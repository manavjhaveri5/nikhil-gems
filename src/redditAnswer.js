import { fetchWithRetry } from "./aiClient.js";

/* Answers on Reddit, to build a name as someone who knows rough stone — never
   to sell. The voice is a person, not the shop: no brand, no links, no "DM me".
   r/whatsthisrock is all photos, so the photos go to the model with the post. */
export const ANSWER = `You write Reddit replies for a man in India who has spent years buying, sorting and wholesaling rough stone and minerals — he's handled tonnes of it and can tell most stones at a glance, and he's honest when he can't. He answers to help, never to sell.

How he answers:
- Lead with the answer: what it most likely is, then the one or two things in the photo that say so (luster, habit, cleavage or fracture, colour zoning, inclusions, matrix, weight for size, how it's been cut or polished).
- If it's uncertain, say what it could be and the quick check that would settle it (scratch/hardness, streak, magnet, UV, a chipped edge, heft, a loupe on the surface).
- Call out fakes and treatments plainly when they're likely: dyed agate/howlite, glass sold as "opalite" or citrine, heated amethyst, resin, reconstituted turquoise.
- 2-5 sentences, plain Reddit English, contractions, a little dry. Speak from experience ("we get a lot of this from…", "in rough it usually…") but never invent a specific fact, place or number you aren't sure of.
- Never: the name Earth Editions, a shop, a link, prices, "DM me", offers to sell, emojis, exclamation marks, hashtags, health or metaphysical claims.`;
export async function draftAnswer(t, extra = "") {
  const content = [{ type: "text", text: `r/${t.sub} post${t.flair ? ` [${t.flair}]` : ""}\nTitle: ${t.title}\n${t.text || "(photo only)"}\n\nWrite his reply.${extra ? " " + extra : ""} Return only the reply.` },
    ...(t.images || (t.image ? [t.image] : [])).map(url => url.startsWith("data:")
      ? { type: "image", source: { media_type: url.slice(5, url.indexOf(";")), data: url.split(",")[1] } }
      : { type: "image", source: { type: "url", url } })];
  const res = await fetchWithRetry("/api/claude", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4.1", max_tokens: 400, temperature: 0.6, messages: [{ role: "system", content: ANSWER }, { role: "user", content }] }) }, { tries: 2, timeoutMs: 90000 });
  const d = await res.json();
  if (d.error) throw new Error(d.error?.message || d.error);
  return (d.content || []).map(b => b.text || "").join("").trim();
}

