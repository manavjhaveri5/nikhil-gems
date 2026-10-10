// Reddit relay: reads the newest posts in r/whatsthisrock and r/crystals from
// this Mac (Reddit answers a home connection; it refuses Vercel's servers
// without API access) and saves them to app_data "ng-reddit-feed-v1", which
// Social → Community shows. Run on demand from ~/Desktop/"Refresh Reddit.command"
// when sitting down to reply. Retire it once
// Reddit approves API access — the ERP then reads Reddit itself.
//
//   node --env-file=.env scripts/reddit-relay.mjs

const URL_ = (process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !KEY) { console.error("reddit-relay: missing Supabase URL / service key"); process.exit(1); }

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141 Safari/537.36";
const unxml = t => String(t || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
const ASKS = /\?|\b(what|which|is (this|it)|real|fake|dyed|identif\w*|id\b|help|anyone know|any idea|found)\b/i;

// One request for both subs: Reddit refuses a second request seconds after the first.
async function rss(sub) {
  const r = await fetch(`https://www.reddit.com/r/${sub}/new/.rss?limit=100`, { headers: { "User-Agent": UA, Accept: "application/atom+xml,application/xml" } });
  if (!r.ok) throw new Error(`r/${sub}: ${r.status}`);
  const xml = await r.text();
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => {
    const tag = n => (e.match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`)) || [])[1] || "";
    const html = unxml(tag("content"));
    const id = (tag("id").match(/t3_(\w+)/) || [])[1] || "";
    const link = (e.match(/<link href="([^"]+)"/) || [])[1] || "";
    const imgs = [...html.matchAll(/(?:src|href)="(https:\/\/(?:i|preview)\.redd\.it\/[^"]+)"/g)].map(m => unxml(m[1]));
    const thumb = unxml((html.match(/<img src="([^"]+)"/) || [])[1] || "");
    const text = unxml((html.match(/<div class="md">([\s\S]*?)<\/div>/) || [])[1] || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return { id, sub: (e.match(/<category term="([^"]+)"/) || [])[1]?.toLowerCase() || sub, title: unxml(tag("title")), text: text.slice(0, 800), url: link, image: imgs[0] || thumb,
      images: [...new Set([...imgs, thumb].filter(Boolean))].slice(0, 3), flair: "", comments: null,
      at: new Date(tag("updated") || tag("published") || Date.now()).toISOString() };
  }).filter(p => p.id);
}

const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const sleep = ms => new Promise(r => setTimeout(r, ms));
// The last good feed: a sub Reddit refuses this time keeps its posts from then.
const prev = await fetch(`${URL_}/rest/v1/app_data?key=eq.ng-reddit-feed-v1&select=value`, { headers: H }).then(r => r.json()).then(d => d?.[0]?.value?.threads || []).catch(() => []);
const errors = [];
let got = null;
for (let tryN = 0; tryN < 3 && !got; tryN++) {
  try { got = await rss("whatsthisrock+crystals"); } catch (e) { if (tryN === 2) errors.push(e.message); else { console.log(`Reddit busy (${e.message}), trying again in 45s…`); await sleep(45000); } }
}
const threads = got || prev;
const keep = threads
  .filter(p => Date.now() - Date.parse(p.at) < 48 * 3600e3)
  .filter(p => p.sub === "whatsthisrock" || ASKS.test(`${p.title} ${p.text.slice(0, 300)}`))
  .sort((a, b) => b.at.localeCompare(a.at)).slice(0, 60);

if (!keep.length) { console.error(`reddit-relay: nothing read (${errors.join("; ") || "empty"}) — keeping the last feed`); process.exit(errors.length ? 1 : 0); }
const r = await fetch(`${URL_}/rest/v1/app_data?on_conflict=key`, {
  method: "POST",
  headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
  body: JSON.stringify({ key: "ng-reddit-feed-v1", value: { at: new Date().toISOString(), threads: keep, errors } }),
});
if (!r.ok) { console.error("reddit-relay: save failed", r.status, await r.text()); process.exit(1); }
console.log(`reddit-relay ${new Date().toISOString()}: ${keep.length} posts${errors.length ? ` (${errors.join("; ")})` : ""}`);
