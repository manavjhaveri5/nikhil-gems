import { adminClient } from "./auth.js";
import * as list from "./mailList.js";
import { sbThumb } from "./photoUrls.js";

/* The weekly "new pieces" email to retail buyers, and the opt-in that fills
   its list.

   Etsy's Seller Policy (2b) says a buyer's email from an order "may only be used
   for Etsy-related communications", and that without the buyer's consent a
   seller may not "add any Etsy member to your email or physical mailing list".
   So nobody is ever copied onto this list from Etsy or eBay order data. Buyers
   join themselves on studio.eartheditions.co/join (linked from the parcel card's
   QR code, the store and, if Sir agrees, the Etsy receipt note), confirm by
   email (double opt-in), and the consent is kept on the contact.

   The list is app_rows "mail-contacts-v1" (lib/mailList.js); the weekly issue
   is an ordinary Gmail send there, from team@eartheditions.co. Who gets it:
   contacts tagged new-pieces (joined here), newsletter (the store's own form)
   or store-customer (ticked marketing on an eartheditions.co account). Trade
   contacts are never in it unless they joined as well.

   The rhythm (pg_cron every 15 min calls tick()):
   - Thursday 10:00 IST: build the issue from pieces listed in the last 7 days,
     send a [Test] copy and an approve/skip email to the approver.
   - Friday 19:30 IST (09:00 New York): if approved, send it, a batch at a time.
   In "auto" mode the issue is approved as soon as it is built (the test copy
   still goes out). Settings are app_rows "mail-weekly-v1" id "settings". */

export const WEEKLY = "mail-weekly-v1";
export const JOINS = "mail-joins-v1";
const PUBLIC = "https://studio.eartheditions.co";
const STORE = "https://eartheditions.co";
export const LIST_TAG = "new-pieces";
export const AUDIENCE = [LIST_TAG, "newsletter", "store-customer"];
export const CONSENT_TEXT = "Email me new pieces from Earth Editions, about once a week. I can unsubscribe at any time.";
// Where someone signed up. Anything else is recorded as "web".
export const SOURCES = { etsy: "Etsy order", ebay: "eBay order", store: "eartheditions.co", card: "parcel card", "etsy-card": "parcel card (Etsy)", "ebay-card": "parcel card (eBay)", web: "website" };
const DEFAULTS = {
  mode: "approve",                 // "approve": waits for Sir's OK each week; "auto": sends by itself
  approver: list.FROM_EMAIL,
  buildDow: 4, buildAt: "10:00",   // Thursday, IST
  sendDow: 5, sendAt: "19:30",     // Friday, IST
  days: 7, paused: false,
  addressLine: "Earth Editions · eartheditions.co",
};
const JOIN_DAY_CAP = 150;          // confirmation emails a day, so the form can't be used to spam

const now = () => new Date().toISOString();
const norm = e => String(e || "").trim().toLowerCase();
const he = v => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const IST = 5.5 * 36e5;

