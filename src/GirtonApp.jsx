/* Girton — the cost watchdog's page.

   Reads app_rows "girton-v1" (day rows, status, alerts, audit, usage snapshot;
   written by lib/girton.js hourly and scripts/girton/audit.mjs) and
   "girton-proposals-v1" (lib/girton-proposals.js). Sir's only jobs here:
   approve or decline proposals, set the AI budget, correct the monthly bills. */
import { useState, useEffect, useMemo } from "react";
import { supabase } from "./supabase.js";
import { C, mob, FI } from "./lmTheme.js";
import { saveK } from "./utils.js";
import { DEFAULT_PLANS } from "../lib/girton-plans.js";

const USD_INR = 88;
const HUE = "#3B6FE0";
const usd = (x, d = 2) => `$${(+x || 0).toFixed(d)}`;
const usdS = x => (Math.abs(x) >= 1 ? usd(x) : Math.abs(x) >= 0.01 ? usd(x, 3) : usd(x, 4));
const inr = x => `₹${Math.round((+x || 0) * USD_INR).toLocaleString("en-IN")}`;
const tok = n => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n || 0);
const bytes = b => b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : `${Math.round((b || 0) / 1e3)} kB`;
const num = n => (+n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });
const ago = ms => { const m = Math.round((Date.now() - ms) / 60e3); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
const daysSince = d => Math.round((Date.now() - Date.parse(`${d}T12:00:00+05:30`)) / 864e5);

const TONE = {
  critical: { c: C.red, bg: C.redBg, icon: "●", label: "Critical" },
  warn: { c: C.amber, bg: C.amberBg, icon: "▲", label: "Warning" },
  info: { c: C.blue, bg: C.blueBg, icon: "i", label: "Note" },
  good: { c: C.green, bg: C.greenBg, icon: "✓", label: "OK" },
};
const toneFor = pct => pct >= 100 ? "critical" : pct >= 80 ? "warn" : "good";

const S = {
  card: { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, padding: 16, minWidth: 0, boxShadow: "0 1px 2px rgba(0,0,0,.04)" },
  h: { margin: "0 0 12px", fontSize: 14, fontWeight: 800, color: C.ink, display: "flex", alignItems: "center", gap: 8 },
  sub: { fontSize: 12, color: C.inkFaint },
  chip: (c, bg) => ({ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 700, color: c, background: bg, borderRadius: 999, padding: "3px 9px", whiteSpace: "nowrap" }),
  btn: (primary) => ({ border: primary ? "none" : `1.5px solid ${C.border}`, background: primary ? HUE : C.surface, color: primary ? "#fff" : C.ink, borderRadius: 10, padding: "8px 14px", fontSize: 13, fontWeight: 800, cursor: "pointer", fontFamily: "inherit" }),
};
const grid = (cols, gap = 14) => ({ display: "grid", gridTemplateColumns: mob() ? "minmax(0,1fr)" : cols, gap });

/* ── Small pieces ─────────────────────────────────────────────────────── */
function Meter({ label, used, limit, right, note, mark }) {
  const pct = limit ? used / limit * 100 : 0;
  const t = TONE[toneFor(pct)];
  return <div style={{ marginBottom: 12 }}>
    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12.5, marginBottom: 5 }}>
      <span style={{ fontWeight: 700, color: C.ink }}>{label}</span>
      <span style={{ color: C.inkMid, textAlign: "right" }}>{right}{pct >= 80 && <b style={{ color: t.c }}> · {Math.round(pct)}%</b>}</span>
    </div>
    <div style={{ position: "relative", height: 10, background: C.card, borderRadius: 99 }}>
      <div style={{ width: `${Math.min(100, Math.max(pct ? 1.5 : 0, pct))}%`, height: "100%", background: pct >= 80 ? t.c : HUE, borderRadius: 99 }} />
      {mark != null && limit > 0 && <div title="Forecast for the month" style={{ position: "absolute", left: `calc(${Math.min(100, mark / limit * 100)}% - 1px)`, top: -4, width: 2, height: 18, borderRadius: 2, background: C.ink }} />}
    </div>
    {note && <div style={{ ...S.sub, marginTop: 4 }}>{note}</div>}
  </div>;
}

function Stat({ label, value, sub, tone }) {
  return <div style={{ ...S.card, padding: "13px 15px" }}>
    <div style={{ fontSize: 11, color: C.inkFaint, fontWeight: 800, textTransform: "uppercase", letterSpacing: .5 }}>{label}</div>
    <div style={{ fontSize: 24, fontWeight: 800, marginTop: 4, color: C.ink, letterSpacing: -.3 }}>{value}</div>
    {sub && <div style={{ fontSize: 12, marginTop: 2, color: tone ? TONE[tone].c : C.inkMid }}>{tone && <b>{TONE[tone].icon} </b>}{sub}</div>}
  </div>;
}

