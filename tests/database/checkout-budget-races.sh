# Sourced by run.sh against its disposable local database. The account is dedicated
# to this race so preceding tests cannot consume its budget.
sql_in <<'SQL'
insert into auth.users(id) values ('30000000-0000-4000-8000-000000000098');
insert into public.customer_addresses(id,customer_id,label,house,street_area,latitude,longitude,location_source)
values ('74000000-0000-4000-8000-000000000098','30000000-0000-4000-8000-000000000098','home','Race house','Race road',0.5,0.5,'pin');
set role authenticated;
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000098',false);
do $$ declare n integer; items jsonb := '[{"menu_item_id":"20000000-0000-4000-8000-000000000001","quantity":1}]'; begin
  for n in 1..19 loop
    perform public.place_order('ammu-sammu',items,public.test_delivery('Budget race'),null,md5('budget-race-seed-'||n)::uuid,public.test_quote('ammu-sammu',items));
  end loop;
end $$;
SQL
race_budget_order() {
  docker exec -i -e PGAPPNAME="$2" "$container" psql -X -q -v ON_ERROR_STOP=1 -v key="$1" -v delay="$3" -U postgres -d "$db" <<'SQL'
begin;
set role authenticated;
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000098',false);
select public.place_order('ammu-sammu','[{"menu_item_id":"20000000-0000-4000-8000-000000000001","quantity":1}]',public.test_delivery('Budget race'),null,:'key'::uuid,public.test_quote('ammu-sammu','[{"menu_item_id":"20000000-0000-4000-8000-000000000001","quantity":1}]'));
select pg_sleep(:'delay'::integer);
commit;
SQL
}
race_budget_order 90000000-0000-4000-8000-000000000001 checkout_budget_first 8 > /tmp/checkout-budget-race-1-$$.log 2>&1 & budget_a=$!
first_ready=0
for _ in {1..60}; do
  if [[ "$(docker exec "$container" psql -X -qAt -U postgres -d "$db" -c "select count(*) from pg_stat_activity where application_name='checkout_budget_first' and wait_event='PgSleep'")" == 1 ]]; then first_ready=1; break; fi
  sleep 0.1
done
[[ "$first_ready" == 1 ]] || { cat /tmp/checkout-budget-race-1-$$.log; echo 'First order did not hold its transaction open' >&2; exit 1; }
race_budget_order 90000000-0000-4000-8000-000000000002 checkout_budget_second 0 > /tmp/checkout-budget-race-2-$$.log 2>&1 & budget_b=$!
second_blocked=0
for _ in {1..60}; do
  if [[ "$(docker exec "$container" psql -X -qAt -U postgres -d "$db" -c "select count(*) from pg_stat_activity a where a.application_name='checkout_budget_second' and exists (select 1 from pg_stat_activity b where b.application_name='checkout_budget_first' and b.pid = any(pg_blocking_pids(a.pid)))")" == 1 ]]; then second_blocked=1; break; fi
  sleep 0.1
done
[[ "$second_blocked" == 1 ]] || { cat /tmp/checkout-budget-race-{1,2}-$$.log; echo 'Second order did not block on the first' >&2; exit 1; }
budget_a_status=0; wait "$budget_a" || budget_a_status=$?
budget_b_status=0; wait "$budget_b" || budget_b_status=$?
if ! { [[ "$budget_a_status" == 0 && "$budget_b_status" != 0 ]] || [[ "$budget_a_status" != 0 && "$budget_b_status" == 0 ]]; }; then
  cat /tmp/checkout-budget-race-{1,2}-$$.log; echo 'Expected one success and one budget refusal' >&2; exit 1
fi
if [[ "$budget_a_status" != 0 ]]; then budget_failed=/tmp/checkout-budget-race-1-$$.log; else budget_failed=/tmp/checkout-budget-race-2-$$.log; fi
grep -q 'order submission limit reached' "$budget_failed" || { cat "$budget_failed"; echo 'Wrong failure in budget race' >&2; exit 1; }
rm -f /tmp/checkout-budget-race-{1,2}-$$.log
sql_cmd "select public.test_assert((select count(*)=20 from public.orders where customer_id='30000000-0000-4000-8000-000000000098' and business_id='10000000-0000-4000-8000-000000000001'),'concurrent fresh keys cannot exceed budget')"
echo 'Concurrent checkout budget race passed.'
