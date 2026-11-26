-- #253 slice 1: per-restaurant opening hours, owner-editable, enforced by the server.
--
-- Representation. businesses.opens_at / closes_at are wall-clock times in India time (Asia/Kolkata), minute precision,
-- one window per day. Both null means no hours are set and the restaurant is open all day. The window is
-- [opens_at, closes_at): opening is inclusive, closing is exclusive. A closing time of 00:00 means midnight at the END of
-- the day (so 11:00 to 00:00 is 11:00 to midnight); 24:00 is never stored (the owner RPC normalises it to 00:00 and the check
-- rejects it), so midnight has exactly one representation. Nothing crosses into the next day: a window needs
-- opens_at < closes_at, or closes_at = 00:00 with opens_at after 00:00. opens_at = closes_at is invalid.
--
-- Enforcement is in offers_private.price_items, which quote_order and place_order both call; place_order calls it only
-- after its idempotent-replay lookup, so a replay of an order already placed still returns outside hours. A closed
-- restaurant is refused with SQLSTATE PT409 (the same as the owner's open/closed switch, HTTP 409), DETAIL
-- 'OUTSIDE_HOURS' and HINT = the opening time as HH:MM. The switch (accepting_orders, #58) still applies within hours.
--
-- Lock order (docs/RELEASE.md): unchanged. save_opening_hours takes users KEY SHARE and sessions SHARE
-- (require_active_session), then the business row FOR NO KEY UPDATE, then the owner's membership FOR SHARE, exactly as
-- save_restaurant_settings. Checkout holds the business row FOR SHARE, so an hours edit waits for a checkout in flight
-- and a later checkout sees the new hours; the hours check reads the business row inside that lock. No new lock.

alter table public.businesses add column opens_at time(0), add column closes_at time(0);
alter table public.businesses add constraint business_opening_hours_valid check (
  (opens_at is null and closes_at is null) or (
    opens_at is not null and closes_at is not null
    and opens_at >= time '00:00' and opens_at < time '24:00' and closes_at >= time '00:00' and closes_at < time '24:00'
    and extract(second from opens_at) = 0 and extract(second from closes_at) = 0
    and opens_at <> closes_at and (opens_at < closes_at or closes_at = time '00:00')
  )
);

-- Owner decisions (26 Nov 2026), set only where nothing has been set. A fresh project has no restaurant rows when
-- migrations run; docs/RELEASE.md carries the same two statements for the trusted setup step.
update public.businesses set opens_at = time '11:00', closes_at = time '00:00'
  where slug = 'kokani-dine-inn' and opens_at is null and closes_at is null;
update public.businesses set opens_at = time '09:00', closes_at = time '19:30'
  where slug = 'ammu-sammu' and opens_at is null and closes_at is null;

-- Hours are owner-editable settings: they bump settings_version like the other four.
drop trigger restaurant_settings_version on public.businesses;
create trigger restaurant_settings_version before update of contact_phone, whatsapp_phone, delivery_fee_paise, min_order_paise, opens_at, closes_at
  on public.businesses for each row execute function restaurant_settings_private.bump_version();

-- Pure: is the instant p_at inside the window? Null hours mean always open.
create function public.business_open_at(p_opens time, p_closes time, p_at timestamptz)
returns boolean language sql stable set search_path = '' as $$
  select case when p_opens is null or p_closes is null then true
    else (p_at at time zone 'Asia/Kolkata')::time >= p_opens
      and ((p_at at time zone 'Asia/Kolkata')::time < p_closes or p_closes = time '00:00') end
$$;
-- A restaurant's hours at p_at (default now). Unknown restaurants are never open. Invoker rights: businesses is public.
create function public.business_open_now(p_business uuid, p_at timestamptz default now())
returns boolean language sql stable set search_path = '' as $$
  select coalesce((select public.business_open_at(b.opens_at, b.closes_at, p_at) from public.businesses b where b.id = p_business), false)
$$;

-- Owner edit. Same checks, order and optimistic concurrency as save_settings; the form sends both times, or both null
-- to clear the hours. '24:00' is accepted as midnight and stored as 00:00.
create function restaurant_settings_private.save_opening_hours(p_business_slug text, p_opens_at time, p_closes_at time, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare caller uuid := auth.uid(); b public.businesses%rowtype; closes time := p_closes_at;
begin
  if caller is null then raise exception 'authentication required' using errcode = '42501'; end if;
  perform customer_lifecycle_private.require_active_session(caller);
  select * into b from public.businesses where slug = p_business_slug for no key update;
  if not found then raise exception 'business unavailable' using errcode = '42501'; end if;
  perform 1 from public.business_memberships where business_id = b.id and user_id = caller and role = 'admin' for share;
  if not found then raise exception 'business unavailable' using errcode = '42501'; end if;
  if p_expected_version is null or p_expected_version <> b.settings_version then
    raise exception 'restaurant details changed; refresh before saving' using errcode = '40001';
  end if;
  if closes = time '24:00' then closes := time '00:00'; end if;
  if (p_opens_at is null) <> (closes is null) then
    raise exception 'Set both opening and closing times, or neither.' using errcode = '22023', detail = 'openingHours';
  end if;
  if p_opens_at is not null then
    if p_opens_at < time '00:00' or p_opens_at >= time '24:00' or extract(second from p_opens_at) <> 0 then
      raise exception 'Enter an opening time in whole minutes.' using errcode = '22023', detail = 'opensAt';
    end if;
    if closes < time '00:00' or closes >= time '24:00' or extract(second from closes) <> 0 then
      raise exception 'Enter a closing time in whole minutes.' using errcode = '22023', detail = 'closesAt';
    end if;
    if p_opens_at = closes or not (p_opens_at < closes or closes = time '00:00') then
      raise exception 'Closing must be after opening on the same day (midnight is allowed).' using errcode = '22023', detail = 'closesAt';
    end if;
  end if;
  update public.businesses set opens_at = p_opens_at, closes_at = closes where id = b.id returning * into b;
  return jsonb_build_object('opens_at', to_char(b.opens_at, 'HH24:MI'), 'closes_at', to_char(b.closes_at, 'HH24:MI'), 'settings_version', b.settings_version);
end $$;
create function public.save_opening_hours(p_business_slug text, p_opens_at time, p_closes_at time, p_expected_version integer)
returns jsonb language sql security invoker set search_path = '' as $$
  select restaurant_settings_private.save_opening_hours(p_business_slug, p_opens_at, p_closes_at, p_expected_version)
$$;

revoke all on function public.business_open_at(time,time,timestamptz), public.business_open_now(uuid,timestamptz),
  restaurant_settings_private.save_opening_hours(text,time,time,integer), public.save_opening_hours(text,time,time,integer)
  from public, anon, authenticated;
grant execute on function public.business_open_at(time,time,timestamptz), public.business_open_now(uuid,timestamptz) to anon, authenticated;
grant execute on function restaurant_settings_private.save_opening_hours(text,time,time,integer), public.save_opening_hours(text,time,time,integer) to authenticated;

-- Shared pricing (copied exactly from 20261126120100_refuse_demo_restaurants.sql); the ONLY change is the added
-- hours check directly after the demo check.
create or replace function offers_private.price_items(p_business uuid, p_items jsonb, p_lock boolean)
returns table (subtotal bigint, lines jsonb) language plpgsql security definer set search_path = '' as $$
declare item jsonb; menu public.menu_items%rowtype; item_id uuid; qty integer; seen uuid[] := array[]::uuid[];
begin
  if exists (select 1 from public.businesses where id = p_business and is_demo) then
    raise exception 'demo restaurant cannot take orders' using errcode = '22023', detail = 'DEMO_RESTAURANT';
  end if;
  -- #253: outside the opening hours (India time). PT409 like the open/closed switch; the hint is the opening time.
  if not public.business_open_now(p_business) then
    raise exception 'restaurant is outside its opening hours' using errcode = 'PT409', detail = 'OUTSIDE_HOURS',
      hint = (select to_char(opens_at, 'HH24:MI') from public.businesses where id = p_business);
  end if;
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
      select * into menu from public.menu_items where id = item_id and business_id = p_business and available and not is_demo for share;
    else
      select * into menu from public.menu_items where id = item_id and business_id = p_business and available and not is_demo;
    end if;
    if not found then raise exception 'item unavailable' using errcode = '22023'; end if;
    subtotal := subtotal + menu.price_paise::bigint * qty;
    lines := lines || jsonb_build_array(jsonb_build_object('menu_item_id', menu.id, 'quantity', qty, 'unit_price_paise', menu.price_paise, 'line_total_paise', menu.price_paise::bigint * qty));
  end loop;
  return next;
end $$;
