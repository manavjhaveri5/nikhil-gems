// ─── DEMO DATA — month close (demo mode only) ─────────────────────────────
// Bank ledgers, statements and remittances for both companies, dated in this
// month and the last two so the Ledger's Month close always has a live month to
// show. Merged into DEMO_DATA by demoData.js. All names and amounts are fictional.

import { accountBalanceAt, accountMonthFlows, monthEndDate, statementId } from "./monthClose.js";

// A day in the month `offset` months from now (0 = this month, -1 = last month).
const md = (offset, day) => {
  const now = new Date();
  const dt = new Date(Date.UTC(now.getFullYear(), now.getMonth() + offset, 1));
  const last = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
  dt.setUTCDate(Math.min(day, last));
  return dt.toISOString().slice(0, 10);
};
const ts = date => `${date}T10:00:00.000Z`;
const txn = (id, date, type, amount, extra) => ({ id, date, type, amount: String(amount), currency: "INR", createdAt: ts(date), ...extra });

export const DEMO_FINANCE = {
  // Replaces the base demo accounts (same ids) so balances have an opening.
  "ng-fin-accounts-v1": [
    { id: "fa-boi-0451", name: "Bank of India 0451", type: "bank", currency: "INR", openingBal: 452300, balance: 682500, active: true },
    { id: "fa-eefc", name: "EEFC", type: "bank", currency: "USD", openingBal: 1200, active: true },
    { id: "fa-cash-01", name: "INR Cash", type: "cash", currency: "INR", openingBal: 18000, balance: 18000, active: true },
    { id: "fa-usd-01", name: "USD Cash", type: "cash", currency: "USD", openingBal: 0, balance: 8650, active: true },
  ],
  // Appended to the base demo txns.
  "ng-fin-txns-v1": [
    txn("mc-ng-1", md(-2, 6), "debit", 74000, { accountFrom: "fa-boi-0451", payee: "Rajasthan Gems", category: "vendor_bill", classifiedAs: "vendor_bill", classifiedRef: { vendorId: "ven-1", vendorName: "Rajasthan Gems", billIds: ["pur-1"], billNumbers: ["RGM-0038"] } }),
    txn("mc-ng-2", md(-1, 4), "credit", 545020, { accountTo: "fa-boi-0451", payee: "ELENA VASQUEZ", category: "customer_receipt", classifiedAs: "customer_receipt", classifiedRef: { invoiceIds: ["inv-1"], invNumbers: ["NG-001/25-26"], buyer: "Elena Vasquez" }, notes: "Inward remittance 0013IRT26000910 · USD 5,725.00 @ ROE 95.2 = INR 545,020.00" }),
    txn("mc-ng-3", md(-1, 9), "debit", 32000, { accountFrom: "fa-boi-0451", payee: "IMPS/P2A/604718023311/BARB/MADIHA MOHAME", category: "Salary", classifiedAs: "expense", classifiedBy: "demo", classifiedRef: { cat: "Salary" } }),
    txn("mc-ng-4", md(-1, 18), "debit", 9800, { accountFrom: "fa-boi-0451", payee: "CBIC GST PAYMENT", category: "Taxes & Duties", classifiedAs: "expense", classifiedBy: "demo", classifiedRef: { cat: "Taxes & Duties" } }),
    txn("mc-ng-5", md(0, 3), "debit", 12400, { accountFrom: "fa-boi-0451", payee: "CBIC GST PAYMENT", category: "Taxes & Duties", classifiedAs: "expense", classifiedBy: "demo", classifiedRef: { cat: "Taxes & Duties" } }),
    txn("mc-ng-6", md(0, 7), "debit", 60000, { accountFrom: "fa-boi-0451", payee: "HIMALAYAN STONE WORKS", category: "vendor_bill", classifiedAs: "vendor_bill", classifiedRef: { vendorId: "ven-2", vendorName: "Himalayan Stone Works", billIds: [], billNumbers: [], paymentOnAccount: true } }),
    txn("mc-ng-7", md(0, 8), "debit", 18500, { accountFrom: "fa-boi-0451", payee: "NEFT FEDEX EXPRESS TSCS", category: "NEFT" }),
    txn("mc-ng-8", md(0, 11), "conversion", 25000, { accountFrom: "fa-boi-0451", accountTo: "fa-cash-01", receivedAmount: 25000, convRate: 1, toCurrency: "INR", payee: "ATM cash withdrawal", category: "Transfer" }),
    txn("mc-ng-9", md(0, 14), "credit", 309500, { accountTo: "fa-boi-0451", payee: "INWARD REMITTANCE 0013IRT26001022", category: "Inward Remittance", notes: "Inward remittance 0013IRT26001022 · EUR 3,200.00 @ ROE 97.1 · Remitter: MAISON CRISTAL" }),
    { ...txn("mc-ng-10", md(0, 16), "credit", 4200, { accountTo: "fa-eefc", payee: "NAKAMURA MINERALS CO", category: "Inward Remittance", notes: "Inward remittance 0013IRT26001041 · USD 4,200.00 credited to EEFC account" }), currency: "USD" },
  ],

  // NG's remittance register: one tied out (invoice + advance), one half-tied.
  // The EEFC credit from Nakamura (mc-ng-10) is deliberately not entered.
  "er-ng-remittances-v1": [
    { id: "rem-demo-1", irt: "0013IRT26000910", date: md(-1, 4), currency: "USD", amount: 5725, settlement: "converted", rate: 95.4, inrCredited: 545020, grossInr: 546165, charges: 1145, chargeCurrency: "INR", remitter: "ELENA VASQUEZ", buyer: "Elena Vasquez", purpose: "Export of goods", advance: true, expectedShipDate: md(1, 10), advanceNote: "Balance for the January order", source: "boi-advice", createdAt: ts(md(-1, 4)) },
    { id: "rem-demo-2", irt: "0013IRT26001022", date: md(0, 14), currency: "EUR", amount: 3200, settlement: "converted", rate: 97.1, inrCredited: 309500, charges: null, chargeCurrency: "INR", remitter: "MAISON CRISTAL", buyer: "Sophie Laurent", source: "boi-advice", createdAt: ts(md(0, 14)) },
  ],

  // Atyahara's FIRCs and courier shipping bills in Export Recon.
  "er-meta-v5:atyahara": {
    fircs: [
      { id: "firc-demo-1", number: "0013IRT26001090", date: md(0, 13), amount: "118750", foreignAmount: "1250", currency: "USD", exchangeRate: "95.0", charges: "", buyerName: "Luna Crystals LLC", bankName: "Bank of India", hasPdf: false },
      { id: "firc-demo-2", number: "CITIN26114820031", date: md(-1, 10), amount: "42000", foreignAmount: "500", currency: "USD", exchangeRate: "84", charges: "0", buyerName: "Etsy (Payoneer)", hasPdf: false },
    ],
    shippingBills: [
      { id: "sb-demo-1", sbNumber: "CSBV_DEL_2026-2027_0920_31450", date: md(-1, 20), amount: "60000", fircId: "firc-demo-1", status: "prepared", sbType: "csb" },
      { id: "sb-demo-2", sbNumber: "CSBV_DEL_2026-2027_1002_31688", date: md(0, 2), amount: "58750", fircId: "firc-demo-1", status: "pending", sbType: "csb" },
      { id: "sb-demo-3", sbNumber: "CSBV_DEL_2026-2027_0905_30911", date: md(-1, 5), amount: "42000", fircId: "firc-demo-2", status: "cleared", sbType: "csb" },
      { id: "sb-demo-4", sbNumber: "CSBV_DEL_2026-2027_1018_31902", date: md(0, 18), amount: "15500", fircId: null, status: "pending", sbType: "csb" },
    ],
    invoices: [],
  },

  "at-fin-accounts-v1": [
    { id: "at-induslnd", name: "IndusInd Bank", type: "bank", currency: "INR", openingBal: 120000, active: true },
    { id: "at-boi", name: "Bank of India", type: "bank", currency: "INR", openingBal: 80000, active: true },
  ],
  "at-fin-txns-v1": [
    txn("mc-at-1", md(-1, 5), "credit", 96400, { accountTo: "at-induslnd", payee: "PAYONEER INC", category: "customer_receipt", classifiedAs: "customer_receipt", classifiedRef: { invoiceIds: [], unapplied: true, buyer: "Etsy payout" } }),
    txn("mc-at-2", md(-1, 12), "debit", 22000, { accountFrom: "at-induslnd", payee: "SALARY OCT PACKING STAFF", category: "Salary", classifiedAs: "expense", classifiedBy: "demo", classifiedRef: { cat: "Salary" } }),
    txn("mc-at-3", md(0, 4), "debit", 6400, { accountFrom: "at-induslnd", payee: "INDIA POST BOOKING", category: "UPI" }),
    txn("mc-at-4", md(0, 9), "debit", 15000, { accountFrom: "at-induslnd", payee: "SHRI PROPERTIES", category: "Rent", classifiedAs: "expense", classifiedBy: "demo", classifiedRef: { cat: "Rent" } }),
    txn("mc-at-5", md(0, 13), "credit", 118750, { accountTo: "at-boi", payee: "INWARD REMITTANCE 0013IRT26001090", category: "Inward Remittance", notes: "Inward remittance 0013IRT26001090 · USD 1,250.00 @ ROE 95.0 · Remitter: LUNA CRYSTALS LLC" }),
    txn("mc-at-6", md(0, 19), "debit", 3150, { accountFrom: "at-boi", payee: "BOI CHARGES INWARD REM", category: "Bank Charges", classifiedAs: "expense", classifiedBy: "demo", classifiedRef: { cat: "Bank Charges" } }),
  ],
};

