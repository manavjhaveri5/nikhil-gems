// ─── Accounting classification learner (ambient, self-improving) ──────────────
// Every action the user takes in the Accounting Journal — classify, correct, rename
// a payee, edit notes, assign a party, change a category — is captured as ONE evolving
// precedent per transaction in a per-company Supabase dataset. New transactions are
// matched against that history three ways, cheapest first:
//   1. matchLearned  — exact/near token match → instant, free local pre-fill.
//   2. retrieveSimilar + AI — semantic (embedding) retrieval of the most similar past
//      decisions, fed to the model as targeted few-shot examples, for novel txns.
// Corrections (where the user overruled the AI) are stored and up-weighted, so the
// system measurably improves on cases it previously got wrong. Nothing is auto-booked.

import { loadK, saveK, uid } from "./utils.js";
import { embedText, embedBatch, classify } from "./aiClient.js";

const MAX_RECORDS = 4000;     // keep the dataset bounded; drop oldest beyond this
const RETRIEVAL_K = 8;        // few-shot examples handed to the model
const MATCH_FLOOR = 0.5;      // confident local match (matchLearned)
const RETRIEVAL_FLOOR = 0.2;  // looser neighbour floor for few-shot retrieval
const CORRECTION_WEIGHT = 2.0;

export const learnKey    = company => `${company || "ng"}-fin-classify-learn-v1`;
export const learnEmbKey = company => `${company || "ng"}-fin-classify-emb-v1`;

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

// A transaction's identity: meaningful tokens from the ORIGINAL bank narration
// (rawPayee/rawNotes preserved on first edit, else the current payee/notes), so a new
// raw line matches what the user once cleaned it into. Numeric refs / bank noise are
// stripped, so different lines from the same merchant collapse to one fingerprint.
const txnTokens = txn => {
  const fromPayee = tokenize(txn?.rawPayee || txn?.payee);
  const toks = fromPayee.length ? fromPayee : tokenize(txn?.rawNotes || txn?.notes);
  return [...new Set(toks)];
};
const direction = txn => (txn?.type === "credit" ? "credit" : "debit");
const embText = r => `${r.rawPayee || r.payee || ""} ${r.payee || ""} ${r.notes || ""}`.trim();

const jaccard = (a, b) => {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  const inter = a.filter(t => setB.has(t)).length;
  return inter / (a.length + b.length - inter);
};
const cosine = (a, b) => {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
};

const CLASS_TYPES = ["expense", "vendor_bill", "vendor_po", "cc_payment", "customer_receipt", "conversion"];
// Normalize an LLM-returned type ("Expense", "Vendor Bill Payment", …) to a canonical key.
const normClass = v => {
  const s = String(v || "").toLowerCase().trim().replace(/[\s-]+/g, "_");
  if (CLASS_TYPES.includes(s)) return s;
  if (s.includes("vendor") && s.includes("bill")) return "vendor_bill";
  if (s.includes("advance") || s.includes("_po") || s.endsWith("po")) return "vendor_po";
  if (s.includes("credit_card") || s === "cc" || s.includes("card_payment")) return "cc_payment";
  if (s.includes("sales") || s.includes("receipt") || s.includes("customer")) return "customer_receipt";
  if (s.includes("conversion") || s.includes("transfer")) return "conversion";
  return "expense";
};

const recLabel = r =>
  r.classifiedAs === "expense" ? `Expense · ${r.cat || "Other"}`
    : r.classifiedAs === "vendor_bill" ? "Vendor Bill Payment"
    : r.classifiedAs === "vendor_po" ? "Advance against PO"
    : r.classifiedAs === "cc_payment" ? "Credit Card Payment"
    : r.classifiedAs === "customer_receipt" ? "Sales Receipt"
    : r.classifiedAs === "conversion" ? "Currency Conversion" : r.classifiedAs;

// The outcome we group classification decisions by.
const outcomeKey = r =>
  `${r.classifiedAs || ""}::${r.cat || ""}::${r.vendorId || ""}::${r.cardAccountId || ""}`;

export const loadLearnMemory = async company => {
  const m = await loadK(learnKey(company));
  return Array.isArray(m) ? m : [];
};
export const loadEmbMap = async company => {
  const m = await loadK(learnEmbKey(company));
  return (m && typeof m === "object" && !Array.isArray(m)) ? m : {};
};

