-- The Etsy queue's clock: every hour Postgres asks the ERP to put the next
-- queued drafts live (api/listing-manager.js, action etsy_queue_tick). The
-- timetable itself (9, 11, 13, 15, 17 US Eastern) lives in the API, so this
-- only has to knock on time. Vercel's own cron runs once a day on this plan,
-- and the GitHub schedule drifts by hours.
--
-- The knock carries a key kept in cron_keys: made here, read by the API with
-- the service role, never sent to the browser. Nobody else can read the table.

create extension if not exists pg_net;
create extension if not exists pg_cron;

create table if not exists public.cron_keys (
  name       text primary key,
  key        text not null,
  created_at timestamptz not null default now()
);
alter table public.cron_keys enable row level security;
revoke all on public.cron_keys from anon, authenticated;

insert into public.cron_keys (name, key)
values ('etsy_queue', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (name) do nothing;

-- Two minutes past each hour (UTC hours line up with Eastern ones). Scheduling
-- under the same name again replaces the job.
select cron.schedule(
  'etsy-queue',
  '2 * * * *',
  $$
  select net.http_post(
    url := 'https://project-nine-tan-22.vercel.app/api/listing-manager',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-key', (select key from public.cron_keys where name = 'etsy_queue')
    ),
    body := jsonb_build_object('action', 'etsy_queue_tick'),
    timeout_milliseconds := 60000
  )
  $$
);
