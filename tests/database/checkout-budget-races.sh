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

# Direct insert must acquire the account lock before the order-number counter.
# Hold an account lock as checkout does, then start a direct insert. With the
# old trigger order the direct insert holds the counter while waiting for the
# account; the first transaction then deadlocks trying to allocate its number.
sql_in <<'SQL'
insert into auth.users(id) values ('30000000-0000-4000-8000-000000000096');
insert into public.customer_addresses(id,customer_id,label,house,street_area,latitude,longitude,location_source)
values ('74000000-0000-4000-8000-000000000096','30000000-0000-4000-8000-000000000096','home','Lock house','Lock road',0.5,0.5,'pin');
SQL
race_direct_order() {
  docker exec -i -e PGAPPNAME="$1" "$container" psql -X -q -v ON_ERROR_STOP=1 -v key="$2" -v hold="$3" -U postgres -d "$db" <<'SQL'
begin;
select case when :'hold'::boolean then customer_lifecycle_private.lock_account('30000000-0000-4000-8000-000000000096') end;
select pg_sleep(case when :'hold'::boolean then 8 else 0 end);
insert into public.orders(business_id,customer_id,customer_name,customer_phone,delivery_address_line,latitude,longitude,address_label,address_house,address_street_area,address_location_source,saved_address_id,saved_address_version,subtotal_paise,delivery_fee_paise,total_paise,idempotency_key,request_hash)
values ('10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000096','Lock customer','9876543210','Lock house, Lock road',0.5,0.5,'home','Lock house','Lock road','pin','74000000-0000-4000-8000-000000000096',1,100,0,100,:'key'::uuid,'lock-order-test');
commit;
SQL
}
race_direct_order checkout_lock_first 91000000-0000-4000-8000-000000000001 true > /tmp/checkout-lock-1-$$.log 2>&1 & direct_a=$!
direct_ready=0
for _ in {1..60}; do
  if [[ "$(docker exec "$container" psql -X -qAt -U postgres -d "$db" -c "select count(*) from pg_stat_activity where application_name='checkout_lock_first' and wait_event='PgSleep'")" == 1 ]]; then direct_ready=1; break; fi
  sleep 0.1
done
[[ "$direct_ready" == 1 ]] || { cat /tmp/checkout-lock-1-$$.log; echo 'Account lock was not held' >&2; exit 1; }
race_direct_order checkout_lock_second 91000000-0000-4000-8000-000000000002 false > /tmp/checkout-lock-2-$$.log 2>&1 & direct_b=$!
direct_blocked=0
for _ in {1..60}; do
  if [[ "$(docker exec "$container" psql -X -qAt -U postgres -d "$db" -c "select count(*) from pg_stat_activity a where a.application_name='checkout_lock_second' and exists (select 1 from pg_stat_activity b where b.application_name='checkout_lock_first' and b.pid = any(pg_blocking_pids(a.pid)))")" == 1 ]]; then direct_blocked=1; break; fi
  sleep 0.1
done
[[ "$direct_blocked" == 1 ]] || { cat /tmp/checkout-lock-{1,2}-$$.log; echo 'Direct insert did not wait on the account lock' >&2; exit 1; }
direct_a_status=0; wait "$direct_a" || direct_a_status=$?
direct_b_status=0; wait "$direct_b" || direct_b_status=$?
if [[ "$direct_a_status" != 0 || "$direct_b_status" != 0 ]]; then
  cat /tmp/checkout-lock-{1,2}-$$.log; echo 'Account-before-counter direct insert race failed' >&2; exit 1
fi
rm -f /tmp/checkout-lock-{1,2}-$$.log
sql_cmd "select public.test_assert((select count(*)=2 from public.orders where customer_id='30000000-0000-4000-8000-000000000096'), 'both direct inserts complete without a deadlock')"
echo 'Direct checkout lock-order race passed.'
