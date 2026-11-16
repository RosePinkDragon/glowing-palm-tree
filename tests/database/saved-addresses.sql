\set ON_ERROR_STOP on
-- #48 saved addresses: ownership/RLS, validation, versioning, list_addresses
-- area/distance, and saved-pin checkout with immutable snapshots. Rolled back.
begin;
create or replace function public.test_assert(ok boolean, message text) returns void language plpgsql as $$ begin if ok is distinct from true then raise exception 'assertion failed: %',message; end if; end $$;
-- Owner-supplied kitchen points are installed (by migration or seed), within a metre.
do $$ declare ns text; ok boolean; begin
  select n.nspname into strict ns from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='postgis';
  execute format('select bool_and(%1$I.st_distance(kitchen_location::%1$I.geography, %1$I.st_setsrid(%1$I.st_makepoint(case slug when ''ammu-sammu'' then 73.3944946 else 73.3988110 end, case slug when ''ammu-sammu'' then 17.7190154 else 17.7197215 end),4326)::%1$I.geography) < 1) and count(*)=2 from public.businesses where slug in (''ammu-sammu'',''kokani-dine-inn'')', ns) into ok;
  perform public.test_assert(ok, 'owner-supplied kitchen points installed');
end $$;
-- Fictional test geography only: a 0..1 degree square with the kitchen in the middle.
do $$ declare ns text; begin
  select n.nspname into strict ns from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='postgis';
  execute format('update public.businesses set is_demo=false,service_area=%1$I.st_geomfromtext(''MULTIPOLYGON(((0 0,1 0,1 1,0 1,0 0)))'',4326),service_area_source=''address-test-only'',service_area_version=''test'',service_area_verified_at=now(),ordering_enabled=true,accepting_orders=true,delivery_fee_paise=0,min_order_paise=0,kitchen_location=%1$I.st_setsrid(%1$I.st_makepoint(0.5,0.5),4326) where slug=''ammu-sammu''',ns);
end $$;
update public.businesses set ordering_enabled=false,service_area=null,kitchen_location=null where slug='kokani-dine-inn';
update public.menu_items set available=true,is_demo=false where id='20000000-0000-4000-8000-000000000001';
insert into auth.users(id) values ('34800000-0000-4000-8000-000000000001'),('34800000-0000-4000-8000-000000000002'),('34800000-0000-4000-8000-000000000003') on conflict do nothing;
insert into public.business_memberships(business_id,user_id,role) values ('10000000-0000-4000-8000-000000000001','34800000-0000-4000-8000-000000000003','admin');
create function public.test_addr_place(k uuid, delivery jsonb, location jsonb) returns jsonb language sql as $$
  select public.place_order('ammu-sammu','[{"menu_item_id":"20000000-0000-4000-8000-000000000001","quantity":1}]',delivery,location,k,
    jsonb_build_object('lines',jsonb_build_array(jsonb_build_object('menu_item_id',m.id,'quantity',1,'unit_price_paise',m.price_paise,'line_total_paise',m.price_paise)),'delivery_fee_paise',0,'min_order_paise',0,'subtotal_paise',m.price_paise,'total_paise',m.price_paise))
  from public.menu_items m where m.id='20000000-0000-4000-8000-000000000001' $$;
create function public.test_addr_delivery(addr uuid, v integer) returns jsonb language sql as $$ select jsonb_build_object('name','Saved Customer','phone','9876543210','address_id',addr,'address_version',v) $$;

-- Privileges: no anonymous access; identity, version and timestamps are not client-writable.
select public.test_assert((select relrowsecurity from pg_class where oid='public.customer_addresses'::regclass),'address RLS enabled');
select public.test_assert(not has_table_privilege('anon','public.customer_addresses','select,insert,update,delete'),'anon has no address access');
select public.test_assert(not has_column_privilege('authenticated','public.customer_addresses','customer_id','insert') and not has_column_privilege('authenticated','public.customer_addresses','customer_id','update')
  and not has_column_privilege('authenticated','public.customer_addresses','version','update') and not has_column_privilege('authenticated','public.customer_addresses','updated_at','update'),'owner, version and timestamps are server-controlled');
