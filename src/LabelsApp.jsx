/* Make Labels — name cards for a show table, a shop shelf or a box.

   One card design (the gold-ruled one first made for the Japan show): a code in
   the corner, the English name, the name in the buyers' language, the stone's
   form and origin, then quantity and price along the foot. Every card is edited
   in place, at the size it prints, and sets are saved to the ERP so any device
   can pick them up.

   It shares its parts with the Shipments module's name cards: the same label
   languages, the same fields on a stock card (labelEn, labelNames[lang],
   labelOrigin, labelShape) so a stone written up for one shipment comes in
   already named, and the same way of printing — a standalone window that
   carries its own page geometry. */
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { C } from "./ui.jsx";
import { loadK, upsertItemK, deleteItemK, uid, onCacheRefresh } from "./utils.js";
import { classify } from "./aiClient.js";

const KEY = "ng-label-sets-v1";
const FONT_LINK = "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@300;400;500&family=Noto+Serif+JP:wght@400&display=swap";
const mob = () => window.innerWidth < 700;

// The shipment labels' languages (nikhil-gems-v6.jsx LABEL_LANGS) — keep in step.
const LANGS = [
  { code: "", label: "English only", font: "" },
  { code: "ja", label: "Japanese · 日本語", font: "'Noto Serif JP','Hiragino Mincho ProN','Yu Mincho',serif", ph: "日本語名" },
  { code: "de", label: "German · Deutsch", font: "", ph: "Deutscher Name" },
  { code: "fr", label: "French · Français", font: "", ph: "Nom français" },
  { code: "es", label: "Spanish · Español", font: "", ph: "Nombre en español" },
  { code: "it", label: "Italian · Italiano", font: "", ph: "Nome italiano" },
];
const langOf = code => LANGS.find(l => l.code === code) || LANGS[0];
const PAPER = { letter: { label: "US Letter", css: "letter" }, a4: { label: "A4", css: "A4" } };
const PER_PAGE = 10;   // two across, five down: 3.5 × 1.85 in cards

const FIELDS = ["code", "en", "local", "type", "origin", "qty", "price"];
const blank = () => ({ id: uid(), code: "", en: "", local: "", type: "", origin: "", qty: "", price: "" });

