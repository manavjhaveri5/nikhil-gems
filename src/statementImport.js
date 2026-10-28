/* What happens when a bank statement import is applied (Finance → Reconcile and
   Accounting → Bank statements both use this): new rows go into the company's
   ledger, rows the bank doesn't have come out, the account's opening balance is
   set if asked, and the statement's month-end balances are kept for Month close
   (a statement starting partway through a month never replaces a fuller one). */

import { loadKFresh, saveK, upsertItemK } from "./utils.js";
import { statementsKey, statementId, keepExistingStatement } from "./monthClose.js";

export async function applyStatementImport({ company, accounts, txns, add = [], removeIds = [], openingBalance = null, accountId = null, statementClosings = [], fileName = "" }) {
  const rm = new Set(removeIds);
  const nextTxns = [...add, ...txns.filter(t => !rm.has(t.id))];
  if (add.length || removeIds.length) await saveK(`${company}-fin-txns-v1`, nextTxns);

  let nextAccounts = accounts, obMsg = "";
  if (openingBalance != null && accountId) {
    nextAccounts = accounts.map(a => (a.id === accountId ? { ...a, openingBal: +openingBalance } : a));
    await saveK(`${company}-fin-accounts-v1`, nextAccounts);
    obMsg = ` · opening bal ₹${(+openingBalance).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
  }

  let stMsg = "", statements = null;
  if (accountId && statementClosings.length) {
    const savedAt = new Date().toISOString();
    const prev = await loadKFresh(statementsKey(company)).catch(() => []);
    const kept = statementClosings
      .map(c => ({ ...c, id: statementId(accountId, c.month), accountId, source: "statement", fileName, savedAt }))
      .filter(rec => !keepExistingStatement((Array.isArray(prev) ? prev : []).find(x => x.id === rec.id), rec));
    for (const rec of kept) statements = await upsertItemK(statementsKey(company), rec);
    stMsg = ` · ${kept.length} month-end balance${kept.length === 1 ? "" : "s"} kept`;
  }

  const message = [add.length ? `${add.length} added` : "", removeIds.length ? `${removeIds.length} removed` : ""].filter(Boolean).join(" · ")
    + (add.length || removeIds.length ? " — ledger matches bank" : "Statement saved") + obMsg + stMsg;
  // statements: the full saved list when month-ends were kept (null otherwise).
  return { txns: nextTxns, accounts: nextAccounts, statements: Array.isArray(statements) && statements.length ? statements : null, message };
}
