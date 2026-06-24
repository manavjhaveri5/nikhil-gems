import { useState, useEffect } from "react";
import { loadK, saveK, onCacheRefresh } from "./utils.js";
import { SHAPES, DEFAULT_EXP_CATS, DEFAULT_MARKETS, PRODUCT_TYPES } from "./constants.js";

const mob = window.innerWidth < 700;

const C = {
  bg: "var(--c-bg)", surface: "var(--c-surface)", card: "var(--c-card)",
  border: "var(--c-border)", borderHi: "var(--c-borderHi)",
  ink: "var(--c-ink)", inkMid: "var(--c-inkMid)", inkFaint: "var(--c-inkFaint)",
  gold: "var(--c-gold)", goldLight: "var(--c-goldLight)", goldBright: "var(--c-goldBright)",
  green: "var(--c-green)", greenBg: "var(--c-greenBg)",
  red: "var(--c-red)", redBg: "var(--c-redBg)",
  amber: "var(--c-amber)", amberBg: "var(--c-amberBg)",
  blue: "var(--c-blue)", blueBg: "var(--c-blueBg)",
};

const FI = {
  border: `1px solid var(--c-border)`, borderRadius: 7, padding: "8px 11px",
  fontSize: 13, background: "var(--c-bg)", color: "var(--c-ink)",
  outline: "none", fontFamily: "inherit", width: "100%", boxSizing: "border-box",
};

const DATASETS = [
  { key: "ng-ds-shapes-v1",    label: "Shapes",             icon: "💎", desc: "Shapes used in Stock module and the Telegram bot", defaults: SHAPES },
  { key: "ng-ds-expcats-v1",   label: "Expense Categories", icon: "🧾", desc: "Categories shown when adding expenses",            defaults: DEFAULT_EXP_CATS },
  { key: "ng-ds-markets-v1",   label: "Markets",            icon: "🌐", desc: "Markets/shows used in Stock and Invoicing",        defaults: DEFAULT_MARKETS },
  { key: "ng-ds-protypes-v1",  label: "Product Types",      icon: "📦", desc: "Product types used in Stock",                     defaults: PRODUCT_TYPES },
];

export const CUSTOMS_DESCS_KEY = "ng-customs-descs-v1";

// Seed rows shown the first time (user can edit/delete/add freely)
const DEFAULT_CUSTOMS_DESCS = [
  { shape: "Palmstone",          desc: "Natural agate stone, cut and polished, roughly shaped",               hsn: "71031029" },
  { shape: "Sphere",             desc: "Natural agate stone, sawn and polished into sphere, roughly shaped",  hsn: "71031029" },
  { shape: "Heart",              desc: "Natural Agate, cut into heart form, roughly shaped",                  hsn: "71031029" },
  { shape: "Shivalingam",        desc: "Natural Agate, traditionally cut and polished, roughly shaped",       hsn: "71031029" },
  { shape: "Bowl",               desc: "Natural agate, hollowed and polished, roughly shaped",                hsn: "71031029" },
  { shape: "Bookend",            desc: "Natural agate, roughly hollowed",                                     hsn: "71031029" },
  { shape: "Freeform",           desc: "Natural agate, hand-shaped and polished, shaped",                     hsn: "71031029" },
  { shape: "Carvings",           desc: "Natural agate, hand-shaped and polished, shaped",                     hsn: "71031029" },
  { shape: "Mineral",            desc: "Natural mineral stone specimen, roughly trimmed",                     hsn: "71031029" },
  { shape: "Rough",              desc: "Natural agate stone, sawn",                                           hsn: "71031029" },
  { shape: "Tower",              desc: "Natural agate, sliced and polished into tower, roughly shaped",       hsn: "71031029" },
  { shape: "Wand",               desc: "Natural agate, pointed and polished, roughly shaped",                 hsn: "71031029" },
  { shape: "Pendulum",           desc: "Natural agate, pointed and polished, faceted",                        hsn: "71031029" },
  { shape: "Tumbled",            desc: "Natural agate stone, cut and polished, roughly shaped",               hsn: "71031029" },
  { shape: "Flatstone",          desc: "Natural agate stone, cut and polished, roughly shaped",               hsn: "71031029" },
  { shape: "Slice",              desc: "Natural agate stone, sawn",                                           hsn: "71031029" },
  { shape: "Geodes",             desc: "Natural mineral stone specimen, roughly trimmed",                     hsn: "71031029" },
  { shape: "Points",             desc: "Natural agate, pointed and polished, roughly shaped",                 hsn: "71031029" },
  { shape: "Quartz Chips",       desc: "Clear quartz, chipped and roughly shaped",                            hsn: "71031029" },
];

