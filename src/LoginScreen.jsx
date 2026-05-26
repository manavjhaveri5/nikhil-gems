import { useState } from "react";
import { supabase } from "./supabase.js";

const C = {
  bg: "#FAF7F2", surface: "#FFFFFF",
  ink: "#1A1308", inkMid: "#4E4433", inkFaint: "#8C7E66",
  gold: "#9A6200", goldLight: "#FEF6E0", goldBright: "#C48208",
  border: "#E3DDD4", borderHi: "#C4B898",
  red: "#892020", redBg: "#FEEEED",
};

export default function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const login = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setError(error.message);
    setLoading(false);
  };

  return (
    <div style={{ minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ width: 360, background: C.surface, borderRadius: 16, border: `1px solid ${C.border}`, padding: "40px 36px", boxShadow: "0 4px 24px #0000000a" }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ fontSize: 28, marginBottom: 4 }}>💎</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: C.ink, letterSpacing: 0.3 }}>Nikhil Gems</div>
          <div style={{ fontSize: 10, color: C.inkFaint, letterSpacing: 1.5, fontWeight: 600, textTransform: "uppercase", marginTop: 2 }}>Business Suite</div>
        </div>

        <form onSubmit={login}>
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: C.inkMid, letterSpacing: 0.8, marginBottom: 5, textTransform: "uppercase" }}>Email</label>
            <input
              type="email" value={email} onChange={e => setEmail(e.target.value)}
              required autoFocus
              style={{ width: "100%", boxSizing: "border-box", padding: "9px 12px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 14, color: C.ink, background: C.bg, outline: "none" }}
            />
          </div>
          <div style={{ marginBottom: 22 }}>
            <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: C.inkMid, letterSpacing: 0.8, marginBottom: 5, textTransform: "uppercase" }}>Password</label>
            <input
              type="password" value={password} onChange={e => setPassword(e.target.value)}
              required
              style={{ width: "100%", boxSizing: "border-box", padding: "9px 12px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 14, color: C.ink, background: C.bg, outline: "none" }}
            />
          </div>

          {error && (
            <div style={{ background: C.redBg, color: C.red, borderRadius: 8, padding: "8px 12px", fontSize: 13, marginBottom: 16 }}>{error}</div>
          )}

          <button
            type="submit" disabled={loading}
            style={{ width: "100%", padding: "11px", background: C.gold, color: "#fff", border: "none", borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.7 : 1, letterSpacing: 0.3 }}
          >
            {loading ? "Signing in…" : "Sign In"}
          </button>
        </form>

        <div style={{ marginTop: 24, textAlign: "center", fontSize: 10, color: C.inkFaint, letterSpacing: 0.5 }}>JAI SWAMINARAYAN</div>
      </div>
    </div>
  );
}
