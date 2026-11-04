/* Raj's listing audit — every listing on every channel, checked each morning.

   The kind of thing that once took a human noticing (eBay pieces filed under
   Pottery & Glass > Figurines; an amethyst tag on a rose quartz sphere; a piece
   sold on Etsy still live on the store) is a rule here, run on the whole
   catalogue every day. Runs from Postgres at 07:30 IST (listing-manager action
   raj_audit) before the 07:45 snapshot, which carries its summary into the
   briefing.

   Output, in app_rows key raj-audit-v1:
   - one row per check and channel (id "check|channel"): what's wrong, why it
     matters, the fix, and every listing it applies to. Each item keeps the day
     it was first seen; items that disappear are recorded as resolved, so Raj
     can tell what got fixed and, a week later, whether the fix helped.
   - one "summary" row: counts, new and resolved today, and the sales
     investigation (demand gaps, high-attention pieces that don't sell, what
     converts, listing cadence).

   Nothing here changes a listing. Fixes are Sir's call. */

import { readRows, upsertRow } from "./app-rows.js";
import { ETSY_CATEGORIES, inferCategoryValue, sectionIdForCategory } from "./listingCategories.js";
import { ebayCategoryFor } from "../api/ebay.js";

export const AUDIT_KEY = "raj-audit-v1";
const IST = 5.5 * 3600e3;
const istDay = ms => new Date(ms + IST).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const r2 = x => Math.round((+x || 0) * 100) / 100;

/* ── Stones: what a title, tag or material is talking about ──────────────── */
const STONE_LIST = `rose quartz|clear quartz|smoky quartz|rutilated quartz|tourmalinated quartz|strawberry quartz|lemon quartz|blue quartz|spirit quartz|quartz|
amethyst|chevron amethyst|citrine|ametrine|moss agate|blue lace agate|crazy lace agate|dendritic agate|fire agate|tree agate|agate|carnelian|
ocean jasper|red jasper|picture jasper|kambaba jasper|jasper|mookaite|bloodstone|labradorite|larvikite|moonstone|sunstone|rainbow fluorite|fluorite|
pyrite|hematite|snowflake obsidian|rainbow obsidian|black obsidian|obsidian|tiger's eye|tigers eye|tiger eye|black tourmaline|pink tourmaline|tourmaline|
selenite|satin spar|optical calcite|orange calcite|mangano calcite|honey calcite|calcite|green aventurine|aventurine|nephrite|jade|malachite|azurite|
chrysocolla|lapis lazuli|lapis|sodalite|turquoise|howlite|amazonite|aquamarine|apatite|kyanite|garnet|ruby zoisite|zoisite|ruby|emerald|sapphire|
peridot|chrysoprase|prehnite|epidote|unakite|rhodonite|rhodochrosite|lepidolite|kunzite|morganite|celestite|celestine|angelite|shungite|septarian|
chalcedony|onyx|serpentine|spinel|tanzanite|opal|ammonite|petrified wood|seraphinite|sugilite|charoite|dumortierite|iolite|cuprite|apophyllite|
stilbite|okenite|heulandite|mesolite|scolecite|natrolite|cavansite|gyrolite|zeolite|chalcopyrite|bornite|magnetite|vanadinite|wulfenite|aragonite|
dolomite|barite|gypsum|desert rose|sphalerite|galena|mica|muscovite|lodolite|kambaba|shiva lingam|shivling|lingam|gaspeite|variscite|blue apatite|
golden healer|rhyolite|tektite|moldavite|thulite|smithsonite|hemimorphite|pietersite|astrophyllite|aegirine|bronzite|covellite|nuummite`.split(/\s*\|\s*/).filter(Boolean)
  .sort((a, b) => b.length - a.length);
const STONE_RE = new RegExp(`\\b(${STONE_LIST.map(s => s.replace(/[.*+?^${}()|[\]\\']/g, m => m === "'" ? "'?" : "\\" + m)).join("|")})\\b`, "gi");
const SYN = { "tigers eye": "tiger eye", "tiger's eye": "tiger eye", lapis: "lapis lazuli", celestine: "celestite", nephrite: "jade", kambaba: "kambaba jasper",
  shivling: "shiva lingam", lingam: "shiva lingam", "chevron amethyst": "amethyst" };
