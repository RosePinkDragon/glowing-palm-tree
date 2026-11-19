\set ON_ERROR_STOP on
-- Owner login log, ownership check and rate limits (#50). Everything rolls back; the same suite runs against
-- both final PostGIS layouts. The concurrent behaviour is covered by the races in run.sh.
begin;

-- The log is developer-only, never realtime, and has no column that could hold a code or token.
select public.test_assert((select relrowsecurity from pg_class where oid='public.owner_login_attempts'::regclass),'owner log RLS enabled');
select public.test_assert(not exists(select 1 from pg_policy where polrelid='public.owner_login_attempts'::regclass),'owner log has no policy');
select public.test_assert(not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='owner_login_attempts'),'owner log is never published to realtime');
select public.test_assert((select array_agg(attname::text order by attnum)=array['id','phone','business_id','app','ip','outcome','created_at'] from pg_attribute where attrelid='public.owner_login_attempts'::regclass and attnum>0 and not attisdropped),'owner log columns hold no code or token');
select public.test_assert((select array_agg(enumlabel::text order by enumsortorder)=array['non_owner','rate_limited','sent_owner','provider_failed'] from pg_enum where enumtypid='public.owner_login_outcome'::regtype),'owner log outcomes');
select public.test_assert(not has_table_privilege('anon','public.owner_login_attempts','select') and not has_table_privilege('authenticated','public.owner_login_attempts','select'),'clients cannot read the owner log');
select public.test_assert(not has_table_privilege('anon','public.owner_login_attempts','insert,update,delete') and not has_table_privilege('authenticated','public.owner_login_attempts','insert,update,delete'),'clients cannot write the owner log');
select public.test_assert(has_table_privilege('service_role','public.owner_login_attempts','select') and not has_table_privilege('service_role','public.owner_login_attempts','insert') and not has_table_privilege('service_role','public.owner_login_attempts','update') and not has_table_privilege('service_role','public.owner_login_attempts','delete'),'developers read, only definer functions write');
do $$ declare fn text; begin
 foreach fn in array array['claim_owner_code_attempt(text,text,text,text)','mark_owner_code_failed(uuid)','purge_expired_owner_login_attempts()'] loop
  perform public.test_assert(has_function_privilege('service_role','public.'||fn,'execute') and not has_function_privilege('anon','public.'||fn,'execute') and not has_function_privilege('authenticated','public.'||fn,'execute'),'owner login function trusted only: '||fn);
  perform public.test_assert((select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid=('public.'||fn)::regprocedure),'owner login function definer with empty search path: '||fn);
 end loop;
end $$;

-- Fixtures. Supabase Auth stores phones without the plus sign.
insert into auth.users(id,phone) values
 ('56000000-0000-4000-8000-000000000001','919876500001'),  -- owner of Ammu Sammu
 ('56000000-0000-4000-8000-000000000002','919876500002'),  -- owner of Kokani Dine Inn
 ('56000000-0000-4000-8000-000000000003','919876500003'),  -- customer only
 ('56000000-0000-4000-8000-000000000004',null);            -- email-only account
insert into public.business_memberships(business_id,user_id,role) values
 ('10000000-0000-4000-8000-000000000001','56000000-0000-4000-8000-000000000001','admin'),
 ('10000000-0000-4000-8000-000000000002','56000000-0000-4000-8000-000000000002','admin'),
 ('10000000-0000-4000-8000-000000000001','56000000-0000-4000-8000-000000000004','admin');
create function public.test_claim(p_phone text,p_slug text,p_ip text default '203.0.113.1',p_app text default 'ammu-sammu-admin') returns public.owner_login_attempts
language plpgsql as $$ declare r record; a public.owner_login_attempts; begin
 select * into r from public.claim_owner_code_attempt(p_phone,p_slug,p_ip,p_app);
 select * into a from public.owner_login_attempts where id=r.attempt_id;

 a.id := coalesce(a.id,'00000000-0000-0000-0000-000000000000');
 perform set_config('test.is_owner',r.is_owner::text,true);
 perform set_config('test.allowed',r.allowed::text,true);
 return a;
end $$;
grant execute on function public.test_claim(text,text,text,text) to service_role;
grant select on all tables in schema public to service_role;
set local role service_role;

