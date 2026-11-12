\set ON_ERROR_STOP on
create function public.test_assert(ok boolean, message text) returns void language plpgsql as $$ begin if ok is distinct from true then raise exception 'assertion failed: %', message; end if; end $$;
grant execute on function public.test_assert(boolean,text) to anon, authenticated;
insert into auth.users(id) values
('30000000-0000-4000-8000-000000000001'),('30000000-0000-4000-8000-000000000002'),
('30000000-0000-4000-8000-000000000003'),('30000000-0000-4000-8000-000000000004'),
('30000000-0000-4000-8000-000000000005');
insert into public.business_memberships(business_id,user_id,role) values
('10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000003','admin'),
('10000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000004','admin');
insert into public.orders(id,business_id,customer_id,customer_name,customer_phone,delivery_address_line,latitude,longitude,location_accuracy,location_captured_at,subtotal_paise,delivery_fee_paise,total_paise,idempotency_key,request_hash) values
('40000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','Customer A','0','A',17,73,10,now(),15000,0,15000,'50000000-0000-4000-8000-000000000001','hash-a'),
('40000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000002','Customer B','0','B',17,73,10,now(),18000,0,18000,'50000000-0000-4000-8000-000000000002','hash-b');
insert into public.order_items(order_id,name,unit_price_paise,quantity,line_total_paise) select id,'Snapshot',100,1,100 from public.orders;
insert into public.order_status_history(order_id,status) select id,'placed' from public.orders;
select public.test_assert((select count(*) = 3 from pg_publication_tables where pubname='supabase_realtime'), 'realtime tables');
select public.test_assert(not has_function_privilege('anon','public.is_business_admin(uuid)','execute') and not has_function_privilege('anon','public.can_view_order(uuid)','execute'), 'no anon helper execution despite default grants');
select public.test_assert(has_function_privilege('authenticated','public.is_business_admin(uuid)','execute') and has_function_privilege('authenticated','public.can_view_order(uuid)','execute'), 'authenticated helper execution');
select public.test_assert(not has_function_privilege('anon','public.prevent_menu_business_change()','execute') and not has_function_privilege('authenticated','public.prevent_menu_business_change()','execute'), 'no client trigger execution despite default grants');
select public.test_assert(not has_table_privilege('anon','public.orders','select'), 'anon cannot read orders');
select public.test_assert(not has_table_privilege('authenticated','public.orders','insert') and not has_table_privilege('authenticated','public.orders','update') and not has_table_privilege('authenticated','public.orders','delete') and not has_table_privilege('authenticated','public.order_items','insert') and not has_table_privilege('authenticated','public.order_status_history','insert'), 'no direct order writes');
select public.test_assert(not has_table_privilege('authenticated','public.business_memberships','insert') and not has_table_privilege('authenticated','public.business_memberships','update') and not has_table_privilege('authenticated','public.business_memberships','delete'), 'no membership writes');
select public.test_assert(not has_table_privilege('authenticated','public.order_items','update') and not has_table_privilege('authenticated','public.order_items','delete') and not has_table_privilege('authenticated','public.order_status_history','update') and not has_table_privilege('authenticated','public.order_status_history','delete'), 'no snapshot or history writes');
set role anon;
select public.test_assert((select count(*) = 2 from public.businesses) and (select count(*) = 2 from public.menu_items), 'public catalog');
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000001',false);
select public.test_assert((select count(*) = 1 from public.orders) and (select count(*) = 1 from public.order_items) and (select count(*) = 1 from public.order_status_history), 'customer A visibility');
select public.test_assert(not public.is_business_admin('10000000-0000-4000-8000-000000000001'), 'customer not admin');
insert into public.device_tokens(user_id,business_id,audience,token) values ('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','customer','device-a');
do $$ begin
  begin insert into public.device_tokens(user_id,business_id,audience,token) values ('30000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','customer','stolen'); raise exception 'cross-user device accepted'; exception when insufficient_privilege then null; end;
  begin insert into public.device_tokens(user_id,business_id,audience,token) values ('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','admin','escalated'); raise exception 'admin device accepted'; exception when insufficient_privilege then null; end;
  begin insert into public.business_memberships values ('10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','admin',now()); raise exception 'self admin accepted'; exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000002',false);
