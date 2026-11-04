import { useEffect, useState } from "react";
import { parseConversionAdvice } from "./remittanceAdvice.js";

/* Ledger panel for a transfer / conversion entry.

   A conversion moves foreign currency out of the EEFC account and puts rupees
   into the operative account. The bank converts at its rate and then keeps a
   commission plus SGST and CGST, so the rupees credited are less than
   USD × rate:

     USD 5,000.00 × 94.8400 = ₹4,74,200.00 − 100 − 9 − 9 = ₹4,74,082.00

   The entry keeps the USD in `amount` and the net rupees in `receivedAmount`,
   with `convRate` = net ÷ USD so every balance in the app (which all compute
   amount × convRate) lands on what the bank statement shows. The bank's own
   rate and the fee lines go in `fx` for the breakdown and the export papers.

   The numbers come from the BOI advice PDF when one is attached as a file,
   and can always be typed in. It also lets a transfer be edited the way any
   other entry can: change either account, swap the direction, or turn it back
   into a plain debit or credit when it was never a transfer. */

const r2 = n => Math.round((+n || 0) * 100) / 100;
const fmt = (n, cur) => {
  const sym = { INR: "₹", USD: "$", EUR: "€", JPY: "¥", GBP: "£" }[cur] ?? `${cur} `;
  return `${sym}${(+n || 0).toLocaleString(cur === "INR" ? "en-IN" : "en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
const str = v => (v || v === 0 ? String(v) : "");

const pdfOf = t => (t.attachments || (t.attachmentUrl ? [{ url: t.attachmentUrl, name: t.attachmentName, type: t.attachmentType }] : []))
  // A Gmail thread link is not a file the browser can read; only stored PDFs are.
  .find(a => a?.url && !/mail\.google\.com/.test(a.url) && (/pdf/i.test(a.type || "") || /\.pdf($|\?)/i.test(a.name || a.url)));

export default function ConversionBreakdown({ txn, accounts, onPatch, extractPdfText, C, inputS, mob, showToast }) {
  const acc = id => accounts.find(a => a.id === id);
  const fromCur = acc(txn.accountFrom)?.currency || txn.currency || "INR";
  const toCur = acc(txn.accountTo)?.currency || txn.toCurrency || "INR";
  const fx = txn.fx || {};
  const cross = fromCur !== toCur;

  const initial = () => ({
    amount: str(txn.amount),
    rate: str(fx.rate ?? txn.classifiedRef?.rate ?? txn.convRate),
    commission: str(fx.commission), sgst: str(fx.sgst), cgst: str(fx.cgst), igst: str(fx.igst),
    net: str(txn.receivedAmount ?? (cross ? "" : txn.amount)),
  });
  const [form, setForm] = useState(initial);
  const [advice, setAdvice] = useState(null);
  const [reading, setReading] = useState(false);
  useEffect(() => { setForm(initial()); setAdvice(null); }, [txn.id, txn.updatedAt]);

  const pdf = pdfOf(txn);
  useEffect(() => {
    if (!cross || !pdf?.url || !extractPdfText) return;
    let off = false;
    setReading(true);
    extractPdfText(pdf.url).then(t => { if (!off) setAdvice(parseConversionAdvice(t)); }).finally(() => { if (!off) setReading(false); });
    return () => { off = true; };
  }, [txn.id, pdf?.url, cross]);

  const usd = +form.amount || 0, rate = +form.rate || 0;
  const gross = r2(usd * rate);
  const fees = r2((+form.commission || 0) + (+form.sgst || 0) + (+form.cgst || 0) + (+form.igst || 0));
  const net = form.net !== "" ? +form.net : r2(gross - fees);
  const netOff = cross && gross > 0 && form.net !== "" && Math.abs(gross - fees - net) > 0.5;
  const dirty = JSON.stringify(form) !== JSON.stringify(initial());

  const fillFromAdvice = a => setForm({
    amount: str(a.foreignAmount), rate: str(a.rate),
    commission: str(a.commission), sgst: str(a.sgst), cgst: str(a.cgst), igst: a.igst ? str(a.igst) : "",
    net: str(a.net),
  });
  const adviceDiffers = advice && (Math.abs((advice.foreignAmount || 0) - (+txn.amount || 0)) > 0.005 || Math.abs((advice.net || 0) - (+txn.receivedAmount || 0)) > 0.5 || !txn.fx);

  const save = async source => {
    if (!(usd > 0)) return showToast?.("Enter the amount sent");
    const received = cross ? net : usd;
    const patch = {
      amount: usd,
      receivedAmount: received,
      convRate: cross ? (received / usd) : 1,
      fx: cross ? { rate, gross, commission: +form.commission || 0, sgst: +form.sgst || 0, cgst: +form.cgst || 0, igst: +form.igst || 0, fees, source } : null,
    };
    if (txn.classifiedRef) patch.classifiedRef = { ...txn.classifiedRef, sourceAmount: usd, targetAmount: received, rate: rate || patch.convRate };
    await onPatch(patch);
    showToast?.("Conversion saved");
  };

  const swap = () => onPatch({
    accountFrom: txn.accountTo, accountTo: txn.accountFrom,
    ...(cross ? { amount: txn.receivedAmount || r2((+txn.amount || 0) * (+txn.convRate || 1)), receivedAmount: +txn.amount || 0, convRate: (+txn.amount || 0) / ((txn.receivedAmount || (+txn.amount || 0) * (+txn.convRate || 1)) || 1), fx: null, currency: toCur, toCurrency: fromCur } : {}),
  });
  const notTransfer = side => {
    if (!window.confirm(side === "debit"
      ? `Make this a plain debit (money out) from ${acc(txn.accountFrom)?.name || "the from account"}? It will need classifying.`
      : `Make this a plain credit (money in) to ${acc(txn.accountTo)?.name || "the to account"}? It will need classifying.`)) return;
    const clear = { convRate: undefined, receivedAmount: undefined, toCurrency: undefined, fx: undefined, rate: undefined, category: "", classifiedAs: null, classifiedRef: null, classifiedAt: null, classifiedBy: null, classifiedSnapshot: null };
    onPatch(side === "debit"
      ? { ...clear, type: "debit", accountFrom: txn.accountFrom, accountTo: undefined, currency: fromCur }
      : { ...clear, type: "credit", accountTo: txn.accountTo, accountFrom: undefined, amount: cross ? (+txn.receivedAmount || r2((+txn.amount || 0) * (+txn.convRate || 1))) : +txn.amount, currency: toCur });
  };

  const label = { fontSize: 10, fontWeight: 900, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .6, marginBottom: 4 };
  const num = (key, ph, cur) => (
    <label style={{ display: "block", minWidth: 0 }}>
      <div style={label}>{ph}{cur ? ` (${cur})` : ""}</div>
      <input type="number" inputMode="decimal" step="any" value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} style={{ ...inputS, width: "100%", boxSizing: "border-box" }} />
    </label>
  );
  const sel = (key, title) => (
    <label style={{ display: "block", minWidth: 0 }}>
      <div style={label}>{title}</div>
      <select value={txn[key] || ""} onChange={e => onPatch({ [key]: e.target.value })} style={{ ...inputS, width: "100%", cursor: "pointer" }}>
        <option value="">- Select account -</option>
        {accounts.map(a => <option key={a.id} value={a.id}>{a.name}{a.currency && a.currency !== "INR" ? ` · ${a.currency}` : ""}</option>)}
      </select>
    </label>
  );
  const btn = { border: `1.5px solid ${C.border}`, background: C.surface, color: C.inkMid, borderRadius: 8, padding: "8px 12px", fontSize: 12, fontWeight: 850, cursor: "pointer", fontFamily: "inherit" };

  return (
    <div style={{ display: "grid", gap: 10, padding: "12px 13px", borderRadius: 10, border: `1.5px solid ${C.blue}55`, background: C.surface }}>
      <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr" : "1fr auto 1fr", gap: 8, alignItems: "end" }}>
        {sel("accountFrom", "From (money out)")}
        <button onClick={swap} title="Swap direction" style={{ ...btn, padding: "8px 10px" }}>⇄</button>
        {sel("accountTo", "To (money in)")}
      </div>

      {cross ? <>
        {advice && adviceDiffers && (
          <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 11px", background: C.greenBg, border: `1px solid ${C.green}55`, borderRadius: 8, fontSize: 12 }}>
            <span>📄</span>
            <div style={{ flex: 1, minWidth: 0 }}>The bank advice says {advice.foreignCurrency} {advice.foreignAmount} × {advice.rate} − fees ₹{r2(advice.commission + advice.sgst + advice.cgst + advice.igst)} = {fmt(advice.net, "INR")}</div>
            <button onClick={() => fillFromAdvice(advice)} style={{ ...btn, background: C.green, color: "#fff", border: "none" }}>Fill in</button>
          </div>
        )}
        {reading && <div style={{ fontSize: 11, color: C.inkFaint }}>Reading the attached advice…</div>}
        <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr 1fr" : "1fr 1fr 1fr", gap: 8 }}>
          {num("amount", "Amount out", fromCur)}
          {num("rate", "Bank rate")}
          <div><div style={label}>Gross ({toCur})</div><div style={{ ...inputS, background: "transparent", fontWeight: 800 }}>{gross ? fmt(gross, toCur) : "—"}</div></div>
          {num("commission", "Commission", toCur)}
          {num("sgst", "SGST", toCur)}
          {num("cgst", "CGST", toCur)}
          {(+form.igst > 0) && num("igst", "IGST", toCur)}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr" : "1fr 1fr", gap: 8, alignItems: "end" }}>
          {num("net", `Net credited to ${acc(txn.accountTo)?.name || "account"}`, toCur)}
          <div style={{ fontSize: 12, color: C.inkMid, lineHeight: 1.5 }}>
            {fmt(usd, fromCur)} × {rate || "?"} = {fmt(gross, toCur)}<br />
            − fees {fmt(fees, toCur)} = <strong style={{ color: netOff ? C.red : C.ink }}>{fmt(r2(gross - fees), toCur)}</strong>
            {netOff && <div style={{ color: C.red, fontWeight: 750 }}>Net doesn't match gross − fees</div>}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="bp" disabled={!dirty} onClick={() => save(advice && form.amount === str(advice.foreignAmount) ? "advice" : "manual")} style={{ fontSize: 12, padding: "8px 14px", opacity: dirty ? 1 : .5 }}>Save conversion</button>
          {dirty && <button onClick={() => setForm(initial())} style={btn}>Reset</button>}
        </div>
      </> : (
        <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr" : "1fr auto", gap: 8, alignItems: "end" }}>
          {num("amount", "Amount", fromCur)}
          <button className="bp" disabled={!dirty} onClick={() => save("manual")} style={{ fontSize: 12, padding: "8px 14px", opacity: dirty ? 1 : .5 }}>Save</button>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", borderTop: `1px solid ${C.border}`, paddingTop: 9 }}>
        <span style={{ fontSize: 11, color: C.inkFaint, fontWeight: 750 }}>Not a transfer?</span>
        <button onClick={() => notTransfer("debit")} style={btn}>Make it a debit</button>
        <button onClick={() => notTransfer("credit")} style={btn}>Make it a credit</button>
      </div>
    </div>
  );
}
