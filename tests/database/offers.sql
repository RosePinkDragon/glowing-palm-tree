\set ON_ERROR_STOP on
-- Offers and order discounts (#182 slice A): constraints, RLS and grants, the issue's acceptance examples,
-- pricing rules, place-time changes, replay, the code rate limit and cancellation. Self-contained; rolls back.
-- The concurrent races live in offers-races.sh.
begin;
-- Customers 1-4, owner 5 (Ammu Sammu) and owner 6 (Kokani Dine Inn).
insert into auth.users(id) select ('18200000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,6) n;
insert into public.business_memberships(business_id,user_id,role) values
 ('10000000-0000-4000-8000-000000000001','18200000-0000-4000-8000-000000000005','admin'),
 ('10000000-0000-4000-8000-000000000002','18200000-0000-4000-8000-000000000006','admin');
insert into public.customer_addresses(customer_id,label,house,street_area,latitude,longitude,location_source)
 select ('18200000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'home','Offer house','Offer road',0.5,0.5,'pin' from generate_series(1,4) n;
do $$ declare ns text; begin
  select n.nspname into strict ns from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='postgis';
  execute format('update public.businesses set service_area=%I.st_geomfromtext(''MULTIPOLYGON(((0 0,1 0,1 1,0 1,0 0)))'',4326),service_area_source=''offers test'',service_area_version=''test'',service_area_verified_at=now(),ordering_enabled=true,accepting_orders=true,delivery_fee_paise=5000,min_order_paise=0 where slug=''ammu-sammu''',ns);
end $$;
insert into public.menu_items(id,business_id,name,category_id,price_paise,diet) values
 ('18200000-0000-4000-a000-000000000001','10000000-0000-4000-8000-000000000001','T250',public.test_category('10000000-0000-4000-8000-000000000001','Offers'),25000,'veg'),
 ('18200000-0000-4000-a000-000000000002','10000000-0000-4000-8000-000000000001','T300',public.test_category('10000000-0000-4000-8000-000000000001','Offers'),30000,'veg'),
 ('18200000-0000-4000-a000-000000000003','10000000-0000-4000-8000-000000000001','T150',public.test_category('10000000-0000-4000-8000-000000000001','Offers'),15000,'veg');

-- Helpers (rolled back with the suite).
create function public.t_cart(p_price integer, p_qty integer) returns jsonb language sql stable as $$
  select jsonb_build_array(jsonb_build_object('menu_item_id',id,'quantity',p_qty)) from public.menu_items where name='T'||(p_price/100) $$;
create function public.t_login(u integer) returns void language sql as $$
  select set_config('request.jwt.claim.sub',('18200000-0000-4000-8000-'||lpad(u::text,12,'0')),false) $$;
create function public.t_quote(cart jsonb, code text default null) returns jsonb language sql as $$ select public.quote_order('ammu-sammu',cart,code) $$;
create function public.t_place(k integer, cart jsonb, code text default null, accepted jsonb default null) returns jsonb language sql as $$
  select public.place_order('ammu-sammu',cart,public.test_delivery('T'),null,('18200000-0000-4000-9000-'||lpad(k::text,12,'0'))::uuid,
    coalesce(accepted,public.quote_order('ammu-sammu',cart,code)->'pricing'),code) $$;
create function public.t_offer(p_kind text, p_value integer, p_apply text default 'automatic', p_code text default null, p_min integer default 0,
  p_max integer default null, p_total integer default null, p_per integer default null, p_first boolean default false,
  p_biz text default 'ammu-sammu', p_name text default 'Test offer') returns uuid language sql as $$
  insert into public.offers(business_id,name,kind,value,max_discount_paise,min_order_paise,apply_mode,code,total_limit,per_customer_limit,first_order_only)
  select id,p_name,p_kind,p_value,p_max,p_min,p_apply,p_code,p_total,p_per,p_first from public.businesses where slug=p_biz returning id $$;
create function public.t_clear() returns void language sql as $$
  delete from public.orders where customer_id::text like '18200000-%';
  delete from public.offers;
  delete from offers_private.code_attempts $$;
create function public.t_fails(stmt text, expected text) returns void language plpgsql as $$
begin
  begin execute stmt;
  exception when others then
    if sqlstate = expected then return; end if;
    raise exception 'wrong error for [%]: % %', stmt, sqlstate, sqlerrm;
  end;
  raise exception 'statement should have failed with %: [%]', expected, stmt;
end $$;
create function public.t_rows(stmt text) returns integer language plpgsql as $$
declare n integer; begin execute stmt; get diagnostics n = row_count; return n; end $$;
-- Insert an offer from a JSON override of a valid base (exercises the constraints one column at a time).
create function public.t_try(o jsonb) returns void language plpgsql as $$
declare r public.offers := jsonb_populate_record(null::public.offers,
  '{"name":"Constraint test","kind":"percent","value":10,"apply_mode":"automatic"}'::jsonb || jsonb_build_object('business_id','10000000-0000-4000-8000-000000000001') || o);
begin
  insert into public.offers(business_id,name,kind,value,max_discount_paise,min_order_paise,apply_mode,code,first_order_only,per_customer_limit,total_limit,starts_at,ends_at,window_from,window_to,window_days)
  values (r.business_id,r.name,r.kind,r.value,r.max_discount_paise,coalesce(r.min_order_paise,0),r.apply_mode,r.code,coalesce(r.first_order_only,false),r.per_customer_limit,r.total_limit,r.starts_at,r.ends_at,r.window_from,r.window_to,r.window_days);
end $$;

-- 1. Structure, grants, publications ---------------------------------------------------------------
select public.test_assert((select relrowsecurity from pg_class where oid='public.offers'::regclass) and (select relrowsecurity from pg_class where oid='public.offer_redemptions'::regclass)
  and (select relrowsecurity from pg_class where oid='offers_private.code_attempts'::regclass),'offers, redemptions and the attempt log have RLS');
select public.test_assert(not exists(select 1 from pg_publication_tables where tablename in ('offers','offer_redemptions','code_attempts')),'no offers table is in a realtime publication');
select public.test_assert(not has_table_privilege('anon','public.offers','select') and not has_table_privilege('anon','public.offer_redemptions','select')
  and not has_table_privilege('authenticated','offers_private.code_attempts','select,insert,update,delete')
  and not has_table_privilege('authenticated','public.offer_redemptions','insert,update,delete') and not has_schema_privilege('authenticated','offers_private','create'),'table grants are minimal');
do $$ declare f text; begin
  foreach f in array array['offers_private.guard_offer()','offers_private.window_open(public.offers,timestamptz)','offers_private.evaluate(public.offers,uuid,bigint,bigint,timestamptz)',
    'offers_private.lock_offers(uuid,uuid,text)','offers_private.resolve(uuid,uuid,text,bigint,bigint,uuid[])','offers_private.price_items(uuid,jsonb,boolean)','offers_private.build_quote(integer,integer,bigint,jsonb,jsonb)'] loop
    perform public.test_assert(not has_function_privilege('anon',f,'execute') and not has_function_privilege('authenticated',f,'execute') and not has_function_privilege('service_role',f,'execute'),'internal '||f||' is not callable by clients');
  end loop;
  foreach f in array array['offers_private.list_active_offers(text)','offers_private.check_offer_code(text,text)','offers_private.quote_order(text,jsonb,text)','offers_private.place_order(text,jsonb,jsonb,jsonb,uuid,jsonb,text)',
    'public.list_active_offers(text)','public.check_offer_code(text,text)','public.quote_order(text,jsonb,text)','public.place_order(text,jsonb,jsonb,jsonb,uuid,jsonb,text)','public.place_order(text,jsonb,jsonb,jsonb,uuid,jsonb)'] loop
    perform public.test_assert(has_function_privilege('authenticated',f,'execute') and not has_function_privilege('service_role',f,'execute')
      and (has_function_privilege('anon',f,'execute') = (f like '%list_active_offers%')),'exact grants for '||f);
    perform public.test_assert((select proconfig @> array['search_path=""'] and prosecdef = (f like 'offers_private.%' and f not like '%window_open%') from pg_proc where oid=f::regprocedure),'definer/invoker split and empty search_path for '||f);
  end loop;
end $$;
select public.test_assert(to_regprocedure('public.place_order(text,jsonb,jsonb,jsonb,uuid)') is null,'no unchecked place_order overload');

-- 2. Constraints -----------------------------------------------------------------------------------
select public.t_try('{}');
select public.t_try('{"value":1}'); select public.t_try('{"value":90}'); select public.t_try('{"kind":"flat","value":100}'); select public.t_try('{"kind":"flat","value":100000}');
select public.t_try('{"kind":"free_delivery","value":null}'); select public.t_try('{"max_discount_paise":100}'); select public.t_try('{"max_discount_paise":100000}');
select public.t_try('{"min_order_paise":0}'); select public.t_try('{"min_order_paise":1000000}'); select public.t_try('{"name":"abc"}');
select public.t_try('{"name":"12345678901234567890123456789012345678 0"}');
select public.t_try('{"apply_mode":"code","code":"ABCD"}'); select public.t_try('{"apply_mode":"code","code":"ABCDEFGHIJ12345"}');
select public.t_try('{"per_customer_limit":1,"total_limit":1}'); select public.t_try('{"per_customer_limit":99,"total_limit":100000}');
select public.t_try('{"starts_at":"2026-12-01T00:00:00Z","ends_at":"2026-12-02T00:00:00Z","window_from":"15:00","window_to":"18:00","window_days":[1,7]}');
select public.t_try('{"window_from":"22:00","window_to":"02:00","window_days":[5]}');
do $$ declare c text; begin
  foreach c in array array[
    '{"value":0}','{"value":91}','{"value":null}','{"kind":"flat","value":99}','{"kind":"flat","value":100001}','{"kind":"free_delivery","value":10}','{"kind":"dish_price","value":10}','{"kind":"bogo","value":null}',
    '{"kind":"flat","value":500,"max_discount_paise":500}','{"max_discount_paise":99}','{"max_discount_paise":100001}',
    '{"min_order_paise":-1}','{"min_order_paise":1000001}','{"name":"ab"}','{"name":"12345678901234567890123456789012345678901"}','{"name":" padded "}','{"name":"bad\u0007name"}',
    '{"apply_mode":"code"}','{"apply_mode":"code","code":"ABC"}','{"apply_mode":"code","code":"ABCDEFGHIJ123456"}','{"apply_mode":"code","code":"AB-CD"}','{"apply_mode":"code","code":"AB CD"}','{"code":"ABCD"}','{"apply_mode":"sometimes"}',
    '{"per_customer_limit":0}','{"per_customer_limit":100}','{"total_limit":0}','{"total_limit":100001}',
    '{"starts_at":"2026-12-02T00:00:00Z","ends_at":"2026-12-02T00:00:00Z"}','{"starts_at":"2026-12-02T00:00:00Z","ends_at":"2026-12-01T00:00:00Z"}',
    '{"window_from":"15:00"}','{"window_from":"15:00","window_to":"18:00"}','{"window_days":[1]}','{"window_from":"15:00","window_to":"15:00","window_days":[1]}',
    '{"window_from":"15:00","window_to":"18:00","window_days":[]}','{"window_from":"15:00","window_to":"18:00","window_days":[0]}','{"window_from":"15:00","window_to":"18:00","window_days":[8]}'] loop
    perform public.t_fails(format('select public.t_try(%L)',c),'23514');
  end loop;
  perform public.t_fails($q$select public.t_try('{"business_id":"10000000-0000-4000-8000-0000000000ff"}')$q$,'23503');
end $$;
-- Codes are stored upper case and unique among a restaurant's not-ended offers (case-insensitively).
select public.t_clear();
select public.t_try('{"apply_mode":"code","code":"save20"}');
select public.test_assert((select code from public.offers)='SAVE20','codes are stored upper case');
select public.t_fails($q$select public.t_try('{"apply_mode":"code","code":"Save20"}')$q$,'23505');
insert into public.offers(business_id,name,kind,value,apply_mode,code) values ('10000000-0000-4000-8000-000000000002','Other restaurant','percent',10,'code','SAVE20');
insert into public.offers(business_id,name,kind,value,apply_mode,code,starts_at,ends_at) values
 ('10000000-0000-4000-8000-000000000001','Scheduled later','percent',10,'code','LATER10',now()+interval '1 day',now()+interval '2 days');
select public.t_fails($q$select public.t_try('{"apply_mode":"code","code":"later10"}')$q$,'23505');
update public.offers set paused=true where code='SAVE20' and business_id='10000000-0000-4000-8000-000000000001';
select public.t_fails($q$select public.t_try('{"apply_mode":"code","code":"SAVE20"}')$q$,'23505');
update public.offers set starts_at=now()-interval '2 days', ends_at=now()-interval '1 day' where code='SAVE20' and business_id='10000000-0000-4000-8000-000000000001';
select public.t_try('{"apply_mode":"code","code":"SAVE20"}');
select public.t_fails($q$update public.offers set ends_at=null where code='SAVE20' and business_id='10000000-0000-4000-8000-000000000001' and ends_at is not null$q$,'23505');
select public.test_assert((select count(*)=1 from public.offers where code='SAVE20' and business_id='10000000-0000-4000-8000-000000000001' and (ends_at is null or ends_at>now())),'one not-ended SAVE20');

-- 3. Acceptance: a 20% offer capped at Rs 100 with a Rs 300 minimum -------------------------------------
select public.t_clear();
select public.t_offer('percent',20,p_min=>30000,p_max=>10000,p_name=>'20 percent off');
set role authenticated;
select public.t_login(1);
select set_config('t.q600',public.t_quote(public.t_cart(30000,2))::text,false);
select public.test_assert((current_setting('t.q600')::jsonb->'pricing'->>'discount_paise')::integer=10000
  and (current_setting('t.q600')::jsonb->'pricing'->>'total_paise')::integer=60000+5000-10000
  and current_setting('t.q600')::jsonb->'pricing'->'offer'->>'kind'='percent' and current_setting('t.q600')::jsonb->'pricing'->'offer'->>'name'='20 percent off'
  and current_setting('t.q600')::jsonb->'pricing'->'offer'->'code'='null'::jsonb,'Rs 600 cart: discount Rs 100 (cap), total 600 + delivery - 100');
-- Rs 250 cart: no discount, the quote keeps exactly its old keys, and the nudge says how much more to add.
select set_config('t.q250',public.t_quote(public.t_cart(25000,1))::text,false);
select public.test_assert(not (current_setting('t.q250')::jsonb->'pricing' ? 'discount_paise') and not (current_setting('t.q250')::jsonb->'pricing' ? 'offer')
  and (current_setting('t.q250')::jsonb->'pricing')=public.test_quote('ammu-sammu',public.t_cart(25000,1)) and (current_setting('t.q250')::jsonb->'pricing'->>'total_paise')::integer=30000
  and (current_setting('t.q250')::jsonb->'nudge'->>'shortfall_paise')::integer=5000 and current_setting('t.q250')::jsonb->'nudge'->>'kind'='percent'
  and (current_setting('t.q250')::jsonb->'nudge'->>'value')::integer=20,'Rs 250 cart: no discount and "add Rs 50 more to get 20% off"');
-- The minimum is checked against the pre-discount subtotal, exactly at the boundary.
select public.test_assert((public.t_quote(public.t_cart(30000,1))->'pricing'->>'discount_paise')::integer=6000,'exactly Rs 300 qualifies: 20% = Rs 60');
-- Placing with the quote stores the discount, the snapshot and the redemption.
select set_config('t.order600',public.t_place(1,public.t_cart(30000,2))::text,false);
select public.test_assert(current_setting('t.order600')::jsonb->>'outcome'='placed' and (current_setting('t.order600')::jsonb->>'discount_paise')::integer=10000
  and (current_setting('t.order600')::jsonb->>'total_paise')::integer=55000 and current_setting('t.order600')::jsonb->'offer'->>'name'='20 percent off','placed order JSON carries the discount and the offer');
select public.test_assert((select discount_paise=10000 and total_paise=55000 and subtotal_paise=60000 and delivery_fee_paise=5000 and offer_name='20 percent off' and offer_kind='percent' and offer_code is null and offer_id is not null
  from public.orders where id=(current_setting('t.order600')::jsonb->>'id')::uuid),'order row keeps the amount and the snapshot');
reset role;
select public.test_assert((select count(*)=1 from public.offer_redemptions where order_id=(current_setting('t.order600')::jsonb->>'id')::uuid and customer_id='18200000-0000-4000-8000-000000000001'),'one redemption per order');
select public.t_fails(format($q$insert into public.offer_redemptions(offer_id,order_id,customer_id,business_id) select offer_id,order_id,customer_id,business_id from public.offer_redemptions where order_id=%L$q$,current_setting('t.order600')::jsonb->>'id'),'23505');
select public.t_fails(format($q$update public.offer_redemptions set business_id='10000000-0000-4000-8000-000000000002' where order_id=%L$q$,current_setting('t.order600')::jsonb->>'id'),'23503');
-- Order constraints: total, non-negative, snapshot and free-delivery rules.
select public.t_fails(format($q$update public.orders set total_paise=total_paise+1 where id=%L$q$,current_setting('t.order600')::jsonb->>'id'),'23514');
select public.t_fails(format($q$update public.orders set discount_paise=65001,total_paise=-1 where id=%L$q$,current_setting('t.order600')::jsonb->>'id'),'23514');
select public.t_fails(format($q$update public.orders set offer_id=null where id=%L$q$,current_setting('t.order600')::jsonb->>'id'),'23514');
select public.t_fails(format($q$update public.orders set offer_kind='free_delivery' where id=%L$q$,current_setting('t.order600')::jsonb->>'id'),'23514');
select public.t_fails(format($q$update public.orders set offer_kind='bogo' where id=%L$q$,current_setting('t.order600')::jsonb->>'id'),'23514');
select public.t_offer('percent',10,p_biz=>'kokani-dine-inn',p_name=>'Other restaurant');
select public.t_fails(format($q$update public.orders set offer_id=(select id from public.offers where name='Other restaurant') where id=%L$q$,current_setting('t.order600')::jsonb->>'id'),'23503');
delete from public.offers where name='Other restaurant';
select public.test_assert((select count(*)=1 from pg_constraint where conrelid='public.orders'::regclass and conname='orders_total_matches') and not exists(select 1 from pg_constraint where conrelid='public.orders'::regclass and conname='orders_check'),'the old total check was replaced');
select public.test_assert((select count(*)=0 from public.orders where discount_paise<>0 and offer_id is null),'existing-style rows stay valid');

-- 4. Pause: no longer applies, placed orders keep their discount, edits lock after use -------------------
update public.offers set paused=true;
set role authenticated; select public.t_login(2);
select public.test_assert(not (public.t_quote(public.t_cart(30000,2))->'pricing' ? 'offer') and (public.t_quote(public.t_cart(30000,2))->'pricing'->>'total_paise')::integer=65000,'paused offer no longer applies');
reset role;
select public.test_assert((select discount_paise=10000 from public.orders where id=(current_setting('t.order600')::jsonb->>'id')::uuid),'the order placed earlier keeps its discount');
select public.t_fails($q$update public.offers set value=30$q$,'PT409');
select public.t_fails($q$update public.offers set min_order_paise=0$q$,'PT409');
select public.t_fails($q$update public.offers set total_limit=5$q$,'PT409');
select public.t_fails($q$delete from public.offers$q$,'23503');
update public.offers set name='Renamed offer', ends_at=now()+interval '30 days', paused=false;
select public.test_assert((select name='Renamed offer' and version=3 and updated_at>=created_at from public.offers),'name, end date and paused stay editable and bump the version');
select public.t_fails($q$update public.offers set id=gen_random_uuid()$q$,'22023');
select public.t_fails($q$update public.offers set business_id='10000000-0000-4000-8000-000000000002'$q$,'22023');

-- 5. Rules: kinds, caps, selection ---------------------------------------------------------------------
select public.t_clear();
select public.t_offer('flat',100000,p_name=>'Rs 1000 off');
set role authenticated; select public.t_login(1);
select public.test_assert((public.t_quote(public.t_cart(15000,1))->'pricing'->>'discount_paise')::integer=15000 and (public.t_quote(public.t_cart(15000,1))->'pricing'->>'total_paise')::integer=5000,'a flat discount never exceeds the subtotal; delivery is still charged');
reset role; select public.t_clear();
select public.t_offer('free_delivery',null,p_name=>'Free delivery');
set role authenticated; select public.t_login(1);
select public.test_assert((public.t_quote(public.t_cart(15000,1))->'pricing'->>'discount_paise')::integer=5000 and (public.t_quote(public.t_cart(15000,1))->'pricing'->>'total_paise')::integer=15000
  and public.t_quote(public.t_cart(15000,1))->'pricing'->'offer'->>'kind'='free_delivery','free delivery takes off exactly the delivery fee');
reset role; update public.businesses set delivery_fee_paise=0 where slug='ammu-sammu';
set role authenticated;
select public.test_assert(not (public.t_quote(public.t_cart(15000,1))->'pricing' ? 'offer'),'free delivery with no fee gives no benefit and is not applied');
reset role; update public.businesses set delivery_fee_paise=5000 where slug='ammu-sammu';
-- Restaurant minimum and offer minimum both use the pre-discount subtotal.
select public.t_clear();
select public.t_offer('flat',5000,p_name=>'Rs 50 off');
update public.businesses set min_order_paise=15000 where slug='ammu-sammu';
set role authenticated; select public.t_login(1);
select public.test_assert((public.t_quote(public.t_cart(15000,1))->'pricing'->>'discount_paise')::integer=5000 and (public.t_quote(public.t_cart(15000,1))->'pricing'->>'total_paise')::integer=15000,'restaurant minimum is met by the subtotal before the discount');
select public.test_assert(public.t_place(2,public.t_cart(15000,1))->>'outcome'='placed','an order whose discounted total is below the minimum can still be placed');
reset role; update public.businesses set min_order_paise=0 where slug='ammu-sammu';
-- Best automatic offer wins; ties go to the earliest created, then the lowest id.
select public.t_clear();
insert into public.offers(id,business_id,name,kind,value,apply_mode,created_at) values
 ('18200000-0000-4000-b000-000000000002','10000000-0000-4000-8000-000000000001','Tie B','flat',2000,'automatic','2026-11-01T00:00:00Z'),
 ('18200000-0000-4000-b000-000000000001','10000000-0000-4000-8000-000000000001','Tie A','flat',2000,'automatic','2026-11-01T00:00:00Z'),
 ('18200000-0000-4000-b000-000000000003','10000000-0000-4000-8000-000000000001','Tie early','flat',2000,'automatic','2026-10-01T00:00:00Z'),
 ('18200000-0000-4000-b000-000000000009','10000000-0000-4000-8000-000000000001','Small','flat',1000,'automatic','2026-09-01T00:00:00Z');
set role authenticated; select public.t_login(1);
select public.test_assert(public.t_quote(public.t_cart(25000,1))->'pricing'->'offer'->>'name'='Tie early','tie: earliest created wins');
reset role; update public.offers set paused=true where name='Tie early';
set role authenticated;
select public.test_assert(public.t_quote(public.t_cart(25000,1))->'pricing'->'offer'->>'name'='Tie A','tie: lowest id wins when created together');
reset role; select public.t_offer('percent',20,p_name=>'Twenty');
set role authenticated;
select public.test_assert(public.t_quote(public.t_cart(25000,1))->'pricing'->'offer'->>'name'='Twenty' and (public.t_quote(public.t_cart(25000,1))->'pricing'->>'discount_paise')::integer=5000,'the largest discount wins (20% of 250 beats Rs 20)');
select public.test_assert(public.t_quote(public.t_cart(25000,1))=public.t_quote(public.t_cart(25000,1)),'selection is deterministic');
-- Only one offer ever applies: one discount, one snapshot.
select public.test_assert((public.t_quote(public.t_cart(25000,1))->'pricing'->>'total_paise')::integer=25000+5000-5000,'at most one order-level offer');

-- 6. Codes: case-insensitive, replace automatic offers, why not ---------------------------------------
reset role; select public.t_clear();
select public.t_offer('percent',10,p_name=>'Auto ten');
select public.t_offer('flat',1000,'code','welcome1',p_name=>'Code Rs 10');
select public.t_offer('percent',50,'code','HALF50',p_name=>'Half',p_per=>1);
select public.t_offer('flat',2000,'code','FIRST20',p_name=>'First only',p_first=>true);
select public.t_offer('flat',2000,'code','BIGCART',p_name=>'Big cart',p_min=>100000);
select public.t_offer('flat',1000,'code','PAUSED1',p_name=>'Paused');
update public.offers set paused=true where code='PAUSED1';
insert into public.offers(business_id,name,kind,value,apply_mode,code,starts_at) values ('10000000-0000-4000-8000-000000000001','Future','flat',1000,'code','FUTURE1',now()+interval '1 day');
insert into public.offers(business_id,name,kind,value,apply_mode,code,starts_at,ends_at) values ('10000000-0000-4000-8000-000000000001','Past','flat',1000,'code','PAST123',now()-interval '2 days',now()-interval '1 day');
set role authenticated; select public.t_login(3);
select public.test_assert((public.check_offer_code('ammu-sammu','  Welcome1 ')->>'applies')::boolean and public.check_offer_code('ammu-sammu','welcome1')->'offer'->>'name'='Code Rs 10'
  and not (public.check_offer_code('ammu-sammu','welcome1')->'offer' ? 'code'),'a code works in any case and returns the offer terms, not the code or limits');
select public.test_assert(public.check_offer_code('ammu-sammu','PAUSED1')->>'reason'='paused' and public.check_offer_code('ammu-sammu','FUTURE1')->>'reason'='not_started'
  and public.check_offer_code('ammu-sammu','PAST123')->>'reason'='ended' and public.check_offer_code('ammu-sammu','NOSUCH1')->>'reason'='not_found' and public.check_offer_code('ammu-sammu','x')->>'reason'='not_found','each failure says why');
select public.test_assert((public.check_offer_code('ammu-sammu','BIGCART')->>'applies')::boolean,'the cart minimum is checked at the quote, not when a code is checked');
-- A valid code replaces the automatic offer even when the automatic discount is larger.
select public.test_assert(public.t_quote(public.t_cart(30000,2),'welcome1')->'pricing'->'offer'->>'code'='WELCOME1' and (public.t_quote(public.t_cart(30000,2),'welcome1')->'pricing'->>'discount_paise')::integer=1000
  and public.t_quote(public.t_cart(30000,2))->'pricing'->'offer'->>'name'='Auto ten','a valid code replaces the automatic offer');
-- A code below its minimum is reported with the shortfall and the cart is priced as without the code.
select public.test_assert(public.t_quote(public.t_cart(30000,2),'bigcart')->'offer_error'->>'reason'='min_order' and (public.t_quote(public.t_cart(30000,2),'bigcart')->'offer_error'->>'shortfall_paise')::integer=40000,'a code below its minimum says how much more to add');
select public.test_assert(public.t_quote(public.t_cart(30000,2),'nosuch1')->'offer_error'->>'reason'='not_found' and public.t_quote(public.t_cart(30000,2),'nosuch1')->'pricing'->'offer'->>'name'='Auto ten','a wrong code is reported and the cart is priced without it');
-- First order only: the customer's first non-cancelled order with this restaurant.
select public.test_assert((public.check_offer_code('ammu-sammu','FIRST20')->>'applies')::boolean,'a customer with no orders is eligible for first order only');
select public.t_place(10,public.t_cart(25000,1),'first20');
select public.test_assert(public.check_offer_code('ammu-sammu','FIRST20')->>'reason'='first_order_only','a later order is not a first order');
-- Per-customer limit 1.
select public.t_login(4);
select public.test_assert((public.check_offer_code('ammu-sammu','HALF50')->>'applies')::boolean,'another customer can still use the code');
select public.t_place(11,public.t_cart(25000,1),'half50');
select public.test_assert(public.check_offer_code('ammu-sammu','HALF50')->>'reason'='per_customer_limit' and public.t_quote(public.t_cart(25000,1),'HALF50')->'offer_error'->>'reason'='per_customer_limit','a used per-customer code is refused with its reason');
select public.t_login(3);
select public.test_assert((public.check_offer_code('ammu-sammu','HALF50')->>'applies')::boolean,'the limit is per customer');

-- 7. Offers that change between quote and place ----------------------------------------------------------
reset role; select public.t_clear();
select public.t_offer('percent',20,p_name=>'Auto twenty');
select public.t_offer('flat',3000,'code','SHORT30',p_name=>'Short lived',p_total=>1);
set role authenticated; select public.t_login(1);
select set_config('t.cart',public.t_cart(30000,1)::text,false);
select set_config('t.quoted',(public.t_quote(current_setting('t.cart')::jsonb)->'pricing')::text,false);
reset role; update public.offers set paused=true where name='Auto twenty';
set role authenticated;
select set_config('t.changed',public.t_place(20,current_setting('t.cart')::jsonb,null,current_setting('t.quoted')::jsonb)::text,false);
select public.test_assert(current_setting('t.changed')::jsonb->>'outcome'='offer_changed' and current_setting('t.changed')::jsonb->>'reason'='paused'
  and not (current_setting('t.changed')::jsonb->'pricing' ? 'offer') and (current_setting('t.changed')::jsonb->'pricing'->>'total_paise')::integer=35000,'a quoted automatic offer that was paused is refused with a distinct outcome and the new total');
reset role;
select public.test_assert(not exists(select 1 from public.orders where idempotency_key='18200000-0000-4000-9000-000000000020'),'the refused order was not created');
set role authenticated;
select public.test_assert(public.t_place(20,current_setting('t.cart')::jsonb,null,current_setting('t.quoted')::jsonb)=current_setting('t.changed')::jsonb,'the refused key replays as the same offer_changed outcome');
select public.test_assert(public.place_order('ammu-sammu',current_setting('t.cart')::jsonb,public.test_delivery('T'),null,'18200000-0000-4000-9000-000000000021',(current_setting('t.changed')::jsonb->'pricing'))->>'outcome'='placed','accepting the new quote with a fresh key places the order');
-- A malformed offer id in the accepted pricing is client data: it is simply "changed", never a cast error.
select public.test_assert(public.t_place(25,current_setting('t.cart')::jsonb,null,jsonb_set(current_setting('t.quoted')::jsonb,'{offer,id}','"not-a-uuid"'))->>'reason'='changed','a malformed offer id in the accepted pricing is refused as changed');
select public.test_assert(public.t_place(26,current_setting('t.cart')::jsonb,null,jsonb_set(current_setting('t.quoted')::jsonb,'{offer,id}','12345'))->>'outcome'='offer_changed','a non-string offer id too');
reset role;
select public.test_assert((select count(*)=2 from public.checkout_pricing_rejections where idempotency_key in ('18200000-0000-4000-9000-000000000025','18200000-0000-4000-9000-000000000026') and offer_reason='changed'),'and the rejections are stored, so the keys are terminal');
set role authenticated; select public.t_login(1);
-- A code that is used up between quote and place.
select public.t_login(2);
select set_config('t.codeq',(public.t_quote(current_setting('t.cart')::jsonb,'short30')->'pricing')::text,false);
select public.test_assert(current_setting('t.codeq')::jsonb->'offer'->>'code'='SHORT30','the code quote carries the code in the snapshot');
select public.t_login(3);
select public.t_place(22,current_setting('t.cart')::jsonb,'short30');
select public.t_login(2);
select set_config('t.codechanged',public.t_place(23,current_setting('t.cart')::jsonb,'short30',current_setting('t.codeq')::jsonb)::text,false);
select public.test_assert(current_setting('t.codechanged')::jsonb->>'outcome'='offer_changed' and current_setting('t.codechanged')::jsonb->>'reason'='used_up','a quoted code that was used up is refused, never silently dropped');
select public.test_assert(public.t_place(23,current_setting('t.cart')::jsonb,'short30',current_setting('t.codeq')::jsonb)=current_setting('t.codechanged')::jsonb,'the code rejection replays identically');
select public.t_fails($q$select public.t_place(23,public.t_cart(30000,1),null,current_setting('t.codeq')::jsonb)$q$,'22023');
select public.t_fails($q$select public.t_place(23,public.t_cart(30000,1),'OTHER123',current_setting('t.codeq')::jsonb)$q$,'22023');
-- A wrong code at place time is also a refusal; the cart is priced without it.
select public.test_assert(public.t_place(24,public.t_cart(30000,1),'nosuch99',(public.t_quote(public.t_cart(30000,1))->'pricing'))->>'reason'='not_found','a wrong code at place time is refused with not_found');
reset role;
select public.test_assert((select count(*)=0 from public.orders where customer_id='18200000-0000-4000-8000-000000000002'),'no order was created for any refused attempt');

-- An unused offer deleted between quote and place: the reason is the generic 'changed', and the order is not created.
select public.t_clear();
select public.t_offer('percent',20,p_name=>'Vanishing');
set role authenticated; select public.t_login(1);
select set_config('t.vq',(public.t_quote(public.t_cart(30000,1))->'pricing')::text,false);
reset role; delete from public.offers;
set role authenticated;
select public.test_assert(public.t_place(70,public.t_cart(30000,1),null,current_setting('t.vq')::jsonb)->>'reason'='changed','a quoted offer that was deleted is reported as changed');
reset role;
select public.test_assert(not exists(select 1 from public.orders where idempotency_key='18200000-0000-4000-9000-000000000070'),'and no order is created');

-- 8. Replay is exact: stored order, discount included; the request hash covers the code ---------------------
select public.t_clear();
select public.t_offer('flat',1000,'code','REPLAY10',p_name=>'Replay',p_total=>1);
set role authenticated; select public.t_login(1);
select set_config('t.acc',(public.t_quote(public.t_cart(25000,1),'replay10')->'pricing')::text,false);
select set_config('t.first',public.t_place(30,public.t_cart(25000,1),'replay10',current_setting('t.acc')::jsonb)::text,false);
select public.test_assert(current_setting('t.first')::jsonb->>'outcome'='placed' and (current_setting('t.first')::jsonb->>'discount_paise')::integer=1000 and current_setting('t.first')::jsonb->'offer'->>'code'='REPLAY10','an order with a code is placed with its discount');
select public.test_assert(public.t_place(30,public.t_cart(25000,1),'replay10',current_setting('t.acc')::jsonb)=current_setting('t.first')::jsonb,'an immediate replay returns the same order JSON');
select public.test_assert(public.t_place(30,public.t_cart(25000,1),' ReplaY10 ',current_setting('t.acc')::jsonb)=current_setting('t.first')::jsonb,'the code is normalised, so a differently typed code is the same request');
select public.t_fails($q$select public.t_place(30,public.t_cart(25000,1),null,current_setting('t.acc')::jsonb)$q$,'22023');
select public.t_fails($q$select public.t_place(30,public.t_cart(25000,1),'OTHER123',current_setting('t.acc')::jsonb)$q$,'22023');
-- The offer is now used up and then paused: the replay still returns the stored order with its discount.
reset role; update public.offers set paused=true; set role authenticated;
select public.test_assert(public.t_place(30,public.t_cart(25000,1),'replay10',current_setting('t.acc')::jsonb)=current_setting('t.first')::jsonb,'a replay after the offer ended returns the stored order unchanged');
reset role;
select public.test_assert((select count(*)=1 from public.orders where idempotency_key='18200000-0000-4000-9000-000000000030') and (select count(*)=1 from public.offer_redemptions),'replays never create a second order or redemption');
-- Without an offer the replay is exactly what it always was, plus a zero discount.
select public.t_clear();
set role authenticated; select public.t_login(1);
select set_config('t.plain',public.t_place(31,public.t_cart(25000,1))::text,false);
select public.test_assert((current_setting('t.plain')::jsonb->>'discount_paise')::integer=0 and current_setting('t.plain')::jsonb->'offer'='null'::jsonb and public.t_place(31,public.t_cart(25000,1))=current_setting('t.plain')::jsonb,'no offer: zero discount, null offer and an exact replay');
-- The six-argument signature (clients built before offers) behaves exactly as before.
select public.test_assert(public.place_order('ammu-sammu',public.t_cart(25000,1),public.test_delivery('T'),null,'18200000-0000-4000-9000-000000000032',public.test_quote('ammu-sammu',public.t_cart(25000,1)))->>'outcome'='placed','the six-argument place_order still works');

-- 9. Cancelling an order gives its use back ---------------------------------------------------------------
reset role; select public.t_clear();
select public.t_offer('flat',1000,'code','ONEUSE1',p_name=>'One use',p_total=>1);
select public.t_offer('flat',1000,'code','FIRSTO1',p_name=>'First order',p_first=>true);
set role authenticated; select public.t_login(3);
select set_config('t.used',public.t_place(40,public.t_cart(25000,1),'oneuse1')::text,false);
select public.test_assert(public.check_offer_code('ammu-sammu','ONEUSE1')->>'reason'='used_up' and public.check_offer_code('ammu-sammu','FIRSTO1')->>'reason'='first_order_only','used up, and no longer a first order');
select public.t_login(4);
select public.test_assert(public.check_offer_code('ammu-sammu','ONEUSE1')->>'reason'='used_up','another customer sees it used up');
reset role;
select public.test_assert((select count(*)=1 from public.offer_redemptions),'one redemption before cancelling');
set role authenticated; select public.t_login(5);
select public.test_assert(public.transition_order((current_setting('t.used')::jsonb->>'id')::uuid,'cancelled',1)->>'status'='cancelled','the owner cancels the order');
select public.test_assert((select (v->0->>'uses')::integer=0 and (v->0->>'discount_given_paise')::integer=0 and (v->0->>'any_redemption')::boolean from (select public.offer_usage_stats('10000000-0000-4000-8000-000000000001') v) q), 'cancelled-only usage still locks terms');
select public.t_login(3);
select public.test_assert((public.check_offer_code('ammu-sammu','FIRSTO1')->>'applies')::boolean,'a cancelled order is not a first order');
select public.t_login(4);
select public.test_assert((public.check_offer_code('ammu-sammu','ONEUSE1')->>'applies')::boolean,'the total use is given back');
select public.test_assert(public.t_place(41,public.t_cart(25000,1),'oneuse1')->>'outcome'='placed','the freed use can be taken again');
select public.t_login(3);
select public.test_assert(public.check_offer_code('ammu-sammu','ONEUSE1')->>'reason'='used_up','and then it is used up again (the cancelled order does not count)');
reset role;
select public.test_assert((select count(*)=2 from public.offer_redemptions) and (select count(*)=1 from public.offer_redemptions r join public.orders o on o.id=r.order_id where o.status<>'cancelled'),'the cancelled order keeps its redemption row for history but no longer counts');

-- Aggregate runs under the caller's policies, including for cancelled-only usage.
set role authenticated; select public.t_login(5);
select public.test_assert((select jsonb_array_length(v)=1 and (v->0->>'uses')::integer=1
  and (v->0->>'discount_given_paise')::integer=1000 and (v->0->>'any_redemption')::boolean
  from (select public.offer_usage_stats('10000000-0000-4000-8000-000000000001') v) q), 'owner sees non-cancelled totals and the redemption lock');
select public.t_login(6);
select public.test_assert(public.offer_usage_stats('10000000-0000-4000-8000-000000000001')='[]'::jsonb, 'another restaurant owner cannot read aggregate usage');
select public.t_login(3);
select public.test_assert(public.offer_usage_stats('10000000-0000-4000-8000-000000000001')='[]'::jsonb, 'customer cannot read aggregate usage');
reset role;

-- 10. Rate limit on code lookups -----------------------------------------------------------------------------
select public.t_clear();
select public.t_offer('flat',1000,'code','GOODCODE',p_name=>'Good code');
set role authenticated; select public.t_login(3);
do $$ declare i integer; begin for i in 1..15 loop
  perform public.test_assert((public.check_offer_code('ammu-sammu','GOODCODE')->>'applies')::boolean,'valid checks never run out');
end loop; end $$;
select public.t_login(4);
do $$ declare i integer; begin for i in 1..10 loop
  perform public.test_assert(public.check_offer_code('ammu-sammu','GUESS'||lpad(i::text,3,'0'))->>'reason'='not_found','wrong guess '||i);
end loop; end $$;
select set_config('t.limited',public.check_offer_code('ammu-sammu','GOODCODE')::text,false);
select public.test_assert(not (current_setting('t.limited')::jsonb->>'applies')::boolean and current_setting('t.limited')::jsonb->>'reason'='rate_limited'
  and (current_setting('t.limited')::jsonb->>'retry_after_seconds')::integer between 1 and 600,'the 11th lookup in 10 minutes is refused, even for a valid code, with a wait');
select public.test_assert(public.t_quote(public.t_cart(25000,1),'GOODCODE')->'offer_error'->>'reason'='rate_limited' and not (public.t_quote(public.t_cart(25000,1),'GOODCODE')->'pricing' ? 'offer'),'the quote is rate limited too, so it cannot be used to guess codes');
select set_config('t.placelimited',public.t_place(50,public.t_cart(25000,1),'GOODCODE',(public.t_quote(public.t_cart(25000,1))->'pricing'))::text,false);
select public.test_assert(current_setting('t.placelimited')::jsonb->>'outcome'='offer_changed' and current_setting('t.placelimited')::jsonb->>'reason'='rate_limited'
  and (current_setting('t.placelimited')::jsonb->>'retry_after_seconds')::integer between 1 and 600,'and so is place_order, which also says how long to wait');
select public.test_assert(public.t_place(50,public.t_cart(25000,1),'GOODCODE',(public.t_quote(public.t_cart(25000,1))->'pricing'))=current_setting('t.placelimited')::jsonb,'the rate-limited rejection replays with the same wait and stays terminal for its key');
reset role;
select public.test_assert(not exists(select 1 from public.orders where idempotency_key='18200000-0000-4000-9000-000000000050') and (select offer_retry_after=(current_setting('t.placelimited')::jsonb->>'retry_after_seconds')::integer from public.checkout_pricing_rejections where idempotency_key='18200000-0000-4000-9000-000000000050'),'no order was created and the wait is stored with the rejection');
set role authenticated; select public.t_login(4);
select public.t_login(3);
select public.test_assert((public.check_offer_code('ammu-sammu','GOODCODE')->>'applies')::boolean,'the limit is per customer');
reset role;
select public.test_assert((select count(*)=10 from offers_private.code_attempts where customer_id='18200000-0000-4000-8000-000000000004'),'only rejected lookups are logged; limited ones are not, so they never extend the wait');
select public.test_assert((select count(*)=0 from offers_private.code_attempts where customer_id='18200000-0000-4000-8000-000000000003') and not exists(select 1 from information_schema.columns where table_schema='offers_private' and table_name='code_attempts' and column_name='outcome'),'accepted lookups are not logged at all');
update offers_private.code_attempts set created_at=created_at-interval '11 minutes' where customer_id='18200000-0000-4000-8000-000000000004';
set role authenticated; select public.t_login(4);
select public.test_assert((public.check_offer_code('ammu-sammu','GOODCODE')->>'applies')::boolean,'the window slides: after 10 minutes the customer can try again');
reset role;
-- Old attempts are pruned by the next lookup.
update offers_private.code_attempts set created_at=created_at-interval '2 hours' where customer_id='18200000-0000-4000-8000-000000000004';
set role authenticated;
select public.check_offer_code('ammu-sammu','GOODCODE');
reset role;
select public.test_assert((select count(*)=0 from offers_private.code_attempts where customer_id='18200000-0000-4000-8000-000000000004'),'attempts older than an hour are pruned by the next lookup');

-- 11. Daily window in Asia/Kolkata -------------------------------------------------------------------------------
select public.t_clear();
select public.test_assert(offers_private.window_open(jsonb_populate_record(null::public.offers,'{"window_from":"15:00","window_to":"18:00","window_days":[1,2,3,4,5,6,7]}'),t),'window '||t)
  from unnest(array['2026-11-20 15:00:00+05:30','2026-11-20 17:59:59+05:30','2026-11-20 12:29:00+00','2026-11-20 10:00:00+00']::timestamptz[]) t;
select public.test_assert(not offers_private.window_open(jsonb_populate_record(null::public.offers,'{"window_from":"15:00","window_to":"18:00","window_days":[1,2,3,4,5,6,7]}'),t),'outside window '||t)
  from unnest(array['2026-11-20 14:59:59+05:30','2026-11-20 18:00:00+05:30','2026-11-20 18:01:00+05:30','2026-11-20 16:00:00+00','2026-11-20 15:30:00+00']::timestamptz[]) t;
-- 2026-11-20 is a Friday (5), the 21st a Saturday (6).
select public.test_assert(not offers_private.window_open(jsonb_populate_record(null::public.offers,'{"window_from":"15:00","window_to":"18:00","window_days":[6,7]}'),'2026-11-20 16:00:00+05:30')
  and offers_private.window_open(jsonb_populate_record(null::public.offers,'{"window_from":"15:00","window_to":"18:00","window_days":[6,7]}'),'2026-11-21 16:00:00+05:30'),'weekday selection');
select public.test_assert(offers_private.window_open(jsonb_populate_record(null::public.offers,'{"window_from":"22:00","window_to":"02:00","window_days":[5]}'),t),'overnight '||t)
  from unnest(array['2026-11-20 23:00:00+05:30','2026-11-21 01:59:00+05:30']::timestamptz[]) t;
select public.test_assert(not offers_private.window_open(jsonb_populate_record(null::public.offers,'{"window_from":"22:00","window_to":"02:00","window_days":[5]}'),t),'not overnight '||t)
  from unnest(array['2026-11-21 02:00:00+05:30','2026-11-21 23:00:00+05:30','2026-11-20 01:00:00+05:30','2026-11-20 21:59:00+05:30']::timestamptz[]) t;
select public.test_assert(offers_private.window_open(jsonb_populate_record(null::public.offers,'{}'),now()),'no window is always open');
-- Live: an offer whose window contains the current Asia/Kolkata time, and one that does not.
select public.t_offer('flat',1000,'code','INWIN123',p_name=>'In window');
select public.t_offer('flat',1000,'code','OUTWIN12',p_name=>'Out of window');
update public.offers set window_from=(now() at time zone 'Asia/Kolkata')::time-interval '1 hour', window_to=(now() at time zone 'Asia/Kolkata')::time+interval '1 hour', window_days=array[1,2,3,4,5,6,7]::smallint[] where code='INWIN123';
update public.offers set window_from=(now() at time zone 'Asia/Kolkata')::time+interval '2 hours', window_to=(now() at time zone 'Asia/Kolkata')::time+interval '3 hours', window_days=array[1,2,3,4,5,6,7]::smallint[] where code='OUTWIN12';
set role authenticated; select public.t_login(3);
select public.test_assert((public.check_offer_code('ammu-sammu','INWIN123')->>'applies')::boolean and public.check_offer_code('ammu-sammu','OUTWIN12')->>'reason'='outside_window','the window is applied to the current Asia/Kolkata time');

-- 12. Public listing and RLS --------------------------------------------------------------------------------------------
reset role; select public.t_clear();
select public.t_offer('percent',10,p_name=>'Active auto');
select public.t_offer('percent',15,p_name=>'Paused auto'); update public.offers set paused=true where name='Paused auto';
insert into public.offers(business_id,name,kind,value,apply_mode,starts_at) values ('10000000-0000-4000-8000-000000000001','Future auto','percent',10,'automatic',now()+interval '1 day');
insert into public.offers(business_id,name,kind,value,apply_mode,starts_at,ends_at) values ('10000000-0000-4000-8000-000000000001','Ended auto','percent',10,'automatic',now()-interval '2 days',now()-interval '1 day');
select public.t_offer('flat',1000,'automatic',p_name=>'Used up auto',p_total=>1);
select public.t_offer('flat',1000,'automatic',p_name=>'Window shut auto');
update public.offers set window_from=(now() at time zone 'Asia/Kolkata')::time+interval '2 hours', window_to=(now() at time zone 'Asia/Kolkata')::time+interval '3 hours', window_days=array[1,2,3,4,5,6,7]::smallint[] where name='Window shut auto';
select public.t_offer('flat',1000,'automatic',p_name=>'Window open auto',p_max=>null,p_first=>true,p_per=>2,p_total=>50,p_min=>10000);
update public.offers set window_from=(now() at time zone 'Asia/Kolkata')::time-interval '1 hour', window_to=(now() at time zone 'Asia/Kolkata')::time+interval '1 hour', window_days=array[1,2,3,4,5,6,7]::smallint[] where name='Window open auto';
select public.t_offer('flat',1000,'code','SECRET11',p_name=>'Secret code');
select public.t_offer('percent',10,p_name=>'Other restaurant auto',p_biz=>'kokani-dine-inn');
-- Use up 'Used up auto' with a real order: it needs to be the one picked, so pause the others briefly.
update public.offers set paused=true where name in ('Active auto','Window open auto');
set role authenticated; select public.t_login(1);
select public.t_place(60,public.t_cart(25000,1));
reset role; update public.offers set paused=false where name in ('Active auto','Window open auto');
select set_config('t.owner_offers',(select count(*) from public.offers where business_id='10000000-0000-4000-8000-000000000001')::text,false);
set role anon;
select set_config('t.public',public.list_active_offers('ammu-sammu')::text,false);
select public.test_assert((select jsonb_agg(e->>'name' order by e->>'name') from jsonb_array_elements(current_setting('t.public')::jsonb) e)='["Active auto", "Window open auto"]'::jsonb,'signed-out visitors see exactly the active automatic offers');
select public.test_assert((select bool_and((select array_agg(k order by k) from jsonb_object_keys(e) k)=array['ends_at','first_order_only','id','kind','max_discount_paise','min_order_paise','name','value','window']) from jsonb_array_elements(current_setting('t.public')::jsonb) e)
  and current_setting('t.public') !~* 'SECRET11|code|limit|paused','the listing exposes no code, limit or status');
select public.test_assert(public.list_active_offers('kokani-dine-inn')->0->>'name'='Other restaurant auto' and jsonb_array_length(public.list_active_offers('kokani-dine-inn'))=1,'each restaurant lists its own');
select public.t_fails($q$select public.list_active_offers('nosuch')$q$,'22023');
select public.t_fails($q$select * from public.offers$q$,'42501');
select public.t_fails($q$select * from public.offer_redemptions$q$,'42501');
select public.t_fails($q$select public.check_offer_code('ammu-sammu','SECRET11')$q$,'42501');
select public.t_fails($q$select public.quote_order('ammu-sammu','[]',null)$q$,'42501');
select public.t_fails($q$select public.place_order('ammu-sammu','[]','{}',null,gen_random_uuid(),'{}','X')$q$,'42501');
select public.t_fails($q$select * from offers_private.code_attempts$q$,'42501');
-- Signed-in customers: no table access either.
set role authenticated; select public.t_login(1);
select public.test_assert((select count(*)=0 from public.offers) and (select count(*)=0 from public.offer_redemptions),'a customer sees no offer rows and no redemptions, not even their own');
select public.t_fails($q$insert into public.offers(business_id,name,kind,value,apply_mode) values ('10000000-0000-4000-8000-000000000001','Mine','percent',10,'automatic')$q$,'42501');
select public.test_assert(public.t_rows('update public.offers set paused=true')=0,'a customer cannot change offers');
select public.t_fails($q$delete from public.offers$q$,'42501');
select public.t_fails($q$select * from offers_private.code_attempts$q$,'42501');
select public.t_fails($q$select offers_private.resolve('10000000-0000-4000-8000-000000000001',auth.uid(),'SECRET11',1,1,null)$q$,'42501');
-- The owner of Ammu Sammu manages exactly that restaurant's offers.
select public.t_login(5);
select public.test_assert((select count(*)=current_setting('t.owner_offers')::integer and bool_and(business_id='10000000-0000-4000-8000-000000000001') from public.offers) and exists(select 1 from public.offers where code='SECRET11'),'the owner reads their own offers, codes included, and no one else''s');
select public.test_assert((select count(*)=1 from public.offer_redemptions where business_id='10000000-0000-4000-8000-000000000001'),'the owner reads their own restaurant''s redemptions');
select public.t_fails($q$insert into public.offers(business_id,name,kind,value,apply_mode) values ('10000000-0000-4000-8000-000000000002','Wrong restaurant','percent',10,'automatic')$q$,'42501');
select public.t_fails($q$insert into public.offers(business_id,name,kind,value,apply_mode,version) values ('10000000-0000-4000-8000-000000000001','Forced version','percent',10,'automatic',9)$q$,'42501');
select public.t_fails($q$update public.offers set business_id='10000000-0000-4000-8000-000000000002' where name='Active auto'$q$,'42501');
select public.t_fails($q$update public.offers set version=9 where name='Active auto'$q$,'42501');
select public.test_assert(public.t_rows($q$insert into public.offers(business_id,name,kind,value,apply_mode,code) values ('10000000-0000-4000-8000-000000000001','Owner made','flat',500,'code','owner55')$q$)=1,'the owner creates an offer');
select public.test_assert((select code='OWNER55' and version=1 from public.offers where name='Owner made'),'its code is stored upper case at version 1');
select public.test_assert(public.t_rows($q$update public.offers set name='Owner edited' where name='Owner made'$q$)=1,'and edits it');
select public.test_assert((select version=2 from public.offers where name='Owner edited'),'the version bumps');
-- Offers are never deleted by clients: no DELETE grant, even for the owner and even for an unused offer.
select public.t_fails($q$delete from public.offers where name='Owner edited'$q$,'42501');
select public.t_fails($q$delete from public.offers where name='Used up auto'$q$,'42501');
select public.test_assert(not has_table_privilege('authenticated','public.offers','delete') and not has_table_privilege('anon','public.offers','delete')
  and not exists(select 1 from pg_policies where schemaname='public' and tablename='offers' and cmd in ('DELETE','ALL')) and not exists(select 1 from pg_trigger where tgrelid='public.offers'::regclass and not tgisinternal and tgtype & 8 <> 0),'no delete grant, policy or trigger on offers');
select public.test_assert((select count(*)=1 from public.offers where name='Owner edited'),'the owner offer is still there after the refused deletes');
select public.t_login(6);
select public.test_assert((select count(*)=1 and min(name)='Other restaurant auto' from public.offers) and (select count(*)=0 from public.offer_redemptions),'the other restaurant''s owner sees only their own offers and no redemptions of Ammu Sammu');
select public.test_assert(public.t_rows($q$update public.offers set paused=true where business_id='10000000-0000-4000-8000-000000000001'$q$)=0,'and cannot change Ammu Sammu offers');
reset role; select public.t_clear();
rollback;
