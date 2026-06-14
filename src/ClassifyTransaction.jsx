import { useState, useEffect } from "react";
import { C, FI, Field } from "./ui.jsx";
import { mob, uid, fmtDate } from "./utils.js";
import { aiSuggest } from "./classifyLearner.js";

// Shared "Classify Transaction" modal used by BOTH finance UIs:
//   • Finance module        (src/FinanceApp.jsx, admin)
//   • Accounting Journal     (nikhil-gems-v6.jsx → AccountingFinanceLedger, accountant)
// Keep the classification LOGIC here so it can never drift between the two screens.
// Visibility differences (bank balances etc.) live in the surrounding ledgers, not here.
//
// Result contract — always calls:
//   onSave({ classifiedAs, classifiedRef, sideEffects })
// sideEffects may include: newExpense, billUpdates, vendorCredit, poUpdate,
//   invoiceUpdates, attachments, and txnPatch (merged onto the ledger txn — used by
//   the currency-conversion reclassification). No txnId arg; no _accountPatch.

const DEFAULT_RATES = { USD: 85, EUR: 92, JPY: 0.57, GBP: 107, AUD: 55, INR: 1 };
const CUR_SYM = { INR: "₹", USD: "$", EUR: "€", JPY: "¥", GBP: "£", AUD: "A$" };

