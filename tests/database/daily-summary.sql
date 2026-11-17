\set ON_ERROR_STOP on
-- Owners' daily summary (#61): India-time days, cash = delivered, open = all dates.
begin;
create or replace function public.test_assert(ok boolean, message text) returns void language plpgsql as $$ begin if not coalesce(ok,false) then raise exception 'assertion failed: %', message; end if; end $$;
grant execute on function public.test_assert(boolean,text) to anon, authenticated;
select public.test_assert(not has_function_privilege('anon','public.daily_summary(text,date)','execute') and has_function_privilege('authenticated','public.daily_summary(text,date)','execute'), 'summary is for signed-in owners only');
insert into auth.users(id) values ('46100000-0000-4000-8000-000000000001'),('46100000-0000-4000-8000-000000000002'),('46100000-0000-4000-8000-000000000003');
insert into public.business_memberships(business_id,user_id,role) values
  ('10000000-0000-4000-8000-000000000001','46100000-0000-4000-8000-000000000001','admin'),
  ('10000000-0000-4000-8000-000000000002','46100000-0000-4000-8000-000000000002','admin');
-- Baseline open orders from other suites, so "still to collect" is checked exactly.
create temporary table summary_base as select coalesce(sum(total_paise),0)::bigint as open_paise, count(*) as open_count
  from public.orders where business_id='10000000-0000-4000-8000-000000000001' and status not in ('delivered','cancelled');
grant select on summary_base to authenticated;
-- Ammu Sammu orders around 10 Nov 2026, India time. a1: delivered same day; a2: placed
-- 23:50, delivered 00:20 next day; a3: cancelled; a4: open from 5 Nov; a5: open, placed
-- that day. k1: Kokani, delivered that day (must never count for Ammu).
insert into public.orders(id,business_id,customer_id,status,customer_name,customer_phone,delivery_address_line,latitude,longitude,address_label,address_house,address_street_area,address_location_source,saved_address_id,saved_address_version,subtotal_paise,delivery_fee_paise,total_paise,idempotency_key,request_hash,created_at) values
  ('46100000-0000-4000-8000-0000000000a1','10000000-0000-4000-8000-000000000001','46100000-0000-4000-8000-000000000003','delivered','A','9000000001','Khed',0.5,0.5,'home','Test','Test','pin',gen_random_uuid(),1,40000,3000,43000,gen_random_uuid(),'s1','2026-11-10 10:00+05:30'),
  ('46100000-0000-4000-8000-0000000000a2','10000000-0000-4000-8000-000000000001','46100000-0000-4000-8000-000000000003','delivered','B','9000000002','Khed',0.5,0.5,'home','Test','Test','pin',gen_random_uuid(),1,20000,3000,23000,gen_random_uuid(),'s2','2026-11-10 23:50+05:30'),
  ('46100000-0000-4000-8000-0000000000a3','10000000-0000-4000-8000-000000000001','46100000-0000-4000-8000-000000000003','cancelled','C','9000000003','Khed',0.5,0.5,'home','Test','Test','pin',gen_random_uuid(),1,90000,3000,93000,gen_random_uuid(),'s3','2026-11-10 12:00+05:30'),
  ('46100000-0000-4000-8000-0000000000a4','10000000-0000-4000-8000-000000000001','46100000-0000-4000-8000-000000000003','accepted','D','9000000004','Khed',0.5,0.5,'home','Test','Test','pin',gen_random_uuid(),1,15000,3000,18000,gen_random_uuid(),'s4','2026-11-05 12:00+05:30'),
  ('46100000-0000-4000-8000-0000000000a5','10000000-0000-4000-8000-000000000001','46100000-0000-4000-8000-000000000003','preparing','E','9000000005','Khed',0.5,0.5,'home','Test','Test','pin',gen_random_uuid(),1,10000,3000,13000,gen_random_uuid(),'s5','2026-11-10 00:05+05:30'),
  ('46100000-0000-4000-8000-0000000000b1','10000000-0000-4000-8000-000000000002','46100000-0000-4000-8000-000000000003','delivered','K','9000000006','Khed',0.5,0.5,'home','Test','Test','pin',gen_random_uuid(),1,70000,3000,73000,gen_random_uuid(),'s6','2026-11-10 13:00+05:30');
