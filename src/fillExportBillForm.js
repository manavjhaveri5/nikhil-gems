/**
 * fillExportBillForm.js
 * Pre-fills page 1 of the Bank of India "Application Form for Export Bill
 * Collection/Purchase — Annexure II" and returns the 3-page form (pages 1-3;
 * the bank's internal "For Branch Use" checklists on pages 4-5 are dropped).
 * Framework-agnostic, works in the browser with pdf-lib.
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

// ─────────────────────────────────────────────
//  COORDINATES  (page 1 = 595.56 × 842.52 pt; y from bottom)
//  Anchored to measured label positions on the template.
// ─────────────────────────────────────────────
const C1 = {
  invNo:     { x: 150, y: 548 },                      // right of "1. Bill Details :"
  currency:  { x: 150, y: 533 },                      // right of "Bill Currency"
  amtFigure: { x: 150, y: 517 },                      // right of "Bill amount (In figure)"
  amtWords:  { x: 355, y: 518, size: 8, maxW: 219 },  // value cell right of "(In words)" (x350–578)
  portLoad:  { x: 150, y: 469 },                      // right of "Port of loading"
  portDest:  { x: 410, y: 469 },                      // right of "Port of Destination"
  origin:    { x: 150, y: 407 },                      // right of "Country of Origin of goods"
  expName:   { x: 150, y: 360 },                      // Exporter "Name and address" — line 1
  expAddr:   { x: 150, y: 351, size: 7, dy: 9 },      // address, wrapped lines downward
  expTel:    { x: 150, y: 301 },                      // "Contact number"
  expEmail:  { x: 150, y: 285, size: 7 },             // "E mail ID"
  // Buyer's (Drawee) Details — right column, value cell x373.6–578
  buyName:   { x: 380, y: 360 },                          // Buyer "Name and address" — line 1
  buyAddr:   { x: 380, y: 351, size: 7, dy: 9, maxW: 195, maxLines: 3 }, // buyer address (wrapped)
  buyCountry:{ x: 380, y: 318 },                          // "Country"
  buyEmail:  { x: 380, y: 301, size: 7 },                 // "E mail Id"
};

const BLACK = rgb(0, 0, 0);

// ── amount → words (generic, works for any currency) ──
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen',
  'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function threeDigitsToWords(n) {
  let s = '';
  if (n >= 100) { s += ONES[Math.floor(n / 100)] + ' Hundred'; n %= 100; if (n) s += ' '; }
  if (n >= 20) { s += TENS[Math.floor(n / 10)]; n %= 10; if (n) s += ' ' + ONES[n]; }
  else if (n > 0) { s += ONES[n]; }
  return s;
}

function intToWords(num) {
  if (num === 0) return 'Zero';
  const scales = ['', ' Thousand', ' Million', ' Billion', ' Trillion'];
  const parts = [];
  let i = 0;
  while (num > 0) {
    const chunk = num % 1000;
    if (chunk) parts.unshift(threeDigitsToWords(chunk) + scales[i]);
    num = Math.floor(num / 1000);
    i++;
  }
  return parts.join(' ').trim();
}

function amountInWords(currency, amount) {
  const n = Number(amount) || 0;
  const whole = Math.floor(n);
  const cents = Math.round((n - whole) * 100);
  const cur = (currency || '').toUpperCase();
  let s = `${cur} ${intToWords(whole)}`.trim();
  s += cents ? ` and ${cents}/100` : '';
  return s + ' Only';
}

// Greedy word-wrap to a max width (in pt) for a given pdf-lib font & size.
function wrapToWidth(font, text, size, maxW) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const trial = line ? line + ' ' + w : w;
    if (font.widthOfTextAtSize(trial, size) <= maxW || !line) { line = trial; }
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * @param {Object}     data
 * @param {Uint8Array|ArrayBuffer} data.templateBytes  the export_bill_form.pdf bytes
 * @param {string}     data.invNo
 * @param {string}     data.currency
 * @param {number}     data.amount
 * @param {string}     [data.portLoading]
 * @param {string}     [data.portDestination]
 * @param {string}     [data.origin]        default "India"
 * @param {string}     data.exporterName
 * @param {string}     [data.exporterAddress]   may contain "\n"
 * @param {string}     [data.exporterTel]
 * @param {string}     [data.exporterEmail]
 * @param {string}     [data.buyerName]
 * @param {string}     [data.buyerAddress]      may contain "\n"
 * @param {string}     [data.buyerCountry]
 * @param {string}     [data.buyerEmail]
 * @returns {Promise<Uint8Array>}   3-page filled form
 */
