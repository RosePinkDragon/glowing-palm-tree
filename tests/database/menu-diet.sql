\set ON_ERROR_STOP on
begin;
-- Self-contained: run after all migrations and seed, or after the older suites.
create or replace function public.test_assert(ok boolean, message text) returns void
language plpgsql as $$ begin if not coalesce(ok,false) then raise exception 'assertion failed: %',message; end if; end $$;
insert into auth.users(id) select ('43000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid from generate_series(1,6) n on conflict do nothing;
insert into public.business_memberships(business_id,user_id,role) values
('10000000-0000-4000-8000-000000000001','43000000-0000-4000-8000-000000000003','admin'),
('10000000-0000-4000-8000-000000000002','43000000-0000-4000-8000-000000000004','admin'),
('10000000-0000-4000-8000-000000000001','43000000-0000-4000-8000-000000000005','admin'),
('10000000-0000-4000-8000-000000000002','43000000-0000-4000-8000-000000000005','admin'),
('10000000-0000-4000-8000-000000000001','43000000-0000-4000-8000-000000000006','admin') on conflict do nothing;
delete from public.business_memberships where user_id='43000000-0000-4000-8000-000000000006';
select public.test_assert((select bool_and(diet is null) from public.menu_items where id in ('20000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002')), 'seed data has no inferred classification');
select public.test_assert(not has_function_privilege('anon','public.require_menu_diet()','execute') and not has_function_privilege('authenticated','public.require_menu_diet()','execute'), 'trigger function is not a client API');
select public.test_assert(not has_function_privilege('anon','public.place_order(text,jsonb,jsonb,jsonb,uuid)','execute'), 'place_order stays unavailable to guests');
select public.test_assert(not has_column_privilege('authenticated','public.order_items','diet','insert') and not has_column_privilege('authenticated','public.order_items','diet','update'), 'snapshot has no direct client write privilege');
-- A trusted unclassified fixture, unrelated to the sample flag.
insert into public.menu_items(id,business_id,name,category,price_paise) values
('23000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Unclassified setup dish','Diet test',10000);
set role anon;
select public.test_assert((select diet is null from public.menu_items where id='23000000-0000-4000-8000-000000000001'), 'guest can read unknown without a fake mark');
do $$ begin
  begin update public.menu_items set diet='veg' where id='23000000-0000-4000-8000-000000000001'; raise exception 'guest edited diet'; exception when insufficient_privilege then null; end;
end $$;
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub','43000000-0000-4000-8000-000000000001',false);
update public.menu_items set diet='veg' where id='23000000-0000-4000-8000-000000000001';
select public.test_assert((select diet is null from public.menu_items where id='23000000-0000-4000-8000-000000000001'), 'customer diet update denied');
do $$ begin
  begin insert into public.menu_items(business_id,name,category,price_paise,diet) values('10000000-0000-4000-8000-000000000001','Customer dish','Diet test',100,'veg'); raise exception 'customer inserted diet'; exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','43000000-0000-4000-8000-000000000003',false);
-- Updating another field does not force an invented classification for old data.
update public.menu_items set description='Waiting for owner classification' where id='23000000-0000-4000-8000-000000000001';
select public.test_assert((select diet is null from public.menu_items where id='23000000-0000-4000-8000-000000000001'), 'unknown may stay unknown');
do $$ begin
  begin insert into public.menu_items(business_id,name,category,price_paise) values('10000000-0000-4000-8000-000000000001','No diet','Diet test',100); raise exception 'new unclassified client dish accepted'; exception when invalid_parameter_value then null; end;
  begin insert into public.menu_items(business_id,name,category,price_paise,is_demo) values('10000000-0000-4000-8000-000000000001','Sample bypass','Diet test',100,true); raise exception 'sample flag bypass accepted'; exception when invalid_parameter_value then null; end;
  begin insert into public.menu_items(business_id,name,category,price_paise,diet) values('10000000-0000-4000-8000-000000000002','Cross business','Diet test',100,'veg'); raise exception 'cross business insert accepted'; exception when insufficient_privilege then null; end;
  begin update public.menu_items set diet='fish' where id='23000000-0000-4000-8000-000000000001'; raise exception 'invalid enum accepted'; exception when invalid_text_representation then null; end;
end $$;
insert into public.menu_items(id,business_id,name,category,price_paise,diet) values
('23000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','Classified dish','Diet test',10000,'egg');
update public.menu_items set diet='veg' where id='23000000-0000-4000-8000-000000000002';
do $$ begin
  begin update public.menu_items set diet=null where id='23000000-0000-4000-8000-000000000002'; raise exception 'known diet erased'; exception when invalid_parameter_value then null; end;
end $$;
select set_config('request.jwt.claim.sub','43000000-0000-4000-8000-000000000004',false);
update public.menu_items set diet='non_veg' where id='23000000-0000-4000-8000-000000000002';
select public.test_assert((select diet='veg' from public.menu_items where id='23000000-0000-4000-8000-000000000002'), 'other business owner cannot reclassify');
select set_config('request.jwt.claim.sub','43000000-0000-4000-8000-000000000006',false);
update public.menu_items set diet='non_veg' where id='23000000-0000-4000-8000-000000000002';
select public.test_assert((select diet='veg' from public.menu_items where id='23000000-0000-4000-8000-000000000002'), 'revoked owner cannot reclassify');
select set_config('request.jwt.claim.sub','43000000-0000-4000-8000-000000000005',false);
do $$ begin
  begin update public.menu_items set business_id='10000000-0000-4000-8000-000000000002',diet='egg' where id='23000000-0000-4000-8000-000000000002'; raise exception 'dual owner transferred dish'; exception when raise_exception then if sqlerrm='dual owner transferred dish' then raise; end if; end;
end $$;
reset role;
-- Fictional local service area, never a real restaurant delivery assertion.
do $$ declare ns text; begin
  select n.nspname into strict ns from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='postgis';
  execute format('update public.businesses set service_area=%I.st_geomfromtext(''MULTIPOLYGON(((0 0,1 0,1 1,0 1,0 0)))'',4326),service_area_source=''diet test'',service_area_version=''test'',service_area_verified_at=now(),ordering_enabled=true,accepting_orders=true,min_order_paise=0 where slug=''ammu-sammu''',ns);
end $$;
select set_config('test.diet.fix',jsonb_build_object('latitude',0.5,'longitude',0.5,'accuracy',10,'captured_at',clock_timestamp())::text,false);
-- Deliberately forged diet must not influence the stored snapshot.
select set_config('test.diet.items','[{"menu_item_id":"23000000-0000-4000-8000-000000000002","quantity":1,"diet":"non_veg"},{"menu_item_id":"23000000-0000-4000-8000-000000000001","quantity":1,"diet":"veg"}]',false);
select set_config('test.diet.delivery','{"name":"Diet Test","phone":"123","address_line":"Synthetic test address"}',false);
set role authenticated;
select set_config('request.jwt.claim.sub','43000000-0000-4000-8000-000000000001',false);
select set_config('test.diet.order',public.place_order('ammu-sammu',current_setting('test.diet.items')::jsonb,current_setting('test.diet.delivery')::jsonb,current_setting('test.diet.fix')::jsonb,'63000000-0000-4000-8000-000000000043')->>'id',false);
select public.test_assert((select diet='veg' from public.order_items where order_id=current_setting('test.diet.order')::uuid and menu_item_id='23000000-0000-4000-8000-000000000002'), 'snapshot comes from authoritative menu, not forged cart');
select public.test_assert((select diet is null from public.order_items where order_id=current_setting('test.diet.order')::uuid and menu_item_id='23000000-0000-4000-8000-000000000001'), 'unknown is snapshotted as unknown');
do $$ begin
  begin update public.order_items set diet='egg' where order_id=current_setting('test.diet.order')::uuid; raise exception 'customer rewrote snapshot'; exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','43000000-0000-4000-8000-000000000002',false);
select public.test_assert((select count(*)=0 from public.order_items where order_id=current_setting('test.diet.order')::uuid), 'other customer cannot see snapshots');
select set_config('request.jwt.claim.sub','43000000-0000-4000-8000-000000000004',false);
select public.test_assert((select count(*)=0 from public.order_items where order_id=current_setting('test.diet.order')::uuid), 'other restaurant owner cannot see snapshots');
select set_config('request.jwt.claim.sub','43000000-0000-4000-8000-000000000003',false);
update public.menu_items set diet='egg' where id='23000000-0000-4000-8000-000000000002';
select public.test_assert((select diet='veg' from public.order_items where order_id=current_setting('test.diet.order')::uuid and menu_item_id='23000000-0000-4000-8000-000000000002'), 'reclassification preserves past order');
do $$ begin
  begin update public.order_items set diet='egg' where order_id=current_setting('test.diet.order')::uuid; raise exception 'owner rewrote snapshot'; exception when insufficient_privilege then null; end;
end $$;
select public.set_accepting_orders('ammu-sammu',false);
select set_config('request.jwt.claim.sub','43000000-0000-4000-8000-000000000001',false);
select public.test_assert(public.place_order('ammu-sammu',current_setting('test.diet.items')::jsonb,current_setting('test.diet.delivery')::jsonb,current_setting('test.diet.fix')::jsonb,'63000000-0000-4000-8000-000000000043')->>'id'=current_setting('test.diet.order'), 'idempotent retry survives reclassification and restaurant closing');
select public.test_assert((select count(*)=2 and count(diet)=1 from public.order_items where order_id=current_setting('test.diet.order')::uuid), 'retry does not rewrite or duplicate snapshots');
do $$ begin
  begin perform public.place_order('ammu-sammu',current_setting('test.diet.items')::jsonb,current_setting('test.diet.delivery')::jsonb,current_setting('test.diet.fix')::jsonb,'63000000-0000-4000-8000-000000000044'); raise exception 'new closed order accepted'; exception when sqlstate 'PT409' then null; end;
end $$;
reset role;
rollback;
