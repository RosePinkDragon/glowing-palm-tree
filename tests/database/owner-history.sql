\set ON_ERROR_STOP on
-- Owner display names and owner-only history actor snapshots (#98).
begin;
create or replace function public.test_assert(ok boolean, message text) returns void language plpgsql as $$ begin if not coalesce(ok,false) then raise exception 'assertion failed: %', message; end if; end $$;
grant execute on function public.test_assert(boolean,text) to anon, authenticated, service_role;

-- Backfill: every earlier owner transition has a snapshot, none for checkout.
select public.test_assert(not exists (select 1 from public.order_status_history h where h.status <> 'placed' and h.changed_by is not null and not exists (select 1 from public.order_status_actors a where a.history_id = h.id)), 'earlier owner transitions are backfilled');
select public.test_assert(not exists (select 1 from public.order_status_actors a join public.order_status_history h on h.id = a.history_id where h.status = 'placed'), 'checkout steps carry no owner snapshot');
select public.test_assert(not exists (select 1 from public.order_status_actors a join public.order_status_history h on h.id = a.history_id join public.orders o on o.id = h.order_id where a.business_id <> o.business_id), 'snapshots belong to the order business');

-- Privileges: no client writes, no identifiers, server-only redaction.
select public.test_assert((select relrowsecurity from pg_class where oid = 'public.order_status_actors'::regclass), 'actor snapshots use RLS');
select public.test_assert(not has_table_privilege('anon','public.order_status_actors','select') and not has_column_privilege('anon','public.order_status_actors','actor_name','select'), 'anon cannot read snapshots');
select public.test_assert(not has_table_privilege('authenticated','public.order_status_actors','insert') and not has_table_privilege('authenticated','public.order_status_actors','update') and not has_table_privilege('authenticated','public.order_status_actors','delete'), 'no client snapshot writes');
select public.test_assert(not has_column_privilege('authenticated','public.order_status_actors','actor_id','select') and not has_column_privilege('authenticated','public.order_status_actors','business_id','select'), 'snapshot identifiers stay server side');
select public.test_assert(not has_column_privilege('authenticated','public.order_status_history','changed_by','select') and has_column_privilege('authenticated','public.order_status_history','status','select') and has_column_privilege('authenticated','public.order_status_history','created_at','select'), 'history exposes status and time only');
select public.test_assert(not has_function_privilege('authenticated','public.redact_owner_history_names(uuid)','execute') and not has_function_privilege('anon','public.redact_owner_history_names(uuid)','execute') and has_function_privilege('service_role','public.redact_owner_history_names(uuid)','execute'), 'redaction is server only');
select public.test_assert(has_function_privilege('authenticated','public.transition_order(uuid,text,integer)','execute') and not has_function_privilege('anon','public.transition_order(uuid,text,integer)','execute'), 'transition grants unchanged');
select public.test_assert(not has_table_privilege('authenticated','public.business_memberships','update'), 'owners cannot rename memberships directly');

-- Fixture: two Ammu Sammu owners, one Kokani owner, one customer, one order.
insert into auth.users(id) values ('49800000-0000-4000-8000-000000000001'),('49800000-0000-4000-8000-000000000002'),('49800000-0000-4000-8000-000000000003'),('49800000-0000-4000-8000-000000000004');
insert into public.business_memberships(business_id,user_id,role) values ('10000000-0000-4000-8000-000000000002','49800000-0000-4000-8000-000000000003','admin');
select public.test_assert((select display_name = 'Owner' from public.business_memberships where user_id = '49800000-0000-4000-8000-000000000003'), 'memberships default to Owner');
insert into public.business_memberships(business_id,user_id,role,display_name) values
  ('10000000-0000-4000-8000-000000000001','49800000-0000-4000-8000-000000000001','admin','Asha Kadam'),
  ('10000000-0000-4000-8000-000000000001','49800000-0000-4000-8000-000000000002','admin','Ravi');
do $$ begin
  begin insert into public.business_memberships(business_id,user_id,role,display_name) values ('10000000-0000-4000-8000-000000000002','49800000-0000-4000-8000-000000000004','admin',' padded '); raise exception 'untrimmed name accepted'; exception when check_violation then null; end;
  begin insert into public.business_memberships(business_id,user_id,role,display_name) values ('10000000-0000-4000-8000-000000000002','49800000-0000-4000-8000-000000000004','admin',''); raise exception 'empty name accepted'; exception when check_violation then null; end;
  begin insert into public.business_memberships(business_id,user_id,role,display_name) values ('10000000-0000-4000-8000-000000000002','49800000-0000-4000-8000-000000000004','admin',repeat('a',61)); raise exception 'long name accepted'; exception when check_violation then null; end;
  begin insert into public.business_memberships(business_id,user_id,role,display_name) values ('10000000-0000-4000-8000-000000000002','49800000-0000-4000-8000-000000000004','admin',E'Line\nbreak'); raise exception 'control character accepted'; exception when check_violation then null; end;
end $$;
insert into public.orders(id,business_id,customer_id,customer_name,customer_phone,delivery_address_line,latitude,longitude,location_accuracy,location_captured_at,subtotal_paise,delivery_fee_paise,total_paise,idempotency_key,request_hash)
values ('49800000-0000-4000-8000-0000000000a1','10000000-0000-4000-8000-000000000001','49800000-0000-4000-8000-000000000004','History customer','9000000000','Khed',0.5,0.5,10,now(),10000,0,10000,'49800000-0000-4000-8000-0000000000b1','history-test');
insert into public.order_status_history(order_id,status,changed_by) values ('49800000-0000-4000-8000-0000000000a1','placed','49800000-0000-4000-8000-000000000004');

-- Owner A accepts; the snapshot carries the name at that moment.
set role authenticated;
select set_config('request.jwt.claim.sub','49800000-0000-4000-8000-000000000001',true);
select public.test_assert((public.transition_order('49800000-0000-4000-8000-0000000000a1','accepted',1)->>'version')::int = 2, 'owner A accepts');
reset role;
update public.business_memberships set display_name = 'Asha K.' where user_id = '49800000-0000-4000-8000-000000000001';

-- Owner B moves it on, then loses access; stale versions write nothing.
set role authenticated;
select set_config('request.jwt.claim.sub','49800000-0000-4000-8000-000000000002',true);
select public.test_assert((public.transition_order('49800000-0000-4000-8000-0000000000a1','preparing',2)->>'status') = 'preparing', 'owner B moves the order on');
do $$ begin
  perform public.transition_order('49800000-0000-4000-8000-0000000000a1','out_for_delivery',2);
  raise exception 'stale version accepted';
exception when serialization_failure then null; end $$;
reset role;
select public.test_assert((select count(*) = 2 from public.order_status_actors a join public.order_status_history h on h.id = a.history_id where h.order_id = '49800000-0000-4000-8000-0000000000a1'), 'a rejected transition snapshots nothing');
delete from public.business_memberships where user_id = '49800000-0000-4000-8000-000000000002';

-- Owner A sees both names as they were, after a rename and a removal.
set role authenticated;
select set_config('request.jwt.claim.sub','49800000-0000-4000-8000-000000000001',true);
select public.test_assert((select string_agg(h.status || ':' || a.actor_name, ',' order by h.id) from public.order_status_history h join public.order_status_actors a on a.history_id = h.id where h.order_id = '49800000-0000-4000-8000-0000000000a1') = 'accepted:Asha Kadam,preparing:Ravi', 'snapshots survive rename and removal');
do $$ begin
  begin perform actor_id from public.order_status_actors; raise exception 'owner read actor ids'; exception when insufficient_privilege then null; end;
  begin perform changed_by from public.order_status_history; raise exception 'owner read changed_by'; exception when insufficient_privilege then null; end;
  begin insert into public.order_status_actors(history_id,actor_name) select id,'Forged' from public.order_status_history limit 1; raise exception 'owner forged a snapshot'; exception when insufficient_privilege then null; end;
  begin update public.business_memberships set display_name = 'Self rename'; raise exception 'owner renamed membership'; exception when insufficient_privilege then null; end;
end $$;
select public.test_assert((select display_name = 'Asha K.' from public.business_memberships where business_id = '10000000-0000-4000-8000-000000000001' and user_id = '49800000-0000-4000-8000-000000000001'), 'owner reads own restaurant name');

-- Removed owner, other restaurant's owner and the customer see no names.
select set_config('request.jwt.claim.sub','49800000-0000-4000-8000-000000000002',true);
select public.test_assert((select count(*) = 0 from public.order_status_actors), 'removed owner loses snapshot access');
do $$ begin perform public.transition_order('49800000-0000-4000-8000-0000000000a1','out_for_delivery',3); raise exception 'removed owner transitioned'; exception when insufficient_privilege then null; end $$;
select set_config('request.jwt.claim.sub','49800000-0000-4000-8000-000000000003',true);
select public.test_assert((select count(*) = 0 from public.order_status_actors a where a.history_id in (select id from public.order_status_history)) and (select count(*) = 0 from public.order_status_history where order_id = '49800000-0000-4000-8000-0000000000a1'), 'other restaurant sees neither history nor names');
select set_config('request.jwt.claim.sub','49800000-0000-4000-8000-000000000004',true);
select public.test_assert((select string_agg(status, ',' order by id) from public.order_status_history where order_id = '49800000-0000-4000-8000-0000000000a1') = 'placed,accepted,preparing', 'customer timeline keeps status steps');
select public.test_assert((select count(*) = 0 from public.order_status_actors), 'customer sees no owner names');
select public.test_assert((select count(*) = 3 from public.order_status_history h left join public.order_status_actors a on a.history_id = h.id where h.order_id = '49800000-0000-4000-8000-0000000000a1' and a.actor_name is null), 'embedded names resolve to nothing for customers');
do $$ begin
  begin perform changed_by from public.order_status_history; raise exception 'customer read changed_by'; exception when insufficient_privilege then null; end;
  begin perform * from public.order_status_history; raise exception 'customer read every history column'; exception when insufficient_privilege then null; end;
  begin perform public.redact_owner_history_names('49800000-0000-4000-8000-000000000001'); raise exception 'customer redacted names'; exception when insufficient_privilege then null; end;
end $$;
reset role;

-- Redaction for account deletion replaces only that account's snapshots.
set role service_role;
select public.test_assert(public.redact_owner_history_names('49800000-0000-4000-8000-000000000001') >= 1, 'redaction reports changed steps');
select public.test_assert((select a.actor_name = 'Former owner' and a.actor_id is null from public.order_status_actors a join public.order_status_history h on h.id = a.history_id where h.order_id = '49800000-0000-4000-8000-0000000000a1' and h.status = 'accepted'), 'redacted step reads Former owner without an id');
select public.test_assert((select a.actor_name = 'Ravi' and a.actor_id = '49800000-0000-4000-8000-000000000002' from public.order_status_actors a join public.order_status_history h on h.id = a.history_id where h.order_id = '49800000-0000-4000-8000-0000000000a1' and h.status = 'preparing'), 'other owners keep their names');
do $$ begin
  begin perform public.redact_owner_history_names(null); raise exception 'null redaction accepted'; exception when null_value_not_allowed then null; end;
  begin update public.business_memberships set display_name = '' where user_id = '49800000-0000-4000-8000-000000000001'; raise exception 'trusted setup stored an empty name'; exception when check_violation then null; end;
end $$;
reset role;
rollback;
