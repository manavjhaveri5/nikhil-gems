#!/usr/bin/env node
/* What Alex needs before his weekly growth review, as one JSON on stdout.
   node scripts/alex/alex-read.mjs
   Scope: Atyahara INDIA = atyahara.com (Shopify). The Atyahara Etsy shop is a separate export
   business and is NOT in Alex's scope. Orders are read straight from Shopify (read-only), because
   the ERP's ng-orders-v1 sync is incomplete. Never prints customers' names, emails, phones or
   street addresses: only state, city, dates, products, amounts and traffic source. */
import { supa, rows, istDay, addDays, AKEYS, BLUEPRINT_URL } from "./alex-common.mjs";

const sb = supa();
const today = istDay();

// ── atyahara.com orders from Shopify ─────────────────────────────────────────
const REGION = { Maharashtra: "West", Gujarat: "West", Goa: "West", Rajasthan: "North", Karnataka: "South", Telangana: "South", "Andhra Pradesh": "South", "Tamil Nadu": "South", Kerala: "South", Puducherry: "South", Delhi: "North", Haryana: "North", Punjab: "North", "Uttar Pradesh": "North", Uttarakhand: "North", "Himachal Pradesh": "North", Chandigarh: "North", "Jammu and Kashmir": "North", "Madhya Pradesh": "Central", Chhattisgarh: "Central", "West Bengal": "East", Assam: "East", Odisha: "East", Bihar: "East", Jharkhand: "East" };
const METRO = c => { c = (c || "").toLowerCase(); return /mumbai|thane|navi mumbai|mymba/.test(c) ? "Mumbai MMR" : /pune/.test(c) ? "Pune" : /bangal|bengal/.test(c) ? "Bengaluru" : /hyderab|rangareddy|secunderabad/.test(c) ? "Hyderabad" : /chennai/.test(c) ? "Chennai" : /delhi|gurg|noida|ghaziabad|faridabad/.test(c) ? "Delhi NCR" : /ahmedabad/.test(c) ? "Ahmedabad" : /kolkata/.test(c) ? "Kolkata" : "Other"; };
const SOURCE = o => { const l = `${o.landing_site || ""} ${o.referring_site || ""}`; return /utm_medium=paid|utm_source=(fb|facebook|ig)|Facebook_UA|fbclid|paid_soci/i.test(l) ? "Meta ads" : /google/i.test(l) ? "Google" : /instagram/i.test(l) ? "Instagram organic" : /whatsapp|wa\.me/i.test(l) ? "WhatsApp" : o.source_name === "web" ? "Direct" : o.source_name === "shopify_draft_order" ? "Manual order" : "Checkout app (source not recorded)"; };

