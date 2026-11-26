-- #243: the server refused only unavailable dishes, so a sample (is_demo) dish marked available could be quoted and
-- ordered by any client calling the RPC directly. offers_private.price_items is the one place both
-- offers_private.quote_order and offers_private.place_order validate cart lines, so the refusal lives here and covers
-- both. A sample dish fails exactly like an unavailable one ('item unavailable', 22023), which the app already maps.
-- place_order replays an existing order before it prices anything, so an order placed earlier is still returned.
-- Body identical to 20261120070000_offers_and_pricing.sql except the two "and not is_demo" predicates. CREATE OR
-- REPLACE keeps the owner, the security definer setting, search_path and the grants (none for client roles).
create or replace function offers_private.price_items(p_business uuid, p_items jsonb, p_lock boolean)
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
