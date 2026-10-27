/* Etsy listings that have come off the shop, and the ones about to: one at a
   time, with what each has done — how long it's been up, what it has sold
   over its life and lately, how many people favourited it — and a suggestion,
   so renewing is a decision rather than a reflex. Renew goes through the same
   listing steps as a new piece (where it goes, its stock card, prices, then
   publish), so it goes back up checked and tied to its stock. Skip is
   remembered, so a piece passed over once doesn't keep coming back. */
import { useEffect, useMemo, useRef, useState } from "react";
import { C, mob } from "./lmTheme.js";
import { loadK, upsertItemK, deleteItemK } from "./utils.js";

export const RENEWALS_KEY = "ng-etsy-renewals-v1";   // [{ id: Etsy listing id, decision: "skip" | "renewed", at, by, title }]
const QUEUE_CACHE = "ng-renew-queue-v1";
const STATS_CACHE = "ng-renew-stats-v1";
const QUEUE_FRESH_MS = 30 * 60 * 1000;
// An expired listing can't sell, so what it sold is final; one still on sale can.
const STATS_TTL = { expired: 7 * 86400000, active: 12 * 3600000 };
const RENEW_USD = 0.2;
const DAY = 86400000;
const BATCH = 20;
const PAGE = 30;
const serif = "'Cormorant Garamond',Georgia,serif";

