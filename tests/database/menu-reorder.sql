\set ON_ERROR_STOP on
-- Atomic dish and category reordering (#102).
begin;
create or replace function public.test_assert(ok boolean, message text) returns void language plpgsql as $$ begin if not coalesce(ok,false) then raise exception 'assertion failed: %', message; end if; end $$;
grant execute on function public.test_assert(boolean,text) to anon, authenticated;
select public.test_assert(not has_function_privilege('anon','public.reorder_menu_items(text,uuid,uuid[])','execute') and not has_function_privilege('anon','public.reorder_menu_categories(text,uuid[])','execute'), 'reorder is unavailable to anon');
select public.test_assert(exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='menu_categories'), 'customer menus hear category changes');
insert into auth.users(id) values ('41020000-0000-4000-8000-000000000001'),('41020000-0000-4000-8000-000000000002'),('41020000-0000-4000-8000-000000000003');
insert into public.business_memberships(business_id,user_id,role) values
  ('10000000-0000-4000-8000-000000000001','41020000-0000-4000-8000-000000000001','admin'),
  ('10000000-0000-4000-8000-000000000002','41020000-0000-4000-8000-000000000002','admin');
insert into public.menu_categories(id,business_id,name,sort_order) values
  ('41020000-0000-4000-8000-0000000000c1','10000000-0000-4000-8000-000000000001','Reorder thalis',5),
  ('41020000-0000-4000-8000-0000000000c2','10000000-0000-4000-8000-000000000001','Reorder snacks',5);
insert into public.menu_items(id,business_id,name,category_id,price_paise,diet,sort_order) values
  ('41020000-0000-4000-8000-0000000000d1','10000000-0000-4000-8000-000000000001','Fish thali','41020000-0000-4000-8000-0000000000c1',32000,'non_veg',0),
  ('41020000-0000-4000-8000-0000000000d2','10000000-0000-4000-8000-000000000001','Veg thali','41020000-0000-4000-8000-0000000000c1',18000,'veg',0),
  ('41020000-0000-4000-8000-0000000000d3','10000000-0000-4000-8000-000000000001','Chicken thali','41020000-0000-4000-8000-0000000000c1',26000,'non_veg',0),
  ('41020000-0000-4000-8000-0000000000d4','10000000-0000-4000-8000-000000000001','Misal pav','41020000-0000-4000-8000-0000000000c2',9000,'veg',0);
create temporary table reorder_ids as select array(select id from public.menu_categories where business_id='10000000-0000-4000-8000-000000000001' order by sort_order, name, id) as ammu_categories;
grant select on reorder_ids to authenticated;

set role authenticated;
select set_config('request.jwt.claim.sub','41020000-0000-4000-8000-000000000001',true);
select public.test_assert(public.reorder_menu_items('ammu-sammu','41020000-0000-4000-8000-0000000000c1',array['41020000-0000-4000-8000-0000000000d3','41020000-0000-4000-8000-0000000000d1','41020000-0000-4000-8000-0000000000d2']::uuid[]) = 3, 'owner reorders dishes');
select public.test_assert((select string_agg(name, ',' order by sort_order, name, id) from public.menu_items where category_id='41020000-0000-4000-8000-0000000000c1') = 'Chicken thali,Fish thali,Veg thali', 'dish order persists');
do $$ begin
  begin perform public.reorder_menu_items('ammu-sammu','41020000-0000-4000-8000-0000000000c1',array['41020000-0000-4000-8000-0000000000d1','41020000-0000-4000-8000-0000000000d2']::uuid[]); raise exception 'missing dish accepted'; exception when serialization_failure then null; end;
  begin perform public.reorder_menu_items('ammu-sammu','41020000-0000-4000-8000-0000000000c1',array['41020000-0000-4000-8000-0000000000d1','41020000-0000-4000-8000-0000000000d2','41020000-0000-4000-8000-0000000000d3','41020000-0000-4000-8000-0000000000d4']::uuid[]); raise exception 'dish from another category accepted'; exception when serialization_failure then null; end;
  begin perform public.reorder_menu_items('ammu-sammu','41020000-0000-4000-8000-0000000000c1',array['41020000-0000-4000-8000-0000000000d1','41020000-0000-4000-8000-0000000000d1','41020000-0000-4000-8000-0000000000d2']::uuid[]); raise exception 'duplicate dish accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.reorder_menu_items('ammu-sammu','41020000-0000-4000-8000-0000000000c1',array['41020000-0000-4000-8000-0000000000d1',null,'41020000-0000-4000-8000-0000000000d2']::uuid[]); raise exception 'null dish accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.reorder_menu_items('ammu-sammu','41020000-0000-4000-8000-0000000000c1',null); raise exception 'null list accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.reorder_menu_items('ammu-sammu','41029999-0000-4000-8000-0000000000c1','{}'); raise exception 'unknown category accepted'; exception when serialization_failure then null; end;
  begin perform public.reorder_menu_items('kokani-dine-inn','41020000-0000-4000-8000-0000000000c1',array['41020000-0000-4000-8000-0000000000d1','41020000-0000-4000-8000-0000000000d2','41020000-0000-4000-8000-0000000000d3']::uuid[]); raise exception 'non-owner reordered another restaurant'; exception when insufficient_privilege then null; end;
