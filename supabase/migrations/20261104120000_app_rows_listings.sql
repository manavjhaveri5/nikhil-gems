-- Listings, one row per piece.
--
-- ng-listings-v1 was a single app_data row holding every listing (4.6 MB, 1,283
-- pieces). Postgres rewrites a row whole, so saving one listing wrote 4.6 MB,
-- and every open ERP tab then downloaded 4.6 MB again. With the queue, the
-- Etsy sync, the bot and pushes to EarthEditions all saving listings, that used
-- up the project's disk IO budget and stalled every other query behind it.
--
-- app_rows holds an array key as rows: (key, id) → data, with `pos` for the
-- order the list had (newest first) and `deleted` as a tombstone so a client
-- can fetch just what changed since it last looked (updated_at > its mark).
-- Writes go through the functions below; each one bumps app_data_versions, so
-- open screens hear about it the way they hear about app_data changes.

create table if not exists public.app_rows (
  key text not null,
  id text not null,
  pos double precision not null default 0,
  data jsonb not null,
  deleted boolean not null default false,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (key, id)
);
create index if not exists app_rows_key_updated on public.app_rows (key, updated_at);

alter table public.app_rows enable row level security;
drop policy if exists app_rows_read on public.app_rows;
create policy app_rows_read on public.app_rows for select to authenticated using (true);
revoke all on public.app_rows from anon;
grant select on public.app_rows to authenticated;

create or replace function public.app_rows_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;
drop trigger if exists app_rows_touch on public.app_rows;
create trigger app_rows_touch before insert or update on public.app_rows
for each row execute function public.app_rows_touch();

-- One version bump per key per statement, not per row.
create or replace function public.app_rows_bump()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.app_data_versions as v (key, ts, rev)
  select distinct r.key, now(), 1 from changed r
  on conflict (key) do update set ts = excluded.ts, rev = v.rev + 1;
  return null;
end;
$$;
drop trigger if exists app_rows_bump_ins on public.app_rows;
drop trigger if exists app_rows_bump_upd on public.app_rows;
create trigger app_rows_bump_ins after insert on public.app_rows
referencing new table as changed for each statement execute function public.app_rows_bump();
create trigger app_rows_bump_upd after update on public.app_rows
referencing new table as changed for each statement execute function public.app_rows_bump();

-- Save several items and remove some, in one go. Items not there yet go in
-- ahead of the list, in the order given (a new piece is the newest).
create or replace function public.app_rows_apply(p_key text, p_items jsonb default '[]'::jsonb, p_deletes text[] default '{}')
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_items jsonb := coalesce(p_items, '[]'::jsonb);
  v_min double precision;
  v_n integer := 0;
  v_cnt integer;
begin
  if coalesce(p_key, '') = '' then raise exception 'app_rows_apply: p_key is required'; end if;
  if jsonb_typeof(v_items) <> 'array' then raise exception 'app_rows_apply: p_items must be an array'; end if;

  with d as (
    select distinct on (e.value->>'id') e.value as item, e.value->>'id' as id
    from jsonb_array_elements(v_items) with ordinality e(value, ord)
    where coalesce(e.value->>'id', '') <> ''
    order by e.value->>'id', e.ord desc
  )
  update public.app_rows a set data = d.item, deleted = false
  from d
  where a.key = p_key and a.id = d.id and (a.data is distinct from d.item or a.deleted);
  get diagnostics v_cnt = row_count; v_n := v_n + v_cnt;

  select coalesce(min(pos), 0) into v_min from public.app_rows where key = p_key;
  insert into public.app_rows (key, id, pos, data)
  select p_key, x.id, v_min - x.cnt - 1 + x.rn, x.item
  from (
    select n.*, row_number() over (order by n.ord) as rn, count(*) over () as cnt
    from (
      select distinct on (e.value->>'id') e.value as item, e.value->>'id' as id, e.ord
      from jsonb_array_elements(v_items) with ordinality e(value, ord)
      where coalesce(e.value->>'id', '') <> ''
      order by e.value->>'id', e.ord desc
    ) n
    where not exists (select 1 from public.app_rows a where a.key = p_key and a.id = n.id)
  ) x;
  get diagnostics v_cnt = row_count; v_n := v_n + v_cnt;

  update public.app_rows set deleted = true, data = jsonb_build_object('id', id)
  where key = p_key and id = any(coalesce(p_deletes, '{}')) and not deleted;
  get diagnostics v_cnt = row_count; v_n := v_n + v_cnt;
  return v_n;