function DailyBars({ days }) {
  const [hov, setHov] = useState(null);
  const max = Math.max(0.0001, ...days.map(d => d.usd));
  return <div>
    <div style={{ position: "relative", height: 150, display: "flex", alignItems: "flex-end", gap: 3, borderBottom: `1px solid ${C.border}` }}>
      {days.map((d, i) => <div key={d.day} onMouseEnter={() => setHov(i)} onMouseLeave={() => setHov(null)} style={{ flex: 1, height: "100%", display: "flex", alignItems: "flex-end" }}>
        <div style={{ width: "100%", height: `${d.usd ? Math.max(3, d.usd / max * 100) : 0}%`, background: HUE, opacity: hov == null || hov === i ? 1 : .4, borderRadius: "4px 4px 0 0", transition: "opacity .15s" }} />
      </div>)}
      {hov != null && <div style={{ position: "absolute", top: 4, left: `${Math.min(68, hov / days.length * 100)}%`, background: C.ink, color: C.surface, fontSize: 12, padding: "7px 10px", borderRadius: 9, pointerEvents: "none", whiteSpace: "nowrap", boxShadow: "0 6px 20px rgba(0,0,0,.18)" }}>
        <b>{days[hov].day}</b><br />{usdS(days[hov].usd)} · {inr(days[hov].usd)}<br />{days[hov].calls} calls{days[hov].errs ? ` · ${days[hov].errs} failed` : ""}
      </div>}
    </div>
    <div style={{ display: "flex", justifyContent: "space-between", ...S.sub, marginTop: 5 }}><span>{days[0]?.day}</span><span>highest day {usdS(max)}</span><span>today</span></div>
  </div>;
}

function Bars({ rows, total, onPick, picked, empty }) {
  const max = Math.max(0.0001, ...rows.map(r => r.usd));
  if (!rows.length) return <div style={{ ...S.sub, fontSize: 13 }}>{empty || "Nothing recorded yet."}</div>;
  return <div style={{ display: "grid", gap: 4 }}>{rows.map(r => <button key={r.k} onClick={() => onPick?.(picked === r.k ? null : r.k)}
    title={`${r.calls} calls · ${tok(r.in)} in / ${tok(r.out)} out · ${usdS(r.calls ? r.usd / r.calls : 0)} per call`}
    style={{ all: "unset", cursor: onPick ? "pointer" : "default", display: "grid", gridTemplateColumns: mob() ? "minmax(0,1fr) auto" : "minmax(0,160px) minmax(0,1fr) auto", alignItems: "center", gap: 10, fontSize: 12.5, padding: "5px 6px", borderRadius: 8, background: picked === r.k ? C.card : "transparent" }}>
    <span style={{ fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: C.ink }}>{r.k}{r.errs ? <span style={{ color: C.red, fontWeight: 600 }}> · {r.errs} failed</span> : null}</span>
    {!mob() && <div style={{ background: C.card, borderRadius: 99, height: 10 }}><div style={{ width: `${r.usd / max * 100}%`, height: "100%", background: HUE, borderRadius: 99 }} /></div>}
    <span style={{ textAlign: "right", color: C.inkMid, whiteSpace: "nowrap" }}>{usdS(r.usd)} <span style={{ color: C.inkFaint }}>· {total ? Math.round(r.usd / total * 100) : 0}% · {r.calls}×</span></span>
  </button>)}</div>;
}
const sumInto = (acc, obj) => { for (const [k, v] of Object.entries(obj || {})) { const t = acc[k] ||= { k, calls: 0, in: 0, out: 0, usd: 0, errs: 0 }; t.calls += v.calls; t.in += v.in; t.out += v.out; t.usd += v.usd; t.errs += v.errs; } return acc; };

