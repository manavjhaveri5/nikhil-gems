import { createHmac } from "node:crypto";
import { adminClient } from "./auth.js";
import { readReply } from "./outreach.js";

/* Campaigns sent from our own Gmail (team@eartheditions.co) through the Gmail
   bridge, instead of Omnisend.

   The list lives in the ERP: app_rows "mail-contacts-v1", one row per address
   (id = the address, lower case). It was imported once from Omnisend, and every
   contact_tag call (trade approvals, outreach sign-ups, the Subscribers tab)
   keeps it current. An address that unsubscribed or bounced is never put back
   on the list by anything automatic.

   A send is app_rows "mail-sends-v1": the rendered email with its
   [[unsubscribe_link]] placeholders, the recipients fixed when it was created,
   and what happened to each. The Omnisend page drives it a batch at a time
   (sendBatch), so it is paced and resumes wherever it stopped. Every email is
   its own message to one person, with List-Unsubscribe headers (one click, per
   RFC 8058) and a plain-text part.

   Replies, unsubscribe-by-email and bounces are read back from Gmail by scan():
   on the 07:00 job and whenever the page opens. */

export const CONTACTS = "mail-contacts-v1";
export const SENDS = "mail-sends-v1";
export const FROM_EMAIL = "team@eartheditions.co";
const PUBLIC = "https://studio.eartheditions.co";
export const CLICKS = "mail-clicks-v1";
/* How fast each style goes out. The personal letter goes slower: a steady
   trickle from a real mailbox looks like a person writing, a burst does not. */
const PACE = { personal: { batch: 6, waitMs: 30_000 }, catalogue: { batch: 12, waitMs: 20_000 } };
// Google Workspace allows ~2,000 a day from one mailbox; outreach shares it.
export const DAY_CAP = 1200;
const OK_EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

const now = () => new Date().toISOString();
const istDay = (d = Date.now()) => new Date(d + 5.5 * 36e5).toISOString().slice(0, 10);
const norm = e => String(e || "").trim().toLowerCase();

function secret() {
  const s = process.env.MAIL_UNSUB_SECRET || process.env.GMAIL_BRIDGE_SECRET;
  if (!s) throw new Error("No secret for unsubscribe links (GMAIL_BRIDGE_SECRET)");
  return s;
}
export const unsubToken = email => createHmac("sha256", secret()).update(`unsub:${norm(email)}`).digest("hex").slice(0, 24);
export const unsubUrl = (email, sendId = "") =>
  `${PUBLIC}/api/mail?action=unsub&e=${Buffer.from(norm(email)).toString("base64url")}&t=${unsubToken(email)}${sendId ? `&s=${encodeURIComponent(sendId)}` : ""}`;
export function readUnsubParams(q) {
  let email = "";
  try { email = norm(Buffer.from(String(q.e || ""), "base64url").toString("utf8")); } catch { return null; }
  if (!OK_EMAIL.test(email)) return null;
  const want = unsubToken(email), got = String(q.t || "");
  return got.length === want.length && got === want ? email : null;
}

/* ── Contacts ─────────────────────────────────────────────────────────────── */

async function getContacts(db, emails) {
  const out = new Map();
  for (let i = 0; i < emails.length; i += 200) {
    const { data, error } = await db.from("app_rows").select("data").eq("key", CONTACTS).eq("deleted", false).in("id", emails.slice(i, i + 200));
    if (error) throw new Error(error.message);
    for (const r of data || []) out.set(r.data.id, r.data);
  }
  return out;
}
export async function allContacts(db = adminClient()) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("app_rows").select("data").eq("key", CONTACTS).eq("deleted", false).range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data || []).map(r => r.data));
    if (!data || data.length < 1000) break;
  }
  return out;
}
async function applyContacts(db, items) {
  for (let i = 0; i < items.length; i += 200) {
    const { error } = await db.rpc("app_rows_apply", { p_key: CONTACTS, p_items: items.slice(i, i + 200), p_deletes: [] });
    if (error) throw new Error(error.message);
  }
}

/* What one contact becomes after a tag change. "Off the list" (unsubscribed,
   bounced) sticks: only the person themselves can come back, by signing up again
   in a way that passes subscribe: "resubscribe". */
