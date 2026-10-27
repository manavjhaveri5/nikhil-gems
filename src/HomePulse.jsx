import React, { useEffect, useMemo, useRef, useState } from "react";
import { C } from "./ui.jsx";
import { mob, loadK, onCacheRefresh } from "./utils.js";

/* The Etsy shop at a glance, for the home page: where this month stands against
   the $10k goal, what still has to go out the door, and what ads are costing.
   The numbers come from /api/etsy?action=pulse (paid receipts and the payment
   ledger, read live) and are bucketed here into the viewer's own days and months,
   so "today" and "this month" mean what the screen around them means. The
   paperwork counts come from the ERP's own orders, where those steps are kept. */

const GOAL_USD = 10000;
const CACHE_KEY = "ng-home-pulse-v1";
// One refresh is ~17 Etsy calls; at this rate a home page left open all day stays
// well inside Etsy's daily allowance, which the listing and order sync need too.
const FRESH_MS = 15 * 60 * 1000;
const LIST_CACHE_KEY = "ng-home-listings-v1";
// Listings change slowly, and a read costs ~10 Etsy calls.
const LIST_FRESH_MS = 30 * 60 * 1000;
// What Etsy charges to list or renew a listing for four months.
const LISTING_FEE_USD = 0.2;
const ORDERS_KEY = "ng-orders-v1";
const RATES_KEY = "ng-fin-rates-v1"; // INR per unit of each currency, refreshed by Finance
const PENDING_DAYS = 60;
const DAY = 86400000;
const SERIF = "'Cormorant Garamond',Georgia,serif";
const VOID = ["canceled", "cancelled", "fully refunded", "fully_refunded"];

/* Series colours, one per thing they stand for, stepped separately for the dark
   surface (both sets checked for colour-blind separation and contrast). */
const PALETTE_CSS = `
.ng-pulse{--pz-now:#D95A00;--pz-prev:#3D7BC4;--pz-ads:#7A5AC8;--pz-off:#0F8C7B}
html.dark .ng-pulse{--pz-now:#D9681A;--pz-prev:#4F8FD6;--pz-ads:#9278E0;--pz-off:#2AA392}
.ng-pulse .pz-row{transition:background .12s}
.ng-pulse .pz-row:hover{background:var(--c-card)}
`;
const NOW = "var(--pz-now)", PREV = "var(--pz-prev)", ADS = "var(--pz-ads)", OFF = "var(--pz-off)";

const card = { background: C.surface, borderRadius: 16, boxShadow: "var(--e-1)", padding: mob ? "13px 14px" : "16px 20px", minWidth: 0 };
const eyebrow = { fontSize: 10, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: 1.1 };

const usd = v => "$" + Math.round(v).toLocaleString("en-US");
const short = (sym, v) => {
  const a = Math.abs(v), s = v < 0 ? "-" : "";
  if (sym === "₹" && a >= 100000) return `${s}₹${(a / 100000).toFixed(a >= 1000000 ? 0 : 1).replace(/\.0$/, "")}L`;
  if (a >= 1000) return `${s}${sym}${(a / 1000).toFixed(a >= 10000 ? 0 : 1).replace(/\.0$/, "")}k`;
  return `${s}${sym}${Math.round(a)}`;
};
const usdK = v => short("$", v);
const rs = v => "₹" + Math.round(v).toLocaleString("en-IN");
const rsK = v => short("₹", v);
const monthStart = (d, k = 0) => new Date(d.getFullYear(), d.getMonth() + k, 1);
const dayStart = ms => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return +d; };
const dayKey = ms => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
const shortDate = ms => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const monthLong = d => d.toLocaleDateString("en-GB", { month: "long" });
const monthShort = d => d.toLocaleDateString("en-GB", { month: "short" });
const flag = iso => /^[A-Z]{2}$/.test(iso || "") ? String.fromCodePoint(...[...iso].map(c => 127397 + c.charCodeAt(0))) : "";
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
// Clean axis maximum just above v, on a step whose quarters and halves are round too.
const niceMax = v => {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  return [1, 1.2, 1.6, 2, 2.4, 3, 4, 5, 6, 8, 10].map(m => m * p).find(m => m >= v * 0.9999);
};

const readCache = key => { try { const c = JSON.parse(localStorage.getItem(key) || "null"); return c?.data?.ok ? c : null; } catch { return null; } };

function useWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/* ── the numbers ─────────────────────────────────────────────────────────── */
// This month, last month, and the same stretch of last month — so the 22nd is
// held against the 22nd, not against a whole month.
function calendar(nowMs) {
  const now = new Date(nowMs);
  const m0 = monthStart(now), m1 = monthStart(now, 1), mPrev = monthStart(now, -1);
  return {
    now, m0, mPrev,
    daysIn: Math.round((m1 - m0) / DAY), daysPrev: Math.round((m0 - mPrev) / DAY),
    day: now.getDate(),
    elapsed: Math.min(1, (nowMs - m0) / (m1 - m0)),
    prevCut: Math.min(+m0, +mPrev + (nowMs - m0)),
  };
}

