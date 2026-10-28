import { useEffect, useMemo, useState } from "react";
import { C, FI } from "./ui.jsx";
import { mob, fmtDate, saveK } from "./utils.js";
import { loadLearnMemory } from "./classifyLearner.js";
import {
  paymentChecks, balanceChecks, statementAccounts, accountBalanceAt, statementsKey, monthOf, shiftMonth, monthLabel,
} from "./monthClose.js";
import { remittanceChecks, ngRemitSettlement, ngRemitMissing, atFircMissing, atFircSettlement, NG_REMIT_KEY, AT_META_KEY, isEefc } from "./remittances.js";
import { ngReconMonth, atReconMonth, NG_BANK_SB_KEY, RECON_CLOSE_KEY, reconCloseId, DOCS_LABEL } from "./reconMonth.js";
import { feesBooked } from "./remittanceFees.js";
import { applyStatementImport } from "./statementImport.js";
import { useKeys } from "./HomeAccounts.jsx";
import PaymentQueue, { needsBill, money } from "./PaymentQueue.jsx";
import MonthClose from "./MonthClose.jsx";
import RemittanceRegister from "./RemittanceRegister.jsx";
import { ReconcileView } from "./FinanceApp.jsx";
import { aiExtract } from "./ExportReconciliationApp.jsx";

/* Accounting — the books for one company at a time, as one place: a dashboard
   of what needs doing, and the work itself.

     Overview         balances, the month in numbers, everything open, the modules
     Classify         every payment has a head or its bill
     Bank statements  upload a statement per account, ERP against the bank month by month
     Reconcile        the month close (payments, bank, remittances, export recon)
     Export recon     invoice ↔ shipping bill ↔ docs to bank ↔ remittance credited ↔ BRC, side by side
     Remittances      the BOI register (fees read off the advice, booked), an invoice for every one

   Nothing here keeps its own copy: it reads the Ledger's entries, the statements,
   the remittance register and Export Recon's records, and writes through the
   same helpers those screens use. Anything that needs the full form opens it. */

const VIEWS = [
  ["home", "Overview"], ["classify", "Classify"], ["bank", "Bank statements"],
  ["reconcile", "Reconcile"], ["export", "Export recon"], ["remit", "Remittances & BRC"],
];
const CUSTOM_CATS_KEY = "ng-accounting-ledger-custom-cats-v1";
const RATES_KEY = "ng-fin-rates-v1";
const DEFAULT_RATES = { INR: 1, USD: 85, EUR: 92, JPY: 0.57, GBP: 107, AUD: 55 };
const arr = v => (Array.isArray(v) ? v : []);
const today = () => new Date().toISOString().slice(0, 10);
const sumByCur = (list, amt = t => +t.amount || 0, cur = t => t.currency || "INR") => {
  const m = {};
  list.forEach(t => { const c = cur(t); m[c] = (m[c] || 0) + amt(t); });
  const parts = Object.entries(m).filter(([, v]) => Math.abs(v) > 0.004)
    .sort((a, b) => (a[0] === "INR" ? -1 : b[0] === "INR" ? 1 : b[1] - a[1])).map(([c, v]) => money(v, c));
  return parts.join(" + ") || money(0);
};
const serif = "'Cormorant Garamond',Georgia,serif";

function Card({ title, sub, right, children, pad = true }) {
  return (
    <div style={{ background: C.surface, borderRadius: 16, boxShadow: "var(--e-1)", padding: pad ? (mob ? 14 : "16px 18px") : 0, minWidth: 0 }}>
      {(title || right) && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 10, padding: pad ? 0 : (mob ? "14px 14px 0" : "16px 18px 0") }}>
          <div>
            {title && <div style={{ fontSize: 10, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: 1.1 }}>{title}</div>}
            {sub && <div style={{ fontSize: 12, color: C.inkMid, marginTop: 3, lineHeight: 1.4 }}>{sub}</div>}
          </div>
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

function Stat({ label, value, sub, tone = C.ink, onClick, big }) {
  return (
    <button onClick={onClick} disabled={!onClick} style={{ textAlign: "left", background: C.card, border: "none", borderRadius: 12, padding: "12px 14px", cursor: onClick ? "pointer" : "default", fontFamily: "inherit", minWidth: 0, color: "inherit" }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .9 }}>{label}</div>
      <div style={{ fontSize: big ? (mob ? 20 : 24) : (mob ? 16 : 18), fontFamily: big ? serif : "inherit", fontWeight: big ? 600 : 800, color: tone, marginTop: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: C.inkMid, marginTop: 3, lineHeight: 1.35 }}>{sub}</div>}
    </button>
  );
}

