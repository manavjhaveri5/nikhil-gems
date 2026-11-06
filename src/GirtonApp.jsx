/* Girton — the cost watchdog's page. Same look as Raj (RajApp.jsx).

   Reads app_rows "girton-v1" (day rows, status with each provider's live data,
   alerts, audit, usage snapshot; written hourly by lib/girton.js and by
   scripts/girton/audit.mjs) and "girton-proposals-v1". Sir's only jobs here:
   approve or decline proposals, set the AI budget, correct the bills. */
import { useState, useEffect, useMemo } from "react";
import { supabase } from "./supabase.js";
import { C, mob, FI } from "./lmTheme.js";
import { saveK } from "./utils.js";
import { DEFAULT_PLANS } from "../lib/girton-plans.js";

const FONT = "-apple-system,'SF Pro Display','Figtree',system-ui,sans-serif";
const SERIF = "'Cormorant Garamond',Georgia,serif";
const card = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px 16px", minWidth: 0 };
const btn = (bg = C.surface, fg = C.ink) => ({ background: bg, color: fg, border: bg === C.surface ? `1px solid ${C.border}` : "none", borderRadius: 7, padding: "7px 13px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" });
const lab = { fontSize: 9.5, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .6, marginBottom: 4, display: "block" };
const h = { fontFamily: SERIF, fontSize: 18, fontWeight: 700, margin: "0 0 10px", color: C.ink };
const sub = { fontSize: 11.5, color: C.inkFaint };
const BAR = C.gold;

const USD_INR = 88;
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
const Tag = ({ t, children }) => <span style={{ fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: .4, background: (TONE[t] || {}).bg || C.card, color: (TONE[t] || {}).c || C.inkMid, borderRadius: 4, padding: "2px 6px", whiteSpace: "nowrap" }}>{children}</span>;
const grid = (cols, gap = 12) => ({ display: "grid", gridTemplateColumns: mob() ? "minmax(0,1fr)" : cols, gap });
const Live = ({ on, at, what }) => on
  ? <span style={{ ...sub, color: C.green }}>● Live from {what}{at ? `, ${ago(at)}` : ""}</span>
  : <span style={sub}>○ Not connected</span>;

function Metric({ label, value, note, tone, onClick }) {
  return <div onClick={onClick} style={{ ...card, padding: "12px 14px", cursor: onClick ? "pointer" : "default" }}>
    <span style={lab}>{label}</span>
    <div style={{ fontSize: 24, fontWeight: 700, fontFamily: SERIF, lineHeight: 1.1 }}>{value}</div>
    {note && <div style={{ fontSize: 11.5, color: tone ? TONE[tone].c : C.inkMid, marginTop: 3 }}>{tone && <b>{TONE[tone].icon} </b>}{note}</div>}
  </div>;
}

function Meter({ label, used, limit, right, note, mark }) {
  const pct = limit ? used / limit * 100 : 0;
  const t = pct >= 100 ? TONE.critical : pct >= 80 ? TONE.warn : null;
  return <div style={{ marginBottom: 11 }}>
    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12.5, marginBottom: 4 }}>
      <span style={{ fontWeight: 600 }}>{label}</span>
      <span style={{ color: C.inkMid, textAlign: "right" }}>{right}{t && <b style={{ color: t.c }}> · {Math.round(pct)}%</b>}</span>
    </div>
    <div style={{ position: "relative", height: 7, background: C.card, borderRadius: 99 }}>
      <div style={{ width: `${Math.min(100, Math.max(pct ? 1.5 : 0, pct))}%`, height: "100%", background: t ? t.c : BAR, borderRadius: 99 }} />
      {mark != null && limit > 0 && <div title="Forecast" style={{ position: "absolute", left: `calc(${Math.min(100, mark / limit * 100)}% - 1px)`, top: -4, width: 2, height: 15, background: C.ink, borderRadius: 1 }} />}
    </div>
    {note && <div style={{ ...sub, marginTop: 3 }}>{note}</div>}
  </div>;
}

function DailyBars({ days }) {
  const [hov, setHov] = useState(null);
  const max = Math.max(0.0001, ...days.map(d => d.usd));
  return <div>
    <div style={{ position: "relative", height: 130, display: "flex", alignItems: "flex-end", gap: 2, borderBottom: `1px solid ${C.border}` }}>
      {days.map((d, i) => <div key={d.day} onMouseEnter={() => setHov(i)} onMouseLeave={() => setHov(null)} style={{ flex: 1, height: "100%", display: "flex", alignItems: "flex-end" }}>
        <div style={{ width: "100%", height: `${d.usd ? Math.max(3, d.usd / max * 100) : 0}%`, background: BAR, opacity: hov == null || hov === i ? 1 : .4, borderRadius: "3px 3px 0 0" }} />
      </div>)}
      {hov != null && <div style={{ position: "absolute", top: 2, left: `${Math.min(66, hov / days.length * 100)}%`, background: C.ink, color: "#fff", fontSize: 12, padding: "6px 9px", borderRadius: 6, pointerEvents: "none", whiteSpace: "nowrap" }}>
        <b>{days[hov].day}</b><br />{usdS(days[hov].usd)} · {inr(days[hov].usd)}{days[hov].calls != null && <><br />{days[hov].calls} calls{days[hov].errs ? ` · ${days[hov].errs} failed` : ""}</>}
      </div>}
    </div>
    <div style={{ display: "flex", justifyContent: "space-between", ...sub, marginTop: 4 }}><span>{days[0]?.day}</span><span>highest {usdS(max)}</span><span>today</span></div>
  </div>;
}

