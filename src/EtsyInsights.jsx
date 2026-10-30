import React, { useEffect, useMemo, useState } from "react";
import { C } from "./ui.jsx";
import { mob, loadK, saveK } from "./utils.js";

/* Insights: the Etsy shop read for what brings sales. Live from Etsy
   (/api/etsy?action=insights): every active listing with its views and
   favourites, six months of paid orders line by line, and ninety days of ad
   charges from the payment ledger. Joined to the ERP's listings for shape,
   stock and type. Etsy's API gives no per-listing ad results and no way to
   set the Ads budget, so the ad side is read from what was charged against
   what sold, and the budget is changed on Etsy. Lifetime views are all Etsy
   gives; a copy is kept each day (ng-etsy-views-v1) so views over the last
   week and month can be read once a few days have built up. */

const CACHE = "ng-insights-v1", VIEWS_KEY = "ng-etsy-views-v1", DAY = 86400000;
const ADS_URL = "https://www.etsy.com/your/shops/me/advertising";
const SALES = "#D95A00", ETSYADS = "#7A5AC8", OFFSITE = "#0F8C7B";

const usd = v => "$" + Math.round(v || 0).toLocaleString("en-US");
const usd2 = v => "$" + (v || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usdK = v => { const a = Math.abs(v || 0); return a >= 1000 ? `$${(a / 1000).toFixed(a >= 10000 ? 0 : 1).replace(/\.0$/, "")}k` : `$${Math.round(a)}`; };
const pct = v => v == null || !isFinite(v) ? "—" : `${Math.round(v * 100)}%`;
const flag = iso => /^[A-Z]{2}$/.test(iso || "") ? String.fromCodePoint(...[...iso].map(c => 127397 + c.charCodeAt(0))) : "🌐";
const dayKey = ms => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const dayStart = ms => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return +d; };
const niceMax = v => { if (!(v > 0)) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); return [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map(m => m * p).find(m => m >= v); };
const readCache = () => { try { const c = JSON.parse(localStorage.getItem(CACHE) || "null"); return c?.data?.ok ? c : null; } catch { return null; } };
const ago = ms => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };

const card = { background: C.surface, borderRadius: 16, boxShadow: "var(--e-1)", border: `1px solid ${C.border}`, padding: mob ? "14px" : "18px 20px", minWidth: 0 };
const eyebrow = { fontSize: 10.5, fontWeight: 800, color: C.inkFaint, textTransform: "uppercase", letterSpacing: 1.1 };
const SERIF = "'Cormorant Garamond',Georgia,serif";