async function getRow(db, key, id) {
  const { data, error } = await db.from("app_rows").select("data").eq("key", key).eq("id", id).eq("deleted", false).maybeSingle();
  if (error) throw new Error(error.message);
  return data?.data || null;
}
async function putRow(db, key, item) {
  const { error } = await db.rpc("app_rows_upsert", { p_key: key, p_item: item, p_prepend: false });
  if (error) throw new Error(error.message);
  return item;
}
export async function getSettings(db = adminClient()) {
  return { ...DEFAULTS, ...((await getRow(db, WEEKLY, "settings")) || {}), id: "settings" };
}
export async function setSettings(patch, db = adminClient()) {
  const s = await getSettings(db);
  const next = { ...s };
  if (patch.mode === "approve" || patch.mode === "auto") next.mode = patch.mode;
  if (typeof patch.paused === "boolean") next.paused = patch.paused;
  if (patch.approver !== undefined) { const a = norm(patch.approver); if (!list.OK.test(a)) throw new Error("Approver needs a valid email"); next.approver = a; }
  if (patch.addressLine !== undefined) next.addressLine = String(patch.addressLine).slice(0, 200);
  for (const k of ["buildAt", "sendAt"]) if (patch[k] !== undefined) { if (!/^\d{2}:\d{2}$/.test(patch[k])) throw new Error(`${k} must be HH:MM`); next[k] = patch[k]; }
  for (const k of ["buildDow", "sendDow"]) if (patch[k] !== undefined) next[k] = Math.max(1, Math.min(7, +patch[k] || 1));
  next.updated = now(); next.updatedBy = patch.by || "";
  // Every change of who decides is kept, so the record of Sir's choice survives.
  if (next.mode !== s.mode) next.modeHistory = [...(s.modeHistory || []), { mode: next.mode, at: now(), by: patch.by || "" }].slice(-20);
  return putRow(db, WEEKLY, next);
}

/* ISO week in IST ("2026-W47") and the IST moment of a weekday + time in it. */
export function weekKey(t = Date.now()) {
  const d = new Date(t + IST); d.setUTCHours(0, 0, 0, 0);
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dow);
  const y = d.getUTCFullYear(), w = Math.ceil(((d - Date.UTC(y, 0, 1)) / 864e5 + 1) / 7);
  return `${y}-W${String(w).padStart(2, "0")}`;
}
function momentIn(t, dow, hhmm) {
  const d = new Date(t + IST); d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() || 7) - dow));
  const [h, m] = hhmm.split(":").map(Number);
  return d.getTime() + (h * 60 + m) * 6e4 - IST;
}

/* ── New pieces ───────────────────────────────────────────────────────────── */

/* What went up in the last N days: eartheditions.co pieces (linked to the
   store) and Etsy listings that aren't on the store (linked to Etsy). One of a
   kind first, then the dearest, so the email leads with the best piece. */
export async function newPieces({ days = 7 } = {}, db = adminClient()) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const { data: sp, error } = await db.from("store_products")
    .select("id,listing_id,handle,title,subtitle,images,price,qty,is_unique,status,created_at,material,shape")
    .eq("status", "active").gte("created_at", since).gt("qty", 0).order("created_at", { ascending: false }).limit(60);
  if (error) throw new Error(error.message);
  const out = [], seen = new Set();
  for (const p of sp || []) {
    if (!p.handle) continue;
    seen.add(p.listing_id || p.id.replace(/^lm-/, ""));
    out.push({
      key: p.id, title: p.title, url: `${STORE}/products/${p.handle}`, image: sbThumb((p.images || [])[0], 400) || "",
      price: p.price ? `$${Number(p.price).toLocaleString("en-US")}` : "", priceN: +p.price || 0,
      meta: [p.subtitle, p.is_unique ? "one of a kind" : ""].filter(Boolean).join(" · "), unique: !!p.is_unique, at: p.created_at, where: "store",
    });
  }
  const { data: el, error: e2 } = await db.from("app_rows").select("id,data").eq("key", "ng-listings-v1").eq("deleted", false)
    .gte("data->platforms->etsy->>first_listed_at", since).limit(80);
  if (e2) throw new Error(e2.message);
  for (const { id, data: l } of el || []) {
    const e = l.platforms?.etsy || {};
    if (seen.has(id) || e.status !== "active" || !/^https:\/\/www\.etsy\.com\/listing\//.test(e.url || "")) continue;
    const img = (e.imagesSrc || l.images || [])[0];
    const unique = l.type !== "repeatable" && (+l.qty || 1) <= 1;
    out.push({
      key: id, title: String(l.title || "").split(/\s[|–—-]\s/)[0].slice(0, 90), url: e.url, image: sbThumb(img, 400) || "",
      price: "", priceN: 0, meta: [unique ? "one of a kind" : "", "on Etsy"].filter(Boolean).join(" · "), unique, at: e.first_listed_at, where: "etsy",
    });
  }
  return out.sort((a, b) => (b.unique - a.unique) || (b.priceN - a.priceN) || String(b.at).localeCompare(String(a.at)));
}

