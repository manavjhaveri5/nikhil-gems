/* Settings Girton's approved proposals change at runtime, without a deploy:
   app_data "girton-config-v1", e.g. { models: { captions: "gpt-5-mini" },
   captions_reasoning: "low" }. Read at most once a minute per warm function. */
import { adminClient } from "./auth.js";

export const CONFIG_KEY = "girton-config-v1";
let cache = null, at = 0;

export async function aiConfig() {
  if (cache && Date.now() - at < 60e3) return cache;
  try {
    const { data } = await adminClient().from("app_data").select("value").eq("key", CONFIG_KEY).maybeSingle();
    let v = data?.value;
    if (typeof v === "string") { try { v = JSON.parse(v); } catch { v = null; } }
    cache = v && typeof v === "object" ? v : {};
  } catch { cache = cache || {}; }
  at = Date.now();
  return cache;
}

// Deep-set one dotted path ("models.captions") and save.
export async function setConfig(path, value) {
  const cur = { ...(await aiConfig()) };
  const parts = path.split(".");
  let o = cur;
  for (const p of parts.slice(0, -1)) o = o[p] = { ...(o[p] || {}) };
  if (value === null || value === undefined) delete o[parts.at(-1)]; else o[parts.at(-1)] = value;
  const { error } = await adminClient().from("app_data").upsert({ key: CONFIG_KEY, value: cur });
  if (error) throw new Error(error.message);
  cache = cur; at = Date.now();
  return cur;
}

export function getPath(obj, path) {
  return path.split(".").reduce((o, p) => (o == null ? undefined : o[p]), obj);
}
