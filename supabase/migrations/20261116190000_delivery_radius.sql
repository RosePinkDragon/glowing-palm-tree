-- #48: delivery areas as a radius around each restaurant's kitchen point.
-- Owner decision, 16 Nov 2026: both Khed restaurants deliver within 12 km of
-- their kitchen. New restaurants (e.g. Dapoli) get their own kitchen point and
-- radius through set_delivery_radius from trusted setup, not from the apps.

-- Trusted setup only (service role / migrations). Replaces the restaurant's
-- service_area with a circle of p_radius_m metres around kitchen_location and
-- records where it came from; the circle is drawn finely enough (128 sides)
-- that it falls short of the true radius by under 4 m.
create function public.set_delivery_radius(p_business_slug text, p_radius_m integer, p_source text)
returns void language plpgsql security definer set search_path = '' as $$
declare b public.businesses%rowtype; ns text;
begin
  if p_radius_m is null or p_radius_m not between 500 and 50000 then
    raise exception 'delivery radius must be 500 m to 50 km' using errcode = '22023';
  end if;
  if nullif(trim(p_source), '') is null then raise exception 'delivery area source required' using errcode = '22023'; end if;
  select * into b from public.businesses where slug = p_business_slug for update;
  if not found then raise exception 'business unavailable' using errcode = '22023'; end if;
  if b.kitchen_location is null then raise exception 'set the kitchen location first' using errcode = '22023'; end if;
  select n.nspname into strict ns from pg_catalog.pg_extension e
    join pg_catalog.pg_namespace n on n.oid = e.extnamespace where e.extname = 'postgis';
  execute format('update public.businesses set service_area = %1$I.st_multi(%1$I.st_buffer(kitchen_location::%1$I.geography, $2, ''quad_segs=32'')::%1$I.geometry),
      service_area_source = $3, service_area_version = $4, service_area_verified_at = now() where id = $1', ns)
    using b.id, p_radius_m::double precision, trim(p_source), 'radius-' || p_radius_m || 'm';
end $$;
revoke all on function public.set_delivery_radius(text, integer, text) from public, anon, authenticated;
grant execute on function public.set_delivery_radius(text, integer, text) to service_role;

-- Apply the owner's 12 km decision to the existing Khed restaurants. Fresh
-- installs have no restaurants yet and stay without an area (fail closed).
do $$ declare s text; begin
  for s in select slug from public.businesses where slug in ('ammu-sammu', 'kokani-dine-inn') and kitchen_location is not null loop
    perform public.set_delivery_radius(s, 12000, 'Owner decision 16 Nov 2026: deliver within 12 km of the kitchen');
  end loop;
end $$;
