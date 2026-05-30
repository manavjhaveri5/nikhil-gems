const BASE_URL = "https://labels.shipglobal.in/api/v1";

async function readJson(response) {
  const text = await response.text();
  try { return { data: JSON.parse(text), text }; }
  catch { return { data: { raw: text }, text }; }
}

async function shipglobalLogin(email, password) {
  const response = await fetch(`${BASE_URL}/customers.php`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const { data } = await readJson(response);
  if (!response.ok) {
    const message = data?.error || data?.message || data?.raw || "ShipGlobal login failed";
    const err = new Error(message);
    err.status = response.status;
    err.details = data;
    throw err;
  }
  if (!data?.token) {
    const err = new Error("ShipGlobal login did not return a token");
    err.status = 502;
    err.details = data;
    throw err;
  }
  return data;
}

function defaultedOrder(payload) {
  const env = process.env;
  const defaults = {
    service: env.SHIPGLOBAL_SERVICE || "DHLECS-CLASSIC",
    package_weight: +(env.SHIPGLOBAL_PACKAGE_WEIGHT || 0),
    package_length: +(env.SHIPGLOBAL_PACKAGE_LENGTH || 0),
    package_breadth: +(env.SHIPGLOBAL_PACKAGE_BREADTH || 0),
    package_height: +(env.SHIPGLOBAL_PACKAGE_HEIGHT || 0),
    csb5_status: +(env.SHIPGLOBAL_CSB5_STATUS || 1),
    seller_nickname: env.SHIPGLOBAL_SELLER_NICKNAME || "",
    seller_firstname: env.SHIPGLOBAL_SELLER_FIRSTNAME || "",
    seller_lastname: env.SHIPGLOBAL_SELLER_LASTNAME || "",
    seller_mobile: env.SHIPGLOBAL_SELLER_MOBILE || "",
    seller_email: env.SHIPGLOBAL_SELLER_EMAIL || "",
    seller_company: env.SHIPGLOBAL_SELLER_COMPANY || "",
    seller_address: env.SHIPGLOBAL_SELLER_ADDRESS || "",
    seller_address_2: env.SHIPGLOBAL_SELLER_ADDRESS_2 || "",
    seller_address_3: env.SHIPGLOBAL_SELLER_ADDRESS_3 || "",
    seller_city: env.SHIPGLOBAL_SELLER_CITY || "",
    seller_postcode: env.SHIPGLOBAL_SELLER_POSTCODE || "",
    seller_country_code: env.SHIPGLOBAL_SELLER_COUNTRY_CODE || "IN",
    seller_state: env.SHIPGLOBAL_SELLER_STATE || "",
    seller_tax_id_type: env.SHIPGLOBAL_SELLER_TAX_ID_TYPE || "",
    seller_tax_id: env.SHIPGLOBAL_SELLER_TAX_ID || "",
  };
  const merged = { ...defaults, ...payload };
  ["package_weight", "package_length", "package_breadth", "package_height"].forEach(k => {
    if (!merged[k]) merged[k] = defaults[k];
  });
  Object.keys(defaults).forEach(k => {
    if (String(k).startsWith("seller_") && !merged[k]) merged[k] = defaults[k];
  });
  return merged;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { action = "create_label", download = "false" } = req.query;
  const body = req.body || {};

  try {
    if (action === "status") {
      return res.json({
        configured: !!(process.env.SHIPGLOBAL_EMAIL && process.env.SHIPGLOBAL_PASSWORD),
        hasPackageDefaults: !!(process.env.SHIPGLOBAL_PACKAGE_WEIGHT && process.env.SHIPGLOBAL_PACKAGE_LENGTH && process.env.SHIPGLOBAL_PACKAGE_BREADTH && process.env.SHIPGLOBAL_PACKAGE_HEIGHT),
        hasSellerDefaults: !!(process.env.SHIPGLOBAL_SELLER_FIRSTNAME && process.env.SHIPGLOBAL_SELLER_LASTNAME && process.env.SHIPGLOBAL_SELLER_MOBILE && process.env.SHIPGLOBAL_SELLER_EMAIL && process.env.SHIPGLOBAL_SELLER_ADDRESS && process.env.SHIPGLOBAL_SELLER_CITY && process.env.SHIPGLOBAL_SELLER_POSTCODE && process.env.SHIPGLOBAL_SELLER_STATE),
      });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "POST required" });

    if (action === "login") {
      const email = body.email || process.env.SHIPGLOBAL_EMAIL;
      const password = body.password || process.env.SHIPGLOBAL_PASSWORD;
      if (!email || !password) {
        return res.status(400).json({ error: "Set SHIPGLOBAL_EMAIL and SHIPGLOBAL_PASSWORD, or pass email/password in the request body." });
      }
      const session = await shipglobalLogin(email, password);
      return res.json({
        token: session.token,
        expires_at: session.expires_at,
        customer: session.customer,
      });
    }

    if (action !== "create_label") {
      return res.status(400).json({ error: "Unsupported ShipGlobal action" });
    }

    const authHeader = req.headers.authorization || "";
    let token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : body.token || process.env.SHIPGLOBAL_TOKEN;
    if (!token) {
      const email = process.env.SHIPGLOBAL_EMAIL;
      const password = process.env.SHIPGLOBAL_PASSWORD;
      if (!email || !password) {
        return res.status(400).json({ error: "ShipGlobal credentials missing. Add SHIPGLOBAL_EMAIL and SHIPGLOBAL_PASSWORD to Vercel env vars." });
      }
      const session = await shipglobalLogin(email, password);
      token = session.token;
    }

    const payload = body.order || body.payload || body;
    const { token: _token, email: _email, password: _password, order: _order, payload: _payload, ...directPayload } = payload;
    const requestPayload = defaultedOrder(body.order || body.payload ? payload : directPayload);
    const suffix = String(download) === "true" ? "?download=true" : "";
    const response = await fetch(`${BASE_URL}/addOrder.php${suffix}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestPayload),
    });
    const { data } = await readJson(response);
    if (!response.ok) return res.status(response.status).json(data);
    return res.json(data);
  } catch (e) {
    return res.status(e.status || 500).json({
      error: e.message || "ShipGlobal request failed",
      details: e.details,
    });
  }
}
