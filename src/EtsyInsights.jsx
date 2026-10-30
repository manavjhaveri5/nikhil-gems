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

/* A listing in an action list: its Etsy page from the title, and what can be
   done about it right here — a new Etsy price (saved to the ERP listing and
   pushed to Etsy and the store, as on the grid), or set aside as dealt with. */
function ListingRow({ r, right, note, onPrice, onDone }) {
  const [edit, setEdit] = useState(false), [val, setVal] = useState(""), [saving, setSaving] = useState(false);
  const base = +r.erp?.price_etsy || r.price || 0; // the Etsy price, in the shop's rupees
  const save = async v => {
    const n = Math.round(+v);
    if (!(n > 0) || !r.erp) return;
    if (!confirm(`Change the Etsy price of "${r.title.slice(0, 60)}" from ₹${Math.round(base).toLocaleString("en-IN")} to ₹${n.toLocaleString("en-IN")}? It updates on Etsy (and the store) now.`)) return;
    setSaving(true);
    try { await onPrice(r.erp, n); setEdit(false); } finally { setSaving(false); }
  };
  const btn = { border: `1px solid ${C.border}`, background: C.surface, borderRadius: 7, padding: "3px 8px", fontSize: 11, fontWeight: 800, cursor: "pointer", color: C.ink };
  return (
    <div style={{ borderTop: `1px solid ${C.border}`, padding: "8px 0" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <Thumb src={r.img} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <a href={`https://www.etsy.com/listing/${r.id}`} target="_blank" rel="noreferrer" style={{ display: "block", fontSize: 12.5, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: C.ink, textDecoration: "none" }}>{r.title}</a>
          <div style={{ fontSize: 11, color: C.inkMid, marginTop: 2 }}>{note}</div>
        </div>
        <div style={{ flexShrink: 0, textAlign: "right", fontSize: 12 }}>{right}</div>
      </div>
      {(onPrice || onDone) && (
        <div style={{ display: "flex", gap: 6, marginTop: 6, paddingLeft: 50, flexWrap: "wrap", alignItems: "center" }}>
          {onPrice && r.erp && !edit && <button style={btn} onClick={() => { setVal(String(Math.round(base * 0.9))); setEdit(true); }}>₹ Change price</button>}
          {onPrice && !r.erp && <a href={`https://www.etsy.com/your/shops/me/listing-editor/edit/${r.id}`} target="_blank" rel="noreferrer" style={{ ...btn, textDecoration: "none" }}>Edit on Etsy ↗</a>}
          {edit && <>
            <span style={{ fontSize: 11, color: C.inkMid }}>now ₹{Math.round(base).toLocaleString("en-IN")}</span>
            {[10, 15, 20].map(p => <button key={p} style={btn} disabled={saving} onClick={() => setVal(String(Math.round(base * (1 - p / 100))))}>−{p}%</button>)}
            <input value={val} onChange={e => setVal(e.target.value.replace(/[^\d]/g, ""))} style={{ width: 80, border: `1px solid ${C.border}`, borderRadius: 7, padding: "3px 7px", fontSize: 12, background: C.surface, color: C.ink }} />
            <button style={{ ...btn, background: C.ink, color: C.surface, borderColor: C.ink }} disabled={saving} onClick={() => save(val)}>{saving ? "Saving…" : "Save"}</button>
            <button style={{ ...btn, border: "none", background: "none", color: C.inkMid }} onClick={() => setEdit(false)}>Cancel</button>
          </>}
          {onDone && !edit && <button style={{ ...btn, color: C.inkMid }} onClick={() => onDone(r.id)} title="Hide for 30 days">✓ Done</button>}
        </div>
      )}
    </div>
  );
}
/* One list of things to do. Five to a page; "Done" sets one aside for 30 days
   (on this device), so the list shrinks as the work gets done. */
const DONE_KEY = "ng-insights-done-v1";
const readDone = () => { try { return JSON.parse(localStorage.getItem(DONE_KEY) || "{}"); } catch { return {}; } };
function ActionCard({ id, icon, title, why, rows, render, empty, accent }) {
  const [done, setDone] = useState(readDone), [page, setPage] = useState(0);
  const fresh = rows.filter(r => !(done[`${id}:${r.id}`] > Date.now() - 30 * DAY));
  const pages = Math.max(1, Math.ceil(fresh.length / 5)), pg = Math.min(page, pages - 1);
  const markDone = rid => { const next = { ...readDone(), [`${id}:${rid}`]: Date.now() }; setDone(next); try { localStorage.setItem(DONE_KEY, JSON.stringify(next)); } catch { /* fine */ } };
  const nav = { border: `1px solid ${C.border}`, background: C.surface, borderRadius: 7, width: 28, height: 26, cursor: "pointer", fontWeight: 800, color: C.ink };
  return (
    <div style={{ ...card, borderTop: `3px solid ${accent}`, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 18 }}>{icon}</span>
        <div style={{ fontSize: 14.5, fontWeight: 800, color: C.ink, flex: 1 }}>{title}</div>
        <span style={{ fontSize: 12, fontWeight: 800, color: fresh.length ? accent : C.inkFaint }}>{fresh.length}</span>
      </div>
      <div style={{ fontSize: 11.5, color: C.inkMid, margin: "4px 0 6px", lineHeight: 1.45 }}>{why}</div>
      <div style={{ flex: 1 }}>{fresh.length ? fresh.slice(pg * 5, pg * 5 + 5).map(r => render(r, markDone)) : <div style={{ fontSize: 12, color: C.inkFaint, padding: "8px 0" }}>{empty}</div>}</div>
      {pages > 1 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, justifyContent: "flex-end", fontSize: 12, color: C.inkMid }}>
          <button style={nav} disabled={pg === 0} onClick={() => setPage(pg - 1)}>‹</button>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>Page {pg + 1} of {pages}</span>
          <button style={nav} disabled={pg >= pages - 1} onClick={() => setPage(pg + 1)}>›</button>
        </div>
      )}
    </div>
  );
}

/* ── The ad plan: what a click is worth, listing by listing ─────────────────
   Etsy Ads charges per click, and a click is a visit to the listing, so a
   listing pays for its ads when
       conversion × price × contribution  >  cost per click
   where contribution is what's left of a sale after the stone itself and
   Etsy's fees. Conversion is sales over views. Views are lifetime on Etsy, so
   the last six months' share is taken as views × 180 / age (to six months);
   sales are the last six months'. A listing's own rate is noisy on few views —
   0 sales from 200 views says little — so it's pulled toward the shop's
   average in proportion to how little it has to go on (a beta prior worth K
   views: shrunk = (sales + m·K) / (views + K)), and judged on an 80% range
   rather than the point: advertise when even the low end pays, stop when even
   the high end doesn't, test the rest. */
const PRIOR_VIEWS = 300, Z80 = 1.2816;
function adPlan(live, { margin, cpc, offsiteShare }) {
  const fees = 0.11 + offsiteShare; // Etsy's 6.5% + payment processing ~4% + the listing fee, and offsite fees spread over sales
  const contrib = Math.max(0.05, margin - fees);
  const rows = live.map(l => ({ ...l, v180: Math.max(l.units180, Math.round(l.views * Math.min(1, 180 / Math.max(1, l.age)))) }));
  const V = rows.reduce((a, r) => a + r.v180, 0), U = rows.reduce((a, r) => a + r.units180, 0);
  const m = V ? U / V : 0.005;
  const a0 = m * PRIOR_VIEWS;
  const out = rows.map(r => {
    const n = r.v180 + PRIOR_VIEWS, p = (r.units180 + a0) / n;
    const sd = Math.sqrt(p * (1 - p) / n);
    const lo = Math.max(0, p - Z80 * sd), hi = p + Z80 * sd;
    const per = r.priceUSD * contrib; // profit from one sale
    const worth = p * per, worthLo = lo * per, worthHi = hi * per; // value of one click
    const plan = worthLo > cpc ? "advertise" : worthHi < cpc && r.v180 >= 150 ? "stop" : per * m * 2 < cpc ? "stop" : "test";
    return { ...r, conv: p, convLo: lo, convHi: hi, worth, worthLo, worthHi, plan, perSale: per };
  });
  // Below this price a listing converting at twice the shop's rate still can't pay for a click.
  const floor = m > 0 ? cpc / (contrib * m * 2) : null;
  return { rows: out, m, contrib, floor, breakEvenRoas: 1 / contrib };
}

/* Weekly sales against weekly Etsy Ads spend: the slope is what an extra
   dollar of ads went with, in sales. Ordinary least squares with an 80% range
   from the t distribution. It reads association, not cause — busy weeks spend
   more because more shoppers click — so it errs high; a range that still
   straddles break-even means the data can't tell, and the budget test can. */
