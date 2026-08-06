import { useState, useEffect, useRef, createContext, useContext, Fragment } from "react";
import { supabase } from "./supabase.js";
import { loadK, loadKFresh, saveK, onCacheRefresh } from "./utils.js";
import ClassifyTransactionModal from "./ClassifyTransaction.jsx";

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

// Overdraft against the fixed deposit at Bank of India. Sanctioned limit is 90%
// of the FD; the rate floats with the FD (FD rate + 1%). All of these are
// editable in Finance → Accounts when the FD renews at a new rate.
const OD_BOI = {
  id: "fa-boi-od", name: "Bank of India OD (against FD)", type: "od",
  currency: "INR", openingBal: 0, active: true,
  odLimit: 1620000, odFdRate: 7.3, odSpread: 1,
  odAccountNo: "006427280000008", odLinkedAccountId: "fa-boi-0451",
};

const DEFAULT_ACCOUNTS = [
  { id: "fa-inr-cash",  name: "INR Cash",             type: "cash", currency: "INR", openingBal: 0, active: true },
  { id: "fa-usd-cash",  name: "USD Cash",             type: "cash", currency: "USD", openingBal: 0, active: true },
  { id: "fa-eur-cash",  name: "EUR Cash",             type: "cash", currency: "EUR", openingBal: 0, active: true },
  { id: "fa-jpy-cash",  name: "JPY Cash",             type: "cash", currency: "JPY", openingBal: 0, active: true },
  { id: "fa-boi-0451",  name: "Bank of India 0451",   type: "bank", currency: "INR", openingBal: 0, active: true },
  { id: "fa-eefc",      name: "EEFC",                 type: "bank", currency: "USD", openingBal: 0, active: true },
  { id: "fa-vantage",   name: "Vantage West",         type: "bank", currency: "USD", openingBal: 0, active: true },
  { id: "fa-chase",     name: "Chase Earth Editions", type: "bank", currency: "USD", openingBal: 0, active: true },
  OD_BOI,
];

const DEFAULT_ACCOUNTS_AT = [
  { id: "at-induslnd",  name: "IndusInd Bank", type: "bank", currency: "INR", openingBal: 0, active: true },
  { id: "at-boi",       name: "Bank of India", type: "bank", currency: "INR", openingBal: 0, active: true },
];

const DEFAULT_RATES = { USD: 85, EUR: 92, JPY: 0.57, GBP: 107, AUD: 55 };
const CUR_SYM = { INR: "₹", USD: "$", EUR: "€", JPY: "¥", GBP: "£", AUD: "A$" };
const PERSONAL_ASSETS_KEY = "personal-fin-assets-v1";

const TXN_CATS = {
  credit: ["FIRC / Inward Remittance", "Show Income – USD", "Show Income – EUR", "Show Income – JPY", "Show Income – INR", "Cash Received", "Advance Received", "Loan Received", "Other Income", "Balance Adjustment"],
  debit:  ["Bill Payment", "Expense Payment", "Show Expense", "Bank Charges", "Loan Repayment", "Personal Withdrawal", "Advance Paid", "Other Payment", "Balance Adjustment"],
  conversion: ["JPY Cash → INR Cash", "USD Cash → INR Cash", "EUR Cash → INR Cash", "EEFC → BOI (INR)", "USD Cash → EEFC", "Bank Transfer (Internal)", "Other Conversion"],
};

const ASSET_TYPES = [
  { id: "mutual_fund", label: "Mutual Fund", tone: C.green, bg: C.greenBg },
  { id: "sip", label: "SIP", tone: C.teal, bg: C.tealBg },
  { id: "fixed_deposit", label: "FD", tone: C.blue, bg: C.blueBg },
  { id: "ppf", label: "PPF", tone: C.amber, bg: C.amberBg },
  { id: "epf_nps", label: "EPF / NPS", tone: C.purple, bg: C.purpleBg },
  { id: "stocks", label: "Stocks", tone: C.ink, bg: C.card },
  { id: "gold", label: "Gold", tone: C.gold, bg: C.goldLight },
  { id: "real_estate", label: "Real Estate", tone: C.red, bg: C.redBg },
  { id: "other", label: "Other", tone: C.inkMid, bg: C.card },
];

// ─── Core calculations ────────────────────────────────────────────────────────

// Credit cards and overdrafts are liabilities: their balance is stored as a
// positive "outstanding" (what you owe). Every movement therefore lands on them
// with the sign flipped — money leaving the account increases what you owe.
const LIABILITY_TYPES = new Set(["credit_card", "od"]);
export const isLiabilityAcc = a => LIABILITY_TYPES.has(a?.type);

// `delta` is always in asset sense (+ = more money available to you).
function applyDelta(bals, id, delta, liabIds) {
  if (!id) return;
  bals[id] = (bals[id] || 0) + (liabIds.has(id) ? -delta : delta);
}

function computeBalances(accounts, transactions) {
  const bals = {};
  const liabIds = new Set(accounts.filter(isLiabilityAcc).map(a => a.id));
  accounts.forEach(a => { bals[a.id] = +(a.openingBal || 0); });
  transactions.forEach(t => {
    const amt = +t.amount || 0;
    if (t.type === "credit") {
      applyDelta(bals, t.accountTo, amt, liabIds);
    } else if (t.type === "debit") {
      applyDelta(bals, t.accountFrom, -amt, liabIds);
      if (t.classifiedAs === "cc_payment" && t.classifiedRef?.cardAccountId) {
        applyDelta(bals, t.classifiedRef.cardAccountId, amt, liabIds);
      }
    } else if (t.type === "conversion") {
      // Internal transfer. Drawing on an OD is exactly this: money leaves the
      // OD (outstanding rises) and lands in the current account.
      applyDelta(bals, t.accountFrom, -amt, liabIds);
      applyDelta(bals, t.accountTo, amt * (+t.convRate || 1), liabIds);
    }
  });
  return bals;
}

// ─── Overdraft ────────────────────────────────────────────────────────────────
// The OD is secured against an FD, so its rate tracks that FD: rate = FD + spread.
export const odRate = a => (+a?.odFdRate || 0) + (+a?.odSpread || 0);

// Day-by-day outstanding on an OD account, from the account's opening balance
// forward through every transaction that touches it. Returns [{ date, bal }]
// with one entry per transaction date (balance holds until the next entry).
function odBalanceSteps(acc, transactions) {
  const touching = transactions
    .filter(t => t.accountFrom === acc.id || t.accountTo === acc.id)
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  let bal = +(acc.openingBal || 0);
  const steps = [];
  for (const t of touching) {
    const amt = +t.amount || 0;
    // Asset-sense delta, then flipped because the OD is a liability.
    let delta = 0;
    if (t.type === "credit" && t.accountTo === acc.id) delta = amt;
    else if (t.type === "debit" && t.accountFrom === acc.id) delta = -amt;
    else if (t.type === "conversion") {
      if (t.accountFrom === acc.id) delta = -amt;
      else if (t.accountTo === acc.id) delta = amt * (+t.convRate || 1);
    }
    bal += -delta;
    const date = t.date || "";
    const last = steps[steps.length - 1];
    if (last && last.date === date) last.bal = bal;
    else steps.push({ date, bal });
  }
  return steps;
}

// UTC throughout, so a day number never shifts with the local timezone.
const dayNum      = d => Math.floor(Date.parse(d + "T00:00:00Z") / 86400000);
const yearOfDay   = n => new Date(n * 86400000).getUTCFullYear();
const yearStartDay = y => Math.floor(Date.UTC(y, 0, 1) / 86400000);
const daysInYear  = y => ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0) ? 366 : 365;

// Interest on a flat span of days at one balance, split at 31 Dec so each part
// is divided by its own year's length. The single place the rate is applied —
// the dashboard estimate and the statement's working both run through here, so
// the two can never disagree.
function accrueFlat(bal, fromDay, toDay, rate) {
  let out = 0, c = fromDay;
  while (c < toDay) {
    const y = yearOfDay(c);
    const until = Math.min(toDay, yearStartDay(y + 1));
    out += Math.max(0, bal) * (until - c) * (rate / 100) / daysInYear(y);
    c = until;
  }
  return out;
}

// Interest accrued on the daily outstanding between two YYYY-MM-DD dates
// (inclusive of `from`, exclusive of `to`) — the "daily products" method Indian
// banks use for an OD: interest runs only on the amount actually drawn, for the
// exact days it stays drawn, so a part repayment cuts it from that day onward.
// The bank uses a 365-day year, 366 in a leap year, so each day is divided by
// the length of the year it actually falls in.
//
// This is the estimate. The bank debits the real figure monthly (which is why it
// compounds — the debit lands in the OD and next month's interest runs on it
// too); that debit is logged from its SMS and shown beside this number.
function odAccruedInterest(acc, transactions, from, to) {
  const rate = odRate(acc);
  if (!rate || !from || !to) return { interest: 0, avgBal: 0, days: 0 };
  const steps = odBalanceSteps(acc, transactions);
  const startDay = dayNum(from), endDay = dayNum(to);
  if (endDay <= startDay) return { interest: 0, avgBal: 0, days: 0 };

  const accrueSpan = (bal, spanFrom, spanTo) => accrueFlat(bal, spanFrom, spanTo, rate);

  // Outstanding as at the start of the window.
  let bal = 0;
  for (const s of steps) { if (dayNum(s.date) <= startDay) bal = s.bal; else break; }
  const future = steps.filter(s => dayNum(s.date) > startDay && dayNum(s.date) < endDay);

  let balDays = 0, interest = 0, cursor = startDay, si = 0;
  while (cursor < endDay) {
    const nextChange = si < future.length ? dayNum(future[si].date) : endDay;
    const until = Math.min(nextChange, endDay);
    balDays  += Math.max(0, bal) * (until - cursor);
    interest += accrueSpan(bal, cursor, until);
    cursor = until;
    if (si < future.length && cursor === nextChange) { bal = future[si].bal; si++; }
  }
  const days = endDay - startDay;
  return { interest, avgBal: days ? balDays / days : 0, days };
}

const OD_INT_CAT = "Interest – OD";
const isOdInterestTxn = t => (t.category || "") === OD_INT_CAT;

// Movement on the OD in liability sense: positive = outstanding goes UP.
function odDelta(acc, t) {
  const amt = +t.amount || 0;
  if (t.type === "credit"     && t.accountTo   === acc.id) return -amt;
  if (t.type === "debit"      && t.accountFrom === acc.id) return  amt;
  if (t.type === "conversion") {
    if (t.accountFrom === acc.id) return  amt;
    if (t.accountTo   === acc.id) return -amt * (+t.convRate || 1);
  }
  return 0;
}

