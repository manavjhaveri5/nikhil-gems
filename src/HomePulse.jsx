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
const LIST_CACHE_KEY = "ng-home-listings-v2";
// Listings change slowly, and a read costs ~10 Etsy calls.
const LIST_FRESH_MS = 30 * 60 * 1000;
// What Etsy charges to list or renew a listing for four months.
const LISTING_FEE_USD = 0.2;
const DAILY_TARGET = 5; // new listings published a day
const PUB_CACHE = "ng-home-published-v1-"; // + year-month: a past month's new listings
const LISTING_MONTHS_BACK = 11;
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
const monthEnd = (d, k = 0) => +monthStart(d, k + 1) - 1; // the month's last millisecond
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

// Listings: new ones by the day they went live, and what's ending or ended.
function buildListingModel(data, nowMs, closed = false) {
  const cal = calendar(nowMs);
  const { now, m0, mPrev, prevCut } = cal;
  // Dated by the listing fee — the day each piece was published — when the
  // ledger could be read; otherwise by the day its draft was made.
  const byFee = data.publishedFrom === "ledger";
  const added = ((byFee ? data.published : data.added) || []).map(a => a.ts * 1000);
  const pub = byFee ? (data.published || []).map(p => ({ id: p.id, ms: p.ts * 1000 })) : [];
  const count = (a, b) => added.filter(t => t >= a && t < b).length;
  const today0 = dayStart(nowMs);
  const weekStart = today0 - ((now.getDay() + 6) % 7) * DAY; // weeks start on Monday
  const dayAt = d => +new Date(m0.getFullYear(), m0.getMonth(), d);
  const daily = [];
  for (let d = 1; d <= cal.day; d++) daily.push(count(dayAt(d), Math.min(dayAt(d + 1), nowMs + 1)));
  const nowS = nowMs / 1000;
  const expiring = data.expiring || [];
  const in7 = expiring.filter(l => l.ends <= nowS + 7 * 86400);
  const expired = data.expiredLately || [];
  return {
    ...cal, byFee, today0, closed, pub, realToday0: dayStart(Date.now()),
    today: count(today0, nowMs + 1), yesterday: count(today0 - DAY, today0),
    week: count(weekStart, nowMs + 1), weekPrev: count(weekStart - 7 * DAY, nowMs - 7 * DAY + 1), weekDays: Math.round((today0 - weekStart) / DAY) + 1,
    month: count(+m0, nowMs + 1), monthPrevSame: count(+mPrev, prevCut), monthPrev: count(+mPrev, +m0),
    daily, hit: daily.filter(n => n >= DAILY_TARGET).length,
    countDay: d0 => count(d0, d0 + DAY),
    recent: byFee ? (data.recent || []).map(r => ({ ...r, ms: r.ts * 1000 })) : [],
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
function RaceChart({ m, cumThis, cumPrev, short, full, goal, closed }) {
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
  // A month that's over ends at the right edge, so its total is labelled there
  // too; the labels at that edge never sit on one another.
  const thisLabelY = closed ? y(last[1]) : -99;
  const clear = (a, ...others) => others.every(b => Math.abs(a - b) > 13);
  const showPrevLabel = clear(prevLabelY, goalLabelY, thisLabelY);
  const showGoalLabel = !!goal && clear(goalLabelY, thisLabelY);
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
          {showGoalLabel && <text x={x(m.daysIn) + 6} y={goalLabelY + 3.5} fontSize={10} fill={C.inkMid} fontWeight={600}>{short(goal)} goal</text>}
          {/* last month, whole */}
          <path d={path(cumPrev.map((v, d) => [d, v]))} fill="none" stroke={PREV} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {showPrevLabel && <text x={x(cumPrev.length - 1) + 6} y={prevLabelY + 3.5} fontSize={10} fill={C.inkMid}>{monthShort(m.mPrev)} {short(prevLast)}</text>}
          {/* this month, so far */}
          <path d={path(thisPts) + `L${x(last[0]).toFixed(1)},${y(0)}L${x(0)},${y(0)}Z`} fill={NOW} fillOpacity={0.1} stroke="none" />
          <path d={path(thisPts)} fill="none" stroke={NOW} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {!closed && <circle cx={x(last[0])} cy={y(last[1])} r={4.5} fill={NOW} stroke={C.surface} strokeWidth={2} />}
          {closed
            ? <text x={x(last[0]) + 6} y={thisLabelY + 3.5} fontSize={10} fontWeight={700} fill={C.ink}>{monthShort(m.m0)} {short(last[1])}</text>
            : <text x={x(last[0])} y={y(last[1]) - 10} textAnchor="middle" fontSize={10.5} fontWeight={700} fill={C.ink}>{short(last[1])}</text>}
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
function MonthBars({ m, sel, onPick }) {
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
            const on = sel == null ? mo.current : mo.key === sel;
            const pickable = onPick?.(mo.key, true);
            return (
              <g key={mo.key}>
                {projTop != null && <path d={barPath(x0, projTop, top - 2, bw)} fill={NOW} fillOpacity={0.14} />}
                <path d={barPath(x0, top, y(0), bw)} fill={on ? NOW : C.borderHi} />
                <text x={cx(i)} y={(projTop ?? top) - 5} textAnchor="middle" fontSize={10} fontWeight={on || mo.usd === best ? 700 : 500} fill={on ? C.ink : C.inkMid}>{usdK(mo.usd)}</text>
                <text x={cx(i)} y={H - 6} textAnchor="middle" fontSize={10} fill={on ? C.ink : C.inkFaint} fontWeight={on ? 700 : 400}>{mo.label}</text>
                <rect x={cx(i) - band / 2} y={PT} width={band} height={CH} fill="transparent" style={{ cursor: pickable ? "pointer" : "default" }}
                  onPointerEnter={() => setHover(i)} onPointerDown={() => setHover(i)} onClick={() => pickable && onPick(mo.key)} />
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

/* ── listings: new each day against the target, and the ones ending ───────── */
const dayName = (ms, today0) => ms === today0 ? "Today" : ms === today0 - DAY ? "Yesterday" : new Date(ms).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
const priceFmt = (v, cur) => {
  if (!(v > 0)) return "";
  try { return new Intl.NumberFormat(cur === "INR" ? "en-IN" : "en-US", { style: "currency", currency: cur || "INR", maximumFractionDigits: 0 }).format(v); } catch { return String(Math.round(v)); }
};
const navBtn = on => ({ width: 24, height: 24, borderRadius: 12, border: `1px solid ${C.border}`, background: C.surface, color: on ? C.ink : C.inkFaint, cursor: on ? "pointer" : "default", fontSize: 14, lineHeight: "20px", padding: 0, opacity: on ? 1 : 0.5, flexShrink: 0 });

// ‹ September › — steps a card back through the months, never past this one.
function MonthNav({ off, min, onChange, children }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <button aria-label="Month before" disabled={off <= min} onClick={() => onChange(off - 1)} style={navBtn(off > min)}>‹</button>
      <div style={eyebrow}>{children}</div>
      <button aria-label="Month after" disabled={off >= 0} onClick={() => onChange(off + 1)} style={navBtn(off < 0)}>›</button>
    </div>
  );
}

// A past month's new listings (and the month before, for comparison), read
// once and kept for a day.
function usePastPublished(off) {
  const [state, setState] = useState({});
  useEffect(() => {
    if (!off) return;
    const m = monthStart(new Date(), off);
    const key = `${PUB_CACHE}${m.getFullYear()}-${m.getMonth() + 1}`;
    const c = readCache(key);
    setState(c ? { key, data: c.data } : { key, loading: true });
    if (c && Date.now() - c.at < DAY) return;
    let gone = false;
    const from = Math.floor(+monthStart(m, -1) / 1000), to = Math.floor(+monthStart(m, 1) / 1000);
    fetch(`/api/etsy?action=published&from=${from}&to=${to}`, { cache: "no-store" })
      .then(r => r.json().catch(() => ({})).then(d => { if (!r.ok || !d.ok) throw new Error(d.error || `Etsy didn't answer (${r.status})`); return d; }))
      .then(d => {
        try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), data: d })); } catch {}
        if (!gone) setState({ key, data: d });
      })
      .catch(e => { if (!gone) setState(s => s.data ? s : { key, err: e.message || "Couldn't reach Etsy" }); });
    return () => { gone = true; };
  }, [off]);
  return state;
}

