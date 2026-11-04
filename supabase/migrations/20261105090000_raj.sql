-- Raj, the ERP's chief of operations (src/RajApp.jsx, lib/raj.js).
--
-- 1. Listing change log. Every edit to a listing (price, title, description,
--    tags, photos, stock, channels…) lands here, whoever made it: the ERP,
--    the Etsy queue, the Telegram bot. Raj reads it to say what was changed
--    and, a week later, what happened to that listing's views and sales.
--    Photos and channels are compared as a short summary (count + cover;
--    channel names), so syncs that only touch timestamps write nothing.
-- 2. Raj's two daily knocks: the numbers at 07:45 IST (after the eBay order
--    sync at 07:30) and, at 09:30 IST, a numbers-only briefing if Claude on
--    the Mac hasn't written one.

create table if not exists public.raj_listing_changes (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  listing_id text not null,
  title      text not null default '',
  field      text not null,
  before     text,
  after      text
);
create index if not exists raj_listing_changes_at_idx on public.raj_listing_changes (at desc);
create index if not exists raj_listing_changes_listing_idx on public.raj_listing_changes (listing_id, at desc);
alter table public.raj_listing_changes enable row level security;
revoke all on public.raj_listing_changes from anon;
grant select on public.raj_listing_changes to authenticated;
drop policy if exists raj_listing_changes_read on public.raj_listing_changes;
create policy raj_listing_changes_read on public.raj_listing_changes for select to authenticated using (true);

-- What a field looks like in the log: short, and only what matters.
create or replace function public.raj_field_text(k text, v jsonb)
returns text language sql immutable as $$
  select case
    when v is null or v = 'null'::jsonb then null
    when k = 'images' and jsonb_typeof(v) = 'array' then
      jsonb_array_length(v)::text || ' photos, cover ' ||
      coalesce(regexp_replace(coalesce(v->0->>'url', v->>0, ''), '^.*/', ''), '')
    when k = 'platforms' and jsonb_typeof(v) = 'object' then
      coalesce((select string_agg(x, ', ' order by x) from jsonb_object_keys(v) x
                where coalesce(v->x->>'status', v->x->>'state', 'on') not in ('removed', 'deleted', 'off', '')), '')
    when k = 'tags' and jsonb_typeof(v) = 'array' then
      left((select string_agg(t, ', ') from jsonb_array_elements_text(v) t), 400)
    when k = 'description' then
      length(v #>> '{}')::text || ' chars: ' || left(v #>> '{}', 160)
    else left(v #>> '{}', 300)
  end
$$;

create or replace function public.raj_log_listing_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  o jsonb := case when tg_op = 'UPDATE' then old.data else '{}'::jsonb end;
  n jsonb := new.data;
  t text := left(coalesce(n->>'title', o->>'title', ''), 140);
  k text;
  b text;
  a text;
begin
  if tg_op = 'INSERT' then
    if not new.deleted then
      insert into raj_listing_changes (listing_id, title, field, after)
      values (new.id, t, 'created', nullif(coalesce(n->>'price_etsy', n->>'price', ''), ''));
    end if;
    return null;
  end if;
  if new.deleted and not old.deleted then
    insert into raj_listing_changes (listing_id, title, field) values (new.id, left(coalesce(o->>'title', ''), 140), 'removed');
    return null;
  end if;
  if new.deleted or o = n then return null; end if;
  for k in
    select distinct x from (select jsonb_object_keys(o) x union select jsonb_object_keys(n)) s
    where x in ('title', 'description', 'tags', 'images', 'video', 'qty', 'platforms', 'material', 'shape', 'sku', 'etsy_section_id')
       or x like 'price%'
  loop
    b := raj_field_text(k, o->k);
    a := raj_field_text(k, n->k);
    if b is distinct from a then
      insert into raj_listing_changes (listing_id, title, field, before, after) values (new.id, t, k, b, a);
    end if;
  end loop;
  return null;
end;
$$;

drop trigger if exists raj_listing_changes on public.app_rows;
create trigger raj_listing_changes after insert or update on public.app_rows
for each row when (new.key = 'ng-listings-v1') execute function public.raj_log_listing_change();

-- The knocks carry their own key (cron_keys, service role only).
insert into public.cron_keys (name, key)
values ('raj', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (name) do nothing;

select cron.schedule(
  'raj-snapshot',
  '15 2 * * *',
  $$
  select net.http_post(
    url := 'https://project-nine-tan-22.vercel.app/api/listing-manager',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-key', (select key from public.cron_keys where name = 'raj')),
    body := jsonb_build_object('action', 'raj_snapshot'),
    timeout_milliseconds := 120000
  )
  $$
);

select cron.schedule(
  'raj-fallback',
  '0 4 * * *',
  $$
  select net.http_post(
    url := 'https://project-nine-tan-22.vercel.app/api/listing-manager',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-key', (select key from public.cron_keys where name = 'raj')),
    body := jsonb_build_object('action', 'raj_fallback'),
    timeout_milliseconds := 60000
  )
  $$
);
