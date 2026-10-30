import React, { useEffect, useMemo, useRef, useState } from "react";
import { C } from "./ui.jsx";
import { mob, loadK, saveK } from "./utils.js";
import { loadHistory, compare, Section, Thumb, Tag, card, eyebrow, usd, usd2, dayKey, DAY, ADS_URL, SERIF, ETSYADS, SALES } from "./EtsyInsights.jsx";

/* Ads tracker: the Etsy Ads plan (which listings to advertise, which to keep
   off) and how it's going, day by day. What Etsy's API gives, it reads by
   itself: the daily Etsy Ads charges and every order (ads_history). What it
   doesn't give (the budget, clicks, which listings have ads on, and ad
   results per listing) comes from Etsy Ads itself: the daily stats CSV from
   its download button, and screenshots of its listings table, read by the AI
   model. The plan (ng-ads-plan-v1) was first built from two years of
   per-listing ad results; the tracker moves listings between its groups as
   new results come in. */

const PLAN_KEY = "ng-ads-plan-v1", TABLE_KEY = "ng-ads-table-v1", DAILY_KEY = "ng-ads-daily-v1";
const BREAK_EVEN = 2.1;            // sales a $1 of ads must bring back (60% margin, Etsy fees)
const CUT_CLICKS = 60;             // clicks with no sale before a test listing is called
const GROUPS = { winner: ["✅ Ad winner", C.green, C.greenBg], test: ["🧪 Test", C.blue || C.inkMid, C.card], off: ["❌ Keep off", C.red, C.redBg] };

// Why a listing isn't selling, as worked out from its ad results, favourites and price (see the plan's diag).
const DIAG = { "Price too high": C.red, "Listing page": C.amber, "Search photo/title": C.amber, "Low demand": C.inkMid, "Too cheap for ads": C.inkMid };
const FIX = {
  "Price too high": "Lower the price 15–20%, or send an offer to the people who favourited it.",
  "Listing page": "Add a size/scale photo and a video, tighten the first lines of the description, and check the shipping cost and delivery time buyers see.",
  "Search photo/title": "Change the first photo (bright, close, clean background) and start the title with what it is and its size.",
  "Low demand": "Rewrite the title and 13 tags with the words buyers search for, or accept it's a niche piece and keep it out of ads.",
  "Too cheap for ads": "It sells on its own; keep ads off it.",
};

const norm = s => String(s || "").toLowerCase().replace(/&quot;|&#39;|&amp;/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
const fmt = k => new Date(k + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const daysAgo = ms => Math.floor((Date.now() - ms) / DAY);

// A title from a screenshot is often cut short ("…"), so a listing matches when its title starts with it.
function bestMatch(title, cands) {
  const t = norm(title.replace(/[….]+$/, "")), words = t.split(" ");
  const head = words.length > 3 ? words.slice(0, -1).join(" ") : t;     // the last word may be cut mid-way
  let best = null;
  for (const c of cands) {
    const n = c.n;
    let score = n.startsWith(head) || (n.length > 20 && head.startsWith(n)) ? 1 + Math.min(n.length, head.length) / 1000 : 0;
    if (!score) {
      const a = new Set(words), b = new Set(n.split(" "));
      const inter = [...a].filter(w => b.has(w)).length;
      score = inter / Math.max(1, a.size) * 0.95;
    }
    if (!best || score > best.score) best = { c, score };
  }
  return best && best.score >= 0.75 ? best.c : null;
}

// The Etsy Ads daily stats CSV: "Date (ET)",Views,Clicks,Orders,Revenue (USD),Spend (USD),ROAS,Click rate,Ending budget (USD)
function parseDailyCsv(text) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  const cells = line => { const out = []; let cur = "", q = false; for (const ch of line) { if (ch === '"') q = !q; else if (ch === "," && !q) { out.push(cur); cur = ""; } else cur += ch; } out.push(cur); return out; };
  const head = cells(lines[0]).map(h => h.toLowerCase());
  const col = re => head.findIndex(h => re.test(h));
  const ix = { d: col(/^date/), v: col(/^views/), c: col(/^clicks/), o: col(/^orders/), r: col(/^revenue/), s: col(/^spend/), b: col(/budget/) };
  if (ix.d < 0 || ix.s < 0) throw new Error("That isn't the Etsy Ads stats file (no Date or Spend column).");
  const num = v => +String(v || "").replace(/[^0-9.\-]/g, "") || 0;
  const out = {};
  for (const line of lines.slice(1)) {
    const c = cells(line), t = Date.parse(c[ix.d]);
    if (!isFinite(t)) continue;
    out[dayKey(t)] = { views: num(c[ix.v]), clicks: num(c[ix.c]), orders: num(c[ix.o]), rev: num(c[ix.r]), spend: num(c[ix.s]), budget: ix.b >= 0 ? num(c[ix.b]) : null };
  }
  return out;
}

// A screenshot, shrunk to a JPEG the model can read.
const toJpeg = file => new Promise((res, rej) => {
  const img = new Image(), url = URL.createObjectURL(file);
  img.onload = () => {
    const s = Math.min(1, 1800 / Math.max(img.width, img.height)), cv = document.createElement("canvas");
    cv.width = Math.round(img.width * s); cv.height = Math.round(img.height * s);
    cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
    URL.revokeObjectURL(url);
    res(cv.toDataURL("image/jpeg", 0.85).split(",")[1]);
  };
  img.onerror = () => { URL.revokeObjectURL(url); rej(new Error(`${file.name || "That image"} couldn't be opened.`)); };
  img.src = url;
});

const READ_PROMPT = `These are screenshots of the Etsy Ads "Listings" table. Read every listing row.
Return only JSON: {"range": "<the date range shown at the top, if visible, else empty>", "rows": [{"title": "<listing title exactly as shown, including any trailing …>", "status": "<badge under the title: Expired, Sold out, Inactive, or empty>", "on": <true if the Ad on/off switch shows a tick (on), false if it shows an X (off)>, "views": <number; 22.9K means 22900>, "clicks": <number>, "orders": <number>, "revenue": <US$ number>, "spend": <US$ number>}]}
Numbers without currency signs or commas. Don't skip or invent rows.`;

async function readScreenshots(files) {
  const rows = [];
  let range = "";
  for (let i = 0; i < files.length; i += 4) {
    const imgs = await Promise.all(files.slice(i, i + 4).map(toJpeg));
    const r = await fetch("/api/claude", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4.1", max_tokens: 8000, messages: [{ role: "user", content: [{ type: "text", text: READ_PROMPT }, ...imgs.map(data => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } }))] }] }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error?.message || `The reader didn't answer (${r.status})`);
    const text = (d.content || []).map(c => c.text || "").join("");
    const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    range ||= json.range || "";
    rows.push(...(json.rows || []));
  }
  return { range, rows };
}

const pct = (v, max) => `${Math.max(0, Math.min(100, max ? v / max * 100 : 0))}%`;
// A chart's top, as four round steps.
const niceMax = v => { const q = Math.max(v, 1e-9) / 4, p = 10 ** Math.floor(Math.log10(q)); return [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(m => m * p >= q) * p * 4; };
const big = { fontFamily: SERIF, fontVariantNumeric: "lining-nums", fontSize: 30, fontWeight: 600, color: C.ink, lineHeight: 1.05, marginTop: 4 };
const small = { fontSize: 11.5, color: C.inkMid, marginTop: 3, lineHeight: 1.4 };
const Dot = ({ color, size = 8 }) => <i style={{ display: "inline-block", width: size, height: size, borderRadius: size, background: color, flexShrink: 0 }} />;

// How much of something is done, as a ring.
function Ring({ value, max, color, size = 54 }) {
  const r = (size - 8) / 2, c = 2 * Math.PI * r, f = max ? Math.min(1, value / max) : 0, m = size / 2;
  return (
    <svg width={size} height={size} style={{ flexShrink: 0 }}>
      <circle cx={m} cy={m} r={r} fill="none" stroke={C.card} strokeWidth={7} />
      {f > 0 && <circle cx={m} cy={m} r={r} fill="none" stroke={color} strokeWidth={7} strokeLinecap="round" strokeDasharray={`${f * c} ${c}`} transform={`rotate(-90 ${m} ${m})`} />}
      <text x={m} y={m} dy=".35em" textAnchor="middle" fontSize={12} fontWeight={800} fill={C.ink}>{Math.round(f * 100)}%</text>
    </svg>
  );
}

// Sales back per $1 of ads on a scale: under 1× loses outright, under break-even loses after costs, past it pays.
function RoasMeter({ value }) {
  const max = Math.max(5, Math.ceil((value || 0) * 1.15));
  return (
    <div style={{ position: "relative", height: 28, marginTop: 10 }}>
      <div style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden" }}>
        <div style={{ width: pct(1, max), background: C.redBg }} />
        <div style={{ width: pct(BREAK_EVEN - 1, max), background: C.amberBg }} />
        <div style={{ flex: 1, background: C.greenBg }} />
      </div>
      <div style={{ position: "absolute", left: pct(BREAK_EVEN, max), top: -3, height: 14, borderLeft: `2px solid ${C.ink}` }} />
      <div style={{ position: "absolute", left: pct(BREAK_EVEN, max), top: 13, transform: "translateX(-50%)", fontSize: 10, color: C.inkFaint, whiteSpace: "nowrap" }}>{BREAK_EVEN}× pays</div>
      {value != null && <div style={{ position: "absolute", left: pct(value, max), top: -4, width: 16, height: 16, marginLeft: -8, borderRadius: 8, background: value >= BREAK_EVEN ? C.green : value >= 1 ? C.amber : C.red, border: `2.5px solid ${C.surface}`, boxShadow: "0 1px 4px rgba(0,0,0,.25)" }} />}
    </div>
  );
}

// The last two weeks of ad spend, one bar a day.
function Spark({ rows }) {
  const max = Math.max(1, ...rows.map(r => r.spend));
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 26, marginTop: 10 }}>
      {rows.map(r => <div key={r.k} title={`${fmt(r.k)}: ${usd2(r.spend)}`} style={{ flex: 1, height: r.spend > 0 ? `${Math.max(12, r.spend / max * 100)}%` : 3, background: r.spend > 0 ? ETSYADS : C.border, borderRadius: 2 }} />)}
    </div>
  );
}