// A to-do tile: green when there is nothing left, amber/red with the count when there is.
function Todo({ label, count, okText, detail, onClick, red }) {
  const ok = !count;
  const tone = ok ? C.green : red ? C.red : C.amber;
  return (
    <button onClick={onClick} style={{ textAlign: "left", background: ok ? C.surface : C.card, border: `1.5px solid ${ok ? C.border : tone}`, borderRadius: 12, padding: "11px 13px", cursor: "pointer", fontFamily: "inherit", minWidth: 0, color: "inherit" }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .9 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 850, color: tone, marginTop: 4 }}>{ok ? `✓ ${okText}` : count}</div>
      {detail && <div style={{ fontSize: 11, color: C.inkMid, marginTop: 2, lineHeight: 1.35 }}>{detail}</div>}
    </button>
  );
}

function Chip({ on, onClick, children }) {
  return <button onClick={onClick} style={{ border: `1px solid ${on ? C.ink : C.border}`, background: on ? C.ink : C.surface, color: on ? C.surface : C.inkMid, borderRadius: 999, padding: "4px 11px", fontSize: 11.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>{children}</button>;
}

function Bars({ rows }) {
  const max = Math.max(1, ...rows.map(r => r.value));
  return (
    <div style={{ display: "grid", gap: 7 }}>
      {rows.map(r => (
        <div key={r.key} style={{ display: "grid", gridTemplateColumns: "minmax(0,150px) 1fr auto", gap: 10, alignItems: "center", fontSize: 12 }}>
          <span style={{ color: C.ink, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.label}</span>
          <div style={{ height: 8, background: C.card, borderRadius: 99, overflow: "hidden" }}><div style={{ width: `${Math.max(2, r.value / max * 100)}%`, height: "100%", background: C.gold, borderRadius: 99 }} /></div>
          <span style={{ color: C.inkMid, fontWeight: 750, whiteSpace: "nowrap" }}>{r.text}</span>
        </div>
      ))}
    </div>
  );
}

const DOC_TONE = { done: "green", cleared: "green", submitted: "blue", packet: "amber", prepared: "amber", pending: "grey", rejected: "red" };
function Pill({ tone = "grey", children, title }) {
  const t = { green: [C.green, C.greenBg], amber: [C.amber, C.amberBg], red: [C.red, C.redBg], grey: [C.inkMid, C.card], blue: [C.blue, C.blueBg] }[tone];
  return <span title={title} style={{ display: "inline-block", fontSize: 10.5, fontWeight: 800, color: t[0], background: t[1], borderRadius: 999, padding: "2px 8px", whiteSpace: "nowrap" }}>{children}</span>;
}

/* Export recon, side by side: one row per shipping bill, left to right the way
   an export settles — invoice, shipping bill, documents to the bank, remittance
   credited (with the bank's fees), realisation, BRC. */
function ExportSideBySide({ company, rows, onOpenRecon }) {
  const [filter, setFilter] = useState("open");
  const realisedNoBrc = r => r.status === "realised" && !r.brc;
  const docsOpen = r => !["submitted", "done", "cleared"].includes(r.docs);
  const filters = [
    ["open", "Open", r => r.problems.length || r.status !== "realised" || !r.brc || docsOpen(r)],
    ["docs", "Docs not sent", docsOpen],
    ["unrealised", "Not realised", r => r.status !== "realised"],
    ["brc", "BRC pending", realisedNoBrc],
    ["fix", "To fix", r => r.problems.length > 0],
    ["done", "Closed with BRC", r => r.status === "realised" && r.brc],
    ["all", "All", () => true],
  ];
  const pred = (filters.find(f => f[0] === filter) || filters[0])[2];
  const shown = rows.filter(pred);
  const th = { textAlign: "left", fontSize: 10, fontWeight: 800, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .4, padding: "9px 10px", whiteSpace: "nowrap", position: "sticky", top: 0, background: C.card };
  const td = { padding: "9px 10px", fontSize: 12, color: C.ink, borderTop: `1px solid ${C.border}`, verticalAlign: "top" };
  const at = company === "at";
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {filters.map(([k, l, p]) => <Chip key={k} on={filter === k} onClick={() => setFilter(k)}>{l} · {rows.filter(p).length}</Chip>)}
        <div style={{ flex: 1 }} />
        <button className="bs" style={{ fontSize: 11.5, padding: "5px 11px" }} onClick={() => onOpenRecon(at ? "sbs" : "ngsheet")}>Open in Export Recon →</button>
      </div>
      <div style={{ border: `1px solid ${C.border}`, borderRadius: 12, overflow: "auto", background: C.surface, maxHeight: mob ? "none" : "70vh" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1080 }}>
          <thead><tr>
            {["Invoice", "Shipping bill", "Docs to bank", at ? "FIRC credited" : "Remittance credited", "Fees", "Realised", "BRC"].map(h => <th key={h} style={th}>{h}</th>)}
          </tr></thead>
          <tbody>
            {shown.length === 0 && <tr><td colSpan={7} style={{ ...td, textAlign: "center", color: C.inkFaint, padding: 24 }}>Nothing here.</td></tr>}
            {shown.map(r => {
              const fees = r.credits.reduce((s, c) => s + (+c.charges || 0), 0);
              return (
                <tr key={r.key} style={{ background: r.problems.length ? C.redBg : "transparent" }}>
                  <td style={td}>
                    <div style={{ fontWeight: 800 }}>{r.invNo || <span style={{ color: C.red }}>No invoice</span>}</div>
                    <div style={{ fontSize: 11, color: C.inkFaint }}>{r.buyer || "—"}</div>
                    {r.value > 0 && <div style={{ fontSize: 11.5, fontWeight: 750 }}>{money(r.value, r.currency || "INR")}</div>}
                  </td>
                  <td style={{ ...td, wordBreak: "break-all", maxWidth: 190 }}>
                    <div style={{ fontWeight: 750 }}>{r.sbNo || <span style={{ color: C.red }}>No SB</span>}</div>
                    <div style={{ fontSize: 11, color: C.inkFaint }}>{r.sbDate ? fmtDate(r.sbDate) : ""}</div>
                  </td>
                  <td style={td}>
                    <Pill tone={DOC_TONE[r.docs] || "grey"}>{DOCS_LABEL[r.docs] || r.docs}</Pill>
                    {r.submittedAt && <div style={{ fontSize: 10.5, color: C.inkFaint, marginTop: 3 }}>sent {fmtDate(r.submittedAt)}</div>}
                  </td>
                  <td style={td}>
                    {r.credits.length === 0 && <span style={{ color: C.inkFaint }}>—</span>}
                    {r.credits.map(c => (
                      <div key={c.id} style={{ marginBottom: 3 }}>
                        <div style={{ fontWeight: 750 }}>{c.irt}</div>
                        <div style={{ fontSize: 11, color: C.inkMid }}>{c.date ? fmtDate(c.date) : "no date"} · {money(c.alloc, c.currency || "INR")}{c.inr && c.currency !== "INR" ? ` → ${money(c.inr)}` : ""}{c.eefc ? " · EEFC" : ""}</div>
                      </div>
                    ))}
                  </td>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>{fees > 0 ? money(fees) : r.credits.length ? <span style={{ color: r.credits.some(c => c.charges == null) ? C.amber : C.inkFaint }}>{r.credits.some(c => c.charges == null) ? "not read" : "—"}</span> : "—"}</td>
                  <td style={td}>
                    {r.status === "realised" ? <span style={{ color: C.green, fontWeight: 800 }}>✓ Realised</span>
                      : <span style={{ color: r.overdue ? C.red : C.amber, fontWeight: 800 }}>{r.status === "part" ? `Part · ${money(r.realised, r.currency)}` : "Not yet"}
                        {r.dueDate && <span style={{ display: "block", fontSize: 10.5 }}>{r.overdue ? "past" : "due by"} {fmtDate(r.dueDate)}</span>}</span>}
                    {r.problems.map(p => <div key={p} style={{ fontSize: 10.5, color: C.red, fontWeight: 700, marginTop: 2 }}>{p}</div>)}
                  </td>
                  <td style={td}>{r.brc ? <Pill tone="green">✓ Cleared</Pill> : r.status === "realised" ? <Pill tone="amber">Pending</Pill> : <span style={{ color: C.inkFaint }}>—</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function AccountingApp({ mods = [], onEnter, isUnclassified, canBank = false }) {
  const [company, setCompany] = useState(() => { try { return localStorage.getItem("ng-accounting-company") || "ng"; } catch { return "ng"; } });
  const [view, setView] = useState(() => { try { return sessionStorage.getItem("acct-open-view") || "home"; } catch { return "home"; } });
  useEffect(() => { try { sessionStorage.removeItem("acct-open-view"); } catch {} }, []);
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [classifyScope, setClassifyScope] = useState("open");
  const [exportScope, setExportScope] = useState("all");
  const [memory, setMemory] = useState([]);
  const [toast, setToast] = useState("");
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(""), 4000); return () => clearTimeout(t); }, [toast]);
  const pickCompany = co => { setCompany(co); try { localStorage.setItem("ng-accounting-company", co); } catch {} };
  const ng = company === "ng";
  const lastMonth = shiftMonth(month, -1);

  const keys = {
    accounts: `${company}-fin-accounts-v1`, txns: `${company}-fin-txns-v1`, statements: statementsKey(company),
    invoices: ng ? "ng-invoices-v2" : null, remits: ng ? NG_REMIT_KEY : null, bankSbs: ng ? NG_BANK_SB_KEY : null, meta: ng ? null : AT_META_KEY,
  };
  const [data, setData] = useKeys([...Object.values(keys), CUSTOM_CATS_KEY, RECON_CLOSE_KEY, RATES_KEY, `${ng ? "at" : "ng"}-fin-txns-v1`]);
  const rates = { ...DEFAULT_RATES, ...(data[RATES_KEY] && typeof data[RATES_KEY] === "object" && !Array.isArray(data[RATES_KEY]) ? data[RATES_KEY] : {}), INR: 1 };
  const inInr = (amount, cur) => (+amount || 0) * (rates[cur || "INR"] || 1);
  useEffect(() => { let alive = true; setMemory([]); loadLearnMemory(company).then(m => { if (alive) setMemory(m); }).catch(() => {}); return () => { alive = false; }; }, [company]);

  const accounts = arr(data[keys.accounts]);
  const txns = arr(data[keys.txns]);
  const statements = arr(data[keys.statements]);
  const invoices = arr(data[keys.invoices]);
  const remits = arr(data[keys.remits]);
  const bankSbs = keys.bankSbs ? data[keys.bankSbs] : null;
  const metaRaw = keys.meta ? data[keys.meta] : null;
  const meta = useMemo(() => { const m = metaRaw?.meta || metaRaw || {}; return { fircs: arr(m.fircs), shippingBills: arr(m.shippingBills), invoices: arr(m.invoices) }; }, [metaRaw]);
  const closes = arr(data[RECON_CLOSE_KEY]);
  const putTxn = t => setData(v => ({ ...v, [keys.txns]: arr(v[keys.txns]).map(x => (x.id === t.id ? t : x)) }));
  const otherCount = arr(data[`${ng ? "at" : "ng"}-fin-txns-v1`]).filter(t => t.type === "debit" && (isUnclassified(t) || needsBill(t, isUnclassified))).length;

  // ── Everything the views read, worked out once ────────────────────────────
  const pay = useMemo(() => paymentChecks({ txns, month, isUnclassified }), [txns, month, isUnclassified]);
  const openPayments = useMemo(() => txns.filter(t => t.type === "debit" && (isUnclassified(t) || needsBill(t, isUnclassified)))
    .sort((a, b) => (b.date || "").localeCompare(a.date || "")), [txns, isUnclassified]);
  const moneyIn = txns.filter(t => t.type === "credit" && monthOf(t.date) === month);
  const bankNow = useMemo(() => balanceChecks({ accounts, txns, statements, month, history: 6 }), [accounts, txns, statements, month]);
  const bankLast = useMemo(() => balanceChecks({ accounts, txns, statements, month: lastMonth, history: 1 }), [accounts, txns, statements, lastMonth]);
  const rem = useMemo(() => remittanceChecks({ company, month, accounts, txns, remittances: remits, invoices, fircs: meta.fircs, sbs: meta.shippingBills }), [company, month, accounts, txns, remits, invoices, meta]);
  const reconFor = m => (ng ? ngReconMonth({ month: m, invoices, remittances: remits, bankSbs: bankSbs && !Array.isArray(bankSbs) ? bankSbs : null }) : atReconMonth({ month: m, meta }));
  const reconAll = useMemo(() => reconFor("all"), [ng, invoices, remits, bankSbs, meta]);
  const reconMonthRes = useMemo(() => reconFor(month), [ng, month, invoices, remits, bankSbs, meta]);
  const remitList = ng ? remits : meta.fircs;
  const noInvoice = ng ? remits.filter(r => !ngRemitSettlement(r, invoices).allocs.length) : meta.fircs.filter(f => !atFircSettlement(f, meta.shippingBills).linked.length);
  const feesOpen = ng ? remits.filter(r => !feesBooked(r)) : [];
  const incomplete = remitList.filter(r => (ng ? ngRemitMissing(r) : atFircMissing(r)).length);
  const allRows = reconAll.rows;
  const docsOpen = allRows.filter(r => r.value > 0 && !["submitted", "done", "cleared"].includes(r.docs));
  const brcPending = allRows.filter(r => r.status === "realised" && !r.brc);
  const brcCleared = allRows.filter(r => r.brc);
  const signed = closes.find(c => c.id === reconCloseId(ng ? "nikhil" : "atyahara", month))?.reconciledAt;
  const realisedInMonth = useMemo(() => {
    if (ng) return remits.filter(r => monthOf(r.date) === month).reduce((s, r) => s + (isEefc(r) ? 0 : +r.inrCredited || 0), 0);
    return meta.fircs.filter(f => monthOf(f.date) === month).reduce((s, f) => s + (+f.amount || 0), 0);
  }, [ng, remits, meta, month]);
  const feesInMonth = remitList.filter(r => monthOf(r.date) === month).reduce((s, r) => s + (+r.charges || 0), 0);

  // ── Ways out to the screens that own the records ──────────────────────────
  const openLedger = (hint = {}) => {
    try { localStorage.setItem("ng-accounting-ledger-company", company); sessionStorage.setItem("ledger-open", JSON.stringify({ company, ...hint })); } catch {}
    onEnter?.("ledger");
  };
  const openRecon = v => {
    try { localStorage.setItem("ng-export-recon-company", ng ? "nikhil" : "atyahara"); sessionStorage.setItem("er-open-view", v); } catch {}
    onEnter?.("recon");
  };

  const coBtn = (co, label) => (
    <button key={co} onClick={() => pickCompany(co)} style={{ border: "none", borderRadius: 8, padding: "6px 13px", cursor: "pointer", fontSize: 12.5, fontWeight: 700, fontFamily: "inherit", background: company === co ? (co === "at" ? C.purple : C.ink) : "transparent", color: company === co ? "#fff" : C.inkMid }}>
      {label}{company !== co && otherCount > 0 && <span style={{ marginLeft: 6, background: C.amberBg, color: C.amber, borderRadius: 999, padding: "0 6px", fontSize: 10.5 }}>{otherCount}</span>}
    </button>
  );
  const badge = { classify: openPayments.length, bank: bankLast.filter(b => !b.ok).length, remit: rem.unentered.length + noInvoice.length + feesOpen.length, export: reconAll.fix.length, reconcile: signed ? 0 : null };

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {/* Header: the company, the month, and the sub-functions */}
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontFamily: serif, fontSize: mob ? 26 : 32, fontWeight: 600, color: C.ink, lineHeight: 1.05 }}>Accounts</div>
          <div style={{ fontSize: 12.5, color: C.inkMid, marginTop: 4 }}>{ng ? "Nikhil Gems" : "Atyahara"} · {monthLabel(month)}</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 3, background: C.card, borderRadius: 10, padding: 3 }}>{coBtn("ng", "Nikhil Gems")}{coBtn("at", "Atyahara")}</div>
          <input type="month" value={month} onChange={e => setMonth(e.target.value || month)} aria-label="Month" style={{ ...FI, width: 160, fontSize: 12.5, padding: "7px 10px" }} />
        </div>
      </div>
      <div style={{ display: "flex", gap: 4, overflowX: "auto", borderBottom: `1px solid ${C.border}`, paddingBottom: 0 }}>
        {VIEWS.map(([id, label]) => {
          const n = badge[id];
          return (
            <button key={id} onClick={() => setView(id)} style={{ background: "none", border: "none", borderBottom: `2.5px solid ${view === id ? C.ink : "transparent"}`, padding: "8px 10px 9px", fontSize: 13, fontWeight: view === id ? 800 : 600, color: view === id ? C.ink : C.inkMid, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>
              {label}{n > 0 && <span style={{ marginLeft: 6, background: C.amberBg, color: C.amber, borderRadius: 999, padding: "1px 7px", fontSize: 10.5, fontWeight: 800 }}>{n}</span>}
            </button>
          );
        })}
      </div>
      {toast && <div style={{ background: C.greenBg, color: C.green, borderRadius: 10, padding: "8px 12px", fontSize: 12.5, fontWeight: 700 }}>{toast}</div>}

      {view === "home" && (
        <>
          <Card title="Balances" sub="The ERP's balance on each account today, and how it stood against the bank last month." pad>
            <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr 1fr" : "repeat(auto-fill, minmax(210px, 1fr))", gap: 8 }}>
              {statementAccounts(accounts).map(acc => {
                const chk = bankLast.find(b => b.acc.id === acc.id);
                const tone = !chk?.statement ? C.inkFaint : chk.ok ? C.green : C.red;
                return <Stat key={acc.id} label={acc.name} big value={money(accountBalanceAt(acc, txns, today()), acc.currency || "INR")}
                  sub={<span style={{ color: tone, fontWeight: 700 }}>{!chk?.statement ? `No ${monthLabel(lastMonth, { month: "short" })} statement` : chk.ok ? `✓ Ties to ${monthLabel(lastMonth, { month: "short" })} statement` : `${monthLabel(lastMonth, { month: "short" })} off by ${money(Math.abs(chk.diff), acc.currency)}`}</span>}
                  onClick={() => setView("bank")} />;
              })}
            </div>
          </Card>

          <Card title={`${monthLabel(month)} in numbers`}>
            <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr 1fr" : "repeat(4, minmax(0,1fr))", gap: 8 }}>
              <Stat label="Paid out" value={sumByCur(pay.payments)} sub={`${pay.payments.length} payment${pay.payments.length === 1 ? "" : "s"}`} onClick={() => setView("classify")} />
              <Stat label="Money in" value={sumByCur(moneyIn)} sub={`${moneyIn.length} credit${moneyIn.length === 1 ? "" : "s"}`} onClick={() => openLedger({ month })} />
              <Stat label="Export realised" value={money(realisedInMonth)} sub={`${remitList.filter(r => monthOf(r.date) === month).length} ${ng ? "remittance" : "FIRC"}s credited`} onClick={() => setView("remit")} />
              <Stat label="Bank fees on remittances" value={money(feesInMonth)} sub={ng ? (feesOpen.length ? `${feesOpen.length} not booked yet` : "All booked") : "Read off the FIRCs"} onClick={() => setView("remit")} />
            </div>
          </Card>

          <Card title="What's open" sub="Each is a list you can clear — click through.">
            <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr 1fr" : "repeat(4, minmax(0,1fr))", gap: 8 }}>
              <Todo label="Payments to classify" count={openPayments.filter(t => isUnclassified(t)).length} okText="All have a head" detail={`${openPayments.filter(t => !isUnclassified(t)).length} more paid to a vendor with no bill`} onClick={() => setView("classify")} />
              <Todo label={`Bank vs statement · ${monthLabel(lastMonth, { month: "short" })}`} count={bankLast.filter(b => !b.ok).length} red={bankLast.some(b => b.statement && !b.ok)} okText="Ties out"
                detail={`${bankLast.filter(b => b.statement && !b.ok).length} off · ${bankLast.filter(b => !b.statement).length} without a statement`} onClick={() => setView("bank")} />
              <Todo label={`BOI credits not entered`} count={rem.unentered.length} red okText="All entered" detail={rem.unentered.length ? `${sumByCur(rem.unentered)} this month` : `${monthLabel(month, { month: "short" })}`} onClick={() => setView("remit")} />
              <Todo label="Remittances with no invoice" count={noInvoice.length} okText="Every one invoiced" detail={`${incomplete.length} missing a detail`} onClick={() => setView("remit")} />
              <Todo label="Docs not sent to the bank" count={docsOpen.length} okText="All sent" detail="Shipping bills whose packet isn't submitted" onClick={() => { setExportScope("all"); setView("export"); }} />
              <Todo label="Not realised" count={reconAll.outstanding.length} red={reconAll.overdue.length > 0} okText="All realised"
                detail={reconAll.overdue.length ? `${reconAll.overdue.length} past the 9-month deadline` : `${sumByCur(reconAll.outstanding, r => Math.max(0, r.value - r.realised), r => r.currency || "INR")} to come`} onClick={() => setView("export")} />
              <Todo label="BRCs" count={brcPending.length} okText={`${brcCleared.length} cleared`} detail={`${brcCleared.length} cleared · ${brcPending.length} realised, BRC pending`} onClick={() => setView("export")} />
              <Todo label={`${monthLabel(month, { month: "short" })} reconciled`} count={signed ? 0 : (reconMonthRes.fix.length || "Not signed off")} okText={`Signed off ${fmtDate(String(signed).slice(0, 10))}`}
                detail={reconMonthRes.fix.length ? `${reconMonthRes.fix.length} to fix first` : "Go through the month and sign it off"} onClick={() => setView("reconcile")} />
            </div>
          </Card>

          <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr" : "minmax(0,1fr) minmax(0,1.3fr)", gap: 14 }}>
            <Card title={`Where ${monthLabel(month, { month: "long" })}'s payments went`}>
              {pay.heads.length === 0 ? <div style={{ fontSize: 12.5, color: C.inkFaint }}>No classified payments this month yet.</div>
                : <Bars rows={pay.heads.slice(0, 9).map(h => ({ key: `${h.head}|${h.currency}`, label: h.head, value: inInr(h.amount, h.currency), text: money(h.amount, h.currency) }))} />}
            </Card>
            <Card title="Payments to classify" right={<button className="bs" style={{ fontSize: 11.5, padding: "4px 10px" }} onClick={() => setView("classify")}>All {openPayments.length} →</button>}>
              <PaymentQueue key={company} company={company} items={openPayments} accounts={accounts} isUnclassified={isUnclassified} memory={memory}
                customHeads={arr(data[CUSTOM_CATS_KEY])} limit={5} onOpenLedger={openLedger} onSaved={putTxn} emptyText="Every payment has a head and its bill." />
            </Card>
          </div>

          <Card title="Modules">
            <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr 1fr" : "repeat(auto-fill, minmax(190px, 1fr))", gap: 8 }}>
              {mods.map(m => (
                <button key={m.id} onClick={() => onEnter?.(m.id)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: C.card, border: "none", borderRadius: 12, cursor: "pointer", fontFamily: "inherit", textAlign: "left", color: "inherit" }}>
                  <span style={{ fontSize: 18 }}>{m.icon}</span>
                  <span style={{ minWidth: 0 }}><span style={{ display: "block", fontSize: 13, fontWeight: 750, color: C.ink }}>{m.title}</span><span style={{ display: "block", fontSize: 10.5, color: C.inkFaint, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.desc}</span></span>
                </button>
              ))}
            </div>
          </Card>
        </>
      )}

      {view === "classify" && (() => {
        const items = classifyScope === "month" ? openPayments.filter(t => monthOf(t.date) === month) : openPayments;
        return (
          <div style={{ display: "grid", gap: 14 }}>
            <Card title="Every payment has a bill or a head" sub="No head yet: pick one here (the head used for that payee before is offered first). Vendor bills, card payments and transfers open in the Ledger. Paid to a vendor with no bill: link the bill there."
              right={<div style={{ display: "flex", gap: 6 }}><Chip on={classifyScope === "open"} onClick={() => setClassifyScope("open")}>All open · {openPayments.length}</Chip><Chip on={classifyScope === "month"} onClick={() => setClassifyScope("month")}>{monthLabel(month, { month: "short" })} · {openPayments.filter(t => monthOf(t.date) === month).length}</Chip></div>}>
              <PaymentQueue key={`${company}:${classifyScope}`} company={company} items={items} accounts={accounts} isUnclassified={isUnclassified} memory={memory}
                customHeads={arr(data[CUSTOM_CATS_KEY])} limit={25} onOpenLedger={openLedger} onSaved={putTxn} emptyText={classifyScope === "month" ? `Every payment in ${monthLabel(month)} has a head and its bill.` : "Every payment has a head and its bill."} />
            </Card>
            {pay.heads.length > 0 && (
              <Card title={`${monthLabel(month)} by head`}>
                <Bars rows={pay.heads.map(h => ({ key: `${h.head}|${h.currency}`, label: `${h.head} · ${h.count}`, value: inInr(h.amount, h.currency), text: money(h.amount, h.currency) }))} />
              </Card>
            )}
          </div>
        );
      })()}

      {view === "bank" && (
        <div style={{ display: "grid", gridTemplateColumns: mob || !canBank ? "1fr" : "minmax(0,1fr) minmax(0,1fr)", gap: 14, alignItems: "start" }}>
          <Card title="ERP against the bank" sub={`Closing balance at the end of each month, from the statements imported. ${monthLabel(month)} and the five before it.`}>
            <div style={{ display: "grid", gap: 10 }}>
              {bankNow.length === 0 && <div style={{ fontSize: 12.5, color: C.inkFaint }}>No bank accounts set up for this company.</div>}
              {bankNow.map(b => (
                <div key={b.acc.id} style={{ background: C.card, borderRadius: 12, padding: "11px 13px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                    <div style={{ fontSize: 13, fontWeight: 800, color: C.ink }}>{b.acc.name} <span style={{ color: C.inkFaint, fontWeight: 600 }}>· {b.acc.currency}</span></div>
                    <div style={{ fontSize: 12.5, fontWeight: 800, color: C.ink }}>{money(accountBalanceAt(b.acc, txns, today()), b.acc.currency)} <span style={{ color: C.inkFaint, fontWeight: 600 }}>today</span></div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0,1fr))", gap: 5, marginTop: 8 }}>
                    {b.history.map(h => (
                      <div key={h.month} title={h.statement ? `ERP ${money(h.erp, b.acc.currency)} · statement ${money(h.statement.closing, b.acc.currency)}` : "No statement"}
                        style={{ background: C.surface, borderRadius: 8, padding: "6px 4px", textAlign: "center", border: `1px solid ${h.month === month ? C.ink : "transparent"}` }}>
                        <div style={{ fontSize: 10, color: C.inkFaint, fontWeight: 700 }}>{monthLabel(h.month, { month: "short" })}</div>
                        <div style={{ fontSize: 11, fontWeight: 850, color: !h.statement ? C.inkFaint : h.ok ? C.green : C.red, whiteSpace: "nowrap" }}>{!h.statement ? "—" : h.ok ? "✓" : `${h.diff > 0 ? "+" : "−"}${money(Math.abs(h.diff), b.acc.currency)}`}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              <button className="bs" style={{ fontSize: 12, justifySelf: "start" }} onClick={() => setView("reconcile")}>Type a closing in, or see why a month is off →</button>
            </div>
          </Card>
          {canBank && (
            <Card title="Upload a bank statement" sub="PDF (read by AI), CSV or Excel. Rows missing from the ledger are added, and the statement's month-end balances are kept for the check on the left.">
              <ReconcileView key={`${company}:${statementAccounts(accounts).length}`} accounts={statementAccounts(accounts)} transactions={txns} company={company}
                onAddTxns={async newTxns => { const list = [...newTxns, ...txns]; setData(v => ({ ...v, [keys.txns]: list })); await saveK(keys.txns, list); setToast(`${newTxns.length} entr${newTxns.length === 1 ? "y" : "ies"} added to the ledger`); }}
                onApplyTxns={async args => { const r = await applyStatementImport({ company, accounts, txns, ...args }); setData(v => ({ ...v, [keys.txns]: r.txns, [keys.accounts]: r.accounts, ...(r.statements ? { [keys.statements]: r.statements } : {}) })); setToast(r.message); }} />
            </Card>
          )}
        </div>
      )}

      {view === "reconcile" && (
        <MonthClose key={`${company}:${month}`} company={company} month={month} accounts={accounts} txns={txns} isUnclassified={isUnclassified}
          onOpenTxn={t => openLedger({ id: t.id, month: monthOf(t.date) })}
          onOpenRecon={v => setView(v === "ngremit" || v === "fircs" ? "remit" : "export")}
          onClose={() => setView("home")} closeLabel="Back to overview" />
      )}

      {view === "export" && (
        <Card title="Export recon, side by side" sub="Each shipping bill left to right: its invoice, the documents sent to the bank, the remittance credited and the bank's fees, realisation, and the BRC."
          right={<div style={{ display: "flex", gap: 6 }}><Chip on={exportScope === "all"} onClick={() => setExportScope("all")}>All months</Chip><Chip on={exportScope === "month"} onClick={() => setExportScope("month")}>{monthLabel(month, { month: "short" })}</Chip></div>}>
          <ExportSideBySide company={company} rows={(exportScope === "month" ? reconMonthRes : reconAll).rows.slice().sort((a, b) => String(b.sbDate || "").localeCompare(String(a.sbDate || "")))} onOpenRecon={openRecon} />
        </Card>
      )}

      {view === "remit" && (
        <div style={{ display: "grid", gap: 14 }}>
          <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr 1fr" : "repeat(4, minmax(0,1fr))", gap: 8 }}>
            <Todo label="BOI credits not entered" count={rem.unentered.length} red okText="All entered" detail={`${monthLabel(month, { month: "short" })} · in the bank ledger`} onClick={() => {}} />
            <Todo label={`${ng ? "Remittances" : "FIRCs"} with no invoice`} count={noInvoice.length} okText="Every one invoiced" detail={ng ? "Advances included — invoice them when they ship" : "No shipping bill realised by it yet"} onClick={() => {}} />
            <Todo label="Fees not booked" count={feesOpen.length} okText={ng ? "All booked" : "Kept on the FIRC"} detail={ng ? (feesOpen.length ? `${money(feesOpen.reduce((s, r) => s + (+r.charges || 0), 0))} read off the advices, still to book` : "Read off the advices and booked as Bank Charges") : "Atyahara's fees stay on the FIRC"} onClick={() => {}} />
            <Todo label="BRCs cleared" count={0} okText={`${brcCleared.length} cleared`} detail={`${brcPending.length} realised, BRC still pending`} onClick={() => setView("export")} />
          </div>
          {ng ? (
            <Card><RemittanceRegister aiExtract={aiExtract} isUnclassified={isUnclassified}
              onChange={({ remits: r, invoices: i }) => setData(v => ({ ...v, ...(r.length || arr(v[NG_REMIT_KEY]).length === 0 ? { [NG_REMIT_KEY]: r } : {}), ...(i.length ? { "ng-invoices-v2": i } : {}) }))} /></Card>
          ) : (
            <Card title="FIRCs" sub="Atyahara's inward remittances, kept in Export Recon. Edit them there; the advance mark covers one that came before its shipment."
              right={<button className="bs" style={{ fontSize: 11.5, padding: "5px 11px" }} onClick={() => openRecon("fircs")}>Open FIRCs →</button>}>
              <div style={{ border: `1px solid ${C.border}`, borderRadius: 12, overflow: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 860 }}>
                  <thead><tr style={{ background: C.card }}>{["Date", "FIRC", "Buyer", "Foreign", "Rate", "INR", "Fees", "Shipping bills", ""].map(h => <th key={h} style={{ textAlign: "left", fontSize: 10, fontWeight: 800, color: C.inkFaint, textTransform: "uppercase", padding: "8px 10px" }}>{h}</th>)}</tr></thead>
                  <tbody>
                    {meta.fircs.slice().sort((a, b) => String(b.date || "").localeCompare(String(a.date || ""))).map(f => {
                      const st = atFircSettlement(f, meta.shippingBills), miss = atFircMissing(f);
                      const td = { padding: "8px 10px", fontSize: 12, borderTop: `1px solid ${C.border}`, verticalAlign: "top", color: C.ink };
                      return (
                        <tr key={f.id}>
                          <td style={{ ...td, whiteSpace: "nowrap" }}>{f.date ? fmtDate(f.date) : <span style={{ color: C.amber }}>no date</span>}</td>
                          <td style={{ ...td, fontWeight: 800 }}>{f.number || "—"}</td>
                          <td style={td}>{f.buyerName || f.remitterName || <span style={{ color: C.amber }}>—</span>}</td>
                          <td style={td}>{f.foreignAmount ? `${f.currency || ""} ${f.foreignAmount}` : <span style={{ color: C.amber }}>—</span>}</td>
                          <td style={td}>{f.exchangeRate || <span style={{ color: C.amber }}>—</span>}</td>
                          <td style={{ ...td, whiteSpace: "nowrap" }}>{money(f.amount)}</td>
                          <td style={td}>{f.charges === "" || f.charges == null ? <span style={{ color: C.amber }}>—</span> : money(f.charges)}</td>
                          <td style={td}>{st.linked.length ? st.linked.map(sb => <div key={sb.id} style={{ fontSize: 11, wordBreak: "break-all" }}>{sb.sbNumber}</div>) : <span style={{ color: f.advance ? C.blue : C.amber, fontWeight: 700 }}>{f.advance ? "Advance" : "None yet"}</span>}</td>
                          <td style={td}>{miss.length ? <Pill tone="amber" title={`Missing ${miss.join(", ")}`}>{miss.length} missing</Pill> : st.settled ? <Pill tone="green">✓</Pill> : <Pill tone="amber">{money(st.unallocated)} unused</Pill>}</td>
                        </tr>
                      );
                    })}
                    {meta.fircs.length === 0 && <tr><td colSpan={9} style={{ padding: 22, textAlign: "center", color: C.inkFaint, fontSize: 12.5 }}>No FIRCs yet.</td></tr>}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
