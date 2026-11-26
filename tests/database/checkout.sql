\set ON_ERROR_STOP on
-- Checkout through the saved-address path (customer_addresses row + address_id/address_version),
-- with the accepted-pricing quote place_order requires. isolation.sql leaves the fictional 0..1 square
-- verified for Ammu Sammu; customer A's saved pin (final-fixture.sql) lies inside it.
update public.businesses set delivery_fee_paise=500,min_order_paise=10000,accepting_orders=true where slug='ammu-sammu';
select public.test_assert(not has_function_privilege('anon','public.place_order(text,jsonb,jsonb,jsonb,uuid,jsonb)','execute') and not has_function_privilege('anon','public.transition_order(uuid,text,integer)','execute'), 'RPCs unavailable to anon despite default grants');
-- Generate a full-size catalog to exercise line-count and quantity boundaries.
insert into public.menu_items (id,business_id,name,category_id,price_paise)
select md5('boundary-item-' || n)::uuid,'10000000-0000-4000-8000-000000000001','Boundary ' || n,public.test_category('10000000-0000-4000-8000-000000000001','Boundary'),1000 from generate_series(1,21) n;
set role authenticated;
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000001',false);
select set_config('test.fix',jsonb_build_object('latitude',0.5,'longitude',0.5,'accuracy',10,'captured_at',clock_timestamp())::text,false);
select set_config('test.items','[{"menu_item_id":"20000000-0000-4000-8000-000000000001","quantity":2}]',false);
select set_config('test.delivery',public.test_delivery()::text,false);
select public.test_assert(current_setting('test.delivery')::jsonb ?& array['address_id','address_version'] and not current_setting('test.delivery')::jsonb ? 'address_line', 'checkout uses the saved-address contract');
select set_config('test.twenty',(select jsonb_agg(jsonb_build_object('menu_item_id',id,'quantity',1))::text from (select i.id from public.menu_items i join public.menu_categories c on c.id=i.category_id where c.name='Boundary' and c.business_id='10000000-0000-4000-8000-000000000001' order by i.id limit 20) x),false);
select set_config('test.twenty_one',(select jsonb_agg(jsonb_build_object('menu_item_id',id,'quantity',1))::text from (select i.id from public.menu_items i join public.menu_categories c on c.id=i.category_id where c.name='Boundary' and c.business_id='10000000-0000-4000-8000-000000000001' order by i.id limit 21) x),false);
select public.test_assert((public.place_order('ammu-sammu',current_setting('test.twenty')::jsonb,current_setting('test.delivery')::jsonb,current_setting('test.fix')::jsonb,'60000000-0000-4000-8000-000000000010',public.test_quote('ammu-sammu',current_setting('test.twenty')::jsonb))->>'subtotal_paise')::integer=20000,'20 lines accepted');
select public.test_assert((public.place_order('ammu-sammu','[{"menu_item_id":"20000000-0000-4000-8000-000000000001","quantity":10}]',current_setting('test.delivery')::jsonb,null,'60000000-0000-4000-8000-000000000011',public.test_quote('ammu-sammu','[{"menu_item_id":"20000000-0000-4000-8000-000000000001","quantity":10}]'))->>'subtotal_paise')::integer=150000,'quantity 10 accepted without a phone fix');
do $$ begin
  begin perform public.place_order('ammu-sammu',current_setting('test.twenty_one')::jsonb,current_setting('test.delivery')::jsonb,current_setting('test.fix')::jsonb,'60000000-0000-4000-8000-000000000012','{}'); raise exception '21 lines accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.place_order('ammu-sammu','[{"menu_item_id":"20000000-0000-4000-8000-000000000001","quantity":11}]',current_setting('test.delivery')::jsonb,current_setting('test.fix')::jsonb,'60000000-0000-4000-8000-000000000013','{}'); raise exception 'quantity 11 accepted'; exception when invalid_parameter_value then null; end;
end $$;
select set_config('test.result',public.place_order('ammu-sammu',current_setting('test.items')::jsonb,current_setting('test.delivery')::jsonb,current_setting('test.fix')::jsonb,'60000000-0000-4000-8000-000000000001',public.test_quote('ammu-sammu',current_setting('test.items')::jsonb))::text,false);
select set_config('test.order_id',current_setting('test.result')::jsonb->>'id',false);
select public.test_assert((current_setting('test.result')::jsonb->>'outcome')='placed' and (current_setting('test.result')::jsonb->>'total_paise')::integer=30500 and (current_setting('test.result')::jsonb->>'version')::integer=1,'server price and fee');
select public.test_assert((select count(*)=1 and min(unit_price_paise)=15000 and min(quantity)=2 from public.order_items where order_id=current_setting('test.order_id')::uuid),'item snapshot');
select public.test_assert((select count(*)=1 from public.order_status_history where order_id=current_setting('test.order_id')::uuid and status='placed'),'initial history');
select public.test_assert((select saved_address_id='74000000-0000-4000-8000-000000000001' and saved_address_version=1 and address_house='Fixture house A' and address_street_area='Fixture Road' and placed_from_distance_m=0 from public.orders where id=current_setting('test.order_id')::uuid),'order keeps the saved-address snapshot and phone distance');
select public.test_assert(public.place_order('ammu-sammu',current_setting('test.items')::jsonb,current_setting('test.delivery')::jsonb,current_setting('test.fix')::jsonb,'60000000-0000-4000-8000-000000000001',public.test_quote('ammu-sammu',current_setting('test.items')::jsonb))->>'id'=current_setting('test.order_id'),'retry returns same order');
do $$ begin
  begin perform public.place_order('ammu-sammu',current_setting('test.items')::jsonb,public.test_delivery('Changed'),current_setting('test.fix')::jsonb,'60000000-0000-4000-8000-000000000001',public.test_quote('ammu-sammu',current_setting('test.items')::jsonb)); raise exception 'idempotency mismatch accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.place_order('ammu-sammu','[{"menu_item_id":"20000000-0000-4000-8000-000000000002","quantity":1}]',current_setting('test.delivery')::jsonb,current_setting('test.fix')::jsonb,'60000000-0000-4000-8000-000000000002','{}'); raise exception 'cross tenant item accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.place_order('ammu-sammu','[{"menu_item_id":"20000000-0000-4000-8000-000000000001","quantity":0}]',current_setting('test.delivery')::jsonb,current_setting('test.fix')::jsonb,'60000000-0000-4000-8000-000000000003','{}'); raise exception 'zero quantity accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.place_order('ammu-sammu','[{"menu_item_id":"20000000-0000-4000-8000-000000000001","quantity":1},{"menu_item_id":"20000000-0000-4000-8000-000000000001","quantity":1}]',current_setting('test.delivery')::jsonb,current_setting('test.fix')::jsonb,'60000000-0000-4000-8000-000000000004','{}'); raise exception 'duplicate item accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.transition_order(current_setting('test.order_id')::uuid,'accepted',1); raise exception 'customer transition accepted'; exception when insufficient_privilege then null; end;
