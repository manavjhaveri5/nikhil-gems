/**
 * migrate-videos.mjs — uploads the 3 remaining large videos to Supabase
 * and rewrites their URLs in app_data.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "fs";

const env = {};
try {
  for (const line of readFileSync(".env.local", "utf-8").split("\n")) {
    const m = line.match(/^([^#=\s][^=]*)=(.+)$/);
    if (m) env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
} catch {}

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || env.VITE_SUPABASE_URL;
const SERVICE_KEY  = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ4bnFuYnNwaWJ2Ym54Ym9qcmhlIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzU0NTM3MywiZXhwIjoyMDg5MTIxMzczfQ.MiAPlsQgVryzW09cK7U-d5RBtaryVaEVdeefTKr-ykc";
const BUCKET       = "ng-media";
const VERCEL_BASE  = "https://uha1i56xojimnx6c.public.blob.vercel-storage.com";

const VIDEOS = [
  "videos/palmstone/bslr92jxx-kunzite.mp4",
  "stock/c8d4ceaf-video.mov",
  "stock/0e909e8e-video.mov",
];

const sb = createClient(SUPABASE_URL, SERVICE_KEY);

async function uploadVideo(pathname) {
  const vercelUrl = `${VERCEL_BASE}/${pathname}`;
  const supaUrl   = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${pathname}`;

  console.log(`\nDownloading ${pathname}...`);
  const res = await fetch(vercelUrl);
  if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status}`);

  const total = parseInt(res.headers.get("content-length") || "0");
  console.log(`  Size: ${(total / 1024 / 1024).toFixed(1)} MB`);

  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`  Downloaded. Uploading to Supabase...`);

  const ct = res.headers.get("content-type") || "video/mp4";
  const { error } = await sb.storage.from(BUCKET).upload(pathname, buf, {
    contentType: ct,
    upsert: true,
  });
  if (error) throw new Error(`Supabase upload: ${error.message}`);

  console.log(`  ✓ Uploaded → ${supaUrl}`);
  return { vercelUrl, supaUrl };
}

async function main() {
  const urlMap = {};

  for (const v of VIDEOS) {
    try {
      const { vercelUrl, supaUrl } = await uploadVideo(v);
      urlMap[vercelUrl] = supaUrl;
    } catch (e) {
      console.error(`  ✗ ${v} — ${e.message}`);
    }
  }

  if (!Object.keys(urlMap).length) {
    console.error("\nNo videos uploaded — aborting DB update.");
    process.exit(1);
  }

  console.log("\nUpdating database...");
  const { data: rows, error } = await sb.from("app_data").select("key, value");
  if (error) throw new Error("DB read: " + error.message);

  for (const row of rows) {
    let str = JSON.stringify(row.value);
    if (!str.includes("vercel-storage.com")) continue;
    let updated = str;
    for (const [old, neu] of Object.entries(urlMap)) updated = updated.replaceAll(old, neu);
    if (updated === str) continue;
    const { error: we } = await sb.from("app_data").update({ value: JSON.parse(updated) }).eq("key", row.key);
    if (we) console.error(`  ✗ DB ${row.key}: ${we.message}`);
    else console.log(`  ✓ DB: ${row.key} updated`);
  }

  console.log("\n✅ Videos migrated and database updated.");
}

main().catch(e => { console.error(e); process.exit(1); });
