#!/usr/bin/env node
/* What Raj needs for the morning, as one compact JSON on stdout.

   node scripts/raj/raj-read.mjs            today's snapshot (made at 07:45 IST by Postgres)
   node scripts/raj/raj-read.mjs --refresh  ask the live ERP for a fresh snapshot first
   node scripts/raj/raj-read.mjs --notes    only Raj's notes (for the memory job)

   The per-listing Etsy view map is left out (it's only for day-to-day sums). */
import { supa, rows, row, cronKey, KEYS, LIVE, istDay, addDays } from "./raj-common.mjs";

const args = new Set(process.argv.slice(2));
const sb = supa();
const today = istDay();

async function refresh() {
  const key = await cronKey(sb);
  const r = await fetch(`${LIVE}/api/listing-manager`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-cron-key": key },
    body: JSON.stringify({ action: "raj_snapshot" }),
  });
  const d = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok) throw new Error(`snapshot: ${d.error || r.status}`);
  return d;
}

const notes = await rows(sb, KEYS.notes);
const shortNote = n => ({ id: n.id, kind: n.kind, title: n.title, status: n.status, due: n.due || undefined, channel: n.channel || undefined,
  updated: (n.updated_at || n.created_at || "").slice(0, 10) });

if (args.has("--notes")) {
  console.log(JSON.stringify({
    today,
    open_followups: notes.filter(n => n.kind === "followup" && n.status !== "done").map(shortNote),
    recent: notes.filter(n => (n.updated_at || n.created_at || "") >= addDays(today, -21)).map(shortNote),
    knowledge_titles: notes.filter(n => n.kind === "knowledge").map(n => ({ id: n.id, title: n.title })),
    counts: notes.reduce((c, n) => (c[n.kind] = (c[n.kind] || 0) + 1, c), {}),
  }, null, 1));
  process.exit(0);
}

let refreshed = null;
let snap = await row(sb, KEYS.snapshots, today);
if (!snap || args.has("--refresh")) { refreshed = await refresh(); snap = await row(sb, KEYS.snapshots, today); }
if (!snap) throw new Error("no snapshot for today");
const { etsy_views, ...lean } = snap;

const history = [];
for (let i = 1; i <= 7; i++) {
  const s = await row(sb, KEYS.snapshots, addDays(today, -i));
  if (s) history.push({ day: s.day, orders: s.sales?.total?.orders, revenue_inr_est: s.sales?.total?.revenue_inr_est,
    etsy_views: (s.etsy?.etsy?.views_yesterday ?? 0) + (s.etsy?.etsy_ee?.views_yesterday ?? 0), site_visitors: s.site?.day?.visitors });
}
const briefingToday = await row(sb, KEYS.briefings, today);

console.log(JSON.stringify({
  today, refreshed: !!refreshed,
  snapshot: lean,
  last_7_days: history,
  open_followups: notes.filter(n => n.kind === "followup" && n.status !== "done").map(shortNote),
  notes_last_3_days: notes.filter(n => (n.updated_at || n.created_at || "") >= addDays(today, -3) && n.kind !== "followup").map(shortNote),
  briefing_already: briefingToday ? briefingToday.generated_by : null,
}, null, 1));
