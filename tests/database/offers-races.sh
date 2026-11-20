# Sourced by run.sh for both PostGIS layouts (#182 slice A). Real sessions, committed fixtures, persisted assertions.
# Offers cannot be over-used by concurrent orders: total limits, per-customer limits and first-order-only.
offer_tmp=$(mktemp -d /tmp/offer-races.XXXXXX)
offer_sql() { docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$db" "$@"; }
offer_wait_for() {
  local predicate="$1" seen=false
  for _ in {1..100}; do
    if [[ $(offer_sql -tA -c "select count(*) from pg_stat_activity where datname=current_database() and ($predicate)") == 1 ]]; then seen=true; break; fi
    sleep 0.05
  done
  [[ "$seen" == true ]] || { echo "Offer race never reached expected state: $predicate" >&2; exit 1; }
}
offer_user() { printf '18201000-0000-4000-8000-%012d' "$1"; }
offer_sql >/dev/null <<'SQL'
insert into auth.users(id) select ('18201000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,12) n;
insert into public.customer_addresses(customer_id,label,house,street_area,latitude,longitude,location_source)
  select ('18201000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'home','Offer race house','Offer race road',0.5,0.5,'pin' from generate_series(1,12) n;
update public.businesses set accepting_orders=true,ordering_enabled=true,delivery_fee_paise=0,min_order_paise=0 where slug='ammu-sammu';
update public.menu_items set available=true,is_demo=false,price_paise=15000 where id='20000000-0000-4000-8000-000000000001';
SQL
# The server's quote for a customer (offer included), taken before the race so every contender holds a valid accepted quote.
offer_quote() {
  offer_sql -tA -v user="$(offer_user "$1")" -v code="$2" -v items="$race_items" <<'SQL' | tail -1
set role authenticated;
select set_config('request.jwt.claim.sub',:'user',false);
select (public.quote_order('ammu-sammu',:'items',nullif(:'code','')) -> 'pricing')::text;
SQL
}
# Place with a given accepted quote; prints the JSON result into file $6. Optional $7 holds the transaction open for N seconds.
offer_place() { # user key code accepted outfile [hold_name hold_seconds]
  local hold=''; [[ -n "${6:-}" ]] && hold="set application_name='$6';"
  local tail=''; [[ -n "${7:-}" ]] && tail="select pg_sleep($7);"
  { echo "begin; $hold set local role authenticated; select set_config('request.jwt.claim.sub',:'user',true);"
    echo "select public.place_order('ammu-sammu',:'items',public.test_delivery('Offer race'),null,:'key'::uuid,:'accepted'::jsonb,nullif(:'code',''));"
    echo "$tail commit;"; } |
  offer_sql -tA -v user="$(offer_user "$1")" -v key="$2" -v code="$3" -v accepted="$4" -v items="$race_items" > "$5.raw"
  grep '^{' "$5.raw" > "$5"
}
offer_count() { grep -c "\"outcome\": \"$2\"" "$1" || true; }
offer_reset() { # pause every offer so only the next race's offer competes
  offer_sql >/dev/null <<'SQL'
update public.offers set paused=true;
SQL
}

# 1. Last use, observed lock wait: the second order waits for the offer lock and then learns the offer was used up.
offer_reset
offer_sql >/dev/null <<'SQL'
insert into public.offers(id,business_id,name,kind,value,apply_mode,total_limit)
  values ('18201000-0000-4000-b000-000000000001','10000000-0000-4000-8000-000000000001','Last use','flat',1000,'automatic',1);
SQL
quote_a=$(offer_quote 1 ''); quote_b=$(offer_quote 2 '')
[[ "$quote_a" == *'"discount_paise"'* && "$quote_b" == *'"discount_paise"'* ]] || { echo 'Both customers should be quoted the last use' >&2; exit 1; }
offer_place 1 18201000-0000-4000-9000-000000000001 '' "$quote_a" "$offer_tmp/last_first" offer_first 3 & offer_first_pid=$!
offer_wait_for "application_name='offer_first' and wait_event='PgSleep'"
offer_place 2 18201000-0000-4000-9000-000000000002 '' "$quote_b" "$offer_tmp/last_second" offer_second & offer_second_pid=$!
offer_wait_for "application_name='offer_second' and cardinality(pg_blocking_pids(pid))>0"
wait "$offer_first_pid" || { cat "$offer_tmp/last_first.raw" >&2; exit 1; }
wait "$offer_second_pid" || { cat "$offer_tmp/last_second.raw" >&2; exit 1; }
[[ "$(offer_count "$offer_tmp/last_first" placed)" == 1 ]] || { echo 'First order did not place' >&2; exit 1; }
grep -q '"outcome": "offer_changed"' "$offer_tmp/last_second" && grep -q '"reason": "used_up"' "$offer_tmp/last_second" || { cat "$offer_tmp/last_second" >&2; echo 'Waiting order was not told the offer was used up' >&2; exit 1; }
offer_sql >/dev/null <<'SQL'
select public.test_assert((select count(*)=1 from public.offer_redemptions where offer_id='18201000-0000-4000-b000-000000000001'),'last use: exactly one redemption');
select public.test_assert((select discount_paise=1000 and total_paise=14000 from public.orders where idempotency_key='18201000-0000-4000-9000-000000000001'),'last use: the first order got the discount');
select public.test_assert(not exists(select 1 from public.orders where idempotency_key='18201000-0000-4000-9000-000000000002'),'last use: the second order was not created');
SQL

# 2. Six customers contend for two uses at once, for an automatic offer and again for a code. Exactly two win each time.
for mode in automatic code; do
  offer_reset
  if [[ $mode == automatic ]]; then code=''; apply=automatic; else code=RACECODE; apply=code; fi
  offer_sql >/dev/null <<SQL
insert into public.offers(business_id,name,kind,value,apply_mode,code,total_limit)
  values ('10000000-0000-4000-8000-000000000001','Two uses $mode','flat',1000,'$apply',$( [[ -n "$code" ]] && echo "'$code'" || echo null ),2);
SQL
  base=$([[ $mode == automatic ]] && echo 10 || echo 20)
  offer_quotes=(); for u in 3 4 5 6 7 8; do offer_quotes+=("$(offer_quote "$u" "$code")"); done
  pids=(); i=0
  for u in 3 4 5 6 7 8; do
    offer_place "$u" "18201000-0000-4000-9000-0000000001$((base+i))" "$code" "${offer_quotes[$i]}" "$offer_tmp/two_$mode.$i" & pids+=("$!"); i=$((i+1))
  done
  for pid in "${pids[@]}"; do wait "$pid" || { echo "Contended $mode order failed" >&2; exit 1; }; done
  [[ "$(cat "$offer_tmp"/two_$mode.[0-5] | grep -c '"outcome": "placed"')" == 2 && "$(cat "$offer_tmp"/two_$mode.[0-5] | grep -c '"reason": "used_up"')" == 4 ]] || { cat "$offer_tmp"/two_$mode.[0-5] >&2; echo "Two uses of a $mode offer were not granted to exactly two of six orders" >&2; exit 1; }
  offer_sql >/dev/null <<SQL
select public.test_assert((select count(*)=2 from public.offer_redemptions r join public.offers o on o.id=r.offer_id where o.name='Two uses $mode'),'$mode: exactly two redemptions');
select public.test_assert((select count(*)=2 and bool_and(discount_paise=1000) from public.orders where idempotency_key::text like '18201000-0000-4000-9000-0000000001%' and offer_name='Two uses $mode'),'$mode: exactly two discounted orders');
select public.test_assert((select count(*)=2 from public.orders where idempotency_key::text like '18201000-0000-4000-9000-0000000001%' and idempotency_key::text >= '18201000-0000-4000-9000-0000000001$base' and idempotency_key::text < '18201000-0000-4000-9000-0000000001$((base+6))'),'$mode: the four refused orders were not created');
SQL
done

# 3. One customer, two simultaneous orders: a per-customer limit of 1 and first-order-only each give the use once.
offer_reset
offer_sql >/dev/null <<'SQL'
insert into public.offers(business_id,name,kind,value,apply_mode,per_customer_limit)
  values ('10000000-0000-4000-8000-000000000001','One each','flat',1000,'automatic',1);
SQL
quote_c=$(offer_quote 9 '')
offer_place 9 18201000-0000-4000-9000-000000000031 '' "$quote_c" "$offer_tmp/per_1" & p1=$!
offer_place 9 18201000-0000-4000-9000-000000000032 '' "$quote_c" "$offer_tmp/per_2" & p2=$!
wait "$p1" && wait "$p2" || { echo 'Per-customer race failed' >&2; exit 1; }
[[ "$(cat "$offer_tmp"/per_[12] | grep -c '"outcome": "placed"')" == 1 && "$(cat "$offer_tmp"/per_[12] | grep -c '"reason": "per_customer_limit"')" == 1 ]] || { cat "$offer_tmp"/per_[12] >&2; echo 'Per-customer limit was not enforced exactly once' >&2; exit 1; }
offer_sql >/dev/null <<'SQL'
select public.test_assert((select count(*)=1 from public.offer_redemptions r join public.orders o on o.id=r.order_id where o.customer_id='18201000-0000-4000-8000-000000000009' and o.offer_name='One each'),'per-customer: one redemption for the customer');
SQL
offer_reset
offer_sql >/dev/null <<'SQL'
insert into public.offers(business_id,name,kind,value,apply_mode,first_order_only)
  values ('10000000-0000-4000-8000-000000000001','Welcome','flat',1000,'automatic',true);
SQL
quote_d=$(offer_quote 10 '')
offer_place 10 18201000-0000-4000-9000-000000000041 '' "$quote_d" "$offer_tmp/first_1" & p1=$!
offer_place 10 18201000-0000-4000-9000-000000000042 '' "$quote_d" "$offer_tmp/first_2" & p2=$!
wait "$p1" && wait "$p2" || { echo 'First-order race failed' >&2; exit 1; }
[[ "$(cat "$offer_tmp"/first_[12] | grep -c '"outcome": "placed"')" == 1 && "$(cat "$offer_tmp"/first_[12] | grep -c '"reason": "first_order_only"')" == 1 ]] || { cat "$offer_tmp"/first_[12] >&2; echo 'First-order-only was not enforced exactly once' >&2; exit 1; }

# 4. The same request twice at once (same key, same code): one order, one redemption, identical answers.
offer_reset
offer_sql >/dev/null <<'SQL'
insert into public.offers(business_id,name,kind,value,apply_mode,code,total_limit)
  values ('10000000-0000-4000-8000-000000000001','Replay race','flat',1000,'code','SAMEKEY1',1);
SQL
quote_e=$(offer_quote 11 SAMEKEY1)
offer_place 11 18201000-0000-4000-9000-000000000051 SAMEKEY1 "$quote_e" "$offer_tmp/same_1" & p1=$!
offer_place 11 18201000-0000-4000-9000-000000000051 samekey1 "$quote_e" "$offer_tmp/same_2" & p2=$!
wait "$p1" && wait "$p2" || { echo 'Concurrent identical requests failed' >&2; exit 1; }
cmp -s "$offer_tmp/same_1" "$offer_tmp/same_2" && [[ "$(offer_count "$offer_tmp/same_1" placed)" == 1 ]] || { cat "$offer_tmp"/same_[12] >&2; echo 'Concurrent identical requests did not return the same order' >&2; exit 1; }
offer_sql >/dev/null <<'SQL'
select public.test_assert((select count(*)=1 from public.orders where idempotency_key='18201000-0000-4000-9000-000000000051') and (select count(*)=1 from public.offer_redemptions r join public.offers o on o.id=r.offer_id where o.name='Replay race'),'concurrent identical requests: one order and one redemption');
SQL

# Leave the committed fixtures inert for later suites.
offer_reset
rm -rf "$offer_tmp"