function merged(was, { email, firstName, lastName, addTags = [], removeTags = [], subscribe, source }) {
  const id = norm(email);
  const c = was ? { ...was } : { id, email: id, tags: [], status: subscribe === false ? "nonSubscribed" : "subscribed", source: source || "erp", added: now() };
  const drop = new Set(removeTags.map(t => String(t).toLowerCase()));
  const tags = (c.tags || []).filter(t => !drop.has(String(t).toLowerCase()));
  for (const t of addTags) if (t && !tags.some(x => x.toLowerCase() === String(t).toLowerCase())) tags.push(String(t));
  c.tags = tags.slice(0, 40);
  if (firstName && !c.firstName) c.firstName = String(firstName).slice(0, 100);
  if (lastName && !c.lastName) c.lastName = String(lastName).slice(0, 100);
  if (subscribe === true && c.status === "nonSubscribed") c.status = "subscribed";
  if (subscribe === "resubscribe" && c.status !== "bounced") c.status = "subscribed";
  c.updated = now();
  return c;
}

// Called by tagContact on every trade approval, outreach sign-up and tag edit.
export async function syncContact(body, db = adminClient()) {
  const id = norm(body.email);
  if (!OK_EMAIL.test(id)) return null;
  const was = (await getContacts(db, [id])).get(id);
  if (!was && body.createIfMissing === false) return null;
  const c = merged(was, { ...body, addTags: [...(body.addTags || []), ...(!was ? body.createTags || [] : [])] });
  await applyContacts(db, [c]);
  return c;
}

export async function setStatus(email, status, why, db = adminClient()) {
  const id = norm(email);
  const was = (await getContacts(db, [id])).get(id);
  if (!was && status !== "unsubscribed") return null;
  const c = was ? { ...was } : { id, email: id, tags: [], source: "unsubscribe", added: now() };
  if (c.status === status) return { ...c, changed: false };
  Object.assign(c, { status, updated: now(), ...(status === "unsubscribed" ? { unsubAt: now(), unsubVia: why } : {}), ...(status === "bounced" ? { bouncedAt: now(), bounceWhy: why } : {}) });
  await applyContacts(db, [c]);
  return { ...c, changed: true };
}

/* One-time copy of Omnisend's contacts. Omnisend's own status wins for anyone
   new; anyone already here keeps an unsubscribe or bounce recorded by the ERP. */
export async function importFromOmnisend({ omniList, rowsOf }, db = adminClient()) {
  const have = new Map((await allContacts(db)).map(c => [c.id, c]));
  const items = [];
  let after, pages = 0, seen = 0;
  do {
    const r = await omniList("/contacts", { limit: 250, after });
    if (!r.ok) throw new Error(`Omnisend: ${r.error}`);
    const rows = rowsOf(r.data, "contacts");
    for (const x of rows) {
      const idf = (x.identifiers || []).find(i => i.type === "email");
      const email = norm(idf?.id || x.email);
      if (!OK_EMAIL.test(email)) continue;
      seen++;
      const st = idf?.channels?.email?.status || x.status || "";
      const status = st === "unsubscribed" ? "unsubscribed" : st === "subscribed" ? "subscribed" : "nonSubscribed";
      const was = have.get(email);
      const tags = [...new Set([...(was?.tags || []), ...(x.tags || []).map(String)])].slice(0, 40);
      const keep = was && (was.status === "unsubscribed" || was.status === "bounced");
      items.push({
        ...(was || { id: email, email, added: x.createdAt || now(), source: "omnisend" }),
        tags, status: keep ? was.status : status,
        firstName: was?.firstName || x.firstName || "", lastName: was?.lastName || x.lastName || "",
        country: was?.country || x.country || "", omnisendId: x.contactID || x.id || "", updated: now(),
      });
    }
    after = r.data?.paging?.hasMore ? (r.data?.paging?.cursors?.after || undefined) : undefined;
    pages++;
  } while (after && pages < 40);

  /* Omnisend segments (active, inactive, …) become tags "seg:<name>", so the
     same audiences can be picked here. */
  const byId = new Map(items.map(c => [c.id, c]));
  const segs = await omniList("/segments", { limit: 100 });
  for (const sg of segs.ok ? rowsOf(segs.data, "segments") : []) {
    const sid = sg.segmentID || sg.segmentId || sg.id, tag = `seg:${String(sg.name || sid).trim()}`;
    let a, n = 0;
    do {
      const r = await omniList("/contacts", { limit: 250, segmentID: sid, after: a });
      if (!r.ok) break;
      for (const x of rowsOf(r.data, "contacts")) {
        const email = norm((x.identifiers || []).find(i => i.type === "email")?.id || x.email);
        const c = byId.get(email);
        if (c && !c.tags.includes(tag)) c.tags = [...c.tags, tag].slice(0, 40);
      }
      a = r.data?.paging?.hasMore ? (r.data?.paging?.cursors?.after || undefined) : undefined;
    } while (a && ++n < 40);
  }
  await applyContacts(db, items);
  const counts = items.reduce((a, c) => (a[c.status] = (a[c.status] || 0) + 1, a), {});
  return { imported: items.length, seen, counts };
}

