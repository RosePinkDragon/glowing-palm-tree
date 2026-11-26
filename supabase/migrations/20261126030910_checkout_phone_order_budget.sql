-- Preserve the active-session implementation and lock order; only the recipient phone predicate changes.
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
     (coalesce(char_length(p_delivery->>'phone'),0) not between 1 and 40 or coalesce(p_delivery->>'phone', '') !~ '^[[:space:]]*\+?[0-9[:space:]().-]+$' or coalesce(pg_catalog.regexp_replace(p_delivery->>'phone', '[[:space:]().-]', '', 'g'), '') !~ '^(\+91|91|0)?[6-9][0-9]{9}$') or
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

-- Checkout already holds the caller's account row lock before reaching the order insert.
-- This trigger sorts before assign_order_number, so direct inserts lock the account before the order counter.
-- Reacquiring the account lock is a no-op for checkout and serializes privileged insert paths too.
-- Replayed keys return before INSERT, and all side effects roll back with a refused insert.
create index orders_checkout_budget_idx on public.orders(customer_id, business_id, created_at desc);

create function offers_private.enforce_order_budget() returns trigger
language plpgsql security definer set search_path = '' as $$
declare cutoff timestamptz;
begin
  perform customer_lifecycle_private.lock_account(new.customer_id);
  cutoff := pg_catalog.clock_timestamp() - interval '1 hour';
  if (select count(*) from public.orders o
      where o.customer_id = new.customer_id and o.business_id = new.business_id
        and o.created_at > cutoff) >= 20 then
    raise exception 'order submission limit reached' using errcode = 'PT429', detail = 'ORDER_RATE_LIMITED';
  end if;
  return new;
end $$;
revoke all on function offers_private.enforce_order_budget() from public, anon, authenticated, service_role;
create trigger a0_checkout_order_budget before insert on public.orders
for each row execute function offers_private.enforce_order_budget();