// The first set: the Japan show's cards, as they were made.
const JAPAN = [
  ["", "Red Jasper", "レッドジャスパー", "Tumbles", "India", "95pcs", "¥4,500"],
  ["", "Moss Agate", "モスアゲート", "Tumbles", "India", "50pcs", "¥4,500"],
  ["", "African Unakite", "アフリカン・ユナカイト", "Tumbles", "South Africa", "64pcs", "¥4,500"],
  ["", "Labradorite", "ラブラドライト", "Tumbles", "Madagascar", "78pcs", "¥4,500"],
  ["", "Blue Tiger Eye", "ブルータイガーアイ", "Tumbles", "South Africa", "138pcs", "¥5,000"],
  ["", "Dalmatian Jasper", "ダルメシアン・ジャスパー", "Tumbles", "Chihuahua, Mexico", "79pcs", "¥6,000"],
  ["", "Sunstone", "サンストーン", "Tumbles", "India", "76pcs", "¥6,000"],
  ["", "Rainbow Moonstone", "レインボームーンストーン", "Tumbles", "India", "76pcs", "¥6,000"],
  ["", "Tiger Eye", "タイガーアイ", "Tumbles", "South Africa", "65pcs", "¥6,000"],
  ["", "Red Carnelian", "レッドカーネリアン", "Tumbles", "India", "132pcs", "¥6,000"],
  ["", "Prehnite", "プレナイト", "Tumbles", "South Africa", "62pcs", "¥6,000"],
  ["", "Owyhee Blue Opal", "オワイヒー・ブルーオパール", "Tumbles", "India", "81pcs", "¥6,000"],
  ["", "Lepidolite", "レピドライト", "Tumbles", "Brazil", "62pcs", "¥6,000"],
  ["", "Ruby Zoisite", "ルビーゾイサイト", "Tumbles", "Tanzania", "69pcs", "¥7,000"],
  ["", "Picture Jasper", "ピクチャージャスパー", "Tumbles", "USA", "90pcs", "¥7,000"],
  ["", "Citrine", "シトリン", "Tumbles", "Zambia", "53pcs", ""],
  ["", "Lapis Lazuli", "ラピスラズリ", "Bowl", "Afghanistan", "12pcs", "¥4,000"],
  ["", "Prehnite", "プレナイト", "Bowl", "South Africa", "12pcs", "¥5,000"],
  ["", "Rhodonite", "ロードナイト", "Bowl", "Australia", "12pcs", "¥5,000"],
  ["", "Tanzanian Moonstone", "タンザニア産ムーンストーン", "Bowl", "Tanzania", "12pcs", "¥6,000"],
  ["", "Blue Opal", "ブルーオパール", "Bowl", "India", "12pcs", "¥6,000"],
  ["", "Unicorn Jasper", "ユニコーン・ジャスパー", "Bowl", "Madagascar", "12pcs", "¥5,000"],
  ["", "Crazy Lace Agate", "クレイジーレースアゲート", "Bowl", "Mexico", "12pcs", "¥5,000"],
  ["", "Tiffany Stone", "ティファニーストーン", "Small Heart", "Utah, USA", "20pcs", "¥10,000"],
  ["", "Pietersite", "ピーターサイト", "Small Heart", "Namibia", "34pcs", "¥5,000"],
  ["", "Blue Lace Agate", "ブルーレースアゲート", "Mini Heart", "South Africa", "85pcs", "¥3,000"],
  ["", "Blue Lace Agate", "ブルーレースアゲート", "Sphere", "South Africa", "26pcs", "¥120/gm"],
  ["", "Blue Lace Agate", "ブルーレースアゲート", "Flat Stones", "South Africa", "20pcs", "¥3,000"],
  ["", "Malachite", "マラカイト", "Shivas", "DR Congo", "21pcs", "¥80/gm"],
  ["", "Hypersthene", "ハイパーステン", "Flat Stones", "Norway", "26pcs", "¥4,000"],
  ["", "Kunzite", "クンツァイト", "Palmstones", "Brazil", "15pcs", "¥100/gm"],
  ["", "Platinum Obsidian", "プラチナオブシディアン", "Sphere", "Mexico", "11pcs", "¥5,000"],
  ["", "Platinum Obsidian", "プラチナオブシディアン", "Palmstones", "Mexico", "26pcs", "¥2,500"],
  ["", "Mesolite", "メソライト", "Mineral Specimen", "India", "20pcs", "¥"],
  ["NG-681", "Apophyllite Stilbite", "アポフィライト・スティルバイト", "Mineral Specimen", "India", "20pcs, 1.109kg", ""],
  ["NG-377", "Green Apophyllite", "緑色アポフィライト", "Mineral Specimen", "India", "20pcs, 0.750kg", ""],
  ["NG-680", "Apophyllite Stilbite", "アポフィライト・スティルバイト", "Mineral Specimen", "India", "26pcs, 0.740kg", ""],
  ["", "Unicorn Jasper", "ユニコーン・ジャスパー", "Heart", "Madagascar", "33pcs", ""],
  ["", "Rainbow Moonstone", "レインボームーンストーン", "Heart", "India", "26pcs", ""],
  ["", "Yttrium Fluorite", "イットリウムフローライト", "Heart", "China", "50pcs", ""],
  ["", "Tanzanian Moonstone", "タンザニア産ムーンストーン", "Heart", "Tanzania", "32pcs", ""],
  ["", "Blue Opal", "ブルーオパール", "Heart", "Peru", "39pcs", "$ ___________"]
];
const japanSet = () => ({
  id: "japan-show", name: "Japan show", lang: "ja", paper: "letter",
  cards: JAPAN.map(([code, en, local, type, origin, qty, price]) => ({ id: uid(), code, en, local, type, origin, qty, price })),
  updatedAt: new Date().toISOString(),
});

/* A long name shrinks to fit its line, to 60% at the most — on screen and on
   the print sheet alike (the print window runs the same loop). */
function fit(el, base) {
  if (!el) return;
  el.style.fontSize = base + "px";
  let s = base;
  while (el.scrollWidth > el.clientWidth + 1 && s > base * 0.6) { s -= 0.5; el.style.fontSize = s + "px"; }
}

