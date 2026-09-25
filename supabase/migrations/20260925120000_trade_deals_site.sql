-- Mineral deals (ready to ship, free shipping) and the public-page settings.
alter table public.trade_products
  add column if not exists is_deal   boolean not null default false,
  add column if not exists deal_note text    not null default '';

insert into public.trade_settings (key, value) values
  ('about', to_jsonb('Earth Editions is a family business. We supply crystals and minerals to shops, stockists and practitioners around the world — by the piece, by the kilo and by the lot.'::text)),
  ('hidden_shows', '[]'::jsonb),
  ('public_limit', '50'::jsonb)
on conflict (key) do nothing;
