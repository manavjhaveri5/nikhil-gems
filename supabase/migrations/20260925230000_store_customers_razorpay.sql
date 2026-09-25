-- Customer accounts for eartheditions.co (not Supabase users — the storefront
-- signs them in itself), rupee prices for Indian checkout, and order fields
-- for Razorpay alongside Stripe.
create table if not exists public.store_customers (
  id             uuid primary key default gen_random_uuid(),
  email          text not null,
  name           text not null default '',
  phone          text not null default '',
  password_hash  text not null,
  reset_hash     text,
  reset_expires  timestamptz,
  failed_logins  integer not null default 0,
  locked_until   timestamptz,
  marketing      boolean not null default false,
  address        jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  last_login     timestamptz
);
create unique index if not exists store_customers_email_idx on public.store_customers (lower(email));
alter table public.store_customers enable row level security;
revoke all on public.store_customers from anon;
grant select, update on public.store_customers to authenticated;
drop policy if exists store_customers_staff on public.store_customers;
create policy store_customers_staff on public.store_customers for select to authenticated using (true);

alter table public.store_orders
  add column if not exists customer_id uuid references public.store_customers(id) on delete set null,
  add column if not exists gateway     text not null default 'stripe',   -- stripe | razorpay
  add column if not exists gateway_order text;                            -- Razorpay order id
alter table public.store_orders drop constraint if exists store_orders_status_check;
alter table public.store_orders add constraint store_orders_status_check
  check (status in ('pending','paid','packed','shipped','delivered','refunded','cancelled'));
create unique index if not exists store_orders_gateway_order_idx on public.store_orders (gateway_order) where gateway_order is not null;

alter table public.store_products add column if not exists price_inr numeric;
insert into public.store_settings (key, value) values
  ('india_shipping', '{"rate": 150, "free_over": 5000}'::jsonb)
on conflict (key) do nothing;