function Delta({ now, prev, good = "up" }) {
  if (!(prev > 0)) return null;
  const d = (now - prev) / prev, up = d >= 0, ok = good === "up" ? up : !up;
  return <span style={{ fontSize: 11.5, fontWeight: 800, color: ok ? C.green : C.red }}>{up ? "▲" : "▼"} {Math.abs(Math.round(d * 100))}%</span>;
}
function Kpi({ label, value, sub, delta, tone }) {
  return (
    <div style={{ ...card, padding: "14px 16px", background: tone || C.surface }}>
      <div style={eyebrow}>{label}</div>
      <div style={{ fontFamily: SERIF, fontVariantNumeric: "lining-nums", fontSize: 30, fontWeight: 600, color: C.ink, lineHeight: 1.1, marginTop: 4 }}>{value}</div>
      <div style={{ display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap", marginTop: 3, fontSize: 11.5, color: C.inkMid }}>{delta}{sub}</div>
    </div>
  );
}
function Section({ title, sub, right, children }) {
  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        <div>
          <div style={{ fontFamily: SERIF, fontSize: 21, fontWeight: 600, color: C.ink, lineHeight: 1.1 }}>{title}</div>
          {sub && <div style={{ fontSize: 12, color: C.inkMid, marginTop: 3, maxWidth: 720 }}>{sub}</div>}
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}
const Thumb = ({ src }) => src
  ? <img src={src} alt="" loading="lazy" style={{ width: 40, height: 40, borderRadius: 8, objectFit: "cover", flexShrink: 0, background: C.card }} />
  : <div style={{ width: 40, height: 40, borderRadius: 8, background: C.card, flexShrink: 0 }} />;
const Tag = ({ children, color = C.inkMid, bg = C.card }) => <span style={{ fontSize: 10, fontWeight: 800, color, background: bg, borderRadius: 6, padding: "2px 6px", whiteSpace: "nowrap" }}>{children}</span>;

/* Daily sales against what the ads cost that day: stacked ad bars, sales as a line. */
function SpendChart({ days }) {
  const [hover, setHover] = useState(null);
  const W = 1000, H = 230, PL = 44, PR = 12, PT = 12, PB = 24;
  const CW = W - PL - PR, CH = H - PT - PB, n = days.length;
  const yMax = niceMax(Math.max(1, ...days.map(d => Math.max(d.sales, d.etsy + d.offsite))) * 1.05);
  const slot = CW / Math.max(1, n), bw = Math.max(2, slot * 0.62);
  const x = i => PL + i * slot + slot / 2, y = v => PT + CH * (1 - v / yMax);
  const avg = days.map((_, i) => { const w = days.slice(Math.max(0, i - 6), i + 1); return w.reduce((a, d) => a + d.sales, 0) / w.length; });
  const line = arr => arr.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const h = hover != null ? days[hover] : null;
  return (
    <div style={{ position: "relative" }}>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 11.5, color: C.inkMid, marginBottom: 6 }}>
        <span><i style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: ETSYADS, marginRight: 5 }} />Etsy Ads</span>
        <span><i style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: OFFSITE, marginRight: 5 }} />Offsite Ads fees</span>
        <span><i style={{ display: "inline-block", width: 14, height: 2, background: SALES, marginRight: 5, verticalAlign: "middle" }} />Sales, 7-day average</span>
        <span><i style={{ display: "inline-block", width: 6, height: 6, borderRadius: 3, background: SALES, opacity: .45, marginRight: 5 }} />Sales that day</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block", touchAction: "pan-y" }}
        onPointerMove={e => { const r = e.currentTarget.getBoundingClientRect(); const i = Math.floor(((e.clientX - r.left) / r.width * W - PL) / slot); setHover(i >= 0 && i < n ? i : null); }}
        onPointerLeave={() => setHover(null)}>
        {[0.25, 0.5, 0.75, 1].map(t => (
          <g key={t}>
            <line x1={PL} x2={W - PR} y1={y(t * yMax)} y2={y(t * yMax)} stroke={C.border} />
            <text x={PL - 6} y={y(t * yMax) + 4} textAnchor="end" fontSize={11} fill={C.inkFaint}>{usdK(t * yMax)}</text>
          </g>
        ))}
        {hover != null && <rect x={PL + hover * slot} y={PT} width={slot} height={CH} fill={C.card} />}
        {days.map((d, i) => (
          <g key={d.k}>
            {d.etsy > 0 && <rect x={x(i) - bw / 2} y={y(d.etsy)} width={bw} height={y(0) - y(d.etsy)} fill={ETSYADS} rx={1.5} />}
            {d.offsite > 0 && <rect x={x(i) - bw / 2} y={y(d.etsy + d.offsite)} width={bw} height={y(d.etsy) - y(d.etsy + d.offsite)} fill={OFFSITE} rx={1.5} />}
            {d.sales > 0 && <circle cx={x(i)} cy={y(d.sales)} r={2.6} fill={SALES} opacity={.45} />}
          </g>
        ))}
        <line x1={PL} x2={W - PR} y1={y(0)} y2={y(0)} stroke={C.inkFaint} strokeOpacity={.5} />
        <path d={line(avg)} fill="none" stroke={SALES} strokeWidth={2.5} strokeLinejoin="round" />
        {days.map((d, i) => i % Math.ceil(n / 8) === 0 && <text key={d.k} x={x(i)} y={H - 6} textAnchor="middle" fontSize={11} fill={C.inkFaint}>{new Date(d.ms).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</text>)}
      </svg>
      {h && (
        <div style={{ position: "absolute", top: 26, left: `${Math.min(78, Math.max(2, (x(hover) / W) * 100 - 8))}%`, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: "var(--e-2)", padding: "8px 11px", fontSize: 12, pointerEvents: "none", minWidth: 170 }}>
          <div style={{ fontWeight: 800, marginBottom: 3 }}>{new Date(h.ms).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}</div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}><span>Sales · {h.orders} order{h.orders === 1 ? "" : "s"}</span><b>{usd(h.sales)}</b></div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, color: ETSYADS }}><span>Etsy Ads</span><b>{usd2(h.etsy)}</b></div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, color: OFFSITE }}><span>Offsite Ads</span><b>{usd2(h.offsite)}</b></div>
        </div>
      )}
    </div>
  );
}

