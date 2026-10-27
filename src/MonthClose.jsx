import { useMemo, useState } from "react";
import { C } from "./ui.jsx";
import { mob, fmtDate } from "./utils.js";
import { paymentChecks, monthLabel } from "./monthClose.js";

/* Month close — one company, one month, the four checks side by side (see
   monthClose.js). Rendered inside the Ledger, so "Classify →" drops you on the
   payment in the same screen; the other checks link to the module that owns the
   records. Each check reads live data and shows what is left, never a stored
   verdict: a month is closed when every list here is empty. */

const CUR_SYM = { INR: "₹", USD: "$", EUR: "€", JPY: "¥", GBP: "£", AUD: "A$" };
const money = (n, cur = "INR") => `${CUR_SYM[cur] || `${cur} `}${(+n || 0).toLocaleString("en-IN", { minimumFractionDigits: cur === "JPY" ? 0 : 2, maximumFractionDigits: cur === "JPY" ? 0 : 2 })}`;

function Tile({ id, active, onClick, title, open, okText, detail }) {
  const ok = open === 0;
  return (
    <button onClick={() => onClick(id)} style={{ textAlign: "left", border: `1.5px solid ${active ? C.ink : ok ? C.border : C.amber}`, background: active ? C.card : C.surface, borderRadius: 10, padding: "11px 12px", cursor: "pointer", fontFamily: "inherit", minWidth: 0 }}>
      <div style={{ fontSize: 10, fontWeight: 900, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .6 }}>{title}</div>
      <div style={{ fontSize: 17, fontWeight: 900, color: ok ? C.green : C.amber, marginTop: 4 }}>{ok ? `✓ ${okText}` : `${open} open`}</div>
      {detail && <div style={{ fontSize: 11, color: C.inkMid, marginTop: 3, lineHeight: 1.35 }}>{detail}</div>}
    </button>
  );
}

function TxnRow({ t, accountName, label, action, onAction, tone = C.amber }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr auto" : "84px minmax(0,1fr) 150px 120px 230px", gap: 10, alignItems: "center", padding: "8px 10px", borderTop: `1px solid ${C.border}` }}>
      {!mob && <div style={{ fontSize: 12, color: C.inkMid }}>{fmtDate(t.date)}</div>}
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 800, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.payee || t.rawPayee || "—"}</div>
        <div style={{ fontSize: 11, color: C.inkFaint, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{mob ? `${fmtDate(t.date)} · ${accountName(t)}` : (t.notes || t.rawNotes || "")}</div>
      </div>
      {!mob && <div style={{ fontSize: 11.5, color: C.inkMid, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{accountName(t)}</div>}
      <div style={{ fontSize: 12.5, fontWeight: 850, color: C.ink, textAlign: "right", whiteSpace: "nowrap" }}>{money(t.amount, t.currency)}</div>
      <div style={{ display: "flex", gap: 6, alignItems: "center", justifyContent: "flex-end", gridColumn: mob ? "1 / -1" : "auto" }}>
        {label && <span style={{ fontSize: 10.5, fontWeight: 800, color: tone, whiteSpace: "nowrap" }}>{label}</span>}
        {onAction && <button className="bs" style={{ fontSize: 11, padding: "4px 10px", whiteSpace: "nowrap" }} onClick={() => onAction(t)}>{action}</button>}
      </div>
    </div>
  );
}

function Block({ title, sub, children, empty }) {
  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 9, overflow: "hidden", background: C.surface }}>
      <div style={{ padding: "9px 10px", background: C.card }}>
        <div style={{ fontSize: 12, fontWeight: 900, color: C.ink }}>{title}</div>
        {sub && <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 2 }}>{sub}</div>}
      </div>
      {children || <div style={{ padding: "10px", fontSize: 12, color: C.green, fontWeight: 750, borderTop: `1px solid ${C.border}` }}>✓ {empty}</div>}
    </div>
  );
}