export default function ClassifyTransactionModal({
  txn, accounts = [], vendors = [], purchases = [], invoices = [], buyers = [],
  rates, categoryGroups, expenseCats = [], customCats = [], onAddCustomCat, normalizeCat, suggestedType,
  learned = null, learnMemory = [], embMap = {}, company = "ng", enableLearner = false, interCo = null, reclassifyDirty = false, onSave, onClose,
}) {
  // The learner's local match (if any) pre-fills the form for unclassified txns.
  const L = (!txn.classifiedAs && learned) ? learned : null;
  const R = { ...DEFAULT_RATES, ...(rates || {}) };
  const toInr = (amt, currency) => (+amt || 0) * (R[currency || "INR"] || 1);
  const fromInr = (amt, currency) => (+amt || 0) / (R[currency || "INR"] || 1);
  const convertMoney = (amt, from, to) => (from === to ? (+amt || 0) : fromInr(toInr(amt, from), to));
  const moneyText = (amt, currency) => `${currency || "INR"} ${(+amt || 0).toLocaleString("en-IN", { minimumFractionDigits: currency === "JPY" ? 0 : 2, maximumFractionDigits: currency === "JPY" ? 0 : 2 })}`;
  const norm = typeof normalizeCat === "function" ? normalizeCat : (x => x);
  const catGroups = (categoryGroups && categoryGroups.length) ? categoryGroups : [{ label: "Categories", cats: expenseCats }];

  const isDebit = txn.type !== "credit";
  const txnAmt = +txn.amount || 0;
  const cur = txn.currency || "INR";
  const sym = CUR_SYM[cur] || cur + " ";

  const allowedTypes = isDebit
    ? ["expense", "vendor_bill", "vendor_po", "cc_payment", "conversion"]
    : ["customer_receipt", "cc_payment", "conversion", "expense"];
  const [classType, setClassType] = useState(() => {
    if (txn.classifiedAs) return txn.classifiedAs;
    if (interCo?.active && isDebit) return "vendor_bill"; // paying the other company → settle their invoice
    if (L && allowedTypes.includes(L.classifiedAs)) return L.classifiedAs; // learned from your history
    if (suggestedType && allowedTypes.includes(suggestedType)) return suggestedType; // pre-point to the (implicit) suggestion
    if (!isDebit) return "customer_receipt";
    const c = (txn.category || "").toLowerCase();
    if (c.includes("purchase") || c.includes("vendor") || c.includes("goods")) return "vendor_bill";
    if (c.includes("advance")) return "vendor_po";
    if (c.includes("credit card")) return "cc_payment";
    return "expense";
  });
  const guessVendor = () => {
    const p = (txn.payee || "").toLowerCase();
    return vendors.find(v => { const n = (v.name || "").toLowerCase(); return n && p && (n.includes(p) || p.includes(n) || p.split(/\s+/).some(w => w.length > 3 && n.includes(w))); })?.id || "";
  };
  const [vendorId, setVendorId] = useState(txn.classifiedRef?.vendorId || L?.vendorId || guessVendor());
  const [selectedBillIds, setSelectedBillIds] = useState(() => new Set(txn.classifiedRef?.billIds || (txn.classifiedRef?.billId ? [txn.classifiedRef.billId] : [])));
  const [selectedPoId, setSelectedPoId] = useState(txn.classifiedRef?.poId || "");
  // Inter-company: pick the OTHER company's invoice this payment settles. Pre-select the
  // one whose number appears in the notes/payee (e.g. "Payment against NG-04-2026/27").
  const interInvs = interCo?.invoices || [];
  const interInvNo = inv => String(inv.invNo || inv.invNumber || inv.number || "");
  const guessedInterId = (() => {
    const hay = `${txn.notes || ""} ${txn.payee || ""}`.toLowerCase().replace(/\s+/g, "");
    return interInvs.find(inv => { const n = interInvNo(inv).toLowerCase().replace(/\s+/g, ""); return n && hay.includes(n); })?.id || "";
  })();
  const [interCoInvId, setInterCoInvId] = useState(txn.classifiedRef?.interCoInvoiceId || guessedInterId);
  const [selectedInvIds, setSelectedInvIds] = useState(() => new Set(txn.classifiedRef?.invoiceIds || (txn.classifiedRef?.invoiceId ? [txn.classifiedRef.invoiceId] : [])));
  const [linkedInvId, setLinkedInvId] = useState(txn.classifiedRef?.linkedInvoiceId || "");
  const [recvDiffMode, setRecvDiffMode] = useState(txn.classifiedRef?.differenceMode || "bank_charges");
  const [convOtherAcct, setConvOtherAcct] = useState(txn.classifiedRef?.convOtherAccountId || "");
  const [convRateInput, setConvRateInput] = useState(txn.classifiedRef?.rate ? String(txn.classifiedRef.rate) : "");
  const rawCat = txn.classifiedRef?.cat || txn.category || "";
  // Recommend a category. If already classified, respect the saved category. Otherwise guess from
  // the best hint — an explicit category, then the details/notes (e.g. "FOOD") and the payee. When
  // nothing maps to a main category, surface a tidy sub-category under "Other" (e.g. Specify "Food")
  // so the user gets a real suggestion instead of a bare "Other".
  const guessedCat = (() => {
    const titleCase = s => { const t = String(s || "").trim().replace(/\s+/g, " "); return t ? t.charAt(0).toUpperCase() + t.slice(1).toLowerCase() : ""; };
    // Learned category from your history wins for unclassified expenses.
    if (L && L.classifiedAs === "expense" && L.cat) {
      const n = norm(L.cat);
      return expenseCats.includes(n) ? { cat: n, specify: "" } : { cat: "Other", specify: L.cat };
    }
    const explicit = txn.classifiedRef?.cat;
    if (explicit) {
      const n = norm(explicit);
      return expenseCats.includes(n) ? { cat: n, specify: "" } : { cat: "Other", specify: explicit };
    }
    for (const c of [txn.category, txn.notes, txn.payee].map(x => String(x || "").trim()).filter(Boolean)) {
      const n = norm(c);
      if (expenseCats.includes(n) && n !== "Other") return { cat: n, specify: "" };
    }
    if (txn.category && !expenseCats.includes(norm(txn.category))) return { cat: "Other", specify: txn.category };
    const hint = String(txn.notes || "").trim();
    return { cat: expenseCats.includes("Other") ? "Other" : (expenseCats[0] || ""), specify: hint.length <= 24 ? titleCase(hint) : "" };
  })();
  const [expCat, setExpCat] = useState(guessedCat.cat);
  // Free-text sub-category under "Other" (e.g. "Milk"/"Food"). Saved as the real category but kept
  // out of the main picker; remembered for next time.
  const [otherCat, setOtherCat] = useState(guessedCat.specify);
  const [catOpen, setCatOpen] = useState(false);
  // Prefill the party from the (cleaned, editable) payee shown in the ledger. A stale
  // classifiedRef.party often holds the raw bank narration from an earlier classify, so
  // only fall back to it when there's no payee.
  const [expParty, setExpParty] = useState(txn.payee || L?.party || txn.classifiedRef?.party || "");
  const [expNotes, setExpNotes] = useState((L && L.notes) || txn.notes || "");
  const [notesTouched, setNotesTouched] = useState(false); // true once the user types in Details/Notes
  const cardAccounts = accounts.filter(a => a.type === "credit_card" && a.active !== false);
  const cardSpendAccount = cardAccounts.find(a => a.id === txn.accountFrom);
  const guessCard = () => {
    const p = `${txn.payee || ""} ${txn.notes || ""}`.toLowerCase();
    return cardAccounts.find(a => { const n = (a.name || "").toLowerCase(); return n && p && (p.includes(n) || n.includes(p) || n.split(/\s+/).filter(w => w.length > 3).some(w => p.includes(w))); })?.id || cardAccounts[0]?.id || "";
  };
  const [ccAccountId, setCcAccountId] = useState(txn.classifiedRef?.cardAccountId || (L?.classifiedAs === "cc_payment" ? L.cardAccountId : "") || guessCard());
  const vendor = vendors.find(v => v.id === vendorId);

  // ── Learner: pre-fill from local history (L, done above) or, for unseen txns, ask AI ──
  const applySuggestion = s => {
    if (!s) return;
    if (s.classifiedAs && allowedTypes.includes(s.classifiedAs)) setClassType(s.classifiedAs);
    if (s.classifiedAs === "expense" && s.cat) {
      const n = norm(s.cat);
      if (expenseCats.includes(n)) { setExpCat(n); setOtherCat(""); }
      else { setExpCat(expenseCats.includes("Other") ? "Other" : (expenseCats[0] || "")); setOtherCat(s.cat); }
    }
    if (s.party || s.payee) setExpParty(s.party || s.payee);
    if (s.notes) setExpNotes(s.notes);
    if (s.vendorId) setVendorId(s.vendorId);
    if (s.cardAccountId) setCcAccountId(s.cardAccountId);
  };
  const [aiSug, setAiSug] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiApplied, setAiApplied] = useState(false);
  const [aiAutoApplied, setAiAutoApplied] = useState(false);
  const CONF_HIGH = 0.75;
  // Confident local match short-circuits AI (instant, free). A weak local match still
  // pre-fills fields above, but we still ask the AI to firm up the classification.
  const localConfident = L && L.classifiedAs && L.confidence >= 0.6 && L.count >= 2;
  useEffect(() => {
    // Run AI for unclassified txns, OR when reclassifying a txn whose payee/notes/type
    // changed since it was classified. Skip when already classified & unchanged, or a
    // confident local match exists.
    if (!enableLearner || (txn.classifiedAs && !reclassifyDirty) || localConfident) return;
    let alive = true;
    setAiLoading(true);
    aiSuggest({ company, txn, memory: learnMemory, embMap, expenseCats })
      .then(s => {
        if (!alive || !s) return;
        setAiSug(s);
        // High confidence → pre-fill silently (ambient). Low → leave as a soft hint.
        if (s.confidence >= CONF_HIGH) { applySuggestion(s); setAiAutoApplied(true); }
      })
      .finally(() => { if (alive) setAiLoading(false); });
    return () => { alive = false; };
  }, []); // run once when the modal opens
  const labelOf = s => {
    if (!s) return "";
    if (s.classifiedAs === "expense") return `Expense · ${(s.classifiedAs === "expense" && s.cat) ? s.cat : "Other"}`;
    return { vendor_bill: "Vendor Bill Payment", vendor_po: "Advance against PO", cc_payment: "Credit Card Payment", customer_receipt: "Sales Receipt", conversion: "Currency Conversion" }[s.classifiedAs] || s.classifiedAs;
  };
  const vendorNameOf = p => p.supplier || p.vendorName || p.vendor || "";
  const matchesVendor = p => {
    if (!vendorId) return true;
    if (p.vendorId === vendorId) return true;
    const s = vendorNameOf(p).toLowerCase(), v = (vendor?.name || "").toLowerCase();
    return s && v && (s.includes(v) || v.includes(s) || v.split(/\s+/).filter(w => w.length > 2).some(w => s.includes(w)));
  };
  const allBills = purchases.filter(p => p.type === "bill");
  // Bills already linked to THIS payment stay visible even after they're marked paid.
  const linkedBillIds = new Set(txn.classifiedRef?.billIds || (txn.classifiedRef?.billId ? [txn.classifiedRef.billId] : []));
  const allOpenBills = allBills.filter(p => p.status !== "paid" || linkedBillIds.has(p.id));
  // When a vendor is chosen, also surface that vendor's PAID bills so a bank payment
  // (e.g. one already settled in the Finance module) can still be linked to the bill
  // and its document attached. Selecting a fully-paid bill adds ₹0 (paying is capped at
  // the amount due), so it never double-pays.
  const vendorBills = vendorId ? allBills.filter(matchesVendor) : allOpenBills.filter(matchesVendor);
  const vendorPOs = purchases.filter(p => p.type === "po" && !["paid", "closed", "cancelled"].includes(p.status || "open")).filter(matchesVendor);
  // Invoices already linked to THIS receipt (so a reviewed receipt still shows its
  // invoice even though classifying it flipped the invoice's status to "paid").
  const linkedInvIds = new Set(txn.classifiedRef?.invoiceIds || (txn.classifiedRef?.invoiceId ? [txn.classifiedRef.invoiceId] : []));
  const openInvoices = (invoices || []).filter(inv => !["paid", "cancelled", "draft"].includes(inv.status || "draft") || linkedInvIds.has(inv.id)).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const selectedBills = vendorBills.filter(b => selectedBillIds.has(b.id));
  const selectedInvs = openInvoices.filter(i => selectedInvIds.has(i.id));
  const billDue = b => Math.max(0, (+b.totalAmount || 0) - (+b.paidAmount || 0));
  const invTotal = inv => +inv.totalAmt || (inv.items || []).reduce((s, i) => s + (+i.amt || 0), 0);
  const invPaid = inv => (+inv.paidAmount || 0) + (inv.payments || []).reduce((s, p) => s + (+p.amount || 0), 0);
  const invDue = inv => Math.max(0, invTotal(inv) - invPaid(inv));
  const totalBillsDue = selectedBills.reduce((s, b) => s + billDue(b), 0);
  const selectedInvDueByCurrency = selectedInvs.reduce((acc, inv) => { const invCur = inv.currency || "USD"; acc[invCur] = (acc[invCur] || 0) + invDue(inv); return acc; }, {});
  const totalInvDueInTxnCurrency = selectedInvs.reduce((s, inv) => s + convertMoney(invDue(inv), inv.currency || "USD", cur), 0);
  const toggleBill = id => setSelectedBillIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleInv = id => setSelectedInvIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const types = isDebit ? [
    ["expense", "Expense", "Rent, freight, salary, etc.", C.amber],
    ["vendor_bill", "Vendor Bill Payment", "Apply against an existing bill", C.blue],
    ["vendor_po", "Advance against PO", "Advance payment on a Purchase Order", C.purple],
    ["cc_payment", "Credit Card Payment", "Payment made to credit card company", C.teal],
    ["conversion", "Currency Conversion", "Transfer between accounts (e.g. EEFC → INR)", C.blue],
  ] : [
    ["customer_receipt", "Sales Receipt", "Apply against an open invoice", C.green],
    ["cc_payment", "Credit Card Payment", "Payment received against credit card bill", C.teal],
    ["conversion", "Currency Conversion", "Transfer between accounts (e.g. EEFC → INR)", C.blue],
    ["expense", "Other Credit", "Loan, refund, misc. income, etc.", C.amber],
  ];
  // ── Currency-conversion reclassification helpers ──
  const convThisAcctId = isDebit ? txn.accountFrom : txn.accountTo;
  const convThisAcct = accounts.find(a => a.id === convThisAcctId);
  const convOther = accounts.find(a => a.id === convOtherAcct);
  const convSrcCur = isDebit ? cur : (convOther?.currency || "INR");
  const convDstCur = isDebit ? (convOther?.currency || "INR") : cur;
  const convRateNum = +convRateInput || 0;
  const convSrcAmt = isDebit ? txnAmt : (convRateNum ? txnAmt / convRateNum : 0);
  const convDstAmt = convSrcAmt * convRateNum;

  // Under "Other", the typed sub-category becomes the real category.
  const effectiveExpenseCat = (expCat === "Other" && otherCat.trim()) ? otherCat.trim() : expCat;
  const canSave = classType === "expense" ? !!effectiveExpenseCat : classType === "vendor_bill" ? (selectedBillIds.size > 0 || !!vendorId || !!interCoInvId) : classType === "vendor_po" ? !!selectedPoId : classType === "customer_receipt" ? (selectedInvIds.size > 0 || openInvoices.length === 0) : classType === "cc_payment" ? !!ccAccountId : classType === "conversion" ? (!!convOtherAcct && convRateNum > 0) : true;
  const SI = { ...FI, fontSize: 13, padding: "8px 10px", borderRadius: 7 };

  const save = async () => {
    let classifiedRef = {}, sideEffects = {};
    if (classType === "expense") {
      const cat = effectiveExpenseCat;
      // Remember a newly-typed custom sub-category for next time (and the expense module).
      if (expCat === "Other" && otherCat.trim() && !expenseCats.includes(cat) && !customCats.includes(cat)) {
        try { await onAddCustomCat?.(cat); } catch {}
      }
      classifiedRef = { cat, party: expParty, ...(linkedInvId && { linkedInvoiceId: linkedInvId }) };
      sideEffects.newExpense = { id: "exp-" + uid(), date: txn.date, cat, party: expParty, amount: txnAmt, currency: cur, notes: expNotes, payFromAccount: txn.accountFrom, createdAt: new Date().toISOString(), ledgerTxnId: txn.id };
      // The Party / Vendor you typed also becomes the transaction's payee (keeping the
      // original bank narration as rawPayee so matching still works).
      const pNew = (expParty || "").trim();
      if (pNew && pNew !== (txn.payee || "")) sideEffects.txnPatch = { ...(sideEffects.txnPatch || {}), payee: pNew, ...(txn.rawPayee == null ? { rawPayee: txn.payee || "" } : {}) };
    } else if (classType === "vendor_bill" && interCoInvId && interCo) {
      // Inter-company settlement: this payment to the other company pays down THEIR invoice
      // (the one they issued to us). Mark it paid in their books and attach it on the right.
      const inv = interInvs.find(i => i.id === interCoInvId);
      const total = invTotal(inv), already = invPaid(inv), due = Math.max(0, total - already);
      const applied = Math.min(due || txnAmt, txnAmt);
      const newPaid = already + applied;
      const newStatus = total > 0 && newPaid >= total - 0.01 ? "paid" : "partial";
      classifiedRef = { interCo: true, interCoKey: interCo.otherKey, interCoCompany: interCo.otherName, interCoInvoiceId: inv.id, invNumber: interInvNo(inv), vendorName: interCo.otherName, paymentAmount: txnAmt, paymentCurrency: cur };
      sideEffects.interCoInvoiceUpdates = { invoicesKey: interCo.invoicesKey, updates: [{ id: inv.id, paidAmount: newPaid, status: newStatus, paidDate: txn.date }] };
    } else if (classType === "vendor_bill") {
      let remaining = txnAmt;
      const billUpdates = [];
      for (const bill of selectedBills) {
        const due = billDue(bill), paying = Math.min(due, remaining), newPaid = (+bill.paidAmount || 0) + paying, total = +bill.totalAmount || 0;
        billUpdates.push({ id: bill.id, paidAmount: newPaid, paymentDate: txn.date, status: newPaid >= total && total > 0 ? "paid" : "partial" });
        remaining -= paying;
      }
      const credit = Math.max(0, remaining);
      classifiedRef = { vendorId, vendorName: vendor?.name || txn.payee || "", billIds: [...selectedBillIds], billNumbers: selectedBills.map(b => b.billNumber).filter(Boolean), ...(selectedBillIds.size === 0 && { paymentOnAccount: true }), ...(credit > 0 && { creditApplied: credit }), ...(linkedInvId && { linkedInvoiceId: linkedInvId }) };
      sideEffects.billUpdates = billUpdates;
      // Auto-attach the bill's document. Purchases-module bills store it as docUrl/docData;
      // misc-module (no-GST) bills store it as attachUrl/attachData — support both.
      sideEffects.attachments = selectedBills.map(b => {
        const url = b.docUrl || b.docData || b.attachUrl || b.attachData;
        if (!url) return null;
        const ext = b.docExt || b.attachExt || (url.startsWith("data:image/png") ? "png" : url.startsWith("data:image") ? "jpg" : "pdf");
        const name = b.billName || b.attachName || `${b.billNumber || "Purchase bill"}.${ext}`;
        return { id: `bill-doc-${b.id}`, url, name, type: ext === "pdf" ? "application/pdf" : `image/${ext === "jpg" ? "jpeg" : ext}`, ext, source: "purchase-bill", sourceBillId: b.id, sourceBillNumber: b.billNumber || "", uploadedAt: new Date().toISOString() };
      }).filter(Boolean);
      if (credit > 0 && vendorId) sideEffects.vendorCredit = { vendorId, amount: credit };
    } else if (classType === "vendor_po") {
      const po = purchases.find(p => p.id === selectedPoId);
      classifiedRef = { vendorId, vendorName: vendor?.name, poId: selectedPoId, poNumber: po?.poNumber };
      sideEffects.poUpdate = { id: selectedPoId, paidAmount: (+po?.paidAmount || 0) + txnAmt };
    } else if (classType === "customer_receipt" && selectedInvs.length === 0) {
      // No invoice to apply against (e.g. a Payoneer payout with no matching invoice in the
      // system) — record it as a plain, unapplied sales receipt. No invoice updates, no FX diff.
      classifiedRef = { invoiceIds: [], buyer: txn.payee || "", paymentAmount: txnAmt, paymentCurrency: cur, unapplied: true };
    } else if (classType === "customer_receipt") {
      const paymentInr = toInr(txnAmt, cur);
      const dueInr = selectedInvs.reduce((s, inv) => s + toInr(invDue(inv), inv.currency || "USD"), 0);
      const diffInr = Math.round((dueInr - paymentInr) * 100) / 100; // >0 short, <0 over
      const buyerNames = [...new Set(selectedInvs.map(inv => buyers.find(b => b.id === inv.buyerId)?.name || inv.buyerName || "").filter(Boolean))];
      const invoiceUpdates = [];
      if (recvDiffMode === "bank_charges") {
        for (const inv of selectedInvs) invoiceUpdates.push({ id: inv.id, paidAmount: invTotal(inv), status: "paid", paidDate: txn.date });
      } else {
        let remainingInr = paymentInr;
        for (const inv of selectedInvs) {
          const invCur = inv.currency || "USD";
          const total = invTotal(inv), already = invPaid(inv), due = Math.max(0, total - already);
          const applyingInr = Math.min(toInr(due, invCur), remainingInr);
          const applying = convertMoney(applyingInr, "INR", invCur);
          const newPaid = already + applying, newStatus = newPaid >= total && total > 0 ? "paid" : "partial";
          invoiceUpdates.push({ id: inv.id, paidAmount: newPaid, status: newStatus, paidDate: newStatus === "paid" ? txn.date : undefined });
          remainingInr -= applyingInr;
        }
      }
      classifiedRef = { invoiceIds: [...selectedInvIds], invoiceId: [...selectedInvIds][0], invNumbers: selectedInvs.map(i => i.invNo || i.invNumber || i.number).filter(Boolean), invNumber: selectedInvs[0]?.invNo || selectedInvs[0]?.invNumber || selectedInvs[0]?.number, buyer: buyerNames.join(", "), paymentAmount: txnAmt, paymentCurrency: cur, invoiceDueByCurrency: selectedInvDueByCurrency, differenceMode: recvDiffMode, differenceInr: diffInr, ...(recvDiffMode === "advance" && diffInr < -0.01 && { advanceReceivedInr: Math.round(-diffInr * 100) / 100 }) };
      sideEffects.invoiceUpdates = invoiceUpdates;
      if (recvDiffMode === "bank_charges" && diffInr > 0.01) {
        sideEffects.newExpense = { id: "exp-" + uid(), date: txn.date, cat: "Bank Charges", party: buyerNames.join(", ") || txn.payee || "", amount: diffInr, currency: "INR", notes: `FX / bank charges on receipt${classifiedRef.invNumbers?.length ? ` for ${classifiedRef.invNumbers.join(", ")}` : ""}`, payFromAccount: txn.accountTo, createdAt: new Date().toISOString(), ledgerTxnId: txn.id };
      }
    } else if (classType === "cc_payment") {
      const card = cardAccounts.find(a => a.id === ccAccountId);
      classifiedRef = { cardAccountId: ccAccountId, cardAccountName: card?.name || "", note: expNotes || "Credit card payment" };
    } else if (classType === "conversion") {
      const fromId = isDebit ? convThisAcctId : convOtherAcct;
      const toId = isDebit ? convOtherAcct : convThisAcctId;
      const fromAcc = accounts.find(a => a.id === fromId), toAcc = accounts.find(a => a.id === toId);
      const amount = Math.round(convSrcAmt * 100) / 100, received = Math.round(convDstAmt * 100) / 100;
      classifiedRef = { conversion: true, fromAccountId: fromId, toAccountId: toId, fromAccountName: fromAcc?.name || "", toAccountName: toAcc?.name || "", rate: convRateNum, convOtherAccountId: convOtherAcct, sourceAmount: amount, sourceCurrency: fromAcc?.currency || convSrcCur, targetAmount: received, targetCurrency: toAcc?.currency || convDstCur };
      sideEffects.txnPatch = { type: "conversion", accountFrom: fromId, accountTo: toId, amount, receivedAmount: received, rate: convRateNum, convRate: convRateNum, currency: fromAcc?.currency || convSrcCur, toCurrency: toAcc?.currency || convDstCur, category: "Transfer" };
    }
    // If you typed in Details/Notes, keep the transaction's Notes exactly in sync (the
    // original narration is preserved as rawNotes). Only when you actually edited it — so a
    // pre-filled value is never forced onto the transaction.
    if (notesTouched && (expNotes || "") !== (txn.notes || "") && classType !== "conversion") {
      sideEffects.txnPatch = { ...(sideEffects.txnPatch || {}), notes: expNotes, ...(txn.rawNotes == null ? { rawNotes: txn.notes || "" } : {}) };
    }
    // Pass the AI's suggestion (if any) so the journal can flag corrections as
    // high-signal training data when the saved decision differs from it.
    await onSave({ classifiedAs: classType, classifiedRef, sideEffects, aiSuggestion: aiSug || null });
  };

  const optionBtn = (id, label, desc, color) => (
    <button key={id} onClick={() => setClassType(id)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", background: classType === id ? C.card : C.surface, border: `1.5px solid ${classType === id ? color : C.border}`, borderRadius: 8, cursor: "pointer", textAlign: "left", width: "100%" }}>
      <div style={{ width: 10, height: 10, borderRadius: "50%", background: classType === id ? color : C.border, flexShrink: 0 }} />
      <div><div style={{ fontSize: 13, fontWeight: 800, color: C.ink }}>{label}</div><div style={{ fontSize: 11, color: C.inkFaint }}>{desc}</div></div>
    </button>
  );
  const CategoryPicker = () => (
    <div style={{ position: "relative" }}>
      <button type="button" onClick={() => setCatOpen(v => !v)} style={{ ...SI, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, textAlign: "left", background: C.surface, cursor: "pointer" }}>
        <span style={{ fontWeight: expCat ? 800 : 500, color: expCat ? C.ink : C.inkFaint }}>{expCat || "Select category"}</span>
        <span style={{ fontSize: 12, color: C.inkFaint }}>{catOpen ? "▲" : "▼"}</span>
      </button>
      {catOpen && (
        <div style={{ position: "absolute", left: 0, right: 0, top: "calc(100% + 6px)", zIndex: 5, background: C.surface, border: `1.5px solid ${C.border}`, borderRadius: 10, boxShadow: "0 18px 44px rgba(26,19,8,.18)", padding: 10, maxHeight: 300, overflowY: "auto" }}>
          {catGroups.map(group => (
            <div key={group.label} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 9, fontWeight: 900, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .65, margin: "0 0 6px 2px" }}>{group.label}</div>
              <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr" : "1fr 1fr", gap: 6 }}>
                {group.cats.map(cat => (
                  <button key={cat} type="button" onClick={() => { setExpCat(cat); setCatOpen(false); }} style={{ border: `1px solid ${expCat === cat ? C.gold : C.border}`, background: expCat === cat ? C.goldLight : C.card, borderRadius: 8, padding: "8px 9px", fontSize: 12, fontWeight: 850, color: expCat === cat ? C.ink : C.inkMid, cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}>
                    {cat}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
  return (
    <div onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }} style={{ position: "fixed", inset: 0, zIndex: 95, background: "rgba(26,19,8,.48)", display: "flex", alignItems: mob ? "stretch" : "center", justifyContent: "center", padding: mob ? 0 : 16 }}>
      <div onMouseDown={e => e.stopPropagation()} style={{ width: mob ? "100%" : 500, maxWidth: "100%", height: mob ? "100%" : "auto", maxHeight: mob ? "100%" : "90vh", overflowY: "auto", background: C.bg, border: mob ? "none" : `1.5px solid ${C.border}`, borderRadius: mob ? 0 : 12, padding: mob ? "20px 16px" : "24px 26px", boxShadow: "0 20px 60px rgba(0,0,0,.3)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 18 }}>
          <div><div style={{ fontWeight: 800, fontSize: 15, color: C.ink }}>Classify Transaction</div><div style={{ fontSize: 12, color: C.inkFaint, marginTop: 3 }}>{sym}{txnAmt.toLocaleString("en-IN", { minimumFractionDigits: 2 })} · {txn.payee || "No payee"} · {fmtDate(txn.date)}</div></div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: C.inkFaint, fontSize: 18, lineHeight: 1, padding: "0 4px" }}>×</button>
        </div>
        {/* Learner suggestion banner */}
        {L && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", marginBottom: 14, background: C.greenBg, border: `1px solid ${C.green}55`, borderRadius: 9, fontSize: 12, color: C.ink }}>
            <span style={{ fontSize: 14 }}>📚</span>
            <span>Pre-filled from your history — classified this way <strong>{L.count}×</strong> before (<strong>{labelOf(L)}</strong>). Review &amp; Save.</span>
          </div>
        )}
        {!L && aiLoading && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", marginBottom: 14, background: C.card, border: `1px solid ${C.border}`, borderRadius: 9, fontSize: 12, color: C.inkMid }}>
            <span style={{ fontSize: 14 }}>✨</span><span>Looking at your past classifications…</span>
          </div>
        )}
        {!L && !aiLoading && aiSug && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", marginBottom: 14, background: C.tealBg, border: `1px solid ${C.teal}66`, borderRadius: 9, fontSize: 12, color: C.ink }}>
            <span style={{ fontSize: 14 }}>✨</span>
            <span style={{ flex: 1 }}>{aiAutoApplied ? <>AI pre-filled <strong>{labelOf(aiSug)}</strong> — review &amp; Save</> : <>AI suggests <strong>{labelOf(aiSug)}</strong></>}{aiSug.party ? <> · {aiSug.party}</> : null}{aiSug.why ? <div style={{ color: C.inkFaint, marginTop: 2 }}>{aiSug.why}</div> : null}</span>
            {!aiAutoApplied && <button onClick={() => { applySuggestion(aiSug); setAiApplied(true); }} disabled={aiApplied}
              style={{ flexShrink: 0, background: aiApplied ? C.card : C.teal, color: aiApplied ? C.inkMid : "#fff", border: "none", borderRadius: 7, padding: "6px 12px", fontSize: 12, fontWeight: 750, cursor: aiApplied ? "default" : "pointer" }}>
              {aiApplied ? "Applied" : "Apply"}
            </button>}
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 7, marginBottom: 20 }}>{types.map(t => optionBtn(...t))}</div>
        {classType === "expense" && <div style={{ display: "grid", gap: 12 }}>
          {cardSpendAccount && <div style={{ padding: "9px 11px", background: C.tealBg, border: `1px solid ${C.teal}55`, borderRadius: 8, fontSize: 12, color: C.inkMid }}>Paid using <strong>{cardSpendAccount.name}</strong>. This expense will increase that card's amount due.</div>}
          <Field label="Category"><CategoryPicker /></Field>
          {expCat === "Other" && (
            <Field label="Specify (optional)">
              <input value={otherCat} onChange={e => setOtherCat(e.target.value)} list="acct-class-othercats" style={SI} placeholder="e.g. Milk — type or pick a past one" />
              <datalist id="acct-class-othercats">{customCats.map(c => <option key={c} value={c} />)}</datalist>
            </Field>
          )}
          <Field label="Party / Vendor"><input value={expParty} onChange={e => setExpParty(e.target.value)} list="acct-class-vendors" style={SI} placeholder="Type or pick a vendor" /></Field>
          <Field label="Details"><input value={expNotes} onChange={e => { setExpNotes(e.target.value); setNotesTouched(true); }} style={SI} placeholder="Line item / reference / note" /></Field>
        </div>}
        {classType === "cc_payment" && <div style={{ padding: "12px 14px", background: C.tealBg, border: `1px solid ${C.teal}`, borderRadius: 8, fontSize: 12, color: C.ink, display: "grid", gap: 10 }}>
          <div><div style={{ fontWeight: 800, marginBottom: 4 }}>Credit Card Payment</div><div style={{ color: C.inkFaint }}>This keeps the bank payment and reduces the selected card's amount due.</div></div>
          <Field label="Credit card account">
            <select value={ccAccountId} onChange={e => setCcAccountId(e.target.value)} style={SI}>
              <option value="">- Select credit card -</option>
              {cardAccounts.map(a => <option key={a.id} value={a.id}>{a.name}{a.creditLimit ? ` · limit ₹${(+a.creditLimit || 0).toLocaleString("en-IN")}` : ""}</option>)}
            </select>
            {cardAccounts.length === 0 && <div style={{ fontSize: 11, color: C.red, marginTop: 5 }}>Add a credit card account in Finance settings first.</div>}
          </Field>
          <Field label="Notes"><input value={expNotes} onChange={e => { setExpNotes(e.target.value); setNotesTouched(true); }} placeholder="Statement month, card ending, reference..." style={SI} /></Field>
        </div>}
        {(classType === "vendor_bill" || classType === "vendor_po") && <div style={{ display: "grid", gap: 12 }}>
          {classType === "vendor_bill" && interCo?.active && interInvs.length > 0 && (
            <div style={{ padding: "10px 12px", background: C.tealBg, border: `1px solid ${C.teal}66`, borderRadius: 9 }}>
              <div style={{ fontSize: 12, fontWeight: 900, color: C.ink }}>✨ Paying {interCo.otherName}</div>
              <div style={{ fontSize: 11, color: C.inkMid, margin: "2px 0 8px" }}>Settle a {interCo.otherName} invoice billed to {interCo.selfName}. It will be marked paid in {interCo.otherName} and shown on the right.</div>
              <div style={{ maxHeight: 220, overflowY: "auto", display: "grid", gap: 6 }}>
                {interInvs.map(inv => {
                  const sel = interCoInvId === inv.id, due = invDue(inv), likely = guessedInterId === inv.id;
                  const buyerName = interCo.buyers?.find(b => b.id === inv.buyerId)?.name || inv.buyerName || inv.buyer || interCo.selfName;
                  return <button key={inv.id} onClick={() => setInterCoInvId(sel ? "" : inv.id)} style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "9px 12px", background: sel ? C.card : C.surface, border: `1.5px solid ${sel ? C.teal : C.border}`, borderRadius: 7, cursor: "pointer", textAlign: "left" }}>
                    <div style={{ width: 16, height: 16, borderRadius: "50%", border: `2px solid ${sel ? C.teal : C.border}`, background: sel ? C.teal : "transparent", flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 12, fontWeight: 800, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{interInvNo(inv) || "(no number)"}{likely && <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 900, color: C.teal }}>✨ LIKELY</span>}</div><div style={{ fontSize: 11, color: C.inkFaint }}>{buyerName} · {fmtDate(inv.date)} · {inv.status || "-"}</div></div>
                    <div style={{ textAlign: "right", flexShrink: 0 }}><div style={{ fontSize: 12, fontWeight: 800, color: C.red }}>₹{due.toLocaleString("en-IN", { minimumFractionDigits: 2 })} due</div></div>
                  </button>;
                })}
              </div>
            </div>
          )}
          <Field label="Filter by Vendor (optional)"><select value={vendorId} onChange={e => { setVendorId(e.target.value); setSelectedBillIds(new Set()); setSelectedPoId(""); }} style={SI}><option value="">All vendors</option>{vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</select></Field>
          {classType === "vendor_bill" && <div><div style={{ fontSize: 10, fontWeight: 900, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .65, marginBottom: 6 }}>Select bills to pay {vendorId ? `- ${vendor?.name}` : "(all vendors)"} <span style={{ fontWeight: 500 }}>(tap to select multiple)</span></div>
            {vendorBills.length === 0 ? <div style={{ fontSize: 12, color: C.inkFaint, padding: "8px 0" }}>No open bills found.</div> : <div style={{ maxHeight: 240, overflowY: "auto", display: "grid", gap: 6 }}>
              {vendorBills.map(b => { const sel = selectedBillIds.has(b.id), due = billDue(b); return <button key={b.id} onClick={() => toggleBill(b.id)} style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "9px 12px", background: sel ? C.card : C.surface, border: `1.5px solid ${sel ? C.blue : C.border}`, borderRadius: 7, cursor: "pointer", textAlign: "left" }}>
                <div style={{ width: 18, height: 18, borderRadius: 4, border: `2px solid ${sel ? C.blue : C.border}`, background: sel ? C.blue : "transparent", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 11, fontWeight: 900 }}>{sel ? "✓" : ""}</div>
                <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 12, fontWeight: 800, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.billNumber || "Bill"}</div><div style={{ fontSize: 11, color: C.inkFaint, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.supplier} · {fmtDate(b.billDate)} · {b.status}</div></div>
                <div style={{ textAlign: "right", flexShrink: 0 }}><div style={{ fontSize: 12, fontWeight: 800, color: C.red }}>₹{due.toLocaleString("en-IN", { minimumFractionDigits: 2 })} due</div><div style={{ fontSize: 10, color: C.inkFaint }}>of ₹{(+b.totalAmount || 0).toLocaleString("en-IN")}</div></div>
              </button>; })}
            </div>}
            {selectedBillIds.size > 0 && <div style={{ marginTop: 10, padding: "10px 13px", background: C.card, borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}><span style={{ color: C.inkFaint }}>Selected due</span><b>₹{totalBillsDue.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</b></div>
              <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: C.inkFaint }}>Payment amount</span><b>₹{txnAmt.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</b></div>
            </div>}
            {selectedBillIds.size === 0 && vendorId && <div style={{ marginTop: 10, padding: "10px 13px", background: C.blueBg, border: `1px solid ${C.blue}55`, borderRadius: 8, fontSize: 12, color: C.inkMid }}>
              No purchase bill selected. This will still be saved in <strong>{vendor?.name || "the vendor"}'s ledger</strong> as a payment on account / advance.
            </div>}
          </div>}
          {classType === "vendor_po" && <div><div style={{ fontSize: 10, fontWeight: 900, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .65, marginBottom: 6 }}>Open POs {vendorId ? `- ${vendor?.name}` : "(all vendors)"}</div>
            {vendorPOs.length === 0 ? <div style={{ fontSize: 12, color: C.inkFaint, padding: "8px 0" }}>No open POs found.</div> : <div style={{ maxHeight: 220, overflowY: "auto", display: "grid", gap: 6 }}>{vendorPOs.map(po => <button key={po.id} onClick={() => setSelectedPoId(po.id)} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", padding: "9px 12px", background: selectedPoId === po.id ? C.card : C.surface, border: `1.5px solid ${selectedPoId === po.id ? C.purple : C.border}`, borderRadius: 7, cursor: "pointer", textAlign: "left" }}><div><div style={{ fontSize: 12, fontWeight: 800, color: C.ink }}>{po.poNumber || "PO"}</div><div style={{ fontSize: 11, color: C.inkFaint }}>{po.supplier} · {fmtDate(po.date)} · {po.status}</div></div><div style={{ fontSize: 12, fontWeight: 800, color: C.ink }}>{po.currency || "INR"}</div></button>)}</div>}
          </div>}
        </div>}
        {classType === "customer_receipt" && <div><div style={{ fontSize: 10, fontWeight: 900, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .65, marginBottom: 6 }}>Apply against invoice(s)</div>
          {openInvoices.length === 0 ? <div style={{ fontSize: 12, color: C.inkFaint, padding: "8px 0" }}>No open invoices found — save anyway to record this as a sales receipt.</div> : openInvoices.map(inv => { const checked = selectedInvIds.has(inv.id), due = invDue(inv), buyerName = buyers.find(b => b.id === inv.buyerId)?.name || inv.buyerName || "Buyer"; return <button key={inv.id} onClick={() => toggleInv(inv.id)} style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "9px 12px", marginBottom: 6, background: checked ? C.card : C.surface, border: `1.5px solid ${checked ? C.green : C.border}`, borderRadius: 7, cursor: "pointer", textAlign: "left" }}><div style={{ width: 16, height: 16, borderRadius: 4, border: `2px solid ${checked ? C.green : C.border}`, background: checked ? C.green : "transparent", color: "#fff", fontSize: 10, fontWeight: 900, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{checked ? "✓" : ""}</div><div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 12, fontWeight: 800, color: C.ink }}>{inv.invNo || inv.invNumber || inv.number || "(no number)"}</div><div style={{ fontSize: 11, color: C.inkFaint }}>{buyerName} · {fmtDate(inv.date)} · {inv.status || "-"}</div></div><div style={{ textAlign: "right", flexShrink: 0 }}><div style={{ fontSize: 12, fontWeight: 800, color: C.red }}>{inv.currency || "USD"} {due.toLocaleString(undefined, { minimumFractionDigits: 2 })} due</div><div style={{ fontSize: 10, color: C.inkFaint }}>of {inv.currency || "USD"} {invTotal(inv).toLocaleString(undefined, { minimumFractionDigits: 2 })}</div></div></button>; })}
          {selectedInvIds.size > 0 && <div style={{ marginTop: 10, padding: "10px 13px", background: C.card, borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, gap: 10 }}><span style={{ color: C.inkFaint }}>Payment received</span><b>{moneyText(txnAmt, cur)}</b></div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, gap: 10 }}><span style={{ color: C.inkFaint }}>Selected invoice due</span><b style={{ color: C.red }}>{Object.entries(selectedInvDueByCurrency).map(([c, a]) => moneyText(a, c)).join(" + ")}</b></div>
            {Object.keys(selectedInvDueByCurrency).some(c => c !== cur) && <div style={{ display: "flex", justifyContent: "space-between", gap: 10, paddingTop: 6, borderTop: `1px solid ${C.border}`, color: C.inkFaint }}><span>Approx in payment currency</span><b>{moneyText(totalInvDueInTxnCurrency, cur)}</b></div>}
            {(() => {
              const paymentInr = toInr(txnAmt, cur);
              const dueInr = selectedInvs.reduce((s, inv) => s + toInr(invDue(inv), inv.currency || "USD"), 0);
              const diffInr = Math.round((dueInr - paymentInr) * 100) / 100;
              if (Math.abs(diffInr) <= 0.5) return null;
              return <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${C.border}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 7, gap: 10 }}><span style={{ color: C.inkFaint }}>Difference vs. invoice{selectedInvIds.size > 1 ? "s" : ""}</span><b style={{ color: diffInr > 0 ? C.amber : C.green }}>{diffInr > 0 ? "−" : "+"}{moneyText(Math.abs(diffInr), "INR")} {diffInr > 0 ? "short" : "over"}</b></div>
                <div style={{ display: "flex", gap: 6 }}>
                  {[["bank_charges", diffInr > 0 ? "Bank charges" : "Round-off", "Close invoice"], ["advance", "Advance", diffInr > 0 ? "Leave outstanding" : "Keep as credit"]].map(([id, label, desc]) => (
                    <button key={id} onClick={() => setRecvDiffMode(id)} style={{ flex: 1, padding: "7px 8px", borderRadius: 7, cursor: "pointer", textAlign: "left", background: recvDiffMode === id ? C.surface : "transparent", border: `1.5px solid ${recvDiffMode === id ? C.gold : C.border}` }}>
                      <div style={{ fontSize: 12, fontWeight: 800, color: C.ink }}>{label}</div><div style={{ fontSize: 10, color: C.inkFaint }}>{desc}</div>
                    </button>
                  ))}
                </div>
                <div style={{ fontSize: 11, color: C.inkMid, marginTop: 7, lineHeight: 1.4 }}>{recvDiffMode === "bank_charges" ? (diffInr > 0 ? `Invoice${selectedInvIds.size > 1 ? "s" : ""} marked fully paid; ${moneyText(diffInr, "INR")} booked as Bank Charges.` : `Invoice${selectedInvIds.size > 1 ? "s" : ""} marked fully paid; ${moneyText(-diffInr, "INR")} excess absorbed as round-off.`) : (diffInr > 0 ? `Applies ${moneyText(paymentInr, "INR")}; remainder stays outstanding.` : `Settles the invoice${selectedInvIds.size > 1 ? "s" : ""}; ${moneyText(-diffInr, "INR")} kept as a buyer advance.`)}</div>
              </div>;
            })()}
          </div>}
        </div>}
        {classType === "conversion" && <div style={{ display: "grid", gap: 12 }}>
          <div style={{ padding: "9px 11px", background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12, color: C.inkMid }}>This {isDebit ? "outflow from" : "deposit into"} <b>{convThisAcct?.name || "this account"}</b>{convThisAcct?.currency ? ` (${convThisAcct.currency})` : ""} is a transfer between your own accounts — e.g. converting EEFC to INR. Pick the {isDebit ? "destination" : "source"} account and the rate used.</div>
          <Field label={isDebit ? "Converted into" : "Converted from"}>
            <select value={convOtherAcct} onChange={e => setConvOtherAcct(e.target.value)} style={SI}>
              <option value="">- Select account -</option>
              {accounts.filter(a => a.active !== false && a.id !== convThisAcctId && a.type !== "credit_card").map(a => <option key={a.id} value={a.id}>{a.name} ({a.currency})</option>)}
            </select>
          </Field>
          <Field label={`Rate${convSrcCur && convDstCur && convSrcCur !== convDstCur ? ` (1 ${convSrcCur} = ? ${convDstCur})` : ""}`}>
            <input type="number" inputMode="decimal" value={convRateInput} onChange={e => setConvRateInput(e.target.value)} placeholder={convSrcCur !== convDstCur ? `e.g. ${(convertMoney(1, convSrcCur, convDstCur) || 1).toFixed(2)}` : "1"} style={SI} />
          </Field>
          {convOtherAcct && convRateNum > 0 && <div style={{ padding: "10px 13px", background: C.card, borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, gap: 10 }}><span style={{ color: C.inkFaint }}>Out of {accounts.find(a => a.id === (isDebit ? convThisAcctId : convOtherAcct))?.name}</span><b style={{ color: C.red }}>− {moneyText(convSrcAmt, convSrcCur)}</b></div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}><span style={{ color: C.inkFaint }}>Into {accounts.find(a => a.id === (isDebit ? convOtherAcct : convThisAcctId))?.name}</span><b style={{ color: C.green }}>+ {moneyText(convDstAmt, convDstCur)}</b></div>
          </div>}
        </div>}
        {(classType === "expense" || classType === "vendor_bill") && invoices.length > 0 && <div style={{ marginTop: 16, borderTop: `1px solid ${C.border}`, paddingTop: 14 }}><Field label="Link to Invoice (optional)"><select value={linkedInvId} onChange={e => setLinkedInvId(e.target.value)} style={SI}><option value="">- Not linked to an invoice -</option>{invoices.map(inv => <option key={inv.id} value={inv.id}>{inv.invNo || inv.number || "Invoice"} · {fmtDate(inv.date)}{inv.totalAmt ? ` · ${inv.currency || "$"} ${(+inv.totalAmt).toLocaleString()}` : ""}</option>)}</select></Field></div>}
        <datalist id="acct-class-vendors">{vendors.map(v => <option key={v.id} value={v.name} />)}</datalist>
        <div style={{ display: "flex", gap: 10, marginTop: 22 }}><button onClick={save} disabled={!canSave} style={{ flex: 1, background: C.gold, border: "none", color: "#fff", borderRadius: 7, padding: "10px 0", fontWeight: 800, fontSize: 13, cursor: canSave ? "pointer" : "not-allowed", opacity: canSave ? 1 : .5, fontFamily: "inherit" }}>Save Classification</button><button onClick={onClose} style={{ padding: "10px 16px", background: C.surface, border: `1.5px solid ${C.border}`, color: C.ink, borderRadius: 7, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>Cancel</button></div>
      </div>
    </div>
  );
}
