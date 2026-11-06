-- Girton, the cost watchdog (lib/girton.js).
-- girton_usage(): what the project uses against its plan, in one cheap call
-- (database size, file storage, biggest tables, scheduled jobs). Service role only.
create or replace function public.girton_usage()
returns jsonb language sql security definer set search_path = public, storage, pg_catalog as $$
  select jsonb_build_object(
    'db_bytes', pg_database_size(current_database()),
    'storage_bytes', (select coalesce(sum((metadata->>'size')::bigint), 0) from storage.objects),
    'storage_objects', (select count(*) from storage.objects),
    'buckets', (select coalesce(jsonb_agg(b order by b->>'bytes' desc), '[]'::jsonb) from (
        select jsonb_build_object('bucket', bucket_id, 'objects', count(*), 'bytes', coalesce(sum((metadata->>'size')::bigint), 0)) b
        from storage.objects group by bucket_id) x),
    'tables', (select coalesce(jsonb_agg(t), '[]'::jsonb) from (
        select jsonb_build_object('table', n.nspname || '.' || c.relname, 'bytes', pg_total_relation_size(c.oid), 'rows', c.reltuples::bigint) t
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind = 'r' and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
        order by pg_total_relation_size(c.oid) desc limit 12) x),
    'app_rows_keys', (select coalesce(jsonb_agg(k), '[]'::jsonb) from (
        select jsonb_build_object('key', key, 'rows', count(*), 'bytes', sum(pg_column_size(data))) k
        from public.app_rows group by key order by sum(pg_column_size(data)) desc limit 12) x),
    'app_data_keys', (select coalesce(jsonb_agg(k), '[]'::jsonb) from (
        select jsonb_build_object('key', key, 'bytes', pg_column_size(value)) k
        from public.app_data order by pg_column_size(value) desc limit 12) x),
    'cron_jobs', (select coalesce(jsonb_agg(jsonb_build_object('job', jobname, 'schedule', schedule)), '[]'::jsonb) from cron.job)
  );
$$;
revoke all on function public.girton_usage() from public, anon, authenticated;
grant execute on function public.girton_usage() to service_role;

-- Hourly, at 20 past (after the Etsy queue at :02).
select cron.schedule(
  'girton-tick',
  '20 * * * *',
  $$
  select net.http_post(
    url := 'https://project-nine-tan-22.vercel.app/api/listing-manager',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-key', (select key from public.cron_keys where name = 'raj')),
    body := jsonb_build_object('action', 'girton_tick'),
    timeout_milliseconds := 60000
  )
  $$
);
