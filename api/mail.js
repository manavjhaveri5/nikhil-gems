import { requireUser, adminClient, cronKeyOk } from "../lib/auth.js";
import { runInboxScan, SCAN_KEY } from "../lib/inbox-scan.js";
import { tradeApproved, checkoutFollowup, orderShipped } from "../lib/mailTemplates.js";

const STORE = "https://eartheditions.co";

/* Emails the ERP sends itself, through Resend, from the eartheditions.co
   domain (SPF/DKIM/DMARC verified in Resend) so they land in inboxes rather
   than junk. Only fixed templates can be sent — no free-form mail — and only
   by a signed-in staff member. Answers 503 until RESEND_API_KEY is set, and the
   caller falls back (the Omnisend automation, or a draft in the mail app). */
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  // The 07:00 IST inbox scan comes from pg_cron with Raj's key; Sir can also run it from Home.
  if (req.body?.action === "gmail_scan" && await cronKeyOk(req, "raj")) return gmail(req, res);
  if (!(await requireUser(req, res))) return;
  if (String(req.body?.action || "").startsWith("gmail_")) return gmail(req, res);
  if (req.body?.template === "order_shipped") return shipStoreOrder(req, res);
  const key = process.env.RESEND_API_KEY;
  if (!key) return res.status(503).json({ error: "Email isn't set up yet (RESEND_API_KEY)", notConfigured: true });
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch { b = {}; } }
  let to = String(b?.to || "").trim();

  let mail, order = null, replyTo = process.env.MAIL_REPLY_TO || "";
  if (b.template === "trade_approved") {
    const setupUrl = String(b.setup_url || "");
    const siteUrl = String(b.site_url || "https://trade.eartheditions.co");
    if (!/^https:\/\/[^/]+\/set-password\?t=[\w-]+$/.test(setupUrl)) return res.status(400).json({ error: "Bad set-up link" });
    mail = tradeApproved({ name: b.name, setupUrl, siteUrl, logoUrl: process.env.MAIL_LOGO_URL || "https://eartheditions.co/logo.png" });
  } else if (b.template === "checkout_followup") {
    // Everything comes from the order itself: the buyer's own email, and only pieces still for sale.
    const db = adminClient();
    const { data: o, error } = await db.from("store_orders").select("id,number,name,email,lines,status,notes").eq("id", String(b.order_id || "")).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!o) return res.status(404).json({ error: "Order not found" });
    if (o.status !== "pending") return res.status(409).json({ error: `${o.number} is ${o.status} now, not unpaid` });
    const ids = (o.lines || []).map(l => l.product_id).filter(Boolean);
    const { data: prods } = await db.from("store_products").select("id,handle,status").in("id", ids.length ? ids : ["-"]);
    const live = Object.fromEntries((prods || []).filter(p => p.status === "active" && p.handle).map(p => [p.id, p.handle]));
    const pieces = (o.lines || []).filter(l => live[l.product_id]).map(l => ({ title: l.title, url: `${STORE}/products/${live[l.product_id]}` }));
    if (!pieces.length) return res.status(409).json({ error: "Those pieces aren't for sale any more, so there's nothing to send" });
    to = String(o.email || "").trim();
    order = o;
    replyTo ||= "team@eartheditions.co";   // the store's contact address: replies have to reach someone
    mail = checkoutFollowup({ name: o.name, number: o.number, pieces, siteUrl: STORE, logoUrl: process.env.MAIL_LOGO_URL || `${STORE}/logo.png` });
  } else return res.status(400).json({ error: "Unknown template" });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ error: "Bad recipient" });

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.MAIL_FROM || "Earth Editions <hello@eartheditions.co>",
      to: [to],
      ...(replyTo ? { reply_to: replyTo } : {}),
      subject: mail.subject, html: mail.html, text: mail.text,
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return res.status(502).json({ error: d?.message || `Resend ${r.status}` });
  // Noted on the order (the status stays "pending", so a late payment still lands).
  let notes;
  if (order) {
    notes = [order.notes, `Follow-up emailed ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })}.`].filter(Boolean).join(" ");
    await adminClient().from("store_orders").update({ notes }).eq("id", order.id).eq("status", "pending");
  }
  return res.json({ ok: true, id: d.id, to, notes });
}

/* Gmail search for the ERP: find the email behind a figure (remittance advice,
   purchase bill, statement) and pull its attachment in. Gmail is reached through
   a small Apps Script web app running in Nikhil Gems' own Google account
   (scripts/gmail-bridge.gs), so no Google Cloud app or token refresh is needed.
   The shared secret stays here on the server. Read-only: search and fetch. */
