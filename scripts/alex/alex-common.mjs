/* Alex's storage. Same tables and helpers as Raj (scripts/raj/raj-common.mjs).
   app_rows  alex-opps-v1      opportunity pipeline, each in the brief's 10-step structure
   app_rows  alex-partners-v1  partner pipeline: tier high | approach | long_term | rejected
   app_rows  alex-notes-v1     decision | lesson | knowledge | followup | handoff (to Soniya or Raj)
   app_rows  alex-reviews-v1   weekly growth reviews, id = YYYY-MM-DD (the Monday) */
export { supa, rows, row, upsert, istDay, addDays, LIVE, redact } from "../raj/raj-common.mjs";
export const AKEYS = { opps: "alex-opps-v1", partners: "alex-partners-v1", notes: "alex-notes-v1", reviews: "alex-reviews-v1" };
export const OPP_KINDS = ["experiment", "investment", "opex"];
export const OPP_STATUS = ["proposed", "changes", "approved", "running", "done", "declined"];
export const TIERS = ["high", "approach", "long_term", "rejected"];
export const PARTNER_STAGES = ["not_contacted", "drafted", "contacted", "talking", "trial", "customer", "no"];
export const NOTE_KINDS = ["decision", "lesson", "knowledge", "followup", "handoff"];
export const BLUEPRINT_URL = "https://claude.ai/artifact/YLGzWcYqG5LCDMeyb6J6FY";
