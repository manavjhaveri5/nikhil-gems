-- Earth Editions retail store (eartheditions.co): products published from
-- Listing Manager, orders paid through Stripe Checkout, and store settings.
-- The storefront reads and writes only through its own server (service role);
-- anon gets nothing. Staff manage everything from the ERP.

create table if not exists public.store_products (
  id           text primary key,              -- lm-<listing id>
  listing_id   text,
  handle       text not null unique,
  title        text not null default '',
  description  text not null default '',
  images       jsonb not null default '[]'::jsonb,
  videos       jsonb not null default '[]'::jsonb,
  material     text not null default '',
  shape        text not null default '',
  product_type text not null default '',
  tags         text[] not null default '{}',
  collections  text[] not null default '{}',
  price        numeric not null default 0,    -- USD
  compare_at   numeric,
  qty          integer not null default 1,
  is_unique    boolean not null default true, -- one of a kind: sells once
  status       text not null default 'active' check (status in ('active','hidden','sold')),
  featured     boolean not null default false,
  sort         integer not null default 0,
  sku          text not null default '',
  weight_g     integer,
  source       jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  sold_at      timestamptz
);
create index if not exists store_products_status_idx on public.store_products (status, sort);

create table if not exists public.store_orders (
  id             uuid primary key default gen_random_uuid(),
  number         text not null unique,
  stripe_session text unique,
  stripe_payment text,
  email          text not null default '',
  name           text not null default '',
  phone          text not null default '',
  shipping       jsonb not null default '{}'::jsonb,   -- address as Stripe returns it
  lines          jsonb not null default '[]'::jsonb,   -- [{product_id,listing_id,title,qty,price,image,unique}]
  subtotal       numeric not null default 0,
  shipping_cost  numeric not null default 0,
  discount       numeric not null default 0,
  total          numeric not null default 0,
  currency       text not null default 'usd',
  status         text not null default 'paid' check (status in ('paid','packed','shipped','delivered','refunded','cancelled')),
  tracking       text not null default '',
  notes          text not null default '',
  erp_synced     boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists store_orders_created_idx on public.store_orders (created_at desc);

create table if not exists public.store_settings (
  key   text primary key,
  value jsonb not null
);
insert into public.store_settings (key, value) values
  ('fx_inr_per_usd', '84'::jsonb),
  ('price_rounding', '"whole"'::jsonb),
  ('shipping', '{"regions":[{"name":"United States","countries":["US"],"rate":12,"free_over":150},{"name":"Rest of world","countries":["*"],"rate":35,"free_over":400}]}'::jsonb),
  ('announcement', '""'::jsonb),
  ('site_url', '"https://earth-store.vercel.app"'::jsonb)
on conflict (key) do nothing;

alter table public.store_products enable row level security;
alter table public.store_orders   enable row level security;
alter table public.store_settings enable row level security;
revoke all on public.store_products, public.store_orders, public.store_settings from anon;
grant select, insert, update, delete on public.store_products, public.store_orders, public.store_settings to authenticated;
drop policy if exists store_products_staff on public.store_products;
drop policy if exists store_orders_staff   on public.store_orders;
drop policy if exists store_settings_staff on public.store_settings;
create policy store_products_staff on public.store_products for all to authenticated using (true) with check (true);
create policy store_orders_staff   on public.store_orders   for all to authenticated using (true) with check (true);
create policy store_settings_staff on public.store_settings for all to authenticated using (true) with check (true);
