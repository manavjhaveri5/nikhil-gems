/* Shared bits for Raj's Mac-side scripts (raj-read, raj-push, extract-transcripts).
   They run under Claude Code scheduled tasks on Manav's Mac, with the ERP's .env
   for Supabase. Nothing here prints a key. */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

export const ERP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const RAJ_HOME = join(homedir(), ".raj");
export const LIVE = "https://project-nine-tan-22.vercel.app";
export const KEYS = { notes: "raj-notes-v1", briefings: "raj-briefings-v1", snapshots: "raj-snapshots-v1" };

export function loadEnv() {
  const env = {};
  for (const f of [".env", ".env.local"]) {
    const p = join(ERP_DIR, f);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return env;
}

export function supa() {
  const env = loadEnv();
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL, key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("ERP .env has no Supabase URL / service role key");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

// Local settings (Telegram), never committed: ~/.raj/config.json
export function rajConfig() {
  const p = join(RAJ_HOME, "config.json");
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return {}; }
}
export function saveRajState(name, value) {
  mkdirSync(RAJ_HOME, { recursive: true });
  writeFileSync(join(RAJ_HOME, name), JSON.stringify(value, null, 2));
}
export function readRajState(name, fallback) {
  try { return JSON.parse(readFileSync(join(RAJ_HOME, name), "utf8")); } catch { return fallback; }
}

const IST = 5.5 * 3600e3;
export const istDay = (ms = Date.now()) => new Date(ms + IST).toISOString().slice(0, 10);
export const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

export async function rows(sb, key) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("app_rows").select("data").eq("key", key).eq("deleted", false)
      .order("pos", { ascending: true }).range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data || []).map(r => r.data));
    if (!data || data.length < 1000) break;
  }
  return out;
}
export async function row(sb, key, id) {
  const { data } = await sb.from("app_rows").select("data").eq("key", key).eq("id", id).eq("deleted", false).maybeSingle();
  return data?.data || null;
}
export async function upsert(sb, key, item, prepend = true) {
  const { error } = await sb.rpc("app_rows_upsert", { p_key: key, p_item: item, p_prepend: prepend });
  if (error) throw new Error(error.message);
}
export async function cronKey(sb) {
  const { data, error } = await sb.from("cron_keys").select("key").eq("name", "raj").maybeSingle();
  if (error) throw new Error(error.message);
  return data?.key || "";
}

/* Anything that looks like a secret, blanked before text leaves this Mac. */
export function redact(s) {
  return String(s || "")
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, "[jwt]")
    .replace(/\b(sk|pk|rk)[-_](live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{16,}/g, "[key]")
    .replace(/\b(ghp|gho|github_pat|xox[abp]|AKIA|shpat|shpss|EAA)[A-Za-z0-9_]{12,}/g, "[key]")
    .replace(/\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g, "[bot-token]")
    .replace(/((?:password|passwd|secret|token|api[_-]?key|service_role)[^\n]{0,12}?[:=]\s*)\S{6,}/gi, "$1[redacted]")
    .replace(/\b[A-Fa-f0-9]{40,}\b/g, "[hex]")
    .replace(/\b[A-Za-z0-9+/]{48,}={0,2}/g, "[blob]");
}

export async function telegram(text) {
  const c = rajConfig();
  if (!c.telegram_token || !c.telegram_chat_id) return { skipped: "no ~/.raj/config.json telegram_token / telegram_chat_id" };
  const r = await fetch(`https://api.telegram.org/bot${c.telegram_token}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: c.telegram_chat_id, text: String(text).slice(0, 4000), parse_mode: "Markdown", disable_web_page_preview: true }),
  });
  const d = await r.json().catch(() => ({}));
  if (!d.ok) {
    // Markdown that Telegram can't parse: send it plain.
    const r2 = await fetch(`https://api.telegram.org/bot${c.telegram_token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: c.telegram_chat_id, text: String(text).slice(0, 4000), disable_web_page_preview: true }),
    });
    const d2 = await r2.json().catch(() => ({}));
    return d2.ok ? { sent: true, plain: true } : { error: d2.description || d.description || `HTTP ${r2.status}` };
  }
  return { sent: true };
}
