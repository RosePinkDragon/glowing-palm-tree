# Sourced by run.sh once per final PostGIS layout. Local disposable database only. (#51)
# Real concurrent sessions: (1) two co-owners delete at once and exactly one is refused as the last owner, (2) a customer's
# deletion waits for an owner's in-flight order transition and then refuses, because the order is no longer final.
ad_sql() { docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$db" "$@"; }
ad_tmp=$(mktemp -d /tmp/account-deletion-races.XXXXXX)
ad_wait() {
  local predicate="$1" seen=false
  for _ in {1..100}; do
    if [[ $(ad_sql -tA -c "select count(*) from pg_stat_activity where datname=current_database() and ($predicate)") == 1 ]]; then seen=true; break; fi
    sleep 0.05
  done
  if [[ "$seen" != true ]]; then echo "Account deletion race never observed: $predicate" >&2; cat "$ad_tmp"/*.log >&2; exit 1; fi
}
# Fixtures: owners 1 and 2 are the only owners of Kokani Dine Inn (the other fixture owners are parked and restored below);
# customer 3 has a placed order at Ammu Sammu; 4 is Ammu Sammu's owner for this race.
ad_sql >/dev/null <<'SQL'
create table public.ad_race_parked as select * from public.business_memberships where business_id='10000000-0000-4000-8000-000000000002';
delete from public.business_memberships where business_id='10000000-0000-4000-8000-000000000002';
insert into auth.users(id) select ('51100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,4) n;
insert into auth.sessions(id,user_id) select ('51100000-0000-4000-b000-'||lpad(n::text,12,'0'))::uuid, ('51100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,4) n;
insert into public.business_memberships(business_id,user_id,role,display_name) values
 ('10000000-0000-4000-8000-000000000002','51100000-0000-4000-8000-000000000001','admin','Race One'),
 ('10000000-0000-4000-8000-000000000002','51100000-0000-4000-8000-000000000002','admin','Race Two'),
 ('10000000-0000-4000-8000-000000000001','51100000-0000-4000-8000-000000000004','admin','Race Four');
insert into public.orders(id,business_id,customer_id,status,customer_name,customer_phone,delivery_address_line,latitude,longitude,address_label,address_house,address_street_area,address_location_source,saved_address_id,saved_address_version,subtotal_paise,delivery_fee_paise,total_paise,idempotency_key,request_hash)
 values ('51100000-0000-4000-9000-000000000001','10000000-0000-4000-8000-000000000001','51100000-0000-4000-8000-000000000003','placed','Race Customer','9800000003','Line',0.5,0.5,'home','House','Road','pin',gen_random_uuid(),1,100,0,100,gen_random_uuid(),'ad-race');
SQL
ad_call() { # sleep seconds, user number, statement
  printf "begin; set application_name='%s'; set local role authenticated; select set_config('request.jwt.claim.sub','51100000-0000-4000-8000-00000000000%s',true); select set_config('request.jwt.claims','{\"session_id\":\"51100000-0000-4000-b000-00000000000%s\"}',true); %s select pg_sleep(%s); commit;\n" "$1" "$3" "$3" "$4" "$2"
}
# 1. Owner one deletes and holds the transaction open; owner two waits on the restaurant lock, then is refused.
ad_call ad-owner-one 3 1 'select public.request_account_deletion();' | ad_sql >"$ad_tmp/one.log" 2>&1 &
ad_one=$!
ad_wait "application_name='ad-owner-one' and wait_event='PgSleep'"
ad_call ad-owner-two 0 2 'select public.request_account_deletion();' | ad_sql >"$ad_tmp/two.log" 2>&1 &
ad_two=$!
ad_wait "application_name='ad-owner-two' and cardinality(pg_blocking_pids(pid))>0"
wait "$ad_one" || { cat "$ad_tmp/one.log" >&2; echo 'First owner deletion failed' >&2; exit 1; }
if wait "$ad_two"; then echo 'Second simultaneous owner deletion was accepted' >&2; exit 1; fi
grep -q 'add another owner first' "$ad_tmp/two.log" || { cat "$ad_tmp/two.log" >&2; echo 'Second owner deletion failed for another reason' >&2; exit 1; }
ad_sql >/dev/null <<'SQL'
select public.test_assert((select count(*)=1 and bool_and(user_id='51100000-0000-4000-8000-000000000002') from public.business_memberships where business_id='10000000-0000-4000-8000-000000000002' and role='admin'),'exactly one owner remains after two simultaneous deletions');
select public.test_assert((select state='deletion_pending' from customer_lifecycle_private.accounts where customer_id='51100000-0000-4000-8000-000000000001')
  and not exists(select 1 from customer_lifecycle_private.accounts where customer_id='51100000-0000-4000-8000-000000000002' and state='deletion_pending'),'only the first owner is pending');
SQL
# 2. An owner's transition in flight (it holds the customer's lifecycle lock); the customer's deletion waits, then refuses.
ad_call ad-transition 3 4 "select public.transition_order('51100000-0000-4000-9000-000000000001','accepted',1);" | ad_sql >"$ad_tmp/transition.log" 2>&1 &
ad_transition=$!
ad_wait "application_name='ad-transition' and wait_event='PgSleep'"
ad_call ad-customer 0 3 'select public.request_account_deletion();' | ad_sql >"$ad_tmp/customer.log" 2>&1 &
ad_customer=$!
ad_wait "application_name='ad-customer' and cardinality(pg_blocking_pids(pid))>0"
wait "$ad_transition" || { cat "$ad_tmp/transition.log" >&2; echo 'In-flight transition failed' >&2; exit 1; }
if wait "$ad_customer"; then echo 'Deletion accepted with an order in progress' >&2; exit 1; fi
grep -q 'finish active orders' "$ad_tmp/customer.log" || { cat "$ad_tmp/customer.log" >&2; echo 'Deletion during a transition failed for another reason' >&2; exit 1; }
ad_sql >/dev/null <<'SQL'
select public.test_assert((select status='accepted' and customer_id='51100000-0000-4000-8000-000000000003' from public.orders where id='51100000-0000-4000-9000-000000000001')
  and not exists(select 1 from customer_lifecycle_private.accounts where customer_id='51100000-0000-4000-8000-000000000003' and state='deletion_pending'),'the order stayed linked and the customer was not marked pending');
-- Restore the fixture owners.
delete from public.business_memberships where business_id='10000000-0000-4000-8000-000000000002';
insert into public.business_memberships select * from public.ad_race_parked;
drop table public.ad_race_parked;
SQL
rm -rf "$ad_tmp"
