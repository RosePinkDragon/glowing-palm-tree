-- #48: each restaurant's kitchen point, supplied by the owner on 16 Nov 2026
-- (Google Maps dropped pins), for "N km from the restaurant" on saved addresses.
-- Only fills a missing point, so a later correction made in the database stays.
do $$ declare ns text; begin
  select n.nspname into strict ns from pg_catalog.pg_extension e
    join pg_catalog.pg_namespace n on n.oid = e.extnamespace where e.extname = 'postgis';
  execute format('update public.businesses set kitchen_location = %1$I.st_setsrid(%1$I.st_makepoint(73.3944946, 17.7190154), 4326) where slug = ''ammu-sammu'' and kitchen_location is null', ns);
  execute format('update public.businesses set kitchen_location = %1$I.st_setsrid(%1$I.st_makepoint(73.3988110, 17.7197215), 4326) where slug = ''kokani-dine-inn'' and kitchen_location is null', ns);
end $$;
