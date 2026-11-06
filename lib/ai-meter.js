/* Girton's AI meter: every server-side AI call goes through aiFetch, which
   records one small row per call (feature, model, tokens, cost, ms, status)
   in app_rows key "girton-ai-v1". The call itself is untouched: the response
   is returned as fetch gave it, and a failed log never fails the call.

   Costs are estimates from list prices (USD per 1M tokens, standard tier,
   developers.openai.com/api/docs/pricing as of 6 Nov 2026). OpenAI's own
   usage page stays the bill; this is what tells you which feature spent it. */
import { adminClient } from "./auth.js";

export const AI_KEY = "girton-ai-v1";

// [input, cached input, output] per 1M tokens. Longest matching prefix wins.
export const PRICES = {
  "gpt-5.5": [5, 0.5, 30],
  "gpt-5.2": [1.75, 0.175, 14],
  "gpt-5-mini": [0.25, 0.025, 2],
  "gpt-5-nano": [0.05, 0.005, 0.4],
  "gpt-5": [1.25, 0.125, 10],
  "gpt-4.1-mini": [0.4, 0.1, 1.6],
  "gpt-4.1-nano": [0.1, 0.025, 0.4],
  "gpt-4.1": [2, 0.5, 8],
  "gpt-4o-mini": [0.15, 0.075, 0.6],
  "gpt-4o": [2.5, 1.25, 10],
  "text-embedding-3-small": [0.02, 0.02, 0],
  "gpt-image-1.5": [8, 2, 32],   // image tokens; text input is cheaper, so this errs high
  "gpt-image-1": [10, 2.5, 40],
  "claude-haiku-4-5": [1, 0.1, 5],
  "claude-sonnet": [3, 0.3, 15],
};
const WEB_SEARCH_PER_CALL = 0.025;   // web_search_preview, non-reasoning models

export function priceOf(model = "") {
  const m = String(model).toLowerCase();
  let best = null;
  for (const k of Object.keys(PRICES)) if (m.startsWith(k) && (!best || k.length > best.length)) best = k;
  return best ? PRICES[best] : null;
}

// Every API shape we use, reduced to { in, cached, out }.
export function tokensOf(u) {
  if (!u) return { in: 0, cached: 0, out: 0 };
  const inp = u.input_tokens ?? u.prompt_tokens ?? 0;
  const cached = u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens ?? 0;
  const out = u.output_tokens ?? u.completion_tokens ?? 0;
  return { in: +inp || 0, cached: +cached || 0, out: +out || 0 };
}

export function costOf(model, t, searches = 0) {
  const p = priceOf(model);
  const search = searches * WEB_SEARCH_PER_CALL;
  if (!p) return { usd: search, priced: false };
  const fresh = Math.max(0, t.in - t.cached);
  return { usd: (fresh * p[0] + t.cached * p[1] + t.out * p[2]) / 1e6 + search, priced: true };
}

const providerOf = url => /anthropic\.com/.test(url) ? "anthropic" : /openai\.com/.test(url) ? "openai" : "other";

function requestModel(init) {
  const b = init?.body;
  if (!b) return "";
  if (typeof b === "string") { try { return JSON.parse(b).model || ""; } catch { return ""; } }
  if (typeof b.get === "function") return b.get("model") || "";   // FormData (image edits)
  return "";
}

export async function logAi(row) {
  const t = tokensOf(row.usage);
  const { usd, priced } = costOf(row.model, t, row.searches || 0);
  const at = Date.now();
  const data = {
    id: `${at.toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    at, feature: String(row.feature || "unknown").slice(0, 60), model: String(row.model || "").slice(0, 60),
    provider: row.provider || "", in: t.in, cached: t.cached, out: t.out, usd: Math.round(usd * 1e6) / 1e6,
    ...(priced ? {} : { unpriced: true }), ms: row.ms || 0, status: row.status || 0,
    ...(row.searches ? { searches: row.searches } : {}), ...(row.err ? { err: String(row.err).slice(0, 160) } : {}),
  };
  try {
    // A plain insert: no read-modify-write, so concurrent calls never lose a row.
    const r = await Promise.race([
      adminClient().from("app_rows").insert({ key: AI_KEY, id: data.id, pos: -at, data }),
      new Promise(r => setTimeout(() => r({ error: { message: "timed out" } }), 1500)),
    ]);
    if (r?.error) console.warn("ai-meter:", r.error.message);
  } catch (e) { console.warn("ai-meter:", e?.message || e); /* the meter never breaks the call */ }
  return data;
}

/* fetch() with the meter on. `feature` names what spent it ("listing-ai",
   "erp:finance", …). Reads the usage from a clone, so the caller's body is
   untouched. */
export async function aiFetch(url, init = {}, feature = "unknown") {
  const started = Date.now();
  const model = requestModel(init);
  const provider = providerOf(String(url));
  let r;
  try { r = await fetch(url, init); }
  catch (e) {
    await logAi({ feature, model, provider, ms: Date.now() - started, status: 0, err: e?.message || e });
    throw e;
  }
  try {
    const d = await r.clone().json().catch(() => null);
    const searches = (d?.output || []).filter(o => o?.type === "web_search_call").length;
    await logAi({
      feature, provider, model: d?.model || model, usage: d?.usage, ms: Date.now() - started, status: r.status, searches,
      err: r.ok ? "" : (d?.error?.message || `HTTP ${r.status}`),
    });
  } catch { /* ignore */ }
  return r;
}
