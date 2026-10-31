import { requireUser, adminClient } from "../lib/auth.js";
import { tradeApproved, checkoutFollowup } from "../lib/mailTemplates.js";

const STORE = "https://eartheditions.co";

/* Emails the ERP sends itself, through Resend, from the eartheditions.co
   domain (SPF/DKIM/DMARC verified in Resend) so they land in inboxes rather
   than junk. Only fixed templates can be sent — no free-form mail — and only
   by a signed-in staff member. Answers 503 until RESEND_API_KEY is set, and the
   caller falls back (the Omnisend automation, or a draft in the mail app). */
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!(await requireUser(req, res))) return;
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
