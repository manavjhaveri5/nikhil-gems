-- A short size line under the title ("47mm · 690g"), split out of Etsy's long titles,
-- and the store's discount off the Etsy list price (the Etsy shop runs a standing sale).
alter table public.store_products add column if not exists subtitle text not null default '';
insert into public.store_settings (key, value) values ('etsy_discount_pct', '25'::jsonb) on conflict (key) do nothing;
