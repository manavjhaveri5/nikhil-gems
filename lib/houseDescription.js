/* The shop's own description format, shared by every writer (the Telegram
   lister and the Listing Manager's AI fill) so a listing reads the same
   wherever it was made: the receive line, one paragraph about the stone, the
   spec block, the photo note, then the shop's own "About" paragraph. Only the
   paragraph is written per stone; the rest is the shop's, word for word. */

export const ATYAHARA_ABOUT = "Atyāhāra embodies a unique approach to luxury, rooted in mindful sourcing and a deep respect for Mother Earth. Our brand celebrates the beauty of nature’s treasures, not as a necessity, but as a cherished indulgence. Every piece is crafted with a commitment to sustainability, ensuring that the earth’s generosity is honored and preserved for future generations. By choosing Atyāhāra, you are embracing a journey where elegance meets responsibility, and together, we can make a difference.";
/* "About Atyāhāra" belongs on the Atyahara shop only. EarthEditions (its
   Etsy shop, eartheditions.co, the eBay store) sells under its own name, so
   the paragraph is taken out of whatever goes there. */
export const withoutAtyAbout = d => String(d || "")
  .replace(/\n*\s*About Aty[aā]h[aā]ra\s*:?\s*\n[^\n]*(?:\n(?!\s*\n)[^\n]*)*/i, "")
  .replace(/\n{3,}/g, "\n\n").trim();
export const PHOTO_NOTE = "Photographs were taken in both studio and natural lighting to show the stone as accurately as possible. Please message us for any questions.";
// One of a kind versus one of several — the shop says which, and says it first.
export const EXACT_LINE = "You will receive the EXACT piece shown in the photographs.";
export const SIMILAR_LINE = "You will receive a very SIMILAR piece. Please message us after purchasing to see available pieces.";
// A bulk lot (8-11 stones in a kilo) is several pieces, not one.
export const LOT_LINE = "You will receive very SIMILAR pieces to those shown. Please message us after purchasing to see available pieces.";

/* Phone numbers, WhatsApp/iMessage and email addresses are taken out of
   anything going to Etsy or eBay: both forbid taking a buyer off the site,
   and eBay removes listings that do. The buyer is sent to the shop's own
   messages instead. */
export const withoutContact = t => String(t || "")
  .split("\n").map(line => {
    if (!/(\+?\d[\d\s().-]{7,}\d)|whats\s*app|imessage|[\w.+-]+@[\w-]+\.[\w.]+/i.test(line)) return line;
    return line
      // "(imessage, whatsapp)" and the like, in brackets only — "text" in a sentence stays.
      .replace(/\(\s*(?:i\s*message|whats\s*app|telegram|sms|call|text)(?:\s*[,/&]\s*(?:i\s*message|whats\s*app|telegram|sms|call|text))*\s*\)/gi, "")
      .replace(/\b(?:contact|email|call|text|message|whatsapp)\s+(?:me|us)\s+(?:on|at|via)\s+(?:\+?\d[\d\s().-]{7,}\d|[\w.+-]+@[\w-]+\.[\w.]+)/gi, "Message us")
      .replace(/\s*(?:on|at|via)?\s*(?:\+?\d[\d\s().-]{7,}\d|[\w.+-]+@[\w-]+\.[\w.]+)/g, "")
      .replace(/\b(?:whats\s*app|i\s*message|text)\s+(?:me|us)\b/gi, "message us")
      .replace(/\s+(?:on\s+)?(?:whats\s*app|i\s*message)\b/gi, "")
      .replace(/\b(message us)(?:\s+(?:or|and)\s+message us)+/gi, "$1")
      .replace(/\s{2,}/g, " ").replace(/\s+([,.!])/g, "$1").trim();
  }).join("\n").replace(/\n{3,}/g, "\n\n").trim();

// What the model is asked for: the paragraph only, in the shop's voice.
export const BODY_VOICE = `Write the paragraph only — one of them, 45-90 words, in this voice:

  "This Ruby in Rhyolite sphere is a natural ruby-bearing rhyolite featuring a
  striking central magenta-pink ruby crystal surrounded by creamy white and grey
  rhyolitic matrix. Additional ruby fragments appear throughout the stone,
  creating a distinctive scattered pattern, while the polished spherical surface
  enhances the contrast, lustre, and natural mineral textures. Ideal for display
  on a desk, shelf, or as a handheld piece."

Open with "This <stone> <form> is a…", describe the stone — colour, matrix, habit,
lustre — and close on where it is at home. British spelling (lustre, colour).
No hype, no "stunning", no emoji, no claims about healing powers, no price.`;

/* The spec block in the shop's order. Weight and size share one line when
   both are known, and stand apart when not. Empty facts are left out. */
export function houseSpecs({ material, finish, origin, weight, dimensions, pantone }) {
  return [
    ["Material", material],
    ["Finish", finish],
    ["Origin", origin],
    ...(weight && dimensions
      ? [["Weight / Dimensions", `${weight} / ${dimensions}`]]
      : [["Weight", weight], ["Dimensions", dimensions]]),
    ["Pantone Color", pantone],
  ].map(([k, v]) => [k, String(v || "").trim()]).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join("\n");
}

/* brand "atyahara" ends on the About paragraph; "earth" (EarthEditions) has
   none, since that paragraph is Atyāhāra's own. */
export function houseDescription({ similar, lot = false, body, title, specs, terms = "", photos = true, brand = "atyahara" }) {
  return [
    lot ? LOT_LINE : similar ? SIMILAR_LINE : EXACT_LINE,
    String(body || "").trim() || title,
    // Sir's own terms (what's in the lot, made to order, bulk savings), as he wrote them.
    withoutContact(terms),
    houseSpecs(specs || {}),
    photos ? PHOTO_NOTE : "",
    brand === "atyahara" ? `About Atyāhāra:\n${ATYAHARA_ABOUT}` : "",
  ].filter(Boolean).join("\n\n");
}
