/* Store → Social: an Instagram caption ready to post for every piece on
   eartheditions.co, and reply drafts for comments and threads.

   Each caption is written the way Earth Editions posts: the piece and where
   it's from, a couple of short paragraphs on what makes this one interesting,
   then weight and size, and whether it's available. The locality, weight and
   size come from the listing in Listing Manager and are never made up. The
   piece's link is tagged (utm_source=instagram), so Store → Visitors shows
   which posts bring people in. Captions are written by themselves for the
   newest pieces when this tab opens, and kept on the product
   (store_products.social.caption).

   Nothing is posted from here. Reddit and Mindat ban accounts (and whole
   websites) for automated posting and selling in threads, so replies are
   drafts to read, adjust and post by hand. The story images themselves are in
   Listing Manager → Stories. */
import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "./supabase.js";
import { C, mob, FI } from "./lmTheme.js";
import { fetchWithRetry } from "./aiClient.js";
import { loadK } from "./utils.js";

const card = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12 };
const btn = (bg = C.surface, fg = C.ink) => ({ background: bg, color: fg, border: bg === C.surface ? `1px solid ${C.border}` : "none", borderRadius: 7, padding: "6px 12px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" });
const lab = { fontSize: 9.5, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .6, marginBottom: 4, display: "block" };
const AUTO = 6;   // captions written by themselves for the newest pieces that have none

export const tagged = (site, handle, source, medium = "social") => `${site}/products/${handle}?utm_source=${source}&utm_medium=${medium}&utm_campaign=${encodeURIComponent(handle)}`;
const plain = html => String(html || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

export const VOICE = `You write for Earth Editions (eartheditions.co), a family business in India selling natural crystals, mineral specimens and gemstone carvings, bought as rough at the source and cut in house. Voice: warm, knowledgeable, plain English, no hype, at most one emoji per paragraph. The piece in the photos is the one the buyer receives.
Rules:
- Metaphysical meaning is phrased as tradition or belief ("traditionally associated with", "many people use it for"), never as a health claim — never "heals", "cures", "treats".
- Never invent facts: no locality, weight, size or treatment that isn't in the details given. If a locality isn't given, don't name one.
- Reddit and Mindat texts are for collectors: no prices, no "buy now", no links in the body, no sales language — show the piece and share what's interesting about the stone.`;

async function ask(prompt, maxTokens = 1400) {
  const res = await fetchWithRetry("/api/claude", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: maxTokens, temperature: 0.7, messages: [{ role: "system", content: VOICE }, { role: "user", content: prompt }] }),
  }, { tries: 2, timeoutMs: 60000 });
  const d = await res.json();
  if (d.error) throw new Error(d.error?.message || d.error);
  return (d.content || []).map(b => b.text || "").join("").replace(/```json|```/g, "").trim();
}

// The piece as the caption writer sees it: the store product, plus the listing's own locality, weight and size.
const details = (p, l = {}) => [
  `Name: ${p.title}`,
  p.material && `Stone: ${p.material}`, p.shape && `Shape: ${p.shape}`,
  `Locality: ${l.origin || "not given"}`,
  `Weight: ${l.weight || (p.weight_g ? `${p.weight_g}g` : "not given")}`,
  `Size: ${l.size || p.subtitle || "not given"}`,
  `Description: ${plain(l.description || p.description).slice(0, 1500)}`,
].join("\n");

// Captions Earth Editions has posted — the model writes in this shape and voice.
const EXAMPLES = `Collector's Ruby from South India 🇮🇳

A beautiful pink ruby heart from the Madikeri region, with natural silk that gives the stone a soft pink asterism when the light catches it just right.

One of those pieces where the inclusions are part of what makes it interesting.

34g | 35 × 38 × 15mm
Available — shop now at eartheditions.co

---

Citrine Ganesha from Madikeri 🇮🇳

The clarity and beautiful honey-golden color of this Citrine made us want to do something special with it—so we decided on a Ganesha carving.

A truly beautiful piece to hold and admire, especially in the light. Citrine is often associated with warmth, abundance and positivity, making it a fitting choice for Ganesha.

886 carats | 60 × 50 × 20mm
Available — shop now at eartheditions.co

---

Baryte on Rainbow Pyrite from Dahisar, Mumbai 🇮🇳

A slender Baryte flower perched on a bed of iridescent "rainbow" Pyrite — from a new find in Dahisar, Mumbai.

Pyrite is a relatively uncommon mineral from the Deccan Traps, making this association particularly interesting.

Available with a custom lucite display base — shop now at eartheditions.co`;

