\set ON_ERROR_STOP on
-- All fixtures roll back; the same suite runs against both final PostGIS layouts.
begin;
select public.test_assert((select relrowsecurity from pg_class where oid='public.customer_notifications'::regclass),'feed RLS enabled');
select public.test_assert(not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='customer_notifications'),'feed is never published to realtime');
select public.test_assert(not has_table_privilege('anon','public.customer_notifications','select'),'anonymous feed access denied');
select public.test_assert(not has_table_privilege('authenticated','public.customer_notifications','insert') and not has_table_privilege('authenticated','public.customer_notifications','delete') and not has_table_privilege('authenticated','public.customer_notifications','update') and has_column_privilege('authenticated','public.customer_notifications','read_at','update'),'only read marker is writable');
do $$ declare fn text; begin
 foreach fn in array array['list_customer_notifications(text,integer,timestamptz,uuid)','mark_customer_notification_read(text,uuid)','mark_all_customer_notifications_read(text)','customer_notification_unread_count(text)'] loop
  perform public.test_assert(has_function_privilege('authenticated','public.'||fn,'execute') and not has_function_privilege('anon','public.'||fn,'execute') and not has_function_privilege('service_role','public.'||fn,'execute'),'customer RPC explicit grants: '||fn);
  perform public.test_assert((select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid=('public.'||fn)::regprocedure),'customer RPC definer and empty path: '||fn);
 end loop;
 foreach fn in array array['purge_expired_customer_notifications()','purge_customer_notifications(uuid,uuid,timestamptz)'] loop
  perform public.test_assert(has_function_privilege('service_role','public.'||fn,'execute') and not has_function_privilege('anon','public.'||fn,'execute') and not has_function_privilege('authenticated','public.'||fn,'execute'),'cleanup trusted only: '||fn);
 end loop;
