-- #48 Phase A: customer-owned saved addresses shared by both restaurant apps,
-- per-restaurant kitchen point, and checkout by saved pin with an immutable
-- per-order address snapshot. The previous typed-address + fresh-GPS checkout
-- keeps working until the customer apps move to saved addresses.
begin;

-- Restaurant kitchen point (WGS84) for "N km from the restaurant". Public, like
-- the rest of the business row; null until the owner supplies it.
do $$ declare ns text; begin
  select n.nspname into strict ns from pg_catalog.pg_extension e
    join pg_catalog.pg_namespace n on n.oid = e.extnamespace where e.extname = 'postgis';
  execute format('alter table public.businesses add column kitchen_location %I.geometry(Point,4326)', ns);
  execute format('alter table public.businesses add constraint valid_kitchen_location check (kitchen_location is null or (not %1$I.st_isempty(kitchen_location) and %1$I.st_y(kitchen_location) between -90 and 90 and %1$I.st_x(kitchen_location) between -180 and 180))', ns);
end $$;

-- No business_id: one customer's addresses serve both apps. No PIN code (13 Nov decision).
-- Text refuses control, zero-width and direction-override characters (ZWJ/ZWNJ stay for Indic scripts).
create table public.customer_addresses (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  label text not null check (label in ('home','work','other')),
  custom_label text check (custom_label is null or (label = 'other' and length(custom_label) between 1 and 40 and custom_label !~ '[[:cntrl:]\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]')),
  house text not null check (length(house) between 1 and 120 and house !~ '[[:cntrl:]\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]'),
  street_area text not null check (length(street_area) between 1 and 200 and street_area !~ '[[:cntrl:]\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]'),
  landmark text check (landmark is null or (length(landmark) between 1 and 120 and landmark !~ '[[:cntrl:]\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]')),
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  location_source text not null check (location_source in ('gps','pin')),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index customer_addresses_owner on public.customer_addresses (customer_id, updated_at desc);

-- Normalise text, keep identity fixed, and bump the version on every edit so a
-- checkout opened on an older version is refused rather than silently changed.
create function public.prepare_customer_address() returns trigger language plpgsql set search_path = '' as $$
declare kept integer;
begin
  new.custom_label := nullif(trim(new.custom_label), '');
  new.house := trim(new.house);
  new.street_area := trim(new.street_area);
  new.landmark := nullif(trim(new.landmark), '');
  if tg_op = 'INSERT' then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('customer_addresses:' || new.customer_id::text, 0));
    select count(*) into kept from public.customer_addresses where customer_id = new.customer_id;
    if kept >= 20 then raise exception 'saved address limit reached' using errcode = '23514'; end if;
    new.version := 1; new.created_at := now(); new.updated_at := new.created_at;
  else
    if new.id is distinct from old.id or new.customer_id is distinct from old.customer_id then
      raise exception 'address owner is immutable' using errcode = '22023';
    end if;
    new.version := old.version + 1; new.created_at := old.created_at; new.updated_at := now();
  end if;
  return new;
end $$;
revoke all on function public.prepare_customer_address() from public, anon, authenticated;
create trigger prepare_customer_address before insert or update on public.customer_addresses
  for each row execute function public.prepare_customer_address();

alter table public.customer_addresses enable row level security;
create policy customer_addresses_own_select on public.customer_addresses for select to authenticated using (customer_id = auth.uid());
create policy customer_addresses_own_insert on public.customer_addresses for insert to authenticated with check (customer_id = auth.uid());
create policy customer_addresses_own_update on public.customer_addresses for update to authenticated using (customer_id = auth.uid()) with check (customer_id = auth.uid());
create policy customer_addresses_own_delete on public.customer_addresses for delete to authenticated using (customer_id = auth.uid());
revoke all on public.customer_addresses from public, anon, authenticated;
-- customer_id, version and timestamps are not writable: the default and trigger own them.
grant select, delete on public.customer_addresses to authenticated;
grant insert (label, custom_label, house, street_area, landmark, latitude, longitude, location_source),
  update (label, custom_label, house, street_area, landmark, latitude, longitude, location_source)
  on public.customer_addresses to authenticated;