function Bars({ rows, total, onPick, picked, empty, value = r => r.usd, fmt = usdS, extra }) {
  const max = Math.max(0.0001, ...rows.map(value));
  if (!rows.length) return <div style={{ ...sub, fontSize: 12.5 }}>{empty || "Nothing recorded yet."}</div>;
  return <div style={{ display: "grid", gap: 2 }}>{rows.map(r => <button key={r.k} onClick={() => onPick?.(picked === r.k ? null : r.k)}
    style={{ all: "unset", cursor: onPick ? "pointer" : "default", display: "grid", gridTemplateColumns: mob() ? "minmax(0,1fr) auto" : "minmax(0,150px) minmax(0,1fr) auto", alignItems: "center", gap: 10, fontSize: 12.5, padding: "5px 6px", borderRadius: 6, background: picked === r.k ? C.card : "transparent" }}>
    <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.k}{r.errs ? <span style={{ color: C.red, fontWeight: 500 }}> · {r.errs} failed</span> : null}</span>
    {!mob() && <div style={{ background: C.card, borderRadius: 99, height: 7 }}><div style={{ width: `${value(r) / max * 100}%`, height: "100%", background: BAR, borderRadius: 99 }} /></div>}
    <span style={{ textAlign: "right", color: C.inkMid, whiteSpace: "nowrap" }}>{fmt(value(r))}{total ? <span style={{ color: C.inkFaint }}> · {Math.round(value(r) / total * 100)}%</span> : null}{extra ? <span style={{ color: C.inkFaint }}> · {extra(r)}</span> : null}</span>
  </button>)}</div>;
}
const sumInto = (acc, obj) => { for (const [k, v] of Object.entries(obj || {})) { const t = acc[k] ||= { k, calls: 0, in: 0, out: 0, usd: 0, errs: 0 }; t.calls += v.calls; t.in += v.in; t.out += v.out; t.usd += v.usd; t.errs += v.errs; } return acc; };
const Row = ({ l, r, strong }) => <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12.5, padding: "6px 0", borderBottom: `1px solid ${C.border}` }}><span style={{ color: C.inkMid }}>{l}</span><span style={{ fontWeight: strong ? 700 : 500, textAlign: "right" }}>{r}</span></div>;

/* ── Proposals ────────────────────────────────────────────────────────── */
const EFFORT = { instant: "Instant", small: "Small job", medium: "Half a day", large: "Several sessions" };
const RISK = { none: ["No risk", "good"], low: ["Low risk", "good"], medium: ["Some risk", "warn"], high: ["Risky", "critical"] };
const STATUS = { proposed: ["Waiting", "info"], approved: ["Approved · queued", "info"], building: ["Being built", "warn"], done: ["Done", "good"], declined: ["Declined", null], failed: ["Build failed", "critical"] };
function Proposal({ p, onDecide, busy }) {
  const [open, setOpen] = useState(false);
  const [rk, rt] = RISK[p.risk] || RISK.low;
  const [sl, st] = STATUS[p.status] || STATUS.proposed;
  const waiting = ["proposed", "declined", "failed"].includes(p.status);
  return <div style={{ ...card, padding: 0, overflow: "hidden", borderLeft: `3px solid ${p.status === "proposed" ? C.gold : p.status === "done" ? C.green : C.border}` }}>
    <div style={{ padding: "13px 16px 11px" }}>
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 7 }}>
        <Tag>{p.area}</Tag><Tag>{p.kind === "config" ? "⚡ " : "🛠 "}{EFFORT[p.effort] || p.effort}</Tag><Tag t={rt}>{rk}</Tag>
        {p.status !== "proposed" && <Tag t={st}>{sl}</Tag>}
      </div>
      <div style={{ fontFamily: SERIF, fontSize: 17, fontWeight: 700, lineHeight: 1.25 }}>{p.title}</div>
      {p.saving_note && <div style={{ marginTop: 5, fontSize: 12.5, fontWeight: 600, color: C.green }}>{p.saving_note}</div>}
      <div style={{ marginTop: 7, fontSize: 13, color: C.inkMid, lineHeight: 1.55 }}>{p.why}</div>
      {p.plan && <div style={{ marginTop: 7 }}>
        <button onClick={() => setOpen(!open)} style={{ all: "unset", cursor: "pointer", fontSize: 12, fontWeight: 600, color: C.gold }}>{open ? "▾" : "▸"} How Claude will build it</button>
        {open && <div style={{ marginTop: 6, fontSize: 12.5, color: C.inkMid, background: C.card, borderRadius: 8, padding: "8px 10px", lineHeight: 1.5 }}>{p.plan}</div>}
      </div>}
      {p.result && p.status !== "proposed" && <div style={{ ...sub, fontSize: 12, marginTop: 7 }}>{p.result}{p.commit ? ` · commit ${String(p.commit).slice(0, 7)}` : ""}</div>}
    </div>
    <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "9px 16px", background: C.card, borderTop: `1px solid ${C.border}`, flexWrap: "wrap" }}>
      <span style={{ ...sub, flex: 1, minWidth: 150 }}>{p.kind === "config" ? "Takes effect when you approve. Undo any time." : "Queued for Claude once approved: say “build Girton's approved changes”."}</span>
      {waiting && <>
        {p.status !== "declined" && <button disabled={busy} onClick={() => onDecide(p.id, "decline")} style={btn()}>Not now</button>}
        <button disabled={busy} onClick={() => onDecide(p.id, "approve")} style={btn(C.ink, "#fff")}>{busy ? "…" : "Approve"}</button>
      </>}
      {(p.status === "approved" || (p.status === "done" && p.kind === "config")) && <button disabled={busy} onClick={() => onDecide(p.id, "undo")} style={btn()}>Undo</button>}
    </div>
  </div>;
}

