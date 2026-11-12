-- Session deletion (including logout) invalidates the corresponding token.
alter table public.device_tokens add column session_id uuid references auth.sessions(id) on delete cascade;
revoke insert, update, delete on public.device_tokens from authenticated;

create function public.register_device_token(p_business_slug text, p_audience text, p_token text)
returns void language plpgsql security definer set search_path = '' as $$
declare caller uuid := auth.uid(); session uuid; business uuid;
begin
  if caller is null or p_audience not in ('customer','admin') or p_audience is null
     or p_token is null or length(trim(p_token)) = 0 or length(p_token) > 4096 then
    raise exception 'invalid device registration' using errcode='22023';
  end if;
  begin session := (auth.jwt()->>'session_id')::uuid;
  exception when others then raise exception 'invalid session' using errcode='42501'; end;
  if session is null then raise exception 'invalid session' using errcode='42501'; end if;
  perform 1 from auth.sessions where id=session and user_id=caller and (not_after is null or not_after > clock_timestamp()) for share;
  if not found then raise exception 'invalid session' using errcode='42501'; end if;
  select id into business from public.businesses where slug=p_business_slug;
  if business is null then raise exception 'invalid business' using errcode='22023'; end if;
  if p_audience='admin' then
    perform 1 from public.business_memberships where business_id=business and user_id=caller and role='admin' for share;
    if not found then raise exception 'admin membership required' using errcode='42501'; end if;
  end if;
  -- Rotate the row on re-registration, invalidating jobs and leases belonging
  -- to the previous registration of this opaque token.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(business::text || ':' || p_audience || ':' || p_token, 0));
  delete from public.device_tokens where business_id=business and audience=p_audience and token=p_token;
  insert into public.device_tokens(user_id,business_id,audience,token,session_id)
    values(caller,business,p_audience,p_token,session);
end $$;
create function public.unregister_device_token(p_business_slug text, p_audience text, p_token text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode='42501'; end if;
  delete from public.device_tokens d using public.businesses b
  where b.slug=p_business_slug and d.business_id=b.id and d.audience=p_audience and d.token=p_token and d.user_id=auth.uid();
end $$;
revoke all on function public.register_device_token(text,text,text), public.unregister_device_token(text,text,text) from public, anon, authenticated;
grant execute on function public.register_device_token(text,text,text), public.unregister_device_token(text,text,text) to authenticated;

create table public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  device_token_id uuid not null references public.device_tokens(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  audience text not null check (audience in ('customer','admin')),
  attempts integer not null default 0 check (attempts between 0 and 5),
  available_at timestamptz not null default now(),
  lease_id uuid, lease_expires_at timestamptz,
  completed_at timestamptz, created_at timestamptz not null default now()
);
create index notification_outbox_ready_idx on public.notification_outbox(available_at) where completed_at is null;
alter table public.notification_outbox enable row level security;
revoke all on public.notification_outbox from public, anon, authenticated;
grant all on public.notification_outbox to service_role;

create function public.queue_order_notification() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op='INSERT' then
    insert into public.notification_outbox(device_token_id,order_id,audience)
      select d.id,new.id,'admin' from public.device_tokens d
      join auth.sessions s on s.id=d.session_id and s.user_id=d.user_id and (s.not_after is null or s.not_after > clock_timestamp())
      join public.business_memberships m on m.business_id=d.business_id and m.user_id=d.user_id and m.role='admin'
      where d.business_id=new.business_id and d.audience='admin';
  elsif new.status is distinct from old.status then
    insert into public.notification_outbox(device_token_id,order_id,audience)
      select d.id,new.id,'customer' from public.device_tokens d
      join auth.sessions s on s.id=d.session_id and s.user_id=d.user_id and (s.not_after is null or s.not_after > clock_timestamp())
      where d.business_id=new.business_id and d.user_id=new.customer_id and d.audience='customer';
  end if;
  return new;
end $$;
revoke all on function public.queue_order_notification() from public, anon, authenticated;
create trigger queue_order_notification after insert or update of status on public.orders
for each row execute function public.queue_order_notification();

-- Lease IDs prevent a worker whose lease expired from acknowledging another
-- worker's attempt. Exhausted jobs stay completed and are never reclaimed.
create function public.claim_notification_jobs(p_limit integer default 20)
returns table(job_id uuid, lease_id uuid) language plpgsql security definer set search_path = '' as $$
begin
  if p_limit is null or p_limit not between 1 and 100 then raise exception 'invalid batch size' using errcode='22023'; end if;
  update public.notification_outbox set completed_at=clock_timestamp(), lease_id=null, lease_expires_at=null
    where completed_at is null and attempts >= 5 and (lease_expires_at is null or lease_expires_at <= clock_timestamp());
  return query
    with ready as (
      select q.id from public.notification_outbox q
      where q.completed_at is null and q.attempts < 5 and q.available_at <= clock_timestamp()
        and (q.lease_expires_at is null or q.lease_expires_at <= clock_timestamp())
      order by q.created_at, q.id for update skip locked limit p_limit
    )
    update public.notification_outbox q set lease_id=gen_random_uuid(),
      lease_expires_at=clock_timestamp()+interval '2 minutes', attempts=q.attempts+1
    from ready where q.id=ready.id returning q.id,q.lease_id;
end $$;
-- Return a destination only while this lease, session, tenant and current
-- membership are valid. No order/customer details are returned to the worker.
create function public.notification_destination(p_job_id uuid, p_lease_id uuid)
returns text language sql security definer set search_path = '' as $$
  select d.token from public.notification_outbox q
  join public.device_tokens d on d.id=q.device_token_id
  join auth.sessions s on s.id=d.session_id and s.user_id=d.user_id and (s.not_after is null or s.not_after > clock_timestamp())
  join public.orders o on o.id=q.order_id and o.business_id=d.business_id
  where q.id=p_job_id and q.lease_id=p_lease_id and q.completed_at is null
    and q.lease_expires_at > clock_timestamp() and d.audience=q.audience
    and ((q.audience='customer' and d.user_id=o.customer_id) or
         (q.audience='admin' and exists (select 1 from public.business_memberships m
            where m.business_id=o.business_id and m.user_id=d.user_id and m.role='admin')))
$$;
create function public.finish_notification_job(p_job_id uuid, p_lease_id uuid, p_result text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare token_id uuid; n integer;
begin
  if p_result is null or p_result not in ('sent','retry','unregistered','discard') then raise exception 'invalid result' using errcode='22023'; end if;
  select device_token_id, attempts into token_id,n from public.notification_outbox
    where id=p_job_id and lease_id=p_lease_id and completed_at is null and lease_expires_at > clock_timestamp() for update;
  if not found then return false; end if;
  if p_result='unregistered' then
    delete from public.device_tokens where id=token_id;
  elsif p_result in ('sent','discard') or n >= 5 then
    update public.notification_outbox set completed_at=clock_timestamp(),lease_id=null,lease_expires_at=null where id=p_job_id;
  else
    update public.notification_outbox set available_at=clock_timestamp()+make_interval(secs => (30 * power(2,n-1))::integer),lease_id=null,lease_expires_at=null where id=p_job_id;
  end if;
  return true;
end $$;
revoke all on function public.claim_notification_jobs(integer), public.notification_destination(uuid,uuid), public.finish_notification_job(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.claim_notification_jobs(integer), public.notification_destination(uuid,uuid), public.finish_notification_job(uuid,uuid,text) to service_role;
