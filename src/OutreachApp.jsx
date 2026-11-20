/* Outreach — wholesale cold outreach for Nikhil Gems / Earth Editions Trade (bulk by the kilo).

   Leads are researched on Manav's Mac (scripts/outreach/: Etsy Open API, shop websites, web
   search) and pushed to app_rows outreach-leads-v1 with a personal draft for each shop.
   Sejal either opens a draft in Gmail / Instagram and marks it here, or ticks several and
   presses Send: those go one at a time, a little apart, from the ERP's Gmail (through the
   Gmail bridge, lib/outreach.js), and each shop is first checked against everyone we already
   know (customers, trade buyers, Omnisend, past Gmail). Follow-ups come due 4 and 10 days
   later, then stop, and are skipped automatically if the shop replied or the email bounced. */
import { useState, useEffect, useMemo, useRef } from "react";
import { supabase } from "./supabase.js";
import { C, mob, FI } from "./lmTheme.js";
import PLAYBOOK from "./outreach/playbook.md?raw";
import { Md, istDay } from "./RajApp.jsx";

const KEY = "outreach-leads-v1";
const FONT = "-apple-system,'SF Pro Display','Figtree',system-ui,sans-serif";
const SERIF = "'Cormorant Garamond',Georgia,serif";
const ACCENT = "#7A4E2D";
const card = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px 16px", minWidth: 0 };
const btn = (bg = C.surface, fg = C.ink) => ({ background: bg, color: fg, border: bg === C.surface ? `1px solid ${C.border}` : "none", borderRadius: 7, padding: "6px 11px", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" });
const lab = { fontSize: 9.5, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .6, marginBottom: 4, display: "block" };
const sub = { fontSize: 11.5, color: C.inkFaint };
const Tag = ({ c = C.inkMid, bg = C.card, children }) => <span style={{ fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: .4, background: bg, color: c, borderRadius: 4, padding: "2px 6px", whiteSpace: "nowrap" }}>{children}</span>;
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const FLAG = { US: "🇺🇸", GB: "🇬🇧", AU: "🇦🇺", NZ: "🇳🇿", JP: "🇯🇵", TW: "🇹🇼", DE: "🇩🇪", NL: "🇳🇱", FR: "🇫🇷", IT: "🇮🇹", ES: "🇪🇸", IE: "🇮🇪", CA: "🇨🇦", BE: "🇧🇪", AT: "🇦🇹", CH: "🇨🇭", SE: "🇸🇪", DK: "🇩🇰" };
const SEG = { etsy_reseller: "Etsy shop", online_shop: "Online shop", physical_shop: "Shop (walk-in)", live_seller: "Live seller" };
const STAGE = { new: ["Not contacted", C.inkMid, C.card], sent: ["Sent", C.blue, C.blueBg], followed_up: ["Followed up", C.blue, C.blueBg], replied: ["Replied", C.green, C.greenBg],
  talking: ["In talks", C.green, C.greenBg], sample: ["Sample / trial", ACCENT, "#F3E9DF"], customer: ["Customer", "#fff", C.green], no: ["Not interested", C.inkFaint, C.card], bounced: ["Bounced", C.red, C.redBg], skip: ["Skipped", C.inkFaint, C.card],
  ours: ["Already our customer", C.green, C.greenBg] };
const OPEN = ["sent", "followed_up"];
// Safe daily limits for an ordinary mailbox and a young Instagram account. The server enforces
// the email ones too (lib/outreach.js): 20 new shops, 60 emails in all with follow-ups.
const CAP = { email: 20, instagram: 12 };
const NO_COLD_EMAIL = ["DE", "AT"];
const isDue = (l, today) => ["sent", "followed_up"].includes(l.stage) && l.next_followup && l.next_followup <= today && (l.followups || [])[l.followups_sent || 0];
// Can the Send button send this lead's email right now?
const canEmail = (l, today) => !!l.email && !NO_COLD_EMAIL.includes(l.country) && (l.stage === "new" || (isDue(l, today) && l.sent_via === "email"));
const pause = ms => new Promise(r => setTimeout(r, ms));

async function load() {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("app_rows").select("data").eq("key", KEY).eq("deleted", false).order("pos", { ascending: true }).range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data || []).map(r => r.data));
    if (!data || data.length < 1000) break;
  }
  return out;
}
async function put(item) {
  const { error } = await supabase.rpc("app_rows_upsert", { p_key: KEY, p_item: { ...item, updated_at: new Date().toISOString() }, p_prepend: false });
  if (error) throw new Error(error.message);
}
const gmail = (to, su, body) => `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to || "")}&su=${encodeURIComponent(su || "")}&body=${encodeURIComponent(body || "")}`;
const igUrl = h => `https://www.instagram.com/${String(h || "").replace(/^@/, "")}/`;
const copy = async (t, toast) => { try { await navigator.clipboard.writeText(t); toast("Copied"); } catch { toast("Couldn't copy"); } };
const sentToday = (leads, via, today, re = /^(sent|followup)/) => leads.filter(l => (l.history || []).some(h => h.day === today && h.via === via && re.test(h.what))).length;

