\set ON_ERROR_STOP on
begin;
create or replace function public.test_assert(ok boolean,message text) returns void language plpgsql as $$ begin if not coalesce(ok,false) then raise exception 'assertion failed: %',message; end if; end $$;
insert into auth.users(id) values('44400000-0000-4000-8000-000000000001'),('44400000-0000-4000-8000-000000000002'),('44400000-0000-4000-8000-000000000003');
insert into public.business_memberships(business_id,user_id,role) values
('10000000-0000-4000-8000-000000000001','44400000-0000-4000-8000-000000000001','admin'),
('10000000-0000-4000-8000-000000000002','44400000-0000-4000-8000-000000000002','admin');
insert into public.menu_categories(id,business_id,name) values('14400000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Photo tests');
insert into public.menu_items(id,business_id,name,category_id,price_paise,diet) values('24400000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Photo dish','14400000-0000-4000-8000-000000000001',10000,'veg');
select public.test_assert((select relrowsecurity from pg_class where oid='public.menu_photo_jobs'::regclass),'ledger RLS enabled');
select public.test_assert(not has_function_privilege('authenticated','public.reserve_menu_photo(uuid,text,uuid,text)','execute'),'reservation is server only');
select public.test_assert(not has_function_privilege('anon','public.attach_menu_photo(uuid,text,uuid)','execute'),'attachment is server only');
select public.test_assert(not has_column_privilege('authenticated','public.menu_items','image_url','UPDATE') and not has_column_privilege('authenticated','public.menu_items','image_url','INSERT'),'client cannot supply pointer');
set role authenticated;
select set_config('request.jwt.claim.sub','44400000-0000-4000-8000-000000000001',true);
update public.menu_items set name='Owner edit still works' where id='24400000-0000-4000-8000-000000000001';
do $$ begin
  begin update public.menu_items set image_url='foreign/dish/photo/card.webp'; raise exception 'owner forged pointer'; exception when insufficient_privilege then null; end;
  begin insert into storage.objects(bucket_id,name) values('menu-images','10000000-0000-4000-8000-000000000001/forged'); raise exception 'owner bypassed validation'; exception when insufficient_privilege then null; end;
  begin select * from public.menu_photo_jobs; raise exception 'client read ledger'; exception when insufficient_privilege then null; end;
