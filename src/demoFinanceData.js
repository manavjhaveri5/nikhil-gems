// ─── DEMO DATA — month close (demo mode only) ─────────────────────────────
// Bank ledgers, statements and remittances for both companies, dated in this
// month and the last two so the Ledger's Month close always has a live month to
// show. Merged into DEMO_DATA by demoData.js. All names and amounts are fictional.

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

// Arrays named in APPEND are added to the base demo list; everything else replaces it.
const APPEND = new Set(["ng-fin-txns-v1"]);
export function mergeDemoFinance(base) {
  Object.entries(DEMO_FINANCE).forEach(([k, v]) => {
    base[k] = APPEND.has(k) && Array.isArray(base[k]) ? [...base[k], ...v] : v;
  });
  return base;
}