function uid() { return Math.random().toString(36).substr(2, 9); }

function Toast({ msg }) {
  if (!msg) return null;
  return (
    <div style={{ position: "fixed", bottom: 28, left: "50%", transform: "translateX(-50%)", background: C.ink, color: "#FAF0DC", borderRadius: 8, padding: "10px 20px", fontSize: 13, fontWeight: 500, zIndex: 999, boxShadow: "0 4px 20px rgba(0,0,0,.22)", pointerEvents: "none" }}>
      {msg}
    </div>
  );
}

function DatasetPanel({ ds }) {
  const [custom, setCustom] = useState([]);
  const [removed, setRemoved] = useState([]);
  const [input, setInput] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [toast, setToast] = useState("");
  const showToast = m => { setToast(m); setTimeout(() => setToast(""), 2500); };

  useEffect(() => {
    Promise.all([loadK(ds.key), loadK(ds.key + "-removed")]).then(([c, r]) => {
      setCustom(Array.isArray(c) ? c : []);
      setRemoved(Array.isArray(r) ? r : []);
      setLoaded(true);
    });
  }, [ds.key]);
  useEffect(() => onCacheRefresh(keys => {
    if (keys.includes(ds.key)) loadK(ds.key).then(c => { if (Array.isArray(c)) setCustom(c); });
    if (keys.includes(ds.key + "-removed")) loadK(ds.key + "-removed").then(r => { if (Array.isArray(r)) setRemoved(r); });
  }), [ds.key]);

  const add = () => {
    const v = input.trim();
    if (!v) return;
    if ([...ds.defaults, ...custom].some(x => x.toLowerCase() === v.toLowerCase())) { showToast("Already exists"); return; }
    const next = [...custom, v];
    setCustom(next); saveK(ds.key, next); setInput(""); showToast("Added");
  };

  const removeCustom  = item => { const next = custom.filter(x => x !== item);  setCustom(next);  saveK(ds.key, next);               showToast("Removed");  };
  const removeDefault = item => { const next = [...removed, item];               setRemoved(next); saveK(ds.key + "-removed", next);  showToast("Hidden");   };
  const restoreDefault = item => { const next = removed.filter(x => x !== item); setRemoved(next); saveK(ds.key + "-removed", next); showToast("Restored"); };

  const visibleDefaults = ds.defaults.filter(x => !removed.includes(x));
  const allItems = [...visibleDefaults, ...custom];

  return (
    <div>
      <Toast msg={toast} />
      <div style={{ marginBottom: 14, fontSize: 12, color: C.inkFaint }}>{ds.desc} · {allItems.length} items</div>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter") add(); }}
          placeholder={`Add new ${ds.label.toLowerCase().replace(/s$/, "")}…`} style={FI} />
        <button onClick={add} disabled={!input.trim()}
          style={{ background: input.trim() ? C.ink : "transparent", color: input.trim() ? "#FAF0DC" : C.inkFaint, border: `1.5px solid ${input.trim() ? C.ink : C.border}`, borderRadius: 7, padding: "0 18px", fontSize: 13, fontWeight: 600, cursor: input.trim() ? "pointer" : "default", flexShrink: 0, transition: "all .15s" }}>
          Add
        </button>
      </div>
      {!loaded && <div style={{ color: C.inkFaint, fontSize: 13 }}>Loading…</div>}
      {loaded && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {custom.map(item => (
            <div key={item} style={{ display: "flex", alignItems: "center", gap: 5, background: C.amberBg, border: `1.5px solid ${C.goldBright}`, borderRadius: 6, padding: "4px 10px", fontSize: 12, fontWeight: 600, color: C.ink }}>
              {item}
              <button onClick={() => removeCustom(item)} style={{ background: "none", border: "none", cursor: "pointer", color: C.red, fontSize: 14, lineHeight: 1, padding: 0, marginLeft: 2 }}>×</button>
            </div>
          ))}
          {visibleDefaults.map(item => (
            <div key={item} style={{ display: "flex", alignItems: "center", gap: 5, background: C.card, border: `1px solid ${C.border}`, borderRadius: 6, padding: "4px 10px", fontSize: 12, color: C.inkMid }}>
              {item}
              <button onClick={() => removeDefault(item)} title="Hide this item" style={{ background: "none", border: "none", cursor: "pointer", color: C.inkFaint, fontSize: 12, lineHeight: 1, padding: 0, marginLeft: 2 }}>×</button>
            </div>
          ))}
          {removed.map(item => (
            <div key={item} style={{ display: "flex", alignItems: "center", gap: 5, background: C.redBg, border: `1px solid ${C.border}`, borderRadius: 6, padding: "4px 10px", fontSize: 12, color: C.inkFaint, textDecoration: "line-through" }}>
              {item}
              <button onClick={() => restoreDefault(item)} title="Restore" style={{ background: "none", border: "none", cursor: "pointer", color: C.green, fontSize: 12, lineHeight: 1, padding: 0, marginLeft: 2, textDecoration: "none" }}>↩</button>
            </div>
          ))}
        </div>
      )}
      {loaded && (
        <div style={{ marginTop: 14, fontSize: 11, color: C.inkFaint }}>
          <span style={{ background: C.amberBg, border: `1px solid ${C.goldBright}`, borderRadius: 4, padding: "1px 6px", marginRight: 6 }}>Gold</span> = your custom items &nbsp;·&nbsp;
          <span style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 4, padding: "1px 6px", marginRight: 6 }}>Grey</span> = built-in (click × to hide) &nbsp;·&nbsp;
          <span style={{ background: C.redBg, border: `1px solid ${C.border}`, borderRadius: 4, padding: "1px 6px", marginRight: 6, textDecoration: "line-through" }}>Red</span> = hidden (click ↩ to restore)
        </div>
      )}
    </div>
  );
}

