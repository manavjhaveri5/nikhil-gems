/* Money moving between the current account and its overdraft (BOI OD against
   FD) is a transfer between our own accounts, not an expense or income. The
   bank prints it as "TO SEJAL JHAVERI OD AC" (paying the OD back) or "BY SEJAL
   NIKHIL JHAVERI OD AC" / "OD SEJAL JHAVERI" (drawing on it). Booked as a
   transfer with the OD account, the OD's balance follows every movement.

   Which way it goes is read off the side of the current account it sits on:
   a debit is money leaving the current account into the OD (repayment), a
   credit is money coming out of the OD into the current account (drawdown).
   Charges and interest on the OD ("STAMP PAPER CHG FOR OD ENHANCEMENT", OD
   interest) are real costs and stay as they are. */

const textOf = t => `${t.payee || ""} ${t.notes || ""} ${t.rawPayee || ""} ${t.rawNotes || ""}`;
const COST = /\b(chg|chgs|charges?|stamp|interest|int\.?\s*(?:dr|cr|paid|debit)|fee|fees|renew\w*|enhanc\w*|penal\w*|gst|tax)\b/i;

// The OD accounts, each with the current account it is drawn into.
export const odAccountsOf = (accounts = []) =>
  accounts.filter(a => a?.type === "od" && a.active !== false && a.odLinkedAccountId);

/* The OD account a ledger line moves money with, or null. Only lines on the
   OD's own current account count, and only plain debits and credits (a line
   already booked as a transfer is left alone).
   There can be several ODs on one current account (two BOI ODs and Sejal's,
   all drawn into 0451). Each line goes to the one it names: by its account
   number first, then by the name the bank prints for it (od.odMatch, e.g.
   "SEJAL" for "SEJAL JHAVERI OD AC"). A line that says OD but names none of
   them is only booked when there is a single OD to book it to. */
export function odFor(t, accounts = []) {
  if (!t || (t.type !== "debit" && t.type !== "credit")) return null;
  const acct = t.type === "debit" ? t.accountFrom : t.accountTo;
  const text = textOf(t);
  if (COST.test(text) || !/\bOD\b/i.test(text)) return null;
  const ods = odAccountsOf(accounts).filter(od => od.odLinkedAccountId === acct);
  if (!ods.length) return null;
  const digits = text.replace(/\D/g, " ").split(/\s+/).filter(d => d.length >= 6);
  const byNumber = ods.find(od => {
    const no = String(od.odAccountNo || "").replace(/\D/g, "");
    return no.length >= 6 && digits.some(d => d.endsWith(no.slice(-6)) || no.endsWith(d.slice(-6)));
  });
  if (byNumber) return byNumber;
  const byName = ods.find(od => {
    try { return od.odMatch && new RegExp(od.odMatch, "i").test(text); } catch { return false; }
  });
  if (byName) return byName;
  // "OD AC", "OD A/C", "OD ACCOUNT", "OD SEJAL JHAVERI", "from OD", "to OD".
  const byWords = /\bOD\s*(?:A\/?C|ACC(?:OU)?N?T?)\b/i.test(text) || /\bOD\s+[A-Z][A-Z]+\s+[A-Z]/.test(text) || /\b(?:from|to|into)\s+(?:the\s+)?OD\b/i.test(text);
  return byWords && ods.length === 1 ? ods[0] : null;
}

// What the line becomes: a transfer with the OD, kept with the bank's own wording.
export function odTransferPatch(t, od, accounts = []) {
  const cur = accounts.find(a => a.id === od.odLinkedAccountId);
  const repay = t.type === "debit";
  const amt = +t.amount || 0;
  const from = repay ? od.odLinkedAccountId : od.id;
  const to = repay ? od.id : od.odLinkedAccountId;
  const name = id => accounts.find(a => a.id === id)?.name || id;
  return {
    type: "conversion",
    accountFrom: from,
    accountTo: to,
    amount: amt,
    receivedAmount: amt,
    currency: cur?.currency || "INR",
    toCurrency: od.currency || "INR",
    rate: 1, convRate: 1,
    category: "Bank Transfer (Internal)",
    classifiedAs: "conversion",
    classifiedRef: null,
    payee: `${name(from)} → ${name(to)}`,
    notes: `${repay ? "OD repayment" : "OD drawdown"}. ${String(t.notes || t.payee || "").trim()}`.trim(),
    ...(t.rawPayee == null ? { rawPayee: t.payee || "" } : {}),
    ...(t.rawNotes == null ? { rawNotes: t.notes || "" } : {}),
    odAuto: true,
  };
}

// Statement import: every new line that is an OD movement becomes a transfer.
export function bookOdTransfers(txns, accounts, onlyIds) {
  let n = 0;
  const out = txns.map(t => {
    if (onlyIds && !onlyIds.has(t.id)) return t;
    const od = odFor(t, accounts);
    if (!od) return t;
    n++;
    return { ...t, ...odTransferPatch(t, od, accounts) };
  });
  return { txns: out, count: n };
}
