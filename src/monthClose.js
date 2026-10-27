/* Month close — the checks an accountant runs before calling a month done, for
   one company (NG or Atyahara) at a time:

     (a) every payment out is classified, and tied to its bill or vendor;
     (b) every inward remittance is entered in full and settles invoices or is
         marked an advance;
     (c) the ERP's balance on each bank account agrees with the statement's
         closing balance at month end;
     (d) every shipping bill of the month is matched to its invoice and to the
         remittance(s) that realised it.

   Pure functions over the records the modules already keep (ledger txns,
   statements, remittances, invoices, shipping bills). Nothing here writes, and
   nothing is copied: the screens that fix a gap keep owning their data. */

export const round2 = n => Math.round((+n || 0) * 100) / 100;
export const monthOf = d => String(d || "").slice(0, 7);
export const monthEndDate = month => {
  const [y, m] = String(month).split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};
export const shiftMonth = (month, n) => {
  const [y, m] = String(month).split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};
export const monthLabel = (month, opts = { month: "long", year: "numeric" }) =>
  month ? new Date(`${month}-01T12:00:00`).toLocaleDateString("en-IN", opts) : "";

/* ── Balances ────────────────────────────────────────────────────────────────
   Same rules as Finance's computeBalances: a credit lands on accountTo, a debit
   leaves accountFrom (and a card payment also reduces that card's outstanding),
   a transfer leaves one account and lands on the other at its received amount.
   Cards and overdrafts are liabilities, kept as a positive amount owed, so every
   movement lands on them with the sign flipped. */
const LIABILITY_TYPES = new Set(["credit_card", "od"]);
export const isLiability = acc => LIABILITY_TYPES.has(acc?.type);

const receivedOf = t => {
  const r = +t.receivedAmount;
  if (r > 0) return r;
  return (+t.amount || 0) * (+t.convRate || 1);
};

// Asset-sense movement of one txn on one account (+ = more money available).
export function txnEffect(t, accId) {
  const amt = +t.amount || 0;
  let d = 0;
  if (t.type === "credit" && t.accountTo === accId) d += amt;
  if (t.type === "debit") {
    if (t.accountFrom === accId) d -= amt;
    if (t.classifiedAs === "cc_payment" && t.classifiedRef?.cardAccountId === accId) d += amt;
  }
  if (t.type === "conversion") {
    if (t.accountFrom === accId) d -= amt;
    if (t.accountTo === accId) d += receivedOf(t);
  }
  return d;
}
export const touchesAccount = (t, accId) =>
  t.accountFrom === accId || t.accountTo === accId ||
  (t.classifiedAs === "cc_payment" && t.classifiedRef?.cardAccountId === accId);

const chronological = (a, b) =>
  (a.date || "").localeCompare(b.date || "") || (a.createdAt || "").localeCompare(b.createdAt || "");

// Balance as the account itself reports it (amount owed, for a card/OD) at the
// end of `date` — every txn dated on or before it counts.
export function accountBalanceAt(acc, txns, date) {
  if (!acc) return 0;
  const liab = isLiability(acc);
  let b = +acc.openingBal || 0;
  for (const t of txns || []) {
    if (!t?.date || t.date > date) continue;
    const d = txnEffect(t, acc.id);
    b += liab ? -d : d;
  }
  return round2(b);
}

// Balance after each txn on the account, over the account's whole history — so a
// month (or a filtered list) shows the true running balance, not one that
// restarts from the opening balance at the top of whatever is on screen.
export function runningBalances(acc, txns) {
  const out = new Map();
  if (!acc) return out;
  const liab = isLiability(acc);
  let b = +acc.openingBal || 0;
  [...(txns || [])].filter(t => t && touchesAccount(t, acc.id)).sort(chronological).forEach(t => {
    const d = txnEffect(t, acc.id);
    b += liab ? -d : d;
    out.set(t.id, round2(b));
  });
  return out;
}

/* ── (a) Payments ────────────────────────────────────────────────────────────
   `isUnclassified` is passed in, not re-implemented: the Ledger owns the rule
   (which categories count as decided), and the month close must agree with the
   "Unclassified" filter the accountant clears them from. */
export function paymentHead(t) {
  if (t.type === "conversion") return "Transfer between own accounts";
  const ref = t.classifiedRef || {};
  if (t.classifiedAs === "vendor_bill") return ref.interCo ? "Inter-company" : "Vendor purchase";
  if (t.classifiedAs === "vendor_po") return "Advance to vendor";
  if (t.classifiedAs === "cc_payment") return "Credit card payment";
  return ref.cat || t.category || "Other";
}

export function paymentChecks({ txns = [], month, isUnclassified, accountIds = null }) {
  const inScope = t => monthOf(t.date) === month && (!accountIds || accountIds.has(t.accountFrom) || accountIds.has(t.accountTo));
  const monthTxns = txns.filter(t => t && inScope(t)).sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const payments = monthTxns.filter(t => t.type === "debit");
  const unclassified = payments.filter(t => isUnclassified(t));
  const classified = payments.filter(t => !isUnclassified(t));
  // A vendor payment with no bill against it is "on account": fine as an
  // advance, but it means the bill is still to be entered or linked.
  const noBill = classified.filter(t => t.classifiedAs === "vendor_bill" && !t.classifiedRef?.interCo &&
    !(t.classifiedRef?.billIds || []).length && !t.classifiedRef?.billId);
  const noVendor = classified.filter(t => ["vendor_bill", "vendor_po"].includes(t.classifiedAs) &&
    !t.classifiedRef?.interCo && !t.classifiedRef?.vendorId);
  const transfersOut = monthTxns.filter(t => t.type === "conversion");
  const heads = {};
  [...classified, ...transfersOut].forEach(t => {
    const head = paymentHead(t), currency = t.currency || "INR", k = `${head}|${currency}`;
    heads[k] = heads[k] || { head, currency, count: 0, amount: 0 };
    heads[k].count += 1;
    heads[k].amount += +t.amount || 0;
  });
  return {
    payments, unclassified, noBill, noVendor,
    moneyInUnclassified: monthTxns.filter(t => t.type === "credit" && isUnclassified(t)),
    heads: Object.values(heads).sort((a, b) => b.amount - a.amount),
    done: unclassified.length === 0,
  };
}
