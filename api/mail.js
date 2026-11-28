import { requireUser, adminClient, cronKeyOk, hasStoreSecret } from "../lib/auth.js";
import { runInboxScan, SCAN_KEY } from "../lib/inbox-scan.js";
import { outreachSend, outreachCheck, outreachCounts, outreachScan, outreachTick, autoStatus, setAutoSettings, outreachJoinList, outreachDigest } from "../lib/outreach.js";
import { tradeApproved, checkoutFollowup, orderShipped } from "../lib/mailTemplates.js";
import * as list from "../lib/mailList.js";
import * as weekly from "../lib/weekly.js";
import { omniList, rowsOf, buildCampaignHtml } from "./omnisend.js";

const STORE = "https://eartheditions.co";

/* Emails the ERP sends itself (order shipped, checkout follow-up, trade
   approval): from team@eartheditions.co through the Gmail bridge, or Resend if
   RESEND_API_KEY is ever set (sendTx). Only fixed templates can be sent — no
   free-form mail — and only by a signed-in staff member. */
export default async function handler(req, res) {
  // The unsubscribe link in Gmail campaigns: public, checked by its signed token.
  if (req.query?.action === "unsub") return unsub(req, res);
  // The weekly "new pieces" list: the public sign-up page, its email confirmation, and the approve/skip links.
  if (["join", "joined", "wk"].includes(req.query?.action)) return publicWeekly(req, res);
  // A product link in a Gmail campaign: note the click, then go to the product.
  if (req.query?.action === "c") {
    const c = list.readClickParams(req.query);
    if (!c) return res.status(400).send("This link isn't valid.");
    try { await list.recordClick(c, String(req.headers["user-agent"] || "")); } catch (e) { console.error("click", e.message); }
    res.setHeader("Cache-Control", "no-store");
    return res.redirect(302, c.url);
  }
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  // The 07:00 IST inbox scan comes from pg_cron with Raj's key; Sir can also run it from Home.
  if (req.body?.action === "gmail_scan" && await cronKeyOk(req, "raj")) return gmail(req, res);
  // eartheditions.co's own emails (order confirmation, password reset), sent from our Gmail.
  if (req.body?.action === "store_mail" && hasStoreSecret(req)) return storeMail(req, res);
  // Read-only Gmail search for checking the outreach sweep's queries (Raj's key only): thread ids, subjects, senders.
  if (req.body?.action === "gmail_probe" && await cronKeyOk(req, "raj")) {
    try {
      const d = await bridgeCall()({ action: "search", q: String(req.body.q || "").slice(0, 400), max: Math.min(+req.body.max || 10, 30) });
      return res.json({ threads: (d.threads || []).map(t => ({ id: t.id, subject: t.subject, messages: (t.messages || []).map(m => ({ from: m.from, date: m.date, snippet: m.snippet })) })) });
    } catch (e) { return res.status(502).json({ error: e.message }); }
  }
  // A one-off reply from Sejal to a shop that already wrote back to cold outreach (Raj key only;
  // the address must belong to an outreach lead, so this can't mail anyone new).
  if (req.body?.action === "gmail_reply" && await cronKeyOk(req, "raj")) {
    try {
      const to = String(req.body.to || "").trim().toLowerCase(), id = String(req.body.lead || "");
      const { data: row } = await adminClient().from("app_rows").select("data").eq("key", "outreach-leads-v1").eq("id", id).eq("deleted", false).maybeSingle();
      const l = row?.data;
      const mine = l && [l.email, l.reply_email, ...(l.also_emails || [])].filter(Boolean).map(x => String(x).toLowerCase()).includes(to);
      if (!mine || !["replied", "talking", "list"].includes(l.stage)) return res.status(400).json({ error: "not a lead that replied" });
      const r = await bridgeCall()({ action: "send", to, subject: String(req.body.subject || "").slice(0, 200), body: String(req.body.body || "").slice(0, 8000), name: "Sejal · Earth Editions" });
      return res.json({ ok: true, messageId: r.messageId, threadId: r.threadId });
    } catch (e) { return res.status(502).json({ error: e.message }); }
  }
  if (req.body?.action === "outreach_digest" && await cronKeyOk(req, "raj")) {
    try { return res.json(await outreachDigest({ force: true, dry: !!req.body.dry })); } catch (e) { return res.status(502).json({ error: e.message }); }
  }
  if (req.body?.action === "weekly_tick" && await cronKeyOk(req, "raj")) {
    // The same 15-minute job also drives the outreach autopilot (lib/outreach.js outreachTick),
    // with whatever time the weekly email left.
    const t0 = Date.now(), bridge = bridgeCall(), out = {};
    try { out.weekly = await weekly.tick({ bridge }); } catch (e) { console.error("weekly tick", e.message); out.weekly = { error: e.message }; }
    try { out.outreach = await outreachTick({ bridge, budgetMs: Math.max(0, 280_000 - (Date.now() - t0)) }); } catch (e) { console.error("outreach tick", e.message); out.outreach = { error: e.message }; }
    // The daily outreach note to Sir on Telegram (09:00 IST, once a day).
    try { const d = await outreachDigest(); if (!d.skipped) out.digest = { sent: !!d.sent, error: d.error }; } catch (e) { console.error("outreach digest", e.message); out.digest = { error: e.message }; }
    return res.status(out.weekly?.error && out.outreach?.error ? 502 : 200).json(out);
  }
  const user = await requireUser(req, res);
  if (!user) return;
  req.user = user;
  // Staff can send a store email too (a missed order confirmation), with the same buyer-only check.
  if (req.body?.action === "store_mail") return storeMail(req, res);
  if (String(req.body?.action || "").startsWith("gmail_")) return gmail(req, res);
  if (req.body?.template === "order_shipped") return shipStoreOrder(req, res);
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

  const d = await sendTx({ to, replyTo, ...mail });
  if (d.error) return res.status(502).json({ error: d.error });
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
/* One transactional email to one person (shipped, checkout follow-up, trade
   approval): Resend if it's ever set up, otherwise from team@eartheditions.co
   through the Gmail bridge. Runs on the server, so nobody's laptop is needed. */
async function sendTx({ to, subject, html, text, replyTo }) {
  const key = process.env.RESEND_API_KEY;
  try {
    if (key) {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: process.env.MAIL_FROM || "Earth Editions <hello@eartheditions.co>", to: [to], reply_to: replyTo || process.env.MAIL_REPLY_TO || "team@eartheditions.co", subject, html, text }),
      });
      const d = await r.json().catch(() => ({}));
      return r.ok ? { id: d.id, via: "resend" } : { error: d?.message || `Resend ${r.status}` };
    }
    const r = await bridgeCall()({ action: "send_raw", messages: [{ raw: list.raw(list.simpleMime({ to, subject, html, senderName: "Earth Editions" })) }] });
    const x = (r.results || [])[0] || {};
    return x.error ? { error: x.error } : { id: x.id || "", via: "gmail" };
  } catch (e) { return { error: e.message }; }
}

