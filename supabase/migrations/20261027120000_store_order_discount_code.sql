-- The code a store order was discounted with (WELCOME10 on the parcel card).
-- store_orders.discount already holds the amount; this says which code took it.
alter table public.store_orders add column if not exists discount_code text not null default '';