// ── Ambient capture: upsert ONE precedent per transaction ─────────────────────
// Called on any meaningful edit (payee/notes/party/category/type/classify). Keeps a
// single evolving record per txnId so repeated edits don't spam the dataset.
// Returns { memory, rec } (or null) so the caller can sync state + embed the record.
export const recordDecision = async (company, txn, decision = {}) => {
  if (!txn) return null;
  const toks = txnTokens(txn);
  if (!toks.length) return null; // nothing to learn from (blank payee/notes)
  const txnId = txn.id || "";
  const mem = await loadLearnMemory(company);
  const existing = txnId ? mem.find(r => r.txnId === txnId) : null;
  const rec = {
    id: existing?.id || uid(),
    txnId,
    toks,
    dir: direction(txn),
    rawPayee: txn.rawPayee || txn.payee || "",
    payee: txn.payee || "",
    notes: txn.notes || "",
    type: txn.type || "debit",
    classifiedAs: decision.classifiedAs || existing?.classifiedAs || "",
    cat: decision.cat != null ? decision.cat : (existing?.cat || ""),
    party: decision.party || txn.payee || existing?.party || "",
    vendorId: decision.vendorId || existing?.vendorId || "",
    cardAccountId: decision.cardAccountId || existing?.cardAccountId || "",
    corrected: decision.corrected != null ? decision.corrected : (existing?.corrected || false),
    aiWas: decision.aiWas || existing?.aiWas || null,
    ts: Date.now(),
  };
  const without = existing ? mem.filter(r => r !== existing) : mem;
  const next = [...without, rec].slice(-MAX_RECORDS);
  await saveK(learnKey(company), next);
  return { memory: next, rec };
};

// Backwards-compatible wrapper (returns the memory array like the old API).
export const recordClassification = async (company, txn, decision) => {
  if (!decision?.classifiedAs) return null;
  const r = await recordDecision(company, txn, decision);
  return r?.memory || null;
};

// Embed one precedent's text and persist the vector under the separate emb key.
export const embedAndStore = async (company, rec) => {
  try {
    if (!rec?.id) return null;
    const text = embText(rec);
    if (!text) return null;
    const vec = await embedText(text);
    if (!vec) return null;
    const map = await loadEmbMap(company);
    map[rec.id] = vec;
    await saveK(learnEmbKey(company), map);
    return { id: rec.id, vec };
  } catch { return null; }
};

// One-time backfill of vectors for records that don't have one yet (batched).
export const backfillEmbeddings = async (company, memory, embMap) => {
  try {
    const map = (embMap && typeof embMap === "object") ? { ...embMap } : await loadEmbMap(company);
    const todo = (memory || []).filter(r => r.id && !map[r.id] && embText(r));
    if (!todo.length) return null;
    for (let i = 0; i < todo.length; i += 100) {
      const batch = todo.slice(i, i + 100);
      const vecs = await embedBatch(batch.map(embText));
      batch.forEach((r, j) => { if (vecs[j]) map[r.id] = vecs[j]; });
    }
    await saveK(learnEmbKey(company), map);
    return map;
  } catch { return embMap || null; }
};

// ── Local match (instant, free) — used to short-circuit AI for repeat merchants ──
export const matchLearned = (memory, txn) => {
  const toks = txnTokens(txn);
  if (!toks.length || !Array.isArray(memory) || !memory.length) return null;
  const dir = direction(txn);
  const groups = {};        // classification groups (records with a real classifiedAs)
  let totalWeight = 0;
  const matched = [];       // ALL matched records (incl. payee/notes-only) for field voting
  for (const r of memory) {
    if (r.dir !== dir) continue;
    const score = jaccard(toks, r.toks || []);
    if (score < MATCH_FLOOR) continue;
    const w = score * score * (r.corrected ? CORRECTION_WEIGHT : 1);
    matched.push({ r, w });
    if (!r.classifiedAs) continue; // payee/notes-only precedent — votes on fields, not class
    totalWeight += w;
    const k = outcomeKey(r);
    if (!groups[k]) groups[k] = { weight: 0, count: 0, rec: r };
    groups[k].weight += w;
    groups[k].count += 1;
    if ((r.ts || 0) >= (groups[k].rec.ts || 0)) groups[k].rec = r;
  }
  if (!matched.length) return null;
  const vote = pick => {
    const tally = {};
    for (const { r, w } of matched) { const v = (pick(r) || "").trim(); if (v) tally[v] = (tally[v] || 0) + w; }
    return Object.entries(tally).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  };
  const learnedPayee = vote(x => x.payee);
  const learnedNotes = vote(x => x.notes);
  const learnedType = vote(x => x.type) || dir;
  const ranked = Object.values(groups).sort((a, b) => b.weight - a.weight);
  const top = ranked[0];
  const r = top?.rec;
  return {
    classifiedAs: r?.classifiedAs || "",
    cat: r?.cat || "",
    party: r?.party || learnedPayee || txn.payee || "",
    payee: learnedPayee,
    notes: learnedNotes,
    type: learnedType,
    vendorId: r?.vendorId || "",
    cardAccountId: r?.cardAccountId || "",
    count: top?.count || 0,
    total: matched.length,
    confidence: totalWeight ? (top?.weight || 0) / totalWeight : 0,
    source: "learned",
  };
};

