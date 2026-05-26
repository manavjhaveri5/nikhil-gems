export const config = { api: { bodyParser: { sizeLimit: "20mb" } }, maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { images, account = "" } = req.body || {};
    if (!images?.length) return res.status(400).json({ error: "images required" });

    const content = [
      ...images.map(b64 => ({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${b64}`, detail: "high" },
      })),
      {
        type: "text",
        text: `These images show a financial transaction ledger${account ? ` for account: ${account}` : ""}.

Extract all rows and respond with ONLY this JSON (no markdown, no explanation):
{
  "opening_balance": 12345.67,
  "closing_balance": 9876.54,
  "transactions": [
    {"date":"YYYY-MM-DD","description":"...","type":"credit|debit","amount":1234.56,"balance":9876.54,"category":"..."}
  ]
}

Rules:
- opening_balance: the starting balance shown before any rows
- closing_balance: the final balance at the end
- balance on each row: the running balance shown AFTER that transaction
- Include ALL rows, sorted by date ascending (oldest first)
- Do NOT include the opening/closing balance rows as transactions
- amount is always a positive number; debit = money OUT, credit = money IN
- category: UPI, NEFT, IMPS, ATM, Bank Charges, Interest, Transfer, Salary, etc.
- If a balance value is not visible set it to null`,
      },
    ];

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 4096,
        temperature: 0,
        messages: [{ role: "user", content }],
      }),
    });

    const raw = await r.text();
    let data;
    try { data = JSON.parse(raw); } catch { return res.status(500).json({ error: raw.slice(0, 300) }); }
    if (!r.ok) return res.status(r.status).json({ error: data.error?.message || "OpenAI error", detail: data });

    const aiContent = data.choices?.[0]?.message?.content || "";
    if (!aiContent) return res.status(500).json({ error: "Empty AI response", debug: JSON.stringify(data).slice(0, 400) });

    const cleaned = aiContent.replace(/```json|```/g, "").trim();
    const oi = cleaned.indexOf("{"), oe = cleaned.lastIndexOf("}");
    if (oi === -1) return res.status(500).json({ error: "Could not parse AI response", raw: aiContent.slice(0, 800) });

    let parsed;
    try { parsed = JSON.parse(cleaned.slice(oi, oe + 1)); } catch {
      return res.status(500).json({ error: "Could not parse AI response", raw: aiContent.slice(0, 800) });
    }

    const transactions = Array.isArray(parsed.transactions) ? parsed.transactions
      : Array.isArray(parsed) ? parsed : [];

    return res.json({
      transactions,
      opening_balance: parsed.opening_balance ?? null,
      closing_balance: parsed.closing_balance ?? null,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}
