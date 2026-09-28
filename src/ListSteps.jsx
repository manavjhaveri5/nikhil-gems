/* Listing a piece, one step at a time: where it goes, what it costs on each
   of those places (the price the customer pays, nothing else), then list it.
   Etsy's sale, shipping and sales tax are read from the shop's own recent
   orders, so there is nothing to set: the fees are Etsy's and don't change. */
import { useEffect, useMemo, useState } from "react";
import { C } from "./lmTheme.js";
import { CHANNELS, linkOf } from "./listingChannels.js";
import { storeSettings, storePriceFor } from "./StoreApp.jsx";

const serif = "'Cormorant Garamond',Georgia,serif";
const DAY = 86400000;
const inr = v => `₹${Math.round(v).toLocaleString("en-IN")}`;
const usd = v => `$${(+v).toLocaleString("en-US", { maximumFractionDigits: +v >= 100 ? 0 : 2 })}`;
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const t = o => Date.parse(o.created_at || o.date || "") || 0;

/* What Etsy buyers are paying right now, from the shop's recent orders: the
   sale running (the discount on the latest orders), what shipping usually
   adds, and the sales tax Etsy puts on top for buyers who owe it. */
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
  const shipping = median(etsy.slice(0, 50).map(o => +o.order_shipping || 0).filter(v => v > 0));
  return { sale, orders: recent.length, tax, taxShare: last100.length ? taxed.length / last100.length : 0, taxWhere, shipping };
}

const PLACE = {
  etsy: "Retail, worldwide",
  ebay: "Retail, US auctions & buy-now",
  store: "eartheditions.co · USA and India",
  trade: "trade.eartheditions.co · wholesale buyers",
};

const Box = ({ children, style }) => <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: "16px 18px", ...style }}>{children}</div>;

