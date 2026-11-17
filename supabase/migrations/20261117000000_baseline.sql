-- Pre-release baseline (issue #131): the complete schema of glowing-palm-tree in one migration.
--
-- This replaces the 17 development migrations that preceded it. No migration for this application
-- has been applied to any persistent or shared database; until the first persistent deployment,
-- schema changes are folded into this file (see docs/RELEASE.md, "Migration policy"). After the
-- first deployment this file is frozen and later changes are forward-only migrations.
--
-- Sections, in dependency order:
--   1 extensions, schemas, types      6 triggers
--   2 tables and constraints          7 row-level security and policies
--   3 indexes                         8 grants and revokes
--   4 row-level security switches     9 realtime publication
--   5 functions                      10 storage bucket and policy
--
-- Not here on purpose: restaurant rows, kitchen points and delivery areas. They are data, not
-- schema, so a fresh project has none (checkout fails closed without a verified area). Trusted
-- setup supplies them; see docs/RELEASE.md. supabase/seed.sql holds demonstration data only.
--
-- The typed-address checkout (a free-text address plus a fresh phone fix) is deliberately absent:
-- place_order accepts saved addresses only, and orders carry no GPS-fix columns.

-- 1. Extensions, schemas, types ----------------------------------------------------------------
-- Tenant data is private by default. Service-role operations bypass RLS in Supabase.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
-- PostGIS may already be installed in another schema on an existing project; every use below
-- looks its schema up in pg_extension.
create extension if not exists postgis with schema extensions;

create schema menu_photo_private;
revoke all on schema menu_photo_private from public, anon, authenticated;

create type public.diet_classification as enum ('veg', 'non_veg', 'egg');

-- 2. Tables and constraints --------------------------------------------------------------------
create table public.businesses (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text not null,
  delivery_fee_paise integer not null default 0 check (delivery_fee_paise >= 0),
  min_order_paise integer not null default 0 check (min_order_paise >= 0),
  is_demo boolean not null default false,
  -- ordering_enabled: developer-controlled "set up to take orders" switch. accepting_orders: the
  -- owner's open/closed switch (set_accepting_orders). Customers can order only when both are true.
  ordering_enabled boolean not null default false,
  accepting_orders boolean not null default false,
  service_area_source text,
  service_area_version text,
  service_area_verified_at timestamptz,
  -- Order numbers look like AMS-2026110001. The prefix is immutable once rows exist (trigger below).
  order_prefix text not null constraint business_order_prefix_format check (order_prefix ~ '^[A-Z][A-Z0-9]{1,9}$')
    constraint business_order_prefix_unique unique,
  -- Contact values are intentionally unconfigured until the owners supply them.
  contact_phone text check (contact_phone is null or contact_phone ~ '^\+[1-9][0-9]{7,14}$'),
  created_at timestamptz not null default now()
);
do $$
declare spatial_schema text;
begin
  select n.nspname into strict spatial_schema from pg_catalog.pg_extension e
    join pg_catalog.pg_namespace n on n.oid = e.extnamespace where e.extname = 'postgis';
  execute format('alter table public.businesses add column service_area %I.geometry(MultiPolygon,4326)', spatial_schema);
  execute format('alter table public.businesses add constraint valid_service_area check (service_area is null or (not %I.st_isempty(service_area) and %I.st_isvalid(service_area)))', spatial_schema, spatial_schema);
  -- Restaurant kitchen point (WGS84) for "N km from the restaurant". Public, like the rest of the
  -- business row; null until trusted setup supplies it.
  execute format('alter table public.businesses add column kitchen_location %I.geometry(Point,4326)', spatial_schema);
  execute format('alter table public.businesses add constraint valid_kitchen_location check (kitchen_location is null or (not %1$I.st_isempty(kitchen_location) and %1$I.st_y(kitchen_location) between -90 and 90 and %1$I.st_x(kitchen_location) between -180 and 180))', spatial_schema);
end $$;
alter table public.businesses add constraint ordering_requires_verified_area check (
  not ordering_enabled or (service_area is not null and service_area_source is not null and
    length(trim(service_area_source)) > 0 and service_area_version is not null and
    length(trim(service_area_version)) > 0 and service_area_verified_at is not null)
);

create table public.business_memberships (
  business_id uuid not null references public.businesses(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('admin')),
  created_at timestamptz not null default now(),
  -- Names exclude control, invisible spacing and bidi-override characters (ZWJ/ZWNJ stay allowed for Marathi).
  display_name text not null default 'Owner',
  primary key (business_id, user_id),
  constraint membership_display_name_valid check (
    display_name = btrim(display_name) and char_length(display_name) between 1 and 60
    and display_name !~ '[[:cntrl:]\u00A0\u00AD\u2000-\u200B\u200E\u200F\u2028-\u202F\u205F\u2060\u2066-\u2069\u3000\uFEFF]')
);

-- Categories are public catalog data; membership controls every owner mutation.
create table public.menu_categories (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id),
  name text not null check (name = btrim(name) and char_length(name) between 1 and 100),
  sort_order integer not null default 0,
  unique (business_id, name),
  unique (business_id, id)
);

create table public.menu_items (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id),
  name text not null, description text,
  price_paise integer not null check (price_paise > 0),
  available boolean not null default true, is_demo boolean not null default false,
  -- image_url is an immutable-version *bucket-relative* card path, never an arbitrary URL.
  image_url text, created_at timestamptz not null default now(),
  -- Owners classify dishes explicitly. Unknown setup data may remain NULL.
  diet public.diet_classification,
  is_featured boolean not null default false,
  sort_order integer not null default 0,
  category_id uuid not null,
  unique (business_id, id),
  constraint menu_items_category_business_fk foreign key (business_id, category_id)
    references public.menu_categories(business_id, id) on update restrict on delete restrict
);

-- Customer-owned saved addresses shared by both restaurant apps. No business_id: one customer's
-- addresses serve both apps. No PIN code. Text refuses control, zero-width and direction-override
-- characters (ZWJ/ZWNJ stay for Indic scripts).
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

