/* Which EarthEditions shop section a piece belongs in.

   The shop's four broad sections, read off the title, shape, type and tags:
   jewellery, a figurative carving, a polished (shaped) stone, or else a
   specimen as it came out of the ground. Shared by the publish (api) and the
   section picker (browser), so both name the same section. */
export const EE_SECTIONS = ["Polished crystals", "Mineral specimens", "Carvings", "Jewellery"];
export function eeSectionFor(listing) {
  const t = [listing.title, listing.shape, listing.productType, ...(listing.tags || [])].join(" ").toLowerCase();
  if (/\b(pendants?|necklaces?|rings?|bracelets?|earrings?|jewell?ery|jewelry|anklets?|beads?|cabochons?)\b/.test(t)) return "Jewellery";
  if (/\b(carvings?|carved|skulls?|figurines?|statues?|idols?|buddha|ganesh\w*|animals?|angels?|dragons?|owls?|elephants?|turtles?|frogs?|birds?|fish|cats?|horses?|bears?|fox|deer|rabbits?|lions?|wolf|wolves)\b/.test(t)) return "Carvings";
  if (/\b(polished|spheres?|orbs?|palm ?stones?|hearts?|towers?|tumbled?|tumbles?|eggs?|wands?|worry|pyramids?|obelisks?|free ?forms?|massage|lingams?|shivalingam|slabs?|points?|generators?|dodecahedrons?|icosahedrons?|octahedrons?|cubes?|merkabas?|platonic|vogels?|cabochons?)\b/.test(t)) return "Polished crystals";
  return "Mineral specimens";
}

/* The best of the shop's own sections for a piece. A section named for a
   kind of piece (Gemstone Bowls, Mini Hearts, Palmstones, Spheres) wins when
   the title or shape names that kind; the more of its words match, the
   better. Failing that, the broad section above if the shop has it. */
const FILLER = new Set(["gemstone", "gemstones", "crystal", "crystals", "stone", "stones", "natural", "the", "and", "of", "for", "shop", "all", "other", "more"]);
const stem = w => w.replace(/(ies)$/, "y").replace(/(es|s)$/, "");
const words = t => String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
export function eeBestSection(listing, sectionNames = []) {
  const have = new Set(words([listing.title, listing.etsy_ee_title, listing.shape, listing.productType].join(" ")).flatMap(w => [w, stem(w)]));
  // "palm stones" and "palmstones" are the same kind.
  const joined = words([listing.title, listing.shape].join(" ")).join("");
  let best = null, bestScore = 0;
  const broadNames = new Set(EE_SECTIONS.map(n => n.toLowerCase()));
  for (const name of sectionNames) {
    if (broadNames.has(name.toLowerCase())) continue;   // the broad four are the fallback below
    // "Slabs / Freeforms": either side of a slash will do.
    const sides = String(name).split("/").map(part => words(part).filter(w => !FILLER.has(w))).filter(x => x.length);
    if (!sides.length) continue;
    const ws = sides.find(side => side.every(w => have.has(w) || have.has(stem(w))) || joined.includes(stem(side.join(""))));
    if (!ws) continue;
    const score = ws.length * 10 + ws.join("").length / 100;
    if (score > bestScore) { best = name; bestScore = score; }
  }
  if (best) return best;
  const broad = eeSectionFor(listing).toLowerCase();
  return sectionNames.find(n => n.toLowerCase() === broad) || "";
}