select public.test_assert(not has_function_privilege('anon','public.list_addresses(text)','execute') and has_function_privilege('authenticated','public.list_addresses(text)','execute'),'list_addresses is for signed-in callers only');
select public.test_assert(not has_function_privilege('authenticated','public.prepare_customer_address()','execute'),'trigger function is not an RPC');
select public.test_assert(to_regprocedure('public.place_order(text,jsonb,jsonb,jsonb,uuid)') is null,'no extra place_order overload');
select public.test_assert(not exists(select 1 from pg_publication_tables where tablename='customer_addresses'),'addresses stay out of realtime (DELETE events bypass RLS)');

set role authenticated;
select set_config('request.jwt.claim.sub','34800000-0000-4000-8000-000000000001',true);
insert into public.customer_addresses(label,house,street_area,landmark,latitude,longitude,location_source)
  values ('home','  12, Shivaji Nagar ',' Station Road, Khed ','   ',0.4,0.4,'pin');
insert into public.customer_addresses(label,custom_label,house,street_area,latitude,longitude,location_source)
  values ('other',' Aai ','Flat 3','Bharne Naka',2,2,'gps');
select set_config('test.home',(select id::text from public.customer_addresses where label='home'),true);
select set_config('test.away',(select id::text from public.customer_addresses where label='other'),true);
select public.test_assert((select customer_id='34800000-0000-4000-8000-000000000001' and version=1 and house='12, Shivaji Nagar' and street_area='Station Road, Khed' and landmark is null from public.customer_addresses where id=current_setting('test.home')::uuid),'insert owns, trims, blanks landmark and starts at version 1');
select public.test_assert((select custom_label='Aai' from public.customer_addresses where id=current_setting('test.away')::uuid),'custom label trimmed');
-- Spoofing the owner and invalid fields are refused.
do $$ begin
  begin insert into public.customer_addresses(customer_id,label,house,street_area,latitude,longitude,location_source) values ('34800000-0000-4000-8000-000000000002','home','x','y',0.4,0.4,'pin'); raise exception 'owner spoof accepted'; exception when insufficient_privilege then null; end;
  begin insert into public.customer_addresses(label,house,street_area,latitude,longitude,location_source) values ('office','x','y',0.4,0.4,'pin'); raise exception 'bad label accepted'; exception when check_violation then null; end;
  begin insert into public.customer_addresses(label,custom_label,house,street_area,latitude,longitude,location_source) values ('home','Mine','x','y',0.4,0.4,'pin'); raise exception 'custom label on home accepted'; exception when check_violation then null; end;
  begin insert into public.customer_addresses(label,custom_label,house,street_area,latitude,longitude,location_source) values ('other',repeat('a',41),'x','y',0.4,0.4,'pin'); raise exception 'long custom label accepted'; exception when check_violation then null; end;
  begin insert into public.customer_addresses(label,house,street_area,latitude,longitude,location_source) values ('home','   ','y',0.4,0.4,'pin'); raise exception 'blank house accepted'; exception when check_violation then null; end;
  begin insert into public.customer_addresses(label,house,street_area,latitude,longitude,location_source) values ('home',repeat('a',121),'y',0.4,0.4,'pin'); raise exception 'long house accepted'; exception when check_violation then null; end;
  begin insert into public.customer_addresses(label,house,street_area,latitude,longitude,location_source) values ('home','x',repeat('a',201),0.4,0.4,'pin'); raise exception 'long street accepted'; exception when check_violation then null; end;
  begin insert into public.customer_addresses(label,house,street_area,latitude,longitude,location_source) values ('home','x'||chr(10)||'y','y',0.4,0.4,'pin'); raise exception 'control character accepted'; exception when check_violation then null; end;
  begin insert into public.customer_addresses(label,house,street_area,latitude,longitude,location_source) values ('home','x'||chr(8238)||'y','y',0.4,0.4,'pin'); raise exception 'direction override accepted'; exception when check_violation then null; end;
  begin insert into public.customer_addresses(label,house,street_area,latitude,longitude,location_source) values ('home','x'||chr(8203)||'y','y',0.4,0.4,'pin'); raise exception 'zero-width space accepted'; exception when check_violation then null; end;
  begin insert into public.customer_addresses(label,house,street_area,latitude,longitude,location_source) values ('home','x','y',91,0.4,'pin'); raise exception 'bad latitude accepted'; exception when check_violation then null; end;
  begin insert into public.customer_addresses(label,house,street_area,latitude,longitude,location_source) values ('home','x','y','NaN',0.4,'pin'); raise exception 'NaN latitude accepted'; exception when check_violation then null; end;
  begin insert into public.customer_addresses(label,house,street_area,latitude,longitude,location_source) values ('home','x','y',0.4,0.4,'typed'); raise exception 'bad source accepted'; exception when check_violation then null; end;