// ── Customs Descriptions panel (key-value table) ──────────────────────────────
function CustomsDescsPanel() {
  const [rows, setRows]     = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [toast, setToast]   = useState("");
  const [editing, setEditing] = useState(null); // id of row being edited
  const [editBuf, setEditBuf] = useState({});    // {shape, desc, hsn}
  const [addBuf, setAddBuf]   = useState({ shape: "", desc: "", hsn: "71031029" });
  const showToast = m => { setToast(m); setTimeout(() => setToast(""), 2500); };

  useEffect(() => {
    loadK(CUSTOMS_DESCS_KEY).then(r => {
      if (Array.isArray(r) && r.length > 0) {
        setRows(r);
      } else {
        // First load — seed with defaults
        const seeded = DEFAULT_CUSTOMS_DESCS.map(d => ({ ...d, id: uid() }));
        setRows(seeded);
        saveK(CUSTOMS_DESCS_KEY, seeded);
      }
      setLoaded(true);
    });
  }, []);
  useEffect(() => onCacheRefresh(keys => {
    if (keys.includes(CUSTOMS_DESCS_KEY)) loadK(CUSTOMS_DESCS_KEY).then(r => { if (Array.isArray(r) && r.length) setRows(r); });
  }), []);

  const persist = next => { setRows(next); saveK(CUSTOMS_DESCS_KEY, next); };

  const startEdit = row => { setEditing(row.id); setEditBuf({ shape: row.shape, desc: row.desc, hsn: row.hsn || "71031029" }); };
  const cancelEdit = () => { setEditing(null); setEditBuf({}); };
  const saveEdit = id => {
    if (!editBuf.shape.trim() || !editBuf.desc.trim()) return;
    persist(rows.map(r => r.id === id ? { ...r, ...editBuf } : r));
    setEditing(null); showToast("Saved");
  };
  const deleteRow = id => { persist(rows.filter(r => r.id !== id)); showToast("Deleted"); };
  const addRow = () => {
    if (!addBuf.shape.trim() || !addBuf.desc.trim()) return;
    persist([...rows, { id: uid(), ...addBuf }]);
    setAddBuf({ shape: "", desc: "", hsn: "71031029" });
    showToast("Added");
  };

  const printTable = () => {
    const esc = s => String(s ?? "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    const body = rows.map(r => `<tr><td class="sh">${esc(r.shape)}</td><td class="ds">${esc(r.desc)}</td><td class="hsn">${esc(r.hsn || "")}</td></tr>`).join("");
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Customs Descriptions</title><style>*{box-sizing:border-box}body{font-family:system-ui,sans-serif;margin:0;padding:28px;color:#1a1308;background:#fff}.btn{background:#b8922a;color:#fff;border:none;padding:9px 20px;border-radius:6px;cursor:pointer;font-size:14px;margin-bottom:20px}h1{font-family:Georgia,serif;font-size:24px;margin:0 0 4px}.sub{font-size:12px;color:#888;margin-bottom:20px}table{width:100%;border-collapse:collapse}th{background:#f8f6f1;padding:8px 12px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.4px;color:#888;border-bottom:2px solid #e5dcc8}td{padding:8px 12px;font-size:13px;border-bottom:1px solid #e5dcc8;vertical-align:top}.sh{font-weight:600;white-space:nowrap}.ds{font-style:italic;color:#444}.hsn{font-family:monospace;color:#777;white-space:nowrap}@media print{.btn{display:none}body{padding:0}}</style></head><body><button class="btn" onclick="window.print()">🖨 Print / Save PDF</button><h1>Customs Descriptions</h1><div class="sub">${rows.length} rows · ${new Date().toLocaleDateString()}</div><table><thead><tr><th>Shape / Category</th><th>Customs / Bill Description</th><th>HSN</th></tr></thead><tbody>${body}</tbody></table></body></html>`;
    const w = window.open("", "_blank");
    if (!w) { showToast("Allow pop-ups to print"); return; }
    w.document.write(html); w.document.close();
  };

  const thSt = { textAlign: "left", padding: "7px 10px", fontSize: 9, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .4, whiteSpace: "nowrap", borderBottom: `1px solid ${C.border}` };
  const tdSt = { padding: "7px 10px", verticalAlign: "middle", borderBottom: `1px solid ${C.border}` };
  const inSt = { ...FI, padding: "5px 8px", fontSize: 12 };

  return (
    <div>
      <Toast msg={toast} />
      <div style={{ marginBottom: 14, display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1, fontSize: 12, color: C.inkFaint }}>
          Maps each shape/category to its customs bill description and HSN code. Auto-fills the <strong>Customs Desc</strong> column when creating invoices from stock. Add several shapes to one description by separating them with commas (e.g. <em>Sphere, Heart, Tumbled</em>). · {rows.length} rows
        </div>
        {loaded && rows.length > 0 && (
          <button onClick={printTable} title="Print or save the table as PDF"
            style={{ background: C.amberBg, border: `1px solid ${C.amber}`, borderRadius: 5, cursor: "pointer", fontSize: 11, color: C.amber, padding: "5px 12px", fontWeight: 600, whiteSpace: "nowrap" }}>
            🖨 Print
          </button>
        )}
      </div>

      {!loaded && <div style={{ color: C.inkFaint, fontSize: 13 }}>Loading…</div>}
      {loaded && (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 9, overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: C.card }}>
                  <th style={{ ...thSt, width: 140 }}>Shape / Category</th>
                  <th style={thSt}>Customs / Bill Description</th>
                  <th style={{ ...thSt, width: 90 }}>HSN</th>
                  <th style={{ ...thSt, width: 60 }}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => editing === row.id ? (
                  <tr key={row.id} style={{ background: C.amberBg }}>
                    <td style={tdSt}>
                      <input value={editBuf.shape} onChange={e => setEditBuf(b => ({ ...b, shape: e.target.value }))}
                        style={inSt} placeholder="Shape… (comma-separate for several)" autoFocus />
                    </td>
                    <td style={tdSt}>
                      <input value={editBuf.desc} onChange={e => setEditBuf(b => ({ ...b, desc: e.target.value }))}
                        onKeyDown={e => { if (e.key === "Enter") saveEdit(row.id); if (e.key === "Escape") cancelEdit(); }}
                        style={inSt} placeholder="Description for customs…" />
                    </td>
                    <td style={tdSt}>
                      <input value={editBuf.hsn} onChange={e => setEditBuf(b => ({ ...b, hsn: e.target.value }))}
                        style={{ ...inSt, width: 80 }} placeholder="HSN" />
                    </td>
                    <td style={{ ...tdSt, whiteSpace: "nowrap" }}>
                      <button onClick={() => saveEdit(row.id)}
                        style={{ background: C.ink, color: "#FAF0DC", border: "none", borderRadius: 5, padding: "4px 10px", fontSize: 11, fontWeight: 600, cursor: "pointer", marginRight: 4 }}>✓</button>
                      <button onClick={cancelEdit}
                        style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 5, padding: "4px 8px", fontSize: 11, cursor: "pointer", color: C.inkMid }}>✕</button>
                    </td>
                  </tr>
                ) : (
                  <tr key={row.id} style={{ cursor: "pointer" }} onClick={() => startEdit(row)}>
                    <td style={{ ...tdSt, fontWeight: 600, fontSize: 13, color: C.ink }}>
                      {(() => {
                        const parts = String(row.shape || "").split(/[,;]/).map(s => s.trim()).filter(Boolean);
                        return parts.length > 1
                          ? <span style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                              {parts.map((p, i) => <span key={i} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 4, padding: "1px 7px", fontSize: 12 }}>{p}</span>)}
                            </span>
                          : row.shape;
                      })()}
                    </td>
                    <td style={{ ...tdSt, fontSize: 12, color: C.inkMid, fontStyle: "italic" }}>{row.desc}</td>
                    <td style={{ ...tdSt, fontSize: 11, color: C.inkFaint, fontFamily: "monospace" }}>{row.hsn}</td>
                    <td style={{ ...tdSt, textAlign: "center" }}>
                      <button onClick={e => { e.stopPropagation(); deleteRow(row.id); }}
                        style={{ background: "none", border: "none", color: C.red, cursor: "pointer", fontSize: 14, padding: "0 4px" }}>×</button>
                    </td>
                  </tr>
                ))}

                {/* Add row */}
                <tr style={{ background: C.greenBg }}>
                  <td style={tdSt}>
                    <input value={addBuf.shape} onChange={e => setAddBuf(b => ({ ...b, shape: e.target.value }))}
                      style={inSt} placeholder="Shape… (comma-separate for several)" />
                  </td>
                  <td style={tdSt}>
                    <input value={addBuf.desc} onChange={e => setAddBuf(b => ({ ...b, desc: e.target.value }))}
                      onKeyDown={e => { if (e.key === "Enter") addRow(); }}
                      style={inSt} placeholder="Description for customs / bill…" />
                  </td>
                  <td style={tdSt}>
                    <input value={addBuf.hsn} onChange={e => setAddBuf(b => ({ ...b, hsn: e.target.value }))}
                      style={{ ...inSt, width: 80 }} placeholder="HSN" />
                  </td>
                  <td style={{ ...tdSt, textAlign: "center" }}>
                    <button onClick={addRow} disabled={!addBuf.shape.trim() || !addBuf.desc.trim()}
                      style={{ background: addBuf.shape.trim() && addBuf.desc.trim() ? C.green : "#ccc", color: "#fff", border: "none", borderRadius: 5, padding: "4px 10px", fontSize: 11, fontWeight: 600, cursor: addBuf.shape.trim() && addBuf.desc.trim() ? "pointer" : "default" }}>
                      + Add
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
      <div style={{ marginTop: 10, fontSize: 11, color: C.inkFaint }}>
        Click any row to edit inline · Enter to save · Esc to cancel
      </div>
    </div>
  );
}

