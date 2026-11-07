#!/usr/bin/env node
/* What Soniya needs before her weekly work, as one JSON on stdout.
   node scripts/soniya/soniya-read.mjs            everything
   node scripts/soniya/soniya-read.mjs --catalogue only the Atyahara catalogue
   Never prints customers' contact details. */
import { supa, rows, istDay, addDays, SKEYS } from "./soniya-common.mjs";

const sb = supa();
const today = istDay();
const only = process.argv[2];

const listings = await rows(sb, "ng-listings-v1");
const onAty = l => JSON.stringify(l.platforms || "").includes("shopify_aty");
const price = l => +l.price_shopify_aty || +l.price_store_inr || 0;
const aty = listings.filter(onAty);
const groups = {};
for (const l of aty) {
  const g = groups[l.shape || "Other"] ||= { count: 0, in_stock: 0, materials: {}, prices: [] };
  g.count++; if ((+l.qty || 0) > 0) g.in_stock++;
  g.materials[l.material || "?"] = (g.materials[l.material || "?"] || 0) + 1;
  if (price(l)) g.prices.push(price(l));
}
const catalogue = {
  total: aty.length,
  by_shape: Object.fromEntries(Object.entries(groups).sort((a, b) => b[1].count - a[1].count).map(([k, g]) => {
    const p = g.prices.sort((a, b) => a - b);
    return [k, { count: g.count, in_stock: g.in_stock, top_materials: Object.entries(g.materials).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([m, n]) => `${m} (${n})`),
      price_inr: p.length ? { min: p[0], median: p[Math.floor(p.length / 2)], max: p[p.length - 1] } : null }];
  })),
  newest: aty.filter(l => l.created_at).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 25)
    .map(l => ({ id: l.id, title: l.title, shape: l.shape, material: l.material, price_inr: price(l) || null, qty: +l.qty || 0, added: String(l.created_at).slice(0, 10), image: (l.images || [])[0] || null })),
  carvings_and_deities: aty.filter(l => /ganesh|buddha|shiva|lingam|nandi|lakshmi|krishna|hanuman|elephant|carv|idol|murti|deity/i.test(`${l.title} ${l.shape}`)).slice(0, 40)
    .map(l => ({ id: l.id, title: l.title, price_inr: price(l) || null, qty: +l.qty || 0, image: (l.images || [])[0] || null })),
  premium: aty.filter(l => price(l) >= 10000).sort((a, b) => price(b) - price(a)).slice(0, 15).map(l => ({ id: l.id, title: l.title, price_inr: price(l), qty: +l.qty || 0 })),
};
// atyahara.com's own catalogue, read-only from Shopify (same credentials Raj uses).
async function shopifyProducts() {
  const { data } = await sb.from("app_data").select("value").eq("key", "ng-shopify-creds-v1").maybeSingle();
  const store = data?.value?.store || "7b7b96-29.myshopify.com", token = data?.value?.token;
  if (!token) return { error: "no Atyahara Shopify token" };
  const out = [];
  let url = `https://${store}/admin/api/2025-01/products.json?status=active&limit=250&fields=id,title,handle,product_type,tags,variants,images,created_at`;
  for (let i = 0; url && i < 8; i++) {
    const r = await fetch(url, { headers: { "X-Shopify-Access-Token": token } });
    if (!r.ok) return { error: `Shopify ${r.status}` };
    out.push(...((await r.json()).products || []));
    const next = /<([^>]+)>;\s*rel="next"/.exec(r.headers.get("link") || "");
    url = next ? next[1] : null;
  }
  const types = {};
  for (const p of out) { const t = p.product_type || "Untyped"; (types[t] ||= []).push(p); }
  const pr = p => Math.min(...(p.variants || []).map(v => +v.price || Infinity));
  const stock = p => (p.variants || []).reduce((t, v) => t + Math.max(0, +v.inventory_quantity || 0), 0);
  return {
    active: out.length,
    by_type: Object.fromEntries(Object.entries(types).sort((a, b) => b[1].length - a[1].length).map(([t, ps]) => {
      const p = ps.map(pr).filter(Number.isFinite).sort((a, b) => a - b);
      return [t, { count: ps.length, price_inr: p.length ? { min: p[0], median: p[Math.floor(p.length / 2)], max: p[p.length - 1] } : null, examples: ps.slice(0, 6).map(x => x.title) }];
    })),
    carvings_and_deities: out.filter(p => /ganesh|buddha|shiva|lingam|nandi|lakshmi|krishna|hanuman|elephant|carv|idol|murti|deity|tortoise|turtle/i.test(`${p.title} ${p.product_type} ${p.tags}`)).slice(0, 60)
      .map(p => ({ title: p.title, url: `https://atyahara.com/products/${p.handle}`, price_inr: pr(p), stock: stock(p), variants: (p.variants || []).length, image: p.images?.[0]?.src || null })),
    newest: out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 20).map(p => ({ title: p.title, type: p.product_type, price_inr: pr(p), stock: stock(p), added: String(p.created_at).slice(0, 10) })),
  };
}
catalogue.atyahara_com = await shopifyProducts().catch(e => ({ error: e.message }));
if (only === "--catalogue") { console.log(JSON.stringify({ today, catalogue }, null, 1)); process.exit(0); }

