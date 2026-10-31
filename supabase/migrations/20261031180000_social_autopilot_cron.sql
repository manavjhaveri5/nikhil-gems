-- The social autopilot's clock. GitHub Actions knocked hourly with the store
-- secret, but the repository never had that secret, so every run failed and
-- nothing posted. Postgres knocks instead, the same way as the Etsy queue
-- (20261031120000_etsy_queue_cron.sql), with its own key in cron_keys.

insert into public.cron_keys (name, key)
values ('social', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (name) do nothing;

-- Seven past each hour, as the workflow did. The autopilot can run for minutes.
select cron.schedule(
  'social-autopilot',
  '7 * * * *',
  $$
  select net.http_post(
    url := 'https://project-nine-tan-22.vercel.app/api/social?action=cron',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-key', (select key from public.cron_keys where name = 'social')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 290000
  )
  $$
);
