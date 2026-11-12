\set ON_ERROR_STOP on
-- Existing isolation fixture leaves a deliberately fictional test polygon at 0..1.
update public.businesses set delivery_fee_paise=500,min_order_paise=10000 where slug='ammu-sammu';
select public.test_assert(not has_function_privilege('anon','public.place_order(text,jsonb,jsonb,jsonb,uuid)','execute') and not has_function_privilege('anon','public.check_delivery_eligibility(text,jsonb)','execute') and not has_function_privilege('anon','public.transition_order(uuid,text,integer)','execute'), 'RPCs unavailable to anon despite default grants');
set role authenticated;
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000001',false);
select set_config('test.fix',jsonb_build_object('latitude',0.5,'longitude',0.5,'accuracy',10,'captured_at',clock_timestamp())::text,false);
select set_config('test.items','[{"menu_item_id":"20000000-0000-4000-8000-000000000001","quantity":2}]',false);
select set_config('test.delivery','{"name":"Test Customer","phone":"123","address_line":"Test address"}',false);
select public.test_assert((public.check_delivery_eligibility('ammu-sammu',current_setting('test.fix')::jsonb)->>'eligible')::boolean,'inside confidence circle');
select public.test_assert(not (public.check_delivery_eligibility('konkan-fine-dine',current_setting('test.fix')::jsonb)->>'eligible')::boolean,'unconfigured zone denied');
select public.test_assert(not (public.check_delivery_eligibility('ammu-sammu',jsonb_build_object('latitude',2,'longitude',2,'accuracy',10,'captured_at',clock_timestamp()))->>'eligible')::boolean,'outside zone denied');
select public.test_assert(not (public.check_delivery_eligibility('ammu-sammu',jsonb_build_object('latitude',0,'longitude',0.5,'accuracy',10,'captured_at',clock_timestamp()))->>'eligible')::boolean,'uncertainty overlaps boundary denied');
select public.test_assert(not (public.check_delivery_eligibility('ammu-sammu',jsonb_build_object('latitude',0.5,'longitude',0.5,'accuracy',101,'captured_at',clock_timestamp()))->>'eligible')::boolean,'inaccurate fix denied');
select public.test_assert(not (public.check_delivery_eligibility('ammu-sammu',jsonb_build_object('latitude',0.5,'longitude',0.5,'accuracy',10,'captured_at',clock_timestamp()-interval '6 minutes'))->>'eligible')::boolean,'stale fix denied');
select public.test_assert(not (public.check_delivery_eligibility('ammu-sammu',jsonb_build_object('latitude',0.5,'longitude',0.5,'accuracy',10,'captured_at',clock_timestamp()+interval '1 minute'))->>'eligible')::boolean,'future fix denied');
select public.test_assert(not (public.check_delivery_eligibility('ammu-sammu','{"latitude":"bad"}')->>'eligible')::boolean,'malformed fix denied');
select set_config('test.result',public.place_order('ammu-sammu',current_setting('test.items')::jsonb,current_setting('test.delivery')::jsonb,current_setting('test.fix')::jsonb,'60000000-0000-4000-8000-000000000001')::text,false);
select set_config('test.order_id',current_setting('test.result')::jsonb->>'id',false);
select public.test_assert((current_setting('test.result')::jsonb->>'total_paise')::integer=30500 and (current_setting('test.result')::jsonb->>'version')::integer=1,'server price and fee');
select public.test_assert((select count(*)=1 and min(unit_price_paise)=15000 and min(quantity)=2 from public.order_items where order_id=current_setting('test.order_id')::uuid),'item snapshot');
select public.test_assert((select count(*)=1 from public.order_status_history where order_id=current_setting('test.order_id')::uuid and status='placed'),'initial history');
select public.test_assert(public.place_order('ammu-sammu',current_setting('test.items')::jsonb,current_setting('test.delivery')::jsonb,current_setting('test.fix')::jsonb,'60000000-0000-4000-8000-000000000001')->>'id'=current_setting('test.order_id'),'retry returns same order');
do $$ begin
  begin perform public.place_order('ammu-sammu',current_setting('test.items')::jsonb,'{"name":"Changed","phone":"123","address_line":"Test address"}',current_setting('test.fix')::jsonb,'60000000-0000-4000-8000-000000000001'); raise exception 'idempotency mismatch accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.place_order('ammu-sammu','[{"menu_item_id":"20000000-0000-4000-8000-000000000002","quantity":1}]',current_setting('test.delivery')::jsonb,current_setting('test.fix')::jsonb,'60000000-0000-4000-8000-000000000002'); raise exception 'cross tenant item accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.place_order('ammu-sammu','[{"menu_item_id":"20000000-0000-4000-8000-000000000001","quantity":0}]',current_setting('test.delivery')::jsonb,current_setting('test.fix')::jsonb,'60000000-0000-4000-8000-000000000003'); raise exception 'zero quantity accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.place_order('ammu-sammu','[{"menu_item_id":"20000000-0000-4000-8000-000000000001","quantity":1},{"menu_item_id":"20000000-0000-4000-8000-000000000001","quantity":1}]',current_setting('test.delivery')::jsonb,current_setting('test.fix')::jsonb,'60000000-0000-4000-8000-000000000004'); raise exception 'duplicate item accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.transition_order(current_setting('test.order_id')::uuid,'accepted',1); raise exception 'customer transition accepted'; exception when insufficient_privilege then null; end;
end $$;
reset role;
update public.menu_items set available=false, price_paise=20000 where id='20000000-0000-4000-8000-000000000001';
set role authenticated;
select public.test_assert((select unit_price_paise=15000 from public.order_items where order_id=current_setting('test.order_id')::uuid), 'snapshot survives menu changes');
do $$ begin
  begin perform public.place_order('ammu-sammu',current_setting('test.items')::jsonb,current_setting('test.delivery')::jsonb,current_setting('test.fix')::jsonb,'60000000-0000-4000-8000-000000000005'); raise exception 'unavailable item accepted'; exception when invalid_parameter_value then null; end;
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