function Lead({ l, onSave, toast, today, open: open0 = false, picked, onPick }) {
  const [open, setOpen] = useState(open0);
  const [note, setNote] = useState(null);
  const [st] = [STAGE[l.stage] || STAGE.new];
  const fu = (l.followups || [])[l.followups_sent || 0];
  const due = OPEN.includes(l.stage) && l.next_followup && l.next_followup <= today && fu;
  const log = (what, via) => [...(l.history || []), { day: today, what, via }];
  const mark = (stage, extra = {}, what = stage, via = "") => onSave({ ...l, stage, ...extra, history: log(what, via) });
  const markSent = via => mark("sent", { sent_at: today, sent_via: via, next_followup: addDays(today, 4), followups_sent: 0 }, "sent", via);
  const markFollowup = () => { const n = (l.followups_sent || 0) + 1; const more = (l.followups || []).length > n;
    mark("followed_up", { followups_sent: n, next_followup: more ? addDays(today, 6) : null }, `followup ${n}`, l.sent_via || ""); };
  const email = l.email, ig = l.instagram;
  const fuSubject = l.draft?.subject ? `Re: ${l.draft.subject}` : "";
  return <div style={{ ...card, borderColor: due ? C.gold : C.border }}>
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
      {onPick && <input type="checkbox" checked={!!picked} onChange={() => onPick(l.id)} aria-label={`Select ${l.name}`} style={{ width: 17, height: 17, marginTop: 2, accentColor: ACCENT, cursor: "pointer", flexShrink: 0 }} />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 4 }}>
          <span style={{ fontSize: 15 }}>{FLAG[l.country] || l.country}</span>
          <span style={{ fontWeight: 700, fontSize: 14.5 }}>{l.name}</span>
          <Tag c={l.tier === "A" ? "#fff" : C.inkMid} bg={l.tier === "A" ? ACCENT : C.card}>Tier {l.tier}</Tag>
          <Tag>{SEG[l.segment] || l.segment}</Tag>
          <Tag c={st[1]} bg={st[2]}>{st[0]}</Tag>
          {due && <Tag c="#fff" bg={C.gold}>Follow-up {(l.followups_sent || 0) + 1} due</Tag>}
          {l.language && l.language !== "en" && <Tag c={C.purple} bg={C.purpleBg}>{l.language === "ja" ? "日本語" : l.language}</Tag>}
        </div>
        <div style={{ fontSize: 12.5, color: C.inkMid, lineHeight: 1.45 }}>{l.why}</div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 6, fontSize: 12 }}>
          {l.website && <a href={/^https?:/.test(l.website) ? l.website : `https://${l.website}`} target="_blank" rel="noreferrer" style={{ color: ACCENT }}>Website</a>}
          {ig && <a href={igUrl(ig)} target="_blank" rel="noreferrer" style={{ color: ACCENT }}>@{String(ig).replace(/^@/, "")}</a>}
          {l.etsy_url && <a href={l.etsy_url} target="_blank" rel="noreferrer" style={{ color: ACCENT }}>Etsy{l.sold ? ` · ${l.sold.toLocaleString()} sales` : ""}</a>}
          {email && <span style={{ color: C.inkMid }}>{email}</span>}
          {l.city && <span style={sub}>{l.city}</span>}
          {(l.signals || []).length > 0 && <span style={sub}>stocks: {l.signals.join(", ")}</span>}
        </div>
        {l.note && <div style={{ marginTop: 6, fontSize: 12, background: C.amberBg, borderRadius: 6, padding: "3px 8px", display: "inline-block" }}>Note: {l.note}</div>}
      </div>
      <button onClick={() => setOpen(o => !o)} style={btn()}>{open ? "Close" : "Open"}</button>
    </div>
    {open && <div style={{ marginTop: 12, borderTop: `1px solid ${C.border}`, paddingTop: 12, display: "grid", gap: 12 }}>
      {due && <div style={{ background: "#FBF4E4", borderRadius: 8, padding: 10 }}>
        <span style={lab}>Follow-up {(l.followups_sent || 0) + 1} · reply in the same {l.sent_via === "instagram" ? "Instagram chat" : "email thread"}</span>
        <div style={{ whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.5 }}>{fu.body}</div>
        <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
          <button onClick={() => copy(fu.body, toast)} style={btn()}>Copy</button>
          {l.sent_via !== "instagram" && email && <a href={gmail(email, fuSubject, fu.body)} target="_blank" rel="noreferrer" style={{ ...btn(), textDecoration: "none" }}>Open in Gmail</a>}
          <button onClick={markFollowup} style={btn(C.ink, "#fff")}>Mark follow-up sent</button>
        </div>
      </div>}
      {l.draft && <div>
        <span style={lab}>Email{email ? ` to ${email}` : " (no address found: use the website's contact form)"}</span>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>{l.draft.subject}</div>
        <div style={{ whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.55, background: C.card, borderRadius: 8, padding: 10 }}>{l.draft.body}</div>
        <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
          {email && <a href={gmail(email, l.draft.subject, l.draft.body)} target="_blank" rel="noreferrer" style={{ ...btn(), textDecoration: "none" }}>Open in Gmail</a>}
          <button onClick={() => copy(`${l.draft.subject}\n\n${l.draft.body}`, toast)} style={btn()}>Copy</button>
          {l.stage === "new" && <button onClick={() => markSent("email")} style={btn(C.ink, "#fff")}>Mark email sent</button>}
        </div>
      </div>}
      {l.dm && <div>
        <span style={lab}>Instagram DM{ig ? ` to @${String(ig).replace(/^@/, "")}` : " (find their Instagram first)"}</span>
        <div style={{ whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.55, background: C.card, borderRadius: 8, padding: 10 }}>{l.dm}</div>
        <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
          <button onClick={() => copy(l.dm, toast)} style={btn()}>Copy</button>
          {ig && <a href={igUrl(ig)} target="_blank" rel="noreferrer" style={{ ...btn(), textDecoration: "none" }}>Open Instagram</a>}
          {l.stage === "new" && <button onClick={() => markSent("instagram")} style={btn(C.ink, "#fff")}>Mark DM sent</button>}
        </div>
      </div>}
      <div>
        <span style={lab}>What happened</span>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {[["replied", "Replied"], ["talking", "In talks"], ["sample", "Sample / trial"], ["customer", "Customer 🎉"], ["no", "Not interested"], ["bounced", "Bounced"], ["ours", "Already our customer"], ["skip", "Skip"], ["new", "Reset"]].map(([s, t]) =>
            <button key={s} onClick={() => mark(s, s === "replied" ? { replied_at: today, next_followup: null } : ["no", "bounced", "skip", "customer", "ours"].includes(s) ? { next_followup: null } : {})} style={l.stage === s ? btn(C.ink, "#fff") : btn()}>{t}</button>)}
          {note === null ? <button onClick={() => setNote(l.note || "")} style={btn()}>{l.note ? "Edit note" : "Add note"}</button> : null}
        </div>
        {note !== null && <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          <input value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. wants 5 kg rose quartz tumbles, call Thursday" style={FI({ flex: 1 })} />
          <button onClick={async () => { await onSave({ ...l, note: note.trim() || null }); setNote(null); }} style={btn(C.ink, "#fff")}>Save</button>
          <button onClick={() => setNote(null)} style={btn()}>Cancel</button>
        </div>}
        {(l.history || []).length > 0 && <div style={{ ...sub, marginTop: 8 }}>{l.history.map(h => `${h.day} ${h.what}${h.via ? ` (${h.via})` : ""}`).join(" · ")}</div>}
      </div>
    </div>}
  </div>;
}

