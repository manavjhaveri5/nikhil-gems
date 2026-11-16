#!/usr/bin/env node
/* atyahara.com orders attributed to Meta ads, read-only, no customer details.
   node scripts/ads/ad-orders.mjs [--since YYYY-MM-DD]
   The Shiprocket (fastrr) checkout stores UTMs in note_attributes, NOT landing_site.
   Meta tags: utm_campaign = campaign id, utm_term = ad set id, utm_content = ad id. */
import { supa } from "../alex/alex-common.mjs";
const since = (process.argv.indexOf("--since") > -1 ? process.argv[process.argv.indexOf("--since") + 1] : "2025-01-01");
const sb = supa();
const { data } = await sb.from("app_data").select("value").eq("key", "ng-shopify-creds-v1").maybeSingle();
const { data: nm } = await sb.from("app_data").select("value").eq("key", "ng-meta-names-v1").maybeSingle();
const names = nm?.value || {};
const store = data?.value?.store || "7b7b96-29.myshopify.com";
let url = `https://${store}/admin/api/2025-01/orders.json?status=any&limit=250&created_at_min=${since}T00:00:00%2B05:30&fields=created_at,total_price,cancelled_at,line_items,landing_site,referring_site,note_attributes,discount_codes,shipping_address`;
const all = [];
while (url) { const r = await fetch(url, { headers: { "X-Shopify-Access-Token": data.value.token } }); if (!r.ok) throw new Error(`Shopify ${r.status}`); all.push(...(await r.json()).orders); const n = /<([^>]+)>;\s*rel="next"/.exec(r.headers.get("link") || ""); url = n ? n[1] : null; }
const orders = all.filter(o => !o.cancelled_at && +o.total_price > 20 && !(o.discount_codes || []).some(d => /test/i.test(d.code))).map(o => {
  const na = Object.fromEntries((o.note_attributes || []).map(a => [a.name, a.value]));
  const q = new URLSearchParams((o.landing_site || "").split("?")[1] || "");
  const u = k => na[k] || q.get(k) || "";
  const l = `${o.landing_site || ""} ${na.landing_page_url || ""} ${o.referring_site || ""} ${u("utm_medium")} ${u("utm_source")}`;
  const meta = /paid_soci|utm_medium=paid|fbclid|\b(fb|ig|facebook)\b paid|paid (fb|ig|facebook)/i.test(l) || (/paid/.test(u("utm_medium")) && /fb|ig|facebook/i.test(u("utm_source")));
  return { date: o.created_at.slice(0, 10), amount: Math.round(+o.total_price), state: (o.shipping_address || {}).province || "?", city: (o.shipping_address || {}).city || "?",
    meta, placement: meta ? u("utm_source") : null, campaign: names[u("utm_campaign")] || u("utm_campaign") || null, adset: names[u("utm_term")] || u("utm_term") || null, ad: names[u("utm_content")] || u("utm_content") || null,
    items: o.line_items.map(x => `${x.title}${x.quantity > 1 ? " x" + x.quantity : ""}`) };
}).sort((a, b) => a.date.localeCompare(b.date));
const m = orders.filter(o => o.meta);
console.log(JSON.stringify({ since, orders: orders.length, revenue_inr: orders.reduce((s, o) => s + o.amount, 0), meta_orders: m.length, meta_revenue_inr: m.reduce((s, o) => s + o.amount, 0), list: orders }, null, 1));