end $$;

-- list_addresses: restaurant-specific area and kitchen distance; unverified areas fail closed.
select public.test_assert((select count(*)=2 from public.list_addresses('ammu-sammu')),'caller lists own addresses');
select public.test_assert((select in_area and distance_m between 15000 and 16500 from public.list_addresses('ammu-sammu') where id=current_setting('test.home')::uuid),'inside address is in area with kitchen distance');
select public.test_assert((select not in_area from public.list_addresses('ammu-sammu') where id=current_setting('test.away')::uuid),'outside address is not in area');
select public.test_assert((select bool_and(not in_area and distance_m is null) from public.list_addresses('kokani-dine-inn')),'unconfigured restaurant: never in area, distance unknown');
do $$ begin
  begin perform public.list_addresses('no-such-restaurant'); raise exception 'unknown restaurant listed'; exception when invalid_parameter_value then null; end;
end $$;

-- Another customer and a restaurant admin see and change nothing.
select set_config('request.jwt.claim.sub','34800000-0000-4000-8000-000000000002',true);
select public.test_assert((select count(*)=0 from public.customer_addresses) and (select count(*)=0 from public.list_addresses('ammu-sammu')),'other customer sees no addresses');
update public.customer_addresses set house='hijack' where id=current_setting('test.home')::uuid;
delete from public.customer_addresses where id=current_setting('test.away')::uuid;
select set_config('request.jwt.claim.sub','34800000-0000-4000-8000-000000000003',true);
select public.test_assert((select count(*)=0 from public.customer_addresses) and (select count(*)=0 from public.list_addresses('ammu-sammu')),'restaurant admin sees no customer addresses, even via RPC');
update public.customer_addresses set house='hijack' where id=current_setting('test.home')::uuid;
select set_config('request.jwt.claim.sub','34800000-0000-4000-8000-000000000001',true);
select public.test_assert((select count(*)=2 from public.customer_addresses where house<>'hijack'),'cross-user update/delete changed nothing');

-- Edits bump the version; identity cannot move to another customer.
update public.customer_addresses set house='14, Shivaji Nagar' where id=current_setting('test.home')::uuid;
select public.test_assert((select version=2 and updated_at>=created_at from public.customer_addresses where id=current_setting('test.home')::uuid),'edit bumps version');
do $$ begin
  begin update public.customer_addresses set customer_id='34800000-0000-4000-8000-000000000002'; raise exception 'owner change accepted'; exception when insufficient_privilege then null; end;
  begin update public.customer_addresses set version=1; raise exception 'version write accepted'; exception when insufficient_privilege then null; end;
end $$;

-- Saved-pin checkout: no fresh GPS needed; the phone fix only measures distance.
select set_config('test.near',jsonb_build_object('latitude',0.4,'longitude',0.4,'accuracy',20,'captured_at',clock_timestamp())::text,true);
select set_config('test.placed',public.test_addr_place('64800000-0000-4000-8000-000000000001',public.test_addr_delivery(current_setting('test.home')::uuid,2),current_setting('test.near')::jsonb)::text,true);
select public.test_assert(current_setting('test.placed')::jsonb->>'outcome'='placed','saved address order placed');
select public.test_assert((select address_label='home' and address_house='14, Shivaji Nagar' and address_street_area='Station Road, Khed' and address_landmark is null and address_location_source='pin'
  and saved_address_id=current_setting('test.home')::uuid and saved_address_version=2 and latitude=0.4 and longitude=0.4 and placed_from_distance_m=0
  and location_accuracy is null and location_captured_at is null and delivery_address_line='14, Shivaji Nagar, Station Road, Khed'
  from public.orders where id=(current_setting('test.placed')::jsonb->>'id')::uuid),'order stores the reviewed snapshot and phone distance');