select public.test_assert((select count(*) = 1 from public.orders) and (select count(*) = 1 from public.order_items) and (select count(*) = 1 from public.order_status_history) and (select count(*) = 0 from public.device_tokens), 'customer B isolation');
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000003',false);
select public.test_assert((select count(*) = 1 from public.orders) and (select count(*) = 1 from public.order_items), 'admin A visibility');
update public.menu_items set name = 'Changed' where id='20000000-0000-4000-8000-000000000001';
update public.menu_items set name = 'Cross tenant' where id='20000000-0000-4000-8000-000000000002';
select public.test_assert((select name = 'Demo meal' from public.menu_items where id='20000000-0000-4000-8000-000000000002'), 'cross tenant menu update denied');
do $$ begin
  begin insert into public.menu_items(business_id,name,category,price_paise) values ('10000000-0000-4000-8000-000000000002','Forbidden','x',100); raise exception 'cross tenant insert accepted'; exception when insufficient_privilege then null; end;
  begin update public.menu_items set business_id='10000000-0000-4000-8000-000000000002' where id='20000000-0000-4000-8000-000000000001'; raise exception 'tenant move accepted'; exception when raise_exception then if sqlerrm = 'tenant move accepted' then raise; end if; end;
end $$;
-- An administrator of both tenants still cannot transfer a menu item.
reset role;
insert into public.business_memberships(business_id,user_id,role) values ('10000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000003','admin');
set role authenticated;
do $$ begin
  begin update public.menu_items set business_id='10000000-0000-4000-8000-000000000002' where id='20000000-0000-4000-8000-000000000001'; raise exception 'dual-admin transfer accepted'; exception when raise_exception then if sqlerrm = 'dual-admin transfer accepted' then raise; end if; end;
end $$;
reset role;
delete from public.business_memberships where business_id='10000000-0000-4000-8000-000000000002' and user_id='30000000-0000-4000-8000-000000000003';
set role authenticated;
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000004',false);
select public.test_assert((select count(*) = 1 from public.orders) and (select count(*) = 1 from public.order_status_history), 'admin B visibility');
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000005',false);
select public.test_assert((select count(*) = 0 from public.orders), 'former admin sees no orders');
reset role;
insert into public.business_memberships(business_id,user_id,role) values ('10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000005','admin');
delete from public.business_memberships where user_id='30000000-0000-4000-8000-000000000005';
set role authenticated;
select public.test_assert((select count(*) = 0 from public.orders) and not public.is_business_admin('10000000-0000-4000-8000-000000000001'), 'revoked admin');
update public.menu_items set name='Revoked' where id='20000000-0000-4000-8000-000000000001';
select public.test_assert((select name='Changed' from public.menu_items where id='20000000-0000-4000-8000-000000000001'), 'revoked admin cannot edit');
reset role;
select public.test_assert((select bool_and(not ordering_enabled and service_area is null and service_area_verified_at is null) from public.businesses), 'no unverified ordering');
do $$ begin
  begin update public.businesses set ordering_enabled=true where slug='ammu-sammu'; raise exception 'unverified ordering accepted'; exception when check_violation then null; end;
end $$;

-- A polygon must be valid and independently attributed before ordering can be enabled.
do $$
declare ns text;
begin
  select n.nspname into strict ns from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='postgis';
  begin
    execute format($q$update public.businesses set service_area=%I.st_geomfromtext('MULTIPOLYGON(((0 0,1 1,1 0,0 1,0 0)))',4326) where slug='ammu-sammu'$q$, ns);
    raise exception 'invalid polygon accepted';
  exception when check_violation then null; end;
  execute format($q$update public.businesses set service_area=%I.st_geomfromtext('MULTIPOLYGON(((0 0,1 0,1 1,0 1,0 0)))',4326), service_area_source='test fixture', service_area_version='test', service_area_verified_at=now(), ordering_enabled=true where slug='ammu-sammu'$q$, ns);
end $$;
select public.test_assert((select ordering_enabled from public.businesses where slug='ammu-sammu'), 'verified fixture polygon permits ordering');
