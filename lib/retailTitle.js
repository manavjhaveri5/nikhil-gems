/* Etsy titles are written for Etsy search: "47mm 690g | Ruby in Fuchsite Sphere -
   Bright Green with Fine Ruby Speckling | Large Polished Crystal Sphere | India".
   The retail store wants the name of the piece and, separately, its size:
   "Ruby in Fuchsite Sphere" · "47mm · 690g". */
const SIZE = /(?:\d+(?:\.\d+)?\s*(?:[-–]\s*\d+(?:\.\d+)?\s*)?(?:mm|cm|kgs?|gms?|grams?|g|inch(?:es)?|in|lbs?|ct|carats?)\b\.?)/i;

export function retailTitle(raw) {
  let t = String(raw || "").replace(/&quot;|&#34;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&")
    .replace(/["“”]/g, "").replace(/\s+/g, " ").replace(/^[^\w]+/, "").trim();
  const sizes = [];
  // Measurements at the very start ("125mm 3.960kg |", "11 Inch", "655g").
  for (;;) {
    const m = t.match(new RegExp("^" + SIZE.source + "\\s*[|,·-]?\\s*", "i"));
    if (!m) break;
    sizes.push(m[0].replace(/[|,·-]\s*$/, "").trim());
    t = t.slice(m[0].length).trim();
  }
  // The name is the first segment; the rest is Etsy keywords (after a dash,
  // bar, bullet or colon).
  let name = t.split(/\s+[|–—•·]\s+|\s+-\s+|(?<=\w)-\s|\||:\s|\s•|•|,\s/)[0].trim();
  // Etsy tails: "… Crystal for Meditation", "… Home Decor Idol".
  name = name.replace(/\s+(for|to)\s.*$/i, "").replace(/\s+(hindu\s+)?home\s+decor.*$/i, "").trim();
  // Weights and sizes in brackets go to the size line: "Slab (49g)".
  name = name.replace(/\s*\(([^)]*)\)\s*/g, (m, inner) => {
    if (new RegExp("^\\s*" + SIZE.source + "\\s*$", "i").test(inner)) { sizes.push(inner.trim()); return " "; }
    return m;
  }).trim();
  // Sales words that say nothing about the stone.
  name = name.replace(/\b(hand[\s-]?carved|hand[\s-]?made|hand[\s-]?crafted|handcrafted|handmade|sacred|vedic|spiritual|healing|reiki|meditation|genuine|authentic|premium|beautiful|stunning|gorgeous|exquisite|natural|rare|lucky|hand[\s-]?polished|certified|energized)\b\s*/gi, "")
    .replace(/\s{2,}/g, " ").trim();
  // A number ("#12", "No. 12") is kept so near-identical pieces are told apart.
  const num = name.match(/\s*(?:#|No\.?)\s*(\d+)\s*$/i);
  if (num) name = name.slice(0, num.index).trim();
  name = name.replace(/\s*[,:;-]+$/, "").trim();
  if (name.length < 3) name = t.slice(0, 60).trim();
  return {
    title: name.charAt(0).toUpperCase() + name.slice(1),
    number: num ? +num[1] : null,
    size: sizes.map(s => s.replace(/\s+/g, "").replace(/inch(es)?$/i, " inch").replace(/(\d)(mm|cm|kg|g)$/i, "$1$2")).join(" · "),
  };
}

/* Pieces that end up with the same name are numbered: "Ruby in Matrix
   Specimen #1", "#2"… Numbers the listing already had are kept; the rest
   are filled in after them, oldest first. items: [{ id, title, number, created_at }] */
export function numberDuplicates(items) {
  const groups = new Map();
  for (const it of items) { const k = it.title.toLowerCase(); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(it); }
  const out = {};
  for (const list of groups.values()) {
    if (list.length === 1 && list[0].number == null) { out[list[0].id] = list[0].title; continue; }
    const used = new Set(list.filter(i => i.number != null).map(i => i.number));
    let n = 1;
    for (const it of [...list].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))) {
      let num = it.number;
      if (num == null) { while (used.has(n)) n++; num = n; used.add(n); }
      out[it.id] = `${it.title} #${num}`;
    }
  }
  return out;
}
