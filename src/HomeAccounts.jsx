import { useEffect, useMemo, useState } from "react";
import { C } from "./ui.jsx";
import { mob, fmtDate, loadK, onCacheRefresh } from "./utils.js";
import { loadLearnMemory } from "./classifyLearner.js";
import { paymentHead, balanceChecks, statementsKey, monthOf, shiftMonth, monthLabel } from "./monthClose.js";
import { remittanceChecks, NG_REMIT_KEY, AT_META_KEY } from "./remittances.js";
import PaymentQueue, { needsBill } from "./PaymentQueue.jsx";

/* Home → Accounts: the money side at a glance, for one company at a time.
   What was paid out this month, the payments still without a head (classified
   right here under an expense head in one tap, or opened in the Ledger when they
   need a bill or an account picked), last month's bank-vs-statement check and
   BOI credits nobody has entered. Every number links to where it is fixed. */

const CUR_SYM = { INR: "₹", USD: "$", EUR: "€", JPY: "¥", GBP: "£", AUD: "A$" };
const money = (n, cur = "INR") => `${CUR_SYM[cur] || `${cur} `}${(+n || 0).toLocaleString("en-IN", { maximumFractionDigits: cur === "INR" ? 0 : 2 })}`;
const sumByCur = list => {
  const m = {};
  list.forEach(t => { const c = t.currency || "INR"; m[c] = (m[c] || 0) + (+t.amount || 0); });
  return Object.entries(m).sort((a, b) => (a[0] === "INR" ? -1 : b[0] === "INR" ? 1 : b[1] - a[1])).map(([c, v]) => money(v, c)).join(" + ") || money(0);
};
const CUSTOM_CATS_KEY = "ng-accounting-ledger-custom-cats-v1";

// Several app_data keys at once, each reloaded when another screen or device changes it.
export function useKeys(keys) {
  const [vals, setVals] = useState({});
  const sig = keys.filter(Boolean).join("|");
  useEffect(() => {
    let alive = true;
    const list = keys.filter(Boolean);
    const load = which => Promise.all(which.map(k => loadK(k).catch(() => null))).then(vs => {
      if (alive) setVals(prev => ({ ...prev, ...Object.fromEntries(which.map((k, i) => [k, vs[i]])) }));
    });
    load(list);
    const off = onCacheRefresh(changed => { const hit = list.filter(k => changed.includes(k)); if (hit.length) load(hit); });
    return () => { alive = false; off?.(); };
  }, [sig]);
  return [vals, setVals];
}
const arr = v => (Array.isArray(v) ? v : []);

function Tile({ label, value, sub, tone = C.ink, onClick }) {
  return (
    <button onClick={onClick} style={{ textAlign: "left", background: C.card, border: "none", borderRadius: 12, padding: "11px 13px", cursor: onClick ? "pointer" : "default", fontFamily: "inherit", minWidth: 0 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .9 }}>{label}</div>
      <div style={{ fontSize: mob ? 17 : 19, fontWeight: 800, color: tone, marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: C.inkMid, marginTop: 2, lineHeight: 1.35 }}>{sub}</div>}
    </button>
  );
}