-- Ownership: only an admin member of that restaurant, matched on the full phone number.
select public.test_assert((select outcome='sent_owner' and business_id='10000000-0000-4000-8000-000000000001' and app='ammu-sammu-admin' and ip='203.0.113.1'::inet and phone='+919876500001' from public.test_claim('+919876500001','ammu-sammu','203.0.113.1')) and current_setting('test.is_owner')='true' and current_setting('test.allowed')='true','owner of the restaurant is authorised and logged');
select public.test_assert((select outcome='non_owner' from public.test_claim('+919876500001','kokani-dine-inn','203.0.113.2')) and current_setting('test.is_owner')='false' and current_setting('test.allowed')='true','an owner of another restaurant is a non-owner here');
select public.test_assert((select outcome='non_owner' from public.test_claim('+919876500003','ammu-sammu','203.0.113.3')) and current_setting('test.is_owner')='false','a customer is a non-owner');
select public.test_assert((select outcome='non_owner' and business_id is null from public.test_claim('+919876500001','no-such-restaurant','203.0.113.4')) and current_setting('test.is_owner')='false','unknown restaurant is a non-owner with no business');
select public.test_assert((select outcome='non_owner' and business_id is null from public.test_claim('+919876500002',null,'203.0.113.5')) and current_setting('test.is_owner')='false','missing restaurant is a non-owner');
select public.test_assert((select outcome='non_owner' from public.test_claim('+19876500001','ammu-sammu','203.0.113.6')) and current_setting('test.is_owner')='false','a different number sharing a suffix is not the owner');
select public.test_assert((select outcome='non_owner' from public.test_claim('+919876500009','ammu-sammu','203.0.113.7')) and current_setting('test.is_owner')='false','unknown number is a non-owner');

-- Input validation raises; nothing is logged for it.
do $$ declare n integer; begin
 select count(*) into n from public.owner_login_attempts;
 begin perform * from public.claim_owner_code_attempt('9876500001','ammu-sammu','203.0.113.8','ammu-sammu-admin'); raise exception 'unnormalised phone accepted'; exception when invalid_parameter_value then null; end;
 begin perform * from public.claim_owner_code_attempt(null,'ammu-sammu','203.0.113.8','ammu-sammu-admin'); raise exception 'null phone accepted'; exception when invalid_parameter_value then null; end;
 begin perform * from public.claim_owner_code_attempt('+0123456789','ammu-sammu','203.0.113.8','ammu-sammu-admin'); raise exception 'leading zero country code accepted'; exception when invalid_parameter_value then null; end;
 begin perform * from public.claim_owner_code_attempt('+919876500001','ammu-sammu','203.0.113.8','Bad App'); raise exception 'bad app accepted'; exception when invalid_parameter_value then null; end;
 begin perform * from public.claim_owner_code_attempt('+919876500001','ammu-sammu','203.0.113.8',null); raise exception 'null app accepted'; exception when invalid_parameter_value then null; end;
 perform public.test_assert((select count(*)=n from public.owner_login_attempts),'rejected input writes nothing');
end $$;
-- Addresses: a missing or malformed IP is logged as NULL, a network mask is dropped, IPv6 works.
select public.test_assert((select ip is null from public.test_claim('+919876500101','ammu-sammu',null)),'missing ip stored as null');
select public.test_assert((select ip is null from public.test_claim('+919876500102','ammu-sammu','not an address')),'malformed ip stored as null');
select public.test_assert((select ip='198.51.100.9'::inet and masklen(ip)=32 from public.test_claim('+919876500103','ammu-sammu','198.51.100.9/24')),'mask dropped from ip');
select public.test_assert((select ip='2001:db8::1'::inet from public.test_claim('+919876500104','ammu-sammu','2001:db8::1')),'ipv6 stored');
reset role;
delete from public.owner_login_attempts;
set local role service_role;