-- Orders carry an immutable copy of the saved address they were placed with (address_* columns,
-- saved_address_id/version, no foreign key so deleting the address never alters the order) and the
-- phone's distance from that pin at order time (null when unknown) for the owners' flag.
-- order_number is assigned by the assign_order_number trigger.
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id),
  customer_id uuid not null references auth.users(id),
  status text not null default 'placed' check (status in ('placed','accepted','preparing','out_for_delivery','delivered','cancelled')),
  version integer not null default 1 check (version > 0),
  customer_name text not null, customer_phone text not null, delivery_address_line text not null,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  subtotal_paise integer not null check (subtotal_paise >= 0),
  delivery_fee_paise integer not null check (delivery_fee_paise >= 0),
  total_paise integer not null check (total_paise = subtotal_paise + delivery_fee_paise),
  idempotency_key uuid not null, request_hash text not null,
  created_at timestamptz not null default now(),
  order_number text not null,
  address_label text check (address_label is null or address_label in ('home','work','other')),
  address_custom_label text,
  address_house text,
  address_street_area text,
  address_landmark text,
  address_location_source text check (address_location_source is null or address_location_source in ('gps','pin')),
  saved_address_id uuid,
  saved_address_version integer check (saved_address_version is null or saved_address_version > 0),
  placed_from_distance_m integer check (placed_from_distance_m is null or placed_from_distance_m >= 0),
  unique (customer_id, business_id, idempotency_key), unique (business_id, id),
  constraint business_order_number_unique unique (business_id, order_number),
  constraint order_address_evidence check (saved_address_id is not null and saved_address_version is not null
    and address_label is not null and address_house is not null and address_street_area is not null
    and address_location_source is not null)
);
create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  menu_item_id uuid references public.menu_items(id),
  name text not null, unit_price_paise integer not null check (unit_price_paise > 0),
  quantity integer not null check (quantity > 0),
  line_total_paise bigint not null check (line_total_paise = unit_price_paise::bigint * quantity),
  diet public.diet_classification
);
create table public.order_status_history (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders(id) on delete cascade,
  status text not null check (status in ('placed','accepted','preparing','out_for_delivery','delivered','cancelled')),
  changed_by uuid references auth.users(id), created_at timestamptz not null default now()
);
-- Owner-only snapshots of the acting owner's name live beside, not inside, order_status_history:
-- customers can read their own history rows, and RLS cannot hide individual columns per audience.
-- actor_id has no foreign key so a snapshot outlives the membership and the account;
-- redact_owner_history_names clears both identifier and name.
create table public.order_status_actors (
  history_id bigint primary key references public.order_status_history(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  actor_id uuid,
  actor_name text not null constraint order_status_actor_name_valid check (
    actor_name = btrim(actor_name) and char_length(actor_name) between 1 and 60
    and actor_name !~ '[[:cntrl:]\u00A0\u00AD\u2000-\u200B\u200E\u200F\u2028-\u202F\u205F\u2060\u2066-\u2069\u3000\uFEFF]')
);
create table public.order_number_counters (
  business_id uuid not null references public.businesses(id),
  year_month text not null check (year_month ~ '^[0-9]{4}(0[1-9]|1[0-2])$'),
  last_number bigint not null check (last_number > 0),
  primary key (business_id, year_month)
);
-- Internal terminal rejections prevent a stale tab from placing a rejected key.
-- No client table grants or policies: only the authenticated, scoped RPC writes it.
create table public.checkout_pricing_rejections (
  customer_id uuid not null references auth.users(id),
  business_id uuid not null references public.businesses(id),
  idempotency_key uuid not null,
  request_hash text not null,
  pricing jsonb not null,
  primary key(customer_id,business_id,idempotency_key)
);
-- Who changed the open/closed switch. businesses is publicly readable, so this is kept in an
-- owner-only log rather than on businesses itself.
create table public.accepting_orders_changes (
  id bigint generated always as identity primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  accepting_orders boolean not null,
  changed_by uuid references auth.users(id) on delete set null,
  changed_at timestamptz not null default now()
);
-- Session deletion (including logout) invalidates the corresponding token.
create table public.device_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  audience text not null check (audience in ('customer','admin')),
  token text not null check (length(trim(token)) > 0),
  created_at timestamptz not null default now(),
  session_id uuid references auth.sessions(id) on delete cascade,
  unique (business_id, audience, token)
);
create table public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  device_token_id uuid not null references public.device_tokens(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  audience text not null check (audience in ('customer','admin')),
  attempts integer not null default 0 check (attempts between 0 and 5),
  available_at timestamptz not null default now(),
  lease_id uuid, lease_expires_at timestamptz,
  completed_at timestamptz, created_at timestamptz not null default now()
);
create table public.menu_photo_jobs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id),
  item_id uuid not null, -- Kept after dish deletion so cleanup remains durable.
  actor_id uuid not null,
  expected_path text,
  state text not null default 'pending' check (state in ('pending','attached','cleanup','cleaning','cleaned')),
  due_at timestamptz not null default now() + interval '15 minutes',
  lease uuid,
  created_at timestamptz not null default now()
);

-- 3. Indexes -----------------------------------------------------------------------------------
create index memberships_user_idx on public.business_memberships(user_id, business_id);
create index menu_items_business_idx on public.menu_items(business_id);
create index menu_items_category_idx on public.menu_items(business_id, category_id);
create index customer_addresses_owner on public.customer_addresses (customer_id, updated_at desc);
create index orders_customer_idx on public.orders(customer_id, created_at desc);
create index orders_business_idx on public.orders(business_id, created_at desc);
create index order_items_order_idx on public.order_items(order_id);
create index order_history_order_idx on public.order_status_history(order_id);
create index order_status_actors_actor_idx on public.order_status_actors(actor_id) where actor_id is not null;
create index accepting_orders_changes_business on public.accepting_orders_changes (business_id, changed_at desc);
create index notification_outbox_ready_idx on public.notification_outbox(available_at) where completed_at is null;
create index menu_photo_cleanup_due on public.menu_photo_jobs(business_id, due_at)
where state in ('pending','cleanup','cleaning');

