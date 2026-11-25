do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
alter default privileges for role postgres in schema public grant execute on functions to anon, authenticated, service_role;
create schema auth;
-- phone mirrors Supabase Auth: unique, stored without the leading plus sign.
create table auth.users (id uuid primary key, phone text unique);
create table auth.sessions (id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade, not_after timestamptz);
-- Suites that set only request.jwt.claim.sub (no request.jwt.claims at all) run as that user's implicit live session: every
-- auth.users row gets one (an id derived from the user id, so it never collides with a suite's own sessions), and auth.jwt()
-- reports it. Suites that exercise session behaviour set request.jwt.claims explicitly, which always wins, including '{}'.
create function auth.implicit_session(p_user uuid) returns uuid language sql immutable as $$ select md5('test-implicit-session:' || p_user::text)::uuid $$;
create function auth.jwt() returns jsonb language sql stable as $$
  select case when nullif(current_setting('request.jwt.claims', true), '') is not null then current_setting('request.jwt.claims', true)::jsonb
    when nullif(current_setting('request.jwt.claim.sub', true), '') is not null
      then jsonb_build_object('sub', current_setting('request.jwt.claim.sub', true), 'session_id', auth.implicit_session(current_setting('request.jwt.claim.sub', true)::uuid))
    else '{}'::jsonb end $$;
create function auth.add_implicit_session() returns trigger language plpgsql as $$ begin
  insert into auth.sessions(id,user_id) values (auth.implicit_session(new.id), new.id); return new; end $$;
create trigger users_implicit_session after insert on auth.users for each row execute function auth.add_implicit_session();
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid(), auth.jwt() to anon, authenticated, service_role;
-- Minimal Storage metadata/RLS contract for local SQL isolation tests. The real
-- Storage HTTP writer/decoder is verified separately by Edge Function tests.
create schema storage;
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text,unique(bucket_id,name));
alter table storage.objects enable row level security;
grant usage on schema storage to anon,authenticated,service_role;
grant select,insert,update,delete on storage.objects to anon,authenticated,service_role;
grant select on storage.buckets to anon,authenticated;
grant all on storage.buckets to service_role;
-- Exercise the Supabase publication branch too.
create publication supabase_realtime;
-- Shared assertion helper for every suite (created before the baseline migration).
create function public.test_assert(ok boolean, message text) returns void language plpgsql as $$ begin if ok is distinct from true then raise exception 'assertion failed: %', message; end if; end $$;
grant execute on function public.test_assert(boolean,text) to anon, authenticated;
