// Bill files: supplier bills from Purchases plus expense invoices (SAR, courier, freight,
// tickets…) attached to Finance entries — with the files themselves, as a list, cards or
// a thumbnail grid, and a zip download. Payment screenshots, Telegram photos and Gmail
// alert links are left out unless "Include photos" is on (Sir, 13 Nov 2026).
// Read-only — nothing here changes a record.
import { useState, useEffect, useMemo } from "react";
import { loadK, fmtDate, mob } from "./utils.js";
import { C, FI } from "./ui.jsx";
import { sbThumb } from "./photoUrls.js";

const CSYM = { INR: "₹", USD: "$", EUR: "€", GBP: "£", JPY: "¥", AUD: "A$" };
const money = (v, cur) => {
  const n = +v || 0, s = CSYM[cur || "INR"] || (cur ? cur + " " : "₹");
  return s + n.toLocaleString(cur && cur !== "INR" ? "en-US" : "en-IN", { maximumFractionDigits: 2 });
};
const TYPE_META = {
  Bill:    { label: "Supplier bill", color: C.red,    bg: C.redBg },
  Payment: { label: "Payment",     color: C.green,  bg: C.greenBg },
  Expense: { label: "Expense invoice",     color: C.purple, bg: C.purpleBg },
};
const VIEW_KEY = "ng-bills-files-view";

