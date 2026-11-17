\set ON_ERROR_STOP on
begin;
create or replace function public.test_assert(ok boolean, message text) returns void language plpgsql as $$ begin if ok is distinct from true then raise exception 'assertion failed: %',message; end if; end $$;
select public.test_assert(not has_table_privilege('authenticated','public.order_number_counters','select,insert,update,delete') and not has_table_privilege('anon','public.order_number_counters','select,insert,update,delete'),'counter table inaccessible to clients');
select public.test_assert((select relrowsecurity from pg_class where oid='public.order_number_counters'::regclass),'counter RLS enabled');
select public.test_assert(not has_function_privilege('authenticated','public.assign_order_number()','execute'),'allocator is not a client RPC');
select public.test_assert(to_regprocedure('public.place_order(text,jsonb,jsonb,jsonb,uuid)') is null and has_function_privilege('authenticated','public.place_order(text,jsonb,jsonb,jsonb,uuid,jsonb)','execute'),'only accepted-pricing RPC remains');
insert into auth.users(id) values ('34700000-0000-4000-8000-000000000001') on conflict do nothing;
-- The numbering customer's saved address, inside the fictional square installed below.
insert into public.customer_addresses(customer_id,label,house,street_area,latitude,longitude,location_source) values ('34700000-0000-4000-8000-000000000001','home','Number house','Synthetic Road',0.5,0.5,'pin');
create function public.test_number_insert(slug text, placed timestamptz) returns text language plpgsql as $$
declare result text;
begin
  insert into public.orders(business_id,customer_id,customer_name,customer_phone,delivery_address_line,latitude,longitude,address_label,address_house,address_street_area,address_location_source,saved_address_id,saved_address_version,subtotal_paise,delivery_fee_paise,total_paise,idempotency_key,request_hash,created_at)
  select id,'34700000-0000-4000-8000-000000000001','Number test','123','Test',0.5,0.5,'home','Test','Test','pin',gen_random_uuid(),1,1,0,1,gen_random_uuid(),'test',placed from public.businesses where businesses.slug=test_number_insert.slug returning order_number into result;
  return result;
end $$;
-- Service-role maintenance has always been allowed to insert orders. Allocation
-- must continue to work through that trusted path without exposing counters to clients.
set role service_role;
select public.test_assert(public.test_number_insert('ammu-sammu','2099-01-01 00:00:00+00')='AMS-2099010001','trusted service-role order inserts allocate a number');
reset role;
select public.test_assert(public.test_number_insert('ammu-sammu','2097-12-31 18:29:59+00')='AMS-2097120001','India month before boundary');
select public.test_assert(public.test_number_insert('ammu-sammu','2097-12-31 18:30:00+00')='AMS-2098010001','India year/month reset');
select public.test_assert(public.test_number_insert('ammu-sammu','2098-01-01 00:00:00+00')='AMS-2098010002','same India month continues');
select public.test_assert(public.test_number_insert('kokani-dine-inn','2097-12-31 18:30:00+00')='KDI-2098010001','restaurant counters independent');
update public.order_number_counters set last_number=9998 where business_id='10000000-0000-4000-8000-000000000001' and year_month='209801';
select public.test_assert(public.test_number_insert('ammu-sammu','2098-01-01 00:00:00+00')='AMS-2098019999','four digit maximum');
select public.test_assert(public.test_number_insert('ammu-sammu','2098-01-01 00:00:00+00')='AMS-20980110000','five digit count grows without truncation');
savepoint counter_rollback;
select public.test_assert(public.test_number_insert('ammu-sammu','2098-01-01 00:00:00+00')='AMS-20980110001','allocation before rollback');
rollback to counter_rollback;
select public.test_assert(public.test_number_insert('ammu-sammu','2098-01-01 00:00:00+00')='AMS-20980110001','rollback restores counter and order atomically');
do $$ begin
  begin update public.businesses set order_prefix='NEW' where slug='ammu-sammu'; raise exception 'prefix changed'; exception when invalid_parameter_value then null; end;
  begin update public.orders set order_number='fake' where order_number='AMS-20980110000'; raise exception 'number changed'; exception when invalid_parameter_value then null; end;
  begin update public.orders set created_at=now() where order_number='AMS-20980110000'; raise exception 'placement changed'; exception when invalid_parameter_value then null; end;
  begin update public.businesses set contact_phone='123' where slug='ammu-sammu'; raise exception 'invalid phone accepted'; exception when check_violation then null; end;
