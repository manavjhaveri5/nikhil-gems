const SG_BASE = "https://labels.shipglobal.in/api/v1";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-shipglobal-token");
  if (req.method === "OPTIONS") return res.status(200).end();

  const action = req.method === "GET" ? req.query.action : req.body?.action;

  // ── authenticate ──────────────────────────────────────────────────────────
  if (action === "authenticate") {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: "username and password required" });

    const r = await fetch(`${SG_BASE}/authenticate.php`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data?.message || data?.error || "ShipGlobal auth failed", details: data });
    return res.json(data);
  }

  // ── create_label ──────────────────────────────────────────────────────────
  if (action === "create_label") {
    const token = req.headers["x-shipglobal-token"];
    if (!token) return res.status(401).json({ error: "x-shipglobal-token header required" });

    const { order } = req.body || {};
    if (!order) return res.status(400).json({ error: "order payload required" });

    const r = await fetch(`${SG_BASE}/addOrder.php`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify(order),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data?.message || data?.error || "ShipGlobal order failed", details: data });
    return res.json(data);
  }

  return res.status(400).json({ error: "Unknown action. Use: authenticate, create_label" });
}