-- Editing after placement changes neither the order nor a retry of the same request.
update public.customer_addresses set house='99, Changed' where id=current_setting('test.home')::uuid;
select public.test_assert(public.test_addr_place('64800000-0000-4000-8000-000000000001',public.test_addr_delivery(current_setting('test.home')::uuid,2),current_setting('test.near')::jsonb)=current_setting('test.placed')::jsonb,'retry after edit returns the original order');
select public.test_assert((select address_house='14, Shivaji Nagar' from public.orders where id=(current_setting('test.placed')::jsonb->>'id')::uuid),'later edits do not change past orders');
-- A checkout opened on the old version is refused; reloading picks up version 3.
do $$ begin
  begin perform public.test_addr_place('64800000-0000-4000-8000-000000000002',public.test_addr_delivery(current_setting('test.home')::uuid,2),null); raise exception 'stale version accepted'; exception when sqlstate 'PT412' then null; end;
end $$;
select public.test_assert((public.test_addr_place('64800000-0000-4000-8000-000000000003',public.test_addr_delivery(current_setting('test.home')::uuid,3),null)->>'outcome')='placed','current version places');
select public.test_assert((select placed_from_distance_m is null and address_house='99, Changed' from public.orders where idempotency_key='64800000-0000-4000-8000-000000000003'),'missing phone fix leaves distance unknown');
select public.test_assert((public.test_addr_place('64800000-0000-4000-8000-000000000004',public.test_addr_delivery(current_setting('test.home')::uuid,3),jsonb_build_object('latitude',0.4,'longitude',0.4,'captured_at',clock_timestamp()-interval '20 minutes'))->>'outcome')='placed','stale phone fix does not block');
select public.test_assert((select placed_from_distance_m is null from public.orders where idempotency_key='64800000-0000-4000-8000-000000000004'),'stale phone fix is unknown distance');
select public.test_assert((public.test_addr_place('64800000-0000-4000-8000-000000000005',public.test_addr_delivery(current_setting('test.home')::uuid,3),jsonb_build_object('latitude','bad','longitude',0.4,'captured_at','soon'))->>'outcome')='placed','malformed phone fix does not block');
select public.test_assert((public.test_addr_place('64800000-0000-4000-8000-000000000006',public.test_addr_delivery(current_setting('test.home')::uuid,3),jsonb_build_object('latitude',0.5,'longitude',0.5,'accuracy',30,'captured_at',clock_timestamp()))->>'outcome')='placed','remote phone still places');
select public.test_assert((select placed_from_distance_m between 15000 and 16500 from public.orders where idempotency_key='64800000-0000-4000-8000-000000000006'),'remote order records how far away the phone was');
select public.test_assert((public.test_addr_place('64800000-0000-4000-8000-000000000015',public.test_addr_delivery(current_setting('test.home')::uuid,3),jsonb_build_object('latitude',0.4,'longitude',0.4,'accuracy',50000,'captured_at',clock_timestamp()))->>'outcome')='placed','coarse phone fix does not block');
select public.test_assert((select placed_from_distance_m is null from public.orders where idempotency_key='64800000-0000-4000-8000-000000000015'),'a fix coarser than 150 m is unknown distance, not "near"');
-- The same key with a different address is a different request.
do $$ begin
  begin perform public.test_addr_place('64800000-0000-4000-8000-000000000003',public.test_addr_delivery(current_setting('test.away')::uuid,1),null); raise exception 'key reused with another address'; exception when invalid_parameter_value then null; end;
end $$;
-- Pricing rejections on the saved path create no order and replay as rejections.
reset role;
update public.menu_items set price_paise=price_paise+100 where id='20000000-0000-4000-8000-000000000001';
set role authenticated;
select set_config('request.jwt.claim.sub','34800000-0000-4000-8000-000000000001',true);
select set_config('test.stale_quote',(select jsonb_build_object('lines',jsonb_build_array(jsonb_build_object('menu_item_id',id,'quantity',1,'unit_price_paise',price_paise-100,'line_total_paise',price_paise-100)),'delivery_fee_paise',0,'min_order_paise',0,'subtotal_paise',price_paise-100,'total_paise',price_paise-100)::text from public.menu_items where id='20000000-0000-4000-8000-000000000001'),true);
select public.test_assert((public.place_order('ammu-sammu','[{"menu_item_id":"20000000-0000-4000-8000-000000000001","quantity":1}]',public.test_addr_delivery(current_setting('test.home')::uuid,3),null,'64800000-0000-4000-8000-000000000016',current_setting('test.stale_quote')::jsonb)->>'outcome')='pricing_changed','saved-path price change places nothing');
select public.test_assert(not exists(select 1 from public.orders where idempotency_key='64800000-0000-4000-8000-000000000016'),'no order for a rejected quote');
reset role;
update public.menu_items set price_paise=price_paise-100 where id='20000000-0000-4000-8000-000000000001';
set role authenticated;
select set_config('request.jwt.claim.sub','34800000-0000-4000-8000-000000000001',true);
-- Holes in the area are outside; its edge is inside.
reset role;
do $$ declare ns text; begin
  select n.nspname into strict ns from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='postgis';
  execute format('update public.businesses set service_area=%1$I.st_geomfromtext(''MULTIPOLYGON(((0 0,1 0,1 1,0 1,0 0),(0.35 0.35,0.45 0.35,0.45 0.45,0.35 0.45,0.35 0.35)))'',4326) where slug=''ammu-sammu''',ns);
