#!/usr/bin/env bash
# Sourced by run.sh inside each disposable final-schema database. No remote URL.
settings_sql() { docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$db" "$@"; }
settings_sql >/dev/null <<'SQL'
create or replace function public.test_assert(ok boolean, message text) returns void language plpgsql as $$ begin if not coalesce(ok,false) then raise exception 'assertion failed: %',message; end if; end $$;
grant execute on function public.test_assert(boolean,text) to authenticated;
insert into auth.users(id) values ('46000000-0000-4000-8000-000000000011'),('46000000-0000-4000-8000-000000000012'),('46000000-0000-4000-8000-000000000013');
insert into auth.sessions(id,user_id) select id,id from auth.users where id::text like '46000000-%';
insert into public.business_memberships(business_id,user_id,role) values
 ('10000000-0000-4000-8000-000000000001','46000000-0000-4000-8000-000000000011','admin'),
 ('10000000-0000-4000-8000-000000000001','46000000-0000-4000-8000-000000000012','admin');
do $$ declare ns text; begin
 select n.nspname into strict ns from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='postgis';
 execute format('update public.businesses set is_demo=false,service_area=%1$I.st_geomfromtext(''MULTIPOLYGON(((0 0,1 0,1 1,0 1,0 0)))'',4326),service_area_source=''settings-race-test-only'',service_area_version=''test'',service_area_verified_at=now(),ordering_enabled=true,accepting_orders=true,delivery_fee_paise=100,min_order_paise=0 where slug=''ammu-sammu''',ns);
end $$;
update public.menu_items set price_paise=15000,available=true,is_demo=false where id='20000000-0000-4000-8000-000000000001';
insert into public.customer_addresses(id,customer_id,label,house,street_area,latitude,longitude,location_source)
 values ('76000000-0000-4000-8000-000000000001','46000000-0000-4000-8000-000000000013','home','Settings test','Test Road',0.5,0.5,'pin');
-- A real pre-change order, used to prove snapshots and replay survive the save.
set role authenticated;
select set_config('request.jwt.claim.sub','46000000-0000-4000-8000-000000000013',false);
select public.place_order('ammu-sammu','[{"menu_item_id":"20000000-0000-4000-8000-000000000001","quantity":1}]',
 '{"name":"Settings customer","phone":"9876543210","address_id":"76000000-0000-4000-8000-000000000001","address_version":1}',null,'66000000-0000-4000-8000-000000000001',
 '{"lines":[{"menu_item_id":"20000000-0000-4000-8000-000000000001","quantity":1,"unit_price_paise":15000,"line_total_paise":15000}],"delivery_fee_paise":100,"min_order_paise":0,"subtotal_paise":15000,"total_paise":15100}');
SQL
settings_version=$(settings_sql -tA -c "select settings_version from public.businesses where slug='ammu-sammu'")
# Hold the first successful save open so the second owner definitely waits.
settings_sql -v version="$settings_version" >/dev/null <<'SQL' &
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','46000000-0000-4000-8000-000000000011',true);
select set_config('request.jwt.claims','{"session_id":"46000000-0000-4000-8000-000000000011"}',true);
select public.save_restaurant_settings('ammu-sammu','+919876543210',null,2000,0,:'version'::integer);
select pg_sleep(2);
commit;
SQL
settings_pid=$!
settings_held=false
for _ in {1..100}; do
 if [[ $(settings_sql -tA -c "select count(*) from pg_stat_activity where state='active' and query='select pg_sleep(2);' and pid<>pg_backend_pid()") == 1 ]]; then settings_held=true; break; fi
 sleep 0.1
done
if [[ "$settings_held" != true ]]; then echo 'Settings race did not hold the business lock' >&2; exit 1; fi
# Checkout cannot read a partially saved fee/minimum while that lock is held.
settings_sql >/dev/null <<'SQL'
set role authenticated;
select set_config('request.jwt.claim.sub','46000000-0000-4000-8000-000000000013',false);
set lock_timeout='300ms';
do $$ begin
 perform public.place_order('ammu-sammu','[{"menu_item_id":"20000000-0000-4000-8000-000000000001","quantity":1}]',
  '{"name":"Settings customer","phone":"9876543210","address_id":"76000000-0000-4000-8000-000000000001","address_version":1}',null,'66000000-0000-4000-8000-000000000004',
  '{"lines":[{"menu_item_id":"20000000-0000-4000-8000-000000000001","quantity":1,"unit_price_paise":15000,"line_total_paise":15000}],"delivery_fee_paise":100,"min_order_paise":0,"subtotal_paise":15000,"total_paise":15100}');
 raise exception 'checkout did not serialize with the settings save';
exception when lock_not_available then null; end $$;
select public.test_assert(not exists(select 1 from public.orders where idempotency_key='66000000-0000-4000-8000-000000000004'),'blocked checkout creates no order');
SQL
# This stale save waits for the first transaction, then must fail, not overwrite it.
settings_sql -v version="$settings_version" >/dev/null <<'SQL'
set role authenticated;
select set_config('request.jwt.claim.sub','46000000-0000-4000-8000-000000000012',false);
select set_config('request.jwt.claims','{"session_id":"46000000-0000-4000-8000-000000000012"}',false);
select set_config('test.settings_version',:'version',false);
do $$ begin
 perform public.save_restaurant_settings('ammu-sammu','+919876543211','+919876543212',3000,100,current_setting('test.settings_version')::integer);
 raise exception 'second owner overwrote the concurrent save';
exception when serialization_failure then null; end $$;
SQL
wait "$settings_pid" || { echo 'Concurrent settings save failed' >&2; exit 1; }
settings_sql -v version="$settings_version" >/dev/null <<'SQL'
select public.test_assert((select delivery_fee_paise=2000 and min_order_paise=0 and contact_phone='+919876543210' and whatsapp_phone is null and settings_version=:'version'::integer+1 from public.businesses where slug='ammu-sammu'),'concurrent stale save cannot overwrite any field');
select public.test_assert((select delivery_fee_paise=100 and total_paise=15100 from public.orders where idempotency_key='66000000-0000-4000-8000-000000000001'),'past order retains its fee and total');
SQL
# The original payload replays its original order even after a settings change.
# A new key gets a no-order quote; accepting it with a new key creates one order.
settings_sql >/dev/null <<'SQL'
set role authenticated;
select set_config('request.jwt.claim.sub','46000000-0000-4000-8000-000000000013',false);
do $$ declare items jsonb := '[{"menu_item_id":"20000000-0000-4000-8000-000000000001","quantity":1}]';
 delivery jsonb := '{"name":"Settings customer","phone":"9876543210","address_id":"76000000-0000-4000-8000-000000000001","address_version":1}';
 quote jsonb := '{"lines":[{"menu_item_id":"20000000-0000-4000-8000-000000000001","quantity":1,"unit_price_paise":15000,"line_total_paise":15000}],"delivery_fee_paise":100,"min_order_paise":0,"subtotal_paise":15000,"total_paise":15100}';
 result jsonb;
begin
 result := public.place_order('ammu-sammu',items,delivery,null,'66000000-0000-4000-8000-000000000001',quote);
 perform public.test_assert(result->>'outcome'='placed' and (result->>'total_paise')::int=15100,'old request replays its original snapshot');
 result := public.place_order('ammu-sammu',items,delivery,null,'66000000-0000-4000-8000-000000000002',quote);
 perform public.test_assert(result->>'outcome'='pricing_changed' and (result->'pricing'->>'delivery_fee_paise')::int=2000 and (result->'pricing'->>'total_paise')::int=17000,'mid-checkout customer must accept new terms');
 perform public.test_assert(not exists(select 1 from public.orders where idempotency_key='66000000-0000-4000-8000-000000000002'),'rejected terms create no order');
 result := public.place_order('ammu-sammu',items,delivery,null,'66000000-0000-4000-8000-000000000003',result->'pricing');
 perform public.test_assert(result->>'outcome'='placed' and (result->>'total_paise')::int=17000,'accepted new quote uses new fee');
end $$;
SQL
# A changed minimum is also a revised term, and accepting an insufficient cart
# still cannot bypass the new server-side minimum.
settings_sql >/dev/null <<'SQL'
set role authenticated;
select set_config('request.jwt.claim.sub','46000000-0000-4000-8000-000000000012',false);
select set_config('request.jwt.claims','{"session_id":"46000000-0000-4000-8000-000000000012"}',false);
select public.save_restaurant_settings('ammu-sammu','+919876543210',null,2000,20000,settings_version) from public.businesses where slug='ammu-sammu';
select set_config('request.jwt.claim.sub','46000000-0000-4000-8000-000000000013',false);
do $$ declare items jsonb := '[{"menu_item_id":"20000000-0000-4000-8000-000000000001","quantity":1}]';
 delivery jsonb := '{"name":"Settings customer","phone":"9876543210","address_id":"76000000-0000-4000-8000-000000000001","address_version":1}';
 quote jsonb := '{"lines":[{"menu_item_id":"20000000-0000-4000-8000-000000000001","quantity":1,"unit_price_paise":15000,"line_total_paise":15000}],"delivery_fee_paise":2000,"min_order_paise":0,"subtotal_paise":15000,"total_paise":17000}';
 result jsonb;
begin
 result := public.place_order('ammu-sammu',items,delivery,null,'66000000-0000-4000-8000-000000000005',quote);
 perform public.test_assert(result->>'outcome'='pricing_changed' and (result->'pricing'->>'min_order_paise')::int=20000,'new minimum must be reviewed');
 begin
  perform public.place_order('ammu-sammu',items,delivery,null,'66000000-0000-4000-8000-000000000006',result->'pricing');
  raise exception 'cart below the new minimum was accepted';
 exception when invalid_parameter_value then null; end;
 perform public.test_assert(not exists(select 1 from public.orders where idempotency_key in ('66000000-0000-4000-8000-000000000005','66000000-0000-4000-8000-000000000006')),'minimum rejections create no orders');
end $$;
SQL
