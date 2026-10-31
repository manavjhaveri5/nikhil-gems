import { useState, useEffect, useMemo } from "react";
import { C, mob, FI } from "./lmTheme.js";
import { loadK, loadKFresh, upsertItemK, upsertVersionedItemK } from "./utils.js";
import { EARTH_LOGO_URL, KEYS } from "./constants.js";
import { loadLiveTrade, setTradePrice, TRADE_SITE } from "./TradeSiteApp.jsx";
import { loadStoreFacts, loadStoreProduct, publishListingToStore } from "./StoreApp.jsx";

const STORE_SITE = "https://eartheditions.co";

/* Listings live in the one store the Listing Manager writes; a send stamps the
   pieces it went out with, so the next mailer can see what has already been
   shown to the list. */
const LIST_KEY = "ng-listings-v1";

/* Campaign composer — shared by the Omnisend module (primary home) and the
   Listing Manager's contextual "Campaign" button, so both drive one implementation.
   Campaigns are only ever created as drafts here; sending is a separate, confirmed
   action because a blast to the subscriber list cannot be undone. */
/* The list has run to the same two conventions for months: a shouted subject
   carrying the send date, and an internal name that is just the date written
   plainly. Both are derived rather than typed, so a new campaign starts correct. */
const MONTHS = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];
const _today = new Date();
const MAILER_DATE = `${_today.getDate()} ${MONTHS[_today.getMonth()]} ${_today.getFullYear()}`;
const ordinal = d => d + (d > 3 && d < 21 ? "th" : ["th", "st", "nd", "rd"][d % 10] || "th");
const CAMPAIGN_NAME = `${ordinal(_today.getDate())} ${MONTHS[_today.getMonth()][0]}${MONTHS[_today.getMonth()].slice(1).toLowerCase()} ${_today.getFullYear()}`;

/* The five things a card actually says. Everything else about the card is a
   design decision that belongs to the whole mailer, not to one product. */
const OVERRIDABLE = [
  { key: "title", label: "Card title", wide: true },
  { key: "meta", label: "Meta line", wide: true, hideKey: "hideMeta", hideLabel: "Print the detail line on this card" },
  { key: "price", label: "Price as printed", hideKey: "hidePrice", hideLabel: "Print the price on this card" },
  { key: "url", label: "Link" },
];

/* A row's prices where they live, each shown as it stands and saved where it
   belongs; only the ones changed are written. `fields` come from the composer:
   { k, label, unit, value, note, blocked } or { info } for a line of text. */
function PriceEditor({ fields, busy, err, onSave, onCancel }) {
  const start = f => (f.value ? String(f.value) : "");
  const [vals, setVals] = useState(() => Object.fromEntries(fields.filter(f => f.k).map(f => [f.k, start(f)])));
  const [bad, setBad] = useState("");
  const save = () => {
    const ch = {};
    for (const f of fields) {
      if (!f.k || f.blocked || vals[f.k] === start(f)) continue;
      const v = vals[f.k] === "" ? 0 : Math.round(+vals[f.k] * 100) / 100;
      if (!(v >= 0)) { setBad(`${f.label}: type a price`); return; }
      ch[f.k] = v;
    }
    if (!Object.keys(ch).length) { onCancel(); return; }
    setBad(""); onSave(ch);
  };
  const first = fields.find(f => f.k && !f.blocked)?.k;
  return (
    <div style={{ padding: "0 8px 10px 51px", display: "grid", gap: 8 }}>
      {fields.map((f, i) => f.info ? <div key={`i${i}`} style={{ fontSize: 10.5, color: C.inkFaint, lineHeight: 1.45 }}>{f.info}</div> : (
        <div key={f.k}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: C.inkMid, marginBottom: 3 }}>{f.label} <span style={{ fontWeight: 500, color: C.inkFaint }}>· USD{f.unit ? ` per ${f.unit}` : ""}</span></div>
          {f.blocked ? <div style={{ fontSize: 11, color: C.inkMid, lineHeight: 1.45 }}>{f.blocked}</div> : <>
            <input type="number" min="0" step="0.01" autoFocus={f.k === first} value={vals[f.k]} placeholder="no price"
              onChange={e => { const v = e.target.value; setVals(o => ({ ...o, [f.k]: v })); setBad(""); }}
              onKeyDown={e => { if (e.key === "Enter") save(); if (e.key === "Escape") onCancel(); }}
              style={{ ...FI(), fontSize: 12, padding: "5px 7px", width: "100%", boxSizing: "border-box" }} />
            {f.note && <div style={{ fontSize: 10, color: C.inkFaint, marginTop: 2, lineHeight: 1.4 }}>{f.note}</div>}
          </>}
        </div>
      ))}
      <div style={{ display: "flex", gap: 6 }}>
        <button type="button" disabled={busy} onClick={save}
          style={{ background: C.teal, color: "#fff", border: "none", borderRadius: 6, padding: "5px 14px", fontSize: 11.5, fontWeight: 700, cursor: busy ? "default" : "pointer", opacity: busy ? .6 : 1 }}>{busy ? "Saving…" : "Save"}</button>
        <button type="button" onClick={onCancel}
          style={{ border: `1px solid ${C.border}`, background: "transparent", color: C.inkFaint, borderRadius: 6, padding: "5px 9px", fontSize: 11, cursor: "pointer" }}>Cancel</button>
      </div>
      {(bad || err) && <div style={{ fontSize: 11, color: C.red, lineHeight: 1.45 }}>{bad || err}</div>}
    </div>
  );
}