const FAMILY_WORDS = ["quartz", "agate", "jasper", "calcite", "obsidian", "fluorite", "tourmaline", "aventurine", "amethyst", "apatite", "zoisite"];
// Zeolites and their usual companions come as one specimen.
const ZEOLITE = new Set(["apophyllite", "stilbite", "okenite", "heulandite", "mesolite", "scolecite", "natrolite", "cavansite", "gyrolite", "zeolite"]);
const canon = s => SYN[s.toLowerCase().replace("’", "'")] || s.toLowerCase().replace("’", "'");
const family = s => ZEOLITE.has(s) ? "zeolite" : FAMILY_WORDS.find(w => s.endsWith(w)) || s;
export function stonesIn(text) {
  const out = new Set();
  for (const m of String(text || "").matchAll(STONE_RE)) out.add(canon(m[1]));
  return out;
}
const MIXED = /\b(chakra|assorted|mixed|mix|lot of|set of|bundle|kit|variety|7 stones|seven stones|birthstone)\b/i;

/* ── Findings ────────────────────────────────────────────────────────────── */
const CHECKS = {
  // Etsy
  etsy_tag_wrong_stone: { sev: "high", kind: "problem", title: "Tags name a different stone", why: "Etsy shows the listing to people searching for the wrong stone; they click, don't buy, and Etsy ranks the listing lower.", fix: "Replace those tags with the right stone's tags." },
  etsy_tags_missing: { sev: "medium", kind: "problem", title: "Fewer than 13 tags", why: "Every unused tag is a search phrase the listing can't be found by.", fix: "Fill all 13 tags with buyer search phrases." },
  etsy_tags_duplicate: { sev: "low", kind: "problem", title: "Duplicate tags", why: "A repeated tag wastes a slot.", fix: "Swap duplicates for new phrases." },
  etsy_category_mismatch: { sev: "medium", kind: "problem", title: "Etsy category differs from the ERP's rule", why: "The wrong category hides a listing from category browsing and filters, like the eBay Figurines problem.", fix: "Check the category; move it if the rule is right." },
  etsy_section_missing: { sev: "medium", kind: "problem", title: "Not in a shop section", why: "Shoppers browsing the shop's sections never see it.", fix: "Put it in its section." },
  etsy_section_mismatch: { sev: "low", kind: "problem", title: "In a different section than its shape suggests", why: "A sphere under Tumbled Stones is hard to find in the shop.", fix: "Check the section." },
  etsy_title_no_stone: { sev: "medium", kind: "problem", title: "Title doesn't name the stone", why: "Most buyers search by stone name.", fix: "Put the stone name early in the title." },
  etsy_photos_few: { sev: "medium", kind: "problem", title: "Fewer than 5 photos", why: "Listings with more photos convert better; buyers want scale, back and detail shots.", fix: "Add photos up to 10." },
  etsy_no_video: { sev: "low", kind: "problem", title: "No video", why: "Etsy favours listings with video in search and the video shows the shine.", fix: "Add a short video when it's next photographed." },
  etsy_materials_missing: { sev: "low", kind: "problem", title: "No materials listed", why: "Materials feed Etsy's search and filters.", fix: "Add the stone as a material." },
  etsy_desc_short: { sev: "medium", kind: "problem", title: "Short description (under 300 characters)", why: "Thin descriptions miss search text and leave buyers' questions unanswered.", fix: "Add size, weight, origin, care and use." },
  etsy_ending_soon: { sev: "high", kind: "problem", title: "Expires within 14 days without auto-renew", why: "It will quietly drop off the shop.", fix: "Renew it or turn on auto-renew." },
  etsy_material_vs_erp: { sev: "medium", kind: "problem", title: "Etsy title stone differs from the ERP's material", why: "Either the listing or the ERP record is wrong, which can mean the wrong piece gets shipped.", fix: "Check which is right and correct the other." },
  etsy_not_in_erp: { sev: "low", kind: "problem", title: "Live on Etsy but not linked to an ERP listing", why: "Stock and sales for it aren't tracked, so it can be oversold.", fix: "Link it in Listing Manager." },
  erp_etsy_drift: { sev: "medium", kind: "problem", title: "ERP says live on Etsy, Etsy doesn't", why: "The piece may have expired or been removed without the ERP knowing, so it isn't selling.", fix: "Renew or relist it, or update the ERP." },
  // eBay
  ebay_wrong_category: { sev: "high", kind: "problem", title: "eBay category is wrong", why: "Crystal buyers browse Crystals (3226) and Display Specimens (3225); anything else hides the piece.", fix: "Move it with the eBay fix tool (fix_listings)." },
  ebay_condition: { sev: "medium", kind: "problem", title: "Condition isn't New", why: "Buyers filter by condition.", fix: "Set condition to New." },
  ebay_specifics_few: { sev: "medium", kind: "problem", title: "Missing item specifics most of the catalogue has", why: "eBay search filters on specifics; a missing one drops the piece from filtered results.", fix: "Add the missing specifics." },
  ebay_photos_few: { sev: "medium", kind: "problem", title: "Fewer than 5 photos", why: "eBay ranks listings with more photos higher.", fix: "Add photos." },
  ebay_best_offer_off: { sev: "low", kind: "problem", title: "Best Offer is off", why: "Offers turn watchers into buyers.", fix: "Turn on Best Offer (fix_listings does it)." },
  ebay_no_impressions: { sev: "medium", kind: "opportunity", title: "No eBay impressions in 30 days", why: "eBay isn't showing it at all: wrong category, weak title, or price far off.", fix: "Check the title keywords and category; consider promoting." },
  // Cross-channel
  oversell_risk: { sev: "high", kind: "problem", title: "Sold on one channel, still live on another", why: "A one-of-a-kind piece can be sold twice, which means a cancellation and a ding on the shop.", fix: "End the other listings now." },
  // Store
  store_no_photos: { sev: "high", kind: "problem", title: "Store product without photos", why: "Nobody buys a piece they can't see.", fix: "Add photos or hide the product." },
  store_price_zero: { sev: "high", kind: "problem", title: "Store product priced at 0", why: "It could sell for nothing.", fix: "Set the price or hide it." },
  // Opportunities (missed sales)
  etsy_favs_no_sales: { sev: "medium", kind: "opportunity", title: "Many favourites, no sale in a year", why: "People want it but something stops them: price, photos, or shipping.", fix: "Send an offer to favouriters, or check the price against what similar pieces sold for." },
  etsy_views_no_sales: { sev: "medium", kind: "opportunity", title: "Lots of views, no sale in a year", why: "Traffic is arriving and leaving: the listing isn't convincing.", fix: "Check the first photo, price and title against what sells." },
  ebay_watched_unsold: { sev: "medium", kind: "opportunity", title: "Watched on eBay, not sold", why: "Watchers are buyers waiting for a nudge.", fix: "Send an offer to watchers (Seller Hub > Listings > Send offer)." },
  store_viewed_not_carted: { sev: "low", kind: "opportunity", title: "Viewed on eartheditions.co, never added to cart (30 days)", why: "Interest without action: price, photos or trust.", fix: "Check price and photos; compare with Etsy." },
  store_abandoned_cart: { sev: "medium", kind: "opportunity", title: "Added to cart on eartheditions.co, not bought (30 days)", why: "These were nearly sales.", fix: "Check the checkout flow and shipping cost for these; consider an abandoned-cart email." },
  demand_gap: { sev: "medium", kind: "opportunity", title: "Selling well, few left to sell", why: "Recent buyers want this kind of piece and the shop has little of it live.", fix: "List more of these from stock, or buy more." },
  erp_unlisted: { sev: "low", kind: "opportunity", title: "In the ERP but live nowhere", why: "Stock that isn't listed can't sell.", fix: "Publish it (the Etsy queue spreads new listings out)." },
};

