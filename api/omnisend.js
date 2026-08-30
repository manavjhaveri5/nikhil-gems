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

/* Escapes for HTML, then folds every non-ASCII character to a numeric entity.
   The output is handed to Omnisend's importer, which strips the <head> — and
   the <meta charset> with it — so an em dash left as raw bytes is at the mercy
   of whatever encoding the next tool assumes, and arrives as "â€". As entities
   the dashes, curly quotes and accented buyer names are pure ASCII and cannot
   be misread, whatever handles the file next. */
const esc = s => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
  // The /u flag matters: without it an emoji is two surrogate halves, and each
  // half becomes an entity that is meaningless on its own.
  .replace(/[^\x00-\x7F]/gu, c => `&#${c.codePointAt(0)};`);

const qs = o => Object.entries(o)
  .filter(([, v]) => v !== "" && v != null)
  .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");

/* Omnisend pages with opaque cursors (?after=<cursor>), not offset/page — those
   are rejected as "Unknown parameter". Page size caps at 250 and larger values
   are rejected rather than clamped, so read the cap back off the error and retry. */
const PAGE_MAX = 250;
async function omniList(path, params = {}) {
  let r = await omni("GET", `${path}?${qs(params)}`);
  const cap = !r.ok && /between\s+1\s+and\s+(\d+)/i.exec(r.error || "");
  if (cap && +cap[1] > 0 && +params.limit > +cap[1]) r = await omni("GET", `${path}?${qs({ ...params, limit: +cap[1] })}`);
  return r;
}
const pagingOf = data => ({
  hasMore: !!data?.paging?.hasMore,
  after: data?.paging?.cursors?.after || "",
});
const clampLimit = n => Math.min(PAGE_MAX, Math.max(1, +n || 100));

const rowsOf = (data, key) => data?.[key] || data?.data || (Array.isArray(data) ? data : []);

/* Contacts come back flat (email/status at the top level) with an `identifiers`
   array alongside; `phone` is an array, not a string. Read both so the row stays
   correct if the account is ever moved to a different API version. */
function normalizeContact(c = {}) {
  const emailId = (Array.isArray(c.identifiers) ? c.identifiers : []).find(i => i.type === "email");
  const phone = Array.isArray(c.phone) ? (c.phone[0]?.phone || c.phone[0] || "") : (c.phone || "");
  return {
    id: c.contactID || c.contactId || c.id || "",
    email: c.email || emailId?.id || "",
    phone: typeof phone === "string" ? phone : "",
    status: c.status || emailId?.channels?.email?.status || "",
    firstName: c.firstName || "",
    lastName: c.lastName || "",
    country: c.country || c.countryCode || "",
    city: c.city || "",
    tags: Array.isArray(c.tags) ? c.tags : [],
    segments: Array.isArray(c.segments) ? c.segments : [],
    createdAt: c.createdAt || "",
    optInDate: emailId?.channels?.email?.statusChangedAt || "",
  };
}

const contactFields = b => ({
  ...(b.firstName != null ? { firstName: String(b.firstName).slice(0, 100) } : {}),
  ...(b.lastName != null ? { lastName: String(b.lastName).slice(0, 100) } : {}),
  ...(b.country ? { country: String(b.country).slice(0, 100) } : {}),
  ...(b.city ? { city: String(b.city).slice(0, 100) } : {}),
  ...(Array.isArray(b.tags) && b.tags.length ? { tags: b.tags.map(t => String(t).slice(0, 60)).slice(0, 25) } : {}),
});

/* ── Email HTML ──────────────────────────────────────────────────────────────
   Table-based layout with inline styles — the only thing that renders reliably
   across Outlook and Gmail, which strip <style> blocks and ignore flex/grid.
   Every design option therefore has to resolve to table attributes and inline
   CSS rather than classes.

   Colours are validated because they land unescaped inside a style attribute. */
