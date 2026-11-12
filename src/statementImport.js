/* What happens when a bank statement import is applied (Finance → Reconcile and
   Accounting → Bank statements both use this): new rows go into the company's
   ledger, rows the bank doesn't have come out, the account's opening balance is
   set if asked, and the statement's month-end balances are kept for Month close
   (a statement starting partway through a month never replaces a fuller one). */

import { loadKFresh, saveK, upsertItemK } from "./utils.js";
import { statementsKey, statementId, keepExistingStatement } from "./monthClose.js";
import { uploadToStorage } from "./storageUtils.js";
import { classifyCardEmis } from "./cardEmi.js";
import { bookOdTransfers } from "./odTransfers.js";

const MON = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
const uid = () => Math.random().toString(36).slice(2, 11);

/* Where each statement row sits in the PDF: the page and the printed line that
   carries its date and amount. pageLines is one array of text lines per page
   (pdf.js text, grouped into lines). Each printed line is used once, so two
   identical payments on one day land on their own lines. Rows not found get null. */
export function locateStatementRows(pageLines = [], rows = []) {
  const used = new Set();
  return rows.map(r => {
    const amt = (+r.amount || 0).toFixed(2);
    const [y, m, d] = String(r.date || "").split("-");
    if (!y || !m || !d) return null;
    const dates = [`${d}-${m}-${y}`, `${d}/${m}/${y}`, `${d}-${m}-${y.slice(2)}`, `${d}/${m}/${y.slice(2)}`, `${d}.${m}.${y}`,
      `${+d} ${MON[+m - 1]}`, `${d} ${MON[+m - 1]}`, `${d}-${MON[+m - 1]}`, `${d}/${MON[+m - 1]}`];
    const amtRe = new RegExp(`(^|[^\\d.])${amt.replace(".", "\\.")}(?!\\d)`);
    for (let p = 0; p < pageLines.length; p++) {
      const lines = pageLines[p] || [];
      for (let i = 0; i < lines.length; i++) {
        const key = `${p}:${i}`;
        if (used.has(key)) continue;
        const low = String(lines[i]).toLowerCase();
        if (!dates.some(x => low.includes(x))) continue;
        // A long description wraps, and the amount can land on the next line or two:
        // read on until the next line that starts another dated row.
        let text = String(lines[i]);
        for (let k = i + 1; k < Math.min(lines.length, i + 4); k++) {
          if (/\b\d{1,2}[-/.](\d{1,2}|[a-z]{3})[-/.]\d{2,4}\b/i.test(lines[k])) break;
          text += " " + lines[k];
        }
        if (!amtRe.test(text.replace(/,/g, ""))) continue;
        used.add(key);
        return { page: p + 1, line: text.replace(/\s+/g, " ").trim().slice(0, 160) };
      }
    }
    return null;
  });
}

// The packet row a statement belongs in, by the kind of account it is for.
const packetRowFor = acc => (acc?.type === "credit_card" ? "credit-cards" : "bank-statement");
const PACKET_ROWS = { "credit-cards": "Credit card statements", "bank-statement": "Bank statement" };

/* Keep the statement PDF: upload it, file it in the Monthly Packet of every
   month it covers, and return its public URL. */
async function keepStatementPdf({ company, acc, doc, months }) {
  const first = months[0] || new Date().toISOString().slice(0, 7);
  const rowId = packetRowFor(acc);
  const file = new File([doc.bytes], doc.name || "statement.pdf", { type: "application/pdf" });
  const url = await uploadToStorage(`accounting-packets/${first}/${rowId}-${uid()}.pdf`, file);
  if (company === "ng") {
    const key = "ng-accountant-packets-v1";
    const prev = await loadKFresh(key).catch(() => []);
    const list = Array.isArray(prev) ? [...prev] : [];
    const entry = { id: uid(), name: doc.name || "statement.pdf", url, size: doc.bytes.byteLength || 0, type: "application/pdf", uploadedAt: new Date().toISOString() };
    for (const month of months) {
      let pk = list.find(x => x.month === month);
      if (!pk) { pk = { month, rows: [], notes: "" }; list.push(pk); }
      const rows = Array.isArray(pk.rows) ? [...pk.rows] : [];
      if (!rows.some(r => r.id === rowId)) rows.push({ id: rowId, title: PACKET_ROWS[rowId], source: "Manual upload", mode: "manual", included: true, notes: "", files: [] });
      pk.rows = rows.map(r => (r.id === rowId ? { ...r, files: [...(r.files || []), entry] } : r));
      pk.updatedAt = entry.uploadedAt;
    }
    list.sort((a, b) => (b.month || "").localeCompare(a.month || ""));
    await saveK(key, list);
  }
  return url;
}

