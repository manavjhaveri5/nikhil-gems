import { adminClient } from "./auth.js";
import { omniList, rowsOf, tagContact } from "../api/omnisend.js";

/* Wholesale outreach sends from the ERP (Outreach page → select → Send).

   Mail goes out through the Gmail bridge (scripts/gmail-bridge.gs), so every
   email leaves from the real mailbox, sits in its Sent folder, and replies land
   there. Only a lead's own stored draft or follow-up can be sent, never free text,
   and only one lead per call: the page paces the calls. A Resend/Omnisend send is
   deliberately not used: their terms forbid cold email, and a suspension there
   would also stop the store's order emails.

   Before a first email: is this shop already known? Trade buyers, store
   customers and orders, Omnisend contacts, other outreach leads already
   contacted, and any Gmail thread to or from the address or its domain. Any hit
   moves the lead to "Skipped" with the reason, and nothing is sent.
   Before a follow-up: has the shop replied, or did the first email bounce?

   Replies are also read automatically (outreachScan: the 07:00 inbox job, whenever
   the Outreach page opens, and before each follow-up). "Sign me up" goes straight
   onto Omnisend as a trade prospect, "no thanks" is never written to again, a
   bounce is marked, and any other reply stops the follow-ups for Sejal to answer. */

const KEY = "outreach-leads-v1";
const FREE = /^(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me|mac|aol|proton|protonmail|gmx|web|t-online|btinternet|bigpond|xtra|orange|free|libero|wanadoo|comcast|att|verizon|nifty|docomo|ezweb|softbank|i\.softbank|au|ocn|so-net|biglobe|excite)\./i;
const NO_COLD_EMAIL = new Set(["DE", "AT"]);
export const CAP = { first: 20, total: 60 };   // new shops a day; all emails a day incl. follow-ups
const OK_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SIGN_UP = /sign (me |us )?up|subscribe|mailing list|trade list|add (me|us)|登録希望|登録をお願い|訂閱|我要訂閱/i;
const NOT_SIGN_UP = /(don'?t|do not|no need to|please don'?t) (sign|subscribe|add)|unsubscribe|no thanks|not interested|remove (me|us)|不用了|不需要|配信停止|今後のご連絡は不要|お断り|取消訂閱/i;