export default function DatasetsApp({ onHome }) {
  const [active, setActive] = useState(0);
  const tabs = [...DATASETS, { key: "customs-descs", label: "Customs Descriptions", icon: "📋", desc: "Shape → invoice description mapping" }];

  return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: "system-ui, sans-serif" }}>
      <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}`, padding: mob ? "0 12px" : "0 24px", display: "flex", alignItems: "center", height: 54, position: "sticky", top: 0, zIndex: 100, gap: 10 }}>
        <button onClick={onHome} style={{ background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 7, padding: "0 12px 0 0", borderRight: `1px solid ${C.border}`, flexShrink: 0 }}>
          <span style={{ fontSize: 20 }}>🗂️</span>
          {!mob && <div><div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 15, fontWeight: 600, color: C.ink, lineHeight: 1.1 }}>Datasets</div><div style={{ fontSize: 8, color: C.inkFaint, letterSpacing: 1.2, fontWeight: 500 }}>NIKHIL GEMS</div></div>}
        </button>
        <div style={{ display: "flex", gap: 4, overflowX: "auto" }}>
          {tabs.map((ds, i) => (
            <button key={ds.key} onClick={() => setActive(i)}
              style={{ background: active === i ? C.gold : "none", color: active === i ? "#fff" : C.inkMid, border: "none", borderRadius: 6, padding: "5px 12px", fontSize: 12, fontWeight: active === i ? 600 : 400, cursor: "pointer", whiteSpace: "nowrap", transition: "all .15s" }}>
              {ds.icon} {ds.label}
            </button>
          ))}
        </div>
      </div>
      <div style={{ maxWidth: 860, margin: "0 auto", padding: mob ? "16px 14px" : "24px 28px" }}>
        <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 22, fontWeight: 600, color: C.ink, marginBottom: 4 }}>
          {tabs[active].icon} {tabs[active].label}
        </div>
        {active < DATASETS.length
          ? <DatasetPanel key={DATASETS[active].key} ds={DATASETS[active]} />
          : <CustomsDescsPanel />
        }
      </div>
    </div>
  );
}
