-- Editors: trade-site accounts that can change products from the site itself.
alter table public.trade_buyers   add column if not exists is_editor boolean not null default false;
-- Product videos, shown in the gallery beside the photos.
alter table public.trade_products add column if not exists videos jsonb not null default '[]'::jsonb;

update public.trade_buyers set is_editor = true, status = 'approved'
  where email = 'manav08jhaveri@hotmail.com';
