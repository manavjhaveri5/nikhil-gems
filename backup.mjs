#!/usr/bin/env node
// Nikhil Gems — weekly data backup
// Fetches all app_data from Supabase and saves a timestamped JSON to ~/Desktop/NikhilGems-Backups/

import { createClient } from "@supabase/supabase-js";
import { writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const SUPABASE_URL      = "https://bxnqnbspibvbnxbojrhe.supabase.co";
const SERVICE_ROLE_KEY  = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ4bnFuYnNwaWJ2Ym54Ym9qcmhlIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzU0NTM3MywiZXhwIjoyMDg5MTIxMzczfQ.MiAPlsQgVryzW09cK7U-d5RBtaryVaEVdeefTKr-ykc";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const BACKUP_DIR = join(homedir(), "Desktop", "NikhilGems-Backups");
mkdirSync(BACKUP_DIR, { recursive: true });

const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const filename  = `backup-${timestamp}.json`;
const filepath  = join(BACKUP_DIR, filename);

console.log(`[Nikhil Gems Backup] Starting at ${new Date().toLocaleString("en-IN")}...`);

const { data, error } = await supabase
  .from("app_data")
  .select("key, value");

if (error) {
  console.error("[Backup FAILED]", error.message);
  process.exit(1);
}

const backup = {
  createdAt: new Date().toISOString(),
  rowCount:  data.length,
  data
};

writeFileSync(filepath, JSON.stringify(backup, null, 2), "utf8");

const sizeMB = (Buffer.byteLength(JSON.stringify(backup), "utf8") / 1024 / 1024).toFixed(2);
console.log(`[Backup OK] ${data.length} records · ${sizeMB} MB → ${filepath}`);

// Keep only last 12 backups (3 months), delete older ones
import { readdirSync, statSync, unlinkSync } from "fs";
const files = readdirSync(BACKUP_DIR)
  .filter(f => f.startsWith("backup-") && f.endsWith(".json"))
  .map(f => ({ name: f, time: statSync(join(BACKUP_DIR, f)).mtimeMs }))
  .sort((a, b) => b.time - a.time);

files.slice(12).forEach(f => {
  unlinkSync(join(BACKUP_DIR, f.name));
  console.log(`[Cleanup] Removed old backup: ${f.name}`);
});
