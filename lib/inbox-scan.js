/* The morning inbox scan (07:00 IST, pg_cron → /api/mail gmail_scan).

   Reads Sir's Gmail through the Apps Script bridge (scripts/gmail-bridge.gs) and
   picks out the papers the books need:
     • purchase bills and tax invoices that carry one of our GSTINs (NG or Atyahara),
       to be matched to a ledger payment or a purchase bill;
     • inward remittance advices, FIRCs and bank credit advices, matched to a
       ledger credit and the Remittance Register;
     • shipping and customs papers (AWB / HAWB, shipping bill, packing list), for
       the sales invoice they belong to.
   Each one is saved to storage (ng-media/inbox/…), its fields are read (a BOI
   advice off its text layer, anything else by one small model call through
   aiFetch), and up to three matches are suggested. Nothing is booked or attached
   here: every document lands in app_rows "ng-inbox-docs-v1" as `pending`, and
   Sir approves or dismisses it on Home ("This morning", src/InboxCard.jsx).

   The same rows also list remittances that still have no paperwork (kind
   "missing"), and pending ones that got their paper elsewhere are marked
   resolved. Reads of the ledger are read-only; the only writes are the inbox
   rows (one app_rows_apply call) and the scan status row. */
import { adminClient } from "./auth.js";
import { aiFetch } from "./ai-meter.js";
import { readRows } from "./app-rows.js";
import { parseRemittanceAdvice } from "../src/remittanceAdvice.js";

export const INBOX_KEY = "ng-inbox-docs-v1";
export const SCAN_KEY = "ng-inbox-scan-v1";
export const OUR_GSTIN = { ng: "27AKFPJ0990D1ZB", at: "27BCVPJ2000F1ZU" };

const MODEL = "gpt-4.1-mini";
const BUCKET = "ng-media";
const TIME_BUDGET_MS = 230_000;   // the function has 300 s; leave room for the final write
const MAX_DOCS = 14;              // new documents read per run; the rest wait for tomorrow
const MAX_AI = 14;                // model calls per run (Girton watches the cost)

const QUERIES = [
  { hint: "bill", q: `has:attachment -in:sent -in:chats (${OUR_GSTIN.ng} OR ${OUR_GSTIN.at} OR "tax invoice" OR "GST invoice" OR "e-invoice" OR "purchase invoice" OR bill OR invoice)` },
  { hint: "remittance", q: `has:attachment -in:chats (FIRC OR "inward remittance" OR "remittance advice" OR "credit advice" OR "foreign inward" OR SWIFT OR MT103 OR IRT)` },
  { hint: "shipping", q: `has:attachment -in:chats (AWB OR "air waybill" OR HAWB OR "shipping bill" OR "bill of lading" OR "packing list" OR customs OR "export declaration" OR DHL OR FedEx OR Aramex OR "India Post")` },
];

const squash = s => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const num = v => { const n = parseFloat(String(v ?? "").replace(/,/g, "")); return Number.isFinite(n) ? n : null; };
const dayNo = d => { const t = new Date(`${String(d || "").slice(0, 10)}T12:00:00Z`).getTime(); return Number.isFinite(t) ? t / 86400000 : null; };
const daysApart = (a, b) => { const x = dayNo(a), y = dayNo(b); return x == null || y == null ? null : y - x; };
const istDay = (t = Date.now()) => new Date(t + 5.5 * 3600_000).toISOString().slice(0, 10);
const words = s => new Set(String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(w => w.length > 2 &&
  !["pvt", "ltd", "the", "and", "private", "limited", "llp", "india", "company", "exports", "traders"].includes(w)));