export default function OutreachApp({ onHome }) {
  const [leads, setLeads] = useState(null);
  const [err, setErr] = useState("");
  const [toastMsg, setToastMsg] = useState("");
  const [tab, setTab] = useState(() => { try { return localStorage.getItem("outreach-tab") || "today"; } catch { return "today"; } });
  const [f, setF] = useState({ country: "all", stage: "all", tier: "all", seg: "all", q: "" });
  const [shown, setShown] = useState(60);
  const today = istDay();
  const toast = m => { setToastMsg(m); setTimeout(() => setToastMsg(""), 2000); };
  const go = t => { setTab(t); try { localStorage.setItem("outreach-tab", t); } catch {} };
  const refresh = () => load().then(setLeads).catch(e => setErr(e.message));
  useEffect(() => { refresh(); }, []);
  const [picked, setPicked] = useState(() => new Set());
  const [run, setRun] = useState(null);       // { done, n, sent, skipped, now, wait, msgs, stopping, over }
  const stopRef = useRef(false);
  const pick = id => setPicked(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const pickAll = (ls, on) => setPicked(p => { const n = new Set(p); for (const l of ls) on ? n.add(l.id) : n.delete(l.id); return n; });
  const leaveGuard = e => { e.preventDefault(); e.returnValue = ""; };
  // One lead per call, 25–45 s apart, so the mailbox sends like a person rather than a blast.
  const bulk = async (action, ids) => {
    stopRef.current = false;
    const st = { done: 0, n: ids.length, sent: 0, skipped: 0, now: "", wait: 0, msgs: [], over: false };
    const upd = x => { Object.assign(st, x); setRun({ ...st }); };
    upd({});
    window.addEventListener("beforeunload", leaveGuard);
    try {
      for (const id of ids) {
        if (stopRef.current) { st.msgs.push("Stopped."); break; }
        const l0 = leads.find(x => x.id === id);
        upd({ now: l0?.name || id, wait: 0 });
        let d = {}, ok = false;
        try {
          const r = await fetch("/api/mail", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, id }) });
          d = await r.json().catch(() => ({})); ok = r.ok;
          if (d.notConfigured) { st.msgs.push("Gmail isn't connected to the ERP yet, so nothing was sent. Sir needs to set up the Gmail bridge once (scripts/gmail-bridge.gs)."); break; }
          if (!ok) { st.msgs.push(`${l0?.name}: ${d.error || `error ${r.status}`}`); if (/limit .* reached/i.test(d.error || "")) break; }
        } catch (e) { st.msgs.push(`${l0?.name}: ${e.message}`); }
        if (d.lead) setLeads(xs => xs.map(x => x.id === d.lead.id ? d.lead : x));
        if (d.why?.length) { st.skipped++; st.msgs.push(`${l0?.name}: skipped, ${d.why.join("; ")}`); }
        if (d.sent) st.sent++;
        setPicked(p => { const n = new Set(p); n.delete(id); return n; });
        upd({ done: st.done + 1 });
        if (d.sent && st.done < st.n && !stopRef.current) {
          const secs = 25 + Math.floor(Math.random() * 21);
          for (let t = secs; t > 0 && !stopRef.current; t--) { upd({ wait: t }); await pause(1000); }
        }
      }
    } finally {
      window.removeEventListener("beforeunload", leaveGuard);
      upd({ over: true, now: "", wait: 0 });
    }
  };
  const save = async l => { try { await put(l); setLeads(xs => xs.map(x => x.id === l.id ? l : x)); toast(STAGE[l.stage]?.[0] || "Saved"); } catch (e) { setErr(e.message); } };

  const stats = useMemo(() => {
    const s = { total: 0, contacted: 0, replied: 0, customers: 0, byCountry: {} };
    for (const l of leads || []) {
      s.total++; if (l.stage !== "new" && l.stage !== "skip") s.contacted++;
      if (["replied", "talking", "sample", "customer"].includes(l.stage)) s.replied++;
      if (l.stage === "customer") s.customers++;
      s.byCountry[l.country] = (s.byCountry[l.country] || 0) + 1;
    }
    return s;
  }, [leads]);

  const shell = body => <div style={{ minHeight: "100vh", background: C.bg, fontFamily: FONT, color: C.ink }}>
    {toastMsg && <div style={{ position: "fixed", bottom: 22, right: 22, left: mob() ? 22 : "auto", zIndex: 1200, background: C.ink, color: "#fff", padding: "10px 18px", borderRadius: 6, fontSize: 12.5 }}>{toastMsg}</div>}
    <div style={{ position: "sticky", top: 0, zIndex: 100, background: C.surface, borderBottom: `1px solid ${C.border}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: mob() ? "10px 14px" : "11px 28px" }}>
        {onHome && <button onClick={onHome} style={{ background: "none", border: "none", cursor: "pointer", color: C.inkMid, fontFamily: "inherit", fontSize: 13, padding: "0 12px 0 0", borderRight: `1px solid ${C.border}` }}>← Home</button>}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 700, lineHeight: 1 }}>Wholesale outreach</div>
          <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 1 }}>Crystal shops abroad · bulk by the kilo · trade.eartheditions.co</div>
        </div>
        <button onClick={refresh} style={btn()}>↻</button>
      </div>
      <div style={{ display: "flex", overflowX: "auto", padding: mob() ? "0 10px" : "0 28px" }}>
        {[["today", "☀️", "Today"], ["all", "📇", "All leads"], ["playbook", "📘", "Playbook"]].map(([k, ic, t]) =>
          <button key={k} onClick={() => go(k)} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: -1, border: "none", background: "none", cursor: "pointer", fontFamily: "inherit", padding: "11px 14px", fontSize: 13, whiteSpace: "nowrap", fontWeight: tab === k ? 700 : 500, color: tab === k ? C.ink : C.inkMid, borderBottom: `2px solid ${tab === k ? C.gold : "transparent"}` }}><span>{ic}</span>{t}</button>)}
      </div>
    </div>
    <div style={{ padding: mob() ? "14px" : "20px 28px", maxWidth: 1100, margin: "0 auto" }}>
      {err && <div style={{ ...card, background: C.redBg, color: C.red, marginBottom: 12, fontSize: 13 }}>{err}</div>}
      {bar}
      {body}
    </div>
  </div>;

  const sel = (leads || []).filter(l => picked.has(l.id));
  const sendable = sel.filter(l => canEmail(l, today)), checkable = sel.filter(l => l.stage === "new" && l.email);
  const busy = run && !run.over;
  const bar = (sel.length > 0 || run) && <div style={{ ...card, position: "sticky", top: mob() ? 96 : 104, zIndex: 50, marginBottom: 14, borderColor: ACCENT, boxShadow: "0 4px 14px rgba(0,0,0,.06)" }}>
    {busy ? <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
      <div style={{ flex: 1, minWidth: 200, fontSize: 13 }}>
        <b>{run.done} of {run.n}</b> done · {run.sent} sent{run.skipped ? ` · ${run.skipped} skipped` : ""} · {run.wait ? `next in ${run.wait}s` : `now: ${run.now}`}
        <div style={sub}>Keep this page open. Emails go one at a time from the ERP's Gmail, a little apart.</div>
      </div>
      <button onClick={() => { stopRef.current = true; setRun(r => ({ ...r, stopping: true })); }} disabled={run.stopping} style={btn(C.redBg, C.red)}>{run.stopping ? "Stopping…" : "Stop"}</button>
    </div> : <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <div style={{ flex: 1, minWidth: 180, fontSize: 13 }}><b>{sel.length} selected</b>{sel.length > sendable.length ? <span style={sub}> · {sel.length - sendable.length} can't be emailed (no email, DM-only country, or nothing due)</span> : null}</div>
      {sendable.length > 0 && <button onClick={() => { if (window.confirm(`Send ${sendable.length} email${sendable.length > 1 ? "s" : ""} from the ERP's Gmail?\n\nEach shop is checked against customers, trade buyers, Omnisend and past Gmail first, and skipped if we already know them. Follow-ups are skipped if the shop replied. It takes about half a minute per email.`)) bulk("gmail_outreach_send", sendable.map(l => l.id)); }} style={btn(C.ink, "#fff")}>Send {sendable.length} email{sendable.length > 1 ? "s" : ""}</button>}
      {checkable.length > 0 && <button onClick={() => bulk("gmail_outreach_check", checkable.map(l => l.id))} style={btn()}>Check history only</button>}
      <button onClick={async () => { for (const l of sel) await save({ ...l, stage: "skip", next_followup: null, history: [...(l.history || []), { day: today, what: "skip", via: "" }] }); setPicked(new Set()); }} style={btn()}>Skip</button>
      <button onClick={() => setPicked(new Set())} style={btn()}>Clear</button>
      {run?.over && <button onClick={() => setRun(null)} style={btn()}>Hide result</button>}
    </div>}
    {run?.over && <div style={{ fontSize: 12.5, marginTop: 8 }}>Finished: {run.sent} sent{run.skipped ? `, ${run.skipped} skipped` : ""}.</div>}
    {run?.msgs?.length > 0 && <div style={{ ...sub, marginTop: 6, display: "grid", gap: 2 }}>{run.msgs.slice(-12).map((m, i) => <div key={i}>{m}</div>)}</div>}
  </div>;
  const selAll = ls => {
    const on = ls.some(l => !picked.has(l.id));
    return ls.length > 0 && <button onClick={() => pickAll(ls, on)} style={{ ...btn(), marginLeft: 8, fontFamily: FONT, verticalAlign: "middle" }}>{on ? "Select all" : "Clear"}</button>;
  };
  const row = (l, extra = {}) => <Lead key={l.id} l={l} onSave={save} toast={toast} today={today} picked={picked.has(l.id)} onPick={busy ? null : pick} {...extra} />;

  if (!leads) return shell(<div style={sub}>Loading…</div>);
  const kpi = (n, t) => <div style={card}><div style={{ fontFamily: SERIF, fontSize: 26, fontWeight: 700 }}>{n}</div><div style={sub}>{t}</div></div>;
  const kpis = <div style={{ display: "grid", gridTemplateColumns: mob() ? "1fr 1fr" : "repeat(4, minmax(0,1fr))", gap: 10, marginBottom: 16 }}>
    {kpi(stats.total, Object.entries(stats.byCountry).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${FLAG[c] || c} ${n}`).join("  "))}
    {kpi(stats.contacted, "contacted")}{kpi(stats.replied, `replied${stats.contacted ? ` · ${Math.round(stats.replied / stats.contacted * 100)}%` : ""}`)}{kpi(stats.customers, "became customers")}
  </div>;

  if (tab === "playbook") return shell(<div style={{ ...card, fontSize: 14, lineHeight: 1.6 }}><Md text={PLAYBOOK} /></div>);

  if (tab === "today") {
    const due = leads.filter(l => isDue(l, today));
    const usedE = sentToday(leads, "email", today, /^sent$/), usedI = sentToday(leads, "instagram", today);
    const fresh = leads.filter(l => l.stage === "new").sort((a, b) => (a.tier || "C").localeCompare(b.tier || "C") || (b.score || 0) - (a.score || 0));
    const pickE = fresh.filter(l => l.email && l.channel !== "instagram" && !NO_COLD_EMAIL.includes(l.country)).slice(0, Math.max(0, CAP.email - usedE));
    // Only shops we can't email (no address, or Germany/Austria). Email shops past today's 20 wait
// for tomorrow's email list rather than spilling in here and getting both a DM and an email.
    const pickI = fresh.filter(l => l.instagram && l.dm && (!l.email || l.channel === "instagram" || NO_COLD_EMAIL.includes(l.country))).slice(0, Math.max(0, CAP.instagram - usedI));
    return shell(<>
      {kpis}
      <div style={{ ...sub, marginBottom: 14 }}>Today: {usedE}/{CAP.email} new shops emailed and {usedI}/{CAP.instagram} Instagram DMs sent. Follow-ups don't count toward the 20. Staying under these limits keeps the mailbox and the Instagram account out of spam filters. Tick shops and press Send, or open one and send it yourself. Reply to anyone who answers within a day.</div>
      <div style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 700, margin: "0 0 10px" }}>Follow-ups due <span style={{ ...sub, fontFamily: FONT }}>{due.length}</span>{selAll(due.filter(l => canEmail(l, today)))}</div>
      <div style={{ display: "grid", gap: 10, marginBottom: 22 }}>{due.map(l => row(l, { open: true }))}{!due.length && <div style={{ ...card, ...sub }}>None due today.</div>}</div>
      <div style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 700, margin: "0 0 10px" }}>Send today by email <span style={{ ...sub, fontFamily: FONT }}>{pickE.length}</span>{selAll(pickE)}</div>
      <div style={{ display: "grid", gap: 10, marginBottom: 22 }}>{pickE.map(l => row(l))}{!pickE.length && <div style={{ ...card, ...sub }}>Daily email limit reached, or no leads with an email left.</div>}</div>
      <div style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 700, margin: "0 0 10px" }}>Send today on Instagram <span style={{ ...sub, fontFamily: FONT }}>{pickI.length}</span> <span style={{ ...sub, fontFamily: FONT }}>· shops with no email, and Germany/Austria</span></div>
      <div style={{ display: "grid", gap: 10 }}>{pickI.map(l => row(l))}{!pickI.length && <div style={{ ...card, ...sub }}>Daily DM limit reached, or no Instagram leads left.</div>}</div>
    </>);
  }

  const q = f.q.trim().toLowerCase();
  const list = leads.filter(l => (f.country === "all" || l.country === f.country) && (f.stage === "all" || l.stage === f.stage) && (f.tier === "all" || l.tier === f.tier) && (f.seg === "all" || l.segment === f.seg)
    && (!q || `${l.name} ${l.city || ""} ${l.email || ""} ${l.instagram || ""}`.toLowerCase().includes(q)))
    .sort((a, b) => (a.tier || "C").localeCompare(b.tier || "C") || (b.score || 0) - (a.score || 0));
  const dd = (k, opts) => <select value={f[k]} onChange={e => { setF(x => ({ ...x, [k]: e.target.value })); setShown(60); }} style={FI({ width: "auto", padding: "6px 8px" })}>{opts.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select>;
  return shell(<>
    {kpis}
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12, alignItems: "center" }}>
      {dd("country", [["all", "All countries"], ...Object.keys(stats.byCountry).sort().map(c => [c, `${FLAG[c] || ""} ${c}`])])}
      {dd("tier", [["all", "All tiers"], ["A", "Tier A"], ["B", "Tier B"], ["C", "Tier C"]])}
      {dd("seg", [["all", "All types"], ...Object.entries(SEG)])}
      {dd("stage", [["all", "Any stage"], ...Object.entries(STAGE).map(([k, v]) => [k, v[0]])])}
      <input value={f.q} onChange={e => setF(x => ({ ...x, q: e.target.value }))} placeholder="Search name, email, @handle" style={FI({ width: 220 })} />
      <span style={sub}>{list.length} leads</span>{selAll(list.slice(0, shown))}
    </div>
    <div style={{ display: "grid", gap: 10 }}>{list.slice(0, shown).map(l => row(l))}</div>
    {list.length > shown && <button onClick={() => setShown(n => n + 60)} style={{ ...btn(), marginTop: 12 }}>Show more</button>}
  </>);
}
