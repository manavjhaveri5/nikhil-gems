/* Raj's numbers — the morning snapshot behind his briefing (src/RajApp.jsx).

   Runs once a day from Postgres (pg_cron → /api/listing-manager action
   raj_snapshot, see supabase/migrations/20261105090000_raj.sql), or on demand
   from the Mac (scripts/raj/raj-read.mjs). Everything here is arithmetic on
   what the channels report; Claude only reads the result and writes about it.

   Every figure says where it came from (`availability`):
   - verified    the channel's own numbers (Etsy receipts, eBay traffic report,
                 the store's own events)
   - recorded    what the ERP holds (orders synced into ng-orders-v1)
   - estimated   derived by us (Etsy daily views = lifetime views today minus
                 yesterday's snapshot; INR totals at a fixed rate)
   - unavailable the channel gives no such number, or isn't connected

   Days are India days (the business works on IST). The snapshot taken on the
   morning of D+1 reports day D. */

import { readRows, upsertRow } from "./app-rows.js";

export const RAJ = {
  notes: "raj-notes-v1",
  briefings: "raj-briefings-v1",
  snapshots: "raj-snapshots-v1",
};

export const CHANNELS = {
  etsy: "Atyahara Etsy",
  etsy_ee: "EarthEditions Etsy",
  ebay: "eBay",
  store: "eartheditions.co",
  shopify_aty: "Atyahara Shopify",
  shopify_earth: "Earth Editions Shopify",
  trade: "Trade (wholesale)",
};

const IST = 5.5 * 3600e3;
export const istDay = ms => new Date(ms + IST).toISOString().slice(0, 10);
const istStart = d => Date.parse(`${d}T00:00:00Z`) - IST;
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const r2 = x => Math.round((+x || 0) * 100) / 100;
const VOID = /cancel|refund|return|void/i;

// INR equivalents for one total line. A fixed rate, so it is an estimate.
const RATE = { INR: 1, USD: +process.env.LISTING_USD_INR || 84, EUR: 91, GBP: 108, CAD: 61, AUD: 55 };
const toInr = (amt, cur) => r2((+amt || 0) * (RATE[String(cur || "INR").toUpperCase()] || RATE.USD));

async function appData(sb, key) {
  const { data, error } = await sb.from("app_data").select("value").eq("key", key).maybeSingle();
  if (error) throw new Error(`${key}: ${error.message}`);
  const v = typeof data?.value === "string" ? JSON.parse(data.value) : data?.value;
  return v ?? null;
}

export async function rajRow(sb, key, id) {
  const { data } = await sb.from("app_rows").select("data").eq("key", key).eq("id", id).eq("deleted", false).maybeSingle();
  return data?.data || null;
}

async function cronKey(sb) {
  const { data } = await sb.from("cron_keys").select("key").eq("name", "raj").maybeSingle();
  return data?.key || "";
}

async function callApi(base, key, path) {
  try {
    const r = await fetch(base + path, { headers: { "x-cron-key": key } });
    const d = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    return r.ok ? d : { error: d?.error?.message || d?.error || `HTTP ${r.status}` };
  } catch (e) {
    return { error: e.message || String(e) };
  }
}

/* ── Orders, one shape for every channel ─────────────────────────────────── */

function fromEtsy(channel, ins) {
  const cur = ins.currency || "INR";
  return (ins.receipts || []).map(r => ({
    channel, id: `${channel}-${r.id}`, ts: (+r.ts || 0) * 1000, day: istDay((+r.ts || 0) * 1000),
    revenue: r2(r.sales), cur, units: (r.lines || []).reduce((t, l) => t + (+l.qty || 1), 0) || 1,
    buyer: r.buyer ? `etsy:${r.buyer}` : "", country: r.country || "",
    lines: (r.lines || []).map(l => ({ title: l.title, qty: +l.qty || 1, amt: r2(l.amt), lid: l.lid })),
  }));
}

