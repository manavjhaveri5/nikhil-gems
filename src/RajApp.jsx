/* Raj — the chief of operations. His briefings, follow-ups and memory live in
   app_rows (raj-briefings-v1, raj-notes-v1, raj-snapshots-v1). The thinking is
   done on Manav's Mac by Claude scheduled tasks (scripts/raj/RAJ.md); this page
   reads what they wrote, lets Sir manage follow-ups, and offers a quick chat
   (Ask Raj) through /api/claude with the latest briefing as context. */
import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { supabase } from "./supabase.js";
import { C, mob, FI } from "./lmTheme.js";
import { fetchWithRetry } from "./aiClient.js";
import { DRAFTABLE, AI_CHECKS } from "../lib/raj-fix-kinds.js";

export const RAJ_KEYS = { notes: "raj-notes-v1", briefings: "raj-briefings-v1", snapshots: "raj-snapshots-v1", audit: "raj-audit-v1", proposals: "raj-proposals-v1" };
const FONT = "-apple-system,'SF Pro Display','Figtree',system-ui,sans-serif";
const SERIF = "'Cormorant Garamond',Georgia,serif";
const card = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12 };
const btn = (bg = C.surface, fg = C.ink) => ({ background: bg, color: fg, border: bg === C.surface ? `1px solid ${C.border}` : "none", borderRadius: 7, padding: "7px 13px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" });
const lab = { fontSize: 9.5, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .6, marginBottom: 4, display: "block" };
const IST = 5.5 * 3600e3;
export const istDay = (ms = Date.now()) => new Date(ms + IST).toISOString().slice(0, 10);
const KIND = {
  followup: ["📌", "Follow-up", C.amber], problem: ["⚠️", "Problem", C.red], solution: ["🛠", "Solution", C.green],
  decision: ["⚖️", "Decision", C.blue], experiment: ["🧪", "Experiment", C.purple], knowledge: ["📚", "Knowledge", C.teal],
  lesson: ["🎓", "Lesson", C.gold],
};
const CH = { etsy: "Atyahara Etsy", etsy_ee: "EarthEditions Etsy", ebay: "eBay", store: "eartheditions.co", shopify_aty: "Atyahara Shopify", shopify_earth: "Earth Editions Shopify", trade: "Trade" };
const money = (v, cur = "INR") => v == null ? "—" : `${cur === "INR" ? "₹" : cur === "USD" ? "$" : cur + " "}${Math.round(v).toLocaleString(cur === "INR" ? "en-IN" : "en-US")}`;

/* ── data ───────────────────────────────────────────────────────────────── */
export async function rajRows(key, { limit = 1000 } = {}) {
  const { data, error } = await supabase.from("app_rows").select("data").eq("key", key).eq("deleted", false).order("pos", { ascending: true }).limit(limit);
  if (error) throw new Error(error.message);
  return (data || []).map(r => r.data);
}
export async function rajRow(key, id) {
  const { data } = await supabase.from("app_rows").select("data").eq("key", key).eq("id", id).eq("deleted", false).maybeSingle();
  return data?.data || null;
}
async function saveNote(n) {
  const now = new Date().toISOString();
  const item = { ...n, id: n.id || `${n.kind}-${Date.now().toString(36)}`, created_at: n.created_at || now, updated_at: now };
  const { error } = await supabase.rpc("app_rows_upsert", { p_key: RAJ_KEYS.notes, p_item: item, p_prepend: true });
  if (error) throw new Error(error.message);
  return item;
}

