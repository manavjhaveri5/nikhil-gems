/* The Etsy queue: a new piece published to Etsy goes up as a draft straight
   away (photos, tags, everything) and waits here; the hourly clock in
   api/listing-manager.js (etsy_queue_tick) puts drafts live at 9, 11, 1, 3
   and 5 New York time, a few a day, so the shop always has something in
   Etsy's new-listing boost and buyers see it in their afternoon. Four a day
   once the queue runs short, so it lasts. The timetable here is the same as
   the server's, worked forward hour by hour, so the times shown are the times
   it will happen. */
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { C, mob } from "./lmTheme.js";
import { loadK, loadKFresh, saveK, upsertItemK, deleteItemK, onCacheRefresh } from "./utils.js";

export const QUEUE_KEY = "ng-etsy-queue-v1";             // [{ id: listing id, etsy_id, title, image, price, shape, material, order, status: queued | live | stuck | dropped, by, tries, error, queued_at, live_at, live_day }]
export const QUEUE_SETTINGS_KEY = "ng-etsy-queue-settings-v1";   // { on, perDay, paused }
const QUEUE_TICK_KEY = "ng-etsy-queue-tick-v1";          // the clock's last knock, written by the server
const SLOTS_ET = [9, 11, 13, 15, 17];
const TAPER_BELOW = 8;
const HOUR = 3600000, DAY = 86400000;
const DEFAULTS = { on: true, perDay: 5, paused: false };

const etParts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", hourCycle: "h23" });
const etNow = (d = new Date()) => {
  const p = Object.fromEntries(etParts.formatToParts(d).map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: +p.hour };
};
const shapeOf = it => String(it?.shape || "").trim().toLowerCase();
const byOrder = (a, b) => (+a.order || 0) - (+b.order || 0);
const perDayFor = (waiting, setting) => Math.max(1, Math.min(SLOTS_ET.length, waiting < TAPER_BELOW ? Math.min(4, +setting || 5) : +setting || 5));

// Only a piece that isn't on sale yet waits: new, a draft, or one taken down by hand. A renewal never does.
export const queuesOnEtsy = l => !l?.platforms?.etsy?.listing_id || ["draft", "inactive"].includes(l.platforms.etsy.status);

export async function loadQueueSettings() {
  return { ...DEFAULTS, ...((await loadK(QUEUE_SETTINGS_KEY).catch(() => null)) || {}) };
}

/* When each waiting piece goes live: the server's rules (catch up a missed
   slot two at a time at most, a shape already up today waits behind a
   different one, four a day under eight waiting) run forward an hour at a
   time from the next knock at two past the hour. */
export function forecast(items, settings, at = new Date()) {
  const when = new Map();
  const pool = items.filter(i => i.status === "queued").sort(byOrder);
  if (settings.paused || !pool.length) return when;
  const days = {};
  const dayOf = d => days[d] || (days[d] = { n: 0, shapes: new Set() });
  for (const i of items) if (i.status === "live" && i.by === "queue" && i.live_day) { const d = dayOf(i.live_day); d.n++; d.shapes.add(shapeOf(i)); }
  let t = new Date(at); t.setUTCMinutes(2, 0, 0);
  if (t < at) t = new Date(+t + HOUR);
  for (let h = 0; h < 24 * 90 && pool.length; h++, t = new Date(+t + HOUR)) {
    const { day, hour } = etNow(t);
    const d = dayOf(day);
    const due = SLOTS_ET.slice(0, perDayFor(pool.length, settings.perDay)).filter(x => x <= hour).length;
    for (let want = Math.min(2, due - d.n); want > 0 && pool.length; want--) {
      const it = pool.splice(Math.max(0, pool.findIndex(x => !d.shapes.has(shapeOf(x)))), 1)[0];
      // Shown as the slot itself, not the two minutes past it the clock knocks.
      when.set(it.id, new Date(+t - 2 * 60000));
      d.n++; d.shapes.add(shapeOf(it));
    }
  }
  return when;
}

// "Today 7:30 pm", "Tomorrow 9:30 pm", "Tue 4 Nov 1:30 am" — in this device's time.
export function whenLabel(d, now = new Date()) {
  if (!d) return "";
  const day = x => new Date(x).toDateString();
  const time = d.toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit", hour12: true }).replace(" ", " ");
  if (day(d) === day(now)) return `Today ${time}`;
  if (day(d) === day(+now + DAY)) return `Tomorrow ${time}`;
  return `${d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} ${time}`;
}
const nyTime = d => d.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: true }).toLowerCase().replace(" ", "");

