/**
 * Parse Zoho invoice CSVs and Contacts CSV → csvInvoicesData.js + csvBuyersData.js
 */
import { readFileSync, writeFileSync } from 'fs';

// RFC-4180 CSV parser — handles multiline quoted fields, escaped double-quotes
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') { field += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === ',' && !inQuotes) {
      row.push(field); field = '';
    } else if ((ch === '\n' || (ch === '\r' && text[i + 1] === '\n')) && !inQuotes) {
      if (ch === '\r') i++;
      row.push(field); field = '';
      if (row.some(x => x !== '')) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field || row.length > 0) { row.push(field); if (row.some(x => x !== '')) rows.push(row); }
  return rows;
}

let invIdx = 0, itemIdx = 0, buyerIdx = 0;
const uid = () => `csv-inv-${++invIdx}-${Date.now()}`;
const iid = () => `csv-iitem-${++itemIdx}-${Date.now()}`;
const bid = () => `csv-buyer-${++buyerIdx}-${Date.now()}`;

// ── Invoice column indices ────────────────────────────────
const CI = {
  date: 0, invId: 1, invNo: 2, status: 4, custId: 5, custName: 6,
  dueDate: 13, currency: 15, fxRate: 16,
  subtotal: 29, total: 30, balance: 31, shipping: 32,
  notes: 38, terms: 39,
  ewayTime: 41,
  payTermsLabel: 37,
  itemName: 58, itemDesc: 59, qty: 60, itemTotal: 63, unit: 64, rate: 65,
  billAddr: 90, billStreet2: 91, billCity: 92, billState: 93, billCountry: 94, billZip: 95,
  shipAddr: 99, shipStreet2: 100, shipCity: 101, shipState: 102, shipCountry: 103,
  igstRate: 118, gstin: 136, hsn: 141,
  portLading: 172, portDischarge: 173,
};

// ── Contacts column indices ───────────────────────────────
const CC = {
  displayName: 2, company: 3, phone: 7, currency: 8, notes: 9,
  billAddr: 20, billStreet2: 21, billCity: 22, billState: 23, billCountry: 24, billZip: 26,
  shipAddr: 32, shipStreet2: 33, shipCity: 34, shipState: 35, shipCountry: 36, shipZip: 38,
  gstTreatment: 51, gstin: 52,
  primaryContactId: 55, email: 56, mobile: 57, contactId: 58, contactName: 59,
  portLading: 70,
};

// ── Parse invoices ────────────────────────────────────────
function processInvoiceFile(filepath) {
  const rows = parseCSV(readFileSync(filepath, 'utf-8'));
  return rows.slice(1); // skip header
}

const inv1 = processInvoiceFile('/Users/manavjhaveri/Downloads/Invoice (1).csv');
const inv2 = processInvoiceFile('/Users/manavjhaveri/Downloads/Invoice (2).csv');
const allRows = [...inv1, ...inv2];

// Group by Invoice ID
const invMap = new Map();
for (const r of allRows) {
  if (!r || r.length < 30) continue;
  const invId = (r[CI.invId] || '').trim();
  if (!invId) continue;
  if (!invMap.has(invId)) invMap.set(invId, { h: r, items: [] });
  const itemName = (r[CI.itemName] || '').trim();
  if (itemName) {
    invMap.get(invId).items.push({
      id: iid(),
      desc: itemName + ((r[CI.itemDesc] || '').trim() ? ' – ' + r[CI.itemDesc].trim() : ''),
      hsn: (r[CI.hsn] || '69120090').trim() || '69120090',
      qty: parseFloat(r[CI.qty]) || 0,
      unit: (r[CI.unit] || 'pcs').trim() || 'pcs',
      rate: parseFloat(r[CI.rate]) || 0,
      amt: parseFloat(r[CI.itemTotal]) || 0,
      igst: parseFloat(r[CI.igstRate]) || 0,
    });
  }
}