const overlap = (a, b) => { const A = words(a), B = words(b); let n = 0; A.forEach(w => B.has(w) && n++); return n; };
const nameOnly = from => String(from || "").replace(/<[^>]*>/g, "").replace(/"/g, "").trim() || String(from || "").replace(/@.*/, "");
const hasDoc = t => (t?.attachments?.length || 0) > 0 || !!t?.attachmentUrl;
const txnText = t => `${t.payee || ""} ${t.notes || ""} ${t.rawPayee || ""} ${t.rawNotes || ""} ${t.bankRemarks || ""} ${t.category || ""}`;
const isBoi = acc => !!acc && (/bank of india|\bboi\b|eefc/i.test(acc.name || "") || /boi|eefc/i.test(acc.id || ""));
const isEefcAcc = acc => /eefc/i.test(acc?.name || "") || /eefc/i.test(acc?.id || "");
const isInward = (t, acc) => t?.type === "credit" && isBoi(acc) && (isEefcAcc(acc) ||
  /inward\s*rem|\bfirc\b|\birt\b|\d{3,}IRT\d+|swift|foreign\s*remit/i.test(txnText(t)) || /inward remittance|firc/i.test(t.classifiedRef?.cat || ""));
const accOf = (t, accounts) => accounts.find(a => a.id === (t.type === "credit" ? (t.accountTo || t.accountFrom) : t.accountFrom)) ||
  accounts.find(a => a.id === t.accountFrom || a.id === t.accountTo);

/* ── Reading a document ─────────────────────────────────────────────────── */

async function pdfText(buf) {
  try {
    const { PDFParse } = await import("pdf-parse");
    const p = new PDFParse({ data: buf });
    try { return String((await p.getText({ first: 4 })).text || ""); } finally { await p.destroy().catch(() => {}); }
  } catch { return ""; }
}

const PROMPT = `You read one document attached to an email received by Nikhil Gems (GSTIN ${OUR_GSTIN.ng}) or Atyahara (GSTIN ${OUR_GSTIN.at}), Indian exporters of gemstones and minerals.
Answer with ONLY this JSON (null where the document doesn't say):
{"doc_type": one of "purchase_invoice" (a bill from a supplier TO us), "sales_invoice" (an invoice WE issued), "remittance_advice" (inward foreign remittance / FIRC / bank credit advice), "payment_receipt", "shipping" (AWB, HAWB, bill of lading, courier invoice for a shipment, packing list), "customs" (shipping bill, export declaration, customs papers), "statement" (bank or card statement), "other",
 "vendor": issuer's business name, "vendor_gstin": issuer's GSTIN, "buyer_gstin": the GSTIN billed to,
 "invoice_no": the document's own number, "date": "YYYY-MM-DD", "amount": the grand total / amount received as a number, "currency": ISO code,
 "reference": IRT / UTR / SWIFT ref / AWB / shipping bill number, "invoice_refs": [our invoice numbers it mentions, e.g. "NG-39"],
 "party": the overseas buyer / remitter / consignee name if any, "summary": under 12 words}`;

async function aiRead({ text, b64, type, name }) {
  const key = process.env.OPENAI_KEY || process.env.OPENAI_API_KEY;
  if (!key) throw new Error("no OpenAI key on the server");
  let part;
  if (text.trim().length >= 120) part = { type: "text", text: `${PROMPT}\n\nFile: ${name}\n---\n${text.slice(0, 12000)}` };
  else if (/^image\//i.test(type)) part = [{ type: "image_url", image_url: { url: `data:${type};base64,${b64}`, detail: "high" } }, { type: "text", text: PROMPT }];
  else part = [{ type: "file", file: { filename: name || "document.pdf", file_data: `data:application/pdf;base64,${b64}` } }, { type: "text", text: PROMPT }];
  const r = await aiFetch("https://api.openai.com/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: MODEL, temperature: 0, max_tokens: 500, response_format: { type: "json_object" },
      messages: [{ role: "user", content: Array.isArray(part) ? part : [part] }] }),
    signal: AbortSignal.timeout(45_000),
  }, "erp:inbox-scan");
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error(d?.error?.message || `OpenAI ${r.status}`);
  try { return JSON.parse(d.choices?.[0]?.message?.content || "{}"); } catch { return {}; }
}

const KIND = { purchase_invoice: "bill", remittance_advice: "remittance", payment_receipt: "remittance", shipping: "shipping", customs: "shipping" };

/* ── Matching ───────────────────────────────────────────────────────────── */

const close = (a, b) => a > 0 && b > 0 && Math.abs(a - b) <= Math.max(1, a * 0.005);
const money = (n, cur) => (!cur || cur === "INR") ? `₹${(+n || 0).toLocaleString("en-IN")}` : `${cur} ${(+n || 0).toLocaleString("en-US")}`;
const txnLabel = t => `${t.payee || t.category || "Entry"} · ${money(t.amount, t.currency)} · ${t.date}`;