/* A small Markdown reader: headings, bullets, bold, italics. Enough for Raj. */
export function Md({ text, size = 13.5 }) {
  const inline = s => {
    const out = []; let rest = s, k = 0;
    const re = /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`/;
    for (let m; (m = re.exec(rest));) {
      if (m.index) out.push(rest.slice(0, m.index));
      out.push(m[1] ? <b key={k++}>{m[1]}</b> : m[2] ? <i key={k++}>{m[2]}</i> : <code key={k++} style={{ fontSize: "0.92em", background: C.card, padding: "0 4px", borderRadius: 4 }}>{m[3]}</code>);
      rest = rest.slice(m.index + m[0].length);
    }
    if (rest) out.push(rest);
    return out;
  };
  const blocks = []; let list = null;
  String(text || "").split("\n").forEach((line, i) => {
    const h = /^(#{1,4})\s+(.*)/.exec(line), li = /^\s*(?:[-*•]|\d+\.)\s+(.*)/.exec(line);
    if (li) { (list ||= []).push(<li key={i} style={{ margin: "3px 0" }}>{inline(li[1])}</li>); return; }
    if (list) { blocks.push(<ul key={`u${i}`} style={{ margin: "4px 0 10px", paddingLeft: 20 }}>{list}</ul>); list = null; }
    if (h) blocks.push(<div key={i} style={{ fontWeight: 700, fontSize: h[1].length <= 2 ? size + 3 : size + 1, margin: "14px 0 5px", color: C.ink }}>{inline(h[2])}</div>);
    else if (line.trim()) blocks.push(<p key={i} style={{ margin: "5px 0" }}>{inline(line)}</p>);
  });
  if (list) blocks.push(<ul key="uend" style={{ margin: "4px 0 10px", paddingLeft: 20 }}>{list}</ul>);
  return <div style={{ fontSize: size, lineHeight: 1.55, color: C.ink }}>{blocks}</div>;
}

const Badge = ({ a }) => {
  const s = String(a || "").split(/[\s:—-]/)[0].toLowerCase();
  const [bg, fg] = s === "verified" ? [C.greenBg, C.green] : s === "recorded" ? [C.blueBg, C.blue] : s === "estimated" ? [C.amberBg, C.amber] : [C.redBg, C.red];
  return <span title={a} style={{ fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: .4, background: bg, color: fg, borderRadius: 4, padding: "1px 6px" }}>{s || "?"}</span>;
};

/* ── Briefing ───────────────────────────────────────────────────────────── */
function Metric({ label, value, sub, avail }) {
  return (
    <div style={{ ...card, padding: "12px 14px", minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 6, alignItems: "center" }}><span style={lab}>{label}</span>{avail && <Badge a={avail} />}</div>
      <div style={{ fontSize: 22, fontWeight: 700, fontFamily: SERIF }}>{value}</div>
      {sub && <div style={{ fontSize: 11.5, color: C.inkMid, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function SnapshotCards({ s }) {
  if (!s) return null;
  const t = s.sales?.total || {}, av = s.availability || {};
  const avg7 = Object.values(s.sales?.compare || {}).reduce((x, c) => x + (c.avg7_orders || 0), 0);
  const ev = s.etsy?.etsy?.favs_yesterday ?? null, ev2 = s.etsy?.etsy_ee?.favs_yesterday ?? null;
  const favs = ev == null && ev2 == null ? null : (ev || 0) + (ev2 || 0);
  const eb = s.ebay?.traffic_yesterday;
  // Etsy ads per shop ({etsy, etsy_ee}), each {cur, day, mtd, last7} of {etsy_ads, offsite_ads}.
  const shops = Object.values(s.ads?.etsy || {}).filter(x => x && x.day);
  const ads = shops[0] ? { cur: shops[0].cur } : null;
  const adSum = k => shops.length ? shops.reduce((t, x) => t + (x[k]?.etsy_ads || 0) + (x[k]?.offsite_ads || 0), 0) : null;
  const adDay = adSum("day"), adMtd = adSum("mtd");
  return (
    <div style={{ display: "grid", gridTemplateColumns: mob() ? "1fr 1fr" : "repeat(4,1fr)", gap: 10, marginBottom: 14 }}>
      <Metric label="Orders" value={t.orders ?? "—"} sub={`7-day avg ${Math.round(avg7 * 10) / 10}`} avail={av.etsy_sales} />
      <Metric label="Revenue (≈ INR)" value={money(t.revenue_inr_est)} sub={t.units != null ? `${t.units} pieces · AOV ${money(t.aov_inr_est)}` : null} avail={av.inr_totals || "estimated"} />
      <Metric label="Etsy new favourites" value={favs ?? "—"} sub="both shops, yesterday (Etsy no longer gives views)" avail={av.etsy_favourites} />
      <Metric label="Site visitors" value={s.site?.day?.visitors ?? "—"} sub={s.site?.avg7?.visitors != null ? `7-day avg ${s.site.avg7.visitors}` : "eartheditions.co"} avail={av.site_traffic} />
      <Metric label="eBay impressions" value={eb?.impressions ?? "—"} sub={eb ? `${eb.views} views` : null} avail={av.ebay_traffic} />
      <Metric label="Etsy ads" value={adDay == null ? "—" : money(adDay, ads.cur)} sub={adMtd != null ? `${money(adMtd, ads.cur)} this month` : null} avail={av.etsy_ads} />
      <Metric label="Meta ads" value="—" sub="not connected yet" avail={av.meta_ads || "unavailable"} />
      <Metric label="Follow-ups due" value={s.followups?.due?.length ?? 0} sub={`${s.followups?.open ?? 0} open`} avail="recorded" />
    </div>
  );
}

function ChannelTable({ s }) {
  const ch = s?.sales?.channels;
  if (!ch || !Object.keys(ch).length) return null;
  return (
    <div style={{ ...card, padding: 14, marginBottom: 14, overflowX: "auto" }}>
      <span style={lab}>By channel · {s.day}</span>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
        <thead><tr style={{ color: C.inkFaint, textAlign: "left" }}>{["Channel", "Orders", "Pieces", "Revenue", "AOV"].map(h => <th key={h} style={{ padding: "4px 6px", fontWeight: 600 }}>{h}</th>)}</tr></thead>
        <tbody>{Object.entries(ch).map(([k, v]) => (
          <tr key={k} style={{ borderTop: `1px solid ${C.border}` }}>
            <td style={{ padding: "6px" }}>{CH[k] || k}</td><td style={{ padding: 6 }}>{v.orders}</td><td style={{ padding: 6 }}>{v.units}</td>
            <td style={{ padding: 6 }}>{money(v.revenue, v.cur)}</td><td style={{ padding: 6 }}>{money(v.aov, v.cur)}</td>
          </tr>))}</tbody>
      </table>
    </div>
  );
}

function BriefingTab({ briefings, showToast }) {
  const [day, setDay] = useState(briefings.find(x => x.generated_by !== "weekly")?.id || istDay());
  const [snap, setSnap] = useState(null);
  const b = briefings.find(x => x.id === day) || null;
  useEffect(() => { let on = true; rajRow(RAJ_KEYS.snapshots, day).then(s => on && setSnap(s)).catch(e => showToast("⚠ " + e.message)); return () => { on = false; }; }, [day, showToast]);
  return (
    <div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        <select value={day} onChange={e => setDay(e.target.value)} style={FI({ width: "auto" })}>
          {!briefings.some(x => x.id === istDay()) && <option value={istDay()}>{istDay()} (today, not written yet)</option>}
          {briefings.map(x => <option key={x.id} value={x.id}>{x.generated_by === "weekly" ? `Weekly review ${x.day}` : x.id}{x.generated_by === "numbers-only" ? " · numbers only" : ""}</option>)}
        </select>
        {b && <span style={{ fontSize: 11.5, color: C.inkFaint }}>written {new Date(b.at).toLocaleString("en-IN", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" })} · {b.generated_by === "claude" ? "by Raj" : "numbers only (Mac was off)"}</span>}
      </div>
      <SnapshotCards s={snap} />
      {b ? (
        <div style={{ ...card, padding: mob() ? 16 : 24, marginBottom: 14 }}>
          {b.headline && <div style={{ fontFamily: SERIF, fontSize: 24, fontWeight: 700, marginBottom: 8 }}>{b.headline}</div>}
          <Md text={b.narrative_md} />
        </div>
      ) : (
        <div style={{ ...card, padding: 24, color: C.inkMid, fontSize: 13.5, marginBottom: 14 }}>
          Good morning, Sir. Today's briefing isn't written yet. Raj writes it at 8:00 IST from this Mac; if the Mac is off, a numbers-only briefing appears by 9:30.
        </div>
      )}
      <ChannelTable s={snap} />
      {snap?.errors && Object.keys(snap.errors).length > 0 && <div style={{ ...card, padding: 14, borderColor: C.red, fontSize: 12.5 }}><span style={lab}>Data problems</span>{Object.entries(snap.errors).map(([k, e]) => <div key={k}>⚠ {k}: {typeof e === "string" ? e : JSON.stringify(e)}</div>)}</div>}
    </div>
  );
}

/* ── Follow-ups ─────────────────────────────────────────────────────────── */
function NoteEditor({ note, onSave, onCancel }) {
  const [n, setN] = useState(note);
  const set = (k, v) => setN(x => ({ ...x, [k]: v }));
  return (
    <div style={{ ...card, padding: 14, marginBottom: 10, display: "grid", gap: 8 }}>
      <div style={{ display: "grid", gridTemplateColumns: mob() ? "1fr" : "140px 1fr 150px 160px", gap: 8 }}>
        <select value={n.kind} onChange={e => set("kind", e.target.value)} style={FI()}>{Object.entries(KIND).map(([k, [, l]]) => <option key={k} value={k}>{l}</option>)}</select>
        <input value={n.title || ""} onChange={e => set("title", e.target.value)} placeholder="Title" style={FI()} />
        <input type="date" value={n.due || ""} onChange={e => set("due", e.target.value)} style={FI()} />
        <select value={n.channel || ""} onChange={e => set("channel", e.target.value)} style={FI()}><option value="">All channels</option>{Object.entries(CH).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
      </div>
      <textarea value={n.body || ""} onChange={e => set("body", e.target.value)} placeholder="Details" rows={3} style={FI({ resize: "vertical" })} />
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button onClick={onCancel} style={btn()}>Cancel</button>
        <button onClick={() => n.title?.trim() && onSave(n)} style={btn(C.ink, "#fff")}>Save</button>
      </div>
    </div>
  );
}

function NoteRow({ n, onEdit, onPatch }) {
  const [icon, label, color] = KIND[n.kind] || ["•", n.kind, C.inkMid];
  const today = istDay();
  const overdue = n.kind === "followup" && n.status === "open" && n.due && n.due < today;
  const dueToday = n.kind === "followup" && n.status === "open" && n.due === today;
  const [open, setOpen] = useState(false);
  return (
    <div style={{ ...card, padding: "11px 14px", marginBottom: 8, opacity: n.status === "done" ? .6 : 1 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
        <span style={{ fontSize: 16 }}>{icon}</span>
        <div style={{ flex: 1, minWidth: 0, cursor: "pointer" }} onClick={() => setOpen(o => !o)}>
          <div style={{ fontSize: 13.5, fontWeight: 600, textDecoration: n.status === "done" ? "line-through" : "none" }}>{n.title}</div>
          <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 2, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <span style={{ color }}>{label}</span>
            {n.channel && <span>{CH[n.channel] || n.channel}</span>}
            {n.due && <span style={{ color: overdue ? C.red : dueToday ? C.amber : C.inkFaint, fontWeight: overdue || dueToday ? 700 : 400 }}>{overdue ? "overdue · " : dueToday ? "today · " : "due "}{n.due}</span>}
            {n.status === "snoozed" && <span>snoozed</span>}
            <span>{(n.updated_at || n.created_at || "").slice(0, 10)}</span>
          </div>
          {open && n.body && <div style={{ fontSize: 12.5, color: C.inkMid, marginTop: 6, whiteSpace: "pre-wrap" }}>{n.body}</div>}
        </div>
        <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
          {n.kind === "followup" && n.status !== "done" && <>
            <button title="Snooze 3 days" onClick={() => onPatch(n, { status: "snoozed", due: istDay(Date.now() + 3 * 864e5) })} style={btn()}>💤</button>
            <button title="Done" onClick={() => onPatch(n, { status: "done", done_at: new Date().toISOString() })} style={btn(C.greenBg, C.green)}>✓</button>
          </>}
          {n.kind === "followup" && n.status === "done" && <button title="Reopen" onClick={() => onPatch(n, { status: "open" })} style={btn()}>↺</button>}
          <button title="Edit" onClick={() => onEdit(n)} style={btn()}>✎</button>
        </div>
      </div>
    </div>
  );
}

function NotesTab({ notes, setNotes, showToast, mode }) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState(mode === "followups" ? "followup" : "");
  const [showDone, setShowDone] = useState(false);
  const [editing, setEditing] = useState(null);
  const save = async n => {
    try { const item = await saveNote(n); setNotes(ns => [item, ...ns.filter(x => x.id !== item.id)]); setEditing(null); showToast("Saved"); }
    catch (e) { showToast("⚠ " + e.message); }
  };
  const patch = (n, p) => save({ ...n, ...p });
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    let l = notes.filter(n => (mode === "followups" ? n.kind === "followup" : n.kind !== "followup" || kind === "followup"));
    if (kind) l = l.filter(n => n.kind === kind);
    if (mode === "followups" && !showDone) l = l.filter(n => n.status !== "done");
    if (s) l = l.filter(n => `${n.title} ${n.body} ${n.channel}`.toLowerCase().includes(s));
    const due = n => n.due || "9999";
    return mode === "followups" ? [...l].sort((a, b) => (a.status === "done") - (b.status === "done") || due(a).localeCompare(due(b)))
      : [...l].sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
  }, [notes, q, kind, showDone, mode]);
  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder={mode === "followups" ? "Search follow-ups" : "Search Raj's memory"} style={FI({ flex: 1, minWidth: 180, width: "auto" })} />
        {mode !== "followups" && <select value={kind} onChange={e => setKind(e.target.value)} style={FI({ width: "auto" })}><option value="">All kinds</option>{Object.entries(KIND).map(([k, [, l]]) => <option key={k} value={k}>{l}</option>)}</select>}
        {mode === "followups" && <label style={{ fontSize: 12.5, display: "flex", gap: 5, alignItems: "center", color: C.inkMid }}><input type="checkbox" checked={showDone} onChange={e => setShowDone(e.target.checked)} />Show done</label>}
        <button onClick={() => setEditing({ kind: mode === "followups" ? "followup" : "knowledge", status: mode === "followups" ? "open" : "noted", title: "", body: "" })} style={btn(C.ink, "#fff")}>+ Add</button>
      </div>
      {editing && <NoteEditor note={editing} onSave={save} onCancel={() => setEditing(null)} />}
      {list.length === 0 && <div style={{ color: C.inkFaint, fontSize: 13, padding: 20, textAlign: "center" }}>Nothing here yet, Sir.</div>}
      {list.map(n => <NoteRow key={n.id} n={n} onEdit={setEditing} onPatch={patch} />)}
    </div>
  );
}

/* ── Ask Raj (OpenAI via /api/claude; the Pro plan can't be called from a web page) ── */
const PERSONA = `You are Raj, chief of operations for Nikhil Gems (Mumbai gemstone and mineral business). Channels: Atyahara Etsy (etsy), EarthEditions Etsy (etsy_ee), eBay, eartheditions.co (store), Atyahara Shopify, Earth Editions Shopify, trade/wholesale. You address the owner as "Sir". Be concise, professional, specific. Use only the numbers in the context; if something isn't there, say it's unavailable. Never invent figures.`;

function AskTab({ briefings, notes }) {
  const [msgs, setMsgs] = useState([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef(null);
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs]);
  const send = async () => {
    const q = text.trim(); if (!q || busy) return;
    setText(""); setBusy(true);
    const next = [...msgs, { role: "user", content: q }];
    setMsgs(next);
    try {
      const b = briefings[0];
      const snap = b ? await rajRow(RAJ_KEYS.snapshots, b.id) : null;
      const { etsy_views, ...lean } = snap || {};
      const words = q.toLowerCase().split(/\W+/).filter(w => w.length > 3);
      const scored = notes.map(n => [words.reduce((s, w) => s + (`${n.title} ${n.body}`.toLowerCase().includes(w) ? 1 : 0), 0), n]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]).slice(0, 15).map(([, n]) => n);
      const open = notes.filter(n => n.kind === "followup" && n.status !== "done").slice(0, 30);
      const ctx = [
        `Today (IST): ${istDay()}`,
        b ? `Latest briefing (${b.id}):\n${b.narrative_md}` : "No briefing yet.",
        snap ? `Snapshot JSON:\n${JSON.stringify(lean).slice(0, 14000)}` : "",
        `Open follow-ups:\n${open.map(n => `- [${n.due || "no date"}] ${n.title}: ${n.body || ""}`).join("\n") || "none"}`,
        scored.length ? `Relevant notes:\n${scored.map(n => `- (${n.kind}) ${n.title}: ${n.body || ""}`).join("\n")}` : "",
      ].filter(Boolean).join("\n\n");
      const res = await fetchWithRetry("/api/claude", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ max_tokens: 900, messages: [{ role: "system", content: `${PERSONA}\n\n${ctx}` }, ...next.slice(-10)] }) }, { tries: 2, timeoutMs: 90000 });
      const d = await res.json();
      if (d.error) throw new Error(d.error?.message || d.error);
      setMsgs(m => [...m, { role: "assistant", content: (d.content || []).map(x => x.text || "").join("").trim() || "…" }]);
    } catch (e) { setMsgs(m => [...m, { role: "assistant", content: `⚠ ${e.message}` }]); }
    setBusy(false);
  };
  return (
    <div style={{ ...card, padding: 14, display: "flex", flexDirection: "column", minHeight: 420 }}>
      <div style={{ flex: 1, overflowY: "auto", maxHeight: "60vh" }}>
        {msgs.length === 0 && <div style={{ color: C.inkFaint, fontSize: 13, padding: 12 }}>Ask about yesterday's sales, a follow-up, or something we solved before. Quick answers here run on the OpenAI key; the full morning briefing and memory run on your Claude plan.</div>}
        {msgs.map((m, i) => (
          <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start", margin: "8px 0" }}>
            <div style={{ maxWidth: "85%", background: m.role === "user" ? C.ink : C.card, color: m.role === "user" ? "#fff" : C.ink, borderRadius: 10, padding: "8px 12px" }}>
              {m.role === "user" ? <span style={{ fontSize: 13.5 }}>{m.content}</span> : <Md text={m.content} size={13} />}
            </div>
          </div>
        ))}
        {busy && <div style={{ fontSize: 12, color: C.inkFaint, padding: 6 }}>Raj is thinking…</div>}
        <div ref={end} />
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <input value={text} onChange={e => setText(e.target.value)} onKeyDown={e => e.key === "Enter" && send()} placeholder="Ask Raj…" style={FI({ flex: 1, width: "auto" })} />
        <button onClick={send} disabled={busy} style={btn(C.ink, "#fff")}>Send</button>
      </div>
    </div>
  );
}


/* ── Audit: every listing checked each morning, and fixes Raj drafted ───── */
const SEV = { high: [C.red, C.redBg, "Urgent"], medium: [C.amber, C.amberBg, "Important"], low: [C.inkFaint, C.card, "Minor"] };
const CHN = { ...CH, all: "All channels" };

/* What an approved fix changes on the ERP listing, so the next save from
   Listing Manager doesn't put the old value back on Etsy. */
function erpPatch(p) {
  const ee = p.channel === "etsy_ee";
  if (p.field === "tags") return { tags: p.proposed };
  if (p.field === "title") return { etsy_title: p.proposed };
  if (p.field === "taxonomy_id") return { etsy_taxonomy_id: p.proposed };
  if (p.field === "shop_section_id") return ee ? {} : { etsy_section_id: p.proposed };
  if (p.field === "should_auto_renew") return { etsy_auto_renew: p.proposed };
  return {};   // materials: the ERP keeps one material, read off the stone
}

function Proposal({ p, onDecide, applyRef, compact = false }) {
  const [busy, setBusy] = useState(false);
  const list = Array.isArray(p.proposed);
  const cur = list ? (p.current || []) : [p.current];
  const next = list ? (p.proposed || []) : [p.proposed];
  const chip = (t, kind) => <span key={kind + t} style={{ fontSize: 11.5, padding: "2px 7px", borderRadius: 10, margin: "0 4px 4px 0", display: "inline-block",
    background: kind === "add" ? C.greenBg : kind === "drop" ? C.redBg : C.card, color: kind === "add" ? C.green : kind === "drop" ? C.red : C.inkMid,
    textDecoration: kind === "drop" ? "line-through" : "none" }}>{t}</span>;
  // The ERP listing first (it feeds EarthEditions, eBay and the store), then the Etsy
  // listing itself, which a shop on hold (vacation mode) refuses.
  const apply = async () => {
    if (busy) return;
    setBusy(true);
    let erp = false;
    try {
      if (p.erp_id && Object.keys(erpPatch(p)).length) {
        const { data, error } = await supabase.from("app_rows").select("data").eq("key", "ng-listings-v1").eq("id", p.erp_id).eq("deleted", false).maybeSingle();
        if (error) throw new Error(error.message);
        if (data?.data) {
          const item = { ...data.data, ...erpPatch(p), updated_at: new Date().toISOString() };
          const { error: e2 } = await supabase.rpc("app_rows_upsert", { p_key: "ng-listings-v1", p_item: item, p_prepend: false });
          if (e2) throw new Error(e2.message);
          erp = true;
        }
      }
      const r = await fetch(`/api/etsy?action=update_listing&listing_id=${p.listing_id}${p.channel === "etsy_ee" ? "&shop=earth" : ""}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ [p.field]: p.proposed }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = d.etsyError || d.error || `Etsy said ${r.status}`;
        if (erp) await onDecide(p, "applied_erp", /vacation/i.test(msg) ? "Etsy shop is on hold; fixed in the ERP listing" : msg);
        else throw new Error(msg);
      } else await onDecide(p, "applied");
    } catch (e) { await onDecide(p, "failed", e.message); }
    setBusy(false);
  };
  if (applyRef) applyRef.current[p.id] = apply;
  const changes = (
      <div style={{ marginTop: compact ? 4 : 8 }}>
        {list ? <>
          {cur.filter(t => !next.includes(t)).map(t => chip(t, "drop"))}
          {next.map(t => chip(t, cur.includes(t) ? "keep" : "add"))}
        </> : <div style={{ fontSize: 12.5 }}><div style={{ color: C.red, textDecoration: "line-through" }}>{String(p.current)}</div><div style={{ color: C.green }}>{p.proposed_label || String(p.proposed)}</div></div>}
      </div>);
  /* In the problem's own list: the fix sits under its piece, with the three
     answers Sir gives one piece at a time. */
  if (compact) return (
    <div style={{ marginTop: 4 }}>
      {changes}
      <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
        <button disabled={busy} onClick={apply} style={btn(C.ink, "#fff")}>{busy ? "Applying…" : "Approve"}</button>
        <button disabled={busy} onClick={() => onDecide(p, "rejected")} style={btn()}>Deny</button>
        <button disabled={busy} onClick={() => onDecide(p, "skipped")} style={btn()}>Skip</button>
      </div>
    </div>);
  return (
    <div style={{ ...card, padding: 14, marginBottom: 10 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <a href={`https://www.etsy.com/listing/${p.listing_id}`} target="_blank" rel="noreferrer" style={{ fontSize: 13.5, fontWeight: 600, color: C.ink }}>{p.title}</a>
          <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 2 }}>{CH[p.channel] || p.channel} · new {p.field}{p.erp_id ? " · ERP listing too" : ""} · {p.reason}</div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button disabled={busy} onClick={() => onDecide(p, "rejected")} style={btn()}>Reject</button>
          <button disabled={busy} onClick={apply} style={btn(C.ink, "#fff")}>{busy ? "Applying…" : "Approve & apply"}</button>
        </div>
      </div>
      <div style={{ marginTop: 8 }}>
        {list ? <>
          {cur.filter(t => !next.includes(t)).map(t => chip(t, "drop"))}
          {next.map(t => chip(t, cur.includes(t) ? "keep" : "add"))}
        </> : <div style={{ fontSize: 12.5 }}><div style={{ color: C.red, textDecoration: "line-through" }}>{String(p.current)}</div><div style={{ color: C.green }}>{p.proposed_label || String(p.proposed)}</div></div>}
      </div>
    </div>
  );
}