-- 4. Row-level security: enabled on every table; policies are in section 7 -----------------------
alter table public.businesses enable row level security;
alter table public.business_memberships enable row level security;
alter table public.menu_categories enable row level security;
alter table public.menu_items enable row level security;
alter table public.customer_addresses enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.order_status_history enable row level security;
alter table public.order_status_actors enable row level security;
alter table public.order_number_counters enable row level security;
alter table public.checkout_pricing_rejections enable row level security;
alter table public.accepting_orders_changes enable row level security;
alter table public.device_tokens enable row level security;
alter table public.notification_outbox enable row level security;
alter table public.menu_photo_jobs enable row level security;

-- 5. Functions ---------------------------------------------------------------------------------
-- Definer functions expose only boolean membership/visibility, never membership rows.
create function public.is_business_admin(target_business uuid) returns boolean
language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.business_memberships m where m.business_id = target_business and m.user_id = auth.uid() and m.role = 'admin') $$;

create function public.can_view_order(target_order uuid) returns boolean
language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.orders o where o.id = target_order and (o.customer_id = auth.uid() or public.is_business_admin(o.business_id))) $$;

-- Trigger functions.
-- Even an administrator of both tenants cannot transfer an existing menu item.
create function public.prevent_menu_business_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.business_id is distinct from old.business_id then
    raise exception 'menu item business cannot be changed';
  end if;
  return new;
end $$;

-- USING/WITH CHECK alone permits an owner of both businesses to transfer a row.
create function public.prevent_category_business_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.business_id is distinct from old.business_id then
    raise exception 'category business cannot be changed' using errcode = '22023';
  end if;
  return new;
end $$;

-- New client-created dishes require classification, even when marked as samples.
-- Trusted bootstrap roles may insert unclassified examples (all migrations then seed).
-- Keeping an existing unknown dish unchanged is allowed; a known mark cannot be erased.
create function public.require_menu_diet() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.diet is null then
    if (tg_op = 'INSERT' and current_user in ('anon', 'authenticated')) or
       (tg_op = 'UPDATE' and old.diet is not null) then
      raise exception 'diet classification required' using errcode='22023';
    end if;
  end if;
  return new;
end $$;

-- Prefix changes require a controlled migration which explicitly disables the trigger guard, so
-- previously issued numbers cannot silently change meaning.
create function public.protect_order_prefix() returns trigger language plpgsql set search_path='' as $$
begin
  if new.order_prefix is distinct from old.order_prefix then
    raise exception 'order prefix is immutable; use a controlled migration' using errcode='22023';
  end if;
  return new;
end $$;

-- Allocate only when an order is actually inserted: pricing rejections and idempotency replays never
-- reach this trigger. SECURITY INVOKER: no new privileged API; place_order already runs as the owner.
create function public.assign_order_number() returns trigger language plpgsql set search_path='' as $$
declare prefix text; ym text; n bigint;
begin
  if tg_op='UPDATE' then
    if new.order_number is distinct from old.order_number or new.business_id is distinct from old.business_id
      or new.created_at is distinct from old.created_at then
      raise exception 'order number and placement identity are immutable' using errcode='22023';
    end if;
    return new;
  end if;
  if new.order_number is not null then raise exception 'order number is server assigned' using errcode='22023'; end if;
  select order_prefix into strict prefix from public.businesses where id=new.business_id for share;
  ym := to_char(new.created_at at time zone 'Asia/Kolkata','YYYYMM');
  insert into public.order_number_counters(business_id,year_month,last_number) values(new.business_id,ym,1)
    on conflict (business_id,year_month) do update set last_number=public.order_number_counters.last_number+1
    returning last_number into n;
  new.order_number := prefix || '-' || ym || lpad(n::text,greatest(4,length(n::text)),'0');
  return new;
end $$;

-- Normalise text, keep identity fixed, and bump the version on every edit so a checkout opened on an
-- older version is refused rather than silently changed.
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

create function public.queue_order_notification() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op='INSERT' then
    insert into public.notification_outbox(device_token_id,order_id,audience)
      select d.id,new.id,'admin' from public.device_tokens d
      join auth.sessions s on s.id=d.session_id and s.user_id=d.user_id and (s.not_after is null or s.not_after > clock_timestamp())
      join public.business_memberships m on m.business_id=d.business_id and m.user_id=d.user_id and m.role='admin'
      where d.business_id=new.business_id and d.audience='admin';
  elsif new.status is distinct from old.status then
    insert into public.notification_outbox(device_token_id,order_id,audience)
      select d.id,new.id,'customer' from public.device_tokens d
      join auth.sessions s on s.id=d.session_id and s.user_id=d.user_id and (s.not_after is null or s.not_after > clock_timestamp())
      where d.business_id=new.business_id and d.user_id=new.customer_id and d.audience='customer';
  end if;
  return new;
end $$;

-- A trigger must access the private ledger even when an owner deletes a dish.
create function menu_photo_private.track_photo() returns trigger
language plpgsql security definer set search_path = '' as $$
declare candidate public.menu_photo_jobs;
begin
  if tg_op <> 'DELETE' and new.image_url is not null and
     (tg_op = 'INSERT' or new.image_url is distinct from old.image_url or new.id is distinct from old.id) then
    select * into candidate from public.menu_photo_jobs j
    where j.business_id = new.business_id and j.item_id = new.id
      and new.image_url = j.business_id::text || '/' || j.item_id::text || '/' || j.id::text || '/card.webp'
      and j.state = 'pending' and j.due_at > now() for update;
    if not found then raise exception 'Photo must be a validated reservation for this dish' using errcode='42501'; end if;
  end if;
  if tg_op <> 'INSERT' and old.image_url is not null and
     (tg_op = 'DELETE' or old.image_url is distinct from new.image_url) then
    update public.menu_photo_jobs j set state='cleanup', due_at=now(), lease=null
    where j.business_id=old.business_id and j.item_id=old.id
      and old.image_url=j.business_id::text || '/' || j.item_id::text || '/' || j.id::text || '/card.webp'
      and state='attached';
  end if;
  if tg_op='DELETE' then return old; else return new; end if;