-- Per phone: 3 admitted per 15 minutes, for owners and non-owners alike. Refusals are logged and never
-- extend the lockout, so the first admitted attempt aging out reopens the window.
do $$ declare r record; begin
 for i in 1..3 loop
  select * into r from public.claim_owner_code_attempt('+919876500001','ammu-sammu','198.51.100.'||i,'ammu-sammu-admin');
  perform public.test_assert(r.allowed and r.is_owner,'owner request '||i||' allowed');
 end loop;
 select * into r from public.claim_owner_code_attempt('+919876500001','ammu-sammu','198.51.100.4','ammu-sammu-admin');
 perform public.test_assert(not r.allowed and r.is_owner and r.attempt_id is not null,'fourth owner request in 15 minutes refused and logged');
 for i in 1..3 loop
  select * into r from public.claim_owner_code_attempt('+919876500009','ammu-sammu','198.51.101.'||i,'ammu-sammu-admin');
  perform public.test_assert(r.allowed and not r.is_owner,'non-owner request '||i||' allowed');
 end loop;
 select * into r from public.claim_owner_code_attempt('+919876500009','ammu-sammu','198.51.101.4','ammu-sammu-admin');
 perform public.test_assert(not r.allowed and not r.is_owner,'fourth non-owner request refused too');
 perform public.test_assert((select count(*)=1 from public.owner_login_attempts where phone='+919876500001' and outcome='rate_limited'),'owner refusal logged once');
 perform public.test_assert((select count(*)=3 from public.owner_login_attempts where phone='+919876500001' and outcome='sent_owner'),'only admitted requests are sent_owner');
 perform public.test_assert((select count(*)=1 from public.owner_login_attempts where phone='+919876500009' and outcome='rate_limited'),'non-owner refusal logged');
 -- Refusals do not count: more attempts leave the admitted count at three.
 select * into r from public.claim_owner_code_attempt('+919876500001','ammu-sammu','198.51.100.5','ammu-sammu-admin');
 perform public.test_assert(not r.allowed,'still refused');
 perform public.test_assert((select count(*)=3 from public.owner_login_attempts where phone='+919876500001' and outcome<>'rate_limited'),'refusals not counted');
end $$;
reset role;
-- The window slides: age the three admitted attempts beyond 15 minutes.
update public.owner_login_attempts set created_at=created_at-interval '16 minutes' where phone='+919876500001' and outcome='sent_owner';
set local role service_role;
select public.test_assert((select allowed from public.claim_owner_code_attempt('+919876500001','ammu-sammu','198.51.100.6','ammu-sammu-admin')),'window reopens after 15 minutes');
reset role;
-- Per phone per day: ten admitted. The three above (aged 16 minutes), the one just admitted and five more make nine.
insert into public.owner_login_attempts(phone,business_id,app,ip,outcome,created_at)
 select '+919876500001','10000000-0000-4000-8000-000000000001','ammu-sammu-admin',null,'sent_owner',now()-interval '2 hours' from generate_series(1,5);
set local role service_role;
select public.test_assert((select allowed from public.claim_owner_code_attempt('+919876500001','ammu-sammu','198.51.100.7','ammu-sammu-admin')),'tenth request of the day still allowed');
select public.test_assert(not (select allowed from public.claim_owner_code_attempt('+919876500001','ammu-sammu','198.51.100.8','ammu-sammu-admin')),'eleventh request of the day refused although the 15 minute window is clear');
reset role;
update public.owner_login_attempts set created_at=created_at-interval '25 hours' where phone='+919876500001';
set local role service_role;
select public.test_assert((select allowed from public.claim_owner_code_attempt('+919876500001','ammu-sammu','198.51.100.9','ammu-sammu-admin')),'daily window slides');
reset role;
delete from public.owner_login_attempts;
set local role service_role;

-- Per IP: ten admitted per hour across different numbers; another address is separate, and with no trusted address the limit is skipped.
do $$ declare r record; begin
 for i in 1..10 loop
  select * into r from public.claim_owner_code_attempt('+9198765002'||lpad(i::text,2,'0'),'ammu-sammu','192.0.2.50','ammu-sammu-admin');
  perform public.test_assert(r.allowed,'ip request '||i||' allowed');
 end loop;
 select * into r from public.claim_owner_code_attempt('+919876500299','ammu-sammu','192.0.2.50','ammu-sammu-admin');
 perform public.test_assert(not r.allowed,'eleventh request from one address refused');
 select * into r from public.claim_owner_code_attempt('+919876500298','ammu-sammu','192.0.2.51','ammu-sammu-admin');
 perform public.test_assert(r.allowed,'another address unaffected');
 -- No trusted address (null or malformed): stored as NULL and never limited per address, only by phone, restaurant and CAPTCHA.
 for i in 1..14 loop
  select * into r from public.claim_owner_code_attempt('+9198765003'||lpad(i::text,2,'0'),'ammu-sammu',case when i%2=0 then null else 'garbage' end,'ammu-sammu-admin');
  perform public.test_assert(r.allowed,'request '||i||' without an address allowed');
 end loop;
 perform public.test_assert((select count(*)=14 and bool_and(ip is null) from public.owner_login_attempts where phone like '+9198765003%'),'addressless requests stored with a null ip');
 select * into r from public.claim_owner_code_attempt('+919876500301','ammu-sammu',null,'ammu-sammu-admin');
 perform public.test_assert(r.allowed,'one request is still within the phone limit');
 for i in 1..2 loop select * into r from public.claim_owner_code_attempt('+919876500301','ammu-sammu',null,'ammu-sammu-admin'); end loop;
 perform public.test_assert(not r.allowed,'the phone limit still applies without an address');
