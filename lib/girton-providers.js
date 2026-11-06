/* Girton's readers for each provider's own API. Each takes nothing but its
   key from Vercel's environment and returns { ...data } or { error }; none
   ever throws, and a missing key is { missing: true }.

   RAILWAY_TOKEN          Railway account token ("No workspace")       → plan, bill, credit, usage, services
   OPENAI_ADMIN_KEY       OpenAI admin key                             → real costs, tokens by key and model
   SUPABASE_ACCESS_TOKEN  Supabase personal access token               → plan; usage via the dashboard's endpoint

   Railway's fields come from its GraphQL schema (introspected 6 Nov 2026).
   OpenAI's from the Usage and Costs API. Supabase's public API has no usage
   meters, so usage comes from the dashboard's own (undocumented) endpoint. */

const iso = ms => new Date(ms).toISOString();
const env = k => (process.env[k] || "").trim().replace(/^["']|["']$/g, "");
// What kind of key is set, never the key: "sk-admin… (52 chars)".
const shape = k => !k ? "empty" : /^[0-9a-f-]{36}$/i.test(k) ? `a UUID-style token (${k.length} chars)` : `${(k.match(/^(sk-admin-|sk-proj-|sk-svcacct-|sk-|sbp_|sb_secret_|sb_publishable_|eyJ)/) || [k.slice(0, 2)])[0]}… (${k.length} chars)`;
const r2 = x => Math.round((+x || 0) * 100) / 100;

/* ── Railway ───────────────────────────────────────────────────────────── */
// $ per unit, railway.com/pricing (6 Nov 2026). Usage values are per minute for CPU/RAM/disk.
const RW_RATE = { CPU_USAGE: 0.000463, MEMORY_USAGE_GB: 0.000231, NETWORK_TX_GB: 0.05, DISK_USAGE_GB: 0.000003472 };
const RW_LABEL = { CPU_USAGE: "CPU", MEMORY_USAGE_GB: "Memory", NETWORK_TX_GB: "Egress", DISK_USAGE_GB: "Volume" };
const RW_FEE = { FREE: 0, HOBBY: 5, PRO: 20 };

async function railwayQuery(token, query, variables, project = false) {
  const r = await fetch("https://backboard.railway.com/graphql/v2", {
    method: "POST", headers: { "Content-Type": "application/json", ...(project ? { "Project-Access-Token": token } : { Authorization: `Bearer ${token}` }) },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors?.length) throw new Error(j.errors?.[0]?.message || `HTTP ${r.status}`);
  return j.data;
}

export async function railway() {
  const token = env("RAILWAY_TOKEN");
  if (!token) return { missing: true };
  try {
    const WS = `id name plan customer { currentUsage creditBalance remainingUsageCreditBalance isTrialing state
        billingPeriod { start end } usageLimit { softLimit hardLimit isOverLimit }
        subscriptions { status nextInvoiceDate nextInvoiceCurrentTotal } }`;
    // Account tokens can ask for "me"; workspace tokens only see their workspace's projects;
    // project tokens use their own header. Try each in turn.
    let ws = [], firstErr = null;
    try { ws = (await railwayQuery(token, `query { me { workspaces { ${WS} } } }`)).me?.workspaces || []; }
    catch (e) {
      firstErr = e;
      try {
        const d = await railwayQuery(token, `query { projects(first: 20) { edges { node { workspace { ${WS} } } } } }`);
        for (const e2 of d.projects?.edges || []) { const w = e2.node.workspace; if (w && !ws.some(x => x.id === w.id)) ws.push(w); }
      } catch {
        try {
          const t = await railwayQuery(token, `query { projectToken { projectId } }`, {}, true);
          const d = await railwayQuery(token, `query ($id: String!) { project(id: $id) { workspace { ${WS} } } }`, { id: t.projectToken.projectId }, true);
          if (d.project?.workspace) ws.push(d.project.workspace);
        } catch { throw firstErr; }
      }
    }
    if (!ws.length) return { error: "The Railway token sees no workspace. Use an account token (No workspace)." };
    const out = [];
    for (const w of ws) {
      const c = w.customer || {};
      const measurements = Object.keys(RW_RATE);
      let est = [];
      try {
        const e = await railwayQuery(token, `query ($w: String!, $m: [MetricMeasurement!]!) { estimatedUsage(workspaceId: $w, measurements: $m) { measurement estimatedValue } }`, { w: w.id, m: measurements });
        est = e.estimatedUsage || [];
      } catch { /* estimates are a bonus */ }
      let used = [];
      try {
        const u = await railwayQuery(token, `query ($w: String!, $m: [MetricMeasurement!]!, $s: DateTime, $e: DateTime) { workspaceUsageTotals(workspaceId: $w, measurements: $m, startDate: $s, endDate: $e) { measurement value } }`,
          { w: w.id, m: measurements, s: c.billingPeriod?.start, e: c.billingPeriod?.end || iso(Date.now()) });
        used = u.workspaceUsageTotals || [];
      } catch { /* fall back to currentUsage */ }
      const lines = measurements.map(m => {
        const u = used.find(x => x.measurement === m)?.value || 0;
        const e = est.find(x => x.measurement === m)?.estimatedValue || 0;
        return { k: RW_LABEL[m], usd: r2(u * RW_RATE[m]), est_usd: r2(e * RW_RATE[m]) };
      });
      let services = [];
      try {
        const p = await railwayQuery(token, `query ($w: String!) { projects(workspaceId: $w, first: 20) { edges { node { id name services { edges { node { id name
          serviceInstances { edges { node { latestDeployment { status createdAt } } } } } } } } } } }`, { w: w.id });
        for (const pe of p.projects?.edges || []) for (const se of pe.node.services?.edges || []) {
          const dep = se.node.serviceInstances?.edges?.[0]?.node?.latestDeployment;
          services.push({ project: pe.node.name, service: se.node.name, status: dep?.status || "?", at: dep?.createdAt || null });
        }
      } catch { /* services are a bonus */ }
      const sub = (c.subscriptions || [])[0] || {};
      const fee = RW_FEE[w.plan] ?? 0;
      const usage = r2(c.currentUsage ?? lines.reduce((s, l) => s + l.usd, 0));
      const estimate = r2(lines.reduce((s, l) => s + l.est_usd, 0)) || null;
      out.push({
        workspace: w.name, plan: w.plan, fee, usage_usd: usage, estimate_usd: estimate,
        // Railway's plan fee includes the same amount of usage, so the bill is the larger of the two.
        bill_usd: r2(Math.max(fee, estimate ?? usage)),
        credit_usd: c.creditBalance ?? null, remaining_credit_usd: c.remainingUsageCreditBalance ?? null,
        period: c.billingPeriod ? [c.billingPeriod.start?.slice(0, 10), c.billingPeriod.end?.slice(0, 10)] : null,
        limit: c.usageLimit ? { soft: c.usageLimit.softLimit, hard: c.usageLimit.hardLimit, over: c.usageLimit.isOverLimit } : null,
        next_invoice: sub.nextInvoiceDate ? { date: String(sub.nextInvoiceDate).slice(0, 10), cents: sub.nextInvoiceCurrentTotal } : null,
        trialing: !!c.isTrialing, state: c.state || null, lines, services,
      });
    }
    return { workspaces: out, at: Date.now() };
  } catch (e) {
    return { error: /not authorized|unauthor|invalid token/i.test(e.message) ? `Railway refused the token ("${e.message}"; key set is ${shape(token)}). It must be an account token made with workspace "No workspace".` : `Railway: ${e.message}` };
  }
}

/* ── OpenAI (admin key) ────────────────────────────────────────────────── */
async function oa(key, path, params) {
  const out = [];
  let page;
  for (let i = 0; i < 6; i++) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) for (const x of [].concat(v)) qs.append(k, String(x));
    if (page) qs.set("page", page);
    const r = await fetch(`https://api.openai.com/v1${path}?${qs}`, { headers: { Authorization: `Bearer ${key}` } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error?.message || `HTTP ${r.status}`), { status: r.status });
    out.push(...(j.data || []));
    if (!j.has_more || !j.next_page) break;
    page = j.next_page;
  }
  return out;
}

export async function openai(now = Date.now()) {
  const key = env("OPENAI_ADMIN_KEY");
  if (!key) return { missing: true };
  const d = new Date(now);
  const monthStart = Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000);
  try {
    // Real cost per day and line item this month.
    const costs = await oa(key, "/organization/costs", { start_time: monthStart, bucket_width: "1d", limit: 31, group_by: ["line_item"] });
    const days = [], items = {};
    let mtd = 0;
    for (const b of costs) {
      let day = 0;
      for (const x of b.results || []) {
        const v = +x.amount?.value || 0;
        day += v; mtd += v;
        const k = x.line_item || "other";
        items[k] = (items[k] || 0) + v;
      }
      days.push({ day: iso(b.start_time * 1000).slice(0, 10), usd: Math.round(day * 1e4) / 1e4 });
    }
    // Tokens by key and model this month.
    let byKey = {}, byModel = {};
    try {
      const use = await oa(key, "/organization/usage/completions", { start_time: monthStart, bucket_width: "1d", limit: 31, group_by: ["api_key_id", "model"] });
      for (const b of use) for (const x of b.results || []) {
        const add = (o, k) => { const t = o[k || "?"] ||= { calls: 0, in: 0, out: 0, cached: 0 }; t.calls += x.num_model_requests || 0; t.in += x.input_tokens || 0; t.out += x.output_tokens || 0; t.cached += x.input_cached_tokens || 0; };
        add(byKey, x.api_key_id); add(byModel, x.model);
      }
    } catch { /* tokens are a bonus */ }
    // Key names, so "key_abc" reads as "railway-bot".
    const names = {};
    try {
      for (const p of await oa(key, "/organization/projects", { limit: 100 })) {
        for (const k of await oa(key, `/organization/projects/${p.id}/api_keys`, { limit: 100 })) names[k.id] = k.name || k.redacted_value || k.id;
      }
    } catch { /* names are a bonus */ }
    const keys = Object.entries(byKey).map(([id, t]) => ({ id, name: names[id] || id, ...t })).sort((a, b) => b.in + b.out - (a.in + a.out));
    const models = Object.entries(byModel).map(([model, t]) => ({ model, ...t })).sort((a, b) => b.in + b.out - (a.in + a.out));
    return { mtd_usd: Math.round(mtd * 1e4) / 1e4, days, line_items: Object.entries(items).map(([k, v]) => ({ k, usd: Math.round(v * 1e4) / 1e4 })).sort((a, b) => b.usd - a.usd), keys, models, at: Date.now() };
  } catch (e) {
    return { error: e.status === 401 || e.status === 403 ? `OpenAI refused the key (HTTP ${e.status}: "${String(e.message).replace(/sk-[\w-]+/g, "sk-…").slice(0, 160)}"; key set is ${shape(key)}). It must be an Admin key, which starts sk-admin.` : `OpenAI: ${e.message}` };
  }
}

