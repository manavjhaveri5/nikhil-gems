import { requireUser } from "../lib/auth.js";
import { writeWithBest, outputText } from "../lib/captionWriter.js";
export const config = {
  api: {
    bodyParser: {
      sizeLimit: "20mb",
    },
  },
  maxDuration: 300,   // a studio shot is a minute or two on the image model
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
    // A photo on the web (a Reddit post's, say), passed by its address.
    if (part.type === "image" && part.source?.type === "url" && /^https:\/\//.test(part.source.url || "")) {
      converted.push({ type: "input_image", image_url: part.source.url });
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

// ── Folded-in endpoints (merged to stay under Vercel's 12-function limit) ──
//  /api/openai → /api/claude?_ai=openai   (OpenAI chat/completions passthrough)
//  /api/embed  → /api/claude?_ai=embed     (OpenAI embeddings)
//  /api/claude?_ai=studio                  (OpenAI image edit: the photo editor's studio shot)
// The first two are reached via rewrites in vercel.json; the route is detected below.
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

/* The photo editor's studio shot: one photo and the brief in, one square image
   out. The newest image model the key can use goes first; a key or org that
   can't use it falls through to the next. input_fidelity keeps the model close
   to the photo's own detail, and is dropped for a model that doesn't take it. */
const STUDIO_MODELS = [process.env.OPENAI_IMAGE_MODEL, "gpt-image-1.5", "gpt-image-1"].filter(Boolean);
async function handleStudioShot(req, res, key) {
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    if (!body.image || !body.prompt) return res.status(400).json({ error: { message: "image and prompt required" } });
    const bytes = Buffer.from(String(body.image), "base64");
    let last = { status: 500, message: "No image model answered." };
    for (const model of [...new Set(STUDIO_MODELS)]) {
      for (const fidelity of [true, false]) {
        const form = new FormData();
        form.append("model", model);
        form.append("image", new Blob([bytes], { type: "image/jpeg" }), "photo.jpg");
        form.append("prompt", String(body.prompt).slice(0, 30000));
        form.append("size", "1024x1024");
        form.append("quality", "high");
        form.append("background", "opaque");
        form.append("output_format", "png");
        if (fidelity) form.append("input_fidelity", "high");
        const r = await fetch("https://api.openai.com/v1/images/edits", {
          method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form,
        });
        const data = await r.json().catch(() => ({}));
        const b64 = data.data?.[0]?.b64_json;
        if (r.ok && b64) return res.status(200).json({ image: b64, mime: "image/png", model, usage: data.usage });
        last = { status: r.status, message: data.error?.message || `OpenAI image edit failed (HTTP ${r.status})` };
        if (!(fidelity && /input_fidelity/i.test(last.message))) break;
      }
      // Only a model this key can't use is worth another try; anything else would fail the same way.
      if (!/model|not found|does not exist|not supported|verif/i.test(last.message)) break;
    }
    return res.status(last.status >= 400 ? last.status : 500).json({ error: { message: last.message } });
  } catch (e) {
    return res.status(500).json({ error: { message: e.message || String(e) } });
  }
}

// Social captions: OpenAI's best writer, in the journal's voice (lib/captionWriter.js).
async function handleCaptionWriter(req, res, key) {
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const { instructions, input } = convertMessages(body.messages || []);
    if (!input.length) return res.status(400).json({ error: { message: "messages required" } });
    const out = await writeWithBest(key, { instructions, input, maxTokens: body.max_tokens || 1000 });
    return res.status(200).json({ id: out.id, model: out.model, content: [{ type: "text", text: out.text }], usage: out.usage, provider: "openai" });
  } catch (err) {
    return res.status(err.status || 500).json({ error: { message: `The caption writer couldn't write it: ${err.message || err}` } });
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  // The daily ops-check workflow (no user session) presents the store secret.
  if (!(await requireUser(req, res, { allowStoreSecret: true }))) return;

  const key = process.env.OPENAI_KEY || process.env.OPENAI_API_KEY;
  if (!key) return res.status(500).json({ error: { message: "OPENAI_KEY not set" } });

  // Social captions ask for the journal's writer by name: the best model, not the everyday one.
  let writer;
  try { writer = (typeof req.body === "string" ? JSON.parse(req.body) : req.body || {}).writer; } catch { /* handled below */ }
  if (writer === "journal") return handleCaptionWriter(req, res, key);

  const route = detectRoute(req);
  if (route === "openai") return handleOpenaiChat(req, res, key);
  if (route === "embed") return handleEmbed(req, res, key);
  if (route === "studio") return handleStudioShot(req, res, key);

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
