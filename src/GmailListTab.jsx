/* The ERP's own mailing list and the campaigns sent from our Gmail
   (lib/mailList.js). Opening the tab also reads Gmail for replies,
   unsubscribe emails and bounces. */
import { useState, useEffect, useCallback } from "react";
import { C, FI, mob } from "./lmTheme.js";
import { mailApi, useGmailRunner, ProgressBar } from "./GmailSend.jsx";
import WeeklyCard from "./WeeklyCard.jsx";

const fmt = v => {
  const d = new Date(v);
  return isNaN(d) ? "—" : `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} · ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
};
const TONE = { subscribed: [C.green, C.greenBg], unsubscribed: [C.red, C.redBg], bounced: [C.red, C.redBg], nonSubscribed: [C.inkFaint, C.card] };
const KIND = { no: "unsubscribe", list: "interested", interested: "🔥 interested", auto: "auto-reply", reply: "reply" };

export default function GmailListTab({ showToast }) {
  const [sum, setSum] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [scanMsg, setScanMsg] = useState("");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [contacts, setContacts] = useState(null);
  const [open, setOpen] = useState("");
  const [live, setLive] = useState({});
  const m = mob();

  const load = useCallback(() => mailApi({ action: "gmail_list_summary" }).then(setSum).catch(e => setErr(e.message)), []);
  useEffect(() => {
    load();
    mailApi({ action: "gmail_campaign_scan" }).then(r => {
      const bits = [r.replies && `${r.replies} new repl${r.replies === 1 ? "y" : "ies"}`, r.unsubs && `${r.unsubs} unsubscribed`, r.bounces && `${r.bounces} bounced`].filter(Boolean);
      setScanMsg(bits.length ? `Gmail checked: ${bits.join(" · ")}` : "Gmail checked: nothing new");
      if (bits.length) load();
    }).catch(e => setScanMsg(`Couldn't read Gmail: ${e.message}`));
  }, [load]);
  useEffect(() => {
    const t = setTimeout(() => mailApi({ action: "gmail_list_contacts", q, status }).then(setContacts).catch(e => setErr(e.message)), 250);
    return () => clearTimeout(t);
  }, [q, status, sum]);

  const { running, run, stop } = useGmailRunner({
    onProgress: p => setLive(x => ({ ...x, [p.id]: p })),
    onDone: () => { showToast?.("📬 Send finished"); load(); },
    onError: e => setErr(e.message),
  });

  const importOmni = async () => {
    if (!window.confirm("Copy every contact from Omnisend into the ERP's list? Anyone already unsubscribed or bounced here stays that way.")) return;
    setBusy("import"); setErr("");
    try { const r = await mailApi({ action: "gmail_list_import" }); showToast?.(`✓ ${r.imported} contacts imported`); load(); }
    catch (e) { setErr(e.message); } finally { setBusy(""); }
  };
  const setOne = async (email, st) => {
    try { await mailApi({ action: "gmail_list_set", email, status: st }); load(); }
    catch (e) { setErr(e.message); }
  };

  const card = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: m ? 12 : 16 };
  const small = { background: C.card, color: C.ink, border: `1px solid ${C.border}`, borderRadius: 8, padding: "6px 12px", fontSize: 11.5, fontWeight: 700, cursor: "pointer" };
  const n = sum?.counts || {};

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ ...card, display: "flex", gap: 18, flexWrap: "wrap", alignItems: "center" }}>
        {[["Subscribed", n.subscribed, C.green], ["Not opted in", n.nonSubscribed, C.inkFaint], ["Unsubscribed", n.unsubscribed, C.red], ["Bounced", n.bounced, C.red]].map(([l, v, c]) => (
          <div key={l}><div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 28, fontWeight: 700, color: c, lineHeight: 1 }}>{v ?? "…"}</div><div style={{ fontSize: 11, color: C.inkFaint }}>{l}</div></div>
        ))}
        <div style={{ flex: 1 }} />
        <div style={{ display: "grid", gap: 6, justifyItems: "end" }}>
          <button onClick={importOmni} disabled={!!busy} style={small}>{busy === "import" ? "Importing…" : "⇣ Import from Omnisend"}</button>
          <div style={{ fontSize: 11, color: C.inkFaint }}>Sends from {sum?.from || "team@eartheditions.co"} · up to {sum?.dayCap || 1200} a day</div>
        </div>
      </div>
      {scanMsg && <div style={{ fontSize: 11.5, color: C.inkMid }}>{scanMsg}</div>}
      {err && <div style={{ fontSize: 12, color: C.red }}>{err}</div>}

      <WeeklyCard card={card} small={small} showToast={showToast} />

      <div style={card}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>Sent from Gmail</div>
        {!sum?.sends?.length && <div style={{ fontSize: 12.5, color: C.inkFaint }}>Nothing yet. Open a campaign draft and use "Send from our Gmail".</div>}
        <div style={{ display: "grid", gap: 10 }}>
          {(sum?.sends || []).map(s => {
            const p = live[s.id] || { id: s.id, status: s.status, pausedWhy: s.pausedWhy, total: s.total, sent: s.sentCount, failed: s.failedCount, skipped: Object.keys(s.skipped || {}).length };
            const replies = s.replies || [];
            return (
              <div key={s.id} style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: 12, display: "grid", gap: 8 }}>
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <div style={{ fontWeight: 700, fontSize: 13, flex: 1, minWidth: 200 }}>{s.subject}</div>
                  <div style={{ fontSize: 11, color: C.inkFaint }}>{fmt(s.startedAt || s.createdAt)}</div>
                  {["sending", "paused"].includes(p.status) && (running === s.id
                    ? <button onClick={stop} style={small}>Pause</button>
                    : <button onClick={() => run(s.id)} disabled={!!running} style={{ ...small, background: C.tealBg, color: C.teal, borderColor: C.teal }}>Resume</button>)}
                </div>
                {p.status !== "ready" ? <ProgressBar p={p} /> : <div style={{ fontSize: 11.5, color: C.inkFaint }}>Prepared, not sent{s.testedAt ? " (test sent)" : ""}.</div>}
                <div style={{ fontSize: 11.5, color: C.inkMid, display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <span>💬 {replies.filter(r => r.kind !== "auto").length} replies{replies.some(r => r.kind === "interested") ? ` (${replies.filter(r => r.kind === "interested").length} interested)` : ""}</span>
                  <span>👆 {s.clicks?.people || 0} clicked</span>
                  <span>🚫 {(s.unsubs || []).length} unsubscribed</span>
                  <span>↩ {(s.bounces || []).length} bounced</span>
                  {replies.length > 0 && <button onClick={() => setOpen(o => o === s.id ? "" : s.id)} style={{ ...small, padding: "2px 9px" }}>{open === s.id ? "Hide replies" : "Show replies"}</button>}
                </div>
                {s.clicks?.top?.length > 0 && (
                  <div style={{ fontSize: 11.5, color: C.inkMid }}>Most clicked: {s.clicks.top.map(([t, n]) => `${t} (${n})`).join(" · ")}</div>
                )}
                {open === s.id && (
                  <div style={{ display: "grid", gap: 6 }}>
                    {replies.slice().reverse().map(r => (
                      <a key={r.messageId} href={r.url} target="_blank" rel="noreferrer" style={{ textDecoration: "none", color: C.ink, background: C.card, borderRadius: 8, padding: "7px 10px", fontSize: 12 }}>
                        <strong>{r.email}</strong> <span style={{ color: C.inkFaint }}>· {KIND[r.kind] || r.kind} · {fmt(r.at)}</span>
                        <div style={{ color: C.inkMid, marginTop: 2 }}>{r.snippet}</div>
                      </a>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: m ? "1fr" : "1fr 1fr", gap: 16 }}>
        <div style={card}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Most engaged</div>
          <div style={{ fontSize: 11, color: C.inkFaint, marginBottom: 8 }}>Who replies and clicks. They get each new send first, and the tags "replied" / "clicked" pick them as an audience.</div>
          {!sum?.engaged?.length && <div style={{ fontSize: 12, color: C.inkFaint }}>No one yet — this fills in after the first send.</div>}
          {(sum?.engaged || []).map(c => {
            const g = c.eng || {}, likes = Object.entries(g.interests || {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0]);
            return (
              <div key={c.id} style={{ fontSize: 12, padding: "5px 0", borderBottom: `1px solid ${C.border}` }}>
                <strong>{c.name || c.id}</strong>{c.name && <span style={{ color: C.inkFaint }}> · {c.id}</span>}
                <div style={{ color: C.inkMid, fontSize: 11 }}>💬 {g.replies || 0} · 👆 {g.clicks || 0} · sent {g.sent || 0}{likes.length ? ` · liked ${likes.join(", ")}` : ""}</div>
              </div>
            );
          })}
        </div>
        <div style={card}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Unsubscribed and bounced</div>
          <div style={{ fontSize: 11, color: C.inkFaint, marginBottom: 8 }}>Taken off automatically — from the link, Gmail's unsubscribe button, a "remove me" reply, or a bounce. They're never sent to again.</div>
          {(sum?.unsubs || []).map(c => (
            <div key={c.id} style={{ fontSize: 12, padding: "5px 0", borderBottom: `1px solid ${C.border}`, display: "flex", gap: 8 }}>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{c.id}</span>
              <span style={{ color: c.status === "bounced" ? C.red : C.inkFaint, fontSize: 11 }}>{c.status === "bounced" ? "bounced" : c.why || "unsubscribed"} · {fmt(c.at)}</span>
            </div>
          ))}
        </div>
      </div>

      <div style={card}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
          <div style={{ fontSize: 14, fontWeight: 700, flex: 1 }}>Contacts{contacts ? ` · ${contacts.count}` : ""}</div>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search email, name or tag" style={{ ...FI(), width: m ? "100%" : 220 }} />
          <select value={status} onChange={e => setStatus(e.target.value)} style={{ ...FI(), width: 150 }}>
            <option value="">Everyone</option><option value="subscribed">Subscribed</option><option value="nonSubscribed">Not opted in</option><option value="unsubscribed">Unsubscribed</option><option value="bounced">Bounced</option>
          </select>
        </div>
        <div style={{ display: "grid", gap: 4 }}>
          {(contacts?.contacts || []).map(c => {
            const [fg, bg] = TONE[c.status] || TONE.nonSubscribed;
            return (
              <div key={c.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "6px 4px", borderBottom: `1px solid ${C.border}`, fontSize: 12.5, flexWrap: m ? "wrap" : "nowrap" }}>
                <div style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.id}{c.firstName ? <span style={{ color: C.inkFaint }}> · {c.firstName} {c.lastName || ""}</span> : null}</div>
                <div style={{ fontSize: 10.5, color: C.inkFaint, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{(c.tags || []).join(", ")}</div>
                <span style={{ background: bg, color: fg, borderRadius: 12, padding: "2px 9px", fontSize: 10.5, fontWeight: 700 }}>{c.status}</span>
                {c.status === "subscribed"
                  ? <button onClick={() => setOne(c.id, "unsubscribed")} style={{ ...small, padding: "3px 9px" }}>Unsubscribe</button>
                  : c.status !== "bounced" && <button onClick={() => window.confirm(`Put ${c.id} back on the list? Only do this if they asked to be.`) && setOne(c.id, "subscribed")} style={{ ...small, padding: "3px 9px" }}>Re-add</button>}
              </div>
            );
          })}
          {contacts && contacts.count > 200 && <div style={{ fontSize: 11, color: C.inkFaint, paddingTop: 6 }}>Showing 200 — search to narrow it down.</div>}
        </div>
      </div>
    </div>
  );
}
