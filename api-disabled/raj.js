export const config = { api: { bodyParser: { sizeLimit: "4mb" } } };

const TOOLS = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: `Search for gem/crystal/mineral pricing, trends, and market data from Etsy, eBay, Reddit, and other sources.
Use this to find:
- Current Etsy listing prices for specific stones (search "etsy [stone] [shape] price")
- eBay sold prices for market reality
- Reddit discussions on r/whatsthisrock, r/crystals, r/mineralcollectors for trends
- Instagram/TikTok trending stones
- Wholesale vs retail price benchmarks
Always cite specific prices found.`,
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "What to search for. Be specific. e.g. 'etsy afghani te sphere 10cm price 2024' or 'ruby fuchsite cube wholesale price india'"
          },
          site: {
            type: "string",
            enum: ["etsy", "ebay", "reddit", "general"],
            description: "Which site to focus on"
          }
        },
        required: ["query"]
      }
    }
  }
];

async function doSearch(query, site) {
  try {
    let url;
    if (site === "etsy") {
      url = `https://www.etsy.com/search?q=${encodeURIComponent(query)}&explicit=1`;
    } else if (site === "ebay") {
      // eBay completed listings shows actual sale prices
      url = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}&LH_Sold=1&LH_Complete=1`;
    } else if (site === "reddit") {
      url = `https://www.reddit.com/search/?q=${encodeURIComponent(query)}&sort=relevance&t=year`;
    } else {
      url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    }

    // Jina AI reader — free, no API key, returns clean markdown from any URL
    const r = await fetch(`https://r.jina.ai/${url}`, {
      headers: {
        "Accept": "text/plain",
        "X-Return-Format": "text",
        "User-Agent": "Mozilla/5.0 (compatible; NikhilGems/1.0)",
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!r.ok) return `Search failed (${r.status}) for: ${query}`;
    const text = await r.text();

    // Extract price-relevant lines to keep context focused
    const lines = text.split("\n");
    const priceLines = lines.filter(l =>
      /\$[\d,]+|\d+\s*(USD|usd|dollars?)|price|listing|sold|£[\d,]+|€[\d,]+/i.test(l)
    );
    const relevant = priceLines.length > 10 ? priceLines.slice(0, 60).join("\n") : text.slice(0, 3000);
    return `[Search: ${query}]\n${relevant}`;
  } catch (e) {
    return `Search error: ${e.message}`;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const key = process.env.OPENAI_KEY;
    if (!key) return res.status(500).json({ error: "OPENAI_KEY not set" });

    // Parse body — Vercel may or may not auto-parse depending on content-type
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON body" }); } }
    if (!body) return res.status(400).json({ error: "Empty body" });

    const { system, messages, maxTokens = 2000 } = body;
    if (!messages?.length) return res.status(400).json({ error: "messages required" });

    // Build messages array for OpenAI (system goes first as a system message)
    const cleaned = [];
    if (system) cleaned.push({ role: "system", content: system });
    for (const m of messages) {
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      if (cleaned.length > 0 && cleaned[cleaned.length - 1].role === m.role) {
        cleaned[cleaned.length - 1].content += "\n" + content;
      } else {
        cleaned.push({ role: m.role, content });
      }
    }
    // Ensure first non-system message is from user
    const firstNonSystem = cleaned.find(m => m.role !== "system");
    if (!firstNonSystem || firstNonSystem.role !== "user") {
      cleaned.push({ role: "user", content: "Hello" });
    }

    let msgs = cleaned;
    const MAX_LOOPS = 5;

    for (let loop = 0; loop < MAX_LOOPS; loop++) {
      const apiBody = {
        model: "gpt-4o",
        max_tokens: maxTokens,
        tools: TOOLS,
        messages: msgs,
      };

      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${key}`,
        },
        body: JSON.stringify(apiBody),
      });

      const rawText = await r.text();
      let data;
      try { data = JSON.parse(rawText); }
      catch { return res.status(500).json({ error: "OpenAI returned non-JSON: " + rawText.slice(0, 300) }); }

      if (!r.ok) return res.status(r.status).json({ error: data?.error?.message || rawText.slice(0, 300) });

      const choice = data.choices?.[0];
      const message = choice?.message;
      const finishReason = choice?.finish_reason;

      // Done — no tool calls
      if (finishReason !== "tool_calls" || !message?.tool_calls?.length) {
        const text = message?.content || "(no response)";
        return res.json({ text, searches: loop });
      }

      // Execute tool calls sequentially
      msgs = [...msgs, message];
      for (const tc of message.tool_calls) {
        let args;
        try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
        const result = await doSearch(args.query, args.site || "general");
        msgs = [...msgs, {
          role: "tool",
          tool_call_id: tc.id,
          content: result,
        }];
      }
    }

    return res.json({ text: "Reached search limit.", searches: MAX_LOOPS });

  } catch (err) {
    return res.status(500).json({ error: "Raj handler crashed: " + err.message, stack: err.stack?.slice(0, 500) });
  }
}