end $$;
insert into auth.users(id) select ('55000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,5) n;
insert into auth.sessions(id,user_id) select id,id from auth.users where id::text like '55000000-%';
insert into public.business_memberships(business_id,user_id,role,display_name) values
 ('10000000-0000-4000-8000-000000000001','55000000-0000-4000-8000-000000000003','admin','Private Owner A'),
 ('10000000-0000-4000-8000-000000000002','55000000-0000-4000-8000-000000000004','admin','Private Owner B'),
 ('10000000-0000-4000-8000-000000000001','55000000-0000-4000-8000-000000000005','admin','Dual Owner');
insert into public.customer_addresses(customer_id,label,house,street_area,latitude,longitude,location_source)
 select id,'home','Test house','Test street',0.5,0.5,'pin' from auth.users where id::text like '55000000-%';
do $$ declare ns text; begin
 select n.nspname into strict ns from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='postgis';
 execute format('update public.businesses set is_demo=false,ordering_enabled=true,accepting_orders=true,delivery_fee_paise=0,min_order_paise=0,service_area=%1$I.st_geomfromtext(''MULTIPOLYGON(((0 0,1 0,1 1,0 1,0 0)))'',4326),service_area_source=''feed-test'',service_area_version=''test'',service_area_verified_at=now()',ns);
end $$;
update public.menu_items set is_demo=false,available=true;
create temporary table feed_orders(name text primary key,id uuid);
grant all on feed_orders to authenticated,service_role;
create function public.test_feed_place(k integer,slug text default 'ammu-sammu') returns uuid language plpgsql as $$
declare items jsonb; result jsonb; begin
 items:=jsonb_build_array(jsonb_build_object('menu_item_id',case when slug='ammu-sammu' then '20000000-0000-4000-8000-000000000001' else '20000000-0000-4000-8000-000000000002' end,'quantity',1));
 result:=public.place_order(slug,items,public.test_delivery(),null,('55000000-0000-4000-9000-'||lpad(k::text,12,'0'))::uuid,public.test_quote(slug,items));
 perform public.test_assert(result->>'outcome'='placed','fixture order accepted');
 return (result->>'id')::uuid;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub','55000000-0000-4000-8000-000000000001',true);
insert into feed_orders values ('chain',public.test_feed_place(1));
select public.test_assert(public.test_feed_place(1)=(select id from feed_orders where name='chain'),'placement replay returns original order');
select public.test_assert((select count(*)=1 from public.list_customer_notifications('ammu-sammu')),'placed recorded once with push off and no devices');
select public.test_assert(public.customer_notification_unread_count('ammu-sammu')=1,'initial unread count');
insert into feed_orders values ('cancel',public.test_feed_place(2));
insert into feed_orders values ('other-business',public.test_feed_place(3,'kokani-dine-inn'));
-- Devices appear only after placement; they affect push fanout, never the feed.
select set_config('request.jwt.claims','{"session_id":"55000000-0000-4000-8000-000000000001"}',true);
select public.register_device_token('ammu-sammu','customer','feed-device-one');
select public.register_device_token('ammu-sammu','customer','feed-device-two');
select set_config('request.jwt.claim.sub','55000000-0000-4000-8000-000000000002',true);
insert into feed_orders values ('other-customer',public.test_feed_place(4));
select set_config('request.jwt.claim.sub','55000000-0000-4000-8000-000000000005',true);
insert into feed_orders values ('dual-role',public.test_feed_place(5));
select public.test_assert((select count(*)=0 from public.list_customer_notifications('ammu-sammu')) and public.customer_notification_unread_count('ammu-sammu')=0,'dual-role restaurant owner cannot read even their own customer feed');
select public.test_assert(not public.mark_customer_notification_read('ammu-sammu',gen_random_uuid()) and public.mark_all_customer_notifications_read('ammu-sammu')=0,'owner read operations disclose nothing');
select set_config('request.jwt.claim.sub','55000000-0000-4000-8000-000000000003',true);
select public.transition_order((select id from feed_orders where name='chain'),'accepted',1);
select public.transition_order((select id from feed_orders where name='chain'),'preparing',2);
select public.transition_order((select id from feed_orders where name='cancel'),'cancelled',1);
reset role;
select public.test_assert((select count(*)=2 from public.customer_notifications where order_id=(select id from feed_orders where name='chain') and event_status in ('accepted','preparing')),'multiple devices create exactly one row per event');
select public.test_assert((select count(*)=6 from public.notification_outbox where order_id in (select id from feed_orders where name in ('chain','cancel'))),'two devices queue six push jobs for three events');
-- Replay the same source events, exercising the unique constraint / ON CONFLICT path.
update public.orders set status='accepted' where id=(select id from feed_orders where name='chain');
update public.orders set status='preparing' where id=(select id from feed_orders where name='chain');
update public.orders set status=status where id=(select id from feed_orders where name='chain');
select public.test_assert((select count(*)=3 from public.customer_notifications where order_id=(select id from feed_orders where name='chain')),'event replay and unchanged writes do not duplicate the feed');
-- Delivery leases, retries and late acknowledgements have no feed side effects.
set local role service_role;
create temporary table feed_jobs as select job_id as id,lease_id from public.claim_notification_jobs(20);
select public.test_assert((select count(*)>1 from feed_jobs),'push jobs claimed');
select public.finish_notification_job(id,lease_id,'retry') from feed_jobs;
reset role;
update public.notification_outbox set available_at=clock_timestamp()-interval '1 second' where completed_at is null;
set local role service_role;
select count(*) from public.claim_notification_jobs(20);
select public.test_assert(not public.finish_notification_job(id,lease_id,'sent'),'old retry lease cannot finish new attempt') from feed_jobs;
select public.finish_notification_job(id,lease_id,'sent') from public.notification_outbox where completed_at is null;
reset role;
select public.test_assert((select count(*)=3 from public.customer_notifications where order_id=(select id from feed_orders where name='chain')),'push retries never write feed entries');
delete from public.device_tokens where user_id='55000000-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub','55000000-0000-4000-8000-000000000003',true);
select public.transition_order((select id from feed_orders where name='chain'),'out_for_delivery',3);
select public.transition_order((select id from feed_orders where name='chain'),'delivered',4);
do $$ begin
 begin perform public.transition_order((select id from feed_orders where name='chain'),'cancelled',5); raise exception 'invalid transition accepted'; exception when invalid_parameter_value then null; end;
 begin perform public.transition_order((select id from feed_orders where name='chain'),'delivered',4); raise exception 'stale version accepted'; exception when serialization_failure then null; end;