const readJSON = k => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } };
const writeJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const inr = v => `₹${Math.round(+v || 0).toLocaleString("en-IN")}`;
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const span = ms => {
  const d = Math.abs(ms) / DAY;
  if (d < 1) return "today";
  if (d < 2) return "1 day";
  if (d < 45) return `${Math.round(d)} days`;
  if (d < 365) return `${Math.round(d / 30.4)} months`;
  const y = Math.floor(d / 365), m = Math.round((d - y * 365) / 30.4);
  return `${y} yr${m ? ` ${m} mo` : ""}`;
};
const ago = ms => Math.abs(ms) < DAY ? "today" : `${span(ms)} ago`;
const when = ts => ts ? new Date(ts * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";
const customOrder = t => /^(custom (order|listing)|reserved\b|made for\b)/i.test(String(t || "").trim());

/* The stock card's count, by whichever measure it has. Nothing left on the
   card is the one thing that makes renewing pointless outright. */
const cardEmpty = card => card && !(+card.qty > 0) && !(+card.qty2 > 0);

/* Renew / maybe / skip, with the reason in words. Cheap either way — four
   more months is $0.20 — so the bar to renew is low; the clear skips are a
   piece with nothing left to sell, a one-off made for one buyer, and a year
   on the shop without a single sale or much interest. */
function verdict(row, st, card, nowMs) {
  if (customOrder(row.title)) return { v: "skip", why: "A custom order — made for one buyer" };
  if (cardEmpty(card)) return { v: "skip", why: `Its stock card (${card.sku || card.material || "linked"}) is empty` };
  if (!st) return { v: "", why: "Reading its sales…" };
  if (st.error) return { v: "", why: `Couldn't read its sales — ${st.error}` };
  const ageDays = (nowMs - row.first * 1000) / DAY;
  if (st.u120 > 0) return { v: "renew", why: `Sold ${st.u120} in its last four months` };
  if (st.u365 > 0) return { v: "renew", why: `Sold ${st.u365} in the last year` };
  if (st.units >= 2) return { v: "renew", why: `Sold ${st.units} since it was first listed` };
  if (row.favs >= 10) return { v: "renew", why: `${row.favs} favourites — people keep saving it` };
  if (row.state === "active" && row.views >= 30 * Math.max(1, ageDays / 30.4)) return { v: "renew", why: `${row.views} views — it gets looked at` };
  if (st.units === 1) return { v: "maybe", why: `One sale, ${ago(nowMs - st.last * 1000)}` };
  if (ageDays >= 365 && row.favs < 3) return { v: "skip", why: `${span(ageDays * DAY)} on Etsy, never sold` };
  if (row.favs >= 3) return { v: "maybe", why: `${row.favs} favourites, no sale yet` };
  return { v: "maybe", why: `${span(ageDays * DAY)} up, no sale yet` };
}
const TONE = {
  renew: { label: "Renew", fg: "var(--c-green)", bg: "var(--c-greenBg)" },
  maybe: { label: "Maybe", fg: "var(--c-amber)", bg: "var(--c-amberBg)" },
  skip:  { label: "Skip",  fg: "var(--c-inkMid)", bg: "var(--c-card)" },
  "":    { label: "…",     fg: "var(--c-inkFaint)", bg: "var(--c-card)" },
};

export default function RenewalQueue({ listings = [], stock = [], getToken, onRenew, showToast, who = "", onCount }) {
  const [queue, setQueue] = useState(() => readJSON(QUEUE_CACHE));     // { at, data }
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [stats, setStats] = useState(() => readJSON(STATS_CACHE) || {});   // id → { …, at }
  const [statsErr, setStatsErr] = useState("");
  const [decisions, setDecisions] = useState([]);
  const [view, setView] = useState("expired");      // expired | ending | skipped | renewed
  const [sort, setSort] = useState("recent");       // recent | best
  const [only, setOnly] = useState("all");          // all | renew | maybe | skip
  const [shown, setShown] = useState(PAGE);
  const [opening, setOpening] = useState("");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const etsyFetch = async url => {
    const tok = getToken ? await getToken() : null;
    const r = await fetch(url, { headers: tok ? { "X-Etsy-Token": tok } : {}, cache: "no-store" });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) throw new Error(d.error || `Etsy didn't answer (${r.status})`);
    return d;
  };

  const loadQueue = async force => {
    if (!force && queue && Date.now() - queue.at < QUEUE_FRESH_MS) return;
    setLoading(true); setErr("");
    try {
      const d = await etsyFetch(`/api/etsy?action=renewal_queue&_=${Date.now()}`);
      const next = { at: Date.now(), data: d };
      if (alive.current) setQueue(next);
      writeJSON(QUEUE_CACHE, next);
    } catch (e) { if (alive.current) setErr(e.message || "Couldn't reach Etsy"); }
    if (alive.current) setLoading(false);
  };
  useEffect(() => { loadQueue(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadK(RENEWALS_KEY).then(v => { if (alive.current && Array.isArray(v)) setDecisions(v); }).catch(() => {}); }, []);

  const data = queue?.data;
  const loadedAt = queue?.at || 0;
  const nowMs = Date.now();

  /* The ERP's own listing for each Etsy one, and its stock card: by the Etsy
     id the listing carries, else by the SKU Etsy holds. */
  const erpByEtsy = useMemo(() => new Map(listings.filter(l => l?.platforms?.etsy?.listing_id).map(l => [String(l.platforms.etsy.listing_id), l])), [listings]);
  const stockById = useMemo(() => new Map(stock.map(s => [s.id, s])), [stock]);
  const stockBySku = useMemo(() => new Map(stock.filter(s => s?.sku).map(s => [String(s.sku).trim().toLowerCase(), s])), [stock]);
  const erpOf = row => erpByEtsy.get(row.id) || null;
  const cardOf = row => {
    const e = erpOf(row);
    return (e?.linked_stock_id && stockById.get(e.linked_stock_id)) || (row.sku && stockBySku.get(row.sku.trim().toLowerCase())) || null;
  };

  /* Put back up since the queue was read: renewed through the listing steps
     (the ERP listing went active, or took auto-renew, after the read). */
  const doneHere = row => {
    const e = erpOf(row);
    if (!e || !(Date.parse(e.updated_at || "") > loadedAt) || e.platforms?.etsy?.status !== "active") return false;
    return row.state === "expired" ? true : !!e.etsy_auto_renew;
  };
  const decided = useMemo(() => new Map(decisions.map(d => [String(d.id), d])), [decisions]);

  // Recorded once, so the Renewed list still knows it after the queue is read again.
  useEffect(() => {
    if (!data) return;
    for (const row of [...(data.expired || []), ...(data.ending || [])]) {
      if (!doneHere(row) || decided.get(row.id)?.decision === "renewed") continue;
      record({ id: row.id, decision: "renewed", at: new Date().toISOString(), by: who, title: row.title });
    }
  }, [listings, data]); // eslint-disable-line react-hooks/exhaustive-deps

  const record = item => {
    setDecisions(list => [item, ...list.filter(x => String(x.id) !== String(item.id))]);
    return upsertItemK(RENEWALS_KEY, item, { prepend: true });
  };
  const skip = async row => {
    try { await record({ id: row.id, decision: "skip", at: new Date().toISOString(), by: who, title: row.title, ends: row.ends }); }
    catch (e) {
      setDecisions(list => list.filter(x => String(x.id) !== row.id));
      showToast?.(`⚠ Couldn't save the skip: ${e.message}`);
    }
  };
  const unskip = async id => {
    const was = decisions;
    setDecisions(list => list.filter(x => String(x.id) !== String(id)));
    try { await deleteItemK(RENEWALS_KEY, String(id)); }
    catch (e) { setDecisions(was); showToast?.(`⚠ Couldn't bring it back: ${e.message}`); }
  };

  const allRows = useMemo(() => data ? [...(data.expired || []), ...(data.ending || [])] : [], [data]);
  const rowById = useMemo(() => new Map(allRows.map(r => [r.id, r])), [allRows]);
  const open = row => !decided.has(row.id) && !doneHere(row);
  // Ending ones that renew themselves already need nothing.
  const lists = useMemo(() => ({
    expired: (data?.expired || []).filter(open),
    ending: (data?.ending || []).filter(r => !r.auto && open(r)),
    skipped: decisions.filter(d => d.decision === "skip"),
    renewed: decisions.filter(d => d.decision === "renewed"),
  }), [data, decisions, listings]); // eslint-disable-line react-hooks/exhaustive-deps
  const autoCount = (data?.ending || []).filter(r => r.auto).length;
  useEffect(() => { if (data) onCount?.(lists.expired.length + lists.ending.length); }, [lists, data]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Read recently enough. One Etsy couldn't answer for is left a few minutes
     before it's asked again, so a bad listing can't hold the batches in a loop. */
  const fresh = row => {
    const s = stats[row.id];
    if (!s) return false;
    const age = Date.now() - (s.at || 0);
    return s.error ? age < 10 * 60000 : age < STATS_TTL[row.state === "active" ? "active" : "expired"];
  };

  /* Sales are one Etsy request per listing, so they're read in batches: the
     rows on screen first, then the rest of the list in the background while
     this tab is open (sorting by best seller needs them all). Kept on this
     device, so the next visit has them. A batch's answer is kept whatever the
     screen did meanwhile — it's filed by listing id. */
  const work = view === "expired" || view === "ending" ? lists[view] : [];
  const missing = work.filter(r => !fresh(r) && !customOrder(r.title));
  const statsFlight = useRef(false);
  const [statsBusy, setStatsBusy] = useState(false);
  useEffect(() => {
    if (statsFlight.current || !missing.length || statsErr) return;
    const onScreen = new Set(work.slice(0, shown).map(r => r.id));
    const batch = [...missing.filter(r => onScreen.has(r.id)), ...missing.filter(r => !onScreen.has(r.id))].slice(0, BATCH);
    statsFlight.current = true;
    setStatsBusy(true);
    etsyFetch(`/api/etsy?action=renewal_stats&ids=${batch.map(r => r.id).join(",")}&_=${Date.now()}`)
      .then(d => {
        if (!alive.current) return;
        const at = Date.now();
        setStats(prev => {
          const next = { ...prev };
          for (const [id, s] of Object.entries(d.stats || {})) next[id] = { ...s, at };
          // Only what this queue still holds is worth keeping on the device.
          writeJSON(STATS_CACHE, Object.fromEntries(Object.entries(next).filter(([id, s]) => rowById.has(id) && !s.error)));
          return next;
        });
      })
      .catch(e => { if (alive.current) setStatsErr(e.message || "Couldn't read sales"); })
      .finally(() => { statsFlight.current = false; if (alive.current) setStatsBusy(false); });
  }, [missing.length, statsBusy, statsErr, view, shown, data]); // eslint-disable-line react-hooks/exhaustive-deps

  const judged = useMemo(() => work.map(row => {
    const st = stats[row.id], card = cardOf(row);
    return { row, st, card, erp: erpOf(row), ...verdict(row, st, card, nowMs) };
  }), [work, stats, stock, listings]); // eslint-disable-line react-hooks/exhaustive-deps
  const counts = judged.reduce((m, j) => (m[j.v] = (m[j.v] || 0) + 1, m), {});
  // Recent sales count most, but a listing that has sold for years isn't buried under one good month.
  const rank = j => (j.st?.u120 || 0) * 1000 + (j.st?.u365 || 0) * 100 + (j.st?.units || 0) * 10 + (j.row.favs || 0) / 10;
  const visible = judged
    .filter(j => only === "all" || j.v === only)
    .sort((a, b) => sort === "best" ? rank(b) - rank(a) || b.row.ends - a.row.ends
      : view === "ending" ? a.row.ends - b.row.ends : b.row.ends - a.row.ends);

  const renew = async j => {
    setOpening(j.row.id);
    try { await onRenew(j.row); }
    catch (e) { showToast?.(`⚠ Couldn't open it: ${e.message}`, 8000); }
    if (alive.current) setOpening("");
  };

  const chip = (key, label, n) => (
    <button key={key} type="button" onClick={() => { setView(key); setShown(PAGE); setOnly("all"); }}
      style={{ padding: "7px 13px", borderRadius: 20, fontSize: 12.5, fontWeight: view === key ? 800 : 600, cursor: "pointer", whiteSpace: "nowrap",
        border: `1.5px solid ${view === key ? C.ink : C.border}`, background: view === key ? C.ink : C.surface, color: view === key ? "#FAF0DC" : C.ink }}>
      {label}{n != null ? ` · ${n}` : ""}
    </button>
  );
  const small = { fontSize: 11.5, color: C.inkFaint };
  const pill = (active, onClick, children) => (
    <button type="button" onClick={onClick} style={{ border: "none", background: active ? C.card : "transparent", color: active ? C.ink : C.inkMid, fontWeight: active ? 800 : 600, fontSize: 12, padding: "5px 10px", borderRadius: 7, cursor: "pointer" }}>{children}</button>
  );

  const statsRead = work.length - missing.length;

  return (
    <div>
      {/* heading */}
      <div style={{ display: "flex", alignItems: "flex-end", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <div style={{ fontFamily: serif, fontSize: 28, color: C.ink, lineHeight: 1.1 }}>Renew on Etsy</div>
          <div style={{ fontSize: 12.5, color: C.inkMid, marginTop: 4, lineHeight: 1.5 }}>
            An Etsy listing runs four months. Renewing an expired one costs ${RENEW_USD.toFixed(2)} and puts it back for another four — it goes through the listing steps first, so it's checked and tied to its stock card.
            {" "}For one about to end, Renew turns on auto-renew so Etsy renews it when it ends.
          </div>
        </div>
        <div style={{ ...small, textAlign: "right" }}>
          {loading ? "Reading Etsy…" : loadedAt ? `Read ${nowMs - loadedAt < 3600000 ? `${Math.max(1, Math.round((nowMs - loadedAt) / 60000))} min` : `${Math.round((nowMs - loadedAt) / 3600000)} h`} ago` : ""}
          {" "}<button type="button" onClick={() => loadQueue(true)} disabled={loading} style={{ marginLeft: 6, border: `1px solid ${C.border}`, background: C.surface, color: C.ink, borderRadius: 7, padding: "5px 10px", fontSize: 12, fontWeight: 700, cursor: loading ? "wait" : "pointer" }}>↻ Refresh</button>
        </div>
      </div>

      {err && <div style={{ background: C.redBg, color: C.red, borderRadius: 10, padding: "10px 14px", fontSize: 13, marginBottom: 12 }}>⚠ Couldn't read the listings from Etsy — {err}</div>}
      {!data && loading && <div style={{ padding: 40, textAlign: "center", color: C.inkMid, fontSize: 13 }}>Reading expired and ending listings from Etsy… (a few seconds)</div>}

      {data && <>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          {chip("expired", "Expired", lists.expired.length)}
          {chip("ending", `Ending in ${data.days} days`, lists.ending.length)}
          {chip("skipped", "Skipped", lists.skipped.length)}
          {chip("renewed", "Renewed", lists.renewed.length)}
        </div>

        {(view === "expired" || view === "ending") && <>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
            <span style={{ ...small, marginRight: 2 }}>Suggested</span>
            {pill(only === "all", () => setOnly("all"), `All ${work.length}`)}
            {pill(only === "renew", () => setOnly("renew"), `Renew ${counts.renew || 0}`)}
            {pill(only === "maybe", () => setOnly("maybe"), `Maybe ${counts.maybe || 0}`)}
            {pill(only === "skip", () => setOnly("skip"), `Skip ${counts.skip || 0}`)}
            <div style={{ flex: 1 }} />
            <span style={{ ...small, marginRight: 2 }}>Order</span>
            {pill(sort === "recent", () => setSort("recent"), view === "ending" ? "Ending soonest" : "Ended most recently")}
            {pill(sort === "best", () => setSort("best"), "Best sellers first")}
          </div>
          <div style={{ ...small, marginBottom: 12 }}>
            {view === "expired"
              ? `${plural(data.counts?.expired || 0, "expired listing")} on Etsy · the last ${data.back} days shown`
              : `${plural(data.counts?.ending || 0, "listing")} ending in ${data.days} days${autoCount ? ` · ${autoCount} already auto-renew` : ""}`}
            {" · "}{missing.length ? `sales read for ${statsRead} of ${work.length}${statsBusy ? "…" : ""}` : "sales read for all"}
            {counts.renew ? ` · renewing the ${counts.renew} suggested ≈ $${(counts.renew * RENEW_USD).toFixed(2)}` : ""}
            {view === "expired" ? " · Etsy shows no views for a listing once it has expired" : ""}
          </div>
          {statsErr && <div style={{ background: C.amberBg, color: C.amber, borderRadius: 10, padding: "8px 12px", fontSize: 12.5, marginBottom: 10 }}>
            ⚠ Sales stopped loading — {statsErr} <button type="button" onClick={() => setStatsErr("")} style={{ marginLeft: 6, border: "none", background: "none", color: C.ink, fontWeight: 800, cursor: "pointer", textDecoration: "underline" }}>Try again</button>
          </div>}

          {!visible.length && <div style={{ padding: 36, textAlign: "center", color: C.inkMid, fontSize: 13 }}>
            {work.length ? "Nothing with that suggestion." : view === "expired" ? "Nothing expired to look at." : "Nothing ending without auto-renew."}
          </div>}

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {visible.slice(0, shown).map(j => <Row key={j.row.id} j={j} nowMs={nowMs} opening={opening === j.row.id} onRenew={() => renew(j)} onSkip={() => skip(j.row)} />)}
          </div>
          {visible.length > shown && <button type="button" onClick={() => setShown(n => n + PAGE)}
            style={{ display: "block", margin: "14px auto 0", border: `1px solid ${C.border}`, background: C.surface, color: C.ink, borderRadius: 9, padding: "10px 18px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
            Show {Math.min(PAGE, visible.length - shown)} more · {visible.length - shown} left</button>}
        </>}

        {(view === "skipped" || view === "renewed") && (
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12 }}>
            {!lists[view].length && <div style={{ padding: 24, textAlign: "center", color: C.inkMid, fontSize: 13 }}>{view === "skipped" ? "Nothing skipped." : "Nothing renewed from here yet."}</div>}
            {lists[view].map((d, i) => {
              const row = rowById.get(String(d.id));
              return (
                <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 14px", borderTop: i ? `1px solid ${C.border}` : "none" }}>
                  {row?.img ? <img src={row.img} alt="" style={{ width: 40, height: 40, borderRadius: 7, objectFit: "cover", flex: "none" }} /> : <div style={{ width: 40, height: 40, borderRadius: 7, background: C.card, flex: "none" }} />}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <a href={row?.url || `https://www.etsy.com/listing/${d.id}`} target="_blank" rel="noreferrer" style={{ fontSize: 13.5, fontWeight: 700, color: C.ink, textDecoration: "none", display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{d.title || row?.title || d.id}</a>
                    <div style={small}>{view === "skipped" ? "Skipped" : "Renewed"} {new Date(d.at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}{d.by ? ` by ${d.by}` : ""}{row ? ` · ${row.state === "expired" ? `ended ${when(row.ends)}` : `ends ${when(row.ends)}`}` : ""}</div>
                  </div>
                  {view === "skipped" && <button type="button" onClick={() => unskip(d.id)} style={{ border: `1px solid ${C.border}`, background: C.surface, color: C.ink, borderRadius: 8, padding: "6px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>Back to the queue</button>}
                </div>
              );
            })}
          </div>
        )}
      </>}
    </div>
  );
}

function Row({ j, nowMs, opening, onRenew, onSkip }) {
  const { row, st, card, erp, v, why } = j;
  const phone = mob();
  const tone = TONE[v] || TONE[""];
  const expired = row.state === "expired";
  const ageMs = nowMs - row.first * 1000;
  // A draft published days after it was made moves the date too; that isn't a renewal.
  const renewedBefore = row.renewed > row.first + 30 * 86400;
  const none = !st && v ? "—" : "…";   // no sales to read (a custom order, an empty card) vs still reading
  const stat = (big, label, title) => (
    <div title={title} style={{ minWidth: 0 }}>
      <div style={{ fontFamily: serif, fontVariantNumeric: "lining-nums", fontSize: 21, color: C.ink, lineHeight: 1.1 }}>{big}</div>
      <div style={{ fontSize: 10.5, color: C.inkFaint, marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</div>
    </div>
  );
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderLeft: `3px solid ${tone.fg}`, borderRadius: 12, padding: phone ? 12 : "12px 16px", display: "flex", gap: 14, flexDirection: phone ? "column" : "row", alignItems: phone ? "stretch" : "center" }}>
      <div style={{ display: "flex", gap: 12, flex: 1, minWidth: 0 }}>
        <a href={row.url} target="_blank" rel="noreferrer" style={{ flex: "none" }}>
          {row.img ? <img src={row.img} alt="" style={{ width: 76, height: 76, borderRadius: 9, objectFit: "cover", background: C.card }} />
            : <div style={{ width: 76, height: 76, borderRadius: 9, background: C.card }} />}
        </a>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: ".04em", color: tone.fg, background: tone.bg, borderRadius: 6, padding: "2px 8px", flex: "none" }}>{tone.label}</span>
            <span style={{ fontSize: 12, color: v ? C.ink : C.inkFaint, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{why}</span>
          </div>
          <a href={row.url} target="_blank" rel="noreferrer" style={{ display: "block", fontSize: 14, fontWeight: 700, color: C.ink, textDecoration: "none", marginTop: 5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{row.title}</a>
          <div style={{ fontSize: 11.5, color: C.inkMid, marginTop: 3 }}>
            {expired ? `Ended ${ago(nowMs - row.ends * 1000)}` : row.ends * 1000 - nowMs < DAY ? "Ends today" : `Ends in ${span(row.ends * 1000 - nowMs)}`}
            {` · ${inr(row.price)}${row.variations ? " and up" : ""} · ${row.qty} left`}
            {renewedBefore ? ` · last renewed ${when(row.renewed)}` : ""}
          </div>
          <div style={{ fontSize: 11.5, marginTop: 3, color: card ? C.inkMid : C.amber, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {card ? `📦 ${card.sku || card.material || "Stock card"} · ${card.qty || 0} ${card.unit || ""}${+card.qty2 ? ` / ${card.qty2} ${card.unit2 || ""}` : ""}${card.location ? ` · 📍 ${card.location}` : ""}`
              : erp ? "In the ERP, not tied to a stock card — the steps ask for it" : "Not in the ERP yet — the steps tie it to its stock card"}
          </div>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10, width: phone ? "100%" : 330, flex: "none" }}>
        {stat(span(ageMs), "since first listed", `First listed ${when(row.first)}`)}
        {stat(st && !st.error ? st.units : none, st && !st.error ? `sold · ${st.u365} this yr` : "sold", st && !st.error ? `${st.orders} order${st.orders === 1 ? "" : "s"} · ${inr(st.revenue)} over its life · ${st.u120} in the last four months${st.last ? ` · last sold ${when(st.last)}` : ""}` : "")}
        {stat(st && !st.error ? (st.last ? span(nowMs - st.last * 1000) : "never") : none, st?.last ? "since last sale" : "last sale", st?.last ? when(st.last) : "")}
        {stat(row.favs, expired ? "favourites" : `♥ · ${row.views ?? "—"} views`, expired ? "Etsy doesn't report views once a listing has expired" : "")}
      </div>
      <div style={{ display: "flex", gap: 8, flexDirection: phone ? "row" : "column", flex: "none", width: phone ? "100%" : 128 }}>
        <button type="button" onClick={onRenew} disabled={opening}
          style={{ flex: 1, padding: "10px 12px", borderRadius: 9, border: "none", background: C.ink, color: "#FAF0DC", fontWeight: 800, fontSize: 13, cursor: opening ? "wait" : "pointer" }}>
          {opening ? "Opening…" : expired ? "Renew →" : "Keep it up →"}</button>
        <button type="button" onClick={onSkip}
          style={{ flex: 1, padding: "9px 12px", borderRadius: 9, border: `1px solid ${C.border}`, background: C.surface, color: C.inkMid, fontWeight: 700, fontSize: 12.5, cursor: "pointer" }}>Skip</button>
      </div>
    </div>
  );
}
