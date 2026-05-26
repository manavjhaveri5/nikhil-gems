import { StrictMode, useState, useEffect } from "react";
import "./theme.css";
import { createRoot } from "react-dom/client";
import Root from "../nikhil-gems-v6.jsx";
import { supabase } from "./supabase.js";
import LoginScreen from "./LoginScreen.jsx";
import { warmCache, DEMO_MODE } from "./utils.js";

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

  if (session === undefined) return null;
  if (!session) return <LoginScreen />;
  return <Root onSignOut={DEMO_MODE ? () => {} : () => supabase.auth.signOut()} />;
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);
