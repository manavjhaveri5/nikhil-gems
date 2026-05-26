import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    return res.status(500).json({ error: "SUPABASE_SERVICE_ROLE_KEY not configured in Vercel env vars" });
  }

  const supabaseAdmin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { email, password, action, userId } = req.body || {};

  try {
    if (action === "delete") {
      const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);
      if (error) return res.status(400).json({ error: error.message });
      return res.json({ success: true });
    }

    if (action === "update-password") {
      if (!userId || !password) return res.status(400).json({ error: "userId and password required" });
      const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, { password });
      if (error) return res.status(400).json({ error: error.message });
      return res.json({ success: true });
    }

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true, userId: data.user.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
