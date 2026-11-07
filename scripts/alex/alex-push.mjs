#!/usr/bin/env node
/* Alex writes to the ERP. Nothing here emails, messages, publishes or spends.

   node scripts/alex/alex-push.mjs opps <file.json>
     [ { id?, title, segment, kind: experiment|investment|opex, budget_inr, priority (1 = highest),
         opportunity, market, competition, economics, execution, resources, risks,
         recommendation, success_criteria, next_action: { what, owner, due }, status?, result? } ... ]
     New items are "proposed" until Sir approves on Alex's page. Reusing an id updates it
     (Sir's status and feedback are kept unless status is given).
   node scripts/alex/alex-push.mjs partners <file.json>
     [ { id?, name, type, city, url?, tier: high|approach|long_term|rejected, rank?, why, first_step,
         stage?: not_contacted|drafted|contacted|talking|trial|customer|no, evidence?, next_action?, due? } ... ]
     Sir's stage and notes are kept unless given.
   node scripts/alex/alex-push.mjs notes <file.json>
     [ { id?, kind: decision|lesson|knowledge|followup|handoff, title, body, to?: soniya|raj|sir, status?, due? } ... ]
   node scripts/alex/alex-push.mjs review <file.json>
     { date: YYYY-MM-DD, headline, review_md, metrics?: {...}, decisions_for_sir?: [ { question, options, recommend } ] } */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { supa, row, upsert, AKEYS, OPP_KINDS, OPP_STATUS, TIERS, PARTNER_STAGES, NOTE_KINDS } from "./alex-common.mjs";

const [cmd, file] = process.argv.slice(2);
const sb = supa();
const now = new Date().toISOString();
const slug = (p, t) => `${p}-${createHash("sha1").update(`${p}|${String(t).toLowerCase().trim()}`).digest("hex").slice(0, 10)}`;
const data = JSON.parse(readFileSync(file, "utf8"));
const out = [];
const need = (o, ks, what) => { for (const k of ks) if (o[k] == null || o[k] === "") throw new Error(`${what} "${o.title || o.name}" needs ${k}`); };

if (cmd === "opps") {
  for (const o of data) {
    need(o, ["title", "opportunity", "economics", "recommendation", "success_criteria", "next_action"], "opportunity");
    if (o.kind && !OPP_KINDS.includes(o.kind)) throw new Error(`bad kind ${o.kind}`);
    if (o.status && !OPP_STATUS.includes(o.status)) throw new Error(`bad status ${o.status}`);
    const id = o.id || slug("opp", o.title);
    const old = await row(sb, AKEYS.opps, id);
    const item = { ...old, ...o, id, status: o.status || old?.status || "proposed", feedback: old?.feedback || null,
      created_at: old?.created_at || now, updated_at: now, by: "alex" };
    await upsert(sb, AKEYS.opps, item, !old);
    out.push({ id, title: item.title, status: item.status, updated: !!old });
  }
} else if (cmd === "partners") {
  for (const p of data) {
    need(p, ["name", "type", "tier", "why"], "partner");
    if (!TIERS.includes(p.tier)) throw new Error(`bad tier ${p.tier}`);
    if (p.stage && !PARTNER_STAGES.includes(p.stage)) throw new Error(`bad stage ${p.stage}`);
    const id = p.id || slug("partner", p.name);
    const old = await row(sb, AKEYS.partners, id);
    const item = { ...old, ...p, id, stage: p.stage || old?.stage || "not_contacted", sir_note: old?.sir_note || null,
      created_at: old?.created_at || now, updated_at: now };
    await upsert(sb, AKEYS.partners, item, false);
    out.push({ id, name: item.name, tier: item.tier, stage: item.stage, updated: !!old });
  }
} else if (cmd === "notes") {
  for (const n of data) {
    if (!NOTE_KINDS.includes(n.kind)) throw new Error(`bad kind ${n.kind}`);
    const id = n.id || slug(n.kind, n.title);
    const old = await row(sb, AKEYS.notes, id);
    const item = { ...old, ...n, id, status: n.status || old?.status || (["followup", "handoff"].includes(n.kind) ? "open" : "noted"), created_at: old?.created_at || now, updated_at: now };
    await upsert(sb, AKEYS.notes, item, !old);
    out.push({ id, title: item.title, status: item.status, updated: !!old });
  }
} else if (cmd === "review") {
  need(data, ["date", "headline", "review_md"], "review");
  const old = await row(sb, AKEYS.reviews, data.date);
  await upsert(sb, AKEYS.reviews, { ...old, ...data, id: data.date, updated_at: now, created_at: old?.created_at || now }, !old);
  out.push({ review: data.date, updated: !!old });
} else throw new Error("use: opps | partners | notes | review <file.json>");
console.log(JSON.stringify({ ok: true, out }, null, 1));
