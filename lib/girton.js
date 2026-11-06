/* Girton, the cost watchdog. Runs hourly from Postgres (listing-manager
   action girton_tick, cron key 'raj').

   Reads the AI meter's raw rows (lib/ai-meter.js, app_rows "girton-ai-v1")
   and writes small rows the ERP page reads (app_rows "girton-v1"):
     day|YYYY-MM-DD  one per IST day: totals, and per feature and model
     status          month to date, forecast, budget, platform usage, open alerts
     alerts          every alert raised, newest first (last 200)
   New alerts also go to Telegram. Raw rows older than 45 days are pruned.

   Budget and plan limits live in app_data "girton-budget-v1", edited on the
   page: { monthly_usd, supabase_plan }. */
import { AI_KEY } from "./ai-meter.js";
import { readRows, upsertRow } from "./app-rows.js";
import { DEFAULT_PLANS } from "./girton-plans.js";
import * as providers from "./girton-providers.js";

export const GIRTON_KEY = "girton-v1";
export const BUDGET_KEY = "girton-budget-v1";
const IST = 5.5 * 3600e3;
const istDay = ms => new Date(ms + IST).toISOString().slice(0, 10);
const dayStart = d => Date.parse(`${d}T00:00:00Z`) - IST;
const r4 = x => Math.round((+x || 0) * 1e4) / 1e4;

// Plan limits Girton checks against (bytes). Supabase: database and file storage.
export const PLAN_LIMITS = {
  free: { db: 0.5e9, storage: 1e9, label: "Supabase Free" },
  pro: { db: 8e9, storage: 100e9, label: "Supabase Pro (included)" },
};

async function rawSince(sb, ms) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("app_rows").select("data").eq("key", AI_KEY).eq("deleted", false)
      .gte("updated_at", new Date(ms).toISOString()).range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data || []).map(r => r.data));
    if (!data || data.length < 1000) break;
  }
  return out;
}

const blank = () => ({ calls: 0, in: 0, out: 0, usd: 0, errs: 0, ms: 0 });
function add(t, x) {
  t.calls++; t.in += x.in || 0; t.out += x.out || 0; t.usd += x.usd || 0; t.ms += x.ms || 0;
  if (x.err || (x.status && x.status >= 400)) t.errs++;
}
// The feature's family: "chat:finance/FinanceApp" → feature "chat", screen "finance/FinanceApp".
const familyOf = f => String(f || "unknown").split(":")[0];

export function rollupDay(day, rows) {
  const total = blank(), feature = {}, model = {}, screen = {}, hours = Array(24).fill(0);
  let top = [];
  for (const x of rows) {
    add(total, x);
    add(feature[familyOf(x.feature)] ||= blank(), x);
    add(model[x.model || "?"] ||= blank(), x);
    add(screen[x.feature || "unknown"] ||= blank(), x);
    hours[new Date(x.at + IST).getUTCHours()] += x.usd || 0;
    top.push(x);
  }
  top = top.sort((a, b) => (b.usd || 0) - (a.usd || 0)).slice(0, 8)
    .map(x => ({ at: x.at, feature: x.feature, model: x.model, in: x.in, out: x.out, usd: r4(x.usd) }));
  const round = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { ...v, usd: r4(v.usd) }]));
  return { id: `day|${day}`, day, total: { ...total, usd: r4(total.usd) }, feature: round(feature), model: round(model),
    screen: round(screen), hours: hours.map(r4), top, unpriced: rows.filter(x => x.unpriced).length, updated: Date.now() };
}

async function platformUsage(sb) {
  const { data, error } = await sb.rpc("girton_usage");
  if (error) return { error: /girton_usage|function|42883|PGRST202/i.test(error.message) ? "girton_usage() not installed" : error.message };
  return data;
}

async function telegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = String(process.env.TELEGRAM_ALLOWED_CHAT_IDS || "").split(/[,\s]+/).filter(Boolean)[0];
  if (!token || !chat) return false;
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
  }).catch(() => null);
  return !!r?.ok;
}