grant all on public.customer_addresses to service_role;

-- Deliberately not in the realtime publication: Supabase does not apply RLS to
-- DELETE events, which would tell every subscriber other customers' address ids.
-- The apps reload the list when it is shown instead.

-- SECURITY DEFINER (PostGIS may live in a schema callers cannot use), so the
-- caller filter is explicit: a restaurant admin gets only their own addresses as
-- a customer, never their customers'. in_area fails closed for unverified areas.
create function public.list_addresses(p_business_slug text)
returns table (id uuid, label text, custom_label text, house text, street_area text, landmark text,
  latitude double precision, longitude double precision, location_source text, version integer,
  updated_at timestamptz, in_area boolean, distance_m integer)
language plpgsql stable security definer set search_path = '' as $$
declare b public.businesses%rowtype; ns text; area_ok boolean;
begin
  if auth.uid() is null then return; end if;
  select * into b from public.businesses where slug = p_business_slug;
  if not found then raise exception 'business unavailable' using errcode = '22023'; end if;
  area_ok := b.ordering_enabled and b.service_area is not null and b.service_area_verified_at is not null
    and nullif(trim(b.service_area_source), '') is not null and nullif(trim(b.service_area_version), '') is not null;
  select n.nspname into strict ns from pg_catalog.pg_extension e
    join pg_catalog.pg_namespace n on n.oid = e.extnamespace where e.extname = 'postgis';
  return query execute format($q$
    select a.id, a.label, a.custom_label, a.house, a.street_area, a.landmark, a.latitude, a.longitude,
      a.location_source, a.version, a.updated_at,
      coalesce($2 and %1$I.st_covers($3::%1$I.geography, p.point), false),
      case when $4 is null then null else round(%1$I.st_distance($4::%1$I.geography, p.point))::integer end
    from public.customer_addresses a
    cross join lateral (select %1$I.st_setsrid(%1$I.st_makepoint(a.longitude, a.latitude), 4326)::%1$I.geography as point) p
    where a.customer_id = $1
    order by a.updated_at desc, a.id
  $q$, ns) using auth.uid(), area_ok, b.service_area, b.kitchen_location;
end $$;
revoke all on function public.list_addresses(text) from public, anon, authenticated;
grant execute on function public.list_addresses(text) to authenticated;

-- Immutable copy of the address the order was placed with, and the phone's
-- distance from that pin at order time (null when unknown) for the owners' flag.
alter table public.orders
  add column address_label text check (address_label is null or address_label in ('home','work','other')),
  add column address_custom_label text,
  add column address_house text,
  add column address_street_area text,
  add column address_landmark text,
  add column address_location_source text check (address_location_source is null or address_location_source in ('gps','pin')),
  add column saved_address_id uuid,
  add column saved_address_version integer check (saved_address_version is null or saved_address_version > 0),
  add column placed_from_distance_m integer check (placed_from_distance_m is null or placed_from_distance_m >= 0),
  alter column location_accuracy drop not null,
  alter column location_captured_at drop not null;
-- Older orders keep their GPS evidence; saved-address orders keep a complete snapshot.
alter table public.orders add constraint order_address_evidence check (
  (saved_address_id is null and location_accuracy is not null and location_captured_at is not null)
  or (saved_address_id is not null and saved_address_version is not null and address_label is not null
      and address_house is not null and address_street_area is not null and address_location_source is not null));

