-- Store the checkout limit here so enforcement and the support RPC report the same value.
create function offers_private.order_budget_limit() returns integer
language sql immutable set search_path = '' as $$
  select 20
$$;
revoke all on function offers_private.order_budget_limit() from public, anon, authenticated, service_role;

create or replace function offers_private.enforce_order_budget() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform customer_lifecycle_private.lock_account(new.customer_id);
  if offers_private.order_budget_count(new.customer_id, new.business_id, pg_catalog.clock_timestamp()) >= offers_private.order_budget_limit() then
    raise exception 'order submission limit reached' using errcode = 'PT429', detail = 'ORDER_RATE_LIMITED';
  end if;
  return new;
end $$;

create or replace function public.manage_order_budget(p_business_slug text, p_customer_id uuid, p_reset boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare business uuid; checked_at timestamptz; reset_time timestamptz; used_slots bigint;
begin
  if p_reset then
    -- Serialize against checkout before taking any business or cutoff lock.
    perform customer_lifecycle_private.lock_account(p_customer_id);
  end if;
  select id into business from public.businesses where slug = p_business_slug for key share;
  if not found then raise exception 'business unavailable' using errcode = '22023'; end if;

  checked_at := pg_catalog.clock_timestamp();
  if p_reset then
    insert into offers_private.order_budget_resets(customer_id, business_id, reset_at)
      values (p_customer_id, business, checked_at)
    on conflict (customer_id, business_id) do update set reset_at = excluded.reset_at;
  end if;
  select (select r.reset_at from offers_private.order_budget_resets r
            where r.customer_id = p_customer_id and r.business_id = business),
         offers_private.order_budget_count(p_customer_id, business, checked_at)
    into reset_time, used_slots;
  return jsonb_build_object('used', used_slots, 'limit', offers_private.order_budget_limit(), 'reset_at', reset_time);
end $$;
