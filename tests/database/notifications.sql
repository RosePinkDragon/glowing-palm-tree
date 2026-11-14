\set ON_ERROR_STOP on
select public.test_assert(not has_table_privilege('authenticated','public.device_tokens','insert') and not has_table_privilege('authenticated','public.device_tokens','update') and not has_table_privilege('authenticated','public.device_tokens','delete'), 'raw device writes revoked');
select public.test_assert(not has_table_privilege('authenticated','public.notification_outbox','select') and not has_function_privilege('authenticated','public.claim_notification_jobs(integer)','execute') and not has_function_privilege('anon','public.notification_destination(uuid,uuid)','execute') and not has_function_privilege('authenticated','public.finish_notification_job(uuid,uuid,text)','execute'), 'outbox is service only');
insert into auth.sessions(id,user_id) values
('80000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001'),
('80000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000002'),
('80000000-0000-4000-8000-000000000003','30000000-0000-4000-8000-000000000003'),
('80000000-0000-4000-8000-000000000004','30000000-0000-4000-8000-000000000004');
set role authenticated;
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000001',false);
select set_config('request.jwt.claims','{"session_id":"80000000-0000-4000-8000-000000000001"}',false);
select public.register_device_token('ammu-sammu','customer','customer-a-test');
do $$ begin
  begin perform public.register_device_token('ammu-sammu','admin','escalation'); raise exception 'customer admin registration accepted'; exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claims','{"session_id":"80000000-0000-4000-8000-000000000002"}',false);
do $$ begin
  begin perform public.register_device_token('ammu-sammu','customer','wrong-session'); raise exception 'foreign session accepted'; exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000003',false);
select set_config('request.jwt.claims','{"session_id":"80000000-0000-4000-8000-000000000003"}',false);
select public.register_device_token('ammu-sammu','admin','admin-a-test');
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000004',false);
select set_config('request.jwt.claims','{"session_id":"80000000-0000-4000-8000-000000000004"}',false);
select public.register_device_token('kokani-dine-inn','admin','admin-b-test');
select public.unregister_device_token('ammu-sammu','admin','admin-a-test');
reset role;
select public.test_assert((select count(*)=1 from public.device_tokens where token='admin-a-test'),'cannot unregister another user token');
insert into public.orders(id,business_id,customer_id,customer_name,customer_phone,delivery_address_line,latitude,longitude,location_accuracy,location_captured_at,subtotal_paise,delivery_fee_paise,total_paise,idempotency_key,request_hash)
select '70000000-0000-4000-8000-000000000001',business_id,customer_id,customer_name,customer_phone,delivery_address_line,latitude,longitude,location_accuracy,location_captured_at,subtotal_paise,delivery_fee_paise,total_paise,'70000000-0000-4000-8000-000000000002','notification-test' from public.orders where idempotency_key='60000000-0000-4000-8000-000000000001';
update public.orders set status='accepted' where id='70000000-0000-4000-8000-000000000001';
select public.test_assert((select count(*)=2 from public.notification_outbox),'new order and status event queued only for eligible tenant recipients');
select public.test_assert(not exists (select 1 from public.notification_outbox q join public.device_tokens d on d.id=q.device_token_id where d.session_id is null or d.token='admin-b-test'),'legacy and other tenant devices not queued');
set role service_role;
select public.test_assert((select count(*)=2 from public.claim_notification_jobs(20)),'two jobs leased');
select set_config('test.admin_job',(select id::text from public.notification_outbox where audience='admin'),false);
select set_config('test.admin_lease',(select lease_id::text from public.notification_outbox where audience='admin'),false);
select set_config('test.customer_job',(select id::text from public.notification_outbox where audience='customer'),false);
select set_config('test.customer_lease',(select lease_id::text from public.notification_outbox where audience='customer'),false);
select public.test_assert(public.notification_destination(current_setting('test.admin_job')::uuid,current_setting('test.admin_lease')::uuid)='admin-a-test','current admin destination');
select public.test_assert(public.notification_destination(current_setting('test.customer_job')::uuid,current_setting('test.customer_lease')::uuid)='customer-a-test','customer destination');
select public.test_assert(not public.finish_notification_job(current_setting('test.admin_job')::uuid,gen_random_uuid(),'sent'),'wrong lease cannot ack');
reset role;
delete from public.business_memberships where business_id='10000000-0000-4000-8000-000000000001' and user_id='30000000-0000-4000-8000-000000000003';
set role service_role;
select public.test_assert(public.notification_destination(current_setting('test.admin_job')::uuid,current_setting('test.admin_lease')::uuid) is null,'revoked admin destination denied');
select public.test_assert(public.finish_notification_job(current_setting('test.admin_job')::uuid,current_setting('test.admin_lease')::uuid,'discard'),'discard revoked destination');
select public.test_assert(public.finish_notification_job(current_setting('test.customer_job')::uuid,current_setting('test.customer_lease')::uuid,'retry'),'retry recorded');
select public.test_assert((select attempts=1 and available_at>clock_timestamp() and lease_id is null from public.notification_outbox where id=current_setting('test.customer_job')::uuid),'retry backoff and lease release');
update public.notification_outbox set available_at=clock_timestamp()-interval '1 second' where id=current_setting('test.customer_job')::uuid;
select public.test_assert((select count(*)=1 from public.claim_notification_jobs(1)),'retry claimed');
select public.test_assert(not public.finish_notification_job(current_setting('test.customer_job')::uuid,current_setting('test.customer_lease')::uuid,'sent'),'old lease cannot acknowledge new attempt');
select set_config('test.new_lease',(select lease_id::text from public.notification_outbox where id=current_setting('test.customer_job')::uuid),false);
select public.test_assert(public.finish_notification_job(current_setting('test.customer_job')::uuid,current_setting('test.new_lease')::uuid,'unregistered'),'unregistered token removed');
reset role;
select public.test_assert(not exists(select 1 from public.device_tokens where token='customer-a-test'),'unregistered token deleted');
delete from auth.sessions where id='80000000-0000-4000-8000-000000000003';
select public.test_assert(not exists(select 1 from public.device_tokens where token='admin-a-test'),'session deletion removes token');
-- Expired sessions cannot register or be used as destinations, and a refreshed
-- registration replaces the old row and invalidates its outstanding leases.
update auth.sessions set not_after=clock_timestamp()-interval '1 second' where id='80000000-0000-4000-8000-000000000001';
set role authenticated;
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000001',false);
select set_config('request.jwt.claims','{"session_id":"80000000-0000-4000-8000-000000000001"}',false);
do $$ begin
  begin perform public.register_device_token('ammu-sammu','customer','customer-rotated'); raise exception 'expired session accepted'; exception when insufficient_privilege then null; end;
