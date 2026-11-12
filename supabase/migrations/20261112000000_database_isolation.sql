-- Tenant data is private by default. Service-role operations bypass RLS in Supabase.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists postgis with schema extensions;

create table public.businesses (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text not null,
  delivery_fee_paise integer not null default 0 check (delivery_fee_paise >= 0),
  min_order_paise integer not null default 0 check (min_order_paise >= 0),
  is_demo boolean not null default false,
  ordering_enabled boolean not null default false,
  service_area_source text,
  service_area_version text,
  service_area_verified_at timestamptz,
  created_at timestamptz not null default now()
);
-- PostGIS may already be installed in another schema on an existing project.
do $$
declare spatial_schema text;
begin
  select n.nspname into strict spatial_schema from pg_extension e
    join pg_namespace n on n.oid = e.extnamespace where e.extname = 'postgis';
  execute format('alter table public.businesses add column service_area %I.geometry(MultiPolygon,4326)', spatial_schema);
  execute format('alter table public.businesses add constraint valid_service_area check (service_area is null or (not %I.st_isempty(service_area) and %I.st_isvalid(service_area)))', spatial_schema, spatial_schema);
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
  primary key (business_id, user_id)
);
create table public.menu_items (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id),
  name text not null, description text, category text not null,
  price_paise integer not null check (price_paise > 0),
  available boolean not null default true, is_demo boolean not null default false,
  image_url text, created_at timestamptz not null default now(),
  unique (business_id, id)
);
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id),
  customer_id uuid not null references auth.users(id),
  status text not null default 'placed' check (status in ('placed','accepted','preparing','out_for_delivery','delivered','cancelled')),
  version integer not null default 1 check (version > 0),
  customer_name text not null, customer_phone text not null, delivery_address_line text not null,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  location_accuracy double precision not null check (location_accuracy >= 0),
  location_captured_at timestamptz not null,
  subtotal_paise integer not null check (subtotal_paise >= 0),
  delivery_fee_paise integer not null check (delivery_fee_paise >= 0),
  total_paise integer not null check (total_paise = subtotal_paise + delivery_fee_paise),
  idempotency_key uuid not null, request_hash text not null,
  created_at timestamptz not null default now(),
  unique (customer_id, business_id, idempotency_key), unique (business_id, id)
);
create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  menu_item_id uuid references public.menu_items(id),
  name text not null, unit_price_paise integer not null check (unit_price_paise > 0),
  quantity integer not null check (quantity > 0),
  line_total_paise bigint not null check (line_total_paise = unit_price_paise::bigint * quantity)
);
create table public.order_status_history (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders(id) on delete cascade,
  status text not null check (status in ('placed','accepted','preparing','out_for_delivery','delivered','cancelled')),
  changed_by uuid references auth.users(id), created_at timestamptz not null default now()
);
create table public.device_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  audience text not null check (audience in ('customer','admin')),
  token text not null check (length(trim(token)) > 0),
  created_at timestamptz not null default now(),
  unique (business_id, audience, token)
);
create index memberships_user_idx on public.business_memberships(user_id, business_id);
create index menu_items_business_idx on public.menu_items(business_id);
create index orders_customer_idx on public.orders(customer_id, created_at desc);
create index orders_business_idx on public.orders(business_id, created_at desc);
create index order_items_order_idx on public.order_items(order_id);
create index order_history_order_idx on public.order_status_history(order_id);

-- Definer functions expose only boolean membership/visibility, never membership rows.
create function public.is_business_admin(target_business uuid) returns boolean
language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.business_memberships m where m.business_id = target_business and m.user_id = auth.uid() and m.role = 'admin') $$;
create function public.can_view_order(target_order uuid) returns boolean
language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.orders o where o.id = target_order and (o.customer_id = auth.uid() or public.is_business_admin(o.business_id))) $$;
revoke all on function public.is_business_admin(uuid), public.can_view_order(uuid) from public, anon, authenticated;
grant execute on function public.is_business_admin(uuid), public.can_view_order(uuid) to authenticated;

alter table public.businesses enable row level security;
alter table public.business_memberships enable row level security;
alter table public.menu_items enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.order_status_history enable row level security;
alter table public.device_tokens enable row level security;
revoke all on public.businesses, public.business_memberships, public.menu_items, public.orders, public.order_items, public.order_status_history, public.device_tokens from anon, authenticated;
grant select on public.businesses, public.menu_items to anon, authenticated;
grant select on public.business_memberships, public.orders, public.order_items, public.order_status_history to authenticated;
grant insert, update, delete on public.menu_items to authenticated;
grant select, insert, update, delete on public.device_tokens to authenticated;
grant all on public.businesses, public.business_memberships, public.menu_items, public.orders, public.order_items, public.order_status_history, public.device_tokens to service_role;
grant usage, select on all sequences in schema public to service_role;
create policy businesses_public on public.businesses for select to anon, authenticated using (true);
create policy menu_public on public.menu_items for select to anon, authenticated using (true);
create policy memberships_self on public.business_memberships for select to authenticated using (user_id = auth.uid());
create policy menu_admin_insert on public.menu_items for insert to authenticated with check (public.is_business_admin(business_id));
create policy menu_admin_update on public.menu_items for update to authenticated using (public.is_business_admin(business_id)) with check (public.is_business_admin(business_id));
create policy menu_admin_delete on public.menu_items for delete to authenticated using (public.is_business_admin(business_id));
create policy orders_visible on public.orders for select to authenticated using (customer_id = auth.uid() or public.is_business_admin(business_id));
create policy order_items_visible on public.order_items for select to authenticated using (public.can_view_order(order_id));
create policy order_history_visible on public.order_status_history for select to authenticated using (public.can_view_order(order_id));
create policy devices_self on public.device_tokens for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid() and (audience = 'customer' or public.is_business_admin(business_id)));
-- Add only when Supabase's publication exists; publication does not bypass RLS.
do $$
declare table_name text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach table_name in array array['orders', 'menu_items', 'order_status_history'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = table_name) then
        execute format('alter publication supabase_realtime add table public.%I', table_name);
      end if;
    end loop;
  end if;
end $$;
-- Even an administrator of both tenants cannot transfer an existing menu item.
create function public.prevent_menu_business_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.business_id is distinct from old.business_id then
    raise exception 'menu item business cannot be changed';
  end if;
  return new;
end $$;
revoke all on function public.prevent_menu_business_change() from public, anon, authenticated;
create trigger menu_business_immutable before update on public.menu_items
for each row execute function public.prevent_menu_business_change();