const invoices = [];
for (const [, { h: r, items }] of invMap) {
  const rawStatus = (r[CI.status] || '').trim().toLowerCase();
  const status = rawStatus === 'closed' ? 'paid' : rawStatus === 'overdue' ? 'overdue' : 'draft';
  const totalAmt = parseFloat(r[CI.total]) || 0;
  const balance  = parseFloat(r[CI.balance]) || 0;
  const paidAmt  = Math.max(0, totalAmt - balance);
  const invNo    = (r[CI.invNo] || '').trim();
  const invType  = invNo.toLowerCase().startsWith('proforma') ? 'proforma' : 'commercial';
  const goodsShipped = !!(r[CI.ewayTime] || '').trim() || status === 'paid';

  const ba = [r[CI.billAddr], r[CI.billStreet2], r[CI.billCity], r[CI.billState]]
    .map(x => (x || '').trim()).filter(Boolean).join(', ');
  const billingAddress = ba + (r[CI.billCountry] ? '\n' + r[CI.billCountry].trim() : '') + (r[CI.billZip] ? ' ' + r[CI.billZip].trim() : '');

  const portLading    = (r[CI.portLading]    || '').trim();
  const portDischarge = (r[CI.portDischarge] || '').trim();

  invoices.push({
    id: uid(),
    invNo,
    type: invType,
    date:    (r[CI.date]    || '').trim() || '2025-01-01',
    dueDate: (r[CI.dueDate] || '').trim() || '',
    currency: (r[CI.currency] || 'INR').trim(),
    terms: (r[CI.payTermsLabel] || '').trim(),
    portLading,
    portDischarge,
    buyerId:      (r[CI.custId]   || '').trim(),
    buyerName:    (r[CI.custName] || '').trim(),
    buyerAddress: billingAddress.trim(),
    buyerCountry: (r[CI.billCountry] || '').trim(),
    buyerGstin:   (r[CI.gstin]   || '').trim(),
    consigneeSameAsBuyer: true,
    consigneeName: '', consigneeAddress: '', consigneeCountry: '',
    items: items.length ? items : [{ id: iid(), desc: 'Goods', hsn: '69120090', qty: 1, unit: 'pcs', rate: 0, amt: totalAmt, igst: 0 }],
    notes: (r[CI.notes] || '').trim().replace(/\s+/g, ' ').substring(0, 400),
    termsText: (r[CI.terms] || '').trim().replace(/\s+/g, ' ').substring(0, 800),
    status,
    totalAmt,
    paidAmount: paidAmt,
    goodsShipped,
    createdAt: ((r[CI.date] || '').trim() || '2025-01-01') + 'T00:00:00.000Z',
  });
}

// ── Parse contacts/buyers ─────────────────────────────────
const contactRows = parseCSV(readFileSync('/Users/manavjhaveri/Downloads/Contacts (2).csv', 'utf-8')).slice(1);
const buyers = [];
for (const r of contactRows) {
  if (!r || r.length < 10) continue;
  const name = (r[CC.displayName] || '').trim();
  if (!name) continue;

  const buildAddr = (addr, street2, city, state, country, zip) =>
    [addr, street2, city, state].map(x => (x||'').trim()).filter(Boolean).join(', ')
    + (country ? '\n' + country.trim() : '') + (zip ? ' ' + zip.trim() : '');

  const billingAddress  = buildAddr(r[CC.billAddr], r[CC.billStreet2], r[CC.billCity], r[CC.billState], r[CC.billCountry], r[CC.billZip]).trim();
  const shippingAddress = buildAddr(r[CC.shipAddr], r[CC.shipStreet2], r[CC.shipCity], r[CC.shipState], r[CC.shipCountry], r[CC.shipZip]).trim();

  buyers.push({
    id:       (r[CC.contactId] || bid()).trim(),
    name,
    company:  (r[CC.company]   || '').trim(),
    email:    (r[CC.email]     || '').trim(),
    phone:    (r[CC.phone]     || r[CC.mobile] || '').trim(),
    currency: (r[CC.currency]  || 'USD').trim(),
    gstin:    (r[CC.gstin]     || '').trim(),
    gstTreatment: (r[CC.gstTreatment] || 'overseas').trim(),
    billingAddress,
    billingCity:  (r[CC.billCity]    || '').trim(),
    billingState: (r[CC.billState]   || '').trim(),
    country:      (r[CC.billCountry] || '').trim(),
    shippingSameAsBilling: !shippingAddress || shippingAddress === billingAddress,
    shippingAddress,
    portLading: (r[CC.portLading] || '').trim(),
    notes:      (r[CC.notes]     || '').trim(),
    createdAt:  new Date().toISOString(),
  });
}

// ── Summary ───────────────────────────────────────────────
console.log(`\n✅ Parsed ${invoices.length} invoices`);
console.log(`   Paid: ${invoices.filter(i=>i.status==='paid').length}, Draft/Overdue: ${invoices.filter(i=>i.status!=='paid').length}`);
console.log(`   USD: $${invoices.filter(i=>i.currency==='USD').reduce((s,i)=>s+i.totalAmt,0).toFixed(2)}`);
console.log(`   INR: ₹${invoices.filter(i=>i.currency==='INR').reduce((s,i)=>s+i.totalAmt,0).toLocaleString('en-IN',{maximumFractionDigits:0})}`);
console.log(`   JPY: ¥${invoices.filter(i=>i.currency==='JPY').reduce((s,i)=>s+i.totalAmt,0).toLocaleString()}`);
console.log(`   EUR: €${invoices.filter(i=>i.currency==='EUR').reduce((s,i)=>s+i.totalAmt,0).toFixed(2)}`);
console.log(`\n✅ Parsed ${buyers.length} buyers\n`);

buyers.forEach(b => console.log(`   ${b.name} (${b.country}) [${b.currency}]`));

// ── Write files ───────────────────────────────────────────
writeFileSync(
  '/Users/manavjhaveri/Downloads/project/src/csvInvoicesData.js',
  `export const CSV_INVOICES = ${JSON.stringify(invoices, null, 2)};\n`
);
console.log('\n✅ Written src/csvInvoicesData.js');

writeFileSync(
  '/Users/manavjhaveri/Downloads/project/src/csvBuyersData.js',
  `export const CSV_BUYERS = ${JSON.stringify(buyers, null, 2)};\n`
);
console.log('✅ Written src/csvBuyersData.js\n');
