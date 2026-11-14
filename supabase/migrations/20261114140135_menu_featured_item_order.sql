-- Keep existing dishes ordinary and preserve their current name order at rank 0.
-- Existing table grants and business-scoped RLS apply to these columns unchanged.
alter table public.menu_items
  add column is_featured boolean not null default false,
  add column sort_order integer not null default 0;