export default function MonthClose({ company, month, accounts = [], txns = [], isUnclassified, onOpenTxn, onClose }) {
  const [section, setSection] = useState("payments");
  const coName = company === "at" ? "Atyahara" : "Nikhil Gems";
  const accountName = t => accounts.find(a => a.id === (t.type === "credit" ? t.accountTo : t.accountFrom))?.name || "Account";

  const pay = useMemo(() => paymentChecks({ txns, month, isUnclassified }), [txns, month, isUnclassified]);

  const tiles = [
    { id: "payments", title: "Payments classified", open: pay.unclassified.length, okText: `all ${pay.payments.length}`,
      detail: pay.noBill.length ? `${pay.noBill.length} vendor payment${pay.noBill.length === 1 ? "" : "s"} with no bill linked` : `${pay.payments.length} payment${pay.payments.length === 1 ? "" : "s"} this month` },
  ];

  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: mob ? "12px" : "14px 16px", display: "grid", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 900, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .65 }}>Month close · {coName}</div>
          <div style={{ fontSize: 16, fontWeight: 900, color: C.ink, marginTop: 2 }}>{monthLabel(month)}</div>
        </div>
        <button className="bs" style={{ fontSize: 12, padding: "6px 11px" }} onClick={onClose}>Back to ledger</button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr 1fr" : `repeat(${tiles.length}, minmax(0, 1fr))`, gap: 8 }}>
        {tiles.map(t => <Tile key={t.id} {...t} active={section === t.id} onClick={setSection} />)}
      </div>

      {section === "payments" && (
        <div style={{ display: "grid", gap: 10 }}>
          <Block title={`Unclassified payments · ${pay.unclassified.length}`} sub="Every payment out needs a head: vendor purchase, expense head, salary, tax, card payment or a transfer between your own accounts."
            empty={`Every payment in ${monthLabel(month, { month: "long" })} is classified.`}>
            {pay.unclassified.length > 0 && pay.unclassified.map(t => (
              <TxnRow key={t.id} t={t} accountName={accountName} action="Classify →" onAction={onOpenTxn} />
            ))}
          </Block>
          <Block title={`Vendor payments with no bill linked · ${pay.noBill.length}`} sub="Classified as paid to a vendor, but no bill is attached to the payment yet — link the bill once it is entered."
            empty="Every vendor payment is tied to its bill.">
            {pay.noBill.length > 0 && pay.noBill.map(t => (
              <TxnRow key={t.id} t={t} accountName={accountName} label={t.classifiedRef?.vendorName || "On account"} tone={C.inkMid} action="Link bill →" onAction={onOpenTxn} />
            ))}
          </Block>
          {pay.noVendor.length > 0 && (
            <Block title={`Vendor payments with no vendor picked · ${pay.noVendor.length}`} sub="The payment is booked as a purchase but not to any vendor's account.">
              {pay.noVendor.map(t => <TxnRow key={t.id} t={t} accountName={accountName} action="Pick vendor →" onAction={onOpenTxn} />)}
            </Block>
          )}
          {pay.moneyInUnclassified.length > 0 && (
            <Block title={`Money in, not yet classified · ${pay.moneyInUnclassified.length}`} sub="Not a payment, but the month is not closed until these are matched to a buyer or invoice too.">
              {pay.moneyInUnclassified.map(t => <TxnRow key={t.id} t={t} accountName={accountName} tone={C.green} action="Classify →" onAction={onOpenTxn} />)}
            </Block>
          )}
          {pay.heads.length > 0 && (
            <Block title="Where the month's payments went" sub="Classified payments and transfers by head.">
              {pay.heads.map(h => (
                <div key={`${h.head}|${h.currency}`} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "7px 10px", borderTop: `1px solid ${C.border}`, fontSize: 12.5 }}>
                  <span style={{ color: C.ink, fontWeight: 750 }}>{h.head} <span style={{ color: C.inkFaint, fontWeight: 600 }}>· {h.count}</span></span>
                  <span style={{ color: C.ink, fontWeight: 850 }}>{money(h.amount, h.currency)}</span>
                </div>
              ))}
            </Block>
          )}
        </div>
      )}
    </div>
  );
}
