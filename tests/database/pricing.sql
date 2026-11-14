\set ON_ERROR_STOP on
begin;
select public.test_assert(to_regprocedure('public.place_order(text,jsonb,jsonb,jsonb,uuid)') is null, 'unchecked signature removed');
select public.test_assert(not has_function_privilege('anon','public.place_order(text,jsonb,jsonb,jsonb,uuid,jsonb)','execute') and has_function_privilege('authenticated','public.place_order(text,jsonb,jsonb,jsonb,uuid,jsonb)','execute'), 'RPC grants are restricted');
select public.test_assert((select proconfig @> array['search_path=""'] from pg_proc where oid='public.place_order(text,jsonb,jsonb,jsonb,uuid,jsonb)'::regprocedure),'empty definer search path');
select public.test_assert((select relrowsecurity from pg_class where oid='public.checkout_pricing_rejections'::regclass) and not has_table_privilege('authenticated','public.checkout_pricing_rejections','select,insert,update,delete'),'rejections have RLS and no client table grants');
update public.businesses set accepting_orders=true,ordering_enabled=true,delivery_fee_paise=500,min_order_paise=100 where slug='ammu-sammu';
insert into public.menu_items(id,business_id,name,category,price_paise,diet) values
('24000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Price one','Pricing',10000,'veg'),
('24000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','Price two','Pricing',20000,'egg');
select set_config('test.pricing.items','[{"menu_item_id":"24000000-0000-4000-8000-000000000001","quantity":1},{"menu_item_id":"24000000-0000-4000-8000-000000000002","quantity":1}]',true);
select set_config('test.pricing.fix',jsonb_build_object('latitude',0.5,'longitude',0.5,'accuracy',10,'captured_at',clock_timestamp())::text,true);
select set_config('test.pricing.accepted','{"lines":[{"menu_item_id":"24000000-0000-4000-8000-000000000001","quantity":1,"unit_price_paise":10000,"line_total_paise":10000},{"menu_item_id":"24000000-0000-4000-8000-000000000002","quantity":1,"unit_price_paise":20000,"line_total_paise":20000}],"delivery_fee_paise":500,"min_order_paise":100,"subtotal_paise":30000,"total_paise":30500}',true);
create function public.test_pricing_order(k integer, accepted jsonb default current_setting('test.pricing.accepted')::jsonb) returns jsonb language sql as $$
 select public.place_order('ammu-sammu',current_setting('test.pricing.items')::jsonb,'{"name":"Pricing","phone":"123","address_line":"Test"}',current_setting('test.pricing.fix')::jsonb,('64000000-0000-4000-8000-'||lpad(k::text,12,'0'))::uuid,accepted)
$$;
set role authenticated;
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000001',true);
select set_config('test.pricing.order',public.test_pricing_order(1)->>'id',true);
reset role;
update public.menu_items set price_paise=case when name='Price one' then 11000 else 19000 end where category='Pricing';
set role authenticated;
select set_config('test.pricing.revised',public.test_pricing_order(2)::text,true);
select public.test_assert(current_setting('test.pricing.revised')::jsonb->>'outcome'='pricing_changed' and (current_setting('test.pricing.revised')::jsonb->'pricing'->>'total_paise')::integer=30500,'offsetting prices need acceptance even with same total');
select public.test_assert(not exists(select 1 from public.orders where idempotency_key='64000000-0000-4000-8000-000000000002'),'changed pricing creates no order');
reset role;
update public.menu_items set price_paise=case when name='Price one' then 10000 else 20000 end where category='Pricing';
set role authenticated;
select public.test_assert(public.test_pricing_order(2)::text=current_setting('test.pricing.revised'),'rejected key remains terminal after prices revert');
do $$ begin
  begin perform public.test_pricing_order(2,current_setting('test.pricing.revised')::jsonb->'pricing'); raise exception 'reused rejection key accepted'; exception when invalid_parameter_value then null; end;
end $$;
reset role;
update public.businesses set delivery_fee_paise=700 where slug='ammu-sammu';
set role authenticated;
select public.test_assert((public.test_pricing_order(3)->'pricing'->>'delivery_fee_paise')::integer=700,'fee-only change returns revised quote');
reset role;
update public.businesses set delivery_fee_paise=500,min_order_paise=200 where slug='ammu-sammu';
set role authenticated;
select public.test_assert((public.test_pricing_order(4)->'pricing'->>'min_order_paise')::integer=200,'minimum-only change requires acceptance even when eligible');
reset role;
update public.businesses set min_order_paise=40000 where slug='ammu-sammu';
set role authenticated;

-- A changed minimum returns a validated quote even when it makes ordering ineligible.
select public.test_assert((public.test_pricing_order(5)->'pricing'->>'min_order_paise')::integer=40000,'below minimum still returns revised quote');
do $$ begin
  begin perform public.test_pricing_order(6,(public.test_pricing_order(5)->'pricing')); raise exception 'below minimum placed'; exception when invalid_parameter_value then null; end;
end $$;
reset role;
update public.businesses set min_order_paise=100 where slug='ammu-sammu';
set role authenticated;
select public.test_assert(public.test_pricing_order(7)->>'outcome'='placed','explicit accepted terms with a new key can place');
do $$ begin
  begin perform public.test_pricing_order(7,jsonb_set(current_setting('test.pricing.accepted')::jsonb,'{min_order_paise}','101')); raise exception 'digest ignored accepted terms'; exception when invalid_parameter_value then null; end;
end $$;
reset role;
update public.businesses set accepting_orders=false,delivery_fee_paise=900,min_order_paise=999999 where slug='ammu-sammu';
update public.menu_items set available=false,price_paise=42,diet='non_veg' where category='Pricing';
set role authenticated;
select public.test_assert(public.test_pricing_order(1)->>'id'=current_setting('test.pricing.order'),'uncertain original recovers before closed, availability and changed pricing checks');
select public.test_assert((select diet='veg' and unit_price_paise=10000 from public.order_items where order_id=current_setting('test.pricing.order')::uuid and menu_item_id='24000000-0000-4000-8000-000000000001'),'trusted historical diet and price remain immutable');
do $$ begin
  begin perform public.test_pricing_order(8); raise exception 'new closed order accepted'; exception when sqlstate 'PT409' then null; end;
end $$;
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000002',true);
do $$ begin
  begin perform public.test_pricing_order(1); raise exception 'other user recovered private order'; exception when sqlstate 'PT409' then null; end;
end $$;
reset role;
update public.businesses set accepting_orders=true,min_order_paise=0 where slug='ammu-sammu';
set role authenticated;
do $$ begin
  begin perform public.place_order('ammu-sammu','[{"menu_item_id":"20000000-0000-4000-8000-000000000002","quantity":1}]','{"name":"Test","phone":"1","address_line":"Test"}',current_setting('test.pricing.fix')::jsonb,'64000000-0000-4000-8000-000000000009',current_setting('test.pricing.accepted')::jsonb); raise exception 'cross business item accepted'; exception when invalid_parameter_value then null; end;
end $$;
reset role;
select public.test_assert((select count(*)=2 from public.orders where idempotency_key::text like '64000000-%'),'only the explicitly accepted new attempts created orders');
rollback;
