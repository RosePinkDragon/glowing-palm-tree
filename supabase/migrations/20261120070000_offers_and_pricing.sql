-- Offers and order discounts (#182, slice A: database and pricing). Forward-only: the baseline is frozen.
--
-- Order-level offers only (percent off, flat off, free delivery), automatic or by code. Dish-level
-- offers (dish_price, bogo) are slice D and add their own columns and a wider `kind` check then.
--
-- The server is the source of truth: public.quote_order and public.place_order price the cart and pick at
-- most ONE offer. place_order keeps its accepted-pricing contract and idempotency/replay rules; a cart with no
-- offer produces exactly the quote it produced before, so clients that know nothing about offers keep working.
--
-- Lock order (extends the checkout order in docs/RELEASE.md):
--   users KEY SHARE -> sessions SHARE -> accounts FOR UPDATE -> business SHARE -> advisory checkout key
--   -> advisory code-attempt key (customer, only when a code is sent) -> advisory offer keys (ascending id)
--   -> address/menu/order rows.
-- quote_order and check_offer_code take only the customer's code-attempt key (and nothing else), so they cannot
-- join a cycle. Cancelling an order takes no offer lock: it can only free a use.

-- 1. Schema ---------------------------------------------------------------------------------------
create schema offers_private;
revoke all on schema offers_private from public, anon, authenticated, service_role;
grant usage on schema offers_private to anon, authenticated;

-- 2. Tables ---------------------------------------------------------------------------------------
create table public.offers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null constraint offer_name_valid check (name = btrim(name) and char_length(name) between 3 and 40 and name !~ '[[:cntrl:]]'),
  kind text not null constraint offer_kind_valid check (kind in ('percent','flat','free_delivery')),
  -- percent: whole percent. flat: paise. free_delivery: no value.
  value integer,
  max_discount_paise integer,
  min_order_paise integer not null default 0,
  apply_mode text not null constraint offer_apply_mode_valid check (apply_mode in ('automatic','code')),
  -- Stored upper case (trigger); case-insensitive for customers.
  code text,
  first_order_only boolean not null default false,
  per_customer_limit integer,
  total_limit integer,
  starts_at timestamptz,
  ends_at timestamptz,
  -- Optional daily window in Asia/Kolkata. window_from > window_to runs past midnight and belongs to the
  -- weekday it starts on. Weekdays are ISO: 1 = Monday ... 7 = Sunday.
  window_from time,
  window_to time,
  window_days smallint[],
  paused boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 constraint offer_version_valid check (version > 0),
  -- coalesce: a NULL check result would pass, so a missing value or code must evaluate to false.
  constraint offer_value_valid check (coalesce(
    (kind = 'percent' and value between 1 and 90)
    or (kind = 'flat' and value between 100 and 100000)
    or (kind = 'free_delivery' and value is null), false)),
  constraint offer_max_discount_valid check (max_discount_paise is null or (kind = 'percent' and max_discount_paise between 100 and 100000)),
  constraint offer_min_order_valid check (min_order_paise between 0 and 1000000),
  constraint offer_code_valid check (coalesce(
    (apply_mode = 'code' and code ~ '^[A-Z0-9]{4,15}$') or (apply_mode = 'automatic' and code is null), false)),
  constraint offer_per_customer_limit_valid check (per_customer_limit is null or per_customer_limit between 1 and 99),
  constraint offer_total_limit_valid check (total_limit is null or total_limit between 1 and 100000),
  constraint offer_dates_valid check (starts_at is null or ends_at is null or ends_at > starts_at),
  constraint offer_window_complete check ((window_from is null) = (window_to is null) and (window_from is null) = (window_days is null)),
  constraint offer_window_valid check (window_from is null or (window_from <> window_to
    and cardinality(window_days) between 1 and 7 and window_days <@ array[1,2,3,4,5,6,7]::smallint[])),
  -- Lets offer_redemptions and orders prove the offer belongs to the same restaurant.
  constraint offers_business_id_unique unique (business_id, id)
);
create index offers_business_code_idx on public.offers (business_id, code) where code is not null;
create index offers_business_mode_idx on public.offers (business_id, apply_mode);

