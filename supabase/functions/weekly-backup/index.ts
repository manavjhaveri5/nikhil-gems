import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

async function uploadToGist(filename: string, content: string): Promise<string> {
  const token = Deno.env.get("GITHUB_TOKEN");
  if (!token) throw new Error("GITHUB_TOKEN secret not set");

  const res = await fetch("https://api.github.com/gists", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "nikhil-gems-backup",
    },
    body: JSON.stringify({
      description: `Nikhil Gems Backup — ${filename}`,
      public: false, // private gist
      files: { [filename]: { content } },
    }),
  });

  const gist = await res.json();
  if (!gist.html_url) throw new Error(`Gist upload failed: ${JSON.stringify(gist)}`);
  return gist.html_url;
}

Deno.serve(async (req: Request) => {
  // Auth — only requests with the correct secret header are accepted
  const secret   = Deno.env.get("BACKUP_SECRET");
  const provided = req.headers.get("x-backup-secret");
  if (secret && provided !== secret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data, error } = await admin.from("app_data").select("key, value");
    if (error) throw error;

    const now      = new Date();
    const dateStr  = now.toISOString().slice(0, 10);
    const filename = `nikhil-gems-backup-${dateStr}.json`;
    const content  = JSON.stringify(
      { createdAt: now.toISOString(), rowCount: data.length, data },
      null, 2
    );

    const url    = await uploadToGist(filename, content);
    const sizeMB = (new TextEncoder().encode(content).length / 1024 / 1024).toFixed(2);

    console.log(`[Backup OK] ${data.length} records · ${sizeMB} MB → ${url}`);

    return new Response(
      JSON.stringify({ ok: true, filename, url, rows: data.length, sizeMB }),
      { headers: { "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("[Backup FAILED]", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});