export default function ListSteps({ form, orders, start = "where", onApply, onClose }) {
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

  const chosen = CHANNELS.filter(c => pick[c.key]);
  const STEPS = [["where", "Where"], ["price", "Price"], ["list", "List"]];
  const at = STEPS.findIndex(x => x[0] === step);

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

  return (
    <div onMouseDown={e => e.target === e.currentTarget && onClose()} style={{ position: "fixed", inset: 0, zIndex: 400, background: "rgba(20,15,8,.5)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: C.bg, width: "100%", maxWidth: 560, maxHeight: "100%", height: innerWidth < 700 ? "100%" : "auto", overflowY: "auto", borderRadius: innerWidth < 700 ? 0 : 16, display: "flex", flexDirection: "column", boxShadow: "0 24px 80px rgba(0,0,0,.3)" }}>
        {/* steps */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "calc(14px + env(safe-area-inset-top)) 18px 12px", background: C.surface, borderBottom: `1px solid ${C.border}`, position: "sticky", top: 0, zIndex: 2 }}>
          {form.images?.[0] && typeof form.images[0] === "string" && <img src={form.images[0]} alt="" style={{ width: 34, height: 34, borderRadius: 7, objectFit: "cover" }} />}
          <div style={{ flex: 1, display: "flex", gap: 6 }}>
            {STEPS.map(([k, label], i) => (
              <button key={k} type="button" onClick={() => (i <= at || chosen.length) && setStep(k)}
                style={{ flex: 1, border: "none", background: "none", padding: "4px 0", cursor: "pointer", textAlign: "left" }}>
                <div style={{ height: 3, borderRadius: 2, background: i <= at ? C.ink : C.border }} />
                <div style={{ fontSize: 11.5, fontWeight: i === at ? 800 : 500, color: i === at ? C.ink : C.inkMid, marginTop: 5 }}>{i + 1} · {label}</div>
              </button>
            ))}
          </div>
          <button type="button" onClick={onClose} style={{ border: "none", background: "none", fontSize: 24, color: C.inkMid, cursor: "pointer" }}>×</button>
        </div>

        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12, flex: 1 }}>
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
            {pick.etsy && <Box>
              <div style={{ fontSize: 12, fontWeight: 800, color: C.ink, marginBottom: 8 }}>Etsy</div>
              <div style={{ display: "flex", gap: 16, alignItems: "flex-end" }}>
                <div style={{ flex: 1, minWidth: 0 }}>{money("price_etsy", "₹")}<div style={{ fontSize: 11.5, color: C.inkFaint, marginTop: 5 }}>Listed price{sale ? ", shown crossed out" : ""}</div></div>
                {pays(etsyPays ? inr(etsyPays) : "—", sale ? `in your ${sale}% sale` : "no sale running")}
              </div>
              <div style={{ fontSize: 12, color: C.inkMid, marginTop: 12, lineHeight: 1.55, borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
                {now.orders ? <>Sale read from your last {now.orders} Etsy order{now.orders === 1 ? "" : "s"}.</> : <>No Etsy orders in the last 30 days — using your store's {sale}% setting.</>}
                {now.shipping > 0 && <> Shipping usually adds {inr(now.shipping)}.</>}
                {now.tax > 0 && <> {now.taxWhere === "US" ? "US buyers" : "Some buyers"} also pay about {Math.round(now.tax * 100)}% sales tax on top — Etsy adds it at checkout and pays it over; it isn't yours.</>}
                {etsyPays > 0 && now.tax > 0 && <div style={{ marginTop: 6, color: C.ink }}>All in for {now.taxWhere === "US" ? "a US" : "a taxed"} buyer: about <b>{inr((etsyPays + (now.shipping || 0)) * (1 + now.tax))}</b></div>}
              </div>
            </Box>}
            {pick.ebay && <Box>
              <div style={{ fontSize: 12, fontWeight: 800, color: C.ink, marginBottom: 8 }}>eBay</div>
              <div style={{ display: "flex", gap: 16, alignItems: "flex-end" }}>
                <div style={{ flex: 1, minWidth: 0 }}>{money("price_ebay", "$", ebayUsd ? String(ebayUsd) : "")}<div style={{ fontSize: 11.5, color: C.inkFaint, marginTop: 5 }}>{p.price_ebay ? "Your price" : "Same as an Etsy buyer pays, in dollars"}</div></div>
                {pays(ebayUsd ? usd(ebayUsd) : "—", "+ shipping")}
              </div>
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
            </Box>}
            {pick.trade && <Box>
              <div style={{ fontSize: 12, fontWeight: 800, color: C.ink, marginBottom: 8 }}>Wholesale</div>
              <div style={{ display: "flex", gap: 16, alignItems: "flex-end" }}>
                <div style={{ flex: 1, minWidth: 0 }}>{money("price_trade", "$")}<div style={{ fontSize: 11.5, color: C.inkFaint, marginTop: 5 }}>Per piece, lot or kilo — as set on the Wholesale tab</div></div>
                {pays(+p.price_trade ? usd(+p.price_trade) : "—", "trade buyers")}
              </div>
            </Box>}
          </>}

          {step === "list" && <>
            <div style={{ fontFamily: serif, fontSize: 28, color: C.ink }}>Ready to list</div>
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
            <div style={{ fontSize: 12, color: C.inkFaint }}>Title, description, tags and photos are the ones on the listing — change them there before listing if they need it.</div>
          </>}
        </div>

        <div style={{ display: "flex", gap: 10, padding: "12px 18px calc(12px + env(safe-area-inset-bottom))", borderTop: `1px solid ${C.border}`, background: C.surface, position: "sticky", bottom: 0 }}>
          {at > 0 && <button type="button" onClick={() => setStep(STEPS[at - 1][0])} style={{ padding: "13px 18px", borderRadius: 10, border: `1px solid ${C.border}`, background: C.surface, color: C.ink, fontWeight: 700, fontSize: 14, cursor: "pointer" }}>Back</button>}
          <div style={{ flex: 1 }} />
          {step !== "list"
            ? <button type="button" disabled={!chosen.length} onClick={() => setStep(STEPS[at + 1][0])}
                style={{ padding: "13px 26px", borderRadius: 10, border: "none", background: C.ink, color: "#FAF0DC", fontWeight: 800, fontSize: 15, cursor: "pointer", opacity: chosen.length ? 1 : .4 }}>Next</button>
            : <>
                <button type="button" disabled={!chosen.length} onClick={() => apply(false)} style={{ padding: "13px 16px", borderRadius: 10, border: `1px solid ${C.border}`, background: C.surface, color: C.ink, fontWeight: 700, fontSize: 14, cursor: "pointer" }}>Save as drafts</button>
                <button type="button" disabled={!chosen.length} onClick={() => apply(true)} style={{ padding: "13px 22px", borderRadius: 10, border: "none", background: C.ink, color: "#FAF0DC", fontWeight: 800, fontSize: 15, cursor: "pointer", opacity: chosen.length ? 1 : .4 }}>List live</button>
              </>}
        </div>
      </div>
    </div>
  );
}
