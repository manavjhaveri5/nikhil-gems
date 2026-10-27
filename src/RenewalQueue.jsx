/* Etsy listings that have come off the shop, and the ones about to: one at a
   time, with what each has done — how long it's been up, what it has sold
   over its life and lately, how many people favourited it — and a suggestion,
   so renewing is a decision rather than a reflex. Renew goes through the same
   listing steps as a new piece (where it goes, its stock card, prices, then
   publish), so it goes back up checked and tied to its stock. Skip is
   remembered, so a piece passed over once doesn't keep coming back.
   What each listing cost comes from Etsy's payment ledger: its listing and
   renewal fees, the fees on its sales, what the sales came to, and so what
   each four months on the shop has been worth. Pieces like it that sold —
   same stone and shape, near its price — say whether a listing that hasn't
   sold yet is still worth a term. */
import { useEffect, useMemo, useRef, useState } from "react";
import { C, mob } from "./lmTheme.js";
import { loadK, upsertItemK, deleteItemK } from "./utils.js";

export const RENEWALS_KEY = "ng-etsy-renewals-v1";   // [{ id: Etsy listing id, decision: "skip" | "renewed", at, by, title }]
// IndexedDB keys (see store below); the -v1 names were localStorage, and are cleared.
const QUEUE_CACHE = "queue", STATS_CACHE = "stats", LEDGER_CACHE = "ledger-v2", BRIEFS_CACHE = "briefs";
const OLD_LS_KEYS = ["ng-renew-queue-v1", "ng-renew-stats-v1", "ng-renew-ledger-v1"];
const RATES_KEY = "ng-fin-rates-v1";   // INR per unit of each currency, kept by Finance
/* The ledger is read in 30-day windows counted from this date (the same count
   as /api/etsy renewal_ledger), so a past window never changes and is kept.
   Three years back covers most of the queue; an older listing's costs are
   the part since then, and say so. */
const EPOCH = 1577836800, WIN = 30 * 86400, MAX_WINDOWS = 36;
const winOf = sec => Math.floor((sec - EPOCH) / WIN);
const QUEUE_FRESH_MS = 30 * 60 * 1000;
// An expired listing can't sell, so what it sold is final; one still on sale can.
const STATS_TTL = { expired: 7 * 86400000, active: 12 * 3600000 };
const RENEW_USD = 0.2;
const DAY = 86400000;
const BATCH = 20;
const PAGE = 30;
const serif = "'Cormorant Garamond',Georgia,serif";

/* The queue's caches — the listings, their sales, three years of ledger —
   run to several hundred KB, so they live in IndexedDB. In localStorage they
   would crowd out the app's own data snapshot, which is dropped when the quota
   runs out, and every screen would lose its fast start. A browser that won't
   open IndexedDB (some private windows) just reads Etsy again. */
