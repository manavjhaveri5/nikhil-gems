#!/usr/bin/env node
/* Takes Tokyo Mineral Show exhibitors off the outreach list: they are fellow dealers at the
   show and already know Nikhil Gems (Sir, 21 Nov 2026). Leads never contacted are removed
   (soft delete); any that were already emailed are left as they are and listed.
   node scripts/outreach/drop-exhibitors.mjs <exhibitors.json> [--dry]
   exhibitors.json: [{ name, website?, email? }] from the show's exhibitor pages. */
import { readFileSync } from "node:fs";
import { supa, rows } from "../raj/raj-common.mjs";
const [file, flag] = process.argv.slice(2);
const ex = JSON.parse(readFileSync(file, "utf8"));
const host = u => { try { return new URL(/^https?:/.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };
const FREE = /^(gmail|yahoo|hotmail|outlook|icloud|me|nifty)\./;
const norm = n => String(n || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const keys = new Set();
for (const e of ex) {
  const h = host(e.website || ""); if (h && !/lit\.link|instagram|linktr|facebook|ameblo|base\.shop|thebase|stores\.jp|creema|minne/.test(h)) keys.add(h);
  const m = String(e.email || "").toLowerCase(); if (m) { keys.add(m); const d = m.split("@")[1]; if (d && !FREE.test(d)) keys.add(d); }
  if (norm(e.name).length >= 4) keys.add(`n:${norm(e.name)}`);
}
const sb = supa();
const leads = await rows(sb, "outreach-leads-v1");
const hit = leads.filter(l => { const m = String(l.email || "").toLowerCase();
  return keys.has(host(l.website || "")) || keys.has(m) || keys.has(m.split("@")[1]) || keys.has(`n:${norm(l.name)}`); });
const untouched = hit.filter(l => (l.stage || "new") === "new" && !(l.history || []).some(h => /^sent|^followup/.test(h.what)));
const contacted = hit.filter(l => !untouched.includes(l));
console.log(`exhibitors on the list: ${hit.length}, never contacted: ${untouched.length}, already contacted: ${contacted.length}`);
for (const l of contacted) console.log("  contacted:", l.name, l.email, l.stage);
if (flag !== "--dry") for (const l of untouched) {
  const { error } = await sb.from("app_rows").update({ deleted: true }).eq("key", "outreach-leads-v1").eq("id", l.id);
  if (error) throw new Error(error.message);
}
console.log(flag === "--dry" ? "dry run" : `removed ${untouched.length}`);