const HEX = /^#?[0-9a-f]{3}([0-9a-f]{3})?$/i;
const hex = (v, fallback) => {
  const s = String(v || "").trim();
  if (!HEX.test(s)) return fallback;
  return s.startsWith("#") ? s : `#${s}`;
};
// Soften a hex toward white, for panel backgrounds derived from the accent.
const tint = (h, amount = 0.9) => {
  const c = hex(h, "#9a6200").slice(1);
  const f = c.length === 3 ? c.split("").map(x => x + x).join("") : c;
  const [r, g, b] = [0, 2, 4].map(i => parseInt(f.slice(i, i + 2), 16));
  const m = v => Math.round(v + (255 - v) * amount);
  return `#${[m(r), m(g), m(b)].map(v => v.toString(16).padStart(2, "0")).join("")}`;
};

const FONTS = {
  serif: { head: "Georgia,'Times New Roman',serif", body: "Helvetica,Arial,sans-serif" },
  sans:  { head: "Helvetica,Arial,sans-serif",      body: "Helvetica,Arial,sans-serif" },
};

/* Two layouts, one shell.

   "editorial" is the house style: masthead logo, dated left-aligned headline,
   an optional full-width banner, then each piece large and single-file with its
   availability, price and its own button underneath — the shape the hand-built
   Omnisend mailers use. "cards" is the older compact grid, kept because a
   short list of cheap items reads better tiled than as a long scroll. */
/* The date reads as a masthead line, so it is spelled out and shouted:
   "AUGUST 4 2026". Built from UTC to match the send, not the server's zone. */
