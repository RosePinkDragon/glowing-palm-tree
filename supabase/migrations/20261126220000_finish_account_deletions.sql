-- Customer account deletion (#51, slice 2a: the trusted finisher's database side; no screens).
--
-- The finish-account-deletions Edge Function (service role) removes the Auth user of each account that
-- list_accounts_pending_auth_deletion() returns. Two service-role-only RPCs bracket the Auth admin call, because SQL cannot make it:
--   prepare_account_auth_deletion(id)   re-runs the active-data cleanup under the account lock, as docs/RELEASE.md asks, and says
--                                       whether the Auth user may now be deleted ('pending'), is already gone ('gone') or must NOT be
--                                       deleted because the account is not pending ('not_pending').
--   complete_account_auth_deletion(id, requested_at)  after the admin call: refuses unless the auth.users row is really gone, then
--                                       records the completion. Idempotent (a retry after a lost response changes nothing).
-- The accounts row cascades away with the Auth user, so completion is recorded in its own table. It holds the account's random id (the
-- primary key makes the call idempotent and lets a later status check ask "is this deletion finished") and two timestamps, no name,
-- phone or address, and nothing else links to that id any more (orders were unlinked by request_account_deletion or the foreign key).
-- Lock order as in docs/RELEASE.md: users KEY SHARE, then the accounts row FOR UPDATE, then the rows cleanup touches.

create table customer_lifecycle_private.account_deletion_completions (
  customer_id uuid primary key,
  requested_at timestamptz,
  completed_at timestamptz not null default clock_timestamp()
);
alter table customer_lifecycle_private.account_deletion_completions enable row level security;
revoke all on customer_lifecycle_private.account_deletion_completions from public, anon, authenticated, service_role;

create function public.prepare_account_auth_deletion(p_customer_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare account_state text;
begin
  if p_customer_id is null then raise exception 'customer required' using errcode = '22023'; end if;
  perform 1 from auth.users where id = p_customer_id for key share;
  if not found then return 'gone'; end if;
  select state into account_state from customer_lifecycle_private.accounts where customer_id = p_customer_id for update;
  if account_state is distinct from 'deletion_pending' then return 'not_pending'; end if;
  perform customer_lifecycle_private.clear_account_active_data(p_customer_id, clock_timestamp());
  return 'pending';
end $$;

create function public.complete_account_auth_deletion(p_customer_id uuid, p_requested_at timestamptz default null) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_customer_id is null then raise exception 'customer required' using errcode = '22023'; end if;
  -- Never record a completion for a user that still exists (the admin call has not happened or failed).
  if exists (select 1 from auth.users where id = p_customer_id) then return false; end if;
  -- Orders were unlinked and stamped by the foreign key action; nothing may still point at the removed user.
  if exists (select 1 from public.orders where customer_id = p_customer_id) then
    raise exception 'orders still linked' using errcode = 'XX000';
  end if;
  insert into customer_lifecycle_private.account_deletion_completions(customer_id, requested_at)
    values (p_customer_id, p_requested_at) on conflict do nothing;
  return true;
end $$;

revoke all on function public.prepare_account_auth_deletion(uuid), public.complete_account_auth_deletion(uuid, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.prepare_account_auth_deletion(uuid), public.complete_account_auth_deletion(uuid, timestamptz) to service_role;
