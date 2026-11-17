\set ON_ERROR_STOP on
-- Helpers for suites that place orders through the saved-address path. Apply once, after every migration.
-- Invoker rights, so each sees only what the calling role may see.
-- The exact quote place_order compares with its accepted-pricing argument, in cart order.
create function public.test_quote(p_slug text, p_items jsonb) returns jsonb language sql stable as $$
  with l as (
    select i.n, m.id, (i.v->>'quantity')::integer q, m.price_paise p
    from jsonb_array_elements(p_items) with ordinality i(v,n)
    join public.menu_items m on m.id = (i.v->>'menu_item_id')::uuid)
  select jsonb_build_object(
    'lines', coalesce((select jsonb_agg(jsonb_build_object('menu_item_id',id,'quantity',q,'unit_price_paise',p,'line_total_paise',p::bigint*q) order by n) from l),'[]'::jsonb),
    'delivery_fee_paise', b.delivery_fee_paise, 'min_order_paise', b.min_order_paise,
    'subtotal_paise', coalesce((select sum(p::bigint*q) from l),0),
    'total_paise', coalesce((select sum(p::bigint*q) from l),0) + b.delivery_fee_paise)
  from public.businesses b where b.slug = p_slug $$;
-- Saved-address delivery details for the calling customer's oldest saved address at its current version.
create function public.test_delivery(p_name text default 'Test Customer') returns jsonb language sql stable as $$
  select jsonb_build_object('name',p_name,'phone','123','address_id',a.id,'address_version',a.version)
  from public.customer_addresses a where a.customer_id = auth.uid() order by a.created_at, a.id limit 1 $$;
-- A catalog category for a restaurant (trusted fixture use, as the table owner).
create function public.test_category(p_business uuid, p_name text) returns uuid language sql as $$
  insert into public.menu_categories(business_id,name) values (p_business,p_name)
  on conflict (business_id,name) do update set name = excluded.name returning id $$;

-- Legacy checkout suites predate explicit join. Trusted fixture setup supplies both restaurant
-- relationships; production Auth has no such trigger. Lifecycle suite disables this per fixture.
create function public.test_customer_relationships() returns trigger language plpgsql security definer set search_path='' as $$
begin
  insert into public.customer_businesses(customer_id,business_id) select new.id,id from public.businesses;
  return new;
end $$;
revoke all on function public.test_customer_relationships() from public,anon,authenticated,service_role;
create trigger test_customer_relationships after insert on auth.users for each row execute function public.test_customer_relationships();