end $$;

-- Public RPCs.
create function public.register_device_token(p_business_slug text, p_audience text, p_token text)
returns void language plpgsql security definer set search_path = '' as $$
declare caller uuid := auth.uid(); session uuid; business uuid;
begin
  if caller is null or p_audience not in ('customer','admin') or p_audience is null
     or p_token is null or length(trim(p_token)) = 0 or length(p_token) > 4096 then
    raise exception 'invalid device registration' using errcode='22023';
  end if;
  begin session := (auth.jwt()->>'session_id')::uuid;
  exception when others then raise exception 'invalid session' using errcode='42501'; end;
  if session is null then raise exception 'invalid session' using errcode='42501'; end if;
  perform 1 from auth.sessions where id=session and user_id=caller and (not_after is null or not_after > clock_timestamp()) for share;
  if not found then raise exception 'invalid session' using errcode='42501'; end if;
  select id into business from public.businesses where slug=p_business_slug;
  if business is null then raise exception 'invalid business' using errcode='22023'; end if;
  if p_audience='admin' then
    perform 1 from public.business_memberships where business_id=business and user_id=caller and role='admin' for share;
    if not found then raise exception 'admin membership required' using errcode='42501'; end if;
  end if;
  -- Rotate the row on re-registration, invalidating jobs and leases belonging
  -- to the previous registration of this opaque token.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(business::text || ':' || p_audience || ':' || p_token, 0));
  delete from public.device_tokens where business_id=business and audience=p_audience and token=p_token;
  insert into public.device_tokens(user_id,business_id,audience,token,session_id)
    values(caller,business,p_audience,p_token,session);
end $$;

create function public.unregister_device_token(p_business_slug text, p_audience text, p_token text)
returns void language plpgsql security definer set search_path = '' as $$
declare caller uuid := auth.uid(); session uuid;
begin
  if caller is null then raise exception 'authentication required' using errcode='42501'; end if;
  begin session := (auth.jwt()->>'session_id')::uuid;
  exception when others then raise exception 'invalid session' using errcode='42501'; end;
  if session is null then raise exception 'invalid session' using errcode='42501'; end if;
  perform 1 from auth.sessions where id=session and user_id=caller and (not_after is null or not_after > clock_timestamp()) for share;
  if not found then raise exception 'invalid session' using errcode='42501'; end if;
  delete from public.device_tokens d using public.businesses b
  where b.slug=p_business_slug and d.business_id=b.id and d.audience=p_audience and d.token=p_token and d.user_id=caller and d.session_id=session;
end $$;

