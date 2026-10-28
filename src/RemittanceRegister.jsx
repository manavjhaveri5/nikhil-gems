import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { C, FI } from "./ui.jsx";
import { mob, fmtDate, loadK, loadKFresh, saveK, onCacheRefresh, upsertVersionedItemK } from "./utils.js";
import { uploadToStorage } from "./storageUtils.js";
import { isRemittanceAdvice, parseRemittanceAdvice, linesFromTextItems } from "./remittanceAdvice.js";
import {
  NG_REMIT_KEY, invRemitLinks, withRemitLink, withoutRemitLink, ngRemitMissing, ngRemitSettlement,
  isInwardCredit, matchLedgerCredit, ngKeys, remitFromAdvice, remitFromLedgerCredit, isEefc,
} from "./remittances.js";
import { monthOf, monthLabel } from "./monthClose.js";
import { bookRemittanceFees, feesBooked } from "./remittanceFees.js";

/* Nikhil Gems' inward remittance register (Export Recon → Remittances).
   One row per foreign payment received at Bank of India, with everything the
   bank and the accountant need: foreign amount, rate, INR credited, charges,
   buyer, and the invoices (and so shipping bills) it settles — or a mark that it
   is an advance against a shipment still to go. A BOI advice PDF is read off its
   text layer exactly (remittanceAdvice.js); anything else falls back to AI.
   Credits on the BOI accounts that nobody has entered here are listed on top,
   one click from becoming an entry. */

