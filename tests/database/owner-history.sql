\set ON_ERROR_STOP on
create or replace function public.test_assert(ok boolean, message text) returns void language plpgsql as $$ begin if ok is distinct from true then raise exception 'assertion failed: %', message; end if; end $$;
grant execute on function public.test_assert(boolean,text) to anon, authenticated;
-- Isolated fixtures work after an upgrade or a fresh all-migrations installation.
insert into auth.users(id) values
('39800000-0000-4000-8000-000000000001'), -- customer
('39800000-0000-4000-8000-000000000002'), -- acting owner A
('39800000-0000-4000-8000-000000000003'), -- remaining owner A
('39800000-0000-4000-8000-000000000004'); -- owner B
insert into public.business_memberships(business_id,user_id,role,display_name) values
('10000000-0000-4000-8000-000000000001','39800000-0000-4000-8000-000000000002','admin','Asha'),
('10000000-0000-4000-8000-000000000001','39800000-0000-4000-8000-000000000003','admin','Other owner'),
('10000000-0000-4000-8000-000000000002','39800000-0000-4000-8000-000000000004','admin','Other restaurant');
insert into public.orders(id,business_id,customer_id,customer_name,customer_phone,delivery_address_line,latitude,longitude,location_accuracy,location_captured_at,subtotal_paise,delivery_fee_paise,total_paise,idempotency_key,request_hash) values
('49800000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','39800000-0000-4000-8000-000000000001','Customer','0','Test',17,73,10,now(),100,0,100,'59800000-0000-4000-8000-000000000001','history'),
('49800000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','39800000-0000-4000-8000-000000000002','Owner customer','0','Test',17,73,10,now(),100,0,100,'59800000-0000-4000-8000-000000000002','history');
insert into public.order_status_history(order_id,status,changed_by) values
('49800000-0000-4000-8000-000000000001','placed','39800000-0000-4000-8000-000000000001'),
('49800000-0000-4000-8000-000000000002','placed','39800000-0000-4000-8000-000000000002');
select public.test_assert(not exists (select 1 from public.order_history_actors),'placed steps never snapshot an owner, including owner-customers');
select public.test_assert(not has_column_privilege('authenticated','public.order_status_history','changed_by','select'),'actor UUID is not customer-readable');
select public.test_assert(not has_table_privilege('authenticated','public.order_history_actors','insert') and not has_table_privilege('authenticated','public.order_history_actors','update') and not has_table_privilege('authenticated','public.order_history_actors','delete'),'no direct actor writes');
select public.test_assert(not has_function_privilege('authenticated','public.redact_owner_history(uuid)','execute') and not has_function_privilege('anon','public.redact_owner_history(uuid)','execute'),'redaction is trusted only');
select public.test_assert(not has_schema_privilege('authenticated','owner_history_private','usage') and not has_function_privilege('authenticated','owner_history_private.capture_actor()','execute') and not has_function_privilege('authenticated','owner_history_private.redact_identity(uuid)','execute'),'capture function is private');
select public.test_assert(not exists (select 1 from pg_publication_tables where schemaname='public' and tablename in ('order_status_history','order_history_actors')),'actor data absent from realtime publications');
create view public.owner_history_test_view with (security_invoker=true) as select * from public.order_history_actors;
grant select on public.owner_history_test_view to authenticated;

set role authenticated;
select set_config('request.jwt.claim.sub','39800000-0000-4000-8000-000000000002',false);
select public.test_assert((public.transition_order('49800000-0000-4000-8000-000000000001','accepted',1)->>'version')::integer=2,'owner accepts with version check');
select public.test_assert((select count(*)=1 and min(actor_name)='Asha' from public.order_history_actors),'owner sees snapshot');
do $$ begin
  begin perform public.transition_order('49800000-0000-4000-8000-000000000001','preparing',1); raise exception 'stale version accepted'; exception when serialization_failure then null; end;
  begin perform public.transition_order('49800000-0000-4000-8000-000000000001','delivered',2); raise exception 'invalid status accepted'; exception when invalid_parameter_value then null; end;
  begin update public.business_memberships set display_name='Impersonated'; raise exception 'client renamed membership'; exception when insufficient_privilege then null; end;
  begin perform public.redact_owner_history('39800000-0000-4000-8000-000000000002'); raise exception 'client redacted history'; exception when insufficient_privilege then null; end;
