-- Check direct API writes before row filtering and BEFORE ROW validation, even for zero target rows.
-- Keep the effective role so trusted SECURITY DEFINER routines and referential actions keep their own checks.
create function session_rls_private.guard_direct_write() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if current_user = 'authenticated' then
    perform session_rls_private.require_active_session();
  end if;
  return null;
end $$;
revoke all on function session_rls_private.guard_direct_write() from public, anon, authenticated, service_role;

create trigger require_active_session before insert or update or delete on public.menu_items
  for each statement execute function session_rls_private.guard_direct_write();
create trigger require_active_session before insert or update or delete on public.menu_categories
  for each statement execute function session_rls_private.guard_direct_write();
create trigger require_active_session before insert or update on public.offers
  for each statement execute function session_rls_private.guard_direct_write();
create trigger require_active_session before insert or update or delete on public.customer_addresses
  for each statement execute function session_rls_private.guard_direct_write();
create trigger require_active_session before update on public.customer_notifications
  for each statement execute function session_rls_private.guard_direct_write();
create trigger require_active_session before insert or update on public.profiles
  for each statement execute function session_rls_private.guard_direct_write();
create trigger require_active_session before insert or update or delete on public.device_tokens
  for each statement execute function session_rls_private.guard_direct_write();

-- Direct token writes still have no grants. If a grant is added, require the same session
-- predicate in addition to the existing devices_self ownership and audience checks.
create policy devices_active_session_insert on public.device_tokens as restrictive for insert to authenticated
  with check ((select session_rls_private.require_active_session()));
create policy devices_active_session_update on public.device_tokens as restrictive for update to authenticated
  using ((select session_rls_private.require_active_session()))
  with check ((select session_rls_private.require_active_session()));
create policy devices_active_session_delete on public.device_tokens as restrictive for delete to authenticated
  using ((select session_rls_private.require_active_session()));