export async function makeCaption(p, l) {
  const caption = await ask(`Write the Instagram caption for this piece, in exactly the shape and voice of these captions we've posted:

${EXAMPLES}

The piece:
${details(p, l)}

Rules for this caption:
- First line: the piece's name, then "from <locality>" and that country's flag emoji — only if a locality is given above. No locality given: just the name, no "from", no flag.
- Then 1–2 short paragraphs (1–3 sentences each): what is specific and interesting about THIS piece — colour, inclusions, clarity, form, why it was cut this way, the locality. Plain, warm, a collector talking. At most one gentle line on what the stone is traditionally associated with, and only if it fits.
- Then a line with weight and size separated by " | " (leave out any that are "not given"; leave the line out if both are).
- Last line: "Available — shop now at eartheditions.co".
- No hashtags, no "link in bio", no exclamation marks, no invented facts. Reply with the caption text only.`, 600);
  return { caption: caption.replace(/^["']|["']$/g, "").trim(), made_at: new Date().toISOString() };
}

function Copy({ text, label = "Copy" }) {
  const [done, setDone] = useState(false);
  return <button style={btn(done ? C.greenBg : C.surface, done ? C.green : C.ink)} onClick={e => { e.stopPropagation(); navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }); }}>{done ? "Copied" : label}</button>;
}
function Block({ title, text, link }) {
  return (
    <div style={{ background: C.card, borderRadius: 8, padding: "10px 12px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ ...lab, marginBottom: 0, flex: 1 }}>{title}</span>
        {link && <Copy text={link} label="Copy link" />}
        <Copy text={text} />
      </div>
      <div style={{ fontSize: 13, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{text}</div>
    </div>
  );
}

function Pack({ p, site }) {
  return (
    <div style={{ marginTop: 12, maxWidth: 560 }}>
      <Block title="Instagram caption" text={p.social.caption} link={`${site}/products/${p.handle}?utm_source=instagram&utm_medium=social&utm_campaign=${encodeURIComponent(p.handle)}`} />
    </div>
  );
}

export function Replies({ site, showToast }) {
  const [where, setWhere] = useState("Reddit");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState(null);
  const draft = async () => {
    if (!text.trim()) return;
    setBusy(true); setOut(null);
    try {
      // Pieces in stock that the message is about, so the draft can point to one where that's welcome.
      const words = [...new Set(text.toLowerCase().match(/[a-z]{4,}/g) || [])].slice(0, 40);
      const { data } = await supabase.from("store_products").select("title,handle,material,shape,price,subtitle").eq("status", "active").limit(2000);
      const hits = (data || []).map(p => ({ p, n: words.filter(w => `${p.title} ${p.material} ${p.shape}`.toLowerCase().includes(w)).length })).filter(x => x.n).sort((a, b) => b.n - a.n).slice(0, 5).map(x => x.p);
      const sells = ["Instagram", "Facebook", "Etsy message", "Email"].includes(where);
      const txt = await ask(`Draft a reply on ${where} to this:\n"""${text.slice(0, 3000)}"""\n\n${hits.length ? `Pieces we have in stock that may be relevant:\n${hits.map(p => `- ${p.title}${p.subtitle ? ` (${p.subtitle})` : ""}, $${p.price}, handle ${p.handle}`).join("\n")}\n` : ""}
${sells ? "This is our own channel: it's fine to suggest one relevant piece if it genuinely fits what they asked." : "This is a community forum: help first. Only mention a piece of ours if they asked where to buy or for a recommendation, and then briefly and without a link in the reply itself."}
Keep it short and human (2-5 sentences), answer what they actually asked, and correct misinformation kindly. Reply with JSON only: {"reply":"…","suggest":"handle of the one piece worth pointing to, or empty"}`, 700);
      const j = JSON.parse(txt);
      setOut({ reply: j.reply, piece: hits.find(p => p.handle === j.suggest) || null, source: where.toLowerCase().split(" ")[0] });
    } catch (e) { showToast("⚠ " + e.message); }
    setBusy(false);
  };
  return (
    <div style={{ ...card, padding: 16, display: "grid", gap: 10 }}>
      <div><b style={{ fontSize: 15 }}>Reply helper</b><div style={{ fontSize: 12, color: C.inkFaint }}>Paste a comment, a thread or a message. You get a draft in the Earth Editions voice that knows what's in stock. Read it, change it, post it yourself.</div></div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {["Reddit", "Mindat", "Instagram", "Facebook", "Etsy message", "Email"].map(w => <button key={w} onClick={() => setWhere(w)} style={{ ...btn(where === w ? C.ink : C.surface, where === w ? "#fff" : C.ink), borderRadius: 999 }}>{w}</button>)}
      </div>
      <textarea value={text} onChange={e => setText(e.target.value)} rows={5} placeholder={where === "Reddit" ? "e.g. “Found this at a rock shop labelled moonstone but it looks like glass? How can I tell?”" : "Paste what they wrote…"} style={FI({ resize: "vertical" })} />
      <div><button onClick={draft} disabled={busy || !text.trim()} style={btn(C.ink, "#fff")}>{busy ? "Drafting…" : "Draft a reply"}</button></div>
      {out && <>
        <Block title={`Draft for ${where}`} text={out.reply} />
        {out.piece && <div style={{ fontSize: 12.5, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>Piece to point to: <b>{out.piece.title}</b> <Copy text={tagged(site, out.piece.handle, out.source, ["reddit", "mindat"].includes(out.source) ? "community" : "social")} label="Copy its link" /></div>}
        {["Reddit", "Mindat"].includes(where) && <div style={{ fontSize: 11.5, color: C.inkFaint }}>Post from your own account, and only add a link where the community's rules allow it.</div>}
      </>}
    </div>
  );
}

export default function SocialTab({ showToast, site }) {
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState({});
  const [missing, setMissing] = useState(false);
  const auto = useRef(false);
  const listings = useRef(null);
  const listingFor = async p => {
    if (!listings.current) listings.current = await loadK("ng-listings-v1").then(ls => Array.isArray(ls) ? ls : []).catch(() => []);
    return listings.current.find(l => String(l.id) === String(p.listing_id)) || {};
  };
  const load = useCallback(async () => {
    const { data, error } = await supabase.from("store_products").select("id,listing_id,handle,title,subtitle,description,material,shape,price,is_unique,weight_g,images,created_at,social").eq("status", "active").order("created_at", { ascending: false }).limit(60);
    if (error) { if (/social/.test(error.message)) setMissing(true); else showToast("⚠ " + error.message); setRows([]); return []; }
    setRows(data); return data;
  }, [showToast]);
  const make = useCallback(async p => {
    setBusy(b => ({ ...b, [p.id]: true }));
    try {
      const social = await makeCaption(p, await listingFor(p));
      const { error } = await supabase.from("store_products").update({ social }).eq("id", p.id);
      if (error) throw new Error(error.message);
      setRows(rs => rs.map(r => r.id === p.id ? { ...r, social } : r));
      return true;
    } catch (e) { showToast(`⚠ ${p.title}: ${e.message}`); return false; }
    finally { setBusy(b => ({ ...b, [p.id]: false })); }
  }, [showToast]);
  useEffect(() => {
    load().then(async data => {
      if (auto.current) return;
      auto.current = true;
      // The newest pieces without a pack get one, one after another.
      for (const p of (data || []).filter(r => !r.social?.caption).slice(0, AUTO)) if (!(await make(p))) break;
    });
  }, [load, make]);

  if (missing) return <div style={{ ...card, padding: 24, fontSize: 13.5 }}><b>The Social tab needs a database update.</b> Run <code>supabase/migrations/20261001090000_site_visitors.sql</code> in Supabase → SQL Editor (project ERP).</div>;
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ ...card, padding: "12px 14px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <div style={{ flex: 1 }}><b style={{ fontSize: 15 }}>Instagram captions</b><div style={{ fontSize: 12, color: C.inkFaint }}>Newest first, written the way you post. Captions are written by themselves for the {AUTO} newest pieces that don't have one. Locality, weight and size come from the listing; use Copy link for the story link sticker, so Visitors shows which posts bring people in.</div></div>
          <button onClick={load} style={btn()}>↻</button>
        </div>
        {!rows && <div style={{ color: C.inkFaint, fontSize: 13 }}>Loading…</div>}
        {(rows || []).map(p => (
          <div key={p.id} style={{ borderTop: `1px solid ${C.border}`, padding: "10px 0" }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", cursor: p.social?.caption ? "pointer" : "default" }} onClick={() => p.social?.caption && setOpen(open === p.id ? null : p.id)}>
              {p.images?.[0] ? <img src={p.images[0]} alt="" loading="lazy" style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 6 }} /> : <div style={{ width: 44, height: 44, background: C.card, borderRadius: 6 }} />}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.title}</div>
                <div style={{ fontSize: 11.5, color: C.inkFaint }}>on the store {new Date(p.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}{p.social?.caption ? " · caption ready" : ""}</div>
              </div>
              {busy[p.id] ? <span style={{ fontSize: 12, color: C.inkFaint }}>Writing…</span>
                : p.social?.caption ? <><button onClick={e => { e.stopPropagation(); make(p); }} style={btn()} title="Write it again">↻</button><button style={btn(open === p.id ? C.ink : C.surface, open === p.id ? "#fff" : C.ink)}>{open === p.id ? "Hide" : "Show caption"}</button></>
                : <button onClick={() => make(p)} style={btn(C.ink, "#fff")}>Write caption</button>}
            </div>
            {open === p.id && p.social?.caption && <Pack p={p} site={site} />}
          </div>
        ))}
      </div>
    </div>
  );
}