end;
$$;

-- Save one item; a new one goes first (p_prepend) or last.
create or replace function public.app_rows_upsert(p_key text, p_item jsonb, p_prepend boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_id text := p_item->>'id';
  v_pos double precision;
  v_upd timestamptz;
begin
  if coalesce(p_key, '') = '' then raise exception 'app_rows_upsert: p_key is required'; end if;
  if coalesce(v_id, '') = '' then raise exception 'app_rows_upsert: p_item.id is required'; end if;
  update public.app_rows set data = p_item, deleted = false
  where key = p_key and id = v_id and (data is distinct from p_item or deleted);
  if not found and not exists (select 1 from public.app_rows where key = p_key and id = v_id) then
    select case when p_prepend then coalesce(min(pos), 0) - 1 else coalesce(max(pos), 0) + 1 end
      into v_pos from public.app_rows where key = p_key;
    insert into public.app_rows (key, id, pos, data) values (p_key, v_id, v_pos, p_item)
    on conflict (key, id) do update set data = excluded.data, deleted = false;
  end if;
  select pos, updated_at into v_pos, v_upd from public.app_rows where key = p_key and id = v_id;
  return jsonb_build_object('id', v_id, 'pos', v_pos, 'updated_at', v_upd);
end;
$$;

create or replace function public.app_rows_delete(p_key text, p_id text)
returns integer language sql security definer set search_path = public as $$
  select public.app_rows_apply(p_key, '[]'::jsonb, array[p_id]);
$$;

revoke all on function public.app_rows_apply(text, jsonb, text[]) from public, anon;
revoke all on function public.app_rows_upsert(text, jsonb, boolean) from public, anon;
revoke all on function public.app_rows_delete(text, text) from public, anon;
grant execute on function public.app_rows_apply(text, jsonb, text[]) to authenticated, service_role;
grant execute on function public.app_rows_upsert(text, jsonb, boolean) to authenticated, service_role;
grant execute on function public.app_rows_delete(text, text) to authenticated, service_role;

-- Copy the listings across, in their current order.
insert into public.app_rows (key, id, pos, data)
select 'ng-listings-v1', e.value->>'id', e.ord, e.value
from public.app_data a, jsonb_array_elements(a.value) with ordinality e(value, ord)
where a.key = 'ng-listings-v1' and jsonb_typeof(a.value) = 'array' and coalesce(e.value->>'id', '') <> ''
on conflict (key, id) do nothing;

-- Bridge, for the switch-over: a tab opened before the new code, or anything
-- else still writing the old app_data row, has what it changed carried into
-- app_rows — only the items that differ from the row it replaced, so a stale
-- copy can't roll back edits made since. Drop once nothing writes the old row.
create or replace function public.app_rows_bridge()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_old jsonb := case when tg_op = 'UPDATE' then old.value else '[]'::jsonb end;
  v_new jsonb := new.value;
  v_items jsonb;
  v_dels text[];
begin
  if jsonb_typeof(v_new) <> 'array' then return null; end if;
  if jsonb_typeof(v_old) <> 'array' then v_old := '[]'::jsonb; end if;
  with o as (select e.value->>'id' as id, e.value from jsonb_array_elements(v_old) e),
       n as (select e.value->>'id' as id, e.value, e.ord from jsonb_array_elements(v_new) with ordinality e(value, ord))
  select coalesce(jsonb_agg(n.value order by n.ord), '[]'::jsonb) into v_items
  from n left join o on o.id = n.id
  where o.id is null or o.value is distinct from n.value;
  with o as (select e.value->>'id' as id from jsonb_array_elements(v_old) e),
       n as (select e.value->>'id' as id from jsonb_array_elements(v_new) e)
  select coalesce(array_agg(o.id), '{}') into v_dels
  from o left join n on n.id = o.id
  where n.id is null and o.id is not null;
  perform public.app_rows_apply(new.key, v_items, v_dels);
  return null;
end;
$$;
drop trigger if exists app_rows_bridge on public.app_data;
create trigger app_rows_bridge after insert or update on public.app_data
for each row when (new.key = 'ng-listings-v1') execute function public.app_rows_bridge();

-- Check: both counts should match.
select
  (select jsonb_array_length(value) from public.app_data where key = 'ng-listings-v1') as in_old_row,
  (select count(*) from public.app_rows where key = 'ng-listings-v1' and not deleted) as in_app_rows;
