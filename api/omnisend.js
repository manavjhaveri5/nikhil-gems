// Omnisend — build a "new products" mailer straight from ERP listings.
//
// Deliberate design: campaigns are always created as DRAFTS. Creating a draft and
// sending a test are safe/repeatable; the real send is a separate explicit action
// (action:"send") that the ERP only calls after a typed confirmation, because a
// campaign blast to the subscriber list cannot be undone.
//
// Auth: Authorization: Omnisend-API-Key <key>  +  Omnisend-Version header.
// Key lives in the Vercel env var OMNISEND_API_KEY (never in git / NEXT_PUBLIC_*).
export const config = { api: { bodyParser: { sizeLimit: "4mb" } } };

const BASE = "https://api.omnisend.com/api";
const VERSION = "2026-03-15";

async function omni(method, path, body) {
  const key = process.env.OMNISEND_API_KEY;
  if (!key) return { ok: false, status: 400, error: "OMNISEND_API_KEY is not set. Add it in Vercel → Settings → Environment Variables." };
  let r;
  try {
    r = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Omnisend-API-Key ${key}`,
        "Omnisend-Version": VERSION,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    return { ok: false, status: 0, error: `Could not reach Omnisend: ${e.message}` };
  }
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 500) }; }
  if (!r.ok) {
    const msg = data?.error?.message || data?.error || data?.message
      || (Array.isArray(data?.errors) ? data.errors.map(e => e.message || e).join("; ") : "")
      || text.slice(0, 400) || `HTTP ${r.status}`;
    return { ok: false, status: r.status, error: String(msg), data };
  }
  return { ok: true, status: r.status, data };
}

// Omnisend's id field naming varies by resource/response envelope — accept the lot.
const pickId = o =>
  o?.templateID || o?.templateId || o?.campaignID || o?.campaignId || o?.id ||
  o?.data?.templateID || o?.data?.campaignID || o?.data?.id || "";

const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const qs = o => Object.entries(o)
  .filter(([, v]) => v !== "" && v != null)
  .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");

/* Omnisend caps page size per resource and rejects anything larger outright
   (segments max out at 50, for instance) rather than clamping. The cap isn't
   documented per-endpoint, so read it back off the error and retry once. */
async function omniList(path, params = {}) {
  let r = await omni("GET", `${path}?${qs(params)}`);
  const cap = !r.ok && /between\s+1\s+and\s+(\d+)/i.exec(r.error || "");
  if (cap && +cap[1] > 0 && +params.limit > +cap[1]) r = await omni("GET", `${path}?${qs({ ...params, limit: +cap[1] })}`);
  return r;
}

const rowsOf = (data, key) => data?.[key] || data?.data || (Array.isArray(data) ? data : []);

/* Contact shape differs between Omnisend API versions: older responses carry a
   flat `email`/`status`, newer ones nest everything under `identifiers`. Flatten
   both into one row the ERP can render, edit and export. */
function normalizeContact(c = {}) {
  const ids = Array.isArray(c.identifiers) ? c.identifiers : [];
  const emailId = ids.find(i => i.type === "email");
  const phoneId = ids.find(i => i.type === "phone");
  const email = emailId?.id || c.email || "";
  const phone = phoneId?.id || c.phone || "";
  const status = emailId?.channels?.email?.status || c.status || c.emailStatus || "";
  return {
    id: c.contactID || c.contactId || c.id || "",
    email,
    phone,
    status,
    firstName: c.firstName || "",
    lastName: c.lastName || "",
    country: c.country || c.countryCode || "",
    city: c.city || "",
    tags: Array.isArray(c.tags) ? c.tags : [],
    createdAt: c.createdAt || c.created_at || "",
    optInDate: emailId?.channels?.email?.statusDate || "",
  };
}

/* The write shape always uses `identifiers` — that is what current API versions
   accept, and older ones tolerate the extra top-level fields we send alongside. */
function contactPayload(b = {}) {
  const email = String(b.email || "").trim();
  const status = b.status === "unsubscribed" ? "unsubscribed" : "subscribed";
  return {
    ...(email ? {
      identifiers: [{
        type: "email",
        id: email,
        channels: { email: { status, statusDate: new Date().toISOString() } },
      }],
    } : {}),
    ...(b.firstName ? { firstName: String(b.firstName).slice(0, 100) } : {}),
    ...(b.lastName ? { lastName: String(b.lastName).slice(0, 100) } : {}),
    ...(b.country ? { country: String(b.country).slice(0, 100) } : {}),
    ...(b.city ? { city: String(b.city).slice(0, 100) } : {}),
    ...(Array.isArray(b.tags) && b.tags.length ? { tags: b.tags.map(t => String(t).slice(0, 60)).slice(0, 25) } : {}),
  };
}

/* ── Email HTML ──────────────────────────────────────────────────────────────
   Table-based two-column layout — the only thing that renders reliably across
   Outlook/Gmail. Inline styles for the same reason (no <style> support in Gmail
   for many clients). Images are capped and links fall back to the store URL. */
function buildCampaignHtml({ brand = "Nikhil Gems", heading = "", intro = "", products = [], ctaLabel = "View product", footer = "" }) {
  const cell = p => {
    const img = p.image
      ? `<img src="${esc(p.image)}" width="260" alt="${esc(p.title)}" style="display:block;width:100%;max-width:260px;height:auto;border:0;border-radius:8px;">`
      : `<div style="width:100%;max-width:260px;height:180px;background:#f2efe9;border-radius:8px;"></div>`;
    const link = p.url ? esc(p.url) : "";
    const wrap = inner => link ? `<a href="${link}" style="text-decoration:none;color:inherit;">${inner}</a>` : inner;
    return `
      <td width="50%" valign="top" style="padding:10px;font-family:Helvetica,Arial,sans-serif;">
        ${wrap(img)}
        <div style="font-size:15px;font-weight:700;color:#1a1308;margin:10px 0 2px;line-height:1.3;">${wrap(esc(p.title))}</div>
        ${p.meta ? `<div style="font-size:12px;color:#8a7f6d;margin-bottom:4px;">${esc(p.meta)}</div>` : ""}
        ${p.price ? `<div style="font-size:14px;font-weight:700;color:#9a6200;">${esc(p.price)}</div>` : ""}
        ${link ? `<div style="margin-top:8px;"><a href="${link}" style="display:inline-block;background:#1a1308;color:#faf0dc;text-decoration:none;font-size:12px;font-weight:700;padding:8px 14px;border-radius:6px;">${esc(ctaLabel)}</a></div>` : ""}
      </td>`;
  };

  const rows = [];
  for (let i = 0; i < products.length; i += 2) {
    rows.push(`<tr>${cell(products[i])}${products[i + 1] ? cell(products[i + 1]) : '<td width="50%"></td>'}</tr>`);
  }

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(heading || brand)}</title></head>
<body style="margin:0;padding:0;background:#faf7f2;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf7f2;padding:24px 12px;">
<tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#ffffff;border-radius:12px;overflow:hidden;">
    <tr><td style="padding:26px 24px 8px;font-family:Georgia,'Times New Roman',serif;text-align:center;">
      <div style="font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#9a6200;font-family:Helvetica,Arial,sans-serif;font-weight:700;">${esc(brand)}</div>
      ${heading ? `<div style="font-size:27px;color:#1a1308;margin-top:10px;line-height:1.25;">${esc(heading)}</div>` : ""}
    </td></tr>
    ${intro ? `<tr><td style="padding:6px 30px 12px;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#4a4238;text-align:center;">${esc(intro).replace(/\n/g, "<br>")}</td></tr>` : ""}
    <tr><td style="padding:6px 14px 18px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows.join("")}</table>
    </td></tr>
    <tr><td style="padding:16px 24px 26px;font-family:Helvetica,Arial,sans-serif;font-size:11px;line-height:1.6;color:#8a7f6d;text-align:center;border-top:1px solid #eee7db;">
      ${footer ? `${esc(footer).replace(/\n/g, "<br>")}<br><br>` : ""}
      You're receiving this because you subscribed to ${esc(brand)}.
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  const { action } = body || {};

  try {
    /* Is the key configured and valid? Used by the ERP to show setup state. */
    if (action === "status") {
      if (!process.env.OMNISEND_API_KEY) return res.json({ ok: true, configured: false });
      const r = await omni("GET", "/segments?limit=1");
      return res.json({ ok: true, configured: true, valid: r.ok, ...(r.ok ? {} : { error: r.error }) });
    }

    /* Audiences to send to. */
    if (action === "segments") {
      // Omnisend rejects limit > 50 outright ("Must be between 1 and 50").
      const r = await omni("GET", "/segments?limit=50");
      if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
      const rows = r.data?.segments || r.data?.data || (Array.isArray(r.data) ? r.data : []);
      return res.json({
        ok: true,
        segments: rows.map(s => ({ id: s.segmentID || s.segmentId || s.id, name: s.name || s.title || "(unnamed)", count: s.contactsCount ?? s.count ?? null })),
      });
    }

    /* Past + draft campaigns, newest first. */
    if (action === "campaigns") {
      const r = await omniList("/campaigns", { limit: +body.limit || 50, offset: +body.offset || 0 });
      if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
      const rows = rowsOf(r.data, "campaigns").map(c => ({
        id: c.campaignID || c.campaignId || c.id || "",
        name: c.name || "(untitled)",
        subject: c.content?.email?.subject || c.subject || "",
        senderName: c.content?.email?.senderName || "",
        status: c.status || "",
        type: c.type || "",
        createdAt: c.createdAt || "",
        sentAt: c.sentAt || c.sendAt || c.scheduledAt || "",
        // Stats keys vary by version; take whichever is present.
        sent: c.statistics?.sent ?? c.stats?.sent ?? null,
        opened: c.statistics?.opened ?? c.stats?.opened ?? null,
        clicked: c.statistics?.clicked ?? c.stats?.clicked ?? null,
      }));
      return res.json({ ok: true, campaigns: rows, paging: r.data?.paging || null });
    }

    /* One campaign, for the detail drawer. */
    if (action === "campaign") {
      const id = String(body.campaignId || "").trim();
      if (!id) return res.status(400).json({ error: "campaignId required" });
      const r = await omni("GET", `/campaigns/${encodeURIComponent(id)}`);
      if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
      return res.json({ ok: true, campaign: r.data });
    }

    /* Subscriber list — one page at a time; the ERP loops for CSV export. */
    if (action === "contacts") {
      const params = { limit: +body.limit || 100, offset: +body.offset || 0 };
      if (body.status) params.status = body.status;
      if (body.email) params.email = String(body.email).trim();
      if (body.segmentId) params.segmentID = body.segmentId;
      const r = await omniList("/contacts", params);
      if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
      const raw = rowsOf(r.data, "contacts");
      return res.json({ ok: true, contacts: raw.map(normalizeContact), count: raw.length, paging: r.data?.paging || null });
    }

    /* Add a subscriber, or edit one when contactId is supplied. */
    if (action === "contact_save") {
      const contactId = String(body.contactId || "").trim();
      const email = String(body.email || "").trim();
      if (!contactId && !email) return res.status(400).json({ error: "Email is required" });
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: `"${email}" is not a valid email address` });
      const payload = contactPayload(body);
      let r;
      if (contactId) {
        r = await omni("PATCH", `/contacts/${encodeURIComponent(contactId)}`, payload);
        if (!r.ok && (r.status === 404 || r.status === 405)) r = await omni("PUT", `/contacts/${encodeURIComponent(contactId)}`, payload);
      } else {
        r = await omni("POST", "/contacts", payload);
        // Already on the list: patch the existing record instead of failing.
        if (!r.ok && (r.status === 409 || /exist|duplicate/i.test(r.error || ""))) {
          const found = await omniList("/contacts", { email, limit: 1 });
          const hit = rowsOf(found.data, "contacts")[0];
          const hitId = hit && (hit.contactID || hit.contactId || hit.id);
          if (hitId) r = await omni("PATCH", `/contacts/${encodeURIComponent(hitId)}`, payload);
        }
      }
      if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
      return res.json({ ok: true, contact: normalizeContact(r.data?.contact || r.data || {}), updated: !!contactId });
    }

    /* Preview only — render the same HTML the campaign would use. */
    if (action === "preview") {
      return res.json({ ok: true, html: buildCampaignHtml(body) });
    }

    /* Push the selected products into Omnisend's catalog (product picker / abandonment). */
    if (action === "sync_products") {
      const products = Array.isArray(body.products) ? body.products : [];
      if (!products.length) return res.status(400).json({ error: "No products supplied" });
      const results = [];
      for (const p of products.slice(0, 100)) {
        const payload = {
          productID: String(p.id),
          title: p.title || "Untitled",
          status: "inStock",
          ...(p.url ? { productUrl: p.url } : {}),
          ...(p.image ? { images: [{ imageID: String(p.id), url: p.image, isDefault: true }] } : {}),
          ...(p.description ? { description: String(p.description).slice(0, 900) } : {}),
          ...(p.priceValue != null ? { variants: [{ variantID: String(p.id), title: p.title || "Default", status: "inStock", price: Math.round(+p.priceValue * 100), ...(p.currency ? { currency: p.currency } : {}) }] } : {}),
        };
        // Create, and fall back to replace when the product already exists.
        let r = await omni("POST", "/products", payload);
        if (!r.ok && (r.status === 409 || /exist/i.test(r.error || ""))) r = await omni("PUT", `/products/${encodeURIComponent(String(p.id))}`, payload);
        results.push({ id: p.id, ok: r.ok, error: r.ok ? "" : r.error });
      }
      return res.json({ ok: true, synced: results.filter(r => r.ok).length, total: results.length, results });
    }

    /* Build the HTML, import it as a template, and create a DRAFT campaign. */
    if (action === "create_campaign") {
      const { name, subject, senderName, senderEmail, replyToEmail, preheader, segmentIds = [] } = body;
      if (!subject) return res.status(400).json({ error: "Subject is required" });
      if (!senderName) return res.status(400).json({ error: "Sender name is required" });
      if (!Array.isArray(body.products) || !body.products.length) return res.status(400).json({ error: "Pick at least one product" });

      const html = buildCampaignHtml(body);
      const tplName = `${name || subject} — ERP ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
      const tpl = await omni("POST", "/email-templates/import", { name: tplName.slice(0, 255), html });
      if (!tpl.ok) return res.status(tpl.status || 400).json({ error: `Template import failed: ${tpl.error}` });
      const templateID = pickId(tpl.data);
      if (!templateID) return res.status(502).json({ error: "Omnisend did not return a template id", raw: tpl.data });

      const campaign = {
        name: (name || subject).slice(0, 250),
        type: "regular",
        channel: "email",
        content: {
          email: {
            subject: String(subject).slice(0, 250),
            senderName: String(senderName).slice(0, 250),
            templateID,
            ...(senderEmail ? { senderEmail } : {}),
            ...(replyToEmail ? { replyToEmail } : {}),
            ...(preheader ? { preheader: String(preheader).slice(0, 250) } : {}),
          },
        },
        ...(segmentIds.length ? { audience: { includedSegmentIDs: segmentIds } } : {}),
      };
      const c = await omni("POST", "/campaigns", campaign);
      if (!c.ok) return res.status(c.status || 400).json({ error: `Campaign create failed: ${c.error}` });
      const campaignId = pickId(c.data);
      return res.json({ ok: true, campaignId, templateID, campaign: c.data });
    }

    /* Test send to your own address — safe, and the way to eyeball the design. */
    if (action === "test_email") {
      const { campaignId, emails } = body;
      if (!campaignId) return res.status(400).json({ error: "campaignId required" });
      const list = (Array.isArray(emails) ? emails : [emails]).filter(Boolean);
      if (!list.length) return res.status(400).json({ error: "At least one test email address required" });
      // Body shape isn't documented; try the common variants before giving up.
      let last = null;
      for (const payload of [{ emails: list }, { email: list[0] }, { recipients: list }]) {
        const r = await omni("POST", `/campaigns/${encodeURIComponent(campaignId)}/test-email`, payload);
        if (r.ok) return res.json({ ok: true, sentTo: list });
        last = r;
        if (r.status !== 400 && r.status !== 422) break;
      }
      return res.status(last?.status || 400).json({ error: last?.error || "Test send failed" });
    }

    /* THE irreversible one. Requires confirm:"SEND" so it can't fire by accident. */
    if (action === "send") {
      const { campaignId, confirm, scheduledAt } = body;
      if (!campaignId) return res.status(400).json({ error: "campaignId required" });
      if (confirm !== "SEND") return res.status(400).json({ error: "Refusing to send without explicit confirmation" });
      const sendingSettings = scheduledAt ? { strategy: "scheduled", scheduledAt } : { strategy: "immediate" };
      const r = await omni("POST", `/campaigns/${encodeURIComponent(campaignId)}/send`, { sendingSettings });
      if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
      return res.json({ ok: true, scheduled: !!scheduledAt, result: r.data });
    }

    return res.status(400).json({ error: `Unknown action "${action || ""}"` });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Omnisend request failed" });
  }
}