export function listSummary(contacts) {
  const counts = { subscribed: 0, nonSubscribed: 0, unsubscribed: 0, bounced: 0 };
  const tags = {};
  for (const c of contacts) {
    counts[c.status] = (counts[c.status] || 0) + 1;
    if (c.status === "subscribed") for (const t of c.tags || []) tags[t] = (tags[t] || 0) + 1;
  }
  return { total: contacts.length, counts, tags };
}
// Subscribed contacts carrying any of the tags (none picked = every subscribed contact).
export const audienceOf = (contacts, tags = [], excludeTags = []) => {
  const want = tags.map(t => t.toLowerCase()), not = excludeTags.map(t => t.toLowerCase());
  return contacts.filter(c => c.status === "subscribed" && OK_EMAIL.test(c.id)
    && (!want.length || (c.tags || []).some(t => want.includes(t.toLowerCase())))
    && !(c.tags || []).some(t => not.includes(t.toLowerCase())));
};

/* ── Sends ────────────────────────────────────────────────────────────────── */

async function getSend(db, id) {
  const { data, error } = await db.from("app_rows").select("data").eq("key", SENDS).eq("id", String(id)).eq("deleted", false).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Send not found");
  return data.data;
}
async function saveSend(db, s) {
  const { error } = await db.rpc("app_rows_upsert", { p_key: SENDS, p_item: s, p_prepend: true });
  if (error) throw new Error(error.message);
  return s;
}
export async function listSends(db = adminClient()) {
  const { data, error } = await db.from("app_rows").select("data").eq("key", SENDS).eq("deleted", false).order("pos", { ascending: true }).limit(30);
  if (error) throw new Error(error.message);
  // The page needs the tallies, not 400 recipients and the whole email.
  return (data || []).map(({ data: s }) => ({
    ...s, html: undefined, recipients: undefined, sent: undefined, failed: undefined,
    total: s.recipients?.length || 0, sentCount: Object.keys(s.sent || {}).length, failedCount: Object.keys(s.failed || {}).length,
  }));
}

export async function createSend({ html, subject, preheader, senderName, tags = [], excludeTags = [], draftId, style = "catalogue", links = {}, engagedFirst = true }, db = adminClient()) {
  if (!html || !subject) throw new Error("Subject and email are required");
  let people = audienceOf(await allContacts(db), tags, excludeTags);
  // The people who reply and click go first: their good reactions early in a
  // send are what tells Gmail the rest of the batch is wanted mail.
  if (engagedFirst) people = people.map(c => [c, engagementScore(c)]).sort((a, b) => b[1] - a[1]).map(x => x[0]);
  const recipients = people.map(c => c.id);
  if (!recipients.length) throw new Error("No subscribed contacts match that audience");
  const s = {
    id: `ms-${Date.now().toString(36)}`, subject: String(subject).slice(0, 200), preheader: String(preheader || "").slice(0, 200),
    senderName: String(senderName || "Nikhil Gems").slice(0, 80), html, tags, excludeTags, draftId: draftId || "",
    recipients, sent: {}, failed: {}, skipped: {}, replies: [], unsubs: [], bounces: [],
    style: PACE[style] ? style : "catalogue", links,
    status: "ready", createdAt: now(),
  };
  await saveSend(db, s);
  return { id: s.id, total: recipients.length };
}