const INV_KEY = "ng-invoices-v2", BUYERS_KEY = "ng-buyers-v2";
const TXN_KEY = "ng-fin-txns-v1", ACC_KEY = "ng-fin-accounts-v1";
const uid = () => Math.random().toString(36).slice(2, 10);
const f2 = (n, cur) => (n == null || n === "" ? "—" : `${cur ? `${cur} ` : ""}${(+n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const inr = n => (n == null || n === "" ? "—" : `₹${(+n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const numOrNull = v => (v === "" || v == null ? null : +String(v).replace(/,/g, ""));

async function pdfText(file) {
  const pdfjsLib = await import("pdfjs-dist");
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  let text = "";
  for (let p = 1; p <= Math.min(pdf.numPages, 3); p++) text += linesFromTextItems((await (await pdf.getPage(p)).getTextContent()).items) + "\n";
  return text;
}
const readB64 = file => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => { const [meta, data] = String(r.result).split(","); res({ b64: data, mime: meta.match(/:(.*?);/)?.[1] || "application/pdf" }); }; r.onerror = rej; r.readAsDataURL(file); });

function Pill({ tone = "amber", children, title }) {
  const t = { green: [C.green, C.greenBg], amber: [C.amber, C.amberBg], red: [C.red, C.redBg], grey: [C.inkMid, C.card], blue: [C.blue, C.blueBg] }[tone];
  return <span title={title} style={{ display: "inline-block", fontSize: 10.5, fontWeight: 800, color: t[0], background: t[1], borderRadius: 999, padding: "2px 8px", whiteSpace: "nowrap" }}>{children}</span>;
}

function Editor({ rem, invoices, buyers, ledgerTxn, onSave, onDelete, onLink, onUnlink, onClose, busy }) {
  const [v, setV] = useState(rem);
  useEffect(() => { setV(rem); }, [rem.id]);
  const set = (k, val) => setV(x => ({ ...x, [k]: val }));
  const eefc = isEefc(v);
  const settle = ngRemitSettlement(v, invoices);
  const missing = ngRemitMissing(v);
  const cur = String(v.currency || "").toUpperCase();
  const buyerOf = inv => buyers.find(b => b.id === inv.buyerId)?.name || inv.buyerName || inv.buyer || "";
  const linkable = invoices
    .filter(i => (i.type || "commercial") !== "proforma" && String(i.status || "").toLowerCase() !== "cancelled")
    .filter(i => !cur || String(i.currency || "").toUpperCase() === cur)
    .filter(i => !invRemitLinks(i).some(l => l.id === v.id))
    .map(i => ({ inv: i, due: Math.max(0, (+i.totalAmt || 0) - invRemitLinks(i).reduce((s, l) => s + (+l.alloc || 0), 0)) }))
    .filter(x => x.due > 0.01)
    .sort((a, b) => (buyerOf(a.inv) === (v.buyer || v.remitter) ? -1 : 0) - (buyerOf(b.inv) === (v.buyer || v.remitter) ? -1 : 0) || String(b.inv.date || "").localeCompare(String(a.inv.date || "")));
  const [pick, setPick] = useState("");
  const [pickAmt, setPickAmt] = useState("");
  useEffect(() => {
    const x = linkable.find(l => l.inv.id === pick);
    if (x) setPickAmt(String(+Math.min(x.due, settle.unallocated || x.due).toFixed(2)));
  }, [pick]);
  const gross = !eefc && +v.amount > 0 && +v.rate > 0 ? +v.amount * +v.rate : null;
  const inp = { ...FI, fontSize: 12.5, padding: "7px 9px" };
  const field = (label, k, type = "text", extra = {}) => (
    <label style={{ display: "grid", gap: 3 }}>
      <span style={{ fontSize: 10, fontWeight: 800, color: missing.some(m => m.toLowerCase().startsWith(label.toLowerCase().split(" ")[0].toLowerCase())) ? C.amber : C.inkFaint, textTransform: "uppercase", letterSpacing: .4 }}>{label}</span>
      <input type={type} value={v[k] ?? ""} onChange={e => set(k, e.target.value)} style={inp} {...extra} />
    </label>
  );
  return (
    <div onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }} style={{ position: "fixed", inset: 0, zIndex: 4000, background: "rgba(0,0,0,.4)", display: "flex", alignItems: mob ? "stretch" : "center", justifyContent: "center", padding: mob ? 0 : 20 }}>
      <div onMouseDown={e => e.stopPropagation()} style={{ width: mob ? "100%" : 820, maxWidth: "100%", maxHeight: mob ? "100%" : "calc(100vh - 40px)", overflow: "auto", background: C.surface, borderRadius: mob ? 0 : 14, boxShadow: "0 24px 70px rgba(0,0,0,.3)", padding: mob ? 16 : 20, display: "grid", gap: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 850, color: C.ink }}>💵 {v.irt || "New remittance"}</div>
            <div style={{ fontSize: 12, color: C.inkFaint, marginTop: 2 }}>
              {missing.length ? <span style={{ color: C.amber, fontWeight: 700 }}>Missing: {missing.join(", ")}</span> : <span style={{ color: C.green, fontWeight: 700 }}>All details entered</span>}
              {v.attachment?.url && <> · <a href={v.attachment.url} target="_blank" rel="noreferrer" style={{ color: C.blue }}>advice ↗</a></>}
            </div>
          </div>
          <button onClick={onClose} disabled={busy} style={{ background: "none", border: "none", fontSize: 22, cursor: "pointer", color: C.inkFaint, lineHeight: 1 }}>×</button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr 1fr" : "repeat(4, minmax(0,1fr))", gap: 10 }}>
          {field("IRT / reference", "irt")}
          {field("Date", "date", "date")}
          <label style={{ display: "grid", gap: 3 }}>
            <span style={{ fontSize: 10, fontWeight: 800, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .4 }}>Credited as</span>
            <select value={v.settlement || "converted"} onChange={e => set("settlement", e.target.value)} style={{ ...inp, cursor: "pointer" }}>
              <option value="converted">Converted to INR</option>
              <option value="eefc">Kept in EEFC</option>
            </select>
          </label>
          {field("Currency", "currency", "text", { placeholder: "USD" })}
          {field("Foreign amount", "amount", "number", { step: "0.01" })}
          {!eefc && field("Rate", "rate", "number", { step: "0.0001" })}
          {!eefc && field("INR credited", "inrCredited", "number", { step: "0.01" })}
          {field(`Charges (${v.chargeCurrency || "INR"})`, "charges", "number", { step: "0.01", placeholder: "0 if none" })}
          {field("Remitter", "remitter")}
          {field("Buyer", "buyer")}
          {field("Purpose", "purpose")}
        </div>
        {gross != null && (
          <div style={{ fontSize: 11.5, color: C.inkMid, marginTop: -6 }}>
            {cur} {f2(v.amount)} @ {v.rate} = {inr(gross)} gross
            {+v.inrCredited > 0 && <> · credited {inr(v.inrCredited)} · charges {inr(gross - +v.inrCredited)}</>}
            {+v.inrCredited > 0 && v.charges !== "" && v.charges != null && Math.abs(gross - +v.inrCredited - +v.charges) > 1 && <b style={{ color: C.amber }}> — charges entered as {inr(v.charges)}; check the advice</b>}
          </div>
        )}

        <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
          <div style={{ padding: "9px 12px", background: C.card, display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
            <div style={{ fontSize: 12.5, fontWeight: 850, color: C.ink }}>Settles</div>
            <div style={{ fontSize: 11.5, color: C.inkMid }}>
              {cur} {f2(settle.allocated)} of {f2(v.amount)} tied to invoices
              {settle.unallocated > 0.01 && <> · <b style={{ color: v.advance ? C.blue : C.amber }}>{cur} {f2(settle.unallocated)} {v.advance ? "held as advance" : "not tied yet"}</b></>}
              {settle.over && <b style={{ color: C.red }}> · more allocated than received</b>}
            </div>
          </div>
          {settle.allocs.map(({ inv, alloc }) => (
            <div key={inv.id} style={{ display: "grid", gridTemplateColumns: mob ? "1fr auto" : "minmax(0,1fr) 160px 130px auto", gap: 10, alignItems: "center", padding: "8px 12px", borderTop: `1px solid ${C.border}` }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 800, color: C.ink }}>{inv.invNo}</div>
                <div style={{ fontSize: 11, color: C.inkFaint }}>{buyerOf(inv)} · {fmtDate(inv.date)} · {inv.currency} {f2(inv.totalAmt)}</div>
              </div>
              {!mob && <div style={{ fontSize: 11.5, color: inv.sbNo ? C.ink : C.amber }}>{inv.sbNo ? `SB ${inv.sbNo}` : "No shipping bill yet"}</div>}
              <div style={{ fontSize: 12.5, fontWeight: 850, color: C.ink, textAlign: "right" }}>{cur} {f2(alloc)}</div>
              <button className="bs" disabled={busy} style={{ fontSize: 11, padding: "3px 9px" }} onClick={() => onUnlink(inv)}>Unlink</button>
            </div>
          ))}
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "9px 12px", borderTop: `1px solid ${C.border}` }}>
            <select value={pick} onChange={e => setPick(e.target.value)} style={{ ...inp, width: mob ? "100%" : 330, cursor: "pointer" }} disabled={!rem.id || busy}>
              <option value="">{linkable.length ? `Link an invoice${cur ? ` in ${cur}` : ""}…` : `No open ${cur || ""} invoices to link`}</option>
              {linkable.map(({ inv, due }) => <option key={inv.id} value={inv.id}>{inv.invNo} · {buyerOf(inv)} · {inv.currency} {f2(due)} due{inv.sbNo ? ` · SB ${inv.sbNo}` : ""}</option>)}
            </select>
            <input type="number" step="0.01" value={pickAmt} onChange={e => setPickAmt(e.target.value)} placeholder="Amount" style={{ ...inp, width: 120 }} disabled={!pick} />
            <button className="bp" style={{ fontSize: 11.5, padding: "6px 12px" }} disabled={!pick || !(+pickAmt > 0) || busy}
              onClick={async () => { const x = linkable.find(l => l.inv.id === pick); if (x) { await onLink(x.inv, +pickAmt, v); setPick(""); setPickAmt(""); } }}>Link</button>
          </div>
          <label style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "9px 12px", borderTop: `1px solid ${C.border}`, cursor: "pointer", background: v.advance ? C.blueBg : "transparent" }}>
            <input type="checkbox" checked={!!v.advance} onChange={e => set("advance", e.target.checked)} style={{ marginTop: 2 }} />
            <div style={{ display: "grid", gap: 6, flex: 1 }}>
              <span style={{ fontSize: 12.5, fontWeight: 800, color: C.ink }}>Advance against a future shipment{settle.allocs.length ? " (the part not tied to an invoice)" : ""}</span>
              {v.advance && (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }} onClick={e => e.preventDefault()}>
                  <input type="date" value={v.expectedShipDate || ""} onChange={e => set("expectedShipDate", e.target.value)} style={{ ...inp, width: 160 }} title="Expected shipping date" />
                  <input value={v.advanceNote || ""} onChange={e => set("advanceNote", e.target.value)} placeholder="Which order / proforma it is for" style={{ ...inp, flex: 1, minWidth: 200 }} />
                </div>
              )}
            </div>
          </label>
        </div>

        <div style={{ fontSize: 12, color: C.inkMid, background: C.card, borderRadius: 9, padding: "9px 12px" }}>
          <b style={{ color: C.ink }}>Bank ledger: </b>
          {ledgerTxn
            ? <>credit of {(ledgerTxn.currency || "INR") === "INR" ? inr(ledgerTxn.amount) : f2(ledgerTxn.amount, ledgerTxn.currency)} on {fmtDate(ledgerTxn.date)} · {ledgerTxn.payee}</>
            : <span style={{ color: C.amber }}>no matching credit found on the BOI accounts — import the statement in Finance → Reconcile, or check the amount and date.</span>}
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          {!rem._new ? <button onClick={() => onDelete(rem)} disabled={busy} style={{ background: "none", border: `1px solid ${C.red}`, color: C.red, borderRadius: 8, padding: "8px 13px", cursor: "pointer", fontSize: 12 }}>Delete</button> : <span />}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="bs" onClick={onClose} disabled={busy}>Close</button>
            <button className="bp" disabled={busy} onClick={() => onSave({
              ...v, currency: cur, amount: numOrNull(v.amount), rate: eefc ? null : numOrNull(v.rate),
              inrCredited: eefc ? null : numOrNull(v.inrCredited), charges: numOrNull(v.charges),
            })}>{busy ? "Saving…" : "Save"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function RemittanceRegister({ aiExtract, isUnclassified = t => !t.classifiedAs, onChange }) {
  const [remits, setRemits] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [buyers, setBuyers] = useState([]);
  const [txns, setTxns] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [month, setMonth] = useState("all");
  const [editing, setEditing] = useState(null); // a remittance record (new ones have no createdAt yet)
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const fileRef = useRef(null);

  const reload = useCallback(() => {
    Promise.all([loadK(NG_REMIT_KEY), loadK(INV_KEY), loadK(BUYERS_KEY), loadK(TXN_KEY), loadK(ACC_KEY)]).then(([r, i, b, t, a]) => {
      setRemits(Array.isArray(r) ? r : []); setInvoices(Array.isArray(i) ? i : []); setBuyers(Array.isArray(b) ? b : []);
      setTxns(Array.isArray(t) ? t : []); setAccounts(Array.isArray(a) ? a : []);
    });
  }, []);
  useEffect(() => { reload(); }, [reload]);
  // A screen hosting the register (Accounting) keeps its own counts; tell it what changed.
  useEffect(() => { onChange?.({ remits, invoices }); }, [remits, invoices]);
  useEffect(() => onCacheRefresh(keys => { if ([NG_REMIT_KEY, INV_KEY, TXN_KEY, ACC_KEY].some(k => keys.includes(k))) reload(); }), [reload]);
  useEffect(() => { if (!msg) return; const t = setTimeout(() => setMsg(null), 6000); return () => clearTimeout(t); }, [msg]);

  const accById = useMemo(() => new Map(accounts.map(a => [a.id, a])), [accounts]);
  const credits = useMemo(() => txns.filter(t => isInwardCredit(t, accById.get(t.accountTo))), [txns, accById]);
  // Each remittance's ledger credit, matched once (a credit can't serve two entries).
  const ledgerOf = useMemo(() => {
    const used = new Set(), out = new Map();
    [...remits].sort((a, b) => String(a.date || "").localeCompare(String(b.date || ""))).forEach(r => {
      const hit = matchLedgerCredit(credits.filter(t => !used.has(t.id)), ngKeys(r));
      if (hit) { used.add(hit.id); out.set(r.id, hit); }
    });
    return { out, used };
  }, [remits, credits]);
  const unentered = credits.filter(t => !ledgerOf.used.has(t.id) && (month === "all" || monthOf(t.date) === month))
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  const months = [...new Set([...remits.map(r => monthOf(r.date)), ...credits.map(t => monthOf(t.date))].filter(Boolean))].sort().reverse();
  const shown = remits.filter(r => month === "all" || monthOf(r.date) === month)
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));

  const saveRemit = async rec => {
    const next = [rec, ...remits.filter(r => r.id !== rec.id)];
    setRemits(next);
    await saveK(NG_REMIT_KEY, next);
  };
  const patchInvoice = async (invId, fn) => {
    const fresh = await loadKFresh(INV_KEY);
    const latest = (Array.isArray(fresh) ? fresh : invoices).find(x => x.id === invId);
    if (!latest) throw new Error("Invoice not found — it may have been deleted");
    const list = await upsertVersionedItemK(INV_KEY, fn(latest), { user: "Admin" });
    setInvoices(Array.isArray(list) && list.length ? list : invoices.map(i => i.id === invId ? fn(i) : i));
  };
  const run = async (fn, ok) => {
    setBusy(true); setMsg(null);
    try { await fn(); if (ok) setMsg({ ok: true, text: ok }); }
    catch (e) { setMsg({ ok: false, text: e?.message || "Something went wrong — check connection" }); }
    finally { setBusy(false); }
  };

  const startNew = seed => setEditing({ id: uid(), irt: "", date: "", currency: "USD", amount: "", settlement: "converted", rate: "", inrCredited: "", charges: "", chargeCurrency: "INR", remitter: "", buyer: "", purpose: "", advance: false, closed: false, ...seed, _new: true });

  const onUpload = async e => {
    const file = e.target.files?.[0]; e.target.value = "";
    if (!file) return;
    await run(async () => {
      let fields = null;
      if (/pdf/i.test(file.type) || /\.pdf$/i.test(file.name)) {
        try { const text = await pdfText(file); if (isRemittanceAdvice(text)) fields = remitFromAdvice(parseRemittanceAdvice(text)); } catch { /* scanned or locked PDF — fall back to AI */ }
      }
      if (!fields && aiExtract) {
        try {
          const { b64, mime } = await readB64(file);
          const ex = await aiExtract(b64, "inward", mime) || {};
          fields = { irt: String(ex.irt || "").trim(), currency: String(ex.currency || "").toUpperCase(), amount: +String(ex.amount || "").replace(/[^\d.]/g, "") || null, buyer: String(ex.buyer || "").trim(), remitter: String(ex.buyer || "").trim(), dateRaw: ex.dateRaw || "", source: "ai" };
        } catch { fields = {}; }
      }
      let attachment = null;
      try {
        const safe = (file.name || "remittance").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90) || "remittance";
        const url = await uploadToStorage(`invoice-shipment-docs/ng/remittances/${Date.now()}-${uid()}-${safe}`, file);
        attachment = { url, fileName: file.name, name: file.name, type: file.type || "", size: file.size || 0 };
      } catch { /* keep the details even if the file couldn't be stored */ }
      const dup = fields?.irt && remits.find(r => String(r.irt || "").toUpperCase() === fields.irt.toUpperCase());
      if (dup) {
        const merged = { ...dup };
        Object.entries(fields).forEach(([k, val]) => { if ((merged[k] == null || merged[k] === "") && val != null && val !== "") merged[k] = val; });
        if (attachment && !merged.attachment?.url) merged.attachment = attachment;
        await saveRemit(merged); setEditing(merged);
      } else {
        startNew({ ...(fields || {}), ...(attachment ? { attachment } : {}) });
      }
    }, null);
    setMsg(m => m || { ok: true, text: "Advice read — check the details, then Save." });
  };

  const editingLedger = editing ? (ledgerOf.out.get(editing.id) || matchLedgerCredit(credits.filter(t => !ledgerOf.used.has(t.id)), ngKeys(editing))) : null;
  const th = { textAlign: "left", fontSize: 10, fontWeight: 800, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .4, padding: "8px 10px", whiteSpace: "nowrap" };
  const td = { padding: "9px 10px", fontSize: 12.5, color: C.ink, borderTop: `1px solid ${C.border}`, verticalAlign: "top" };

  return (
    <div>
      <input ref={fileRef} type="file" accept="application/pdf,image/*" style={{ display: "none" }} onChange={onUpload} />
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 19, fontWeight: 700, color: C.ink, letterSpacing: "-.01em" }}>Remittances</div>
          <div style={{ fontSize: 12, color: C.inkFaint, marginTop: 2, maxWidth: 640 }}>Every foreign payment received at Bank of India — foreign amount, rate, INR credited, charges, buyer, and the invoices and shipping bills it settles, or an advance against a shipment still to go.</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <select value={month} onChange={e => setMonth(e.target.value)} style={{ ...FI, width: 170, fontSize: 12, padding: "7px 9px", cursor: "pointer" }}>
            <option value="all">All months</option>
            {months.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </select>
          <button className="bs" style={{ fontSize: 12 }} disabled={busy} onClick={() => startNew({})}>+ Add by hand</button>
          <button className="bp" style={{ fontSize: 12 }} disabled={busy} onClick={() => fileRef.current?.click()}>{busy ? "Reading…" : "⬆ Upload BOI advice"}</button>
        </div>
      </div>
      {msg && <div style={{ background: msg.ok ? C.greenBg : C.redBg, color: msg.ok ? C.green : C.red, borderRadius: 9, padding: "8px 12px", fontSize: 12.5, fontWeight: 700, marginBottom: 12 }}>{msg.text}</div>}

      {unentered.length > 0 && (
        <div style={{ border: `1px solid ${C.amber}`, borderRadius: 10, overflow: "hidden", marginBottom: 14, background: C.surface }}>
          <div style={{ padding: "9px 12px", background: C.amberBg }}>
            <div style={{ fontSize: 12.5, fontWeight: 850, color: C.amber }}>In the bank, not entered here · {unentered.length}</div>
            <div style={{ fontSize: 11.5, color: C.inkMid, marginTop: 2 }}>Foreign inward credits on the Bank of India accounts with no remittance entered against them.</div>
          </div>
          {unentered.map(t => (
            <div key={t.id} style={{ display: "grid", gridTemplateColumns: mob ? "1fr auto" : "90px minmax(0,1fr) 160px 140px auto", gap: 10, alignItems: "center", padding: "8px 12px", borderTop: `1px solid ${C.border}` }}>
              {!mob && <div style={{ fontSize: 12, color: C.inkMid }}>{fmtDate(t.date)}</div>}
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 800, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.payee}</div>
                <div style={{ fontSize: 11, color: C.inkFaint, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.notes || ""}</div>
              </div>
              {!mob && <div style={{ fontSize: 11.5, color: C.inkMid }}>{accById.get(t.accountTo)?.name}</div>}
              <div style={{ fontSize: 12.5, fontWeight: 850, textAlign: "right" }}>{(t.currency || "INR") === "INR" ? inr(t.amount) : f2(t.amount, t.currency)}</div>
              <button className="bs" style={{ fontSize: 11, padding: "4px 10px" }} onClick={() => startNew(remitFromLedgerCredit(t, accById.get(t.accountTo)))}>Enter →</button>
            </div>
          ))}
        </div>
      )}

      <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "auto", background: C.surface }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 980 }}>
          <thead><tr style={{ background: C.card }}>
            {["Date", "IRT", "Buyer", "Foreign", "Rate", "INR credited", "Charges", "Settles", "Bank", ""].map(h => <th key={h} style={th}>{h}</th>)}
          </tr></thead>
          <tbody>
            {shown.length === 0 && <tr><td colSpan={10} style={{ ...td, color: C.inkFaint, textAlign: "center", padding: 24 }}>No remittances {month === "all" ? "yet" : `in ${monthLabel(month)}`}. Upload a Bank of India advice, or enter one from the bank list above.</td></tr>}
            {shown.map(r => {
              const st = ngRemitSettlement(r, invoices), miss = ngRemitMissing(r), led = ledgerOf.out.get(r.id);
              const ok = !miss.length && st.settled && !st.over && !st.noSb.length;
              return (
                <tr key={r.id} onClick={() => setEditing(r)} style={{ cursor: "pointer" }}>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>{r.date ? fmtDate(r.date) : <span style={{ color: C.amber }}>{r.dateRaw || "no date"}</span>}</td>
                  <td style={{ ...td, fontWeight: 800 }}>{r.irt || <span style={{ color: C.amber }}>—</span>}</td>
                  <td style={td}>{r.buyer || r.remitter || <span style={{ color: C.amber }}>—</span>}</td>
                  <td style={{ ...td, whiteSpace: "nowrap", fontWeight: 800 }}>{f2(r.amount, r.currency)}</td>
                  <td style={td}>{isEefc(r) ? <span style={{ color: C.inkFaint }}>EEFC</span> : (r.rate || <span style={{ color: C.amber }}>—</span>)}</td>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>{isEefc(r) ? <span style={{ color: C.inkFaint }}>kept in {r.currency}</span> : inr(r.inrCredited)}</td>
                  <td style={{ ...td, whiteSpace: "nowrap" }} onClick={e => e.stopPropagation()}>
                    {r.charges == null || r.charges === "" ? <span style={{ color: C.amber }}>—</span> : inr(r.charges)}
                    {+r.charges > 0 && (feesBooked(r)
                      ? <div style={{ fontSize: 10.5, color: C.green, fontWeight: 700 }}>✓ booked</div>
                      : <button className="bs" disabled={busy} style={{ display: "block", fontSize: 10.5, padding: "2px 8px", marginTop: 3 }} title={isEefc(r) ? "Classify the bank's fee debit as Bank Charges" : "Book the fees as a Bank Charges expense"}
                          onClick={() => run(async () => { const saved = await bookRemittanceFees({ rem: r, txns, accounts, isUnclassified }); setRemits(list => list.map(x => (x.id === saved.id ? saved : x))); }, `Fees on ${r.irt || "the remittance"} booked as Bank Charges.`)}>Book fees</button>)}
                  </td>
                  <td style={td}>
                    {st.allocs.map(a => <div key={a.inv.id} style={{ fontSize: 11.5, whiteSpace: "nowrap" }}>{a.inv.invNo}{a.inv.sbNo ? ` · SB ${a.inv.sbNo}` : ""} <span style={{ color: C.inkFaint }}>{f2(a.alloc)}</span></div>)}
                    {st.unallocated > 0.01 && <div style={{ fontSize: 11.5, color: r.advance ? C.blue : C.amber, fontWeight: 700 }}>{r.currency} {f2(st.unallocated)} {r.advance ? "advance" : "not tied"}</div>}
                    {!st.allocs.length && <div style={{ fontSize: 10.5, color: C.amber, fontWeight: 800 }}>No invoice yet{r.expectedShipDate ? ` · ships ${fmtDate(r.expectedShipDate)}` : ""}</div>}
                  </td>
                  <td style={td}>{led ? <Pill tone="green" title={`${led.payee} · ${fmtDate(led.date)}`}>✓ {fmtDate(led.date)}</Pill> : <Pill tone="amber">Not found</Pill>}</td>
                  <td style={td}>{ok ? <Pill tone="green">✓</Pill> : <Pill tone="amber" title={[miss.length ? `Missing ${miss.join(", ")}` : "", !st.settled ? "Not tied to an invoice or marked advance" : "", st.noSb.length ? `No SB on ${st.noSb.map(i => i.invNo).join(", ")}` : ""].filter(Boolean).join(" · ")}>{miss.length ? `${miss.length} missing` : !st.settled ? "Not tied" : st.noSb.length ? "No SB" : "Check"}</Pill>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editing && (
        <Editor rem={editing} invoices={invoices} buyers={buyers} ledgerTxn={editingLedger} busy={busy}
          onClose={() => setEditing(null)}
          onSave={rec => run(async () => {
            const { _new, ...clean } = rec;
            await saveRemit({ ...clean, ...(_new ? { createdAt: new Date().toISOString() } : { updatedAt: new Date().toISOString() }) });
            setEditing(null);
          }, `${rec.irt || "Remittance"} saved.`)}
          onDelete={rec => {
            const linked = invoices.filter(i => invRemitLinks(i).some(l => l.id === rec.id));
            if (!window.confirm(`Delete ${rec.irt || "this remittance"}${linked.length ? ` and unlink it from ${linked.map(i => i.invNo).join(", ")}` : ""}?`)) return;
            run(async () => {
              for (const inv of linked) await patchInvoice(inv.id, latest => withoutRemitLink(latest, rec.id));
              const next = remits.filter(r => r.id !== rec.id);
              setRemits(next); await saveK(NG_REMIT_KEY, next); setEditing(null);
            }, `${rec.irt || "Remittance"} deleted.`);
          }}
          onLink={(inv, amount, draft) => run(async () => {
            // A brand-new entry is saved first so the invoice never points at nothing.
            if (draft._new) { const { _new, ...clean } = draft; await saveRemit({ ...clean, createdAt: new Date().toISOString() }); setEditing(clean); }
            await patchInvoice(inv.id, latest => withRemitLink(latest, draft, amount));
          }, `${inv.invNo} linked.`)}
          onUnlink={inv => run(() => patchInvoice(inv.id, latest => withoutRemitLink(latest, editing.id)), `${inv.invNo} unlinked.`)}
        />
      )}
    </div>
  );
}