end $$;
reset role;
delete from public.owner_login_attempts;

-- Per restaurant: thirty sends per hour cap the cost. Non-owner requests do not count toward it,
-- and the other restaurant is separate.
insert into public.owner_login_attempts(phone,business_id,app,ip,outcome)
 select '+9198765004'||lpad(n::text,2,'0'),'10000000-0000-4000-8000-000000000001','ammu-sammu-admin',null,case when n%2=0 then 'sent_owner' else 'provider_failed' end::public.owner_login_outcome from generate_series(1,30) n;
insert into public.owner_login_attempts(phone,business_id,app,ip,outcome)
 select '+9198765005'||lpad(n::text,2,'0'),'10000000-0000-4000-8000-000000000001','ammu-sammu-admin',null,'non_owner' from generate_series(1,40) n;
set local role service_role;
select public.test_assert(not (select allowed from public.claim_owner_code_attempt('+919876500001','ammu-sammu','192.0.2.60','ammu-sammu-admin')),'restaurant send cap refuses an owner request');
select public.test_assert(current_setting('test.is_owner',true) is not null and (select outcome='rate_limited' from public.owner_login_attempts order by created_at desc limit 1),'refusal logged as rate_limited');
select public.test_assert((select allowed from public.claim_owner_code_attempt('+919876500002','kokani-dine-inn','192.0.2.61','kokani-dine-inn-admin')),'other restaurant unaffected');
reset role;
-- Sends older than an hour no longer count.
update public.owner_login_attempts set created_at=created_at-interval '61 minutes' where outcome in ('sent_owner','provider_failed') and business_id='10000000-0000-4000-8000-000000000001' and phone like '+9198765004%';
set local role service_role;
select public.test_assert((select allowed from public.claim_owner_code_attempt('+919876500001','ammu-sammu','192.0.2.62','ammu-sammu-admin')),'restaurant window slides');
reset role;
delete from public.owner_login_attempts;

-- Flood protection for the log itself: after 50 refusals from one address in an hour more are not stored.
insert into public.owner_login_attempts(phone,business_id,app,ip,outcome)
 select '+9198765006'||lpad(n::text,2,'0'),null,'ammu-sammu-admin','192.0.2.70','rate_limited' from generate_series(1,50) n;
insert into public.owner_login_attempts(phone,business_id,app,ip,outcome)
 select '+9198765007'||lpad(n::text,2,'0'),null,'ammu-sammu-admin','192.0.2.70','non_owner' from generate_series(1,10) n;
set local role service_role;
do $$ declare r record; begin
 select * into r from public.claim_owner_code_attempt('+919876500777','ammu-sammu','192.0.2.70','ammu-sammu-admin');
 perform public.test_assert(not r.allowed and r.attempt_id is null,'refusal beyond the log cap is answered but not stored');
 perform public.test_assert((select count(*)=50 from public.owner_login_attempts where outcome='rate_limited'),'log growth bounded');
end $$;
reset role;
delete from public.owner_login_attempts;
-- With no address the cap is per phone.
insert into public.owner_login_attempts(phone,business_id,app,ip,outcome)
 select '+919876500888',null,'ammu-sammu-admin',null,'rate_limited' from generate_series(1,50);
insert into public.owner_login_attempts(phone,business_id,app,ip,outcome)
 select '+919876500888',null,'ammu-sammu-admin',null,'non_owner' from generate_series(1,10);
set local role service_role;
do $$ declare r record; begin
 select * into r from public.claim_owner_code_attempt('+919876500888','ammu-sammu',null,'ammu-sammu-admin');
 perform public.test_assert(not r.allowed and r.attempt_id is null,'addressless refusal beyond the phone log cap is not stored');
 select * into r from public.claim_owner_code_attempt('+919876500889','ammu-sammu',null,'ammu-sammu-admin');
 perform public.test_assert(r.allowed and r.attempt_id is not null,'another phone with no address is still logged');