function fromErp(rows) {
  const by = new Map();
  for (const r of rows || []) {
    const ch = r.platform;
    if (!ch || ch === "etsy" || ch === "etsy_ee" || VOID.test(String(r.status || ""))) continue;
    const oid = `${ch}-${r.platform_order_id || r.order_number || r.id}`;
    const ts = Date.parse(r.created_at || "") || istStart(r.date || "1970-01-01") + 12 * 3600e3;
    const o = by.get(oid) || { channel: ch, id: oid, ts, day: r.date || istDay(ts), revenue: 0, cur: String(r.currency || "INR").toUpperCase(), units: 0,
      buyer: String(r.buyer_email || r.buyer_name || "").toLowerCase(), country: r.buyer_country || r.ship_country || "", lines: [] };
    o.revenue = r2(o.revenue + (+r.sale_price || 0));
    o.units += +r.qty || 1;
    o.lines.push({ title: r.listing_title || "", qty: +r.qty || 1, amt: r2(r.sale_price), lid: r.listing_id || "" });
    by.set(oid, o);
  }
  return [...by.values()];
}

function salesFor(orders, day) {
  const today = orders.filter(o => o.day === day);
  const channels = {};
  for (const o of today) {
    const c = channels[o.channel] ||= { name: CHANNELS[o.channel] || o.channel, orders: 0, revenue: 0, units: 0, cur: o.cur };
    c.orders++; c.revenue = r2(c.revenue + o.revenue); c.units += o.units;
  }
  for (const c of Object.values(channels)) c.aov = c.orders ? r2(c.revenue / c.orders) : 0;
  // Last 7 days before, and the same day a week ago, per channel.
  const week = orders.filter(o => o.day >= addDays(day, -7) && o.day < day);
  const lastWeekDay = orders.filter(o => o.day === addDays(day, -7));
  const per = (list, ch) => list.filter(o => o.channel === ch);
  const allCh = new Set([...today, ...week].map(o => o.channel));
  const compare = {};
  for (const ch of allCh) {
    const w = per(week, ch), l = per(lastWeekDay, ch);
    compare[ch] = {
      avg7_orders: r2(w.length / 7), avg7_revenue: r2(w.reduce((t, o) => t + o.revenue, 0) / 7),
      lastweek_orders: l.length, lastweek_revenue: r2(l.reduce((t, o) => t + o.revenue, 0)),
    };
  }
  // Month to date (IST month of `day`).
  const month = day.slice(0, 7);
  const mtd = {};
  for (const o of orders.filter(o => o.day.startsWith(month) && o.day <= day)) {
    const m = mtd[o.channel] ||= { orders: 0, revenue: 0, cur: o.cur };
    m.orders++; m.revenue = r2(m.revenue + o.revenue);
  }
  // Products, countries, new vs returning (a buyer seen before `day` in the data we hold).
  const prod = new Map();
  for (const o of today) for (const l of o.lines) {
    const k = `${o.channel}|${l.lid || l.title}`;
    const p = prod.get(k) || { channel: o.channel, title: l.title, lid: l.lid, units: 0, revenue: 0, cur: o.cur };
    p.units += l.qty; p.revenue = r2(p.revenue + l.amt); prod.set(k, p);
  }
  const seenBefore = new Set(orders.filter(o => o.day < day && o.buyer).map(o => o.buyer));
  const countries = {};
  today.forEach(o => { if (o.country) countries[o.country] = (countries[o.country] || 0) + 1; });
  const big = [...today].sort((a, b) => toInr(b.revenue, b.cur) - toInr(a.revenue, a.cur)).slice(0, 5)
    .map(o => ({ channel: o.channel, revenue: o.revenue, cur: o.cur, units: o.units, country: o.country, items: o.lines.map(l => l.title).slice(0, 3) }));
  const totalInr = r2(today.reduce((t, o) => t + toInr(o.revenue, o.cur), 0));
  return {
    channels, compare, mtd,
    total: { orders: today.length, units: today.reduce((t, o) => t + o.units, 0), revenue_inr_est: totalInr,
      aov_inr_est: today.length ? r2(totalInr / today.length) : 0,
      new_buyers: today.filter(o => o.buyer && !seenBefore.has(o.buyer)).length,
      returning_buyers: today.filter(o => o.buyer && seenBefore.has(o.buyer)).length },
    top_products: [...prod.values()].sort((a, b) => b.units - a.units || b.revenue - a.revenue).slice(0, 8),
    countries, biggest_orders: big,
  };
}

/* ── Etsy listings: views from lifetime counts, snapshot to snapshot ─────── */

