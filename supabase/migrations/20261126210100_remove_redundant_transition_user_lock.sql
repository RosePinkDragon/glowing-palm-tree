-- #238: require_active_session already holds the caller's user lock.
create or replace function public.transition_order(p_order_id uuid, p_status text, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare o public.orders%rowtype; caller uuid := auth.uid(); actor text; step bigint; target_customer uuid; target_business uuid;
begin
  if caller is null then raise exception 'authentication required' using errcode='42501'; end if;
  perform customer_lifecycle_private.require_active_session(caller);
  if not found then raise exception 'authentication required' using errcode='42501'; end if;
  select customer_id,business_id into target_customer,target_business from public.orders where id=p_order_id;
  if not found or not public.is_business_admin(target_business) then raise exception 'order unavailable' using errcode='42501'; end if;
  if target_customer is not null then perform customer_lifecycle_private.lock_account(target_customer); end if;
  perform 1 from public.businesses where id=target_business for share;
  select * into o from public.orders where id=p_order_id for update;
  if not found then raise exception 'order unavailable' using errcode='42501'; end if;
  -- Lock the membership so revocation and transition cannot race.
  select m.display_name into actor from public.business_memberships m where m.business_id=o.business_id and m.user_id=caller and m.role='admin' for share;
  if not found then raise exception 'order unavailable' using errcode='42501'; end if;
  if p_expected_version is null or p_expected_version <> o.version then raise exception 'order version conflict' using errcode='40001'; end if;
  if not ((o.status='placed' and p_status in ('accepted','cancelled')) or
          (o.status='accepted' and p_status in ('preparing','cancelled')) or
          (o.status='preparing' and p_status in ('out_for_delivery','cancelled')) or
          (o.status='out_for_delivery' and p_status='delivered')) then
    raise exception 'invalid order transition' using errcode='22023';
  end if;
  update public.orders set status=p_status, version=version+1 where id=o.id returning * into o;
  insert into public.order_status_history(order_id,status,changed_by) values(o.id,o.status,caller) returning id into step;
  insert into public.order_status_actors(history_id,business_id,actor_id,actor_name) values(step,o.business_id,caller,actor);
  return jsonb_build_object('id',o.id,'business_id',o.business_id,'status',o.status,'version',o.version,'subtotal_paise',o.subtotal_paise,'delivery_fee_paise',o.delivery_fee_paise,'total_paise',o.total_paise,'created_at',o.created_at);
end $$;
