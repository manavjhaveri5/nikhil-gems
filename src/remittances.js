/* Inward remittances — what a foreign payment received at Bank of India must
   carry to be "entered correctly", and how it ties to the bank ledger and to the
   invoices / shipping bills it settles. Shared by Export Recon (where they are
   entered) and the Ledger's Month close (where they are checked).

   Nikhil Gems keeps them in a register (er-ng-remittances-v1); each record:
     { id, irt, date, currency, amount (foreign), settlement: "converted"|"eefc",
       rate, inrCredited, charges, chargeCurrency, remitter, buyer, purpose,
       advance, advanceNote, expectedShipDate, closed, attachment, createdAt }
   and the invoices it settles carry the link: invoice._remittances =
   [{ id, alloc, irt, currency }] (older records: one _remittanceId/_remittanceAlloc).

   Atyahara keeps FIRCs in Export Recon (er-meta-v5:atyahara), settled by the
   shipping bills pointing at them (sb.fircId); a FIRC carries `advance` too. */

import { monthOf, round2 } from "./monthClose.js";

export const NG_REMIT_KEY = "er-ng-remittances-v1";
export const AT_META_KEY = "er-meta-v5:atyahara";

/* ── Invoice ↔ remittance links ──────────────────────────────────────────── */
export function invRemitLinks(inv) {
  const list = Array.isArray(inv?._remittances) ? inv._remittances.filter(l => l?.id) : [];
  if (inv?._remittanceId && !list.some(l => l.id === inv._remittanceId)) {
    return [{ id: inv._remittanceId, alloc: +inv._remittanceAlloc || 0, irt: inv._remittanceIrt || "", currency: inv._remittanceCurrency || "" }, ...list];
  }
  return list;
}
// Folds the old single-link fields into the list, so a record only ever has one shape after a write.
const dropLegacy = inv => {
  const { _remittanceId, _remittanceAlloc, _remittanceIrt, _remittanceCurrency, ...rest } = inv;
  return rest;
};
export function withRemitLink(inv, rem, alloc) {
  const links = invRemitLinks(inv).filter(l => l.id !== rem.id);
  return { ...dropLegacy(inv), _remittances: [...links, { id: rem.id, alloc: round2(alloc), irt: rem.irt || "", currency: rem.currency || "" }] };
}
export function withoutRemitLink(inv, remId) {
  const links = invRemitLinks(inv).filter(l => l.id !== remId);
  const out = dropLegacy(inv);
  if (links.length) out._remittances = links; else delete out._remittances;
  return out;
}
export const remitAllocations = (rem, invoices = []) =>
  invoices.flatMap(inv => invRemitLinks(inv).filter(l => l.id === rem.id).map(l => ({ inv, alloc: +l.alloc || 0 })));

/* ── Completeness ────────────────────────────────────────────────────────── */
const blank = v => v == null || v === "" || (typeof v === "number" && !Number.isFinite(v));
const num = v => (blank(v) ? null : +String(v).replace(/,/g, ""));
export const isEefc = rem => rem?.settlement === "eefc";

// What an NG register entry still lacks, in words the accountant reads.
export function ngRemitMissing(rem) {
  const m = [];
  if (!rem.irt) m.push("IRT / reference");
  if (!rem.date) m.push("date");
  if (!rem.currency) m.push("currency");
  if (!(num(rem.amount) > 0)) m.push("foreign amount");
  if (!isEefc(rem)) {
    if (!(num(rem.rate) > 0)) m.push("rate");
    if (!(num(rem.inrCredited) > 0)) m.push("INR credited");
  }
  if (blank(rem.charges)) m.push("charges");
  if (!rem.buyer && !rem.remitter) m.push("buyer");
  return m;
}

// How the remittance is settled: allocated to invoices, held as an advance, or open.
export function ngRemitSettlement(rem, invoices = []) {
  const allocs = remitAllocations(rem, invoices);
  const allocated = round2(allocs.reduce((s, a) => s + a.alloc, 0));
  const amount = num(rem.amount) || 0;
  const unallocated = round2(Math.max(0, amount - allocated));
  const sbNos = [...new Set(allocs.map(a => a.inv.sbNo).filter(Boolean).map(String))];
  const noSb = rem.advance ? [] : allocs.filter(a => !a.inv.sbNo).map(a => a.inv);
  return {
    allocs, allocated, unallocated, sbNos, noSb,
    over: allocated > amount + 0.01,
    settled: amount > 0 && (unallocated <= 0.01 || !!rem.advance),
  };
}

