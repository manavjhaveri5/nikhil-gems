#!/usr/bin/env node
/* Finds small and mid-sized crystal shops on Etsy that ship from the target countries, through
   Etsy's public Open API (read only). They are resellers who already buy spheres, palm stones,
   hearts and tumbles, so they are the best fit for buying by the kilo.
   Etsy's rules forbid unsolicited sales messages through Etsy Conversations, so contact is made
   only through a website, email or Instagram the shop publishes itself.
   node scripts/outreach/find-etsy.mjs out.json [US,GB,AU,NZ,JP,DE,NL,FR,IT,ES,IE,CA] */
import { writeFileSync } from "node:fs";
import { loadEnv } from "../raj/raj-common.mjs";
const [out = "etsy.json", cc = "US,GB,AU,NZ,JP,TW,DE,NL,FR,IT,ES,IE,BE,AT,CH,SE,DK,CA"] = process.argv.slice(2);
const TARGET = new Set(cc.split(","));
const e = loadEnv(), key = e.ETSY_KEYSTRING || e.ETSY_API_KEY;
const H = { "x-api-key": e.ETSY_SHARED_SECRET ? `${key}:${e.ETSY_SHARED_SECRET}` : key };
const sleep = ms => new Promise(r => setTimeout(r, ms));
// The ERP shares this Etsy app key (listing sync, Raj's audit). Etsy allows 5,000 requests a day;
// on 18 Nov 2026 this script used them all and locked the ERP out of Etsy for hours. Never again:
// stop while at least RESERVE requests remain for the ERP.
const RESERVE = 2500;
let left = Infinity;
const guard = r => { const v = +r.headers.get("x-remaining-today"); if (Number.isFinite(v)) left = v; if (left < RESERVE) throw new Error(`Etsy daily budget: only ${left} requests left, stopping to leave ${RESERVE} for the ERP`); };
const get = async u => { for (let i = 0; i < 3; i++) { let r; try { r = await fetch(`https://openapi.etsy.com/v3/application/${u}`, { headers: H, signal: AbortSignal.timeout(15000) }); } catch { await sleep(1000); continue; } if (r.status === 429) {
    // 5-a-second limit: wait and try again. Daily limit (long Retry-After or nothing left today): stop.
    const wait = +r.headers.get("retry-after") || 0, rem = +r.headers.get("x-remaining-today");
    if (wait <= 5 && !(Number.isFinite(rem) && rem < RESERVE)) { await sleep(1500 + wait * 1000); continue; }
    throw new Error("Etsy daily rate limit hit: stop");
  } guard(r); return r.ok ? r.json() : null; } return null; };
const KW = ["crystal sphere", "palm stone crystal", "tumbled stones", "crystal heart carving", "crystal tower", "raw crystal", "healing crystals", "crystal shop", "himalayan quartz", "crystal bowl gemstone",
  "lepidolite", "rose quartz sphere", "moonstone palm stone", "crystal worry stone", "chakra crystals set", "apophyllite", "zeolite cluster", "rhodonite", "malachite sphere", "mini crystal hearts", "crystal wand", "crystal pyramid", "crystal mystery box", "bulk crystals"];
const shops = new Map();
try { for (const k of KW) for (let off = 0; off < 300; off += 100) {
  const j = await get(`listings/active?keywords=${encodeURIComponent(k)}&limit=100&offset=${off}&sort_on=score`);
  for (const l of j?.results || []) shops.set(l.shop_id, (shops.get(l.shop_id) || 0) + 1);
  await sleep(150);
} } catch (err) { console.error(String(err.message || err)); }
console.error("shops seen", shops.size);
const keep = [];
let n = 0;
const ids = [...shops.keys()].sort((a, b) => shops.get(b) - shops.get(a)); // best-matching shops first, in case the budget runs out
async function check(id) {
  const hits = shops.get(id);
  const s = await get(`shops/${id}`);
  if (++n % 200 === 0) console.error(n, keep.length);
  if (!s || s.is_vacation) return;
  const from = s.shipping_from_country_iso || s.shop_location_country_iso;
  if (!TARGET.has(from) || ["CN", "IN", "HK", "PK", "BR", "TH"].includes(s.shipping_from_country_iso)) return;
  if ((s.transaction_sold_count || 0) < 100 || s.transaction_sold_count > 60000 || (s.listing_active_count || 0) < 15) return;
  const text = [s.title, s.announcement, s.policy_seller_info, s.policy_additional, s.sale_message].filter(Boolean).join("\n");
  const ig = (text.match(/(?:instagram\.com\/|@)([A-Za-z0-9._]{3,30})/i) || [])[1] || "";
  const email = (text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i) || [])[0] || "";
  const site = (text.match(/https?:\/\/(?!www\.etsy|etsy\.|instagram|facebook|tiktok)[^\s)"'<>]+/i) || [])[0] || "";
  keep.push({ source: "etsy", country: from, name: s.shop_name, etsy_url: `https://www.etsy.com/shop/${s.shop_name}`, title: s.title || "", sold: s.transaction_sold_count,
    listings: s.listing_active_count, favs: s.num_favorers, reviews: s.review_count, rating: s.review_average, hits, since: new Date(s.create_date * 1000).toISOString().slice(0, 7),
    instagram: /^(gmail|yahoo|hotmail|outlook|icloud)/i.test(ig) ? "" : ig, email, website: site, blurb: String(s.announcement || "").slice(0, 400) });
}
// 4 at a time with a short pause: well under Etsy's 10 requests a second.
try { for (let i = 0; i < ids.length; i += 3) { await Promise.all(ids.slice(i, i + 3).map(check)); await sleep(1000); } } catch (err) { console.error(String(err.message || err), "· saving", keep.length, "shops found so far"); }
keep.sort((a, b) => b.hits - a.hits || b.sold - a.sold);
writeFileSync(out, JSON.stringify(keep, null, 1));
const by = {}; for (const k of keep) by[k.country] = (by[k.country] || 0) + 1;
console.log(keep.length, JSON.stringify(by), "ig", keep.filter(k => k.instagram).length, "site", keep.filter(k => k.website).length, "email", keep.filter(k => k.email).length);