async function gmail(req, res) {
  const url = process.env.GMAIL_BRIDGE_URL, secret = process.env.GMAIL_BRIDGE_SECRET;
  const b = req.body;
  if (!url || !secret) {
    const error = "Gmail isn't connected yet (GMAIL_BRIDGE_URL / GMAIL_BRIDGE_SECRET)";
    // So Home can say why there's no morning scan rather than showing nothing.
    if (b.action === "gmail_scan") await adminClient().rpc("app_rows_upsert", { p_key: SCAN_KEY, p_item: { id: "last", at: new Date().toISOString(), ok: false, notConfigured: true, error }, p_prepend: false });
    return res.status(503).json({ error, notConfigured: true });
  }
  const call = async body => {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, secret }), redirect: "follow", signal: AbortSignal.timeout(60_000) });
    const d = await r.json().catch(() => null);
    if (!r.ok || !d) throw new Error(`Gmail bridge ${r.status}`);
    if (d.error) throw new Error(d.error);
    return d;
  };
  try {
    if (b.action === "gmail_search") {
      const q = String(b.q || "").slice(0, 500);
      if (!q.trim()) return res.status(400).json({ error: "Nothing to search for" });
      return res.json(await call({ action: "search", q, max: Math.min(+b.max || 15, 30), find: String(b.find || "").slice(0, 200) }));
    }
    if (b.action === "gmail_attachment") {
      // Saved to storage here, so a large PDF never has to pass back through the browser.
      const a = await call({ action: "attachment", messageId: String(b.messageId || ""), index: +b.index || 0 });
      const name = String(a.name || "attachment").replace(/[^\w.\- ]+/g, "_").slice(-80);
      const path = `${String(b.folder || "gmail").replace(/[^\w/-]/g, "")}/${String(b.messageId).replace(/\W/g, "")}-${+b.index || 0}-${name}`;
      const db = adminClient().storage.from("ng-media");
      const { error } = await db.upload(path, Buffer.from(a.b64, "base64"), { contentType: a.type || "application/octet-stream", upsert: true });
      if (error) throw new Error(error.message);
      return res.json({ url: db.getPublicUrl(path).data.publicUrl, name: a.name, type: a.type || "", size: a.size || 0 });
    }
    if (b.action === "gmail_scan") {
      // Purchase bills with our GSTIN, remittance advices and shipping papers → Home's "This morning" card.
      return res.json(await runInboxScan({ bridge: call, days: +b.days || 3, trigger: b.trigger === "manual" ? "manual" : "cron" }));
    }
    return res.status(400).json({ error: "Unknown Gmail action" });
  } catch (e) {
    return res.status(502).json({ error: e.message || "Gmail search failed" });
  }
}

/* An eartheditions.co order marked shipped from Listing Manager → Orders: the
   store order gets status "shipped" and its tracking first, so the order is right
   even when email isn't set up; then the buyer gets the shipped email (once, unless
   the tracking number changes). Answers { ok, emailed, to, tracking_url, notes }. */
const TRACK = {
  "USPS": t => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${t}`,
  "UPS": t => `https://www.ups.com/track?tracknum=${t}`,
  "FedEx": t => `https://www.fedex.com/fedextrack/?trknbr=${t}`,
  "DHL": t => `https://www.dhl.com/global-en/home/tracking/tracking-express.html?tracking-id=${t}`,
  "India Post": t => `https://www.indiapost.gov.in/_layouts/15/dop.portal.tracking/trackconsignment.aspx?consignmentnumber=${t}`,
  "Aramex": t => `https://www.aramex.com/us/en/track/results?ShipmentNumber=${t}`,
};
export const trackingLink = (carrier, tracking) => {
  const t = encodeURIComponent(String(tracking || "").trim());
  if (!t) return "";
  return (TRACK[carrier] || (x => `https://t.17track.net/en#nums=${x}`))(t);
};
async function shipStoreOrder(req, res) {
  const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const number = String(b.number || "").trim();
  const tracking = String(b.tracking || "").trim().slice(0, 60);
  const carrier = String(b.carrier || "").trim().slice(0, 40);
  if (!number) return res.status(400).json({ error: "Missing order number" });
  if (!tracking) return res.status(400).json({ error: "Add a tracking number first" });
  const db = adminClient();
  const { data: o, error } = await db.from("store_orders").select("id,number,name,email,lines,status,tracking,notes").eq("number", number).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!o) return res.status(404).json({ error: `${number} isn't in the store's orders` });
  if (!["paid", "packed", "shipped", "delivered"].includes(o.status)) return res.status(409).json({ error: `${number} is ${o.status}, so it can't be shipped` });
  const url = /^https:\/\//i.test(String(b.tracking_url || "")) ? String(b.tracking_url) : trackingLink(carrier, tracking);
  const day = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
  const already = o.tracking === tracking && /Shipped email sent/.test(o.notes || "");
  let notes = o.notes || "";
  const status = o.status === "delivered" ? "delivered" : "shipped";
  const { error: uerr } = await db.from("store_orders").update({ status, tracking, updated_at: new Date().toISOString() }).eq("id", o.id);
  if (uerr) return res.status(500).json({ error: uerr.message });

  const key = process.env.RESEND_API_KEY;
  const to = String(o.email || "").trim();
  if (already) return res.json({ ok: true, emailed: false, already: true, to, tracking_url: url, notes });
  if (!key) return res.json({ ok: true, emailed: false, notConfigured: true, to, tracking_url: url, notes });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.json({ ok: true, emailed: false, error: "The order has no valid buyer email", tracking_url: url, notes });
  const pieces = (o.lines || []).map(l => `${l.title}${(+l.qty || 1) > 1 ? ` × ${l.qty}` : ""}`);
  const mail = orderShipped({ name: o.name, number: o.number, pieces, carrier, tracking, trackingUrl: url, note: String(b.note || "").slice(0, 300), siteUrl: STORE, logoUrl: process.env.MAIL_LOGO_URL || `${STORE}/logo.png` });
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: process.env.MAIL_FROM || "Earth Editions <hello@eartheditions.co>", to: [to], reply_to: process.env.MAIL_REPLY_TO || "team@eartheditions.co", subject: mail.subject, html: mail.html, text: mail.text }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return res.json({ ok: true, emailed: false, error: d?.message || `Resend ${r.status}`, to, tracking_url: url, notes });
  notes = [notes, `Shipped email sent ${day} (${carrier || "carrier"} ${tracking}).`].filter(Boolean).join(" ");
  await db.from("store_orders").update({ notes }).eq("id", o.id);
  return res.json({ ok: true, emailed: true, id: d.id, to, tracking_url: url, notes });
}
