/* Which eartheditions.co visits are bots, not shoppers. Shared by the ERP's
   Store → Visitors tab and Raj's morning snapshot, so both count the same way.

   A visit is one session: { country, city, source, events: [{ type, path }] }.
   Only a visit that saw one page and did nothing else can be a bot here:
   - China and Singapore: since October 2026, hundreds a day, each one page,
     direct, desktop Chrome (Taiyuan; Singapore hits old Wix URLs).
   - Data-centre towns (AWS, Google, Microsoft), arriving direct: crawlers
     running a real browser, e.g. Ashburn, Council Bluffs, Mountain View.
   - Direct hits on old Wix product URLs (/product-page/…), which no current
     page links to: only crawlers with an old index ask for them.
   Anything with a cart, a second page or a referrer counts as a person. */

const DATA_CENTRE_CITIES = new Set(["ashburn", "council bluffs", "boardman", "the dalles", "quincy", "prineville", "mountain view", "santa clara"]);

export function botLike(v) {
  const ev = v?.events || [];
  if (ev.length !== 1 || ev[0].type !== "view") return false;
  if (["CN", "SG"].includes(v.country)) return true;
  const direct = !v.source || v.source === "direct";
  if (!direct) return false;
  if (DATA_CENTRE_CITIES.has(String(v.city || "").trim().toLowerCase())) return true;
  return /^\/product-page\//.test(ev[0].path || "");
}

/* Events → visits (by session id), each with the fields botLike reads. */
export function visitsOf(events) {
  const m = new Map();
  for (const e of events) {
    let v = m.get(e.sid);
    if (!v) m.set(e.sid, v = { sid: e.sid, country: e.country, city: e.city, source: e.source || "direct", events: [] });
    v.events.push(e);
  }
  return [...m.values()];
}

/* The events left once bot visits are taken out. */
export function withoutBots(events) {
  const bots = new Set(visitsOf(events).filter(botLike).map(v => v.sid));
  return { events: bots.size ? events.filter(e => !bots.has(e.sid)) : events, bots: bots.size };
}
