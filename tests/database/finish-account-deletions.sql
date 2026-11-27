\set ON_ERROR_STOP on
-- The finisher's RPCs (#51 slice 2a): prepare_account_auth_deletion and complete_account_auth_deletion. Self-contained; rolls back.
-- Users: 1 requests deletion (has a delivered order, profile, address, token), 2 is an untouched active control, 3 never signed in again.
begin;
insert into auth.users(id) select ('52000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,3) n;
insert into auth.sessions(id,user_id) select ('52000000-0000-4000-b000-'||lpad(n::text,12,'0'))::uuid, ('52000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,3) n;
create function public.f_user(n integer) returns uuid language sql immutable as $$ select ('52000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
insert into public.profiles(user_id,full_name) select public.f_user(n),'Customer '||n from generate_series(1,2) n;
insert into public.customer_addresses(customer_id,label,house,street_area,latitude,longitude,location_source)
  select public.f_user(n),'home','House','Road',0.5,0.5,'pin' from generate_series(1,2) n;
insert into public.orders(id,business_id,customer_id,status,customer_name,customer_phone,delivery_address_line,latitude,longitude,address_label,address_custom_label,address_house,address_street_area,address_landmark,address_location_source,saved_address_id,saved_address_version,placed_from_distance_m,subtotal_paise,delivery_fee_paise,total_paise,idempotency_key,request_hash)
  select ('52000000-0000-4000-9000-'||lpad(n::text,12,'0'))::uuid,'10000000-0000-4000-8000-000000000001',public.f_user(n),'delivered','Customer '||n,'9876500000','Line',19.03,73.02,'home','Mum','House','Road','Near','pin',gen_random_uuid(),1,120,100,50,150,gen_random_uuid(),'h'||n
  from generate_series(1,2) n;

-- Grants: service_role only; the completion table is private.
do $$ declare f text; begin
  foreach f in array array['public.prepare_account_auth_deletion(uuid)','public.complete_account_auth_deletion(uuid,timestamptz)'] loop
    perform public.test_assert(has_function_privilege('service_role',f,'execute') and not has_function_privilege('authenticated',f,'execute') and not has_function_privilege('anon',f,'execute'),'service-only '||f);
  end loop;
  perform public.test_assert(not has_table_privilege('service_role','customer_lifecycle_private.account_deletion_completions','select,insert,update,delete')
    and not has_table_privilege('authenticated','customer_lifecycle_private.account_deletion_completions','select,insert,update,delete'),'completion table private');
end $$;
-- anon and authenticated are refused outright.
set local role anon;
do $$ begin
  begin perform public.prepare_account_auth_deletion(public.f_user(1)); raise exception 'anon prepared'; exception when insufficient_privilege then null; end;
  begin perform public.complete_account_auth_deletion(public.f_user(1),null); raise exception 'anon completed'; exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role authenticated;
do $$ begin
  begin perform public.prepare_account_auth_deletion(public.f_user(1)); raise exception 'authenticated prepared'; exception when insufficient_privilege then null; end;
  begin perform public.complete_account_auth_deletion(public.f_user(1)); raise exception 'authenticated completed'; exception when insufficient_privilege then null; end;
end $$;
reset role;

-- An active (not pending) account must never be handed to the Auth delete, and nothing is cleaned up.
set local role service_role;
select public.test_assert(public.prepare_account_auth_deletion(public.f_user(2))='not_pending','active account is refused');
select public.test_assert(public.prepare_account_auth_deletion(public.f_user(3))='not_pending','account with no row is refused');
reset role;
select public.test_assert((select count(*)=1 from public.profiles where user_id=public.f_user(2)),'refused prepare removes nothing');
-- Completion is refused while the auth user exists.
set local role service_role;
select public.test_assert(public.complete_account_auth_deletion(public.f_user(2))=false,'no completion while the user exists');
reset role;
select public.test_assert((select count(*)=0 from customer_lifecycle_private.account_deletion_completions),'nothing recorded yet');

-- User 1 requests deletion, then a profile and address land late (the RLS helper is lock-free).
select set_config('request.jwt.claim.sub', public.f_user(1)::text, false);
select set_config('request.jwt.claims', jsonb_build_object('sub',public.f_user(1),'session_id','52000000-0000-4000-b000-000000000001')::text, false);
set local role authenticated; select public.request_account_deletion(); reset role;
insert into public.profiles(user_id,full_name) values (public.f_user(1),'Late');
insert into public.customer_addresses(customer_id,label,house,street_area,latitude,longitude,location_source) values (public.f_user(1),'work','House','Road',0.5,0.5,'pin');

set local role service_role;
create temp table listed as select * from public.list_accounts_pending_auth_deletion();
select public.test_assert((select count(*)=1 from listed where customer_id=public.f_user(1)),'pending account is listed');
select public.test_assert(public.prepare_account_auth_deletion(public.f_user(1))='pending','pending account may be deleted');
-- Prepare is repeatable (a retry after a failed admin call).
select public.test_assert(public.prepare_account_auth_deletion(public.f_user(1))='pending','prepare is idempotent');
reset role;
select public.test_assert((select count(*)=0 from public.profiles where user_id=public.f_user(1)) and (select count(*)=0 from public.customer_addresses where customer_id=public.f_user(1)),'late writes cleaned');
select public.test_assert((select count(*)=1 from public.profiles where user_id=public.f_user(2)),'control customer untouched');
select public.test_assert((select customer_id is null and customer_deleted_at is not null and customer_name='Customer 1' from public.orders where id='52000000-0000-4000-9000-000000000001'),'order already unlinked and stamped, snapshot kept for retention');
-- Still not complete: the user is there.
set local role service_role;
select public.test_assert(public.complete_account_auth_deletion(public.f_user(1),(select requested_at from listed))=false,'not complete before the admin delete');
reset role;

-- The Auth admin delete (here as the table owner; the Edge Function calls the admin API).
delete from auth.users where id=public.f_user(1);
select public.test_assert((select count(*)=0 from customer_lifecycle_private.accounts where customer_id=public.f_user(1)),'accounts row cascades away');
select public.test_assert((select customer_id is null and customer_deleted_at is not null from public.orders where id='52000000-0000-4000-9000-000000000001'),'order stays unlinked and stamped after the Auth delete');
select public.test_assert((select count(*)=0 from public.orders where customer_id=public.f_user(1)),'no order points at the removed user');
set local role service_role;
select public.test_assert(public.prepare_account_auth_deletion(public.f_user(1))='gone','a removed user reads as gone (lost response retry)');
select public.test_assert(public.complete_account_auth_deletion(public.f_user(1),(select requested_at from listed))=true,'completion recorded');
select public.test_assert(public.complete_account_auth_deletion(public.f_user(1),(select requested_at from listed))=true,'completion is idempotent');
select public.test_assert((select count(*)=0 from public.list_accounts_pending_auth_deletion() where customer_id=public.f_user(1)),'no longer listed');
reset role;
select public.test_assert((select count(*)=1 and bool_and(requested_at is not null) from customer_lifecycle_private.account_deletion_completions where customer_id=public.f_user(1)),'exactly one completion row');
-- A user that never existed reads as gone and may be recorded (the retry case where the first response was lost).
set local role service_role;
select public.test_assert(public.prepare_account_auth_deletion(public.f_user(4))='gone','unknown id reads as gone');
select public.test_assert(public.complete_account_auth_deletion(public.f_user(4),null), 'manual completion succeeds without a requested_at');
reset role;
select public.test_assert((select count(*)=1 and bool_and(requested_at is null and completed_at is not null)
  from customer_lifecycle_private.account_deletion_completions where customer_id=public.f_user(4)), 'manual completion records a null request time');
rollback;