function matchBill(doc, ctx) {
  const co = doc.company || "ng";
  const { txns, purchases } = ctx[co];
  const f = doc.fields, amt = num(f.amount), out = [];
  const no = squash(f.invoiceNo);
  for (const p of purchases) {
    let score = 0, why = [];
    if (no.length >= 3 && squash(p.billNumber) === no) { score += 6; why.push("same bill number"); }
    if (close(amt, num(p.totalAmount))) { score += 3; why.push("same total"); }
    const gap = daysApart(p.billDate || p.date, f.date);
    if (gap != null && Math.abs(gap) <= 3) { score += 1; why.push("same date"); }
    if ((f.vendorGstin && squash(p.supplierGstin) === squash(f.vendorGstin)) || overlap(p.supplier, f.vendor)) { score += 2; why.push("same supplier"); }
    if (score >= 5) out.push({ target: "purchase", company: co, id: p.id, score: score - (p.docUrl ? 2 : 0), why: why.join(", ") + (p.docUrl ? " (already has a document)" : ""),
      label: `Purchase bill ${p.billNumber || ""} · ${p.supplier || ""} · ₹${(+p.totalAmount || 0).toLocaleString("en-IN")}`.replace(/\s+/g, " ") });
  }
  for (const t of txns) {
    if (t.type !== "debit" || !close(amt, +t.amount) || (t.currency || "INR") !== (f.currency || "INR")) continue;
    const gap = daysApart(f.date, t.date);
    if (gap == null || gap < -15 || gap > 75) continue;
    let score = 4 + (Math.abs(gap) <= 7 ? 2 : Math.abs(gap) <= 30 ? 1 : 0);
    const named = overlap(txnText(t), f.vendor) > 0;
    if (named) score += 2;
    if (hasDoc(t)) score -= 2;
    out.push({ target: "txn", company: co, id: t.id, score, label: txnLabel(t),
      why: `same amount, ${gap === 0 ? "same day" : `${Math.abs(gap)} day${Math.abs(gap) === 1 ? "" : "s"} ${gap > 0 ? "after" : "before"} the bill`}${named ? ", payee matches" : ""}${hasDoc(t) ? " (already has a document)" : ""}` });
  }
  return out;
}

function matchRemittance(doc, ctx) {
  const { txns, accounts } = ctx.ng, remits = ctx.remits;
  const f = doc.fields, out = [];
  const ref = squash(f.reference), foreign = num(f.foreignAmount ?? f.amount), inr = num(f.inrAmount), cur = f.currency;
  for (const r of remits) {
    let score = 0, why = [];
    if (ref.length >= 6 && squash(r.irt) === ref) { score += 7; why.push("same IRT"); }
    if (close(foreign, num(r.amount)) && (!cur || r.currency === cur)) { score += 3; why.push("same amount"); }
    const gap = daysApart(r.date, f.date);
    if (gap != null && Math.abs(gap) <= 7) { score += 1; why.push("within a week"); }
    if (score >= 4) out.push({ target: "remit", company: "ng", id: r.id, score: score - (r.attachment?.url ? 3 : 0),
      label: `Register ${r.irt || ""} · ${money(r.amount, r.currency)} · ${r.date || ""}`.replace(/\s+/g, " "),
      why: why.join(", ") + (r.attachment?.url ? " (already has an advice)" : "") });
  }
  for (const t of txns) {
    const acc = accOf(t, accounts);
    if (t.type !== "credit" || !isBoi(acc)) continue;
    const gap = daysApart(f.date, t.date);
    let score = 0, why = [];
    if (ref.length >= 6 && squash(txnText(t)).includes(ref)) { score += 7; why.push("reference in the narration"); }
    if (gap != null && Math.abs(gap) <= 7) {
      if (inr && (t.currency || "INR") === "INR" && Math.abs((+t.amount || 0) - inr) < 1) { score += 5; why.push("same ₹ credited"); }
      else if (foreign && t.currency === cur && Math.abs((+t.amount || 0) - foreign) < 0.01) { score += 5; why.push(`same ${cur} credited`); }
    }
    if (score >= 5) out.push({ target: "txn", company: "ng", id: t.id, score: score - (hasDoc(t) ? 2 : 0), label: txnLabel(t),
      why: why.join(", ") + (hasDoc(t) ? " (already has a document)" : "") });
  }
  return out;
}

