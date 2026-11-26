\set ON_ERROR_STOP on
-- Runs inside a transaction so this test cannot change the shared fixture.
begin;
update public.businesses set accepting_orders=true, min_order_paise=0 where slug='ammu-sammu';
update public.businesses b set accepting_orders=true, ordering_enabled=true, min_order_paise=0, service_area=a.service_area, service_area_source='budget-test', service_area_version='budget-test', service_area_verified_at=now() from public.businesses a where b.slug='kokani-dine-inn' and a.slug='ammu-sammu';
insert into auth.users(id) values ('30000000-0000-4000-8000-000000000099');
insert into public.customer_addresses(id,customer_id,label,house,street_area,latitude,longitude,location_source)
values ('74000000-0000-4000-8000-000000000099','30000000-0000-4000-8000-000000000099','home','Budget house','Budget road',0.5,0.5,'pin');
create function public.test_budget_outbox_count() returns bigint language sql security definer set search_path = '' as $$ select count(*) from public.notification_outbox $$;
set role authenticated;
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000099',false);
do $$
declare
  items jsonb := '[{"menu_item_id":"20000000-0000-4000-8000-000000000001","quantity":1}]';
  delivery jsonb := public.test_delivery('Budget customer');
  quote jsonb := public.test_quote('ammu-sammu',items);
  invalid text; n integer; result jsonb; first_id text; outbox_before bigint; first_key uuid := md5('budget-1')::uuid;
  valid text[] := array['9876543210','+91 98765 43210','919876543210','09876543210','(98765)-43210'];
begin
  foreach invalid in array array['', '   ', '123', '5876543210', '+14155550123', '9876543210abc', repeat(' ',41)||'9876543210'] loop
    begin
      perform public.place_order('ammu-sammu',items,jsonb_set(delivery,'{phone}',to_jsonb(invalid)),null,gen_random_uuid(),quote);
      raise exception 'invalid phone accepted: %', invalid;
    exception when invalid_parameter_value then
      if sqlerrm <> 'invalid delivery details' then raise; end if;
    end;
  end loop;
  for n in 1..20 loop
    result := public.place_order('ammu-sammu',items,jsonb_set(delivery,'{phone}',to_jsonb(valid[1 + ((n-1) % array_length(valid,1))])),null,md5('budget-'||n)::uuid,quote);
    if n=1 then first_id := result->>'id'; end if;
    perform public.test_assert(result->>'outcome'='placed', 'within budget');
  end loop;
  perform public.test_assert((public.place_order('kokani-dine-inn','[{"menu_item_id":"20000000-0000-4000-8000-000000000002","quantity":1}]'::jsonb,jsonb_set(delivery,'{phone}',to_jsonb(valid[1])),null,md5('budget-other-business')::uuid,public.test_quote('kokani-dine-inn','[{"menu_item_id":"20000000-0000-4000-8000-000000000002","quantity":1}]'::jsonb))->>'outcome')='placed', 'another restaurant has its own budget');
  outbox_before := public.test_budget_outbox_count();
  perform public.test_assert(public.place_order('ammu-sammu',items,jsonb_set(delivery,'{phone}',to_jsonb(valid[1])),null,first_key,quote)->>'id'=first_id,'retry works at limit');
  begin
    perform public.place_order('ammu-sammu',items,jsonb_set(delivery,'{phone}',to_jsonb(valid[1])),null,md5('budget-over')::uuid,quote);
    raise exception 'budget allowed the 21st distinct order';
  exception when sqlstate 'PT429' then
    if sqlerrm <> 'order submission limit reached' then raise; end if;
  end;
  perform public.test_assert(public.test_budget_outbox_count() = outbox_before, 'retry and refused order do not enqueue notifications');
end $$;
reset role;
select public.test_assert((select count(*)=20 from public.orders where customer_id='30000000-0000-4000-8000-000000000099' and business_id='10000000-0000-4000-8000-000000000001'), 'budget refusal created no order');
select public.test_assert(not exists(select 1 from public.orders where idempotency_key=md5('budget-over')::uuid), 'refused key was not inserted');
select public.test_assert(not exists(select 1 from public.notification_outbox where order_id not in (select id from public.orders)), 'refusal created no orphan notifications');
rollback;
