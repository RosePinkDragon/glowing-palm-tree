-- Customer profile shared by both restaurant apps (#45, slice 1: database).
--
-- One row per Auth account, holding the customer's full name. It is not per restaurant: a customer who signs in to
-- either app (each with its own session) reads and writes the same row. Phone comes from Auth and is not stored here.
-- Orders keep their own customer_name / customer_phone snapshots; this table never changes them.
--
-- Privacy. Only the owner of a row can see or change it. Restaurant owners, admins and business members get no policy
-- and no grant of their own: being an admin of a restaurant gives no access here. anon has no privilege at all and
-- service_role is unchanged (it bypasses RLS, as everywhere). Owner names in the owners' app come from the membership
-- (#59), not from profiles.
--
-- Account initialization / backfill. Profiles are created on first save: no name is stored anywhere server-side today
-- (the checkout's "Me" name lives only on the device, and auth user_metadata is not trusted), so there is nothing to
-- backfill and no row is created at sign-up. A missing row simply means "no name yet" (the app asks once per account).
-- Never invent a row from user_metadata or from an order's customer_name.
--
-- Writes. A client may set only full_name: INSERT and UPDATE are granted on that column alone, and user_id defaults to
-- auth.uid(), so a request cannot name another user or change the row's owner (a trigger also refuses it for any role).
-- That is what PostgREST's upsert (on_conflict=user_id) sends. There is no DELETE grant or policy; the row goes only with
-- the Auth account (ON DELETE CASCADE, which runs without RLS). Write policies require an active Auth session exactly as
-- the other direct writes do (#213 slice B, session_rls_private.require_active_session(), a lock-free STABLE lookup);
-- SELECT does not.
--
-- Lock order (docs/RELEASE.md): unchanged. The table takes no advisory or lifecycle lock and nothing locks it; its only
-- lock interaction is the FK to auth.users (KEY SHARE on the user row, the first lock in the order) and the cascade.
-- Row-level security is enabled but not forced, like the rest of the schema: the table owner (migrations, trusted
-- SECURITY DEFINER code) bypasses it.

create table public.profiles (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  full_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_full_name_trimmed_check check (char_length(btrim(full_name)) between 1 and 120 and full_name = btrim(full_name))
);

alter table public.profiles enable row level security;

-- The row's owner, creation time and update time are managed here, not by clients.
create function public.prepare_profile() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now(); new.updated_at := new.created_at;
  else
    if new.user_id is distinct from old.user_id then raise exception 'profile owner is immutable' using errcode = '22023'; end if;
    new.created_at := old.created_at; new.updated_at := now();
  end if;
  return new;
end $$;
revoke all on function public.prepare_profile() from public, anon, authenticated, service_role;
create trigger prepare_profile before insert or update on public.profiles
  for each row execute function public.prepare_profile();

create policy profiles_own_select on public.profiles for select to authenticated using (user_id = auth.uid());
create policy profiles_own_insert on public.profiles for insert to authenticated
  with check (user_id = auth.uid() and (select session_rls_private.require_active_session()));
create policy profiles_own_update on public.profiles for update to authenticated
  using (user_id = auth.uid() and (select session_rls_private.require_active_session()))
  with check (user_id = auth.uid() and (select session_rls_private.require_active_session()));

revoke all on public.profiles from public, anon, authenticated;
grant select on public.profiles to authenticated;
grant insert (full_name) on public.profiles to authenticated;
grant update (full_name) on public.profiles to authenticated;
