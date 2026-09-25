/* Etsy titles are written for Etsy search: "47mm 690g | Ruby in Fuchsite Sphere -
   Bright Green with Fine Ruby Speckling | Large Polished Crystal Sphere | India".
   The retail store wants the name of the piece and, separately, its size:
   "Ruby in Fuchsite Sphere" · "47mm · 690g". */
const SIZE = /(?:\d+(?:\.\d+)?\s*(?:[-–]\s*\d+(?:\.\d+)?\s*)?(?:mm|cm|kg|gms?|grams?|g|inch(?:es)?|in|lbs?|ct|carats?)\b\.?)/i;

export function retailTitle(raw) {
  let t = String(raw || "").replace(/\s+/g, " ").trim();
  const sizes = [];
  // Measurements at the very start ("125mm 3.960kg |", "11 Inch", "655g").
  for (;;) {
    const m = t.match(new RegExp("^" + SIZE.source + "\\s*[|,·-]?\\s*", "i"));
    if (!m) break;
    sizes.push(m[0].replace(/[|,·-]\s*$/, "").trim());
    t = t.slice(m[0].length).trim();
  }
  // The name is the first segment; the rest is Etsy keywords.
  let name = t.split(/\s+[|–—]\s+|\s+-\s+|\|/)[0].trim();
  // "#12" stays as a number so near-identical pieces are told apart.
  const num = name.match(/\s*#\s*(\d+)\s*$/);
  if (num) name = name.slice(0, num.index).trim();
  name = name.replace(/\s*[,:;-]+$/, "").trim();
  if (name.length < 3) name = t.slice(0, 60).trim();
  return {
    title: num ? `${name} No. ${num[1]}` : name,
    size: sizes.map(s => s.replace(/\s+/g, "").replace(/inch(es)?$/i, " inch").replace(/(\d)(mm|cm|kg|g)$/i, "$1$2")).join(" · "),
  };
}