function buildModel(data, rates, erpOrders, nowMs) {
  const cur = data.currency || "INR";
  const usdRate = +rates?.USD || 84;
  const toUSD = v => cur === "USD" ? v : cur === "INR" ? v / usdRate : v * (+rates?.[cur] || usdRate) / usdRate;
  const shopFmt = cur === "INR" ? rs : cur === "USD" ? usd : v => `${cur} ${Math.round(v).toLocaleString()}`;

  const { now, m0, mPrev, daysIn, daysPrev, day, elapsed, prevCut } = calendar(nowMs);
  const daysLeft = daysIn - day + 1;

  const receipts = (data.receipts || []).map(r => ({ ...r, ms: r.ts * 1000, counted: !VOID.includes(r.status) }));
  const within = (a, b) => receipts.filter(r => r.ms >= a && r.ms < b);
  const sum = (rows, f) => rows.reduce((s, r) => s + f(r), 0);
  const thisRows = within(+m0, nowMs + 1), prevSame = within(+mPrev, prevCut), prevRows = within(+mPrev, +m0);
  const sales = sum(thisRows, r => r.sales), salesPrevSame = sum(prevSame, r => r.sales), salesPrev = sum(prevRows, r => r.sales);
  const orders = thisRows.filter(r => r.counted).length, ordersPrevSame = prevSame.filter(r => r.counted).length, ordersPrev = prevRows.filter(r => r.counted).length;
  const items = sum(thisRows.filter(r => r.counted), r => r.items);
  const usdNow = toUSD(sales);
  const pace = GOAL_USD * elapsed;
  const avgPerDay = usdNow / Math.max(1, elapsed * daysIn);
  const projection = elapsed > 0.04 ? usdNow / elapsed : null;

  // Running total at the end of each day: [0] is the start of the month.
  const cumulative = (start, days, upTo) => {
    const out = [0];
    let run = 0;
    for (let d = 1; d <= days; d++) {
      const end = +new Date(start.getFullYear(), start.getMonth(), d + 1);
      const from = +new Date(start.getFullYear(), start.getMonth(), d);
      if (from > upTo) break;
      run += toUSD(sum(within(from, Math.min(end, upTo + 1)), r => r.sales));
      out.push(run);
    }
    return out;
  };
  const cumThis = cumulative(m0, daysIn, nowMs);
  const cumPrev = cumulative(mPrev, daysPrev, +m0 - 1);

  const months = [-5, -4, -3, -2, -1, 0].map(k => {
    const a = monthStart(now, k), b = monthStart(now, k + 1);
    const rows = within(+a, +b);
    return { key: +a, label: monthShort(a), name: monthLong(a), current: k === 0, usd: toUSD(sum(rows, r => r.sales)), shop: sum(rows, r => r.sales), orders: rows.filter(r => r.counted).length };
  });
  // A month that started before the window the server was asked for is partial; don't show it as real.
  const firstFull = (data.from || 0) * 1000 <= months[0].key + DAY;
  const monthsShown = firstFull ? months : months.slice(1);

  const today0 = dayStart(nowMs);
  const unshipped = receipts.filter(r => r.lines && !r.shipped && r.counted).sort((a, b) => a.ms - b.ms).map(r => ({
    ...r,
    waiting: Math.max(0, Math.floor((today0 - dayStart(r.ms)) / DAY)),
    shipIn: r.ship_by ? Math.round((dayStart(r.ship_by * 1000) - today0) / DAY) : null,
  }));
  const overdue = unshipped.filter(r => r.shipIn != null && r.shipIn < 0).length;

  // Ad spend, by the day Etsy charged it.
  const adsByDay = {};
  for (const a of data.ads || []) {
    const k = dayKey(a.ts * 1000);
    const b = adsByDay[k] || (adsByDay[k] = { etsy: 0, offsite: 0 });
    b[a.kind] += a.amt;
  }
  const adsIn = (a, b) => (data.ads || []).filter(x => x.ts * 1000 >= a && x.ts * 1000 < b)
    .reduce((s, x) => ({ ...s, [x.kind]: s[x.kind] + x.amt, total: s.total + x.amt }), { etsy: 0, offsite: 0, total: 0 });
  const adsNow = adsIn(+m0, nowMs + 1), adsPrevSame = adsIn(+mPrev, prevCut), adsPrev = adsIn(+mPrev, +m0);
  const ads30 = [];
  for (let i = 29; i >= 0; i--) {
    const ms = +new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const b = adsByDay[dayKey(ms)] || { etsy: 0, offsite: 0 };
    ads30.push({ ms, etsy: b.etsy, offsite: b.offsite, total: b.etsy + b.offsite });
  }
  const yesterday = ads30[28];

  // Paperwork still open on Etsy orders, grouped to one parcel per receipt.
  const since = new Date(today0 - PENDING_DAYS * DAY).toISOString().slice(0, 10);
  const groups = new Map();
  for (const o of erpOrders || []) {
    if (o.platform !== "etsy" || String(o.date || o.created_at || "").slice(0, 10) < since) continue;
    if (o.cancelled || ["canceled", "cancelled", "fully_refunded"].includes(String(o.status || "").toLowerCase())) continue;
    const k = String(o.etsy_receipt_id || o.platform_order_id || o.id);
    const g = groups.get(k) || { stock: true, sales: true, ng: true };
    g.stock = g.stock && !!o.linked_stock_id;
    g.sales = g.sales && !!o._atInvoiceNo;
    g.ng = g.ng && !!o._ngInvoiceNo;
    groups.set(k, g);
  }
  const g = [...groups.values()];
  const pending = {
    total: g.length,
    stock: g.filter(x => !x.stock).length,
    sales: g.filter(x => !x.sales).length,
    ng: g.filter(x => !x.ng).length,
    done: g.filter(x => x.stock && x.sales && x.ng).length,
  };

  return {
    cur, usdRate, toUSD, shopFmt, now, m0, mPrev, daysIn, daysPrev, day, elapsed, daysLeft, prevCut,
    sales, salesPrevSame, salesPrev, orders, ordersPrevSame, ordersPrev, items,
    usdNow, usdPrevSame: toUSD(salesPrevSame), usdPrev: toUSD(salesPrev), pace, avgPerDay, projection,
    needPerDay: Math.max(0, GOAL_USD - usdNow) / Math.max(1, daysLeft),
    aov: orders ? usdNow / orders : 0, aovPrev: ordersPrev ? toUSD(salesPrev) / ordersPrev : 0,
    cumThis, cumPrev, months: monthsShown, unshipped, overdue,
    adsNow, adsPrevSame, adsPrev, ads30, yesterday, pending,
  };
}

// Listings: new ones by the date they were first listed, and what's ending or ended.
function buildListingModel(data, nowMs) {
  const cal = calendar(nowMs);
  const { now, m0, mPrev, daysIn, daysPrev, prevCut } = cal;
  const added = (data.added || []).map(a => a.ts * 1000);
  const count = (a, b) => added.filter(t => t >= a && t < b).length;
  const today0 = dayStart(nowMs);
  const weekStart = today0 - ((now.getDay() + 6) % 7) * DAY; // weeks start on Monday
  const running = (start, days, upTo) => {
    const out = [0];
    for (let d = 1; d <= days; d++) {
      const from = +new Date(start.getFullYear(), start.getMonth(), d);
      if (from > upTo) break;
      out.push(out[d - 1] + count(from, Math.min(+new Date(start.getFullYear(), start.getMonth(), d + 1), upTo + 1)));
    }
    return out;
  };
  const nowS = nowMs / 1000;
  const expiring = data.expiring || [];
  const in7 = expiring.filter(l => l.ends <= nowS + 7 * 86400);
  const expired = data.expiredLately || [];
  return {
    ...cal,
    today: count(today0, nowMs + 1), yesterday: count(today0 - DAY, today0),
    week: count(weekStart, nowMs + 1), weekPrev: count(weekStart - 7 * DAY, nowMs - 7 * DAY + 1), weekDays: Math.round((today0 - weekStart) / DAY) + 1,
    month: count(+m0, nowMs + 1), monthPrevSame: count(+mPrev, prevCut), monthPrev: count(+mPrev, +m0),
    cumThis: running(m0, daysIn, nowMs), cumPrev: running(mPrev, daysPrev, +m0 - 1),
    counts: data.counts || {},
    in7: in7.length, in7Off: in7.filter(l => !l.auto).length,
    in30: expiring.length, in30Off: expiring.filter(l => !l.auto).length,
    expired7: expired.filter(l => l.ends >= nowS - 7 * 86400).length, expired30: expired.length,
  };
}

