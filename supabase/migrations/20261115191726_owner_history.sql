-- Membership names are restaurant-scoped operational identities, not private profiles.
-- Unknown legacy names deliberately use a neutral value until trusted setup supplies them.
alter table public.business_memberships add column display_name text not null default 'Owner'
  check (display_name = btrim(display_name) and char_length(display_name) between 1 and 120);

-- Never add owner fields to customer-visible history rows. The actor ledger is
-- readable only by current owners, and is intentionally absent from Realtime.
create table public.order_history_actors (
  history_id bigint primary key references public.order_status_history(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_name text not null check (char_length(actor_name) between 1 and 120)
);
create index order_history_actors_user_idx on public.order_history_actors(actor_user_id);
alter table public.order_history_actors enable row level security;
revoke all on public.order_history_actors from public, anon, authenticated;
grant select on public.order_history_actors to authenticated;
grant all on public.order_history_actors to service_role;
create policy owner_history_visible on public.order_history_actors for select to authenticated
  using (exists (
    select 1 from public.order_status_history h join public.orders o on o.id = h.order_id
    where h.id = history_id and public.is_business_admin(o.business_id)
  ));

-- UUID actor identifiers are also owner data. Existing client queries must use
-- explicit safe columns rather than history(*). Orders still signal refreshes.
revoke select on public.order_status_history from authenticated;
grant select (id, order_id, status, created_at) on public.order_status_history to authenticated;
do $$ begin
  if exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'order_status_history') then
    alter publication supabase_realtime drop table public.order_status_history;
  end if;
end $$;

create schema owner_history_private;
revoke all on schema owner_history_private from public, anon, authenticated;
create function owner_history_private.capture_actor() returns trigger
language plpgsql security definer set search_path = '' as $$
declare owner_name text;
begin
  -- The placed step belongs to the customer, even if that customer is an owner.
  if new.status = 'placed' then return new; end if;
  -- transition_order already locks this membership. Lock here as well so trusted
  -- history writers cannot race a rename/removal while the name is snapshotted.
  select m.display_name into owner_name
    from public.business_memberships m join public.orders o on o.business_id = m.business_id
    where o.id = new.order_id and m.user_id = new.changed_by and m.role = 'admin'
    for share of m;
  if not found then raise exception 'owner history requires an acting owner' using errcode = '42501'; end if;
  insert into public.order_history_actors(history_id, actor_user_id, actor_name)
    values (new.id, new.changed_by, owner_name);
  return new;
end $$;
revoke all on function owner_history_private.capture_actor() from public, anon, authenticated;
create trigger capture_owner_history after insert on public.order_status_history
  for each row execute function owner_history_private.capture_actor();

-- Trusted deletion primitive for #51, deliberately unavailable to app clients.
-- Lock the identity even if memberships have already been removed. Its FK lock
-- serializes new membership grants in every business with redaction/deletion.
create function owner_history_private.redact_identity(p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_user_id is null then raise exception 'identity required' using errcode = '22023'; end if;
  perform 1 from auth.users where id = p_user_id for update;
  if exists (select 1 from public.business_memberships where user_id = p_user_id) then
    raise exception 'remove owner memberships before redaction' using errcode = '22023';
  end if;
  update public.order_history_actors set actor_name = 'Former owner', actor_user_id = null
    where actor_user_id = p_user_id;
  update public.order_status_history set changed_by = null where changed_by = p_user_id;
end $$;
revoke all on function owner_history_private.redact_identity(uuid) from public, anon, authenticated;
grant usage on schema owner_history_private to service_role;
grant execute on function owner_history_private.redact_identity(uuid) to service_role;
create function public.redact_owner_history(p_user_id uuid) returns void
language sql security invoker set search_path = '' as $$
  select owner_history_private.redact_identity(p_user_id)
$$;
revoke all on function public.redact_owner_history(uuid) from public, anon, authenticated;
grant execute on function public.redact_owner_history(uuid) to service_role;