end $$;
reset role;
set role service_role;
do $$
declare actor uuid:='44400000-0000-4000-8000-000000000001'; dish uuid:='24400000-0000-4000-8000-000000000001'; a jsonb; b jsonb; c jsonb; stale jsonb; old_path text; claimed jsonb;
begin
  begin perform public.reserve_menu_photo('44400000-0000-4000-8000-000000000002','ammu-sammu',dish,null); raise exception 'other-business admin authorized'; exception when insufficient_privilege then null; end;
  begin perform public.reserve_menu_photo('44400000-0000-4000-8000-000000000003','ammu-sammu',dish,null); raise exception 'customer authorized'; exception when insufficient_privilege then null; end;
  begin perform public.reserve_menu_photo(actor,'kokani-dine-inn',dish,null); raise exception 'foreign business authorized'; exception when insufficient_privilege then null; end;
  a:=public.reserve_menu_photo(actor,'ammu-sammu',dish,null);
  stale:=public.reserve_menu_photo(actor,'ammu-sammu',dish,null);
  perform public.test_assert(public.claim_menu_photo_cleanup(actor,'ammu-sammu')='[]'::jsonb,'in-flight reservations not cleaned');
  begin perform public.attach_menu_photo(actor,'ammu-sammu',(a->>'id')::uuid); raise exception 'incomplete upload attached'; exception when serialization_failure then null; end;
  insert into storage.objects(bucket_id,name) values('menu-images',(a->>'base')||'/card.webp'),('menu-images',(a->>'base')||'/detail.webp');
  old_path:=public.attach_menu_photo(actor,'ammu-sammu',(a->>'id')::uuid);
  perform public.test_assert(old_path=(a->>'base')||'/card.webp','canonical business/dish/version pointer');
  begin update public.menu_items set id='24400000-0000-4000-8000-000000000099' where id=dish; raise exception 'photo-bound dish id changed'; exception when insufficient_privilege then null; end;
  begin update public.menu_items set image_url=replace(old_path,dish::text,'24400000-0000-4000-8000-000000000002') where id=dish; raise exception 'mismatched dish/path accepted'; exception when insufficient_privilege then null; end;
  begin perform public.attach_menu_photo(actor,'ammu-sammu',(stale->>'id')::uuid); raise exception 'stale update attached'; exception when serialization_failure then null; end;
  b:=public.reserve_menu_photo(actor,'ammu-sammu',dish,old_path);
  insert into storage.objects(bucket_id,name) values('menu-images',(b->>'base')||'/card.webp'),('menu-images',(b->>'base')||'/detail.webp');
  perform public.attach_menu_photo(actor,'ammu-sammu',(b->>'id')::uuid);
  perform public.test_assert((select state='cleanup' from public.menu_photo_jobs where id=(a->>'id')::uuid),'replace queues old assets');
  claimed:=public.claim_menu_photo_cleanup(actor,'ammu-sammu');
  perform public.test_assert(jsonb_array_length(claimed)=1 and claimed->0->>'id'=a->>'id','only detached version claimed');
  perform public.finish_menu_photo_cleanup(actor,'ammu-sammu',(a->>'id')::uuid,gen_random_uuid());
  perform public.test_assert((select state='cleaning' from public.menu_photo_jobs where id=(a->>'id')::uuid),'wrong lease cannot ack');
  perform public.finish_menu_photo_cleanup(actor,'ammu-sammu',(a->>'id')::uuid,(claimed->0->>'lease')::uuid);
  perform public.test_assert((select state='cleaned' from public.menu_photo_jobs where id=(a->>'id')::uuid),'correct lease acknowledged');
  -- Expiry is claimed under the same lock as attach; a resumed request cannot attach.
  update public.menu_photo_jobs set due_at=now()-interval '1 minute' where id=(stale->>'id')::uuid;
  perform public.claim_menu_photo_cleanup(actor,'ammu-sammu');
  begin perform public.attach_menu_photo(actor,'ammu-sammu',(stale->>'id')::uuid); raise exception 'claimed upload attached'; exception when serialization_failure then null; end;
  begin perform public.remove_menu_photo(actor,'ammu-sammu',dish,old_path); raise exception 'stale removal accepted'; exception when serialization_failure then null; end;
  begin perform public.remove_menu_photo('44400000-0000-4000-8000-000000000002','ammu-sammu',dish,(b->>'base')||'/card.webp'); raise exception 'other-business removal accepted'; exception when insufficient_privilege then null; end;
  perform public.remove_menu_photo(actor,'ammu-sammu',dish,(b->>'base')||'/card.webp');
  perform public.remove_menu_photo(actor,'ammu-sammu',dish,(b->>'base')||'/card.webp');
  perform public.test_assert((select image_url is null from public.menu_items where id=dish),'removal retry is safe');
  perform public.test_assert((select state='cleanup' from public.menu_photo_jobs where id=(b->>'id')::uuid),'removal queues old assets');
  c:=public.reserve_menu_photo(actor,'ammu-sammu',dish,null);
  insert into storage.objects(bucket_id,name) values('menu-images',(c->>'base')||'/card.webp'),('menu-images',(c->>'base')||'/detail.webp');
  perform public.attach_menu_photo(actor,'ammu-sammu',(c->>'id')::uuid);
end $$;
reset role;
set role anon;
select public.test_assert((select count(*)=6 from storage.objects where bucket_id='menu-images'),'public reads optimized objects');
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub','44400000-0000-4000-8000-000000000002',true);
delete from storage.objects where bucket_id='menu-images'; update storage.objects set name='forged' where bucket_id='menu-images';
select public.test_assert((select count(*)=6 from storage.objects where bucket_id='menu-images'),'other-business writes refused');
select set_config('request.jwt.claim.sub','44400000-0000-4000-8000-000000000003',true);
delete from storage.objects where bucket_id='menu-images';
select public.test_assert((select count(*)=6 from storage.objects where bucket_id='menu-images'),'customer deletion refused');
select set_config('request.jwt.claim.sub','44400000-0000-4000-8000-000000000001',true);
delete from public.menu_items where id='24400000-0000-4000-8000-000000000001';
reset role;
select public.test_assert(not exists(select 1 from public.menu_photo_jobs where item_id='24400000-0000-4000-8000-000000000001' and state='attached'),'dish deletion queues photo');
rollback;
