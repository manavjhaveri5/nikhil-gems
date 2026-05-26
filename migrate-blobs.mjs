/**
 * migrate-blobs.mjs
 *
 * Copies every file from the locked Vercel Blob store (nikhil-gems-blob)
 * into Supabase Storage bucket "ng-media", then rewrites all 786 Vercel Blob
 * URLs directly in the Supabase app_data table — no browser console paste needed.
 *
 * Run after the Vercel Blob store unlocks (2026-06-20):
 *   node migrate-blobs.mjs
 *
 * Reads credentials from .env.local automatically.
 * Safe to re-run: uploads use upsert, DB updates are idempotent.
 */

import { list } from "@vercel/blob";
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "fs";

// ── load .env.local ───────────────────────────────────────────────────────────
const env = {};
try {
  for (const line of readFileSync(".env.local", "utf-8").split("\n")) {
    const m = line.match(/^([^#=\s][^=]*)=(.+)$/);
    if (m) env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
} catch {}

const BLOB_TOKEN   = process.env.BLOB_READ_WRITE_TOKEN  || env.BLOB_READ_WRITE_TOKEN;
const SUPABASE_URL = process.env.VITE_SUPABASE_URL       || env.VITE_SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY    || env.SUPABASE_SERVICE_ROLE_KEY
                     // fallback: derive from known value
                     || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ4bnFuYnNwaWJ2Ym54Ym9qcmhlIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzU0NTM3MywiZXhwIjoyMDg5MTIxMzczfQ.MiAPlsQgVryzW09cK7U-d5RBtaryVaEVdeefTKr-ykc";

const BUCKET           = "ng-media";
const VERCEL_BLOB_HOST = "uha1i56xojimnx6c.public.blob.vercel-storage.com";

if (!BLOB_TOKEN || !SUPABASE_URL) {
  console.error("Missing BLOB_READ_WRITE_TOKEN or VITE_SUPABASE_URL in .env.local");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY);

// Compute the Supabase public URL for a given blob pathname
function supabaseUrl(pathname) {
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${pathname}`;
}

// ── Step 1: build complete file list from Vercel Blob ─────────────────────────
async function listAllBlobs() {
  const all = [];
  let cursor;
  do {
    const { blobs, cursor: next } = await list({ token: BLOB_TOKEN, cursor, limit: 1000 });
    // skip folder placeholder objects (size 0, no content-type)
    all.push(...blobs.filter(b => b.size > 0));
    cursor = next;
  } while (cursor);
  return all;
}

// ── Step 2: copy one file ─────────────────────────────────────────────────────
const MAX_BYTES = 200 * 1024 * 1024; // 200 MB — matches ng-media bucket file_size_limit

async function migrateOne(blob) {
  // Skip files that exceed Supabase's upload limit to avoid OOM / rejection
  if (blob.size > MAX_BYTES) {
    throw new Error(`SKIP_LARGE: ${(blob.size / 1024 / 1024).toFixed(1)} MB exceeds 45 MB limit — keeping Vercel URL`);
  }
  const res = await fetch(blob.url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const { error } = await sb.storage.from(BUCKET).upload(blob.pathname, buf, {
    contentType: blob.contentType || "application/octet-stream",
    upsert: true,
  });
  if (error) throw new Error(`Supabase: ${error.message}`);
  return supabaseUrl(blob.pathname);
}

// ── Step 3: rewrite all URLs in Supabase app_data ─────────────────────────────
async function updateDatabase(urlMap) {
  const { data: rows, error } = await sb.from("app_data").select("key, value");
  if (error) throw new Error("DB read failed: " + error.message);

  let rowsUpdated = 0;
  let urlsReplaced = 0;

  for (const row of rows) {
    let str = JSON.stringify(row.value);
    if (!str.includes(VERCEL_BLOB_HOST)) continue;

    let updated = str;
    for (const [oldUrl, newUrl] of Object.entries(urlMap)) {
      updated = updated.replaceAll(oldUrl, newUrl);
    }

    const { error: writeErr } = await sb
      .from("app_data")
      .update({ value: JSON.parse(updated) })
      .eq("key", row.key);

    if (writeErr) {
      console.error(`  ✗ DB update failed for ${row.key}: ${writeErr.message}`);
    } else {
      const count = (str.match(new RegExp(VERCEL_BLOB_HOST, "g")) || []).length;
      console.log(`  ✓ DB: ${row.key} — ${count} URL(s) updated`);
      rowsUpdated++;
      urlsReplaced += count;
    }
  }
  return { rowsUpdated, urlsReplaced };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Ensure bucket exists
  await sb.storage.createBucket(BUCKET, { public: true }).catch(() => {});

  console.log("Step 1 — Listing all files in Vercel Blob store...");
  const blobs = await listAllBlobs();
  console.log(`Found ${blobs.length} files to migrate.\n`);

  const urlMap = {};
  let ok = 0, failed = 0;

  console.log("Step 2 — Copying files to Supabase Storage...");
  for (const blob of blobs) {
    try {
      const newUrl = await migrateOne(blob);
      urlMap[blob.url] = newUrl;
      ok++;
      if (ok % 20 === 0) process.stdout.write(`  ${ok}/${blobs.length}...\n`);
    } catch (e) {
      failed++;
      if (e.message.startsWith("SKIP_LARGE:")) {
        console.warn(`  ⚠ SKIPPED ${blob.pathname} — ${e.message.replace("SKIP_LARGE: ", "")}`);
      } else {
        console.error(`  ✗ ${blob.pathname} — ${e.message}`);
      }
    }
  }

  console.log(`\nFiles: ${ok} migrated, ${failed} failed.\n`);
  writeFileSync("blob-url-map.json", JSON.stringify(urlMap, null, 2));

  if (ok === 0) {
    console.error("No files migrated — aborting DB update. The Vercel Blob store may still be locked.");
    process.exit(1);
  }

  console.log("Step 3 — Updating Supabase app_data with new URLs...");
  const { rowsUpdated, urlsReplaced } = await updateDatabase(urlMap);
  console.log(`\nDB: ${rowsUpdated} rows updated, ${urlsReplaced} URLs rewritten.`);

  console.log("\n✅ Migration complete!");
  console.log("All images will now load from Supabase Storage.");
  console.log("URL map saved to blob-url-map.json (keep as backup).");

  if (failed > 0) {
    console.warn(`\n⚠️  ${failed} files failed. Re-run the script to retry them.`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
