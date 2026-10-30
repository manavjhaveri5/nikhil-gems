/* The custom acrylic stand, offered at the foot of every piece's description:
   Etsy's copy points at the stand's Etsy listing, the store's at its
   eartheditions.co page. Whatever stand line the description already carries
   (typed by hand, or with the other platform's link) gives way to the right
   one, so it appears once. The stand itself, and other stands, go without. */
export const STAND_LINKS = {
  etsy: "https://www.etsy.com/in-en/listing/4585700462/custom-acrylic-mineral-display-stand?variation0=7141686101",
  store: "https://eartheditions.co/products/custom-acrylic-mineral-display-stand-personalized-crystal-and-mineral--xmqbn",
};
const LINE = /^.*customi[sz]ed acrylic stand from .*$/gim;

export function withStandLine(text, platform, title = "") {
  const body = String(text || "").replace(LINE, "").replace(/\n{3,}/g, "\n\n").trim();
  if (!body || /\bstands?\b/i.test(title) || !STAND_LINKS[platform]) return body;
  return `${body}\n\nYou can order a customized acrylic stand from ${STAND_LINKS[platform]}`;
}
