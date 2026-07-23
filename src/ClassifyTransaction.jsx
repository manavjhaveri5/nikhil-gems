import { useState, useEffect, forwardRef, useImperativeHandle } from "react";
import { C, FI, Field } from "./ui.jsx";
import { mob, uid, fmtDate } from "./utils.js";
import { aiSuggest } from "./classifyLearner.js";

// Words that say nothing about WHICH vendor this is. Nearly every supplier here is
// a "…Gems & Stones Trading Co.", so these carry no identifying signal and must not
// be allowed to match one vendor's records against another's.
const GENERIC_VENDOR_WORDS = new Set([
  "co", "company", "pvt", "private", "ltd", "limited", "llp", "inc", "corp", "corporation",
  "and", "the", "of", "sons", "son", "brothers", "bros", "associates", "group",
  "gem", "gems", "gemstone", "gemstones", "stone", "stones", "mineral", "minerals",
  "crystal", "crystals", "jewel", "jewels", "jewellery", "jewelry", "lapidary", "agate",
  "trading", "traders", "trade", "export", "exports", "exporter", "exporters",
  "import", "imports", "importer", "importers", "enterprise", "enterprises",
  "industries", "industry", "international", "overseas", "global", "india",
  "agency", "agencies", "supplier", "suppliers", "supplies", "works", "impex",
]);
const normVendorName = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
const vendorWords = name => normVendorName(name).split(" ").filter(Boolean);
const distinctiveVendorWords = name => vendorWords(name).filter(w => !GENERIC_VENDOR_WORDS.has(w));

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

const purchaseSignature = p => {
  if (!p || p.type !== "bill") return p?.id || "";
  const itemSig = (p.items || []).map(it => [it.desc, it.qty, it.unit, it.rate, it.amt].join(":")).join("|");
  return [
    p.source === "misc-bill-maker" ? "misc" : "bill",
    (p.billNumber || "").trim(),
    (p.supplier || p.vendorName || p.vendor || "").trim(),
    p.billDate || p.date || "",
    +p.totalAmount || 0,
    itemSig,
  ].join("||").toLowerCase();
};

const dedupePurchasesForPicker = (list, keepIds = new Set()) => {
  const seen = new Set();
  const out = [];
  (list || []).forEach(p => {
    const sig = purchaseSignature(p);
    if (sig && seen.has(sig) && !keepIds.has(p.id)) return;
    if (sig) seen.add(sig);
    out.push(p);
  });
  return out;
};

