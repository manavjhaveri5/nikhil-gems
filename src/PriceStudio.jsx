/* Price Studio: a few calm steps from "what it cost" to every platform's
   price, in the look of eartheditions.co (white, hairlines, serif questions,
   square black buttons).

   The idea it's built around: Etsy shows a crossed-out full price and a sale
   price, so the full price is set high enough that during the usual sale,
   after Etsy's fees, the piece still makes what it should. The store sells
   at the Etsy price less its own discount, so its prices follow the same
   numbers. Nothing is saved until Apply; the editor then saves as usual. */
import { useEffect, useMemo, useRef, useState } from "react";
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

// Round up, never down: rounding shouldn't eat into the margin.
const ROUNDS = [
  { key: "99",  label: "Ends in 99", eg: "₹2,499", f: v => Math.max(99, Math.ceil((v + 1) / 100) * 100 - 1) },
  { key: "100", label: "Nearest ₹100", eg: "₹2,500", f: v => Math.ceil(v / 100) * 100 },
  { key: "50",  label: "Nearest ₹50", eg: "₹2,450", f: v => Math.ceil(v / 50) * 50 },
  { key: "10",  label: "Nearest ₹10", eg: "₹2,440", f: v => Math.ceil(v / 10) * 10 },
];
const roundInr = (v, key) => (ROUNDS.find(r => r.key === key) || ROUNDS[0]).f(v);
const roundUsd99 = v => (v <= 0 ? 0 : Math.max(0.99, Math.ceil(v) - 0.01));

/* Every number the studio shows, from its inputs. */
export function priceMath(inp, { liveRate = 84, store = {} } = {}) {
  const cost = n(inp.cost) + n(inp.extra);
  const keep = inp.mode === "amount" ? n(inp.keepAmount) : cost * (n(inp.mult) || 1);
  const fee = (n(inp.fees) + (inp.ads ? 15 : 0)) / 100;
  const sale = n(inp.sale) / 100;
  // What the buyer must pay during the sale so that, after fees, `keep` is left.
  const saleRaw = keep > 0 ? keep / Math.max(.05, 1 - fee) : 0;
  const fullRaw = saleRaw / Math.max(.05, 1 - sale);
  const etsy = fullRaw > 0 ? roundInr(fullRaw, inp.round) : 0;
  const salePrice = Math.round(etsy * (1 - sale));
  const netSale = salePrice * (1 - fee);
  const netFull = etsy * (1 - fee);
  const ebayFee = n(inp.ebayFees) / 100;
  const ebay = keep > 0 ? roundUsd99(keep / Math.max(.05, 1 - ebayFee) / (liveRate || 84)) : 0;
  const fx = +store.fx_inr_per_usd || 84, disc = store.etsy_discount_pct ?? 25;
  const storeUsd = etsy ? storePriceFor({ price_etsy: etsy }, fx, store.price_rounding || "whole", disc) : 0;
  const storeInr = etsy ? Math.round(etsy * (1 - (+disc || 0) / 100) / 10) * 10 : 0;
  return { cost, keep, fee, sale, etsy, salePrice, netSale, netFull, profitSale: netSale - cost, profitFull: netFull - cost,
    ebay, storeUsd, storeInr, fx, disc };
}

const STEPS = ["Cost", "Margin", "Etsy sale", "Round", "Everywhere", "Review"];