-- One row per order that used an offer. A use counts only while its order is not cancelled, so cancelling an
-- order gives the use back with no extra bookkeeping. Customers have no access; owners read their own rows.
create table public.offer_redemptions (
  id uuid primary key default gen_random_uuid(),
  offer_id uuid not null,
  order_id uuid not null constraint offer_redemptions_one_per_order unique,
  customer_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint offer_redemptions_offer_fk foreign key (business_id, offer_id) references public.offers (business_id, id),
  constraint offer_redemptions_order_fk foreign key (business_id, order_id) references public.orders (business_id, id) on delete cascade
);
create index offer_redemptions_offer_idx on public.offer_redemptions (offer_id);
create index offer_redemptions_customer_idx on public.offer_redemptions (customer_id, business_id);

-- Rejected code lookups, per customer, for the rate limit (lookups that find an applicable code are not logged).
-- Outside the Data API; written only by definer functions.
create table offers_private.code_attempts (
  id bigint generated always as identity primary key,
  customer_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp()
);
create index code_attempts_customer_idx on offers_private.code_attempts (customer_id, created_at);
alter table offers_private.code_attempts enable row level security;
revoke all on table offers_private.code_attempts from public, anon, authenticated, service_role;

-- 3. Orders: the discount and a snapshot of the offer ---------------------------------------------
alter table public.orders drop constraint orders_check;
alter table public.orders
  add column discount_paise integer not null default 0 constraint orders_discount_nonnegative check (discount_paise >= 0),
  add column offer_id uuid,
  add column offer_name text,
  add column offer_code text,
  add column offer_kind text constraint orders_offer_kind_valid check (offer_kind is null or offer_kind in ('percent','flat','free_delivery'));
alter table public.orders
  add constraint orders_offer_fk foreign key (business_id, offer_id) references public.offers (business_id, id),
  add constraint orders_total_matches check (total_paise = subtotal_paise + delivery_fee_paise - discount_paise),
  add constraint orders_total_nonnegative check (total_paise >= 0),
  add constraint orders_offer_snapshot check (
    (offer_id is null and offer_name is null and offer_code is null and offer_kind is null and discount_paise = 0)
    or (offer_id is not null and offer_name is not null and offer_kind is not null and discount_paise > 0)),
  add constraint orders_free_delivery_discount check (offer_kind is distinct from 'free_delivery' or discount_paise = delivery_fee_paise);
-- A rejected key replays as the same outcome: offer_reason is set when the rejection was an offer change, and
-- offer_retry_after (seconds) when that reason is rate_limited.
alter table public.checkout_pricing_rejections add column offer_reason text, add column offer_retry_after integer;

-- 4. Triggers -------------------------------------------------------------------------------------
-- Normalises the code, bumps version/updated_at, keeps identity fixed, locks terms once an offer has been used
-- (name, end date and paused stay editable) and keeps a code unique among the restaurant's not-ended offers.
-- UPDATE first takes the offer's advisory key, the one checkout holds while it redeems the offer, so an edit either
-- waits for an in-flight first redemption and then sees it (and is refused), or commits before checkout looks. The edit
-- holds only that key and the offer row lock (a non-key UPDATE lock), and checkout's foreign keys take KEY SHARE, which
-- that lock does not conflict with, so a single-offer UPDATE and a checkout cannot form a cycle. A statement that edits
-- several offers locks their keys in scan order, so either side of such a race can be chosen as a deadlock victim
-- (40P01): edit one offer per statement.
-- Offers are never deleted: owners pause, resume or end them. There is no DELETE grant or policy for clients, and no
-- DELETE trigger, because a DELETE locks the row FOR UPDATE before any trigger runs and that conflicts with checkout's
-- KEY SHARE, which would make the checkout a deadlock victim.
create function offers_private.guard_offer() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    perform pg_advisory_xact_lock(hashtextextended('offer:' || old.id::text, 0));
  end if;
  if new.code is not null then new.code := upper(btrim(new.code)); end if;
  if tg_op = 'UPDATE' then
    if new.id <> old.id or new.business_id <> old.business_id then
      raise exception 'offer identity is immutable' using errcode = '22023';
    end if;
    new.created_at := old.created_at;
    new.version := old.version + 1;
    new.updated_at := now();
    if exists (select 1 from public.offer_redemptions r where r.offer_id = old.id) and
       (new.kind, new.value, new.max_discount_paise, new.min_order_paise, new.apply_mode, new.code, new.first_order_only,
        new.per_customer_limit, new.total_limit, new.starts_at, new.window_from, new.window_to, new.window_days)
       is distinct from
       (old.kind, old.value, old.max_discount_paise, old.min_order_paise, old.apply_mode, old.code, old.first_order_only,
        old.per_customer_limit, old.total_limit, old.starts_at, old.window_from, old.window_to, old.window_days) then
      raise exception 'offer terms are locked once it has been used' using errcode = 'PT409', detail = 'OFFER_LOCKED';
    end if;
  end if;
  if new.apply_mode = 'code' and new.code is not null and (new.ends_at is null or new.ends_at > now()) then
    perform pg_advisory_xact_lock(hashtextextended('offer-code-owner:' || new.business_id::text || ':' || new.code, 0));
    if exists (select 1 from public.offers o where o.business_id = new.business_id and o.code = new.code and o.id <> new.id
               and (o.ends_at is null or o.ends_at > now())) then
      raise exception 'code is already in use by another active or scheduled offer' using errcode = '23505', constraint = 'offers_code_not_ended_unique';
    end if;
  end if;
  return new;
