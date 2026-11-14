-- Public serving, but *all* writes pass through the decoding Edge Function.
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('menu-images', 'menu-images', true, 1048576, array['image/webp']);
-- No INSERT/UPDATE/DELETE policy: clients (including owners) cannot bypass decoding.
create policy menu_images_public_read on storage.objects for select to anon, authenticated
using (bucket_id = 'menu-images');

create table public.menu_photo_jobs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id),
  item_id uuid not null, -- Kept after dish deletion so cleanup remains durable.
  actor_id uuid not null,
  expected_path text,
  state text not null default 'pending' check (state in ('pending','attached','cleanup','cleaning','cleaned')),
  due_at timestamptz not null default now() + interval '15 minutes',
  lease uuid,
  created_at timestamptz not null default now()
);
alter table public.menu_photo_jobs enable row level security;
revoke all on public.menu_photo_jobs from public, anon, authenticated;
grant all on public.menu_photo_jobs to service_role;
create index menu_photo_cleanup_due on public.menu_photo_jobs(business_id, due_at)
where state in ('pending','cleanup','cleaning');

-- image_url is an immutable-version *bucket-relative* card path, never an arbitrary URL.
revoke insert, update on public.menu_items from authenticated;
grant insert(id,business_id,name,description,category_id,price_paise,available,is_demo,diet,is_featured,sort_order,created_at),
      update(id,business_id,name,description,category_id,price_paise,available,is_demo,diet,is_featured,sort_order,created_at)
on public.menu_items to authenticated;

create schema menu_photo_private;
revoke all on schema menu_photo_private from public, anon, authenticated;
-- A trigger must access the private ledger even when an owner deletes a dish.
create function menu_photo_private.track_photo() returns trigger
language plpgsql security definer set search_path = '' as $$
declare candidate public.menu_photo_jobs;
begin
  if tg_op <> 'DELETE' and new.image_url is not null and
     (tg_op = 'INSERT' or new.image_url is distinct from old.image_url or new.id is distinct from old.id) then
    select * into candidate from public.menu_photo_jobs j
    where j.business_id = new.business_id and j.item_id = new.id
      and new.image_url = j.business_id::text || '/' || j.item_id::text || '/' || j.id::text || '/card.webp'
      and j.state = 'pending' and j.due_at > now() for update;
    if not found then raise exception 'Photo must be a validated reservation for this dish' using errcode='42501'; end if;
  end if;
  if tg_op <> 'INSERT' and old.image_url is not null and
     (tg_op = 'DELETE' or old.image_url is distinct from new.image_url) then
    update public.menu_photo_jobs j set state='cleanup', due_at=now(), lease=null
    where j.business_id=old.business_id and j.item_id=old.id
      and old.image_url=j.business_id::text || '/' || j.item_id::text || '/' || j.id::text || '/card.webp'
      and state='attached';
  end if;
  if tg_op='DELETE' then return old; else return new; end if;
end $$;
revoke all on function menu_photo_private.track_photo() from public, anon, authenticated;
create trigger menu_photo_tracking before insert or update of image_url,id or delete on public.menu_items
for each row execute function menu_photo_private.track_photo();

-- These RPCs are server-only and SECURITY INVOKER. The actor comes from Auth.getUser,
-- never request JSON. Each transaction checks current, database-backed membership.
create function public.menu_photo_business(p_actor uuid, p_slug text) returns uuid
language plpgsql security invoker set search_path='' as $$
declare business uuid;
begin
  select b.id into business from public.businesses b join public.business_memberships m on m.business_id=b.id
  where b.slug=p_slug and m.user_id=p_actor and m.role='admin' for share of m;
  if business is null then raise exception 'Admin access required' using errcode='42501'; end if;
  return business;
end $$;

