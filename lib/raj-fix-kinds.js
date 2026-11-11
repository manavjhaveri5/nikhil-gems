/* Which audit checks a drafted fix covers, and the field it changes. Kept
   apart from raj-fixes.js so the Raj page can read it without pulling in the
   audit's server code. */
export const DRAFTABLE = {
  etsy_tag_wrong_stone: "tags", etsy_tags_missing: "tags", etsy_tags_duplicate: "tags",
  etsy_title_no_stone: "title", etsy_materials_missing: "materials",
  etsy_section_missing: "shop_section_id", etsy_section_mismatch: "shop_section_id",
  etsy_category_mismatch: "taxonomy_id", etsy_ending_soon: "should_auto_renew",
};
export const AI_CHECKS = new Set(["etsy_tag_wrong_stone", "etsy_tags_missing", "etsy_tags_duplicate", "etsy_title_no_stone"]);