function bridgeCall() {
  const url = process.env.GMAIL_BRIDGE_URL, secret = process.env.GMAIL_BRIDGE_SECRET;
  if (!url || !secret) return async () => { throw new Error("Gmail isn't connected yet (GMAIL_BRIDGE_URL / GMAIL_BRIDGE_SECRET)"); };
  return async body => {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, secret }), redirect: "follow", signal: AbortSignal.timeout(60_000) });
    const d = await r.json().catch(() => null);
    if (!r.ok || !d) throw new Error(`Gmail bridge ${r.status}`);
    if (d.error) throw new Error(d.error);
    return d;
  };
}

async function gmail(req, res) {
  const url = process.env.GMAIL_BRIDGE_URL, secret = process.env.GMAIL_BRIDGE_SECRET;
  const b = req.body;
  if (!url || !secret) {
    const error = "Gmail isn't connected yet (GMAIL_BRIDGE_URL / GMAIL_BRIDGE_SECRET)";
    // So Home can say why there's no morning scan rather than showing nothing.
    if (b.action === "gmail_scan") await adminClient().rpc("app_rows_upsert", { p_key: SCAN_KEY, p_item: { id: "last", at: new Date().toISOString(), ok: false, notConfigured: true, error }, p_prepend: false });
    return res.status(503).json({ error, notConfigured: true });
  }
  const call = bridgeCall();
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
      const scan = await runInboxScan({ bridge: call, days: +b.days || 3, trigger: b.trigger === "manual" ? "manual" : "cron" });
      // Outreach replies ride on the same morning job: sign-ups onto Omnisend, "no thanks" stopped, bounces marked.
      let outreach, campaigns;
      try { outreach = await outreachScan({ bridge: call, trigger: "cron" }); } catch (e) { outreach = { error: e.message }; }
      // Replies, unsubscribes and bounces from Gmail campaigns.
      try { campaigns = await list.scan(call); } catch (e) { campaigns = { error: e.message }; }
      return res.json({ ...scan, outreach, campaigns });
    }
    // Wholesale outreach: one lead per call, its own stored draft only (lib/outreach.js).
    if (b.action === "gmail_outreach_send") return res.json(await outreachSend({ bridge: call, id: String(b.id || "") }));
    if (b.action === "gmail_outreach_check") return res.json(await outreachCheck({ bridge: call, id: String(b.id || "") }));
    if (b.action === "gmail_outreach_counts") return res.json(await outreachCounts());
    if (b.action === "gmail_outreach_join") return res.json(await outreachJoinList({ id: String(b.id || ""), by: req.user?.email || "" }));
    if (b.action === "gmail_outreach_auto") return res.json(await autoStatus());
    if (b.action === "gmail_outreach_auto_set") return res.json(await setAutoSettings(b.settings || {}, req.user?.email || ""));
    if (b.action === "gmail_outreach_auto_run") return res.json(await outreachTick({ bridge: call, budgetMs: 200_000 }));
    if (b.action === "gmail_outreach_scan") return res.json(await outreachScan({ bridge: call, trigger: b.force ? "manual" : "page" }));
    // Campaigns from our own Gmail (lib/mailList.js).
    if (b.action === "gmail_list_summary") {
      const contacts = await list.allContacts();
      const sends = await list.listSends();
      const clicks = await list.clickStats(sends.map(x => x.id)).catch(() => ({}));
      const engaged = contacts.filter(c => c.status === "subscribed" && list.engagementScore(c) > 0)
        .map(c => ({ id: c.id, name: c.firstName || "", score: list.engagementScore(c), eng: c.eng }))
        .sort((x, y) => y.score - x.score).slice(0, 25);
      const unsubs = contacts.filter(c => c.status === "unsubscribed" || c.status === "bounced")
        .sort((x, y) => String(y.updated || "").localeCompare(String(x.updated || ""))).slice(0, 40)
        .map(c => ({ id: c.id, status: c.status, why: c.unsubVia || c.bounceWhy || "", at: c.unsubAt || c.bouncedAt || c.updated }));
      return res.json({ ...list.listSummary(contacts), sends: sends.map(x => ({ ...x, clicks: clicks[x.id] || null })), engaged, unsubs, dayCap: list.DAY_CAP, from: list.FROM_EMAIL });
    }
    if (b.action === "gmail_list_contacts") {
      const q = String(b.q || "").toLowerCase().trim();
      const all = await list.allContacts();
      const hit = all.filter(c => (!b.status || c.status === b.status) && (!q || c.id.includes(q) || `${c.firstName || ""} ${c.lastName || ""}`.toLowerCase().includes(q) || (c.tags || []).some(t => t.toLowerCase().includes(q))));
      hit.sort((x, y) => String(y.updated || "").localeCompare(String(x.updated || "")));
      return res.json({ contacts: hit.slice(0, 200), count: hit.length });
    }
    if (b.action === "gmail_list_import") return res.json(await list.importFromOmnisend({ omniList, rowsOf }));
    if (b.action === "gmail_list_set") {
      const st = String(b.status || "");
      if (st === "subscribed") return res.json(await list.syncContact({ email: b.email, subscribe: "resubscribe", addTags: b.addTags || [] }));
      if (!["unsubscribed", "nonSubscribed"].includes(st)) return res.status(400).json({ error: "Unknown status" });
      return res.json(await list.setStatus(b.email, st, "erp"));
    }
    if (b.action === "gmail_campaign_create") {
      if (!Array.isArray(b.products) || !b.products.length) return res.status(400).json({ error: "Pick at least one product" });
      const style = b.style === "personal" ? "personal" : "catalogue";
      if (style === "personal" && !String(b.note || "").trim()) return res.status(400).json({ error: "Write the short note first" });
      const html = style === "personal" ? list.buildPersonalHtml(b) : buildCampaignHtml(b);
      // Which product each link is, so a click teaches us what that person liked.
      const links = {};
      for (const p of b.products) for (const u of [p.url, p.video]) if (/^https:\/\//.test(u || "")) links[u] = String(p.title || "").slice(0, 120);
      return res.json(await list.createSend({ html, style, links, subject: b.subject, preheader: b.preheader, senderName: b.senderName, tags: b.tags || [], excludeTags: b.excludeTags || [], draftId: b.draftId }));
    }
    if (b.action === "gmail_campaign_preview") {
      const html = list.buildPersonalHtml(b);
      return res.json({ html: list.fillName(html, { firstName: String(b.sampleName || "Sejal") }).replace(/\[\[unsubscribe_link\]\]/g, "#") });
    }
    if (b.action === "gmail_campaign_audience") {
      const n = list.audienceOf(await list.allContacts(), b.tags || [], b.excludeTags || []).length;
      return res.json({ count: n });
    }
    if (b.action === "gmail_campaign_test") return res.json(await list.sendTest({ id: b.id, to: b.to }, call));
    if (b.action === "gmail_campaign_batch") return res.json(await list.sendBatch({ id: b.id, start: !!b.start }, call));
    if (b.action === "gmail_campaign_status") return res.json(await list.setSendStatus({ id: b.id, status: b.status }));
    if (b.action === "gmail_campaign_scan") return res.json(await list.scan(call));
    // The weekly "new pieces" email (lib/weekly.js).
    if (b.action === "gmail_weekly_get") {
      const week = weekly.weekKey();
      const [settings, current, last, stats] = await Promise.all([weekly.getSettings(), weekly.getWeek(week), weekly.getWeek(weekly.weekKey(Date.now() - 7 * 864e5)), weekly.joinStats()]);
      return res.json({ week, settings, current, last, stats, joinUrl: "https://studio.eartheditions.co/join" });
    }
    if (b.action === "gmail_weekly_set") return res.json(await weekly.setSettings({ ...b.settings, by: req.user?.email || "erp" }));
    if (b.action === "gmail_weekly_build") return res.json(await weekly.build({ bridge: call, force: true, by: req.user?.email || "erp" }));
    if (b.action === "gmail_weekly_preview") return res.json({ pieces: await weekly.newPieces({ days: 7 }) });
    if (b.action === "gmail_weekly_edit") return res.json(await weekly.edit({ week: String(b.week || ""), subject: b.subject, note: b.note, drop: b.drop || [], by: req.user?.email || "" }));
    if (b.action === "gmail_weekly_test") return res.json(await weekly.testIssue({ week: String(b.week || ""), to: b.to }, call));
    if (b.action === "gmail_weekly_decide") {
      if (!["approve", "skip"].includes(b.act)) return res.status(400).json({ error: "approve or skip" });
      return res.json(await weekly.decide({ week: String(b.week || weekly.weekKey()), act: b.act, via: "erp", by: req.user?.email || "" }));
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
  const { data: o, error } = await db.from("store_orders").select("id,number,name,email,lines,status,tracking,notes,shipping").eq("number", number).maybeSingle();
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

  // Parcels abroad go Delivered Duty Paid; an order within India has no customs to mention.
  const ddp = String(o.shipping?.country || "").toUpperCase() !== "IN";
  const to = String(o.email || "").trim();
  if (already) return res.json({ ok: true, emailed: false, already: true, to, tracking_url: url, notes });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.json({ ok: true, emailed: false, error: "The order has no valid buyer email", tracking_url: url, notes });
  const pieces = (o.lines || []).map(l => `${l.title}${(+l.qty || 1) > 1 ? ` × ${l.qty}` : ""}`);
  const mail = orderShipped({ name: o.name, number: o.number, pieces, ddp, carrier, tracking, trackingUrl: url, note: String(b.note || "").slice(0, 300), siteUrl: STORE, logoUrl: process.env.MAIL_LOGO_URL || `${STORE}/logo.png` });
  const d = await sendTx({ to, ...mail });
  if (d.error) return res.json({ ok: true, emailed: false, error: d.error, to, tracking_url: url, notes });
  notes = [notes, `Shipped email sent ${day} (${carrier || "carrier"} ${tracking}).`].filter(Boolean).join(" ");
  await db.from("store_orders").update({ notes }).eq("id", o.id);
  return res.json({ ok: true, emailed: true, id: d.id, to, tracking_url: url, notes });
}

/* GET shows a page with one button (so a mail scanner opening the link can't
   unsubscribe anyone); POST unsubscribes — the button, or Gmail's one-click
   unsubscribe (RFC 8058), which POSTs "List-Unsubscribe=One-Click" here. */
async function unsub(req, res) {
  const email = list.readUnsubParams(req.query || {});
  const page = (title, body) => res.status(email ? 200 : 400).setHeader("Content-Type", "text/html; charset=utf-8").send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="margin:0;background:#f6f3ee;font-family:Georgia,serif;color:#1a1308;"><div style="max-width:440px;margin:12vh auto;padding:32px 28px;background:#fff;text-align:center;border:1px solid #e6dfd3;">
<div style="font-size:22px;letter-spacing:3px;font-weight:700;">EARTH</div><div style="font-size:10px;letter-spacing:4px;color:#8a7f6d;margin-bottom:26px;">EDITIONS</div>${body}</div></body></html>`);
  if (!email) return page("Link not valid", `<p style="font-size:15px;line-height:1.6;">This unsubscribe link isn't valid. Reply to any of our emails with "unsubscribe" and we'll take you off the list.</p>`);
  const esc = v => String(v).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  if (req.method === "POST") {
    try { await list.unsubscribe(email, String(req.query.s || ""), "link"); }
    catch (e) { return page("Try again", `<p style="font-size:15px;">Something went wrong. Please try again, or reply "unsubscribe" to any of our emails.</p>`); }
    return page("Unsubscribed", `<p style="font-size:17px;margin:0 0 10px;">You're unsubscribed.</p><p style="font-size:14px;color:#6b6152;line-height:1.6;margin:0;">${esc(email)} won't get our emails any more.</p>`);
  }
  const action = `/api/mail?${new URLSearchParams(req.query).toString()}`;
  return page("Unsubscribe", `<p style="font-size:15px;line-height:1.6;margin:0 0 22px;">Stop our emails to <strong>${esc(email)}</strong>?</p>
<form method="post" action="${esc(action)}"><button type="submit" style="background:#1a1308;color:#faf0dc;border:0;padding:12px 26px;font-size:13px;letter-spacing:1.5px;cursor:pointer;">UNSUBSCRIBE</button></form>`);
}

/* ── The weekly list's public pages ─────────────────────────────────────────
   /join (rewritten here): the sign-up form, linked from the parcel card's QR
   code and the store. ?s= says where they came from (etsy, ebay, card…).
   Double opt-in: the form only emails a confirm link; pressing the button on
   that link's page is what puts them on the list. GET pages only ever show a
   button, so a mail scanner opening a link changes nothing. */
const esc = v => String(v ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function shell(res, code, title, body) {
  return res.status(code).setHeader("Content-Type", "text/html; charset=utf-8").setHeader("Cache-Control", "no-store").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Earth Editions</title><meta name="robots" content="noindex"></head>
<body style="margin:0;background:#f6f3ee;font-family:Georgia,serif;color:#1a1308;"><div style="max-width:440px;margin:8vh auto;padding:32px 24px;background:#fff;border:1px solid #e6dfd3;">
<div style="text-align:center;font-size:22px;letter-spacing:3px;font-weight:700;">EARTH</div><div style="text-align:center;font-size:10px;letter-spacing:4px;color:#8a7f6d;margin-bottom:26px;">EDITIONS</div>${body}</div></body></html>`);
}
const BTN = "background:#1a1308;color:#faf0dc;border:0;padding:13px 26px;font-size:13px;letter-spacing:1.5px;cursor:pointer;width:100%";
const INPUT = "width:100%;box-sizing:border-box;padding:12px;border:1px solid #d9d0c1;font-size:16px;font-family:inherit;margin:0 0 12px";
function joinForm(res, src, msg = "", vals = {}) {
  return shell(res, msg ? 400 : 200, "New pieces", `<h1 style="font-weight:normal;font-size:26px;margin:0 0 10px;text-align:center">New pieces, first</h1>
<p style="font-size:15px;line-height:1.6;color:#4a4033;margin:0 0 22px;text-align:center">One short email a week with the crystals and minerals we've just listed. Most are one of a kind.</p>
${msg ? `<p style="color:#a3341f;font-size:14px">${esc(msg)}</p>` : ""}
<form method="post" action="/api/mail?action=join&amp;s=${encodeURIComponent(src)}">
<input name="email" type="email" required placeholder="Your email" value="${esc(vals.email || "")}" style="${INPUT}" autocomplete="email">
<input name="name" type="text" placeholder="First name (optional)" value="${esc(vals.name || "")}" style="${INPUT}" autocomplete="given-name">
<input name="website" type="text" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true">
<label style="display:flex;gap:10px;align-items:flex-start;font-size:14px;line-height:1.5;color:#4a4033;margin:4px 0 18px"><input type="checkbox" name="consent" value="yes" required style="margin-top:4px">${esc(weekly.CONSENT_TEXT)}</label>
<button type="submit" style="${BTN}">JOIN</button></form>
<p style="font-size:12px;color:#8a7f6d;line-height:1.5;margin:18px 0 0">We'll email you once to confirm. We never share your address. <a href="https://eartheditions.co/privacy" style="color:#8a7f6d">Privacy</a></p>`);
}
async function publicWeekly(req, res) {
  const q = req.query || {}, a = q.action;
  let b = req.body || {};
  if (typeof b === "string") b = Object.fromEntries(new URLSearchParams(b));
  try {
    if (a === "join") {
      const src = String(q.s || "web").toLowerCase().slice(0, 20);
      if (req.method !== "POST") return joinForm(res, src);
      if (b.website) return shell(res, 200, "Check your email", `<p style="font-size:16px;text-align:center">Thanks! Check your email to confirm.</p>`);
      const r = await weekly.requestJoin({ email: b.email, name: b.name, src, consent: !!b.consent }, bridgeCall());
      if (r.error) return joinForm(res, src, r.error, b);
      return shell(res, 200, "Check your email", `<p style="font-size:17px;text-align:center;margin:0 0 10px">Nearly there.</p><p style="font-size:15px;line-height:1.6;text-align:center;color:#4a4033;margin:0">We've sent a confirm link to <strong>${esc(String(b.email).trim())}</strong>. Press the button in it and you're on the list. (No email? Check Promotions or spam.)</p>`);
    }
    if (a === "joined") {
      const email = weekly.readJoinParams(q);
      if (!email) return shell(res, 400, "Link not valid", `<p style="font-size:15px;text-align:center">This confirm link isn't valid. You can <a href="/join">sign up again here</a>.</p>`);
      if (req.method !== "POST") return shell(res, 200, "Confirm", `<p style="font-size:15px;line-height:1.6;text-align:center;margin:0 0 20px">Send new pieces to <strong>${esc(email)}</strong>, about once a week?</p><form method="post" action="/api/mail?${esc(new URLSearchParams(q).toString())}"><button type="submit" style="${BTN}">YES, SIGN ME UP</button></form>`);
      await weekly.confirmJoin(email);
      return shell(res, 200, "You're on the list", `<p style="font-size:18px;text-align:center;margin:0 0 10px">You're on the list.</p><p style="font-size:15px;line-height:1.6;text-align:center;color:#4a4033;margin:0 0 18px">The next email of new pieces comes on Friday. Every email has a one-click unsubscribe.</p><p style="text-align:center"><a href="https://eartheditions.co" style="color:#9a6200">Visit eartheditions.co</a></p>`);
    }
    if (a === "wk") {
      const week = String(q.w || ""), act = String(q.do || "");
      if (!weekly.checkWeekToken(week, act, q.t)) return shell(res, 400, "Link not valid", `<p style="text-align:center">This link isn't valid.</p>`);
      const w = await weekly.getWeek(week);
      if (!w?.sendId) return shell(res, 404, "Not found", `<p style="text-align:center">There's no issue for ${esc(week)}.</p>`);
      const label = act === "approve" ? "APPROVE AND SEND" : "SKIP THIS WEEK";
      if (req.method !== "POST") return shell(res, 200, "Weekly email", `<p style="font-size:15px;line-height:1.6;margin:0 0 6px"><strong>${esc(w.subject)}</strong></p><p style="font-size:14px;color:#4a4033;margin:0 0 20px">${w.pieceCount} pieces · ${w.audience} subscribers · now: ${esc(w.state)}</p>${w.state === "sent" ? "" : `<form method="post" action="/api/mail?${esc(new URLSearchParams(q).toString())}"><button type="submit" style="${BTN}">${label}</button></form>`}`);
      const r = await weekly.decide({ week, act, via: "email link" });
      const when = new Date(r.sendAfter).toLocaleString("en-GB", { weekday: "long", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
      return shell(res, 200, "Done", `<p style="font-size:16px;text-align:center">${r.state === "approved" ? `Approved. It goes out ${esc(when)} IST${Date.now() > Date.parse(r.sendAfter) ? " (that's passed, so within 15 minutes)" : ""}.` : r.state === "sent" ? "It has already been sent." : "Skipped. Nothing goes out this week."}</p>`);
    }
  } catch (e) {
    console.error("weekly public", e.message);
    return shell(res, 500, "Try again", `<p style="text-align:center">Something went wrong. Please try again in a minute.</p>`);
  }
  return shell(res, 404, "Not found", "");
}

/* The store's transactional emails go out from team@eartheditions.co through
   the Gmail bridge (Resend isn't set up). The store renders the email; this
   only sends it, and only to someone it belongs to: the buyer on a recent paid
   order (kind "order", with its number), or an account holder (kind "account").
   So a leaked store secret can't turn this into a way to mail strangers. */
async function storeMail(req, res) {
  const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const to = String(b.to || "").trim().toLowerCase();
  const subject = String(b.subject || "").slice(0, 200), html = String(b.html || "");
  if (!list.OK.test(to) || !subject || !html || html.length > 200_000) return res.status(400).json({ error: "Bad email" });
  const db = adminClient();
  let ok = false;
  if (b.kind === "order") {
    const { data: o } = await db.from("store_orders").select("email,status,created_at").eq("number", String(b.number || "")).maybeSingle();
    ok = !!o && String(o.email || "").trim().toLowerCase() === to && !["pending", "cancelled"].includes(o.status) && Date.now() - Date.parse(o.created_at) < 30 * 864e5;
  } else if (b.kind === "account") {
    const { data: c } = await db.from("store_customers").select("id").ilike("email", to).limit(1);
    ok = !!c?.length;
  }
  if (!ok) return res.status(403).json({ error: "Not a customer email" });
  try {
    const r = await bridgeCall()({ action: "send_raw", messages: [{ raw: list.raw(list.simpleMime({ to, subject, html, senderName: "Earth Editions" })) }] });
    const x = (r.results || [])[0] || {};
    if (x.error) throw new Error(x.error);
    return res.json({ ok: true, id: x.id || "" });
  } catch (e) {
    console.error("store mail", e.message);
    return res.status(502).json({ error: e.message });
  }
}
