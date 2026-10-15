import { requireUser } from "../lib/auth.js";
import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const caller = await requireUser(req, res);
  if (!caller) return;

  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    return res.status(500).json({ error: "SUPABASE_SERVICE_ROLE_KEY not configured in Vercel env vars" });
  }

  const supabaseAdmin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Creating logins, resetting passwords and deleting accounts is the admin's
  // alone. Staff are the accounts named in ng-users-v1 (same rule as the app);
  // ADMIN_EMAILS, when set, narrows it to those addresses. If the staff list
  // can't be read, refuse rather than guess.
  const callerEmail = (caller.email || "").toLowerCase();
  const { data: staffRow, error: staffErr } = await supabaseAdmin
    .from("app_data").select("value").eq("key", "ng-users-v1").maybeSingle();
  if (staffErr || !staffRow || !Array.isArray(staffRow.value)) {
    return res.status(503).json({ error: "Couldn't verify admin access — try again" });
  }
  const admins = (process.env.ADMIN_EMAILS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  const isStaff = staffRow.value.some(u => u?.email?.toLowerCase() === callerEmail);
  if (!callerEmail || isStaff || (admins.length && !admins.includes(callerEmail))) {
    return res.status(403).json({ error: "Only the admin can manage logins" });
  }

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

    // If auth account already exists (e.g. after a KV wipe), find the existing
    // user, update their password, and return their ID so the profile can be saved.
    if (error) {
      const msg = error.message || "";
      if (msg.toLowerCase().includes("already been registered") || msg.toLowerCase().includes("already registered")) {
        const { data: list, error: listErr } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
        if (!listErr && list?.users) {
          const existing = list.users.find(u => u.email?.toLowerCase() === email.toLowerCase());
          if (existing) {
            await supabaseAdmin.auth.admin.updateUserById(existing.id, { password });
            return res.json({ success: true, userId: existing.id, alreadyExisted: true });
          }
        }
      }
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true, userId: data.user.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
