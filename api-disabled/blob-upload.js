// Uploads now go directly to Supabase Storage via src/storageUtils.js (client-side).
// This endpoint is no longer used.
export default function handler(_req, res) {
  res.status(410).json({ error: "Endpoint removed. Uploads go directly to Supabase Storage." });
}