end $$;
create trigger offers_guard before insert or update on public.offers
  for each row execute function offers_private.guard_offer();

-- 5. Pricing helpers (private) --------------------------------------------------------------------
-- Is the daily window open at p_now (evaluated in Asia/Kolkata)? No window means always open.
create function offers_private.window_open(o public.offers, p_now timestamptz) returns boolean
language plpgsql immutable set search_path = '' as $$
declare local_ts timestamp := p_now at time zone 'Asia/Kolkata'; t time; dow integer; prev integer;
begin
  if o.window_from is null then return true; end if;
  t := local_ts::time; dow := extract(isodow from local_ts)::integer; prev := case when dow = 1 then 7 else dow - 1 end;
  if o.window_from < o.window_to then
    return dow = any(o.window_days) and t >= o.window_from and t < o.window_to;
  end if;
  return (dow = any(o.window_days) and t >= o.window_from) or (prev = any(o.window_days) and t < o.window_to);
end $$;

-- Why an offer does or does not apply, and what it takes off. reason is null when it applies. Uses count only
-- non-cancelled orders. p_customer null skips the customer checks; p_subtotal null skips min order and amount.
-- Runs with the privileges of the definer function that calls it.
create function offers_private.evaluate(o public.offers, p_customer uuid, p_subtotal bigint, p_fee bigint, p_now timestamptz)
returns table (reason text, discount bigint, shortfall bigint)
language plpgsql stable set search_path = '' as $$
declare used bigint; d bigint;
begin
  discount := 0; shortfall := null; reason := null;
  if o.paused then reason := 'paused';
  elsif o.ends_at is not null and o.ends_at <= p_now then reason := 'ended';
  elsif o.starts_at is not null and o.starts_at > p_now then reason := 'not_started';
  elsif not offers_private.window_open(o, p_now) then reason := 'outside_window';
  end if;
  if reason is null and o.total_limit is not null then
    select count(*) into used from public.offer_redemptions r join public.orders x on x.id = r.order_id
      where r.offer_id = o.id and x.status <> 'cancelled';
    if used >= o.total_limit then reason := 'used_up'; end if;
  end if;
  if reason is null and p_customer is not null then
    if o.first_order_only and exists (select 1 from public.orders x where x.customer_id = p_customer
         and x.business_id = o.business_id and x.status <> 'cancelled') then
      reason := 'first_order_only';
    elsif o.per_customer_limit is not null then
      select count(*) into used from public.offer_redemptions r join public.orders x on x.id = r.order_id
        where r.offer_id = o.id and r.customer_id = p_customer and x.status <> 'cancelled';
      if used >= o.per_customer_limit then reason := 'per_customer_limit'; end if;
    end if;
  end if;
  if reason is null and p_subtotal is not null then
    if p_subtotal < o.min_order_paise then
      reason := 'min_order'; shortfall := o.min_order_paise - p_subtotal;
    else
      d := case o.kind
        when 'percent' then least(p_subtotal * o.value / 100, coalesce(o.max_discount_paise, p_subtotal))
        when 'flat' then least(o.value::bigint, p_subtotal)
        else p_fee end;
      if d <= 0 then reason := 'no_benefit'; else discount := d; end if;
    end if;
  end if;
  return next;
end $$;

