// Atyahara accounting stock screen + the orders-flow step that links a sale to a
// stock category (replaces "add to NG invoice" now that Atyahara buys in bulk).
import { useState, useEffect, useMemo } from "react";
import { loadK, loadKFresh, saveK, upsertVersionedItemK, uid, today, mob, inr, fmtDate } from "./utils.js";
import { C, FI } from "./ui.jsx";
import { AT_ACC_STOCK_KEY, DEFAULT_ATY_CATEGORIES, UNCATEGORISED, catId, normUnit, makeCategorizer } from "./atyStock.js";
import { rebuildAtyStockNow, requestAtyStockRebuild } from "./atyStockSync.js";

const AT_INVOICES_KEY = "at-invoices-v1";
const n = v => (+v || 0).toLocaleString("en-IN", { maximumFractionDigits: 3 });
const btn = (bg = C.ink, off = false) => ({ background: off ? C.border : bg, color: "#fff", border: "none", borderRadius: 8, padding: "8px 13px", fontSize: 12, fontWeight: 800, cursor: off ? "default" : "pointer" });
const ghost = { background: "transparent", color: C.inkMid, border: `1px solid ${C.border}`, borderRadius: 8, padding: "7px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer" };

function useCustoms() {
  const [rows, setRows] = useState(DEFAULT_ATY_CATEGORIES);
  useEffect(() => { loadK("ng-customs-descs-v1").then(r => Array.isArray(r) && r.length && setRows(r)).catch(() => {}); }, []);
  return rows;
}

// The invoice lines that belong to one order (Etsy lines carry the transaction id).
export function linesForOrder(inv, order) {
  const items = inv?.items || [];
  const keys = [order?.id, order?.etsy_transaction_id, order?.platform_order_id].filter(Boolean).map(String);
  const hit = items.filter(it => keys.some(k => String(it.id || "") === k || String(it.id || "").includes(k) || String(it._etsyTransactionId || "") === k));
  return hit.length ? hit : items.length === 1 ? items : [];
}

/* Point the order's invoice line(s) at a category, record it on the order, rebuild. */
export async function linkOrderToCategory({ order, invNo, desc, patchOrder }) {
  const list = (await loadKFresh(AT_INVOICES_KEY).catch(() => [])) || [];
  const inv = list.find(i => String(i.invNo || "") === String(invNo || ""));
  if (!inv) throw new Error(`Sales invoice ${invNo || ""} not found. Create it in step 3 first.`);
  const lines = linesForOrder(inv, order);
  if (!lines.length) throw new Error(`Couldn't find this order's line on ${inv.invNo}. Link it from the invoice instead.`);
  const ids = new Set(lines.map(l => l.id));
  const next = { ...inv, items: inv.items.map(it => ids.has(it.id) ? { ...it, acctStockId: catId(desc, normUnit(it.unit)), acctDesc: it.acctDesc || desc } : it), updatedAt: new Date().toISOString() };
  await upsertVersionedItemK(AT_INVOICES_KEY, next, { prepend: false, user: "Admin" });
  await patchOrder(order, { _atStockCatId: catId(desc, "pcs"), _atStockCat: desc, _atStockQty: lines.reduce((s, l) => s + (+(l.acctQty || l.qty) || 0), 0), _atStockLinkedAt: new Date().toISOString() });
  await rebuildAtyStockNow();
}

