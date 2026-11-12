-- Only trusted database functions may write orders. Location is evidence for
-- eligibility, not proof that a person is physically present.
create function public.check_delivery_eligibility(p_business_slug text, p_location jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  b public.businesses%rowtype; spatial_schema text; lat double precision; lon double precision;
  accuracy_m double precision; captured timestamptz; covered boolean;
begin
  if auth.uid() is null or jsonb_typeof(p_location) <> 'object' then return jsonb_build_object('eligible', false); end if;
  select * into b from public.businesses where slug = p_business_slug;
  if not found or not b.ordering_enabled or b.service_area is null or b.service_area_verified_at is null
     or nullif(trim(b.service_area_source), '') is null or nullif(trim(b.service_area_version), '') is null then
    return jsonb_build_object('eligible', false);
  end if;
  lat := (p_location->>'latitude')::double precision;
  lon := (p_location->>'longitude')::double precision;
  accuracy_m := (p_location->>'accuracy')::double precision;
  captured := (p_location->>'captured_at')::timestamptz;
  if lat is null or lon is null or accuracy_m is null or captured is null
     or lat not between -90 and 90 or lon not between -180 and 180
     or accuracy_m < 1 or accuracy_m > 100
     or captured < clock_timestamp() - interval '5 minutes'
     or captured > clock_timestamp() + interval '30 seconds' then
    return jsonb_build_object('eligible', false);
  end if;
  select n.nspname into strict spatial_schema from pg_catalog.pg_extension e
    join pg_catalog.pg_namespace n on n.oid = e.extnamespace where e.extname = 'postgis';
  -- The center must be covered and its spheroidal distance to every zone
  -- boundary (including holes) must be at least the accuracy radius in metres.
  -- This avoids accepting the gaps between a buffered polygon's chords.
  execute format('select %1$I.st_covers($1::%1$I.geography, point) and %1$I.st_distance(point, %1$I.st_boundary($1)::%1$I.geography) >= $4 from (select %1$I.st_setsrid(%1$I.st_makepoint($2,$3),4326)::%1$I.geography as point) p', spatial_schema)
    into covered using b.service_area, lon, lat, accuracy_m;
  return jsonb_build_object('eligible', coalesce(covered, false));
exception when others then
  -- Invalid input and any geospatial failure deny eligibility.
  return jsonb_build_object('eligible', false);
end $$;

create function public.place_order(p_business_slug text, p_items jsonb, p_delivery jsonb, p_location jsonb, p_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid(); b public.businesses%rowtype; existing public.orders%rowtype;
  item jsonb; menu public.menu_items%rowtype; item_id uuid; qty integer;
  subtotal bigint := 0; total bigint; order_id uuid := gen_random_uuid(); request_digest text;
  crypto_schema text; seen uuid[] := array[]::uuid[];
begin
  if caller is null or p_idempotency_key is null then raise exception 'authentication and idempotency key required' using errcode='22023'; end if;
  select * into b from public.businesses where slug=p_business_slug for share;
  if not found then raise exception 'business unavailable' using errcode='22023'; end if;
  select n.nspname into strict crypto_schema from pg_catalog.pg_extension e
    join pg_catalog.pg_namespace n on n.oid=e.extnamespace where e.extname='pgcrypto';
  execute format('select pg_catalog.encode(%I.digest($1, ''sha256''), ''hex'')', crypto_schema)
    into request_digest using jsonb_build_object('business',p_business_slug,'items',p_items,'delivery',p_delivery,'location',p_location)::text;
  -- Serialize even simultaneous first attempts before checking the unique key.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(caller::text || ':' || b.id::text || ':' || p_idempotency_key::text, 0));
  select * into existing from public.orders where customer_id=caller and business_id=b.id and idempotency_key=p_idempotency_key;
  if found then
    if existing.request_hash <> request_digest then raise exception 'idempotency key reused with different request' using errcode='22023'; end if;
    return jsonb_build_object('id',existing.id,'business_id',existing.business_id,'status',existing.status,'version',existing.version,'subtotal_paise',existing.subtotal_paise,'delivery_fee_paise',existing.delivery_fee_paise,'total_paise',existing.total_paise,'created_at',existing.created_at);
  end if;
  if not coalesce((public.check_delivery_eligibility(p_business_slug,p_location)->>'eligible')::boolean,false) then
    raise exception 'delivery unavailable' using errcode='22023';
  end if;
  if jsonb_typeof(p_delivery) is distinct from 'object' or
     coalesce(length(trim(p_delivery->>'name')),0) not between 1 and 120 or
     coalesce(length(trim(p_delivery->>'phone')),0) not between 1 and 40 or
     coalesce(length(trim(p_delivery->>'address_line')),0) not between 1 and 500 then
    raise exception 'invalid delivery details' using errcode='22023';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' then raise exception 'invalid items' using errcode='22023'; end if;
  if jsonb_array_length(p_items) not between 1 and 20 then raise exception 'invalid items' using errcode='22023'; end if;
  for item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(item) is distinct from 'object' or coalesce(item->>'menu_item_id','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' or
      coalesce(item->>'quantity','') !~ '^[1-9][0-9]?$' then raise exception 'invalid item' using errcode='22023'; end if;
    item_id := (item->>'menu_item_id')::uuid; qty := (item->>'quantity')::integer;
    if qty > 10 or item_id = any(seen) then raise exception 'invalid item quantity or duplicate' using errcode='22023'; end if;
    seen := array_append(seen,item_id);
    select * into menu from public.menu_items where id=item_id and business_id=b.id and available for share;
    if not found then raise exception 'item unavailable' using errcode='22023'; end if;
    subtotal := subtotal + menu.price_paise::bigint * qty;
  end loop;
  total := subtotal + b.delivery_fee_paise;
  if subtotal < b.min_order_paise or total > 2147483647 then raise exception 'invalid order total' using errcode='22023'; end if;
  insert into public.orders(id,business_id,customer_id,customer_name,customer_phone,delivery_address_line,latitude,longitude,location_accuracy,location_captured_at,subtotal_paise,delivery_fee_paise,total_paise,idempotency_key,request_hash)
  values(order_id,b.id,caller,trim(p_delivery->>'name'),trim(p_delivery->>'phone'),trim(p_delivery->>'address_line'),(p_location->>'latitude')::double precision,(p_location->>'longitude')::double precision,(p_location->>'accuracy')::double precision,(p_location->>'captured_at')::timestamptz,subtotal::integer,b.delivery_fee_paise,total::integer,p_idempotency_key,request_digest)
  returning * into existing;
  for item in select value from jsonb_array_elements(p_items) loop
    select * into strict menu from public.menu_items where id=(item->>'menu_item_id')::uuid;
    qty := (item->>'quantity')::integer;
    insert into public.order_items(order_id,menu_item_id,name,unit_price_paise,quantity,line_total_paise)
      values(order_id,menu.id,menu.name,menu.price_paise,qty,menu.price_paise::bigint*qty);
  end loop;
  insert into public.order_status_history(order_id,status,changed_by) values(order_id,'placed',caller);
  return jsonb_build_object('id',existing.id,'business_id',existing.business_id,'status',existing.status,'version',existing.version,'subtotal_paise',existing.subtotal_paise,'delivery_fee_paise',existing.delivery_fee_paise,'total_paise',existing.total_paise,'created_at',existing.created_at);
end $$;

create function public.transition_order(p_order_id uuid, p_status text, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare o public.orders%rowtype; caller uuid := auth.uid();
begin
  if caller is null then raise exception 'authentication required' using errcode='42501'; end if;
  select * into o from public.orders where id=p_order_id for update;
  if not found then raise exception 'order unavailable' using errcode='42501'; end if;
  -- Lock the membership so revocation and transition cannot race.
  perform 1 from public.business_memberships where business_id=o.business_id and user_id=caller and role='admin' for share;
  if not found then raise exception 'order unavailable' using errcode='42501'; end if;
  if p_expected_version is null or p_expected_version <> o.version then raise exception 'order version conflict' using errcode='40001'; end if;
  if not ((o.status='placed' and p_status in ('accepted','cancelled')) or
          (o.status='accepted' and p_status in ('preparing','cancelled')) or
          (o.status='preparing' and p_status in ('out_for_delivery','cancelled')) or
          (o.status='out_for_delivery' and p_status='delivered')) then
    raise exception 'invalid order transition' using errcode='22023';
  end if;
  update public.orders set status=p_status, version=version+1 where id=o.id returning * into o;
  insert into public.order_status_history(order_id,status,changed_by) values(o.id,o.status,caller);
  return jsonb_build_object('id',o.id,'business_id',o.business_id,'status',o.status,'version',o.version,'subtotal_paise',o.subtotal_paise,'delivery_fee_paise',o.delivery_fee_paise,'total_paise',o.total_paise,'created_at',o.created_at);
end $$;
revoke all on function public.check_delivery_eligibility(text,jsonb), public.place_order(text,jsonb,jsonb,jsonb,uuid), public.transition_order(uuid,text,integer) from public, anon, authenticated;
grant execute on function public.check_delivery_eligibility(text,jsonb), public.place_order(text,jsonb,jsonb,jsonb,uuid), public.transition_order(uuid,text,integer) to authenticated;
