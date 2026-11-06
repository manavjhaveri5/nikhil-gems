#!/usr/bin/env node
/* Girton's code audit: a static pass over the ERP (and the Railway bot, if
   it's on this Mac) for what costs money or Claude tokens. Writes the
   findings to app_rows "girton-v1" id "audit", which the Girton page shows.

   node scripts/girton/audit.mjs            run and save
   node scripts/girton/audit.mjs --dry      print only

   Every check is a plain rule over the files; nothing here calls an AI. */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { homedir } from "node:os";
import { ERP_DIR, supa, upsert, istDay } from "../raj/raj-common.mjs";
import { upsertProposals } from "../../lib/girton-proposals.js";

const sb = supa();
const cfgRow = (await sb.from("app_data").select("value").eq("key", "girton-config-v1").maybeSingle()).data?.value || {};

const DRY = process.argv.includes("--dry");
const BOT = join(homedir(), "Downloads/project/bot/server.py");
const findings = [];
const add = f => findings.push(f);
const rel = p => relative(ERP_DIR, p);

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (/^(node_modules|dist|\.git|\.vercel|supabase|public|api-disabled)$/.test(n)) continue;
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(jsx?|mjs)$/.test(n)) out.push(p);
  }
  return out;
}
const files = walk(ERP_DIR).map(p => ({ p, src: readFileSync(p, "utf8") }));
const lineOf = (src, i) => src.slice(0, i).split("\n").length;

/* 1. Big files: every Claude session that opens one pays for all of it. */
const isData = p => /Data\.js$|\.json$/.test(p);
// Only a static import puts a data file in every phone's download; import() loads it on demand.
const dataFiles = files.filter(f => isData(f.p) && f.src.length > 200e3)
  .filter(d => { const base = d.p.split("/").pop().replace(/\.js$/, ""); return files.some(f => new RegExp(`^import[^\\n]*["'][^"']*${base}(\\.js)?["']`, "m").test(f.src)); });
if (dataFiles.length) add({
  area: "Vercel", level: "info", title: `${dataFiles.length} seed-data files are bundled into the app (${Math.round(dataFiles.reduce((s, f) => s + f.src.length, 0) / 1024)} kB)`,
  detail: "Old CSV imports compiled into JavaScript. If a screen imports them, every phone downloads them; they also show up in code searches and cost tokens when a session greps the repo.",
  fix: "If nothing imports them any more, delete them; otherwise load them only inside the import screen.", where: dataFiles.map(f => rel(f.p)).join(", "),
});
const big = files.filter(f => !isData(f.p)).map(f => ({ ...f, lines: f.src.split("\n").length, tokens: Math.round(f.src.length / 3.6) }))
  .filter(f => f.lines > 3000).sort((a, b) => b.lines - a.lines);
for (const f of big) add({
  area: "Claude tokens", level: f.lines > 10000 ? "warn" : "info",
  title: `${rel(f.p)} is ${f.lines.toLocaleString("en-IN")} lines (~${Math.round(f.tokens / 1000)}k tokens)`,
  detail: `A coding session that reads this file whole spends about ${Math.round(f.tokens / 1000)}k tokens before doing anything, and an edit that needs context around it re-reads large parts. Split by screen so a change touches a 300–800 line file instead.`,
  fix: f.lines > 10000 ? "Move each screen (MODS entry) into its own src/ file behind React.lazy, the way Raj, Customers and Girton already are; one screen per session." : "Split the largest sub-components into their own files when next touched.",
  where: rel(f.p), saving: f.lines > 10000 ? "most of a Pro session's budget on big edits" : "",
});

/* 2. Vercel's Hobby function cap. */
const fns = readdirSync(join(ERP_DIR, "api")).filter(n => /\.(js|mjs|ts)$/.test(n) && !n.startsWith("_"));
add({
  area: "Vercel", level: fns.length >= 12 ? "warn" : "good",
  title: `${fns.length} of 12 serverless functions used`,
  detail: fns.length >= 12 ? "The Hobby plan allows 12 functions and all are used: a new endpoint must be folded into an existing file (as /api/embed and Girton's actions are), or the plan upgraded at $20/month. Folding is free; keep doing it." : "Room for more.",
  fix: fns.length >= 12 ? "Keep new server actions inside listing-manager.js or claude.js routes; never add a file to api/." : "",
  where: fns.join(", "),
});