/* Step 4 in the orders flow. */
export function AtyStockStep({ order, invNo, invoice, patchOrder, showToast }) {
  const customs = useCustoms();
  const categorize = useMemo(() => makeCategorizer(customs), [customs]);
  const [book, setBook] = useState([]);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    const load = () => loadK(AT_ACC_STOCK_KEY).then(b => setBook(Array.isArray(b) ? b : [])).catch(() => {});
    load(); window.addEventListener("aty-stock-updated", load);
    return () => window.removeEventListener("aty-stock-updated", load);
  }, []);
  const lines = invoice ? linesForOrder(invoice, order) : [];
  const suggested = order._atStockCat || (lines[0] ? categorize(lines[0], { shape: order.listing_shape, title: order.listing_title }).desc : categorize({}, { shape: order.listing_shape, title: order.listing_title }).desc);
  const chosen = pick || suggested;
  const qty = lines.reduce((s, l) => s + (+(l.acctQty || l.qty) || 0), 0) || 1;
  const bal = book.find(e => e.id === catId(chosen, "pcs"));
  const done = !!order._atStockCatId;
  if (!invNo) return <div style={{ fontSize: 12, color: C.inkMid }}>Create the sales invoice in step 3 first. This step then takes the piece out of Atyahara's stock.</div>;
  const save = async () => {
    if (!chosen || chosen === UNCATEGORISED) { setErr("Choose a category."); return; }
    setBusy(true); setErr("");
    try { await linkOrderToCategory({ order, invNo, desc: chosen, patchOrder }); showToast?.(`−${qty} pcs from ${chosen}`); }
    catch (e) { setErr(e.message || String(e)); }
    setBusy(false);
  };
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px 14px" }}>
      <div style={{ fontSize: 13, fontWeight: 850, color: C.ink }}>Take it out of Atyahara's stock</div>
      <div style={{ fontSize: 11, color: C.inkMid, marginTop: 3, lineHeight: 1.45 }}>
        {done ? <>Linked to <b>{order._atStockCat}</b> · −{order._atStockQty || qty} pcs on {invNo}.</> : <>Atyahara buys from Nikhil Gems in bulk. Pick the stock category this sale comes out of; {invNo} is linked to it.</>}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 10 }}>
        <select value={chosen} onChange={e => setPick(e.target.value)} style={{ ...FI, flex: "1 1 260px", width: "auto" }}>
          {customs.map(r => <option key={r.desc} value={r.desc}>{r.desc}</option>)}
        </select>
        <span style={{ fontSize: 12, color: C.inkMid }}>−{qty} pcs</span>
        <button onClick={save} disabled={busy} style={btn(C.green, busy)}>{busy ? "Saving…" : done ? "Change" : "Link to stock"}</button>
      </div>
      <div style={{ fontSize: 11, marginTop: 7, color: bal && bal.qty < 0 ? C.red : C.inkFaint }}>
        {bal ? `In stock now: ${n(bal.qty)} pcs (bought ${n(bal.qtyIn)}, sold ${n(bal.qtyOut)})` : "No pieces of this category in stock yet."}
        {!done && !pick && lines[0] && " · suggested from the invoice description"}
      </div>
      {err && <div style={{ fontSize: 12, color: C.red, fontWeight: 700, marginTop: 6 }}>{err}</div>}
    </div>
  );
}

