/* "Just listed" stories catch-up. The story image (lettering, fonts, layout)
   is drawn only by the Stories module, renderListedStory in StoryStudio.jsx,
   which needs a real browser. So any open ERP or Studio tab checks every 10
   minutes for new pieces still waiting for their story, draws each one, and
   posts it. The server holds a 5-minute lock per piece so two open tabs never
   post the same story twice. */
let running = false;

async function catchUp() {
  if (running || document.hidden) return;
  running = true;
  try {
    const r = await fetch("/api/social?action=story_pending", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "story_pending" }) });
    if (!r.ok) return;
    const { pending = [] } = await r.json();
    if (!pending.length) return;
    const [{ renderListedStory }, { uploadToStorage }] = await Promise.all([import("./StoryStudio.jsx"), import("./storageUtils.js")]);
    for (const l of pending.slice(0, 3)) {
      try {
        const blob = await renderListedStory(l);
        const image = await uploadToStorage(`social-stories/${Date.now().toString(36)}-${l.id}.jpg`, new File([blob], "just-listed.jpg", { type: "image/jpeg" }));
        await fetch("/api/social", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "story_now", id: l.id, image }) });
      } catch (e) { console.warn("story catch-up", l.id, e?.message || e); }
    }
  } catch (e) { console.warn("story catch-up", e?.message || e); }
  finally { running = false; }
}

let started = false;
export function startStoryCatchup() {
  if (started) return;
  started = true;
  setTimeout(catchUp, 20000);
  setInterval(catchUp, 10 * 60000);
}
