\set ON_ERROR_STOP on
begin;
-- Self-contained: run after all migrations and seed, or after the older suites.
create or replace function public.test_assert(ok boolean, message text) returns void
language plpgsql as $$ begin if not coalesce(ok,false) then raise exception 'assertion failed: %',message; end if; end $$;
insert into auth.users(id) select ('43100000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid from generate_series(1,6) n on conflict do nothing;
insert into public.business_memberships(business_id,user_id,role) values
('10000000-0000-4000-8000-000000000001','43100000-0000-4000-8000-000000000003','admin'),
('10000000-0000-4000-8000-000000000002','43100000-0000-4000-8000-000000000004','admin'),
('10000000-0000-4000-8000-000000000001','43100000-0000-4000-8000-000000000005','admin'),
('10000000-0000-4000-8000-000000000002','43100000-0000-4000-8000-000000000005','admin'),
('10000000-0000-4000-8000-000000000001','43100000-0000-4000-8000-000000000006','admin') on conflict do nothing;
delete from public.business_memberships where user_id='43100000-0000-4000-8000-000000000006';
-- Defaulted setup rows retain their unknown diet; neither field invents a mark.
insert into public.menu_items(id,business_id,name,category,price_paise) values
('23100000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Ranked dish','Ordering test',100),
('23100000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','Other dish','Ordering test',100);
select public.test_assert((select bool_and(not is_featured and sort_order=0 and diet is null) from public.menu_items where category='Ordering test'), 'safe defaults preserve unknown diet');
select public.test_assert((select relrowsecurity from pg_class where oid='public.menu_items'::regclass), 'menu RLS stays enabled');
set role anon;
select public.test_assert((select count(*)=2 from public.menu_items where category='Ordering test' and not is_featured and sort_order=0), 'guests may read default fields');
do $$ begin
  begin update public.menu_items set is_featured=true,sort_order=8 where category='Ordering test'; raise exception 'guest edited merchandising'; exception when insufficient_privilege then null; end;
  begin insert into public.menu_items(business_id,name,category,price_paise,diet,is_featured,sort_order) values('10000000-0000-4000-8000-000000000001','Guest','Ordering test',100,'veg',true,8); raise exception 'guest inserted merchandising'; exception when insufficient_privilege then null; end;
end $$;
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub','43100000-0000-4000-8000-000000000001',false);
update public.menu_items set is_featured=true,sort_order=8 where category='Ordering test';
select public.test_assert((select bool_and(not is_featured and sort_order=0) from public.menu_items where category='Ordering test'), 'customer cannot edit fields');
do $$ begin
  begin insert into public.menu_items(business_id,name,category,price_paise,diet,is_featured,sort_order) values('10000000-0000-4000-8000-000000000001','Customer','Ordering test',100,'veg',true,8); raise exception 'customer inserted merchandising'; exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','43100000-0000-4000-8000-000000000003',false);
update public.menu_items set is_featured=true,sort_order=-2147483648 where id='23100000-0000-4000-8000-000000000001';
select public.test_assert((select is_featured and sort_order=-2147483648 and diet is null from public.menu_items where id='23100000-0000-4000-8000-000000000001'), 'owning Ammu admin may edit both fields and keep unknown diet');
update public.menu_items set is_featured=true,sort_order=8 where id='23100000-0000-4000-8000-000000000002';
select public.test_assert((select not is_featured and sort_order=0 from public.menu_items where id='23100000-0000-4000-8000-000000000002'), 'Ammu admin cannot edit Kokani');
do $$ begin
  begin update public.menu_items set is_featured=null where id='23100000-0000-4000-8000-000000000001'; raise exception 'null featured accepted'; exception when not_null_violation then null; end;
  begin update public.menu_items set sort_order=null where id='23100000-0000-4000-8000-000000000001'; raise exception 'null rank accepted'; exception when not_null_violation then null; end;
  begin update public.menu_items set sort_order=2147483648 where id='23100000-0000-4000-8000-000000000001'; raise exception 'overflow rank accepted'; exception when numeric_value_out_of_range then null; end;
  begin execute $sql$update public.menu_items set sort_order='1.5' where id='23100000-0000-4000-8000-000000000001'$sql$; raise exception 'fractional rank text accepted'; exception when invalid_text_representation then null; end;
  begin execute $sql$update public.menu_items set is_featured='featured' where id='23100000-0000-4000-8000-000000000001'$sql$; raise exception 'invalid boolean accepted'; exception when invalid_text_representation then null; end;
  begin insert into public.menu_items(business_id,name,category,price_paise,diet,is_featured,sort_order) values('10000000-0000-4000-8000-000000000002','Cross-business','Ordering test',100,'veg',true,8); raise exception 'cross-business insert accepted'; exception when insufficient_privilege then null; end;
end $$;
insert into public.menu_items(business_id,name,category,price_paise,diet,is_featured,sort_order) values('10000000-0000-4000-8000-000000000001','Owner new dish','Ordering test',100,'egg',true,5);
select set_config('request.jwt.claim.sub','43100000-0000-4000-8000-000000000004',false);
update public.menu_items set is_featured=true,sort_order=2147483647,available=false where id='23100000-0000-4000-8000-000000000002';
select public.test_assert((select is_featured and sort_order=2147483647 and not available from public.menu_items where id='23100000-0000-4000-8000-000000000002'), 'owning Kokani admin may rank an unavailable featured dish');
update public.menu_items set is_featured=false,sort_order=9 where id='23100000-0000-4000-8000-000000000001';
select set_config('request.jwt.claim.sub','43100000-0000-4000-8000-000000000006',false);
update public.menu_items set is_featured=false,sort_order=9 where id='23100000-0000-4000-8000-000000000001';
select public.test_assert((select is_featured and sort_order=-2147483648 from public.menu_items where id='23100000-0000-4000-8000-000000000001'), 'other and revoked owners cannot edit');
select set_config('request.jwt.claim.sub','43100000-0000-4000-8000-000000000005',false);
do $$ begin
  begin update public.menu_items set business_id='10000000-0000-4000-8000-000000000002',is_featured=false,sort_order=9 where id='23100000-0000-4000-8000-000000000001'; raise exception 'dual owner transferred dish'; exception when raise_exception then if sqlerrm='dual owner transferred dish' then raise; end if; end;
end $$;
reset role;
set role anon;
select public.test_assert((select count(*)=0 from public.menu_items where id='23100000-0000-4000-8000-000000000002' and available and is_featured), 'public featured predicate excludes unavailable dish');
select public.test_assert((select is_featured and sort_order=-2147483648 from public.menu_items where id='23100000-0000-4000-8000-000000000001'), 'guests read persisted owner fields');
reset role;
rollback;
