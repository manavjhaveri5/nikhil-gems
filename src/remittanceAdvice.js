/* Foreign inward remittance advice (Bank of India "FOREIGN INWARD REMITTANCE
   ADVICE", file names like 0013IRT26000910.pdf).

   These are fixed-template, text-layer PDFs covering a single transaction — not
   a statement — so they are parsed deterministically off the text rather than
   sent through the vision model. Remittance amounts have to be exact, and OCR of
   a ruled column layout is the wrong tool for that.

   Two settlement shapes appear in practice and they book very differently:

   converted — the bank buys the foreign currency and credits the INR operative
     account. The advice shows a real rate (e.g. USD 5725 @ 95.20 = INR 545020)
     and an "Operative … INR Cr" row for the net after commission and GST. That
     net is what shows up on the INR bank statement, so it is the amount booked
     and the gross plus charges are kept in the notes for the export paperwork.

   eefc — the money stays in foreign currency in the EEFC account. The conversion
     row is a no-op (USD → USD @ 1.0000), an "EEFC … USD Cr" row holds the real
     credit, and the "Operative … INR Dr" row is only the bank recovering its
     charges. Booking such a remittance as an INR credit would invent rupees that
     never arrived, so the credit is reported in its own currency and the INR
     charge is returned as a separate debit. */

/* pdf.js hands back positioned text runs, not lines, but this template is read
   by line (the "Transaction Details" table is column-aligned). Bucket runs by
   their y coordinate — with a small tolerance, since glyphs on one visual line
   are rarely at an identical y — then order each line left to right. */
export function linesFromTextItems(items = []) {
  const buckets = new Map();
  for (const it of items) {
    const str = it?.str ?? "";
    if (!str.trim()) continue;
    const y = Math.round((it.transform?.[5] ?? 0) / 2) * 2;
    if (!buckets.has(y)) buckets.set(y, []);
    buckets.get(y).push(it);
  }
  return [...buckets.entries()]
    .sort((a, b) => b[0] - a[0])                       // top of page first
    .map(([, runs]) => runs
      .sort((a, b) => (a.transform?.[4] ?? 0) - (b.transform?.[4] ?? 0))
      .map(r => r.str).join(" ")
      .replace(/\s+/g, " ").trim())
    .join("\n");
}

export const isRemittanceAdvice = text =>
  /FOREIGN\s+INWARD\s+REMITTANCE\s+ADVICE/i.test(String(text || ""));