/* Uncontrolled on purpose (as in NameCard.jsx): a contentEditable React
   re-renders under the caret loses it mid-word, so text is written when the
   value changes from outside and edits commit on blur. */
function Editable({ value, onCommit, ph, className, style, onInput }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (el && document.activeElement !== el && el.innerText !== (value || "")) el.innerText = value || "";
  }, [value]);
  return (
    <div ref={ref} className={"lbl-ed " + (className || "")} style={style} contentEditable suppressContentEditableWarning spellCheck={false}
      data-ph={ph}
      onInput={onInput}
      onPaste={e => { e.preventDefault(); document.execCommand("insertText", false, e.clipboardData.getData("text").replace(/\s*\n\s*/g, " ")); }}
      onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); } }}
      onBlur={e => { const v = e.currentTarget.innerText.replace(/\s+/g, " ").trim(); e.currentTarget.innerText = v; if (v !== (value || "")) onCommit(v); }} />
  );
}

function Card({ c, lang, onPatch, onAct, index, total }) {
  const en = useRef(null), loc = useRef(null);
  const L = langOf(lang);
  const refit = useCallback(() => { fit(en.current?.querySelector(".lbl-ed"), 18); fit(loc.current?.querySelector(".lbl-ed"), 17); }, []);
  useEffect(() => { document.fonts?.ready.then(refit); refit(); }, [c.en, c.local, lang, refit]);
  const f = (k, cls, ph, style) => <Editable value={c[k]} ph={ph} className={cls} style={style} onInput={k === "en" || k === "local" ? refit : undefined} onCommit={v => onPatch({ [k]: v })} />;
  return (
    <div className="lbl-card">
      <div className="lbl-code">{f("code", "", "code")}</div>
      <div ref={en} className="lbl-line">{f("en", "lbl-en", "English name")}</div>
      {lang && <div ref={loc} className="lbl-line">{f("local", "lbl-jp", L.ph, L.font ? { fontFamily: L.font } : undefined)}</div>}
      <div className="lbl-rule1" />
      {f("type", "lbl-type", "type")}
      {f("origin", "lbl-origin", "origin")}
      <div className="lbl-rule2" />
      <div className="lbl-foot">{f("qty", "", "qty")}{f("price", "lbl-price", "price")}</div>
      <div className="lbl-ctl">
        <button title="Duplicate" onClick={() => onAct("dup")}>⧉</button>
        <button title="Move earlier" disabled={!index} onClick={() => onAct("up")}>◀</button>
        <button title="Move later" disabled={index === total - 1} onClick={() => onAct("down")}>▶</button>
        <button title="Delete" onClick={() => onAct("del")}>✕</button>
      </div>
    </div>
  );
}

const CARD_CSS = `
.lbl-card{position:relative;background:#fff;border:1px solid #cfb793;border-top:6px solid #8a6a3e;display:flex;flex-direction:column;align-items:center;padding:12px 18px 0;color:#1d1a17;font-family:"Cormorant Garamond",Garamond,serif;width:336px;height:178px;box-sizing:border-box;overflow:hidden}
.lbl-code{position:absolute;left:6px;top:3px;font-size:8px;color:#8a6a3e;min-width:10px}
.lbl-line{width:100%;display:flex;justify-content:center}
.lbl-en{font-size:18px;letter-spacing:.03em;line-height:1.15;white-space:nowrap;max-width:100%;text-align:center;min-height:21px}
.lbl-jp{font-family:"Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif;font-size:17px;letter-spacing:.04em;line-height:1.3;white-space:nowrap;max-width:100%;text-align:center;min-height:22px}
.lbl-rule1{align-self:stretch;border-top:1px solid #e2d6c4;margin-top:auto}
.lbl-type{font-size:8.5px;letter-spacing:.24em;text-transform:uppercase;color:#8a6a3e;margin-top:6px;min-height:11px;text-align:center}
.lbl-origin{font-size:8px;letter-spacing:.2em;text-transform:uppercase;color:#a29a90;margin-top:4px;min-height:10px;text-align:center}
.lbl-rule2{align-self:stretch;border-top:1px solid #e2d6c4;border-bottom:1px solid #e2d6c4;height:5px;margin-top:8px}
.lbl-foot{align-self:stretch;display:flex;justify-content:space-between;align-items:baseline;font-size:11.5px;padding:7px 0 12px;font-variant-numeric:oldstyle-nums}
.lbl-foot>div{min-width:20px}.lbl-price{text-align:right}
`;
const EDIT_CSS = `
.lbl-ed{cursor:text;border-radius:2px;outline:none}
.lbl-ed:hover{background:rgba(138,106,62,.08)}
.lbl-ed:focus{background:rgba(138,106,62,.12)}
.lbl-ed:empty::before{content:attr(data-ph);color:#c9c1b6;font-style:italic}
.lbl-ctl{position:absolute;right:4px;top:4px;display:flex;gap:3px;opacity:0;transition:opacity .15s}
.lbl-card:hover .lbl-ctl,.lbl-card:focus-within .lbl-ctl{opacity:1}
@media (hover:none){.lbl-ctl{opacity:1}}
.lbl-ctl button{padding:3px 6px;font-size:11px;border-radius:4px;background:#fff;color:#4a4036;border:1px solid #d8cfc2;cursor:pointer;line-height:1}
.lbl-ctl button:disabled{opacity:.35;cursor:default}
.lbl-sheet{width:816px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.18);margin:0 auto 24px;padding:27px 0 27px;display:grid;grid-template-columns:336px 336px;grid-auto-rows:178px;gap:7px;justify-content:center;align-content:start;min-height:1056px;box-sizing:border-box}
`;

