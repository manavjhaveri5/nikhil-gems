// ─── Accounting classification learner ────────────────────────────────────────
// A lightweight, self-improving classifier for the Accounting Journal. Every time
// the user confirms a classification we append it to a per-company dataset in
// Supabase. New transactions are matched against that history (instant, free,
// explainable). When nothing in the history matches, we fall back to Claude,
// feeding it the user's own past decisions as examples so it generalises in the
// user's style. Nothing is auto-booked — callers use this only to pre-fill.

import { loadK, saveK } from "./utils.js";

const MAX_RECORDS = 4000; // keep the dataset bounded; drop oldest beyond this

export const learnKey = company => `${company || "ng"}-fin-classify-learn-v1`;

// Words that carry no merchant meaning in Indian bank narrations.
const STOP = new Set([
  "upi", "neft", "imps", "rtgs", "dr", "cr", "the", "and", "ltd", "pvt", "inc",
  "payment", "pay", "paid", "to", "from", "via", "ref", "no", "bank", "account",
  "ac", "txn", "trf", "transfer", "online", "purchase", "pos", "card", "bil",
  "bill", "india", "limited", "co", "intl", "international",
]);

const tokenize = s =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(t => t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t));

// A transaction's identity for matching: meaningful tokens from the cleaned payee
// (primary) plus the details/notes (fallback), and its money direction.
const txnTokens = txn => {
  const fromPayee = tokenize(txn?.payee);
  const toks = fromPayee.length ? fromPayee : tokenize(txn?.notes);
  return [...new Set(toks)];
};
const direction = txn => (txn?.type === "credit" ? "credit" : "debit");

const jaccard = (a, b) => {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  const inter = a.filter(t => setB.has(t)).length;
  return inter / (a.length + b.length - inter);
};

// The outcome we group decisions by. Party is excluded from the key (it tracks the
// payee), but carried along from the winning record so we can pre-fill it.
const outcomeKey = r =>
  `${r.classifiedAs || ""}::${r.cat || ""}::${r.vendorId || ""}::${r.cardAccountId || ""}`;

export const loadLearnMemory = async company => {
  const m = await loadK(learnKey(company));
  return Array.isArray(m) ? m : [];
};

// Append one confirmed classification to the dataset. Returns the new array so the
// caller can keep an in-memory copy in sync.
export const recordClassification = async (company, txn, decision) => {
  if (!txn || !decision?.classifiedAs) return null;
  const rec = {
    toks: txnTokens(txn),
    dir: direction(txn),
    payee: txn.payee || "",
    classifiedAs: decision.classifiedAs,
    cat: decision.cat || "",
    party: decision.party || txn.payee || "",
    vendorId: decision.vendorId || "",
    cardAccountId: decision.cardAccountId || "",
    ts: Date.now(),
  };
  if (!rec.toks.length) return null; // nothing to learn from (e.g. blank payee)
  const mem = await loadLearnMemory(company);
  const next = [...mem, rec].slice(-MAX_RECORDS);
  await saveK(learnKey(company), next);
  return next;
};

// Find the best learned classification for a transaction. Returns null when there's
// no reasonable match, else { classifiedAs, cat, party, vendorId, cardAccountId,
// count, total, confidence, why }.
export const matchLearned = (memory, txn) => {
  const toks = txnTokens(txn);
  if (!toks.length || !Array.isArray(memory) || !memory.length) return null;
  const dir = direction(txn);
  const groups = {}; // outcomeKey -> { weight, count, rec }
  let totalWeight = 0;
  for (const r of memory) {
    if (r.dir !== dir) continue;
    const score = jaccard(toks, r.toks || []);
    if (score < 0.5) continue;
    // Recent decisions weigh a touch more; exact matches dominate.
    const w = score * score;
    totalWeight += w;
    const k = outcomeKey(r);
    if (!groups[k]) groups[k] = { weight: 0, count: 0, rec: r };
    groups[k].weight += w;
    groups[k].count += 1;
    if ((r.ts || 0) >= (groups[k].rec.ts || 0)) groups[k].rec = r;
  }
  const ranked = Object.values(groups).sort((a, b) => b.weight - a.weight);
  if (!ranked.length) return null;
  const top = ranked[0];
  const confidence = totalWeight ? top.weight / totalWeight : 0;
  const r = top.rec;
  return {
    classifiedAs: r.classifiedAs,
    cat: r.cat || "",
    party: r.party || txn.payee || "",
    vendorId: r.vendorId || "",
    cardAccountId: r.cardAccountId || "",
    count: top.count,
    total: Object.values(groups).reduce((s, g) => s + g.count, 0),
    confidence,
    source: "learned",
  };
};

