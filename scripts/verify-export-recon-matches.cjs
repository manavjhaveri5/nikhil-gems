const fs = require("fs");
const { PDFParse } = require("pdf-parse");

const bundlePath =
  process.argv[2] || "/Users/manavjhaveri/Downloads/project/export-recon-full-with-files-2026-06-03.json";
const reportPath =
  process.argv[3] || "/Users/manavjhaveri/Downloads/project/export-recon-verification-report.csv";

const norm = (value) => String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const num = (value) => Number(String(value || "").replace(/[^0-9.]/g, ""));
const esc = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;

async function extract(file) {
  const parser = new PDFParse({ data: fs.readFileSync(file) });
  const result = await parser.getText();
  await parser.destroy();
  return result.text || "";
}

function amountPresent(text, amount) {
  const n = num(amount);
  if (!n) return "";
  const variants = new Set([
    n.toFixed(2),
    String(n),
    Math.round(n).toString(),
    n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  ]);
  const flat = text.replace(/\s+/g, " ");
  for (const v of variants) {
    if (flat.includes(v)) return "yes";
  }
  return "no";
}

function contextFor(text, needle) {
  const idx = norm(text).indexOf(norm(needle));
  if (idx < 0) return "";
  const flat = text.replace(/\s+/g, " ");
  const plainIdx = flat.toUpperCase().replace(/[^A-Z0-9]/g, "").indexOf(norm(needle));
  return flat.slice(Math.max(0, plainIdx - 120), plainIdx + 220);
}

async function main() {
  const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
  const meta = bundle.meta || {};
  const fircs = new Map((meta.fircs || []).map((f) => [f.id, f]));
  const sbs = new Map((meta.shippingBills || []).map((sb) => [sb.id, sb]));
  const matchRows = [
    ...(bundle.recovery?.fircMatches || []).map((m) => ({
      type: "FIRC",
      key: `firc:${[...fircs.values()].find((f) => f.number === m.number)?.id || ""}`,
      record: m.number,
      amount: [...fircs.values()].find((f) => f.number === m.number)?.amount || "",
      date: [...fircs.values()].find((f) => f.number === m.number)?.date || "",
      file: m.file,
    })),
    ...(bundle.recovery?.sbMatches || []).map((m) => ({
      type: "Shipping Bill",
      key: `sb:${[...sbs.values()].find((sb) => sb.sbNumber === m.sbNumber)?.id || ""}`,
      record: m.sbNumber,
      amount: [...sbs.values()].find((sb) => sb.sbNumber === m.sbNumber)?.amount || "",
      date: [...sbs.values()].find((sb) => sb.sbNumber === m.sbNumber)?.date || "",
      file: m.file,
    })),
  ];

  const rows = [["type", "record", "source_pdf", "exact_number_in_pdf", "amount_in_pdf", "date_metadata", "verdict", "context"]];
  let pass = 0;
  let review = 0;
  let fail = 0;

  for (let i = 0; i < matchRows.length; i += 1) {
    const row = matchRows[i];
    let text = "";
    let exact = "no";
    let amount = "";
    let verdict = "FAIL";
    let context = "";
    try {
      text = await extract(row.file);
      exact = norm(text).includes(norm(row.record)) || norm(row.file).includes(norm(row.record)) ? "yes" : "no";
      amount = amountPresent(text, row.amount);
      context = contextFor(text, row.record);
      if (exact === "yes" && (amount === "yes" || amount === "")) verdict = "PASS";
      else if (exact === "yes") verdict = "REVIEW_AMOUNT";
      else verdict = "FAIL";
    } catch (error) {
      context = error.message;
    }
    if (verdict === "PASS") pass += 1;
    else if (verdict === "FAIL") fail += 1;
    else review += 1;
    rows.push([row.type, row.record, row.file, exact, amount, row.date, verdict, context]);
    if ((i + 1) % 25 === 0) console.log(`verified ${i + 1}/${matchRows.length}`);
  }

  fs.writeFileSync(reportPath, rows.map((r) => r.map(esc).join(",")).join("\n"));
  console.log(`wrote ${reportPath}`);
  console.log(`PASS=${pass} REVIEW=${review} FAIL=${fail} TOTAL=${matchRows.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