/* eartheditions.co account holders who ticked "email me" join the audience;
   one who later unticked is taken off it (unless they joined another way). */
async function syncStoreCustomers(db) {
  const { data, error } = await db.from("store_customers").select("email,name,marketing").limit(2000);
  if (error) throw new Error(error.message);
  // Only the ones whose state changed are written.
  const have = new Map((await list.allContacts(db)).map(c => [c.id, c]));
  let n = 0;
  for (const c of data || []) {
    const e = norm(c.email);
    if (!list.OK.test(e)) continue;
    const tagged = (have.get(e)?.tags || []).includes("store-customer");
    if (c.marketing) { n++; if (!tagged) await list.syncContact({ email: e, firstName: String(c.name || "").split(" ")[0], addTags: ["store-customer"], source: "store-account" }, db); }
    else if (tagged) await list.syncContact({ email: e, removeTags: ["store-customer"], createIfMissing: false }, db);
  }
  return n;
}

/* ── The issue ────────────────────────────────────────────────────────────── */

const titleCase = t => String(t || "").replace(/\s+/g, " ").trim();
function issueContent(pieces, settings) {
  const n = pieces.length, uniq = pieces.filter(p => p.unique).length;
  const lead = titleCase(pieces[0].title);
  return {
    subject: n > 1 ? `New this week: ${lead} and ${n - 1} more` : `New this week: ${lead}`,
    preheader: uniq ? `${uniq} of them one of a kind. Once a piece is gone, it's gone.` : "Fresh from our studio in India.",
    note: `${n} new piece${n > 1 ? "s" : ""} went up this week${uniq ? `, ${uniq === n ? "every one" : `${uniq}`} of them one of a kind` : ""}. Here they are, newest finds first.\n\nEvery stone is photographed as it is, in our studio and in daylight.`,
    ask: "If one catches your eye and you'd like more photos, a video or its exact size, just reply to this email.",
    signoff: "Warm regards,\nEarth Editions",
    addressLine: settings.addressLine,
    why: "You're getting this because you asked to hear about new pieces from Earth Editions.",
    photos: 6, priceSuffix: "",
  };
}

const sendIdFor = week => `wk-${week}`;
const approveUrl = (week, act) => `${PUBLIC}/api/mail?action=wk&w=${encodeURIComponent(week)}&do=${act}&t=${list.sign(`wk:${week}:${act}`)}`;
export const checkWeekToken = (week, act, t) => ["approve", "skip"].includes(act) && String(t || "") === list.sign(`wk:${week}:${act}`);

export async function getWeek(week, db = adminClient()) { return getRow(db, WEEKLY, `week:${week}`); }

/* Builds this week's issue (or rebuilds it while it hasn't started sending),
   sends the [Test] copy and asks the approver. */
