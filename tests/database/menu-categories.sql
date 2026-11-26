\set ON_ERROR_STOP on
begin;
create or replace function public.test_assert(ok boolean, message text) returns void
language plpgsql as $$ begin if not coalesce(ok,false) then raise exception 'assertion failed: %',message; end if; end $$;
select public.test_assert(not exists(select 1 from information_schema.columns where table_schema='public' and table_name='menu_items' and column_name='category'), 'text category removed');
select public.test_assert((select relrowsecurity from pg_class where oid='public.menu_categories'::regclass), 'category RLS enabled');
select public.test_assert(to_regprocedure('public.place_order(text,jsonb,jsonb,jsonb,uuid)') is null, 'only accepted-pricing checkout signature exists');
select public.test_assert(not has_function_privilege('anon','public.prevent_category_business_change()','execute') and not has_function_privilege('authenticated','public.prevent_category_business_change()','execute'), 'trigger is not a client API');
insert into auth.users(id) select ('43200000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid from generate_series(1,6) n on conflict do nothing;
insert into public.business_memberships(business_id,user_id,role) values
('10000000-0000-4000-8000-000000000001','43200000-0000-4000-8000-000000000003','admin'),
('10000000-0000-4000-8000-000000000002','43200000-0000-4000-8000-000000000004','admin'),
('10000000-0000-4000-8000-000000000001','43200000-0000-4000-8000-000000000005','admin'),
('10000000-0000-4000-8000-000000000002','43200000-0000-4000-8000-000000000005','admin'),
('10000000-0000-4000-8000-000000000001','43200000-0000-4000-8000-000000000006','admin') on conflict do nothing;
delete from public.business_memberships where user_id='43200000-0000-4000-8000-000000000006';
insert into public.menu_categories(id,business_id,name) values
('14300000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','All'),
('14300000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','All');
insert into public.menu_items(id,business_id,name,category_id,price_paise) values
('24300000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Unknown dish','14300000-0000-4000-8000-000000000001',10000);
select public.test_assert((select diet is null and not is_featured and sort_order=0 from public.menu_items where id='24300000-0000-4000-8000-000000000001'), 'new category assignment preserves diet and merchandising defaults');
set role anon;
select public.test_assert((select count(*)=2 from public.menu_categories where name='All'), 'guests read categories in both public catalogs');
do $$ begin
  begin insert into public.menu_categories(business_id,name) values('10000000-0000-4000-8000-000000000001','Guest'); raise exception 'guest inserted category'; exception when insufficient_privilege then null; end;
  begin update public.menu_categories set sort_order=1; raise exception 'guest updated category'; exception when insufficient_privilege then null; end;
  begin delete from public.menu_categories; raise exception 'guest deleted category'; exception when insufficient_privilege then null; end;
end $$;
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub','43200000-0000-4000-8000-000000000001',true);
update public.menu_categories set sort_order=4 where name='All';
delete from public.menu_categories where name='All';
select public.test_assert((select count(*)=2 and bool_and(sort_order=0) from public.menu_categories where name='All'), 'customer update and delete affect no categories');
do $$ begin
  begin insert into public.menu_categories(business_id,name) values('10000000-0000-4000-8000-000000000001','Customer'); raise exception 'customer inserted category'; exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','43200000-0000-4000-8000-000000000003',true);
update public.menu_categories set sort_order=-2147483648 where id='14300000-0000-4000-8000-000000000001';
update public.menu_categories set sort_order=7 where id='14300000-0000-4000-8000-000000000002';
delete from public.menu_categories where id='14300000-0000-4000-8000-000000000002';
select public.test_assert((select sort_order=0 from public.menu_categories where id='14300000-0000-4000-8000-000000000002'), 'owning admin cannot update or delete other-business category');
insert into public.menu_categories(id,business_id,name,sort_order) values('14300000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','Empty',2147483647);
update public.menu_categories set name='Renamed' where id='14300000-0000-4000-8000-000000000003';
delete from public.menu_categories where id='14300000-0000-4000-8000-000000000003';
select public.test_assert(not exists(select 1 from public.menu_categories where id='14300000-0000-4000-8000-000000000003'), 'owner creates renames and deletes empty category');
do $$ begin
  begin insert into public.menu_categories(business_id,name) values('10000000-0000-4000-8000-000000000002','Cross'); raise exception 'cross business insert'; exception when insufficient_privilege then null; end;
  begin insert into public.menu_categories(business_id,name) values('10000000-0000-4000-8000-000000000001','All'); raise exception 'duplicate category'; exception when unique_violation then null; end;
  begin insert into public.menu_categories(business_id,name) values('10000000-0000-4000-8000-000000000001',' '); raise exception 'blank category'; exception when check_violation then null; end;
  begin insert into public.menu_categories(business_id,name) values('10000000-0000-4000-8000-000000000001',' Padded '); raise exception 'untrimmed category'; exception when check_violation then null; end;
  begin insert into public.menu_categories(business_id,name) values('10000000-0000-4000-8000-000000000001',repeat('x',101)); raise exception 'long category'; exception when check_violation then null; end;
  begin update public.menu_categories set name=null where id='14300000-0000-4000-8000-000000000001'; raise exception 'null name'; exception when not_null_violation then null; end;
  begin update public.menu_categories set sort_order=null where id='14300000-0000-4000-8000-000000000001'; raise exception 'null order'; exception when not_null_violation then null; end;
  begin update public.menu_categories set sort_order=-2147483649 where id='14300000-0000-4000-8000-000000000001'; raise exception 'underflow order'; exception when numeric_value_out_of_range then null; end;
  begin update public.menu_categories set sort_order=2147483648 where id='14300000-0000-4000-8000-000000000001'; raise exception 'overflow order'; exception when numeric_value_out_of_range then null; end;
  begin execute $q$update public.menu_categories set sort_order='1.5' where id='14300000-0000-4000-8000-000000000001'$q$; raise exception 'fractional order'; exception when invalid_text_representation then null; end;
  begin delete from public.menu_categories where id='14300000-0000-4000-8000-000000000001'; raise exception 'in-use category deleted'; exception when foreign_key_violation then null; end;
  begin insert into public.menu_items(business_id,name,category_id,price_paise,diet) values('10000000-0000-4000-8000-000000000001','Cross category','14300000-0000-4000-8000-000000000002',100,'egg'); raise exception 'cross category insert'; exception when foreign_key_violation then null; end;
  begin update public.menu_items set category_id='14300000-0000-4000-8000-000000000002' where id='24300000-0000-4000-8000-000000000001'; raise exception 'cross category update'; exception when foreign_key_violation then null; end;
  begin insert into public.menu_items(business_id,name,price_paise,diet) values('10000000-0000-4000-8000-000000000001','Missing category',100,'egg'); raise exception 'missing category'; exception when not_null_violation then null; end;
  begin insert into public.menu_items(business_id,name,category_id,price_paise) values('10000000-0000-4000-8000-000000000001','No diet','14300000-0000-4000-8000-000000000001',100); raise exception 'missing new diet'; exception when invalid_parameter_value then null; end;
end $$;
insert into public.menu_items(id,business_id,name,category_id,price_paise,diet,is_featured,sort_order) values
('24300000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','Egg dish','14300000-0000-4000-8000-000000000001',10000,'egg',true,-2);
update public.menu_categories set name='Renamed All' where id='14300000-0000-4000-8000-000000000001';
select public.test_assert((select c.name='Renamed All' and m.diet='egg' and m.is_featured and m.sort_order=-2 from public.menu_items m join public.menu_categories c on (c.business_id,c.id)=(m.business_id,m.category_id) where m.id='24300000-0000-4000-8000-000000000002'), 'rename preserves category reference, diet and item ordering');
select set_config('request.jwt.claim.sub','43200000-0000-4000-8000-000000000006',true);
update public.menu_categories set sort_order=8 where id='14300000-0000-4000-8000-000000000001';
delete from public.menu_categories where id='14300000-0000-4000-8000-000000000002';
select public.test_assert((select sort_order=-2147483648 from public.menu_categories where id='14300000-0000-4000-8000-000000000001'), 'revoked membership cannot edit categories');
select set_config('request.jwt.claim.sub','43200000-0000-4000-8000-000000000005',true);
do $$ begin
  begin update public.menu_categories set business_id='10000000-0000-4000-8000-000000000001' where id='14300000-0000-4000-8000-000000000002'; raise exception 'dual admin transferred category'; exception when invalid_parameter_value then null; end;
  begin update public.menu_items set business_id='10000000-0000-4000-8000-000000000002',category_id='14300000-0000-4000-8000-000000000002' where id='24300000-0000-4000-8000-000000000001'; raise exception 'dual admin transferred dish'; exception when raise_exception then if sqlerrm='dual admin transferred dish' then raise; end if; end;
end $$;
reset role;
-- Fictional local boundary. Exercise accepted-pricing checkout against the final schema.
do $$ declare ns text; begin
  select n.nspname into strict ns from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='postgis';
  execute format('update public.businesses set is_demo=false,service_area=%I.st_geomfromtext(''MULTIPOLYGON(((0 0,1 0,1 1,0 1,0 0)))'',4326),service_area_source=''category test'',service_area_version=''test'',service_area_verified_at=now(),ordering_enabled=true,accepting_orders=true,min_order_paise=0,delivery_fee_paise=0 where slug=''ammu-sammu''',ns);
end $$;
select set_config('test.category.items','[{"menu_item_id":"24300000-0000-4000-8000-000000000002","quantity":1,"diet":"veg"}]',true);
select set_config('test.category.pricing','{"lines":[{"menu_item_id":"24300000-0000-4000-8000-000000000002","quantity":1,"unit_price_paise":10000,"line_total_paise":10000}],"subtotal_paise":10000,"delivery_fee_paise":0,"min_order_paise":0,"total_paise":10000}',true);
select set_config('test.category.fix',jsonb_build_object('latitude',0.5,'longitude',0.5,'accuracy',10,'captured_at',clock_timestamp())::text,true);
-- The checkout customer's saved address, inside the fictional square (saved-address path, no typed address).
insert into public.customer_addresses(customer_id,label,house,street_area,latitude,longitude,location_source) values ('43200000-0000-4000-8000-000000000001','home','Category house','Synthetic Road',0.5,0.5,'pin');
set role authenticated;
select set_config('request.jwt.claim.sub','43200000-0000-4000-8000-000000000001',true);
select set_config('test.category.order',public.place_order('ammu-sammu',current_setting('test.category.items')::jsonb,public.test_delivery('Category'),current_setting('test.category.fix')::jsonb,'64300000-0000-4000-8000-000000000001',current_setting('test.category.pricing')::jsonb)->>'id',true);
select public.test_assert((select diet='egg' and unit_price_paise=10000 from public.order_items where order_id=current_setting('test.category.order')::uuid), 'final-schema checkout snapshots authoritative diet and accepted price');
select set_config('request.jwt.claim.sub','43200000-0000-4000-8000-000000000003',true);
update public.menu_items set diet='non_veg',price_paise=11000 where id='24300000-0000-4000-8000-000000000002';
select public.test_assert((select diet='egg' from public.order_items where order_id=current_setting('test.category.order')::uuid), 'later reclassification preserves past-order diet');
select set_config('request.jwt.claim.sub','43200000-0000-4000-8000-000000000001',true);
select public.test_assert(public.place_order('ammu-sammu',current_setting('test.category.items')::jsonb,public.test_delivery('Category'),current_setting('test.category.fix')::jsonb,'64300000-0000-4000-8000-000000000002',current_setting('test.category.pricing')::jsonb)->>'outcome'='pricing_changed', 'final-schema checkout requires changed-price acceptance');
reset role;
rollback;
