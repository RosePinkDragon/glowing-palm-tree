#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
container="database-isolation-${RANDOM}-$$"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
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
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" < supabase/migrations/20261114000000_accepting_orders.sql
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" < tests/database/accepting-orders.sql
  # An order and a closing at the same moment are serialized by the business row lock.
  as_user() { docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$db" >/dev/null 2>&1; }
  set_open() { printf "set role authenticated; select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000003',false); select public.set_accepting_orders('ammu-sammu',%s);\n" "$1" | as_user; }
  place_sql() { printf "set role authenticated; select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000001',false); select public.place_order('ammu-sammu','[{\"menu_item_id\":\"20000000-0000-4000-8000-000000000001\",\"quantity\":1}]','{\"name\":\"Race\",\"phone\":\"123\",\"address_line\":\"Test\"}',jsonb_build_object('latitude',0.5,'longitude',0.5,'accuracy',10,'captured_at',clock_timestamp()),'%s');\n" "$1"; }
  count_orders() { docker exec "$container" psql -X -q -t -A -U postgres -d "$db" -c "select count(*) from public.orders where idempotency_key='$1'"; }
  # 1. An order in flight finishes first; the close waits for it.
  set_open true
  { echo 'begin;'; place_sql 60000000-0000-4000-8000-000000000584; echo 'select pg_sleep(2); commit;'; } | as_user & order_pid=$!
  sleep 1
  set_open false
  wait "$order_pid" || { echo 'In-flight order was refused by a later close' >&2; exit 1; }
  [[ "$(count_orders 60000000-0000-4000-8000-000000000584)" == 1 ]] || { echo 'In-flight order missing' >&2; exit 1; }
  # 2. A close in flight finishes first; the order waits and is refused.
  set_open true
  { echo "begin; set role authenticated; select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000003',false); select public.set_accepting_orders('ammu-sammu',false); select pg_sleep(2); commit;"; } | as_user & close_pid=$!
  sleep 1
  if place_sql 60000000-0000-4000-8000-000000000585 | as_user; then echo 'Order accepted during a close' >&2; exit 1; fi
  wait "$close_pid"
  [[ "$(count_orders 60000000-0000-4000-8000-000000000585)" == 0 ]] || { echo 'Order placed during a close' >&2; exit 1; }
done
echo 'Database isolation, checkout, notification and open/closed tests passed in fresh and existing PostGIS schemas.'
