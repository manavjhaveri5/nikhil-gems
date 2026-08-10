// ─── Documents module: AI classification + bulk file helpers ─────────────────
// Kept out of DocumentsApp.jsx so the UI file stays readable, and so the heavy
// bits (pdf-lib, jszip) can be dynamically imported only when actually used.

import { downscaleImageFile } from "./storageUtils.js";

export const IMG_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
export const isImageFile = f => String(f?.type || "").startsWith("image/");
export const isPdfFile = f => String(f?.type || "").includes("pdf") || /\.pdf$/i.test(f?.name || "");

// /api/claude forwards the base64 payload to the model, and the function body is
// capped at 20 MB. Base64 inflates by ~4/3, so keep the raw file under 8 MB —
// anything larger is stored without classification rather than failing the upload.
const AI_MAX_BYTES = 8 * 1024 * 1024;

const fileToBase64 = file => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result || "").split(",")[1] || "");
  r.onerror = () => reject(new Error("Could not read file"));
  r.readAsDataURL(file);
});

const CATEGORY_IDS = ["identity", "tax", "utility", "licence", "property", "banking", "insurance", "vehicle", "certs", "other"];

const PROMPT = `You are filing a document into a small Indian business's document vault (a gemstone exporter — Nikhil Gems / Atyahara).

Read the attached document and return ONLY valid JSON, no markdown fences:
{"category":"one of: ${CATEGORY_IDS.join(" | ")}",
 "title":"short human title, max 8 words, e.g. 'Passport — Nikhil Jhaveri' or 'Electricity bill — Aug 2026'",
 "owner":"person or company the document belongs to, exactly as printed, else empty string",
 "refNo":"the document's own number — passport no., PAN, consumer no., policy no., acknowledgement no. — else empty string",
 "issueDateRaw":"issue/filing/bill date exactly as printed e.g. 02/06/2025, else empty string",
 "expiryDateRaw":"expiry/valid-till/due date exactly as printed, else empty string",
 "tags":["2 to 4 short lowercase keywords, e.g. mseb, fy2024-25, renewal"],
 "notes":"one short sentence on what this is, max 20 words"}

Category guide:
identity = passport, PAN, Aadhaar, driving licence, voter ID
tax = ITR, GST returns, TDS, challans, tax notices
utility = electricity, water, gas, internet, phone bills
licence = IEC, GST registration certificate, Shop Act, MSME, trade licence
property = rent/lease agreements, property tax, society bills, sale deeds
banking = bank statements, AD code letters, loan papers, cheques
insurance = any insurance policy (health, fire, transit, vehicle)
vehicle = RC book, PUC, permits, vehicle papers
certs = degrees, gemmology certificates, awards, lab reports
other = anything that fits none of the above

Indian dates are DAY/MONTH/YEAR. Never invent a value — use an empty string when it is not printed.`;

// Indian documents print DD/MM/YYYY; also accept ISO and "12 Mar 2024" forms.
export function parseLooseDate(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/\-. ](\d{1,2})[/\-. ](\d{2,4})$/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = String(+y > 70 ? 1900 + +y : 2000 + +y);
    if (+mo > 12) [d, mo] = [mo, d]; // tolerate a stray MM/DD source
    if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) return "";
    return `${y}-${String(+mo).padStart(2, "0")}-${String(+d).padStart(2, "0")}`;
  }
  const t = Date.parse(s);
  if (!isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  return "";
}

// Ask the model what this document is. Returns a partial document record, or
// null when the file can't be classified (too big, unsupported, model failure).
// Never throws — a failed classification must not lose the upload.
export async function classifyDocument(file) {
  try {
    if (!isPdfFile(file) && !isImageFile(file)) return null;
    const payload = isImageFile(file) ? await downscaleImageFile(file) : file;
    if (payload.size > AI_MAX_BYTES) return null;

    const b64 = await fileToBase64(payload);
    if (!b64) return null;
    const mime = isImageFile(payload) ? (IMG_MIMES.has(payload.type) ? payload.type : "image/jpeg") : "application/pdf";

    const res = await fetch("/api/claude", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 500,
        messages: [{
          role: "user",
          content: [
            mime.startsWith("image/")
              ? { type: "image", source: { type: "base64", media_type: mime, data: b64 } }
              : { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64, filename: file.name } },
            { type: "text", text: `${PROMPT}\n\nThe uploaded file is named: ${file.name}` },
          ],
        }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.error) return null;

    const text = (data.content || []).map(c => c.text || "").join("").replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));

    return {
      category: CATEGORY_IDS.includes(parsed.category) ? parsed.category : "other",
      title: String(parsed.title || "").trim().slice(0, 90),
      owner: String(parsed.owner || "").trim().slice(0, 60),
      refNo: String(parsed.refNo || "").trim().slice(0, 50),
      issueDate: parseLooseDate(parsed.issueDateRaw),
      expiryDate: parseLooseDate(parsed.expiryDateRaw),
      tags: (Array.isArray(parsed.tags) ? parsed.tags : []).map(t => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 4),
      notes: String(parsed.notes || "").trim().slice(0, 160),
    };
  } catch {
    return null;
  }
}

