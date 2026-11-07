#!/usr/bin/env node
/* What Alex needs before his weekly growth review, as one JSON on stdout.
   node scripts/alex/alex-read.mjs
   Atyahara = platforms "etsy" (the Atyahara Etsy shop) and "shopify_aty" (atyahara.com).
   Revenue is item revenue (sale_price), INR rows only; older USD rows are counted separately.
   Never prints customers' names, emails, phones or addresses. */
import { supa, rows, istDay, addDays, AKEYS, BLUEPRINT_URL } from "./alex-common.mjs";

const sb = supa();
const today = istDay();
const { data: od } = await sb.from("app_data").select("value").eq("key", "ng-orders-v1").single();
const ATY = ["etsy", "shopify_aty"];
const live = (od?.value || []).filter(o => ATY.includes(o.platform) && !/cancel/i.test(o.status || "") && o.date);
const inr = live.filter(o => o.currency === "INR");
const sum = a => Math.round(a.reduce((s, o) => s + (+o.sale_price || 0), 0));
const orderCount = a => new Set(a.map(o => o.platform_order_id || o.order_number || o.id)).size;
const between = (a, from, to) => a.filter(o => o.date >= from && o.date <= to);
const byChannel = a => Object.fromEntries(ATY.map(p => { const x = a.filter(o => o.platform === p); return [p, { revenue_inr: sum(x), orders: orderCount(x), pieces: x.length }]; }));

const monthStart = today.slice(0, 8) + "01";
const yearAgo = addDays(today, -365);
const months = {};
for (const o of between(inr, yearAgo, today)) { const m = o.date.slice(0, 7); (months[m] ||= { etsy: 0, shopify_aty: 0 })[o.platform] += +o.sale_price || 0; }
for (const m of Object.values(months)) for (const k in m) m[k] = Math.round(m[k]);
const last12 = between(inr, yearAgo, today);
const top = (a, n = 12) => { const t = {}; for (const o of a) { const k = (o.listing_title || "?").slice(0, 70); (t[k] ||= { pieces: 0, revenue_inr: 0, channel: o.platform }); t[k].pieces++; t[k].revenue_inr += +o.sale_price || 0; } return Object.entries(t).sort((a, b) => b[1].revenue_inr - a[1].revenue_inr).slice(0, n).map(([title, v]) => ({ title, ...v, revenue_inr: Math.round(v.revenue_inr) })); };
const countries = a => { const t = {}; for (const o of a) t[o.buyer_country || "?"] = (t[o.buyer_country || "?"] || 0) + (+o.sale_price || 0); return Object.entries(t).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([c, v]) => ({ country: c, revenue_inr: Math.round(v) })); };
const fees12 = Math.round(last12.filter(o => o.platform === "etsy").reduce((s, o) => s + (+o.etsy_fees || +o.order_fees || 0), 0));

const sales = {
  note: "Item revenue in INR from ng-orders-v1. Product costs are not in the ERP, so gross/contribution/net profit cannot be computed.",
  last_7_days: { from: addDays(today, -6), ...byChannel(between(inr, addDays(today, -6), today)) },
  prior_7_days: { from: addDays(today, -13), ...byChannel(between(inr, addDays(today, -13), addDays(today, -7))) },
  month_to_date: byChannel(between(inr, monthStart, today)),
  last_12_months: { ...byChannel(last12), etsy_share_pct: Math.round(100 * sum(last12.filter(o => o.platform === "etsy")) / Math.max(1, sum(last12))), etsy_fees_recorded_inr: fees12 },
  by_month: months,
  top_products_90_days: top(between(inr, addDays(today, -90), today)),
  top_products_12_months: top(last12, 15),
  countries_12_months: countries(last12),
  orders_last_14_days: between(inr, addDays(today, -13), today).map(o => ({ date: o.date, channel: o.platform, title: (o.listing_title || "").slice(0, 70), price_inr: +o.sale_price || 0, country: o.buyer_country || null })),
};

// Raj's latest snapshot (ads, site, Etsy state) and his open items.
const { data: snapRow } = await sb.from("app_rows").select("data").eq("key", "raj-snapshots-v1").eq("deleted", false).order("id", { ascending: false }).limit(1).maybeSingle();
const snap = snapRow?.data || {};
const [rajNotes, soniyaWork, opps, partners, notes, reviews] = await Promise.all([
  rows(sb, "raj-notes-v1"), rows(sb, "soniya-work-v1"),
  rows(sb, AKEYS.opps), rows(sb, AKEYS.partners), rows(sb, AKEYS.notes), rows(sb, AKEYS.reviews),
]);
console.log(JSON.stringify({
  today, blueprint: BLUEPRINT_URL,
  sales,
  raj: {
    snapshot_date: snap.id || snap.date || null, site: snap.site || null, ads: snap.ads || null, etsy: snap.etsy || null,
    open_followups: rajNotes.filter(n => n.kind === "followup" && n.status !== "done").slice(0, 25).map(n => ({ title: n.title, due: n.due, channel: n.channel })),
    recent_decisions: rajNotes.filter(n => n.kind === "decision").slice(0, 15).map(n => ({ title: n.title, body: n.body })),
  },
  soniya: {
    waiting_for_sir: soniyaWork.filter(w => ["proposed", "changes"].includes(w.status)).map(w => ({ type: w.type, title: w.title, date: w.date })),
    approved: soniyaWork.filter(w => w.status === "approved").map(w => ({ type: w.type, title: w.title, date: w.date })),
  },
  mine: {
    opportunities: opps.map(o => ({ id: o.id, title: o.title, status: o.status, priority: o.priority, kind: o.kind, budget_inr: o.budget_inr, next_action: o.next_action, sir_feedback: o.feedback || null, result: o.result || null })),
    partners: partners.map(p => ({ id: p.id, name: p.name, tier: p.tier, rank: p.rank, stage: p.stage, sir_note: p.sir_note || null, next_action: p.next_action, due: p.due })),
    notes: notes.slice(0, 80).map(n => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, to: n.to, status: n.status, due: n.due })),
    last_reviews: reviews.sort((a, b) => String(b.id).localeCompare(String(a.id))).slice(0, 3).map(r => ({ date: r.id, headline: r.headline, decisions_for_sir: r.decisions_for_sir || [] })),
  },
}, null, 1));
