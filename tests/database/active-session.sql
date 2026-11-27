\set ON_ERROR_STOP on
-- Active-session authorization (#213 slice A). A JWT can stay unexpired after its Auth session was signed out (row
-- deleted) or expired (not_after in the past). The checkout, owner, offer and notification-marker RPCs must then refuse and
-- leave the database untouched. Also: missing, null, malformed and another user's session_id, and the happy path
-- including an idempotent checkout retry. Self-contained; rolls back. Every identity here sets request.jwt.claims
-- explicitly, so the fixture's implicit session is never used.
begin;
-- 1 customer, 2 other customer, 3 owner (Ammu Sammu), 4 owner (Kokani Dine Inn). Session ids differ from user ids.
insert into auth.users(id) select ('21300000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,4) n;
insert into auth.sessions(id,user_id) select ('21300000-0000-4000-b000-'||lpad(n::text,12,'0'))::uuid, ('21300000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,4) n;
insert into public.business_memberships(business_id,user_id,role) values
 ('10000000-0000-4000-8000-000000000001','21300000-0000-4000-8000-000000000003','admin'),
 ('10000000-0000-4000-8000-000000000002','21300000-0000-4000-8000-000000000004','admin');
insert into public.customer_addresses(customer_id,label,house,street_area,latitude,longitude,location_source)
 select ('21300000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'home','Session house','Session road',0.5,0.5,'pin' from generate_series(1,2) n;
do $$ declare ns text; begin
  select n.nspname into strict ns from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='postgis';
  execute format('update public.businesses set is_demo=false,service_area=%I.st_geomfromtext(''MULTIPOLYGON(((0 0,1 0,1 1,0 1,0 0)))'',4326),service_area_source=''session test'',service_area_version=''test'',service_area_verified_at=now(),ordering_enabled=true,accepting_orders=true,delivery_fee_paise=0,min_order_paise=0 where slug=''ammu-sammu''',ns);
end $$;
insert into public.menu_categories(id,business_id,name,sort_order) values
 ('21300000-0000-4000-8000-0000000000c1','10000000-0000-4000-8000-000000000001','Session mains',90);
insert into public.menu_items(id,business_id,name,category_id,price_paise,diet,sort_order) values
 ('21300000-0000-4000-8000-0000000000d1','10000000-0000-4000-8000-000000000001','Session one','21300000-0000-4000-8000-0000000000c1',20000,'veg',0),
 ('21300000-0000-4000-8000-0000000000d2','10000000-0000-4000-8000-000000000001','Session two','21300000-0000-4000-8000-0000000000c1',10000,'veg',1);
-- An automatic offer, so a successful checkout records a redemption that a refused one must not.
insert into public.offers(business_id,name,kind,value,apply_mode) values ('10000000-0000-4000-8000-000000000001','Session offer','percent',10,'automatic');

-- Helpers (rolled back with the suite).
create function public.t_user(n integer) returns uuid language sql immutable as $$ select ('21300000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
create function public.t_session(n integer) returns uuid language sql immutable as $$ select ('21300000-0000-4000-b000-'||lpad(n::text,12,'0'))::uuid $$;
-- Sign in as user n with an unexpired JWT whose session claim is shaped by mode.
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
-- Everything a refused call must leave alone, read with definer rights so the caller's RLS does not hide anything.
create function public.t_state() returns jsonb language sql security definer set search_path = '' as $$
  select jsonb_build_object(
    'orders', (select coalesce(jsonb_agg(jsonb_build_array(id,status,version,idempotency_key) order by id),'[]') from public.orders where customer_id in (select ('21300000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,4) n)),
    'history', (select count(*) from public.order_status_history h join public.orders o on o.id=h.order_id where o.business_id='10000000-0000-4000-8000-000000000001'),
    'actors', (select count(*) from public.order_status_actors),
    'items', (select count(*) from public.order_items),
    'redemptions', (select count(*) from public.offer_redemptions),
    'offer_attempts', (select count(*) from offers_private.code_attempts),
    'relationships', (select count(*) from public.customer_businesses),
    'accepting', (select accepting_orders from public.businesses where slug='ammu-sammu'),
    'accepting_changes', (select count(*) from public.accepting_orders_changes),
    'item_sort', (select jsonb_agg(jsonb_build_array(id,sort_order) order by id) from public.menu_items where category_id='21300000-0000-4000-8000-0000000000c1'),
    'category_sort', (select jsonb_agg(jsonb_build_array(id,sort_order) order by id) from public.menu_categories where business_id='10000000-0000-4000-8000-000000000001'),
    'notifications', (select coalesce(jsonb_agg(jsonb_build_array(id,read_at) order by id),'[]') from public.customer_notifications where user_id=public.t_user(1))) $$;
-- Redemptions are owner-readable only, so count them with definer rights.
create function public.t_redemptions() returns bigint language sql security definer set search_path = '' as $$ select count(*) from public.offer_redemptions $$;
create function public.t_cart() returns jsonb language sql stable as $$
  select '[{"menu_item_id":"21300000-0000-4000-8000-0000000000d1","quantity":1},{"menu_item_id":"21300000-0000-4000-8000-0000000000d2","quantity":2}]'::jsonb $$;
-- Checkout under the current identity. Rejected-session cases pass a quote captured with a live session.
create function public.t_place(key integer, accepted jsonb default null) returns jsonb language sql as $$
  select public.place_order('ammu-sammu',public.t_cart(),public.test_delivery('Session'),null,('21300000-0000-4000-9000-'||lpad(key::text,12,'0'))::uuid,
    coalesce(accepted,public.quote_order('ammu-sammu',public.t_cart(),null)->'pricing')) $$;
create function public.t_order(key integer) returns uuid language sql security definer set search_path = '' as $$
  select id from public.orders where idempotency_key=('21300000-0000-4000-9000-'||lpad(key::text,12,'0'))::uuid $$;
-- Run one statement as user n (shaped by mode) and require the active-session refusal: 42501 with detail INVALID_SESSION.
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
-- Every protected RPC, each as its proper actor (1 customer, 3 owner), and the database must be unchanged afterwards.
-- The two orders are placed in the happy-path section below.
create function public.t_refuse_all(mode text) returns void language plpgsql as $$
declare before_state jsonb := public.t_state(); o2 uuid := public.t_order(2); n1 uuid;
begin
  select id into n1 from public.customer_notifications where user_id=public.t_user(1) order by id limit 1;
  perform public.t_denied(1, mode, 'select public.t_place(3, current_setting(''t.accepted_quote'')::jsonb)');                -- a new checkout
  perform public.t_denied(1, mode, 'select public.t_place(1, current_setting(''t.accepted_quote'')::jsonb)');                -- a retry of an order that already exists
  perform public.t_denied(1, mode, $q$select public.place_order('ammu-sammu',public.t_cart(),public.test_delivery('Session'),null,'21300000-0000-4000-9000-000000000004',current_setting('t.accepted_quote')::jsonb,null)$q$);
  perform public.t_denied(1, mode, $q$select public.check_offer_code('ammu-sammu','INVALID238')$q$);
  perform public.t_denied(1, mode, $q$select public.quote_order('ammu-sammu',public.t_cart(),'INVALID238')$q$);
  perform public.t_denied(1, mode, $q$select public.quote_order('ammu-sammu',public.t_cart(),null)$q$);
  perform public.t_denied(3, mode, format('select public.transition_order(%L::uuid,''accepted'',1)', o2));
  perform public.t_denied(3, mode, 'select public.set_accepting_orders(''ammu-sammu'',false)');
  perform public.t_denied(3, mode, 'select public.reorder_menu_items(''ammu-sammu'',''21300000-0000-4000-8000-0000000000c1'',array[''21300000-0000-4000-8000-0000000000d2'',''21300000-0000-4000-8000-0000000000d1'']::uuid[])');
  perform public.t_denied(3, mode, 'select public.reorder_menu_categories(''ammu-sammu'',(select array_agg(id order by sort_order desc,id) from public.menu_categories where business_id=''10000000-0000-4000-8000-000000000001''))');
  perform public.t_denied(1, mode, format('select public.mark_customer_notification_read(''ammu-sammu'',%L::uuid)', n1));
  perform public.t_denied(1, mode, 'select public.mark_all_customer_notifications_read(''ammu-sammu'')');
  perform public.test_assert(public.t_state() = before_state, 'refused calls (' || mode || ') leave the database unchanged');
end $$;

-- 0. The helper is internal: nobody can call it, so nobody can probe or lock sessions through it. ------------------
select public.test_assert(not has_function_privilege('anon','customer_lifecycle_private.require_active_session(uuid)','execute')
  and not has_function_privilege('authenticated','customer_lifecycle_private.require_active_session(uuid)','execute')
  and not has_function_privilege('service_role','customer_lifecycle_private.require_active_session(uuid)','execute'), 'the session helper has no client or service grants');
select public.test_assert((select prosecdef and proconfig = array['search_path=""'] from pg_proc where oid='customer_lifecycle_private.require_active_session(uuid)'::regprocedure), 'the helper is definer with an empty search_path');
select public.test_assert((select count(*)=0 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='require_active_session'), 'the helper is not exposed in public');

-- 1. Happy path with live sessions: every RPC still works, and a checkout retry returns the same order. ------------
set local role authenticated;
select public.t_as(1);
select public.test_assert(public.check_offer_code('ammu-sammu','INVALID238')->>'reason'='not_found', 'an active session can check a code');
select public.test_assert(public.quote_order('ammu-sammu',public.t_cart(),'INVALID238')->'offer_error'->>'reason'='not_found', 'an active session can quote with a code');
select set_config('t.accepted_quote',public.quote_order('ammu-sammu',public.t_cart(),null)->>'pricing',true);
select public.test_assert((public.t_place(1)->>'outcome')='placed', 'checkout succeeds with an active session');
select public.test_assert((public.t_redemptions()=1), 'checkout recorded the offer redemption');
select public.test_assert((public.t_place(1)->>'id')::uuid = public.t_order(1), 'an idempotent retry returns the same order');
select public.test_assert((public.t_place(1)->>'order_number') = (select order_number from public.orders where id=public.t_order(1)), 'the retry returns the same order number');
select public.test_assert((public.t_place(2)->>'outcome')='placed', 'a second checkout with a new key succeeds');
select public.test_assert((select count(*)=2 from public.orders where customer_id=public.t_user(1)) and (public.t_redemptions()=2), 'the retry created no extra order or redemption');
select public.t_as(3);
select public.test_assert((public.transition_order(public.t_order(1),'accepted',1)->>'status')='accepted', 'transition works with an active session');
select public.test_assert((public.set_accepting_orders('ammu-sammu',false)->>'accepting_orders')='false', 'closing works with an active session');
select public.test_assert((public.set_accepting_orders('ammu-sammu',true)->>'accepting_orders')='true', 'opening works with an active session');
select public.test_assert(public.reorder_menu_items('ammu-sammu','21300000-0000-4000-8000-0000000000c1',array['21300000-0000-4000-8000-0000000000d2','21300000-0000-4000-8000-0000000000d1']::uuid[])=2, 'dish reorder works with an active session');
select public.test_assert(public.reorder_menu_categories('ammu-sammu',(select array_agg(id order by sort_order desc,id) from public.menu_categories where business_id='10000000-0000-4000-8000-000000000001'))>0, 'category reorder works with an active session');
-- Another restaurant's owner still fails on membership, with its own error (not the session error).
select public.t_as(4);
do $$ declare d text; begin
  begin perform public.transition_order(public.t_order(2),'accepted',1); raise exception 'cross-business transition succeeded';
  exception when others then get stacked diagnostics d = pg_exception_detail;
    if not (sqlstate='42501' and sqlerrm='order unavailable' and coalesce(d,'')='') then raise; end if; end;
  begin perform public.set_accepting_orders('ammu-sammu',false); raise exception 'cross-business close succeeded';
  exception when others then get stacked diagnostics d = pg_exception_detail;
    if not (sqlstate='42501' and sqlerrm='business unavailable' and coalesce(d,'')='') then raise; end if; end;
end $$;
select public.t_as(1);
select public.test_assert((select count(*)>=1 from public.customer_notifications where user_id=public.t_user(1)), 'the customer has notifications to mark');
select public.test_assert(public.mark_customer_notification_read('ammu-sammu',(select id from public.customer_notifications where user_id=public.t_user(1) order by id limit 1)), 'marking one read works with an active session');
select public.test_assert(public.mark_all_customer_notifications_read('ammu-sammu')>=0, 'marking all read works with an active session');

-- 2. Claims that never name an active session of the caller. ------------------------------------------------------
select public.t_refuse_all('missing');
select public.t_refuse_all('null');
select public.t_refuse_all('empty');
select public.t_refuse_all('malformed');
select public.t_refuse_all('foreign');

-- 3. A still-unexpired JWT whose session row was deleted (sign-out) or has expired. The claim names the caller's own session. --
reset role;
delete from auth.sessions where id in (public.t_session(1), public.t_session(3));
set local role authenticated;
select public.t_refuse_all('own');
reset role;
insert into auth.sessions(id,user_id) values (public.t_session(1),public.t_user(1)), (public.t_session(3),public.t_user(3));
-- Unlike the deleted case the row is still there; only not_after has passed (a second ago, and just now).
update auth.sessions set not_after = clock_timestamp() - interval '1 second' where id in (public.t_session(1), public.t_session(3));
set local role authenticated;
select public.t_refuse_all('own');
reset role;
update auth.sessions set not_after = clock_timestamp() - interval '1 microsecond' where id in (public.t_session(1), public.t_session(3));
set local role authenticated;
select public.t_refuse_all('own');
-- A future not_after is still active.
reset role;
update auth.sessions set not_after = clock_timestamp() + interval '1 hour' where id in (public.t_session(1), public.t_session(3));
set local role authenticated;
select public.t_as(1);
select public.test_assert((public.t_place(1)->>'id')::uuid = public.t_order(1), 'a session with a future not_after is active');

-- 4. The deleted session of one user does not affect another's; a restored session works again, including the retry. ---
reset role;
delete from auth.sessions where id = public.t_session(1);
set local role authenticated;
select public.t_as(3);
select public.test_assert((public.transition_order(public.t_order(2),'accepted',1)->>'status')='accepted', 'the owner is unaffected by the customer''s deleted session');
reset role;
insert into auth.sessions(id,user_id) values (public.t_session(1),public.t_user(1));
set local role authenticated;
select public.t_as(1);
select public.test_assert((public.t_place(1)->>'id')::uuid = public.t_order(1) and (select count(*)=2 from public.orders where customer_id=public.t_user(1)), 'after signing in again the same key returns the same order');
select public.test_assert((public.t_redemptions()=2), 'the same-key retry after sign-in redeemed nothing more');
reset role;
rollback;