function matchShipping(doc, ctx, text) {
  const invoices = ctx.invoices, f = doc.fields, out = [];
  const blob = squash(`${text} ${(f.invoiceRefs || []).join(" ")} ${f.reference || ""}`);
  for (const inv of invoices) {
    let score = 0, why = [];
    const no = squash(inv.invNo);
    if (no.length >= 3 && new RegExp(`${no}(?![0-9])`).test(blob)) { score += 6; why.push(`mentions ${inv.invNo}`); }
    if (inv.sbNo && squash(inv.sbNo).length >= 5 && blob.includes(squash(inv.sbNo))) { score += 6; why.push("same shipping bill no."); }
    const party = inv.consigneeName || inv.buyerName || "";
    if (party && (overlap(party, f.party) || overlap(party, text.slice(0, 4000)) >= 2)) { score += 2; why.push("same buyer"); }
    const gap = daysApart(inv.date, f.date);
    if (gap != null && gap >= -10 && gap <= 45) score += 1;
    if (score >= 5) out.push({ target: "invoice", company: "ng", id: inv.id, score, why: why.join(", "),
      label: `Invoice ${inv.invNo} · ${inv.consigneeName || inv.buyerName || ""} · ${inv.date}`.replace(/\s+·\s+·/, " ·") });
  }
  return out;
}

const top3 = list => list.sort((a, b) => b.score - a.score).filter((m, i, a) => a.findIndex(x => x.target === m.target && x.id === m.id) === i).slice(0, 3);

/* ── Remittances still without paperwork ─────────────────────────────────── */

function missingPapers(ctx, now) {
  const { txns, accounts } = ctx.ng;
  const out = [];
  const since = istDay(now - 120 * 86400_000);
  for (const r of ctx.remits) {
    if (r.attachment?.url) continue;
    out.push({ id: `missing-remit-${r.id}`, target: "remit", targetId: r.id, date: r.date || "", amount: num(r.amount), currency: r.currency || "",
      label: `Register entry ${r.irt || "(no IRT)"} · ${r.buyer || r.remitter || ""}`.trim() });
  }
  for (const t of txns) {
    if (!t.date || t.date < since || hasDoc(t)) continue;
    if (!isInward(t, accOf(t, accounts))) continue;
    out.push({ id: `missing-txn-${t.id}`, target: "txn", targetId: t.id, date: t.date, amount: +t.amount || 0, currency: t.currency || "INR",
      label: `Inward credit · ${t.payee || "BOI"}` });
  }
  return out;
}

/* ── The run ─────────────────────────────────────────────────────────────── */

async function readValue(sb, key) {
  const { data, error } = await sb.from("app_data").select("value").eq("key", key).maybeSingle();
  if (error) throw new Error(`${key}: ${error.message}`);
  let v = data?.value;
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { v = null; } }
  return Array.isArray(v) ? v : [];
}

async function loadBooks(sb) {
  const [ngT, ngA, atT, atA, inv, rem, ngP, atP] = await Promise.all(
    ["ng-fin-txns-v1", "ng-fin-accounts-v1", "at-fin-txns-v1", "at-fin-accounts-v1", "ng-invoices-v2", "er-ng-remittances-v1", "ng-purch-v5", "at-purch-v1"].map(k => readValue(sb, k)));
  return {
    ng: { txns: ngT, accounts: ngA, purchases: ngP },
    at: { txns: atT, accounts: atA, purchases: atP },
    invoices: inv.filter(i => String(i.status || "").toLowerCase() !== "cancelled"),
    remits: rem,
  };
}