const itemFor = (listing, etsyId) => ({
  id: listing.id, etsy_id: etsyId,
  title: String(listing.etsy_title || listing.title || "").slice(0, 140),
  image: (listing.images || [])[0] || "",
  price: listing.price_etsy_usd ? `$${listing.price_etsy_usd}` : listing.price_etsy ? `₹${Math.round(+listing.price_etsy).toLocaleString("en-IN")}` : "",
  shape: listing.shape || "", material: listing.material || "",
});

/* Into the queue, at the back — or where it already is, if it's waiting.
   Returns when it goes live. */
export async function enqueueEtsy(listing, etsyId) {
  const [items, settings] = await Promise.all([loadKFresh(QUEUE_KEY).catch(() => null).then(v => v || []), loadQueueSettings()]);
  const have = items.find(i => i.id === listing.id);
  const waiting = have?.status === "queued";
  const order = waiting ? have.order : Math.max(0, ...items.filter(i => i.status === "queued").map(i => +i.order || 0)) + 1;
  const item = { ...itemFor(listing, etsyId), order, status: "queued", tries: 0, error: "", queued_at: waiting ? have.queued_at : new Date().toISOString() };
  await upsertItemK(QUEUE_KEY, item, { prepend: false });
  return forecast([...items.filter(i => i.id !== item.id), item], settings).get(item.id) || null;
}

// Put live another way (Publish now, a hand publish): it leaves the queue without using one of the day's slots.
export async function markQueueLive(listingId) {
  const items = (await loadKFresh(QUEUE_KEY).catch(() => null)) || [];
  const it = items.find(i => i.id === listingId && (i.status === "queued" || i.status === "stuck"));
  if (!it) return;
  const at = new Date();
  await upsertItemK(QUEUE_KEY, { ...it, status: "live", by: "hand", live_at: at.toISOString(), live_day: etNow(at).day, error: "" }, { prepend: false });
}

/* Asked when a new piece is published to Etsy from its card: into the queue
   (the default) or live now. Resolves "queue" | "now" | null. */
export async function chooseEtsyPublish(listing) {
  if (listing.platforms?.etsy?.status === "expired")
    return confirm("Renew on Etsy?\n\nEtsy charges a $0.20 listing fee to renew it for another four months.") ? "now" : null;
  const [items, settings] = await Promise.all([loadK(QUEUE_KEY).catch(() => null).then(v => v || []), loadQueueSettings()]);
  if (!settings.on || !queuesOnEtsy(listing)) return confirm("Publish on Etsy?\n\nEtsy charges a $0.20 listing fee to put it live.") ? "now" : null;
  const have = items.find(i => i.id === listing.id && i.status === "queued");
  const probe = have || { ...itemFor(listing, null), id: listing.id, status: "queued", order: Math.max(0, ...items.filter(i => i.status === "queued").map(i => +i.order || 0)) + 1 };
  const at = forecast(have ? items : [...items, probe], settings).get(listing.id);
  return new Promise(resolve => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const done = v => { root.unmount(); host.remove(); resolve(v); };
    root.render(<Chooser title={listing.title} at={at} queued={!!have} paused={settings.paused} onPick={done} />);
  });
}