export function atFircMissing(f) {
  const m = [];
  if (!f.number) m.push("FIRC / reference");
  if (!f.date) m.push("date");
  if (!f.currency) m.push("currency");
  if (!(num(f.foreignAmount) > 0)) m.push("foreign amount");
  if (!(num(f.exchangeRate) > 0)) m.push("rate");
  if (!(num(f.amount) > 0)) m.push("INR credited");
  if (blank(f.charges)) m.push("charges");
  if (!f.buyerName && !f.remitterName) m.push("buyer");
  return m;
}
export function atFircSettlement(f, sbs = []) {
  const linked = sbs.filter(sb => sb.fircId === f.id);
  const used = round2(linked.reduce((s, sb) => s + (+sb.amount || 0), 0));
  const amount = num(f.amount) || 0;
  const unallocated = round2(Math.max(0, amount - used));
  // A FIRC is realised in INR; a rupee or so of rounding across SBs is not a gap.
  return { linked, used, unallocated, over: used > amount + 1, settled: amount > 0 && (unallocated <= 1 || !!f.advance) };
}

/* ── The bank ledger side ────────────────────────────────────────────────── */
export const isBoiAccount = acc =>
  !!acc && (/bank of india|\bboi\b|eefc/i.test(acc.name || "") || /boi|eefc/i.test(acc.id || ""));
const txnText = t => `${t.payee || ""} ${t.notes || ""} ${t.rawPayee || ""} ${t.rawNotes || ""} ${t.category || ""}`;
const squash = s => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// A credit on a BOI account that is a foreign inward remittance. Every credit to
// an EEFC account is one; on the INR account it says so in the narration.
export function isInwardCredit(t, acc) {
  if (!t || t.type !== "credit" || !isBoiAccount(acc)) return false;
  if (/eefc/i.test(acc.name || "") || /eefc/i.test(acc.id || "")) return true;
  return /inward\s*rem|\bfirc\b|\birt\b|\d{3,}IRT\d+|swift|foreign\s*remit/i.test(txnText(t)) ||
    /inward remittance|firc/i.test(t.classifiedRef?.cat || "");
}

// The ledger credit a remittance arrived as: by its reference first, then by
// amount (INR credited, or the foreign amount into EEFC) within a week.
export function matchLedgerCredit(credits, { irt, date, inr, foreign, currency }) {
  const ref = squash(irt);
  if (ref.length >= 6) {
    const hit = credits.find(t => squash(txnText(t)).includes(ref));
    if (hit) return hit;
  }
  if (!date) return null;
  const day = d => new Date(`${d}T12:00:00`).getTime() / 86400000;
  const near = t => t.date && Math.abs(day(t.date) - day(date)) <= 7;
  return credits.find(t => near(t) && (
    (inr > 0 && (t.currency || "INR") === "INR" && Math.abs((+t.amount || 0) - inr) < 1) ||
    (foreign > 0 && t.currency === currency && Math.abs((+t.amount || 0) - foreign) < 0.01)
  )) || null;
}

export const ngKeys = rem => ({ irt: rem.irt, date: rem.date, inr: num(rem.inrCredited), foreign: num(rem.amount), currency: rem.currency });
const atKeys = f => ({ irt: f.number || f.transactionRef, date: f.date, inr: num(f.amount), foreign: num(f.foreignAmount), currency: f.currency });

/* Everything Month close (b) needs for one company and month. Returns the
   remittances of the month with what each lacks, and the BOI credits in the
   bank ledger that have no remittance entered against them. */