/* The print sheet: its own document with inch geometry, the same card CSS and
   the same fit loop, so it prints what the editor shows. */
function printSet(set) {
  const L = langOf(set.lang);
  const esc = t => String(t ?? "").replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
  const pages = [];
  for (let i = 0; i < set.cards.length; i += PER_PAGE) pages.push(set.cards.slice(i, i + PER_PAGE));
  const card = c => `<div class="lbl-card"><div class="lbl-code">${esc(c.code)}</div><div class="lbl-line"><div class="lbl-en">${esc(c.en)}</div></div>${set.lang ? `<div class="lbl-line"><div class="lbl-jp"${L.font ? ` style="font-family:${L.font}"` : ""}>${esc(c.local)}</div></div>` : ""}<div class="lbl-rule1"></div><div class="lbl-type">${esc(c.type)}</div><div class="lbl-origin">${esc(c.origin)}</div><div class="lbl-rule2"></div><div class="lbl-foot"><div>${esc(c.qty)}</div><div class="lbl-price">${esc(c.price)}</div></div></div>`;
  const w = window.open("", "_blank");
  if (!w) return false;
  const paper = PAPER[set.paper] || PAPER.letter;
  w.document.write(`<!DOCTYPE html><html lang="${set.lang || "en"}"><head><meta charset="UTF-8"><title>${esc(set.name)} — labels</title>
<link href="${FONT_LINK}" rel="stylesheet"><style>${CARD_CSS}
*{box-sizing:border-box}body{margin:0;background:#e9e6e1;font-family:system-ui,sans-serif}
.bar{position:sticky;top:0;background:#fff;border-bottom:1px solid #d6d0c7;padding:10px 16px;display:flex;justify-content:space-between;align-items:center;gap:12px}
.bar b{font:500 18px "Cormorant Garamond",serif}.bar span{font-size:12px;color:#7a7268}
.bar button{background:#6f5430;color:#fff;border:0;border-radius:6px;padding:9px 16px;font-size:13px;cursor:pointer}
.sheet{width:7.3in;margin:16px auto;background:#fff;padding:.28in 0;display:grid;grid-template-columns:3.5in 3.5in;grid-auto-rows:1.854in;gap:.073in;justify-content:center;box-shadow:0 1px 3px rgba(0,0,0,.18)}
.lbl-card{width:3.5in;height:1.854in}
@page{size:${paper.css};margin:.28in .5in}
@media print{body{background:#fff}.bar{display:none}.sheet{margin:0 auto;padding:0;box-shadow:none;break-after:page}.sheet:last-child{break-after:auto}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style></head><body>
<div class="bar"><div><b>${esc(set.name)}</b> <span>· ${set.cards.length} card${set.cards.length === 1 ? "" : "s"} · ${pages.length} page${pages.length === 1 ? "" : "s"} · ${paper.label}</span></div><button onclick="window.print()">🖨 Print / Save as PDF</button></div>
${pages.map(p => `<div class="sheet">${p.map(card).join("")}</div>`).join("")}
<script>
function fit(el,base){el.style.fontSize=base+"px";var s=base;while(el.scrollWidth>el.clientWidth+1&&s>base*.6){s-=.5;el.style.fontSize=s+"px";}}
(document.fonts?document.fonts.ready:Promise.resolve()).then(function(){document.querySelectorAll(".lbl-en").forEach(function(e){fit(e,18)});document.querySelectorAll(".lbl-jp").forEach(function(e){fit(e,17)});});
</script></body></html>`);
  w.document.close();
  return true;
}