export async function build({ bridge, force = false, by = "cron" }, db = adminClient()) {
  const settings = await getSettings(db);
  const week = weekKey();
  const was = await getWeek(week, db);
  if (was && !force) return { week, already: true, state: was.state };
  if (was?.sendId) {
    try { const s = await list.getSendRow(was.sendId, db); if (Object.keys(s.sent || {}).length) throw new Error("This week's issue has already started sending"); }
    catch (e) { if (/already started/.test(e.message)) throw e; }
  }
  const storeCustomers = await syncStoreCustomers(db).catch(e => ({ error: e.message }));
  const pieces = await newPieces({ days: settings.days }, db);
  const row = { id: `week:${week}`, week, builtAt: now(), builtBy: by, pieceCount: pieces.length, storeCustomers };
  if (!pieces.length) return putRow(db, WEEKLY, { ...row, state: "skipped", why: `Nothing new was listed in the last ${settings.days} days` });

  const picked = pieces.slice(0, 18);
  const c = issueContent(picked, settings);
  const html = list.buildPersonalHtml({ ...c, products: picked });
  const links = Object.fromEntries(picked.map(p => [p.url, p.title.slice(0, 120)]));
  const sendId = sendIdFor(week) + (was ? `-${Date.now().toString(36)}` : "");
  // A rebuild replaces the unsent issue: the old one is cancelled, not left "ready".
  if (was?.sendId) await list.setSendStatus({ id: was.sendId, status: "cancelled" }, db).catch(() => {});
  let created;
  try {
    created = await list.createSend({ id: sendId, meta: { weekly: week }, html, style: "personal", links, subject: c.subject, preheader: c.preheader, senderName: "Earth Editions", tags: AUDIENCE, engagedFirst: true }, db);
  } catch (e) {
    if (/No subscribed contacts/.test(e.message)) return putRow(db, WEEKLY, { ...row, state: "skipped", why: "Nobody has joined the list yet" });
    throw e;
  }
  await list.sendTest({ id: sendId, to: settings.approver }, bridge, db);
  const auto = settings.mode === "auto";
  const out = { ...row, sendId, subject: c.subject, note: c.note, audience: created.total, pieces: picked, dropped: [],
    state: auto ? "approved" : "awaiting", ...(auto ? { approvedAt: now(), approvedVia: "auto" } : {}),
    sendAfter: new Date(momentIn(Date.now(), settings.sendDow, settings.sendAt)).toISOString() };
  await putRow(db, WEEKLY, out);
  await askApproval(out, settings, bridge, auto);
  return out;
}

