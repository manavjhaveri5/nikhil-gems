// ─── Resilient client for the AI/embedding endpoints ──────────────────────────
// The /api/claude and /api/embed endpoints have no retry/timeout of their own, so
// the learner routes all its calls through here: an AbortController timeout plus
// exponential backoff with jitter on network errors, 429s and 5xx. Other 4xx are
// not retried (they won't get better). Everything throws on final failure so the
// learner can fall back gracefully.

const sleep = ms => new Promise(r => setTimeout(r, ms));

export const fetchWithRetry = async (url, opts = {}, { tries = 3, baseMs = 400, timeoutMs = 15000 } = {}) => {
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok) return res;
      // Retry only on rate-limit / server errors; give up on other 4xx.
      if (res.status !== 429 && res.status < 500) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error?.message || body.error || `HTTP ${res.status}`);
      }
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      // A non-retryable HTTP error thrown above shouldn't be retried.
      if (e?.message && /^HTTP 4\d\d/.test(e.message) && !/HTTP 429/.test(e.message)) throw e;
    }
    if (attempt < tries - 1) await sleep(baseMs * 2 ** attempt + Math.random() * baseMs);
  }
  throw lastErr || new Error("request failed");
};

// Embed one or many strings → returns number[][] (one vector per input, order kept).
export const embedBatch = async inputs => {
  const arr = (Array.isArray(inputs) ? inputs : [inputs]).map(s => String(s || "").slice(0, 2000));
  if (!arr.length) return [];
  const res = await fetchWithRetry("/api/embed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: arr }),
  });
  const data = await res.json();
  return Array.isArray(data.embeddings) ? data.embeddings : [];
};

export const embedText = async text => (await embedBatch([text]))[0] || null;

// Call the classification model (/api/claude proxies OpenAI server-side). Returns the
// raw text reply, or "" on failure-after-retries handled by the caller's try/catch.
export const classify = async (prompt, maxTokens = 400) => {
  const res = await fetchWithRetry("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-opus-4-5", max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error?.message || data.error || "classify failed");
  return data.content?.find(b => b.type === "text")?.text || "";
};
