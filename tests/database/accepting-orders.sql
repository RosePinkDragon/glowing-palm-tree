\set ON_ERROR_STOP on
-- #58: owners open or close their restaurant for new orders. Runs after checkout.sql,
-- which leaves Ammu Sammu with a verified test polygon and ordering_enabled.
-- Earlier suites revoke memberships, so restore one owner per restaurant.
insert into public.business_memberships(business_id,user_id,role) values
('10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000003','admin'),
('10000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000004','admin')
on conflict do nothing;
select public.test_assert((select bool_and(not accepting_orders) from public.businesses), 'restaurants start closed');
select public.test_assert(exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='businesses'), 'businesses published for live open/closed');
select public.test_assert(not has_function_privilege('anon','public.set_accepting_orders(text,boolean)','execute'), 'anon cannot change the switch despite default grants');
select public.test_assert(not has_table_privilege('authenticated','public.businesses','update') and not has_table_privilege('anon','public.businesses','update'), 'no direct business updates');
select public.test_assert(not has_table_privilege('anon','public.accepting_orders_changes','select') and not has_table_privilege('authenticated','public.accepting_orders_changes','insert') and not has_table_privilege('authenticated','public.accepting_orders_changes','update') and not has_table_privilege('authenticated','public.accepting_orders_changes','delete'), 'change log is read-only and hidden from anon');
select set_config('test.fix',jsonb_build_object('latitude',0.5,'longitude',0.5,'accuracy',10,'captured_at',clock_timestamp())::text,false);
select set_config('test.items','[{"menu_item_id":"20000000-0000-4000-8000-000000000001","quantity":1}]',false);
select set_config('test.delivery','{"name":"Closed Test","phone":"123","address_line":"Test address"}',false);
set role anon;
select public.test_assert((select count(*)=2 from public.businesses where accepting_orders is not null), 'guests can read open/closed');
reset role;

set role authenticated;
-- A customer and another restaurant's owner cannot change the switch.
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000001',false);
do $$ begin
  begin perform public.set_accepting_orders('ammu-sammu',true); raise exception 'customer opened restaurant'; exception when insufficient_privilege then null; end;
  begin perform public.place_order('ammu-sammu',current_setting('test.items')::jsonb,current_setting('test.delivery')::jsonb,current_setting('test.fix')::jsonb,'60000000-0000-4000-8000-000000000581'); raise exception 'order accepted while closed'; exception when sqlstate 'PT409' then null; end;
end $$;
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000004',false);
do $$ begin
  begin perform public.set_accepting_orders('ammu-sammu',true); raise exception 'other owner opened restaurant'; exception when insufficient_privilege then null; end;
  begin perform public.set_accepting_orders('missing',true); raise exception 'unknown business accepted'; exception when insufficient_privilege then null; end;
end $$;

-- The restaurant's own owner opens it; only that owner's restaurant changes.
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000003',false);
do $$ begin
  begin perform public.set_accepting_orders('ammu-sammu',null); raise exception 'null accepted'; exception when invalid_parameter_value then null; end;
end $$;
select public.test_assert((public.set_accepting_orders('ammu-sammu',true)->>'accepting_orders')::boolean, 'owner opens restaurant');
select public.test_assert((select accepting_orders from public.businesses where slug='ammu-sammu') and not (select accepting_orders from public.businesses where slug='konkan-fine-dine'), 'only own restaurant opened');
select public.set_accepting_orders('ammu-sammu',true);
select public.test_assert((select count(*)=1 from public.accepting_orders_changes where accepting_orders and changed_by='30000000-0000-4000-8000-000000000003'), 'one change logged with owner; repeat is a no-op');
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000004',false);
select public.test_assert((select count(*)=0 from public.accepting_orders_changes), 'other owner cannot see change log');
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000001',false);
select public.test_assert((select count(*)=0 from public.accepting_orders_changes), 'customer cannot see change log');

-- Open: a customer orders. Closed: retries still return that order, new orders are refused.
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000001',false);
select set_config('test.open_order',public.place_order('ammu-sammu',current_setting('test.items')::jsonb,current_setting('test.delivery')::jsonb,current_setting('test.fix')::jsonb,'60000000-0000-4000-8000-000000000582')->>'id',false);
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000003',false);
select public.test_assert(not (public.set_accepting_orders('ammu-sammu',false)->>'accepting_orders')::boolean, 'owner closes restaurant');
select public.test_assert((select count(*)=2 from public.accepting_orders_changes), 'owner sees both changes');
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000001',false);
select public.test_assert(public.place_order('ammu-sammu',current_setting('test.items')::jsonb,current_setting('test.delivery')::jsonb,current_setting('test.fix')::jsonb,'60000000-0000-4000-8000-000000000582')->>'id'=current_setting('test.open_order'), 'retry after closing returns the existing order');
do $$ begin
  begin perform public.place_order('ammu-sammu',current_setting('test.items')::jsonb,current_setting('test.delivery')::jsonb,current_setting('test.fix')::jsonb,'60000000-0000-4000-8000-000000000583'); raise exception 'new order accepted after closing'; exception when sqlstate 'PT409' then null; end;
end $$;
-- Orders placed before closing carry on through every status.
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000003',false);
select public.test_assert(public.transition_order(current_setting('test.open_order')::uuid,'accepted',1)->>'status'='accepted', 'earlier order continues while closed');
reset role;
select public.test_assert((select count(*)=1 from public.orders where idempotency_key in ('60000000-0000-4000-8000-000000000581','60000000-0000-4000-8000-000000000582','60000000-0000-4000-8000-000000000583')), 'only the open-time order exists');

-- Removing an owner keeps the log entry without their identity link.
insert into auth.users(id) values ('30000000-0000-4000-8000-000000000058');
insert into public.business_memberships(business_id,user_id,role) values ('10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000058','admin');
set role authenticated;
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000058',false);
select public.set_accepting_orders('ammu-sammu',true);
reset role;
delete from auth.users where id='30000000-0000-4000-8000-000000000058';
select public.test_assert((select count(*)=1 from public.accepting_orders_changes where accepting_orders and changed_by is null), 'deleted owner change kept anonymously');