/* MIME for one recipient: multipart/alternative, UTF-8, base64 bodies. */
const b64 = s => Buffer.from(s, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
const hdr = s => /^[\x20-\x7E]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
const textOf = html => html
  .replace(/<head[\s\S]*?<\/head>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<(br|\/p|\/div|\/tr|\/h\d)[^>]*>/gi, "\n")
  .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (m, h, t) => `${t.replace(/<[^>]+>/g, "").trim()} (${h})`)
  .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n))
  .replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();

export const firstNameOf = c => {
  const f = String(c?.firstName || "").trim().split(/\s+/)[0] || "";
  // Only a real-looking first name: not an email, a shop name in capitals, or initials.
  if (!/^[A-Za-z\u00C0-\u024F'-]{2,20}$/.test(f)) return "";
  return f[0].toUpperCase() + f.slice(1).toLowerCase();
};
/* [[first_name]] in a subject or body. With no usable name the body says
   "there" ("Hi there,"), and the subject drops it with its comma. */
export const fillName = (t, c, { subject = false } = {}) => {
  const n = firstNameOf(c);
  let x = String(t || "");
  if (!n && subject) x = x.replace(/\s*,?\s*\[\[first_name\]\]\s*,?\s*/g, " ").replace(/^\s+|\s+$/g, "").replace(/^\w/, m => m.toUpperCase());
  return x.replace(/\[\[first_name\]\]/g, n || "there");
};

/* The "personal" style: reads like a note typed in Gmail, not a newsletter.
   Plain white, one column, a greeting by name, a few small photos, a question
   to reply to, and a signature. Mail that looks like a person's mail is where
   Gmail's filters are kindest, and people answer a note more than a flyer. */
const he = v => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const httpsOnly = v => /^https:\/\//i.test(String(v || "")) ? String(v) : "";
export function buildPersonalHtml({ note = "", products = [], signoff = "", priceSuffix = "", addressLine = "", ask = "" } = {}) {
  const paras = String(note || "").split(/\n\s*\n/).map(x => x.trim()).filter(Boolean)
    .map(x => `<p style="margin:0 0 14px">${he(x).replace(/\n/g, "<br>")}</p>`).join("");
  const pics = products.slice(0, 4), rest = products.slice(4, 12);
  const price = p => p.price ? ` &middot; ${he(p.price)}${priceSuffix ? ` ${he(priceSuffix)}` : ""}` : "";
  const card = p => {
    const u = httpsOnly(p.url), img = httpsOnly(p.image);
    const title = u ? `<a href="${he(u)}" style="color:#1a1308;font-weight:bold;text-decoration:none">${he(p.title)}</a>` : `<strong>${he(p.title)}</strong>`;
    // No photo: the text takes the whole row instead of sitting beside an empty 120px gap.
    const pic = img ? `<td style="padding:0 0 14px;vertical-align:top;width:132px">${u ? `<a href="${he(u)}">` : ""}<img src="${he(img)}" width="120" height="120" alt="${he(p.title)}" style="display:block;width:120px;height:120px;object-fit:cover;border-radius:6px;border:0">${u ? "</a>" : ""}</td>` : "";
    return `<tr>${pic}`
      + `<td${img ? "" : ` colspan="2"`} style="padding:0 0 14px ${img ? 4 : 0}px;vertical-align:middle;font-size:14px;line-height:1.5">${title}<br><span style="color:#6b5d4a">${he(p.meta || "")}${price(p)}</span>${u && p.video ? `<br><a href="${he(httpsOnly(p.video) || u)}" style="color:#9a6200">Watch the video</a>` : ""}</td></tr>`;
  };
  const line = p => { const u = httpsOnly(p.url); return `<li style="margin:0 0 6px">${u ? `<a href="${he(u)}" style="color:#9a6200">${he(p.title)}</a>` : he(p.title)}<span style="color:#6b5d4a">${price(p)}</span></li>`; };
  const sig = String(signoff || "Warm regards,\nNikhil Gems").split("\n").map(he).join("<br>");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body style="margin:0;padding:0;background:#ffffff">`
    + `<div style="max-width:560px;padding:20px 16px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#1a1308">`
    + `<p style="margin:0 0 14px">Hi [[first_name]],</p>${paras}`
    + (pics.length ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 4px;border-collapse:collapse">${pics.map(card).join("")}</table>` : "")
    + (rest.length ? `<p style="margin:0 0 6px">Also new this week:</p><ul style="margin:0 0 14px;padding-left:20px">${rest.map(line).join("")}</ul>` : "")
    + `<p style="margin:0 0 14px">${he(ask || "If any of these are right for you, just reply to this email and I'll send more photos, a video or a price.")}</p>`
    + `<p style="margin:0 0 22px">${sig}</p>`
    + `<p style="margin:0;font-size:11px;line-height:1.5;color:#8a7d6a">${addressLine ? `${he(addressLine)}<br>` : ""}You're getting this because you've bought from us or asked to hear about new pieces. <a href="[[unsubscribe_link]]" style="color:#8a7d6a">Unsubscribe</a></p>`
    + `</div></body></html>`;
}

/* Every product link goes through our own domain once, so the ERP learns who
   looked at what. Signed, so it can never be used to bounce someone elsewhere. */
const clickSig = (sid, email, url) => createHmac("sha256", secret()).update(`c:${sid}:${norm(email)}:${url}`).digest("hex").slice(0, 16);
export const clickUrl = (sid, email, url) =>
  `${PUBLIC}/api/mail?action=c&s=${encodeURIComponent(sid)}&e=${Buffer.from(norm(email)).toString("base64url")}&u=${Buffer.from(url).toString("base64url")}&t=${clickSig(sid, email, url)}`;
export function readClickParams(q) {
  try {
    const email = norm(Buffer.from(String(q.e || ""), "base64url").toString("utf8"));
    const url = Buffer.from(String(q.u || ""), "base64url").toString("utf8");
    const sid = String(q.s || "");
    if (!OK_EMAIL.test(email) || !/^https:\/\//.test(url)) return null;
    return clickSig(sid, email, url) === String(q.t || "") ? { sid, email, url } : null;
  } catch { return null; }
}

export function personalHtml(s, email, contact = null) {
  const u = unsubUrl(email, s.id);
  // One page does both here, so the separate "Email preferences" link is dropped.
  let h = s.html.replace(/ \| <a href="\[\[preference_link\]\]"[^>]*>[^<]*<\/a>/g, "").replace(/\[\[unsubscribe_link\]\]|\[\[preference_link\]\]/g, u);
  h = fillName(h, contact);
  h = h.replace(/href="(https:\/\/[^"]+)"/g, (m, href) => {
    const real = href.replace(/&amp;/g, "&");
    if (real.startsWith(`${PUBLIC}/api/mail?action=unsub`) || /^https:\/\/(www\.)?instagram\.com/.test(real)) return m;
    return `href="${clickUrl(s.id, email, real).replace(/&/g, "&amp;")}"`;
  });
  if (s.preheader) h = h.replace(/<body([^>]*)>/i, `<body$1><div style="display:none;max-height:0;overflow:hidden;opacity:0;">${s.preheader.replace(/[<>&]/g, "")}</div>`);
  return h;
}
export function mimeFor(s, email, { test = false, contact = null } = {}) {
  const html = personalHtml(s, email, contact);
  const u = unsubUrl(email, s.id);
  const boundary = `=_ng_${Math.random().toString(36).slice(2)}`;
  return [
    `From: ${hdr(s.senderName)} <${FROM_EMAIL}>`,
    `To: <${email}>`,
    `Subject: ${hdr((test ? "[Test] " : "") + fillName(s.subject, contact, { subject: true }))}`,
    "MIME-Version: 1.0",
    `List-Unsubscribe: <${u}>, <mailto:${FROM_EMAIL}?subject=unsubscribe>`,
    "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
    `X-NG-Send: ${s.id}`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", b64(textOf(html)),
    `--${boundary}`, "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "", b64(html),
    `--${boundary}--`, "",
  ].join("\r\n");
}
const raw = mime => Buffer.from(mime, "utf8").toString("base64url");