const MONTHS = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];
const todayLine = () => {
  const d = new Date();
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${d.getUTCFullYear()}`;
};

/* The in-stock banner, drawn rather than uploaded.

   It used to be a hosted graphic, which meant it only existed if someone had
   exported one — and a JPEG of type is unreadable on a phone and invisible when
   a client blocks images. Built from tables it scales, stays selectable, and
   the copy is editable per campaign. Badges arrive as "Label | Caption" lines. */
function promoBanner({ ribbon, title, subtitle, note, badges, color, font, width }) {
  const G = hex(color, "#14331f");
  const rows = String(badges || "").split("\n").map(l => l.trim()).filter(Boolean).slice(0, 3);
  const cellW = rows.length ? Math.floor(100 / rows.length) : 100;

  const badgeCells = rows.map((line, i) => {
    const [label, caption = ""] = line.split("|").map(s => s.trim());
    // Leading emoji becomes the icon; the rest is the label.
    const m = /^(\p{Extended_Pictographic}️?)\s*(.*)$/u.exec(label || "");
    const icon = m ? m[1] : "";
    const text = m ? m[2] : label;
    return `
      <td width="${cellW}%" align="center" valign="middle" style="padding:14px 6px;${i ? `border-left:1px solid #dcdcdc;` : ""}">
        ${icon ? `<div style="font-size:19px;line-height:38px;width:38px;height:38px;background:#e6e6e6;border-radius:19px;margin:0 auto 7px;">${esc(icon)}</div>` : ""}
        <div style="font-size:11.5px;font-weight:700;color:#2b2b2b;letter-spacing:.3px;text-transform:uppercase;">${esc(text)}</div>
        ${caption ? `<div style="font-size:11px;color:#6b6b6b;padding-top:2px;">${esc(caption)}</div>` : ""}
      </td>`;
  }).join("");

  return `
    <tr><td align="center" style="padding:24px 30px 0;font-family:${font};">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:${width}px;">
        ${ribbon ? `<tr><td align="center" style="padding-bottom:16px;">
          <table role="presentation" cellpadding="0" cellspacing="0" align="center"><tr>
            <td style="background:${G};padding:9px 22px;font-size:13px;font-weight:700;letter-spacing:.8px;color:#ffffff;text-transform:uppercase;">${esc(ribbon)}</td>
          </tr></table>
        </td></tr>` : ""}
        ${title ? `<tr><td align="center" style="font-family:'Arial Black','Helvetica Neue',Helvetica,Arial,sans-serif;font-size:40px;line-height:1.05;font-weight:900;color:${G};letter-spacing:-.5px;">${esc(title)}</td></tr>` : ""}
        ${subtitle ? `<tr><td align="center" style="padding-top:10px;font-size:16px;font-weight:700;letter-spacing:1px;color:${G};text-transform:uppercase;">${esc(subtitle)}</td></tr>` : ""}
        ${note ? `<tr><td style="padding:16px 0 0;"><div style="border-top:1px solid #d8d8d8;"></div></td></tr>
        <tr><td align="center" style="padding-top:14px;font-size:13.5px;color:#3a3a3a;">${esc(note)}</td></tr>` : ""}
        ${badgeCells ? `<tr><td style="padding-top:16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;"><tr>${badgeCells}</tr></table>
        </td></tr>` : ""}
      </table>
    </td></tr>`;
}

function buildEditorialHtml({
  brand, heading, intro, products, ctaLabel, footer, accent, ink, pageBg, cardBg, font,
  showPrice, showMeta, showCta, cornerStyle, headerImage, headingSize,
  dateLine, bannerImage, priceSuffix, tradeEyebrow, tradeLine, tradeButton, tradeUrl,
  instagramUrl, addressLine,
  promoRibbon, promoTitle, promoSubtitle, promoNote, promoBadges, promoColor,
  productColumns, shipIcon, shipTitle, shipNote, logoWidth,
}) {
  const A = hex(accent, "#9a6200");
  const INK = hex(ink, "#1a1308");
  const PAGE = hex(pageBg, "#e5e6e6");
  const CARD = hex(cardBg, "#ffffff");
  const F = FONTS[font] || FONTS.serif;
  const radius = cornerStyle === "square" ? "0" : "6px";
  const MUTED = "#767676";
  const W = 540;                       // content width inside the 600px card
  // A wordmark needs room an icon doesn't — 46px would render "EARTH EDITIONS"
  // as an unreadable smudge — so the masthead width is the caller's to set.
  const LOGO_W = Math.min(W, Math.max(24, +logoWidth || 150));
  const url = v => (/^https?:\/\//i.test(String(v || "")) ? esc(v) : "");

  /* Each piece is a photo with its caption centred underneath — name, what's
     left, price, and its own way in. The button repeats per product on purpose:
     in a long scroll there is no single "the" product.

     Two-up is the default. Paired cells are top-aligned rather than stretched,
     because the photos are hand shots of different crops and forcing a common
     height would letterbox them. */
  const cols = +productColumns === 1 ? 1 : 2;
  const imgW = cols === 1 ? W : 250;

  const cell = p => {
    const link = url(p.url);
    const src = url(p.image);
    const img = src
      ? `<img src="${src}" width="${imgW}" alt="${esc(p.title)}" style="display:block;width:100%;max-width:${imgW}px;height:auto;border:0;border-radius:${radius};">`
      : `<div style="width:100%;max-width:${imgW}px;height:${cols === 1 ? 280 : 200}px;background:${tint(A, 0.94)};border-radius:${radius};"></div>`;
    return `
      <td width="${cols === 1 ? "100%" : "50%"}" align="center" valign="top" style="padding:0 ${cols === 1 ? 0 : 8}px 30px;font-family:${F.body};">
        ${link ? `<a href="${link}" style="text-decoration:none;">${img}</a>` : img}
        <div style="font-size:12.5px;color:${INK};padding-top:12px;line-height:1.5;">${esc(p.title)}</div>
        ${showMeta && p.available ? `<div style="font-size:12px;color:${INK};padding-top:5px;"><strong>Available:</strong> ${esc(p.available)}</div>`
          : showMeta && p.meta ? `<div style="font-size:12px;color:${MUTED};padding-top:5px;">${esc(p.meta)}</div>` : ""}
        ${showPrice && p.price ? `<div style="font-size:12.5px;color:${INK};padding-top:5px;white-space:nowrap;">${esc(p.price)}${priceSuffix ? ` ${esc(priceSuffix)}` : ""}</div>` : ""}
        ${showCta && link ? `<div style="padding-top:12px;">
          <a href="${link}" style="display:inline-block;border:1px solid ${INK};color:${INK};text-decoration:none;font-size:10px;letter-spacing:.5px;padding:7px 15px;">${esc(ctaLabel)}</a>
        </div>` : ""}
      </td>`;
  };

  const gridFor = list => {
    if (!list.length) return "";
    const grid = [];
    for (let i = 0; i < list.length; i += cols) {
      grid.push(`<tr>${cols === 1 ? cell(list[i])
        : `${cell(list[i])}${list[i + 1] ? cell(list[i + 1]) : '<td width="50%"></td>'}`}</tr>`);
    }
    return `<tr><td style="height:30px;line-height:30px;font-size:0;">&nbsp;</td></tr>
    <tr><td style="padding:0 30px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${grid.join("")}</table></td></tr>`;
  };

  /* The in-stock banner is a divider, not a masthead: the pieces on special
     sit under it and everything else above it. When nothing is flagged the
     mailer reads as it always has — banner first, then all the products. */
  const dealItems = products.filter(p => p.deal);
  const aboveRows = dealItems.length ? gridFor(products.filter(p => !p.deal)) : "";
  const belowRows = gridFor(dealItems.length ? dealItems : products);

  /* Shipping terms are the last thing a wholesale buyer checks, so they close
     the mailer — after the products, under the trade panel. */
  const shipPanel = (shipTitle || shipNote) ? `
    <tr><td align="center" style="padding:8px 34px 30px;font-family:${F.body};">
      ${shipIcon ? (url(shipIcon)
        ? `<img src="${url(shipIcon)}" width="34" alt="" style="display:block;margin:0 auto 14px;max-width:34px;height:auto;border:0;">`
        : `<div style="font-size:26px;line-height:1;padding-bottom:14px;">${esc(shipIcon)}</div>`) : ""}
      ${shipTitle ? `<div style="font-family:'Arial Black','Helvetica Neue',Helvetica,Arial,sans-serif;font-size:19px;font-weight:900;letter-spacing:.5px;color:${INK};text-transform:uppercase;line-height:1.3;">${esc(shipTitle)}</div>` : ""}
      ${shipNote ? `<div style="font-size:12px;line-height:1.7;color:#5a5a5a;padding-top:12px;">${esc(shipNote).replace(/\n/g, "<br>")}</div>` : ""}
    </td></tr>` : "";

  /* The standing invitation to the trade site. It is the one block that isn't
     about a single product, so it gets the inverted panel to say so. */
  const tradePanel = (tradeLine || tradeButton) ? `
    <tr><td style="padding:6px 30px 30px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${INK};">
        <tr><td align="center" style="padding:26px 20px;font-family:${F.head};">
          ${tradeEyebrow ? `<div style="font-family:${F.body};font-size:9.5px;letter-spacing:2.5px;text-transform:uppercase;color:#b6ada0;padding-bottom:8px;">${esc(tradeEyebrow)}</div>` : ""}
          ${tradeLine ? `<div style="font-size:21px;color:#ffffff;line-height:1.3;padding-bottom:16px;">${esc(tradeLine)}</div>` : ""}
          ${tradeButton && url(tradeUrl) ? `<a href="${url(tradeUrl)}" style="display:inline-block;background:${tint(A, 0.93)};color:${INK};text-decoration:none;font-family:${F.body};font-size:10.5px;letter-spacing:1.5px;text-transform:uppercase;padding:11px 22px;">${esc(tradeButton)}</a>` : ""}
        </td></tr>
      </table>
    </td></tr>` : "";

  const stamp = dateLine === false ? "" : (dateLine || todayLine());

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(heading || brand)}</title></head>
<body style="margin:0;padding:0;background:${PAGE};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAGE};padding:28px 12px;">
<tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:${CARD};">
    ${/* Wordmark files carry their own whitespace, so the cell adds little. */
      url(headerImage)
      ? `<tr><td align="center" style="padding:26px 30px 0;"><img src="${url(headerImage)}" alt="${esc(brand)}" width="${LOGO_W}" style="display:block;max-width:${LOGO_W}px;height:auto;border:0;"></td></tr>`
      : `<tr><td align="center" style="padding:32px 30px 6px;font-family:${F.body};font-size:11px;letter-spacing:2.5px;text-transform:uppercase;color:${A};font-weight:700;">${esc(brand)}</td></tr>`}
    ${stamp ? `<tr><td style="padding:${url(headerImage) ? 14 : 26}px 30px 0;font-family:${F.body};font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:${MUTED};">${esc(stamp)}</td></tr>` : ""}
    ${heading ? `<tr><td style="padding:8px 30px 0;font-family:${F.head};font-size:${Math.min(40, Math.max(16, +headingSize || 26))}px;color:${INK};line-height:1.25;">${esc(heading)}</td></tr>` : ""}
    ${intro ? `<tr><td style="padding:12px 30px 0;font-family:${F.body};font-size:12.5px;line-height:1.75;color:#5a5a5a;">${esc(intro).replace(/\n/g, "<br>")}</td></tr>` : ""}
    ${aboveRows}
    ${url(bannerImage)
      ? `<tr><td align="center" style="padding:26px 30px 0;"><img src="${url(bannerImage)}" width="${W}" alt="" style="display:block;width:100%;max-width:${W}px;height:auto;border:0;"></td></tr>`
      : (promoTitle || promoRibbon)
        ? promoBanner({ ribbon: promoRibbon, title: promoTitle, subtitle: promoSubtitle, note: promoNote, badges: promoBadges, color: promoColor || INK, font: F.body, width: W })
        : ""}
    ${belowRows}
    ${tradePanel}
    ${shipPanel}
    ${/* Omnisend appends its own footer to every campaign — the copyright, the
          postal address from account settings, the "sent to <you>" line and the
          Edit preferences / Unsubscribe links — and refuses to send a campaign
          without it. Its import docs say to strip those from imported HTML, so
          this footer carries none of them: repeating them would print the
          address twice and risk a second, dead unsubscribe link. What is left
          is ours to say. */""}
    ${(url(instagramUrl) || addressLine || footer) ? `<tr><td align="center" style="padding:0 30px 30px;font-family:${F.body};font-size:11px;line-height:1.7;color:${MUTED};">
      ${url(instagramUrl) ? `<div style="padding-bottom:10px;"><a href="${url(instagramUrl)}" style="color:${A};text-decoration:none;font-size:10.5px;letter-spacing:1.5px;text-transform:uppercase;">Instagram</a></div>` : ""}
      ${addressLine ? `<div>${esc(addressLine).replace(/\n/g, "<br>")}</div>` : ""}
      ${footer ? `<div style="padding-top:6px;">${esc(footer).replace(/\n/g, "<br>")}</div>` : ""}
    </td></tr>` : ""}
  </table>
