\set ON_ERROR_STOP on
-- Owner-name self-service, only against the final schema; every fixture rolls back.
begin;
select public.test_assert(not (select prosecdef from pg_proc where oid='public.set_owner_display_name(text,text)'::regprocedure),'public owner-name wrapper is invoker');
select public.test_assert((select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid='owner_settings_private.set_display_name(text,text)'::regprocedure),'private implementation is definer with empty path');
select public.test_assert((select proconfig @> array['search_path=""'] from pg_proc where oid='public.set_owner_display_name(text,text)'::regprocedure),'wrapper has empty path');
select public.test_assert(has_schema_privilege('authenticated','owner_settings_private','usage') and not has_schema_privilege('anon','owner_settings_private','usage'),'private-schema usage only for authenticated wrapper');
select public.test_assert(not has_any_column_privilege('authenticated','public.business_memberships','UPDATE'),'no membership update grant');
do $$ declare fn text; begin
 foreach fn in array array['public.set_owner_display_name(text,text)','owner_settings_private.set_display_name(text,text)'] loop
  perform public.test_assert(has_function_privilege('authenticated',fn,'execute') and not has_function_privilege('anon',fn,'execute') and not has_function_privilege('service_role',fn,'execute'),'precise owner-name execute grants: '||fn);
 end loop;