export async function sendTest({ id, to }, bridge, db = adminClient()) {
  const list = (Array.isArray(to) ? to : [to]).map(norm).filter(e => OK_EMAIL.test(e)).slice(0, 5);
  if (!list.length) throw new Error("A test address is needed");
  const s = await getSend(db, id);
  const known = await getContacts(db, list);
  const r = await bridge({ action: "send_raw", messages: list.map(e => ({ raw: raw(mimeFor(s, e, { test: true, contact: known.get(e) || { firstName: "Friend" } })) })) });
  const bad = (r.results || []).find(x => x.error);
  if (bad) throw new Error(bad.error);
  s.testedAt = now(); s.testedTo = list;
  await saveSend(db, s);
  return { ok: true, sentTo: list };
}

async function sentTodayCount(db) {
  const today = istDay();
  const { data, error } = await db.from("app_rows").select("data").eq("key", SENDS).eq("deleted", false).limit(30);
  if (error) throw new Error(error.message);
  let n = 0;
  for (const { data: s } of data || []) for (const v of Object.values(s.sent || {})) if (istDay(Date.parse(v.at)) === today) n++;
  return n;
}

/* The next few recipients. Returns progress; the page calls again until done.
   A lock stops two open tabs sending the same batch. */
export async function sendBatch({ id, start }, bridge, db = adminClient()) {
  let s = await getSend(db, id);
  if (s.status === "done" || s.status === "cancelled") return progress(s);
  if (s.status === "ready" && !start) throw new Error("Not started");
  if (!s.testedAt) throw new Error("Send yourself a test first");
  if (s.lockUntil && Date.parse(s.lockUntil) > Date.now()) return { ...progress(s), busy: true };
  const used = await sentTodayCount(db);
  if (used >= DAY_CAP) { s.status = "paused"; s.pausedWhy = `Daily limit (${DAY_CAP}) reached — resume tomorrow`; await saveSend(db, s); return progress(s); }
  s = { ...s, status: "sending", startedAt: s.startedAt || now(), lockUntil: new Date(Date.now() + 120_000).toISOString(), pausedWhy: "" };
  await saveSend(db, s);

  const pace = PACE[s.style] || PACE.catalogue;
  const todo = s.recipients.filter(e => !s.sent[e] && !s.failed[e] && !s.skipped[e]).slice(0, Math.min(pace.batch, DAY_CAP - used));
  // Anyone who unsubscribed or bounced since the send was created is skipped.
  const live = await getContacts(db, todo);
  const go = [];
  for (const e of todo) {
    const c = live.get(e);
    if (!c || c.status !== "subscribed") s.skipped[e] = c?.status || "removed";
    else go.push(e);
  }
  if (go.length) {
    let r;
    try { r = await bridge({ action: "send_raw", messages: go.map(e => ({ raw: raw(mimeFor(s, e, { contact: live.get(e) })) })) }); }
    catch (e) { s.lockUntil = ""; s.status = "paused"; s.pausedWhy = e.message; await saveSend(db, s); throw e; }
    const results = r.results || [];
    go.forEach((e, i) => {
      const x = results[i] || { error: "No result" };
      if (x.error) s.failed[e] = String(x.error).slice(0, 200);
      else s.sent[e] = { at: now(), threadId: x.threadId || "", messageId: x.id || "" };
    });
    // A hard stop from Google (quota, suspension) pauses rather than burning through the list.
    const fatal = results.find(x => x.error && /limit|quota|suspend|rate/i.test(x.error));
    if (fatal) { s.status = "paused"; s.pausedWhy = fatal.error; }
    // What each contact has been sent, for the engagement picture.
    const at = now();
    await applyContacts(db, go.filter(e => s.sent[e]).map(e => {
      const c = live.get(e), g = c.eng || {};
      return { ...c, eng: { ...g, sent: (g.sent || 0) + 1, lastSentAt: at } };
    })).catch(() => {});
  }
  const left = s.recipients.filter(e => !s.sent[e] && !s.failed[e] && !s.skipped[e]).length;
  if (!left) { s.status = "done"; s.doneAt = now(); }
  s.lockUntil = "";
  await saveSend(db, s);
  return progress(s);
}
export async function setSendStatus({ id, status }, db = adminClient()) {
  const s = await getSend(db, id);
  if (!["paused", "cancelled"].includes(status) || s.status === "done") throw new Error("Can't change that send");
  s.status = status; s.lockUntil = "";
  await saveSend(db, s);
  return progress(s);
}
const progress = s => ({
  waitMs: (PACE[s.style] || PACE.catalogue).waitMs,
  id: s.id, status: s.status, pausedWhy: s.pausedWhy || "", total: s.recipients.length,
  sent: Object.keys(s.sent).length, failed: Object.keys(s.failed).length, skipped: Object.keys(s.skipped).length,
});

