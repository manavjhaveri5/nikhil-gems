/**
 * Daily morning digest — sent to the Nikhil Gems Telegram bot chat(s).
 * Vercel Cron: runs at 03:30 UTC  =  09:00 IST  =  12:30 JST
 *
 * Env vars required (same ones the main telegram.js uses):
 *   SUPABASE_URL / VITE_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY  (or SUPABASE_ANON_KEY / VITE_SUPABASE_ANON_KEY)
 *   TELEGRAM_BOT_TOKEN
 *   TELEGRAM_ALLOWED_CHAT_IDS   (comma-separated)
 *   CRON_SECRET                 (optional — set in Vercel env for extra security)
 */

import { createClient } from "@supabase/supabase-js";

// ── Supabase helpers ──────────────────────────────────────────────────────────
function sb() {
  return createClient(
    process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_ANON_KEY ||
      process.env.VITE_SUPABASE_ANON_KEY
  );
}

async function loadK(key) {
  const { data } = await sb().from("app_data").select("value").eq("key", key).single();
  return data?.value ?? null;
}

// ── Telegram helpers ──────────────────────────────────────────────────────────
async function tgSend(chatId, text, token) {
  const chunks = [];
  for (let i = 0; i < text.length; i += 4000) chunks.push(text.slice(i, i + 4000));
  for (const chunk of chunks) {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: "HTML" }),
    });
  }
}

