/* What the story queue knows: when each piece went live or sold, and which
   stories have been posted or skipped (kept in app data, so every device
   agrees). Shared by the grid's badge and the queue itself. */
import { useEffect, useMemo, useState } from "react";
import { loadK, upsertItemK, onCacheRefresh } from "./utils.js";

export const STORIES_KEY = "ng-stories-v1";
export const WEEK = 7 * 86400000;

const t = v => Date.parse(v || "") || 0;
/* When a piece went live: the first time the ERP put it on a platform, or
   else when it was first listed. Etsy moves a listing's creation date to the
   day it renews, so its own first-listed date wins over a later created_at;
   a renewal is never a new piece. */
export const listedAt = l => {
  const live = Math.max(0, ...Object.values(l.platforms || {}).map(p => t(p?.live_at)));
  if (live) return live;
  const dates = [t(l.created_at), t(l.platforms?.etsy?.first_listed_at)].filter(Boolean);
  return dates.length ? Math.min(...dates) : 0;
};
const dead = o => /cancel|refund/i.test(o.status || "") || !!o.cancelled_at || !!o.refunded;
export const ago = ms => {
  const s = (Date.now() - ms) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 60) return `${Math.round(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
};
export const cover = l => (l.images || []).find(u => typeof u === "string");
// Supabase and Etsy both serve smaller copies on request.
export const small = u => /etsystatic\.com\/.*il_fullxfull\./.test(u || "") ? u.replace("il_fullxfull.", "il_340x270.")
  : /\/storage\/v1\/object\/public\//.test(u || "") ? u.replace("/object/public/", "/render/image/public/") + (u.includes("?") ? "&" : "?") + "width=340&quality=70" : u;

/* The two lists, shared with the toolbar badge so both count the same way. */
export function storyLists(listings, orders, isLive, done = {}) {
  const now = Date.now();
  /* A sale finds its piece by the ERP listing it was matched to, else by its
     Etsy listing or eBay item; a sale of something not in Listing Manager at
     all still gets a story, from the order's own title and photo. Every
     sale counts, one-offs and stock pieces alike. */
  const byId = new Map(), byEtsy = new Map(), byEbay = new Map();
  for (const l of listings || []) {
    byId.set(l.id, l);
    if (l.platforms?.etsy?.listing_id) byEtsy.set(String(l.platforms.etsy.listing_id), l);
    if (l.platforms?.ebay?.item_id) byEbay.set(String(l.platforms.ebay.item_id), l);
  }
  const lastSale = new Map();   // listing id → { l, at }
  for (const o of orders || []) {
    if (!o || dead(o)) continue;
    const l = byId.get(o.listing_id) || byEtsy.get(String(o.etsy_listing_id || "")) || byEbay.get(String(o.ebay_item_id || ""))
      || (o.listing_image ? { id: `order:${o.platform_order_id || o.id}`, title: o.listing_title || "Sold piece", images: [o.listing_image], material: o.listing_material || "" } : null);
    if (!l) continue;
    const at = t(o.created_at || o.date);
    if (at > (lastSale.get(l.id)?.at || 0)) lastSale.set(l.id, { l, at });
  }
  const withPhoto = (listings || []).filter(cover);
  const listed = withPhoto.filter(l => isLive(l)).map(l => ({ l, at: listedAt(l) })).sort((a, b) => b.at - a.at);
  const sold = [...lastSale.values()].filter(r => cover(r.l)).sort((a, b) => b.at - a.at);
  const due = (rows, kind) => rows.filter(r => now - r.at < WEEK && !done[`${kind}:${r.l.id}`]);
  return { listed, sold, due: { listed: due(listed, "listed"), sold: due(sold, "sold") } };
}

export function useStoriesDone() {
  const [rows, setRows] = useState([]);
  useEffect(() => {
    let off = false;
    const pull = () => loadK(STORIES_KEY).then(r => !off && setRows(Array.isArray(r) ? r : [])).catch(() => {});
    pull();
    const stop = onCacheRefresh?.(keys => (!keys || keys.includes(STORIES_KEY)) && pull());
    return () => { off = true; typeof stop === "function" && stop(); };
  }, []);
  const done = useMemo(() => Object.fromEntries(rows.map(r => [r.id, r])), [rows]);
  const mark = async (kind, l, how) => {
    const row = { id: `${kind}:${l.id}`, kind, listing_id: l.id, how, at: new Date().toISOString() };
    setRows(rs => [row, ...rs.filter(r => r.id !== row.id)]);
    await upsertItemK(STORIES_KEY, row).catch(() => {});
  };
  return { done, mark };
}

