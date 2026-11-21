-- The weekly "new pieces" email (lib/weekly.js). Every 15 minutes the ERP checks
-- whether this week's issue needs building (Thursday 10:00 IST: test copy and
-- approve/skip email to the approver) or sending (Friday 19:30 IST, once
-- approved, in paced batches). Each call returns at once when there's nothing
-- to do. Uses Raj's cron key, already in public.cron_keys.
select cron.unschedule('weekly-new-pieces') where exists (select 1 from cron.job where jobname = 'weekly-new-pieces');
select cron.schedule(
  'weekly-new-pieces',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://project-nine-tan-22.vercel.app/api/mail',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-key', (select key from public.cron_keys where name = 'raj')),
    body := jsonb_build_object('action', 'weekly_tick'),
    timeout_milliseconds := 295000
  )
  $$
);