const etsyUrl = id => `https://www.etsy.com/listing/${id}`;
const ebayUrl = id => `https://www.ebay.com/itm/${id}`;

async function cronKey(sb) {
  const { data } = await sb.from("cron_keys").select("key").eq("name", "raj").maybeSingle();
  return data?.key || "";
}
async function callApi(base, key, path) {
  try {
    const r = await fetch(base + path, { headers: { "x-cron-key": key } });
    const d = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    return r.ok ? d : { error: d?.error?.message || d?.error || `HTTP ${r.status}` };
  } catch (e) { return { error: e.message || String(e) }; }
}

/* eBay item details come one GetItem each, so in batches of 40 per call. */
async function ebayFull(base, key) {
  const first = await callApi(base, key, "/api/ebay?action=insights&full=1&lite=1&from=0&n=40&tdays=30");
  if (first.error) return first;
  const total = (first.active || []).length;
  for (let from = 40; from < total; from += 40) {
    const more = await callApi(base, key, `/api/ebay?action=insights&full=1&lite=1&from=${from}&n=40&tdays=1`);
    if (more.error) { first.partial = more.error; break; }
    first.all.push(...(more.all || []));
  }
  return first;
}

export async function rajAudit({ sb, base, now = Date.now() }) {
  const today = istDay(now);
  const key = await cronKey(sb);
  if (!key) throw new Error("cron_keys has no 'raj' row");
  const errors = {};
  const found = {};   // check|channel → items
  const add = (check, channel, item) => ((found[`${check}|${channel}`] ||= { check, channel, items: [] }).items.push(item));

  const [aty, ee, ebay, listings, storeRes, prevRows] = await Promise.all([
    callApi(base, key, "/api/etsy?action=insights&days=365&audit=1"),
    callApi(base, key, "/api/etsy?action=insights&days=365&audit=1&shop=earth"),
    ebayFull(base, key),
    readRows(sb, "ng-listings-v1").catch(e => { errors.listings = e.message; return []; }),
    sb.from("store_products").select("id,listing_id,handle,title,images,price,qty,status,is_unique,sold_at").eq("status", "active").limit(5000),
    readRows(sb, AUDIT_KEY).catch(() => []),
  ]);

  /* ERP listings by channel id */
  const erpByEtsy = new Map(), erpByEbay = new Map();
  for (const l of listings) {
    for (const ch of ["etsy", "etsy_ee"]) { const id = l.platforms?.[ch]?.listing_id; if (id) erpByEtsy.set(String(id), l); }
    const eb = l.platforms?.ebay?.item_id; if (eb) erpByEbay.set(String(eb), l);
  }

  /* ── Etsy, both shops ── */
  const shops = { etsy: aty, etsy_ee: ee };
  const etsyActive = { etsy: new Set(), etsy_ee: new Set() };
  const salesByListing = new Map();          // lid → { units365, units90, last }
  const sold90ByGroup = new Map();           // "category|stone" → units
  const activeByGroup = new Map();
  const convByCat = {};                      // category → { views, units }
  const cadence = {};
  const groupOf = (title, materials) => {
    const st = [...stonesIn(`${title} ${(materials || []).join(" ")}`)][0] || "other";
    return `${inferCategoryValue(title)}|${family(st)}`;
  };
  for (const [ch, ins] of Object.entries(shops)) {
    if (!ins || ins.error) { errors[ch] = ins?.error || "no reply"; continue; }
    const nowS = Date.now() / 1000;
    for (const r of ins.receipts || []) for (const ln of r.lines || []) {
      const s = salesByListing.get(ln.lid) || { units365: 0, units90: 0, last: 0 };
      s.units365 += ln.qty; if (r.ts > nowS - 90 * 86400) s.units90 += ln.qty; s.last = Math.max(s.last, r.ts);
      salesByListing.set(ln.lid, s);
      if (r.ts > nowS - 90 * 86400) { const g = groupOf(ln.title); sold90ByGroup.set(g, (sold90ByGroup.get(g) || 0) + ln.qty); }
    }
    cadence[ch] = { active: (ins.listings || []).length,
      new_7d: (ins.listings || []).filter(l => l.first > nowS - 7 * 86400).length,
      new_30d: (ins.listings || []).filter(l => l.first > nowS - 30 * 86400).length };
    for (const l of ins.listings || []) {
      etsyActive[ch].add(l.id);
      const it = { id: l.id, title: l.title, url: etsyUrl(l.id) };
      const titleStones = stonesIn(l.title), titleFam = new Set([...titleStones].map(family));
      const cat = inferCategoryValue(l.title);
      const g = groupOf(l.title, l.materials); activeByGroup.set(g, (activeByGroup.get(g) || 0) + 1);
      const cc = (convByCat[cat] ||= { views: 0, units: 0, listings: 0 }); cc.views += l.views; cc.listings++;
      cc.units += salesByListing.get(l.id)?.units365 || 0;
      if (l.tagList) {
        const tags = l.tagList.map(t => String(t).toLowerCase().trim());
        if (tags.length < 13) add("etsy_tags_missing", ch, { ...it, detail: `${tags.length}/13 tags` });
        const dup = tags.filter((t, i) => tags.indexOf(t) !== i);
        if (dup.length) add("etsy_tags_duplicate", ch, { ...it, detail: `repeated: ${[...new Set(dup)].join(", ")}` });
        if (titleStones.size && !MIXED.test(l.title)) {
          const wrong = new Set();
          for (const src of [...tags, ...(l.materials || []).map(m => String(m).toLowerCase())])
            for (const s of stonesIn(src)) if (!titleStones.has(s) && !titleFam.has(family(s)) && ![...titleStones].some(t => t.includes(s) || s.includes(t))) wrong.add(s);
          if (wrong.size) add("etsy_tag_wrong_stone", ch, { ...it, detail: `tags/materials say ${[...wrong].join(", ")}; title is ${[...titleStones].join(", ")}` });
        }
        if (!titleStones.size && !MIXED.test(l.title)) add("etsy_title_no_stone", ch, { ...it, detail: "no stone name found in the title" });
        const expected = ETSY_CATEGORIES.find(c => c.value === cat)?.taxonomyId;
        if (expected && l.taxonomy && l.taxonomy !== expected && cat !== "metaphysical")
          add("etsy_category_mismatch", ch, { ...it, detail: `filed under taxonomy ${l.taxonomy}; a ${cat} piece goes under ${expected}` });
        if (!l.section) add("etsy_section_missing", ch, { ...it, detail: "no shop section" });
        else if (ch === "etsy") {
          const want = sectionIdForCategory(cat);
          const special = [58218908, 58168978, 30146745, 50040802, 58326407].includes(l.section);
          if (want && l.section !== want && !special && cat !== "metaphysical") add("etsy_section_mismatch", ch, { ...it, detail: `section ${l.section}; ${cat} pieces go in ${want}` });
        }
        if (!(l.materials || []).length) add("etsy_materials_missing", ch, it);
        if (l.descLen < 300) add("etsy_desc_short", ch, { ...it, detail: `${l.descLen} characters` });
      }
      if (l.photos < 5) add("etsy_photos_few", ch, { ...it, detail: `${l.photos} photos` });
      if (!l.video) add("etsy_no_video", ch, it);
      if (l.ends && !l.auto && l.ends < nowS + 14 * 86400) add("etsy_ending_soon", ch, { ...it, detail: `expires ${istDay(l.ends * 1000)}` });
      const erp = erpByEtsy.get(l.id);
      if (!erp) add("etsy_not_in_erp", ch, it);
      else if (erp.material && titleStones.size) {
        const em = stonesIn(erp.material);
        if (em.size && ![...em].some(s => titleStones.has(s) || titleFam.has(family(s))))
          add("etsy_material_vs_erp", ch, { ...it, detail: `ERP material "${erp.material}"; Etsy title says ${[...titleStones].join(", ")}`, erp_id: erp.id });
      }
      // Missed sales
      const sold = salesByListing.get(l.id);
      const ageD = l.first ? (nowS - l.first) / 86400 : 999;
      if (!sold && l.favs >= 8 && ageD > 30) add("etsy_favs_no_sales", ch, { ...it, detail: `${l.favs} favourites, ${l.views} views, ${l.price} ${l.cur}`, value: l.favs });
      else if (!sold && l.views >= 250 && ageD > 60) add("etsy_views_no_sales", ch, { ...it, detail: `${l.views} views, ${l.favs} favourites, ${l.price} ${l.cur}`, value: l.views });
    }
  }
  // ERP thinks it's live on Etsy, Etsy doesn't (only when that shop answered).
  for (const l of listings) for (const ch of ["etsy", "etsy_ee"]) {
    const p = l.platforms?.[ch];
    if (p?.status === "active" && p.listing_id && !shops[ch]?.error && etsyActive[ch].size && !etsyActive[ch].has(String(p.listing_id)))
      add("erp_etsy_drift", ch, { id: String(p.listing_id), title: l.title, url: p.url || etsyUrl(p.listing_id), erp_id: l.id, detail: p.expired ? "expired" : "not active on Etsy" });
  }

  /* ── eBay ── */
  if (!ebay || ebay.error) errors.ebay = ebay?.error || "no reply";
  else {
    const all = ebay.all || [];
    const byId = new Map((ebay.active || []).map(i => [i.id, i]));
    const nameCount = {};
    all.forEach(x => (x.specNames || []).forEach(n => { nameCount[n] = (nameCount[n] || 0) + 1; }));
    const common = Object.entries(nameCount).filter(([, c]) => c >= all.length * 0.6).map(([n]) => n);
    const t = ebay.traffic || {}, H = t.header || [], col = n => H.indexOf(n) + 1;
    const imp = new Map((t.rows || []).map(r => [r[0], +r[col("LISTING_IMPRESSION_TOTAL")] || 0]));
    for (const x of all) {
      const a = byId.get(x.id) || {};
      const it = { id: x.id, title: a.title || "", url: ebayUrl(x.id) };
      const want = ebayCategoryFor(a.title || "");
      if (x.cat && x.cat !== want) add("ebay_wrong_category", "ebay", { ...it, detail: `in ${x.cat} ${x.catName || ""}; should be ${want}` });
      if (x.cond && x.cond !== "1000") add("ebay_condition", "ebay", { ...it, detail: `condition ${x.cond}` });
      const missing = common.filter(n => !(x.specNames || []).includes(n));
      if (missing.length) add("ebay_specifics_few", "ebay", { ...it, detail: `missing: ${missing.join(", ")}` });
      if (x.pics < 5) add("ebay_photos_few", "ebay", { ...it, detail: `${x.pics} photos` });
      if (x.bestOffer && x.bestOffer !== "true") add("ebay_best_offer_off", "ebay", it);
    }
    const ageOk = i => !i.start || Date.parse(i.start) < Date.now() - 30 * 864e5;
    if (!t.error) for (const i of ebay.active || []) if (ageOk(i) && !(imp.get(i.id) > 0)) add("ebay_no_impressions", "ebay", { id: i.id, title: i.title, url: ebayUrl(i.id), detail: "0 impressions in 30 days" });
    for (const i of ebay.active || []) if (+i.watch >= 2) add("ebay_watched_unsold", "ebay", { id: i.id, title: i.title, url: ebayUrl(i.id), detail: `${i.watch} watchers at ${i.price}`, value: +i.watch });
    if (t.error) errors.ebay_traffic = String(t.error);
  }

  /* ── Cross-channel: sold somewhere, live elsewhere ── */
  const ebayActive = new Set((ebay?.active || []).map(i => i.id));
  for (const l of listings) {
    const P = l.platforms || {};
    const soldOn = Object.entries(P).filter(([, v]) => v?.status === "sold" || v?.sold_by).map(([k, v]) => v.sold_by || k);
    if (!soldOn.length || (+l.qty || 1) > 1) continue;
    const live = [];
    for (const ch of ["etsy", "etsy_ee"]) if (P[ch]?.listing_id && etsyActive[ch].has(String(P[ch].listing_id))) live.push(ch);
    if (P.ebay?.item_id && ebayActive.has(String(P.ebay.item_id))) live.push("ebay");
    if (P.store?.status === "active") live.push("store");
    if (P.trade?.status === "active") live.push("trade");
    if (P.shopify_earth?.status === "active") live.push("shopify_earth");
    const still = live.filter(c => !soldOn.includes(c));
    if (still.length) add("oversell_risk", "all", { id: l.id, title: l.title, detail: `sold on ${[...new Set(soldOn)].join(", ")}; still live on ${still.join(", ")}`, erp_id: l.id });
  }
  // In the ERP, live nowhere (one-offs with stock, not drafts waiting in the queue).
  for (const l of listings) {
    const P = l.platforms || {};
    const anyLive = Object.values(P).some(v => v?.status === "active" || v?.status === "draft" || v?.queued_at);
    const anySold = Object.values(P).some(v => v?.status === "sold" || v?.sold_by);
    if (!anyLive && !anySold && (+l.qty || 0) > 0 && (l.images || []).length) add("erp_unlisted", "all", { id: l.id, title: l.title, detail: `qty ${l.qty}`, erp_id: l.id });
  }

  /* ── Store ── */
  if (storeRes.error) errors.store = storeRes.error.message;
  for (const p of storeRes.data || []) {
    const it = { id: p.id, title: p.title, url: `https://eartheditions.co/products/${p.handle}` };
    if (!(p.images || []).length) add("store_no_photos", "store", it);
    if (!(+p.price > 0)) add("store_price_zero", "store", it);
  }
  try {
    const since = new Date(now - 30 * 864e5).toISOString();
    const ev = [];
    for (let off = 0; off < 60000; off += 1000) {
      const { data, error } = await sb.from("site_events").select("sid,type,handle,title").gte("at", since).eq("is_staff", false)
        .in("type", ["view", "add_to_cart", "purchase"]).not("handle", "is", null).range(off, off + 999);
      if (error) throw error;
      ev.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    const per = new Map();
    for (const e of ev) {
      const p = per.get(e.handle) || { title: e.title, views: 0, carts: new Set(), buys: new Set() };
      if (e.type === "view") p.views++; else if (e.type === "add_to_cart") p.carts.add(e.sid); else p.buys.add(e.sid);
      if (e.title) p.title = e.title;
      per.set(e.handle, p);
    }
    for (const [h, p] of per) {
      const it = { id: h, title: p.title || h, url: `https://eartheditions.co/products/${h}` };
      const abandoned = [...p.carts].filter(s => !p.buys.has(s)).length;
      if (abandoned) add("store_abandoned_cart", "store", { ...it, detail: `${abandoned} cart${abandoned > 1 ? "s" : ""} not bought, ${p.views} views`, value: abandoned });
      else if (p.views >= 15 && !p.carts.size) add("store_viewed_not_carted", "store", { ...it, detail: `${p.views} views, no carts`, value: p.views });
    }
  } catch (e) { errors.site = e.message || String(e); }

  /* ── Demand gaps: sold in 90 days vs live now (Etsy, both shops) ── */
  for (const [g, units] of sold90ByGroup) {
    const live = activeByGroup.get(g) || 0;
    const [cat, stone] = g.split("|");
    if (units >= 3 && live <= Math.max(2, units / 3) && stone !== "other")
      add("demand_gap", "etsy", { id: g, title: `${stone} ${cat}`, detail: `${units} sold in 90 days; ${live} live now`, value: units });
  }

  /* ── Merge with yesterday: first seen, resolved ── */
  const prev = new Map(prevRows.filter(r => r.id !== "summary").map(r => [r.id, r]));
  const rows = [], summary = { by_check: [], new_today: 0, resolved_today: 0 };
  const ids = new Set([...Object.keys(found), ...prev.keys()]);
  for (const id of ids) {
    const f = found[id] || { ...(prev.get(id) || {}), items: [] };
    const def = CHECKS[f.check];
    if (!def) continue;
    const old = prev.get(id);
    const was = new Map((old?.items || []).map(i => [i.id, i]));
    const items = (f.items || []).sort((a, b) => (b.value || 0) - (a.value || 0)).map(i => ({ ...i, since: was.get(i.id)?.since || today }));
    const nowIds = new Set(items.map(i => i.id));
    const resolvedNow = [...was.values()].filter(i => !nowIds.has(i.id)).map(i => ({ id: i.id, title: i.title, day: today, since: i.since }));
    // A shop that didn't answer today can't resolve anything.
    const channelDown = (f.channel === "etsy" || f.channel === "etsy_ee") ? !!errors[f.channel] : f.channel === "ebay" ? !!errors.ebay : f.channel === "store" ? !!(errors.store || errors.site) : false;
    if (channelDown && old) { rows.push(old); continue; }
    const newToday = items.filter(i => i.since === today && old).length;
    const history = [...(old?.history || []).filter(h => h.day !== today), { day: today, count: items.length }].slice(-90);
    const row = { id, check: f.check, channel: f.channel, severity: def.sev, kind: def.kind, title: def.title, why: def.why, fix: def.fix,
      count: items.length, new_today: newToday, resolved_today: resolvedNow.length,
      first_seen: old?.first_seen || today, updated: today, items: items.slice(0, 1500),
      resolved: [...resolvedNow, ...(old?.resolved || [])].slice(0, 300), history };
    rows.push(row);
    summary.new_today += newToday; summary.resolved_today += resolvedNow.length;
    summary.by_check.push({ id, check: f.check, channel: f.channel, severity: def.sev, kind: def.kind, title: def.title, count: items.length, new_today: newToday, resolved_today: resolvedNow.length,
      top: items.slice(0, 5).map(i => ({ id: i.id, title: i.title, detail: i.detail })) });
  }
  const sevRank = { high: 0, medium: 1, low: 2 };
  summary.by_check.sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || b.count - a.count);

  // What converts: Etsy orders per 1,000 lifetime views of live listings, by category.
  summary.conversion_by_category = Object.entries(convByCat).map(([cat, c]) => ({ cat, listings: c.listings, views: c.views, units_365d: c.units,
    per_1000_views: c.views ? r2(c.units / c.views * 1000) : 0 })).sort((a, b) => b.per_1000_views - a.per_1000_views);
  summary.cadence = cadence;
  summary.id = "summary"; summary.day = today; summary.at = new Date(now).toISOString(); summary.errors = errors;
  summary.totals = {
    problems_high: summary.by_check.filter(c => c.kind === "problem" && c.severity === "high").reduce((t, c) => t + c.count, 0),
    problems: summary.by_check.filter(c => c.kind === "problem").reduce((t, c) => t + c.count, 0),
    opportunities: summary.by_check.filter(c => c.kind === "opportunity").reduce((t, c) => t + c.count, 0),
  };

  for (const r of rows) await upsertRow(sb, AUDIT_KEY, r, false);
  await upsertRow(sb, AUDIT_KEY, summary, true);
  return summary;
}

/* For the snapshot: the summary plus fixes resolved 7 days ago with their
   Etsy views before and after (the evidence Raj learns from). */
export async function auditForSnapshot(sb, etsyMaps) {
  const rows = await readRows(sb, AUDIT_KEY).catch(() => []);
  const summary = rows.find(r => r.id === "summary") || null;
  if (!summary) return null;
  const weekAgo = addDays(summary.day, -7);
  const fixes = [];
  for (const r of rows) for (const x of r.resolved || []) {
    if (x.day !== weekAgo || !String(r.channel).startsWith("etsy")) continue;
    const m = etsyMaps?.[r.channel] || {};
    const v = k => m[k]?.[x.id]?.[0];
    const nowV = v("now"), atV = v("d7"), before = v("d14");
    fixes.push({ check: r.check, id: x.id, title: x.title, fixed: x.day,
      views_week_after: nowV != null && atV != null ? nowV - atV : null, views_week_before: atV != null && before != null ? atV - before : null });
  }
  const { by_check, ...rest } = summary;
  return { ...rest, by_check: by_check.map(({ top, ...c }) => ({ ...c, top: top.slice(0, 3) })), fixes_week_old: fixes.slice(0, 40) };
}