/* Stock → cards. What the shipment labels already know about a stone comes
   with it: its English and local names, origin and form. */
const stockName = s => String(s.labelEn || [s.material, s.shape].filter(Boolean).join(" ") || s.name || "").trim();
function cardFromStock(s, lang, cur) {
  const qty = parseFloat(s.qty) > 0 ? `${s.qty}${s.unit === "pcs" ? "pcs" : ` ${s.unit || ""}`.trimEnd()}` : "";
  return {
    ...blank(),
    code: s.sku || s.code || "",
    en: stockName(s),
    local: lang ? String((s.labelNames || {})[lang] ?? (lang === "ja" ? s.nameJp || "" : "")).trim() : "",
    type: String(s.labelShape || s.shape || "").trim(),
    origin: String(s.labelOrigin || s.origin || "").trim(),
    qty,
    price: +s.listPrice > 0 ? `${cur}${(+s.listPrice).toLocaleString("en-US", { maximumFractionDigits: 0 })}` : "",
    stockId: s.id,
  };
}

function StockPicker({ lang, onAdd, onClose }) {
  const [stock, setStock] = useState(null);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState(new Set());
  const [cur, setCur] = useState(lang === "ja" ? "¥" : lang && lang !== "" ? "€" : "$");
  useEffect(() => { loadK("ng-stock-v5").then(a => setStock((Array.isArray(a) ? a : []).filter(s => !s.soldDate))).catch(() => setStock([])); }, []);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const list = (stock || []).filter(s => words.every(w => `${stockName(s)} ${s.origin || ""} ${s.sku || ""} ${s.showTag || ""} ${s.location || ""}`.toLowerCase().includes(w))).slice(0, 300);
  const tog = id => setPicked(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(20,15,5,.45)", display: "flex", alignItems: mob() ? "flex-end" : "center", justifyContent: "center", padding: mob() ? 0 : 20 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: mob() ? "14px 14px 0 0" : 12, width: "100%", maxWidth: 680, maxHeight: "88vh", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "14px 18px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 10 }}>
          <b style={{ fontFamily: "'Cormorant Garamond',serif", fontSize: 20, flex: 1 }}>Add from Stock</b>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer" }}>×</button>
        </div>
        <div style={{ padding: "10px 18px", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", borderBottom: `1px solid ${C.border}` }}>
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search stone, origin, show, box…" style={{ flex: 1, minWidth: 180, padding: "8px 11px", border: `1px solid ${C.border}`, borderRadius: 7, fontSize: 13 }} />
          <label style={{ fontSize: 12.5, color: C.inkMid }}>Price in <select value={cur} onChange={e => setCur(e.target.value)} style={{ padding: "5px 6px", borderRadius: 6, border: `1px solid ${C.border}` }}>{["$", "¥", "€", "£", "₹"].map(x => <option key={x}>{x}</option>)}</select></label>
        </div>
        <div style={{ overflowY: "auto", flex: 1, padding: "4px 18px" }}>
          {!stock && <div style={{ padding: 16, color: C.inkFaint, fontSize: 13 }}>Loading stock…</div>}
          {list.map(s => (
            <label key={s.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${C.border}`, cursor: "pointer", fontSize: 13 }}>
              <input type="checkbox" checked={picked.has(s.id)} onChange={() => tog(s.id)} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{stockName(s) || "—"}</div>
                <div style={{ fontSize: 11.5, color: C.inkFaint }}>{[s.origin, s.qty ? `${s.qty} ${s.unit || ""}` : "", s.showTag, s.location ? `Box ${s.location}` : ""].filter(Boolean).join(" · ")}</div>
              </div>
              {+s.listPrice > 0 && <span style={{ fontSize: 12, color: C.inkMid }}>${(+s.listPrice).toLocaleString("en-US")}</span>}
            </label>
          ))}
        </div>
        <div style={{ padding: "12px 18px", borderTop: `1px solid ${C.border}`, display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 12.5, color: C.inkMid, marginRight: "auto" }}>{picked.size} ticked</span>
          <button onClick={onClose} style={btn()}>Cancel</button>
          <button disabled={!picked.size} onClick={() => onAdd((stock || []).filter(s => picked.has(s.id)).map(s => cardFromStock(s, lang, cur)))} style={btn(true)}>Add {picked.size || ""} card{picked.size === 1 ? "" : "s"}</button>
        </div>
      </div>
    </div>
  );
}

const btn = (primary = false) => ({ background: primary ? "#6f5430" : "#f4f2ee", color: primary ? "#fff" : "#2a2622", border: `1px solid ${primary ? "#6f5430" : "#d6d0c7"}`, borderRadius: 6, padding: "8px 13px", fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: "system-ui,sans-serif", whiteSpace: "nowrap" });

export default function LabelsApp({ onHome }) {
  /* The sets live here and change synchronously, so two quick edits (blur one
     field, type in the next) both land; each change is then saved in order. */
  const [sets, setSets] = useState(null);
  const setsRef = useRef(null);
  const [openId, setOpenId] = useState(null);
  const openRef = useRef(null);
  openRef.current = openId;
  const chain = useRef(Promise.resolve());
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState("");
  const [toast, setToast] = useState("");
  const say = m => { setToast(m); setTimeout(() => setToast(""), 3500); };
  useEffect(() => {
    if (!document.querySelector(`link[href="${FONT_LINK}"]`)) { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = FONT_LINK; document.head.appendChild(l); }
  }, []);
  const put = next => { setsRef.current = next; setSets(next); };
  useEffect(() => {
    const load = () => loadK(KEY).then(v => {
      const arr = Array.isArray(v) ? v : [];
      // Another device's changes come in, except to the set open here.
      const open = setsRef.current?.find(x => x.id === openRef.current);
      put(open ? arr.map(x => x.id === open.id ? open : x) : arr);
      return arr;
    });
    // First visit: start with the Japan show's cards.
    load().then(arr => { if (!arr.length) saveSet(japanSet()); }).catch(() => put([]));
    return onCacheRefresh(keys => { if (keys.includes(KEY)) load().catch(() => {}); });
  }, []);

  const list = sets || [];
  const set = list.find(s => s.id === openId);
  // Saves are per set, so two people on two sets never overwrite each other.
  function saveSet(next) {
    next = { ...next, updatedAt: new Date().toISOString() };
    const cur = setsRef.current || [];
    put(cur.some(x => x.id === next.id) ? cur.map(x => x.id === next.id ? next : x) : [next, ...cur]);
    chain.current = chain.current.then(() => upsertItemK(KEY, next)).catch(e => say("⚠ Not saved: " + e.message));
    return chain.current;
  }
  const current = () => (setsRef.current || []).find(s => s.id === openRef.current);
  const patchSet = p => { const s0 = current(); if (s0) saveSet({ ...s0, ...p }); };
  const patchCard = (id, p) => { const s0 = current(); if (s0) saveSet({ ...s0, cards: s0.cards.map(c => c.id === id ? { ...c, ...p } : c) }); };
  const act = (i, a) => {
    const cards = [...current().cards];
    if (a === "dup") cards.splice(i + 1, 0, { ...cards[i], id: uid() });
    if (a === "up" && i > 0) [cards[i - 1], cards[i]] = [cards[i], cards[i - 1]];
    if (a === "down" && i < cards.length - 1) [cards[i + 1], cards[i]] = [cards[i], cards[i + 1]];
    if (a === "del") { if (!window.confirm(`Delete "${cards[i].en || "this card"}"?`)) return; cards.splice(i, 1); }
    patchSet({ cards });
  };
  const newSet = () => { const s = { id: uid(), name: "New labels", lang: "", paper: "letter", cards: [blank()], updatedAt: new Date().toISOString() }; saveSet(s); setOpenId(s.id); };
  const copySet = s => { const c = { ...s, id: uid(), name: `${s.name} (copy)`, cards: s.cards.map(x => ({ ...x, id: uid() })) }; saveSet(c); say("Copied"); };
  const removeSet = s => {
    if (!window.confirm(`Delete the label set "${s.name}"?`)) return;
    put((setsRef.current || []).filter(x => x.id !== s.id));
    chain.current = chain.current.then(() => deleteItemK(KEY, s.id)).catch(e => say("⚠ " + e.message));
  };

  /* AI: the local-language name and the origin for cards that lack them, one
     request for the whole set (as the shipment cards do). */
  const aiFill = async () => {
    const L = langOf(set.lang);
    const todo = set.cards.map((c, i) => ({ c, i })).filter(({ c }) => c.en && ((set.lang && !c.local) || !c.origin));
    if (!todo.length) return say("Every card already has its names and origin");
    setBusy("ai");
    try {
      const lines = todo.map(({ c }, n) => `${n + 1}. name="${c.en}" type="${c.type}" origin="${c.origin}"`).join("\n");
      const raw = await classify(`These are display cards for stones on a mineral dealer's table. For each numbered stone return one object.
${lines}

"local": ${set.lang ? `the stone's name in ${L.label.split(" · ")[0]} as a mineral dealer in that country would label it (for Japanese, katakana with a ・ between words where natural, e.g. ブルーレースアゲート). The stone name only — not the type.` : `""`}
"origin": the origin given if any, otherwise the country it most commonly comes from, in plain title case ("South Africa").
Return ONLY a JSON array of ${todo.length} objects in order, each {"local":"...","origin":"..."}. No fences.`, 300 + todo.length * 60);
      const out = JSON.parse(raw.replace(/```json|```/g, "").trim());
      const cards = [...set.cards];
      todo.forEach(({ c, i }, n) => {
        const r = out[n] || {};
        cards[i] = { ...c, local: c.local || (set.lang ? String(r.local || "").trim() : ""), origin: c.origin || String(r.origin || "").trim() };
      });
      const now = current();   // edits made while the AI was working stay
      const byId = Object.fromEntries(cards.map(c => [c.id, c]));
      await saveSet({ ...now, cards: now.cards.map(c => byId[c.id] ? { ...c, local: c.local || byId[c.id].local, origin: c.origin || byId[c.id].origin } : c) });
      say(`✓ Filled ${todo.length} card${todo.length === 1 ? "" : "s"} — check them before printing`);
    } catch (e) { say("⚠ AI fill failed: " + e.message); }
    setBusy("");
  };

  const zoom = Math.min(1, (window.innerWidth - 24) / 816);

  return (
    <div style={{ minHeight: "100vh", background: "#e9e6e1", color: "#2a2622" }}>
      <style>{CARD_CSS + EDIT_CSS}</style>
      {toast && <div style={{ position: "fixed", bottom: 20, left: "50%", transform: "translateX(-50%)", zIndex: 1100, background: "#2a2622", color: "#fff", padding: "10px 18px", borderRadius: 6, fontSize: 13 }}>{toast}</div>}
      <div style={{ position: "sticky", top: 0, zIndex: 20, background: "#fff", borderBottom: "1px solid #d6d0c7", padding: "10px 16px", display: "flex", flexWrap: "wrap", gap: "10px 14px", alignItems: "center" }}>
        <button onClick={set ? () => setOpenId(null) : onHome} style={{ ...btn(), background: "none", border: "none", color: "#7a7268", paddingLeft: 0 }}>← {set ? "All labels" : "Home"}</button>
        {set ? (
          <>
            <input key={set.id} defaultValue={set.name} onKeyDown={e => e.key === "Enter" && e.currentTarget.blur()} style={{ font: "500 20px 'Cormorant Garamond',serif", border: "1px solid transparent", borderRadius: 6, padding: "2px 6px", minWidth: 120, flex: mob() ? "1 1 100%" : "0 1 260px" }} onFocus={e => e.target.style.borderColor = "#d6d0c7"} onBlur={e => { e.target.style.borderColor = "transparent"; const v = e.target.value.trim() || "Labels"; if (v !== set.name) patchSet({ name: v }); }} />
            <select value={set.lang} onChange={e => patchSet({ lang: e.target.value })} style={{ ...btn(), padding: "7px 8px" }} title="Second line on each card">{LANGS.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}</select>
            <select value={set.paper} onChange={e => patchSet({ paper: e.target.value })} style={{ ...btn(), padding: "7px 8px" }}>{Object.entries(PAPER).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}</select>
            <div style={{ flex: 1 }} />
            <button onClick={() => patchSet({ cards: [...current().cards, blank()] })} style={btn()}>＋ Card</button>
            <button onClick={() => setPicker(true)} style={btn()}>＋ From Stock</button>
            <button onClick={aiFill} disabled={!!busy} style={btn()}>{busy === "ai" ? "Filling…" : "✨ AI fill names"}</button>
            <button onClick={() => { if (!printSet(set)) say("Allow pop-ups to open the print sheet"); }} style={btn(true)}>🖨 Print / PDF</button>
          </>
        ) : (
          <>
            <div><div style={{ font: "500 22px 'Cormorant Garamond',serif" }}>Make Labels</div><div style={{ fontSize: 12, color: "#7a7268" }}>Name cards for shows, shelves and boxes · 10 to a page</div></div>
            <div style={{ flex: 1 }} />
            <button onClick={newSet} style={btn(true)}>＋ New label set</button>
          </>
        )}
      </div>

      {!set && (
        <div style={{ maxWidth: 820, margin: "18px auto", padding: "0 14px", display: "grid", gap: 10 }}>
          {!sets && <div style={{ color: "#7a7268", fontSize: 13 }}>Loading…</div>}
          {list.map(s => (
            <div key={s.id} onClick={() => setOpenId(s.id)} style={{ background: "#fff", border: "1px solid #d6d0c7", borderRadius: 10, padding: "12px 16px", display: "flex", gap: 12, alignItems: "center", cursor: "pointer" }}>
              <div style={{ width: 54, height: 30, border: "1px solid #cfb793", borderTop: "4px solid #8a6a3e", background: "#fff", flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ font: "500 18px 'Cormorant Garamond',serif" }}>{s.name}</div>
                <div style={{ fontSize: 12, color: "#7a7268" }}>{s.cards.length} card{s.cards.length === 1 ? "" : "s"} · {langOf(s.lang).label} · {(PAPER[s.paper] || PAPER.letter).label}</div>
              </div>
              <button onClick={e => { e.stopPropagation(); copySet(s); }} style={btn()} title="Make a copy">⧉</button>
              <button onClick={e => { e.stopPropagation(); if (!printSet(s)) say("Allow pop-ups to open the print sheet"); }} style={btn()} title="Print">🖨</button>
              <button onClick={e => { e.stopPropagation(); removeSet(s); }} style={{ ...btn(), color: "#9b2c2c" }} title="Delete">✕</button>
            </div>
          ))}
        </div>
      )}

      {set && (
        <>
          <p style={{ fontSize: 12.5, color: "#7a7268", maxWidth: 816, margin: "12px auto 0", padding: "0 16px", fontFamily: "system-ui,sans-serif" }}>
            Click any text on a card to change it. Hover a card to copy, move or delete it. Saved as you go · {set.cards.length} cards on {Math.max(1, Math.ceil(set.cards.length / PER_PAGE))} page{set.cards.length > PER_PAGE ? "s" : ""}.
          </p>
          <div style={{ overflowX: "auto", padding: "14px 0 40px" }}>
            <div style={{ width: 816, margin: "0 auto", zoom }}>
              {Array.from({ length: Math.max(1, Math.ceil(set.cards.length / PER_PAGE)) }, (_, p) => (
                <div key={p} className="lbl-sheet">
                  {set.cards.slice(p * PER_PAGE, p * PER_PAGE + PER_PAGE).map((c, k) => {
                    const i = p * PER_PAGE + k;
                    return <Card key={c.id} c={c} lang={set.lang} index={i} total={set.cards.length} onPatch={pp => patchCard(c.id, pp)} onAct={a => act(i, a)} />;
                  })}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
      {picker && set && <StockPicker lang={set.lang} onClose={() => setPicker(false)} onAdd={cards => { patchSet({ cards: [...current().cards.filter(c => c.en || c.local || c.price), ...cards] }); setPicker(false); say(`✓ ${cards.length} card${cards.length === 1 ? "" : "s"} added`); }} />}
    </div>
  );
}