// ── Retrieval for the AI prompt: top-K most SIMILAR past decisions ────────────
// Semantic (cosine over embeddings) when a query vector is available, else token
// overlap. Returns records that carry a real classification (useful as examples).
export const retrieveSimilar = (memory, embMap, txn, queryEmb, { k = RETRIEVAL_K } = {}) => {
  if (!Array.isArray(memory) || !memory.length) return [];
  const dir = direction(txn);
  const toks = txnTokens(txn);
  const useEmb = !!(queryEmb && embMap && Object.keys(embMap).length);
  const scored = [];
  for (const r of memory) {
    if (r.dir !== dir || !r.classifiedAs) continue;
    const score = (useEmb && r.id && embMap[r.id]) ? cosine(queryEmb, embMap[r.id]) : jaccard(toks, r.toks || []);
    if (score < RETRIEVAL_FLOOR) continue;
    const ageDays = (Date.now() - (r.ts || 0)) / 86400000;
    const recency = 1 + (ageDays < 30 ? 0.3 : 0);
    scored.push({ r, w: score * (r.corrected ? CORRECTION_WEIGHT : 1) * recency });
  }
  scored.sort((a, b) => b.w - a.w);
  const seen = new Set();
  const out = [];
  for (const { r } of scored) {
    const key = `${(r.payee || "").toLowerCase()}|${r.classifiedAs}|${r.cat}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length >= k) break;
  }
  return out;
};

// Cold-start fallback: global most-frequent (payee → label) pairs.
const summarizeMemory = (memory, dir, max = 30) => {
  const byKey = {};
  for (const r of memory || []) {
    if ((dir && r.dir !== dir) || !r.classifiedAs) continue;
    const payee = (r.payee || (r.toks || []).join(" ")).trim();
    if (!payee) continue;
    const k = `${payee.toLowerCase()}|${recLabel(r)}`;
    if (!byKey[k]) byKey[k] = { payee, label: recLabel(r), n: 0 };
    byKey[k].n += 1;
  }
  return Object.values(byKey).sort((a, b) => b.n - a.n).slice(0, max)
    .map(e => `- "${e.payee}" → ${e.label}`).join("\n");
};

// ── AI suggestion, primed with the most similar past decisions (RAG) ──────────
export const aiSuggest = async ({ company, txn, memory = [], embMap = {}, expenseCats = [], queryEmb }) => {
  try {
    const dir = direction(txn);
    let qEmb = queryEmb;
    if (qEmb === undefined) { try { qEmb = await embedText(embText(txn)); } catch { qEmb = null; } }
    const neighbors = retrieveSimilar(memory, embMap, txn, qEmb, { k: RETRIEVAL_K });
    const examples = neighbors.length >= 2
      ? neighbors.map((r, i) =>
          `${i + 1}. Raw: "${(r.rawPayee || r.payee || "").slice(0, 60)}" | Payee: "${r.payee || ""}" | Notes: "${(r.notes || "").slice(0, 50)}" → ${recLabel(r)}`).join("\n")
      : (summarizeMemory(memory, dir) || "(no history yet)");
    const isDebit = dir === "debit";
    const types = isDebit
      ? "expense, vendor_bill (paying a purchase bill), vendor_po (advance on a PO), cc_payment (paying a credit-card company), conversion (transfer between own accounts)"
      : "customer_receipt (money received from a buyer/invoice), cc_payment, conversion, expense (refund/misc)";
    const sym = txn.currency || "INR";
    const prompt =
`You classify bank transactions for a gemstone & jewelry export business in India.
Pick the best TYPE: ${types}.
If the type is "expense", also pick a CATEGORY. Prefer one of these when it fits: ${expenseCats.join(", ")}. Otherwise use a short custom category in Title Case (e.g. Food, Marketing, Software).

The user's OWN past decisions on the most similar transactions (learn their style):
${examples}

Now classify THIS transaction:
- Direction: ${isDebit ? "money out (debit)" : "money in (credit)"}
- Raw narration: ${txn.rawPayee || txn.payee || "(unknown)"}
- Payee / source: ${txn.payee || "(unknown)"}
- Details / notes: ${txn.notes || "(none)"}
- Amount: ${sym} ${(+txn.amount || 0).toLocaleString("en-IN")}

Reply with ONLY a JSON object, no prose:
{"classifiedAs":"expense|vendor_bill|vendor_po|cc_payment|customer_receipt|conversion","cat":"<category if expense, else empty>","payee":"<clean merchant/party name, e.g. 'Jio'>","notes":"<short description of what this payment is for>","party":"<same as payee>","confidence":<0 to 1>,"why":"<short reason>"}`;

    const text = await classify(prompt, 400);
    const m = String(text).match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    if (!parsed?.classifiedAs) return null;
    const conf = Math.max(0, Math.min(1, +parsed.confidence || 0));
    return {
      classifiedAs: normClass(parsed.classifiedAs),
      cat: parsed.cat || "",
      payee: parsed.payee || parsed.party || "",
      notes: parsed.notes || "",
      party: parsed.party || parsed.payee || txn.payee || "",
      vendorId: "",
      cardAccountId: "",
      why: parsed.why || "",
      confidence: conf,
      source: "ai",
    };
  } catch { return null; }
};
