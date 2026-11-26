\set ON_ERROR_STOP on
-- Customer profiles (#45 slice 1): public.profiles holds one full name per Auth account, private to its owner. Own read/write
-- (including PostgREST's upsert shape), another customer / a restaurant admin / anon see and change nothing, no DELETE, the owner
-- is immutable, the name constraint (1-120 characters, already trimmed), deletion with the Auth account, and the active-session
-- requirement on writes (#213 slice B). Self-contained; rolls back. Every identity sets request.jwt.claims.
begin;
-- 1 and 2 customers, 3 admin (Ammu Sammu), 4 admin (Kokani Dine Inn), 5 name tests, 6 deleted with its account, 7 dead-session tests.
insert into auth.users(id) select ('45000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,7) n;
insert into auth.sessions(id,user_id) select ('45000000-0000-4000-b000-'||lpad(n::text,12,'0'))::uuid, ('45000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,7) n;
insert into public.business_memberships(business_id,user_id,role) values
 ('10000000-0000-4000-8000-000000000001','45000000-0000-4000-8000-000000000003','admin'),
 ('10000000-0000-4000-8000-000000000002','45000000-0000-4000-8000-000000000004','admin');
-- Customer 2 has a profile written by a trusted fixture, so the others have something to be refused.
insert into public.profiles(user_id,full_name) values ('45000000-0000-4000-8000-000000000002','Second Customer');

create function public.t_user(n integer) returns uuid language sql immutable as $$ select ('45000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
create function public.t_session(n integer) returns uuid language sql immutable as $$ select ('45000000-0000-4000-b000-'||lpad(n::text,12,'0'))::uuid $$;
create function public.t_as(n integer, mode text default 'own') returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', public.t_user(n)::text, false);
  perform set_config('request.jwt.claims', case mode
    when 'own' then jsonb_build_object('sub',public.t_user(n),'session_id',public.t_session(n))::text
    when 'foreign' then jsonb_build_object('sub',public.t_user(n),'session_id',public.t_session(case when n=2 then 1 else 2 end))::text
    when 'missing' then jsonb_build_object('sub',public.t_user(n))::text
    when 'null' then jsonb_build_object('sub',public.t_user(n),'session_id',null)::text
    when 'malformed' then jsonb_build_object('sub',public.t_user(n),'session_id','not-a-uuid')::text
    when 'empty' then '{}' end, false);
end $$;
-- Every profile row, read with definer rights so RLS hides nothing.
create function public.t_rows() returns jsonb language sql security definer set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(t) order by t.user_id),'[]') from public.profiles t $$;
-- As user n (active session): the statement must fail with exactly this SQLSTATE (and, for 23514, this constraint).
create function public.t_fails(n integer, stmt text, state text, what text default null) returns void language plpgsql as $$
declare c text;
begin
  perform public.t_as(n);
  begin execute stmt;
  exception when others then
    get stacked diagnostics c = constraint_name;
    if sqlstate = state and (what is null or c = what or sqlerrm like '%'||what||'%') then return; end if;
    raise exception 'wrong error for [%] (user %): % % %', stmt, n, sqlstate, sqlerrm, c;
  end;
  raise exception 'statement succeeded but must fail with %: [%]', state, stmt;
end $$;
-- As user n: the statement works and changes exactly the expected number of rows.
create function public.t_rows_changed(n integer, stmt text, expected bigint) returns void language plpgsql as $$
declare rows bigint;
begin
  perform public.t_as(n);
  execute stmt; get diagnostics rows = row_count;
  if rows <> expected then raise exception 'expected % rows for [%], got %', expected, stmt, rows; end if;
end $$;
-- As user n with a dead or missing session: INSERT/UPDATE fail with the active-session refusal (42501 'invalid session', INVALID_SESSION).
create function public.t_dead(n integer, mode text, stmt text) returns void language plpgsql as $$
declare detail text;
begin
  perform public.t_as(n, mode);
  begin execute stmt;
  exception when others then
    get stacked diagnostics detail = pg_exception_detail;
    if sqlstate = '42501' and sqlerrm = 'invalid session' and detail = 'INVALID_SESSION' then return; end if;
    raise exception 'wrong error for [%] (user %, %): % % %', stmt, n, mode, sqlstate, sqlerrm, detail;
  end;
  raise exception 'statement succeeded with an inactive session (user %, %): [%]', n, mode, stmt;
end $$;
create function public.t_dead_all(mode text) returns void language plpgsql as $$
declare before_rows jsonb := public.t_rows();
begin
  perform public.t_dead(7, mode, $s$insert into public.profiles(full_name) values ('Dead session')$s$);
  perform public.t_dead(7, mode, $s$insert into public.profiles(full_name) values ('Dead upsert') on conflict (user_id) do update set full_name=excluded.full_name$s$);
  perform public.t_dead(2, mode, $s$update public.profiles set full_name='Dead update' where user_id='45000000-0000-4000-8000-000000000002'$s$);
  perform public.test_assert(public.t_rows() = before_rows, 'refused profile writes (' || mode || ') leave the table unchanged');
end $$;

-- 0. Catalog: RLS on, exactly three own-row policies, grants as designed. ----------------------------------------------
select public.test_assert((select relrowsecurity from pg_class where oid='public.profiles'::regclass), 'row-level security is enabled');
select public.test_assert((select count(*)=3 from pg_policies where schemaname='public' and tablename='profiles' and roles='{authenticated}'), 'three policies, all for authenticated');
select public.test_assert((select count(*)=0 from pg_policies where schemaname='public' and tablename='profiles' and cmd in ('DELETE','ALL')), 'no DELETE or ALL policy');
select public.test_assert((select count(*)=1 from pg_policies where tablename='profiles' and cmd='SELECT' and qual='(user_id = auth.uid())'), 'select is own row only');
select public.test_assert((select count(*)=2 from pg_policies where tablename='profiles' and cmd in ('INSERT','UPDATE') and coalesce(with_check,'') like '%user_id = auth.uid()%' and coalesce(with_check,'') like '%require_active_session%'
  and (cmd='INSERT' or (qual like '%user_id = auth.uid()%' and qual like '%require_active_session%'))), 'insert and update are own row and need an active session');
select public.test_assert(has_table_privilege('authenticated','public.profiles','select') and not has_table_privilege('authenticated','public.profiles','insert')
  and not has_table_privilege('authenticated','public.profiles','update') and not has_table_privilege('authenticated','public.profiles','delete')
  and not has_table_privilege('authenticated','public.profiles','truncate') and not has_table_privilege('authenticated','public.profiles','references') and not has_table_privilege('authenticated','public.profiles','trigger'), 'authenticated has SELECT only at table level');
select public.test_assert(has_column_privilege('authenticated','public.profiles','full_name','insert') and has_column_privilege('authenticated','public.profiles','full_name','update')
  and not has_column_privilege('authenticated','public.profiles','user_id','insert') and not has_column_privilege('authenticated','public.profiles','user_id','update')
  and not has_column_privilege('authenticated','public.profiles','created_at','insert') and not has_column_privilege('authenticated','public.profiles','created_at','update')
  and not has_column_privilege('authenticated','public.profiles','updated_at','insert') and not has_column_privilege('authenticated','public.profiles','updated_at','update'), 'clients may write full_name only');
select public.test_assert(not has_any_column_privilege('anon','public.profiles','select') and not has_any_column_privilege('anon','public.profiles','insert')
  and not has_any_column_privilege('anon','public.profiles','update') and not has_table_privilege('anon','public.profiles','delete'), 'anon has no privilege at all');
select public.test_assert((select count(*)=0 from information_schema.role_table_grants where table_schema='public' and table_name='profiles' and grantee not in ('postgres','authenticated','service_role','supabase_admin')), 'no other grantee holds a table privilege');
select public.test_assert(not exists (select 1 from pg_publication_tables where schemaname='public' and tablename='profiles'), 'profiles is not in any realtime publication');
select public.test_assert((select confdeltype='c' from pg_constraint where conrelid='public.profiles'::regclass and contype='f'), 'the Auth foreign key cascades');

-- 1. Own read and write, as the app sends them (a name only; upsert on user_id). ---------------------------------------
set local role authenticated;
select public.t_rows_changed(1, $s$insert into public.profiles(full_name) values ('Neha Rao')$s$, 1);
select public.test_assert((select count(*)=1 and min(user_id::text)=public.t_user(1)::text and min(full_name)='Neha Rao' from public.profiles), 'a customer reads exactly their own row (not customer 2''s)');
select public.t_rows_changed(1, $s$insert into public.profiles(full_name) values ('Neha R. Rao') on conflict (user_id) do update set full_name=excluded.full_name$s$, 1);
select public.t_rows_changed(1, $s$update public.profiles set full_name='Neha Rao-Iyer' where user_id=auth.uid()$s$, 1);
select public.test_assert((select full_name from public.profiles)='Neha Rao-Iyer', 'the saved name reads back');
-- A first-time upsert creates the row; a repeated one updates it in place.
select public.t_rows_changed(5, $s$insert into public.profiles(full_name) values ('First save') on conflict (user_id) do update set full_name=excluded.full_name$s$, 1);
select public.t_rows_changed(5, $s$insert into public.profiles(full_name) values ('Second save') on conflict (user_id) do update set full_name=excluded.full_name$s$, 1);
select public.test_assert((select count(*)=1 and min(full_name)='Second save' from public.profiles), 'upsert twice leaves one row');
-- An explicit user_id (even one's own) is not writable: the name is the only column a client sends.
select public.t_fails(1, $s$insert into public.profiles(user_id,full_name) values ('45000000-0000-4000-8000-000000000001','Own id')$s$, '42501', 'permission denied');
reset role;
select public.test_assert((select count(*)=3 from public.profiles) and (select full_name from public.profiles where user_id=public.t_user(1))='Neha Rao-Iyer', 'three rows exist after the own writes');
-- created_at stays, updated_at moves (back-dated by the trusted fixture so the transaction's constant now() shows it).
set local session_replication_role = replica;   -- the trigger would otherwise reset both
update public.profiles set created_at='2020-01-01', updated_at='2020-01-02' where user_id=public.t_user(1);
set local session_replication_role = origin;
set local role authenticated;
select public.t_rows_changed(1, $s$update public.profiles set full_name='Neha Rao' where user_id=auth.uid()$s$, 1);
select public.test_assert((select created_at='2020-01-01' and updated_at>'2020-01-02' and updated_at=now() from public.profiles), 'update keeps created_at and refreshes updated_at');
reset role;

-- 2. Nobody else: another customer, an admin of the restaurant, an admin of the other restaurant, anon. ------------------
do $$ declare before_rows jsonb := public.t_rows(); who integer; begin
  foreach who in array array[3,4] loop
    perform public.t_as(who);
    set local role authenticated;
    perform public.test_assert((select count(*)=0 from public.profiles), 'admin ' || who || ' sees no profile');
    perform public.test_assert((select count(*)=0 from public.profiles where user_id=public.t_user(1)), 'admin ' || who || ' cannot select by id');
    perform public.t_rows_changed(who, $s$update public.profiles set full_name='Admin edit' where user_id in (select user_id from public.profiles) or true$s$, 0);
    reset role;
  end loop;
  -- Customer 2 sees only their own row and cannot touch customer 1's.
  perform public.t_as(2);
  set local role authenticated;
  perform public.test_assert((select count(*)=1 and min(user_id::text)=public.t_user(2)::text from public.profiles), 'customer 2 sees only their own row');
  perform public.test_assert((select count(*)=0 from public.profiles where user_id=public.t_user(1)), 'customer 2 cannot read customer 1''s row');
  perform public.t_rows_changed(2, $s$update public.profiles set full_name='Hijack' where user_id='45000000-0000-4000-8000-000000000001'$s$, 0);
  perform public.t_fails(2, $s$insert into public.profiles(user_id,full_name) values ('45000000-0000-4000-8000-000000000001','Hijack')$s$, '42501');
  perform public.t_fails(2, $s$insert into public.profiles(user_id,full_name) values ('45000000-0000-4000-8000-000000000001','Hijack') on conflict (user_id) do update set full_name=excluded.full_name$s$, '42501');
  -- Without a user_id the upsert targets the caller's own row, never another's.
  perform public.t_rows_changed(2, $s$insert into public.profiles(full_name) values ('Second Customer') on conflict (user_id) do update set full_name=excluded.full_name$s$, 1);
  reset role;
  perform public.test_assert(public.t_rows() = before_rows, 'no cross-user or admin attempt changed any row');
end $$;
-- Moving a row to another user is refused for a column privilege, and (for any role) by the trigger.
set local role authenticated;
select public.t_fails(2, $s$update public.profiles set user_id='45000000-0000-4000-8000-000000000001' where user_id=auth.uid()$s$, '42501', 'permission denied');
reset role;
do $$ begin
  begin update public.profiles set user_id=public.t_user(1) where user_id=public.t_user(2);
  exception when others then if sqlstate='22023' and sqlerrm='profile owner is immutable' then return; end if; raise; end;
  raise exception 'the owner of a profile changed';
end $$;
-- anon: nothing.
set local role anon;
select set_config('request.jwt.claims','{}',false);
do $$ begin
  begin perform count(*) from public.profiles; raise exception 'anon selected'; exception when insufficient_privilege then null; end;
  begin insert into public.profiles(user_id,full_name) values (public.t_user(1),'Anon'); raise exception 'anon inserted'; exception when insufficient_privilege then null; end;
  begin update public.profiles set full_name='Anon'; raise exception 'anon updated'; exception when insufficient_privilege then null; end;
  begin delete from public.profiles; raise exception 'anon deleted'; exception when insufficient_privilege then null; end;
end $$;
reset role;

-- 3. No DELETE for anyone (the row goes with the Auth account only). --------------------------------------------------
set local role authenticated;
select public.t_fails(1, $s$delete from public.profiles where user_id=auth.uid()$s$, '42501', 'permission denied');
select public.t_fails(3, $s$delete from public.profiles$s$, '42501', 'permission denied');
select public.t_fails(1, $s$truncate public.profiles$s$, '42501', 'permission denied');
reset role;
select public.test_assert((select count(*)=3 from public.profiles), 'no profile was deleted');

-- 4. The name: 1 to 120 characters, already trimmed. -------------------------------------------------------------------
set local role authenticated;
select public.t_rows_changed(1, $s$update public.profiles set full_name='N' where user_id=auth.uid()$s$, 1);
select public.t_rows_changed(1, $s$update public.profiles set full_name=repeat('N',120) where user_id=auth.uid()$s$, 1);
select public.t_rows_changed(1, $s$update public.profiles set full_name=repeat(chr(233),120) where user_id=auth.uid()$s$, 1);   -- characters, not bytes
select public.t_rows_changed(1, $s$update public.profiles set full_name='Mary  Ann' where user_id=auth.uid()$s$, 1);               -- inner spaces are kept
select public.t_fails(1, $s$update public.profiles set full_name='' where user_id=auth.uid()$s$, '23514', 'profiles_full_name_trimmed_check');
select public.t_fails(1, $s$update public.profiles set full_name='   ' where user_id=auth.uid()$s$, '23514', 'profiles_full_name_trimmed_check');
select public.t_fails(1, $s$update public.profiles set full_name=repeat('N',121) where user_id=auth.uid()$s$, '23514', 'profiles_full_name_trimmed_check');
select public.t_fails(1, $s$update public.profiles set full_name=' Neha' where user_id=auth.uid()$s$, '23514', 'profiles_full_name_trimmed_check');
select public.t_fails(1, $s$update public.profiles set full_name='Neha ' where user_id=auth.uid()$s$, '23514', 'profiles_full_name_trimmed_check');
select public.t_fails(1, $s$update public.profiles set full_name=repeat('N',119)||' ' where user_id=auth.uid()$s$, '23514', 'profiles_full_name_trimmed_check');
select public.t_fails(1, $s$update public.profiles set full_name=null where user_id=auth.uid()$s$, '23502');
select public.t_fails(5, $s$insert into public.profiles(full_name) values ('') on conflict (user_id) do update set full_name=excluded.full_name$s$, '23514', 'profiles_full_name_trimmed_check');
select public.t_fails(5, $s$insert into public.profiles(full_name) values (repeat('N',121)) on conflict (user_id) do update set full_name=excluded.full_name$s$, '23514', 'profiles_full_name_trimmed_check');
select public.t_fails(5, $s$insert into public.profiles(full_name) values (' padded ') on conflict (user_id) do update set full_name=excluded.full_name$s$, '23514', 'profiles_full_name_trimmed_check');
select public.t_fails(6, $s$insert into public.profiles(full_name) values ('') $s$, '23514', 'profiles_full_name_trimmed_check');
select public.t_fails(6, $s$insert into public.profiles(full_name) values (' x')$s$, '23514', 'profiles_full_name_trimmed_check');
select public.t_rows_changed(6, $s$insert into public.profiles(full_name) values ('Delete Me')$s$, 1);
reset role;
select public.test_assert((select full_name from public.profiles where user_id=public.t_user(1))='Mary  Ann' and (select full_name from public.profiles where user_id=public.t_user(5))='Second save', 'refused names changed nothing');

-- 5. Deleting the Auth account removes the profile (and nothing else's). ---------------------------------------------
delete from auth.users where id=public.t_user(6);
select public.test_assert((select count(*)=0 from public.profiles where user_id=public.t_user(6)) and (select count(*)=3 from public.profiles), 'the profile goes with its Auth account only');

-- 6. Writes need an active session; reads do not. -----------------------------------------------------------------------
set local role authenticated;
select public.t_rows_changed(7, $s$insert into public.profiles(full_name) values ('Active session')$s$, 1);
select public.t_rows_changed(7, $s$update public.profiles set full_name='Active again' where user_id=auth.uid()$s$, 1);
select public.t_dead_all('missing');
select public.t_dead_all('null');
select public.t_dead_all('empty');
select public.t_dead_all('malformed');
select public.t_dead_all('foreign');
reset role;
-- A still-unexpired JWT whose session row was deleted (sign-out) or has expired.
delete from auth.sessions where id in (public.t_session(2), public.t_session(7));
set local role authenticated;
select public.t_dead_all('own');
-- ... but the owner can still read their own row (the SELECT policy has no session requirement).
select public.t_as(2);
select public.test_assert((select count(*)=1 and min(full_name)='Second Customer' from public.profiles), 'a dead session can still read its own row');
reset role;
insert into auth.sessions(id,user_id) values (public.t_session(2),public.t_user(2)), (public.t_session(7),public.t_user(7));
update auth.sessions set not_after = clock_timestamp() - interval '1 second' where id in (public.t_session(2), public.t_session(7));
set local role authenticated;
select public.t_dead_all('own');
reset role;
-- A restored session works again; another user's dead session never affected anyone else.
update auth.sessions set not_after = null where id in (public.t_session(2), public.t_session(7));
set local role authenticated;
select public.t_rows_changed(2, $s$update public.profiles set full_name='Second Customer back' where user_id=auth.uid()$s$, 1);
reset role;
rollback;
