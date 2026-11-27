\set ON_ERROR_STOP on
-- Runs inside a transaction so this test cannot change the shared fixture.
begin;
select public.test_assert((select array_agg(tgname::text order by tgname) from pg_catalog.pg_trigger where tgrelid='public.orders'::regclass and not tgisinternal and tgname in ('a0_checkout_order_budget','assign_order_number')) = array['a0_checkout_order_budget','assign_order_number'], 'budget trigger fires before order-number allocation');
update public.businesses set accepting_orders=true, min_order_paise=0 where slug='ammu-sammu';
update public.businesses b set accepting_orders=true, ordering_enabled=true, min_order_paise=0, service_area=a.service_area, service_area_source='budget-test', service_area_version='budget-test', service_area_verified_at=now() from public.businesses a where b.slug='kokani-dine-inn' and a.slug='ammu-sammu';
insert into auth.users(id,phone) values ('30000000-0000-4000-8000-000000000099','919999999999');
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
    perform public.test_assert((select customer_phone='+919876543210' from public.orders where id=(result->>'id')::uuid),
      'all accepted phone spellings store the same recipient number, independently of the login phone');
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
-- A cancelled order still consumes a slot for its original customer and restaurant.
update public.orders set status='cancelled' where idempotency_key=md5('budget-1')::uuid;
create function public.test_budget_order(p_key uuid, p_phone text default '9876543210') returns jsonb language sql as $$
  select public.place_order('ammu-sammu',items,jsonb_set(public.test_delivery('Budget customer'),'{phone}',to_jsonb(p_phone)),
    null,p_key,public.test_quote('ammu-sammu',items))
  from (values ('[{"menu_item_id":"20000000-0000-4000-8000-000000000001","quantity":1}]'::jsonb)) v(items)
$$;
create function public.test_budget_denied(p_key uuid) returns void language plpgsql as $$
declare detail text;
begin
  perform public.test_budget_order(p_key);
  raise exception 'order was accepted at the budget limit';
exception when sqlstate 'PT429' then
  get stacked diagnostics detail = pg_exception_detail;
  if detail is distinct from 'ORDER_RATE_LIMITED' then raise; end if;
end $$;

set local role authenticated;
select public.test_budget_denied(md5('budget-after-cancel')::uuid);
-- An exhausted account cannot consume a different customer's budget.
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000001',false);
select public.test_assert(public.test_budget_order(md5('budget-other-customer')::uuid)->>'outcome'='placed',
  'a different customer can place a new order while the first is at the limit');
do $$ begin
  perform public.manage_order_budget('ammu-sammu','30000000-0000-4000-8000-000000000099',true);
  raise exception 'customer could reset the budget';
exception when insufficient_privilege then null;
end $$;
reset role;
set local role anon;
do $$ begin
  perform public.manage_order_budget('ammu-sammu','30000000-0000-4000-8000-000000000099');
  raise exception 'anon could inspect the budget';
exception when insufficient_privilege then null;
end $$;
reset role;
set local role service_role;
select public.test_assert((public.manage_order_budget('ammu-sammu','30000000-0000-4000-8000-000000000099')->>'used')::int=20,
  'service can inspect the budget and counts cancelled orders');
select set_config('test.other_budget',public.manage_order_budget('ammu-sammu','30000000-0000-4000-8000-000000000001')::text,true);
select public.test_assert((public.manage_order_budget('ammu-sammu','30000000-0000-4000-8000-000000000099',true)->>'used')::int=0,
  'service reset releases the slots for one customer at one restaurant');
select public.test_assert(public.manage_order_budget('ammu-sammu','30000000-0000-4000-8000-000000000001')=current_setting('test.other_budget')::jsonb,
  'reset leaves the other customer budget unchanged');
select public.test_assert((public.manage_order_budget('kokani-dine-inn','30000000-0000-4000-8000-000000000099')->>'used')::int=1,
  'reset leaves the other restaurant budget unchanged');
reset role;
select public.test_assert((select count(*)=20 and count(*) filter (where status='cancelled')=1
  from public.orders where customer_id='30000000-0000-4000-8000-000000000099' and business_id='10000000-0000-4000-8000-000000000001'),
  'reset preserves orders and cancelled status');
set local role authenticated;
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000099',false);
select public.test_assert(public.test_budget_order(md5('budget-1')::uuid)->>'status'='cancelled',
  'the old key still replays the original cancelled order after reset');
select public.test_assert(public.test_budget_order(md5('budget-after-reset')::uuid,'+91 98765 43210')->>'outcome'='placed',
  'a fresh key works after reset');
reset role;
set local role service_role;
-- This transaction pre-dates the reset, so recording the default transaction timestamp would miss the new order.
select public.test_assert((public.manage_order_budget('ammu-sammu','30000000-0000-4000-8000-000000000099')->>'used')::int=1,
  'the new order consumes a slot and the replay does not');
reset role;

-- A full budget stays full at 59 minutes and releases at 60 minutes, using server time.
insert into auth.users(id) values ('30000000-0000-4000-8000-000000000096'), ('30000000-0000-4000-8000-000000000097');
insert into public.customer_addresses(id,customer_id,label,house,street_area,latitude,longitude,location_source) values
  ('74000000-0000-4000-8000-000000000096','30000000-0000-4000-8000-000000000096','home','Old house','Old road',0.5,0.5,'pin'),
  ('74000000-0000-4000-8000-000000000097','30000000-0000-4000-8000-000000000097','home','Old house','Old road',0.5,0.5,'pin');
insert into public.orders(business_id,customer_id,customer_name,customer_phone,delivery_address_line,latitude,longitude,address_label,address_house,address_street_area,address_location_source,saved_address_id,saved_address_version,subtotal_paise,delivery_fee_paise,total_paise,idempotency_key,request_hash,created_at)
select '10000000-0000-4000-8000-000000000001',address.customer_id,'Old customer','9876543210','Old road',0.5,0.5,'home','Old house','Old road','pin',address.id,1,100,0,100,md5(address.id::text||n)::uuid,'fixture',pg_catalog.statement_timestamp()-fixture.age
from (values ('74000000-0000-4000-8000-000000000096'::uuid,interval '60 minutes'),
             ('74000000-0000-4000-8000-000000000097'::uuid,interval '59 minutes')) fixture(address_id,age)
join public.customer_addresses address on address.id=fixture.address_id
cross join generate_series(1,20) n;
select public.test_assert(offers_private.order_budget_count(customer_id,business_id,min(created_at)+interval '59 minutes')=20
  and offers_private.order_budget_count(customer_id,business_id,min(created_at)+interval '60 minutes')=0,
  'the budget counts an order at exactly 59 minutes and excludes it at exactly 60 minutes')
from public.orders where customer_id='30000000-0000-4000-8000-000000000096' group by customer_id,business_id;
set role authenticated;
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000097',false);
select public.test_budget_denied(md5('budget-59-minutes')::uuid);
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000096',false);
select public.test_assert((public.place_order('ammu-sammu','[{"menu_item_id":"20000000-0000-4000-8000-000000000001","quantity":1}]',public.test_delivery('Old customer'),jsonb_build_object('latitude',0.5,'longitude',0.5,'accuracy',10,'captured_at','2099-01-01T00:00:00Z'),md5('budget-after-window')::uuid,public.test_quote('ammu-sammu','[{"menu_item_id":"20000000-0000-4000-8000-000000000001","quantity":1}]'))->>'outcome')='placed','orders at the 60-minute boundary no longer consume budget even with an invalid client clock');
rollback;