/* ── A proposal card ──────────────────────────────────────────────────── */
const EFFORT = { instant: "Instant", small: "Small job", medium: "Half a day", large: "Several nights" };
const RISK = { none: ["No risk", "good"], low: ["Low risk", "good"], medium: ["Some risk", "warn"], high: ["Risky", "critical"] };
const STATUS = {
  proposed: ["Waiting for you", "info"], approved: ["Approved · queued for Claude", "info"], building: ["Being built", "warn"],
  done: ["Done", "good"], declined: ["Declined", "info"], failed: ["Build failed", "critical"],
};
function Proposal({ p, onDecide, busy, compact }) {
  const [open, setOpen] = useState(false);
  const [rk, rt] = RISK[p.risk] || RISK.low;
  const [sl, st] = STATUS[p.status] || STATUS.proposed;
  const waiting = p.status === "proposed" || p.status === "declined" || p.status === "failed";
  return <div style={{ ...S.card, padding: 0, overflow: "hidden", borderColor: p.status === "proposed" ? HUE + "55" : C.border }}>
    <div style={{ padding: "14px 16px 12px" }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
        <span style={S.chip(C.inkMid, C.card)}>{p.area}</span>
        <span style={S.chip(C.inkMid, C.card)}>{p.kind === "config" ? "⚡ " : "🛠 "}{EFFORT[p.effort] || p.effort}</span>
        <span style={S.chip(TONE[rt].c, TONE[rt].bg)}>{rk}</span>
        {p.status !== "proposed" && <span style={S.chip(TONE[st].c, TONE[st].bg)}>{TONE[st].icon} {sl}</span>}
      </div>
      <div style={{ fontSize: 15, fontWeight: 800, color: C.ink, lineHeight: 1.35 }}>{p.title}</div>
      {p.saving_note && <div style={{ marginTop: 6, fontSize: 12.5, fontWeight: 700, color: C.green }}>💰 {p.saving_note}</div>}
      {!compact && <div style={{ marginTop: 8, fontSize: 13, color: C.inkMid, lineHeight: 1.55 }}>{p.why}</div>}
      {!compact && p.plan && <div style={{ marginTop: 8 }}>
        <button onClick={() => setOpen(!open)} style={{ all: "unset", cursor: "pointer", fontSize: 12, fontWeight: 700, color: HUE }}>{open ? "▾" : "▸"} How Claude will build it</button>
        {open && <div style={{ marginTop: 6, fontSize: 12.5, color: C.inkMid, background: C.card, borderRadius: 10, padding: "9px 11px", lineHeight: 1.5 }}>{p.plan}</div>}
      </div>}
      {p.result && p.status !== "proposed" && <div style={{ marginTop: 8, ...S.sub, fontSize: 12.5 }}>{p.result}{p.commit ? ` · commit ${String(p.commit).slice(0, 7)}` : ""}</div>}
    </div>
    <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "10px 16px", background: C.card, borderTop: `1px solid ${C.border}`, flexWrap: "wrap" }}>
      <span style={{ ...S.sub, flex: 1, minWidth: 140 }}>{p.kind === "config" ? "Takes effect the moment you approve. Undo any time." : "Queued for Claude once approved. Say “build Girton's approved changes” in a Claude session."}</span>
      {waiting && <>
        {p.status !== "declined" && <button disabled={busy} onClick={() => onDecide(p.id, "decline")} style={S.btn(false)}>Not now</button>}
        <button disabled={busy} onClick={() => onDecide(p.id, "approve")} style={S.btn(true)}>{busy ? "…" : "Approve"}</button>
      </>}
      {(p.status === "approved" || (p.status === "done" && p.kind === "config")) && <button disabled={busy} onClick={() => onDecide(p.id, "undo")} style={S.btn(false)}>Undo</button>}
    </div>
  </div>;
}

/* ── The page ─────────────────────────────────────────────────────────── */
const TABS = [["overview", "Overview"], ["proposals", "Proposals"], ["ai", "AI spend"], ["platforms", "Plans & limits"], ["audit", "Code audit"]];