// A readable fallback title when the model can't help: "iec-cert_2024.pdf" → "Iec cert 2024".
export function titleFromFileName(name) {
  const base = String(name || "Document").replace(/\.[^.]+$/, "").replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim();
  return (base.charAt(0).toUpperCase() + base.slice(1)).slice(0, 90) || "Document";
}

const fetchBlob = async url => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not fetch file (HTTP ${res.status})`);
  return res.blob();
};

const triggerDownload = (blob, name) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
};

// One file downloads as itself; several are zipped so the browser asks once.
// Folders inside the zip are named after the document, so the export is readable.
export async function downloadDocuments(docs, onProgress) {
  const entries = [];
  docs.forEach(d => (d.files || []).forEach(f => entries.push({ doc: d, file: f })));
  if (!entries.length) throw new Error("Nothing to download — those documents have no files");

  if (entries.length === 1) {
    const { file } = entries[0];
    triggerDownload(await fetchBlob(file.url), file.name || "document");
    return 1;
  }

  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const used = new Set();
  let done = 0;
  for (const { doc, file } of entries) {
    try {
      const folder = String(doc.title || "Document").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 60);
      let path = `${folder}/${file.name || "file"}`;
      while (used.has(path)) path = path.replace(/(\.[^.]*)?$/, m => `-${Math.random().toString(36).slice(2, 6)}${m}`);
      used.add(path);
      zip.file(path, await fetchBlob(file.url));
    } catch { /* skip the unreachable file, keep the rest of the zip */ }
    onProgress?.(++done, entries.length);
  }
  const blob = await zip.generateAsync({ type: "blob" });
  triggerDownload(blob, `documents-${new Date().toISOString().slice(0, 10)}.zip`);
  return entries.length;
}

// Merge the selected documents' files into one PDF — PDFs are copied page by
// page, images become full pages — so "print" is a single trip to the printer
// instead of one tab per file.
export async function buildPrintPdf(docs) {
  const { PDFDocument } = await import("pdf-lib");
  const out = await PDFDocument.create();
  let added = 0;
  const skipped = [];

  for (const doc of docs) {
    for (const file of doc.files || []) {
      try {
        const blob = await fetchBlob(file.url);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const type = `${blob.type || file.type || ""} ${file.name || ""}`.toLowerCase();

        if (type.includes("pdf")) {
          const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
          const pages = await out.copyPages(src, src.getPageIndices());
          pages.forEach(p => out.addPage(p));
          added++;
        } else if (/png/.test(type)) {
          const img = await out.embedPng(bytes);
          addImagePage(out, img);
          added++;
        } else if (/jpe?g/.test(type)) {
          const img = await out.embedJpg(bytes);
          addImagePage(out, img);
          added++;
        } else {
          skipped.push(file.name);
        }
      } catch {
        skipped.push(file.name);
      }
    }
  }
  if (!added) throw new Error("Nothing printable in that selection (PDFs and JPG/PNG only)");
  return { bytes: await out.save(), skipped };
}

// Fit the image inside A4 with a small margin, keeping its aspect ratio.
function addImagePage(pdf, img) {
  const A4 = [595.28, 841.89], margin = 24;
  const maxW = A4[0] - margin * 2, maxH = A4[1] - margin * 2;
  const scale = Math.min(maxW / img.width, maxH / img.height, 1);
  const w = img.width * scale, h = img.height * scale;
  const page = pdf.addPage(A4);
  page.drawImage(img, { x: (A4[0] - w) / 2, y: (A4[1] - h) / 2, width: w, height: h });
}

export function openPdfBytes(bytes, tab) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  if (tab) tab.location.href = url;
  else window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}