// ── Formatting helpers ────────────────────────────────────────────────────────
function today() {
  return new Date().toISOString().split("T")[0];
}
function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}
function fmtDate(d) {
  if (!d) return "—";
  const [y, m, day] = d.split("-");
  const mon = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][+m - 1];
  return `${+day} ${mon}`;
}
function fmtCurObj(obj) {
  return Object.entries(obj).filter(([, v]) => v > 0).map(([c, v]) => `${c} ${(+v).toLocaleString()}`).join(" · ") || "—";
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Light auth: Vercel crons send the CRON_SECRET in Authorization header
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers["authorization"] !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const token    = process.env.TELEGRAM_BOT_TOKEN;
  const chatIds  = (process.env.TELEGRAM_ALLOWED_CHAT_IDS || "")
                    .split(",").map(s => s.trim()).filter(Boolean);

  if (!token || chatIds.length === 0) {
    return res.status(200).json({ ok: false, reason: "No bot token or chat IDs set" });
  }

  const todayStr = today();
  const now      = new Date();

  // ── Load all data in parallel ─────────────────────────────────────────────
  const [shows, todos, invoices, purchases, expenses, stock] = await Promise.all([
    loadK("ng-shows-v1"),
    loadK("ng-todos-v1"),
    loadK("ng-invoices-v2"),
    loadK("ng-purch-v5"),
    loadK("ng-expenses-v1"),
    loadK("ng-stock-v5"),
  ]);

  const showsArr    = shows    || [];
  const todosArr    = todos    || [];
  const invoicesArr = invoices || [];
  const purchArr    = purchases|| [];
  const expArr      = expenses || [];
  const stockArr    = stock    || [];

  const lines = [];

  // ── Header ────────────────────────────────────────────────────────────────
  const DAY   = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][now.getUTCDay()];
  const MON   = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][now.getUTCMonth()];
  lines.push(`🌅 <b>Good morning — ${DAY} ${now.getUTCDate()} ${MON}</b>`);
  lines.push("━━━━━━━━━━━━━━━━━━━━━━");
  lines.push("");

  // ── Shows section ────────────────────────────────────────────────────────
  const activeShows  = showsArr.filter(s => s.startDate <= todayStr && s.endDate >= todayStr);
  const upcomingShows = showsArr.filter(s => s.startDate > todayStr)
                                .sort((a, b) => a.startDate.localeCompare(b.startDate));
  const nextShow     = upcomingShows[0] || null;

  if (activeShows.length > 0) {
    for (const show of activeShows) {
      const daysLeft = daysBetween(todayStr, show.endDate);
      const dailySales = show.dailySales || [];

      // Revenue totals
      const allRevByCur = {};
      dailySales.forEach(s => {
        const c = s.currency || "USD";
        allRevByCur[c] = (allRevByCur[c] || 0) + (+s.amount || 0);
      });
      (show.bagItems || []).filter(b => b.status === "sold").forEach(b => {
        const c = b.currency || "USD";
        allRevByCur[c] = (allRevByCur[c] || 0) + (+b.sellPrice || 0);
      });
      (show.showStock || []).filter(i => i.sold).forEach(i => {
        const c = i.soldCurrency || "USD";
        allRevByCur[c] = (allRevByCur[c] || 0) + (+i.soldPrice || 0);
      });

      // Today's sales only
      const todaySales = dailySales.filter(s => s.date === todayStr);
      const todayByCur = {};
      todaySales.forEach(s => {
        const c = s.currency || "USD";
        todayByCur[c] = (todayByCur[c] || 0) + (+s.amount || 0);
      });

      // Expenses
      const expByCur = {};
      (show.showExpenses || []).forEach(e => {
        const c = e.currency || "USD";
        expByCur[c] = (expByCur[c] || 0) + (+e.amount || 0);
      });

      lines.push(`🎪 <b>LIVE: ${show.name}</b> (${show.city})`);
      lines.push(`📅 Day ${daysBetween(show.startDate, todayStr) + 1} · ${daysLeft} day${daysLeft !== 1 ? "s" : ""} remaining`);
      lines.push(`💰 Total revenue: ${fmtCurObj(allRevByCur)}`);
      if (Object.keys(todayByCur).length > 0)
        lines.push(`📈 Today's sales: ${fmtCurObj(todayByCur)}`);
      if (Object.keys(expByCur).length > 0)
        lines.push(`💸 Show costs: ${fmtCurObj(expByCur)}`);

      const cl = show.checklist || [];
      if (cl.length > 0) {
        const done = cl.filter(t => t.done).length;
        lines.push(`✅ Checklist: ${done}/${cl.length}`);
      }
      lines.push("");
    }
  }

  if (!activeShows.length && nextShow) {
    const daysTo = daysBetween(todayStr, nextShow.startDate);
    lines.push(`📅 <b>Next show: ${nextShow.name}</b> (${nextShow.city})`);
    lines.push(`🗓 ${fmtDate(nextShow.startDate)} – ${fmtDate(nextShow.endDate)} · <b>${daysTo} day${daysTo !== 1 ? "s" : ""} away</b>`);

    // Shipment deadlines
    const urgentShips = (nextShow.shipments || []).filter(sh => {
      if (!sh.date) return false;
      return daysBetween(todayStr, sh.date) <= 7;
    });
    for (const sh of urgentShips) {
      const d = daysBetween(todayStr, sh.date);
      const flag = d < 0 ? "🚨 OVERDUE" : d === 0 ? "⚠️ TODAY" : d <= 2 ? `⚠️ ${d}d` : `📦 ${d}d`;
      lines.push(`${flag} — ${sh.type || "Shipment"} by ${fmtDate(sh.date)}`);
    }

    // Prep checklist
    const cl = nextShow.checklist || [];
    if (cl.length > 0) {
      const done  = cl.filter(t => t.done).length;
      const open  = cl.filter(t => !t.done);
      const pct   = Math.round(done / cl.length * 100);
      lines.push(`✅ Prep: ${done}/${cl.length} (${pct}%)${open.length > 0 ? ` · Open: ${open.slice(0, 3).map(t => t.task).join(", ")}${open.length > 3 ? ` +${open.length - 3}` : ""}` : " 🎉 All done!"}`);
    }
    lines.push("");
  }

  // ── Tasks section ────────────────────────────────────────────────────────
  const overdue  = todosArr.filter(t => !t.done && t.dueDate && t.dueDate < todayStr);
  const dueToday = todosArr.filter(t => !t.done && t.dueDate === todayStr);
  const dueSoon  = todosArr.filter(t => !t.done && t.dueDate > todayStr && daysBetween(todayStr, t.dueDate) <= 3);

  if (overdue.length || dueToday.length || dueSoon.length) {
    lines.push(`📋 <b>Tasks</b>`);
    if (overdue.length)
      lines.push(`🔴 ${overdue.length} overdue: ${overdue.slice(0, 3).map(t => t.text).join(", ")}${overdue.length > 3 ? ` +${overdue.length - 3} more` : ""}`);
    if (dueToday.length)
      lines.push(`🟡 ${dueToday.length} due today: ${dueToday.slice(0, 3).map(t => t.text).join(", ")}`);
    if (dueSoon.length)
      lines.push(`🔵 ${dueSoon.length} due in ≤3 days`);
    lines.push("");
  }

  // ── Finance: invoices ────────────────────────────────────────────────────
  const unpaidInv = invoicesArr.filter(i =>
    i.type !== "proforma" && !["paid", "cancelled"].includes(i.status)
  );
  const overdueInv = unpaidInv.filter(i => i.dueDate && i.dueDate < todayStr);
  if (unpaidInv.length > 0) {
    const totalOwed = unpaidInv.reduce((s, i) => s + (+(i.totalAmount || 0) - +(i.paidAmount || 0)), 0);
    lines.push(`💰 <b>Outstanding invoices</b>`);
    lines.push(`📄 ${unpaidInv.length} open · ₹${totalOwed.toLocaleString("en-IN")}`);
    if (overdueInv.length > 0)
      lines.push(`⚠️ ${overdueInv.length} overdue!`);
    lines.push("");
  }

  // ── Finance: bills (payables) ────────────────────────────────────────────
  const unpaidBills = purchArr.filter(p =>
    p.type === "bill" && !["paid", "cancelled"].includes(p.status)
  );
  if (unpaidBills.length > 0) {
    const totalBills = unpaidBills.reduce((s, b) => s + (+(b.totalAmount || 0) - +(b.paidAmount || 0)), 0);
    lines.push(`💳 <b>Bills payable</b>`);
    lines.push(`📑 ${unpaidBills.length} open · ₹${totalBills.toLocaleString("en-IN")}`);
    lines.push("");
  }

  // ── Monthly expenses ─────────────────────────────────────────────────────
  const thisMonth = todayStr.slice(0, 7);
  const monthExp  = expArr.filter(e => (e.date || "").startsWith(thisMonth));
  const monthExpTotal = monthExp.reduce((s, e) => s + +(e.amount || 0), 0);
  if (monthExpTotal > 0) {
    lines.push(`🧾 Expenses this month: ₹${monthExpTotal.toLocaleString("en-IN")} (${monthExp.length} entries)`);
    lines.push("");
  }

  // ── Stock summary ────────────────────────────────────────────────────────
  const physStock = stockArr.filter(s => !s.type || s.type === "physical");
  const recentStock = physStock
    .filter(s => s.addedDate && daysBetween(s.addedDate, todayStr) <= 7)
    .slice(-5);
  if (recentStock.length > 0) {
    lines.push(`💎 ${recentStock.length} item${recentStock.length !== 1 ? "s" : ""} added this week`);
    lines.push("");
  }

  // ── Footer ───────────────────────────────────────────────────────────────
  lines.push(`<i>Nikhil Gems · <a href="https://project-nine-tan-22.vercel.app">Open app</a></i>`);

  const message = lines.join("\n");

  // Send to all allowed chat IDs
  const results = await Promise.allSettled(chatIds.map(cid => tgSend(cid, message, token)));
  const sent    = results.filter(r => r.status === "fulfilled").length;

  return res.status(200).json({ ok: true, sentTo: sent, of: chatIds.length });
}
