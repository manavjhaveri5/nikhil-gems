#!/usr/bin/env node
/* The day's Claude conversations, boiled down for Raj to read.

   Reads ~/.claude/projects/<project>/<session>.jsonl (main sessions, not
   subagents) from where it last stopped, keeps only what Manav typed and what
   Claude answered in words (no tool output, no thinking), blanks anything that
   looks like a secret, and writes plain-text parts to ~/.raj/digest/.
   Nothing is sent anywhere; Claude reads the parts and writes notes with
   raj-push.mjs.

   node extract-transcripts.mjs                      everything new since last time
   node extract-transcripts.mjs --session <id>       one session (the /raj-update skill)
   node extract-transcripts.mjs --max-parts 3        stop after 3 parts (backfill a bit per night)
   node extract-transcripts.mjs --commit             mark the last run's parts as read
                                                     (only after the notes are pushed)

   Sessions that are Raj's own jobs (first message carries "[raj-job]") are skipped. */
import { readdirSync, statSync, openSync, readSync, closeSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { RAJ_HOME, redact, readRajState, saveRajState } from "./raj-common.mjs";

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const has = name => argv.includes(name);
const PROJECTS = join(homedir(), ".claude", "projects");
const OUT = join(RAJ_HOME, "digest");
const STATE = "transcripts.json";

if (has("--commit")) {
  const manifest = readRajState("digest-manifest.json", null);
  if (!manifest) { console.log(JSON.stringify({ ok: false, error: "nothing to commit" })); process.exit(0); }
  const state = readRajState(STATE, { files: {} });
  for (const [f, v] of Object.entries(manifest.files)) state.files[f] = v;
  state.committed_at = new Date().toISOString();
  saveRajState(STATE, state);
  saveRajState("digest-manifest.json", null);
  console.log(JSON.stringify({ ok: true, files: Object.keys(manifest.files).length }));
  process.exit(0);
}

const session = opt("--session", "");
const maxParts = Math.max(1, +opt("--max-parts", 6));
const partBytes = Math.max(20, +opt("--part-kb", 110)) * 1024;
const state = readRajState(STATE, { files: {} });

const files = [];
for (const proj of existsSync(PROJECTS) ? readdirSync(PROJECTS) : []) {
  const dir = join(PROJECTS, proj);
  let names = [];
  try { names = readdirSync(dir).filter(n => n.endsWith(".jsonl")); } catch { continue; }
  for (const n of names) {
    if (session && !n.includes(session)) continue;
    const p = join(dir, n), st = statSync(p);
    const was = state.files[p];
    if (was?.skip) continue;
    if (was && was.offset >= st.size) continue;
    files.push({ path: p, project: proj, size: st.size, mtime: st.mtimeMs, offset: was?.offset || 0 });
  }
}
files.sort((a, b) => a.mtime - b.mtime);   // oldest first, so a capped run catches up in order

const IST = 5.5 * 3600e3;
const when = iso => { const t = Date.parse(iso || ""); return t ? new Date(t + IST).toISOString().slice(0, 16).replace("T", " ") : ""; };
const strip = s => String(s || "")
  .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
  .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "")
  .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "")
  .replace(/<\/?command-(name|message|args)>/g, "")
  .trim();
const clip = (s, n) => s.length > n ? s.slice(0, n) + " …" : s;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const parts = [];
let buf = "";
const manifest = { files: {} };
let stopped = false, sessions = 0;
const flush = () => {
  if (!buf.trim()) return;
  const p = join(OUT, `part-${String(parts.length + 1).padStart(2, "0")}.txt`);
  writeFileSync(p, buf);
  parts.push(p);
  buf = "";
};

for (const f of files) {
  if (stopped) break;
  const fd = openSync(f.path, "r");
  const len = f.size - f.offset;
  const data = Buffer.alloc(len);
  readSync(fd, data, 0, len, f.offset);
  closeSync(fd);
  let pos = 0, consumed = f.offset, header = false, title = "", lines = [];
  const id = basename(f.path, ".jsonl");
  let skip = false, firstUserSeen = !!f.offset;
  while (pos < data.length) {
    const nl = data.indexOf(10, pos);
    if (nl < 0) break;                       // a line still being written: leave it for next time
    const raw = data.subarray(pos, nl).toString("utf8");
    pos = nl + 1;
    let o;
    try { o = JSON.parse(raw); } catch { consumed = f.offset + pos; continue; }
    if (o.type === "custom-title" && o.customTitle) title = o.customTitle;
    if (o.isSidechain || o.isMeta) { consumed = f.offset + pos; continue; }
    let text = "", who = "";
    if (o.type === "user") {
      const c = o.message?.content;
      if (typeof c === "string") text = strip(c);
      else if (Array.isArray(c)) text = strip(c.filter(b => b?.type === "text").map(b => b.text).join("\n"));
      who = "Manav";
      if (text && !firstUserSeen) { firstUserSeen = true; if (text.includes("[raj-job]")) { skip = true; break; } }
      if (/^\[?Request interrupted/.test(text)) text = "";
      text = clip(text, 2500);
    } else if (o.type === "assistant") {
      const c = o.message?.content;
      if (Array.isArray(c)) text = c.filter(b => b?.type === "text").map(b => b.text).join("\n").trim();
      who = "Claude";
      text = clip(text, 1600);
    }
    if (text) lines.push(`[${when(o.timestamp)}] ${who}: ${redact(text)}`);
    consumed = f.offset + pos;
    // Part full: write what this session has so far and maybe stop.
    if (buf.length + lines.join("\n").length > partBytes) {
      if (!header) { buf += `\n=== Session ${title || id.slice(0, 8)} (${id.slice(0, 8)}) · ${f.project} ===\n`; header = true; }
      buf += lines.join("\n") + "\n";
      lines = [];
      flush();
      if (parts.length >= maxParts) { stopped = true; break; }
    }
  }
  if (skip) { manifest.files[f.path] = { offset: f.size, skip: true }; continue; }
  if (lines.length) {
    if (!header) buf += `\n=== Session ${title || id.slice(0, 8)} (${id.slice(0, 8)}) · ${f.project} ===\n`;
    buf += lines.join("\n") + "\n";
    sessions++;
  } else if (header) sessions++;
  manifest.files[f.path] = { offset: consumed };
}
if (!stopped) flush();
manifest.at = new Date().toISOString();
saveRajState("digest-manifest.json", manifest);
console.log(JSON.stringify({
  parts, sessions, files_read: Object.keys(manifest.files).length,
  more_left: stopped || files.length > Object.keys(manifest.files).length,
  next: "read the parts, push notes with raj-push.mjs, then run this script with --commit",
}, null, 1));
