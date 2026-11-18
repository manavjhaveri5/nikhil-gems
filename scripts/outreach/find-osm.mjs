#!/usr/bin/env node
/* Finds crystal / mineral / metaphysical shops in OpenStreetMap (public, ODbL) for the given
   ISO countries. Writes candidates with whatever contact tags OSM has.
   node scripts/outreach/find-osm.mjs US,GB,AU out.json */
import { writeFileSync } from "node:fs";
const [cc = "US", out = "osm.json"] = process.argv.slice(2);
const NAME = "[Cc]rystal|[Mm]ineral|[Gg]emstone|[Mm]etaphysical|[Ss]piritual|[Hh]ealing [Ss]tone|[Rr]ock [Ss]hop|[Kk]ristall|[Ee]delstein|[Pp]ierres|[Cc]ristal|[Mm]inerali|[Kk]ristal|パワーストーン|天然石|鉱物|水晶";
const all = [];
for (const c of cc.split(",")) {
  const q = `[out:json][timeout:180];area["ISO3166-1"="${c}"][admin_level=2]->.a;
  (nwr["shop"]["name"~"${NAME}"](area.a); nwr["shop"~"esoteric|crystal|gemstone|new_age|minerals"](area.a););out center tags;`;
  const r = await fetch(process.env.OVERPASS || "https://overpass.kumi.systems/api/interpreter", { method: "POST", body: new URLSearchParams({ data: q }), headers: { "User-Agent": "lead-finder/1.0" } });
  if (!r.ok) { console.error(c, r.status); continue; }
  const j = await r.json();
  for (const e of j.elements || []) {
    const t = e.tags || {};
    if (/jewel|optic|glass|chandelier|car |auto|nail|bridal|church/i.test(`${t.name} ${t.shop}`) && !/crystal shop|crystals/i.test(t.name || "")) continue;
    all.push({ source: "osm", country: c, name: t.name, shop: t.shop, city: t["addr:city"] || "", website: t.website || t["contact:website"] || t.url || "",
      email: t.email || t["contact:email"] || "", phone: t.phone || t["contact:phone"] || "", instagram: t["contact:instagram"] || "", facebook: t["contact:facebook"] || "" });
  }
  console.error(c, (j.elements || []).length);
  await new Promise(r => setTimeout(r, 15000));
}
writeFileSync(out, JSON.stringify(all, null, 1));
console.log(all.length, "with website", all.filter(x => x.website).length);
