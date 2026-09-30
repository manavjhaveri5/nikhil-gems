-- Who is on eartheditions.co and what they do there, for the ERP's Store →
-- Visitors tab. The storefront writes through its own server (service role);
-- staff read with their ERP session; anon gets nothing.
--
-- No IP addresses are kept: the country / region / city come from Vercel's
-- location headers at the moment of the visit. A visitor is an anonymous id
-- kept in their browser; a name or email is only attached when they give it
-- (newsletter sign-up, an order).

create table if not exists public.site_events (
  id        bigint generated always as identity primary key,
  at        timestamptz not null default now(),
  vid       text not null default '',        -- anonymous visitor id (their browser)
  sid       text not null default '',        -- one visit
  type      text not null,                   -- view | add_to_cart | checkout | purchase | signup | option | search
  path      text not null default '',
  title     text not null default '',
  handle    text,                            -- product page / product acted on
  source    text not null default '',        -- where the visit came from: instagram, google, reddit, direct…
  medium    text not null default '',
  campaign  text not null default '',
  referrer  text not null default '',
  country   text not null default '',
  region    text not null default '',
  city      text not null default '',
  device    text not null default '',        -- mobile | tablet | desktop
  browser   text not null default '',
  os        text not null default '',
  lang      text not null default '',
  is_staff  boolean not null default false,
  data      jsonb not null default '{}'::jsonb   -- email / name / order on signup and purchase; option picked…
);
create index if not exists site_events_at_idx  on public.site_events (at desc);
create index if not exists site_events_vid_idx on public.site_events (vid, at desc);

-- One row per open visit, refreshed every 30 s while the page is open:
-- "on the site right now" = seen in the last minute or so.
create table if not exists public.site_live (
  sid        text primary key,
  vid        text not null default '',
  path       text not null default '',
  title      text not null default '',
  source     text not null default '',
  country    text not null default '',
  city       text not null default '',
  device     text not null default '',
  is_staff   boolean not null default false,
  started_at timestamptz not null default now(),
  last_seen  timestamptz not null default now()
);
create index if not exists site_live_seen_idx on public.site_live (last_seen desc);

alter table public.site_events enable row level security;
alter table public.site_live   enable row level security;
revoke all on public.site_events, public.site_live from anon;
grant select, delete on public.site_events, public.site_live to authenticated;
drop policy if exists site_events_staff on public.site_events;
drop policy if exists site_live_staff   on public.site_live;
create policy site_events_staff on public.site_events for all to authenticated using (true) with check (true);
create policy site_live_staff   on public.site_live   for all to authenticated using (true) with check (true);

-- Store → Social: the ready-to-post pack made for each piece (captions, story
-- lines, pins, a Reddit post, a Mindat caption, an email blurb).
alter table public.store_products add column if not exists social jsonb;
