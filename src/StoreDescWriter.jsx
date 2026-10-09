/* Store descriptions: every piece on eartheditions.co gets its own text,
   written in the journal's voice, instead of the Etsy copy it was carrying.

   Why: 911 of 930 store products had their Etsy description word for word,
   and Google shows one copy of identical text — Etsy's. A third of them also
   carried healing/energy wording, which Merchant Center disapproves.

   Each description goes in the listing's store_description (the store-only
   field, so Etsy keeps its own text) and straight onto the store product, so
   eartheditions.co shows it without a full re-publish. A description someone
   typed in the store's own editor (source.manual) is left alone. Nothing is
   saved until you've seen three samples and chosen to go on. */
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./supabase.js";
import { C, FI } from "./lmTheme.js";

const BANNED = /\b(heal\w*|chakra\w*|energ\w*|reiki|meditat\w*|metaphysic\w*|vibration\w*|aura\w*|manifest\w*|spiritual\w*|zodiac|birthstone|protect\w* (you|against)|ward\w* off|crystal grid|negativ\w*)\b/i;
const HYPE = /\b(stunning|breathtaking|must-have|magical|mesmeri[sz]ing|gorgeous|exquisite)\b|!/i;
const plain = t => String(t || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

function facts(l) {
  const dims = [l.width, l.height, l.depth].filter(v => +v > 0);
  return [
    `Title: ${l.store_title || l.title}`,
    l.material && `Stone: ${l.material}`,
    l.shape && `Shape: ${l.shape}`,
    l.size && `Size: ${l.size}`,
    l.weight && `Weight: ${l.weight}`,
    dims.length && `Dimensions: ${dims.join(" × ")} ${l.dim_unit || "mm"}`,
    l.origin && `Origin: ${l.origin}`,
    l.type === "repeatable" ? `Sold as: one of several similar pieces (${l.qty || "several"} in stock); each varies a little from the photos` : "Sold as: one of a kind — the piece in the photos is the one the buyer receives",
    `Old description (a source of facts only — do not reuse its wording, and ignore any healing or energy claims in it): ${plain(l.store_description || l.shopify_description || l.description).slice(0, 1800)}`,
  ].filter(Boolean).join("\n");
}

const PROMPT = f => `Write the product description for this piece on eartheditions.co, Earth Editions' own shop (a family business in Mumbai selling natural crystals, minerals and carvings).

Voice: the same as our journal — plain, specific, warm; British spelling ("colour"); short sentences; "we" only for the shop.

Shape: 70–120 words in two short paragraphs, plain text, no headings or bullet points.
1. What this piece is and what is notable about it as you would see it: colour, pattern, form, finish, size in the hand — only from the facts below.
2. One accurate, interesting fact about the stone itself: how it forms, where it is found, or its history. Mainstream mineralogy only; if unsure, leave it out.
End with one sentence on what the buyer receives: for a one-of-a-kind piece, that the piece in the photos is the one they receive; for one of several, that each is natural and varies a little from the photos.

Rules:
- Never invent facts about the piece: no origin, size, weight or treatment that isn't in the facts.
- No health, healing, metaphysical, spiritual, chakra, energy, meditation, zodiac or folklore claims of any kind.
- No hype ("stunning", "breathtaking", "must-have", "magical"), no exclamation marks, no emojis, no hashtags, no mention of Etsy or other shops.
- Don't copy sentences from the old description.

Facts:
${f}

Reply with the description only.`;

async function write(l, strict = false) {
  const r = await fetch("/api/claude", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4.1", max_tokens: 600, temperature: 0.6,
      messages: [{ role: "user", content: PROMPT(facts(l)) + (strict ? "\n\nYour last draft broke a rule (a health/energy word, hype or an exclamation mark). Write it again without any of that." : "") }] }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error(d.error?.message || `AI ${r.status}`);
  return String(d.content?.find(x => x.type === "text")?.text || "").replace(/^["'\s]+|["'\s]+$/g, "").trim();
}
// Written, checked, rewritten once if it slips; null if it still breaks a rule.
async function writeChecked(l) {
  for (const strict of [false, true]) {
    const t = await write(l, strict);
    const words = t.split(/\s+/).length;
    if (t && words >= 45 && words <= 170 && !BANNED.test(t) && !HYPE.test(t)) return t;
  }
  return null;
}

export default function StoreDescWriter({ listings, saveListingItem, showToast, onClose }) {
  const [products, setProducts] = useState(null);   // store_products by listing id
  const [redo, setRedo] = useState(false);          // also rewrite ones written before
  const [samples, setSamples] = useState(null);     // [{ l, text }]
  const [run, setRun] = useState(null);             // { done, total, failed: [], skipped }
  const stop = useRef(false);

  useEffect(() => {
    (async () => {
      const rows = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase.from("store_products").select("id,listing_id,status,source").range(from, from + 999);
        if (error) { showToast?.("⚠ " + error.message); break; }
        rows.push(...data);
        if (data.length < 1000) break;
      }
      const m = new Map();
      for (const p of rows) { const lid = p.listing_id || (String(p.id).startsWith("lm-") ? String(p.id).slice(3) : ""); if (lid) m.set(String(lid), p); }
      setProducts(m);
    })();
  }, [showToast]);

  // Live on the store, not protected by a hand edit there, and (unless redoing) not done yet.
  const todo = useMemo(() => !products ? [] : (listings || []).filter(l => {
    const p = products.get(String(l.id));
    if (!p || p.status !== "active") return false;
    if ((p.source?.manual || []).includes("description")) return false;
    return redo || !l.store_description_auto;
  }), [products, listings, redo]);

  const save = async (l, text) => {
    const p = products.get(String(l.id));
    await saveListingItem({ ...l, store_description: text, store_description_auto: new Date().toISOString() }, { prepend: false });
    const { error } = await supabase.from("store_products").update({ description: text, updated_at: new Date().toISOString() }).eq("id", p.id);
    if (error) throw error;
  };

  const makeSamples = async () => {
    setSamples("busy");
    const pick = [...todo].sort(() => Math.random() - .5).slice(0, 3);
    const out = [];
    for (const l of pick) {
      try { out.push({ l, text: await writeChecked(l) }); } catch (e) { out.push({ l, text: null, err: e.message }); }
    }
    setSamples(out);
  };

  const runAll = async () => {
    stop.current = false;
    // The samples you approved go first.
    const ok = (Array.isArray(samples) ? samples : []).filter(s => s.text);
    const rest = todo.filter(l => !ok.some(s => s.l.id === l.id));
    const st = { done: 0, total: ok.length + rest.length, failed: [], skipped: 0 };
    setRun({ ...st });
    for (const s of ok) { try { await save(s.l, s.text); st.done++; } catch (e) { st.failed.push(`${s.l.title}: ${e.message}`); } setRun({ ...st }); }
    let i = 0;
    const worker = async () => {
      while (i < rest.length && !stop.current) {
        const l = rest[i++];
        try {
          const text = await writeChecked(l);
          if (!text) { st.skipped++; st.failed.push(`${l.title}: kept breaking a rule, left as it was`); }
          else { await save(l, text); st.done++; }
        } catch (e) { st.failed.push(`${l.title}: ${e.message}`); }
        setRun({ ...st });
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    st.stopped = stop.current;
    setRun({ ...st, finished: true });
    showToast?.(`✓ ${st.done} store descriptions written${st.failed.length ? ` · ${st.failed.length} need a look` : ""} — live on eartheditions.co within 10 minutes`);
  };

  const btn = (bg, fg = "#fff") => ({ background: bg, color: fg, border: bg === "transparent" ? `1px solid ${C.border}` : "none", borderRadius: 8, padding: "9px 14px", fontSize: 13, fontWeight: 800, cursor: "pointer", fontFamily: "inherit" });
  return (
    <div onMouseDown={e => e.target === e.currentTarget && !run?.total && onClose()} style={{ position: "fixed", inset: 0, zIndex: 2200, background: "rgba(20,15,8,.6)", display: "grid", placeItems: "center", padding: 16 }}>
      <div style={{ background: C.bg, borderRadius: 14, width: "min(860px,100%)", maxHeight: "90vh", overflow: "auto", padding: 20, display: "grid", gap: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: C.ink, flex: 1 }}>✍ Store descriptions</div>
          {!(run && !run.finished) && <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 22, cursor: "pointer", color: C.inkMid }}>×</button>}
        </div>
        <div style={{ fontSize: 13, color: C.inkMid, lineHeight: 1.5 }}>
          Gives every piece on eartheditions.co its own description in the journal's voice — what it is, how the stone forms or where it's found, what the buyer receives — with no health or energy claims. It goes in the store-only description, so <b>Etsy keeps its own text</b>. Descriptions typed in the store's own editor are left alone.
        </div>
        {!products ? <div style={{ fontSize: 13, color: C.inkFaint }}>Reading the store…</div> : (
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", fontSize: 13 }}>
            <b>{todo.length}</b> pieces to write
            <label style={{ display: "flex", gap: 6, alignItems: "center", color: C.inkMid }}><input type="checkbox" checked={redo} onChange={e => setRedo(e.target.checked)} disabled={!!run} /> also rewrite ones written before</label>
          </div>
        )}

        {!run && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button disabled={!todo.length || samples === "busy"} onClick={makeSamples} style={btn(C.ink)}>{samples === "busy" ? "Writing 3 samples…" : Array.isArray(samples) ? "↻ 3 different samples" : "Write 3 samples first"}</button>
            {Array.isArray(samples) && <button onClick={runAll} style={btn("#1F8F4E")}>Looks right — write all {todo.length}</button>}
          </div>
        )}

        {Array.isArray(samples) && !run && samples.map(({ l, text, err }) => (
          <div key={l.id} style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: 12, background: C.surface, display: "grid", gap: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: C.ink }}>{l.store_title || l.title}</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, fontSize: 12.5, lineHeight: 1.5 }}>
              <div><div style={{ fontSize: 10, fontWeight: 800, color: C.inkFaint, letterSpacing: .5, marginBottom: 3 }}>NOW (SAME AS ETSY)</div><div style={{ color: C.inkMid, maxHeight: 180, overflow: "auto" }}>{plain(l.store_description || l.shopify_description || l.description).slice(0, 700)}</div></div>
              <div><div style={{ fontSize: 10, fontWeight: 800, color: "#1F8F4E", letterSpacing: .5, marginBottom: 3 }}>NEW, FOR EARTHEDITIONS.CO</div><div style={{ color: C.ink, whiteSpace: "pre-line" }}>{text || <span style={{ color: C.red }}>{err || "Couldn't write one that kept the rules — this piece would be left as it is."}</span>}</div></div>
            </div>
          </div>
        ))}

        {run && (
          <div style={{ display: "grid", gap: 8 }}>
            <div style={{ height: 8, background: C.card, borderRadius: 4, overflow: "hidden" }}><div style={{ height: "100%", width: `${run.total ? (run.done + run.failed.length) / run.total * 100 : 0}%`, background: "#1F8F4E", transition: "width .3s" }} /></div>
            <div style={{ fontSize: 13, color: C.ink }}>{run.done} written{run.failed.length ? ` · ${run.failed.length} need a look` : ""} · of {run.total}{run.finished ? (run.stopped ? " — stopped" : " — done") : " — keep this open"}</div>
            {!run.finished && <button onClick={() => { stop.current = true; }} style={{ ...btn("transparent", C.ink), justifySelf: "start" }}>Stop after the ones in progress</button>}
            {run.failed.length > 0 && <div style={{ fontSize: 12, color: C.inkMid, maxHeight: 160, overflow: "auto", background: C.surface, borderRadius: 8, padding: 10 }}>{run.failed.map((f, k) => <div key={k}>• {f}</div>)}</div>}
            {run.finished && <button onClick={onClose} style={{ ...btn(C.ink), justifySelf: "start" }}>Close</button>}
          </div>
        )}
      </div>
    </div>
  );
}
