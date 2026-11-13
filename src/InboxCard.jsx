/* "This morning" on Home: what the 07:00 inbox scan (lib/inbox-scan.js) found in
   Gmail and wants Sir to approve. Purchase bills with our GSTIN, remittance
   advices and shipping papers, each with up to three suggested matches, plus
   remittances that still have no paperwork. Admin only.

   Approve attaches the saved document to the chosen ledger entry, purchase bill,
   invoice or register entry: one read just before, one save (the same path as
   the 📎 attach button), never retried. Dismiss only marks the inbox row. */
import { useState, useEffect, useCallback } from "react";
import { C, mob } from "./lmTheme.js";
import { supabase } from "./supabase.js";
import { loadKFresh, saveK, fmtDate, DEMO_MODE } from "./utils.js";
import GmailFinder from "./GmailFinder.jsx";

const INBOX_KEY = "ng-inbox-docs-v1", SCAN_KEY = "ng-inbox-scan-v1";
const uid = () => Math.random().toString(36).slice(2, 10);
const KIND = {
  bill: { icon: "🧾", label: "Purchase bill" },
  remittance: { icon: "💱", label: "Remittance advice" },
  shipping: { icon: "📦", label: "Shipping paper" },
  missing: { icon: "❓", label: "No paperwork yet" },
};
const TARGET = { txn: "Ledger entry", purchase: "Purchase bill", invoice: "Invoice", remit: "Remittance Register" };
const COMPANY = { ng: "Nikhil Gems", at: "Atyahara" };
const keyFor = (target, co) => target === "txn" ? `${co || "ng"}-fin-txns-v1` : target === "purchase" ? (co === "at" ? "at-purch-v1" : "ng-purch-v5")
  : target === "invoice" ? "ng-invoices-v2" : "er-ng-remittances-v1";
// Currency always labelled: ₹ for rupees, the code (USD, EUR…) for the rest.
const money = (n, cur) => n == null || n === "" ? "" : (!cur || cur === "INR") ? `₹${(+n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`
  : `${cur} ${(+n).toLocaleString("en-US", { maximumFractionDigits: 2 })}${cur === "USD" ? " ($)" : ""}`;
const invoiceLabel = (doc) => {
  const n = `${doc.file?.name || ""} ${doc.email?.subject || ""}`;
  if (doc.kind === "remittance") return "BOI Remittance";
  if (/awb|hawb|waybill|hbl|bill of lading/i.test(n)) return "HAWB / HBL";
  if (/shipping\s*bill|\bsb\b/i.test(n)) return "Shipping Bill";
  if (/packing/i.test(n)) return "Packing List";
  return "Shipping document";
};

