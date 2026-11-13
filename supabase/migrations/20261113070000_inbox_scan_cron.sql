-- The morning inbox scan (lib/inbox-scan.js): purchase bills with our GSTIN,
-- remittance advices and shipping papers from Gmail, at 07:00 IST, half an hour
-- before Raj's 07:30 audit. Results go to app_rows "ng-inbox-docs-v1" for Home's
-- "This morning" card. Uses Raj's cron key, already in public.cron_keys.
select cron.unschedule('inbox-scan') where exists (select 1 from cron.job where jobname = 'inbox-scan');
select cron.schedule(
  'inbox-scan',
  '30 1 * * *',
  $$
  select net.http_post(
    url := 'https://project-nine-tan-22.vercel.app/api/mail',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-key', (select key from public.cron_keys where name = 'raj')),
    body := jsonb_build_object('action', 'gmail_scan', 'days', 3),
    timeout_milliseconds := 295000
  )
  $$
);