const extOf = f => {
  const e = (f.ext || "").toLowerCase();
  if (e) return e === "jpeg" ? "jpg" : e;
  const t = (f.type || "").toLowerCase();
  if (t.includes("pdf")) return "pdf";
  if (t.includes("png")) return "png";
  if (t.includes("webp")) return "webp";
  if (t.startsWith("image/")) return "jpg";
  const u = String(f.url || "");
  const m = u.startsWith("data:") ? u.match(/^data:[^/]+\/([a-z0-9+]+)/i) : u.split(/[?#]/)[0].match(/\.([a-z0-9]{2,5})$/i);
  const x = (m?.[1] || "").toLowerCase();
  return x === "jpeg" ? "jpg" : x || "bin";
};
const isLink = f => f.type === "email" || (f.ext || "") === "email" || /^https:\/\/mail\.google\.com\//.test(f.url || "");
const isImage = f => !isLink(f) && ["jpg", "png", "webp", "gif", "heic"].includes(extOf(f));
// An invoice is a PDF, or a file whose name says so. Photos and screenshots are not.
const isInvoiceFile = f => !isLink(f) && (extOf(f) === "pdf" || /inv|bill|tax|gst|receipt|challan/i.test(f.name || ""));
const dlCount = r => r.files.filter(f => !isLink(f)).length;

// One file list per record, whichever of the old/new shapes it uses.
const filesOf = (...srcs) => {
  const out = [], seen = new Set();
  for (const s of srcs) {
    if (!s) continue;
    const list = Array.isArray(s) ? s : [s];
    for (const f of list) {
      const g = typeof f === "string" ? { url: f } : f;
      if (!g?.url || seen.has(g.url)) continue;
      seen.add(g.url); out.push(g);
    }
  }
  return out;
};

const safe = s => String(s || "").replace(/[\\/:*?"<>|#%&{}$!'@+`=]/g, "-").replace(/\s+/g, " ").trim().slice(0, 50);

function buildRows(purchases, expenses, txns, withPhotos) {
  const rows = [];
  const txnById = new Map((txns || []).map(t => [t.id, t]));
  const keep = list => list.filter(f => !isLink(f) && (withPhotos || isInvoiceFile(f)));
  for (const p of purchases || []) {
    if (p.type !== "bill") continue;
    const files = filesOf(
      p.docUrl ? { url: p.docUrl, ext: p.docExt, name: p.billName } : p.docData ? { url: p.docData, name: p.billName } : null,
      p.attachments,
    );
    const due = (+p.totalAmount || 0) - (+p.paidAmount || 0);
    rows.push({ id: "b-" + p.id, type: "Bill", date: p.billDate || p.date || (p.createdAt || "").slice(0, 10), party: p.supplier || "", ref: p.billNumber || "", what: (p.items || []).map(i => i.desc || i.purchaseDesc).filter(Boolean).slice(0, 2).join(", "), amount: +p.totalAmount || 0, currency: p.currency || "INR", status: due > 0.5 ? "Unpaid " + money(due, p.currency) : "Paid", files });
  }
  const booked = new Set();
  for (const e of expenses || []) {
    const t = e.ledgerTxnId ? txnById.get(e.ledgerTxnId) : null;
    if (t) booked.add(t.id);
    const files = keep(filesOf(e.receipt ? { url: e.receipt, name: e.receiptName } : null, e.attachments, t?.attachments, t?.attachmentUrl ? { url: t.attachmentUrl, name: t.attachmentName } : null));
    if (files.length) rows.push({ id: "e-" + e.id, type: "Expense", date: e.date || "", party: e.party || t?.payee || "", ref: e.cat || "", what: e.notes || e.description || "", amount: +e.amount || 0, currency: e.currency || "INR", status: "Paid", files });
  }
  for (const t of txns || []) {
    if (booked.has(t.id) || t.type !== "debit" || ["vendor_bill", "vendor_po", "cc_payment", "customer_receipt"].includes(t.classifiedAs)) continue;
    const files = keep(filesOf(t.attachments, t.attachmentUrl ? { url: t.attachmentUrl, name: t.attachmentName } : null));
    if (files.length) rows.push({ id: "t-" + t.id, type: "Expense", date: t.date || "", party: t.payee || t.rawPayee || "", ref: t.category || "", what: t.notes || "", amount: +t.amount || 0, currency: t.currency || "INR", status: t.classifiedAs ? "Paid" : "Not booked yet", files });
  }
  return rows;
}

// Zip with the xlsx library the ERP already ships (its CFB writer makes real zips).
async function zipAndDownload(rows, zipName, onProgress) {
  const { CFB } = await import("xlsx");
  const zip = CFB.utils.cfb_new({ root: "R" });
  const jobs = [];
  const used = new Set();
  const links = [];
  for (const r of rows) r.files.forEach((f, i) => {
    if (isLink(f)) { links.push([r.date, TYPE_META[r.type].label, r.party, r.ref, f.url]); return; }
    const folder = r.type === "Bill" ? "Supplier bills" : r.type === "Payment" ? "Payments" : "Expense invoices";
    let base = [r.date || "no-date", safe(r.party) || "unknown", safe(r.ref)].filter(Boolean).join("_") + (r.files.length > 1 ? `_${i + 1}` : "");
    let name = `${folder}/${base}.${extOf(f)}`, n = 2;
    while (used.has(name)) name = `${folder}/${base}_${n++}.${extOf(f)}`;
    used.add(name);
    jobs.push({ name, url: f.url, row: r });
  });
  const failed = [];
  let done = 0;
  const worker = async () => {
    while (jobs.length) {
      const j = jobs.shift();
      try {
        const res = await fetch(j.url);
        if (!res.ok) throw new Error("HTTP " + res.status);
        CFB.utils.cfb_add(zip, j.name, new Uint8Array(await res.arrayBuffer()));
      } catch (e) { failed.push(`${j.name}  (${e.message})  ${j.url.startsWith("data:") ? "" : j.url}`); }
      onProgress(++done);
    }
  };
  const total = jobs.length;
  await Promise.all(Array.from({ length: Math.min(4, total) }, worker));
  const summary = ["Date,Type,Party,Ref,Amount,Currency,Status,Files",
    ...rows.map(r => [r.date, TYPE_META[r.type].label, r.party, r.ref, r.amount, r.currency, r.status, r.files.length].map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(","))].join("\n");
  CFB.utils.cfb_add(zip, "index.csv", new TextEncoder().encode(summary));
  if (links.length) CFB.utils.cfb_add(zip, "email-links.csv", new TextEncoder().encode(["Date,Type,Party,Ref,Gmail link", ...links.map(l => l.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(","))].join("\n")));
  if (failed.length) CFB.utils.cfb_add(zip, "could-not-download.txt", new TextEncoder().encode(failed.join("\n")));
  const bytes = CFB.write(zip, { fileType: "zip", type: "array", compression: false });
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/zip" }));
  const a = document.createElement("a"); a.href = url; a.download = zipName; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return { total, failed: failed.length };
}

const Thumb = ({ f, size }) => isLink(f)
  ? <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 2, color: C.inkMid, fontSize: size > 100 ? 30 : 18 }}>✉<span style={{ fontSize: 9, fontWeight: 700 }}>EMAIL</span></div>
  : isImage(f)
  ? <img src={sbThumb(f.url, size)} alt="" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
  : <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 2, color: C.inkMid, fontSize: size > 100 ? 30 : 18 }}>📄<span style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase" }}>{extOf(f)}</span></div>;