end $$;
-- The same client key belongs to each account separately, including after a committed-looking retry.
begin;
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000002',false);
select set_config('test.b_delivery',public.test_delivery('Customer B')::text,false);
select set_config('test.b_order',public.place_order('ammu-sammu',current_setting('test.items')::jsonb,current_setting('test.b_delivery')::jsonb,current_setting('test.fix')::jsonb,'60000000-0000-4000-8000-000000000001',public.test_quote('ammu-sammu',current_setting('test.items')::jsonb))->>'id',false);
select public.test_assert(current_setting('test.b_order') <> current_setting('test.order_id'),'same key creates a separate order for customer B');
select public.test_assert(public.place_order('ammu-sammu',current_setting('test.items')::jsonb,current_setting('test.b_delivery')::jsonb,current_setting('test.fix')::jsonb,'60000000-0000-4000-8000-000000000001',public.test_quote('ammu-sammu',current_setting('test.items')::jsonb))->>'id'=current_setting('test.b_order'),'customer B retry returns B order');
reset role;
select public.test_assert((select count(*)=2 and count(distinct customer_id)=2 from public.orders where business_id='10000000-0000-4000-8000-000000000001' and idempotency_key='60000000-0000-4000-8000-000000000001'),'same key remains isolated per account');
rollback;
reset role;
update public.menu_items set available=false, price_paise=20000 where id='20000000-0000-4000-8000-000000000001';
set role authenticated;
select public.test_assert((select unit_price_paise=15000 from public.order_items where order_id=current_setting('test.order_id')::uuid), 'snapshot survives menu changes');
do $$ begin
  begin perform public.place_order('ammu-sammu',current_setting('test.items')::jsonb,current_setting('test.delivery')::jsonb,current_setting('test.fix')::jsonb,'60000000-0000-4000-8000-000000000005','{}'); raise exception 'unavailable item accepted'; exception when invalid_parameter_value then null; end;
end $$;
reset role;
update public.menu_items set available=true, price_paise=15000 where id='20000000-0000-4000-8000-000000000001';
set role authenticated;
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000004',false);
do $$ begin
  begin perform public.transition_order(current_setting('test.order_id')::uuid,'accepted',1); raise exception 'cross tenant transition accepted'; exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000003',false);
select public.test_assert((public.transition_order(current_setting('test.order_id')::uuid,'accepted',1)->>'version')::integer=2,'admin accepts order');
do $$ begin
  begin perform public.transition_order(current_setting('test.order_id')::uuid,'preparing',1); raise exception 'stale transition accepted'; exception when serialization_failure then null; end;
  begin perform public.transition_order(current_setting('test.order_id')::uuid,'delivered',2); raise exception 'invalid transition accepted'; exception when invalid_parameter_value then null; end;
end $$;
select public.test_assert((public.transition_order(current_setting('test.order_id')::uuid,'preparing',2)->>'version')::integer=3,'preparing transition');
select public.test_assert((public.transition_order(current_setting('test.order_id')::uuid,'out_for_delivery',3)->>'version')::integer=4,'delivery transition');
select public.test_assert((public.transition_order(current_setting('test.order_id')::uuid,'delivered',4)->>'version')::integer=5,'delivered transition');
do $$ begin
  begin perform public.transition_order(current_setting('test.order_id')::uuid,'cancelled',5); raise exception 'terminal transition accepted'; exception when invalid_parameter_value then null; end;
end $$;
select public.test_assert((select count(*)=5 from public.order_status_history where order_id=current_setting('test.order_id')::uuid),'history tracks all states exactly once');
reset role;
select public.test_assert((select count(*)=1 from public.orders where customer_id='30000000-0000-4000-8000-000000000001' and idempotency_key='60000000-0000-4000-8000-000000000001'),'one order per idempotency key');
-- Leave the restaurant closed again, as accepting-orders.sql expects to start.
update public.businesses set accepting_orders=false where slug='ammu-sammu';