/* ── Page ─────────────────────────────────────────────────────────────── */
const TABS = [["overview", "🧮", "Overview"], ["proposals", "✅", "Proposals"], ["ai", "🤖", "AI spend"], ["platforms", "🧾", "Plans & bills"], ["audit", "🔎", "Code audit"]];

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
  const [toast, setToast] = useState("");

  const go = t => { setTab(t); try { localStorage.setItem("girton-tab", t); } catch {} };
  const showToast = m => { setToast(m); setTimeout(() => setToast(""), 2600); };
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
  const refresh = async () => { setBusy("refresh"); setErr(""); try { await post({ action: "girton_refresh" }); await load(); showToast("Checked just now"); } catch (e) { setErr(e.message); } setBusy(""); };
  const decide = async (id, decision) => {
    setBusy(id); setErr("");
    try { const d = await post({ action: "girton_decide", id, decision }); setProps(ps => ps.map(p => p.id === id ? d.proposal : p)); showToast(decision === "approve" ? (d.proposal.kind === "config" ? "Approved and applied" : "Approved and queued for Claude") : decision === "undo" ? "Undone" : "Set aside"); }
    catch (e) { setErr(e.message); }
    setBusy("");
  };

  const get = id => rows?.find(r => r.id === id);
  const status = get("status"), audit = get("audit"), snap = get("usage-snapshot");
  const alerts = get("alerts")?.list || [];
  const prov = status?.providers || {};
  const rw = prov.railway?.workspaces?.[0], oai = prov.openai?.mtd_usd != null ? prov.openai : null;
  const dayRows = useMemo(() => (rows || []).filter(r => r.id?.startsWith("day|")).sort((a, b) => a.day < b.day ? -1 : 1), [rows]);
  const today = status?.today || new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const todayRow = dayRows.find(d => d.day === today);
  const inRange = useMemo(() => dayRows.filter(d => range === "today" ? d.day === today : range === "7d" ? d.day > new Date(Date.parse(today) - 7 * 864e5).toISOString().slice(0, 10) : range === "month" ? d.day.startsWith(today.slice(0, 7)) : true), [dayRows, range, today]);
  const total = inRange.reduce((s, d) => s + (d.total?.usd || 0), 0);
  const features = useMemo(() => Object.values(inRange.reduce((a, d) => sumInto(a, d.feature), {})).sort((a, b) => b.usd - a.usd), [inRange]);
  const models = useMemo(() => Object.values(inRange.reduce((a, d) => sumInto(a, d.model), {})).sort((a, b) => b.usd - a.usd), [inRange]);
  const screens = useMemo(() => picked ? Object.values(inRange.reduce((a, d) => sumInto(a, Object.fromEntries(Object.entries(d.screen || {}).filter(([k]) => k.split(":")[0] === picked))), {})).sort((a, b) => b.usd - a.usd) : [], [inRange, picked]);
  const last30 = useMemo(() => { const by = Object.fromEntries(dayRows.map(d => [d.day, d.total])); return Array.from({ length: 30 }, (_, i) => { const day = new Date(Date.parse(today) - (29 - i) * 864e5).toISOString().slice(0, 10); const t = by[day]; return { day, usd: t?.usd || 0, calls: t?.calls || 0, errs: t?.errs || 0 }; }); }, [dayRows, today]);
  const waiting = props.filter(p => p.status === "proposed");

  const shell = body => <div style={{ minHeight: "100vh", background: C.bg, fontFamily: FONT, color: C.ink }}>
    {toast && <div style={{ position: "fixed", bottom: 22, right: 22, left: mob() ? 22 : "auto", zIndex: 1200, background: C.ink, color: "#fff", padding: "10px 18px", borderRadius: 6, fontSize: 12.5 }}>{toast}</div>}
    <div style={{ position: "sticky", top: 0, zIndex: 100, background: C.surface, borderBottom: `1px solid ${C.border}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: mob() ? "10px 14px" : "11px 28px" }}>
        {onHome && <button onClick={onHome} style={{ background: "none", border: "none", cursor: "pointer", color: C.inkMid, fontFamily: "inherit", fontSize: 13, padding: "0 12px 0 0", borderRight: `1px solid ${C.border}` }}>← Home</button>}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 700, lineHeight: 1 }}>Girton</div>
          <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 1 }}>Cost watch · AI spend, plans, limits, savings{status ? ` · checked ${ago(status.at)}` : ""}</div>
        </div>
        <button onClick={refresh} disabled={busy === "refresh"} style={btn()}>{busy === "refresh" ? "Checking…" : "↻ Check now"}</button>
      </div>
      <div style={{ display: "flex", overflowX: "auto", padding: mob() ? "0 10px" : "0 28px" }}>
        {TABS.map(([k, icon, label]) => <button key={k} onClick={() => go(k)} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: -1, border: "none", background: "none", cursor: "pointer", fontFamily: "inherit", padding: "11px 14px", fontSize: 13, whiteSpace: "nowrap", fontWeight: tab === k ? 700 : 500, color: tab === k ? C.ink : C.inkMid, borderBottom: `2px solid ${tab === k ? C.gold : "transparent"}` }}>
          <span style={{ fontSize: 14 }}>{icon}</span>{label}{k === "proposals" && waiting.length ? <span style={{ background: C.gold, color: "#fff", borderRadius: 99, padding: "0 6px", fontSize: 10.5, fontWeight: 700 }}>{waiting.length}</span> : null}
        </button>)}
      </div>
    </div>
    <div style={{ maxWidth: 1000, margin: "0 auto", padding: mob() ? "14px 12px 60px" : "22px 28px 60px" }}>
      {err && <div style={{ ...card, background: C.redBg, color: C.red, marginBottom: 12, fontSize: 13 }}>{err}</div>}
      {body}
    </div>
  </div>;

  if (!rows) return shell(<div style={{ color: C.inkFaint, padding: 30 }}>{err ? "" : "Loading…"}</div>);

  const budget = status?.budget || {};
  const B = budget.monthly_usd ?? 10;
  const aiMtd = oai ? oai.mtd_usd : status?.mtd || 0;
  const aiForecast = oai ? Math.max(status?.forecast || 0, oai.mtd_usd / Math.max(1, +today.slice(8, 10)) * (status?.days_in_month || 30)) : status?.forecast || 0;
  const plans = (bills || budget.plans || DEFAULT_PLANS).map(p =>
    p.id === "railway" && rw ? { ...p, plan: rw.plan[0] + rw.plan.slice(1).toLowerCase(), usd: rw.bill_usd, live: true, check: false }
      : p.id === "supabase" && prov.supabase?.plan ? { ...p, plan: prov.supabase.plan[0].toUpperCase() + prov.supabase.plan.slice(1), live: true } : p);
  const monthly = plans.reduce((s, p) => s + (p.metered ? aiForecast : +p.usd || 0), 0);
  const openAlerts = (status?.open_alerts || []).filter(a => a.level !== "info");
  const transforms = snap?.supabase?.live ? null : snap?.supabase?.items?.find(i => /transform/i.test(i.k));
  const sbErr = status?.supabase_usage?.error || "";
  const needs = waiting.length + openAlerts.length;
  const p = status?.platform || {};
  const lim = status?.limits || { db: 8e9, storage: 100e9 };
  const fTone = status ? (aiMtd >= B ? "critical" : aiForecast > B ? "warn" : "good") : null;

  const saveBills = async next => { await saveK("girton-budget-v1", { ...budget, plans: next }, { merge: false }); setBills(next); showToast("Saved"); };
  const saveBudget = async () => { await saveK("girton-budget-v1", { ...budget, plans: bills || budget.plans || DEFAULT_PLANS, monthly_usd: Math.max(0, +budgetEdit || 0) }, { merge: false }); setBudgetEdit(null); refresh(); };

  const propList = props.filter(x => pFilter === "open" ? x.status === "proposed" : pFilter === "queued" ? ["approved", "building", "failed"].includes(x.status) : pFilter === "done" ? x.status === "done" : x.status === "declined")
    .sort((a, b) => ({ instant: 0, small: 1, medium: 2, large: 3 }[a.effort] ?? 2) - ({ instant: 0, small: 1, medium: 2, large: 3 }[b.effort] ?? 2));

  const alertsCard = <div style={card}>
    <div style={h}>Alerts</div>
    {openAlerts.map(a => { const t = TONE[a.level] || TONE.info; return <div key={a.id} style={{ background: t.bg, borderRadius: 8, padding: "8px 10px", marginBottom: 6, fontSize: 12.5, lineHeight: 1.45 }}><b style={{ color: t.c }}>{t.icon} {t.label}</b> {a.text}</div>; })}
    {transforms && transforms.used > transforms.limit && <div style={{ background: C.redBg, borderRadius: 8, padding: "8px 10px", marginBottom: 6, fontSize: 12.5, lineHeight: 1.45 }}><b style={{ color: C.red }}>● Supabase</b> Image transformations at {num(transforms.used)} of {num(transforms.limit)} this cycle (as of {snap.as_of}). This can restrict the project until {snap.supabase.cycle[1]}.</div>}
    {!openAlerts.length && !(transforms && transforms.used > transforms.limit) && <div style={{ background: C.greenBg, borderRadius: 8, padding: "8px 10px", fontSize: 12.5 }}><b style={{ color: C.green }}>✓ All quiet.</b> Nothing unusual in spend or limits.</div>}
    {alerts.length > 0 && <details style={{ marginTop: 8 }}><summary style={{ fontSize: 12, color: C.inkMid, cursor: "pointer" }}>Earlier alerts ({alerts.length})</summary>
      {alerts.slice(0, 30).map(a => <div key={a.id} style={{ fontSize: 12, color: C.inkMid, padding: "5px 0", borderBottom: `1px solid ${C.border}` }}><b>{a.day}</b> · {a.text}</div>)}
    </details>}
    <div style={{ ...sub, marginTop: 8 }}>Checked hourly; warnings also go to Telegram.</div>
  </div>;

  const budgetCard = <div style={card}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}><div style={h}>AI budget</div>
      {budgetEdit == null ? <button onClick={() => setBudgetEdit(B)} style={{ all: "unset", cursor: "pointer", fontSize: 12, fontWeight: 600, color: C.gold }}>Change</button>
        : <span style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="number" min="0" value={budgetEdit} onChange={e => setBudgetEdit(e.target.value)} style={FI({ width: 76, padding: "4px 8px" })} /><button onClick={saveBudget} style={btn(C.ink, "#fff")}>Save</button></span>}
    </div>
    <Meter label={oai ? "OpenAI bill this month" : "AI spend this month (estimated)"} used={aiMtd} limit={B} mark={aiForecast} right={`${usd(aiMtd)} of ${usd(B, 0)}`} note={`Forecast ${usd(aiForecast)} (${inr(aiForecast)}), the black tick.`} />
    <Live on={!!oai} at={oai?.at} what="OpenAI" />
  </div>;

  let body;
  if (tab === "overview") body = <>
    <div style={{ ...grid("repeat(4, minmax(0,1fr))", 10), marginBottom: 16 }}>
      <Metric label="Running cost / month" value={usd(monthly, 0)} note={`≈ ${inr(monthly)} · tools + AI`} />
      <Metric label="AI this month" value={usdS(aiMtd)} note={`forecast ${usd(aiForecast)} of ${usd(B, 0)}`} tone={fTone} />
      <Metric label="AI today" value={usdS(todayRow?.total?.usd || 0)} note={`${todayRow?.total?.calls || 0} calls${todayRow?.total?.errs ? ` · ${todayRow.total.errs} failed` : ""}`} />
      <Metric label="Needs you" value={needs || "—"} note={needs ? `${waiting.length} to approve${openAlerts.length ? ` · ${openAlerts.length} alert${openAlerts.length > 1 ? "s" : ""}` : ""}` : "all on track"} onClick={waiting.length ? () => go("proposals") : undefined} />
    </div>
    <div style={{ ...grid("minmax(0,1.45fr) minmax(0,1fr)", 14), marginBottom: 14 }}>
      <div style={{ display: "grid", gap: 10, alignContent: "start" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}><div style={{ ...h, margin: 0 }}>Waiting for your approval</div>{waiting.length > 2 && <button onClick={() => go("proposals")} style={{ all: "unset", cursor: "pointer", fontSize: 12, color: C.gold, fontWeight: 600 }}>All {waiting.length} →</button>}</div>
        {waiting.slice(0, 2).map(x => <Proposal key={x.id} p={x} onDecide={decide} busy={busy === x.id} />)}
        {!waiting.length && <div style={{ ...card, color: C.inkMid, fontSize: 13 }}>Nothing waiting. Girton adds proposals when his audit finds savings.</div>}
      </div>
      <div style={{ display: "grid", gap: 14, alignContent: "start" }}>{alertsCard}{budgetCard}</div>
    </div>
    <div style={grid("minmax(0,1.45fr) minmax(0,1fr)", 14)}>
      <div style={card}><div style={h}>AI spend per day</div><DailyBars days={oai?.days?.length ? last30.map(d => ({ ...d, usd: oai.days.find(x => x.day === d.day)?.usd ?? d.usd })) : last30} /><div style={{ ...sub, marginTop: 6 }}>{oai ? "OpenAI's own daily bill this month; earlier days from Girton's meter." : "From Girton's meter (estimated)."}</div></div>
      <div style={card}>
        <div style={h}>Limits at a glance</div>
        {!p.error && <><Meter label="Supabase database" used={p.db_bytes || 0} limit={lim.db} right={`${bytes(p.db_bytes)} of ${bytes(lim.db)}`} />
          <Meter label="Supabase storage" used={p.storage_bytes || 0} limit={lim.storage} right={`${bytes(p.storage_bytes)} of ${bytes(lim.storage)}`} /></>}
        {(snap?.supabase?.items || []).filter(i => /transform|^Egress/i.test(i.k)).map(i => <Meter key={i.k} label={i.k} used={i.used} limit={i.limit} right={`${num(i.used)} of ${num(i.limit)} ${i.unit}`} />)}
        {rw && <Meter label={`Railway ${rw.plan.toLowerCase()} usage`} used={rw.estimate_usd ?? rw.usage_usd} limit={rw.fee || 5} right={`${usd(rw.estimate_usd ?? rw.usage_usd)} of ${usd(rw.fee, 0)} included`} />}
        <Meter label="Vercel functions" used={audit?.vercel?.functions || 12} limit={audit?.vercel?.limit || 12} right={`${audit?.vercel?.functions ?? 12} of ${audit?.vercel?.limit || 12}`} />
        <button onClick={() => go("platforms")} style={{ all: "unset", cursor: "pointer", fontSize: 12, color: C.gold, fontWeight: 600 }}>All plans & bills →</button>
      </div>
    </div>
  </>;

  else if (tab === "proposals") body = <>
    <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
      {[["open", `Waiting (${waiting.length})`], ["queued", `Approved (${props.filter(x => ["approved", "building", "failed"].includes(x.status)).length})`], ["done", `Done (${props.filter(x => x.status === "done").length})`], ["declined", `Declined (${props.filter(x => x.status === "declined").length})`]].map(([k, l]) =>
        <button key={k} onClick={() => setPFilter(k)} style={pFilter === k ? btn(C.ink, "#fff") : btn()}>{l}</button>)}
      <span style={{ ...sub, marginLeft: 4 }}>⚡ applies the moment you approve · 🛠 queued for your next Claude session</span>
    </div>
    <div style={grid("repeat(2, minmax(0,1fr))")}>{propList.map(x => <Proposal key={x.id} p={x} onDecide={decide} busy={busy === x.id} />)}</div>
    {!propList.length && <div style={{ ...card, color: C.inkMid, fontSize: 13 }}>Nothing here.</div>}
  </>;

  else if (tab === "ai") body = <>
    <div style={{ ...grid("repeat(4, minmax(0,1fr))", 10), marginBottom: 14 }}>
      <Metric label="Today" value={usdS(todayRow?.total?.usd || 0)} note={`${inr(todayRow?.total?.usd || 0)} · ${todayRow?.total?.calls || 0} calls`} />
      <Metric label={oai ? "OpenAI bill · month" : "This month"} value={usdS(aiMtd)} note={`${inr(aiMtd)} of ${usd(B, 0)} budget`} />
      <Metric label="Month forecast" value={usd(aiForecast)} note={fTone === "good" ? "Within budget" : fTone === "warn" ? "Heading over budget" : fTone ? "Over budget" : ""} tone={fTone} />
      <Metric label="Failed calls today" value={todayRow?.total?.errs || 0} note={(todayRow?.total?.errs || 0) ? "Key, credit or rate limit" : "None"} tone={(todayRow?.total?.errs || 0) >= 3 ? "critical" : (todayRow?.total?.errs || 0) ? "warn" : "good"} />
    </div>
    <div style={{ ...card, marginBottom: 14 }}><div style={h}>AI spend per day, last 30 days</div><DailyBars days={last30} /><div style={{ ...sub, marginTop: 6 }}>Girton's meter: every AI call the ERP makes, priced at OpenAI's list rates.</div></div>
    <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
      {[["today", "Today"], ["7d", "7 days"], ["month", "This month"], ["all", "All"]].map(([k, l]) => <button key={k} onClick={() => setRange(k)} style={range === k ? btn(C.ink, "#fff") : btn()}>{l}</button>)}
      <span style={{ fontSize: 13, color: C.inkMid, marginLeft: 6 }}>{usd(total)} · {inr(total)}</span>
    </div>
    <div style={{ ...grid("minmax(0,1.3fr) minmax(0,1fr)", 14), marginBottom: 14 }}>
      <div style={card}>
        <div style={h}>What spent it</div>
        <Bars rows={features} total={total} onPick={setPicked} picked={picked} extra={r => `${r.calls}×`} empty="No AI calls in this period. The meter started on 6 Nov 2026." />
        {picked && <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.border}` }}>
          <span style={lab}>Which screen asked for {picked}</span>
          <Bars rows={screens.map(s => ({ ...s, k: s.k.split(":").slice(1).join(":") || "(server)" }))} total={total} extra={r => `${r.calls}×`} />
        </div>}
        <div style={{ ...sub, marginTop: 8 }}>Tap a feature to see which screen used it.</div>
      </div>
      <div style={card}>
        <div style={h}>Which model</div>
        <Bars rows={models} total={total} extra={r => `${r.calls}×`} />
        {todayRow?.top?.length > 0 && <>
          <div style={{ ...h, marginTop: 16 }}>Costliest calls today</div>
          {todayRow.top.slice(0, 6).map((x, i) => <Row key={i} l={`${new Date(x.at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })} · ${x.feature}`} r={usdS(x.usd)} />)}
        </>}
      </div>
    </div>
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}><div style={h}>OpenAI's own figures</div><Live on={!!oai} at={oai?.at} what="OpenAI" /></div>
      {oai ? <div style={grid("repeat(3, minmax(0,1fr))", 16)}>
        <div><span style={lab}>Bill by item · month</span><Bars rows={oai.line_items.map(x => ({ ...x }))} total={oai.mtd_usd} /></div>
        <div><span style={lab}>Tokens by API key</span><Bars rows={oai.keys.map(x => ({ k: x.name, v: x.in + x.out, calls: x.calls }))} value={r => r.v} fmt={tok} extra={r => `${num(r.calls)} calls`} /></div>
        <div><span style={lab}>Tokens by model</span><Bars rows={oai.models.map(x => ({ k: x.model, v: x.in + x.out, calls: x.calls }))} value={r => r.v} fmt={tok} extra={r => `${num(r.calls)} calls`} /></div>
      </div> : <div style={{ fontSize: 13, color: C.inkMid }}>{prov.openai?.error || "Add OPENAI_ADMIN_KEY in Vercel to see OpenAI's real bill, and tokens per API key (the ERP's, the Railway bot's) and per model."}</div>}
    </div>
  </>;

  else if (tab === "platforms") body = <>
    <div style={{ ...card, marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}><div style={h}>Monthly bills</div><div style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 700 }}>{usd(monthly, 0)} <span style={{ ...sub, fontFamily: FONT, fontSize: 12 }}>≈ {inr(monthly)}/month</span></div></div>
      {plans.map(pl => <div key={pl.id} style={{ display: "grid", gridTemplateColumns: mob() ? "minmax(0,1fr) 92px" : "minmax(0,160px) minmax(0,1fr) 110px", gap: 10, alignItems: "center", padding: "9px 0", borderTop: `1px solid ${C.border}` }}>
        <div><div style={{ fontWeight: 700, fontSize: 13.5 }}>{pl.name}</div><div style={sub}>{pl.plan}</div></div>
        {!mob() && <div style={{ fontSize: 12.5, color: C.inkMid }}>{pl.note}{pl.live && <span style={{ color: C.green, marginLeft: 6 }}>● live</span>}{pl.check && <span style={{ marginLeft: 6 }}><Tag t="warn">check amount</Tag></span>}</div>}
        <div style={{ textAlign: "right" }}>{pl.metered ? <span style={{ fontSize: 13.5, fontWeight: 700 }}>{usd(aiForecast)}<div style={sub}>forecast</div></span>
          : pl.live && pl.id === "railway" ? <span style={{ fontSize: 13.5, fontWeight: 700 }}>{usd(pl.usd)}<div style={sub}>this period</div></span>
          : <input type="number" min="0" step="1" defaultValue={pl.usd} onBlur={e => { const v = +e.target.value || 0; const base = bills || budget.plans || DEFAULT_PLANS; if (v !== +pl.usd || pl.check) saveBills(base.map(q => q.id === pl.id ? { ...q, usd: v, check: false } : q)); }} style={FI({ width: 82, textAlign: "right", padding: "5px 8px" })} />}</div>
      </div>)}
      <div style={{ ...sub, marginTop: 6 }}>Type an amount and click away to save. Live rows come from the provider's own API.</div>
    </div>

    <div style={{ ...grid("repeat(2, minmax(0,1fr))", 14), marginBottom: 14 }}>
      <div style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}><div style={h}>Supabase · {snap?.supabase?.plan || "Pro"}</div>{snap && <span style={sub}>cycle {snap.supabase.cycle[0]} → {snap.supabase.cycle[1]}</span>}</div>
        {!p.error ? <>
          <Meter label="Database" used={p.db_bytes || 0} limit={lim.db} right={`${bytes(p.db_bytes)} of ${bytes(lim.db)}`} />
          <Meter label="File storage" used={p.storage_bytes || 0} limit={lim.storage} right={`${bytes(p.storage_bytes)} of ${bytes(lim.storage)} · ${num(p.storage_objects)} files`} />
        </> : <div style={{ ...sub, marginBottom: 8 }}>Database figures: {p.error}</div>}
        {(snap?.supabase?.items || []).filter(i => !/storage/i.test(i.k)).map(i => <Meter key={i.k} label={i.k} used={i.used} limit={i.limit} right={`${num(i.used)} of ${num(i.limit)} ${i.unit}`} />)}
        {prov.supabase?.day && <div style={{ marginTop: 6 }}><span style={lab}>Last 24 hours · from the project's logs</span>
          <Row l="Requests" r={num(prov.supabase.day.requests)} />
          <Row l="File downloads" r={num(prov.supabase.day.file_requests)} />
          {prov.supabase.day.egress_gb > 0 && <Row l="Data sent (approx.)" r={`${prov.supabase.day.egress_gb} GB`} />}
          <Row l="Image transformations" r={<span style={{ color: prov.supabase.day.transforms > 20 ? C.red : C.ink }}>{num(prov.supabase.day.transforms)}</span>} />
          <div style={{ marginTop: 4 }}><Live on at={prov.supabase.at} what="Supabase" /></div></div>}
        {snap?.supabase?.live ? <Live on at={snap.supabase.as_of_ms} what="Supabase" />
          : <div style={{ ...sub, marginTop: 6 }}>Cycle totals as of {snap?.as_of} ({daysSince(snap?.as_of)} d ago), read from the dashboard: Supabase's API gives tokens no cycle totals.</div>}
        {sbErr && !status?.supabase_usage?.missing && <div style={{ ...sub, color: C.amber, marginTop: 4 }}>▲ {sbErr}</div>}
      </div>
      <div style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}><div style={h}>Railway{rw ? ` · ${rw.plan[0]}${rw.plan.slice(1).toLowerCase()}` : ""}</div><Live on={!!rw} at={prov.railway?.at} what="Railway" /></div>
        {rw ? <>
          <Meter label="Usage this period" used={rw.estimate_usd ?? rw.usage_usd} limit={Math.max(rw.fee, 1)} right={`${usd(rw.usage_usd)} so far${rw.estimate_usd != null ? ` · ${usd(rw.estimate_usd)} expected` : ""}`} note={`${usd(rw.fee, 0)} of usage is included in the plan fee.`} />
          {rw.lines.map(l => <Row key={l.k} l={l.k} r={`${usd(l.usd)}${l.est_usd ? ` → ${usd(l.est_usd)}` : ""}`} />)}
          {rw.period && <Row l="Billing period" r={`${rw.period[0]} → ${rw.period[1]}`} />}
          {rw.credit_usd != null && <Row l="Credit balance" r={usd(rw.credit_usd)} />}
          {rw.limit?.hard != null && <Row l="Spend limit" r={`${rw.limit.soft != null ? `soft $${rw.limit.soft} · ` : ""}hard $${rw.limit.hard}`} />}
          {rw.next_invoice && <Row l="Next invoice" r={`${rw.next_invoice.date}${rw.next_invoice.cents != null ? ` · ${usd(rw.next_invoice.cents / 100)}` : ""}`} strong />}
          {rw.services.length > 0 && <div style={{ marginTop: 10 }}><span style={lab}>Services</span>
            {rw.services.map(s => <Row key={s.project + s.service} l={`${s.service} · ${s.project}`} r={<Tag t={/SUCCESS/.test(s.status) ? "good" : /FAILED|CRASHED/.test(s.status) ? "critical" : "info"}>{s.status}</Tag>} />)}</div>}
        </> : <div style={{ fontSize: 13, color: C.inkMid }}>{prov.railway?.error || "Add RAILWAY_TOKEN in Vercel to see Railway's plan, this period's bill, credit, limits and whether the bot is up."}</div>}
      </div>
    </div>

    <div style={{ ...grid("repeat(2, minmax(0,1fr))", 14), marginBottom: 14 }}>
      {budgetCard}
      <div style={card}><div style={h}>Vercel · Hobby</div>
        <Meter label="Serverless functions" used={audit?.vercel?.functions || 12} limit={audit?.vercel?.limit || 12} right={`${audit?.vercel?.functions ?? 12} of ${audit?.vercel?.limit || 12}`} note="Full by design: new server features fold into existing files (free); the next plan is $20/month." />
      </div>
    </div>

    {!p.error && (p.tables?.length || p.app_rows_keys?.length) ? <div style={{ ...grid("repeat(2, minmax(0,1fr))", 14), marginBottom: 14 }}>
      <div style={card}><div style={h}>Biggest tables</div>{(p.tables || []).slice(0, 8).map(t => <Row key={t.table} l={t.table} r={`${bytes(t.bytes)} · ${num(t.rows)} rows`} />)}</div>
      <div style={card}><div style={h}>Biggest stored data</div>
        {[...(p.app_rows_keys || []).map(k => ({ ...k, kind: `${num(k.rows)} rows` })), ...(p.app_data_keys || []).map(k => ({ ...k, kind: "single value" }))].sort((a, b) => b.bytes - a.bytes).slice(0, 8).map(k => <Row key={k.key + k.kind} l={k.key} r={`${bytes(k.bytes)} · ${k.kind}`} />)}
        <div style={{ ...sub, marginTop: 6 }}>A big single value is downloaded whole by every screen that reads it.</div>
      </div>
    </div> : null}

    <div style={{ ...card, background: C.card }}>
      <div style={h}>Connections</div>
      <div style={{ ...sub, fontSize: 12.5, marginBottom: 6 }}>Each key goes in Vercel → the ERP project → Settings → Environment Variables (Production), then redeploy. Only you can create them.</div>
      {[["OpenAI", "OPENAI_ADMIN_KEY", "platform.openai.com → Settings → Organization → Admin keys", !!oai, prov.openai?.error],
        ["Supabase", "SUPABASE_ACCESS_TOKEN", "supabase.com/dashboard/account/tokens → Generate new token", !!(snap?.supabase?.live || prov.supabase?.day), status?.supabase_usage?.missing ? null : sbErr],
        ["Railway", "RAILWAY_TOKEN", "railway.com/account/tokens → New token, workspace: No workspace", !!rw, prov.railway?.error]].map(([n, v, how, on, e]) =>
        <div key={n} style={{ display: "flex", gap: 10, alignItems: "baseline", padding: "8px 0", borderTop: `1px solid ${C.border}`, fontSize: 13 }}>
          <span style={{ width: 16, color: on ? C.green : e ? C.amber : C.inkFaint }}>{on ? "●" : e ? "▲" : "○"}</span>
          <div style={{ flex: 1, minWidth: 0 }}><b>{n}</b> <code style={{ fontSize: 11.5, background: C.surface, padding: "1px 5px", borderRadius: 4 }}>{v}</code><div style={sub}>{on ? "Connected." : e || how}</div></div>
        </div>)}
    </div>
  </>;

  else body = <div style={card}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}><div style={h}>Where money and tokens leak</div>{audit && <span style={sub}>run {audit.day} · {audit.findings?.length || 0} findings</span>}</div>
    {!audit && <div style={{ ...sub, fontSize: 13 }}>No audit yet.</div>}
    {(audit?.findings || []).map((f, i) => { const t = TONE[f.level] || TONE.info; return <details key={i} style={{ borderTop: `1px solid ${C.border}`, padding: "9px 0" }}>
      <summary style={{ cursor: "pointer", fontSize: 13.5, display: "flex", gap: 8, alignItems: "baseline" }}><b style={{ color: t.c, width: 14 }}>{t.icon}</b><span style={{ flex: 1 }}><b>{f.title}</b> <span style={{ color: C.inkFaint }}>· {f.area}</span></span>{f.saving && <Tag t="good">{f.saving}</Tag>}</summary>
      <div style={{ fontSize: 13, color: C.inkMid, margin: "7px 0 0 22px", lineHeight: 1.55 }}>{f.detail}{f.fix && <div style={{ marginTop: 5 }}><b style={{ color: C.ink }}>Fix:</b> {f.fix}</div>}{f.where && <div style={{ marginTop: 5, fontFamily: "ui-monospace, monospace", fontSize: 11.5, color: C.inkFaint, wordBreak: "break-all" }}>{f.where}</div>}</div>
    </details>; })}
  </div>;

  return shell(body);
}
