-- Raj's listing audit (lib/raj-audit.js): every listing on every channel checked
-- at 07:30 IST, a quarter of an hour before the morning snapshot reads it.
select cron.schedule(
  'raj-audit',
  '0 2 * * *',
  $$
  select net.http_post(
    url := 'https://project-nine-tan-22.vercel.app/api/listing-manager',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-key', (select key from public.cron_keys where name = 'raj')),
    body := jsonb_build_object('action', 'raj_audit'),
    timeout_milliseconds := 290000
  )
  $$
);
