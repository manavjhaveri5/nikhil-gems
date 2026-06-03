const manifest = {
  name: "Nikhil Gems",
  short_name: "Nikhil Gems",
  description: "Nikhil Gems Business Suite",
  start_url: "/",
  display: "standalone",
  background_color: "#FAF7F2",
  theme_color: "#9A6200",
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
  ],
};

export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/manifest+json; charset=utf-8");
  res.status(200).json(manifest);
}