/* ── small pieces ─────────────────────────────────────────────────────────── */
// A signed change against a named period; colour says whether the move is good
// (upIsGood={null} for a number that's neither, like ad spend).
function Delta({ now, prev, label, upIsGood = true, money }) {
  if (!(prev > 0)) return <span style={{ fontSize: 11, color: C.inkFaint }}>{label}: none yet</span>;
  const p = Math.round((now / prev - 1) * 100);
  const good = p === 0 || upIsGood == null ? null : (p > 0) === upIsGood;
  const col = good == null ? C.inkMid : good ? C.green : C.red;
  return (
    <span style={{ fontSize: 11, color: C.inkMid }}>
      <span style={{ color: col, fontWeight: 700 }}>{p > 0 ? "▲" : p < 0 ? "▼" : "•"} {Math.abs(p)}%</span>{" "}
      vs {label}{money ? ` (${money(prev)})` : ""}
    </span>
  );
}

function Tip({ x, y, w, children }) {
  if (x == null) return null;
  const width = 168;
  const left = Math.max(0, Math.min(x + 12, w - width));
  const flip = x + 12 + width > w;
  return (
    <div style={{ position: "absolute", left: flip ? Math.max(0, x - width - 12) : left, top: y, width, pointerEvents: "none", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,.12)", padding: "8px 10px", fontSize: 11, color: C.ink, zIndex: 5 }}>
      {children}
    </div>
  );
}
const TipRow = ({ color, dash, label, value }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 3 }}>
    {color && <span style={{ width: 12, height: 0, borderTop: `2px ${dash ? "dashed" : "solid"} ${color}`, flexShrink: 0 }} />}
    <span style={{ flex: 1, color: C.inkMid }}>{label}</span>
    <span style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{value}</span>
  </div>
);
const Key = ({ color, dash, children }) => (
  <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10.5, color: C.inkMid, whiteSpace: "nowrap" }}>
    <span style={{ width: 14, height: 0, borderTop: `2px ${dash ? "dashed" : "solid"} ${color}` }} />{children}
  </span>
);

function Stat({ label, value, sub, onClick }) {
  return (
    <div onClick={onClick} style={{ ...card, padding: mob ? "11px 12px" : "13px 15px", cursor: onClick ? "pointer" : "default" }}>
      <div style={eyebrow}>{label}</div>
      <div style={{ fontFamily: SERIF, fontVariantNumeric: "lining-nums", fontSize: mob ? 24 : 28, fontWeight: 600, color: C.ink, lineHeight: 1.15, marginTop: 4, letterSpacing: "-.01em" }}>{value}</div>
      <div style={{ marginTop: 3, lineHeight: 1.45 }}>{sub}</div>
    </div>
  );
}