end $$;
reset role;
update auth.sessions set not_after=null where id='80000000-0000-4000-8000-000000000001';
set role authenticated;
select public.register_device_token('ammu-sammu','customer','customer-rotated');
reset role;
update public.orders set status='preparing' where id='70000000-0000-4000-8000-000000000001';
set role service_role;
select public.test_assert((select count(*)=1 from public.claim_notification_jobs(1)),'rotated token job claimed');
select set_config('test.rotated_job',(select id::text from public.notification_outbox where completed_at is null and audience='customer'),false);
select set_config('test.rotated_lease',(select lease_id::text from public.notification_outbox where id=current_setting('test.rotated_job')::uuid),false);
reset role;
update auth.sessions set not_after=clock_timestamp()-interval '1 second' where id='80000000-0000-4000-8000-000000000001';
set role service_role;
select public.test_assert(public.notification_destination(current_setting('test.rotated_job')::uuid,current_setting('test.rotated_lease')::uuid) is null,'expired session destination denied');
reset role;
update auth.sessions set not_after=null where id='80000000-0000-4000-8000-000000000001';
set role authenticated;
select public.register_device_token('ammu-sammu','customer','customer-rotated');
reset role;
select public.test_assert(not exists(select 1 from public.notification_outbox where id=current_setting('test.rotated_job')::uuid),'re-registration invalidates old leased jobs');
set role service_role;
select public.test_assert(not public.finish_notification_job(current_setting('test.rotated_job')::uuid,current_setting('test.rotated_lease')::uuid,'unregistered'),'stale worker cannot remove new registration');
reset role;
update public.orders set status='out_for_delivery' where id='70000000-0000-4000-8000-000000000001';
set role service_role;
select set_config('test.final_job',(select id::text from public.notification_outbox where completed_at is null and audience='customer'),false);
update public.notification_outbox set attempts=4, available_at=clock_timestamp()-interval '1 second' where id=current_setting('test.final_job')::uuid;
select public.test_assert((select count(*)=1 from public.claim_notification_jobs(1)),'fifth attempt claimed');
select set_config('test.final_lease',(select lease_id::text from public.notification_outbox where id=current_setting('test.final_job')::uuid),false);
select public.test_assert(public.finish_notification_job(current_setting('test.final_job')::uuid,current_setting('test.final_lease')::uuid,'retry'),'fifth retry acknowledged');
select public.test_assert((select attempts=5 and completed_at is not null from public.notification_outbox where id=current_setting('test.final_job')::uuid),'attempts capped');
reset role;

-- A different, expired, or deleted session cannot remove the current session's registration.
insert into auth.sessions(id,user_id) values
('80000000-0000-4000-8000-000000000005','30000000-0000-4000-8000-000000000001'),
('80000000-0000-4000-8000-000000000006','30000000-0000-4000-8000-000000000001');
set role authenticated;
select set_config('request.jwt.claims','{"session_id":"80000000-0000-4000-8000-000000000005"}',false);
select public.unregister_device_token('ammu-sammu','customer','customer-rotated');
reset role;
select public.test_assert(exists(select 1 from public.device_tokens where token='customer-rotated'), 'other active session cannot unregister token');
update auth.sessions set not_after=clock_timestamp()-interval '1 second' where id='80000000-0000-4000-8000-000000000005';
set role authenticated;
do $$ begin
  begin perform public.unregister_device_token('ammu-sammu','customer','customer-rotated'); raise exception 'expired session unregistered token'; exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claims','{"session_id":"80000000-0000-4000-8000-000000000006"}',false);
reset role;
delete from auth.sessions where id='80000000-0000-4000-8000-000000000006';
set role authenticated;
do $$ begin
  begin perform public.unregister_device_token('ammu-sammu','customer','customer-rotated'); raise exception 'deleted session unregistered token'; exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claims','{"session_id":"80000000-0000-4000-8000-000000000002"}',false);
do $$ begin
  begin perform public.unregister_device_token('ammu-sammu','customer','customer-rotated'); raise exception 'foreign session unregistered token'; exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claims','{"session_id":"80000000-0000-4000-8000-000000000001"}',false);
select public.unregister_device_token('ammu-sammu','customer','customer-rotated');
reset role;
select public.test_assert(not exists(select 1 from public.device_tokens where token='customer-rotated'), 'current session can unregister token');