/* Where Sir fixes a listing by hand, for checks no field change can fix. */
const editUrl = (c, i) => /^etsy/.test(c.channel) && /^\d+$/.test(String(i.id)) ? `https://www.etsy.com/your/shops/me/listing-editor/edit/${i.id}`
  : c.channel === "ebay" && /^\d+$/.test(String(i.id)) ? `https://www.ebay.com/sl/list?mode=ReviseItem&itemId=${i.id}`
  : i.url || "";

function CheckRow({ c, props, onDrafted, onDecide, onSkip, applyRef, showToast }) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState("");
  const field = DRAFTABLE[c.check];
  /* The latest answer for each piece: a fix waiting, applied, denied or skipped.
     Denied and skipped pieces stay out of "Draft fixes for all"; each can be
     drafted again on its own. */
  const latest = new Map();
  for (const p of (props || []).filter(p => p.check === c.check && p.channel === c.channel))
    if (!latest.has(String(p.listing_id)) || String(p.created_at || p.decided_at || "") >= String(latest.get(String(p.listing_id)).created_at || latest.get(String(p.listing_id)).decided_at || "")) latest.set(String(p.listing_id), p);
  const todo = (c.items || []).filter(i => !latest.has(String(i.id)) || latest.get(String(i.id)).status === "failed");
  // Draft: ten at a time for the AI checks, the rest in one go; each lands as a proposal to approve.
  const draft = async (list = todo) => {
    const todo = list;
    const size = AI_CHECKS.has(c.check) ? 10 : 500;
    let made = 0, skipped = 0;
    try {
      for (let k = 0; k < todo.length; k += size) {
        setBusy(`Drafting ${Math.min(k + size, todo.length)}/${todo.length}…`);
        const r = await fetch("/api/listing-manager", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "raj_draft", check: c.check, channel: c.channel,
            items: todo.slice(k, k + size).map(i => ({ id: i.id, title: i.title, tags: i.tags, materials: i.materials, detail: i.detail, erp_id: i.erp_id })) }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `Draft failed (${r.status})`);
        await onDrafted(d.proposals || []);
        made += (d.proposals || []).length; skipped += (d.skipped || []).length;
      }
      showToast(made ? `${made} fix${made === 1 ? "" : "es"} drafted, each under its piece below${skipped ? ` · ${skipped} left as they are` : ""}` : "The AI found nothing to change there");
    } catch (e) { showToast(`⚠ ${e.message}${made ? ` (${made} drafted before it stopped)` : ""}`); }
    setBusy("");
  };
  // No field fixes it (photos, a sale to chase): it becomes a follow-up with the pieces listed.
  const followup = async () => {
    setBusy("Saving…");
    try {
      const due = new Date(Date.now() + 7 * 864e5 + IST).toISOString().slice(0, 10);
      await saveNote({ kind: "followup", status: "open", due, title: `${c.title} · ${CHN[c.channel] || c.channel} (${c.count})`,
        body: `${c.fix}\n\n${(c.items || []).slice(0, 60).map(i => `- ${i.title || i.id}${i.detail ? ` (${i.detail})` : ""}`).join("\n")}${c.count > 60 ? `\n- …and ${c.count - 60} more on the Audit tab` : ""}` });
      showToast("Added to Follow-ups, due in a week");
    } catch (e) { showToast("⚠ " + e.message); }
    setBusy("");
  };
  const [fg, bg, label] = SEV[c.severity] || SEV.low;
  const items = all ? c.items : (c.items || []).slice(0, 40);
  const trend = (c.history || []).slice(-8).map(h => h.count);
  return (
    <div style={{ ...card, marginBottom: 8, overflow: "hidden" }}>
      <div onClick={() => setOpen(o => !o)} style={{ padding: "11px 14px", cursor: "pointer", display: "flex", gap: 10, alignItems: "center" }}>
        <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", background: bg, color: fg, borderRadius: 4, padding: "2px 6px", flexShrink: 0 }}>{label}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600 }}>{c.title}</div>
          <div style={{ fontSize: 11, color: C.inkFaint }}>{CHN[c.channel] || c.channel}{c.new_today ? ` · ${c.new_today} new` : ""}{c.resolved_today ? ` · ${c.resolved_today} fixed` : ""}{trend.length > 1 ? ` · trend ${trend.join(" → ")}` : ""}</div>
        </div>
        <span style={{ fontSize: 18, fontWeight: 700, fontFamily: SERIF }}>{c.count}</span>
        <span style={{ color: C.inkFaint }}>{open ? "▾" : "▸"}</span>
      </div>
      {open && (
        <div style={{ borderTop: `1px solid ${C.border}`, padding: "10px 14px" }}>
          <div style={{ fontSize: 12.5, color: C.inkMid, marginBottom: 8 }}><b>Why it matters:</b> {c.why} <b>Fix:</b> {c.fix}</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
            {field ? <>
              <button disabled={!!busy || !todo.length} onClick={() => draft()} style={btn(C.ink, "#fff")}>
                {busy || (todo.length ? `Draft fixes for ${todo.length}` : "All drafted")}</button>
              <span style={{ fontSize: 11.5, color: C.inkFaint }}>
                {AI_CHECKS.has(c.check) ? `AI writes new ${field === "tags" ? "tags" : "titles"}, about one call per 10 listings. ` : ""}
                Each fix appears under its piece: Approve, Deny or Skip. Nothing changes until you approve.</span>
            </> : <>
              <button disabled={!!busy} onClick={followup} style={btn(C.ink, "#fff")}>{busy || "Add to Follow-ups"}</button>
              <span style={{ fontSize: 11.5, color: C.inkFaint }}>This needs hands, not a field change: it goes on your follow-ups with the pieces listed. Each piece below has its edit link.</span>
            </>}
          </div>
          {items.map(i => (
            <div key={i.id} style={{ fontSize: 12.5, padding: "5px 0", borderTop: `1px solid ${C.border}`, display: "flex", gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                {i.url ? <a href={i.url} target="_blank" rel="noreferrer" style={{ color: C.ink }}>{i.title || i.id}</a> : <span>{i.title || i.id}</span>}
                {i.detail && <div style={{ fontSize: 11.5, color: C.inkMid }}>{i.detail}</div>}
                {field && (() => {
                  const p = latest.get(String(i.id));
                  const small = { ...btn(), padding: "3px 9px", fontSize: 11.5 };
                  const one = () => draft([i]);
                  if (p?.status === "pending") return <Proposal p={p} onDecide={onDecide} applyRef={applyRef} compact />;
                  if (p?.status === "applied" || p?.status === "applied_erp") return <div style={{ fontSize: 11.5, color: C.green, marginTop: 3 }}>✓ Fixed{p.status === "applied_erp" ? " in the ERP listing" : ""}</div>;
                  const said = p?.status === "rejected" ? "Denied" : p?.status === "skipped" ? "Skipped" : p?.status === "failed" ? `Not applied: ${p.error || "error"}` : "";
                  return <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 4, flexWrap: "wrap" }}>
                    {said && <span style={{ fontSize: 11.5, color: p.status === "failed" ? C.red : C.inkFaint }}>{said}</span>}
                    <button disabled={!!busy} onClick={one} style={small}>{p ? "Draft again" : "Draft fix"}</button>
                    {!p && <button disabled={!!busy} onClick={() => onSkip(c, i)} style={small}>Skip</button>}
                  </div>;
                })()}
              </div>
              {!field && editUrl(c, i) && <a href={editUrl(c, i)} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: C.blue, flexShrink: 0 }}>Edit ↗</a>}
              <span style={{ fontSize: 10.5, color: C.inkFaint, flexShrink: 0 }}>since {i.since}</span>
            </div>
          ))}
          {!all && (c.items || []).length > 40 && <button onClick={() => setAll(true)} style={{ ...btn(), marginTop: 8 }}>Show all {c.items.length}</button>}
        </div>
      )}
    </div>
  );
}