end $$;
set role authenticated;
select set_config('request.jwt.claim.sub','34800000-0000-4000-8000-000000000001',true);
select public.test_assert((select not in_area from public.list_addresses('ammu-sammu') where id=current_setting('test.home')::uuid),'address inside a hole is out of area');
do $$ begin
  begin perform public.test_addr_place('64800000-0000-4000-8000-000000000017',public.test_addr_delivery(current_setting('test.home')::uuid,3),null); raise exception 'address in a hole accepted'; exception when invalid_parameter_value then null; end;
end $$;
insert into public.customer_addresses(label,house,street_area,latitude,longitude,location_source) values ('work','Edge','Boundary Road',0,0.5,'pin');
select public.test_assert((select in_area from public.list_addresses('ammu-sammu') where house='Edge'),'address on the area edge is in area');
select public.test_assert((public.test_addr_place('64800000-0000-4000-8000-000000000018',public.test_addr_delivery((select id from public.customer_addresses where house='Edge'),1),null)->>'outcome')='placed','address on the edge places');
delete from public.customer_addresses where house='Edge';
-- Closed restaurants and unverified areas refuse saved-address orders too.
reset role;
update public.businesses set accepting_orders=false where slug='ammu-sammu';
set role authenticated;
select set_config('request.jwt.claim.sub','34800000-0000-4000-8000-000000000001',true);
do $$ begin
  begin perform public.test_addr_place('64800000-0000-4000-8000-000000000019',public.test_addr_delivery(current_setting('test.away')::uuid,1),null); raise exception 'closed restaurant accepted'; exception when sqlstate 'PT409' then null; end;
end $$;
reset role;
do $$ declare ns text; begin
  select n.nspname into strict ns from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='postgis';
  execute format('update public.businesses set accepting_orders=true,service_area=%1$I.st_geomfromtext(''MULTIPOLYGON(((0 0,1 0,1 1,0 1,0 0)))'',4326),service_area_verified_at=null,ordering_enabled=false where slug=''ammu-sammu''',ns);
end $$;
set role authenticated;
select set_config('request.jwt.claim.sub','34800000-0000-4000-8000-000000000001',true);
select public.test_assert((select bool_and(not in_area) from public.list_addresses('ammu-sammu')),'unverified area: nothing is in area');
do $$ begin
  begin perform public.test_addr_place('64800000-0000-4000-8000-000000000020',public.test_addr_delivery(current_setting('test.home')::uuid,3),null); raise exception 'unverified area accepted'; exception when invalid_parameter_value then null; end;
end $$;
reset role;
update public.businesses set service_area_verified_at=now(),ordering_enabled=true where slug='ammu-sammu';
set role authenticated;
select set_config('request.jwt.claim.sub','34800000-0000-4000-8000-000000000001',true);
-- The server stays authoritative: outside the area, other people's addresses, malformed requests.
do $$ begin
  begin perform public.test_addr_place('64800000-0000-4000-8000-000000000007',public.test_addr_delivery(current_setting('test.away')::uuid,1),null); raise exception 'outside address accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.test_addr_place('64800000-0000-4000-8000-000000000008',public.test_addr_delivery(current_setting('test.home')::uuid,3)||'{"address_line":"typed"}',null); raise exception 'mixed address accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.test_addr_place('64800000-0000-4000-8000-000000000009',jsonb_build_object('name','A','phone','1','address_id',current_setting('test.home'),'address_version','x'),null); raise exception 'bad version accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.test_addr_place('64800000-0000-4000-8000-000000000010',jsonb_build_object('name','A','phone','1','address_id','not-a-uuid','address_version',1),null); raise exception 'bad id accepted'; exception when invalid_parameter_value then null; end;