/* Day by day: ad spend as bars against Etsy's budget (step line) and the plan's,
   with whole-shop sales (7-day average) on the right scale, and the restart marked. */
function DailyChart({ rows, start, planBudget }) {
  const [hover, setHover] = useState(null);
  const W = 1000, H = 230, PL = 42, PR = 50, PT = 18, PB = 24, CW = W - PL - PR, CH = H - PT - PB, n = rows.length;
  const aMax = niceMax(Math.max(planBudget, ...rows.map(r => Math.max(r.spend, r.budget || 0))) * 1.08);
  const avg = rows.map((_, i) => { const w = rows.slice(Math.max(0, i - 6), i + 1); return w.reduce((s, d) => s + d.sales, 0) / w.length; });
  const sMax = niceMax(Math.max(1, ...avg) * 1.1);
  const slot = CW / Math.max(1, n), bw = Math.max(2, slot * 0.58);
  const x = i => PL + i * slot + slot / 2, yA = v => PT + CH * (1 - v / aMax), yS = v => PT + CH * (1 - v / sMax);
  const sales = avg.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${yS(v).toFixed(1)}`).join("");
  let bud = "", run = false;
  rows.forEach((r, i) => {
    if (r.budget == null) { run = false; return; }
    const y = yA(r.budget).toFixed(1), x1 = (PL + (i + 1) * slot).toFixed(1);
    bud += run ? `V${y}H${x1}` : `M${(PL + i * slot).toFixed(1)},${y}H${x1}`; run = true;
  });
  const si = start ? rows.findIndex(r => r.k >= start) : -1, every = Math.max(1, Math.ceil(n / 8));
  const h = hover != null ? rows[hover] : null;
  const key = (el, label) => <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>{el}{label}</span>;
  return (
    <div style={{ position: "relative" }}>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 11.5, color: C.inkMid, marginBottom: 6 }}>
        {key(<i style={{ width: 10, height: 10, borderRadius: 2, background: ETSYADS }} />, "Ad spend a day")}
        {key(<i style={{ width: 14, borderTop: `2px dashed ${C.ink}` }} />, "Etsy's daily budget")}
        {key(<i style={{ width: 14, borderTop: `2px dotted ${C.gold}` }} />, `Plan ${usd(planBudget)}/day`)}
        {key(<i style={{ width: 14, height: 2.5, background: SALES }} />, "Shop sales a day, 7-day average (right)")}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block", touchAction: "pan-y" }}
        onPointerMove={e => { const r = e.currentTarget.getBoundingClientRect(); const i = Math.floor(((e.clientX - r.left) / r.width * W - PL) / slot); setHover(i >= 0 && i < n ? i : null); }}
        onPointerLeave={() => setHover(null)}>
        {[0.25, 0.5, 0.75, 1].map(f => (
          <g key={f}>
            <line x1={PL} x2={W - PR} y1={yA(f * aMax)} y2={yA(f * aMax)} stroke={C.border} />
            <text x={PL - 6} y={yA(f * aMax) + 4} textAnchor="end" fontSize={11} fill={ETSYADS}>${Math.round(f * aMax)}</text>
            <text x={W - PR + 6} y={yS(f * sMax) + 4} fontSize={11} fill={SALES}>${Math.round(f * sMax)}</text>
          </g>
        ))}
        {si > 0 && <rect x={PL + si * slot} y={PT} width={CW - si * slot} height={CH} fill={C.greenBg} opacity={.45} />}
        {hover != null && <rect x={PL + hover * slot} y={PT} width={slot} height={CH} fill={C.card} />}
        {rows.map((r, i) => r.spend > 0 && <rect key={r.k} x={x(i) - bw / 2} y={yA(r.spend)} width={bw} height={yA(0) - yA(r.spend)} fill={ETSYADS} opacity={hover === i ? 1 : .8} rx={1.5} />)}
        <line x1={PL} x2={W - PR} y1={yA(planBudget)} y2={yA(planBudget)} stroke={C.gold} strokeWidth={2} strokeDasharray="2 4" />
        {bud && <path d={bud} fill="none" stroke={C.ink} strokeWidth={1.6} strokeDasharray="6 4" />}
        <path d={sales} fill="none" stroke={SALES} strokeWidth={2.5} strokeLinejoin="round" />
        {si > 0 && <g><line x1={PL + si * slot} x2={PL + si * slot} y1={PT - 4} y2={PT + CH} stroke={C.green} strokeWidth={1.5} /><text x={PL + si * slot + 5} y={PT + 6} fontSize={11} fontWeight={800} fill={C.green}>Restart · {fmt(rows[si].k)}</text></g>}
        {rows.map((r, i) => i % every === 0 && <text key={r.k} x={x(i)} y={H - 7} textAnchor="middle" fontSize={11} fill={C.inkFaint}>{fmt(r.k)}</text>)}
      </svg>
      {h && (
        <div style={{ position: "absolute", top: 30, left: `${Math.min(68, Math.max(2, (x(hover) / W) * 100 - 12))}%`, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 9, padding: "8px 10px", fontSize: 12, boxShadow: "0 4px 14px rgba(0,0,0,.08)", pointerEvents: "none", minWidth: 180 }}>
          <div style={{ fontWeight: 800, color: C.ink, marginBottom: 3 }}>{new Date(h.k + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}</div>
          <div style={{ color: ETSYADS }}>Ad spend <b>{usd2(h.spend)}</b>{h.budget != null ? ` of ${usd2(h.budget)}` : ""}</div>
          {h.clicks != null && <div style={{ color: C.inkMid }}>{h.clicks} clicks · {h.adOrders} ad orders · {usd(h.adRev)}</div>}
          <div style={{ color: SALES }}>Shop <b>{usd(h.sales)}</b> · {h.orders} order{h.orders === 1 ? "" : "s"}</div>
        </div>
      )}
    </div>
  );
}

// A labelled horizontal bar on a shared scale.
function Bar({ value, max, color, height = 8 }) {
  return <div style={{ height, background: C.card, borderRadius: height / 2, overflow: "hidden" }}><div style={{ width: pct(value, max), height: "100%", background: color, borderRadius: height / 2 }} /></div>;
}

export default function AdsTracker({ listings = [] }) {
  const [plan, setPlan] = useState(null), [table, setTable] = useState(null), [daily, setDaily] = useState(null), [hist, setHist] = useState(null);
  const [busy, setBusy] = useState(""), [msg, setMsg] = useState(null);
  const [show, setShow] = useState("on"), [page, setPage] = useState(0), [diagF, setDiagF] = useState(null), [how, setHow] = useState(false);
  const shotRef = useRef(null), csvRef = useRef(null), tableRef = useRef(null), feedRef = useRef(null);

  useEffect(() => {
    loadK(PLAN_KEY).then(v => setPlan(v && v.items ? v : { items: [], history: [] })).catch(() => setPlan({ items: [], history: [] }));
    loadK(TABLE_KEY).then(v => setTable(v && v.rows ? v : { rows: {} })).catch(() => setTable({ rows: {} }));
    loadK(DAILY_KEY).then(v => setDaily(v && typeof v === "object" && !Array.isArray(v) ? v : {})).catch(() => setDaily({}));
    loadHistory(setHist);
  }, []);
  const savePlan = next => { setPlan(next); saveK(PLAN_KEY, next, { merge: false }).catch(() => {}); };

  // ERP listings by Etsy id: title, photo, and whether it's still for sale.
  const erp = useMemo(() => {
    const m = {};
    for (const l of listings) { const e = l.platforms?.etsy; if (e?.listing_id) m[String(e.listing_id)] = { title: l.title, img: (l.images || [])[0], state: e.expired ? "expired" : (e.status || "") }; }
    return m;
  }, [listings]);

  const t = useMemo(() => {
    if (!plan || !table || !daily) return null;
    const today = dayKey(Date.now());
    // Daily spend: Etsy's own stats where uploaded, else the ledger's charge.
    const ledger = Object.fromEntries((hist?.days || []).map(d => [d.k, d]));
    const keys = [...new Set([...Object.keys(ledger), ...Object.keys(daily)])].filter(k => k < today).sort();
    const spendOf = k => daily[k]?.spend ?? ledger[k]?.etsy ?? 0;
    // When the ads came back on: the first charged day after three or more quiet ones.
    let restart = null, lastOn = null;
    for (let i = keys.length - 1; i >= 0; i--) {
      if (spendOf(keys[i]) > 0) { lastOn ||= keys[i]; continue; }
      if (lastOn) {
        const quiet = keys.slice(Math.max(0, i - 2), i + 1).every(k => !(spendOf(k) > 0));
        if (quiet) { restart = keys[i + 1]; break; }
      }
    }
    const off = !lastOn || daysAgo(Date.parse(lastOn + "T12:00:00")) > 2;
    // While the ads are off, the last run is over: "since the restart" waits for the next one.
    const start = plan.startDate || (off ? null : restart);
    const budget = [...keys].reverse().map(k => daily[k]?.budget).find(b => b > 0) || null;
    const planBudget = plan.budget || 25;
    const want = Math.round(planBudget * 2.5);

    // Every day since the restart, and the four weeks before it to compare against.
    const rowOf = k => ({ k, spend: spendOf(k), budget: daily[k]?.budget ?? null, clicks: daily[k]?.clicks ?? null, adOrders: daily[k]?.orders ?? null, adRev: daily[k]?.rev ?? null, sales: ledger[k]?.sales || 0, orders: ledger[k]?.orders || 0 });
    const since = start ? keys.filter(k => k >= start).map(rowOf) : [];
    const before = start ? keys.filter(k => k < start).slice(-28).map(rowOf) : [];
    const sum = (a, f) => a.reduce((s, d) => s + (f(d) || 0), 0);
    const cmp = since.length >= 4 && before.length >= 7 ? compare(before.map(d => d.sales), since.map(d => d.sales)) : null;
    const hasEtsy = since.some(d => d.clicks != null);
    // The chart: four weeks before the restart through yesterday (or the last eight weeks).
    const chartFrom = start ? dayKey(Date.parse(start + "T12:00:00") - 28 * DAY) : dayKey(Date.now() - 56 * DAY);
    const chart = keys.filter(k => k >= chartFrom).map(rowOf);

    // The listings table from the screenshots, matched to the plan.
    const cands = [...plan.items.map(i => ({ id: i.id, n: norm(i.title) })), ...Object.entries(erp).map(([id, e]) => ({ id, n: norm(e.title) }))];
    const shot = {};
    for (const r of Object.values(table.rows || {})) { const m = r.id ? { id: r.id } : bestMatch(r.title, cands); if (m) shot[m.id] = r; }
    const soldSince = {};
    for (const x of hist?.lines || []) if (start && x.k >= start) { soldSince[x.lid] ||= { n: 0, v: 0 }; soldSince[x.lid].n += x.qty; soldSince[x.lid].v += x.price * x.qty; }

    const forSale = id => !erp[id] || ["active", ""].includes(erp[id].state);
    const ranked = plan.items.filter(i => i.group !== "off" && forSale(i.id)).sort((a, b) => (a.group === "winner" ? 0 : 1) - (b.group === "winner" ? 0 : 1) || (a.rank || 999) - (b.rank || 999));
    const shouldOn = new Set(ranked.slice(0, want).map(i => i.id));
    const items = plan.items.map(i => {
      const s = shot[i.id], on = s ? !!s.on : i.on ?? null, sold = soldSince[i.id];
      const roas = s?.spend > 0 ? s.revenue / s.spend : null;
      let act = null, tone = C.inkMid, note = "";
      if (on && !forSale(i.id)) { act = "Turn off: not for sale"; tone = C.red; }
      else if (on && i.group === "off") { act = "Turn off: on the keep-off list"; tone = C.red; }
      else if (on && s && i.group === "test" && s.clicks >= CUT_CLICKS && !s.orders) { act = `Turn off: ${s.clicks} clicks, no sale`; tone = C.red; }
      else if (on && s && i.group === "winner" && s.clicks >= 100 && roas != null && roas < 1) { act = `Watch: ${s.clicks} clicks, ${roas.toFixed(1)}× back`; tone = C.amber; }
      else if (on === false && shouldOn.has(i.id)) { act = "Turn on"; tone = C.green; }
      else if (on === null && shouldOn.has(i.id)) { act = "Switch on in Etsy Ads"; tone = C.green; }
      if (on && s && s.orders > 0 && roas != null) note = roas >= BREAK_EVEN ? `Working: ${roas.toFixed(1)}× back` : `${roas.toFixed(1)}× back, under ${BREAK_EVEN}×`;
      else if (on && s) note = `Learning: ${s.clicks} clicks`;
      const promote = i.group === "test" && s && s.orders >= 1 && roas >= BREAK_EVEN;
      return { ...i, img: i.img || erp[i.id]?.img, state: erp[i.id]?.state, sale: forSale(i.id), s, on, sold, roas, act, tone, note, promote, demote: i.group === "test" && act?.startsWith("Turn off:") && s?.clicks >= CUT_CLICKS, should: shouldOn.has(i.id) };
    });
    // Listings with ads on that aren't in the plan at all.
    const planIds = new Set(plan.items.map(i => i.id));
    const strays = Object.entries(shot).filter(([id, r]) => r.on && !planIds.has(id)).map(([id, r]) => ({ id, ...r, state: erp[id]?.state }));
    const onCount = items.filter(i => i.on).length, followed = items.filter(i => i.should && i.on).length;
    return { start, restart, off, lastOn, budget, planBudget, want, since, before, chart, cmp, hasEtsy, items, strays, onCount, followed,
      spend: sum(since, d => d.spend), adRev: sum(since, d => d.adRev), adOrders: sum(since, d => d.adOrders), clicks: sum(since, d => d.clicks),
      salesDay: since.length ? sum(since, d => d.sales) / since.length : 0, salesDayBefore: before.length ? sum(before, d => d.sales) / before.length : 0,
      tableAge: table.at ? daysAgo(table.at) : null, csvAge: Object.keys(daily).length ? daysAgo(Date.parse(Object.keys(daily).sort().pop() + "T12:00:00")) : null };
  }, [plan, table, daily, hist, erp]);

  const onShots = async files => {
    files = [...files].filter(f => /^image\//.test(f.type));
    if (!files.length) return;
    setBusy(`Reading ${files.length} screenshot${files.length > 1 ? "s" : ""}…`); setMsg(null);
    try {
      const { range, rows } = await readScreenshots(files);
      const next = { at: Date.now(), range: range || table?.range || "", rows: { ...(table?.rows || {}) } };
      for (const r of rows) if (r.title) next.rows[norm(r.title).slice(0, 60)] = { ...r, seen: Date.now() };
      setTable(next); await saveK(TABLE_KEY, next, { merge: false });
      setMsg({ ok: true, text: `Read ${rows.length} listings${range ? ` (${range})` : ""}.` });
    } catch (e) { setMsg({ ok: false, text: e.message || "Couldn't read those screenshots." }); }
    setBusy("");
  };
  const onCsv = async file => {
    if (!file) return;
    setBusy("Reading the stats file…"); setMsg(null);
    try {
      const rows = parseDailyCsv(await file.text());
      const next = { ...(daily || {}), ...rows };
      setDaily(next); await saveK(DAILY_KEY, next, { merge: false });
      setMsg({ ok: true, text: `Added ${Object.keys(rows).length} days of Etsy Ads stats.` });
    } catch (e) { setMsg({ ok: false, text: e.message }); }
    setBusy("");
  };
  useEffect(() => {
    const paste = e => { const f = [...(e.clipboardData?.files || [])]; if (f.length) { e.preventDefault(); onShots(f); } };
    window.addEventListener("paste", paste);
    return () => window.removeEventListener("paste", paste);
  });

  const move = (id, group, why) => savePlan({ ...plan, items: plan.items.map(i => i.id === id ? { ...i, group, why: why || i.why } : i), history: [...(plan.history || []), { at: new Date().toISOString(), id, group }] });
  const markOn = (id, on) => savePlan({ ...plan, items: plan.items.map(i => i.id === id ? { ...i, on } : i) });

  if (!plan || !t) return <div style={{ padding: 40, color: C.inkFaint }}>Loading the ads plan…</div>;
  if (!plan.items.length) return <div style={{ padding: 40, color: C.inkMid }}>No ads plan saved yet.</div>;

  const lists = {
    todo: t.items.filter(i => i.act || i.promote),
    on: t.items.filter(i => i.should),
    off: t.items.filter(i => i.group === "off"),
    work: t.items.filter(i => i.diag?.length).sort((a, b) => (b.past?.spend || 0) - (a.past?.spend || 0)),
    all: t.items,
  };
  const sum = (a, f) => a.reduce((s, x) => s + (f(x) || 0), 0);
  const list = show === "work" && diagF ? lists.work.filter(i => i.diag.some(d => d.k === diagF)) : lists[show];
  const per = 15, pages = Math.max(1, Math.ceil(list.length / per)), pg = Math.min(page, pages - 1);
  const go = k => { setShow(k); setPage(0); setDiagF(null); tableRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); };
  const pill = (k, label) => (
    <button key={k} onClick={() => { setShow(k); setPage(0); setDiagF(null); }} style={{ border: `1.5px solid ${show === k ? C.ink : C.border}`, background: show === k ? C.ink : C.surface, color: show === k ? C.surface : C.inkMid, borderRadius: 10, padding: "6px 12px", fontSize: 12.5, fontWeight: 800, cursor: "pointer" }}>{label} · {lists[k].length}</button>
  );
  const btn = { border: `1px solid ${C.border}`, background: C.surface, borderRadius: 8, padding: "5px 10px", fontSize: 11.5, fontWeight: 800, cursor: "pointer", color: C.ink, textDecoration: "none", whiteSpace: "nowrap" };
  const dark = { ...btn, background: C.ink, color: C.surface, border: "none", padding: "7px 12px" };
  const th = { color: C.inkFaint, fontSize: 10.5, textTransform: "uppercase", letterSpacing: .6, textAlign: "right", fontWeight: 800, padding: "0 0 6px 8px", whiteSpace: "nowrap" };
  const td = { padding: "7px 0 7px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums", borderTop: `1px solid ${C.border}`, verticalAlign: "middle" };
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  // A title's name part: "Clear Quartz Sphere: …" → "Clear Quartz Sphere", skipping a leading size like "35–40mm".
  const short = s => { const parts = s.split(/: | \| | [–—-] |, /).map(x => x.trim()); return (parts.find(x => /[a-z]{4,}/i.test(x.replace(/\d+\s*(mm|cm|g|kg|in|inch)\b/gi, ""))) || parts[0]).slice(0, 48); };

  // What to change in Etsy Ads now, most costly first.
  const turnOn = t.items.filter(i => /^(Turn on|Switch on)/.test(i.act || "")).length;
  const turnOff = t.items.filter(i => i.act?.startsWith("Turn off")).length;
  const decided = t.items.filter(i => i.promote || i.demote).length;
  const doNow = [];
  if (t.budget && Math.abs(t.budget - t.planBudget) >= 1) doNow.push({ tone: C.red, head: `Set the daily budget to ${usd2(t.planBudget)}`, sub: `Etsy Ads has it at ${usd2(t.budget)}. Etsy Ads → Settings → Daily budget.`, href: ADS_URL });
  if (turnOn) doNow.push({ tone: C.green, head: `Switch on ${plural(turnOn, "listing")}`, sub: t.tableAge == null ? "Tick each one in the list as you go, or add a screenshot and it ticks them itself." : "In the plan, but off in Etsy Ads.", go: "todo" });
  if (turnOff) doNow.push({ tone: C.red, head: `Switch off ${plural(turnOff, "listing")}`, sub: "Sold out, expired, on the keep-off list, or failed its test.", go: "todo" });
  if (t.strays.length) doNow.push({ tone: C.red, head: `Switch off ${plural(t.strays.length, "listing")} outside the plan`, sub: t.strays.slice(0, 3).map(s => short(s.title)).join(" · ") + (t.strays.length > 3 ? " …" : "") });
  if (decided) doNow.push({ tone: C.ink, head: `${plural(decided, "test")} decided`, sub: "Move each to winners or keep-off.", go: "todo" });
  if (t.tableAge == null || t.tableAge >= 4) doNow.push({ tone: C.amber, head: t.tableAge == null ? "Add a screenshot of Etsy Ads → Listings" : `Refresh the listings screenshot (${t.tableAge} days old)`, sub: "So it knows which listings are on and how each one is doing.", feed: true });
  if (t.csvAge == null || t.csvAge >= 3) doNow.push({ tone: C.amber, head: "Download a fresh Etsy Ads stats file", sub: t.csvAge == null ? "For the budget, clicks and Etsy's own ad sales." : `The one here stops ${t.csvAge} days ago.`, feed: true });

  // How it's going, in a few lines.
  const news = [];
  const roasNow = t.hasEtsy && t.spend > 0 ? t.adRev / t.spend : null;
  if (t.off) news.push({ tone: C.red, text: <>Ads <b>aren't spending</b>{t.lastOn ? `: nothing charged since ${fmt(t.lastOn)}` : ""}.</> });
  else if (t.start) news.push({ tone: C.green, text: <>Back on since <b>{fmt(t.start)}</b>: {usd2(t.spend)} over {plural(t.since.length, "day")}, {usd2(t.spend / Math.max(1, t.since.length))}/day.</> });
  if (roasNow != null) news.push({ tone: roasNow >= BREAK_EVEN ? C.green : C.amber, text: <>Etsy counts <b>{plural(t.adOrders, "ad order")}</b>, {usd(t.adRev)} from {t.clicks} clicks: <b>{roasNow.toFixed(1)}×</b>.</> });
  if (t.since.length) news.push({ tone: t.salesDay >= t.salesDayBefore ? C.green : C.amber, text: <>Shop sales <b>{usd(t.salesDay)}/day</b>, against {usd(t.salesDayBefore)}/day before{t.cmp && t.since.length < 14 ? " (firmer after two weeks)" : ""}.</> });
  const sold = t.items.filter(i => i.sold && i.group !== "off");
  if (sold.length) news.push({ tone: C.green, text: <>Sold from the plan: {sold.slice(0, 3).map(i => `${short(i.title)} (${usd(i.sold.v)})`).join(", ")}{sold.length > 3 ? ` +${sold.length - 3}` : ""}.</> });
  if (!news.length) news.push({ tone: C.inkMid, text: "Nothing new yet." });

  // The plan's shape, each group's two-year ad record, and why listings don't sell.
  const comp = [
    ["Winners, on", C.green, t.items.filter(i => i.should && i.group === "winner").length],
    ["Tests, on", C.blue, t.items.filter(i => i.should && i.group === "test").length],
    ["Tests, waiting", C.blueBg, t.items.filter(i => i.group === "test" && !i.should && i.sale).length],
    ["Not for sale", C.amber, t.items.filter(i => i.group !== "off" && !i.sale).length],
    ["Keep off", C.red, t.items.filter(i => i.group === "off").length],
  ].filter(c => c[2]);
  const compN = sum(comp, c => c[2]);
  const rec = ["winner", "off"].map(g => { const a = plan.items.filter(i => i.group === g); return { g, n: a.length, sp: sum(a, i => i.past?.spend), rv: sum(a, i => i.past?.rev) }; });
  const recMax = Math.max(1, ...rec.map(r => Math.max(r.sp, r.rv)));
  const reasons = Object.keys(FIX).map(k => { const a = lists.work.filter(i => i.diag.some(d => d.k === k)); return { k, n: a.length, sp: sum(a, i => i.past?.spend), rv: sum(a, i => i.past?.rev) }; }).filter(r => r.n);
  const rMax = Math.max(1, ...reasons.map(r => r.n));
  const best = t.items.filter(i => i.group === "winner" && i.past?.spend > 0).sort((a, b) => b.past.rev - a.past.rev).slice(0, 8);
  const bestMax = Math.max(1, ...best.map(i => i.past.rev));
  const win = rec[0], winRoas = win.sp ? win.rv / win.sp : null;

  const tile = (i) => ({ padding: mob ? "14px" : "16px 18px", borderLeft: !mob && i ? `1px solid ${C.border}` : "none", borderTop: mob && i > 1 ? `1px solid ${C.border}` : "none", minWidth: 0 });
  const bMax = Math.max(t.budget || 0, t.planBudget) * 1.15;
  const fresh = (label, age, none) => {
    const tone = age == null ? C.red : age >= 4 ? C.amber : C.green;
    return <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: C.ink, background: C.card, borderRadius: 999, padding: "4px 10px", whiteSpace: "nowrap" }}><Dot color={tone} />{label} · <span style={{ color: C.inkMid }}>{age == null ? none : age === 0 ? "today" : `${age} d ago`}</span></span>;
  };
  const two = { display: "grid", gridTemplateColumns: mob ? "minmax(0, 1fr)" : "repeat(2, minmax(0, 1fr))", gap: 16, alignItems: "start" };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 16 }}>
      {/* The four numbers that matter, each with its picture. */}
      <div style={{ ...card, padding: 0, display: "grid", gridTemplateColumns: mob ? "repeat(2, minmax(0, 1fr))" : "repeat(4, minmax(0, 1fr))", overflow: "hidden" }}>
        <div style={{ ...tile(0), background: t.off ? C.redBg : C.greenBg }}>
          <div style={eyebrow}>Etsy Ads</div>
          <div style={{ ...big, color: t.off ? C.red : C.green, display: "flex", alignItems: "center", gap: 8 }}><Dot color={t.off ? C.red : C.green} size={11} />{t.off ? "Off" : "Running"}</div>
          <div style={small}>{t.off ? (t.lastOn ? `last charge ${fmt(t.lastOn)}` : "no charges found") : t.start ? `since ${fmt(t.start)} · ${usd(t.spend)} spent` : `last charge ${fmt(t.lastOn)}`}</div>
          <Spark rows={t.chart.slice(-14)} />
        </div>
        <div style={tile(1)}>
          <div style={eyebrow}>Daily budget</div>
          <div style={big}>{t.budget ? usd2(t.budget) : "—"}<span style={{ fontSize: 15, color: C.inkFaint }}> / {usd(t.planBudget)}</span></div>
          <div style={small}>{t.budget ? (Math.abs(t.budget - t.planBudget) < 1 ? "set to the plan" : "in Etsy Ads, against the plan") : "add the stats file to see it"}</div>
          <div style={{ position: "relative", height: 8, background: C.card, borderRadius: 4, marginTop: 14 }}>
            <div style={{ width: pct(t.budget || 0, bMax), height: "100%", background: t.budget && Math.abs(t.budget - t.planBudget) < 1 ? C.green : C.red, borderRadius: 4 }} />
            <div title={`Plan ${usd2(t.planBudget)}`} style={{ position: "absolute", left: pct(t.planBudget, bMax), top: -4, height: 16, borderLeft: `2px solid ${C.ink}` }} />
          </div>
        </div>
        <div style={tile(2)}>
          <div style={eyebrow}>Plan listings on</div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 4 }}>
            <Ring value={t.followed} max={t.want} color={t.followed >= t.want * .9 ? C.green : t.followed ? C.amber : C.red} />
            <div><div style={{ ...big, marginTop: 0 }}>{t.followed}<span style={{ fontSize: 15, color: C.inkFaint }}> / {t.want}</span></div><div style={small}>{t.tableAge != null ? `from your screenshot${t.tableAge ? `, ${t.tableAge} d old` : ""}` : "ticked by hand"}</div></div>
          </div>
        </div>
        <div style={tile(3)}>
          <div style={eyebrow}>{roasNow != null ? "Back per $1, since restart" : "Winners' record, per $1"}</div>
          <div style={{ ...big, color: (roasNow ?? winRoas) >= BREAK_EVEN ? C.green : C.amber }}>{(roasNow ?? winRoas) != null ? `${(roasNow ?? winRoas).toFixed(1)}×` : "—"}</div>
          <div style={small}>{roasNow != null ? `${usd(t.adRev)} from ${usd(t.spend)}` : `${usd(win.rv)} from ${usd(win.sp)} over two years`}</div>
          <RoasMeter value={roasNow ?? winRoas} />
        </div>
      </div>

      {/* What to do, and how it's going. */}
      <div style={{ display: "grid", gridTemplateColumns: mob ? "minmax(0, 1fr)" : "minmax(0, 1.25fr) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
        <Section title="Do now" sub={doNow.length ? `${plural(doNow.length, "thing")} to change, most costly first.` : null} right={<a href={ADS_URL} target="_blank" rel="noreferrer" style={btn}>Open Etsy Ads ↗</a>}>
          {!doNow.length ? <div style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 13.5, fontWeight: 700, color: C.green }}><span style={{ fontSize: 22 }}>✓</span>All set. Nothing to change in Etsy Ads today.</div> : (
            <div style={{ display: "grid", gap: 2 }}>
              {doNow.map((d, n) => (
                <div key={n} style={{ display: "flex", gap: 12, alignItems: "center", padding: "9px 0", borderTop: n ? `1px solid ${C.border}` : "none" }}>
                  <span style={{ width: 26, height: 26, borderRadius: 13, background: d.tone, color: C.surface, fontSize: 12.5, fontWeight: 800, display: "grid", placeItems: "center", flexShrink: 0 }}>{n + 1}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 800, color: C.ink }}>{d.head}</div>
                    <div style={{ fontSize: 11.5, color: C.inkMid, marginTop: 1 }}>{d.sub}</div>
                  </div>
                  {d.go && <button onClick={() => go(d.go)} style={btn}>Show →</button>}
                  {d.feed && <button onClick={() => feedRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })} style={btn}>Add ↓</button>}
                  {d.href && <a href={d.href} target="_blank" rel="noreferrer" style={btn}>Etsy Ads ↗</a>}
                </div>))}
            </div>
          )}
        </Section>
        <Section title="How it's going">
          <div style={{ display: "grid", gap: 10 }}>
            {news.map((u, i) => <div key={i} style={{ display: "flex", gap: 9, alignItems: "baseline", fontSize: 13, color: C.ink, lineHeight: 1.45 }}><Dot color={u.tone} /><span>{u.text}</span></div>)}
          </div>
        </Section>
      </div>

      {/* Data from Etsy Ads that the API can't give. */}
      <div ref={feedRef} style={{ ...card, padding: mob ? 14 : "12px 18px", display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ ...eyebrow, marginRight: 4 }}>Data</div>
        {fresh("Charges & orders", 0)}
        {fresh("Stats file", t.csvAge, "none")}
        {fresh(`Listings screenshot${t.tableAge != null ? ` (${Object.keys(table.rows).length})` : ""}`, t.tableAge, "none")}
        <span style={{ flex: 1 }} />
        <input ref={shotRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={e => { onShots(e.target.files); e.target.value = ""; }} />
        <input ref={csvRef} type="file" accept=".csv,text/csv" style={{ display: "none" }} onChange={e => { onCsv(e.target.files?.[0]); e.target.value = ""; }} />
        <button onClick={() => shotRef.current?.click()} disabled={!!busy} style={dark} title="Or paste them anywhere on this page (⌘V)">+ Screenshots</button>
        <button onClick={() => csvRef.current?.click()} disabled={!!busy} style={dark}>+ Stats file</button>
        <button onClick={() => setHow(!how)} style={btn}>{how ? "Close" : "How?"}</button>
        {(busy || msg) && <div style={{ width: "100%", fontSize: 12.5, fontWeight: 700, color: busy ? C.inkMid : msg.ok ? C.green : C.red }}>{busy || msg.text}</div>}
        {how && (
          <div style={{ width: "100%", display: "grid", gridTemplateColumns: mob ? "1fr" : "1fr 1fr 1fr", gap: 12, fontSize: 12.5, color: C.inkMid, lineHeight: 1.5, borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
            <div><b style={{ color: C.ink }}>Screenshots.</b> In Etsy Ads → Listings, set the dates to start on the restart day{t.start ? ` (${fmt(t.start)})` : ""}, sort by Spend, and screenshot the first few pages. Paste here with ⌘V.</div>
            <div><b style={{ color: C.ink }}>Stats file.</b> In Etsy Ads, pick the last few weeks and press the download icon (top right). Add the .csv it saves.</div>
            <div style={{ display: "grid", gap: 8 }}>
              <label>Plan budget $<input value={plan.budget ?? 25} onChange={e => savePlan({ ...plan, budget: +e.target.value.replace(/[^\d.]/g, "") || 0 })} style={{ width: 54, border: `1px solid ${C.border}`, borderRadius: 7, padding: "4px 7px", fontSize: 12.5, background: C.surface, color: C.ink }} />/day → {t.want} listings</label>
              <label>Restart day <input type="date" value={plan.startDate || t.restart || ""} onChange={e => savePlan({ ...plan, startDate: e.target.value || null })} style={{ border: `1px solid ${C.border}`, borderRadius: 7, padding: "3px 6px", fontSize: 12.5, background: C.surface, color: C.ink }} />{plan.startDate && <button onClick={() => savePlan({ ...plan, startDate: null })} style={{ ...btn, marginLeft: 6 }}>Auto</button>}</label>
            </div>
          </div>
        )}
      </div>

      {t.chart.length > 0 && (
        <Section title={t.start ? "Spend and sales around the restart" : "Spend and sales, last eight weeks"} sub="Spend is Etsy's own figure where the stats file covers the day, else the charge on the payment ledger. Shop sales are every order, ads or not. Hover for a day.">
          <DailyChart rows={t.chart} start={t.start} planBudget={t.planBudget} />
          {t.since.length > 0 && (
            <details style={{ marginTop: 10 }}>
              <summary style={{ fontSize: 12, fontWeight: 800, color: C.inkMid, cursor: "pointer" }}>Day-by-day numbers since the restart</summary>
              <div style={{ overflowX: "auto", marginTop: 8 }}>
                <table style={{ width: "100%", minWidth: 560, borderCollapse: "collapse", fontSize: 12.5 }}>
                  <thead><tr><th style={{ ...th, textAlign: "left", paddingLeft: 0 }}>Day</th><th style={th}>Budget</th><th style={th}>Ad spend</th><th style={th}>Clicks</th><th style={th}>Etsy: ad orders · sales</th><th style={th}>Shop orders · sales</th></tr></thead>
                  <tbody>{[...t.since].reverse().map(d => (
                    <tr key={d.k}>
                      <td style={{ ...td, textAlign: "left", paddingLeft: 0, fontWeight: 700 }}>{fmt(d.k)}</td>
                      <td style={td}>{d.budget != null ? usd2(d.budget) : "—"}</td>
                      <td style={{ ...td, fontWeight: 800 }}>{usd2(d.spend)}</td>
                      <td style={td}>{d.clicks ?? "—"}</td>
                      <td style={td}>{d.adOrders != null ? `${d.adOrders} · ${usd(d.adRev)}` : "—"}</td>
                      <td style={td}>{d.orders} · {usd(d.sales)}</td>
                    </tr>))}</tbody>
                </table>
              </div>
            </details>
          )}
        </Section>
      )}

      <div style={two}>
        <Section title="The plan at a glance" sub={`${plan.items.length} listings sorted by two years of ad results. At ${usd(t.planBudget)}/day, the top ${t.want} get ads.`}>
          <div style={{ display: "flex", height: 26, borderRadius: 8, overflow: "hidden", gap: 2 }}>
            {comp.map(([l, c, n]) => <div key={l} title={`${l}: ${n}`} style={{ width: pct(n, compN), background: c, display: "grid", placeItems: "center", fontSize: 11, fontWeight: 800, color: c === C.blueBg ? C.blue : C.surface, minWidth: 0, overflow: "hidden" }}>{n / compN > .06 ? n : ""}</div>)}
          </div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 8, fontSize: 11.5, color: C.inkMid }}>
            {comp.map(([l, c, n]) => <span key={l} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><Dot color={c} />{l} <b style={{ color: C.ink }}>{n}</b></span>)}
          </div>
          <div style={{ ...eyebrow, marginTop: 18 }}>Why it's shaped like this: two years of ads</div>
          <div style={{ display: "grid", gap: 12, marginTop: 10 }}>
            {rec.map(r => (
              <div key={r.g}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12.5, marginBottom: 5 }}>
                  <b style={{ color: C.ink }}>{r.g === "winner" ? `The ${r.n} winners` : `The ${r.n} kept off`}</b>
                  <span style={{ fontWeight: 800, color: r.sp && r.rv / r.sp >= BREAK_EVEN ? C.green : C.red }}>{r.sp ? `${(r.rv / r.sp).toFixed(1)}× back` : ""}</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "52px 1fr 58px", gap: 8, alignItems: "center", fontSize: 11, color: C.inkMid }}>
                  <span>spent</span><Bar value={r.sp} max={recMax} color={ETSYADS} /><span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{usd(r.sp)}</span>
                  <span>sold</span><Bar value={r.rv} max={recMax} color={r.rv / Math.max(1, r.sp) >= BREAK_EVEN ? C.green : C.red} /><span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{usd(r.rv)}</span>
                </div>
              </div>))}
          </div>
        </Section>

        <Section title="Why listings don't sell" sub={`${lists.work.length} listings have a reason found from their ad clicks, favourites and price. Click one to see them.`}>
          <div style={{ display: "grid", gap: 4 }}>
            {reasons.map(r => (
              <button key={r.k} onClick={() => { setShow("work"); setPage(0); setDiagF(r.k); tableRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }}
                style={{ textAlign: "left", background: "none", border: "none", padding: "8px 6px", margin: "0 -6px", borderRadius: 10, cursor: "pointer", color: C.ink }}
                onMouseEnter={e => e.currentTarget.style.background = C.card} onMouseLeave={e => e.currentTarget.style.background = "none"}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline", fontSize: 13 }}>
                  <b>{r.k}</b><span style={{ fontSize: 11.5, color: C.inkMid, whiteSpace: "nowrap" }}><b style={{ color: C.ink }}>{r.n}</b> · {usd(r.sp)} ads → {usd(r.rv)}</span>
                </div>
                <div style={{ margin: "5px 0" }}><Bar value={r.n} max={rMax} color={DIAG[r.k] || C.inkMid} height={7} /></div>
                <div style={{ fontSize: 11.5, color: C.inkMid, lineHeight: 1.4 }}>{FIX[r.k]}</div>
              </button>))}
          </div>
        </Section>
      </div>

      <div style={two}>
        <Section title="The winners" sub="Ad sales over two years, and what each $1 of ads brought back.">
          <div style={{ display: "grid", gap: 9 }}>
            {best.map(i => {
              const r = i.past.rev / i.past.spend;
              return (
                <a key={i.id} href={`https://www.etsy.com/listing/${i.id}`} target="_blank" rel="noreferrer" style={{ display: "flex", gap: 10, alignItems: "center", textDecoration: "none", color: C.ink }}>
                  <Thumb src={i.img} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12.5 }}>
                      <span style={{ fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{short(i.title)}</span>
                      <span style={{ fontWeight: 800, color: r >= BREAK_EVEN ? C.green : C.amber, whiteSpace: "nowrap" }}>{r.toFixed(1)}×</span>
                    </div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
                      <div style={{ flex: 1, minWidth: 30 }}><Bar value={i.past.rev} max={bestMax} color={C.green} height={6} /></div>
                      <span style={{ fontSize: 11, color: C.inkMid, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{usd(i.past.rev)} from {usd(i.past.spend)}</span>
                      {i.on ? <Dot color={C.green} /> : <Dot color={C.border} />}
                    </div>
                  </div>
                </a>);
            })}
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 10, fontSize: 11, color: C.inkFaint }}><Dot color={C.green} />ads on <Dot color={C.border} />not on yet</div>
        </Section>

        {plan.restock?.length > 0 && (
          <Section title="Winners to bring back" sub="Past ad winners no longer for sale. Renew the expired ones if the stock is there; list pieces like the sold ones.">
            <div style={{ display: "grid", gap: 8 }}>
              {plan.restock.map((r, i) => (
                <div key={i} style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 12.5, background: C.card, borderRadius: 10, padding: "8px 10px" }}>
                  <Tag color={r.state === "Sold out" ? C.inkMid : C.amber} bg={r.state === "Sold out" ? C.surface : C.amberBg}>{r.state}</Tag>
                  <span style={{ flex: 1, minWidth: 0, color: C.ink, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{short(r.title)}</span>
                  <span style={{ color: C.green, fontWeight: 800, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{usd(r.past.rev)} <span style={{ color: C.inkFaint, fontWeight: 600 }}>from {usd(r.past.spend)}</span></span>
                </div>))}
            </div>
          </Section>
        )}
      </div>

      <div ref={tableRef} style={{ scrollMarginTop: 12 }}>
        <Section title="Every listing in the plan" sub={`Grey numbers are the last two years of ads; black ones are since the restart. A test with ${CUT_CLICKS} clicks and no sale gets switched off; one that earns ${BREAK_EVEN}× or more moves up to winners.`}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12, alignItems: "center" }}>
            {pill("on", "Should be on")}{pill("todo", "To do")}{pill("work", "Needs work")}{pill("off", "Keep off")}{pill("all", "All")}
            {diagF && <button onClick={() => setDiagF(null)} style={{ ...btn, color: DIAG[diagF] }}>{diagF} · {list.length} ✕</button>}
          </div>
          {show === "on" && <div style={{ fontSize: 12, color: C.inkMid, marginBottom: 10 }}>In <a href={ADS_URL} target="_blank" rel="noreferrer" style={{ color: C.ink }}>Etsy Ads</a> → Listings, switch these on and everything else off, then tick each here. A screenshot fills the ticks in by itself.</div>}
          {show === "work" && diagF && <div style={{ fontSize: 12, color: C.ink, background: C.card, borderRadius: 10, padding: "8px 12px", marginBottom: 10 }}><b style={{ color: DIAG[diagF] }}>Fix:</b> {FIX[diagF]}</div>}
          {!list.length ? <div style={{ fontSize: 13, color: C.inkMid }}>{show === "todo" ? "Nothing to do right now." : "None."}</div> : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", minWidth: 760, borderCollapse: "collapse", fontSize: 12.5 }}>
                <thead><tr>{show === "on" && <th style={{ ...th, textAlign: "left", paddingLeft: 0 }}>#</th>}<th style={{ ...th, textAlign: "left", paddingLeft: show === "on" ? 8 : 0 }}>Listing</th><th style={th}>On?</th><th style={th}>Ad clicks</th><th style={th}>Ad spend</th><th style={th}>Ad orders</th><th style={th}>Sold since</th><th style={{ ...th, textAlign: "left" }}>Call</th></tr></thead>
                <tbody>{list.slice(pg * per, pg * per + per).map((i, n) => {
                  const [gl, gc, gb] = GROUPS[i.group];
                  return (
                    <tr key={i.id}>
                      {show === "on" && <td style={{ ...td, textAlign: "left", paddingLeft: 0, color: C.inkFaint, fontWeight: 800 }}>{pg * per + n + 1}</td>}
                      <td style={{ ...td, textAlign: "left", paddingLeft: show === "on" ? 8 : 0 }}>
                        <div style={{ display: "flex", gap: 9, alignItems: "center" }}>
                          <Thumb src={i.img} />
                          <div style={{ minWidth: 0 }}>
                            <a href={`https://www.etsy.com/listing/${i.id}`} target="_blank" rel="noreferrer" style={{ color: C.ink, fontWeight: 700, textDecoration: "none", display: "block", maxWidth: 330, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{i.title}</a>
                            <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 3, alignItems: "center" }}>
                              <Tag color={gc} bg={gb}>{gl}</Tag>
                              {i.state && i.state !== "active" && <Tag color={C.red} bg={C.redBg}>{i.state}</Tag>}
                              {show !== "work" && i.diag?.map(d => <Tag key={d.k} color={DIAG[d.k] || C.inkMid} bg={C.card}>{d.k}</Tag>)}
                              <span style={{ fontSize: 11, color: C.inkFaint }}>{i.why}</span>
                            </div>
                            {show === "work" && i.diag?.map(d => <div key={d.k} style={{ fontSize: 11.5, color: C.ink, lineHeight: 1.45, marginTop: 4, maxWidth: 520, whiteSpace: "normal" }}><b style={{ color: DIAG[d.k] || C.inkMid }}>{d.k}:</b> {d.text}</div>)}
                          </div>
                        </div>
                      </td>
                      <td style={td}>
                        {/* Ticked by hand, or read from the latest Etsy Ads screenshot (then fixed). */}
                        <button onClick={() => !i.s && markOn(i.id, !i.on)} title={i.s ? "Read from your Etsy Ads screenshot" : i.on ? "Marked on: click to undo" : "Tick once you've switched it on in Etsy Ads"}
                          style={{ ...btn, padding: "3px 9px", cursor: i.s ? "default" : "pointer", color: i.on ? C.surface : C.inkFaint, background: i.on ? C.green : C.surface, borderColor: i.on ? C.green : C.border }}>{i.on ? "✓ On" : i.on === false ? "Off" : "☐"}</button>
                      </td>
                      {/* Since the restart where a screenshot covers it, else the two-year record in grey. */}
                      <td style={{ ...td, color: i.s ? C.ink : C.inkFaint }}>{i.s ? i.s.clicks : i.past ? i.past.clicks : "—"}</td>
                      <td style={{ ...td, color: i.s ? C.ink : C.inkFaint }}>{i.s ? usd2(i.s.spend) : i.past ? usd(i.past.spend) : "—"}</td>
                      <td style={{ ...td, color: i.s ? C.ink : C.inkFaint }}>{i.s ? `${i.s.orders}${i.s.revenue ? ` · ${usd(i.s.revenue)}` : ""}` : i.past ? `${i.past.orders}${i.past.rev ? ` · ${usd(i.past.rev)}` : ""}` : "—"}</td>
                      <td style={td}>{i.sold ? `${i.sold.n} · ${usd(i.sold.v)}` : "—"}</td>
                      <td style={{ ...td, textAlign: "left" }}>
                        <div style={{ fontWeight: 800, color: i.act ? i.tone : C.inkMid }}>{i.act || i.note || (i.should ? "On the list" : "")}</div>
                        {i.act && i.note && <div style={{ fontSize: 11, color: C.inkFaint }}>{i.note}</div>}
                        <div style={{ display: "flex", gap: 5, marginTop: 4 }}>
                          {i.promote && <button onClick={() => move(i.id, "winner", `Won its test: ${i.roas.toFixed(1)}× back`)} style={{ ...btn, color: C.green }}>Move to winners</button>}
                          {i.demote && <button onClick={() => move(i.id, "off", `Failed its test: ${i.s.clicks} clicks, no sale`)} style={{ ...btn, color: C.red }}>Move to keep-off</button>}
                        </div>
                      </td>
                    </tr>);
                })}</tbody>
              </table>
            </div>
          )}
          {pages > 1 && (
            <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "flex-end", marginTop: 8, fontSize: 12, color: C.inkMid }}>
              <button onClick={() => setPage(pg - 1)} disabled={pg === 0} style={{ ...btn, width: 30 }}>‹</button>
              <span>Page {pg + 1} of {pages}</span>
              <button onClick={() => setPage(pg + 1)} disabled={pg >= pages - 1} style={{ ...btn, width: 30 }}>›</button>
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}
