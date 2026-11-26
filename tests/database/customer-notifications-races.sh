# Sourced by run.sh in each final-schema PostGIS layout. No remote connections.
feed_sql() { docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$db" "$@"; }
feed_sql >/dev/null <<'SQL'
insert into auth.users(id) values ('55100000-0000-4000-8000-000000000001'),('55100000-0000-4000-8000-000000000002');
insert into public.business_memberships(business_id,user_id,role) values ('10000000-0000-4000-8000-000000000001','55100000-0000-4000-8000-000000000002','admin');
insert into public.customer_addresses(id,customer_id,label,house,street_area,latitude,longitude,location_source) values
 ('75100000-0000-4000-8000-000000000001','55100000-0000-4000-8000-000000000001','home','Feed race','Test Road',0.5,0.5,'pin');
update public.businesses set is_demo=false,ordering_enabled=true,accepting_orders=true,delivery_fee_paise=0,min_order_paise=0 where slug='ammu-sammu';
update public.menu_items set is_demo=false,available=true,price_paise=15000 where id='20000000-0000-4000-8000-000000000001';
create function public.test_feed_race_place() returns uuid language sql as $$
 select (public.place_order('ammu-sammu','[{"menu_item_id":"20000000-0000-4000-8000-000000000001","quantity":1}]',
 '{"name":"Race customer","phone":"9876543210","address_id":"75100000-0000-4000-8000-000000000001","address_version":1}',null,'65100000-0000-4000-8000-000000000001',
 public.test_quote('ammu-sammu','[{"menu_item_id":"20000000-0000-4000-8000-000000000001","quantity":1}]'))->>'id')::uuid $$;
SQL
feed_tmp=$(mktemp -d /tmp/customer-feed-races.XXXXXX)
# Observe actual PostgreSQL sleep/lock wait states, rather than assume process timing.
feed_wait_for() {
 local predicate="$1" seen=false
 for _ in {1..60}; do
  if [[ $(feed_sql -tA -c "select count(*) from pg_stat_activity where datname=current_database() and ($predicate)") == 1 ]]; then seen=true; break; fi
  sleep 0.05
 done
 if [[ "$seen" != true ]]; then echo "Feed race never reached expected state: $predicate" >&2; exit 1; fi
}
feed_sql >"$feed_tmp/place-first.log" 2>&1 <<'SQL' &
begin;
set application_name='feed-placement-first';
set local role authenticated;
select set_config('request.jwt.claim.sub','55100000-0000-4000-8000-000000000001',true);
select public.test_feed_race_place();
select pg_sleep(3);
commit;
SQL
feed_first_pid=$!
feed_wait_for "application_name='feed-placement-first' and wait_event='PgSleep'"
feed_sql >"$feed_tmp/place-replay.log" 2>&1 <<'SQL' &
set application_name='feed-placement-replay';
set role authenticated;
select set_config('request.jwt.claim.sub','55100000-0000-4000-8000-000000000001',false);
select public.test_feed_race_place() as replay_id \gset
select public.test_assert(:'replay_id'::uuid=(select id from public.orders where idempotency_key='65100000-0000-4000-8000-000000000001'),'concurrent replay returns the first order');
SQL
feed_second_pid=$!
feed_wait_for "application_name='feed-placement-replay' and cardinality(pg_blocking_pids(pid))>0"
if ! wait "$feed_first_pid"; then cat "$feed_tmp/place-first.log" >&2; exit 1; fi
if ! wait "$feed_second_pid"; then cat "$feed_tmp/place-replay.log" >&2; exit 1; fi
feed_sql >/dev/null <<'SQL'
select public.test_assert((select count(*)=1 from public.orders where idempotency_key='65100000-0000-4000-8000-000000000001'),'exactly one persisted order after simultaneous placement');
select public.test_assert((select count(*)=1 from public.customer_notifications where user_id='55100000-0000-4000-8000-000000000001' and event_status='placed'),'exactly one placed event after simultaneous placement');
SQL
# Both owners use version 1; one transition commits and the waiting session must lose.
feed_sql >"$feed_tmp/transition-first.log" 2>&1 <<'SQL' &
begin;
set application_name='feed-transition-first';
set local role authenticated;
select set_config('request.jwt.claim.sub','55100000-0000-4000-8000-000000000002',true);
select public.transition_order((select id from public.orders where idempotency_key='65100000-0000-4000-8000-000000000001'),'accepted',1);
select pg_sleep(3);
commit;
SQL
feed_first_pid=$!
feed_wait_for "application_name='feed-transition-first' and wait_event='PgSleep'"
feed_sql >"$feed_tmp/transition-stale.log" 2>&1 <<'SQL' &
set application_name='feed-transition-stale';
set role authenticated;
select set_config('request.jwt.claim.sub','55100000-0000-4000-8000-000000000002',false);
do $$ begin
 perform public.transition_order((select id from public.orders where idempotency_key='65100000-0000-4000-8000-000000000001'),'accepted',1);
 raise exception 'concurrent stale transition unexpectedly succeeded';
exception when serialization_failure then null; end $$;
SQL
feed_second_pid=$!
feed_wait_for "application_name='feed-transition-stale' and cardinality(pg_blocking_pids(pid))>0"
if ! wait "$feed_first_pid"; then cat "$feed_tmp/transition-first.log" >&2; exit 1; fi
if ! wait "$feed_second_pid"; then cat "$feed_tmp/transition-stale.log" >&2; exit 1; fi
feed_sql >/dev/null <<'SQL'
select public.test_assert((select status='accepted' and version=2 from public.orders where idempotency_key='65100000-0000-4000-8000-000000000001'),'only one transition committed');
select public.test_assert((select count(*)=2 and count(distinct event_status)=2 from public.customer_notifications where user_id='55100000-0000-4000-8000-000000000001'),'one placed and one accepted entry after real contention');
SQL
rm -rf "$feed_tmp"
echo 'Customer feed placement replay and stale transition races passed.'