function AuditTab({ showToast }) {
  const [rows, setRows] = useState(null);
  const [props, setProps] = useState([]);
  const [kind, setKind] = useState("problem");
  useEffect(() => {
    Promise.all([rajRows(RAJ_KEYS.audit), rajRows(RAJ_KEYS.proposals)])
      .then(([a, p]) => { setRows(a); setProps(p); }).catch(e => { setRows([]); showToast("⚠ " + e.message); });
  }, [showToast]);
  const decide = async (p, status, error) => {
    const item = { ...p, status, decided_at: new Date().toISOString(), ...(error ? { error } : {}) };
    const { error: e } = await supabase.rpc("app_rows_upsert", { p_key: RAJ_KEYS.proposals, p_item: item, p_prepend: false });
    if (e) return showToast("⚠ " + e.message);
    setProps(ps => ps.map(x => x.id === p.id ? item : x));
    showToast(status === "applied" ? "Applied in the ERP and on Etsy" : status === "applied_erp" ? `Fixed in the ERP listing (${error})` : status === "failed" ? `⚠ Not applied: ${error}` : status === "skipped" ? "Skipped: left as it is" : "Denied: nothing changed");
  };
  // Skip a piece before anything was drafted for it: no AI call, and it stays out of "Draft fixes for all".
  const skip = async (c, i) => {
    const now = new Date().toISOString();
    const item = { id: `skip-${c.check}-${c.channel}-${i.id}`, check: c.check, channel: c.channel, listing_id: String(i.id), title: i.title || "", status: "skipped", created_at: now, decided_at: now };
    const { error: e } = await supabase.rpc("app_rows_upsert", { p_key: RAJ_KEYS.proposals, p_item: item, p_prepend: false });
    if (e) return showToast("⚠ " + e.message);
    setProps(ps => [...ps.filter(x => x.id !== item.id), item]);
    showToast("Skipped: left as it is");
  };
  const drafted = async list => {
    const now = new Date().toISOString();
    const items = list.map(p => ({ ...p, status: "pending", created_at: now }));
    for (const item of items) {
      const { error: e } = await supabase.rpc("app_rows_upsert", { p_key: RAJ_KEYS.proposals, p_item: item, p_prepend: false });
      if (e) throw new Error(e.message);
    }
    setProps(ps => [...ps.filter(x => !items.some(i => i.id === x.id)), ...items]);
  };
  const applyRef = useRef({});
  const [allBusy, setAllBusy] = useState("");
  const approveAll = async list => {
    for (let k = 0; k < list.length; k++) {
      setAllBusy(`Applying ${k + 1}/${list.length}…`);
      await applyRef.current[list[k].id]?.();
    }
    setAllBusy("");
  };
  if (!rows) return <div style={{ color: C.inkFaint, padding: 30 }}>Loading…</div>;
  const sum = rows.find(r => r.id === "summary");
  if (!sum) return <div style={{ ...card, padding: 24, color: C.inkMid }}>The first audit runs at 7:30 IST.</div>;
  const order = { high: 0, medium: 1, low: 2 };
  const checks = rows.filter(r => r.id !== "summary" && r.kind === kind && r.count > 0)
    .sort((a, b) => (b.check === "etsy_shop_on_hold") - (a.check === "etsy_shop_on_hold") || order[a.severity] - order[b.severity] || b.count - a.count);
  const pending = props.filter(p => p.status === "pending");
  // Fixes whose piece is listed under a problem below are answered there; the rest stay here.
  const listed = new Set(rows.filter(r => r.id !== "summary").flatMap(r => (r.items || []).map(i => `${r.check}|${r.channel}|${i.id}`)));
  const loose = pending.filter(p => !listed.has(`${p.check}|${p.channel}|${p.listing_id}`));
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: mob() ? "1fr 1fr" : "repeat(5,1fr)", gap: 10, marginBottom: 14 }}>
        <Metric label="Urgent problems" value={sum.totals?.problems_high ?? "—"} />
        <Metric label="All problems" value={sum.totals?.problems ?? "—"} />
        <Metric label="Sales leads" value={sum.totals?.opportunities ?? "—"} />
        <Metric label="New today" value={sum.new_today ?? 0} />
        <Metric label="Fixed since yesterday" value={sum.resolved_today ?? 0} sub={`audit ${sum.day}`} />
      </div>
      {sum.errors && Object.keys(sum.errors).length > 0 && <div style={{ ...card, padding: 12, fontSize: 12.5, marginBottom: 12, color: C.red }}>⚠ Not checked today: {Object.entries(sum.errors).map(([k, v]) => `${k} (${v})`).join("; ")}</div>}
      {pending.length > 0 && <>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6, marginBottom: 6 }}>
          <div style={{ ...lab, margin: 0, flex: 1 }}>Fixes Raj drafted · {pending.length} waiting for you</div>
          <button disabled={!!allBusy} onClick={() => confirm(`Apply all ${pending.length} drafted fixes?`) && approveAll(pending)} style={btn(C.ink, "#fff")}>{allBusy || `Approve all ${pending.length}`}</button>
        </div>
        {loose.map(p => <Proposal key={p.id} p={p} onDecide={decide} applyRef={applyRef} />)}
        {loose.length < pending.length && <div style={{ fontSize: 11.5, color: C.inkFaint, marginBottom: 8 }}>{pending.length - loose.length} more {pending.length - loose.length === 1 ? "sits" : "sit"} under {pending.length - loose.length === 1 ? "its piece" : "their pieces"} in the problems below.</div>}
      </>}
      <div style={{ display: "flex", gap: 8, margin: "14px 0 10px" }}>
        {[["problem", "Problems"], ["opportunity", "Sales leads"]].map(([k, l]) => (
          <button key={k} onClick={() => setKind(k)} style={btn(kind === k ? C.ink : C.surface, kind === k ? "#fff" : C.ink)}>{l}</button>
        ))}
      </div>
      {checks.map(c => <CheckRow key={c.id} c={c} props={props} onDrafted={drafted} onDecide={decide} onSkip={skip} applyRef={applyRef} showToast={showToast} />)}
    </div>
  );
}

