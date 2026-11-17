\set ON_ERROR_STOP on
-- #60: final-schema contract. Self-contained and rolled back for #131's runner.
begin;
create or replace function public.test_assert(ok boolean, message text) returns void language plpgsql as $$ begin if not coalesce(ok,false) then raise exception 'assertion failed: %', message; end if; end $$;
grant execute on function public.test_assert(boolean,text) to anon, authenticated;
select public.test_assert(not has_function_privilege('anon','public.save_restaurant_settings(text,text,text,numeric,numeric,integer)','execute'), 'anonymous callers cannot execute the settings operation');
select public.test_assert(not has_schema_privilege('anon','restaurant_settings_private','usage'), 'private implementation is not available to anonymous callers');
select public.test_assert(not has_any_column_privilege('authenticated','public.businesses','UPDATE'), 'owners have no direct column or table update permission');
select public.test_assert(not (select prosecdef from pg_proc where oid='public.save_restaurant_settings(text,text,text,numeric,numeric,integer)'::regprocedure), 'API wrapper runs as invoker');
insert into auth.users(id) values ('46000000-0000-4000-8000-000000000001'),('46000000-0000-4000-8000-000000000002'),('46000000-0000-4000-8000-000000000003');
insert into auth.sessions(id,user_id) select id,id from auth.users where id::text like '46000000-%';
insert into public.business_memberships(business_id,user_id,role) values
 ('10000000-0000-4000-8000-000000000001','46000000-0000-4000-8000-000000000001','admin'),
 ('10000000-0000-4000-8000-000000000002','46000000-0000-4000-8000-000000000002','admin');
create temporary table settings_before as select to_jsonb(b) as value from public.businesses b where slug='ammu-sammu';
grant select on settings_before to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub','46000000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"session_id":"46000000-0000-4000-8000-000000000001"}',true);
-- All invalid calls must retain every column and the version, even when other
-- fields would have changed. Errors carry a field identifier for a future form.
do $$ declare test jsonb; detail text; v integer; begin
 select settings_version into v from public.businesses where slug='ammu-sammu';
 for test in select value from jsonb_array_elements('[
  {"phone":null,"field":"contactPhone"}, {"phone":"+12025550123","field":"contactPhone"},
  {"phone":"+910123456789","field":"contactPhone"}, {"phone":"+919876543210x","field":"contactPhone"},
  {"whatsapp":"+912223456789","field":"whatsappPhone"}, {"whatsapp":"","field":"whatsappPhone"},
  {"fee":-1,"field":"deliveryFeePaise"}, {"fee":100001,"field":"deliveryFeePaise"},
  {"fee":0.1,"field":"deliveryFeePaise"}, {"fee":null,"field":"deliveryFeePaise"},
  {"fee":"NaN","field":"deliveryFeePaise"}, {"fee":"Infinity","field":"deliveryFeePaise"},
  {"min":-1,"field":"minOrderPaise"}, {"min":1000001,"field":"minOrderPaise"},
  {"min":0.1,"field":"minOrderPaise"}, {"min":null,"field":"minOrderPaise"}
 ]'::jsonb) loop
  begin
   perform public.save_restaurant_settings('ammu-sammu',case when test ? 'phone' then test->>'phone' else '+919876543210' end,
    case when test ? 'whatsapp' then test->>'whatsapp' else '+919876543211' end,
    case when test ? 'fee' then (test->>'fee')::numeric else 1234 end,
    case when test ? 'min' then (test->>'min')::numeric else 5678 end,v);
   raise exception 'accepted invalid settings: %',test;
  exception when invalid_parameter_value then
   get stacked diagnostics detail = pg_exception_detail;
   perform public.test_assert(detail=test->>'field','server identifies invalid field');
  end;
 end loop;
