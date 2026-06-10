import { useState, useEffect, useRef, createContext, useContext } from "react";
import { supabase } from "./supabase.js";
import { loadK, loadKFresh, saveK } from "./utils.js";

// ─── Utils ────────────────────────────────────────────────────────────────────
const mob = window.innerWidth < 700;
const uid = () => Math.random().toString(36).substr(2, 9);
const today = () => new Date().toISOString().slice(0, 10);
const fmtDate = d => d ? new Date(d + "T12:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" }) : "—";
const inrFmt = n => "₹" + Math.abs(+n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtAmt = (n, cur) => {
  const sym = { INR: "₹", USD: "$", EUR: "€", JPY: "¥", GBP: "£", AUD: "A$" }[cur] || cur;
  const abs = Math.abs(+n || 0);
  const str = cur === "JPY" ? Math.round(abs).toLocaleString("en-IN") : abs.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (+n < 0 ? "-" : "") + sym + str;
};
// loadK / saveK imported from utils.js (shared cache — see top of file)

// ─── Privacy context ──────────────────────────────────────────────────────────
const MaskCtx = createContext(false);
const useMasked = () => useContext(MaskCtx);
// m(formattedValue) → returns "••••" when privacy mode is on
const makeMask = masked => v => masked ? "••••" : v;

// ─── Colors (CSS vars — same as main app) ────────────────────────────────────
const C = {
  bg: "var(--c-bg)", surface: "var(--c-surface)", card: "var(--c-card)",
  border: "var(--c-border)", borderHi: "var(--c-borderHi)",
  ink: "var(--c-ink)", inkMid: "var(--c-inkMid)", inkFaint: "var(--c-inkFaint)",
  gold: "var(--c-gold)", goldLight: "var(--c-goldLight)", goldBright: "var(--c-goldBright)",
  green: "var(--c-green)", greenBg: "var(--c-greenBg)", greenBright: "var(--c-greenBright)",
  red: "var(--c-red)", redBg: "var(--c-redBg)",
  amber: "var(--c-amber)", amberBg: "var(--c-amberBg)",
  blue: "var(--c-blue)", blueBg: "var(--c-blueBg)",
  purple: "var(--c-purple)", purpleBg: "var(--c-purpleBg)",
  teal: "var(--c-teal)", tealBg: "var(--c-tealBg)",
};

// ─── Constants ────────────────────────────────────────────────────────────────
function companyKeys(co) {
  return {
    accounts:     `${co}-fin-accounts-v1`,
    transactions: `${co}-fin-txns-v1`,
    rates:        "ng-fin-rates-v1",
    invoices:     co === "ng" ? "ng-invoices-v2"  : "at-invoices-v1",
    buyers:       co === "ng" ? "ng-buyers-v2"    : "at-buyers-v1",
    purchases:    co === "ng" ? "ng-purch-v5"     : "at-purch-v1",
    vendors:      co === "ng" ? "ng-vendors-v5"   : "at-vendors-v1",
    expenses:     co === "ng" ? "ng-expenses-v1"  : "at-expenses-v1",
  };
}

const CC_GRACE = 3; // days before due date to show warning
const DEFAULT_ACCOUNTS = [
  { id: "fa-inr-cash",  name: "INR Cash",             type: "cash", currency: "INR", openingBal: 0, active: true },
  { id: "fa-usd-cash",  name: "USD Cash",             type: "cash", currency: "USD", openingBal: 0, active: true },
  { id: "fa-eur-cash",  name: "EUR Cash",             type: "cash", currency: "EUR", openingBal: 0, active: true },
  { id: "fa-jpy-cash",  name: "JPY Cash",             type: "cash", currency: "JPY", openingBal: 0, active: true },
  { id: "fa-boi-0451",  name: "Bank of India 0451",   type: "bank", currency: "INR", openingBal: 0, active: true },
  { id: "fa-eefc",      name: "EEFC",                 type: "bank", currency: "USD", openingBal: 0, active: true },
  { id: "fa-vantage",   name: "Vantage West",         type: "bank", currency: "USD", openingBal: 0, active: true },
  { id: "fa-chase",     name: "Chase Earth Editions", type: "bank", currency: "USD", openingBal: 0, active: true },
];

const DEFAULT_ACCOUNTS_AT = [
  { id: "at-induslnd",  name: "IndusInd Bank", type: "bank", currency: "INR", openingBal: 0, active: true },
  { id: "at-boi",       name: "Bank of India", type: "bank", currency: "INR", openingBal: 0, active: true },
];

const DEFAULT_RATES = { USD: 85, EUR: 92, JPY: 0.57, GBP: 107, AUD: 55 };
const CUR_SYM = { INR: "₹", USD: "$", EUR: "€", JPY: "¥", GBP: "£", AUD: "A$" };

const TXN_CATS = {
  credit: ["FIRC / Inward Remittance", "Show Income – USD", "Show Income – EUR", "Show Income – JPY", "Show Income – INR", "Cash Received", "Advance Received", "Loan Received", "Other Income"],
  debit:  ["Bill Payment", "Expense Payment", "Show Expense", "Bank Charges", "Loan Repayment", "Personal Withdrawal", "Advance Paid", "Other Payment"],
  conversion: ["JPY Cash → INR Cash", "USD Cash → INR Cash", "EUR Cash → INR Cash", "EEFC → BOI (INR)", "USD Cash → EEFC", "Bank Transfer (Internal)", "Other Conversion"],
};

// ─── Core calculations ────────────────────────────────────────────────────────
function computeBalances(accounts, transactions) {
  const bals = {};
  const cardIds = new Set(accounts.filter(a => a.type === "credit_card").map(a => a.id));
  accounts.forEach(a => { bals[a.id] = +(a.openingBal || 0); });
  transactions.forEach(t => {
    if (t.type === "credit") {
      if (t.accountTo) {
        // Credit card payment received → reduces outstanding (liability goes down)
        if (cardIds.has(t.accountTo)) bals[t.accountTo] = (bals[t.accountTo] || 0) - (+t.amount || 0);
        else bals[t.accountTo] = (bals[t.accountTo] || 0) + (+t.amount || 0);
      }
    } else if (t.type === "debit") {
      if (t.accountFrom) {
        // Credit card spend → increases outstanding (liability goes up)
        if (cardIds.has(t.accountFrom)) bals[t.accountFrom] = (bals[t.accountFrom] || 0) + (+t.amount || 0);
        else bals[t.accountFrom] = (bals[t.accountFrom] || 0) - (+t.amount || 0);
      }
      if (t.classifiedAs === "cc_payment" && t.classifiedRef?.cardAccountId) {
        bals[t.classifiedRef.cardAccountId] = (bals[t.classifiedRef.cardAccountId] || 0) - (+t.amount || 0);
      }
    } else if (t.type === "conversion") {
      if (t.accountFrom) bals[t.accountFrom] = (bals[t.accountFrom] || 0) - (+t.amount || 0);
      if (t.accountTo)   bals[t.accountTo]   = (bals[t.accountTo]   || 0) + (+t.amount || 0) * (+t.convRate || 1);
    }
  });
  return bals;
}

function toINR(amount, currency, rates) {
  if (!currency || currency === "INR") return +amount || 0;
  return (+amount || 0) * (rates[currency] || 1);
}
function fromINR(amount, currency, rates) {
  if (!currency || currency === "INR") return +amount || 0;
  return (+amount || 0) / (rates[currency] || 1);
}
function convertMoney(amount, fromCurrency, toCurrency, rates) {
  const from = fromCurrency || "INR";
  const to = toCurrency || "INR";
  if (from === to) return +amount || 0;
  return fromINR(toINR(amount, from, rates), to, rates);
}
function moneyText(amount, currency) {
  const cur = currency || "INR";
  return `${cur} ${(+amount || 0).toLocaleString("en-IN", { minimumFractionDigits: cur === "JPY" ? 0 : 2, maximumFractionDigits: cur === "JPY" ? 0 : 2 })}`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────
function FToast({ msg }) {
  if (!msg) return null;
  return <div style={{ position: "fixed", bottom: 22, left: "50%", transform: "translateX(-50%)", zIndex: 9999, background: C.ink, color: "#fff", padding: "10px 20px", borderRadius: 6, fontSize: 12, boxShadow: "0 8px 28px rgba(0,0,0,.18)", display: "flex", alignItems: "center", gap: 8, whiteSpace: "nowrap" }}><span style={{ color: C.goldBright }}>✓</span>{msg}</div>;
}

function FTag({ c, children }) {
  return <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: .9, color: c || C.inkFaint, textTransform: "uppercase", marginBottom: 4 }}>{children}</div>;
}