/* ── Learning from people ────────────────────────────────────────────────────
   Each contact carries eng: { sent, clicks, replies, lastClickAt, lastReplyAt,
   interests: { "<product title>": n } }, plus the tags "clicked" / "replied".
   That ranks who goes first in the next send and shows on the Gmail list tab. */
export function engagementScore(c) {
  const g = c?.eng || {};
  const fresh = t => t && Date.now() - Date.parse(t) < 120 * 864e5;
  return (g.replies || 0) * 5 + (g.clicks || 0) * 2 + (fresh(g.lastReplyAt) ? 6 : 0) + (fresh(g.lastClickAt) ? 3 : 0)
    - ((g.sent || 0) >= 4 && !g.clicks && !g.replies ? 2 : 0);
}
async function noteEngagement(db, email, kind, extra = {}) {
  const id = norm(email);
  const c = (await getContacts(db, [id])).get(id);
  if (!c) return;
  const g = { ...(c.eng || {}) }, at = extra.at || now();
  if (kind === "click") {
    g.clicks = (g.clicks || 0) + 1; g.lastClickAt = at;
    if (extra.title) g.interests = { ...(g.interests || {}), [extra.title]: ((g.interests || {})[extra.title] || 0) + 1 };
  } else {
    g.replies = (g.replies || 0) + 1; g.lastReplyAt = at; g.lastReplyKind = extra.kind || "";
  }
  const tag = kind === "click" ? "clicked" : "replied";
  const tags = (c.tags || []).includes(tag) ? c.tags : [...(c.tags || []), tag];
  await applyContacts(db, [{ ...c, tags, eng: g, updated: now() }]);
}

