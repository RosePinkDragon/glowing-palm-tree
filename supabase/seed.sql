-- Demonstration catalog only; no service boundary has been verified.
insert into public.businesses (id, slug, name, is_demo, order_prefix) values
  ('10000000-0000-4000-8000-000000000001', 'ammu-sammu', 'Ammu Sammu', true, 'AMS'),
  ('10000000-0000-4000-8000-000000000002', 'kokani-dine-inn', 'Kokani Dine Inn', true, 'KDI')
on conflict (slug) do nothing;
-- Owner-supplied kitchen points (#48). The baseline creates no restaurant rows or kitchen points;
-- these are set here for the demonstration rows only (see docs/RELEASE.md for production setup).
do $$ declare ns text; begin
  select n.nspname into strict ns from pg_catalog.pg_extension e
    join pg_catalog.pg_namespace n on n.oid = e.extnamespace where e.extname = 'postgis';
  execute format('update public.businesses set kitchen_location = %1$I.st_setsrid(%1$I.st_makepoint(73.3944946, 17.7190154), 4326) where slug = ''ammu-sammu'' and kitchen_location is null', ns);
  execute format('update public.businesses set kitchen_location = %1$I.st_setsrid(%1$I.st_makepoint(73.3988110, 17.7197215), 4326) where slug = ''kokani-dine-inn'' and kitchen_location is null', ns);
end $$;
insert into public.menu_categories(business_id, name)
select id, 'Demo' from public.businesses where slug in ('ammu-sammu', 'kokani-dine-inn')
on conflict (business_id, name) do nothing;
insert into public.menu_items (id, business_id, name, description, category_id, price_paise, is_demo)
select v.id, b.id, v.name, 'Example item for demonstration', c.id, v.price, true
from (values
  ('20000000-0000-4000-8000-000000000001'::uuid, 'ammu-sammu', 'Demo meal', 15000),
  ('20000000-0000-4000-8000-000000000002'::uuid, 'kokani-dine-inn', 'Demo meal', 18000)
) v(id, slug, name, price) join public.businesses b on b.slug = v.slug
join public.menu_categories c on c.business_id=b.id and c.name='Demo'
on conflict (id) do nothing;