function Chooser({ title, at, queued, paused, onPick }) {
  useEffect(() => {
    const k = e => { if (e.key === "Escape") onPick(null); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onPick]);
  const btn = (primary) => ({ display: "block", width: "100%", textAlign: "left", padding: "12px 14px", borderRadius: 10, cursor: "pointer", fontFamily: "inherit",
    border: primary ? "none" : `1px solid ${C.border}`, background: primary ? C.ink : C.surface, color: primary ? "#FAF0DC" : C.ink });
  return (
    <div onMouseDown={e => e.target === e.currentTarget && onPick(null)} style={{ position: "fixed", inset: 0, zIndex: 5000, background: "rgba(20,15,8,.5)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, fontFamily: "'Figtree',system-ui,sans-serif" }}>
      <div style={{ background: C.bg, borderRadius: 14, padding: 18, width: "100%", maxWidth: 400, boxShadow: "0 18px 50px rgba(0,0,0,.25)" }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: C.ink }}>Etsy</div>
        <div style={{ fontSize: 12.5, color: C.inkMid, marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 14 }}>
          <button type="button" autoFocus onClick={() => onPick("queue")} style={btn(true)}>
            <div style={{ fontSize: 13.5, fontWeight: 800 }}>{queued ? "Keep it in the queue" : "Add to the queue"}</div>
            <div style={{ fontSize: 11.5, opacity: .8, marginTop: 2 }}>
              {paused ? "Uploads it as a draft now · the queue is paused" : at ? `Uploads it as a draft now · goes live ${whenLabel(at)} (${nyTime(at)} New York)` : "Uploads it as a draft now"}
            </div>
          </button>
          <button type="button" onClick={() => onPick("now")} style={btn(false)}>
            <div style={{ fontSize: 13.5, fontWeight: 800 }}>Publish now</div>
            <div style={{ fontSize: 11.5, color: C.inkMid, marginTop: 2 }}>Live straight away</div>
          </button>
        </div>
        <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 10 }}>Etsy charges $0.20 when it goes live, either way.</div>
        <button type="button" onClick={() => onPick(null)} style={{ marginTop: 10, border: "none", background: "none", color: C.inkMid, fontSize: 12.5, fontWeight: 700, cursor: "pointer", padding: 0 }}>Cancel</button>
      </div>
    </div>
  );
}

/* The Queue tab: what goes live when, how long the queue lasts, anything
   Etsy refused, and what went up today. */
