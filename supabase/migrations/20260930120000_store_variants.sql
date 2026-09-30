-- A store product sold in options (sizes, grades): each is
-- { key, name, label, price (USD), price_inr, qty, sku }, sent from the listing's
-- variations in Listing Manager. Empty for a single piece.
alter table public.store_products add column if not exists variants jsonb not null default '[]'::jsonb;
