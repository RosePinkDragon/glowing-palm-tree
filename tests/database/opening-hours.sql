\set ON_ERROR_STOP on
-- #253 slice 1: opening hours. Runs last in the shared-fixture chain (customers A and B, their saved addresses, and the
-- real-dish fixture come from final-fixture.sql); rolled back. The server clock cannot be faked inside a transaction, so
-- the boundaries are proven on the pure function business_open_at with explicit instants (every boundary, both
-- restaurants' windows, midnight, any session time zone), and enforcement is proven with windows built around the
-- current India time (test_hours below), which cannot be time-dependent.
begin;
-- Hours are null (always open) wherever nothing has set them: the seed creates the restaurants after the migrations.
select public.test_assert((select bool_and(opens_at is null and closes_at is null) from public.businesses), 'seeded restaurants have no hours, so every other suite is time-independent');

-- 1. The pure window function: the owner decisions of 26 Nov 2026, in India time, whatever the session time zone.
create function public.t_open(opens time, closes time, at_ist text) returns boolean language sql as $$
  select public.business_open_at(opens, closes, (at_ist || '+05:30')::timestamptz) $$;
do $$ declare z text; begin
  foreach z in array array['UTC','Asia/Kolkata','America/New_York','Pacific/Kiritimati'] loop
    perform set_config('timezone', z, true);
    -- Ammu Sammu 09:00 to 19:30.
    perform public.test_assert(not public.t_open('09:00','19:30','2026-11-26 08:59:59'), 'ammu closed just before opening ' || z);
    perform public.test_assert(not public.t_open('09:00','19:30','2026-11-26 00:00:00'), 'ammu closed at midnight ' || z);
    perform public.test_assert(public.t_open('09:00','19:30','2026-11-26 09:00:00'), 'ammu open at opening ' || z);
    perform public.test_assert(public.t_open('09:00','19:30','2026-11-26 19:29:59'), 'ammu open just before closing ' || z);
    perform public.test_assert(not public.t_open('09:00','19:30','2026-11-26 19:30:00'), 'ammu closed at closing ' || z);
    perform public.test_assert(not public.t_open('09:00','19:30','2026-11-26 23:59:59'), 'ammu closed late evening ' || z);
    -- Kokani Dine Inn 11:00 to midnight (closes_at 00:00 is the end of the day).
    perform public.test_assert(not public.t_open('11:00','00:00','2026-11-26 10:59:59'), 'kokani closed just before opening ' || z);
    perform public.test_assert(public.t_open('11:00','00:00','2026-11-26 11:00:00'), 'kokani open at opening ' || z);
    perform public.test_assert(public.t_open('11:00','00:00','2026-11-26 23:59:59'), 'kokani open just before midnight ' || z);
    perform public.test_assert(not public.t_open('11:00','00:00','2026-11-27 00:00:00'), 'kokani closed at midnight ' || z);
    perform public.test_assert(not public.t_open('11:00','00:00','2026-11-27 00:00:01'), 'kokani closed just after midnight ' || z);
    perform public.test_assert(not public.t_open('11:00','00:00','2026-11-27 05:00:00'), 'kokani closed in the small hours ' || z);
    -- No hours set: open at every instant.
    perform public.test_assert(public.t_open(null,null,'2026-11-26 03:00:00') and public.t_open(null,null,'2026-11-26 23:59:59'), 'null hours are always open ' || z);
  end loop;
  -- The same instant is on different India dates in UTC: 18:30 UTC on the 25th is 00:00 IST on the 26th.
  perform set_config('timezone', 'UTC', true);
  perform public.test_assert(public.business_open_at('00:00','12:00','2026-11-25 18:30+00') and not public.business_open_at('01:00','12:00','2026-11-25 18:30+00'), 'the window is read in India time, not UTC');
end $$;
select public.test_assert(not public.business_open_now(gen_random_uuid()), 'an unknown restaurant is never open');
select public.test_assert(public.business_open_now((select id from public.businesses where slug='ammu-sammu')), 'a restaurant without hours is open');

-- 2. Storage: valid windows, and every invalid shape refused by the constraint.
create function public.t_hours_ok(o time, c time) returns boolean language plpgsql as $$
begin update public.businesses set opens_at=o, closes_at=c where slug='ammu-sammu'; return true;
exception when check_violation then return false; end $$;
select public.test_assert(public.t_hours_ok('09:00','19:30') and public.t_hours_ok('11:00','00:00') and public.t_hours_ok('00:00','12:00') and public.t_hours_ok('00:01','00:00') and public.t_hours_ok(null,null), 'valid windows accepted (same-day, midnight close, from midnight, cleared)');
select public.test_assert(not public.t_hours_ok('09:00',null) and not public.t_hours_ok(null,'19:30'), 'half a window refused');
select public.test_assert(not public.t_hours_ok('09:00','09:00') and not public.t_hours_ok('00:00','00:00'), 'an empty window (and a 24-hour one spelled 00:00 to 00:00) refused: clear the hours instead');
select public.test_assert(not public.t_hours_ok('19:30','09:00') and not public.t_hours_ok('22:00','02:00'), 'a window crossing midnight refused (one window per day)');
select public.test_assert(not public.t_hours_ok('09:00','24:00') and not public.t_hours_ok('24:00','24:00'), 'midnight has one representation: 24:00 is refused');
select public.test_assert(not public.t_hours_ok('09:00:30','19:30') and not public.t_hours_ok('09:00','19:30:15'), 'whole minutes only');
update public.businesses set opens_at=null, closes_at=null;

-- 3. Enforcement, with windows around the current India time. t is the current minute; every case works at every time of day.
create function public.t_ist_minute() returns time language sql stable as $$ select date_trunc('minute', now() at time zone 'Asia/Kolkata')::time $$;
create function public.t_window(kind text, t time, out o time, out c time) language plpgsql immutable as $$
begin
  case kind
    when 'before_opening' then if t < '23:59' then o := t + interval '1 minute'; c := '00:00'; else o := '00:00'; c := '00:01'; end if;
    when 'at_opening' then o := t; c := case when t >= '23:00' then '00:00'::time else t + interval '1 hour' end;
    when 'before_closing' then o := case when t >= '23:59' then '23:00'::time else '00:00'::time end; c := case when t >= '23:59' then '00:00'::time else t + interval '1 minute' end;
    when 'at_closing' then if t > '00:00' then o := '00:00'; c := t; else o := '01:00'; c := '02:00'; end if;
    when 'midnight_close' then if t > '00:00' then o := t; c := '00:00'; else o := '00:00'; c := '00:02'; end if;
  end case;
end $$;
-- Every minute of the day: each window is valid and is open (or closed) at that minute, so the cases below hold at any time of day.
select public.test_assert((select bool_and(
    (w.o < w.c or w.c = time '00:00') and w.o <> w.c
    and public.business_open_at(w.o, w.c, (date '2026-11-26' + t)::timestamp at time zone 'Asia/Kolkata' + interval '30 seconds')
      = (k in ('at_opening','before_closing','midnight_close')))
  from generate_series(0, 1439) m, lateral (select (m * interval '1 minute')::time t) x, unnest(array['before_opening','at_opening','before_closing','at_closing','midnight_close']) k, lateral public.t_window(k, x.t) w
  ), 'every window is valid and has the expected state at every minute of the day');
create function public.t_hours(kind text) returns void language plpgsql security definer set search_path = public as $$
declare w record;
begin
  if kind = 'none' then update public.businesses set opens_at=null, closes_at=null, accepting_orders=true where slug='ammu-sammu'; return; end if;
  select * into w from public.t_window(kind, public.t_ist_minute());
  update public.businesses set opens_at=w.o, closes_at=w.c, accepting_orders=true where slug='ammu-sammu';
end $$;
-- Ammu Sammu is a real, verified, ordering-enabled restaurant here, with no fee or minimum so the quote is just the items.
do $$ declare ns text; begin
  select n.nspname into strict ns from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='postgis';
  execute format('update public.businesses set is_demo=false,service_area=%I.st_geomfromtext(''MULTIPOLYGON(((0 0,1 0,1 1,0 1,0 0)))'',4326),service_area_source=''hours test'',service_area_version=''test'',service_area_verified_at=now(),ordering_enabled=true,accepting_orders=true,delivery_fee_paise=0,min_order_paise=0 where slug=''ammu-sammu''',ns);
end $$;
insert into public.menu_items(id,business_id,name,category_id,price_paise,diet) values
('25300000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Hours dish',public.test_category('10000000-0000-4000-8000-000000000001','Hours'),10000,'veg');
select set_config('test.hours.items','[{"menu_item_id":"25300000-0000-4000-8000-000000000001","quantity":1}]',true);
create function public.t_hq() returns jsonb language sql as $$ select public.quote_order('ammu-sammu',current_setting('test.hours.items')::jsonb,null) $$;
create function public.t_hp(k integer) returns jsonb language sql as $$
  select public.place_order('ammu-sammu',current_setting('test.hours.items')::jsonb,public.test_delivery('Hours'),null,('65300000-0000-4000-8000-'||lpad(k::text,12,'0'))::uuid,current_setting('test.hours.pricing')::jsonb) $$;
-- Run a statement and report how it was refused: 'ok', 'OUTSIDE_HOURS:<hint>', 'NOT_ACCEPTING' (the owner's switch), or the other state/detail.
create function public.t_outcome(stmt text) returns text language plpgsql as $$
declare detail text; hint text;
begin execute stmt; return 'ok';
exception when others then
  get stacked diagnostics detail = pg_exception_detail, hint = pg_exception_hint;
  if sqlstate = 'PT409' and detail = 'OUTSIDE_HOURS' then return 'OUTSIDE_HOURS:' || hint; end if;
  if sqlstate = 'PT409' and sqlerrm = 'restaurant is not accepting orders' then return 'NOT_ACCEPTING'; end if;
  return sqlstate || ':' || coalesce(detail, sqlerrm);
end $$;
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000001',true);
set role authenticated;
-- Open: the quote and a new order both work at opening, just before closing, and with a midnight close.
select public.t_hours('at_opening');
select public.test_assert(public.t_outcome('select public.t_hq()') = 'ok', 'quote works at the opening minute');
-- The accepted pricing is quoted once, while open, so later calls need no quote (a quote outside hours is refused).
select set_config('test.hours.pricing', (public.t_hq()->'pricing')::text, true);
select public.test_assert(public.t_outcome('select public.t_hp(1)') = 'ok', 'a new order is placed at the opening minute');
select public.t_hours('before_closing');
select public.test_assert(public.t_outcome('select public.t_hp(2)') = 'ok', 'a new order is placed just before closing');
select public.t_hours('midnight_close');
select public.test_assert(public.t_outcome('select public.t_hq()') = 'ok' and public.t_outcome('select public.t_hp(3)') = 'ok', 'a midnight-closing window is open until midnight');
select public.t_hours('none');
select public.test_assert(public.t_outcome('select public.t_hp(4)') = 'ok', 'no hours set: open');
reset role;
select public.test_assert((select count(*)=4 from public.orders where idempotency_key::text like '65300000-%'), 'the four open-time orders exist');
-- Closed by hours: quote and new orders are refused (PT409, OUTSIDE_HOURS, hint = the opening time), and nothing is written.
do $$ declare kind text; opens text; begin
  foreach kind in array array['before_opening','at_closing'] loop
    perform public.t_hours(kind);
    select to_char(opens_at,'HH24:MI') into opens from public.businesses where slug='ammu-sammu';
    set local role authenticated;
    perform public.test_assert(public.t_outcome('select public.t_hq()') = 'OUTSIDE_HOURS:' || opens, kind || ': quote refused with the opening time');
    perform public.test_assert(public.t_outcome('select public.t_hp(10)') = 'OUTSIDE_HOURS:' || opens, kind || ': new order refused with the opening time');
    reset role;
  end loop;
end $$;
select public.test_assert((select count(*)=4 from public.orders where idempotency_key::text like '65300000-%'), 'refusals created no order');
select public.test_assert(not exists (select 1 from public.checkout_pricing_rejections where idempotency_key::text like '65300000-%'), 'a refusal outside hours stores nothing, so the key stays usable');
-- Replays of already-placed orders still return outside hours; a different request on the same key is still refused as before.
set role authenticated;
select public.test_assert((select (public.t_hp(1)->>'id')::uuid = o.id from public.orders o where o.idempotency_key='65300000-0000-4000-8000-000000000001'), 'replay of an order placed earlier returns it outside hours');
select public.test_assert(public.t_hp(1)->>'outcome' = 'placed', 'the replay answers as placed');
select public.test_assert(public.t_outcome('select public.place_order(''ammu-sammu'',''[{"menu_item_id":"25300000-0000-4000-8000-000000000001","quantity":2}]'',public.test_delivery(''Hours''),null,''65300000-0000-4000-8000-000000000001'',current_setting(''test.hours.pricing'')::jsonb)') like '22023:%', 'a changed request on a used key is still refused outside hours');
reset role;
-- The same key works once the restaurant is open again.
select public.t_hours('at_opening');
set role authenticated;
select public.test_assert(public.t_outcome('select public.t_hp(10)') = 'ok', 'the refused key places an order once open');
reset role;
-- The owner's switch still applies within hours, and says so differently.
update public.businesses set accepting_orders=false where slug='ammu-sammu';
set role authenticated;
select public.test_assert(public.t_outcome('select public.t_hp(11)') = 'NOT_ACCEPTING', 'within hours with the switch off: refused as not accepting');
select public.test_assert((select (public.t_hp(2)->>'id')::uuid = o.id from public.orders o where o.idempotency_key='65300000-0000-4000-8000-000000000002'), 'replay still returns with the switch off');
reset role;
-- Both closed: the switch is checked first (before pricing), so the older refusal wins.
select public.t_hours('before_opening');
update public.businesses set accepting_orders=false where slug='ammu-sammu';
set role authenticated;
select public.test_assert(public.t_outcome('select public.t_hp(12)') = 'NOT_ACCEPTING', 'switch off and outside hours: not accepting');
reset role;
select public.test_assert((select count(*)=5 from public.orders where idempotency_key::text like '65300000-%'), 'only the five open-time orders exist');
-- Another restaurant's hours do not affect this one: Kokani closed by hours leaves Ammu Sammu open.
select public.t_hours('at_opening');
update public.businesses set opens_at=(public.t_ist_minute() + interval '1 minute')::time, closes_at='00:00' where slug='kokani-dine-inn' and public.t_ist_minute() < '23:59';
select public.test_assert(public.business_open_now((select id from public.businesses where slug='ammu-sammu')), 'one restaurant closed by hours does not close the other');

-- 4. Owners edit hours: only that restaurant's owner, with an active session, optimistic version, valid windows.
select public.test_assert(not has_function_privilege('anon','public.save_opening_hours(text,time,time,integer)','execute') and has_function_privilege('authenticated','public.save_opening_hours(text,time,time,integer)','execute'), 'only signed-in callers can edit hours');
select public.test_assert(not has_schema_privilege('anon','restaurant_settings_private','usage') and not has_function_privilege('anon','restaurant_settings_private.save_opening_hours(text,time,time,integer)','execute'), 'the private implementation is not reachable by guests');
select public.test_assert(not (select prosecdef from pg_proc where oid='public.save_opening_hours(text,time,time,integer)'::regprocedure) and (select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid='restaurant_settings_private.save_opening_hours(text,time,time,integer)'::regprocedure), 'invoker wrapper, definer implementation with an empty search_path');
select public.test_assert((select prosecdef and proconfig @> array['search_path=""'] and not has_function_privilege('anon','offers_private.price_items(uuid,jsonb,boolean)','execute') and not has_function_privilege('authenticated','offers_private.price_items(uuid,jsonb,boolean)','execute') from pg_proc where oid='offers_private.price_items(uuid,jsonb,boolean)'::regprocedure), 'price_items stays a definer with an empty search_path and no client execute');
insert into auth.users(id) values ('53000000-0000-4000-8000-000000000001'),('53000000-0000-4000-8000-000000000002'),('53000000-0000-4000-8000-000000000003');
insert into public.business_memberships(business_id,user_id,role) values
 ('10000000-0000-4000-8000-000000000001','53000000-0000-4000-8000-000000000001','admin'),
 ('10000000-0000-4000-8000-000000000002','53000000-0000-4000-8000-000000000002','admin');
update public.businesses set opens_at=null, closes_at=null where slug in ('ammu-sammu','kokani-dine-inn');
create temporary table hours_before as select slug, to_jsonb(b) value from public.businesses b;
grant select on hours_before to authenticated;
create function public.t_save(opens time, closes time, slug text default 'ammu-sammu', version integer default null) returns text language plpgsql as $$
declare v integer := coalesce(version, (select settings_version from public.businesses b where b.slug = t_save.slug)); detail text;
begin perform public.save_opening_hours(slug, opens, closes, v); return 'ok';
exception when others then get stacked diagnostics detail = pg_exception_detail; return sqlstate || ':' || coalesce(detail, sqlerrm); end $$;
set role authenticated;
select set_config('request.jwt.claim.sub','53000000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"session_id":"53000000-0000-4000-8000-000000000001"}',true);
reset role;
insert into auth.sessions(id,user_id) select id,id from auth.users where id::text like '53000000-%';
set role authenticated;
-- Invalid windows are refused with the field named, and leave every column and the version unchanged.
select public.test_assert(public.t_save('09:00','09:00') = '22023:closesAt' and public.t_save('19:30','09:00') = '22023:closesAt' and public.t_save('22:00','02:00') = '22023:closesAt', 'empty and midnight-crossing windows refused (closesAt)');
select public.test_assert(public.t_save('09:00',null) = '22023:openingHours' and public.t_save(null,'19:30') = '22023:openingHours', 'half a window refused (openingHours)');
select public.test_assert(public.t_save('09:00:30','19:30') = '22023:opensAt' and public.t_save('09:00','19:30:30') = '22023:closesAt', 'sub-minute times refused');
select public.test_assert(public.t_save('24:00','24:00') like '22023:%', '24:00 is not an opening time');
reset role;
select public.test_assert((select to_jsonb(b)=h.value from public.businesses b join hours_before h on h.slug=b.slug where b.slug='ammu-sammu'), 'invalid hours leave every column and the version unchanged');
set role authenticated;
-- The owner of Ammu Sammu saves, including midnight as 24:00 (stored 00:00); the version moves by one each time.
create temporary table hours_saved as select public.save_opening_hours('ammu-sammu','09:00','19:30',(select settings_version from public.businesses where slug='ammu-sammu')) value;
grant select on hours_saved to authenticated;
select public.test_assert((select value->>'opens_at'='09:00' and value->>'closes_at'='19:30' and (value->>'settings_version')::int=(select (h.value->>'settings_version')::int+1 from hours_before h where slug='ammu-sammu') from hours_saved), 'owner saves 09:00 to 19:30 and the version bumps');
select public.test_assert((select opens_at='09:00' and closes_at='19:30' from public.businesses where slug='ammu-sammu') and (select opens_at is null from public.businesses where slug='kokani-dine-inn'), 'only the owner''s restaurant changed');
select public.test_assert(public.save_opening_hours('ammu-sammu','11:00','24:00',(select settings_version from public.businesses where slug='ammu-sammu'))->>'closes_at' = '00:00', '24:00 is stored as midnight (00:00)');
select public.test_assert((select closes_at = time '00:00' and opens_at = time '11:00' from public.businesses where slug='ammu-sammu'), 'midnight is stored as 00:00');
select public.test_assert(public.save_opening_hours('ammu-sammu',null,null,(select settings_version from public.businesses where slug='ammu-sammu'))->>'opens_at' is null, 'both null clears the hours');
select public.save_opening_hours('ammu-sammu','09:00','19:30',(select settings_version from public.businesses where slug='ammu-sammu'));
-- Optimistic concurrency, both ways: a stale or missing version is refused; an hours edit invalidates an open settings form.
select public.test_assert(public.t_save('10:00','20:00','ammu-sammu',1) like '40001:%', 'stale version refused');
select public.test_assert((public.t_save('10:00','20:00','ammu-sammu',0) like '40001:%'), 'wrong version refused');
do $$ declare v integer; begin
  select settings_version into v from public.businesses where slug='ammu-sammu';
  begin perform public.save_opening_hours('ammu-sammu','10:00','20:00',null); raise exception 'null version accepted'; exception when serialization_failure then null; end;
  perform public.save_opening_hours('ammu-sammu','10:00','20:00',v);
  begin perform public.save_restaurant_settings('ammu-sammu','+919876543210',null,0,0,v); raise exception 'settings form saved over an hours edit'; exception when serialization_failure then null; end;
  perform public.save_restaurant_settings('ammu-sammu','+919876543210',null,0,0,v + 1);
  begin perform public.save_opening_hours('ammu-sammu','10:00','20:00',v + 1); raise exception 'hours form saved over a settings edit'; exception when serialization_failure then null; end;
end $$;
select public.test_assert((select opens_at='10:00' and closes_at='20:00' from public.businesses where slug='ammu-sammu'), 'the settings save left the hours alone');
-- Not the owner: another restaurant's owner, a customer, an unknown restaurant, and a revoked owner all fail.
select set_config('request.jwt.claim.sub','53000000-0000-4000-8000-000000000002',true);
select set_config('request.jwt.claims','{"session_id":"53000000-0000-4000-8000-000000000002"}',true);
select public.test_assert(public.t_save('08:00','21:00') like '42501:%', 'another restaurant''s owner cannot edit these hours');
select public.test_assert(public.t_save('08:00','21:00','missing',1) like '42501:%', 'an unknown restaurant is refused');
select public.test_assert(public.t_save('08:00','21:00','kokani-dine-inn') = 'ok', 'that owner edits their own restaurant');
select set_config('request.jwt.claim.sub','53000000-0000-4000-8000-000000000003',true);
select set_config('request.jwt.claims','{"session_id":"53000000-0000-4000-8000-000000000003"}',true);
select public.test_assert(public.t_save('08:00','21:00') like '42501:%' and public.t_save('08:00','21:00','kokani-dine-inn') like '42501:%', 'a customer cannot edit hours');
-- Dead sessions: a valid-looking JWT for an unknown, missing, foreign, expired or deleted session.
select set_config('request.jwt.claim.sub','53000000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"session_id":"53000000-0000-4000-8000-000000000099"}',true);
select public.test_assert(public.t_save('08:00','21:00') = '42501:INVALID_SESSION', 'unknown session refused');
select set_config('request.jwt.claims','{}',true);
select public.test_assert(public.t_save('08:00','21:00') = '42501:INVALID_SESSION', 'missing session refused');
select set_config('request.jwt.claims','{"session_id":"53000000-0000-4000-8000-000000000002"}',true);
select public.test_assert(public.t_save('08:00','21:00') = '42501:INVALID_SESSION', 'another user''s session refused');
reset role;
update auth.sessions set not_after=now()-interval '1 second' where id='53000000-0000-4000-8000-000000000001';
set role authenticated;
select set_config('request.jwt.claims','{"session_id":"53000000-0000-4000-8000-000000000001"}',true);
select public.test_assert(public.t_save('08:00','21:00') = '42501:INVALID_SESSION', 'expired session refused');
reset role;
delete from auth.sessions where id='53000000-0000-4000-8000-000000000001';
set role authenticated;
select public.test_assert(public.t_save('08:00','21:00') = '42501:INVALID_SESSION', 'deleted (signed-out) session refused');
reset role;
insert into auth.sessions(id,user_id) values ('53000000-0000-4000-8000-000000000001','53000000-0000-4000-8000-000000000001');
delete from public.business_memberships where user_id='53000000-0000-4000-8000-000000000001';
set role authenticated;
select public.test_assert(public.t_save('08:00','21:00') like '42501:%', 'a revoked owner cannot edit');
reset role;
select public.test_assert((select opens_at='10:00' and closes_at='20:00' from public.businesses where slug='ammu-sammu'), 'refused edits changed nothing');
select set_config('timezone','UTC',true);
rollback;