export default function EtsyQueuePanel({ listings = [], onPublishNow, showToast, onCount }) {
  const [items, setItems] = useState(null);
  const [settings, setSettings] = useState(DEFAULTS);
  const [tick, setTick] = useState(null);
  const [busy, setBusy] = useState("");
  const [now, setNow] = useState(() => new Date());
  const phone = mob();

  const load = async () => {
    const [q, s, t] = await Promise.all([loadKFresh(QUEUE_KEY).catch(() => null), loadQueueSettings(), loadKFresh(QUEUE_TICK_KEY).catch(() => null)]);
    setItems(Array.isArray(q) ? q : []); setSettings(s); setTick(t || null); setNow(new Date());
  };
  useEffect(() => {
    load();
    // The clock works on the server: look again every few minutes, and whenever the app's data refreshes.
    const iv = setInterval(load, 5 * 60000);
    const off = onCacheRefresh(keys => { if (!keys || keys.includes?.(QUEUE_KEY)) load(); });
    return () => { clearInterval(iv); off(); };
  }, []);

  const byId = useMemo(() => new Map(listings.map(l => [l.id, l])), [listings]);
  const all = items || [];
  const stuck = all.filter(i => i.status === "stuck");
  const when = useMemo(() => forecast(all, settings, now), [items, settings, now]);
  // In the order they'll go live (the shape rule can put one behind a later piece); queue order when paused.
  const waiting = all.filter(i => i.status === "queued").sort((a, b) => (+when.get(a.id) || Infinity) - (+when.get(b.id) || Infinity) || byOrder(a, b));
  useEffect(() => { onCount?.(waiting.length + stuck.length); }, [waiting.length, stuck.length]);

  const today = etNow(now).day;
  const recent = all.filter(i => i.status === "live" && i.live_at && +now - new Date(i.live_at) < 7 * DAY).sort((a, b) => new Date(b.live_at) - new Date(a.live_at));
  const last = waiting.length ? when.get(waiting[waiting.length - 1].id) : null;
  const runwayDays = last ? (+last - +now) / DAY : 0;
  const lastDay = last ? new Set([...when.values()].map(d => etNow(d).day)).size : 0;
  // The server knocks at two past every hour; nothing for three hours means the clock has stopped.
  const clockQuiet = tick?.at ? +now - new Date(tick.at) > 3 * HOUR : items !== null;

  const saveSettings = async patch => {
    const next = { ...settings, ...patch };
    setSettings(next);
    try { await saveK(QUEUE_SETTINGS_KEY, next); } catch (e) { showToast?.(`⚠ Not saved: ${e.message}`); load(); }
  };
  const write = async (item, label) => {
    setItems(list => (list || []).map(i => i.id === item.id ? item : i));
    try { await upsertItemK(QUEUE_KEY, item, { prepend: false }); } catch (e) { showToast?.(`⚠ ${label}: ${e.message}`); load(); }
  };
  // Goes in just ahead of the piece shown above it.
  const moveUp = async it => {
    const i = waiting.findIndex(x => x.id === it.id);
    if (i <= 0) return;
    const above = waiting[i - 1];
    // Already ahead of it in the queue, and still after it: held back by the one-of-a-shape-a-day rule.
    if ((+it.order || 0) < (+above.order || 0))
      return showToast?.(`A ${String(it.shape || "piece of this shape").toLowerCase()} already goes up that day, so this one waits a day — Publish now puts it up anyway`, 7000);
    await write({ ...it, order: (+above.order || 0) - 0.5 }, "Not moved");
  };
  const moveTop = async it => {
    const top = Math.min(...waiting.map(x => +x.order || 0));
    await write({ ...it, order: top - 1 }, "Not moved");
  };
  const remove = async it => {
    if (!confirm(`Take "${it.title}" out of the queue?\n\nIt stays on Etsy as a draft — publish it from its card when you want it live.`)) return;
    setItems(list => (list || []).filter(i => i.id !== it.id));
    try { await deleteItemK(QUEUE_KEY, it.id); } catch (e) { showToast?.(`⚠ Not removed: ${e.message}`); load(); }
  };
  const retry = it => write({ ...it, status: "queued", tries: 0, error: "" }, "Not retried");
  const publishNow = async it => {
    const l = byId.get(it.id);
    if (!l) return showToast?.("⚠ That listing isn't in the ERP any more");
    setBusy(it.id);
    try { await onPublishNow(l); showToast?.(`✓ Live on Etsy — ${String(it.title).slice(0, 40)}`); }
    catch (e) { showToast?.(`⚠ Etsy didn't publish it: ${e.message}`, 9000); }
    finally { setBusy(""); load(); }
  };

  const small = { fontSize: 11.5, color: C.inkMid };
  const pill = (on) => ({ border: `1px solid ${on ? C.ink : C.border}`, background: on ? C.ink : C.surface, color: on ? "#FAF0DC" : C.ink, borderRadius: 8, padding: "6px 11px", fontSize: 12, fontWeight: 700, cursor: "pointer" });
  const action = { border: `1px solid ${C.border}`, background: C.surface, color: C.ink, borderRadius: 8, padding: "6px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" };
  const perDay = perDayFor(waiting.length, settings.perDay);
  // The slot hours in this device's time (India sees them in its evening), on the next day they all run.
  const hourStart = new Date(now); hourStart.setUTCMinutes(0, 0, 0);
  const firstSlot = Array.from({ length: 48 }, (_, k) => new Date(+hourStart + k * HOUR)).find(x => x > now && etNow(x).hour === SLOTS_ET[0]);
  const slotsLocal = SLOTS_ET.slice(0, perDay).map(h => firstSlot ? new Date(+firstSlot + (h - SLOTS_ET[0]) * HOUR).toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit", hour12: true }) : "");
  const next = when.size ? new Date(Math.min(...[...when.values()].map(Number))) : null;

  const thumb = (it, size = 56) => {
    const src = byId.get(it.id)?.images?.[0] || it.image;
    return src ? <img src={src} alt="" style={{ width: size, height: size, borderRadius: 8, objectFit: "cover", flex: "none", background: C.card }} />
      : <div style={{ width: size, height: size, borderRadius: 8, background: C.card, flex: "none" }} />;
  };
  const meta = it => [it.shape, it.material, it.price].filter(Boolean).join(" · ");

  return (
    <div style={{ padding: phone ? "12px 12px 40px" : "16px 22px 40px", maxWidth: 980, margin: "0 auto" }}>
      <div style={{ display: "flex", gap: 12, alignItems: phone ? "stretch" : "flex-start", flexDirection: phone ? "column" : "row", marginBottom: 14 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 17, fontWeight: 800, color: C.ink }}>Etsy queue</div>
          <div style={{ ...small, marginTop: 3, lineHeight: 1.45 }}>
            New Etsy listings upload as drafts and wait here. They go live {perDay} a day at {SLOTS_ET.slice(0, perDay).map(h => `${h > 12 ? h - 12 : h}`).join(", ")} New York time
            {slotsLocal.every(Boolean) ? ` (${slotsLocal.join(", ")} here)` : ""}, when US buyers shop, mixing shapes through the day.
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", flex: "none" }}>
          <span style={{ ...small, marginRight: 2 }}>A day</span>
          {[3, 4, 5].map(n => <button key={n} type="button" onClick={() => saveSettings({ perDay: n })} style={pill(+settings.perDay === n)}>{n}</button>)}
          <button type="button" onClick={() => saveSettings({ paused: !settings.paused })} style={{ ...pill(settings.paused), marginLeft: 6 }}>{settings.paused ? "▶ Resume" : "❚❚ Pause"}</button>
        </div>
      </div>

      <label style={{ display: "flex", gap: 8, alignItems: "center", ...small, marginBottom: 12, cursor: "pointer" }}>
        <input type="checkbox" checked={!!settings.on} onChange={e => saveSettings({ on: e.target.checked })} />
        New pieces published to Etsy go into the queue{settings.on ? "" : " — off: they go live straight away"}
      </label>

      {items === null ? <div style={{ padding: 36, textAlign: "center", color: C.inkFaint, fontSize: 13 }}>Loading…</div> : <>
        <div style={{ display: "grid", gridTemplateColumns: phone ? "1fr 1fr" : "repeat(4, minmax(0, 1fr))", gap: 10, marginBottom: 12 }}>
          {[
            [waiting.length, "queued"],
            [waiting.length ? `${lastDay} day${lastDay === 1 ? "" : "s"}` : "—", last ? `runs out ${whenLabel(last, now).replace(/ \d.*$/, "")}` : "of pieces"],
            [recent.filter(i => i.live_day === today && i.by === "queue").length, "live today from here"],
            [settings.paused ? "Paused" : next ? whenLabel(next, now) : "—", "next goes live"],
          ].map(([big, label], k) => (
            <div key={k} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: "10px 12px", minWidth: 0 }}>
              <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 21, color: C.ink, lineHeight: 1.1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{big}</div>
              <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 2 }}>{label}</div>
            </div>
          ))}
        </div>

        {settings.paused && <Note tone="amber">Paused — nothing goes live until you resume. New pieces still upload as drafts and join the queue.</Note>}
        {!settings.paused && waiting.length > 0 && runwayDays < 2 && <Note tone="amber">Under two days of pieces left — publish a few more to Etsy to keep one going up every slot.</Note>}
        {clockQuiet && (waiting.length > 0 || stuck.length > 0) && <Note tone="red">{tick?.at ? `The hourly clock last ran ${whenLabel(new Date(tick.at), now)} — nothing will go live until it runs again.` : "The hourly clock hasn't run yet — it starts within the hour once it's set up."}</Note>}

        {stuck.length > 0 && <>
          <div style={{ fontSize: 12, fontWeight: 800, color: C.red, margin: "14px 0 6px", letterSpacing: ".03em" }}>ETSY REFUSED THESE — {stuck.length}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {stuck.map(it => (
              <div key={it.id} style={{ display: "flex", gap: 12, alignItems: "center", background: C.surface, border: `1px solid ${C.border}`, borderLeft: `3px solid ${C.red}`, borderRadius: 12, padding: "10px 12px", flexWrap: phone ? "wrap" : "nowrap" }}>
                {thumb(it, 48)}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: C.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.title}</div>
                  <div style={{ fontSize: 11.5, color: C.red, marginTop: 2 }}>Tried {it.tries} times: {it.error || "Etsy didn't say why"}</div>
                  <div style={small}>Fix it on the listing (or on Etsy), then try again.</div>
                </div>
                <div style={{ display: "flex", gap: 6, flex: "none" }}>
                  <button type="button" onClick={() => retry(it)} style={action}>Try again</button>
                  <button type="button" onClick={() => publishNow(it)} disabled={busy === it.id} style={action}>{busy === it.id ? "Publishing…" : "Publish now"}</button>
                  <button type="button" onClick={() => remove(it)} style={{ ...action, color: C.inkMid }}>Remove</button>
                </div>
              </div>
            ))}
          </div>
        </>}

        <div style={{ fontSize: 12, fontWeight: 800, color: C.inkMid, margin: "16px 0 6px", letterSpacing: ".03em" }}>UP NEXT</div>
        {!waiting.length ? <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 28, textAlign: "center", color: C.inkMid, fontSize: 13 }}>
          Nothing waiting. Publish a new piece to Etsy and it lands here as a draft.
        </div> : (
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12 }}>
            {waiting.map((it, i) => {
              const at = when.get(it.id);
              const newDay = i === 0 || (at && when.get(waiting[i - 1].id) && new Date(at).toDateString() !== new Date(when.get(waiting[i - 1].id)).toDateString());
              return (
                <div key={it.id}>
                  {newDay && at && <div style={{ padding: "8px 14px 4px", fontSize: 11, fontWeight: 800, color: C.inkFaint, borderTop: i ? `1px solid ${C.border}` : "none", letterSpacing: ".03em" }}>
                    {whenLabel(at, now).replace(/ \d.*$/, "").toUpperCase()}</div>}
                  <div style={{ display: "flex", gap: 12, alignItems: "center", padding: "8px 14px", flexWrap: phone ? "wrap" : "nowrap" }}>
                    {thumb(it)}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 700, color: C.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{byId.get(it.id)?.title || it.title}</div>
                      <div style={{ ...small, marginTop: 2 }}>
                        <b style={{ color: settings.paused ? C.inkFaint : C.ink }}>{settings.paused ? "Paused" : at ? whenLabel(at, now) : "—"}</b>
                        {at && !settings.paused ? ` · ${nyTime(at)} New York` : ""}{meta(it) ? ` · ${meta(it)}` : ""}
                      </div>
                      {it.tries > 0 && <div style={{ fontSize: 11.5, color: C.amber, marginTop: 2 }}>Etsy refused it {it.tries === 1 ? "once" : `${it.tries} times`}: {it.error} — trying again next slot</div>}
                      {!byId.get(it.id) && <div style={{ fontSize: 11.5, color: C.amber, marginTop: 2 }}>Not in the ERP any more — the clock will drop it</div>}
                    </div>
                    <div style={{ display: "flex", gap: 6, flex: "none" }}>
                      {i > 0 && <button type="button" onClick={() => moveUp(it)} title="Move up one" style={action}>↑</button>}
                      {i > 1 && <button type="button" onClick={() => moveTop(it)} title="Move to the front" style={action}>⇡ Next</button>}
                      <button type="button" onClick={() => publishNow(it)} disabled={busy === it.id || !byId.get(it.id)} style={action}>{busy === it.id ? "Publishing…" : "Publish now"}</button>
                      <button type="button" onClick={() => remove(it)} style={{ ...action, color: C.inkMid }}>Remove</button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {recent.length > 0 && <>
          <div style={{ fontSize: 12, fontWeight: 800, color: C.inkMid, margin: "18px 0 6px", letterSpacing: ".03em" }}>WENT LIVE THIS WEEK</div>
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12 }}>
            {recent.map((it, i) => (
              <a key={it.id} href={`https://www.etsy.com/listing/${it.etsy_id}`} target="_blank" rel="noreferrer"
                style={{ display: "flex", gap: 12, alignItems: "center", padding: "8px 14px", borderTop: i ? `1px solid ${C.border}` : "none", textDecoration: "none" }}>
                {thumb(it, 36)}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.title}</div>
                  <div style={small}>{whenLabel(new Date(it.live_at), now)} · {it.by === "queue" ? "from the queue" : it.by === "hand" ? "published by hand" : it.note || "elsewhere"}</div>
                </div>
                <span style={{ fontSize: 12, color: C.inkFaint, flex: "none" }}>Etsy ↗</span>
              </a>
            ))}
          </div>
        </>}
        {tick?.at && <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 14 }}>Clock last ran {whenLabel(new Date(tick.at), now)}{tick.done ? ` · put ${tick.done} live` : ""}{tick.failed ? ` · ${tick.failed} refused` : ""}.</div>}
      </>}
    </div>
  );
}

function Note({ tone, children }) {
  const bg = tone === "red" ? C.redBg : C.amberBg, fg = tone === "red" ? C.red : C.amber;
  return <div style={{ background: bg, color: fg, borderRadius: 10, padding: "8px 12px", fontSize: 12.5, marginBottom: 10 }}>⚠ {children}</div>;
}
