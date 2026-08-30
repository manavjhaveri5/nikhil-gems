import { useEffect, useRef, useState } from "react";
import { C } from "./ui.jsx";

/* The show's name cards, edited as cards.

   The sheet that prints is 95 × 50 mm with a fixed typographic order — name,
   shape, origin, one sentence, note and price — and what was on screen was a
   row of labelled inputs that shared none of that. You could not see a long
   name crowding the line, or an empty price leaving a write-on rule, without
   opening the print sheet and coming back.

   So the editor is the card. Every field is typed in the place it prints, at
   the proportions it prints in: sizes are in cqw against a card that holds the
   95:50 ratio, so what fits here fits there. The print sheet still builds its
   own document — millimetre geometry belongs in the page that goes to paper,
   not in the app's screen styles — and this mirrors it. Keep the two in step:
   the print CSS lives in printLabels(). */

/* Uncontrolled on purpose: a contentEditable that React re-renders under the
   caret loses it mid-word, so the text is written once on mount and after that
   only when the value changes from outside (an AI fill), and edits commit on
   blur — the same bargain the rest of this screen's inputs make. */
function EditableText({ value, onCommit, placeholder, upper = false, style }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (el && document.activeElement !== el && el.innerText !== (value || "")) el.innerText = value || "";
  }, [value]);
  return (
    <div
      ref={ref}
      className="ngcard-edit"
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      data-ph={placeholder || ""}
      onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); } }}
      onBlur={e => {
        let v = e.currentTarget.innerText.replace(/\s+/g, " ").trim();
        if (upper) v = v.toUpperCase();
        e.currentTarget.innerText = v;
        if (v !== (value || "")) onCommit(v);
      }}
      style={style}
    />
  );
}

export default function NameCard({
  meta, lead, sub, shape, origin, desc, note, notePlaceholder, price, currency = "$",
  copies = 1, skipped = false, aiBusy = false, showAi = true, removable = false, font,
  onLead, onSub, onShape, onOrigin, onDesc, onNote, onPrice, onCopies, onSkip, onAi, onRemove,
}) {
  /* Copies is held locally and committed on blur: a commit is a write to the
     shared stock row, and one per keystroke would be a write per digit — the
     same bargain the rest of this screen's inputs make. */
  const [copiesDraft, setCopiesDraft] = useState(String(copies));
  useEffect(() => { setCopiesDraft(String(copies)); }, [copies]);
  const hasPrice = String(price ?? "").trim() !== "";

  const chip = {
    background: "none", border: `1px solid ${C.border}`, borderRadius: 5, padding: "1px 8px",
    fontSize: 9, fontWeight: 700, color: C.inkMid, cursor: "pointer", fontFamily: "inherit",
  };

  return (
    <div style={{ display: "grid", gap: 5, opacity: skipped ? .55 : 1 }}>
      {/* The handling — copies, skip, AI — sits outside the card so the card is
          only ever what goes to paper. */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        <span style={{ fontSize: 9.5, color: C.inkFaint, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {meta}{skipped ? " · not printing" : ""}
        </span>
        {showAi && (
          <button type="button" onClick={onAi} disabled={aiBusy} title="Write this card with AI"
            style={{ ...chip, color: aiBusy ? C.inkFaint : "#8B6F47" }}>{aiBusy ? "…" : "✨"}</button>
        )}
        <label title="How many of this card the sheet prints"
          style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 9, fontWeight: 700, color: C.inkFaint }}>
          ×
          <input type="number" min="0" max="200" value={copiesDraft}
            onChange={e => setCopiesDraft(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }}
            onBlur={() => {
              const v = String(Math.max(0, Math.min(200, parseInt(copiesDraft, 10) || 0)));
              setCopiesDraft(v);
              if (v !== String(copies)) onCopies(v);
            }}
            style={{ width: 42, border: `1px solid ${C.border}`, borderRadius: 5, background: C.surface,
              color: C.ink, fontSize: 10, fontWeight: 700, padding: "2px 5px", fontFamily: "inherit" }} />
        </label>
        <button type="button" onClick={onSkip} style={{ ...chip, color: skipped ? C.blue : C.inkMid }}>
          {skipped ? "print" : "skip"}
        </button>
        {removable && (
          <button type="button" onClick={onRemove} title="Remove from the shipment plan"
            style={{ background: "none", border: "none", cursor: "pointer", color: C.inkFaint, fontSize: 15, lineHeight: 1, padding: 0 }}>×</button>
        )}
      </div>

      <div className="ngcard" style={{ fontFamily: font || "'Cormorant Garamond',Georgia,serif" }}>
        <div className="ngcard-accent" />
        <div className="ngcard-top">
          <EditableText value={lead} onCommit={onLead} placeholder="Stone name"
            style={{ fontSize: "6.6cqw", lineHeight: 1.1, letterSpacing: ".05em", color: "#1a1a1a", textAlign: "center", width: "100%" }} />
          {onSub && (
            <EditableText value={sub} onCommit={onSub} placeholder="English name"
              style={{ fontSize: "3.7cqw", fontStyle: "italic", color: "#777", letterSpacing: ".06em", textAlign: "center", width: "100%" }} />
          )}
        </div>
        <div className="ngcard-mid">
          <hr className="ngcard-rule" />
          <EditableText value={shape} onCommit={onShape} placeholder="SHAPE" upper
            style={{ fontSize: "3.5cqw", color: "#6B5344", letterSpacing: ".18em", textAlign: "center", width: "100%" }} />
          <EditableText value={origin} onCommit={onOrigin} placeholder="ORIGIN" upper
            style={{ fontSize: "3.2cqw", color: "#8a8177", letterSpacing: ".18em", textAlign: "center", width: "100%" }} />
          <EditableText value={desc} onCommit={onDesc} placeholder="One sentence about the stone"
            style={{ fontSize: "3.3cqw", fontWeight: 300, color: "#666", lineHeight: 1.4, textAlign: "center", width: "100%" }} />
          <hr className="ngcard-rule" />
          <hr className="ngcard-rule-accent" />
        </div>
        <div className="ngcard-bottom">
          <EditableText value={note} onCommit={onNote} placeholder={notePlaceholder || "per kg"}
            style={{ fontSize: "3.4cqw", fontStyle: "italic", fontWeight: 300, color: "#a09a92", letterSpacing: ".04em", flex: 1, minWidth: 0, textAlign: "left" }} />
          <div style={{ display: "flex", alignItems: "flex-end", gap: "1.5cqw", fontSize: "4.1cqw", color: "#1a1a1a", whiteSpace: "nowrap" }}>
            <span style={{ color: "#a09a92" }}>{currency}</span>
            {/* Typed as text, not as a number input: the printed card sets the
                figure tight against the currency mark, and a number field is a
                fixed box with a spinner in it. Blank prints as a rule to write
                on at the table, so blank shows as one here. */}
            <EditableText value={hasPrice ? String(price) : ""} placeholder="⁠"
              onCommit={v => onPrice(v.replace(/[^\d.]/g, ""))}
              style={{ minWidth: hasPrice ? "3cqw" : "17cqw", textAlign: "right",
                borderBottom: hasPrice ? "none" : "1px dashed #bdb5aa" }} />
          </div>
        </div>
      </div>
    </div>
  );
}