// Sales and orders from Raj's daily snapshots (last 14 days).
const snaps = [];
for (let i = 0; i < 14; i++) {
  const { data } = await sb.from("app_rows").select("data").eq("key", "raj-snapshots-v1").eq("id", addDays(today, -i)).eq("deleted", false).maybeSingle();
  if (data?.data) snaps.push(data.data);
}
const seen = new Set();
const orders = snaps.flatMap(s => (s.orders_since_last?.orders || []).map(o => ({ day: o.at_ist?.slice(0, 10), number: o.number, channel: o.channel, amount: o.amount, cur: o.cur, items: o.items, source: o.source?.kind, source_detail: o.source?.detail, country: o.country, device: o.device, buyer: o.buyer_history }))).filter(o => !seen.has(o.number) && seen.add(o.number));
const latest = snaps[0] || {};
const sales = {
  month_to_date: latest.sales?.mtd || null,
  orders_last_14_days: orders,
  site_yesterday: latest.site?.day || null,
  etsy_ads_inr: latest.ads?.etsy || null,
};

const [work, notes, rajNotes, brandRow] = await Promise.all([
  rows(sb, SKEYS.work), rows(sb, SKEYS.notes), rows(sb, "raj-notes-v1"),
  sb.from("app_data").select("value").eq("key", SKEYS.brand).maybeSingle(),
]);
const open = work.filter(w => ["proposed", "changes"].includes(w.status));
const approved = work.filter(w => w.status === "approved");
const recentDone = work.filter(w => ["published", "declined"].includes(w.status)).slice(0, 15);
console.log(JSON.stringify({
  today,
  brand_book: brandRow.data?.value || null,
  my_notes: notes.slice(0, 80).map(n => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, status: n.status, due: n.due })),
  my_work: {
    waiting_for_sir: open.map(w => ({ id: w.id, type: w.type, title: w.title, date: w.date, status: w.status, sir_feedback: w.feedback || null })),
    approved: approved.map(w => ({ id: w.id, type: w.type, title: w.title, date: w.date })),
    recently_closed: recentDone.map(w => ({ id: w.id, type: w.type, title: w.title, status: w.status, sir_feedback: w.feedback || null, result: w.result || null })),
    calendar_next_28_days: work.filter(w => w.date && w.date >= today && w.date <= addDays(today, 28) && w.status !== "declined").sort((a, b) => a.date.localeCompare(b.date)).map(w => ({ date: w.date, id: w.id, type: w.type, title: w.title, status: w.status })),
  },
  raj_marketing_notes: rajNotes.filter(n => ["shopify_aty", "etsy", "store"].includes(n.channel) || /ad|meta|instagram|brand|campaign/i.test(n.title)).slice(0, 30).map(n => ({ kind: n.kind, title: n.title, body: n.body })),
  sales, catalogue,
}, null, 1));
