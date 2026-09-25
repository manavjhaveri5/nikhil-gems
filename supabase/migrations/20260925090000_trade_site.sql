-- Trade site (trade.eartheditions.co) — the wholesale catalogue, its buyers
-- and the carts they send over WhatsApp.
--
-- Buyers are NOT Supabase auth users. Every signed-in user of this project can
-- read app_data, so a buyer holding a Supabase session would hold the books.
-- The trade site talks to these tables only through its own server function
-- with the service role; anon gets nothing. The ERP (staff, authenticated)
-- manages them directly.

create table if not exists public.trade_products (
  id           text primary key,
  handle       text,
  title        text not null default '',
  description  text not null default '',
  collections  text[] not null default '{}',
  product_type text not null default '',
  shape        text not null default '',
  material     text not null default '',
  tags         text[] not null default '{}',
  images       jsonb not null default '[]'::jsonb,   -- [url]
  variants     jsonb not null default '[]'::jsonb,   -- [{id,title,price,sku,stock}]
  price        numeric not null default 0,           -- lowest variant price; 0 = on request
  unit         text not null default 'piece',        -- piece | kg | lot
  stock        integer,
  is_new       boolean not null default false,
  new_at       timestamptz,
  live         boolean not null default true,
  sort         integer not null default 0,
  source       jsonb not null default '{}'::jsonb,   -- {shopify_id, stock_id, ...}
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists trade_products_live_idx on public.trade_products (live, sort);

create table if not exists public.trade_buyers (
  id              uuid primary key default gen_random_uuid(),
  email           text not null,
  name            text not null default '',
  company         text not null default '',
  phone           text not null default '',
  city            text not null default '',
  state           text not null default '',
  country         text not null default '',
  resale_no       text not null default '',
  resale_docs     jsonb not null default '[]'::jsonb, -- [{name,path,type,size,uploadedAt}] in trade-private
  status          text not null default 'pending' check (status in ('pending','approved','paused','declined')),
  password_hash   text,
  invite_hash     text,        -- sha256 of the one-time set-password token
  invite_expires  timestamptz,
  failed_logins   integer not null default 0,
  locked_until    timestamptz,
  shopify_id      text,
  notes           text not null default '',
  created_at      timestamptz not null default now(),
  approved_at     timestamptz,
  last_login      timestamptz
);
create unique index if not exists trade_buyers_email_idx on public.trade_buyers (lower(email));

create table if not exists public.trade_enquiries (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  buyer_id    uuid references public.trade_buyers(id) on delete set null,
  buyer       jsonb not null default '{}'::jsonb,  -- snapshot: name, company, email, phone, state
  lines       jsonb not null default '[]'::jsonb,  -- [{product_id,title,variant,qty,price,unit,image}]
  note        text not null default '',
  total       numeric not null default 0,
  currency    text not null default 'USD',
  status      text not null default 'new' check (status in ('new','talking','invoiced','lost')),
  staff_note  text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists trade_enquiries_created_idx on public.trade_enquiries (created_at desc);

create table if not exists public.trade_settings (
  key   text primary key,
  value jsonb not null
);
insert into public.trade_settings (key, value) values
  ('whatsapp', '""'::jsonb),
  ('hide_prices', 'true'::jsonb),
  ('min_order', '0'::jsonb),
  ('currency', '"USD"'::jsonb)
on conflict (key) do nothing;

alter table public.trade_products  enable row level security;
alter table public.trade_buyers    enable row level security;
alter table public.trade_enquiries enable row level security;
alter table public.trade_settings  enable row level security;

revoke all on public.trade_products, public.trade_buyers, public.trade_enquiries, public.trade_settings from anon;
grant select, insert, update, delete on public.trade_products, public.trade_buyers, public.trade_enquiries, public.trade_settings to authenticated;

drop policy if exists trade_products_staff  on public.trade_products;
drop policy if exists trade_buyers_staff    on public.trade_buyers;
drop policy if exists trade_enquiries_staff on public.trade_enquiries;
drop policy if exists trade_settings_staff  on public.trade_settings;
create policy trade_products_staff  on public.trade_products  for all to authenticated using (true) with check (true);
create policy trade_buyers_staff    on public.trade_buyers    for all to authenticated using (true) with check (true);
create policy trade_enquiries_staff on public.trade_enquiries for all to authenticated using (true) with check (true);
create policy trade_settings_staff  on public.trade_settings  for all to authenticated using (true) with check (true);

-- Photos are public; resale certificates are not.
insert into storage.buckets (id, name, public) values ('trade-media', 'trade-media', true)
  on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('trade-private', 'trade-private', false)
  on conflict (id) do nothing;

drop policy if exists trade_media_staff_write on storage.objects;
create policy trade_media_staff_write on storage.objects for all to authenticated
  using (bucket_id in ('trade-media','trade-private'))
  with check (bucket_id in ('trade-media','trade-private'));