/* ── a running total through the month, against last month (and a goal) ───── */
function RaceChart({ m, cumThis, cumPrev, short, full, goal }) {
  const [ref, w] = useWidth();
  const [hover, setHover] = useState(null);
  const H = mob ? 170 : 200, PL = 38, PR = 58, PT = 10, PB = 22;
  const CW = Math.max(10, w - PL - PR), CH = H - PT - PB;
  const xMax = Math.max(m.daysIn, m.daysPrev);
  const yMax = niceMax(Math.max(goal || 0, ...cumPrev, ...cumThis, 1) * 1.04);
  const x = d => PL + (d / xMax) * CW;
  const y = v => PT + CH * (1 - v / yMax);
  const nowX = m.elapsed * m.daysIn;
  // This month's line ends at this moment, not at the end of today.
  const thisPts = cumThis.map((v, d) => [Math.min(d, nowX), v]);
  const path = pts => pts.map(([d, v], i) => `${i ? "L" : "M"}${x(d).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const last = thisPts[thisPts.length - 1];
  const prevLast = cumPrev[cumPrev.length - 1];
  const ticks = [0.25, 0.5, 0.75, 1].map(t => t * yMax);
  const prevName = monthLong(m.mPrev), thisName = monthLong(m.m0);
  const goalLabelY = goal ? y(goal) : -99, prevLabelY = y(prevLast);
  const showPrevLabel = Math.abs(goalLabelY - prevLabelY) > 13;
  const onMove = e => {
    const r = e.currentTarget.getBoundingClientRect();
    const d = Math.round(((e.clientX - r.left - PL) / CW) * xMax);
    setHover(Math.max(1, Math.min(xMax, d)));
  };
  const hv = hover != null ? {
    now: hover <= cumThis.length - 1 ? cumThis[hover] : null,
    prev: hover <= cumPrev.length - 1 ? cumPrev[hover] : null,
    goal: goal && hover <= m.daysIn ? goal * hover / m.daysIn : null,
  } : null;
  return (
    <div ref={ref} style={{ position: "relative", marginTop: 10 }}>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 4 }}>
        <Key color={NOW}>{thisName}</Key>
        <Key color={PREV}>{prevName}</Key>
        {goal && <Key color={C.inkFaint} dash>On track for {short(goal)}</Key>}
      </div>
      {w > 0 && (
        <svg width={w} height={H} style={{ display: "block", touchAction: "pan-y" }} onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)}>
          {ticks.map(t => (
            <g key={t}>
              <line x1={PL} x2={PL + CW} y1={y(t)} y2={y(t)} stroke={C.border} strokeWidth={1} />
              <text x={PL - 6} y={y(t) + 3.5} textAnchor="end" fontSize={10} fill={C.inkFaint} style={{ fontVariantNumeric: "tabular-nums" }}>{short(t)}</text>
            </g>
          ))}
          <line x1={PL} x2={PL + CW} y1={y(0)} y2={y(0)} stroke={C.borderHi} strokeWidth={1} />
          {[1, 8, 15, 22, 29].filter(d => d <= xMax).map(d => (
            <text key={d} x={x(d)} y={H - 6} textAnchor="middle" fontSize={10} fill={C.inkFaint}>{d}</text>
          ))}
          {/* goal pace: a straight line to the goal on the last day */}
          {goal && <line x1={x(0)} y1={y(0)} x2={x(m.daysIn)} y2={y(goal)} stroke={C.inkFaint} strokeWidth={1.25} strokeDasharray="5 4" />}
          {goal && <text x={x(m.daysIn) + 6} y={goalLabelY + 3.5} fontSize={10} fill={C.inkMid} fontWeight={600}>{short(goal)} goal</text>}
          {/* last month, whole */}
          <path d={path(cumPrev.map((v, d) => [d, v]))} fill="none" stroke={PREV} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {showPrevLabel && <text x={x(cumPrev.length - 1) + 6} y={prevLabelY + 3.5} fontSize={10} fill={C.inkMid}>{monthShort(m.mPrev)} {short(prevLast)}</text>}
          {/* this month, so far */}
          <path d={path(thisPts) + `L${x(last[0]).toFixed(1)},${y(0)}L${x(0)},${y(0)}Z`} fill={NOW} fillOpacity={0.1} stroke="none" />
          <path d={path(thisPts)} fill="none" stroke={NOW} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={x(last[0])} cy={y(last[1])} r={4.5} fill={NOW} stroke={C.surface} strokeWidth={2} />
          <text x={x(last[0])} y={y(last[1]) - 10} textAnchor="middle" fontSize={10.5} fontWeight={700} fill={C.ink}>{short(last[1])}</text>
          {hover != null && (
            <g pointerEvents="none">
              <line x1={x(hover)} x2={x(hover)} y1={PT} y2={PT + CH} stroke={C.inkFaint} strokeWidth={1} />
              {hv.prev != null && <circle cx={x(hover)} cy={y(hv.prev)} r={4} fill={PREV} stroke={C.surface} strokeWidth={2} />}
              {hv.now != null && <circle cx={x(Math.min(hover, nowX))} cy={y(hv.now)} r={4} fill={NOW} stroke={C.surface} strokeWidth={2} />}
            </g>
          )}
        </svg>
      )}
      {hover != null && (
        <Tip x={x(hover)} y={18} w={w}>
          <div style={{ fontWeight: 700 }}>Day {hover}</div>
          {hv.now != null && <TipRow color={NOW} label={`${monthShort(m.m0)} 1–${hover}`} value={full(hv.now)} />}
          {hv.prev != null && <TipRow color={PREV} label={`${monthShort(m.mPrev)} 1–${hover}`} value={full(hv.prev)} />}
          {hv.goal != null && <TipRow color={C.inkFaint} dash label="On track" value={full(hv.goal)} />}
        </Tip>
      )}
    </div>
  );
}

/* ── the last six months, with the goal across them ─────────────────────────── */
function MonthBars({ m }) {
  const [ref, w] = useWidth();
  const [hover, setHover] = useState(null);
  const H = 150, PL = 34, PR = 6, PT = 18, PB = 20;
  const CW = Math.max(10, w - PL - PR), CH = H - PT - PB;
  const months = m.months;
  const proj = m.projection || 0;
  const yMax = niceMax(Math.max(GOAL_USD, proj, ...months.map(x => x.usd)) * 1.05);
  const y = v => PT + CH * (1 - v / yMax);
  const band = CW / months.length;
  const bw = Math.min(24, band * 0.5);
  const cx = i => PL + band * i + band / 2;
  const best = Math.max(...months.filter(x => !x.current).map(x => x.usd), 0);
  const barPath = (x0, top, bottom, width) => {
    const r = Math.min(4, width / 2, Math.max(0, bottom - top));
    return `M${x0},${bottom}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x0 + width - r}Q${x0 + width},${top} ${x0 + width},${top + r}V${bottom}Z`;
  };
  const hm = hover != null ? months[hover] : null;
  return (
    <div ref={ref} style={{ position: "relative" }}>
      {w > 0 && (
        <svg width={w} height={H} style={{ display: "block" }} onPointerLeave={() => setHover(null)}>
          {[0.5, 1].map(t => (
            <g key={t}>
              <line x1={PL} x2={PL + CW} y1={y(t * yMax)} y2={y(t * yMax)} stroke={C.border} strokeWidth={1} />
              <text x={PL - 6} y={y(t * yMax) + 3.5} textAnchor="end" fontSize={10} fill={C.inkFaint}>{usdK(t * yMax)}</text>
            </g>
          ))}
          <line x1={PL} x2={PL + CW} y1={y(0)} y2={y(0)} stroke={C.borderHi} strokeWidth={1} />
          {months.map((mo, i) => {
            const x0 = cx(i) - bw / 2;
            const top = y(mo.usd);
            const projTop = mo.current && proj > mo.usd ? y(proj) : null;
            return (
              <g key={mo.key}>
                {projTop != null && <path d={barPath(x0, projTop, top - 2, bw)} fill={NOW} fillOpacity={0.14} />}
                <path d={barPath(x0, top, y(0), bw)} fill={mo.current ? NOW : C.borderHi} />
                <text x={cx(i)} y={(projTop ?? top) - 5} textAnchor="middle" fontSize={10} fontWeight={mo.current || mo.usd === best ? 700 : 500} fill={mo.current ? C.ink : C.inkMid}>{usdK(mo.usd)}</text>
                <text x={cx(i)} y={H - 6} textAnchor="middle" fontSize={10} fill={mo.current ? C.ink : C.inkFaint} fontWeight={mo.current ? 700 : 400}>{mo.label}</text>
                <rect x={cx(i) - band / 2} y={PT} width={band} height={CH} fill="transparent" onPointerEnter={() => setHover(i)} onPointerDown={() => setHover(i)} />
              </g>
            );
          })}
          <line x1={PL} x2={PL + CW} y1={y(GOAL_USD)} y2={y(GOAL_USD)} stroke={C.ink} strokeOpacity={0.55} strokeWidth={1.25} strokeDasharray="5 4" pointerEvents="none" />
          <text x={PL + CW} y={y(GOAL_USD) - 4} textAnchor="end" fontSize={10} fontWeight={600} fill={C.inkMid}>Goal {usdK(GOAL_USD)}</text>
        </svg>
      )}
      {hm && (
        <Tip x={cx(hover)} y={8} w={w}>
          <div style={{ fontWeight: 700 }}>{hm.name}{hm.current ? " (so far)" : ""}</div>
          <TipRow label="Sales" value={usd(hm.usd)} />
          <TipRow label="In shop currency" value={m.shopFmt(hm.shop)} />
          <TipRow label="Orders" value={hm.orders} />
          <TipRow label="Of goal" value={`${Math.round(hm.usd / GOAL_USD * 100)}%`} />
          {hm.current && m.projection != null && <TipRow color={NOW} label="On pace for" value={usd(m.projection)} />}
        </Tip>
      )}
    </div>
  );
}

/* ── ad spend per day, Etsy Ads under Offsite Ads ─────────────────────────── */
function AdBars({ m }) {
  const [ref, w] = useWidth();
  const [hover, setHover] = useState(null);
  const H = mob ? 120 : 140, PL = 38, PR = 4, PT = 8, PB = 20;
  const CW = Math.max(10, w - PL - PR), CH = H - PT - PB;
  const days = m.ads30;
  const yMax = niceMax(Math.max(...days.map(d => d.total), 1) * 1.05);
  const y = v => PT + CH * (1 - v / yMax);
  const band = CW / days.length;
  const bw = Math.max(2, Math.min(18, band - 2));
  const x0 = i => PL + band * i + (band - bw) / 2;
  const top = (x, t, b, width, round) => {
    const r = round ? Math.min(3, width / 2, Math.max(0, b - t)) : 0;
    return `M${x},${b}V${t + r}Q${x},${t} ${x + r},${t}H${x + width - r}Q${x + width},${t} ${x + width},${t + r}V${b}Z`;
  };
  const hd = hover != null ? days[hover] : null;
  return (
    <div ref={ref} style={{ position: "relative" }}>
      {w > 0 && (
        <svg width={w} height={H} style={{ display: "block" }} onPointerLeave={() => setHover(null)}>
          {[0.5, 1].map(t => (
            <g key={t}>
              <line x1={PL} x2={PL + CW} y1={y(t * yMax)} y2={y(t * yMax)} stroke={C.border} strokeWidth={1} />
              <text x={PL - 6} y={y(t * yMax) + 3.5} textAnchor="end" fontSize={10} fill={C.inkFaint}>{rsK(t * yMax)}</text>
            </g>
          ))}
          <line x1={PL} x2={PL + CW} y1={y(0)} y2={y(0)} stroke={C.borderHi} strokeWidth={1} />
          {days.map((d, i) => {
            const etsyTop = y(d.etsy);
            const gap = d.etsy > 0 && d.offsite > 0 ? 2 : 0;
            return (
              <g key={d.ms} opacity={hover == null || hover === i ? 1 : 0.55}>
                {d.etsy > 0 && <path d={top(x0(i), etsyTop, y(0), bw, d.offsite <= 0)} fill={ADS} />}
                {d.offsite > 0 && <path d={top(x0(i), y(d.etsy + d.offsite) - gap, etsyTop - gap, bw, true)} fill={OFF} />}
                <rect x={PL + band * i} y={PT} width={band} height={CH} fill="transparent" onPointerEnter={() => setHover(i)} onPointerDown={() => setHover(i)} />
              </g>
            );
          })}
          {[0, 14, 29].map(i => (
            <text key={i} x={x0(i) + bw / 2} y={H - 6} textAnchor={i === 0 ? "start" : i === 29 ? "end" : "middle"} fontSize={10} fill={C.inkFaint}>{i === 29 ? "Today" : shortDate(days[i].ms)}</text>
          ))}
        </svg>
      )}
      {hd && (
        <Tip x={x0(hover) + bw / 2} y={4} w={w}>
          <div style={{ fontWeight: 700 }}>{new Date(hd.ms).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}</div>
          <TipRow color={ADS} label="Etsy Ads" value={rs(hd.etsy)} />
          <TipRow color={OFF} label="Offsite Ads" value={rs(hd.offsite)} />
          <TipRow label="Total" value={rs(hd.total)} />
        </Tip>
      )}
    </div>
  );
}

/* ── listings: new this month, and the ones ending ─────────────────────────── */
const countShort = v => Number.isInteger(v) ? String(v) : v.toFixed(1);
const countFull = v => plural(Math.round(v), "listing");

function ListingsRow({ lm, err, loading, usdRate, onOpen, onRenew }) {
  if (!lm) {
    return (
      <div style={{ ...card, marginBottom: 11 }}>
        <div style={eyebrow}>Listings</div>
        <div style={{ fontSize: 11.5, color: err ? C.red : C.inkFaint, marginTop: 8 }}>
          {err ? `Couldn't read the listings from Etsy — ${err}` : loading ? "Reading the listings from Etsy…" : "Listings load after the sales numbers."}
        </div>
      </div>
    );
  }
  const prevPeriod = `${monthShort(lm.mPrev)} 1–${new Date(lm.prevCut - 1).getDate()}`;
  const c = lm.counts;
  const renewUSD = lm.in30 * LISTING_FEE_USD;
  const box = { background: C.card, borderRadius: 10, padding: "9px 12px", minWidth: 0 };
  const big = { fontFamily: SERIF, fontVariantNumeric: "lining-nums", fontSize: mob ? 26 : 30, fontWeight: 600, color: C.ink, lineHeight: 1.1 };
  const offNote = (n, off) => !n ? "nothing ending" : off === n ? `auto-renew is off on all ${n} — they'll come off the shop` : `${off} will come off the shop · ${n - off} auto-renew`;
  // The ending and expired rows open the Renew queue, where each is renewed or skipped.
  const renew = onRenew || onOpen;
  const health = [
    ["🟢", "Active", c.active, `listed on Etsy now${c.sold_out ? ` · ${c.sold_out} sold out` : ""}`, null, onOpen],
    ["⏳", "Ending in 7 days", lm.in7, offNote(lm.in7, lm.in7Off), lm.in7Off ? C.red : null, renew],
    ["🗓️", "Ending in 30 days", lm.in30, lm.in30 ? `${offNote(lm.in30, lm.in30Off)} · renewing all ≈ ${usd(renewUSD)} (${rs(renewUSD * usdRate)})` : "nothing ending", lm.in30Off ? C.amber : null, renew],
    ["⛔", "Expired", c.expired, `${lm.expired30} in the last 30 days · ${lm.expired7} this week · renew or skip each →`, null, renew],
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr" : "minmax(0,1.5fr) minmax(0,1fr)", gap: 11, marginBottom: 11 }}>
      <div style={card}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <div style={eyebrow}>New listings · {monthLong(lm.m0)}</div>
          <span style={{ fontSize: 10.5, color: C.inkFaint }}>by the day first listed — renewals don't count</span>
          <div style={{ flex: 1 }} />
          <button onClick={onOpen} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 11, color: C.gold, fontWeight: 600, padding: 0 }}>Open listings →</button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 8, marginTop: 10 }}>
          <div style={box}>
            <div style={{ fontSize: 10.5, color: C.inkMid, fontWeight: 600 }}>Today</div>
            <div style={big}>{lm.today}</div>
            <div style={{ fontSize: 10.5, color: C.inkFaint, marginTop: 2 }}>yesterday {lm.yesterday}</div>
          </div>
          <div style={box}>
            <div style={{ fontSize: 10.5, color: C.inkMid, fontWeight: 600 }}>This week</div>
            <div style={big}>{lm.week}</div>
            <div style={{ marginTop: 2 }}><Delta now={lm.week} prev={lm.weekPrev} label={lm.weekDays === 7 ? "last week" : lm.weekDays === 1 ? "last Monday" : `last Mon–${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][lm.weekDays - 1]}`} /></div>
          </div>
          <div style={box}>
            <div style={{ fontSize: 10.5, color: C.inkMid, fontWeight: 600 }}>This month</div>
            <div style={big}>{lm.month}</div>
            <div style={{ marginTop: 2 }}><Delta now={lm.month} prev={lm.monthPrevSame} label={prevPeriod} /></div>
          </div>
        </div>
        <div style={{ fontSize: 11, color: C.inkMid, marginTop: 9 }}>{monthLong(lm.mPrev)} in full: <b style={{ color: C.ink }}>{plural(lm.monthPrev, "new listing")}</b>{lm.day > 1 ? ` · this month so far ${(lm.month / Math.max(1, lm.elapsed * lm.daysIn)).toFixed(1)} a day, last month ${(lm.monthPrev / lm.daysPrev).toFixed(1)}` : ""}</div>
        <RaceChart m={lm} cumThis={lm.cumThis} cumPrev={lm.cumPrev} short={countShort} full={countFull} />
      </div>

      <div style={card}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
          <div style={eyebrow}>Shop listings</div>
          <div style={{ flex: 1 }} />
          {onRenew && <button onClick={onRenew} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 11, color: C.gold, fontWeight: 600, padding: 0, marginRight: 10 }}>Renew queue →</button>}
          <button onClick={onOpen} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 11, color: C.gold, fontWeight: 600, padding: 0 }}>Open →</button>
        </div>
        {health.map(([icon, label, n, hint, tone, go]) => (
          <div key={label} className="pz-row" onClick={go} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 8px", borderRadius: 10, cursor: "pointer" }}>
            <span style={{ width: 30, height: 30, borderRadius: 8, background: tone === C.red ? C.redBg : tone === C.amber ? C.amberBg : C.card, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, flexShrink: 0 }}>{icon}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: C.ink }}>{label}</div>
              <div style={{ fontSize: 10.5, color: tone || C.inkFaint, lineHeight: 1.4 }}>{hint}</div>
            </div>
            <span style={{ fontFamily: SERIF, fontVariantNumeric: "lining-nums", fontSize: 24, fontWeight: 600, color: C.ink, minWidth: 34, textAlign: "right" }}>{(n ?? 0).toLocaleString("en-IN")}</span>
          </div>
        ))}
        <div style={{ fontSize: 10.5, color: C.inkFaint, marginTop: 6, paddingTop: 8, borderTop: `1px solid ${C.border}` }}>
          Inactive {c.inactive ?? 0} · Drafts {c.draft ?? 0}{lm.in30Off ? " · An Etsy listing runs four months; with auto-renew off it then expires." : ""}
        </div>
      </div>
    </div>
  );
}

