-- Allocate only when an order is actually inserted: pricing rejections and
-- idempotency replays never reach this trigger. Everything rolls back together.
begin;
lock table public.businesses, public.orders in access exclusive mode;
alter table public.businesses add column order_prefix text,
  add column contact_phone text check (contact_phone is null or contact_phone ~ '^\+[1-9][0-9]{7,14}$');
update public.businesses set order_prefix = case slug
  when 'ammu-sammu' then 'AMS' when 'kokani-dine-inn' then 'KDI' end;
alter table public.businesses alter column order_prefix set not null,
  add constraint business_order_prefix_format check (order_prefix ~ '^[A-Z][A-Z0-9]{1,9}$'),
  add constraint business_order_prefix_unique unique(order_prefix);
-- Contact values are intentionally unconfigured; design-reference numbers are examples.

create table public.order_number_counters (
  business_id uuid not null references public.businesses(id),
  year_month text not null check (year_month ~ '^[0-9]{4}(0[1-9]|1[0-2])$'),
  last_number bigint not null check (last_number > 0),
  primary key (business_id, year_month)
);
alter table public.order_number_counters enable row level security;
revoke all on public.order_number_counters from public, anon, authenticated;
-- Preserve existing trusted service-role maintenance inserts into orders. RLS
-- bypass alone does not grant the table access needed by this invoker trigger.
grant select, insert, update on public.order_number_counters to service_role;

alter table public.orders add column order_number text;
with numbered as (
  select id, business_id, to_char(created_at at time zone 'Asia/Kolkata','YYYYMM') as ym,
    row_number() over (partition by business_id, to_char(created_at at time zone 'Asia/Kolkata','YYYYMM') order by created_at,id) as n
  from public.orders
)
update public.orders o set order_number=b.order_prefix || '-' || n.ym || lpad(n.n::text,greatest(4,length(n.n::text)),'0')
from numbered n join public.businesses b on b.id=n.business_id where o.id=n.id;
insert into public.order_number_counters(business_id,year_month,last_number)
select business_id,to_char(created_at at time zone 'Asia/Kolkata','YYYYMM'),count(*) from public.orders
  group by business_id,to_char(created_at at time zone 'Asia/Kolkata','YYYYMM');
alter table public.orders alter column order_number set not null,
  add constraint business_order_number_unique unique(business_id,order_number);

-- Prefix changes require a controlled migration which explicitly disables this
-- guard, so previously issued numbers cannot silently change meaning.
create function public.protect_order_prefix() returns trigger language plpgsql set search_path='' as $$
begin
  if new.order_prefix is distinct from old.order_prefix then
    raise exception 'order prefix is immutable; use a controlled migration' using errcode='22023';
  end if;
  return new;
end $$;
revoke all on function public.protect_order_prefix() from public,anon,authenticated;
create trigger business_order_prefix_immutable before update of order_prefix on public.businesses
  for each row execute function public.protect_order_prefix();

-- SECURITY INVOKER: no new privileged API. Orders have no direct client writes;
-- place_order already runs as the trusted owner of these tables.
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
revoke all on function public.assign_order_number() from public,anon,authenticated;
create trigger assign_order_number before insert or update of order_number,business_id,created_at on public.orders
  for each row execute function public.assign_order_number();

-- Preserve the accepted-pricing six-argument contract verbatim, adding only the
-- server number to successful placement/replay responses.
create or replace function public.place_order(p_business_slug text, p_items jsonb, p_delivery jsonb, p_location jsonb, p_idempotency_key uuid, p_accepted_pricing jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid(); b public.businesses%rowtype; existing public.orders%rowtype;
  item jsonb; menu public.menu_items%rowtype; item_id uuid; qty integer;
  subtotal bigint := 0; total bigint; order_id uuid := gen_random_uuid(); request_digest text;
  crypto_schema text; rejected public.checkout_pricing_rejections%rowtype; quote jsonb; quote_lines jsonb := '[]'::jsonb; seen uuid[] := array[]::uuid[];
begin
  if caller is null or p_idempotency_key is null then raise exception 'authentication and idempotency key required' using errcode='22023'; end if;
  select * into b from public.businesses where slug=p_business_slug for share;
  if not found then raise exception 'business unavailable' using errcode='22023'; end if;
  select n.nspname into strict crypto_schema from pg_catalog.pg_extension e
    join pg_catalog.pg_namespace n on n.oid=e.extnamespace where e.extname='pgcrypto';
  execute format('select pg_catalog.encode(%I.digest($1, ''sha256''), ''hex'')', crypto_schema)
    into request_digest using jsonb_build_object('business',p_business_slug,'items',p_items,'delivery',p_delivery,'location',p_location,'accepted_pricing',p_accepted_pricing)::text;
  -- Serialize even simultaneous first attempts before checking the unique key.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(caller::text || ':' || b.id::text || ':' || p_idempotency_key::text, 0));
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
  insert into public.orders(id,business_id,customer_id,customer_name,customer_phone,delivery_address_line,latitude,longitude,location_accuracy,location_captured_at,subtotal_paise,delivery_fee_paise,total_paise,idempotency_key,request_hash)
  values(order_id,b.id,caller,trim(p_delivery->>'name'),trim(p_delivery->>'phone'),trim(p_delivery->>'address_line'),(p_location->>'latitude')::double precision,(p_location->>'longitude')::double precision,(p_location->>'accuracy')::double precision,(p_location->>'captured_at')::timestamptz,subtotal::integer,b.delivery_fee_paise,total::integer,p_idempotency_key,request_digest)
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
revoke all on function public.place_order(text,jsonb,jsonb,jsonb,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.place_order(text,jsonb,jsonb,jsonb,uuid,jsonb) to authenticated;

commit;
