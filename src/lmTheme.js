/* Shared look-and-feel for the Listing Manager, Omnisend and the campaign composer.
   These screens were built together and read as one surface, so the palette and the
   input style live here rather than being copied per module. */
export const C = {
  bg:"var(--c-bg)", surface:"var(--c-surface)", card:"var(--c-card)",
  border:"var(--c-border)", borderHi:"var(--c-borderHi)",
  ink:"var(--c-ink)", inkMid:"var(--c-inkMid)", inkFaint:"var(--c-inkFaint)",
  gold:"var(--c-gold)", goldLight:"var(--c-goldLight)",
  green:"var(--c-green)", greenBg:"var(--c-greenBg)",
  red:"var(--c-red)", redBg:"var(--c-redBg)",
  amber:"var(--c-amber)", amberBg:"var(--c-amberBg)",
  blue:"var(--c-blue)", blueBg:"var(--c-blueBg)",
  purple:"#6B3FA0", purpleBg:"#F3EEFF",
  // The selection accent these screens have always asked for by name; the CSS
  // variables were there, the mapping wasn't, so every C.teal read as undefined.
  teal:"var(--c-teal)", tealBg:"var(--c-tealBg)",
};

export const mob = () => window.innerWidth < 700;

export function FI(extra = {}) {
  return {
    background: C.surface, border: `1.5px solid ${C.border}`, color: C.ink,
    borderRadius: 7, padding: "8px 11px", fontSize: 13, fontFamily: "inherit",
    width: "100%", boxSizing: "border-box", ...extra,
  };
}
