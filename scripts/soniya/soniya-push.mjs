#!/usr/bin/env node
/* Soniya writes to the ERP. Nothing here posts or publishes anywhere.

   node scripts/soniya/soniya-push.mjs work <file.json>
     [ { id?, type, title, segment, purpose, date?, products?: [{id,title}],
         insight, concept, art_direction, copy: { headline, caption, supporting }, objective, execution,
         status? } ... ]
     type: campaign | post | carousel | reel | collection | naming | photo
     purpose: identity | educate | desire | discovery | sales | trust
     New items are "proposed" until Sir approves on her page. Reusing an id updates it
     (Sir's status and feedback are kept unless status is given).
   node scripts/soniya/soniya-push.mjs notes <file.json>
     [ { id?, kind, title, body, status?, due? } ... ]  kind: decision | lesson | knowledge | followup | campaign
   node scripts/soniya/soniya-push.mjs brand <file.json>
     { sections: [ { id, title, body_md } ... ] }  → the brand book (replaces it) */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { supa, row, upsert, SKEYS, WORK_TYPES, NOTE_KINDS } from "./soniya-common.mjs";

const [cmd, file] = process.argv.slice(2);
const sb = supa();
const now = new Date().toISOString();
const slug = (p, t) => `${p}-${createHash("sha1").update(`${p}|${String(t).toLowerCase().trim()}`).digest("hex").slice(0, 10)}`;
const data = JSON.parse(readFileSync(file, "utf8"));
const out = [];

if (cmd === "work") {
  for (const w of data) {
    if (!WORK_TYPES.includes(w.type)) throw new Error(`bad type ${w.type} on "${w.title}"`);
    if (!w.title || !w.concept) throw new Error(`"${w.title}" needs a title and a concept`);
    const id = w.id || slug(w.type, w.title);
    const old = await row(sb, SKEYS.work, id);
    const item = { ...old, ...w, id, status: w.status || old?.status || "proposed", feedback: old?.feedback || null,
      created_at: old?.created_at || now, updated_at: now, by: "soniya" };
    await upsert(sb, SKEYS.work, item, !old);
    out.push({ id, title: item.title, status: item.status, updated: !!old });
  }
} else if (cmd === "notes") {
  for (const n of data) {
    if (!NOTE_KINDS.includes(n.kind)) throw new Error(`bad kind ${n.kind}`);
    const id = n.id || slug(n.kind, n.title);
    const old = await row(sb, SKEYS.notes, id);
    const item = { ...old, ...n, id, status: n.status || old?.status || (n.kind === "followup" ? "open" : "noted"), created_at: old?.created_at || now, updated_at: now };
    await upsert(sb, SKEYS.notes, item, !old);
    out.push({ id, title: item.title, status: item.status, updated: !!old });
  }
} else if (cmd === "brand") {
  if (!Array.isArray(data.sections) || !data.sections.length) throw new Error("brand needs sections");
  const { error } = await sb.from("app_data").upsert({ key: SKEYS.brand, value: { ...data, updated_at: now } }, { onConflict: "key" });
  if (error) throw new Error(error.message);
  out.push({ brand: data.sections.length });
} else throw new Error("use: work | notes | brand <file.json>");
console.log(JSON.stringify({ ok: true, out }, null, 1));
