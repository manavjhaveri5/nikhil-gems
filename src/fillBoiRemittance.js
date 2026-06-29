/**
 * fillBoiRemittance.js
 * Core utility — framework-agnostic, works in browser with pdf-lib.
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

// ─────────────────────────────────────────────
//  COORDINATES  (all in PDF points, y from bottom)
//  Page 1: 487.3 × 680.5 pt
//  Page 2: 487.0 × 759.0 pt
// ─────────────────────────────────────────────
const COORDS = {
  p1: {
    amount:        { x: 248, y: 460 },
    remName:       { x: 248, y: 447 },
    remAddr:       { x: 248, y: 439 },
    tick_a:        { x: 222, y: 421 },
    tick_b:        { x: 222, y: 407 },
    tick_c:        { x: 222, y: 302 },
    tick_d:        { x: 222, y: 279 },
    tick_e:        { x: 222, y: 257 },
    bill1:         { x: 290, y: 422 },
    bill2:         { x: 290, y: 413 },
    bill3:         { x: 290, y: 404 },
    shipCheck_w3:  { x: 271, y: 393 },
    shipCheck_a12: { x: 271, y: 375 },
    lineAct:       { x: 248, y: 362 },
    commodity:     { x: 248, y: 344 },
    po1:           { x: 248, y: 325 },
    po2:           { x: 248, y: 316 },
    po3:           { x: 248, y: 307 },
    impDet:        { x: 295, y: 303 },
    expBill:       { x: 295, y: 287 },
    otherCl:       { x: 295, y: 258 },
    eefc_check:    { x: 259, y: 228 },
    eefc_accNo:    { x: 370, y: 224 },
    inr_check:     { x: 259, y: 214 },
    inr_accNo:     { x: 310, y: 204 },
  },
  p2: {
    date:  { x: 110, y: 196 },
    place: { x: 120, y: 178 },
    name:  { x: 295, y: 160 },
    addr1: { x: 302, y: 143 },
    addr2: { x: 302, y: 134 },
    iec:   { x: 313, y: 122 },
    stamp: { x: 280, y: 68, w: 150, h: 54 },
  },
};

const BLACK = rgb(0, 0, 0);
const fd = (d) => {
  if (!d) return '';
  const [y, m, day] = d.split('-');
  return `${day}/${m}/${y}`;
};

/**
 * @param {Object}     data
 * @param {string}     data.currency
 * @param {number}     data.amount
 * @param {string}     data.accType           'eefc' | 'inr'
 * @param {string}     data.accountNo
 * @param {string}     data.remName
 * @param {string}     [data.remAddr]
 * @param {string}     data.purpose           'a' | 'b' | 'c' | 'd' | 'e'
 * @param {Array}      data.invoices          [{no, date, pdfBytes?}]
 * @param {string}     [data.shipWin]         'w3' | 'a12'
 * @param {string}     [data.commodity]
 * @param {string}     [data.lineAct]
 * @param {string}     [data.impDet]
 * @param {string}     [data.expBill]
 * @param {string}     [data.otherCl]
 * @param {string}     data.bName
 * @param {string}     data.bAddr1
 * @param {string}     data.bAddr2
 * @param {string}     data.iecCode
 * @param {string}     data.sigDate           'YYYY-MM-DD'
 * @param {string}     [data.sigPlace]
 * @param {Uint8Array} data.boiPdfBytes
 * @param {Uint8Array} data.sigJpegBytes
 * @returns {Promise<Uint8Array>}
 */
