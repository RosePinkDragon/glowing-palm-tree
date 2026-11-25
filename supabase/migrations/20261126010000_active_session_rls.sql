-- Active-session authorization for direct writes through row-level security (#213, slice B).
--
-- Slice A made the checkout and owner write RPCs refuse a JWT whose Auth session is gone or expired. Clients can also
-- write four tables directly, with RLS as the only gate: menu_items and menu_categories (insert/update/delete), offers
-- (insert/update), customer_addresses (insert/update/delete) and customer_notifications (update of read_at). This
-- migration adds the same requirement to exactly those write policies. SELECT policies are untouched.
--
-- RLS cannot take row locks, and a policy expression must be cheap, so this predicate is a plain STABLE lookup. It does
-- NOT lock auth.sessions or auth.users, and so adds nothing to the lock order (users -> sessions -> accounts -> business
-- -> advisory -> rows, docs/RELEASE.md). The consequence, accepted: a sign-out that commits while a direct write is in
-- flight is not waited for, exactly as for any plain read-then-write; the next statement is refused. The RPCs keep their
-- locking check (customer_lifecycle_private.require_active_session).
--
-- The predicate answers only for the caller's own session (it takes no argument; it reads auth.uid() and the JWT's
-- session_id), so it cannot be used to probe another user's sessions. It returns true or raises 42501 'invalid session'
-- with detail INVALID_SESSION, the same error the RPCs raise, so PostgREST reports an inactive session on an INSERT, an
-- UPDATE or a DELETE identically, and the app can tell it apart from an ordinary RLS refusal (which is a bare 42501
-- on INSERT and zero rows on UPDATE/DELETE).
-- A session id must be the canonical hyphenated UUID Auth issues; anything else is refused (never an error from a cast).

create schema session_rls_private;
revoke all on schema session_rls_private from public, anon, authenticated, service_role;
-- Policies run as the caller, so only the signed-in role needs to resolve and execute the predicate.
grant usage on schema session_rls_private to authenticated;

create function session_rls_private.require_active_session() returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare claim text := auth.jwt()->>'session_id';
begin
  if auth.uid() is not null and claim ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    perform 1 from auth.sessions s
      where s.id = claim::uuid and s.user_id = auth.uid() and (s.not_after is null or s.not_after > clock_timestamp());
    if found then return true; end if;
  end if;
  raise exception 'invalid session' using errcode = '42501', detail = 'INVALID_SESSION';
end $$;
revoke all on function session_rls_private.require_active_session() from public, anon, authenticated, service_role;
grant execute on function session_rls_private.require_active_session() to authenticated;

-- Each policy below is the existing one with ONE added conjunct. The sub-select makes the planner evaluate the
-- predicate once per statement instead of once per row.

-- menu_items (baseline)
drop policy menu_admin_insert on public.menu_items;
drop policy menu_admin_update on public.menu_items;
drop policy menu_admin_delete on public.menu_items;
create policy menu_admin_insert on public.menu_items for insert to authenticated
  with check (public.is_business_admin(business_id) and (select session_rls_private.require_active_session()));
create policy menu_admin_update on public.menu_items for update to authenticated
  using (public.is_business_admin(business_id) and (select session_rls_private.require_active_session()))
  with check (public.is_business_admin(business_id) and (select session_rls_private.require_active_session()));
create policy menu_admin_delete on public.menu_items for delete to authenticated
  using (public.is_business_admin(business_id) and (select session_rls_private.require_active_session()));

-- menu_categories (baseline)
drop policy categories_admin_insert on public.menu_categories;
drop policy categories_admin_update on public.menu_categories;
drop policy categories_admin_delete on public.menu_categories;
create policy categories_admin_insert on public.menu_categories for insert to authenticated
  with check (public.is_business_admin(business_id) and (select session_rls_private.require_active_session()));
create policy categories_admin_update on public.menu_categories for update to authenticated
  using (public.is_business_admin(business_id) and (select session_rls_private.require_active_session()))
  with check (public.is_business_admin(business_id) and (select session_rls_private.require_active_session()));
create policy categories_admin_delete on public.menu_categories for delete to authenticated
  using (public.is_business_admin(business_id) and (select session_rls_private.require_active_session()));

-- offers (offers_and_pricing; there is no delete policy or grant)
drop policy offers_admin_insert on public.offers;
drop policy offers_admin_update on public.offers;
create policy offers_admin_insert on public.offers for insert to authenticated
  with check (public.is_business_admin(business_id) and (select session_rls_private.require_active_session()));
create policy offers_admin_update on public.offers for update to authenticated
  using (public.is_business_admin(business_id) and (select session_rls_private.require_active_session()))
  with check (public.is_business_admin(business_id) and (select session_rls_private.require_active_session()));

-- customer_addresses (baseline)
drop policy customer_addresses_own_insert on public.customer_addresses;
drop policy customer_addresses_own_update on public.customer_addresses;
drop policy customer_addresses_own_delete on public.customer_addresses;
create policy customer_addresses_own_insert on public.customer_addresses for insert to authenticated
  with check (customer_id = auth.uid() and (select session_rls_private.require_active_session()));
create policy customer_addresses_own_update on public.customer_addresses for update to authenticated
  using (customer_id = auth.uid() and (select session_rls_private.require_active_session()))
  with check (customer_id = auth.uid() and (select session_rls_private.require_active_session()));
create policy customer_addresses_own_delete on public.customer_addresses for delete to authenticated
  using (customer_id = auth.uid() and (select session_rls_private.require_active_session()));

-- customer_notifications: update of read_at (baseline; the only column grant is read_at)
drop policy customer_notifications_own_read on public.customer_notifications;
create policy customer_notifications_own_read on public.customer_notifications for update to authenticated
  using (user_id=auth.uid() and not public.is_business_admin(business_id) and created_at >= now()-interval '30 days'
    and (select session_rls_private.require_active_session()))
  with check (user_id=auth.uid() and not public.is_business_admin(business_id) and created_at >= now()-interval '30 days'
    and (select session_rls_private.require_active_session()));