/* bridge(body) → the Apps Script's JSON (see api/mail.js). */
export async function runInboxScan({ bridge, days = 3, trigger = "cron", now = Date.now(), sb = adminClient(), dry = false, aiRead: read = aiRead }) {
  const started = Date.now();
  const status = { id: "last", at: new Date(now).toISOString(), day: istDay(now), trigger, ok: false, found: 0, read: 0, skipped: 0, errors: [] };
  const existing = await readRows(sb, INBOX_KEY);
  const byId = new Map(existing.map(r => [r.id, r]));

  // 1. What's new in the inbox.
  const fresh = new Map();
  for (const { hint, q } of QUERIES) {
    let res;
    try { res = await bridge({ action: "search", q: `${q} newer_than:${Math.max(1, Math.min(+days || 3, 30))}d`, max: 20 }); }
    catch (e) { status.errors.push(`${hint}: ${e.message}`); continue; }
    for (const t of res.threads || []) for (const m of t.messages || []) for (const a of m.attachments || []) {
      const id = `${String(m.id).replace(/\W/g, "")}-${a.index}`;
      const pdf = /pdf/i.test(a.type) || /\.pdf$/i.test(a.name);
      const img = /^image\/(jpe?g|png|webp)/i.test(a.type);
      if (!(pdf || (img && a.size > 40_000)) || a.size > 15_000_000) continue;   // logos and signatures are small images
      if (byId.has(id) || fresh.has(id)) continue;
      fresh.set(id, { id, hint, msgId: m.id, index: a.index, name: a.name, type: a.type, size: a.size,
        email: { subject: String(m.subject || t.subject || "").slice(0, 160), from: nameOnly(m.from).slice(0, 80), date: m.date, url: t.url } });
    }
  }
  status.found = fresh.size;
  if (status.errors.length === QUERIES.length) {
    status.error = status.errors[0];
    if (dry) return { status, rows: [] };
    await sb.rpc("app_rows_upsert", { p_key: SCAN_KEY, p_item: status, p_prepend: false });
    return status;
  }

  // 2. Read each one, keep the papers we want, suggest matches.
  const books = await loadBooks(sb);
  const rows = [];
  let aiCalls = 0;
  const queue = [...fresh.values()].sort((a, b) => String(b.email.date).localeCompare(String(a.email.date)));
  for (const c of queue) {
    if (status.read >= MAX_DOCS || Date.now() - started > TIME_BUDGET_MS) { status.more = queue.length - status.read - status.skipped; break; }
    try {
      const a = await bridge({ action: "attachment", messageId: c.msgId, index: c.index });
      const buf = Buffer.from(a.b64 || "", "base64");
      const type = a.type || c.type || "application/octet-stream";
      const text = /pdf/i.test(type) || /\.pdf$/i.test(c.name) ? await pdfText(buf) : "";
      const flat = squash(text);
      const gstCo = flat.includes(OUR_GSTIN.ng) ? "ng" : flat.includes(OUR_GSTIN.at) ? "at" : "";

      let kind = "", fields = {};
      const adv = parseRemittanceAdvice(text);
      if (adv) {
        kind = "remittance";
        fields = { vendor: adv.remitterBank || "Bank of India", party: adv.remitter || "", invoiceNo: adv.remittanceNo || "", reference: adv.remittanceNo || adv.transactionId || "",
          date: adv.date || "", amount: adv.foreignAmount ?? adv.creditAmount ?? null, currency: adv.foreignCurrency || adv.creditCurrency || "",
          foreignAmount: adv.foreignAmount ?? null, inrAmount: adv.creditCurrency === "INR" ? adv.creditAmount : null, read: "advice" };
      } else {
        if (aiCalls >= MAX_AI) { status.more = (status.more || 0) + 1; continue; }
        aiCalls++;
        const x = await read({ text, b64: a.b64, type, name: a.name || c.name });
        kind = KIND[x.doc_type] || "";
        fields = { vendor: x.vendor || "", vendorGstin: squash(x.vendor_gstin), buyerGstin: squash(x.buyer_gstin), invoiceNo: x.invoice_no || "",
          date: /^\d{4}-\d{2}-\d{2}$/.test(x.date || "") ? x.date : "", amount: num(x.amount), currency: String(x.currency || "").toUpperCase().slice(0, 3),
          reference: x.reference || "", invoiceRefs: Array.isArray(x.invoice_refs) ? x.invoice_refs.slice(0, 6).map(String) : [], party: x.party || "",
          summary: String(x.summary || "").slice(0, 100), read: "ai" };
        if (kind === "remittance" && fields.currency === "INR") fields.inrAmount = fields.amount;
        if (kind === "remittance" && fields.currency && fields.currency !== "INR") fields.foreignAmount = fields.amount;
      }
      const company = gstCo || (fields.buyerGstin === OUR_GSTIN.at ? "at" : fields.buyerGstin === OUR_GSTIN.ng ? "ng" : "");
      // A bill only counts when it is billed to us by GSTIN; our own sales invoices, statements and the rest are passed over.
      const keep = kind === "bill" ? !!company && fields.vendorGstin !== OUR_GSTIN.ng && fields.vendorGstin !== OUR_GSTIN.at : !!kind;
      const base = { id: c.id, msgId: c.msgId, index: c.index, email: c.email, name: a.name || c.name, type, size: a.size || c.size, foundAt: new Date().toISOString() };
      if (!keep) {
        status.skipped++;
        rows.push({ ...base, kind: kind || "other", status: "skipped", reason: kind === "bill" ? "not billed to our GSTIN" : "not a bill, remittance or shipping paper", fields: { summary: fields.summary || "" } });
        continue;
      }
      const folder = `inbox/${istDay(now).slice(0, 7)}`;
      const path = `${folder}/${c.id}-${String(a.name || c.name || "document").replace(/[^\w.\- ]+/g, "_").slice(-80)}`;
      const st = sb.storage.from(BUCKET);
      if (!dry) {
        const { error: upErr } = await st.upload(path, buf, { contentType: type, upsert: true });
        if (upErr) throw new Error(`storage: ${upErr.message}`);
      }
      const doc = { ...base, kind, company: company || "ng", fields, status: "pending",
        file: { url: st.getPublicUrl(path).data.publicUrl, path, name: a.name || c.name, type, size: a.size || c.size } };
      doc.matches = top3(kind === "bill" ? matchBill(doc, books) : kind === "remittance" ? matchRemittance(doc, books) : matchShipping(doc, books, text));
      rows.push(doc);
      status.read++;
    } catch (e) {
      status.errors.push(`${c.name}: ${e.message}`.slice(0, 160));
    }
  }

  // 3. Remittances with no paper yet; earlier ones that got it are closed.
  const missing = missingPapers(books, now);
  const stillMissing = new Set(missing.map(m => m.id));
  for (const m of missing) if (!byId.has(m.id)) rows.push({ ...m, kind: "missing", status: "pending", foundAt: new Date().toISOString() });
  for (const r of existing) {
    if (r.kind === "missing" && r.status === "pending" && !stillMissing.has(r.id)) rows.push({ ...r, status: "resolved", decidedAt: new Date().toISOString() });
  }
  status.missing = missing.length;

  if (dry) return { status, rows };
  // 4. One write for all of it.
  if (rows.length) {
    const { error } = await sb.rpc("app_rows_apply", { p_key: INBOX_KEY, p_items: rows, p_deletes: [] });
    if (error) { status.errors.push(`save: ${error.message}`); status.error = error.message; }
  }
  const all = [...existing.filter(r => !rows.some(x => x.id === r.id)), ...rows];
  status.pending = all.filter(r => r.status === "pending" && r.kind !== "missing").length;
  status.ok = !status.error;
  status.ms = Date.now() - started;
  status.ai_calls = aiCalls;
  await sb.rpc("app_rows_upsert", { p_key: SCAN_KEY, p_item: status, p_prepend: false });
  return status;
}

/* For Raj's 07:45 snapshot: what's waiting on Sir. */
export async function inboxForSnapshot(sb) {
  const rows = await readRows(sb, INBOX_KEY);
  const scan = (await readRows(sb, SCAN_KEY)).find(r => r.id === "last") || null;
  const pending = rows.filter(r => r.status === "pending");
  const docs = pending.filter(r => r.kind !== "missing");
  return {
    scanned_at: scan?.at || null, scan_ok: scan?.ok ?? null, scan_error: scan?.error || null,
    pending_documents: docs.length,
    by_kind: docs.reduce((c, r) => (c[r.kind] = (c[r.kind] || 0) + 1, c), {}),
    with_suggested_match: docs.filter(r => r.matches?.length).length,
    remittances_without_paperwork: pending.filter(r => r.kind === "missing").length,
    new_today: docs.filter(r => (r.foundAt || "").slice(0, 10) >= istDay(Date.now() - 86400_000)).map(r => ({
      kind: r.kind, vendor: r.fields?.vendor || "", amount: r.fields?.amount ?? null, currency: r.fields?.currency || "", matched: !!r.matches?.length })).slice(0, 12),
  };
}
