import { useEffect, useMemo, useState } from "react";
import { C, FI } from "./ui.jsx";
import { mob, fmtDate, loadK, upsertItemK, onCacheRefresh } from "./utils.js";
import { monthLabel } from "./monthClose.js";
import { NG_REMIT_KEY } from "./remittances.js";
import { ngReconMonth, atReconMonth, RECON_CLOSE_KEY, NG_BANK_SB_KEY, reconCloseId } from "./reconMonth.js";

/* Export Recon for one company and one month: each shipping bill against its
   invoice and the remittance(s) that realised it, what needs fixing, what is
   still outstanding, and a sign-off once the month has been gone through. Used
   in Export Recon (Month view) and inside the Ledger's Month close. */

const fmt = (n, cur) => `${cur === "INR" || !cur ? "₹" : `${cur} `}${(+n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export function useLiveKey(key, fallback = []) {
  const [v, setV] = useState(fallback);
  useEffect(() => {
    setV(fallback);
    if (!key) return;
    let alive = true;
    const load = () => loadK(key).then(x => { if (alive) setV(x ?? fallback); }).catch(() => {});
    load();
    const off = onCacheRefresh(keys => { if (keys.includes(key)) load(); });
    return () => { alive = false; off?.(); };
  }, [key]);
  return [v, setV];
}

// Sign-off records for every company/month: { id: "<company>:<month>", company, month, reconciledAt, outstanding, fixCount }.
export function useReconCloses() {
  const [list, setList] = useLiveKey(RECON_CLOSE_KEY);
  const arr = Array.isArray(list) ? list : [];
  const save = async rec => {
    setList([rec, ...arr.filter(r => r.id !== rec.id)]);
    const saved = await upsertItemK(RECON_CLOSE_KEY, rec);
    if (Array.isArray(saved) && saved.length) setList(saved);
  };
  return [arr, save];
}

export function reconMonthFor(company, month, { invoices, remittances, bankSbs, atMeta }) {
  return company === "atyahara"
    ? atReconMonth({ month, meta: atMeta })
    : ngReconMonth({ month, invoices: Array.isArray(invoices) ? invoices : [], remittances: Array.isArray(remittances) ? remittances : [], bankSbs: bankSbs && !Array.isArray(bankSbs) ? bankSbs : null });
}

function StatusCell({ r }) {
  if (r.status === "realised") return <span style={{ color: C.green, fontWeight: 800 }}>✓ Realised</span>;
  const tone = r.overdue ? C.red : C.amber;
  return (
    <span style={{ color: tone, fontWeight: 800 }}>
      {r.status === "part" ? "Part realised" : "Unrealised"}
      {r.dueDate && <span style={{ display: "block", fontSize: 10.5, fontWeight: 700 }}>{r.overdue ? "past" : "due by"} {fmtDate(r.dueDate)}</span>}
    </span>
  );
}

export function ReconMonthView({ company, month, result, closeRec, onSignOff, onReopen, compact = false }) {
  const { rows, fix, outstanding, overdue, realisedCount } = result;
  const owed = {};
  outstanding.forEach(r => { const k = r.currency || "INR"; owed[k] = (owed[k] || 0) + Math.max(0, r.value - r.realised); });
  const owedText = Object.entries(owed).map(([cur, v]) => fmt(v, cur)).join(" + ") || "nothing";
  const th = { textAlign: "left", fontSize: 10, fontWeight: 800, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .4, padding: "8px 10px", whiteSpace: "nowrap" };
  const td = { padding: "8px 10px", fontSize: 12.5, color: C.ink, borderTop: `1px solid ${C.border}`, verticalAlign: "top" };
  const signedOff = !!closeRec?.reconciledAt;
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {[
          [`${rows.length} shipping bill${rows.length === 1 ? "" : "s"}`, C.ink],
          [`${realisedCount} realised`, C.green],
          [`${outstanding.length} outstanding · ${owedText}`, outstanding.length ? C.amber : C.green],
          ...(overdue.length ? [[`${overdue.length} past the realisation deadline`, C.red]] : []),
          [`${fix.length} to fix`, fix.length ? C.red : C.green],
        ].map(([t, c]) => <span key={t} style={{ fontSize: 11.5, fontWeight: 800, color: c, background: C.card, border: `1px solid ${C.border}`, borderRadius: 999, padding: "3px 10px" }}>{t}</span>)}
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", background: signedOff ? C.greenBg : C.card, border: `1px solid ${signedOff ? C.green : C.border}`, borderRadius: 9, padding: "9px 12px" }}>
        <div style={{ fontSize: 12.5, color: signedOff ? C.green : C.inkMid, fontWeight: 750 }}>
          {signedOff
            ? <>✓ {monthLabel(month)} reconciled on {fmtDate(closeRec.reconciledAt.slice(0, 10))}{closeRec.outstanding ? ` — ${closeRec.outstanding} outstanding at the time` : ""}{(fix.length > 0) && <b style={{ color: C.red }}> · {fix.length} new item{fix.length === 1 ? "" : "s"} to fix since</b>}</>
            : fix.length ? `Fix the ${fix.length} item${fix.length === 1 ? "" : "s"} below, then mark ${monthLabel(month)} reconciled.` : `Nothing to fix — mark ${monthLabel(month)} reconciled once you've gone through it.`}
        </div>
        {signedOff
          ? <button className="bs" style={{ fontSize: 11.5, padding: "5px 11px" }} onClick={onReopen}>Re-open</button>
          : <button className="bp" style={{ fontSize: 11.5, padding: "5px 11px" }} disabled={fix.length > 0} title={fix.length ? "Fix the open items first" : ""} onClick={onSignOff}>Mark reconciled</button>}
      </div>

      <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "auto", background: C.surface }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: compact ? 760 : 900 }}>
          <thead><tr style={{ background: C.card }}>
            {["SB date", "Shipping bill", "Invoice", "Buyer", "Value", "Realised", company === "atyahara" ? "FIRC" : "Remittance", "Status"].map(h => <th key={h} style={th}>{h}</th>)}
          </tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={8} style={{ ...td, textAlign: "center", color: C.inkFaint, padding: 22 }}>No shipping bills in {monthLabel(month)}.</td></tr>}
            {rows.map(r => (
              <tr key={r.key} style={{ background: r.problems.length ? C.redBg : "transparent" }}>
                <td style={{ ...td, whiteSpace: "nowrap" }}>{r.sbDate ? fmtDate(r.sbDate) : "—"}</td>
                <td style={{ ...td, fontWeight: 800, wordBreak: "break-all" }}>{r.sbNo || <span style={{ color: C.red }}>none</span>}
                  {r.bankOpen && r.status === "realised" && <div style={{ fontSize: 10.5, color: C.amber, fontWeight: 700 }}>still open at the bank</div>}
                </td>
                <td style={td}>{r.invNo || <span style={{ color: C.red }}>none</span>}</td>
                <td style={td}>{r.buyer || "—"}</td>
                <td style={{ ...td, whiteSpace: "nowrap" }}>{r.value ? fmt(r.value, r.currency) : "—"}</td>
                <td style={{ ...td, whiteSpace: "nowrap" }}>{r.realised ? fmt(r.realised, r.currency) : "—"}</td>
                <td style={td}>{r.remittances.length ? r.remittances.join(", ") : "—"}</td>
                <td style={td}><StatusCell r={r} />{r.problems.map(p => <div key={p} style={{ fontSize: 11, color: C.red, fontWeight: 700, marginTop: 2 }}>{p}</div>)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {company !== "atyahara" && result.bankImportedAt != null && (
        <div style={{ fontSize: 11, color: C.inkFaint }}>Bank SB Outstanding report imported {fmtDate(String(result.bankImportedAt).slice(0, 10))} — re-import it in Invoice Sets to refresh which SBs the bank still holds open.</div>
      )}
    </div>
  );
}

/* The Month view inside Export Recon. Atyahara's data comes from the module (it
   is already loaded there); Nikhil Gems' invoices and remittances are read here. */
export default function ReconMonth({ company, atMeta }) {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const ng = company !== "atyahara";
  const [invoices] = useLiveKey(ng ? "ng-invoices-v2" : null);
  const [remittances] = useLiveKey(ng ? NG_REMIT_KEY : null);
  const [bankSbs] = useLiveKey(ng ? NG_BANK_SB_KEY : null, null);
  const [closes, saveClose] = useReconCloses();
  const result = useMemo(() => reconMonthFor(company, month, { invoices, remittances, bankSbs, atMeta }), [company, month, invoices, remittances, bankSbs, atMeta]);
  const closeRec = closes.find(r => r.id === reconCloseId(company, month)) || null;
  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 19, fontWeight: 700, color: C.ink, letterSpacing: "-.01em" }}>Month</div>
          <div style={{ fontSize: 12, color: C.inkFaint, marginTop: 2, maxWidth: 640 }}>Every shipping bill of the month against its invoice and the {ng ? "remittance(s)" : "FIRC"} that realised it — what still needs fixing, and what is still to come in.</div>
        </div>
        <input type="month" value={month} onChange={e => setMonth(e.target.value || month)} style={{ ...FI, width: 170, fontSize: 12.5, padding: "7px 9px" }} />
      </div>
      <ReconMonthView company={company} month={month} result={result} closeRec={closeRec}
        onSignOff={() => saveClose({ id: reconCloseId(company, month), company, month, reconciledAt: new Date().toISOString(), outstanding: result.outstanding.length, fixCount: result.fix.length })}
        onReopen={() => saveClose({ ...closeRec, reconciledAt: null, reopenedAt: new Date().toISOString() })} />
    </div>
  );
}
