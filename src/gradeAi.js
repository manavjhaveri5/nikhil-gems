import { fetchWithRetry } from "./aiClient.js";
import { emptyCurves, CHANNELS } from "./ToneCurve.jsx";
import { ADJUSTMENTS, NEUTRAL, MAX_BANDS } from "./glPipeline.js";

/* The retoucher's brief, and the one call that sends it.

   The model reads the picture and writes the recipe; the GPU moves the pixels.
   That split is deliberate: these are wholesale goods, and a generative
   re-render would repaint the stone's own pattern — the buyer would be looking
   at a picture of a piece that doesn't exist. So the AI's job is to say what to
   change and by how much ("the inclusions sit at hue 268–292, push those"), and
   every number it picks lands on a slider the eye can overrule.

   A frame of the listing's video is the same stone under the same light as its
   photos, so the video editor asks the same question of the same prompt. */

const SYSTEM = `You are a retoucher for wholesale gemstone and mineral product photography.

You are given one product photo and what the seller wants changed. Reply with ONLY a JSON object — no prose, no code fence:

{
  "summary": "one short sentence on what you changed and why",
  "adjust": { "exposure": 0, "contrast": 0, "highlights": 0, "shadows": 0, "temperature": 0, "tint": 0, "vibrance": 0, "saturation": 0, "clarity": 0 },
  "bands": [ { "name": "purple inclusions", "center": 275, "width": 34, "sat": 22, "lum": -4, "hue": 0 } ],
  "curve": { "rgb": [[0,0],[64,58],[192,200],[255,255]] }
}

Every value in "adjust" is -100..100, 0 = untouched. Omit a key to leave it at 0.
"bands" targets specific colours already in the photo: "center" and "width" are degrees on the hue wheel (red 0, yellow 55, green 120, cyan 185, blue 240, purple 280, magenta 320), "sat"/"lum" are -100..100, "hue" is a shift in degrees, -30..30. At most 4 bands. Read the actual hues off THIS photo — measure them, do not use the nominal value for the colour's name. Name each band after what it is in the picture.

"curve" is optional and usually unnecessary — reach for it only when the sliders cannot say it: a filmic S for a flat scene, a lifted black point for a washed-out shot, or a per-channel fix for a colour cast ("r", "g", "b" keys, same shape). Points are [in, out] on 0..255, x ascending, first x 0 and last x 255, at most 6 points, never decreasing.

Rules:
- The buyer receives this exact stone. Correct the photograph, never invent the goods: no colour that isn't in the frame, no saturation that turns a dull piece into a bright one.
- Hand shots are the norm here. Skin sits around hue 15-35 at low saturation — keep bands off it, and say so in the summary if the seller's request would have hit it.
- Prefer a few decisive numbers over many timid ones. Most photos need less than ±30.
- If the photo is already right, return zeros and say so.`;

/* Reading the picture, not editing it. The model's other job is to answer "what
   colours are actually in here" — named in the photo's own terms and measured
   off the pixels — so the ranges to push are the ones this stone has, rather
   than the eight a colour wheel happens to be divided into. */
const SYSTEM_FIND = `You are a retoucher looking at one product photo of a gemstone, mineral or carving.

List the distinct colour ranges actually present in the stone. Reply with ONLY JSON:

{ "summary": "one short sentence naming what you found",
  "bands": [ { "name": "rust vein", "center": 28, "width": 26, "sat": 0, "lum": 0, "hue": 0 } ] }

- 2 to 4 ranges, ordered by how much of the stone they cover.
- "center" and "width" are degrees on the hue wheel, measured off THIS photo — sample the pixels, do not use the nominal hue for the colour's name.
- Width is the spread that colour actually occupies, not a default.
- Name each range the way the seller would say it out loud: "rust vein", "olive body", "blue-grey shell".
- The background and the hand holding the piece are not colours of the stone. Skin sits near hue 15-35 at low saturation — never return a range that would catch it, and say so in the summary if the stone's own colour sits there too.
- Always return "sat": 0, "lum": 0, "hue": 0. You are identifying the ranges, not adjusting them.`;


/* The model gets a small copy — a 768px long edge is plenty to judge exposure
   and read hues off, and keeps the request quick and cheap. Takes anything a
   canvas will draw: the loaded still, or the video's current frame. */
function downscaleToB64(source, max = 768) {
  const sw = source.width || source.videoWidth || source.displayWidth;
  const sh = source.height || source.videoHeight || source.displayHeight;
  const scale = Math.min(1, max / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  cv.getContext("2d").drawImage(source, 0, 0, w, h);
  return cv.toDataURL("image/jpeg", 0.85).split(",")[1] || "";
}

function parseRecipe(text) {
  const raw = String(text || "").replace(/```json|```/gi, "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The model didn't return a recipe.");
  const parsed = JSON.parse(raw.slice(start, end + 1));
  const adjust = { ...NEUTRAL };
  for (const a of ADJUSTMENTS) {
    const v = +parsed?.adjust?.[a.key];
    if (Number.isFinite(v)) adjust[a.key] = Math.max(-100, Math.min(100, Math.round(v)));
  }
  const bands = (Array.isArray(parsed?.bands) ? parsed.bands : []).slice(0, MAX_BANDS).map(b => ({
    name: String(b?.name || "colour").slice(0, 28),
    center: ((+b?.center || 0) % 360 + 360) % 360,
    width: Math.max(8, Math.min(180, +b?.width || 40)),
    sat: Math.max(-100, Math.min(100, +b?.sat || 0)),
    lum: Math.max(-100, Math.min(100, +b?.lum || 0)),
    hue: Math.max(-30, Math.min(30, +b?.hue || 0)),
  }));
  const curves = emptyCurves();
  for (const ch of CHANNELS) {
    const raw = parsed?.curve?.[ch.key];
    if (!Array.isArray(raw) || raw.length < 2) continue;
    const pts = raw
      .map(p => [Math.max(0, Math.min(1, (+p?.[0] || 0) / 255)), Math.max(0, Math.min(1, (+p?.[1] || 0) / 255))])
      .sort((a, b) => a[0] - b[0])
      .slice(0, 6);
    // The ends are structural, not the model's to move off the corners.
    pts[0] = [0, pts[0][1]];
    pts[pts.length - 1] = [1, pts[pts.length - 1][1]];
    curves[ch.key] = pts;
  }
  return { summary: String(parsed?.summary || "").slice(0, 240), adjust, bands, curves };
}
/* Reads whatever can be drawn to a canvas — a still, or one frame paused out of
   the clip. `mode: "find"` asks for an inventory of the colours present instead
   of an edit, and the ranges come back at zero for the seller to push. */
export async function askGrade({ source, instruction, mode = "edit" }) {
  const data = downscaleToB64(source);
  const res = await fetchWithRetry("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      max_tokens: 800,
      temperature: 0,
      messages: [
        { role: "system", content: mode === "find" ? SYSTEM_FIND : SYSTEM },
        { role: "user", content: [
          { type: "text", text: instruction },
          { type: "image", source: { media_type: "image/jpeg", data } },
        ] },
      ],
    }),
  }, { tries: 2, timeoutMs: 60000 });
  const body = await res.json();
  if (body.error) throw new Error(body.error?.message || "The model refused the request.");
  const recipe = parseRecipe(body.content?.[0]?.text || "");
  return mode === "find"
    ? { ...recipe, bands: recipe.bands.map(b => ({ ...b, sat: 0, lum: 0, hue: 0 })) }
    : recipe;
}
