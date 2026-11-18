#!/usr/bin/env node
/* Writes wholesale outreach leads to the ERP (app_rows outreach-leads-v1).
   Nothing here emails or messages anyone: Sejal sends by hand from the Outreach page.
   node scripts/outreach/outreach-push.mjs leads <file.json> [--dry]
     [ { id?, name, country, segment, tier: A|B|C, score, channel, language, website?, email?, instagram?,
         etsy_url?, city?, signals?, why, draft: { subject, body }, dm?, followups?: [ { day, body } ] } ... ]
   Re-pushing a lead updates its research and drafts but keeps Sejal's stage, dates and notes. */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { supa, rows, upsert } from "../raj/raj-common.mjs";
export const OKEY = "outreach-leads-v1";
export const STAGES = ["new", "sent", "followed_up", "replied", "talking", "sample", "customer", "no", "bounced", "skip"];
const KEEP = ["stage", "sent_at", "sent_via", "next_followup", "followups_sent", "replied_at", "note", "history"];
const [cmd, file, flag] = process.argv.slice(2);
if (cmd !== "leads") throw new Error("usage: leads <file.json> [--dry]");
const data = JSON.parse(readFileSync(file, "utf8"));
const sb = supa(), now = new Date().toISOString();
const old = new Map((await rows(sb, OKEY)).map(r => [r.id, r]));
const domain = u => { try { return new URL(/^https?:/.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, ""); } catch { return ""; } };
let added = 0, updated = 0;
for (const l of data) {
  for (const k of ["name", "country", "segment", "tier", "why", "draft"]) if (!l[k]) throw new Error(`${l.name}: needs ${k}`);
  const id = l.id || `lead-${createHash("sha1").update((domain(l.website) || l.instagram || l.etsy_url || l.name).toLowerCase()).digest("hex").slice(0, 10)}`;
  const prev = old.get(id);
  const item = { ...l, id, created_at: prev?.created_at || now, updated_at: now };
  for (const k of KEEP) if (prev?.[k] != null) item[k] = prev[k];
  item.stage ||= "new";
  if (flag !== "--dry") await upsert(sb, OKEY, item, false);
  prev ? updated++ : added++;
}
console.log(JSON.stringify({ added, updated, total: old.size + added, dry: flag === "--dry" }));