end $$;
reset role;
update public.business_memberships set display_name='Asha renamed' where user_id='39800000-0000-4000-8000-000000000002';
set role authenticated;
select public.test_assert((public.transition_order('49800000-0000-4000-8000-000000000001','preparing',2)->>'version')::integer=3,'renamed owner transitions');
select public.test_assert((select array_agg(actor_name order by history_id)=array['Asha','Asha renamed'] from public.order_history_actors),'earlier name is immutable after rename');
select set_config('request.jwt.claim.sub','39800000-0000-4000-8000-000000000001',false);
select public.test_assert((select count(*)=3 from public.order_status_history where order_id='49800000-0000-4000-8000-000000000001'),'customer retains safe timeline');
select public.test_assert((select count(*)=0 from public.order_history_actors) and (select count(*)=0 from public.owner_history_test_view),'customer direct and view reads cannot see names');
do $$ begin
  begin perform changed_by from public.order_status_history; raise exception 'customer read actor UUID'; exception when insufficient_privilege then null; end;
  begin perform public.transition_order('49800000-0000-4000-8000-000000000001','out_for_delivery',3); raise exception 'customer transitioned order'; exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','39800000-0000-4000-8000-000000000004',false);
select public.test_assert((select count(*)=0 from public.order_history_actors) and (select count(*)=0 from public.owner_history_test_view),'other-restaurant owner cannot see names');
do $$ begin
  begin perform public.transition_order('49800000-0000-4000-8000-000000000001','out_for_delivery',3); raise exception 'cross-tenant owner transitioned'; exception when insufficient_privilege then null; end;
end $$;
reset role;
set role service_role;
do $$ begin
  begin perform public.redact_owner_history('39800000-0000-4000-8000-000000000002'); raise exception 'active owner redacted'; exception when invalid_parameter_value then null; end;
end $$;
reset role;
delete from public.business_memberships where user_id='39800000-0000-4000-8000-000000000002';
set role authenticated;
select set_config('request.jwt.claim.sub','39800000-0000-4000-8000-000000000002',false);
select public.test_assert((select count(*)=0 from public.order_history_actors),'removed owner loses actor access even to own customer order');
do $$ begin
  begin perform public.transition_order('49800000-0000-4000-8000-000000000001','out_for_delivery',3); raise exception 'removed owner transitioned'; exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','39800000-0000-4000-8000-000000000003',false);
select public.test_assert((select array_agg(actor_name order by history_id)=array['Asha','Asha renamed'] from public.order_history_actors),'names survive membership removal');
select public.test_assert((select count(*)=2 from public.owner_history_test_view),'authorized invoker view preserves owner access');
reset role;
set role service_role;
select public.redact_owner_history('39800000-0000-4000-8000-000000000002');
select public.redact_owner_history('39800000-0000-4000-8000-000000000002');
reset role;
select public.test_assert((select count(*)=2 and bool_and(actor_name='Former owner' and actor_user_id is null) from public.order_history_actors),'redaction replaces names and clears actor IDs');
select public.test_assert(not exists (select 1 from public.order_status_history where changed_by='39800000-0000-4000-8000-000000000002'),'redaction clears legacy actor identity');
-- Remove the separate owner-customer test order; full customer deletion is #51.
delete from public.orders where id='49800000-0000-4000-8000-000000000002';
delete from auth.users where id='39800000-0000-4000-8000-000000000002';
set role authenticated;
select set_config('request.jwt.claim.sub','39800000-0000-4000-8000-000000000003',false);
select public.test_assert((public.transition_order('49800000-0000-4000-8000-000000000001','out_for_delivery',3)->>'version')::integer=4,'remaining owner can continue');
select public.test_assert((public.transition_order('49800000-0000-4000-8000-000000000001','delivered',4)->>'version')::integer=5,'remaining owner can complete');
select public.test_assert((select count(*)=5 from public.order_status_history where order_id='49800000-0000-4000-8000-000000000001'),'redaction preserves complete timeline');
reset role;
drop view public.owner_history_test_view;
