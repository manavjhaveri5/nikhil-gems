import { useEffect, useState } from "react";
import { C } from "./ui.jsx";
import { mob, fmtDate } from "./utils.js";
import { DEFAULT_EXP_CATS } from "./constants.js";
import { matchLearned } from "./classifyLearner.js";
import { monthOf } from "./monthClose.js";
import { quickClassifyExpense, undoQuickClassify } from "./quickClassify.js";

/* Payments that still need something: no head yet (put under an expense head
   here in one tap — the head used for that payee before is offered first — or
   opened in the Ledger when it needs a bill, card or account picked), or paid to
   a vendor with no bill linked (opened in the Ledger to link it). Used on Home
   and in Accounting → Classify. */

const CUR_SYM = { INR: "₹", USD: "$", EUR: "€", JPY: "¥", GBP: "£", AUD: "A$" };
export const money = (n, cur = "INR") => `${CUR_SYM[cur] || `${cur} `}${(+n || 0).toLocaleString("en-IN", { maximumFractionDigits: cur === "INR" ? 0 : 2 })}`;
const LEARNED_LABEL = { vendor_bill: "Vendor bill", vendor_po: "Advance to vendor", cc_payment: "Card payment", conversion: "Transfer" };

export const needsBill = (t, isUnclassified) => t?.type === "debit" && !isUnclassified(t) && t.classifiedAs === "vendor_bill" &&
  !t.classifiedRef?.interCo && !(t.classifiedRef?.billIds || []).length && !t.classifiedRef?.billId;