const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} took over ${ms / 1000}s — not retried; check the entry before trying again`)), ms))]);

// Demo mode (previews) shows made-up rows; nothing is read or written.
const DEMO = {
  scan: { id: "last", at: new Date().toISOString(), ok: true, trigger: "cron" },
  rows: [
    { id: "d1", kind: "bill", status: "pending", company: "ng", email: { subject: "Tax invoice 2026-118", from: "Demo Lapidary Works", date: new Date().toISOString() },
      file: { url: "#", name: "TI-2026-118.pdf" }, fields: { vendor: "Demo Lapidary Works", invoiceNo: "TI-2026-118", date: "2026-11-11", amount: 48500, currency: "INR" },
      matches: [{ target: "txn", company: "ng", id: "x1", label: "Demo Lapidary Works · ₹48,500 · 2026-11-12", why: "same amount, 1 day after the bill, payee matches" },
        { target: "purchase", company: "ng", id: "x2", label: "Purchase bill TI-2026-118 · Demo Lapidary Works · ₹48,500", why: "same bill number, same total" }] },
    { id: "d2", kind: "remittance", status: "pending", company: "ng", email: { subject: "Foreign inward remittance advice", from: "Bank of India", date: new Date().toISOString() },
      file: { url: "#", name: "0013IRT26001001.pdf" }, fields: { vendor: "Bank of India", party: "Demo Minerals LLC", invoiceNo: "0013IRT26001001", date: "2026-11-12", amount: 2400, currency: "USD" },
      matches: [{ target: "remit", company: "ng", id: "x3", label: "Register 0013IRT26001001 · USD 2,400 · 2026-11-12", why: "same IRT, same amount, within a week" }] },
    { id: "d3", kind: "shipping", status: "pending", company: "ng", email: { subject: "Your DHL waybill", from: "DHL Express", date: new Date().toISOString() },
      file: { url: "#", name: "AWB-1234567890.pdf" }, fields: { vendor: "DHL Express", reference: "1234567890", date: "2026-11-10", amount: null, currency: "" }, matches: [] },
    { id: "d4", kind: "missing", status: "pending", target: "txn", targetId: "x4", label: "Inward credit · BOI", date: "2026-11-05", amount: 182340, currency: "INR" },
  ],
};

async function readInbox() {
  if (DEMO_MODE) return DEMO;
  const { data, error } = await supabase.from("app_rows").select("data").in("key", [INBOX_KEY, SCAN_KEY]).eq("deleted", false).limit(2000);
  if (error) throw new Error(error.message);
  const all = (data || []).map(r => r.data);
  return { scan: all.find(r => r.id === "last") || null, rows: all.filter(r => r.id !== "last") };
}
const markRow = (row, patch) => DEMO_MODE ? Promise.resolve() : supabase.rpc("app_rows_upsert", { p_key: INBOX_KEY, p_item: { ...row, ...patch, decidedAt: new Date().toISOString() }, p_prepend: false })
  .then(({ error }) => { if (error) throw new Error(error.message); });

/* Put `file` on one record. One fresh read, one save. */
async function attachTo({ target, company, id }, file, doc) {
  if (DEMO_MODE) return "attached";
  const key = keyFor(target, company);
  const list = await withTimeout(loadKFresh(key), 20000, "Reading the records");
  if (!Array.isArray(list)) throw new Error("Couldn't read the records");
  const rec = list.find(x => x?.id === id);
  if (!rec) throw new Error(`That ${TARGET[target].toLowerCase()} is no longer there`);
  const now = new Date().toISOString(), ext = (file.name || "").split(".").pop().toLowerCase();
  const fromEmail = doc.email ? { subject: doc.email.subject, from: doc.email.from, date: doc.email.date } : undefined;
  let next;
  if (target === "txn") {
    const atts = rec.attachments || (rec.attachmentUrl ? [{ url: rec.attachmentUrl, name: rec.attachmentName || "Attachment" }] : []);
    if (atts.some(a => a.url === file.url)) return "already there";
    const all = [...atts, { id: uid(), url: file.url, name: file.name, type: file.type, size: file.size, ext, uploadedAt: now, source: "gmail-inbox", fromEmail }];
    next = { ...rec, attachments: all, attachmentUrl: all[0]?.url || null, attachmentName: all[0]?.name || null, updatedAt: now };
  } else if (target === "invoice") {
    const atts = Array.isArray(rec.attachments) ? rec.attachments : [];
    if (atts.some(a => a.url === file.url)) return "already there";
    next = { ...rec, attachments: [...atts, { id: uid(), url: file.url, name: file.name, path: file.path || "", size: file.size, type: file.type, label: invoiceLabel(doc), fileName: file.name, uploadedAt: now }], updatedAt: now };
  } else if (target === "remit") {
    if (rec.attachment?.url) throw new Error("That register entry already has an advice");
    next = { ...rec, attachment: { url: file.url, fileName: file.name, name: file.name, type: file.type || "", size: file.size || 0 } };
  } else {
    if (rec.docUrl) throw new Error("That purchase bill already has a document");
    next = { ...rec, docUrl: file.url, docExt: ext, updatedAt: now };
  }
  await withTimeout(saveK(key, list.map(x => x?.id === id ? next : x)), 20000, "Saving");
  return "attached";
}

function DocItem({ doc, onDone }) {
  const [pick, setPick] = useState(doc.matches?.[0] ? 0 : -1);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const f = doc.fields || {}, k = KIND[doc.kind] || KIND.bill;
  const approve = async () => {
    const m = doc.matches[pick];
    setBusy("approve"); setErr("");
    try {
      const r = await attachTo(m, doc.file, doc);
      await markRow(doc, { status: "approved", approved: { target: m.target, company: m.company, id: m.id, label: m.label } });
      onDone(doc.id, r === "already there" ? `Already on ${m.label}` : `Attached to ${m.label}`);
    } catch (e) { setErr(e.message); setBusy(""); }
  };
  const dismiss = async () => {
    setBusy("dismiss"); setErr("");
    try { await markRow(doc, { status: "dismissed" }); onDone(doc.id, "Dismissed"); } catch (e) { setErr(e.message); setBusy(""); }
  };
  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, background: C.card, padding: "9px 11px", marginTop: 8 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <span style={{ fontSize: 14 }}>{k.icon}</span>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: C.ink, flex: 1, minWidth: 140 }}>
          {f.vendor || f.party || doc.email?.from || k.label}{f.invoiceNo ? ` · ${f.invoiceNo}` : ""}
        </span>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: C.ink }}>{money(f.amount, f.currency)}</span>
      </div>
      <div style={{ fontSize: 11, color: C.inkMid, marginTop: 2 }}>
        {k.label}{doc.company && doc.kind === "bill" ? ` · billed to ${COMPANY[doc.company]}` : ""}{f.date ? ` · ${fmtDate(f.date)}` : ""}
        {" · "}<a href={doc.file?.url} target="_blank" rel="noreferrer" style={{ color: C.blue }}>{doc.file?.name || "document"} ↗</a>
        {doc.email?.url && <> · <a href={doc.email.url} target="_blank" rel="noreferrer" style={{ color: C.blue }}>email ↗</a></>}
      </div>
      {doc.matches?.length > 0 ? (
        <div style={{ marginTop: 6 }}>
          {doc.matches.map((m, i) => (
            <label key={`${m.target}:${m.id}`} style={{ display: "flex", gap: 7, alignItems: "flex-start", fontSize: 11.5, color: C.ink, padding: "3px 0", cursor: "pointer" }}>
              <input type="radio" checked={pick === i} onChange={() => setPick(i)} style={{ marginTop: 2 }} />
              <span><b>{TARGET[m.target]}</b>{m.company === "at" ? " (Atyahara)" : ""}: {m.label}<span style={{ color: C.inkFaint }}> — {m.why}</span></span>
            </label>
          ))}
        </div>
      ) : <div style={{ fontSize: 11, color: C.amber, marginTop: 5 }}>No match found in the books. Dismiss it, or attach it by hand from the entry's 📎.</div>}
      {err && <div style={{ fontSize: 11.5, color: C.red, marginTop: 5 }}>{err}</div>}
      <div style={{ display: "flex", gap: 6, marginTop: 7, justifyContent: "flex-end" }}>
        <button className="bs" disabled={!!busy} onClick={dismiss} style={{ fontSize: 11.5, padding: "5px 11px" }}>{busy === "dismiss" ? "…" : "Dismiss"}</button>
        <button className="bp" disabled={!!busy || pick < 0} onClick={approve} style={{ fontSize: 11.5, padding: "5px 11px" }}>{busy === "approve" ? "Attaching…" : "Approve"}</button>
      </div>
    </div>
  );
}

function MissingItem({ row, onDone }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const dismiss = async () => {
    setBusy(true); setErr("");
    try { await markRow(row, { status: "dismissed" }); onDone(row.id, "Dismissed"); } catch (e) { setErr(e.message); setBusy(false); }
  };
  return (
    <div style={{ border: `1px dashed ${C.border}`, borderRadius: 10, padding: "8px 11px", marginTop: 8 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <span style={{ fontSize: 14 }}>❓</span>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: C.ink, flex: 1, minWidth: 140 }}>{row.label}</span>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: C.ink }}>{money(row.amount, row.currency)}</span>
      </div>
      <div style={{ fontSize: 11, color: C.inkMid, marginTop: 2 }}>{TARGET[row.target]} · {row.date ? fmtDate(row.date) : "no date"} · no advice or FIRC attached</div>
      {err && <div style={{ fontSize: 11.5, color: C.red, marginTop: 5 }}>{err}</div>}
      {open && <div style={{ marginTop: 8 }}>
        <GmailFinder amount={row.amount} date={row.date} folder="finance-attachments/ng" pickLabel="Approve" onPick={async att => {
          const file = { url: att.url, name: att.name, type: att.type, size: att.size };
          await attachTo({ target: row.target, company: "ng", id: row.targetId }, file, { kind: "remittance", email: att.fromEmail ? { ...att.fromEmail } : null, file });
          await markRow(row, { status: "approved", approved: { target: row.target, id: row.targetId }, file });
          onDone(row.id, `Attached ${att.name}`);
        }} />
      </div>}
      <div style={{ display: "flex", gap: 6, marginTop: 7, justifyContent: "flex-end" }}>
        <button className="bs" disabled={busy} onClick={dismiss} style={{ fontSize: 11.5, padding: "5px 11px" }}>Dismiss</button>
        <button className="bp" disabled={busy} onClick={() => setOpen(o => !o)} style={{ fontSize: 11.5, padding: "5px 11px" }}>{open ? "Close" : "📧 Find in Gmail"}</button>
      </div>
    </div>
  );
}

export default function InboxCard() {
  const [data, setData] = useState(undefined);
  const [note, setNote] = useState("");
  const [scanning, setScanning] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const load = useCallback(() => readInbox().then(setData).catch(() => setData(null)), []);
  useEffect(() => { load(); }, [load]);
  if (data === undefined || data === null) return null;

  const pending = data.rows.filter(r => r.status === "pending");
  const docs = pending.filter(r => r.kind !== "missing").sort((a, b) => String(b.email?.date || "").localeCompare(String(a.email?.date || "")));
  const missing = pending.filter(r => r.kind === "missing").sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const scan = data.scan;
  const done = (id, msg) => { setData(d => ({ ...d, rows: d.rows.map(r => r.id === id ? { ...r, status: "done" } : r) })); setNote(msg); };
  const scanNow = async () => {
    setScanning(true); setNote("");
    try {
      const r = await fetch("/api/mail", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "gmail_scan", trigger: "manual", days: 3 }) });
      const d = await r.json().catch(() => ({}));
      setNote(r.ok ? `Scanned: ${d.read || 0} new document${d.read === 1 ? "" : "s"}${d.more ? `, ${d.more} more next run` : ""}` : (d.error || `Scan failed (${r.status})`));
    } catch (e) { setNote(e.message); }
    setScanning(false); load();
  };
  const when = scan?.at ? new Date(scan.at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "";
  const list = showAll ? docs : docs.slice(0, 5);
  const matched = docs.filter(d => d.matches?.length).length;

  return (
    <div style={{ background: `linear-gradient(135deg,#2F6B5A14,${C.surface} 65%)`, border: `1px solid ${C.border}`, borderRadius: 16, padding: mob() ? "14px 15px" : "16px 20px", marginBottom: 11 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 20 }}>📬</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .6 }}>This morning · from Gmail{when ? ` · scanned ${when}` : ""}</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.ink, marginTop: 2 }}>
            {docs.length || missing.length
              ? [docs.length && `${docs.length} document${docs.length > 1 ? "s" : ""} to approve${matched ? ` (${matched} with a match)` : ""}`, missing.length && `${missing.length} remittance${missing.length > 1 ? "s" : ""} without paperwork`].filter(Boolean).join(" · ")
              : "Nothing waiting on you."}
          </div>
        </div>
        <button className="bs" disabled={scanning} onClick={scanNow} style={{ fontSize: 11.5, padding: "5px 10px", flexShrink: 0 }}>{scanning ? "Scanning…" : "Scan now"}</button>
      </div>
      {scan?.notConfigured && <div style={{ fontSize: 12, color: C.amber, marginTop: 8 }}>Gmail isn't connected to the ERP yet, so there's no morning scan. Set up scripts/gmail-bridge.gs once (Sir only).</div>}
      {scan && !scan.notConfigured && scan.error && <div style={{ fontSize: 12, color: C.red, marginTop: 8 }}>Last scan had a problem: {scan.error}</div>}
      {note && <div style={{ fontSize: 12, color: C.green, marginTop: 8 }}>{note}</div>}
      {list.map(d => <DocItem key={d.id} doc={d} onDone={done} />)}
      {docs.length > 5 && <button className="bs" onClick={() => setShowAll(s => !s)} style={{ fontSize: 11.5, padding: "5px 10px", marginTop: 8 }}>{showAll ? "Show fewer" : `Show all ${docs.length}`}</button>}
      {missing.slice(0, showAll ? 50 : 3).map(r => <MissingItem key={r.id} row={r} onDone={done} />)}
    </div>
  );
}
