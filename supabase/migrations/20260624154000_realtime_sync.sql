-- Reliable app_data invalidation and atomic item writes.
-- app_data can hold very large JSON values, so realtime is enabled only on this
-- tiny per-key versions table. Every writer to app_data advances one row here.

create table if not exists public.app_data_versions (
  key text primary key,
  ts timestamptz not null default now(),
  rev bigint not null default 1
);

grant select on public.app_data_versions to anon, authenticated;

create or replace function public.bump_app_data_version()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.app_data_versions as v (key, ts, rev)
  values (new.key, now(), 1)
  on conflict (key) do update
    set ts = excluded.ts,
        rev = v.rev + 1;
  return new;
end;
$$;

drop trigger if exists app_data_version_bump on public.app_data;
create trigger app_data_version_bump
after insert or update on public.app_data
for each row
execute function public.bump_app_data_version();

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1
       from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'app_data_versions'
     ) then
    alter publication supabase_realtime add table public.app_data_versions;
  end if;
end $$;

create or replace function public.app_data_upsert_item(
  p_key text,
  p_item jsonb,
  p_prepend boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id text := p_item->>'id';
  v_curr jsonb;
  v_next jsonb;
begin
  if p_key is null or p_key = '' then
    raise exception 'app_data_upsert_item: p_key is required';
  end if;
  if v_id is null or v_id = '' then
    raise exception 'app_data_upsert_item: p_item.id is required';
  end if;

  insert into public.app_data (key, value)
  values (p_key, '[]'::jsonb)
  on conflict (key) do nothing;

  select value into v_curr
  from public.app_data
  where key = p_key
  for update;

  if jsonb_typeof(coalesce(v_curr, '[]'::jsonb)) <> 'array' then
    v_curr := '[]'::jsonb;
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_curr) as t(elem)
    where elem->>'id' = v_id
  ) then
    select coalesce(jsonb_agg(case when elem->>'id' = v_id then p_item else elem end order by ord), '[]'::jsonb)
    into v_next
    from jsonb_array_elements(v_curr) with ordinality as t(elem, ord);
  elsif p_prepend then
    v_next := jsonb_build_array(p_item) || v_curr;
  else
    v_next := v_curr || jsonb_build_array(p_item);
  end if;

  update public.app_data
  set value = v_next
  where key = p_key;

  return v_next;
end;
$$;

create or replace function public.app_data_delete_item(
  p_key text,
  p_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_curr jsonb;
  v_next jsonb;
begin
  if p_key is null or p_key = '' then
    raise exception 'app_data_delete_item: p_key is required';
  end if;
  if p_id is null or p_id = '' then
    raise exception 'app_data_delete_item: p_id is required';
  end if;

  insert into public.app_data (key, value)
  values (p_key, '[]'::jsonb)
  on conflict (key) do nothing;

  select value into v_curr
  from public.app_data
  where key = p_key
  for update;

  if jsonb_typeof(coalesce(v_curr, '[]'::jsonb)) <> 'array' then
    v_curr := '[]'::jsonb;
  end if;

  select coalesce(jsonb_agg(elem order by ord), '[]'::jsonb)
  into v_next
  from jsonb_array_elements(v_curr) with ordinality as t(elem, ord)
  where elem->>'id' is distinct from p_id;

  update public.app_data
  set value = v_next
  where key = p_key;

  return v_next;
end;
$$;

grant execute on function public.app_data_upsert_item(text, jsonb, boolean) to anon, authenticated;
grant execute on function public.app_data_delete_item(text, text) to anon, authenticated;