/* 3. AI calls that skip the meter (they'd be invisible to Girton). */
for (const f of files) {
  if (/ai-meter\.js$/.test(f.p) || /\/src\//.test(f.p) && !/api\.openai\.com|api\.anthropic\.com/.test(f.src)) continue;
  const re = /\bfetch\(\s*["'`]https:\/\/api\.(openai|anthropic)\.com/g;
  let m;
  while ((m = re.exec(f.src))) add({
    area: "AI meter", level: "warn", title: `Unmetered AI call in ${rel(f.p)}:${lineOf(f.src, m.index)}`,
    detail: "This call goes to the AI provider directly, so its cost never shows on the Girton page.",
    fix: "Use aiFetch(url, init, \"feature-name\") from lib/ai-meter.js.", where: `${rel(f.p)}:${lineOf(f.src, m.index)}`,
  });
}

/* 4. Expensive models and token budgets, by call site. */
const caption = files.find(f => /captionWriter\.js$/.test(f.p));
if (caption && /gpt-5\.5/.test(caption.src) && !cfgRow.models?.captions) add({
  area: "OpenAI", level: "warn", title: "Social captions run on gpt-5.5 with medium reasoning",
  detail: "gpt-5.5 is $5 in / $30 out per million tokens, the most expensive model in the ERP, and the caption call allows 8,000 thinking tokens on top of the caption. One caption can cost up to about $0.27 (₹24); a gpt-5-mini caption costs about $0.01.",
  fix: "Set OPENAI_WRITER_MODEL=gpt-5-mini in Vercel, or drop reasoning to \"low\" and the +8000 to +2000. Compare a week of captions on the Girton page first.",
  where: "lib/captionWriter.js", saving: "≈ 90% of caption spend",
});
const studio = files.find(f => /api\/claude\.js$/.test(f.p));
if (studio && /form\.append\("quality", "high"\)/.test(studio.src)) add({
  area: "OpenAI", level: "info", title: "Studio shots use gpt-image-1.5 at high quality",
  detail: "A 1024×1024 high-quality edit is the single most expensive call the ERP makes (roughly $0.15–0.25 each). Fine for final listing photos; costly for trial runs.",
  fix: "Offer a 'draft' button at medium quality (about a quarter of the price) and keep high for the final shot.",
  where: "api/claude.js handleStudioShot", saving: "≈ 60–75% per trial shot",
});
for (const f of files) {
  const re = /model:\s*["']gpt-4o["']/g; let m;
  while ((m = re.exec(f.src))) add({ area: "OpenAI", level: "info", title: `gpt-4o in ${rel(f.p)}:${lineOf(f.src, m.index)}`,
    detail: "gpt-4o costs 6× gpt-4.1-mini for similar quality on extraction and short replies.", fix: "Switch to gpt-4.1-mini unless this call needs gpt-4o's vision quality.", where: `${rel(f.p)}:${lineOf(f.src, m.index)}`, saving: "≈ 80%" });
}

/* 5. The Railway finance bot (separate repo). */
if (existsSync(BOT)) {
  const src = readFileSync(BOT, "utf8");
  const n4o = (src.match(/["']gpt-4o["']/g) || []).length;
  if (n4o) add({ area: "Railway bot", level: "warn", title: `Telegram finance bot uses gpt-4o in ${n4o} places`,
    detail: "Receipts and payment texts are short extraction jobs; gpt-4o-mini or gpt-4.1-mini reads them as well for about 1/15 or 1/6 of the price. The bot's calls are not on the Girton meter yet (separate server).",
    fix: "Change the model to gpt-4.1-mini in bot/server.py, and give the bot its own OpenAI key (\"railway-bot\") so its spend is visible per key.", where: "~/Downloads/project/bot/server.py", saving: "≈ 80–90% of the bot's AI spend" });
  if (/max_retries\s*=\s*6/.test(src)) add({ area: "Railway bot", level: "info", title: "Bot retries each OpenAI call up to 6 times",
    detail: "With a bad key or exhausted quota, every message makes 7 attempts and then reports 'still busy', which hides the real error (this is what happened on 6 Nov).",
    fix: "max_retries=2, and report 401/insufficient_quota errors as such instead of 'busy'.", where: "~/Downloads/project/bot/server.py" });
}

/* 6. Database egress: polling and select("*"). */
for (const f of files) {
  const re = /setInterval\([^,]+,\s*(\d[\d_]*)\s*\)/g; let m;
  while ((m = re.exec(f.src))) {
    const ms = +m[1].replace(/_/g, "");
    // What the timer runs: the inline callback, or the function it names.
    let body = m[0];
    const id = body.match(/setInterval\(\s*([A-Za-z_$][\w$]*)\s*,/)?.[1];
    if (id) { const def = f.src.lastIndexOf(`${id}=`, m.index) >= 0 ? f.src.lastIndexOf(`${id}=`, m.index) : f.src.lastIndexOf(`function ${id}`, m.index); if (def >= 0 && m.index - def < 4000) body = f.src.slice(def, def + 700); }
    if (ms < 60000 && /supabase|fetch\(|loadK/.test(body)) add({
      area: "Supabase", level: "info", title: `Polls every ${ms / 1000}s in ${rel(f.p)}:${lineOf(f.src, m.index)}`,
      detail: "Each open tab repeats this query on a timer, all day. Realtime (already used for app_data) or a slower interval saves database egress.",
      fix: "Use the existing realtime version bump, or poll no faster than once a minute while the tab is visible.", where: `${rel(f.p)}:${lineOf(f.src, m.index)}` });
  }
}
const stars = files.flatMap(f => [...f.src.matchAll(/\.select\(["']\*["']\)/g)].map(m => `${rel(f.p)}:${lineOf(f.src, m.index)}`));
if (stars.length) add({ area: "Supabase", level: "info", title: `${stars.length} queries select every column`,
  detail: "select(\"*\") downloads columns the screen never shows; on wide tables that is most of the egress.", fix: "Name the columns each screen needs.", where: stars.join(", ") });

/* 7. Image transforms (the quota that restricted the ERP once). */
const transforms = files.filter(f => /\/render\/image\//.test(f.src)).map(f => rel(f.p));
add({ area: "Supabase", level: transforms.length ? "critical" : "good",
  title: transforms.length ? `Supabase image transforms used in ${transforms.join(", ")}` : "No Supabase image transforms in the code",
  detail: transforms.length ? "Transforms are capped at 100 origin images a month; going over restricted the whole project before." : "Thumbnails go through /img/sb, so the 100/month transform quota is safe.",
  fix: transforms.length ? "Route through /img/sb (src/photoUrls.js sbThumb)." : "" });

/* 8. Client bundle (if built). */
const dist = join(ERP_DIR, "dist/assets");
if (existsSync(dist)) {
  const chunks = readdirSync(dist).filter(n => n.endsWith(".js")).map(n => ({ n, kb: Math.round(statSync(join(dist, n)).size / 1024) })).sort((a, b) => b.kb - a.kb);
  const heavy = chunks.filter(c => c.kb > 600);
  if (heavy.length) add({ area: "Vercel", level: "info", title: `${heavy.length} JavaScript chunks over 600 kB`,
    detail: `Largest: ${heavy.slice(0, 4).map(c => `${c.n} ${c.kb} kB`).join(", ")}. Big chunks cost bandwidth on every deploy (the service worker re-downloads them) and slow the phone app.`,
    fix: "Lazy-load the heavy libraries (PDF, charts, image tools) inside the screens that use them." });
}

const order = { critical: 0, warn: 1, info: 2, good: 3 };
findings.sort((a, b) => order[a.level] - order[b.level]);
const audit = {
  id: "audit", day: istDay(), at: Date.now(), findings,
  vercel: { functions: fns.length, limit: 12 },
  biggest_files: big.slice(0, 8).map(f => ({ file: rel(f.p), lines: f.lines, tokens: f.tokens })),
};
/* ── Proposals: what Girton recommends doing, for Sir to approve ─────────────
   Each is tied to a finding above, so a fixed problem stops being proposed
   (an existing proposal keeps its status either way). */
const has = re => findings.some(f => re.test(f.title));
const proposals = [];
if (has(/Social captions run on gpt-5\.5/)) proposals.push({
  id: "captions-gpt5-mini", kind: "config", area: "OpenAI", effort: "instant", risk: "low",
  title: "Write social captions with gpt-5-mini instead of gpt-5.5",
  why: "Captions use gpt-5.5 ($5 in / $30 out per million tokens) with up to 8,000 thinking tokens, so one caption can cost about $0.27 (₹24). gpt-5-mini with light thinking writes the same length for about $0.01. The voice guide and examples stay the same.",
  saving_note: "≈ 95% of caption spend. Girton will show the real difference after a week.",
  changes: [{ path: "models.captions", value: "gpt-5-mini" }, { path: "captions_reasoning", value: "low" }],
});
if (has(/Studio shots use gpt-image/)) proposals.push({
  id: "studio-draft-quality", kind: "code", area: "OpenAI", effort: "small", risk: "none",
  title: "Add a cheaper Draft studio shot",
  why: "Every studio shot runs at high quality, about $0.15–0.25 each, even for trial runs. A Draft button at medium quality costs about a quarter of that; the final shot stays high quality.",
  saving_note: "≈ 70% on each trial shot",
  plan: "In the photo editor add a 'Draft' option that sends quality=medium to /api/claude?_ai=studio (make api/claude.js handleStudioShot accept body.quality: medium or high, default high). Keep the existing button as 'Final (high)'. Build, deploy, push.",
});
if (has(/Bot retries each OpenAI call/)) proposals.push({
  id: "bot-retries", kind: "code", area: "Railway bot", effort: "small", risk: "low",
  title: "Stop the finance bot retrying 7 times and say what really failed",
  why: "On 6 Nov a bad key looked like 'OpenAI is still busy' because the bot retries each call 6 times and reports every error as busy. With 2 retries and honest messages (bad key, out of credit, rate limit), you see the real problem at once.",
  saving_note: "Fewer wasted calls; outages found in minutes, not days",
  plan: "In ~/Downloads/project/bot/server.py: AsyncOpenAI(max_retries=2); in the OpenAI error handler, map 401 to 'OpenAI key rejected — check OPENAI_KEY in Railway', insufficient_quota to 'OpenAI credit is used up', 429 to 'busy, try again in a minute', anything else to the short error text. py_compile, commit, push main (Railway deploys).",
});
if (has(/Polls every 30s in nikhil-gems-v6\.jsx/)) proposals.push({
  id: "activity-poll", kind: "code", area: "Supabase", effort: "small", risk: "low",
  title: "Stop re-downloading the activity log every 30 seconds",
  why: "The activity feed already updates live over realtime, but every open tab also re-downloads the whole log (ng-activity-v1, up to 500 entries) every 30 seconds, all day. Polling every 5 minutes, only while the tab is visible, keeps it just as current.",
  saving_note: "≈ 90% of that query's database egress",
  plan: "nikhil-gems-v6.jsx around the 'fallback poll every 30s' comment: poll every 300000 ms and skip when document.hidden; keep the realtime subscription. Build, deploy, push.",
});
if (Date.now() >= Date.parse("2026-11-11T00:00:00+05:30")) proposals.push({
  id: "drop-listings-bridge", kind: "code", area: "Supabase", effort: "small", risk: "medium",
  title: "Remove the old 1.5 MB listings copy from app_data",
  why: "Since 4 Nov listings live one row per piece in app_rows, but the old single 1.5 MB copy (app_data ng-listings-v1) is still kept as a bridge. Anything still reading it downloads 1.5 MB each time.",
  saving_note: "1.5 MB per read of the old key",
  plan: "grep for every reader of the app_data ng-listings-v1 copy (bot server.py, store sync, api/*). Switch any remaining reader to app_rows (lib/app-rows.js readRows). Only when nothing reads it: delete the app_data row. Build, deploy, push both repos if touched.",
});
if (has(/nikhil-gems-v6\.jsx is/)) proposals.push({
  id: "split-main-file", kind: "code", area: "Claude tokens", effort: "large", risk: "medium",
  title: "Split the 26,700-line main file, one screen per night",
  why: "nikhil-gems-v6.jsx is about 640k tokens. Any Claude session that edits it re-reads big parts of it, which is why long ERP sessions hit your Pro limits. Moving each screen into its own file (as Raj, Customers and Girton already are) makes each edit read 1–2% of that.",
  saving_note: "Most of a Pro session's tokens on ERP edits",
  plan: "Each run moves ONE screen (a MODS entry, largest first) out of nikhil-gems-v6.jsx into src/<Name>App.jsx behind React.lazy, with its helpers. No behaviour change. npm run build must pass and the screen must render in preview before deploying. Stop after one screen; the proposal stays 'approved' until the file is under 8,000 lines.",
});
if (has(/queries select every column/)) proposals.push({
  id: "select-columns", kind: "code", area: "Supabase", effort: "small", risk: "low",
  title: "Download only the columns each screen shows",
  why: `${findings.find(f => /select every column/.test(f.title))?.where.split(", ").length || "Several"} queries fetch every column (select *). Naming the columns cuts what each one downloads.`,
  saving_note: "Database egress on those screens",
  plan: "For each select(\"*\") the audit lists, name the columns the code uses. Build, deploy, push.",
});
proposals.push({
  id: "find-image-transforms", kind: "code", area: "Supabase", effort: "medium", risk: "low",
  title: "Find what is still using Supabase image transforms",
  why: "This billing cycle used 1,516 image transforms against the 100 included, which is what can restrict the project. The ERP's code no longer uses them, so they come from somewhere else: the store site, old saved URLs, or emails.",
  saving_note: "Keeps the ERP from being restricted again",
  plan: "Search the store site repo, Omnisend templates, the bot and stored URLs in app_data/app_rows/store_products for '/render/image/' or '/storage/v1/render'. Switch each to /img/sb (src/photoUrls.js sbThumb or the store's equivalent). Report what was found. Build, deploy, push.",
});
if (DRY) { console.log(JSON.stringify({ audit, proposals }, null, 1)); process.exit(0); }
await upsert(sb, "girton-v1", audit, false);
const added = await upsertProposals(sb, proposals);
console.log(`proposals: ${proposals.length} current, ${added} new`);
console.log(`audit saved: ${findings.length} findings (${findings.filter(f => f.level === "warn" || f.level === "critical").length} to act on)`);