-- Takes the locks for place_order and returns the offers it may consider. With a code: the customer's code-attempt
-- key, then that offer. Without: every not-ended automatic offer, in ascending id order. place_order only considers
-- the returned ids, so an offer created after this call can never be used unlocked.
create function offers_private.lock_offers(p_business uuid, p_customer uuid, p_code text) returns uuid[]
language plpgsql security definer set search_path = '' as $$
declare ids uuid[]; one uuid; now_ts timestamptz := clock_timestamp();
begin
  if p_code is not null then
    perform pg_advisory_xact_lock(hashtextextended('offer-code:' || p_customer::text, 0));
    ids := array(select o.id from public.offers o where o.business_id = p_business and o.code = p_code
      and (o.ends_at is null or o.ends_at > now_ts) order by o.id);
  else
    ids := array(select o.id from public.offers o where o.business_id = p_business and o.apply_mode = 'automatic'
      and (o.ends_at is null or o.ends_at > now_ts) order by o.id);
  end if;
  foreach one in array ids loop
    perform pg_advisory_xact_lock(hashtextextended('offer:' || one::text, 0));
  end loop;
  return ids;
end $$;

-- Picks the offer for a cart. p_code null: the best eligible automatic offer (largest discount; ties go to the
-- earliest created, then the lowest id). p_code set: only that code is considered, never silently replaced by an
-- automatic offer. Returns {offer, discount_paise, error, nudge}. Failed code lookups are rate limited per customer:
-- 10 rejected lookups in 10 minutes. A lookup is rejected unless the code exists and applies (a cart below the
-- offer's minimum is not a rejection); only rejected lookups are logged. Rate-limited lookups are not logged either,
-- so they never extend the wait.
-- Every code failure RETURNS (never raises) so its log row commits; nothing after this call raises on a hit only.
create function offers_private.resolve(p_business uuid, p_customer uuid, p_code text, p_subtotal bigint, p_fee bigint, p_allowed uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  now_ts timestamptz := clock_timestamp(); o public.offers%rowtype; ev record; norm text;
  best public.offers%rowtype; best_discount bigint := 0; nudge_offer public.offers%rowtype; nudge_short bigint;
  rejected_count integer; oldest timestamptz; failure jsonb;
begin
  if p_code is not null then
    norm := upper(btrim(p_code));
    perform pg_advisory_xact_lock(hashtextextended('offer-code:' || p_customer::text, 0));
    delete from offers_private.code_attempts where customer_id = p_customer and created_at < now_ts - interval '1 hour';
    select count(*), min(created_at) into rejected_count, oldest from offers_private.code_attempts
      where customer_id = p_customer and created_at > now_ts - interval '10 minutes';
    if rejected_count >= 10 then
      return jsonb_build_object('offer', null, 'discount_paise', 0, 'nudge', null, 'error', jsonb_build_object('reason', 'rate_limited',
        'retry_after_seconds', greatest(1, ceil(extract(epoch from oldest + interval '10 minutes' - now_ts))::integer)));
    end if;
    if norm ~ '^[A-Z0-9]{4,15}$' then
      select * into o from public.offers x where x.business_id = p_business and x.code = norm
        and (x.ends_at is null or x.ends_at > now_ts) and (p_allowed is null or x.id = any(p_allowed));
    end if;
    if o.id is null then
      failure := jsonb_build_object('reason', case when norm ~ '^[A-Z0-9]{4,15}$' and exists (select 1 from public.offers x
        where x.business_id = p_business and x.code = norm) then 'ended' else 'not_found' end);
    else
      select * into ev from offers_private.evaluate(o, p_customer, p_subtotal, p_fee, now_ts);
      if ev.reason is not null then
        failure := jsonb_build_object('reason', ev.reason) || case when ev.shortfall is null then '{}'::jsonb
          else jsonb_build_object('shortfall_paise', ev.shortfall) end;
      end if;
    end if;
    -- A cart below the offer's minimum is not a rejection: the code itself was fine.
    if failure is not null and failure->>'reason' <> 'min_order' then
      insert into offers_private.code_attempts(customer_id, business_id) values (p_customer, p_business);
    end if;
    if failure is not null then
      return jsonb_build_object('offer', null, 'discount_paise', 0, 'nudge', null, 'error', failure);
    end if;
    return jsonb_build_object('offer', jsonb_build_object('id', o.id, 'name', o.name, 'code', o.code, 'kind', o.kind),
      'discount_paise', ev.discount, 'nudge', null, 'error', null);
  end if;

  for o in select * from public.offers x where x.business_id = p_business and x.apply_mode = 'automatic'
      and (p_allowed is null or x.id = any(p_allowed)) order by x.created_at, x.id loop
    select * into ev from offers_private.evaluate(o, p_customer, p_subtotal, p_fee, now_ts);
    if ev.reason is null then
      if ev.discount > best_discount then best := o; best_discount := ev.discount; end if;
    elsif ev.reason = 'min_order' and (nudge_short is null or ev.shortfall < nudge_short) then
      nudge_offer := o; nudge_short := ev.shortfall;
    end if;
  end loop;
  return jsonb_build_object('error', null, 'discount_paise', best_discount,
    'offer', case when best.id is null then null else jsonb_build_object('id', best.id, 'name', best.name, 'code', best.code, 'kind', best.kind) end,
    'nudge', case when nudge_offer.id is null then null else jsonb_build_object('offer_id', nudge_offer.id, 'name', nudge_offer.name,
      'kind', nudge_offer.kind, 'value', nudge_offer.value, 'shortfall_paise', nudge_short) end);
end $$;

-- Validates and prices the cart lines. Messages and SQLSTATEs are the ones place_order always used.
-- p_lock takes FOR SHARE on the menu rows (checkout); the quote reads them without locks.
create function offers_private.price_items(p_business uuid, p_items jsonb, p_lock boolean)
returns table (subtotal bigint, lines jsonb) language plpgsql security definer set search_path = '' as $$
declare item jsonb; menu public.menu_items%rowtype; item_id uuid; qty integer; seen uuid[] := array[]::uuid[];
begin
  subtotal := 0; lines := '[]'::jsonb;
  if jsonb_typeof(p_items) is distinct from 'array' then raise exception 'invalid items' using errcode = '22023'; end if;
  if jsonb_array_length(p_items) not between 1 and 20 then raise exception 'invalid items' using errcode = '22023'; end if;
  for item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(item) is distinct from 'object' or coalesce(item->>'menu_item_id','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' or
      coalesce(item->>'quantity','') !~ '^[1-9][0-9]?$' then raise exception 'invalid item' using errcode = '22023'; end if;
    item_id := (item->>'menu_item_id')::uuid; qty := (item->>'quantity')::integer;
    if qty > 10 or item_id = any(seen) then raise exception 'invalid item quantity or duplicate' using errcode = '22023'; end if;
    seen := array_append(seen, item_id);
    if p_lock then
      select * into menu from public.menu_items where id = item_id and business_id = p_business and available for share;
    else
      select * into menu from public.menu_items where id = item_id and business_id = p_business and available;
    end if;
    if not found then raise exception 'item unavailable' using errcode = '22023'; end if;
    subtotal := subtotal + menu.price_paise::bigint * qty;
    lines := lines || jsonb_build_array(jsonb_build_object('menu_item_id', menu.id, 'quantity', qty, 'unit_price_paise', menu.price_paise, 'line_total_paise', menu.price_paise::bigint * qty));
  end loop;
  return next;
end $$;

-- The quote place_order compares with the accepted pricing. With no offer it has exactly the keys it always had.
create function offers_private.build_quote(p_fee integer, p_min integer, p_subtotal bigint, p_lines jsonb, p_resolution jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('lines', p_lines, 'delivery_fee_paise', p_fee, 'min_order_paise', p_min, 'subtotal_paise', p_subtotal,
    'total_paise', p_subtotal + p_fee - (p_resolution->>'discount_paise')::bigint)
    || case when p_resolution->'offer' = 'null'::jsonb then '{}'::jsonb
       else jsonb_build_object('discount_paise', (p_resolution->>'discount_paise')::bigint, 'offer', p_resolution->'offer') end
$$;

-- 6. Customer RPCs (private definer, public invoker wrapper) --------------------------------------
-- Active automatic offers, readable by anyone including signed-out visitors. Never codes, limits or counts.
create function offers_private.list_active_offers(p_business_slug text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare b uuid; now_ts timestamptz := clock_timestamp();
begin
  select id into b from public.businesses where slug = p_business_slug;
  if not found then raise exception 'business unavailable' using errcode = '22023'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'kind', o.kind, 'value', o.value,
      'max_discount_paise', o.max_discount_paise, 'min_order_paise', o.min_order_paise, 'first_order_only', o.first_order_only,
      'ends_at', o.ends_at, 'window', case when o.window_from is null then null else jsonb_build_object(
        'from', to_char(o.window_from, 'HH24:MI'), 'to', to_char(o.window_to, 'HH24:MI'), 'days', to_jsonb(o.window_days)) end)
      order by o.created_at, o.id)
    from public.offers o
    where o.business_id = b and o.apply_mode = 'automatic' and not o.paused
      and (o.starts_at is null or o.starts_at <= now_ts) and (o.ends_at is null or o.ends_at > now_ts)
      and offers_private.window_open(o, now_ts)
      and (o.total_limit is null or (select count(*) from public.offer_redemptions r join public.orders x on x.id = r.order_id
            where r.offer_id = o.id and x.status <> 'cancelled') < o.total_limit)), '[]'::jsonb);
end $$;
create function public.list_active_offers(p_business_slug text) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select offers_private.list_active_offers(p_business_slug)
$$;

-- Does this code apply for this customer at this restaurant? Rate limited. The cart minimum is checked by the quote.
create function offers_private.check_offer_code(p_business_slug text, p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare caller uuid := auth.uid(); b uuid; r jsonb; o public.offers%rowtype;
begin
  if caller is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if p_code is null or char_length(p_code) > 64 then raise exception 'invalid offer code' using errcode = '22023'; end if;
  select id into b from public.businesses where slug = p_business_slug;
  if not found then raise exception 'business unavailable' using errcode = '22023'; end if;
  r := offers_private.resolve(b, caller, p_code, null, null, null);
  if r->'error' <> 'null'::jsonb then
    return jsonb_build_object('applies', false, 'reason', r->'error'->>'reason', 'retry_after_seconds', r->'error'->'retry_after_seconds', 'offer', null);
  end if;
  select * into strict o from public.offers where id = (r->'offer'->>'id')::uuid;
  return jsonb_build_object('applies', true, 'reason', null, 'retry_after_seconds', null, 'offer', jsonb_build_object(
    'id', o.id, 'name', o.name, 'kind', o.kind, 'value', o.value, 'max_discount_paise', o.max_discount_paise,
    'min_order_paise', o.min_order_paise, 'first_order_only', o.first_order_only));
end $$;
create function public.check_offer_code(p_business_slug text, p_code text) returns jsonb
language sql security invoker set search_path = '' as $$
  select offers_private.check_offer_code(p_business_slug, p_code)
$$;

-- The server's quote for a cart: what place_order will compare with the accepted pricing. A code that does not
-- apply is reported in offer_error and the cart is priced without it (as the best automatic offer would apply).
create function offers_private.quote_order(p_business_slug text, p_items jsonb, p_offer_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare caller uuid := auth.uid(); b public.businesses%rowtype; priced record; r jsonb; code text; offer_error jsonb;
begin
  if caller is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if p_offer_code is not null and char_length(p_offer_code) > 64 then raise exception 'invalid offer code' using errcode = '22023'; end if;
  code := nullif(upper(btrim(p_offer_code)), '');
  select * into b from public.businesses where slug = p_business_slug;
  if not found then raise exception 'business unavailable' using errcode = '22023'; end if;
  select * into priced from offers_private.price_items(b.id, p_items, false);
  r := offers_private.resolve(b.id, caller, code, priced.subtotal, b.delivery_fee_paise, null);
  if r->'error' <> 'null'::jsonb then
    offer_error := r->'error';
    r := offers_private.resolve(b.id, caller, null, priced.subtotal, b.delivery_fee_paise, null);
  end if;
  return jsonb_build_object('outcome', 'quoted',
    'pricing', offers_private.build_quote(b.delivery_fee_paise, b.min_order_paise, priced.subtotal, priced.lines, r),
    'offer_error', offer_error, 'nudge', r->'nudge');
end $$;
create function public.quote_order(p_business_slug text, p_items jsonb, p_offer_code text default null) returns jsonb
language sql security invoker set search_path = '' as $$
  select offers_private.quote_order(p_business_slug, p_items, p_offer_code)
$$;

-- 7. Checkout --------------------------------------------------------------------------------------
-- The previous definer place_order is replaced by the private implementation below. The six-argument
-- public signature stays as a wrapper so clients built before offers keep working unchanged.
drop function public.place_order(text, jsonb, jsonb, jsonb, uuid, jsonb);

create function offers_private.place_order(p_business_slug text, p_items jsonb, p_delivery jsonb, p_location jsonb, p_idempotency_key uuid, p_accepted_pricing jsonb, p_offer_code text)
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
create function public.place_order(p_business_slug text, p_items jsonb, p_delivery jsonb, p_location jsonb, p_idempotency_key uuid, p_accepted_pricing jsonb, p_offer_code text)
returns jsonb language sql security invoker set search_path = '' as $$
  select offers_private.place_order(p_business_slug, p_items, p_delivery, p_location, p_idempotency_key, p_accepted_pricing, p_offer_code)
$$;
create function public.place_order(p_business_slug text, p_items jsonb, p_delivery jsonb, p_location jsonb, p_idempotency_key uuid, p_accepted_pricing jsonb)
returns jsonb language sql security invoker set search_path = '' as $$
  select offers_private.place_order(p_business_slug, p_items, p_delivery, p_location, p_idempotency_key, p_accepted_pricing, null)
$$;

-- 8. Row-level security ---------------------------------------------------------------------------
alter table public.offers enable row level security;
alter table public.offer_redemptions enable row level security;
-- Owners (admin members) manage their own restaurant's offers. Nobody else can read or write the table:
-- customers get active automatic offers through list_active_offers and check a code through check_offer_code.
create policy offers_admin_select on public.offers for select to authenticated using (public.is_business_admin(business_id));
create policy offers_admin_insert on public.offers for insert to authenticated with check (public.is_business_admin(business_id));
create policy offers_admin_update on public.offers for update to authenticated
  using (public.is_business_admin(business_id)) with check (public.is_business_admin(business_id));
create policy offer_redemptions_admin_select on public.offer_redemptions for select to authenticated using (public.is_business_admin(business_id));
-- No Realtime: neither table is added to supabase_realtime.

-- 9. Grants ----------------------------------------------------------------------------------------
revoke all on public.offers, public.offer_redemptions from public, anon, authenticated;
grant select on public.offers, public.offer_redemptions to authenticated;
-- id, version and the timestamps are owned by defaults and the trigger.
grant insert (business_id, name, kind, value, max_discount_paise, min_order_paise, apply_mode, code, first_order_only,
    per_customer_limit, total_limit, starts_at, ends_at, window_from, window_to, window_days, paused),
  update (name, kind, value, max_discount_paise, min_order_paise, apply_mode, code, first_order_only,
    per_customer_limit, total_limit, starts_at, ends_at, window_from, window_to, window_days, paused)
  on public.offers to authenticated;
grant all on public.offers, public.offer_redemptions to service_role;

-- Default privileges grant EXECUTE broadly: revoke everything, then grant explicitly.
revoke all on function
  offers_private.guard_offer(), offers_private.window_open(public.offers, timestamptz),
  offers_private.evaluate(public.offers, uuid, bigint, bigint, timestamptz), offers_private.lock_offers(uuid, uuid, text),
  offers_private.resolve(uuid, uuid, text, bigint, bigint, uuid[]), offers_private.price_items(uuid, jsonb, boolean),
  offers_private.build_quote(integer, integer, bigint, jsonb, jsonb),
  offers_private.list_active_offers(text), public.list_active_offers(text),
  offers_private.check_offer_code(text, text), public.check_offer_code(text, text),
  offers_private.quote_order(text, jsonb, text), public.quote_order(text, jsonb, text),
  offers_private.place_order(text, jsonb, jsonb, jsonb, uuid, jsonb, text),
  public.place_order(text, jsonb, jsonb, jsonb, uuid, jsonb, text), public.place_order(text, jsonb, jsonb, jsonb, uuid, jsonb)
  from public, anon, authenticated, service_role;
-- Signed-out visitors may list active automatic offers.
grant execute on function offers_private.list_active_offers(text), public.list_active_offers(text) to anon, authenticated;
-- Signed-in customers (each function checks the caller itself).
grant execute on function
  offers_private.check_offer_code(text, text), public.check_offer_code(text, text),
  offers_private.quote_order(text, jsonb, text), public.quote_order(text, jsonb, text),
  offers_private.place_order(text, jsonb, jsonb, jsonb, uuid, jsonb, text),
  public.place_order(text, jsonb, jsonb, jsonb, uuid, jsonb, text), public.place_order(text, jsonb, jsonb, jsonb, uuid, jsonb)
  to authenticated;
