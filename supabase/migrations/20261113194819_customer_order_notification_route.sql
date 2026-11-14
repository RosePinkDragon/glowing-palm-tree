-- The dispatcher receives only an opaque customer route alongside the already
-- authorized destination. Admin messages remain generic. No public RPC access.
create function public.notification_delivery(p_job_id uuid, p_lease_id uuid)
returns jsonb language sql security invoker set search_path = '' as $$
  with checked as materialized (
    select public.notification_destination(p_job_id,p_lease_id) as token
  )
  select jsonb_build_object('token',checked.token,
    'order_id',case when q.audience='customer' then q.order_id else null end)
  from checked cross join public.notification_outbox q
  where q.id=p_job_id and q.lease_id=p_lease_id and checked.token is not null
$$;
revoke all on function public.notification_delivery(uuid,uuid) from public, anon, authenticated;
grant execute on function public.notification_delivery(uuid,uuid) to service_role;