/* A product link was opened. Link checkers in company mail systems open every
   link the moment an email arrives, so clicks in the first 90 seconds after
   sending, or from a known scanner, are not counted. */
const SCANNER = /bot|crawler|spider|scan|preview|safelinks|proofpoint|barracuda|mimecast|urldefense|headless|python|curl|wget/i;
export async function recordClick({ sid, email, url }, ua = "", db = adminClient()) {
  let s;
  try { s = await getSend(db, sid); } catch { return; }
  const sentAt = s.sent?.[email]?.at;
  if (SCANNER.test(ua) || (sentAt && Date.now() - Date.parse(sentAt) < 90_000)) return;
  const title = s.links?.[url] || "";
  const id = `${sid}:${email}`;
  const { data } = await db.from("app_rows").select("data").eq("key", CLICKS).eq("id", id).maybeSingle();
  const row = data?.data || { id, sid, email, clicks: [] };
  row.clicks = [...row.clicks, { url, title, at: now() }].slice(-30);
  const { error } = await db.rpc("app_rows_upsert", { p_key: CLICKS, p_item: row, p_prepend: false });
  if (error) throw new Error(error.message);
  await noteEngagement(db, email, "click", { title });
}
// Per send: how many people clicked, and the products they clicked most.
export async function clickStats(sids, db = adminClient()) {
  const out = {};
  if (!sids.length) return out;
  const { data } = await db.from("app_rows").select("data").eq("key", CLICKS).eq("deleted", false).in("data->>sid", sids).limit(5000);
  for (const { data: r } of data || []) {
    const o = out[r.sid] ||= { people: 0, clicks: 0, top: {} , who: [] };
    o.people++; o.clicks += r.clicks.length; o.who.push(r.email);
    for (const c of r.clicks) if (c.title) o.top[c.title] = (o.top[c.title] || 0) + 1;
  }
  for (const o of Object.values(out)) o.top = Object.entries(o.top).sort((a, b) => b[1] - a[1]).slice(0, 6);
  return out;
}

/* What a reply is about. Builds on outreach's reading (unsubscribe, auto-reply)
   and picks out buying interest, so those can be answered first. */
const WANTS = /price|quote|interested|available|availability|how much|cost|order|buy|reserve|hold (it|them|this)|send (me )?(more|photos?|pics|pictures|videos?)|wholesale|minimum|moq|shipping to|invoice|pay/i;
export function classifyReply(text) {
  const k = readReply(text);
  if (k === "no" || k === "auto") return k;
  if (WANTS.test(text)) return "interested";
  return k === "list" ? "interested" : "reply";
}

