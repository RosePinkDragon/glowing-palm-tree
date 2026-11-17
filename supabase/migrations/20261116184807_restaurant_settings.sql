-- #60 backend only. Fold into #131's baseline at cutover; no remote deployment.
begin;
alter table public.businesses
  add column whatsapp_phone text check (whatsapp_phone is null or whatsapp_phone ~ '^\+91[6-9][0-9]{9}$'),
  add column settings_version integer not null default 1 check (settings_version > 0);

-- Only the invoker wrapper is exposed over the API. Privileged implementation
-- stays in a schema outside the Data API, with explicit caller/session checks.
create schema restaurant_settings_private;
revoke all on schema restaurant_settings_private from public, anon, authenticated;
grant usage on schema restaurant_settings_private to authenticated;
create function restaurant_settings_private.bump_version() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.settings_version := old.settings_version + 1;
  return new;
end $$;
revoke all on function restaurant_settings_private.bump_version() from public, anon, authenticated;
-- Trusted administrative edits invalidate an open settings form too. Unrelated
-- updates (including #58's accepting_orders) do not invalidate the form.
create trigger restaurant_settings_version before update of contact_phone, whatsapp_phone, delivery_fee_paise, min_order_paise
  on public.businesses for each row execute function restaurant_settings_private.bump_version();

create function restaurant_settings_private.save_settings(
  p_business_slug text, p_contact_phone text, p_whatsapp_phone text,
  p_delivery_fee_paise numeric, p_min_order_paise numeric, p_expected_version integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare caller uuid := auth.uid(); session uuid; b public.businesses%rowtype;
begin
  if caller is null then raise exception 'authentication required' using errcode = '42501'; end if;
  begin session := (auth.jwt()->>'session_id')::uuid;
  exception when others then raise exception 'invalid session' using errcode = '42501'; end;
  if session is null then raise exception 'invalid session' using errcode = '42501'; end if;
  perform 1 from auth.sessions where id = session and user_id = caller and (not_after is null or not_after > clock_timestamp()) for share;
  if not found then raise exception 'invalid session' using errcode = '42501'; end if;
  -- Same business lock as checkout/open-close: a concurrent checkout either
  -- uses the old accepted terms or receives the new quote, never mixed fields.
  select * into b from public.businesses where slug = p_business_slug for no key update;
  if not found then raise exception 'business unavailable' using errcode = '42501'; end if;
  perform 1 from public.business_memberships where business_id = b.id and user_id = caller and role = 'admin' for share;
  if not found then raise exception 'business unavailable' using errcode = '42501'; end if;
  if p_expected_version is null or p_expected_version <> b.settings_version then
    raise exception 'restaurant details changed; refresh before saving' using errcode = '40001';
  end if;
  -- Numeric arguments deliberately avoid integer coercion rounding fractional
  -- paise before validation. No writes occur until all four fields are valid.
  if p_contact_phone is null or p_contact_phone !~ '^\+91[1-9][0-9]{9}$' then
    raise exception 'Enter an Indian mobile or landline number.' using errcode = '22023', detail = 'contactPhone';
  end if;
  if p_whatsapp_phone is not null and p_whatsapp_phone !~ '^\+91[6-9][0-9]{9}$' then
    raise exception 'Enter an Indian mobile number or leave it empty.' using errcode = '22023', detail = 'whatsappPhone';
  end if;
  if p_delivery_fee_paise is null or p_delivery_fee_paise < 0 or p_delivery_fee_paise > 100000 or trunc(p_delivery_fee_paise) <> p_delivery_fee_paise then
    raise exception 'Enter a delivery fee from 0 to 1,000 rupees, in whole paise.' using errcode = '22023', detail = 'deliveryFeePaise';
  end if;
  if p_min_order_paise is null or p_min_order_paise < 0 or p_min_order_paise > 1000000 or trunc(p_min_order_paise) <> p_min_order_paise then
    raise exception 'Enter a minimum order from 0 to 10,000 rupees, in whole paise.' using errcode = '22023', detail = 'minOrderPaise';
  end if;
  update public.businesses set contact_phone = p_contact_phone, whatsapp_phone = p_whatsapp_phone,
    delivery_fee_paise = p_delivery_fee_paise::integer, min_order_paise = p_min_order_paise::integer
    where id = b.id returning * into b;
  return jsonb_build_object('contact_phone', b.contact_phone, 'whatsapp_phone', b.whatsapp_phone,
    'delivery_fee_paise', b.delivery_fee_paise, 'min_order_paise', b.min_order_paise, 'settings_version', b.settings_version);
end $$;
revoke all on function restaurant_settings_private.save_settings(text,text,text,numeric,numeric,integer) from public, anon, authenticated;
grant execute on function restaurant_settings_private.save_settings(text,text,text,numeric,numeric,integer) to authenticated;

create function public.save_restaurant_settings(
  p_business_slug text, p_contact_phone text, p_whatsapp_phone text,
  p_delivery_fee_paise numeric, p_min_order_paise numeric, p_expected_version integer
) returns jsonb language sql security invoker set search_path = '' as $$
  select restaurant_settings_private.save_settings(p_business_slug, p_contact_phone, p_whatsapp_phone,
    p_delivery_fee_paise, p_min_order_paise, p_expected_version)
$$;
revoke all on function public.save_restaurant_settings(text,text,text,numeric,numeric,integer) from public, anon, authenticated;
grant execute on function public.save_restaurant_settings(text,text,text,numeric,numeric,integer) to authenticated;
-- No businesses UPDATE grants are added. Public reads and existing business
-- Realtime invalidations carry the new terms; past orders keep their snapshots.
commit;
