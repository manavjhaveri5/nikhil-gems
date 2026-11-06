/* Shared by lib/girton.js and the Girton page; no imports, so the browser can load it. */
/* What the business pays each month for its tools, editable on the page.
   "metered" plans take their amount from Girton's own meter. Amounts marked
   check: true are Girton's best guess until Sir corrects them. */
export const DEFAULT_PLANS = [
  { id: "supabase", name: "Supabase", plan: "Pro", usd: 25, note: "Database, storage, logins. Includes $10 compute credit." },
  { id: "vercel", name: "Vercel", plan: "Hobby", usd: 0, note: "ERP hosting. 12-function cap." },
  { id: "railway", name: "Railway", plan: "Hobby", usd: 5, check: true, note: "Telegram finance bot." },
  { id: "openai", name: "OpenAI API", plan: "Pay as you go", metered: true, note: "ERP AI, captions, studio shots, bot." },
  { id: "claude", name: "Claude", plan: "Pro", usd: 20, check: true, note: "Coding sessions, Raj and Girton's Mac tasks." },
];
