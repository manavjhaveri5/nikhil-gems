/**
 * One-time CSV import script: Nikhil Gems Finance Tracker → ng-purch-v5 bills
 * Run: node import-bills.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const SUPABASE_URL = "https://bxnqnbspibvbnxbojrhe.supabase.co";
const SUPABASE_KEY = "sb_publishable_f28nKe2nPEkN0o12ZoFaVw_V2N5J6az";
const PURCH_KEY    = "ng-purch-v5";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/* ── helpers ────────────────────────────────────────────────────── */

/** Parse ₹1,23,456.78 → number */
function parseAmt(s) {
  if (s == null || s === "" || s === "#N/A" || String(s).trim() === "-") return 0;
  const cleaned = String(s).replace(/[₹,\s]/g, "").replace(/[^0-9.\-]/g, "");
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

/** "02/06/25" | "2/6/25" | "1/12/25" → "2025-06-02" */
function parseDate(s) {
  if (!s || s.trim() === "") return null;
  const parts = s.trim().split("/");
  if (parts.length !== 3) return null;
  let [d, m, y] = parts.map(p => parseInt(p.trim(), 10));
  if (isNaN(d) || isNaN(m) || isNaN(y)) return null;
  if (y < 100) y = 2000 + y;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Proper RFC-4180 CSV line parser (handles quoted commas + escaped quotes) */
function parseCSVLine(line) {
  const result = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { field += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === "," && !inQuotes) {
      result.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  result.push(field);
  return result;
}

let billIdx = 0;
function uid() { return `csv-bill-${++billIdx}-${Date.now()}`; }
function itemId() { return `csv-item-${billIdx}-${Date.now()}`; }

/* ── parse CSV ──────────────────────────────────────────────────── */

const csvText = readFileSync(
  "/Users/manavjhaveri/Downloads/Nikhil Gems Master Finance Tracker - Ordered.csv",
  "utf-8"
);

const lines = csvText.split(/\r?\n/);
const bills = [];

// Columns: Date,Vendor,Stone,Shape,Pcs,Kgs,Rate,Total,GST,Grand Total,Paid Amount,Balance,Purchase Bill,notes,Invoice Number,Lot ID
for (let i = 1; i < lines.length; i++) {
  const raw = lines[i].trim();
  if (!raw) continue;

  const cols = parseCSVLine(raw);

  const vendor    = (cols[1]  || "").trim();
  const stone     = (cols[2]  || "").trim();
  const shape     = (cols[3]  || "").trim();
  const pcsRaw    = (cols[4]  || "").trim();
  const kgsRaw    = (cols[5]  || "").trim();
  const rateRaw   = (cols[6]  || "").trim();

  // Skip empty rows — need at least a vendor
  if (!vendor) continue;

  // Skip balance snapshot rows (these were Nishant's cash/bank balance notes)
  if (vendor === "Nishant" && (stone === "Cash Balance" || stone === "Bank Balance")) continue;

  const total      = parseAmt(cols[7]);
  const gstAmt     = parseAmt(cols[8]);
  const grandTotal = parseAmt(cols[9]);
  const paidAmt    = parseAmt(cols[10]);
  const balance    = parseAmt(cols[11]);
  const billRef    = (cols[12] || "").trim();
  const notesRaw   = (cols[13] || "").trim();
  const invNum     = (cols[14] || "").trim();

  // Derive best "total amount" for the bill
  // Grand Total is the definitive payable; fall back to Total+GST or Paid if missing
  let totalAmount = grandTotal;
  if (totalAmount === 0) totalAmount = total + gstAmt;
  if (totalAmount === 0) totalAmount = paidAmt;
  // If still zero (no amounts at all) but vendor exists → include as ₹0 record
  // (e.g. rows like Yasin Bapu coco jasper rough spheres with no pricing yet)

  // Determine status
  let status;
  const tol = 2; // rounding tolerance ₹2
  if (paidAmt >= totalAmount - tol && totalAmount > 0) {
    status = "paid";
  } else if (paidAmt > 0 && totalAmount > 0) {
    status = "partial";
  } else if (totalAmount === 0 && paidAmt === 0) {
    status = "pending"; // no amounts yet — still a liability if balance says so
  } else {
    status = "pending";
  }

  // Date
  const dateStr = parseDate(cols[0]);

  // Qty & unit
  const kgs  = parseFloat(kgsRaw.replace(/[^\d.]/g, "")) || 0;
  const pcs  = parseFloat(pcsRaw.replace(/[^\d.]/g, "")) || 0;
  const rate = parseFloat(rateRaw.replace(/[^\d./]/g, "")) || 0;
  let qty  = 0;
  let unit = "pcs";
  if (kgs  > 0)  { qty = kgs;  unit = "kg"; }
  else if (pcs > 0) { qty = pcs;  unit = "pcs"; }

  // Description
  const descParts = [stone, shape].filter(Boolean);
  const desc = descParts.join(" – ") || "Purchase";

  // Bill number: prefer the document ref in "Purchase Bill" col,
  // then invoice number, else auto-generate
  const billNum = billRef && !["cash","CASH","packing","Packing","marketing","cash balance","bank balance"].includes(billRef.toLowerCase())
    ? billRef
    : invNum || `CSV-${billIdx + 1}`;

  // Notes: combine all available info
  const noteParts = [];
  if (notesRaw) noteParts.push(notesRaw);
  if (invNum && billNum !== invNum) noteParts.push(`Invoice: ${invNum}`);
  if (billRef && billNum !== billRef) noteParts.push(`Ref: ${billRef}`);
  noteParts.push("Imported from CSV");

  const id = uid();
  const bill = {
    type:             "bill",
    id,
    billNumber:       billNum,
    supplier:         vendor,
    supplierGstin:    "",
    supplierLocation: "",
    supplierCountry:  "India",
    supplierContact:  "",
    billDate:         dateStr || "2025-01-01",
    currency:         "INR",
    items: [{
      id:   itemId(),
      desc,
      hsn:  "",
      gst:  0,            // GST already baked into totalAmount
      qty,
      unit,
      rate,
      amt:  totalAmount,  // Use grand total as item amount
    }],
    notes:       noteParts.join(" | "),
    status,
    paidAmount:  paidAmt,
    totalAmount,
    createdAt:   dateStr ? `${dateStr}T00:00:00.000Z` : new Date().toISOString(),
  };

  bills.push(bill);
}

console.log(`\n✅ Parsed ${bills.length} bills from CSV\n`);

// Print summary
const paid    = bills.filter(b => b.status === "paid");
const partial = bills.filter(b => b.status === "partial");
const pending = bills.filter(b => b.status === "pending");
const totalOwed = bills.reduce((s, b) => s + (b.totalAmount || 0), 0);
const totalPaid = bills.reduce((s, b) => s + (b.paidAmount  || 0), 0);
const outstanding = totalOwed - totalPaid;

console.log(`   Paid:     ${paid.length} bills`);
console.log(`   Partial:  ${partial.length} bills`);
console.log(`   Pending:  ${pending.length} bills`);
console.log(`   Total Purchased: ₹${totalOwed.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`);
console.log(`   Total Paid:      ₹${totalPaid.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`);
console.log(`   Outstanding:     ₹${outstanding.toLocaleString("en-IN", { maximumFractionDigits: 0 })}\n`);

/* ── merge with existing Supabase data ─────────────────────────── */

console.log("⏳ Loading existing purchases from Supabase …");

const { data: existing, error: loadErr } = await supabase
  .from("app_data")
  .select("value")
  .eq("key", PURCH_KEY)
  .single();

if (loadErr && loadErr.code !== "PGRST116") {
  console.error("❌ Load error:", loadErr.message);
  process.exit(1);
}

const existingBills = existing?.value ?? [];
console.log(`   Found ${existingBills.length} existing records.\n`);

// Avoid duplicates by id prefix "csv-bill-" — remove old CSV imports first,
// then append fresh ones
const nonCSV = existingBills.filter(b => !String(b.id || "").startsWith("csv-bill-"));
const merged = [...nonCSV, ...bills];

console.log(`⏳ Saving ${merged.length} total records to Supabase (${nonCSV.length} existing + ${bills.length} CSV) …`);

const { error: saveErr } = await supabase
  .from("app_data")
  .upsert({ key: PURCH_KEY, value: merged });

if (saveErr) {
  console.error("❌ Save error:", saveErr.message);
  process.exit(1);
}

console.log("✅ Import complete! All bills saved to ng-purch-v5.\n");
console.log(`   Open the app → Purchases to see ${bills.length} imported bills.`);
console.log(`   Outstanding payables: ₹${outstanding.toLocaleString("en-IN", { maximumFractionDigits: 0 })}\n`);
