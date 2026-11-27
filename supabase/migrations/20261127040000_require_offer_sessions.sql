-- #238: authorize offer lookups before pricing or logging a code attempt.
create or replace function offers_private.check_offer_code(p_business_slug text, p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare caller uuid := auth.uid(); b uuid; r jsonb; o public.offers%rowtype;
begin
  if caller is null then raise exception 'authentication required' using errcode = '42501'; end if;
  perform customer_lifecycle_private.require_active_session(caller);
  if p_code is null or char_length(p_code) > 64 then raise exception 'invalid offer code' using errcode = '22023'; end if;
  select id into b from public.businesses where slug = p_business_slug;
  if not found then raise exception 'business unavailable' using errcode = '22023'; end if;
  r := offers_private.resolve(b, caller, p_code, null, null, null);
  if r->'error' <> 'null'::jsonb then
    return jsonb_build_object('applies', false, 'reason', r->'error'->>'reason', 'retry_after_seconds', r->'error'->'retry_after_seconds', 'offer', null);
  end if;
  select * into strict o from public.offers where id = (r->'offer'->>'id')::uuid;
  return jsonb_build_object('applies', true, 'reason', null, 'retry_after_seconds', null, 'offer', jsonb_build_object(
    'id', o.id, 'name', o.name, 'kind', o.kind, 'value', o.value, 'max_discount_paise', o.max_discount_paise,
    'min_order_paise', o.min_order_paise, 'first_order_only', o.first_order_only));
end $$;

create or replace function offers_private.quote_order(p_business_slug text, p_items jsonb, p_offer_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare caller uuid := auth.uid(); b public.businesses%rowtype; priced record; r jsonb; code text; offer_error jsonb;
begin
  if caller is null then raise exception 'authentication required' using errcode = '42501'; end if;
  perform customer_lifecycle_private.require_active_session(caller);
  if p_offer_code is not null and char_length(p_offer_code) > 64 then raise exception 'invalid offer code' using errcode = '22023'; end if;
  code := nullif(upper(btrim(p_offer_code)), '');
  select * into b from public.businesses where slug = p_business_slug;
  if not found then raise exception 'business unavailable' using errcode = '22023'; end if;
  select * into priced from offers_private.price_items(b.id, p_items, false);
  r := offers_private.resolve(b.id, caller, code, priced.subtotal, b.delivery_fee_paise, null);
  if r->'error' <> 'null'::jsonb then
    offer_error := r->'error';
    r := offers_private.resolve(b.id, caller, null, priced.subtotal, b.delivery_fee_paise, null);
  end if;
  return jsonb_build_object('outcome', 'quoted',
    'pricing', offers_private.build_quote(b.delivery_fee_paise, b.min_order_paise, priced.subtotal, priced.lines, r),
    'offer_error', offer_error, 'nudge', r->'nudge');
end $$;

-- The helper itself rejects an absent user, and its successful PERFORM always sets FOUND.
create or replace function public.transition_order(p_order_id uuid, p_status text, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare o public.orders%rowtype; caller uuid := auth.uid(); actor text; step bigint; target_customer uuid; target_business uuid;
begin
  if caller is null then raise exception 'authentication required' using errcode='42501'; end if;
  perform customer_lifecycle_private.require_active_session(caller);
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
