-- Optimistic concurrency control for JSON-array records stored in app_data.
-- Existing records without _version are treated as version 0. The first
-- successful versioned save upgrades them to version 1.

create or replace function public.app_data_upsert_item_versioned(
  p_key text,
  p_item jsonb,
  p_expected_version integer default null,
  p_prepend boolean default true,
  p_user text default null
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
  v_existing jsonb;
  v_current_version integer;
  v_next_item jsonb;
begin
  if p_key is null or p_key = '' then
    raise exception 'app_data_upsert_item_versioned: p_key is required';
  end if;
  if v_id is null or v_id = '' then
    raise exception 'app_data_upsert_item_versioned: p_item.id is required';
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

  select elem into v_existing
  from jsonb_array_elements(v_curr) as t(elem)
  where elem->>'id' = v_id
  limit 1;

  if v_existing is not null then
    v_current_version := coalesce((v_existing->>'_version')::integer, 0);
    if p_expected_version is not null and v_current_version <> p_expected_version then
      return jsonb_build_object(
        'ok', false,
        'status', 409,
        'latest', v_existing,
        'latestVersion', v_current_version,
        'items', v_curr
      );
    end if;
    v_next_item := p_item
      || jsonb_build_object(
        '_version', v_current_version + 1,
        'updatedAt', now(),
        'updatedBy', coalesce(p_user, p_item->>'updatedBy', 'unknown')
      );

    select coalesce(jsonb_agg(case when elem->>'id' = v_id then v_next_item else elem end order by ord), '[]'::jsonb)
    into v_next
    from jsonb_array_elements(v_curr) with ordinality as t(elem, ord);
  else
    if p_expected_version is not null and p_expected_version <> 0 then
      return jsonb_build_object(
        'ok', false,
        'status', 409,
        'latest', null,
        'latestVersion', null,
        'items', v_curr
      );
    end if;
    v_next_item := p_item
      || jsonb_build_object(
        '_version', 1,
        'createdAt', coalesce(p_item->>'createdAt', now()::text),
        'updatedAt', now(),
        'updatedBy', coalesce(p_user, p_item->>'updatedBy', 'unknown')
      );
    if p_prepend then
      v_next := jsonb_build_array(v_next_item) || v_curr;
    else
      v_next := v_curr || jsonb_build_array(v_next_item);
    end if;
  end if;

  update public.app_data
  set value = v_next
  where key = p_key;

  return jsonb_build_object(
    'ok', true,
    'item', v_next_item,
    'items', v_next,
    'version', (v_next_item->>'_version')::integer
  );
end;
$$;

create or replace function public.app_data_delete_item_versioned(
  p_key text,
  p_id text,
  p_expected_version integer default null,
  p_user text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_curr jsonb;
  v_next jsonb;
  v_existing jsonb;
  v_current_version integer;
begin
  if p_key is null or p_key = '' then
    raise exception 'app_data_delete_item_versioned: p_key is required';
  end if;
  if p_id is null or p_id = '' then
    raise exception 'app_data_delete_item_versioned: p_id is required';
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

  select elem into v_existing
  from jsonb_array_elements(v_curr) as t(elem)
  where elem->>'id' = p_id
  limit 1;

  if v_existing is not null then
    v_current_version := coalesce((v_existing->>'_version')::integer, 0);
    if p_expected_version is not null and v_current_version <> p_expected_version then
      return jsonb_build_object(
        'ok', false,
        'status', 409,
        'latest', v_existing,
        'latestVersion', v_current_version,
        'items', v_curr
      );
    end if;
  end if;

  select coalesce(jsonb_agg(elem order by ord), '[]'::jsonb)
  into v_next
  from jsonb_array_elements(v_curr) with ordinality as t(elem, ord)
  where elem->>'id' is distinct from p_id;

  update public.app_data
  set value = v_next
  where key = p_key;

  return jsonb_build_object(
    'ok', true,
    'deletedId', p_id,
    'items', v_next,
    'deletedBy', coalesce(p_user, 'unknown')
  );
end;
$$;

grant execute on function public.app_data_upsert_item_versioned(text, jsonb, integer, boolean, text) to anon, authenticated;
grant execute on function public.app_data_delete_item_versioned(text, text, integer, text) to anon, authenticated;
