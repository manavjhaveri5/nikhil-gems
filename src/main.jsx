import { StrictMode, useState, useEffect, Component } from "react";
import "./theme.css";
import { createRoot } from "react-dom/client";
import Root from "../nikhil-gems-v6.jsx";
import { supabase } from "./supabase.js";
import LoginScreen from "./LoginScreen.jsx";
import { warmCache, DEMO_MODE, syncOfflineQueue, getOfflineQueueCount } from "./utils.js";

class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100dvh",gap:16,padding:24,textAlign:"center",fontFamily:"system-ui,sans-serif"}}>
        <div style={{fontSize:32}}>⚠️</div>
        <div style={{fontSize:17,fontWeight:600,color:"#1a1208"}}>Something went wrong</div>
        <div style={{fontSize:13,color:"#7a6a4a",maxWidth:280}}>{this.state.err?.message||"An unexpected error occurred."}</div>
        <button onClick={()=>window.location.reload()} style={{marginTop:8,padding:"10px 28px",background:"#c48208",color:"#fff",border:"none",borderRadius:10,fontSize:15,fontWeight:600,cursor:"pointer"}}>
          Reload
        </button>
      </div>
    );
  }
}

// ── Service Worker registration ───────────────────────────────────────────────
if ("serviceWorker" in navigator && !DEMO_MODE) {
  navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
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