// ─── Shell layout for Finance ─────────────────────────────────────────────────
function FShell({ title, view, setView, onHome, masked, toggleMask, company, setCompany, children }) {
  const dayOfMonth = new Date().getDate();
  const reconcileAlert = dayOfMonth >= 8 && dayOfMonth <= 15;

  const VIEWS = [
    { id: "dashboard", label: mob ? "📊" : "Dashboard", title: "Dashboard" },
    { id: "ledger",    label: mob ? "📋" : "Ledger",    title: "Ledger" },
    { id: "classify",  label: mob ? "🏷" : "Classify",  title: "Classify Expenses" },
    { id: "add",       label: mob ? "+" : "+ Entry",    title: "New Entry" },
    { id: "accounts",  label: mob ? "⚙" : "Accounts",  title: "Accounts & Rates" },
    { id: "reconcile", label: mob ? "🏦" : "Reconcile", title: "Reconcile", alert: reconcileAlert },
  ];

  return (
    <div style={{ fontFamily: "'Figtree',system-ui,sans-serif", background: C.bg, minHeight: "100vh", color: C.ink }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400&family=Figtree:wght@300;400;500;600&display=swap');
        *{box-sizing:border-box;}
        input,select,textarea{font-family:inherit;}
        input:focus,select:focus,textarea:focus{outline:none;border-color:var(--c-goldBright)!important;box-shadow:0 0 0 3px rgba(154,98,0,.1);}
        .fbp{background:var(--c-ink);color:#FAF0DC;border:none;padding:8px 18px;border-radius:6px;cursor:pointer;font-size:13px;font-weight:500;white-space:nowrap;font-family:inherit;transition:all .18s;}
        .fbp:hover{opacity:.88;}
        .fbp:disabled{opacity:.4;cursor:not-allowed;}
        .fbs{background:var(--c-surface);color:var(--c-ink);border:1.5px solid var(--c-border);padding:7px 14px;border-radius:6px;cursor:pointer;font-size:13px;font-weight:400;white-space:nowrap;font-family:inherit;transition:all .18s;}
        .fbs:hover{border-color:var(--c-inkMid);}
        @media(max-width:699px){.fbp,.fbs{font-size:15px!important;padding:9px 14px!important;}}
        .f-nav-tabs::-webkit-scrollbar{display:none;}
        .f-nav-tabs{-ms-overflow-style:none;scrollbar-width:none;}
      `}</style>

      {/* Header */}
      <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}`, padding: mob ? "0 12px" : "0 24px", display: "flex", alignItems: "center", height: 54, position: "sticky", top: 0, zIndex: 100, gap: 10, boxShadow: "0 1px 0 rgba(26,19,8,.04)" }}>
        <button onClick={onHome} style={{ background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 7, padding: "0 12px 0 0", borderRight: `1px solid ${C.border}`, flexShrink: 0 }}>
          <span style={{ fontSize: 20 }}>💰</span>
          {!mob && <div>
            <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 15, fontWeight: 600, color: C.ink, lineHeight: 1.1 }}>Finance</div>
            <div style={{ fontSize: 8, color: C.inkFaint, letterSpacing: 1.2, fontWeight: 500 }}>
              {company === "at" ? "ATYAHARA" : "NIKHIL GEMS"}
            </div>
          </div>}
        </button>

        {/* Company switcher */}
        <div style={{ display: "flex", gap: 3, flexShrink: 0, background: C.card, borderRadius: 7, padding: 3, border: `1px solid ${C.border}` }}>
          {[
            { id: "ng", label: mob ? "NG" : "Nikhil Gems" },
            { id: "at", label: mob ? "AT" : "Atyahara" },
          ].map(co => (
            <button key={co.id} onClick={() => setCompany(co.id)}
              style={{
                background: company === co.id ? (co.id === "at" ? "#5B2D8E" : C.ink) : "transparent",
                color: company === co.id ? "#fff" : C.inkMid,
                border: "none", borderRadius: 5, padding: mob ? "4px 8px" : "4px 12px",
                fontSize: mob ? 10 : 11, cursor: "pointer", fontWeight: company === co.id ? 700 : 400,
                transition: "all .15s", whiteSpace: "nowrap",
              }}>
              {co.label}
            </button>
          ))}
        </div>

        {/* Nav tabs */}
        <div className="f-nav-tabs" style={{ display: "flex", gap: 4, flex: 1, overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
          {VIEWS.map(v => (
            <button key={v.id} onClick={() => setView(v.id)}
              style={{ background: view === v.id ? C.ink : "none", color: view === v.id ? "#FAF0DC" : C.inkMid, border: `1.5px solid ${view === v.id ? C.ink : "transparent"}`, borderRadius: 6, padding: mob ? "5px 8px" : "5px 12px", fontSize: mob ? 11 : 12, cursor: "pointer", fontWeight: view === v.id ? 600 : 400, transition: "all .15s", whiteSpace: "nowrap", position: "relative", flexShrink: 0 }}>
              {v.label}
              {v.alert && <span style={{ position: "absolute", top: 2, right: 2, width: 6, height: 6, borderRadius: 3, background: C.amber }} />}
            </button>
          ))}
        </div>

        <span style={{ fontSize: 20, flexShrink: 0 }}>💰</span>
      </div>

      <div style={{ padding: mob ? "14px 12px" : "22px 28px", maxWidth: 1200, margin: "0 auto" }}>
        <MaskCtx.Provider value={masked}>
          {children}
        </MaskCtx.Provider>
      </div>
    </div>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
function Dashboard({ accounts, transactions, rates, invoices, purchases, balances, totalINR, onAddTxn }) {
  const masked = useMasked();
  const m = makeMask(masked);
  const today_str = today();
  const thisMonth = today_str.slice(0, 7);

  // Monthly P&L from ledger
  const monthIn  = transactions.filter(t => t.type === "credit"     && (t.date || "").startsWith(thisMonth)).reduce((s, t) => s + toINR(+t.amount, t.currency || accounts.find(a => a.id === t.accountTo)?.currency, rates), 0);
  const monthOut = transactions.filter(t => t.type === "debit"      && (t.date || "").startsWith(thisMonth)).reduce((s, t) => s + toINR(+t.amount, t.currency || accounts.find(a => a.id === t.accountFrom)?.currency, rates), 0);

  // Receivables: invoices not yet paid
  const unpaidInvs = invoices.filter(i => !["paid", "draft"].includes(i.status || ""));
  const proformas  = invoices.filter(i => i.type === "proforma" && i.status !== "paid");
  const receivablesByCur = unpaidInvs.reduce((acc, inv) => {
    const cur = inv.currency || "USD";
    const paid = (inv.payments || []).reduce((s, p) => s + (+p.amount || 0), 0) + (+inv.paidAmount || 0);
    acc[cur] = (acc[cur] || 0) + Math.max(0, (+inv.totalAmt || 0) - paid);
    return acc;
  }, {});
  const totalRecINR = Object.entries(receivablesByCur).reduce((s, [cur, amt]) => s + toINR(amt, cur, rates), 0);

  // Payables: unpaid bills
  const unpaidBills = purchases.filter(p => p.type === "bill" && ["pending", "confirmed", "partial"].includes(p.status || ""));
  const totalPayINR = unpaidBills.reduce((s, p) => s + toINR(Math.max(0, (+p.totalAmount || 0) - (+p.paidAmount || 0)), p.currency || "INR", rates), 0);

  // Open POs (committed capital)
  const openPOs = purchases.filter(p => p.type === "po" && ["open", "confirmed"].includes(p.status || ""));
  const totalPOINR = openPOs.reduce((s, p) => s + toINR(+p.totalAmount || 0, p.currency || "INR", rates), 0);

  const recentTxns = [...transactions].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10);
  const cashAccs = accounts.filter(a => a.type === "cash" && a.active);
  const bankAccs = accounts.filter(a => a.type === "bank" && a.active);
  const cardAccs = accounts.filter(a => a.type === "credit_card" && a.active);

  const StatCard = ({ label, value, sub, color, bg }) => (
    <div style={{ background: bg || C.surface, border: `1.5px solid ${C.border}`, borderRadius: 10, padding: mob ? "14px 15px" : "16px 18px" }}>
      <div style={{ fontSize: 9, fontWeight: 700, color: color || C.inkFaint, textTransform: "uppercase", letterSpacing: .8, marginBottom: 6 }}>{label}</div>
      <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: mob ? 19 : 22, fontWeight: 600, color: color || C.ink, lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: C.inkFaint, marginTop: 3 }}>{sub}</div>}
    </div>
  );

  return (
    <div>
      {/* Capital Banner */}
      <div style={{ background: `linear-gradient(135deg,${C.ink} 0%,#3A2810 100%)`, borderRadius: 12, padding: mob ? "18px 20px" : "24px 30px", marginBottom: 18, color: "#FAF0DC", boxShadow: "0 8px 32px rgba(26,19,8,.18)" }}>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", opacity: .55, marginBottom: 6 }}>Total Capital Position</div>
        <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: mob ? 34 : 46, fontWeight: 600, lineHeight: 1, marginBottom: 6 }}>{m(inrFmt(totalINR))}</div>
        <div style={{ fontSize: 10, opacity: .45, marginBottom: 18 }}>All accounts at current exchange rates</div>
        <div style={{ display: "flex", gap: mob ? 18 : 32, flexWrap: "wrap" }}>
          {[
            ["This Month In",  `+${inrFmt(monthIn)}`,  "#90EE90"],
            ["This Month Out", `-${inrFmt(monthOut)}`,  "#FF9999"],
            ["Net This Month", (monthIn - monthOut >= 0 ? "+" : "") + inrFmt(monthIn - monthOut), monthIn - monthOut >= 0 ? "#90EE90" : "#FF9999"],
          ].map(([l, v, col]) => (
            <div key={l}>
              <div style={{ fontSize: 9, opacity: .45, letterSpacing: .8, textTransform: "uppercase", marginBottom: 3 }}>{l}</div>
              <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: mob ? 16 : 18, fontWeight: 600, color: col }}>{m(v)}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Cash accounts */}
      <div style={{ fontSize: 10, fontWeight: 700, color: C.amber, textTransform: "uppercase", letterSpacing: .8, marginBottom: 8 }}>💵 Cash on Hand</div>
      <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr 1fr" : `repeat(${Math.min(cashAccs.length, 4)},1fr)`, gap: 10, marginBottom: 14 }}>
        {cashAccs.map(acc => {
          const bal = balances[acc.id] || 0;
          const sym = CUR_SYM[acc.currency] || acc.currency;
          const equiv = toINR(bal, acc.currency, rates);
          return (
            <div key={acc.id} style={{ background: C.amberBg, border: `1.5px solid ${C.borderHi}`, borderRadius: 9, padding: mob ? "12px 14px" : "16px 20px" }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: C.amber, textTransform: "uppercase", letterSpacing: .7, marginBottom: 5 }}>{acc.currency}</div>
              <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: mob ? 20 : 26, fontWeight: 600, color: bal < 0 ? C.red : C.ink, lineHeight: 1 }}>
                {m(sym + Math.abs(bal).toLocaleString("en-IN", { minimumFractionDigits: acc.currency === "JPY" ? 0 : 2, maximumFractionDigits: acc.currency === "JPY" ? 0 : 2 }))}
              </div>
              {acc.currency !== "INR" && <div style={{ fontSize: 10, color: C.inkFaint, marginTop: 3 }}>{masked ? "" : `≈ ${inrFmt(equiv)}`}</div>}
            </div>
          );
        })}
      </div>

      {/* Bank accounts */}
      <div style={{ fontSize: 10, fontWeight: 700, color: C.blue, textTransform: "uppercase", letterSpacing: .8, marginBottom: 8 }}>🏦 Bank Accounts</div>
      <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr" : `repeat(${Math.min(bankAccs.length, 4)},1fr)`, gap: 10, marginBottom: 18 }}>
        {bankAccs.map(acc => {
          const bal = balances[acc.id] || 0;
          const sym = CUR_SYM[acc.currency] || acc.currency;
          const equiv = toINR(bal, acc.currency, rates);
          return (
            <div key={acc.id} style={{ background: C.blueBg, border: `1.5px solid ${C.border}`, borderRadius: 9, padding: mob ? "12px 14px" : "16px 20px" }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: C.blue, textTransform: "uppercase", letterSpacing: .7, marginBottom: 5 }}>{acc.name}</div>
              <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: mob ? 20 : 26, fontWeight: 600, color: bal < 0 ? C.red : C.ink, lineHeight: 1 }}>
                {m(sym + Math.abs(bal).toLocaleString("en-IN", { minimumFractionDigits: acc.currency === "JPY" ? 0 : 2, maximumFractionDigits: acc.currency === "JPY" ? 0 : 2 }))}
              </div>
              {acc.currency !== "INR" && <div style={{ fontSize: 10, color: C.inkFaint, marginTop: 3 }}>{masked ? "" : `≈ ${inrFmt(equiv)}`}</div>}
            </div>
          );
        })}
      </div>

      {/* Receivables / Payables / POs */}
      <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr" : "1fr 1fr 1fr", gap: 12, marginBottom: 18 }}>
        {/* Receivables */}
        <div style={{ background: C.greenBg, border: `1.5px solid ${C.green}40`, borderRadius: 10, padding: "16px 18px" }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: C.green, textTransform: "uppercase", letterSpacing: .7, marginBottom: 6 }}>📥 Receivables</div>
          <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 24, fontWeight: 600, color: C.green, marginBottom: 4 }}>{m(inrFmt(totalRecINR))}</div>
          <div style={{ fontSize: 11, color: C.inkMid, marginBottom: 8 }}>{unpaidInvs.length} unpaid invoice{unpaidInvs.length !== 1 ? "s" : ""}</div>
          {Object.entries(receivablesByCur).map(([cur, amt]) => (
            <div key={cur} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.inkFaint, marginBottom: 2 }}>
              <span>{cur}</span>
              <span style={{ fontWeight: 600 }}>{m(fmtAmt(amt, cur))}</span>
            </div>
          ))}
          {proformas.length > 0 && (
            <div style={{ marginTop: 10, background: C.surface, borderRadius: 5, padding: "6px 9px", fontSize: 10, color: C.inkMid }}>
              + {proformas.length} pro forma{proformas.length !== 1 ? "s" : ""} (potential)
            </div>
          )}
        </div>

        {/* Payables */}
        <div style={{ background: C.redBg, border: `1.5px solid ${C.red}40`, borderRadius: 10, padding: "16px 18px" }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: C.red, textTransform: "uppercase", letterSpacing: .7, marginBottom: 6 }}>📤 Payables</div>
          <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 24, fontWeight: 600, color: C.red, marginBottom: 4 }}>{m(inrFmt(totalPayINR))}</div>
          <div style={{ fontSize: 11, color: C.inkMid, marginBottom: 8 }}>{unpaidBills.length} unpaid bill{unpaidBills.length !== 1 ? "s" : ""}</div>
          {unpaidBills.slice(0, 4).map(b => (
            <div key={b.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.inkFaint, marginBottom: 2, overflow: "hidden" }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "55%" }}>{b.supplier || b.billNumber || "—"}</span>
              <span style={{ fontWeight: 600, color: C.red, flexShrink: 0 }}>{m(inrFmt(toINR(Math.max(0, (+b.totalAmount || 0) - (+b.paidAmount || 0)), b.currency || "INR", rates)))}</span>
            </div>
          ))}
        </div>

        {/* Open Purchase Orders */}
        <div style={{ background: C.purpleBg, border: `1.5px solid ${C.purple}40`, borderRadius: 10, padding: "16px 18px" }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: C.purple, textTransform: "uppercase", letterSpacing: .7, marginBottom: 6 }}>📦 Open Orders (POs)</div>
          <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 24, fontWeight: 600, color: C.purple, marginBottom: 4 }}>{m(inrFmt(totalPOINR))}</div>
          <div style={{ fontSize: 11, color: C.inkMid, marginBottom: 8 }}>{openPOs.length} PO{openPOs.length !== 1 ? "s" : ""} · committed capital</div>
          {openPOs.slice(0, 4).map(po => (
            <div key={po.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.inkFaint, marginBottom: 2, overflow: "hidden" }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "55%" }}>{po.supplier || po.poNumber || "—"}</span>
              <span style={{ fontWeight: 600, color: C.purple, flexShrink: 0 }}>{m(inrFmt(toINR(+po.totalAmount || 0, po.currency || "INR", rates)))}</span>
            </div>
          ))}
          {openPOs.length === 0 && <div style={{ fontSize: 11, color: C.inkFaint }}>No open purchase orders</div>}
        </div>
      </div>

      {/* Credit Cards */}
      {cardAccs.length > 0 && (
        <>
          <div style={{ fontSize: 10, fontWeight: 700, color: C.red, textTransform: "uppercase", letterSpacing: .8, marginBottom: 8 }}>💳 Credit Cards</div>
          <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr" : `repeat(${Math.min(cardAccs.length, 3)}, 1fr)`, gap: 10, marginBottom: 14 }}>
            {cardAccs.map(a => {
              const bal = balances[a.id] || 0;
              const limit = a.creditLimit || 0;
              const used = Math.max(0, bal);
              const available = limit ? Math.max(0, limit - used) : null;
              const utilPct = limit ? Math.min(100, Math.round(used / limit * 100)) : null;
              const today_d = new Date();
              const dueDay = a.billingDueDay || 0;
              let daysUntilDue = null;
              if (dueDay) {
                const thisMonth = new Date(today_d.getFullYear(), today_d.getMonth(), dueDay);
                const nextMonth = new Date(today_d.getFullYear(), today_d.getMonth() + 1, dueDay);
                const target = thisMonth >= today_d ? thisMonth : nextMonth;
                daysUntilDue = Math.ceil((target - today_d) / (1000 * 60 * 60 * 24));
              }
              const dueSoon = daysUntilDue !== null && daysUntilDue <= CC_GRACE;
              return (
                <div key={a.id} style={{ background: C.surface, border: `1.5px solid ${dueSoon ? C.red : C.border}`, borderRadius: 10, padding: mob ? "14px 15px" : "16px 18px" }}>
                  <div style={{ fontSize: 9, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .8, marginBottom: 4 }}>{a.name}</div>
                  <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: mob ? 19 : 22, fontWeight: 600, color: C.red, lineHeight: 1.1, marginBottom: 6 }}>{m(fmtAmt(used, a.currency || "INR"))}</div>
                  {limit > 0 && (
                    <>
                      <div style={{ height: 4, background: C.card, borderRadius: 2, overflow: "hidden", marginBottom: 4 }}>
                        <div style={{ height: "100%", width: `${utilPct}%`, background: utilPct > 80 ? C.red : utilPct > 50 ? C.amber : C.green, borderRadius: 2, transition: "width .4s" }} />
                      </div>
                      <div style={{ fontSize: 10, color: C.inkFaint, marginBottom: 4 }}>
                        {m(fmtAmt(available, a.currency || "INR"))} available · {utilPct}% used
                      </div>
                    </>
                  )}
                  {daysUntilDue !== null && (
                    <div style={{ fontSize: 10, fontWeight: 600, color: dueSoon ? C.red : C.inkFaint, marginTop: 2 }}>
                      {dueSoon ? "⚠ " : ""}Due in {daysUntilDue}d
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Recent Transactions */}
      <div style={{ background: C.surface, border: `1.5px solid ${C.border}`, borderRadius: 10, padding: "16px 20px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .7 }}>Recent Transactions</div>
          <button onClick={onAddTxn} className="fbp" style={{ fontSize: 11, padding: "5px 12px" }}>+ New Entry</button>
        </div>
        {recentTxns.length === 0
          ? <div style={{ fontSize: 13, color: C.inkFaint, textAlign: "center", padding: "24px 0" }}>No transactions yet — add your first entry to start tracking.</div>
          : recentTxns.map(t => {
            const cur = t.currency || accounts.find(a => a.id === (t.accountTo || t.accountFrom))?.currency || "INR";
            const accName = accounts.find(a => a.id === (t.type === "conversion" ? t.accountFrom : t.accountTo || t.accountFrom))?.name || "—";
            const sym = CUR_SYM[cur] || cur;
            const isConv = t.type === "conversion";
            return (
              <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 0", borderBottom: `1px solid ${C.border}` }}>
                <div style={{ width: 8, height: 8, borderRadius: 4, background: isConv ? C.blue : t.type === "credit" ? C.green : C.red, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: mob ? 13 : 12, fontWeight: 500, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.payee || t.category || accName}</div>
                  <div style={{ fontSize: 10, color: C.inkFaint }}>{fmtDate(t.date)} · {accName}{t.category ? ` · ${t.category}` : ""}{t.createdAt&&t.createdAt.slice(0,10)!==t.date?<span style={{color:C.amber,marginLeft:4}}>backdated</span>:null}</div>
                </div>
                <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: mob ? 14 : 13, fontWeight: 600, color: isConv ? C.blue : t.type === "credit" ? C.green : C.red, flexShrink: 0 }}>
                  {masked ? "••••" : `${isConv ? "⇄ " : t.type === "credit" ? "+" : "−"}${sym}${Math.abs(+t.amount || 0).toLocaleString("en-IN", { minimumFractionDigits: cur === "JPY" ? 0 : 2, maximumFractionDigits: cur === "JPY" ? 0 : 2 })}`}
                </div>
              </div>
            );
          })
        }
      </div>
    </div>
  );
}

// ─── Smart Payee Picker ───────────────────────────────────────────────────────
function PayeePicker({ value, onChange, type, vendors = [], purchases = [], invoices = [], style }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState(value || "");
  const todayStr = today();

  // Build smart suggestion list
  const suggestions = (() => {
    if (type === "debit") {
      // Group pending bills by vendor
      const vendorMap = {};
      purchases
        .filter(p => p.type === "bill" && ["pending", "confirmed", "partial", "expanded"].includes(p.status || ""))
        .forEach(bill => {
          const name = bill.supplier || "Unknown";
          if (!vendorMap[name]) vendorMap[name] = { name, total: 0, overdue: 0, bills: [] };
          const paid = bill.paidAmount || 0;
          const owed = Math.max(0, (+bill.totalAmount || 0) - paid);
          const isOverdue = bill.billDate && (Math.round((new Date(todayStr) - new Date(bill.billDate)) / 86400000) > 60);
          vendorMap[name].total += owed;
          if (isOverdue) vendorMap[name].overdue += owed;
          vendorMap[name].bills.push(bill);
        });
      // Also add vendors with no open bills (just names)
      vendors.forEach(v => {
        if (!vendorMap[v.name]) vendorMap[v.name] = { name: v.name, total: 0, overdue: 0, bills: [] };
      });
      return Object.values(vendorMap).sort((a, b) => b.total - a.total);
    } else if (type === "credit") {
      // Group unpaid invoices by buyer
      const buyerMap = {};
      invoices
        .filter(i => ["sent", "partial", "shipped"].includes(i.status || ""))
        .forEach(inv => {
          const name = inv.buyerName || inv.buyerId || "Unknown Buyer";
          if (!buyerMap[name]) buyerMap[name] = { name, total: 0, overdue: 0 };
          const paid = (inv.payments || []).reduce((s, p) => s + (+p.amount || 0), 0) + (+inv.paidAmount || 0);
          const owed = Math.max(0, (+inv.totalAmt || 0) - paid);
          const isOverdue = inv.dueDate && inv.dueDate < todayStr;
          buyerMap[name].total += owed;
          if (isOverdue) buyerMap[name].overdue += owed;
        });
      return Object.values(buyerMap).sort((a, b) => b.total - a.total);
    }
    // Conversion — just return nothing fancy
    return [];
  })();

  const filtered = q.trim()
    ? suggestions.filter(s => s.name.toLowerCase().includes(q.toLowerCase()))
    : suggestions;

  const pick = name => { setQ(name); onChange(name); setOpen(false); };

  return (
    <div style={{ position: "relative" }}>
      <input
        value={q}
        onChange={e => { setQ(e.target.value); onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 180)}
        onKeyDown={e => {
          if (e.key === "Escape") setOpen(false);
          if (e.key === "Enter" && filtered.length > 0) { pick(filtered[0].name); e.preventDefault(); }
        }}
        placeholder={type === "credit" ? "Buyer, bank, show..." : "Vendor, merchant..."}
        style={style}
      />
      {open && filtered.length > 0 && (
        <div style={{
          position: "absolute", top: "100%", left: 0, right: 0, zIndex: 999,
          background: C.surface, border: `1.5px solid ${C.border}`, borderRadius: 8,
          boxShadow: "0 4px 20px rgba(26,19,8,.13)", marginTop: 3,
          maxHeight: 280, overflowY: "auto"
        }}>
          {filtered.map((s, i) => (
            <div key={i} onMouseDown={() => pick(s.name)}
              style={{
                padding: "9px 13px", cursor: "pointer", borderBottom: i < filtered.length - 1 ? `1px solid ${C.border}` : "none",
                display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
                background: "transparent",
              }}
              onMouseEnter={e => e.currentTarget.style.background = C.card}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</div>
                {s.total > 0 && (
                  <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 2 }}>
                    {s.bills?.length > 0 ? `${s.bills.length} open bill${s.bills.length > 1 ? "s" : ""}` : ""}
                    {s.bills?.length > 0 && " · "}
                    <span style={{ color: C.amber, fontWeight: 600 }}>₹{s.total.toLocaleString("en-IN", { maximumFractionDigits: 0 })} pending</span>
                    {s.overdue > 0 && <span style={{ color: C.red, fontWeight: 700 }}> · ₹{s.overdue.toLocaleString("en-IN", { maximumFractionDigits: 0 })} overdue</span>}
                  </div>
                )}
                {s.total === 0 && s.bills?.length === 0 && <div style={{ fontSize: 10, color: C.inkFaint, marginTop: 1 }}>No open bills</div>}
              </div>
              {s.total > 0 && (
                <div style={{ fontSize: 12, fontWeight: 700, color: s.overdue > 0 ? C.red : C.amber, flexShrink: 0, textAlign: "right" }}>
                  {type === "debit" ? "BILL" : "INV"}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Add Transaction Form ─────────────────────────────────────────────────────
function AddTxnForm({ accounts, invoices, purchases, vendors = [], onSave, onCancel }) {
  const [type, setType] = useState("credit");
  const [date, setDate] = useState(today());
  const [accountFrom, setAccountFrom] = useState("");
  const [accountTo, setAccountTo] = useState("");
  const [amount, setAmount] = useState("");
  const [convRate, setConvRate] = useState("");
  const [payee, setPayee] = useState("");
  const [category, setCategory] = useState("");
  const [notes, setNotes] = useState("");
  const [refType, setRefType] = useState("");
  const [refId, setRefId] = useState("");
  const [err, setErr] = useState("");
  const [classifyNow, setClassifyNow] = useState(true);

  const accFrom = accounts.find(a => a.id === accountFrom);
  const accTo   = accounts.find(a => a.id === accountTo);
  const convToAmt = type === "conversion" && amount && convRate ? (+amount * +convRate) : null;
  const activeAccs = accounts.filter(a => a.active);
  const FI = { background: C.surface, border: `1.5px solid ${C.border}`, color: C.ink, borderRadius: 6, padding: mob ? "10px 12px" : "8px 11px", fontSize: mob ? 16 : 13, width: "100%", fontFamily: "inherit" };

  const submit = () => {
    setErr("");
    if (!date)   return setErr("Date is required");
    if (!amount || +amount <= 0) return setErr("Enter a valid amount");
    if (type === "credit"     && !accountTo)   return setErr("Select destination account");
    if (type === "debit"      && !accountFrom) return setErr("Select source account");
    if (type === "conversion" && (!accountFrom || !accountTo)) return setErr("Select both accounts");
    if (type === "conversion" && (!convRate || +convRate <= 0)) return setErr("Enter conversion rate");
    const txn = {
      id: uid(), date, type,
      accountFrom: type !== "credit"     ? accountFrom : undefined,
      accountTo:   type !== "debit"      ? accountTo   : undefined,
      amount: +amount,
      convRate: type === "conversion"    ? +convRate   : undefined,
      currency: type === "credit" ? accTo?.currency : accFrom?.currency,
      payee, category, notes,
      refType: refType || undefined,
      refId:   refId   || undefined,
      createdAt: new Date().toISOString(),
    };
    onSave(txn, classifyNow);
  };

  // Auto-fill from invoice link
  useEffect(() => {
    if (refType === "invoice" && refId) {
      const inv = invoices.find(i => i.id === refId);
      if (inv) {
        setPayee(inv.buyerName || inv.buyerId || "");
        setCategory("FIRC / Inward Remittance");
        setAmount(String((+inv.totalAmt || 0) - (inv.payments || []).reduce((s, p) => s + (+p.amount || 0), 0)));
      }
    }
  }, [refType, refId]);

  return (
    <div style={{ maxWidth: mob ? "100%" : 600, width: mob ? "100%" : "auto" }}>
      <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 22, fontWeight: 600, marginBottom: 20 }}>New Transaction</div>

      {/* Type Selector */}
      <div style={{ display: "flex", gap: 8, marginBottom: 22 }}>
        {[
          { id: "credit",     label: "💚 Credit (Money In)" },
          { id: "debit",      label: "🔴 Debit (Money Out)" },
          { id: "conversion", label: "🔄 Conversion / Transfer" },
        ].map(t => (
          <button key={t.id} onClick={() => { setType(t.id); setAccountFrom(""); setAccountTo(""); setCategory(""); }}
            style={{ flex: 1, padding: mob ? "11px 6px" : "10px 8px", background: type === t.id ? C.ink : C.surface, color: type === t.id ? "#FAF0DC" : C.inkMid, border: `1.5px solid ${type === t.id ? C.ink : C.border}`, borderRadius: 8, cursor: "pointer", fontSize: mob ? 13 : 11, fontWeight: 600, transition: "all .15s" }}>
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr" : "1fr 1fr", gap: 14, marginBottom: 14 }}>
        <div>
          <FTag>Date</FTag>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} style={FI} />
        </div>

        <div>
          <FTag>Amount {accFrom || accTo ? `(${CUR_SYM[(type==="credit"?accTo:accFrom)?.currency]||""}${(type==="credit"?accTo:accFrom)?.currency||""})` : ""}</FTag>
          <input type="number" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" style={FI} step="0.01" min="0" />
        </div>

        {type !== "credit" && (
          <div>
            <FTag>From Account</FTag>
            <select value={accountFrom} onChange={e => setAccountFrom(e.target.value)} style={FI}>
              <option value="">— Select account —</option>
              {activeAccs.map(a => <option key={a.id} value={a.id}>{a.name} ({a.currency})</option>)}
            </select>
          </div>
        )}

        {type !== "debit" && (
          <div>
            <FTag>{type === "conversion" ? "To Account" : "Into Account"}</FTag>
            <select value={accountTo} onChange={e => setAccountTo(e.target.value)} style={FI}>
              <option value="">— Select account —</option>
              {activeAccs.filter(a => a.id !== accountFrom).map(a => <option key={a.id} value={a.id}>{a.name} ({a.currency})</option>)}
            </select>
          </div>
        )}

        {type === "conversion" && (
          <>
            <div>
              <FTag>Rate: 1 {accFrom?.currency || "?"} = ? {accTo?.currency || "?"}</FTag>
              <input type="number" value={convRate} onChange={e => setConvRate(e.target.value)} placeholder="e.g. 85" style={FI} step="0.0001" min="0" />
            </div>
            <div>
              <FTag>You Receive ({accTo?.currency || "?"})</FTag>
              <div style={{ ...FI, background: C.card, color: C.ink, fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 18, fontWeight: 600 }}>
                {convToAmt != null ? `${CUR_SYM[accTo?.currency] || ""}${convToAmt.toLocaleString("en-IN", { minimumFractionDigits: accTo?.currency === "JPY" ? 0 : 2, maximumFractionDigits: accTo?.currency === "JPY" ? 0 : 2 })}` : "—"}
              </div>
            </div>
          </>
        )}

        <div>
          <FTag>{type === "credit" ? "From / Source" : type === "conversion" ? "Label / Note" : "To / Payee"}</FTag>
          <PayeePicker value={payee} onChange={setPayee} type={type} vendors={vendors} purchases={purchases} invoices={invoices} style={FI} />
        </div>

        <div>
          <FTag>Category</FTag>
          <select value={category} onChange={e => setCategory(e.target.value)} style={FI}>
            <option value="">— Select —</option>
            {(TXN_CATS[type] || []).map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>

      {/* Link to Invoice / Bill */}
      <div style={{ marginBottom: 14 }}>
        <FTag>Link to Invoice or Bill (optional)</FTag>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <select value={refType} onChange={e => { setRefType(e.target.value); setRefId(""); }} style={{ ...FI, width: "auto", flex: "0 0 auto" }}>
            <option value="">No link</option>
            <option value="invoice">Invoice</option>
            <option value="bill">Bill</option>
          </select>
          {refType === "invoice" && (
            <select value={refId} onChange={e => setRefId(e.target.value)} style={{ ...FI, flex: 1 }}>
              <option value="">— Select invoice —</option>
              {invoices.filter(i => ["sent", "partial", "paid", "shipped"].includes(i.status || "")).map(i => (
                <option key={i.id} value={i.id}>{i.invNo} · {i.currency} {(+i.totalAmt || 0).toFixed(2)}</option>
              ))}
            </select>
          )}
          {refType === "bill" && (
            <select value={refId} onChange={e => setRefId(e.target.value)} style={{ ...FI, flex: 1 }}>
              <option value="">— Select bill —</option>
              {purchases.filter(p => p.type === "bill").map(p => (
                <option key={p.id} value={p.id}>{p.billNumber || "Bill"} · {p.supplier} · {inrFmt(+p.totalAmount || 0)}</option>
              ))}
            </select>
          )}
        </div>
      </div>

      <div style={{ marginBottom: 20 }}>
        <FTag>Notes</FTag>
        <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="FIRC number, reference, any details..." style={{ ...FI, height: 64, resize: "vertical" }} />
      </div>

      {err && <div style={{ background: C.redBg, color: C.red, borderRadius: 7, padding: "8px 12px", fontSize: 13, marginBottom: 14 }}>{err}</div>}

      {/* Classify now toggle */}
      {type !== "conversion" && (
        <label style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18, cursor: "pointer", userSelect: "none" }}>
          <div onClick={() => setClassifyNow(v => !v)} style={{ width: 38, height: 22, borderRadius: 11, background: classifyNow ? C.green : C.card, border: `1.5px solid ${classifyNow ? C.green : C.border}`, position: "relative", transition: "background .2s, border-color .2s", flexShrink: 0 }}>
            <div style={{ position: "absolute", top: 2, left: classifyNow ? 17 : 2, width: 15, height: 15, borderRadius: "50%", background: classifyNow ? "#fff" : C.inkFaint, transition: "left .2s" }} />
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>Classify now</div>
            <div style={{ fontSize: 11, color: C.inkFaint }}>{classifyNow ? "You'll classify this right after saving" : "Skip — classify later from the ledger"}</div>
          </div>
        </label>
      )}

      <div style={{ display: "flex", gap: 10 }}>
        <button onClick={submit} className="fbp">{classifyNow && type !== "conversion" ? "Save & Classify →" : "Save Transaction"}</button>
        <button onClick={onCancel} className="fbs">Cancel</button>
      </div>
    </div>
  );
}

// ─── Ledger View ──────────────────────────────────────────────────────────────
// ─── Classify Modal ───────────────────────────────────────────────────────────
const EXP_CATS = ["Sea Freight", "Air Freight", "Courier / Local Delivery", "Rent", "Electricity", "Staff / Labour", "Show — Booth Fee", "Show — Travel", "Show — Hotel", "Packaging", "Bank Charges", "GST / Tax Payment", "Repairs & Maintenance", "Other"];

const CLASSIFY_META = {
  expense:          { label: "Expense",       color: "var(--c-amber)"  },
  vendor_bill:      { label: "Bill Paid",     color: "var(--c-blue)"   },
  vendor_po:        { label: "Adv. PO",       color: "var(--c-purple)" },
  customer_receipt: { label: "Cust. Receipt", color: "var(--c-green)"  },
  cc_payment:       { label: "CC Payment",    color: "var(--c-teal)"   },
};

function guessExpCat(txn) {
  const s = ((txn.category || "") + " " + (txn.payee || "")).toLowerCase();
  if (s.includes("freight") || s.includes("ship global") || s.includes("cargo")) return "Sea Freight";
  if (s.includes("air freight") || s.includes("fedex") || s.includes("dhl")) return "Air Freight";
  if (s.includes("courier") || s.includes("local delivery")) return "Courier / Local Delivery";
  if (s.includes("rent") || s.includes("lease")) return "Rent";
  if (s.includes("electric")) return "Electricity";
  if (s.includes("salary") || s.includes("staff") || s.includes("labour") || s.includes("wage")) return "Staff / Labour";
  if (s.includes("packaging") || s.includes("packing")) return "Packaging";
  if (s.includes("bank charge") || s.includes("swift")) return "Bank Charges";
  if (s.includes("gst") || s.includes("tax")) return "GST / Tax Payment";
  if (s.includes("repair") || s.includes("maintenance")) return "Repairs & Maintenance";
  return "Other";
}

function guessVendorId(txn, vendors) {
  const payee = (txn.payee || "").toLowerCase();
  if (!payee) return "";
  const match = vendors.find(v => {
    const name = v.name.toLowerCase();
    return name.includes(payee) || payee.includes(name) || payee.split(" ").some(w => w.length > 3 && name.includes(w));
  });
  return match?.id || "";
}

function ClassifyModal({ txn, accounts = [], vendors, purchases, invoices, buyers = [], rates = DEFAULT_RATES, onSave, onClose }) {
  const isDebit = txn.type !== "credit";
  const [classType, setClassType] = useState(() => {
    if (txn.classifiedAs) return txn.classifiedAs;
    if (!isDebit) return "customer_receipt";
    const cat = (txn.category || "").toLowerCase();
    if (cat.includes("bill") || cat.includes("vendor payment") || cat.includes("vendor pay")) return "vendor_bill";
    if (cat.includes("advance paid") || cat.includes("advance against")) return "vendor_po";
    return "expense";
  });

  const [expCat,       setExpCat]       = useState(() => txn.classifiedRef?.cat   || guessExpCat(txn));
  const [expParty,     setExpParty]     = useState(() => txn.classifiedRef?.party || txn.payee || "");
  const [expNotes,     setExpNotes]     = useState(txn.notes || "");
  const [vendorId,     setVendorId]     = useState(() => txn.classifiedRef?.vendorId || guessVendorId(txn, vendors));
  const [selectedBillIds, setSelectedBillIds] = useState(() => {
    const existing = txn.classifiedRef?.billIds || (txn.classifiedRef?.billId ? [txn.classifiedRef.billId] : []);
    return new Set(existing);
  });
  const [selectedPoId,   setSelectedPoId]   = useState(txn.classifiedRef?.poId   || "");
  const [selectedInvIds, setSelectedInvIds] = useState(() => {
    const existing = txn.classifiedRef?.invoiceIds || (txn.classifiedRef?.invoiceId ? [txn.classifiedRef.invoiceId] : []);
    return new Set(existing);
  });
  const [linkedInvId,  setLinkedInvId]  = useState(txn.classifiedRef?.linkedInvoiceId || "");
  // How to treat the gap between the payment received and the invoice(s) due
  // (FX swing / SWIFT & bank charges). Default: close the invoice and book the
  // difference as Bank Charges. "advance" keeps the remainder as a buyer advance.
  const [recvDiffMode, setRecvDiffMode] = useState(txn.classifiedRef?.differenceMode || "bank_charges");
  // Reclassify an imported credit/debit as a currency conversion (e.g. EEFC → BOI INR).
  const [convOtherAcct, setConvOtherAcct] = useState(txn.classifiedRef?.convOtherAccountId || "");
  const [convRateInput, setConvRateInput] = useState(txn.classifiedRef?.convRate ? String(txn.classifiedRef.convRate) : "");
  const cardAccounts = accounts.filter(a => a.type === "credit_card" && a.active !== false);
  const guessCard = () => {
    const p = `${txn.payee || ""} ${txn.notes || ""}`.toLowerCase();
    return cardAccounts.find(a => {
      const n = (a.name || "").toLowerCase();
      return n && p && (p.includes(n) || n.includes(p) || n.split(/\s+/).filter(w => w.length > 3).some(w => p.includes(w)));
    })?.id || cardAccounts[0]?.id || "";
  };
  const [ccAccountId, setCcAccountId] = useState(txn.classifiedRef?.cardAccountId || guessCard());
  const cardSpendAccount = cardAccounts.find(a => a.id === txn.accountFrom);

  const vendor = vendors.find(v => v.id === vendorId);
  const allOpenBills = purchases.filter(p => p.type === "bill" && p.status !== "paid");
  const vendorBills = vendorId
    ? allOpenBills.filter(p => {
        if (p.vendorId === vendorId) return true;
        const sLow = (p.supplier || "").toLowerCase();
        const vLow = (vendor?.name || "").toLowerCase();
        return sLow.includes(vLow) || vLow.includes(sLow) ||
          vLow.split(" ").filter(w => w.length > 2).some(w => sLow.includes(w));
      })
    : allOpenBills;
  const allOpenPOs = purchases.filter(p => p.type === "po" && p.status !== "paid");
  const vendorPOs = vendorId
    ? allOpenPOs.filter(p => {
        if (p.vendorId === vendorId) return true;
        const sLow = (p.supplier || "").toLowerCase();
        const vLow = (vendor?.name || "").toLowerCase();
        return sLow.includes(vLow) || vLow.includes(sLow) ||
          vLow.split(" ").filter(w => w.length > 2).some(w => sLow.includes(w));
      })
    : allOpenPOs;
  const openInvoices = (invoices || [])
    .filter(inv => !["paid", "cancelled", "draft"].includes(inv.status || "draft"))
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  const txnAmt = +txn.amount || 0;

  const toggleBill = id => setSelectedBillIds(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const selectedBills = vendorBills.filter(b => selectedBillIds.has(b.id));
  const totalBillsDue = selectedBills.reduce((s, b) => s + Math.max(0, (+b.totalAmount || 0) - (+b.paidAmount || 0)), 0);
  const creditAmount  = Math.max(0, txnAmt - totalBillsDue);
  const cur    = txn.currency || "INR";
  const sym    = CUR_SYM[cur] || cur;

  const toggleInv = id => setSelectedInvIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const selectedInvsList = openInvoices.filter(i => selectedInvIds.has(i.id));
  const invTotalOf = inv => +inv.totalAmt || (inv.items || []).reduce((a, i) => a + (+i.amt || 0), 0);
  const invPaidOf = inv => (+inv.paidAmount || 0) + (inv.payments || []).reduce((a, p) => a + (+p.amount || 0), 0);
  const invDueOf = inv => Math.max(0, invTotalOf(inv) - invPaidOf(inv));
  const totalInvDue = selectedInvsList.reduce((s, inv) => {
    return s + invDueOf(inv);
  }, 0);
  const selectedInvDueByCurrency = selectedInvsList.reduce((acc, inv) => {
    const invCur = inv.currency || "USD";
    acc[invCur] = (acc[invCur] || 0) + invDueOf(inv);
    return acc;
  }, {});
  const totalInvDueInTxnCurrency = selectedInvsList.reduce((s, inv) => s + convertMoney(invDueOf(inv), inv.currency || "USD", cur, rates), 0);

  // ── Currency-conversion reclassification helpers ──
  // For a debit, this txn's account is the source; for a credit it's the destination.
  const convThisAcctId = isDebit ? txn.accountFrom : txn.accountTo;
  const convThisAcct   = accounts.find(a => a.id === convThisAcctId);
  const convOther      = accounts.find(a => a.id === convOtherAcct);
  const convSrcCur     = isDebit ? cur : (convOther?.currency || "INR");
  const convDstCur     = isDebit ? (convOther?.currency || "INR") : cur;
  const convRateNum    = +convRateInput || 0;
  // amount is always expressed in the SOURCE account's currency (per computeBalances)
  const convSrcAmt     = isDebit ? txnAmt : (convRateNum ? txnAmt / convRateNum : 0);
  const convDstAmt     = convSrcAmt * convRateNum;

  const canSave = classType === "expense" ? !!expCat
    : classType === "vendor_bill"      ? selectedBillIds.size > 0
    : classType === "vendor_po"        ? !!selectedPoId
    : classType === "customer_receipt" ? selectedInvIds.size > 0
    : classType === "cc_payment"       ? !!ccAccountId
    : classType === "conversion"       ? (!!convOtherAcct && convRateNum > 0)
    : false;

  const handleSave = () => {
    let classifiedRef = {};
    let sideEffects   = {};
    let accountPatch;

    if (classType === "expense") {
      classifiedRef = { cat: expCat, party: expParty, ...(linkedInvId && { linkedInvoiceId: linkedInvId }) };
      sideEffects.newExpense = {
        id: "exp-" + uid(), date: txn.date, cat: expCat, party: expParty,
        amount: txnAmt, currency: cur, notes: expNotes,
        payFromAccount: txn.accountFrom, createdAt: new Date().toISOString(), ledgerTxnId: txn.id,
      };
    } else if (classType === "vendor_bill") {
      // Distribute payment across selected bills (oldest first, then by selection order)
      let remaining = txnAmt;
      const billUpdates = [];
      for (const bill of selectedBills) {
        const due = Math.max(0, (+bill.totalAmount || 0) - (+bill.paidAmount || 0));
        const paying = Math.min(due, remaining);
        const newPaid = (+bill.paidAmount || 0) + paying;
        const billTot = +bill.totalAmount || 0;
        billUpdates.push({ id: bill.id, paidAmount: newPaid, paymentDate: txn.date, status: newPaid >= billTot ? "paid" : "partial" });
        remaining -= paying;
      }
      const credit = Math.max(0, remaining);
      classifiedRef = {
        vendorId, vendorName: vendor?.name,
        billIds: [...selectedBillIds],
        billNumbers: selectedBills.map(b => b.billNumber).filter(Boolean),
        ...(credit > 0 && { creditApplied: credit }),
        ...(linkedInvId && { linkedInvoiceId: linkedInvId }),
      };
      sideEffects.billUpdates = billUpdates;
      if (credit > 0 && vendorId) sideEffects.vendorCredit = { vendorId, amount: credit };
    } else if (classType === "vendor_po") {
      const po      = purchases.find(p => p.id === selectedPoId);
      classifiedRef = { vendorId, vendorName: vendor?.name, poId: selectedPoId, poNumber: po?.poNumber };
      sideEffects.poUpdate = { id: selectedPoId, paidAmount: (+po?.paidAmount || 0) + txnAmt };
    } else if (classType === "customer_receipt") {
      const paymentInr = toINR(txnAmt, cur, rates);
      const dueInr     = selectedInvsList.reduce((s, inv) => s + toINR(invDueOf(inv), inv.currency || "USD", rates), 0);
      const diffInr    = Math.round((dueInr - paymentInr) * 100) / 100; // >0 short (bank ate it), <0 over
      const buyerNames = [...new Set(selectedInvsList.map(inv => buyers.find(b => b.id === inv.buyerId)?.name || inv.buyerName || "").filter(Boolean))];
      const invUpdates = [];
      if (recvDiffMode === "bank_charges") {
        // The customer settled in full; the gap is FX swing / SWIFT & bank charges.
        // Close every selected invoice and book the difference (if any) as an expense.
        for (const inv of selectedInvsList) {
          const invTotal = invTotalOf(inv);
          invUpdates.push({ id: inv.id, paidAmount: invTotal, status: "paid", paidDate: txn.date });
        }
      } else {
        // "advance": apply what the payment covers (oldest/selection order),
        // leave any shortfall outstanding and keep any excess as a buyer advance.
        let remainingInr = paymentInr;
        for (const inv of selectedInvsList) {
          const invCur      = inv.currency || "USD";
          const invTotal    = invTotalOf(inv);
          const alreadyPaid = invPaidOf(inv);
          const due         = Math.max(0, invTotal - alreadyPaid);
          const applyingInr = Math.min(toINR(due, invCur, rates), remainingInr);
          const applying    = convertMoney(applyingInr, "INR", invCur, rates);
          const newPaid     = alreadyPaid + applying;
          const newStatus   = newPaid >= invTotal && invTotal > 0 ? "paid" : "partial";
          invUpdates.push({ id: inv.id, paidAmount: newPaid, status: newStatus, paidDate: newStatus === "paid" ? txn.date : undefined });
          remainingInr -= applyingInr;
        }
      }
      classifiedRef = {
        invoiceIds:  [...selectedInvIds],
        invoiceId:   [...selectedInvIds][0], // backward compat
        invNumbers:  selectedInvsList.map(i => i.invNo || i.invNumber || i.number).filter(Boolean),
        invNumber:   selectedInvsList[0]?.invNo || selectedInvsList[0]?.invNumber || selectedInvsList[0]?.number,
        buyer:       buyerNames.join(", "),
        paymentAmount: txnAmt,
        paymentCurrency: cur,
        invoiceDueByCurrency: selectedInvDueByCurrency,
        differenceMode: recvDiffMode,
        differenceInr: diffInr,
        ...(recvDiffMode === "advance" && diffInr < -0.01 && { advanceReceivedInr: Math.round(-diffInr * 100) / 100 }),
      };
      sideEffects.invoiceUpdates = invUpdates;
      // Book the shortfall as a Bank Charges expense so the invoice can close cleanly.
      if (recvDiffMode === "bank_charges" && diffInr > 0.01) {
        sideEffects.newExpense = {
          id: "exp-" + uid(), date: txn.date, cat: "Bank Charges",
          party: buyerNames.join(", ") || txn.payee || "",
          amount: diffInr, currency: "INR",
          notes: `FX / bank charges on receipt${classifiedRef.invNumbers?.length ? ` for ${classifiedRef.invNumbers.join(", ")}` : ""}`,
          payFromAccount: txn.accountTo, createdAt: new Date().toISOString(), ledgerTxnId: txn.id,
        };
      }
    } else if (classType === "cc_payment") {
      const card = cardAccounts.find(a => a.id === ccAccountId);
      classifiedRef = { cardAccountId: ccAccountId, cardAccountName: card?.name || "", note: expNotes || "Credit card payment" };
    } else if (classType === "conversion") {
      // Turn this imported credit/debit into a proper account-to-account conversion.
      const fromAcctId = isDebit ? convThisAcctId : convOtherAcct;
      const toAcctId   = isDebit ? convOtherAcct  : convThisAcctId;
      accountPatch = {
        type: "conversion",
        accountFrom: fromAcctId,
        accountTo:   toAcctId,
        amount:      Math.round(convSrcAmt * 100) / 100,
        currency:    convSrcCur,
        convRate:    convRateNum,
      };
      classifiedRef = {
        conversion: true,
        fromAccountId: fromAcctId, toAccountId: toAcctId,
        fromAccountName: accounts.find(a => a.id === fromAcctId)?.name || "",
        toAccountName:   accounts.find(a => a.id === toAcctId)?.name || "",
        convRate: convRateNum,
        convOtherAccountId: convOtherAcct,
        sourceAmount: Math.round(convSrcAmt * 100) / 100, sourceCurrency: convSrcCur,
        targetAmount: Math.round(convDstAmt * 100) / 100, targetCurrency: convDstCur,
      };
    }

    onSave(txn.id, { classifiedAs: classType, classifiedRef, sideEffects, ...(accountPatch && { _accountPatch: accountPatch }) });
    onClose();
  };

  const SI = { width: "100%", background: C.surface, border: `1.5px solid ${C.border}`, color: C.ink, borderRadius: 6, padding: "8px 10px", fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" };

  const TYPES = isDebit
    ? [
        { id: "expense",      label: "Expense",                desc: "Rent, freight, salary, etc.",         color: C.amber  },
        { id: "vendor_bill",  label: "Vendor Bill Payment",    desc: "Apply against an existing bill",      color: C.blue   },
        { id: "vendor_po",    label: "Advance against PO",     desc: "Advance payment on a Purchase Order", color: C.purple },
        { id: "cc_payment",   label: "Credit Card Payment",    desc: "Payment made to credit card company", color: C.teal   },
        { id: "conversion",   label: "Currency Conversion",    desc: "Transfer between accounts (e.g. EEFC → INR)", color: C.blue },
      ]
    : [
        { id: "customer_receipt", label: "Customer Receipt",    desc: "Apply against an open invoice",           color: C.green },
        { id: "cc_payment",       label: "Credit Card Payment", desc: "Payment received against credit card bill", color: C.teal  },
        { id: "conversion",       label: "Currency Conversion", desc: "Transfer between accounts (e.g. EEFC → INR)", color: C.blue  },
        { id: "expense",          label: "Other Credit",        desc: "Loan, refund, misc. income, etc.",          color: C.amber },
      ];

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: C.bg, border: mob ? "none" : `1.5px solid ${C.border}`, borderRadius: mob ? 0 : 12, padding: mob ? "20px 16px" : "24px 26px", width: "100%", maxWidth: mob ? "100%" : 500, maxHeight: mob ? "100%" : "90vh", height: mob ? "100%" : "auto", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,.3)" }}>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 18 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15, color: C.ink }}>Classify Transaction</div>
            <div style={{ fontSize: 12, color: C.inkFaint, marginTop: 3 }}>
              {sym}{txnAmt.toLocaleString("en-IN", { minimumFractionDigits: 2 })} · {txn.payee || "No payee"} · {fmtDate(txn.date)}
            </div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: C.inkFaint, fontSize: 18, lineHeight: 1, padding: "0 4px" }}>✕</button>
        </div>

        {/* Type selector */}
        <div style={{ display: "flex", flexDirection: "column", gap: 7, marginBottom: 20 }}>
          {TYPES.map(t => (
            <button key={t.id} onClick={() => setClassType(t.id)} style={{
              display: "flex", alignItems: "center", gap: 12, padding: "10px 14px",
              background: classType === t.id ? C.card : C.surface,
              border: `1.5px solid ${classType === t.id ? t.color : C.border}`,
              borderRadius: 8, cursor: "pointer", textAlign: "left", width: "100%",
            }}>
              <div style={{ width: 10, height: 10, borderRadius: "50%", background: classType === t.id ? t.color : C.border, flexShrink: 0 }} />
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>{t.label}</div>
                <div style={{ fontSize: 11, color: C.inkFaint }}>{t.desc}</div>
              </div>
            </button>
          ))}
        </div>

        {/* Expense fields */}
        {classType === "expense" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {cardSpendAccount && <div style={{ padding: "9px 11px", background: C.tealBg, border: `1px solid ${C.teal}55`, borderRadius: 8, fontSize: 12, color: C.inkMid }}>Paid using <strong>{cardSpendAccount.name}</strong>. This expense will increase that card's amount due.</div>}
            <div><FTag>Category</FTag>
              <input list="exp-cats" value={expCat} onChange={e => setExpCat(e.target.value)} placeholder="Type or pick a category…" style={SI} />
              <datalist id="exp-cats">{EXP_CATS.map(c => <option key={c} value={c} />)}</datalist>
            </div>
            <div><FTag>Party / Vendor</FTag>
              <input
                value={expParty}
                onChange={e => {
                  const val = e.target.value;
                  const match = vendors.find(v => v.name?.toLowerCase() === val.toLowerCase());
                  setExpParty(val);
                  if (match) setVendorId(match.id);
                }}
                placeholder="Type or pick a vendor…"
                style={SI}
                list="exp-classify-vendors"
              />
              <datalist id="exp-classify-vendors">
                {[...vendors].sort((a, b) => a.name.localeCompare(b.name)).map(v => <option key={v.id} value={v.name} />)}
              </datalist>
              {vendors.find(v => v.id === vendorId) && expParty && <div style={{ fontSize: 10, color: "var(--c-green)", marginTop: 3 }}>✓ Linked to vendor ledger</div>}
            </div>
            <div><FTag>Notes</FTag>
              <input value={expNotes} onChange={e => setExpNotes(e.target.value)} placeholder="Optional" style={SI} />
            </div>
          </div>
        )}

        {/* Credit card payment */}
        {classType === "cc_payment" && (
          <div style={{ padding: "12px 14px", background: C.tealBg, border: `1px solid ${C.teal}`, borderRadius: 8, fontSize: 12, color: C.ink, display: "grid", gap: 10 }}>
            <div>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Credit Card Payment</div>
              <div style={{ color: C.inkFaint }}>This keeps the bank payment and reduces the selected card's amount due.</div>
            </div>
            <div><FTag>Credit Card Account</FTag>
              <select value={ccAccountId} onChange={e => setCcAccountId(e.target.value)} style={SI}>
                <option value="">- Select credit card -</option>
                {cardAccounts.map(a => <option key={a.id} value={a.id}>{a.name}{a.creditLimit ? ` · limit ₹${(+a.creditLimit || 0).toLocaleString("en-IN")}` : ""}</option>)}
              </select>
              {cardAccounts.length === 0 && <div style={{ fontSize: 11, color: C.red, marginTop: 5 }}>Add a credit card account in Finance settings first.</div>}
            </div>
            <div><FTag>Notes</FTag><input value={expNotes} onChange={e => setExpNotes(e.target.value)} placeholder="Statement month, card ending, reference..." style={SI} /></div>
          </div>
        )}

        {/* Vendor bill / PO fields */}
        {(classType === "vendor_bill" || classType === "vendor_po") && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div><FTag>Filter by Vendor (optional)</FTag>
              <select value={vendorId} onChange={e => { setVendorId(e.target.value); setSelectedBillId(""); setSelectedPoId(""); }} style={SI}>
                <option value="">All vendors</option>
                {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </div>

            {classType === "vendor_bill" && (
              <div>
                <FTag>Select Bills to Pay {vendorId ? `— ${vendor?.name}` : "(all vendors)"} <span style={{ fontWeight: 400, color: C.inkFaint }}>(tap to select multiple)</span></FTag>
                {vendorBills.length === 0
                  ? <div style={{ fontSize: 12, color: C.inkFaint, padding: "8px 0" }}>No open bills found.</div>
                  : <>
                      <div style={{ maxHeight: 240, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
                        {vendorBills.map(b => {
                          const due = Math.max(0, (+b.totalAmount || 0) - (+b.paidAmount || 0));
                          const sel = selectedBillIds.has(b.id);
                          return (
                            <button key={b.id} onClick={() => toggleBill(b.id)} style={{
                              display: "flex", alignItems: "center", gap: 10, width: "100%",
                              padding: "9px 12px",
                              background: sel ? C.card : C.surface,
                              border: `1.5px solid ${sel ? C.blue : C.border}`,
                              borderRadius: 7, cursor: "pointer", textAlign: "left",
                            }}>
                              <div style={{ width: 18, height: 18, borderRadius: 4, border: `2px solid ${sel ? C.blue : C.border}`, background: sel ? C.blue : "transparent", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                                {sel && <span style={{ color: "#fff", fontSize: 11, fontWeight: 700, lineHeight: 1 }}>✓</span>}
                              </div>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: 12, fontWeight: 600, color: C.ink }}>{b.billNumber || "Bill"}</div>
                                <div style={{ fontSize: 11, color: C.inkFaint }}>{b.supplier} · {fmtDate(b.billDate)} · {b.status}</div>
                              </div>
                              <div style={{ textAlign: "right", flexShrink: 0 }}>
                                <div style={{ fontSize: 12, fontWeight: 600, color: C.red }}>₹{due.toLocaleString("en-IN", { minimumFractionDigits: 2 })} due</div>
                                <div style={{ fontSize: 10, color: C.inkFaint }}>of ₹{(+b.totalAmount || 0).toLocaleString("en-IN")}</div>
                              </div>
                            </button>
                          );
                        })}
                      </div>

                      {/* Payment summary */}
                      {selectedBillIds.size > 0 && (
                        <div style={{ marginTop: 10, padding: "10px 13px", background: C.card, borderRadius: 8, border: `1px solid ${C.border}` }}>
                          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                            <span style={{ color: C.inkFaint }}>{selectedBillIds.size} bill{selectedBillIds.size > 1 ? "s" : ""} selected · total due</span>
                            <span style={{ fontWeight: 600, color: C.ink }}>₹{totalBillsDue.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</span>
                          </div>
                          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                            <span style={{ color: C.inkFaint }}>Payment amount</span>
                            <span style={{ fontWeight: 600, color: C.ink }}>₹{txnAmt.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</span>
                          </div>
                          {creditAmount > 0 && (
                            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginTop: 6, paddingTop: 6, borderTop: `1px solid ${C.border}` }}>
                              <span style={{ color: C.green, fontWeight: 600 }}>↳ Credit to vendor ledger</span>
                              <span style={{ fontWeight: 700, color: C.green }}>₹{creditAmount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</span>
                            </div>
                          )}
                          {txnAmt < totalBillsDue && (
                            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginTop: 6, paddingTop: 6, borderTop: `1px solid ${C.border}` }}>
                              <span style={{ color: C.amber, fontWeight: 600 }}>Still outstanding</span>
                              <span style={{ fontWeight: 700, color: C.amber }}>₹{(totalBillsDue - txnAmt).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</span>
                            </div>
                          )}
                        </div>
                      )}
                    </>
                }
              </div>
            )}

            {classType === "vendor_po" && (
              <div><FTag>Open POs {vendorId ? `— ${vendor?.name}` : "(all vendors)"}</FTag>
                {vendorPOs.length === 0
                  ? <div style={{ fontSize: 12, color: C.inkFaint, padding: "8px 0" }}>No open POs found.</div>
                  : <div style={{ maxHeight: 220, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
                      {vendorPOs.map(po => (
                        <button key={po.id} onClick={() => setSelectedPoId(po.id)} style={{
                          display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%",
                          padding: "9px 12px",
                          background: selectedPoId === po.id ? C.card : C.surface,
                          border: `1.5px solid ${selectedPoId === po.id ? C.purple : C.border}`,
                          borderRadius: 7, cursor: "pointer", textAlign: "left",
                        }}>
                          <div>
                            <div style={{ fontSize: 12, fontWeight: 600, color: C.ink }}>{po.poNumber || "PO"}</div>
                            <div style={{ fontSize: 11, color: C.inkFaint }}>{po.supplier} · {fmtDate(po.date)} · {po.status}</div>
                          </div>
                          <div style={{ textAlign: "right" }}>
                            <div style={{ fontSize: 12, fontWeight: 600, color: C.ink }}>{po.currency || "INR"}</div>
                            {po.paidAmount > 0 && <div style={{ fontSize: 10, color: C.inkFaint }}>₹{(+po.paidAmount).toLocaleString()} paid</div>}
                          </div>
                        </button>
                      ))}
                    </div>
                }
              </div>
            )}
          </div>
        )}

        {/* Customer receipt fields — multi-select */}
        {classType === "customer_receipt" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <FTag>Apply Against Invoice(s)</FTag>
              {selectedInvIds.size > 0 && (
                <span style={{ fontSize: 11, color: C.green, fontWeight: 600 }}>{selectedInvIds.size} selected</span>
              )}
            </div>
            {openInvoices.length === 0
              ? <div style={{ fontSize: 12, color: C.inkFaint, padding: "8px 0" }}>No open invoices found.</div>
              : openInvoices.map(inv => {
                  const invTotal  = +inv.totalAmt || (inv.items || []).reduce((s, i) => s + (+i.amt || 0), 0);
                  const invPaid   = (+inv.paidAmount || 0) + (inv.payments || []).reduce((s, p) => s + (+p.amount || 0), 0);
                  const invDue    = Math.max(0, invTotal - invPaid);
                  const buyerName = buyers.find(b => b.id === inv.buyerId)?.name || inv.buyerName || "—";
                  const checked   = selectedInvIds.has(inv.id);
                  return (
                    <button key={inv.id} onClick={() => toggleInv(inv.id)} style={{
                      display: "flex", alignItems: "center", gap: 10, width: "100%",
                      padding: "9px 12px", marginBottom: 6,
                      background: checked ? C.card : C.surface,
                      border: `1.5px solid ${checked ? C.green : C.border}`,
                      borderRadius: 7, cursor: "pointer", textAlign: "left",
                    }}>
                      {/* Checkbox */}
                      <div style={{ width: 16, height: 16, borderRadius: 4, border: `2px solid ${checked ? C.green : C.border}`, background: checked ? C.green : "transparent", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                        {checked && <svg width="9" height="7" viewBox="0 0 9 7"><path d="M1 3.5l2.5 2.5 4.5-5" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: C.ink }}>{inv.invNo || inv.invNumber || inv.number || "(no number)"}</div>
                        <div style={{ fontSize: 11, color: C.inkFaint }}>{buyerName} · {fmtDate(inv.date)} · {inv.status || "—"}</div>
                      </div>
                      <div style={{ textAlign: "right", flexShrink: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: C.red }}>
                          {inv.currency || "USD"} {invDue.toLocaleString(undefined, { minimumFractionDigits: 2 })} due
                        </div>
                        <div style={{ fontSize: 10, color: C.inkFaint }}>
                          of {inv.currency || "USD"} {invTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                        </div>
                      </div>
                    </button>
                  );
                })
            }
            {/* Payment summary across selected invoices */}
            {selectedInvIds.size > 0 && (() => {
              const applying  = Math.min(totalInvDueInTxnCurrency, txnAmt);
              const stillDue  = Math.max(0, totalInvDueInTxnCurrency - applying);
              const overpay   = Math.max(0, txnAmt - totalInvDueInTxnCurrency);
              const invDueLabel = Object.entries(selectedInvDueByCurrency).map(([c, a]) => moneyText(a, c)).join(" + ");
              const paymentInr = toINR(txnAmt, cur, rates);
              const dueInrTotal = selectedInvsList.reduce((s, inv) => s + toINR(invDueOf(inv), inv.currency || "USD", rates), 0);
              const diffInr = Math.round((dueInrTotal - paymentInr) * 100) / 100; // >0 short, <0 over
              const hasGap = Math.abs(diffInr) > 0.5;
              return (
                <div style={{ marginTop: 10, padding: "10px 13px", background: C.card, borderRadius: 8, border: `1px solid ${C.border}` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                    <span style={{ color: C.inkFaint }}>Payment received</span>
                    <span style={{ fontWeight: 600, color: C.ink }}>{moneyText(txnAmt, cur)}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                    <span style={{ color: C.inkFaint }}>Total due ({selectedInvIds.size} invoice{selectedInvIds.size > 1 ? "s" : ""})</span>
                    <span style={{ fontWeight: 600, color: C.red }}>{invDueLabel}</span>
                  </div>
                  {Object.keys(selectedInvDueByCurrency).some(c => c !== cur) && (
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4, paddingTop: 4, borderTop: `1px solid ${C.border}` }}>
                      <span style={{ color: C.inkFaint }}>Approx in payment currency</span>
                      <span style={{ fontWeight: 600, color: C.ink }}>{moneyText(totalInvDueInTxnCurrency, cur)}</span>
                    </div>
                  )}
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                    <span style={{ color: C.inkFaint }}>Applied</span>
                    <span style={{ fontWeight: 600, color: C.green }}>- {moneyText(applying, cur)}</span>
                  </div>
                  {stillDue > 0 && (
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginTop: 6, paddingTop: 6, borderTop: `1px solid ${C.border}` }}>
                      <span style={{ color: C.amber, fontWeight: 600 }}>Still outstanding</span>
                      <span style={{ fontWeight: 700, color: C.amber }}>{moneyText(stillDue, cur)}</span>
                    </div>
                  )}
                  {overpay > 0 && (
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginTop: 6, paddingTop: 6, borderTop: `1px solid ${C.border}` }}>
                      <span style={{ color: C.green, fontWeight: 600 }}>Overpayment / advance</span>
                      <span style={{ fontWeight: 700, color: C.green }}>{moneyText(overpay, cur)}</span>
                    </div>
                  )}
                  {stillDue === 0 && overpay === 0 && !hasGap && (
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginTop: 6, paddingTop: 6, borderTop: `1px solid ${C.border}` }}>
                      <span style={{ color: C.green, fontWeight: 600 }}>✓ Exact match</span>
                    </div>
                  )}

                  {/* Difference handling — FX swing / bank charges vs. advance */}
                  {hasGap && (
                    <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${C.border}` }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 7 }}>
                        <span style={{ color: C.inkFaint }}>Difference vs. invoice{selectedInvIds.size > 1 ? "s" : ""}</span>
                        <span style={{ fontWeight: 700, color: diffInr > 0 ? C.amber : C.green }}>
                          {diffInr > 0 ? "−" : "+"}{moneyText(Math.abs(diffInr), "INR")} {diffInr > 0 ? "short" : "over"}
                        </span>
                      </div>
                      <div style={{ display: "flex", gap: 6 }}>
                        {[
                          { id: "bank_charges", label: diffInr > 0 ? "Bank charges" : "Round-off", desc: "Close invoice" },
                          { id: "advance",      label: "Advance",       desc: diffInr > 0 ? "Leave outstanding" : "Keep as credit" },
                        ].map(o => (
                          <button key={o.id} onClick={() => setRecvDiffMode(o.id)} style={{
                            flex: 1, padding: "7px 8px", borderRadius: 7, cursor: "pointer", textAlign: "left",
                            background: recvDiffMode === o.id ? C.surface : "transparent",
                            border: `1.5px solid ${recvDiffMode === o.id ? C.gold : C.border}`,
                          }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: C.ink }}>{o.label}</div>
                            <div style={{ fontSize: 10, color: C.inkFaint }}>{o.desc}</div>
                          </button>
                        ))}
                      </div>
                      <div style={{ fontSize: 11, color: C.inkMid, marginTop: 7, lineHeight: 1.4 }}>
                        {recvDiffMode === "bank_charges"
                          ? (diffInr > 0
                              ? `Invoice${selectedInvIds.size > 1 ? "s" : ""} marked fully paid; ${moneyText(diffInr, "INR")} booked as Bank Charges.`
                              : `Invoice${selectedInvIds.size > 1 ? "s" : ""} marked fully paid; ${moneyText(-diffInr, "INR")} excess absorbed as round-off.`)
                          : (diffInr > 0
                              ? `Applies ${moneyText(paymentInr, "INR")}; remainder stays outstanding on the invoice.`
                              : `Settles the invoice${selectedInvIds.size > 1 ? "s" : ""}; ${moneyText(-diffInr, "INR")} kept as a buyer advance.`)}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        )}

        {/* Currency conversion — reclassify this entry as an account-to-account transfer */}
        {classType === "conversion" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ padding: "9px 11px", background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12, color: C.inkMid }}>
              This {isDebit ? "outflow from" : "deposit into"} <strong>{convThisAcct?.name || "this account"}</strong> {convThisAcct?.currency ? `(${convThisAcct.currency})` : ""} is a transfer between your own accounts — e.g. converting EEFC to INR. Pick the {isDebit ? "destination" : "source"} account and the rate used.
            </div>
            <div>
              <FTag>{isDebit ? "Converted into" : "Converted from"}</FTag>
              <select value={convOtherAcct} onChange={e => setConvOtherAcct(e.target.value)} style={SI}>
                <option value="">— Select account —</option>
                {accounts.filter(a => a.active !== false && a.id !== convThisAcctId && a.type !== "credit_card").map(a => (
                  <option key={a.id} value={a.id}>{a.name} ({a.currency})</option>
                ))}
              </select>
            </div>
            <div>
              <FTag>Rate {convSrcCur && convDstCur && convSrcCur !== convDstCur ? `(1 ${convSrcCur} = ? ${convDstCur})` : ""}</FTag>
              <input type="number" inputMode="decimal" value={convRateInput} onChange={e => setConvRateInput(e.target.value)} placeholder={convSrcCur !== convDstCur ? `e.g. ${(convertMoney(1, convSrcCur, convDstCur, rates) || 1).toFixed(2)}` : "1"} style={SI} />
            </div>
            {convOtherAcct && convRateNum > 0 && (
              <div style={{ padding: "10px 13px", background: C.card, borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ color: C.inkFaint }}>Out of {accounts.find(a => a.id === (isDebit ? convThisAcctId : convOtherAcct))?.name}</span>
                  <span style={{ fontWeight: 700, color: C.red }}>− {moneyText(convSrcAmt, convSrcCur)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: C.inkFaint }}>Into {accounts.find(a => a.id === (isDebit ? convOtherAcct : convThisAcctId))?.name}</span>
                  <span style={{ fontWeight: 700, color: C.green }}>+ {moneyText(convDstAmt, convDstCur)}</span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Link to Invoice — for expenses and bill payments */}
        {(classType === "expense" || classType === "vendor_bill") && invoices?.length > 0 && (
          <div style={{ marginTop: 16, borderTop: `1px solid ${C.border}`, paddingTop: 14 }}>
            <FTag>Link to Invoice (optional)</FTag>
            <select value={linkedInvId} onChange={e => setLinkedInvId(e.target.value)} style={{ width: "100%", background: C.surface, border: `1.5px solid ${C.border}`, color: C.ink, borderRadius: 6, padding: "8px 10px", fontSize: 13, fontFamily: "inherit" }}>
              <option value="">— Not linked to an invoice —</option>
              {invoices.map(inv => (
                <option key={inv.id} value={inv.id}>
                  {inv.invNo || inv.number || "Invoice"} · {fmtDate(inv.date)}{inv.totalAmt ? ` · ${inv.currency || "$"} ${(+inv.totalAmt).toLocaleString()}` : ""}
                </option>
              ))}
            </select>
          </div>
        )}

        <div style={{ display: "flex", gap: 10, marginTop: 22 }}>
          <button onClick={handleSave} disabled={!canSave} style={{
            flex: 1, background: C.gold, border: "none", color: "#fff", borderRadius: 7,
            padding: "10px 0", fontWeight: 600, fontSize: 13,
            cursor: canSave ? "pointer" : "not-allowed", opacity: canSave ? 1 : 0.5, fontFamily: "inherit",
          }}>Save Classification</button>
          <button onClick={onClose} style={{ padding: "10px 16px", background: C.surface, border: `1.5px solid ${C.border}`, color: C.ink, borderRadius: 7, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ─── AttachmentModal ─────────────────────────────────────────────────────────
function AttachmentModal({ txn, onSave, onClose }) {
  const [uploading, setUploading] = useState(false);
  const [removing,  setRemoving]  = useState(false);
  const fileRef = useRef();

  const attachments = txn.attachments || (txn.attachmentUrl ? [{ url: txn.attachmentUrl, name: txn.attachmentName || "Attachment" }] : []);

  const handleFiles = async files => {
    if (!files?.length) return;
    setUploading(true);
    const newAtts = [...attachments];
    for (const file of Array.from(files)) {
      try {
        await supabase.storage.createBucket("bill-docs", { public: true }).catch(() => {});
        const ext = file.name.split(".").pop().toLowerCase();
        const path = `txn-attach-${txn.id}-${Date.now()}.${ext}`;
        await supabase.storage.from("bill-docs").upload(path, file, { upsert: true, contentType: file.type });
        const { data } = supabase.storage.from("bill-docs").getPublicUrl(path);
        newAtts.push({ url: data.publicUrl, name: file.name, ext });
      } catch {}
    }
    await onSave(txn.id, { attachments: newAtts, attachmentUrl: newAtts[0]?.url, attachmentName: newAtts[0]?.name });
    setUploading(false);
  };

  const remove = async idx => {
    setRemoving(true);
    const next = attachments.filter((_, i) => i !== idx);
    await onSave(txn.id, { attachments: next, attachmentUrl: next[0]?.url || null, attachmentName: next[0]?.name || null });
    setRemoving(false);
  };

  const isImg = att => ["jpg","jpeg","png","gif","webp","bmp"].includes((att.ext || att.name?.split(".").pop() || "").toLowerCase()) || (att.url && /\.(jpg|jpeg|png|gif|webp|bmp)/i.test(att.url));

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", zIndex: 600, display: "flex", alignItems: "center", justifyContent: "center", backdropFilter: "blur(3px)" }} onClick={onClose}>
      <div style={{ width: "min(560px,96vw)", background: C.surface, borderRadius: 12, boxShadow: "0 24px 60px rgba(0,0,0,.35)", overflow: "hidden" }} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: "14px 20px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14, color: C.ink }}>📎 Attachments</div>
            <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 2 }}>{txn.payee || txn.notes || txn.date} · {txn.type} ₹{(+txn.amount||0).toLocaleString("en-IN")}</div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: C.inkFaint, padding: "0 4px" }}>×</button>
        </div>
        {/* Body */}
        <div style={{ padding: "18px 20px" }}>
          {/* Existing attachments */}
          {attachments.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
              {attachments.map((att, i) => (
                <div key={i} style={{ position: "relative", border: `1.5px solid ${C.border}`, borderRadius: 8, overflow: "hidden", background: C.card }}>
                  {isImg(att)
                    ? <img src={att.url} alt={att.name} style={{ width: 160, height: 110, objectFit: "cover", display: "block", cursor: "pointer" }} onClick={() => window.open(att.url, "_blank")} />
                    : <div style={{ width: 160, height: 110, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, cursor: "pointer", color: C.inkMid }} onClick={() => window.open(att.url, "_blank")}>
                        <span style={{ fontSize: 28 }}>📄</span>
                        <span style={{ fontSize: 10, color: C.inkFaint, textAlign: "center", padding: "0 8px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 150 }}>{att.name}</span>
                      </div>
                  }
                  <button onClick={() => remove(i)} disabled={removing} style={{ position: "absolute", top: 4, right: 4, background: "rgba(0,0,0,.55)", border: "none", borderRadius: "50%", width: 20, height: 20, color: "#fff", fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1, padding: 0 }}>×</button>
                  <div style={{ padding: "4px 8px", fontSize: 9, color: C.inkFaint, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", borderTop: `1px solid ${C.border}` }}>{att.name}</div>
                </div>
              ))}
            </div>
          )}
          {/* Upload area */}
          <input ref={fileRef} type="file" multiple accept="image/*,application/pdf,.pdf,.doc,.docx,.xls,.xlsx" style={{ display: "none" }} onChange={e => { handleFiles(e.target.files); e.target.value = ""; }} />
          <div
            style={{ border: `2px dashed ${C.border}`, borderRadius: 10, padding: "24px 20px", textAlign: "center", cursor: uploading ? "default" : "pointer", background: uploading ? C.card : "transparent", transition: "background .15s" }}
            onClick={() => !uploading && fileRef.current?.click()}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); handleFiles(e.dataTransfer.files); }}
          >
            {uploading
              ? <div style={{ color: C.inkFaint, fontSize: 13 }}>⏳ Uploading…</div>
              : <>
                  <div style={{ fontSize: 28, marginBottom: 6 }}>📎</div>
                  <div style={{ fontSize: 13, color: C.inkMid, fontWeight: 600 }}>Click or drag &amp; drop files</div>
                  <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 4 }}>Images, PDF, Excel — multiple files supported</div>
                </>
            }
          </div>
        </div>
      </div>
    </div>
  );
}

function EditTxnModal({ txn, accounts, onSave, onClose }) {
  const isConv = txn.type === "conversion";
  const cur = txn.currency || accounts.find(a => a.id === (txn.accountTo || txn.accountFrom))?.currency || "INR";
  const [date,     setDate]     = useState(txn.date || "");
  const [amount,   setAmount]   = useState(txn.amount != null ? String(txn.amount) : "");
  const [currency, setCurrency] = useState(cur);
  const [payee,    setPayee]    = useState(txn.payee || "");
  const [category, setCategory] = useState(txn.category || "");
  const [notes,    setNotes]    = useState(txn.notes || "");

  const FI2 = { background: C.surface, border: `1px solid ${C.border}`, color: C.ink, borderRadius: 6, padding: "7px 10px", fontSize: 13, fontFamily: "inherit", width: "100%", boxSizing: "border-box" };

  const handleSave = () => {
    const patch = { date, payee, category, notes };
    if (!isConv) { patch.amount = amount; patch.currency = currency; }
    onSave(txn.id, patch);
    onClose();
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.55)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12, padding: 22, width: "100%", maxWidth: 400, boxShadow: "0 8px 40px rgba(0,0,0,.25)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
          <span style={{ fontWeight: 700, fontSize: 15, color: C.ink }}>Edit Transaction</span>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 20, color: C.inkFaint, lineHeight: 1 }}>&times;</button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <div style={{ fontSize: 10, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .7, marginBottom: 4 }}>Date</div>
            <input type="date" value={date} onChange={e => setDate(e.target.value)} style={FI2} />
          </div>
          {!isConv && (
            <div style={{ display: "flex", gap: 8 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 10, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .7, marginBottom: 4 }}>Amount</div>
                <input type="number" value={amount} onChange={e => setAmount(e.target.value)} style={FI2} placeholder="0" />
              </div>
              <div style={{ width: 90 }}>
                <div style={{ fontSize: 10, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .7, marginBottom: 4 }}>Currency</div>
                <select value={currency} onChange={e => setCurrency(e.target.value)} style={FI2}>
                  {Object.keys(CUR_SYM).map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>
          )}
          <div>
            <div style={{ fontSize: 10, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .7, marginBottom: 4 }}>Payee / Source</div>
            <input value={payee} onChange={e => setPayee(e.target.value)} style={FI2} placeholder="Who paid / received" />
          </div>
          <div>
            <div style={{ fontSize: 10, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .7, marginBottom: 4 }}>Category</div>
            <input value={category} onChange={e => setCategory(e.target.value)} style={FI2} placeholder="e.g. Travel, Gems" />
          </div>
          <div>
            <div style={{ fontSize: 10, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .7, marginBottom: 4 }}>Notes</div>
            <input value={notes} onChange={e => setNotes(e.target.value)} style={FI2} placeholder="Optional notes" />
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
          <button onClick={handleSave} style={{ flex: 1, background: C.gold, border: "none", color: "#fff", borderRadius: 7, padding: "10px 0", fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>Save</button>
          <button onClick={onClose} style={{ padding: "10px 16px", background: C.surface, border: `1.5px solid ${C.border}`, color: C.ink, borderRadius: 7, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function LedgerView({ transactions, accounts, rates, onDelete, onUpdate, vendors = [], purchases = [], expenses = [], invoices = [], buyers = [], onClassify }) {
  const masked = useMasked();
  const m = makeMask(masked);
  const [filterAcc,    setFilterAcc]    = useState("");
  const [filterType,   setFilterType]   = useState("");
  const [filterMonth,  setFilterMonth]  = useState("");
  const [filterSearch, setFilterSearch] = useState("");
  const [confirmDel,   setConfirmDel]   = useState(null);
  const [classifyTxn,  setClassifyTxn]  = useState(null);
  const [sortBy,       setSortBy]       = useState("txnDate");
  const [editAccTxn,   setEditAccTxn]   = useState(null);
  const [editTxn,      setEditTxn]      = useState(null);
  const [attachTxn,    setAttachTxn]    = useState(null);
  const [selected,     setSelected]     = useState(new Set()); // selected txn ids

  const isBackdated = t => t.createdAt && t.createdAt.slice(0,10) !== t.date;

  // Always sort by txn date asc for bank-statement view when account filtered
  const sorted = [...transactions].sort((a, b) => {
    if (sortBy === "entryDate") return (b.createdAt || b.date).localeCompare(a.createdAt || a.date);
    return a.date.localeCompare(b.date); // asc for running balance
  });
  const filtered = sorted.filter(t => {
    if (filterAcc    && t.accountFrom !== filterAcc && t.accountTo !== filterAcc) return false;
    if (filterType   && t.type !== filterType) return false;
    if (filterMonth  && !(t.date || "").startsWith(filterMonth)) return false;
    if (filterSearch) {
      const q = filterSearch.toLowerCase();
      if (!(t.payee||"").toLowerCase().includes(q) && !(t.category||"").toLowerCase().includes(q) && !(t.notes||"").toLowerCase().includes(q)) return false;
    }
    return true;
  });

  // Running balance per row (only meaningful when a single account is selected)
  const accObj = accounts.find(a => a.id === filterAcc);
  const runningBals = (() => {
    if (!filterAcc || !accObj) return null;
    let bal = +(accObj.openingBal || 0);
    return filtered.map(t => {
      if (t.type === "credit") bal += +t.amount;
      else if (t.type === "debit") bal -= +t.amount;
      return bal;
    });
  })();

  const getAcc = id => accounts.find(a => a.id === id);
  const FI = { background: C.surface, border: `1px solid ${C.border}`, color: C.ink, borderRadius: 5, padding: "5px 9px", fontSize: mob ? 14 : 12, fontFamily: "inherit" };

  const allSelected = filtered.length > 0 && filtered.every(t => selected.has(t.id));
  const toggleAll   = () => setSelected(allSelected ? new Set() : new Set(filtered.map(t => t.id)));
  const toggleOne   = id => setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const exportCSV = () => {
    const rows = filtered.filter(t => selected.size === 0 || selected.has(t.id));
    const accName = accObj?.name || "All Accounts";
    const headers = ["Date", "Description", "Category", "Debit", "Credit", ...(filterAcc ? ["Balance"] : []), "Account", "Notes"];
    const lines = [headers.join(",")];
    rows.forEach((t, i) => {
      const debit  = t.type === "debit"   ? (+t.amount).toFixed(2) : "";
      const credit = t.type === "credit"  ? (+t.amount).toFixed(2) : "";
      const bal    = runningBals ? runningBals[i].toFixed(2) : "";
      const row = [
        t.date,
        `"${(t.payee || "").replace(/"/g,'""')}"`,
        `"${(t.category || "").replace(/"/g,'""')}"`,
        debit, credit,
        ...(filterAcc ? [bal] : []),
        `"${(getAcc(t.accountTo || t.accountFrom)?.name || "").replace(/"/g,'""')}"`,
        `"${(t.notes || "").replace(/"/g,'""')}"`,
      ];
      lines.push(row.join(","));
    });
    const csv = lines.join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const month = filterMonth || new Date().toISOString().slice(0,7);
    a.download = `statement-${accName.replace(/\s+/g,"-")}-${month}.csv`;
    a.click();
  };

  // Summary totals
  const totalIn  = filtered.filter(t => t.type === "credit").reduce((s, t) => s + toINR(+t.amount, t.currency, rates), 0);
  const totalOut = filtered.filter(t => t.type === "debit").reduce((s, t) => s + toINR(+t.amount, t.currency, rates), 0);

  return (
    <div>
      {classifyTxn && (
	        <ClassifyModal
	          txn={classifyTxn}
	          accounts={accounts}
	          vendors={vendors}
          purchases={purchases}
          invoices={invoices}
          buyers={buyers}
          rates={rates}
          onSave={(txnId, result) => { onClassify(txnId, result); }}
          onClose={() => setClassifyTxn(null)}
        />
      )}
      {editTxn && (
        <EditTxnModal
          txn={editTxn}
          accounts={accounts}
          onSave={(id, patch) => onUpdate && onUpdate(id, patch)}
          onClose={() => setEditTxn(null)}
        />
      )}
      {attachTxn && (
        <AttachmentModal
          txn={attachTxn}
          onSave={async (id, patch) => {
            if (onUpdate) await onUpdate(id, patch);
            // Keep modal open with updated txn data
            setAttachTxn(t => ({ ...t, ...patch }));
          }}
          onClose={() => setAttachTxn(null)}
        />
      )}

      {/* Filters */}
      <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap", alignItems: "center" }}>
        <select value={filterAcc} onChange={e => { setFilterAcc(e.target.value); setSelected(new Set()); }} style={FI}>
          <option value="">All Accounts</option>
          {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <select value={filterType} onChange={e => setFilterType(e.target.value)} style={FI}>
          <option value="">All Types</option>
          <option value="credit">Credit (In)</option>
          <option value="debit">Debit (Out)</option>
          <option value="conversion">Conversion</option>
        </select>
        <input type="month" value={filterMonth} onChange={e => setFilterMonth(e.target.value)} style={FI} />
        <input value={filterSearch} onChange={e => setFilterSearch(e.target.value)} placeholder="Search payee…" style={{ ...FI, minWidth: 140 }} />
        {(filterAcc || filterType || filterMonth || filterSearch) &&
          <button onClick={() => { setFilterAcc(""); setFilterType(""); setFilterMonth(""); setFilterSearch(""); }} style={{ ...FI, cursor: "pointer", color: C.gold, border: "none", background: "none" }}>✕ Clear</button>}
        <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
          <div style={{ display: "flex", gap: 2, background: C.card, borderRadius: 5, padding: 2, border: `1px solid ${C.border}` }}>
            {[["txnDate","By Date"],["entryDate","Recently Logged"]].map(([id,label]) => (
              <button key={id} onClick={() => setSortBy(id)} style={{ background: sortBy===id ? C.surface : "transparent", color: sortBy===id ? C.ink : C.inkMid, border: sortBy===id ? `1px solid ${C.border}` : "1px solid transparent", borderRadius: 4, padding: "4px 10px", cursor: "pointer", fontSize: 11, whiteSpace: "nowrap", transition: "all .15s" }}>{label}</button>
            ))}
          </div>
          <button onClick={exportCSV} style={{ background: C.ink, color: "#fff", border: "none", borderRadius: 6, padding: "6px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 5, whiteSpace: "nowrap" }}>
            ↓ {selected.size > 0 ? `Download ${selected.size}` : "Download All"}
          </button>
        </div>
      </div>

      {/* Summary bar */}
      {filtered.length > 0 && (
        <div style={{ display: "flex", gap: 16, marginBottom: 10, padding: "9px 14px", background: C.card, borderRadius: 8, fontSize: 12, flexWrap: "wrap", alignItems: "center" }}>
          <input type="checkbox" checked={allSelected} onChange={toggleAll} style={{ width: 14, height: 14, accentColor: C.ink, cursor: "pointer" }} title="Select all" />
          <span style={{ color: C.inkFaint }}>{filtered.length} entries{selected.size > 0 ? ` · ${selected.size} selected` : ""}</span>
          <span style={{ color: C.green }}>In: {inrFmt(totalIn)}</span>
          <span style={{ color: C.red }}>Out: {inrFmt(totalOut)}</span>
          <span style={{ color: C.ink, fontWeight: 600 }}>Net: {`${totalIn - totalOut >= 0 ? "+" : ""}${inrFmt(totalIn - totalOut)}`}</span>
          {runningBals && <span style={{ color: C.inkMid, marginLeft: "auto" }}>Closing: ₹{runningBals[runningBals.length-1]?.toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2})}</span>}
        </div>
      )}

      {filtered.length === 0
        ? <div style={{ textAlign: "center", padding: "40px 20px", color: C.inkFaint }}>No transactions match your filters.</div>
        : mob ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {filtered.map(t => {
              const isConv = t.type === "conversion";
              const cur    = t.currency || getAcc(t.accountTo || t.accountFrom)?.currency || "INR";
              const sym    = CUR_SYM[cur] || cur;
              const typeCol = t.type === "credit" ? C.green : t.type === "debit" ? C.red : C.blue;
              const typeBg  = t.type === "credit" ? C.greenBg : t.type === "debit" ? C.redBg : C.blueBg;
              const accLabel = isConv
                ? `${getAcc(t.accountFrom)?.name || "?"} → ${getAcc(t.accountTo)?.name || "?"}`
                : getAcc(t.accountTo || t.accountFrom)?.name || "—";
              const fmtNum = (n, currency) => {
                const abs = Math.abs(+n || 0);
                return currency === "JPY"
                  ? Math.round(abs).toLocaleString("en-IN")
                  : abs.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
              };
              const amtLabel = isConv
                ? `${sym}${fmtNum(t.amount, cur)} → ${CUR_SYM[getAcc(t.accountTo)?.currency] || ""}${fmtNum(+t.amount * +t.convRate, getAcc(t.accountTo)?.currency)}`
                : `${sym}${fmtNum(t.amount, cur)}`;
              return (
                <div key={t.id} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 12px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
                    <div style={{ fontWeight: 600, fontSize: 14, color: C.ink, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingRight: 8 }}>{t.payee || t.category || "—"}</div>
                    <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontWeight: 600, fontSize: 15, color: typeCol, flexShrink: 0 }}>{masked ? "••••" : amtLabel}</div>
                  </div>
                  <div style={{ fontSize: 11, color: C.inkMid, marginBottom: 5 }}>
                    {isBackdated(t) ? fmtDate(t.createdAt.slice(0,10)) : fmtDate(t.date)} · {accLabel}
                    {isBackdated(t) && <span style={{ marginLeft: 6, fontSize: 9, color: C.inkFaint }}>txn {fmtDate(t.date)}</span>}
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                    <span style={{ background: typeBg, color: typeCol, borderRadius: 4, padding: "2px 7px", fontSize: 10, fontWeight: 700, textTransform: "capitalize" }}>{t.type}</span>
                    {t.category && <span style={{ fontSize: 10, color: C.inkFaint }}>{t.category}</span>}
                    {t.classifiedAs
                      ? <button onClick={() => setClassifyTxn(t)} style={{ background: (CLASSIFY_META[t.classifiedAs]?.color || C.inkFaint) + "22", border: `1px solid ${CLASSIFY_META[t.classifiedAs]?.color || C.border}`, color: CLASSIFY_META[t.classifiedAs]?.color || C.inkFaint, borderRadius: 4, padding: "2px 8px", fontSize: 10, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>{CLASSIFY_META[t.classifiedAs]?.label || t.classifiedAs}</button>
                      : <button onClick={() => setClassifyTxn(t)} style={{ background: "none", border: `1px solid ${C.border}`, color: C.inkFaint, borderRadius: 4, padding: "2px 8px", fontSize: 10, cursor: "pointer", whiteSpace: "nowrap" }}>Classify</button>
                    }
                    <div style={{ marginLeft: "auto", display: "flex", gap: 4, alignItems: "center" }}>
                      <button onClick={() => setAttachTxn(t)} style={{ background: "none", border: "none", cursor: "pointer", color: (t.attachments?.length||t.attachmentUrl) ? C.amber : C.inkFaint, fontSize: 13, padding: "2px 5px" }} title="Attachments">📎{(t.attachments?.length > 1) && <span style={{ fontSize: 9 }}>{t.attachments.length}</span>}</button>
                      <button onClick={() => setEditTxn(t)} style={{ background: "none", border: "none", cursor: "pointer", color: C.inkFaint, fontSize: 13, padding: "2px 5px" }} title="Edit">✏</button>
                      {confirmDel === t.id
                        ? <div style={{ display: "flex", gap: 4 }}>
                          <button onClick={() => { onDelete(t.id); setConfirmDel(null); }} style={{ background: C.red, border: "none", color: "#fff", borderRadius: 4, padding: "3px 10px", fontSize: 11, cursor: "pointer" }}>Del</button>
                          <button onClick={() => setConfirmDel(null)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 14, color: C.inkFaint }}>✕</button>
                        </div>
                        : <button onClick={() => setConfirmDel(t.id)} style={{ background: "none", border: "none", cursor: "pointer", color: C.inkFaint, fontSize: 16, padding: "2px 6px" }}>&times;</button>
                      }
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: C.card, borderBottom: `1px solid ${C.border}` }}>
                  <th style={{ padding: "8px 8px 8px 14px", width: 28 }}>
                    <input type="checkbox" checked={allSelected} onChange={toggleAll} style={{ width: 13, height: 13, accentColor: C.ink, cursor: "pointer" }} />
                  </th>
                  {["Date", "Type", "Debit", "Credit", ...(filterAcc ? ["Balance"] : ["Account"]), "Payee / Source", "Category", "Notes", "Classify", ""].map(h => (
                    <th key={h} style={{ padding: "8px 12px", textAlign: "left", fontSize: 9, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .7, whiteSpace: "nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((t, rowIdx) => {
                  const isConv = t.type === "conversion";
                  const cur    = t.currency || getAcc(t.accountTo || t.accountFrom)?.currency || "INR";
                  const sym    = CUR_SYM[cur] || cur;
                  const typeCol = t.type === "credit" ? C.green : t.type === "debit" ? C.red : C.blue;
                  const typeBg  = t.type === "credit" ? C.greenBg : t.type === "debit" ? C.redBg : C.blueBg;
                  const accLabel = isConv
                    ? `${getAcc(t.accountFrom)?.name || "?"} → ${getAcc(t.accountTo)?.name || "?"}`
                    : getAcc(t.accountTo || t.accountFrom)?.name || "—";
                  const fmtNum = (n, currency) => {
                    const abs = Math.abs(+n || 0);
                    return currency === "JPY"
                      ? Math.round(abs).toLocaleString("en-IN")
                      : abs.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                  };
                  const isSelected = selected.has(t.id);
                  const runBal = runningBals ? runningBals[rowIdx] : null;

                  return (
                    <tr key={t.id} style={{ borderBottom: `1px solid ${C.border}`, background: isSelected ? C.card : "transparent" }}>
                      <td style={{ padding: "9px 8px 9px 14px" }}>
                        <input type="checkbox" checked={isSelected} onChange={() => toggleOne(t.id)} style={{ width: 13, height: 13, accentColor: C.ink, cursor: "pointer" }} />
                      </td>
                      <td style={{ padding: "9px 12px", color: C.inkMid, whiteSpace: "nowrap" }}>
                        <div>{isBackdated(t) ? fmtDate(t.createdAt.slice(0,10)) : fmtDate(t.date)}</div>
                        {isBackdated(t) && <div style={{ fontSize: 9, color: C.inkFaint, marginTop: 1 }}>txn {fmtDate(t.date)}</div>}
                      </td>
                      <td style={{ padding: "9px 12px" }}>
                        <span style={{ background: typeBg, color: typeCol, borderRadius: 4, padding: "2px 7px", fontSize: 10, fontWeight: 700, textTransform: "capitalize" }}>{t.type}</span>
                      </td>
                      {/* Debit */}
                      <td style={{ padding: "9px 12px", fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 14, fontWeight: 600, color: C.red, whiteSpace: "nowrap", textAlign: "right" }}>
                        {t.type === "debit" ? fmtNum(t.amount, cur) : ""}
                      </td>
                      {/* Credit */}
                      <td style={{ padding: "9px 12px", fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 14, fontWeight: 600, color: C.green, whiteSpace: "nowrap", textAlign: "right" }}>
                        {t.type === "credit" ? fmtNum(t.amount, cur) : isConv ? `${sym}${fmtNum(t.amount,cur)}→` : ""}
                      </td>
                      {/* Balance or Account */}
                      {filterAcc
                        ? <td style={{ padding: "9px 12px", fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 13, color: runBal < 0 ? C.red : C.inkMid, whiteSpace: "nowrap", textAlign: "right" }}>
                            {runBal != null ? fmtNum(runBal, cur) : ""}
                          </td>
                        : <td style={{ padding: "9px 12px", color: C.inkMid, fontSize: 11 }}>
                            {accLabel}
                          </td>
                      }
                      <td style={{ padding: "9px 12px", color: C.ink }}>{t.payee || "—"}</td>
                      <td style={{ padding: "9px 12px", color: C.inkFaint, fontSize: 11 }}>{t.category || "—"}</td>
                      <td style={{ padding: "9px 12px", color: C.inkFaint, fontSize: 11, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.notes || "—"}</td>
                      <td style={{ padding: "9px 12px" }}>
                        {t.classifiedAs
                          ? <button onClick={() => setClassifyTxn(t)} style={{
                              background: (CLASSIFY_META[t.classifiedAs]?.color || C.inkFaint) + "22",
                              border: `1px solid ${CLASSIFY_META[t.classifiedAs]?.color || C.border}`,
                              color: CLASSIFY_META[t.classifiedAs]?.color || C.inkFaint,
                              borderRadius: 4, padding: "2px 8px", fontSize: 10, fontWeight: 700,
                              cursor: "pointer", whiteSpace: "nowrap",
                            }}>{CLASSIFY_META[t.classifiedAs]?.label || t.classifiedAs}</button>
                          : <button onClick={() => setClassifyTxn(t)} style={{
                              background: "none", border: `1px solid ${C.border}`,
                              color: C.inkFaint, borderRadius: 4, padding: "2px 8px",
                              fontSize: 10, cursor: "pointer", whiteSpace: "nowrap",
                            }}>Classify</button>
                        }
                      </td>
                      <td style={{ padding: "9px 12px" }}>
                        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                          <button onClick={() => setAttachTxn(t)} title="Attachments" style={{ background: "none", border: "none", cursor: "pointer", color: (t.attachments?.length||t.attachmentUrl) ? C.amber : C.inkFaint, fontSize: 13, padding: "2px 4px", position: "relative" }}>
                            📎{(t.attachments?.length > 0) && <span style={{ position: "absolute", top: 0, right: 0, background: C.amber, color: "#fff", borderRadius: "50%", width: 12, height: 12, fontSize: 8, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>{t.attachments.length}</span>}
                          </button>
                          <button onClick={() => setEditTxn(t)} style={{ background: "none", border: "none", cursor: "pointer", color: C.inkFaint, fontSize: 12, padding: "2px 5px" }} title="Edit">✏</button>
                          {confirmDel === t.id
                            ? <div style={{ display: "flex", gap: 4 }}>
                              <button onClick={() => { onDelete(t.id); setConfirmDel(null); }} style={{ background: C.red, border: "none", color: "#fff", borderRadius: 4, padding: "2px 8px", fontSize: 11, cursor: "pointer" }}>Del</button>
                              <button onClick={() => setConfirmDel(null)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12, color: C.inkFaint }}>✕</button>
                            </div>
                            : <button onClick={() => setConfirmDel(t.id)} style={{ background: "none", border: "none", cursor: "pointer", color: C.inkFaint, fontSize: 14, padding: "2px 6px" }}>&times;</button>
                          }
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      }
    </div>
  );
}

// ─── Accounts & Rates Settings ────────────────────────────────────────────────
function AccountsSettings({ accounts, rates, balances, onUpdate, onUpdateRates, onFetchRates, fetchingRates, onReassignTxns }) {
  const masked = useMasked();
  const m = makeMask(masked);
  const [editRates,  setEditRates]  = useState(false);
  const [ratesDraft, setRatesDraft] = useState({ ...rates });
  const [addingAcc,  setAddingAcc]  = useState(false);
  const [newAcc, setNewAcc] = useState({ name: "", type: "bank", currency: "INR", openingBal: 0, active: true, creditLimit: 0, billingDueDay: 0 });
  const [deleteModal, setDeleteModal] = useState(null); // { acc, moveTo }
  const [moveToId, setMoveToId] = useState("");

  const FI = { background: C.surface, border: `1.5px solid ${C.border}`, color: C.ink, borderRadius: 6, padding: mob ? "10px 11px" : "7px 10px", fontSize: mob ? 16 : 13, fontFamily: "inherit" };

  const updateOpeningBal = (id, val)      => onUpdate(accounts.map(a => a.id === id ? { ...a, openingBal: +val } : a));
  const updateName       = (id, name)     => onUpdate(accounts.map(a => a.id === id ? { ...a, name } : a));
  const toggleActive     = id            => onUpdate(accounts.map(a => a.id === id ? { ...a, active: !a.active } : a));
  const [editingName, setEditingName] = useState(null); // account id being renamed
  const addAccount = () => {
    if (!newAcc.name || !newAcc.currency) return;
    onUpdate([...accounts, { ...newAcc, id: "fa-" + uid() }]);
    setAddingAcc(false);
    setNewAcc({ name: "", type: "bank", currency: "USD", openingBal: 0, active: true });
  };

  const cashAccs = accounts.filter(a => a.type === "cash");
  const bankAccs = accounts.filter(a => a.type === "bank");
  const cardAccs = accounts.filter(a => a.type === "credit_card");

  return (
    <div style={{ maxWidth: 720 }}>
      {/* Exchange Rates */}
      <div style={{ background: C.surface, border: `1.5px solid ${C.border}`, borderRadius: 10, padding: "18px 20px", marginBottom: 22 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14, color: C.ink }}>Exchange Rates to INR</div>
            {rates._fetchedAt && (
              <div style={{ fontSize: 10, color: C.inkFaint, marginTop: 2 }}>
                Live · updated {new Date(rates._fetchedAt).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
            <button onClick={() => onFetchRates()} disabled={fetchingRates} className="fbs" style={{ fontSize: 12, padding: "5px 12px", display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ display: "inline-block", animation: fetchingRates ? "spin 1s linear infinite" : "none" }}>🔄</span>
              {fetchingRates ? "Fetching…" : "Refresh"}
            </button>
            {editRates
              ? <div style={{ display: "flex", gap: 7 }}>
                <button onClick={() => { onUpdateRates(ratesDraft); setEditRates(false); }} className="fbp" style={{ fontSize: 12, padding: "5px 12px" }}>Save</button>
                <button onClick={() => { setRatesDraft({ ...rates }); setEditRates(false); }} className="fbs" style={{ fontSize: 12, padding: "5px 10px" }}>Cancel</button>
              </div>
              : <button onClick={() => { setRatesDraft({ ...rates }); setEditRates(true); }} className="fbs" style={{ fontSize: 12, padding: "5px 10px" }}>Edit</button>
            }
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {Object.entries(ratesDraft).filter(([cur])=>cur!=="._fetchedAt"&&!cur.startsWith("_")).map(([cur, rate]) => (
            <div key={cur} style={{ background: C.card, borderRadius: 7, padding: "8px 13px", display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: C.inkMid, minWidth: 32 }}>{cur}</span>
              <span style={{ fontSize: 11, color: C.inkFaint }}>=</span>
              {editRates
                ? <input type="number" value={rate} onChange={e => setRatesDraft(r => ({ ...r, [cur]: +e.target.value }))} style={{ ...FI, width: 80, padding: "3px 7px", fontSize: 13 }} />
                : <span style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 15, fontWeight: 600, color: C.ink }}>₹{rate}</span>
              }
            </div>
          ))}
        </div>
        <div style={{ fontSize: 10, color: C.inkFaint, marginTop: 8 }}>Auto-refreshes daily · mid-market rate via open.er-api.com · used for INR equivalents only</div>
      </div>

      {/* Accounts table */}
      {[["💵 Cash Accounts", cashAccs], ["🏦 Bank Accounts", bankAccs]].map(([label, accs]) => (
        <div key={label} style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .7, marginBottom: 10 }}>{label}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {accs.map(acc => {
              const bal = balances[acc.id] || 0;
              const sym = CUR_SYM[acc.currency] || acc.currency;
              return (
                <div key={acc.id} style={{ background: acc.active ? C.surface : C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: "12px 16px", display: "flex", alignItems: "center", gap: 14, flexWrap: mob ? "wrap" : "nowrap", opacity: acc.active ? 1 : .5 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {editingName === acc.id
                      ? <input
                          autoFocus
                          defaultValue={acc.name}
                          onBlur={e => { updateName(acc.id, e.target.value.trim() || acc.name); setEditingName(null); }}
                          onKeyDown={e => { if (e.key === "Enter") e.target.blur(); if (e.key === "Escape") setEditingName(null); }}
                          style={{ ...FI, fontSize: 13, fontWeight: 600, padding: "4px 8px", width: "100%" }}
                        />
                      : <div
                          onClick={() => setEditingName(acc.id)}
                          title="Click to rename"
                          style={{ fontWeight: 600, fontSize: 13, color: C.ink, cursor: "text", borderBottom: `1px dashed ${C.border}`, display: "inline-block", paddingBottom: 1 }}>
                          {acc.name}
                        </div>
                    }
                    <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 2 }}>{acc.currency} · {acc.type}</div>
                  </div>
                  <div style={{ textAlign: "right", minWidth: 120, flexShrink: 0 }}>
                    <div style={{ fontSize: 9, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .5 }}>Current Balance</div>
                    <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 17, fontWeight: 600, color: bal < 0 ? C.red : C.green }}>{m(sym + Math.abs(bal).toLocaleString("en-IN", { minimumFractionDigits: acc.currency === "JPY" ? 0 : 2, maximumFractionDigits: acc.currency === "JPY" ? 0 : 2 }))}</div>
                  </div>
                  <div style={{ minWidth: mob ? "100%" : 180, flexShrink: 0 }}>
                    <div style={{ fontSize: 9, color: C.inkFaint, marginBottom: 3, textTransform: "uppercase", letterSpacing: .5 }}>Opening Balance</div>
                    <input type="number" value={acc.openingBal || 0} onChange={e => updateOpeningBal(acc.id, e.target.value)} style={{ ...FI, width: "100%" }} step="0.01" />
                  </div>
                  <button onClick={() => toggleActive(acc.id)} style={{ background: "none", border: "none", cursor: "pointer", color: acc.active ? C.inkFaint : C.amber, fontSize: 12, padding: "4px 8px", flexShrink: 0 }}>
                    {acc.active ? "Hide" : "Show"}
                  </button>
                  <button onClick={() => { setDeleteModal(acc); setMoveToId(accounts.find(a=>a.id!==acc.id)?.id||""); }}
                    style={{ background: "none", border: "none", cursor: "pointer", color: C.red, fontSize: 12, padding: "4px 8px", flexShrink: 0, opacity: .7 }} title="Delete account">
                    🗑
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {/* Delete account modal */}
      {deleteModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", zIndex: 3000, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "#fff", borderRadius: 16, padding: 28, width: 380, maxWidth: "92vw", boxShadow: "0 20px 60px rgba(0,0,0,.2)" }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: "#111", marginBottom: 8 }}>Delete "{deleteModal.name}"?</div>
            <div style={{ fontSize: 13, color: "#666", marginBottom: 20 }}>
              All transactions in this account will be moved to another account.
            </div>
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#555", marginBottom: 6 }}>Move transactions to:</div>
              <select value={moveToId} onChange={e => setMoveToId(e.target.value)}
                style={{ width: "100%", padding: "9px 10px", borderRadius: 8, border: "1.5px solid #ddd", fontSize: 13, fontFamily: "inherit" }}>
                <option value="">— delete without moving —</option>
                {accounts.filter(a => a.id !== deleteModal.id).map(a => (
                  <option key={a.id} value={a.id}>{a.name} ({a.currency})</option>
                ))}
              </select>
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => setDeleteModal(null)}
                style={{ flex: 1, padding: "10px", borderRadius: 8, border: "1.5px solid #ddd", background: "#fff", fontSize: 13, cursor: "pointer" }}>Cancel</button>
              <button onClick={() => {
                if (moveToId && onReassignTxns) onReassignTxns(deleteModal.id, moveToId);
                onUpdate(accounts.filter(a => a.id !== deleteModal.id));
                setDeleteModal(null);
              }}
                style={{ flex: 1, padding: "10px", borderRadius: 8, border: "none", background: "#c0392b", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                Delete{moveToId ? " & Move" : ""}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Credit Cards */}
      {cardAccs.length > 0 && (
        <div style={{ background: C.surface, border: `1.5px solid ${C.border}`, borderRadius: 10, padding: "18px 20px", marginBottom: 22 }}>
          <div style={{ fontWeight: 600, fontSize: 14, color: C.ink, marginBottom: 12 }}>💳 Credit Cards</div>
          {cardAccs.map(a => {
            const bal = balances[a.id] || 0;
            const limit = a.creditLimit || 0;
            return (
              <div key={a.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500, color: C.ink }}>{a.name}</div>
                  <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 2 }}>
                    {limit > 0 ? `Limit: ₹${limit.toLocaleString("en-IN")}` : "No limit set"}
                    {a.billingDueDay ? ` · Due: ${a.billingDueDay}th` : ""}
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 16, fontWeight: 600, color: C.red }}>{m(fmtAmt(Math.max(0, bal), a.currency || "INR"))}</div>
                  <div style={{ fontSize: 10, color: C.inkFaint }}>outstanding</div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add Account */}
      {addingAcc ? (
        <div style={{ background: C.surface, border: `1.5px solid ${C.border}`, borderRadius: 10, padding: "18px 20px" }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>New Account</div>
          <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr" : "1fr 1fr", gap: 10, marginBottom: 12 }}>
            <div><FTag>Name</FTag><input value={newAcc.name} onChange={e => setNewAcc(a => ({ ...a, name: e.target.value }))} style={FI} placeholder="Account name" /></div>
            <div><FTag>Type</FTag><select value={newAcc.type} onChange={e => setNewAcc(a => ({ ...a, type: e.target.value }))} style={FI}><option value="cash">Cash</option><option value="bank">Bank Account</option><option value="credit_card">Credit Card</option></select></div>
            <div><FTag>Currency</FTag><select value={newAcc.currency} onChange={e => setNewAcc(a => ({ ...a, currency: e.target.value }))} style={FI}><option>INR</option><option>USD</option><option>EUR</option><option>JPY</option><option>GBP</option><option>AUD</option></select></div>
            <div><FTag>Opening Balance</FTag><input type="number" value={newAcc.openingBal} onChange={e => setNewAcc(a => ({ ...a, openingBal: +e.target.value }))} style={FI} step="0.01" /></div>
          </div>
                {newAcc.type === "credit_card" && (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
                    <div>
                      <FTag>Credit Limit</FTag>
                      <input type="number" value={newAcc.creditLimit || ""} onChange={e => setNewAcc(a => ({ ...a, creditLimit: +e.target.value }))} placeholder="e.g. 100000" style={FI} />
                    </div>
                    <div>
                      <FTag>Payment Due Day (of month)</FTag>
                      <input type="number" value={newAcc.billingDueDay || ""} onChange={e => setNewAcc(a => ({ ...a, billingDueDay: +e.target.value }))} placeholder="e.g. 15" min="1" max="31" style={FI} />
                    </div>
                  </div>
                )}
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={addAccount} className="fbp" style={{ fontSize: 12 }}>Add Account</button>
            <button onClick={() => setAddingAcc(false)} className="fbs" style={{ fontSize: 12 }}>Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setAddingAcc(true)} className="fbs" style={{ width: "100%", textAlign: "center" }}>+ Add Account</button>
      )}
    </div>
  );
}

// ─── PDF Progress Bar ─────────────────────────────────────────────────────────
const PDF_STEPS = ["Reading PDF", "Extracting transactions", "Comparing ledger", "Done"];
function PdfProgressBar({ step }) {
  const pct = step >= PDF_STEPS.length ? 100 : Math.round((step / (PDF_STEPS.length - 1)) * 100);
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.55)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "#fff", borderRadius: 20, padding: "40px 48px", width: 420, maxWidth: "90vw", boxShadow: "0 32px 80px rgba(0,0,0,.22)" }}>
        <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: 2, textTransform: "uppercase", color: "#111", marginBottom: 28 }}>Processing Statement</div>
        {/* Avant-garde bar */}
        <div style={{ position: "relative", height: 3, background: "#e8e5e0", borderRadius: 2, marginBottom: 28, overflow: "hidden" }}>
          <div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: `${pct}%`, background: "linear-gradient(90deg,#1a1a1a,#888)", borderRadius: 2, transition: "width .6s cubic-bezier(.4,0,.2,1)" }} />
          {/* shimmer */}
          <div style={{ position: "absolute", inset: 0, background: "linear-gradient(90deg,transparent 0%,rgba(255,255,255,.4) 50%,transparent 100%)", animation: "shimmer 1.4s infinite", backgroundSize: "200% 100%" }} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {PDF_STEPS.map((s, i) => {
            const done = step > i;
            const active = step === i;
            return (
              <div key={s} style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <div style={{ width: 22, height: 22, borderRadius: "50%", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: done ? "#1a1a1a" : active ? "transparent" : "transparent", border: done ? "none" : active ? "2px solid #1a1a1a" : "2px solid #d4d0ca", transition: "all .4s" }}>
                  {done
                    ? <svg width="11" height="8" viewBox="0 0 11 8"><path d="M1 4l3 3 6-6" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinecap="round"/></svg>
                    : active
                    ? <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#1a1a1a", animation: "pulse 1s infinite" }} />
                    : null}
                </div>
                <span style={{ fontSize: 13, color: done ? "#1a1a1a" : active ? "#1a1a1a" : "#aaa", fontWeight: active || done ? 600 : 400, transition: "color .3s" }}>{s}</span>
                {active && <span style={{ fontSize: 11, color: "#888", marginLeft: "auto" }}>…</span>}
                {done && <span style={{ fontSize: 11, color: "#aaa", marginLeft: "auto" }}>✓</span>}
              </div>
            );
          })}
        </div>
        <style>{`@keyframes shimmer{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}} @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}`}</style>
      </div>
    </div>
  );
}

// ─── PDF Import Modal ─────────────────────────────────────────────────────────
function PdfImportModal({ txns, acc, accTxns = [], onAdd, onClose, openingBalance = null, closingBalance = null }) {
  const CUR = acc?.currency || "INR";
  const sym = { INR: "₹", USD: "$", EUR: "€", JPY: "¥", GBP: "£", AUD: "A$" }[CUR] || CUR;
  const f2 = n => (+n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtAmt = n => sym + f2(Math.abs(n));

  // For each PDF txn, check if it already exists in the ledger (by date ±2 days + amount match)
  const enriched = txns.map(t => {
    const amt = +t.amount;
    const tDate = new Date(t.date).getTime();
    const matched = accTxns.some(l => {
      const diff = Math.abs(new Date(l.date).getTime() - tDate) / 86400000;
      return diff <= 2 && Math.abs(+l.amount - amt) < 0.5 && l.type === t.type;
    });
    return { ...t, matched };
  });

  // Default: select only unmatched transactions
  const [sel, setSel] = useState(() => new Set(enriched.map((t, i) => t.matched ? -1 : i).filter(i => i >= 0)));
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  const newCount = enriched.filter(t => !t.matched).length;
  const matchedCount = enriched.length - newCount;

  const toggle = i => setSel(s => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; });
  const toggleAll = () => {
    const newIdxs = enriched.map((t, i) => t.matched ? -1 : i).filter(i => i >= 0);
    setSel(sel.size === newIdxs.length ? new Set() : new Set(newIdxs));
  };

  // ── Running balances ──────────────────────────────────────────────────────
  // Bank running balance (from statement opening balance)
  const bankRunning = [];
  {
    let b = openingBalance != null ? +openingBalance : null;
    enriched.forEach(t => {
      if (b != null) b += t.type === "credit" ? +t.amount : -(+t.amount);
      bankRunning.push(b);
    });
  }

  // Statement-period summary. This import should reconcile the statement's
  // own opening and closing balances, not compare May against today's ERP cash.
  const stmtStartDate = enriched[0]?.date || "";
  const stmtEndDate = enriched[enriched.length - 1]?.date || "";
  const bankClosing = closingBalance ?? bankRunning[bankRunning.length - 1];
  const coveredClosing = (() => {
    if (openingBalance == null) return null;
    let b = +openingBalance;
    enriched.forEach((t, i) => {
      if (t.matched || sel.has(i)) b += t.type === "credit" ? +t.amount : -(+t.amount);
    });
    return +b.toFixed(2);
  })();
  const importDiff = bankClosing != null && coveredClosing != null ? +(bankClosing - coveredClosing).toFixed(2) : null;
  const statementDiff = bankClosing != null && bankRunning[bankRunning.length - 1] != null ? +(bankClosing - bankRunning[bankRunning.length - 1]).toFixed(2) : null;

  const handleAdd = async () => {
    setSaving(true);
    const toAdd = enriched.filter((_, i) => sel.has(i)).map(t => ({
      id: uid(), type: t.type, amount: String(t.amount), currency: CUR,
      accountFrom: t.type === "debit"  ? acc.id : null,
      accountTo:   t.type === "credit" ? acc.id : null,
      payee: t.description || "", category: t.category || "Other",
      date: t.date || today(), notes: "Imported from bank statement PDF",
      createdAt: new Date().toISOString(),
    }));
    await onAdd(toAdd);
    setSaving(false);
    setDone(true);
    setTimeout(onClose, 1400);
  };

  const badge = (text, color, bg) => (
    <span style={{ fontSize: 10, background: bg, color, borderRadius: 4, padding: "1px 6px", fontWeight: 700, flexShrink: 0, whiteSpace: "nowrap" }}>{text}</span>
  );

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", zIndex: 2000, display: "flex", alignItems: "flex-end", justifyContent: "center" }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: "#fff", borderRadius: "20px 20px 0 0", width: "100%", maxWidth: 760, maxHeight: "92vh", display: "flex", flexDirection: "column", boxShadow: "0 -24px 80px rgba(0,0,0,.25)", animation: "slideUp .3s cubic-bezier(.4,0,.2,1)" }}>
        <style>{`@keyframes slideUp{from{transform:translateY(100%)}to{transform:translateY(0)}}`}</style>

        {/* ── Header ── */}
        <div style={{ padding: "20px 24px 0", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#111", letterSpacing: -.3 }}>
                {done ? "✓ Added to ledger" : "Bank Statement Reconciliation"}
              </div>
              <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>{acc?.name} · {CUR} · {txns.length} transactions</div>
            </div>
            <button onClick={onClose} style={{ background: "#f5f3f0", border: "none", borderRadius: "50%", width: 32, height: 32, fontSize: 16, cursor: "pointer", color: "#555", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>×</button>
          </div>

          {/* ── Balance summary cards ── */}
          {!done && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 14 }}>
              {[
                { label: "Statement Opening", val: openingBalance, sub: stmtStartDate || null },
                { label: "Statement Closing", val: bankClosing, sub: stmtEndDate || null },
                { label: "After Selected Import", val: coveredClosing, sub: importDiff != null ? `Remaining ${importDiff >= 0 ? "+" : ""}${sym}${f2(importDiff)}` : null, subCol: importDiff == null || Math.abs(importDiff) < 1 ? "#2d7a4f" : "#c0392b" },
                { label: "Statement Check", val: statementDiff == null ? null : statementDiff, sub: statementDiff == null ? null : Math.abs(statementDiff) < 1 ? "Opening + rows = closing" : "Statement balances differ", subCol: statementDiff == null || Math.abs(statementDiff) < 1 ? "#2d7a4f" : "#c0392b" },
              ].map(({ label, val, sub, subCol }) => (
                <div key={label} style={{ background: "#faf9f7", borderRadius: 10, padding: "10px 12px", border: "1px solid #ede9e3" }}>
                  <div style={{ fontSize: 9, fontWeight: 700, color: "#aaa", textTransform: "uppercase", letterSpacing: .5, marginBottom: 4 }}>{label}</div>
                  <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 16, fontWeight: 700, color: "#111" }}>
                    {val != null ? sym + f2(val) : "—"}
                  </div>
                  {sub && <div style={{ fontSize: 10, fontWeight: 700, color: subCol, marginTop: 2 }}>{sub}</div>}
                </div>
              ))}
            </div>
          )}

          {/* ── Column headers ── */}
          {!done && (
            <div style={{ display: "grid", gridTemplateColumns: "28px 1fr 90px 90px 110px 76px", gap: 0, padding: "6px 8px", background: "#f5f3f0", borderRadius: "8px 8px 0 0", borderBottom: "1px solid #ede9e3" }}>
              <div style={{ display: "flex", alignItems: "center" }}>
                <input type="checkbox"
                  checked={sel.size > 0 && sel.size === newCount}
                  ref={el => { if (el) el.indeterminate = sel.size > 0 && sel.size < newCount; }}
                  onChange={toggleAll}
                  style={{ width: 13, height: 13, accentColor: "#1a1a1a", cursor: "pointer" }} />
              </div>
              {["Date / Description", "Debit", "Credit", "Bank Bal", "Status"].map(h => (
                <div key={h} style={{ fontSize: 9, fontWeight: 700, color: "#aaa", textTransform: "uppercase", letterSpacing: .5, textAlign: "right", padding: "0 4px" }}>{h === "Date / Description" ? <span style={{ textAlign: "left", display: "block" }}>{h}</span> : h}</div>
              ))}
            </div>
          )}
        </div>

        {/* ── Transaction rows ── */}
        <div style={{ overflowY: "auto", flex: 1 }}>
          {enriched.map((t, i) => {
            const isCredit = t.type === "credit";
            const checked  = sel.has(i);
            const isNew    = !t.matched;
            const bankBal  = bankRunning[i];
            const rowBg    = done ? "#fff" : checked ? "#fafaf8" : t.matched ? "#f9fdfb" : "#fff";

            return (
              <div key={i} onClick={() => !done && isNew && toggle(i)}
                style={{ display: "grid", gridTemplateColumns: "28px 1fr 90px 90px 110px 76px", gap: 0, padding: "10px 8px", borderBottom: "1px solid #f5f3f0", background: rowBg, cursor: !done && isNew ? "pointer" : "default", transition: "background .12s", alignItems: "center" }}>

                {/* Checkbox */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                  {done ? <span style={{ color: "#2d7a4f", fontSize: 13 }}>✓</span>
                    : t.matched ? <span style={{ fontSize: 12, color: "#2d7a4f" }}>✓</span>
                    : <input type="checkbox" checked={checked} readOnly style={{ width: 13, height: 13, accentColor: "#1a1a1a", cursor: "pointer" }} />}
                </div>

                {/* Description */}
                <div style={{ minWidth: 0, paddingRight: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 500, color: "#111", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 5 }}>
                    {t.description}
                    {t.matched && !done && badge("✓ ERP", "#1a6b40", "#e6f5ed")}
                    {!t.matched && !done && badge("NEW", "#8a4a0a", "#fff3e0")}
                  </div>
                  <div style={{ fontSize: 10, color: "#bbb", marginTop: 1 }}>{t.date}{t.category ? ` · ${t.category}` : ""}</div>
                </div>

                {/* Debit */}
                <div style={{ textAlign: "right", fontSize: 12, fontWeight: 600, color: "#c0392b", padding: "0 4px" }}>
                  {!isCredit ? f2(t.amount) : ""}
                </div>

                {/* Credit */}
                <div style={{ textAlign: "right", fontSize: 12, fontWeight: 600, color: "#2d7a4f", padding: "0 4px" }}>
                  {isCredit ? f2(t.amount) : ""}
                </div>

                {/* Bank balance */}
                <div style={{ textAlign: "right", fontSize: 12, color: "#333", fontFamily: "'Cormorant Garamond',Georgia,serif", padding: "0 4px" }}>
                  {bankBal != null ? sym + f2(bankBal) : "—"}
                </div>

                {/* Status */}
                <div style={{ textAlign: "right", fontSize: 11, fontWeight: 700, color: t.matched ? "#2d7a4f" : checked ? "#111" : "#aaa", padding: "0 4px" }}>
                  {t.matched ? "In ERP" : checked ? "Import" : "Skip"}
                </div>
              </div>
            );
          })}
        </div>

        {/* ── Footer ── */}
        {!done && (
          <div style={{ padding: "14px 20px", borderTop: "1px solid #ede9e3", flexShrink: 0, background: "#fff", display: "flex", gap: 10, alignItems: "center" }}>
            <div style={{ flex: 1, fontSize: 12, color: "#888" }}>
              {sel.size > 0
                ? <>{sel.size} selected · {matchedCount} already in ledger{importDiff != null ? ` · ${Math.abs(importDiff) < 1 ? "statement closes" : `remaining ${importDiff >= 0 ? "+" : ""}${sym}${f2(importDiff)}`}` : ""}</>
                : <>{newCount} new · {matchedCount} already matched</>}
            </div>
            <button onClick={handleAdd} disabled={saving || sel.size === 0}
              style={{ background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 10, padding: "11px 24px", fontSize: 13, fontWeight: 700, cursor: sel.size === 0 ? "not-allowed" : "pointer", opacity: sel.size === 0 ? .35 : 1, whiteSpace: "nowrap" }}>
              {saving ? "Adding…" : sel.size === 0 ? "Nothing to add" : `Add ${sel.size} to ledger →`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Expense Classify Split View ─────────────────────────────────────────────
const EXPENSE_CATS = [
  { label: "Food & Dining",   icon: "🍽️", color: "#e74c3c" },
  { label: "Groceries",       icon: "🛒", color: "#27ae60" },
  { label: "Shopping",        icon: "👜", color: "#9b59b6" },
  { label: "Transport",       icon: "🚗", color: "#3498db" },
  { label: "Utilities",       icon: "💡", color: "#f39c12" },
  { label: "Entertainment",   icon: "🎭", color: "#e67e22" },
  { label: "Staff / Salary",  icon: "👤", color: "#1abc9c" },
  { label: "Marketing / Ads", icon: "📢", color: "#e91e63" },
  { label: "Shipping",        icon: "📦", color: "#607d8b" },
  { label: "Health",          icon: "🏥", color: "#4caf50" },
  { label: "Software / Subs", icon: "💻", color: "#2196f3" },
  { label: "Bank Charges",    icon: "🏦", color: "#795548" },
  { label: "Transfer",        icon: "💸", color: "#ff5722" },
  { label: "Business",        icon: "💼", color: "#455a64" },
  { label: "Income",          icon: "💰", color: "#16a085" },
  { label: "Other",           icon: "📋", color: "#9e9e9e" },
];
const METHOD_CATS = new Set(["UPI","NEFT","IMPS","ATM","Transfer","Bank Charges","Interest","Salary"]);
const isUnclassified = t => !t.category || t.category === "Other" || METHOD_CATS.has(t.category);

function ExpenseSplitView({ transactions, accounts, onUpdate }) {
  const [selected,     setSelected]     = useState(null);
  const [tab,          setTab]          = useState("unclassified");
  const [filterAcc,    setFilterAcc]    = useState("");
  const [filterMonth,  setFilterMonth]  = useState("");
  const [customCat,    setCustomCat]    = useState("");
  const [saving,       setSaving]       = useState(false);
  const listRef = useRef();

  const months = [...new Set(transactions.map(t => t.date?.slice(0,7)).filter(Boolean))].sort().reverse();
  const getAcc = id => accounts.find(a => a.id === id);

  const filtered = [...transactions]
    .filter(t => {
      if (filterAcc && t.accountFrom !== filterAcc && t.accountTo !== filterAcc) return false;
      if (filterMonth && !(t.date||"").startsWith(filterMonth)) return false;
      if (tab === "unclassified" && !isUnclassified(t)) return false;
      return true;
    })
    .sort((a, b) => {
      if (tab === "unclassified") {
        const au = isUnclassified(a), bu = isUnclassified(b);
        if (au !== bu) return au ? -1 : 1;
      }
      return b.date.localeCompare(a.date);
    });

  const unclassCount = transactions.filter(isUnclassified).length;
  const selIdx   = filtered.findIndex(t => t.id === selected);
  const selTxn   = transactions.find(t => t.id === selected);

  // Auto-select first on load / tab change
  useEffect(() => {
    if (filtered.length > 0 && (!selected || !filtered.find(t => t.id === selected))) {
      setSelected(filtered[0].id);
    }
  }, [tab, filterAcc, filterMonth]);

  const goTo = idx => {
    if (idx >= 0 && idx < filtered.length) setSelected(filtered[idx].id);
  };

  const classify = async (cat) => {
    if (!selTxn || saving) return;
    setSaving(true);
    await onUpdate(selTxn.id, { category: cat });
    setSaving(false);
    // Auto-advance to next
    const next = selIdx + 1;
    if (next < filtered.length) setSelected(filtered[next].id);
  };

  const FI = { background: C.surface, border: `1px solid ${C.border}`, color: C.ink, borderRadius: 6, padding: "5px 9px", fontSize: 12, fontFamily: "inherit" };

  return (
    <div style={{ display: "flex", height: "calc(100vh - 148px)", borderRadius: 14, border: `1px solid ${C.border}`, overflow: "hidden", background: C.surface }}>

      {/* ── LEFT: list ── */}
      <div style={{ width: mob ? "100%" : 340, flexShrink: 0, borderRight: `1px solid ${C.border}`, display: "flex", flexDirection: "column", background: C.surface }}>
        {/* Filters */}
        <div style={{ padding: "12px 12px 10px", borderBottom: `1px solid ${C.border}`, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", gap: 6 }}>
            {[
              { id: "unclassified", label: `Unclassified${unclassCount > 0 ? ` (${unclassCount})` : ""}` },
              { id: "all",          label: "All" },
            ].map(t => (
              <button key={t.id} onClick={() => setTab(t.id)} style={{ fontSize: 11, padding: "5px 12px", borderRadius: 20, border: "none", cursor: "pointer", fontWeight: 600, background: tab === t.id ? C.ink : C.card, color: tab === t.id ? "#fff" : C.inkMid }}>{t.label}</button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <select value={filterMonth} onChange={e => setFilterMonth(e.target.value)} style={{ ...FI, flex: 1 }}>
              <option value="">All months</option>
              {months.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
            <select value={filterAcc} onChange={e => setFilterAcc(e.target.value)} style={{ ...FI, flex: 1 }}>
              <option value="">All accounts</option>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
        </div>

        {/* Transaction list */}
        <div ref={listRef} style={{ flex: 1, overflowY: "auto" }}>
          {filtered.length === 0 && (
            <div style={{ padding: "40px 20px", textAlign: "center", color: C.inkFaint, fontSize: 13 }}>
              {tab === "unclassified" ? "🎉 All classified!" : "No transactions"}
            </div>
          )}
          {filtered.map((t, i) => {
            const isSel = t.id === selected;
            const unclass = isUnclassified(t);
            const cat = EXPENSE_CATS.find(c => c.label === t.category);
            const accName = getAcc(t.accountFrom || t.accountTo)?.name || "";
            return (
              <div key={t.id} onClick={() => setSelected(t.id)}
                style={{ padding: "10px 12px", borderBottom: `1px solid ${C.border}`, cursor: "pointer", transition: "background .1s",
                  background: isSel ? "#eeedf8" : C.surface,
                  borderLeft: `3px solid ${isSel ? "#6366f1" : "transparent"}` }}>
                <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {t.payee || t.notes || "—"}
                    </div>
                    <div style={{ fontSize: 10, color: C.inkFaint, marginTop: 1 }}>{fmtDate(t.date)} · {accName}</div>
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: t.type === "credit" ? C.green : C.red }}>
                      {t.type === "credit" ? "+" : "−"}₹{(+t.amount).toLocaleString("en-IN")}
                    </div>
                    <div style={{ fontSize: 10, marginTop: 2, color: cat ? cat.color : C.inkFaint, fontWeight: cat ? 600 : 400 }}>
                      {cat ? `${cat.icon} ${t.category}` : unclass ? "· unclassified" : t.category}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── RIGHT: classify panel ── */}
      {!mob && (
        <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px", background: "#fafaf8" }}>
          {!selTxn ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: C.inkFaint, fontSize: 14 }}>
              Select a transaction to classify
            </div>
          ) : (
            <>
              {/* Nav */}
              <div style={{ display: "flex", gap: 8, marginBottom: 20, alignItems: "center" }}>
                <button onClick={() => goTo(selIdx - 1)} disabled={selIdx <= 0} style={{ ...FI, cursor: selIdx > 0 ? "pointer" : "default", opacity: selIdx > 0 ? 1 : .4 }}>← Prev</button>
                <button onClick={() => goTo(selIdx + 1)} disabled={selIdx >= filtered.length - 1} style={{ ...FI, cursor: selIdx < filtered.length - 1 ? "pointer" : "default", opacity: selIdx < filtered.length - 1 ? 1 : .4 }}>Next →</button>
                <div style={{ fontSize: 11, color: C.inkFaint, marginLeft: "auto" }}>{selIdx + 1} / {filtered.length}</div>
              </div>

              {/* Txn card */}
              <div style={{ background: C.surface, borderRadius: 14, padding: "18px 20px", marginBottom: 24, border: `1px solid ${C.border}` }}>
                <div style={{ fontSize: 11, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .6, marginBottom: 6 }}>
                  {fmtDate(selTxn.date)} · {getAcc(selTxn.accountFrom || selTxn.accountTo)?.name || ""}
                </div>
                <div style={{ fontSize: 14, fontWeight: 700, color: C.ink, marginBottom: 10, wordBreak: "break-word" }}>
                  {selTxn.payee || selTxn.notes || "—"}
                </div>
                <div style={{ fontSize: 32, fontWeight: 800, color: selTxn.type === "credit" ? C.green : C.red, fontFamily: "'Cormorant Garamond', serif" }}>
                  {selTxn.type === "credit" ? "+" : "−"}₹{(+selTxn.amount).toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                </div>
                {selTxn.category && !isUnclassified(selTxn) && (
                  <div style={{ marginTop: 10, fontSize: 12, background: C.card, display: "inline-block", padding: "3px 10px", borderRadius: 20, color: C.inkMid }}>
                    {EXPENSE_CATS.find(c => c.label === selTxn.category)?.icon || "📋"} {selTxn.category}
                  </div>
                )}
              </div>

              {/* Category grid */}
              <div style={{ fontSize: 10, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .7, marginBottom: 10 }}>Pick category</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 16 }}>
                {EXPENSE_CATS.map(cat => {
                  const active = selTxn.category === cat.label;
                  return (
                    <button key={cat.label} onClick={() => classify(cat.label)} disabled={saving}
                      style={{ padding: "10px 6px", borderRadius: 10, border: `1.5px solid ${active ? cat.color : C.border}`, background: active ? cat.color + "22" : C.surface, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 5, transition: "all .12s", opacity: saving ? .6 : 1 }}>
                      <span style={{ fontSize: 22 }}>{cat.icon}</span>
                      <span style={{ fontSize: 10, fontWeight: 600, color: active ? cat.color : C.ink, textAlign: "center", lineHeight: 1.2 }}>{cat.label}</span>
                    </button>
                  );
                })}
              </div>

              {/* Custom */}
              <div style={{ display: "flex", gap: 8 }}>
                <input value={customCat} onChange={e => setCustomCat(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && customCat.trim()) { classify(customCat.trim()); setCustomCat(""); } }}
                  placeholder="Custom category…"
                  style={{ flex: 1, fontSize: 13, padding: "9px 12px", borderRadius: 9, border: `1.5px solid ${C.border}`, background: C.surface, color: C.ink, fontFamily: "inherit" }} />
                <button onClick={() => { if (customCat.trim()) { classify(customCat.trim()); setCustomCat(""); } }}
                  style={{ padding: "9px 18px", borderRadius: 9, border: "none", background: C.ink, color: "#fff", cursor: "pointer", fontWeight: 600, fontSize: 13 }}>Save</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Reconcile View ───────────────────────────────────────────────────────────
// ─── CSV parser helpers ───────────────────────────────────────────────────────
function parseCSVRow(line) {
  const result = []; let cur = ""; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (inQ && line[i+1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
    else if (ch === ',' && !inQ) { result.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  result.push(cur.trim());
  return result;
}
function parseDateStr(s) {
  if (!s) return null;
  s = s.trim();
  // DD/MM/YYYY or DD-MM-YYYY
  let m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  // YYYY-MM-DD
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return s;
  // DD-MMM-YYYY (e.g. 21-Apr-2026)
  const months = {jan:"01",feb:"02",mar:"03",apr:"04",may:"05",jun:"06",jul:"07",aug:"08",sep:"09",oct:"10",nov:"11",dec:"12"};
  m = s.match(/^(\d{1,2})[\/\-]([A-Za-z]{3})[\/\-](\d{4})$/);
  if (m && months[m[2].toLowerCase()]) return `${m[3]}-${months[m[2].toLowerCase()]}-${m[1].padStart(2,'0')}`;
  // DD/MM/YY or DD-MM-YY. Indian bank statements commonly use this format.
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})$/);
  if (m) { const yr = +m[3] > 50 ? `19${m[3]}` : `20${m[3]}`; return `${yr}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`; }
  return null;
}
function parseAmtStr(s) {
  if (!s || !s.trim()) return null;
  const n = parseFloat(s.replace(/[, ₹$]/g, ''));
  return isNaN(n) ? null : Math.abs(n);
}
function parseBankCsv(text, accName = "") {
  const rawLines = text.split(/\r?\n/);
  // Find header row — scan first 40 lines (bank statements have many info rows at top)
  let headerIdx = -1, headers = [], rawHeaders = [];
  for (let i = 0; i < Math.min(rawLines.length, 40); i++) {
    const cells = parseCSVRow(rawLines[i]);
    if (cells.length < 3) continue; // need at least a few columns
    // Strip all non-alpha chars for matching, but keep spaces
    const low = cells.map(c => c.toLowerCase().replace(/[^a-z0-9 ]/g," ").replace(/\s+/g," ").trim());
    const hasDate = low.some(c => c === 'date' || c.startsWith('date') || c.includes(' date') || c.includes('txn') || c.includes('value dt'));
    const hasAmt  = low.some(c => c.includes('debit') || c.includes('credit') || c.includes('withdrawal') || c.includes('deposit') || c.includes('dr') || c.includes('cr'));
    if (hasDate && hasAmt) {
      headerIdx = i; headers = low; rawHeaders = cells; break;
    }
  }
  if (headerIdx === -1) {
    // Show first few lines to help debug
    const preview = rawLines.slice(0, 6).map((l,i) => `row${i}: ${l.slice(0,80)}`).join('\n');
    throw new Error(`Could not find header row (scanned 40 rows).\n\nFirst rows:\n${preview}`);
  }
  const find = (...keys) => headers.findIndex(h => keys.some(k => h.includes(k)));
  let dateCol   = find('txn date','transaction date','value dt','value date','tran date');
  if (dateCol === -1) dateCol = find('date');
  let descCol   = find('narration','description','particulars','remarks','transaction details','details','chq ref');
  if (descCol === -1) descCol = find('detail', 'ref', 'particular');
  let debitCol  = find('withdrawal amt','withdrawal','debit amt','debit amount','dr amt','money out','debit');
  let creditCol = find('deposit amt','deposit','credit amt','credit amount','cr amt','money in','credit');
  let balCol    = find('closing balance','closing bal','running balance','balance');
  if (dateCol === -1) throw new Error(`No date column found.\nHeaders detected: ${rawHeaders.join(' | ')}`);
  const transactions = [];
  for (let i = headerIdx + 1; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (!line.trim()) continue;
    const cells = parseCSVRow(line);
    if (!cells[dateCol]?.trim()) continue;
    const date = parseDateStr(cells[dateCol]);
    if (!date) continue;
    const debit  = debitCol  >= 0 ? parseAmtStr(cells[debitCol])  : null;
    const credit = creditCol >= 0 ? parseAmtStr(cells[creditCol]) : null;
    const balance = balCol >= 0 ? parseAmtStr(cells[balCol]) : null;
    const description = descCol >= 0 ? (cells[descCol] || "").trim() : (cells[1] || "").trim();
    if ((debit === null || debit === 0) && (credit === null || credit === 0)) continue;
    const isCredit = (credit !== null && credit > 0) && (debit === null || debit === 0);
    const type = isCredit ? "credit" : "debit";
    const amount = isCredit ? credit : (debit || 0);
    // Guess category from description
    const d = description.toLowerCase();
    let category = "Other";
    if (d.includes("upi")) category = "UPI";
    else if (d.includes("neft")) category = "NEFT";
    else if (d.includes("imps")) category = "IMPS";
    else if (d.includes("atm")) category = "ATM";
    else if (d.includes("interest") || d.includes("int ")) category = "Interest";
    else if (d.includes("charge") || d.includes("fee") || d.includes("gst")) category = "Bank Charges";
    else if (d.includes("salary") || d.includes("sal ")) category = "Salary";
    else if (d.includes("transfer") || d.includes("trf")) category = "Transfer";
    transactions.push({ date, description, type, amount, balance, category });
  }
  if (!transactions.length) throw new Error("No transactions found in CSV. Check that the file has Date, Debit/Credit columns.");
  // Sort oldest-first regardless of how the bank exported (newest-first or oldest-first)
  transactions.sort((a, b) => a.date.localeCompare(b.date));
  // Compute opening balance from the FIRST (oldest) transaction
  const first = transactions[0];
  const last  = transactions[transactions.length - 1];
  const openingBalance = (first.balance != null)
    ? +(first.type === "debit" ? first.balance + first.amount : first.balance - first.amount).toFixed(2)
    : null;
  const closingBalance = last.balance ?? null;
  return { transactions, opening_balance: openingBalance, closing_balance: closingBalance };
}
// ─────────────────────────────────────────────────────────────────────────────

function ReconcileView({ accounts, transactions, onAddTxns, company }) {
  const [selectedAcc, setSelectedAcc] = useState(accounts[0]?.id || "");
  const [statement,   setStatement]   = useState("");
  const [analysis,    setAnalysis]    = useState("");
  const [analyzing,   setAnalyzing]   = useState(false);
  const [pdfLoading,  setPdfLoading]  = useState(false);
  const [pdfStep,     setPdfStep]     = useState(0);
  const [pdfName,     setPdfName]     = useState("");
  const [missing,     setMissing]     = useState([]);
  const [adding,      setAdding]      = useState({});
  const [added,       setAdded]       = useState({});
  const [pdfModal,    setPdfModal]    = useState(null); // array of txns from PDF
  const [pdfError,    setPdfError]    = useState("");
  const pdfRef = useRef();
  const csvRef = useRef();

  const acc     = accounts.find(a => a.id === selectedAcc);
  const accTxns = transactions.filter(t => t.accountFrom === selectedAcc || t.accountTo === selectedAcc).sort((a, b) => a.date.localeCompare(b.date));

  const dayOfMonth = new Date().getDate();
  const showReminder = dayOfMonth >= 8 && dayOfMonth <= 15;

  const FI = { background: C.surface, border: `1.5px solid ${C.border}`, color: C.ink, borderRadius: 6, padding: "7px 10px", fontSize: mob ? 16 : 13, fontFamily: "inherit" };

  // ── Upload PDF → progress bar → modal with structured transactions ──────────
  const handlePdf = async (file) => {
    if (!file) return;
    setPdfLoading(true);
    setPdfStep(0);
    setPdfName(file.name);
    try {
      // Step 0: Render PDF pages as images using PDF.js
      setPdfStep(0);
      const arrayBuffer = await file.arrayBuffer();
      const pdfjsLib = await import("pdfjs-dist");
      pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      const images = [];
      const maxPages = Math.min(pdf.numPages, 6); // cap at 6 pages
      for (let p = 1; p <= maxPages; p++) {
        const page = await pdf.getPage(p);
        const scale = 1.8; // high enough to read small text
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width  = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        // JPEG at 0.82 quality — readable but compact
        images.push(canvas.toDataURL("image/jpeg", 0.82).split(",")[1]);
      }
      console.log(`[PDF] Rendered ${images.length} page(s) as images`);

      // Step 1: Send images to AI (vision)
      setPdfStep(1);
      const resp = await fetch("/api/parse-pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images, account: acc?.name }),
      });

      // Step 2: Process response
      setPdfStep(2);
      const raw = await resp.text();
      let data;
      try { data = JSON.parse(raw); } catch { throw new Error(`Server error: ${raw.slice(0, 400)}`); }
      if (!resp.ok || data.error) throw new Error(data.error + (data.raw ? `\n\nAI returned:\n${data.raw}` : ""));
      if (!data.transactions?.length) throw new Error("No transactions found.\n\n" + JSON.stringify(data).slice(0, 400));

      // Step 3: Done
      setPdfStep(3);
      await new Promise(r => setTimeout(r, 500));
      setPdfModal({ txns: data.transactions, openingBalance: data.opening_balance ?? null, closingBalance: data.closing_balance ?? null });
    } catch (e) {
      setPdfError(e.message);
      console.error("[PDF] Error:", e.message);
    }
    setPdfLoading(false);
  };

  // ── Upload CSV / Excel ────────────────────────────────────────────────────
  const handleCsv = async (file) => {
    if (!file) return;
    setPdfError("");
    setPdfName(file.name);
    try {
      let text;
      const isExcel = /\.(xlsx|xls|ods)$/i.test(file.name) || file.type.includes("spreadsheet") || file.type.includes("excel");
      if (isExcel) {
        const XLSX = await import("xlsx");
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: "array", cellDates: true, dateNF: "yyyy-mm-dd" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        text = XLSX.utils.sheet_to_csv(ws, { blankrows: false });
      } else {
        text = await file.text();
      }
      const data = parseBankCsv(text, acc?.name || "");
      if (!data.transactions?.length) throw new Error("No transactions found.");
      setPdfModal({ txns: data.transactions, openingBalance: data.opening_balance ?? null, closingBalance: data.closing_balance ?? null });
    } catch (e) {
      setPdfError(e.message);
      setPdfName("");
    }
  };

  // ── Reconcile + parse missing transactions as JSON ─────────────────────────
  const analyze = async () => {
    if (!statement.trim() || !acc) return;
    setAnalyzing(true);
    setAnalysis("");
    setMissing([]);
    try {
      const txnLines = accTxns.slice(-120).map(t =>
        `${t.date} | ${t.type==="credit"?"CR":"DR"} | ${t.amount} ${t.currency || acc.currency} | ${t.payee || t.category || ""}`
      ).join("\n");

      const prompt = `You are a financial reconciliation assistant for ${company === "at" ? "Atyahara" : "Nikhil Gems, a gem export business in India"}.

Account: ${acc.name} (${acc.currency})

SYSTEM LEDGER (last ${accTxns.slice(-120).length} entries):
${txnLines || "(empty)"}

BANK STATEMENT:
${statement}

Tasks:
1. Identify transactions in the BANK STATEMENT that are NOT in the system ledger (by date + amount).
2. Identify system entries that don't match the bank (errors/duplicates).
3. Give overall verdict: BALANCED / DISCREPANCY / NEEDS REVIEW.

At the END of your response, output a JSON block (and nothing after it) like this:
<missing_json>
[
  {"date":"YYYY-MM-DD","type":"debit|credit","amount":1234,"description":"...","category":"..."},
  ...
]
</missing_json>
If nothing is missing, output <missing_json>[]</missing_json>.`;

      const res = await fetch("/api/claude", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 3000, messages: [{ role: "user", content: prompt }] }),
      });
      const data = await res.json();
      const full = data.content?.find(b => b.type === "text")?.text || "No response.";

      // Split out the JSON block
      const jsonMatch = full.match(/<missing_json>([\s\S]*?)<\/missing_json>/);
      const report = full.replace(/<missing_json>[\s\S]*?<\/missing_json>/, "").trim();
      setAnalysis(report);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[1].trim());
          setMissing(Array.isArray(parsed) ? parsed.map((m, i) => ({ ...m, _id: i })) : []);
        } catch {}
      }
    } catch (e) {
      setAnalysis("Error: " + e.message);
    }
    setAnalyzing(false);
  };

  // ── Add a single missing txn to the ledger ─────────────────────────────────
  const addToLedger = async (m) => {
    if (!acc || adding[m._id]) return;
    setAdding(a => ({ ...a, [m._id]: true }));
    try {
      const newTxn = {
        id: uid(), type: m.type, amount: String(m.amount), currency: acc.currency,
        accountFrom: m.type === "debit"  ? acc.id : null,
        accountTo:   m.type === "credit" ? acc.id : null,
        payee: m.description || "", category: m.category || "Other",
        date: m.date || today(), notes: "Added via bank statement reconciliation",
        createdAt: new Date().toISOString(),
      };
      await onAddTxns([newTxn]);
      setAdded(a => ({ ...a, [m._id]: true }));
    } catch (e) { alert("Failed: " + e.message); }
    setAdding(a => ({ ...a, [m._id]: false }));
  };

  const addAllMissing = async () => {
    const toAdd = missing.filter(m => !added[m._id]);
    for (const m of toAdd) await addToLedger(m);
  };

  return (
    <div style={{ maxWidth: 700 }}>
      {pdfLoading && <PdfProgressBar step={pdfStep} />}
      {pdfModal && <PdfImportModal txns={pdfModal.txns} acc={acc} accTxns={accTxns} onAdd={onAddTxns} openingBalance={pdfModal.openingBalance} closingBalance={pdfModal.closingBalance} onClose={() => { setPdfModal(null); setPdfName(""); }} />}
      {pdfError && (
        <div style={{ background: "#fff0f0", border: "1px solid #f5c6c6", borderRadius: 10, padding: "14px 16px", marginBottom: 16, position: "relative" }}>
          <button onClick={() => setPdfError("")} style={{ position: "absolute", top: 10, right: 12, background: "none", border: "none", fontSize: 16, cursor: "pointer", color: "#999" }}>×</button>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#c0392b", marginBottom: 6 }}>PDF extraction failed</div>
          <pre style={{ fontSize: 11, color: "#555", whiteSpace: "pre-wrap", wordBreak: "break-all", margin: 0, maxHeight: 200, overflowY: "auto" }}>{pdfError}</pre>
        </div>
      )}

      {showReminder && (
        <div style={{ background: C.amberBg, border: `1px solid ${C.amber}`, borderRadius: 9, padding: "12px 16px", marginBottom: 20, display: "flex", gap: 12, alignItems: "flex-start" }}>
          <span style={{ fontSize: 20 }}>🔔</span>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14, color: C.amber }}>Monthly Reconciliation Due</div>
            <div style={{ fontSize: 12, color: C.inkMid, marginTop: 2 }}>Upload your bank statement PDF — AI reads it, finds missing entries, and adds them to your ledger.</div>
          </div>
        </div>
      )}

      {/* Account selector */}
      <div style={{ display: "flex", gap: 10, marginBottom: 24, alignItems: "center" }}>
        <select value={selectedAcc} onChange={e => setSelectedAcc(e.target.value)} style={{ ...FI, flex: 1, maxWidth: 280 }}>
          {accounts.map(a => <option key={a.id} value={a.id}>{a.name} ({a.currency})</option>)}
        </select>
        <div style={{ fontSize: 12, color: C.inkFaint }}>{accTxns.length} transactions in system</div>
      </div>

      {/* Upload — PDF or CSV */}
      <div
        onDragOver={e => e.preventDefault()}
        onDrop={e => {
          e.preventDefault();
          const f = e.dataTransfer.files[0];
          if (!f) return;
          if (/\.(csv|xlsx|xls|ods)$/i.test(f.name) || f.type.includes("csv") || f.type.includes("spreadsheet") || f.type.includes("excel")) handleCsv(f);
          else handlePdf(f);
        }}
        style={{ border: `2px dashed ${pdfName ? "#1a1a1a" : C.border}`, borderRadius: 14, padding: mob ? "24px 16px" : "36px 40px", background: pdfName ? "#fafaf8" : C.surface, textAlign: "center", transition: "all .2s" }}>
        <input ref={pdfRef} type="file" accept="application/pdf" style={{ display: "none" }} onChange={e => { if (e.target.files[0]) handlePdf(e.target.files[0]); e.target.value=""; }} />
        <input ref={csvRef} type="file" accept=".csv,.xlsx,.xls,.ods,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" style={{ display: "none" }} onChange={e => { if (e.target.files[0]) handleCsv(e.target.files[0]); e.target.value=""; }} />
        {pdfName ? (
          <>
            <div style={{ fontSize: 28, marginBottom: 8 }}>✅</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#111", marginBottom: 4 }}>{pdfName}</div>
            <div style={{ fontSize: 12, color: "#aaa" }}>Drop another file to replace</div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 12, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .7, marginBottom: 16 }}>Upload bank statement</div>
            <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
              <button onClick={() => pdfRef.current?.click()} style={{ background: "#111", color: "#fff", border: "none", borderRadius: 9, padding: "12px 24px", cursor: "pointer", fontSize: 14, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
                <span>📄</span> PDF
              </button>
              <button onClick={() => csvRef.current?.click()} style={{ background: C.surface, color: C.ink, border: `1.5px solid ${C.border}`, borderRadius: 9, padding: "12px 24px", cursor: "pointer", fontSize: 14, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
                <span>📊</span> CSV / Excel
              </button>
            </div>
            <div style={{ fontSize: 11, color: "#bbb", marginTop: 12 }}>or drag & drop here · PDF uses AI · CSV is instant</div>
          </>
        )}
      </div>

      {/* Recent ledger entries */}
      {accTxns.length > 0 && (
        <div style={{ marginTop: 28 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .7, marginBottom: 10 }}>Recent — {acc?.name}</div>
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
            {accTxns.slice().reverse().slice(0, 8).map((t, i, arr) => (
              <div key={t.id} style={{ padding: "12px 16px", borderBottom: i < arr.length - 1 ? `1px solid ${C.border}` : "none", display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: C.ink }}>{t.payee || t.category || "—"}</div>
                  <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 2 }}>{fmtDate(t.date)}</div>
                </div>
                <div style={{ fontSize: 14, fontWeight: 700, color: t.type === "credit" ? C.green : C.red }}>
                  {t.type === "credit" ? "+" : "−"}{(+t.amount).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Finance App ─────────────────────────────────────────────────────────
export default function FinanceApp({ onHome }) {
  const [company,       setCompanyState]  = useState(() => localStorage.getItem("ng-active-company") || "ng");
  const [view,          setView]          = useState("dashboard");
  const [accounts,      setAccounts]      = useState([]);
  const [txns,          setTxns]          = useState([]);
  const [rates,         setRates]         = useState(DEFAULT_RATES);
  const [invoices,      setInvoices]      = useState([]);
  const [buyers,        setBuyers]        = useState([]);
  const [purchases,     setPurchases]     = useState([]);
  const [vendors,       setVendors]       = useState([]);
  const [expenses,      setExpenses]      = useState([]);
  const [loaded,        setLoaded]        = useState(false);
  const [toast,         setToast]         = useState("");
  const [masked,        setMasked]        = useState(false);
  const [fetchingRates, setFetchingRates] = useState(false);
  const [pendingClassify, setPendingClassify] = useState(null); // txn waiting to be classified

  const setCompany = co => { setCompanyState(co); localStorage.setItem("ng-active-company", co); };

  const showToast = m => { setToast(m); setTimeout(() => setToast(""), 3000); };

  // Fetch live rates from open.er-api.com (free, no key needed)
  const fetchLiveRates = async (currentRates) => {
    setFetchingRates(true);
    try {
      const res = await fetch("https://open.er-api.com/v6/latest/USD");
      const data = await res.json();
      if (data.result !== "success") throw new Error("API error");
      const r = data.rates;
      const inrPerUsd = r.INR;
      const newRates = {
        ...(currentRates || {}),
        USD: Math.round(inrPerUsd * 100) / 100,
        EUR: Math.round((inrPerUsd / r.EUR) * 100) / 100,
        GBP: Math.round((inrPerUsd / r.GBP) * 100) / 100,
        JPY: Math.round((inrPerUsd / r.JPY) * 10000) / 10000,
        AUD: Math.round((inrPerUsd / r.AUD) * 100) / 100,
        _fetchedAt: new Date().toISOString(),
      };
      setRates(newRates);
      await saveK(companyKeys(company).rates, newRates);
      showToast("✓ Rates updated from live market");
      return newRates;
    } catch (e) {
      showToast("⚠ Could not fetch live rates — check connection");
    } finally {
      setFetchingRates(false);
    }
  };

  useEffect(() => {
    setLoaded(false);
    const keys = companyKeys(company);
    Promise.all([
      loadK(keys.accounts),
      loadK(keys.transactions),
      loadK(keys.rates),
      loadK(keys.invoices),
      loadK(keys.buyers),
      loadK(keys.purchases),
      loadK(keys.vendors),
      loadK(keys.expenses),
    ]).then(([accs, t, r, invs, buys, purch, vends, exps]) => {
      setAccounts(accs?.length ? accs : (company === "ng" ? DEFAULT_ACCOUNTS : DEFAULT_ACCOUNTS_AT));
      setTxns(t  || []);
      const savedRates = r && Object.keys(r || {}).length ? r : DEFAULT_RATES;
      setRates(savedRates);
      setInvoices(invs  || []);
      setBuyers(buys || []);
      setPurchases(purch || []);
      setVendors(vends  || []);
      setExpenses(exps  || []);
      setLoaded(true);
      // Auto-refresh if rates are older than 24 hours or never fetched
      const fetchedAt = savedRates._fetchedAt ? new Date(savedRates._fetchedAt) : null;
      const stale = !fetchedAt || (Date.now() - fetchedAt.getTime() > 24 * 60 * 60 * 1000);
      if (stale) fetchLiveRates(savedRates);
    });
  }, [company]);

  const saveAccounts = async accs => { setAccounts(accs); await saveK(companyKeys(company).accounts, accs); showToast("Accounts saved"); };
  const saveRates    = async r    => { setRates(r);        await saveK(companyKeys(company).rates, r);    showToast("Rates updated"); };
  const saveTxn = async (txn, classifyNow = false) => {
    const list = [txn, ...txns];
    setTxns(list);
    await saveK(companyKeys(company).transactions, list);
    if (classifyNow) {
      setPendingClassify(txn);
      setView("dashboard");
    } else {
      showToast("Transaction saved");
      setView("dashboard");
    }
  };
  const deleteTxn = async id => {
    const list = txns.filter(t => t.id !== id);
    setTxns(list);
    await saveK(companyKeys(company).transactions, list);
    showToast("Deleted");
  };

  const updateTxn = async (id, patch) => {
    const list = txns.map(t => t.id === id ? { ...t, ...patch } : t);
    setTxns(list);
    await saveK(companyKeys(company).transactions, list);
    showToast("Saved");
  };

  const handleClassify = async (txnId, { classifiedAs, classifiedRef, sideEffects, _accountPatch }) => {
    const keys = companyKeys(company);
    const newTxns = txns.map(t => t.id === txnId ? { ...t, classifiedAs, classifiedRef, classifiedAt: new Date().toISOString(), ...(_accountPatch || {}) } : t);
    setTxns(newTxns);
    await saveK(keys.transactions, newTxns);

    if (sideEffects.newExpense) {
      const newExps = [...expenses, sideEffects.newExpense];
      setExpenses(newExps);
      await saveK(keys.expenses, newExps);
    }
    if (sideEffects.billUpdates?.length) {
      const updateMap = Object.fromEntries(sideEffects.billUpdates.map(u => [u.id, u]));
      const newPurch = purchases.map(p => updateMap[p.id] ? { ...p, ...updateMap[p.id] } : p);
      setPurchases(newPurch);
      await saveK(keys.purchases, newPurch);
    }
    // legacy single-bill update (backwards compat)
    if (sideEffects.billUpdate) {
      const newPurch = purchases.map(p => p.id === sideEffects.billUpdate.id ? { ...p, ...sideEffects.billUpdate } : p);
      setPurchases(newPurch);
      await saveK(keys.purchases, newPurch);
    }
    if (sideEffects.vendorCredit) {
      const { vendorId, amount } = sideEffects.vendorCredit;
      const newVendors = vendors.map(v => v.id === vendorId ? { ...v, creditBalance: (+v.creditBalance || 0) + amount } : v);
      setVendors(newVendors);
      await saveK(keys.vendors, newVendors);
    }
    if (sideEffects.poUpdate) {
      const newPurch = purchases.map(p => p.id === sideEffects.poUpdate.id ? { ...p, ...sideEffects.poUpdate } : p);
      setPurchases(newPurch);
      await saveK(keys.purchases, newPurch);
    }
    if (sideEffects.invoiceUpdates?.length) {
      const updateMap = Object.fromEntries(sideEffects.invoiceUpdates.map(u => [u.id, u]));
      const freshInvs = await loadKFresh(keys.invoices);
      const newInvs = (Array.isArray(freshInvs) ? freshInvs : invoices).map(inv => updateMap[inv.id] ? { ...inv, ...updateMap[inv.id] } : inv);
      setInvoices(newInvs);
      await saveK(keys.invoices, newInvs);
    } else if (sideEffects.invoiceUpdate) {
      const freshInv = await loadKFresh(keys.invoices);
      const newInvs = (Array.isArray(freshInv) ? freshInv : invoices).map(inv => inv.id === sideEffects.invoiceUpdate.id ? { ...inv, ...sideEffects.invoiceUpdate } : inv);
      setInvoices(newInvs);
      await saveK(keys.invoices, newInvs);
    }
    showToast("✓ Classified");
  };

  const balances  = computeBalances(accounts, txns);
  const totalINR  = accounts.filter(a => a.active).reduce((s, a) => {
  const bal = toINR(balances[a.id] || 0, a.currency, rates);
  return a.type === "credit_card" ? s - bal : s + bal;
}, 0);

  return (
    <FShell view={view} setView={setView} onHome={onHome} title={view} masked={masked} toggleMask={() => setMasked(v => !v)} company={company} setCompany={setCompany}>
      {!loaded
        ? <div style={{ textAlign: "center", padding: "60px 20px", color: C.inkFaint, fontSize: 14 }}>Loading financial data…</div>
        : <>
          {view === "dashboard"  && <Dashboard accounts={accounts} transactions={txns} rates={rates} invoices={invoices} purchases={purchases} balances={balances} totalINR={totalINR} onAddTxn={() => setView("add")} />}
          {view === "ledger"     && <LedgerView transactions={txns} accounts={accounts} rates={rates} onDelete={deleteTxn} onUpdate={updateTxn} vendors={vendors} purchases={purchases} expenses={expenses} invoices={invoices} buyers={buyers} onClassify={handleClassify} />}
          {view === "add"        && <AddTxnForm accounts={accounts} invoices={invoices} purchases={purchases} vendors={vendors} onSave={saveTxn} onCancel={() => setView("dashboard")} />}
          {view === "accounts"   && <AccountsSettings accounts={accounts} rates={rates} balances={balances} onUpdate={saveAccounts} onUpdateRates={saveRates} onFetchRates={()=>fetchLiveRates(rates)} fetchingRates={fetchingRates} onReassignTxns={async (fromId, toId) => { const updated = txns.map(t => ({ ...t, accountFrom: t.accountFrom===fromId ? toId : t.accountFrom, accountTo: t.accountTo===fromId ? toId : t.accountTo })); setTxns(updated); await saveK(companyKeys(company).transactions, updated); showToast("Transactions moved"); }} />}
          {view === "classify"   && <ExpenseSplitView transactions={txns} accounts={accounts} onUpdate={updateTxn} />}
          {view === "reconcile"  && <ReconcileView accounts={accounts} transactions={txns} company={company} onAddTxns={async (newTxns) => { const list = [...newTxns, ...txns]; setTxns(list); await saveK(companyKeys(company).transactions, list); showToast(`${newTxns.length} transaction${newTxns.length>1?"s":""} added to ledger`); }} />}
        </>
      }
      {/* Inline classify after manual entry */}
      {pendingClassify && (
        <ClassifyModal
          txn={pendingClassify}
          accounts={accounts}
          vendors={vendors}
          purchases={purchases}
          invoices={invoices}
          rates={rates}
          onSave={(txnId, result) => {
            handleClassify(txnId, result);
            setPendingClassify(null);
            showToast("✓ Saved & classified");
          }}
          onClose={() => { setPendingClassify(null); showToast("Transaction saved"); }}
        />
      )}
      <FToast msg={toast} />
    </FShell>
  );
}