function slope(points) {
  const n = points.length;
  if (n < 5) return null;
  const mx = points.reduce((a, p) => a + p.x, 0) / n, my = points.reduce((a, p) => a + p.y, 0) / n;
  const sxx = points.reduce((a, p) => a + (p.x - mx) ** 2, 0);
  if (!(sxx > 0)) return null;
  const b = points.reduce((a, p) => a + (p.x - mx) * (p.y - my), 0) / sxx;
  const resid = points.reduce((a, p) => a + (p.y - (my + b * (p.x - mx))) ** 2, 0);
  const se = Math.sqrt(resid / (n - 2) / sxx);
  const t = [0, 0, 0, 1.638, 1.533, 1.476, 1.440, 1.415, 1.397, 1.383, 1.372, 1.363, 1.356, 1.350, 1.345][n - 2] || 1.31;
  const r = b * Math.sqrt(sxx / points.reduce((a, p) => a + (p.y - my) ** 2, 0));
  return { b, lo: b - t * se, hi: b + t * se, n, r };
}
// Welch's comparison of two runs of days: the gap in mean daily sales and its 80% range.
function compare(a, b) {
  const st = x => { const n = x.length, mu = x.reduce((s, v) => s + v, 0) / n; return { n, mu, v: x.reduce((s, v) => s + (v - mu) ** 2, 0) / Math.max(1, n - 1) }; };
  if (a.length < 4 || b.length < 4) return null;
  const A = st(a), B = st(b), se = Math.sqrt(A.v / A.n + B.v / B.n);
  return { diff: B.mu - A.mu, lo: B.mu - A.mu - Z80 * se, hi: B.mu - A.mu + Z80 * se, A, B };
}

/* The budget's own history, read from the daily Etsy Ads charges: binary
   segmentation splits the days wherever spend per day shifts for good (each run
   at least a week, the shift over 25% and well outside the day-to-day wobble). */
function budgetRuns(days, minLen = 7) {
  const mean = (i, j) => { let a = 0; for (let k = i; k < j; k++) a += days[k].etsy; return a / (j - i); };
  const vari = (i, j, mu) => { let a = 0; for (let k = i; k < j; k++) a += (days[k].etsy - mu) ** 2; return a / Math.max(1, j - i - 1); };
  const cuts = [];
  const split = (i, j) => {
    let best = null;
    for (let k = i + minLen; k <= j - minLen; k++) {
      const a = mean(i, k), b = mean(k, j);
      const se = Math.sqrt(vari(i, k, a) / (k - i) + vari(k, j, b) / (j - k)) || 1e-9;
      const t = Math.abs(b - a) / se;
      if (!best || t > best.t) best = { k, t, a, b };
    }
    if (!best) return;
    const rel = Math.abs(best.b - best.a) / Math.max(best.a, best.b, 1e-9);
    if (best.t < 3 || rel < 0.25 || Math.abs(best.b - best.a) < 0.5) return;
    cuts.push(best.k); split(i, best.k); split(best.k, j);
  };
  split(0, days.length);
  const edges = [0, ...cuts.sort((a, b) => a - b), days.length];
  return edges.slice(0, -1).map((a, i) => {
    const run = days.slice(a, edges[i + 1]);
    return { from: run[0].k, days: run, ads: run.reduce((x, d) => x + d.etsy, 0) / run.length, sales: run.reduce((x, d) => x + d.sales, 0) / run.length };
  });
}


/* Every budget change in the shop's life, and what sales did around it. The
   daily Etsy Ads charges are split into runs of steady spend (budgetRuns); at
   each change the four weeks before are set against the four weeks after.
   Pooled, with bigger changes counting more (a slope through the origin), that
   reads what an extra $1 a day of ads has brought in sales a day. Sales the
   Offsite Ads were charged on are taken out first (fee ÷ 15%), since those
   are paid per sale, not by the budget. */
function readHistory(hist) {
  if (!hist?.days?.length) return null;
  const today = dayKey(Date.now());
  const by = Object.fromEntries(hist.days.map(d => [d.k, d]));
  const first = hist.days.find(d => d.orders > 0 || d.etsy > 0)?.k || hist.days[0].k;
  const series = [];
  for (let t = Date.parse(first + "T12:00:00"); ; t += DAY) {
    const k = dayKey(t);
    if (k >= today) break;
    const d = by[k] || { etsy: 0, offsite: 0, sales: 0, orders: 0, fresh: 0 };
    series.push({ k, ms: dayStart(t), etsy: d.etsy, offsite: d.offsite, sales: d.sales, orders: d.orders, fresh: d.fresh, own: Math.max(0, d.sales - d.offsite / 0.15) });
  }
  if (series.length < 60) return null;
  const firstAds = series.findIndex(d => d.etsy > 0);
  const runs = firstAds < 0 ? [] : budgetRuns(series.slice(firstAds), 10);
  const mean = (a, f) => a.reduce((s2, d) => s2 + f(d), 0) / Math.max(1, a.length);
  const events = [];
  for (let i = 1; i < runs.length; i++) {
    const before = runs[i - 1].days.slice(-28), after = runs[i].days.slice(0, 28);
    if (before.length < 7 || after.length < 7) continue;
    const a0 = mean(before, d => d.etsy), a1 = mean(after, d => d.etsy), s0 = mean(before, d => d.own), s1 = mean(after, d => d.own);
    events.push({ k: runs[i].from, a0, a1, s0, s1, da: a1 - a0, ds: s1 - s0 });
  }
  const pool = ev => {
    if (ev.length < 3) return null;
    const sxx = ev.reduce((s2, e) => s2 + e.da * e.da, 0), b = ev.reduce((s2, e) => s2 + e.da * e.ds, 0) / sxx;
    const rss = ev.reduce((s2, e) => s2 + (e.ds - b * e.da) ** 2, 0), se = Math.sqrt(rss / (ev.length - 1) / sxx);
    return { b, lo: b - Z80 * se, hi: b + Z80 * se, n: ev.length };
  };
  const yearAgo = dayKey(Date.now() - 365 * DAY);
  const recentEv = events.filter(e => e.k >= yearAgo);
  // Month by month, for the picture.
  const months = [];
  for (const d of series) {
    const k = d.k.slice(0, 7);
    let mo = months[months.length - 1];
    if (!mo || mo.k !== k) months.push(mo = { k, etsy: 0, offsite: 0, sales: 0, orders: 0, fresh: 0, n: 0 });
    mo.etsy += d.etsy; mo.offsite += d.offsite; mo.sales += d.sales; mo.orders += d.orders; mo.fresh += d.fresh; mo.n++;
  }
  // Are the ads running? The last day with a charge, against the month before it.
  let lastCharge = null;
  for (let i = series.length - 1; i >= 0; i--) if (series[i].etsy > 0) { lastCharge = series[i]; break; }
  const quietDays = lastCharge ? series.length - 1 - series.indexOf(lastCharge) : series.length;
  const before30 = lastCharge ? mean(series.slice(Math.max(0, series.indexOf(lastCharge) - 29), series.indexOf(lastCharge) + 1), d => d.etsy) : 0;
  const yr = series.filter(d => d.k >= yearAgo), onDays = yr.filter(d => d.etsy > 0);
  const fresh14 = series.slice(-14).reduce((s2, d) => s2 + d.fresh, 0), fresh90 = series.slice(-104, -14).reduce((s2, d) => s2 + d.fresh, 0) / 90 * 14;
  return {
    series, runs, events, months, all: pool(events), recent: pool(recentEv), recentN: recentEv.length,
    lastCharge, quietDays, before30, onPerDay: mean(onDays, d => d.etsy),
    total: { etsy: series.reduce((s2, d) => s2 + d.etsy, 0), offsite: series.reduce((s2, d) => s2 + d.offsite, 0), sales: series.reduce((s2, d) => s2 + d.sales, 0) },
    year: { etsy: yr.reduce((s2, d) => s2 + d.etsy, 0), sales: yr.reduce((s2, d) => s2 + d.sales, 0), offsite: yr.reduce((s2, d) => s2 + d.offsite, 0) },
    fresh14, fresh90,
  };
}

