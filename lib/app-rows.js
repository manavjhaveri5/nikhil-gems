/* Server side of app_rows (supabase/migrations/20261104120000_app_rows_listings.sql):
   array keys kept one row per item instead of one app_data value. The ERP's
   src/utils.js does the same for the browser. Each helper takes a supabase-js
   client made with the service role. */
export const ROW_KEYS = new Set(["ng-listings-v1"]);
export const isRowKey = k => ROW_KEYS.has(k);

// The whole array, in list order.
export async function readRows(sb, key) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("app_rows").select("data,pos").eq("key", key).eq("deleted", false)
      .order("pos", { ascending: true }).order("id", { ascending: true }).range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data || []).map(r => r.data));
    if (!data || data.length < 1000) break;
  }
  return out;
}

export async function upsertRow(sb, key, item, prepend = true) {
  const { error } = await sb.rpc("app_rows_upsert", { p_key: key, p_item: item, p_prepend: prepend });
  if (error) throw new Error(error.message);
}

export async function deleteRow(sb, key, id) {
  const { error } = await sb.rpc("app_rows_delete", { p_key: key, p_id: id });
  if (error) throw new Error(error.message);
}

/* A whole-array save, written as what changed: items that differ from the
   stored rows, and stored ids missing from the new array. */
export async function saveRows(sb, key, next) {
  const stored = await readRows(sb, key);
  const was = new Map(stored.filter(x => x?.id).map(x => [x.id, JSON.stringify(x)]));
  const ids = new Set();
  const items = [];
  for (const x of next || []) {
    if (!x?.id) continue;
    ids.add(x.id);
    if (was.get(x.id) !== JSON.stringify(x)) items.push(x);
  }
  const deletes = [...was.keys()].filter(id => !ids.has(id));
  for (let i = 0; i < Math.max(items.length, 1); i += 200) {
    const { error } = await sb.rpc("app_rows_apply", { p_key: key, p_items: items.slice(i, i + 200), p_deletes: i === 0 ? deletes : [] });
    if (error) throw new Error(error.message);
  }
}