const num = s => {
  const n = parseFloat(String(s ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};
// The advice prints DD-MM-YYYY; ISO keeps it unambiguous downstream.
const isoDate = s => {
  const m = /(\d{2})-(\d{2})-(\d{4})/.exec(String(s || ""));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : "";
};
const grab = (re, text) => {
  const m = re.exec(text);
  return m ? m[1].trim() : "";
};
const money = n => (n == null ? "" : n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

/* Rows of the "Transaction Details" table:
   <Type> <AccountNo|Office Acct> <Name…> <CUR> <Cr|Dr> <Amount> */
const ROW = /^\s*(EEFC|Operative|Commission)\s+(\S+(?:\s+Acct)?)\s+(.+?)\s+([A-Z]{3})\s+(Cr|Dr)\s+([\d,]+\.?\d*)\s*$/gim;

function tableRows(text) {
  const out = [];
  let m;
  ROW.lastIndex = 0;
  while ((m = ROW.exec(text)) !== null) {
    out.push({
      type: m[1].toLowerCase(), account: m[2], name: m[3].trim(),
      currency: m[4].toUpperCase(), dir: m[5].toLowerCase(), amount: num(m[6]),
    });
  }
  return out;
}

export function parseRemittanceAdvice(rawText) {
  const text = String(rawText || "").replace(/\r/g, "");
  if (!isRemittanceAdvice(text)) return null;

  const remittanceNo = grab(/Remittance\s+No\.?\s*:?\s*([A-Za-z0-9]+)/i, text);
  const transactionId = grab(/Transaction\s+Id\s*:?\s*(\S+)/i, text);
  const date = isoDate(grab(/Transaction\s+Date\s*:?\s*([\d-]+)/i, text));
  const valueDate = isoDate(grab(/Nostro\s+Value\s+Date\s*:?\s*([\d-]+)/i, text));
  const remitter = grab(/Remitter\s+Name\s*:?\s*(.+)/i, text);
  const remitterBank = grab(/Remitter\s+Bank\s*:?\s*(.+)/i, text).replace(/\s*,\s*/g, ", ");
  const purpose = grab(/Purpose\s*:?\s*(.+)/i, text);
  const notionalRate = num(grab(/Notional\s+Rate\s*:?\s*([\d.]+)/i, text));

  /* Conversion row, e.g. "Purchase : USD 5725.00 95.2000 INR 545020.00" */
  const conv = /(?:Purchase|Sale)\s*:?\s*([A-Z]{3})\s+([\d,]+\.?\d*)\s+([\d,]+\.?\d*)\s+([A-Z]{3})\s+([\d,]+\.?\d*)/i.exec(text);
  const foreignCurrency = conv ? conv[1].toUpperCase() : "";
  const foreignAmount = conv ? num(conv[2]) : null;
  const convRate = conv ? num(conv[3]) : null;
  const toCurrency = conv ? conv[4].toUpperCase() : "";
  const toAmount = conv ? num(conv[5]) : null;

  const rows = tableRows(text);
  const eefcCredit = rows.find(r => r.type === "eefc" && r.dir === "cr");
  const operative = rows.find(r => r.type === "operative");
  const commission = rows.filter(r => r.type === "commission").reduce((s, r) => s + (r.amount || 0), 0);

  // A no-op conversion row (same currency, rate 1) means the money never became rupees.
  const isEefc = !!eefcCredit || (!!conv && foreignCurrency === toCurrency);

  let creditCurrency, creditAmount, grossAmount, charges, chargeCurrency, rate;
  if (isEefc) {
    creditCurrency = eefcCredit?.currency || foreignCurrency;
    creditAmount = eefcCredit?.amount ?? foreignAmount;
    grossAmount = creditAmount;
    rate = null;                                   // nothing was converted
    chargeCurrency = operative?.currency || "INR";
    charges = operative?.dir === "dr" ? operative.amount : (commission || null);
  } else {
    creditCurrency = operative?.currency || toCurrency || "INR";
    creditAmount = operative?.dir === "cr" ? operative.amount : toAmount;
    grossAmount = toAmount;
    rate = convRate ?? notionalRate;
    chargeCurrency = creditCurrency;
    charges = grossAmount != null && creditAmount != null
      ? Number((grossAmount - creditAmount).toFixed(2)) : (commission || null);
  }

  const notes = [
    `Inward remittance ${remittanceNo || ""}`.trim(),
    isEefc
      ? `${foreignCurrency} ${money(foreignAmount)} credited to EEFC account — not converted to INR`
      : (foreignAmount != null && rate != null
          ? `${foreignCurrency} ${money(foreignAmount)} @ ROE ${rate} = ${toCurrency} ${money(grossAmount)}`
          : ""),
    charges ? `Bank charges + GST ${chargeCurrency} ${money(charges)}${isEefc ? " debited separately" : ""}` : "",
    !isEefc && creditAmount != null ? `Net credit ${creditCurrency} ${money(creditAmount)}` : "",
    remitter ? `Remitter: ${remitter}${remitterBank ? ` (${remitterBank})` : ""}` : "",
    purpose ? `Purpose: ${purpose}` : "",
    transactionId ? `Txn ${transactionId}` : "",
    valueDate && valueDate !== date ? `Value date ${valueDate}` : "",
  ].filter(Boolean).join(" · ");

  const payee = remitter || "Inward remittance";

  return {
    documentType: "inward_remittance",
    settlement: isEefc ? "eefc" : "converted",
    remittanceNo, transactionId,
    accountNumber: (isEefc ? eefcCredit?.account : operative?.account) || "",
    date, valueDate, remitter, remitterBank, purpose,
    foreignCurrency, foreignAmount, rate, notionalRate,
    creditCurrency, creditAmount, grossAmount, charges, chargeCurrency,
    // Shape the import modal consumes, alongside statement rows.
    transaction: {
      date, type: "credit", amount: creditAmount, currency: creditCurrency,
      payee, description: payee, category: "Inward Remittance", notes, balance: null,
    },
    // EEFC advices also debit the INR account for the bank's commission.
    chargeTransaction: isEefc && charges
      ? {
          date, type: "debit", amount: charges, currency: chargeCurrency,
          payee: "Bank of India", description: "Inward remittance charges",
          category: "Bank Charges",
          notes: `Charges + GST on inward remittance ${remittanceNo}${remitter ? ` from ${remitter}` : ""}`,
          balance: null,
        }
      : null,
  };
}
