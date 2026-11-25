# Sourced by run.sh once per final PostGIS layout. Local disposable database only. (#213)
# The active-session check locks the caller's auth.sessions row FOR SHARE, so a sign-out (the row's DELETE) cannot be
# ordered between the check and the write it authorizes: it waits for the in-flight call, and any later call is refused.
as_sql() { docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$db" "$@"; }
as_sql >/dev/null <<'SQL'
insert into auth.users(id) values ('21310000-0000-4000-8000-000000000001');
insert into auth.sessions(id,user_id) values ('21310000-0000-4000-b000-000000000001','21310000-0000-4000-8000-000000000001');
insert into public.business_memberships(business_id,user_id,role) values ('10000000-0000-4000-8000-000000000001','21310000-0000-4000-8000-000000000001','admin');
SQL
as_tmp=$(mktemp -d /tmp/active-session-races.XXXXXX)
as_wait() {
  local predicate="$1" seen=false
  for _ in {1..100}; do
    if [[ $(as_sql -tA -c "select count(*) from pg_stat_activity where datname=current_database() and ($predicate)") == 1 ]]; then seen=true; break; fi
    sleep 0.05
  done
  if [[ "$seen" != true ]]; then echo "Active-session race never observed: $predicate" >&2; cat "$as_tmp"/*.log >&2; exit 1; fi
}
as_changes_before=$(as_sql -tA -c "select count(*) from public.accepting_orders_changes")
# An owner call that has passed the session check and is still open (it re-sends the current switch value: no change).
as_sql >"$as_tmp/call.log" 2>&1 <<'SQL' &
begin;
set application_name='active-session-call';
set local role authenticated;
select set_config('request.jwt.claim.sub','21310000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"session_id":"21310000-0000-4000-b000-000000000001"}',true);
select public.set_accepting_orders('ammu-sammu',(select accepting_orders from public.businesses where slug='ammu-sammu'));
select pg_sleep(3);
commit;
SQL
as_call=$!
as_wait "application_name='active-session-call' and wait_event='PgSleep'"
# The sign-out must wait for it: a bounded delete times out while the call is open ...
as_sql >"$as_tmp/probe.log" 2>&1 <<'SQL' || { cat "$as_tmp/probe.log" >&2; exit 1; }
set lock_timeout='300ms';
do $$ begin
  delete from auth.sessions where id='21310000-0000-4000-b000-000000000001';
  raise exception 'sign-out did not wait for the in-flight call';
exception when lock_not_available then null; end $$;
SQL
# ... and an unbounded one is held behind it, then completes once the call commits.
as_sql >"$as_tmp/signout.log" 2>&1 <<'SQL' &
set application_name='active-session-signout';
delete from auth.sessions where id='21310000-0000-4000-b000-000000000001';
SQL
as_signout=$!
as_wait "application_name='active-session-signout' and cardinality(pg_blocking_pids(pid))>0"
wait "$as_call" || { cat "$as_tmp/call.log" >&2; echo 'In-flight owner call failed' >&2; exit 1; }
wait "$as_signout" || { cat "$as_tmp/signout.log" >&2; exit 1; }
# After the sign-out the same unexpired JWT is refused, and nothing changed.
as_sql >/dev/null <<'SQL'
select public.test_assert(not exists(select 1 from auth.sessions where id='21310000-0000-4000-b000-000000000001'), 'the sign-out completed after the in-flight call');
set role authenticated;
select set_config('request.jwt.claim.sub','21310000-0000-4000-8000-000000000001',false);
select set_config('request.jwt.claims','{"session_id":"21310000-0000-4000-b000-000000000001"}',false);
do $$ declare d text; begin
  perform public.set_accepting_orders('ammu-sammu',not (select accepting_orders from public.businesses where slug='ammu-sammu'));
  raise exception 'owner call succeeded after sign-out';
exception when others then
  get stacked diagnostics d = pg_exception_detail;
  if not (sqlstate='42501' and sqlerrm='invalid session' and d='INVALID_SESSION') then raise; end if;
end $$;
SQL
[[ "$(as_sql -tA -c "select count(*) from public.accepting_orders_changes")" == "$as_changes_before" ]] || { echo 'A refused or no-op call changed the accepting switch history' >&2; exit 1; }
as_sql >/dev/null <<'SQL'
delete from public.business_memberships where user_id='21310000-0000-4000-8000-000000000001';
delete from auth.users where id='21310000-0000-4000-8000-000000000001';
SQL
rm -rf "$as_tmp"
echo 'Active-session sign-out race passed.'