export default function BillsReceipts({ company, purchases, onOpenBill }) {
  const [view, setView] = useState(() => { try { return localStorage.getItem(VIEW_KEY) || (mob ? "cards" : "list"); } catch { return "list"; } });
  const [type, setType] = useState("all");
  const [fileF, setFileF] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(() => new Set());
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState("");
  const [preview, setPreview] = useState(null);

  const [expenses, setExpenses] = useState(null);
  const [txns, setTxns] = useState(null);
  const [withPhotos, setWithPhotos] = useState(false);
  useEffect(() => {
    setExpenses(null); setTxns(null); setSel(new Set());
    const co = company === "at" ? "at" : "ng";
    Promise.all([loadK(`${co}-expenses-v1`), loadK(`${co}-fin-txns-v1`)])
      .then(([e, t]) => { setExpenses(Array.isArray(e) ? e : []); setTxns(Array.isArray(t) ? t : []); })
      .catch(() => { setExpenses([]); setTxns([]); });
  }, [company]);
  useEffect(() => { try { localStorage.setItem(VIEW_KEY, view); } catch {} }, [view]);

  const all = useMemo(() => expenses && txns ? buildRows(purchases, expenses, txns, withPhotos) : [], [purchases, expenses, txns, withPhotos]);
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return all.filter(r =>
      (type === "all" || r.type === type) &&
      (fileF === "all" || (fileF === "has" ? r.files.length > 0 : r.files.length === 0)) &&
      (!from || (r.date || "").slice(0, 7) >= from) && (!to || (r.date || "").slice(0, 7) <= to) &&
      (!s || `${r.party} ${r.ref} ${r.what}`.toLowerCase().includes(s))
    ).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  }, [all, type, fileF, from, to, q]);

  const counts = useMemo(() => {
    const c = { all: all.length, Bill: 0, Payment: 0, Expense: 0, files: 0, missing: 0 };
    all.forEach(r => { c[r.type]++; c.files += r.files.length; if (!r.files.length) c.missing++; });
    return c;
  }, [all]);

  const selRows = rows.filter(r => sel.has(r.id));
  const dlRows = (selRows.length ? selRows : rows).filter(r => r.files.length);
  const dlFiles = dlRows.reduce((n, r) => n + dlCount(r), 0);
  const allTicked = rows.length > 0 && rows.every(r => sel.has(r.id));
  const toggle = id => setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const tickAll = () => setSel(allTicked ? new Set() : new Set(rows.map(r => r.id)));

  const download = async () => {
    if (!dlFiles || busy) return;
    if (dlFiles > 400 && !window.confirm(`${dlFiles} files is a big download. Continue?`)) return;
    setBusy({ done: 0, total: dlFiles }); setMsg("");
    try {
      const span = from || to ? `${from || "start"}_to_${to || "now"}` : new Date().toISOString().slice(0, 10);
      const r = await zipAndDownload(dlRows, `${company === "at" ? "Atyahara" : "NikhilGems"}_supplier-bills_${span}.zip`, done => setBusy({ done, total: dlFiles }));
      setMsg(r.failed ? `Zip saved. ${r.failed} of ${r.total} files couldn't be fetched; they're listed in could-not-download.txt inside it.` : `Zip saved with ${r.total} files and an index.csv.`);
    } catch (e) { setMsg("Download failed: " + e.message); }
    setBusy(null);
  };

  if (!expenses || !txns) return <p style={{ color: C.inkFaint, textAlign: "center", paddingTop: 40, fontSize: 13 }}>Loading bills…</p>;

  const seg = (opts, val, set) => (
    <div style={{ display: "flex", gap: 1, background: C.card, borderRadius: 6, padding: 3, border: `1px solid ${C.border}`, flexWrap: "wrap" }}>
      {opts.map(([id, label]) => (
        <button key={id} onClick={() => set(id)} style={{ background: val === id ? C.surface : "transparent", color: val === id ? C.ink : C.inkMid, border: val === id ? `1px solid ${C.border}` : "1px solid transparent", borderRadius: 4, padding: "5px 11px", cursor: "pointer", fontSize: 12, fontWeight: val === id ? 600 : 400, whiteSpace: "nowrap" }}>{label}</button>
      ))}
    </div>
  );
  const Badge = ({ t }) => <span style={{ fontSize: 10, fontWeight: 700, color: TYPE_META[t].color, background: TYPE_META[t].bg, borderRadius: 4, padding: "2px 7px", whiteSpace: "nowrap" }}>{TYPE_META[t].label}</span>;
  const FileLinks = ({ r }) => r.files.length
    ? <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>{r.files.map((f, i) => (
        isLink(f)
          ? <a key={i} href={f.url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} title="Open the email in Gmail" style={{ color: C.blue, fontSize: 12, textDecoration: "none" }}>✉</a>
          : <button key={i} onClick={e => { e.stopPropagation(); setPreview({ r, i }); }} title={f.name || "Open file"} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: C.blue, fontSize: 12 }}>📎{r.files.length > 1 ? i + 1 : ""}</button>
      ))}</span>
    : <span style={{ fontSize: 11, color: C.amber }}>No file</span>;
  const Check = ({ r }) => <input type="checkbox" checked={sel.has(r.id)} onChange={() => toggle(r.id)} onClick={e => e.stopPropagation()} style={{ width: 16, height: 16, cursor: "pointer", accentColor: C.gold, flexShrink: 0 }} />;
  const openRow = r => { if (r.type === "Bill" && onOpenBill) onOpenBill(r.id.slice(2)); else if (r.files.length) setPreview({ r, i: 0 }); };
  const card = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8 };

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: mob ? "repeat(2,1fr)" : "repeat(4,1fr)", gap: 10, marginBottom: 14 }}>
        {[[counts.Bill, "Supplier bills"], [counts.missing, "Supplier bills without a scan"], [counts.Expense, "Expense invoices"], [counts.files, "Files"]].map(([v, l]) => (
          <div key={l} style={{ ...card, borderRadius: 9, padding: "10px 14px" }}>
            <div style={{ fontSize: 9, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .5 }}>{l}</div>
            <div style={{ fontSize: 20, fontWeight: 600, color: C.ink, marginTop: 2 }}>{v}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
        {seg([["all", "All"], ["Bill", "Supplier bills"], ["Expense", "Expense invoices"]], type, setType)}
        {seg([["all", "Any"], ["has", "With file"], ["missing", "Missing file"]], fileF, setFileF)}
        <label title="Also show payment screenshots and photos sent from Telegram" style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: C.inkMid, cursor: "pointer" }}><input type="checkbox" checked={withPhotos} onChange={e => setWithPhotos(e.target.checked)} style={{ accentColor: C.gold }} />Include photos</label>
        <div style={{ marginLeft: mob ? 0 : "auto" }}>{seg([["list", "☰ List"], ["cards", "▤ Cards"], ["grid", "▦ Grid"]], view, setView)}</div>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search supplier, bill no., item…" style={{ ...FI, flex: "1 1 200px", minWidth: 0, fontSize: 12, padding: "7px 10px" }} />
        <label style={{ fontSize: 11, color: C.inkMid, display: "flex", alignItems: "center", gap: 4 }}>From <input type="month" value={from} onChange={e => setFrom(e.target.value)} style={{ ...FI, width: "auto", fontSize: 12, padding: "5px 8px" }} /></label>
        <label style={{ fontSize: 11, color: C.inkMid, display: "flex", alignItems: "center", gap: 4 }}>To <input type="month" value={to} onChange={e => setTo(e.target.value)} style={{ ...FI, width: "auto", fontSize: 12, padding: "5px 8px" }} /></label>
        {(from || to || q || type !== "all" || fileF !== "all") && <button className="bs" style={{ fontSize: 11 }} onClick={() => { setFrom(""); setTo(""); setQ(""); setType("all"); setFileF("all"); }}>Clear</button>}
      </div>

      <div style={{ ...card, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "8px 12px", marginBottom: 12, position: "sticky", top: 0, zIndex: 2 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.inkMid, cursor: "pointer" }}>
          <input type="checkbox" checked={allTicked} onChange={tickAll} style={{ width: 16, height: 16, accentColor: C.gold }} />
          {sel.size ? `${selRows.length} ticked` : `${rows.length} shown`}
        </label>
        {sel.size > 0 && <button className="bs" style={{ fontSize: 11 }} onClick={() => setSel(new Set())}>Untick all</button>}
        <button className="bp" style={{ fontSize: 12, marginLeft: "auto", opacity: dlFiles && !busy ? 1 : .5 }} disabled={!dlFiles || !!busy} onClick={download}>
          {busy ? `Zipping ${busy.done}/${busy.total}…` : `⬇ Download ${dlFiles} file${dlFiles === 1 ? "" : "s"} (${sel.size ? "ticked" : "everything shown"})`}
        </button>
      </div>
      {msg && <div style={{ fontSize: 12, color: C.inkMid, marginBottom: 10 }}>{msg}</div>}

      {rows.length === 0 && <div style={{ ...card, padding: "40px 0", textAlign: "center", color: C.inkFaint, fontSize: 13 }}>Nothing matches these filters.</div>}

      {rows.length > 0 && view === "list" && (mob ? null : (
        <div style={{ ...card, borderRadius: 9, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "28px 92px 84px 1.4fr 1fr 110px 120px 80px", gap: 8, padding: "8px 12px", background: C.card, borderBottom: `1px solid ${C.border}` }}>
            {["", "Type", "Date", "Supplier", "Bill no. / category", "Amount", "Status", "Files"].map(h => <div key={h} style={{ fontSize: 9, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .4 }}>{h}</div>)}
          </div>
          {rows.map(r => (
            <div key={r.id} onClick={() => openRow(r)} style={{ display: "grid", gridTemplateColumns: "28px 92px 84px 1.4fr 1fr 110px 120px 80px", gap: 8, padding: "8px 12px", borderBottom: `1px solid ${C.border}`, alignItems: "center", cursor: "pointer", fontSize: 12, background: sel.has(r.id) ? C.card : "transparent" }}>
              <Check r={r} /><Badge t={r.type} />
              <div style={{ color: C.inkMid }}>{r.date ? fmtDate(r.date) : "—"}</div>
              <div style={{ color: C.ink, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.what}>{r.party || "—"}</div>
              <div style={{ color: C.inkMid, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.ref || "—"}</div>
              <div style={{ color: C.ink, fontVariantNumeric: "tabular-nums" }}>{money(r.amount, r.currency)}</div>
              <div style={{ fontSize: 11, color: /Unpaid|Not booked/.test(r.status) ? C.red : C.inkMid }}>{r.status || "—"}</div>
              <FileLinks r={r} />
            </div>
          ))}
        </div>
      ))}

      {rows.length > 0 && (view === "cards" || (view === "list" && mob)) && (
        <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr" : "repeat(auto-fill,minmax(300px,1fr))", gap: 8 }}>
          {rows.map(r => (
            <div key={r.id} onClick={() => openRow(r)} style={{ ...card, padding: 10, display: "flex", gap: 10, cursor: "pointer", outline: sel.has(r.id) ? `2px solid ${C.gold}` : "none" }}>
              <div style={{ width: 64, height: 64, borderRadius: 6, overflow: "hidden", background: C.card, flexShrink: 0, border: `1px solid ${C.border}` }}>
                {r.files[0] ? <Thumb f={r.files[0]} size={200} /> : <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: C.amber, textAlign: "center" }}>No file</div>}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 6, alignItems: "flex-start" }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.party || "—"}</div>
                  <Check r={r} />
                </div>
                <div style={{ fontSize: 11, color: C.inkMid, margin: "2px 0 5px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.date ? fmtDate(r.date) : "—"} · {r.ref || "—"}</div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <Badge t={r.type} />
                  <span style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>{money(r.amount, r.currency)}</span>
                  <span style={{ marginLeft: "auto" }}><FileLinks r={r} /></span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {rows.length > 0 && view === "grid" && (
        <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill,minmax(${mob ? 140 : 170}px,1fr))`, gap: 10 }}>
          {rows.map(r => (
            <div key={r.id} onClick={() => r.files.length ? setPreview({ r, i: 0 }) : openRow(r)} style={{ ...card, overflow: "hidden", cursor: "pointer", outline: sel.has(r.id) ? `2px solid ${C.gold}` : "none", position: "relative" }}>
              <div style={{ aspectRatio: "1 / 1", background: C.card, borderBottom: `1px solid ${C.border}` }}>
                {r.files[0] ? <Thumb f={r.files[0]} size={400} /> : <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: C.amber }}>No file</div>}
              </div>
              <div style={{ position: "absolute", top: 6, left: 6, background: C.surface, borderRadius: 4, padding: 2, display: "flex" }}><Check r={r} /></div>
              {r.files.length > 1 && <div style={{ position: "absolute", top: 6, right: 6, background: "rgba(0,0,0,.6)", color: "#fff", borderRadius: 10, fontSize: 10, fontWeight: 700, padding: "2px 7px" }}>{r.files.length}</div>}
              <div style={{ padding: "6px 8px" }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.party || "—"}</div>
                <div style={{ fontSize: 10, color: C.inkMid, display: "flex", justifyContent: "space-between", gap: 4 }}><span>{r.date ? fmtDate(r.date) : "—"}</span><span>{money(r.amount, r.currency)}</span></div>
                <div style={{ marginTop: 4 }}><Badge t={r.type} /></div>
              </div>
            </div>
          ))}
        </div>
      )}

      {preview && (() => {
        const { r, i } = preview, f = r.files[i];
        return (
          <div onClick={() => setPreview(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.75)", zIndex: 1000, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 16 }}>
            <div onClick={e => e.stopPropagation()} style={{ background: C.surface, borderRadius: 10, maxWidth: 900, width: "100%", maxHeight: "92vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderBottom: `1px solid ${C.border}`, flexWrap: "wrap" }}>
                <Badge t={r.type} />
                <div style={{ fontWeight: 600, fontSize: 13, color: C.ink, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.party || "—"} · {r.ref || ""} · {money(r.amount, r.currency)}</div>
                {r.files.length > 1 && <span style={{ fontSize: 11, color: C.inkMid }}>
                  <button className="bs" style={{ fontSize: 11, padding: "2px 8px" }} disabled={i === 0} onClick={() => setPreview({ r, i: i - 1 })}>‹</button> {i + 1}/{r.files.length} <button className="bs" style={{ fontSize: 11, padding: "2px 8px" }} disabled={i === r.files.length - 1} onClick={() => setPreview({ r, i: i + 1 })}>›</button>
                </span>}
                {!isLink(f) && <a href={f.url} target="_blank" rel="noreferrer" download={f.url.startsWith("data:") ? `${safe(r.party)}.${extOf(f)}` : undefined} className="bs" style={{ fontSize: 11, textDecoration: "none" }}>Open / save</a>}
                {r.type === "Bill" && onOpenBill && <button className="bs" style={{ fontSize: 11 }} onClick={() => { setPreview(null); onOpenBill(r.id.slice(2)); }}>Open bill</button>}
                <button className="bs" style={{ fontSize: 11 }} onClick={() => setPreview(null)}>Close</button>
              </div>
              <div style={{ flex: 1, minHeight: 0, overflow: "auto", background: C.card, display: "flex", alignItems: "center", justifyContent: "center" }}>
                {isLink(f)
                  ? <a href={f.url} target="_blank" rel="noreferrer" style={{ padding: 40, color: C.blue }}>✉ Open this email in Gmail</a>
                  : isImage(f)
                  ? <img src={f.url} alt="" style={{ maxWidth: "100%", maxHeight: "80vh", objectFit: "contain" }} />
                  : extOf(f) === "pdf"
                    ? <iframe title="file" src={f.url} style={{ width: "100%", height: "80vh", border: "none" }} />
                    : <a href={f.url} target="_blank" rel="noreferrer" style={{ padding: 40, color: C.blue }}>Open {f.name || "file"}</a>}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
