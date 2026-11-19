import { adminClient } from "./auth.js";
import { omniList, rowsOf } from "../api/omnisend.js";

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
   Before a follow-up: has the shop replied, or did the first email bounce? */

const KEY = "outreach-leads-v1";
const FREE = /^(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me|mac|aol|proton|protonmail|gmx|web|t-online|btinternet|bigpond|xtra|orange|free|libero|wanadoo|comcast|att|verizon)\./i;
const NO_COLD_EMAIL = new Set(["DE", "AT"]);
export const CAP = { first: 20, total: 60 };   // new shops a day; all emails a day incl. follow-ups
const OK_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
export async function outreachSend({ bridge, id }) {
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
  } else {
    // Stop the follow-up if they answered or the first email bounced.
    const dom = domainOf(email), since = gmailDay(addDays(l.sent_at || today, -1));
    const rep = await bridge({ action: "search", q: `(from:${email}${dom ? ` OR from:${dom}` : ""}) after:${since}`, max: 1 });
    if (rep.threads?.length) {
      l = await saveLead(db, logged(l, "replied", "email", { stage: "replied", replied_at: today, next_followup: null }));
      return { lead: l, sent: false, skipped: true, why: ["they replied: answer them in Gmail"] };
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

export const outreachCounts = async () => ({ ...(await sentToday(adminClient())), cap: CAP });