/* ── Supabase ──────────────────────────────────────────────────────────── */
const SB_METRICS = {
  STORAGE_IMAGES_TRANSFORMED: ["Image transformations", "images"], EGRESS: ["Egress", "GB"], CACHED_EGRESS: ["Cached egress", "GB"],
  STORAGE_SIZE: ["File storage", "GB"], LOG_INGESTION: ["Log ingestion", "GB"], REALTIME_MESSAGE_COUNT: ["Realtime messages", ""],
  REALTIME_PEAK_CONNECTIONS: ["Realtime peak connections", ""], MONTHLY_ACTIVE_USERS: ["Monthly active users", ""],
  FUNCTION_INVOCATIONS: ["Edge function invocations", ""],
};

async function sbLogs(H, ref, sql, startMs, endMs) {
  const qs = new URLSearchParams({ sql, iso_timestamp_start: iso(startMs), iso_timestamp_end: iso(endMs) });
  const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/analytics/endpoints/logs?${qs}`, { headers: H });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(typeof j.error === "string" ? j.error : j.error?.message || j.message || `HTTP ${r.status}`);
  return j.result || [];
}

export async function supabase(now = Date.now(), cycleDay = 12) {
  const token = env("SUPABASE_ACCESS_TOKEN");
  if (!token) return { missing: true };
  const slug = env("SUPABASE_ORG_SLUG") || "endxiptyqmxpnvkosjxv";
  const ref = env("SUPABASE_PROJECT_REF") || "bxnqnbspibvbnxbojrhe";
  const H = { Authorization: `Bearer ${token}`, "User-Agent": "girton/1.0" };
  // The plan, from the public API. A 401 means the token itself is wrong; a 403 is
  // only this endpoint saying no, so carry on to the logs.
  let plan = null, orgNote = "";
  const o = await fetch(`https://api.supabase.com/v1/organizations/${slug}`, { headers: H }).catch(() => null);
  if (o?.status === 401) return { error: `Supabase refused the token (HTTP 401; key set is ${shape(token)}). Use a personal access token, which starts sbp_.` };
  if (o?.ok) plan = (await o.json().catch(() => ({}))).plan || null;
  else if (o) orgNote = `organisation details: HTTP ${o.status} ${(await o.text().catch(() => "")).slice(0, 120)}`;
  const d = new Date(now);
  let start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), cycleDay));
  if (start.getTime() > now) start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, cycleDay));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, cycleDay));
  const cycle = [iso(start).slice(0, 10), iso(end).slice(0, 10)];
  // Full plan usage: only the dashboard's endpoint has it, and it may refuse personal tokens.
  const r = await fetch(`https://api.supabase.com/platform/organizations/${slug}/usage?start=${iso(start)}&end=${iso(end)}`, { headers: H }).catch(() => null);
  if (r?.ok) {
    const text = await r.text();
    let j; try { j = JSON.parse(text); } catch { j = null; }
    const list = Array.isArray(j) ? j : j?.usages || j?.usage || [];
    const items = [];
    for (const u of Array.isArray(list) ? list : []) {
      const meta = SB_METRICS[u.metric];
      if (!meta) continue;
      const gb = meta[1] === "GB";
      const used = +(u.usage ?? u.usage_original ?? 0), free = +(u.pricing_free_units ?? u.free_units ?? 0);
      items.push({ k: meta[0], used: gb ? r2(used / 1e9) : used, limit: gb ? Math.round(free / 1e9) : free, unit: meta[1], unlimited: !!u.unlimited, cost: u.cost ?? null });
    }
    if (items.length) {
      const order = Object.values(SB_METRICS).map(m => m[0]);
      items.sort((a, b) => order.indexOf(a.k) - order.indexOf(b.k));
      return { plan, cycle, items, at: Date.now() };
    }
  }
  // Fallback the token can read: the project's request logs for the last 24 hours.
  try {
    // ClickHouse SQL over the unified logs table (Supabase moved logs there in Sept 2026).
    const rows = await sbLogs(H, ref, `select count() as total, countIf(log_attributes['request.path'] like '%/storage/v1/render/image%') as transforms, countIf(log_attributes['request.path'] like '%/storage/v1/object%') as files, sum(toUInt64OrZero(log_attributes['response.headers.content_length'])) as bytes from logs where source_name = 'edge_logs'`, now - 864e5, now);
    const x = rows[0] || {};
    return { plan, cycle, partial: true, note: orgNote || undefined, day: { requests: +x.total || 0, transforms: +x.transforms || 0, file_requests: +x.files || 0, egress_gb: Math.round((+x.bytes || 0) / 1e7) / 100 }, at: Date.now() };
  } catch (e) {
    // Show which columns the logs table has, so the query can be fixed in one go.
    let cols = "";
    try { const one = await sbLogs(H, ref, "select * from logs limit 1", now - 3600e3, now); cols = one[0] ? ` Columns: ${Object.entries(one[0]).map(([k, v]) => `${k}${v && typeof v === "object" ? `{${Object.keys(v).slice(0, 40).join(",")}}` : ""}`).join(", ").slice(0, 1500)}.` : " (no rows in the last hour)"; } catch (e2) { cols = ` Column probe failed: ${e2.message}`; }
    return { plan, cycle, error: `Supabase: the log query failed (${e.message})${cols}${orgNote ? `; ${orgNote}` : ""}. Key set is ${shape(token)}.` };
  }
}
