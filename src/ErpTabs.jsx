/* Tabs across the top, like a browser's: each holds a module (or Home) and
   stays open behind the others, so going back finds it as it was left —
   filters, scroll, an open search. + opens Home in a new tab; ⌘/Ctrl-click
   on a module opens it in one. A middle click closes a tab, as in Chrome.
   Desktop only: a phone has its own bottom bar. The shell (nikhil-gems-v6)
   keeps the list; this draws it, and the pane each tab lives in. */
import React, { memo, useState } from "react";
import { C } from "./ui.jsx";

export const TAB_H = 38;
export const MAX_TABS = 10;

const ease = "background .12s, color .12s";

export function TabStrip({ tabs, active, labelOf, onSwitch, onClose, onNew }) {
  const [hover, setHover] = useState(null);
  return (
    <div role="tablist" style={{ position: "fixed", top: 0, left: 0, right: 0, height: TAB_H, zIndex: 700, background: C.border,
      display: "flex", alignItems: "flex-end", gap: 0, padding: "0 8px", boxSizing: "border-box", fontFamily: "'Figtree',system-ui,sans-serif", userSelect: "none" }}>
      {/* A module's page is made to fill the window; in a tab it fills what's
          under the strip, or every page would scroll by the strip's height. */}
      <style>{`[data-ng-tab] > * { min-height: calc(100vh - ${TAB_H}px) !important; }`}</style>
      {tabs.map((t, i) => {
        const on = t.key === active, { icon, title } = labelOf(t.mod);
        const nextOn = tabs[i + 1]?.key === active;
        return (
          <div key={t.key} role="tab" aria-selected={on} title={title}
            onMouseDown={e => { if (e.button === 0) onSwitch(t.key); }}
            onAuxClick={e => { if (e.button === 1) { e.preventDefault(); onClose(t.key); } }}
            onMouseEnter={() => setHover(t.key)} onMouseLeave={() => setHover(h => h === t.key ? null : h)}
            style={{ position: "relative", height: TAB_H - 6, flex: "0 1 210px", minWidth: 0, display: "flex", alignItems: "center", gap: 7,
              padding: "0 8px 0 12px", borderRadius: "9px 9px 0 0", cursor: "default", transition: ease,
              background: on ? C.surface : hover === t.key ? "rgba(255,255,255,.45)" : "transparent",
              color: on ? C.ink : C.inkMid, fontSize: 12.5, fontWeight: on ? 650 : 500, boxShadow: on ? "0 -1px 3px rgba(26,19,8,.08)" : "none" }}>
            <span style={{ fontSize: 13, flex: "none" }}>{icon}</span>
            <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</span>
            {tabs.length > 1 && (
              <button aria-label={`Close ${title}`} title="Close tab" onMouseDown={e => e.stopPropagation()} onClick={() => onClose(t.key)}
                style={{ flex: "none", width: 18, height: 18, borderRadius: 9, border: "none", padding: 0, lineHeight: "18px", fontSize: 13, cursor: "pointer",
                  background: "transparent", color: C.inkFaint, visibility: on || hover === t.key ? "visible" : "hidden" }}
                onMouseEnter={e => { e.currentTarget.style.background = C.card; }} onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}>×</button>
            )}
            {/* The thin divider between two tabs that aren't the one on show. */}
            {!on && !nextOn && i < tabs.length - 1 && <span style={{ position: "absolute", right: 0, top: 9, bottom: 9, width: 1, background: C.borderHi, opacity: .6 }} />}
          </div>
        );
      })}
      {tabs.length < MAX_TABS && (
        <button title="New tab (Home)" aria-label="New tab" onClick={onNew}
          style={{ alignSelf: "center", marginLeft: 6, width: 28, height: 28, borderRadius: 14, border: "none", background: "transparent", color: C.inkMid, fontSize: 19, lineHeight: "28px", padding: 0, cursor: "pointer" }}
          onMouseEnter={e => { e.currentTarget.style.background = "rgba(255,255,255,.55)"; }} onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}>+</button>
      )}
    </div>
  );
}

/* Where a tab's module lives: its own scrolling page under the strip. Hidden
   while another tab is on show (still mounted, so nothing is lost), and not
   re-drawn while it stays hidden. No z-index, so the modules' own dialogs
   still layer with the rest of the app as before. */
export const TabPane = memo(function TabPane({ id, on, children }) {
  return (
    <div data-ng-tab={id} data-ng-tab-on={on ? "1" : undefined}
      style={{ position: "absolute", top: TAB_H, left: 0, right: 0, height: `calc(100vh - ${TAB_H}px)`, overflow: "auto", display: on ? "block" : "none" }}>
      {children}
    </div>
  );
}, (a, b) => !a.on && !b.on && a.id === b.id);
