/* Book the bank's fees on an inward remittance, read off the BOI advice.

   Converted to INR: the bank took its commission + GST before crediting, so the
   ledger only ever shows the net — the fees exist nowhere else. They are booked
   as a Bank Charges expense (Expenses module), tagged with the remittance.
   Kept in EEFC: the bank debits the fees from the INR account separately, so
   that debit is in the bank ledger once the statement is in. It is classified
   as Bank Charges rather than booked again, which would count it twice. */

import { loadKFresh, saveK, uid } from "./utils.js";
import { NG_REMIT_KEY, isBoiAccount, isEefc } from "./remittances.js";
import { quickClassifyExpense } from "./quickClassify.js";

const day = d => new Date(`${d}T12:00:00`).getTime() / 86400000;

// The INR debit an EEFC remittance's fees came out as, if it is in the ledger yet.
export function feeDebitFor(rem, txns = [], accounts = []) {
  const charges = +rem.charges || 0;
  if (!(charges > 0) || !rem.date) return null;
  const accById = new Map(accounts.map(a => [a.id, a]));
  return txns.find(t => t.type === "debit" && isBoiAccount(accById.get(t.accountFrom)) && (t.currency || "INR") === "INR" &&
    Math.abs((+t.amount || 0) - charges) < 1 && t.date && Math.abs(day(t.date) - day(rem.date)) <= 5) || null;
}

export const feesBooked = rem => !!rem.feesBookedAt || !(+rem.charges > 0);

export async function bookRemittanceFees({ rem, txns, accounts, isUnclassified }) {
  const charges = +rem.charges || 0;
  if (!(charges > 0)) throw new Error("No fees entered on this remittance.");
  const now = new Date().toISOString();
  let patch;
  if (isEefc(rem)) {
    const debit = feeDebitFor(rem, txns, accounts);
    if (!debit) throw new Error(`The ₹${charges.toLocaleString("en-IN")} fee debit isn't in the bank ledger yet — import the BOI statement, then book again.`);
    if (isUnclassified(debit)) await quickClassifyExpense({ company: "ng", txn: debit, cat: "Bank Charges" });
    patch = { feesBookedAt: now, feesTxnId: debit.id };
  } else {
    const fresh = await loadKFresh("ng-expenses-v1");
    const list = (Array.isArray(fresh) ? fresh : []).filter(e => e.remittanceId !== rem.id);
    const exp = {
      id: "exp-" + uid(), date: rem.date || now.slice(0, 10), cat: "Bank Charges", party: "Bank of India", amount: charges, currency: "INR",
      notes: `Commission + GST on inward remittance ${rem.irt || ""}${rem.buyer ? ` from ${rem.buyer}` : ""}`.trim(), remittanceId: rem.id, source: "remittance-fees", createdAt: now,
    };
    await saveK("ng-expenses-v1", [exp, ...list]);
    patch = { feesBookedAt: now, feesExpenseId: exp.id };
  }
  const remFresh = await loadKFresh(NG_REMIT_KEY);
  const remits = Array.isArray(remFresh) ? remFresh : [];
  const saved = { ...(remits.find(r => r.id === rem.id) || rem), ...patch };
  await saveK(NG_REMIT_KEY, remits.some(r => r.id === rem.id) ? remits.map(r => (r.id === rem.id ? saved : r)) : [saved, ...remits]);
  return saved;
}