function ListingRow({ r, right, note }) {
  return (
    <a href={`https://www.etsy.com/listing/${r.id}`} target="_blank" rel="noreferrer" style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 0", borderTop: `1px solid ${C.border}`, color: C.ink, textDecoration: "none" }}>
      <Thumb src={r.img} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.title}</div>
        <div style={{ fontSize: 11, color: C.inkMid, marginTop: 2 }}>{note}</div>
      </div>
      <div style={{ flexShrink: 0, textAlign: "right", fontSize: 12 }}>{right}</div>
    </a>
  );
}
function ActionCard({ icon, title, why, rows, render, empty, accent }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, 5);
  return (
    <div style={{ ...card, borderTop: `3px solid ${accent}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 18 }}>{icon}</span>
        <div style={{ fontSize: 14.5, fontWeight: 800, color: C.ink, flex: 1 }}>{title}</div>
        <span style={{ fontSize: 12, fontWeight: 800, color: rows.length ? accent : C.inkFaint }}>{rows.length}</span>
      </div>
      <div style={{ fontSize: 11.5, color: C.inkMid, margin: "4px 0 6px", lineHeight: 1.45 }}>{why}</div>
      {rows.length ? shown.map(render) : <div style={{ fontSize: 12, color: C.inkFaint, padding: "8px 0" }}>{empty}</div>}
      {rows.length > 5 && <button onClick={() => setAll(a => !a)} style={{ marginTop: 6, background: "none", border: "none", color: C.gold, fontWeight: 800, fontSize: 12, cursor: "pointer", padding: 0 }}>{all ? "Show fewer" : `Show all ${rows.length}`}</button>}
    </div>
  );
}

export default function EtsyInsights({ listings = [], onOpenRenew }) {
  const [cache, setCache] = useState(readCache);
  const [busy, setBusy] = useState(false), [err, setErr] = useState("");
  const [range, setRange] = useState(30);
  const [rate, setRate] = useState(84);
  const [viewsHist, setViewsHist] = useState(null);
  const [sort, setSort] = useState("rev");

  const load = async () => {
    setBusy(true); setErr("");
    try {
      const r = await fetch(`/api/etsy?action=insights&days=180&_=${Date.now()}`, { cache: "no-store" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(d.error || `Etsy didn't answer (${r.status})`);
      const next = { at: Date.now(), data: d };
      setCache(next);
      try { localStorage.setItem(CACHE, JSON.stringify(next)); } catch { /* too big to keep: fine, it reloads */ }
    } catch (e) { setErr(e.message || "Couldn't reach Etsy"); }
    setBusy(false);
  };
  useEffect(() => {
    loadK("ng-fin-rates-v1").then(r => { if (+r?.USD > 0) setRate(+r.USD); }).catch(() => {});
    loadK(VIEWS_KEY).then(v => setViewsHist(v && typeof v === "object" && !Array.isArray(v) ? v : {})).catch(() => setViewsHist({}));
    if (!cache || Date.now() - cache.at > 3 * 3600000) load();
  }, []);

  // Today's lifetime views, kept once a day, so views over a week or a month can be worked out.
  useEffect(() => {
    if (!cache?.data?.listings || viewsHist == null) return;
    const k = dayKey(cache.data.at * 1000);
    if (viewsHist[k]) return;
    const snap = Object.fromEntries(cache.data.listings.map(l => [l.id, l.views]));
    const keep = Object.keys(viewsHist).sort().slice(-34);
    const next = { ...Object.fromEntries(keep.map(d => [d, viewsHist[d]])), [k]: snap };
    setViewsHist(next);
    saveK(VIEWS_KEY, next, { merge: false }).catch(() => {});
  }, [cache, viewsHist]);

  const m = useMemo(() => {
    const d = cache?.data;
    if (!d) return null;
    const cur = d.currency || "INR";
    const toUSD = v => cur === "USD" ? v : v / rate;
    const nowMs = d.at * 1000, today0 = dayStart(nowMs);
    const P = range * DAY, a = today0 + DAY - P, pa = a - P;
    const rec = (d.receipts || []).map(r => ({ ...r, ms: r.ts * 1000, usd: toUSD(r.sales) }));
    const inP = rec.filter(r => r.ms >= a), inPrev = rec.filter(r => r.ms >= pa && r.ms < a);
    const sum = (rows, f) => rows.reduce((s, r) => s + f(r), 0);
    const ads = (d.ads || []).map(x => ({ ...x, ms: x.ts * 1000, usd: toUSD(x.amt) }));
    const adsFrom = nowMs - 90 * DAY;
    const adIn = (from, to, kind) => sum(ads.filter(x => x.ms >= from && x.ms < to && (!kind || x.kind === kind)), x => x.usd);
    const sales = sum(inP, r => r.usd), salesPrev = sum(inPrev, r => r.usd);
    const etsyAds = adIn(a, Infinity, "etsy"), offsite = adIn(a, Infinity, "offsite");
    const prevAdsKnown = pa >= adsFrom - DAY;
    const etsyAdsPrev = prevAdsKnown ? adIn(pa, a, "etsy") : null, offsitePrev = prevAdsKnown ? adIn(pa, a, "offsite") : null;

    // Days of the chart.
    const days = [];
    for (let t = a; t <= today0; t += DAY) {
      const e = t + DAY, rows = rec.filter(r => r.ms >= t && r.ms < e);
      days.push({ k: dayKey(t), ms: t, sales: sum(rows, r => r.usd), orders: rows.length, etsy: adIn(t, e, "etsy"), offsite: adIn(t, e, "offsite") });
    }
    // Weeks, newest first: where the money went and what came back.
    const weeks = [];
    for (let e = today0 + DAY, i = 0; i < 12 && e - 7 * DAY >= nowMs - 180 * DAY; e -= 7 * DAY, i++) {
      const s = e - 7 * DAY, rows = rec.filter(r => r.ms >= s && r.ms < e);
      const known = s >= adsFrom - DAY;
      weeks.push({ s, sales: sum(rows, r => r.usd), orders: rows.length, etsy: known ? adIn(s, e, "etsy") : null, offsite: known ? adIn(s, e, "offsite") : null });
    }

    // Offsite Ads: the orders they were charged on.
    const offsiteRefs = new Set(ads.filter(x => x.kind === "offsite" && x.ms >= a).map(x => x.ref).filter(Boolean));
    const offsiteOrders = inP.filter(r => offsiteRefs.has(r.id));
    const offsiteSales = sum(offsiteOrders, r => r.usd);

    // Listings: sales put against each, joined to the ERP.
    const erpBy = {};
    for (const l of listings) { const id = l.platforms?.etsy?.listing_id; if (id) erpBy[String(id)] = l; }
    const per = {};
    const add = (r, key, wf) => { for (const ln of r.lines || []) { if (!ln.lid) continue; const p = per[ln.lid] ||= { units: 0, rev: 0, unitsPrev: 0, revPrev: 0, units180: 0, last: 0, title: ln.title }; wf(p, ln, r); } };
    for (const r of rec) add(r, "", (p, ln) => { p.units180 += ln.qty; p.last = Math.max(p.last, r.ms); if (r.ms >= a) { p.units += ln.qty; p.rev += toUSD(ln.amt); } else if (r.ms >= pa) { p.unitsPrev += ln.qty; p.revPrev += toUSD(ln.amt); } });
    const hist = viewsHist || {}, hk = Object.keys(hist).sort();
    const oldest = (back) => { const want = dayKey(nowMs - back * DAY); const k = hk.find(x => x >= want); return k && k < dayKey(nowMs) ? { k, v: hist[k] } : null; };
    const v7 = oldest(7), v30 = oldest(30);
    const live = (d.listings || []).map(l => {
      const s = per[l.id] || { units: 0, rev: 0, unitsPrev: 0, revPrev: 0, units180: 0, last: 0 };
      const erp = erpBy[l.id];
      const age = Math.max(1, (nowMs - l.first * 1000) / DAY);
      return {
        ...l, ...s, erp, priceUSD: toUSD(l.price), age,
        shape: erp?.shape || "", type: erp?.type || (l.qty > 1 ? "repeatable" : "unique"),
        conv: l.views > 0 ? s.units180 / l.views * 1000 : 0, // sales per 1,000 views
        favRate: l.views > 0 ? l.favs / l.views : 0,
        viewsWeek: v7 && v7.v[l.id] != null ? l.views - v7.v[l.id] : null,
        viewsMonth: v30 && v30.v[l.id] != null ? l.views - v30.v[l.id] : null,
      };
    });
    const liveIds = new Set(live.map(l => l.id));
    const sellers = Object.entries(per).filter(([, p]) => p.units > 0 || p.unitsPrev > 0).map(([id, p]) => ({ id, ...p, ...(live.find(l => l.id === id) || { title: p.title, gone: true }) }));

    // Actions.
    const medViews = (() => { const v = live.map(l => l.views).sort((x, y) => x - y); return v[Math.floor(v.length / 2)] || 0; })();
    const p85 = (() => { const v = live.map(l => l.views).sort((x, y) => x - y); return v[Math.floor(v.length * 0.85)] || 0; })();
    const quiet = live.filter(l => l.units180 >= 3 && nowMs - l.last > 21 * DAY).sort((x, y) => y.units180 - x.units180);
    const push = live.filter(l => l.units180 >= 2 && l.conv >= 4 && l.views <= Math.max(medViews * 2, 300)).sort((x, y) => y.conv * y.priceUSD - x.conv * x.priceUSD);
    const wasted = live.filter(l => l.units180 === 0 && l.views >= Math.max(p85, 150) && l.age > 45).sort((x, y) => y.views - x.views);
    const loved = live.filter(l => l.units180 === 0 && l.favs >= 8 && l.favRate >= 0.04).sort((x, y) => y.favs - x.favs);
    const restock = live.filter(l => l.type === "repeatable" && l.qty <= 3 && l.units180 >= 3).sort((x, y) => y.units180 - x.units180);
    const polish = live.filter(l => l.units180 >= 2 && (!l.video || l.photos < 5)).sort((x, y) => y.units180 - x.units180);
    const erpExpiredSold = listings.filter(l => l.platforms?.etsy?.expired && l.platforms?.etsy?.listing_id && per[String(l.platforms.etsy.listing_id)]?.units180 > 0);

    // Shapes: what earns per listing.
    const byShape = {};
    for (const l of live) {
      const k = l.shape || "Unsorted";
      const g = byShape[k] ||= { shape: k, n: 0, units: 0, rev: 0, views: 0, units180: 0 };
      g.n++; g.units += l.units; g.rev += l.rev; g.views += l.views; g.units180 += l.units180;
    }
    const shapes = Object.values(byShape).map(g => ({ ...g, perListing: g.rev / g.n, conv: g.views ? g.units180 / g.views * 1000 : 0 })).sort((x, y) => y.rev - x.rev);

    const countries = {};
    for (const r of inP) { const c = countries[r.country || "?"] ||= { c: r.country, orders: 0, usd: 0 }; c.orders++; c.usd += r.usd; }
    const buyers = {}; for (const r of rec) if (r.buyer) buyers[r.buyer] = (buyers[r.buyer] || 0) + 1;
    const repeatShare = inP.length ? inP.filter(r => buyers[r.buyer] > 1).length / inP.length : 0;
    const neverSold = live.filter(l => l.units180 === 0).length;

    return {
      cur, sales, salesPrev, orders: inP.length, ordersPrev: inPrev.length, aov: inP.length ? sales / inP.length : 0, aovPrev: inPrev.length ? salesPrev / inPrev.length : 0,
      etsyAds, offsite, etsyAdsPrev, offsitePrev, days, weeks, offsiteOrders, offsiteSales,
      live, liveIds, sellers, quiet, push, wasted, loved, restock, polish, erpExpiredSold, shapes,
      countries: Object.values(countries).sort((x, y) => y.usd - x.usd).slice(0, 8), repeatShare, neverSold,
      viewsSince: v7?.k || null, adsError: d.adsError, at: cache.at,
    };
  }, [cache, range, rate, listings, viewsHist]);

  if (!m) return (
    <div style={{ ...card, textAlign: "center", padding: 48, color: C.inkMid }}>
      {busy ? "Reading the shop from Etsy — listings, six months of orders and the ad charges. About half a minute…" : err ? <>Couldn't read Etsy: {err} <button onClick={load} style={{ marginLeft: 8 }}>Try again</button></> : "Loading…"}
    </div>
  );

  const adsTotal = m.etsyAds + m.offsite, adShare = m.sales ? adsTotal / m.sales : null;
  const roasEtsy = m.etsyAds ? (m.sales - m.offsiteSales) / m.etsyAds : null;
  const perDayAds = m.etsyAds / range;
  // The budget call: what the ads cost against what the shop takes, read plainly.
  const verdict = adShare == null ? null
    : adShare < 0.08 ? { tone: C.green, head: "Ads are cheap for what the shop takes — room to spend more", body: `Ads cost ${pct(adShare)} of sales. Raise the Etsy Ads daily budget by about 20% (to ~${usd2(perDayAds * 1.2)}/day) and watch the next two weeks below: if sales rise with it, keep going.` }
    : adShare < 0.15 ? { tone: C.amber, head: "Ad spend is in a healthy range", body: `Ads cost ${pct(adShare)} of sales. Keep the budget (~${usd2(perDayAds)}/day) but point it at the listings that convert — the "Put ads behind these" list — and turn ads off the ones that only collect views.` }
    : { tone: C.red, head: "Ads are eating the margin", body: `Ads cost ${pct(adShare)} of sales. Cut the Etsy Ads budget by about a quarter (to ~${usd2(perDayAds * 0.75)}/day), keep ads only on proven sellers, and take them off everything in "Views, no sales".` };

  const sorted = [...m.sellers].sort((x, y) => sort === "units" ? y.units - x.units : sort === "trend" ? ((y.rev - y.revPrev) - (x.rev - x.revPrev)) : sort === "conv" ? (y.conv || 0) - (x.conv || 0) : y.rev - x.rev).slice(0, 25);
  const grid = (min) => ({ display: "grid", gridTemplateColumns: mob ? "1fr" : `repeat(auto-fill, minmax(${min}px, 1fr))`, gap: 14 });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, paddingBottom: 40 }}>
      {/* header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontFamily: SERIF, fontSize: 28, fontWeight: 600, color: C.ink, lineHeight: 1 }}>Etsy insights</div>
          <div style={{ fontSize: 12, color: C.inkMid, marginTop: 4 }}>Live from Etsy · updated {ago(m.at)} · amounts in $ at ₹{Math.round(rate)}</div>
        </div>
        <div style={{ display: "inline-flex", gap: 2, padding: 3, background: C.card, borderRadius: 10 }}>
          {[[7, "7 days"], [30, "30 days"], [90, "90 days"]].map(([k, l]) => (
            <button key={k} onClick={() => setRange(k)} style={{ border: "none", cursor: "pointer", fontSize: 12, fontWeight: 800, padding: "6px 12px", borderRadius: 8, background: range === k ? C.surface : "transparent", color: range === k ? C.ink : C.inkMid, boxShadow: range === k ? "0 1px 2px rgba(0,0,0,.08)" : "none" }}>{l}</button>
          ))}
        </div>
        <button onClick={load} disabled={busy} style={{ border: `1px solid ${C.border}`, background: C.surface, borderRadius: 10, padding: "7px 12px", fontSize: 12, fontWeight: 800, cursor: "pointer", color: C.ink }}>{busy ? "Refreshing…" : "↻ Refresh"}</button>
      </div>
      {err && <div style={{ fontSize: 12, color: C.red }}>Refresh failed: {err} — showing the last copy.</div>}
      {m.adsError && <div style={{ fontSize: 12, color: C.amber }}>Etsy didn't give the ad charges this time ({m.adsError}); ad figures may read low.</div>}

      {/* KPIs */}
      <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr 1fr" : "repeat(5, 1fr)", gap: 12 }}>
        <Kpi label="Sales" value={usd(m.sales)} delta={<Delta now={m.sales} prev={m.salesPrev} />} sub={`vs ${usd(m.salesPrev)} the ${range} days before`} />
        <Kpi label="Orders" value={m.orders} delta={<Delta now={m.orders} prev={m.ordersPrev} />} sub={`avg order ${usd(m.aov)}`} />
        <Kpi label="Etsy Ads" value={usd(m.etsyAds)} delta={m.etsyAdsPrev != null ? <Delta now={m.etsyAds} prev={m.etsyAdsPrev} good="down" /> : null} sub={`${usd2(perDayAds)}/day`} />
        <Kpi label="Offsite Ads fees" value={usd(m.offsite)} sub={`${m.offsiteOrders.length} order${m.offsiteOrders.length === 1 ? "" : "s"} · ${usd(m.offsiteSales)} sales`} />
        <Kpi label="Ads as % of sales" value={pct(adShare)} tone={adShare == null ? undefined : adShare < 0.1 ? C.greenBg : adShare < 0.18 ? C.amberBg : C.redBg}
          sub={roasEtsy ? `every $1 of Etsy Ads ↔ ${usd2(roasEtsy)} of other sales` : ""} />
      </div>

      {/* budget verdict */}
      {verdict && (
        <div style={{ ...card, borderLeft: `5px solid ${verdict.tone}`, display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 260 }}>
            <div style={eyebrow}>Ad budget · what to do</div>
            <div style={{ fontSize: 16.5, fontWeight: 800, color: C.ink, marginTop: 4 }}>{verdict.head}</div>
            <div style={{ fontSize: 12.5, color: C.inkMid, marginTop: 4, lineHeight: 1.5 }}>{verdict.body}</div>
            <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 6 }}>Etsy doesn't let other apps change the Ads budget or see per-listing ad results, so the budget is set on Etsy. Offsite Ads are a fee on each order they bring (12–15%) — they can't be switched off past $10k a year in sales.</div>
          </div>
          <a href={ADS_URL} target="_blank" rel="noreferrer" style={{ background: C.ink, color: C.surface, borderRadius: 10, padding: "10px 16px", fontWeight: 800, fontSize: 13, textDecoration: "none", whiteSpace: "nowrap" }}>Open Etsy Ads ↗</a>
        </div>
      )}

      {/* spend vs sales */}
      <Section title="Where the ad money goes, day by day" sub="Ad charges as bars, sales as the line. When the bars climb and the line doesn't, the extra spend isn't bringing sales.">
        <SpendChart days={m.days} />
      </Section>

      {/* actions */}
      <div>
        <div style={{ ...eyebrow, margin: "4px 2px 10px" }}>Do these to sell more — from your own numbers</div>
        <div style={grid(330)}>
          <ActionCard icon="📉" accent={C.red} title="Bestsellers gone quiet" rows={m.quiet}
            why="Sold 3+ times in six months, nothing in the last 3 weeks — yet still live. Check the price, photos and title against when it sold, and put Etsy Ads behind it."
            empty="None — every regular seller has sold in the last 3 weeks."
            render={r => <ListingRow key={r.id} r={r} note={`${r.units180} sold in 6 months · last ${Math.round((Date.now() - r.last) / DAY)} days ago · ${r.qty} in stock`} right={<b>{usd(r.priceUSD)}</b>} />} />
          <ActionCard icon="🚀" accent={C.green} title="Put ads behind these" rows={m.push}
            why="They sell well for the few people who see them (a high share of views turn into sales) but get few views. Ads bring views — these turn them into orders."
            empty="Nothing stands out yet."
            render={r => <ListingRow key={r.id} r={r} note={`${r.units180} sold · ${r.views.toLocaleString()} views · ${r.conv.toFixed(1)} sales per 1k views`} right={<b>{usd(r.priceUSD)}</b>} />} />
          <ActionCard icon="🕳️" accent={C.amber} title="Views, no sales" rows={m.wasted}
            why="Among the most-viewed in the shop, not one sale in six months. Take these off Etsy Ads — the clicks cost money — and fix the price or the first photo."
            empty="No high-traffic listing is going without sales."
            render={r => <ListingRow key={r.id} r={r} note={`${r.views.toLocaleString()} views · ${r.favs} favourites · 0 sold`} right={<b>{usd(r.priceUSD)}</b>} />} />
          <ActionCard icon="❤️" accent="#C2417A" title="Loved, not bought" rows={m.loved}
            why="People keep favouriting these but don't buy — usually the price. Send a sale to favouriters (Etsy → Marketing → Sales and discounts → targeted offer) or lower it a little."
            empty="Nothing here."
            render={r => <ListingRow key={r.id} r={r} note={`${r.favs} favourites from ${r.views.toLocaleString()} views`} right={<b>{usd(r.priceUSD)}</b>} />} />
          <ActionCard icon="📦" accent={C.blue} title="Restock before it runs out" rows={m.restock}
            why="Repeatable listings that sell, down to 3 or fewer on Etsy. A sold-out listing drops out of search and loses its ranking."
            empty="Every selling repeatable has stock."
            render={r => <ListingRow key={r.id} r={r} note={`${r.units180} sold in 6 months`} right={<b style={{ color: r.qty ? C.amber : C.red }}>{r.qty} left</b>} />} />
          <ActionCard icon="🎬" accent={C.purple || "#7A5AC8"} title="Sellers missing a video or photos" rows={m.polish}
            why="Proven sellers without a video or with fewer than 5 photos. Etsy shows listings with video more, and more photos convert better — the cheapest boost there is."
            empty="Every seller has a video and 5+ photos."
            render={r => <ListingRow key={r.id} r={r} note={`${r.units180} sold · ${r.photos} photos${r.video ? "" : " · no video"}`} right={<span style={{ display: "flex", gap: 4 }}>{!r.video && <Tag color={C.red} bg={C.redBg}>video</Tag>}{r.photos < 5 && <Tag color={C.amber} bg={C.amberBg}>photos</Tag>}</span>} />} />
        </div>
        {m.erpExpiredSold.length > 0 && (
          <div style={{ ...card, marginTop: 14, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", borderLeft: `5px solid ${C.amber}` }}>
            <span style={{ fontSize: 20 }}>♻️</span>
            <div style={{ flex: 1, minWidth: 220, fontSize: 13, color: C.ink }}><b>{m.erpExpiredSold.length} expired listing{m.erpExpiredSold.length === 1 ? "" : "s"} that sold in the last six months.</b> <span style={{ color: C.inkMid }}>Renewing a proven seller costs $0.20 and brings back its sales.</span></div>
            {onOpenRenew && <button onClick={onOpenRenew} style={{ background: C.ink, color: C.surface, border: "none", borderRadius: 10, padding: "9px 14px", fontWeight: 800, fontSize: 12.5, cursor: "pointer" }}>Open Renew →</button>}
          </div>
        )}
      </div>

      {/* top sellers */}
      <Section title={`Top sellers · last ${range} days`} sub="What brings the money in, against the period before. Sales per 1,000 views is how well a listing turns lookers into buyers (six months of sales over lifetime views)."
        right={<div style={{ display: "inline-flex", gap: 2, padding: 3, background: C.card, borderRadius: 9 }}>
          {[["rev", "Revenue"], ["units", "Units"], ["trend", "Change"], ["conv", "Converts"]].map(([k, l]) => (
            <button key={k} onClick={() => setSort(k)} style={{ border: "none", cursor: "pointer", fontSize: 11.5, fontWeight: 800, padding: "4px 10px", borderRadius: 7, background: sort === k ? C.surface : "transparent", color: sort === k ? C.ink : C.inkMid }}>{l}</button>
          ))}
        </div>}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, minWidth: 720 }}>
            <thead>
              <tr style={{ color: C.inkFaint, fontSize: 10.5, textTransform: "uppercase", letterSpacing: .6, textAlign: "right" }}>
                <th style={{ textAlign: "left", padding: "6px 4px" }}>Listing</th><th>Units</th><th>Revenue</th><th>Change</th><th>Views</th>{m.viewsSince && <th>Views 7d</th>}<th>Favs</th><th>Per 1k views</th><th>Stock</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, i) => (
                <tr key={r.id} style={{ borderTop: `1px solid ${C.border}`, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                  <td style={{ textAlign: "left", padding: "7px 4px" }}>
                    <a href={`https://www.etsy.com/listing/${r.id}`} target="_blank" rel="noreferrer" style={{ display: "flex", alignItems: "center", gap: 9, color: C.ink, textDecoration: "none" }}>
                      <span style={{ width: 18, color: C.inkFaint, fontWeight: 800, fontSize: 11 }}>{i + 1}</span>
                      <Thumb src={r.img} />
                      <span style={{ minWidth: 0 }}>
                        <span style={{ display: "block", fontWeight: 700, maxWidth: 320, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.title}</span>
                        <span style={{ display: "flex", gap: 4, marginTop: 2 }}>
                          {r.gone && <Tag color={C.red} bg={C.redBg}>not live</Tag>}
                          {!r.gone && !r.video && <Tag>no video</Tag>}
                          {r.shape && <Tag>{r.shape}</Tag>}
                        </span>
                      </span>
                    </a>
                  </td>
                  <td style={{ fontWeight: 800 }}>{r.units}</td>
                  <td style={{ fontWeight: 800 }}>{usd(r.rev)}</td>
                  <td>{r.revPrev > 0 ? <Delta now={r.rev} prev={r.revPrev} /> : r.rev > 0 ? <span style={{ color: C.green, fontWeight: 800, fontSize: 11.5 }}>new</span> : <span style={{ color: C.red, fontWeight: 800, fontSize: 11.5 }}>▼ 100%</span>}</td>
                  <td>{r.views != null ? r.views.toLocaleString() : "—"}</td>
                  {m.viewsSince && <td>{r.viewsWeek != null ? r.viewsWeek.toLocaleString() : "—"}</td>}
                  <td>{r.favs ?? "—"}</td>
                  <td>{r.conv ? r.conv.toFixed(1) : "—"}</td>
                  <td style={{ color: r.qty != null && r.qty <= 3 ? C.red : C.ink, fontWeight: r.qty <= 3 ? 800 : 400 }}>{r.qty ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!m.viewsSince && <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 8 }}>Views over the last 7 days appear here once a week of daily copies has built up (from today).</div>}
      </Section>

      <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr" : "1.4fr 1fr", gap: 14 }}>
        {/* shapes */}
        <Section title="What to list more of" sub={`By shape, last ${range} days. Revenue per live listing says where a new listing earns most — list more where it's high, fewer where it's low.`}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead><tr style={{ color: C.inkFaint, fontSize: 10.5, textTransform: "uppercase", letterSpacing: .6, textAlign: "right" }}><th style={{ textAlign: "left", padding: "5px 0" }}>Shape</th><th>Live</th><th>Units</th><th>Revenue</th><th>Per listing</th><th>Per 1k views</th></tr></thead>
            <tbody>
              {(() => { const best = Math.max(...m.shapes.map(s => s.perListing), 1); return m.shapes.slice(0, 14).map(s => (
                <tr key={s.shape} style={{ borderTop: `1px solid ${C.border}`, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                  <td style={{ textAlign: "left", padding: "7px 0", fontWeight: 700 }}>{s.shape}</td>
                  <td>{s.n}</td><td>{s.units}</td><td style={{ fontWeight: 800 }}>{usd(s.rev)}</td>
                  <td style={{ width: 130 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "flex-end" }}>
                      <div style={{ width: 60, height: 6, background: C.card, borderRadius: 3, overflow: "hidden" }}><div style={{ width: `${s.perListing / best * 100}%`, height: "100%", background: SALES }} /></div>
                      <b>{usd(s.perListing)}</b>
                    </div>
                  </td>
                  <td>{s.conv.toFixed(1)}</td>
                </tr>)); })()}
            </tbody>
          </table>
          <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 8 }}>{m.neverSold} of {m.live.length} live listings haven't sold in six months. "Unsorted" are Etsy listings not linked to the ERP or without a shape.</div>
        </Section>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {/* countries */}
          <Section title="Where buyers are" sub={`Last ${range} days`}>
            {m.countries.map(c => { const top = m.countries[0]?.usd || 1; return (
              <div key={c.c || "?"} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", fontSize: 12.5 }}>
                <span style={{ width: 22 }}>{flag(c.c)}</span>
                <span style={{ width: 34, fontWeight: 700 }}>{c.c || "?"}</span>
                <div style={{ flex: 1, height: 8, background: C.card, borderRadius: 4, overflow: "hidden" }}><div style={{ width: `${c.usd / top * 100}%`, height: "100%", background: SALES, opacity: .8 }} /></div>
                <span style={{ width: 60, textAlign: "right", fontWeight: 800 }}>{usd(c.usd)}</span>
                <span style={{ width: 54, textAlign: "right", color: C.inkMid }}>{c.orders} ord.</span>
              </div>); })}
            <div style={{ fontSize: 11.5, color: C.inkMid, marginTop: 8 }}>{pct(m.repeatShare)} of these orders came from buyers who've bought before.</div>
          </Section>
          {/* weeks */}
          <Section title="Week by week" sub="Ad charges against sales. Ads % rising week on week means the budget is outrunning what it brings.">
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead><tr style={{ color: C.inkFaint, fontSize: 10, textTransform: "uppercase", letterSpacing: .5, textAlign: "right" }}><th style={{ textAlign: "left" }}>Week of</th><th>Sales</th><th>Orders</th><th>Ads</th><th>Ads %</th></tr></thead>
              <tbody>
                {m.weeks.map(w => { const ad = w.etsy == null ? null : w.etsy + w.offsite, sh = ad != null && w.sales ? ad / w.sales : null; return (
                  <tr key={w.s} style={{ borderTop: `1px solid ${C.border}`, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    <td style={{ textAlign: "left", padding: "5px 0" }}>{new Date(w.s).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</td>
                    <td style={{ fontWeight: 800 }}>{usd(w.sales)}</td><td>{w.orders}</td><td>{ad == null ? "—" : usd(ad)}</td>
                    <td style={{ fontWeight: 800, color: sh == null ? C.inkFaint : sh < 0.1 ? C.green : sh < 0.18 ? C.amber : C.red }}>{pct(sh)}</td>
                  </tr>); })}
              </tbody>
            </table>
          </Section>
        </div>
      </div>
    </div>
  );
}