// Each day of the month as a bar, the target across them. A bar picks the
// day the side list shows.
function DayBars({ lm, sel, onPick }) {
  const [ref, w] = useWidth();
  const [hover, setHover] = useState(null);
  const H = mob ? 150 : 172, PL = 24, PR = 8, PT = 16, PB = 20;
  const CW = Math.max(10, w - PL - PR), CH = H - PT - PB;
  const yMax = niceMax(Math.max(DAILY_TARGET * 1.5, ...lm.daily));
  const y = v => PT + CH * (1 - v / yMax);
  const band = CW / lm.daysIn;
  const bw = Math.max(3, Math.min(16, band - 2)); // a 2px gap between bars
  const cx = d => PL + band * (d - 1) + band / 2;
  const dayMs = d => +new Date(lm.m0.getFullYear(), lm.m0.getMonth(), d);
  const barPath = (x0, top, bottom, width) => {
    const r = Math.min(4, width / 2, Math.max(0, bottom - top));
    return `M${x0},${bottom}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x0 + width - r}Q${x0 + width},${top} ${x0 + width},${top + r}V${bottom}Z`;
  };
  const isToday = d => !lm.closed && d === lm.day;
  const hv = hover != null ? lm.daily[hover - 1] : null;
  return (
    <div ref={ref} style={{ position: "relative", marginTop: 10 }}>
      {w > 0 && (
        <svg width={w} height={H} style={{ display: "block", touchAction: "pan-y" }} onPointerLeave={() => setHover(null)}>
          {[0.5, 1].map(t => (
            <g key={t}>
              <line x1={PL} x2={PL + CW} y1={y(t * yMax)} y2={y(t * yMax)} stroke={C.border} strokeWidth={1} />
              <text x={PL - 6} y={y(t * yMax) + 3.5} textAnchor="end" fontSize={10} fill={C.inkFaint}>{t * yMax}</text>
            </g>
          ))}
          <line x1={PL} x2={PL + CW} y1={y(0)} y2={y(0)} stroke={C.borderHi} strokeWidth={1} />
          {[1, 8, 15, 22, 29].filter(d => d <= lm.daysIn).map(d => (
            <text key={d} x={cx(d)} y={H - 6} textAnchor="middle" fontSize={10} fill={C.inkFaint}>{d}</text>
          ))}
          {lm.daily.map((v, i) => {
            const d = i + 1, x0 = cx(d) - bw / 2, today = isToday(d), picked = sel === dayMs(d);
            return (
              <g key={d}>
                {v > 0
                  ? <path d={barPath(x0, y(v), y(0), bw)} fill={NOW} fillOpacity={today ? 0.55 : 1} stroke={picked ? C.ink : "none"} strokeWidth={1.5} />
                  : <rect x={x0} y={y(0) - 2} width={bw} height={2} rx={1} fill={picked ? C.ink : C.borderHi} />}
                {today && <text x={cx(d)} y={y(v) - 5} textAnchor="middle" fontSize={10.5} fontWeight={700} fill={C.ink}>{v}</text>}
                <rect x={cx(d) - band / 2} y={PT} width={band} height={CH} fill="transparent" style={{ cursor: "pointer" }}
                  onPointerEnter={() => setHover(d)} onPointerDown={() => setHover(d)} onClick={() => onPick(dayMs(d))} />
              </g>
            );
          })}
          <line x1={PL} x2={PL + CW} y1={y(DAILY_TARGET)} y2={y(DAILY_TARGET)} stroke={C.ink} strokeOpacity={0.55} strokeWidth={1.25} strokeDasharray="5 4" pointerEvents="none" />
          <text x={PL + CW} y={y(DAILY_TARGET) - 4} textAnchor="end" fontSize={10} fontWeight={600} fill={C.inkMid} pointerEvents="none">Target {DAILY_TARGET} a day</text>
        </svg>
      )}
      {hover != null && (
        <Tip x={cx(hover)} y={8} w={w}>
          <div style={{ fontWeight: 700 }}>{dayName(dayMs(hover), lm.realToday0)}{isToday(hover) ? " (so far)" : ""}</div>
          <TipRow color={NOW} label="Published" value={hv} />
          <TipRow label={`Target ${DAILY_TARGET}`} value={hv >= DAILY_TARGET ? "✓ met" : `${DAILY_TARGET - hv} short`} />
          {lm.byFee && hv > 0 && <div style={{ color: C.inkFaint, marginTop: 4 }}>Click to list them</div>}
        </Tip>
      )}
    </div>
  );
}