</td></tr></table>
</body></html>`;
}

function buildCampaignHtml({
  brand = "Nikhil Gems", heading = "", intro = "", products = [],
  ctaLabel = "View product", footer = "",
  // Design options — all optional.
  layout = "editorial",
  columns = 2, accent = "#9a6200", ink = "#1a1308", pageBg = "#faf7f2", cardBg = "#ffffff",
  font = "serif", showPrice = true, showMeta = true, showCta = true, showDivider = false,
  cornerStyle = "rounded", headerImage = "", ctaStyle = "solid", headingSize = 27,
  // Editorial-only furniture.
  dateLine = "", bannerImage = "", priceSuffix = "",
  tradeEyebrow = "", tradeLine = "", tradeButton = "", tradeUrl = "",
  instagramUrl = "", addressLine = "",
  promoRibbon = "", promoTitle = "", promoSubtitle = "", promoNote = "", promoBadges = "", promoColor = "",
  productColumns = 2, shipIcon = "", shipTitle = "", shipNote = "", logoWidth = 150,
} = {}) {
  if (layout === "editorial") {
    return buildEditorialHtml({
      brand, heading, intro, products, ctaLabel, footer, accent, ink, pageBg, cardBg, font,
      showPrice, showMeta, showCta, cornerStyle, headerImage, headingSize,
      dateLine, bannerImage, priceSuffix, tradeEyebrow, tradeLine, tradeButton, tradeUrl,
      instagramUrl, addressLine,
      promoRibbon, promoTitle, promoSubtitle, promoNote, promoBadges, promoColor,
      productColumns, shipIcon, shipTitle, shipNote, logoWidth,
    });
  }
  const cols = +columns === 1 ? 1 : 2;
  const A = hex(accent, "#9a6200");
  const INK = hex(ink, "#1a1308");
  const PAGE = hex(pageBg, "#faf7f2");
  const CARD = hex(cardBg, "#ffffff");
  const F = FONTS[font] || FONTS.serif;
  const radius = cornerStyle === "square" ? "0" : "8px";
  const outerRadius = cornerStyle === "square" ? "0" : "12px";
  const imgW = cols === 1 ? 540 : 260;

  const cell = p => {
    const img = p.image
      ? `<img src="${esc(p.image)}" width="${imgW}" alt="${esc(p.title)}" style="display:block;width:100%;max-width:${imgW}px;height:auto;border:0;border-radius:${radius};">`
      : `<div style="width:100%;max-width:${imgW}px;height:${cols === 1 ? 300 : 180}px;background:${tint(A, 0.93)};border-radius:${radius};"></div>`;
    const link = p.url ? esc(p.url) : "";
    const wrap = inner => link ? `<a href="${link}" style="text-decoration:none;color:inherit;">${inner}</a>` : inner;
    const cta = ctaStyle === "outline"
      ? `display:inline-block;background:transparent;border:1.5px solid ${A};color:${A};`
      : ctaStyle === "link"
        ? `display:inline-block;color:${A};text-decoration:underline;`
        : `display:inline-block;background:${INK};color:${CARD};`;
    const ctaPad = ctaStyle === "link" ? "" : `padding:9px 16px;border-radius:${cornerStyle === "square" ? "0" : "6px"};`;
    return `
      <td width="${cols === 1 ? "100%" : "50%"}" valign="top" style="padding:10px;font-family:${F.body};">
        ${wrap(img)}
        <div style="font-size:${cols === 1 ? 18 : 15}px;font-weight:700;color:${INK};margin:10px 0 2px;line-height:1.3;">${wrap(esc(p.title))}</div>
        ${showMeta && p.meta ? `<div style="font-size:12px;color:#8a7f6d;margin-bottom:4px;">${esc(p.meta)}</div>` : ""}
        ${showPrice && p.price ? `<div style="font-size:14px;font-weight:700;color:${A};">${esc(p.price)}</div>` : ""}
        ${showCta && link ? `<div style="margin-top:8px;"><a href="${link}" style="${cta}${ctaPad}text-decoration:${ctaStyle === "link" ? "underline" : "none"};font-size:12px;font-weight:700;">${esc(ctaLabel)}</a></div>` : ""}
      </td>`;
  };

  const rows = [];
  const divider = showDivider ? `<tr><td colspan="${cols}" style="padding:4px 10px;"><div style="border-top:1px solid ${tint(A, 0.8)};"></div></td></tr>` : "";
  for (let i = 0; i < products.length; i += cols) {
    const cells = cols === 1
      ? cell(products[i])
      : `${cell(products[i])}${products[i + 1] ? cell(products[i + 1]) : '<td width="50%"></td>'}`;
    rows.push(`<tr>${cells}</tr>`);
    if (i + cols < products.length) rows.push(divider);
  }

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(heading || brand)}</title></head>
<body style="margin:0;padding:0;background:${PAGE};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAGE};padding:24px 12px;">
<tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:${CARD};border-radius:${outerRadius};overflow:hidden;">
    <tr><td style="padding:26px 24px 8px;font-family:${F.head};text-align:center;">
      ${headerImage && /^https?:\/\//i.test(headerImage)
        ? `<img src="${esc(headerImage)}" alt="${esc(brand)}" width="150" style="display:block;margin:0 auto 12px;max-width:150px;height:auto;border:0;">`
        : `<div style="font-size:13px;letter-spacing:2px;text-transform:uppercase;color:${A};font-family:${F.body};font-weight:700;">${esc(brand)}</div>`}
      ${heading ? `<div style="font-size:${Math.min(40, Math.max(16, +headingSize || 27))}px;color:${INK};margin-top:10px;line-height:1.25;">${esc(heading)}</div>` : ""}
    </td></tr>
    ${intro ? `<tr><td style="padding:6px 30px 12px;font-family:${F.body};font-size:14px;line-height:1.6;color:#4a4238;text-align:center;">${esc(intro).replace(/\n/g, "<br>")}</td></tr>` : ""}
    <tr><td style="padding:6px 14px 18px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows.join("")}</table>
    </td></tr>
    <tr><td style="padding:16px 24px 26px;font-family:${F.body};font-size:11px;line-height:1.6;color:#8a7f6d;text-align:center;border-top:1px solid ${tint(A, 0.85)};">
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

    /* Campaigns, newest first. Omnisend exposes no open/click stats on this
       resource, so the ERP links out for reporting rather than inventing numbers. */
    if (action === "campaigns") {
      const r = await omniList("/campaigns", { limit: clampLimit(body.limit || 100), after: body.after || undefined });
      if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
      const rows = rowsOf(r.data, "campaigns").map(c => ({
        id: c.id || c.campaignID || "",
        name: c.name || "(untitled)",
        subject: c.content?.email?.subject || "",
        preheader: c.content?.email?.preheader || "",
        senderName: c.content?.email?.senderName || "",
        senderEmail: c.content?.email?.senderEmail || "",
        status: c.status || "",
        type: c.type || "",
        channel: c.channel || "",
        segmentIds: c.audience?.includedSegmentIDs || [],
        createdAt: c.createdAt || "",
        sentAt: c.startedAt || "",
        endedAt: c.endedAt || "",
      }));
      return res.json({ ok: true, campaigns: rows, ...pagingOf(r.data) });
    }

    /* One campaign, for the detail panel. */
    if (action === "campaign") {
      const id = String(body.campaignId || "").trim();
      if (!id) return res.status(400).json({ error: "campaignId required" });
      const r = await omni("GET", `/campaigns/${encodeURIComponent(id)}`);
      if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
      return res.json({ ok: true, campaign: r.data });
    }

    /* Delete a draft. The status is read back from Omnisend first rather than
       trusted from the caller: a sent campaign is the record that it went out,
       and losing it loses the history. Whether Omnisend permits deleting drafts
       at all is its call — its refusal is passed through verbatim. */
    if (action === "delete_campaign") {
      const id = String(body.campaignId || "").trim();
      if (!id) return res.status(400).json({ error: "campaignId required" });
      const cur = await omni("GET", `/campaigns/${encodeURIComponent(id)}`);
      if (!cur.ok) return res.status(cur.status || 400).json({ error: cur.error });
      const status = String(cur.data?.status || cur.data?.campaign?.status || "").toLowerCase();
      if (status === "sent" || status === "sending") {
        return res.status(400).json({ error: `Refusing to delete a ${status} campaign — that record is the proof it went out.` });
      }
      const r = await omni("DELETE", `/campaigns/${encodeURIComponent(id)}`);
      if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
      return res.json({ ok: true, deleted: id });
    }

    /* Subscribers, one cursor page at a time; the ERP loops this for CSV export. */
    if (action === "contacts") {
      const params = { limit: clampLimit(body.limit || 100) };
      if (body.after) params.after = body.after;
      if (body.status) params.status = body.status;
      if (body.email) params.email = String(body.email).trim();
      if (body.segmentId) params.segmentID = body.segmentId;
      const r = await omniList("/contacts", params);
      if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
      const raw = rowsOf(r.data, "contacts");
      return res.json({ ok: true, contacts: raw.map(normalizeContact), count: raw.length, ...pagingOf(r.data) });
    }

    /* Add a subscriber, or edit one when contactId is supplied.
       Writes are attempted in the `identifiers` shape first (what current API
       versions document) and retried flat, since the read side returns both and
       the accepted write shape is not advertised anywhere in the response. */
    if (action === "contact_save") {
      const contactId = String(body.contactId || "").trim();
      const email = String(body.email || "").trim();
      const status = body.status === "unsubscribed" ? "unsubscribed" : "subscribed";
      if (!contactId && !email) return res.status(400).json({ error: "Email is required" });
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: `"${email}" is not a valid email address` });

      const withIdentifiers = {
        ...contactFields(body),
        ...(email ? { identifiers: [{ type: "email", id: email, channels: { email: { status } } }] } : {}),
      };
      const flat = { ...contactFields(body), ...(email ? { email, status } : {}) };

      const attempt = async (method, path) => {
        let r = await omni(method, path, withIdentifiers);
        if (!r.ok && (r.status === 400 || r.status === 422)) {
          const alt = await omni(method, path, flat);
          if (alt.ok) return alt;
        }
        return r;
      };

      let r;
      if (contactId) {
        r = await attempt("PATCH", `/contacts/${encodeURIComponent(contactId)}`);
        if (!r.ok && (r.status === 404 || r.status === 405)) r = await attempt("PUT", `/contacts/${encodeURIComponent(contactId)}`);
      } else {
        r = await attempt("POST", "/contacts");
        // Already on the list — patch that record rather than reporting a failure.
        if (!r.ok && (r.status === 409 || /exist|duplicate/i.test(r.error || ""))) {
          const found = await omniList("/contacts", { email, limit: 1 });
          const hitId = rowsOf(found.data, "contacts")[0]?.id;
          if (hitId) r = await attempt("PATCH", `/contacts/${encodeURIComponent(hitId)}`);
        }
      }
      if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
      return res.json({ ok: true, contact: normalizeContact(r.data?.contact || r.data || {}), updated: !!contactId });
    }

    /* Tag a subscriber by email, creating the contact if Omnisend has never seen
       them. Tags are merged rather than replaced — a PATCH with a tags array
       overwrites the list, which would strip the signup's own tags
       (form_subscriber, source: shopify, …) that the audience rules rely on. */
    if (action === "contact_tag") {
      const email = String(body.email || "").trim();
      if (!email) return res.status(400).json({ error: "Email is required" });
      const add = [...new Set((body.addTags || []).map(t => String(t).trim()).filter(Boolean))];
      const remove = new Set((body.removeTags || []).map(t => String(t).trim().toLowerCase()).filter(Boolean));
      if (!add.length && !remove.size) return res.status(400).json({ error: "No tags to change" });

      const found = await omniList("/contacts", { email, limit: 1 });
      const hit = rowsOf(found.data, "contacts")[0];

      /* createTags apply only to a contact this call brings into existence — the
         audience membership a new arrival should start with. They are deliberately
         not merged into an existing contact: someone already tagged `inactive` has
         been put there on purpose, and quietly adding `active` would land them in
         both segments at once. */
      const createTags = [...new Set((body.createTags || []).map(t => String(t).trim()).filter(Boolean))];

      if (!hit) {
        if (body.createIfMissing === false) return res.status(404).json({ error: `${email} is not in Omnisend` });
        const born = [...add];
        for (const t of createTags) if (!born.some(x => x.toLowerCase() === t.toLowerCase())) born.push(t);
        const created = await omni("POST", "/contacts", {
          identifiers: [{ type: "email", id: email, channels: { email: { status: "subscribed" } } }],
          tags: born.slice(0, 25),
          ...(body.firstName ? { firstName: String(body.firstName).slice(0, 100) } : {}),
          ...(body.lastName ? { lastName: String(body.lastName).slice(0, 100) } : {}),
        });
        if (!created.ok) return res.status(created.status || 400).json({ error: created.error });
        return res.json({ ok: true, created: true, email, tags: born });
      }

      const existing = Array.isArray(hit.tags) ? hit.tags : [];
      const kept = existing.filter(t => !remove.has(String(t).toLowerCase()));
      const merged = [...kept];
      for (const t of add) if (!merged.some(x => String(x).toLowerCase() === t.toLowerCase())) merged.push(t);
      if (merged.length === existing.length && merged.every((t, i) => t === existing[i])) {
        return res.json({ ok: true, unchanged: true, email, tags: merged });
      }
      const r = await omni("PATCH", `/contacts/${encodeURIComponent(hit.contactID || hit.contactId || hit.id)}`, { tags: merged.slice(0, 25) });
      if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
      return res.json({ ok: true, created: false, email, tags: merged });
    }

    /* Fire a custom event so an Omnisend automation can send a real email to one
       person. Omnisend has no transactional endpoint — campaigns go to segments,
       not individuals — so an event plus a one-step automation is how a single
       welcome mail gets sent. The automation lives in Omnisend, which is also
       what keeps the template, the unsubscribe footer and the open/click stats
       out of the ERP. Note the event only appears in Omnisend's trigger dropdown
       after it has fired at least once. */
    if (action === "trigger_event") {
      const email = String(body.email || "").trim();
      const eventName = String(body.eventName || "").trim();
      if (!email) return res.status(400).json({ error: "Email is required" });
      if (!eventName) return res.status(400).json({ error: "eventName is required" });
      const r = await omni("POST", "/events", {
        eventName: eventName.slice(0, 100),
        origin: "api",
        contact: { email },
        ...(body.properties && typeof body.properties === "object" ? { properties: body.properties } : {}),
      });
      if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
      return res.json({ ok: true, email, eventName });
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
