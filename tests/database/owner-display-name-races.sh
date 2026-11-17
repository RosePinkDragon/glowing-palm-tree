# Sourced by run.sh once per final PostGIS layout. Local disposable database only.
owner_name_sql() { docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$db" "$@"; }
owner_name_sql >/dev/null <<'SQL'
insert into auth.users(id) values ('55310000-0000-4000-8000-000000000001'),('55310000-0000-4000-8000-000000000002');
insert into auth.sessions(id,user_id) values ('55310000-0000-4000-8000-000000000001','55310000-0000-4000-8000-000000000001');
insert into public.business_memberships(business_id,user_id,role,display_name) values
 ('10000000-0000-4000-8000-000000000001','55310000-0000-4000-8000-000000000001','admin','Race Old');
insert into public.orders(id,business_id,customer_id,customer_name,customer_phone,delivery_address_line,latitude,longitude,address_label,address_house,address_street_area,address_location_source,saved_address_id,saved_address_version,subtotal_paise,delivery_fee_paise,total_paise,idempotency_key,request_hash)
values ('55310000-0000-4000-9000-000000000001','10000000-0000-4000-8000-000000000001','55310000-0000-4000-8000-000000000002','Name race customer','0','Test address',0.5,0.5,'home','Test','Test','pin',gen_random_uuid(),1,100,0,100,'55310000-0000-4000-a000-000000000001','owner-name-race');
set role authenticated;
select set_config('request.jwt.claim.sub','55310000-0000-4000-8000-000000000001',false);
select public.transition_order('55310000-0000-4000-9000-000000000001','accepted',1);
SQL
owner_name_tmp=$(mktemp -d /tmp/owner-name-races.XXXXXX)
owner_name_wait() {
 local predicate="$1" seen=false
 for _ in {1..60}; do
  if [[ $(owner_name_sql -tA -c "select count(*) from pg_stat_activity where datname=current_database() and ($predicate)") == 1 ]]; then seen=true; break; fi
  sleep 0.05
 done
 if [[ "$seen" != true ]]; then echo "Owner-name race never observed: $predicate" >&2; cat "$owner_name_tmp"/*.log >&2; exit 1; fi
}
owner_name_finish() {
 if ! wait "$owner_name_first_pid"; then cat "$owner_name_tmp/first.log" >&2; exit 1; fi
 if ! wait "$owner_name_second_pid"; then cat "$owner_name_tmp/second.log" >&2; exit 1; fi
}
# A rename holds the membership; the new step must wait and snapshot the new name.
owner_name_sql >"$owner_name_tmp/first.log" 2>&1 <<'SQL' &
begin;
set application_name='owner-name-rename-first';
set local role authenticated;
select set_config('request.jwt.claim.sub','55310000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"session_id":"55310000-0000-4000-8000-000000000001"}',true);
select public.set_owner_display_name('ammu-sammu','Race New');
select pg_sleep(3);
commit;
SQL
owner_name_first_pid=$!
owner_name_wait "application_name='owner-name-rename-first' and wait_event='PgSleep'"
owner_name_sql >"$owner_name_tmp/second.log" 2>&1 <<'SQL' &
set application_name='owner-name-transition-waits';
set lock_timeout='10s';
set role authenticated;
select set_config('request.jwt.claim.sub','55310000-0000-4000-8000-000000000001',false);
select public.transition_order('55310000-0000-4000-9000-000000000001','preparing',2);
SQL
owner_name_second_pid=$!
owner_name_wait "application_name='owner-name-transition-waits' and cardinality(pg_blocking_pids(pid))>0"
owner_name_finish
# Reverse ordering: a transition's existing snapshot read must block the rename.
owner_name_sql >"$owner_name_tmp/first.log" 2>&1 <<'SQL' &
begin;
set application_name='owner-name-transition-first';
set local role authenticated;
select set_config('request.jwt.claim.sub','55310000-0000-4000-8000-000000000001',true);
select public.transition_order('55310000-0000-4000-9000-000000000001','out_for_delivery',3);
select pg_sleep(3);
commit;
SQL
owner_name_first_pid=$!
owner_name_wait "application_name='owner-name-transition-first' and wait_event='PgSleep'"
owner_name_sql >"$owner_name_tmp/second.log" 2>&1 <<'SQL' &
set application_name='owner-name-rename-waits';
set lock_timeout='10s';
set role authenticated;
select set_config('request.jwt.claim.sub','55310000-0000-4000-8000-000000000001',false);
select set_config('request.jwt.claims','{"session_id":"55310000-0000-4000-8000-000000000001"}',false);
select public.set_owner_display_name('ammu-sammu','Race Last');
SQL
owner_name_second_pid=$!
owner_name_wait "application_name='owner-name-rename-waits' and cardinality(pg_blocking_pids(pid))>0"
owner_name_finish
owner_name_sql >/dev/null <<'SQL'
set role authenticated;
select set_config('request.jwt.claim.sub','55310000-0000-4000-8000-000000000001',false);
select public.transition_order('55310000-0000-4000-9000-000000000001','delivered',4);
reset role;
select public.test_assert((select array_agg(a.actor_name order by h.id)=array['Race Old','Race New','Race New','Race Last'] from public.order_status_history h join public.order_status_actors a on a.history_id=h.id where h.order_id='55310000-0000-4000-9000-000000000001'),'concurrent renames never rewrite snapshots or mix step names');
SQL
# Membership revocation wins first: the waiting rename must refuse, never resurrect it.
owner_name_sql >"$owner_name_tmp/first.log" 2>&1 <<'SQL' &
begin;
set application_name='owner-name-revocation-first';
delete from public.business_memberships where business_id='10000000-0000-4000-8000-000000000001' and user_id='55310000-0000-4000-8000-000000000001';
select pg_sleep(3);
commit;
SQL
owner_name_first_pid=$!
owner_name_wait "application_name='owner-name-revocation-first' and wait_event='PgSleep'"
owner_name_sql >"$owner_name_tmp/second.log" 2>&1 <<'SQL' &
set application_name='owner-name-revoked-rename';
set lock_timeout='10s';
set role authenticated;
select set_config('request.jwt.claim.sub','55310000-0000-4000-8000-000000000001',false);
select set_config('request.jwt.claims','{"session_id":"55310000-0000-4000-8000-000000000001"}',false);
do $$ begin perform public.set_owner_display_name('ammu-sammu','Should Refuse'); raise exception 'rename survived concurrent revocation'; exception when insufficient_privilege then null; end $$;
SQL
owner_name_second_pid=$!
owner_name_wait "application_name='owner-name-revoked-rename' and cardinality(pg_blocking_pids(pid))>0"
owner_name_finish
owner_name_sql >/dev/null <<'SQL'
select public.test_assert(not exists(select 1 from public.business_memberships where business_id='10000000-0000-4000-8000-000000000001' and user_id='55310000-0000-4000-8000-000000000001'),'rename cannot recreate revoked membership');
insert into public.business_memberships(business_id,user_id,role,display_name) values ('10000000-0000-4000-8000-000000000001','55310000-0000-4000-8000-000000000001','admin','Race Last');
SQL
# Session expiry wins first: FOR SHARE must wait, recheck expiry and refuse the rename.
owner_name_sql >"$owner_name_tmp/first.log" 2>&1 <<'SQL' &
begin;
set application_name='owner-name-session-first';
update auth.sessions set not_after=clock_timestamp()-interval '1 second' where id='55310000-0000-4000-8000-000000000001';
select pg_sleep(3);
commit;
SQL
owner_name_first_pid=$!
owner_name_wait "application_name='owner-name-session-first' and wait_event='PgSleep'"
owner_name_sql >"$owner_name_tmp/second.log" 2>&1 <<'SQL' &
set application_name='owner-name-expired-rename';
set lock_timeout='10s';
set role authenticated;
select set_config('request.jwt.claim.sub','55310000-0000-4000-8000-000000000001',false);
select set_config('request.jwt.claims','{"session_id":"55310000-0000-4000-8000-000000000001"}',false);
do $$ begin perform public.set_owner_display_name('ammu-sammu','Should Refuse'); raise exception 'rename survived concurrent session expiry'; exception when insufficient_privilege then null; end $$;
SQL
owner_name_second_pid=$!
owner_name_wait "application_name='owner-name-expired-rename' and cardinality(pg_blocking_pids(pid))>0"
owner_name_finish
owner_name_sql >/dev/null <<'SQL'
select public.test_assert((select display_name='Race Last' from public.business_memberships where business_id='10000000-0000-4000-8000-000000000001' and user_id='55310000-0000-4000-8000-000000000001'),'session expiry blocks any name update');
SQL
rm -rf "$owner_name_tmp"
echo 'Owner name transition, revocation and session-lock races passed.'
