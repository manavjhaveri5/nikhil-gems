/* Export Recon, one month at a time — every shipping bill of the month matched
   to its invoice and to the remittance(s) that realised it.

   Nikhil Gems: a shipping bill is the SB number on a commercial invoice; its
   realisation is the remittances linked to that invoice (remittances.js). The
   bank's SB Outstanding report (er-ng-bank-sbs-v1) adds SBs the ERP hasn't got,
   and says which ones the bank still holds open.
   Atyahara: shipping bills live in Export Recon (er-meta-v5:atyahara), each
   realised by the FIRC it points at, its invoice attached to it.

   Two kinds of open item, kept apart on purpose:
     fix         — something is wrong or missing in the records (an SB with no
                   invoice, an invoice with no SB, a paid invoice with no
                   remittance); a month is reconciled only when these are gone.
     outstanding — money not received yet. Normal until the realisation
                   deadline (9 months from the shipping bill under FEMA). */

import { monthOf, round2 } from "./monthClose.js";
import { invRemitLinks } from "./remittances.js";

export const RECON_CLOSE_KEY = "er-recon-close-v1";
export const NG_BANK_SB_KEY = "er-ng-bank-sbs-v1";
export const REALISATION_MONTHS = 9;
export const reconCloseId = (company, month) => `${company}:${month}`;

