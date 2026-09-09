/**
 * Listing taxonomy shared by the Listing Manager UI and the Telegram listing bot.
 *
 * Both surfaces have to file a listing under the same Etsy category, shop section
 * and shape, so the tables live here once rather than being copied into each.
 */

/* Etsy category presets — each maps to the shape + productType the API needs,
   plus the Etsy taxonomy id the listing is actually filed under. The ids are
   read off /seller-taxonomy/nodes; the comment is the category's full path, so
   a wrong one is visible here rather than only on the published listing. */
export const ETSY_CATEGORIES = [
  { value:"metaphysical", label:"Metaphysical Crystals",   shape:"Mineral",        productType:"Lapidary",     taxonomyId: 1158  }, // Spirituality & Religion > Prayer Beads & Charms > Metaphysical Crystals
  { value:"rocks_geodes", label:"Rocks & Geodes",          shape:"Specimen",       productType:"Mineral",      taxonomyId: 1893  }, // Home Decor > Home Accents > Rocks & Geodes
  { value:"spheres",      label:"Crystal Spheres",          shape:"Sphere",         productType:"Lapidary",     taxonomyId: 1158  },
  { value:"hearts",       label:"Crystal Hearts",           shape:"Heart",          productType:"Lapidary",     taxonomyId: 1158  },
  { value:"palmstones",   label:"Palmstones",               shape:"Palmstone",      productType:"Lapidary",     taxonomyId: 1158  },
  { value:"towers",       label:"Towers & Points",          shape:"Tower",          productType:"Lapidary",     taxonomyId: 1158  },
  { value:"tumbled",      label:"Tumbled Stones",           shape:"Tumbled",        productType:"Lapidary",     taxonomyId: 1158  },
  { value:"bowls",        label:"Crystal Bowls",            shape:"Bowl - 4 inch",  productType:"Lapidary",     taxonomyId: 1003  }, // Home Decor > Decorative Storage > Decorative Bowls
  { value:"bracelets",    label:"Bracelets",                shape:"Bracelet",       productType:"Jewellery",    taxonomyId: 1195  }, // Jewelry > Bracelets > Beaded Bracelets
  { value:"pendants",     label:"Pendants & Necklaces",     shape:"Pendant",        productType:"Jewellery",    taxonomyId: 1229  }, // Jewelry > Necklaces > Pendant Necklaces
  { value:"pendulums",    label:"Pendulums & Dowsing",      shape:"Pendulum",       productType:"Healing/Reiki",taxonomyId: 1964  }, // Spirituality & Religion > Divination Tools > Dowsing
  { value:"rough",        label:"Rough Stones",             shape:"Rough",          productType:"Rough",        taxonomyId: 1959  }, // Spirituality & Religion > Natural Curios > Mineral
  { value:"carvings",     label:"Carvings & Sculptures",    shape:"Mineral",        productType:"Carvings",     taxonomyId: 2869  }, // Home Decor > Home Accents > Statues
  { value:"collector",    label:"Collector's Corner",       shape:"Collector",      productType:"Mineral",      taxonomyId: 1893  },
];

// Actual shop sections from the Atyahara Etsy shop
export const ETSY_SHOP_SECTIONS = [
  { id: null,      label: "— Let category decide —" },
  { id: 58168978,  label: "Collector's Corner" },
  { id: 28345880,  label: "Spheres" },
  { id: 58185469,  label: "Hearts" },
  { id: 30952509,  label: "Palmstones" },
  { id: 28345876,  label: "Bracelets" },
  { id: 58218908,  label: "Ganesha" },
  { id: 30949825,  label: "Gemstone Bowls and More" },
  { id: 30843294,  label: "Pendants & Pendulums" },
  { id: 30692617,  label: "Towers & Freeforms" },
  { id: 50040802,  label: "Chips" },
  { id: 28345870,  label: "Tumbled Stones" },
  { id: 28361899,  label: "Mineral Specimens" },
  { id: 30789512,  label: "Rough Stones" },
  { id: 58326407,  label: "Eggs & Shivas" },
  { id: 30146745,  label: "Wellness" },
];

export const SHAPES = [
  "Sphere","Heart","Palmstone","Tower","Tumbled","Bracelet","Pendant","Pendulum",
  "Bowl - 2 inch","Bowl - 3 inch","Bowl - 4 inch","Bowl - 5 inch","Bowl - 6 inch","Bowl - 7 inch",
  "Rough","Mineral","Egg","Skull","Pyramid","Chips","Freeform","Set","Mala","Wand","Point","Slab","Other",
];

export const PRODUCT_TYPES = ["Lapidary","Carvings","Jewellery","Healing/Reiki","Decor","Mineral","Rough"];

/* Category value → the shop section a listing of that category belongs in, so a
   draft made away from the listing form still lands in the right Etsy section. */
const SECTION_BY_CATEGORY = {
  spheres: 28345880, hearts: 58185469, palmstones: 30952509, bracelets: 28345876,
  bowls: 30949825, pendants: 30843294, pendulums: 30843294, towers: 30692617,
  tumbled: 28345870, rocks_geodes: 28361899, metaphysical: 28361899,
  rough: 30789512, collector: 58168978, carvings: 58326407,
};

export const categoryByValue = value =>
  ETSY_CATEGORIES.find(c => c.value === value) || null;

export const sectionIdForCategory = value => SECTION_BY_CATEGORY[value] || null;

/* Best-guess category from free text (a Telegram caption, a stock note). Falls
   back to metaphysical crystals, which is where an unclassified stone belongs. */
export function inferCategoryValue(text = "") {
  const s = String(text).toLowerCase();
  const hit = [
    [/\bsphere|\bball\b|orb\b/, "spheres"],
    [/\bheart/, "hearts"],
    [/\bpalm ?stone|palmstone|worry stone/, "palmstones"],
    [/\btower|obelisk|generator|\bpoint\b/, "towers"],
    [/\btumbl/, "tumbled"],
    [/\bbowl/, "bowls"],
    [/\bbracelet|\bbead(ed)? band/, "bracelets"],
    [/\bpendant|necklace/, "pendants"],
    [/\bpendulum|dowsing/, "pendulums"],
    [/\brough\b|\braw\b|unpolished/, "rough"],
    [/\bcarving|statue|ganesh|buddha|skull|animal/, "carvings"],
    [/\bgeode|\bcluster|\bdruzy|\bdruse|specimen/, "rocks_geodes"],
    [/\bcollector|museum grade|rare piece/, "collector"],
  ].find(([re]) => re.test(s));
  return hit ? hit[1] : "metaphysical";
}
