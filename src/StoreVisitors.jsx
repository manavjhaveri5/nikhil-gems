/* Store → Visitors: who is on eartheditions.co right now, where visitors come
   from, and what each one looked at and did.

   The storefront records page views and actions (add to cart, checkout,
   purchase, newsletter sign-up) in site_events, and keeps one row per open
   visit in site_live, refreshed every 30 s. A visitor is an anonymous id in
   their browser; their name or email shows once they sign up or buy. Places
   come from the visitor's IP address at the time (no IP is kept) — the
   country is reliable, the city approximate. */
import { useState, useEffect, useMemo, useCallback } from "react";
import { supabase } from "./supabase.js";
import { C, mob } from "./lmTheme.js";

const card = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12 };
const btn = (on = false) => ({ background: on ? C.ink : C.surface, color: on ? "#fff" : C.ink, border: on ? "none" : `1px solid ${C.border}`, borderRadius: 999, padding: "6px 13px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" });
const lab = { fontSize: 9.5, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .6 };
const flag = cc => /^[A-Z]{2}$/.test(cc || "") ? String.fromCodePoint(...[...cc].map(c => 127397 + c.charCodeAt(0))) : "🌐";
const COUNTRY = (() => { try { return new Intl.DisplayNames(["en"], { type: "region" }); } catch { return null; } })();
const countryName = cc => { try { return cc ? COUNTRY?.of(cc) || cc : "Unknown"; } catch { return cc || "Unknown"; } };
const place = x => [x.city, countryName(x.country)].filter(Boolean).join(", ");
const ago = t => { const s = Math.max(0, (Date.now() - new Date(t)) / 1e3); return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
const dur = ms => { const s = Math.round(ms / 1e3); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m`; };
const time = t => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const day = t => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const pageName = e => e.handle ? (e.title || e.handle).replace(/ \| Earth Editions$/, "") : e.path === "/" ? "Home" : (e.title || e.path).replace(/ \| Earth Editions$/, "");
const ACTION = { add_to_cart: "🛒 Added to cart", checkout: "💳 Went to checkout", purchase: "✅ Bought", signup: "✉️ Joined the list", option: "Picked an option", search: "🔍 Searched" };
const RANGES = [["today", "Today"], ["7d", "7 days"], ["30d", "30 days"]];
const since = r => { const d = new Date(); if (r === "today") d.setHours(0, 0, 0, 0); else d.setDate(d.getDate() - (r === "7d" ? 7 : 30)); return d.toISOString(); };

async function pages(build, max = 20000) {
  const out = [];
  for (let from = 0; from < max; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

export default function VisitorsTab({ showToast, site }) {
  const [range, setRange] = useState("today");
  const [staff, setStaff] = useState(false);
  const [events, setEvents] = useState(null);
  const [live, setLive] = useState([]);
  const [who, setWho] = useState({});
  const [open, setOpen] = useState(null);
  const [missing, setMissing] = useState(false);

  const loadLive = useCallback(async () => {
    let qy = supabase.from("site_live").select("*").gt("last_seen", new Date(Date.now() - 200e3).toISOString()).order("started_at", { ascending: false }).limit(200);
    if (!staff) qy = qy.eq("is_staff", false);
    const { data, error } = await qy;
    if (error) { if (/site_live|does not exist|schema cache/i.test(error.message)) setMissing(true); return; }
    setLive(data || []);
  }, [staff]);
  const load = useCallback(async () => {
    try {
      const [ev, ids] = await Promise.all([
        pages(() => { let qy = supabase.from("site_events").select("*").gte("at", since(range)).order("at", { ascending: false }); return staff ? qy : qy.eq("is_staff", false); }),
        // Names and emails, from any sign-up or purchase ever — so a returning buyer is recognised.
        pages(() => supabase.from("site_events").select("vid,data,at").in("type", ["signup", "purchase"]).order("at", { ascending: false }), 5000),
      ]);
      const w = {};
      for (const r of ids) if (!w[r.vid] && (r.data?.email || r.data?.name)) w[r.vid] = { email: r.data.email || "", name: r.data.name || "" };
      setWho(w); setEvents(ev); setMissing(false);
    } catch (e) {
      if (/site_events|does not exist|schema cache/i.test(e.message)) { setMissing(true); setEvents([]); }
      else { showToast("⚠ " + e.message); setEvents([]); }
    }
  }, [range, staff, showToast]);
  useEffect(() => { load(); const t = setInterval(load, 60e3); return () => clearInterval(t); }, [load]);
  useEffect(() => { loadLive(); const t = setInterval(loadLive, 10e3); return () => clearInterval(t); }, [loadLive]);

  const s = useMemo(() => {
    // Turned-away visits (blocked cities, VPNs) are counted on their own, never as visits.
    const blockedEv = (events || []).filter(e => e.type === "blocked");
    const ev = [...(events || [])].filter(e => e.type !== "blocked").reverse();   // oldest first
    const visits = new Map();
    for (const e of ev) {
      let v = visits.get(e.sid);
      if (!v) visits.set(e.sid, v = { sid: e.sid, vid: e.vid, start: e.at, end: e.at, source: e.source || "direct", campaign: e.campaign, referrer: e.referrer, country: e.country, city: e.city, region: e.region, device: e.device, browser: e.browser, os: e.os, lang: e.lang, events: [] });
      v.end = e.at; v.events.push(e);
    }
    const all = [...visits.values()];
    for (const v of all) { const l = live.find(x => x.sid === v.sid); if (l && l.last_seen > v.end) v.end = l.last_seen; }
    const did = (v, t) => v.events.some(e => e.type === t);
    const tally = (key, extra = () => ({})) => {
      const m = new Map();
      for (const v of all) { const k = key(v); const r = m.get(k) || { k, visits: 0, carts: 0, buys: 0, ...extra(v) }; r.visits++; if (did(v, "add_to_cart")) r.carts++; if (did(v, "purchase")) r.buys++; m.set(k, r); }
      return [...m.values()].sort((a, b) => b.visits - a.visits);
    };
    const prod = new Map();
    for (const e of ev) if (e.handle && (e.type === "view" || e.type === "add_to_cart")) {
      const r = prod.get(e.handle) || { handle: e.handle, title: "", views: 0, carts: 0 };
      if (e.type === "view") { r.views++; r.title = r.title || pageName(e); } else r.carts++;
      prod.set(e.handle, r);
    }
    return {
      visits: all.sort((a, b) => b.end.localeCompare(a.end)),
      people: new Set(all.map(v => v.vid)).size,
      views: ev.filter(e => e.type === "view").length,
      carts: all.filter(v => did(v, "add_to_cart")).length,
      checkouts: all.filter(v => did(v, "checkout")).length,
      buys: all.filter(v => did(v, "purchase")).length,
      sources: tally(v => v.source),
      places: tally(v => `${v.country}|${v.city}`, v => ({ country: v.country, city: v.city })),
      devices: tally(v => v.device || "unknown"),
      products: [...prod.values()].sort((a, b) => b.views - a.views).slice(0, 15),
      returning: all.filter(v => all.some(o => o.vid === v.vid && o.start < v.start)).length,
      blocked: blockedEv,
      blockedPlaces: [...blockedEv.reduce((m, e) => { const k = `${e.city || "?"}|${e.data?.site || ""}`; const r = m.get(k) || { city: e.city || "Unknown", country: e.country, site: e.data?.site || "", n: 0, last: e.at }; r.n++; if (e.at > r.last) r.last = e.at; return m.set(k, r); }, new Map()).values()].sort((a, b) => b.n - a.n),
    };
  }, [events, live]);

  if (missing) return (
    <div style={{ ...card, padding: 24, fontSize: 13.5, lineHeight: 1.6 }}>
      <b>Visitor stats need their database tables.</b> Run the migration <code>supabase/migrations/20261001090000_site_visitors.sql</code> in Supabase → SQL Editor (project ERP). The store starts recording visits as soon as the tables exist.
    </div>
  );

  const Stat = ({ n, l, sub }) => (
    <div style={{ ...card, padding: "12px 14px", flex: "1 1 120px" }}>
      <div style={lab}>{l}</div>
      <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4 }}>{n}</div>
      {sub && <div style={{ fontSize: 11, color: C.inkFaint }}>{sub}</div>}
    </div>
  );
  const pct = (a, b) => b ? `${Math.round(a / b * 100)}%` : "—";
  const Table = ({ title, rows, cols, empty = "Nothing yet." }) => (
    <div style={{ ...card, padding: "12px 14px", minWidth: 0 }}>
      <div style={{ ...lab, marginBottom: 8 }}>{title}</div>
      {!rows.length ? <div style={{ fontSize: 12.5, color: C.inkFaint }}>{empty}</div> : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead><tr>{cols.map(([h, , right]) => <th key={h} style={{ textAlign: right ? "right" : "left", fontWeight: 600, color: C.inkFaint, fontSize: 11, padding: "0 0 6px" }}>{h}</th>)}</tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i} style={{ borderTop: `1px solid ${C.border}` }}>{cols.map(([h, f, right]) => <td key={h} style={{ padding: "6px 0", textAlign: right ? "right" : "left", maxWidth: right ? undefined : 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f(r)}</td>)}</tr>)}</tbody>
        </table>
      )}
    </div>
  );

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {/* Right now */}
      <div style={{ ...card, padding: "14px 16px", borderColor: live.length ? C.green : C.border }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: live.length ? 10 : 0 }}>
          <span style={{ width: 9, height: 9, borderRadius: 9, background: live.length ? C.green : C.inkFaint, boxShadow: live.length ? `0 0 0 4px ${C.greenBg}` : "none" }} />
          <b style={{ fontSize: 15 }}>{live.length} on the site right now</b>
          <span style={{ fontSize: 11.5, color: C.inkFaint }}>updates every 10 s</span>
        </div>
        {live.map(l => (
          <div key={l.sid} style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 13, padding: "6px 0", borderTop: `1px solid ${C.border}`, flexWrap: "wrap" }}>
            <span style={{ fontSize: 16 }}>{flag(l.country)}</span>
            <span style={{ minWidth: 140 }}>{place(l)}{who[l.vid] ? <b> · {who[l.vid].name || who[l.vid].email}</b> : ""}</span>
            <a href={`${site}${l.path}`} target="_blank" rel="noreferrer" style={{ flex: 1, minWidth: 160, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{(l.title || l.path).replace(/ \| Earth Editions$/, "")}</a>
            <span style={{ color: C.inkMid }}>{l.source || "direct"} · {l.device}</span>
            <span style={{ color: C.inkFaint, fontSize: 12 }}>on site {dur(new Date(l.last_seen) - new Date(l.started_at))}</span>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {RANGES.map(([k, l]) => <button key={k} onClick={() => setRange(k)} style={btn(range === k)}>{l}</button>)}
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5, color: C.inkMid, marginLeft: 6 }}><input type="checkbox" checked={staff} onChange={e => setStaff(e.target.checked)} />Include staff</label>
        <div style={{ flex: 1 }} /><button onClick={() => { load(); loadLive(); }} style={btn()}>↻ Refresh</button>
      </div>

      {!events ? <div style={{ color: C.inkFaint, fontSize: 13 }}>Loading…</div> : <>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Stat n={s.people} l="Visitors" sub={`${s.returning} returning visit${s.returning === 1 ? "" : "s"}`} />
          <Stat n={s.visits.length} l="Visits" />
          <Stat n={s.views} l="Pages viewed" sub={s.visits.length ? `${(s.views / s.visits.length).toFixed(1)} per visit` : ""} />
          <Stat n={s.carts} l="Added to cart" sub={`${pct(s.carts, s.visits.length)} of visits`} />
          <Stat n={s.checkouts} l="Checkouts" />
          <Stat n={s.buys} l="Bought" sub={`${pct(s.buys, s.visits.length)} of visits`} />
        </div>

        <Table title={`Turned away — ${s.blocked.length} blocked visit${s.blocked.length === 1 ? "" : "s"} (blocked cities and VPNs, both sites)`}
          rows={s.blockedPlaces.slice(0, 20)} empty="None in this period. (Counted from 5 October 2026.)"
          cols={[["Place", r => `${flag(r.country)} ${r.city}`], ["Site", r => r.site === "trade" ? "Trade" : "Store"], ["Tries", r => r.n, 1], ["Last", r => new Date(r.last).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }), 1]]} />

        <div style={{ display: "grid", gridTemplateColumns: mob() ? "1fr" : "1fr 1fr", gap: 14 }}>
          <Table title="Where visits come from" rows={s.sources.slice(0, 12)} cols={[["Source", r => r.k], ["Visits", r => r.visits, 1], ["Carts", r => r.carts, 1], ["Bought", r => r.buys, 1], ["Cart rate", r => pct(r.carts, r.visits), 1]]} />
          <Table title="Where visitors are" rows={s.places.slice(0, 12)} cols={[["Place", r => `${flag(r.country)} ${place(r)}`], ["Visits", r => r.visits, 1], ["Carts", r => r.carts, 1], ["Bought", r => r.buys, 1]]} />
          <Table title="Most viewed pieces" rows={s.products} cols={[["Piece", r => <a href={`${site}/products/${r.handle}`} target="_blank" rel="noreferrer" style={{ color: C.ink }}>{r.title}</a>], ["Views", r => r.views, 1], ["Carts", r => r.carts, 1]]} />
          <Table title="Devices" rows={s.devices} cols={[["Device", r => r.k], ["Visits", r => r.visits, 1], ["Cart rate", r => pct(r.carts, r.visits), 1]]} />
        </div>

        <div style={{ ...card, padding: "12px 14px" }}>
          <div style={{ ...lab, marginBottom: 8 }}>Visits · newest first · tap one to see what they did</div>
          {!s.visits.length && <div style={{ fontSize: 12.5, color: C.inkFaint }}>No visits in this period yet.</div>}
          {s.visits.slice(0, 150).map(v => {
            const id = who[v.vid], isOpen = open === v.sid;
            const others = s.visits.filter(o => o.vid === v.vid && o.sid !== v.sid);
            const acts = v.events.filter(e => e.type !== "view");
            return (
              <div key={v.sid} style={{ borderTop: `1px solid ${C.border}` }}>
                <div onClick={() => setOpen(isOpen ? null : v.sid)} style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 13, padding: "8px 0", cursor: "pointer", flexWrap: "wrap" }}>
                  <span style={{ fontSize: 16 }}>{flag(v.country)}</span>
                  <span style={{ minWidth: 150, flex: "1 1 150px" }}>{id ? <b>{id.name || id.email}</b> : place(v)}{id ? <span style={{ color: C.inkFaint }}> · {place(v)}</span> : ""}</span>
                  <span style={{ color: C.inkMid, minWidth: 110 }}>{v.source}{v.campaign ? ` · ${v.campaign}` : ""}</span>
                  <span style={{ color: C.inkMid }}>{v.events.filter(e => e.type === "view").length} pages · {dur(new Date(v.end) - new Date(v.start))}</span>
                  {acts.length > 0 && <span style={{ fontSize: 12 }}>{[...new Set(acts.map(e => ACTION[e.type]?.split(" ")[0]))].join(" ")}</span>}
                  <span style={{ color: C.inkFaint, fontSize: 12, marginLeft: "auto" }}>{range === "today" ? time(v.start) : `${day(v.start)} ${time(v.start)}`}</span>
                </div>
                {isOpen && (
                  <div style={{ background: C.card, borderRadius: 8, padding: "10px 12px", marginBottom: 10, fontSize: 12.5, display: "grid", gap: 6 }}>
                    <div style={{ color: C.inkMid }}>
                      {v.device} · {v.os} · {v.browser}{v.lang ? ` · ${v.lang}` : ""} · {place(v)}{v.region ? ` (${v.region})` : ""}
                      {v.referrer ? <> · came from <span title={v.referrer}>{v.referrer.replace(/^https?:\/\//, "").slice(0, 60)}</span></> : ""}
                    </div>
                    {id && <div>{id.name && <b>{id.name}</b>} {id.email && <a href={`mailto:${id.email}`} style={{ color: C.ink }}>{id.email}</a>}</div>}
                    {others.length > 0 && <div style={{ color: C.inkMid }}>Also visited {others.length} other time{others.length === 1 ? "" : "s"} in this period (first from {others.at(-1).source}, {day(others.at(-1).start)}).</div>}
                    <div style={{ display: "grid", gap: 3, marginTop: 4 }}>
                      {v.events.map((e, i) => {
                        const next = v.events.slice(i + 1).find(x => x.type === "view");
                        return (
                          <div key={e.id} style={{ display: "flex", gap: 10 }}>
                            <span style={{ color: C.inkFaint, width: 44, flexShrink: 0 }}>{time(e.at)}</span>
                            {e.type === "view"
                              ? <span style={{ flex: 1 }}><a href={`${site}${e.path}`} target="_blank" rel="noreferrer" style={{ color: C.ink }}>{pageName(e)}</a>{next ? <span style={{ color: C.inkFaint }}> · {dur(new Date(next.at) - new Date(e.at))}</span> : ""}</span>
                              : <b style={{ flex: 1 }}>{ACTION[e.type] || e.type}{e.data?.title ? ` — ${e.data.title}` : ""}{e.data?.total ? ` · ${e.data.total} ${String(e.data.currency || "").toUpperCase()}` : ""}</b>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div style={{ fontSize: 11.5, color: C.inkFaint, lineHeight: 1.5 }}>
          Places come from the visitor's internet connection: the country is reliable, the city approximate, and a VPN shows the VPN's location. Names and emails show only for visitors who joined the list or bought. Visitors in the UK and EU are counted only if they agree.
        </div>
      </>}
    </div>
  );
}