async function shopifyOrders() {
  const { data } = await sb.from("app_data").select("value").eq("key", "ng-shopify-creds-v1").maybeSingle();
  const store = data?.value?.store || "7b7b96-29.myshopify.com", token = data?.value?.token;
  if (!token) throw new Error("no Atyahara Shopify token");
  const out = [];
  let url = `https://${store}/admin/api/2025-01/orders.json?status=any&limit=250&fields=created_at,total_price,cancelled_at,shipping_address,billing_address,line_items,source_name,referring_site,landing_site,discount_codes`;
  for (let i = 0; url && i < 20; i++) {
    const r = await fetch(url, { headers: { "X-Shopify-Access-Token": token } });
    if (!r.ok) throw new Error(`Shopify ${r.status}`);
    out.push(...((await r.json()).orders || []));
    const next = /<([^>]+)>;\s*rel="next"/.exec(r.headers.get("link") || "");
    url = next ? next[1] : null;
  }
  return out;
}
let india = { error: null };
try {
  const all = await shopifyOrders();
  const os = all.filter(o => !o.cancelled_at && +o.total_price > 20 && (o.shipping_address || o.billing_address || {}).country_code === "IN" && !(o.discount_codes || []).some(d => /test/i.test(d.code)))
    .map(o => { const a = o.shipping_address || o.billing_address || {}; return { date: o.created_at.slice(0, 10), amount: +o.total_price, state: a.province || "?", region: REGION[a.province] || "Other", metro: METRO(a.city), source: SOURCE(o), pieces: o.line_items.reduce((s, l) => s + l.quantity, 0), items: o.line_items.map(l => `${l.title}${l.quantity > 1 ? ` x${l.quantity}` : ""}`), discount: (o.discount_codes || []).map(d => d.code).join(",") || null }; });
  const agg = (list, key) => { const t = {}; for (const o of list) { const k = o[key]; (t[k] ||= { orders: 0, revenue_inr: 0, pieces: 0 }); t[k].orders++; t[k].revenue_inr += o.amount; t[k].pieces += o.pieces; } const tot = list.reduce((s, o) => s + o.amount, 0) || 1; return Object.entries(t).sort((a, b) => b[1].revenue_inr - a[1].revenue_inr).map(([k, v]) => ({ [key]: k, ...v, revenue_inr: Math.round(v.revenue_inr), share_pct: Math.round(100 * v.revenue_inr / tot), pieces_per_order: +(v.pieces / v.orders).toFixed(1) })); };
  const products = {}; for (const o of os) for (const it of o.items) { const k = it.replace(/ x\d+$/, "").replace(/\s*-\s*\d.*$/, "").trim(); products[k] = (products[k] || 0) + (+(/ x(\d+)$/.exec(it)?.[1] || 1)); }
  const win = (from, to) => os.filter(o => o.date >= from && o.date <= to);
  india = {
    scope: "atyahara.com India orders (Shopify), cancelled and test orders removed",
    all_time: { orders: os.length, revenue_inr: Math.round(os.reduce((s, o) => s + o.amount, 0)), avg_order_inr: Math.round(os.reduce((s, o) => s + o.amount, 0) / Math.max(1, os.length)), multi_piece_orders: os.filter(o => o.pieces > 1).length },
    last_7_days: agg(win(addDays(today, -6), today), "region"),
    last_30_days: { orders: win(addDays(today, -29), today).length, revenue_inr: Math.round(win(addDays(today, -29), today).reduce((s, o) => s + o.amount, 0)) },
    by_region: agg(os, "region"), by_state: agg(os, "state"), by_metro: agg(os, "metro"), by_source: agg(os, "source"),
    by_month: agg(os.map(o => ({ ...o, month: o.date.slice(0, 7) })), "month").sort((a, b) => a.month.localeCompare(b.month)),
    top_products: Object.entries(products).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([title, pieces]) => ({ title, pieces })),
    orders_last_60_days: win(addDays(today, -59), today),
    erp_sync_check: null,
  };
  const { data: od } = await sb.from("app_data").select("value").eq("key", "ng-orders-v1").single();
  const erpCount = new Set((od?.value || []).filter(o => o.platform === "shopify_aty").map(o => o.order_number)).size;
  india.erp_sync_check = { shopify_orders_total: all.length, erp_shopify_aty_orders: erpCount, note: erpCount < all.length ? "ERP is missing atyahara.com orders: hand off to Raj" : "in sync" };
} catch (e) { india = { error: e.message }; }

// ── selling-moments calendar (app_data alex-moments-v1, maintained by Alex) ──
const { data: mrow } = await sb.from("app_data").select("value").eq("key", "alex-moments-v1").maybeSingle();
const moments = (mrow?.value?.moments || []).map(m => ({ ...m, days_away: m.date ? Math.round((Date.parse(m.date) - Date.parse(today)) / 864e5) : null }));
const upcoming = moments.filter(m => m.days_away == null || (m.days_away >= -7 && m.days_away <= 75)).sort((a, b) => (a.days_away ?? 999) - (b.days_away ?? 999));

// ── Raj, Soniya, and Alex's own pipeline ─────────────────────────────────────
const { data: snapRow } = await sb.from("app_rows").select("data").eq("key", "raj-snapshots-v1").eq("deleted", false).order("id", { ascending: false }).limit(1).maybeSingle();
const snap = snapRow?.data || {};
const [rajNotes, soniyaWork, opps, partners, notes, reviews] = await Promise.all([
  rows(sb, "raj-notes-v1"), rows(sb, "soniya-work-v1"),
  rows(sb, AKEYS.opps), rows(sb, AKEYS.partners), rows(sb, AKEYS.notes), rows(sb, AKEYS.reviews),
]);
console.log(JSON.stringify({
  today, blueprint: BLUEPRINT_URL,
  scope_note: "Atyahara India only (atyahara.com, B2B gifting, retail). The Etsy shop is a separate export business: ignore it.",
  india,
  selling_moments: { upcoming_75_days: upcoming, all: moments },
  meta_ads: { from_raj_snapshot: snap.ads || null, note: "Region/age/gender breakdowns need a CSV export from Ads Manager that Sir approves; ask for it when a decision depends on it." },
  raj: {
    snapshot_date: snap.id || snap.date || null, site: snap.site || null,
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
