\set ON_ERROR_STOP on
-- Customer account deletion (#51 slice 1): request_account_deletion, the retention setting and the purge. Self-contained; rolls back.
-- Users: 1 deletes, 2 is an untouched control customer, 3 and 4 co-own Ammu Sammu, 5 solely owns Kokani Dine Inn, 6 has an active
-- order, 7 has a dead session, 8 is deleted directly (the fallback path with no RPC), 9 is a customer with a late-cancelled order.
begin;
insert into auth.users(id) select ('51000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,10) n;
insert into auth.sessions(id,user_id) select ('51000000-0000-4000-b000-'||lpad(n::text,12,'0'))::uuid, ('51000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,10) n;
insert into public.business_memberships(business_id,user_id,role,display_name) values
 ('10000000-0000-4000-8000-000000000001','51000000-0000-4000-8000-000000000003','admin','Owner Three'),
 ('10000000-0000-4000-8000-000000000001','51000000-0000-4000-8000-000000000004','admin','Owner Four'),
 ('10000000-0000-4000-8000-000000000002','51000000-0000-4000-8000-000000000005','admin','Owner Five');
create function public.t_user(n integer) returns uuid language sql immutable as $$ select ('51000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
create function public.t_session(n integer) returns uuid language sql immutable as $$ select ('51000000-0000-4000-b000-'||lpad(n::text,12,'0'))::uuid $$;
create function public.t_as(n integer) returns void language plpgsql as $$ begin
  perform set_config('request.jwt.claim.sub', public.t_user(n)::text, false);
  perform set_config('request.jwt.claims', jsonb_build_object('sub',public.t_user(n),'session_id',public.t_session(n))::text, false); end $$;
create function public.t_order(n integer, u integer, b text, st text) returns void language sql as $$
  insert into public.orders(id,business_id,customer_id,status,customer_name,customer_phone,delivery_address_line,latitude,longitude,address_label,address_custom_label,address_house,address_street_area,address_landmark,address_location_source,saved_address_id,saved_address_version,placed_from_distance_m,subtotal_paise,delivery_fee_paise,total_paise,idempotency_key,request_hash)
  values (('51000000-0000-4000-9000-'||lpad(n::text,12,'0'))::uuid,('10000000-0000-4000-8000-00000000000'||b)::uuid,public.t_user(u),st,'Customer '||u,'98765000'||lpad(u::text,2,'0'),'Line '||n,19.03,73.02,'home','Mum','House '||n,'Road '||n,'Near '||n,'pin',gen_random_uuid(),1,120,100,50,150,gen_random_uuid(),'hash'||n) $$;
-- Run as user n: the statement must fail with this SQLSTATE and detail.
create function public.t_fails(n integer, stmt text, state text, what text) returns void language plpgsql as $$
declare d text;
begin
  perform public.t_as(n); set local role authenticated;
  begin execute stmt; reset role; raise exception 'accepted: %', stmt;
  exception when others then
    get stacked diagnostics d = pg_exception_detail; reset role;
    if sqlstate = state and coalesce(d,'') = coalesce(what,'') then return; end if;
    raise exception 'expected % / % but got % / % (%) for %', state, what, sqlstate, d, sqlerrm, stmt;
  end;
end $$;
-- Everything one customer owns, counted with definer rights (RLS hides nothing).
create function public.t_data(n integer) returns jsonb language sql security definer set search_path = '' as $$
  select jsonb_build_object(
    'profiles',(select count(*) from public.profiles where user_id=public.t_user(n)),
    'addresses',(select count(*) from public.customer_addresses where customer_id=public.t_user(n)),
    'tokens',(select count(*) from public.device_tokens where user_id=public.t_user(n)),
    'notifications',(select count(*) from public.customer_notifications where user_id=public.t_user(n)),
    'relationships',(select count(*) from public.customer_businesses where customer_id=public.t_user(n)),
    'leave_requests',(select count(*) from customer_lifecycle_private.leave_requests where customer_id=public.t_user(n)),
    'code_attempts',(select count(*) from offers_private.code_attempts where customer_id=public.t_user(n)),
    'rejections',(select count(*) from public.checkout_pricing_rejections where customer_id=public.t_user(n)),
    'orders',(select count(*) from public.orders where customer_id=public.t_user(n)),
    'redemptions',(select count(*) from public.offer_redemptions where customer_id=public.t_user(n)),
    'memberships',(select count(*) from public.business_memberships where user_id=public.t_user(n))) $$;

-- Data for customers 1, 2 and 6: profile, two addresses, tokens, relationships, a leave receipt, code attempts, a pricing rejection.
insert into public.profiles(user_id,full_name) select public.t_user(n),'Customer '||n from generate_series(1,2) n;
insert into public.customer_addresses(customer_id,label,house,street_area,latitude,longitude,location_source)
  select public.t_user(n),l,'House','Road',0.5,0.5,'pin' from generate_series(1,2) n cross join (values('home'),('work')) v(l);
insert into public.customer_businesses(customer_id,business_id) select public.t_user(n),b.id from generate_series(1,2) n cross join public.businesses b;
insert into customer_lifecycle_private.leave_requests(customer_id,request_id,business_id,generation,started_at,completed_at)
  select public.t_user(n),gen_random_uuid(),'10000000-0000-4000-8000-000000000002',gen_random_uuid(),now(),now() from generate_series(1,2) n;
insert into offers_private.code_attempts(customer_id,business_id) select public.t_user(n),'10000000-0000-4000-8000-000000000001' from generate_series(1,2) n;
insert into public.checkout_pricing_rejections(customer_id,business_id,idempotency_key,request_hash,pricing)
  select public.t_user(n),'10000000-0000-4000-8000-000000000001',gen_random_uuid(),'h','{}' from generate_series(1,2) n;
-- Orders: customer 1 has a delivered and a cancelled order (the notification trigger adds a feed row each), customer 2 one delivered, 6 one placed, 9 none yet.
select public.t_order(1,1,'1','delivered'), public.t_order(2,1,'2','cancelled'), public.t_order(3,2,'1','delivered'), public.t_order(4,6,'1','placed');
update public.orders set kitchen_distance_m=500 where id='51000000-0000-4000-9000-000000000001';
insert into public.order_items(order_id,name,unit_price_paise,quantity,line_total_paise) select id,'Dish',100,1,100 from public.orders where customer_id in (public.t_user(1),public.t_user(2));
insert into public.order_status_history(order_id,status,changed_by) values ('51000000-0000-4000-9000-000000000001','delivered',public.t_user(4)),('51000000-0000-4000-9000-000000000001','placed',null);
insert into public.order_status_actors(history_id,business_id,actor_id,actor_name) select id,'10000000-0000-4000-8000-000000000001',public.t_user(4),'Owner Four' from public.order_status_history where changed_by=public.t_user(4);
insert into public.offers(id,business_id,name,kind,value,apply_mode) values ('51000000-0000-4000-c000-000000000001','10000000-0000-4000-8000-000000000001','Deletion offer','percent',10,'automatic');
insert into public.offer_redemptions(offer_id,order_id,customer_id,business_id) values
 ('51000000-0000-4000-c000-000000000001','51000000-0000-4000-9000-000000000001',public.t_user(1),'10000000-0000-4000-8000-000000000001'),
 ('51000000-0000-4000-c000-000000000001','51000000-0000-4000-9000-000000000003',public.t_user(2),'10000000-0000-4000-8000-000000000001');
insert into public.device_tokens(user_id,business_id,audience,token,session_id) select public.t_user(n),'10000000-0000-4000-8000-000000000001','customer','tok-'||n,public.t_session(n) from generate_series(1,2) n;
insert into public.notification_outbox(device_token_id,order_id,audience,completed_at)
  select d.id,'51000000-0000-4000-9000-000000000001','customer',v.f from public.device_tokens d cross join (values(null::timestamptz),(clock_timestamp())) v(f) where d.token='tok-1';
create temp table before_user2 as select public.t_data(2) as data, (select jsonb_agg(to_jsonb(o) order by o.id) from public.orders o where customer_id=public.t_user(2)) as orders;
grant select on before_user2 to authenticated;

-- Grants: the RPC is for signed-in customers only; the purge and the finisher list are for service_role only; the settings are private.
do $$ declare f text; begin
  foreach f in array array['public.request_account_deletion()','customer_lifecycle_private.request_account_deletion()'] loop
    perform public.test_assert(has_function_privilege('authenticated',f,'execute') and not has_function_privilege('anon',f,'execute') and not has_function_privilege('service_role',f,'execute'),'deletion grants '||f);
  end loop;
  foreach f in array array['public.purge_deleted_customer_order_snapshots()','public.list_accounts_pending_auth_deletion(integer)'] loop
    perform public.test_assert(has_function_privilege('service_role',f,'execute') and not has_function_privilege('authenticated',f,'execute') and not has_function_privilege('anon',f,'execute'),'service-only '||f);
  end loop;
  perform public.test_assert(not has_function_privilege('authenticated','customer_lifecycle_private.order_snapshot_retention()','execute'),'retention reader private');
  perform public.test_assert(not has_table_privilege('authenticated','customer_lifecycle_private.retention_settings','select,insert,update,delete')
    and not has_table_privilege('service_role','customer_lifecycle_private.retention_settings','select,insert,update,delete'),'retention table private');
  perform public.test_assert((select proconfig @> array['search_path=""'] and prosecdef from pg_proc where oid='customer_lifecycle_private.request_account_deletion()'::regprocedure),'definer boundary');
  perform public.test_assert(customer_lifecycle_private.order_snapshot_retention()=interval '365 days','default retention is 365 days (placeholder)');
end $$;

-- Refusals leave everything as it was.
select public.t_fails(6,'select public.request_account_deletion()','PT409','ACCOUNT_HAS_ACTIVE_ORDER');
create temp table before_owner as select public.t_data(5) d5;
do $$ declare st text; before_data jsonb; begin
  foreach st in array array['placed','accepted','preparing','out_for_delivery'] loop
    update public.orders set status=st where id='51000000-0000-4000-9000-000000000004';
    before_data := public.t_data(6);
    perform public.t_fails(6,'select public.request_account_deletion()','PT409','ACCOUNT_HAS_ACTIVE_ORDER');
    perform public.test_assert(before_data=public.t_data(6),'active-order refusal changes nothing ('||st||')');
  end loop;
end $$;
select public.t_fails(5,'select public.request_account_deletion()','PT409','ONLY_OWNER');
-- Dead sessions are refused before anything happens: foreign, deleted, expired and missing.
do $$ declare claim jsonb; begin
  update auth.sessions set not_after=now()-interval '1 minute' where id=public.t_session(7);
  foreach claim in array array[jsonb_build_object('sub',public.t_user(7),'session_id',public.t_session(7)),jsonb_build_object('sub',public.t_user(7),'session_id',public.t_session(2)),
      jsonb_build_object('sub',public.t_user(7),'session_id','51000000-0000-4000-b000-0000000000ff'),jsonb_build_object('sub',public.t_user(7))] loop
    perform set_config('request.jwt.claim.sub',public.t_user(7)::text,false); perform set_config('request.jwt.claims',claim::text,false);
    set local role authenticated;
    begin perform public.request_account_deletion(); reset role; raise exception 'dead session accepted';
    exception when insufficient_privilege then reset role; end;
  end loop;
end $$;
select public.test_assert(not exists(select 1 from customer_lifecycle_private.accounts where state='deletion_pending'),'refusals mark nothing pending');
select public.test_assert((select d5=public.t_data(5) from before_owner),'sole-owner refusal changes nothing');
select public.test_assert(not exists(select 1 from public.orders where customer_id is null),'refusals unlink no order');
-- An unauthenticated caller (anon) cannot call it at all.
set local role anon;
do $$ begin begin perform public.request_account_deletion(); raise exception 'anon accepted'; exception when insufficient_privilege then null; end; end $$;
reset role;

-- 1. Customer 1 deletes. The first call does the work and returns the pending confirmation.
select public.t_as(1);
set local role authenticated;
create temp table first_call(r jsonb); grant all on first_call to authenticated;
insert into first_call select public.request_account_deletion();
reset role;
select public.test_assert((select r->>'state'='deletion_pending' and (r->>'customer_id')::uuid=public.t_user(1) from first_call),'confirmation names the account and state');
select public.test_assert(public.t_data(1)=jsonb_build_object('profiles',0,'addresses',0,'tokens',0,'notifications',0,'relationships',0,'leave_requests',0,'code_attempts',0,'rejections',0,'orders',0,'redemptions',0,'memberships',0),'all active data removed, nothing still linked to the account');
select public.test_assert((select count(*)=2 and count(*) filter (where customer_id is null and customer_deleted_at is not null and customer_deleted_at>=now()-interval '1 minute' and customer_pii_purged_at is null)=2 from public.orders where id in ('51000000-0000-4000-9000-000000000001','51000000-0000-4000-9000-000000000002')),'orders kept, unlinked and stamped');
select public.test_assert((select customer_name='Customer 1' and customer_phone='9876500001' and delivery_address_line='Line 1' and latitude=19.03 and total_paise=150 from public.orders where id='51000000-0000-4000-9000-000000000001'),'snapshots and totals kept until the retention period ends');
select public.test_assert((select count(*)=2 from public.order_items where order_id in ('51000000-0000-4000-9000-000000000001','51000000-0000-4000-9000-000000000002')),'order items kept');
select public.test_assert((select count(*)=1 and bool_and(customer_id is null) from public.offer_redemptions where order_id='51000000-0000-4000-9000-000000000001'),'offer use kept, unlinked');
select public.test_assert((select state='deletion_pending' and deletion_requested_at is not null from customer_lifecycle_private.accounts where customer_id=public.t_user(1)),'account marked pending');
select public.test_assert(exists(select 1 from auth.users where id=public.t_user(1)),'the RPC leaves the auth user for the trusted finisher');
select public.test_assert((select count(*)=1 from public.notification_outbox where completed_at is not null and device_token_id is null and order_id='51000000-0000-4000-9000-000000000001')
  and not exists(select 1 from public.notification_outbox where completed_at is null and order_id='51000000-0000-4000-9000-000000000001'),'completed push audit kept without token, pending jobs dropped');
-- Another customer is untouched, byte for byte.
select public.test_assert((select b.data=public.t_data(2) and b.orders=(select jsonb_agg(to_jsonb(o) order by o.id) from public.orders o where customer_id=public.t_user(2)) from before_user2 b),'the other customer is unaffected');
select public.test_assert((select count(*)=1 from public.profiles where full_name='Customer 2'),'control profile still there');

-- 2. A second call is idempotent: same confirmation, nothing else changes.
create temp table snapshot_after as select (select jsonb_agg(to_jsonb(o) order by o.id) from public.orders o) orders, (select jsonb_agg(to_jsonb(a) order by a.customer_id) from customer_lifecycle_private.accounts a) accounts;
select public.t_as(1);
set local role authenticated;
select public.test_assert((select r from first_call)=public.request_account_deletion(),'a second call returns the same confirmation');
reset role;
select public.test_assert((select s.orders=(select jsonb_agg(to_jsonb(o) order by o.id) from public.orders o) and s.accounts=(select jsonb_agg(to_jsonb(a) order by a.customer_id) from customer_lifecycle_private.accounts a) from snapshot_after s),'a second call changes nothing');

-- 2b. Data that landed on the pending account after the first pass (the RLS helper is lock-free) is removed by the next request.
insert into public.profiles(user_id,full_name) values (public.t_user(1),'Late profile');
insert into public.customer_addresses(customer_id,label,house,street_area,latitude,longitude,location_source) values (public.t_user(1),'home','H','R',0.5,0.5,'pin');
insert into public.customer_businesses(customer_id,business_id) values (public.t_user(1),'10000000-0000-4000-8000-000000000001');
insert into offers_private.code_attempts(customer_id,business_id) values (public.t_user(1),'10000000-0000-4000-8000-000000000001');
insert into public.device_tokens(user_id,business_id,audience,token,session_id) values (public.t_user(1),'10000000-0000-4000-8000-000000000001','customer','late-token',public.t_session(1));
select public.test_assert((public.t_data(1)->>'profiles')::int=1 and (public.t_data(1)->>'addresses')::int=1 and (public.t_data(1)->>'tokens')::int=1,'late data is present before the repeat call');
select public.t_as(1);
set local role authenticated;
select public.test_assert((select r from first_call)=public.request_account_deletion(),'the repeat call still returns the original confirmation');
reset role;
select public.test_assert(public.t_data(1)=jsonb_build_object('profiles',0,'addresses',0,'tokens',0,'notifications',0,'relationships',0,'leave_requests',0,'code_attempts',0,'rejections',0,'orders',0,'redemptions',0,'memberships',0),'a repeat call removes data that landed after the first pass');

-- 3. A pending account can do nothing, even with a fresh live session: no profile, no address, no checkout, no restaurant link.
select public.t_fails(1,$q$insert into public.profiles(full_name) values ('Back again')$q$,'PT409','ACCOUNT_LIFECYCLE_PENDING');
select public.t_fails(1,$q$insert into public.customer_addresses(label,house,street_area,latitude,longitude,location_source) values ('home','H','R',0.5,0.5,'pin')$q$,'PT409','ACCOUNT_LIFECYCLE_PENDING');
select public.t_fails(1,$q$select public.join_business('ammu-sammu')$q$,'PT409','ACCOUNT_LIFECYCLE_PENDING');
select public.t_fails(1,$q$select public.register_device_token('ammu-sammu','customer','new-token')$q$,'PT409','ACCOUNT_LIFECYCLE_PENDING');
select public.t_fails(1,$q$select public.place_order('ammu-sammu','[]','{}',null,gen_random_uuid(),'{}')$q$,'PT409','ACCOUNT_LIFECYCLE_PENDING');
-- 4. Nobody reads the unlinked orders as a customer; owners of the restaurant still do.
do $$ declare n integer; begin
  foreach n in array array[1,2,6,9] loop
    perform public.t_as(n); set local role authenticated;
    perform public.test_assert((select count(*)=0 from public.orders where id in ('51000000-0000-4000-9000-000000000001','51000000-0000-4000-9000-000000000002')),'customer '||n||' cannot read unlinked orders');
    perform public.test_assert((select count(*)=0 from public.order_items where order_id in ('51000000-0000-4000-9000-000000000001','51000000-0000-4000-9000-000000000002')),'customer '||n||' cannot read their items');
    perform public.test_assert((select count(*)=0 from public.order_status_history where order_id in ('51000000-0000-4000-9000-000000000001','51000000-0000-4000-9000-000000000002')),'customer '||n||' cannot read their history');
    perform public.test_assert((select count(*) from public.orders where customer_id is null)=0,'customer '||n||' sees no order with a null customer');
    reset role;
  end loop;
  perform public.t_as(3); set local role authenticated;
  perform public.test_assert((select count(*)=1 and bool_and(customer_id is null and customer_name='Customer 1' and total_paise=150) from public.orders where id='51000000-0000-4000-9000-000000000001'),'owner still sees the order');
  perform public.test_assert((select count(*)=1 from public.order_items where order_id='51000000-0000-4000-9000-000000000001'),'owner still sees its items');
  perform public.test_assert((select count(*)=1 from public.offer_redemptions where order_id='51000000-0000-4000-9000-000000000001' and customer_id is null),'owner still sees the offer use');
  reset role;
  perform public.t_as(5); set local role authenticated;
  perform public.test_assert((select count(*)=0 from public.orders where id='51000000-0000-4000-9000-000000000001'),'the other restaurant owner does not see it');
  reset role;
  -- Anonymous visitors see nothing.
  set local role anon;
  begin perform count(*) from public.orders; raise exception 'anon read orders'; exception when insufficient_privilege then null; end;
  reset role;
end $$;
-- An anonymised order is final: the owner's transition is the ordinary refusal, not an authentication error.
select public.t_fails(3,$q$select public.transition_order('51000000-0000-4000-9000-000000000001','accepted',1)$q$,'22023',null);

-- 5. Owner 4 (co-owner) may delete; their name on history becomes "Former owner"; owner 3 is then the only owner and is refused.
select public.t_as(4); set local role authenticated; select public.request_account_deletion(); reset role;
select public.test_assert(not exists(select 1 from public.business_memberships where user_id=public.t_user(4)),'owner membership removed');
select public.test_assert((select actor_name='Former owner' and actor_id is null from public.order_status_actors where history_id=(select id from public.order_status_history where order_id='51000000-0000-4000-9000-000000000001' and status='delivered')),'owner name replaced');
select public.test_assert(not exists(select 1 from public.order_status_history where changed_by=public.t_user(4)),'history actor cleared');
select public.t_fails(3,'select public.request_account_deletion()','PT409','ONLY_OWNER');
select public.test_assert(exists(select 1 from public.business_memberships where user_id=public.t_user(3)),'the remaining owner keeps the restaurant');
-- An owner whose co-owner is already pending does not count that co-owner (pending state set by trusted fixture).
insert into public.business_memberships(business_id,user_id,role) values ('10000000-0000-4000-8000-000000000001',public.t_user(9),'admin');
insert into customer_lifecycle_private.accounts(customer_id,state,deletion_requested_at) values (public.t_user(9),'deletion_pending',now());
select public.t_fails(3,'select public.request_account_deletion()','PT409','ONLY_OWNER');
delete from customer_lifecycle_private.accounts where customer_id=public.t_user(9); delete from public.business_memberships where user_id=public.t_user(9);

-- 6. A customer whose last order finishes can delete.
update public.orders set status='delivered' where id='51000000-0000-4000-9000-000000000004';
select public.t_as(6); set local role authenticated; select public.request_account_deletion(); reset role;
select public.test_assert((select customer_id is null and customer_deleted_at is not null from public.orders where id='51000000-0000-4000-9000-000000000004'),'finished order unlinked after deletion');
-- The finisher's list shows who still needs the auth user removed, oldest first; direct auth deletion then clears it.
select public.test_assert((select array_agg(customer_id order by requested_at, customer_id) from public.list_accounts_pending_auth_deletion(10))@>array[public.t_user(1),public.t_user(4),public.t_user(6)],'finisher list names the pending accounts');
select public.test_assert((select count(*)=1 from public.list_accounts_pending_auth_deletion(1)),'finisher list honours its limit');
set local role service_role;
select public.test_assert((select count(*)>=3 from public.list_accounts_pending_auth_deletion()),'service_role may list');
reset role;
delete from auth.users where id=public.t_user(1);
select public.test_assert(not exists(select 1 from customer_lifecycle_private.accounts where customer_id=public.t_user(1)) and not exists(select 1 from public.list_accounts_pending_auth_deletion(100) where customer_id=public.t_user(1)),'removing the auth user completes it');
select public.test_assert((select count(*)=2 and bool_and(customer_id is null) from public.orders where id in ('51000000-0000-4000-9000-000000000001','51000000-0000-4000-9000-000000000002')),'orders survive auth user removal');

-- 7. Fallback: an auth user deleted directly (dashboard) with orders is no longer blocked and is stamped by the foreign key action.
select public.t_order(5,8,'1','delivered');
insert into public.checkout_pricing_rejections(customer_id,business_id,idempotency_key,request_hash,pricing) values (public.t_user(8),'10000000-0000-4000-8000-000000000001',gen_random_uuid(),'h','{}');
insert into public.offer_redemptions(offer_id,order_id,customer_id,business_id) values ('51000000-0000-4000-c000-000000000001','51000000-0000-4000-9000-000000000005',public.t_user(8),'10000000-0000-4000-8000-000000000001');
insert into public.order_status_history(order_id,status,changed_by) values ('51000000-0000-4000-9000-000000000005','delivered',public.t_user(8));
delete from auth.users where id=public.t_user(8);
select public.test_assert((select customer_id is null and customer_deleted_at>=now()-interval '1 minute' from public.orders where id='51000000-0000-4000-9000-000000000005'),'direct auth delete keeps and stamps the order');
select public.test_assert(not exists(select 1 from public.checkout_pricing_rejections where idempotency_key is not null and customer_id is null) and exists(select 1 from public.offer_redemptions where order_id='51000000-0000-4000-9000-000000000005' and customer_id is null),'direct delete: rejections go, offer use stays');
select public.test_assert((select changed_by is null from public.order_status_history where order_id='51000000-0000-4000-9000-000000000005'),'direct delete: history actor no longer blocks');

-- 8. Constraints: a link is a customer or a deletion stamp; nothing is blanked early; a purged order has no snapshot left.
do $$ begin
  begin update public.orders set customer_deleted_at=now() where id='51000000-0000-4000-9000-000000000003'; raise exception 'linked order stamped deleted'; exception when check_violation then null; end;
  begin update public.orders set customer_deleted_at=null where id='51000000-0000-4000-9000-000000000001'; raise exception 'unlinked order without stamp'; exception when check_violation then null; end;
  begin update public.orders set customer_name=null where id='51000000-0000-4000-9000-000000000003'; raise exception 'snapshot blanked on a linked order'; exception when check_violation then null; end;
  begin update public.orders set customer_name=null where id='51000000-0000-4000-9000-000000000001'; raise exception 'snapshot blanked before purge'; exception when check_violation then null; end;
  begin update public.orders set customer_pii_purged_at=now() where id='51000000-0000-4000-9000-000000000001'; raise exception 'purge stamp with snapshots present'; exception when check_violation then null; end;
  begin update public.orders set customer_pii_purged_at=now() where id='51000000-0000-4000-9000-000000000003'; raise exception 'linked order purged'; exception when check_violation then null; end;
  begin update customer_lifecycle_private.retention_settings set order_snapshot_retention=interval '0'; raise exception 'zero retention accepted'; exception when check_violation then null; end;
  begin update customer_lifecycle_private.retention_settings set order_snapshot_retention=interval '23 hours'; raise exception 'retention under the floor accepted'; exception when check_violation then null; end;
  begin insert into customer_lifecycle_private.retention_settings(singleton) values (false); raise exception 'second settings row'; exception when check_violation then null; end;
end $$;

-- 8b. A direct auth.users delete while an order is in progress: the order is unlinked, the owner can still move it to cancelled or delivered,
-- and the purge never touches it until it is final.
select public.t_order(6,10,'1','placed'), public.t_order(7,10,'1','placed');
delete from auth.users where id=public.t_user(10);
select public.test_assert((select count(*)=2 and bool_and(customer_id is null and customer_deleted_at is not null and customer_name is not null) from public.orders where id in ('51000000-0000-4000-9000-000000000006','51000000-0000-4000-9000-000000000007')),'active orders survive a direct auth delete, unlinked');
update public.orders set customer_deleted_at=now()-interval '1000 days' where id in ('51000000-0000-4000-9000-000000000006','51000000-0000-4000-9000-000000000007');
select public.test_assert(public.purge_deleted_customer_order_snapshots()=0,'the purge skips active orders however old');
select public.test_assert((select count(*)=2 and bool_and(customer_name is not null and customer_pii_purged_at is null) from public.orders where id in ('51000000-0000-4000-9000-000000000006','51000000-0000-4000-9000-000000000007')),'active orders keep their snapshot');
select public.t_as(3); set local role authenticated;
select public.transition_order('51000000-0000-4000-9000-000000000006','cancelled',1);
select public.transition_order('51000000-0000-4000-9000-000000000007','accepted',1);
select public.transition_order('51000000-0000-4000-9000-000000000007','preparing',2);
select public.transition_order('51000000-0000-4000-9000-000000000007','out_for_delivery',3);
select public.transition_order('51000000-0000-4000-9000-000000000007','delivered',4);
reset role;
select public.test_assert((select count(*)=2 and count(*) filter (where status='cancelled')=1 and count(*) filter (where status='delivered')=1 from public.orders where id in ('51000000-0000-4000-9000-000000000006','51000000-0000-4000-9000-000000000007')),'the owner finished both orders after the customer vanished');
select public.test_assert(not exists(select 1 from public.customer_notifications where order_id in ('51000000-0000-4000-9000-000000000006','51000000-0000-4000-9000-000000000007')),'no feed row for a customer who no longer exists');

update public.orders set customer_deleted_at=now() where id in ('51000000-0000-4000-9000-000000000006','51000000-0000-4000-9000-000000000007');

-- 9. Retention purge. Time is simulated by moving customer_deleted_at back; the setting is read at purge time.
select public.test_assert(public.purge_deleted_customer_order_snapshots()=0,'nothing is due right after deletion');
update public.orders set customer_deleted_at=now()-interval '364 days' where id in ('51000000-0000-4000-9000-000000000001','51000000-0000-4000-9000-000000000002');
select public.test_assert(public.purge_deleted_customer_order_snapshots()=0,'nothing is due one day before the period ends');
select public.test_assert((select customer_name='Customer 1' from public.orders where id='51000000-0000-4000-9000-000000000001'),'snapshot intact before the period ends');
update public.orders set customer_deleted_at=now()-interval '366 days' where id='51000000-0000-4000-9000-000000000001';
set local role service_role;
create temp table purged(n integer); grant all on purged to service_role;
insert into purged select public.purge_deleted_customer_order_snapshots();
reset role;
select public.test_assert((select n=1 from purged),'exactly the order past the period is purged');
select public.test_assert((select customer_id is null and customer_pii_purged_at is not null and customer_name is null and customer_phone is null and delivery_address_line is null
  and latitude is null and longitude is null and address_label is null and address_custom_label is null and address_house is null and address_street_area is null and address_landmark is null
  and address_location_source is null and saved_address_id is null and saved_address_version is null and placed_from_distance_m is null and kitchen_distance_m is null
  and status='delivered' and total_paise=150 and order_number is not null and business_id is not null from public.orders where id='51000000-0000-4000-9000-000000000001'),'purged order: snapshots blank, record kept');
select public.test_assert((select customer_name='Customer 1' and latitude=19.03 from public.orders where id='51000000-0000-4000-9000-000000000002'),'a not-yet-due order of the same customer keeps its snapshot');
select public.test_assert((select b.orders=(select jsonb_agg(to_jsonb(o) order by o.id) from public.orders o where customer_id=public.t_user(2)) from before_user2 b),'non-deleted customer orders are never purged');
select public.test_assert((select count(*)=1 from public.order_items where order_id='51000000-0000-4000-9000-000000000001'),'purged order keeps its items');
select public.test_assert(public.purge_deleted_customer_order_snapshots()=0,'purge is idempotent');
-- The period is one setting, read at purge time: shorten it and the 364-day-old order is due; recent deletions still wait.
update customer_lifecycle_private.retention_settings set order_snapshot_retention=interval '30 days';
select public.test_assert(public.purge_deleted_customer_order_snapshots()=1,'a shorter period purges exactly the older order');
select public.test_assert((select customer_name is null and customer_pii_purged_at is not null from public.orders where id='51000000-0000-4000-9000-000000000002'),'older order purged under the shorter period');
select public.test_assert((select count(*)=2 and bool_and(customer_name is not null) from public.orders where id in ('51000000-0000-4000-9000-000000000004','51000000-0000-4000-9000-000000000005')),'recent deletions keep their snapshot');
update customer_lifecycle_private.retention_settings set order_snapshot_retention=interval '2 years';
update public.orders set customer_deleted_at=now()-interval '500 days' where id='51000000-0000-4000-9000-000000000004';
select public.test_assert(public.purge_deleted_customer_order_snapshots()=0,'a longer period holds an order that the default would purge');
update customer_lifecycle_private.retention_settings set order_snapshot_retention=interval '365 days';
select public.test_assert(public.purge_deleted_customer_order_snapshots()=1,'back at the default the 500-day-old order is purged');
select public.test_assert((select customer_name is not null from public.orders where id='51000000-0000-4000-9000-000000000005'),'the newest deletion is still intact');
rollback;