-- Checkout. Orders are placed only for a saved address (customer_addresses row plus
-- address_id/address_version); the phone fix in p_location is optional and only measures
-- the distance the order was placed from. The exact accepted-pricing quote is required.
create function public.place_order(p_business_slug text, p_items jsonb, p_delivery jsonb, p_location jsonb, p_idempotency_key uuid, p_accepted_pricing jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid(); b public.businesses%rowtype; existing public.orders%rowtype;
  item jsonb; menu public.menu_items%rowtype; item_id uuid; qty integer;
  subtotal bigint := 0; total bigint; order_id uuid := gen_random_uuid(); request_digest text;
  crypto_schema text; rejected public.checkout_pricing_rejections%rowtype; quote jsonb; quote_lines jsonb := '[]'::jsonb; seen uuid[] := array[]::uuid[];
  addr public.customer_addresses%rowtype; spatial_schema text; covered boolean;
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
  if jsonb_typeof(p_delivery) is distinct from 'object' or
     coalesce(length(trim(p_delivery->>'name')),0) not between 1 and 120 or
     coalesce(length(trim(p_delivery->>'phone')),0) not between 1 and 40 or
     not (p_delivery ? 'address_id') or p_delivery ? 'address_line' or
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
  insert into public.orders(id,business_id,customer_id,customer_name,customer_phone,delivery_address_line,latitude,longitude,
    address_label,address_custom_label,address_house,address_street_area,address_landmark,address_location_source,
    saved_address_id,saved_address_version,placed_from_distance_m,subtotal_paise,delivery_fee_paise,total_paise,idempotency_key,request_hash)
  values(order_id,b.id,caller,trim(p_delivery->>'name'),trim(p_delivery->>'phone'),
    concat_ws(', ',addr.house,addr.street_area,addr.landmark),addr.latitude,addr.longitude,
    addr.label,addr.custom_label,addr.house,addr.street_area,addr.landmark,addr.location_source,
    addr.id,addr.version,round(phone_distance)::integer,subtotal::integer,b.delivery_fee_paise,total::integer,p_idempotency_key,request_digest)
  returning * into existing;
  for item in select value from jsonb_array_elements(p_items) loop
    select * into strict menu from public.menu_items where id=(item->>'menu_item_id')::uuid;
    qty := (item->>'quantity')::integer;
    insert into public.order_items(order_id,menu_item_id,name,unit_price_paise,quantity,line_total_paise,diet)
      values(order_id,menu.id,menu.name,menu.price_paise,qty,menu.price_paise::bigint*qty,menu.diet);
  end loop;
  insert into public.order_status_history(order_id,status,changed_by) values(order_id,'placed',caller);
  return jsonb_build_object('outcome','placed','id',existing.id,'order_number',existing.order_number,'business_id',existing.business_id,'status',existing.status,'version',existing.version,'subtotal_paise',existing.subtotal_paise,'delivery_fee_paise',existing.delivery_fee_paise,'total_paise',existing.total_paise,'created_at',existing.created_at);
end $$;

-- Owners change the open/closed switch only through this function; clients have no direct update
-- grant on businesses. The business row is locked, so an order and a closing at the same moment
-- are serialized: the order is either placed before the close or refused.
create function public.set_accepting_orders(p_business_slug text, p_accepting boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare caller uuid := auth.uid(); b public.businesses%rowtype;
begin
  if caller is null then raise exception 'authentication required' using errcode='42501'; end if;
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

create function public.transition_order(p_order_id uuid, p_status text, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare o public.orders%rowtype; caller uuid := auth.uid(); actor text; step bigint;
begin
  if caller is null then raise exception 'authentication required' using errcode='42501'; end if;
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

create function public.reorder_menu_items(p_business_slug text, p_category_id uuid, p_item_ids uuid[])
returns integer language plpgsql security definer set search_path = '' as $$
declare caller uuid := auth.uid(); business uuid; seen uuid[]; wanted uuid[];
begin
  if caller is null then raise exception 'authentication required' using errcode='42501'; end if;
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

create function public.reorder_menu_categories(p_business_slug text, p_category_ids uuid[])
returns integer language plpgsql security definer set search_path = '' as $$
declare caller uuid := auth.uid(); business uuid; seen uuid[]; wanted uuid[];
begin
  if caller is null then raise exception 'authentication required' using errcode='42501'; end if;
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

-- Owners' daily cash and order summary. Days run midnight to midnight, India time.
create function public.daily_summary(p_business_slug text, p_date date default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  caller uuid := auth.uid(); business uuid;
  day date := coalesce(p_date, (pg_catalog.now() at time zone 'Asia/Kolkata')::date);
  day_start timestamptz; day_end timestamptz; result jsonb;
begin
  if caller is null then raise exception 'authentication required' using errcode='42501'; end if;
  select b.id into business from public.businesses b where b.slug=p_business_slug;
  if not found or not exists (select 1 from public.business_memberships m where m.business_id=business and m.user_id=caller and m.role='admin') then
    raise exception 'summary unavailable' using errcode='42501';
  end if;
  day_start := day::timestamp at time zone 'Asia/Kolkata';
  day_end := (day + 1)::timestamp at time zone 'Asia/Kolkata';
  with delivered as (
    select o.id, o.total_paise from public.orders o
    where o.business_id=business and o.status='delivered'
      and exists (select 1 from public.order_status_history h where h.order_id=o.id and h.status='delivered' and h.created_at >= day_start and h.created_at < day_end)
  ), cancelled as (
    select o.id from public.orders o
    where o.business_id=business and o.status='cancelled'
      and exists (select 1 from public.order_status_history h where h.order_id=o.id and h.status='cancelled' and h.created_at >= day_start and h.created_at < day_end)
  ), placed as (
    select o.id, o.status from public.orders o where o.business_id=business and o.created_at >= day_start and o.created_at < day_end
  ), open_orders as (
    select o.total_paise from public.orders o where o.business_id=business and o.status not in ('delivered','cancelled')
  ), dishes as (
    -- Most ordered among the day's placed orders that were not cancelled, by stored name.
    select i.name, sum(i.quantity)::integer as quantity from public.order_items i join placed p on p.id=i.order_id
    where p.status <> 'cancelled' group by i.name order by sum(i.quantity) desc, i.name limit 5
  )
  select jsonb_build_object(
    'date', day,
    'collected_paise', (select coalesce(sum(total_paise), 0) from delivered),
    'delivered_count', (select count(*) from delivered),
    'outstanding_paise', (select coalesce(sum(total_paise), 0) from open_orders),
    'outstanding_count', (select count(*) from open_orders),
    'placed_count', (select count(*) from placed),
    'cancelled_count', (select count(*) from cancelled),
    'top_dishes', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'quantity', quantity) order by quantity desc, name) from dishes), '[]'::jsonb)
  ) into result;
  return result;
end $$;

-- SECURITY DEFINER (PostGIS may live in a schema callers cannot use), so the caller filter is explicit.
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

-- Notification queue: service-role only.
create function public.claim_notification_jobs(p_limit integer default 20)
returns table(job_id uuid, lease_id uuid) language plpgsql security definer set search_path = '' as $$
begin
  if p_limit is null or p_limit not between 1 and 100 then raise exception 'invalid batch size' using errcode='22023'; end if;
  update public.notification_outbox set completed_at=clock_timestamp(), lease_id=null, lease_expires_at=null
    where completed_at is null and attempts >= 5 and (lease_expires_at is null or lease_expires_at <= clock_timestamp());
  return query
    with ready as (
      select q.id from public.notification_outbox q
      where q.completed_at is null and q.attempts < 5 and q.available_at <= clock_timestamp()
        and (q.lease_expires_at is null or q.lease_expires_at <= clock_timestamp())
      order by q.created_at, q.id for update skip locked limit p_limit
    )
    update public.notification_outbox q set lease_id=gen_random_uuid(),
      lease_expires_at=clock_timestamp()+interval '2 minutes', attempts=q.attempts+1
    from ready where q.id=ready.id returning q.id,q.lease_id;
end $$;

create function public.notification_destination(p_job_id uuid, p_lease_id uuid)
returns text language sql security definer set search_path = '' as $$
  select d.token from public.notification_outbox q
  join public.device_tokens d on d.id=q.device_token_id
  join auth.sessions s on s.id=d.session_id and s.user_id=d.user_id and (s.not_after is null or s.not_after > clock_timestamp())
  join public.orders o on o.id=q.order_id and o.business_id=d.business_id
  where q.id=p_job_id and q.lease_id=p_lease_id and q.completed_at is null
    and q.lease_expires_at > clock_timestamp() and d.audience=q.audience
    and ((q.audience='customer' and d.user_id=o.customer_id) or
         (q.audience='admin' and exists (select 1 from public.business_memberships m
            where m.business_id=o.business_id and m.user_id=d.user_id and m.role='admin')))
$$;

