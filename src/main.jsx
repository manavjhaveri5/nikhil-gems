import { StrictMode, useState, useEffect, Component } from "react";
import "./theme.css";
import { createRoot } from "react-dom/client";
import Root from "../nikhil-gems-v6.jsx";
import { supabase } from "./supabase.js";
import LoginScreen from "./LoginScreen.jsx";
import { warmCache, DEMO_MODE, syncOfflineQueue, getOfflineQueueCount, logActivity } from "./utils.js";
import { inject as injectAnalytics } from "@vercel/analytics";

const clearAppShellAndReload = async () => {
  try {
    sessionStorage.setItem("ng-update-scroll", JSON.stringify({ x: window.scrollX || 0, y: window.scrollY || 0 }));
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.filter(k => k.startsWith("ng-shell-")).map(k => caches.delete(k)));
    }
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(reg => reg.update().catch(() => {})));
    }
  } catch {}
  const url = new URL(window.location.href);
  url.searchParams.set("reload", String(Date.now()));
  window.location.href = url.toString();
};

const isStaleChunkError = err => {
  const msg = String(err?.message || err || "");
  return /Failed to fetch dynamically imported module|Importing a module script failed|Loading chunk|dynamically imported/i.test(msg);
};

window.addEventListener("unhandledrejection", e => {
  if (isStaleChunkError(e.reason)) {
    e.preventDefault?.();
    clearAppShellAndReload();
  }
});

// ── Client crash reporting → Activity feed ───────────────────────────────────
// Crashes land in the admin-visible activity log with user/device context.
// Deduped per message and capped per session so a crash loop can't flood it.
if (!DEMO_MODE) {
  const reported = new Set();
  let errBudget = 5;
  const reportClientError = async (kind, err) => {
    try {
      if (isStaleChunkError(err)) return; // handled by the reload flow above
      const msg = String(err?.message || err || "unknown").slice(0, 160);
      if (!msg || msg === "unknown" || reported.has(msg) || errBudget <= 0) return;
      reported.add(msg); errBudget--;
      let email = "";
      try { const { data: { session } } = await supabase.auth.getSession(); email = session?.user?.email || ""; } catch {}
      const device = /Mobi|Android/i.test(navigator.userAgent) ? "mobile" : "desktop";
      logActivity({ user: email || "unknown", action: "error", module: "system", label: `💥 ${kind}: ${msg} · ${device}` });
    } catch {}
  };
  window.addEventListener("error", e => reportClientError("crash", e.error || e.message));
  window.addEventListener("unhandledrejection", e => reportClientError("promise", e.reason));
  injectAnalytics(); // Vercel Web Analytics (no-op locally; needs the dashboard toggle once)
}

class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err) {
    if (isStaleChunkError(err)) clearAppShellAndReload();
  }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100dvh",gap:16,padding:24,textAlign:"center",fontFamily:"system-ui,sans-serif"}}>
        <div style={{fontSize:32}}>⚠️</div>
        <div style={{fontSize:17,fontWeight:600,color:"#1a1208"}}>Something went wrong</div>
        <div style={{fontSize:13,color:"#7a6a4a",maxWidth:280}}>{this.state.err?.message||"An unexpected error occurred."}</div>
        <button onClick={clearAppShellAndReload} style={{marginTop:8,padding:"10px 28px",background:"#c48208",color:"#fff",border:"none",borderRadius:10,fontSize:15,fontWeight:600,cursor:"pointer"}}>
          Reload
        </button>
      </div>
    );
  }
}

// ── Service Worker registration ───────────────────────────────────────────────
if ("serviceWorker" in navigator && !DEMO_MODE) {
  navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).then(reg => {
    reg.update().catch(() => {});
    setInterval(() => reg.update().catch(() => {}), 60 * 1000);
  }).catch(() => {});
}

function App() {
  const [session, setSession] = useState(DEMO_MODE ? "demo" : undefined);

  useEffect(() => {
    if (DEMO_MODE) return; // skip auth entirely in demo
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      if (session) warmCache();
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_, session) => {
      setSession(session);
      if (session) warmCache();
    });
    return () => subscription.unsubscribe();
  }, []);

  if (session === undefined) return (
    <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100dvh",background:"#FAF7F2",flexDirection:"column",gap:14}}>
      <div style={{fontSize:44,animation:"pulse 1.2s ease-in-out infinite"}}>💎</div>
    </div>
  );
  if (!session) return <ErrorBoundary><LoginScreen /></ErrorBoundary>;
  return <ErrorBoundary><Root onSignOut={DEMO_MODE ? () => {} : () => supabase.auth.signOut()} /></ErrorBoundary>;
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);
