\set ON_ERROR_STOP on
-- Shared fixture for the final-schema suites (isolation, checkout, notifications,
-- notification-routing, accepting-orders). Apply after every migration and seed.sql.
-- Orders here carry the saved-address snapshot, never the legacy typed-address evidence.
insert into auth.users(id) values
('30000000-0000-4000-8000-000000000001'),('30000000-0000-4000-8000-000000000002'),
('30000000-0000-4000-8000-000000000003'),('30000000-0000-4000-8000-000000000004'),
('30000000-0000-4000-8000-000000000005');
insert into public.business_memberships(business_id,user_id,role) values
('10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000003','admin'),
('10000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000004','admin');
-- Each customer's saved address. Customer A's pin lies inside the fictional 0..1 degree
-- service square that isolation.sql installs, so A can check out once ordering is enabled.
insert into public.customer_addresses(id,customer_id,label,house,street_area,latitude,longitude,location_source) values
('74000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','home','Fixture house A','Fixture Road',0.5,0.5,'pin'),
('74000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000002','home','Fixture house B','Fixture Road',0.5,0.5,'pin');
insert into public.orders(id,business_id,customer_id,customer_name,customer_phone,delivery_address_line,latitude,longitude,address_label,address_house,address_street_area,address_location_source,saved_address_id,saved_address_version,subtotal_paise,delivery_fee_paise,total_paise,idempotency_key,request_hash) values
('40000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','Customer A','0','Fixture house A, Fixture Road',0.5,0.5,'home','Fixture house A','Fixture Road','pin','74000000-0000-4000-8000-000000000001',1,15000,0,15000,'50000000-0000-4000-8000-000000000001','hash-a'),
('40000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000002','Customer B','0','Fixture house B, Fixture Road',0.5,0.5,'home','Fixture house B','Fixture Road','pin','74000000-0000-4000-8000-000000000002',1,18000,0,18000,'50000000-0000-4000-8000-000000000002','hash-b');
-- Customer A's pre-session (legacy) device token: visible only to A, never queued for notifications.
insert into public.device_tokens(user_id,business_id,audience,token) values ('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','customer','device-a');
insert into public.order_items(order_id,name,unit_price_paise,quantity,line_total_paise) select id,'Snapshot',100,1,100 from public.orders;
insert into public.order_status_history(order_id,status) select id,'placed' from public.orders;
