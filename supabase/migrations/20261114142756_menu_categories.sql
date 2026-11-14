-- Categories are public catalog data; membership controls every owner mutation.
create table public.menu_categories (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id),
  name text not null check (name = btrim(name) and char_length(name) between 1 and 100),
  sort_order integer not null default 0,
  unique (business_id, name),
  unique (business_id, id)
);
alter table public.menu_categories enable row level security;
revoke all on public.menu_categories from anon, authenticated;
grant select on public.menu_categories to anon, authenticated;
grant insert, update, delete on public.menu_categories to authenticated;
grant all on public.menu_categories to service_role;
create policy categories_public on public.menu_categories for select to anon, authenticated using (true);
create policy categories_admin_insert on public.menu_categories for insert to authenticated
  with check (public.is_business_admin(business_id));
create policy categories_admin_update on public.menu_categories for update to authenticated
  using (public.is_business_admin(business_id)) with check (public.is_business_admin(business_id));
create policy categories_admin_delete on public.menu_categories for delete to authenticated
  using (public.is_business_admin(business_id));
-- USING/WITH CHECK alone permits an owner of both businesses to transfer a row.
create function public.prevent_category_business_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.business_id is distinct from old.business_id then
    raise exception 'category business cannot be changed' using errcode = '22023';
  end if;
  return new;
end $$;
revoke all on function public.prevent_category_business_change() from public, anon, authenticated;
create trigger category_business_immutable before update on public.menu_categories
for each row execute function public.prevent_category_business_change();
-- Refuse invalid names rather than losing or silently truncating existing data.
do $$ begin
  if exists (select 1 from public.menu_items where char_length(btrim(category)) not between 1 and 100) then
    raise exception 'Existing category names must contain 1 to 100 trimmed characters';
  end if;
end $$;
insert into public.menu_categories(business_id, name)
select distinct business_id, btrim(category) from public.menu_items;
alter table public.menu_items add column category_id uuid;
update public.menu_items m set category_id=c.id from public.menu_categories c
where c.business_id=m.business_id and c.name=btrim(m.category);
alter table public.menu_items
  alter column category_id set not null,
  add constraint menu_items_category_business_fk foreign key (business_id, category_id)
    references public.menu_categories(business_id, id) on update restrict on delete restrict,
  drop column category;
create index menu_items_category_idx on public.menu_items(business_id, category_id);
