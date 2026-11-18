# Real two-session races, sourced after the foundation races in both PostGIS layouts.
lb_tmp=$(mktemp -d)
lb_sql() { docker exec -i -e PGOPTIONS='-c statement_timeout=15000' "$container" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$db" "$@"; }
lb_setup() {
 lb_user="b5200000-0000-4000-8000-0000000000$1"
 lb_order="b5200000-0000-4000-9000-0000000000$1"
 lb_request="b5200000-0000-4000-a000-0000000000$1"
 lb_auth="set role authenticated; select set_config('request.jwt.claim.sub','$lb_user',false); select set_config('request.jwt.claims','{\"session_id\":\"$lb_user\"}',false);"
 lb_sql >/dev/null <<SQL
insert into auth.users(id) values('$lb_user');
insert into auth.sessions(id,user_id) values('$lb_user','$lb_user');
insert into public.customer_businesses(customer_id,business_id) select '$lb_user',id from public.businesses;
insert into public.customer_addresses(customer_id,label,house,street_area,latitude,longitude,location_source) values('$lb_user','home','Leave race house','Road',0.5,0.5,'pin');
update public.businesses set accepting_orders=true where slug='ammu-sammu';
SQL
 lb_gen=$(lb_sql -tA -c "select generation from public.customer_businesses where customer_id='$lb_user' and business_id='10000000-0000-4000-8000-000000000001'")
 lb_leave="select public.leave_business('ammu-sammu','$lb_request','$lb_gen');"
 lb_place="select public.place_order('ammu-sammu','$race_items',public.test_delivery('Leave race'),null,'$lb_order',public.test_quote('ammu-sammu','$race_items'));"
 if [[ ${2:-none} != none ]]; then
  lb_sql >/dev/null <<SQL
insert into public.orders(id,business_id,customer_id,status,customer_name,customer_phone,delivery_address_line,latitude,longitude,address_label,address_house,address_street_area,address_location_source,saved_address_id,saved_address_version,subtotal_paise,delivery_fee_paise,total_paise,idempotency_key,request_hash)
values('$lb_order','10000000-0000-4000-8000-000000000001','$lb_user','$2','Keep customer','123','Keep address',0.5,0.5,'home','Keep house','Road','pin',gen_random_uuid(),1,100,0,100,gen_random_uuid(),'race');
SQL
 fi
}
lb_hold() {
 local sql=$1
 { echo "begin; set application_name='leave-race-held'; $sql select pg_sleep(3); commit;"; } | lb_sql -tA >"$lb_tmp/held" 2>&1 & lb_pid=$!
 local ready=false
 for _ in {1..100}; do
  if [[ $(lb_sql -tA -c "select count(*) from pg_stat_activity where datname=current_database() and application_name='leave-race-held' and wait_event='PgSleep'") == 1 ]]; then ready=true; break; fi
  sleep 0.05
 done
 [[ $ready == true ]] || { cat "$lb_tmp/held"; echo 'Leave race barrier not reached' >&2; exit 1; }
}
lb_done() { wait "$lb_pid" || { cat "$lb_tmp/held" >&2; exit 1; }; }
lb_refuse() {
 local expected=$1 sql=$2
 if echo "$sql" | lb_sql >"$lb_tmp/refused" 2>&1; then echo "Expected $expected" >&2; exit 1; fi
 grep -q "$expected" "$lb_tmp/refused" || { cat "$lb_tmp/refused" >&2; exit 1; }
}
# Placement first: leave observes committed active order after waiting.
lb_setup 01
lb_hold "$lb_auth $lb_place"
lb_refuse ACTIVE_ORDERS "$lb_auth $lb_leave"
lb_done
lb_sql -c "select public.test_assert((select count(*)=1 from public.orders where customer_id='$lb_user') and (select state='active' from public.customer_businesses where customer_id='$lb_user' and business_id='10000000-0000-4000-8000-000000000001'),'placement won; leave changed nothing')" >/dev/null
# Leave first: placement sees left, cannot silently rejoin.
lb_setup 02
lb_hold "$lb_auth $lb_leave"
lb_refuse BUSINESS_JOIN_REQUIRED "$lb_auth $lb_place"
lb_done
lb_sql -c "select public.test_assert(not exists(select 1 from public.orders where customer_id='$lb_user') and (select state='left' from public.customer_businesses where customer_id='$lb_user' and business_id='10000000-0000-4000-8000-000000000001'),'leave won; checkout refused')" >/dev/null
# Non-final transition first still blocks leave.
lb_setup 03 placed
lb_hold "set role authenticated; select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000003',false); select public.transition_order('$lb_order','accepted',1);"
lb_refuse ACTIVE_ORDERS "$lb_auth $lb_leave"
lb_done
lb_sql -c "select public.test_assert((select status='accepted' from public.orders where id='$lb_order') and not exists(select 1 from customer_lifecycle_private.leave_requests where customer_id='$lb_user'),'nonfinal transition retained; no leave receipt')" >/dev/null
# Final transition first: cutoff must include its committed feed event and purge it.
lb_setup 04 out_for_delivery
lb_hold "set role authenticated; select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000003',false); select public.transition_order('$lb_order','delivered',1);"
echo "$lb_auth $lb_leave" | lb_sql >/dev/null
lb_done
lb_sql -c "select public.test_assert((select status='delivered' from public.orders where id='$lb_order') and not exists(select 1 from public.customer_notifications where user_id='$lb_user'),'final transition snapshot retained; feed purged')" >/dev/null
# Leave checks first and refuses an active order; its lock must serialize the later transition.
lb_setup 05 placed
lb_hold "select customer_lifecycle_private.lock_account('$lb_user'); $lb_auth do \$\$ begin begin $lb_leave raise exception 'active leave succeeded'; exception when sqlstate 'PT409' then if sqlerrm<>'finish active orders' then raise; end if; end; end \$\$;"
echo "set role authenticated; select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000003',false); select public.transition_order('$lb_order','cancelled',1);" | lb_sql >/dev/null
lb_done
lb_sql -c "select public.test_assert((select status='cancelled' from public.orders where id='$lb_order') and exists(select 1 from public.customer_notifications where user_id='$lb_user' and event_status='cancelled') and not exists(select 1 from customer_lifecycle_private.leave_requests where customer_id='$lb_user'),'leave refused first, transition then completes without accidental purge')" >/dev/null
echo "$lb_auth $lb_leave" | lb_sql >/dev/null
# Leave holds first on a final order: a stale nonfinal transition cannot re-create feed after purge.
lb_setup 06 delivered
lb_hold "$lb_auth $lb_leave"
lb_refuse 'invalid order transition' "set role authenticated; select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000003',false); select public.transition_order('$lb_order','preparing',1);"
lb_done
lb_sql -c "select public.test_assert(not exists(select 1 from public.customer_notifications where user_id='$lb_user'),'stale transition creates no post-leave feed')" >/dev/null
# Duplicate leave waits, then returns the same saved receipt. Compare final stdout JSON.
lb_setup 07
lb_hold "$lb_auth $lb_leave"
echo "$lb_auth $lb_leave" | lb_sql -tA >"$lb_tmp/duplicate"
lb_done
grep '"state": "left"' "$lb_tmp/held" >"$lb_tmp/first-receipt"
grep '"state": "left"' "$lb_tmp/duplicate" >"$lb_tmp/second-receipt"
cmp "$lb_tmp/first-receipt" "$lb_tmp/second-receipt"
lb_sql -c "select public.test_assert((select count(*)=1 from customer_lifecycle_private.leave_requests where customer_id='$lb_user'),'duplicate leave has one request')" >/dev/null
# Simultaneous different-business leaves cannot both pass last-business check.
lb_setup 08
lb_other_gen=$(lb_sql -tA -c "select generation from public.customer_businesses where customer_id='$lb_user' and business_id='10000000-0000-4000-8000-000000000002'")
lb_hold "$lb_auth $lb_leave"
lb_refuse LAST_BUSINESS "$lb_auth select public.leave_business('kokani-dine-inn',gen_random_uuid(),'$lb_other_gen');"
lb_done
# Join racing a pending-state transaction waits then refuses pending. Other business stays usable.
lb_setup 09
lb_hold "select customer_lifecycle_private.lock_account('$lb_user'); update public.customer_businesses set state='leave_pending' where customer_id='$lb_user' and business_id='10000000-0000-4000-8000-000000000001';"
lb_refuse BUSINESS_LIFECYCLE_PENDING "$lb_auth select public.join_business('ammu-sammu');"
lb_done
echo "$lb_auth select public.join_business('kokani-dine-inn');" | lb_sql >/dev/null
# Actual atomic leave first: join waits for completion, then starts a new generation.
lb_setup 10
lb_hold "$lb_auth $lb_leave"
echo "$lb_auth select public.join_business('ammu-sammu');" | lb_sql >/dev/null
lb_done
lb_sql -c "select public.test_assert((select state='active' and generation<>'$lb_gen' from public.customer_businesses where customer_id='$lb_user' and business_id='10000000-0000-4000-8000-000000000001'),'join after atomic leave has fresh generation')" >/dev/null
# Registration first: leave waits and cleans the committed token.
lb_setup 11
lb_hold "$lb_auth select public.register_device_token('ammu-sammu','customer','leave-race-token-first');"
echo "$lb_auth $lb_leave" | lb_sql >/dev/null
lb_done
lb_sql -c "select public.test_assert(not exists(select 1 from public.device_tokens where user_id='$lb_user'),'registration before leave is cleaned')" >/dev/null
# Cleanup first: registration waits then cannot restore a left customer's token.
lb_setup 12
lb_hold "$lb_auth $lb_leave"
lb_refuse BUSINESS_LIFECYCLE_PENDING "$lb_auth select public.register_device_token('ammu-sammu','customer','leave-race-cleanup-first');"
lb_done
lb_sql -c "select public.test_assert(not exists(select 1 from public.device_tokens where user_id='$lb_user'),'registration after leave refused')" >/dev/null
# Dispatcher unregistered versus leave: token-before-jobs order, both directions.
lb_sql >/dev/null <<'SQL'
create function public.test_leave_pause() returns trigger language plpgsql as $$ begin
 if current_setting('application_name',true)='leave-cleanup-inside' then perform pg_sleep(3); end if;
 return new;
end $$;
create trigger test_leave_pause before update on public.notification_outbox for each row
 when (old.completed_at is not null and new.device_token_id is null) execute function public.test_leave_pause();
SQL
for direction in dispatcher-first leave-first rotation; do
 if [[ $direction == dispatcher-first ]]; then lb_setup 13 delivered; elif [[ $direction == leave-first ]]; then lb_setup 14 delivered; else lb_setup 15 delivered; fi
 echo "$lb_auth select public.register_device_token('ammu-sammu','customer','dispatcher-$direction');" | lb_sql >/dev/null
 lb_token=$(lb_sql -tA -c "select id from public.device_tokens where user_id='$lb_user'")
 lb_job="b5200000-0000-4000-b000-${lb_user##*-}"
 lb_lease="b5200000-0000-4000-c000-${lb_user##*-}"
 lb_sql >/dev/null <<SQL
insert into public.notification_outbox(device_token_id,order_id,audience,completed_at) values('$lb_token','$lb_order','customer',clock_timestamp());
insert into public.notification_outbox(id,device_token_id,order_id,audience,attempts,lease_id,lease_expires_at) values('$lb_job','$lb_token','$lb_order','customer',1,'$lb_lease',clock_timestamp()+interval '2 minutes');
SQL
 if [[ $direction == dispatcher-first ]]; then
  lb_hold "set role service_role; select public.finish_notification_job('$lb_job','$lb_lease','unregistered');"
  echo "$lb_auth $lb_leave" | lb_sql >/dev/null
 else
  # Pause inside cleanup after it locks the completed job; this reproduces the old inversion.
  echo "begin; set application_name='leave-cleanup-inside'; $lb_auth $lb_leave commit;" | lb_sql >"$lb_tmp/held" 2>&1 & lb_pid=$!
  lb_ready=false
  for _ in {1..100}; do
   if [[ $(lb_sql -tA -c "select count(*) from pg_stat_activity where datname=current_database() and application_name='leave-cleanup-inside' and wait_event='PgSleep'") == 1 ]]; then lb_ready=true; break; fi
   sleep 0.05
  done
  [[ $lb_ready == true ]] || { cat "$lb_tmp/held" >&2; echo 'Inside-cleanup barrier missing' >&2; exit 1; }
  if [[ $direction == leave-first ]]; then
   lb_sql -c "set role service_role; select public.test_assert(not public.finish_notification_job('$lb_job','$lb_lease','unregistered'),'removed lease cannot finish after leave')" >/dev/null
  else
   # A different customer re-registering the same opaque token also deletes the old token/jobs.
   echo "set role authenticated; select set_config('request.jwt.claim.sub','b5200000-0000-4000-8000-000000000001',false); select set_config('request.jwt.claims','{\"session_id\":\"b5200000-0000-4000-8000-000000000001\"}',false); select public.register_device_token('ammu-sammu','customer','dispatcher-rotation');" | lb_sql >/dev/null
  fi
 fi
 lb_done
 lb_sql -c "select public.test_assert(not exists(select 1 from public.device_tokens where user_id='$lb_user') and not exists(select 1 from public.notification_outbox where order_id='$lb_order' and completed_at is null),'dispatcher/leave complete with no token or pending work')" >/dev/null
done
lb_sql >/dev/null <<'SQL'
drop trigger test_leave_pause on public.notification_outbox;
drop function public.test_leave_pause();
SQL
rm -rf "$lb_tmp"
echo 'Leave placement, transitions, duplicate/last-business, join and token races passed.'