end $$;
reset role;
delete from public.owner_login_attempts;

-- A failed send is recorded once, and only for an authorised attempt.
set local role service_role;
do $$ declare r record; n record; begin
 select * into r from public.claim_owner_code_attempt('+919876500001','ammu-sammu','192.0.2.80','ammu-sammu-admin');
 select * into n from public.claim_owner_code_attempt('+919876500003','ammu-sammu','192.0.2.81','ammu-sammu-admin');
 perform public.test_assert(public.mark_owner_code_failed(r.attempt_id),'authorised attempt marked failed');
 perform public.test_assert((select outcome='provider_failed' from public.owner_login_attempts where id=r.attempt_id),'outcome recorded');
 perform public.test_assert(not public.mark_owner_code_failed(r.attempt_id),'second mark is a no-op');
 perform public.test_assert(not public.mark_owner_code_failed(n.attempt_id) and (select outcome='non_owner' from public.owner_login_attempts where id=n.attempt_id),'a non-owner row is never rewritten');
 perform public.test_assert(not public.mark_owner_code_failed(gen_random_uuid()) and not public.mark_owner_code_failed(null),'unknown attempt ignored');
end $$;
reset role;
delete from public.owner_login_attempts;

-- Deleting a restaurant keeps the security rows, detached.
insert into public.businesses(id,slug,name,order_prefix) values ('1f000000-0000-4000-8000-000000000001','log-test','Log test','LGT');
set local role service_role;
select public.test_assert((select business_id='1f000000-0000-4000-8000-000000000001' from public.test_claim('+919876500003','log-test','192.0.2.90')),'attempt linked to restaurant');
reset role;
delete from public.businesses where id='1f000000-0000-4000-8000-000000000001';
select public.test_assert((select count(*)=1 and bool_and(business_id is null) from public.owner_login_attempts),'rows survive restaurant deletion');
delete from public.owner_login_attempts;

-- Trusted 90-day purge: exact boundary kept, idempotent, nothing else touched.
insert into public.owner_login_attempts(id,phone,business_id,app,ip,outcome,created_at) values
 ('56100000-0000-4000-8000-000000000001','+919876500801',null,'ammu-sammu-admin',null,'non_owner',now()-interval '90 days 1 second'),
 ('56100000-0000-4000-8000-000000000002','+919876500802',null,'ammu-sammu-admin',null,'sent_owner',now()-interval '91 days'),
 ('56100000-0000-4000-8000-000000000003','+919876500803',null,'ammu-sammu-admin',null,'non_owner',now()-interval '89 days'),
 ('56100000-0000-4000-8000-000000000004','+919876500804',null,'ammu-sammu-admin',null,'rate_limited',now());
set local role service_role;
select public.test_assert(public.purge_expired_owner_login_attempts()=2,'purge removes only rows older than 90 days');
select public.test_assert(public.purge_expired_owner_login_attempts()=0,'purge retry is idempotent');
select public.test_assert((select array_agg(id order by id)=array['56100000-0000-4000-8000-000000000003'::uuid,'56100000-0000-4000-8000-000000000004'::uuid] from public.owner_login_attempts),'recent rows kept');
reset role;
-- Clients cannot call any of it, even with a valid session.
set local role authenticated;
select set_config('request.jwt.claim.sub','56000000-0000-4000-8000-000000000001',true);
do $$ begin
 begin perform * from public.claim_owner_code_attempt('+919876500001','ammu-sammu','192.0.2.99','ammu-sammu-admin'); raise exception 'client claimed an attempt'; exception when insufficient_privilege then null; end;
 begin perform public.purge_expired_owner_login_attempts(); raise exception 'client purged the log'; exception when insufficient_privilege then null; end;
 begin perform public.mark_owner_code_failed(gen_random_uuid()); raise exception 'client rewrote the log'; exception when insufficient_privilege then null; end;
 begin perform count(*) from public.owner_login_attempts; raise exception 'client read the log'; exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role anon;
do $$ begin
 begin perform * from public.claim_owner_code_attempt('+919876500001','ammu-sammu','192.0.2.99','ammu-sammu-admin'); raise exception 'anonymous claimed an attempt'; exception when insufficient_privilege then null; end;
 begin perform count(*) from public.owner_login_attempts; raise exception 'anonymous read the log'; exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
