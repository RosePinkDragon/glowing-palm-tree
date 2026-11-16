-- Owners' daily cash and order summary (#61). Days run midnight to midnight,
-- India time. Delivered means the cash was collected, so cash counts orders
-- delivered during the day (by their "delivered" history step), at the totals
-- stored when the order was placed. Cancelled orders are counted, never cash.
-- "Still to collect now" is the current open total across all placement dates.
create function public.daily_summary(p_business_slug text, p_date date default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  caller uuid := auth.uid(); business uuid;
  day date := coalesce(p_date, (pg_catalog.now() at time zone 'Asia/Kolkata')::date);
  day_start timestamptz; day_end timestamptz; result jsonb;
begin
  if caller is null then raise exception 'authentication required' using errcode='42501'; end if;
  select b.id into business from public.businesses b where b.slug=p_business_slug;
  if not found or not exists (select 1 from public.business_memberships m where m.business_id=business and m.user_id=caller and m.role='admin') then
    raise exception 'summary unavailable' using errcode='42501';
  end if;
  day_start := day::timestamp at time zone 'Asia/Kolkata';
  day_end := (day + 1)::timestamp at time zone 'Asia/Kolkata';
  with delivered as (
    select o.id, o.total_paise from public.orders o
    where o.business_id=business and o.status='delivered'
      and exists (select 1 from public.order_status_history h where h.order_id=o.id and h.status='delivered' and h.created_at >= day_start and h.created_at < day_end)
  ), cancelled as (
    select o.id from public.orders o
    where o.business_id=business and o.status='cancelled'
      and exists (select 1 from public.order_status_history h where h.order_id=o.id and h.status='cancelled' and h.created_at >= day_start and h.created_at < day_end)
  ), placed as (
    select o.id, o.status from public.orders o where o.business_id=business and o.created_at >= day_start and o.created_at < day_end
  ), open_orders as (
    select o.total_paise from public.orders o where o.business_id=business and o.status not in ('delivered','cancelled')
  ), dishes as (
    -- Most ordered among the day's placed orders that were not cancelled, by stored name.
    select i.name, sum(i.quantity)::integer as quantity from public.order_items i join placed p on p.id=i.order_id
    where p.status <> 'cancelled' group by i.name order by sum(i.quantity) desc, i.name limit 5
  )
  select jsonb_build_object(
    'date', day,
    'collected_paise', (select coalesce(sum(total_paise), 0) from delivered),
    'delivered_count', (select count(*) from delivered),
    'outstanding_paise', (select coalesce(sum(total_paise), 0) from open_orders),
    'outstanding_count', (select count(*) from open_orders),
    'placed_count', (select count(*) from placed),
    'cancelled_count', (select count(*) from cancelled),
    'top_dishes', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'quantity', quantity) order by quantity desc, name) from dishes), '[]'::jsonb)
  ) into result;
  return result;
end $$;
revoke all on function public.daily_summary(text,date) from public, anon, authenticated;
grant execute on function public.daily_summary(text,date) to authenticated;
