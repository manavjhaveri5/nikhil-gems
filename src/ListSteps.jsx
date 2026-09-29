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

export default function ListSteps({ form, orders, stock = [], weightKg = 0, rate = 88, start = "where", renderWhere, renderPlatform, onAI, aiBusy, onApply, onClose }) {
  const [step, setStep] = useState(start);
  const [pick, setPick] = useState(() => Object.fromEntries(CHANNELS.map(c => [c.key, linkOf(form, c.key).linked])));
  const [p, setP] = useState(() => ({
    price_etsy: form.price_etsy || "", price_ebay: form.price_ebay || "",
    price_store: form.price_store || "", price_store_inr: form.price_store_inr || "", price_trade: form.price_trade || "",
  }));
  const [s, setS] = useState(null);
  useEffect(() => { storeSettings().then(setS).catch(() => setS({})); }, []);
  useEffect(() => { const k = e => e.key === "Escape" && onClose(); addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, [onClose]);

  const now = useMemo(() => etsyNow(orders), [orders]);
  // The sale running now, or the store's own setting when there are no recent orders to read it from.
  const sale = now.sale ?? (+s?.etsy_discount_pct || 0);
  const fx = +s?.fx_inr_per_usd || 84;
  const etsyPrice = +p.price_etsy || 0;
  const etsyPays = Math.round(etsyPrice * (1 - sale / 100));
  // Until given their own, the store and eBay follow what an Etsy buyer pays.
  const storeUsd = +p.price_store || storePriceFor({ price_etsy: etsyPrice }, fx, s?.price_rounding, sale) || 0;
  const storeInr = +p.price_store_inr || (etsyPrice ? Math.round(etsyPays / 10) * 10 : 0);
  const ebayUsd = +p.price_ebay || (etsyPays ? Math.round(etsyPays / fx) : 0);

  // What the piece cost us, from its stock card (an older listing may carry its own); 0 if unknown.
  const cost = +form._stockCost || +form.price_calc?.cost || 0;
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
  const money4 = (pkey, paid, cur) => {
    if (!paid) return null;
    const gross = paid * (cur === "$" ? rate : 1);
    const feeBase = pkey === "ebay" ? gross * (1 + (now.tax || 0)) : gross;
    const fees = feeBase * FEES[pkey];
    const shipping = pkey === "trade" ? 0 : pkey === "store_in" ? shipIn : ship;
    // A sale within India owes 0.25% GST on stones (HSN 7103), inside the price; exports carry none.
    const gst = pkey === "store_in" ? gross * .0025 / 1.0025 : 0;
    return { gross, fees, shipping, gst, profit: gross - fees - shipping - gst - cost, onTax: pkey === "ebay" && now.tax > 0 };
  };
  const chosen = CHANNELS.filter(c => pick[c.key]);
  // Where → the piece → prices → a page for each platform picked → publish.
  const STEPS = [["where", "Where"], ["piece", "The piece"], ["price", "Price"],
    ...(renderPlatform ? chosen.map(c => [c.key, c.key === "store" ? "Retail" : c.label]) : []), ["list", "Publish"]];
  const at = Math.max(0, STEPS.findIndex(x => x[0] === step));
  /* Etsy, eBay and Earth Editions sell the actual piece, so it has to be
     findable and tied to its stock card; wholesale alone doesn't. */
  const retail = chosen.some(c => c.key !== "trade");
  const pieceMissing = retail ? [!form._loc && "where it's stored", !form.linked_stock_id && "its stock card"].filter(Boolean) : [];
  const canNext = step === "where" ? chosen.length > 0 : step === "piece" ? !pieceMissing.length : true;

  const apply = live => {
    const patch = {
      price_etsy: p.price_etsy,
      price_ebay: p.price_ebay || (pick.ebay && ebayUsd ? String(ebayUsd) : form.price_ebay || ""),
      price_store: p.price_store, price_store_inr: p.price_store_inr,
      price_trade: p.price_trade,
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
        ["Cost of the piece", -cost, C.inkMid],
      ].map(([k, v, col]) => (
        <div key={k} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: col, padding: "2px 0" }}>
          <span>{k}</span><span>{v < 0 ? "− " : ""}{v ? inr(Math.abs(v)) : "—"}</span>
        </div>
      ))}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", borderTop: `1px solid ${C.border}`, marginTop: 4, paddingTop: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 800, color: C.ink }}>Profit{!cost ? " · no cost on the stock card" : ""}</span>
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
            {pick.etsy && <Box>
              <div style={{ fontSize: 12, fontWeight: 800, color: C.ink, marginBottom: 8 }}>Etsy</div>
              <div style={{ display: "flex", gap: 16, alignItems: "flex-end" }}>
                <div style={{ flex: 1, minWidth: 0 }}>{money("price_etsy", "₹")}<div style={{ fontSize: 11.5, color: C.inkFaint, marginTop: 5 }}>Listed price{sale ? ", shown crossed out" : ""}</div></div>
                {pays(etsyPays ? inr(etsyPays) : "—",
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
                  <div key={c.key} style={{ display: "flex", alignItems: "center", gap: 10, padding: "13px 16px", borderTop: i ? `1px solid ${C.border}` : "none" }}>
                    <span style={{ width: 8, height: 8, borderRadius: 4, background: c.color }} />
                    <span style={{ flex: 1, fontSize: 14, fontWeight: 700, color: C.ink }}>{c.label}</span>
                    <span style={{ fontSize: 14, color: /No price/.test(price) ? C.red : C.ink }}>{price}</span>
                  </div>
                );
              }) : <div style={{ padding: 16, color: C.inkMid }}>Nowhere picked yet.</div>}
            </Box>
            <div style={{ fontSize: 12, color: C.inkFaint }}>Publish live puts it up on each of these and then gives you a link to see it live. Save as drafts keeps it off sale.</div>
          </>}
        </div>

        <div style={{ display: "flex", gap: 10, padding: "12px 18px calc(12px + env(safe-area-inset-bottom))", borderTop: `1px solid ${C.border}`, background: C.surface, position: "sticky", bottom: 0 }}>
          {at > 0 && <button type="button" onClick={() => setStep(STEPS[at - 1][0])} style={{ padding: "13px 18px", borderRadius: 10, border: `1px solid ${C.border}`, background: C.surface, color: C.ink, fontWeight: 700, fontSize: 14, cursor: "pointer" }}>Back</button>}
          <div style={{ flex: 1 }} />
          {step !== "list"
            ? <button type="button" disabled={!canNext} onClick={() => { setStep(STEPS[at + 1][0]); const box = document.getElementById("ls-box"); if (box) box.scrollTop = 0; }}
                style={{ padding: "13px 26px", borderRadius: 10, border: "none", background: C.ink, color: "#FAF0DC", fontWeight: 800, fontSize: 15, cursor: canNext ? "pointer" : "not-allowed", opacity: canNext ? 1 : .4 }}>Next</button>
            : <>
                <button type="button" disabled={!chosen.length} onClick={() => apply(false)} style={{ padding: "13px 16px", borderRadius: 10, border: `1px solid ${C.border}`, background: C.surface, color: C.ink, fontWeight: 700, fontSize: 14, cursor: "pointer" }}>Save as drafts</button>
                <button type="button" disabled={!chosen.length || pieceMissing.length > 0} onClick={() => apply(true)} style={{ padding: "13px 22px", borderRadius: 10, border: "none", background: C.ink, color: "#FAF0DC", fontWeight: 800, fontSize: 15, cursor: "pointer", opacity: chosen.length && !pieceMissing.length ? 1 : .4 }}>Publish live</button>
              </>}
        </div>
      </div>
    </div>
  );
}
