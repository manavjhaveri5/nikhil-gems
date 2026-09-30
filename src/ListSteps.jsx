/* Listing a piece, one step at a time: where it's kept and where it goes,
   what the customer pays on each of those places and what that leaves us,
   then list it. Etsy's sale and sales tax are read from the shop's own recent
   orders, and each platform's fees are fixed, so there is nothing to set. */
import { useEffect, useMemo, useState } from "react";
import { C } from "./lmTheme.js";
import { CHANNELS, linkOf } from "./listingChannels.js";
import { storeSettings, storePriceFor } from "./StoreApp.jsx";
import { recommendCarriers, carrierLabel } from "./shipping.js";

const serif = "'Cormorant Garamond',Georgia,serif";
const DAY = 86400000;
const inr = v => `₹${Math.round(v).toLocaleString("en-IN")}`;
const usd = v => `$${(+v).toLocaleString("en-US", { maximumFractionDigits: +v >= 100 ? 0 : 2 })}`;
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const t = o => Date.parse(o.created_at || o.date || "") || 0;

/* What Etsy buyers are paying right now, from the shop's recent orders: the
   sale running (the discount on the latest orders) and the sales tax Etsy
   puts on top for buyers who owe it. Shipping isn't guessed: it follows the
   listing's shipping profile, and Etsy ships free in the US over $35. */
export function etsyNow(orders = []) {
  const etsy = orders.filter(o => (o.platform === "etsy" || o.source === "etsy-sync") && !o.cancelled && !/cancel/i.test(o.status || "") && +o.list_price > 0)
    .sort((a, b) => t(b) - t(a));
  const recent = etsy.filter(o => Date.now() - t(o) < 30 * DAY).slice(0, 12);
  // The sale: the discount most of the latest orders carried.
  const counts = {};
  for (const o of recent) { const p = Math.round(100 * (+o.discount || 0) / +o.list_price); counts[p] = (counts[p] || 0) + 1; }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const sale = top ? +top[0] : null;
  const last100 = etsy.slice(0, 100);
  const taxed = last100.filter(o => +o.order_tax > 0 && (+o.order_subtotal || 0) + (+o.order_shipping || 0) > 0);
  const tax = taxed.length ? median(taxed.map(o => +o.order_tax / ((+o.order_subtotal || 0) + (+o.order_shipping || 0)))) : 0;
  const byCountry = {};
  for (const o of taxed) { const c = o.buyer_country || o.ship_country || ""; if (c) byCountry[c] = (byCountry[c] || 0) + 1; }
  const taxWhere = Object.entries(byCountry).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  return { sale, orders: recent.length, tax, taxShare: last100.length ? taxed.length / last100.length : 0, taxWhere };
}

/* What each platform keeps of a sale — fixed, so never asked for. Etsy:
   transaction, payment processing and listing fees together; eBay: final
   value fee and payments; the two sites: card processing. */
const FEES = { etsy: .11, ebay: .15, store: .03, trade: .03, store_in: .0236 };
const FEE_NAME = { etsy: "Etsy fees", ebay: "eBay fees", store: "Card fees", trade: "Card fees", store_in: "Razorpay 2% + GST" };

const PLACE = {
  etsy: "Retail, worldwide",
  ebay: "Retail, US auctions & buy-now",
  store: "eartheditions.co · USA and India",
  trade: "trade.eartheditions.co · wholesale buyers",
};

const Box = ({ children, style }) => <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: "16px 18px", ...style }}>{children}</div>;

/* The cheapest carrier that has actually gone to that country, then to its
   region; null when there's only guesswork from other lanes. */
const laneBest = rec => !rec?.options?.length ? null
  : rec.options.find(o => o.exact && o.key !== "other") || rec.options.find(o => o.exact)
  || rec.options.find(o => /^\d+ to /.test(o.basis || "")) || null;

/* "Customer pays" can be typed too: the listed price is worked back from it
   through the sale. What's typed stays on screen while typing, so rounding the
   listed price never makes the number jump under the cursor. */
function PaysInput({ value, onSet, size = 30, width = 150 }) {
  const [typed, setTyped] = useState(null);
  return (
    <span style={{ display: "inline-flex", alignItems: "baseline", gap: 3, borderBottom: `1.5px dashed ${C.border}`, width }}>
      <span style={{ fontFamily: serif, fontSize: size * .7, color: C.inkMid }}>₹</span>
      <input type="number" inputMode="decimal" value={typed ?? (value || "")} placeholder="0" title="Type what the buyer should pay — the listed price is worked out from it"
        onFocus={() => setTyped(value ? String(value) : "")} onBlur={() => setTyped(null)}
        onChange={e => { setTyped(e.target.value); onSet(+e.target.value || 0); }}
        style={{ flex: 1, minWidth: 0, width: "100%", border: 0, outline: "none", background: "transparent", fontFamily: serif, fontSize: size, color: C.ink, textAlign: "right", padding: 0 }} />
    </span>
  );
}

