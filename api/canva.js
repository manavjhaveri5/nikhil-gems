/**
 * Canva Connect actions for the Background Remover sandbox.
 *
 *   POST { action: "create", image, name, width, height }
 *        → uploads the photo to Canva, creates a design from it,
 *          returns { design_id, edit_url } so the user can open it,
 *          remove the background (one click), and save.
 *
 *   POST { action: "export", design_id }
 *        → exports the (now background-removed) design as PNG and
 *          returns { image } as a data URL to save back into the ERP.
 *
 * Background removal itself stays a manual click inside Canva — the
 * Connect API does not expose it. This just removes the file shuffle.
 */
import { getCanvaAccessToken } from "./canva-auth.js";

export const config = { api: { bodyParser: { sizeLimit: "25mb" } }, maxDuration: 120 };

const BASE = "https://api.canva.com/rest/v1";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clampDim = n => Math.max(40, Math.min(8000, Math.round(n || 1000)));

const authed = (token, path, opts = {}) =>
  fetch(`${BASE}${path}`, { ...opts, headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });

// Poll a Canva job endpoint until it leaves "in_progress". Returns the job object.
// Budget (~95s) stays under the function maxDuration (120s) with margin.
async function pollJob(token, path, { tries = 63, delay = 1500 } = {}) {
  let last = "in_progress";
  for (let i = 0; i < tries; i++) {
    const r = await authed(token, path);
    const data = await r.json();
    const job = data.job || data;
    const status = job?.status;
    if (status) last = status;
    if (status && status !== "in_progress") return job;
    await sleep(delay);
  }
  throw new Error(`Canva job timed out (last status: ${last})`);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const token = await getCanvaAccessToken();
  if (!token) return res.status(401).json({ error: "Canva not connected. Connect Canva first.", needsAuth: true });

  const { action } = req.body || {};

  try {
    if (action === "create") {
      const { image, name = "ERP photo", width, height } = req.body || {};
      if (!image) return res.status(400).json({ error: "image (base64 data URL) required" });
      const buf = Buffer.from(String(image).replace(/^data:image\/\w+;base64,/, ""), "base64");

      // 1) Upload the photo as a Canva asset (async job).
      const up = await fetch(`${BASE}/asset-uploads`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
          "Asset-Upload-Metadata": JSON.stringify({ name_base64: Buffer.from(name).toString("base64") }),
        },
        body: buf,
      });
      const upStart = await up.json();
      if (!up.ok) return res.status(up.status).json({ error: `asset upload: ${JSON.stringify(upStart)}` });

      const upJob = upStart.job?.status === "in_progress"
        ? await pollJob(token, `/asset-uploads/${upStart.job.id}`)
        : upStart.job;
      const assetId = upJob?.asset?.id;
      if (!assetId) return res.status(502).json({ error: `no asset id from Canva: ${JSON.stringify(upJob)}` });

      // 2) Create a design that contains the photo, sized to the image.
      const dz = await authed(token, "/designs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          design_type: { type: "custom", width: clampDim(width), height: clampDim(height) },
          asset_id: assetId,
          title: name,
        }),
      });
      const dzData = await dz.json();
      if (!dz.ok) return res.status(dz.status).json({ error: `create design: ${JSON.stringify(dzData)}` });

      const design = dzData.design || dzData;
      return res.status(200).json({
        design_id: design.id,
        edit_url: design.urls?.edit_url || design.urls?.view_url || null,
      });
    }

    if (action === "export") {
      const { design_id } = req.body || {};
      if (!design_id) return res.status(400).json({ error: "design_id required" });

      // 3) Export the (background-removed) design as PNG.
      const ex = await authed(token, "/exports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ design_id, format: { type: "png" } }),
      });
      const exStart = await ex.json();
      if (!ex.ok) return res.status(ex.status).json({ error: `export: ${JSON.stringify(exStart)}` });

      const exJob = exStart.job?.status === "in_progress"
        ? await pollJob(token, `/exports/${exStart.job.id}`)
        : exStart.job;
      if (exJob?.status === "failed") return res.status(502).json({ error: `export failed: ${JSON.stringify(exJob.error || exJob)}` });

      const url = exJob?.urls?.[0];
      if (!url) return res.status(502).json({ error: `no export url: ${JSON.stringify(exJob)}` });

      // Canva export URLs are short-lived — download now and hand back a data URL
      // so the client can save it into ERP storage.
      const img = await fetch(url);
      const out = Buffer.from(await img.arrayBuffer());
      return res.status(200).json({ image: `data:image/png;base64,${out.toString("base64")}` });
    }

    return res.status(400).json({ error: "unknown action (use 'create' or 'export')" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