-- Same six-argument accepted-pricing contract (no new overload). A delivery with
-- address_id/address_version uses the saved pin; the phone fix becomes optional
-- and only measures distance. Without address_id the previous rules apply.
create or replace function public.place_order(p_business_slug text, p_items jsonb, p_delivery jsonb, p_location jsonb, p_idempotency_key uuid, p_accepted_pricing jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid(); b public.businesses%rowtype; existing public.orders%rowtype;
  item jsonb; menu public.menu_items%rowtype; item_id uuid; qty integer;
  subtotal bigint := 0; total bigint; order_id uuid := gen_random_uuid(); request_digest text;
  crypto_schema text; rejected public.checkout_pricing_rejections%rowtype; quote jsonb; quote_lines jsonb := '[]'::jsonb; seen uuid[] := array[]::uuid[];
  saved boolean; addr public.customer_addresses%rowtype; spatial_schema text; covered boolean;
  phone_lat double precision; phone_lon double precision; phone_at timestamptz; phone_distance double precision;
begin
  if caller is null or p_idempotency_key is null then raise exception 'authentication and idempotency key required' using errcode='22023'; end if;
  select * into b from public.businesses where slug=p_business_slug for share;
  if not found then raise exception 'business unavailable' using errcode='22023'; end if;
  select n.nspname into strict crypto_schema from pg_catalog.pg_extension e
    join pg_catalog.pg_namespace n on n.oid=e.extnamespace where e.extname='pgcrypto';
  -- The digest covers address_id/address_version inside p_delivery.
  execute format('select pg_catalog.encode(%I.digest($1, ''sha256''), ''hex'')', crypto_schema)
    into request_digest using jsonb_build_object('business',p_business_slug,'items',p_items,'delivery',p_delivery,'location',p_location,'accepted_pricing',p_accepted_pricing)::text;
  -- Serialize even simultaneous first attempts before checking the unique key.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(caller::text || ':' || b.id::text || ':' || p_idempotency_key::text, 0));
  -- Replays come first: a retry returns the original order even if the saved
  -- address was edited or deleted afterwards.
  select * into existing from public.orders where customer_id=caller and business_id=b.id and idempotency_key=p_idempotency_key;
  if found then
    if existing.request_hash <> request_digest then raise exception 'idempotency key reused with different request' using errcode='22023'; end if;
    return jsonb_build_object('outcome','placed','id',existing.id,'order_number',existing.order_number,'business_id',existing.business_id,'status',existing.status,'version',existing.version,'subtotal_paise',existing.subtotal_paise,'delivery_fee_paise',existing.delivery_fee_paise,'total_paise',existing.total_paise,'created_at',existing.created_at);
  end if;
  select * into rejected from public.checkout_pricing_rejections where customer_id=caller and business_id=b.id and idempotency_key=p_idempotency_key;
  if found then
    if rejected.request_hash <> request_digest then raise exception 'idempotency key reused with different request' using errcode='22023'; end if;
    return jsonb_build_object('outcome','pricing_changed','pricing',rejected.pricing);
  end if;
  if not b.accepting_orders then
    -- PT409: PostgREST answers HTTP 409 rather than a server error.
    raise exception 'restaurant is not accepting orders' using errcode='PT409';
  end if;
  saved := jsonb_typeof(p_delivery) = 'object' and p_delivery ? 'address_id';
  if saved then
    if coalesce(length(trim(p_delivery->>'name')),0) not between 1 and 120 or
       coalesce(length(trim(p_delivery->>'phone')),0) not between 1 and 40 or
       p_delivery ? 'address_line' or
       coalesce(p_delivery->>'address_id','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' or
       coalesce(p_delivery->>'address_version','') !~ '^[1-9][0-9]{0,8}$' then
      raise exception 'invalid delivery details' using errcode='22023';
    end if;
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
  else
    if not coalesce((public.check_delivery_eligibility(p_business_slug,p_location)->>'eligible')::boolean,false) then
      raise exception 'delivery unavailable' using errcode='22023';
    end if;
    if jsonb_typeof(p_delivery) is distinct from 'object' or
       coalesce(length(trim(p_delivery->>'name')),0) not between 1 and 120 or
       coalesce(length(trim(p_delivery->>'phone')),0) not between 1 and 40 or
       coalesce(length(trim(p_delivery->>'address_line')),0) not between 1 and 500 then
      raise exception 'invalid delivery details' using errcode='22023';
    end if;
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
    quote_lines := quote_lines || jsonb_build_array(jsonb_build_object('menu_item_id',menu.id,'quantity',qty,'unit_price_paise',menu.price_paise,'line_total_paise',menu.price_paise::bigint*qty));
  end loop;
  total := subtotal + b.delivery_fee_paise;
  quote := jsonb_build_object('lines',quote_lines,'delivery_fee_paise',b.delivery_fee_paise,'min_order_paise',b.min_order_paise,'subtotal_paise',subtotal,'total_paise',total);
  if total > 2147483647 then raise exception 'invalid order total' using errcode='22023'; end if;
  if p_accepted_pricing is distinct from quote then
    -- A changed quote creates no order. Replaying its key remains a rejection,
    -- even if menu prices later return to the previously accepted values.
    insert into public.checkout_pricing_rejections(customer_id,business_id,idempotency_key,request_hash,pricing)
      values(caller,b.id,p_idempotency_key,request_digest,quote);
    return jsonb_build_object('outcome','pricing_changed','pricing',quote);
  end if;
  if subtotal < b.min_order_paise or total > 2147483647 then raise exception 'invalid order total' using errcode='22023'; end if;
  if saved then
    insert into public.orders(id,business_id,customer_id,customer_name,customer_phone,delivery_address_line,latitude,longitude,
      address_label,address_custom_label,address_house,address_street_area,address_landmark,address_location_source,
      saved_address_id,saved_address_version,placed_from_distance_m,subtotal_paise,delivery_fee_paise,total_paise,idempotency_key,request_hash)
    values(order_id,b.id,caller,trim(p_delivery->>'name'),trim(p_delivery->>'phone'),
      concat_ws(', ',addr.house,addr.street_area,addr.landmark),addr.latitude,addr.longitude,
      addr.label,addr.custom_label,addr.house,addr.street_area,addr.landmark,addr.location_source,
      addr.id,addr.version,round(phone_distance)::integer,subtotal::integer,b.delivery_fee_paise,total::integer,p_idempotency_key,request_digest)
    returning * into existing;
  else
    insert into public.orders(id,business_id,customer_id,customer_name,customer_phone,delivery_address_line,latitude,longitude,location_accuracy,location_captured_at,subtotal_paise,delivery_fee_paise,total_paise,idempotency_key,request_hash)
    values(order_id,b.id,caller,trim(p_delivery->>'name'),trim(p_delivery->>'phone'),trim(p_delivery->>'address_line'),(p_location->>'latitude')::double precision,(p_location->>'longitude')::double precision,(p_location->>'accuracy')::double precision,(p_location->>'captured_at')::timestamptz,subtotal::integer,b.delivery_fee_paise,total::integer,p_idempotency_key,request_digest)
    returning * into existing;
  end if;
  for item in select value from jsonb_array_elements(p_items) loop
    select * into strict menu from public.menu_items where id=(item->>'menu_item_id')::uuid;
    qty := (item->>'quantity')::integer;
    insert into public.order_items(order_id,menu_item_id,name,unit_price_paise,quantity,line_total_paise,diet)
      values(order_id,menu.id,menu.name,menu.price_paise,qty,menu.price_paise::bigint*qty,menu.diet);
  end loop;
  insert into public.order_status_history(order_id,status,changed_by) values(order_id,'placed',caller);
  return jsonb_build_object('outcome','placed','id',existing.id,'order_number',existing.order_number,'business_id',existing.business_id,'status',existing.status,'version',existing.version,'subtotal_paise',existing.subtotal_paise,'delivery_fee_paise',existing.delivery_fee_paise,'total_paise',existing.total_paise,'created_at',existing.created_at);
end $$;
revoke all on function public.place_order(text,jsonb,jsonb,jsonb,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.place_order(text,jsonb,jsonb,jsonb,uuid,jsonb) to authenticated;

commit;