export async function girtonTick({ sb, now = Date.now(), notify = true }) {
  const today = istDay(now);
  const yday = istDay(now - 864e5);
  const { data: bRow } = await sb.from("app_data").select("value").eq("key", BUDGET_KEY).maybeSingle();
  let budget = bRow?.value;
  if (typeof budget === "string") { try { budget = JSON.parse(budget); } catch { budget = null; } }
  budget = { monthly_usd: 10, supabase_plan: "pro", plans: DEFAULT_PLANS, ...(budget || {}) };

  // 1. Yesterday and today from the raw meter.
  const raw = await rawSince(sb, dayStart(yday));
  const byDay = { [yday]: [], [today]: [] };
  for (const x of raw) { const d = istDay(x.at); if (byDay[d]) byDay[d].push(x); }
  const dayRows = [rollupDay(yday, byDay[yday]), rollupDay(today, byDay[today])];
  for (const d of dayRows) await upsertRow(sb, GIRTON_KEY, d, true);

  // 2. The month so far, from the day rows.
  const stored = await readRows(sb, GIRTON_KEY);
  const days = stored.filter(r => r?.id?.startsWith("day|")).sort((a, b) => a.day < b.day ? -1 : 1);
  const month = today.slice(0, 7);
  const mtdDays = days.filter(d => d.day.startsWith(month));
  const mtd = mtdDays.reduce((s, d) => s + (d.total?.usd || 0), 0);
  const last7 = days.filter(d => d.day < today).slice(-7);
  const avg7 = last7.length ? last7.reduce((s, d) => s + d.total.usd, 0) / last7.length : (dayRows[1].total.usd || 0);
  const [y, m] = month.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const dayOfMonth = +today.slice(8, 10);
  // The month before today, today at no less than the 7-day pace, then that pace for the days left.
  const todayUsd = dayRows[1].total.usd || 0;
  const forecast = mtd - todayUsd + Math.max(todayUsd, avg7) + avg7 * (daysInMonth - dayOfMonth);

  // 3. Platform usage.
  const platform = await platformUsage(sb);
  const limits = PLAN_LIMITS[budget.supabase_plan] || PLAN_LIMITS.pro;
  // Plan usage, live when the access token is set; otherwise the dated snapshot stays.
  // Each provider's own API, when Sir has set its key in Vercel (lib/girton-providers.js).
  const [sbLive, rw, oai] = await Promise.all([
    providers.supabase(now, budget.supabase_cycle_day || 12).catch(e => ({ error: e.message })),
    providers.railway().catch(e => ({ error: e.message })),
    providers.openai(now).catch(e => ({ error: e.message })),
  ]);
  if (sbLive && !sbLive.error && !sbLive.missing) {
    const snapRow = stored.find(r => r?.id === "usage-snapshot") || { id: "usage-snapshot" };
    const sup = snapRow.supabase || {};
    await upsertRow(sb, GIRTON_KEY, { ...snapRow, supabase: { ...sup, plan: sbLive.plan ? sbLive.plan[0].toUpperCase() + sbLive.plan.slice(1) : sup.plan || "Pro", cycle: sbLive.cycle, items: sbLive.items, live: true, as_of_ms: now }, supabase_as_of: today }, false);
  }

  // 4. Alerts, one per kind and subject per day.
  const alerts = [];
  const raise = (kind, subject, level, text) => alerts.push({ id: `${today}|${kind}|${subject}`, day: today, at: now, kind, subject, level, text });
  const B = budget.monthly_usd;
  const spent = oai?.mtd_usd != null ? Math.max(oai.mtd_usd, mtd) : mtd;
  if (B > 0) {
    if (spent >= B) raise("budget", "over", "critical", `AI spend this month is $${spent.toFixed(2)}, over the $${B} budget.`);
    else if (forecast > B) raise("budget", "forecast", "warn", `At this pace AI spend will reach about $${forecast.toFixed(2)} this month, over the $${B} budget ($${mtd.toFixed(2)} so far).`);
    else if (spent >= 0.8 * B) raise("budget", "80", "warn", `AI spend is $${spent.toFixed(2)}, ${Math.round(spent / B * 100)}% of the $${B} budget.`);
  }
  // A feature spending far above its normal.
  const todayRow = dayRows[1];
  for (const [f, t] of Object.entries(todayRow.feature)) {
    const prior = last7.map(d => d.feature?.[f]?.usd || 0);
    const norm = prior.length ? prior.reduce((s, v) => s + v, 0) / prior.length : 0;
    if (t.usd >= 0.05 && t.usd > 3 * norm) raise("spike", f, t.usd >= 0.5 ? "critical" : "warn",
      `${f} has spent $${t.usd.toFixed(3)} today (${t.calls} calls), ${norm ? `${(t.usd / norm).toFixed(1)}× its usual $${norm.toFixed(3)}/day` : "with no history before today"}.`);
  }
  // Errors in the last hour: a bad key, quota or rate limit shows up here first.
  const hourAgo = now - 3600e3;
  const errs = {};
  for (const x of byDay[today].concat(byDay[yday])) {
    if (x.at < hourAgo || !(x.err || x.status >= 400)) continue;
    const f = familyOf(x.feature);
    (errs[f] ||= []).push(x);
  }
  for (const [f, list] of Object.entries(errs)) if (list.length >= 3) {
    const why = list[list.length - 1].err || `HTTP ${list[list.length - 1].status}`;
    raise("errors", f, "critical", `${f} failed ${list.length} times in the last hour: ${why}`);
  }
  // One call that cost a lot.
  for (const x of byDay[today]) if (x.at >= hourAgo && x.usd >= 0.2)
    raise("costly-call", `${familyOf(x.feature)}-${x.id}`, "warn", `One ${x.feature} call on ${x.model} cost $${x.usd.toFixed(2)} (${x.in} tokens in, ${x.out} out).`);
  // Unpriced models: the meter can't cost them, so the totals are low.
  if (todayRow.unpriced) raise("unpriced", "models", "info", `${todayRow.unpriced} calls today used a model Girton has no price for; their cost is not counted.`);
  for (const w of rw?.workspaces || []) {
    if (w.limit?.over) raise("railway", "limit", "critical", `Railway workspace ${w.workspace} is over its usage limit.`);
    else if (w.limit?.soft && w.estimate_usd > w.limit.soft) raise("railway", "soft", "warn", `Railway is on course for $${w.estimate_usd} this period, above the $${w.limit.soft} soft limit.`);
    else if (w.estimate_usd != null && w.estimate_usd > w.fee * 1.5 && w.fee > 0) raise("railway", "over-included", "warn", `Railway usage is on course for $${w.estimate_usd}, beyond the $${w.fee} included in ${w.plan}.`);
    for (const sv of w.services || []) if (/FAILED|CRASHED/.test(sv.status)) raise("railway", `svc-${sv.service}`, "critical", `Railway service ${sv.service} is ${sv.status.toLowerCase()}.`);
  }
  for (const it of (sbLive && !sbLive.error && !sbLive.missing ? sbLive.items : [])) {
    if (it.unlimited || !it.limit) continue;
    const pct = it.used / it.limit * 100;
    if (pct >= 80) raise("supabase", it.k, pct >= 100 ? "critical" : "warn", `Supabase ${it.k.toLowerCase()} is at ${it.used.toLocaleString("en-IN")} of ${it.limit.toLocaleString("en-IN")} ${it.unit} this cycle (${Math.round(pct)}%).`);
  }
  if (platform && !platform.error) {
    if (platform.db_bytes > 0.8 * limits.db) raise("supabase", "db", "warn", `Supabase database is ${(platform.db_bytes / 1e6).toFixed(0)} MB, ${Math.round(platform.db_bytes / limits.db * 100)}% of ${limits.label}.`);
    if (platform.storage_bytes > 0.8 * limits.storage) raise("supabase", "storage", "warn", `Supabase storage is ${(platform.storage_bytes / 1e9).toFixed(2)} GB, ${Math.round(platform.storage_bytes / limits.storage * 100)}% of ${limits.label}.`);
  }

  // 5. Keep the alert history; Telegram only for alerts not raised before.
  const history = stored.find(r => r?.id === "alerts")?.list || [];
  const seen = new Set(history.map(a => a.id));
  const fresh = alerts.filter(a => !seen.has(a.id));
  if (notify && fresh.some(a => a.level !== "info")) {
    const lines = fresh.filter(a => a.level !== "info").map(a => `${a.level === "critical" ? "🔴" : "🟠"} ${a.text}`);
    await telegram(`<b>Girton</b> (cost watch)\n${lines.join("\n")}\n\nMonth so far: $${mtd.toFixed(2)} of $${B}. ERP → Girton for details.`);
  }
  if (fresh.length) await upsertRow(sb, GIRTON_KEY, { id: "alerts", list: [...fresh, ...history].slice(0, 200) }, false);

  const status = {
    id: "status", at: now, today, month, budget, mtd: r4(mtd), forecast: r4(forecast), avg7: r4(avg7),
    days_in_month: daysInMonth, platform, limits, open_alerts: alerts,
    supabase_usage: sbLive?.missing ? { missing: true } : sbLive?.error ? { error: sbLive.error, sample: sbLive.sample } : { live: true, at: now },
    providers: { railway: rw, openai: oai, supabase: sbLive?.missing ? { missing: true } : sbLive?.error ? { error: sbLive.error } : { live: true, plan: sbLive.plan } },
  };
  await upsertRow(sb, GIRTON_KEY, status, false);

  // 6. Once a day, drop raw meter rows past 45 days (the day rows keep the totals).
  if (new Date(now + IST).getUTCHours() === 3) {
    await sb.from("app_rows").delete().eq("key", AI_KEY).lt("updated_at", new Date(now - 45 * 864e5).toISOString());
  }
  return { mtd: status.mtd, forecast: status.forecast, today: todayRow.total, alerts: alerts.length, new_alerts: fresh.length };
}
