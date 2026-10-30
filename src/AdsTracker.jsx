import React, { useEffect, useMemo, useRef, useState } from "react";
import { C } from "./ui.jsx";
import { mob, loadK, saveK } from "./utils.js";
import { loadHistory, compare, Kpi, Section, Thumb, Tag, eyebrow, usd, usd2, dayKey, DAY, ADS_URL } from "./EtsyInsights.jsx";

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

export default function AdsTracker({ listings = [] }) {
  const [plan, setPlan] = useState(null), [table, setTable] = useState(null), [daily, setDaily] = useState(null), [hist, setHist] = useState(null);
  const [busy, setBusy] = useState(""), [msg, setMsg] = useState(null);
  const [show, setShow] = useState("todo"), [page, setPage] = useState(0);
  const shotRef = useRef(null), csvRef = useRef(null);

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
    const start = plan.startDate || restart;
    const off = !lastOn || daysAgo(Date.parse(lastOn + "T12:00:00")) > 2;
    const budget = [...keys].reverse().map(k => daily[k]?.budget).find(b => b > 0) || null;
    const planBudget = plan.budget || 25;
    const want = Math.round((budget || planBudget) * 2.5);

    // Every day since the restart, and the four weeks before it to compare against.
    const rowOf = k => ({ k, spend: spendOf(k), budget: daily[k]?.budget ?? null, clicks: daily[k]?.clicks ?? null, adOrders: daily[k]?.orders ?? null, adRev: daily[k]?.rev ?? null, sales: ledger[k]?.sales || 0, orders: ledger[k]?.orders || 0 });
    const since = start ? keys.filter(k => k >= start).map(rowOf) : [];
    const before = start ? keys.filter(k => k < start).slice(-28).map(rowOf) : [];
    const sum = (a, f) => a.reduce((s, d) => s + (f(d) || 0), 0);
    const cmp = since.length >= 4 && before.length >= 7 ? compare(before.map(d => d.sales), since.map(d => d.sales)) : null;
    const hasEtsy = since.some(d => d.clicks != null);

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
      else if (on === null && shouldOn.has(i.id)) { act = "Switch on (not seen yet)"; tone = C.inkMid; }
      if (on && s && s.orders > 0 && roas != null) note = roas >= BREAK_EVEN ? `Working: ${roas.toFixed(1)}× back` : `${roas.toFixed(1)}× back, under ${BREAK_EVEN}×`;
      else if (on && s) note = `Learning: ${s.clicks} clicks`;
      const promote = i.group === "test" && s && s.orders >= 1 && roas >= BREAK_EVEN;
      return { ...i, img: i.img || erp[i.id]?.img, state: erp[i.id]?.state, s, on, sold, roas, act, tone, note, promote, demote: i.group === "test" && act?.startsWith("Turn off:") && s?.clicks >= CUT_CLICKS, should: shouldOn.has(i.id) };
    });
    // Listings with ads on that aren't in the plan at all.
    const planIds = new Set(plan.items.map(i => i.id));
    const strays = Object.entries(shot).filter(([id, r]) => r.on && !planIds.has(id)).map(([id, r]) => ({ id, ...r, state: erp[id]?.state }));
    const onCount = items.filter(i => i.on).length, followed = items.filter(i => i.should && i.on).length;
    return { start, restart, off, lastOn, budget, planBudget, want, since, before, cmp, hasEtsy, items, strays, onCount, followed,
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
  const list = lists[show], per = 15, pages = Math.max(1, Math.ceil(list.length / per)), pg = Math.min(page, pages - 1);
  const pill = (k, label) => (
    <button key={k} onClick={() => { setShow(k); setPage(0); }} style={{ border: `1.5px solid ${show === k ? C.ink : C.border}`, background: show === k ? C.ink : C.surface, color: show === k ? C.surface : C.inkMid, borderRadius: 10, padding: "6px 12px", fontSize: 12.5, fontWeight: 800, cursor: "pointer" }}>{label} · {lists[k].length}</button>
  );
  const btn = { border: `1px solid ${C.border}`, background: C.surface, borderRadius: 8, padding: "5px 10px", fontSize: 11.5, fontWeight: 800, cursor: "pointer", color: C.ink };
  const th = { color: C.inkFaint, fontSize: 10.5, textTransform: "uppercase", letterSpacing: .6, textAlign: "right", fontWeight: 800, padding: "0 0 6px 8px", whiteSpace: "nowrap" };
  const td = { padding: "7px 0 7px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums", borderTop: `1px solid ${C.border}`, verticalAlign: "middle" };

  // Today's update, in plain words.
  const upd = [];
  if (t.off) upd.push({ tone: C.red, text: `Etsy Ads aren't spending${t.lastOn ? `: nothing charged since ${fmt(t.lastOn)}` : ""}. Check Etsy Ads: the budget is set and the listings below marked "Turn on" are switched on.` });
  else if (t.start) upd.push({ tone: C.green, text: `Ads back on since ${fmt(t.start)} (${t.since.length} day${t.since.length === 1 ? "" : "s"}): ${usd2(t.spend)} spent, ${usd2(t.spend / Math.max(1, t.since.length))}/day${t.budget ? ` against a ${usd2(t.budget)}/day budget` : ""}.` });
  if (t.hasEtsy && t.spend > 0) upd.push({ tone: t.adRev / t.spend >= BREAK_EVEN ? C.green : C.amber, text: `Etsy counts ${t.adOrders} order${t.adOrders === 1 ? "" : "s"} and ${usd(t.adRev)} from ${t.clicks} ad clicks: ${(t.adRev / t.spend).toFixed(1)}× the spend (break-even is ${BREAK_EVEN}×).` });
  if (t.since.length) upd.push({ tone: t.salesDay >= t.salesDayBefore ? C.green : C.amber, text: `Whole-shop sales ${usd(t.salesDay)}/day since the restart, against ${usd(t.salesDayBefore)}/day in the four weeks before${t.cmp ? ` (the gap could really be ${usd(t.cmp.lo)} to ${usd(t.cmp.hi)} a day${t.since.length < 14 ? "; firmer after two weeks" : ""})` : ""}.` });
  const sold = t.items.filter(i => i.sold && i.group !== "off");
  if (sold.length) upd.push({ tone: C.green, text: `Sold since the restart from the plan: ${sold.slice(0, 5).map(i => `${i.title.split(/[:|–—-]/)[0].trim()} (${usd(i.sold.v)})`).join(", ")}${sold.length > 5 ? ` and ${sold.length - 5} more` : ""}.` });
  if (t.tableAge != null) upd.push({ tone: C.inkMid, text: `${t.followed} of the ${t.want} listings the plan wants on are on; ${t.onCount} plan listings on in all.${t.strays.length ? ` ${t.strays.length} listing${t.strays.length > 1 ? "s" : ""} outside the plan ${t.strays.length > 1 ? "have" : "has"} ads on.` : ""}` });
  const todo = lists.todo.length;
  if (todo) upd.push({ tone: C.ink, text: `${todo} thing${todo > 1 ? "s" : ""} to do in Etsy Ads: see "To do" below.` });
  if (t.tableAge == null) upd.push({ tone: C.amber, text: "No screenshot of the Etsy Ads listings table yet, so which listings are on, and how each is doing, isn't known. Add one below." });
  else if (t.tableAge >= 4) upd.push({ tone: C.amber, text: `The listings screenshot is ${t.tableAge} days old. A fresh one keeps the calls right.` });
  if (t.csvAge == null || t.csvAge >= 3) upd.push({ tone: C.amber, text: t.csvAge == null ? "Add the Etsy Ads stats file for the budget, clicks and Etsy's own ad sales." : `The Etsy Ads stats file stops ${t.csvAge} days ago. Download a fresh one.` });

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr 1fr" : "repeat(4, 1fr)", gap: 10 }}>
        <Kpi label="Ads" value={t.off ? "Off" : "Running"} sub={t.lastOn ? `last charge ${fmt(t.lastOn)}` : "no charges found"} tone={t.off ? C.redBg : C.greenBg} />
        <Kpi label="Budget" value={t.budget ? `${usd2(t.budget)}/day` : "—"} sub={t.budget ? `from Etsy's stats · plan ${usd2(t.planBudget)}` : `plan ${usd2(t.planBudget)}/day · add the stats file`} />
        <Kpi label="Since the restart" value={t.start ? usd(t.spend) : "—"} sub={t.start ? `spent · ${t.hasEtsy ? `${usd(t.adRev)} back by Etsy's count` : "Etsy's ad sales come from the stats file"}` : "waiting for ads to restart"} />
        <Kpi label="Plan followed" value={t.tableAge != null ? `${t.followed}/${t.want}` : "—"} sub={t.tableAge != null ? `of the listings it wants on are on` : "needs a screenshot of Etsy Ads"} />
      </div>

      <Section title="Today's update" sub={`Read by itself from Etsy's charges and orders${t.tableAge != null ? `, plus your Etsy Ads screenshot from ${t.tableAge === 0 ? "today" : `${t.tableAge} day${t.tableAge > 1 ? "s" : ""} ago`}` : ""}.`}
        right={<a href={ADS_URL} target="_blank" rel="noreferrer" style={{ ...btn, textDecoration: "none" }}>Open Etsy Ads ↗</a>}>
        <div style={{ display: "grid", gap: 7 }}>
          {upd.map((u, i) => <div key={i} style={{ fontSize: 13, color: C.ink, lineHeight: 1.5, borderLeft: `3px solid ${u.tone}`, paddingLeft: 10 }}>{u.text}</div>)}
        </div>
      </Section>

      <Section title="Update from Etsy Ads" sub="What Etsy's API can't give: the budget, clicks, which listings have ads on, and each listing's ad results. Two minutes, every few days.">
        <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr" : "1fr 1fr", gap: 12 }}>
          <div style={{ background: C.card, borderRadius: 12, padding: 14 }}>
            <div style={eyebrow}>1 · Listings table (screenshots)</div>
            <div style={{ fontSize: 12.5, color: C.inkMid, margin: "6px 0 10px", lineHeight: 1.5 }}>In Etsy Ads, set the dates to start on the restart day{t.start ? ` (${fmt(t.start)})` : ""}, sort by <b>Spend</b>, and screenshot the first few pages. Paste them here (⌘V) or choose the files.</div>
            <input ref={shotRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={e => { onShots(e.target.files); e.target.value = ""; }} />
            <button onClick={() => shotRef.current?.click()} disabled={!!busy} style={{ ...btn, background: C.ink, color: C.surface, border: "none", padding: "8px 14px" }}>Add screenshots</button>
            {t.tableAge != null && <span style={{ fontSize: 11.5, color: C.inkFaint, marginLeft: 10 }}>{Object.keys(table.rows).length} listings read · {t.tableAge === 0 ? "today" : `${t.tableAge} d ago`}{table.range ? ` · ${table.range}` : ""}</span>}
          </div>
          <div style={{ background: C.card, borderRadius: 12, padding: 14 }}>
            <div style={eyebrow}>2 · Daily stats (file)</div>
            <div style={{ fontSize: 12.5, color: C.inkMid, margin: "6px 0 10px", lineHeight: 1.5 }}>In Etsy Ads, pick a range that covers the last few weeks and press the download icon (top right). Choose the .csv it saves.</div>
            <input ref={csvRef} type="file" accept=".csv,text/csv" style={{ display: "none" }} onChange={e => { onCsv(e.target.files?.[0]); e.target.value = ""; }} />
            <button onClick={() => csvRef.current?.click()} disabled={!!busy} style={{ ...btn, background: C.ink, color: C.surface, border: "none", padding: "8px 14px" }}>Add stats file</button>
            {t.csvAge != null && <span style={{ fontSize: 11.5, color: C.inkFaint, marginLeft: 10 }}>up to {t.csvAge === 0 ? "today" : `${t.csvAge} d ago`}</span>}
          </div>
        </div>
        {busy && <div style={{ marginTop: 10, fontSize: 12.5, color: C.inkMid }}>{busy}</div>}
        {msg && <div style={{ marginTop: 10, fontSize: 12.5, fontWeight: 700, color: msg.ok ? C.green : C.red }}>{msg.text}</div>}
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center", marginTop: 12, fontSize: 12, color: C.inkMid }}>
          <label>Planned budget $<input value={plan.budget ?? 25} onChange={e => savePlan({ ...plan, budget: +e.target.value.replace(/[^\d.]/g, "") || 0 })} style={{ width: 54, border: `1px solid ${C.border}`, borderRadius: 7, padding: "4px 7px", fontSize: 12.5, background: C.surface, color: C.ink }} />/day → about {t.want} listings on</label>
          <label>Restart day <input type="date" value={plan.startDate || t.restart || ""} onChange={e => savePlan({ ...plan, startDate: e.target.value || null })} style={{ border: `1px solid ${C.border}`, borderRadius: 7, padding: "3px 6px", fontSize: 12.5, background: C.surface, color: C.ink }} /></label>
          {plan.startDate && <button onClick={() => savePlan({ ...plan, startDate: null })} style={btn}>Find it by itself</button>}
        </div>
      </Section>

      <Section title="The plan, listing by listing" sub={`Ad winners first, then untested pieces in the price band that pays for ads; enough of them for the budget (about 2.5 listings per $1 a day, so each gets 20–30 clicks a month to prove itself). A test listing with ${CUT_CLICKS} clicks and no sale is called; one that sells at ${BREAK_EVEN}× or better moves up to winners.`}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
          {pill("todo", "To do")}{pill("on", "Should be on")}{pill("off", "Keep off")}{pill("work", "Needs work")}{pill("all", "All")}
        </div>
        {show === "work" && (
          <div style={{ display: "grid", gap: 6, marginBottom: 12, background: C.card, borderRadius: 10, padding: "10px 12px" }}>
            {Object.entries(FIX).map(([k, f]) => {
              const n = lists.work.filter(i => i.diag.some(d => d.k === k)).length;
              return n ? <div key={k} style={{ fontSize: 12.5, color: C.ink, lineHeight: 1.45 }}><Tag color={DIAG[k]} bg={C.surface}>{k} · {n}</Tag> {f}</div> : null;
            })}
          </div>
        )}
        {!list.length ? <div style={{ fontSize: 13, color: C.inkMid }}>{show === "todo" ? "Nothing to do right now." : "None."}</div> : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", minWidth: 760, borderCollapse: "collapse", fontSize: 12.5 }}>
              <thead><tr><th style={{ ...th, textAlign: "left", paddingLeft: 0 }}>Listing</th><th style={th}>Ad</th><th style={th}>Clicks</th><th style={th}>Spend</th><th style={th}>Ad orders</th><th style={th}>Sold since</th><th style={{ ...th, textAlign: "left" }}>Call</th></tr></thead>
              <tbody>{list.slice(pg * per, pg * per + per).map(i => {
                const [gl, gc, gb] = GROUPS[i.group];
                return (
                  <tr key={i.id}>
                    <td style={{ ...td, textAlign: "left", paddingLeft: 0 }}>
                      <div style={{ display: "flex", gap: 9, alignItems: "center" }}>
                        <Thumb src={i.img} />
                        <div style={{ minWidth: 0 }}>
                          <a href={`https://www.etsy.com/listing/${i.id}`} target="_blank" rel="noreferrer" style={{ color: C.ink, fontWeight: 700, textDecoration: "none", display: "block", maxWidth: 330, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{i.title}</a>
                          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 3, alignItems: "center" }}>
                            <Tag color={gc} bg={gb}>{gl}</Tag>
                            {i.state && i.state !== "active" && <Tag color={C.red} bg={C.redBg}>{i.state}</Tag>}
                            {i.diag?.map(d => <Tag key={d.k} color={DIAG[d.k] || C.inkMid} bg={C.card}>{d.k}</Tag>)}
                            <span style={{ fontSize: 11, color: C.inkFaint }}>{i.why}</span>
                          </div>
                          {show === "work" && i.diag?.map(d => <div key={d.k} style={{ fontSize: 11.5, color: C.ink, lineHeight: 1.45, marginTop: 4, maxWidth: 520, whiteSpace: "normal" }}><b style={{ color: DIAG[d.k] || C.inkMid }}>{d.k}:</b> {d.text}</div>)}
                        </div>
                      </div>
                    </td>
                    <td style={td}>
                      {i.on == null ? <button onClick={() => markOn(i.id, true)} title="Mark as switched on" style={{ ...btn, padding: "3px 7px", color: C.inkFaint }}>?</button>
                        : <button onClick={() => !i.s && markOn(i.id, !i.on)} title={i.s ? "From your Etsy Ads screenshot" : "Marked by hand: click to change"} style={{ ...btn, padding: "3px 8px", cursor: i.s ? "default" : "pointer", color: i.on ? C.green : C.inkFaint, borderColor: i.on ? C.green : C.border }}>{i.on ? "On" : "Off"}</button>}
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
        {t.strays.length > 0 && (
          <div style={{ marginTop: 14, background: C.redBg, borderRadius: 10, padding: "10px 12px", fontSize: 12.5, color: C.ink }}>
            <b style={{ color: C.red }}>Ads on, but not in the plan:</b> {t.strays.slice(0, 12).map(s => `${s.title.slice(0, 50)}${s.state && s.state !== "active" ? ` (${s.state})` : ""}`).join(" · ")}{t.strays.length > 12 ? ` and ${t.strays.length - 12} more` : ""}. Switch these off unless you mean them.
          </div>
        )}
      </Section>

      {t.since.length > 0 && (
        <Section title="Day by day since the restart" sub="Spend is Etsy's own figure where the stats file covers the day, else the charge on the payment ledger. Shop sales are every order, ads or not.">
          <div style={{ overflowX: "auto" }}>
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
        </Section>
      )}

      {plan.restock?.length > 0 && (
        <Section title="Past ad winners no longer for sale" sub="Renew the expired ones if the stock is still there; list pieces like the sold ones.">
          <div style={{ display: "grid", gap: 6 }}>
            {plan.restock.map((r, i) => (
              <div key={i} style={{ display: "flex", gap: 10, alignItems: "baseline", fontSize: 12.5, borderTop: i ? `1px solid ${C.border}` : "none", paddingTop: i ? 6 : 0 }}>
                <Tag color={r.state === "Sold out" ? C.inkMid : C.amber} bg={r.state === "Sold out" ? C.card : C.amberBg}>{r.state}</Tag>
                <span style={{ flex: 1, color: C.ink, fontWeight: 700 }}>{r.title}</span>
                <span style={{ color: C.green, fontWeight: 800, whiteSpace: "nowrap" }}>{usd(r.past.rev)} from {usd(r.past.spend)}</span>
              </div>))}
          </div>
        </Section>
      )}
    </div>
  );
}
