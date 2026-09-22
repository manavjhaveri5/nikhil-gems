#!/usr/bin/env node
/* Denver Mineral Show 2026 — put back two invoices the booth issued on paper
   but the app no longer holds.

   NG-2026-0020 (Peace Love and Crystal Healing, $347.05) was deleted from the
   list; its number is free, so it goes back under it. The Moonrise Crystals
   sale ($2,673.50) was printed as NG-2026-0017 and then overwritten on
   2026-09-18 by an edit that replaced it with a different customer entirely;
   that number is occupied by a real invoice, so this sale comes back at the
   end of the series instead and the customer needs a corrected copy.

   Both are transcribed from the printed PDFs. Neither carries stockEffects:
   the cards they sold were stamped when the invoice was first issued, and
   writing effects again here would take the stock down twice.

   Read-modify-write on one array. Run it once, with nobody writing invoices
   in the app at the same time. It refuses to run if either number is already
   present, so a second run is a no-op rather than a duplicate.
*/
import { createClient } from "@supabase/supabase-js";

try { process.loadEnvFile(new URL(".env", import.meta.url)); } catch {}

const SUPABASE_URL     = process.env.SUPABASE_URL || "https://bxnqnbspibvbnxbojrhe.supabase.co";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_SERVICE_ROLE_KEY — put it in .env next to this script.");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const KEY = "ng-show-invoices-v1";
const now = new Date().toISOString();
const uid = () => Math.random().toString(36).slice(2, 11);

// desc, shape, qty, unit, rate, note
const line = (desc, shape, qty, unit, rate, note = "") =>
  ({ id: uid(), desc, shape, qty: String(qty), unit, rate: String(rate), note, basis: null, stockId: null });

const show = {
  showId: "denver-2026", showSlug: "denver-2026", showName: "Denver Mineral Show",
  currency: "USD", status: "issued", taxPct: "0",
  discount: "", discountMode: "amt", shipping: "",
  payments: [], stockEffects: [], showMethods: [],
  showPay: ["zelle#poazjf50p", "wire#6sosgscdd", "cheque#793c4rhso"],
  createdAt: now, issuedAt: now, updatedAt: now,
};

const INVOICES = [
  {
    ...show,
    id: uid(),
    invNo: "NG-2026-0020",
    date: "2026-09-05",
    notes: "Restored from the printed invoice. The record was deleted from the app; the paper the customer holds is the source for these lines.",
    customer: {
      id: "ly7xtzbks", name: "Peace Love and Crystal Healing", company: "Peace Love and Crystal Healing",
      email: "", phone: "", city: "", state: "Ohio", country: "",
      resaleNo: "43259513", notes: "", addToList: true,
    },
    lines: [
      line("Flint", "Palmstone", "0.26", "kgs", "350"),
      line("Variscite", "Heart", "0.23", "kgs", "300"),
      line("Dendritic Opal", "Slice", "1", "flat", "52", "52 cm at $1.00/cm"),
      line("Thulite", "Palmstone", "0.073", "kgs", "250"),
      line("Thulite", "Mini Heart", "1", "pcs", "3"),
      line("Golden Sapphire", "Mini Hearts", "3", "pcs", "5"),
      line("Seraphinite", "Palmstone", "0.065", "kgs", "350"),
      line("Rhodochrosite", "Mini Spheres", "0.053", "kgs", "350"),
      line("Coppernite", "Tower", "1", "pcs", "9.5"),
      line("Unicorn", "Tower", "1", "pcs", "4.5"),
      line("Banded Jasper", "Palmstone", "1", "pcs", "4.5"),
      line("Pendulums", "", "13", "pcs", "3"),
    ],
    expect: 347.05,
  },
  {
    ...show,
    id: uid(),
    invNo: "NG-2026-0033",
    date: "2026-09-14",
    notes: "Shipped with insurance value of $2500. Printed at the booth as NG-2026-0017; that number was overwritten in the app on 2026-09-18 and now holds a different customer, so this sale is recorded here. The buyer's copy shows the old number and needs replacing.",
    customer: {
      id: uid(), name: "Julie", company: "Moonrise Crystals",
      email: "", phone: "", city: "", state: "Hawaii", country: "",
      resaleNo: "", notes: "", addToList: true,
    },
    lines: [
      line("Moss Agate", "Flatstone", "56", "pcs", "3"),
      line("Australian Malachite", "Heart", "1.2", "kgs", "200"),
      line("Aquamarine", "Mini Hearts", "358", "grams", "0.6"),
      line("Rhodonite", "Mini Hearts", "442", "grams", "0.5"),
      line("Outback Jasper", "Heart", "2", "kgs", "200"),
      line("Prehnite", "Heart", "2", "kgs", "150"),
      line("Thulite", "Mini Heart", "325", "grams", "0.6"),
      line("Rainbow Moonstone", "Flatstone", "50", "pcs", "2.75"),
      line("Gem Lepidolite", "Heart", "30", "pcs", "4"),
      line("Ruby Fuchsite", "Heart", "2", "kgs", "75"),
      line("Chiastolite", "Mini Hearts", "209", "grams", "0.8"),
      line("Ruby", "Mini Heart", "30", "pcs", "7"),
      line("Shipping", "", "1", "flat", "150"),
    ],
    expect: 2673.50,
  },
];

const money = n => "$" + n.toFixed(2);
const sum = inv => inv.lines.reduce((a, l) => a + Number(l.qty) * Number(l.rate), 0);

// The printed paper is the authority. If a transcription does not add up to what
// the customer was charged, nothing is written.
for (const inv of INVOICES) {
  const got = Math.round(sum(inv) * 100) / 100;
  if (got !== inv.expect) {
    console.error(`${inv.invNo}: lines total ${money(got)}, invoice says ${money(inv.expect)} — not writing.`);
    process.exit(1);
  }
  console.log(`${inv.invNo}  ${inv.customer.company.padEnd(32)} ${inv.lines.length} lines  ${money(got)}  ✓ ties to the printed total`);
}

const { data, error } = await supabase.from("app_data").select("value").eq("key", KEY).single();
if (error) { console.error("Read failed:", error.message); process.exit(1); }
const current = Array.isArray(data.value) ? data.value : [];
console.log(`\nInvoice list holds ${current.length} invoices.`);

const clash = INVOICES.filter(inv => current.some(c => c?.invNo === inv.invNo));
if (clash.length) {
  console.error(`Already present: ${clash.map(c => c.invNo).join(", ")} — nothing written.`);
  process.exit(1);
}

// Newest first, the order the app writes in.
const next = [...INVOICES].reverse().concat(current);
const { error: wErr } = await supabase.from("app_data").upsert({ key: KEY, value: next });
if (wErr) { console.error("Write failed:", wErr.message); process.exit(1); }

const { data: check } = await supabase.from("app_data").select("value").eq("key", KEY).single();
const after = Array.isArray(check.value) ? check.value : [];
const found = INVOICES.map(i => i.invNo).filter(no => after.some(c => c?.invNo === no));
console.log(`Wrote ${after.length} invoices. Confirmed back from the server: ${found.join(", ")}`);
if (found.length !== INVOICES.length) { console.error("Not everything landed — check the app."); process.exit(1); }