export async function applyStatementImport({ company, accounts, txns, add = [], removeIds = [], openingBalance = null, accountId = null, statementClosings = [], fileName = "", statementDoc = null, rowRefs = {} }) {
  const rm = new Set(removeIds);
  // statementDoc: { bytes, name } of the PDF; rowRefs: ledger id -> { page, line }.
  // The PDF is kept and every row read off it points at its page.
  let fileUrl = "", docMsg = "";
  if (statementDoc?.bytes && accountId) {
    try {
      const months = [...new Set([...statementClosings.map(c => c.month), ...add.map(t => String(t.date || "").slice(0, 7))].filter(Boolean))].sort();
      fileUrl = await keepStatementPdf({ company, acc: accounts.find(a => a.id === accountId), doc: statementDoc, months });
      docMsg = " · PDF kept";
    } catch (e) { docMsg = ` · PDF not kept (${e.message})`; }
  }
  const link = t => (fileUrl && rowRefs[t.id] ? { ...t, stmtRef: { url: fileUrl, page: rowRefs[t.id].page, line: rowRefs[t.id].line, name: statementDoc.name || fileName } } : t);
  let nextTxns = [...add.map(link), ...txns.filter(t => !rm.has(t.id)).map(link)];
  // Card EMI instalments in the new rows are booked the way the last ones were.
  let emiMsg = "";
  if (add.length) {
    const expKey = company === "ng" ? "ng-expenses-v1" : "at-expenses-v1";
    const { patches, expenses } = classifyCardEmis(nextTxns, { only: new Set(add.map(t => t.id)), expenseKey: expKey });
    if (expenses.length) {
      nextTxns = nextTxns.map(t => (patches[t.id] ? { ...t, ...patches[t.id] } : t));
      const prevEx = await loadKFresh(expKey).catch(() => []);
      await saveK(expKey, [...expenses, ...(Array.isArray(prevEx) ? prevEx : [])]);
      emiMsg = ` · ${expenses.length} EMI line${expenses.length === 1 ? "" : "s"} booked`;
    }
  }
  // Money to or from the overdraft is a transfer with the OD account, so its balance moves.
  let odMsg = "";
  if (add.length) {
    const od = bookOdTransfers(nextTxns, accounts, new Set(add.map(t => t.id)));
    if (od.count) { nextTxns = od.txns; odMsg = ` · ${od.count} OD transfer${od.count === 1 ? "" : "s"} booked`; }
  }
  if (add.length || removeIds.length || (fileUrl && Object.keys(rowRefs).length)) await saveK(`${company}-fin-txns-v1`, nextTxns);

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
      .map(c => ({ ...c, id: statementId(accountId, c.month), accountId, source: "statement", fileName, ...(fileUrl ? { fileUrl } : {}), savedAt }))
      .filter(rec => !keepExistingStatement((Array.isArray(prev) ? prev : []).find(x => x.id === rec.id), rec));
    for (const rec of kept) statements = await upsertItemK(statementsKey(company), rec);
    stMsg = ` · ${kept.length} month-end balance${kept.length === 1 ? "" : "s"} kept`;
  }

  const message = [add.length ? `${add.length} added` : "", removeIds.length ? `${removeIds.length} removed` : ""].filter(Boolean).join(" · ")
    + (add.length || removeIds.length ? " — ledger matches bank" : "Statement saved") + obMsg + stMsg + docMsg + emiMsg + odMsg;
  // statements: the full saved list when month-ends were kept (null otherwise).
  return { txns: nextTxns, accounts: nextAccounts, statements: Array.isArray(statements) && statements.length ? statements : null, message };
}