/* ── the page section ─────────────────────────────────────────────────────── */
export default function EtsyPulse({ onEnter, rates }) {
  const [cache, setCache] = useState(() => readCache(CACHE_KEY));
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [lcache, setLcache] = useState(() => readCache(LIST_CACHE_KEY));
  const [lloading, setLloading] = useState(false);
  const [lerr, setLerr] = useState("");
  const [erpOrders, setErpOrders] = useState(null);
  const [ownRates, setOwnRates] = useState(undefined);
  const [tick, setTick] = useState(Date.now());
  const busy = useRef(false);

  const fetchInto = async (url, key, set, setBusy, setError) => {
    setBusy(true); setError("");
    try {
      const r = await fetch(url, { cache: "no-store" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(d.error || `Etsy didn't answer (${r.status})`);
      const next = { at: Date.now(), data: d };
      set(next);
      try { localStorage.setItem(key, JSON.stringify(next)); } catch {}
    } catch (e) { setError(e.message || "Couldn't reach Etsy"); }
    setBusy(false); setTick(Date.now());
  };
  const stale = (key, ms) => { const c = readCache(key); return !c || Date.now() - c.at > ms; };
  /* Sales first, then listings — one after the other, never together, so the
     two reads never share Etsy's per-second allowance. */
  const refresh = async force => {
    if (busy.current) return;
    busy.current = true;
    const now = new Date();
    if (force || stale(CACHE_KEY, FRESH_MS)) {
      const from = Math.floor(+monthStart(now, -5) / 1000), adsFrom = Math.floor(+monthStart(now, -1) / 1000);
      await fetchInto(`/api/etsy?action=pulse&from=${from}&ads_from=${adsFrom}&_=${Date.now()}`, CACHE_KEY, setCache, setLoading, setErr);
    }
    if (force || stale(LIST_CACHE_KEY, LIST_FRESH_MS)) {
      await fetchInto(`/api/etsy?action=listing_pulse&from=${Math.floor(+monthStart(now, -1) / 1000)}&_=${Date.now()}`, LIST_CACHE_KEY, setLcache, setLloading, setLerr);
    }
    busy.current = false;
  };
  const load = () => refresh(true);

  useEffect(() => {
    refresh(false);
    // Left open all day, the page keeps itself current — but only while someone can see it.
    const t = setInterval(() => {
      setTick(Date.now());
      if (document.visibilityState === "visible") refresh(false);
    }, 60000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    loadK(ORDERS_KEY).then(o => setErpOrders(Array.isArray(o) ? o : []));
    // The home page passes its rates in, but loads them a beat later than this; reading
    // them here too keeps the dollar figures from flashing at a fallback rate first.
    loadK(RATES_KEY).then(r => setOwnRates(r || {}));
    return onCacheRefresh(keys => { if (keys.includes(ORDERS_KEY)) loadK(ORDERS_KEY).then(o => { if (Array.isArray(o)) setErpOrders(o); }); });
  }, []);

  const fx = rates?.USD ? rates : ownRates;
  const m = useMemo(() => cache?.data && fx ? buildModel(cache.data, fx, erpOrders, Date.now()) : null, [cache, fx, erpOrders, tick]);
  const lm = useMemo(() => lcache?.data ? buildListingModel(lcache.data, Date.now()) : null, [lcache, tick]);

  const ago = cache ? Math.round((Date.now() - cache.at) / 60000) : null;
  const status = loading || lloading ? "Updating…" : ago == null ? "" : ago < 1 ? "Updated just now" : `Updated ${ago < 60 ? `${ago} min` : `${Math.round(ago / 60)} h`} ago`;
  const reconnect = /oauth|token|authori/i.test(err);

  if (!m) {
    return (
      <div className="ng-pulse" style={{ ...card, marginBottom: 11, animation: "fadeUp .4s ease .08s both" }}>
        <style>{PALETTE_CSS}</style>
        <div style={eyebrow}>Etsy this month</div>
        {err ? (
          <div style={{ marginTop: 8, fontSize: 12.5, color: C.inkMid, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span>{reconnect ? "Etsy isn't connected, so the shop numbers can't load." : `Couldn't load the shop numbers — ${err}`}</span>
            <button className="bs" style={{ fontSize: 11.5 }} onClick={() => reconnect ? onEnter("etsy") : load()}>{reconnect ? "Open Etsy to reconnect" : "Try again"}</button>
          </div>
        ) : (
          <div style={{ marginTop: 10 }}>
            <div style={{ height: 44, width: 180, borderRadius: 8, background: C.card, animation: "pulse 1.4s ease infinite" }} />
            <div style={{ height: 8, borderRadius: 4, background: C.card, marginTop: 14 }} />
            <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 10 }}>Reading the shop from Etsy…</div>
          </div>
        )}
      </div>
    );
  }

  const reached = m.usdNow >= GOAL_USD;
  const ahead = m.usdNow - m.pace;
  const fill = Math.min(1, m.usdNow / GOAL_USD);
  const paceCol = reached || ahead >= 0 ? C.green : m.usdNow >= m.pace * 0.75 ? C.amber : C.red;
  const prevPeriod = `${monthShort(m.mPrev)} 1–${new Date(m.prevCut - 1).getDate()}`;
  const adsShare = m.sales > 0 ? m.adsNow.total / m.sales : null;
  const adsSharePrev = m.salesPrev > 0 ? m.adsPrev.total / m.salesPrev : null;
  const go = () => onEnter("orders");

  const stepRows = [
    ["🚚", "Ship", m.unshipped.length, "live from Etsy"],
    ["📦", "Stock allocated", m.pending.stock],
    ["🧾", "Sales invoice", m.pending.sales],
    ["🏷️", "NG invoice", m.pending.ng],
  ];

  return (
    <div className="ng-pulse" style={{ marginBottom: 11, animation: "fadeUp .4s ease .08s both" }}>
      <style>{PALETTE_CSS}</style>

      {/* ── Row 1: this month against the goal ── */}
      <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr" : "minmax(0,1.5fr) minmax(0,1fr)", gap: 11, marginBottom: 11 }}>
        <div style={card}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <div style={eyebrow}>Etsy · {monthLong(m.m0)} · day {m.day} of {m.daysIn}</div>
            <div style={{ flex: 1 }} />
            <span title={err ? `Last refresh failed: ${err}` : ""} style={{ fontSize: 10.5, color: err ? C.red : C.inkFaint }}>{err ? "Refresh failed · showing last numbers" : status}</span>
            <button onClick={load} disabled={loading || lloading} title="Refresh from Etsy" aria-label="Refresh from Etsy" style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 7, padding: "2px 7px", fontSize: 12, cursor: loading || lloading ? "default" : "pointer", color: C.inkMid, lineHeight: 1.3 }}>
              <span style={{ display: "inline-block", animation: loading || lloading ? "spin 1s linear infinite" : "none" }}>↻</span>
            </button>
          </div>

          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginTop: 6 }}>
            <div style={{ fontFamily: SERIF, fontVariantNumeric: "lining-nums", fontSize: mob ? 42 : 54, fontWeight: 600, color: C.ink, lineHeight: 1, letterSpacing: "-.02em" }}>{usd(m.usdNow)}</div>
            <div style={{ fontSize: 13, color: C.inkMid }}>of {usd(GOAL_USD)} goal · <span style={{ color: C.inkFaint }}>{m.shopFmt(m.sales)}</span></div>
          </div>

          {/* Goal meter: the fill is where we are, the tick is where we should be by now. */}
          <div style={{ position: "relative", height: 10, borderRadius: 5, background: C.card, marginTop: 14 }} role="meter" aria-valuemin={0} aria-valuemax={GOAL_USD} aria-valuenow={Math.round(m.usdNow)} aria-label="Sales against the monthly goal">
            <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${fill * 100}%`, borderRadius: 5, background: paceCol, transition: "width .6s ease" }} />
            {!reached && <div title={`On track by now: ${usd(m.pace)}`} style={{ position: "absolute", left: `calc(${m.elapsed * 100}% - 1px)`, top: -4, bottom: -4, width: 2, borderRadius: 1, background: C.ink }} />}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, color: C.inkFaint, marginTop: 5, gap: 8 }}>
            <span>{Math.round(m.usdNow / GOAL_USD * 100)}% of goal</span>
            {!reached && <span>┃ on track would be {usd(m.pace)} by now</span>}
          </div>

          {/* The push: what the month needs from here. */}
          <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr" : "repeat(3,minmax(0,1fr))", gap: 8, marginTop: 12 }}>
            {[
              reached
                ? ["Goal reached", `${usd(m.usdNow - GOAL_USD)} over`, C.green, "🎉"]
                : [ahead >= 0 ? "Ahead of pace" : "Behind pace", `${usd(Math.abs(ahead))}`, ahead >= 0 ? C.green : C.red, ahead >= 0 ? "▲" : "▼"],
              ["On pace for", m.projection != null ? usd(m.projection) : "—", m.projection != null && m.projection >= GOAL_USD ? C.green : C.ink, null, "if the month keeps this rate"],
              reached
                ? ["Averaging", `${usd(m.avgPerDay)}/day`, C.ink, null, "so far this month"]
                : ["To hit the goal", `${usd(m.needPerDay)}/day`, C.ink, null, `for the last ${plural(m.daysLeft, "day")} · now ${usd(m.avgPerDay)}/day`],
            ].map(([label, value, col, icon, hint]) => (
              <div key={label} style={{ background: C.card, borderRadius: 10, padding: "8px 11px", minWidth: 0 }}>
                <div style={{ fontSize: 10.5, color: C.inkMid, fontWeight: 600 }}>{label}</div>
                <div style={{ fontSize: 17, fontWeight: 750, color: col, marginTop: 1, whiteSpace: "nowrap" }}>{icon && <span style={{ fontSize: 12, marginRight: 4 }}>{icon}</span>}{value}</div>
                {hint && <div style={{ fontSize: 10, color: C.inkFaint, marginTop: 1 }}>{hint}</div>}
              </div>
            ))}
          </div>

          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 10 }}>
            <Delta now={m.usdNow} prev={m.usdPrevSame} label={prevPeriod} money={usd} />
            <span style={{ fontSize: 11, color: C.inkMid }}>{monthLong(m.mPrev)} in full: <b style={{ color: C.ink }}>{usd(m.usdPrev)}</b> · {plural(m.ordersPrev, "order")}</span>
          </div>

          <RaceChart m={m} cumThis={m.cumThis} cumPrev={m.cumPrev} short={usdK} full={usd} goal={GOAL_USD} />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 11, minWidth: 0 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 11 }}>
            <Stat label="Orders" value={m.orders} onClick={go}
              sub={<><Delta now={m.orders} prev={m.ordersPrevSame} label={prevPeriod} /><div style={{ fontSize: 10.5, color: C.inkFaint }}>{plural(m.items, "item")} sold</div></>} />
            <Stat label="Average order" value={m.orders ? usd(m.aov) : "—"}
              sub={<><Delta now={m.aov} prev={m.aovPrev} label={monthShort(m.mPrev)} /><div style={{ fontSize: 10.5, color: C.inkFaint }}>{m.orders ? `${m.shopFmt(m.sales / m.orders)} per order` : "no orders yet"}</div></>} />
          </div>
          <div style={{ ...card, flex: 1 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6, gap: 8 }}>
              <div style={eyebrow}>Last {m.months.length} months</div>
              {(() => {
                const best = m.months.filter(x => !x.current).sort((a, b) => b.usd - a.usd)[0];
                return best && <span style={{ fontSize: 10.5, color: C.inkFaint }}>Best: {best.name} {usd(best.usd)} · {Math.round(best.usd / GOAL_USD * 100)}% of goal</span>;
              })()}
            </div>
            <MonthBars m={m} />
          </div>
        </div>
      </div>

      {/* ── Row 2: what has to go out, and what's left to file ── */}
      <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr" : "minmax(0,1.5fr) minmax(0,1fr)", gap: 11, marginBottom: 11 }}>
        <div style={card}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
            <div style={eyebrow}>To ship · oldest order first</div>
            <span style={{ fontSize: 11, color: C.inkMid }}>{plural(m.unshipped.length, "order")}{m.overdue ? <> · <b style={{ color: C.red }}>⚠ {m.overdue} overdue</b></> : ""}</span>
            <div style={{ flex: 1 }} />
            <button onClick={go} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 11, color: C.gold, fontWeight: 600, padding: 0 }}>Open orders →</button>
          </div>
          {m.unshipped.length === 0 ? (
            <div style={{ fontSize: 12.5, color: C.green, fontWeight: 600, padding: "10px 0" }}>✓ Everything paid for has shipped.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {m.unshipped.slice(0, 8).map(r => {
                const l = r.lines?.[0] || {};
                const more = (r.lines?.length || 1) - 1;
                const waitCol = r.waiting >= 5 ? C.red : r.waiting >= 3 ? C.amber : C.inkMid;
                const ship = r.shipIn == null ? null
                  : r.shipIn < 0 ? [`${-r.shipIn}d overdue`, C.red, C.redBg]
                  : r.shipIn === 0 ? ["Ship today", C.amber, C.amberBg]
                  : r.shipIn === 1 ? ["Ship tomorrow", C.amber, C.amberBg]
                  : [`Ship by ${shortDate(r.ship_by * 1000)}`, C.inkMid, "transparent"];
                return (
                  <div key={r.id} className="pz-row" onClick={go} title={r.note ? `Note from buyer: ${r.note}` : ""} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 8px", borderRadius: 10, cursor: "pointer" }}>
                    {l.img ? <img src={l.img} alt="" loading="lazy" style={{ width: 40, height: 40, borderRadius: 8, objectFit: "cover", flexShrink: 0, background: C.card }} />
                      : <div style={{ width: 40, height: 40, borderRadius: 8, background: C.card, flexShrink: 0 }} />}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.qty > 1 ? `${l.qty} × ` : ""}{l.title || `Order ${r.id}`}{more > 0 ? <span style={{ color: C.inkFaint, fontWeight: 500 }}> +{more} more</span> : ""}</div>
                      <div style={{ fontSize: 11, color: C.inkMid, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {r.buyer || "Buyer"} · {flag(r.country)} {r.country} · ordered {shortDate(r.ms)}{r.gift ? " · 🎁 gift" : ""}{r.note ? " · 💬 note" : ""}
                      </div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3, flexShrink: 0 }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: C.ink }}>{usd(m.toUSD(r.sales))}</span>
                      <div style={{ display: "flex", gap: 4 }}>
                        <span title={`Ordered ${shortDate(r.ms)}`} style={{ fontSize: 10, fontWeight: 700, color: waitCol, whiteSpace: "nowrap" }}>{r.waiting === 0 ? "today" : mob ? `${r.waiting}d` : `${r.waiting}d waiting`}</span>
                        {ship && <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 9, color: ship[1], background: ship[2], border: ship[2] === "transparent" ? `1px solid ${C.border}` : "none", whiteSpace: "nowrap" }}>{ship[0]}</span>}
                      </div>
                    </div>
                  </div>
                );
              })}
              {m.unshipped.length > 8 && <button onClick={go} className="bs" style={{ fontSize: 11.5, marginTop: 6, alignSelf: "flex-start" }}>+{m.unshipped.length - 8} more to ship →</button>}
            </div>
          )}
        </div>

        <div style={card}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
            <div style={eyebrow}>Still to do</div>
            <span style={{ fontSize: 10.5, color: C.inkFaint }}>Etsy orders, last {PENDING_DAYS} days</span>
          </div>
          {stepRows.map(([icon, label, n, hint]) => (
            <div key={label} className="pz-row" onClick={go} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 8px", borderRadius: 10, cursor: "pointer" }}>
              <span style={{ width: 30, height: 30, borderRadius: 8, background: n ? C.amberBg : C.greenBg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, flexShrink: 0 }}>{icon}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: C.ink }}>{label}</div>
                <div style={{ fontSize: 10.5, color: C.inkFaint }}>{n ? `${plural(n, "order")} waiting${hint ? ` · ${hint}` : ""}` : "✓ all done"}</div>
              </div>
              <span style={{ fontFamily: SERIF, fontVariantNumeric: "lining-nums", fontSize: 24, fontWeight: 600, color: n ? C.ink : C.green, minWidth: 28, textAlign: "right" }}>{n || "✓"}</span>
            </div>
          ))}
          {erpOrders && m.pending.total > 0 && (
            <div style={{ marginTop: 8, paddingTop: 10, borderTop: `1px solid ${C.border}` }}>
              <div style={{ height: 6, borderRadius: 3, background: C.card, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${m.pending.done / m.pending.total * 100}%`, background: C.green, borderRadius: 3 }} />
              </div>
              <div style={{ fontSize: 10.5, color: C.inkMid, marginTop: 5 }}>{m.pending.done} of {plural(m.pending.total, "order")} fully done — stock, sales invoice and NG invoice</div>
            </div>
          )}
        </div>
      </div>

      {/* ── Row 3: listings — what's new, and what's about to drop off ── */}
      <ListingsRow lm={lm} err={lerr} loading={lloading} usdRate={m.usdRate} onOpen={() => onEnter("etsy")} onRenew={() => onEnter("etsy", "renew")} />

      {/* ── Row 4: ad spend ── */}
      <div style={{ ...card, display: "grid", gridTemplateColumns: mob ? "1fr" : "minmax(0,1fr) minmax(0,1.5fr)", gap: mob ? 12 : 24 }}>
        <div style={{ minWidth: 0 }}>
          <div style={eyebrow}>Ad spend · {monthLong(m.m0)}</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginTop: 6 }}>
            <div style={{ fontFamily: SERIF, fontVariantNumeric: "lining-nums", fontSize: mob ? 32 : 38, fontWeight: 600, color: C.ink, lineHeight: 1 }}>{rs(m.adsNow.total)}</div>
            <div style={{ fontSize: 12, color: C.inkFaint }}>{usd(m.toUSD(m.adsNow.total))}</div>
          </div>
          <div style={{ marginTop: 6 }}><Delta now={m.adsNow.total} prev={m.adsPrevSame.total} label={prevPeriod} upIsGood={null} money={rs} /></div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 12 }}>
            {[
              ["Per day", rs(m.adsNow.total / Math.max(1, m.day)), "average this month"],
              ["Yesterday", rs(m.yesterday.total), m.yesterday.offsite ? `incl. ${rs(m.yesterday.offsite)} offsite` : "Etsy Ads"],
              ["Share of sales", adsShare != null ? `${(adsShare * 100).toFixed(1)}%` : "—", adsSharePrev != null ? `${monthShort(m.mPrev)}: ${(adsSharePrev * 100).toFixed(1)}%` : ""],
              [`${monthLong(m.mPrev)}`, rs(m.adsPrev.total), m.salesPrev > 0 && m.adsPrev.total > 0 ? `₹${(m.salesPrev / m.adsPrev.total).toFixed(0)} of sales per ₹1` : ""],
            ].map(([label, value, hint]) => (
              <div key={label} style={{ background: C.card, borderRadius: 10, padding: "8px 11px", minWidth: 0 }}>
                <div style={{ fontSize: 10.5, color: C.inkMid, fontWeight: 600 }}>{label}</div>
                <div style={{ fontSize: 16, fontWeight: 750, color: C.ink, marginTop: 1 }}>{value}</div>
                {hint && <div style={{ fontSize: 10, color: C.inkFaint, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{hint}</div>}
              </div>
            ))}
          </div>
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center", marginBottom: 6 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: C.inkMid }}>Last 30 days</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10.5, color: C.inkMid }}><span style={{ width: 10, height: 10, borderRadius: 2, background: ADS }} />Etsy Ads {rs(m.adsNow.etsy)}</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10.5, color: C.inkMid }}><span style={{ width: 10, height: 10, borderRadius: 2, background: OFF }} />Offsite Ads {rs(m.adsNow.offsite)}</span>
            <span style={{ fontSize: 10, color: C.inkFaint }}>this month · as Etsy charged it</span>
          </div>
          <AdBars m={m} />
        </div>
      </div>
    </div>
  );
}
