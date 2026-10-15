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
/* Card sizes, chosen per set. Each fits Letter and A4 with the sheet's margins;
   k scales everything on the card (type, rules, padding) to suit. */
const SIZES = {
  s10: { label: "Small · 10 a page (3.5 × 1.85 in)", w: 3.5, h: 1.854, cols: 2, rows: 5, k: 1 },
  s8:  { label: "Medium · 8 a page (3.5 × 2.45 in)", w: 3.5, h: 2.45, cols: 2, rows: 4, k: 1.25 },
  s6:  { label: "Large · 6 a page (3.5 × 3.25 in)", w: 3.5, h: 3.25, cols: 2, rows: 3, k: 1.5 },
  s4:  { label: "Extra large · 4 a page (3.5 × 4.9 in)", w: 3.5, h: 4.9, cols: 2, rows: 2, k: 1.85 },
  s2:  { label: "Shelf card · 2 a page (7 × 4.9 in)", w: 7, h: 4.9, cols: 1, rows: 2, k: 2.5 },
};
// On top of the card size, the writing itself can be set larger or smaller.
const TEXT = [["0.85", "Smaller text"], ["1", "Normal text"], ["1.2", "Larger text"], ["1.4", "Largest text"]];
/* Any other size: typed in inches. As many go on a page as fit inside the
   sheet's printable area (7.3 × 10.4 in on Letter, the tighter of the two
   papers); the type grows with the card the way the set sizes do. */
const clampIn = (v, lo, hi, d) => Math.min(hi, Math.max(lo, +v || d));
const geom = set => {
  let z = SIZES[set?.size];
  if (set?.size === "custom") {
    const w = clampIn(set.cw, 1.5, 7.3, 3.5), h = clampIn(set.ch, 1, 10.4, 1.854);
    const cols = Math.max(1, Math.floor((7.3 + 0.073) / (w + 0.073))), rows = Math.max(1, Math.floor((10.4 + 0.073) / (h + 0.073)));
    z = { w, h, cols, rows, k: Math.max(0.75, Math.min(w / 3.5, h / 1.854) ** 0.7) };
  }
  z = z || SIZES.s10;
  const L = layoutOf(set);
  return { ...z, k: z.k * (+set?.text || 1), per: z.cols * z.rows, kn: L.name.s, kl: L.local.s };
};

/* Where things sit on the card and how big each is, per set: every part has
   its own size (a share of the card's own), the name and the type lines can
   sit left, centred or right, the name at the top or in the middle, and any
   part can be left off. */
const PARTS = [["name", "Name"], ["local", "Second-language name"], ["type", "Type"], ["origin", "Origin"], ["foot", "Qty & price"], ["code", "Code"]];
const SCALES = [0.7, 0.85, 1, 1.2, 1.4, 1.7, 2, 2.5];
const LAYOUT0 = { name: { s: 1, align: "center", pos: "top", show: true }, local: { s: 1, show: true }, type: { s: 1, align: "center", show: true }, origin: { s: 1, show: true }, foot: { s: 1, show: true }, code: { s: 1, show: true } };
function layoutOf(set) {
  const l = set?.layout || {};
  return Object.fromEntries(Object.entries(LAYOUT0).map(([k, d]) => [k, { ...d, ...(l[k] || {}) }]));
}
function layoutCss(set) {
  const L = layoutOf(set);
  const ta = a => (a === "left" ? "left" : a === "right" ? "right" : "center");
  const jc = a => (a === "left" ? "flex-start" : a === "right" ? "flex-end" : "center");
  return `
.lbl-card{--kn:${L.name.s};--kl:${L.local.s};--kt:${L.type.s};--ko:${L.origin.s};--kf:${L.foot.s};--kc:${L.code.s}}
.lbl-line{justify-content:${jc(L.name.align)}}.lbl-en,.lbl-jp{text-align:${ta(L.name.align)}}
.lbl-type,.lbl-origin{align-self:stretch;text-align:${ta(L.type.align)}}
${L.name.pos === "middle" ? ".lbl-code+.lbl-line{margin-top:auto}" : ""}
${L.name.show ? "" : ".lbl-code+.lbl-line{display:none}"}
${L.local.show ? "" : ".lbl-code+.lbl-line+.lbl-line{display:none}"}
${L.type.show ? "" : ".lbl-type{display:none}"}${L.origin.show ? "" : ".lbl-origin{display:none}"}
${L.foot.show ? "" : ".lbl-rule2,.lbl-foot{display:none}"}${L.code.show ? "" : ".lbl-code{display:none}"}
${L.type.show || L.origin.show ? "" : ".lbl-rule1{border-top:0}"}`;
}

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

