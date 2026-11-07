/* Soniya's storage. Same tables and helpers as Raj (scripts/raj/raj-common.mjs).
   app_rows  soniya-work-v1   her proposals: campaign | post | carousel | reel | collection | naming | photo
   app_rows  soniya-notes-v1  decision | lesson | knowledge | followup | campaign
   app_data  soniya-brand-v1  the brand book (editable on her page) */
export { supa, rows, row, upsert, istDay, addDays, LIVE, redact } from "../raj/raj-common.mjs";
export const SKEYS = { work: "soniya-work-v1", notes: "soniya-notes-v1", brand: "soniya-brand-v1" };
export const WORK_TYPES = ["campaign", "post", "carousel", "reel", "collection", "naming", "photo"];
export const NOTE_KINDS = ["decision", "lesson", "knowledge", "followup", "campaign"];
