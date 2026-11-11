/* Raj's audit finds; this drafts the fix for Sir to approve.

   Each check that a field change can fix gets a proposal per listing (the
   same shape Raj's Mac tasks write to raj-proposals-v1): what the field is
   now, what it would become, and why. Nothing here touches a listing — the
   Raj page applies a proposal only when Sir presses Approve.

   Tags and titles are drafted by the AI, ten listings to a call; the rest
   (materials, section, category, auto-renew) follow the audit's own rules. */
import { stonesIn } from "./raj-audit.js";
import { ETSY_CATEGORIES, ETSY_SHOP_SECTIONS, inferCategoryValue, sectionIdForCategory } from "./listingCategories.js";

import { DRAFTABLE, AI_CHECKS } from "./raj-fix-kinds.js";
export { DRAFTABLE, AI_CHECKS };

const titleCase = s => s.replace(/\b\w/g, c => c.toUpperCase());
const sectionName = id => ETSY_SHOP_SECTIONS.find(s => String(s.id) === String(id))?.label || `section ${id}`;
// Several shop categories share one Etsy taxonomy; the first names it well enough.
const categoryName = id => ETSY_CATEGORIES.find(c => String(c.taxonomyId) === String(id))?.label || `Etsy category ${id}`;

// Etsy's tag rules: 20 characters, letters, numbers, spaces and a few marks.
// A tag over 20 is dropped, not cut: "mexican jasper spher" helps nobody.
const cleanTag = t => { const c = String(t || "").toLowerCase().replace(/[^a-z0-9 '&-]/g, " ").replace(/\s+/g, " ").trim(); return c.length <= 20 ? c : ""; };
const BANNED_TAG = /\b(lapidary|wholesale|bulk|cures?|heals?)\b/i;

function tagsPrompt(items) {
  return `You fix Etsy tags for a crystal and gemstone shop. For each listing below write exactly 13 tags.
Rules: each tag 20 characters or fewer, lowercase, 2-3 word phrases a shopper would type (not single words),
about THIS piece's stone(s) as named in its title, its shape and its use (decor, gift, altar, collection).
Keep any current tag that is already right for this piece. Never name a stone that isn't in the title
(a tag for a different stone sends the wrong shoppers). No healing claims, no "lapidary", no repeated tags,
and use any one word in at most three tags.
Reply as JSON: {"listings":[{"id":"…","tags":["…", …13]}]}

${items.map(i => `id ${i.id}\ntitle: ${i.title}\ncurrent tags: ${(i.tags || []).join(", ") || "none"}\nmaterials: ${(i.materials || []).join(", ") || "none"}`).join("\n\n")}`;
}
function titlesPrompt(items) {
  return `You fix Etsy titles for a crystal and gemstone shop. Each title below doesn't clearly name its stone early.
Rewrite each so the stone name comes in the first three words, keeping every true fact in it (size, weight,
shape, colour, origin). 60-140 characters, no ALL CAPS, no healing claims, no "lapidary". If the title
already names the stone early (the stone may be a rare one), return it unchanged.
Reply as JSON: {"listings":[{"id":"…","title":"…"}]}

${items.map(i => `id ${i.id}\ntitle: ${i.title}\ntags: ${(i.tags || []).join(", ")}\nmaterials: ${(i.materials || []).join(", ") || "none"}`).join("\n\n")}`;
}

/* items: the audit's items for one check and channel. aiJson(prompt) returns
   the model's parsed JSON. Returns the proposals, plus any listing skipped. */
export async function draftFixes({ check, channel, items = [], aiJson }) {
  const field = DRAFTABLE[check];
  if (!field) throw new Error(`No drafted fix for ${check}`);
  const base = i => ({
    id: `fix-${check}-${channel}-${i.id}`, check, channel, listing_id: String(i.id), title: i.title,
    erp_id: i.erp_id || null, field, reason: i.detail || "",
  });
  const out = [], skipped = [];

  if (AI_CHECKS.has(check)) {
    if (items.length > 10) throw new Error("Ten listings at a time");
    const reply = await aiJson(field === "tags" ? tagsPrompt(items) : titlesPrompt(items));
    const byId = new Map((reply?.listings || []).map(x => [String(x.id), x]));
    for (const i of items) {
      const r = byId.get(String(i.id));
      if (field === "tags") {
        const tags = [...new Set((r?.tags || []).map(cleanTag).filter(t => t.length > 1 && !BANNED_TAG.test(t)))].slice(0, 13);
        const cur = (i.tags || []).map(t => String(t).toLowerCase());
        if (tags.length < 10 || (tags.length === cur.length && tags.every(t => cur.includes(t)))) { skipped.push({ id: i.id, why: "no better tags came back" }); continue; }
        out.push({ ...base(i), current: i.tags || [], proposed: tags });
      } else {
        const t = String(r?.title || "").trim().slice(0, 140);
        if (!t || t === String(i.title).trim()) { skipped.push({ id: i.id, why: "title already names its stone" }); continue; }
        out.push({ ...base(i), current: i.title, proposed: t });
      }
    }
    return { proposals: out, skipped };
  }

  for (const i of items) {
    if (field === "materials") {
      const stones = [...stonesIn(i.title)].map(titleCase);
      if (!stones.length) { skipped.push({ id: i.id, why: "no stone found in the title" }); continue; }
      out.push({ ...base(i), current: i.materials || [], proposed: stones });
    } else if (field === "shop_section_id") {
      const want = check === "etsy_section_mismatch"
        ? +(String(i.detail || "").match(/go in (\d+)/) || [])[1]
        : sectionIdForCategory(inferCategoryValue(i.title));
      if (!want || channel !== "etsy") { skipped.push({ id: i.id, why: channel !== "etsy" ? "EarthEditions sections are set by name in Listing Manager" : "no section rule fits" }); continue; }
      const now = (String(i.detail || "").match(/section (\d+)/) || [])[1];
      out.push({ ...base(i), current: now ? sectionName(now) : "no section", proposed: want, proposed_label: sectionName(want) });
    } else if (field === "taxonomy_id") {
      const m = String(i.detail || "").match(/taxonomy (\d+).*goes under (\d+)/);
      if (!m) { skipped.push({ id: i.id, why: "no category in the audit note" }); continue; }
      out.push({ ...base(i), current: categoryName(m[1]), proposed: +m[2], proposed_label: categoryName(m[2]) });
    } else if (field === "should_auto_renew") {
      out.push({ ...base(i), current: "off", proposed: true, proposed_label: "on (Etsy charges $0.20 each time it renews)" });
    }
  }
  return { proposals: out, skipped };
}
