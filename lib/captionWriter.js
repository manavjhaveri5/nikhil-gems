/* The writer behind the social captions: OpenAI's newest model this key can
   use, on the Responses API, writing in the journal's voice
   (lib/instagramVoice.js). A model the key can't use falls through to the
   next; OPENAI_WRITER_MODEL, when set in Vercel, goes first. Server only:
   api/claude.js (Captions, Compose) and api/social.js (Autopilot). */

export const WRITER_MODELS = [process.env.OPENAI_WRITER_MODEL, "gpt-5.5", "gpt-5.2", "gpt-5", "gpt-4.1"].filter(Boolean);

export function outputText(data) {
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

// `input` is a string or Responses API input items. Resolves { text, model, usage, id }; throws with .status.
export async function writeWithBest(key, { instructions, input, maxTokens = 1000 }) {
  let last = { status: 502, message: "No OpenAI model answered." };
  for (const model of [...new Set(WRITER_MODELS)]) {
    for (const think of [true, false]) {
      const r = await fetch("https://api.openai.com/v1/responses", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, input, ...(instructions ? { instructions } : {}),
          // A reasoning model thinks before it writes, out of the same budget, so it gets room for that on top.
          ...(think ? { reasoning: { effort: "medium" }, max_output_tokens: maxTokens + 8000 } : { max_output_tokens: maxTokens, temperature: 0.8 }) }),
      }).catch(e => ({ ok: false, status: 502, json: async () => ({ error: { message: e.message } }) }));
      const d = await r.json().catch(() => ({}));
      const text = r.ok ? outputText(d).trim() : "";
      if (text) return { text, model: d.model || model, usage: d.usage, id: d.id };
      last = { status: r.ok ? 502 : r.status, message: d.error?.message || (r.ok ? `${model} wrote nothing (${d.incomplete_details?.reason || d.status || "empty reply"})` : `OpenAI: HTTP ${r.status}`) };
      // An older model that doesn't think is asked again plainly.
      if (!(think && /reasoning/i.test(last.message))) break;
    }
    // Only a model this key can't use is worth another try; anything else would fail the same way.
    if (!/model|not found|does not exist|not supported|verif/i.test(last.message)) break;
  }
  throw Object.assign(new Error(last.message), { status: last.status >= 400 ? last.status : 502 });
}
