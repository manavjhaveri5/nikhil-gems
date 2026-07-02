/**
 * Returns the current deployment identifier.
 * Vercel injects VERCEL_GIT_COMMIT_SHA and VERCEL_DEPLOYMENT_ID automatically.
 * The app polls this every 5 min to detect when a new deploy has gone live.
 */
export default function handler(req, res) {
  // Allow all origins so the app can poll even from a PWA context
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");

  const sha     = process.env.VERCEL_GIT_COMMIT_SHA   || null;
  const depId   = process.env.VERCEL_DEPLOYMENT_ID    || null;

  // Use commit SHA as the version key, fall back to deployment ID.
  // In local dev both will be null — return "dev" so the poller stays quiet.
  const version = sha || depId || "dev";

  res.status(200).json({ version });
}
