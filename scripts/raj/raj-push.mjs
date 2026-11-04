#!/usr/bin/env node
/* Raj writes to the ERP.

   node scripts/raj/raj-push.mjs briefing <file.json>
     { headline, narrative_md, highlights:[...], telegram:"short text" }
     → raj-briefings-v1 row for today (IST), generated_by "claude"; Telegram if set up.
   node scripts/raj/raj-push.mjs notes <file.json>
     [ { id?, kind, title, body, channel?, status?, due?, source? } ... ]
     kind: followup | problem | solution | decision | experiment | knowledge | lesson
   node scripts/raj/raj-push.mjs proposals <file.json>
     [ { channel: "etsy"|"etsy_ee", listing_id, title, field: "tags"|"title", current, proposed, reason, check } ... ]
     → raj-proposals-v1, status "pending" until Sir approves or rejects it on the Raj page.
   node scripts/raj/raj-push.mjs report <file.json>
     { headline, narrative_md, highlights } → raj-briefings-v1 row "week-<date>" (the weekly review)
     An id that exists is updated (created_at kept); without an id one is made
     from kind + title. status "done" closes a follow-up.
   node scripts/raj/raj-push.mjs telegram "text" */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { supa, row, upsert, KEYS, istDay, telegram } from "./raj-common.mjs";

const [cmd, arg] = process.argv.slice(2);
const sb = supa();
const now = new Date().toISOString();
const KINDS = new Set(["followup", "problem", "solution", "decision", "experiment", "knowledge", "lesson"]);
const slugId = (kind, title) => `${kind}-${createHash("sha1").update(`${kind}|${String(title).toLowerCase().trim()}`).digest("hex").slice(0, 12)}`;

if (cmd === "briefing") {
  const b = JSON.parse(readFileSync(arg, "utf8"));
  const today = istDay();
  const snap = await row(sb, KEYS.snapshots, today);
  const item = {
    id: today, day: snap?.day || null, at: now, generated_by: "claude",
    headline: String(b.headline || "").slice(0, 200), narrative_md: String(b.narrative_md || ""),
    highlights: Array.isArray(b.highlights) ? b.highlights.slice(0, 12) : [], snapshot_id: snap ? today : null,
  };
  if (!item.narrative_md) throw new Error("narrative_md is empty");
  await upsert(sb, KEYS.briefings, item, true);
  const tg = b.telegram ? await telegram(b.telegram) : { skipped: "no telegram text" };
  console.log(JSON.stringify({ ok: true, id: today, telegram: tg }));
} else if (cmd === "notes") {
  const list = JSON.parse(readFileSync(arg, "utf8"));
  const done = [];
  for (const n of Array.isArray(list) ? list : [list]) {
    if (!n?.title || !KINDS.has(n.kind)) { done.push({ skipped: n?.title || "(no title)", why: "needs title and a known kind" }); continue; }
    const id = n.id || slugId(n.kind, n.title);
    const was = await row(sb, KEYS.notes, id);
    const item = {
      ...(was || {}), ...n, id,
      status: n.status || was?.status || (n.kind === "followup" ? "open" : "noted"),
      created_at: was?.created_at || n.created_at || now, updated_at: now,
      ...(n.status === "done" && was?.status !== "done" ? { done_at: now } : {}),
    };
    await upsert(sb, KEYS.notes, item, true);
    done.push({ id, kind: item.kind, title: item.title, status: item.status, updated: !!was });
  }
  console.log(JSON.stringify({ ok: true, notes: done }, null, 1));
} else if (cmd === "proposals") {
  const list = JSON.parse(readFileSync(arg, "utf8"));
  const done = [];
  for (const p of Array.isArray(list) ? list : [list]) {
    if (!p?.listing_id || !["tags", "title"].includes(p.field) || !["etsy", "etsy_ee"].includes(p.channel) || p.proposed == null) { done.push({ skipped: p?.listing_id, why: "needs channel etsy|etsy_ee, listing_id, field tags|title, proposed" }); continue; }
    if (p.field === "tags") {
      const t = [...new Set((p.proposed || []).map(x => String(x).toLowerCase().trim()).filter(x => x && x.length <= 20))];
      if (t.length !== (p.proposed || []).length || t.length > 13) { done.push({ skipped: p.listing_id, why: "tags must be 13 or fewer, unique, 20 characters max" }); continue; }
      p.proposed = t;
    }
    if (p.field === "title" && String(p.proposed).length > 140) { done.push({ skipped: p.listing_id, why: "title over 140" }); continue; }
    const id = `${p.channel}:${p.listing_id}:${p.field}`;
    const was = await row(sb, "raj-proposals-v1", id);
    if (was && was.status !== "pending" && JSON.stringify(was.proposed) === JSON.stringify(p.proposed)) { done.push({ id, unchanged: was.status }); continue; }
    await upsert(sb, "raj-proposals-v1", { ...p, id, status: "pending", created_at: now }, true);
    done.push({ id, status: "pending" });
  }
  console.log(JSON.stringify({ ok: true, proposals: done }, null, 1));
} else if (cmd === "report") {
  const b = JSON.parse(readFileSync(arg, "utf8"));
  const id = `week-${istDay()}`;
  await upsert(sb, KEYS.briefings, { id, day: istDay(), at: now, generated_by: "weekly", headline: String(b.headline || "").slice(0, 200),
    narrative_md: String(b.narrative_md || ""), highlights: Array.isArray(b.highlights) ? b.highlights.slice(0, 12) : [] }, true);
  const tg = b.telegram ? await telegram(b.telegram) : { skipped: "no telegram text" };
  console.log(JSON.stringify({ ok: true, id, telegram: tg }));
} else if (cmd === "telegram") {
  console.log(JSON.stringify(await telegram(arg)));
} else {
  console.error("usage: raj-push.mjs briefing <file> | notes <file> | telegram <text>");
  process.exit(1);
}
