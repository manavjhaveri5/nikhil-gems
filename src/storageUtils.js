import { supabase } from "./supabase.js";

const BUCKET = "ng-media";
let bucketReadyPromise = null;

async function ensureBucket() {
  if (!bucketReadyPromise) {
    bucketReadyPromise = supabase.storage.createBucket(BUCKET, { public: true }).catch(() => {});
  }
  return bucketReadyPromise;
}

export async function uploadToStorage(path, file) {
  await ensureBucket();
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
    upsert: true,
    contentType: file.type || "application/octet-stream",
  });
  if (error) throw new Error(error.message);
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}
