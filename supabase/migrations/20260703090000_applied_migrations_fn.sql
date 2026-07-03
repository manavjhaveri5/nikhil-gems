-- Read-only list of applied migration versions so external health checks
-- (e.g. the ai-ops-check GitHub Action) can detect drift between
-- supabase/migrations/ in the repo and what is actually applied in prod.
create or replace function public.applied_migrations()
returns table(version text, name text)
language sql
stable
security definer
set search_path = ''
as $$
  select m.version, coalesce(m.name, '')
  from supabase_migrations.schema_migrations m
  order by m.version;
$$;

grant execute on function public.applied_migrations() to anon, authenticated;
