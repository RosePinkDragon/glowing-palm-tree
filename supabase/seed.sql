-- Demonstration catalog only; no service boundary has been verified.
insert into public.businesses (id, slug, name, is_demo) values
  ('10000000-0000-4000-8000-000000000001', 'ammu-sammu', 'Ammu Sammu', true),
  ('10000000-0000-4000-8000-000000000002', 'konkan-fine-dine', 'Kokani Dine Inn', true)
on conflict (slug) do nothing;
insert into public.menu_items (id, business_id, name, description, category, price_paise, is_demo)
select v.id, b.id, v.name, 'Example item for demonstration', 'Demo', v.price, true
from (values
  ('20000000-0000-4000-8000-000000000001'::uuid, 'ammu-sammu', 'Demo meal', 15000),
  ('20000000-0000-4000-8000-000000000002'::uuid, 'konkan-fine-dine', 'Demo meal', 18000)
) v(id, slug, name, price) join public.businesses b on b.slug = v.slug
on conflict (id) do nothing;
