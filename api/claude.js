import { requireUser } from "../lib/auth.js";
import { JOURNAL_WRITER_MODEL } from "../lib/instagramVoice.js";
export const config = {
  api: {
    bodyParser: {
      sizeLimit: "20mb",
    },
  },
  maxDuration: 60,
};

const OPENAI_URL = "https://api.openai.com/v1/responses";

function asText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => part?.text || "").filter(Boolean).join("\n");
  }
  return "";
}

function dataUrl(mime, b64) {
  return `data:${mime || "application/octet-stream"};base64,${b64}`;
}

function convertContent(content) {
  if (typeof content === "string") return [{ type: "input_text", text: content }];
  if (!Array.isArray(content)) return [{ type: "input_text", text: String(content || "") }];

  const converted = [];
  for (const part of content) {
    if (!part) continue;
    if (part.type === "text") {
      converted.push({ type: "input_text", text: part.text || "" });
      continue;
    }
    if (part.type === "image" && part.source?.data) {
      converted.push({
        type: "input_image",
        image_url: dataUrl(part.source.media_type || "image/jpeg", part.source.data),
      });
      continue;
    }
    if (part.type === "document" && part.source?.data) {
      converted.push({
        type: "input_file",
        filename: part.source.filename || "document.pdf",
        file_data: dataUrl(part.source.media_type || "application/pdf", part.source.data),
      });
      continue;
    }
    converted.push({ type: "input_text", text: part.text || JSON.stringify(part) });
  }
  return converted.length ? converted : [{ type: "input_text", text: "" }];
}

function convertMessages(messages = []) {
  const instructions = [];
  const input = [];

  for (const msg of messages) {
    if (!msg) continue;
    if (msg.role === "system") {
      instructions.push(asText(msg.content));
      continue;
    }
    input.push({
      role: msg.role === "assistant" ? "assistant" : "user",
      content: convertContent(msg.content),
    });
  }

  return { instructions: instructions.filter(Boolean).join("\n\n"), input };
}

function outputText(data) {
  if (data.output_text) return data.output_text;
  const chunks = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) chunks.push(content.text);
      if (content.type === "text" && content.text) chunks.push(content.text);
    }
  }
  return chunks.join("");
}

// ── Folded-in endpoints (merged to stay under Vercel's 12-function limit) ──
//  /api/openai → /api/claude?_ai=openai   (OpenAI chat/completions passthrough)
//  /api/embed  → /api/claude?_ai=embed     (OpenAI embeddings)
// Both are reached via rewrites in vercel.json; the route is detected below.
function detectRoute(req) {
  if (req.query?._ai) return req.query._ai;
  const u = String(req.url || "");
  if (/embed/.test(u)) return "embed";
  if (/openai/.test(u)) return "openai";
  return "claude";
}

async function handleOpenaiChat(req, res, key) {
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(typeof req.body === "string" ? JSON.parse(req.body) : req.body),
    });
    const data = await r.json();
    return res.status(r.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

async function handleEmbed(req, res, key) {
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const input = body.input;
    if (input == null || (Array.isArray(input) && input.length === 0)) {
      return res.status(400).json({ error: "input (string or string[]) required" });
    }
    const r = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "text-embedding-3-small", dimensions: 512, input }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.error?.message || "embedding failed", details: data });
    const embeddings = (data.data || []).sort((a, b) => (a.index || 0) - (b.index || 0)).map(d => d.embedding);
    return res.status(200).json({ embeddings });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// The model behind the eartheditions.co journal, called on Anthropic directly. Text only.
// Returns false when Anthropic refuses (e.g. no credit), so the request falls through to OpenAI.
async function handleJournalWriter(req, res) {
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const msgs = body.messages || [];
    const system = msgs.filter(m => m?.role === "system").map(m => asText(m.content)).join("\n\n");
    const messages = msgs.filter(m => m && m.role !== "system").map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: asText(m.content) }));
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: JOURNAL_WRITER_MODEL, max_tokens: body.max_tokens || 1000, ...(system ? { system } : {}), messages }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { console.warn(`journal writer unavailable, using OpenAI: ${data.error?.message || r.status}`); return false; }
    res.status(200).json({ id: data.id, model: data.model, content: (data.content || []).filter(b => b.type === "text"), usage: data.usage, provider: "anthropic" });
    return true;
  } catch (err) {
    console.warn(`journal writer unavailable, using OpenAI: ${err.message}`);
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  // The daily ops-check workflow (no user session) presents the store secret.
  if (!(await requireUser(req, res, { allowStoreSecret: true }))) return;

  // Social captions ask for the journal's writer by name; everything else stays on OpenAI.
  let writer;
  try { writer = (typeof req.body === "string" ? JSON.parse(req.body) : req.body || {}).writer; } catch { /* handled below */ }
  if (writer === "journal" && process.env.ANTHROPIC_KEY && (await handleJournalWriter(req, res))) return;

  const key = process.env.OPENAI_KEY || process.env.OPENAI_API_KEY;
  if (!key) return res.status(500).json({ error: { message: "OPENAI_KEY not set" } });

  const route = detectRoute(req);
  if (route === "openai") return handleOpenaiChat(req, res, key);
  if (route === "embed") return handleEmbed(req, res, key);

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const { instructions, input } = convertMessages(body.messages || []);
    if (!input.length) return res.status(400).json({ error: { message: "messages required" } });

    const model =
      process.env.OPENAI_RECON_MODEL ||
      process.env.OPENAI_MODEL ||
      (String(body.model || "").startsWith("claude") ? "gpt-4.1-mini" : body.model) ||
      "gpt-4.1-mini";

    const response = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        input,
        ...(instructions ? { instructions } : {}),
        max_output_tokens: body.max_output_tokens || body.max_tokens || 1000,
        temperature: body.temperature ?? 0,
      }),
    });

    const raw = await response.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return res.status(500).json({ error: { message: `OpenAI returned non-JSON: ${raw.slice(0, 300)}` } });
    }

    if (!response.ok) {
      return res.status(response.status).json({
        error: {
          message: data.error?.message || "OpenAI API error",
          type: data.error?.type || "openai_error",
        },
        openai: data,
      });
    }

    res.status(200).json({
      id: data.id,
      model: data.model || model,
      content: [{ type: "text", text: outputText(data) }],
      usage: data.usage,
      provider: "openai",
    });
  } catch (err) {
    res.status(500).json({ error: { message: err.message || String(err) } });
  }
}