end $$;
reset role;
select public.test_assert((select count(*)=5 and count(distinct event_status)=5 from public.customer_notifications where order_id=(select id from feed_orders where name='chain')),'all five normal events once, including push disabled again');
select public.test_assert((select count(*)=2 from public.customer_notifications where order_id=(select id from feed_orders where name='cancel')),'placed and cancelled once');
select public.test_assert(not exists(select 1 from public.customer_notifications where title<>'Order update' or body like '%Owner%' or body like '%Test Customer%'),'feed contains no owner/actor/customer names');
select public.test_assert(not exists(select 1 from information_schema.columns where table_schema='public' and table_name='customer_notifications' and column_name in ('actor_name','actor_id','changed_by','owner_name')),'no actor columns in feed');
create temporary table feed_row_keys as select id,user_id,business_id from public.customer_notifications;
grant select on feed_row_keys to authenticated;
-- Force a failure after an order/status write: both changes must roll back together.
set local role authenticated;
select set_config('request.jwt.claim.sub','55000000-0000-4000-8000-000000000001',true);
do $$ begin
 begin perform public.test_feed_place(99); raise exception 'forced rollback' using errcode='P5555'; exception when sqlstate 'P5555' then null; end;
end $$;
reset role;
select public.test_assert(not exists(select 1 from public.orders where idempotency_key='55000000-0000-4000-9000-000000000099'),'rolled-back placement leaves no order or orphan feed');
set local role authenticated;
select set_config('request.jwt.claim.sub','55000000-0000-4000-8000-000000000003',true);
do $$ begin
 begin perform public.transition_order((select id from feed_orders where name='other-customer'),'accepted',1); raise exception 'forced rollback' using errcode='P5555'; exception when sqlstate 'P5555' then null; end;
end $$;
reset role;
select public.test_assert((select status='placed' from public.orders where id=(select id from feed_orders where name='other-customer')) and (select count(*)=1 from public.customer_notifications where order_id=(select id from feed_orders where name='other-customer')),'rolled-back transition leaves no feed event');
-- RLS, column permissions, scoped RPCs and idempotent read state.
set local role authenticated;
select set_config('request.jwt.claim.sub','55000000-0000-4000-8000-000000000001',true);
select public.test_assert((select count(*)=8 from public.customer_notifications),'customer sees only own rows across restaurants');
select public.test_assert((select count(*)=7 from public.list_customer_notifications('ammu-sammu')) and (select count(*)=1 from public.list_customer_notifications('kokani-dine-inn')),'RPC list is restaurant scoped');
select public.test_assert(not public.mark_customer_notification_read('ammu-sammu',(select id from feed_row_keys where user_id='55000000-0000-4000-8000-000000000002')),'known other-customer row cannot be marked through privileged RPC');
update public.customer_notifications set read_at=now() where id=(select id from feed_row_keys where user_id='55000000-0000-4000-8000-000000000002');
select public.test_assert(not public.mark_customer_notification_read('ammu-sammu',(select id from public.customer_notifications where business_id='10000000-0000-4000-8000-000000000002' limit 1)),'cannot mark other restaurant row through this restaurant');
select public.test_assert(public.mark_customer_notification_read('ammu-sammu',(select id from public.customer_notifications where event_status='delivered')),'mark own row read');
create temporary table feed_read_before as select id,read_at from public.customer_notifications where event_status='delivered';
select public.test_assert(public.mark_customer_notification_read('ammu-sammu',(select id from feed_read_before)),'mark-one retry succeeds');
update public.customer_notifications set read_at=null where id=(select id from feed_read_before);
select public.test_assert((select n.read_at=b.read_at from public.customer_notifications n join feed_read_before b using(id)),'read marker cannot be cleared or changed on retry');
select public.test_assert(public.customer_notification_unread_count('ammu-sammu')=6,'count before mark-all');
select public.test_assert(public.mark_all_customer_notifications_read('ammu-sammu')=6,'mark-all updates exactly the unread rows');
select public.test_assert(public.mark_all_customer_notifications_read('ammu-sammu')=0,'mark-all retry is idempotent');
select public.test_assert(public.customer_notification_unread_count('ammu-sammu')=0,'count after mark-all');
select public.test_assert((select read_at is null from public.customer_notifications where business_id='10000000-0000-4000-8000-000000000002'),'mark-all leaves other restaurant unread');
update public.customer_notifications set read_at='1900-01-01' where business_id='10000000-0000-4000-8000-000000000002';
select public.test_assert((select read_at>now()-interval '1 minute' from public.customer_notifications where business_id='10000000-0000-4000-8000-000000000002'),'direct mark-read timestamp is server assigned');
do $$ declare command text; begin
 foreach command in array array[
  'update public.customer_notifications set user_id=gen_random_uuid()', 'update public.customer_notifications set business_id=gen_random_uuid()',
  'update public.customer_notifications set order_id=gen_random_uuid()', 'update public.customer_notifications set event_status=''cancelled''',
  'update public.customer_notifications set title=''forged''', 'update public.customer_notifications set body=''forged''',
  'update public.customer_notifications set created_at=now()', 'update public.customer_notifications set id=gen_random_uuid()',
  'insert into public.customer_notifications default values', 'delete from public.customer_notifications',
  'select public.purge_expired_customer_notifications()',
  'select public.purge_customer_notifications(auth.uid(),null,now())'] loop
  begin execute command; raise exception 'forbidden feed operation accepted: %',command; exception when insufficient_privilege then null; end;
 end loop;
 begin perform public.list_customer_notifications('ammu-sammu',0); raise exception 'invalid limit accepted'; exception when invalid_parameter_value then null; end;
 begin perform public.list_customer_notifications('ammu-sammu',101); raise exception 'unbounded limit accepted'; exception when invalid_parameter_value then null; end;
 begin perform public.list_customer_notifications('ammu-sammu',null); raise exception 'null limit accepted'; exception when invalid_parameter_value then null; end;
 begin perform public.list_customer_notifications('ammu-sammu',20,now(),null); raise exception 'half cursor accepted'; exception when invalid_parameter_value then null; end;
 begin perform public.list_customer_notifications('ammu-sammu',20,'infinity',gen_random_uuid()); raise exception 'infinite cursor accepted'; exception when invalid_parameter_value then null; end;
 begin perform public.list_customer_notifications('missing'); raise exception 'missing restaurant accepted'; exception when invalid_parameter_value then null; end;
 begin perform public.mark_customer_notification_read('ammu-sammu',null); raise exception 'null notification accepted'; exception when invalid_parameter_value then null; end;
