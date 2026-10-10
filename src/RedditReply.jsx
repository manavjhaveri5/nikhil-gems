/* The "EE reply" bookmark's window. On a Reddit post, the bookmark reads the
   post (title, text, photos) from the page you're on and opens this, with the
   post in the address after #. The reply is drafted straight away, from the
   photos, in the rough-stone expert's voice — copy it, paste it into Reddit.
   Reading the page in your own browser needs no Reddit API access. */
import { useEffect, useState } from "react";
import { supabase } from "./supabase.js";
import { draftAnswer } from "./redditAnswer.js";

const ERP = typeof window !== "undefined" ? window.location.origin : "";
/* What the bookmark runs on reddit.com. Photos: the post's own (i.redd.it /
   preview.redd.it), never avatars or icons; the page's share image as a
   fallback. */
export const BOOKMARKLET = `javascript:(()=>{const p=document.querySelector('shreddit-post');const t=(p&&p.getAttribute('post-title'))||(document.querySelector('meta[property="og:title"]')||{}).content||(document.querySelector('h1')||{}).innerText||document.title;const s=(location.pathname.match(/\\/r\\/([^/]+)/)||[])[1]||'';const b=((p&&p.querySelector('[slot="text-body"]'))||{}).innerText||(document.querySelector('meta[property="og:description"]')||{}).content||'';const im=[...new Set([...document.querySelectorAll('shreddit-post img, gallery-carousel img, shreddit-player')].map(i=>i.currentSrc||i.src||i.getAttribute('poster')||'').filter(u=>/(i|preview)\\.redd\\.it/.test(u)))];const og=(document.querySelector('meta[property="og:image"]')||{}).content;if(og&&!im.length)im.push(og);if(!s){alert('Open a Reddit post first');return}window.open('${ERP}/reddit-reply#'+encodeURIComponent(JSON.stringify({t:t,s:s,b:b.slice(0,1500),i:im.slice(0,3),u:location.href})),'eereply','width=560,height=740');})();`;

export default function RedditReply() {
  const [post, setPost] = useState(null);
  const [reply, setReply] = useState("");
  const [state, setState] = useState("");   // "" | "busy" | "copied" | error text
  const [signedIn, setSignedIn] = useState(null);

  useEffect(() => {
    try { const d = JSON.parse(decodeURIComponent(location.hash.slice(1) || "null")); if (d) setPost({ sub: d.s, title: d.t, text: d.b, images: d.i || [], url: d.u }); } catch { /* none */ }
    supabase.auth.getSession().then(({ data }) => setSignedIn(!!data?.session));
  }, []);

  const draft = async (extra = "") => {
    setState("busy"); setReply("");
    try {
      const r = await draftAnswer(post, extra);
      setReply(r);
      try { await navigator.clipboard.writeText(r); setState("copied"); } catch { setState(""); }
    } catch (e) { setState(e.message || String(e)); }
  };
  useEffect(() => { if (post && signedIn) draft(); }, [post, signedIn]);   // eslint-disable-line react-hooks/exhaustive-deps

  const copy = async () => { try { await navigator.clipboard.writeText(reply); setState("copied"); } catch { setState("Couldn't copy — select the text and copy it"); } };
  const box = { fontFamily: "-apple-system, system-ui, sans-serif", color: "#1A1714", background: "#FAF7F2", minHeight: "100vh", padding: 18, boxSizing: "border-box" };
  const btn = (bg = "#fff", fg = "#1A1714") => ({ background: bg, color: fg, border: bg === "#fff" ? "1px solid #DDD5C8" : "none", borderRadius: 8, padding: "9px 14px", fontSize: 14, fontWeight: 700, cursor: "pointer" });

  if (signedIn === false) return <div style={box}><b>Sign in to the ERP first</b><p style={{ fontSize: 14 }}>Open <a href="/">the ERP</a> in this browser, sign in, then click the EE reply bookmark again on the Reddit post.</p></div>;
  if (!post) return (
    <div style={box}>
      <h2 style={{ fontSize: 18, margin: "0 0 8px" }}>EE reply — Reddit answers in one click</h2>
      <p style={{ fontSize: 14, lineHeight: 1.5 }}>Drag this button to your bookmarks bar (show it with ⌘⇧B):</p>
      <a href={BOOKMARKLET} onClick={e => { e.preventDefault(); alert("Drag this to your bookmarks bar, don't click it here."); }} style={{ ...btn("#1A1714", "#FAF0DC"), display: "inline-block", textDecoration: "none" }}>EE reply</a>
      <p style={{ fontSize: 14, lineHeight: 1.5 }}>Then on any question in r/whatsthisrock or r/crystals, click <b>EE reply</b>. A window like this one drafts the answer from the post and its photos and copies it. Paste it into the comment box, change anything you like, post.</p>
    </div>
  );
  return (
    <div style={box}>
      <div style={{ fontSize: 12, color: "#8A8378", fontWeight: 700 }}>r/{post.sub}</div>
      <div style={{ fontSize: 15, fontWeight: 700, margin: "2px 0 8px" }}>{post.title}</div>
      {post.images.length > 0 && <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>{post.images.map(u => <img key={u} src={u} alt="" style={{ width: 70, height: 70, objectFit: "cover", borderRadius: 8 }} />)}</div>}
      {state === "busy" && <div style={{ fontSize: 14, color: "#5D5850" }}>Looking at the photos and writing…</div>}
      {reply && <textarea value={reply} onChange={e => setReply(e.target.value)} rows={8} style={{ width: "100%", boxSizing: "border-box", fontSize: 14, lineHeight: 1.5, padding: 10, borderRadius: 8, border: "1px solid #DDD5C8", fontFamily: "inherit" }} />}
      {reply && <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
        <button onClick={copy} style={btn("#1A1714", "#FAF0DC")}>{state === "copied" ? "✓ Copied — paste it on Reddit" : "Copy"}</button>
        <button onClick={() => draft()} style={btn()}>↻ Another</button>
        <button onClick={() => draft("Make it shorter: 1-2 sentences.")} style={btn()}>Shorter</button>
      </div>}
      {state && !["busy", "copied"].includes(state) && <div style={{ color: "#B42318", fontSize: 13, marginTop: 8 }}>⚠ {state}</div>}
    </div>
  );
}
