import { supabase } from "./supabase.js";

const BUCKET = "ng-media";
let bucketReadyPromise = null;

async function ensureBucket() {
  if (!bucketReadyPromise) {
    bucketReadyPromise = supabase.storage.createBucket(BUCKET, { public: true }).catch(() => {});
  }
  return bucketReadyPromise;
}

// Marketplaces (Shopify caps at 20 megapixels) reject oversized photos, and full-res
// phone shots bloat storage. Downscale so the longest edge is <= 4096px — that keeps every
// image under ~16.7 MP while staying sharp. Non-images and already-small files pass through
// untouched; if decoding fails (e.g. HEIC on an unsupported browser) we keep the original.
const MAX_EDGE = 4096;
export async function downscaleImageFile(file) {
  if (!file || typeof file.type !== "string" || !file.type.startsWith("image/")) return file;
  if (file.type === "image/gif") return file; // don't flatten animation
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return file;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return file; // undecodable here — let the server/marketplace deal with it
  }
  const { width, height } = bitmap;
  if (!width || !height || Math.max(width, height) <= MAX_EDGE) { bitmap.close?.(); return file; }
  const scale = MAX_EDGE / Math.max(width, height);
  const w = Math.round(width * scale), h = Math.round(height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  // Keep PNG for transparency, otherwise JPEG for size.
  const outType = file.type === "image/png" ? "image/png" : "image/jpeg";
  const blob = await new Promise(res => canvas.toBlob(res, outType, 0.92));
  if (!blob) return file;
  const baseName = (file.name || "image").replace(/\.[^.]+$/, "");
  const outExt = outType === "image/png" ? "png" : "jpg";
  return new File([blob], `${baseName}.${outExt}`, { type: outType });
}

export async function uploadToStorage(path, file) {
  await ensureBucket();
  const resized = await downscaleImageFile(file);
  const { error } = await supabase.storage.from(BUCKET).upload(path, resized, {
    upsert: true,
    contentType: resized.type || "application/octet-stream",
  });
  if (error) throw new Error(error.message);
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}