end $$;
select set_config('request.jwt.claim.sub','55000000-0000-4000-8000-000000000002',true);
select public.test_assert((select count(*)=1 from public.customer_notifications) and public.customer_notification_unread_count('ammu-sammu')=1,'other customer cannot see/read changes to A');
select public.test_assert(not public.mark_customer_notification_read('ammu-sammu',gen_random_uuid()),'unknown/foreign row returns no existence details');
select set_config('request.jwt.claim.sub','55000000-0000-4000-8000-000000000003',true);
select public.test_assert((select count(*)=0 from public.customer_notifications) and (select count(*)=0 from public.list_customer_notifications('ammu-sammu')) and public.customer_notification_unread_count('ammu-sammu')=0,'restaurant owner gets no feed');
select public.test_assert(not public.mark_customer_notification_read('ammu-sammu',(select id from feed_row_keys where user_id='55000000-0000-4000-8000-000000000001' limit 1)),'owner cannot mark known customer row');
select set_config('request.jwt.claim.sub','55000000-0000-4000-8000-000000000005',true);
select public.test_assert(not public.mark_customer_notification_read('ammu-sammu',(select id from feed_row_keys where user_id='55000000-0000-4000-8000-000000000005')) and public.mark_all_customer_notifications_read('ammu-sammu')=0,'dual-role owner cannot mark known own row or mark all');
select set_config('request.jwt.claim.sub','55000000-0000-4000-8000-000000000004',true);
select public.test_assert((select count(*)=0 from public.customer_notifications) and public.mark_all_customer_notifications_read('ammu-sammu')=0,'other restaurant owner gets no feed');
select set_config('request.jwt.claim.sub','',true);
do $$ begin
 begin perform public.list_customer_notifications('ammu-sammu'); raise exception 'signed-out list accepted'; exception when insufficient_privilege then null; end;
 begin perform public.mark_customer_notification_read('ammu-sammu',gen_random_uuid()); raise exception 'signed-out update accepted'; exception when insufficient_privilege then null; end;
 begin perform public.mark_all_customer_notifications_read('ammu-sammu'); raise exception 'signed-out all accepted'; exception when insufficient_privilege then null; end;
 begin perform public.customer_notification_unread_count('ammu-sammu'); raise exception 'signed-out count accepted'; exception when insufficient_privilege then null; end;