end $$;
select public.test_assert((select string_agg(name, ',' order by sort_order, name, id) from public.menu_items where category_id='41020000-0000-4000-8000-0000000000c1') = 'Chicken thali,Fish thali,Veg thali', 'rejected reorders write nothing');
select public.test_assert(public.reorder_menu_categories('ammu-sammu',(select array(select x from unnest(ammu_categories) with ordinality u(x,n) order by n desc) from reorder_ids)) >= 3, 'owner reorders categories');
select public.test_assert((select array_agg(id order by sort_order, name, id) from public.menu_categories where business_id='10000000-0000-4000-8000-000000000001') = (select array(select x from unnest(ammu_categories) with ordinality u(x,n) order by n desc) from reorder_ids), 'category order persists in full');
select public.test_assert((select min(sort_order) = 0 and max(sort_order) = count(*) - 1 from public.menu_categories where business_id='10000000-0000-4000-8000-000000000001'), 'categories get distinct positions');
do $$ begin
  begin perform public.reorder_menu_categories('ammu-sammu',array['41020000-0000-4000-8000-0000000000c1']::uuid[]); raise exception 'partial category list accepted'; exception when serialization_failure then null; end;
end $$;

-- Other restaurant's owner, customer and anon cannot reorder.
select set_config('request.jwt.claim.sub','41020000-0000-4000-8000-000000000002',true);
do $$ begin
  begin perform public.reorder_menu_items('ammu-sammu','41020000-0000-4000-8000-0000000000c1',array['41020000-0000-4000-8000-0000000000d1','41020000-0000-4000-8000-0000000000d2','41020000-0000-4000-8000-0000000000d3']::uuid[]); raise exception 'other owner reordered dishes'; exception when insufficient_privilege then null; end;
  begin perform public.reorder_menu_categories('ammu-sammu','{}'); raise exception 'other owner reordered categories'; exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','41020000-0000-4000-8000-000000000003',true);
do $$ begin
  begin perform public.reorder_menu_items('ammu-sammu','41020000-0000-4000-8000-0000000000c1',array['41020000-0000-4000-8000-0000000000d1','41020000-0000-4000-8000-0000000000d2','41020000-0000-4000-8000-0000000000d3']::uuid[]); raise exception 'customer reordered dishes'; exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','',true);
do $$ begin
  begin perform public.reorder_menu_categories('ammu-sammu','{}'); raise exception 'signed-out reorder accepted'; exception when insufficient_privilege then null; end;
end $$;

-- A partial availability update leaves every other dish field untouched.
select set_config('request.jwt.claim.sub','41020000-0000-4000-8000-000000000001',true);
update public.menu_items set available=false where id='41020000-0000-4000-8000-0000000000d2';
select public.test_assert((select not available and name='Veg thali' and price_paise=18000 and sort_order=2 from public.menu_items where id='41020000-0000-4000-8000-0000000000d2'), 'availability switch changes only availability');
reset role;
rollback;
