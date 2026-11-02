import { useState, useEffect } from "react";
import { C, FI } from "./ui.jsx";
import { fmtDate } from "./utils.js";

/* Find the email behind a figure — a remittance advice, a purchase bill, a
   statement — and pull its attachment in. Searches Gmail through /api/mail
   (gmail_search), written the ways the figure is usually printed, around the
   date. Picking an attachment saves it to storage and hands back {url,name,type,size}. */

// 150000 → 150000 · 1,50,000 · 150,000 · 150000.00 …  4594.17 → 4594.17 · 4,594.17
export function amountForms(amount) {
  const n = Math.abs(+amount || 0);
  if (!n) return [];
  const whole = Number.isInteger(Math.round(n * 100) / 100);
  const dec = whole ? 0 : 2;
  const plain = n.toFixed(dec);
  const forms = new Set([plain,
    n.toLocaleString("en-IN", { minimumFractionDigits: dec, maximumFractionDigits: dec }),
    n.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec })]);
  if (whole) [n.toFixed(2), n.toLocaleString("en-IN", { minimumFractionDigits: 2 }), n.toLocaleString("en-US", { minimumFractionDigits: 2 })].forEach(f => forms.add(f));
  return [...forms];
}

const gmailDate = (d, days) => {
  const t = new Date(`${d}T12:00:00`);
  if (isNaN(t)) return "";
  t.setDate(t.getDate() + days);
  return `${t.getFullYear()}/${t.getMonth() + 1}/${t.getDate()}`;
};

export function gmailQuery({ amount, date, text = "", days = 15 }) {
  const forms = amountForms(amount);
  const parts = [];
  if (forms.length) parts.push(`(${forms.map(f => `"${f}"`).join(" OR ")})`);
  if (text) parts.push(text);
  if (date && days) { parts.push(`after:${gmailDate(date, -days)}`); parts.push(`before:${gmailDate(date, days + 1)}`); }
  return parts.join(" ");
}

const post = async body => {
  const r = await fetch("/api/mail", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || `Gmail search failed (${r.status})`), { notConfigured: d.notConfigured });
  return d;
};

const kb = n => n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

export default function GmailFinder({ amount, date, text = "", folder = "gmail", onPick, pickLabel = "Attach", autoSearch = true }) {
  const [q, setQ] = useState(() => gmailQuery({ amount, date, text }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [threads, setThreads] = useState(null);
  const [taking, setTaking] = useState("");
  const [taken, setTaken] = useState({});
  const find = amountForms(amount).join("|");

  const search = async (query = q) => {
    if (!query.trim()) return;
    setBusy(true); setErr("");
    try { setThreads((await post({ action: "gmail_search", q: query, find })).threads || []); }
    catch (e) { setErr(e.notConfigured ? "Gmail isn't connected to the ERP yet — see scripts/gmail-bridge.gs for the one-time set-up." : e.message); setThreads(null); }
    setBusy(false);
  };
  useEffect(() => { if (autoSearch && q.trim()) search(); }, []);

  const take = async (m, a) => {
    const k = `${m.id}:${a.index}`;
    setTaking(k); setErr("");
    try {
      const att = await post({ action: "gmail_attachment", messageId: m.id, index: a.index, folder });
      await onPick({ ...att, fromEmail: { subject: m.subject, from: m.from, date: m.date } });
      setTaken(t => ({ ...t, [k]: true }));
    } catch (e) { setErr(e.message); }
    setTaking("");
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 6 }}>
        <input value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === "Enter") search(); }} placeholder="Amount, invoice no., sender…"
          style={{ ...FI, flex: 1, minWidth: 0, fontSize: 12, padding: "7px 9px" }} />
        <button className="bp" style={{ fontSize: 12, padding: "7px 12px" }} disabled={busy} onClick={() => search()}>{busy ? "Searching…" : "Search"}</button>
      </div>
      <div style={{ fontSize: 10.5, color: C.inkFaint, marginTop: 4 }}>Searches Gmail for the figure as it's usually written, 15 days either side. Edit the search to widen it.</div>
      {err && <div style={{ fontSize: 12, color: C.red, marginTop: 8 }}>{err}</div>}
      {threads && threads.length === 0 && <div style={{ fontSize: 12, color: C.inkFaint, marginTop: 10 }}>No emails found. Try removing the dates, or search a reference or sender.</div>}
      {threads && threads.map(t => {
        const msgs = t.messages.filter(m => m.attachments.length || m.hit);
        const show = msgs.length ? msgs : t.messages.slice(-1);
        return (
          <div key={t.id} style={{ border: `1px solid ${C.border}`, borderRadius: 8, background: C.card, padding: "9px 11px", marginTop: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
              <div style={{ fontSize: 12.5, fontWeight: 800, color: C.ink, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.subject || "(no subject)"}</div>
              <a href={t.url} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: C.blue, flexShrink: 0 }}>Open ↗</a>
            </div>
            {show.map(m => (
              <div key={m.id} style={{ marginTop: 6 }}>
                <div style={{ fontSize: 11, color: C.inkMid }}>{m.from.replace(/<.*>/, "").trim() || m.from} · {fmtDate(m.date.slice(0, 10))}</div>
                {(m.hit || m.snippet) && <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 2, wordBreak: "break-word" }}>{m.hit ? `…${m.hit}…` : m.snippet}</div>}
                {m.attachments.map(a => {
                  const k = `${m.id}:${a.index}`;
                  return (
                    <div key={k} style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 5, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, padding: "5px 8px" }}>
                      <span style={{ fontSize: 14 }}>{/pdf/i.test(a.type) ? "📄" : /image/i.test(a.type) ? "🖼" : /sheet|excel|csv/i.test(a.type + a.name) ? "📊" : "📎"}</span>
                      <span title={a.name} style={{ flex: 1, minWidth: 0, fontSize: 11.5, fontWeight: 700, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</span>
                      <span style={{ fontSize: 10.5, color: C.inkFaint, flexShrink: 0 }}>{kb(a.size)}</span>
                      <button className={taken[k] ? "bs" : "bp"} disabled={!!taking || taken[k]} onClick={() => take(m, a)} style={{ fontSize: 11, padding: "4px 10px", flexShrink: 0 }}>
                        {taken[k] ? "✓ Done" : taking === k ? "…" : pickLabel}
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
