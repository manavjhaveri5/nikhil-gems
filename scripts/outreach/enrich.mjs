#!/usr/bin/env node
/* Reads each lead's own website (home, contact and about pages only, one request at a time
   per site) and pulls the public contact email, Instagram handle and stock signals.
   node scripts/outreach/enrich.mjs in.json out.json */
import { readFileSync, writeFileSync } from "node:fs";
const [inp, out] = process.argv.slice(2);
const leads = JSON.parse(readFileSync(inp, "utf8"));
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const BADMAIL = /\.(png|jpe?g|gif|webp|svg)$|example\.|sentry|wixpress|domain\.com|email\.com|@2x|godaddy|shopify\.com|squarespace|yourname|name@/i;
const SKIPIG = new Set(["p", "reel", "explore", "accounts", "stories", "instagram", "share", "tv"]);
const SIG = { spheres: /sphere|球|kugel/i, palm: /palm ?stone|worry stone|flat ?stone|handsmeichler/i, tumbled: /tumble|さざれ|trommel/i, hearts: /heart|ハート/i, towers: /tower|point|generator/i,
  himalayan: /himalayan|ヒマラヤ/i, zeolite: /apophyllite|zeolite|stilbite|okenite|cavansite/i, wholesale: /wholesale|trade account|卸/i, live: /live sale|whatnot|tiktok live|live show|ライブ/i, workshop: /workshop|reiki|sound bath|class/i };
const norm = u => { try { const x = new URL(/^https?:/.test(u) ? u : `https://${u}`); return x.origin; } catch { return ""; } };
async function page(u) {
  try { const r = await fetch(u, { headers: { "User-Agent": UA, "Accept-Language": "en,ja;q=0.8" }, redirect: "follow", signal: AbortSignal.timeout(12000) });
    if (!r.ok || !/html/.test(r.headers.get("content-type") || "")) return ""; return (await r.text()).slice(0, 800000); } catch { return ""; }
}
let i = 0;
for (const l of leads) {
  i++;
  const o = norm(l.website || "");
  if (!o || /etsy\.com|facebook\.com|instagram\.com|linktr\.ee/.test(o)) { if (/instagram\.com\/([^/?#]+)/.test(l.website || "")) l.instagram ||= RegExp.$1; continue; }
  const home = await page(o);
  if (!home) { l.site_ok = false; continue; }
  l.site_ok = true;
  const links = [...home.matchAll(/href=["']([^"'#]+)["']/gi)].map(m => m[1]);
  const extra = [...new Set(links.filter(h => /contact|about|wholesale|our-story|impressum|お問い合わせ|会社概要|特定商取引|tokushoho|legal/i.test(h))
    .map(h => { try { return new URL(h, o).href; } catch { return ""; } }).filter(h => h.startsWith(o)))].slice(0, 3);
  let html = home;
  for (const u of extra) html += await page(u);
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&amp;/g, " ").replace(/\s+/g, " ");
  const mails = [...new Set([...html.matchAll(/(?:mailto:)?([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi)].map(m => m[1].toLowerCase()).filter(m => !BADMAIL.test(m)))];
  const host = new URL(o).hostname.replace(/^www\./, "");
  mails.sort((a, b) => (b.endsWith(host) - a.endsWith(host)) || (/^(hello|info|shop|contact|wholesale|buying)/.test(b) - /^(hello|info|shop|contact|wholesale|buying)/.test(a)));
  if (!l.email && mails[0]) l.email = mails[0];
  l.emails = mails.slice(0, 4);
  const igs = [...html.matchAll(/instagram\.com\/([A-Za-z0-9._]{2,30})/gi)].map(m => m[1].replace(/\.$/, "")).filter(h => !SKIPIG.has(h.toLowerCase()));
  if (!l.instagram && igs[0]) l.instagram = igs[0];
  const fb = (html.match(/facebook\.com\/([A-Za-z0-9.\-]{3,60})/i) || [])[1]; if (fb && !l.facebook && !/sharer|plugins|tr$|dialog/.test(fb)) l.facebook = fb;
  l.signals = Object.entries(SIG).filter(([, re]) => re.test(text)).map(([k]) => k);
  l.platform = /cdn\.shopify|myshopify/.test(html) ? "shopify" : /squarespace/.test(html) ? "squarespace" : /wix\.com|wixstatic/.test(html) ? "wix" : /woocommerce|wp-content/.test(html) ? "woocommerce" : /base\.shop|thebase|stores\.jp|colorme/.test(html) ? "jp-cart" : "";
  l.title_tag = ((home.match(/<title[^>]*>([^<]{0,140})/i) || [])[1] || "").trim();
  l.desc = ((home.match(/name=["']description["'][^>]*content=["']([^"']{0,300})/i) || [])[1] || "").trim();
  if (i % 20 === 0) console.error(i, leads.length);
}
writeFileSync(out, JSON.stringify(leads, null, 1));
console.log("done", leads.length, "email", leads.filter(l => l.email).length, "ig", leads.filter(l => l.instagram).length);
