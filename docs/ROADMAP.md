# ERP Efficiency Roadmap

_Audit date: 5 July 2026. Prioritized for daily-work speed first (Manav's pick). Items get built only when green-lit — reference them by number ("do #1 and #4")._

## Why these items (audit findings)

- **Bundle:** 1.3 MB main chunk carries Stock, Purchases, Invoicing, Shows; 7 secondary apps are already lazy-loaded. No loading skeletons — slow connections stare at a blank screen.
- **Data layer:** each dataset is one big JSON array in one Supabase row (47 keys). Invoices moved to per-item versioned saves (July 2026); **stock and purchases still rewrite the entire array on every edit** (~30 call sites) — two people editing at once silently overwrite each other.
- **Navigation:** no global search, no keyboard shortcuts; cross-module jumps are hand-wired props.
- **Observability:** no analytics, no client error reporting; ~18 duplicate toast implementations, 34 hand-rolled modals.
- **Permissions:** module on/off only; feature rules like "hide show earnings" are hardcoded one-offs.

## P0 — Fewer clicks daily

1. **Global command palette (Cmd+K / Ctrl+K)** — fuzzy search invoices, stock, buyers, vendors, bills, shows, listings from anywhere (data already cached client-side, so it's instant), plus actions: "new invoice", "open box STK15", "mark NG-29 paid". New `src/CommandPalette.jsx` mounted in the root app, reusing the existing `go()` navigation + deep-link props. Mobile: long-press the FAB for the same sheet. _Effort: ~1 session._
2. **Quick actions on list rows** — extend the invoice-list pattern (Ship?/Paid? checkboxes) to bills and stock rows so common actions don't require opening the record. _Effort: small._
3. **Recents & pinned in the palette** — last 10 opened records per user (localStorage); the record you were just working on is 2 keystrokes away. _Effort: small, rides on #1._

## P1 — Don't lose work, don't lose trust

4. **Per-item versioned saves for stock & purchases** — port the invoice pattern (`upsertVersionedItemK`, `app_data_upsert_item_versioned` — SQL already live in prod) across the ~30 `saveStockK`/`savePurchasesK` call sites. Kills the concurrent-edit overwrite bug class. Biggest reliability win on the list. _Effort: 1–2 sessions, mechanical but wide._
5. **Client error reporting** — `window.onerror` + `unhandledrejection` hook posting crashes (with user/device context) into the existing `ng-activity-v1` feed; the daily AI ops-check flags spikes. No third-party service. _Effort: tiny._
6. **Auto-reload idle stale tabs** — when an update is ready AND the tab has been hidden >30 min AND no form is dirty, reload automatically. Prereq: a small dirty-draft registry so a half-typed invoice in a background tab is never lost. _Effort: small, after the registry._

## P2 — Speed & polish

7. **Split the main bundle** — lazy-load Stock, Purchases, Invoicing, Shows like the already-lazy apps; add skeleton screens. Biggest effect on slow connections and older laptops. _Effort: ~1 session._
8. **Shared UI primitives** — one `<Modal>`, one toast hook, one `<FileDrop>` in `src/ui.jsx` replacing ~34 hand-rolled modals and ~18 toast copies. Invisible to users; every future feature ships faster. _Effort: incremental, adopt as files are touched._
9. **Feature-level permissions** — `deniedFeatures` list on staff profiles (e.g. `shows.earnings`, `stock.costPrice`) editable from the Users screen, replacing hardcoded rules. _Effort: small-medium._
10. **Usage analytics** — Vercel Web Analytics + module-open events into the activity feed; after two weeks of data, reorder this roadmap by what's actually used. _Effort: tiny._

## Explicitly not recommended now

- Normalized database rewrite — per-item versioned saves (#4) capture most of the value at a fraction of the risk.
- Third-party observability SaaS — the activity feed + daily AI ops-check cover this scale.