export default function CampaignComposer({ listings = [], onClose, showToast }) {
  const [sel, setSel] = useState(() => new Set());
  /* The in-stock banner splits the mailer: pieces marked as a deal print under
     it, everything else above. Mark none and the banner stays where it was,
     above the whole run of products. */
  const [deals, setDeals] = useState(() => new Set());
  /* Per-card copy for this mailer only. A listing is written for its storefront;
     the card that sells it in an email sometimes wants a shorter name, a lot
     price, or the second photo. Overrides are keyed by listing id and hold only
     the fields actually typed — a blank one falls back to the listing, so the
     card follows later catalogue edits until the moment it is overridden.
     Nothing here is written back to the listing. */
  const [overrides, setOverrides] = useState({});
  const [editing, setEditing] = useState("");
  const [q, setQ] = useState("");
  /* The picker shows the listings, everything live on the trade site (most
     of it made there, with no listing), or the stock cards in stock — the
     lots and repeatable lines to offer as deals. A trade product that came
     from a listing is that listing, so picking it in either view is the same
     pick, and a send marks it as mailed; the rest have nowhere to keep that. */
  const [source, setSource] = useState("listings");
  const [trade, setTrade] = useState(null); // live trade products, once asked for
  const [stockCards, setStockCards] = useState(null); // likewise the stock cards
  const [storeMap, setStoreMap] = useState(null); // eartheditions.co's products, by listing id
  const [loadErr, setLoadErr] = useState("");
  const [pricing, setPricing] = useState(null); // { id, busy, err }: the row whose prices are open
  // Prices saved on listings this session: the listings prop is the one handed in when the composer opened.
  const [patched, setPatched] = useState({});
  const [brand, setBrand] = useState("Nikhil Gems");
  const [heading, setHeading] = useState("New arrivals");
  // Every mailer is the same weekly list with a new date on it, so the subject
  // writes itself. Still a plain field — a one-off can say something else.
  const [subject, setSubject] = useState(() => `NIKHIL GEMS - WEEKLY MAILING LIST - ${MAILER_DATE}`);
  const [preheader, setPreheader] = useState("");
  /* Every mailer has opened with the same line telling the reader why it landed
     in their inbox — the standing broadcast-list note. It is prefilled like the
     other standing furniture (promo, shipping, trade) rather than retyped each
     week; clear the field to drop the paragraph entirely. */
  const [intro, setIntro] = useState(
    "You're receiving this email as part of the Nikhil Gems broadcast list, where we share weekly updates on new stones, carvings, and special lots available for order."
  );
  const [senderName, setSenderName] = useState("Nikhil Gems");
  const [senderEmail, setSenderEmail] = useState("");
  // The list is trade buyers: trade prices and the trade site's pages unless another storefront is chosen.
  const [priceMode, setPriceMode] = useState("trade");
  /* Design lives in one object so preview and the created draft can never drift
     apart — both are rendered from payloadBase() by the same server function. */
  const [design, setDesign] = useState({
    layout: "editorial",
    columns: 2, accent: "#9a6200", ink: "#1a1308", pageBg: "#e5e6e6", cardBg: "#ffffff",
    font: "serif", showPrice: true, showMeta: true, showCta: true, showDivider: false,
    cornerStyle: "square", ctaStyle: "outline", ctaLabel: "Shop now",
    headingSize: 26, footer: "",
    headerImage: EARTH_LOGO_URL,
    logoWidth: 150,
    // Editorial furniture — the standing trade CTA is pre-filled because it is
    // the same invitation on every mailer; blank the line to drop the panel.
    bannerImage: "", priceSuffix: "", dateLine: "",
    // The in-stock banner is drawn from these rather than uploaded as a graphic,
    // so it stays sharp, readable on a phone, and survives blocked images.
    promoRibbon: "Limited lots · Special pricing", promoTitle: "IN-STOCK SPECIALS",
    promoSubtitle: "Special prices · Shipping included",
    promoNote: "Current inventory available for immediate dispatch.",
    promoBadges: "📦 In stock | Available now\n🚚 Ready to ship | Quick dispatch\n🌐 Shipping included | No extra charges",
    promoColor: "#14331f",
    productColumns: 2,
    shipIcon: "✈️", shipTitle: "Duty free worldwide shipping",
    shipNote: "All orders ship DDP — the price you see is the price you pay. No customs fees, no import duties, no surprise charges on delivery. Your order clears at our end, not yours.",
    tradeEyebrow: "Trade access", tradeLine: "View full catalogue & wholesale pricing",
    tradeButton: "Log in to eartheditions.co", tradeUrl: "https://eartheditions.co/account/login",
    instagramUrl: "https://www.instagram.com/eartheditions_/?hl=fr", addressLine: "",
  });
  const [designOpen, setDesignOpen] = useState(false);
  const [segments, setSegments] = useState([]);
  const [segIds, setSegIds] = useState(() => new Set());
  const [configured, setConfigured] = useState(null); // null=checking
  const [previewHtml, setPreviewHtml] = useState("");
  const [campaignId, setCampaignId] = useState("");
  const [testTo, setTestTo] = useState("");
  const [testedOk, setTestedOk] = useState(false);
  const [busy, setBusy] = useState("");
  // Stamps written this session, so a row updates the moment the send lands
  // rather than waiting for the listings prop to come back around.
  const [stamps, setStamps] = useState({});
  const [err, setErr] = useState("");

  const post = async payload => {
    const r = await fetch("/api/omnisend", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) throw new Error(d.error || `Request failed (${r.status})`);
    return d;
  };

  useEffect(() => {
    (async () => {
      try {
        const s = await post({ action: "status" });
        setConfigured(!!s.configured && s.valid !== false);
        if (s.configured && s.valid === false) setErr(s.error || "Omnisend rejected the API key.");
        if (s.configured && s.valid !== false) {
          try { const g = await post({ action: "segments" }); setSegments(g.segments || []); } catch {}
        }
      } catch (e) { setConfigured(false); setErr(e.message); }
    })();
  }, []);

  /* Where each piece's price lives, read once the composer opens: the store
     products on eartheditions.co, the trade site's products and the stock
     cards. The email prints those prices, and a price set here is saved to
     them, so the email, the ERP and both sites agree. */
  useEffect(() => {
    const fail = what => e => setLoadErr(`Couldn't load ${what}: ${e.message}`);
    loadStoreFacts().then(setStoreMap).catch(fail("eartheditions.co's prices"));
    loadLiveTrade().then(setTrade).catch(fail("the trade site"));
    loadK(KEYS.stock).then(rows => setStockCards(Array.isArray(rows) ? rows : [])).catch(fail("the stock cards"));
  }, []);
  const UNIT = { pcs: "pc", gm: "g" };
  const cardFacts = c => ({ id: c.id, sku: c.sku || "", price: +c.listPrice || 0, unit: c.pricingMode ? "lot" : UNIT[c.unit] || c.unit || "pc", lot: !!c.pricingMode, region: c.region || "",
    qty: [c.qty && `${c.qty} ${c.unit || ""}`, c.qty2 && `${c.qty2} ${c.unit2 || ""}`].filter(Boolean).join(" · ") });
  const { pool, tradeView, stockView, cardById } = useMemo(() => {
    const base = listings.map(l => patched[l.id] ? { ...l, ...patched[l.id] } : l);
    const byId = new Map(base.map(l => [String(l.id), l]));
    const byProduct = new Map(base.filter(l => l.platforms?.trade?.product_id).map(l => [String(l.platforms.trade.product_id), l]));
    const tied = new Map(), only = [], view = [];
    for (const r of trade || []) {
      const t = { id: r.id, url: `${TRADE_SITE}/p/${r.id}`, price: +r.price || 0, unit: r.unit === "piece" || r.unit === "lot" ? r.unit : "kg", options: (r.variants || []).length };
      const lid = r.source?.listing_id || (String(r.id).startsWith("lm-") ? String(r.id).slice(3) : "");
      const l = byId.get(String(lid)) || byProduct.get(String(r.id));
      if (l) { if (!tied.has(l.id)) { const item = { ...l, _trade: t }; tied.set(l.id, item); view.push(item); } continue; }
      const item = { id: `trade:${r.id}`, noListing: true, title: r.title, material: r.material, shape: r.shape, description: r.description || "",
        images: (r.images || []).filter(u => typeof u === "string"), _trade: t };
      only.push(item); view.push(item);
    }
    // In stock: something left on the card and not sold. A lot priced by the kilo or piece keeps its rate in Stock.
    const cardById = new Map((stockCards || []).map(c => [c.id, c]));
    const cards = (stockCards || []).filter(c => (+c.qty > 0 || +c.qty2 > 0) && !c.soldDate).map(c => ({
      id: `stock:${c.id}`, noListing: true, title: [c.material, c.shape].filter(Boolean).join(" ") || c.sku || "Stock card",
      material: c.material, shape: c.shape, size: c.size, sku: c.sku,
      images: [...new Set([...(Array.isArray(c.photos) ? c.photos : []), c.photo].filter(u => typeof u === "string" && /^https?:/.test(u)))],
      _stock: cardFacts(c),
    }));
    return { pool: [...base.map(l => tied.get(l.id) || l), ...only, ...cards], tradeView: view, stockView: cards, cardById };
  }, [listings, patched, trade, stockCards]);
  const storeOf = l => (!l.noListing && storeMap?.[l.id]) || null;
  const cardOf = l => (!l.noListing && l.linked_stock_id && cardById.get(l.linked_stock_id)) || null;
  // What eartheditions.co charges: the store product's live price, else the listing's own store price, else the old Shopify one.
  const storePrice = l => +storeOf(l)?.price || +l.price_store || +l.price_shopify_earth || 0;
  const storeLink = l => { const s = storeOf(l); return s?.status === "active" && s.handle ? `${STORE_SITE}/products/${s.handle}` : ""; };

  /* Setting a price saves it where it lives. A trade product or stock card
     has one home. A listing has up to three: its store price (pushed to
     eartheditions.co the way Listing Manager does), its trade price (on the
     product, and on the listing, which a sync would otherwise put back) and
     its stock card's, through the same versioned write Stock uses. */
  const saveCard = async (id, v) => {
    const card = ((await loadKFresh(KEYS.stock)) || []).find(c => c.id === id);
    if (!card) throw new Error("That stock card is gone");
    if (card.pricingMode) throw new Error("That card is priced as a lot: set it in Stock");
    const listPrice = v ? String(v) : "";
    await upsertVersionedItemK(KEYS.stock, { ...card, listPrice, updatedAt: new Date().toISOString() }, { prepend: false });
    setStockCards(cs => (cs || []).map(c => c.id === id ? { ...card, listPrice } : c));
  };
  const saveTrade = async (id, v) => {
    await setTradePrice(id, v);
    setTrade(rs => (rs || []).map(r => r.id === id ? { ...r, price: v, variants: (r.variants || []).map(x => ({ ...x, price: v })) } : r));
  };
  const savePrices = async (l, ch) => {
    setPricing(p => ({ ...p, busy: true, err: "" }));
    const done = [];
    try {
      if (l._stock) { await saveCard(l._stock.id, ch.card); done.push("the stock card"); }
      else if (l.noListing) { await saveTrade(l._trade.id, ch.trade); done.push("the trade site"); }
      else {
        const str = v => (v ? String(v) : "");
        const patch = { ...("store" in ch ? { price_store: str(ch.store) } : {}), ...("trade" in ch ? { price_trade: str(ch.trade) } : {}) };
        let row = null;
        if (Object.keys(patch).length) {
          row = ((await loadKFresh(LIST_KEY)) || []).find(x => x.id === l.id);
          if (!row) throw new Error("That listing is gone");
          row = { ...row, ...patch, updated_at: new Date().toISOString() };
          await upsertItemK(LIST_KEY, row, { prepend: false });
          setPatched(m => ({ ...m, [l.id]: { ...(m[l.id] || {}), ...patch } }));
        }
        if ("store" in ch) {
          if (storeOf(l)) {
            await publishListingToStore(row, { syncOnly: true, override: ["price"] });
            const sp = await loadStoreProduct(l.id).catch(() => null);
            setStoreMap(m => ({ ...m, [l.id]: { ...(m?.[l.id] || {}), ...(sp || { price: ch.store }) } }));
            done.push("eartheditions.co");
          } else done.push("the listing (it isn't on eartheditions.co yet)");
        }
        if ("trade" in ch) { if (l._trade) { await saveTrade(l._trade.id, ch.trade); done.push("the trade site"); } else done.push("the listing's trade price"); }
        if ("card" in ch && cardOf(l)) { await saveCard(cardOf(l).id, ch.card); done.push("its stock card"); }
      }
      setPricing(null); invalidate();
      showToast?.(`✓ Price saved: ${done.join(", ")}`);
    } catch (e) { setPricing(p => ({ ...p, busy: false, err: done.length ? `Saved to ${done.join(", ")} — then: ${e.message}` : e.message })); }
  };

  /* The prices a row's editor shows: a trade product's or stock card's own,
     or a listing's three — trade first, as the list is mostly trade buyers. */
  const blockedOptions = t => t?.options > 1 && <>It has {t.options} options with their own prices: <a href={t.url} target="_blank" rel="noreferrer" style={{ color: C.teal, fontWeight: 700 }}>price them on the trade site</a>.</>;
  const lotNote = "Priced as a lot, by the kilo or piece: set it on the card in Stock, where the rate is kept with it.";
  const priceFields = l => {
    if (l._stock) return [{ k: "card", label: `📦 Stock card${l._stock.sku ? ` ${l._stock.sku}` : ""}`, unit: l._stock.unit, value: l._stock.price, note: "Saved on the stock card.", blocked: l._stock.lot && lotNote }];
    if (l.noListing) return [{ k: "trade", label: "🤝 Trade site", unit: l._trade.unit, value: l._trade.price, note: "0 = price on request. Buyers see it straight away.", blocked: blockedOptions(l._trade) }];
    const st = storeOf(l), c = cardOf(l), cf = c && cardFacts(c);
    return [
      { k: "trade", label: "🤝 Trade site", unit: l._trade?.unit, value: l._trade ? l._trade.price : +l.price_trade || 0, blocked: blockedOptions(l._trade),
        note: l._trade ? "On the trade site: buyers see it straight away." : "Not on the trade site: kept on the listing for when it goes up." },
      { k: "store", label: "🛒 eartheditions.co", value: storePrice(l),
        note: st ? (st.status === "active" ? "Live on eartheditions.co." : `On eartheditions.co (${st.status}).`) + (+l.price_store > 0 ? "" : " Follows the Etsy price until you set one.") : "Not on eartheditions.co: kept on the listing." },
      cf ? { k: "card", label: `📦 Stock card${cf.sku ? ` ${cf.sku}` : ""}`, unit: cf.unit, value: cf.price, note: [cf.qty, cf.region].filter(Boolean).join(" · ") || "Its stock card.", blocked: cf.lot && lotNote }
        : { info: "No stock card linked: link one on the listing in Listing Manager to price it here too." },
    ];
  };

  // Money shown per product depends on which storefront the mailer is for —
  // Earth Editions is wholesale/login-to-view, so "no prices" is a first-class option.
  const priceOf = (l, mode = priceMode) => {
    const none = { price: "", priceValue: null, currency: "" };
    if (mode === "none") return none;
    // A trade product or stock card with no listing has one price, its own, whichever storefront is chosen.
    const own = l._stock || (l.noListing ? l._trade : null)
      || (mode === "trade" ? l._trade || (+l.price_trade > 0 ? { price: +l.price_trade, unit: "" } : null) : null);
    if (own || mode === "trade") {
      const v = own?.price || 0;
      return v ? { price: `$${v.toLocaleString("en-US")}${own.unit ? ` / ${own.unit}` : ""}`, priceValue: v, currency: "USD" } : none;
    }
    if (mode === "earth") { const v = storePrice(l); return v ? { price: `$${v.toLocaleString("en-US")}`, priceValue: v, currency: "USD" } : none; }
    const map = { aty: ["price_shopify_aty", "INR", "₹"], etsy: ["price_etsy", "INR", "₹"] };
    const [field, currency, sym] = map[mode] || [];
    const v = +l[field] || 0;
    if (!v) return none;
    return { price: `${sym}${v.toLocaleString(currency === "INR" ? "en-IN" : "en-US")}`, priceValue: v, currency };
  };
  // A card goes where its price comes from: the trade site's page with trade prices, eartheditions.co with its prices.
  const shopLink = l => (priceMode === "earth" && storeLink(l)) || l.platforms?.shopify_earth?.storefront_url || l.platforms?.shopify_aty?.storefront_url || l.platforms?.etsy?.url || l.platforms?.ebay?.url || storeLink(l) || "";
  const linkOf = l => priceMode === "trade" ? l._trade?.url || shopLink(l) : shopLink(l) || l._trade?.url || "";
  const metaOf = l => [l.material, l.shape, l.size].filter(Boolean).join(" · ");
  const baseProduct = l => ({
    id: l.id, title: l.title || "Untitled", deal: deals.has(l.id),
    image: (l.images || [])[0] || "",
    url: linkOf(l),
    meta: metaOf(l),
    description: l.description || "",
    ...priceOf(l),
  });
  const toProduct = l => {
    const o = overrides[l.id] || {};
    const p = baseProduct(l);
    for (const k of ["title", "meta", "price", "image", "url"]) {
      if (typeof o[k] === "string" && o[k].trim()) p[k] = o[k].trim();
    }
    // A card with no price reads as "ask us" — which is the point for a piece
    // whose number is negotiated, sitting beside pieces that print theirs.
    if (o.hidePrice) { p.price = ""; p.priceValue = null; }
    if (o.hideMeta) p.meta = "";
    return p;
  };
  const edited = l => ["hidePrice", "hideMeta"].some(k => (overrides[l.id] || {})[k])
    || [...OVERRIDABLE.map(f => f.key), "image"].some(k => (overrides[l.id] || {})[k]?.trim());
  const setOverride = (id, key, val) => {
    setOverrides(o => ({ ...o, [id]: { ...(o[id] || {}), [key]: val } }));
    invalidate();
  };
  const clearOverrides = id => { setOverrides(o => { const n = { ...o }; delete n[id]; return n; }); invalidate(); };

  const ql = q.toLowerCase();
  const visible = (source === "trade" ? tradeView : source === "stock" ? stockView : pool.slice(0, listings.length)).filter(l => !ql || `${l.title || ""} ${l.material || ""} ${l.sku || ""}`.toLowerCase().includes(ql));
  const chosen = pool.filter(l => sel.has(l.id));
  const products = chosen.map(toProduct);
  const payloadBase = () => ({ brand, heading, intro, products, ...design });

  const toggle = id => setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleDeal = id => { setDeals(d => { const n = new Set(d); n.has(id) ? n.delete(id) : n.add(id); return n; }); invalidate(); };
  // Any edit invalidates the draft that's already in Omnisend.
  const invalidate = () => { setCampaignId(""); setTestedOk(false); };
  // Any design change invalidates the draft already sitting in Omnisend.
  const setD = (k, v) => { setDesign(d => ({ ...d, [k]: v })); invalidate(); };

  const doPreview = async () => {
    setBusy("preview"); setErr("");
    try { const d = await post({ action: "preview", ...payloadBase() }); setPreviewHtml(d.html || ""); }
    catch (e) { setErr(e.message); } finally { setBusy(""); }
  };
  const doCreate = async () => {
    setBusy("create"); setErr("");
    try {
      await post({ action: "sync_products", products }).catch(() => {}); // catalog sync is best-effort
      const d = await post({
        action: "create_campaign", ...payloadBase(),
        // Omnisend's campaign name is internal-only; the date alone is how the
        // list has always been labelled there.
        name: CAMPAIGN_NAME, subject, preheader, senderName, senderEmail: senderEmail || undefined,
        segmentIds: [...segIds],
      });
      setCampaignId(d.campaignId); setTestedOk(false);
      showToast?.("✓ Draft created in Omnisend");
    } catch (e) { setErr(e.message); } finally { setBusy(""); }
  };
  const doTest = async () => {
    setBusy("test"); setErr("");
    try { await post({ action: "test_email", campaignId, emails: [testTo] }); setTestedOk(true); showToast?.(`✓ Test sent to ${testTo}`); }
    catch (e) { setErr(e.message); } finally { setBusy(""); }
  };
  /* What a listing already knows about being mailed. The newest entry wins —
     entries are appended in send order. */
  const sentOf = l => {
    if (stamps[l.id]) return stamps[l.id];
    const rows = Array.isArray(l.campaigns) ? l.campaigns : [];
    return rows.length ? rows[rows.length - 1].sentAt : (l.last_campaign_at || "");
  };
  const sentLabel = iso => {
    const d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  };
  const sentCount = l => {
    const rows = Array.isArray(l.campaigns) ? l.campaigns : (l.last_campaign_at ? [{ sentAt: l.last_campaign_at }] : []);
    // The prop doesn't refresh under us, so a stamp written this session counts once more.
    return rows.length + (stamps[l.id] && !rows.some(c => c.sentAt === stamps[l.id]) ? 1 : 0);
  };

  /* A send is the only thing that marks a listing as mailed — a draft or a test
     is not, since neither reaches the list. Best-effort: the campaign is already
     out the door, so a failed stamp is reported, never thrown. */
  const recordSend = async () => {
    const sentAt = new Date().toISOString();
    const fresh = await loadK(LIST_KEY).catch(() => null);
    const byId = new Map((Array.isArray(fresh) ? fresh : listings).map(l => [l.id, l]));
    const done = {};
    // A trade product or stock card with no listing behind it has nowhere to keep the stamp.
    for (const l of chosen.filter(l => !l.noListing)) {
      const row = byId.get(l.id) || l;
      const prior = (Array.isArray(row.campaigns) ? row.campaigns : []).filter(c => c.id !== campaignId);
      await upsertItemK(LIST_KEY, {
        ...row,
        campaigns: [...prior, { id: campaignId, name: CAMPAIGN_NAME, subject, sentAt, deal: deals.has(l.id) }],
        last_campaign_at: sentAt,
      }, { prepend: false });
      done[l.id] = sentAt;
    }
    setStamps(s => ({ ...s, ...done }));
  };

  const doSend = async () => {
    const audience = segIds.size ? `${segIds.size} segment(s)` : "ALL subscribers";
    if (!window.confirm(`Send "${subject}" to ${audience}?\n\nThis emails real people and cannot be undone.`)) return;
    if (window.prompt('Type SEND to confirm:') !== "SEND") { showToast?.("Cancelled — nothing sent"); return; }
    setBusy("send"); setErr("");
    try {
      await post({ action: "send", campaignId, confirm: "SEND" });
      showToast?.("📣 Campaign sent");
      try { await recordSend(); showToast?.(`✓ ${chosen.filter(l => !l.noListing).length} listing(s) marked as mailed`); }
      catch (e) { showToast?.(`Sent — but the listings weren't marked: ${e.message}`); }
      onClose();
    }
    catch (e) { setErr(e.message); } finally { setBusy(""); }
  };

  const card = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14 };
  const lab = { fontSize: 9.5, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .6, marginBottom: 4, display: "block" };

  return (
    <div onClick={e => e.target === e.currentTarget && onClose()} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", zIndex: 1000, display: "flex", alignItems: mob() ? "stretch" : "center", justifyContent: "center", padding: mob() ? 0 : 20 }}>
      <div style={{ background: C.bg, borderRadius: mob() ? 0 : 16, width: "min(1100px,100%)", maxHeight: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 18px", borderBottom: `1px solid ${C.border}`, background: C.surface, flexShrink: 0 }}>
          <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 20, fontWeight: 700, color: C.ink, lineHeight: 1 }}>📣 New-products campaign</div>
          <div style={{ fontSize: 11, color: C.inkFaint }}>{sel.size} selected{products.filter(p => p.deal).length ? ` · ${products.filter(p => p.deal).length} under the banner` : ""}</div>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={{ background: "transparent", border: `1px solid ${C.border}`, borderRadius: 8, padding: "6px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer", color: C.ink }}>Close</button>
        </div>

        {configured === false && (
          <div style={{ margin: 14, padding: "12px 14px", background: "#fff8e6", border: "1px solid #f0dfae", borderRadius: 10, fontSize: 12.5, color: "#8a6d1a", lineHeight: 1.55, flexShrink: 0 }}>
            <strong>Omnisend isn't connected yet.</strong> Create an API key in Omnisend → <em>API Keys</em>, then add it in Vercel → Settings → Environment Variables as <code>OMNISEND_API_KEY</code> and redeploy. {err && <div style={{ marginTop: 6, color: C.red }}>{err}</div>}
          </div>
        )}

        <div style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: mob() ? "1fr" : "320px 1fr", gap: 14, padding: 14, overflowY: "auto" }}>
          {/* Product picker */}
          <div style={{ ...card, display: "flex", flexDirection: "column", minHeight: 0 }}>
            <div style={{ display: "flex", gap: 4, marginBottom: 8, background: C.card, borderRadius: 8, padding: 3 }}>
              {[["listings", `Listings (${listings.length})`], ["trade", `Trade site${trade ? ` (${tradeView.length})` : ""}`], ["stock", `Stock cards${stockCards ? ` (${stockView.length})` : ""}`]].map(([k, label]) => (
                <button key={k} type="button" onClick={() => setSource(k)}
                  style={{ flex: 1, border: "none", borderRadius: 6, padding: "6px 8px", fontSize: 11.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
                    background: source === k ? C.surface : "transparent", color: source === k ? C.ink : C.inkFaint, boxShadow: source === k ? "0 1px 2px rgba(0,0,0,.08)" : "none" }}>{label}</button>
              ))}
            </div>
            {source === "trade" && priceMode !== "trade" && trade && (
              <div style={{ fontSize: 11, color: C.inkMid, background: C.tealBg, borderRadius: 7, padding: "7px 9px", marginBottom: 8, lineHeight: 1.45 }}>
                Everything live on trade.eartheditions.co.{" "}
                <button type="button" onClick={() => { setPriceMode("trade"); invalidate(); }}
                  style={{ border: "none", background: "none", padding: 0, color: C.teal, fontWeight: 700, fontSize: 11, cursor: "pointer", fontFamily: "inherit", textDecoration: "underline" }}>Print trade prices and link to the trade site</button>
              </div>
            )}
            {source === "stock" && stockCards && (
              <div style={{ fontSize: 11, color: C.inkMid, background: C.tealBg, borderRadius: 7, padding: "7px 9px", marginBottom: 8, lineHeight: 1.45 }}>
                Stock cards with something left on them. Their price prints whatever storefront is chosen; a card has no web page, so give it a link under ✎ if you want one.
              </div>
            )}
            {loadErr && <div style={{ fontSize: 11, color: C.red, marginBottom: 8 }}>{loadErr}</div>}
            <input value={q} onChange={e => setQ(e.target.value)} placeholder={source === "trade" ? "Search the trade site…" : source === "stock" ? "Search stock cards — stone, shape, SKU…" : "Search listings…"} style={{ ...FI(), marginBottom: 8 }} />
            <div style={{ flex: 1, overflowY: "auto", maxHeight: mob() ? 260 : 420, display: "flex", flexDirection: "column", gap: 5 }}>
              {((source === "trade" && !trade) || (source === "stock" && !stockCards)) && !loadErr && <div style={{ fontSize: 12, color: C.inkFaint, padding: 10 }}>Loading {source === "trade" ? "the trade site" : "the stock cards"}…</div>}
              {visible.length === 0 && (source === "listings" || (source === "trade" ? trade : stockCards)) && <div style={{ fontSize: 12, color: C.inkFaint, padding: 10 }}>Nothing matches.</div>}
              {visible.map(l => {
                const on = sel.has(l.id);
                const o = overrides[l.id] || {};
                const open = editing === l.id;
                const shot = o.image?.trim() || (l.images || [])[0] || "";
                const shown = priceOf(l, priceMode === "none" ? "trade" : priceMode).price;
                const card4 = cardOf(l);
                const detail = l._stock ? [l.sku, l._stock.qty, l._stock.region].filter(Boolean).join(" · ")
                  : [[l.material, l.shape].filter(Boolean).join(" · ") || l.sku || "", card4 && `📦 ${card4.sku || "stock card"}`, !linkOf(l) && "no public link"].filter(Boolean).join(" · ");
                return (
                  <div key={l.id} style={{ borderRadius: 8, background: on ? C.tealBg : "transparent", border: `1px solid ${on ? C.teal : "transparent"}` }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 9, padding: "6px 8px", cursor: "pointer" }}>
                    <input type="checkbox" checked={on} onChange={() => { toggle(l.id); invalidate(); }} style={{ accentColor: C.teal }} />
                    {shot
                      ? <img src={shot} alt="" style={{ width: 34, height: 34, borderRadius: 6, objectFit: "cover", flexShrink: 0 }} />
                      : <div style={{ width: 34, height: 34, borderRadius: 6, background: C.card, flexShrink: 0 }} />}
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.title?.trim() || l.title || "Untitled"}{edited(l) && <span title="Edited for this mailer" style={{ color: C.teal }}> ✎</span>}</div>
                      {/* The price this card prints, as a button that opens where it's set; then the detail on one line. */}
                      <div style={{ fontSize: 10, color: C.inkFaint, display: "flex", alignItems: "center", gap: 6, marginTop: 2, minWidth: 0 }}>
                        <button type="button" title="Its prices on the trade site, eartheditions.co and its stock card: click to see and set them"
                          onClick={e => { e.preventDefault(); e.stopPropagation(); setPricing(pricing?.id === l.id ? null : { id: l.id }); }}
                          style={{ flexShrink: 0, border: `1px solid ${shown ? C.border : "#d9a441"}`, background: pricing?.id === l.id ? C.surface : shown ? "transparent" : "#fff6e0", color: shown ? C.ink : "#8a6d1a", borderRadius: 5, padding: "1px 6px", fontSize: 10, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap", fontFamily: "inherit" }}>
                          {shown ? `${l._trade?.options > 1 && (priceMode === "trade" || l.noListing) ? "from " : ""}${shown} ✎` : "No price · set"}
                        </button>
                        <span title={detail} style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{detail}</span>
                      </div>
                      {sentOf(l) && (
                        <div title={(l.campaigns || []).map(c => `${c.name} — ${sentLabel(c.sentAt)}`).join("\n")}
                          style={{ fontSize: 10, color: C.teal, fontWeight: 600 }}>
                          ✉ Mailed {sentLabel(sentOf(l))}{sentCount(l) > 1 ? ` · ${sentCount(l)}×` : ""}
                        </div>
                      )}
                    </div>
                    {on && (
                      <button type="button" title="Print this one under the in-stock banner"
                        onClick={e => { e.preventDefault(); e.stopPropagation(); toggleDeal(l.id); }}
                        style={{ flexShrink: 0, border: `1px solid ${deals.has(l.id) ? C.teal : C.border}`, background: deals.has(l.id) ? C.teal : "transparent", color: deals.has(l.id) ? "#fff" : C.inkFaint, borderRadius: 6, padding: "3px 7px", fontSize: 9.5, fontWeight: 700, letterSpacing: .4, textTransform: "uppercase", cursor: "pointer" }}>
                        Deal
                      </button>
                    )}
                    {on && (
                      <button type="button" title="Edit how this one reads in the mailer"
                        onClick={e => { e.preventDefault(); e.stopPropagation(); setEditing(open ? "" : l.id); }}
                        style={{ flexShrink: 0, border: `1px solid ${open ? C.teal : C.border}`, background: "transparent", color: open ? C.teal : C.inkFaint, borderRadius: 6, padding: "3px 7px", fontSize: 11, cursor: "pointer" }}>
                        ✎
                      </button>
                    )}
                  </label>
                  {pricing?.id === l.id && (
                    <PriceEditor fields={priceFields(l)} busy={!!pricing.busy} err={pricing.err || ""}
                      onSave={ch => savePrices(l, ch)} onCancel={() => setPricing(null)} />
                  )}
                  {on && open && (
                    <div style={{ padding: "2px 8px 10px", display: "grid", gap: 7 }}>
                      {/* The listing's own photos, so picking the second shot is a
                          click rather than a hunt for its URL. */}
                      {(l.images || []).length > 1 && (
                        <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                          {(l.images || []).slice(0, 8).map(src => (
                            <img key={src} src={src} alt="" onClick={() => setOverride(l.id, "image", src === (l.images || [])[0] ? "" : src)}
                              style={{ width: 34, height: 34, borderRadius: 6, objectFit: "cover", cursor: "pointer", border: `2px solid ${src === shot ? C.teal : "transparent"}` }} />
                          ))}
                        </div>
                      )}
                      {OVERRIDABLE.map(f => (
                        <div key={f.key}>
                          <label style={{ ...lab, marginBottom: 2 }}>{f.label}</label>
                          <input value={o[f.key] || ""} onChange={e => setOverride(l.id, f.key, e.target.value)}
                            placeholder={String(baseProduct(l)[f.key] || "—")}
                            disabled={!!(f.hideKey && o[f.hideKey])}
                            style={{ ...FI(), fontSize: 11.5, padding: "5px 7px", ...(f.hideKey && o[f.hideKey] ? { opacity: .45 } : {}) }} />
                          {f.hideKey && (
                            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: C.inkMid, cursor: "pointer", marginTop: 5 }}>
                              <input type="checkbox" checked={!o[f.hideKey]}
                                onChange={e => setOverride(l.id, f.hideKey, !e.target.checked)}
                                style={{ accentColor: C.teal }} />
                              {f.hideLabel}
                            </label>
                          )}
                        </div>
                      ))}
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 10, color: C.inkFaint, flex: 1 }}>Blank = whatever the listing says. This mailer only.</span>
                        {edited(l) && (
                          <button type="button" onClick={() => clearOverrides(l.id)}
                            style={{ border: `1px solid ${C.border}`, background: "transparent", color: C.inkFaint, borderRadius: 6, padding: "3px 8px", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>
                            Reset
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Compose + preview */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
            <div style={{ ...card, display: "grid", gap: 10, gridTemplateColumns: mob() ? "1fr" : "1fr 1fr" }}>
              <div style={{ gridColumn: mob() ? "auto" : "1 / -1" }}>
                <label style={lab}>Subject *</label>
                <input value={subject} onChange={e => { setSubject(e.target.value); invalidate(); }} placeholder="Fresh arrivals — hand-picked this week" style={FI()} />
              </div>
              <div><label style={lab}>Preheader</label><input value={preheader} onChange={e => { setPreheader(e.target.value); invalidate(); }} placeholder="Preview text in the inbox" style={FI()} /></div>
              <div><label style={lab}>Heading</label><input value={heading} onChange={e => { setHeading(e.target.value); invalidate(); }} style={FI()} /></div>
              <div style={{ gridColumn: mob() ? "auto" : "1 / -1" }}>
                <label style={lab}>Intro</label>
                <textarea value={intro} onChange={e => { setIntro(e.target.value); invalidate(); }} rows={3} placeholder="A line or two above the products…" style={{ ...FI(), resize: "vertical" }} />
              </div>
              <div><label style={lab}>Brand</label><input value={brand} onChange={e => { setBrand(e.target.value); invalidate(); }} style={FI()} /></div>
              <div><label style={lab}>Sender name *</label><input value={senderName} onChange={e => { setSenderName(e.target.value); invalidate(); }} style={FI()} /></div>
              <div><label style={lab}>Sender email</label><input value={senderEmail} onChange={e => { setSenderEmail(e.target.value); invalidate(); }} placeholder="verified in Omnisend" style={FI()} /></div>
              <div>
                <label style={lab}>Which price to print</label>
                <select value={priceMode} onChange={e => { setPriceMode(e.target.value); invalidate(); }} style={FI()}>
                  <option value="trade">Trade site ($ per kg, lot or piece; links to the trade site)</option>
                  <option value="earth">eartheditions.co ($; links to the store)</option>
                  <option value="aty">Atyahara (₹)</option>
                  <option value="etsy">Etsy (₹)</option>
                  <option value="none">Print no prices</option>
                </select>
              </div>
              <div style={{ gridColumn: mob() ? "auto" : "1 / -1" }}>
                <button type="button" onClick={() => setDesignOpen(o => !o)}
                  style={{ width: "100%", textAlign: "left", background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: "9px 12px", fontSize: 12, fontWeight: 700, color: C.ink, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ transform: designOpen ? "rotate(90deg)" : "none", transition: "transform .15s", fontSize: 10 }}>▸</span>
                  🎨 Design
                  <span style={{ fontWeight: 500, color: C.inkFaint, fontSize: 11 }}>
                    {design.layout === "editorial" ? "editorial" : design.columns === 1 ? "cards · 1 column" : "cards · 2 columns"} · {design.font === "sans" ? "sans" : "serif"} · {design.cornerStyle}
                  </span>
                  <span style={{ flex: 1 }} />
                  <span style={{ width: 15, height: 15, borderRadius: 4, background: design.accent, border: `1px solid ${C.border}` }} />
                </button>

                {designOpen && (
                  <div style={{ border: `1px solid ${C.border}`, borderTop: "none", borderRadius: "0 0 8px 8px", padding: 12, display: "grid", gap: 12 }}>
                    <div style={{ display: "grid", gridTemplateColumns: mob() ? "1fr 1fr" : "repeat(4, 1fr)", gap: 10 }}>
                      <div>
                        <label style={lab}>Layout</label>
                        <select value={design.layout} onChange={e => setD("layout", e.target.value)} style={FI()}>
                          <option value="editorial">Editorial (big photos)</option>
                          <option value="cards">Compact cards</option>
                        </select>
                      </div>
                      <div>
                        <label style={lab}>Columns</label>
                        {design.layout === "cards"
                          ? <select value={design.columns} onChange={e => setD("columns", +e.target.value)} style={FI()}>
                              <option value={2}>Two columns</option>
                              <option value={1}>One column (big)</option>
                            </select>
                          : <select value={design.productColumns} onChange={e => setD("productColumns", +e.target.value)} style={FI()}>
                              <option value={2}>Two columns</option>
                              <option value={1}>One column (big)</option>
                            </select>}
                      </div>
                      <div>
                        <label style={lab}>Font</label>
                        <select value={design.font} onChange={e => setD("font", e.target.value)} style={FI()}>
                          <option value="serif">Serif headings</option>
                          <option value="sans">All sans-serif</option>
                        </select>
                      </div>
                      <div>
                        <label style={lab}>Corners</label>
                        <select value={design.cornerStyle} onChange={e => setD("cornerStyle", e.target.value)} style={FI()}>
                          <option value="rounded">Rounded</option>
                          <option value="square">Square</option>
                        </select>
                      </div>
                      {design.layout === "cards" && (
                        <div>
                          <label style={lab}>Button style</label>
                          <select value={design.ctaStyle} onChange={e => setD("ctaStyle", e.target.value)} style={FI()}>
                            <option value="solid">Solid</option>
                            <option value="outline">Outline</option>
                            <option value="link">Text link</option>
                          </select>
                        </div>
                      )}
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: mob() ? "1fr 1fr" : "repeat(4, 1fr)", gap: 10 }}>
                      {[["accent", "Accent"], ["ink", "Text"], ["pageBg", "Page"], ["cardBg", "Card"]].map(([k, label]) => (
                        <div key={k}>
                          <label style={lab}>{label}</label>
                          <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
                            <input type="color" value={design[k]} onChange={e => setD(k, e.target.value)}
                              style={{ width: 34, height: 32, padding: 0, border: `1px solid ${C.border}`, borderRadius: 6, background: "none", cursor: "pointer", flexShrink: 0 }} />
                            <input value={design[k]} onChange={e => setD(k, e.target.value)} style={{ ...FI(), fontSize: 11, padding: "7px 8px" }} />
                          </div>
                        </div>
                      ))}
                    </div>

                    <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                      {[["showPrice", "Show price"], ["showMeta", "Show details"], ["showCta", "Show button"], ["showDivider", "Divider between rows"]].map(([k, label]) => (
                        <label key={k} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.inkMid, cursor: "pointer" }}>
                          <input type="checkbox" checked={design[k]} onChange={e => setD(k, e.target.checked)} /> {label}
                        </label>
                      ))}
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: mob() ? "1fr" : "1fr 1fr 90px", gap: 10 }}>
                      <div>
                        <label style={lab}>Button label</label>
                        <input value={design.ctaLabel} onChange={e => setD("ctaLabel", e.target.value)} placeholder="View product" style={FI()} />
                      </div>
                      <div>
                        <label style={lab}>Logo URL <span style={{ textTransform: "none", fontWeight: 400 }}>(replaces the brand line)</span></label>
                        <div style={{ display: "flex", gap: 5 }}>
                          <input value={design.headerImage} onChange={e => setD("headerImage", e.target.value)} placeholder="https://…" style={FI()} />
                          <input type="number" min={24} max={540} value={design.logoWidth} onChange={e => setD("logoWidth", +e.target.value)}
                            title="Logo width in px" style={{ ...FI(), width: 68, flexShrink: 0 }} />
                        </div>
                      </div>
                      <div>
                        <label style={lab}>Heading px</label>
                        <input type="number" min={16} max={40} value={design.headingSize} onChange={e => setD("headingSize", +e.target.value)} style={FI()} />
                      </div>
                    </div>

                    {design.layout === "editorial" && (
                      <div style={{ display: "grid", gap: 10, borderTop: `1px solid ${C.border}`, paddingTop: 12 }}>
                        {/* In-stock banner — built in HTML, not an uploaded image. */}
                        <div style={{ display: "grid", gap: 10 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <label style={{ ...lab, marginBottom: 0 }}>In-stock banner</label>
                            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.inkMid, cursor: "pointer" }}>
                              <input type="checkbox" checked={!!design.promoTitle || !!design.promoRibbon}
                                onChange={e => {
                                  if (e.target.checked) setDesign(d => ({ ...d, promoTitle: "IN-STOCK SPECIALS", promoRibbon: "Limited lots · Special pricing" }));
                                  else setDesign(d => ({ ...d, promoTitle: "", promoRibbon: "" }));
                                  invalidate();
                                }} /> show
                            </label>
                            <span style={{ fontSize: 11, color: C.inkFaint }}>
                              {products.some(p => p.deal)
                                ? "drawn in the email — no image to host"
                                : "only prints once a listing is marked DEAL"}
                            </span>
                          </div>
                          {(design.promoTitle || design.promoRibbon) && (
                            <div style={{ display: "grid", gridTemplateColumns: mob() ? "1fr" : "1fr 1fr", gap: 10 }}>
                              <div>
                                <label style={lab}>Ribbon</label>
                                <input value={design.promoRibbon} onChange={e => setD("promoRibbon", e.target.value)} style={FI()} />
                              </div>
                              <div>
                                <label style={lab}>Banner title</label>
                                <input value={design.promoTitle} onChange={e => setD("promoTitle", e.target.value)} style={FI()} />
                              </div>
                              <div>
                                <label style={lab}>Sub-line</label>
                                <input value={design.promoSubtitle} onChange={e => setD("promoSubtitle", e.target.value)} style={FI()} />
                              </div>
                              <div>
                                <label style={lab}>Note under the rule</label>
                                <input value={design.promoNote} onChange={e => setD("promoNote", e.target.value)} style={FI()} />
                              </div>
                              <div style={{ gridColumn: mob() ? "auto" : "1 / -1" }}>
                                <label style={lab}>Badges <span style={{ textTransform: "none", fontWeight: 400 }}>— one per line, “emoji Label | caption”, up to 3</span></label>
                                <textarea value={design.promoBadges} onChange={e => setD("promoBadges", e.target.value)} rows={3} style={{ ...FI(), resize: "vertical", fontSize: 12 }} />
                              </div>
                              <div>
                                <label style={lab}>Banner colour</label>
                                <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
                                  <input type="color" value={design.promoColor} onChange={e => setD("promoColor", e.target.value)}
                                    style={{ width: 34, height: 32, padding: 0, border: `1px solid ${C.border}`, borderRadius: 6, background: "none", cursor: "pointer", flexShrink: 0 }} />
                                  <input value={design.promoColor} onChange={e => setD("promoColor", e.target.value)} style={{ ...FI(), fontSize: 11, padding: "7px 8px" }} />
                                </div>
                              </div>
                            </div>
                          )}
                        </div>

                        <div style={{ display: "grid", gridTemplateColumns: mob() ? "1fr" : "2fr 1fr 1fr", gap: 10 }}>
                          <div>
                            <label style={lab}>Banner image <span style={{ textTransform: "none", fontWeight: 400 }}>(overrides the drawn banner)</span></label>
                            <input value={design.bannerImage} onChange={e => setD("bannerImage", e.target.value)} placeholder="https://…  only if you have artwork" style={FI()} />
                          </div>
                          <div>
                            <label style={lab}>Price suffix</label>
                            <input value={design.priceSuffix} onChange={e => setD("priceSuffix", e.target.value)} placeholder="/ LOT" style={FI()} />
                          </div>
                          <div>
                            <label style={lab}>Date line</label>
                            <input value={design.dateLine} onChange={e => setD("dateLine", e.target.value)} placeholder="today's date" style={FI()} />
                          </div>
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: mob() ? "1fr" : "1fr 1fr", gap: 10 }}>
                          <div>
                            <label style={lab}>Trade panel heading <span style={{ textTransform: "none", fontWeight: 400 }}>(empty removes the panel)</span></label>
                            <input value={design.tradeLine} onChange={e => setD("tradeLine", e.target.value)} style={FI()} />
                          </div>
                          <div>
                            <label style={lab}>Trade panel eyebrow</label>
                            <input value={design.tradeEyebrow} onChange={e => setD("tradeEyebrow", e.target.value)} style={FI()} />
                          </div>
                          <div>
                            <label style={lab}>Trade button label</label>
                            <input value={design.tradeButton} onChange={e => setD("tradeButton", e.target.value)} style={FI()} />
                          </div>
                          <div>
                            <label style={lab}>Trade button link</label>
                            <input value={design.tradeUrl} onChange={e => setD("tradeUrl", e.target.value)} placeholder="https://…" style={FI()} />
                          </div>
                          <div>
                            <label style={lab}>Instagram link</label>
                            <input value={design.instagramUrl} onChange={e => setD("instagramUrl", e.target.value)} placeholder="https://instagram.com/…" style={FI()} />
                          </div>
                          <div>
                            <label style={lab}>Address line <span style={{ textTransform: "none", fontWeight: 400 }}>(Omnisend already prints one — leave empty)</span></label>
                            <input value={design.addressLine} onChange={e => setD("addressLine", e.target.value)} placeholder="usually blank" style={FI()} />
                          </div>
                        </div>

                        {/* Shipping terms — the closing block under the trade panel. */}
                        <div style={{ display: "grid", gridTemplateColumns: mob() ? "1fr" : "90px 1fr", gap: 10, borderTop: `1px solid ${C.border}`, paddingTop: 12 }}>
                          <div>
                            <label style={lab}>Icon</label>
                            <input value={design.shipIcon} onChange={e => setD("shipIcon", e.target.value)} placeholder="✈️ or URL" style={FI()} />
                          </div>
                          <div>
                            <label style={lab}>Shipping heading <span style={{ textTransform: "none", fontWeight: 400 }}>(empty removes the block)</span></label>
                            <input value={design.shipTitle} onChange={e => setD("shipTitle", e.target.value)} style={FI()} />
                          </div>
                          <div style={{ gridColumn: mob() ? "auto" : "1 / -1" }}>
                            <label style={lab}>Shipping note</label>
                            <textarea value={design.shipNote} onChange={e => setD("shipNote", e.target.value)} rows={3} style={{ ...FI(), resize: "vertical", fontSize: 12 }} />
                          </div>
                        </div>
                      </div>
                    )}

                    <div>
                      <label style={lab}>Footer text <span style={{ textTransform: "none", fontWeight: 400 }}>(Omnisend adds ©, your postal address and the unsubscribe links below this)</span></label>
                      <textarea value={design.footer} onChange={e => setD("footer", e.target.value)} rows={2}
                        placeholder="Studio address, reply-to, shipping note…" style={{ ...FI(), resize: "vertical" }} />
                    </div>

                    <div style={{ fontSize: 10.5, color: C.inkFaint, lineHeight: 1.5 }}>
                      Hit Preview to see changes. Email clients ignore stylesheets, so these map to inline styles and table layout — what you preview is what sends.
                    </div>
                  </div>
                )}
              </div>

            </div>

            {err && configured !== false && <div style={{ background: C.redBg, border: `1px solid ${C.red}55`, color: C.red, borderRadius: 10, padding: "9px 12px", fontSize: 12 }}>{err}</div>}

            {previewHtml && (
              <div style={{ ...card, padding: 0, overflow: "hidden" }}>
                <iframe title="Email preview" srcDoc={previewHtml} style={{ width: "100%", height: 380, border: "none", background: "#fff" }} />
              </div>
            )}

            {/* Draft → test → send. Each step gates the next.
                Audience sits here rather than up in the copy: who it goes to is a
                decision made at the point of sending, not while writing. */}
            <div style={{ ...card, display: "grid", gap: 10 }}>
              <div>
                <label style={lab}>Audience {segments.length === 0
                  ? <span style={{ textTransform: "none", fontWeight: 400 }}>— none loaded, will go to all subscribers</span>
                  : segIds.size === 0 && <span style={{ textTransform: "none", fontWeight: 400 }}>— none picked, will go to all subscribers</span>}</label>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {segments.map(s => {
                    const on = segIds.has(s.id);
                    return <button key={s.id} type="button" onClick={() => { setSegIds(p => { const n = new Set(p); n.has(s.id) ? n.delete(s.id) : n.add(s.id); return n; }); invalidate(); }}
                      style={{ background: on ? C.teal : C.card, color: on ? "#fff" : C.ink, border: `1px solid ${on ? C.teal : C.border}`, borderRadius: 20, padding: "5px 12px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                      {s.name}{s.count != null ? ` · ${s.count}` : ""}
                    </button>;
                  })}
                </div>
              </div>

              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <button onClick={doPreview} disabled={!products.length || !!busy}
                style={{ background: C.card, color: C.ink, border: `1px solid ${C.border}`, borderRadius: 9, padding: "10px 16px", fontSize: 12.5, fontWeight: 700, cursor: products.length ? "pointer" : "not-allowed", opacity: products.length ? 1 : .5 }}>
                {busy === "preview" ? "Rendering…" : "Preview"}
              </button>
              <button onClick={doCreate} disabled={!products.length || !subject || !senderName || configured === false || !!busy}
                style={{ background: C.ink, color: "#FAF0DC", border: "none", borderRadius: 9, padding: "10px 16px", fontSize: 12.5, fontWeight: 700, cursor: "pointer", opacity: (!products.length || !subject || !senderName || configured === false) ? .4 : 1 }}>
                {busy === "create" ? "Creating…" : campaignId ? "Recreate draft" : "Create draft"}
              </button>
              {campaignId && <>
                <input value={testTo} onChange={e => setTestTo(e.target.value)} placeholder="you@example.com" style={{ ...FI(), width: 190 }} />
                <button onClick={doTest} disabled={!testTo || !!busy}
                  style={{ background: C.tealBg, color: C.teal, border: `1px solid ${C.teal}`, borderRadius: 9, padding: "10px 16px", fontSize: 12.5, fontWeight: 700, cursor: testTo ? "pointer" : "not-allowed", opacity: testTo ? 1 : .5 }}>
                  {busy === "test" ? "Sending…" : "Send test"}
                </button>
                <div style={{ flex: 1 }} />
                <button onClick={doSend} disabled={!testedOk || !!busy}
                  title={testedOk ? "" : "Send yourself a test first"}
                  style={{ background: testedOk ? C.red : C.card, color: testedOk ? "#fff" : C.inkFaint, border: `1px solid ${testedOk ? C.red : C.border}`, borderRadius: 9, padding: "10px 20px", fontSize: 12.5, fontWeight: 700, cursor: testedOk ? "pointer" : "not-allowed" }}>
                  {busy === "send" ? "Sending…" : "Send to list →"}
                </button>
                </>}
              </div>
            </div>
            <div style={{ fontSize: 11, color: C.inkFaint, lineHeight: 1.6 }}>
              The draft is created in Omnisend — you can also open it there to tweak the design. Omnisend appends its own unsubscribe footer to campaigns; confirm it's present in the test email before sending. Sending is irreversible.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
