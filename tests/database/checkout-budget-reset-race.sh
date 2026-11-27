# Sourced by run.sh for each disposable PostGIS layout.
budget_reset_sql() {
  docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$db" \
    -v customer=30000000-0000-4000-8000-000000000095 "$@"
}
budget_reset_sql >/dev/null <<'SQL'
insert into auth.users(id) values (:'customer');
insert into public.customer_addresses(id,customer_id,label,house,street_area,latitude,longitude,location_source)
values ('74000000-0000-4000-8000-000000000095',:'customer','home','Reset house','Reset road',0.5,0.5,'pin');
SQL

budget_reset_tmp=$(mktemp -d /tmp/checkout-budget-reset.XXXXXX)
budget_reset_wait() {
  local predicate="$1"
  for _ in {1..100}; do
    if [[ $(budget_reset_sql -tA -c "select count(*) from pg_stat_activity where datname=current_database() and ($predicate)") == 1 ]]; then
      return 0
    fi
    sleep 0.05
  done
  echo "Checkout budget reset race never observed: $predicate" >&2
  cat "$budget_reset_tmp"/*.log >&2
  exit 1
}

# Keep checkout's transaction open until PostgreSQL shows the support reset waiting on it.
mkfifo "$budget_reset_tmp/checkout.in"
budget_reset_sql <"$budget_reset_tmp/checkout.in" >"$budget_reset_tmp/checkout.log" 2>&1 &
budget_reset_checkout=$!
exec {budget_reset_input}>"$budget_reset_tmp/checkout.in"
cat >&"$budget_reset_input" <<'SQL'
begin;
set local application_name='checkout-budget-reset-checkout';
set local idle_in_transaction_session_timeout='30s';
set local role authenticated;
select set_config('request.jwt.claim.sub', :'customer', true);
select public.place_order('ammu-sammu',items,public.test_delivery('Reset race'),null,
  '92000000-0000-4000-8000-000000000001',public.test_quote('ammu-sammu',items))
from (values ('[{"menu_item_id":"20000000-0000-4000-8000-000000000001","quantity":1}]'::jsonb)) v(items);
SQL
budget_reset_wait "application_name='checkout-budget-reset-checkout' and state='idle in transaction' and query like 'select public.place_order(%'"

budget_reset_sql {budget_reset_input}>&- >"$budget_reset_tmp/reset.log" 2>&1 <<'SQL' &
set application_name='checkout-budget-reset-support';
set statement_timeout='20s';
set role service_role;
select public.test_assert(public.manage_order_budget('ammu-sammu', :'customer', true)->>'used' = '0',
  'reset succeeds with zero slots used once the earlier checkout commits');
SQL
budget_reset_support=$!
budget_reset_wait "application_name='checkout-budget-reset-support' and exists (
  select 1 from pg_stat_activity holder where holder.application_name='checkout-budget-reset-checkout'
    and holder.pid=any(pg_blocking_pids(pg_stat_activity.pid)))"
printf 'commit;\n' >&"$budget_reset_input"
exec {budget_reset_input}>&-
wait "$budget_reset_checkout" || { cat "$budget_reset_tmp/checkout.log" >&2; exit 1; }
wait "$budget_reset_support" || { cat "$budget_reset_tmp/reset.log" >&2; exit 1; }

budget_reset_sql >/dev/null <<'SQL'
select public.test_assert((select o.created_at < r.reset_at
  from public.orders o join offers_private.order_budget_resets r using (customer_id, business_id)
  where o.customer_id=:'customer' and o.idempotency_key='92000000-0000-4000-8000-000000000001'),
  'the earlier order was preserved and its timestamp precedes the reset');
set role authenticated;
select set_config('request.jwt.claim.sub', :'customer', false);
select public.test_assert(public.place_order('ammu-sammu',items,public.test_delivery('Reset race'),null,
  '92000000-0000-4000-8000-000000000002',public.test_quote('ammu-sammu',items))->>'outcome' = 'placed',
  'a new checkout succeeds after the reset')
from (values ('[{"menu_item_id":"20000000-0000-4000-8000-000000000001","quantity":1}]'::jsonb)) v(items);
set role service_role;
select public.test_assert(public.manage_order_budget('ammu-sammu', :'customer')->>'used' = '1',
  'only the new checkout uses the reset budget');
SQL
rm -rf "$budget_reset_tmp"
echo 'Checkout budget reset race passed.'
