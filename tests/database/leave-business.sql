\set ON_ERROR_STOP on
begin;
insert into auth.users(id) select ('b5210000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,3) n;
insert into auth.sessions(id,user_id) select id,id from auth.users where id::text like 'b5210000-%';
insert into public.customer_businesses(customer_id,business_id) select u.id,b.id from auth.users u cross join public.businesses b where u.id::text like 'b5210000-%';
insert into public.customer_addresses(customer_id,label,house,street_area,latitude,longitude,location_source) values ('b5210000-0000-4000-8000-000000000001','home','Keep house','Keep road',0.5,0.5,'pin');
insert into public.business_memberships(business_id,user_id,role) values ('10000000-0000-4000-8000-000000000001','b5210000-0000-4000-8000-000000000001','admin');
insert into public.orders(id,business_id,customer_id,status,customer_name,customer_phone,delivery_address_line,latitude,longitude,address_label,address_house,address_street_area,address_location_source,saved_address_id,saved_address_version,subtotal_paise,delivery_fee_paise,total_paise,idempotency_key,request_hash)
values ('b5210000-0000-4000-9000-000000000001','10000000-0000-4000-8000-000000000001','b5210000-0000-4000-8000-000000000001','delivered','Keep name','123','Keep address',0.5,0.5,'home','Keep house','Keep road','pin',gen_random_uuid(),1,100,0,100,gen_random_uuid(),'keep');
insert into public.order_items(order_id,name,unit_price_paise,quantity,line_total_paise) values ('b5210000-0000-4000-9000-000000000001','Keep item',100,1,100);
insert into public.order_status_history(order_id,status) values ('b5210000-0000-4000-9000-000000000001','delivered');
insert into public.device_tokens(user_id,business_id,audience,token,session_id) values
 ('b5210000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','customer','remove','b5210000-0000-4000-8000-000000000001'),
 ('b5210000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','admin','keep-admin','b5210000-0000-4000-8000-000000000001'),
 ('b5210000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','customer','keep-other-business','b5210000-0000-4000-8000-000000000001'),
 ('b5210000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','customer','keep-other-user','b5210000-0000-4000-8000-000000000002');
insert into public.notification_outbox(device_token_id,order_id,audience,completed_at) select d.id,'b5210000-0000-4000-9000-000000000001','customer',v.finished from public.device_tokens d cross join (values(null::timestamptz),(clock_timestamp())) v(finished) where d.token='remove';
create temp table preserved(kind text,row jsonb);
insert into preserved select 'order',to_jsonb(o) from public.orders o union all select 'item',to_jsonb(i) from public.order_items i union all select 'history',to_jsonb(h) from public.order_status_history h union all select 'actor',to_jsonb(a) from public.order_status_actors a union all select 'address',to_jsonb(a) from public.customer_addresses a union all select 'member',to_jsonb(m) from public.business_memberships m;
create temp table receipt(value jsonb);
grant all on receipt to authenticated;
select public.test_assert(not has_table_privilege('authenticated','customer_lifecycle_private.leave_requests','select,insert,update,delete'),'receipt ledger private');
select public.test_assert(not exists(select 1 from pg_publication_tables where schemaname='customer_lifecycle_private'),'ledger not realtime');
do $$ declare f text; begin foreach f in array array['public.leave_business(text,uuid,uuid)','customer_lifecycle_private.leave_business(text,uuid,uuid)'] loop
 perform public.test_assert(has_function_privilege('authenticated',f,'execute') and not has_function_privilege('anon',f,'execute') and not has_function_privilege('service_role',f,'execute'),'exact leave grants');
 perform public.test_assert((select proconfig @> array['search_path=""'] and prosecdef=(f like 'customer_lifecycle_private.%') from pg_proc where oid=f::regprocedure),'leave security boundary');
end loop; end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub','b5210000-0000-4000-8000-000000000001',true);
do $$ declare claim text; begin
 foreach claim in array array['{}','{"session_id":"bad"}','{"session_id":"b5210000-0000-4000-8000-000000000002"}','{"session_id":"b5210000-0000-4000-8000-000000000099"}'] loop
  perform set_config('request.jwt.claims',claim,true);
  begin perform customer_lifecycle_private.leave_business('ammu-sammu',gen_random_uuid(),gen_random_uuid()); raise exception 'invalid session accepted'; exception when insufficient_privilege then null; end;
 end loop;
end $$;
select set_config('request.jwt.claims','{"session_id":"b5210000-0000-4000-8000-000000000001"}',true);
do $$ declare g uuid; detail text; begin
 select generation into g from public.customer_businesses where customer_id=auth.uid() and business_id='10000000-0000-4000-8000-000000000001';
 begin perform public.leave_business('unknown',gen_random_uuid(),g); raise exception 'unknown business accepted'; exception when invalid_parameter_value then null; end;
 begin perform public.leave_business('ammu-sammu',null,g); raise exception 'null request accepted'; exception when invalid_parameter_value then null; end;
 begin perform public.leave_business('ammu-sammu',gen_random_uuid(),gen_random_uuid()); raise exception 'stale generation accepted'; exception when sqlstate 'PT409' then get stacked diagnostics detail=pg_exception_detail; perform public.test_assert(detail='STALE_RELATIONSHIP','strict stale code'); end;
end $$;
-- Every non-final state blocks leave before cleanup or receipt creation.
reset role;
do $$ declare current_status text; detail text; begin
 foreach current_status in array array['placed','accepted','preparing','out_for_delivery'] loop
  update public.orders set status=current_status where id='b5210000-0000-4000-9000-000000000001';
  begin
   perform public.leave_business('ammu-sammu',gen_random_uuid(),(select generation from public.customer_businesses where customer_id='b5210000-0000-4000-8000-000000000001' and business_id='10000000-0000-4000-8000-000000000001'));
   raise exception 'non-final leave succeeded';
  exception when sqlstate 'PT409' then get stacked diagnostics detail=pg_exception_detail; perform public.test_assert(detail='ACTIVE_ORDERS','non-final status blocks leave'); end;
 end loop;
 update public.orders set status='delivered' where id='b5210000-0000-4000-9000-000000000001';
end $$;
-- Force a mid-cleanup failure: the entire transaction (including pending and token deletion) rolls back.
create function public.test_leave_fail() returns trigger language plpgsql as $$ begin raise exception 'synthetic cleanup failure' using errcode='P0001'; end $$;
create trigger test_leave_fail before delete on public.customer_notifications for each row execute function public.test_leave_fail();
set local role authenticated;
do $$ begin
 begin perform public.leave_business('ammu-sammu','b5210000-0000-4000-a000-000000000001',(select generation from public.customer_businesses where customer_id=auth.uid() and business_id='10000000-0000-4000-8000-000000000001')); raise exception 'failure injection unused' using errcode='XX000'; exception when raise_exception then null; end;
end $$;
reset role;
select public.test_assert(exists(select 1 from public.device_tokens where token='remove') and (select state='active' from public.customer_businesses where customer_id='b5210000-0000-4000-8000-000000000001' and business_id='10000000-0000-4000-8000-000000000001') and not exists(select 1 from customer_lifecycle_private.leave_requests),'cleanup failure rolled back all work');
drop trigger test_leave_fail on public.customer_notifications;
set local role authenticated;
insert into receipt select public.leave_business('ammu-sammu','b5210000-0000-4000-a000-000000000001',(select generation from public.customer_businesses where customer_id=auth.uid() and business_id='10000000-0000-4000-8000-000000000001'));
select public.test_assert(public.leave_business('ammu-sammu','b5210000-0000-4000-a000-000000000001',((select value from receipt)->>'generation')::uuid)=(select value from receipt),'lost-response retry returns identical receipt');
do $$ declare detail text; begin
 begin perform public.leave_business('kokani-dine-inn','b5210000-0000-4000-a000-000000000001',((select value from receipt)->>'generation')::uuid); raise exception 'ID reused'; exception when sqlstate 'PT409' then get stacked diagnostics detail=pg_exception_detail; perform public.test_assert(detail='LEAVE_REQUEST_CONFLICT','request binds business'); end;
end $$;
reset role;
select public.test_assert((select count(*)=3 from public.device_tokens where token like 'keep-%'),'admin/other business/other user tokens untouched');
select public.test_assert(not exists(select 1 from public.device_tokens where token='remove') and not exists(select 1 from public.notification_outbox where order_id='b5210000-0000-4000-9000-000000000001' and completed_at is null),'customer token and pending jobs removed');
select public.test_assert((select count(*)=1 from public.notification_outbox where order_id='b5210000-0000-4000-9000-000000000001' and completed_at is not null and device_token_id is null),'completed push audit retained');
select public.test_assert(not exists(select 1 from public.customer_notifications where user_id='b5210000-0000-4000-8000-000000000001'),'feed purged');
select public.test_assert((select state='left' from public.customer_businesses where customer_id='b5210000-0000-4000-8000-000000000001' and business_id='10000000-0000-4000-8000-000000000001'),'left marker retained');
create temp table after_preserved as select 'order',to_jsonb(o) from public.orders o union all select 'item',to_jsonb(i) from public.order_items i union all select 'history',to_jsonb(h) from public.order_status_history h union all select 'actor',to_jsonb(a) from public.order_status_actors a union all select 'address',to_jsonb(a) from public.customer_addresses a union all select 'member',to_jsonb(m) from public.business_memberships m;
select public.test_assert(not exists((select * from after_preserved except all select * from preserved)
 union all (select * from preserved except all select * from after_preserved)), 'complete snapshots/shared data unchanged in both directions');
set local role authenticated;
do $$ declare detail text; begin
 begin perform public.leave_business('kokani-dine-inn',gen_random_uuid(),(select generation from public.customer_businesses where customer_id=auth.uid() and business_id='10000000-0000-4000-8000-000000000002')); raise exception 'last business left'; exception when sqlstate 'PT409' then get stacked diagnostics detail=pg_exception_detail; perform public.test_assert(detail='LAST_BUSINESS','last business code'); end;
 perform public.join_business('ammu-sammu');
 perform public.register_device_token('ammu-sammu','customer','later-generation');
end $$;
reset role;
insert into public.customer_notifications(user_id,business_id,order_id,event_status,title,body) values('b5210000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','b5210000-0000-4000-9000-000000000001','delivered','Later','Later');
set local role authenticated;
do $$ declare detail text; begin
 begin perform public.leave_business('ammu-sammu',gen_random_uuid(),((select value from receipt)->>'generation')::uuid); raise exception 'stale new request accepted';
 exception when sqlstate 'PT409' then get stacked diagnostics detail=pg_exception_detail; perform public.test_assert(detail='STALE_RELATIONSHIP','old generation cannot start new leave'); end;
end $$;
select public.test_assert(public.leave_business('ammu-sammu','b5210000-0000-4000-a000-000000000001',((select value from receipt)->>'generation')::uuid)=(select value from receipt),'old retry after rejoin returns old receipt');
reset role;
select public.test_assert(exists(select 1 from public.device_tokens where token='later-generation') and exists(select 1 from public.customer_notifications where body='Later') and (select state='active' and generation<>(select (value->>'generation')::uuid from receipt) from public.customer_businesses where customer_id='b5210000-0000-4000-8000-000000000001' and business_id='10000000-0000-4000-8000-000000000001'),'old retry cannot erase rejoin');
rollback;