export default function ListSteps({ form, orders, stock = [], weightKg = 0, rate = 88, start = "where", renderWhere, renderPlatform, onAI, aiBusy, onApply, onPublishOne, onClose, onDone, research = false }) {
  const [step, setStep] = useState(start);
  // An exception to the stock-card rule: a piece with no stock card (a sample,
  // consignment, a one-off bought in), kept on the listing with its reason.
  const [noStock, setNoStock] = useState(() => !!form.stock_exception);
  const [noStockWhy, setNoStockWhy] = useState(() => form.stock_exception?.reason || "");
  const stockException = () => (noStock && !form.linked_stock_id ? { reason: noStockWhy.trim(), at: new Date().toISOString() } : null);
  const [pick, setPick] = useState(() => Object.fromEntries(CHANNELS.map(c => [c.key, linkOf(form, c.key).linked])));
  const [p, setP] = useState(() => ({
    price_etsy: form.price_etsy || "", price_ebay: form.price_ebay || "",
    price_store: form.price_store || "", price_store_inr: form.price_store_inr || "", price_trade: form.price_trade || "",
  }));
  /* A piece sold in variants with their own prices (sizes, grades) is priced
     per option here, not once: the first variation that's priced per option
     sets the rows, and Etsy's headline price becomes the cheapest of them. */
  const vi = (form.variations || []).findIndex(v => v?.perVariantPricing && (v.options || []).some(o => String(o.label || "").trim()));
  const varName = vi >= 0 ? form.variations[vi].name || "Variant" : "";
  const [vopts, setVopts] = useState(() => vi >= 0 ? form.variations[vi].options.filter(o => String(o.label || "").trim()).map(o => ({ ...o })) : []);
  const setOptPrice = (id, k, v) => setVopts(list => list.map(o => o.id === id ? { ...o, [k]: v } : o));
  const varMin = vopts.reduce((m, o) => +o.price_etsy > 0 && (!m || +o.price_etsy < m) ? +o.price_etsy : m, 0);
  const variantsPatch = () => {
    if (vi < 0) return {};
    const byId = Object.fromEntries(vopts.map(o => [o.id, o]));
    const variations = form.variations.map((v, i) => i !== vi ? v : { ...v, options: v.options.map(o => byId[o.id] ? { ...o, price_etsy: byId[o.id].price_etsy, price_shopify: byId[o.id].price_shopify, cost: byId[o.id].cost ?? o.cost ?? "" } : o) });
    return { variations, ...(varMin ? { price_etsy: String(varMin) } : {}) };
  };
  const costPatch = () => cardCost ? {} : {
    price_calc: { ...(form.price_calc || {}), cost: calcCost || "", cost_lines: costLines.filter(l => String(l.label).trim() || +l.amt) },
  };
  /* Price research (admin only): pieces like this one elsewhere. Nothing runs
     until asked — Etsy's own search is free, the web search is one AI call —
     and what came back is kept on the listing so it's never paid for twice. */
  const [rs, setRs] = useState(() => form.price_research || null);   // { etsy?: {items, at}, web?: {items, at} }
  const [rsBusy, setRsBusy] = useState("");
  const [rsErr, setRsErr] = useState("");
  const runResearch = async mode => {
    setRsBusy(mode); setRsErr("");
    try {
      const r = await fetch("/api/listing-manager", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "price_research", mode, listing: { title: form.title, material: form.material, shape: form.shape, size: form.size, weight: form.weight, origin: form.origin, images: (form.images || []).slice(0, 1) } }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `Research failed (${r.status})`);
      setRs(x => ({ ...(x || {}), [mode]: { items: d.items || [], at: d.at } }));
    } catch (e) { setRsErr(e.message || String(e)); }
    setRsBusy("");
  };
  const [s, setS] = useState(null);
  useEffect(() => { storeSettings().then(setS).catch(() => setS({})); }, []);
  useEffect(() => { const k = e => e.key === "Escape" && onClose(); addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, [onClose]);

  const now = useMemo(() => etsyNow(orders), [orders]);
  // The sale running now, or the store's own setting when there are no recent orders to read it from.
  const sale = now.sale ?? (+s?.etsy_discount_pct || 0);
  const fx = +s?.fx_inr_per_usd || 84;
  const etsyPrice = (vi >= 0 && varMin) || +p.price_etsy || 0;
  const etsyPays = Math.round(etsyPrice * (1 - sale / 100));
  const listedFor = paid => paid ? String(Math.round(paid / (1 - sale / 100))) : "";
  // Until given their own, the store and eBay follow what an Etsy buyer pays.
  const storeUsd = +p.price_store || storePriceFor({ price_etsy: etsyPrice }, fx, s?.price_rounding, sale) || 0;
  const storeInr = +p.price_store_inr || (etsyPrice ? Math.round(etsyPays / 10) * 10 : 0);
  const ebayUsd = +p.price_ebay || (etsyPays ? Math.round(etsyPays / fx) : 0);

  // What the piece cost us, from its stock card (an older listing may carry its own); 0 if unknown.
  /* No cost on a stock card (custom work, a piece with no card): it's worked
     out here instead, line by line — materials, making, packaging — and kept
     on the listing. A variant can carry its own cost over the top of it. */
  const cardCost = +form._stockCost || 0;
  const [costLines, setCostLines] = useState(() => {
    const saved = form.price_calc?.cost_lines;
    if (Array.isArray(saved) && saved.length) return saved.map(l => ({ ...l }));
    return [{ id: "c1", label: "", amt: +form.price_calc?.cost ? String(form.price_calc.cost) : "" }];
  });
  const calcCost = costLines.reduce((n, l) => n + (+l.amt || 0), 0);
  const cost = cardCost || calcCost;
  const optCost = o => +o.cost || cost;
  /* What shipping it to a US buyer should cost us, from what our past parcels
     cost at this weight (the piece plus about 300 g of packing). Ours to pay:
     Etsy ships free in the US over $35, and the sites and eBay price it in. */
  const shipEst = useMemo(() => {
    if (!weightKg) return null;
    const rec = recommendCarriers(orders, stock, { id: "_price", ship_country: "US", parcel_weight_kg: weightKg + 0.3 });
    const pick = laneBest(rec) || rec?.options?.[rec.options.length - 1];
    return pick ? { cost: pick.expected, carrier: pick.label || carrierLabel(pick.key), basis: pick.basis } : null;
  }, [orders, stock, weightKg]);
  const [shipTyped, setShipTyped] = useState("");
  const ship = shipTyped !== "" ? +shipTyped || 0 : shipEst?.cost || 0;
  // Within India a parcel costs far less: from our past domestic parcels, else a courier's usual rate.
  const shipInEst = useMemo(() => {
    const rec = recommendCarriers(orders, stock, { id: "_price_in", ship_country: "IN", parcel_weight_kg: (weightKg || .5) + 0.3 });
    const pick = laneBest(rec);
    if (pick) return { cost: pick.expected, carrier: pick.label || carrierLabel(pick.key), basis: pick.basis };
    return { cost: Math.round(80 + 70 * Math.ceil((weightKg || .5) + .3)), carrier: "a domestic courier", basis: "usual rate" };
  }, [orders, stock, weightKg]);
  const [shipInTyped, setShipInTyped] = useState("");
  const shipIn = shipInTyped !== "" ? +shipInTyped || 0 : shipInEst.cost;
  /* Customer pays → platform fees → shipping → cost → profit, all in rupees.
     eBay charges its fee on the whole order, US sales tax included; Etsy
     only on the price. */
  const money4 = (pkey, paid, cur, pieceCost = cost) => {
    if (!paid) return null;
    const gross = paid * (cur === "$" ? rate : 1);
    const feeBase = pkey === "ebay" ? gross * (1 + (now.tax || 0)) : gross;
    const fees = feeBase * FEES[pkey];
    const shipping = pkey === "trade" ? 0 : pkey === "store_in" ? shipIn : ship;
    // A sale within India owes 0.25% GST on stones (HSN 7103), inside the price; exports carry none.
    const gst = pkey === "store_in" ? gross * .0025 / 1.0025 : 0;
    return { gross, fees, shipping, gst, pieceCost, profit: gross - fees - shipping - gst - pieceCost, onTax: pkey === "ebay" && now.tax > 0 };
  };
  const chosen = CHANNELS.filter(c => pick[c.key]);
  // Where → the piece → prices → a page for each platform picked → publish.
  const STEPS = [["where", "Where"], ["piece", "The piece"], ...(research ? [["research", "Research"]] : []), ["price", "Price"],
    ...(renderPlatform ? chosen.map(c => [c.key, c.key === "store" ? "Retail" : c.label]) : []), ["list", "Publish"]];
  const at = Math.max(0, STEPS.findIndex(x => x[0] === step));
  /* Etsy, eBay and Earth Editions sell the actual piece, so it has to be
     findable and tied to its stock card; wholesale alone doesn't. */
  const retail = chosen.some(c => c.key !== "trade");
  // The exception covers pieces that aren't on a shelf at all (custom, made to
  // order, consignment) — so it waives the location along with the card.
  const pieceMissing = retail && !noStock ? [!form._loc && "where it's stored", !form.linked_stock_id && "its stock card"].filter(Boolean) : [];
  const canNext = step === "where" ? chosen.length > 0 : step === "piece" ? !pieceMissing.length : true;

  // One platform at a time from the last step: publish it, then link to it live.
  const [one, setOne] = useState({});   // key → { busy, url, error }
  /* Putting a piece live on Etsy costs a $0.20 listing fee (an update to one
     that's already live doesn't), so it asks first. */
  const etsyFeeOk = () => linkOf(form, "etsy").status === "active"
    || window.confirm("Publish on Etsy?\n\nEtsy charges a $0.20 listing fee to put it live.");
  const publishOne = async key => {
    if (key === "etsy" && !etsyFeeOk()) return;
    setOne(x => ({ ...x, [key]: { busy: true } }));
    try {
      const url = await onPublishOne(pricesPatch(), key);
      setOne(x => ({ ...x, [key]: { url: url || "", done: true } }));
    } catch (e) { setOne(x => ({ ...x, [key]: { error: e.message || "Didn't publish" } })); }
  };
  // Every platform picked is live (published here, or already live) → the step is
  // done. Each publish already saved the listing, so Done just closes — no re-sync.
  const allLive = chosen.length > 0 && chosen.every(c => one[c.key]?.url || one[c.key]?.done || (linkOf(form, c.key).linked && linkOf(form, c.key).status === "active"));
  const pricesPatch = () => ({
      price_etsy: p.price_etsy,
      price_ebay: p.price_ebay || (pick.ebay && ebayUsd ? String(ebayUsd) : form.price_ebay || ""),
      price_store: p.price_store, price_store_inr: p.price_store_inr,
      price_trade: p.price_trade,
      stock_exception: stockException(),
      ...variantsPatch(), ...costPatch(), ...(rs ? { price_research: rs } : {}),
  });
  const apply = live => {
    if (live && pick.etsy && !etsyFeeOk()) return;
    const patch = {
      stock_exception: stockException(),
      price_etsy: p.price_etsy,
      price_ebay: p.price_ebay || (pick.ebay && ebayUsd ? String(ebayUsd) : form.price_ebay || ""),
      price_store: p.price_store, price_store_inr: p.price_store_inr,
      price_trade: p.price_trade,
      ...variantsPatch(), ...costPatch(), ...(rs ? { price_research: rs } : {}),
    };
    onApply(patch, Object.fromEntries(chosen.map(c => [c.key, true])), { live });
  };

  const money = (field, cur, placeholder) => (
    <div style={{ display: "flex", alignItems: "baseline", gap: 4, borderBottom: `1.5px solid ${C.ink}`, minWidth: 0 }}>
      <span style={{ fontFamily: serif, fontSize: 24, color: C.inkMid }}>{cur}</span>
      <input type="number" inputMode="decimal" value={p[field]} placeholder={placeholder || "0"}
        onChange={e => setP(x => ({ ...x, [field]: e.target.value }))}
        style={{ flex: 1, minWidth: 0, width: "100%", border: 0, outline: "none", background: "transparent", fontFamily: serif, fontSize: 30, color: C.ink, padding: "2px 0" }} />
    </div>
  );
  const pays = (big, sub) => (
    <div style={{ textAlign: "right", flex: "none" }}>
      <div style={{ fontSize: 10.5, letterSpacing: ".16em", textTransform: "uppercase", color: C.inkFaint }}>Customer pays</div>
      <div style={{ fontFamily: serif, fontSize: 30, color: C.ink, lineHeight: 1.1 }}>{big}</div>
      {sub && <div style={{ fontSize: 11.5, color: C.inkMid, marginTop: 2 }}>{sub}</div>}
    </div>
  );
  // The money under each platform: what's paid, what goes where, what's left.
  const sheet = (pkey, m, label) => !m ? null : (
    <div style={{ marginTop: 12, borderTop: `1px solid ${C.border}`, paddingTop: 8 }}>
      {label && <div style={{ fontSize: 11, color: C.inkFaint, marginBottom: 4 }}>{label}</div>}
      {[
        ["Customer pays", m.gross, C.ink],
        [`${FEE_NAME[pkey]} · ${+(FEES[pkey] * 100).toFixed(2)}%${m.onTax ? " of price + tax" : ""}`, -m.fees, C.inkMid],
        [pkey === "trade" ? "Shipping · buyer pays freight" : pkey === "store_in" ? "Shipping in India" : "Shipping", -m.shipping, C.inkMid],
        ...(m.gst ? [["GST · 0.25% (in the price)", -m.gst, C.inkMid]] : []),
        ["Cost of the piece", -m.pieceCost, C.inkMid],
      ].map(([k, v, col]) => (
        <div key={k} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: col, padding: "2px 0" }}>
          <span>{k}</span><span>{v < 0 ? "− " : ""}{v ? inr(Math.abs(v)) : "—"}</span>
        </div>
      ))}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", borderTop: `1px solid ${C.border}`, marginTop: 4, paddingTop: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 800, color: C.ink }}>Profit{!m.pieceCost ? " · no cost entered" : ""}</span>
        <span style={{ fontFamily: serif, fontSize: 24, color: m.profit >= 0 ? C.green : C.red }}>{m.profit < 0 ? "− " : ""}{inr(Math.abs(m.profit))}</span>
      </div>
    </div>
  );

  return (
    <div onMouseDown={e => e.target === e.currentTarget && onClose()} style={{ position: "fixed", inset: 0, zIndex: 400, background: "rgba(20,15,8,.5)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div id="ls-box" style={{ background: C.bg, width: "100%", maxWidth: 560, maxHeight: "100%", height: innerWidth < 700 ? "100%" : "auto", overflowY: "auto", borderRadius: innerWidth < 700 ? 0 : 16, display: "flex", flexDirection: "column", boxShadow: "0 24px 80px rgba(0,0,0,.3)" }}>
        {/* steps */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "calc(14px + env(safe-area-inset-top)) 18px 12px", background: C.surface, borderBottom: `1px solid ${C.border}`, position: "sticky", top: 0, zIndex: 2 }}>
          {form.images?.[0] && typeof form.images[0] === "string" && <img src={form.images[0]} alt="" style={{ width: 34, height: 34, borderRadius: 7, objectFit: "cover" }} />}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", gap: 4 }}>
              {STEPS.map(([k], i) => (
                <button key={k} type="button" onClick={() => i < at && setStep(k)} aria-label={STEPS[i][1]}
                  style={{ flex: 1, height: 14, border: "none", background: "none", padding: "5px 0", cursor: i < at ? "pointer" : "default" }}>
                  <div style={{ height: 3, borderRadius: 2, background: i <= at ? C.ink : C.border }} />
                </button>
              ))}
            </div>
            <div style={{ fontSize: 12, color: C.inkMid, marginTop: 2 }}><b style={{ color: C.ink }}>{STEPS[at][1]}</b> · {at + 1} of {STEPS.length}</div>
          </div>
          <button type="button" onClick={onClose} style={{ border: "none", background: "none", fontSize: 24, color: C.inkMid, cursor: "pointer" }}>×</button>
        </div>

        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12, flex: 1 }}>
          {step === "piece" && <>
            <div style={{ fontFamily: serif, fontSize: 28, color: C.ink }}>The piece</div>
            {renderWhere && renderWhere()}
            {pieceMissing.length > 0 && <div style={{ fontSize: 13, color: C.red }}>Etsy, eBay and Earth Editions need {pieceMissing.join(" and ")} before it can go on.</div>}
            {retail && !form.linked_stock_id && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "10px 12px", borderRadius: 10, border: `1px solid ${noStock ? C.amber : C.border}`, background: noStock ? C.amberBg : "transparent" }}>
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, fontWeight: 700, color: C.ink, cursor: "pointer" }}>
                  <input type="checkbox" checked={noStock} onChange={e => setNoStock(e.target.checked)} style={{ width: 16, height: 16, margin: 0 }} />
                  Exception: no stock card or shelf for this piece
                </label>
                {noStock && <input value={noStockWhy} onChange={e => setNoStockWhy(e.target.value)} placeholder="Why? e.g. custom / made to order, sample, consignment (optional)"
                  style={{ border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 10px", fontSize: 13, background: C.surface, color: C.ink }} />}
              </div>
            )}
          </>}

          {renderPlatform && chosen.some(c => c.key === step) && <>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ fontFamily: serif, fontSize: 28, color: C.ink, flex: 1 }}>{STEPS[at][1]}</div>
              {step !== "trade" && onAI && <button type="button" onClick={onAI} disabled={aiBusy || !form.title}
                style={{ padding: "9px 14px", borderRadius: 10, border: "none", background: C.gold, color: "#fff", fontWeight: 800, fontSize: 13, cursor: aiBusy ? "wait" : "pointer", opacity: form.title ? 1 : .5 }}>
                {aiBusy ? "Filling…" : "✨ Fill with AI"}</button>}
            </div>
            {step !== "trade" && <div style={{ fontSize: 12, color: C.inkMid, marginTop: -4 }}>AI fills the title, description, tags, stone, shape, origin and section from what's there — only the empty ones.</div>}
            {renderPlatform(step)}
          </>}

          {step === "where" && <>
            <div style={{ fontFamily: serif, fontSize: 28, color: C.ink }}>Where should it go?</div>
            {CHANNELS.map(c => {
              const ln = linkOf(form, c.key);
              const on = !!pick[c.key];
              return (
                <button key={c.key} type="button" onClick={() => setPick(x => ({ ...x, [c.key]: !x[c.key] }))}
                  style={{ display: "flex", alignItems: "center", gap: 14, textAlign: "left", background: C.surface, border: `1.5px solid ${on ? C.ink : C.border}`, borderRadius: 12, padding: "14px 16px", cursor: "pointer", WebkitTapHighlightColor: "transparent" }}>
                  <span style={{ width: 22, height: 22, borderRadius: 6, border: `1.5px solid ${on ? C.ink : C.borderHi}`, background: on ? C.ink : "transparent", color: "#fff", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>{on ? "✓" : ""}</span>
                  <span style={{ flex: 1 }}>
                    <span style={{ display: "block", fontSize: 16, fontWeight: 700, color: C.ink }}>{c.label}</span>
                    <span style={{ display: "block", fontSize: 12, color: C.inkMid }}>{PLACE[c.key]}</span>
                  </span>
                  {ln.linked && <span style={{ fontSize: 11, fontWeight: 800, color: ln.status === "active" ? C.green : C.amber }}>{ln.status === "active" ? "Live" : "Draft"}</span>}
                </button>
              );
            })}
          </>}

          {step === "research" && <>
            <div style={{ fontFamily: serif, fontSize: 28, color: C.ink }}>Price research</div>
            <div style={{ fontSize: 13.5, color: C.inkMid, lineHeight: 1.5 }}>What pieces like this sell for elsewhere — only when you ask. Tap <b>Next</b> to skip.</div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button type="button" disabled={!!rsBusy} onClick={() => runResearch("etsy")} style={{ padding: "11px 16px", borderRadius: 10, border: "none", background: C.ink, color: "#FAF0DC", fontWeight: 800, fontSize: 14, cursor: "pointer", opacity: rsBusy ? .5 : 1 }}>
                {rsBusy === "etsy" ? "Searching Etsy…" : rs?.etsy ? "↻ Search Etsy again" : "Search Etsy"} <span style={{ fontWeight: 500, opacity: .75 }}>· free</span></button>
              <button type="button" disabled={!!rsBusy} onClick={() => runResearch("web")} style={{ padding: "11px 16px", borderRadius: 10, border: `1px solid ${C.border}`, background: C.surface, color: C.ink, fontWeight: 800, fontSize: 14, cursor: "pointer", opacity: rsBusy ? .5 : 1 }}>
                {rsBusy === "web" ? "Searching the web… (up to a minute)" : rs?.web ? "↻ Search the web again" : "Search the web"} <span style={{ fontWeight: 500, color: C.inkMid }}>· uses AI</span></button>
            </div>
            {rsErr && <div style={{ fontSize: 13, color: C.red }}>⚠️ {rsErr}</div>}
            {["etsy", "web"].filter(k => rs?.[k]).map(k => {
              const FX = { USD: rate, INR: 1, GBP: rate * 1.27, EUR: rate * 1.08, CAD: rate * .73, AUD: rate * .66 };
              const items = rs[k].items || [];
              const inInr = x => FX[x.currency] ? x.price * FX[x.currency] : 0;
              const ps = items.map(inInr).filter(Boolean).sort((a, b) => a - b);
              const mid = ps.length ? ps[Math.floor(ps.length / 2)] : 0;
              return (
                <Box key={k}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 6 }}>
                    <div style={{ flex: 1, fontSize: 12, fontWeight: 800, color: C.ink }}>{k === "etsy" ? "On Etsy" : "Around the web"} · {items.length}</div>
                    {ps.length > 1 && <div style={{ fontSize: 12, color: C.inkMid }}>{inr(ps[0])} – {inr(ps[ps.length - 1])} · middle <b style={{ color: C.ink }}>{inr(mid)}</b> ≈ {usd(Math.round(mid / rate))}</div>}
                  </div>
                  {!items.length && <div style={{ fontSize: 13, color: C.inkMid }}>Nothing close turned up.</div>}
                  {items.map(x => {
                    const r = inInr(x);
                    return (
                      <div key={x.id || x.url} style={{ display: "flex", gap: 12, padding: "10px 0", borderTop: `1px solid ${C.border}` }}>
                        {x.image ? <img src={x.image} alt="" style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 8, flex: "none", background: C.card }} />
                          : <div style={{ width: 64, height: 64, borderRadius: 8, flex: "none", background: C.card, display: "grid", placeItems: "center", color: C.inkFaint, fontSize: 11 }}>{x.where?.slice(0, 10) || "web"}</div>}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <a href={x.url} target="_blank" rel="noreferrer" style={{ fontSize: 13.5, fontWeight: 700, color: C.ink, textDecoration: "none", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{x.title} ↗</a>
                          <div style={{ fontSize: 12, color: C.inkMid, marginTop: 3, lineHeight: 1.45 }}>{x.where ? <b>{x.where}</b> : null}{x.where && x.note ? " · " : ""}{x.note}</div>
                        </div>
                        <div style={{ textAlign: "right", flex: "none" }}>
                          <div style={{ fontFamily: serif, fontSize: 20, color: C.ink }}>{r ? inr(r) : x.price ? `${x.price} ${x.currency}` : "—"}</div>
                          {r > 0 && x.currency !== "INR" && <div style={{ fontSize: 11, color: C.inkFaint }}>{x.price.toLocaleString()} {x.currency}</div>}
                          {r > 0 && vi < 0 && pick.etsy && <button type="button" onClick={() => setP(v => ({ ...v, price_etsy: listedFor(Math.round(r)) }))}
                            style={{ marginTop: 4, border: `1px solid ${C.border}`, background: "transparent", borderRadius: 6, padding: "3px 8px", fontSize: 11, fontWeight: 700, color: C.ink, cursor: "pointer" }}>Match on Etsy</button>}
                        </div>
                      </div>
                    );
                  })}
                  <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 6 }}>Found {new Date(rs[k].at).toLocaleString()} · kept on this listing{k === "etsy" ? " · listed prices, before any sale they're running" : ""}</div>
                </Box>
              );
            })}
          </>}
          {step === "price" && <>
            <div style={{ fontFamily: serif, fontSize: 28, color: C.ink }}>Prices</div>
            {!chosen.length && <div style={{ color: C.inkMid, fontSize: 14 }}>Pick where it goes first.</div>}
            {chosen.some(c => c.key !== "trade") && <Box>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, fontWeight: 800, color: C.ink }}>Shipping — what we pay</div>
                  <div style={{ fontSize: 11.5, color: C.inkMid, marginTop: 2 }}>
                    {shipEst ? <>≈ {inr(shipEst.cost)} to the US by {shipEst.carrier} · {weightKg + .3 < 1 ? `${Math.round((weightKg + .3) * 1000)} g` : `${(weightKg + .3).toFixed(1)} kg`} packed · {shipEst.basis}</>
                      : weightKg ? "No past parcels to go on yet — type what it'll cost" : "Add the piece's weight (or its stock card's kilos) for an estimate, or type it"}
                  </div>
                </div>
                <div style={{ width: 130 }}>{/* typed shipping replaces the estimate */}
                  <div style={{ display: "flex", alignItems: "baseline", gap: 4, borderBottom: `1.5px solid ${C.ink}` }}>
                    <span style={{ fontFamily: serif, fontSize: 20, color: C.inkMid }}>₹</span>
                    <input type="number" inputMode="decimal" value={shipTyped} placeholder={shipEst ? String(shipEst.cost) : "0"} onChange={e => setShipTyped(e.target.value)}
                      style={{ flex: 1, minWidth: 0, width: "100%", border: 0, outline: "none", background: "transparent", fontFamily: serif, fontSize: 24, color: C.ink }} />
                  </div>
                </div>
              </div>
            </Box>}
            {!cardCost && chosen.length > 0 && <Box>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, fontWeight: 800, color: C.ink }}>What it costs us</div>
                  <div style={{ fontSize: 11.5, color: C.inkMid, marginTop: 2 }}>{form.linked_stock_id ? "Its stock card has no cost — add it up here." : "No stock card — add up what goes into it: material, making, packaging."}</div>
                </div>
                <div style={{ fontFamily: serif, fontSize: 26, color: C.ink }}>{calcCost ? inr(calcCost) : "—"}</div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
                {costLines.map((l, i) => (
                  <div key={l.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <input value={l.label} placeholder={["e.g. Acrylic sheet", "e.g. Laser cutting", "e.g. Labour", "e.g. Packaging"][i] || "What for"}
                      onChange={e => setCostLines(ls => ls.map(x => x.id === l.id ? { ...x, label: e.target.value } : x))}
                      style={{ flex: 1, minWidth: 0, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 10px", fontSize: 13.5, background: C.surface, color: C.ink, outline: "none" }} />
                    <div style={{ display: "flex", alignItems: "baseline", gap: 3, borderBottom: `1.5px solid ${C.ink}`, width: 100 }}>
                      <span style={{ color: C.inkMid }}>₹</span>
                      <input type="number" inputMode="decimal" value={l.amt} placeholder="0"
                        onChange={e => setCostLines(ls => ls.map(x => x.id === l.id ? { ...x, amt: e.target.value } : x))}
                        style={{ flex: 1, minWidth: 0, width: "100%", border: 0, outline: "none", background: "transparent", fontSize: 17, color: C.ink }} />
                    </div>
                    <button type="button" onClick={() => setCostLines(ls => ls.length > 1 ? ls.filter(x => x.id !== l.id) : [{ id: "c1", label: "", amt: "" }])}
                      style={{ border: "none", background: "none", color: C.inkFaint, fontSize: 18, cursor: "pointer", padding: "0 4px" }}>×</button>
                  </div>
                ))}
                <button type="button" onClick={() => setCostLines(ls => [...ls, { id: `c${Date.now()}`, label: "", amt: "" }])}
                  style={{ alignSelf: "flex-start", border: `1px dashed ${C.border}`, background: "transparent", borderRadius: 8, padding: "6px 12px", fontSize: 12.5, fontWeight: 700, color: C.ink, cursor: "pointer" }}>+ Add a cost</button>
              </div>
            </Box>}
            {vi >= 0 && (pick.etsy || pick.store) && <Box>
              <div style={{ fontSize: 12, fontWeight: 800, color: C.ink, marginBottom: 2 }}>Prices by {varName.toLowerCase()}</div>
              <div style={{ fontSize: 11.5, color: C.inkMid, marginBottom: 8 }}>Each option's listed price. Customer pays is after your {sale ? `${sale}% ` : ""}sale; profit is after fees, shipping and that option's cost.</div>
              {vopts.map(o => {
                const lp = +o.price_etsy || 0, paysV = Math.round(lp * (1 - sale / 100));
                const mE = money4("etsy", paysV, "₹", optCost(o));
                const sUsd = +o.price_shopify || storePriceFor({ price_etsy: lp }, fx, s?.price_rounding, sale) || 0;
                const mS = money4("store", sUsd, "$", optCost(o));
                const cell = { display: "flex", alignItems: "baseline", gap: 3, borderBottom: `1.5px solid ${C.ink}`, width: 110 };
                const inp = { flex: 1, minWidth: 0, width: "100%", border: 0, outline: "none", background: "transparent", fontFamily: serif, fontSize: 22, color: C.ink };
                return (
                  <div key={o.id} style={{ borderTop: `1px solid ${C.border}`, padding: "10px 0", display: "flex", flexWrap: "wrap", gap: "8px 18px", alignItems: "flex-end" }}>
                    <div style={{ flex: "1 1 120px", fontSize: 14, fontWeight: 700, color: C.ink, alignSelf: "center" }}>{o.label}</div>
                    {pick.etsy && <div>
                      <div style={{ fontSize: 10.5, color: C.inkFaint, marginBottom: 2 }}>Etsy</div>
                      <div style={cell}><span style={{ color: C.inkMid }}>₹</span><input type="number" inputMode="decimal" value={o.price_etsy ?? ""} onChange={e => setOptPrice(o.id, "price_etsy", e.target.value)} style={inp} /></div>
                      <div style={{ fontSize: 11.5, color: C.inkMid, marginTop: 4 }}>pays <PaysInput value={paysV} size={14} width={70} onSet={v => setOptPrice(o.id, "price_etsy", listedFor(v))} />{mE && <> ≈ {usd(Math.round(paysV / rate))} · profit <b style={{ color: mE.profit >= 0 ? C.green : C.red }}>{mE.profit < 0 ? "− " : ""}{inr(Math.abs(mE.profit))}</b></>}</div>
                    </div>}
                    {!cardCost && <div>
                      <div style={{ fontSize: 10.5, color: C.inkFaint, marginBottom: 2 }}>Cost</div>
                      <div style={{ ...cell, width: 90 }}><span style={{ color: C.inkMid }}>₹</span><input type="number" inputMode="decimal" value={o.cost ?? ""} placeholder={cost ? String(Math.round(cost)) : "0"} onChange={e => setOptPrice(o.id, "cost", e.target.value)} style={inp} /></div>
                      <div style={{ fontSize: 11.5, color: C.inkFaint, marginTop: 4 }}>{o.cost ? "own cost" : "as calculated"}</div>
                    </div>}
                    {pick.store && <div>
                      <div style={{ fontSize: 10.5, color: C.inkFaint, marginBottom: 2 }}>Earth Editions</div>
                      <div style={cell}><span style={{ color: C.inkMid }}>$</span><input type="number" inputMode="decimal" value={o.price_shopify ?? ""} placeholder={sUsd ? String(sUsd) : ""} onChange={e => setOptPrice(o.id, "price_shopify", e.target.value)} style={inp} /></div>
                      <div style={{ fontSize: 11.5, color: C.inkMid, marginTop: 4 }}>{mS ? <>profit <b style={{ color: mS.profit >= 0 ? C.green : C.red }}>{mS.profit < 0 ? "− " : ""}{inr(Math.abs(mS.profit))}</b></> : "—"}</div>
                    </div>}
                  </div>
                );
              })}
            </Box>}
            {pick.etsy && <Box>
              <div style={{ fontSize: 12, fontWeight: 800, color: C.ink, marginBottom: 8 }}>Etsy</div>
              <div style={{ display: "flex", gap: 16, alignItems: "flex-end" }}>
                <div style={{ flex: 1, minWidth: 0 }}>{vi >= 0
                  ? <><div style={{ fontFamily: serif, fontSize: 30, color: C.ink }}>{varMin ? `from ${inr(varMin)}` : "—"}</div><div style={{ fontSize: 11.5, color: C.inkFaint, marginTop: 5 }}>Priced per {varName.toLowerCase()} below — Etsy shows the lowest</div></>
                  : <>{money("price_etsy", "₹")}<div style={{ fontSize: 11.5, color: C.inkFaint, marginTop: 5 }}>Listed price{sale ? ", shown crossed out" : ""}</div></>}</div>
                {pays(vi >= 0 ? (etsyPays ? inr(etsyPays) : "—") : <PaysInput value={etsyPays} onSet={v => setP(x => ({ ...x, price_etsy: listedFor(v) }))} />,
                  etsyPays ? <><span>≈ {usd(Math.round(etsyPays / rate))}</span>{sale ? <> <s style={{ color: C.inkFaint }}>{usd(Math.round(etsyPrice / rate))}</s> · {sale}% sale</> : ""}</> : sale ? `in your ${sale}% sale` : "no sale running",
                  )}
              </div>
              {sheet("etsy", money4("etsy", etsyPays))}
              <div style={{ fontSize: 12, color: C.inkMid, marginTop: 12, lineHeight: 1.55, borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
                {now.orders ? <>Sale read from your last {now.orders} Etsy order{now.orders === 1 ? "" : "s"}.</> : <>No Etsy orders in the last 30 days — using your store's {sale}% setting.</>}
                {now.tax > 0 && <> {now.taxWhere === "US" ? "US buyers" : "Some buyers"} also pay about {Math.round(now.tax * 100)}% sales tax on top — Etsy adds it at checkout and pays it over; it isn't yours.</>}
                {etsyPays > 0 && now.tax > 0 && <div style={{ marginTop: 6, color: C.ink }}>All in for {now.taxWhere === "US" ? "a US" : "a taxed"} buyer: about <b>{inr(etsyPays * (1 + now.tax))}</b> ≈ {usd(Math.round(etsyPays * (1 + now.tax) / rate))}</div>}
              </div>
            </Box>}
            {pick.ebay && <Box>
              <div style={{ fontSize: 12, fontWeight: 800, color: C.ink, marginBottom: 8 }}>eBay</div>
              <div style={{ display: "flex", gap: 16, alignItems: "flex-end" }}>
                <div style={{ flex: 1, minWidth: 0 }}>{money("price_ebay", "$", ebayUsd ? String(ebayUsd) : "")}<div style={{ fontSize: 11.5, color: C.inkFaint, marginTop: 5 }}>{p.price_ebay ? "Your price" : "Same as an Etsy buyer pays, in dollars"}</div></div>
                {pays(ebayUsd ? usd(ebayUsd) : "—", ebayUsd ? `≈ ${inr(ebayUsd * rate)}` : "")}
              </div>
              {sheet("ebay", money4("ebay", ebayUsd, "$"))}
              {now.tax > 0 && ebayUsd > 0 && <div style={{ fontSize: 12, color: C.inkMid, marginTop: 8, lineHeight: 1.55 }}>US buyers also pay about {Math.round(now.tax * 100)}% sales tax on top — eBay collects and pays it over. All in: about <b>{usd(Math.round(ebayUsd * (1 + now.tax)))}</b>. eBay's fee is charged on that total, tax included.</div>}
            </Box>}
            {pick.store && <Box>
              <div style={{ fontSize: 12, fontWeight: 800, color: C.ink, marginBottom: 8 }}>Earth Editions</div>
              <div style={{ display: "flex", gap: 14 }}>
                <div style={{ flex: 1, minWidth: 0 }}>{money("price_store", "$", storeUsd ? String(storeUsd) : "")}<div style={{ fontSize: 11.5, color: C.inkFaint, marginTop: 5 }}>USA</div></div>
                <div style={{ flex: 1, minWidth: 0 }}>{money("price_store_inr", "₹", storeInr ? String(storeInr) : "")}<div style={{ fontSize: 11.5, color: C.inkFaint, marginTop: 5 }}>India</div></div>
              </div>
              <div style={{ fontSize: 12, color: C.inkMid, marginTop: 10 }}>
                {p.price_store || p.price_store_inr ? "Customer pays these." : "Leave empty and it follows what an Etsy buyer pays in the sale."}
              </div>
              {sheet("store", money4("store", storeUsd, "$"), "A US sale")}
              {storeInr > 0 && <>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14, fontSize: 12, color: C.inkMid }}>
                  <span style={{ flex: 1 }}>Shipping in India ≈ {inr(shipInEst.cost)} by {shipInEst.carrier} · {shipInEst.basis}</span>
                  <span style={{ display: "flex", alignItems: "baseline", gap: 3, borderBottom: `1.5px solid ${C.ink}`, width: 90 }}>
                    <span style={{ color: C.inkMid }}>₹</span>
                    <input type="number" inputMode="decimal" value={shipInTyped} placeholder={String(shipInEst.cost)} onChange={e => setShipInTyped(e.target.value)}
                      style={{ flex: 1, minWidth: 0, width: "100%", border: 0, outline: "none", background: "transparent", fontSize: 16, color: C.ink }} />
                  </span>
                </div>
                {sheet("store_in", money4("store_in", storeInr), "An India sale · paid through Razorpay")}
              </>}
            </Box>}
            {pick.trade && <Box>
              <div style={{ fontSize: 12, fontWeight: 800, color: C.ink, marginBottom: 8 }}>Wholesale</div>
              <div style={{ display: "flex", gap: 16, alignItems: "flex-end" }}>
                <div style={{ flex: 1, minWidth: 0 }}>{money("price_trade", "$")}<div style={{ fontSize: 11.5, color: C.inkFaint, marginTop: 5 }}>Per piece, lot or kilo — as set on the Wholesale tab</div></div>
                {pays(+p.price_trade ? usd(+p.price_trade) : "—", +p.price_trade ? `≈ ${inr(+p.price_trade * rate)}` : "trade buyers")}
              </div>
              {sheet("trade", money4("trade", +p.price_trade, "$"))}
            </Box>}
          </>}

          {step === "list" && <>
            <div style={{ fontFamily: serif, fontSize: 28, color: C.ink }}>Publish</div>
            <Box style={{ display: "flex", gap: 14, alignItems: "center" }}>
              {form.images?.[0] && typeof form.images[0] === "string" && <img src={form.images[0]} alt="" style={{ width: 64, height: 64, borderRadius: 9, objectFit: "cover", flex: "none" }} />}
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: C.ink }}>{form.title || "Untitled"}</div>
                <div style={{ fontSize: 12, color: C.inkMid, marginTop: 3 }}>{(form.images || []).length} photo{(form.images || []).length === 1 ? "" : "s"}{form.video ? " + video" : ""}{form.officeLocation ? ` · 📍 ${form.officeLocation}` : ""}</div>
              </div>
            </Box>
            <Box style={{ padding: 0 }}>
              {chosen.length ? chosen.map((c, i) => {
                const price = c.key === "etsy" ? (etsyPays ? `${inr(etsyPays)}${sale ? ` (${inr(etsyPrice)} − ${sale}%)` : ""}` : "No price")
                  : c.key === "ebay" ? (ebayUsd ? usd(ebayUsd) : "No price")
                  : c.key === "store" ? [storeUsd && usd(storeUsd), storeInr && inr(storeInr)].filter(Boolean).join(" · ") || "No price"
                  : +p.price_trade ? usd(+p.price_trade) : "No price";
                return (
                  <div key={c.key} style={{ borderTop: i ? `1px solid ${C.border}` : "none" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "13px 16px" }}>
                    <span style={{ width: 8, height: 8, borderRadius: 4, background: c.color }} />
                    <span style={{ flex: 1, fontSize: 14, fontWeight: 700, color: C.ink }}>{c.label}</span>
                    <span style={{ fontSize: 14, color: /No price/.test(price) ? C.red : C.ink }}>{price}</span>
                  </div>
                  {onPublishOne && (() => {
                    const st = one[c.key] || {};
                    const ln = linkOf(form, c.key);
                    const url = st.url || (ln.linked && ln.status === "active" ? ln.live : "");
                    const noPrice = /No price/.test(price);
                    return (
                      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 16px 12px 34px", flexWrap: "wrap" }}>
                        {st.error && <span style={{ flex: "1 1 100%", fontSize: 12, color: C.red }}>{st.error}</span>}
                        {url && <a href={url} target="_blank" rel="noreferrer" style={{ fontSize: 13, fontWeight: 800, color: C.green, border: `1.5px solid ${C.green}60`, borderRadius: 8, padding: "7px 12px", textDecoration: "none" }}>✓ View live ↗</a>}
                        {st.done && !url && <span style={{ fontSize: 12.5, color: C.green, fontWeight: 700 }}>✓ Published — link appears once the platform confirms</span>}
                        <button type="button" disabled={st.busy || noPrice || pieceMissing.length > 0} onClick={() => publishOne(c.key)}
                          style={{ fontSize: 13, fontWeight: 800, borderRadius: 8, padding: "7px 14px", cursor: st.busy ? "wait" : "pointer", border: url ? `1px solid ${C.border}` : "none",
                            background: url ? C.surface : C.ink, color: url ? C.ink : "#FAF0DC", opacity: noPrice || pieceMissing.length ? .4 : 1 }}>
                          {st.busy ? "Publishing…" : url ? "Update" : `Publish on ${c.label}`}</button>
                        {st.busy && <span style={{ fontSize: 12, color: C.inkMid }}>You can close this — it carries on, and a message says when it's live.</span>}
                      </div>
                    );
                  })()}
                  </div>
                );
              }) : <div style={{ padding: 16, color: C.inkMid }}>Nowhere picked yet.</div>}
            </Box>
            <div style={{ fontSize: 12, color: C.inkFaint }}>Publish each one on its own and check it live, or all at once with Publish all live. Save as drafts keeps it off sale.</div>
          </>}
        </div>

        <div style={{ display: "flex", gap: 10, padding: "12px 18px calc(12px + env(safe-area-inset-bottom))", borderTop: `1px solid ${C.border}`, background: C.surface, position: "sticky", bottom: 0 }}>
          {at > 0 && <button type="button" onClick={() => setStep(STEPS[at - 1][0])} style={{ padding: "13px 18px", borderRadius: 10, border: `1px solid ${C.border}`, background: C.surface, color: C.ink, fontWeight: 700, fontSize: 14, cursor: "pointer" }}>Back</button>}
          <div style={{ flex: 1 }} />
          {step !== "list"
            ? <button type="button" disabled={!canNext} onClick={() => { setStep(STEPS[at + 1][0]); const box = document.getElementById("ls-box"); if (box) box.scrollTop = 0; }}
                style={{ padding: "13px 26px", borderRadius: 10, border: "none", background: C.ink, color: "#FAF0DC", fontWeight: 800, fontSize: 15, cursor: canNext ? "pointer" : "not-allowed", opacity: canNext ? 1 : .4 }}>Next</button>
            : allLive
            ? <button type="button" onClick={() => (onDone || onClose)()}
                style={{ padding: "13px 30px", borderRadius: 10, border: "none", background: C.green, color: "#fff", fontWeight: 800, fontSize: 15, cursor: "pointer" }}>✓ Done</button>
            : <>
                <button type="button" disabled={!chosen.length} onClick={() => apply(false)} style={{ padding: "13px 16px", borderRadius: 10, border: `1px solid ${C.border}`, background: C.surface, color: C.ink, fontWeight: 700, fontSize: 14, cursor: "pointer" }}>Save as drafts</button>
                <button type="button" disabled={!chosen.length || pieceMissing.length > 0} onClick={() => apply(true)} style={{ padding: "13px 22px", borderRadius: 10, border: "none", background: C.ink, color: "#FAF0DC", fontWeight: 800, fontSize: 15, cursor: "pointer", opacity: chosen.length && !pieceMissing.length ? 1 : .4 }}>Publish all live</button>
              </>}
        </div>
      </div>
    </div>
  );
}
