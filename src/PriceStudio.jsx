/* Price Studio: one page, no steps. What it cost (per piece or per kilo),
   what a piece weighs, the margin, Etsy's fees and sale, the shipping
   profile and its cost — and, as you type, the price for every platform,
   the per-piece price, what's left after fees and the profit.

   Etsy shows a crossed-out full price and a sale price, so the full price is
   set high enough that during the usual sale, after fees, the piece still
   makes its margin. The store sells at the Etsy price less its discount.
   Nothing is saved until Apply; the editor then saves as usual.
   The inputs are kept on the listing as price_calc (cost, extra, sale, fees,
   ads …), which the editor's price boxes read for their sale/profit lines. */
import { useEffect, useMemo, useState } from "react";
import { storePriceFor } from "./StoreApp.jsx";

const T = {
  ink: "#141210", mid: "#5d5850", faint: "#9a948a", line: "#ebe7e0", sunk: "#f6f4f0",
  accent: "#7a5a33", good: "#2f6b3a", bad: "#a33a2c",
  serif: "'Cormorant Garamond', Georgia, serif",
  sans: "Inter, Figtree, system-ui, sans-serif",
};
const PREFS_KEY = "lm-price-prefs";
const readPrefs = () => { try { return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") || {}; } catch { return {}; } };
const writePrefs = p => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch {} };

const inr = v => `₹${Math.round(+v || 0).toLocaleString("en-IN")}`;
const usd = v => `$${(+v || 0).toLocaleString("en-US", { minimumFractionDigits: +v % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
const n = v => (v === "" || v == null || !isFinite(+v) ? 0 : +v);
const grams = w => { // "500g", "1.2 kg", "755" → grams
  const m = String(w || "").toLowerCase().match(/([\d.]+)\s*(kg|kgs|kilo|g|gm|gms|gram|grams)?/);
  if (!m) return 0;
  return /^k/.test(m[2] || "") ? +m[1] * 1000 : +m[1];
};

// Round up, never down: rounding shouldn't eat into the margin.
const ROUNDS = {
  "99": v => Math.max(99, Math.ceil((v + 1) / 100) * 100 - 1),
  "100": v => Math.ceil(v / 100) * 100,
  "50": v => Math.ceil(v / 50) * 50,
  "10": v => Math.ceil(v / 10) * 10,
};
const roundUsd99 = v => (v <= 0 ? 0 : Math.max(0.99, Math.ceil(v) - 0.01));

/* Every number the studio shows, from its inputs. */
export function priceMath(i, { liveRate = 84, store = {} } = {}) {
  const perKg = i.unit === "kg";
  const w = n(i.weight);                                    // grams per piece
  const pcsKg = w > 0 ? 1000 / w : 0;
  const unitCost = n(i.cost) + n(i.extra) + n(i.shipCost);  // per piece, or per kilo
  const keep = i.mode === "profit" ? unitCost * (1 + n(i.profitPct) / 100) : unitCost * (n(i.mult) || 1);
  const fee = (n(i.fees) + (i.ads ? 15 : 0)) / 100;
  const sale = n(i.sale) / 100;
  // What the buyer pays in the sale so that, after fees, `keep` is left.
  const saleRaw = keep > 0 ? keep / Math.max(.05, 1 - fee) : 0;
  const fullRaw = saleRaw / Math.max(.05, 1 - sale);
  const etsy = fullRaw > 0 ? (ROUNDS[i.round] || ROUNDS["99"])(fullRaw) : 0;
  const salePrice = Math.round(etsy * (1 - sale));
  const netSale = salePrice * (1 - fee), netFull = etsy * (1 - fee);
  const profitSale = netSale - unitCost, profitFull = netFull - unitCost;
  const ebay = keep > 0 ? roundUsd99(keep / Math.max(.05, 1 - n(i.ebayFees) / 100) / (liveRate || 84)) : 0;
  const fx = +store.fx_inr_per_usd || 84, disc = store.etsy_discount_pct ?? 25;
  const storeUsd = etsy ? storePriceFor({ price_etsy: etsy }, fx, store.price_rounding || "whole", disc) : 0;
  const storeInr = etsy ? Math.round(etsy * (1 - (+disc || 0) / 100) / 10) * 10 : 0;
  const trade = unitCost > 0 ? Math.round(unitCost * (n(i.tradeMult) || 1) / (liveRate || 84) * 100) / 100 : 0;
  // The other unit: per kilo ↔ per piece, through the weight.
  const other = !pcsKg ? null : perKg
    ? { label: "per piece", etsy: etsy / pcsKg, sale: salePrice / pcsKg, cost: unitCost / pcsKg, trade: trade / pcsKg }
    : { label: "per kilo", etsy: etsy * pcsKg, sale: salePrice * pcsKg, cost: unitCost * pcsKg, trade: trade * pcsKg };
  return { perKg, pcsKg, unitCost, keep, fee, sale, etsy, salePrice, netSale, netFull, profitSale, profitFull,
    marginSale: salePrice ? profitSale / salePrice : 0, ebay, storeUsd, storeInr, trade, other, fx, disc };
}

export default function PriceStudio({ listing = {}, stockCost = 0, stockWeight = 0, liveRate = 84, loadSettings, shippingProfiles = [], onApply, onClose }) {
  const prefs = useMemo(readPrefs, []);
  const last = listing.price_calc || {};
  const [i, setI] = useState(() => ({
    unit: last.unit || "piece",
    cost: last.cost ?? (stockCost || ""), extra: last.extra ?? "",
    weight: last.weight ?? (grams(listing.weight) || stockWeight || ""),
    mode: last.mode === "profit" ? "profit" : "mult", mult: last.mult ?? prefs.mult ?? 3, profitPct: last.profitPct ?? prefs.profitPct ?? 150,
    fees: last.fees ?? prefs.fees ?? 11, ads: last.ads ?? prefs.ads ?? false, sale: last.sale ?? prefs.sale ?? 20,
    shipProfile: listing.etsy_shipping_profile_id ?? "", shipCost: last.shipCost ?? "",
    round: last.round || prefs.round || "99", ebayFees: last.ebayFees ?? prefs.ebayFees ?? 15, tradeMult: last.tradeMult ?? prefs.tradeMult ?? 1.8,
  }));
  const [store, setStore] = useState({});
  const [take, setTake] = useState({ etsy: true, ebay: true, storeUsd: false, storeInr: false, trade: false });
  useEffect(() => { loadSettings?.().then(s => setStore(s || {})).catch(() => {}); }, [loadSettings]);
  useEffect(() => { const k = e => e.key === "Escape" && onClose(); addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, [onClose]);
  const set = (k, v) => setI(x => ({ ...x, [k]: v }));
  const m = useMemo(() => priceMath(i, { liveRate, store }), [i, liveRate, store]);
  const per = m.perKg ? "/kg" : "/pc";

  const apply = () => {
    const { shipProfile, ...calc } = i;
    writePrefs({ mult: i.mult, profitPct: i.profitPct, fees: i.fees, ads: i.ads, sale: i.sale, round: i.round, ebayFees: i.ebayFees, tradeMult: i.tradeMult });
    onApply({
      ...(take.etsy && m.etsy ? { price_etsy: m.etsy } : {}),
      ...(take.ebay && m.ebay ? { price_ebay: m.ebay } : {}),
      ...(take.storeUsd && m.storeUsd ? { price_store: m.storeUsd } : {}),
      ...(take.storeInr && m.storeInr ? { price_store_inr: m.storeInr } : {}),
      ...(take.trade && m.trade ? { price_trade: m.trade } : {}),
      ...(shipProfile !== "" ? { etsy_shipping_profile_id: +shipProfile || null } : {}),
      ...(!listing.weight && n(i.weight) ? { weight: `${i.weight}g` } : {}),
      price_calc: calc,
    });
  };

  const field = (label, k, { prefix = "₹", suffix = "", placeholder = "0", hint, w } = {}) => (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0, ...(w ? { width: w } : { flex: 1 }) }}>
      <span style={lab}>{label}</span>
      <span style={{ display: "flex", alignItems: "baseline", gap: 4, borderBottom: `1px solid ${T.ink}` }}>
        {prefix && <span style={{ color: T.faint, fontSize: 15 }}>{prefix}</span>}
        <input value={i[k]} onChange={e => set(k, e.target.value.replace(/[^\d.]/g, ""))} inputMode="decimal" placeholder={placeholder}
          style={{ flex: 1, minWidth: 0, border: 0, outline: "none", background: "transparent", fontSize: 18, fontFamily: T.sans, color: T.ink, padding: "4px 0" }} />
        {suffix && <span style={{ color: T.faint, fontSize: 13 }}>{suffix}</span>}
      </span>
      {hint && <span style={{ fontSize: 11, color: T.faint }}>{hint}</span>}
    </label>
  );
  const seg = (k, opts) => (
    <div style={{ display: "flex", border: `1px solid ${T.line}` }}>
      {opts.map(([v, t]) => <button key={v} type="button" onClick={() => set(k, v)} style={{ flex: 1, padding: "7px 10px", border: 0, cursor: "pointer", fontSize: 12.5,
        background: i[k] === v ? T.ink : "#fff", color: i[k] === v ? "#fff" : T.mid, fontFamily: T.sans }}>{t}</button>)}
    </div>
  );
  const row = (k, label, value, sub, strong) => (
    <div style={{ display: "flex", alignItems: "baseline", gap: 10, padding: "8px 0", borderBottom: `1px solid ${T.line}` }}>
      {k && <input type="checkbox" checked={!!take[k]} onChange={e => setTake(t => ({ ...t, [k]: e.target.checked }))} style={{ accentColor: T.ink, margin: 0 }} title="Fill this price in" />}
      <span style={{ flex: 1, fontSize: 13.5, color: strong ? T.ink : T.mid, fontWeight: strong ? 600 : 400 }}>{label}{sub && <span style={{ display: "block", fontSize: 11, color: T.faint, fontWeight: 400 }}>{sub}</span>}</span>
      <span style={{ fontFamily: strong ? T.serif : T.sans, fontSize: strong ? 26 : 15, fontWeight: strong ? 500 : 600, color: T.ink }}>{value}</span>
    </div>
  );

  return (
    <div onMouseDown={e => e.target === e.currentTarget && onClose()} style={{ position: "fixed", inset: 0, zIndex: 3000, background: "rgba(20,18,16,.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, fontFamily: T.sans }}>
      <div style={{ background: "#fff", width: "100%", maxWidth: 1060, maxHeight: "94vh", display: "flex", flexDirection: "column", boxShadow: "0 24px 70px rgba(0,0,0,.28)" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 14, padding: "18px 26px", borderBottom: `1px solid ${T.line}` }}>
          <span style={{ fontFamily: T.serif, fontSize: 26 }}>Price Studio</span>
          <span style={{ fontSize: 13, color: T.faint, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{listing.title}</span>
          <button onClick={onClose} style={{ border: 0, background: "none", fontSize: 24, cursor: "pointer", color: T.mid }}>×</button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.15fr) minmax(0, 1fr)", gap: 0, overflowY: "auto", flex: 1 }}>
          {/* inputs */}
          <div style={{ padding: "20px 26px", display: "flex", flexDirection: "column", gap: 18, borderRight: `1px solid ${T.line}` }}>
            <div>
              <span style={lab}>Priced</span>
              {seg("unit", [["piece", "Per piece"], ["kg", "Per kilo"]])}
            </div>
            <div style={{ display: "flex", gap: 18 }}>
              {field(`Cost ${m.perKg ? "per kilo" : "per piece"}`, "cost", { hint: stockCost ? `Stock cost: ${inr(stockCost)}` : "What you paid" })}
              {field("Extra costs", "extra", { hint: "Polishing, stand, packing" })}
            </div>
            <div style={{ display: "flex", gap: 18 }}>
              {field("Weight per piece", "weight", { prefix: "", suffix: "g", hint: m.pcsKg ? `≈ ${m.pcsKg >= 10 ? Math.round(m.pcsKg) : m.pcsKg.toFixed(1)} pieces per kilo` : "For the per-piece / per-kilo price" })}
              <div style={{ flex: 1 }} />
            </div>
            <div>
              <span style={lab}>Margin</span>
              <div style={{ display: "flex", gap: 14, alignItems: "flex-end" }}>
                <div style={{ width: 210 }}>{seg("mode", [["mult", "× cost"], ["profit", "Profit %"]])}</div>
                {i.mode === "mult" ? field("", "mult", { prefix: "×", placeholder: "3", w: 110 }) : field("", "profitPct", { prefix: "", suffix: "%", placeholder: "150", w: 110 })}
                <span style={{ fontSize: 12, color: T.faint, paddingBottom: 6 }}>keep {inr(m.keep)}{per} after fees</span>
              </div>
            </div>
            <div style={{ display: "flex", gap: 18, alignItems: "flex-end" }}>
              {field("Etsy fees", "fees", { prefix: "", suffix: "%", w: 110, hint: "Listing, transaction, payment" })}
              <label style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13, color: T.mid, paddingBottom: 22, cursor: "pointer" }}>
                <input type="checkbox" checked={!!i.ads} onChange={e => set("ads", e.target.checked)} style={{ accentColor: T.ink }} /> Offsite ads (+15%)
              </label>
              {field("Etsy sale", "sale", { prefix: "", suffix: "% off", w: 120, hint: "Your usual sale" })}
            </div>
            <div style={{ display: "flex", gap: 18, alignItems: "flex-end" }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1.4, minWidth: 0 }}>
                <span style={lab}>Etsy shipping profile</span>
                <select value={i.shipProfile ?? ""} onChange={e => set("shipProfile", e.target.value)} style={{ border: 0, borderBottom: `1px solid ${T.ink}`, padding: "7px 0", fontSize: 14, background: "transparent", fontFamily: T.sans, color: T.ink }}>
                  <option value="">Auto (by price)</option>
                  {shippingProfiles.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
              </label>
              {field("Shipping you pay", "shipCost", { hint: "Added to cost if shipping is free" })}
            </div>
            <div style={{ display: "flex", gap: 18, alignItems: "flex-end" }}>
              <div style={{ flex: 1.4 }}>
                <span style={lab}>Round Etsy price up to</span>
                {seg("round", [["99", "…99"], ["100", "₹100"], ["50", "₹50"], ["10", "₹10"]])}
              </div>
              {field("eBay fees", "ebayFees", { prefix: "", suffix: "%", w: 90 })}
              {field("Wholesale", "tradeMult", { prefix: "×", w: 90, hint: "× cost" })}
            </div>
          </div>

          {/* results */}
          <div style={{ padding: "20px 26px", background: T.sunk, display: "flex", flexDirection: "column" }}>
            <span style={{ ...lab, marginBottom: 2 }}>Prices · tick the ones to fill in</span>
            {row("etsy", `Etsy full price${per}`, m.etsy ? inr(m.etsy) : "—", m.sale ? `Shown crossed out; ${Math.round(m.sale * 100)}% sale price ${inr(m.salePrice)}` : null, true)}
            {row("ebay", `eBay${per}`, m.ebay ? usd(m.ebay) : "—", `after ${i.ebayFees || 0}% fees, at ₹${Math.round(liveRate)}/$`)}
            {row("storeUsd", `EE store · USA${per}`, m.storeUsd ? usd(m.storeUsd) : "—", `Etsy less ${m.disc}% ÷ ${m.fx} — leave unticked to keep following Etsy`)}
            {row("storeInr", `EE store · India${per}`, m.storeInr ? inr(m.storeInr) : "—", `Etsy less ${m.disc}%`)}
            {row("trade", `Wholesale${per}`, m.trade ? usd(m.trade) : "—", `cost × ${i.tradeMult || 1}`)}

            <span style={{ ...lab, marginTop: 18, marginBottom: 2 }}>What you make, per {m.perKg ? "kilo" : "piece"}</span>
            {row(null, "Cost", m.unitCost ? inr(m.unitCost) : "—", n(i.shipCost) ? `includes ${inr(i.shipCost)} shipping` : null)}
            {row(null, `In the ${i.sale || 0}% sale, after fees`, m.netSale ? inr(m.netSale) : "—", `${Math.round(m.fee * 100)}% Etsy fees`)}
            <div style={{ display: "flex", gap: 10, padding: "10px 0", borderBottom: `1px solid ${T.line}` }}>
              <div style={{ flex: 1 }}><div style={{ fontSize: 11, color: T.faint }}>Profit in the sale</div><div style={{ fontFamily: T.serif, fontSize: 28, color: m.profitSale >= 0 ? T.good : T.bad }}>{m.etsy ? inr(m.profitSale) : "—"}</div></div>
              <div style={{ flex: 1 }}><div style={{ fontSize: 11, color: T.faint }}>Margin</div><div style={{ fontFamily: T.serif, fontSize: 28, color: T.ink }}>{m.etsy ? `${Math.round(m.marginSale * 100)}%` : "—"}</div></div>
              <div style={{ flex: 1 }}><div style={{ fontSize: 11, color: T.faint }}>At full price</div><div style={{ fontFamily: T.serif, fontSize: 28, color: T.ink }}>{m.etsy ? inr(m.profitFull) : "—"}</div></div>
            </div>
            {m.other && m.etsy > 0 && (
              <div style={{ marginTop: 14, padding: "10px 12px", background: "#fff", border: `1px solid ${T.line}`, fontSize: 13, color: T.mid, lineHeight: 1.6 }}>
                <b style={{ color: T.ink }}>{m.other.label}</b> ({m.pcsKg >= 10 ? Math.round(m.pcsKg) : m.pcsKg.toFixed(1)} pcs/kg): Etsy {inr(m.other.etsy)} · in the sale {inr(m.other.sale)} · cost {inr(m.other.cost)}{m.trade ? ` · wholesale ${usd(Math.round(m.other.trade * 100) / 100)}` : ""}
              </div>
            )}
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "14px 26px", borderTop: `1px solid ${T.line}` }}>
          <span style={{ fontSize: 12, color: T.faint, flex: 1 }}>Fills in the ticked prices{i.shipProfile !== "" ? " and the shipping profile" : ""}. Nothing is saved until you save the listing.</span>
          <button onClick={onClose} style={{ padding: "11px 20px", border: `1px solid ${T.line}`, background: "#fff", cursor: "pointer", fontSize: 12, letterSpacing: ".14em", textTransform: "uppercase" }}>Cancel</button>
          <button onClick={apply} disabled={!m.etsy} style={{ padding: "11px 26px", border: 0, background: m.etsy ? T.ink : T.line, color: "#fff", cursor: m.etsy ? "pointer" : "not-allowed", fontSize: 12, letterSpacing: ".14em", textTransform: "uppercase" }}>Apply prices</button>
        </div>
      </div>
    </div>
  );
}
const lab = { fontSize: 10.5, letterSpacing: ".16em", textTransform: "uppercase", color: T.mid, display: "block", marginBottom: 6 };