// An unsubscribe from a campaign's link, counted against that campaign.
export async function unsubscribe(email, sendId, via, db = adminClient()) {
  const c = await setStatus(email, "unsubscribed", via, db);
  if (sendId && c?.changed) {
    try { const s = await getSend(db, sendId); s.unsubs = [...new Set([...(s.unsubs || []), norm(email)])]; await saveSend(db, s); } catch { /* the send may be gone */ }
  }
  return c;
}

/* ── Reading Gmail back ───────────────────────────────────────────────────── */

const fromAddr = f => norm((/<([^>]+)>/.exec(f || "") || [, f])[1]);
const gDay = iso => istDay(Date.parse(iso) - 864e5).replace(/-/g, "/");

export async function scan(bridge, db = adminClient()) {
  const { data, error } = await db.from("app_rows").select("data").eq("key", SENDS).eq("deleted", false).limit(30);
  if (error) throw new Error(error.message);
  const recent = (data || []).map(r => r.data).filter(s => s.startedAt && Date.now() - Date.parse(s.startedAt) < 30 * 864e5);
  const out = { checked: recent.length, replies: 0, unsubs: 0, bounces: 0 };
  if (!recent.length) return out;
  const since = gDay(recent.map(s => s.startedAt).sort()[0]);

  // Unsubscribe by email (the mailto in List-Unsubscribe).
  const un = await bridge({ action: "search", q: `to:${FROM_EMAIL} subject:unsubscribe after:${since}`, max: 30 });
  for (const t of un.threads || []) for (const m of t.messages || []) {
    const who = fromAddr(m.from);
    if (who && who !== FROM_EMAIL && (await setStatus(who, "unsubscribed", "email"))?.changed) out.unsubs++;
  }
  // Bounces name the address they couldn't deliver to.
  const bo = await bridge({ action: "search", q: `from:(mailer-daemon OR postmaster) after:${since}`, max: 30 });
  const bounceText = (bo.threads || []).flatMap(t => t.messages.map(m => `${m.subject} ${m.snippet}`.toLowerCase()));

  for (let s of recent) {
    // A batch in flight owns the row; its replies are read on the next pass.
    if (s.lockUntil && Date.parse(s.lockUntil) > Date.now()) continue;
    let changed = false;
    const byThread = new Map(Object.entries(s.sent || {}).map(([e, v]) => [v.threadId, e]));
    for (const e of Object.keys(s.sent || {})) {
      if ((s.bounces || []).includes(e)) continue;
      if (bounceText.some(t => t.includes(e))) {
        s.bounces = [...(s.bounces || []), e]; changed = true; out.bounces++;
        await setStatus(e, "bounced", `bounced on ${s.subject}`);
      }
    }
    // A personalised subject differs per person: search on its longest fixed part.
    const stem = s.subject.split("[[first_name]]").map(x => x.replace(/["(),]/g, " ").trim()).sort((a, b) => b.length - a.length)[0].slice(0, 80);
    const re = await bridge({ action: "search", q: `in:inbox subject:"${stem}" -from:${FROM_EMAIL} after:${gDay(s.startedAt)}`, max: 30 });
    for (const t of re.threads || []) {
      const e = byThread.get(t.id) || null;
      for (const m of t.messages || []) {
        const who = fromAddr(m.from);
        if (!who || who === FROM_EMAIL || /mailer-daemon|postmaster/.test(who)) continue;
        if ((s.replies || []).some(r => r.messageId === m.id)) continue;
        const kind = classifyReply(m.snippet);
        s.replies = [...(s.replies || []), { email: who, matched: e || "", at: m.date, kind, snippet: m.snippet.slice(0, 200), messageId: m.id, url: t.url }];
        changed = true; out.replies++;
        if (kind !== "auto") await noteEngagement(db, e || who, "reply", { kind, at: m.date }).catch(() => {});
        if (kind === "no" && (await setStatus(who, "unsubscribed", "reply"))?.changed) { s.unsubs = [...(s.unsubs || []), who]; out.unsubs++; }
      }
    }
    if (changed) await saveSend(db, s);
  }
  return out;
}