export default function GirtonApp({ onHome }) {
  const [rows, setRows] = useState(null);
  const [props, setProps] = useState([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [tab, setTab] = useState(() => { try { return localStorage.getItem("girton-tab") || "overview"; } catch { return "overview"; } });
  const [range, setRange] = useState("month");
  const [picked, setPicked] = useState(null);
  const [pFilter, setPFilter] = useState("open");
  const [bills, setBills] = useState(null);
  const [budgetEdit, setBudgetEdit] = useState(null);

  const go = t => { setTab(t); try { localStorage.setItem("girton-tab", t); } catch {} };
  const load = async () => {
    const [a, b] = await Promise.all([
      supabase.from("app_rows").select("data").eq("key", "girton-v1").eq("deleted", false).limit(600),
      supabase.from("app_rows").select("data").eq("key", "girton-proposals-v1").eq("deleted", false).limit(200),
    ]);
    if (a.error) return setErr(a.error.message);
    setRows((a.data || []).map(r => r.data));
    setProps((b.data || []).map(r => r.data));
  };
  useEffect(() => { load(); }, []);

  const post = async body => {
    const r = await fetch("/api/listing-manager", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    return d;
  };
  const refresh = async () => { setBusy("refresh"); setErr(""); try { await post({ action: "girton_refresh" }); await load(); } catch (e) { setErr(e.message); } setBusy(""); };
  const decide = async (id, decision) => {
    setBusy(id); setErr("");
    try { const d = await post({ action: "girton_decide", id, decision }); setProps(ps => ps.map(p => p.id === id ? d.proposal : p)); }
    catch (e) { setErr(e.message); }
    setBusy("");
  };

  const get = id => rows?.find(r => r.id === id);
  const status = get("status"), audit = get("audit"), snap = get("usage-snapshot");
  const alerts = get("alerts")?.list || [];
  const dayRows = useMemo(() => (rows || []).filter(r => r.id?.startsWith("day|")).sort((a, b) => a.day < b.day ? -1 : 1), [rows]);
  const today = status?.today || new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const todayRow = dayRows.find(d => d.day === today);
  const inRange = useMemo(() => dayRows.filter(d => range === "today" ? d.day === today : range === "7d" ? d.day > new Date(Date.parse(today) - 7 * 864e5).toISOString().slice(0, 10) : range === "month" ? d.day.startsWith(today.slice(0, 7)) : true), [dayRows, range, today]);
  const total = inRange.reduce((s, d) => s + (d.total?.usd || 0), 0);
  const features = useMemo(() => Object.values(inRange.reduce((a, d) => sumInto(a, d.feature), {})).sort((a, b) => b.usd - a.usd), [inRange]);
  const models = useMemo(() => Object.values(inRange.reduce((a, d) => sumInto(a, d.model), {})).sort((a, b) => b.usd - a.usd), [inRange]);
  const screens = useMemo(() => picked ? Object.values(inRange.reduce((a, d) => sumInto(a, Object.fromEntries(Object.entries(d.screen || {}).filter(([k]) => k.split(":")[0] === picked))), {})).sort((a, b) => b.usd - a.usd) : [], [inRange, picked]);
  const last30 = useMemo(() => { const by = Object.fromEntries(dayRows.map(d => [d.day, d.total])); return Array.from({ length: 30 }, (_, i) => { const day = new Date(Date.parse(today) - (29 - i) * 864e5).toISOString().slice(0, 10); const t = by[day]; return { day, usd: t?.usd || 0, calls: t?.calls || 0, errs: t?.errs || 0 }; }); }, [dayRows, today]);

  if (!rows) return <div style={{ padding: 28, color: C.inkMid }}>{err || "Loading Girton…"}</div>;

  const budget = status?.budget || {};
  const B = budget.monthly_usd ?? 10;
  const plans = bills || budget.plans || DEFAULT_PLANS;
  const aiForecast = status?.forecast || 0;
  const monthly = plans.reduce((s, p) => s + (p.metered ? aiForecast : +p.usd || 0), 0);
  const waiting = props.filter(p => p.status === "proposed");
  const openAlerts = (status?.open_alerts || []).filter(a => a.level !== "info");
  const transforms = snap?.supabase?.items?.find(i => /transform/i.test(i.k));
  const needs = waiting.length + openAlerts.length;
  const p = status?.platform || {};
  const lim = status?.limits || { db: 8e9, storage: 100e9 };
  const fTone = status ? (status.mtd >= B ? "critical" : aiForecast > B ? "warn" : "good") : null;

  const saveBills = async next => { await saveK("girton-budget-v1", { ...budget, plans: next }, { merge: false }); setBills(next); };
  const saveBudget = async () => { await saveK("girton-budget-v1", { ...budget, plans, monthly_usd: Math.max(0, +budgetEdit || 0) }, { merge: false }); setBudgetEdit(null); refresh(); };

  const propList = props.filter(x => pFilter === "open" ? x.status === "proposed" : pFilter === "queued" ? ["approved", "building", "failed"].includes(x.status) : pFilter === "done" ? x.status === "done" : x.status === "declined")
    .sort((a, b) => ({ instant: 0, small: 1, medium: 2, large: 3 }[a.effort] ?? 2) - ({ instant: 0, small: 1, medium: 2, large: 3 }[b.effort] ?? 2));

  /* Sections reused across tabs */
  const alertsCard = <div style={S.card}>
    <div style={S.h}>🔔 Alerts</div>
    {openAlerts.map(a => { const t = TONE[a.level] || TONE.info; return <div key={a.id} style={{ background: t.bg, borderRadius: 10, padding: "9px 11px", marginBottom: 6, fontSize: 13, lineHeight: 1.45 }}><b style={{ color: t.c }}>{t.icon} {t.label}</b> <span style={{ color: C.ink }}>{a.text}</span></div>; })}
    {transforms && transforms.used > transforms.limit && <div style={{ background: C.redBg, borderRadius: 10, padding: "9px 11px", marginBottom: 6, fontSize: 13, lineHeight: 1.45 }}><b style={{ color: C.red }}>● Supabase</b> Image transformations at {num(transforms.used)} of {num(transforms.limit)} this cycle (as of {snap.as_of}). This can restrict the project until {snap.supabase.cycle[1]}.</div>}
    {!openAlerts.length && !(transforms && transforms.used > transforms.limit) && <div style={{ background: C.greenBg, borderRadius: 10, padding: "9px 11px", fontSize: 13 }}><b style={{ color: C.green }}>✓ All quiet.</b> Nothing unusual in AI spend or limits.</div>}
    {alerts.length > 0 && <details style={{ marginTop: 8 }}><summary style={{ fontSize: 12, color: C.inkMid, cursor: "pointer" }}>Earlier alerts ({alerts.length})</summary>
      {alerts.slice(0, 30).map(a => <div key={a.id} style={{ fontSize: 12, color: C.inkMid, padding: "5px 0", borderBottom: `1px solid ${C.border}` }}><b>{a.day}</b> · {a.text}</div>)}
    </details>}
    <div style={{ ...S.sub, marginTop: 8 }}>Checked hourly. Warnings also go to Telegram.</div>
  </div>;

  const aiBudgetCard = <div style={S.card}>
    <div style={{ ...S.h, justifyContent: "space-between" }}><span>🤖 AI budget</span>
      {budgetEdit == null ? <button onClick={() => setBudgetEdit(B)} style={{ all: "unset", cursor: "pointer", fontSize: 12, fontWeight: 700, color: HUE }}>Change</button>
        : <span style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="number" min="0" value={budgetEdit} onChange={e => setBudgetEdit(e.target.value)} style={FI({ width: 80, padding: "4px 8px" })} /><button onClick={saveBudget} style={S.btn(true)}>Save</button></span>}
    </div>
    <Meter label="Spent this month" used={status?.mtd || 0} limit={B} mark={aiForecast} right={`${usd(status?.mtd || 0)} of ${usd(B, 0)}`} note={`Forecast ${usd(aiForecast)} (${inr(aiForecast)}) · the black tick. 7-day pace ${usdS(status?.avg7 || 0)}/day.`} />
    {snap?.openai && <div style={S.sub}>OpenAI credit balance {usd(snap.openai.credit_usd)} on {snap.openai_as_of || snap.as_of} ({snap.openai.tier} tier).</div>}
  </div>;

  return <div style={{ background: C.bg, minHeight: "100%" }}>
    {/* Hero */}
    <div style={{ background: "linear-gradient(135deg,#0E1A3A 0%,#1C2F6B 55%,#3B6FE0 130%)", color: "#fff", padding: mob() ? "16px 14px 18px" : "22px 26px 24px" }}>
      <div style={{ maxWidth: 1180, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {onHome && <button onClick={onHome} style={{ border: "1px solid rgba(255,255,255,.25)", background: "rgba(255,255,255,.08)", color: "#fff", borderRadius: 10, padding: "6px 11px", cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}>← Home</button>}
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: -.3 }}>🧮 Girton</div>
            <div style={{ fontSize: 13, opacity: .78 }}>Keeps the business's running costs low. You approve; he and Claude do the rest.</div>
          </div>
          <button onClick={refresh} disabled={busy === "refresh"} style={{ border: "none", background: "rgba(255,255,255,.14)", color: "#fff", borderRadius: 10, padding: "8px 14px", cursor: "pointer", fontWeight: 800, fontFamily: "inherit", fontSize: 13 }}>{busy === "refresh" ? "Checking…" : "↻ Check now"}</button>
        </div>
        <div style={{ ...grid("repeat(4, minmax(0,1fr))", 12), marginTop: 18 }}>
          {[
            ["Running cost / month", `${usd(monthly, 0)}`, `≈ ${inr(monthly)} · tools + AI`],
            ["AI this month", usd(status?.mtd || 0), `forecast ${usd(aiForecast)} of ${usd(B, 0)}`],
            ["AI today", usdS(todayRow?.total?.usd || 0), `${todayRow?.total?.calls || 0} calls${todayRow?.total?.errs ? ` · ${todayRow.total.errs} failed` : ""}`],
            ["Needs you", needs ? String(needs) : "Nothing", needs ? `${waiting.length} to approve${openAlerts.length ? ` · ${openAlerts.length} alert${openAlerts.length > 1 ? "s" : ""}` : ""}` : "all on track"],
          ].map(([l, v, s], i) => <div key={l} onClick={i === 3 && waiting.length ? () => go("proposals") : undefined} style={{ background: "rgba(255,255,255,.09)", border: "1px solid rgba(255,255,255,.14)", borderRadius: 14, padding: "12px 14px", cursor: i === 3 && waiting.length ? "pointer" : "default" }}>
            <div style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: .5, opacity: .7 }}>{l}</div>
            <div style={{ fontSize: 24, fontWeight: 800, marginTop: 3, letterSpacing: -.3 }}>{v}</div>
            <div style={{ fontSize: 12, opacity: .75 }}>{s}</div>
          </div>)}
        </div>
        {status && <div style={{ fontSize: 11.5, opacity: .6, marginTop: 10 }}>Last check {ago(status.at)}. AI costs are estimates from OpenAI's list prices.</div>}
      </div>
    </div>

    {/* Tabs */}
    <div style={{ position: "sticky", top: 0, zIndex: 2, background: C.bg, borderBottom: `1px solid ${C.border}` }}>
      <div style={{ maxWidth: 1180, margin: "0 auto", padding: mob() ? "8px 12px" : "10px 26px", display: "flex", gap: 6, overflowX: "auto" }}>
        {TABS.map(([k, l]) => <button key={k} onClick={() => go(k)} style={{ border: "none", cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap", borderRadius: 999, padding: "7px 14px", fontSize: 13, fontWeight: 800, background: tab === k ? C.ink : "transparent", color: tab === k ? C.surface : C.inkMid }}>
          {l}{k === "proposals" && waiting.length ? <span style={{ marginLeft: 6, background: HUE, color: "#fff", borderRadius: 99, padding: "1px 7px", fontSize: 11 }}>{waiting.length}</span> : null}
        </button>)}
      </div>
    </div>

    <div style={{ maxWidth: 1180, margin: "0 auto", padding: mob() ? "14px 12px 40px" : "20px 26px 50px", overflowX: "hidden" }}>
      {err && <div style={{ ...S.card, background: C.redBg, color: C.red, marginBottom: 14 }}>{err}</div>}

      {tab === "overview" && <>
        <div style={{ ...grid("minmax(0,1.4fr) minmax(0,1fr)"), marginBottom: 14 }}>
          <div style={{ display: "grid", gap: 10, alignContent: "start" }}>
            <div style={{ ...S.h, margin: "2px 0 0", justifyContent: "space-between" }}><span>✅ Waiting for your approval</span>{waiting.length > 2 && <button onClick={() => go("proposals")} style={{ all: "unset", cursor: "pointer", fontSize: 12, color: HUE, fontWeight: 700 }}>All {waiting.length} →</button>}</div>
            {waiting.slice(0, 2).map(x => <Proposal key={x.id} p={x} onDecide={decide} busy={busy === x.id} />)}
            {!waiting.length && <div style={{ ...S.card, color: C.inkMid, fontSize: 13 }}>Nothing waiting. Girton adds proposals when his audit finds savings.</div>}
          </div>
          <div style={{ display: "grid", gap: 14, alignContent: "start" }}>{alertsCard}{aiBudgetCard}</div>
        </div>
        <div style={{ ...grid("minmax(0,1.4fr) minmax(0,1fr)") }}>
          <div style={S.card}><div style={S.h}>📈 AI spend per day</div><DailyBars days={last30} /></div>
          <div style={S.card}>
            <div style={S.h}>🧭 Limits at a glance</div>
            {!p.error && <><Meter label="Supabase database" used={p.db_bytes || 0} limit={lim.db} right={`${bytes(p.db_bytes)} of ${bytes(lim.db)}`} />
              <Meter label="Supabase storage" used={p.storage_bytes || 0} limit={lim.storage} right={`${bytes(p.storage_bytes)} of ${bytes(lim.storage)}`} /></>}
            {(snap?.supabase?.items || []).filter(i => /transform|^Egress/i.test(i.k)).map(i => <Meter key={i.k} label={i.k} used={i.used} limit={i.limit} right={`${num(i.used)} of ${num(i.limit)} ${i.unit}`} />)}
            <Meter label="Vercel functions" used={audit?.vercel?.functions || 12} limit={audit?.vercel?.limit || 12} right={`${audit?.vercel?.functions ?? 12} of ${audit?.vercel?.limit || 12}`} />
            <button onClick={() => go("platforms")} style={{ all: "unset", cursor: "pointer", fontSize: 12, color: HUE, fontWeight: 700 }}>All plans & limits →</button>
          </div>
        </div>
      </>}

      {tab === "proposals" && <>
        <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
          {[["open", `Waiting (${waiting.length})`], ["queued", `Approved (${props.filter(x => ["approved", "building", "failed"].includes(x.status)).length})`], ["done", `Done (${props.filter(x => x.status === "done").length})`], ["declined", `Declined (${props.filter(x => x.status === "declined").length})`]].map(([k, l]) =>
            <button key={k} onClick={() => setPFilter(k)} style={{ ...S.btn(pFilter === k), padding: "6px 12px", background: pFilter === k ? C.ink : C.surface, color: pFilter === k ? C.surface : C.ink }}>{l}</button>)}
          <span style={{ ...S.sub, marginLeft: 6 }}>⚡ instant ones apply the moment you approve · 🛠 code ones are queued for your next Claude session</span>
        </div>
        <div style={grid("repeat(2, minmax(0,1fr))")}>{propList.map(x => <Proposal key={x.id} p={x} onDecide={decide} busy={busy === x.id} />)}</div>
        {!propList.length && <div style={{ ...S.card, color: C.inkMid, fontSize: 13 }}>Nothing here.</div>}
      </>}

      {tab === "ai" && <>
        <div style={{ ...grid("repeat(4, minmax(0,1fr))", 12), marginBottom: 14 }}>
          <Stat label="Today" value={usdS(todayRow?.total?.usd || 0)} sub={`${inr(todayRow?.total?.usd || 0)} · ${todayRow?.total?.calls || 0} calls`} />
          <Stat label="This month" value={usd(status?.mtd || 0)} sub={`${inr(status?.mtd || 0)} of ${usd(B, 0)} budget`} />
          <Stat label="Month forecast" value={usd(aiForecast)} sub={fTone === "good" ? "Within budget" : fTone === "warn" ? "Heading over budget" : fTone ? "Over budget" : ""} tone={fTone} />
          <Stat label="Failed calls today" value={todayRow?.total?.errs || 0} sub={(todayRow?.total?.errs || 0) ? "Key, credit or rate limit" : "None"} tone={(todayRow?.total?.errs || 0) >= 3 ? "critical" : (todayRow?.total?.errs || 0) ? "warn" : "good"} />
        </div>
        <div style={{ ...S.card, marginBottom: 14 }}><div style={S.h}>📈 AI spend per day, last 30 days</div><DailyBars days={last30} /></div>
        <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
          {[["today", "Today"], ["7d", "7 days"], ["month", "This month"], ["all", "All"]].map(([k, l]) => <button key={k} onClick={() => setRange(k)} style={{ ...S.btn(false), padding: "6px 12px", background: range === k ? C.ink : C.surface, color: range === k ? C.surface : C.ink }}>{l}</button>)}
          <span style={{ fontSize: 13, color: C.inkMid, marginLeft: 6 }}>{usd(total)} · {inr(total)}</span>
        </div>
        <div style={grid("minmax(0,1.3fr) minmax(0,1fr)")}>
          <div style={S.card}>
            <div style={S.h}>What spent it</div>
            <Bars rows={features} total={total} onPick={setPicked} picked={picked} empty="No AI calls in this period. The meter started on 6 Nov 2026." />
            {picked && <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${C.border}` }}>
              <div style={{ ...S.sub, fontSize: 12.5, marginBottom: 6 }}>Which screen asked for <b style={{ color: C.ink }}>{picked}</b></div>
              <Bars rows={screens.map(s => ({ ...s, k: s.k.split(":").slice(1).join(":") || "(server)" }))} total={total} />
            </div>}
            <div style={{ ...S.sub, marginTop: 10 }}>Tap a feature to see which screen used it.</div>
          </div>
          <div style={S.card}>
            <div style={S.h}>Which model</div>
            <Bars rows={models} total={total} />
            {todayRow?.top?.length > 0 && <>
              <div style={{ ...S.h, marginTop: 18 }}>Costliest calls today</div>
              {todayRow.top.slice(0, 6).map((x, i) => <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "6px 0", borderBottom: `1px solid ${C.border}`, gap: 8 }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{new Date(x.at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })} · {x.feature} <span style={{ color: C.inkFaint }}>· {x.model}</span></span>
                <span style={{ whiteSpace: "nowrap", color: C.inkMid }}>{usdS(x.usd)}</span>
              </div>)}
            </>}
          </div>
        </div>
      </>}

      {tab === "platforms" && <>
        <div style={{ ...S.card, marginBottom: 14 }}>
          <div style={{ ...S.h, justifyContent: "space-between" }}><span>🧾 Monthly bills</span><span style={{ fontSize: 15 }}>{usd(monthly, 0)} <span style={{ ...S.sub, fontSize: 12.5 }}>≈ {inr(monthly)}/month</span></span></div>
          <div style={{ display: "grid", gap: 2 }}>
            {plans.map((pl, i) => <div key={pl.id} style={{ display: "grid", gridTemplateColumns: mob() ? "minmax(0,1fr) 90px" : "minmax(0,170px) minmax(0,1fr) 110px", gap: 10, alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${C.border}` }}>
              <div><div style={{ fontWeight: 800, fontSize: 13.5 }}>{pl.name}</div><div style={S.sub}>{pl.plan}</div></div>
              {!mob() && <div style={{ fontSize: 12.5, color: C.inkMid }}>{pl.note}{pl.check && <span style={{ ...S.chip(C.amber, C.amberBg), marginLeft: 6 }}>check amount</span>}</div>}
              <div style={{ textAlign: "right" }}>{pl.metered ? <span style={{ fontSize: 13.5, fontWeight: 700 }}>{usd(aiForecast)}<div style={S.sub}>forecast</div></span>
                : <input type="number" min="0" step="1" defaultValue={pl.usd} onBlur={e => { const v = +e.target.value || 0; if (v !== +pl.usd || pl.check) saveBills(plans.map((q, j) => j === i ? { ...q, usd: v, check: false } : q)); }} style={FI({ width: 80, textAlign: "right", padding: "5px 8px" })} />}</div>
            </div>)}
          </div>
          <div style={{ ...S.sub, marginTop: 8 }}>Edit an amount and click away to save it. Amounts marked "check amount" are Girton's guess until you correct them.</div>
        </div>

        <div style={{ ...grid("repeat(2, minmax(0,1fr))"), marginBottom: 14 }}>
          <div style={S.card}>
            <div style={{ ...S.h, justifyContent: "space-between" }}><span>🟢 Supabase · {snap?.supabase?.plan || "Pro"}</span>{snap && <span style={S.sub}>cycle {snap.supabase.cycle[0]} → {snap.supabase.cycle[1]}</span>}</div>
            {!p.error ? <>
              <Meter label="Database (live)" used={p.db_bytes || 0} limit={lim.db} right={`${bytes(p.db_bytes)} of ${bytes(lim.db)}`} />
              <Meter label="File storage (live)" used={p.storage_bytes || 0} limit={lim.storage} right={`${bytes(p.storage_bytes)} of ${bytes(lim.storage)} · ${num(p.storage_objects)} files`} />
            </> : <div style={{ ...S.sub, marginBottom: 10 }}>Live database figures: {p.error}</div>}
            {(snap?.supabase?.items || []).filter(i => !/storage/i.test(i.k)).map(i => <Meter key={i.k} label={i.k} used={i.used} limit={i.limit} right={`${num(i.used)} of ${num(i.limit)} ${i.unit}`} />)}
            {snap && <div style={S.sub}>Usage figures as of {snap.as_of} ({daysSince(snap.as_of)} d ago), read from the dashboard. They update automatically once Supabase's access token is added (see below). Compute: {snap.supabase.compute.hours} h, ${snap.supabase.compute.usd} against the $10 credit.</div>}
          </div>
          <div style={{ display: "grid", gap: 14, alignContent: "start" }}>
            {aiBudgetCard}
            <div style={S.card}>
              <div style={S.h}>▲ Vercel · Hobby</div>
              <Meter label="Serverless functions" used={audit?.vercel?.functions || 12} limit={audit?.vercel?.limit || 12} right={`${audit?.vercel?.functions ?? 12} of ${audit?.vercel?.limit || 12}`} note="Full: new server features are folded into existing files (free). The next plan is $20/month." />
            </div>
            <div style={S.card}>
              <div style={S.h}>🚂 Railway</div>
              <div style={{ fontSize: 13, color: C.inkMid }}>Runs the Telegram finance bot (now on gpt-4o-mini). Usage appears here once a Railway token is added.</div>
            </div>
          </div>
        </div>

        {!p.error && (p.tables?.length || p.app_rows_keys?.length) ? <div style={{ ...grid("repeat(2, minmax(0,1fr))"), marginBottom: 14 }}>
          <div style={S.card}><div style={S.h}>Biggest tables</div>
            {(p.tables || []).slice(0, 8).map(t => <div key={t.table} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "5px 0", gap: 8, borderBottom: `1px solid ${C.border}` }}><span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{t.table}</span><span style={{ color: C.inkMid, whiteSpace: "nowrap" }}>{bytes(t.bytes)} · {num(t.rows)} rows</span></div>)}
          </div>
          <div style={S.card}><div style={S.h}>Biggest stored data</div>
            {[...(p.app_rows_keys || []).map(k => ({ ...k, kind: `${num(k.rows)} rows` })), ...(p.app_data_keys || []).map(k => ({ ...k, kind: "single value" }))].sort((a, b) => b.bytes - a.bytes).slice(0, 8)
              .map(k => <div key={k.key + k.kind} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "5px 0", gap: 8, borderBottom: `1px solid ${C.border}` }}><span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{k.key}</span><span style={{ color: C.inkMid, whiteSpace: "nowrap" }}>{bytes(k.bytes)} · {k.kind}</span></div>)}
            <div style={{ ...S.sub, marginTop: 6 }}>A big single value is downloaded whole by every screen that reads it.</div>
          </div>
        </div> : null}

        <div style={{ ...S.card, background: C.card }}>
          <div style={S.h}>🔑 Next step: make every number live</div><div style={{ ...S.sub, fontSize: 12.5, marginBottom: 6 }}>Only you can create these. Add them in Vercel, then tell Claude and Girton will start reading them.</div>
          {[["OpenAI admin key", "Real spend per key, including the Railway bot.", "platform.openai.com → Settings → Admin keys → set OPENAI_ADMIN_KEY in Vercel"],
            ["Supabase access token", "Egress and image-transform counts every hour instead of a snapshot.", "supabase.com/dashboard/account/tokens → set SUPABASE_ACCESS_TOKEN in Vercel"],
            ["Vercel token", "Bandwidth and function usage.", "vercel.com/account/tokens → set VERCEL_TOKEN in Vercel"],
            ["Railway token", "The bot's monthly usage.", "railway.com/account/tokens → set RAILWAY_TOKEN in Vercel"]].map(([t, w, how]) =>
            <div key={t} style={{ padding: "8px 0", borderBottom: `1px solid ${C.border}`, fontSize: 13 }}><b>{t}</b> <span style={{ color: C.inkMid }}>· {w}</span><div style={{ ...S.sub, marginTop: 2 }}>{how}</div></div>)}
        </div>
      </>}

      {tab === "audit" && <div style={S.card}>
        <div style={{ ...S.h, justifyContent: "space-between" }}><span>🔎 Where money and tokens leak</span>{audit && <span style={S.sub}>run {audit.day} · {audit.findings?.length || 0} findings</span>}</div>
        {!audit && <div style={{ ...S.sub, fontSize: 13 }}>No audit yet.</div>}
        {(audit?.findings || []).map((f, i) => { const t = TONE[f.level] || TONE.info; return <details key={i} style={{ borderTop: i ? `1px solid ${C.border}` : "none", padding: "10px 0" }}>
          <summary style={{ cursor: "pointer", fontSize: 13.5, display: "flex", gap: 8, alignItems: "baseline" }}><b style={{ color: t.c, width: 14 }}>{t.icon}</b><span style={{ flex: 1 }}><b>{f.title}</b> <span style={{ color: C.inkFaint }}>· {f.area}</span></span>{f.saving && <span style={S.chip(C.green, C.greenBg)}>{f.saving}</span>}</summary>
          <div style={{ fontSize: 13, color: C.inkMid, margin: "8px 0 0 22px", lineHeight: 1.55 }}>{f.detail}{f.fix && <div style={{ marginTop: 5 }}><b style={{ color: C.ink }}>Fix:</b> {f.fix}</div>}{f.where && <div style={{ marginTop: 5, fontFamily: "ui-monospace, monospace", fontSize: 11.5, color: C.inkFaint, wordBreak: "break-all" }}>{f.where}</div>}</div>
        </details>; })}
      </div>}
    </div>
  </div>;
}