insert into public.order_status_history(order_id,status,created_at) values
  ('46100000-0000-4000-8000-0000000000a1','delivered','2026-11-10 11:00+05:30'),
  ('46100000-0000-4000-8000-0000000000a2','delivered','2026-11-11 00:20+05:30'),
  ('46100000-0000-4000-8000-0000000000a3','cancelled','2026-11-10 12:30+05:30'),
  ('46100000-0000-4000-8000-0000000000b1','delivered','2026-11-10 14:00+05:30');
insert into public.order_items(order_id,name,unit_price_paise,quantity,line_total_paise) values
  ('46100000-0000-4000-8000-0000000000a1','Veg thali',20000,2,40000),
  ('46100000-0000-4000-8000-0000000000a2','Misal pav',10000,2,20000),
  ('46100000-0000-4000-8000-0000000000a3','Fish thali',30000,3,90000),
  ('46100000-0000-4000-8000-0000000000a5','Misal pav',10000,1,10000),
  ('46100000-0000-4000-8000-0000000000b1','Kokani thali',70000,1,70000);
-- Current menu prices never matter: totals come from the stored order snapshot.
update public.menu_items set price_paise = price_paise + 99900;

set role authenticated;
select set_config('request.jwt.claim.sub','46100000-0000-4000-8000-000000000001',true);
create temporary table summary_10 on commit drop as select public.daily_summary('ammu-sammu','2026-11-10') as s;
select public.test_assert((select (s->>'collected_paise')::bigint = 43000 and (s->>'delivered_count')::int = 1 from summary_10), 'cash counts only orders delivered that day, at stored totals');
select public.test_assert((select (s->>'placed_count')::int = 4 and (s->>'cancelled_count')::int = 1 from summary_10), 'placed and cancelled counts follow the India-time day');
select public.test_assert((select (s->>'outstanding_paise')::bigint = b.open_paise + 31000 and (s->>'outstanding_count')::int = b.open_count + 2 from summary_10, summary_base b), 'still to collect covers every open order, whatever its date');
select public.test_assert((select s->'top_dishes' = '[{"name":"Misal pav","quantity":3},{"name":"Veg thali","quantity":2}]'::jsonb from summary_10), 'most ordered excludes cancelled orders, ties by name');
select public.test_assert((select s->>'date' = '2026-11-10' from summary_10), 'summary echoes its day');
-- Placed before midnight, delivered after: placed on the 10th, cash on the 11th.
select public.test_assert((select (s->>'collected_paise')::bigint = 23000 and (s->>'delivered_count')::int = 1 and (s->>'placed_count')::int = 0 and (s->>'cancelled_count')::int = 0 from (select public.daily_summary('ammu-sammu','2026-11-11') s) x), 'cross-midnight delivery counts on the delivery day');
select public.test_assert((select (s->>'outstanding_paise')::bigint = b.open_paise + 31000 from (select public.daily_summary('ammu-sammu','2026-11-11') s) x, summary_base b), 'still to collect is the same on any chosen day');
select public.test_assert((select s->>'date' = to_char(now() at time zone 'Asia/Kolkata','YYYY-MM-DD') from (select public.daily_summary('ammu-sammu') s) x), 'no date means today in India time');
-- Other restaurant's owner, a customer and a signed-out caller cannot see the numbers.
select set_config('request.jwt.claim.sub','46100000-0000-4000-8000-000000000002',true);
do $$ begin perform public.daily_summary('ammu-sammu','2026-11-10'); raise exception 'other owner saw the summary'; exception when insufficient_privilege then null; end $$;
select public.test_assert((select (s->>'collected_paise')::bigint = 73000 from (select public.daily_summary('kokani-dine-inn','2026-11-10') s) x), 'each restaurant sees only its own cash');
select set_config('request.jwt.claim.sub','46100000-0000-4000-8000-000000000003',true);
do $$ begin perform public.daily_summary('ammu-sammu','2026-11-10'); raise exception 'customer saw the summary'; exception when insufficient_privilege then null; end $$;
select set_config('request.jwt.claim.sub','',true);
do $$ begin perform public.daily_summary('ammu-sammu','2026-11-10'); raise exception 'signed-out caller saw the summary'; exception when insufficient_privilege then null; end $$;
do $$ begin perform public.daily_summary('no-such-restaurant','2026-11-10'); raise exception 'unknown restaurant answered'; exception when insufficient_privilege then null; end $$;
reset role;
rollback;
