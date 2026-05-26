/**
 * Parse Nikhil Gems Master Stock Tracker CSV → src/csvStockData.js
 *
 * CSV columns (0-indexed, row 2 is headers, data starts row 3):
 *  0: Date       1: Stone      2: Shape       3: Box (location)
 *  4: PCS        5: KG         6: CP          7: Unit
 *  8: WIX?       9: Etsy?     10: Shopify?   11: Photographed?
 * 12: Notes     13: Shows      14: SKU        15: Vendor
 * 16: Key       17: Pcs used  18: Kgs used   19: Photo
 */
import { readFileSync, writeFileSync } from 'fs';

// RFC-4180 CSV parser — handles quoted fields and embedded commas/newlines
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
      row.push(field.trim()); field = '';
    } else if ((ch === '\n' || (ch === '\r' && text[i + 1] === '\n')) && !inQuotes) {
      if (ch === '\r') i++;
      row.push(field.trim()); field = '';
      if (row.some(x => x !== '')) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field || row.length > 0) { row.push(field.trim()); if (row.some(x => x !== '')) rows.push(row); }
  return rows;
}

// Parse "31/12/2025" → "2025-12-31"
function parseDate(d) {
  if (!d) return '';
  const parts = d.split('/');
  if (parts.length === 3) return `${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`;
  return d;
}

// Strip ₹, commas, spaces and parse as float
function parseCost(s) {
  if (!s) return '';
  const n = parseFloat(s.replace(/[₹,\s]/g, ''));
  return isNaN(n) ? '' : n;
}

function parseBool(s) {
  return s?.trim().toUpperCase() === 'TRUE';
}

function parseNum(s) {
  const n = parseFloat(s?.replace(/,/g, '') || '');
  return isNaN(n) ? 0 : n;
}

const csvPath = '/Users/manavjhaveri/Downloads/Nikhil Gems Master Stock Tracker - Stock.csv';
const text = readFileSync(csvPath, 'utf8');
const rows = parseCSV(text);

// Skip row 0 (section header "1,,,,OPENING STOCK...") and row 1 (column headers)
// Data starts at row index 2
const dataRows = rows.slice(2);

let count = 0;
const items = [];

for (const row of dataRows) {
  // Skip fully empty rows or rows without a date
  if (!row[0]) continue;
  // Skip any sub-header rows that crept in
  if (row[0] === 'Date' || row[1] === 'Stone') continue;

  const date    = parseDate(row[0]);
  const material = row[1] || '';
  const shape   = row[2] || '';
  const location = row[3] || '';
  const pcsRaw  = parseNum(row[4]);
  const kgRaw   = parseNum(row[5]);
  const cost    = parseCost(row[6]);
  // col 7: Unit (ignored — we derive from PCS/KG)
  const postedWix      = parseBool(row[8]);
  const postedEtsy     = parseBool(row[9]);
  const postedShopify  = parseBool(row[10]);
  const photographed   = parseBool(row[11]);
  const notes   = row[12] || '';
  const market  = row[13] || 'Unassigned';
  const sku     = row[14] || '';
  const vendor  = row[15] || '';

  if (!material) continue;

  // Qty/unit logic:
  //   PCS > 0  → qty=PCS, unit="pcs", weightGm=KG*1000
  //   PCS == 0 → qty=KG,  unit="kg",  weightGm=KG*1000
  let qty, unit, weightGm;
  if (pcsRaw > 0) {
    qty = pcsRaw;
    unit = 'pcs';
    weightGm = kgRaw > 0 ? Math.round(kgRaw * 1000) : '';
  } else if (kgRaw > 0) {
    qty = kgRaw;
    unit = 'kg';
    weightGm = Math.round(kgRaw * 1000);
  } else {
    qty = '';
    unit = 'pcs';
    weightGm = '';
  }

  count++;
  const notesParts = [];
  if (notes) notesParts.push(notes);
  if (vendor) notesParts.push(`Vendor: ${vendor}`);
  if (sku) notesParts.push(`SKU: ${sku}`);
  notesParts.push('Imported from CSV');

  items.push({
    id: `csv-stock-${count}-${1700000000 + count}`,
    material,
    shape,
    origin: '',
    size: '',
    grade: '',
    hsn: '7103',
    qty,
    unit,
    weightGm,
    costPrice: cost,
    location,
    market: market || 'Unassigned',
    productType: '',
    photographed,
    postedShopify,
    postedWix,
    postedEtsy,
    photo: '',
    notes: notesParts.join(' | '),
    addedDate: date || new Date().toISOString().slice(0, 10),
    source: 'csv-import',
  });
}

const output = `export const CSV_STOCK = ${JSON.stringify(items, null, 2)};\n`;
writeFileSync('/Users/manavjhaveri/Downloads/project/src/csvStockData.js', output);
console.log(`✅ Parsed ${items.length} stock items → src/csvStockData.js`);

// Quick summary
const pcsItems = items.filter(i => i.unit === 'pcs');
const kgItems  = items.filter(i => i.unit === 'kg');
const withWeight = items.filter(i => i.weightGm);
const photographedCount = items.filter(i => i.photographed).length;
const wixCount     = items.filter(i => i.postedWix).length;
const etsyCount    = items.filter(i => i.postedEtsy).length;
const shopifyCount = items.filter(i => i.postedShopify).length;
console.log(`   ${pcsItems.length} pcs items, ${kgItems.length} kg items`);
console.log(`   ${withWeight.length} items with weight data`);
console.log(`   📸 ${photographedCount} photographed · Wix: ${wixCount} · Etsy: ${etsyCount} · Shopify: ${shopifyCount}`);