function etsyListingIntel(shopKey, ins, prevMap, weekMap) {
  const listings = ins.listings || [];
  const map = {};
  for (const l of listings) map[l.id] = [l.views, l.favs];
  const sold30 = new Map();
  for (const r of ins.receipts || []) {
    if ((+r.ts || 0) * 1000 < Date.now() - 30 * 864e5) continue;
    for (const ln of r.lines || []) sold30.set(ln.lid, (sold30.get(ln.lid) || 0) + (+ln.qty || 1));
  }
  const gained = (m, l) => m && m[l.id] ? Math.max(0, l.views - m[l.id][0]) : null;
  const rows = listings.map(l => ({ id: l.id, title: l.title, price: l.price, cur: l.cur, views: l.views, favs: l.favs,
    d1: gained(prevMap, l), d7: gained(weekMap, l), sold30: sold30.get(l.id) || 0, age_days: l.first ? Math.round((Date.now() / 1000 - l.first) / 86400) : null }));
  const has1 = !!prevMap, has7 = !!weekMap;
  const pick = (arr, n = 8) => arr.slice(0, n).map(({ id, title, price, cur, views, favs, d1, d7, sold30 }) => ({ id, title, price, cur, views, favs, d1, d7, sold30 }));
  return {
    map,
    out: {
      active: listings.length,
      views_yesterday: has1 ? rows.reduce((t, r) => t + (r.d1 || 0), 0) : null,
      views_7d: has7 ? rows.reduce((t, r) => t + (r.d7 || 0), 0) : null,
      favs_total: listings.reduce((t, l) => t + (+l.favs || 0), 0),
      top_viewed_yesterday: has1 ? pick(rows.filter(r => r.d1 > 0).sort((a, b) => b.d1 - a.d1)) : [],
      gaining_7d: has7 ? pick(rows.filter(r => r.d7 > 0).sort((a, b) => b.d7 - a.d7)) : [],
      views_no_sales: pick(rows.filter(r => !r.sold30 && (has7 ? r.d7 >= 5 : (r.views >= 40 && (r.age_days ?? 0) > 45)))
        .sort((a, b) => (has7 ? b.d7 - a.d7 : b.views - a.views))),
      no_traffic: has7 ? rows.filter(r => r.d7 === 0 && (r.age_days ?? 99) > 14).length
        : rows.filter(r => !r.views && (r.age_days ?? 0) > 30).length,
      no_traffic_basis: has7 ? "no new views in 7 days" : "0 lifetime views, listed 30+ days",
      top_sellers_30d: [...sold30.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
        .map(([id, units]) => ({ id, units, title: (listings.find(l => l.id === id) || (ins.others || []).find(l => l.id === id) || {}).title || "" })),
      repeat_buyers_45d: (() => { const c = {}; (ins.receipts || []).forEach(r => { if (r.buyer) c[r.buyer] = (c[r.buyer] || 0) + 1; }); return Object.values(c).filter(n => n > 1).length; })(),
    },
  };
}

function etsyAds(ins, day) {
  const sum = (from, to) => {
    const o = { etsy_ads: 0, offsite_ads: 0 };
    for (const a of ins.ads || []) {
      const d = istDay((+a.ts || 0) * 1000);
      if (d < from || d > to) continue;
      if (a.kind === "etsy") o.etsy_ads = r2(o.etsy_ads + a.amt); else o.offsite_ads = r2(o.offsite_ads + a.amt);
    }
    return o;
  };
  return { cur: ins.currency || "INR", day: sum(day, day), mtd: sum(`${day.slice(0, 7)}-01`, day), last7: sum(addDays(day, -6), day) };
}

/* ── eartheditions.co: its own visitor events ────────────────────────────── */

async function siteTraffic(sb, day) {
  const from = new Date(istStart(addDays(day, -7))).toISOString(), to = new Date(istStart(addDays(day, 1))).toISOString();
  const rows = [];
  for (let off = 0; off < 50000; off += 1000) {
    const { data, error } = await sb.from("site_events").select("at,vid,sid,type,handle,title,source,country,device")
      .gte("at", from).lt("at", to).eq("is_staff", false).order("at", { ascending: true }).range(off, off + 999);
    if (error) throw new Error(`site_events: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const byDay = {};
  for (const e of rows) (byDay[istDay(Date.parse(e.at))] ||= []).push(e);
  const sum = list => {
    const t = c => list.filter(e => e.type === c).length;
    return { visitors: new Set(list.map(e => e.vid)).size, visits: new Set(list.map(e => e.sid)).size, page_views: t("view"),
      product_views: list.filter(e => e.type === "view" && e.handle).length, add_to_cart: t("add_to_cart"), checkout: t("checkout"),
      purchase: t("purchase"), signups: t("signup"), searches: t("search") };
  };
  const D = byDay[day] || [];
  const firstBySid = new Map();
  D.forEach(e => { if (!firstBySid.has(e.sid)) firstBySid.set(e.sid, e); });
  const tally = (list, f) => { const c = {}; list.forEach(x => { const k = f(x) || "unknown"; c[k] = (c[k] || 0) + 1; }); return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 8); };
  const prevDays = [...Array(7)].map((_, i) => sum(byDay[addDays(day, -7 + i)] || []));
  const avg = k => r2(prevDays.reduce((t, d) => t + d[k], 0) / 7);
  return {
    day: sum(D),
    avg7: { visitors: avg("visitors"), visits: avg("visits"), product_views: avg("product_views"), add_to_cart: avg("add_to_cart"), purchase: avg("purchase") },
    sources: tally([...firstBySid.values()], e => e.source || "direct"),
    countries: tally([...firstBySid.values()], e => e.country),
    devices: tally([...firstBySid.values()], e => e.device),
    top_products: tally(D.filter(e => e.type === "view" && e.handle), e => e.title || e.handle).slice(0, 8),
    carted: tally(D.filter(e => e.type === "add_to_cart"), e => e.title || e.handle).slice(0, 8),
  };
}

/* ── Listing changes, and what happened after the ones a week old ────────── */

async function listingChanges(sb, day, listings, etsyMaps) {
  const since = new Date(istStart(addDays(day, -8))).toISOString();
  const { data, error } = await sb.from("raj_listing_changes").select("at,listing_id,title,field,before,after")
    .gte("at", since).order("at", { ascending: false }).limit(3000);
  if (error) return { error: error.message };
  const recentFrom = istStart(day);
  const group = list => {
    const m = new Map();
    for (const c of list) {
      const g = m.get(c.listing_id) || { listing_id: c.listing_id, title: c.title, fields: [] };
      g.fields.push({ field: c.field, before: c.before, after: c.after, at: c.at });
      m.set(c.listing_id, g);
    }
    return [...m.values()];
  };
  const recent = (data || []).filter(c => Date.parse(c.at) >= recentFrom);
  const counts = {};
  recent.forEach(c => { counts[c.field] = (counts[c.field] || 0) + 1; });
  // Changes made 7 days before `day`: Etsy views in the week since vs the week before.
  const weekOld = group((data || []).filter(c => istDay(Date.parse(c.at)) === addDays(day, -7) && c.field !== "created"));
  const byId = new Map((listings || []).map(l => [l.id, l]));
  const etsyId = l => String(l?.platforms?.etsy?.listing_id || l?.platforms?.etsy?.id || l?.platforms?.etsy?.etsy_listing_id || l?.etsy_listing_id || "");
  const impact = weekOld.slice(0, 25).map(g => {
    const eid = etsyId(byId.get(g.listing_id));
    const v = k => etsyMaps[k]?.[eid]?.[0];
    const now = v("now"), at = v("d7"), before = v("d14");
    return { ...g, fields: g.fields.map(f => f.field), etsy_id: eid || null,
      views_week_after: now != null && at != null ? now - at : null, views_week_before: at != null && before != null ? at - before : null };
  });
  return { count: recent.length, by_field: counts, listings: group(recent).slice(0, 40), impact_week_old: impact };
}

/* ── The snapshot ────────────────────────────────────────────────────────── */

export async function rajSnapshot({ sb, base, now = Date.now() }) {
  const today = istDay(now), day = addDays(today, -1);
  const key = await cronKey(sb);
  if (!key) throw new Error("cron_keys has no 'raj' row (run the Raj migration)");
  const errors = {};

  const [atyIns, eeIns, ebayIns, ordersRaw, listings, prev, week, twoWeek] = await Promise.all([
    callApi(base, key, "/api/etsy?action=insights&days=45"),
    callApi(base, key, "/api/etsy?action=insights&days=45&shop=earth"),
    callApi(base, key, "/api/ebay?action=insights&lite=1&tdays=1"),
    appData(sb, "ng-orders-v1").catch(e => { errors.orders = e.message; return []; }),
    readRows(sb, "ng-listings-v1").catch(e => { errors.listings = e.message; return []; }),
    rajRow(sb, RAJ.snapshots, addDays(today, -1)),
    rajRow(sb, RAJ.snapshots, addDays(today, -7)),
    rajRow(sb, RAJ.snapshots, addDays(today, -14)),
  ]);

  const shops = { etsy: atyIns, etsy_ee: eeIns };
  const orders = fromErp(Array.isArray(ordersRaw) ? ordersRaw : []);
  const etsy = {}, etsyViews = {}, ads = {};
  for (const [ch, ins] of Object.entries(shops)) {
    if (ins?.error) { errors[ch] = ins.error; continue; }
    orders.push(...fromEtsy(ch, ins));
    const intel = etsyListingIntel(ch, ins, prev?.etsy_views?.[ch], week?.etsy_views?.[ch]);
    etsy[ch] = intel.out;
    etsyViews[ch] = intel.map;
    ads[ch] = etsyAds(ins, day);
    if (ins.adsError) errors[`${ch}_ads`] = ins.adsError;
  }

  let ebay = null;
  if (ebayIns?.error) errors.ebay = ebayIns.error;
  else {
    const t = ebayIns.traffic || {};
    const H = t.header || [];
    const col = name => H.indexOf(name) + 1;
    const rows = t.rows || [];
    const total = name => rows.reduce((s, r) => s + (+r[col(name)] || 0), 0);
    const title = id => (ebayIns.active || []).find(i => i.id === id)?.title || "";
    const impressions = total("LISTING_IMPRESSION_TOTAL"), views = total("LISTING_VIEWS_TOTAL");
    ebay = {
      active: (ebayIns.active || []).length, sold_60d: +ebayIns.sold60 || 0,
      watchers: (ebayIns.active || []).reduce((s, i) => s + (+i.watch || 0), 0),
      traffic_yesterday: t.error ? null : { impressions, search_impressions: total("LISTING_IMPRESSION_SEARCH_RESULTS_PAGE"), views,
        ctr_pct: impressions ? r2(views / impressions * 100) : 0, transactions: total("TRANSACTION") },
      top_viewed: t.error ? [] : rows.map(r => ({ id: r[0], title: title(r[0]), views: +r[col("LISTING_VIEWS_TOTAL")] || 0, impressions: +r[col("LISTING_IMPRESSION_TOTAL")] || 0 }))
        .sort((a, b) => b.views - a.views).slice(0, 6),
      most_watched: [...(ebayIns.active || [])].sort((a, b) => (+b.watch || 0) - (+a.watch || 0)).slice(0, 5).map(i => ({ id: i.id, title: i.title, watch: +i.watch || 0, price: i.price })),
    };
    if (t.error) errors.ebay_traffic = `${t.error} ${t.detail || ""}`.trim();
  }

  let site = null;
  try { site = await siteTraffic(sb, day); } catch (e) { errors.site = e.message; }

  const etsyMaps = { now: etsyViews.etsy, d7: week?.etsy_views?.etsy, d14: twoWeek?.etsy_views?.etsy };
  const changes = await listingChanges(sb, day, listings, etsyMaps).catch(e => ({ error: e.message }));

  const notes = await readRows(sb, RAJ.notes).catch(() => []);
  const open = notes.filter(n => n.kind === "followup" && n.status !== "done");
  const followups = {
    open: open.length,
    due: open.filter(n => n.due && n.due <= today && n.status !== "snoozed").map(n => ({ id: n.id, title: n.title, due: n.due, channel: n.channel || "" })),
  };

  const snap = {
    id: today, day, at: new Date(now).toISOString(),
    sales: salesFor(orders, day),
    etsy, ads: { etsy: ads, meta: null }, ebay, site, changes, followups,
    listings_total: listings.length,
    etsy_views: etsyViews,
    availability: {
      etsy_sales: errors.etsy || errors.etsy_ee ? "partial: " + [errors.etsy, errors.etsy_ee].filter(Boolean).join("; ") : "verified (Etsy receipts)",
      ebay_shopify_store_trade_sales: "recorded (orders in the ERP; eBay synced 07:30 IST, store by webhook, Shopify when the ERP syncs)",
      etsy_views: prev ? "estimated (lifetime views today minus yesterday's snapshot, ~24h to 07:45 IST)" : "unavailable today (first snapshot; from tomorrow)",
      etsy_views_7d: week ? "estimated" : "unavailable until 7 days of snapshots",
      etsy_search_impressions: "unavailable (Etsy's API doesn't give them)",
      etsy_ads: "verified (Etsy payment ledger)",
      ebay_traffic: ebay?.traffic_yesterday ? "verified (eBay traffic report)" : `unavailable${errors.ebay_traffic || errors.ebay ? ": " + (errors.ebay_traffic || errors.ebay) : ""}`,
      site_traffic: site ? "verified (eartheditions.co's own events, staff excluded)" : "unavailable",
      shopify_traffic: "unavailable (needs Shopify analytics access)",
      meta_ads: "unavailable (Meta isn't connected)",
      inr_totals: "estimated (fixed rates: USD " + RATE.USD + ")",
    },
    errors,
  };
  await upsertRow(sb, RAJ.snapshots, snap, true);
  return snap;
}

/* ── The numbers-only briefing, for a morning Claude didn't run ──────────── */

const money = (v, cur) => `${String(cur || "INR").toUpperCase() === "INR" ? "₹" : String(cur).toUpperCase() === "USD" ? "$" : (cur + " ")}${Math.round(+v || 0).toLocaleString("en-IN")}`;

export function numbersOnlyBriefing(s) {
  const S = s.sales || {}, T = S.total || {};
  const ch = Object.entries(S.channels || {}).map(([k, c]) => `- ${c.name}: ${c.orders} order${c.orders === 1 ? "" : "s"}, ${money(c.revenue, c.cur)} (${c.units} pcs)`);
  const lines = [
    `Good morning, Sir. Today is numbers only: the analysis runs on the Mac, and it hasn't reported yet.`,
    ``,
    `## Yesterday (${s.day})`,
    T.orders ? `${T.orders} orders, ${T.units} pieces, about ${money(T.revenue_inr_est, "INR")} in all.` : `No orders recorded yesterday.`,
    ...ch,
  ];
  const ey = s.etsy?.etsy, ee = s.etsy?.etsy_ee;
  lines.push(``, `## Traffic`);
  if (ey) lines.push(`- Atyahara Etsy: ${ey.views_yesterday ?? "n/a"} views yesterday, ${ey.active} active listings`);
  if (ee) lines.push(`- EarthEditions Etsy: ${ee.views_yesterday ?? "n/a"} views yesterday, ${ee.active} active listings`);
  if (s.ebay?.traffic_yesterday) lines.push(`- eBay: ${s.ebay.traffic_yesterday.views} views from ${s.ebay.traffic_yesterday.impressions} impressions; ${s.ebay.watchers} watchers`);
  if (s.site) lines.push(`- eartheditions.co: ${s.site.day.visitors} visitors (7-day avg ${s.site.avg7.visitors}), ${s.site.day.add_to_cart} add-to-carts, ${s.site.day.purchase} purchases`);
  if (s.changes?.count) lines.push(``, `## Listing changes`, `${s.changes.count} edits across ${s.changes.listings.length} listings.`);
  if (s.followups?.due?.length) lines.push(``, `## Follow-ups due`, ...s.followups.due.map(f => `- ${f.title}${f.due ? ` (due ${f.due})` : ""}`));
  return {
    id: s.id, day: s.day, at: new Date().toISOString(), generated_by: "numbers-only",
    headline: T.orders ? `${T.orders} orders, about ${money(T.revenue_inr_est, "INR")}` : "No orders yesterday",
    narrative_md: lines.join("\n"), highlights: [], snapshot_id: s.id,
  };
}

export async function rajFallback({ sb, base, now = Date.now() }) {
  const today = istDay(now);
  const have = await rajRow(sb, RAJ.briefings, today);
  if (have) return { skipped: true, by: have.generated_by };
  const snap = (await rajRow(sb, RAJ.snapshots, today)) || await rajSnapshot({ sb, base, now });
  const b = numbersOnlyBriefing(snap);
  await upsertRow(sb, RAJ.briefings, b, true);
  return { written: true, id: b.id };
}
