// Background-removal sandbox endpoint.
// Proxies an image to remove.bg (white-background is a single param — matches the
// "phone photo -> clean white bg -> back into the ERP" workflow). The provider can
// be swapped for Photoroom (the same engine Canva uses) by changing the fetch below.
export const config = { api: { bodyParser: { sizeLimit: "25mb" } }, maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const key = process.env.REMOVEBG_API_KEY;
  if (!key) {
    return res.status(500).json({
      error: "REMOVEBG_API_KEY not set. Add it in Vercel → Settings → Environment Variables (get a free key at remove.bg/api), then redeploy.",
    });
  }

  try {
    const { image, bg_color = "ffffff", size = "auto" } = req.body || {};
    if (!image) return res.status(400).json({ error: "image (base64 data URL) required" });

    const b64 = String(image).replace(/^data:image\/\w+;base64,/, "");

    const form = new URLSearchParams();
    form.set("image_file_b64", b64);
    form.set("size", size); // auto | preview | full
    if (bg_color && bg_color !== "transparent") {
      form.set("bg_color", bg_color.replace(/^#/, "")); // white = ffffff
    }

    const r = await fetch("https://api.remove.bg/v1.0/removebg", {
      method: "POST",
      headers: { "X-Api-Key": key, "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return res.status(r.status).json({ error: `remove.bg ${r.status}: ${txt.slice(0, 400)}` });
    }

    const buf = Buffer.from(await r.arrayBuffer());
    res.status(200).json({
      image: `data:image/png;base64,${buf.toString("base64")}`,
      creditsCharged: r.headers.get("x-credits-charged") || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