// Statement month-ends, worked out from the demo ledger itself so the demo always
// shows one month that ties out and one that is short a bank charge.
function demoStatements(accounts, txns, plan) {
  return plan.map(([accountId, offset, gap, fileName]) => {
    const acc = accounts.find(a => a.id === accountId);
    const month = md(offset, 1).slice(0, 7);
    const closingDate = monthEndDate(month);
    const flows = accountMonthFlows(acc, txns, month);
    return {
      id: statementId(accountId, month), accountId, month, closingDate, fromDate: `${month}-01`,
      closing: accountBalanceAt(acc, txns, closingDate) - gap,
      credits: flows.credits, debits: flows.debits + gap, rows: flows.count + (gap ? 1 : 0),
      source: "statement", fileName, savedAt: ts(closingDate),
    };
  });
}

// Arrays named in APPEND are added to the base demo list; everything else replaces it.
const APPEND = new Set(["ng-fin-txns-v1"]);
export function mergeDemoFinance(base) {
  Object.entries(DEMO_FINANCE).forEach(([k, v]) => {
    base[k] = APPEND.has(k) && Array.isArray(base[k]) ? [...base[k], ...v] : v;
  });
  // Tie the demo invoices to their shipping bills and remittances.
  base["ng-invoices-v2"] = (base["ng-invoices-v2"] || []).map(inv =>
    inv.id === "inv-1" ? { ...inv, sbNo: "4417825", sbDate: md(-1, 2), _remittances: [{ id: "rem-demo-1", alloc: 4850, irt: "0013IRT26000910", currency: "USD" }] }
    : inv.id === "inv-3" ? { ...inv, sbNo: "4433190", sbDate: md(0, 6), _remittances: [{ id: "rem-demo-2", alloc: 1600, irt: "0013IRT26001022", currency: "EUR" }] }
    : inv.id === "inv-2" ? { ...inv, sbNo: "4440012", sbDate: md(0, 9) }
    : inv);
  base["ng-fin-statements-v1"] = demoStatements(base["ng-fin-accounts-v1"], base["ng-fin-txns-v1"], [
    ["fa-boi-0451", -2, 0, "BOI-0451-statement.pdf"],
    ["fa-boi-0451", -1, 590, "BOI-0451-statement.pdf"],
    ["fa-eefc", -1, 0, "EEFC-statement.csv"],
  ]);
  base["at-fin-statements-v1"] = demoStatements(base["at-fin-accounts-v1"], base["at-fin-txns-v1"], [
    ["at-induslnd", -1, 0, "IndusInd-statement.xlsx"],
  ]);
  return base;
}
