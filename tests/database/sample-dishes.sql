\set ON_ERROR_STOP on
-- Sample dishes (#243). menu_items.is_demo marks a dish as sample data. The app never offers one, but the server must
-- refuse it too: quote_order and place_order both fail with the 'item unavailable' error (22023) used for unavailable
-- dishes, a cart with one sample line is refused whole, a refusal changes nothing, real dishes still work, and a
-- replay of an order placed earlier still returns it. Self-contained; rolls back.
begin;
insert into auth.users(id) select ('24300000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,2) n;
insert into auth.sessions(id,user_id) select ('24300000-0000-4000-b000-'||lpad(n::text,12,'0'))::uuid, ('24300000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,2) n;
insert into public.customer_addresses(customer_id,label,house,street_area,latitude,longitude,location_source)
 select ('24300000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'home','Sample house','Sample road',0.5,0.5,'pin' from generate_series(1,2) n;
do $$ declare ns text; begin
  select n.nspname into strict ns from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='postgis';
  execute format('update public.businesses set is_demo=false,service_area=%I.st_geomfromtext(''MULTIPOLYGON(((0 0,1 0,1 1,0 1,0 0)))'',4326),service_area_source=''sample test'',service_area_version=''test'',service_area_verified_at=now(),ordering_enabled=true,accepting_orders=true,delivery_fee_paise=0,min_order_paise=0 where slug=''ammu-sammu''',ns);
end $$;
insert into public.menu_categories(id,business_id,name,sort_order) values ('24300000-0000-4000-8000-0000000000c1','10000000-0000-4000-8000-000000000001','Sample mains',90);
-- d1, d2 real; d3 sample and available (the case under test); d4 sample and unavailable; d5 real, becomes a sample later.
insert into public.menu_items(id,business_id,name,category_id,price_paise,diet,sort_order,available,is_demo) values
 ('24300000-0000-4000-8000-0000000000d1','10000000-0000-4000-8000-000000000001','Real one','24300000-0000-4000-8000-0000000000c1',20000,'veg',0,true,false),
 ('24300000-0000-4000-8000-0000000000d2','10000000-0000-4000-8000-000000000001','Real two','24300000-0000-4000-8000-0000000000c1',10000,'veg',1,true,false),
 ('24300000-0000-4000-8000-0000000000d3','10000000-0000-4000-8000-000000000001','Sample dish','24300000-0000-4000-8000-0000000000c1',15000,'veg',2,true,true),
 ('24300000-0000-4000-8000-0000000000d4','10000000-0000-4000-8000-000000000001','Sample hidden','24300000-0000-4000-8000-0000000000c1',15000,'veg',3,false,true),
 ('24300000-0000-4000-8000-0000000000d5','10000000-0000-4000-8000-000000000001','Later sample','24300000-0000-4000-8000-0000000000c1',12000,'veg',4,true,false);
-- An automatic offer, so a successful checkout records a redemption that a refused one must not.
insert into public.offers(business_id,name,kind,value,apply_mode) values ('10000000-0000-4000-8000-000000000001','Sample offer','percent',10,'automatic');

create function public.s_as(n integer) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', ('24300000-0000-4000-8000-'||lpad(n::text,12,'0')), false);
  perform set_config('request.jwt.claims', jsonb_build_object('sub',('24300000-0000-4000-8000-'||lpad(n::text,12,'0')),'session_id',('24300000-0000-4000-b000-'||lpad(n::text,12,'0')))::text, false);
end $$;
-- Everything a refused call must leave alone, read with definer rights so RLS hides nothing.
create function public.s_state() returns jsonb language sql security definer set search_path = '' as $$
  select jsonb_build_object(
    'orders', (select count(*) from public.orders where customer_id in (select ('24300000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,2) n)),
    'order_items', (select count(*) from public.order_items),
    'history', (select count(*) from public.order_status_history),
    'redemptions', (select count(*) from public.offer_redemptions),
    'rejections', (select count(*) from public.checkout_pricing_rejections),
    'relationships', (select count(*) from public.customer_businesses),
    'outbox', (select count(*) from public.notification_outbox),
    'notifications', (select count(*) from public.customer_notifications)) $$;
create function public.s_cart(ids text[]) returns jsonb language sql stable as $$
  select jsonb_agg(jsonb_build_object('menu_item_id',('24300000-0000-4000-8000-0000000000'||i)::uuid,'quantity',1) order by ord) from unnest(ids) with ordinality t(i,ord) $$;
-- Place the cart as the current customer. s_place sends the unfiltered test quote, so a refusal is the server's own
-- (the quote_order step cannot refuse first); s_place_ok sends the server's live quote, as the app does.
create function public.s_place(key integer, cart jsonb) returns jsonb language sql as $$
  select public.place_order('ammu-sammu',cart,public.test_delivery('Sample'),null,('24300000-0000-4000-9000-'||lpad(key::text,12,'0'))::uuid,public.test_quote('ammu-sammu',cart)) $$;
create function public.s_place_ok(key integer, cart jsonb) returns jsonb language sql as $$
  select public.place_order('ammu-sammu',cart,public.test_delivery('Sample'),null,('24300000-0000-4000-9000-'||lpad(key::text,12,'0'))::uuid,public.quote_order('ammu-sammu',cart,null)->'pricing') $$;
-- Require the expected 22023 refusal and verify the checkout state is unchanged.
create function public.s_refused(stmt text, expected_message text default 'item unavailable', expected_detail text default '') returns void language plpgsql as $$
declare before_state jsonb := public.s_state(); actual_detail text;
begin
  begin execute stmt;
  exception when others then
    get stacked diagnostics actual_detail = pg_exception_detail;
    if sqlstate = '22023' and sqlerrm = expected_message and actual_detail = expected_detail then
      perform public.test_assert(public.s_state() = before_state, 'a refused call leaves the database unchanged: ' || stmt);
      return;
    end if;
    raise exception 'wrong error for [%]: % %', stmt, sqlstate, sqlerrm;
  end;
  raise exception 'statement unexpectedly succeeded: [%]', stmt;
end $$;

set local role authenticated;
select public.s_as(1);

-- 1. Real dishes still quote and order. ----------------------------------------------------------------------------
select public.test_assert((public.quote_order('ammu-sammu',public.s_cart(array['d1','d2']),null)->>'outcome')='quoted', 'a real cart still quotes');
select set_config('test.q1',public.quote_order('ammu-sammu',public.s_cart(array['d1','d2']),null)->>'pricing',false);
select public.test_assert((public.s_place_ok(1,public.s_cart(array['d1','d2']))->>'outcome')='placed', 'a real cart is still placed');
select public.test_assert((select count(*)=1 from public.orders where idempotency_key='24300000-0000-4000-9000-000000000001'), 'the real order exists');

-- The seeded Demo meal is also refused at a real restaurant.
select public.s_refused($q$select public.quote_order('ammu-sammu','[{"menu_item_id":"20000000-0000-4000-8000-000000000001","quantity":1}]',null)$q$);
select public.s_refused($q$select public.s_place(8,'[{"menu_item_id":"20000000-0000-4000-8000-000000000001","quantity":1}]')$q$);

-- 2. An available sample dish is refused by both functions, with the unavailable-dish error. -----------------------
select public.s_refused(format('select public.quote_order(%L,%L::jsonb,null)','ammu-sammu',public.s_cart(array['d3'])));
select public.s_refused(format('select public.s_place(2,%L::jsonb)',public.s_cart(array['d3'])));
-- Same error for a sample dish that is also unavailable, and the code path through p_accepted_pricing '{}' does not matter.
select public.s_refused(format('select public.quote_order(%L,%L::jsonb,null)','ammu-sammu',public.s_cart(array['d4'])));
select public.s_refused(format('select public.place_order(%L,%L::jsonb,public.test_delivery(''Sample''),null,%L::uuid,''{}''::jsonb)','ammu-sammu',public.s_cart(array['d3']),'24300000-0000-4000-9000-000000000003'));
-- Order placed with the real quote of the real lines but with the sample line added is refused too (the quote the client
-- would hold cannot include the sample line, and the server still refuses).
select public.s_refused(format('select public.place_order(%L,%L::jsonb,public.test_delivery(''Sample''),null,%L::uuid,public.test_quote(%L,%L::jsonb))','ammu-sammu',public.s_cart(array['d1','d3']),'24300000-0000-4000-9000-000000000004','ammu-sammu',public.s_cart(array['d1'])));

-- 3. A mixed cart is refused entirely, in either position, by both functions; no partial order. -------------------
select public.s_refused(format('select public.quote_order(%L,%L::jsonb,null)','ammu-sammu',public.s_cart(array['d1','d3'])));
select public.s_refused(format('select public.quote_order(%L,%L::jsonb,null)','ammu-sammu',public.s_cart(array['d3','d1'])));
select public.s_refused(format('select public.s_place(5,%L::jsonb)',public.s_cart(array['d1','d3'])));
select public.s_refused(format('select public.s_place(6,%L::jsonb)',public.s_cart(array['d3','d1','d2'])));
select public.test_assert((select count(*)=1 from public.orders where customer_id='24300000-0000-4000-8000-000000000001'), 'only the real order exists after every refusal');
select public.test_assert((select count(*)=0 from public.order_items i join public.orders o on o.id=i.order_id where i.menu_item_id='24300000-0000-4000-8000-0000000000d3'), 'no order line for the sample dish');

-- 4. A dish that becomes a sample later is refused; an order placed before is replayed (replay comes first). ---------
reset role;
update public.menu_items set is_demo=true where id='24300000-0000-4000-8000-0000000000d5';
set local role authenticated;
select public.s_as(1);
select public.s_refused(format('select public.quote_order(%L,%L::jsonb,null)','ammu-sammu',public.s_cart(array['d5'])));
select set_config('test.before_replay',public.s_state()::text,true);
-- Order 1 held d1 and d2 (real). Turn both into sample dishes: the retry of that exact request still returns the order.
reset role;
update public.menu_items set is_demo=true where id in ('24300000-0000-4000-8000-0000000000d1','24300000-0000-4000-8000-0000000000d2');
set local role authenticated;
select public.s_as(1);
select public.test_assert((public.place_order('ammu-sammu',public.s_cart(array['d1','d2']),public.test_delivery('Sample'),null,'24300000-0000-4000-9000-000000000001',current_setting('test.q1')::jsonb)->>'id')::uuid = (select id from public.orders where idempotency_key='24300000-0000-4000-9000-000000000001'), 'the retry of an order placed before the dishes were samples still returns it');
select public.test_assert(public.s_state() = current_setting('test.before_replay')::jsonb, 'the replay created nothing');
-- A new order for the same dishes is now refused.
select public.s_refused(format('select public.s_place(7,%L::jsonb)',public.s_cart(array['d1','d2'])));
-- #245: Only the restaurant's demo flag changes. Its real dishes, open state and delivery area still qualify.
reset role;
update public.menu_items set is_demo=false where id in ('24300000-0000-4000-8000-0000000000d1','24300000-0000-4000-8000-0000000000d2');
update public.businesses set is_demo=true where slug='ammu-sammu';
set local role authenticated;
select public.s_as(1);
select public.s_refused($q$select public.quote_order('ammu-sammu',public.s_cart(array['d1','d2']),null)$q$,
  'demo restaurant cannot take orders', 'DEMO_RESTAURANT');
select public.s_refused($q$select public.place_order('ammu-sammu',public.s_cart(array['d1','d2']),public.test_delivery('Sample'),null,
  '24300000-0000-4000-9000-000000000009',current_setting('test.q1')::jsonb)$q$, 'demo restaurant cannot take orders', 'DEMO_RESTAURANT');
select public.test_assert((public.place_order('ammu-sammu',public.s_cart(array['d1','d2']),public.test_delivery('Sample'),null,
  '24300000-0000-4000-9000-000000000001',current_setting('test.q1')::jsonb)->>'id')::uuid =
  (select id from public.orders where idempotency_key='24300000-0000-4000-9000-000000000001'), 'an order is still replayable after the restaurant becomes demo');
select public.test_assert(public.s_state() = current_setting('test.before_replay')::jsonb, 'refusal and replay change no checkout state');

reset role;
update public.businesses set is_demo=false where slug='ammu-sammu';
set local role authenticated;
select public.s_as(2);
select public.test_assert(public.quote_order('ammu-sammu',public.s_cart(array['d1','d2']),null)->>'outcome'='quoted', 'the real restaurant quotes again');
select public.test_assert(public.s_place_ok(9,public.s_cart(array['d1','d2']))->>'outcome'='placed', 'the real restaurant accepts a new order');
reset role;
rollback;
