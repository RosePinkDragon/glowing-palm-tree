-- Owners open or close their restaurant for new orders (#58). This is separate
-- from ordering_enabled, the developer-controlled "set up to take orders" switch;
-- customers can order only when both are true.
alter table public.businesses add column accepting_orders boolean not null default false;

-- businesses is publicly readable, so who changed the switch is kept in an
-- owner-only log rather than on businesses itself.
create table public.accepting_orders_changes (
  id bigint generated always as identity primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  accepting_orders boolean not null,
  changed_by uuid references auth.users(id) on delete set null,
  changed_at timestamptz not null default now()
);
create index accepting_orders_changes_business on public.accepting_orders_changes (business_id, changed_at desc);
alter table public.accepting_orders_changes enable row level security;
revoke all on public.accepting_orders_changes from anon, authenticated;
grant select on public.accepting_orders_changes to authenticated;
grant all on public.accepting_orders_changes to service_role;
create policy accepting_orders_changes_admin on public.accepting_orders_changes for select to authenticated
  using (public.is_business_admin(business_id));

-- Owners change the switch only through this function; clients have no
-- direct update grant on businesses.
create function public.set_accepting_orders(p_business_slug text, p_accepting boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare caller uuid := auth.uid(); b public.businesses%rowtype;
begin
  if caller is null then raise exception 'authentication required' using errcode='42501'; end if;
  if p_accepting is null then raise exception 'a value is required' using errcode='22023'; end if;
  select * into b from public.businesses where slug=p_business_slug for update;
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
revoke all on function public.set_accepting_orders(text,boolean) from public, anon, authenticated;
grant execute on function public.set_accepting_orders(text,boolean) to authenticated;

-- place_order is unchanged except for the open check, placed after the
-- idempotent-retry lookup so an order that already exists is still returned.
-- The business row is locked for share, so an order and a closing at the same
-- moment are serialized: the order is either placed before the close or refused.
create or replace function public.place_order(p_business_slug text, p_items jsonb, p_delivery jsonb, p_location jsonb, p_idempotency_key uuid)
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
  if not b.accepting_orders then
    raise exception 'restaurant is not accepting orders' using errcode='55000';
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


-- Customers, including guests, follow open/closed changes live. businesses is
-- already publicly readable; publication does not bypass RLS.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'businesses') then
    alter publication supabase_realtime add table public.businesses;
  end if;
end $$;