// What went live on one day of the month on show — today, or the month's last
// day, unless a bar or the arrows pick another. Days older than the week the
// pulse sends details for are asked of Etsy as they're opened.
function PublishedList({ lm, sel, setSel, details, need, detailsErr }) {
  const day0 = sel ?? lm.today0;
  const dayPub = lm.pub.filter(p => p.ms >= day0 && p.ms < day0 + DAY).sort((a, b) => b.ms - a.ms);
  const n = lm.byFee ? dayPub.length : lm.countDay(day0);
  const missing = dayPub.filter(p => !details(p.id)).map(p => p.id);
  useEffect(() => { if (missing.length) need(missing); }, [day0, lm, missing.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const first = +lm.m0, last = lm.today0;
  const isToday = day0 === lm.realToday0;
  const left = Math.max(0, DAILY_TARGET - n);
  const go = d => setSel(d === lm.today0 ? null : d);
  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <div style={eyebrow}>Published · {dayName(day0, lm.realToday0)}</div>
        <div style={{ flex: 1 }} />
        <button aria-label="Day before" disabled={day0 <= first} onClick={() => go(day0 - DAY)} style={navBtn(day0 > first)}>‹</button>
        <button aria-label="Day after" disabled={day0 >= last} onClick={() => go(day0 + DAY)} style={navBtn(day0 < last)}>›</button>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginTop: 6 }}>
        <span style={{ fontFamily: SERIF, fontVariantNumeric: "lining-nums", fontSize: 30, fontWeight: 600, color: C.ink, lineHeight: 1 }}>{n}</span>
        <span style={{ fontSize: 12, color: C.inkMid }}>of {DAILY_TARGET}</span>
        <span style={{ fontSize: 11, fontWeight: 700, color: left ? (isToday ? C.amber : C.red) : C.green, marginLeft: "auto" }}>{left ? `${left} ${isToday ? "to go" : "short"}` : "✓ target met"}</span>
      </div>
      <div style={{ height: 6, borderRadius: 3, background: C.card, marginTop: 7, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${Math.min(100, n / DAILY_TARGET * 100)}%`, background: NOW, borderRadius: 3 }} />
      </div>
      {!lm.byFee
        ? <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 10 }}>Etsy's fee record couldn't be read, so the pieces can't be listed — the counts are by the day each draft was made.</div>
        : !dayPub.length
          ? <div style={{ fontSize: 11.5, color: C.inkFaint, marginTop: 10 }}>{`Nothing published ${isToday ? "yet today" : "that day"}.`}</div>
          : <div style={{ marginTop: 8, maxHeight: mob ? "none" : 272, overflowY: "auto", marginRight: -6, paddingRight: 6 }}>
              {missing.length > 0 && detailsErr && <div style={{ fontSize: 10.5, color: C.red, margin: "2px 6px 4px" }}>Couldn't fetch the details from Etsy — {detailsErr}</div>}
              {dayPub.map(p => {
                const r = details(p.id);
                return (
                  <a key={p.id} className="pz-row" href={`https://www.etsy.com/listing/${p.id}`} target="_blank" rel="noreferrer"
                    style={{ display: "flex", gap: 9, alignItems: "center", padding: "6px 6px", borderRadius: 10, textDecoration: "none", color: "inherit" }}>
                    {r?.img
                      ? <img src={r.img} alt="" loading="lazy" style={{ width: 40, height: 40, borderRadius: 8, objectFit: "cover", flexShrink: 0, background: C.card }} />
                      : <span style={{ width: 40, height: 40, borderRadius: 8, background: C.card, flexShrink: 0, animation: r ? "none" : "pulse 1.4s ease infinite" }} />}
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: r ? C.ink : C.inkFaint, lineHeight: 1.3, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{r ? r.title || `Listing ${p.id}` : "Reading from Etsy…"}</div>
                      <div style={{ fontSize: 10.5, color: C.inkFaint, marginTop: 1 }}>
                        {[new Date(p.ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }), r && priceFmt(r.price, r.cur), r?.state && r.state !== "active" ? r.state.replace("_", " ") : ""].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                  </a>
                );
              })}
            </div>}
    </div>
  );
}