const SCAN_KEY = "outreach-scan-v1";
// Only their own words: cut the reply at the quoted email below it.
function ownWords(t) {
  t = String(t || "");
  const cuts = [/ wrote:/i, /-{2,}\s*Original/i, /\bFrom: /, /\bSent from my/i, / > /, /書きました/, /のメッセージ:/];
  let end = t.length;
  for (const re of cuts) { const m = re.exec(t); if (m && m.index < end) { end = m.index; if (/wrote/i.test(m[0])) { const on = t.lastIndexOf("On ", end); if (on >= 0) end = on; } } }
  return t.slice(0, end).trim();
}
// Auto-responders (out of office, help-desk tickets) aren't answers: follow-ups carry on.
const AUTO = /out of (the )?office|auto(matic|mated)?[- ]?(reply|response|generated)|thanks? (you )?for (contacting|reaching out|your (e-?mail|message|inquiry|enquiry))|we('ll| will) (get back|respond|reply)|(support )?ticket|do not reply|no-?reply|away (from|until)|on (holiday|vacation|leave)|自動(返信|応答)|お問い合わせありがとう|自動回覆|自動回复/i;
// What a reply means: "list" (sign me up), "no" (stop writing), "auto" (an auto-responder), or "reply" (Sejal answers).
export function readReply(text) {
  const t = ownWords(text);
  if (AUTO.test(t) && !SIGN_UP.test(t)) return "auto";
  if (NOT_SIGN_UP.test(t)) return "no";
  if (SIGN_UP.test(t)) return "list";
  return "reply";
}

const istDay = () => new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const gmailDay = d => d.replace(/-/g, "/");
const domainOf = e => { const d = String(e).split("@")[1] || ""; return d && !FREE.test(d) ? d.toLowerCase() : ""; };

async function getLead(db, id) {
  const { data, error } = await db.from("app_rows").select("data").eq("key", KEY).eq("id", String(id)).eq("deleted", false).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Lead not found");
  return data.data;
}
async function saveLead(db, l) {
  const item = { ...l, updated_at: new Date().toISOString() };
  const { error } = await db.rpc("app_rows_upsert", { p_key: KEY, p_item: item, p_prepend: false });
  if (error) throw new Error(error.message);
  return item;
}
const logged = (l, what, via = "email", extra = {}) => ({ ...l, ...extra, history: [...(l.history || []), { day: istDay(), what, via }] });

async function sentToday(db) {
  const today = istDay();
  const { data, error } = await db.from("app_rows").select("data").eq("key", KEY).eq("deleted", false).contains("data", { history: [{ day: today }] });
  if (error) throw new Error(error.message);
  let first = 0, total = 0;
  for (const r of data || []) for (const h of r.data.history || []) {
    if (h.day !== today || h.via !== "email") continue;
    if (h.what === "sent") { first++; total++; } else if (/^followup/.test(h.what)) total++;
  }
  return { first, total };
}

/* Every place this shop could already be known from. Returns reasons; empty means new. */
export async function knownBefore({ db = adminClient(), bridge, lead }) {
  const email = String(lead.email || "").trim().toLowerCase(), dom = domainOf(email);
  const why = [];
  if (!email) return why;
  for (const [table, label] of [["trade_buyers", "a trade buyer"], ["store_customers", "a store customer"], ["store_orders", "on a store order"]]) {
    let q = db.from(table).select("email").limit(1);
    q = dom ? q.or(`email.ilike.${email},email.ilike.%@${dom}`) : q.ilike("email", email);
    const { data } = await q;
    if (data?.length) why.push(`already ${label} (${data[0].email})`);
  }
  const { data: others } = await db.from("app_rows").select("data").eq("key", KEY).eq("deleted", false).neq("id", lead.id)
    .or(`data->>email.ilike.${email}${dom ? `,data->>email.ilike.%@${dom}` : ""}`).limit(5);
  const contacted = (others || []).map(r => r.data).find(o => !["new", "skip"].includes(o.stage));
  if (contacted) why.push(contacted.stage === "ours" ? `already our customer (${contacted.name})` : `already contacted as ${contacted.name}`);
  // The ERP's own Gmail mailing list (Japan list, trade and show customers, store sign-ups).
  const { data: listed } = await db.from("app_rows").select("data").eq("key", "mail-contacts-v1").eq("deleted", false)
    .or(`data->>email.ilike.${email}${dom ? `,data->>email.ilike.%@${dom}` : ""}`).limit(1);
  if (listed?.length) why.push(`on our mailing list (${listed[0].data.email})`);
  if (process.env.OMNISEND_API_KEY) {
    const r = await omniList("/contacts", { email, limit: 1 });
    const hit = r.ok && rowsOf(r.data, "contacts").find(c => String(c.email || c.identifiers?.find?.(i => i.type === "email")?.id || "").toLowerCase() === email);
    if (hit) why.push("on the Omnisend list");
  }
  if (bridge) {
    const who = [email, ...(dom ? [dom] : [])];
    const q = who.map(w => `from:${w} OR to:${w}`).join(" OR ");
    const d = await bridge({ action: "search", q: `(${q}) in:anywhere`, max: 1 });
    const t = d.threads?.[0];
    if (t) why.push(`Gmail already has "${String(t.subject || "(no subject)").slice(0, 60)}" with them`);
  }
  return why;
}

/* Sends one lead's first email or its due follow-up. Answers { lead, sent, skipped?, why? }. */
export async function outreachSend({ bridge, id, skipReplyCheck = false }) {
  const db = adminClient();
  let l = await getLead(db, id);
  const email = String(l.email || "").trim(), today = istDay();
  if (!OK_EMAIL.test(email)) throw new Error(`${l.name} has no email address`);
  if (NO_COLD_EMAIL.has(l.country)) throw new Error(`${l.name} is in ${l.country}: Instagram DM only, no cold email`);
  const fu = (l.followups || [])[l.followups_sent || 0];
  const first = l.stage === "new";
  const followup = ["sent", "followed_up"].includes(l.stage) && l.sent_via === "email" && fu && l.next_followup && l.next_followup <= today;
  if (!first && !followup) throw new Error(`${l.name} has nothing due to send (${l.stage})`);
  const used = await sentToday(db);
  if (used.total >= CAP.total) throw new Error(`Today's limit of ${CAP.total} emails is reached`);
  if (first && used.first >= CAP.first) throw new Error(`Today's limit of ${CAP.first} new shops is reached`);

  if (first) {
    const why = await knownBefore({ db, bridge, lead: l });
    if (why.length) {
      l = await saveLead(db, logged(l, "skip: known", "", { stage: "skip", next_followup: null, note: [l.note, `Not sent: ${why.join("; ")}.`].filter(Boolean).join(" ") }));
      return { lead: l, sent: false, skipped: true, why };
    }
  } else if (!skipReplyCheck) {
    // Stop the follow-up if they answered or the first email bounced.
    const dom = domainOf(email), since = gmailDay(addDays(l.sent_at || today, -1));
    const rep = await bridge({ action: "search", q: `(from:${email}${dom ? ` OR from:${dom}` : ""}) after:${since}`, max: 1 });
    if (rep.threads?.length) {
      // Same reading as the scan: sign-ups go on the list, "no" stops for good, anything else is Sejal's.
      const r = await outreachScan({ bridge, trigger: "followup" });
      l = await getLead(db, id);
      if (["sent", "followed_up"].includes(l.stage)) return outreachSend({ bridge, id, skipReplyCheck: true });
      return { lead: l, sent: false, skipped: true, why: [r.list.includes(l.name) ? "they asked to join the mailing list: added to Omnisend" : r.no.includes(l.name) ? "they said no thanks: won't write again" : "they replied: answer them in Gmail"] };
    }
    const bounce = await bridge({ action: "search", q: `from:mailer-daemon "${email}" after:${since}`, max: 1 });
    if (bounce.threads?.length) {
      l = await saveLead(db, logged(l, "bounced", "email", { stage: "bounced", next_followup: null }));
      return { lead: l, sent: false, skipped: true, why: ["the first email bounced"] };
    }
  }

  const subject = first ? l.draft?.subject : `Re: ${l.draft?.subject || ""}`;
  const original = String(l.draft?.body || "").split("\n").map(s => `> ${s}`).join("\n");
  const body = first ? l.draft?.body : `${fu.body}\n\nOn ${l.sent_at}, Sejal wrote:\n${original}`;
  if (!subject || !body) throw new Error(`${l.name} has no draft to send`);
  const r = await bridge({ action: "send", to: email, subject, body, name: "Sejal · Earth Editions" });
  if (!r.ok) throw new Error(r.error || "Gmail didn't send it");
  if (first) l = logged(l, "sent", "email", { stage: "sent", sent_at: today, sent_via: "email", next_followup: addDays(today, 4), followups_sent: 0, thread_id: r.threadId || null });
  else {
    const n = (l.followups_sent || 0) + 1;
    l = logged(l, `followup ${n}`, "email", { stage: "followed_up", followups_sent: n, next_followup: (l.followups || []).length > n ? addDays(today, 6) : null });
  }
  return { lead: await saveLead(db, l), sent: true };
}

/* History check without sending, for the page's "Check" button. */
export async function outreachCheck({ bridge, id }) {
  const db = adminClient();
  let l = await getLead(db, id);
  if (l.stage !== "new") return { lead: l, why: [] };
  const why = await knownBefore({ db, bridge, lead: l });
  if (why.length) l = await saveLead(db, logged(l, "skip: known", "", { stage: "skip", next_followup: null, note: [l.note, `Already known: ${why.join("; ")}.`].filter(Boolean).join(" ") }));
  return { lead: l, why };
}

/* Reads Gmail for replies and bounces from every shop we've emailed and acts on them.
   One Gmail search per 15 shops, so a run stays well inside the function's time limit. */
export async function outreachScan({ bridge, trigger = "page" }) {
  const db = adminClient();
  if (trigger === "page") {
    const { data } = await db.from("app_rows").select("data").eq("key", SCAN_KEY).eq("id", "last").maybeSingle();
    if (data?.data?.at && Date.now() - Date.parse(data.data.at) < 10 * 60e3) return { skipped: "ran in the last 10 minutes", last: data.data };
  }
  const leads = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("app_rows").select("data").eq("key", KEY).eq("deleted", false).in("data->>stage", ["sent", "followed_up"]).range(from, from + 999);
    if (error) throw new Error(error.message);
    leads.push(...data.map(r => r.data)); if (data.length < 1000) break;
  }
  const open = leads.filter(l => l.sent_via === "email" && OK_EMAIL.test(String(l.email || "")));
  const out = { at: new Date().toISOString(), trigger, checked: open.length, list: [], no: [], replied: [], bounced: [], auto: [], errors: [] };
  const today = istDay();
  const act = async (l, kind, words) => {
    if (kind === "list") {
      const r = await tagContact({ email: l.email, addTags: ["trade-prospect", "wholesale-outreach", `country-${String(l.country || "").toLowerCase()}`], createTags: ["trade-prospect"] });
      if (r.status !== 200) { out.errors.push(`${l.name}: Omnisend ${r.body?.error || r.status}`); kind = "reply"; }
      else { await saveLead(db, logged(l, "signed up (auto)", "email", { stage: "list", on_list: true, wants_list: true, replied_at: today, next_followup: null, reply_text: words.slice(0, 300) })); out.list.push(l.name); return; }
    }
    if (kind === "auto") {
      if (!(l.history || []).some(h => h.what === "auto-reply")) { await saveLead(db, logged(l, "auto-reply", "email", { auto_reply: words.slice(0, 200) })); out.auto.push(l.name); }
      return;
    }
    if (kind === "no") { await saveLead(db, logged(l, "said no (auto)", "email", { stage: "no", replied_at: today, next_followup: null, reply_text: words.slice(0, 300) })); out.no.push(l.name); return; }
    if (kind === "bounced") { await saveLead(db, logged(l, "bounced (auto)", "email", { stage: "bounced", next_followup: null })); out.bounced.push(l.name); return; }
    await saveLead(db, logged(l, "replied (auto)", "email", { stage: "replied", replied_at: today, next_followup: null, reply_text: words.slice(0, 300) })); out.replied.push(l.name);
  };
  const done = new Set();
  for (let i = 0; i < open.length; i += 15) {
    const chunk = open.slice(i, i + 15);
    const since = gmailDay(addDays(chunk.reduce((m, l) => (l.sent_at && l.sent_at < m ? l.sent_at : m), today), -1));
    const who = chunk.flatMap(l => [l.email.toLowerCase(), ...(domainOf(l.email) ? [domainOf(l.email)] : [])]);
    try {
      const res = await bridge({ action: "search", q: `(${who.map(w => `from:${w}`).join(" OR ")}) after:${since}`, max: 30 });
      // Every message from each shop, then the strongest meaning wins (a real answer beats an auto-reply).
      const got = new Map();
      for (const t of res.threads || []) for (const m of t.messages || []) {
        const from = String(m.from || "").toLowerCase();
        const l = chunk.find(x => from.includes(x.email.toLowerCase()) || (domainOf(x.email) && from.includes(`@${domainOf(x.email)}`)));
        if (!l || (l.sent_at && m.date && m.date.slice(0, 10) < l.sent_at)) continue;
        const kind = readReply(m.snippet), rank = { no: 4, list: 3, reply: 2, auto: 1 }[kind];
        if (!got.has(l.id) || rank > got.get(l.id).rank) got.set(l.id, { l, kind, rank, words: ownWords(m.snippet) });
      }
      for (const { l, kind, words } of got.values()) { done.add(l.id); await act(l, kind, words); }
    } catch (e) { out.errors.push(e.message); }
  }
  // Bounces: delivery-failure notices that name one of the addresses.
  const left = open.filter(l => !done.has(l.id));
  if (left.length) try {
    const since = gmailDay(addDays(left.reduce((m, l) => (l.sent_at && l.sent_at < m ? l.sent_at : m), today), -1));
    const res = await bridge({ action: "search", q: `from:(mailer-daemon OR postmaster) after:${since}`, max: 30, find: left.map(l => l.email).join("|") });
    for (const t of res.threads || []) for (const m of t.messages || []) {
      const l = left.find(x => !done.has(x.id) && String(m.hit || "").toLowerCase().includes(x.email.toLowerCase()));
      if (l) { done.add(l.id); await act(l, "bounced", ""); }
    }
  } catch (e) { out.errors.push(`bounces: ${e.message}`); }
  await db.rpc("app_rows_upsert", { p_key: SCAN_KEY, p_item: { id: "last", ...out }, p_prepend: false });
  return out;
}

export const outreachCounts = async () => ({ ...(await sentToday(adminClient())), cap: CAP });