/* The stock book: one row per category and unit. */
export default function AtyStockView({ showToast, onOpenInvoice }) {
  const customs = useCustoms();
  const [book, setBook] = useState(null);
  const [unsorted, setUnsorted] = useState([]);
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);
  const [adj, setAdj] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const refresh = async () => {
    setBusy(true);
    try { const r = await rebuildAtyStockNow(); if (r) { setBook(r.entries); setUnsorted(r.unsorted); } }
    catch (e) { showToast?.("Couldn't rebuild stock: " + (e.message || e)); }
    setBusy(false);
  };
  useEffect(() => {
    loadK(AT_ACC_STOCK_KEY).then(b => setBook(Array.isArray(b) ? b : [])).catch(() => setBook([]));
    refresh();
    const on = e => { if (e.detail?.entries) { setBook(e.detail.entries); setUnsorted(e.detail.unsorted || []); } };
    window.addEventListener("aty-stock-updated", on);
    return () => window.removeEventListener("aty-stock-updated", on);
  }, []);
  const rows = (book || []).filter(e => showAll || e.unit === "pcs" || Math.abs(e.qty) > 0.0001);
  const pcs = (book || []).filter(e => e.unit === "pcs" && e.desc !== UNCATEGORISED);
  const tot = pcs.reduce((a, e) => ({ q: a.q + Math.max(0, e.qty), v: a.v + Math.max(0, e.qty) * (e.avgCost || 0) }), { q: 0, v: 0 });
  const negatives = pcs.filter(e => e.qty < 0);
  const otherUnits = (book || []).filter(e => e.unit !== "pcs" && Math.abs(e.qty) > 0.0001);
  const bigLines = (book || []).flatMap(e => e.outs.filter(o => o.qty >= 20 && e.unit === "pcs").map(o => ({ ...o, cat: e.desc })));

  const saveAdj = async () => {
    const q = +adj.qty;
    if (!adj.desc || !q) { showToast?.("Enter a category and a quantity"); return; }
    setBusy(true);
    try {
      const list = (await loadKFresh(AT_ACC_STOCK_KEY).catch(() => [])) || [];
      const id = catId(adj.desc, adj.unit);
      const a = { id: uid(), date: adj.date || today(), qty: q, note: adj.note || "", at: new Date().toISOString() };
      const ex = list.find(e => e.id === id);
      const next = ex ? list.map(e => e.id === id ? { ...e, adjustments: [...(e.adjustments || []), a] } : e)
        : [...list, { id, desc: adj.desc, unit: normUnit(adj.unit), auto: true, bills: [], outs: [], adjustments: [a], qty: 0 }];
      await saveK(AT_ACC_STOCK_KEY, next, { merge: false });
      setAdj(null); await refresh(); showToast?.("Adjustment saved");
    } catch (e) { showToast?.("Save failed: " + (e.message || e)); }
    setBusy(false);
  };
  const delAdj = async (entryId, adjId) => {
    if (!window.confirm("Remove this adjustment?")) return;
    const list = (await loadKFresh(AT_ACC_STOCK_KEY).catch(() => [])) || [];
    await saveK(AT_ACC_STOCK_KEY, list.map(e => e.id === entryId ? { ...e, adjustments: (e.adjustments || []).filter(a => a.id !== adjId) } : e), { merge: false });
    await refresh();
  };

  const th = { textAlign: "right", fontSize: 10, fontWeight: 800, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .5, padding: "8px 8px", borderBottom: `1px solid ${C.border}` };
  const td = { textAlign: "right", fontSize: 13, padding: "9px 8px", borderBottom: `1px solid ${C.border}` };
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "flex-start", marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: C.inkMid, maxWidth: 640, lineHeight: 1.5 }}>
          Atyahara's stock in pieces, by customs category, since 1 Apr 2026. <b>Bills from Nikhil Gems add</b>, <b>every Atyahara sales invoice takes away</b>, and adjustments correct a count. It rebuilds itself whenever an invoice changes. This is the ERP's own record, not for the CA.
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={ghost} onClick={() => setAdj({ desc: customs[0]?.desc || "", unit: "pcs", qty: "", note: "", date: today() })}>+ Adjustment</button>
          <button style={btn(C.ink, busy)} disabled={busy} onClick={refresh}>{busy ? "Rebuilding…" : "Rebuild"}</button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr 1fr" : "repeat(4, 1fr)", gap: 10, marginBottom: 14 }}>
        {[["Pieces in stock", n(tot.q)], ["Value at average cost", inr(tot.v)], ["Categories short", negatives.length], ["Lines not sorted", unsorted.length]].map(([k, v], i) => (
          <div key={k} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 9, padding: "11px 13px" }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .5 }}>{k}</div>
            <div style={{ fontSize: 19, fontWeight: 850, marginTop: 3, color: (i === 2 || i === 3) && +v > 0 ? C.red : C.ink }}>{v}</div>
          </div>
        ))}
      </div>

      {adj && (
        <div style={{ background: C.surface, border: `1.5px solid ${C.gold}`, borderRadius: 10, padding: 14, marginBottom: 14, display: "grid", gridTemplateColumns: mob ? "1fr" : "2fr 80px 100px 130px 2fr auto", gap: 8, alignItems: "end" }}>
          <label style={{ fontSize: 11, color: C.inkMid }}>Category<select value={adj.desc} onChange={e => setAdj({ ...adj, desc: e.target.value })} style={FI}>{[...customs.map(r => r.desc), UNCATEGORISED].map(d => <option key={d}>{d}</option>)}</select></label>
          <label style={{ fontSize: 11, color: C.inkMid }}>Unit<select value={adj.unit} onChange={e => setAdj({ ...adj, unit: e.target.value })} style={FI}>{["pcs", "kg", "gm", "ct"].map(u => <option key={u}>{u}</option>)}</select></label>
          <label style={{ fontSize: 11, color: C.inkMid }}>Qty (+ or −)<input value={adj.qty} onChange={e => setAdj({ ...adj, qty: e.target.value })} inputMode="decimal" style={FI} /></label>
          <label style={{ fontSize: 11, color: C.inkMid }}>Date<input type="date" value={adj.date} onChange={e => setAdj({ ...adj, date: e.target.value })} style={FI} /></label>
          <label style={{ fontSize: 11, color: C.inkMid }}>Why<input value={adj.note} onChange={e => setAdj({ ...adj, note: e.target.value })} placeholder="e.g. physical count, kg converted to pcs" style={FI} /></label>
          <div style={{ display: "flex", gap: 6 }}><button style={btn(C.green, busy)} disabled={busy} onClick={saveAdj}>Save</button><button style={ghost} onClick={() => setAdj(null)}>Cancel</button></div>
        </div>
      )}

      {(negatives.length > 0 || otherUnits.length > 0 || bigLines.length > 0) && (
        <div style={{ background: C.amberBg, border: `1px solid ${C.amber}`, borderRadius: 9, padding: "10px 13px", marginBottom: 14, fontSize: 12, color: C.ink, lineHeight: 1.55 }}>
          <b>To look at</b>
          {negatives.length > 0 && <div>· {negatives.length} categor{negatives.length === 1 ? "y has" : "ies have"} sold more pieces than were billed from Nikhil Gems since 1 Apr (stock held before April, or a sale in the wrong category). Add an opening adjustment or relink the sale.</div>}
          {otherUnits.length > 0 && <div>· {otherUnits.length} categor{otherUnits.length === 1 ? "y is" : "ies are"} in kg/gm from older NG bills. Convert them to pieces with two adjustments (− the kg, + the pieces).</div>}
          {bigLines.map(o => <div key={o.invId + o.lineId}>· {o.invNo} ({fmtDate(o.date)}) sells {n(o.qty)} pcs of “{o.item || o.cat}”. Probably a typo in the quantity.</div>)}
        </div>
      )}

      {book === null ? <div style={{ fontSize: 13, color: C.inkFaint, padding: 30, textAlign: "center" }}>Loading…</div> : (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 720 }}>
            <thead><tr>
              <th style={{ ...th, textAlign: "left" }}>Category</th><th style={th}>Unit</th><th style={th}>Bought</th><th style={th}>Sold</th><th style={th} title="Pieces a category sold beyond what it bought, taken from the mixed bulk lot (NG-62)">From bulk lot</th><th style={th}>Adj.</th><th style={th}>In stock</th><th style={th}>Avg cost</th><th style={th}>Value</th>
            </tr></thead>
            <tbody>
              {rows.map(e => {
                const isOpen = open === e.id;
                return [
                  <tr key={e.id} onClick={() => setOpen(isOpen ? null : e.id)} style={{ cursor: "pointer", background: isOpen ? C.card : "transparent" }}>
                    <td style={{ ...td, textAlign: "left", fontWeight: 700, color: e.desc === UNCATEGORISED ? C.amber : C.ink }}>{isOpen ? "▾" : "▸"} {e.desc}</td>
                    <td style={{ ...td, color: C.inkMid }}>{e.unit}</td>
                    <td style={td}>{n(e.qtyIn)}</td><td style={td}>{n(e.qtyOut)}</td><td style={{ ...td, color: C.inkMid }}>{e.fromLot ? "+" + n(e.fromLot) : e.qtyToCategories ? "−" + n(e.qtyToCategories) : "—"}</td><td style={{ ...td, color: C.inkMid }}>{e.qtyAdj ? n(e.qtyAdj) : "—"}</td>
                    <td style={{ ...td, fontWeight: 850, color: e.qty < 0 ? C.red : C.ink }}>{n(e.qty)}</td>
                    <td style={{ ...td, color: C.inkMid }}>{e.avgCost ? inr(e.avgCost) : "—"}</td>
                    <td style={td}>{e.qty > 0 && e.avgCost ? inr(e.qty * e.avgCost) : "—"}</td>
                  </tr>,
                  isOpen && <tr key={e.id + "-d"}><td colSpan={9} style={{ padding: "10px 12px", background: C.bg, borderBottom: `1px solid ${C.border}` }}>
                    <Moves e={e} onOpenInvoice={onOpenInvoice} onDelAdj={id => delAdj(e.id, id)} />
                  </td></tr>,
                ];
              })}
            </tbody>
          </table>
          <div style={{ padding: "8px 12px", fontSize: 11, color: C.inkFaint }}>
            <label style={{ cursor: "pointer" }}><input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} /> Show empty kg/gm rows</label>
          </div>
        </div>
      )}

      {unsorted.length > 0 && (
        <details style={{ marginTop: 14 }}>
          <summary style={{ fontSize: 12, fontWeight: 800, color: C.amber, cursor: "pointer" }}>{unsorted.length} invoice lines couldn't be sorted into a category (counted under Uncategorised)</summary>
          <div style={{ fontSize: 12, color: C.inkMid, marginTop: 8, lineHeight: 1.6 }}>
            {unsorted.map((u, i) => <div key={i}>{u.side === "in" ? "Bought" : "Sold"} · {u.doc} · {fmtDate(u.date)} · {n(u.qty)} × {u.item || "(no description)"}</div>)}
            <div style={{ marginTop: 6, color: C.inkFaint }}>Give the line a customs description on its invoice and it sorts itself on the next rebuild.</div>
          </div>
        </details>
      )}
    </div>
  );
}