export default function HomeAccounts({ isUnclassified, onEnter }) {
  const [company, setCompany] = useState(() => { try { return localStorage.getItem("ng-home-accounts-company") || "ng"; } catch { return "ng"; } });
  const [tab, setTab] = useState("todo");
  const [memory, setMemory] = useState({});
  const month = new Date().toISOString().slice(0, 7);
  const lastMonth = shiftMonth(month, -1);

  const [data, setData] = useKeys(["ng-fin-accounts-v1", "ng-fin-txns-v1", "at-fin-accounts-v1", "at-fin-txns-v1",
    statementsKey(company), company === "ng" ? NG_REMIT_KEY : AT_META_KEY, CUSTOM_CATS_KEY]);
  useEffect(() => {
    let alive = true;
    ["ng", "at"].forEach(co => loadLearnMemory(co).then(m => { if (alive) setMemory(s => ({ ...s, [co]: m })); }).catch(() => {}));
    return () => { alive = false; };
  }, []);

  const pick = co => { setCompany(co); try { localStorage.setItem("ng-home-accounts-company", co); } catch {} };
  const accountsOf = co => arr(data[`${co}-fin-accounts-v1`]);
  const txnsOf = co => arr(data[`${co}-fin-txns-v1`]);
  const since = new Date(Date.now() - 92 * 86400000).toISOString().slice(0, 10);
  // No head yet, or paid to a vendor with no bill against it.
  const todoOf = co => txnsOf(co).filter(t => t.type === "debit" && (t.date || "") >= since && (isUnclassified(t) || needsBill(t, isUnclassified)))
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  const accounts = accountsOf(company), txns = txnsOf(company);
  const accName = id => accounts.find(a => a.id === id)?.name || "Account";
  const todo = todoOf(company);
  const paid = txns.filter(t => t.type === "debit" && monthOf(t.date) === month);
  const latest = txns.filter(t => t.type === "debit" || (t.type === "conversion")).filter(t => (t.date || "") <= new Date().toISOString().slice(0, 10))
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || "").localeCompare(a.createdAt || "")).slice(0, 8);

  const bank = useMemo(() => balanceChecks({ accounts, txns, statements: arr(data[statementsKey(company)]), month: lastMonth, history: 1 }), [accounts, txns, data, company, lastMonth]);
  const bankOff = bank.filter(b => b.statement && !b.ok), bankMissing = bank.filter(b => !b.statement);
  const remit = useMemo(() => {
    const meta = data[AT_META_KEY]; const m = meta?.meta || meta || {};
    const args = { company, accounts, txns, remittances: arr(data[NG_REMIT_KEY]), invoices: [], fircs: arr(m.fircs), sbs: arr(m.shippingBills) };
    const a = remittanceChecks({ ...args, month }), b = remittanceChecks({ ...args, month: lastMonth });
    return { unentered: [...b.unentered, ...a.unentered], incomplete: [...b.rows, ...a.rows].filter(r => r.missing.length) };
  }, [company, accounts, txns, data, month, lastMonth]);


  // Opens the Ledger on this company — on one entry, or on Month close.
  const openLedger = (hint = {}) => {
    try {
      localStorage.setItem("ng-accounting-ledger-company", company);
      sessionStorage.setItem("ledger-open", JSON.stringify({ company, ...hint }));
    } catch {}
    onEnter?.("ledger");
  };
  // Show a change at once, without waiting for the store to report it back.
  const putTxn = (co, txn) => setData(v => ({ ...v, [`${co}-fin-txns-v1`]: arr(v[`${co}-fin-txns-v1`]).map(t => (t.id === txn.id ? txn : t)) }));
  const coBtn = (co, label) => {
    const n = todoOf(co).length;
    return (
      <button key={co} onClick={() => pick(co)} style={{ border: "none", borderRadius: 7, padding: "5px 11px", cursor: "pointer", fontSize: 12, fontWeight: 700, fontFamily: "inherit", background: company === co ? (co === "at" ? C.purple : C.ink) : "transparent", color: company === co ? "#fff" : C.inkMid }}>
        {label}{n > 0 && <span style={{ marginLeft: 6, background: company === co ? "rgba(255,255,255,.22)" : C.amberBg, color: company === co ? "#fff" : C.amber, borderRadius: 999, padding: "0 6px", fontSize: 10.5 }}>{n}</span>}
      </button>
    );
  };

  return (
    <div style={{ background: C.surface, borderRadius: 16, padding: mob ? "14px" : "16px 18px", boxShadow: "var(--e-1)", marginBottom: 12, display: "grid", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: 1.1 }}>Accounts · {monthLabel(month)}</div>
          <div style={{ display: "flex", gap: 3, background: C.card, borderRadius: 9, padding: 3 }}>{coBtn("ng", "Nikhil Gems")}{coBtn("at", "Atyahara")}</div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button className="bs" style={{ fontSize: 11.5, padding: "5px 11px" }} onClick={() => openLedger({ close: true, month: lastMonth })}>✓ Close {monthLabel(lastMonth, { month: "long" })} →</button>
          <button className="bp" style={{ fontSize: 11.5, padding: "5px 11px" }} onClick={() => { try { localStorage.setItem("ng-accounting-company", company); } catch {} onEnter?.("group:accounting"); }}>Accounting →</button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr 1fr" : "repeat(4, minmax(0,1fr))", gap: 8 }}>
        <Tile label={`Paid out · ${monthLabel(month, { month: "short" })}`} value={sumByCur(paid)} sub={`${paid.length} payment${paid.length === 1 ? "" : "s"}`} onClick={() => setTab("latest")} />
        <Tile label="To classify" value={todo.length ? `${todo.length} payment${todo.length === 1 ? "" : "s"}` : "✓ None"} tone={todo.length ? C.amber : C.green}
          sub={todo.length ? sumByCur(todo) : "Every payment has a head"} onClick={() => setTab("todo")} />
        <Tile label={`Bank vs statement · ${monthLabel(lastMonth, { month: "short" })}`}
          value={bankOff.length ? `${bankOff.length} off` : bankMissing.length ? `${bankMissing.length} missing` : "✓ Agrees"}
          tone={bankOff.length ? C.red : bankMissing.length ? C.amber : C.green}
          sub={bankOff.length ? bankOff.map(b => `${b.acc.name} ${b.diff > 0 ? "+" : "−"}${money(Math.abs(b.diff), b.acc.currency)}`).join(" · ") : bankMissing.length ? `No statement for ${bankMissing.map(b => b.acc.name).join(", ")}` : `${bank.length} account${bank.length === 1 ? "" : "s"} tie out`}
          onClick={() => openLedger({ close: true, month: lastMonth, section: "balance" })} />
        <Tile label="BOI remittances" value={remit.unentered.length ? `${remit.unentered.length} not entered` : remit.incomplete.length ? `${remit.incomplete.length} incomplete` : "✓ Entered"}
          tone={remit.unentered.length ? C.red : remit.incomplete.length ? C.amber : C.green}
          sub={remit.unentered.length ? `${sumByCur(remit.unentered)} in the bank with no ${company === "at" ? "FIRC" : "entry"}` : remit.incomplete.length ? "Missing rate, charges or buyer" : "Last two months"}
          onClick={() => openLedger({ close: true, month: remit.unentered.some(t => monthOf(t.date) === lastMonth) ? lastMonth : month, section: "remit" })} />
      </div>

      <div style={{ display: "flex", gap: 14, borderBottom: `1px solid ${C.border}` }}>
        {[["todo", `Payments to classify${todo.length ? ` · ${todo.length}` : ""}`], ["latest", "Latest payments"]].map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} style={{ background: "none", border: "none", borderBottom: `2px solid ${tab === k ? C.ink : "transparent"}`, padding: "4px 0 7px", fontSize: 12.5, fontWeight: tab === k ? 800 : 600, color: tab === k ? C.ink : C.inkMid, cursor: "pointer", fontFamily: "inherit" }}>{l}</button>
        ))}
      </div>

      {tab === "todo" && (
        <PaymentQueue key={company} company={company} items={todo} accounts={accounts} isUnclassified={isUnclassified} memory={memory[company] || []}
          customHeads={arr(data[CUSTOM_CATS_KEY])} limit={6} onOpenLedger={openLedger} onSaved={t => putTxn(company, t)}
          emptyText="Every payment in the last three months has a head and its bill." />
      )}

      {tab === "latest" && (
        <div style={{ display: "grid" }}>
          {latest.length === 0 && <div style={{ fontSize: 12.5, color: C.inkFaint }}>No payments yet.</div>}
          {latest.map(t => {
            const un = isUnclassified(t);
            return (
              <button key={t.id} onClick={() => openLedger({ id: t.id, month: monthOf(t.date) })} style={{ display: "grid", gridTemplateColumns: mob ? "1fr auto" : "70px minmax(0,1fr) 170px 110px", gap: 10, alignItems: "center", padding: "8px 0", border: "none", borderTop: `1px solid ${C.border}`, background: "none", textAlign: "left", cursor: "pointer", fontFamily: "inherit" }}>
                {!mob && <div style={{ fontSize: 11.5, color: C.inkMid }}>{fmtDate(t.date)}</div>}
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 750, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.payee || "—"}</div>
                  <div style={{ fontSize: 11, color: C.inkFaint }}>{mob ? `${fmtDate(t.date)} · ` : ""}{accName(t.accountFrom)}</div>
                </div>
                {!mob && <div style={{ fontSize: 11.5, fontWeight: 700, color: un ? C.amber : C.inkMid, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{un ? "Not classified" : paymentHead(t)}</div>}
                <div style={{ fontSize: 13, fontWeight: 800, color: C.ink, textAlign: "right" }}>{money(t.amount, t.currency)}</div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