end $$;
reset role;
-- A trusted purge is scoped, idempotent and cannot delete rows created after its durable cutoff.
update public.customer_notifications set created_at=now()-interval '1 day' where user_id='55000000-0000-4000-8000-000000000001';
update public.customer_notifications set created_at=clock_timestamp() where user_id='55000000-0000-4000-8000-000000000001' and event_status='delivered';
set local role service_role;
select public.test_assert(public.purge_customer_notifications('55000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',now())=6,'leave removes only this restaurant before cutoff');
select public.test_assert(public.purge_customer_notifications('55000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',now())=0,'leave retry preserves later rows');
select public.test_assert((select count(*)=1 from public.customer_notifications where user_id='55000000-0000-4000-8000-000000000001' and business_id='10000000-0000-4000-8000-000000000002'),'leave retains other restaurant');
select public.test_assert(public.purge_customer_notifications('55000000-0000-4000-8000-000000000001',null,clock_timestamp())=2,'account cleanup affects only specified user');
select public.test_assert((select count(*)=1 from public.customer_notifications where user_id='55000000-0000-4000-8000-000000000002'),'cleanup preserves other customer');
do $$ begin
 begin perform public.purge_customer_notifications(null,null,now()); raise exception 'global purge accepted'; exception when invalid_parameter_value then null; end;
 begin perform public.purge_customer_notifications('55000000-0000-4000-8000-000000000001',null,'infinity'); raise exception 'infinite cutoff accepted'; exception when invalid_parameter_value then null; end;
end $$;
reset role;
-- Deterministic ties and microseconds; RPC returns one lookahead row.
insert into public.customer_notifications(id,user_id,business_id,order_id,event_status,title,body,created_at)
 select ('55000000-0000-4000-a000-'||lpad(n::text,12,'0'))::uuid,'55000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',(select id from feed_orders where name='chain'),
 case n when 1 then 'placed' when 2 then 'accepted' else 'preparing' end,'Order update','Safe test body',date_trunc('second',now())-interval '1 day'+case when n=1 then interval '0.123455 seconds' else interval '0.123456 seconds' end
 from generate_series(1,3) n;
set local role authenticated;
select set_config('request.jwt.claim.sub','55000000-0000-4000-8000-000000000001',true);
select public.test_assert((select array_agg(id)=array['55000000-0000-4000-a000-000000000003'::uuid,'55000000-0000-4000-a000-000000000002'::uuid] from public.list_customer_notifications('ammu-sammu',1)),'tie order and lookahead correct');
select public.test_assert((select count(*)=1 and min(id::text)='55000000-0000-4000-a000-000000000001' from public.list_customer_notifications('ammu-sammu',2,date_trunc('second',now())-interval '1 day'+interval '0.123456 seconds','55000000-0000-4000-a000-000000000002')),'cursor preserves microseconds with no duplicate or gap');
reset role;
update public.customer_notifications set created_at=now()-interval '30 days' where id='55000000-0000-4000-a000-000000000001';
update public.customer_notifications set created_at=now()-interval '30 days 0.000001 seconds' where id='55000000-0000-4000-a000-000000000002';
set local role authenticated;
select public.test_assert((select count(*)=2 from public.list_customer_notifications('ammu-sammu')) and public.customer_notification_unread_count('ammu-sammu')=2,'exact boundary visible, expired row hidden from list/count');
select public.test_assert(not public.mark_customer_notification_read('ammu-sammu','55000000-0000-4000-a000-000000000002'),'expired mark-one hidden');
reset role;
set local role service_role;
select public.test_assert(public.purge_expired_customer_notifications()=1,'trusted expiry deletes only older than 30 days');
select public.test_assert(public.purge_expired_customer_notifications()=0,'trusted expiry retry is idempotent');
reset role;
select public.test_assert(exists(select 1 from public.customer_notifications where id='55000000-0000-4000-a000-000000000001'),'expiry retains exact boundary');
select public.test_assert(exists(select 1 from pg_constraint where conrelid='public.customer_notifications'::regclass and confrelid='auth.users'::regclass and confdeltype='c'),'account foreign key cascades');
rollback;
