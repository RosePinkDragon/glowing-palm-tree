# Sourced by run.sh for both PostGIS layouts. Real sessions, bounded locks and persisted assertions.
relationship_tmp=$(mktemp -d)
relationship_sql() { docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$db" "$@"; }
relationship_hold() {
  local name=$1
  local ready=false
  for _ in {1..100}; do
    if [[ $(docker exec "$container" psql -X -qtA -U postgres -d "$db" -c "select count(*) from pg_stat_activity where application_name='$name' and wait_event='PgSleep'") == 1 ]]; then ready=true; break; fi
    sleep 0.05
  done
  [[ $ready == true ]] || { echo "Lifecycle race never reached barrier: $name" >&2; return 1; }
}
relationship_sql >/dev/null <<'SQL'
insert into auth.users(id) values ('35200000-0000-4000-8000-000000000009');
insert into auth.sessions(id,user_id) values ('35200000-0000-4000-8000-000000000009','35200000-0000-4000-8000-000000000009');
insert into public.customer_addresses(customer_id,label,house,street_area,latitude,longitude,location_source) values ('35200000-0000-4000-8000-000000000009','home','Lifecycle house','Lifecycle road',0.5,0.5,'pin');
update public.businesses set accepting_orders=true where slug='ammu-sammu';
SQL
relationship_auth="set role authenticated; select set_config('request.jwt.claim.sub','35200000-0000-4000-8000-000000000009',false); select set_config('request.jwt.claims','{\"session_id\":\"35200000-0000-4000-8000-000000000009\"}',false);"
relationship_place() {
  echo "$relationship_auth"
  echo "select public.place_order('ammu-sammu','$race_items',public.test_delivery('Lifecycle race'),null,'$1',public.test_quote('ammu-sammu','$race_items'));"
}
# A refused first checkout rolls back the implicit relationship as well as the order.
relationship_sql >/dev/null <<'SQL'
update public.businesses set accepting_orders=false where slug='ammu-sammu';
SQL
if relationship_place 65200000-0000-4000-8000-000000000099 | relationship_sql >"$relationship_tmp/refused_first" 2>&1; then echo 'Closed first checkout succeeded' >&2; exit 1; fi
grep -q 'restaurant is not accepting orders' "$relationship_tmp/refused_first"
relationship_sql >/dev/null <<'SQL'
select public.test_assert(not exists(select 1 from public.customer_businesses where customer_id='35200000-0000-4000-8000-000000000009'),'failed first checkout rolls back enrollment');
update public.businesses set accepting_orders=true where slug='ammu-sammu';
SQL
# A normal-return pricing rejection and its replay must not enroll a never-linked caller.
{
 echo "$relationship_auth";
 echo "select public.test_assert(public.place_order('ammu-sammu','$race_items',public.test_delivery('Lifecycle race'),null,'65200000-0000-4000-8000-000000000098','{}')->>'outcome'='pricing_changed','stale first quote refused');";
} | relationship_sql >/dev/null
relationship_sql >/dev/null <<'SQL'
select public.test_assert(not exists(select 1 from public.customer_businesses where customer_id='35200000-0000-4000-8000-000000000009') and not exists(select 1 from public.orders where customer_id='35200000-0000-4000-8000-000000000009'),'pricing_changed leaves no relationship or order');
SQL
{
 echo "$relationship_auth";
 echo "select public.test_assert(public.place_order('ammu-sammu','$race_items',public.test_delivery('Lifecycle race'),null,'65200000-0000-4000-8000-000000000098','{}')->>'outcome'='pricing_changed','rejection replay remains refused');";
} | relationship_sql >/dev/null
relationship_sql >/dev/null <<'SQL'
select public.test_assert(not exists(select 1 from public.customer_businesses where customer_id='35200000-0000-4000-8000-000000000009'),'pricing rejection replay never enrolls');
SQL
# Corrected pricing uses a fresh key; the rejected key remains terminal by existing contract.
# Never-linked checkout succeeds without any client join call, and replay preserves its generation.
relationship_place 65200000-0000-4000-8000-000000000001 | relationship_sql >/dev/null
relationship_sql >/dev/null <<'SQL'
select public.test_assert((select count(*)=1 from public.customer_businesses where customer_id='35200000-0000-4000-8000-000000000009'),'first order enrolls exactly once');
create table public.test_first_relationship as select * from public.customer_businesses where customer_id='35200000-0000-4000-8000-000000000009';
SQL
relationship_place 65200000-0000-4000-8000-000000000001 | relationship_sql >/dev/null
relationship_sql >/dev/null <<'SQL'
select public.test_assert(not exists((select * from public.customer_businesses where customer_id='35200000-0000-4000-8000-000000000009') except select * from public.test_first_relationship),'first order replay preserves generation/timestamp');
drop table public.test_first_relationship;
-- Separate never-linked customer for concurrent distinct first orders.
insert into auth.users(id) values ('35200000-0000-4000-8000-000000000008');
insert into public.customer_addresses(customer_id,label,house,street_area,latitude,longitude,location_source) values ('35200000-0000-4000-8000-000000000008','home','Concurrent house','Road',0.5,0.5,'pin');
SQL
relationship_original_auth=$relationship_auth
relationship_auth="set role authenticated; select set_config('request.jwt.claim.sub','35200000-0000-4000-8000-000000000008',false);"
{ echo "begin; set application_name='relationship_first';"; relationship_place 65200000-0000-4000-8000-000000000081; echo 'select pg_sleep(4); commit;'; } | relationship_sql >/dev/null & relationship_pid=$!
relationship_hold relationship_first
relationship_place 65200000-0000-4000-8000-000000000082 | relationship_sql >/dev/null
wait "$relationship_pid"
relationship_auth=$relationship_original_auth
relationship_sql >/dev/null <<'SQL'
select public.test_assert((select count(*)=2 from public.orders where customer_id='35200000-0000-4000-8000-000000000008'),'both concurrent first orders succeed');
select public.test_assert((select count(*)=1 and bool_and(state='active') from public.customer_businesses where customer_id='35200000-0000-4000-8000-000000000008'),'concurrent first orders converge on one active relationship');
SQL
# Join first: checkout waits on the stable account row, then sees committed membership.
{ echo "begin; set application_name='relationship_join'; $relationship_auth"; echo "select public.join_business('ammu-sammu'); select pg_sleep(4); commit;"; } | relationship_sql >/dev/null & relationship_pid=$!
relationship_hold relationship_join
{ echo "$relationship_auth set lock_timeout='300ms';"; echo "do \$\$ begin perform public.place_order('ammu-sammu','$race_items',public.test_delivery(),null,'65200000-0000-4000-8000-000000000002',public.test_quote('ammu-sammu','$race_items')); raise exception 'checkout bypassed join lock'; exception when lock_not_available then null; end \$\$;"; } | relationship_sql >/dev/null
relationship_place 65200000-0000-4000-8000-000000000002 | relationship_sql >/dev/null
wait "$relationship_pid"
# Placement first: lifecycle writer waits and observes its committed non-final order.
{ echo "begin; set application_name='relationship_checkout';"; relationship_place 65200000-0000-4000-8000-000000000003; echo 'select pg_sleep(4); commit;'; } | relationship_sql >/dev/null & relationship_pid=$!
relationship_hold relationship_checkout
relationship_sql >/dev/null <<'SQL'
set lock_timeout='300ms';
do $$ begin
 perform customer_lifecycle_private.lock_account('35200000-0000-4000-8000-000000000009');
 raise exception 'lifecycle writer bypassed checkout lock';
exception when lock_not_available then null; end $$;
SQL
relationship_sql >/dev/null <<'SQL'
begin;
set statement_timeout='10s';
select customer_lifecycle_private.lock_account('35200000-0000-4000-8000-000000000009');
select public.test_assert((select count(*)=3 from public.orders where customer_id='35200000-0000-4000-8000-000000000009' and status='placed'),'writer sees committed active orders');
commit;
SQL
wait "$relationship_pid"
# Full-row snapshot evidence with real orders; symmetric comparison catches loss as well as edits.
relationship_sql >/dev/null <<'SQL'
create view public.test_relationship_snapshot as
 select 'order' kind,to_jsonb(o) row from public.orders o
 union all select 'item',to_jsonb(i) from public.order_items i
 union all select 'history',to_jsonb(h) from public.order_status_history h
 union all select 'actor',to_jsonb(a) from public.order_status_actors a
 union all select 'address',to_jsonb(a) from public.customer_addresses a;
create table public.test_relationship_before as select * from public.test_relationship_snapshot;
SQL
# Trusted future-lifecycle fixture first: checkout must wait, then reject the committed pending state.
relationship_sql >/dev/null <<'SQL' &
begin;
set application_name='relationship_pending';
select customer_lifecycle_private.lock_account('35200000-0000-4000-8000-000000000009');
update public.customer_businesses set state='leave_pending' where customer_id='35200000-0000-4000-8000-000000000009' and business_id='10000000-0000-4000-8000-000000000001';
select pg_sleep(4);
commit;
SQL
relationship_pid=$!
relationship_hold relationship_pending
if relationship_place 65200000-0000-4000-8000-000000000004 | relationship_sql >"$relationship_tmp/pending" 2>&1; then echo 'Pending placement succeeded' >&2; exit 1; fi
grep -q BUSINESS_LIFECYCLE_PENDING "$relationship_tmp/pending"
wait "$relationship_pid"
# Replays are gated too; they cannot rejoin or rewrite snapshots after leave starts.
if relationship_place 65200000-0000-4000-8000-000000000003 | relationship_sql >"$relationship_tmp/replay" 2>&1; then echo 'Pending replay succeeded' >&2; exit 1; fi
grep -q BUSINESS_LIFECYCLE_PENDING "$relationship_tmp/replay"
relationship_sql >/dev/null <<'SQL'
select public.test_assert((select count(*)=3 from public.orders where customer_id='35200000-0000-4000-8000-000000000009'),'only three committed placements');
select public.test_assert(not exists((select * from public.test_relationship_snapshot except all select * from public.test_relationship_before)
 union all (select * from public.test_relationship_before except all select * from public.test_relationship_snapshot)),
 'all retained order/item/history/actor/address snapshots exactly unchanged');
drop view public.test_relationship_snapshot;
drop table public.test_relationship_before;
SQL
# A completed leave is a retained left marker, not an absent row. New orders and replays refuse it.
relationship_sql >/dev/null <<'SQL'
update public.customer_businesses set state='left' where customer_id='35200000-0000-4000-8000-000000000009';
create table public.test_left_relationship as select * from public.customer_businesses where customer_id='35200000-0000-4000-8000-000000000009';
SQL
for key in 65200000-0000-4000-8000-000000000005 65200000-0000-4000-8000-000000000001; do
 if relationship_place "$key" | relationship_sql >"$relationship_tmp/left" 2>&1; then echo 'Left customer checkout succeeded' >&2; exit 1; fi
 grep -q BUSINESS_JOIN_REQUIRED "$relationship_tmp/left"
done
relationship_sql >/dev/null <<'SQL'
select public.test_assert((select count(*)=3 from public.orders where customer_id='35200000-0000-4000-8000-000000000009'),'left checkout creates no orders');
select public.test_assert(not exists((select * from public.customer_businesses where customer_id='35200000-0000-4000-8000-000000000009') except select * from public.test_left_relationship),'left refusal preserves generation/state');
drop table public.test_left_relationship;
SQL
# Auth deletion races: existing account row reproduces the original cascade inversion.
relationship_sql >/dev/null <<'SQL'
insert into auth.users(id) values ('35200000-0000-4000-8000-000000000007');
insert into customer_lifecycle_private.accounts(customer_id) values ('35200000-0000-4000-8000-000000000007');
SQL
relationship_sql >/dev/null <<'SQL' &
begin;
set application_name='relationship_user_lock';
set statement_timeout='10s';
select customer_lifecycle_private.lock_account('35200000-0000-4000-8000-000000000007');
select pg_sleep(4);
insert into public.customer_businesses(customer_id,business_id) values ('35200000-0000-4000-8000-000000000007','10000000-0000-4000-8000-000000000001');
commit;
SQL
relationship_pid=$!
relationship_hold relationship_user_lock
relationship_sql >/dev/null <<'SQL'
set statement_timeout='10s';
delete from auth.users where id='35200000-0000-4000-8000-000000000007';
select public.test_assert(not exists(select 1 from customer_lifecycle_private.accounts where customer_id='35200000-0000-4000-8000-000000000007') and not exists(select 1 from public.customer_businesses where customer_id='35200000-0000-4000-8000-000000000007'),'delete waits then cascades without deadlock');
SQL
wait "$relationship_pid"
# Delete first: lock_account waits for users, then rejects the deleted identity cleanly.
relationship_sql >/dev/null <<'SQL'
insert into auth.users(id) values ('35200000-0000-4000-8000-000000000007');
insert into customer_lifecycle_private.accounts(customer_id) values ('35200000-0000-4000-8000-000000000007');
SQL
relationship_sql >/dev/null <<'SQL' &
begin;
set application_name='relationship_user_delete';
delete from auth.users where id='35200000-0000-4000-8000-000000000007';
select pg_sleep(4);
commit;
SQL
relationship_pid=$!
relationship_hold relationship_user_delete
relationship_sql >/dev/null <<'SQL'
set statement_timeout='10s';
do $$ begin
 begin perform customer_lifecycle_private.lock_account('35200000-0000-4000-8000-000000000007'); raise exception 'deleted user locked';
 exception when insufficient_privilege then null; end;
end $$;
SQL
wait "$relationship_pid"
# Exercise the exact baseline backfill SQL against existing historical data, never a rewritten copy.
# Roll back: production runs this only during baseline bootstrap, never after leave.
{
 echo 'begin;';
 echo "delete from public.customer_businesses where customer_id='35200000-0000-4000-8000-000000000009';";
 sed -n '/^-- BEGIN CUSTOMER RELATIONSHIP BACKFILL$/,/^-- END CUSTOMER RELATIONSHIP BACKFILL$/p' supabase/migrations/20261117000000_baseline.sql
 echo "select public.test_assert((select joined_at=(select min(created_at) from public.orders where customer_id=r.customer_id and business_id=r.business_id) from public.customer_businesses r where customer_id='35200000-0000-4000-8000-000000000009'),'backfill earliest order');";
 echo 'create temp table backfill_before as select * from public.customer_businesses;';
 sed -n '/^-- BEGIN CUSTOMER RELATIONSHIP BACKFILL$/,/^-- END CUSTOMER RELATIONSHIP BACKFILL$/p' supabase/migrations/20261117000000_baseline.sql
 echo "select public.test_assert(not exists((select * from public.customer_businesses) except (select * from backfill_before)),'backfill preserves existing generation'); rollback;";
} | relationship_sql >/dev/null
rm -rf "$relationship_tmp"
echo "Customer relationship join/checkout/lifecycle races and backfill passed."
