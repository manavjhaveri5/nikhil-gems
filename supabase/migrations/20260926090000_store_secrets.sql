-- Secrets the store's server keeps for itself (e.g. the Stripe webhook signing
-- secret it provisions). No grants: only the service role can read or write.
create table if not exists public.store_secrets (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
alter table public.store_secrets enable row level security;
revoke all on public.store_secrets from anon, authenticated;
