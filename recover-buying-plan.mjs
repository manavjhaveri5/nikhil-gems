/**
 * Nikhil Gems — Buying Plan Recovery
 * Run on your Mac: node recover-buying-plan.mjs
 *
 * 1. Prints the current state of every show's buying plan in Supabase
 * 2. If a show has 0 lines, prints "EMPTY" so you know what's gone
 */

import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";

const SUPABASE_URL     = "https://bxnqnbspibvbnxbojrhe.supabase.co";
const SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ4bnFuYnNwaWJ2Ym54Ym9qcmhlIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzU0NTM3MywiZXhwIjoyMDg5MTIxMzczfQ.MiAPlsQgVryzW09cK7U-d5RBtaryVaEVdeefTKr-ykc";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

console.log("Fetching shows data from Supabase...\n");

const { data, error } = await supabase
  .from("app_data")
  .select("key,value,updated_at")
  .eq("key", "ng-shows-v1")
  .single();

if (error) {
  console.error("ERROR:", error.message);
  process.exit(1);
}

if (!data?.value || !Array.isArray(data.value) || data.value.length === 0) {
  console.log("❌ ng-shows-v1 is EMPTY or missing in Supabase.");
  console.log("   Last updated:", data?.updated_at || "unknown");
  console.log("\nChecking Supabase audit log / backups...");
  process.exit(1);
}

const shows = data.value;
console.log(`✓ Found ${shows.length} show(s). Last updated: ${data.updated_at}\n`);

let anyEmpty = false;
shows.forEach(show => {
  const bp = show.buyingPlan || [];
  const status = bp.length === 0 ? "❌ EMPTY" : `✓ ${bp.length} lines`;
  console.log(`  ${show.name} (${show.id}): ${status}`);
  if (bp.length > 0) {
    const stones = [...new Set(bp.map(r => r.stone).filter(Boolean))];
    console.log(`     Stones: ${stones.join(", ")}`);
    console.log(`     Vendors: ${[...new Set(bp.map(r=>r.vendor).filter(Boolean))].join(", ")}`);
  } else {
    anyEmpty = true;
  }
});

// Save full snapshot to desktop
const filename = `ng-shows-snapshot-${new Date().toISOString().slice(0,19).replace(/:/g,"-")}.json`;
const filepath = `${process.env.HOME}/Desktop/${filename}`;
writeFileSync(filepath, JSON.stringify(data.value, null, 2));
console.log(`\n📁 Full snapshot saved to: ${filepath}`);

if (anyEmpty) {
  console.log("\n⚠️  One or more shows have an empty buying plan in Supabase.");
  console.log("   Check your Desktop for NikhilGems-Backups/ folder for older snapshots.");
  console.log("   Or check Supabase Dashboard → Table Editor → app_data → ng-shows-v1");
}