end $$;
select set_config('request.jwt.claim.sub','34800000-0000-4000-8000-000000000002',true);
do $$ begin
  begin perform public.test_addr_place('64800000-0000-4000-8000-000000000011',public.test_addr_delivery(current_setting('test.home')::uuid,3),null); raise exception 'another customer used the address'; exception when sqlstate 'PT412' then null; end;
end $$;
-- Owners see the order's copy, never the saved address itself.
select set_config('request.jwt.claim.sub','34800000-0000-4000-8000-000000000003',true);
select public.test_assert((select address_house='14, Shivaji Nagar' from public.orders where id=(current_setting('test.placed')::jsonb->>'id')::uuid),'owner sees the order snapshot');
-- Deleting keeps past orders and their retries; new orders with it are refused.
select set_config('request.jwt.claim.sub','34800000-0000-4000-8000-000000000001',true);
delete from public.customer_addresses where id=current_setting('test.home')::uuid;
select public.test_assert(public.test_addr_place('64800000-0000-4000-8000-000000000001',public.test_addr_delivery(current_setting('test.home')::uuid,2),current_setting('test.near')::jsonb)=current_setting('test.placed')::jsonb,'retry after delete returns the original order');
select public.test_assert((select count(*)=1 from public.orders where saved_address_id=current_setting('test.home')::uuid and address_house='14, Shivaji Nagar'),'deleted address keeps its order copy');
select public.test_assert((public.place_order('ammu-sammu','[{"menu_item_id":"20000000-0000-4000-8000-000000000001","quantity":1}]',public.test_addr_delivery(current_setting('test.home')::uuid,3),null,'64800000-0000-4000-8000-000000000016',current_setting('test.stale_quote')::jsonb)->>'outcome')='pricing_changed','rejected quote replays as a rejection after the address is deleted');
do $$ begin
  begin perform public.test_addr_place('64800000-0000-4000-8000-000000000012',public.test_addr_delivery(current_setting('test.home')::uuid,3),null); raise exception 'deleted address accepted'; exception when sqlstate 'PT412' then null; end;
end $$;
-- The previous typed-address + fresh-GPS checkout still works until the apps move over.
select public.test_assert((public.test_addr_place('64800000-0000-4000-8000-000000000013','{"name":"Legacy","phone":"123","address_line":"Typed address"}',jsonb_build_object('latitude',0.5,'longitude',0.5,'accuracy',10,'captured_at',clock_timestamp()))->>'outcome')='placed','legacy checkout still places');
select public.test_assert((select saved_address_id is null and location_accuracy=10 from public.orders where idempotency_key='64800000-0000-4000-8000-000000000013'),'legacy order keeps GPS evidence');
do $$ begin
  begin perform public.test_addr_place('64800000-0000-4000-8000-000000000014','{"name":"Legacy","phone":"123","address_line":"Typed address"}',null); raise exception 'legacy without GPS accepted'; exception when invalid_parameter_value then null; end;
end $$;
-- At most 20 saved addresses per customer.
insert into public.customer_addresses(label,house,street_area,latitude,longitude,location_source) select 'other','House '||n,'Street',0.3,0.3,'pin' from generate_series(1,19) n;
do $$ begin
  begin insert into public.customer_addresses(label,house,street_area,latitude,longitude,location_source) values ('other','One too many','Street',0.3,0.3,'pin'); raise exception '21st address accepted'; exception when check_violation then null; end;
end $$;
reset role;
-- A saved-address order without a complete snapshot cannot be written, even by trusted code.
do $$ begin
  begin
    insert into public.orders(business_id,customer_id,customer_name,customer_phone,delivery_address_line,latitude,longitude,saved_address_id,saved_address_version,subtotal_paise,delivery_fee_paise,total_paise,idempotency_key,request_hash)
    values ('10000000-0000-4000-8000-000000000001','34800000-0000-4000-8000-000000000001','X','1','X',0.4,0.4,gen_random_uuid(),1,1,0,1,gen_random_uuid(),'test');
    raise exception 'incomplete snapshot accepted';
  exception when check_violation then null; end;
end $$;
rollback;
