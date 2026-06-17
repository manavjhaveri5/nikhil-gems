/**
 * Nikhil Gems — Buying Plan Recovery
 * Run on your Mac: node recover-buying-plan.mjs
 *
 * 1. Prints the current state of every show's buying plan in Supabase
 * 2. Saves a snapshot JSON to ~/Desktop
 * 3. Checks Supabase WAL / soft-delete for any prior row versions
 */

import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const SUPABASE_URL     = "https://bxnqnbspibvbnxbojrhe.supabase.co";
const SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ4bnFuYnNwaWJ2Ym54Ym9qcmhlIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzU0NTM3MywiZXhwIjoyMDg5MTIxMzczfQ.MiAPlsQgVryzW09cK7U-d5RBtaryVaEVdeefTKr-ykc";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

console.log("=".repeat(60));
console.log("Nikhil Gems — Buying Plan Recovery");
console.log("=".repeat(60) + "\n");

// ── 1. Current state ──────────────────────────────────────────────
console.log("Fetching current shows data from Supabase...\n");

const { data, error } = await supabase
  .from("app_data")
  .select("key,value,updated_at")
  .eq("key", "ng-shows-v1")
  .single();

if (error) {
  console.error("ERROR fetching ng-shows-v1:", error.message);
  process.exit(1);
}

if (!data?.value || !Array.isArray(data.value) || data.value.length === 0) {
  console.log("❌ ng-shows-v1 is EMPTY or missing in Supabase.");
  process.exit(1);
}

const shows = data.value;
console.log(`✓ Found ${shows.length} show(s). Last updated: ${data.updated_at}\n`);

let anyEmpty = false;
for (const show of shows) {
  const bp = show.buyingPlan || [];
  const giRows = bp.filter(r => (r.vendor || "").toUpperCase().includes("GEMSTONES INFINITY"));
  const status = bp.length === 0 ? "❌ EMPTY" : `✓ ${bp.length} lines`;
  const giNote = giRows.length ? ` (${giRows.length} GEMSTONES INFINITY rows)` : "";
  console.log(`  ${show.name} (${show.id}): ${status}${giNote}`);
  if (bp.length > 0) {
    const vendors = [...new Set(bp.map(r => r.vendor).filter(Boolean))];
    const stones  = [...new Set(bp.map(r => r.stone).filter(Boolean))];
    console.log(`     Vendors: ${vendors.join(", ")}`);
    console.log(`     Stones:  ${stones.join(", ")}`);
    if (giRows.length) {
      const giStones = [...new Set(giRows.map(r => r.stone).filter(Boolean))];
      console.log(`     GI stones: ${giStones.join(", ")}`);
    }
  } else {
    anyEmpty = true;
  }
  console.log();
}

// ── 2. Save snapshot ──────────────────────────────────────────────
const filename = `ng-shows-snapshot-${new Date().toISOString().slice(0,19).replace(/:/g,"-")}.json`;
const filepath = join(homedir(), "Desktop", filename);
try {
  writeFileSync(filepath, JSON.stringify(data.value, null, 2));
  console.log(`📁 Snapshot saved to: ${filepath}\n`);
} catch (e) {
  console.warn("Could not save to Desktop:", e.message);
}

// ── 3. Check Supabase audit / history table ───────────────────────
console.log("Checking for audit/history records...");
// Supabase doesn't expose WAL directly but some setups log to a history table.
// Try common names — safe to fail.
const historyAttempts = [
  { table: "app_data_history", filter: { key: "ng-shows-v1" } },
  { table: "_app_data_log",    filter: { key: "ng-shows-v1" } },
  { table: "audit_log",        filter: {} },
];

let foundHistory = false;
for (const { table, filter } of historyAttempts) {
  let q = supabase.from(table).select("*").order("recorded_at", { ascending: false }).limit(5);
  if (filter.key) q = q.eq("key", filter.key);
  const { data: hd, error: he } = await q;
  if (!he && hd && hd.length > 0) {
    console.log(`\n✓ Found history in '${table}':`);
    hd.forEach(r => console.log("  ", JSON.stringify(r).slice(0, 120) + "..."));
    foundHistory = true;
    break;
  }
}

if (!foundHistory) {
  console.log("  No history/audit table found (standard Supabase free/pro — no WAL replay).");
  console.log("\n💡 Recovery options:");
  console.log("   1. Supabase Dashboard → Project Settings → Backups");
  console.log("      (Point-in-time recovery available on Pro+ plans)");
  console.log("   2. Check your browser's localStorage:");
  console.log("      Open Chrome/Safari DevTools → Application → Local Storage");
  console.log("      Look for key: ng-sb-cache-v1");
  console.log("      The buying plan rows may still be cached there from before the loss.");
  console.log("\n   3. Run the browser console snippet from BROWSER_RECOVERY.md");
}

if (anyEmpty) {
  console.log("\n⚠️  One or more shows have an EMPTY buying plan in Supabase.");
}
