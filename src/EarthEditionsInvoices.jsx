/* Earth Editions invoices: the third company in Invoicing, next to Nikhil Gems
   and Atyahara. Earth Editions is billed as its own US business, in dollars,
   so it keeps its own invoices (ee-invoices-v1), its own numbering
   (EE-1-2026-27, by Indian financial year like the others) and its own
   company details (ee-company-v1), which Sir fills in from the Company
   details button here: nothing about the US entity lives in the code.

   An invoice is made from an eartheditions.co order (Listing Manager →
   Orders → Create invoice), or by hand. Print / PDF opens it as a page the
   browser saves as a PDF. */
import { useState, useEffect, useMemo } from "react";
import { loadKFresh, saveK, uid } from "./utils.js";
import { supabase } from "./supabase.js";
import { C, mob, FI } from "./lmTheme.js";

export const EE_INVOICES_KEY = "ee-invoices-v1";
export const EE_COMPANY_KEY = "ee-company-v1";

export const EE_COMPANY_DEFAULT = {
  name: "Earth Editions", address: "", email: "team@eartheditions.co", phone: "+91 96192 48797", website: "eartheditions.co",
  taxLabel: "EIN", taxId: "", bank: "Chase", bankAddress: "", accountName: "", accountNo: "", routing: "", swift: "",
  footer: "Thank you for your order. Shipped DDP: duties and import taxes paid.",
};

const r2 = n => Math.round((+n || 0) * 100) / 100;
export const fiscalYear = d => { const t = new Date(d || Date.now()); const y = t.getMonth() >= 3 ? t.getFullYear() : t.getFullYear() - 1; return `${y}-${String(y + 1).slice(-2)}`; };
export function nextEeInvoiceNo(list, date) {
  const fy = fiscalYear(date);
  const max = (list || []).reduce((m, x) => { const g = String(x.invNo || "").match(/^EE-(\d+)-(\d{4}-\d{2})$/); return g && g[2] === fy ? Math.max(m, +g[1]) : m; }, 0);
  return `EE-${max + 1}-${fy}`;
}
export const eeTotals = inv => {
  const sub = r2((inv.items || []).reduce((s, i) => s + (+i.qty || 0) * (+i.rate || 0), 0));
  return { sub, total: r2(sub + (+inv.shipping || 0) - (+inv.discount || 0)) };
};
const money = (n, cur = "USD") => new Intl.NumberFormat(cur === "INR" ? "en-IN" : "en-US", { style: "currency", currency: cur }).format(+n || 0);

export async function loadEeCompany() {
  const v = await loadKFresh(EE_COMPANY_KEY).catch(() => null);
  return { ...EE_COMPANY_DEFAULT, ...(v && !Array.isArray(v) && typeof v === "object" ? v : {}) };
}

/* An invoice for an eartheditions.co order, made once: a second click finds the first. */
export async function createEeInvoiceFromOrder(number) {
  const list = (await loadKFresh(EE_INVOICES_KEY).catch(() => [])) || [];
  const have = list.find(x => x.orderNo === number);
  if (have) return { invoice: have, existed: true };
  const { data: o, error } = await supabase.from("store_orders").select("*").eq("number", number).maybeSingle();
  if (error) throw new Error(error.message);
  if (!o) throw new Error(`${number} isn't in the store's orders`);
  const a = o.shipping || {};
  const date = String(o.created_at || new Date().toISOString()).slice(0, 10);
  const inv = {
    id: `ee-${number}`, invNo: nextEeInvoiceNo(list, date), date, orderNo: number,
    buyerName: o.name || "", buyerEmail: o.email || "", buyerPhone: o.phone || "",
    address: [[a.line1, a.line2].filter(Boolean).join(", "), [a.city, a.state, a.postal_code].filter(Boolean).join(" "), a.country].filter(Boolean).join("\n"),
    currency: String(o.currency || "usd").toUpperCase(),
    items: (o.lines || []).map(l => ({ id: uid(), desc: l.title, sku: l.sku || "", qty: +l.qty || 1, rate: +l.price || 0 })),
    shipping: +o.shipping_cost || 0, discount: +o.discount || 0, discountCode: o.discount_code || "",
    status: ["paid", "packed", "shipped", "delivered"].includes(o.status) ? "paid" : o.status,
    paidVia: o.gateway === "razorpay" ? "Razorpay" : "Stripe", paymentRef: o.stripe_payment || "",
    createdAt: new Date().toISOString(),
  };
  await saveK(EE_INVOICES_KEY, [inv, ...list]);
  return { invoice: inv, existed: false };
}

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const br = s => esc(s).replace(/\n/g, "<br>");
export function eeInvoiceHtml(inv, co) {
  const { sub, total } = eeTotals(inv);
  const m = n => money(n, inv.currency);
  const bank = [co.bank && `Bank: ${co.bank}`, co.bankAddress, co.accountName && `Account name: ${co.accountName}`, co.accountNo && `Account no.: ${co.accountNo}`, co.routing && `Routing (ACH): ${co.routing}`, co.swift && `SWIFT: ${co.swift}`].filter(Boolean);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(inv.invNo)} · ${esc(co.name)}</title>