// Compact, token-light summary of the user's past decisions for the AI prompt:
// the most common (payee → Type · Category) pairs, capped.
const summarizeMemory = (memory, dir, max = 40) => {
  const byKey = {};
  for (const r of memory || []) {
    if (dir && r.dir !== dir) continue;
    const label = r.classifiedAs === "expense" ? `Expense · ${r.cat || "Other"}`
      : r.classifiedAs === "vendor_bill" ? "Vendor Bill Payment"
      : r.classifiedAs === "vendor_po" ? "Advance against PO"
      : r.classifiedAs === "cc_payment" ? "Credit Card Payment"
      : r.classifiedAs === "customer_receipt" ? "Sales Receipt"
      : r.classifiedAs === "conversion" ? "Currency Conversion" : r.classifiedAs;
    const payee = (r.payee || (r.toks || []).join(" ")).trim();
    if (!payee) continue;
    const k = `${payee.toLowerCase()}|${label}`;
    if (!byKey[k]) byKey[k] = { payee, label, n: 0 };
    byKey[k].n += 1;
  }
  return Object.values(byKey)
    .sort((a, b) => b.n - a.n)
    .slice(0, max)
    .map(e => `- "${e.payee}" → ${e.label}`)
    .join("\n");
};

// Ask Claude to classify, primed with the user's own history. Returns a suggestion
// shaped like matchLearned (source: "ai") or null. Self-contained fetch so the
// learner stays modular.
export const aiSuggest = async ({ company, txn, memory, expenseCats = [] }) => {
  try {
    const dir = direction(txn);
    const examples = summarizeMemory(memory, dir);
    const sym = txn.currency || "INR";
    const isDebit = dir === "debit";
    const types = isDebit
      ? "expense, vendor_bill (paying a purchase bill), vendor_po (advance on a PO), cc_payment (paying a credit-card company), conversion (transfer between own accounts)"
      : "customer_receipt (money received from a buyer/invoice), cc_payment, conversion, expense (refund/misc)";
    const prompt =
`You classify bank transactions for a gemstone & jewelry export business in India.
Pick the best TYPE: ${types}.
If the type is "expense", also pick a CATEGORY. Prefer one of these standard categories when it fits: ${expenseCats.join(", ")}. If none fit, use a short custom category in Title Case (e.g. Food, Marketing, Software).

How THIS user has classified similar transactions before:
${examples || "(no history yet)"}

Classify this transaction:
- Direction: ${isDebit ? "money out (debit)" : "money in (credit)"}
- Payee / source: ${txn.payee || "(unknown)"}
- Details / notes: ${txn.notes || "(none)"}
- Amount: ${sym} ${(+txn.amount || 0).toLocaleString("en-IN")}

Reply with ONLY a JSON object, no prose:
{"classifiedAs":"expense|vendor_bill|vendor_po|cc_payment|customer_receipt|conversion","cat":"<category if expense, else empty>","party":"<merchant/vendor name>","why":"<short reason>"}`;

    const res = await fetch("/api/claude", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-4-5", max_tokens: 400, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.error) return null;
    const text = data.content?.find(b => b.type === "text")?.text || (typeof data === "string" ? data : "");
    const match = String(text).match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    if (!parsed?.classifiedAs) return null;
    return {
      classifiedAs: parsed.classifiedAs,
      cat: parsed.cat || "",
      party: parsed.party || txn.payee || "",
      vendorId: "",
      cardAccountId: "",
      why: parsed.why || "",
      confidence: 0,
      source: "ai",
    };
  } catch { return null; }
};