/* A long name wraps onto a second line, and only past two lines (or a single
   word too wide for the card) does it shrink, to 60% at the most — on screen
   and on the print sheet alike (the print window runs the same loop). */
function fit(el, base) {
  if (!el) return;
  el.style.fontSize = base + "px";
  let s = base;
  const over = () => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > s * 1.3 * 2 + 2;
  while (over() && s > base * 0.6) { s -= 0.5; el.style.fontSize = s + "px"; }
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

function Card({ c, lang, onPatch, onAct, index, total, g }) {
  const en = useRef(null), loc = useRef(null);
  const L = langOf(lang);
  const refit = useCallback(() => { fit(en.current?.querySelector(".lbl-ed"), 18 * g.k * g.kn); fit(loc.current?.querySelector(".lbl-ed"), 17 * g.k * g.kl); }, [g.k, g.kn, g.kl]);
  useEffect(() => { document.fonts?.ready.then(refit); refit(); }, [c.en, c.local, lang, refit, g.w, g.h]);
  const f = (k, cls, ph, style) => <Editable value={c[k]} ph={ph} className={cls} style={style} onInput={k === "en" || k === "local" ? refit : undefined} onCommit={v => onPatch({ [k]: v })} />;
  return (
    <div className="lbl-card" style={{ "--k": g.k, width: g.w * 96, height: g.h * 96 }}>
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

/* Bulk edit: every card as a row to type in, and one change made across many
   at once — set a field, find and replace in it, or add to its start or end —
   on the ticked cards, or all of them when none are ticked. */
function BulkTable({ set, onCards, say }) {
  const L = langOf(set.lang);
  const cols = [["code", "Code"], ["en", "Name"], ...(set.lang ? [["local", L.label || "Second name"]] : []), ["type", "Type"], ["origin", "Origin"], ["qty", "Qty"], ["price", "Price"]];
  const [sel, setSel] = useState(() => new Set());
  const [field, setField] = useState("price"), [mode, setMode] = useState("set"), [a, setA] = useState(""), [b, setB] = useState("");
  const live = new Set(set.cards.map(c => c.id));
  const picked = [...sel].filter(id => live.has(id));
  const targets = picked.length ? new Set(picked) : live;
  const apply = () => {
    if (mode === "replace" && !a) return say("Type what to find first");
    let n = 0;
    onCards(cards => cards.map(c => {
      if (!targets.has(c.id)) return c;
      const v = String(c[field] || "");
      const nv = mode === "set" ? a : mode === "replace" ? v.split(a).join(b) : mode === "prefix" ? a + v : v + a;
      if (nv === v) return c;
      n++; return { ...c, [field]: nv };
    }));
    say(`✓ ${n} card${n === 1 ? "" : "s"} changed`);
  };
  const cell = { border: "1px solid #e4ddd2", padding: 0 };
  const inp = { width: "100%", border: 0, padding: "7px 8px", fontSize: 13, fontFamily: "system-ui,sans-serif", background: "transparent", boxSizing: "border-box" };
  const label = cols.find(([k]) => k === field)?.[1] || field;
  return (
    <div style={{ maxWidth: 1100, margin: "12px auto 40px", padding: "0 12px", fontFamily: "system-ui,sans-serif" }}>
      <div style={{ background: "#fff", border: "1px solid #d6d0c7", borderRadius: 10, padding: 12, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", fontSize: 13, marginBottom: 10 }}>
        <b style={{ fontWeight: 600 }}>Change</b>
        <select value={field} onChange={e => setField(e.target.value)} style={{ ...btn(), padding: "6px 6px" }}>{cols.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <select value={mode} onChange={e => setMode(e.target.value)} style={{ ...btn(), padding: "6px 6px" }}>
          <option value="set">set to</option><option value="replace">find & replace</option><option value="prefix">add at start</option><option value="suffix">add at end</option>
        </select>
        <input value={a} onChange={e => setA(e.target.value)} placeholder={mode === "replace" ? "find" : mode === "set" ? `new ${label.toLowerCase()} (blank clears it)` : "text"} style={{ ...btn(), padding: "6px 8px", minWidth: 150, cursor: "text" }} />
        {mode === "replace" && <input value={b} onChange={e => setB(e.target.value)} placeholder="replace with" style={{ ...btn(), padding: "6px 8px", minWidth: 130, cursor: "text" }} />}
        <button onClick={apply} style={btn(true)}>Apply to {picked.length ? `${picked.length} ticked` : `all ${set.cards.length}`}</button>
        {picked.length > 0 && <>
          <button onClick={() => setSel(new Set())} style={btn()}>Untick</button>
          <button onClick={() => { if (!confirm(`Delete ${picked.length} card${picked.length === 1 ? "" : "s"}?`)) return; onCards(cards => cards.filter(c => !targets.has(c.id))); setSel(new Set()); }} style={{ ...btn(), color: "#9b2c2c" }}>Delete ticked</button>
        </>}
      </div>
      <div style={{ overflowX: "auto", background: "#fff", border: "1px solid #d6d0c7", borderRadius: 10 }}>
        <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 760 }}>
          <thead><tr style={{ background: "#f4f2ee", fontSize: 11.5, textTransform: "uppercase", letterSpacing: ".05em", color: "#7a7268" }}>
            <th style={{ ...cell, width: 34, padding: 6 }}><input type="checkbox" checked={picked.length === set.cards.length && set.cards.length > 0} onChange={e => setSel(e.target.checked ? new Set(live) : new Set())} /></th>
            <th style={{ ...cell, width: 30, padding: 6 }}>#</th>
            {cols.map(([k, l]) => <th key={k} style={{ ...cell, padding: "6px 8px", textAlign: "left", fontWeight: 600 }}>{l}</th>)}
          </tr></thead>
          <tbody>{set.cards.map((c, i) => (
            <tr key={c.id} style={{ background: sel.has(c.id) ? "#f7f1e6" : "#fff" }}>
              <td style={{ ...cell, textAlign: "center" }}><input type="checkbox" checked={sel.has(c.id)} onChange={e => setSel(s0 => { const n = new Set(s0); e.target.checked ? n.add(c.id) : n.delete(c.id); return n; })} /></td>
              <td style={{ ...cell, textAlign: "center", fontSize: 12, color: "#7a7268" }}>{i + 1}</td>
              {cols.map(([k]) => (
                <td key={k} style={{ ...cell, minWidth: k === "en" || k === "local" ? 200 : k === "code" ? 80 : 110 }}>
                  <input key={`${c.id}:${k}:${c[k] || ""}`} defaultValue={c[k] || ""} style={inp}
                    onKeyDown={e => e.key === "Enter" && e.currentTarget.blur()}
                    onBlur={e => { const v = e.target.value.trim(); if (v !== (c[k] || "")) onCards(cards => cards.map(x => x.id === c.id ? { ...x, [k]: v } : x)); }} />
                </td>
              ))}
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

const CARD_CSS = `
.lbl-card{--k:1;position:relative;background:#fff;border:1px solid #cfb793;border-top:calc(6px*var(--k)) solid #8a6a3e;display:flex;flex-direction:column;align-items:center;padding:calc(12px*var(--k)) calc(18px*var(--k)) 0;color:#1d1a17;font-family:"Cormorant Garamond",Garamond,serif;width:336px;height:178px;box-sizing:border-box;overflow:hidden}
.lbl-code{position:absolute;left:6px;top:3px;font-size:calc(8px*var(--k)*var(--kc,1));color:#8a6a3e;min-width:10px}
.lbl-line{width:100%;display:flex;justify-content:center}
.lbl-en{font-size:calc(18px*var(--k)*var(--kn,1));letter-spacing:.03em;line-height:1.15;white-space:normal;overflow-wrap:break-word;width:100%;max-width:100%;text-align:center;min-height:calc(21px*var(--k)*var(--kn,1))}
.lbl-jp{font-family:"Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif;font-size:calc(17px*var(--k)*var(--kl,1));letter-spacing:.04em;line-height:1.3;white-space:nowrap;max-width:100%;text-align:center;min-height:calc(22px*var(--k)*var(--kl,1))}
.lbl-rule1{align-self:stretch;border-top:1px solid #e2d6c4;margin-top:auto}
.lbl-type{font-size:calc(8.5px*var(--k)*var(--kt,1));letter-spacing:.24em;text-transform:uppercase;color:#8a6a3e;margin-top:calc(6px*var(--k));min-height:calc(11px*var(--k));text-align:center}
.lbl-origin{font-size:calc(8px*var(--k)*var(--ko,1));letter-spacing:.2em;text-transform:uppercase;color:#a29a90;margin-top:calc(4px*var(--k));min-height:calc(10px*var(--k));text-align:center}
.lbl-rule2{align-self:stretch;border-top:1px solid #e2d6c4;border-bottom:1px solid #e2d6c4;height:calc(5px*var(--k));margin-top:calc(8px*var(--k))}
.lbl-foot{align-self:stretch;display:flex;justify-content:space-between;align-items:baseline;font-size:calc(11.5px*var(--k)*var(--kf,1));padding:calc(7px*var(--k)) 0 calc(12px*var(--k));font-variant-numeric:oldstyle-nums}
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
  const g = geom(set);
  for (let i = 0; i < set.cards.length; i += g.per) pages.push(set.cards.slice(i, i + g.per));
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
.sheet{width:7.3in;margin:16px auto;background:#fff;padding:.28in 0;display:grid;grid-template-columns:repeat(${g.cols},${g.w}in);grid-auto-rows:${g.h}in;gap:.073in;justify-content:center;box-shadow:0 1px 3px rgba(0,0,0,.18)}
.lbl-card{--k:${g.k};width:${g.w}in;height:${g.h}in}
${layoutCss(set)}
@page{size:${paper.css};margin:.28in .5in}
@media print{body{background:#fff}.bar{display:none}.sheet{margin:0 auto;padding:0;box-shadow:none;break-after:page}.sheet:last-child{break-after:auto}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style></head><body>
<div class="bar"><div><b>${esc(set.name)}</b> <span>· ${set.cards.length} card${set.cards.length === 1 ? "" : "s"} · ${pages.length} page${pages.length === 1 ? "" : "s"} · ${paper.label}</span></div><button onclick="window.print()">🖨 Print / Save as PDF</button></div>
${pages.map(p => `<div class="sheet">${p.map(card).join("")}</div>`).join("")}
<script>
function fit(el,base){el.style.fontSize=base+"px";var s=base;function over(){return el.scrollWidth>el.clientWidth+1||el.scrollHeight>s*1.3*2+2}while(over()&&s>base*.6){s-=.5;el.style.fontSize=s+"px";}}
(document.fonts?document.fonts.ready:Promise.resolve()).then(function(){document.querySelectorAll(".lbl-en").forEach(function(e){fit(e,${18 * g.k * g.kn})});document.querySelectorAll(".lbl-jp").forEach(function(e){fit(e,${17 * g.k * g.kl})});});
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

/* A box is written "STK65", "65" or "stk 065" across the stock; any of them
   finds it. Named places (Cupboard 1, Room 2) match as typed. */
const boxKey = v => { const t = String(v || "").trim().toLowerCase().replace(/\s+/g, " "); const m = t.match(/^(?:stk|box)?\s*0*(\d+)$/); return m ? m[1] : t; };

function StockPicker({ lang, onAdd, onClose, boxFirst = false }) {
  const [stock, setStock] = useState(null);
  const [q, setQ] = useState("");
  const [box, setBox] = useState("");
  const [picked, setPicked] = useState(new Set());
  const [cur, setCur] = useState(lang === "ja" ? "¥" : lang && lang !== "" ? "€" : "$");
  useEffect(() => { loadK("ng-stock-v5").then(a => setStock((Array.isArray(a) ? a : []).filter(s => !s.soldDate))).catch(() => setStock([])); }, []);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const inBox = box.trim() ? (stock || []).filter(s => s.location && boxKey(s.location) === boxKey(box)) : null;
  const list = (inBox || stock || []).filter(s => words.every(w => `${stockName(s)} ${s.origin || ""} ${s.sku || ""} ${s.showTag || ""} ${s.location || ""}`.toLowerCase().includes(w))).slice(0, 300);
  const tog = id => setPicked(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(20,15,5,.45)", display: "flex", alignItems: mob() ? "flex-end" : "center", justifyContent: "center", padding: mob() ? 0 : 20 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: mob() ? "14px 14px 0 0" : 12, width: "100%", maxWidth: 680, maxHeight: "88vh", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "14px 18px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 10 }}>
          <b style={{ fontFamily: "'Cormorant Garamond',serif", fontSize: 20, flex: 1 }}>Add from Stock</b>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer" }}>×</button>
        </div>
        <div style={{ padding: "10px 18px", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", borderBottom: `1px solid ${C.border}` }}>
          <input autoFocus={boxFirst} value={box} onChange={e => setBox(e.target.value)} placeholder="Box no. e.g. 65" style={{ width: 120, padding: "8px 11px", border: `1px solid ${box ? "#8a6a3e" : C.border}`, borderRadius: 7, fontSize: 13, fontWeight: box ? 600 : 400 }} />
          <input autoFocus={!boxFirst} value={q} onChange={e => setQ(e.target.value)} placeholder="Search stone, origin, show…" style={{ flex: 1, minWidth: 160, padding: "8px 11px", border: `1px solid ${C.border}`, borderRadius: 7, fontSize: 13 }} />
          <label style={{ fontSize: 12.5, color: C.inkMid }}>Price in <select value={cur} onChange={e => setCur(e.target.value)} style={{ padding: "5px 6px", borderRadius: 6, border: `1px solid ${C.border}` }}>{["$", "¥", "€", "£", "₹"].map(x => <option key={x}>{x}</option>)}</select></label>
        </div>
        <div style={{ overflowY: "auto", flex: 1, padding: "4px 18px" }}>
          {!stock && <div style={{ padding: 16, color: C.inkFaint, fontSize: 13 }}>Loading stock…</div>}
          {inBox && <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 0", borderBottom: `1px solid ${C.border}`, fontSize: 13 }}>
            <span style={{ flex: 1 }}>{inBox.length ? <><b>{inBox.length}</b> in box {box.trim()}{[...new Set(inBox.map(s => s.location))].length > 1 ? ` (${[...new Set(inBox.map(s => s.location))].join(", ")})` : ""}</> : <span style={{ color: C.inkFaint }}>Nothing in box {box.trim()}</span>}</span>
            {inBox.length > 0 && <button onClick={() => onAdd(inBox.map(s => cardFromStock(s, lang, cur)))} style={btn(true)}>Make all {inBox.length} labels</button>}
          </div>}
          {list.map(s => (
            <label key={s.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${C.border}`, cursor: "pointer", fontSize: 13 }}>
              <input type="checkbox" checked={picked.has(s.id)} onChange={() => tog(s.id)} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{stockName(s) || "—"}</div>
                <div style={{ fontSize: 11.5, color: C.inkFaint }}>{[s.origin, s.qty ? `${s.qty} ${s.unit || ""}` : "", s.showTag, s.location ? (/^(stk|box)?\s*\d+$/i.test(s.location) ? `Box ${s.location}` : s.location) : ""].filter(Boolean).join(" · ")}</div>
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
  const [picker, setPicker] = useState(false);   // false | "stock" | "box"
  const [showLayout, setShowLayout] = useState(false);
  const [bulk, setBulk] = useState(false);
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
    load().then(async arr => {
      if (!arr.length) saveSet(japanSet());
      /* Sent here from a show's Shipment tab: its cards become a new set. */
      let pending = null;
      try { pending = JSON.parse(localStorage.getItem("ng-labels-pending") || "null"); localStorage.removeItem("ng-labels-pending"); } catch { /* none */ }
      if (pending?.stockIds?.length) {
        const all = await loadK("ng-stock-v5").catch(() => []);
        const ids = new Set(pending.stockIds);
        const cur = pending.lang === "ja" ? "¥" : "$";
        const cards = (Array.isArray(all) ? all : []).filter(x => ids.has(x.id)).map(x => cardFromStock(x, pending.lang || "", cur));
        if (cards.length) {
          const s0 = { id: uid(), name: pending.name || "Show labels", lang: pending.lang || "", paper: "letter", cards, updatedAt: new Date().toISOString() };
          saveSet(s0); setOpenId(s0.id); say(`✓ ${cards.length} labels from ${s0.name}`);
        }
      }
    }).catch(() => put([]));
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
  const g = geom(set);

  return (
    <div style={{ minHeight: "100vh", background: "#e9e6e1", color: "#2a2622" }}>
      <style>{CARD_CSS + EDIT_CSS + (set ? layoutCss(set) : "")}</style>
      {toast && <div style={{ position: "fixed", bottom: 20, left: "50%", transform: "translateX(-50%)", zIndex: 1100, background: "#2a2622", color: "#fff", padding: "10px 18px", borderRadius: 6, fontSize: 13 }}>{toast}</div>}
      <div style={{ position: "sticky", top: 0, zIndex: 20, background: "#fff", borderBottom: "1px solid #d6d0c7", padding: "10px 16px", display: "flex", flexWrap: "wrap", gap: "10px 14px", alignItems: "center" }}>
        <button onClick={set ? () => setOpenId(null) : onHome} style={{ ...btn(), background: "none", border: "none", color: "#7a7268", paddingLeft: 0 }}>← {set ? "All labels" : "Home"}</button>
        {set ? (
          <>
            <input key={set.id} defaultValue={set.name} onKeyDown={e => e.key === "Enter" && e.currentTarget.blur()} style={{ font: "500 20px 'Cormorant Garamond',serif", border: "1px solid transparent", borderRadius: 6, padding: "2px 6px", minWidth: 120, flex: mob() ? "1 1 100%" : "0 1 260px" }} onFocus={e => e.target.style.borderColor = "#d6d0c7"} onBlur={e => { e.target.style.borderColor = "transparent"; const v = e.target.value.trim() || "Labels"; if (v !== set.name) patchSet({ name: v }); }} />
            <select value={set.lang} onChange={e => patchSet({ lang: e.target.value })} style={{ ...btn(), padding: "7px 8px" }} title="Second line on each card">{LANGS.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}</select>
            <select value={set.paper} onChange={e => patchSet({ paper: e.target.value })} style={{ ...btn(), padding: "7px 8px" }}>{Object.entries(PAPER).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}</select>
            <select value={SIZES[set.size] || set.size === "custom" ? set.size : "s10"} onChange={e => patchSet({ size: e.target.value, ...(e.target.value === "custom" && !set.cw ? { cw: g.w, ch: g.h } : {}) })} style={{ ...btn(), padding: "7px 8px" }} title="Card size">{Object.entries(SIZES).map(([k, z]) => <option key={k} value={k}>{z.label}</option>)}<option value="custom">Custom size…</option></select>
            {set.size === "custom" && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12.5, color: "#4a4036" }}>
                <input key={"w" + set.id} type="number" step="0.05" min="1.5" max="7.3" defaultValue={g.w} onBlur={e => patchSet({ cw: clampIn(e.target.value, 1.5, 7.3, 3.5) })} style={{ ...btn(), width: 64, padding: "6px 6px" }} title="Width, inches" />×
                <input key={"h" + set.id} type="number" step="0.05" min="1" max="10.4" defaultValue={g.h} onBlur={e => patchSet({ ch: clampIn(e.target.value, 1, 10.4, 1.854) })} style={{ ...btn(), width: 64, padding: "6px 6px" }} title="Height, inches" />in · {g.per} a page
              </span>
            )}
            <select value={set.text || "1"} onChange={e => patchSet({ text: e.target.value })} style={{ ...btn(), padding: "7px 8px" }} title="Text size">{TEXT.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            <button onClick={() => setShowLayout(v => !v)} style={{ ...btn(), ...(showLayout ? { background: "#e9e1d4" } : {}) }}>▤ Layout</button>
            <button onClick={() => setBulk(v => !v)} style={{ ...btn(), ...(bulk ? { background: "#e9e1d4" } : {}) }}>{bulk ? "▣ Back to cards" : "▦ Bulk edit"}</button>
            <div style={{ flex: 1 }} />
            <button onClick={() => patchSet({ cards: [...current().cards, blank()] })} style={btn()}>＋ Card</button>
            <button onClick={() => setPicker("box")} style={btn()}>📦 From box</button>
            <button onClick={() => setPicker("stock")} style={btn()}>＋ From Stock</button>
            <button onClick={aiFill} disabled={!!busy} style={btn()}>{busy === "ai" ? "Filling…" : "✨ AI fill names"}</button>
            <button onClick={() => { if (!printSet(set)) say("Allow pop-ups to open the print sheet"); }} style={btn(true)}>🖨 Print / PDF</button>
          </>
        ) : (
          <>
            <div><div style={{ font: "500 22px 'Cormorant Garamond',serif" }}>Make Labels</div><div style={{ fontSize: 12, color: "#7a7268" }}>Name cards for shows, shelves and boxes · 2 to 10 a page</div></div>
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
                <div style={{ fontSize: 12, color: "#7a7268" }}>{s.cards.length} card{s.cards.length === 1 ? "" : "s"} · {langOf(s.lang).label} · {(PAPER[s.paper] || PAPER.letter).label} · {geom(s).per} a page</div>
              </div>
              <button onClick={e => { e.stopPropagation(); copySet(s); }} style={btn()} title="Make a copy">⧉</button>
              <button onClick={e => { e.stopPropagation(); if (!printSet(s)) say("Allow pop-ups to open the print sheet"); }} style={btn()} title="Print">🖨</button>
              <button onClick={e => { e.stopPropagation(); removeSet(s); }} style={{ ...btn(), color: "#9b2c2c" }} title="Delete">✕</button>
            </div>
          ))}
        </div>
      )}

      {set && showLayout && (() => {
        const L = layoutOf(set);
        const put = (part, patch) => patchSet({ layout: { ...(set.layout || {}), [part]: { ...(set.layout?.[part] || {}), ...patch } } });
        const seg = (part, key, opts) => (
          <span style={{ display: "inline-flex", border: "1px solid #d6d0c7", borderRadius: 6, overflow: "hidden" }}>
            {opts.map(([v, l]) => <button key={v} onClick={() => put(part, { [key]: v })} style={{ border: 0, padding: "5px 9px", fontSize: 12, cursor: "pointer", background: L[part][key] === v ? "#6f5430" : "#fff", color: L[part][key] === v ? "#fff" : "#4a4036" }}>{l}</button>)}
          </span>
        );
        return (
          <div style={{ background: "#fff", borderBottom: "1px solid #d6d0c7", padding: "10px 16px", display: "grid", gap: 8, fontSize: 13, fontFamily: "system-ui,sans-serif" }}>
            {PARTS.filter(([k]) => k !== "local" || set.lang).map(([k, label]) => (
              <div key={k} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6, width: 190 }}><input type="checkbox" checked={L[k].show} onChange={e => put(k, { show: e.target.checked })} />{label}</label>
                <select value={L[k].s} disabled={!L[k].show} onChange={e => put(k, { s: +e.target.value })} style={{ ...btn(), padding: "5px 6px" }} title="Size">{SCALES.map(v => <option key={v} value={v}>{Math.round(v * 100)}%</option>)}</select>
                {k === "name" && seg("name", "align", [["left", "Left"], ["center", "Centre"], ["right", "Right"]])}
                {k === "name" && seg("name", "pos", [["top", "Top"], ["middle", "Middle"]])}
                {k === "type" && <>{seg("type", "align", [["left", "Left"], ["center", "Centre"], ["right", "Right"]])}<span style={{ fontSize: 11.5, color: "#7a7268" }}>type & origin lines</span></>}
              </div>
            ))}
            <div><button onClick={() => patchSet({ layout: {} })} style={{ ...btn(), padding: "5px 10px", fontSize: 12 }}>Reset layout</button></div>
          </div>
        );
      })()}

      {set && bulk && <BulkTable set={set} say={say} onCards={f => { const s0 = current(); if (s0) patchSet({ cards: f(s0.cards) }); }} />}

      {set && !bulk && (
        <>
          <p style={{ fontSize: 12.5, color: "#7a7268", maxWidth: 816, margin: "12px auto 0", padding: "0 16px", fontFamily: "system-ui,sans-serif" }}>
            Click any text on a card to change it. Hover a card to copy, move or delete it. Saved as you go · {set.cards.length} cards on {Math.max(1, Math.ceil(set.cards.length / g.per))} page{set.cards.length > g.per ? "s" : ""}.
          </p>
          <div style={{ overflowX: "auto", padding: "14px 0 40px" }}>
            <div style={{ width: 816, margin: "0 auto", zoom }}>
              {Array.from({ length: Math.max(1, Math.ceil(set.cards.length / g.per)) }, (_, p) => (
                <div key={p} className="lbl-sheet" style={{ gridTemplateColumns: `repeat(${g.cols}, ${g.w * 96}px)`, gridAutoRows: `${g.h * 96}px` }}>
                  {set.cards.slice(p * g.per, p * g.per + g.per).map((c, k) => {
                    const i = p * g.per + k;
                    return <Card key={c.id} c={c} g={g} lang={set.lang} index={i} total={set.cards.length} onPatch={pp => patchCard(c.id, pp)} onAct={a => act(i, a)} />;
                  })}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
      {picker && set && <StockPicker lang={set.lang} boxFirst={picker === "box"} onClose={() => setPicker(false)} onAdd={cards => { patchSet({ cards: [...current().cards.filter(c => c.en || c.local || c.price), ...cards] }); setPicker(false); say(`✓ ${cards.length} card${cards.length === 1 ? "" : "s"} added`); }} />}
    </div>
  );
}
