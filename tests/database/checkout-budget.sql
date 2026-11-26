\set ON_ERROR_STOP on
-- Runs inside a transaction so this test cannot change the shared fixture.
begin;
select public.test_assert((select array_agg(tgname::text order by tgname) from pg_catalog.pg_trigger where tgrelid='public.orders'::regclass and not tgisinternal and tgname in ('a0_checkout_order_budget','assign_order_number')) = array['a0_checkout_order_budget','assign_order_number'], 'budget trigger fires before order-number allocation');
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
  invalid text; client_clock text; n integer; result jsonb; first_id text; outbox_before bigint; first_key uuid := md5('budget-1')::uuid;
  valid text[] := array['9876543210','+91 98765 43210','919876543210','09876543210','(98765)-43210'];
begin
  foreach invalid in array array['', '   ', '123', '5876543210', '+14155550123', '9876543210abc', '(+91) 98765 43210', repeat(' ',41)||'9876543210'] loop
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
  foreach client_clock in array array['1900-01-01T00:00:00Z', '2099-01-01T00:00:00Z'] loop
    begin
      perform public.place_order('ammu-sammu',items,jsonb_set(delivery,'{phone}',to_jsonb(valid[1])),jsonb_build_object('latitude',0.5,'longitude',0.5,'accuracy',10,'captured_at',client_clock),md5('budget-clock-'||client_clock)::uuid,quote);
      raise exception 'client clock bypassed budget';
    exception when sqlstate 'PT429' then
      if sqlerrm <> 'order submission limit reached' then raise; end if;
    end;
  end loop;
  perform public.test_assert(public.test_budget_outbox_count() = outbox_before, 'retry and refused order do not enqueue notifications');
end $$;
reset role;
select public.test_assert((select count(*)=20 from public.orders where customer_id='30000000-0000-4000-8000-000000000099' and business_id='10000000-0000-4000-8000-000000000001'), 'budget refusal created no order');
select public.test_assert(not exists(select 1 from public.orders where idempotency_key=md5('budget-over')::uuid), 'refused key was not inserted');
-- Old orders are outside the server-side rolling window even when the client clock is wrong.
insert into auth.users(id) values ('30000000-0000-4000-8000-000000000097');
insert into public.customer_addresses(id,customer_id,label,house,street_area,latitude,longitude,location_source) values ('74000000-0000-4000-8000-000000000097','30000000-0000-4000-8000-000000000097','home','Old house','Old road',0.5,0.5,'pin');
insert into public.orders(business_id,customer_id,customer_name,customer_phone,delivery_address_line,latitude,longitude,address_label,address_house,address_street_area,address_location_source,saved_address_id,saved_address_version,subtotal_paise,delivery_fee_paise,total_paise,idempotency_key,request_hash,created_at)
select '10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000097','Old customer','9876543210','Old road',0.5,0.5,'home','Old house','Old road','pin','74000000-0000-4000-8000-000000000097',1,100,0,100,md5('old-budget-'||n)::uuid,'fixture',pg_catalog.clock_timestamp()-interval '61 minutes' from generate_series(1,20) n;
set role authenticated;
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000097',false);
select public.test_assert((public.place_order('ammu-sammu','[{"menu_item_id":"20000000-0000-4000-8000-000000000001","quantity":1}]',public.test_delivery('Old customer'),jsonb_build_object('latitude',0.5,'longitude',0.5,'accuracy',10,'captured_at','2099-01-01T00:00:00Z'),md5('budget-after-window')::uuid,public.test_quote('ammu-sammu','[{"menu_item_id":"20000000-0000-4000-8000-000000000001","quantity":1}]'))->>'outcome')='placed','old orders do not consume budget even with an invalid client clock');
rollback;
