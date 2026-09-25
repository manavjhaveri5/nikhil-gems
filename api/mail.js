import { requireUser } from "../lib/auth.js";
import { tradeApproved } from "../lib/mailTemplates.js";

/* Emails the ERP sends itself, through Resend, from the eartheditions.co
   domain (SPF/DKIM/DMARC verified in Resend) so they land in inboxes rather
   than junk. Only fixed templates can be sent — no free-form mail — and only
   by a signed-in staff member. Answers 503 until RESEND_API_KEY is set, and the
   caller falls back to the Omnisend automation. */
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!(await requireUser(req, res))) return;
  const key = process.env.RESEND_API_KEY;
  if (!key) return res.status(503).json({ error: "Email isn't set up yet (RESEND_API_KEY)", notConfigured: true });
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch { b = {}; } }
  const to = String(b?.to || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ error: "Bad recipient" });

  let mail;
  if (b.template === "trade_approved") {
    const setupUrl = String(b.setup_url || "");
    const siteUrl = String(b.site_url || "https://trade.eartheditions.co");
    if (!/^https:\/\/[^/]+\/set-password\?t=[\w-]+$/.test(setupUrl)) return res.status(400).json({ error: "Bad set-up link" });
    mail = tradeApproved({ name: b.name, setupUrl, siteUrl, logoUrl: process.env.MAIL_LOGO_URL || "https://earth-store-six.vercel.app/logo.png" });
  } else return res.status(400).json({ error: "Unknown template" });

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.MAIL_FROM || "Earth Editions <hello@eartheditions.co>",
      to: [to],
      ...(process.env.MAIL_REPLY_TO ? { reply_to: process.env.MAIL_REPLY_TO } : {}),
      subject: mail.subject, html: mail.html, text: mail.text,
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return res.status(502).json({ error: d?.message || `Resend ${r.status}` });
  return res.json({ ok: true, id: d.id });
}
