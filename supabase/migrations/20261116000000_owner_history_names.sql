-- Owner display names and owner-only order-history actor snapshots (#98, for #53).
--
-- Each restaurant membership carries its own display name. Existing and future
-- memberships created without one read "Owner"; trusted setup (service role)
-- sets real names with an ordinary UPDATE, validated by the constraint below.
-- Private customer profiles are never read or joined.
alter table public.business_memberships add column display_name text not null default 'Owner';
alter table public.business_memberships add constraint membership_display_name_valid check (
  display_name = btrim(display_name) and char_length(display_name) between 1 and 60 and display_name !~ '[[:cntrl:]]');

-- Snapshots live beside, not inside, order_status_history: customers can read
-- their own history rows, and RLS cannot hide individual columns per audience.
-- actor_id has no foreign key so a snapshot outlives the membership and the
-- account; redact_owner_history_names clears both identifier and name.
create table public.order_status_actors (
  history_id bigint primary key references public.order_status_history(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  actor_id uuid,
  actor_name text not null constraint order_status_actor_name_valid check (
    actor_name = btrim(actor_name) and char_length(actor_name) between 1 and 60 and actor_name !~ '[[:cntrl:]]')
);
create index order_status_actors_actor_idx on public.order_status_actors(actor_id) where actor_id is not null;
alter table public.order_status_actors enable row level security;
revoke all on public.order_status_actors from public, anon, authenticated;
grant select (history_id, actor_name) on public.order_status_actors to authenticated;
grant all on public.order_status_actors to service_role;
create policy order_status_actors_owner on public.order_status_actors for select to authenticated
  using (public.is_business_admin(business_id));

-- Customers keep status and time only; the acting account id is not exposed.
revoke select on public.order_status_history from authenticated;
grant select (id, order_id, status, created_at) on public.order_status_history to authenticated;

-- Past owner transitions get the acting membership's current name, or
-- "Former owner" when that membership no longer exists. "placed" rows are
-- written by the customer's checkout and never carry an owner snapshot.
insert into public.order_status_actors(history_id, business_id, actor_id, actor_name)
select h.id, o.business_id, case when m.user_id is null then null else h.changed_by end, coalesce(m.display_name, 'Former owner')
from public.order_status_history h
join public.orders o on o.id = h.order_id
left join public.business_memberships m on m.business_id = o.business_id and m.user_id = h.changed_by and m.role = 'admin'
where h.status <> 'placed' and h.changed_by is not null
on conflict (history_id) do nothing;

-- Same contract as before; additionally snapshots the acting owner's name
-- under the membership row lock that already serializes revocation.
create or replace function public.transition_order(p_order_id uuid, p_status text, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare o public.orders%rowtype; caller uuid := auth.uid(); actor text; step bigint;
begin
  if caller is null then raise exception 'authentication required' using errcode='42501'; end if;
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
revoke all on function public.transition_order(uuid,text,integer) from public, anon, authenticated;
grant execute on function public.transition_order(uuid,text,integer) to authenticated;

-- Redaction path for account deletion (#51): call before deleting the account.
-- Replaces every snapshot made by that account with "Former owner" and drops
-- the identifier. Returns the number of history steps redacted.
create function public.redact_owner_history_names(p_user_id uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare redacted integer;
begin
  if p_user_id is null then raise exception 'account required' using errcode='22004'; end if;
  update public.order_status_actors set actor_name='Former owner', actor_id=null where actor_id=p_user_id;
  get diagnostics redacted = row_count;
  return redacted;
end $$;
revoke all on function public.redact_owner_history_names(uuid) from public, anon, authenticated;
grant execute on function public.redact_owner_history_names(uuid) to service_role;
