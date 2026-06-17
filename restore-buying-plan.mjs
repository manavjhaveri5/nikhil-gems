/**
 * Nikhil Gems — Denver Mineral Show buying-plan restore (GEMSTONES INFINITY)
 * Run on your Mac:  node restore-buying-plan.mjs
 *
 * Strategy: ADD ONLY MISSING.
 *   - Keeps every existing row in Denver untouched (all vendors).
 *   - For each row in the "before" list below, it is added ONLY if no existing
 *     GEMSTONES INFINITY row already has the same stone+shape (case/space-insensitive).
 *   - Safe + idempotent: re-running adds nothing new.
 *
 * A timestamped backup of ng-shows-v1 is written to your Desktop before saving.
 */

import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";

const SUPABASE_URL     = "https://bxnqnbspibvbnxbojrhe.supabase.co";
const SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ4bnFuYnNwaWJ2Ym54Ym9qcmhlIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzU0NTM3MywiZXhwIjoyMDg5MTIxMzczfQ.MiAPlsQgVryzW09cK7U-d5RBtaryVaEVdeefTKr-ykc";
const SHOW_ID = "denver-2026";
const VENDOR  = "GEMSTONES INFINITY";

const uid = () => Math.random().toString(36).substr(2, 9);
const norm = v => String(v || "").trim().toLowerCase();

// ── The "before" list: shape, stone, qty (kg), cost ₹/kg ──────────────────
const BEFORE = [
  // Heart
  ["Heart","Afghanite",2,30000],
  ["Heart","Variscite",3,11000],
  ["Heart","Aquamarine",3,11000],
  ["Heart","Shattuckite",3,8000],
  ["Heart","Seraphinite",5,23000],
  ["Heart","Haze Sunstone",2,20000],
  ["Heart","Kunzite",3,11000],
  ["Heart","Citron Chrysoprase",3,9000],
  ["Heart","Yttrium Fluorite",2,23000],
  ["Heart","Sonora Sunset",3,25000],
  // Sphere
  ["Sphere","Afghanite",2,30000],
  ["Sphere","Variscite",3,11000],
  ["Sphere","Aquamarine",3,11000],
  ["Sphere","Seraphinite",5,23000],
  ["Sphere","Malachite Chrysocolla",3,15000],
  ["Sphere","Charoite",3,33000],
  ["Sphere","Citron Chrysoprase",3,9000],
  ["Sphere","Ruby Zoisite",2,23000],
  ["Sphere","Thulite",3,11500],
  ["Sphere","Blue Lace Agate",5,16000],
  ["Sphere","Sonora Sunset",3,25000],
  ["Sphere","Ajoite",2,35000],
  ["Sphere","Emerald",2,23000],
  ["Sphere","Tiffany Stone",1,80000],
  // Palmstone
  ["Palmstone","Afghanite",2,30000],
  ["Palmstone","Variscite",3,11000],
  ["Palmstone","Citron Chrysoprase",3,9000],
  ["Palmstone","Sonora Sunset",3,25000],
  // Palmstones
  ["Palmstones","Shattuckite",3,8000],
  // Spheres
  ["Spheres","Shattuckite",3,8000],
  // Shivalingam
  ["Shivalingam","Haze Sunstone",2,20000],
  ["Shivalingam","Malachite",5,13000],
  // Mini Puffy Hearts
  ["Mini Puffy Hearts","Malachite Chrysocolla",3,15000],
  ["Mini Puffy Hearts","Charoite",3,33000],
  // Flatstone
  ["Flatstone","Cobalto Calcite",3,18000],
  ["Flatstone","Charoite",3,33000],
  ["Flatstone","Ruby Zoisite",1,23000],
  ["Flatstone","Hypersthene",3,11000],
  ["Flatstone","Pink Rhodonite",5,5500],
  ["Flatstone","Tanzanian Moonstone",5,7500],
  ["Flatstone","Blue Lace Agate",3,16000],
  // Puffy Mini Heart
  ["Puffy Mini Heart","Ruby Zoisite",2,23000],
  // Mini Puffy Heart
  ["Mini Puffy Heart","Thulite",3,11500],
];

const makeLine = (shape, stone, qty, costPerKg) => ({
  id: uid(), stone, shape, vendor: VENDOR,
  qty: String(qty), unit: "kg", targetRate: "",
  currency: "INR", priority: "Medium",
  notes: "", notesAuto: false,
  costPerKg: String(costPerKg),
  targetSellPrice: "", targetSellPriceUsd: "",
  lastRate: "", lastVendor: "", lastDate: "", lastSource: "",
  createdAt: new Date().toISOString(),
});

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

console.log(`Fetching ng-shows-v1 from Supabase...\n`);
const { data, error } = await supabase
  .from("app_data").select("value,updated_at").eq("key", "ng-shows-v1").single();
if (error) { console.error("ERROR:", error.message); process.exit(1); }

const shows = data.value;
const show = shows.find(s => s.id === SHOW_ID);
if (!show) { console.error(`Show ${SHOW_ID} not found.`); process.exit(1); }

// Backup current state to Desktop first
const stamp = new Date().toISOString().slice(0,19).replace(/:/g,"-");
const backupPath = `${process.env.HOME}/Desktop/ng-shows-BACKUP-before-restore-${stamp}.json`;
writeFileSync(backupPath, JSON.stringify(shows, null, 2));
console.log(`🛟  Backup written: ${backupPath}\n`);

const plan = show.buyingPlan || [];
console.log(`"${show.name}" currently has ${plan.length} lines `
  + `(${plan.filter(r => r.vendor === VENDOR).length} ${VENDOR}).\n`);

// Existing GEMSTONES INFINITY stone+shape combos
const existing = new Set(
  plan.filter(r => r.vendor === VENDOR).map(r => `${norm(r.stone)}|||${norm(r.shape)}`)
);

const added = [], skipped = [];
const toAppend = [];
for (const [shape, stone, qty, cost] of BEFORE) {
  const key = `${norm(stone)}|||${norm(shape)}`;
  if (existing.has(key)) { skipped.push(`${shape} / ${stone}`); continue; }
  existing.add(key); // guard against dupes within the BEFORE list itself
  toAppend.push(makeLine(shape, stone, qty, cost));
  added.push(`${shape} / ${stone}  —  ${qty}kg @ ₹${cost.toLocaleString("en-IN")}`);
}

console.log(`➕ Will ADD ${added.length} missing row(s):`);
added.forEach(a => console.log(`   + ${a}`));
console.log(`\n⏭️  Skipped ${skipped.length} (stone+shape already present):`);
skipped.forEach(s => console.log(`   - ${s}`));

if (toAppend.length === 0) {
  console.log("\nNothing to add — every row already exists. No write performed.");
  process.exit(0);
}

const newPlan = [...plan, ...toAppend];
const newShows = shows.map(s => s.id === SHOW_ID ? { ...s, buyingPlan: newPlan } : s);

const { error: upErr } = await supabase
  .from("app_data")
  .update({ value: newShows, updated_at: new Date().toISOString() })
  .eq("key", "ng-shows-v1");
if (upErr) { console.error("\nSAVE FAILED:", upErr.message); process.exit(1); }

console.log(`\n✅ Saved. "${show.name}" now has ${newPlan.length} lines `
  + `(${newPlan.filter(r => r.vendor === VENDOR).length} ${VENDOR}).`);
console.log("   Refresh the app in your browser to see the rows.");
