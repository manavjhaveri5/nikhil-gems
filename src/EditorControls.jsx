import { C } from "./lmTheme.js";

/* The two controls both editors are built out of.

   Defined at module scope on purpose: a component created inside a render is a
   fresh type on every state change, so React would remount the range input
   mid-drag and the slider would drop the pointer after the first pixel. */

export const lab = { fontSize: 9.5, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .6 };

export function Slider({ label, hint, value, min = -100, max = 100, signed = true, step = 1, unit = "", onChange, onReset }) {
  return (
    <div style={{ display: "grid", gap: 3 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
        <span style={lab}>{label}</span>
        {hint && <span style={{ fontSize: 9.5, color: C.inkFaint }}>{hint}</span>}
        <span style={{ flex: 1 }} />
        <button type="button" onClick={onReset} title="Back to zero"
          style={{ background: "none", border: "none", padding: 0, cursor: "pointer",
            fontSize: 11, fontWeight: 700, color: value === 0 ? C.inkFaint : C.teal }}>
          {(signed && value > 0 ? `+${value}` : `${value}`) + unit}
        </button>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(+e.target.value)}
        style={{ width: "100%", accentColor: C.teal, margin: 0 }} />
    </div>
  );
}
