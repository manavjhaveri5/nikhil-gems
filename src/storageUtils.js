import { supabase } from "./supabase.js";

const BUCKET = "ng-media";
let bucketReady = false;

async function ensureBucket() {
  if (bucketReady) return;
  await supabase.storage.createBucket(BUCKET, { public: true }).catch(() => {});
  bucketReady = true;
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
