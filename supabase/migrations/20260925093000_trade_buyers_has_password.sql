-- The ERP only needs to know whether a buyer has set a password, never the hash.
alter table public.trade_buyers
  add column if not exists has_password boolean generated always as (password_hash is not null) stored;