const store = (() => {
  let db = null;
  const open = () => db || (db = new Promise((res, rej) => {
    const r = indexedDB.open("ng-renew", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const run = (mode, fn) => open().then(d => new Promise((res, rej) => {
    const t = d.transaction("kv", mode), q = fn(t.objectStore("kv"));
    t.oncomplete = () => res(q.result);
    t.onerror = () => rej(t.error);
  }));
  return {
    get: k => run("readonly", s => s.get(k)).catch(() => null),
    set: (k, v) => run("readwrite", s => s.put(v, k)).catch(() => {}),
  };
})();
const inr = v => `₹${Math.round(+v || 0).toLocaleString("en-IN")}`;
// Short rupees for a stat box: ₹840, ₹4.5k, ₹19k, ₹1.2L.
const inrK = v => {
  const a = Math.abs(+v || 0);
  const t = a >= 1e5 ? `${(a / 1e5).toFixed(a >= 1e6 ? 0 : 1)}L` : a >= 1e4 ? `${Math.round(a / 1e3)}k` : a >= 1e3 ? `${(a / 1e3).toFixed(1)}k` : `${Math.round(a)}`;
  return `${v < 0 ? "−" : ""}₹${t}`;
};
const usd = (v, rate) => rate ? `$${Math.round(v / rate).toLocaleString("en-US")}` : "";
const monthOf = sec => new Date(sec * 1000).toLocaleDateString("en-GB", { month: "short", year: "numeric" });
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const span = ms => {
  const d = Math.abs(ms) / DAY;
  if (d < 1) return "today";
  if (d < 2) return "1 day";
  if (d < 45) return `${Math.round(d)} days`;
  if (d < 365) return `${Math.round(d / 30.4)} months`;
  const y = Math.floor(d / 365), m = Math.round((d - y * 365) / 30.4);
  return `${y} yr${m ? ` ${m} mo` : ""}`;
};
const ago = ms => Math.abs(ms) < DAY ? "today" : `${span(ms)} ago`;
const when = ts => ts ? new Date(ts * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";
const customOrder = t => /^(custom (order|listing)|reserved\b|made for\b)/i.test(String(t || "").trim());

/* The ledger windows read so far, filed for looking up one listing: its own
   fees by listing id, sale fees by transaction and by order, its sales lines. */
function ledgerIndex(windows) {
  const fees = new Map(), tx = new Map(), rc = new Map(), sales = new Map();
  let fee = 0, feeAt = 0;
  for (const w of Object.values(windows || {})) {
    if (!w || w.error) continue;
    for (const [id, list] of Object.entries(w.fees || {})) {
      fees.set(id, [...(fees.get(id) || []), ...list]);
      // The fee a listing pays now, for "per term": the latest listing or renewal fee.
      for (const [ts, k, v] of list) if ("lx".includes(k) && ts > feeAt && v > 0) { fee = v; feeAt = ts; }
    }
    for (const [id, v] of Object.entries(w.tx || {})) tx.set(id, (tx.get(id) || 0) + v);
    for (const [id, row] of Object.entries(w.rc || {})) { const a = rc.get(id) || [0, 0, 0, 0]; row.forEach((v, i) => { a[i] += v; }); rc.set(id, a); }
    for (const line of w.sales || []) sales.set(line[1], [...(sales.get(line[1]) || []), line]);
  }
  return { fees, tx, rc, sales, fee: fee || 19 };
}

/* What a listing has cost and brought in since coverFrom: its listing and
   renewal fees, the fees on each sale (an order's own fees split by the item's
   share of it), what its sales came to after coupons and refunds, and what's
   left. Etsy Ads aren't here — they're bought for the shop, not a listing. A
   listing first listed before coverFrom shows the part since (covered: false). */
function economics(row, idx, coverFrom, nowS) {
  if (!idx || !coverFrom) return null;
  const fees = [...(idx.fees.get(row.id) || [])].sort((a, b) => a[0] - b[0]);
  const n = { l: 0, x: 0, s: 0, r: 0, p: 0 };
  let listing = 0;
  for (const [, k, v] of fees) { if (k in n) n[k]++; listing += v; }
  const parts = { transaction: 0, processing: 0, shipping: 0, offsite: 0, other: 0 };
  let revenue = 0, units = 0;
  for (const [rid, , tid, rev, q, , share] of idx.sales.get(row.id) || []) {
    revenue += rev;
    if (rev > 0) units += q;
    parts.transaction += idx.tx.get(tid) || 0;
    const o = idx.rc.get(rid);
    if (o) { parts.processing += o[0] * share; parts.shipping += o[1] * share; parts.offsite += o[2] * share; parts.other += o[3] * share; }
  }
  const onSales = Object.values(parts).reduce((a, b) => a + b, 0);
  const spent = listing + onSales, net = revenue - spent;
  // Each listing or renewal fee buys up to four months on the shop, until the next one.
  const terms = fees.filter(f => "lxsr".includes(f[1])).map(f => f[0]);
  const stop = row.state === "expired" ? Math.min(row.ends || nowS, nowS) : nowS;
  let live = 0;
  terms.forEach((ts, i) => { live += Math.max(0, Math.min(terms[i + 1] ?? Infinity, ts + 120 * 86400, stop) - ts); });
  return {
    covered: (row.first || 0) >= coverFrom - 86400, since: coverFrom,
    n, renewals: n.x + n.s + n.r, terms: terms.length, listing, parts, onSales, spent, revenue, units, net,
    perTerm: terms.length ? net / terms.length : null,
    liveDays: live / 86400, spanDays: Math.max(0, nowS - Math.max(row.first || coverFrom, coverFrom)) / 86400,
  };
}

/* Stone and shape, for "similar pieces that sold". The ERP's own material and
   shape when it has them; otherwise the title, which in this shop reads
   "[size] Stone Shape - description": the first part that isn't only a size,
   its shape word, and what's left once that and the filler words are out as
   the stone — matched to a stone the stock and listings already name when one
   fits ("Green Apophyllite with Stilbite" → apophyllite). */
const TITLE_SHAPES = [
  [/\b(shiva ?)?lingams?\b|\bshivalingams?\b/i, "Lingam"], [/\bmerkabas?( stars?)?\b/i, "Merkaba"], [/\bpendulums?\b/i, "Pendulum"],
  [/\b(mini )?hearts?\b/i, "Heart"], [/\bspheres?\b|\borbs?\b/i, "Sphere"], [/\bpalm ?stones?\b|\bworry stones?\b/i, "Palmstone"],
  [/\beggs?\b/i, "Egg"], [/\bskulls?\b/i, "Skull"], [/\bpyramids?\b/i, "Pyramid"], [/\bwands?\b/i, "Wand"], [/\bbowls?\b/i, "Bowl"],
  [/\btowers?\b|\bpoints?\b|\bobelisks?\b|\bgenerators?\b/i, "Tower"], [/\bbracelets?\b/i, "Bracelet"], [/\bpendants?\b|\bnecklaces?\b/i, "Pendant"],
  [/\bmalas?\b/i, "Mala"], [/\bcabochons?\b/i, "Cabochon"], [/\bslabs?\b|\bslices?\b/i, "Slab"], [/\bgeodes?\b/i, "Geode"], [/\bclusters?\b/i, "Cluster"],
  [/\bspecimens?\b/i, "Specimen"], [/\btumbled?\b|\btumbles\b/i, "Tumbled"], [/\bfree ?forms?\b/i, "Freeform"], [/\bsets?\b|\bkits?\b/i, "Set"],
  [/\bchips\b/i, "Chips"], [/\bbeads?\b/i, "Beads"],
  [/\bcarvings?\b|\bfigurines?\b|\b(ganesha|buddha|idol|deity|angel|dragon|owl|elephant)s?\b/i, "Carving"], [/\brough\b|\braw\b/i, "Rough"],
];
const ERP_SHAPE = { Point: "Tower", Chips: "Tumbled" };   // the ERP's word → the title's
const FILLER = /\b(natural|genuine|polished|raw|rough|a{2,3}|grade|top|quality|mini|small|large|big|huge|xl|hand|carved|handmade|crystals?|stones?|gemstones?|healing|reiki|meditation|premium|rare|unique|ooak|bulk|massive|the|and|for|in|with|pieces?|pcs|lot|of)\b/gi;
const SIZES = /\b\d+(\.\d+)?\s*([-–x]|to)?\s*\d*(\.\d+)?\s*(g|gm|gms|grams?|kg|mm|cm|inch(es)?|in|ct|carats?)\b|#\d+/gi;
function pieceOf(title, erp, vocab) {
  let stone = String(erp?.material || "").trim(), shape = "";
  const es = String(erp?.shape || "");
  if (es && !/^(other|mineral)$/i.test(es)) shape = ERP_SHAPE[es] || es.replace(/\s*-.*$/, "");   // "Bowl - 3 inch" → Bowl
  const main = unescape(title).split(/\s+[-–—|:]\s*|[-–—]\s+|[|:(,]/).map(p => p.replace(SIZES, " ").trim()).find(p => /[a-z]{3}/i.test(p)) || "";
  if (!shape) shape = (TITLE_SHAPES.find(([re]) => re.test(main)) || [])[1] || "";
  if (!stone) {
    let rest = main;
    for (const [re] of TITLE_SHAPES) rest = rest.replace(new RegExp(re.source, "gi"), " ");
    rest = rest.replace(FILLER, " ").replace(/[^a-z' ]/gi, " ").replace(/\s+/g, " ").trim().toLowerCase();
    stone = vocab.find(v => ` ${rest} `.includes(` ${v} `)) || rest;
  }
  return { stone: stone.toLowerCase(), shape };
}
const sameStone = (a, b) => !!a && !!b && (a === b || ` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `));
const titleCase = t => String(t).replace(/\b[a-z]/g, c => c.toUpperCase());
const shapes = (sh, n = 2) => n === 1 || /(tumbled|rough|s)$/i.test(sh) ? sh.toLowerCase() : `${sh.toLowerCase()}s`;
// Etsy hands titles back HTML-escaped ("Tiger&#39;s Eye").
const unescape = t => String(t || "").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

/* What sold in the last year that is like this listing: the same stone and
   shape within 40% of its price; else the same stone and shape at any price;
   else the stone in any shape. Units, what buyers paid on average, the latest
   sale, and the three latest of those listings to look at. */
function similarFor(row, mine, sold) {
  if (!mine?.stone) return null;
  const others = sold.filter(x => x.lid !== row.id && sameStone(x.stone, mine.stone));
  const shaped = mine.shape ? others.filter(x => x.shape === mine.shape) : [];
  const band = row.price > 0 ? shaped.filter(x => x.unit >= row.price * 0.6 && x.unit <= row.price * 1.4) : [];
  const [tier, set] = band.length ? ["band", band] : shaped.length ? ["shape", shaped] : others.length ? ["stone", others] : ["none", []];
  const units = set.reduce((n, x) => n + x.qty, 0);
  const recent = [...set].sort((a, b) => b.ts - a.ts);
  const items = [];
  for (const x of recent) { if (!items.some(i => i.lid === x.lid)) items.push(x); if (items.length === 3) break; }
  const label = tier === "stone" ? `${titleCase(mine.stone)} ${units === 1 ? "piece" : "pieces"} (any shape)`
    : `${titleCase(mine.stone)} ${shapes(mine.shape, units)}${tier === "band" ? ` at ${inrK(row.price * 0.6)}–${inrK(row.price * 1.4)}` : ""}`;
  return { ...mine, tier, label, units, avg: units ? set.reduce((n, x) => n + x.paid * x.qty, 0) / units : 0, last: recent[0]?.ts || 0, items,
    shapeUnits: shaped.reduce((n, x) => n + x.qty, 0), stoneUnits: others.reduce((n, x) => n + x.qty, 0) };
}

/* A listing with no sale of its own leans on what its kind does: three or
   more of the same stone and shape sold in the year moves Maybe to Renew (and
   Skip to Maybe); nothing of the stone sold at all moves Maybe to Skip. A
   custom order or an empty stock card stays a Skip. */
function nudge(base, st, sim) {
  if (!sim || base.hard || !base.v || !st || st.error || st.units) return base;
  const what = sim.shapeUnits ? `${sim.shapeUnits} similar ${shapes(sim.shape, sim.shapeUnits)}` : `${sim.stoneUnits} ${titleCase(sim.stone)} ${sim.stoneUnits === 1 ? "piece" : "pieces"}`;
  const but = /\bbut\b/.test(base.why) ? "still," : "but";
  if (sim.shapeUnits >= 3 && base.v === "maybe") return { v: "renew", why: `${base.why} — ${but} ${what} sold this year` };
  if (sim.shapeUnits >= 3 && base.v === "skip") return { v: "maybe", why: `${base.why} — ${but} ${what} sold this year` };
  if (!sim.stoneUnits && base.v === "maybe") return { v: "skip", why: `${base.why}, and nothing like it sold this year` };
  if (sim.stoneUnits) return { ...base, why: `${base.why} · ${what} sold this year` };
  return base;
}

/* The stock card's count, by whichever measure it has. Nothing left on the
   card is the one thing that makes renewing pointless outright. */
const cardEmpty = card => card && !(+card.qty > 0) && !(+card.qty2 > 0);

/* Renew / maybe / skip, with the reason in words. Cheap either way — four
   more months is $0.20 — so the bar to renew is low; the clear skips are a
   piece with nothing left to sell, a one-off made for one buyer, terms paid
   for again and again without a sale, and a year on the shop without a single
   sale or much interest. What each term has earned after Etsy's fees is the
   clearest renew. */
function verdict(row, st, card, nowMs, e, fee) {
  if (customOrder(row.title)) return { v: "skip", hard: true, why: "A custom order — made for one buyer" };
  if (cardEmpty(card)) return { v: "skip", hard: true, why: `Its stock card (${card.sku || card.material || "linked"}) is empty` };
  if (!st) return { v: "", why: "Reading its sales…" };
  if (st.error) return { v: "", why: `Couldn't read its sales — ${st.error}` };
  // A year of terms (three fees) without a sale is a skip; two is a doubt.
  if (e && e.terms >= 2 && !e.units && !st.units) return e.terms >= 3 && row.favs < 10
    ? { v: "skip", why: `${e.terms} terms paid for (${inr(e.listing)}), never sold` }
    : { v: "maybe", why: `${row.favs >= 10 ? `${row.favs} favourites, but ` : ""}${e.terms} terms (${inr(e.listing)}) without a sale` };
  if (e && e.units && e.perTerm >= 20 * fee) return { v: "renew", why: `Each ${inr(fee)} term has brought back ${inr(e.perTerm)} after fees` };
  const ageDays = (nowMs - row.first * 1000) / DAY;
  if (st.u120 > 0) return { v: "renew", why: `Sold ${st.u120} in its last four months` };
  if (st.u365 > 0) return { v: "renew", why: `Sold ${st.u365} in the last year` };
  if (st.units >= 2) return { v: "renew", why: `Sold ${st.units} since it was first listed` };
  if (row.favs >= 10) return { v: "renew", why: `${row.favs} favourites — people keep saving it` };
  if (row.state === "active" && row.views >= 30 * Math.max(1, ageDays / 30.4)) return { v: "renew", why: `${row.views} views — it gets looked at` };
  if (st.units === 1) return { v: "maybe", why: `One sale, ${ago(nowMs - st.last * 1000)}` };
  if (ageDays >= 365 && row.favs < 3) return { v: "skip", why: `${span(ageDays * DAY)} on Etsy, never sold` };
  if (row.favs >= 3) return { v: "maybe", why: `${row.favs} favourites, no sale yet` };
  return { v: "maybe", why: `${span(ageDays * DAY)} up, no sale yet` };
}
const TONE = {
  renew: { label: "Renew", fg: "var(--c-green)", bg: "var(--c-greenBg)" },
  maybe: { label: "Maybe", fg: "var(--c-amber)", bg: "var(--c-amberBg)" },
  skip:  { label: "Skip",  fg: "var(--c-inkMid)", bg: "var(--c-card)" },
  "":    { label: "…",     fg: "var(--c-inkFaint)", bg: "var(--c-card)" },
};

export default function RenewalQueue({ listings = [], stock = [], getToken, onRenew, showToast, who = "", onCount }) {
  const [ready, setReady] = useState(false);   // the caches are read back from IndexedDB
  const [queue, setQueue] = useState(null);     // { at, data }
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [stats, setStats] = useState({});   // id → { …, at }
  const [statsErr, setStatsErr] = useState("");
  const [ledger, setLedger] = useState({});   // window → { fees, tx, rc, sales, titles, ads, final, at }
  const [briefs, setBriefs] = useState({});   // listing id → { img, title, state } for the similar-sold pictures
  const [ledgerErr, setLedgerErr] = useState("");
  const [usdRate, setUsdRate] = useState(0);
  const [decisions, setDecisions] = useState([]);
  const [view, setView] = useState("expired");      // expired | ending | skipped | renewed
  const [sort, setSort] = useState("recent");       // recent | best
  const [only, setOnly] = useState("all");          // all | renew | maybe | skip
  const [shown, setShown] = useState(PAGE);
  const [opening, setOpening] = useState("");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const etsyFetch = async url => {
    const tok = getToken ? await getToken() : null;
    const r = await fetch(url, { headers: tok ? { "X-Etsy-Token": tok } : {}, cache: "no-store" });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) throw new Error(d.error || `Etsy didn't answer (${r.status})`);
    return d;
  };

  const loadQueue = async (force, cached = queue) => {
    if (!force && cached && Date.now() - cached.at < QUEUE_FRESH_MS) return;
    setLoading(true); setErr("");
    try {
      const d = await etsyFetch(`/api/etsy?action=renewal_queue&_=${Date.now()}`);
      const next = { at: Date.now(), data: d };
      if (alive.current) setQueue(next);
      store.set(QUEUE_CACHE, next);
    } catch (e) { if (alive.current) setErr(e.message || "Couldn't reach Etsy"); }
    if (alive.current) setLoading(false);
  };
  useEffect(() => {
    try { OLD_LS_KEYS.forEach(k => localStorage.removeItem(k)); } catch {}
    Promise.all([QUEUE_CACHE, STATS_CACHE, LEDGER_CACHE, BRIEFS_CACHE].map(k => store.get(k))).then(([q, st, led, br]) => {
      if (!alive.current) return;
      if (q?.data) setQueue(q);
      if (st) setStats(st);
      if (led) setLedger(led);
      if (br) setBriefs(br);
      setReady(true);
      loadQueue(false, q?.data ? q : null);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadK(RENEWALS_KEY).then(v => { if (alive.current && Array.isArray(v)) setDecisions(v); }).catch(() => {}); }, []);
  useEffect(() => { loadK(RATES_KEY).then(r => { if (alive.current && +r?.USD > 0) setUsdRate(+r.USD); }).catch(() => {}); }, []);

  const data = queue?.data;
  const loadedAt = queue?.at || 0;
  const nowMs = Date.now();

  /* The ERP's own listing for each Etsy one, and its stock card: by the Etsy
     id the listing carries, else by the SKU Etsy holds. */
  const erpByEtsy = useMemo(() => new Map(listings.filter(l => l?.platforms?.etsy?.listing_id).map(l => [String(l.platforms.etsy.listing_id), l])), [listings]);
  const stockById = useMemo(() => new Map(stock.map(s => [s.id, s])), [stock]);
  const stockBySku = useMemo(() => new Map(stock.filter(s => s?.sku).map(s => [String(s.sku).trim().toLowerCase(), s])), [stock]);
  const erpOf = row => erpByEtsy.get(row.id) || null;
  const cardOf = row => {
    const e = erpOf(row);
    return (e?.linked_stock_id && stockById.get(e.linked_stock_id)) || (row.sku && stockBySku.get(row.sku.trim().toLowerCase())) || null;
  };

  /* Put back up since the queue was read: renewed through the listing steps
     (the ERP listing went active, or took auto-renew, after the read). */
  const doneHere = row => {
    const e = erpOf(row);
    if (!e || !(Date.parse(e.updated_at || "") > loadedAt) || e.platforms?.etsy?.status !== "active") return false;
    return row.state === "expired" ? true : !!e.etsy_auto_renew;
  };
  const decided = useMemo(() => new Map(decisions.map(d => [String(d.id), d])), [decisions]);

  // Recorded once, so the Renewed list still knows it after the queue is read again.
  useEffect(() => {
    if (!data) return;
    for (const row of [...(data.expired || []), ...(data.ending || [])]) {
      if (!doneHere(row) || decided.get(row.id)?.decision === "renewed") continue;
      record({ id: row.id, decision: "renewed", at: new Date().toISOString(), by: who, title: row.title });
    }
  }, [listings, data]); // eslint-disable-line react-hooks/exhaustive-deps

  const record = item => {
    setDecisions(list => [item, ...list.filter(x => String(x.id) !== String(item.id))]);
    return upsertItemK(RENEWALS_KEY, item, { prepend: true });
  };
  const skip = async row => {
    try { await record({ id: row.id, decision: "skip", at: new Date().toISOString(), by: who, title: row.title, ends: row.ends }); }
    catch (e) {
      setDecisions(list => list.filter(x => String(x.id) !== row.id));
      showToast?.(`⚠ Couldn't save the skip: ${e.message}`);
    }
  };
  const unskip = async id => {
    const was = decisions;
    setDecisions(list => list.filter(x => String(x.id) !== String(id)));
    try { await deleteItemK(RENEWALS_KEY, String(id)); }
    catch (e) { setDecisions(was); showToast?.(`⚠ Couldn't bring it back: ${e.message}`); }
  };

  const allRows = useMemo(() => data ? [...(data.expired || []), ...(data.ending || [])] : [], [data]);
  const rowById = useMemo(() => new Map(allRows.map(r => [r.id, r])), [allRows]);
  const open = row => !decided.has(row.id) && !doneHere(row);
  // Ending ones that renew themselves already need nothing.
  const lists = useMemo(() => ({
    expired: (data?.expired || []).filter(open),
    ending: (data?.ending || []).filter(r => !r.auto && open(r)),
    skipped: decisions.filter(d => d.decision === "skip"),
    renewed: decisions.filter(d => d.decision === "renewed"),
  }), [data, decisions, listings]); // eslint-disable-line react-hooks/exhaustive-deps
  const autoCount = (data?.ending || []).filter(r => r.auto).length;
  useEffect(() => { if (data) onCount?.(lists.expired.length + lists.ending.length); }, [lists, data]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Read recently enough. One Etsy couldn't answer for is left a few minutes
     before it's asked again, so a bad listing can't hold the batches in a loop. */
  const fresh = row => {
    const s = stats[row.id];
    if (!s) return false;
    const age = Date.now() - (s.at || 0);
    return s.error ? age < 10 * 60000 : age < STATS_TTL[row.state === "active" ? "active" : "expired"];
  };

  /* The ledger windows this list needs: from now back to its oldest listing,
     three years at most. A finished window is kept for good; the current one,
     or one that failed, is read again after a while. */
  const work = view === "expired" || view === "ending" ? lists[view] : [];
  const nowS = Math.floor(nowMs / 1000), kNow = winOf(nowS), kFloor = kNow - MAX_WINDOWS + 1;
  const kMin = Math.max(kFloor, winOf(work.reduce((m, r) => Math.min(m, r.first || m), nowS)), 0);
  const winFresh = w => !!w && (w.error ? Date.now() - (w.at || 0) < 10 * 60000 : w.final || Date.now() - (w.at || 0) < 3600000);
  const missingWins = [];
  for (let k = kNow; k >= kMin; k--) if (!winFresh(ledger[k])) missingWins.push(k);
  // Read back without a gap from now: costs are counted from the oldest of these.
  let kLow = null;
  for (let k = kNow; k >= kFloor && ledger[k] && !ledger[k].error; k--) kLow = k;
  const coverFrom = kLow == null ? 0 : EPOCH + kLow * WIN;
  const idx = useMemo(() => ledgerIndex(ledger), [ledger]);

  /* Every sale in the last year with its stone and shape, read once from the
     ledger windows — what "similar pieces that sold" is picked from. The
     stones the stock and listings already name are what a title is matched to. */
  const vocab = useMemo(() => [...new Set([...stock.map(x => x?.material), ...listings.map(l => l?.material)]
    .map(v => String(v || "").toLowerCase().trim()).filter(v => v.length >= 4 && v !== "other"))].sort((a, b) => b.length - a.length), [stock, listings]);
  const soldYear = useMemo(() => {
    const titles = {}, out = [], since = Math.floor(Date.now() / 1000) - 365 * 86400;
    for (const w of Object.values(ledger)) if (w && !w.error) Object.assign(titles, w.titles || {});
    for (const w of Object.values(ledger)) for (const x of (w && !w.error && w.sales) || []) {
      if (x[5] < since || !(x[3] > 0)) continue;   // the last year, and not cancelled or refunded in full
      out.push({ lid: x[1], qty: x[4], paid: x[3] / x[4], unit: x[7] || x[3] / x[4], ts: x[5], title: unescape(titles[x[1]] || "") });
    }
    const piece = new Map();
    for (const x of out) {
      if (!piece.has(x.lid)) piece.set(x.lid, pieceOf(x.title, erpByEtsy.get(x.lid), vocab));
      Object.assign(x, piece.get(x.lid));
    }
    return out;
  }, [ledger, erpByEtsy, vocab]);
  // "Nothing like it sold" is only said once the whole year has been read.
  const simReady = kLow != null && kLow <= winOf(nowS - 365 * 86400);

  /* Sales are one Etsy request per listing, so they're read in batches, and
     the ledger a few windows at a time; one Etsy call in flight, so the two
     never share Etsy's per-second allowance. The rows on screen first, then
     the ledger, then the rest of the list in the background while this tab is
     open (sorting by best seller needs them all). Kept on this device, so the
     next visit has them. An answer is kept whatever the screen did meanwhile —
     it's filed by listing id or window. */
  const missing = work.filter(r => !fresh(r) && !customOrder(r.title));

  const judged = useMemo(() => work.map(row => {
    const st = stats[row.id], card = cardOf(row), e = economics(row, idx, coverFrom, nowS), erp = erpOf(row);
    const sim = simReady && !customOrder(row.title) ? similarFor(row, pieceOf(row.title, erp, vocab), soldYear) : null;
    return { row, st, card, e, erp, sim, ...nudge(verdict(row, st, card, nowMs, e, idx.fee), st, sim) };
  }), [work, stats, stock, listings, idx, coverFrom, soldYear, simReady, vocab]); // eslint-disable-line react-hooks/exhaustive-deps
  const counts = judged.reduce((m, j) => (m[j.v] = (m[j.v] || 0) + 1, m), {});
  // Recent sales count most, but a listing that has sold for years isn't buried under one good month.
  const rank = j => (j.st?.u120 || 0) * 1000 + (j.st?.u365 || 0) * 100 + (j.st?.units || 0) * 10 + (j.row.favs || 0) / 10;
  const visible = judged
    .filter(j => only === "all" || j.v === only)
    .sort((a, b) => sort === "best" ? rank(b) - rank(a) || b.row.ends - a.row.ends
      : view === "ending" ? a.row.ends - b.row.ends : b.row.ends - a.row.ends);

  const flight = useRef(false);
  const [busy, setBusy] = useState("");   // "" | "stats" | "ledger" | "briefs"
  // Pictures of the similar pieces on screen: one listing_brief call for up to a hundred.
  const briefIds = [...new Set(visible.slice(0, shown).flatMap(j => (j.sim?.items || []).map(x => x.lid)))].filter(id => !briefs[id]);
  useEffect(() => {
    if (!ready || flight.current) return;
    const onScreen = new Set(work.slice(0, shown).map(r => r.id));
    const seen = missing.filter(r => onScreen.has(r.id));
    const job = !statsErr && seen.length ? { kind: "stats", rows: seen.slice(0, BATCH) }
      : !ledgerErr && missingWins.length ? { kind: "ledger", ks: missingWins.slice(0, 3) }
      : briefIds.length ? { kind: "briefs", ids: briefIds.slice(0, 100) }
      : !statsErr && missing.length ? { kind: "stats", rows: missing.slice(0, BATCH) } : null;
    if (!job) return;
    flight.current = true;
    setBusy(job.kind);
    const done = () => { flight.current = false; if (alive.current) setBusy(""); };
    if (job.kind === "stats") {
      etsyFetch(`/api/etsy?action=renewal_stats&ids=${job.rows.map(r => r.id).join(",")}&_=${Date.now()}`)
        .then(d => {
          if (!alive.current) return;
          const at = Date.now();
          setStats(prev => {
            const next = { ...prev };
            for (const [id, st] of Object.entries(d.stats || {})) next[id] = { ...st, at };
            // Only what this queue still holds is worth keeping on the device.
            store.set(STATS_CACHE, Object.fromEntries(Object.entries(next).filter(([id, st]) => rowById.has(id) && !st.error)));
            return next;
          });
        })
        .catch(e => { if (alive.current) setStatsErr(e.message || "Couldn't read sales"); })
        .finally(done);
    } else if (job.kind === "briefs") {
      // A listing Etsy no longer has comes back missing; it's noted, so it isn't asked again.
      const keep = items => setBriefs(prev => {
        const next = { ...prev };
        for (const id of job.ids) next[id] = { missing: true };
        for (const b of items) next[b.id] = { img: b.img || "", title: unescape(b.title), state: b.state || "" };
        store.set(BRIEFS_CACHE, next);
        return next;
      });
      etsyFetch(`/api/etsy?action=listing_brief&ids=${job.ids.join(",")}&_=${Date.now()}`)
        .then(d => { if (alive.current) keep(d.items || []); })
        .catch(() => { if (alive.current) keep([]); })
        .finally(done);
    } else {
      etsyFetch(`/api/etsy?action=renewal_ledger&k=${job.ks.join(",")}&_=${Date.now()}`)
        .then(d => {
          if (!alive.current) return;
          const at = Date.now();
          setLedger(prev => {
            const next = { ...prev };
            for (const w of d.windows || []) if (w && Number.isFinite(w.k)) next[w.k] = { ...w, at };
            for (const k of Object.keys(next)) if (+k < kFloor) delete next[k];
            store.set(LEDGER_CACHE, Object.fromEntries(Object.entries(next).filter(([, w]) => !w.error)));
            return next;
          });
        })
        .catch(e => { if (alive.current) setLedgerErr(e.message || "Couldn't read Etsy's ledger"); })
        .finally(done);
    }
  }, [ready, missing.length, missingWins.length, briefIds.length, busy, statsErr, ledgerErr, view, shown, data]); // eslint-disable-line react-hooks/exhaustive-deps

  const renew = async j => {
    setOpening(j.row.id);
    try { await onRenew(j.row); }
    catch (e) { showToast?.(`⚠ Couldn't open it: ${e.message}`, 8000); }
    if (alive.current) setOpening("");
  };

  const chip = (key, label, n) => (
    <button key={key} type="button" onClick={() => { setView(key); setShown(PAGE); setOnly("all"); }}
      style={{ padding: "7px 13px", borderRadius: 20, fontSize: 12.5, fontWeight: view === key ? 800 : 600, cursor: "pointer", whiteSpace: "nowrap",
        border: `1.5px solid ${view === key ? C.ink : C.border}`, background: view === key ? C.ink : C.surface, color: view === key ? "#FAF0DC" : C.ink }}>
      {label}{n != null ? ` · ${n}` : ""}
    </button>
  );
  const small = { fontSize: 11.5, color: C.inkFaint };
  const pill = (active, onClick, children) => (
    <button type="button" onClick={onClick} style={{ border: "none", background: active ? C.card : "transparent", color: active ? C.ink : C.inkMid, fontWeight: active ? 800 : 600, fontSize: 12, padding: "5px 10px", borderRadius: 7, cursor: "pointer" }}>{children}</button>
  );

  const statsRead = work.length - missing.length;
  const adsLast = ledger[kNow - 1] && !ledger[kNow - 1].error ? ledger[kNow - 1].ads : null;

  return (
    <div>
      {/* heading */}
      <div style={{ display: "flex", alignItems: "flex-end", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <div style={{ fontFamily: serif, fontSize: 28, color: C.ink, lineHeight: 1.1 }}>Renew on Etsy</div>
          <div style={{ fontSize: 12.5, color: C.inkMid, marginTop: 4, lineHeight: 1.5 }}>
            An Etsy listing runs four months. Renewing an expired one costs ${RENEW_USD.toFixed(2)} and puts it back for another four — it goes through the listing steps first, so it's checked and tied to its stock card.
            {" "}For one about to end, Renew turns on auto-renew so Etsy renews it when it ends.
          </div>
        </div>
        <div style={{ ...small, textAlign: "right" }}>
          {loading ? "Reading Etsy…" : loadedAt ? `Read ${nowMs - loadedAt < 3600000 ? `${Math.max(1, Math.round((nowMs - loadedAt) / 60000))} min` : `${Math.round((nowMs - loadedAt) / 3600000)} h`} ago` : ""}
          {" "}<button type="button" onClick={() => loadQueue(true)} disabled={loading} style={{ marginLeft: 6, border: `1px solid ${C.border}`, background: C.surface, color: C.ink, borderRadius: 7, padding: "5px 10px", fontSize: 12, fontWeight: 700, cursor: loading ? "wait" : "pointer" }}>↻ Refresh</button>
        </div>
      </div>

      {err && <div style={{ background: C.redBg, color: C.red, borderRadius: 10, padding: "10px 14px", fontSize: 13, marginBottom: 12 }}>⚠ Couldn't read the listings from Etsy — {err}</div>}
      {!data && loading && <div style={{ padding: 40, textAlign: "center", color: C.inkMid, fontSize: 13 }}>Reading expired and ending listings from Etsy… (a few seconds)</div>}

      {data && <>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          {chip("expired", "Expired", lists.expired.length)}
          {chip("ending", `Ending in ${data.days} days`, lists.ending.length)}
          {chip("skipped", "Skipped", lists.skipped.length)}
          {chip("renewed", "Renewed", lists.renewed.length)}
        </div>

        {(view === "expired" || view === "ending") && <>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
            <span style={{ ...small, marginRight: 2 }}>Suggested</span>
            {pill(only === "all", () => setOnly("all"), `All ${work.length}`)}
            {pill(only === "renew", () => setOnly("renew"), `Renew ${counts.renew || 0}`)}
            {pill(only === "maybe", () => setOnly("maybe"), `Maybe ${counts.maybe || 0}`)}
            {pill(only === "skip", () => setOnly("skip"), `Skip ${counts.skip || 0}`)}
            <div style={{ flex: 1 }} />
            <span style={{ ...small, marginRight: 2 }}>Order</span>
            {pill(sort === "recent", () => setSort("recent"), view === "ending" ? "Ending soonest" : "Ended most recently")}
            {pill(sort === "best", () => setSort("best"), "Best sellers first")}
          </div>
          <div style={{ ...small, marginBottom: 12 }}>
            {view === "expired"
              ? `${plural(data.counts?.expired || 0, "expired listing")} on Etsy · the last ${data.back} days shown`
              : `${plural(data.counts?.ending || 0, "listing")} ending in ${data.days} days${autoCount ? ` · ${autoCount} already auto-renew` : ""}`}
            {" · "}{missing.length ? `sales read for ${statsRead} of ${work.length}${busy === "stats" ? "…" : ""}` : "sales read for all"}
            {counts.renew ? ` · renewing the ${counts.renew} suggested ≈ $${(counts.renew * RENEW_USD).toFixed(2)}` : ""}
            {view === "expired" ? " · Etsy shows no views for a listing once it has expired" : ""}
          </div>
          <div style={{ ...small, marginTop: -8, marginBottom: 12 }}>
            {coverFrom ? `Fees and earnings from Etsy's ledger since ${monthOf(coverFrom)}` : "Etsy's fee ledger"}
            {missingWins.length ? `${coverFrom ? ", reading" : " — reading"} back to ${monthOf(EPOCH + kMin * WIN)}${busy === "ledger" ? "…" : ""}` : ""}
            {" · a term is one listing or renewal fee, four months on the shop"}
            {adsLast != null ? ` · Etsy Ads (${inr(adsLast)} the last 30 days) are bought for the whole shop, so no listing's fees include them` : ""}
          </div>
          {statsErr && <div style={{ background: C.amberBg, color: C.amber, borderRadius: 10, padding: "8px 12px", fontSize: 12.5, marginBottom: 10 }}>
            ⚠ Sales stopped loading — {statsErr} <button type="button" onClick={() => setStatsErr("")} style={{ marginLeft: 6, border: "none", background: "none", color: C.ink, fontWeight: 800, cursor: "pointer", textDecoration: "underline" }}>Try again</button>
          </div>}
          {ledgerErr && <div style={{ background: C.amberBg, color: C.amber, borderRadius: 10, padding: "8px 12px", fontSize: 12.5, marginBottom: 10 }}>
            ⚠ Fees stopped loading — {ledgerErr} <button type="button" onClick={() => setLedgerErr("")} style={{ marginLeft: 6, border: "none", background: "none", color: C.ink, fontWeight: 800, cursor: "pointer", textDecoration: "underline" }}>Try again</button>
          </div>}

          {!visible.length && <div style={{ padding: 36, textAlign: "center", color: C.inkMid, fontSize: 13 }}>
            {work.length ? "Nothing with that suggestion." : view === "expired" ? "Nothing expired to look at." : "Nothing ending without auto-renew."}
          </div>}

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {visible.slice(0, shown).map(j => <Row key={j.row.id} j={j} nowMs={nowMs} fee={idx.fee} usdRate={usdRate} briefs={briefs} simReady={simReady} opening={opening === j.row.id} onRenew={() => renew(j)} onSkip={() => skip(j.row)} />)}
          </div>
          {visible.length > shown && <button type="button" onClick={() => setShown(n => n + PAGE)}
            style={{ display: "block", margin: "14px auto 0", border: `1px solid ${C.border}`, background: C.surface, color: C.ink, borderRadius: 9, padding: "10px 18px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
            Show {Math.min(PAGE, visible.length - shown)} more · {visible.length - shown} left</button>}
        </>}

        {(view === "skipped" || view === "renewed") && (
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12 }}>
            {!lists[view].length && <div style={{ padding: 24, textAlign: "center", color: C.inkMid, fontSize: 13 }}>{view === "skipped" ? "Nothing skipped." : "Nothing renewed from here yet."}</div>}
            {lists[view].map((d, i) => {
              const row = rowById.get(String(d.id));
              return (
                <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 14px", borderTop: i ? `1px solid ${C.border}` : "none" }}>
                  {row?.img ? <img src={row.img} alt="" style={{ width: 40, height: 40, borderRadius: 7, objectFit: "cover", flex: "none" }} /> : <div style={{ width: 40, height: 40, borderRadius: 7, background: C.card, flex: "none" }} />}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <a href={row?.url || `https://www.etsy.com/listing/${d.id}`} target="_blank" rel="noreferrer" style={{ fontSize: 13.5, fontWeight: 700, color: C.ink, textDecoration: "none", display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{unescape(d.title || row?.title || d.id)}</a>
                    <div style={small}>{view === "skipped" ? "Skipped" : "Renewed"} {new Date(d.at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}{d.by ? ` by ${d.by}` : ""}{row ? ` · ${row.state === "expired" ? `ended ${when(row.ends)}` : `ends ${when(row.ends)}`}` : ""}</div>
                  </div>
                  {view === "skipped" && <button type="button" onClick={() => unskip(d.id)} style={{ border: `1px solid ${C.border}`, background: C.surface, color: C.ink, borderRadius: 8, padding: "6px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>Back to the queue</button>}
                </div>
              );
            })}
          </div>
        )}
      </>}
    </div>
  );
}

function Row({ j, nowMs, fee, usdRate, briefs, simReady, opening, onRenew, onSkip }) {
  const { row, st, card, erp, e, sim, v, why } = j;
  const phone = mob();
  const tone = TONE[v] || TONE[""];
  const expired = row.state === "expired";
  const ageMs = nowMs - row.first * 1000;
  // A draft published days after it was made moves the date too; that isn't a renewal.
  const renewedBefore = row.renewed > row.first + 30 * 86400;
  const none = !st && v ? "—" : "…";   // no sales to read (a custom order, an empty card) vs still reading
  const sold = st && !st.error;
  const stat = (big, label, title, color) => (
    <div title={title} style={{ minWidth: 0 }}>
      <div style={{ fontFamily: serif, fontVariantNumeric: "lining-nums", fontSize: 19, color: color || C.ink, lineHeight: 1.1, whiteSpace: "nowrap" }}>{big}</div>
      <div style={{ fontSize: 10.5, color: C.inkFaint, marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</div>
    </div>
  );
  /* Sold for: what the ledger saw it sell for (after coupons and refunds)
     when it covers the listing's whole life; else the lifetime list prices. */
  const revenue = e?.covered ? e.revenue : sold ? st.revenue : null;
  const since = e && !e.covered ? ` since ${monthOf(e.since)}` : "";
  const months = d => d >= 45 ? `${Math.round(d / 30.4)} months` : `${Math.round(d)} days`;
  const p = e?.parts;
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderLeft: `3px solid ${tone.fg}`, borderRadius: 12, padding: phone ? 12 : "12px 16px", display: "flex", gap: 14, flexDirection: phone ? "column" : "row", alignItems: phone ? "stretch" : "center" }}>
      <div style={{ display: "flex", gap: 12, flex: 1, minWidth: 0 }}>
        <a href={row.url} target="_blank" rel="noreferrer" style={{ flex: "none" }}>
          {row.img ? <img src={row.img} alt="" style={{ width: 76, height: 76, borderRadius: 9, objectFit: "cover", background: C.card }} />
            : <div style={{ width: 76, height: 76, borderRadius: 9, background: C.card }} />}
        </a>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: ".04em", color: tone.fg, background: tone.bg, borderRadius: 6, padding: "2px 8px", flex: "none" }}>{tone.label}</span>
            <span style={{ fontSize: 12, color: v ? C.ink : C.inkFaint, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{why}</span>
          </div>
          <a href={row.url} target="_blank" rel="noreferrer" style={{ display: "block", fontSize: 14, fontWeight: 700, color: C.ink, textDecoration: "none", marginTop: 5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{unescape(row.title)}</a>
          <div style={{ fontSize: 11.5, color: C.inkMid, marginTop: 3 }}>
            {expired ? `Ended ${ago(nowMs - row.ends * 1000)}` : row.ends * 1000 - nowMs < DAY ? "Ends today" : `Ends in ${span(row.ends * 1000 - nowMs)}`}
            {` · ${inr(row.price)}${row.variations ? " and up" : ""} · ${row.qty} left`}
            {renewedBefore ? ` · last renewed ${when(row.renewed)}` : ""}
            {` · ♥ ${row.favs}${expired ? "" : ` · ${row.views ?? "—"} views`}`}
            {e?.covered && e.terms ? ` · on sale ${months(e.liveDays)} of ${months(e.spanDays)}` : ""}
            {e && !e.covered ? ` · fees counted${since} — listed before that` : ""}
          </div>
          <div style={{ fontSize: 11.5, marginTop: 3, color: card ? C.inkMid : C.amber, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {card ? `📦 ${card.sku || card.material || "Stock card"} · ${card.qty || 0} ${card.unit || ""}${+card.qty2 ? ` / ${card.qty2} ${card.unit2 || ""}` : ""}${card.location ? ` · 📍 ${card.location}` : ""}`
              : erp ? "In the ERP, not tied to a stock card — the steps ask for it" : "Not in the ERP yet — the steps tie it to its stock card"}
          </div>
          {sim ? (
            <div style={{ marginTop: 5 }}>
              <div title={sim.tier === "band" ? "Same stone and shape, listed within 40% of this one's price, sold in the last 12 months"
                  : sim.tier === "shape" ? "Same stone and shape, at any price — none near this one's price sold in the last 12 months"
                  : sim.tier === "stone" ? `Nothing ${sim.shape ? `shaped as a ${sim.shape.toLowerCase()}` : "of this shape"} sold — the same stone in any shape` : ""}
                style={{ fontSize: 11.5, color: sim.units ? C.inkMid : C.inkFaint, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {sim.units ? <>🔎 Similar sold: <b style={{ color: C.ink }}>{sim.units}</b> {sim.label} in 12 months · {inr(sim.avg)} avg · last {ago(nowMs - sim.last * 1000)}</>
                  : `🔎 Nothing like it (${titleCase(sim.stone)}${sim.shape ? ` · ${sim.shape}` : ""}) sold in the last 12 months`}
              </div>
              {sim.items.length > 0 && <div style={{ display: "flex", gap: 10, marginTop: 5, flexWrap: "wrap" }}>
                {sim.items.map(x => {
                  const b = briefs?.[x.lid];
                  return (
                    <a key={x.lid} href={`https://www.etsy.com/listing/${x.lid}`} target="_blank" rel="noreferrer"
                      title={`${x.title || b?.title || ""} · listed at ${inr(x.unit)}, sold for ${inr(x.paid)} on ${when(x.ts)}`}
                      style={{ display: "flex", gap: 6, alignItems: "center", textDecoration: "none", maxWidth: 168, minWidth: 0 }}>
                      {b?.img ? <img src={b.img} alt="" style={{ width: 30, height: 30, borderRadius: 6, objectFit: "cover", flex: "none" }} />
                        : <span style={{ width: 30, height: 30, borderRadius: 6, background: C.card, flex: "none" }} />}
                      <span style={{ minWidth: 0, lineHeight: 1.25 }}>
                        <span style={{ display: "block", fontSize: 10.5, color: C.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{x.title || b?.title || "Listing"}</span>
                        <span style={{ display: "block", fontSize: 10.5, color: C.inkFaint, whiteSpace: "nowrap" }}>{inrK(x.paid)} · {ago(nowMs - x.ts * 1000)}</span>
                      </span>
                    </a>
                  );
                })}
              </div>}
            </div>
          ) : !simReady && !customOrder(row.title) ? <div style={{ fontSize: 11.5, color: C.inkFaint, marginTop: 5 }}>🔎 Looking for similar pieces that sold…</div> : null}
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: "8px 10px", width: phone ? "100%" : 372, flex: "none" }}>
        {stat(span(ageMs), "since first listed", `First listed ${when(row.first)}`)}
        {stat(sold ? st.units : none, sold ? `sold · ${st.u365} this yr` : "sold",
          sold ? `${st.orders} order${st.orders === 1 ? "" : "s"} · ${st.u120} in the last four months, ${st.u365} in the last year${st.last ? ` · last sold ${when(st.last)}` : ""}` : "")}
        {stat(revenue != null ? inrK(revenue) : none, usdRate && revenue ? `sold for · ${usd(revenue, usdRate)}` : "sold for",
          revenue == null ? "" : e?.covered ? `${inr(revenue)}${usdRate ? ` (${usd(revenue, usdRate)})` : ""} — what its orders came to after coupons and refunds, cancelled ones out`
            : `${inr(revenue)}${usdRate ? ` (${usd(revenue, usdRate)})` : ""} at its listed prices, over its life`)}
        {stat(sold ? (st.last ? span(nowMs - st.last * 1000) : "never") : none, st?.last ? "since last sale" : "last sale", st?.last ? when(st.last) : "")}
        {stat(e ? `${e.renewals}×` : "…", "renewed",
          e ? [`${e.n.x} when it expired`, `${e.n.s} after a sale (Etsy renews a listing with more in stock each time one sells)`, e.n.r ? `${e.n.r} other` : "",
            e.n.l ? `listed ${e.n.l === 1 ? "once" : `${e.n.l} times`}` : e.covered ? "" : `first listed before ${monthOf(e.since)}`, e.n.p ? `${e.n.p} private listing` : ""].filter(Boolean).join(" · ") + ` — ${inr(e.listing)} in listing fees${since}` : "Reading Etsy's fee ledger…")}
        {stat(e ? inrK(e.spent) : "…", "Etsy fees",
          e ? `${inr(e.spent)}${usdRate ? ` (${usd(e.spent, usdRate)})` : ""}: listing and renewals ${inr(e.listing)} · transaction ${inr(p.transaction)} · processing ${inr(p.processing)} · shipping fee ${inr(p.shipping)} · offsite ads ${inr(p.offsite)}${p.other ? ` · other ${inr(p.other)}` : ""}. An order's own fees are split by this item's share of it. Etsy Ads aren't here — they're bought for the whole shop.` : "Reading Etsy's fee ledger…")}
        {stat(e ? inrK(e.net) : "…", usdRate && e ? `net · ${usd(e.net, usdRate)}` : "net after fees",
          e ? `${inr(e.revenue)} sold for${since} − ${inr(e.spent)} Etsy fees = ${inr(e.net)}. The stone's own cost isn't taken off.` : "", e ? (e.net > 0 ? C.green : e.net < 0 ? C.red : C.ink) : undefined)}
        {stat(e && e.perTerm != null ? inrK(e.perTerm) : e ? "—" : "…", `per ${inr(fee)} term`,
          e && e.perTerm != null ? `What each listing or renewal fee (${inr(fee)} — $0.20 — for four months on the shop) has brought back after Etsy's fees: ${inr(e.net)} over ${plural(e.terms, "term")}${since}` : e ? `No listing or renewal fee${since} to measure against` : "", e?.perTerm != null ? (e.perTerm >= 20 * fee ? C.green : e.perTerm <= 0 ? C.red : C.ink) : undefined)}
      </div>
      <div style={{ display: "flex", gap: 8, flexDirection: phone ? "row" : "column", flex: "none", width: phone ? "100%" : 128 }}>
        <button type="button" onClick={onRenew} disabled={opening}
          style={{ flex: 1, padding: "10px 12px", borderRadius: 9, border: "none", background: C.ink, color: "#FAF0DC", fontWeight: 800, fontSize: 13, cursor: opening ? "wait" : "pointer" }}>
          {opening ? "Opening…" : expired ? "Renew →" : "Keep it up →"}</button>
        <button type="button" onClick={onSkip}
          style={{ flex: 1, padding: "9px 12px", borderRadius: 9, border: `1px solid ${C.border}`, background: C.surface, color: C.inkMid, fontWeight: 700, fontSize: 12.5, cursor: "pointer" }}>Skip</button>
      </div>
    </div>
  );
}