export async function fillBoiRemittance(data) {
  const {
    currency, amount, accType, accountNo,
    remName, remAddr = '',
    purpose,
    invoices = [],
    shipWin = 'w3', commodity = '', lineAct = '',
    impDet = '', expBill = '', otherCl = '',
    bName, bAddr1, bAddr2, iecCode,
    sigDate, sigPlace = 'Mumbai',
    boiPdfBytes, sigJpegBytes,
  } = data;

  const pdfDoc = await PDFDocument.load(boiPdfBytes);
  const hv  = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const hvb = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const pages = pdfDoc.getPages();
  const [p1, p2] = pages;

  const dt = (page, x, y, text, bold = false, size = 8) => {
    if (!text) return;
    page.drawText(String(text), { x, y, font: bold ? hvb : hv, size, color: BLACK });
  };
  const fb = (page, x, y, w = 5, h = 5) => {
    page.drawRectangle({ x, y, width: w, height: h, color: BLACK });
  };

  // ── PAGE 1 ──
  const amtStr = Number(amount).toLocaleString('en-IN', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  dt(p1, COORDS.p1.amount.x, COORDS.p1.amount.y, `${currency} ${amtStr}`, true);
  dt(p1, COORDS.p1.remName.x, COORDS.p1.remName.y, remName, true);
  dt(p1, COORDS.p1.remAddr.x, COORDS.p1.remAddr.y, remAddr, false, 7);

  const tickKey = `tick_${purpose}`;
  if (COORDS.p1[tickKey]) fb(p1, COORDS.p1[tickKey].x, COORDS.p1[tickKey].y);

  const billNos = invoices.filter(i => i.no);

  if (purpose === 'a') {
    [COORDS.p1.bill1, COORDS.p1.bill2, COORDS.p1.bill3].forEach((pos, i) => {
      if (billNos[i]) dt(p1, pos.x, pos.y, billNos[i].no, true);
    });
  } else if (purpose === 'b') {
    const shipPos = shipWin === 'a12' ? COORDS.p1.shipCheck_a12 : COORDS.p1.shipCheck_w3;
    fb(p1, shipPos.x, shipPos.y);
    dt(p1, COORDS.p1.lineAct.x,   COORDS.p1.lineAct.y,   lineAct,   false, 7);
    dt(p1, COORDS.p1.commodity.x, COORDS.p1.commodity.y, commodity, false, 7);
    [COORDS.p1.po1, COORDS.p1.po2, COORDS.p1.po3].forEach((pos, i) => {
      if (billNos[i]) dt(p1, pos.x, pos.y, billNos[i].no, true);
    });
  } else if (purpose === 'c') {
    dt(p1, COORDS.p1.impDet.x,  COORDS.p1.impDet.y,  impDet,  false, 7);
    dt(p1, COORDS.p1.expBill.x, COORDS.p1.expBill.y, expBill, false, 7);
  } else if (purpose === 'e') {
    dt(p1, COORDS.p1.otherCl.x, COORDS.p1.otherCl.y, otherCl, false, 7);
  }

  if (accType === 'eefc') {
    fb(p1, COORDS.p1.eefc_check.x, COORDS.p1.eefc_check.y);
    dt(p1, COORDS.p1.eefc_accNo.x, COORDS.p1.eefc_accNo.y, accountNo, true, 7);
  } else {
    fb(p1, COORDS.p1.inr_check.x, COORDS.p1.inr_check.y);
    dt(p1, COORDS.p1.inr_accNo.x, COORDS.p1.inr_accNo.y, accountNo, true, 7);
  }

  // ── PAGE 2 ──
  dt(p2, COORDS.p2.date.x,  COORDS.p2.date.y,  fd(sigDate), true);
  dt(p2, COORDS.p2.place.x, COORDS.p2.place.y, sigPlace,    true);
  dt(p2, COORDS.p2.name.x,  COORDS.p2.name.y,  bName,       true);
  dt(p2, COORDS.p2.addr1.x, COORDS.p2.addr1.y, bAddr1,      false, 7);
  dt(p2, COORDS.p2.addr2.x, COORDS.p2.addr2.y, bAddr2,      false, 7);
  dt(p2, COORDS.p2.iec.x,   COORDS.p2.iec.y,   iecCode,     true);

  const { x: sx, y: sy, w: sw, h: sh } = COORDS.p2.stamp;
  const sigImg = await pdfDoc.embedJpg(sigJpegBytes);
  p2.drawImage(sigImg, { x: sx, y: sy, width: sw, height: sh });

  // ── MERGE INVOICE PDFs ──
  const invPdfs = invoices.filter(i => i.pdfBytes);
  if (!invPdfs.length) return pdfDoc.save();

  const merged = await PDFDocument.create();
  const formPages = await merged.copyPages(pdfDoc, pdfDoc.getPageIndices());
  formPages.forEach(p => merged.addPage(p));

  for (const inv of invPdfs) {
    try {
      const invDoc = await PDFDocument.load(inv.pdfBytes);
      const invPages = await merged.copyPages(invDoc, invDoc.getPageIndices());
      invPages.forEach(p => merged.addPage(p));
    } catch (e) {
      console.warn(`Could not load invoice PDF for ${inv.no}:`, e.message);
    }
  }

  return merged.save();
}
