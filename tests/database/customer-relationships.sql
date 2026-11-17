\set ON_ERROR_STOP on
begin;
select public.test_assert((select relrowsecurity from pg_class where oid='public.customer_businesses'::regclass),'relationship RLS');
select public.test_assert(not exists(select 1 from pg_publication_tables where tablename='customer_businesses'),'no relationship realtime');
select public.test_assert(not has_table_privilege('anon','public.customer_businesses','select') and has_table_privilege('authenticated','public.customer_businesses','select'),'read grants');
select public.test_assert(not has_table_privilege('authenticated','public.customer_businesses','insert,update,delete'),'no direct writes');
select public.test_assert(not has_table_privilege('authenticated','customer_lifecycle_private.accounts','select,insert,update,delete'),'private lock table');
select public.test_assert(not has_function_privilege('authenticated','customer_lifecycle_private.lock_account(uuid)','execute'),'cannot choose lock identity');
do $$ declare f text; begin
 foreach f in array array['public.join_business(text)','customer_lifecycle_private.join_business(text)'] loop
  perform public.test_assert(has_function_privilege('authenticated',f,'execute') and not has_function_privilege('anon',f,'execute') and not has_function_privilege('service_role',f,'execute'),'join grant '||f);
  perform public.test_assert((select proconfig @> array['search_path=""'] and prosecdef=(f like 'customer_lifecycle_private.%') from pg_proc where oid=f::regprocedure),'trusted boundary '||f);
 end loop;
end $$;
-- Unlike legacy test fixtures, these users start genuinely unlinked.
alter table auth.users disable trigger test_customer_relationships;
insert into auth.users(id) values ('35200000-0000-4000-8000-000000000001'),('35200000-0000-4000-8000-000000000002');
alter table auth.users enable trigger test_customer_relationships;
insert into auth.sessions(id,user_id) select id,id from auth.users where id::text like '35200000-%';
create temp table before_relationships as select to_jsonb(a) row from public.customer_addresses a;
create temp table receipts(receipt jsonb);
grant all on receipts to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub','35200000-0000-4000-8000-000000000001',true);
-- Session validation even through private implementation.
do $$ declare claim text; begin
 foreach claim in array array['{}','{"session_id":"bad"}','{"session_id":"35200000-0000-4000-8000-000000000099"}','{"session_id":"35200000-0000-4000-8000-000000000002"}'] loop
  perform set_config('request.jwt.claims',claim,true);
  begin perform customer_lifecycle_private.join_business('ammu-sammu'); raise exception 'bad session accepted'; exception when insufficient_privilege then null; end;
 end loop;
end $$;
select set_config('request.jwt.claims','{"session_id":"35200000-0000-4000-8000-000000000001"}',true);
insert into receipts select public.join_business('ammu-sammu');
select public.test_assert(public.join_business('ammu-sammu')=(select receipt from receipts),'join idempotent: timestamp/generation unchanged');
select public.test_assert((select count(*)=1 from public.customer_businesses),'only own relationship');
select public.join_business('kokani-dine-inn');
do $$ begin
 begin perform public.join_business('unknown'); raise exception 'unknown business accepted'; exception when invalid_parameter_value then null; end;
 begin update public.customer_businesses set state='leave_pending'; raise exception 'direct update accepted'; exception when insufficient_privilege then null; end;
end $$;
reset role;
-- Expired/revoked session and pending account checks.
update auth.sessions set not_after=clock_timestamp()-interval '1 second' where id='35200000-0000-4000-8000-000000000001';
set local role authenticated;
do $$ begin begin perform public.join_business('ammu-sammu'); raise exception 'expired session accepted'; exception when insufficient_privilege then null; end; end $$;
reset role;
update auth.sessions set not_after=null where id='35200000-0000-4000-8000-000000000001';
update public.customer_businesses set state='leave_pending' where customer_id='35200000-0000-4000-8000-000000000001' and business_id='10000000-0000-4000-8000-000000000001';
set local role authenticated;
do $$ declare detail text; begin
 begin perform public.join_business('ammu-sammu'); raise exception 'pending join accepted'; exception when sqlstate 'PT409' then get stacked diagnostics detail=pg_exception_detail; perform public.test_assert(detail='BUSINESS_LIFECYCLE_PENDING','pending join code'); end;
 perform public.join_business('kokani-dine-inn');
end $$;
reset role;
update customer_lifecycle_private.accounts set state='deletion_pending' where customer_id='35200000-0000-4000-8000-000000000001';
set local role authenticated;
do $$ declare detail text; begin
 begin perform public.join_business('kokani-dine-inn'); raise exception 'pending account joined'; exception when sqlstate 'PT409' then get stacked diagnostics detail=pg_exception_detail; perform public.test_assert(detail='ACCOUNT_LIFECYCLE_PENDING','pending account code'); end;
end $$;
reset role;
update customer_lifecycle_private.accounts set state='active' where customer_id='35200000-0000-4000-8000-000000000001';
-- Simulate completed leave with a retained marker; explicit rejoin gets a new generation.
update public.customer_businesses set state='left' where customer_id='35200000-0000-4000-8000-000000000001' and business_id='10000000-0000-4000-8000-000000000001';
set local role authenticated;
select public.test_assert(public.join_business('ammu-sammu')->>'generation'<>(select receipt->>'generation' from receipts),'fresh generation after relationship removal');
select set_config('request.jwt.claim.sub','35200000-0000-4000-8000-000000000002',true);
select public.test_assert((select count(*)=0 from public.customer_businesses),'cross-user relationship isolation');
reset role;
select public.test_assert((select count(*)=1 from customer_lifecycle_private.accounts where customer_id='35200000-0000-4000-8000-000000000001'),'stable account row');
select public.test_assert(not exists((select to_jsonb(a) from public.customer_addresses a) except (select row from before_relationships)),'shared addresses unchanged');
-- All uncommitted join effects, including account lock creation, roll back.
rollback;
