/* BOI set checker — reads the documents going into a BOI remittance set and
   says where they disagree, before the set goes to the bank:
     1. each invoice on the form is on a shipping bill, at the same value
     2. the HAWB printed on the shipping bill is the AWB on the shipping label
     3. the remitter on the inward advice is the buyer on the invoice
   Reading is one AI call per document; results are cached by the caller. */

const PROMPTS = {
  sb: 'This is an Indian customs export Shipping Bill / Courier Shipping Bill (CSB) / Postal Bill of Export. Return ONLY valid JSON, no markdown: {"sbNumber":"shipping bill number","invoices":[{"no":"invoice number exactly as printed","value":"the invoice value in its FOREIGN currency (the item / taxable value in USD, EUR etc., NOT the INR figure), digits only","currency":"that foreign currency code e.g. USD","valueInr":"invoice value in INR if printed, digits only","rate":"exchange rate if printed"}],"hawb":["every HAWB / AWB / house airway bill / courier tracking number printed on it, digits and letters only"],"consignee":"consignee / buyer name"}',
  awb: 'This is a shipping label, airway bill (AWB / HAWB) or bill of lading for an export shipment. Return ONLY valid JSON, no markdown: {"awb":"the airway bill / tracking / waybill number (the main barcode number), digits and letters only","other":["any other AWB / tracking / reference numbers printed"],"consignee":"receiver / consignee name"}',
  adv: 'This is an inward remittance advice (SWIFT MT103 / bank credit advice) for an export payment received in India. Return ONLY valid JSON, no markdown: {"remitter":"name of the ordering customer / remitter / sender of the money (MT103 field 50), not the bank and not the beneficiary","amount":"amount credited (field 32A) digits only","ordered":"original amount ordered (field 33B) digits only, empty if not shown","currency":"currency code","invoices":["every invoice / proforma / order number the payment names — in the remittance information (field 70, RmtInf, Ustrd) or anywhere else in the payment details — exactly as written e.g. NG-57/26-27; empty list if none"]}',
  inv: 'This is an export invoice / proforma / purchase order. Return ONLY valid JSON, no markdown: {"invoiceNumber":"invoice number","amount":"total value digits only","currency":"currency code","buyer":"buyer / bill-to name","consignee":"consignee / ship-to name if different, else empty"}',
};

const b64Of = bytes => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** part: {kind:'pdf'|'jpg'|'png', bytes:Uint8Array}; docKind: 'sb'|'awb'|'adv'|'inv' */
export async function readBoiDoc(part, docKind) {
  const prompt = PROMPTS[docKind];
  if (!prompt) return null;
  const data = b64Of(part.bytes);
  const file = part.kind === "pdf"
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
    : { type: "image", source: { type: "base64", media_type: part.kind === "png" ? "image/png" : "image/jpeg", data } };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch("/api/claude", {
      method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "application/json", "x-ai-feature": "boi-checker" },
      body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 500,
        messages: [{ role: "user", content: [file, { type: "text", text: prompt }] }] }),
    });
    if (!res.ok) throw new Error(`AI ${res.status}`);
    const d = await res.json();
    if (d.error) throw new Error(d.error.message || "AI error");
    const t = (d.content || []).map(i => i.text || "").join("").replace(/```json|```/g, "").trim();
    return JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
  } finally { clearTimeout(timer); }
}