const ClassifyTransactionModal = forwardRef(function ClassifyTransactionModal({
  txn, accounts = [], vendors = [], purchases = [], invoices = [], buyers = [],
  ledgerTxns = [],
  rates, categoryGroups, expenseCats = [], customCats = [], onAddCustomCat, normalizeCat, suggestedType,
  learned = null, learnMemory = [], embMap = {}, company = "ng", enableLearner = false, interCo = null, reclassifyDirty = false, onSave, onClose,
  inline = false, onValidityChange,
  onUploadBill, preselectBillId, onPreselectConsumed,
  onCreatePO, preselectPoId, onPreselectPoConsumed,
}, ref) {
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
  const [quickBills, setQuickBills] = useState([]);
  const [quickBillOpen, setQuickBillOpen] = useState(false);
  const [quickBill, setQuickBill] = useState({ billNumber: "", supplier: "", date: "", amount: "", currency: "" });
  const [applyAdvance, setApplyAdvance] = useState(""); // advance/credit to offset against the selected bill(s)
  // When the parent's inline "Upload Bill" shortcut saves a new bill, auto-select it here so the
  // payment continues without leaving the classify modal.
  useEffect(() => {
    if (!preselectBillId) return;
    const bill = purchases.find(p => p.id === preselectBillId);
    if (!bill) return; // wait until the refreshed purchases list includes it
    setClassType("vendor_bill");
    setSelectedBillIds(prev => new Set([...prev, preselectBillId]));
    setVendorId(prev => {
      if (prev) return prev;
      const v = vendors.find(x => (x.name || "").toLowerCase() === (bill.supplier || "").toLowerCase());
      return v ? v.id : prev;
    });
    onPreselectConsumed?.();
  }, [preselectBillId, purchases]);
  // Same for the inline "New PO" shortcut — auto-select the freshly-created PO.
  useEffect(() => {
    if (!preselectPoId) return;
    const po = purchases.find(p => p.id === preselectPoId);
    if (!po) return;
    setClassType("vendor_po");
    setSelectedPoId(preselectPoId);
    setVendorId(prev => {
      if (prev) return prev;
      const v = vendors.find(x => (x.name || "").toLowerCase() === (po.supplier || "").toLowerCase());
      return v ? v.id : prev;
    });
    onPreselectPoConsumed?.();
  }, [preselectPoId, purchases]);
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
  const [recvDiffMode, setRecvDiffMode] = useState(txn.classifiedRef?.differenceMode || "advance");
  const [recvDiffTouched, setRecvDiffTouched] = useState(!!txn.classifiedRef?.differenceMode);
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
  const [vendorOpen, setVendorOpen] = useState(false);
  const [vendorQuery, setVendorQuery] = useState("");
  const [vendorActiveIndex, setVendorActiveIndex] = useState(0);
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
  const buyerNameOfInv = inv => buyers.find(b => b.id === inv.buyerId)?.name || inv.buyerName || inv.customerName || inv.buyer || "";
  const guessBuyer = () => {
    const p = (txn.payee || "").toLowerCase();
    return buyers.find(b => {
      const n = (b.name || b.contactName || "").toLowerCase();
      return n && p && (n.includes(p) || p.includes(n) || p.split(/\s+/).some(w => w.length > 3 && n.includes(w)));
    }) || null;
  };
  const guessedBuyer = guessBuyer();
  const [receiptPartyQuery, setReceiptPartyQuery] = useState(txn.classifiedRef?.buyer || guessedBuyer?.name || txn.payee || "");

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
    if (s.classifiedAs === "customer_receipt" && (s.party || s.payee)) setReceiptPartyQuery(s.party || s.payee);
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
    const s = normVendorName(vendorNameOf(p)), v = normVendorName(vendor?.name);
    if (!s || !v) return false;
    if (s === v || s.includes(v) || v.includes(s)) return true;
    // Match on the distinctive part of the name only. Matching on any shared word
    // put every vendor in this business against every other — "ZN Gems & Stones
    // Trading Co." matched "Gemstones Infinity" and "Shahi Mineral Stones" on
    // "gems"/"stones" alone, which surfaced their bills under the wrong vendor.
    const want = distinctiveVendorWords(vendor?.name);
    const have = new Set(distinctiveVendorWords(vendorNameOf(p)));
    if (!want.length || !want.every(w => have.has(w))) return false;
    // One shared distinctive word is weak on its own — "Rajasthan Gems & Minerals"
    // and "Rajasthan Stone Works" are different firms sharing a place name. Require
    // half the vendor's words to appear as well.
    const vt = vendorWords(vendor?.name), st = new Set(vendorWords(vendorNameOf(p)));
    return vt.filter(w => st.has(w)).length / vt.length >= 0.5;
  };
  // Bills already linked to THIS payment stay visible even after they're marked paid.
  const linkedBillIds = new Set(txn.classifiedRef?.billIds || (txn.classifiedRef?.billId ? [txn.classifiedRef.billId] : []));
  const purchaseList = dedupePurchasesForPicker([...quickBills, ...purchases], linkedBillIds);
  const allBills = purchaseList.filter(p => p.type === "bill");
  const allOpenBills = allBills.filter(p => p.status !== "paid" || linkedBillIds.has(p.id));
  // When a vendor is chosen, also surface that vendor's PAID bills so a bank payment
  // (e.g. one already settled in the Finance module) can still be linked to the bill
  // and its document attached. Selecting a fully-paid bill adds ₹0 (paying is capped at
  // the amount due), so it never double-pays.
  const linkedOrMatchesVendor = p => linkedBillIds.has(p.id) || matchesVendor(p);
  const vendorBills = vendorId ? allBills.filter(linkedOrMatchesVendor) : allOpenBills.filter(linkedOrMatchesVendor);
  const vendorPOs = purchaseList.filter(p => p.type === "po" && !["paid", "closed", "cancelled"].includes(p.status || "open")).filter(matchesVendor);
  // Invoices already linked to THIS receipt (so a reviewed receipt still shows its
  // invoice even though classifying it flipped the invoice's status to "paid").
  const linkedInvIds = new Set(txn.classifiedRef?.invoiceIds || (txn.classifiedRef?.invoiceId ? [txn.classifiedRef.invoiceId] : []));
  const invoiceHasDue = inv => {
    const total = +inv.totalAmt || (inv.items || []).reduce((s, i) => s + (+i.amt || 0), 0);
    const paid = (+inv.paidAmount || 0) + (inv.payments || []).reduce((s, p) => s + (+p.amount || 0), 0);
    return Math.max(0, total - paid) > 0.5;
  };
  const invoiceIsOpen = inv => {
    const status = String(inv.status || "").toLowerCase();
    if (linkedInvIds.has(inv.id)) return true;
    if (status === "cancelled" || status === "paid") return false;
    if (status === "draft" && !invoiceHasDue(inv)) return false;
    return invoiceHasDue(inv) || !status;
  };
  const receiptPartyNeedle = String(receiptPartyQuery || "").trim().toLowerCase();
  const receiptPartyMatches = inv => {
    if (!receiptPartyNeedle) return true;
    const hay = `${buyerNameOfInv(inv)} ${inv.buyerName || ""} ${inv.customerName || ""} ${inv.invNo || ""} ${inv.invNumber || ""}`.toLowerCase();
    return hay.includes(receiptPartyNeedle) || receiptPartyNeedle.split(/\s+/).filter(w => w.length > 2).some(w => hay.includes(w));
  };
  const openInvoices = (invoices || [])
    .filter(invoiceIsOpen)
    .filter(inv => linkedInvIds.has(inv.id) || receiptPartyMatches(inv))
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const selectedBills = allBills.filter(b => selectedBillIds.has(b.id));
  const selectedInvs = openInvoices.filter(i => selectedInvIds.has(i.id));
  const ledgerPaidForBill = bid => (ledgerTxns || []).reduce((sum, t) => {
    if (!t || t.id === txn.id || t.classifiedAs !== "vendor_bill" || t.classifiedRef?.interCo) return sum;
    if (t.classifiedRef?.billPayments && typeof t.classifiedRef.billPayments === "object") return sum + (+t.classifiedRef.billPayments[bid] || 0);
    const ids = t.classifiedRef?.billIds || (t.classifiedRef?.billId ? [t.classifiedRef.billId] : []);
    if (!ids.includes(bid)) return sum;
    let remaining = +t.amount || 0;
    const legacy = {};
    for (const id of ids) {
      if (remaining <= 0.005) break;
      const bill = allBills.find(b => b.id === id);
      const cap = Math.max(0, +bill?.totalAmount || remaining);
      const applied = Math.min(cap || remaining, remaining);
      if (applied > 0) legacy[id] = applied;
      remaining -= applied;
    }
    return sum + (+legacy[bid] || 0);
  }, 0);
  const billPaid = b => b?.source === "misc-bill-maker" && !b.paymentNote ? ledgerPaidForBill(b.id) + (+priorBillPayments[b.id] || 0) : (+b?.paidAmount || 0);
  const billDue = b => Math.max(0, (+b.totalAmount || 0) - billPaid(b));
  const priorBillPayments = (() => {
    if (txn.classifiedAs !== "vendor_bill" || txn.classifiedRef?.interCo) return {};
    if (txn.classifiedRef?.billPayments && typeof txn.classifiedRef.billPayments === "object") return txn.classifiedRef.billPayments;
    const ids = txn.classifiedRef?.billIds || (txn.classifiedRef?.billId ? [txn.classifiedRef.billId] : []);
    let remaining = txnAmt;
    const out = {};
    for (const id of ids) {
      if (remaining <= 0.005) break;
      const bill = allBills.find(b => b.id === id);
      const cap = Math.max(0, +bill?.totalAmount || remaining);
      const applied = Math.min(cap || remaining, remaining);
      if (applied > 0) out[id] = applied;
      remaining -= applied;
    }
    return out;
  })();
  const poTotal = po => +po.totalAmount || (po.items || []).reduce((s, i) => s + (+i.amt || 0), 0);
  const poDue = po => Math.max(0, poTotal(po) - (+po.paidAmount || 0));
  const invTotal = inv => +inv.totalAmt || (inv.items || []).reduce((s, i) => s + (+i.amt || 0), 0);
  const invPaid = inv => (+inv.paidAmount || 0) + (inv.payments || []).reduce((s, p) => s + (+p.amount || 0), 0);
  const invDue = inv => Math.max(0, invTotal(inv) - invPaid(inv));
  const invNoOf = inv => inv.invNo || inv.invNumber || inv.number || "";
  const invoicePaidSourceLines = inv => {
    const invNo = invNoOf(inv);
    const linked = (ledgerTxns || []).filter(t => {
      if (!t || t.id === txn.id || t.classifiedAs !== "customer_receipt") return false;
      const ref = t.classifiedRef || {};
      const ids = ref.invoiceIds || (ref.invoiceId ? [ref.invoiceId] : []);
      const nums = ref.invNumbers || (ref.invNumber ? [ref.invNumber] : []);
      return ids.includes(inv.id) || (invNo && nums.includes(invNo));
    });
    const lines = [];
    linked.slice(0, 2).forEach(t => lines.push(`Paid from ${fmtDate(t.date)} receipt: ${moneyText(+t.amount || 0, t.currency || cur)}${t.payee ? ` · ${t.payee}` : ""}`));
    (inv.payments || []).slice(0, Math.max(0, 2 - lines.length)).forEach(p => lines.push(`Recorded on invoice: ${moneyText(+p.amount || 0, p.currency || inv.currency || cur)}${p.date ? ` · ${fmtDate(p.date)}` : ""}`));
    const directlyPaid = +inv.paidAmount || 0;
    const linkedAmt = linked.reduce((s, t) => s + convertMoney(+t.amount || 0, t.currency || cur, inv.currency || cur), 0);
    const paymentRowsAmt = (inv.payments || []).reduce((s, p) => s + (+p.amount || 0), 0);
    const unexplained = Math.max(0, directlyPaid - linkedAmt - paymentRowsAmt);
    if (unexplained > 0.5 && lines.length < 2) lines.push(`Marked paid on invoice: ${moneyText(unexplained, inv.currency || cur)}`);
    const selectedMatches = !txn.classifiedAs && Math.abs(convertMoney(txnAmt, cur, inv.currency || cur) - invPaid(inv)) <= 1;
    if (selectedMatches) lines.unshift(`This selected payment matches the paid amount, but is not linked yet.`);
    return lines.slice(0, 2);
  };
  const totalBillsDue = selectedBills.reduce((s, b) => s + billDue(b), 0);
  // Advance/credit pooled for this vendor: money already advanced on their open POs plus any
  // running credit balance. Applying it against a bill lets you clear what's left after cash
  // (e.g. ₹60k advanced on a PO + ₹40k paid now settles a ₹1L bill). Only meaningful once a
  // vendor is chosen, since the pool is per-vendor.
  // Only money explicitly booked as an advance counts. Paying against a PO used to be
  // pooled in here too, but that money is already recorded on the PO and carries over
  // when the PO is billed — offering it again as free credit against an unrelated bill
  // spends it twice.
  const vendorCreditAvailable = vendorId ? Math.max(0, +vendor?.creditBalance || 0) : 0;
  const availableAdvance = vendorCreditAvailable;
  // Where that pool actually comes from. Shown in the UI because "advance
  // available" on its own is unauditable — you can't tell a stale credit balance
  // from money genuinely sitting on an open PO without being told which.
  const advanceSources = !vendorId || vendorCreditAvailable <= 0.005 ? [] : [
    { key: "credit", label: "Credit balance on vendor", sub: "from payments booked as an advance", amount: vendorCreditAvailable },
  ];
  const dueAfterCash = Math.max(0, totalBillsDue - txnAmt);
  const maxAdvanceApply = Math.min(availableAdvance, dueAfterCash);
  const advanceToApply = Math.min(Math.max(0, +applyAdvance || 0), maxAdvanceApply);
  const selectedInvDueByCurrency = selectedInvs.reduce((acc, inv) => { const invCur = inv.currency || "USD"; acc[invCur] = (acc[invCur] || 0) + invDue(inv); return acc; }, {});
  const totalInvDueInTxnCurrency = selectedInvs.reduce((s, inv) => s + convertMoney(invDue(inv), inv.currency || "USD", cur), 0);
  const selectedDiffInr = Math.round((selectedInvs.reduce((s, inv) => s + toInr(invDue(inv), inv.currency || "USD"), 0) - toInr(txnAmt, cur)) * 100) / 100;
  useEffect(() => {
    if (recvDiffTouched || selectedInvIds.size === 0) return;
    setRecvDiffMode(Math.abs(selectedDiffInr) <= 5 ? "bank_charges" : "advance");
  }, [recvDiffTouched, selectedInvIds.size, selectedDiffInr]);
  const toggleBill = id => setSelectedBillIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  // Settled bills stay selectable — that's how a payment already recorded elsewhere
  // gets linked to its bill and its document attached — but they're listed apart, so
  // "select bills to pay" isn't contradicted by a row reading ₹0.00 due.
  const billsToPay   = vendorBills.filter(b => billDue(b) > 0.005);
  const billsSettled = vendorBills.filter(b => billDue(b) <= 0.005);
  const renderBillRow = b => {
    const sel = selectedBillIds.has(b.id), due = billDue(b), settled = due <= 0.005;
    return <button key={b.id} onClick={() => toggleBill(b.id)} style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "9px 12px", background: sel ? C.card : C.surface, border: `1.5px solid ${sel ? C.blue : C.border}`, borderRadius: 7, cursor: "pointer", textAlign: "left", opacity: settled && !sel ? .62 : 1 }}>
      <div style={{ width: 18, height: 18, borderRadius: 4, border: `2px solid ${sel ? C.blue : C.border}`, background: sel ? C.blue : "transparent", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 11, fontWeight: 900 }}>{sel ? "✓" : ""}</div>
      <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 12, fontWeight: 800, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.billNumber || "Bill"}</div><div style={{ fontSize: 11, color: C.inkFaint, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.supplier} · {fmtDate(b.billDate)} · {b.status}</div></div>
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        {settled
          ? <><div style={{ fontSize: 12, fontWeight: 800, color: C.green }}>Settled</div><div style={{ fontSize: 10, color: C.inkFaint }}>₹{(+b.totalAmount || 0).toLocaleString("en-IN")} paid</div></>
          : <><div style={{ fontSize: 12, fontWeight: 800, color: C.red }}>₹{due.toLocaleString("en-IN", { minimumFractionDigits: 2 })} due</div><div style={{ fontSize: 10, color: C.inkFaint }}>of ₹{(+b.totalAmount || 0).toLocaleString("en-IN")}</div></>}
      </div>
    </button>;
  };
  const toggleInv = id => setSelectedInvIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const openQuickBill = () => {
    setQuickBill({
      billNumber: txn.refNo || txn.reference || "",
      supplier: vendor?.name || txn.payee || "",
      date: txn.date || "",
      amount: txnAmt ? String(txnAmt) : "",
      currency: cur,
    });
    setQuickBillOpen(true);
  };
  const addQuickBill = () => {
    const supplier = (quickBill.supplier || vendor?.name || txn.payee || "").trim();
    const amount = +quickBill.amount || 0;
    if (!supplier || amount <= 0) return;
    const bill = {
      id: "bill-" + uid(), type: "bill",
      vendorId: vendorId || "", vendorName: supplier, supplier,
      billNumber: quickBill.billNumber || "Bill",
      date: quickBill.date || txn.date, billDate: quickBill.date || txn.date,
      currency: quickBill.currency || cur, totalAmount: amount, paidAmount: 0,
      status: "pending",
      items: [{ id: uid(), desc: txn.notes || txn.payee || "Purchase bill", qty: "1", unit: "lot", rate: String(amount), amt: amount }],
      notes: `Created from transaction ${txn.date || ""}`.trim(),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    setQuickBills(prev => [bill, ...prev]);
    setSelectedBillIds(prev => new Set([...prev, bill.id]));
    if (vendorId || !vendors.length) setVendorId(vendorId);
    setQuickBillOpen(false);
  };
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
  const canSave = classType === "expense" ? !!effectiveExpenseCat : classType === "vendor_bill" ? (selectedBillIds.size > 0 || !!vendorId || !!interCoInvId) : classType === "vendor_po" ? (!!selectedPoId || !!vendorId) : classType === "customer_receipt" ? (selectedInvIds.size > 0 || openInvoices.length === 0) : classType === "cc_payment" ? !!ccAccountId : classType === "conversion" ? (!!convOtherAcct && convRateNum > 0) : true;
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
      const billPayments = {};
      for (const bill of selectedBills) {
        const alreadyFromThisTxn = +priorBillPayments[bill.id] || 0;
        const paidExcludingThisTxn = Math.max(0, billPaid(bill) - alreadyFromThisTxn);
        const total = +bill.totalAmount || 0;
        const due = Math.max(0, total - paidExcludingThisTxn);
        const paying = Math.min(due, remaining);
        const newPaid = paidExcludingThisTxn + paying;
        if (paying > 0) billPayments[bill.id] = +paying.toFixed(2);
        billUpdates.push({ id: bill.id, paidAmount: newPaid, paymentDate: txn.date, status: newPaid >= total && total > 0 ? "paid" : "partial" });
        remaining -= paying;
      }
      Object.entries(priorBillPayments).forEach(([id, amount]) => {
        if (selectedBillIds.has(id) || billUpdates.some(u => u.id === id)) return;
        const bill = allBills.find(b => b.id === id);
        if (!bill) return;
        const total = +bill.totalAmount || 0;
        const paid = Math.max(0, (+bill.paidAmount || 0) - (+amount || 0));
        billUpdates.push({ id, paidAmount: paid, paymentDate: paid > 0 ? bill.paymentDate : undefined, status: paid >= total && total > 0 ? "paid" : paid > 0 ? "partial" : "pending" });
      });
      const credit = Math.max(0, remaining);
      // Apply the vendor's advance/credit on top of the cash, against whatever is still due on
      // each bill. Consumed amount is reported so the parent can draw it down from the vendor's
      // credit balance + open-PO advances, keeping the books consistent.
      let advRemaining = advanceToApply;
      if (advRemaining > 0) {
        for (const upd of billUpdates) {
          if (advRemaining <= 0.005) break;
          const bill = selectedBills.find(b => b.id === upd.id);
          const total = +bill.totalAmount || 0;
          const stillDue = Math.max(0, total - upd.paidAmount);
          const apply = Math.min(stillDue, advRemaining);
          if (apply <= 0) continue;
          upd.paidAmount = +(upd.paidAmount + apply).toFixed(2);
          upd.advanceApplied = +((upd.advanceApplied || 0) + apply).toFixed(2);
          upd.status = upd.paidAmount >= total && total > 0 ? "paid" : "partial";
          advRemaining -= apply;
        }
      }
      const advanceUsed = +(advanceToApply - advRemaining).toFixed(2);
      classifiedRef = { vendorId, vendorName: vendor?.name || txn.payee || "", billIds: [...selectedBillIds], billNumbers: selectedBills.map(b => b.billNumber).filter(Boolean), billPayments, ...(selectedBillIds.size === 0 && { paymentOnAccount: true }), ...(credit > 0 && { creditApplied: credit }), ...(advanceUsed > 0 && { advanceApplied: advanceUsed }), ...(linkedInvId && { linkedInvoiceId: linkedInvId }) };
      if (quickBills.length) sideEffects.newBills = quickBills;
      sideEffects.billUpdates = billUpdates;
      if (advanceUsed > 0 && vendorId) sideEffects.advanceApplied = { vendorId, amount: advanceUsed };
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
      const po = selectedPoId ? purchases.find(p => p.id === selectedPoId) : null;
      if (po) {
        classifiedRef = { vendorId, vendorName: vendor?.name, poId: selectedPoId, poNumber: po?.poNumber };
        sideEffects.poUpdate = { id: selectedPoId, paidAmount: (+po?.paidAmount || 0) + txnAmt };
      } else {
        // No PO chosen → record a plain advance to the vendor. It's added to their credit balance
        // and can be applied against any of their bills later (see the "Apply advance" control).
        classifiedRef = { vendorId, vendorName: vendor?.name || txn.payee || "", paymentOnAccount: true, advanceToVendor: true, advanceAmount: txnAmt };
        if (vendorId) sideEffects.vendorCredit = { vendorId, amount: txnAmt };
      }
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

  // Inline mode: let the surrounding form trigger our save and know when we're ready.
  useImperativeHandle(ref, () => ({ submit: save, canSave }));
  useEffect(() => { onValidityChange?.(canSave); }, [canSave]);

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
    <div onMouseDown={e => { if (!inline && e.target === e.currentTarget) onClose(); }} style={inline ? {} : { position: "fixed", inset: 0, zIndex: 95, background: "rgba(26,19,8,.48)", display: "flex", alignItems: mob ? "stretch" : "center", justifyContent: "center", padding: mob ? 0 : 16 }}>
      <div onMouseDown={e => e.stopPropagation()} style={inline ? {} : { width: mob ? "100%" : 500, maxWidth: "100%", height: mob ? "100%" : "auto", maxHeight: mob ? "100%" : "90vh", overflowY: "auto", background: C.bg, border: mob ? "none" : `1.5px solid ${C.border}`, borderRadius: mob ? 0 : 12, padding: mob ? "20px 16px" : "24px 26px", boxShadow: "0 20px 60px rgba(0,0,0,.3)" }}>
        {!inline && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 18 }}>
          <div><div style={{ fontWeight: 800, fontSize: 15, color: C.ink }}>Classify Transaction</div><div style={{ fontSize: 12, color: C.inkFaint, marginTop: 3 }}>{sym}{txnAmt.toLocaleString("en-IN", { minimumFractionDigits: 2 })} · {txn.payee || "No payee"} · {fmtDate(txn.date)}</div></div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: C.inkFaint, fontSize: 18, lineHeight: 1, padding: "0 4px" }}>×</button>
        </div>
        )}
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
          <Field label="Filter by Vendor (optional)">{(() => {
            const sorted = [...vendors].sort((a, b) => (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" }));
            const q = vendorQuery.trim().toLowerCase();
            const filtered = q ? sorted.filter(v => (v.name || "").toLowerCase().includes(q)) : sorted;
            const selName = vendors.find(v => v.id === vendorId)?.name || "";
            const choices = [{ id: "", name: "All vendors" }, ...filtered];
            const pick = id => { setVendorId(id); setSelectedBillIds(new Set()); setSelectedPoId(""); setVendorQuery(""); setVendorActiveIndex(0); setVendorOpen(false); };
            const rowSt = { display: "block", width: "100%", textAlign: "left", border: "none", background: "transparent", padding: "8px 10px", fontSize: 13, color: C.ink, cursor: "pointer", borderRadius: 6, fontFamily: "inherit" };
            return (
              <div style={{ position: "relative" }}>
                <input
                  value={vendorOpen ? vendorQuery : (selName || "All vendors")}
                  placeholder="All vendors — type to search"
                  onFocus={() => { setVendorQuery(""); setVendorActiveIndex(0); setVendorOpen(true); }}
                  onChange={e => { setVendorQuery(e.target.value); setVendorActiveIndex(0); setVendorOpen(true); }}
                  onKeyDown={e => {
                    if (e.key === "Escape") { e.preventDefault(); setVendorQuery(""); setVendorActiveIndex(0); setVendorOpen(false); }
                    if (e.key === "ArrowDown") { e.preventDefault(); setVendorOpen(true); setVendorActiveIndex(i => Math.min(i + 1, choices.length - 1)); }
                    if (e.key === "ArrowUp") { e.preventDefault(); setVendorOpen(true); setVendorActiveIndex(i => Math.max(i - 1, 0)); }
                    if (e.key === "Enter") { e.preventDefault(); pick(choices[vendorActiveIndex]?.id || ""); }
                  }}
                  onBlur={() => setTimeout(() => { setVendorQuery(""); setVendorActiveIndex(0); setVendorOpen(false); }, 150)}
                  style={{ ...SI, cursor: "text" }} />
                {vendorOpen && (
                  <div style={{ position: "absolute", left: 0, right: 0, top: "calc(100% + 6px)", zIndex: 6, background: C.surface, border: `1.5px solid ${C.border}`, borderRadius: 10, boxShadow: "0 18px 44px rgba(26,19,8,.18)", padding: 6, maxHeight: 260, overflowY: "auto" }}>
                    {choices.map((v, idx) => (
                      <button key={v.id || "__all"} type="button" onMouseDown={e => e.preventDefault()} onMouseEnter={() => setVendorActiveIndex(idx)} onClick={() => pick(v.id)} style={{ ...rowSt, fontWeight: v.id === vendorId ? 900 : 600, background: idx === vendorActiveIndex ? C.card : (v.id === vendorId ? C.goldLight : "transparent") }}>{v.name}</button>
                    ))}
                    {filtered.length === 0 && <div style={{ padding: "8px 10px", fontSize: 12, color: C.inkFaint }}>No vendors match “{vendorQuery}”</div>}
                  </div>
                )}
              </div>
            );
          })()}</Field>
          {classType === "vendor_bill" && <div><div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 6 }}><div style={{ fontSize: 10, fontWeight: 900, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .65 }}>Select bills to pay {vendorId ? `- ${vendor?.name}` : "(all vendors)"} <span style={{ fontWeight: 500 }}>(tap to select multiple)</span></div><div style={{ display: "flex", gap: 6, flexShrink: 0 }}>{onUploadBill && <button type="button" onClick={onUploadBill} title="Upload a bill document — opens the Purchases bill scanner, then returns here with it selected" style={{ border: `1px solid ${C.blue}55`, background: C.blue, color: "#fff", borderRadius: 6, padding: "5px 8px", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>⬆ Upload Bill</button>}<button type="button" onClick={openQuickBill} style={{ border: `1px solid ${C.blue}55`, background: C.blueBg, color: C.blue, borderRadius: 6, padding: "5px 8px", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>+ Add bill</button></div></div>
            {quickBillOpen && <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: 10, display: "grid", gridTemplateColumns: mob ? "1fr" : "1fr 1.2fr 1fr 1fr .8fr", gap: 8, marginBottom: 8 }}>
              <input value={quickBill.billNumber} onChange={e => setQuickBill(q => ({ ...q, billNumber: e.target.value }))} placeholder="Bill no." style={SI} />
              <input value={quickBill.supplier} onChange={e => setQuickBill(q => ({ ...q, supplier: e.target.value }))} placeholder="Vendor" style={SI} />
              <input type="date" value={quickBill.date} onChange={e => setQuickBill(q => ({ ...q, date: e.target.value }))} style={SI} />
              <input type="number" min="0" step="0.01" value={quickBill.amount} onChange={e => setQuickBill(q => ({ ...q, amount: e.target.value }))} placeholder="Amount" style={SI} />
              <select value={quickBill.currency || cur} onChange={e => setQuickBill(q => ({ ...q, currency: e.target.value }))} style={SI}>{Object.keys(CUR_SYM).map(c => <option key={c} value={c}>{c}</option>)}</select>
              <div style={{ gridColumn: mob ? "auto" : "1/-1", display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button type="button" onClick={() => setQuickBillOpen(false)} style={{ border: `1px solid ${C.border}`, background: C.surface, color: C.inkMid, borderRadius: 6, padding: "7px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Cancel</button>
                <button type="button" onClick={addQuickBill} disabled={!(quickBill.supplier || vendor?.name || txn.payee) || !(+quickBill.amount > 0)} style={{ border: "none", background: C.blue, color: "#fff", borderRadius: 6, padding: "7px 12px", fontSize: 12, fontWeight: 800, cursor: (+quickBill.amount > 0) ? "pointer" : "default", opacity: (+quickBill.amount > 0) ? 1 : .55 }}>Add & select</button>
              </div>
            </div>}
            {vendorBills.length === 0 ? <div style={{ fontSize: 12, color: C.inkFaint, padding: "8px 0" }}>{vendorId ? `No open bills — this records an advance to ${vendor?.name || "the vendor"}, offset against their future bills.` : "No open bills. Pick a vendor above to record this as an advance to them."}</div> : <div style={{ maxHeight: 240, overflowY: "auto", display: "grid", gap: 6 }}>
              {billsToPay.map(renderBillRow)}
              {billsToPay.length === 0 && (
                <div style={{ fontSize: 11, color: C.inkFaint, padding: "6px 2px" }}>
                  Nothing outstanding for {vendor?.name || "this vendor"} — this will be saved as an advance unless you link it to a settled bill below.
                </div>
              )}
              {billsSettled.length > 0 && (
                <div style={{ display: "grid", gap: 6, marginTop: billsToPay.length ? 4 : 0 }}>
                  <div style={{ fontSize: 9, fontWeight: 800, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .5, paddingTop: 7, borderTop: `1px dashed ${C.border}` }}>
                    Already settled · nothing to pay
                  </div>
                  <div style={{ fontSize: 10, color: C.inkFaint, marginTop: -2 }}>
                    Pick one only to attach this payment or its document to the bill — it adds ₹0.
                  </div>
                  {billsSettled.map(renderBillRow)}
                </div>
              )}
            </div>}
            {selectedBillIds.size > 0 && <div style={{ marginTop: 10, padding: "10px 13px", background: C.card, borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}><span style={{ color: C.inkFaint }}>Selected due</span><b>₹{totalBillsDue.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</b></div>
              <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: C.inkFaint }}>Payment amount</span><b>₹{txnAmt.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</b></div>
              {availableAdvance > 0.005 && <div style={{ marginTop: 8, padding: "9px 10px", borderTop: `1px dashed ${C.border}`, background: C.surface, borderRadius: 7 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 6 }}>
                  <span style={{ color: C.green, fontWeight: 900 }}>Vendor advance available: ₹{availableAdvance.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</span>
                  <button type="button" onClick={() => setApplyAdvance(String(maxAdvanceApply))} disabled={maxAdvanceApply <= 0} style={{ border: `1px solid ${C.green}55`, background: C.greenBg, color: C.green, borderRadius: 6, padding: "4px 9px", fontSize: 11, fontWeight: 800, cursor: maxAdvanceApply > 0 ? "pointer" : "default", opacity: maxAdvanceApply > 0 ? 1 : .5, flexShrink: 0 }}>Use max</button>
                </div>
                {advanceSources.length > 0 && (
                  <div style={{ marginBottom: 8, paddingBottom: 7, borderBottom: `1px dashed ${C.border}` }}>
                    <div style={{ fontSize: 10, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .5, fontWeight: 700, marginBottom: 3 }}>Made up of</div>
                    {advanceSources.map(s => (
                      <div key={s.key} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, fontSize: 11, marginTop: 3 }}>
                        <span style={{ color: C.inkMid, minWidth: 0 }}>
                          {s.label}
                          {s.sub && <span style={{ color: C.inkFaint }}> · {s.sub}</span>}
                        </span>
                        <b style={{ color: C.inkMid, flexShrink: 0 }}>₹{s.amount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</b>
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ fontSize: 11, color: C.inkFaint, marginBottom: 8 }}>Money already paid to this vendor. Enter an amount only if you want to use it to reduce this bill.</div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ color: C.inkMid, whiteSpace: "nowrap" }}>Use advance ₹</span>
                  <input type="number" min="0" step="0.01" value={applyAdvance} onChange={e => setApplyAdvance(e.target.value)} placeholder="0.00" style={{ ...SI, padding: "6px 8px" }} />
                  {applyAdvance !== "" && <button type="button" onClick={() => setApplyAdvance("")} style={{ border: "none", background: "transparent", color: C.inkFaint, cursor: "pointer", fontSize: 11, flexShrink: 0 }}>clear</button>}
                </div>
                {(+applyAdvance || 0) > maxAdvanceApply + 0.005 && <div style={{ marginTop: 4, fontSize: 11, color: C.amber }}>Capped at ₹{maxAdvanceApply.toLocaleString("en-IN", { minimumFractionDigits: 2 })} (available / due after cash).</div>}
                {advanceToApply > 0 && (() => { const paidToBills = Math.min(txnAmt, totalBillsDue) + advanceToApply; const cleared = paidToBills >= totalBillsDue - 0.01; return <div style={{ marginTop: 6, fontSize: 11, color: cleared ? C.green : C.inkMid, fontWeight: cleared ? 800 : 500 }}>Bill{selectedBillIds.size > 1 ? "s" : ""} settled ₹{paidToBills.toLocaleString("en-IN", { minimumFractionDigits: 2 })} of ₹{totalBillsDue.toLocaleString("en-IN", { minimumFractionDigits: 2 })}{cleared ? " · fully cleared ✓" : ` · ₹${Math.max(0, totalBillsDue - paidToBills).toLocaleString("en-IN", { minimumFractionDigits: 2 })} still due`}</div>; })()}
              </div>}
            </div>}
            {selectedBillIds.size === 0 && vendorId && <div style={{ marginTop: 10, padding: "10px 13px", background: C.blueBg, border: `1px solid ${C.blue}55`, borderRadius: 8, fontSize: 12, color: C.inkMid }}>
              No purchase bill selected. This will still be saved in <strong>{vendor?.name || "the vendor"}'s ledger</strong> as a payment on account / advance.
            </div>}
          </div>}
          {classType === "vendor_po" && <div><div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 6 }}><div style={{ fontSize: 10, fontWeight: 900, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .65 }}>Open POs {vendorId ? `- ${vendor?.name}` : "(all vendors)"}</div>{onCreatePO && <button type="button" onClick={onCreatePO} title="Create a new Purchase Order — opens the Purchases PO form, then returns here with it selected" style={{ border: `1px solid ${C.purple}55`, background: C.purple, color: "#fff", borderRadius: 6, padding: "5px 8px", fontSize: 11, fontWeight: 800, cursor: "pointer", flexShrink: 0 }}>+ New PO</button>}</div>
            {vendorPOs.length === 0 ? <div style={{ fontSize: 12, color: C.inkFaint, padding: "8px 0" }}>No open POs found.</div> : <div style={{ maxHeight: 220, overflowY: "auto", display: "grid", gap: 6 }}>{vendorPOs.map(po => { const total = poTotal(po), due = poDue(po), poCur = po.currency || "INR"; return <button key={po.id} onClick={() => setSelectedPoId(po.id)} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, width: "100%", padding: "9px 12px", background: selectedPoId === po.id ? C.card : C.surface, border: `1.5px solid ${selectedPoId === po.id ? C.purple : C.border}`, borderRadius: 7, cursor: "pointer", textAlign: "left" }}><div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 12, fontWeight: 800, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{po.poNumber || "PO"}</div><div style={{ fontSize: 11, color: C.inkFaint, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{po.supplier} · {fmtDate(po.date)} · {po.status}</div></div><div style={{ textAlign: "right", flexShrink: 0 }}><div style={{ fontSize: 12, fontWeight: 800, color: C.ink }}>{moneyText(total, poCur)}</div>{(+po.paidAmount || 0) > 0 && <div style={{ fontSize: 10, color: C.inkFaint }}>{moneyText(due, poCur)} left</div>}</div></button>; })}</div>}
            {!selectedPoId && <div style={{ marginTop: 10, padding: "10px 13px", background: vendorId ? C.blueBg : C.surface, border: `1px solid ${vendorId ? C.blue + "55" : C.border}`, borderRadius: 8, fontSize: 12, color: C.inkMid }}>{vendorId ? <>No PO selected — this records <b>₹{txnAmt.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</b> as an advance to <strong>{vendor?.name}</strong>, added to their credit and usable against any future bill.</> : <>Pick a vendor above to record this as an advance to them (usable against future bills), or select a PO.</>}</div>}
          </div>}
        </div>}
        {classType === "customer_receipt" && <div>
          <Field label="Filter by buyer / vendor (optional)">
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input list="acct-class-buyers" value={receiptPartyQuery} onChange={e => setReceiptPartyQuery(e.target.value)} placeholder="Type buyer/vendor name..." style={{ ...SI, flex: 1 }} />
              {receiptPartyQuery && <button type="button" onClick={() => setReceiptPartyQuery("")} style={{ border: `1px solid ${C.border}`, background: C.surface, color: C.inkMid, borderRadius: 7, padding: "8px 10px", fontSize: 12, cursor: "pointer", fontFamily: "inherit", flexShrink: 0 }}>Clear</button>}
            </div>
          </Field>
          <div style={{ fontSize: 10, fontWeight: 900, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .65, margin: "10px 0 6px" }}>Apply against invoice(s){receiptPartyQuery ? ` - ${receiptPartyQuery}` : ""}</div>
          {openInvoices.length === 0 ? <div style={{ fontSize: 12, color: C.inkFaint, padding: "8px 0" }}>No open invoices found — save anyway to record this as a sales receipt.</div> : openInvoices.map(inv => { const checked = selectedInvIds.has(inv.id), due = invDue(inv), paidLines = invoicePaidSourceLines(inv), buyerName = buyers.find(b => b.id === inv.buyerId)?.name || inv.buyerName || "Buyer"; return <button key={inv.id} onClick={() => toggleInv(inv.id)} style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "9px 12px", marginBottom: 6, background: checked ? C.card : C.surface, border: `1.5px solid ${checked ? C.green : C.border}`, borderRadius: 7, cursor: "pointer", textAlign: "left" }}><div style={{ width: 16, height: 16, borderRadius: 4, border: `2px solid ${checked ? C.green : C.border}`, background: checked ? C.green : "transparent", color: "#fff", fontSize: 10, fontWeight: 900, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{checked ? "✓" : ""}</div><div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 12, fontWeight: 800, color: C.ink }}>{invNoOf(inv) || "(no number)"}</div><div style={{ fontSize: 11, color: C.inkFaint }}>{buyerName} · {fmtDate(inv.date)} · {inv.status || "-"}</div>{paidLines.map((line, i) => <div key={i} style={{ fontSize: 10, color: line.startsWith("This selected") ? C.amber : C.green, marginTop: 2, fontWeight: line.startsWith("This selected") ? 850 : 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{line}</div>)}</div><div style={{ textAlign: "right", flexShrink: 0 }}><div style={{ fontSize: 12, fontWeight: 800, color: C.red }}>{inv.currency || "USD"} {due.toLocaleString(undefined, { minimumFractionDigits: 2 })} due</div><div style={{ fontSize: 10, color: C.inkFaint }}>of {inv.currency || "USD"} {invTotal(inv).toLocaleString(undefined, { minimumFractionDigits: 2 })}</div></div></button>; })}
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
                    <button key={id} onClick={() => { setRecvDiffTouched(true); setRecvDiffMode(id); }} style={{ flex: 1, padding: "7px 8px", borderRadius: 7, cursor: "pointer", textAlign: "left", background: recvDiffMode === id ? C.surface : "transparent", border: `1.5px solid ${recvDiffMode === id ? C.gold : C.border}` }}>
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
        <datalist id="acct-class-buyers">{buyers.map(b => <option key={b.id || b.name} value={b.name || b.contactName || ""} />)}</datalist>
        {!inline && <div style={{ display: "flex", gap: 10, marginTop: 22 }}><button onClick={save} disabled={!canSave} style={{ flex: 1, background: C.gold, border: "none", color: "#fff", borderRadius: 7, padding: "10px 0", fontWeight: 800, fontSize: 13, cursor: canSave ? "pointer" : "not-allowed", opacity: canSave ? 1 : .5, fontFamily: "inherit" }}>Save Classification</button><button onClick={onClose} style={{ padding: "10px 16px", background: C.surface, border: `1.5px solid ${C.border}`, color: C.ink, borderRadius: 7, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>Cancel</button></div>}
      </div>
    </div>
  );
});

export default ClassifyTransactionModal;
