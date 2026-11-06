#!/usr/bin/env node
/* Girton's proposals, for the Claude session that builds approved ones.

   node scripts/girton/proposals.mjs next
       the oldest approved code proposal as JSON (or "none")
   node scripts/girton/proposals.mjs mark <id> <building|done|failed|approved> [--commit <sha>] [--result "<text>"]
       record progress; "approved" puts a multi-night job back in the queue
   node scripts/girton/proposals.mjs list
       every proposal's id, status and title */
import { supa, rows, upsert, telegram } from "../raj/raj-common.mjs";

const KEY = "girton-proposals-v1";
const sb = supa();
const [cmd, id, status] = process.argv.slice(2);
const flag = n => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const all = await rows(sb, KEY);

if (cmd === "list") {
  for (const p of all) console.log(`${p.status.padEnd(9)} ${p.kind.padEnd(6)} ${p.id.padEnd(24)} ${p.title}`);
} else if (cmd === "next") {
  const p = all.filter(x => x.kind === "code" && x.status === "approved").sort((a, b) => (a.decided_at || 0) - (b.decided_at || 0))[0];
  console.log(p ? JSON.stringify(p, null, 1) : "none");
} else if (cmd === "mark") {
  const p = all.find(x => x.id === id);
  if (!p || !["building", "done", "failed", "approved"].includes(status)) { console.error("usage: mark <id> <building|done|failed|approved>"); process.exit(1); }
  const commit = flag("commit"), result = flag("result");
  Object.assign(p, { status, ...(commit ? { commit } : {}), ...(result ? { result } : {}), ...(status === "done" ? { done_at: Date.now() } : {}) });
  await upsert(sb, KEY, p, false);
  if (status === "done" || status === "failed") {
    await telegram(`*Girton*: ${status === "done" ? "✅ built" : "❌ couldn't build"} “${p.title}”${result ? `\n${result}` : ""}${commit ? `\ncommit ${commit.slice(0, 7)}` : ""}`).catch(() => {});
  }
  console.log(`${id} → ${status}`);
} else {
  console.error("usage: next | mark <id> <status> | list");
  process.exit(1);
}