create function public.finish_notification_job(p_job_id uuid, p_lease_id uuid, p_result text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare token_id uuid; n integer;
begin
  if p_result is null or p_result not in ('sent','retry','unregistered','discard') then raise exception 'invalid result' using errcode='22023'; end if;
  select device_token_id, attempts into token_id,n from public.notification_outbox
    where id=p_job_id and lease_id=p_lease_id and completed_at is null and lease_expires_at > clock_timestamp() for update;
  if not found then return false; end if;
  if p_result='unregistered' then
    delete from public.device_tokens where id=token_id;
  elsif p_result in ('sent','discard') or n >= 5 then
    update public.notification_outbox set completed_at=clock_timestamp(),lease_id=null,lease_expires_at=null where id=p_job_id;
  else
    update public.notification_outbox set available_at=clock_timestamp()+make_interval(secs => (30 * power(2,n-1))::integer),lease_id=null,lease_expires_at=null where id=p_job_id;
  end if;
  return true;
end $$;

create function public.notification_delivery(p_job_id uuid, p_lease_id uuid)
returns jsonb language sql security invoker set search_path = '' as $$
  with checked as materialized (
    select public.notification_destination(p_job_id,p_lease_id) as token
  )
  select jsonb_build_object('token',checked.token,
    'order_id',case when q.audience='customer' then q.order_id else null end)
  from checked cross join public.notification_outbox q
  where q.id=p_job_id and q.lease_id=p_lease_id and checked.token is not null
$$;

-- Redaction path for account deletion (#51).
create function public.redact_owner_history_names(p_user_id uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare redacted integer;
begin
  if p_user_id is null then raise exception 'account required' using errcode='22004'; end if;
  -- Both data-modifying statements always run, even though only steps is counted.
  with steps as (
    update public.order_status_actors set actor_name='Former owner', actor_id=null where actor_id=p_user_id returning history_id
  ), cleared as (
    update public.order_status_history h set changed_by=null from steps where h.id=steps.history_id and h.changed_by=p_user_id returning h.id
  )
  select count(*) into redacted from steps;
  return redacted;
end $$;

-- Menu photo RPCs: server-only and SECURITY INVOKER. The actor comes from Auth.getUser, never request JSON.
create function public.menu_photo_business(p_actor uuid, p_slug text) returns uuid
language plpgsql security invoker set search_path='' as $$
declare business uuid;
begin
  select b.id into business from public.businesses b join public.business_memberships m on m.business_id=b.id
  where b.slug=p_slug and m.user_id=p_actor and m.role='admin' for share of m;
  if business is null then raise exception 'Admin access required' using errcode='42501'; end if;
  return business;
end $$;

create function public.reserve_menu_photo(p_actor uuid,p_slug text,p_item uuid,p_expected text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare business uuid; current_path text; job public.menu_photo_jobs;
begin
  business:=public.menu_photo_business(p_actor,p_slug);
  select image_url into current_path from public.menu_items where id=p_item and business_id=business for update;
  if not found then raise exception 'Dish no longer exists' using errcode='P0002'; end if;
  if current_path is distinct from p_expected then raise exception 'Photo changed. Reload before retrying.' using errcode='40001'; end if;
  insert into public.menu_photo_jobs(business_id,item_id,actor_id,expected_path)
  values(business,p_item,p_actor,p_expected) returning * into job;
  return jsonb_build_object('id',job.id,'base',business::text || '/' || p_item::text || '/' || job.id::text);
end $$;

create function public.attach_menu_photo(p_actor uuid,p_slug text,p_job uuid) returns text
language plpgsql security invoker set search_path='' as $$
declare business uuid; job public.menu_photo_jobs; current_path text; next_path text;
begin
  business:=public.menu_photo_business(p_actor,p_slug);
  select * into job from public.menu_photo_jobs where id=p_job and business_id=business and actor_id=p_actor for update;
  if not found or job.state<>'pending' or job.due_at<=now() then raise exception 'Photo reservation expired. Choose the photo again.' using errcode='40001'; end if;
  select image_url into current_path from public.menu_items where id=job.item_id and business_id=business for update;
  if not found then raise exception 'Dish no longer exists' using errcode='P0002'; end if;
  if current_path is distinct from job.expected_path then raise exception 'Photo changed. Reload before retrying.' using errcode='40001'; end if;
  next_path:=job.business_id::text || '/' || job.item_id::text || '/' || job.id::text || '/card.webp';
  -- Both exact objects must have been written to the correct bucket by the server.
  if (select count(*) from storage.objects where bucket_id='menu-images' and name in
      (next_path,replace(next_path,'/card.webp','/detail.webp')))<>2 then
    raise exception 'Photo upload is incomplete' using errcode='40001';
  end if;
  update public.menu_items set image_url=next_path where id=job.item_id and business_id=business;
  update public.menu_photo_jobs set state='attached' where id=p_job;
  return next_path;
end $$;

create function public.remove_menu_photo(p_actor uuid,p_slug text,p_item uuid,p_expected text) returns void
language plpgsql security invoker set search_path='' as $$
declare business uuid; current_path text;
begin
  business:=public.menu_photo_business(p_actor,p_slug);
  select image_url into current_path from public.menu_items where id=p_item and business_id=business for update;
  if not found then raise exception 'Dish no longer exists' using errcode='P0002'; end if;
  if current_path is null then return; end if; -- Safe retry after a lost response.
  if current_path is distinct from p_expected then raise exception 'Photo changed. Reload before retrying.' using errcode='40001'; end if;
  update public.menu_items set image_url=null where id=p_item and business_id=business;
end $$;

create function public.claim_menu_photo_cleanup(p_actor uuid,p_slug text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare business uuid; result jsonb;
begin
  business:=public.menu_photo_business(p_actor,p_slug);
  -- The same row lock is taken by attachment. An unexpired upload is never claimed;
  -- once claimed it cannot be attached, even if a slow function resumes afterwards.
  with candidates as (
    select id from public.menu_photo_jobs where business_id=business
      and state in ('pending','cleanup','cleaning') and due_at<=now()
    order by due_at limit 5 for update skip locked
  ), claimed as (
    update public.menu_photo_jobs j set state='cleaning',lease=gen_random_uuid(),due_at=now()+interval '2 minutes'
    from candidates c where j.id=c.id returning j.*
  ) select coalesce(jsonb_agg(jsonb_build_object('id',id,'lease',lease,'base',business_id::text || '/' || item_id::text || '/' || id::text)),'[]'::jsonb) into result from claimed;
  return result;
end $$;

create function public.finish_menu_photo_cleanup(p_actor uuid,p_slug text,p_job uuid,p_lease uuid) returns void
language plpgsql security invoker set search_path='' as $$
declare business uuid;
begin
  business:=public.menu_photo_business(p_actor,p_slug);
  update public.menu_photo_jobs set state='cleaned',lease=null where id=p_job and business_id=business and lease=p_lease and state='cleaning';
end $$;

-- Trusted setup only: replaces a restaurant's service_area with a circle around its kitchen point.
create function public.set_delivery_radius(p_business_slug text, p_radius_m integer, p_source text)
returns void language plpgsql security definer set search_path = '' as $$
declare b public.businesses%rowtype; ns text;
begin
  if p_radius_m is null or p_radius_m not between 500 and 50000 then
    raise exception 'delivery radius must be 500 m to 50 km' using errcode = '22023';
  end if;
  if nullif(trim(p_source), '') is null then raise exception 'delivery area source required' using errcode = '22023'; end if;
  select * into b from public.businesses where slug = p_business_slug for update;
  if not found then raise exception 'business unavailable' using errcode = '22023'; end if;
  if b.kitchen_location is null then raise exception 'set the kitchen location first' using errcode = '22023'; end if;
  select n.nspname into strict ns from pg_catalog.pg_extension e
    join pg_catalog.pg_namespace n on n.oid = e.extnamespace where e.extname = 'postgis';
  execute format('update public.businesses set service_area = %1$I.st_multi(%1$I.st_buffer(kitchen_location::%1$I.geography, $2, ''quad_segs=32'')::%1$I.geometry),
      service_area_source = $3, service_area_version = $4, service_area_verified_at = now() where id = $1', ns)
    using b.id, p_radius_m::double precision, trim(p_source), 'radius-' || p_radius_m || 'm';
end $$;

-- 6. Triggers ----------------------------------------------------------------------------------
create trigger menu_business_immutable before update on public.menu_items
for each row execute function public.prevent_menu_business_change();
create trigger category_business_immutable before update on public.menu_categories
for each row execute function public.prevent_category_business_change();
create trigger menu_diet_required before insert or update on public.menu_items
for each row execute function public.require_menu_diet();
create trigger menu_photo_tracking before insert or update of image_url,id or delete on public.menu_items
for each row execute function menu_photo_private.track_photo();
create trigger business_order_prefix_immutable before update of order_prefix on public.businesses
  for each row execute function public.protect_order_prefix();
create trigger assign_order_number before insert or update of order_number,business_id,created_at on public.orders
  for each row execute function public.assign_order_number();
create trigger prepare_customer_address before insert or update on public.customer_addresses
  for each row execute function public.prepare_customer_address();
create trigger queue_order_notification after insert or update of status on public.orders
for each row execute function public.queue_order_notification();

-- 7. Row-level security policies ---------------------------------------------------------------
create policy businesses_public on public.businesses for select to anon, authenticated using (true);
create policy memberships_self on public.business_memberships for select to authenticated using (user_id = auth.uid());
create policy menu_public on public.menu_items for select to anon, authenticated using (true);
create policy menu_admin_insert on public.menu_items for insert to authenticated with check (public.is_business_admin(business_id));
create policy menu_admin_update on public.menu_items for update to authenticated using (public.is_business_admin(business_id)) with check (public.is_business_admin(business_id));
create policy menu_admin_delete on public.menu_items for delete to authenticated using (public.is_business_admin(business_id));
create policy categories_public on public.menu_categories for select to anon, authenticated using (true);
create policy categories_admin_insert on public.menu_categories for insert to authenticated
  with check (public.is_business_admin(business_id));
create policy categories_admin_update on public.menu_categories for update to authenticated
  using (public.is_business_admin(business_id)) with check (public.is_business_admin(business_id));
create policy categories_admin_delete on public.menu_categories for delete to authenticated
  using (public.is_business_admin(business_id));
create policy customer_addresses_own_select on public.customer_addresses for select to authenticated using (customer_id = auth.uid());
create policy customer_addresses_own_insert on public.customer_addresses for insert to authenticated with check (customer_id = auth.uid());
create policy customer_addresses_own_update on public.customer_addresses for update to authenticated using (customer_id = auth.uid()) with check (customer_id = auth.uid());
create policy customer_addresses_own_delete on public.customer_addresses for delete to authenticated using (customer_id = auth.uid());
create policy orders_visible on public.orders for select to authenticated using (customer_id = auth.uid() or public.is_business_admin(business_id));
create policy order_items_visible on public.order_items for select to authenticated using (public.can_view_order(order_id));
create policy order_history_visible on public.order_status_history for select to authenticated using (public.can_view_order(order_id));
create policy order_status_actors_owner on public.order_status_actors for select to authenticated
  using (public.is_business_admin(business_id));
create policy accepting_orders_changes_admin on public.accepting_orders_changes for select to authenticated
  using (public.is_business_admin(business_id));
create policy devices_self on public.device_tokens for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid() and (audience = 'customer' or public.is_business_admin(business_id)));
-- order_number_counters, checkout_pricing_rejections, notification_outbox and menu_photo_jobs have
-- no policy: only trusted functions and the service role touch them.

-- 8. Grants and revokes (least privilege) ------------------------------------------------------
-- Tables. Clients get only what is listed; the service role is trusted. Rows are written by
-- SECURITY DEFINER functions, never directly by clients.
revoke all on public.businesses, public.business_memberships, public.menu_categories, public.menu_items,
  public.orders, public.order_items, public.order_status_history, public.device_tokens,
  public.accepting_orders_changes from anon, authenticated;
revoke all on public.customer_addresses, public.order_status_actors, public.order_number_counters,
  public.checkout_pricing_rejections, public.notification_outbox, public.menu_photo_jobs from public, anon, authenticated;
grant select on public.businesses, public.menu_categories, public.menu_items to anon, authenticated;
grant select on public.business_memberships, public.orders, public.order_items, public.device_tokens,
  public.accepting_orders_changes to authenticated;
grant insert, update, delete on public.menu_categories to authenticated;
-- Customers keep status and time only; the acting account id is not exposed. Owner names are in
-- order_status_actors, readable by owners only.
grant select (id, order_id, status, created_at) on public.order_status_history to authenticated;
grant select (history_id, actor_name) on public.order_status_actors to authenticated;
-- menu_items: image_url is writable only through the photo RPCs, never by clients.
grant delete on public.menu_items to authenticated;
grant insert(id,business_id,name,description,category_id,price_paise,available,is_demo,diet,is_featured,sort_order,created_at),
      update(id,business_id,name,description,category_id,price_paise,available,is_demo,diet,is_featured,sort_order,created_at)
on public.menu_items to authenticated;
-- customer_id, version and timestamps are not writable: the default and trigger own them.
grant select, delete on public.customer_addresses to authenticated;
grant insert (label, custom_label, house, street_area, landmark, latitude, longitude, location_source),
  update (label, custom_label, house, street_area, landmark, latitude, longitude, location_source)
  on public.customer_addresses to authenticated;
grant all on public.businesses, public.business_memberships, public.menu_categories, public.menu_items,
  public.customer_addresses, public.orders, public.order_items, public.order_status_history,
  public.order_status_actors, public.accepting_orders_changes, public.device_tokens,
  public.notification_outbox, public.menu_photo_jobs to service_role;
-- The counters only need what the SECURITY INVOKER numbering trigger does for trusted maintenance inserts.
grant select, insert, update on public.order_number_counters to service_role;
grant usage, select on sequence public.order_status_history_id_seq to service_role;

-- Functions. Default privileges grant EXECUTE broadly, so revoke everything, then grant explicitly.
revoke all on function
  public.is_business_admin(uuid), public.can_view_order(uuid),
  public.register_device_token(text,text,text), public.unregister_device_token(text,text,text),
  public.set_accepting_orders(text,boolean), public.place_order(text,jsonb,jsonb,jsonb,uuid,jsonb),
  public.transition_order(uuid,text,integer), public.reorder_menu_items(text,uuid,uuid[]),
  public.reorder_menu_categories(text,uuid[]), public.daily_summary(text,date), public.list_addresses(text),
  public.claim_notification_jobs(integer), public.notification_destination(uuid,uuid),
  public.finish_notification_job(uuid,uuid,text), public.notification_delivery(uuid,uuid),
  public.redact_owner_history_names(uuid), public.set_delivery_radius(text,integer,text),
  public.menu_photo_business(uuid,text), public.reserve_menu_photo(uuid,text,uuid,text),
  public.attach_menu_photo(uuid,text,uuid), public.remove_menu_photo(uuid,text,uuid,text),
  public.claim_menu_photo_cleanup(uuid,text), public.finish_menu_photo_cleanup(uuid,text,uuid,uuid),
  public.prevent_menu_business_change(), public.prevent_category_business_change(), public.require_menu_diet(),
  public.protect_order_prefix(), public.assign_order_number(), public.prepare_customer_address(),
  public.queue_order_notification(), menu_photo_private.track_photo()
  from public, anon, authenticated;
-- Signed-in customers and owners (each function checks the caller itself).
grant execute on function
  public.is_business_admin(uuid), public.can_view_order(uuid),
  public.register_device_token(text,text,text), public.unregister_device_token(text,text,text),
  public.set_accepting_orders(text,boolean), public.place_order(text,jsonb,jsonb,jsonb,uuid,jsonb),
  public.transition_order(uuid,text,integer), public.reorder_menu_items(text,uuid,uuid[]),
  public.reorder_menu_categories(text,uuid[]), public.daily_summary(text,date), public.list_addresses(text)
  to authenticated;
-- Trusted server code only (the notification dispatcher, the menu-photos Edge Function, setup and account deletion).
grant execute on function
  public.claim_notification_jobs(integer), public.notification_destination(uuid,uuid),
  public.finish_notification_job(uuid,uuid,text), public.notification_delivery(uuid,uuid),
  public.redact_owner_history_names(uuid), public.set_delivery_radius(text,integer,text),
  public.menu_photo_business(uuid,text), public.reserve_menu_photo(uuid,text,uuid,text),
  public.attach_menu_photo(uuid,text,uuid), public.remove_menu_photo(uuid,text,uuid,text),
  public.claim_menu_photo_cleanup(uuid,text), public.finish_menu_photo_cleanup(uuid,text,uuid,uuid)
  to service_role;

-- 9. Realtime publication ----------------------------------------------------------------------
-- Add only when Supabase's publication exists; publication does not bypass RLS. Customers, including
-- guests, follow open/closed changes and menu/category changes live; orders and history reach their
-- owners and customers through RLS. customer_addresses is deliberately NOT published: Supabase does not
-- apply RLS to DELETE events, which would tell every subscriber other customers' address ids.
do $$
declare table_name text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach table_name in array array['businesses', 'menu_categories', 'menu_items', 'order_status_history', 'orders'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = table_name) then
        execute format('alter publication supabase_realtime add table public.%I', table_name);
      end if;
    end loop;
  end if;
end $$;

-- 10. Storage ----------------------------------------------------------------------------------
-- Public serving, but *all* writes pass through the decoding Edge Function.
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('menu-images', 'menu-images', true, 1048576, array['image/webp']);
-- No INSERT/UPDATE/DELETE policy: clients (including owners) cannot bypass decoding.
create policy menu_images_public_read on storage.objects for select to anon, authenticated
using (bucket_id = 'menu-images');
