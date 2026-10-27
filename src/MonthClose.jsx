import { useEffect, useMemo, useState } from "react";
import { C, FI } from "./ui.jsx";
import { mob, fmtDate, loadK, upsertItemK, onCacheRefresh } from "./utils.js";
import { paymentChecks, balanceChecks, statementsKey, statementId, monthEndDate, monthLabel } from "./monthClose.js";

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

// One statement account: ERP balance against the statement's closing, how the
// month's money in/out compares when the statement's rows are known, the last
// six months at a glance, and a closing typed in by hand when no statement was
// imported.
function BalanceRow({ chk, onSaveClosing }) {
  const { acc, statement: st, erp, diff, ok, asOf, partial, flows, history } = chk;
  const cur = acc.currency || "INR";
  const [editing, setEditing] = useState(false);
  const [amt, setAmt] = useState("");
  const [date, setDate] = useState(asOf);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setEditing(false); setAmt(st?.closing != null ? String(st.closing) : ""); setDate(st?.closingDate || monthEndDate(chk.month)); }, [chk.month, st?.id, st?.closing]);
  const save = async () => {
    if (amt === "" || !Number.isFinite(+amt)) return;
    setBusy(true);
    try { await onSaveClosing(acc, { closing: +amt, closingDate: date || monthEndDate(chk.month) }); setEditing(false); }
    finally { setBusy(false); }
  };
  const status = !st ? { t: "No statement", c: C.amber } : ok ? { t: "✓ Agrees", c: C.green } : { t: `Off by ${money(Math.abs(diff), cur)}`, c: C.red };
  const stFlows = st && st.credits != null && st.debits != null;
  return (
    <div style={{ borderTop: `1px solid ${C.border}`, padding: "10px" }}>
      <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr 1fr" : "minmax(0,1.3fr) 1fr 1fr 1fr auto", gap: 10, alignItems: "center" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 850, color: C.ink }}>{acc.name}</div>
          <div style={{ fontSize: 11, color: C.inkFaint }}>{cur}{st?.fileName ? ` · ${st.fileName}` : st?.source === "manual" ? " · typed in" : ""}</div>
        </div>
        <div><div style={{ fontSize: 10, color: C.inkFaint, fontWeight: 800 }}>ERP · {fmtDate(asOf)}</div><div style={{ fontSize: 13, fontWeight: 850, color: C.ink }}>{money(erp, cur)}</div></div>
        <div><div style={{ fontSize: 10, color: C.inkFaint, fontWeight: 800 }}>STATEMENT</div><div style={{ fontSize: 13, fontWeight: 850, color: st ? C.ink : C.inkFaint }}>{st ? money(st.closing, cur) : "—"}</div></div>
        <div><div style={{ fontSize: 10, color: C.inkFaint, fontWeight: 800 }}>DIFFERENCE</div><div style={{ fontSize: 13, fontWeight: 900, color: diff == null ? C.inkFaint : ok ? C.green : C.red }}>{diff == null ? "—" : `${diff > 0 ? "+" : diff < 0 ? "−" : ""}${money(Math.abs(diff), cur)}`}</div></div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", justifyContent: "flex-end", gridColumn: mob ? "1 / -1" : "auto" }}>
          <span style={{ fontSize: 11, fontWeight: 850, color: status.c, whiteSpace: "nowrap" }}>{status.t}</span>
          <button className="bs" style={{ fontSize: 11, padding: "4px 10px", whiteSpace: "nowrap" }} onClick={() => setEditing(e => !e)}>{st ? "Edit closing" : "Enter closing"}</button>
        </div>
      </div>
      {partial && <div style={{ fontSize: 11, color: C.amber, marginTop: 6 }}>The statement stops on {fmtDate(asOf)}, before the month ends — the rest of the month is not checked yet.</div>}
      {st && !ok && (
        <div style={{ fontSize: 11.5, color: C.inkMid, marginTop: 6, lineHeight: 1.45 }}>
          {diff > 0 ? "The bank shows more than the ERP" : "The ERP shows more than the bank"} at {fmtDate(asOf)}.{" "}
          {st.fromDate && st.fromDate > `${chk.month}-01` || partial ? `ERP ${fmtDate(st.fromDate || `${chk.month}-01`)} – ${fmtDate(asOf)}` : "ERP this month"}: in {money(flows.credits, cur)} · out {money(flows.debits, cur)} ({flows.count} entr{flows.count === 1 ? "y" : "ies"}).
          {stFlows && <> Statement: in {money(st.credits, cur)} · out {money(st.debits, cur)} ({st.rows} row{st.rows === 1 ? "" : "s"}).
            {Math.abs(st.credits - flows.credits) >= 0.5 && <b style={{ color: C.red }}> Money in differs by {money(Math.abs(st.credits - flows.credits), cur)}.</b>}
            {Math.abs(st.debits - flows.debits) >= 0.5 && <b style={{ color: C.red }}> Money out differs by {money(Math.abs(st.debits - flows.debits), cur)}.</b>}
            {Math.abs(st.credits - flows.credits) < 0.5 && Math.abs(st.debits - flows.debits) < 0.5 && " This month's movements agree, so the gap was there before the month began — check earlier months or the opening balance."}</>}
          {!stFlows && " Import the statement in Finance → Reconcile to see which rows are missing."}
        </div>
      )}
      {editing && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
          <span style={{ fontSize: 11.5, color: C.inkMid }}>Statement closing {cur}</span>
          <input type="number" step="0.01" value={amt} onChange={e => setAmt(e.target.value)} style={{ ...FI, width: 150, fontSize: 12, padding: "6px 9px" }} placeholder="As printed" />
          <span style={{ fontSize: 11.5, color: C.inkMid }}>as of</span>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} style={{ ...FI, width: 150, fontSize: 12, padding: "6px 9px" }} />
          <button className="bp" style={{ fontSize: 11, padding: "6px 12px" }} disabled={busy || amt === ""} onClick={save}>{busy ? "Saving…" : "Save"}</button>
        </div>
      )}
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 8 }}>
        {history.map(h => {
          const t = !h.statement ? "—" : h.ok ? "✓" : `${h.diff > 0 ? "+" : "−"}${money(Math.abs(h.diff), cur)}`;
          const c = !h.statement ? C.inkFaint : h.ok ? C.green : C.red;
          return <span key={h.month} title={h.statement ? `ERP ${money(h.erp, cur)} · statement ${money(h.statement.closing, cur)}` : "No statement for this month"}
            style={{ fontSize: 10.5, fontWeight: 800, color: c, background: h.month === chk.month ? C.card : "transparent", border: `1px solid ${C.border}`, borderRadius: 999, padding: "2px 8px", whiteSpace: "nowrap" }}>
            {monthLabel(h.month, { month: "short" })} {t}</span>;
        })}
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

  // Statement month-ends: kept by Finance → Reconcile on import, or typed in here.
  const [statements, setStatements] = useState([]);
  useEffect(() => {
    let alive = true;
    const load = () => loadK(statementsKey(company)).then(v => { if (alive) setStatements(Array.isArray(v) ? v : []); }).catch(() => {});
    load();
    const off = onCacheRefresh(keys => { if (keys.includes(statementsKey(company))) load(); });
    return () => { alive = false; off?.(); };
  }, [company]);
  const saveClosing = async (acc, { closing, closingDate }) => {
    const prev = statements.find(s => s.id === statementId(acc.id, month));
    const rec = { ...(prev || {}), id: statementId(acc.id, month), accountId: acc.id, month, closing, closingDate, source: "manual", savedAt: new Date().toISOString() };
    if (prev && prev.closing !== closing) { delete rec.credits; delete rec.debits; delete rec.rows; delete rec.fileName; }
    setStatements(list => [rec, ...list.filter(s => s.id !== rec.id)]);
    const saved = await upsertItemK(statementsKey(company), rec);
    if (Array.isArray(saved) && saved.length) setStatements(saved);
  };
  const bal = useMemo(() => balanceChecks({ accounts, txns, statements, month }), [accounts, txns, statements, month]);
  const balOpen = bal.filter(b => !b.ok).length;

  const tiles = [
    { id: "payments", title: "Payments classified", open: pay.unclassified.length, okText: `all ${pay.payments.length}`,
      detail: pay.noBill.length ? `${pay.noBill.length} vendor payment${pay.noBill.length === 1 ? "" : "s"} with no bill linked` : `${pay.payments.length} payment${pay.payments.length === 1 ? "" : "s"} this month` },
    { id: "balance", title: "Bank vs statement", open: balOpen, okText: `${bal.length} agree`,
      detail: balOpen ? `${bal.filter(b => !b.statement).length} without a statement · ${bal.filter(b => b.statement && !b.ok).length} off` : "Every account ties to its statement" },
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

      {section === "balance" && (
        <Block title="ERP balance against the bank statement" sub={`Closing balance on each bank account at the end of ${monthLabel(month)}. Statements imported in Finance → Reconcile keep their month-end balances; you can also type a closing in off the PDF.`}>
          {bal.length === 0
            ? <div style={{ padding: 10, fontSize: 12, color: C.inkFaint, borderTop: `1px solid ${C.border}` }}>No bank accounts set up for this company.</div>
            : bal.map(chk => <BalanceRow key={chk.acc.id} chk={chk} onSaveClosing={saveClosing} />)}
        </Block>
      )}
    </div>
  );
}