end $$;
update public.businesses set contact_phone='+919000000001' where slug='ammu-sammu';
-- Fictional geometry is confined to this rolled-back test fixture.
do $$ declare ns text; begin
  select n.nspname into strict ns from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='postgis';
  execute format('update public.businesses set is_demo=false,service_area=%1$I.st_geomfromtext(''MULTIPOLYGON(((0 0,1 0,1 1,0 1,0 0)))'',4326),service_area_source=''number-test-only'',service_area_version=''test'',service_area_verified_at=now(),ordering_enabled=true,accepting_orders=true,delivery_fee_paise=0,min_order_paise=0',ns);
end $$;
update public.menu_items set available=true,is_demo=false where id='20000000-0000-4000-8000-000000000001';
select set_config('test.number.fix',jsonb_build_object('latitude',0.5,'longitude',0.5,'accuracy',10,'captured_at',clock_timestamp())::text,true);
select set_config('test.number.quote',(select jsonb_build_object('lines',jsonb_build_array(jsonb_build_object('menu_item_id',id,'quantity',1,'unit_price_paise',price_paise,'line_total_paise',price_paise)),'delivery_fee_paise',0,'min_order_paise',0,'subtotal_paise',price_paise,'total_paise',price_paise)::text from public.menu_items where id='20000000-0000-4000-8000-000000000001'),true);
create function public.test_number_place(k uuid, quote jsonb) returns jsonb language sql as $$ select public.place_order('ammu-sammu','[{"menu_item_id":"20000000-0000-4000-8000-000000000001","quantity":1}]',public.test_delivery('Number'),current_setting('test.number.fix')::jsonb,k,quote) $$;
select set_config('test.number.counter',(select coalesce(sum(last_number),0)::text from public.order_number_counters),true);
set role authenticated;
select set_config('request.jwt.claim.sub','34700000-0000-4000-8000-000000000001',true);
select public.test_assert(public.test_number_place('64700000-0000-4000-8000-000000000001','{}')->>'outcome'='pricing_changed','pricing rejection does not place');
reset role;
select public.test_assert((select coalesce(sum(last_number),0)::text=current_setting('test.number.counter') from public.order_number_counters),'pricing rejection consumes no number');
set role authenticated;
select set_config('test.number.placed',public.test_number_place('64700000-0000-4000-8000-000000000002',current_setting('test.number.quote')::jsonb)::text,true);
select public.test_assert((current_setting('test.number.placed')::jsonb->>'order_number') ~ '^AMS-[0-9]{6}[0-9]{4,}$','RPC returns real number');
select public.test_assert(public.test_number_place('64700000-0000-4000-8000-000000000002',current_setting('test.number.quote')::jsonb)=current_setting('test.number.placed')::jsonb,'retry returns same order and number');
do $$ begin
 begin perform public.test_number_place('64700000-0000-4000-8000-000000000002','{}'); raise exception 'conflicting retry accepted'; exception when invalid_parameter_value then null; end;
end $$;
reset role;
select public.test_assert((select sum(last_number)=current_setting('test.number.counter')::bigint+1 from public.order_number_counters),'accepted placement and retry allocate exactly once');
update public.menu_items set price_paise=price_paise+1 where id='20000000-0000-4000-8000-000000000001';
set role authenticated;
select public.test_assert(public.test_number_place('64700000-0000-4000-8000-000000000001','{}')->'pricing'=current_setting('test.number.quote')::jsonb,'terminal rejected key preserves original revised quote');
select public.test_assert(public.test_number_place('64700000-0000-4000-8000-000000000002',current_setting('test.number.quote')::jsonb)->>'order_number'=current_setting('test.number.placed')::jsonb->>'order_number','successful replay precedes repricing');
reset role;
rollback;
