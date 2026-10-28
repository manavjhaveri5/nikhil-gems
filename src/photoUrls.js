/* Our photos (Supabase storage, ng-media and trade-media) at a smaller size,
   resized by the store's /img/sb route (earth-store app/img/sb) and cached at
   its edge — not by Supabase, whose resizing is metered at 100 photos a month
   on our plan. The widths are the ones that route makes (IMG_WIDTHS in the
   store's lib/format.js); anything else is returned as it was. */
const IMG_WIDTHS = [200, 400, 700, 1000, 1400, 2000];
const SB_PHOTO = /^https:\/\/[^/]+\.supabase\.co\/storage\/v1\/object\/public\/(ng-media|trade-media)\/([^?#]+)/;

export const sbThumb = (u, w) => {
  const s = String(u || "").match(SB_PHOTO);
  return s ? `https://eartheditions.co/img/sb/${IMG_WIDTHS.find(x => x >= w) || 2000}/${s[1]}/${s[2]}` : u;
};