const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// Bank reports print dates every which way: 25-03-2025, 25/03/2025, 25-Mar-2025, 2025-03-25.
export function looseDate(s) {
  const t = String(s || "").trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(t);
  if (m) { const y = m[3].length === 2 ? `20${m[3]}` : m[3]; return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`; }
  m = /^(\d{1,2})[-\s/]([A-Za-z]{3})[A-Za-z]*[-\s/](\d{2,4})$/.exec(t);
  if (m && MON[m[2].toLowerCase()]) { const y = m[3].length === 2 ? `20${m[3]}` : m[3]; return `${y}-${String(MON[m[2].toLowerCase()]).padStart(2, "0")}-${m[1].padStart(2, "0")}`; }
  return "";
}
export function realisationDue(date) {
  if (!date) return "";
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + REALISATION_MONTHS);
  return d.toISOString().slice(0, 10);
}
const sbKey = v => String(v ?? "").replace(/\D/g, "").replace(/^0+/, "");
const today = () => new Date().toISOString().slice(0, 10);
// `month` may be "all": every shipping bill, whatever its month.
const inMonth = (date, month) => month === "all" || monthOf(date) === month;

/* Where the bank paperwork stands. NG: the Invoice Sets status (packet →
   submitted → done) and a BRC among the invoice's documents. Atyahara: the SB's
   own status cycle, "cleared" meaning the bank has closed it, plus its BRC file. */
export const DOCS_LABEL = { pending: "Not sent", packet: "Packet ready", submitted: "Submitted", done: "Done", prepared: "Prepared", cleared: "Cleared", rejected: "Rejected" };
const ngDocs = inv =>
  (inv.reconDone || inv.bankStatus === "cleared" || inv.bankStatus === "done") ? "done"
  : inv.bankStatus === "submitted" ? "submitted" : inv.bankStatus === "packet_downloaded" ? "packet" : "pending";
const ngHasBrc = inv => (inv.attachments || []).some(a => /\bbrc\b|realisation|realization/i.test(`${a?.label || ""} ${a?.fileName || a?.name || ""}`));

function finish(rows, extra = {}) {
  const fix = rows.filter(r => r.problems.length);
  const outstanding = rows.filter(r => r.status !== "realised" && r.value > 0);
  return {
    rows, fix, outstanding,
    realisedCount: rows.filter(r => r.status === "realised").length,
    overdue: outstanding.filter(r => r.overdue),
    reconciled: fix.length === 0,
    ...extra,
  };
}

export function ngReconMonth({ month, invoices = [], remittances = [], bankSbs = null }) {
  const bankList = Array.isArray(bankSbs?.list) ? bankSbs.list : [];
  const bankByKey = new Map(bankList.map(b => [sbKey(b.sbNo), b]));
  const remById = new Map(remittances.map(r => [r.id, r]));
  const exportInvoices = invoices.filter(i => (i.type || "commercial") === "commercial" && String(i.status || "").toLowerCase() !== "cancelled" && String(i.currency || "").toUpperCase() !== "INR");
  const rows = [];
  exportInvoices.forEach(inv => {
    const bank = inv.sbNo ? bankByKey.get(sbKey(inv.sbNo)) : null;
    const sbDate = looseDate(bank?.date) || inv.sbDate || "";
    if (!inMonth(sbDate || inv.date, month)) return;
    const links = invRemitLinks(inv);
    const value = +inv.totalAmt || 0;
    const realised = round2(links.reduce((s, l) => s + (+l.alloc || 0), 0));
    const status = value > 0 && realised >= value - 0.01 ? "realised" : realised > 0 ? "part" : "unrealised";
    const due = realisationDue(sbDate || inv.date);
    const problems = [];
    if (!inv.sbNo) problems.push("No shipping bill number on the invoice");
    if (!links.length && (inv.status === "paid" || +inv.paidAmount > 0)) problems.push("Marked paid, but no remittance linked");
    if (realised > value + 0.01) problems.push("More remittance linked than the invoice is worth");
    rows.push({
      key: inv.id, sbNo: inv.sbNo || "", sbDate, invId: inv.id, invNo: inv.invNo || "", buyer: inv.buyerName || inv.buyer || "",
      currency: String(inv.currency || "").toUpperCase(), value, realised, status,
      remittances: links.map(l => remById.get(l.id)?.irt || l.irt).filter(Boolean),
      credits: links.map(l => {
        const r = remById.get(l.id) || {};
        const share = +r.amount > 0 ? (+l.alloc || 0) / +r.amount : 0;
        return { id: l.id, irt: r.irt || l.irt, date: r.date || "", alloc: +l.alloc || 0, currency: r.currency || l.currency,
          inr: +r.inrCredited > 0 ? round2(+r.inrCredited * share) : null, charges: r.charges == null || r.charges === "" ? null : round2(+r.charges * share), eefc: r.settlement === "eefc" };
      }),
      docs: ngDocs(inv), submittedAt: String(inv.bankSubmittedAt || "").slice(0, 10), brc: ngHasBrc(inv),
      dueDate: due, overdue: status !== "realised" && !!due && due < today(),
      bankOpen: !!bank && bankList.length > 0,
      problems,
    });
  });
  // SBs the bank holds that no invoice in the ERP carries.
  const invKeys = new Set(exportInvoices.map(i => sbKey(i.sbNo)).filter(Boolean));
  bankList.forEach(b => {
    const k = sbKey(b.sbNo), d = looseDate(b.date);
    if (!k || invKeys.has(k) || !inMonth(d, month)) return;
    rows.push({
      key: `bank-${k}`, sbNo: b.sbNo, sbDate: d, invNo: "", buyer: "", currency: "", value: 0, realised: 0, status: "unrealised",
      remittances: [], credits: [], docs: "pending", brc: false, dueDate: looseDate(b.due) || realisationDue(d), overdue: false, bankOpen: true,
      problems: ["At the bank, but no invoice in the ERP has this SB number"],
    });
  });
  rows.sort((a, b) => String(a.sbDate || "").localeCompare(String(b.sbDate || "")) || String(a.invNo).localeCompare(String(b.invNo)));
  return finish(rows, { bankImportedAt: bankSbs?.importedAt || null });
}

export function atReconMonth({ month, meta }) {
  const fircs = meta?.fircs || [], sbs = meta?.shippingBills || [], invs = meta?.invoices || [];
  const fircById = new Map(fircs.map(f => [f.id, f]));
  const rows = sbs.filter(sb => inMonth(sb.date, month)).map(sb => {
    const firc = sb.fircId ? fircById.get(sb.fircId) : null;
    const inv = invs.find(i => i.linkedSbId === sb.id);
    const value = +sb.amount || 0;
    const status = firc ? "realised" : "unrealised";
    const due = realisationDue(sb.date);
    const problems = [];
    if (!inv && !sb.hasInvPdf) problems.push("No invoice attached to the shipping bill");
    if (sb.fircId && !firc) problems.push("Points at a FIRC that no longer exists");
    return {
      key: sb.id, sbNo: sb.sbNumber || "", sbDate: sb.date || "", invNo: inv?.invoiceNumber || inv?.number || (sb.hasInvPdf ? "Invoice on file" : ""),
      buyer: firc?.buyerName || inv?.buyerName || "", currency: "INR", value, realised: firc ? value : 0, status,
      remittances: firc ? [firc.number || "FIRC"] : [],
      credits: firc ? [{ id: firc.id, irt: firc.number || "FIRC", date: firc.date || "", alloc: value, currency: "INR", inr: value,
        charges: firc.charges == null || firc.charges === "" || !(+firc.amount > 0) ? null : round2(+firc.charges * value / +firc.amount) }] : [],
      // The bank marking the SB cleared is its realisation closed — the BRC, whether or not the file is attached yet.
      docs: sb.status || "pending", brc: !!sb.hasBrcPdf || sb.status === "cleared",
      dueDate: due, overdue: status !== "realised" && !!due && due < today(),
      bankStatus: sb.status || "pending", problems,
    };
  }).sort((a, b) => String(a.sbDate).localeCompare(String(b.sbDate)));
  return finish(rows);
}
