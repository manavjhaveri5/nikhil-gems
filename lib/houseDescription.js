/* The shop's own description format, shared by every writer (the Telegram
   lister and the Listing Manager's AI fill) so a listing reads the same
   wherever it was made: the receive line, one paragraph about the stone, the
   spec block, the photo note, then the shop's own "About" paragraph. Only the
   paragraph is written per stone; the rest is the shop's, word for word. */

export const ATYAHARA_ABOUT = "Atyāhāra embodies a unique approach to luxury, rooted in mindful sourcing and a deep respect for Mother Earth. Our brand celebrates the beauty of nature’s treasures, not as a necessity, but as a cherished indulgence. Every piece is crafted with a commitment to sustainability, ensuring that the earth’s generosity is honored and preserved for future generations. By choosing Atyāhāra, you are embracing a journey where elegance meets responsibility, and together, we can make a difference.";
export const PHOTO_NOTE = "Photographs were taken in both studio and natural lighting to show the stone as accurately as possible. Please message us for any questions.";
// One of a kind versus one of several — the shop says which, and says it first.
export const EXACT_LINE = "You will receive the EXACT piece shown in the photographs.";
export const SIMILAR_LINE = "You will receive a very SIMILAR piece. Please message us after purchasing to see available pieces.";

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
export function houseDescription({ similar, body, title, specs, photos = true, brand = "atyahara" }) {
  return [
    similar ? SIMILAR_LINE : EXACT_LINE,
    String(body || "").trim() || title,
    houseSpecs(specs || {}),
    photos ? PHOTO_NOTE : "",
    brand === "atyahara" ? `About Atyāhāra:\n${ATYAHARA_ABOUT}` : "",
  ].filter(Boolean).join("\n\n");
}
