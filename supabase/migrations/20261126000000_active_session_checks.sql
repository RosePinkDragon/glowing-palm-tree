-- Active-session authorization for checkout and owner write RPCs (#213, slice A).
--
-- A JWT stays cryptographically valid until it expires, even after sign-out or revocation deleted its
-- auth.sessions row. The functions below already authorize by auth.uid() and business membership; this
-- migration also requires that the JWT's session_id names a present, unexpired session of the caller,
-- exactly as save_restaurant_settings, set_owner_display_name, device-token registration and join/leave
-- business already do. Missing, malformed, foreign, deleted and expired sessions raise SQLSTATE 42501
-- 'invalid session' with detail INVALID_SESSION.
--
-- Lock order (unchanged, see docs/RELEASE.md): users KEY SHARE -> sessions SHARE -> accounts -> business
-- -> advisory -> rows. The helper is the first lock every caller takes, so it cannot invert that order.
-- Sessions are locked FOR SHARE, as in the existing checks: a sign-out (DELETE) or a revoking update
-- must wait for the in-flight write to commit, so a write can never be ordered after the revocation
-- that should have stopped it. (FOR KEY SHARE would also block a DELETE, but the repository documents
-- and tests "sessions SHARE"; one mode keeps every path comparable.) A token refresh updates the row and
-- waits only for the length of one short transaction.
--
-- Each function below is the current definition (baseline, or offers_and_pricing for checkout) with exactly
-- one added statement: the call to require_active_session right after its existing caller check.
-- Not changed here (slice B): direct table writes allowed by row-level security.

create function customer_lifecycle_private.require_active_session(p_caller uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare session uuid;
begin
  if p_caller is null then raise exception 'authentication required' using errcode='42501'; end if;
  -- Users first: serializes with Auth account deletion cascading through sessions.
  perform 1 from auth.users where id=p_caller for key share;
  if not found then raise exception 'authentication required' using errcode='42501'; end if;
  begin session := (auth.jwt()->>'session_id')::uuid;
  exception when others then
    raise exception 'invalid session' using errcode='42501', detail='INVALID_SESSION';
  end;
  if session is null then raise exception 'invalid session' using errcode='42501', detail='INVALID_SESSION'; end if;
  perform 1 from auth.sessions where id=session and user_id=p_caller
    and (not_after is null or not_after > clock_timestamp()) for share;
  if not found then raise exception 'invalid session' using errcode='42501', detail='INVALID_SESSION'; end if;
end $$;
-- Internal only: called from SECURITY DEFINER functions (which run as the owner); no client or service role
-- may call it directly, and a caller cannot choose another user to check.
revoke all on function customer_lifecycle_private.require_active_session(uuid) from public, anon, authenticated, service_role;



-- Checkout (private implementation; the public place_order wrappers call it and are unchanged).
create or replace function offers_private.place_order(p_business_slug text, p_items jsonb, p_delivery jsonb, p_location jsonb, p_idempotency_key uuid, p_accepted_pricing jsonb, p_offer_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid(); b public.businesses%rowtype; existing public.orders%rowtype;
  menu public.menu_items%rowtype; item jsonb; qty integer;
  priced record; subtotal bigint; total bigint; order_id uuid := gen_random_uuid(); request_digest text;
  crypto_schema text; rejected public.checkout_pricing_rejections%rowtype; quote jsonb;
  addr public.customer_addresses%rowtype; spatial_schema text; covered boolean;
  phone_lat double precision; phone_lon double precision; phone_at timestamptz; phone_distance double precision; kitchen_distance double precision;
  offer_code text; locked uuid[]; resolution jsonb; code_error jsonb; discount bigint; offer jsonb; change_reason text; previous_reason text; retry_after integer;
begin
  if caller is null or p_idempotency_key is null then raise exception 'authentication and idempotency key required' using errcode='22023'; end if;
  perform customer_lifecycle_private.require_active_session(caller);
  if p_offer_code is not null and char_length(p_offer_code) > 64 then raise exception 'invalid offer code' using errcode='22023'; end if;
  offer_code := nullif(upper(btrim(p_offer_code)), '');
  perform customer_lifecycle_private.lock_account(caller);
  select * into b from public.businesses where slug=p_business_slug for share;
  if not found then raise exception 'business unavailable' using errcode='22023'; end if;
  -- Read-only gate: left/pending relationships refuse checkout. A completed leave must
  -- retain its left marker; replays and pricing rejections must never enroll a customer.
  if exists(select 1 from public.customer_businesses where customer_id=caller and business_id=b.id and state='left') then
    raise exception 'join this business before checkout' using errcode='PT403', detail='BUSINESS_JOIN_REQUIRED';
  end if;
  if exists(select 1 from public.customer_businesses where customer_id=caller and business_id=b.id and state='leave_pending') then
    raise exception 'business lifecycle pending' using errcode='PT409', detail='BUSINESS_LIFECYCLE_PENDING';
  end if;
  select n.nspname into strict crypto_schema from pg_catalog.pg_extension e
    join pg_catalog.pg_namespace n on n.oid=e.extnamespace where e.extname='pgcrypto';
  -- The digest covers address_id/address_version inside p_delivery and the offer code. The code key is added only
  -- when a code is sent, so a request without one hashes exactly as it did before offers.
  execute format('select pg_catalog.encode(%I.digest($1, ''sha256''), ''hex'')', crypto_schema)
    into request_digest using (jsonb_build_object('business',p_business_slug,'items',p_items,'delivery',p_delivery,'location',p_location,'accepted_pricing',p_accepted_pricing)
      || case when offer_code is null then '{}'::jsonb else jsonb_build_object('offer_code',offer_code) end)::text;
  -- Serialize even simultaneous first attempts before checking the unique key.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(caller::text || ':' || b.id::text || ':' || p_idempotency_key::text, 0));
  -- Replays come first: a retry returns the original order even if the saved
  -- address was edited or deleted afterwards, and even if its offer has since ended or been used up.
  select * into existing from public.orders where customer_id=caller and business_id=b.id and idempotency_key=p_idempotency_key;
  if found then
    if existing.request_hash <> request_digest then raise exception 'idempotency key reused with different request' using errcode='22023'; end if;
    return jsonb_build_object('outcome','placed','id',existing.id,'order_number',existing.order_number,'business_id',existing.business_id,'status',existing.status,'version',existing.version,'subtotal_paise',existing.subtotal_paise,'delivery_fee_paise',existing.delivery_fee_paise,'discount_paise',existing.discount_paise,
      'offer',case when existing.offer_id is null then null else jsonb_build_object('id',existing.offer_id,'name',existing.offer_name,'code',existing.offer_code,'kind',existing.offer_kind) end,
      'total_paise',existing.total_paise,'created_at',existing.created_at);
  end if;
  select * into rejected from public.checkout_pricing_rejections where customer_id=caller and business_id=b.id and idempotency_key=p_idempotency_key;
  if found then
    if rejected.request_hash <> request_digest then raise exception 'idempotency key reused with different request' using errcode='22023'; end if;
    if rejected.offer_reason is not null then
      return jsonb_build_object('outcome','offer_changed','reason',rejected.offer_reason,'pricing',rejected.pricing)
        || case when rejected.offer_retry_after is null then '{}'::jsonb else jsonb_build_object('retry_after_seconds',rejected.offer_retry_after) end;
    end if;
    return jsonb_build_object('outcome','pricing_changed','pricing',rejected.pricing);
  end if;
  if not b.accepting_orders then
    -- PT409: PostgREST answers HTTP 409 rather than a server error.
    raise exception 'restaurant is not accepting orders' using errcode='PT409';
  end if;
  if jsonb_typeof(p_delivery) is distinct from 'object' or
     coalesce(length(trim(p_delivery->>'name')),0) not between 1 and 120 or
     coalesce(length(trim(p_delivery->>'phone')),0) not between 1 and 40 or
     not (p_delivery ? 'address_id') or p_delivery ? 'address_line' or
     coalesce(p_delivery->>'address_id','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' or
     coalesce(p_delivery->>'address_version','') !~ '^[1-9][0-9]{0,8}$' then
    raise exception 'invalid delivery details' using errcode='22023';
  end if;
  -- Offer locks come after the checkout key and before every address/menu/order row (see the lock order above).
  locked := offers_private.lock_offers(b.id, caller, offer_code);
  -- Ownership is explicit: this function bypasses RLS. Lock the row so the
  -- snapshot below is exactly the version the customer reviewed.
  select * into addr from public.customer_addresses
    where id=(p_delivery->>'address_id')::uuid and customer_id=caller for share;
  if not found or addr.version <> (p_delivery->>'address_version')::integer then
    -- PT412: HTTP 412, the reviewed address is gone or changed; reload it.
    raise exception 'saved address changed' using errcode='PT412';
  end if;
  if not b.ordering_enabled or b.service_area is null or b.service_area_verified_at is null
     or nullif(trim(b.service_area_source), '') is null or nullif(trim(b.service_area_version), '') is null then
    raise exception 'delivery unavailable' using errcode='22023';
  end if;
  select n.nspname into strict spatial_schema from pg_catalog.pg_extension e
    join pg_catalog.pg_namespace n on n.oid=e.extnamespace where e.extname='postgis';
  execute format('select %1$I.st_covers($1::%1$I.geography, %1$I.st_setsrid(%1$I.st_makepoint($2,$3),4326)::%1$I.geography)', spatial_schema)
    into covered using b.service_area, addr.longitude, addr.latitude;
  if not coalesce(covered,false) then raise exception 'delivery unavailable' using errcode='22023'; end if;
  -- Kitchen-to-pin distance for the owners' queue card; unknown when no kitchen point is set.
  if b.kitchen_location is not null then
    execute format('select %1$I.st_distance($1::%1$I.geography, %1$I.st_setsrid(%1$I.st_makepoint($2,$3),4326)::%1$I.geography)', spatial_schema)
      into kitchen_distance using b.kitchen_location, addr.longitude, addr.latitude;
  end if;
  -- The phone fix never blocks an order: anything missing, malformed, coarser
  -- than 150 m, old or in the future just leaves the distance unknown. It is
  -- the customer's own claim, so owners treat it as a hint, never as proof.
  begin
    if jsonb_typeof(p_location) = 'object' then
      phone_lat := (p_location->>'latitude')::double precision;
      phone_lon := (p_location->>'longitude')::double precision;
      phone_at := (p_location->>'captured_at')::timestamptz;
      if phone_lat between -90 and 90 and phone_lon between -180 and 180
         and (p_location->>'accuracy')::double precision between 0 and 150
         and phone_at between clock_timestamp() - interval '10 minutes' and clock_timestamp() + interval '30 seconds' then
        execute format('select %1$I.st_distance(%1$I.st_setsrid(%1$I.st_makepoint($1,$2),4326)::%1$I.geography, %1$I.st_setsrid(%1$I.st_makepoint($3,$4),4326)::%1$I.geography)', spatial_schema)
          into phone_distance using phone_lon, phone_lat, addr.longitude, addr.latitude;
      end if;
    end if;
  exception when others then phone_distance := null;
  end;
  select * into priced from offers_private.price_items(b.id, p_items, true);
  subtotal := priced.subtotal;
  resolution := offers_private.resolve(b.id, caller, offer_code, subtotal, b.delivery_fee_paise, locked);
  if resolution->'error' <> 'null'::jsonb then
    -- The code no longer applies. Never drop it silently: refuse with the reason and the cart priced without it,
    -- which is exactly what a retry without the code will compute. (resolve returned, so its attempt log commits.)
    code_error := resolution->'error';
    resolution := offers_private.resolve(b.id, caller, null, subtotal, b.delivery_fee_paise, null);
  end if;
  discount := (resolution->>'discount_paise')::bigint;
  offer := resolution->'offer';
  total := subtotal + b.delivery_fee_paise - discount;
  quote := offers_private.build_quote(b.delivery_fee_paise, b.min_order_paise, subtotal, priced.lines, resolution);
  if total > 2147483647 then raise exception 'invalid order total' using errcode='22023'; end if;
  if code_error is not null or p_accepted_pricing is distinct from quote then
    -- A changed quote creates no order. Replaying its key remains a rejection,
    -- even if menu prices later return to the previously accepted values.
    change_reason := code_error->>'reason';
    if change_reason is null and jsonb_typeof(p_accepted_pricing->'offer') = 'object'
       and (jsonb_typeof(offer) is distinct from 'object' or offer->>'id' is distinct from p_accepted_pricing->'offer'->>'id') then
      -- The quoted offer is gone: say why when it still exists, otherwise that it changed. The id is client data,
      -- so a malformed one is simply "changed" (never a cast error).
      if p_accepted_pricing->'offer'->>'id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
        select e.reason into previous_reason from public.offers o
          cross join lateral offers_private.evaluate(o, caller, subtotal, b.delivery_fee_paise, clock_timestamp()) e
          where o.id = (p_accepted_pricing->'offer'->>'id')::uuid and o.business_id = b.id;
      end if;
      change_reason := coalesce(previous_reason, 'changed');
    end if;
    if change_reason = 'rate_limited' then retry_after := (code_error->>'retry_after_seconds')::integer; end if;
    insert into public.checkout_pricing_rejections(customer_id,business_id,idempotency_key,request_hash,pricing,offer_reason,offer_retry_after)
      values(caller,b.id,p_idempotency_key,request_digest,quote,change_reason,retry_after);
    if change_reason is not null then
      return jsonb_build_object('outcome','offer_changed','reason',change_reason,'pricing',quote)
        || case when retry_after is null then '{}'::jsonb else jsonb_build_object('retry_after_seconds',retry_after) end;
    end if;
    return jsonb_build_object('outcome','pricing_changed','pricing',quote);
  end if;
  if subtotal < b.min_order_paise or total > 2147483647 then raise exception 'invalid order total' using errcode='22023'; end if;
  -- Enroll only when creating a new order, after all normal-return replay/rejection paths.
  -- Still under the account lock; failure of the order transaction rolls this back too.
  insert into public.customer_businesses(customer_id,business_id) values(caller,b.id) on conflict do nothing;
  insert into public.orders(id,business_id,customer_id,customer_name,customer_phone,delivery_address_line,latitude,longitude,
    address_label,address_custom_label,address_house,address_street_area,address_landmark,address_location_source,
    saved_address_id,saved_address_version,placed_from_distance_m,kitchen_distance_m,subtotal_paise,delivery_fee_paise,discount_paise,total_paise,
    offer_id,offer_name,offer_code,offer_kind,idempotency_key,request_hash)
  values(order_id,b.id,caller,trim(p_delivery->>'name'),trim(p_delivery->>'phone'),
    concat_ws(', ',addr.house,addr.street_area,addr.landmark),addr.latitude,addr.longitude,
    addr.label,addr.custom_label,addr.house,addr.street_area,addr.landmark,addr.location_source,
    addr.id,addr.version,round(phone_distance)::integer,round(kitchen_distance)::integer,subtotal::integer,b.delivery_fee_paise,discount::integer,total::integer,
    (offer->>'id')::uuid,offer->>'name',offer->>'code',offer->>'kind',p_idempotency_key,request_digest)
  returning * into existing;
  if jsonb_typeof(offer) = 'object' then
    insert into public.offer_redemptions(offer_id,order_id,customer_id,business_id) values(existing.offer_id,existing.id,caller,b.id);
  end if;
  for item in select value from jsonb_array_elements(p_items) loop
    select * into strict menu from public.menu_items where id=(item->>'menu_item_id')::uuid;
    qty := (item->>'quantity')::integer;
    insert into public.order_items(order_id,menu_item_id,name,unit_price_paise,quantity,line_total_paise,diet)
      values(order_id,menu.id,menu.name,menu.price_paise,qty,menu.price_paise::bigint*qty,menu.diet);
  end loop;
  insert into public.order_status_history(order_id,status,changed_by) values(order_id,'placed',caller);
  return jsonb_build_object('outcome','placed','id',existing.id,'order_number',existing.order_number,'business_id',existing.business_id,'status',existing.status,'version',existing.version,'subtotal_paise',existing.subtotal_paise,'delivery_fee_paise',existing.delivery_fee_paise,'discount_paise',existing.discount_paise,
    'offer',case when existing.offer_id is null then null else jsonb_build_object('id',existing.offer_id,'name',existing.offer_name,'code',existing.offer_code,'kind',existing.offer_kind) end,
    'total_paise',existing.total_paise,'created_at',existing.created_at);
end $$;


-- Owners: open/closed switch.
create or replace function public.set_accepting_orders(p_business_slug text, p_accepting boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare caller uuid := auth.uid(); b public.businesses%rowtype;
begin
  if caller is null then raise exception 'authentication required' using errcode='42501'; end if;
  perform customer_lifecycle_private.require_active_session(caller);
  if p_accepting is null then raise exception 'a value is required' using errcode='22023'; end if;
  select * into b from public.businesses where slug=p_business_slug for no key update;
  if not found then raise exception 'business unavailable' using errcode='42501'; end if;
  -- Lock the membership so revocation and the change cannot race.
  perform 1 from public.business_memberships where business_id=b.id and user_id=caller and role='admin' for share;
  if not found then raise exception 'business unavailable' using errcode='42501'; end if;
  if b.accepting_orders is distinct from p_accepting then
    update public.businesses set accepting_orders=p_accepting where id=b.id;
    insert into public.accepting_orders_changes(business_id,accepting_orders,changed_by) values (b.id,p_accepting,caller);
  end if;
  return jsonb_build_object('business_id',b.id,'accepting_orders',p_accepting);
end $$;


-- Owners: order status transitions.
create or replace function public.transition_order(p_order_id uuid, p_status text, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare o public.orders%rowtype; caller uuid := auth.uid(); actor text; step bigint; target_customer uuid; target_business uuid;
begin
  if caller is null then raise exception 'authentication required' using errcode='42501'; end if;
  perform customer_lifecycle_private.require_active_session(caller);
  perform 1 from auth.users where id=caller for key share;
  if not found then raise exception 'authentication required' using errcode='42501'; end if;
  select customer_id,business_id into target_customer,target_business from public.orders where id=p_order_id;
  if not found or not public.is_business_admin(target_business) then raise exception 'order unavailable' using errcode='42501'; end if;
  perform customer_lifecycle_private.lock_account(target_customer);
  perform 1 from public.businesses where id=target_business for share;
  select * into o from public.orders where id=p_order_id for update;
  if not found then raise exception 'order unavailable' using errcode='42501'; end if;
  -- Lock the membership so revocation and transition cannot race.
  select m.display_name into actor from public.business_memberships m where m.business_id=o.business_id and m.user_id=caller and m.role='admin' for share;
  if not found then raise exception 'order unavailable' using errcode='42501'; end if;
  if p_expected_version is null or p_expected_version <> o.version then raise exception 'order version conflict' using errcode='40001'; end if;
  if not ((o.status='placed' and p_status in ('accepted','cancelled')) or
          (o.status='accepted' and p_status in ('preparing','cancelled')) or
          (o.status='preparing' and p_status in ('out_for_delivery','cancelled')) or
          (o.status='out_for_delivery' and p_status='delivered')) then
    raise exception 'invalid order transition' using errcode='22023';
  end if;
  update public.orders set status=p_status, version=version+1 where id=o.id returning * into o;
  insert into public.order_status_history(order_id,status,changed_by) values(o.id,o.status,caller) returning id into step;
  insert into public.order_status_actors(history_id,business_id,actor_id,actor_name) values(step,o.business_id,caller,actor);
  return jsonb_build_object('id',o.id,'business_id',o.business_id,'status',o.status,'version',o.version,'subtotal_paise',o.subtotal_paise,'delivery_fee_paise',o.delivery_fee_paise,'total_paise',o.total_paise,'created_at',o.created_at);
end $$;


-- Owners: menu reordering.
create or replace function public.reorder_menu_items(p_business_slug text, p_category_id uuid, p_item_ids uuid[])
returns integer language plpgsql security definer set search_path = '' as $$
declare caller uuid := auth.uid(); business uuid; seen uuid[]; wanted uuid[];
begin
  if caller is null then raise exception 'authentication required' using errcode='42501'; end if;
  perform customer_lifecycle_private.require_active_session(caller);
  select b.id into business from public.businesses b where b.slug=p_business_slug;
  if not found then raise exception 'menu unavailable' using errcode='42501'; end if;
  perform 1 from public.business_memberships where business_id=business and user_id=caller and role='admin' for share;
  if not found then raise exception 'menu unavailable' using errcode='42501'; end if;
  if p_item_ids is null or array_position(p_item_ids, null) is not null
     or cardinality(p_item_ids) <> (select count(distinct x) from unnest(p_item_ids) x) then
    raise exception 'list each dish exactly once' using errcode='22023';
  end if;
  -- Locking the category blocks dishes being added to or moved into it.
  perform 1 from public.menu_categories where id=p_category_id and business_id=business for update;
  if not found then raise exception 'menu changed' using errcode='40001'; end if;
  select coalesce(array_agg(id order by id), '{}') into seen from
    (select m.id from public.menu_items m where m.business_id=business and m.category_id=p_category_id for update) locked;
  select coalesce(array_agg(x order by x), '{}') into wanted from unnest(p_item_ids) x;
  if seen <> wanted then raise exception 'menu changed' using errcode='40001'; end if;
  update public.menu_items m set sort_order=o.position - 1
  from unnest(p_item_ids) with ordinality o(id, position)
  where m.id=o.id and m.business_id=business and m.sort_order <> o.position - 1;
  return cardinality(p_item_ids);
end $$;


create or replace function public.reorder_menu_categories(p_business_slug text, p_category_ids uuid[])
returns integer language plpgsql security definer set search_path = '' as $$
declare caller uuid := auth.uid(); business uuid; seen uuid[]; wanted uuid[];
begin
  if caller is null then raise exception 'authentication required' using errcode='42501'; end if;
  perform customer_lifecycle_private.require_active_session(caller);
  select b.id into business from public.businesses b where b.slug=p_business_slug;
  if not found then raise exception 'menu unavailable' using errcode='42501'; end if;
  perform 1 from public.business_memberships where business_id=business and user_id=caller and role='admin' for share;
  if not found then raise exception 'menu unavailable' using errcode='42501'; end if;
  if p_category_ids is null or array_position(p_category_ids, null) is not null
     or cardinality(p_category_ids) <> (select count(distinct x) from unnest(p_category_ids) x) then
    raise exception 'list each category exactly once' using errcode='22023';
  end if;
  -- Serialize category reorders per business without locking the business row,
  -- which checkout holds while placing orders.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('menu_categories:' || business::text, 0));
  select coalesce(array_agg(id order by id), '{}') into seen from
    (select c.id from public.menu_categories c where c.business_id=business for update) locked;
  select coalesce(array_agg(x order by x), '{}') into wanted from unnest(p_category_ids) x;
  if seen <> wanted then raise exception 'menu changed' using errcode='40001'; end if;
  update public.menu_categories c set sort_order=o.position - 1
  from unnest(p_category_ids) with ordinality o(id, position)
  where c.id=o.id and c.business_id=business and c.sort_order <> o.position - 1;
  return cardinality(p_category_ids);
end $$;

-- Customers: notification read markers.
create or replace function public.mark_customer_notification_read(p_business_slug text, p_notification_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare caller uuid := auth.uid(); business uuid;
begin
  if caller is null then raise exception 'authentication required' using errcode='42501'; end if;
  perform customer_lifecycle_private.require_active_session(caller);
  if p_notification_id is null then raise exception 'notification required' using errcode='22023'; end if;
  select id into business from public.businesses where slug=p_business_slug;
  if business is null then raise exception 'invalid restaurant' using errcode='22023'; end if;
  update public.customer_notifications set read_at=coalesce(read_at,clock_timestamp())
    where id=p_notification_id and user_id=caller and business_id=business
      and not public.is_business_admin(business) and created_at >= now()-interval '30 days';
  return found;
end $$;

create or replace function public.mark_all_customer_notifications_read(p_business_slug text)
returns integer language plpgsql security definer set search_path = '' as $$
declare caller uuid := auth.uid(); business uuid; changed integer;
begin
  if caller is null then raise exception 'authentication required' using errcode='42501'; end if;
  perform customer_lifecycle_private.require_active_session(caller);
  select id into business from public.businesses where slug=p_business_slug;
  if business is null then raise exception 'invalid restaurant' using errcode='22023'; end if;
  update public.customer_notifications set read_at=clock_timestamp()
    where user_id=caller and business_id=business and not public.is_business_admin(business)
      and read_at is null and created_at >= now()-interval '30 days';
  get diagnostics changed = row_count;
  return changed;
end $$;