export function remittanceChecks({ company, month, remittances = [], invoices = [], fircs = [], sbs = [], txns = [], accounts = [] }) {
  const accById = new Map(accounts.map(a => [a.id, a]));
  const credits = txns.filter(t => isInwardCredit(t, accById.get(t.accountTo)));
  const used = new Set();
  const rows = (company === "at" ? fircs : remittances).map(r => {
    const keys = company === "at" ? atKeys(r) : ngKeys(r);
    const hit = matchLedgerCredit(credits.filter(t => !used.has(t.id)), keys);
    if (hit) used.add(hit.id);
    const missing = company === "at" ? atFircMissing(r) : ngRemitMissing(r);
    const settle = company === "at" ? atFircSettlement(r, sbs) : ngRemitSettlement(r, invoices);
    const problems = [
      ...(missing.length ? [`Missing ${missing.join(", ")}`] : []),
      ...(!settle.settled ? [`${company === "at" ? "₹" : `${r.currency || ""} `}${settle.unallocated.toLocaleString("en-IN", { maximumFractionDigits: 2 })} not tied to ${company === "at" ? "a shipping bill" : "an invoice"} or marked advance`] : []),
      ...(settle.over ? ["Allocated more than was received"] : []),
      ...((settle.noSb || []).length ? [`No shipping bill on ${settle.noSb.map(i => i.invNo).join(", ")}`] : []),
    ];
    return { rec: r, month: monthOf(r.date), ledgerTxn: hit, missing, settle, problems, ok: problems.length === 0 };
  });
  const inMonth = rows.filter(x => x.month === month);
  const undated = rows.filter(x => !x.rec.date);
  const unentered = credits.filter(t => monthOf(t.date) === month && !used.has(t.id));
  return {
    rows: inMonth, undated, unentered,
    open: inMonth.filter(x => !x.ok).length + unentered.length,
    done: inMonth.every(x => x.ok) && unentered.length === 0,
  };
}

/* A register entry from a parsed Bank of India advice (remittanceAdvice.js). */
export function remitFromAdvice(adv) {
  const eefc = adv.settlement === "eefc";
  return {
    irt: adv.remittanceNo || "",
    date: adv.date || "",
    valueDate: adv.valueDate || "",
    currency: adv.foreignCurrency || adv.creditCurrency || "",
    amount: adv.foreignAmount ?? (eefc ? adv.creditAmount : null),
    settlement: eefc ? "eefc" : "converted",
    rate: eefc ? null : adv.rate,
    inrCredited: eefc ? null : adv.creditAmount,
    grossInr: eefc ? null : adv.grossAmount,
    charges: adv.charges ?? 0,
    chargeCurrency: adv.chargeCurrency || "INR",
    remitter: adv.remitter || "",
    buyer: adv.remitter || "",
    remitterBank: adv.remitterBank || "",
    purpose: adv.purpose || "",
    bankTxnId: adv.transactionId || "",
    source: "boi-advice",
  };
}

/* A register entry started from a ledger credit nobody entered yet. */
export function remitFromLedgerCredit(t, acc) {
  const text = txnText(t);
  const irt = (/(\d{3,}IRT\d+)/i.exec(text) || /\bIRT\s*[:#]?\s*([A-Z0-9]{6,})/i.exec(text) || [])[1] || "";
  const eefc = /eefc/i.test(acc?.name || "") || /eefc/i.test(acc?.id || "");
  const fx = /\b(USD|EUR|GBP|JPY|AUD|CHF|CAD|SGD|HKD|AED)\s*([\d,]+(?:\.\d+)?)/.exec(text);
  const rate = /ROE\s*([\d.]+)/i.exec(text);
  const remitter = (/Remitter:\s*([^·(]+)/i.exec(text) || [])[1]?.trim() || "";
  return {
    irt, date: t.date || "",
    currency: eefc ? (t.currency || acc?.currency || "USD") : (fx?.[1] || ""),
    amount: eefc ? +t.amount || null : (fx ? +fx[2].replace(/,/g, "") : null),
    settlement: eefc ? "eefc" : "converted",
    rate: eefc ? null : (rate ? +rate[1] : null),
    inrCredited: eefc ? null : +t.amount || null,
    charges: null, chargeCurrency: "INR",
    remitter, buyer: remitter || (/inward/i.test(t.payee || "") ? "" : t.payee || ""),
    source: "ledger", ledgerTxnId: t.id,
  };
}