end $$;
reset role;
select public.test_assert((select to_jsonb(b)=s.value from public.businesses b,settings_before s where b.slug='ammu-sammu'), 'invalid settings leave every field and version unchanged');
set local role authenticated;
-- National/format normalization is the service's job; SQL takes canonical values.
create temporary table settings_saved as select public.save_restaurant_settings('ammu-sammu','+912223456789','+919876543210',100000,1000000,settings_version) value from public.businesses where slug='ammu-sammu';
select public.test_assert((select saved.value->>'contact_phone'='+912223456789' and (saved.value->>'delivery_fee_paise')::int=100000 and (saved.value->>'min_order_paise')::int=1000000 and (saved.value->>'settings_version')::int=(s.value->>'settings_version')::int+1 from settings_saved saved,settings_before s), 'upper bounds and a landline save together and advance version');
reset role;
select public.test_assert((select to_jsonb(b)-array['contact_phone','whatsapp_phone','delivery_fee_paise','min_order_paise','settings_version']=s.value-array['contact_phone','whatsapp_phone','delivery_fee_paise','min_order_paise','settings_version'] from public.businesses b,settings_before s where b.slug='ammu-sammu'), 'no unrelated business column changes');
set local role authenticated;
do $$ declare v integer; begin
 select (value->>'settings_version')::int into v from settings_before;
 begin perform public.save_restaurant_settings('ammu-sammu','+919876543212',null,0,0,v); raise exception 'stale save succeeded'; exception when serialization_failure then null; end;
 begin perform public.save_restaurant_settings('ammu-sammu','+919876543212',null,0,0,null); raise exception 'missing version succeeded'; exception when serialization_failure then null; end;
end $$;
select public.save_restaurant_settings('ammu-sammu','+919876543210',null,0,0,settings_version) from public.businesses where slug='ammu-sammu';
select public.test_assert((select whatsapp_phone is null and delivery_fee_paise=0 and min_order_paise=0 from public.businesses where slug='ammu-sammu'), 'optional WhatsApp and zero lower bounds supported');
-- Another restaurant's owner, customer, missing/unknown/expired session and
-- revoked membership all fail even when they possess a previously valid JWT.
do $$ begin
 begin perform public.save_restaurant_settings('kokani-dine-inn','+919876543210',null,0,0,1); raise exception 'cross-tenant save succeeded'; exception when insufficient_privilege then null; end;
 begin perform public.save_restaurant_settings('unknown','+919876543210',null,0,0,1); raise exception 'unknown restaurant save succeeded'; exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','46000000-0000-4000-8000-000000000003',true);
select set_config('request.jwt.claims','{"session_id":"46000000-0000-4000-8000-000000000003"}',true);
do $$ begin perform public.save_restaurant_settings('ammu-sammu','+919876543210',null,0,0,1); raise exception 'customer save succeeded'; exception when insufficient_privilege then null; end $$;
select set_config('request.jwt.claim.sub','46000000-0000-4000-8000-000000000001',true);
do $$ begin perform public.save_restaurant_settings('ammu-sammu','+919876543210',null,0,0,1); raise exception 'other user session succeeded'; exception when insufficient_privilege then null; end $$;
select set_config('request.jwt.claims','{}',true);
do $$ begin perform public.save_restaurant_settings('ammu-sammu','+919876543210',null,0,0,1); raise exception 'missing session succeeded'; exception when insufficient_privilege then null; end $$;
select set_config('request.jwt.claims','{"session_id":"46000000-0000-4000-8000-000000000099"}',true);
do $$ begin perform public.save_restaurant_settings('ammu-sammu','+919876543210',null,0,0,1); raise exception 'unknown session succeeded'; exception when insufficient_privilege then null; end $$;
reset role;
update auth.sessions set not_after=now()-interval '1 second' where id='46000000-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claims','{"session_id":"46000000-0000-4000-8000-000000000001"}',true);
do $$ begin perform public.save_restaurant_settings('ammu-sammu','+919876543210',null,0,0,1); raise exception 'expired session succeeded'; exception when insufficient_privilege then null; end $$;
reset role;
update auth.sessions set not_after=null where id='46000000-0000-4000-8000-000000000001';
delete from public.business_memberships where user_id='46000000-0000-4000-8000-000000000001';
set local role authenticated;
do $$ begin perform public.save_restaurant_settings('ammu-sammu','+919876543210',null,0,0,1); raise exception 'revoked owner save succeeded'; exception when insufficient_privilege then null; end $$;
reset role;
rollback;