function Moves({ e, onOpenInvoice, onDelAdj }) {
  const rows = [
    ...e.bills.map(b => ({ d: b.billDate, k: "in", doc: b.billNumber, who: b.supplier, item: b.item, q: b.qty, amt: b.amt })),
    ...e.outs.map(o => ({ d: o.date, k: "out", doc: o.invNo, who: o.buyer, item: o.item, q: -o.qty, how: o.how })),
    ...(e.adjustments || []).map(a => ({ d: a.date, k: "adj", doc: "Adjustment", who: a.note, q: +a.qty, adjId: a.id })),
  ].sort((a, b) => String(b.d || "").localeCompare(String(a.d || "")));
  return (
    <div style={{ maxHeight: 320, overflowY: "auto" }}>
      {rows.map((r, i) => (
        <div key={i} style={{ display: "grid", gridTemplateColumns: mob ? "70px 1fr 60px" : "80px 150px 1fr 70px 90px", gap: 8, fontSize: 12, padding: "4px 0", borderBottom: `1px dashed ${C.border}`, alignItems: "center" }}>
          <span style={{ color: C.inkFaint }}>{fmtDate(r.d)}</span>
          <span style={{ fontWeight: 700, color: r.k === "in" ? C.green : r.k === "out" ? C.red : C.blue, cursor: r.k !== "adj" && onOpenInvoice ? "pointer" : "default" }} onClick={() => r.k !== "adj" && onOpenInvoice?.(r.doc, r.k)}>{r.doc}</span>
          {!mob && <span style={{ color: C.inkMid, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{[r.who, r.item].filter(Boolean).join(" · ")}{r.how === "linked" ? " · linked" : ""}</span>}
          <span style={{ textAlign: "right", fontWeight: 800, color: r.q < 0 ? C.red : C.green }}>{r.q > 0 ? "+" : ""}{n(r.q)}</span>
          {!mob && <span style={{ textAlign: "right", color: C.inkFaint }}>{r.adjId ? <button onClick={() => onDelAdj(r.adjId)} style={{ ...ghost, padding: "2px 8px", fontSize: 11 }}>Remove</button> : r.amt ? inr(r.amt) : ""}</span>}
        </div>
      ))}
    </div>
  );
}
