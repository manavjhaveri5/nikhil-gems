/* Links to eartheditions.co in social posts carry the platform they were
   posted on (utm_source=youtube, tiktok, pinterest…), so the store's visitor
   stats and Raj can tell which platform brings people. Before 15 Nov 2026
   every platform said utm_source=social.

   utm_medium stays "social" for posts made by hand and "autopilot" for the
   ones the autopilot made. Links to other sites are left alone. */

const STORE = /^https?:\/\/(?:www\.)?eartheditions\.co(?:[/?#]|$)/i;

export function tagUrl(url, platform) {
  if (!url || !platform || !STORE.test(url)) return url;
  try {
    const u = new URL(url);
    const medium = u.searchParams.get("utm_medium");
    u.searchParams.set("utm_source", platform);
    u.searchParams.set("utm_medium", medium && medium !== "social" ? medium : "social");
    return u.toString();
  } catch { return url; }
}

// Every store link inside a caption; punctuation that ends a sentence stays outside the link.
export function tagText(text, platform) {
  if (!text || !platform) return text;
  return String(text).replace(/https?:\/\/(?:www\.)?eartheditions\.co[^\s<>"')\]]*/gi, m => {
    const tail = (m.match(/[.,!?;:]+$/) || [""])[0];
    return tagUrl(m.slice(0, m.length - tail.length), platform) + tail;
  });
}

export function tagPayload(payload, platform) {
  if (!payload) return payload;
  const out = { ...payload };
  for (const k of ["text", "body", "comment"]) if (typeof out[k] === "string") out[k] = tagText(out[k], platform);
  if (typeof out.link === "string") out.link = tagUrl(out.link, platform);
  return out;
}
