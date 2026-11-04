/* Raj on Home: today's headline and highlights, plus follow-ups due. Admin only.
   Reads the same app_rows Raj's page does; tap to open Raj. */
import { useState, useEffect } from "react";
import { C, mob } from "./lmTheme.js";
import { rajRows, RAJ_KEYS, istDay } from "./RajApp.jsx";

export default function RajCard({ onEnter }) {
  const [b, setB] = useState(undefined);
  const [due, setDue] = useState([]);
  useEffect(() => {
    let on = true;
    const today = istDay();
    rajRows(RAJ_KEYS.briefings, { limit: 3 }).then(l => on && setB([...l].sort((x, y) => y.id.localeCompare(x.id))[0] || null)).catch(() => on && setB(null));
    rajRows(RAJ_KEYS.notes).then(n => on && setDue(n.filter(x => x.kind === "followup" && x.status !== "done" && x.due && x.due <= today)
      .sort((x, y) => x.due.localeCompare(y.due)))).catch(() => {});
    return () => { on = false; };
  }, []);
  if (b === undefined) return null;
  const today = istDay(), fresh = b?.id === today;
  return (
    <div onClick={() => onEnter("raj")} role="button"
      style={{ cursor: "pointer", background: `linear-gradient(135deg,#8B6F3E14,${C.surface} 65%)`, border: `1px solid ${C.border}`, borderRadius: 16, padding: mob() ? "14px 15px" : "16px 20px", marginBottom: 11 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <span style={{ fontSize: 20 }}>🧑‍💼</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .6 }}>Raj · {fresh ? "this morning" : b ? `last briefing ${b.id}` : "no briefing yet"}</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.ink, marginTop: 2 }}>{fresh && b.headline ? b.headline : "Good morning, Sir."}</div>
        </div>
        <span style={{ fontSize: 12, color: C.inkMid }}>Open →</span>
      </div>
      {fresh && b.highlights?.length > 0 && (
        <ul style={{ margin: "0 0 4px", paddingLeft: 18, fontSize: 12.5, color: C.inkMid, lineHeight: 1.5 }}>
          {b.highlights.slice(0, 4).map((h, i) => <li key={i}>{h}</li>)}
        </ul>
      )}
      {!fresh && <div style={{ fontSize: 12.5, color: C.inkMid }}>Today's briefing comes at 8:00 IST{b ? "" : " once Raj's first run is done"}.</div>}
      {due.length > 0 && (
        <div style={{ marginTop: 8, fontSize: 12, color: C.amber, fontWeight: 600 }}>
          📌 {due.length} follow-up{due.length > 1 ? "s" : ""} due: {due.slice(0, 2).map(d => d.title).join(" · ")}{due.length > 2 ? " …" : ""}
        </div>
      )}
    </div>
  );
}