export async function fillExportBillForm(data) {
  const {
    templateBytes,
    invNo = '', currency = '', amount = 0,
    portLoading = '', portDestination = '', origin = 'India',
    exporterName = '', exporterAddress = '', exporterTel = '', exporterEmail = '',
    buyerName = '', buyerAddress = '', buyerCountry = '', buyerEmail = '',
  } = data;

  const pdfDoc = await PDFDocument.load(templateBytes);
  const hv = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const hvb = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const p1 = pdfDoc.getPages()[0];

  const dt = (x, y, text, bold = false, size = 8) => {
    if (text == null || text === '') return;
    p1.drawText(String(text), { x, y, font: bold ? hvb : hv, size, color: BLACK });
  };

  // ── Bill Details ──
  dt(C1.invNo.x, C1.invNo.y, invNo, true);
  dt(C1.currency.x, C1.currency.y, currency, true);

  const amtStr = Number(amount).toLocaleString('en-IN', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  dt(C1.amtFigure.x, C1.amtFigure.y, `${currency} ${amtStr}`, true);

  // amount in words — single line, auto-shrunk to fit its cell width
  const wordsStr = amountInWords(currency, amount);
  let ws = C1.amtWords.size;
  while (ws > 5 && hv.widthOfTextAtSize(wordsStr, ws) > C1.amtWords.maxW) ws -= 0.5;
  dt(C1.amtWords.x, C1.amtWords.y, wordsStr, false, ws);

  dt(C1.portLoad.x, C1.portLoad.y, portLoading, false);
  dt(C1.portDest.x, C1.portDest.y, portDestination, false);
  dt(C1.origin.x, C1.origin.y, origin, false);

  // ── Exporter's (Drawer) Details ──
  dt(C1.expName.x, C1.expName.y, exporterName, true);
  (exporterAddress ? String(exporterAddress).split('\n') : []).forEach((ln, i) => {
    dt(C1.expAddr.x, C1.expAddr.y - i * C1.expAddr.dy, ln.trim(), false, C1.expAddr.size);
  });
  dt(C1.expTel.x, C1.expTel.y, exporterTel, false);
  dt(C1.expEmail.x, C1.expEmail.y, exporterEmail, false, C1.expEmail.size);

  // ── Buyer's (Drawee) Details ──
  dt(C1.buyName.x, C1.buyName.y, buyerName, true);
  // Buyer address is free-form — normalise newlines/commas and wrap to the cell.
  const rawAddr = String(buyerAddress || '').replace(/\s*\n\s*/g, ', ').replace(/\s+/g, ' ').trim();
  wrapToWidth(hv, rawAddr, C1.buyAddr.size, C1.buyAddr.maxW).slice(0, C1.buyAddr.maxLines).forEach((ln, i) => {
    dt(C1.buyAddr.x, C1.buyAddr.y - i * C1.buyAddr.dy, ln, false, C1.buyAddr.size);
  });
  dt(C1.buyCountry.x, C1.buyCountry.y, buyerCountry, false);
  dt(C1.buyEmail.x, C1.buyEmail.y, buyerEmail, false, C1.buyEmail.size);

  // ── keep only the 3-page form (drop bank's internal checklists, pages 4-5) ──
  const last = pdfDoc.getPageCount() - 1;
  for (let i = last; i >= 3; i--) pdfDoc.removePage(i);

  return pdfDoc.save();
}