function MonthChart({ months }) {
  const [hover, setHover] = useState(null);
  const W = 1000, H = 250, PL = 46, PR = 46, PT = 12, PB = 26, CW = W - PL - PR, CH = H - PT - PB, n = months.length;
  const sMax = niceMax(Math.max(1, ...months.map(m => m.sales)) * 1.05), aMax = niceMax(Math.max(1, ...months.map(m => m.etsy)) * 1.05);
  const slot = CW / Math.max(1, n), bw = Math.max(2, slot * 0.66);
  const x = i => PL + i * slot + slot / 2, yS = v => PT + CH * (1 - v / sMax), yA = v => PT + CH * (1 - v / aMax);
  const line = months.map((m, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${yA(m.etsy).toFixed(1)}`).join("");
  const h = hover != null ? months[hover] : null;
  return (
    <div style={{ position: "relative" }}>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 11.5, color: C.inkMid, marginBottom: 6 }}>
        <span><i style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: SALES, opacity: .8, marginRight: 5 }} />Sales a month (left scale)</span>
        <span><i style={{ display: "inline-block", width: 14, height: 2.5, background: ETSYADS, marginRight: 5, verticalAlign: "middle" }} />Etsy Ads spend a month (right scale)</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block", touchAction: "pan-y" }}
        onPointerMove={e => { const r = e.currentTarget.getBoundingClientRect(); const i = Math.floor(((e.clientX - r.left) / r.width * W - PL) / slot); setHover(i >= 0 && i < n ? i : null); }}
        onPointerLeave={() => setHover(null)}>
        {[0.25, 0.5, 0.75, 1].map(t => (
          <g key={t}>
            <line x1={PL} x2={W - PR} y1={yS(t * sMax)} y2={yS(t * sMax)} stroke={C.border} />
            <text x={PL - 6} y={yS(t * sMax) + 4} textAnchor="end" fontSize={11} fill={C.inkFaint}>{usdK(t * sMax)}</text>
            <text x={W - PR + 6} y={yA(t * aMax) + 4} fontSize={11} fill={ETSYADS}>{usdK(t * aMax)}</text>
          </g>
        ))}
        {hover != null && <rect x={PL + hover * slot} y={PT} width={slot} height={CH} fill={C.card} />}
        {months.map((m, i) => <rect key={m.k} x={x(i) - bw / 2} y={yS(m.sales)} width={bw} height={yS(0) - yS(m.sales)} fill={SALES} opacity={hover === i ? 1 : .72} rx={1.5} />)}
        <path d={line} fill="none" stroke={ETSYADS} strokeWidth={2.5} strokeLinejoin="round" />
        {months.map((m, i) => m.k.endsWith("-01") && <text key={m.k} x={x(i)} y={H - 8} textAnchor="middle" fontSize={11} fill={C.inkFaint}>{m.k.slice(0, 4)}</text>)}
      </svg>
      {h && (
        <div style={{ position: "absolute", top: 26, left: `${Math.min(70, Math.max(2, (x(hover) / W) * 100 - 10))}%`, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 9, padding: "8px 10px", fontSize: 12, boxShadow: "0 4px 14px rgba(0,0,0,.08)", pointerEvents: "none", minWidth: 170 }}>
          <div style={{ fontWeight: 800, color: C.ink, marginBottom: 3 }}>{new Date(h.k + "-01T00:00:00").toLocaleDateString("en-GB", { month: "long", year: "numeric" })}</div>
          <div>Sales <b>{usd(h.sales)}</b> · {h.orders} orders</div>
          <div style={{ color: ETSYADS }}>Etsy Ads <b>{usd(h.etsy)}</b> ({usd2(h.etsy / h.n)}/day)</div>
          <div style={{ color: OFFSITE }}>Offsite fees {usd(h.offsite)}</div>
          <div style={{ color: C.inkMid }}>Listed or renewed: {h.fresh}</div>
        </div>
      )}
    </div>
  );
}

function AdHistory({ h, be, busy, error }) {
  const [pg, setPg] = useState(0);
  if (!h) return (
    <Section title="Six years of ads: what actually worked" sub="Every Etsy Ads charge and every order since the shop opened.">
      <div style={{ fontSize: 13, color: error ? C.red : C.inkMid }}>{error ? `Couldn't read the history: ${error}` : "Reading the shop's whole history from Etsy, which takes about a minute the first time…"}</div>
    </Section>
  );
  const est = h.recent && h.recentN >= 4 ? h.recent : h.all, estLabel = est === h.recent ? "the last 12 months" : "all years";
  const verdict = !est ? null
    : est.lo > be ? { tone: C.green, bg: C.greenBg, head: `Ads pay. Each extra $1 has brought about ${usd2(est.b)} in sales`, body: `Over ${estLabel}, every time the budget went up sales rose with it, and every time it came down they fell: ${usd2(est.b)} a dollar (80% range ${usd2(est.lo)}–${usd2(est.hi)}), above the ${usd2(be)} a dollar has to bring back to break even. Keep them on, at about ${usd2(Math.max(5, h.onPerDay))}/day (your average this year on days they ran) or more.` }
    : est.hi < be ? { tone: C.red, bg: C.redBg, head: `Ads haven't paid: about ${usd2(est.b)} back per $1`, body: `Over ${estLabel}, budget changes moved sales by about ${usd2(est.b)} per extra $1 (80% range ${usd2(est.lo)}–${usd2(est.hi)}), under the ${usd2(be)} break-even. Keep a small budget on the "Advertise" listings only.` }
    : { tone: C.amber, bg: C.amberBg, head: `Ads about break even: ${usd2(est.b)} back per $1`, body: `Over ${estLabel}, budget changes moved sales by about ${usd2(est.b)} per extra $1 (80% range ${usd2(est.lo)}–${usd2(est.hi)}), with ${usd2(be)} needed to break even. They're not losing money, but more budget won't pay much more. Point them at the "Advertise" listings below.` };
  const off = h.lastCharge && h.quietDays >= 3 && h.before30 > 1;
  const ev = [...h.events].reverse(), per = 8, pages = Math.max(1, Math.ceil(ev.length / per)), p = Math.min(pg, pages - 1);
  const fmtDay = k => new Date(k + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  return (
    <Section title="Six years of ads: what actually worked" sub={`Every Etsy Ads charge, Offsite Ads fee and order since ${fmtDay(h.series[0].k)}, read straight from Etsy and kept up to date by itself.${busy ? " Updating…" : ""}`}>
      {off && (
        <div style={{ background: C.redBg, color: C.red, borderRadius: 10, padding: "10px 12px", fontSize: 13, fontWeight: 700, marginBottom: 12, lineHeight: 1.5 }}>
          ⚠️ Etsy Ads haven't charged anything since {fmtDay(h.lastCharge.k)} ({h.quietDays} days), after about {usd2(h.before30)}/day the month before. They're switched off or the budget is used up. Check Etsy → Marketing → Etsy Ads.
        </div>
      )}
      {h.fresh90 > 20 && h.fresh14 < h.fresh90 * 0.35 && (
        <div style={{ background: C.amberBg, color: C.ink, borderRadius: 10, padding: "10px 12px", fontSize: 13, marginBottom: 12, lineHeight: 1.5 }}>
          <b>Listing and renewing have nearly stopped:</b> {h.fresh14} listings put up or renewed in the last two weeks, against about {Math.round(h.fresh90)} in a usual two weeks before that. A renewed or new listing gets a fresh start in Etsy search, and your record months (Mar–Apr 2026) were the months you listed and renewed most.
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr 1fr" : "repeat(4, 1fr)", gap: 10, marginBottom: 14 }}>
        <Kpi label="Each extra $1 of ads brought" value={est ? usd2(est.b) : "—"} sub={est ? `in sales · 80% range ${usd2(est.lo)}–${usd2(est.hi)} · ${estLabel}` : "not enough budget changes yet"} tone={verdict?.bg} />
        <Kpi label="Break-even" value={usd2(be)} sub="sales a $1 of ads must bring back" />
        <Kpi label="Etsy Ads, last 12 months" value={usd(h.year.etsy)} sub={`${usd(h.year.sales)} sales · ads ${h.year.sales ? (h.year.etsy / h.year.sales * 100).toFixed(1) : 0}% of sales`} />
        <Kpi label="Since the shop opened" value={usd(h.total.etsy + h.total.offsite)} sub={`on ads (${usd(h.total.etsy)} Etsy Ads, ${usd(h.total.offsite)} Offsite) · ${usd(h.total.sales)} sales`} />
      </div>
      {verdict && (
        <div style={{ borderLeft: `4px solid ${verdict.tone}`, background: C.card, borderRadius: 10, padding: "10px 14px", marginBottom: 14 }}>
          <div style={{ fontWeight: 800, color: verdict.tone, fontSize: 14.5 }}>{verdict.head}</div>
          <div style={{ fontSize: 12.5, color: C.ink, marginTop: 4, lineHeight: 1.55, maxWidth: 900 }}>{verdict.body}{h.all && est !== h.all && <> Across all years together it's {usd2(h.all.b)} per $1 ({h.all.n} changes); the shop is a lot bigger now, so the recent figure is the one to go by.</>}</div>
        </div>
      )}
      <MonthChart months={h.months} />
      <div style={{ fontSize: 15, fontWeight: 800, color: C.ink, margin: "18px 0 4px" }}>Every budget change, and what sales did</div>
      <div style={{ fontSize: 12, color: C.inkMid, marginBottom: 8, lineHeight: 1.5, maxWidth: 860 }}>Found in the daily charges: each time the spend shifted for good, the four weeks before are compared with the four weeks after. One change on its own can be thrown by anything (a big order, the season), so the figure above pools all of them, with bigger changes counting more.</div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", minWidth: 560, borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead><tr style={{ color: C.inkFaint, fontSize: 10.5, textTransform: "uppercase", letterSpacing: .6, textAlign: "right" }}><th style={{ textAlign: "left" }}>Changed on</th><th>Ads/day</th><th>Sales/day</th><th>Sales per extra $1</th></tr></thead>
          <tbody>{ev.slice(p * per, p * per + per).map(e => {
            const r = Math.abs(e.da) >= 2 ? e.ds / e.da : null;
            return (
              <tr key={e.k} style={{ borderTop: `1px solid ${C.border}`, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                <td style={{ textAlign: "left", padding: "6px 0" }}>{fmtDay(e.k)} <span style={{ color: e.da > 0 ? C.green : C.red, fontWeight: 800 }}>{e.da > 0 ? "▲ up" : "▼ down"}</span></td>
                <td>{usd2(e.a0)} → <b>{usd2(e.a1)}</b></td>
                <td>{usd(e.s0)} → <b>{usd(e.s1)}</b></td>
                <td style={{ fontWeight: 800, color: r == null ? C.inkFaint : r >= be ? C.green : r > 0 ? C.amber : C.red }}>{r == null ? "too small to read" : usd2(r)}</td>
              </tr>);
          })}</tbody>
        </table>
      </div>
      {pages > 1 && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "flex-end", marginTop: 8, fontSize: 12, color: C.inkMid }}>
          <button onClick={() => setPg(p - 1)} disabled={p === 0} style={{ border: `1px solid ${C.border}`, background: C.surface, borderRadius: 7, width: 28, height: 26, cursor: "pointer" }}>‹</button>
          <span>Page {p + 1} of {pages}</span>
          <button onClick={() => setPg(p + 1)} disabled={p >= pages - 1} style={{ border: `1px solid ${C.border}`, background: C.surface, borderRadius: 7, width: 28, height: 26, cursor: "pointer" }}>›</button>
        </div>
      )}
    </Section>
  );
}

/* What sells: every order line since the shop opened, put against what's on
   sale now. Price bands, kinds of piece (read from the title), exact against
   similar (the ERP's type, else the title), the big statement sales, and the
   buyers who come back. */
const KINDS = [["Cluster / specimen", /cluster|druse|geode|cathedral|specimen|mineral|matrix|formation/i], ["Sphere", /sphere|\bball\b|\borb\b/i],
  ["Jewellery", /pendant|necklace|\bring\b|earring|bracelet|bead|mala|jewel/i], ["Point / tower", /point|tower|obelisk|wand|generator|pyramid|vogel/i],
  ["Bowl / carving", /bowl|dish|carving|carved|skull|buddha|ganesh|lingam|shivling|bottle|sculpture/i], ["Palm / heart / tumble", /palm|heart|tumble|worry|egg|pocket/i],
  ["Slab / slice", /slab|slice|plate/i], ["Raw / rough", /\braw\b|rough/i]];
const kindOf = t => (KINDS.find(([, re]) => re.test(t)) || ["Other"])[0];
const SIMILAR = /similar|you will receive|you'll receive|choose|set of|\blot\b|bulk|wholesale|random|intuitively|assorted/i;
const BANDS = [["Under $25", 0, 25], ["$25–75", 25, 75], ["$75–150", 75, 150], ["$150–300", 150, 300], ["$300 and up", 300, Infinity]];
const bandOf = p => BANDS.findIndex(([, a, b]) => p >= a && p < b);

function WhatSells({ hist, live, erpListings }) {
  const [span, setSpan] = useState(365), [bigPg, setBigPg] = useState(0);
  const r = useMemo(() => {
    const lines = hist?.lines;
    if (!lines?.length) return null;
    const erp = {};
    for (const l of erpListings || []) { const id = l.platforms?.etsy?.listing_id; if (id) erp[String(id)] = l; }
    const since = span ? dayKey(Date.now() - span * DAY) : "";
    const typeOf = x => erp[x.lid]?.type || live.find(l => l.id === x.lid)?.type || (SIMILAR.test(x.title) ? "repeatable" : "unique");
    const rows = lines.filter(x => x.k >= since).map(x => ({ ...x, rev: x.price * x.qty, band: bandOf(x.price), kind: kindOf(x.title), type: typeOf(x) === "repeatable" ? "similar" : "exact" }));
    const total = rows.reduce((s2, x) => s2 + x.rev, 0) || 1;
    const yrs = Math.max(1 / 12, Math.min(span || 9999, (Date.now() - Date.parse(lines[0].k)) / DAY) / 365);
    const group = (key, inv) => {
      const g = {};
      for (const x of rows) { const k = key(x); (g[k] ||= { k, rev: 0, units: 0 }); g[k].rev += x.rev; g[k].units += x.qty; }
      for (const l of live) { const k = inv(l); if (k == null) continue; (g[k] ||= { k, rev: 0, units: 0 }); g[k].live = (g[k].live || 0) + 1; }
      return Object.values(g).map(v => ({ ...v, share: v.rev / total, perListing: v.live ? v.rev / v.live / yrs : null }));
    };
    const bands = group(x => x.band, l => bandOf(l.priceUSD)).sort((a, b) => a.k - b.k);
    const kinds = group(x => x.kind, l => kindOf(l.title)).sort((a, b) => b.rev - a.rev);
    const types = group(x => x.type, l => (l.type === "repeatable" ? "similar" : "exact")).sort((a, b) => b.rev - a.rev);
    // Orders: their value, and the share the big ones bring.
    const orders = {};
    for (const x of rows) { const o = (orders[x.rid] ||= { rid: x.rid, k: x.k, v: 0, buyer: x.buyer, name: x.name, country: x.country }); o.v += x.rev; }
    const ov = Object.values(orders).sort((a, b) => a.v - b.v);
    const median = ov.length ? ov[Math.floor(ov.length / 2)].v : 0;
    const bigOrders = ov.filter(o => o.v >= 300);
    // Average order a quarter, whole history, to show the drift.
    const q = {};
    for (const x of lines) { const k = `${x.k.slice(0, 4)} Q${Math.floor((+x.k.slice(5, 7) - 1) / 3) + 1}`; const e = (q[k] ||= { k, v: 0, ids: new Set(), big: 0 }); e.v += x.price * x.qty; e.ids.add(x.rid); if (x.price >= 300) e.big += x.price * x.qty; }
    const quarters = Object.values(q).map(e => ({ k: e.k, v: e.v, n: e.ids.size, aov: e.v / e.ids.size, bigShare: e.big / (e.v || 1) })).slice(-10);
    // Buyers who came back.
    const by = {};
    for (const o of Object.values(orders)) { if (!o.buyer) continue; const b = (by[o.buyer] ||= { name: o.name, country: o.country, n: 0, v: 0, last: "" }); b.n++; b.v += o.v; if (o.k > b.last) b.last = o.k; }
    const buyers = Object.values(by), repeat = buyers.filter(b => b.n > 1);
    const repeatRev = repeat.reduce((s2, b) => s2 + b.v, 0);
    const big = rows.filter(x => x.price >= 300).sort((a, b) => b.price - a.price);
    return { rows, total, bands, kinds, types, median, nOrders: ov.length, bigOrders, bigRev: bigOrders.reduce((s2, o) => s2 + o.v, 0), quarters, buyers, repeat: repeat.sort((a, b) => b.v - a.v), repeatRev, big };
  }, [hist, live, erpListings, span]);

  if (!r) return null;
  const pct = v => `${Math.round(v * 100)}%`;
  const top = r.bands[r.bands.length - 1], low = r.bands[0];
  const bestKind = [...r.kinds].filter(k => k.live >= 5 && k.perListing != null).sort((a, b) => b.perListing - a.perListing)[0];
  const exact = r.types.find(t => t.k === "exact"), similar = r.types.find(t => t.k === "similar");
  const qa = r.quarters, q0 = qa[Math.max(0, qa.length - 6)], q1 = qa[qa.length - 1];
  const takeaways = [
    top && `Pieces of $300 and up are ${pct(top.share)} of sales from ${top.units} sales. A listing in that band earns about ${usd(top.perListing)} a year, against ${usd(low?.perListing)} for one under $25.`,
    exact && similar && `Exact pieces bring ${pct(exact.share)} of the money at about ${usd(exact.rev / Math.max(1, exact.units))} each; similar pieces bring ${pct(similar.share)} at about ${usd(similar.rev / Math.max(1, similar.units))}, but ${pct(similar.units / (exact.units + similar.units))} of the units.`,
    bestKind && `${bestKind.k} earns the most per listing: about ${usd(bestKind.perListing)} a year each, with ${bestKind.live} live now.`,
    q0 && q1 && q0 !== q1 && `Average order: ${usd(q0.aov)} in ${q0.k}, ${usd(q1.aov)} in ${q1.k}, while orders went from ${q0.n} to ${q1.n} a quarter.`,
    r.repeat.length > 0 && `${r.repeat.length} buyers came back for more; together they're ${pct(r.repeatRev / r.total)} of sales.`,
  ].filter(Boolean);
  const th = { color: C.inkFaint, fontSize: 10.5, textTransform: "uppercase", letterSpacing: .6, textAlign: "right", fontWeight: 800, padding: "0 0 6px 8px" };
  const td = { padding: "6px 0 6px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums", borderTop: `1px solid ${C.border}` };
  const Bar = ({ v, col = SALES }) => <div style={{ height: 6, borderRadius: 3, background: C.card, minWidth: 60 }}><div style={{ width: `${Math.min(100, v * 100)}%`, height: 6, borderRadius: 3, background: col }} /></div>;
  const Table = ({ head, rows: rs, label }) => (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", minWidth: 560, borderCollapse: "collapse", fontSize: 12.5 }}>
        <thead><tr><th style={{ ...th, textAlign: "left", paddingLeft: 0 }}>{head}</th><th style={th}>Sales</th><th style={{ ...th, width: "18%" }}>Share</th><th style={th}>Sold</th><th style={th}>Avg</th><th style={th}>Live now</th><th style={th}>A listing earns/yr</th></tr></thead>
        <tbody>{rs.map(b => (
          <tr key={b.k}>
            <td style={{ ...td, textAlign: "left", paddingLeft: 0, fontWeight: 700 }}>{label(b)}</td>
            <td style={{ ...td, fontWeight: 800 }}>{usd(b.rev)}</td>
            <td style={td}><div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "flex-end" }}><Bar v={b.share} /><span style={{ width: 32 }}>{pct(b.share)}</span></div></td>
            <td style={td}>{b.units}</td><td style={td}>{b.units ? usd(b.rev / b.units) : "—"}</td><td style={td}>{b.live || 0}</td>
            <td style={{ ...td, fontWeight: 800, color: C.ink }}>{b.perListing != null ? usd(b.perListing) : "—"}</td>
          </tr>))}</tbody>
      </table>
    </div>
  );
  const per = 8, bigPages = Math.max(1, Math.ceil(r.big.length / per)), bp = Math.min(bigPg, bigPages - 1);
  const fmt = k => new Date(k + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const sub = { fontSize: 15, fontWeight: 800, color: C.ink, margin: "20px 0 6px" };
  return (
    <Section title="What sells" sub="Every order since the shop opened, against what's on sale now. “A listing earns” is that group's sales over the period, per listing live now, per year."
      right={<div style={{ display: "flex", gap: 4 }}>{[[365, "12 months"], [730, "2 years"], [0, "All years"]].map(([v, l]) => (
        <button key={v} onClick={() => setSpan(v)} style={{ border: `1px solid ${span === v ? C.ink : C.border}`, background: span === v ? C.ink : C.surface, color: span === v ? C.surface : C.inkMid, borderRadius: 8, padding: "5px 10px", fontSize: 12, fontWeight: 800, cursor: "pointer" }}>{l}</button>))}</div>}>
      <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr 1fr" : "repeat(4, 1fr)", gap: 10, marginBottom: 14 }}>
        <Kpi label="From $300+ orders" value={pct(r.bigRev / r.total)} sub={`${r.bigOrders.length} of ${r.nOrders} orders`} />
        <Kpi label="Middle order" value={usd(r.median)} sub={`half of orders are under this · ${usd(r.total)} in all`} />
        <Kpi label="Exact pieces" value={exact ? pct(exact.share) : "—"} sub={`of sales · similar pieces ${similar ? pct(similar.share) : "—"}`} />
        <Kpi label="Buyers who came back" value={pct(r.repeatRev / r.total)} sub={`of sales · ${r.repeat.length} of ${r.buyers.length} buyers`} />
      </div>
      <div style={{ background: C.card, borderRadius: 10, padding: "10px 14px", fontSize: 13, color: C.ink, lineHeight: 1.6 }}>
        {takeaways.map((t, i) => <div key={i}>• {t}</div>)}
      </div>

      <div style={sub}>By price</div>
      <Table head="Price of the piece" rows={r.bands} label={b => BANDS[b.k]?.[0] || "?"} />
      <div style={sub}>By kind of piece</div>
      <Table head="Kind (from the title)" rows={r.kinds} label={b => b.k} />
      <div style={sub}>Exact piece or similar piece</div>
      <Table head="Listing" rows={r.types} label={b => b.k === "exact" ? "Exact piece (you get this one)" : "Similar piece (one like it)"} />

      <div style={sub}>Order size, quarter by quarter</div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", minWidth: 480, borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead><tr><th style={{ ...th, textAlign: "left", paddingLeft: 0 }}>Quarter</th><th style={th}>Orders</th><th style={th}>Sales</th><th style={th}>Average order</th><th style={th}>From $300+ pieces</th></tr></thead>
          <tbody>{[...r.quarters].reverse().map(e => (
            <tr key={e.k}><td style={{ ...td, textAlign: "left", paddingLeft: 0, fontWeight: 700 }}>{e.k}</td><td style={td}>{e.n}</td><td style={td}>{usd(e.v)}</td><td style={{ ...td, fontWeight: 800 }}>{usd(e.aov)}</td><td style={td}>{pct(e.bigShare)}</td></tr>))}</tbody>
        </table>
      </div>

      <div style={sub}>The statement pieces that sold</div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", minWidth: 480, borderCollapse: "collapse", fontSize: 12.5 }}>
          <tbody>{r.big.slice(bp * per, bp * per + per).map((x, i) => (
            <tr key={x.rid + x.lid + i}><td style={{ ...td, textAlign: "left", paddingLeft: 0, color: C.inkMid, whiteSpace: "nowrap" }}>{fmt(x.k)}</td><td style={{ ...td, textAlign: "left" }}>{x.title}</td><td style={{ ...td, color: C.inkMid }}>{x.kind}</td><td style={{ ...td, fontWeight: 800 }}>{usd(x.price)}</td></tr>))}</tbody>
        </table>
      </div>
      {bigPages > 1 && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "flex-end", marginTop: 8, fontSize: 12, color: C.inkMid }}>
          <button onClick={() => setBigPg(bp - 1)} disabled={bp === 0} style={{ border: `1px solid ${C.border}`, background: C.surface, borderRadius: 7, width: 28, height: 26, cursor: "pointer" }}>‹</button>
          <span>Page {bp + 1} of {bigPages}</span>
          <button onClick={() => setBigPg(bp + 1)} disabled={bp >= bigPages - 1} style={{ border: `1px solid ${C.border}`, background: C.surface, borderRadius: 7, width: 28, height: 26, cursor: "pointer" }}>›</button>
        </div>
      )}

      {r.repeat.length > 0 && <>
        <div style={sub}>Your best returning buyers</div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", minWidth: 420, borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead><tr><th style={{ ...th, textAlign: "left", paddingLeft: 0 }}>Buyer</th><th style={th}>Orders</th><th style={th}>Spent</th><th style={th}>Last order</th></tr></thead>
            <tbody>{r.repeat.slice(0, 10).map((b, i) => (
              <tr key={i}><td style={{ ...td, textAlign: "left", paddingLeft: 0, fontWeight: 700 }}>{b.name || "—"} <span style={{ color: C.inkFaint, fontWeight: 400 }}>{b.country}</span></td><td style={td}>{b.n}</td><td style={{ ...td, fontWeight: 800 }}>{usd(b.v)}</td><td style={td}>{fmt(b.last)}</td></tr>))}</tbody>
          </table>
        </div>
      </>}
    </Section>
  );
}

