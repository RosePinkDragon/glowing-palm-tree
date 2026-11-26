-- Customer account deletion (#51, slice 1: database and services; no screens).
--
-- Owner decision of 26 Nov 2026: the account closes at once and the active data goes at once (profile, saved addresses,
-- device tokens, notifications, restaurant links); past orders stay with the restaurant and a scheduled job blanks the
-- customer's name, phone, address and pin when the retention period ends. The period is a setting, 365 days as a
-- placeholder until the lawyer answers under #195 (DPDP Rules 2025, rule 8(3)). Nothing here depends on that answer.
--
-- 1. Auth user removal. SQL cannot call GoTrue's admin API, and whether the SECURITY DEFINER owner may DELETE from auth.users
--    on a hosted project cannot be shown by local tests (they run as superuser). So the RPC does everything except remove
--    the auth.users row: it marks the account deletion_pending (the unused state in customer_lifecycle_private.accounts),
--    stamps deletion_requested_at, and a trusted finisher (an Edge Function with the service role in a later slice, or the
--    SQL fallback in docs/RELEASE.md) removes the user. A pending account can do nothing: checkout, join, leave and
--    token registration already refuse it through lock_account, and the RLS session helper below now refuses it too, so
--    a fresh sign-in with the same phone can neither create a profile or address nor order. Removing the auth user then
--    cascades the remaining rows (accounts, sessions, leftovers) and signs the person out everywhere.
--    service_role lists what still waits for that step with list_accounts_pending_auth_deletion().
-- 2. Orders stay. orders.customer_id becomes nullable (ON DELETE SET NULL, so even a direct auth user delete cannot be
--    blocked or lose an order). A BEFORE UPDATE trigger stamps orders.customer_deleted_at the moment the link is cut, by
--    this RPC or by the foreign key action. The retention clock runs from that stamp, per order. offer_redemptions keeps
--    its rows too (customer_id set null) so an offer's usage counts stay right. checkout_pricing_rejections is only a
--    replay guard for a customer who no longer exists and its primary key contains customer_id, so it is deleted
--    (ON DELETE CASCADE) rather than nulled.
-- 3. Purge. purge_deleted_customer_order_snapshots() (service_role only) blanks the customer snapshot columns of orders
--    whose customer_deleted_at is older than the retention setting, once, and stamps customer_pii_purged_at. CHECK
--    constraints keep the snapshot columns required for every order that is not purged.
--
-- Lock order (docs/RELEASE.md): users KEY SHARE -> sessions SHARE -> accounts FOR UPDATE -> business (FOR NO KEY UPDATE for
-- an owner, the shared per-restaurant owner lock; #59 reuses it) -> advisory -> token, order and other rows. The same
-- accounts lock serializes the active-order check with checkout (place_order and transition_order take it first).

-- 1. Account state and retention setting -------------------------------------------------------
alter table customer_lifecycle_private.accounts
  add column deletion_requested_at timestamptz,
  add constraint accounts_deletion_requested_pending check (deletion_requested_at is null or state = 'deletion_pending');

-- One row, changed in one place: update customer_lifecycle_private.retention_settings set order_snapshot_retention = interval '...'.
create table customer_lifecycle_private.retention_settings (
  singleton boolean primary key default true check (singleton),
  order_snapshot_retention interval not null default interval '365 days' check (order_snapshot_retention > interval '0')
);
insert into customer_lifecycle_private.retention_settings default values;
alter table customer_lifecycle_private.retention_settings enable row level security;
revoke all on customer_lifecycle_private.retention_settings from public, anon, authenticated, service_role;

-- A pending account is refused by every RLS write that requires an active session (profile and address inserts, owner
-- writes), with the error the lifecycle lock raises. SELECT policies do not call this helper and are unchanged.
create or replace function session_rls_private.require_active_session() returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare claim text := auth.jwt()->>'session_id';
begin
  if auth.uid() is not null and claim ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    perform 1 from auth.sessions s
      where s.id = claim::uuid and s.user_id = auth.uid() and (s.not_after is null or s.not_after > clock_timestamp());
    if found then
      if exists (select 1 from customer_lifecycle_private.accounts a where a.customer_id = auth.uid() and a.state = 'deletion_pending') then
        raise exception 'account lifecycle pending' using errcode = 'PT409', detail = 'ACCOUNT_LIFECYCLE_PENDING';
      end if;
      return true;
    end if;
  end if;
  raise exception 'invalid session' using errcode = '42501', detail = 'INVALID_SESSION';
end $$;

-- 2. Orders and records that outlive the account -----------------------------------------------
alter table public.orders drop constraint orders_customer_id_fkey;
alter table public.orders alter column customer_id drop not null;
alter table public.orders add constraint orders_customer_id_fkey foreign key (customer_id) references auth.users(id) on delete set null;
alter table public.orders
  add column customer_deleted_at timestamptz,
  add column customer_pii_purged_at timestamptz;
alter table public.orders alter column customer_name drop not null, alter column customer_phone drop not null,
  alter column delivery_address_line drop not null, alter column latitude drop not null, alter column longitude drop not null;
alter table public.orders drop constraint order_address_evidence;
alter table public.orders
  -- Linked to a customer, or anonymised with the time the link was cut; never both, never neither.
  add constraint orders_customer_link check ((customer_id is not null and customer_deleted_at is null) or (customer_id is null and customer_deleted_at is not null)),
  add constraint orders_purge_after_deletion check (customer_pii_purged_at is null or (customer_id is null and customer_pii_purged_at >= customer_deleted_at)),
  -- Until purged every snapshot stays required, exactly as before; a purged order carries none of them.
  add constraint orders_snapshot_required check (customer_pii_purged_at is not null or (customer_name is not null and customer_phone is not null
    and delivery_address_line is not null and latitude is not null and longitude is not null
    and saved_address_id is not null and saved_address_version is not null and address_label is not null and address_house is not null
    and address_street_area is not null and address_location_source is not null)),
  add constraint orders_snapshot_blank_when_purged check (customer_pii_purged_at is null or (customer_name is null and customer_phone is null
    and delivery_address_line is null and latitude is null and longitude is null and address_label is null and address_custom_label is null
    and address_house is null and address_street_area is null and address_landmark is null and address_location_source is null
    and saved_address_id is null and saved_address_version is null and placed_from_distance_m is null));
create index orders_purge_due_idx on public.orders (customer_deleted_at) where customer_pii_purged_at is null and customer_id is null;

-- The link is cut either by request_account_deletion or by the foreign key's SET NULL: stamp the time in both.
create function customer_lifecycle_private.stamp_customer_deleted() returns trigger language plpgsql set search_path = '' as $$
begin
  if old.customer_id is not null and new.customer_id is null and new.customer_deleted_at is null then
    new.customer_deleted_at := clock_timestamp();
  end if;
  return new;
end $$;
create trigger stamp_customer_deleted before update of customer_id on public.orders
  for each row execute function customer_lifecycle_private.stamp_customer_deleted();
revoke all on function customer_lifecycle_private.stamp_customer_deleted() from public, anon, authenticated, service_role;

alter table public.offer_redemptions drop constraint offer_redemptions_customer_id_fkey;
alter table public.offer_redemptions alter column customer_id drop not null;
alter table public.offer_redemptions add constraint offer_redemptions_customer_id_fkey foreign key (customer_id) references auth.users(id) on delete set null;

alter table public.checkout_pricing_rejections drop constraint checkout_pricing_rejections_customer_id_fkey;
alter table public.checkout_pricing_rejections add constraint checkout_pricing_rejections_customer_id_fkey foreign key (customer_id) references auth.users(id) on delete cascade;

-- order_status_history.changed_by also blocked the delete (an owner who is also deleting their account).
alter table public.order_status_history drop constraint order_status_history_changed_by_fkey;
alter table public.order_status_history add constraint order_status_history_changed_by_fkey foreign key (changed_by) references auth.users(id) on delete set null;

-- An anonymised order is always final, so no transition can reach it; but an owner's attempt would take the customer's
-- lifecycle lock first and fail on a null customer with a misleading authentication error. Same function as
-- 20261126000000_active_session_checks.sql with the lock made conditional, so the refusal is the ordinary 'invalid order transition'.
create or replace function public.transition_order(p_order_id uuid, p_status text, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare o public.orders%rowtype; caller uuid := auth.uid(); actor text; step bigint; target_customer uuid; target_business uuid;
begin
  if caller is null then raise exception 'authentication required' using errcode='42501'; end if;
  perform customer_lifecycle_private.require_active_session(caller);
  perform 1 from auth.users where id=caller for key share;
  if not found then raise exception 'authentication required' using errcode='42501'; end if;
  select customer_id,business_id into target_customer,target_business from public.orders where id=p_order_id;
  if not found or not public.is_business_admin(target_business) then raise exception 'order unavailable' using errcode='42501'; end if;
  if target_customer is not null then perform customer_lifecycle_private.lock_account(target_customer); end if;
  perform 1 from public.businesses where id=target_business for share;
  select * into o from public.orders where id=p_order_id for update;
  if not found then raise exception 'order unavailable' using errcode='42501'; end if;
  -- Lock the membership so revocation and transition cannot race.
  select m.display_name into actor from public.business_memberships m where m.business_id=o.business_id and m.user_id=caller and m.role='admin' for share;
  if not found then raise exception 'order unavailable' using errcode='42501'; end if;
  if p_expected_version is null or p_expected_version <> o.version then raise exception 'order version conflict' using errcode='40001'; end if;
  if not ((o.status='placed' and p_status in ('accepted','cancelled')) or
          (o.status='accepted' and p_status in ('preparing','cancelled')) or
          (o.status='preparing' and p_status in ('out_for_delivery','cancelled')) or
          (o.status='out_for_delivery' and p_status='delivered')) then
    raise exception 'invalid order transition' using errcode='22023';
  end if;
  update public.orders set status=p_status, version=version+1 where id=o.id returning * into o;
  insert into public.order_status_history(order_id,status,changed_by) values(o.id,o.status,caller) returning id into step;
  insert into public.order_status_actors(history_id,business_id,actor_id,actor_name) values(step,o.business_id,caller,actor);
  return jsonb_build_object('id',o.id,'business_id',o.business_id,'status',o.status,'version',o.version,'subtotal_paise',o.subtotal_paise,'delivery_fee_paise',o.delivery_fee_paise,'total_paise',o.total_paise,'created_at',o.created_at);
end $$;

-- 3. The deletion request -----------------------------------------------------------------------
-- Everything commits together or nothing does. A second call (a retry after a lost response, or after signing in again with
-- the same phone) finds the account already pending and returns the same confirmation without doing anything.
create function customer_lifecycle_private.request_account_deletion() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare caller uuid := auth.uid(); account_state text; requested timestamptz; cutoff timestamptz; owned uuid[];
begin
  -- users KEY SHARE and sessions SHARE first (refuses a missing, expired or foreign session with INVALID_SESSION).
  perform customer_lifecycle_private.require_active_session(caller);
  insert into customer_lifecycle_private.accounts(customer_id) values (caller) on conflict do nothing;
  select state, deletion_requested_at into account_state, requested
    from customer_lifecycle_private.accounts where customer_id = caller for update;
  if account_state = 'deletion_pending' then
    return jsonb_build_object('customer_id', caller, 'state', 'deletion_pending', 'requested_at', coalesce(requested, clock_timestamp()));
  end if;

  -- Restaurants this account owns: lock each (ordered, so two owners deleting at once cannot deadlock) and require another
  -- owner whose own account is not already being deleted. The membership is removed below in this transaction, so the
  -- second of two simultaneous owner deletions waits here, then finds no other usable owner and is refused.
  select coalesce(array_agg(business_id order by business_id), array[]::uuid[]) into owned
    from public.business_memberships where user_id = caller and role = 'admin';
  perform 1 from public.businesses where id = any(owned) order by id for no key update;
  if exists (
    select 1 from unnest(owned) o(business_id) where not exists (
      select 1 from public.business_memberships m
      where m.business_id = o.business_id and m.role = 'admin' and m.user_id <> caller
        and not exists (select 1 from customer_lifecycle_private.accounts a where a.customer_id = m.user_id and a.state = 'deletion_pending'))) then
    raise exception 'add another owner first' using errcode = 'PT409', detail = 'ONLY_OWNER';
  end if;
  -- Terminal states are delivered and cancelled (transition_order). Checkout and transitions hold the accounts lock we hold.
  if exists (select 1 from public.orders where customer_id = caller and status not in ('delivered', 'cancelled')) then
    raise exception 'finish active orders' using errcode = 'PT409', detail = 'ACCOUNT_HAS_ACTIVE_ORDER';
  end if;

  cutoff := clock_timestamp();
  update customer_lifecycle_private.accounts set state = 'deletion_pending', deletion_requested_at = cutoff where customer_id = caller;

  -- Device tokens (every audience): lock in id order, keep completed push audit rows with the token reference removed, drop
  -- pending jobs with their tokens (same order as leave_business).
  perform d.id from public.device_tokens d where d.user_id = caller order by d.id for update;
  update public.notification_outbox q set device_token_id = null from public.device_tokens d
    where q.device_token_id = d.id and q.completed_at is not null and d.user_id = caller;
  delete from public.notification_outbox q using public.device_tokens d where q.device_token_id = d.id and q.completed_at is null and d.user_id = caller;
  delete from public.device_tokens where user_id = caller;
  perform public.purge_customer_notifications(caller, null, cutoff);

  delete from public.customer_addresses where customer_id = caller;
  delete from public.profiles where user_id = caller;
  delete from public.customer_businesses where customer_id = caller;
  delete from customer_lifecycle_private.leave_requests where customer_id = caller;
  delete from offers_private.code_attempts where customer_id = caller;
  delete from public.checkout_pricing_rejections where customer_id = caller;

  -- Owner leftovers: the membership, and the owner's name on past history ("Former owner").
  delete from public.business_memberships where user_id = caller;
  perform public.redact_owner_history_names(caller);
  update public.order_status_history set changed_by = null where changed_by = caller;
  update public.accepting_orders_changes set changed_by = null where changed_by = caller;

  -- Orders and offer uses stay for the restaurants, unlinked. The trigger stamps customer_deleted_at (the retention clock).
  update public.offer_redemptions set customer_id = null where customer_id = caller;
  update public.orders set customer_id = null where customer_id = caller;

  return jsonb_build_object('customer_id', caller, 'state', 'deletion_pending', 'requested_at', cutoff);
end $$;

create function public.request_account_deletion() returns jsonb
language sql security invoker set search_path = '' as $$ select customer_lifecycle_private.request_account_deletion() $$;
revoke all on function customer_lifecycle_private.request_account_deletion(), public.request_account_deletion()
  from public, anon, authenticated, service_role;
grant execute on function customer_lifecycle_private.request_account_deletion(), public.request_account_deletion() to authenticated;

-- 4. The trusted finisher's list and the retention purge (service_role and the SQL editor only) --
create function public.list_accounts_pending_auth_deletion(p_limit integer default 100)
returns table (customer_id uuid, requested_at timestamptz) language sql stable security definer set search_path = '' as $$
  select a.customer_id, a.deletion_requested_at from customer_lifecycle_private.accounts a
  where a.state = 'deletion_pending' and a.deletion_requested_at is not null
  order by a.deletion_requested_at, a.customer_id limit greatest(coalesce(p_limit, 100), 0)
$$;

create function customer_lifecycle_private.order_snapshot_retention() returns interval
language sql stable security definer set search_path = '' as $$
  select order_snapshot_retention from customer_lifecycle_private.retention_settings where singleton
$$;
revoke all on function customer_lifecycle_private.order_snapshot_retention() from public, anon, authenticated, service_role;

create function public.purge_deleted_customer_order_snapshots() returns integer
language plpgsql security definer set search_path = '' as $$
declare purged integer;
begin
  update public.orders set
    customer_name = null, customer_phone = null, delivery_address_line = null, latitude = null, longitude = null,
    address_label = null, address_custom_label = null, address_house = null, address_street_area = null, address_landmark = null,
    address_location_source = null, saved_address_id = null, saved_address_version = null, placed_from_distance_m = null,
    customer_pii_purged_at = clock_timestamp()
  where customer_id is null and customer_pii_purged_at is null
    and customer_deleted_at < clock_timestamp() - customer_lifecycle_private.order_snapshot_retention();
  get diagnostics purged = row_count;
  return purged;
end $$;
revoke all on function public.list_accounts_pending_auth_deletion(integer), public.purge_deleted_customer_order_snapshots()
  from public, anon, authenticated, service_role;
grant execute on function public.list_accounts_pending_auth_deletion(integer), public.purge_deleted_customer_order_snapshots() to service_role;
