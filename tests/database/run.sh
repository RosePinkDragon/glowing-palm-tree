#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
container="database-isolation-${RANDOM}-$$"
cleanup() { docker rm -fv "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
# A disposable local-only password, no published ports or persistent volumes.
docker run -d --name "$container" -e POSTGRES_PASSWORD=local-isolation-test-only postgis/postgis:17-3.5-alpine >/dev/null
ready=false
for _ in {1..60}; do
  if docker exec "$container" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
if [[ "$ready" != true ]]; then echo 'PostGIS did not become ready' >&2; exit 1; fi
# Helpers for the database named in $db. sql_file applies a file, sql_in runs stdin quietly, sql_cmd runs one statement.
sql_file() { docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" < "$1"; }
sql_in() { docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 "$@" -U postgres -d "$db" >/dev/null; }
sql_cmd() { docker exec "$container" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$db" -c "$1"; }

# ---------------------------------------------------------------------------
# Final-schema pass: the baseline migration (every file in supabase/migrations) once per PostGIS layout (a fresh install, and one where
# PostGIS already lives in public), then seed, then every suite and every race.
# ---------------------------------------------------------------------------
# Suites that need nothing but the migrated, seeded schema; each rolls back.
self_contained=(menu-categories menu-photos owner-history menu-reorder daily-summary order-numbers saved-addresses menu-diet menu-featured restaurant-settings customer-notifications owner-display-name customer-relationships)
# Suites that share final-fixture.sql and run in this order (checkout leaves the restaurant closed,
# notification-routing continues from notifications).
shared_fixture=(isolation checkout notifications notification-routing accepting-orders pricing)
for db in all_fresh all_existing; do
  docker exec "$container" createdb -U postgres "$db"
  sql_file tests/database/fixture.sql
  if [[ "$db" == all_existing ]]; then
    sql_cmd 'create extension if not exists postgis with schema public'
  fi
  # Apply the baseline before seed, proving sample data can be bootstrapped safely.
  for migration in supabase/migrations/*.sql; do
    sql_file "$migration"
  done
  sql_file supabase/seed.sql
  sql_file tests/database/helpers.sql
  for suite in "${self_contained[@]}"; do sql_file "tests/database/$suite.sql"; done
  sql_file tests/database/final-fixture.sql
  for suite in "${shared_fixture[@]}"; do sql_file "tests/database/$suite.sql"; done

  # Races (committed fixtures, real concurrent sessions). All place orders through a saved address
  # with the exact accepted-pricing quote; customer A's address comes from final-fixture.sql.
  sql_in <<'SQL'
do $$ declare ns text; begin
  select n.nspname into strict ns from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='postgis';
  execute format('update public.businesses set is_demo=false,service_area=%1$I.st_geomfromtext(''MULTIPOLYGON(((0 0,1 0,1 1,0 1,0 0)))'',4326),service_area_source=''race-test-only'',service_area_version=''test'',service_area_verified_at=now(),ordering_enabled=true,accepting_orders=true,delivery_fee_paise=0,min_order_paise=0 where slug=''ammu-sammu''',ns);
end $$;
update public.menu_items set available=true,is_demo=false,price_paise=15000 where id='20000000-0000-4000-8000-000000000001';
insert into public.business_memberships(business_id,user_id,role) values ('10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000003','admin') on conflict do nothing;
SQL
  race_items='[{"menu_item_id":"20000000-0000-4000-8000-000000000001","quantity":1}]'
  count_orders() { docker exec "$container" psql -X -q -t -A -U postgres -d "$db" -c "select count(*) from public.orders where idempotency_key='$1'"; }
  # 1. Two sessions race the same first request and must both recover one order.
  fix_time=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  race_order() {
    docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 -v fix="$fix_time" -v items="$race_items" -U postgres -d "$db" >/dev/null <<'SQL'
set role authenticated;
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000001',false);
select public.place_order('ammu-sammu',:'items',public.test_delivery('Race'),jsonb_build_object('latitude',0.5,'longitude',0.5,'accuracy',10,'captured_at',:'fix'),'60000000-0000-4000-8000-000000000099',public.test_quote('ammu-sammu',:'items'));
SQL
  }
  race_order & first=$!
  race_order & second=$!
  failed=0
  wait "$first" || failed=1
  wait "$second" || failed=1
  if (( failed )); then echo 'Concurrent order requests failed' >&2; exit 1; fi
  sql_cmd "select public.test_assert((select count(*)=1 from public.orders where customer_id='30000000-0000-4000-8000-000000000001' and idempotency_key='60000000-0000-4000-8000-000000000099'), 'concurrent retry creates one order')"
  # An order and a closing at the same moment are serialized by the business row lock.
  # Output is discarded; errors stay visible (race 3 prints its expected refusal).
  as_user() { docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$db" >/dev/null; }
  set_open() { printf "set role authenticated; select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000003',false); select public.set_accepting_orders('ammu-sammu',%s);\n" "$1" | as_user; }
  place_sql() { printf "set role authenticated; select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000001',false); select public.place_order('ammu-sammu','%s',public.test_delivery('Race'),jsonb_build_object('latitude',0.5,'longitude',0.5,'accuracy',10,'captured_at',clock_timestamp()),'%s',public.test_quote('ammu-sammu','%s'));\n" "$race_items" "$1" "$race_items"; }
  # 2. An order in flight finishes; a close during it does not undo or refuse it.
  set_open true
  { echo 'begin;'; place_sql 60000000-0000-4000-8000-000000000584; echo 'select pg_sleep(3); commit;'; } | as_user & order_pid=$!
  sleep 1
  set_open false
  wait "$order_pid" || { echo 'In-flight order was refused by a later close' >&2; exit 1; }
  [[ "$(count_orders 60000000-0000-4000-8000-000000000584)" == 1 ]] || { echo 'In-flight order missing' >&2; exit 1; }
  # 3. A close in flight finishes first; the order waits and is refused.
  set_open true
  { echo "begin; set role authenticated; select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000003',false); select public.set_accepting_orders('ammu-sammu',false); select pg_sleep(3); commit;"; } | as_user & close_pid=$!
  sleep 1
  refusal=$(place_sql 60000000-0000-4000-8000-000000000585 | docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$db" 2>&1 >/dev/null) && { echo 'Order accepted during a close' >&2; exit 1; }
  grep -q 'restaurant is not accepting orders' <<<"$refusal" || { echo "$refusal" >&2; echo 'Order during a close failed for another reason' >&2; exit 1; }
  wait "$close_pid"
  [[ "$(count_orders 60000000-0000-4000-8000-000000000585)" == 0 ]] || { echo 'Order placed during a close' >&2; exit 1; }
  # 4. Exercise the accepted-pricing signature under simultaneous first requests.
  set_open true
  fix_time=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  race_priced_order() {
    docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 -v fix="$fix_time" -v items="$race_items" -U postgres -d "$db" >/dev/null <<'SQL'
set role authenticated;
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000001',false);
select public.place_order('ammu-sammu',:'items',public.test_delivery('Pricing race'),jsonb_build_object('latitude',0.5,'longitude',0.5,'accuracy',10,'captured_at',:'fix'),'64000000-0000-4000-8000-000000000099',public.test_quote('ammu-sammu',:'items'));
SQL
  }
  race_priced_order & first=$!
  race_priced_order & second=$!
  failed=0
  wait "$first" || failed=1
  wait "$second" || failed=1
  if (( failed )); then echo 'Concurrent accepted-pricing requests failed' >&2; exit 1; fi
  [[ "$(count_orders 64000000-0000-4000-8000-000000000099)" == 1 ]] || { echo 'Accepted-pricing race did not create exactly one order' >&2; exit 1; }
  # 5. Real concurrent RPCs: four unique keys plus two first attempts at one key.
  set_open true
  number_before=$(docker exec "$container" psql -X -q -t -A -U postgres -d "$db" -c "select sum(last_number) from public.order_number_counters")
  fix_time=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  number_race() {
    docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 -v fix="$fix_time" -v key="$1" -v items="$race_items" -U postgres -d "$db" >/dev/null <<'SQL'
set role authenticated;
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000001',false);
select public.place_order('ammu-sammu',:'items',public.test_delivery('Number race'),jsonb_build_object('latitude',0.5,'longitude',0.5,'accuracy',10,'captured_at',:'fix'),:'key'::uuid,public.test_quote('ammu-sammu',:'items'));
SQL
  }
  number_pids=()
  for suffix in 1 2 3 4 5 5; do
    number_race "64700000-0000-4000-8000-00000000010${suffix}" & number_pids+=("$!")
  done
  for pid in "${number_pids[@]}"; do wait "$pid" || { echo 'Numbering race failed' >&2; exit 1; }; done
  sql_cmd "select public.test_assert((select count(*)=5 and count(distinct order_number)=5 from public.orders where idempotency_key::text like '64700000-0000-4000-8000-00000000010%'),'concurrent distinct requests have unique numbers and replay creates one'); select public.test_assert((select sum(last_number)=$number_before+5 from public.order_number_counters),'concurrent replay consumes no extra counter')"
  # #48: an address edit made while checkout holds the address waits for it, and
  # the order keeps exactly the version it locked. Committed fixture, last step.
  docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$db" >/dev/null <<'SQL'
do $$ declare ns text; begin
  select n.nspname into strict ns from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='postgis';
  execute format('update public.businesses set is_demo=false,service_area=%1$I.st_geomfromtext(''MULTIPOLYGON(((0 0,1 0,1 1,0 1,0 0)))'',4326),service_area_source=''address-race-test-only'',service_area_version=''test'',service_area_verified_at=now(),ordering_enabled=true,accepting_orders=true,delivery_fee_paise=0,min_order_paise=0 where slug=''ammu-sammu''',ns);
end $$;
update public.menu_items set available=true,is_demo=false where id='20000000-0000-4000-8000-000000000001';
insert into auth.users(id) values ('34800000-0000-4000-8000-000000000009') on conflict do nothing;
insert into public.customer_addresses(id,customer_id,label,house,street_area,latitude,longitude,location_source)
  values ('74800000-0000-4000-8000-000000000001','34800000-0000-4000-8000-000000000009','home','Before edit','Race Road',0.4,0.4,'pin');
SQL
  docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$db" >/dev/null <<'SQL' &
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','34800000-0000-4000-8000-000000000009',true);
select public.place_order('ammu-sammu','[{"menu_item_id":"20000000-0000-4000-8000-000000000001","quantity":1}]','{"name":"Race","phone":"123","address_id":"74800000-0000-4000-8000-000000000001","address_version":1}',null,'64800000-0000-4000-8000-000000000099',
  jsonb_build_object('lines',jsonb_build_array(jsonb_build_object('menu_item_id',m.id,'quantity',1,'unit_price_paise',m.price_paise,'line_total_paise',m.price_paise)),'delivery_fee_paise',0,'min_order_paise',0,'subtotal_paise',m.price_paise,'total_paise',m.price_paise))
  from public.menu_items m where m.id='20000000-0000-4000-8000-000000000001';
select pg_sleep(2);
commit;
SQL
  checkout_pid=$!
  # Wait until the checkout has placed its order and holds the address (it is sleeping).
  held=false
  for _ in {1..100}; do
    if [[ $(docker exec "$container" psql -X -qtA -U postgres -d "$db" -c "select count(*) from pg_stat_activity where state='active' and query like '%pg_sleep(2)%' and pid<>pg_backend_pid()") == 1 ]]; then held=true; break; fi
    sleep 0.1
  done
  if [[ "$held" != true ]]; then echo 'Saved-address checkout race never held the address' >&2; exit 1; fi
  docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$db" >/dev/null <<'SQL'
set role authenticated;
select set_config('request.jwt.claim.sub','34800000-0000-4000-8000-000000000009',false);
set lock_timeout = '300ms';
do $$ begin
  update public.customer_addresses set house='Edited during checkout' where id='74800000-0000-4000-8000-000000000001';
  raise exception 'address edit did not wait for the open checkout';
exception when lock_not_available then null; end $$;
SQL
  wait "$checkout_pid" || { echo 'Saved-address checkout race failed' >&2; exit 1; }
  docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$db" >/dev/null <<'SQL'
set role authenticated;
select set_config('request.jwt.claim.sub','34800000-0000-4000-8000-000000000009',false);
update public.customer_addresses set house='Edited during checkout' where id='74800000-0000-4000-8000-000000000001';
SQL
  docker exec "$container" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$db" -c "do \$\$ begin if not coalesce((select o.address_house='Before edit' and o.saved_address_version=1 and a.version=2 and a.house='Edited during checkout' from public.orders o join public.customer_addresses a on a.id=o.saved_address_id where o.idempotency_key='64800000-0000-4000-8000-000000000099'),false) then raise exception 'the order must keep the version locked at checkout'; end if; end \$\$"
  source tests/database/restaurant-settings-races.sh
  source tests/database/customer-notifications-races.sh
  source tests/database/owner-display-name-races.sh
  source tests/database/customer-relationships-races.sh
done
echo 'Baseline, final-schema suites and races (including restaurant settings, customer feed and owner names) passed in both PostGIS layouts.'