// A full statement for one period: opening balance, every movement, and the
// bank's own "daily products" working — Σ(balance × days) ÷ days-in-year × rate.
// Laid out this way so each line can be checked against BOI's statement rather
// than taken on trust.
function odStatement(acc, transactions, from, to) {
  const rate = odRate(acc);
  const touching = transactions
    .filter(t => t.accountFrom === acc.id || t.accountTo === acc.id)
    .sort((a, b) => (a.date || "").localeCompare(b.date || "")
                 || (a.createdAt || "").localeCompare(b.createdAt || ""));

  let bal = +(acc.openingBal || 0);
  const rows = [];
  for (const t of touching) {
    const d = t.date || "";
    if (d >= to) continue;
    const delta = odDelta(acc, t);
    bal += delta;
    if (d < from) continue;                       // rolls into the opening balance
    rows.push({
      id: t.id, date: d,
      time: t.createdAt ? new Date(t.createdAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "",
      kind: isOdInterestTxn(t) ? "interest" : delta > 0 ? "draw" : "repay",
      particulars: t.payee || t.category || "—",
      notes: t.notes || "",
      drawn:  delta > 0 ?  delta : 0,
      repaid: delta < 0 ? -delta : 0,
      balance: bal,
      bankSaid: t.odAvailAfter != null ? +t.odAvailAfter : null,
    });
  }
  const closing = bal;

  // Opening = balance before the window, i.e. reverse out everything inside it.
  const opening = closing - rows.reduce((s, r) => s + r.drawn - r.repaid, 0);

  // Balance periods: a movement dated D takes effect on D (banks charge on the
  // day's closing balance), so [previous change, D) sits at the old balance.
  const lastByDate = new Map();
  rows.forEach(r => lastByDate.set(r.date, r.balance));
  const periods = [];
  let pBal = opening, cursor = from;
  for (const d of [...lastByDate.keys()].sort()) {
    if (d > cursor) periods.push({ from: cursor, to: d, balance: pBal });
    pBal = lastByDate.get(d);
    cursor = d;
  }
  if (cursor < to) periods.push({ from: cursor, to, balance: pBal });

  const priced = periods.map(p => {
    const days = dayNum(p.to) - dayNum(p.from);
    return { ...p, days,
      product:  Math.max(0, p.balance) * days,
      interest: accrueFlat(p.balance, dayNum(p.from), dayNum(p.to), rate) };
  }).filter(p => p.days > 0);

  const totalDays = dayNum(to) - dayNum(from);
  return {
    rate, opening, closing, rows, periods: priced, totalDays,
    drawn:    rows.reduce((s, r) => s + r.drawn, 0),
    repaid:   rows.reduce((s, r) => s + r.repaid, 0),
    charged:  rows.filter(r => r.kind === "interest").reduce((s, r) => s + r.drawn, 0),
    productSum: priced.reduce((s, p) => s + p.product, 0),
    interest:   priced.reduce((s, p) => s + p.interest, 0),
    avgBal:     totalDays ? priced.reduce((s, p) => s + p.product, 0) / totalDays : 0,
    peak:       Math.max(0, ...priced.map(p => p.balance)),
  };
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
    { id: "flow",      label: mob ? "💸" : "Money Flow", title: "Money Flow" },
    { id: "assets",    label: mob ? "🧾" : "Assets",    title: "Personal Assets" },
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
        .fl-row:hover{background:var(--c-card);}
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
// ─── OD Statement ─────────────────────────────────────────────────────────────
// A month's overdraft account laid out the way a bank statement is, plus the
// interest working underneath it, so every rupee charged can be traced to a
// balance and a number of days.
function OdStatementModal({ acc, transactions, onClose }) {
  const masked = useMasked();
  const m = makeMask(masked);
  const now = new Date();
  const [ym, setYm] = useState({ y: now.getFullYear(), mo: now.getMonth() });

  const pad   = n => String(n).padStart(2, "0");
  const start = `${ym.y}-${pad(ym.mo + 1)}-01`;
  const endD  = new Date(ym.y, ym.mo + 1, 1);
  const end   = `${endD.getFullYear()}-${pad(endD.getMonth() + 1)}-01`;
  const cur   = acc.currency || "INR";
  const f     = n => m(fmtAmt(n, cur));

  const st = odStatement(acc, transactions, start, end);
  const isCurrentMonth = ym.y === now.getFullYear() && ym.mo === now.getMonth();
  const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

  const shift = n => setYm(v => {
    const d = new Date(v.y, v.mo + n, 1);
    return { y: d.getFullYear(), mo: d.getMonth() };
  });
  const label = new Date(ym.y, ym.mo, 1).toLocaleString("en-IN", { month: "long", year: "numeric" });

  const exportCsv = () => {
    const q = s => `"${String(s ?? "").replace(/"/g, '""')}"`;
    const lines = [
      [`OD Statement — ${acc.name}`], [label], [`Rate`, `${st.rate.toFixed(2)}% p.a.`], [],
      ["Date", "Time", "Particulars", "Drawn", "Repaid", "Outstanding"],
      [q("Opening balance"), "", "", "", "", st.opening.toFixed(2)],
      ...st.rows.map(r => [r.date, r.time, q(r.particulars), r.drawn ? r.drawn.toFixed(2) : "",
                           r.repaid ? r.repaid.toFixed(2) : "", r.balance.toFixed(2)]),
      [q("Closing balance"), "", "", st.drawn.toFixed(2), st.repaid.toFixed(2), st.closing.toFixed(2)], [],
      ["Interest working — daily products"],
      ["From", "To", "Days", "Outstanding", "Product (bal x days)", "Interest"],
      ...st.periods.map(p => [p.from, p.to, p.days, p.balance.toFixed(2), p.product.toFixed(2), p.interest.toFixed(2)]),
      ["", "", st.totalDays, "", st.productSum.toFixed(2), st.interest.toFixed(2)],
    ];
    const blob = new Blob([lines.map(r => r.join(",")).join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `OD-statement-${ym.y}-${pad(ym.mo + 1)}.csv`;
    a.click(); URL.revokeObjectURL(a.href);
  };

  const TH = { fontSize: 9, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .6, padding: "7px 10px", textAlign: "left", whiteSpace: "nowrap", borderBottom: `1px solid ${C.border}` };
  const TD = { fontSize: 12, color: C.ink, padding: "8px 10px", whiteSpace: "nowrap", borderBottom: `1px solid ${C.border}` };
  const NUM = { ...TD, textAlign: "right", fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 14, fontWeight: 600 };
  const KIND = { draw: [C.red, "Drawdown"], repay: [C.green, "Repayment"], interest: [C.amber, "Interest charged"] };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", zIndex: 3000, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: mob ? 0 : "28px 20px", overflowY: "auto" }}>
      <div onClick={e => e.stopPropagation()} style={{ background: C.surface, borderRadius: mob ? 0 : 14, width: "100%", maxWidth: 940, boxShadow: "0 24px 70px rgba(0,0,0,.28)", overflow: "hidden" }}>

        {/* Header */}
        <div style={{ background: `linear-gradient(135deg,${C.ink} 0%,#3A2810 100%)`, color: "#FAF0DC", padding: mob ? "16px 18px" : "20px 24px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", opacity: .55 }}>Overdraft Statement</div>
              <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: mob ? 21 : 26, fontWeight: 600, lineHeight: 1.15, marginTop: 2 }}>{acc.name}</div>
              <div style={{ fontSize: 10, opacity: .6, marginTop: 3 }}>
                {acc.odAccountNo ? `A/c ${acc.odAccountNo} · ` : ""}{st.rate.toFixed(2)}% p.a.
                {acc.odLimit ? ` · limit ${f(+acc.odLimit)}` : ""}
              </div>
            </div>
            <button onClick={onClose} style={{ background: "rgba(255,255,255,.12)", border: "none", color: "#FAF0DC", borderRadius: 7, width: 30, height: 30, fontSize: 16, cursor: "pointer", flexShrink: 0 }}>×</button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
            {[["‹", -1], ["›", 1]].map(([g, n], i) => (
              <button key={g} onClick={() => shift(n)} style={{ background: "rgba(255,255,255,.12)", border: "none", color: "#FAF0DC", borderRadius: 6, padding: "4px 11px", fontSize: 15, cursor: "pointer", order: i === 0 ? 0 : 2 }}>{g}</button>
            ))}
            <div style={{ fontSize: 13, fontWeight: 600, minWidth: 118, textAlign: "center", order: 1 }}>{label}</div>
            <button onClick={exportCsv} style={{ background: "rgba(255,255,255,.12)", border: "none", color: "#FAF0DC", borderRadius: 6, padding: "5px 12px", fontSize: 11, cursor: "pointer", order: 3, marginLeft: "auto" }}>⤓ CSV</button>
          </div>
        </div>

        <div style={{ padding: mob ? "14px 14px 22px" : "18px 24px 26px" }}>

          {/* Summary */}
          <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr 1fr" : "repeat(5,1fr)", gap: 9, marginBottom: 16 }}>
            {[
              ["Opening", f(st.opening), "outstanding", C.inkMid],
              ["Drawn", st.drawn ? `+${f(st.drawn)}` : f(0), `${st.rows.filter(r => r.kind === "draw").length} draw(s)`, C.red],
              ["Repaid", st.repaid ? `−${f(st.repaid)}` : f(0), `${st.rows.filter(r => r.kind === "repay").length} repayment(s)`, C.green],
              ["Closing", f(st.closing), "outstanding", C.ink],
              ["Interest", f(st.interest), isCurrentMonth ? "projected" : "for the month", C.amber],
            ].map(([l, v, s, col]) => (
              <div key={l} style={{ background: C.card, borderRadius: 8, padding: "10px 12px" }}>
                <div style={{ fontSize: 9, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .6 }}>{l}</div>
                <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 17, fontWeight: 600, color: col, lineHeight: 1.15, marginTop: 3 }}>{v}</div>
                <div style={{ fontSize: 9, color: C.inkFaint, marginTop: 1 }}>{s}</div>
              </div>
            ))}
          </div>

          {isCurrentMonth && (
            <div style={{ fontSize: 10, color: C.inkMid, background: C.amberBg, border: `1px solid ${C.borderHi}`, borderRadius: 7, padding: "8px 11px", marginBottom: 16 }}>
              This month is still running. Days after {todayStr} are priced at the balance as it stands now — repay or draw again and this restates.
            </div>
          )}

          {/* Transactions */}
          <div style={{ fontSize: 10, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .8, marginBottom: 7 }}>Account Movements</div>
          <div style={{ overflowX: "auto", border: `1px solid ${C.border}`, borderRadius: 9, marginBottom: 20 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 620 }}>
              <thead><tr>
                {["Date", "Time", "Particulars", "Drawn", "Repaid", "Outstanding"].map((h, i) => (
                  <th key={h} style={{ ...TH, textAlign: i >= 3 ? "right" : "left" }}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                <tr style={{ background: C.card }}>
                  <td style={{ ...TD, fontWeight: 600 }} colSpan={5}>Opening balance</td>
                  <td style={{ ...NUM, fontWeight: 700 }}>{f(st.opening)}</td>
                </tr>
                {st.rows.map(r => {
                  const [col, lbl] = KIND[r.kind];
                  return (
                    <tr key={r.id}>
                      <td style={TD}>{new Date(r.date + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}</td>
                      <td style={{ ...TD, color: C.inkFaint, fontSize: 11 }}>{r.time || "—"}</td>
                      <td style={{ ...TD, whiteSpace: "normal", minWidth: 200 }}>
                        <div style={{ fontWeight: 500 }}>{r.particulars}</div>
                        <div style={{ fontSize: 9, color: col, fontWeight: 700, textTransform: "uppercase", letterSpacing: .5, marginTop: 2 }}>{lbl}</div>
                        {r.bankSaid != null && (
                          <div style={{ fontSize: 9, color: C.inkFaint, marginTop: 2 }}>bank reported {f(r.bankSaid)} available</div>
                        )}
                      </td>
                      <td style={{ ...NUM, color: r.drawn ? C.red : C.inkFaint }}>{r.drawn ? f(r.drawn) : "—"}</td>
                      <td style={{ ...NUM, color: r.repaid ? C.green : C.inkFaint }}>{r.repaid ? f(r.repaid) : "—"}</td>
                      <td style={NUM}>{f(r.balance)}</td>
                    </tr>
                  );
                })}
                {st.rows.length === 0 && (
                  <tr><td style={{ ...TD, color: C.inkFaint, textAlign: "center" }} colSpan={6}>No movement this month</td></tr>
                )}
                <tr style={{ background: C.card }}>
                  <td style={{ ...TD, fontWeight: 600 }} colSpan={3}>Closing balance</td>
                  <td style={{ ...NUM, color: C.red }}>{f(st.drawn)}</td>
                  <td style={{ ...NUM, color: C.green }}>{f(st.repaid)}</td>
                  <td style={{ ...NUM, fontWeight: 700 }}>{f(st.closing)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Interest working */}
          <div style={{ fontSize: 10, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .8, marginBottom: 3 }}>Interest Working — Daily Products</div>
          <div style={{ fontSize: 10, color: C.inkFaint, marginBottom: 7 }}>
            Interest is charged on each day's closing balance. Every period below is a stretch where the balance did not move.
          </div>
          <div style={{ overflowX: "auto", border: `1px solid ${C.border}`, borderRadius: 9, marginBottom: 12 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 620 }}>
              <thead><tr>
                {["From", "To", "Days", "Outstanding", "Product (bal × days)", "Interest"].map((h, i) => (
                  <th key={h} style={{ ...TH, textAlign: i >= 2 ? "right" : "left" }}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {st.periods.map(p => (
                  <tr key={p.from}>
                    <td style={TD}>{new Date(p.from + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}</td>
                    <td style={TD}>{new Date(dayNum(p.to) * 86400000 - 86400000).toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "UTC" })}</td>
                    <td style={NUM}>{p.days}</td>
                    <td style={{ ...NUM, color: p.balance > 0 ? C.ink : C.inkFaint }}>{f(p.balance)}</td>
                    <td style={{ ...NUM, color: C.inkMid }}>{m(Math.round(p.product).toLocaleString("en-IN"))}</td>
                    <td style={{ ...NUM, color: p.interest > 0 ? C.amber : C.inkFaint }}>{f(p.interest)}</td>
                  </tr>
                ))}
                <tr style={{ background: C.card }}>
                  <td style={{ ...TD, fontWeight: 600 }} colSpan={2}>Total</td>
                  <td style={{ ...NUM, fontWeight: 700 }}>{st.totalDays}</td>
                  <td style={{ ...NUM, color: C.inkFaint, fontSize: 11 }}>avg {f(st.avgBal)}</td>
                  <td style={{ ...NUM, fontWeight: 700 }}>{m(Math.round(st.productSum).toLocaleString("en-IN"))}</td>
                  <td style={{ ...NUM, fontWeight: 700, color: C.amber }}>{f(st.interest)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* The arithmetic, spelled out */}
          <div style={{ background: C.card, borderRadius: 9, padding: "12px 14px", fontSize: 11, color: C.inkMid, lineHeight: 1.7 }}>
            <span style={{ fontWeight: 700, color: C.ink }}>How this is worked out</span><br />
            Σ products {m(Math.round(st.productSum).toLocaleString("en-IN"))} ÷ {daysInYear(ym.y)} days
            {" "}× {st.rate.toFixed(2)}% = <span style={{ fontWeight: 700, color: C.amber }}>{f(st.interest)}</span>
            <div style={{ fontSize: 10, color: C.inkFaint, marginTop: 5 }}>
              {daysInYear(ym.y) === 366 ? "366-day year (leap)" : "365-day year"} · rate = FD {acc.odFdRate}% + {acc.odSpread}% spread
              {st.peak > 0 && <> · peak outstanding {f(st.peak)}</>}
              {st.charged > 0 && <> · BOI actually debited {f(st.charged)} this month</>}
            </div>
            {st.charged > 0 && Math.abs(st.charged - st.interest) >= 1 && (
              <div style={{ fontSize: 10, color: C.red, marginTop: 6 }}>
                ⚠ Charged {f(Math.abs(st.charged - st.interest))} {st.charged > st.interest ? "more" : "less"} than this working — worth querying with the branch.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

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
  const odAccs   = accounts.filter(a => a.type === "od" && a.active);
  const [odStatementAcc, setOdStatement] = useState(null);

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

      {odStatementAcc && (
        <OdStatementModal acc={odStatementAcc} transactions={transactions} onClose={() => setOdStatement(null)} />
      )}

      {/* Overdraft */}
      {odAccs.map(a => {
        const drawn     = Math.max(0, balances[a.id] || 0);
        const limit     = +a.odLimit || 0;
        const available = limit ? Math.max(0, limit - drawn) : null;
        const utilPct   = limit ? Math.min(100, Math.round(drawn / limit * 100)) : 0;
        const rate      = odRate(a);

        // All local dates — mixing these with toISOString() would shift the window
        // by a day for the IST evening, since UTC is still on the previous date.
        const now  = new Date();
        const ymd  = dt => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
        const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
        // End is exclusive, so pass tomorrow to include today — interest accrues on
        // today's closing balance, and a draw made today should show a day's cost.
        const tomorrow   = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
        const fyStart    = `${now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1}-04-01`;

        const mtd = odAccruedInterest(a, transactions, monthStart, ymd(tomorrow));
        // Same calculation run to month end. There are no transactions after today,
        // so the current outstanding simply carries forward — i.e. "what BOI will
        // debit on the 1st if nothing changes". Repay tomorrow and this drops by
        // itself, because the repayment lands in the history it walks.
        const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        const projected = odAccruedInterest(a, transactions, monthStart, ymd(nextMonth));
        const daysLeft  = Math.round((nextMonth - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000) - 1;
        const paidFY = transactions
          .filter(t => isOdInterestTxn(t) && (t.accountFrom === a.id || t.accountTo === a.id) && (t.date || "") >= fyStart)
          .reduce((s, t) => s + (+t.amount || 0), 0);

        // Latest "Avl Bal" the bank itself reported, captured from the OD SMS.
        const lastSnap = [...transactions]
          .filter(t => t.odAvailAfter != null && (t.accountFrom === a.id || t.accountTo === a.id))
          .sort((x, y) => (y.date || "").localeCompare(x.date || ""))[0];
        const drift = lastSnap && available != null
          ? Math.round((available - (+lastSnap.odAvailAfter || 0)) * 100) / 100
          : null;

        return (
          <div key={a.id} style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: C.amber, textTransform: "uppercase", letterSpacing: .8, marginBottom: 8 }}>🏛 Overdraft</div>
            <div style={{ background: C.surface, border: `1.5px solid ${utilPct > 80 ? C.red : C.border}`, borderRadius: 10, padding: mob ? "14px 15px" : "16px 18px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
                <div>
                  <div style={{ fontSize: 9, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .8, marginBottom: 4 }}>{a.name}</div>
                  <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: mob ? 24 : 30, fontWeight: 600, color: drawn > 0 ? C.red : C.green, lineHeight: 1 }}>
                    {m(fmtAmt(drawn, a.currency || "INR"))}
                  </div>
                  <div style={{ fontSize: 10, color: C.inkFaint, marginTop: 3 }}>drawn{rate ? ` · ${rate.toFixed(2)}% p.a. (FD ${a.odFdRate}% + ${a.odSpread}%)` : ""}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 9, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .8 }}>Available</div>
                  <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: mob ? 19 : 22, fontWeight: 600, color: C.ink }}>
                    {available != null ? m(fmtAmt(available, a.currency || "INR")) : "—"}
                  </div>
                  {limit > 0 && <div style={{ fontSize: 10, color: C.inkFaint, marginTop: 2 }}>of {m(fmtAmt(limit, a.currency || "INR"))} limit</div>}
                  <button onClick={() => setOdStatement(a)} className="fbs" style={{ fontSize: 11, padding: "5px 11px", marginTop: 7 }}>
                    📜 Detailed ledger
                  </button>
                </div>
              </div>

              {limit > 0 && (
                <div style={{ height: 6, background: C.card, borderRadius: 3, overflow: "hidden", marginBottom: 10 }}>
                  <div style={{ height: "100%", width: `${utilPct}%`, background: utilPct > 80 ? C.red : utilPct > 50 ? C.amber : C.green, borderRadius: 3, transition: "width .4s" }} />
                </div>
              )}

              <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr 1fr" : "repeat(5, 1fr)", gap: 10, paddingTop: 10, borderTop: `1px solid ${C.border}` }}>
                {[
                  ["Utilisation", `${utilPct}%`, null, null],
                  ["Avg outstanding MTD", m(fmtAmt(Math.round(mtd.avgBal), a.currency || "INR")), `${mtd.days} day${mtd.days === 1 ? "" : "s"}`, null],
                  ["Interest accrued MTD", m(fmtAmt(Math.round(mtd.interest), a.currency || "INR")), "so far", null],
                  ["Due at month end", m(fmtAmt(Math.round(projected.interest), a.currency || "INR")),
                    drawn > 0 && daysLeft > 0 ? `if ${m(fmtAmt(drawn, a.currency || "INR"))} stays drawn` : "debited ~1st", C.amber],
                  ["Interest paid FY", m(fmtAmt(Math.round(paidFY), a.currency || "INR")), "charged by bank", null],
                ].map(([lbl, val, sub, tone]) => (
                  <div key={lbl}>
                    <div style={{ fontSize: 9, fontWeight: 700, color: tone || C.inkFaint, textTransform: "uppercase", letterSpacing: .6, marginBottom: 3 }}>{lbl}</div>
                    <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 17, fontWeight: 600, color: tone || C.ink, lineHeight: 1.1 }}>{val}</div>
                    {sub && <div style={{ fontSize: 9, color: C.inkFaint, marginTop: 2 }}>{sub}</div>}
                  </div>
                ))}
              </div>

              {drawn > 0 && (
                <div style={{ marginTop: 10, fontSize: 10, color: C.inkFaint }}>
                  Interest runs on the amount actually drawn, for the exact days it stays drawn — repay part of it and it drops from that day.
                  {" "}At {rate.toFixed(2)}% that's about {m(fmtAmt(Math.round(drawn * rate / 100 / 365), a.currency || "INR"))}/day on the current {m(fmtAmt(drawn, a.currency || "INR"))}.
                  {" "}BOI debits the month's interest into the OD at the start of the next month.
                </div>
              )}

              {limit > 0 && drawn > limit && (
                <div style={{ marginTop: 10, fontSize: 10, color: C.red, background: C.redBg, borderRadius: 6, padding: "7px 10px" }}>
                  ⚠ Drawn {m(fmtAmt(drawn - limit, a.currency || "INR"))} over the sanctioned limit — banks charge penal interest on the excess, so the real cost is above the estimate here.
                </div>
              )}

              {drift != null && Math.abs(drift) >= 1 && (
                <div style={{ marginTop: 10, fontSize: 10, color: C.red, background: C.redBg, borderRadius: 6, padding: "7px 10px" }}>
                  ⚠ Off by {m(fmtAmt(Math.abs(drift), a.currency || "INR"))} vs the bank — BOI last reported {m(fmtAmt(+lastSnap.odAvailAfter, a.currency || "INR"))} available on {lastSnap.date}. A draw or repayment is probably missing from the ledger.
                </div>
              )}
            </div>
          </div>
        );
      })}

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

// ─── Personal Assets ─────────────────────────────────────────────────────────
function AssetDashboard({ assets, rates, onSave, onDelete }) {
  const masked = useMasked();
  const m = makeMask(masked);
  const [form, setForm] = useState(null);
  const [typeFilter, setTypeFilter] = useState("all");
  const [ownerFilter, setOwnerFilter] = useState("all");
  const [sortBy, setSortBy] = useState("value");
  const FI = { width: "100%", border: `1.5px solid ${C.border}`, borderRadius: 7, padding: "9px 11px", fontSize: 13, background: C.surface, color: C.ink };

  const typeMeta = id => ASSET_TYPES.find(t => t.id === id) || ASSET_TYPES[ASSET_TYPES.length - 1];
  const valueOf = a => toINR(+a.currentValue || +a.investedAmount || 0, a.currency || "INR", rates);
  const investedOf = a => toINR(+a.investedAmount || 0, a.currency || "INR", rates);
  const totalValue = assets.reduce((s, a) => s + valueOf(a), 0);
  const totalInvested = assets.reduce((s, a) => s + investedOf(a), 0);
  const gain = totalValue - totalInvested;
  const monthlySip = assets.filter(a => a.active !== false).reduce((s, a) => s + toINR(+a.sipAmount || 0, a.currency || "INR", rates), 0);
  const owners = [...new Set(assets.map(a => a.owner).filter(Boolean))].sort();
  const allocation = ASSET_TYPES.map(t => {
    const value = assets.filter(a => a.type === t.id).reduce((s, a) => s + valueOf(a), 0);
    return { ...t, value, pct: totalValue ? Math.round(value / totalValue * 100) : 0 };
  }).filter(x => x.value > 0);
  const riskSplit = ["Low", "Medium", "High"].map(risk => ({
    risk,
    value: assets.filter(a => (a.risk || "Medium") === risk).reduce((s, a) => s + valueOf(a), 0),
  })).filter(x => x.value > 0);
  const upcoming = assets
    .filter(a => a.maturityDate)
    .map(a => ({ ...a, days: Math.ceil((new Date(a.maturityDate) - new Date(today())) / 86400000) }))
    .filter(a => a.days >= 0 && a.days <= 180)
    .sort((a, b) => a.days - b.days);
  const filtered = assets
    .filter(a => typeFilter === "all" || a.type === typeFilter)
    .filter(a => ownerFilter === "all" || a.owner === ownerFilter)
    .sort((a, b) => sortBy === "maturity"
      ? String(a.maturityDate || "9999").localeCompare(String(b.maturityDate || "9999"))
      : sortBy === "gain"
        ? ((valueOf(b) - investedOf(b)) - (valueOf(a) - investedOf(a)))
        : valueOf(b) - valueOf(a));

  const blank = () => ({ id: uid(), type: "mutual_fund", name: "", owner: "Personal", institution: "", folio: "", currency: "INR", investedAmount: "", currentValue: "", sipAmount: "", sipDay: "", interestRate: "", startDate: today(), maturityDate: "", risk: "Medium", liquidity: "T+3", goal: "", nominee: "", notes: "", active: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const save = async () => {
    if (!form.name?.trim()) return;
    const rec = { ...form, updatedAt: new Date().toISOString() };
    await onSave(rec);
    setForm(null);
  };
  const existingForm = !!(form && assets.some(a => a.id === form.id));
  const removeAsset = async id => {
    const hit = assets.find(a => a.id === id);
    if (!window.confirm(`Delete ${hit?.name || "this asset"}?`)) return;
    await onDelete(id);
    if (form?.id === id) setForm(null);
  };

  const Stat = ({ label, value, sub, color, bg }) => (
    <div style={{ background: bg || C.surface, border: `1.5px solid ${C.border}`, borderRadius: 10, padding: "15px 17px" }}>
      <div style={{ fontSize: 9, fontWeight: 800, color: color || C.inkFaint, textTransform: "uppercase", letterSpacing: .8, marginBottom: 6 }}>{label}</div>
      <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: mob ? 22 : 28, fontWeight: 650, color: color || C.ink, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: C.inkFaint, marginTop: 5 }}>{sub}</div>}
    </div>
  );

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 26, fontWeight: 650 }}>Personal Assets</div>
          <div style={{ fontSize: 12, color: C.inkFaint, marginTop: 2 }}>MFs, SIPs, FDs, PPFs, stocks, gold, property and long-term personal holdings.</div>
        </div>
        <button className="fbp" onClick={() => setForm(blank())}>+ Add Asset</button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr 1fr" : "repeat(4,1fr)", gap: 10, marginBottom: 16 }}>
        <Stat label="Net Worth Tracked" value={m(inrFmt(totalValue))} sub={`${assets.length} asset${assets.length !== 1 ? "s" : ""}`} color={C.ink} bg={C.card} />
        <Stat label="Invested" value={m(inrFmt(totalInvested))} sub="Original capital" color={C.blue} bg={C.blueBg} />
        <Stat label="Gain / Loss" value={m(`${gain >= 0 ? "+" : "-"}${inrFmt(gain)}`)} sub={totalInvested ? `${gain >= 0 ? "+" : ""}${Math.round(gain / totalInvested * 100)}% overall` : "Add invested amount"} color={gain >= 0 ? C.green : C.red} bg={gain >= 0 ? C.greenBg : C.redBg} />
        <Stat label="Monthly SIP" value={m(inrFmt(monthlySip))} sub="Active recurring investments" color={C.teal} bg={C.tealBg} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr" : "1.35fr .95fr", gap: 14, marginBottom: 16 }}>
        <div style={{ background: C.surface, border: `1.5px solid ${C.border}`, borderRadius: 10, padding: "16px 18px" }}>
          <FTag c={C.gold}>Allocation</FTag>
          {allocation.length ? allocation.map(a => (
            <div key={a.id} style={{ marginBottom: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 5 }}>
                <span style={{ color: C.ink, fontWeight: 650 }}>{a.label}</span>
                <span style={{ color: C.inkMid }}>{m(inrFmt(a.value))} · {a.pct}%</span>
              </div>
              <div style={{ height: 7, borderRadius: 4, background: C.card, overflow: "hidden" }}><div style={{ width: `${a.pct}%`, height: "100%", background: a.tone, borderRadius: 4 }} /></div>
            </div>
          )) : <div style={{ fontSize: 13, color: C.inkFaint, padding: "18px 0" }}>Add assets to see allocation.</div>}
          {riskSplit.length > 0 && <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
            {riskSplit.map(r => <span key={r.risk} style={{ fontSize: 11, color: C.inkMid, border: `1px solid ${C.border}`, borderRadius: 999, padding: "5px 9px", background: C.card }}>{r.risk}: {m(inrFmt(r.value))}</span>)}
          </div>}
        </div>

        <div style={{ background: C.surface, border: `1.5px solid ${C.border}`, borderRadius: 10, padding: "16px 18px" }}>
          <FTag c={C.amber}>Upcoming Maturities</FTag>
          {upcoming.length ? upcoming.slice(0, 6).map(a => (
            <div key={a.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "9px 0", borderBottom: `1px solid ${C.border}` }}>
              <div style={{ width: 42, textAlign: "center", color: a.days <= 30 ? C.red : C.amber, fontWeight: 800, fontSize: 13 }}>{a.days}d</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 650, color: C.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.name}</div>
                <div style={{ fontSize: 10, color: C.inkFaint }}>{typeMeta(a.type).label} · {fmtDate(a.maturityDate)}</div>
              </div>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.ink }}>{m(inrFmt(valueOf(a)))}</div>
            </div>
          )) : <div style={{ fontSize: 13, color: C.inkFaint, padding: "18px 0" }}>No maturity dates in the next 180 days.</div>}
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} style={{ ...FI, width: 180 }}>
          <option value="all">All asset types</option>
          {ASSET_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
        <select value={ownerFilter} onChange={e => setOwnerFilter(e.target.value)} style={{ ...FI, width: 170 }}>
          <option value="all">All owners</option>
          {owners.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
        <select value={sortBy} onChange={e => setSortBy(e.target.value)} style={{ ...FI, width: 150 }}>
          <option value="value">Value</option>
          <option value="gain">Gain</option>
          <option value="maturity">Maturity</option>
        </select>
      </div>

      <div style={{ background: C.surface, border: `1.5px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr 96px" : "1.3fr 120px 120px 120px 110px 90px", gap: 10, padding: "9px 14px", background: C.card, borderBottom: `1px solid ${C.border}` }}>
          {["Asset", "Type", "Invested", "Value", "Maturity", ""].slice(0, mob ? 2 : 6).map(h => <div key={h} style={{ fontSize: 9, fontWeight: 800, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .7 }}>{h}</div>)}
        </div>
        {filtered.length ? filtered.map(a => {
          const meta = typeMeta(a.type);
          const val = valueOf(a);
          const inv = investedOf(a);
          const pnl = val - inv;
          return (
            <div key={a.id} onClick={() => setForm(a)} style={{ display: "grid", gridTemplateColumns: mob ? "1fr 96px" : "1.3fr 120px 120px 120px 110px 90px", gap: 10, padding: "12px 14px", borderBottom: `1px solid ${C.border}`, alignItems: "center", cursor: "pointer" }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.name}</div>
                <div style={{ fontSize: 10, color: C.inkFaint, marginTop: 2 }}>{[a.institution, a.owner, a.goal].filter(Boolean).join(" · ") || "Personal"}</div>
                {mob && <div style={{ fontSize: 11, color: pnl >= 0 ? C.green : C.red, marginTop: 4 }}>{m(inrFmt(val))} {inv ? `(${pnl >= 0 ? "+" : "-"}${m(inrFmt(pnl))})` : ""}</div>}
              </div>
              <div><span style={{ fontSize: 10, fontWeight: 750, color: meta.tone, background: meta.bg, borderRadius: 4, padding: "3px 7px" }}>{meta.label}</span></div>
              {!mob && <div style={{ fontSize: 12, color: C.inkMid }}>{m(inrFmt(inv))}</div>}
              {!mob && <div><div style={{ fontSize: 13, fontWeight: 750, color: C.ink }}>{m(inrFmt(val))}</div><div style={{ fontSize: 10, color: pnl >= 0 ? C.green : C.red }}>{inv ? `${pnl >= 0 ? "+" : "-"}${m(inrFmt(pnl))}` : "—"}</div></div>}
              {!mob && <div style={{ fontSize: 12, color: a.maturityDate ? C.inkMid : C.inkFaint }}>{a.maturityDate ? fmtDate(a.maturityDate) : "—"}</div>}
              {!mob && <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }} onClick={e => e.stopPropagation()}>
                <button className="fbs" style={{ fontSize: 11, padding: "4px 8px" }} onClick={() => setForm(a)}>Edit</button>
                <button className="fbs" style={{ fontSize: 11, padding: "4px 8px", color: C.red }} onClick={() => removeAsset(a.id)}>Delete</button>
              </div>}
            </div>
          );
        }) : <div style={{ textAlign: "center", padding: "52px 20px", color: C.inkFaint, fontSize: 13 }}>No personal assets yet.</div>}
      </div>

      {form && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.28)", zIndex: 1000, display: "flex", alignItems: mob ? "stretch" : "center", justifyContent: "center", padding: mob ? 0 : 20 }}>
          <div style={{ background: C.bg, width: mob ? "100%" : 760, maxHeight: mob ? "100%" : "88vh", overflowY: "auto", borderRadius: mob ? 0 : 12, border: `1px solid ${C.border}`, boxShadow: "0 18px 60px rgba(0,0,0,.22)" }}>
            <div style={{ position: "sticky", top: 0, background: C.surface, borderBottom: `1px solid ${C.border}`, padding: "14px 18px", display: "flex", justifyContent: "space-between", alignItems: "center", zIndex: 2 }}>
              <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 22, fontWeight: 650 }}>{existingForm ? "Edit Asset" : "New Asset"}</div>
              <button className="fbs" onClick={() => setForm(null)}>Close</button>
            </div>
            <div style={{ padding: "18px", display: "grid", gridTemplateColumns: mob ? "1fr" : "1fr 1fr", gap: 12 }}>
              <label><FTag>Asset Type</FTag><select value={form.type} onChange={e => set("type", e.target.value)} style={FI}>{ASSET_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}</select></label>
              <label><FTag>Owner</FTag><input value={form.owner || ""} onChange={e => set("owner", e.target.value)} style={FI} placeholder="Personal / Manav / Family" /></label>
              <label style={{ gridColumn: mob ? "auto" : "1/-1" }}><FTag>Name</FTag><input value={form.name || ""} onChange={e => set("name", e.target.value)} style={FI} placeholder="Parag Parikh Flexi Cap / SBI FD / PPF" autoFocus /></label>
              <label><FTag>Institution</FTag><input value={form.institution || ""} onChange={e => set("institution", e.target.value)} style={FI} placeholder="AMC, bank, broker" /></label>
              <label><FTag>Folio / Account</FTag><input value={form.folio || ""} onChange={e => set("folio", e.target.value)} style={FI} placeholder="Optional" /></label>
              <label><FTag>Invested Amount</FTag><input type="number" value={form.investedAmount || ""} onChange={e => set("investedAmount", e.target.value)} style={FI} /></label>
              <label><FTag>Current Value</FTag><input type="number" value={form.currentValue || ""} onChange={e => set("currentValue", e.target.value)} style={FI} /></label>
              <label><FTag>Monthly SIP / Deposit</FTag><input type="number" value={form.sipAmount || ""} onChange={e => set("sipAmount", e.target.value)} style={FI} placeholder="0" /></label>
              <label><FTag>SIP Day</FTag><input type="number" min="1" max="31" value={form.sipDay || ""} onChange={e => set("sipDay", e.target.value)} style={FI} placeholder="5" /></label>
              <label><FTag>Rate %</FTag><input type="number" value={form.interestRate || ""} onChange={e => set("interestRate", e.target.value)} style={FI} placeholder="FD/PPF expected rate" /></label>
              <label><FTag>Currency</FTag><select value={form.currency || "INR"} onChange={e => set("currency", e.target.value)} style={FI}>{Object.keys(CUR_SYM).map(c => <option key={c} value={c}>{c}</option>)}</select></label>
              <label><FTag>Start Date</FTag><input type="date" value={form.startDate || ""} onChange={e => set("startDate", e.target.value)} style={FI} /></label>
              <label><FTag>Maturity / Review Date</FTag><input type="date" value={form.maturityDate || ""} onChange={e => set("maturityDate", e.target.value)} style={FI} /></label>
              <label><FTag>Risk</FTag><select value={form.risk || "Medium"} onChange={e => set("risk", e.target.value)} style={FI}>{["Low", "Medium", "High"].map(x => <option key={x}>{x}</option>)}</select></label>
              <label><FTag>Liquidity</FTag><input value={form.liquidity || ""} onChange={e => set("liquidity", e.target.value)} style={FI} placeholder="Instant / T+3 / locked till maturity" /></label>
              <label><FTag>Goal</FTag><input value={form.goal || ""} onChange={e => set("goal", e.target.value)} style={FI} placeholder="Emergency / Retirement / House / Travel" /></label>
              <label><FTag>Nominee</FTag><input value={form.nominee || ""} onChange={e => set("nominee", e.target.value)} style={FI} /></label>
              <label style={{ gridColumn: mob ? "auto" : "1/-1" }}><FTag>Notes</FTag><textarea value={form.notes || ""} onChange={e => set("notes", e.target.value)} style={{ ...FI, minHeight: 80, resize: "vertical" }} placeholder="Lock-in, tax notes, renewal instruction, exit rule..." /></label>
            </div>
            <div style={{ padding: "14px 18px", borderTop: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", gap: 10, background: C.surface, flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                {existingForm && <button className="fbs" style={{ color: C.red }} onClick={() => removeAsset(form.id)}>Delete</button>}
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: C.inkMid }}><input type="checkbox" checked={form.active !== false} onChange={e => set("active", e.target.checked)} /> Active</label>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="fbs" onClick={() => setForm(null)}>Cancel</button>
                <button className="fbp" onClick={save}>Save Asset</button>
              </div>
            </div>
          </div>
        </div>
      )}
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
function AddTxnForm({ accounts, invoices, purchases, ledgerTxns = [], vendors = [], buyers = [], rates, expenseCats = [], onSave, onSaveClassified, onCancel }) {
  const [type, setType] = useState("credit");
  const [date, setDate] = useState(today());
  const [accountFrom, setAccountFrom] = useState("");
  const [accountTo, setAccountTo] = useState("");
  const [amount, setAmount] = useState("");
  const [convRate, setConvRate] = useState("");
  const [payee, setPayee] = useState("");
  const [notes, setNotes] = useState("");
  const [refType, setRefType] = useState("");
  const [refId, setRefId] = useState("");
  const [err, setErr] = useState("");
  const [canClassify, setCanClassify] = useState(false);
  const txnIdRef = useRef(uid());       // stable id shared by the draft txn + its classification
  const classifyRef = useRef(null);     // inline classifier's imperative handle

  const accFrom = accounts.find(a => a.id === accountFrom);
  const accTo   = accounts.find(a => a.id === accountTo);
  // Same-currency transfer (e.g. bank → cash, both INR) is a plain 1:1 move — no rate needed.
  const sameCur = type === "conversion" && accFrom && accTo && accFrom.currency === accTo.currency;
  const convToAmt = type === "conversion" && amount
    ? (sameCur ? +amount : (convRate ? +amount * +convRate : null))
    : null;
  const activeAccs = accounts.filter(a => a.active);
  const FI = { background: C.surface, border: `1.5px solid ${C.border}`, color: C.ink, borderRadius: 6, padding: mob ? "10px 12px" : "8px 11px", fontSize: mob ? 16 : 13, width: "100%", fontFamily: "inherit" };

  const validateTop = () => {
    if (!date)   return "Date is required";
    if (!amount || +amount <= 0) return "Enter a valid amount";
    if (type === "credit"     && !accountTo)   return "Select destination account";
    if (type === "debit"      && !accountFrom) return "Select source account";
    if (type === "conversion" && (!accountFrom || !accountTo)) return "Select both accounts";
    if (type === "conversion" && !sameCur && (!convRate || +convRate <= 0)) return "Enter conversion rate";
    return "";
  };
  const buildTxn = () => ({
    id: txnIdRef.current, date, type,
    accountFrom: type !== "credit"     ? accountFrom : undefined,
    accountTo:   type !== "debit"      ? accountTo   : undefined,
    amount: +amount,
    convRate: type === "conversion"    ? (sameCur ? 1 : +convRate) : undefined,
    currency: type === "credit" ? accTo?.currency : accFrom?.currency,
    payee, notes,
    refType: refType || undefined,
    refId:   refId   || undefined,
    createdAt: new Date().toISOString(),
  });
  // Live draft handed to the inline classifier so it reads amount/account/direction as you type.
  const draftTxn = buildTxn();
  // Primary save: validate the top fields, then let the inline classifier fire its onSave
  // (which rebuilds the txn and applies the classification) — one action, no popup.
  const submit = () => {
    setErr("");
    const v = validateTop(); if (v) return setErr(v);
    if (type === "conversion") { onSave(buildTxn(), false); return; }
    if (!canClassify) return setErr("Complete the classification below");
    classifyRef.current?.submit();
  };
  // Escape hatch: record the raw entry now, classify later from the ledger.
  const submitRaw = () => {
    setErr("");
    const v = validateTop(); if (v) return setErr(v);
    onSave(buildTxn(), false);
  };
  const handleInlineClassify = (result) => onSaveClassified(buildTxn(), result);

  // Auto-fill from invoice link
  useEffect(() => {
    if (refType === "invoice" && refId) {
      const inv = invoices.find(i => i.id === refId);
      if (inv) {
        setPayee(inv.buyerName || inv.buyerId || "");
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
          <button key={t.id} onClick={() => { setType(t.id); setAccountFrom(""); setAccountTo(""); }}
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
              {sameCur
                ? <div style={{ ...FI, background: C.card, color: C.inkMid, display: "flex", alignItems: "center" }}>1 : 1 · same currency</div>
                : <input type="number" value={convRate} onChange={e => setConvRate(e.target.value)} placeholder="e.g. 85" style={FI} step="0.0001" min="0" />}
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

      {/* Classification — inline, so a manual entry is one flow (no separate popup) */}
      {type !== "conversion" && (
        <div style={{ marginBottom: 18 }}>
          <FTag>Classification</FTag>
          <div style={{ border: `1.5px solid ${C.border}`, borderRadius: 8, padding: mob ? 12 : 14, background: C.card }}>
            <ClassifyTransactionModal
              inline
              key={type}
              ref={classifyRef}
              txn={draftTxn}
              accounts={accounts}
	              vendors={vendors}
	              purchases={purchases}
	              ledgerTxns={ledgerTxns}
	              invoices={invoices}
              buyers={buyers}
              rates={rates}
              expenseCats={expenseCats}
              onValidityChange={setCanClassify}
              onSave={handleInlineClassify}
              onClose={() => {}}
            />
          </div>
        </div>
      )}

      {err && <div style={{ background: C.redBg, color: C.red, borderRadius: 7, padding: "8px 12px", fontSize: 13, marginBottom: 14 }}>{err}</div>}

      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button onClick={submit} className="fbp" disabled={type !== "conversion" && !canClassify} style={type !== "conversion" && !canClassify ? { opacity: .5, cursor: "not-allowed" } : undefined}>{type === "conversion" ? "Save Transfer" : "Save Transaction"}</button>
        <button onClick={onCancel} className="fbs">Cancel</button>
        {type !== "conversion" && <button onClick={submitRaw} style={{ marginLeft: "auto", background: "none", border: "none", color: C.inkFaint, fontSize: 12, cursor: "pointer", textDecoration: "underline", fontFamily: "inherit" }}>Save without classifying</button>}
      </div>
    </div>
  );
}

// ─── Ledger View ──────────────────────────────────────────────────────────────
// ─── Classify Modal ───────────────────────────────────────────────────────────
const EXP_CATS = ["Sea Freight", "Air Freight", "Courier / Local Delivery", "Rent", "Electricity", "Staff / Labour", "Show — Booth Fee", "Show — Travel", "Show — Hotel", "Packaging", "Bank Charges", "GST / Tax Payment", "Repairs & Maintenance", "Petty Cash", "Other"];

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
  const [type,     setType]     = useState(txn.type || "debit");

  const FI2 = { background: C.surface, border: `1px solid ${C.border}`, color: C.ink, borderRadius: 6, padding: "7px 10px", fontSize: 13, fontFamily: "inherit", width: "100%", boxSizing: "border-box" };

  const handleSave = () => {
    const patch = { date, payee, category, notes };
    if (!isConv) {
      patch.amount = amount; patch.currency = currency;
      // Flip Debit (money out) ↔ Credit (money in): move the account to the correct
      // side and reset any now-wrong classification.
      if (type !== txn.type) {
        const acct = txn.type === "credit" ? txn.accountTo : txn.accountFrom;
        if (type === "credit") { patch.type = "credit"; patch.accountTo = acct || ""; patch.accountFrom = ""; }
        else { patch.type = "debit"; patch.accountFrom = acct || ""; patch.accountTo = ""; }
        if (txn.classifiedAs) { patch.classifiedAs = null; patch.classifiedRef = null; patch.classifiedAt = null; }
      }
    }
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
            <div>
              <div style={{ fontSize: 10, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .7, marginBottom: 4 }}>Type</div>
              <div style={{ display: "flex", gap: 8 }}>
                {[["debit", "Debit", C.red], ["credit", "Credit", C.green]].map(([id, label, col]) => (
                  <button key={id} onClick={() => setType(id)} style={{ flex: 1, padding: "9px 10px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 700, fontFamily: "inherit", border: `1.5px solid ${type === id ? col : C.border}`, background: type === id ? col : C.surface, color: type === id ? "#fff" : C.inkMid }}>{label}</button>
                ))}
              </div>
            </div>
          )}
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
  const [editAccTxn,   setEditAccTxn]   = useState(null);
  const [editTxn,      setEditTxn]      = useState(null);
  const [attachTxn,    setAttachTxn]    = useState(null);
  const [selected,     setSelected]     = useState(new Set()); // selected txn ids

  const isBackdated = t => t.createdAt && t.createdAt.slice(0,10) !== t.date;

  // Ledger always shows newest-logged first, so entries you just added surface at
  // the top regardless of their transaction date. The running balance below is
  // computed chronologically so it stays correct despite this display order.
  const sorted = [...transactions].sort((a, b) => (b.createdAt || b.date).localeCompare(a.createdAt || a.date));
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

  // Running balance per row (only meaningful when a single account is selected).
  // Computed in chronological order (txn date, then entry time) so each row shows
  // the correct balance-as-of-that-txn even though the list is displayed newest-first.
  const accObj = accounts.find(a => a.id === filterAcc);
  const { balById, closingBal } = (() => {
    if (!filterAcc || !accObj) return { balById: null, closingBal: null };
    const chron = [...filtered].sort((a, b) =>
      (a.date || "").localeCompare(b.date || "") || (a.createdAt || "").localeCompare(b.createdAt || ""));
    let bal = +(accObj.openingBal || 0);
    const liab = isLiabilityAcc(accObj);
    const m = new Map();
    chron.forEach(t => {
      // Asset-sense delta, then flipped for liability accounts (card/OD), matching
      // computeBalances. Transfers count too — an OD draw is a transfer, and
      // without this the running balance ignored it entirely.
      let delta = 0;
      if (t.type === "credit") delta = +t.amount;
      else if (t.type === "debit") delta = -(+t.amount);
      else if (t.type === "conversion") {
        delta = t.accountFrom === filterAcc ? -(+t.amount) : (+t.amount) * (+t.convRate || 1);
      }
      bal += liab ? -delta : delta;
      m.set(t.id, bal);
    });
    return { balById: m, closingBal: bal };
  })();
  const runningBals = balById ? filtered.map(t => balById.get(t.id)) : null;

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
      const bal    = balById ? (balById.get(t.id) || 0).toFixed(2) : "";
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
	        <ClassifyTransactionModal
          txn={classifyTxn}
          accounts={accounts}
	          vendors={vendors}
	          purchases={purchases}
	          ledgerTxns={transactions}
	          invoices={invoices}
          buyers={buyers}
          rates={rates}
          expenseCats={EXP_CATS}
          onSave={(result) => { onClassify(classifyTxn.id, result); }}
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
          {closingBal != null && <span style={{ color: C.inkMid, marginLeft: "auto" }}>Closing: ₹{closingBal.toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2})}</span>}
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
function AccountsSettings({ accounts, rates, balances, onUpdate, onUpdateRates, onFetchRates, fetchingRates, onAdjustBalance, onReassignTxns }) {
  const masked = useMasked();
  const m = makeMask(masked);
  const [editRates,  setEditRates]  = useState(false);
  const [ratesDraft, setRatesDraft] = useState({ ...rates });
  const [addingAcc,  setAddingAcc]  = useState(false);
  const [newAcc, setNewAcc] = useState({ name: "", type: "bank", currency: "INR", openingBal: 0, active: true, creditLimit: 0, billingDueDay: 0 });
  const [deleteModal, setDeleteModal] = useState(null); // { acc, moveTo }
  const [moveToId, setMoveToId] = useState("");
  const [correctingId, setCorrectingId] = useState(null); // account id being reconciled
  const [correctVal, setCorrectVal] = useState("");

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
  const odAccs   = accounts.filter(a => a.type === "od");
  const updateAccField = (id, patch) => onUpdate(accounts.map(a => a.id === id ? { ...a, ...patch } : a));

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
                    {onAdjustBalance && (correctingId === acc.id
                      ? <div style={{ display: "flex", gap: 5, marginTop: 5, alignItems: "center" }}>
                          <input
                            autoFocus type="number" step="0.01" value={correctVal} placeholder="Correct bal."
                            onChange={e => setCorrectVal(e.target.value)}
                            onKeyDown={e => { if (e.key === "Enter" && correctVal !== "") { onAdjustBalance(acc.id, +correctVal); setCorrectingId(null); } if (e.key === "Escape") setCorrectingId(null); }}
                            style={{ ...FI, width: 92, padding: "4px 7px", fontSize: 12 }} />
                          <button onClick={() => { if (correctVal !== "") onAdjustBalance(acc.id, +correctVal); setCorrectingId(null); }} className="fbp" style={{ fontSize: 11, padding: "4px 9px" }}>Set</button>
                          <button onClick={() => setCorrectingId(null)} className="fbs" style={{ fontSize: 11, padding: "4px 9px" }}>✕</button>
                        </div>
                      : <div onClick={() => { setCorrectingId(acc.id); setCorrectVal(""); }} title="Reconcile to today's real balance without finding the missing transaction" style={{ fontSize: 10, color: C.gold, cursor: "pointer", marginTop: 3, textDecoration: "underline dotted" }}>Correct balance…</div>
                    )}
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

      {/* Overdrafts */}
      {odAccs.length > 0 && (
        <div style={{ background: C.surface, border: `1.5px solid ${C.border}`, borderRadius: 10, padding: "18px 20px", marginBottom: 22 }}>
          <div style={{ fontWeight: 600, fontSize: 14, color: C.ink, marginBottom: 4 }}>🏛 Overdraft Accounts</div>
          <div style={{ fontSize: 11, color: C.inkFaint, marginBottom: 12 }}>
            The OD is secured against the FD, so its rate moves with the FD. When the FD renews at a new rate, change the FD rate here and the interest estimate follows.
          </div>
          {odAccs.map(a => {
            const drawn = Math.max(0, balances[a.id] || 0);
            return (
              <div key={a.id} style={{ padding: "12px 0", borderBottom: `1px solid ${C.border}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>{a.name}</div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 16, fontWeight: 600, color: drawn > 0 ? C.red : C.green }}>{m(fmtAmt(drawn, a.currency || "INR"))}</div>
                    <div style={{ fontSize: 10, color: C.inkFaint }}>drawn · {odRate(a).toFixed(2)}% p.a.</div>
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr 1fr" : "repeat(4, 1fr)", gap: 8 }}>
                  <div><FTag>Sanctioned Limit</FTag><input type="number" value={a.odLimit || ""} onChange={e => updateAccField(a.id, { odLimit: +e.target.value })} style={FI} /></div>
                  <div><FTag>FD Rate %</FTag><input type="number" step="0.01" value={a.odFdRate ?? ""} onChange={e => updateAccField(a.id, { odFdRate: +e.target.value })} style={FI} /></div>
                  <div><FTag>Spread %</FTag><input type="number" step="0.01" value={a.odSpread ?? ""} onChange={e => updateAccField(a.id, { odSpread: +e.target.value })} style={FI} /></div>
                  <div><FTag>OD A/c Number</FTag><input value={a.odAccountNo || ""} onChange={e => updateAccField(a.id, { odAccountNo: e.target.value.trim() })} style={FI} placeholder="006427280000008" /></div>
                </div>
                <div style={{ marginTop: 8 }}>
                  <FTag>Linked Current Account</FTag>
                  <select value={a.odLinkedAccountId || ""} onChange={e => updateAccField(a.id, { odLinkedAccountId: e.target.value })} style={{ ...FI, width: "100%" }}>
                    <option value="">— none —</option>
                    {accounts.filter(x => x.type === "bank").map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
                  </select>
                  <div style={{ fontSize: 10, color: C.inkFaint, marginTop: 4 }}>Draws forwarded from the BOI SMS are booked between these two accounts.</div>
                </div>
              </div>
            );
          })}
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
            <div><FTag>Type</FTag><select value={newAcc.type} onChange={e => setNewAcc(a => ({ ...a, type: e.target.value }))} style={FI}><option value="cash">Cash</option><option value="bank">Bank Account</option><option value="credit_card">Credit Card</option><option value="od">Overdraft</option></select></div>
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
                {newAcc.type === "od" && (
                  <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr 1fr" : "repeat(4, 1fr)", gap: 8, marginTop: 8 }}>
                    <div><FTag>Sanctioned Limit</FTag><input type="number" value={newAcc.odLimit || ""} onChange={e => setNewAcc(a => ({ ...a, odLimit: +e.target.value }))} placeholder="e.g. 1620000" style={FI} /></div>
                    <div><FTag>FD Rate %</FTag><input type="number" step="0.01" value={newAcc.odFdRate || ""} onChange={e => setNewAcc(a => ({ ...a, odFdRate: +e.target.value }))} placeholder="7.3" style={FI} /></div>
                    <div><FTag>Spread %</FTag><input type="number" step="0.01" value={newAcc.odSpread || ""} onChange={e => setNewAcc(a => ({ ...a, odSpread: +e.target.value }))} placeholder="1" style={FI} /></div>
                    <div><FTag>OD A/c Number</FTag><input value={newAcc.odAccountNo || ""} onChange={e => setNewAcc(a => ({ ...a, odAccountNo: e.target.value.trim() }))} style={FI} /></div>
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
function PdfImportModal({ txns, acc, accTxns = [], onApply, onClose, openingBalance = null, closingBalance = null }) {
  const CUR = acc?.currency || "INR";
  const sym = { INR: "₹", USD: "$", EUR: "€", JPY: "¥", GBP: "£", AUD: "A$" }[CUR] || CUR;
  const f2 = n => (+n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtAmt = n => sym + f2(Math.abs(n));

  // Bank statement is the source of truth. Match statement rows to ledger
  // entries one-to-one (date ±2 days, amount ±0.5, same direction) so one
  // ledger entry can't cover two identical statement rows.
  const usedLedgerIds = new Set();
  const enriched = txns.map(t => {
    const amt = +t.amount;
    const tDate = new Date(t.date).getTime();
    const hit = accTxns.find(l => {
      if (usedLedgerIds.has(l.id)) return false;
      const diff = Math.abs(new Date(l.date).getTime() - tDate) / 86400000;
      return diff <= 2 && Math.abs(+l.amount - amt) < 0.5 && l.type === t.type;
    });
    if (hit) usedLedgerIds.add(hit.id);
    return { ...t, matched: !!hit };
  });
  // Ledger entries inside the statement window that no statement row matched —
  // per bank-as-truth these are suspect (wrong direction, duplicate, typo date).
  const stmtTimes = txns.map(t => new Date(t.date).getTime()).filter(n => !isNaN(n));
  const extras = stmtTimes.length ? accTxns.filter(l => {
    if (usedLedgerIds.has(l.id)) return false;
    const d = new Date(l.date).getTime();
    return d >= Math.min(...stmtTimes) - 2 * 86400000 && d <= Math.max(...stmtTimes) + 2 * 86400000;
  }) : [];

  // Opening balance: offer to set the account's opening balance to the statement's
  // opening so the running balance ties out. Default ON only when the account has no
  // ledger entries on/before the statement start — otherwise we'd clobber real history.
  const stmtStart = txns.length ? txns.map(t => t.date).sort()[0] : "";
  const hasPriorHistory = accTxns.some(l => l.date && stmtStart && l.date <= stmtStart);
  const canSetOpening = openingBalance != null;
  // Default: select only unmatched transactions
  const [sel, setSel] = useState(() => new Set(enriched.map((t, i) => t.matched ? -1 : i).filter(i => i >= 0)));
  const [selRm, setSelRm] = useState(new Set());
  const [setOpening, setSetOpening] = useState(() => canSetOpening && !hasPriorHistory);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const toggleRm = id => setSelRm(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

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
    const toRemove = extras.filter(x => selRm.has(x.id)).map(x => x.id);
    await onApply({ add: toAdd, removeIds: toRemove, openingBalance: setOpening && canSetOpening ? +openingBalance : null, accountId: acc?.id });
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

          {/* ── Wrong-account guard: a real statement should match at least something ── */}
          {!done && enriched.length >= 10 && matchedCount === 0 && (
            <div style={{ background: "#fff8e6", border: "1px solid #f0dfae", borderRadius: 8, padding: "8px 12px", marginBottom: 12, fontSize: 12, color: "#8a6d1a" }}>
              ⚠ None of these {enriched.length} rows match anything in <strong>{acc?.name}</strong> — double-check you've selected the right account before importing.
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

          {/* ── Ledger entries the bank statement doesn't have (bank = source of truth) ── */}
          {!done && extras.length > 0 && (
            <>
              <div style={{ padding: "12px 8px 8px", fontSize: 10, fontWeight: 700, color: "#c0392b", textTransform: "uppercase", letterSpacing: .5, background: "#fdf6f5", borderTop: "1px solid #f5e0dc" }}>
                In ledger but not on bank statement ({extras.length}) — tick to remove
              </div>
              {extras.map(l => {
                const isCredit = l.type === "credit";
                const checked = selRm.has(l.id);
                return (
                  <div key={l.id} onClick={() => toggleRm(l.id)}
                    style={{ display: "grid", gridTemplateColumns: "28px 1fr 90px 90px 110px 76px", gap: 0, padding: "10px 8px", borderBottom: "1px solid #f5f3f0", background: checked ? "#fdf1ef" : "#fff", cursor: "pointer", transition: "background .12s", alignItems: "center" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <input type="checkbox" checked={checked} readOnly style={{ width: 13, height: 13, accentColor: "#c0392b", cursor: "pointer" }} />
                    </div>
                    <div style={{ minWidth: 0, paddingRight: 8 }}>
                      <div style={{ fontSize: 12, fontWeight: 500, color: "#111", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 5 }}>
                        {l.payee || "—"}
                        {badge("NOT ON BANK", "#c0392b", "#fdecea")}
                      </div>
                      <div style={{ fontSize: 10, color: "#bbb", marginTop: 1 }}>{l.date}{l.category ? ` · ${l.category}` : ""}</div>
                    </div>
                    <div style={{ textAlign: "right", fontSize: 12, fontWeight: 600, color: "#c0392b", padding: "0 4px" }}>{!isCredit ? f2(l.amount) : ""}</div>
                    <div style={{ textAlign: "right", fontSize: 12, fontWeight: 600, color: "#2d7a4f", padding: "0 4px" }}>{isCredit ? f2(l.amount) : ""}</div>
                    <div />
                    <div style={{ textAlign: "right", fontSize: 11, fontWeight: 700, color: checked ? "#c0392b" : "#aaa", padding: "0 4px" }}>{checked ? "Remove" : "Keep"}</div>
                  </div>
                );
              })}
            </>
          )}
        </div>

        {/* ── Opening-balance option: makes the running balance tie out to the bank ── */}
        {!done && canSetOpening && (
          <div style={{ padding: "10px 20px 0", flexShrink: 0, background: "#fff" }}>
            <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer", background: setOpening ? "#f0f7f2" : "#faf9f7", border: `1px solid ${setOpening ? "#bfe0cc" : "#ede9e3"}`, borderRadius: 10, padding: "10px 12px" }}>
              <input type="checkbox" checked={setOpening} onChange={e => setSetOpening(e.target.checked)} style={{ width: 14, height: 14, accentColor: "#2d7a4f", cursor: "pointer", marginTop: 1 }} />
              <div style={{ fontSize: 12, color: "#444", lineHeight: 1.45 }}>
                Set <strong>{acc?.name}</strong> opening balance to <strong>{sym}{f2(openingBalance)}</strong> (as of {stmtStart || stmtStartDate}) so the ledger balance ties out to the bank.
                {hasPriorHistory && <div style={{ color: "#c0392b", fontWeight: 700, marginTop: 3 }}>⚠ This account already has entries on/before that date — turning this on overwrites its current opening balance.</div>}
              </div>
            </label>
          </div>
        )}

        {/* ── Footer ── */}
        {!done && (
          <div style={{ padding: "14px 20px", borderTop: "1px solid #ede9e3", flexShrink: 0, background: "#fff", display: "flex", gap: 10, alignItems: "center" }}>
            <div style={{ flex: 1, fontSize: 12, color: "#888" }}>
              {sel.size > 0 || selRm.size > 0
                ? <>{sel.size} selected · {matchedCount} already in ledger{selRm.size > 0 ? <> · <span style={{ color: "#c0392b", fontWeight: 700 }}>{selRm.size} to remove</span></> : null}{importDiff != null ? ` · ${Math.abs(importDiff) < 1 ? "statement closes" : `remaining ${importDiff >= 0 ? "+" : ""}${sym}${f2(importDiff)}`}` : ""}</>
                : <>{newCount} new · {matchedCount} already matched{extras.length > 0 ? ` · ${extras.length} not on bank` : ""}</>}
            </div>
            {(() => { const obOnly = setOpening && canSetOpening; const nothing = sel.size === 0 && selRm.size === 0 && !obOnly; return (
            <button onClick={handleAdd} disabled={saving || nothing}
              style={{ background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 10, padding: "11px 24px", fontSize: 13, fontWeight: 700, cursor: nothing ? "not-allowed" : "pointer", opacity: nothing ? .35 : 1, whiteSpace: "nowrap" }}>
              {saving ? "Applying…" : nothing ? "Nothing to apply" : `${sel.size > 0 ? `Add ${sel.size}` : ""}${sel.size > 0 && selRm.size > 0 ? " · " : ""}${selRm.size > 0 ? `Remove ${selRm.size}` : ""}${(sel.size > 0 || selRm.size > 0) && obOnly ? " · " : ""}${obOnly ? "Set opening bal" : ""} →`}
            </button>
            ); })()}
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

// Classify queue. Runs the SAME structured classifier as the Accounting Journal
// (ClassifyTransactionModal) — so a payment classified here is fully linked to its
// bill / invoice / vendor / card, not just tagged with a loose category. What this
// view adds on top is throughput: a filtered queue, one-key Save & next, and a
// progress read-out, so hundreds of imported bank rows can be worked through fast.
function ExpenseSplitView({ transactions, accounts, vendors = [], purchases = [], invoices = [], buyers = [], rates, company = "ng", onClassify }) {
  const [selected,     setSelected]     = useState(null);
  const [tab,          setTab]          = useState("unclassified");
  const [filterAcc,    setFilterAcc]    = useState("");
  const [filterMonth,  setFilterMonth]  = useState("");
  const [saving,       setSaving]       = useState(false);
  const [canSave,      setCanSave]      = useState(false);
  const [mobPanel,     setMobPanel]     = useState(false);
  const classifyRef = useRef();
  const listRef = useRef();

  // "Unclassified" here means *not structurally classified* — a bank-import category
  // like "UPI" is not an accounting classification.
  const needsClassify = t => !t.classifiedAs;

  const months = [...new Set(transactions.map(t => t.date?.slice(0,7)).filter(Boolean))].sort().reverse();
  const getAcc = id => accounts.find(a => a.id === id);

  const filtered = [...transactions]
    .filter(t => {
      if (filterAcc && t.accountFrom !== filterAcc && t.accountTo !== filterAcc) return false;
      if (filterMonth && !(t.date||"").startsWith(filterMonth)) return false;
      if (tab === "unclassified" && !needsClassify(t)) return false;
      return true;
    })
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  const unclassCount = transactions.filter(needsClassify).length;
  const doneCount = transactions.length - unclassCount;
  const pct = transactions.length ? Math.round(doneCount / transactions.length * 100) : 100;
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
  const pick = id => { setSelected(id); if (mob) setMobPanel(true); };

  // Save the structured classification, then jump to the next in the queue. The
  // saved row leaves the "unclassified" list, so the next id is captured up front.
  const saveAndNext = async () => {
    if (!selTxn || saving || !classifyRef.current?.submit) return;
    const nextId = filtered[selIdx + 1]?.id || null;
    setSaving(true);
    try {
      await classifyRef.current.submit();
      if (nextId) setSelected(nextId);
      else if (mob) setMobPanel(false);
    } finally { setSaving(false); }
  };

  const FI = { background: C.surface, border: `1px solid ${C.border}`, color: C.ink, borderRadius: 6, padding: "5px 9px", fontSize: 12, fontFamily: "inherit" };

  return (
    <div style={{ display: "flex", height: "calc(100vh - 148px)", borderRadius: 14, border: `1px solid ${C.border}`, overflow: "hidden", background: C.surface }}>

      {/* ── LEFT: list ── */}
      <div style={{ width: mob ? "100%" : 340, flexShrink: 0, borderRight: `1px solid ${C.border}`, display: mob && mobPanel ? "none" : "flex", flexDirection: "column", background: C.surface }}>
        {/* Filters */}
        <div style={{ padding: "12px 12px 10px", borderBottom: `1px solid ${C.border}`, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {[
              { id: "unclassified", label: `Unclassified${unclassCount > 0 ? ` (${unclassCount})` : ""}` },
              { id: "all",          label: "All" },
            ].map(t => (
              <button key={t.id} onClick={() => setTab(t.id)} style={{ fontSize: 11, padding: "5px 12px", borderRadius: 20, border: "none", cursor: "pointer", fontWeight: 600, background: tab === t.id ? C.ink : C.card, color: tab === t.id ? "#fff" : C.inkMid }}>{t.label}</button>
            ))}
          </div>
          {/* Progress — linked, not just tagged */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ flex: 1, height: 5, background: C.card, borderRadius: 3, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${pct}%`, background: pct === 100 ? C.green : C.gold, borderRadius: 3, transition: "width .4s" }} />
            </div>
            <span style={{ fontSize: 10, fontWeight: 700, color: C.inkFaint, whiteSpace: "nowrap" }}>{doneCount}/{transactions.length} linked</span>
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
            const unclass = needsClassify(t);
            const meta = CLASSIFY_META[t.classifiedAs];
            const accName = getAcc(t.accountFrom || t.accountTo)?.name || "";
            return (
              <div key={t.id} onClick={() => pick(t.id)}
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
                    <div style={{ fontSize: 10, marginTop: 2, color: meta ? meta.color : C.inkFaint, fontWeight: meta ? 700 : 400 }}>
                      {meta ? meta.label : unclass ? "· unclassified" : t.category}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── RIGHT: classify panel — the real, fully-linked classifier ── */}
      {(!mob || mobPanel) && (
        <div style={{ flex: 1, minHeight: 0, background: "#fafaf8", display: "flex", flexDirection: "column" }}>
          {!selTxn ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: C.inkFaint, fontSize: 14 }}>
              Select a transaction to classify
            </div>
          ) : (
            <>
            {/* Scroll area — the action bar below stays pinned, never covering content */}
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: mob ? "14px 14px" : "20px 24px" }}>
              {/* Nav */}
              <div style={{ display: "flex", gap: 8, marginBottom: 16, alignItems: "center" }}>
                {mob && <button onClick={() => setMobPanel(false)} style={{ ...FI, cursor: "pointer" }}>← List</button>}
                {!mob && <>
                  <button onClick={() => goTo(selIdx - 1)} disabled={selIdx <= 0} style={{ ...FI, cursor: selIdx > 0 ? "pointer" : "default", opacity: selIdx > 0 ? 1 : .4 }}>← Prev</button>
                  <button onClick={() => goTo(selIdx + 1)} disabled={selIdx >= filtered.length - 1} style={{ ...FI, cursor: selIdx < filtered.length - 1 ? "pointer" : "default", opacity: selIdx < filtered.length - 1 ? 1 : .4 }}>Next →</button>
                </>}
                <div style={{ fontSize: 11, color: C.inkFaint, marginLeft: "auto" }}>{selIdx + 1} / {filtered.length}</div>
              </div>

              {/* Txn card */}
              <div style={{ background: C.surface, borderRadius: 14, padding: "16px 20px", marginBottom: 16, border: `1px solid ${C.border}` }}>
                <div style={{ fontSize: 11, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .6, marginBottom: 6 }}>
                  {fmtDate(selTxn.date)} · {getAcc(selTxn.accountFrom || selTxn.accountTo)?.name || ""}
                </div>
                <div style={{ fontSize: 14, fontWeight: 700, color: C.ink, marginBottom: 8, wordBreak: "break-word" }}>
                  {selTxn.payee || selTxn.notes || "—"}
                </div>
                <div style={{ fontSize: 30, fontWeight: 800, color: selTxn.type === "credit" ? C.green : C.red, fontFamily: "'Cormorant Garamond', serif" }}>
                  {selTxn.type === "credit" ? "+" : "−"}₹{(+selTxn.amount).toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                </div>
                {selTxn.classifiedAs && (
                  <div style={{ marginTop: 10, fontSize: 11, fontWeight: 700, background: (CLASSIFY_META[selTxn.classifiedAs]?.color || C.inkFaint) + "22", border: `1px solid ${CLASSIFY_META[selTxn.classifiedAs]?.color || C.border}`, color: CLASSIFY_META[selTxn.classifiedAs]?.color || C.inkMid, display: "inline-block", padding: "3px 10px", borderRadius: 20 }}>
                    ✓ {CLASSIFY_META[selTxn.classifiedAs]?.label || selTxn.classifiedAs}{selTxn.classifiedRef?.cat ? ` · ${selTxn.classifiedRef.cat}` : ""}
                  </div>
                )}
              </div>

              {/* The shared classifier — identical logic to the Accounting Journal */}
              <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: mob ? "14px 14px" : "18px 20px" }}>
                <ClassifyTransactionModal
                  inline
                  key={selTxn.id}
                  ref={classifyRef}
                  txn={selTxn}
                  accounts={accounts}
                  vendors={vendors}
                  purchases={purchases}
                  ledgerTxns={transactions}
                  invoices={invoices}
                  buyers={buyers}
                  rates={rates}
                  company={company}
                  expenseCats={EXP_CATS}
                  onValidityChange={setCanSave}
                  onSave={result => onClassify(selTxn.id, result)}
                  onClose={() => {}}
                />
              </div>
            </div>

            {/* Action bar — pinned below the scroll area, the throughput this view exists for */}
            <div style={{ flexShrink: 0, display: "flex", gap: 10, alignItems: "center", background: C.surface, borderTop: `1px solid ${C.border}`, padding: mob ? "10px 14px" : "12px 24px", boxShadow: "0 -4px 14px rgba(26,19,8,.05)" }}>
              <div style={{ fontSize: 11, color: C.inkFaint, whiteSpace: "nowrap" }}>{!canSave && "Pick a type to continue"}</div>
              <div style={{ flex: 1 }} />
              {selIdx < filtered.length - 1 && (
                <button onClick={() => goTo(selIdx + 1)} style={{ ...FI, padding: "11px 16px", cursor: "pointer" }}>Skip</button>
              )}
              <button onClick={saveAndNext} disabled={!canSave || saving}
                style={{ minWidth: mob ? 150 : 200, background: C.ink, color: "#FAF0DC", border: "none", borderRadius: 10, padding: "12px 18px", fontSize: 13.5, fontWeight: 700, cursor: (!canSave || saving) ? "not-allowed" : "pointer", opacity: (!canSave || saving) ? .4 : 1 }}>
                {saving ? "Saving…" : selIdx < filtered.length - 1 ? "Save & next →" : "Save classification"}
              </button>
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

function ReconcileView({ accounts, transactions, onAddTxns, onApplyTxns, company }) {
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
      {pdfModal && <PdfImportModal txns={pdfModal.txns} acc={acc} accTxns={accTxns} onApply={onApplyTxns} openingBalance={pdfModal.openingBalance} closingBalance={pdfModal.closingBalance} onClose={() => { setPdfModal(null); setPdfName(""); }} />}
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
// ─── Money Flow ───────────────────────────────────────────────────────────────
// Cash-basis view of where money actually comes from and goes. Buckets are
// resolved from the explicit category first, then payee/notes keywords; anything
// unresolvable lands in "Uncategorised" — surfaced loudly, with inline classify
// so the unknown share shrinks as you use it. Credit-card bill payments and
// internal conversions are transfers, not spend (they'd double-count the card's
// own transactions), so they're excluded from buckets and footnoted instead.
const FLOW_INCOME = [
  { id: "payouts",  label: "Marketplace payouts",     sub: "Etsy · Payoneer",        icon: "🛍", color: "#2D7A4F", kw: ["payoneer"] },
  { id: "wires",    label: "Export wire remittances", sub: "Inward · SWIFT",         icon: "🌍", color: "#3F8FA8", kw: ["inward", "irm0", "cre001", "remittance"] },
  { id: "domestic", label: "Domestic & direct sales", sub: "Razorpay · Paytm · UPI", icon: "🇮🇳", color: "#7A5EA8", kw: ["razorpay", "paytm", "sales receipt", "customer_receipt", "payment received", "receipt"] },
  { id: "otherIn",  label: "Other income",            sub: "Refunds · adjustments",  icon: "↩️", color: "#8A8A5E", kw: [] },
];
const FLOW_EXPENSE = [
  { id: "shipping",  label: "Shipping & couriers",   icon: "📦", color: "#4A7DB5", cats: ["air freight", "sea freight", "freight", "courier / local delivery", "land freight / courier", "shipping"], kw: ["ship", "delhiv", "porter", "courier", "bigfoot", "bigf", "bluedart", "dtdc", "fedex", "dhl", "department of posts", "nandan"] },
  { id: "stock",     label: "Stock & vendor payments", icon: "💎", color: "#7A5EA8", cats: ["vendor payment", "vendor_bill", "vendor_po"], kw: ["nikhil gems", "indbh", "emporium"] },
  { id: "team",      label: "Team & owner",          icon: "👤", color: "#B5764A", cats: ["salary", "staff / labour"], kw: ["salary", "madiha", "manav jhaveri"] },
  { id: "marketing", label: "Marketing & ads",       icon: "📢", color: "#C24E6A", cats: ["marketing"], kw: ["facebook", "face/", "meta ads", "instagram"] },
  { id: "software",  label: "Software & subs",       icon: "💻", color: "#3F8FA8", cats: ["software", "ai", "subscription", "payment"], kw: ["openai", "open ai", "shopify", "apple", "google", "canva", "adobe", "zoho", "subscription"] },
  { id: "office",    label: "Office, rent & utilities", icon: "🏢", color: "#8A8A5E", cats: ["utilities", "internet", "electricity", "rent", "repairs & maintenance"], kw: ["jio", "airtel", "electricity"] },
  { id: "food",      label: "Food & lifestyle",      icon: "🍽", color: "#C99A3C", cats: ["food", "food & dining", "groceries", "movies", "entertainment"], kw: ["blinkit", "swiggy", "zomato", "zoma", "cafe", "coffee", "restaurant", "neuma", "nutcracker", "gourmet", "book my show", "benne", "subko"] },
  { id: "shopping",  label: "Shopping & supplies",   icon: "🛒", color: "#A87456", cats: ["shopping", "packaging & supplies", "packaging", "equipment"], kw: ["amazon", "flipkart", "ikea", "furnitur"] },
  { id: "travel",    label: "Travel & shows",        icon: "✈️", color: "#5EA88A", cats: ["show — hotel", "show — travel", "show — booth fee", "travel", "transport"], kw: ["goibibo", "makemytrip", "hotel", "irctc", "uber", "ola", "flight"] },
  { id: "bank",      label: "Bank & card charges",   icon: "🏦", color: "#79553D", cats: ["bank charges"], kw: ["bank charge", " fee", "annual charge"] },
  { id: "taxes",     label: "Taxes & government",    icon: "🏛", color: "#6B6B6B", cats: ["gst / tax payment", "tax"], kw: ["gst payment", "income tax", "customs duty"] },
  { id: "misc",      label: "Misc (classified)",     icon: "🗂", color: "#9A9A9A", cats: ["petty cash", "business", "health"], kw: [] },
];
const FLOW_METHOD_CATS = new Set(["upi", "neft", "imps", "atm", "transfer", "other", ""]);

// Bank narration → something a human can scan.
// "IMPS/P2A/609716723034/BARB/MADIHA MOHAME" → { name:"Madiha Mohame",
//  via:"IMPS", ref:"…723034" }. Anything we can't confidently parse is passed
// through untouched rather than mangled.
const NARRATION_NOISE = new Set(["p2a", "p2m", "p2p", "tpt", "mmt", "nft", "chq", "ib", "inb", "mb", "ecom", "cms", "bil", "bulk", "ft", "dr", "cr", "ach", "sb", "ca"]);
const NARRATION_VIA   = new Set(["imps", "neft", "rtgs", "upi", "ach", "atm", "pos", "nach", "ecs", "swift"]);
const titleCase = s => s.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
function prettyPayee(raw = "") {
  const s = String(raw).trim();
  if (!s) return { name: "—", via: "", ref: "" };
  const parts = s.split(/[/|\\]+/).map(x => x.trim()).filter(Boolean);
  if (parts.length < 3) return { name: /^[A-Z0-9 .&'-]+$/.test(s) ? titleCase(s) : s, via: "", ref: "" };

  const via  = NARRATION_VIA.has(parts[0].toLowerCase()) ? parts[0].toUpperCase() : "";
  const digits = parts.filter(p => /^\d{6,}$/.test(p)).sort((a, b) => b.length - a.length)[0] || "";
  const words = parts.filter(p => {
    const l = p.toLowerCase();
    return /[a-z]/i.test(p) && !NARRATION_NOISE.has(l) && !NARRATION_VIA.has(l) && !/^\d+$/.test(p);
  });
  // Bank IFSC-ish codes (BARB, BKID, HDFC…) are exactly 4 caps with no space.
  // Among what's left, the real name is the wordiest token — a full name beats a
  // handle, and on a tie the earlier token wins (UPI puts the merchant first,
  // trailing tokens are usually handles like "paytmqr").
  const named = words.filter(p => !/^[A-Z]{4}$/.test(p) && p.replace(/[^a-z]/gi, "").length > 3);
  const score = p => p.replace(/[^a-z]/gi, "").length + (/\s/.test(p) ? 8 : 0);
  const pick  = named.reduce((best, p) => (best === null || score(p) > score(best) ? p : best), null);
  if (!pick) return { name: s, via, ref: "" };
  return {
    name: /^[A-Z0-9 .&'-]+$/.test(pick) ? titleCase(pick) : pick,
    via,
    ref: digits ? "…" + digits.slice(-6) : "",
  };
}
function flowBucketOf(t) {
  const cat = String(t.category || "").toLowerCase().trim();
  const hay = `${t.payee || ""} ${t.notes || ""}`.toLowerCase();
  if (t.type === "conversion" || t.classifiedAs === "cc_payment" || cat === "cc_payment" || cat === "credit card") return { side: "transfer" };
  if (t.type === "credit") {
    for (const b of FLOW_INCOME) if (b.kw.some(k => hay.includes(k) || cat.includes(k))) return { side: "in", bucket: b };
    if (cat === "customer_receipt" || cat.includes("sales") || cat.includes("receipt")) return { side: "in", bucket: FLOW_INCOME[2] };
    return { side: "in", bucket: FLOW_INCOME[3] };
  }
  // Debit: explicit category wins when it's a real category (not a payment method)
  if (!FLOW_METHOD_CATS.has(cat)) {
    for (const b of FLOW_EXPENSE) if (b.cats.includes(cat)) return { side: "out", bucket: b };
  }
  for (const b of FLOW_EXPENSE) if (b.kw.length && b.kw.some(k => hay.includes(k))) return { side: "out", bucket: b };
  if (!FLOW_METHOD_CATS.has(cat)) return { side: "out", bucket: FLOW_EXPENSE.find(b => b.id === "misc") };
  return { side: "out", bucket: null }; // Uncategorised
}
// Chip → canonical category string (resolves back to the same bucket)
const FLOW_CHIPS = [
  ["📦 Shipping", "Courier / Local Delivery"], ["💎 Vendor", "Vendor Payment"], ["👤 Staff", "Staff / Labour"],
  ["📢 Marketing", "Marketing"], ["💻 Software", "Software"], ["🍽 Food", "Food"], ["🏢 Utilities", "Utilities"],
  ["🛒 Shopping", "Shopping"], ["✈️ Travel", "Travel"], ["🏦 Bank", "Bank Charges"], ["🏛 Tax", "GST / Tax Payment"],
];

// ─── Balance trajectory ───────────────────────────────────────────────────────
// The one chart the eye goes to first: total balance across all accounts as a
// continuous line, reconstructed backwards from today's known balance through
// each day's net flow. Beneath it, a daily flow lane — inflows grow up, outflows
// grow down — so every rise and dip in the curve has its cause directly under it.
// Hover anywhere for the day's balance, money in, and money out.
function BalanceChart({ transactions, months, rates, totalINR, selMo, fmtL, m }) {
  const wrapRef = useRef(null);
  const [w, setW] = useState(0);
  const [hover, setHover] = useState(null); // index into days
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el); setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const toINR = t => (+t.amount || 0) * (t.currency && t.currency !== "INR" ? (+rates?.[t.currency] || 1) : 1);
  const sfmt = v => (v < 0 ? "−" : "") + fmtL(v); // fmtL drops the sign; balances can go negative

  // ── Reconstruct the daily series ──
  const { days, flows } = (() => {
    const today = new Date(); today.setHours(12, 0, 0, 0);
    const txns = (transactions || []).filter(t => t.date);
    const first = txns.reduce((a, t) => (!a || t.date < a ? t.date : a), null);
    const start = months
      ? new Date(today.getTime() - months * 30.44 * 86400000)
      : (first ? new Date(first + "T12:00:00") : today);
    const net = new Map(), inA = new Map(), outA = new Map();
    for (const t of txns) {
      const amt = toINR(t);
      if (!amt) continue;
      const d = t.date.slice(0, 10);
      if (t.type === "credit") { net.set(d, (net.get(d) || 0) + amt); inA.set(d, (inA.get(d) || 0) + amt); }
      else { net.set(d, (net.get(d) || 0) - amt); outA.set(d, (outA.get(d) || 0) + amt); }
    }
    const days = [];
    for (let d = new Date(start); d <= today; d = new Date(d.getTime() + 86400000))
      days.push(d.toISOString().slice(0, 10));
    // Walk backwards from today's known total
    const bal = new Array(days.length);
    let b = totalINR;
    for (let i = days.length - 1; i >= 0; i--) { bal[i] = b; b -= net.get(days[i]) || 0; }
    return {
      days: days.map((d, i) => ({ d, bal: bal[i], in: inA.get(d) || 0, out: outA.get(d) || 0 })),
      flows: Math.max(...days.map(d => Math.max(inA.get(d) || 0, outA.get(d) || 0)), 1),
    };
  })();

  if (!days.length || w < 120) return <div ref={wrapRef} />;

  // ── Geometry ──
  const H = mob ? 220 : 264, LANE = mob ? 30 : 38, GAP = 14, XLBL = 18;
  const M = { t: 16, r: mob ? 12 : 86, b: XLBL + LANE + GAP, l: 10 };
  const pw = Math.max(10, w - M.l - M.r), ph = H - M.t - M.b;
  const lo0 = Math.min(...days.map(p => p.bal)), hi0 = Math.max(...days.map(p => p.bal));
  const pad = Math.max((hi0 - lo0) * 0.12, hi0 * 0.02, 1);
  const lo = lo0 - pad, hi = hi0 + pad;
  const X = i => M.l + (days.length < 2 ? pw / 2 : i / (days.length - 1) * pw);
  const Y = v => M.t + (1 - (v - lo) / (hi - lo)) * ph;
  const laneY = M.t + ph + GAP + LANE / 2;            // flow-lane midline
  const laneAmp = v => Math.sqrt(v / flows) * (LANE / 2 - 1); // sqrt so small days stay visible

  // Nice y ticks (3 clean values)
  const rawStep = (hi - lo) / 3;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const step = [1, 2, 2.5, 5, 10].map(x => x * mag).find(s => s >= rawStep) || rawStep;
  const ticks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) ticks.push(v);

  // Month boundaries for x labels + the drill-selection band
  const moStarts = days.reduce((acc, p, i) => { if (i === 0 || p.d.slice(0, 7) !== days[i - 1].d.slice(0, 7)) acc.push(i); return acc; }, []);
  const selRange = selMo ? [days.findIndex(p => p.d.slice(0, 7) === selMo), days.map(p => p.d.slice(0, 7)).lastIndexOf(selMo)] : null;

  const path = days.map((p, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(p.bal).toFixed(1)}`).join("");
  const area = `${path}L${X(days.length - 1).toFixed(1)},${(M.t + ph).toFixed(1)}L${X(0).toFixed(1)},${(M.t + ph).toFixed(1)}Z`;
  const iHi = days.reduce((b2, p, i) => p.bal > days[b2].bal ? i : b2, 0);
  const iLo = days.reduce((b2, p, i) => p.bal < days[b2].bal ? i : b2, 0);
  const last = days[days.length - 1], firstBal = days[0].bal;
  const delta = last.bal - firstBal;
  const hovP = hover != null ? days[hover] : null;
  const niceDate = d => new Date(d + "T12:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: undefined });

  const onMove = e => {
    const r = wrapRef.current.querySelector("svg").getBoundingClientRect();
    const x = e.clientX - r.left;
    setHover(Math.max(0, Math.min(days.length - 1, Math.round((x - M.l) / pw * (days.length - 1)))));
  };

  // Tooltip placement: flip side past the midpoint
  const tipLeft = hovP ? (X(hover) < w / 2 ? X(hover) + 14 : undefined) : 0;
  const tipRight = hovP && X(hover) >= w / 2 ? w - X(hover) + 14 : undefined;

  const serif = { fontFamily: "'Cormorant Garamond',Georgia,serif" };
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: mob ? "16px 14px 10px" : "20px 22px 12px" }}>
      {/* header */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 14, flexWrap: "wrap", marginBottom: 4 }}>
        <div style={{ flex: 1, minWidth: 160 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: 0.8 }}>Balance trajectory</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            <span style={{ ...serif, fontSize: mob ? 27 : 33, fontWeight: 600, color: C.ink, lineHeight: 1.25 }}>{m(sfmt(last.bal))}</span>
            <span style={{ fontSize: 11.5, fontWeight: 600, color: delta >= 0 ? C.green : C.red }}>
              {delta >= 0 ? "▲" : "▼"} {m(fmtL(delta))} <span style={{ color: C.inkFaint, fontWeight: 400 }}>since {niceDate(days[0].d)}</span>
            </span>
          </div>
        </div>
        <div style={{ fontSize: 10, color: C.inkFaint, textAlign: "right", lineHeight: 1.7, paddingTop: 4 }}>
          High {m(sfmt(days[iHi].bal))} · {niceDate(days[iHi].d)}<br />
          Low&nbsp; {m(sfmt(days[iLo].bal))} · {niceDate(days[iLo].d)}
        </div>
      </div>

      <div ref={wrapRef} style={{ position: "relative" }}>
        <svg width={w} height={H} style={{ display: "block", cursor: "crosshair" }}
          onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          <defs>
            <linearGradient id="balFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--c-gold)" stopOpacity=".16" />
              <stop offset="100%" stopColor="var(--c-gold)" stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* selected-month band (drill state) */}
          {selRange && selRange[0] >= 0 && (
            <rect x={X(selRange[0])} y={M.t - 6} width={X(selRange[1]) - X(selRange[0])} height={ph + LANE + GAP + 12}
              fill="var(--c-goldLight)" opacity=".55" rx="6" />
          )}

          {/* gridlines + inside tick labels */}
          {ticks.map(v => (
            <g key={v}>
              <line x1={M.l} x2={M.l + pw} y1={Y(v)} y2={Y(v)} stroke={C.border} strokeWidth="1" />
              <text x={M.l + 2} y={Y(v) - 4} fontSize="9.5" fill={C.inkFaint}>{m(sfmt(v))}</text>
            </g>
          ))}

          {/* area + line */}
          <path d={area} fill="url(#balFill)" />
          <path d={path} fill="none" stroke="var(--c-gold)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

          {/* high / low markers */}
          {[iHi, iLo].map(i => i !== days.length - 1 && (
            <circle key={i} cx={X(i)} cy={Y(days[i].bal)} r="3.4" fill="var(--c-gold)" stroke={C.surface} strokeWidth="2" />
          ))}

          {/* endpoint: dot + direct label */}
          <circle cx={X(days.length - 1)} cy={Y(last.bal)} r="4.5" fill="var(--c-gold)" stroke={C.surface} strokeWidth="2" />
          {!mob && <>
            <text x={X(days.length - 1) + 10} y={Y(last.bal) + 1} fontSize="12" fontWeight="600" fill={C.ink}>{m(sfmt(last.bal))}</text>
            <text x={X(days.length - 1) + 10} y={Y(last.bal) + 13} fontSize="9" fill={C.inkFaint}>today</text>
          </>}

          {/* daily flow lane: in grows up, out grows down */}
          <line x1={M.l} x2={M.l + pw} y1={laneY} y2={laneY} stroke={C.border} strokeWidth="1" />
          {days.map((p, i) => (p.in > 0 || p.out > 0) && (
            <g key={p.d}>
              {p.in > 0 && <rect x={X(i) - 1} y={laneY - laneAmp(p.in)} width="2" height={laneAmp(p.in)} fill="var(--c-green)" opacity=".75" />}
              {p.out > 0 && <rect x={X(i) - 1} y={laneY} width="2" height={laneAmp(p.out)} fill="var(--c-red)" opacity=".65" />}
            </g>
          ))}
          <text x={M.l + 2} y={laneY - LANE / 2 + 2} fontSize="8.5" fill={C.inkFaint} letterSpacing=".08em">IN ↑</text>
          <text x={M.l + 2} y={laneY + LANE / 2 + 1} fontSize="8.5" fill={C.inkFaint} letterSpacing=".08em">OUT ↓</text>

          {/* x labels at month starts */}
          {moStarts.map(i => (pw / moStarts.length > 26) && (
            <text key={i} x={X(i)} y={H - 4} fontSize="9.5" fill={C.inkFaint}>
              {new Date(days[i].d + "T12:00:00").toLocaleDateString("en-IN", { month: "short" })}
            </text>
          ))}

          {/* crosshair */}
          {hovP && <>
            <line x1={X(hover)} x2={X(hover)} y1={M.t} y2={laneY + LANE / 2} stroke={C.inkMid} strokeWidth="1" opacity=".45" />
            <circle cx={X(hover)} cy={Y(hovP.bal)} r="4.5" fill="var(--c-gold)" stroke={C.surface} strokeWidth="2" />
          </>}
        </svg>

        {/* tooltip */}
        {hovP && (
          <div style={{ position: "absolute", top: M.t + 2, left: tipLeft, right: tipRight, pointerEvents: "none",
            background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: "8px 12px",
            boxShadow: "0 6px 22px rgba(26,19,8,.12)", minWidth: 128 }}>
            <div style={{ fontSize: 9.5, color: C.inkFaint, marginBottom: 1 }}>{niceDate(hovP.d)}</div>
            <div style={{ ...serif, fontSize: 19, fontWeight: 600, color: C.ink, lineHeight: 1.15 }}>{m(sfmt(hovP.bal))}</div>
            {(hovP.in > 0 || hovP.out > 0) ? (
              <div style={{ marginTop: 4, display: "flex", flexDirection: "column", gap: 2 }}>
                {hovP.in > 0 && <div style={{ fontSize: 10.5, color: C.inkMid, display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ width: 10, height: 2, background: "var(--c-green)", borderRadius: 1 }} />
                  <b style={{ color: C.ink }}>{m("+" + fmtL(hovP.in))}</b>&nbsp;in
                </div>}
                {hovP.out > 0 && <div style={{ fontSize: 10.5, color: C.inkMid, display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ width: 10, height: 2, background: "var(--c-red)", borderRadius: 1 }} />
                  <b style={{ color: C.ink }}>{m("−" + fmtL(hovP.out))}</b>&nbsp;out
                </div>}
              </div>
            ) : <div style={{ fontSize: 10, color: C.inkFaint, marginTop: 3 }}>No movement</div>}
          </div>
        )}
      </div>

      <div style={{ fontSize: 9.5, color: C.inkFaint, padding: "4px 2px 2px" }}>
        Reconstructed backwards from today's balance through each day's recorded flows · all accounts, INR at current rates
      </div>
    </div>
  );
}

// ─── Etsy → bank reconciliation ───────────────────────────────────────────────
// Bridges the two ends of the marketplace pipeline that the app records
// independently: individual Etsy sales in the Orders store (ng-orders-v1,
// written by the Listing Manager) and the lump-sum Payoneer deposits the flow
// engine buckets as "Marketplace payouts". Per month: what Etsy sold, what's
// left after Etsy's cut, and what actually reached the bank. Rows are receipt-
// level (order_total is duplicated across a multi-item receipt's lines, so
// gross is deduped by receipt; etsy_fees/etsy_net are share-allocated per line
// and sum cleanly).
function EtsyReconCard({ months, selMo, onPick, payoutByMo, rates, fmtL, m, card, label, serif }) {
  const [orders, setOrders] = useState(null); // null = loading
  useEffect(() => { let on = true; loadK("ng-orders-v1").then(v => { if (on) setOrders(Array.isArray(v) ? v : []); }); return () => { on = false; }; }, []);

  const cutoff = months ? new Date(Date.now() - months * 30.44 * 86400000).toISOString().slice(0, 10) : "";
  const toINR = (amt, cur) => (+amt || 0) * (cur && cur !== "INR" ? (+rates?.[cur] || 1) : 1);

  // Receipt-level rollup per month
  const byMo = new Map();
  const seen = new Set();
  for (const o of orders || []) {
    const isEtsy = o.platform === "etsy" || !!o.etsy_receipt_id || String(o.order_number || "").startsWith("ETSY-");
    if (!isEtsy || o.cancelled_at || String(o.status || "").toLowerCase() === "cancelled") continue;
    const d = String(o.date || o.created_at || "").slice(0, 10);
    if (!d || d < cutoff) continue;
    const mo = d.slice(0, 7);
    if (!byMo.has(mo)) byMo.set(mo, { gross: 0, fees: 0, net: 0, n: 0 });
    const e = byMo.get(mo);
    const rid = String(o.etsy_receipt_id || o.platform_order_id || o.order_number || o.id);
    if (!seen.has(rid)) { seen.add(rid); e.gross += toINR(o.order_total, o.currency); e.n++; }
    e.fees += toINR(o.etsy_fees, o.currency);       // per-line, share-allocated → sums cleanly
    e.net  += toINR(o.etsy_net,  o.currency);
  }
  for (const e of byMo.values()) if (!e.net) e.net = Math.max(0, e.gross - e.fees);

  const moKeys = [...new Set([...byMo.keys(), ...Object.keys(payoutByMo)])].sort();
  if (orders === null) return null;                       // still loading — no flash
  const totSales = [...byMo.values()].reduce((s, e) => s + e.gross, 0);
  const totPaid  = moKeys.reduce((s, k) => s + (payoutByMo[k] || 0), 0);
  if (!totSales && !totPaid) return null;                 // nothing to reconcile in range
  const totNet  = [...byMo.values()].reduce((s, e) => s + e.net, 0);
  const totFees = Math.max(0, totSales - totNet);
  const inTransit = Math.max(0, totNet - totPaid);
  const maxBar = Math.max(...moKeys.map(k => Math.max(byMo.get(k)?.gross || 0, payoutByMo[k] || 0)), 1);
  const moShort = k => new Date(k + "-15").toLocaleDateString("en-IN", { month: "short", year: k.slice(0, 4) !== String(new Date().getFullYear()) ? "2-digit" : undefined });

  const num = { fontSize: 12, fontWeight: 650, color: C.ink, textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };
  const th  = { ...label, fontSize: 9, textAlign: "right", paddingBottom: 6 };
  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 2 }}>
        <div style={label}>Etsy sales → bank</div>
        <div style={{ fontSize: 10.5, color: C.inkFaint, flex: 1 }}>from the Orders tab vs Payoneer deposits in the books</div>
      </div>

      {/* summary strip */}
      <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr 1fr" : "repeat(4,1fr)", gap: 12, margin: "10px 0 14px" }}>
        {[["Etsy sold", totSales, C.ink], ["Etsy kept", -totFees, C.red], ["Reached bank", totPaid, C.green], ["Not yet landed", inTransit, C.amber]].map(([k, v, tone]) => (
          <div key={k}>
            <div style={{ ...label, marginBottom: 2 }}>{k}</div>
            <div style={{ ...serif, fontSize: mob ? 19 : 22, fontWeight: 600, color: tone, lineHeight: 1.1 }}>
              {m((v < 0 ? "−" : "") + fmtL(v))}
            </div>
            {k === "Etsy kept" && totSales > 0 && <div style={{ fontSize: 9.5, color: C.inkFaint }}>{Math.round(totFees / totSales * 100)}% of sales</div>}
            {k === "Reached bank" && totNet > 0 && <div style={{ fontSize: 9.5, color: C.inkFaint }}>{Math.round(Math.min(100, totPaid / totNet * 100))}% of expected</div>}
          </div>
        ))}
      </div>

      {/* month table: sales bar vs received bar */}
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto auto auto", columnGap: mob ? 8 : 14, rowGap: 0, alignItems: "center" }}>
        <div />{/* month */}
        <div />{/* bars */}
        <div style={th}>Sold</div>
        <div style={th}>{mob ? "Net" : "After fees"}</div>
        <div style={th}>{mob ? "Bank" : "Reached bank"}</div>
        {moKeys.map(k => {
          const e = byMo.get(k) || { gross: 0, net: 0, n: 0 };
          const paid = payoutByMo[k] || 0;
          const on = selMo === k;
          return (
            <Fragment key={k}>
              <button onClick={() => onPick && onPick(on ? null : k)}
                style={{ background: "none", border: "none", padding: "7px 0", cursor: onPick ? "pointer" : "default", font: "inherit",
                  fontSize: 11.5, fontWeight: on ? 700 : 500, color: on ? C.gold : C.inkMid, textAlign: "left", whiteSpace: "nowrap" }}>
                {moShort(k)}{e.n ? <span style={{ color: C.inkFaint, fontWeight: 400 }}> · {e.n}</span> : ""}
              </button>
              <div style={{ display: "flex", flexDirection: "column", gap: 2, opacity: selMo && !on ? .45 : 1 }}>
                <div title={`Sold ${fmtL(e.gross)}`}   style={{ height: 6, width: `${Math.max(e.gross / maxBar * 100, e.gross ? 2 : 0)}%`, background: "var(--c-gold)", borderRadius: 3, opacity: .85 }} />
                <div title={`Reached bank ${fmtL(paid)}`} style={{ height: 6, width: `${Math.max(paid / maxBar * 100, paid ? 2 : 0)}%`, background: "var(--c-green)", borderRadius: 3, opacity: .8 }} />
              </div>
              <div style={{ ...num, opacity: selMo && !on ? .45 : 1 }}>{m(fmtL(e.gross))}</div>
              <div style={{ ...num, color: C.inkMid, opacity: selMo && !on ? .45 : 1 }}>{m(fmtL(e.net))}</div>
              <div style={{ ...num, color: paid ? C.green : C.inkFaint, opacity: selMo && !on ? .45 : 1 }}>{m(fmtL(paid))}</div>
            </Fragment>
          );
        })}
      </div>

      {/* legend + caveat */}
      <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", marginTop: 12, fontSize: 9.5, color: C.inkFaint }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><span style={{ width: 14, height: 5, background: "var(--c-gold)", borderRadius: 3, opacity: .85 }} />Etsy sold</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><span style={{ width: 14, height: 5, background: "var(--c-green)", borderRadius: 3, opacity: .8 }} />Reached bank (Payoneer)</span>
        <span style={{ flex: 1 }} />
        <span>Payouts lag sales — a late-month order usually lands next month.</span>
      </div>
    </div>
  );
}

// "+18% vs Jul" — coloured by whether the direction is good for that metric.
function Delta({ now, was, prevLabel, good }) {
  if (was === undefined || was === null) return <span>No {prevLabel || "prior"} comparison</span>;
  if (!was) return now
    ? <span style={{ color: good === "up" ? "#8FCBA8" : "#E8A0A0", fontWeight: 600 }}>▲ new vs {prevLabel}</span>
    : <span>Nothing in {prevLabel}</span>;
  const pct = (now - was) / was * 100;
  const up = pct >= 0;
  const ok = good === "up" ? up : !up;
  if (Math.abs(pct) < 0.5) return <span>Flat vs {prevLabel}</span>;
  return <span style={{ color: ok ? "#8FCBA8" : "#E8A0A0", fontWeight: 600 }}>
    {up ? "▲" : "▼"} {Math.abs(pct).toFixed(0)}% vs {prevLabel}
  </span>;
}

// Detail panel for one selected month: day-by-day rhythm, what moved against the
// previous month, and the payments that actually drove the number.
function MonthDetail({ moKey, agg, prev, prevKey, moKeys, onPick, fmtL, m, moName, moShort, toINR, card, label, serif }) {
  const idx  = moKeys.indexOf(moKey);
  const back = moKeys[idx - 1], fwd = moKeys[idx + 1];
  const net  = agg.in - agg.out;

  // Day-by-day in/out inside the month
  const days = new Date(+moKey.slice(0, 4), +moKey.slice(5, 7), 0).getDate();
  const daily = Array.from({ length: days }, () => ({ in: 0, out: 0 }));
  for (const t of agg.txns) {
    const d = +String(t.date || "").slice(8, 10);
    if (!d || d > days) continue;
    const amt = toINR(t);
    if (t.type === "credit") daily[d - 1].in += amt; else daily[d - 1].out += amt;
  }
  const dayPeak = Math.max(...daily.map(d => Math.max(d.in, d.out)), 1);
  const busiest = daily.reduce((best, d, i) => (d.in + d.out) > (daily[best].in + daily[best].out) ? i : best, 0);

  // What moved vs the previous month, by bucket (spend + income together)
  const bucketAmts = a => {
    const map = new Map();
    if (!a) return map;
    for (const e of a.outB.values()) map.set(e.bucket.label, { amt: e.amt, icon: e.bucket.icon, out: true });
    for (const e of a.inB.values())  map.set(e.bucket.label, { amt: e.amt, icon: e.bucket.icon, out: false });
    if (a.uncat.amt) map.set("Uncategorised", { amt: a.uncat.amt, icon: "🕳", out: true });
    return map;
  };
  const nowMap = bucketAmts(agg), prevMap = bucketAmts(prev);
  const movers = prev ? [...new Set([...nowMap.keys(), ...prevMap.keys()])]
    .map(k => ({ k, icon: (nowMap.get(k) || prevMap.get(k)).icon, out: (nowMap.get(k) || prevMap.get(k)).out,
                 now: nowMap.get(k)?.amt || 0, was: prevMap.get(k)?.amt || 0 }))
    .map(r => ({ ...r, d: r.now - r.was }))
    .filter(r => Math.abs(r.d) > 1)
    .sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 5) : [];

  const top = [...agg.txns].sort((a, b) => toINR(b) - toINR(a)).slice(0, 6);

  const stat = (k, v, tone) => (
    <div>
      <div style={{ ...label, marginBottom: 2 }}>{k}</div>
      <div style={{ fontSize: 13.5, fontWeight: 650, color: tone || C.ink }}>{v}</div>
    </div>
  );

  return (
    <div style={{ ...card, borderColor: C.gold + "55", boxShadow: "0 2px 14px rgba(0,0,0,.05)" }}>
      {/* header + month stepper */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        <div style={{ ...serif, fontSize: 22, fontWeight: 600, color: C.ink, flex: 1 }}>{moName(moKey)}</div>
        <div style={{ display: "flex", gap: 4 }}>
          <button disabled={!back} onClick={() => onPick(back)} title={back ? moName(back) : ""}
            style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 7, padding: "4px 10px", fontSize: 12, cursor: back ? "pointer" : "default", opacity: back ? 1 : .35, color: C.ink }}>‹ {back ? moShort(back) : ""}</button>
          <button disabled={!fwd} onClick={() => onPick(fwd)} title={fwd ? moName(fwd) : ""}
            style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 7, padding: "4px 10px", fontSize: 12, cursor: fwd ? "pointer" : "default", opacity: fwd ? 1 : .35, color: C.ink }}>{fwd ? moShort(fwd) : ""} ›</button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr 1fr" : "repeat(4,1fr)", gap: 12, marginBottom: 16 }}>
        {stat("In", m(fmtL(agg.in)), C.green)}
        {stat("Out", m(fmtL(agg.out)), C.red)}
        {stat("Net", m((net >= 0 ? "+" : "−") + fmtL(net)), net >= 0 ? C.green : C.red)}
        {stat("Transactions", `${agg.txns.length}${agg.transferN ? ` · ${agg.transferN} transfer${agg.transferN > 1 ? "s" : ""}` : ""}`)}
      </div>

      {/* day-by-day */}
      <div style={{ ...label, marginBottom: 7 }}>Day by day · busiest {busiest + 1} {moShort(moKey)}</div>
      {/* money in grows above the hairline, money out below it */}
      <div style={{ position: "relative", display: "flex", alignItems: "stretch", gap: 2, height: 56, marginBottom: 4 }}>
        <div style={{ position: "absolute", left: 0, right: 0, top: "50%", height: 1, background: C.border }} />
        {daily.map((d, i) => (
          <div key={i} title={`${i + 1} ${moShort(moKey)} · in ${fmtL(d.in)} · out ${fmtL(d.out)}`}
            style={{ flex: 1, display: "flex", flexDirection: "column", height: "100%" }}>
            <div style={{ flex: 1, display: "flex", alignItems: "flex-end" }}>
              <div style={{ width: "100%", height: d.in / dayPeak * 27, background: "var(--c-green)", opacity: .85, borderRadius: "2px 2px 0 0", minHeight: d.in ? 2 : 0 }} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ width: "100%", height: d.out / dayPeak * 27, background: "var(--c-red)", opacity: .7, borderRadius: "0 0 2px 2px", minHeight: d.out ? 2 : 0 }} />
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9.5, color: C.inkFaint, marginBottom: 16 }}>
        <span>1</span><span>{Math.round(days / 2)}</span><span>{days}</span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr" : "1fr 1fr", gap: 18 }}>
        {/* movers */}
        <div>
          <div style={{ ...label, marginBottom: 8 }}>{prev ? `What moved vs ${moShort(prevKey)}` : "No earlier month in range"}</div>
          {movers.length === 0 && <div style={{ fontSize: 11.5, color: C.inkFaint }}>{prev ? "Nothing shifted materially." : "Widen the range to compare."}</div>}
          {movers.map(r => {
            const worse = r.out ? r.d > 0 : r.d < 0;
            return (
              <div key={r.k} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderBottom: `1px solid ${C.border}40` }}>
                <span style={{ fontSize: 12 }}>{r.icon}</span>
                <span style={{ fontSize: 12, color: C.ink, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.k}</span>
                <span style={{ fontSize: 10.5, color: C.inkFaint }}>{m(fmtL(r.was))} → {m(fmtL(r.now))}</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: worse ? C.red : C.green, width: 62, textAlign: "right" }}>
                  {r.d >= 0 ? "+" : "−"}{m(fmtL(r.d))}
                </span>
              </div>
            );
          })}
        </div>
        {/* biggest movements */}
        <div>
          <div style={{ ...label, marginBottom: 8 }}>Biggest movements this month</div>
          {top.length === 0 && <div style={{ fontSize: 11.5, color: C.inkFaint }}>No transactions.</div>}
          {top.map(t => (
            <div key={t.id} className="fl-row" style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 4px", borderBottom: `1px solid ${C.border}40`, borderRadius: 6 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{prettyPayee(t.payee || t.notes || "").name}</div>
                <div style={{ fontSize: 10, color: C.inkFaint }}>{fmtDate(t.date)}{t.category ? ` · ${t.category}` : ""}</div>
              </div>
              <div style={{ fontSize: 12.5, fontWeight: 650, color: t.type === "credit" ? C.green : C.ink, flexShrink: 0 }}>
                {m((t.type === "credit" ? "+" : "−") + fmtL(toINR(t)))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function MoneyFlowView({ transactions, accounts, rates, totalINR, onUpdate }) {
  const masked = useMasked();
  const m = makeMask(masked);
  const [months, setMonths] = useState(6);
  const [expanded, setExpanded] = useState(null); // bucket id | "uncat" | income id
  const [q, setQ] = useState("");
  const [selMo, setSelMo] = useState(null);       // "YYYY-MM" — drills every panel into one month

  const toINR = t => (+t.amount || 0) * (t.currency && t.currency !== "INR" ? (+rates?.[t.currency] || 1) : 1);
  const fmtL = n => {
    const a = Math.abs(n);
    return "₹" + (a >= 1e5 ? (a / 1e5).toLocaleString("en-IN", { maximumFractionDigits: 1 }) + "L" : a >= 1e3 ? Math.round(a / 1e3).toLocaleString("en-IN") + "k" : Math.round(a).toLocaleString("en-IN"));
  };
  const cutoff = months ? new Date(Date.now() - months * 30.44 * 86400000).toISOString().slice(0, 10) : "";
  const ql = q.toLowerCase();
  const scoped = (transactions || [])
    .filter(t => (t.date || "") >= cutoff)
    .filter(t => !ql || `${t.payee || ""} ${t.notes || ""} ${t.category || ""}`.toLowerCase().includes(ql));

  // ── Engine: single pass → buckets, months, transfers ──
  // Every transaction is added twice: once to the whole-period aggregate and once
  // to its own month, so drilling into a month is a lookup rather than a re-scan.
  const mkAgg = () => ({ in: 0, out: 0, inB: new Map(), outB: new Map(), uncat: { amt: 0, txns: [] }, transferAmt: 0, transferN: 0, txns: [] });
  const addTo = (agg, t, amt, r) => {
    if (r.side === "transfer") { agg.transferAmt += amt; agg.transferN++; return; }
    agg.txns.push(t);
    if (r.side === "in") {
      agg.in += amt;
      const e = agg.inB.get(r.bucket.id) || { bucket: r.bucket, amt: 0, txns: [] };
      e.amt += amt; e.txns.push(t); agg.inB.set(r.bucket.id, e);
    } else {
      agg.out += amt;
      if (!r.bucket) { agg.uncat.amt += amt; agg.uncat.txns.push(t); }
      else { const e = agg.outB.get(r.bucket.id) || { bucket: r.bucket, amt: 0, txns: [] }; e.amt += amt; e.txns.push(t); agg.outB.set(r.bucket.id, e); }
    }
  };
  const all = mkAgg(), byMonth = new Map();
  for (const t of scoped) {
    const amt = toINR(t);
    if (!amt) continue;
    const r = flowBucketOf(t);
    const mo = (t.date || "").slice(0, 7);
    if (!byMonth.has(mo)) byMonth.set(mo, mkAgg());
    addTo(all, t, amt, r);
    addTo(byMonth.get(mo), t, amt, r);
  }
  const moKeys = [...byMonth.keys()].sort();
  const monthOn = selMo && byMonth.has(selMo);
  const agg     = monthOn ? byMonth.get(selMo) : all;
  const prevKey = monthOn ? moKeys[moKeys.indexOf(selMo) - 1] : null;
  const prev    = prevKey ? byMonth.get(prevKey) : null;

  const totalIn = agg.in, totalOut = agg.out;
  const { uncat, transferAmt, transferN } = agg;
  const net = totalIn - totalOut;
  const nMo = monthOn ? 1 : Math.max(1, moKeys.length);
  const avgNet = net / nMo;
  const runway = avgNet < 0 && totalINR > 0 ? totalINR / -avgNet : null;
  const knownPct = totalOut > 0 ? (1 - uncat.amt / totalOut) * 100 : 100;
  const inRows = [...agg.inB.values()].sort((a, b) => b.amt - a.amt);
  const outRows = [...agg.outB.values()].sort((a, b) => b.amt - a.amt);
  const maxIn = inRows[0]?.amt || 1, maxOut = Math.max(outRows[0]?.amt || 0, uncat.amt) || 1;
  const moName = k => k ? new Date(k + "-15").toLocaleDateString("en-IN", { month: "long", year: "numeric" }) : "";
  const moShort = k => k ? new Date(k + "-15").toLocaleDateString("en-IN", { month: "short" }) : "";
  const scopeLabel = monthOn ? `in ${moShort(selMo)}` : months ? `last ${months} months` : "all time";

  const card = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: mob ? "16px 14px" : "20px 22px" };
  const label = { fontSize: 10, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: 0.8 };
  const serif = { fontFamily: "'Cormorant Garamond',Georgia,serif" };

  // Inline transaction list for an expanded bucket, with one-tap reclassify.
  // Bank narration is unreadable raw ("IMPS/P2A/609716.../BARB/MADIHA MOHAME"),
  // so rows lead with the human name and keep the reference as quiet sub-text,
  // grouped by month with a running subtotal.
  const TxnList = ({ txns, classify }) => {
    const sorted = [...txns].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    const total = sorted.reduce((s, t) => s + toINR(t), 0);
    let lastMo = null;
    return (
      <div style={{ marginTop: 10, borderTop: `1px solid ${C.border}` }} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 2px 5px" }}>
          <span style={{ ...label, flex: 1 }}>{sorted.length} payment{sorted.length === 1 ? "" : "s"}</span>
          <span style={{ fontSize: 11, fontWeight: 700, color: C.inkMid }}>{m(fmtL(total))}</span>
        </div>
        <div style={{ maxHeight: 340, overflowY: "auto", paddingRight: 2 }}>
          {sorted.map(t => {
            const mo = (t.date || "").slice(0, 7);
            const head = mo !== lastMo ? mo : null;
            lastMo = mo;
            const monthSum = head ? sorted.filter(x => (x.date || "").slice(0, 7) === mo).reduce((s, x) => s + toINR(x), 0) : 0;
            const p = prettyPayee(t.payee || t.notes || "");
            const cat = t.category && !FLOW_METHOD_CATS.has(String(t.category).toLowerCase()) ? t.category : null;
            return (
              <Fragment key={t.id}>
                {head && (
                  <div style={{ position: "sticky", top: 0, zIndex: 1, display: "flex", alignItems: "center", gap: 8,
                    background: C.surface, padding: "6px 2px 4px", borderBottom: `1px solid ${C.border}` }}>
                    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: .6, color: C.inkMid, textTransform: "uppercase" }}>
                      {new Date(head + "-15").toLocaleDateString("en-IN", { month: "long", year: "numeric" })}
                    </span>
                    <span style={{ flex: 1, height: 1, background: C.border }} />
                    <span style={{ fontSize: 10, color: C.inkFaint }}>{m(fmtL(monthSum))}</span>
                  </div>
                )}
                <div className="fl-row" style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 4px", borderBottom: `1px solid ${C.border}40`, borderRadius: 6 }}>
                  <div style={{ width: 34, flexShrink: 0, textAlign: "center" }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: C.ink, lineHeight: 1 }}>{(t.date || "").slice(8, 10)}</div>
                    <div style={{ fontSize: 9, color: C.inkFaint, textTransform: "uppercase" }}>{moShort((t.date || "").slice(0, 7))}</div>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, color: C.ink, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                    <div style={{ fontSize: 9.5, color: C.inkFaint, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {[p.via, p.ref, cat].filter(Boolean).join(" · ") || fmtDate(t.date)}
                    </div>
                  </div>
                  <div style={{ fontSize: 12.5, fontWeight: 650, color: t.type === "credit" ? C.green : C.ink, flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
                    {m((t.type === "credit" ? "+" : "−") + fmtL(toINR(t)))}
                  </div>
                  {classify && (
                    <select value="" onChange={e => e.target.value && onUpdate(t.id, { category: e.target.value })}
                      title="Tag this payment"
                      style={{ fontSize: 10.5, border: `1px solid ${C.border}`, borderRadius: 20, padding: "3px 6px", background: C.card, color: C.inkMid, cursor: "pointer", width: 66, flexShrink: 0, appearance: "none", textAlign: "center" }}>
                      <option value="">🏷 tag</option>
                      {FLOW_CHIPS.map(([lab, cat2]) => <option key={cat2} value={cat2}>{lab}</option>)}
                    </select>
                  )}
                </div>
              </Fragment>
            );
          })}
        </div>
      </div>
    );
  };

  const Bar = ({ row, max, total, side }) => {
    const b = row.bucket;
    const open = expanded === `${side}:${b.id}`;
    return (
      <div key={b.id} style={{ padding: "7px 0", cursor: "pointer" }} onClick={() => setExpanded(open ? null : `${side}:${b.id}`)}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 13 }}>{b.icon}</span>
          <span style={{ fontSize: 12.5, fontWeight: open ? 700 : 500, color: C.ink, flex: 1 }}>
            {b.label}
            {b.sub && <span style={{ fontSize: 10, color: C.inkFaint, fontWeight: 400 }}> · {b.sub}</span>}
            <span style={{ fontSize: 10, color: C.inkFaint, fontWeight: 400 }}> · {row.txns.length}</span>
          </span>
          <span style={{ fontSize: 13, fontWeight: 650, color: C.ink }}>{m(fmtL(row.amt))}</span>
          <span style={{ fontSize: 10, color: C.inkFaint, width: 34, textAlign: "right" }}>{total ? Math.round(row.amt / total * 100) : 0}%</span>
        </div>
        <div style={{ height: 7, background: C.card, borderRadius: 4, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${Math.max(2, row.amt / max * 100)}%`, background: b.color, borderRadius: 4, transition: "width .4s cubic-bezier(.4,0,.2,1)" }} />
        </div>
        {open && <TxnList txns={row.txns} classify={side === "out"} />}
      </div>
    );
  };

  return (
    <div style={{ maxWidth: 980, display: "flex", flexDirection: "column", gap: 14 }}>
      {/* ── Controls ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 2, background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: 3 }}>
          {[["3M", 3], ["6M", 6], ["12M", 12], ["All", 0]].map(([lab, v]) => (
            <button key={lab} onClick={() => { setMonths(v); setSelMo(null); setExpanded(null); }} style={{ background: months === v ? C.ink : "transparent", color: months === v ? "#FAF0DC" : C.inkMid, border: "none", borderRadius: 6, padding: "5px 13px", fontSize: 12, fontWeight: months === v ? 700 : 400, cursor: "pointer" }}>{lab}</button>
          ))}
        </div>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search payee — e.g. shiprocket…"
          style={{ flex: 1, minWidth: 170, border: `1.5px solid ${C.border}`, borderRadius: 8, padding: "7px 12px", fontSize: 12, background: C.surface, color: C.ink }} />
      </div>

      {/* ── Hero: the answer ── */}
      <div style={{ ...card, background: C.ink, border: "none", color: "#FAF0DC" }}>
        <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr 1fr" : "1fr 1fr 1.2fr", gap: mob ? 14 : 10 }}>
          <div>
            <div style={{ ...label, color: "#FAF0DC66" }}>Money in</div>
            <div style={{ ...serif, fontSize: mob ? 24 : 30, fontWeight: 600, color: "#8FCBA8" }}>{m(fmtL(totalIn))}</div>
            <div style={{ fontSize: 10.5, color: "#FAF0DC55" }}>
              {monthOn ? <Delta now={totalIn} was={prev?.in} prevLabel={moShort(prevKey)} good="up" /> : `${m(fmtL(totalIn / nMo))}/mo avg`}
            </div>
          </div>
          <div>
            <div style={{ ...label, color: "#FAF0DC66" }}>Money out</div>
            <div style={{ ...serif, fontSize: mob ? 24 : 30, fontWeight: 600, color: "#E8A0A0" }}>{m(fmtL(totalOut))}</div>
            <div style={{ fontSize: 10.5, color: "#FAF0DC55" }}>
              {monthOn ? <Delta now={totalOut} was={prev?.out} prevLabel={moShort(prevKey)} good="down" /> : `${m(fmtL(totalOut / nMo))}/mo avg`}
            </div>
          </div>
          <div>
            <div style={{ ...label, color: "#FAF0DC66" }}>Net cash flow</div>
            <div style={{ ...serif, fontSize: mob ? 24 : 30, fontWeight: 600, color: net >= 0 ? "#8FCBA8" : "#E8A0A0" }}>{m((net >= 0 ? "+" : "−") + fmtL(net))}</div>
            <div style={{ fontSize: 10.5, color: "#FAF0DC88", fontWeight: 600 }}>
              {monthOn
                ? `${moName(selMo)} · ${agg.txns.length} transaction${agg.txns.length === 1 ? "" : "s"}`
                : net >= 0 ? `Building ${m(fmtL(avgNet))}/mo` : runway ? `Burning ${m(fmtL(-avgNet))}/mo · ~${runway.toFixed(1)} mo runway` : `Burning ${m(fmtL(-avgNet))}/mo`}
            </div>
          </div>
        </div>
      </div>

      {/* ── Balance trajectory ── */}
      <BalanceChart transactions={transactions} months={months} rates={rates} totalINR={totalINR} selMo={monthOn ? selMo : null} fmtL={fmtL} m={m} />

      {/* ── Monthly rhythm — click a month to drill the whole page into it ── */}
      {moKeys.length > 1 && (
        <div style={card}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
            <div style={label}>Monthly rhythm — in vs out</div>
            <div style={{ fontSize: 10.5, color: C.inkFaint, flex: 1 }}>
              {monthOn ? `Showing ${moName(selMo)} only` : "Click any month to drill in"}
            </div>
            {monthOn && (
              <button onClick={() => { setSelMo(null); setExpanded(null); }}
                style={{ background: C.ink, color: "#FAF0DC", border: "none", borderRadius: 7, padding: "4px 11px", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
                ✕ All months
              </button>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: mob ? 6 : 12, height: 138, overflowX: "auto", paddingBottom: 2 }}>
            {moKeys.map(mo => {
              const d = byMonth.get(mo);
              const peak = Math.max(...moKeys.map(k => Math.max(byMonth.get(k).in, byMonth.get(k).out)), 1);
              const moNet = d.in - d.out;
              const on = selMo === mo, dim = monthOn && !on;
              return (
                <button key={mo} onClick={() => { setSelMo(on ? null : mo); setExpanded(null); }}
                  title={`${moName(mo)}\nIn ${fmtL(d.in)} · Out ${fmtL(d.out)}\nNet ${moNet >= 0 ? "+" : "−"}${fmtL(moNet)}\n${d.txns.length} transactions`}
                  style={{
                    flex: 1, minWidth: 46, maxWidth: 108, display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
                    background: on ? C.card : "transparent", border: `1px solid ${on ? C.border : "transparent"}`,
                    borderRadius: 10, padding: "6px 2px", cursor: "pointer", opacity: dim ? .42 : 1,
                    transition: "opacity .2s, background .2s, transform .12s", font: "inherit",
                  }}>
                  <div style={{ fontSize: 9.5, fontWeight: 700, color: moNet >= 0 ? C.green : C.red }}>{m((moNet >= 0 ? "+" : "−") + fmtL(moNet))}</div>
                  <div style={{ display: "flex", gap: 3, alignItems: "flex-end", height: 84 }}>
                    <div style={{ width: mob ? 10 : 16, height: Math.max(3, d.in / peak * 84), background: "var(--c-green)", opacity: .85, borderRadius: "3px 3px 0 0", transition: "height .4s" }} />
                    <div style={{ width: mob ? 10 : 16, height: Math.max(3, d.out / peak * 84), background: "var(--c-red)", opacity: .75, borderRadius: "3px 3px 0 0", transition: "height .4s" }} />
                  </div>
                  <div style={{ fontSize: 9.5, fontWeight: on ? 700 : 400, color: on ? C.ink : C.inkFaint }}>{moShort(mo)}</div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Month detail: only when a month is selected ── */}
      {monthOn && (
        <MonthDetail
          moKey={selMo} agg={agg} prev={prev} prevKey={prevKey}
          moKeys={moKeys} onPick={k => { setSelMo(k); setExpanded(null); }}
          fmtL={fmtL} m={m} moName={moName} moShort={moShort} toINR={toINR} card={card} label={label} serif={serif}
        />
      )}

      {/* ── Sources & uses ── */}
      <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr" : "1fr 1.15fr", gap: 14, alignItems: "start" }}>
        <div style={card}>
          <div style={{ ...label, marginBottom: 8 }}>Where it comes from · <span style={{ color: monthOn ? C.gold : C.inkFaint }}>{scopeLabel}</span></div>
          {inRows.length === 0 && <div style={{ fontSize: 12, color: C.inkFaint, padding: "12px 0" }}>No income in this period.</div>}
          {inRows.map(r => <Bar key={r.bucket.id} row={r} max={maxIn} total={totalIn} side="in" />)}
        </div>
        <div style={card}>
          <div style={{ ...label, marginBottom: 8 }}>Where it goes · <span style={{ color: monthOn ? C.gold : C.inkFaint }}>{scopeLabel}</span></div>
          {/* Uncategorised — pinned on top when it exists: the biggest lie in any P&L */}
          {uncat.amt > 0 && (
            <div style={{ margin: "2px 0 10px", padding: "10px 12px", background: C.amberBg, border: `1px solid ${C.amber}45`, borderRadius: 10, cursor: "pointer" }}
              onClick={() => setExpanded(expanded === "uncat" ? null : "uncat")}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span style={{ fontSize: 13 }}>🕳</span>
                <span style={{ fontSize: 12.5, fontWeight: 700, color: C.amber, flex: 1 }}>Uncategorised · {uncat.txns.length} payments</span>
                <span style={{ fontSize: 13.5, fontWeight: 700, color: C.amber }}>{m(fmtL(uncat.amt))}</span>
                <span style={{ fontSize: 10, color: C.amber, width: 34, textAlign: "right" }}>{Math.round(uncat.amt / (totalOut || 1) * 100)}%</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                <div style={{ flex: 1, height: 5, background: "#00000012", borderRadius: 3, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${knownPct}%`, background: C.green, borderRadius: 3, transition: "width .5s" }} />
                </div>
                <span style={{ fontSize: 10, fontWeight: 700, color: C.inkMid }}>{Math.round(knownPct)}% of spend explained</span>
              </div>
              <div style={{ fontSize: 10.5, color: C.inkMid, marginTop: 4 }}>Tap to open · tag each payment and watch this shrink.</div>
              {expanded === "uncat" && <div onClick={e => e.stopPropagation()}><TxnList txns={uncat.txns} classify /></div>}
            </div>
          )}
          {outRows.map(r => <Bar key={r.bucket.id} row={r} max={maxOut} total={totalOut} side="out" />)}
        </div>
      </div>

      {/* ── Etsy sales ↔ bank payouts ── */}
      <EtsyReconCard months={months} selMo={monthOn ? selMo : null}
        onPick={k => { setSelMo(k); setExpanded(null); }}
        payoutByMo={Object.fromEntries([...byMonth].map(([mo, a]) => [mo, a.inB.get("payouts")?.amt || 0]))}
        rates={rates} fmtL={fmtL} m={m} card={card} label={label} serif={serif} />

      {(transferN > 0 || !months) && (
        <div style={{ fontSize: 10.5, color: C.inkFaint, padding: "0 4px" }}>
          {transferN > 0 && <>Excluded from spend: {transferN} internal transfer{transferN > 1 ? "s" : ""} / credit-card bill payment{transferN > 1 ? "s" : ""} totalling {m(fmtL(transferAmt))} — counting them would double-count the card's own transactions. </>}
          All figures cash-basis, converted to INR at current rates.
        </div>
      )}
    </div>
  );
}

// One-time reconciliation cleanup (Atyahara / IndusInd): 6 pre-existing ledger
// entries that aren't on the uploaded bank statement — a wrong-direction copy of a
// Nikhil Gems payment plus a few inter-company / duplicate records. Removing them
// makes the IndusInd ledger tie out to the bank. The Fix button only shows while
// these still exist, so it disappears for good once clicked.
const ATYAHARA_RECON_FIX = [
  { date: "2026-07-20", type: "credit", amount: 172569,  match: "nikhil gems" },
  { date: "2026-06-28", type: "credit", amount: 100000,  match: "nikhil gems" },
  { date: "2026-07-17", type: "credit", amount: 76074,   match: "atyahara" },
  { date: "2026-07-29", type: "credit", amount: 5000,    match: "ship global" },
  { date: "2026-06-15", type: "debit",  amount: 3074,    match: "ikea" },
  { date: "2026-06-26", type: "debit",  amount: 788,     match: "subko" },
  // Penny-perfect: 3 mis-imported rows not on the statement (a duplicate 11-May
  // ShipGlobal credit + two debits the bank never carried).
  { date: "2026-05-11", type: "credit", amount: 2536.32, match: "ship" },
  { date: "2026-06-01", type: "debit",  amount: 1456.66, match: "ship" },
  { date: "2026-05-28", type: "debit",  amount: 297.98,  match: "zoma" },
];
function findReconFixIds(txns = []) {
  const ids = [];
  for (const t of ATYAHARA_RECON_FIX) {
    const hit = txns.find(x =>
      !ids.includes(x.id) &&
      x.type === t.type &&
      Math.abs((+x.amount || 0) - t.amount) < 0.5 &&
      String(x.date || "").slice(0, 10) === t.date &&
      String(x.payee || "").toLowerCase().includes(t.match)
    );
    if (hit) ids.push(hit.id);
  }
  return ids;
}

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
  const [assets,        setAssets]        = useState([]);
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
      loadK(PERSONAL_ASSETS_KEY),
    ]).then(([accs, t, r, invs, buys, purch, vends, exps, personalAssets]) => {
      // Existing books were saved before the OD account existed, so seed it in
      // rather than leaving it only in DEFAULT_ACCOUNTS (which never applies once
      // accounts have been saved once).
      const needsOd = company === "ng" && accs?.length && !accs.some(a => a.type === "od");
      const seeded = accs?.length
        ? (needsOd ? [...accs, OD_BOI] : accs)
        : (company === "ng" ? DEFAULT_ACCOUNTS : DEFAULT_ACCOUNTS_AT);
      setAccounts(seeded);
      // Persist the seed — the Telegram bot resolves accounts from the database,
      // so an OD that only ever exists in this component's state would leave it
      // unable to match the account number in a forwarded BOI SMS.
      if (needsOd) saveK(keys.accounts, seeded);
      setTxns(t  || []);
      const savedRates = r && Object.keys(r || {}).length ? r : DEFAULT_RATES;
      setRates(savedRates);
      setInvoices(invs  || []);
      setBuyers(buys || []);
      setPurchases(purch || []);
      setVendors(vends  || []);
      setExpenses(exps  || []);
      setAssets(Array.isArray(personalAssets) ? personalAssets : []);
      setLoaded(true);
      // Auto-refresh if rates are older than 24 hours or never fetched
      const fetchedAt = savedRates._fetchedAt ? new Date(savedRates._fetchedAt) : null;
      const stale = !fetchedAt || (Date.now() - fetchedAt.getTime() > 24 * 60 * 60 * 1000);
      if (stale) fetchLiveRates(savedRates);
    });
  }, [company]);

  // Live updates: reload a key when another device changes it (add/edit/delete).
  useEffect(() => onCacheRefresh(changed => {
    const keys = companyKeys(company);
    if (changed.includes(keys.transactions)) loadKFresh(keys.transactions).then(v => Array.isArray(v) && setTxns(v));
    if (changed.includes(keys.accounts))     loadKFresh(keys.accounts).then(v => Array.isArray(v) && v.length && setAccounts(v));
    if (changed.includes(keys.rates))        loadKFresh(keys.rates).then(v => v && Object.keys(v).length && setRates(v));
    if (changed.includes(keys.invoices))     loadKFresh(keys.invoices).then(v => Array.isArray(v) && setInvoices(v));
    if (changed.includes(keys.buyers))       loadKFresh(keys.buyers).then(v => Array.isArray(v) && setBuyers(v));
    if (changed.includes(keys.purchases))    loadKFresh(keys.purchases).then(v => Array.isArray(v) && setPurchases(v));
    if (changed.includes(keys.vendors))      loadKFresh(keys.vendors).then(v => Array.isArray(v) && setVendors(v));
    if (changed.includes(keys.expenses))     loadKFresh(keys.expenses).then(v => Array.isArray(v) && setExpenses(v));
    if (changed.includes(PERSONAL_ASSETS_KEY)) loadKFresh(PERSONAL_ASSETS_KEY).then(v => Array.isArray(v) && setAssets(v));
  }), [company]);

  const saveAccounts = async accs => { setAccounts(accs); await saveK(companyKeys(company).accounts, accs); showToast("Accounts saved"); };
  const saveRates    = async r    => { setRates(r);        await saveK(companyKeys(company).rates, r);    showToast("Rates updated"); };
  const saveAsset = async asset => {
    const list = [asset, ...assets.filter(a => a.id !== asset.id)];
    setAssets(list);
    await saveK(PERSONAL_ASSETS_KEY, list);
    showToast("Asset saved");
  };
  const deleteAsset = async id => {
    const list = assets.filter(a => a.id !== id);
    setAssets(list);
    await saveK(PERSONAL_ASSETS_KEY, list);
    showToast("Asset deleted");
  };
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

  // Reconcile an account to a known-correct balance without hunting for the missing
  // transaction(s) — plugs the gap with a single dated "Balance Adjustment" entry
  // so the ledger stays accurate instead of silently offsetting the opening balance.
  const adjustBalance = async (accId, targetBalance) => {
    const acc = accounts.find(a => a.id === accId);
    if (!acc) return;
    const current = computeBalances(accounts, txns)[accId] || 0;
    const delta = +targetBalance - current;
    if (!delta) { showToast("Already matches"); return; }
    const isCredit = delta > 0;
    const txn = {
      id: uid(), date: today(), type: isCredit ? "credit" : "debit",
      accountTo:   isCredit ? accId : undefined,
      accountFrom: isCredit ? undefined : accId,
      amount: Math.abs(delta),
      currency: acc.currency,
      payee: "Balance Adjustment",
      category: "Balance Adjustment",
      notes: `Reconciled: ${fmtAmt(current, acc.currency)} → ${fmtAmt(+targetBalance, acc.currency)}`,
      createdAt: new Date().toISOString(),
    };
    const list = [txn, ...txns];
    setTxns(list);
    await saveK(companyKeys(company).transactions, list);
    showToast(`✓ ${acc.name} corrected to ${fmtAmt(+targetBalance, acc.currency)}`);
  };

  const handleClassify = async (txnId, { classifiedAs, classifiedRef, sideEffects = {} }, baseTxns = txns) => {
    const _accountPatch = sideEffects.txnPatch;
    const keys = companyKeys(company);
    // Keep the simple `category` field in step with the structured classification —
    // the Accounting Journal already does this, and without it a txn classified from
    // the Ledger still reads as "unclassified" in Classify / Money Flow.
    const newTxns = baseTxns.map(t => t.id === txnId ? { ...t, category: classifiedAs === "expense" ? (classifiedRef?.cat || t.category) : classifiedAs, classifiedAs, classifiedRef, classifiedAt: new Date().toISOString(), ...(_accountPatch || {}) } : t);
    setTxns(newTxns);
    await saveK(keys.transactions, newTxns);

    if (sideEffects.newExpense) {
      const newExps = [...expenses, sideEffects.newExpense];
      setExpenses(newExps);
      await saveK(keys.expenses, newExps);
    }
    // Bill payments + advance draw-down both touch `purchases`; build one array so neither
    // write clobbers the other.
    let nextPurch = purchases; let purchDirty = false;
    if (sideEffects.billUpdates?.length || sideEffects.newBills?.length) {
      const updateMap = Object.fromEntries((sideEffects.billUpdates || []).map(u => [u.id, u]));
      const newIds = new Set((sideEffects.newBills || []).map(b => b.id));
      const basePurchases = [...(sideEffects.newBills || []), ...purchases.filter(p => !newIds.has(p.id))];
      nextPurch = basePurchases.map(p => updateMap[p.id] ? { ...p, ...updateMap[p.id] } : p);
      const affectedIds = new Set((sideEffects.billUpdates || []).map(u => u.id));
      const ledgerPaidForBill = bid => newTxns.reduce((sum, t) => {
        if (t.classifiedAs !== "vendor_bill" || t.classifiedRef?.interCo) return sum;
        if (t.classifiedRef?.billPayments && typeof t.classifiedRef.billPayments === "object") return sum + (+t.classifiedRef.billPayments[bid] || 0);
        const ids = t.classifiedRef?.billIds || (t.classifiedRef?.billId ? [t.classifiedRef.billId] : []);
        if (!ids.includes(bid)) return sum;
        let rem = +t.amount || 0;
        const legacy = {};
        for (const id of ids) {
          if (rem <= 0.005) break;
          const bill = nextPurch.find(p => p.id === id);
          const cap = Math.max(0, +bill?.totalAmount || rem);
          const applied = Math.min(cap || rem, rem);
          if (applied > 0) legacy[id] = applied;
          rem -= applied;
        }
        return sum + (+legacy[bid] || 0);
      }, 0);
      nextPurch = nextPurch.map(p => {
        if (!affectedIds.has(p.id) || p.source !== "misc-bill-maker" || p.paymentNote) return p;
        const paid = +ledgerPaidForBill(p.id).toFixed(2);
        const total = +p.totalAmount || 0;
        return { ...p, paidAmount: paid, status: paid >= total && total > 0 ? "paid" : paid > 0 ? "partial" : "pending", paymentDate: paid > 0 ? (p.paymentDate || newTxns.find(t => t.id === txnId)?.date) : undefined };
      });
      purchDirty = true;
    }
    // Advance/credit applied against the bill: draw it from the vendor's credit balance first,
    // then their open PO advances. Total cash to the vendor is unchanged.
    if (sideEffects.advanceApplied) {
      const { vendorId: avId, amount } = sideEffects.advanceApplied;
      let rem = +amount || 0;
      const vName = (vendors.find(v => v.id === avId)?.name || "").toLowerCase();
      const newVendors = vendors.map(v => {
        if (v.id !== avId) return v;
        const cb = +v.creditBalance || 0; const used = Math.min(cb, rem); rem = +(rem - used).toFixed(2);
        return { ...v, creditBalance: +(cb - used).toFixed(2) };
      });
      if (newVendors.some((v, i) => v !== vendors[i])) { setVendors(newVendors); await saveK(keys.vendors, newVendors); }
      if (rem > 0.005) {
        nextPurch = nextPurch.map(p => {
          if (rem <= 0.005 || p.type !== "po" || ["paid", "closed", "cancelled"].includes(p.status || "")) return p;
          const s = (p.supplier || p.vendorName || "").toLowerCase();
          const match = p.vendorId === avId || (s && vName && (s.includes(vName) || vName.includes(s)));
          if (!match) return p;
          const adv = Math.max(0, +p.paidAmount || +p.advance || 0);
          if (adv <= 0) return p;
          const used = Math.min(adv, rem); rem = +(rem - used).toFixed(2);
          const left = +(adv - used).toFixed(2);
          return { ...p, paidAmount: left, ...(p.advance != null ? { advance: String(left) } : {}) };
        });
        purchDirty = true;
      }
    }
    if (purchDirty) { setPurchases(nextPurch); await saveK(keys.purchases, nextPurch); }
    // legacy single-bill update (backwards compat)
    if (sideEffects.billUpdate) {
      const newPurch = nextPurch.map(p => p.id === sideEffects.billUpdate.id ? { ...p, ...sideEffects.billUpdate } : p);
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
      const newPurch = nextPurch.map(p => p.id === sideEffects.poUpdate.id ? { ...p, ...sideEffects.poUpdate } : p);
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

  // Inline manual entry: add the txn and apply its classification in one pass (against a
  // base list that already includes the new txn, so there's no setState race).
  const saveTxnClassified = async (txn, result) => {
    await handleClassify(txn.id, result, [txn, ...txns]);
    setView("dashboard");
  };

  const balances  = computeBalances(accounts, txns);
  const totalINR  = accounts.filter(a => a.active).reduce((s, a) => {
  const bal = toINR(balances[a.id] || 0, a.currency, rates);
  return isLiabilityAcc(a) ? s - bal : s + bal;
}, 0);

  return (
    <FShell view={view} setView={setView} onHome={onHome} title={view} masked={masked} toggleMask={() => setMasked(v => !v)} company={company} setCompany={setCompany}>
      {!loaded
        ? <div style={{ textAlign: "center", padding: "60px 20px", color: C.inkFaint, fontSize: 14 }}>Loading financial data…</div>
        : <>
          {(() => {
            const fixIds = company === "at" ? findReconFixIds(txns) : [];
            if (!fixIds.length) return null;
            const runFix = async () => {
              if (!window.confirm(`Remove ${fixIds.length} entries that aren't on your IndusInd bank statement (wrong-direction / inter-company / duplicate records)?\n\nThis makes the ledger match the bank. It can't be undone from here, but you can re-add any entry manually.`)) return;
              const rm = new Set(fixIds);
              const list = txns.filter(t => !rm.has(t.id));
              setTxns(list);
              await saveK(companyKeys(company).transactions, list);
              showToast(`✓ Removed ${rm.size} non-bank entr${rm.size === 1 ? "y" : "ies"} — IndusInd now matches the statement`);
            };
            return (
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", background: "#fff8e6", border: "1px solid #f0dfae", borderRadius: 12, padding: "12px 16px", marginBottom: 16 }}>
                <div style={{ flex: 1, minWidth: 240, fontSize: 13, color: "#8a6d1a", lineHeight: 1.5 }}>
                  🔧 <strong>{fixIds.length} entr{fixIds.length === 1 ? "y is" : "ies are"} inflating IndusInd</strong> — records in the ERP that aren't on your uploaded bank statement (wrong-direction, inter-company, or duplicate entries). Clear them so the ledger ties out to the bank to the paisa.
                </div>
                <button onClick={runFix} style={{ background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 10, padding: "10px 20px", fontSize: 13, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>
                  Fix reconciliation →
                </button>
              </div>
            );
          })()}
          {view === "dashboard"  && <Dashboard accounts={accounts} transactions={txns} rates={rates} invoices={invoices} purchases={purchases} balances={balances} totalINR={totalINR} onAddTxn={() => setView("add")} />}
          {view === "flow"       && <MoneyFlowView transactions={txns} accounts={accounts} rates={rates} totalINR={totalINR} onUpdate={updateTxn} />}
          {view === "assets"     && <AssetDashboard assets={assets} rates={rates} onSave={saveAsset} onDelete={deleteAsset} />}
          {view === "ledger"     && <LedgerView transactions={txns} accounts={accounts} rates={rates} onDelete={deleteTxn} onUpdate={updateTxn} vendors={vendors} purchases={purchases} expenses={expenses} invoices={invoices} buyers={buyers} onClassify={handleClassify} />}
          {view === "add"        && <AddTxnForm accounts={accounts} invoices={invoices} purchases={purchases} ledgerTxns={txns} vendors={vendors} buyers={buyers} rates={rates} expenseCats={EXP_CATS} onSave={saveTxn} onSaveClassified={saveTxnClassified} onCancel={() => setView("dashboard")} />}
          {view === "accounts"   && <AccountsSettings accounts={accounts} rates={rates} balances={balances} onUpdate={saveAccounts} onUpdateRates={saveRates} onFetchRates={()=>fetchLiveRates(rates)} fetchingRates={fetchingRates} onAdjustBalance={adjustBalance} onReassignTxns={async (fromId, toId) => { const updated = txns.map(t => ({ ...t, accountFrom: t.accountFrom===fromId ? toId : t.accountFrom, accountTo: t.accountTo===fromId ? toId : t.accountTo })); setTxns(updated); await saveK(companyKeys(company).transactions, updated); showToast("Transactions moved"); }} />}
          {view === "classify"   && <ExpenseSplitView transactions={txns} accounts={accounts} vendors={vendors} purchases={purchases} invoices={invoices} buyers={buyers} rates={rates} company={company} onClassify={handleClassify} />}
          {view === "reconcile"  && <ReconcileView accounts={accounts} transactions={txns} company={company} onAddTxns={async (newTxns) => { const list = [...newTxns, ...txns]; setTxns(list); await saveK(companyKeys(company).transactions, list); showToast(`${newTxns.length} transaction${newTxns.length>1?"s":""} added to ledger`); }} onApplyTxns={async ({ add = [], removeIds = [], openingBalance = null, accountId = null }) => { const rm = new Set(removeIds); const list = [...add, ...txns.filter(t => !rm.has(t.id))]; setTxns(list); await saveK(companyKeys(company).transactions, list); let obMsg = ""; if (openingBalance != null && accountId) { const accs = accounts.map(a => a.id === accountId ? { ...a, openingBal: +openingBalance } : a); setAccounts(accs); await saveK(companyKeys(company).accounts, accs); obMsg = ` · opening bal ₹${(+openingBalance).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`; } showToast([add.length ? `${add.length} added` : "", removeIds.length ? `${removeIds.length} removed` : ""].filter(Boolean).join(" · ") + " — ledger matches bank" + obMsg); }} />}
        </>
      }
      {/* Inline classify after manual entry */}
      {pendingClassify && (
        <ClassifyTransactionModal
          txn={pendingClassify}
          accounts={accounts}
	          vendors={vendors}
	          purchases={purchases}
	          ledgerTxns={txns}
	          invoices={invoices}
          buyers={buyers}
          rates={rates}
          expenseCats={EXP_CATS}
          onSave={(result) => {
            handleClassify(pendingClassify.id, result);
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
