const fs = require("fs");
const path = require("path");
const { PDFParse } = require("pdf-parse");

const inputPath =
  process.argv[2] || "/Users/manavjhaveri/Downloads/export-recon-full-2026-06-03.json";
const outputPath =
  process.argv[3] || "/Users/manavjhaveri/Downloads/export-recon-full-with-files-2026-06-03.json";
const downloadsDir = "/Users/manavjhaveri/Downloads";

const norm = (value) => String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const base64 = (file) => fs.readFileSync(file).toString("base64");

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, out);
    else if (/\.pdf$/i.test(entry.name)) out.push(file);
  }
  return out;
}

function interestingPdf(file) {
  const name = path.basename(file);
  const parent = path.basename(path.dirname(file));
  return (
    /^FIRC-86936134/.test(parent) ||
    parent === "ShipGlobal shipping bills" ||
    /^(SB\s+CSBV|SG32|CITIN|FEMA|.*HAWB)/i.test(name)
  );
}

async function extractText(file) {
  try {
    const parser = new PDFParse({ data: fs.readFileSync(file) });
    const result = await parser.getText();
    await parser.destroy();
    return result.text || "";
  } catch (error) {
    return "";
  }
}

async function main() {
  const bundle = readJson(inputPath);
  const meta = bundle.meta || bundle;
  const fircs = Array.isArray(meta.fircs) ? meta.fircs : [];
  const shippingBills = Array.isArray(meta.shippingBills) ? meta.shippingBills : [];
  const files = { ...(bundle.files || {}) };

  const pdfs = walk(downloadsDir).filter(interestingPdf);
  const indexed = [];
  for (let i = 0; i < pdfs.length; i += 1) {
    const file = pdfs[i];
    const text = await extractText(file);
    indexed.push({
      file,
      fileNorm: norm(path.basename(file)),
      textNorm: norm(text),
      size: fs.statSync(file).size,
    });
    if ((i + 1) % 50 === 0) console.log(`indexed ${i + 1}/${pdfs.length} PDFs`);
  }

  const usedFiles = new Set();
  const fircMatches = [];
  const sbMatches = [];

  for (const firc of fircs) {
    const target = norm(firc.number);
    const match = indexed.find(
      (pdf) =>
        !usedFiles.has(pdf.file) &&
        (pdf.fileNorm.includes(target) || pdf.textNorm.includes(target))
    );
    if (match) {
      files[`firc:${firc.id}`] = base64(match.file);
      firc.hasPdf = true;
      usedFiles.add(match.file);
      fircMatches.push({ number: firc.number, file: match.file });
    }
  }
  for (const firc of fircs) {
    firc.hasPdf = Boolean(files[`firc:${firc.id}`]);
  }

  for (const sb of shippingBills) {
    const target = norm(sb.sbNumber);
    const candidates = indexed.filter(
      (pdf) =>
        !usedFiles.has(pdf.file) &&
        (pdf.fileNorm.includes(target) || pdf.textNorm.includes(target))
    );
    const match =
      candidates.find((pdf) => path.basename(path.dirname(pdf.file)) === "ShipGlobal shipping bills") ||
      candidates[0];
    if (match) {
      files[`sb:${sb.id}`] = base64(match.file);
      sb.hasSbPdf = true;
      usedFiles.add(match.file);
      sbMatches.push({ sbNumber: sb.sbNumber, file: match.file });
    }
  }
  for (const sb of shippingBills) {
    sb.hasSbPdf = Boolean(files[`sb:${sb.id}`]);
  }

  const fema = indexed.find((pdf) => /FEMA/i.test(path.basename(pdf.file)));
  if (fema) files.fema = base64(fema.file);

  const restored = {
    version: bundle.version || "er-meta-v5",
    exportedAt: new Date().toISOString(),
    meta: { ...meta, fircs, shippingBills },
    files,
    recovery: {
      source: inputPath,
      pdfsIndexed: indexed.length,
      fircsMatched: fircMatches.length,
      shippingBillsMatched: sbMatches.length,
      fileCount: Object.keys(files).length,
      unmatchedFircs: fircs.filter((f) => !files[`firc:${f.id}`]).map((f) => f.number),
      unmatchedShippingBills: shippingBills
        .filter((sb) => !files[`sb:${sb.id}`])
        .map((sb) => sb.sbNumber),
      fircMatches,
      sbMatches,
    },
  };

  fs.writeFileSync(outputPath, JSON.stringify(restored));
  console.log(`wrote ${outputPath}`);
  console.log(`indexed PDFs: ${indexed.length}`);
  console.log(`FIRCs matched: ${fircMatches.length}/${fircs.length}`);
  console.log(`Shipping bills matched: ${sbMatches.length}/${shippingBills.length}`);
  console.log(`Files in backup: ${Object.keys(files).length}`);
  console.log(`Size: ${(fs.statSync(outputPath).size / 1024 / 1024).toFixed(1)} MB`);
  if (restored.recovery.unmatchedFircs.length) {
    console.log("Unmatched FIRCs:");
    console.log(restored.recovery.unmatchedFircs.join("\n"));
  }
  if (restored.recovery.unmatchedShippingBills.length) {
    console.log("Unmatched shipping bills:");
    console.log(restored.recovery.unmatchedShippingBills.join("\n"));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
