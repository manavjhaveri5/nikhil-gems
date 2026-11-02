import { useState, useEffect, useRef } from "react";
import { C } from "./ui.jsx";

/* 📅 month button with our own year + 12-month popover. Replaces a hidden native
   <input type="month">, whose picker Safari shows but won't let you click. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export default function MonthPicker({ value, onChange, label, title, dim = false }) {
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(() => +(value || "").slice(0, 4) || new Date().getFullYear());
  const ref = useRef(null);
  useEffect(() => { if (open) setYear(+(value || "").slice(0, 4) || new Date().getFullYear()); }, [open]);
  useEffect(() => {
    if (!open) return;
    const away = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const esc = e => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("touchstart", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("touchstart", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  const pick = m => { onChange(`${year}-${String(m + 1).padStart(2, "0")}`); setOpen(false); };
  const now = new Date(), thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const nav = { background: "none", border: `1px solid ${C.border}`, borderRadius: 6, width: 30, height: 28, cursor: "pointer", color: C.ink, fontSize: 14 };
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button type="button" onClick={() => setOpen(o => !o)} title={title} aria-label="Pick month" aria-expanded={open}
        style={{ display: "flex", alignItems: "center", gap: 7, background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: "7px 12px", cursor: "pointer", opacity: dim ? .45 : 1 }}>
        <span style={{ fontSize: 15, lineHeight: 1 }}>📅</span>
        <span style={{ fontSize: 12, fontWeight: 800, color: C.ink, whiteSpace: "nowrap" }}>{label}</span>
      </button>
      {open && <div role="dialog" style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 900, background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,.14)", padding: 10, width: 236 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <button type="button" style={nav} onClick={() => setYear(y => y - 1)} aria-label="Previous year">‹</button>
          <span style={{ fontSize: 13, fontWeight: 800, color: C.ink }}>{year}</span>
          <button type="button" style={nav} onClick={() => setYear(y => y + 1)} aria-label="Next year">›</button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 4 }}>
          {MONTHS.map((m, i) => {
            const key = `${year}-${String(i + 1).padStart(2, "0")}`, sel = key === value;
            return <button type="button" key={m} onClick={() => pick(i)}
              style={{ padding: "8px 0", borderRadius: 6, cursor: "pointer", fontSize: 12.5, fontWeight: sel ? 800 : 500, border: key === thisMonth && !sel ? `1px solid ${C.border}` : "1px solid transparent", background: sel ? C.ink : "none", color: sel ? C.card : C.ink }}>{m}</button>;
          })}
        </div>
      </div>}
    </div>
  );
}
