-- Atomic owner reordering for dishes within a category and for categories (#102).
-- The client sends the complete order it saw. If the set of rows changed in
-- the meantime (another owner added, moved or deleted one), nothing is written
-- and the caller reloads: SQLSTATE 40001 "menu changed".
create function public.reorder_menu_items(p_business_slug text, p_category_id uuid, p_item_ids uuid[])
returns integer language plpgsql security definer set search_path = '' as $$
declare caller uuid := auth.uid(); business uuid; seen uuid[]; wanted uuid[];
begin
  if caller is null then raise exception 'authentication required' using errcode='42501'; end if;
  select b.id into business from public.businesses b where b.slug=p_business_slug;
  if not found then raise exception 'menu unavailable' using errcode='42501'; end if;
  perform 1 from public.business_memberships where business_id=business and user_id=caller and role='admin' for share;
  if not found then raise exception 'menu unavailable' using errcode='42501'; end if;
  if p_item_ids is null or array_position(p_item_ids, null) is not null
     or cardinality(p_item_ids) <> (select count(distinct x) from unnest(p_item_ids) x) then
    raise exception 'list each dish exactly once' using errcode='22023';
  end if;
  -- Locking the category blocks dishes being added to or moved into it.
  perform 1 from public.menu_categories where id=p_category_id and business_id=business for update;
  if not found then raise exception 'menu changed' using errcode='40001'; end if;
  select coalesce(array_agg(id order by id), '{}') into seen from
    (select m.id from public.menu_items m where m.business_id=business and m.category_id=p_category_id for update) locked;
  select coalesce(array_agg(x order by x), '{}') into wanted from unnest(p_item_ids) x;
  if seen <> wanted then raise exception 'menu changed' using errcode='40001'; end if;
  update public.menu_items m set sort_order=o.position - 1
  from unnest(p_item_ids) with ordinality o(id, position)
  where m.id=o.id and m.business_id=business and m.sort_order <> o.position - 1;
  return cardinality(p_item_ids);
end $$;

create function public.reorder_menu_categories(p_business_slug text, p_category_ids uuid[])
returns integer language plpgsql security definer set search_path = '' as $$
declare caller uuid := auth.uid(); business uuid; seen uuid[]; wanted uuid[];
begin
  if caller is null then raise exception 'authentication required' using errcode='42501'; end if;
  select b.id into business from public.businesses b where b.slug=p_business_slug;
  if not found then raise exception 'menu unavailable' using errcode='42501'; end if;
  perform 1 from public.business_memberships where business_id=business and user_id=caller and role='admin' for share;
  if not found then raise exception 'menu unavailable' using errcode='42501'; end if;
  if p_category_ids is null or array_position(p_category_ids, null) is not null
     or cardinality(p_category_ids) <> (select count(distinct x) from unnest(p_category_ids) x) then
    raise exception 'list each category exactly once' using errcode='22023';
  end if;
  -- Serialize category reorders per business without locking the business row,
  -- which checkout holds while placing orders.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('menu_categories:' || business::text, 0));
  select coalesce(array_agg(id order by id), '{}') into seen from
    (select c.id from public.menu_categories c where c.business_id=business for update) locked;
  select coalesce(array_agg(x order by x), '{}') into wanted from unnest(p_category_ids) x;
  if seen <> wanted then raise exception 'menu changed' using errcode='40001'; end if;
  update public.menu_categories c set sort_order=o.position - 1
  from unnest(p_category_ids) with ordinality o(id, position)
  where c.id=o.id and c.business_id=business and c.sort_order <> o.position - 1;
  return cardinality(p_category_ids);
end $$;
revoke all on function public.reorder_menu_items(text,uuid,uuid[]), public.reorder_menu_categories(text,uuid[]) from public, anon, authenticated;
grant execute on function public.reorder_menu_items(text,uuid,uuid[]), public.reorder_menu_categories(text,uuid[]) to authenticated;

-- Customer menus refresh when categories are added, renamed or reordered.
-- Categories are public catalog rows; the publication does not bypass RLS.
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'menu_categories') then
    alter publication supabase_realtime add table public.menu_categories;
  end if;
end $$;
