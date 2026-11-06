/* Girton — the cost watchdog's page.

   Everything here is read from app_rows "girton-v1", which the hourly
   girton_tick (lib/girton.js) writes from the AI meter (lib/ai-meter.js):
   one row per day, a status row, the alert history and the code audit
   (scripts/girton/audit.mjs). The page only reads and draws; the one write is
   the budget (app_data "girton-budget-v1"). */
import { useState, useEffect, useMemo } from "react";
import { supabase } from "./supabase.js";
import { C, mob, FI } from "./lmTheme.js";
import { saveK } from "./utils.js";

const KEY = "girton-v1";
const USD_INR = 88;
const HUE = "#2F6FDE";          // one hue: every chart here is magnitude
const usd = (x, d = 2) => `$${(+x || 0).toFixed(d)}`;
const usdSmart = x => (x >= 1 ? usd(x) : x >= 0.01 ? usd(x, 3) : usd(x, 4));
const inr = x => `₹${Math.round((+x || 0) * USD_INR).toLocaleString("en-IN")}`;
const tok = n => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n || 0);
const bytes = b => b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(0)} MB` : `${Math.round((b || 0) / 1e3)} kB`;
const LEVEL = { critical: { c: C.red, bg: C.redBg, icon: "●", label: "Critical" }, warn: { c: C.amber, bg: C.amberBg, icon: "▲", label: "Warning" },
  info: { c: C.blue, bg: C.blueBg, icon: "i", label: "Note" }, good: { c: C.green, bg: C.greenBg, icon: "✓", label: "OK" } };

const card = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14, minWidth: 0 };
const h3 = { margin: "0 0 10px", fontSize: 13, fontWeight: 800, letterSpacing: .2, color: C.ink };

function Tile({ label, value, sub, tone }) {
  return <div style={{ ...card, padding: "12px 14px" }}>
    <div style={{ fontSize: 11, color: C.inkFaint, fontWeight: 700, textTransform: "uppercase", letterSpacing: .4 }}>{label}</div>
    <div style={{ fontSize: 22, fontWeight: 800, marginTop: 4, color: C.ink }}>{value}</div>
    {sub && <div style={{ fontSize: 12, color: tone ? LEVEL[tone].c : C.inkMid, marginTop: 2 }}>{tone && <b>{LEVEL[tone].icon} </b>}{sub}</div>}
  </div>;
}

function Meter({ used, limit, mark, label, right }) {
  const pct = limit ? Math.min(100, used / limit * 100) : 0;
  const mpct = limit && mark != null ? Math.min(100, mark / limit * 100) : null;
  const tone = pct >= 100 ? C.red : pct >= 80 ? C.amber : HUE;
  return <div style={{ marginBottom: 12 }}>
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 5, gap: 8 }}>
      <span style={{ fontWeight: 700 }}>{label}</span><span style={{ color: C.inkMid, textAlign: "right" }}>{right}</span>
    </div>
    <div style={{ position: "relative", height: 12, background: C.card, borderRadius: 6 }}>
      <div style={{ width: `${pct}%`, height: "100%", background: tone, borderRadius: 6 }} />
      {mpct != null && <div title="Forecast for the month" style={{ position: "absolute", left: `calc(${mpct}% - 1px)`, top: -3, width: 2, height: 18, background: C.ink }} />}
    </div>
  </div>;
}

/* Daily AI spend, last 30 days. One series, so no legend; hover shows the day. */
function DailyBars({ days }) {
  const [hov, setHov] = useState(null);
  const max = Math.max(0.0001, ...days.map(d => d.usd));
  return <div>
    <div style={{ position: "relative", height: 140, display: "flex", alignItems: "flex-end", gap: 2, borderBottom: `1px solid ${C.border}` }}>
      {days.map((d, i) => <div key={d.day} onMouseEnter={() => setHov(i)} onMouseLeave={() => setHov(null)}
        style={{ flex: 1, height: "100%", display: "flex", alignItems: "flex-end", cursor: "default" }}>
        <div style={{ width: "100%", height: `${Math.max(d.usd ? 2 : 0, d.usd / max * 100)}%`, background: HUE, opacity: hov == null || hov === i ? 1 : .45, borderRadius: "4px 4px 0 0" }} />
      </div>)}
      {hov != null && <div style={{ position: "absolute", top: 0, left: `${Math.min(70, hov / days.length * 100)}%`, background: C.ink, color: C.surface, fontSize: 12, padding: "6px 9px", borderRadius: 7, pointerEvents: "none", whiteSpace: "nowrap" }}>
        <b>{days[hov].day}</b><br />{usdSmart(days[hov].usd)} · {inr(days[hov].usd)}<br />{days[hov].calls} calls{days[hov].errs ? ` · ${days[hov].errs} failed` : ""}
      </div>}
    </div>
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, color: C.inkFaint, marginTop: 4 }}>
      <span>{days[0]?.day}</span><span>highest {usdSmart(max)}/day</span><span>{days[days.length - 1]?.day}</span>
    </div>
  </div>;
}

/* Spend by feature: horizontal bars, one hue, value labels in ink. */
function Breakdown({ rows, total, onPick, picked }) {
  const max = Math.max(0.0001, ...rows.map(r => r.usd));
  return <div style={{ display: "grid", gap: 6 }}>
    {rows.map(r => <button key={r.k} onClick={() => onPick?.(picked === r.k ? null : r.k)} title={`${r.calls} calls · ${tok(r.in)} in / ${tok(r.out)} out · ${usdSmart(r.calls ? r.usd / r.calls : 0)} per call`}
      style={{ all: "unset", cursor: onPick ? "pointer" : "default", display: "grid", gridTemplateColumns: mob() ? "minmax(0,1fr) 70px" : "minmax(0,170px) minmax(0,1fr) 150px", alignItems: "center", gap: 8, fontSize: 12.5, padding: "3px 4px", borderRadius: 6, background: picked === r.k ? C.card : "transparent" }}>
      <span style={{ fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.k}{r.errs ? <span style={{ color: C.red, fontWeight: 600 }}> · {r.errs} failed</span> : null}</span>
      {!mob() && <div style={{ background: C.card, borderRadius: 6, height: 14 }}><div style={{ width: `${r.usd / max * 100}%`, height: "100%", background: HUE, borderRadius: 6 }} /></div>}
      <span style={{ textAlign: "right", color: C.inkMid }}>{usdSmart(r.usd)}<span style={{ color: C.inkFaint }}> · {total ? Math.round(r.usd / total * 100) : 0}% · {r.calls}×</span></span>
    </button>)}
    {!rows.length && <div style={{ color: C.inkFaint, fontSize: 13 }}>No AI calls recorded yet. The meter started on 6 Nov 2026.</div>}
  </div>;
}

const sumInto = (acc, obj) => { for (const [k, v] of Object.entries(obj || {})) { const t = acc[k] ||= { k, calls: 0, in: 0, out: 0, usd: 0, errs: 0 }; t.calls += v.calls; t.in += v.in; t.out += v.out; t.usd += v.usd; t.errs += v.errs; } return acc; };

export default function GirtonApp({ onHome }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [range, setRange] = useState("month");
  const [picked, setPicked] = useState(null);
  const [edit, setEdit] = useState(null);

  const load = async () => {
    const { data, error } = await supabase.from("app_rows").select("data").eq("key", KEY).eq("deleted", false).limit(500);
    if (error) return setErr(error.message);
    setRows((data || []).map(r => r.data));
  };
  useEffect(() => { load(); }, []);

  const refresh = async () => {
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/listing-manager", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "girton_refresh" }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      await load();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const status = rows?.find(r => r.id === "status");
  const alerts = rows?.find(r => r.id === "alerts")?.list || [];
  const audit = rows?.find(r => r.id === "audit");
  const dayRows = useMemo(() => (rows || []).filter(r => r.id?.startsWith("day|")).sort((a, b) => a.day < b.day ? -1 : 1), [rows]);
  const today = status?.today || new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const inRange = useMemo(() => dayRows.filter(d => range === "today" ? d.day === today : range === "7d" ? d.day > new Date(Date.parse(today) - 7 * 864e5).toISOString().slice(0, 10) : range === "month" ? d.day.startsWith(today.slice(0, 7)) : true), [dayRows, range, today]);
  const total = inRange.reduce((s, d) => s + (d.total?.usd || 0), 0);
  const features = useMemo(() => Object.values(inRange.reduce((a, d) => sumInto(a, d.feature), {})).sort((a, b) => b.usd - a.usd), [inRange]);
  const models = useMemo(() => Object.values(inRange.reduce((a, d) => sumInto(a, d.model), {})).sort((a, b) => b.usd - a.usd), [inRange]);
  const screens = useMemo(() => picked ? Object.values(inRange.reduce((a, d) => sumInto(a, Object.fromEntries(Object.entries(d.screen || {}).filter(([k]) => k.split(":")[0] === picked))), {})).sort((a, b) => b.usd - a.usd) : [], [inRange, picked]);
  const last30 = useMemo(() => {
    const out = [], by = Object.fromEntries(dayRows.map(d => [d.day, d]));
    for (let i = 29; i >= 0; i--) { const day = new Date(Date.parse(today) - i * 864e5).toISOString().slice(0, 10); const t = by[day]?.total; out.push({ day, usd: t?.usd || 0, calls: t?.calls || 0, errs: t?.errs || 0 }); }
    return out;
  }, [dayRows, today]);
  const todayRow = dayRows.find(d => d.day === today);

  if (!rows) return <div style={{ padding: 24, color: C.inkMid }}>{err || "Loading Girton…"}</div>;

  const B = status?.budget?.monthly_usd || 10;
  const fTone = !status ? null : status.mtd >= B ? "critical" : status.forecast > B ? "warn" : "good";
  const p = status?.platform || {};
  const lim = status?.limits || { db: 8e9, storage: 100e9, label: "Supabase Pro (included)" };
  const grid = cols => ({ display: "grid", gridTemplateColumns: mob() ? "minmax(0,1fr)" : cols, gap: 12 });

  const saveBudget = async () => {
    const v = { monthly_usd: Math.max(0, +edit.monthly_usd || 0), supabase_plan: edit.supabase_plan };
    await saveK("girton-budget-v1", v, { merge: false });
    setEdit(null); refresh();
  };

  return <div style={{ maxWidth: 1180, margin: "0 auto", padding: mob() ? "12px 12px 40px" : "18px 22px 50px", overflowX: "hidden" }}>
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
      {onHome && <button onClick={onHome} style={{ ...FI({ width: "auto", padding: "6px 11px", cursor: "pointer" }) }}>← Home</button>}
      <div style={{ flex: 1, minWidth: 200 }}>
        <div style={{ fontSize: 20, fontWeight: 800 }}>🧮 Girton</div>
        <div style={{ fontSize: 12.5, color: C.inkMid }}>Cost watch: AI spend, platform limits, and where the code wastes money. {status && <>Checked {new Date(status.at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}.</>}</div>
      </div>
      <button onClick={refresh} disabled={busy} style={{ ...FI({ width: "auto", padding: "7px 13px", cursor: "pointer", fontWeight: 700 }) }}>{busy ? "Checking…" : "↻ Check now"}</button>
    </div>
    {err && <div style={{ ...card, background: C.redBg, color: C.red, marginBottom: 12 }}>{err}</div>}

    <div style={{ ...grid("repeat(5, minmax(0,1fr))"), marginBottom: 12 }}>
      <Tile label="Today" value={usdSmart(todayRow?.total?.usd || 0)} sub={`${inr(todayRow?.total?.usd || 0)} · ${todayRow?.total?.calls || 0} calls`} />
      <Tile label="This month" value={usd(status?.mtd || 0)} sub={`${inr(status?.mtd || 0)} of ${usd(B, 0)} budget`} />
      <Tile label="Month forecast" value={usd(status?.forecast || 0)} sub={fTone === "good" ? "Within budget" : fTone === "warn" ? "Heading over budget" : fTone ? "Over budget" : ""} tone={fTone} />
      <Tile label="7-day average" value={`${usdSmart(status?.avg7 || 0)}/day`} sub={`≈ ${inr((status?.avg7 || 0) * 30)}/month`} />
      <Tile label="Failed AI calls today" value={todayRow?.total?.errs || 0} sub={(todayRow?.total?.errs || 0) ? "Key, quota or rate limit" : "None"} tone={(todayRow?.total?.errs || 0) >= 3 ? "critical" : (todayRow?.total?.errs || 0) ? "warn" : "good"} />
    </div>

    <div style={{ ...grid("minmax(0,1.3fr) minmax(0,1fr)"), marginBottom: 12 }}>
      <div style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <h3 style={h3}>Budget</h3>
          <button onClick={() => setEdit(edit ? null : { monthly_usd: B, supabase_plan: status?.budget?.supabase_plan || "pro" })} style={{ all: "unset", cursor: "pointer", fontSize: 12, color: C.blue, fontWeight: 700 }}>{edit ? "Cancel" : "Edit"}</button>
        </div>
        {edit && <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12, alignItems: "center" }}>
          <label style={{ fontSize: 12.5 }}>Monthly AI budget (USD) <input type="number" min="0" step="1" value={edit.monthly_usd} onChange={e => setEdit({ ...edit, monthly_usd: e.target.value })} style={FI({ width: 90, marginLeft: 6 })} /></label>
          <label style={{ fontSize: 12.5 }}>Supabase plan <select value={edit.supabase_plan} onChange={e => setEdit({ ...edit, supabase_plan: e.target.value })} style={FI({ width: 100, marginLeft: 6 })}><option value="free">Free</option><option value="pro">Pro</option></select></label>
          <button onClick={saveBudget} style={{ ...FI({ width: "auto", cursor: "pointer", fontWeight: 700, background: C.ink, color: C.surface }) }}>Save</button>
        </div>}
        <Meter used={status?.mtd || 0} limit={B} mark={status?.forecast} label="AI spend this month" right={`${usd(status?.mtd || 0)} spent · forecast ${usd(status?.forecast || 0)} · budget ${usd(B, 0)}`} />
        {p.error ? <div style={{ fontSize: 12.5, color: C.amber }}>Supabase usage: {p.error}</div> : <>
          <Meter used={p.db_bytes || 0} limit={lim.db} label="Supabase database" right={`${bytes(p.db_bytes)} of ${bytes(lim.db)}`} />
          <Meter used={p.storage_bytes || 0} limit={lim.storage} label="Supabase file storage" right={`${bytes(p.storage_bytes)} of ${bytes(lim.storage)} · ${(p.storage_objects || 0).toLocaleString("en-IN")} files`} />
        </>}
        <Meter used={audit?.vercel?.functions || 12} limit={audit?.vercel?.limit || 12} label="Vercel functions" right={`${audit?.vercel?.functions ?? 12} of ${audit?.vercel?.limit || 12} (Hobby cap)`} />
        <div style={{ fontSize: 11.5, color: C.inkFaint }}>The black tick on the AI bar is the month's forecast. Vercel bandwidth and Railway usage need their API tokens (phase 2). Costs are estimated from OpenAI's list prices; OpenAI's usage page is the actual bill.</div>
      </div>
      <div style={card}>
        <h3 style={h3}>Alerts</h3>
        {(status?.open_alerts?.length ? status.open_alerts : []).map(a => { const L = LEVEL[a.level] || LEVEL.info; return <div key={a.id} style={{ background: L.bg, borderRadius: 8, padding: "8px 10px", marginBottom: 6, fontSize: 12.5 }}><b style={{ color: L.c }}>{L.icon} {L.label}</b> <span style={{ color: C.ink }}>{a.text}</span></div>; })}
        {!status?.open_alerts?.length && <div style={{ background: C.greenBg, borderRadius: 8, padding: "8px 10px", fontSize: 12.5 }}><b style={{ color: C.green }}>✓ OK</b> Nothing unusual today.</div>}
        {alerts.length > 0 && <details style={{ marginTop: 8 }}><summary style={{ fontSize: 12, color: C.inkMid, cursor: "pointer" }}>Earlier alerts ({alerts.length})</summary>
          {alerts.slice(0, 30).map(a => <div key={a.id} style={{ fontSize: 12, color: C.inkMid, padding: "4px 0", borderBottom: `1px solid ${C.border}` }}><b>{a.day}</b> · {a.text}</div>)}
        </details>}
        <div style={{ fontSize: 11.5, color: C.inkFaint, marginTop: 8 }}>Checked every hour. New warnings go to Telegram: budget pace, a feature spending 3× its usual, 3+ failed calls in an hour, any single call over $0.20.</div>
      </div>
    </div>

    <div style={{ ...card, marginBottom: 12 }}>
      <h3 style={h3}>AI spend per day, last 30 days</h3>
      <DailyBars days={last30} />
    </div>

    <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
      {[["today", "Today"], ["7d", "7 days"], ["month", "This month"], ["all", "All"]].map(([k, l]) => <button key={k} onClick={() => setRange(k)} style={{ ...FI({ width: "auto", padding: "5px 12px", cursor: "pointer", fontWeight: 700, background: range === k ? C.ink : C.surface, color: range === k ? C.surface : C.ink }) }}>{l}</button>)}
      <span style={{ fontSize: 12.5, color: C.inkMid, alignSelf: "center", marginLeft: 6 }}>{usd(total)} · {inr(total)}</span>
    </div>
    <div style={{ ...grid("minmax(0,1.3fr) minmax(0,1fr)"), marginBottom: 12 }}>
      <div style={card}>
        <h3 style={h3}>What spent it (feature)</h3>
        <Breakdown rows={features} total={total} onPick={setPicked} picked={picked} />
        {picked && <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 12, color: C.inkMid, marginBottom: 6 }}>Which screen asked for <b>{picked}</b>:</div>
          <Breakdown rows={screens.map(s => ({ ...s, k: s.k.split(":").slice(1).join(":") || "(server)" }))} total={total} />
        </div>}
      </div>
      <div style={card}>
        <h3 style={h3}>Which model</h3>
        <Breakdown rows={models} total={total} />
        {todayRow?.top?.length > 0 && <>
          <h3 style={{ ...h3, marginTop: 16 }}>Costliest calls today</h3>
          {todayRow.top.slice(0, 6).map((x, i) => <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "4px 0", borderBottom: `1px solid ${C.border}`, gap: 8 }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{new Date(x.at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })} · {x.feature} · <span style={{ color: C.inkFaint }}>{x.model}</span></span>
            <span style={{ whiteSpace: "nowrap", color: C.inkMid }}>{usdSmart(x.usd)} · {tok(x.in)}/{tok(x.out)}</span>
          </div>)}
        </>}
      </div>
    </div>

    {!p.error && (p.tables?.length || p.app_rows_keys?.length) ? <div style={{ ...grid("minmax(0,1fr) minmax(0,1fr)"), marginBottom: 12 }}>
      <div style={card}>
        <h3 style={h3}>Biggest database tables</h3>
        {(p.tables || []).slice(0, 8).map(t => <div key={t.table} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "3px 0", gap: 8 }}><span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{t.table}</span><span style={{ color: C.inkMid, whiteSpace: "nowrap" }}>{bytes(t.bytes)} · {(t.rows || 0).toLocaleString("en-IN")} rows</span></div>)}
      </div>
      <div style={card}>
        <h3 style={h3}>Biggest stored keys</h3>
        {[...(p.app_rows_keys || []).map(k => ({ ...k, kind: `${k.rows} rows` })), ...(p.app_data_keys || []).map(k => ({ ...k, kind: "one value" }))].sort((a, b) => b.bytes - a.bytes).slice(0, 8)
          .map(k => <div key={k.key + k.kind} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "3px 0", gap: 8 }}><span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{k.key}</span><span style={{ color: C.inkMid, whiteSpace: "nowrap" }}>{bytes(k.bytes)} · {k.kind}</span></div>)}
        <div style={{ fontSize: 11.5, color: C.inkFaint, marginTop: 6 }}>A big single value is re-downloaded whole by every open screen that reads it.</div>
      </div>
    </div> : null}

    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <h3 style={h3}>Code audit: where money and tokens leak</h3>
        {audit && <span style={{ fontSize: 12, color: C.inkFaint }}>Run {audit.day} · {audit.findings?.length || 0} findings{audit.saving_usd_month ? ` · about ${usd(audit.saving_usd_month, 0)}/month to save` : ""}</span>}
      </div>
      {!audit && <div style={{ fontSize: 13, color: C.inkFaint }}>No audit yet. It runs from the Mac (scripts/girton/audit.mjs).</div>}
      {(audit?.findings || []).map((f, i) => { const L = LEVEL[f.level] || LEVEL.info; return <details key={i} style={{ borderTop: i ? `1px solid ${C.border}` : "none", padding: "8px 0" }}>
        <summary style={{ cursor: "pointer", fontSize: 13 }}><b style={{ color: L.c }}>{L.icon}</b> <b>{f.title}</b> <span style={{ color: C.inkFaint }}>· {f.area}{f.saving ? ` · saves ${f.saving}` : ""}</span></summary>
        <div style={{ fontSize: 12.5, color: C.inkMid, margin: "6px 0 0 18px", lineHeight: 1.5 }}>{f.detail}{f.fix && <div style={{ marginTop: 4 }}><b style={{ color: C.ink }}>Fix:</b> {f.fix}</div>}{f.where && <div style={{ marginTop: 4, fontFamily: "ui-monospace, monospace", fontSize: 11.5, color: C.inkFaint }}>{f.where}</div>}</div>
      </details>; })}
    </div>
  </div>;
}
