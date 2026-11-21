/* "Friday's email" on Home: the weekly new-pieces issue (lib/weekly.js) before
   it goes out. Sir asked for it to send by itself but to show here first, so
   he can change the subject or the note, take pieces out, send himself a test,
   or skip the week. Admin only. Before Thursday's build it shows what's new so far. */
import { useState, useEffect, useCallback } from "react";
import { C, FI, mob } from "./lmTheme.js";
import { mailApi } from "./GmailSend.jsx";

const fmt = v => v ? new Date(v).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "";

export default function WeeklyHomeCard() {
  const [d, setD] = useState(null);
  const [soFar, setSoFar] = useState(null);
  const [subject, setSubject] = useState("");
  const [note, setNote] = useState("");
  const [drop, setDrop] = useState(() => new Set());
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const m = mob();

  const load = useCallback(async () => {
    try {
      const x = await mailApi({ action: "gmail_weekly_get" });
      setD(x);
      // The issue still to go: this week's, or last week's if it's approved and unsent.
      const w = [x.current, x.last].find(v => v && ["awaiting", "approved"].includes(v.state));
      if (w) { setSubject(w.subject || ""); setNote(w.note || ""); setDrop(new Set(w.dropped || [])); }
      else if (!x.current) mailApi({ action: "gmail_weekly_preview" }).then(r => setSoFar(r.pieces)).catch(() => {});
    } catch (e) { setMsg(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);
  if (!d) return null;

  const w = [d.current, d.last].find(v => v && ["awaiting", "approved"].includes(v.state));
  const s = d.settings;
  const card = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: m ? 12 : 16, marginBottom: 14 };
  const btn = { background: C.card, color: C.ink, border: `1px solid ${C.border}`, borderRadius: 8, padding: "6px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer" };
  const act = async (name, payload, done) => {
    setBusy(name); setMsg("");
    try { await mailApi(payload); setMsg(done); await load(); } catch (e) { setMsg(`⚠ ${e.message}`); } finally { setBusy(""); }
  };

  // Not built yet: a glance at what Thursday will pick up.
  if (!w) {
    const last = d.current || d.last;
    return (
      <div style={card}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>✉️ Weekly new-pieces email</div>
        <div style={{ fontSize: 12.5, color: C.inkMid, marginTop: 4 }}>
          {s.paused ? "Paused." : d.current ? `This week: ${d.current.state}${d.current.why ? ` (${d.current.why})` : ""}${d.current.sentAt ? `, ${d.current.sent} sent ${fmt(d.current.sentAt)}` : ""}.`
            : `Next issue builds Thursday ${s.buildAt} IST and ${s.mode === "auto" ? "sends by itself" : "waits for your OK"} Friday ${s.sendAt}. ${soFar ? `${soFar.length} new piece${soFar.length === 1 ? "" : "s"} so far` : ""}.`}
          {" "}{d.stats.audience} on the list.{last?.sentAt && last !== d.current ? ` Last one: ${last.sent} sent.` : ""}
        </div>
      </div>
    );
  }

  const pieces = w.pieces || [], kept = pieces.filter(p => !drop.has(p.url));
  const dirty = subject !== (w.subject || "") || note !== (w.note || "") || [...drop].sort().join() !== [...(w.dropped || [])].sort().join();
  const late = Date.now() > Date.parse(w.sendAfter);
  return (
    <div style={{ ...card, borderColor: w.state === "awaiting" ? C.amber : C.border }}>
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>✉️ {w.state === "approved" ? `Goes out ${late ? "now" : fmt(w.sendAfter)}` : "Waiting for your OK"}: weekly new pieces</div>
        <div style={{ fontSize: 12, color: C.inkFaint }}>{kept.length} pieces · {w.audience} people · from team@eartheditions.co</div>
      </div>
      <div style={{ fontSize: 13, margin: "6px 0 10px" }}><strong>{w.subject}</strong></div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {w.state === "awaiting" && <button disabled={!!busy} onClick={() => act("ok", { action: "gmail_weekly_decide", week: w.week, act: "approve" }, "✓ Approved. It goes out within 15 minutes.")} style={{ ...btn, background: C.green, color: "#fff", borderColor: C.green }}>Approve and send</button>}
        <button onClick={() => setOpen(o => !o)} style={btn}>{open ? "Close" : "✎ Edit"}</button>
        <button disabled={!!busy} onClick={() => act("test", { action: "gmail_weekly_test", week: w.week }, `✓ Test sent to ${s.approver}`)} style={btn}>{busy === "test" ? "Sending…" : "Send me a test"}</button>
        <button disabled={!!busy} onClick={() => window.confirm("Skip this week? Nothing goes out.") && act("skip", { action: "gmail_weekly_decide", week: w.week, act: "skip" }, "Skipped this week")} style={btn}>Skip this week</button>
      </div>
      {open && (
        <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
          <label style={{ fontSize: 11.5, color: C.inkMid }}>Subject
            <input value={subject} onChange={e => setSubject(e.target.value)} style={{ ...FI(), marginTop: 4 }} /></label>
          <label style={{ fontSize: 11.5, color: C.inkMid }}>Note (after "Hi [name],")
            <textarea value={note} onChange={e => setNote(e.target.value)} rows={4} style={{ ...FI(), marginTop: 4, resize: "vertical", fontFamily: "inherit" }} /></label>
          <div style={{ fontSize: 11.5, color: C.inkMid }}>Pieces (the first 6 show with photos; tap to take one out)</div>
          <div style={{ display: "grid", gap: 6, gridTemplateColumns: m ? "1fr" : "1fr 1fr" }}>
            {pieces.map(p => {
              const out = drop.has(p.url);
              return (
                <button key={p.url} onClick={() => setDrop(x => { const n = new Set(x); n.has(p.url) ? n.delete(p.url) : n.add(p.url); return n; })}
                  style={{ display: "flex", gap: 8, alignItems: "center", textAlign: "left", background: out ? C.card : C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: 6, cursor: "pointer", opacity: out ? 0.45 : 1 }}>
                  {p.image ? <img src={p.image} alt="" width={40} height={40} style={{ objectFit: "cover", borderRadius: 5 }} /> : <div style={{ width: 40 }} />}
                  <span style={{ fontSize: 12, flex: 1, textDecoration: out ? "line-through" : "none" }}>{p.title}<br /><span style={{ color: C.inkFaint }}>{[p.price, p.where === "etsy" ? "Etsy" : "store"].filter(Boolean).join(" · ")}</span></span>
                  <span style={{ fontSize: 13 }}>{out ? "↺" : "✕"}</span>
                </button>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button disabled={!dirty || !!busy} onClick={() => act("save", { action: "gmail_weekly_edit", week: w.week, subject, note, drop: [...drop] }, "✓ Saved. Send yourself a test to see it.")} style={{ ...btn, background: dirty ? C.ink : C.card, color: dirty ? C.surface : C.inkFaint }}>{busy === "save" ? "Saving…" : "Save changes"}</button>
          </div>
        </div>
      )}
      {msg && <div style={{ fontSize: 12, color: msg.startsWith("⚠") ? C.red : C.inkMid, marginTop: 8 }}>{msg}</div>}
    </div>
  );
}