end $$;
insert into auth.users(id) select ('55300000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,4) n;
insert into auth.sessions(id,user_id) select id,id from auth.users where id::text like '55300000-%';
insert into public.business_memberships(business_id,user_id,role,display_name) values
 ('10000000-0000-4000-8000-000000000001','55300000-0000-4000-8000-000000000001','admin','Before Rename'),
 ('10000000-0000-4000-8000-000000000001','55300000-0000-4000-8000-000000000002','admin','Other Owner'),
 ('10000000-0000-4000-8000-000000000002','55300000-0000-4000-8000-000000000003','admin','Other Restaurant'),
 ('10000000-0000-4000-8000-000000000002','55300000-0000-4000-8000-000000000001','admin','Same User Other Restaurant');
insert into public.orders(id,business_id,customer_id,customer_name,customer_phone,delivery_address_line,latitude,longitude,address_label,address_house,address_street_area,address_location_source,saved_address_id,saved_address_version,subtotal_paise,delivery_fee_paise,total_paise,idempotency_key,request_hash)
values ('55300000-0000-4000-9000-000000000001','10000000-0000-4000-8000-000000000001','55300000-0000-4000-8000-000000000004','Name test customer','0','Test address',0.5,0.5,'home','Test','Test','pin',gen_random_uuid(),1,100,0,100,'55300000-0000-4000-a000-000000000001','owner-name-test');
set local role authenticated;
select set_config('request.jwt.claim.sub','55300000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"session_id":"55300000-0000-4000-8000-000000000001"}',true);
select public.transition_order('55300000-0000-4000-9000-000000000001','accepted',1);
reset role;
create temporary table owner_name_members_before as select business_id,user_id,to_jsonb(m) value from public.business_memberships m;
create temporary table owner_name_actors_before as select history_id,to_jsonb(a) value from public.order_status_actors a;
create temporary table owner_name_history_before as select id,to_jsonb(h) value from public.order_status_history h;
create temporary table owner_name_orders_before as select id,to_jsonb(o) value from public.orders o;
create temporary table owner_name_businesses_before as select id,to_jsonb(b) value from public.businesses b;
set local role authenticated;
select public.test_assert(public.set_owner_display_name('ammu-sammu','After Rename')=jsonb_build_object('business_id','10000000-0000-4000-8000-000000000001','user_id','55300000-0000-4000-8000-000000000001','display_name','After Rename'),'RPC confirms exactly caller/business/name');
reset role;
select public.test_assert(not exists(select 1 from public.business_memberships m join owner_name_members_before b using(business_id,user_id) where
 case when m.business_id='10000000-0000-4000-8000-000000000001' and m.user_id='55300000-0000-4000-8000-000000000001' then to_jsonb(m)-'display_name'<>b.value-'display_name' or m.display_name<>'After Rename' else to_jsonb(m)<>b.value end),'only caller selected-restaurant name changes; every other row/column stays identical');
select public.test_assert(not exists(select 1 from public.orders o join owner_name_orders_before b using(id) where to_jsonb(o)<>b.value) and not exists(select 1 from public.businesses r join owner_name_businesses_before b using(id) where to_jsonb(r)<>b.value),'rename never changes orders or restaurant settings');
select public.test_assert(not exists(select 1 from public.order_status_actors a join owner_name_actors_before b using(history_id) where to_jsonb(a)<>b.value) and not exists(select 1 from public.order_status_history h join owner_name_history_before b using(id) where to_jsonb(h)<>b.value),'all past history and name snapshots unchanged');
set local role authenticated;
-- NULL is mapped explicitly; all other invalid values use the unchanged table constraint.
do $$ declare name text; detail text; before_name text; begin
 select display_name into before_name from public.business_memberships where business_id='10000000-0000-4000-8000-000000000001' and user_id=auth.uid();
 foreach name in array array[null::text,'',' ',' padded','padded ',repeat('a',61),E'A\tB',E'A\nB',E'A\rB',E'A\u0001B',E'A\u007FB',E'A\u0085B',E'A\u009FB',E'A\u00A0B',E'A\u00ADB',E'A\u2000B',E'A\u200BB',E'A\u200EB',E'A\u200FB',E'A\u2028B',E'A\u202EB',E'A\u205FB',E'A\u2060B',E'A\u2066B',E'A\u2069B',E'A\u3000B',E'A\uFEFFB'] loop
  begin perform public.set_owner_display_name('ammu-sammu',name); raise exception 'invalid name accepted: %',name;
  exception when invalid_parameter_value then
   get stacked diagnostics detail=pg_exception_detail;
   perform public.test_assert(detail='displayName','invalid name identifies field');
  end;
  perform public.test_assert((select display_name=before_name from public.business_memberships where business_id='10000000-0000-4000-8000-000000000001' and user_id=auth.uid()),'invalid input leaves name unchanged');
 end loop;
 foreach name in array array['A',repeat('a',60),E'\u0938\u0941\u0930\u0947\u0936',E'\u0930\u094D\u200D\u092F',E'A\u200CB',E'e\u0301',repeat(chr(128512),60),E'\u1680Name\u1680'] loop
  perform public.test_assert(public.set_owner_display_name('ammu-sammu',name)->>'display_name'=name,'existing Unicode and character-count rules preserved');
 end loop;
end $$;
select public.set_owner_display_name('ammu-sammu','New Owner');
select public.transition_order('55300000-0000-4000-9000-000000000001','preparing',2);
reset role;
select public.test_assert((select a.actor_name='Before Rename' from public.order_status_actors a join public.order_status_history h on h.id=a.history_id where h.order_id='55300000-0000-4000-9000-000000000001' and h.status='accepted'),'past step retains original name');
select public.test_assert((select a.actor_name='New Owner' from public.order_status_actors a join public.order_status_history h on h.id=a.history_id where h.order_id='55300000-0000-4000-9000-000000000001' and h.status='preparing'),'new step uses new name');
set local role authenticated;
do $$ begin
 begin update public.business_memberships set display_name='Direct write'; raise exception 'direct table update accepted'; exception when insufficient_privilege then null; end;
 begin perform public.set_owner_display_name('missing','Name'); raise exception 'unknown restaurant accepted'; exception when insufficient_privilege then null; end;
 begin perform public.set_owner_display_name(null,'Name'); raise exception 'null restaurant accepted'; exception when insufficient_privilege then null; end;
 begin perform public.set_owner_display_name('ammu-sammu','Forged','55300000-0000-4000-8000-000000000002'); raise exception 'target-owner parameter accepted'; exception when undefined_function then null; end;
end $$;
-- A different owner updates only their own membership; they cannot target the first owner's row.
select set_config('request.jwt.claim.sub','55300000-0000-4000-8000-000000000002',true);
select set_config('request.jwt.claims','{"session_id":"55300000-0000-4000-8000-000000000002"}',true);
select public.set_owner_display_name('ammu-sammu','Second Owner New Name');
do $$ begin
 begin perform public.set_owner_display_name('kokani-dine-inn','Not Their Restaurant'); raise exception 'cross-restaurant setter accepted'; exception when insufficient_privilege then null; end;
 begin perform owner_settings_private.set_display_name('kokani-dine-inn','Private Bypass'); raise exception 'private implementation bypassed access'; exception when insufficient_privilege then null; end;
end $$;
reset role;
select public.test_assert((select display_name='New Owner' from public.business_memberships where user_id='55300000-0000-4000-8000-000000000001' and business_id='10000000-0000-4000-8000-000000000001'),'other owner cannot change first owner');
set local role authenticated;
select set_config('request.jwt.claim.sub','55300000-0000-4000-8000-000000000003',true);
select set_config('request.jwt.claims','{"session_id":"55300000-0000-4000-8000-000000000003"}',true);
do $$ begin perform public.set_owner_display_name('ammu-sammu','Other Restaurant'); raise exception 'foreign restaurant owner accepted'; exception when insufficient_privilege then null; end $$;
select set_config('request.jwt.claim.sub','55300000-0000-4000-8000-000000000004',true);
select set_config('request.jwt.claims','{"session_id":"55300000-0000-4000-8000-000000000004","user_metadata":{"role":"admin"}}',true);
do $$ begin perform public.set_owner_display_name('ammu-sammu','Customer'); raise exception 'customer accepted'; exception when insufficient_privilege then null; end $$;
select set_config('request.jwt.claim.sub','55300000-0000-4000-8000-000000000001',true);
do $$ declare claims text; begin
 foreach claims in array array['{}','{"session_id":"bad"}','{"session_id":null}','{"session_id":"55300000-0000-4000-8000-000000000099"}','{"session_id":"55300000-0000-4000-8000-000000000002"}'] loop
  perform set_config('request.jwt.claims',claims,true);
  begin perform public.set_owner_display_name('ammu-sammu','Invalid Session'); raise exception 'invalid session accepted: %',claims; exception when insufficient_privilege then null; end;
 end loop;
end $$;
select set_config('request.jwt.claims','{"session_id":"55300000-0000-4000-8000-000000000001"}',true);
reset role;
update auth.sessions set not_after=clock_timestamp()-interval '1 second' where id='55300000-0000-4000-8000-000000000001';
set local role authenticated;
do $$ begin perform public.set_owner_display_name('ammu-sammu','Expired'); raise exception 'expired session accepted'; exception when insufficient_privilege then null; end $$;
reset role;
update auth.sessions set not_after=null where id='55300000-0000-4000-8000-000000000001';
delete from auth.sessions where id='55300000-0000-4000-8000-000000000001';
set local role authenticated;
do $$ begin perform public.set_owner_display_name('ammu-sammu','Revoked Session'); raise exception 'revoked session accepted'; exception when insufficient_privilege then null; end $$;
reset role;
insert into auth.sessions(id,user_id) values ('55300000-0000-4000-8000-000000000001','55300000-0000-4000-8000-000000000001');
delete from public.business_memberships where user_id='55300000-0000-4000-8000-000000000001' and business_id='10000000-0000-4000-8000-000000000001';
set local role authenticated;
do $$ begin perform public.set_owner_display_name('ammu-sammu','Removed Owner'); raise exception 'removed owner accepted'; exception when insufficient_privilege then null; end $$;
select set_config('request.jwt.claim.sub','',true);
do $$ begin perform public.set_owner_display_name('ammu-sammu','Signed Out'); raise exception 'missing caller accepted'; exception when insufficient_privilege then null; end $$;
reset role;
set local role anon;
do $$ begin perform public.set_owner_display_name('ammu-sammu','Anonymous'); raise exception 'anon accepted'; exception when insufficient_privilege then null; end $$;
reset role;
rollback;
