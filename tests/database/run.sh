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
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" <<'SQL'
insert into public.businesses(id,slug,name,is_demo) values
('10000000-0000-4000-8000-000000000001','ammu-sammu','Ammu Sammu',true),
('10000000-0000-4000-8000-000000000002','kokani-dine-inn','Kokani Dine Inn',true);
insert into public.menu_items(id,business_id,name,category,price_paise,is_demo) values
('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Demo meal','Demo',15000,true),
('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','Demo meal','Demo',18000,true);
SQL
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
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" < supabase/migrations/20261114140135_menu_featured_item_order.sql
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" < tests/database/menu-featured.sql
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
  # Backfill trims and merges only names within the same business.
  docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" -c "insert into public.menu_items(id,business_id,name,category,price_paise,diet) values ('24300000-0000-4000-8000-000000000099','10000000-0000-4000-8000-000000000001','Backfill',' Demo ',100,'egg')"
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" < supabase/migrations/20261114142756_menu_categories.sql
  docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" -c "select public.test_assert((select a.category_id=b.category_id and a.diet='egg' from public.menu_items a cross join public.menu_items b where a.id='24300000-0000-4000-8000-000000000099' and b.id='20000000-0000-4000-8000-000000000001'),'trimmed category backfill preserves diet and assignment')"
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -v before_migration=1 -U postgres -d "$db" < tests/database/order-numbers.sql
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" < supabase/migrations/20261116103753_order_tracking_numbers.sql
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" < supabase/seed.sql
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" < tests/database/menu-categories.sql
  # Earlier owner transitions from the checkout suite, plus one by an owner who
  # has since been removed, exercise the snapshot backfill.
  docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" -c "insert into auth.users(id) values ('49800000-0000-4000-8000-0000000000ff'); insert into public.order_status_history(order_id,status,changed_by) select id,'accepted','49800000-0000-4000-8000-0000000000ff' from public.orders order by created_at, id limit 1"
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" < supabase/migrations/20261116000000_owner_history_names.sql
  docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" -c "select public.test_assert((select count(*) = 1 from public.order_status_actors a join public.order_status_history h on h.id = a.history_id where h.changed_by = '49800000-0000-4000-8000-0000000000ff' and a.actor_name = 'Former owner' and a.actor_id is null), 'removed owner backfills as Former owner') ; select public.test_assert(exists (select 1 from public.order_status_actors a join public.order_status_history h on h.id = a.history_id join public.orders o on o.id = h.order_id join public.business_memberships m on m.business_id = o.business_id and m.user_id = h.changed_by where a.actor_name = m.display_name and a.actor_id = h.changed_by), 'current owners backfill with their membership name')"
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" < tests/database/owner-history.sql
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" < tests/database/order-numbers.sql
  # Real concurrent RPCs: four unique keys plus two first attempts at one key.
  set_open true
  number_before=$(docker exec "$container" psql -X -q -t -A -U postgres -d "$db" -c "select sum(last_number) from public.order_number_counters")
  fix_time=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  number_race() {
    docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 -v fix="$fix_time" -v key="$1" -U postgres -d "$db" >/dev/null <<'SQL'
set role authenticated;
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000001',false);
select public.place_order('ammu-sammu',jsonb_build_array(jsonb_build_object('menu_item_id',m.id,'quantity',1)),'{"name":"Number race","phone":"123","address_line":"Test"}',jsonb_build_object('latitude',0.5,'longitude',0.5,'accuracy',10,'captured_at',:'fix'),:'key'::uuid,jsonb_build_object('lines',jsonb_build_array(jsonb_build_object('menu_item_id',m.id,'quantity',1,'unit_price_paise',m.price_paise,'line_total_paise',m.price_paise)),'delivery_fee_paise',b.delivery_fee_paise,'min_order_paise',b.min_order_paise,'subtotal_paise',m.price_paise,'total_paise',m.price_paise+b.delivery_fee_paise)) from public.menu_items m join public.businesses b on b.id=m.business_id where m.id='20000000-0000-4000-8000-000000000001';
SQL
  }
  number_pids=()
  for suffix in 1 2 3 4 5 5; do
    number_race "64700000-0000-4000-8000-00000000010${suffix}" & number_pids+=("$!")
  done
  for pid in "${number_pids[@]}"; do wait "$pid" || { echo 'Numbering race failed' >&2; exit 1; }; done
  docker exec "$container" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$db" -c "select public.test_assert((select count(*)=5 and count(distinct order_number)=5 from public.orders where idempotency_key::text like '64700000-0000-4000-8000-00000000010%'),'concurrent distinct requests have unique numbers and replay creates one'); select public.test_assert((select sum(last_number)=$number_before+5 from public.order_number_counters),'concurrent replay consumes no extra counter')"
  # #48 upgrade path: existing businesses and legacy GPS orders, then the saved-address
  # and kitchen-point migrations. Legacy orders must satisfy the new evidence check,
  # and the kitchen points must land on the existing rows (as in production).
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" < supabase/migrations/20261116160000_saved_addresses.sql
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" < supabase/migrations/20261116180000_kitchen_locations.sql
  docker exec "$container" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$db" -c "do \$\$ declare ns text; n integer; begin
    if not exists (select 1 from public.orders where saved_address_id is null and location_accuracy is not null) then raise exception 'upgrade test has no legacy orders'; end if;
    if exists (select 1 from pg_constraint where conname='order_address_evidence' and not convalidated) then raise exception 'evidence check not validated'; end if;
    select n2.nspname into strict ns from pg_extension e join pg_namespace n2 on n2.oid=e.extnamespace where e.extname='postgis';
    execute format('select count(*) filter (where kitchen_location is not null and %1\$I.st_distance(kitchen_location::%1\$I.geography, %1\$I.st_setsrid(%1\$I.st_makepoint(case slug when ''ammu-sammu'' then 73.3944946 else 73.3988110 end, case slug when ''ammu-sammu'' then 17.7190154 else 17.7197215 end),4326)::%1\$I.geography) < 1) from public.businesses where slug in (''ammu-sammu'',''kokani-dine-inn'')', ns) into n;
    if n <> 2 then raise exception 'kitchen points not set on existing restaurants: %', n; end if;
  end \$\$"
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
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" < tests/database/menu-categories.sql
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" < tests/database/menu-photos.sql
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" < tests/database/owner-history.sql
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" < tests/database/menu-reorder.sql
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" < tests/database/daily-summary.sql
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" < tests/database/order-numbers.sql
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" < tests/database/saved-addresses.sql
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
done
echo 'Database isolation, checkout, notification, open/closed diet, featured, category, owner-history, menu-reorder daily-summary, order-number and saved-address tests passed, including all migrations before seed in both PostGIS schemas.'
