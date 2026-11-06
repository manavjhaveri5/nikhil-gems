/* Girton's proposals: changes he recommends, which Sir approves or declines on
   the Girton page. app_rows "girton-proposals-v1", one row per proposal:

   { id, title, why, area, saving_usd_month, saving_note, effort, risk,
     kind: "config" | "code",
     changes: [{ path, value }]   config only: girton-config-v1 settings applied on approval
     plan: "…"                    code only: what Claude will do when it builds it
     status: proposed | approved | building | done | declined | failed,
     created, decided_at, done_at, result, undo }

   A config proposal takes effect the moment it's approved (and can be undone).
   A code proposal is queued; a Claude session builds approved ones one at a
   time (scripts/girton/proposals.mjs next / mark), deploys, and marks them
   done with the commit. */
import { readRows, upsertRow } from "./app-rows.js";
import { aiConfig, setConfig, getPath } from "./girton-config.js";

export const PROPOSALS_KEY = "girton-proposals-v1";

export async function decide(sb, id, decision, who = "Sir") {
  const all = await readRows(sb, PROPOSALS_KEY);
  const p = all.find(x => x.id === id);
  if (!p) throw new Error("No such proposal.");
  const now = Date.now();
  if (decision === "approve") {
    if (p.status !== "proposed" && p.status !== "declined" && p.status !== "failed") throw new Error(`Already ${p.status}.`);
    if (p.kind === "config") {
      const cfg = await aiConfig();
      const undo = (p.changes || []).map(c => ({ path: c.path, value: getPath(cfg, c.path) ?? null }));
      for (const c of p.changes || []) await setConfig(c.path, c.value);
      Object.assign(p, { status: "done", decided_at: now, done_at: now, decided_by: who, undo, result: "Applied instantly. Undo any time." });
    } else {
      Object.assign(p, { status: "approved", decided_at: now, decided_by: who, result: "Queued for Claude. Say \"build Girton's approved changes\" in a Claude session." });
    }
  } else if (decision === "decline") {
    Object.assign(p, { status: "declined", decided_at: now, decided_by: who });
  } else if (decision === "undo") {
    if (p.kind === "config" && p.status === "done") {
      for (const u of p.undo || []) await setConfig(u.path, u.value);
      Object.assign(p, { status: "proposed", undo: null, done_at: null, result: "Undone." });
    } else if (p.status === "approved") {
      Object.assign(p, { status: "proposed", decided_at: null, result: "" });
    } else throw new Error("Nothing to undo.");
  } else throw new Error("Unknown decision.");
  await upsertRow(sb, PROPOSALS_KEY, p, false);
  return p;
}

/* Add or refresh proposals from the audit. A proposal Sir has already
   decided keeps its status; its text and numbers are refreshed. */
export async function upsertProposals(sb, list) {
  const all = await readRows(sb, PROPOSALS_KEY);
  const byId = new Map(all.map(x => [x.id, x]));
  let added = 0;
  for (const p of list) {
    const was = byId.get(p.id);
    const keep = was ? { status: was.status, created: was.created, decided_at: was.decided_at, decided_by: was.decided_by, done_at: was.done_at, result: was.result, undo: was.undo, commit: was.commit } : { status: "proposed", created: Date.now() };
    if (!was) added++;
    await upsertRow(sb, PROPOSALS_KEY, { ...p, ...keep }, false);
  }
  return added;
}
