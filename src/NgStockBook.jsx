// Nikhil Gems accounting stock book (from 1 Apr 2026), worked out from the bills and
// invoices every time it is shown. See ngStock.js for the rules.
import { useMemo, useState } from "react";
import { mob, inr, fmtDate, today } from "./utils.js";
import { C } from "./ui.jsx";
import { buildNgStock, NG_STOCK_FROM } from "./ngStock.js";

const q = v => (+v || 0).toLocaleString("en-IN", { maximumFractionDigits: 3 });
const rs = v => "₹" + Math.round(+v || 0).toLocaleString("en-IN");
const UNIT = { kg: "kg (incl. grams)", pcs: "pieces", ct: "carats" };
const cell = { padding: "9px 10px", fontSize: 12, borderBottom: `1px solid ${C.border}`, textAlign: "right", whiteSpace: "nowrap" };
const head = { ...cell, fontSize: 10, fontWeight: 800, color: C.inkFaint, textTransform: "uppercase", letterSpacing: ".04em", background: C.card };

export default function NgStockBook({ purchases = [], invoices = [], onViewBill }) {
  const [asAt, setAsAt] = useState(today());
  const [open, setOpen] = useState("");
  const book = useMemo(() => buildNgStock({ purchases, invoices, to: asAt || "9999-12-31" }), [purchases, invoices, asAt]);
  const dupExtra = book.checks.filter(c => c.kind === "duplicate-bill").reduce((s, c) => s + c.amount * c.extra.length, 0);
  return (
    <div style={{ marginBottom: 26 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
        <div>
          <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 20, fontWeight: 600 }}>Stock book from {fmtDate(NG_STOCK_FROM)}</div>
          <div style={{ fontSize: 12, color: C.inkMid, marginTop: 2, maxWidth: 720 }}>
            Opening is NG's Tally closing at 31 Mar 2026. Every purchase bill adds and every sales invoice takes away, by unit, as the CA keeps it.
            Value at average cost. Worked out from the documents each time, so fixing a bill or invoice fixes the book.
          </div>
        </div>
        <label style={{ fontSize: 12, color: C.inkMid }}>As at <input type="date" value={asAt} min={NG_STOCK_FROM} onChange={e => setAsAt(e.target.value)} style={{ marginLeft: 6, padding: "5px 8px", border: `1px solid ${C.border}`, borderRadius: 7, fontSize: 12 }} /></label>
      </div>
      <div style={{ overflowX: "auto", background: C.surface, border: `1.5px solid ${C.border}`, borderRadius: 9 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: mob ? 720 : 0 }}>
          <thead><tr>
            <th style={{ ...head, textAlign: "left" }}>Unit</th><th style={head}>Opening 1 Apr</th><th style={head}>Bought</th><th style={head}>Bought ₹</th>
            <th style={head}>Sold</th><th style={head}>Closing</th><th style={head}>Avg cost</th><th style={head}>Closing ₹</th>
          </tr></thead>
          <tbody>
            {book.rows.map(r => (
              <tr key={r.unit} onClick={() => setOpen(open === r.unit ? "" : r.unit)} style={{ cursor: "pointer", background: open === r.unit ? C.card : undefined }}>
                <td style={{ ...cell, textAlign: "left", fontWeight: 800 }}>{open === r.unit ? "▾" : "▸"} {UNIT[r.unit] || r.unit}</td>
                <td style={cell}>{q(r.openQty)}</td><td style={cell}>{q(r.inQty)}</td><td style={cell}>{rs(r.inValue)}</td>
                <td style={cell}>{q(r.outQty)}</td>
                <td style={{ ...cell, fontWeight: 800, color: r.negative ? C.red : C.ink }}>{q(r.closeQty)}</td>
                <td style={cell}>{r.avgCost ? rs(r.avgCost) : "—"}</td><td style={{ ...cell, fontWeight: 800 }}>{rs(r.closeValue)}</td>
              </tr>
            ))}
            <tr>
              <td style={{ ...cell, textAlign: "left", fontWeight: 800 }}>Total value</td><td style={cell}>{rs(book.total.openValue)}</td><td style={cell} /><td style={cell}>{rs(book.total.inValue)}</td>
              <td style={cell}>{rs(book.total.outValue)} at cost</td><td style={cell} /><td style={cell} /><td style={{ ...cell, fontWeight: 900 }}>{rs(book.total.closeValue)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      {open && (() => {
        const r = book.rows.find(x => x.unit === open); if (!r) return null;
        const moves = [...r.ins.map(m => ({ ...m, kind: "in" })), ...r.outs.map(m => ({ ...m, kind: "out" }))].sort((a, b) => a.date.localeCompare(b.date));
        return (
          <div style={{ marginTop: 8, background: C.surface, border: `1.5px solid ${C.border}`, borderRadius: 9, maxHeight: 420, overflowY: "auto" }}>
            {moves.map((m, i) => {
              const click = m.kind === "in" && m.billId && onViewBill;
              return (
                <div key={i} onClick={click ? () => onViewBill(m.billId) : undefined} style={{ display: "grid", gridTemplateColumns: mob ? "74px 1fr 80px" : "90px 120px 1fr 100px 110px", gap: 8, padding: "7px 12px", borderBottom: `1px solid ${C.border}`, fontSize: 12, cursor: click ? "pointer" : "default" }}>
                  <span style={{ color: C.inkFaint }}>{fmtDate(m.date)}</span>
                  {!mob && <span style={{ fontWeight: 700 }}>{m.kind === "in" ? "Bill " : ""}{m.doc}</span>}
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{mob ? `${m.doc} · ` : ""}{m.party ? `${m.party} · ` : ""}{m.desc}</span>
                  <span style={{ textAlign: "right", fontWeight: 800, color: m.kind === "in" ? C.green : C.red }}>{m.kind === "in" ? "+" : "−"}{q(m.asGm != null ? m.asGm : m.qty)}{m.asGm != null ? " g" : ""}</span>
                  {!mob && <span style={{ textAlign: "right", color: C.inkMid }}>{m.kind === "in" ? rs(m.value) : `${m.currency} ${q(m.sale)}`}</span>}
                </div>
              );
            })}
          </div>
        );
      })()}
      {book.checks.length > 0 && (
        <div style={{ marginTop: 12, background: "#fff8ec", border: `1.5px solid ${C.amber}`, borderRadius: 9, padding: "12px 14px" }}>
          <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 4 }}>Bills to check ({book.checks.length})</div>
          <div style={{ fontSize: 12, color: C.inkMid, marginBottom: 8 }}>
            Exact copies of a bill are counted once here{dupExtra ? `; the extra copies add ${rs(dupExtra)} to purchases elsewhere in the ERP until they are deleted` : ""}. Near copies and odd rates are counted as they are; open the bill to fix it.
          </div>
          {book.checks.map((c, i) => {
            const id = c.keep || c.billId || c.ids?.[1];
            return (
              <div key={i} onClick={onViewBill && id ? () => onViewBill(id) : undefined} style={{ fontSize: 12, padding: "5px 0", borderTop: i ? `1px solid ${C.border}` : "none", cursor: onViewBill && id ? "pointer" : "default" }}>
                <b>{c.party}</b> · {c.doc}{c.date ? ` · ${fmtDate(c.date)}` : ""} · {
                  c.kind === "duplicate-bill" ? `${rs(c.amount)} saved ${c.extra.length + 1} times` :
                  c.kind === "possible-duplicate" ? `two bills, ${c.amounts.map(rs).join(" and ")}: probably the same bill entered twice` :
                  `rate ${rs(c.rate)} per ${c.unit} against a usual ${rs(c.usual)} (${rs(c.value)})`}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
