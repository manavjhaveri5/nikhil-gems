/**
 * Nikhil Gems — Buying Plan Restore (GEMSTONES INFINITY, Denver Mineral Show)
 * Run on your Mac: node restore-buying-plan.mjs
 *
 * Adds back the 43 missing GEMSTONES INFINITY rows to the Denver Mineral Show
 * buying plan. Skips any row where the exact same stone+shape combination
 * already exists for GEMSTONES INFINITY (so it's safe to re-run).
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL     = "https://bxnqnbspibvbnxbojrhe.supabase.co";
const SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ4bnFuYnNwaWJ2Ym54Ym9qcmhlIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzU0NTM3MywiZXhwIjoyMDg5MTIxMzczfQ.MiAPlsQgVryzW09cK7U-d5RBtaryVaEVdeefTKr-ykc";
const SHOWS_KEY        = "ng-shows-v1";
const DENVER_ID        = "denver-2026";
const VENDOR           = "GEMSTONES INFINITY";

const uid = () => Math.random().toString(36).substr(2, 9);
const now = () => new Date().toISOString();

// ── The 43 recovered rows (stone, shape, qty kg, costPerKg INR) ──────────────
const RECOVERED_ROWS = [
  // ── Heart ────────────────────────────────────────────────────────────────
  { stone: "Afghanite",          shape: "Heart",           qty: 2, costPerKg: 30000 },
  { stone: "Variscite",          shape: "Heart",           qty: 3, costPerKg: 11000 },
  { stone: "Aquamarine",         shape: "Heart",           qty: 3, costPerKg: 11000 },
  { stone: "Shattuckite",        shape: "Heart",           qty: 3, costPerKg:  8000 },
  { stone: "Seraphinite",        shape: "Heart",           qty: 5, costPerKg: 23000 },
  { stone: "Haze Sunstone",      shape: "Heart",           qty: 2, costPerKg: 20000 },
  { stone: "Kunzite",            shape: "Heart",           qty: 3, costPerKg: 11000 },
  { stone: "Citron Chrysoprase", shape: "Heart",           qty: 3, costPerKg:  9000 },
  { stone: "Yttrium Fluorite",   shape: "Heart",           qty: 2, costPerKg: 23000 },
  { stone: "Sonora Sunset",      shape: "Heart",           qty: 3, costPerKg: 25000 },

  // ── Sphere ───────────────────────────────────────────────────────────────
  { stone: "Afghanite",          shape: "Sphere",          qty: 2, costPerKg: 30000 },
  { stone: "Variscite",          shape: "Sphere",          qty: 3, costPerKg: 11000 },
  { stone: "Aquamarine",         shape: "Sphere",          qty: 3, costPerKg: 11000 },
  { stone: "Seraphinite",        shape: "Sphere",          qty: 5, costPerKg: 23000 },
  { stone: "Malachite Chrysocolla", shape: "Sphere",       qty: 3, costPerKg: 15000 },
  { stone: "Charoite",           shape: "Sphere",          qty: 3, costPerKg: 33000 },
  { stone: "Citron Chrysoprase", shape: "Sphere",          qty: 3, costPerKg:  9000 },
  { stone: "Ruby Zoisite",       shape: "Sphere",          qty: 2, costPerKg: 23000 },
  { stone: "Thulite",            shape: "Sphere",          qty: 3, costPerKg: 11500 },
  { stone: "Blue Lace Agate",    shape: "Sphere",          qty: 5, costPerKg: 16000 },
  { stone: "Sonora Sunset",      shape: "Sphere",          qty: 3, costPerKg: 25000 },
  { stone: "Ajoite",             shape: "Sphere",          qty: 2, costPerKg: 35000 },
  { stone: "Emerald",            shape: "Sphere",          qty: 2, costPerKg: 23000 },
  { stone: "Tiffany Stone",      shape: "Sphere",          qty: 1, costPerKg: 80000 },

  // ── Palmstone ────────────────────────────────────────────────────────────
  { stone: "Afghanite",          shape: "Palmstone",       qty: 2, costPerKg: 30000 },
  { stone: "Variscite",          shape: "Palmstone",       qty: 3, costPerKg: 11000 },
  { stone: "Citron Chrysoprase", shape: "Palmstone",       qty: 3, costPerKg:  9000 },
  { stone: "Sonora Sunset",      shape: "Palmstone",       qty: 3, costPerKg: 25000 },

  // ── Palmstones (plural heading — treated as its own shape bucket) ─────────
  { stone: "Shattuckite",        shape: "Palmstones",      qty: 3, costPerKg:  8000 },

  // ── Spheres (plural heading) ──────────────────────────────────────────────
  { stone: "Shattuckite",        shape: "Spheres",         qty: 3, costPerKg:  8000 },

  // ── Shivalingam ──────────────────────────────────────────────────────────
  { stone: "Haze Sunstone",      shape: "Shivalingam",     qty: 2, costPerKg: 20000 },
  { stone: "Malachite",          shape: "Shivalingam",     qty: 5, costPerKg: 13000 },

  // ── Mini Puffy Hearts ─────────────────────────────────────────────────────
  { stone: "Malachite Chrysocolla", shape: "Mini Puffy Hearts", qty: 3, costPerKg: 15000 },
  { stone: "Charoite",           shape: "Mini Puffy Hearts", qty: 3, costPerKg: 33000 },

  // ── Flatstone ────────────────────────────────────────────────────────────
  { stone: "Cobalto Calcite",    shape: "Flatstone",       qty: 3, costPerKg: 18000 },
  { stone: "Charoite",           shape: "Flatstone",       qty: 3, costPerKg: 33000 },
  { stone: "Ruby Zoisite",       shape: "Flatstone",       qty: 1, costPerKg: 23000 },
  { stone: "Hypersthene",        shape: "Flatstone",       qty: 3, costPerKg: 11000 },
  { stone: "Pink Rhodonite",     shape: "Flatstone",       qty: 5, costPerKg:  5500 },
  { stone: "Tanzanian Moonstone",shape: "Flatstone",       qty: 5, costPerKg:  7500 },
  { stone: "Blue Lace Agate",    shape: "Flatstone",       qty: 3, costPerKg: 16000 },

  // ── Puffy Mini Heart ──────────────────────────────────────────────────────
  { stone: "Ruby Zoisite",       shape: "Puffy Mini Heart", qty: 2, costPerKg: 23000 },

  // ── Mini Puffy Heart ─────────────────────────────────────────────────────
  { stone: "Thulite",            shape: "Mini Puffy Heart", qty: 3, costPerKg: 11500 },
];

// ── Main ──────────────────────────────────────────────────────────────────────
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

console.log("=".repeat(60));
console.log("GEMSTONES INFINITY — Buying Plan Restore");
console.log("=".repeat(60) + "\n");

// 1. Fetch current shows
const { data, error } = await supabase
  .from("app_data")
  .select("key,value")
  .eq("key", SHOWS_KEY)
  .single();

if (error) { console.error("ERROR:", error.message); process.exit(1); }

const shows = data?.value;
if (!Array.isArray(shows) || !shows.length) {
  console.error("No shows found in Supabase."); process.exit(1);
}

const denverIdx = shows.findIndex(s => s.id === DENVER_ID);
if (denverIdx < 0) {
  console.error(`Denver show (${DENVER_ID}) not found.`); process.exit(1);
}

const denver = shows[denverIdx];
const existing = denver.buyingPlan || [];
const giExisting = existing.filter(r =>
  (r.vendor || "").toUpperCase().includes("GEMSTONES INFINITY")
);

console.log(`Denver show found.`);
console.log(`Current buying plan: ${existing.length} rows total`);
console.log(`GEMSTONES INFINITY rows already present: ${giExisting.length}\n`);

// 2. Build a set of existing stone+shape keys (for GEMSTONES INFINITY only)
const existingKeys = new Set(
  giExisting.map(r => `${(r.stone||"").toLowerCase()}|${(r.shape||"").toLowerCase()}`)
);

// 3. Build new rows, skipping exact stone+shape duplicates
const toAdd = [];
const skipped = [];

for (const row of RECOVERED_ROWS) {
  const key = `${row.stone.toLowerCase()}|${row.shape.toLowerCase()}`;
  if (existingKeys.has(key)) {
    skipped.push(`  ⏭  SKIP (already exists): ${row.stone} · ${row.shape}`);
  } else {
    toAdd.push({
      id: uid(),
      stone: row.stone,
      shape: row.shape,
      vendor: VENDOR,
      qty: String(row.qty),
      unit: "kg",
      targetRate: "",
      currency: "INR",
      priority: "Medium",
      notes: "",
      notesAuto: false,
      costPerKg: String(row.costPerKg),
      targetSellPrice: "",
      targetSellPriceUsd: "",
      lastRate: "", lastVendor: "", lastDate: "", lastSource: "",
      createdAt: now(),
    });
  }
}

if (skipped.length) {
  console.log("Skipped (stone+shape already exists for GEMSTONES INFINITY):");
  skipped.forEach(s => console.log(s));
  console.log();
}

if (!toAdd.length) {
  console.log("✓ Nothing to restore — all 43 rows already exist. Done.");
  process.exit(0);
}

console.log(`Adding ${toAdd.length} row(s):`);
toAdd.forEach(r => console.log(`  +  ${r.stone} · ${r.shape}  (${r.qty} kg @ ₹${Number(r.costPerKg).toLocaleString("en-IN")})`));
console.log();

// 4. Merge and save
const updatedPlan = [...existing, ...toAdd];
const updatedShows = shows.map((s, i) =>
  i === denverIdx ? { ...s, buyingPlan: updatedPlan } : s
);

const { error: saveErr } = await supabase
  .from("app_data")
  .upsert({ key: SHOWS_KEY, value: updatedShows });

if (saveErr) {
  console.error("ERROR saving:", saveErr.message);
  process.exit(1);
}

console.log(`✅ Done! Denver buying plan now has ${updatedPlan.length} rows.`);
console.log(`   GEMSTONES INFINITY: ${giExisting.length} existing + ${toAdd.length} restored = ${giExisting.length + toAdd.length} rows.`);
console.log("\nRefresh the app in your browser to see the restored data.");
