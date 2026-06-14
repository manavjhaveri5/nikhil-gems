// OpenAI embeddings endpoint for the accounting classification learner.
// Turns transaction text into 512-dim "meaning vectors" used for semantic
// retrieval of similar past decisions. Batch-friendly: pass a string or array.
export const config = { api: { bodyParser: { sizeLimit: "4mb" } } };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const key = process.env.OPENAI_KEY || process.env.OPENAI_API_KEY;
  if (!key) return res.status(500).json({ error: "OPENAI_KEY not set" });
  try {
    const input = req.body?.input;
    if (input == null || (Array.isArray(input) && input.length === 0)) {
      return res.status(400).json({ error: "input (string or string[]) required" });
    }
    const r = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        dimensions: 512,
        input,
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.error?.message || "embedding failed", details: data });
    // Preserve input order; return just the vectors.
    const embeddings = (data.data || [])
      .sort((a, b) => (a.index || 0) - (b.index || 0))
      .map(d => d.embedding);
    return res.status(200).json({ embeddings });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