export default function PriceStudio({ listing = {}, stockCost = 0, liveRate = 84, loadSettings, onApply, onClose }) {
  const prefs = useMemo(readPrefs, []);
  const last = listing.price_calc || {};
  const [step, setStep] = useState(0);
  const [inp, setInp] = useState(() => ({
    cost: last.cost ?? (stockCost || ""), extra: last.extra ?? "",
    mode: last.mode || "mult", mult: last.mult ?? prefs.mult ?? 3, keepAmount: last.keepAmount ?? "",
    sale: last.sale ?? prefs.sale ?? 20, fees: last.fees ?? prefs.fees ?? 11, ads: last.ads ?? prefs.ads ?? false,
    round: last.round || prefs.round || "99", ebayFees: prefs.ebayFees ?? 15,
  }));
  // Which other prices to set. Earth Editions left alone follows Etsy by itself.
  const [take, setTake] = useState({ ebay: true, storeUsd: false, storeInr: false });
  const [custom, setCustom] = useState({});
  const [store, setStore] = useState({});
  const [dir, setDir] = useState(1);
  const firstRef = useRef(null);
  const phone = typeof window !== "undefined" && window.innerWidth < 760;

  useEffect(() => { loadSettings?.().then(s => s && setStore(s)).catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const t = setTimeout(() => firstRef.current?.focus(), 250); return () => clearTimeout(t); }, [step]);
  useEffect(() => { const k = e => e.key === "Escape" && onClose(); addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, [onClose]);

  const m = priceMath(inp, { liveRate, store });
  const set = (k, v) => setInp(s => ({ ...s, [k]: v }));
  const can = [n(inp.cost) > 0 || (inp.mode === "amount"), m.keep > 0, true, m.etsy > 0, true, m.etsy > 0];
  const go = d => { setDir(d); setStep(s => Math.min(STEPS.length - 1, Math.max(0, s + d))); };
  const val = k => (custom[k] != null ? custom[k] : { ebay: m.ebay, storeUsd: m.storeUsd, storeInr: m.storeInr }[k]);

  const apply = () => {
    const patch = { price_etsy: String(m.etsy) };
    if (take.ebay && n(val("ebay")) > 0) patch.price_ebay = (+val("ebay")).toFixed(2);
    if (take.storeUsd && n(val("storeUsd")) > 0) patch.price_store = String(val("storeUsd"));
    if (take.storeInr && n(val("storeInr")) > 0) patch.price_store_inr = String(Math.round(val("storeInr")));
    patch.price_calc = { cost: inp.cost, extra: inp.extra, mode: inp.mode, mult: inp.mult, keepAmount: inp.keepAmount,
      sale: inp.sale, fees: inp.fees, ads: inp.ads, round: inp.round, at: new Date().toISOString() };
    writePrefs({ ...prefs, sale: inp.sale, fees: inp.fees, ads: inp.ads, round: inp.round, mult: inp.mult, ebayFees: inp.ebayFees });
    onApply(patch);
  };
  const next = () => { if (!can[step]) return; step === STEPS.length - 1 ? apply() : go(1); };

  /* ── pieces ─────────────────────────────────────────────────────────── */
  // Called as functions, not <Tags />: they're rebuilt every render, and as
  // components an input inside would remount and lose focus on each key.
  const Q = ({ eyebrow, title, lede }) => (
    <div style={{ marginBottom: 26 }}>
      <div style={eyebrowS}>{eyebrow}</div>
      <h2 style={{ fontFamily: T.serif, fontWeight: 500, fontSize: phone ? 34 : 44, lineHeight: 1.02, margin: "10px 0 0", letterSpacing: "-.005em" }}>{title}</h2>
      {lede && <p style={{ color: T.mid, fontSize: 15.5, lineHeight: 1.55, margin: "12px 0 0", maxWidth: "44ch" }}>{lede}</p>}
    </div>
  );
  const Big = ({ value, onChange, prefix = "₹", placeholder = "0", inputRef, hint }) => (
    <label style={{ display: "block", borderBottom: `1px solid ${T.ink}`, paddingBottom: 6 }}>
      <span style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontFamily: T.serif, fontSize: 40, color: T.mid }}>{prefix}</span>
        <input ref={inputRef} value={value} inputMode="decimal" placeholder={placeholder}
          onChange={e => onChange(e.target.value.replace(/[^\d.]/g, ""))} onKeyDown={e => e.key === "Enter" && next()}
          style={{ flex: 1, minWidth: 0, border: 0, outline: "none", background: "transparent", fontFamily: T.serif, fontSize: 52, lineHeight: 1.1, color: T.ink, padding: 0 }} />
      </span>
      {hint && <span style={{ display: "block", fontSize: 12.5, color: T.faint, marginTop: 4 }}>{hint}</span>}
    </label>
  );
  const Chips = ({ items, on, pick }) => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {items.map(([k, label, sub]) => {
        const sel = String(on) === String(k);
        return (
          <button key={k} type="button" onClick={() => pick(k)} style={{ minHeight: 48, padding: sub ? "8px 16px" : "0 18px", border: `1px solid ${sel ? T.ink : T.line}`, background: sel ? T.ink : "#fff",
            color: sel ? "#fff" : T.ink, cursor: "pointer", fontSize: 14, letterSpacing: ".02em", textAlign: "left", transition: "all .18s" }}>
            <span style={{ display: "block", fontWeight: 500 }}>{label}</span>
            {sub && <span style={{ display: "block", fontSize: 11.5, color: sel ? "rgba(255,255,255,.7)" : T.faint, marginTop: 2 }}>{sub}</span>}
          </button>
        );
      })}
    </div>
  );
  const Row = ({ k, v, strong, tone, sub }) => (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, padding: "11px 0", borderBottom: `1px solid ${T.line}` }}>
      <span style={{ color: strong ? T.ink : T.mid, fontSize: 14 }}>{k}{sub && <span style={{ display: "block", fontSize: 11.5, color: T.faint }}>{sub}</span>}</span>
      <span style={{ fontFamily: strong ? T.serif : T.sans, fontSize: strong ? 26 : 15, fontWeight: strong ? 500 : 500, color: tone || T.ink, whiteSpace: "nowrap" }}>{v}</span>
    </div>
  );

  /* The Etsy listing as a buyer sees it during the sale. */
  const EtsyPreview = ({ small }) => (
    <div style={{ border: `1px solid ${T.line}`, background: "#fff", display: "flex", gap: 14, padding: small ? 12 : 16, alignItems: "center" }}>
      {listing.images?.[0] && typeof listing.images[0] === "string" && <img src={listing.images[0]} alt="" style={{ width: small ? 54 : 76, height: small ? 54 : 76, objectFit: "cover", flex: "none" }} />}
      <div style={{ minWidth: 0 }}>
        <div style={{ ...eyebrowS, fontSize: 10 }}>On Etsy{m.sale ? `, during your ${Math.round(m.sale * 100)}% sale` : ""}</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 6, flexWrap: "wrap" }}>
          <span style={{ fontFamily: T.serif, fontSize: small ? 26 : 34, lineHeight: 1 }}>{m.etsy ? inr(m.sale ? m.salePrice : m.etsy) : "—"}</span>
          {m.sale > 0 && m.etsy > 0 && <span style={{ color: T.faint, textDecoration: "line-through", fontSize: 15 }}>{inr(m.etsy)}</span>}
          {m.sale > 0 && m.etsy > 0 && <span style={{ color: T.good, fontSize: 13, fontWeight: 600 }}>{Math.round(m.sale * 100)}% off</span>}
        </div>
      </div>
    </div>
  );

  const profitTone = p => (p > 0 ? T.good : T.bad);
  const pct = (p, of) => (of > 0 ? `${Math.round((p / of) * 100)}%` : "—");

  /* ── the steps ──────────────────────────────────────────────────────── */
  const body = [
    <div key="cost">
      <Q eyebrow="Step 1 · Cost" title="What did this piece cost you?" lede="The price you paid for it, in rupees. Add anything else it cost to get it ready, like polishing, a stand or packing." />
      {Big({ inputRef: firstRef, value: inp.cost, onChange: v => set("cost", v), hint: stockCost ? `From the linked stock item: ${inr(stockCost)}` : "Cost of the piece" })}
      <div style={{ marginTop: 26, maxWidth: 320 }}>
        <div style={eyebrowS}>Extra costs (optional)</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6, borderBottom: `1px solid ${T.line}`, marginTop: 8 }}>
          <span style={{ color: T.mid }}>₹</span>
          <input value={inp.extra} inputMode="decimal" placeholder="0" onChange={e => set("extra", e.target.value.replace(/[^\d.]/g, ""))} onKeyDown={e => e.key === "Enter" && next()}
            style={{ flex: 1, border: 0, outline: "none", fontSize: 20, padding: "8px 0", background: "transparent" }} />
        </div>
      </div>
    </div>,

    <div key="margin">
      <Q eyebrow="Step 2 · Margin" title="How much should it bring in?" lede="What you want in hand after Etsy's fees, even during a sale. Pick a markup on cost, or type the amount." />
      <Chips on={inp.mode === "mult" ? inp.mult : ""} pick={k => setInp(s => ({ ...s, mode: "mult", mult: k }))}
        items={[2, 2.5, 3, 4, 5].map(x => [x, `${x}×`, m.cost ? inr(m.cost * x) : "on cost"])} />
      <div style={{ marginTop: 26 }}>
        <div style={eyebrowS}>Or the amount you want in hand</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6, borderBottom: `1px solid ${inp.mode === "amount" ? T.ink : T.line}`, marginTop: 8, maxWidth: 320 }}>
          <span style={{ color: T.mid }}>₹</span>
          <input ref={firstRef} value={inp.mode === "amount" ? inp.keepAmount : ""} inputMode="decimal" placeholder={m.keep ? String(Math.round(m.keep)) : "0"}
            onChange={e => setInp(s => ({ ...s, mode: "amount", keepAmount: e.target.value.replace(/[^\d.]/g, "") }))} onKeyDown={e => e.key === "Enter" && next()}
            style={{ flex: 1, border: 0, outline: "none", fontSize: 20, padding: "8px 0", background: "transparent" }} />
        </div>
      </div>
      {m.keep > 0 && m.cost > 0 && <p style={{ color: T.mid, marginTop: 22, fontSize: 15 }}>That's <b style={{ color: T.ink }}>{inr(m.keep - m.cost)}</b> profit on a {inr(m.cost)} piece.</p>}
    </div>,

    <div key="sale">
      <Q eyebrow="Step 3 · Etsy sale" title="How big is your usual Etsy sale?" lede="Etsy shows the full price crossed out next to the sale price. The full price is set so the sale price still brings in your number." />
      <Chips on={inp.sale} pick={k => set("sale", k)} items={[[0, "No sale"], [10, "10%"], [15, "15%"], [20, "20%"], [25, "25%"], [30, "30%"], [40, "40%"]]} />
      <div style={{ marginTop: 28 }}>{EtsyPreview({})}</div>
      <div style={{ marginTop: 26, display: "flex", flexWrap: "wrap", gap: 18, alignItems: "center" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 14, color: T.mid }}>
          Etsy fees
          <span style={{ display: "flex", alignItems: "baseline", borderBottom: `1px solid ${T.line}` }}>
            <input value={inp.fees} inputMode="decimal" onChange={e => set("fees", e.target.value.replace(/[^\d.]/g, ""))} style={{ width: 44, border: 0, outline: "none", fontSize: 16, textAlign: "right", padding: "4px 2px", background: "transparent" }} />%
          </span>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 14, color: T.mid, cursor: "pointer" }}>
          <input type="checkbox" checked={!!inp.ads} onChange={e => set("ads", e.target.checked)} style={{ width: 18, height: 18, accentColor: T.ink, margin: 0 }} />
          Allow for Offsite Ads (+15%)
        </label>
      </div>
      <p style={{ color: T.faint, fontSize: 12.5, marginTop: 10, maxWidth: "52ch" }}>Fees cover Etsy's transaction and payment processing. Offsite Ads only charge when an ad brings the sale, so leave it off unless you want room for it.</p>
    </div>,

    <div key="round">
      <Q eyebrow="Step 4 · Round" title="How should the price look?" lede="Always rounded up, so rounding never cuts into what you make." />
      <Chips on={inp.round} pick={k => set("round", k)} items={ROUNDS.map(r => [r.key, r.label, m.keep ? inr(r.f(m.fee < 1 ? m.keep / (1 - m.fee) / (1 - m.sale) : 0)) : r.eg])} />
      <div style={{ marginTop: 30, display: "grid", gridTemplateColumns: phone ? "1fr" : "1fr 1fr", gap: 0, borderTop: `1px solid ${T.ink}` }}>
        <div style={{ padding: "18px 0", borderBottom: `1px solid ${T.line}` }}>
          <div style={eyebrowS}>Etsy price</div>
          <div style={{ fontFamily: T.serif, fontSize: 48, lineHeight: 1.05, marginTop: 6 }}>{inr(m.etsy)}</div>
        </div>
        <div style={{ padding: "18px 0", borderBottom: `1px solid ${T.line}` }}>
          <div style={eyebrowS}>{m.sale ? `During the ${Math.round(m.sale * 100)}% sale` : "Buyers pay"}</div>
          <div style={{ fontFamily: T.serif, fontSize: 48, lineHeight: 1.05, marginTop: 6 }}>{inr(m.sale ? m.salePrice : m.etsy)}</div>
        </div>
      </div>
    </div>,

    <div key="else">
      <Q eyebrow="Step 5 · Everywhere else" title="Prices on the other platforms" lede="Worked out from the same numbers. Tick the ones to set; you can type over any of them." />
      <div style={{ borderTop: `1px solid ${T.ink}` }}>
        {[
          { k: "ebay", name: "eBay", cur: "$", sub: `Same amount in hand after ${inp.ebayFees}% eBay fees, at ₹${liveRate.toFixed(1)} a dollar` },
          { k: "storeUsd", name: "Earth Editions · USA", cur: "$", sub: `Left unticked, the site charges this itself: Etsy price less ${m.disc}%, at ₹${m.fx} a dollar` },
          { k: "storeInr", name: "Earth Editions · India", cur: "₹", sub: `Left unticked, the site charges this itself: Etsy price less ${m.disc}%` },
        ].map(r => (
          <div key={r.k} style={{ display: "flex", gap: 14, alignItems: "center", padding: "16px 0", borderBottom: `1px solid ${T.line}` }}>
            <input type="checkbox" checked={!!take[r.k]} onChange={e => setTake(t => ({ ...t, [r.k]: e.target.checked }))} style={{ width: 20, height: 20, accentColor: T.ink, margin: 0, flex: "none" }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 500 }}>{r.name}</div>
              <div style={{ fontSize: 12, color: T.faint, marginTop: 2 }}>{r.sub}</div>
            </div>
            <span style={{ display: "flex", alignItems: "baseline", gap: 2, borderBottom: `1px solid ${take[r.k] ? T.ink : T.line}`, opacity: take[r.k] ? 1 : .55 }}>
              <span style={{ color: T.mid, fontFamily: T.serif, fontSize: 22 }}>{r.cur}</span>
              <input value={val(r.k) || ""} inputMode="decimal" onChange={e => { setCustom(c => ({ ...c, [r.k]: e.target.value.replace(/[^\d.]/g, "") })); setTake(t => ({ ...t, [r.k]: true })); }}
                style={{ width: phone ? 80 : 110, border: 0, outline: "none", background: "transparent", fontFamily: T.serif, fontSize: 26, textAlign: "right", padding: "2px 0" }} />
            </span>
          </div>
        ))}
      </div>
      <p style={{ color: T.faint, fontSize: 12.5, marginTop: 14 }}>Wholesale is priced per kilo or per piece on its own tab, so it isn't worked out here.</p>
    </div>,

    <div key="review">
      <Q eyebrow="Step 6 · Review" title="Your prices" />
      {EtsyPreview({})}
      <div style={{ marginTop: 22, borderTop: `1px solid ${T.ink}` }}>
        <Row k="Etsy price" v={inr(m.etsy)} strong />
        {m.sale > 0 && <Row k={`Buyers pay during the ${Math.round(m.sale * 100)}% sale`} v={inr(m.salePrice)} />}
        <Row k={`Etsy fees (${Math.round(m.fee * 100)}%)`} v={`− ${inr((m.sale ? m.salePrice : m.etsy) * m.fee)}`} tone={T.mid} />
        <Row k="Cost" v={`− ${inr(m.cost)}`} tone={T.mid} />
        <Row k={m.sale ? "Profit during the sale" : "Profit"} v={inr(m.profitSale)} tone={profitTone(m.profitSale)} strong sub={`${pct(m.profitSale, m.sale ? m.salePrice : m.etsy)} of what the buyer pays`} />
        {m.sale > 0 && <Row k="Profit at full price" v={inr(m.profitFull)} tone={profitTone(m.profitFull)} sub={`${pct(m.profitFull, m.etsy)} of the full price`} />}
      </div>
      <div style={{ marginTop: 22, borderTop: `1px solid ${T.line}` }}>
        {take.ebay && <Row k="eBay" v={usd(val("ebay"))} />}
        <Row k="Earth Editions · USA" v={usd(take.storeUsd ? val("storeUsd") : m.storeUsd)} sub={take.storeUsd ? "Set here" : "Follows the Etsy price"} />
        <Row k="Earth Editions · India" v={inr(take.storeInr ? val("storeInr") : m.storeInr)} sub={take.storeInr ? "Set here" : "Follows the Etsy price"} />
      </div>
      <p style={{ color: T.faint, fontSize: 12.5, marginTop: 14 }}>Apply puts these into the listing. Nothing goes to a platform until you press Save.</p>
    </div>,
  ];

  /* The running total, beside the steps on a wide screen. */
  const Receipt = (
    <aside style={{ background: T.sunk, padding: "28px 26px", alignSelf: "stretch" }}>
      <div style={eyebrowS}>So far</div>
      <div style={{ marginTop: 14 }}>
        <Row k="Cost" v={m.cost ? inr(m.cost) : "—"} />
        <Row k="In hand, after fees" v={m.keep ? inr(m.keep) : "—"} />
        <Row k="Etsy price" v={m.etsy ? inr(m.etsy) : "—"} strong />
        {m.sale > 0 && <Row k={`In the ${Math.round(m.sale * 100)}% sale`} v={m.etsy ? inr(m.salePrice) : "—"} />}
        <Row k="Profit in the sale" v={m.etsy ? inr(m.profitSale) : "—"} tone={m.etsy ? profitTone(m.profitSale) : T.faint} />
      </div>
    </aside>
  );

  return (
    <div onMouseDown={e => e.target === e.currentTarget && onClose()}
      style={{ position: "fixed", inset: 0, zIndex: 400, background: "rgba(20,18,16,.45)", display: "flex", alignItems: phone ? "stretch" : "center", justifyContent: "center", padding: phone ? 0 : 24, fontFamily: T.sans, color: T.ink }}>
      <style>{`@keyframes ps-in-r{from{opacity:0;transform:translateX(24px)}to{opacity:1;transform:none}}@keyframes ps-in-l{from{opacity:0;transform:translateX(-24px)}to{opacity:1;transform:none}}.ps-step{animation:ps-in-${dir > 0 ? "r" : "l"} .38s cubic-bezier(.2,.7,.2,1)}.ps input::placeholder{color:#c9c3b8}.ps input:focus{outline:none!important;box-shadow:none!important;border-color:inherit}.ps input[type=checkbox]:focus-visible{outline:2px solid #141210!important;outline-offset:2px}`}</style>
      <div className="ps" style={{ background: "#fff", width: "100%", maxWidth: 1000, display: "flex", flexDirection: "column", ...(phone ? { height: "100%" } : { maxHeight: "92vh", minHeight: 600 }), boxShadow: "0 30px 90px rgba(0,0,0,.25)" }}>
        {/* header: name, progress, close */}
        <div style={{ padding: phone ? "calc(12px + env(safe-area-inset-top)) 18px 0" : "18px 30px 0", flex: "none" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ fontFamily: T.serif, fontSize: 22, fontWeight: 500 }}>Price Studio</div>
            <div style={{ flex: 1, minWidth: 0, color: T.faint, fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{listing.title}</div>
            <button type="button" onClick={onClose} aria-label="Close" style={{ border: 0, background: "none", fontSize: 26, lineHeight: 1, cursor: "pointer", color: T.mid, padding: 4 }}>×</button>
          </div>
          <div style={{ display: "flex", gap: 4, marginTop: 14 }}>
            {STEPS.map((s, i) => (
              <button key={s} type="button" onClick={() => { if (i < step || can.slice(0, i).every(Boolean)) { setDir(i > step ? 1 : -1); setStep(i); } }} title={s}
                style={{ flex: 1, border: 0, padding: "6px 0 0", background: "none", cursor: "pointer", textAlign: "left" }}>
                <span style={{ display: "block", height: 2, background: i <= step ? T.ink : T.line, transition: "background .3s" }} />
                {!phone && <span style={{ display: "block", fontSize: 10.5, letterSpacing: ".16em", textTransform: "uppercase", color: i === step ? T.ink : T.faint, marginTop: 7 }}>{s}</span>}
              </button>
            ))}
          </div>
        </div>

        {/* body: the step, and the running total */}
        <div style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: phone ? "1fr" : "minmax(0,1fr) 320px", gap: phone ? 0 : 30, padding: phone ? "0" : "0 30px", overflow: "hidden" }}>
          <div style={{ overflowY: "auto", padding: phone ? "28px 18px 24px" : "40px 10px 30px 0" }}>
            <div key={step} className="ps-step">{body[step]}</div>
          </div>
          {!phone && <div style={{ padding: "30px 0" }}>{Receipt}</div>}
        </div>

        {/* footer */}
        <div style={{ flex: "none", borderTop: `1px solid ${T.line}`, padding: phone ? "12px 18px calc(12px + env(safe-area-inset-bottom))" : "16px 30px", display: "flex", alignItems: "center", gap: 14 }}>
          {phone && m.etsy > 0 && step < 5 && (
            <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: T.mid, lineHeight: 1.35 }}>
              Etsy <b style={{ color: T.ink }}>{inr(m.etsy)}</b>{m.sale ? <> · sale {inr(m.salePrice)}</> : null}<br />profit <b style={{ color: profitTone(m.profitSale) }}>{inr(m.profitSale)}</b>
            </div>
          )}
          {!(phone && m.etsy > 0 && step < 5) && <div style={{ flex: 1 }}>{step > 0 && <button type="button" onClick={() => go(-1)} style={linkS}>← Back</button>}</div>}
          {phone && m.etsy > 0 && step < 5 && step > 0 && <button type="button" onClick={() => go(-1)} style={{ ...btnS, background: "#fff", color: T.ink, padding: "0 16px" }}>←</button>}
          <button type="button" disabled={!can[step]} onClick={next} style={{ ...btnS, ...(can[step] ? {} : { background: T.sunk, borderColor: T.line, color: T.faint, cursor: "default" }) }}>
            {step === STEPS.length - 1 ? "Apply prices" : "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}

const eyebrowS = { fontSize: 11, letterSpacing: ".22em", textTransform: "uppercase", color: T.mid };
const btnS = { minHeight: 50, padding: "0 30px", background: T.ink, color: "#fff", border: `1px solid ${T.ink}`, fontSize: 13, letterSpacing: ".14em", textTransform: "uppercase", cursor: "pointer", fontFamily: T.sans, whiteSpace: "nowrap" };
const linkS = { border: 0, background: "none", fontSize: 12.5, letterSpacing: ".14em", textTransform: "uppercase", cursor: "pointer", color: T.mid, padding: "12px 0", fontFamily: T.sans };
