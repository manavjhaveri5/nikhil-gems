/* Card EMI instalments — the monthly lines a card prints for a purchase converted
   to EMI ("EMI PRINCIPAL - 2/12, REF# 70975913", "EMI INTEREST - 2/12, …", and a
   GST line on the interest the same day). They are booked without asking: each
   kind copies how the last one of its kind on that card was classified, so a
   change made once by hand carries forward. With no history, Bank Charges.

   Pure: returns the ledger patches and the expense records to write. */

const EMI_RE = /EMI\s+(PRINCIPAL|INTEREST)\b\s*-?\s*(\d+)\s*\/\s*(\d+)\D*?(?:REF#?\s*(\d+))?/i;

const textOf = t => `${t.bankRemarks || ""} ${t.rawPayee || ""} ${t.payee || ""}`;
const cardOf = t => (t.type === "credit" ? t.accountTo : t.accountFrom);

export function emiInfo(t, sameDay = []) {
  const m = textOf(t).match(EMI_RE);
  if (m) return { kind: m[1].toLowerCase(), n: +m[2], of: +m[3], ref: m[4] || "" };
  // GST printed on its own line is the GST on that day's EMI interest.
  if (/^\s*GST\s*$/i.test(t.bankRemarks || t.payee || "")) {
    const interest = sameDay.find(o => o !== t && cardOf(o) === cardOf(t) && o.date === t.date && emiInfo(o).kind === "interest");
    if (interest) return { ...emiInfo(interest), kind: "gst" };
  }
  return { kind: null };
}

const PARTY = { principal: "EMI Principal", interest: "EMI Interest", gst: "GST on EMI interest" };

export function classifyCardEmis(txns = [], { only = null, expenseKey = "", now = new Date().toISOString() } = {}) {
  const uid = () => Math.random().toString(36).slice(2, 11);
  const pool = only ? txns.filter(t => only.has(t.id)) : txns;
  const byDay = {};
  txns.forEach(t => { if (t?.date) (byDay[`${cardOf(t)}|${t.date}`] ||= []).push(t); });
  // The last hand-made decision per card and kind.
  const last = {};
  txns.filter(t => t?.classifiedAs === "expense" && t.type === "debit")
    .sort((a, b) => String(a.classifiedAt || "").localeCompare(String(b.classifiedAt || "")))
    .forEach(t => { const k = emiInfo(t, byDay[`${cardOf(t)}|${t.date}`]).kind; if (k) last[`${cardOf(t)}|${k}`] = t.classifiedRef?.cat || t.category; });
  const patches = {}, expenses = [];
  for (const t of pool) {
    if (!t || t.type !== "debit" || t.classifiedAs) continue;
    const info = emiInfo(t, byDay[`${cardOf(t)}|${t.date}`]);
    if (!info.kind) continue;
    const cat = last[`${cardOf(t)}|${info.kind}`] || last[`${cardOf(t)}|interest`] || "Bank Charges";
    const party = PARTY[info.kind];
    const notes = `Card EMI ${info.n}/${info.of}${info.ref ? ` · ref ${info.ref}` : ""} · ${info.kind === "principal" ? "principal" : info.kind === "interest" ? "interest" : "GST on interest"}`;
    patches[t.id] = {
      category: cat, classifiedAs: "expense", classifiedAt: now, classifiedBy: "emi-rule",
      classifiedRef: { cat, party }, payee: party, notes,
    };
    if (expenseKey) expenses.push({ id: "exp-" + uid(), cat, date: t.date, notes, party, amount: +t.amount || 0, currency: t.currency || "INR", createdAt: now, ledgerTxnId: t.id, payFromAccount: t.accountFrom });
  }
  return { patches, expenses };
}
