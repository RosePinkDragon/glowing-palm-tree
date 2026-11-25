-- Run as the caller so the redemptions and orders policies filter every row.
create function public.offer_usage_stats(p_business_id uuid, p_offer_id uuid default null)
returns jsonb
language sql stable security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'offer_id', s.offer_id, 'uses', s.uses,
    'discount_given_paise', s.discount_given_paise, 'any_redemption', true
  )), '[]'::jsonb)
  from (
    select r.offer_id,
      count(*) filter (where o.status <> 'cancelled') as uses,
      coalesce(sum(o.discount_paise) filter (where o.status <> 'cancelled'), 0) as discount_given_paise
    from public.offer_redemptions r
    join public.orders o on o.business_id = r.business_id and o.id = r.order_id
    where r.business_id = p_business_id and (p_offer_id is null or r.offer_id = p_offer_id)
    group by r.offer_id
  ) s;
$$;
revoke all on function public.offer_usage_stats(uuid, uuid) from public, anon;
grant execute on function public.offer_usage_stats(uuid, uuid) to authenticated;