function ListingsRow({ lm, err, loading, usdRate, onOpen, onRenew }) {
  const [off, setOff] = useState(0);   // months back from this one
  const [sel, setSel] = useState(null); // a day picked from the chart; null is the month's latest
  const past = usePastPublished(off);
  const pm = useMemo(() => off && past.data
    ? buildListingModel({ ...past.data, publishedFrom: past.data.ledgerError ? "" : "ledger", added: [], recent: [] }, monthEnd(new Date(), off), true)
    : null, [off, past.data]);
  // Listing details by id: the week the pulse sent, then whatever's been asked for.
  const [briefs, setBriefs] = useState({});
  const [briefErr, setBriefErr] = useState("");
  const asked = useRef(new Set());
  const recentById = useMemo(() => new Map((lm?.recent || []).map(r => [r.id, r])), [lm]);
  const details = id => recentById.get(id) || briefs[id];
  const need = ids => {
    const want = ids.filter(id => !asked.current.has(id)).slice(0, 100);
    if (!want.length) return;
    want.forEach(id => asked.current.add(id));
    setBriefErr("");
    fetch(`/api/etsy?action=listing_brief&ids=${want.join(",")}`, { cache: "no-store" })
      .then(r => r.json().catch(() => ({})).then(d => { if (!r.ok || !d.ok) throw new Error(d.error || `Etsy didn't answer (${r.status})`); return d; }))
      .then(d => setBriefs(b => {
        const next = { ...b };
        for (const it of d.items || []) next[it.id] = it;
        // One Etsy no longer has still gets a row, without a picture.
        for (const id of want) if (!next[id]) next[id] = { id, title: "", img: "", price: 0, cur: "", state: "removed" };
        return next;
      }))
      .catch(e => { want.forEach(id => asked.current.delete(id)); setBriefErr(e.message || "Couldn't reach Etsy"); });
  };
  const switchMonth = k => { setOff(k); setSel(null); };

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
  const v = off ? pm : lm; // the month on show; null while a past month loads
  const shown = monthStart(new Date(), off);
  const c = lm.counts;
  const renewUSD = lm.in30 * LISTING_FEE_USD;
  const box = { background: C.card, borderRadius: 10, padding: "9px 12px", minWidth: 0 };
  const big = { fontFamily: SERIF, fontVariantNumeric: "lining-nums", fontSize: mob ? 26 : 30, fontWeight: 600, color: C.ink, lineHeight: 1.1 };
  const of = { fontSize: 12, color: C.inkMid, fontFamily: "inherit", fontWeight: 500, marginLeft: 4 };
  const sub = { fontSize: 10.5, color: C.inkFaint, marginTop: 2 };
  const offNote = (n, off) => !n ? "nothing ending" : off === n ? `auto-renew is off on all ${n} — they'll come off the shop` : `${off} will come off the shop · ${n - off} auto-renew`;
  // The ending and expired rows open the Renew queue, where each is renewed or skipped.
  const renew = onRenew || onOpen;
  const health = [
    ["🟢", "Active", c.active, `listed on Etsy now${c.sold_out ? ` · ${c.sold_out} sold out` : ""}`, null, onOpen],
    ["⏳", "Ending in 7 days", lm.in7, offNote(lm.in7, lm.in7Off), lm.in7Off ? C.red : null, renew],
    ["🗓️", "Ending in 30 days", lm.in30, lm.in30 ? `${offNote(lm.in30, lm.in30Off)} · renewing all ≈ ${usd(renewUSD)} (${rs(renewUSD * usdRate)})` : "nothing ending", lm.in30Off ? C.amber : null, renew],
    ["⛔", "Expired", c.expired, `${lm.expired30} in the last 30 days · ${lm.expired7} this week · renew or skip each →`, null, renew],
  ];
  const pick = ms => setSel(v && ms === v.today0 ? null : ms);

  let body;
  if (!v) {
    body = <div style={{ fontSize: 11.5, color: past.err ? C.red : C.inkFaint, marginTop: 12, minHeight: 120 }}>{past.err ? `Couldn't read ${monthLong(shown)} from Etsy — ${past.err}` : `Reading ${monthLong(shown)} from Etsy…`}</div>;
  } else if (v.closed) {
    // A month that's over: how it finished, against the month before.
    const target = DAILY_TARGET * v.daysIn;
    const best = v.daily.reduce((b, n, i) => n > b.n ? { n, d: i + 1 } : b, { n: 0, d: 0 });
    body = <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 8, marginTop: 10 }}>
        <div style={box}>
          <div style={{ fontSize: 10.5, color: C.inkMid, fontWeight: 600 }}>The month</div>
          <div style={big}>{v.month}<span style={of}>/ {target}</span></div>
          <div style={sub}>{v.month >= target ? <span style={{ color: C.green, fontWeight: 700 }}>✓ target met</span> : `${target - v.month} short of ${DAILY_TARGET} a day`}</div>
        </div>
        <div style={box}>
          <div style={{ fontSize: 10.5, color: C.inkMid, fontWeight: 600 }}>Days at {DAILY_TARGET}+</div>
          <div style={big}>{v.hit}<span style={of}>/ {v.daysIn}</span></div>
          <div style={sub}>{best.n ? `best ${best.n} on ${best.d} ${monthShort(v.m0)}` : "no listings"}</div>
        </div>
        <div style={box}>
          <div style={{ fontSize: 10.5, color: C.inkMid, fontWeight: 600 }}>A day</div>
          <div style={big}>{(v.month / v.daysIn).toFixed(1)}</div>
          <div style={{ marginTop: 2 }}><Delta now={v.month} prev={v.monthPrev} label={monthLong(v.mPrev)} /></div>
        </div>
      </div>
      <div style={{ fontSize: 11, color: C.inkMid, marginTop: 9 }}>
        {monthLong(v.mPrev)}: <b style={{ color: C.ink }}>{plural(v.monthPrev, "new listing")}</b> · {(v.monthPrev / v.daysPrev).toFixed(1)} a day
      </div>
      <DayBars lm={v} sel={sel ?? v.today0} onPick={pick} />
    </>;
  } else {
    const prevPeriod = `${monthShort(v.mPrev)} 1–${new Date(v.prevCut - 1).getDate()}`;
    body = <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 8, marginTop: 10 }}>
        <div style={box}>
          <div style={{ fontSize: 10.5, color: C.inkMid, fontWeight: 600 }}>Today</div>
          <div style={big}>{v.today}<span style={of}>/ {DAILY_TARGET}</span></div>
          <div style={sub}>{v.today >= DAILY_TARGET ? <span style={{ color: C.green, fontWeight: 700 }}>✓ target met</span> : `${DAILY_TARGET - v.today} to go`} · yesterday {v.yesterday}</div>
        </div>
        <div style={box}>
          <div style={{ fontSize: 10.5, color: C.inkMid, fontWeight: 600 }}>This week</div>
          <div style={big}>{v.week}<span style={of}>/ {DAILY_TARGET * v.weekDays}</span></div>
          <div style={{ marginTop: 2 }}><Delta now={v.week} prev={v.weekPrev} label={v.weekDays === 7 ? "last week" : v.weekDays === 1 ? "last Monday" : `last Mon–${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][v.weekDays - 1]}`} /></div>
        </div>
        <div style={box}>
          <div style={{ fontSize: 10.5, color: C.inkMid, fontWeight: 600 }}>This month</div>
          <div style={big}>{v.month}<span style={of}>/ {DAILY_TARGET * v.day}</span></div>
          <div style={{ marginTop: 2 }}><Delta now={v.month} prev={v.monthPrevSame} label={prevPeriod} /></div>
        </div>
      </div>
      <div style={{ fontSize: 11, color: C.inkMid, marginTop: 9 }}>
        <b style={{ color: C.ink }}>{v.hit} of {v.day} day{v.day === 1 ? "" : "s"}</b> at {DAILY_TARGET} or more
        {v.day > 1 ? ` · ${(v.month / v.day).toFixed(1)} a day this month` : ""} · {monthLong(v.mPrev)} {(v.monthPrev / v.daysPrev).toFixed(1)} a day ({plural(v.monthPrev, "new listing")})
      </div>
      <DayBars lm={v} sel={sel ?? v.today0} onPick={pick} />
    </>;
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr" : "minmax(0,1.5fr) minmax(0,1fr)", gap: 11, marginBottom: 11, alignItems: "start" }}>
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <MonthNav off={off} min={-LISTING_MONTHS_BACK} onChange={switchMonth}>New listings · {monthLong(shown)}{off && shown.getFullYear() !== new Date().getFullYear() ? ` ${shown.getFullYear()}` : ""}</MonthNav>
          <span style={{ fontSize: 10.5, color: C.inkFaint }}>{!v || v.byFee ? "published on Etsy, by the day each went live — drafts and renewals don't count" : "by the day each draft was made — Etsy's fee record couldn't be read"}</span>
          <div style={{ flex: 1 }} />
          <button onClick={onOpen} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 11, color: C.gold, fontWeight: 600, padding: 0 }}>Open listings →</button>
        </div>
        {body}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 11, minWidth: 0 }}>
        {v && <PublishedList lm={v} sel={sel} setSel={setSel} details={details} need={need} detailsErr={briefErr} />}
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
  const [soff, setSoff] = useState(0); // the sales card's month, back from this one
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
  /* The sales card can step back through the months the pulse already holds
     (it reads six); a month needs the one before it too, for comparison. The
     cards for shipping, paperwork and ads stay on today. */
  const salesMin = useMemo(() => {
    const from = (cache?.data?.from || 0) * 1000, now = new Date();
    let k = 0;
    while (k > -12 && +monthStart(now, k - 2) >= from - DAY) k--;
    return k;
  }, [cache]);
  const sm = useMemo(() => soff && cache?.data && fx ? { ...buildModel(cache.data, fx, erpOrders, monthEnd(new Date(), soff)), closed: true } : m, [soff, cache, fx, erpOrders, m]);
  const pickMonth = (key, test) => {
    const now = new Date(), k = (new Date(key).getFullYear() - now.getFullYear()) * 12 + new Date(key).getMonth() - now.getMonth();
    if (k > 0 || k < salesMin) return false;
    if (!test) setSoff(k);
    return true;
  };

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

  const reached = sm.usdNow >= GOAL_USD;
  const ahead = sm.usdNow - sm.pace;
  const fill = Math.min(1, sm.usdNow / GOAL_USD);
  const paceCol = reached || ahead >= 0 ? C.green : sm.usdNow >= sm.pace * 0.75 ? C.amber : C.red;
  const prevPeriod = sm.closed ? monthLong(sm.mPrev) : `${monthShort(sm.mPrev)} 1–${new Date(sm.prevCut - 1).getDate()}`;
  const adsShare = m.sales > 0 ? m.adsNow.total / m.sales : null;
  const adsSharePrev = m.salesPrev > 0 ? m.adsPrev.total / m.salesPrev : null;
  const go = () => onEnter("orders");
  const shownYear = sm.m0.getFullYear() !== new Date().getFullYear() ? ` ${sm.m0.getFullYear()}` : "";
  // What the month needs from here — or, for one that's over, how it finished.
  const pushBoxes = sm.closed
    ? [
      reached ? ["Goal reached", `${usd(sm.usdNow - GOAL_USD)} over`, C.green, "🎉"] : ["Short of goal", usd(GOAL_USD - sm.usdNow), C.red, "▼"],
      ["Orders", String(sm.orders), C.ink, null, `${plural(sm.items, "item")} sold`],
      ["Averaged", `${usd(sm.usdNow / sm.daysIn)}/day`, C.ink, null, `over ${plural(sm.daysIn, "day")}`],
    ]
    : [
      reached
        ? ["Goal reached", `${usd(sm.usdNow - GOAL_USD)} over`, C.green, "🎉"]
        : [ahead >= 0 ? "Ahead of pace" : "Behind pace", `${usd(Math.abs(ahead))}`, ahead >= 0 ? C.green : C.red, ahead >= 0 ? "▲" : "▼"],
      ["On pace for", sm.projection != null ? usd(sm.projection) : "—", sm.projection != null && sm.projection >= GOAL_USD ? C.green : C.ink, null, "if the month keeps this rate"],
      reached
        ? ["Averaging", `${usd(sm.avgPerDay)}/day`, C.ink, null, "so far this month"]
        : ["To hit the goal", `${usd(sm.needPerDay)}/day`, C.ink, null, `for the last ${plural(sm.daysLeft, "day")} · now ${usd(sm.avgPerDay)}/day`],
    ];

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
            <MonthNav off={soff} min={salesMin} onChange={setSoff}>Etsy · {monthLong(sm.m0)}{shownYear}{sm.closed ? " · closed" : ` · day ${sm.day} of ${sm.daysIn}`}</MonthNav>
            <div style={{ flex: 1 }} />
            <span title={err ? `Last refresh failed: ${err}` : ""} style={{ fontSize: 10.5, color: err ? C.red : C.inkFaint }}>{err ? "Refresh failed · showing last numbers" : status}</span>
            <button onClick={load} disabled={loading || lloading} title="Refresh from Etsy" aria-label="Refresh from Etsy" style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 7, padding: "2px 7px", fontSize: 12, cursor: loading || lloading ? "default" : "pointer", color: C.inkMid, lineHeight: 1.3 }}>
              <span style={{ display: "inline-block", animation: loading || lloading ? "spin 1s linear infinite" : "none" }}>↻</span>
            </button>
          </div>

          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginTop: 6 }}>
            <div style={{ fontFamily: SERIF, fontVariantNumeric: "lining-nums", fontSize: mob ? 42 : 54, fontWeight: 600, color: C.ink, lineHeight: 1, letterSpacing: "-.02em" }}>{usd(sm.usdNow)}</div>
            <div style={{ fontSize: 13, color: C.inkMid }}>of {usd(GOAL_USD)} goal · <span style={{ color: C.inkFaint }}>{sm.shopFmt(sm.sales)}</span></div>
          </div>

          {/* Goal meter: the fill is where we are, the tick is where we should be by now. */}
          <div style={{ position: "relative", height: 10, borderRadius: 5, background: C.card, marginTop: 14 }} role="meter" aria-valuemin={0} aria-valuemax={GOAL_USD} aria-valuenow={Math.round(sm.usdNow)} aria-label="Sales against the monthly goal">
            <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${fill * 100}%`, borderRadius: 5, background: paceCol, transition: "width .6s ease" }} />
            {!reached && !sm.closed && <div title={`On track by now: ${usd(sm.pace)}`} style={{ position: "absolute", left: `calc(${sm.elapsed * 100}% - 1px)`, top: -4, bottom: -4, width: 2, borderRadius: 1, background: C.ink }} />}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, color: C.inkFaint, marginTop: 5, gap: 8 }}>
            <span>{Math.round(sm.usdNow / GOAL_USD * 100)}% of goal</span>
            {!reached && !sm.closed && <span>┃ on track would be {usd(sm.pace)} by now</span>}
          </div>

          {/* The push: what the month needs from here. */}
          <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr" : "repeat(3,minmax(0,1fr))", gap: 8, marginTop: 12 }}>
            {pushBoxes.map(([label, value, col, icon, hint]) => (
              <div key={label} style={{ background: C.card, borderRadius: 10, padding: "8px 11px", minWidth: 0 }}>
                <div style={{ fontSize: 10.5, color: C.inkMid, fontWeight: 600 }}>{label}</div>
                <div style={{ fontSize: 17, fontWeight: 750, color: col, marginTop: 1, whiteSpace: "nowrap" }}>{icon && <span style={{ fontSize: 12, marginRight: 4 }}>{icon}</span>}{value}</div>
                {hint && <div style={{ fontSize: 10, color: C.inkFaint, marginTop: 1 }}>{hint}</div>}
              </div>
            ))}
          </div>

          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 10 }}>
            <Delta now={sm.usdNow} prev={sm.closed ? sm.usdPrev : sm.usdPrevSame} label={prevPeriod} money={usd} />
            <span style={{ fontSize: 11, color: C.inkMid }}>{monthLong(sm.mPrev)} in full: <b style={{ color: C.ink }}>{usd(sm.usdPrev)}</b> · {plural(sm.ordersPrev, "order")}</span>
          </div>

          <RaceChart m={sm} cumThis={sm.cumThis} cumPrev={sm.cumPrev} short={usdK} full={usd} goal={GOAL_USD} closed={sm.closed} />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 11, minWidth: 0 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 11 }}>
            <Stat label={sm.closed ? `Orders · ${monthShort(sm.m0)}` : "Orders"} value={sm.orders} onClick={go}
              sub={<><Delta now={sm.orders} prev={sm.closed ? sm.ordersPrev : sm.ordersPrevSame} label={prevPeriod} /><div style={{ fontSize: 10.5, color: C.inkFaint }}>{plural(sm.items, "item")} sold</div></>} />
            <Stat label={sm.closed ? `Average order · ${monthShort(sm.m0)}` : "Average order"} value={sm.orders ? usd(sm.aov) : "—"}
              sub={<><Delta now={sm.aov} prev={sm.aovPrev} label={monthShort(sm.mPrev)} /><div style={{ fontSize: 10.5, color: C.inkFaint }}>{sm.orders ? `${sm.shopFmt(sm.sales / sm.orders)} per order` : "no orders yet"}</div></>} />
          </div>
          <div style={{ ...card, flex: 1 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6, gap: 8 }}>
              <div style={eyebrow}>Last {m.months.length} months</div>
              {(() => {
                const best = m.months.filter(x => !x.current).sort((a, b) => b.usd - a.usd)[0];
                return best && <span style={{ fontSize: 10.5, color: C.inkFaint }}>Best: {best.name} {usd(best.usd)} · {Math.round(best.usd / GOAL_USD * 100)}% of goal</span>;
              })()}
            </div>
            <MonthBars m={m} sel={+sm.m0} onPick={pickMonth} />
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
