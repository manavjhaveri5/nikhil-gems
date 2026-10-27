/* Classify a payment under an expense head without opening the Ledger — the
   Home page's one-tap path. Writes exactly what the Ledger's classify writes for
   an expense (ClassifyTransaction → handleStructuredClassify): the entry's head,
   the matching record in the Expenses module, and the precedent the learner
   suggests from next time. Vendor bills, card payments and transfers need the
   full form (bills to pick, accounts to choose), so they open the Ledger. */

import { loadKFresh, saveK, uid } from "./utils.js";
import { recordDecision } from "./classifyLearner.js";

const txnsKey = co => `${co}-fin-txns-v1`;
const expensesKey = co => (co === "ng" ? "ng-expenses-v1" : "at-expenses-v1");

export async function quickClassifyExpense({ company, txn, cat }) {
  const now = new Date().toISOString();
  const party = txn.payee || "";
  const fresh = await loadKFresh(txnsKey(company));
  const list = Array.isArray(fresh) ? fresh : [];
  const latest = list.find(t => t.id === txn.id) || txn;
  const saved = {
    ...latest, category: cat, classifiedAs: "expense", classifiedRef: { cat, party },
    classifiedAt: now, classifiedBy: "home-quick", updatedAt: now,
    classifiedSnapshot: { payee: latest.payee || "", notes: latest.notes || "", type: latest.type || "debit", att: "" },
  };
  await saveK(txnsKey(company), list.map(t => (t.id === txn.id ? saved : t)));

  const exFresh = await loadKFresh(expensesKey(company));
  const expenses = (Array.isArray(exFresh) ? exFresh : []).filter(e => e.ledgerTxnId !== txn.id);
  await saveK(expensesKey(company), [{
    id: "exp-" + uid(), date: latest.date, cat, party, amount: +latest.amount || 0, currency: latest.currency || "INR",
    notes: latest.notes || "", payFromAccount: latest.accountFrom, createdAt: now, ledgerTxnId: txn.id,
  }, ...expenses]);

  recordDecision(company, saved, { classifiedAs: "expense", cat, party }).catch(() => {});
  return { saved, before: latest };
}

// Put an entry back the way it was before a quick classify, and drop its expense record.
export async function undoQuickClassify({ company, before }) {
  const fresh = await loadKFresh(txnsKey(company));
  const list = Array.isArray(fresh) ? fresh : [];
  await saveK(txnsKey(company), list.map(t => (t.id === before.id ? { ...before, updatedAt: new Date().toISOString() } : t)));
  const exFresh = await loadKFresh(expensesKey(company));
  await saveK(expensesKey(company), (Array.isArray(exFresh) ? exFresh : []).filter(e => e.ledgerTxnId !== before.id));
}