/* ── the app ────────────────────────────────────────────────────────────── */
export default function RajApp({ onHome }) {
  const [tab, setTab] = useState("briefing");
  const [toast, setToast] = useState("");
  const showToast = useCallback(m => { setToast(m); setTimeout(() => setToast(""), 3800); }, []);
  const [briefings, setBriefings] = useState(null);
  const [notes, setNotes] = useState([]);
  useEffect(() => {
    Promise.all([rajRows(RAJ_KEYS.briefings, { limit: 120 }), rajRows(RAJ_KEYS.notes)])
      .then(([b, n]) => { setBriefings([...b].sort((x, y) => (y.at || y.id).localeCompare(x.at || x.id))); setNotes(n); })
      .catch(e => { setBriefings([]); showToast("⚠ " + e.message); });
  }, [showToast]);
  const openCount = notes.filter(n => n.kind === "followup" && n.status !== "done" && (!n.due || n.due <= istDay())).length;
  const TABS = [["briefing", "☀️", "Briefing"], ["audit", "🔎", "Audit"], ["followups", "📌", `Follow-ups${openCount ? ` (${openCount})` : ""}`], ["memory", "📚", "Memory"], ["ask", "💬", "Ask Raj"]];
  return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: FONT, color: C.ink }}>
      {toast && <div style={{ position: "fixed", bottom: 22, right: 22, left: mob() ? 22 : "auto", zIndex: 1200, background: C.ink, color: "#fff", padding: "10px 18px", borderRadius: 6, fontSize: 12.5 }}>{toast}</div>}
      <div style={{ position: "sticky", top: 0, zIndex: 100, background: C.surface, borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: mob() ? "10px 14px" : "11px 28px" }}>
          <button onClick={onHome} style={{ background: "none", border: "none", cursor: "pointer", color: C.inkMid, fontFamily: "inherit", fontSize: 13, padding: "0 12px 0 0", borderRight: `1px solid ${C.border}` }}>← Home</button>
          <div>
            <div style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 700, lineHeight: 1 }}>Raj</div>
            <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 1 }}>Chief of operations · briefing, follow-ups, memory</div>
          </div>
        </div>
        <div style={{ display: "flex", overflowX: "auto", padding: mob() ? "0 10px" : "0 28px" }}>
          {TABS.map(([k, icon, label]) => (
            <button key={k} onClick={() => setTab(k)} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: -1, border: "none", background: "none", cursor: "pointer", fontFamily: "inherit", padding: "11px 14px", fontSize: 13, whiteSpace: "nowrap", fontWeight: tab === k ? 700 : 500, color: tab === k ? C.ink : C.inkMid, borderBottom: `2px solid ${tab === k ? C.gold : "transparent"}` }}>
              <span style={{ fontSize: 14 }}>{icon}</span>{label}
            </button>
          ))}
        </div>
      </div>
      <div style={{ maxWidth: 1000, margin: "0 auto", padding: mob() ? "14px 12px 60px" : "22px 28px 60px" }}>
        {briefings === null ? <div style={{ color: C.inkFaint, padding: 30 }}>Loading…</div>
          : tab === "briefing" ? <BriefingTab briefings={briefings} showToast={showToast} />
          : tab === "audit" ? <AuditTab showToast={showToast} />
          : tab === "followups" ? <NotesTab mode="followups" notes={notes} setNotes={setNotes} showToast={showToast} />
          : tab === "memory" ? <NotesTab mode="memory" notes={notes} setNotes={setNotes} showToast={showToast} />
          : <AskTab briefings={briefings} notes={notes} />}
      </div>
    </div>
  );
}