// ── matching helpers ──
const normNo = s => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const num = v => parseFloat(String(v ?? "").replace(/[^\d.]/g, "")) || 0;
// Invoice numbers: "NG/045/25-26" vs "NG-45/2025-26" — compare alphanumerics, and
// fall back to the digit runs when the prefixes are printed differently.
const sameInvNo = (a, b) => {
  const x = normNo(a), y = normNo(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const dx = (String(a).match(/\d+/g) || []).map(n => String(+n)).join("|");
  const dy = (String(b).match(/\d+/g) || []).map(n => String(+n)).join("|");
  return !!dx && dx === dy;
};
// AWB numbers: carriers print them with spaces or a prefix; one containing the
// other (8+ characters) is the same waybill.
const sameAwb = (a, b) => {
  const x = normNo(a), y = normNo(b);
  if (x.length < 6 || y.length < 6) return false;
  return x === y || (Math.min(x.length, y.length) >= 8 && (x.includes(y) || y.includes(x)));
};
const STOP = new Set(["LLC", "INC", "LTD", "LIMITED", "CO", "COMPANY", "CORP", "CORPORATION", "GMBH", "PVT", "PTY", "SA", "SRL", "BV", "AG", "PLC", "THE", "AND", "OF", "MR", "MRS", "MS", "DR", "LLP", "KK", "KG"]);
const nameTokens = s => String(s || "").toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter(w => w.length > 1 && !STOP.has(w));
export const sameName = (a, b) => {
  const x = nameTokens(a), y = nameTokens(b);
  if (!x.length || !y.length) return false;
  const ys = new Set(y);
  const common = x.filter(w => ys.has(w)).length;
  return common / Math.min(x.length, y.length) >= 0.5;
};

/**
 * @param {Object} p
 * @param {string} p.purpose      'a' shipped | 'b' advance | …
 * @param {Array}  p.invoices     linked invoice records [{invNo,totalAmt,currency,buyer,consignee}]
 * @param {Array}  p.sb           readings of shipping bills [{label, ...read}]
 * @param {Array}  p.awb          readings of AWBs / labels
 * @param {Array}  p.adv          readings of inward advices
 * @param {Array}  p.invFiles     readings of invoice files with no record
 * @param {string} p.remName      remitter name typed on the form
 * @returns {Array<{ok:boolean,title:string,detail:string}>}
 */
export function compareBoiSet({ purpose, invoices = [], sb = [], awb = [], adv = [], invFiles = [], remName = "" }) {
  const out = [];
  const flag = (title, detail) => out.push({ ok: false, title, detail });
  const pass = (title, detail) => out.push({ ok: true, title, detail });

  // Invoices: the records, plus any invoice file that isn't one of them.
  const invs = [...invoices];
  for (const f of invFiles) {
    if (!f?.invoiceNumber || invs.some(i => sameInvNo(i.invNo, f.invoiceNumber))) continue;
    invs.push({ invNo: f.invoiceNumber, totalAmt: num(f.amount), currency: String(f.currency || "").toUpperCase(), buyer: f.buyer, consignee: f.consignee });
  }

  // 1. Invoice ↔ shipping bill
  if (purpose === "a" && sb.length) {
    const sbInvs = sb.flatMap(s => (s.invoices || []).map(x => ({ ...x, sbNumber: s.sbNumber || s.label })));
    for (const inv of invs) {
      const hit = sbInvs.find(x => sameInvNo(x.no, inv.invNo));
      if (!hit) {
        flag(`${inv.invNo} isn't on the shipping bill`,
          sbInvs.length ? `The shipping bill names ${sbInvs.map(x => x.no).join(", ")}.` : "No invoice number could be read off the shipping bill.");
        continue;
      }
      const t = +inv.totalAmt || 0, ic = String(inv.currency || "").toUpperCase();
      let v = num(hit.value), hc = String(hit.currency || "").toUpperCase();
      const rate = num(hit.rate);
      // A foreign-currency invoice filed on the shipping bill in INR at rate 1 (or
      // near it): the courier typed the dollar figure into the rupee field, so
      // customs holds the goods at a few hundred rupees. Banks reject that.
      const inrAtPar = hc === "INR" && ic && ic !== "INR" && rate > 0 && rate < 5;
      if (inrAtPar) flag(`${inv.invNo}: shipping bill filed in INR at rate ${hit.rate}`,
        `The invoice is ${ic} ${t.toLocaleString("en-IN")}, but the shipping bill declares ₹${num(hit.valueInr || hit.value).toLocaleString("en-IN")} in INR at an exchange rate of ${hit.rate}, so customs values the goods at about ${ic} ${(num(hit.valueInr || hit.value) / 85).toFixed(0)}. The courier must amend the shipping bill to ${ic}.`);
      // Otherwise a shipping bill's INR value is turned back at its rate, never called a currency mismatch.
      if (hc === "INR" && ic && ic !== "INR") { const inr = num(hit.valueInr) || num(hit.value); v = rate ? inr / rate : 0; hc = ic; }
      const sameCcy = !hc || !ic || hc === ic;
      if (!sameCcy) flag(`${inv.invNo}: currency differs`, `Invoice is ${ic}, shipping bill ${hc}.`);
      else if (!v || !t) flag(`${inv.invNo}: value not checked`, !t ? "The invoice has no total in Invoicing." : `No ${ic || "foreign-currency"} value could be read off ${hit.sbNumber || "the shipping bill"} — compare it by eye.`);
      else if (Math.abs(v - t) > Math.max(1, t * 0.01)) flag(`${inv.invNo}: value differs`, `Invoice ${ic} ${t.toLocaleString("en-IN")} · shipping bill ${v.toLocaleString("en-IN")} (${(v - t > 0 ? "+" : "") + (v - t).toLocaleString("en-IN", { maximumFractionDigits: 2 })}). The bank needs these to be the same.`);
      else if (!inrAtPar) pass(`${inv.invNo} matches the shipping bill`, `${hit.sbNumber || "SB"} · ${v.toLocaleString("en-IN")}`);
    }
    for (const x of sbInvs) {
      if (!invs.some(i => sameInvNo(i.invNo, x.no))) flag(`Shipping bill names ${x.no}`, "That invoice isn't on this form — wrong shipping bill, or an invoice is missing from the form.");
    }
  }

  // 2. HAWB on the shipping bill ↔ AWB on the label
  if (purpose === "a" && sb.length && awb.length) {
    const hawbs = sb.flatMap(s => (s.hawb || []).filter(Boolean));
    for (const a of awb) {
      const nos = [a.awb, ...(a.other || [])].filter(Boolean);
      if (!nos.length) { flag(`${a.label}: no AWB number read`, "Check the label is legible."); continue; }
      if (!hawbs.length) { flag("No HAWB on the shipping bill", `The label's AWB is ${a.awb || nos[0]}, but no HAWB could be read off the shipping bill.`); continue; }
      const m = nos.find(n => hawbs.some(h => sameAwb(h, n)));
      if (m) pass("HAWB matches the label", m);
      else flag("HAWB doesn't match the label", `Shipping bill HAWB ${hawbs.join(", ")} · label AWB ${a.awb || nos[0]}.`);
    }
  }

  // 3. Remitter on the inward advice ↔ buyer on the invoice
  const buyers = [...new Set(invs.flatMap(i => [i.buyer, i.consignee]).filter(Boolean))];
  for (const a of adv) {
    if (!a?.remitter) { flag("Remitter not read off the advice", "Check the advice names who sent the money."); continue; }
    if (!buyers.length) continue;
    if (buyers.some(b => sameName(b, a.remitter))) pass("Remitter is the invoice buyer", a.remitter);
    else flag("Remitter isn't the invoice buyer", `Advice: ${a.remitter} · invoice: ${buyers.join(" / ")}. A third-party payment needs the bank's third-party declaration.`);
    // Which invoices the payment names (field 70 / remittance information).
    const named = (a.invoices || []).filter(Boolean);
    if (named.length) {
      const extra = named.filter(n => !invs.some(i => sameInvNo(i.invNo, n)));
      const unnamed = invs.filter(i => !named.some(n => sameInvNo(i.invNo, n)));
      if (extra.length) flag(`Advice is for ${extra.join(", ")}`, `The payment names ${named.join(", ")}, which ${extra.length > 1 ? "aren't" : "isn't"} on this form. Link ${extra.length > 1 ? "those invoices" : "that invoice"} instead.`);
      if (unnamed.length) flag(`${unnamed.map(i => i.invNo).join(", ")} not named on the advice`, `The payment names only ${named.join(", ")}.`);
      if (!extra.length && !unnamed.length) pass("Advice names these invoices", named.join(", "));
    }
    // The amount: the ordered amount (before the banks' charges) against the invoices' total.
    const ccy = String(a.currency || "").toUpperCase();
    const amt = num(a.ordered) || num(a.amount), tot = invs.filter(i => !ccy || !i.currency || String(i.currency).toUpperCase() === ccy).reduce((s, i) => s + (+i.totalAmt || 0), 0);
    if (amt && tot) {
      const gap = amt - tot, fmt = n => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
      if (Math.abs(gap) > Math.max(50, tot * 0.02)) flag(`Advice is ${ccy} ${fmt(amt)}, invoices ${fmt(tot)}`, gap < 0 ? `${fmt(-gap)} short — a different invoice, or a part payment (then the form's amount should be ${fmt(amt)}).` : `${fmt(gap)} more than the invoices on the form.`);
      else pass("Advice amount matches the invoices", `${ccy} ${fmt(amt)}${Math.abs(gap) >= 0.01 ? ` (${fmt(Math.abs(gap))} ${gap < 0 ? "short — bank charges" : "over"})` : ""}`);
    }
  }
  if (remName.trim() && buyers.length && !buyers.some(b => sameName(b, remName)) && !adv.some(a => sameName(a?.remitter, remName))) {
    flag("Remitter on the form isn't the invoice buyer", `Form: ${remName} · invoice: ${buyers.join(" / ")}.`);
  }
  return out;
}