async function askApproval(w, settings, bridge, auto) {
  const when = new Date(w.sendAfter).toLocaleString("en-GB", { weekday: "long", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
  const btn = (href, label, dark) => `<a href="${he(href)}" style="display:inline-block;margin:0 8px 8px 0;padding:11px 20px;border-radius:6px;text-decoration:none;font-weight:bold;${dark ? "background:#1a1308;color:#fff" : "background:#f1ece3;color:#1a1308"}">${label}</a>`;
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#1a1308;max-width:560px;padding:16px">`
    + `<p>This week's "new pieces" email is ready: <strong>${he(w.subject)}</strong></p>`
    + `<p>${w.pieceCount} piece${w.pieceCount > 1 ? "s" : ""} from the last week · ${w.audience} subscriber${w.audience > 1 ? "s" : ""} · goes out ${he(when)} IST${auto ? " by itself (auto mode)" : " once you approve"}.<br>The [Test] copy just above shows exactly what they'll get.</p>`
    + (auto ? `<p>${btn(approveUrl(w.week, "skip"), "Skip this week", false)}</p>` : `<p>${btn(approveUrl(w.week, "approve"), "Approve and send", true)}${btn(approveUrl(w.week, "skip"), "Skip this week", false)}</p>`)
    + `<p style="font-size:12px;color:#8a7d6a">To change the subject, the note or which pieces are in it, open the ERP Home page before it goes.</p></body></html>`;
  await bridge({ action: "send_raw", messages: [{ raw: list.raw(list.simpleMime({ to: settings.approver, subject: `Approve: ${w.subject}`, html, senderName: "ERP" })) }] });
}

export async function decide({ week, act, via = "erp", by = "" }, db = adminClient()) {
  const w = await getWeek(week, db);
  if (!w?.sendId) throw new Error("No issue for that week");
  if (w.state === "sent") return w;
  const s = await list.getSendRow(w.sendId, db);
  if (Object.keys(s.sent || {}).length && act === "skip") throw new Error("It has already started sending");
  const next = act === "approve"
    ? { ...w, state: "approved", approvedAt: now(), approvedVia: via, approvedBy: by }
    : { ...w, state: "skipped", skippedAt: now(), skippedVia: via, why: "Skipped" };
  if (act === "skip") await list.setSendStatus({ id: w.sendId, status: "cancelled" }, db).catch(() => {});
  return putRow(db, WEEKLY, next);
}

/* Sir's edits on Home before it goes: subject, the note, pieces taken out.
   The email is rebuilt from the same pieces, so nothing new sneaks in. */
export async function edit({ week, subject, note, drop = [], by = "" }, db = adminClient()) {
  const w = await getWeek(week, db);
  if (!w?.sendId || !Array.isArray(w.pieces)) throw new Error("No issue to edit for that week");
  if (w.state === "sent" || w.state === "skipped") throw new Error(`It's ${w.state}, so it can't be edited`);
  const settings = await getSettings(db);
  const dropped = [...new Set(drop.map(String))];
  const keep = w.pieces.filter(p => !dropped.includes(p.url));
  if (!keep.length) throw new Error("Leave at least one piece in, or skip this week");
  const c = issueContent(keep, settings);
  const subj = String(subject || "").trim().slice(0, 200) || c.subject;
  const text = String(note ?? "").trim() || c.note;
  const html = list.buildPersonalHtml({ ...c, note: text, products: keep });
  const links = Object.fromEntries(keep.map(p => [p.url, p.title.slice(0, 120)]));
  await list.updateSend(w.sendId, { html, subject: subj, links }, db);
  return putRow(db, WEEKLY, { ...w, subject: subj, note: text, dropped, editedAt: now(), editedBy: by });
}
export async function testIssue({ week, to }, bridge, db = adminClient()) {
  const w = await getWeek(week, db);
  if (!w?.sendId) throw new Error("No issue for that week");
  return list.sendTest({ id: w.sendId, to: to || (await getSettings(db)).approver }, bridge, db);
}

/* Sends batches until the time budget runs out (the next tick carries on). */
async function drive(w, bridge, db, budgetMs) {
  const t0 = Date.now();
  let p;
  for (;;) {
    p = await list.sendBatch({ id: w.sendId, start: true }, bridge, db);
    if (["done", "paused", "cancelled"].includes(p.status)) break;
    const wait = p.busy ? 15_000 : (p.waitMs || 30_000);
    if (Date.now() - t0 + wait + 20_000 > budgetMs) break;
    await new Promise(ok => setTimeout(ok, wait));
  }
  if (p.status === "done") await putRow(db, WEEKLY, { ...w, state: "sent", sentAt: now(), sent: p.sent, failed: p.failed, skippedPeople: p.skipped });
  return p;
}

/* pg_cron, every 15 minutes. Cheap when there's nothing to do. */
export async function tick({ bridge, budgetMs = 240_000 }, db = adminClient()) {
  const settings = await getSettings(db);
  if (settings.paused) return { paused: true };
  const t = Date.now(), week = weekKey(t);
  let w = await getWeek(week, db);
  const out = { week };
  if (!w && t >= momentIn(t, settings.buildDow, settings.buildAt)) { w = await build({ bridge, by: "cron" }, db); out.built = w.state; }
  // Last week's issue, if it was approved late, still goes (it's still the newest).
  const prev = !w || w.state !== "approved" ? await getWeek(weekKey(t - 7 * 864e5), db) : null;
  const go = [w, prev].find(x => x?.state === "approved" && t >= Date.parse(x.sendAfter || 0) && t - Date.parse(x.sendAfter || 0) < 6 * 864e5);
  if (go) out.send = await drive(go, bridge, db, budgetMs);
  return out;
}

/* ── Joining ──────────────────────────────────────────────────────────────── */

const joinToken = email => list.sign(`join:${norm(email)}`);
export const confirmUrl = email => `${PUBLIC}/api/mail?action=joined&e=${Buffer.from(norm(email)).toString("base64url")}&t=${joinToken(email)}`;
export function readJoinParams(q) {
  let email = "";
  try { email = norm(Buffer.from(String(q.e || ""), "base64url").toString("utf8")); } catch { return null; }
  return list.OK.test(email) && String(q.t || "") === joinToken(email) ? email : null;
}

/* Step 1: the form. Nothing goes on the list yet; we email a confirm link. */
export async function requestJoin({ email, name, src, consent }, bridge, db = adminClient()) {
  const e = norm(email);
  if (!list.OK.test(e)) return { error: "That email doesn't look right." };
  if (!consent) return { error: "Please tick the box to say you'd like the emails." };
  const source = SOURCES[src] ? src : "web";
  const was = await getRow(db, JOINS, e);
  if (was?.requestedAt && Date.now() - Date.parse(was.requestedAt) < 10 * 6e4) return { ok: true, again: true };
  const today = new Date(Date.now() + IST).toISOString().slice(0, 10);
  const { count } = await db.from("app_rows").select("id", { count: "exact", head: true }).eq("key", JOINS).gte("data->>requestedAt", `${today}T00:00:00`);
  if ((count || 0) >= JOIN_DAY_CAP) return { error: "We can't take more sign-ups today. Please try again tomorrow." };
  await putRow(db, JOINS, { ...(was || {}), id: e, email: e, name: String(name || "").trim().slice(0, 60), src: source, requestedAt: now(), requests: (was?.requests || 0) + 1 });
  const first = String(name || "").trim().split(/\s+/)[0];
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#1a1308;max-width:520px;padding:16px">`
    + `<p>Hi${first ? ` ${he(first)}` : ""},</p><p>Thanks for asking to hear about our new pieces. Please confirm it's you:</p>`
    + `<p><a href="${he(confirmUrl(e))}" style="display:inline-block;padding:12px 22px;background:#1a1308;color:#fff;border-radius:6px;text-decoration:none;font-weight:bold">Yes, send me new pieces</a></p>`
    + `<p style="font-size:13px;color:#6b5d4a">About once a week, from team@eartheditions.co. If you didn't ask for this, ignore this email and you won't hear from us.</p>`
    + `<p>Earth Editions</p></body></html>`;
  await bridge({ action: "send_raw", messages: [{ raw: list.raw(list.simpleMime({ to: e, subject: "Confirm: new pieces from Earth Editions", html })) }] });
  return { ok: true };
}

/* Step 2: they pressed the button in that email. Now they're on the list. */
export async function confirmJoin(email, db = adminClient()) {
  const e = norm(email);
  const j = (await getRow(db, JOINS, e)) || { id: e, email: e, src: "web" };
  const c = await list.syncContact({
    email: e, firstName: j.name ? j.name.split(/\s+/)[0] : "", subscribe: "resubscribe", source: `join-${j.src}`,
    addTags: [LIST_TAG, `src:${j.src}`],
    consent: { list: LIST_TAG, at: now(), requestedAt: j.requestedAt || "", src: j.src, text: CONSENT_TEXT, method: "double opt-in" },
  }, db);
  await putRow(db, JOINS, { ...j, confirmedAt: now() });
  return c;
}

export async function joinStats(db = adminClient()) {
  const all = await list.allContacts(db);
  const on = all.filter(c => c.status === "subscribed" && (c.tags || []).some(t => AUDIENCE.includes(t)));
  const bySrc = {};
  for (const c of on) { const s = (c.tags || []).find(t => t.startsWith("src:"))?.slice(4) || ((c.tags || []).includes("store-customer") ? "store-account" : "store-form"); bySrc[s] = (bySrc[s] || 0) + 1; }
  const { data } = await db.from("app_rows").select("data").eq("key", JOINS).eq("deleted", false).limit(500);
  const pending = (data || []).filter(r => !r.data.confirmedAt).length;
  return { audience: on.length, bySrc, pending };
}
