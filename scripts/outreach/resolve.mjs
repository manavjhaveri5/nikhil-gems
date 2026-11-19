#!/usr/bin/env node
/* Finds the website of a named shop by trying likely domains. A domain is kept only when its
   page title or description contains the shop's name words and a crystal-shop word.
   node scripts/outreach/resolve.mjs seed.json out.json */
import { readFileSync, writeFileSync } from "node:fs";
const [inp, out] = process.argv.slice(2);
const seeds = JSON.parse(readFileSync(inp, "utf8"));
const TLD = { CA: [".ca", ".com"], FR: [".fr", ".com"], IT: [".it", ".com"], ES: [".es", ".com"], BE: [".be", ".com"], AT: [".at", ".com"], CH: [".ch", ".com"], SE: [".se", ".com"], DK: [".dk", ".com"], US: [".com"], GB: [".co.uk", ".com", ".uk"], AU: [".com.au", ".com"], NZ: [".co.nz", ".nz", ".com"], DE: [".de", ".com"], JP: [".jp", ".com", ".co.jp"], TW: [".tw", ".com.tw", ".com"], NL: [".nl", ".com"], IE: [".ie", ".com"] };
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const CRYS = /crystal|mineral|gem|stone|metaphysical|spiritual|tarot|witch|healing|fossil|kristall|edelstein|天然石|パワーストーン/i;
async function head(u) { try { const r = await fetch(u, { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(9000) }); if (!r.ok) return ""; return (await r.text()).slice(0, 200000); } catch { return ""; } }
for (const s of seeds) {
  if (s.website || s.email || s.instagram) continue;
  const words = s.name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter(Boolean);
  const core = words.filter(w => !["the", "and", "of", "shop"].includes(w));
  const slugs = [...new Set([words.join(""), core.join(""), words.join("-"), core.join("") + "s", core.join("") + "shop", core.join("") + (s.city ? s.city.toLowerCase().replace(/[^a-z]/g, "") : "")])];
  for (const sl of slugs) { let hit = "";
    for (const t of TLD[s.country] || [".com"]) {
      const html = await head(`https://www.${sl}${t}`) || await head(`https://${sl}${t}`);
      if (!html) continue;
      const meta = ((html.match(/<title[^>]*>([^<]*)/i) || [])[1] || "") + " " + ((html.match(/name=["']description["'][^>]*content=["']([^"']*)/i) || [])[1] || "");
      const m = meta.toLowerCase().replace(/&amp;/g, "and");
      if (core.every(w => m.includes(w) || m.replace(/\s/g, "").includes(w)) && CRYS.test(meta)) { hit = `https://${sl}${t}`; break; }
    }
    if (hit) { s.website = hit; break; } }
  if (s.website) console.error(s.name, "→", s.website);
}
writeFileSync(out, JSON.stringify(seeds.map(s => ({ source: "web", ...s })), null, 1));
// (etsy candidates keep source "etsy" because the spread puts theirs last)
console.log("resolved", seeds.filter(s => s.website).length, "/", seeds.length);
