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

/* Big uploads (video takes) report how far along they are. supabase-js has no
   progress events, so this posts to the same Storage endpoint over XHR. */
async function uploadWithProgress(path, file, onProgress, signal) {
  const { data: { session } } = await supabase.auth.getSession();
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
  const url = `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/${BUCKET}/${path.split("/").map(encodeURIComponent).join("/")}`;
  await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("Authorization", `Bearer ${session?.access_token || key}`);
    xhr.setRequestHeader("apikey", key);
    xhr.setRequestHeader("x-upsert", "true");
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let msg = `Upload failed (${xhr.status})`;
      try { msg = JSON.parse(xhr.responseText).message || msg; } catch {}
      reject(new Error(msg));
    };
    xhr.onerror = () => reject(new Error("Upload failed — check the connection and try again."));
    xhr.onabort = () => reject(new Error("Upload stopped."));
    if (signal) {
      if (signal.aborted) return xhr.abort();
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }
    xhr.send(file);
  });
  onProgress(1);
}

export async function uploadToStorage(path, file, { onProgress, signal } = {}) {
  await ensureBucket();
  if (onProgress) {
    await uploadWithProgress(path, file, onProgress, signal);
    return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
  }
  const resized = await downscaleImageFile(file);
  const { error } = await supabase.storage.from(BUCKET).upload(path, resized, {
    upsert: true,
    contentType: resized.type || "application/octet-stream",
  });
  if (error) throw new Error(error.message);
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

// Public URLs look like <project>/storage/v1/object/public/<bucket>/<path>.
// Returns the in-bucket path, or "" for anything that isn't one of our URLs.
export function storagePathFromUrl(url) {
  const marker = `/storage/v1/object/public/${BUCKET}/`;
  const i = String(url || "").indexOf(marker);
  if (i === -1) return "";
  try { return decodeURIComponent(String(url).slice(i + marker.length).split("?")[0]); }
  catch { return ""; }
}

// Best-effort cleanup so deleted records don't leave orphaned files behind.
// Never throws — losing the file is worse than leaving one stray object.
export async function removeFromStorage(urlsOrPaths) {
  const paths = (Array.isArray(urlsOrPaths) ? urlsOrPaths : [urlsOrPaths])
    .map(u => (String(u || "").startsWith("http") ? storagePathFromUrl(u) : String(u || "")))
    .filter(Boolean);
  if (!paths.length) return;
  try { await supabase.storage.from(BUCKET).remove(paths); } catch {}
}
