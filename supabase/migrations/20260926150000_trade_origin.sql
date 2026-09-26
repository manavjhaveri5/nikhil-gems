-- Where a trade product's stone comes from (a country, e.g. "India"). Asked
-- for, AI-suggested, when a listing is first posted to the trade site from
-- Listing Manager; editable in the ERP and by editors on the site.
alter table public.trade_products add column if not exists origin text not null default '';
