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
for db in fresh existing; do
  docker exec "$container" createdb -U postgres "$db"
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" < tests/database/fixture.sql
  if [[ "$db" == existing ]]; then
    docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" -c 'create extension if not exists postgis with schema public'
  fi
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" < supabase/migrations/20261112000000_database_isolation.sql
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" < supabase/seed.sql
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" < tests/database/isolation.sql
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" < supabase/migrations/20261112000001_checkout.sql
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" < tests/database/checkout.sql
  # Two sessions race the same first request and must both recover one order.
  fix_time=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  race_order() {
    docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 -v fix="$fix_time" -U postgres -d "$db" >/dev/null <<'SQL'
set role authenticated;
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000001',false);
select public.place_order('ammu-sammu','[{"menu_item_id":"20000000-0000-4000-8000-000000000001","quantity":1}]','{"name":"Race","phone":"123","address_line":"Test"}',jsonb_build_object('latitude',0.5,'longitude',0.5,'accuracy',10,'captured_at',:'fix'),'60000000-0000-4000-8000-000000000099');
SQL
  }
  race_order & first=$!
  race_order & second=$!
  failed=0
  wait "$first" || failed=1
  wait "$second" || failed=1
  if (( failed )); then echo 'Concurrent order requests failed' >&2; exit 1; fi
  docker exec "$container" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$db" -c "select public.test_assert((select count(*)=1 from public.orders where customer_id='30000000-0000-4000-8000-000000000001' and idempotency_key='60000000-0000-4000-8000-000000000099'), 'concurrent retry creates one order')"
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" < supabase/migrations/20261112000002_notifications.sql
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" < tests/database/notifications.sql
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" < supabase/migrations/20261113194819_customer_order_notification_route.sql
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" < tests/database/notification-routing.sql
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" < supabase/migrations/20261114000000_accepting_orders.sql
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" < tests/database/accepting-orders.sql
  # An order and a closing at the same moment are serialized by the business row lock.
  # Output is discarded; errors stay visible (race 2 prints its expected refusal).
  as_user() { docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$db" >/dev/null; }
  set_open() { printf "set role authenticated; select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000003',false); select public.set_accepting_orders('ammu-sammu',%s);\n" "$1" | as_user; }
  place_sql() { printf "set role authenticated; select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000001',false); select public.place_order('ammu-sammu','[{\"menu_item_id\":\"20000000-0000-4000-8000-000000000001\",\"quantity\":1}]','{\"name\":\"Race\",\"phone\":\"123\",\"address_line\":\"Test\"}',jsonb_build_object('latitude',0.5,'longitude',0.5,'accuracy',10,'captured_at',clock_timestamp()),'%s');\n" "$1"; }
  count_orders() { docker exec "$container" psql -X -q -t -A -U postgres -d "$db" -c "select count(*) from public.orders where idempotency_key='$1'"; }
  # 1. An order in flight finishes; a close during it does not undo or refuse it.
  set_open true
  { echo 'begin;'; place_sql 60000000-0000-4000-8000-000000000584; echo 'select pg_sleep(3); commit;'; } | as_user & order_pid=$!
  sleep 1
  set_open false
  wait "$order_pid" || { echo 'In-flight order was refused by a later close' >&2; exit 1; }
  [[ "$(count_orders 60000000-0000-4000-8000-000000000584)" == 1 ]] || { echo 'In-flight order missing' >&2; exit 1; }
  # 2. A close in flight finishes first; the order waits and is refused.
  set_open true
  { echo "begin; set role authenticated; select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000003',false); select public.set_accepting_orders('ammu-sammu',false); select pg_sleep(3); commit;"; } | as_user & close_pid=$!
  sleep 1
  refusal=$(place_sql 60000000-0000-4000-8000-000000000585 | docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$db" 2>&1 >/dev/null) && { echo 'Order accepted during a close' >&2; exit 1; }
  grep -q 'restaurant is not accepting orders' <<<"$refusal" || { echo "$refusal" >&2; echo 'Order during a close failed for another reason' >&2; exit 1; }
  wait "$close_pid"
  [[ "$(count_orders 60000000-0000-4000-8000-000000000585)" == 0 ]] || { echo 'Order placed during a close' >&2; exit 1; }
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" < supabase/migrations/20261114082153_menu_diet_snapshots.sql
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" < supabase/migrations/20261114133057_accepted_checkout_pricing.sql
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" < tests/database/menu-diet.sql
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" < tests/database/pricing.sql
  # Exercise the accepted-pricing signature under simultaneous first requests.
  set_open true
  fix_time=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  race_priced_order() {
    docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 -v fix="$fix_time" -U postgres -d "$db" >/dev/null <<'SQL'
set role authenticated;
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000001',false);
select public.place_order('ammu-sammu',jsonb_build_array(jsonb_build_object('menu_item_id',m.id,'quantity',1)),'{"name":"Pricing race","phone":"123","address_line":"Test"}',jsonb_build_object('latitude',0.5,'longitude',0.5,'accuracy',10,'captured_at',:'fix'),'64000000-0000-4000-8000-000000000099',jsonb_build_object('lines',jsonb_build_array(jsonb_build_object('menu_item_id',m.id,'quantity',1,'unit_price_paise',m.price_paise,'line_total_paise',m.price_paise)),'delivery_fee_paise',b.delivery_fee_paise,'min_order_paise',b.min_order_paise,'subtotal_paise',m.price_paise,'total_paise',m.price_paise+b.delivery_fee_paise)) from public.menu_items m join public.businesses b on b.id=m.business_id where m.id='20000000-0000-4000-8000-000000000001';
SQL
  }
  race_priced_order & first=$!
  race_priced_order & second=$!
  failed=0
  wait "$first" || failed=1
  wait "$second" || failed=1
  if (( failed )); then echo 'Concurrent accepted-pricing requests failed' >&2; exit 1; fi
  [[ "$(count_orders 64000000-0000-4000-8000-000000000099)" == 1 ]] || { echo 'Accepted-pricing race did not create exactly one order' >&2; exit 1; }
done
# Installation order differs from the staged regression suites: apply every
# migration before seed, proving unknown sample data can be bootstrapped safely.
for db in all_fresh all_existing; do
  docker exec "$container" createdb -U postgres "$db"
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" < tests/database/fixture.sql
  if [[ "$db" == all_existing ]]; then
    docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" -c 'create extension if not exists postgis with schema public'
  fi
  for migration in supabase/migrations/*.sql; do
    docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" < "$migration"
  done
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" < supabase/seed.sql
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" < tests/database/menu-diet.sql
done
echo 'Database isolation, checkout, notification, open/closed and diet tests passed, including all migrations before seed in both PostGIS schemas.'