<style>body{font-family:Helvetica,Arial,sans-serif;color:#141210;margin:0;padding:40px;font-size:13px}.top{display:flex;justify-content:space-between;gap:24px}
h1{font-family:Georgia,serif;font-weight:normal;font-size:30px;margin:0 0 6px}.brand{font-weight:700;letter-spacing:4px;font-size:22px}.sub{letter-spacing:6px;font-size:10px;color:#5d5850}
.muted{color:#5d5850;line-height:1.5}table{width:100%;border-collapse:collapse;margin-top:28px}th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#5d5850;border-bottom:1.5px solid #141210;padding:8px 6px}
td{padding:10px 6px;border-bottom:1px solid #ebe7e0;vertical-align:top}.r{text-align:right}.tot td{border:none;padding:5px 6px}.grand td{font-weight:700;font-size:15px;border-top:1.5px solid #141210;padding-top:10px}
.paid{display:inline-block;border:2px solid #2e7d4f;color:#2e7d4f;font-weight:700;letter-spacing:2px;padding:4px 12px;border-radius:4px;margin-top:10px}.box{margin-top:30px;display:flex;gap:40px;flex-wrap:wrap}
@media print{body{padding:24px}.noprint{display:none}}</style></head><body>
<div class="noprint" style="margin-bottom:20px"><button onclick="print()" style="padding:9px 16px;font-size:13px;cursor:pointer">Print / Save as PDF</button></div>
<div class="top"><div><div class="brand">EARTH</div><div class="sub">EDITIONS</div><div class="muted" style="margin-top:12px">${esc(co.name)}<br>${br(co.address)}${co.address ? "<br>" : ""}${esc(co.email)}${co.website ? ` · ${esc(co.website)}` : ""}${co.taxId ? `<br>${esc(co.taxLabel || "Tax ID")}: ${esc(co.taxId)}` : ""}</div></div>
<div class="r"><h1>Invoice</h1><div class="muted">No. <b style="color:#141210">${esc(inv.invNo)}</b><br>Date ${esc(new Date(inv.date + "T12:00:00").toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" }))}${inv.orderNo ? `<br>Order ${esc(inv.orderNo)}` : ""}</div>${inv.status === "paid" ? `<div class="paid">PAID</div>` : ""}</div></div>
<div class="box"><div><div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#5d5850;margin-bottom:6px">Bill &amp; ship to</div><b>${esc(inv.buyerName)}</b><br><span class="muted">${br(inv.address)}${inv.buyerEmail ? `<br>${esc(inv.buyerEmail)}` : ""}</span></div></div>
<table><thead><tr><th>Description</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Amount</th></tr></thead><tbody>
${(inv.items || []).map(i => `<tr><td>${esc(i.desc)}${i.sku ? `<div class="muted" style="font-size:11px">${esc(i.sku)}</div>` : ""}</td><td class="r">${+i.qty || 0}</td><td class="r">${m(i.rate)}</td><td class="r">${m((+i.qty || 0) * (+i.rate || 0))}</td></tr>`).join("")}
</tbody></table>
<table style="width:300px;margin-left:auto;margin-top:10px"><tbody class="tot">
<tr><td>Subtotal</td><td class="r">${m(sub)}</td></tr><tr><td>Shipping</td><td class="r">${+inv.shipping ? m(inv.shipping) : "Free"}</td></tr>
${+inv.discount ? `<tr><td>Discount${inv.discountCode ? ` (${esc(inv.discountCode)})` : ""}</td><td class="r">−${m(inv.discount)}</td></tr>` : ""}
<tr class="grand"><td>Total ${esc(inv.currency)}</td><td class="r">${m(total)}</td></tr></tbody></table>
${inv.status === "paid" ? `<p class="muted" style="margin-top:18px">Paid in full${inv.paidVia ? ` via ${esc(inv.paidVia)}` : ""}${inv.paymentRef ? ` (${esc(inv.paymentRef)})` : ""}.</p>` : bank.length ? `<div class="muted" style="margin-top:22px"><b style="color:#141210">Payment details</b><br>${bank.map(esc).join("<br>")}</div>` : ""}
${co.footer ? `<p class="muted" style="margin-top:30px;border-top:1px solid #ebe7e0;padding-top:14px">${esc(co.footer)}${co.phone ? ` · WhatsApp ${esc(co.phone)}` : ""}</p>` : ""}
</body></html>`;
}
export function openEeInvoice(inv, co) {
  const url = URL.createObjectURL(new Blob([eeInvoiceHtml(inv, co)], { type: "text/html" }));
  window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

const btn = (bg = C.surface, fg = C.ink) => ({ background: bg, color: fg, border: bg === C.surface ? `1px solid ${C.border}` : "none", borderRadius: 7, padding: "7px 13px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" });
const card = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12 };
const lab = { fontSize: 11, fontWeight: 700, color: C.inkMid, display: "block", marginBottom: 4 };

export default function EarthEditionsInvoices({ openId, onOpened }) {
  const [list, setList] = useState(null);
  const [co, setCo] = useState(EE_COMPANY_DEFAULT);
  const [edit, setEdit] = useState(null);        // an invoice being edited
  const [coEdit, setCoEdit] = useState(null);    // the company details form
  const [msg, setMsg] = useState("");
  const load = () => Promise.all([loadKFresh(EE_INVOICES_KEY).catch(() => []), loadEeCompany()]).then(([l, c]) => { setList(Array.isArray(l) ? l : []); setCo(c); return Array.isArray(l) ? l : []; });
  useEffect(() => { load().then(l => { if (openId) { const x = l.find(i => i.id === openId || i.invNo === openId); if (x) setEdit({ ...x }); onOpened?.(); } }); }, [openId]);
  const flash = t => { setMsg(t); setTimeout(() => setMsg(""), 3500); };
  const saveInv = async inv => {
    const next = list.some(x => x.id === inv.id) ? list.map(x => x.id === inv.id ? inv : x) : [inv, ...list];
    if (next.some(x => x.id !== inv.id && x.invNo === inv.invNo)) return flash(`⚠ ${inv.invNo} is already used`);
    await saveK(EE_INVOICES_KEY, next); setList(next); setEdit(null); flash(`Saved ${inv.invNo}`);
  };
  const del = async inv => {
    if (!window.confirm(`Delete invoice ${inv.invNo}?`)) return;
    const next = list.filter(x => x.id !== inv.id); await saveK(EE_INVOICES_KEY, next); setList(next); setEdit(null); flash(`Deleted ${inv.invNo}`);
  };
  const saveCo = async () => { await saveK(EE_COMPANY_KEY, coEdit, { merge: false }); setCo(coEdit); setCoEdit(null); flash("Company details saved"); };
  const blank = () => ({ id: uid(), invNo: nextEeInvoiceNo(list, new Date()), date: new Date().toISOString().slice(0, 10), orderNo: "", buyerName: "", buyerEmail: "", address: "", currency: "USD", items: [{ id: uid(), desc: "", qty: 1, rate: 0 }], shipping: 0, discount: 0, status: "unpaid", createdAt: new Date().toISOString() });
  const missing = !co.address || !co.taxId;
  const sorted = useMemo(() => [...(list || [])].sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.invNo).localeCompare(String(a.invNo))), [list]);

  if (coEdit) return (
    <div style={{ ...card, padding: 18, display: "grid", gap: 12, maxWidth: 720 }}>
      <div style={{ fontWeight: 800, fontSize: 16 }}>Earth Editions company details</div>
      <div style={{ fontSize: 12, color: C.inkFaint }}>Printed on every Earth Editions invoice. The bank block only shows on unpaid invoices.</div>
      <div style={{ display: "grid", gridTemplateColumns: mob() ? "1fr" : "1fr 1fr", gap: 10 }}>
        {[["name", "Legal name"], ["email", "Email"], ["website", "Website"], ["phone", "Phone / WhatsApp"], ["taxLabel", "Tax ID label (EIN)"], ["taxId", "Tax ID"], ["bank", "Bank"], ["accountName", "Account name"], ["accountNo", "Account number"], ["routing", "Routing (ACH)"], ["swift", "SWIFT"], ["bankAddress", "Bank address"]].map(([k, l]) => (
          <div key={k}><span style={lab}>{l}</span><input value={coEdit[k] || ""} onChange={e => setCoEdit(c => ({ ...c, [k]: e.target.value }))} style={FI()} /></div>
        ))}
      </div>
      <div><span style={lab}>Business address</span><textarea rows={3} value={coEdit.address} onChange={e => setCoEdit(c => ({ ...c, address: e.target.value }))} style={FI({ resize: "vertical" })} /></div>
      <div><span style={lab}>Footer line</span><input value={coEdit.footer} onChange={e => setCoEdit(c => ({ ...c, footer: e.target.value }))} style={FI()} /></div>
      <div style={{ display: "flex", gap: 8 }}><button onClick={saveCo} style={btn(C.ink, "#FAF0DC")}>Save details</button><button onClick={() => setCoEdit(null)} style={btn()}>Cancel</button></div>
    </div>
  );

  if (edit) {
    const t = eeTotals(edit);
    const setI = (i, p) => setEdit(e => ({ ...e, items: e.items.map((x, j) => j === i ? { ...x, ...p } : x) }));
    return (
      <div style={{ ...card, padding: 18, display: "grid", gap: 12, maxWidth: 860 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div style={{ fontWeight: 800, fontSize: 16, flex: 1 }}>Earth Editions invoice {edit.invNo}</div>
          <button onClick={() => openEeInvoice(edit, co)} style={btn()}>🖨 Print / PDF</button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: mob() ? "1fr 1fr" : "1fr 1fr 1fr 1fr", gap: 10 }}>
          <div><span style={lab}>Invoice no.</span><input value={edit.invNo} onChange={e => setEdit(x => ({ ...x, invNo: e.target.value }))} style={FI()} /></div>
          <div><span style={lab}>Date</span><input type="date" value={edit.date} onChange={e => setEdit(x => ({ ...x, date: e.target.value }))} style={FI()} /></div>
          <div><span style={lab}>Currency</span><select value={edit.currency} onChange={e => setEdit(x => ({ ...x, currency: e.target.value }))} style={FI()}>{["USD", "EUR", "GBP", "INR"].map(c => <option key={c}>{c}</option>)}</select></div>
          <div><span style={lab}>Status</span><select value={edit.status} onChange={e => setEdit(x => ({ ...x, status: e.target.value }))} style={FI()}><option value="paid">Paid</option><option value="unpaid">Unpaid</option></select></div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: mob() ? "1fr" : "1fr 1fr", gap: 10 }}>
          <div><span style={lab}>Buyer</span><input value={edit.buyerName} onChange={e => setEdit(x => ({ ...x, buyerName: e.target.value }))} style={FI()} /><span style={{ ...lab, marginTop: 8 }}>Email</span><input value={edit.buyerEmail} onChange={e => setEdit(x => ({ ...x, buyerEmail: e.target.value }))} style={FI()} /></div>
          <div><span style={lab}>Address</span><textarea rows={4} value={edit.address} onChange={e => setEdit(x => ({ ...x, address: e.target.value }))} style={FI({ resize: "vertical" })} /></div>
        </div>
        <div style={{ display: "grid", gap: 6 }}>
          <span style={lab}>Items</span>
          {edit.items.map((it, i) => (
            <div key={it.id || i} style={{ display: "grid", gridTemplateColumns: "1fr 70px 100px 100px auto", gap: 6, alignItems: "center" }}>
              <input value={it.desc} onChange={e => setI(i, { desc: e.target.value })} placeholder="Description" style={FI()} />
              <input value={it.qty} onChange={e => setI(i, { qty: e.target.value.replace(/[^\d.]/g, "") })} style={FI()} />
              <input value={it.rate} onChange={e => setI(i, { rate: e.target.value.replace(/[^\d.]/g, "") })} style={FI()} />
              <div style={{ fontSize: 13, fontWeight: 700, textAlign: "right" }}>{money((+it.qty || 0) * (+it.rate || 0), edit.currency)}</div>
              <button onClick={() => setEdit(x => ({ ...x, items: x.items.filter((_, j) => j !== i) }))} style={{ ...btn(), color: C.red }}>✕</button>
            </div>
          ))}
          <div><button onClick={() => setEdit(x => ({ ...x, items: [...x.items, { id: uid(), desc: "", qty: 1, rate: 0 }] }))} style={btn()}>＋ Line</button></div>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "end" }}>
          <div><span style={lab}>Shipping</span><input value={edit.shipping} onChange={e => setEdit(x => ({ ...x, shipping: e.target.value.replace(/[^\d.]/g, "") }))} style={FI({ width: 110 })} /></div>
          <div><span style={lab}>Discount</span><input value={edit.discount} onChange={e => setEdit(x => ({ ...x, discount: e.target.value.replace(/[^\d.]/g, "") }))} style={FI({ width: 110 })} /></div>
          <div style={{ flex: 1, textAlign: "right", fontSize: 15 }}>Subtotal {money(t.sub, edit.currency)} · <b>Total {money(t.total, edit.currency)}</b></div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => saveInv({ ...edit, items: edit.items.map(i => ({ ...i, qty: +i.qty || 0, rate: +i.rate || 0 })), shipping: +edit.shipping || 0, discount: +edit.discount || 0, updatedAt: new Date().toISOString() })} style={btn(C.ink, "#FAF0DC")}>Save</button>
          <button onClick={() => setEdit(null)} style={btn()}>Back</button>
          <div style={{ flex: 1 }} />
          {list.some(x => x.id === edit.id) && <button onClick={() => del(edit)} style={{ ...btn(), color: C.red }}>Delete</button>}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 12, maxWidth: 980 }}>
      {msg && <div style={{ fontSize: 12.5, color: msg.startsWith("⚠") ? C.red : C.green }}>{msg}</div>}
      {missing && <div style={{ ...card, padding: 12, fontSize: 12.5, color: C.amber, borderColor: C.amber }}>Earth Editions' address and EIN aren't filled in yet, so invoices print without them. Add them under <b>Company details</b>.</div>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button onClick={() => setEdit(blank())} style={btn(C.ink, "#FAF0DC")}>＋ Invoice</button>
        <button onClick={() => setCoEdit({ ...co })} style={btn()}>Company details</button>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: C.inkFaint, alignSelf: "center" }}>From an order: Listing Manager → Orders → 📄 Create invoice</span>
      </div>
      {!list && <div style={{ color: C.inkFaint, fontSize: 13 }}>Loading…</div>}
      {list && !list.length && <div style={{ ...card, padding: 24, textAlign: "center", color: C.inkFaint, fontSize: 13 }}>No Earth Editions invoices yet.</div>}
      {sorted.map(inv => { const { total } = eeTotals(inv); return (
        <div key={inv.id} style={{ ...card, padding: "12px 16px", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <b style={{ fontFamily: "ui-monospace,monospace", fontSize: 13, minWidth: 130 }}>{inv.invNo}</b>
          <div style={{ flex: 1, minWidth: 160 }}><div style={{ fontWeight: 600, fontSize: 14 }}>{inv.buyerName || "—"}</div><div style={{ fontSize: 11.5, color: C.inkFaint }}>{inv.date}{inv.orderNo ? ` · ${inv.orderNo}` : ""} · {inv.status === "paid" ? "Paid" : "Unpaid"}</div></div>
          <div style={{ fontWeight: 800, fontSize: 15 }}>{money(total, inv.currency)}</div>
          <button onClick={() => openEeInvoice(inv, co)} style={btn()}>🖨 PDF</button>
          <button onClick={() => setEdit({ ...inv })} style={btn()}>Edit</button>
        </div>
      ); })}
    </div>
  );
}