create function public.reserve_menu_photo(p_actor uuid,p_slug text,p_item uuid,p_expected text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare business uuid; current_path text; job public.menu_photo_jobs;
begin
  business:=public.menu_photo_business(p_actor,p_slug);
  select image_url into current_path from public.menu_items where id=p_item and business_id=business for update;
  if not found then raise exception 'Dish no longer exists' using errcode='P0002'; end if;
  if current_path is distinct from p_expected then raise exception 'Photo changed. Reload before retrying.' using errcode='40001'; end if;
  insert into public.menu_photo_jobs(business_id,item_id,actor_id,expected_path)
  values(business,p_item,p_actor,p_expected) returning * into job;
  return jsonb_build_object('id',job.id,'base',business::text || '/' || p_item::text || '/' || job.id::text);
end $$;

create function public.attach_menu_photo(p_actor uuid,p_slug text,p_job uuid) returns text
language plpgsql security invoker set search_path='' as $$
declare business uuid; job public.menu_photo_jobs; current_path text; next_path text;
begin
  business:=public.menu_photo_business(p_actor,p_slug);
  select * into job from public.menu_photo_jobs where id=p_job and business_id=business and actor_id=p_actor for update;
  if not found or job.state<>'pending' or job.due_at<=now() then raise exception 'Photo reservation expired. Choose the photo again.' using errcode='40001'; end if;
  select image_url into current_path from public.menu_items where id=job.item_id and business_id=business for update;
  if not found then raise exception 'Dish no longer exists' using errcode='P0002'; end if;
  if current_path is distinct from job.expected_path then raise exception 'Photo changed. Reload before retrying.' using errcode='40001'; end if;
  next_path:=job.business_id::text || '/' || job.item_id::text || '/' || job.id::text || '/card.webp';
  -- Both exact objects must have been written to the correct bucket by the server.
  if (select count(*) from storage.objects where bucket_id='menu-images' and name in
      (next_path,replace(next_path,'/card.webp','/detail.webp')))<>2 then
    raise exception 'Photo upload is incomplete' using errcode='40001';
  end if;
  update public.menu_items set image_url=next_path where id=job.item_id and business_id=business;
  update public.menu_photo_jobs set state='attached' where id=p_job;
  return next_path;
end $$;

create function public.remove_menu_photo(p_actor uuid,p_slug text,p_item uuid,p_expected text) returns void
language plpgsql security invoker set search_path='' as $$
declare business uuid; current_path text;
begin
  business:=public.menu_photo_business(p_actor,p_slug);
  select image_url into current_path from public.menu_items where id=p_item and business_id=business for update;
  if not found then raise exception 'Dish no longer exists' using errcode='P0002'; end if;
  if current_path is null then return; end if; -- Safe retry after a lost response.
  if current_path is distinct from p_expected then raise exception 'Photo changed. Reload before retrying.' using errcode='40001'; end if;
  update public.menu_items set image_url=null where id=p_item and business_id=business;
end $$;

create function public.claim_menu_photo_cleanup(p_actor uuid,p_slug text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare business uuid; result jsonb;
begin
  business:=public.menu_photo_business(p_actor,p_slug);
  -- The same row lock is taken by attachment. An unexpired upload is never claimed;
  -- once claimed it cannot be attached, even if a slow function resumes afterwards.
  with candidates as (
    select id from public.menu_photo_jobs where business_id=business
      and state in ('pending','cleanup','cleaning') and due_at<=now()
    order by due_at limit 5 for update skip locked
  ), claimed as (
    update public.menu_photo_jobs j set state='cleaning',lease=gen_random_uuid(),due_at=now()+interval '2 minutes'
    from candidates c where j.id=c.id returning j.*
  ) select coalesce(jsonb_agg(jsonb_build_object('id',id,'lease',lease,'base',business_id::text || '/' || item_id::text || '/' || id::text)),'[]'::jsonb) into result from claimed;
  return result;
end $$;
create function public.finish_menu_photo_cleanup(p_actor uuid,p_slug text,p_job uuid,p_lease uuid) returns void
language plpgsql security invoker set search_path='' as $$
declare business uuid;
begin
  business:=public.menu_photo_business(p_actor,p_slug);
  update public.menu_photo_jobs set state='cleaned',lease=null where id=p_job and business_id=business and lease=p_lease and state='cleaning';
end $$;

revoke all on function public.menu_photo_business(uuid,text),public.reserve_menu_photo(uuid,text,uuid,text),
public.attach_menu_photo(uuid,text,uuid),public.remove_menu_photo(uuid,text,uuid,text),
public.claim_menu_photo_cleanup(uuid,text),public.finish_menu_photo_cleanup(uuid,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.menu_photo_business(uuid,text),public.reserve_menu_photo(uuid,text,uuid,text),
public.attach_menu_photo(uuid,text,uuid),public.remove_menu_photo(uuid,text,uuid,text),
public.claim_menu_photo_cleanup(uuid,text),public.finish_menu_photo_cleanup(uuid,text,uuid,uuid) to service_role;