const ASSUME_KEY = "ng-insights-assume-v1";
const readAssume = () => { try { return { margin: 0.6, cpc: 0.25, ...JSON.parse(localStorage.getItem(ASSUME_KEY) || "{}") }; } catch { return { margin: 0.6, cpc: 0.25 }; } };

function AdStrategy({ m, onPrice, hist }) {
  const [as, setAs] = useState(readAssume);
  const [show, setShow] = useState("advertise"), [page, setPage] = useState(0);
  const setA = (k, v) => { const next = { ...as, [k]: v }; setAs(next); try { localStorage.setItem(ASSUME_KEY, JSON.stringify(next)); } catch { /* fine */ } };

  const plan = useMemo(() => adPlan(m.live, { margin: as.margin, cpc: as.cpc, offsiteShare: m.offsiteShare }), [m, as]);
  const groups = { advertise: [], test: [], stop: [] };
  plan.rows.forEach(r => groups[r.plan].push(r));
  groups.advertise.sort((a, b) => (b.worth - as.cpc) - (a.worth - as.cpc));
  groups.stop.sort((a, b) => b.v180 - a.v180);
  groups.test.sort((a, b) => b.worth - a.worth);

  // Weeks with ads known (the ledger reaches back 90 days), oldest first.
  const pts = m.weeks.filter(w => w.etsy != null).map(w => ({ x: w.etsy, y: w.sales - w.offsiteSales }));
  const be = plan.breakEvenRoas;
  const h = useMemo(() => readHistory(hist), [hist]);
  // The whole history's budget changes when there are enough; else the last 90 days' weeks.
  const fit = h?.recent && h.recentN >= 4 ? h.recent : slope(pts);
  const perDay = Math.max(m.etsyAds28 / 28, m.etsyAds28 < 7 && h ? h.onPerDay : 0);
  const call = !fit ? { tone: C.inkMid, head: "Not enough weeks of ad data yet", body: "Keep the budget steady for now; the call firms up as weeks build." }
    : fit.lo > be ? { tone: C.green, head: `Raise the budget — to about ${usd2(perDay * 1.3)}/day`, body: `More Etsy Ads has gone with more sales: about ${usd2(fit.b)} per extra $1 (80% range ${usd2(fit.lo)}–${usd2(fit.hi)}), above the ${usd2(be)} a dollar has to bring back to break even. Raise it 30%, keep it there two weeks, and the budget test below reads whether the gain holds.` }
    : fit.hi < be ? { tone: C.red, head: `Cut the budget — to about ${usd2(Math.max(1, perDay * 0.6))}/day, on the "Advertise" listings only`, body: `Extra ad money hasn't been bringing enough back: about ${usd2(fit.b)} in sales per extra $1 (80% range ${usd2(fit.lo)}–${usd2(fit.hi)}), below the ${usd2(be)} break-even. Turn ads off the "Stop" listings in Etsy Ads, and lower the budget.` }
    : { tone: C.amber, head: `Too close to call from the history — run a budget test`, body: `More ads has gone with about ${usd2(fit.b)} more sales per $1, but the 80% range (${usd2(fit.lo)}–${usd2(fit.hi)}) straddles the ${usd2(be)} break-even, so the past can't settle it. Point the ads at the "Advertise" listings, then alternate two budgets — ${usd2(Math.max(1, perDay * 0.6))}/day and ${usd2(perDay * 1.4)}/day — two weeks each. The budget test below spots each change in the ad charges by itself and reads the answer from your own sales.` };

  // Budget test: runs of steady spend found in the daily charges (today's still filling, so left out), the last two compared.
  const periods = useMemo(() => {
    const today = dayStart(Date.now());
    const ds = h ? h.series.slice(-180) : m.daily90.filter(d => d.ms < today);
    return ds.length >= 14 ? budgetRuns(ds) : [];
  }, [m, h]);
  const lastTwo = periods.slice(-2);
  const test = lastTwo.length === 2 ? compare(lastTwo[0].days.map(d => d.sales), lastTwo[1].days.map(d => d.sales)) : null;
  const dAds = lastTwo.length === 2 ? lastTwo[1].ads - lastTwo[0].ads : 0;
  const cur = periods[periods.length - 1];
  const nextStep = !cur ? null : (() => {
    const held = cur.days.length;
    const wasHigher = lastTwo.length === 2 && cur.ads > lastTwo[0].ads;
    const to = wasHigher ? Math.max(1, cur.ads * 0.6) : Math.max(1, cur.ads * 1.4);
    if (cur.ads < 0.5) return `Etsy Ads are off: nothing has been charged for ${held} days. ${h?.recent?.lo > be ? `They've been paying (about ${usd2(h.recent.b)} back per $1), so turn them back on at about ${usd2(Math.max(5, h.onPerDay))}/day.` : "Turn them back on at a small budget on the \"Advertise\" listings, and this test will read what they add."}`;
    return held < 14
      ? `The current budget (about ${usd2(cur.ads)}/day) has run ${held} days. Leave it alone until it has two full weeks, then change it.`
      : `The budget has held at about ${usd2(cur.ads)}/day for ${held} days, long enough to read. Next step: set it to ${usd2(to)}/day in Etsy Ads and leave it two weeks. This test will spot the change in the charges by itself.`;
  })();

  const list = groups[show], pages = Math.max(1, Math.ceil(list.length / 10)), pg = Math.min(page, pages - 1);
  const inp = { width: 70, border: `1px solid ${C.border}`, borderRadius: 7, padding: "4px 7px", fontSize: 12.5, background: C.surface, color: C.ink };
  const pill = (k, label, n, col) => (
    <button key={k} onClick={() => { setShow(k); setPage(0); }} style={{ border: `1.5px solid ${show === k ? col : C.border}`, background: show === k ? col + "18" : C.surface, color: show === k ? col : C.inkMid, borderRadius: 10, padding: "7px 12px", fontSize: 12.5, fontWeight: 800, cursor: "pointer" }}>{label} · {n}</button>
  );
  const copyTitles = rows => { try { navigator.clipboard.writeText(rows.map(r => r.title).join("\n")); } catch { /* fine */ } };

  return (<>
    <AdHistory h={h} be={be} busy={hist?.busy} error={hist?.error} />
    <Section title="Ad plan — where the money should go" sub="Worked out from what each listing actually converts, its price and your margin. Etsy Ads bids for you; what you control is the daily budget and which listings are in ads (Etsy Ads → Listings).">
      {/* assumptions */}
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center", fontSize: 12, color: C.inkMid, background: C.card, borderRadius: 10, padding: "10px 12px", marginBottom: 14 }}>
        <label>Margin on the stone <input style={inp} value={Math.round(as.margin * 100)} onChange={e => setA("margin", Math.min(95, +e.target.value || 0) / 100)} />%</label>
        <label>Cost per click $<input style={inp} value={as.cpc} onChange={e => setA("cpc", e.target.value.replace(/[^\d.]/g, ""))} /></label>
        <span>→ each $1 of sales leaves <b style={{ color: C.ink }}>{usd2(plan.contrib)}</b> · break-even <b style={{ color: C.ink }}>{usd2(plan.breakEvenRoas)}</b> sales per $1 of ads · shop converts <b style={{ color: C.ink }}>{(plan.m * 100).toFixed(2)}%</b> of views</span>
        <span style={{ fontSize: 11, color: C.inkFaint, flexBasis: "100%" }}>Cost per click: Etsy Ads shows spend and clicks — divide one by the other. Margin: what's left after what the stone cost you. Fees (Etsy ~11%, plus offsite fees at {pct(m.offsiteShare)} of sales) are taken off already.</span>
      </div>

      {/* the budget call */}
      <div style={{ borderLeft: `5px solid ${call.tone}`, padding: "4px 0 4px 14px", marginBottom: 16 }}>
        <div style={eyebrow}>Budget · now {usd2(perDay)}/day on Etsy Ads</div>
        <div style={{ fontSize: 16.5, fontWeight: 800, color: C.ink, marginTop: 4 }}>{call.head}</div>
        <div style={{ fontSize: 12.5, color: C.inkMid, marginTop: 4, lineHeight: 1.55, maxWidth: 820 }}>{call.body}</div>
        {plan.floor && <div style={{ fontSize: 12.5, color: C.ink, marginTop: 8 }}>💡 Below about <b>{usd(plan.floor)}</b>, a listing can't pay for a {usd2(+as.cpc)} click even converting at twice the shop's rate. Cheap pieces sell through search and bundles, not ads — keep ads for the dearer ones.</div>}
      </div>

      {/* listings by plan */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
        {pill("advertise", "✅ Advertise", groups.advertise.length, C.green)}
        {pill("test", "🧪 Test", groups.test.length, C.amber)}
        {pill("stop", "⛔ Stop advertising", groups.stop.length, C.red)}
        <button onClick={() => copyTitles(list)} style={{ marginLeft: "auto", border: `1px solid ${C.border}`, background: C.surface, borderRadius: 9, padding: "6px 11px", fontSize: 12, fontWeight: 800, cursor: "pointer", color: C.ink }}>Copy these titles</button>
      </div>
      <div style={{ fontSize: 11.5, color: C.inkMid, marginBottom: 8 }}>
        {show === "advertise" ? "Even at the low end of what they convert, a click on these earns more than it costs. Keep them on Etsy Ads — these are where the budget should go."
          : show === "stop" ? "Even at the high end of what they convert, a click on these costs more than it brings back — or they're too cheap for a click ever to pay. Switch them off in Etsy Ads → Listings (paste the copied titles into its search)."
          : "Not enough sales or views to tell yet. Leave them in ads for a month on a modest budget; they'll move to Advertise or Stop as numbers build."}
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, minWidth: 640 }}>
          <thead><tr style={{ color: C.inkFaint, fontSize: 10.5, textTransform: "uppercase", letterSpacing: .6, textAlign: "right" }}>
            <th style={{ textAlign: "left", padding: "5px 0" }}>Listing</th><th>Price</th><th>Sold 6m</th><th>Views 6m≈</th><th>Converts</th><th>A click is worth</th><th>vs cost</th>
          </tr></thead>
          <tbody>
            {list.slice(pg * 10, pg * 10 + 10).map(r => (
              <tr key={r.id} style={{ borderTop: `1px solid ${C.border}`, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                <td style={{ textAlign: "left", padding: "6px 0" }}>
                  <a href={`https://www.etsy.com/listing/${r.id}`} target="_blank" rel="noreferrer" style={{ display: "flex", gap: 8, alignItems: "center", color: C.ink, textDecoration: "none" }}>
                    <Thumb src={r.img} /><span style={{ maxWidth: 300, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontWeight: 700 }}>{r.title}</span>
                  </a>
                </td>
                <td>{usd(r.priceUSD)}</td><td>{r.units180}</td><td>{r.v180.toLocaleString()}</td>
                <td title={`80% range ${(r.convLo * 100).toFixed(2)}–${(r.convHi * 100).toFixed(2)}%`}>{(r.conv * 100).toFixed(2)}%</td>
                <td title={`80% range ${usd2(r.worthLo)}–${usd2(r.worthHi)}`}>{usd2(r.worth)}</td>
                <td style={{ fontWeight: 800, color: r.worth > +as.cpc ? C.green : C.red }}>{r.worth > +as.cpc ? "+" : "−"}{usd2(Math.abs(r.worth - +as.cpc))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, justifyContent: "flex-end", fontSize: 12, color: C.inkMid }}>
          <button onClick={() => setPage(pg - 1)} disabled={pg === 0} style={{ border: `1px solid ${C.border}`, background: C.surface, borderRadius: 7, width: 28, height: 26, cursor: "pointer" }}>‹</button>
          <span>Page {pg + 1} of {pages}</span>
          <button onClick={() => setPage(pg + 1)} disabled={pg >= pages - 1} style={{ border: `1px solid ${C.border}`, background: C.surface, borderRadius: 7, width: 28, height: 26, cursor: "pointer" }}>›</button>
        </div>
      )}

      {/* budget test */}
      <div style={{ marginTop: 18, borderTop: `1px solid ${C.border}`, paddingTop: 14 }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: C.ink }}>🧪 Budget test</div>
        <div style={{ fontSize: 12, color: C.inkMid, margin: "4px 0 10px", lineHeight: 1.5, maxWidth: 820 }}>The only clean way to know what the ads add: change the daily budget, hold it two weeks, then change it again. Nothing to log. Each budget change is found in the daily Etsy Ads charges, and the last two budgets are compared on daily sales, with the range the difference could really be.</div>
        {nextStep && <div style={{ fontSize: 12.5, color: C.ink, background: C.card, border: `1px solid ${C.border}`, borderRadius: 9, padding: "8px 11px", marginBottom: 10, maxWidth: 820 }}>👉 {nextStep}</div>}
        {periods.length > 0 && (
          <table style={{ width: "100%", maxWidth: 640, borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead><tr style={{ color: C.inkFaint, fontSize: 10.5, textTransform: "uppercase", letterSpacing: .6, textAlign: "right" }}><th style={{ textAlign: "left" }}>Budget from</th><th>Days</th><th>Spent/day</th><th>Sales/day</th></tr></thead>
            <tbody>{periods.map(p => (
              <tr key={p.from} style={{ borderTop: `1px solid ${C.border}`, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                <td style={{ textAlign: "left", padding: "5px 0" }}>{new Date(p.from + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</td>
                <td>{p.days.length}</td><td>{usd2(p.ads)}</td><td style={{ fontWeight: 800 }}>{usd(p.sales)}</td>
              </tr>))}</tbody>
          </table>
        )}
        {periods.length === 1 && <div style={{ marginTop: 8, fontSize: 12, color: C.inkMid }}>One steady budget across the whole stretch, so there's nothing to compare yet.</div>}
        {test && (
          <div style={{ marginTop: 10, fontSize: 12.5, color: C.ink, lineHeight: 1.55 }}>
            Moving from {usd2(lastTwo[0].ads)} to {usd2(lastTwo[1].ads)}/day of ads, sales went {test.diff >= 0 ? "up" : "down"} <b>{usd(Math.abs(test.diff))}/day</b> (80% range {usd(test.lo)} to {usd(test.hi)}).{" "}
            {Math.abs(dAds) > 0.1 && <>That's <b>{usd2(test.diff / dAds)}</b> in sales per extra $1 of ads, against the {usd2(be)} needed to break even. </>}
            {test.lo > 0 && dAds > 0 ? <b style={{ color: C.green }}>The higher budget is bringing real extra sales.</b>
              : test.hi < 0 && dAds > 0 ? <b style={{ color: C.red }}>The higher budget isn't helping — go back down.</b>
              : <span style={{ color: C.inkMid }}>Not clear yet — {Math.min(test.A.n, test.B.n) < 14 ? "give it the full two weeks" : "the difference is inside the day-to-day noise; the smaller budget is the safer one"}.</span>}
          </div>
        )}
      </div>
    </Section>
  </>);
}

// A dropped connection gets two more tries before the page says so.
async function fetchRetry(url) {
  for (let i = 0; ; i++) {
    try { return await fetch(url, { cache: "no-store" }); }
    catch (e) { if (i >= 2) throw e; await new Promise(r => setTimeout(r, 1500 * (i + 1))); }
  }
}

/* The shop's whole history, a row a day, kept in app_data. The first read
   goes back to the shop's first day (a minute or so); after that only the
   last few days are asked for again and laid over what's kept. */
const HIST_KEY = "ng-ads-history-v1";
async function loadHistory(set) {
  let kept = null;
  try { kept = await loadK(HIST_KEY); } catch { /* read it fresh */ }
  if (kept?.days?.length) set({ ...kept, busy: true });
  // A copy kept before order lines were added is read again whole, once.
  if (kept && !kept.lines) kept = { ...kept, at: 0, days: [] };
  if (kept?.at && Date.now() - kept.at < 6 * 3600000) return set({ ...kept, busy: false });
  const lastK = kept?.days?.length ? kept.days[kept.days.length - 1].k : null;
  const from = lastK ? Math.floor(Date.parse(lastK + "T00:00:00+05:30") / 1000) - 3 * 86400 : 0;
  try {
    const r = await fetchRetry(`/api/etsy?action=ads_history${from ? `&from=${from}` : ""}&_=${Date.now()}`);
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) throw new Error(d.error || `Etsy didn't answer (${r.status})`);
    const cut = from ? new Date((from + 19800) * 1000).toISOString().slice(0, 10) : "";
    const days = [...(kept?.days || []).filter(x => cut && x.k < cut), ...d.days];
    const lines = [...(kept?.lines || []).filter(x => cut && x.k < cut), ...(d.lines || [])];
    const next = { at: Date.now(), firstDay: kept?.firstDay || d.firstDay, days, lines };
    set(next);
    saveK(HIST_KEY, next, { merge: false }).catch(() => {});
  } catch (e) { set(kept ? { ...kept, busy: false, error: e.message } : { error: e.message || "Couldn't reach Etsy", days: [] }); }
}

export default function EtsyInsights({ listings = [], onOpenRenew, onPrice }) {
  const [cache, setCache] = useState(readCache);
  const [busy, setBusy] = useState(false), [err, setErr] = useState("");
  const [range, setRange] = useState(30);
  const [rate, setRate] = useState(84);
  const [viewsHist, setViewsHist] = useState(null);
  const [sort, setSort] = useState("rev");

  const [hist, setHist] = useState(null);
  const load = async () => {
    setBusy(true); setErr("");
    try {
      const r = await fetchRetry(`/api/etsy?action=insights&days=180&_=${Date.now()}`);
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
    loadHistory(setHist);
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
      const offRefs = new Set(ads.filter(x => x.kind === "offsite" && x.ms >= s && x.ms < e + 3 * DAY).map(x => x.ref).filter(Boolean));
      weeks.push({ s, sales: sum(rows, r => r.usd), orders: rows.length, etsy: known ? adIn(s, e, "etsy") : null, offsite: known ? adIn(s, e, "offsite") : null, offsiteSales: sum(rows.filter(r => offRefs.has(r.id)), r => r.usd) });
    }

    const daily90 = [];
    for (let t = today0 - 89 * DAY; t <= today0; t += DAY) {
      const e = t + DAY, rows = rec.filter(r => r.ms >= t && r.ms < e);
      daily90.push({ k: dayKey(t), ms: t, sales: sum(rows, r => r.usd), etsy: adIn(t, e, "etsy") });
    }
    const etsyAds28 = adIn(today0 + DAY - 28 * DAY, Infinity, "etsy");
    const sales90 = sum(rec.filter(r => r.ms >= nowMs - 90 * DAY), r => r.usd);
    const offsiteShare = sales90 ? adIn(nowMs - 90 * DAY, Infinity, "offsite") / sales90 : 0;
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
    const shapeRow = (l, gone) => {
      const s = per[l.id] || { units: 0, rev: 0, unitsPrev: 0, revPrev: 0, units180: 0, last: 0 };
      const erp = erpBy[l.id];
      const age = Math.max(1, (nowMs - l.first * 1000) / DAY);
      return {
        ...l, ...s, erp, priceUSD: toUSD(l.price), age,
        shape: erp?.shape || "", type: erp?.type || (l.qty > 1 || (gone && s.units180 > 1) ? "repeatable" : "unique"),
        conv: l.views > 0 ? s.units180 / l.views * 1000 : 0, // sales per 1,000 views
        favRate: l.views > 0 ? l.favs / l.views : 0,
        viewsWeek: v7 && v7.v[l.id] != null ? l.views - v7.v[l.id] : null,
        viewsMonth: v30 && v30.v[l.id] != null ? l.views - v30.v[l.id] : null,
        ...(gone ? { gone: true } : {}),
      };
    };
    const live = (d.listings || []).map(l => shapeRow(l, false));
    // Sold out, expired or taken down since their orders: kept so their sales count against their views.
    const others = (d.others || []).map(l => shapeRow(l, true));
    const byId = Object.fromEntries([...others, ...live].map(l => [l.id, l]));
    const liveIds = new Set(live.map(l => l.id));
    const sellers = Object.entries(per).filter(([, p]) => p.units > 0 || p.unitsPrev > 0).map(([id, p]) => ({ id, ...p, ...(byId[id] || { title: p.title, gone: true }) }));

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
    /* Exact piece (one of a kind: the buyer gets the stone in the photos) against
       a repeatable listing (one listing, many similar stones). A unique listing
       can only ever sell once; a repeatable one keeps its reviews, ranking and
       ad history across every sale — that difference is the point of the table. */
    const kinds = ["unique", "repeatable"].map(t => {
      // On sale now, or sold (or otherwise left the shop) within the six months.
      const g = [...live, ...others.filter(l => l.units180 > 0)].filter(l => (l.type === "repeatable" ? "repeatable" : "unique") === t);
      const v180 = g.reduce((s2, l) => s2 + Math.max(l.units180, l.views * Math.min(1, 180 / Math.max(1, l.age))), 0);
      const u180 = g.reduce((s2, l) => s2 + l.units180, 0);
      return { t, n: g.length, units: g.reduce((s2, l) => s2 + l.units, 0), rev: g.reduce((s2, l) => s2 + l.rev, 0), u180,
        sold: g.filter(l => l.units180 > 0).length, avgPrice: g.length ? g.reduce((s2, l) => s2 + l.priceUSD, 0) / g.length : 0,
        conv: v180 ? u180 / v180 : 0, favRate: g.reduce((s2, l) => s2 + l.views, 0) ? g.reduce((s2, l) => s2 + l.favs, 0) / g.reduce((s2, l) => s2 + l.views, 0) : 0 };
    });

    return {
      cur, sales, salesPrev, orders: inP.length, ordersPrev: inPrev.length, aov: inP.length ? sales / inP.length : 0, aovPrev: inPrev.length ? salesPrev / inPrev.length : 0,
      etsyAds, offsite, etsyAdsPrev, offsitePrev, days, weeks, offsiteOrders, offsiteSales,
      live, liveIds, sellers, quiet, push, wasted, loved, restock, polish, erpExpiredSold, shapes,
      countries: Object.values(countries).sort((x, y) => y.usd - x.usd).slice(0, 8), repeatShare, neverSold,
      viewsSince: v7?.k || null, daily90, etsyAds28, offsiteShare, kinds, adsError: d.adsError, at: cache.at,
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
          <ActionCard id="quiet" icon="📉" accent={C.red} title="Bestsellers gone quiet" rows={m.quiet}
            why="Sold 3+ times in six months, nothing in the last 3 weeks — yet still live. Check the price, photos and title against when it sold, and put Etsy Ads behind it."
            empty="None — every regular seller has sold in the last 3 weeks."
            render={(r, done) => <ListingRow key={r.id} r={r} onDone={done} onPrice={onPrice} note={`${r.units180} sold in 6 months · last ${Math.round((Date.now() - r.last) / DAY)} days ago · ${r.qty} in stock`} right={<b>{usd(r.priceUSD)}</b>} />} />
          <ActionCard id="push" icon="🚀" accent={C.green} title="Put ads behind these" rows={m.push}
            why="They sell well for the few people who see them (a high share of views turn into sales) but get few views. Ads bring views — these turn them into orders."
            empty="Nothing stands out yet."
            render={(r, done) => <ListingRow key={r.id} r={r} onDone={done} onPrice={onPrice} note={`${r.units180} sold · ${r.views.toLocaleString()} views · ${r.conv.toFixed(1)} sales per 1k views`} right={<b>{usd(r.priceUSD)}</b>} />} />
          <ActionCard id="wasted" icon="🕳️" accent={C.amber} title="Views, no sales" rows={m.wasted}
            why="Among the most-viewed in the shop, not one sale in six months. Take these off Etsy Ads — the clicks cost money — and fix the price or the first photo."
            empty="No high-traffic listing is going without sales."
            render={(r, done) => <ListingRow key={r.id} r={r} onDone={done} onPrice={onPrice} note={`${r.views.toLocaleString()} views · ${r.favs} favourites · 0 sold`} right={<b>{usd(r.priceUSD)}</b>} />} />
          <ActionCard id="loved" icon="❤️" accent="#C2417A" title="Loved, not bought" rows={m.loved}
            why="People keep favouriting these but don't buy — usually the price. Send a sale to favouriters (Etsy → Marketing → Sales and discounts → targeted offer) or lower it a little."
            empty="Nothing here."
            render={(r, done) => <ListingRow key={r.id} r={r} onDone={done} onPrice={onPrice} note={`${r.favs} favourites from ${r.views.toLocaleString()} views`} right={<b>{usd(r.priceUSD)}</b>} />} />
          <ActionCard id="restock" icon="📦" accent={C.blue} title="Restock before it runs out" rows={m.restock}
            why="Repeatable listings that sell, down to 3 or fewer on Etsy. A sold-out listing drops out of search and loses its ranking."
            empty="Every selling repeatable has stock."
            render={(r, done) => <ListingRow key={r.id} r={r} onDone={done} onPrice={onPrice} note={`${r.units180} sold in 6 months`} right={<b style={{ color: r.qty ? C.amber : C.red }}>{r.qty} left</b>} />} />
          <ActionCard id="polish" icon="🎬" accent={C.purple || "#7A5AC8"} title="Sellers missing a video or photos" rows={m.polish}
            why="Proven sellers without a video or with fewer than 5 photos. Etsy shows listings with video more, and more photos convert better — the cheapest boost there is."
            empty="Every seller has a video and 5+ photos."
            render={(r, done) => <ListingRow key={r.id} r={r} onDone={done} onPrice={onPrice} note={`${r.units180} sold · ${r.photos} photos${r.video ? "" : " · no video"}`} right={<span style={{ display: "flex", gap: 4 }}>{!r.video && <Tag color={C.red} bg={C.redBg}>video</Tag>}{r.photos < 5 && <Tag color={C.amber} bg={C.amberBg}>photos</Tag>}</span>} />} />
        </div>
        {m.erpExpiredSold.length > 0 && (
          <div style={{ ...card, marginTop: 14, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", borderLeft: `5px solid ${C.amber}` }}>
            <span style={{ fontSize: 20 }}>♻️</span>
            <div style={{ flex: 1, minWidth: 220, fontSize: 13, color: C.ink }}><b>{m.erpExpiredSold.length} expired listing{m.erpExpiredSold.length === 1 ? "" : "s"} that sold in the last six months.</b> <span style={{ color: C.inkMid }}>Renewing a proven seller costs $0.20 and brings back its sales.</span></div>
            {onOpenRenew && <button onClick={onOpenRenew} style={{ background: C.ink, color: C.surface, border: "none", borderRadius: 10, padding: "9px 14px", fontWeight: 800, fontSize: 12.5, cursor: "pointer" }}>Open Renew →</button>}
          </div>
        )}
      </div>

      <WhatSells hist={hist} live={m.live} erpListings={listings} />

      <AdStrategy m={m} onPrice={onPrice} hist={hist} />

      {/* exact piece vs repeatable */}
      <Section title="Exact piece or similar-piece listing?" sub={`One-of-a-kind listings ("you get this stone") against repeatable ones ("you get one like it"): every listing live on Etsy now, plus the ones that sold out and left the shop. Units and revenue are the last ${range} days; conversion is six months.`}>
        <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr" : "1fr 1fr", gap: 12 }}>
          {m.kinds.map(k => (
            <div key={k.t} style={{ background: C.card, borderRadius: 12, padding: "12px 14px" }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: C.ink }}>{k.t === "unique" ? "💎 Exact piece (1 of 1)" : "🔁 Repeatable (similar piece)"}</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginTop: 10 }}>
                {[["Listings", k.n.toLocaleString()], ["Revenue", usd(k.rev)], ["Per listing", usd(k.n ? k.rev / k.n : 0)],
                  ["Units", k.units], ["Avg price", usd(k.avgPrice)], ["Ever sold (6m)", `${k.n ? Math.round(k.sold / k.n * 100) : 0}%`],
                  ["Converts", `${(k.conv * 100).toFixed(2)}%`], ["Favourited", `${(k.favRate * 100).toFixed(1)}%`], ["Units / listing", (k.n ? k.u180 / k.n : 0).toFixed(2)]].map(([l, v]) => (
                  <div key={l}><div style={{ fontSize: 10, fontWeight: 800, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .5 }}>{l}</div><div style={{ fontSize: 16, fontWeight: 800, color: C.ink, marginTop: 2 }}>{v}</div></div>
                ))}
              </div>
            </div>
          ))}
        </div>
        {(() => {
          const [u, r] = m.kinds; if (!u.n || !r.n) return null;
          const perU = u.rev / u.n, perR = r.rev / r.n, x = perU ? perR / perU : 0;
          return <div style={{ fontSize: 12.5, color: C.ink, marginTop: 12, lineHeight: 1.55 }}>
            A repeatable listing earns <b>{x >= 1 ? `${x.toFixed(1)}×` : `${Math.round(x * 100)}% of`}</b> what an exact-piece listing does, and converts at {(r.conv * 100).toFixed(2)}% against {(u.conv * 100).toFixed(2)}%.{" "}
            {x >= 1.5 ? "Where you hold several similar stones, one repeatable listing beats a listing per stone: it keeps its sales history, reviews and ranking from sale to sale, and every ad click goes to a listing that's proven." : x < 0.8 ? "Exact pieces are pulling more per listing — buyers here pay for the specific stone. Keep those as one-offs, with strong photos and video." : "They're close per listing — use repeatable for stock that is truly alike, exact pieces for stones that sell on their looks."}
            {" "}Exact pieces also pay $0.20 per new listing each time, and can't build a sales history; repeatable listings are the better home for ad money.
          </div>;
        })()}
      </Section>

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
            <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 420 }}>
              <thead><tr style={{ color: C.inkFaint, fontSize: 10, textTransform: "uppercase", letterSpacing: .5, textAlign: "right" }}><th style={{ textAlign: "left" }}>Week of</th><th>Sales</th><th>Orders</th><th style={{ color: ETSYADS }}>Etsy Ads</th><th style={{ color: OFFSITE }}>Offsite</th><th>Ads %</th><th title="Sales not from Offsite Ads, per $1 of Etsy Ads">Per $1</th></tr></thead>
              <tbody>
                {m.weeks.map(w => { const ad = w.etsy == null ? null : w.etsy + w.offsite, sh = ad != null && w.sales ? ad / w.sales : null, per = w.etsy ? (w.sales - w.offsiteSales) / w.etsy : null; return (
                  <tr key={w.s} style={{ borderTop: `1px solid ${C.border}`, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    <td style={{ textAlign: "left", padding: "5px 0" }}>{new Date(w.s).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</td>
                    <td style={{ fontWeight: 800 }}>{usd(w.sales)}</td><td>{w.orders}</td>
                    <td>{w.etsy == null ? "—" : usd(w.etsy)}</td><td>{w.offsite == null ? "—" : usd(w.offsite)}</td>
                    <td style={{ fontWeight: 800, color: sh == null ? C.inkFaint : sh < 0.1 ? C.green : sh < 0.18 ? C.amber : C.red }}>{pct(sh)}</td>
                    <td>{per == null ? "—" : usd(per)}</td>
                  </tr>); })}
              </tbody>
            </table></div>
          </Section>
        </div>
      </div>
    </div>
  );
}
