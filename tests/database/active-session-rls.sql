\set ON_ERROR_STOP on
-- Active-session authorization for direct writes through RLS (#213 slice B). A still-unexpired JWT whose Auth session was
-- deleted, has expired, belongs to someone else or is absent must not insert/update/delete menu items, categories, offers
-- or saved addresses, nor mark a notification read; the tables stay unchanged. With an active session the same
-- statements work, other restaurants' owners and other customers are still stopped by the existing rules, and
-- device_tokens has no direct write grant at all. Self-contained; rolls back. Every identity sets request.jwt.claims.
begin;
-- 1 customer, 2 other customer, 3 owner (Ammu Sammu), 4 owner (Kokani Dine Inn).
insert into auth.users(id) select ('21320000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,4) n;
insert into auth.sessions(id,user_id) select ('21320000-0000-4000-b000-'||lpad(n::text,12,'0'))::uuid, ('21320000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,4) n;
insert into public.business_memberships(business_id,user_id,role) values
 ('10000000-0000-4000-8000-000000000001','21320000-0000-4000-8000-000000000003','admin'),
 ('10000000-0000-4000-8000-000000000002','21320000-0000-4000-8000-000000000004','admin');
insert into public.menu_categories(id,business_id,name,sort_order) values
 ('21320000-0000-4000-8000-0000000000c1','10000000-0000-4000-8000-000000000001','RLS session mains',90),
 ('21320000-0000-4000-8000-0000000000c2','10000000-0000-4000-8000-000000000001','RLS session empty',91);
insert into public.menu_items(id,business_id,name,category_id,price_paise,diet,sort_order) values
 ('21320000-0000-4000-8000-0000000000d1','10000000-0000-4000-8000-000000000001','RLS one','21320000-0000-4000-8000-0000000000c1',20000,'veg',0);
insert into public.offers(id,business_id,name,kind,value,apply_mode) values
 ('21320000-0000-4000-8000-0000000000e1','10000000-0000-4000-8000-000000000001','RLS offer','percent',10,'automatic');
insert into public.customer_addresses(id,customer_id,label,house,street_area,latitude,longitude,location_source) values
 ('21320000-0000-4000-8000-0000000000a1','21320000-0000-4000-8000-000000000001','home','RLS house','RLS road',0.5,0.5,'pin'),
 ('21320000-0000-4000-8000-0000000000a2','21320000-0000-4000-8000-000000000002','home','Other house','RLS road',0.5,0.5,'pin');
-- A notification for customer 1, which needs a real order (the order's own trigger writes one; replace it with a known id).
insert into public.orders(id,business_id,customer_id,customer_name,customer_phone,delivery_address_line,latitude,longitude,address_label,address_house,address_street_area,address_location_source,saved_address_id,saved_address_version,subtotal_paise,delivery_fee_paise,total_paise,idempotency_key,request_hash) values
 ('21320000-0000-4000-8000-0000000000f2','10000000-0000-4000-8000-000000000001','21320000-0000-4000-8000-000000000001','RLS','1','RLS road',0.5,0.5,'home','RLS house','RLS road','pin','21320000-0000-4000-8000-0000000000a1',1,100,0,100,'21320000-0000-4000-9000-000000000001','rls');
delete from public.customer_notifications where order_id='21320000-0000-4000-8000-0000000000f2';
insert into public.customer_notifications(id,user_id,business_id,order_id,event_status,title,body) values
 ('21320000-0000-4000-8000-0000000000f1','21320000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','21320000-0000-4000-8000-0000000000f2','placed','Order update','Placed.');

create function public.t_user(n integer) returns uuid language sql immutable as $$ select ('21320000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
create function public.t_session(n integer) returns uuid language sql immutable as $$ select ('21320000-0000-4000-b000-'||lpad(n::text,12,'0'))::uuid $$;
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
-- Every row of every in-scope table, read with definer rights so RLS hides nothing.
create function public.t_state() returns jsonb language sql security definer set search_path = '' as $$
  select jsonb_build_object(
    'items', (select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') from public.menu_items t),
    'categories', (select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') from public.menu_categories t),
    'offers', (select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') from public.offers t),
    'addresses', (select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') from public.customer_addresses t),
    'notifications', (select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') from public.customer_notifications t),
    'profiles', (select coalesce(jsonb_agg(to_jsonb(t) order by t.user_id),'[]') from public.profiles t),
    'devices', (select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') from public.device_tokens t)) $$;
-- As user n: the statement must fail with the active-session refusal (42501, 'invalid session', detail INVALID_SESSION).
create function public.t_denied(n integer, mode text, stmt text) returns void language plpgsql as $$
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
-- As user n with an active session: an ordinary RLS refusal. INSERT raises a bare 42501 row-level-security error;
-- UPDATE and DELETE see no row. Neither is the session error.
create function public.t_rls_refused(n integer, stmt text) returns void language plpgsql as $$
declare rows bigint; detail text;
begin
  perform public.t_as(n);
  begin execute stmt; get diagnostics rows = row_count;
  exception when others then
    get stacked diagnostics detail = pg_exception_detail;
    if sqlstate = '42501' and sqlerrm like 'new row violates row-level security policy%' and detail is distinct from 'INVALID_SESSION' then return; end if;
    raise exception 'wrong error for [%] (user %): % % %', stmt, n, sqlstate, sqlerrm, detail;
  end;
  if rows <> 0 then raise exception 'statement changed % rows for another business or customer: [%]', rows, stmt; end if;
end $$;
-- As user n with an active session: the statement affects exactly one row.
create function public.t_ok(n integer, stmt text) returns void language plpgsql as $$
declare rows bigint;
begin
  perform public.t_as(n);
  execute stmt; get diagnostics rows = row_count;
  if rows <> 1 then raise exception 'expected one row for [%], got %', stmt, rows; end if;
end $$;
-- The statements under test. Owner (3) edits the Ammu Sammu menu and offers; customer (1) manages their own address and inbox.
create function public.t_writes() returns text[] language sql immutable as $$ select array[
  -- (statement, actor) pairs flattened: even index = actor, odd = statement
  '3', $s$insert into public.menu_items(business_id,name,category_id,price_paise,diet) values ('10000000-0000-4000-8000-000000000001','RLS new','21320000-0000-4000-8000-0000000000c1',100,'veg')$s$,
  '3', $s$update public.menu_items set name='RLS hacked' where id='21320000-0000-4000-8000-0000000000d1'$s$,
  '3', $s$delete from public.menu_items where id='21320000-0000-4000-8000-0000000000d1'$s$,
  '3', $s$insert into public.menu_categories(business_id,name,sort_order) values ('10000000-0000-4000-8000-000000000001','RLS new category',1)$s$,
  '3', $s$update public.menu_categories set name='RLS hacked' where id='21320000-0000-4000-8000-0000000000c1'$s$,
  '3', $s$delete from public.menu_categories where id='21320000-0000-4000-8000-0000000000c2'$s$,
  '3', $s$insert into public.offers(business_id,name,kind,value,apply_mode) values ('10000000-0000-4000-8000-000000000001','RLS new offer','percent',5,'automatic')$s$,
  '3', $s$update public.offers set name='RLS hacked' where id='21320000-0000-4000-8000-0000000000e1'$s$,
  '1', $s$insert into public.customer_addresses(label,house,street_area,latitude,longitude,location_source) values ('work','RLS new house','RLS new road',0.5,0.5,'pin')$s$,
  '1', $s$update public.customer_addresses set house='RLS hacked' where id='21320000-0000-4000-8000-0000000000a1'$s$,
  '1', $s$delete from public.customer_addresses where id='21320000-0000-4000-8000-0000000000a1'$s$,
  '1', $s$update public.customer_notifications set read_at=now() where id='21320000-0000-4000-8000-0000000000f1'$s$] $$;
-- Every in-scope write, as its actor, with the given session shape; the database must be unchanged afterwards.
create function public.t_refuse_all(mode text) returns void language plpgsql as $$
declare before_state jsonb := public.t_state(); w text[] := public.t_writes(); i integer;
begin
  for i in 1..array_length(w,1)/2 loop
    perform public.t_denied(w[2*i-1]::integer, mode, w[2*i]);
  end loop;
  perform public.test_assert(public.t_state() = before_state, 'refused direct writes (' || mode || ') leave every table unchanged');
end $$;

-- 0. The predicate and the policies. ------------------------------------------------------------------------------
select public.test_assert(has_function_privilege('authenticated','session_rls_private.require_active_session()','execute')
  and not has_function_privilege('anon','session_rls_private.require_active_session()','execute')
  and not has_function_privilege('service_role','session_rls_private.require_active_session()','execute'), 'only authenticated may execute the predicate');
select public.test_assert(has_schema_privilege('authenticated','session_rls_private','usage') and not has_schema_privilege('anon','session_rls_private','usage')
  and not has_schema_privilege('authenticated','session_rls_private','create') and not has_schema_privilege('service_role','session_rls_private','usage'), 'the predicate schema is usable by authenticated only');
select public.test_assert((select prosecdef and provolatile='s' and proconfig = array['search_path=""'] and pronargs=0 and prorettype='boolean'::regtype from pg_proc where oid='session_rls_private.require_active_session()'::regprocedure), 'the predicate is stable, definer, argument-free, boolean, with an empty search_path');
select public.test_assert((select count(*)=0 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='require_active_session'), 'the predicate is not exposed in public');
-- Exactly the write policies under test carry it; no SELECT policy does; every in-scope write policy does.
select public.test_assert((select count(*)=12 from pg_policies where schemaname='public' and tablename not in ('profiles','device_tokens') and (coalesce(qual,'')||coalesce(with_check,'')) like '%require_active_session%'), 'twelve existing policies use the predicate (profiles and devices checked separately)');
select public.test_assert((select count(*)=0 from pg_policies where schemaname='public' and cmd='SELECT' and (coalesce(qual,'')||coalesce(with_check,'')) like '%require_active_session%'), 'no SELECT policy uses the predicate');
select public.test_assert((select count(*)=0 from pg_policies where schemaname='public' and cmd in ('INSERT','UPDATE','DELETE') and tablename in ('menu_items','menu_categories','offers','customer_addresses')
  and ((cmd in ('UPDATE','DELETE') and qual not like '%require_active_session%') or (cmd in ('INSERT','UPDATE') and with_check not like '%require_active_session%'))), 'every direct write policy of the four tables requires the session');
select public.test_assert((select count(*)=1 from pg_policies where schemaname='public' and tablename='customer_notifications' and cmd='UPDATE' and qual like '%require_active_session%' and with_check like '%require_active_session%'), 'the notification read marker policy requires the session');
-- device_tokens: no direct write grant for any client role.
select public.test_assert(not has_table_privilege('authenticated','public.device_tokens','insert') and not has_table_privilege('authenticated','public.device_tokens','update')
  and not has_table_privilege('authenticated','public.device_tokens','delete') and not has_table_privilege('anon','public.device_tokens','insert')
  and not has_table_privilege('anon','public.device_tokens','update') and not has_table_privilege('anon','public.device_tokens','delete')
  and not has_any_column_privilege('authenticated','public.device_tokens','insert') and not has_any_column_privilege('authenticated','public.device_tokens','update'), 'device_tokens has no direct write grant');

-- 1. Active sessions: every in-scope write works. ------------------------------------------------------------------
set local role authenticated;
select public.t_as(3);
select public.test_assert(session_rls_private.require_active_session(), 'the predicate is true for an active session');
select public.t_ok(3, $s$insert into public.menu_items(id,business_id,name,category_id,price_paise,diet) values ('21320000-0000-4000-8000-0000000000d2','10000000-0000-4000-8000-000000000001','RLS two','21320000-0000-4000-8000-0000000000c1',300,'veg')$s$);
select public.t_ok(3, $s$update public.menu_items set name='RLS two renamed' where id='21320000-0000-4000-8000-0000000000d2'$s$);
select public.t_ok(3, $s$delete from public.menu_items where id='21320000-0000-4000-8000-0000000000d2'$s$);
select public.t_ok(3, $s$insert into public.menu_categories(id,business_id,name,sort_order) values ('21320000-0000-4000-8000-0000000000c3','10000000-0000-4000-8000-000000000001','RLS third',3)$s$);
select public.t_ok(3, $s$update public.menu_categories set name='RLS third renamed' where id='21320000-0000-4000-8000-0000000000c3'$s$);
select public.t_ok(3, $s$delete from public.menu_categories where id='21320000-0000-4000-8000-0000000000c3'$s$);
select public.t_ok(3, $s$insert into public.offers(business_id,name,kind,value,apply_mode) values ('10000000-0000-4000-8000-000000000001','RLS second offer','percent',5,'automatic')$s$);
select public.t_ok(3, $s$update public.offers set name='RLS second renamed' where name='RLS second offer'$s$);
-- Customers manage their own addresses and inbox marker.
select public.t_ok(1, $s$insert into public.customer_addresses(label,house,street_area,latitude,longitude,location_source) values ('work','RLS second','RLS road',0.5,0.5,'pin')$s$);
select public.t_ok(1, $s$update public.customer_addresses set house='RLS second edited' where house='RLS second'$s$);
select public.t_ok(1, $s$delete from public.customer_addresses where house='RLS second edited'$s$);
reset role;
-- A future not_after is still active.
update auth.sessions set not_after = clock_timestamp() + interval '1 hour' where id in (public.t_session(1), public.t_session(3));
set local role authenticated;
select public.t_ok(3, $s$update public.menu_items set name='RLS future session' where id='21320000-0000-4000-8000-0000000000d1'$s$);
select public.t_ok(1, $s$update public.customer_addresses set house='RLS future session' where id='21320000-0000-4000-8000-0000000000a1'$s$);
reset role;
update auth.sessions set not_after = null where id in (public.t_session(1), public.t_session(3));

-- 2. Cross-business and cross-customer attempts with an ACTIVE session are still refused by the existing rules. -----
set local role authenticated;
do $$ declare before_state jsonb := public.t_state(); begin
  perform public.t_rls_refused(4, $s$insert into public.menu_items(business_id,name,category_id,price_paise,diet) values ('10000000-0000-4000-8000-000000000001','RLS cross','21320000-0000-4000-8000-0000000000c1',100,'veg')$s$);
  perform public.t_rls_refused(4, $s$update public.menu_items set name='RLS cross' where id='21320000-0000-4000-8000-0000000000d1'$s$);
  perform public.t_rls_refused(4, $s$delete from public.menu_items where id='21320000-0000-4000-8000-0000000000d1'$s$);
  perform public.t_rls_refused(4, $s$insert into public.menu_categories(business_id,name,sort_order) values ('10000000-0000-4000-8000-000000000001','RLS cross',1)$s$);
  perform public.t_rls_refused(4, $s$update public.menu_categories set name='RLS cross' where id='21320000-0000-4000-8000-0000000000c1'$s$);
  perform public.t_rls_refused(4, $s$delete from public.menu_categories where id='21320000-0000-4000-8000-0000000000c2'$s$);
  perform public.t_rls_refused(4, $s$insert into public.offers(business_id,name,kind,value,apply_mode) values ('10000000-0000-4000-8000-000000000001','RLS cross offer','percent',5,'automatic')$s$);
  perform public.t_rls_refused(4, $s$update public.offers set name='RLS cross' where id='21320000-0000-4000-8000-0000000000e1'$s$);
  perform public.t_rls_refused(2, $s$update public.customer_addresses set house='RLS cross' where id='21320000-0000-4000-8000-0000000000a1'$s$);
  perform public.t_rls_refused(2, $s$delete from public.customer_addresses where id='21320000-0000-4000-8000-0000000000a1'$s$);
  perform public.t_rls_refused(2, $s$update public.customer_notifications set read_at=now() where id='21320000-0000-4000-8000-0000000000f1'$s$);
  perform public.test_assert(public.t_state() = before_state, 'cross-business and cross-customer attempts leave every table unchanged');
end $$;

-- 3. Claims that never name an active session of the caller. ------------------------------------------------------
select public.t_refuse_all('missing');
select public.t_refuse_all('null');
select public.t_refuse_all('empty');
select public.t_refuse_all('malformed');
select public.t_refuse_all('foreign');
-- A session id in uppercase is the same UUID and is accepted (Auth issues lowercase; nothing else changes).
select public.t_as(3);
select set_config('request.jwt.claims', jsonb_build_object('sub',public.t_user(3),'session_id',upper(public.t_session(3)::text))::text, false);
select public.test_assert(session_rls_private.require_active_session(), 'an uppercase canonical session id is accepted');

-- 4. A still-unexpired JWT whose session row was deleted (sign-out) or has expired. -------------------------------
reset role;
delete from auth.sessions where id in (public.t_session(1), public.t_session(3));
set local role authenticated;
select public.t_refuse_all('own');
-- A signed-out session receives the same refusal regardless of the target or row count.
do $$ declare before_state jsonb := public.t_state(); begin
  perform public.t_denied(1, 'own', $s$update public.customer_addresses set house='RLS refused' where id='21320000-0000-4000-8000-0000000000a2'$s$);
  perform public.t_denied(1, 'own', $s$update public.customer_addresses set house='RLS refused' where id='21320000-0000-4000-8000-0000000000a3'$s$);
  perform public.t_denied(1, 'own', $s$delete from public.customer_addresses where false$s$);
  perform public.t_denied(1, 'own', $s$update public.customer_notifications set read_at=now() where false$s$);
  perform public.t_denied(1, 'own', $s$update public.profiles set full_name='RLS refused' where false$s$);
  perform public.t_denied(3, 'own', $s$update public.menu_items set name='RLS refused' where false$s$);
  perform public.t_denied(3, 'own', $s$delete from public.menu_categories where false$s$);
  perform public.t_denied(3, 'own', $s$update public.offers set name='RLS refused' where false$s$);
  perform public.test_assert(public.t_state() = before_state, 'session refusal leaves all tables unchanged');
end $$;
select public.t_as(1);
select public.test_assert(exists(select 1 from public.customer_addresses where id='21320000-0000-4000-8000-0000000000a1'),
  'the existing address SELECT policy still works with a dead session');
reset role;
insert into auth.sessions(id,user_id) values (public.t_session(1),public.t_user(1)), (public.t_session(3),public.t_user(3));
update auth.sessions set not_after = clock_timestamp() - interval '1 second' where id in (public.t_session(1), public.t_session(3));
set local role authenticated;
select public.t_refuse_all('own');
reset role;
update auth.sessions set not_after = clock_timestamp() - interval '1 microsecond' where id in (public.t_session(1), public.t_session(3));
set local role authenticated;
select public.t_refuse_all('own');

-- 5. Another user's deleted session affects nobody else; a restored session works again. ---------------------------
reset role;
delete from auth.sessions where id = public.t_session(1);
update auth.sessions set not_after = null where id = public.t_session(3);
set local role authenticated;
select public.t_ok(3, $s$update public.menu_items set name='RLS owner unaffected' where id='21320000-0000-4000-8000-0000000000d1'$s$);
select public.t_denied(1, 'own', $s$update public.customer_addresses set house='RLS gone' where id='21320000-0000-4000-8000-0000000000a1'$s$);
reset role;
insert into auth.sessions(id,user_id) values (public.t_session(1),public.t_user(1));
set local role authenticated;
select public.t_ok(1, $s$update public.customer_addresses set house='RLS back again' where id='21320000-0000-4000-8000-0000000000a1'$s$);
select public.t_rls_refused(1, $s$update public.customer_addresses set house='RLS missing' where id='21320000-0000-4000-8000-0000000000a3'$s$);
-- The read marker is one-way, so the happy path for it runs last.
select public.t_ok(1, $s$update public.customer_notifications set read_at=now() where id='21320000-0000-4000-8000-0000000000f1'$s$);
-- The inactive predicate answers only about the caller: an unauthenticated role cannot even reach it.
reset role;
set local role anon;
do $$ begin
  begin perform session_rls_private.require_active_session(); raise exception 'anon reached the predicate';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- 6. device_tokens: direct writes are refused by privilege, with an active session and without one. ----------------
insert into public.device_tokens(id,user_id,business_id,audience,token) values
 ('21320000-0000-4000-8000-0000000000b1','21320000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','customer','rls-token');
create function public.t_perm_denied(n integer, mode text, stmt text) returns void language plpgsql as $$
begin
  perform public.t_as(n, mode);
  begin execute stmt;
  exception when insufficient_privilege then
    if sqlerrm like 'permission denied for table device_tokens%' then return; end if;
    raise;
  end;
  raise exception 'direct device_tokens write succeeded: [%]', stmt;
end $$;
select public.t_state() as devices_before \gset
set local role authenticated;
select public.t_perm_denied(1, 'own', $s$insert into public.device_tokens(user_id,business_id,audience,token) values ('21320000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','customer','rls-token-2')$s$);
select public.t_perm_denied(1, 'own', $s$update public.device_tokens set token='rls-changed' where id='21320000-0000-4000-8000-0000000000b1'$s$);
select public.t_perm_denied(1, 'own', $s$delete from public.device_tokens where id='21320000-0000-4000-8000-0000000000b1'$s$);
select public.t_perm_denied(3, 'own', $s$insert into public.device_tokens(user_id,business_id,audience,token) values ('21320000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','admin','rls-admin-token')$s$);
select public.t_perm_denied(1, 'missing', $s$update public.device_tokens set token='rls-changed' where id='21320000-0000-4000-8000-0000000000b1'$s$);
reset role;
select public.test_assert(public.t_state()::text = :'devices_before', 'refused device token writes leave the table unchanged');

-- 7. Statement-level session refusal takes precedence over row validation. ----------------------------------------
insert into public.customer_addresses(customer_id,label,house,street_area,latitude,longitude,location_source)
select public.t_user(1),'work','House '||n,'RLS road',0.5,0.5,'pin' from generate_series(1,19) n;
insert into public.offers(business_id,name,kind,value,apply_mode,code) values
 ('10000000-0000-4000-8000-000000000001','Existing RLS code','percent',5,'code','RLSTOP');
create function public.t_validation_precedence(n integer, stmt text, expected_code text, expected_message text) returns void language plpgsql as $$
begin
  perform public.t_as(n);
  begin
    execute stmt;
    raise exception 'expected row validation to refuse the active session statement';
  exception when others then
    if sqlstate <> expected_code or sqlerrm <> expected_message then raise; end if;
  end;
  perform public.t_denied(n, 'missing', stmt);
end $$;
set local role authenticated;
do $$ declare before_state jsonb := public.t_state(); begin
  perform public.t_validation_precedence(1,
    $s$insert into public.customer_addresses(label,house,street_area,latitude,longitude,location_source) values ('work','One too many','RLS road',0.5,0.5,'pin')$s$,
    '23514', 'saved address limit reached');
  perform public.t_validation_precedence(3,
    $s$insert into public.offers(business_id,name,kind,value,apply_mode,code) values ('10000000-0000-4000-8000-000000000001','Duplicate RLS code','percent',5,'code','RLSTOP')$s$,
    '23505', 'code is already in use by another active or scheduled offer');
  perform public.t_validation_precedence(3,
    $s$insert into public.menu_items(business_id,name,category_id,price_paise) values ('10000000-0000-4000-8000-000000000001','Unclassified dish','21320000-0000-4000-8000-0000000000c1',100)$s$,
    '22023', 'diet classification required');
  perform public.test_assert(public.t_state() = before_state, 'both refusal paths leave all tables unchanged');
end $$;
reset role;

-- 8. A rollback-only grant exercises the device guard and separate write-only RLS policies. ------------------------
savepoint simulated_device_grant;
grant insert, update, delete on public.device_tokens to authenticated;
set local role authenticated;
select public.t_denied(1, 'missing', $s$update public.device_tokens set token='RLS refused' where false$s$);
select public.t_rls_refused(2, $s$delete from public.device_tokens where id='21320000-0000-4000-8000-0000000000b1'$s$);
select public.t_ok(1, $s$update public.device_tokens set token='RLS updated token' where id='21320000-0000-4000-8000-0000000000b1'$s$);
reset role;
alter table public.device_tokens disable trigger require_active_session;
set local role authenticated;
select public.t_denied(1, 'missing', $s$insert into public.device_tokens(user_id,business_id,audience,token) values ('21320000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','customer','RLS refused')$s$);
select public.t_denied(1, 'missing', $s$update public.device_tokens set token='RLS refused' where id='21320000-0000-4000-8000-0000000000b1'$s$);
select public.t_denied(1, 'missing', $s$delete from public.device_tokens where id='21320000-0000-4000-8000-0000000000b1'$s$);
select public.test_assert(exists(select 1 from public.device_tokens where id='21320000-0000-4000-8000-0000000000b1'),
  'the device SELECT policy still works with a dead session');
reset role;
rollback to savepoint simulated_device_grant;
select public.test_assert(not has_table_privilege('authenticated','public.device_tokens','insert,update,delete'),
  'the simulated device write grant was rolled back');
rollback;
