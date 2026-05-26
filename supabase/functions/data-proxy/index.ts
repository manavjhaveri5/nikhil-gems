import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── AES-256-GCM helpers ───────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2)
    arr[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return arr;
}

async function getKey(): Promise<CryptoKey> {
  const keyHex = Deno.env.get("DATA_ENCRYPTION_KEY");
  if (!keyHex || keyHex.length !== 64)
    throw new Error("DATA_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)");
  return crypto.subtle.importKey(
    "raw", hexToBytes(keyHex), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]
  );
}

async function encrypt(plaintext: string): Promise<string> {
  const key = await getKey();
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const buf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)
  );
  const out = new Uint8Array(12 + buf.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(buf), 12);
  return "ENC:" + btoa(String.fromCharCode(...out));
}

async function decrypt(stored: string): Promise<unknown> {
  // Plain-text legacy values — return as-is, will be encrypted on next save
  if (!stored.startsWith("ENC:")) {
    try { return JSON.parse(stored); } catch { return stored; }
  }
  const key      = await getKey();
  const combined = Uint8Array.from(atob(stored.slice(4)), (c) => c.charCodeAt(0));
  const decBuf   = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: combined.slice(0, 12) }, key, combined.slice(12)
  );
  return JSON.parse(new TextDecoder().decode(decBuf));
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  // Require a valid Supabase JWT
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  // Verify the token belongs to a real user
  const userClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } }
  );
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  // Service-role client for DB ops (direct table access, protected by our own auth check above)
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    const { action, key, value } = await req.json();
    if (!key) throw new Error("key is required");

    // LOAD
    if (action === "load") {
      const { data, error } = await admin
        .from("app_data").select("value").eq("key", key).single();
      if (error && error.code !== "PGRST116") throw error;
      if (!data) return new Response(JSON.stringify({ value: [] }), {
        headers: { ...CORS, "Content-Type": "application/json" },
      });
      const raw = typeof data.value === "string" ? data.value : JSON.stringify(data.value);
      const decrypted = await decrypt(raw);
      return new Response(JSON.stringify({ value: decrypted }), {
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // SAVE
    if (action === "save") {
      const encrypted = await encrypt(JSON.stringify(value));
      const { error } = await admin.from("app_data").upsert({ key, value: encrypted });
      if (error) throw error;
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    throw new Error(`Unknown action: ${action}`);

  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