export default function PaymentQueue({ company, items, accounts = [], isUnclassified, memory = [], customHeads = [], onOpenLedger, onSaved, limit = 0, emptyText }) {
  const [busyId, setBusyId] = useState("");
  const [done, setDone] = useState(null);
  const [err, setErr] = useState("");
  const [showAll, setShowAll] = useState(false);
  useEffect(() => { if (!done) return; const t = setTimeout(() => setDone(null), 9000); return () => clearTimeout(t); }, [done]);
  const heads = [...DEFAULT_EXP_CATS, ...customHeads.filter(c => c && !DEFAULT_EXP_CATS.includes(c))];
  const accName = id => accounts.find(a => a.id === id)?.name || "Account";

  const classify = async (t, cat) => {
    if (!cat) return;
    setBusyId(t.id); setErr("");
    try {
      const { saved, before } = await quickClassifyExpense({ company, txn: t, cat });
      onSaved?.(saved);
      setDone({ label: `${t.payee || "Payment"} → ${cat}`, before });
    } catch (e) { setErr(`Couldn't classify: ${e?.message || "check connection"}`); }
    finally { setBusyId(""); }
  };
  const undo = async () => {
    const d = done; setDone(null);
    try { await undoQuickClassify({ company, before: d.before }); onSaved?.(d.before); }
    catch (e) { setErr(`Undo failed: ${e?.message || "check connection"}`); }
  };
  const shown = limit && !showAll ? items.slice(0, limit) : items;

  return (
    <div style={{ display: "grid" }}>
      {done && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, background: C.greenBg, color: C.green, borderRadius: 9, padding: "7px 11px", fontSize: 12.5, fontWeight: 700, marginBottom: 6 }}>
          <span>✓ {done.label}</span>
          <button onClick={undo} style={{ background: "none", border: "none", color: C.green, fontWeight: 800, cursor: "pointer", textDecoration: "underline", fontFamily: "inherit" }}>Undo</button>
        </div>
      )}
      {err && <div style={{ background: C.redBg, color: C.red, borderRadius: 9, padding: "7px 11px", fontSize: 12.5, fontWeight: 700, marginBottom: 6 }}>{err}</div>}
      {items.length === 0 && <div style={{ fontSize: 12.5, color: C.green, fontWeight: 700, padding: "6px 0" }}>✓ {emptyText || "Nothing to classify."}</div>}
      {shown.map(t => {
        const billOnly = needsBill(t, isUnclassified);
        const learned = billOnly ? null : matchLearned(memory, t);
        const sure = learned && learned.confidence >= 0.6 && learned.count >= 1;
        const quick = sure && learned.classifiedAs === "expense" && learned.cat ? learned.cat : "";
        const other = sure && LEARNED_LABEL[learned.classifiedAs] ? `${LEARNED_LABEL[learned.classifiedAs]}${learned.party ? ` · ${learned.party}` : ""}` : "";
        const busy = busyId === t.id;
        return (
          <div key={t.id} style={{ display: "grid", gridTemplateColumns: mob ? "1fr auto" : "70px minmax(0,1fr) 110px minmax(0,auto)", gap: 10, alignItems: "center", padding: "8px 0", borderTop: `1px solid ${C.border}`, opacity: busy ? .5 : 1 }}>
            {!mob && <div style={{ fontSize: 11.5, color: C.inkMid }}>{fmtDate(t.date)}</div>}
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 750, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.payee || "—"}</div>
              <div style={{ fontSize: 11, color: C.inkFaint, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{mob ? `${fmtDate(t.date)} · ` : ""}{accName(t.accountFrom)}{t.notes ? ` · ${t.notes}` : ""}</div>
            </div>
            <div style={{ fontSize: 13, fontWeight: 800, color: C.ink, textAlign: "right" }}>{money(t.amount, t.currency)}</div>
            <div style={{ display: "flex", gap: 6, alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap", gridColumn: mob ? "1 / -1" : "auto" }}>
              {billOnly ? <>
                <span style={{ fontSize: 11, color: C.amber, fontWeight: 700, whiteSpace: "nowrap" }}>Paid to {t.classifiedRef?.vendorName || "vendor"} · no bill</span>
                <button className="bs" style={{ fontSize: 11, padding: "4px 9px", whiteSpace: "nowrap" }} onClick={() => onOpenLedger?.({ id: t.id, month: monthOf(t.date) })}>Link bill →</button>
              </> : <>
                {quick && <button disabled={busy} onClick={() => classify(t, quick)} title="Classify under the head you used for this payee before"
                  style={{ border: `1px solid ${C.green}`, background: C.greenBg, color: C.green, borderRadius: 7, padding: "4px 9px", fontSize: 11.5, fontWeight: 800, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>✓ {quick}</button>}
                {!quick && other && <span style={{ fontSize: 11, color: C.inkMid, whiteSpace: "nowrap" }}>Looks like {other}</span>}
                <select value="" disabled={busy} onChange={e => classify(t, e.target.value)} aria-label="Expense head"
                  style={{ border: `1px solid ${C.border}`, background: C.surface, color: C.ink, borderRadius: 7, padding: "4px 6px", fontSize: 11.5, fontFamily: "inherit", cursor: "pointer", maxWidth: 140 }}>
                  <option value="">{quick ? "Other head…" : "Expense head…"}</option>
                  {heads.map(h => <option key={h} value={h}>{h}</option>)}
                </select>
                <button className="bs" style={{ fontSize: 11, padding: "4px 9px", whiteSpace: "nowrap" }} onClick={() => onOpenLedger?.({ id: t.id, month: monthOf(t.date) })} title="Vendor bill, card payment or transfer — open it in the Ledger">Bill / more →</button>
              </>}
            </div>
          </div>
        );
      })}
      {limit > 0 && items.length > limit && (
        <button onClick={() => setShowAll(s => !s)} style={{ background: "none", border: "none", borderTop: `1px solid ${C.border}`, padding: "8px 0 0", textAlign: "left", color: C.gold, fontWeight: 700, fontSize: 12.5, cursor: "pointer", fontFamily: "inherit" }}>
          {showAll ? "Show fewer" : `+ ${items.length - limit} more`}
        </button>
      )}
    </div>
  );
}
