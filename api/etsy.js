import { requireUser, hasStoreSecret } from "../lib/auth.js";
import { getEtsyAccessToken, etsyAuthHandler } from "../lib/etsy-auth.js";

export const maxDuration = 45; // Vercel Pro: allow up to 45s for multi-page listing fetches

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Etsy-Token");
  if (req.method === "OPTIONS") return res.status(200).end();
  // /api/etsy-auth is rewritten here (vercel.json) so the Etsy OAuth redirect URI and
  // every existing /api/etsy-auth?action=… caller keep working, on one function
  // instead of two. Checked before this file's own `action` routing so the two
  // action namespaces can never collide.
  // Only the consent start and Etsy's own callback (?code=…, no action) are open;
  // get-session / refresh / invalidate hand out or drop the shop token.
  if (req.query?._oauth !== undefined) {
    if (req.query.action && req.query.action !== "start" && !(await requireUser(req, res))) return;
    return etsyAuthHandler(req, res);
  }
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  // Reviews for eartheditions.co, for the store's server only (store secret).
  // Text, stars and dates; nothing that names or links the Etsy shop.
  if (req.query?.action === "store_reviews") return hasStoreSecret(req) ? storeReviews(res) : res.status(401).json({ error: "Unauthorized" });
  if (!(await requireUser(req, res))) return;

  // x-api-key must be keystring:sharedsecret for Etsy API v3
  const key = process.env.ETSY_API_KEY ||
    (process.env.ETSY_KEYSTRING && process.env.ETSY_SHARED_SECRET
      ? `${process.env.ETSY_KEYSTRING}:${process.env.ETSY_SHARED_SECRET}`
      : process.env.ETSY_KEYSTRING);

  // Etsy token: prefer client-provided (frontend manages refresh lifecycle),
  // fall back to the stored one. Authorization carries the ERP session, not Etsy's.
  const clientToken = req.headers["x-etsy-token"] || null;
  const token = clientToken || await getEtsyAccessToken();

  const defaultShopId = process.env.ETSY_SHOP_ID;

  const readJsonish = async response => {
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { text, data };
  };

  const etsyMessage = data => data?.error || data?.message || data?.detail || data?.raw || "Etsy API error";

  if (!key) {
    return res.status(500).json({
      error: "ETSY_KEYSTRING / ETSY_API_KEY not set.",
      setup: "Add ETSY_KEYSTRING and ETSY_SHARED_SECRET to your env vars."
    });
  }

  const { action, shop_id, limit = "50", offset = "0", min_created, receipt_id, enrich = "true", enrich_limit = "150" } = req.query;
  const sid = shop_id || defaultShopId;

  // Public endpoints only need x-api-key. Authenticated endpoints also need Bearer.
  const pubHeaders  = { "x-api-key": key };
  const authHeaders = token
    ? { "x-api-key": key, Authorization: `Bearer ${token}` }
    : pubHeaders;

  try {
    // ── ping: verify API key (public endpoint) ─────────────────────────────────
    if (action === "ping") {
      const r = await fetch("https://openapi.etsy.com/v3/application/openapi-ping", { headers: pubHeaders });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ ok: false, error: data.error || "Auth failed", details: data });
      return res.json({
        ok: true,
        api_key_valid: true,
        has_oauth_token: !!token,
        message: token
          ? "✓ API key valid + OAuth token present — ready to sync orders"
          : "✓ API key valid — but no OAuth token yet. Visit /api/etsy-auth?action=start to connect your shop",
        data
      });
    }

    if (!sid) return res.status(400).json({ error: "shop_id required (or set ETSY_SHOP_ID env var)" });

    // ── shop: fetch shop info (public) ─────────────────────────────────────────
    if (action === "shop") {
      const r = await fetch(`https://openapi.etsy.com/v3/application/shops/${sid}`, { headers: pubHeaders });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data.error || "Etsy API error", details: data });
      return res.json(data);
    }

    // ── orders: list paid receipts (requires OAuth) ────────────────────────────
    if (action === "orders") {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      if (!token) return res.status(401).json({
        error: "OAuth token required to read orders.",
        fix: "Visit /api/etsy-auth?action=start to authorize your shop."
      });
      const pageLimit = String(Math.min(100, Math.max(1, parseInt(limit, 10) || 100)));
      const fetchPage = async pageOffset => {
        const p = new URLSearchParams({
          was_paid: "true",
          limit: pageLimit,
          offset: String(pageOffset),
          sort_on: "created",
          sort_order: "desc",
        });
        p.append("includes[]", "Transactions");
        if (min_created) p.set("min_created", min_created);
        return fetch(`https://openapi.etsy.com/v3/application/shops/${sid}/receipts?${p}`, { headers: authHeaders });
      };
      const first = await fetchPage(parseInt(offset, 10) || 0);
      const data = await first.json();
      if (!first.ok) return res.status(first.status).json({ error: data.error || "Etsy API error", details: data });
      const results = [...(data.results || [])];
      const count = data.count || results.length;
      const startOffset = parseInt(offset, 10) || 0;
      const maxPages = Math.min(10, Math.ceil(Math.max(0, count - startOffset) / (+pageLimit || 100)));
      for (let page = 1; page < maxPages; page++) {
        const r = await fetchPage(startOffset + page * (+pageLimit || 100));
        if (!r.ok) break;
        const d = await r.json();
        results.push(...(d.results || []));
        if (!d.results?.length) break;
      }
      if (String(enrich) !== "false") {
        const needsDetail = receipt => !receipt.buyer_email || !receipt.first_line || !receipt.transactions?.length;
        const detailTargets = results.filter(needsDetail).slice(0, Math.max(0, parseInt(enrich_limit, 10) || 150));
        const detailByReceiptId = {};
        const fetchDetail = async receipt => {
          try {
            const p = new URLSearchParams();
            p.append("includes[]", "Transactions");
            const r = await fetch(`https://openapi.etsy.com/v3/application/shops/${sid}/receipts/${receipt.receipt_id}?${p}`, { headers: authHeaders });
            if (!r.ok) return;
            const d = await r.json();
            detailByReceiptId[String(receipt.receipt_id)] = d;
          } catch {}
        };
        for (let i = 0; i < detailTargets.length; i += 8) {
          await Promise.all(detailTargets.slice(i, i + 8).map(fetchDetail));
        }
        results.forEach((receipt, idx) => {
          const detail = detailByReceiptId[String(receipt.receipt_id)];
          if (!detail) return;
          results[idx] = {
            ...receipt,
            ...detail,
            transactions: detail.transactions?.length ? detail.transactions : receipt.transactions,
          };
        });
      }
      const listingIds = [...new Set(results.flatMap(receipt =>
        (receipt.transactions || [])
          .map(txn => txn?.listing_id)
          .filter(Boolean)
          .map(String)
      ))];
      const imageByListingId = {};
      // Fetch listing images via the BATCH endpoint (up to 100 listings, incl. sold_out, per
      // request). The old one-request-per-listing approach blew past Etsy's 10 req/sec rate limit,
      // so most image calls 429'd and orders showed no thumbnail. One batch call per 100 listings
      // stays well under the limit and is far faster.
      const fetchImageBatch = async ids => {
        try {
          const r = await fetch(`https://openapi.etsy.com/v3/application/listings/batch?listing_ids=${ids.join(",")}&includes=Images`, { headers: authHeaders });
          if (!r.ok) return;
          const d = await r.json();
          (d.results || []).forEach(listing => {
            const imgs = listing?.images || listing?.Images || [];
            const img = [...imgs].sort((a, b) => (a.rank || 0) - (b.rank || 0))[0];
            if (img) {
              imageByListingId[String(listing.listing_id)] = {
                url_570xN: img.url_570xN,
                url_fullxfull: img.url_fullxfull,
                url_170x135: img.url_170x135,
                url_75x75: img.url_75x75,
              };
            }
          });
        } catch {}
      };
      for (let i = 0; i < listingIds.length; i += 100) {
        await fetchImageBatch(listingIds.slice(i, i + 100));
      }
      results.forEach(receipt => {
        (receipt.transactions || []).forEach(txn => {
          const img = imageByListingId[String(txn?.listing_id || "")];
          if (img && !txn.image_data) txn.image_data = img;
        });
      });
      results.sort((a, b) =>
        (b.create_timestamp || b.creation_tsz || b.created_timestamp || b.update_timestamp || 0) -
        (a.create_timestamp || a.creation_tsz || a.created_timestamp || a.update_timestamp || 0)
      );
      return res.json({ ...data, count, results });
    }

    // ── pulse: the home page's Etsy numbers, in one compact call ───────────────
    // ?from=<unix s>      paid receipts created since then (the month-by-month trend)
    // &ads_from=<unix s>  ledger since then, for ad spend
    // Rows come back trimmed and undated-by-calendar: the browser buckets them into
    // its own days and months, so "today" means the same thing as on the screen.
    // Ad spend is read from the payment-account ledger, where Etsy Ads post as
    // `prolist` (a charge a day) and Offsite Ads as `offsite_ads_fee` (one per
    // attributed order). Refunds of either arrive positive, so they net off.
    if (action === "pulse") {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      if (!token) return res.status(401).json({ error: "OAuth token required", fix: "Visit /api/etsy-auth?action=start" });
      const nowS = Math.floor(Date.now() / 1000);
      const from = Math.max(nowS - 400 * 86400, parseInt(req.query.from, 10) || nowS - 62 * 86400);
      const adsFrom = Math.max(nowS - 93 * 86400, parseInt(req.query.ads_from, 10) || nowS - 62 * 86400);
      const money = m => m && m.amount != null ? (+m.amount || 0) / (+m.divisor || 100) : 0;

      const { getJson, allPages } = etsyQueue(authHeaders);

      const receiptsP = allPages(offset => {
        const p = new URLSearchParams({ was_paid: "true", limit: "100", offset: String(offset), min_created: String(from), sort_on: "created", sort_order: "desc" });
        return `https://openapi.etsy.com/v3/application/shops/${sid}/receipts?${p}`;
      });
      // The ledger answers at most 31 days per request.
      const windows = [];
      for (let a = adsFrom; a < nowS; a += 30 * 86400) windows.push([a, Math.min(nowS + 60, a + 30 * 86400)]);
      const ledgerP = Promise.all(windows.map(([a, b]) => allPages(offset =>
        `https://openapi.etsy.com/v3/application/shops/${sid}/payment-account/ledger-entries?min_created=${a}&max_created=${b}&limit=100&offset=${offset}`
      ))).then(chunks => chunks.flat());

      const [rawReceipts, ledgerResult] = await Promise.all([receiptsP, ledgerP.then(rows => ({ rows }), e => ({ error: e.message }))]);

      const VOID = ["canceled", "cancelled", "fully refunded", "fully_refunded"];
      const unshippedListingIds = new Set();
      const seenReceipts = new Set();
      const receipts = [];
      for (const r of rawReceipts) {
        const id = String(r.receipt_id);
        if (seenReceipts.has(id)) continue;
        seenReceipts.add(id);
        const txns = r.transactions || [];
        const status = String(r.status || "").toLowerCase();
        const voided = VOID.includes(status);
        // Sales as Etsy counts them: items after coupons, plus shipping; the tax Etsy
        // collects on the buyer's behalf is not ours. Partial refunds come off.
        const refunded = (r.refunds || []).reduce((s, rf) => s + money(rf.amount), 0);
        const sales = money(r.grandtotal) - money(r.total_tax_cost) - money(r.total_vat_cost) - refunded;
        const row = {
          id,
          ts: +r.create_timestamp || +r.created_timestamp || 0,
          status,
          shipped: !!r.is_shipped,
          sales: voided ? 0 : Math.max(0, Number(sales.toFixed(2))),
          items: txns.reduce((s, t) => s + (+t.quantity || 1), 0) || 1,
          cur: r.grandtotal?.currency_code || "",
        };
        if (!row.shipped && !voided) {
          const shipBys = txns.map(t => +t.expected_ship_date || 0).filter(Boolean);
          row.buyer = r.name || "";
          row.country = r.country_iso || "";
          row.ship_by = shipBys.length ? Math.min(...shipBys) : 0;
          row.gift = !!r.is_gift;
          row.note = r.message_from_buyer ? String(r.message_from_buyer).slice(0, 140) : "";
          row.lines = txns.map(t => ({ title: t.title || "", qty: +t.quantity || 1, listing_id: t.listing_id ? String(t.listing_id) : "" }));
          row.lines.forEach(l => l.listing_id && unshippedListingIds.add(l.listing_id));
        }
        receipts.push(row);
      }

      // Thumbnails for the orders still to ship — one batch call covers them all.
      if (unshippedListingIds.size) {
        try {
          const ids = [...unshippedListingIds].slice(0, 100);
          const d = await getJson(`https://openapi.etsy.com/v3/application/listings/batch?listing_ids=${ids.join(",")}&includes=Images`);
          const img = {};
          for (const l of d.results || []) {
            const first = [...(l.images || [])].sort((a, b) => (a.rank || 0) - (b.rank || 0))[0];
            if (first) img[String(l.listing_id)] = first.url_170x135 || first.url_75x75 || first.url_570xN || "";
          }
          receipts.forEach(r => (r.lines || []).forEach(l => { if (img[l.listing_id]) l.img = img[l.listing_id]; }));
        } catch {}
      }

      const ads = [];
      const seenEntries = new Set();
      for (const e of ledgerResult.rows || []) {
        const type = String(e.ledger_type || "").toLowerCase();
        const kind = type.startsWith("prolist") ? "etsy" : type.startsWith("offsite_ads") ? "offsite" : "";
        if (!kind || seenEntries.has(e.entry_id)) continue;
        seenEntries.add(e.entry_id);
        ads.push({ ts: +e.created_timestamp || +e.create_date || 0, kind, amt: Number((-(+e.amount || 0) / 100).toFixed(2)) });
      }

      return res.json({
        ok: true,
        currency: receipts.find(r => r.cur)?.cur || "",
        from, adsFrom, at: nowS,
        receipts,
        ads,
        ...(ledgerResult.error ? { adsError: ledgerResult.error } : {}),
      });
    }

    // ── listing_pulse: the shop's listings in numbers, for the home page ───────
    // ?from=<unix s>  listings published since then, dated by their listing fee
    // (`published`; see below). `added` is the older count by
    // original_creation_timestamp — when the draft was made — kept as the
    // fallback if the ledger can't be read. A renewal moves created_timestamp,
    // so counting by that would call every renewal a new listing.
    // Never the whole catalog: a listing can't have been first created after its
    // latest renewal, so newest-first pages stop once created_timestamp passes
    // `from`; listings run four months from their last renewal, so oldest-first
    // active pages are the soonest to end and stop past 30 days out.
    if (action === "listing_pulse") {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      if (!token) return res.status(401).json({ error: "OAuth token required", fix: "Visit /api/etsy-auth?action=start" });
      const nowS = Math.floor(Date.now() / 1000);
      const from = Math.max(nowS - 400 * 86400, parseInt(req.query.from, 10) || nowS - 62 * 86400);
      const soon = nowS + 30 * 86400, lately = nowS - 30 * 86400;
      const { getJson, allPages, pagesWhile } = etsyQueue(authHeaders);
      const url = (state, offset, order = "desc", limit = 100) =>
        `https://openapi.etsy.com/v3/application/shops/${sid}/listings?${new URLSearchParams({ state, limit: String(limit), offset: String(offset), sort_on: "created", sort_order: order })}`;
      const sinceFrom = state => pagesWhile(o => url(state, o), last => +last.created_timestamp >= from);
      // The ledger answers at most 31 days per request.
      const windows = [];
      for (let a = from; a < nowS; a += 30 * 86400) windows.push([a, Math.min(nowS + 60, a + 30 * 86400)]);
      const ledgerP = Promise.all(windows.map(([a, b]) => allPages(o =>
        `https://openapi.etsy.com/v3/application/shops/${sid}/payment-account/ledger-entries?min_created=${a}&max_created=${b}&limit=100&offset=${o}`
      ))).then(chunks => ({ rows: chunks.flat() }), e => ({ error: e.message }));
      const [active, soldOut, inactive, ending, expired, draft, ledger] = await Promise.all([
        sinceFrom("active"), sinceFrom("sold_out"), sinceFrom("inactive"),
        pagesWhile(o => url("active", o, "asc"), last => +last.ending_timestamp <= soon),
        pagesWhile(o => url("expired", o), last => +last.ending_timestamp >= lately),
        getJson(url("draft", 0, "desc", 1)),
        ledgerP,
      ]);

      /* Published, not drafted: Etsy charges the $0.20 listing fee the moment a
         listing goes live, against that listing, so the fee record says which
         piece went up and when. A draft has no fee yet, and a renewal is a fee
         of its own kind (renew_expired, renew_sold…), so neither counts.
         feeTypes is what the ledger called its listing fees, for checking. */
      const feeTypes = {};
      const published = [];
      const feeSeen = new Set(), entrySeen = new Set();
      const fees = (ledger.rows || []).map(e => ({ e,
        type: String(e.ledger_type || "").toLowerCase(), ref: String(e.reference_type || "").toLowerCase(),
        ts: +e.created_timestamp || +e.create_date || 0,
      })).filter(({ type, ref }) => (type.includes("listing") || type.includes("renew") || ref === "listing")
        && !/^(prolist|offsite)|tax|vat|gst/.test(type))
        .sort((a, b) => a.ts - b.ts);
      for (const { e, type, ts } of fees) {
        if (entrySeen.has(e.entry_id)) continue;
        entrySeen.add(e.entry_id);
        feeTypes[type || "?"] = (feeTypes[type || "?"] || 0) + 1;
        const id = String(e.reference_id ?? "");
        if (type.includes("renew") || !(+e.amount < 0) || !id || feeSeen.has(id)) continue;
        feeSeen.add(id);
        published.push({ id, ts });
      }
      const publishedFrom = !ledger.error && Object.keys(feeTypes).length ? "ledger" : "";

      // The last week's new pieces with a picture and a title, for the side list.
      let recent = [];
      const recentIds = published.filter(p => p.ts >= nowS - 8 * 86400).slice(-100).map(p => p.id);
      if (recentIds.length) {
        try {
          const d = await getJson(`https://openapi.etsy.com/v3/application/listings/batch?listing_ids=${recentIds.join(",")}&includes=Images`);
          const byId = new Map((d.results || []).map(l => [String(l.listing_id), l]));
          recent = published.filter(p => recentIds.includes(p.id)).map(p => {
            const l = byId.get(p.id);
            const img = l && [...(l.images || [])].sort((a, b) => (a.rank || 0) - (b.rank || 0))[0];
            return { id: p.id, ts: p.ts, title: l ? String(l.title || "").slice(0, 120) : "", state: l?.state || "",
              img: img ? img.url_170x135 || img.url_75x75 || img.url_570xN || "" : "",
              price: l?.price ? (+l.price.amount || 0) / (+l.price.divisor || 100) : 0, cur: l?.price?.currency_code || "" };
          });
        } catch {}
      }

      const seen = new Set();
      const added = [];
      for (const l of [...active.rows, ...soldOut.rows, ...inactive.rows]) {
        if (seen.has(l.listing_id) || !(+l.original_creation_timestamp >= from)) continue;
        seen.add(l.listing_id);
        added.push({ ts: +l.original_creation_timestamp, state: l.state });
      }
      const expiring = ending.rows.filter(l => +l.ending_timestamp <= soon).map(l => ({
        id: String(l.listing_id), title: String(l.title || "").slice(0, 90), ends: +l.ending_timestamp, auto: !!l.should_auto_renew, qty: +l.quantity || 0,
      }));
      const expiredLately = expired.rows.filter(l => +l.ending_timestamp >= lately).map(l => ({ ends: +l.ending_timestamp }));

      return res.json({
        ok: true, from, at: nowS,
        counts: { active: active.count, sold_out: soldOut.count, inactive: inactive.count, expired: expired.count, draft: +draft.count || 0 },
        added, expiring, expiredLately,
        published, publishedFrom, recent, feeTypes,
        ...(ledger.error ? { ledgerError: ledger.error } : {}),
      });
    }

    // ── renewal_queue: listings that have come off the shop, and the ones about to ─
    // For Listing Manager's Renew tab. Expired listings most recently ended first
    // (a listing ends four months after its last renewal, so newest-created is
    // newest-ended), back to ?back=<days> (default 365); active listings ending
    // within ?days=<n> (default 30), soonest first. Each row carries what the
    // renew-or-skip call needs from the listing itself — age, views, favourites —
    // and no description, so a long queue stays a small reply. Sales are a call
    // of their own (renewal_stats): one Etsy request per listing, so they are
    // only asked for the rows on screen.
    if (action === "renewal_queue") {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      if (!token) return res.status(401).json({ error: "OAuth token required", fix: "Visit /api/etsy-auth?action=start" });
      const nowS = Math.floor(Date.now() / 1000);
      const days = Math.min(60, Math.max(1, parseInt(req.query.days, 10) || 30));
      const back = Math.min(1500, Math.max(1, parseInt(req.query.back, 10) || 365));
      const soon = nowS + days * 86400, since = nowS - back * 86400;
      const { getJson, pagesWhile } = etsyQueue(authHeaders);
      const url = (state, offset, order) =>
        `https://openapi.etsy.com/v3/application/shops/${sid}/listings?${new URLSearchParams({ state, limit: "100", offset: String(offset), sort_on: "created", sort_order: order, includes: "Images" })}`;
      // Expired pages are read together once the first says how many there are —
      // one after another took twenty seconds. Twelve pages at most: a queue
      // longer than 1,200 is worked through over weeks, newest first.
      const expiredRows = async () => {
        const first = await getJson(url("expired", 0, "desc"));
        const rows = [...(first.results || [])];
        const count = +first.count || rows.length;
        if (rows.length === 100 && +rows[99].ending_timestamp >= since) {
          const offsets = [];
          for (let o = 100; o < Math.min(count, 1200); o += 100) offsets.push(o);
          (await Promise.all(offsets.map(o => getJson(url("expired", o, "desc"))))).forEach(p => rows.push(...(p.results || [])));
        }
        return { rows, count };
      };
      const [ending, expired] = await Promise.all([
        pagesWhile(o => url("active", o, "asc"), last => +last.ending_timestamp <= soon),
        expiredRows(),
      ]);
      const row = l => {
        const img = [...(l.images || [])].sort((a, b) => (a.rank || 0) - (b.rank || 0))[0];
        return {
          id: String(l.listing_id),
          title: String(l.title || "").slice(0, 140),
          state: l.state,
          ends: +l.ending_timestamp || 0,
          first: +l.original_creation_timestamp || +l.creation_timestamp || 0,
          renewed: +l.created_timestamp || 0,
          views: l.views != null ? +l.views : null,
          favs: +l.num_favorers || 0,
          qty: +l.quantity || 0,
          price: l.price?.amount != null ? (+l.price.amount || 0) / (+l.price.divisor || 100) : 0,
          cur: l.price?.currency_code || "",
          auto: !!l.should_auto_renew,
          sku: (l.skus || [])[0] || "",
          variations: !!l.has_variations,
          img: img ? img.url_170x135 || img.url_570xN || img.url_75x75 || "" : "",
          url: l.url || `https://www.etsy.com/listing/${l.listing_id}`,
        };
      };
      return res.json({
        ok: true, at: nowS, days, back,
        counts: { expired: expired.count, ending: ending.rows.filter(l => +l.ending_timestamp <= soon).length },
        expired: expired.rows.filter(l => +l.ending_timestamp >= since).map(row),
        ending: ending.rows.filter(l => +l.ending_timestamp <= soon).map(row),
      });
    }

    // ── renewal_stats: what each listing has sold, for the renew-or-skip call ──
    // ?ids=1,2,3 (up to 25). Etsy's transactions for one listing — every unit
    // sold through it, whichever receipt it was on. Lifetime, the last four
    // months (one listing term, what a renewal buys) and the last year.
    if (action === "renewal_stats") {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      if (!token) return res.status(401).json({ error: "OAuth token required", fix: "Visit /api/etsy-auth?action=start" });
      const ids = [...new Set(String(req.query.ids || "").split(",").map(s => s.trim()).filter(s => /^\d+$/.test(s)))].slice(0, 25);
      if (!ids.length) return res.status(400).json({ error: "ids required" });
      const nowS = Math.floor(Date.now() / 1000);
      const money = m => m && m.amount != null ? (+m.amount || 0) / (+m.divisor || 100) : 0;
      const { getJson } = etsyQueue(authHeaders);
      const page = (id, offset) => getJson(`https://openapi.etsy.com/v3/application/shops/${sid}/listings/${id}/transactions?limit=100&offset=${offset}`);
      const stats = {};
      await Promise.all(ids.map(async id => {
        try {
          const first = await page(id, 0);
          const txns = [...(first.results || [])];
          const count = +first.count || txns.length;
          // A repeatable piece can pass a hundred sales; read on (to a thousand)
          // rather than guess which end of the list Etsy put the recent ones.
          for (let o = 100; o < Math.min(count, 1000); o += 100) txns.push(...((await page(id, o)).results || []));
          const s = { orders: count, units: 0, revenue: 0, last: 0, u120: 0, u365: 0, cur: "" };
          const seen = new Set();
          for (const t of txns) {
            if (seen.has(t.transaction_id)) continue;
            seen.add(t.transaction_id);
            const ts = +t.created_timestamp || +t.create_timestamp || +t.paid_timestamp || 0;
            const q = +t.quantity || 1;
            s.units += q;
            s.revenue += money(t.price) * q;
            s.cur = s.cur || t.price?.currency_code || "";
            if (ts > s.last) s.last = ts;
            if (ts >= nowS - 120 * 86400) s.u120 += q;
            if (ts >= nowS - 365 * 86400) s.u365 += q;
          }
          s.revenue = Number(s.revenue.toFixed(2));
          if (count > txns.length) s.partial = true;
          stats[id] = s;
        } catch (e) { stats[id] = { error: e.message }; }
      }));
      return res.json({ ok: true, at: nowS, stats });
    }

    // ── renewal_listing: one listing whole, photos included, to pre-fill the form ─
    // The batch endpoint answers for a listing in any state — the single-listing
    // one only for what's on sale — so an expired listing reads back too.
    if (action === "renewal_listing") {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      if (!token) return res.status(401).json({ error: "OAuth token required", fix: "Visit /api/etsy-auth?action=start" });
      const id = String(req.query.listing_id || "").replace(/\D/g, "");
      if (!id) return res.status(400).json({ error: "listing_id required" });
      const { getJson } = etsyQueue(authHeaders);
      const d = await getJson(`https://openapi.etsy.com/v3/application/listings/batch?listing_ids=${id}&includes=Images`);
      const listing = (d.results || [])[0];
      if (!listing) return res.status(404).json({ error: "Etsy has no listing with that id" });
      return res.json({ ok: true, listing });
    }

    // ── receipt: single receipt by ID (requires OAuth) ─────────────────────────
    if (action === "receipt") {
      if (!receipt_id) return res.status(400).json({ error: "receipt_id required" });
      if (!token) return res.status(401).json({ error: "OAuth token required", fix: "Visit /api/etsy-auth?action=start" });
      const r = await fetch(`https://openapi.etsy.com/v3/application/shops/${sid}/receipts/${receipt_id}`, { headers: authHeaders });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data.error || "Etsy API error", details: data });
      return res.json(data);
    }

    // ── payments: gross/fees/net per receipt (requires OAuth) ──────────────────
    // ?receipt_ids=1,2,3 (max 40 per call). Returns { payments: { [receiptId]: {gross,fees,net,currency} } }.
    // Etsy's payment objects are the source of truth for what the seller actually earns —
    // receipt totals don't include processing/transaction fees.
    if (action === "payments") {
      if (!token) return res.status(401).json({ error: "OAuth token required", fix: "Visit /api/etsy-auth?action=start" });
      const ids = String(req.query.receipt_ids || "").split(",").map(s => s.trim()).filter(Boolean).slice(0, 40);
      if (!ids.length) return res.status(400).json({ error: "receipt_ids required" });
      const money = m => m && m.amount != null ? (+m.amount || 0) / (+m.divisor || 100) : null;
      const paymentAmounts = payment => {
        const read = prefix => ["gross", "fees", "net"].map(key => money(payment[`${prefix}_${key}`]));
        const amount = read("amount");
        const posted = read("posted");
        const adjusted = read("adjusted");
        // Etsy presents settled earnings from its posted fields. Adjusted fields take
        // precedence when an order has a later refund or payment adjustment.
        const hasValues = values => values.some(value => value != null);
        const hasAdjustment = adjusted.some(value => Math.abs(value || 0) > 0);
        if (hasAdjustment) return { values: adjusted, source: "adjusted" };
        if (hasValues(posted)) return { values: posted, source: "posted" };
        return { values: amount.map(value => value || 0), source: "amount" };
      };
      const payments = {};
      const fetchOne = async rid => {
        try {
          const r = await fetch(`https://openapi.etsy.com/v3/application/shops/${sid}/receipts/${rid}/payments`, { headers: authHeaders });
          if (!r.ok) return;
          const d = await r.json();
          const list = d.results || [];
          if (!list.length) return;
          // A receipt can (rarely) have multiple payment records — sum them.
          const totals = list.reduce((sum, payment) => {
            const { values, source } = paymentAmounts(payment);
            sum.gross += values[0] || 0;
            sum.fees += values[1] || 0;
            sum.net += values[2] || 0;
            if (source === "adjusted" || (source === "posted" && sum.source === "amount")) sum.source = source;
            return sum;
          }, { gross: 0, fees: 0, net: 0, source: "amount" });
          payments[String(rid)] = {
            gross: Number(totals.gross.toFixed(2)),
            fees: Number(totals.fees.toFixed(2)),
            net: Number(totals.net.toFixed(2)),
            source: totals.source,
            currency: list[0]?.shop_currency || list[0]?.currency || "",
          };
        } catch {}
      };
      for (let i = 0; i < ids.length; i += 8) {
        await Promise.all(ids.slice(i, i + 8).map(fetchOne));
      }
      return res.json({ ok: true, payments });
    }

    // ── earnings: EXACT per-receipt "you earned" from the payment-account ledger ─
    // A receipt's payment record only carries the processing fee; the transaction
    // fee, regulatory operating fee, etc. are separate ledger entries. We sum every
    // ledger entry tied to a receipt (via its receipt_id, payment ids, or transaction
    // ids) — that signed sum is exactly what Etsy shows as "You earned". Falls back to
    // the payment net when no ledger entries can be attributed (e.g. missing scope).
    // ?receipt_ids=1,2,3 (max 40). Add &debug=1 to see the matched ledger lines.
    if (action === "earnings") {
      if (!token) return res.status(401).json({ error: "OAuth token required", fix: "Visit /api/etsy-auth?action=start" });
      const ids = String(req.query.receipt_ids || "").split(",").map(s => s.trim()).filter(Boolean).slice(0, 40);
      if (!ids.length) return res.status(400).json({ error: "receipt_ids required" });
      const debug = req.query.debug === "1";
      const money = m => m && m.amount != null ? (+m.amount || 0) / (+m.divisor || 100) : 0;

      // 1. Per receipt: grandtotal (buyer paid), transaction ids, created ts, and the
      //    payment record (net for fallback, payment ids, currency).
      const info = {}; // rid -> { buyerPaid, currency, created, ids:Set(candidate ids), net }
      const fetchOne = async rid => {
        const key = String(rid);
        const rec = { buyerPaid: 0, currency: "", created: 0, ids: new Set([key]), net: 0 };
        try {
          const r = await fetch(`https://openapi.etsy.com/v3/application/shops/${sid}/receipts/${rid}`, { headers: authHeaders });
          if (r.ok) {
            const d = await r.json();
            rec.buyerPaid = money(d.grandtotal);
            rec.currency = d.grandtotal?.currency_code || rec.currency;
            rec.created = +d.create_timestamp || +d.created_timestamp || +d.creation_tsz || 0;
            for (const t of d.transactions || []) if (t.transaction_id != null) rec.ids.add(String(t.transaction_id));
            // Cancellation: Etsy marks status "canceled", or the buyer was fully
            // refunded. This detail fetch is authoritative — the order-list receipt
            // often lacks refunds, so a cancellation after the initial sync is only
            // reliably seen here.
            const st = String(d.status || "").toLowerCase();
            const refunded = (d.refunds || []).reduce((s, rf) => s + money(rf.amount || rf.gross || rf), 0);
            rec.status = st;
            rec.canceled = ["canceled", "cancelled"].includes(st) || (rec.buyerPaid > 0 && refunded >= rec.buyerPaid - 0.01);
            rec.refunded = Number(refunded.toFixed(2));
          }
        } catch {}
        // Etsy fills the net into different fields per shop (adjusted → posted → amount);
        // reading only amount_net returned 0 for shops that use posted_net.
        const netOf = p => {
          for (const m of [p.adjusted_net, p.posted_net, p.amount_net]) if (m && m.amount != null && +m.amount !== 0) return money(m);
          return money(p.posted_net || p.amount_net);
        };
        try {
          const r = await fetch(`https://openapi.etsy.com/v3/application/shops/${sid}/receipts/${rid}/payments`, { headers: authHeaders });
          if (r.ok) {
            const d = await r.json();
            for (const p of d.results || []) {
              rec.net += netOf(p);
              if (!rec.currency) rec.currency = p.shop_currency || p.currency || "";
              if (p.payment_id != null) rec.ids.add(String(p.payment_id));
              if (!rec.created) rec.created = +p.create_timestamp || 0;
            }
          }
        } catch {}
        info[key] = rec;
      };
      for (let i = 0; i < ids.length; i += 8) await Promise.all(ids.slice(i, i + 8).map(fetchOne));

      // 2. Ledger window derived from the receipts' create dates (fees post within a
      //    day or two); default to a 60-day look-back if timestamps are missing.
      const nowS = Math.floor(Date.now() / 1000);
      const createds = Object.values(info).map(r => r.created).filter(Boolean);
      const minCreated = (createds.length ? Math.min(...createds) : nowS - 60 * 86400) - 3 * 86400;
      const maxCreated = nowS + 86400;

      // candidate id -> receipt id
      const idToReceipt = new Map();
      for (const [rid, rec] of Object.entries(info)) for (const cid of rec.ids) if (!idToReceipt.has(cid)) idToReceipt.set(cid, rid);

      // 3. Page the ledger; attribute each entry to a receipt by reference_id.
      const attributed = {}; // rid -> { sum, entries:[] }
      let offset = 0, pages = 0, ledgerErr = null;
      while (pages < 25) {
        let d;
        try {
          const r = await fetch(`https://openapi.etsy.com/v3/application/shops/${sid}/payment-account/ledger-entries?min_created=${minCreated}&max_created=${maxCreated}&limit=100&offset=${offset}`, { headers: authHeaders });
          if (!r.ok) { ledgerErr = `ledger ${r.status}`; break; }
          d = await r.json();
        } catch (e) { ledgerErr = e.message; break; }
        const results = d.results || [];
        for (const e of results) {
          const rid = idToReceipt.get(String(e.reference_id != null ? e.reference_id : ""));
          if (!rid) continue;
          const amt = (+e.amount || 0) / 100;
          const a = attributed[rid] || (attributed[rid] = { sum: 0, entries: [] });
          a.sum += amt;
          if (debug) a.entries.push({ amount: +amt.toFixed(2), description: e.description, ref_type: e.reference_type, ref_id: String(e.reference_id) });
        }
        pages++;
        if (results.length < 100) break;
        offset += 100;
      }

      // 4. Prefer the exact ledger sum; fall back to the payment net.
      const payments = {};
      for (const rid of ids) {
        const rec = info[String(rid)];
        const att = attributed[String(rid)];
        const cancelInfo = rec ? { canceled: !!rec.canceled, status: rec.status || "", refunded: rec.refunded || 0 } : {};
        if (att && Math.abs(att.sum) > 0.001) {
          const earned = Number(att.sum.toFixed(2));
          const gross = Number((rec?.buyerPaid || earned).toFixed(2));
          payments[String(rid)] = { gross, net: earned, fees: Number((gross - earned).toFixed(2)), currency: rec?.currency || "", source: "ledger", matched: att.entries.length || undefined, ...cancelInfo, ...(debug ? { entries: att.entries } : {}) };
        } else if (rec) {
          const gross = Number((rec.buyerPaid || rec.net).toFixed(2)), net = Number(rec.net.toFixed(2));
          payments[String(rid)] = { gross, net, fees: Number((gross - net).toFixed(2)), currency: rec.currency || "", source: "payment", ...cancelInfo };
        }
      }
      return res.json({ ok: true, payments, window: { minCreated, maxCreated }, ...(ledgerErr ? { ledgerErr } : {}) });
    }

    // ── complete_order / add_tracking: mark receipt shipped with tracking ───
    if (action === "complete_order" || action === "add_tracking" || action === "submit_tracking") {
      if (req.method !== "POST") return res.status(405).json({ error: "POST required" });
      if (!token) return res.status(401).json({
        error: "OAuth token required to update Etsy orders.",
        fix: "Reconnect Etsy so the app can request transactions_w."
      });
      const body = req.body || {};
      const targetReceiptId = body.receipt_id || body.receiptId || receipt_id;
      if (!targetReceiptId) return res.status(400).json({ error: "receipt_id required" });
      const trackingCode = String(body.tracking_code || body.trackingCode || body.tracking || "").trim();
      const carrierName = String(body.carrier_name || body.carrierName || body.carrier || "other").trim() || "other";
      const basePayload = {};
      if (trackingCode) basePayload.tracking_code = trackingCode;
      if (body.note_to_buyer || body.noteToBuyer) basePayload.note_to_buyer = body.note_to_buyer || body.noteToBuyer;
      if (body.send_bcc !== undefined) basePayload.send_bcc = !!body.send_bcc;
      const postTracking = async carrier => {
        const payload = { ...basePayload, ...(carrier ? { carrier_name: carrier } : {}) };
        const r = await fetch(`https://openapi.etsy.com/v3/application/shops/${sid}/receipts/${targetReceiptId}/tracking`, {
          method: "POST",
          headers: { ...authHeaders, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const { data } = await readJsonish(r);
        return { r, data };
      };
      let { r, data } = await postTracking(carrierName);
      let usedCarrier = carrierName;
      // Etsy only accepts carriers from its own list. For couriers it doesn't know
      // (Cirro, ShipGlobal, etc.) it 400s on carrier_name — retry as "other" so the
      // order still ships; the real courier + tracking link stay recorded in the app.
      if (!r.ok && carrierName && carrierName.toLowerCase() !== "other"
        && !/scope|permission|forbidden|transactions_w/i.test(JSON.stringify(data || {}))
        && (r.status === 400 || /carrier/i.test(JSON.stringify(data || {})))) {
        ({ r, data } = await postTracking("other"));
        usedCarrier = "other";
      }
      if (!r.ok) {
        const msg = etsyMessage(data);
        return res.status(r.status).json({
          error: msg,
          details: data,
          fix: /scope|permission|forbidden|transactions_w/i.test(String(msg))
            ? "Reconnect Etsy from the Etsy manager so the new transactions_w permission is granted."
            : undefined,
        });
      }
      return res.json({ ok: true, receipt: data, tracking_code: trackingCode, carrier_name: carrierName, carrier_sent: usedCarrier });
    }

    // ── discounts: active shop sales / discounts ─────────────────────────────
    if (action === "discounts") {
      if (!token) return res.status(401).json({ error: "OAuth token required" });
      const r = await fetch(`https://openapi.etsy.com/v3/application/shops/${sid}/discounts`, { headers: authHeaders });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data.error || "Etsy API error", details: data });
      return res.json(data);
    }

    // ── sections: shop sections ───────────────────────────────────────────────
    if (action === "sections") {
      const r = await fetch(`https://openapi.etsy.com/v3/application/shops/${sid}/sections`, { headers: authHeaders });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data.error || "Etsy API error", details: data });
      return res.json(data);
    }

    // ── listings: active listings with images ─────────────────────────────────
    if (action === "listings") {
      const state = req.query.state || "active";
      const p = new URLSearchParams({ state, limit, offset });
      p.append("includes[]", "Images");
      const r = await fetch(`https://openapi.etsy.com/v3/application/shops/${sid}/listings?${p}`, { headers: authHeaders });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data.error || "Etsy API error", details: data });
      return res.json(data);
    }

    // ── listings_all: paginate all active + draft + inactive + sold_out listings
    if (action === "listings_all") {
      const results = [];
      const stateErrors = [];
      const etsyFetch = (url) => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 12000); // 12s per request
        return fetch(url, { headers: authHeaders, signal: ctrl.signal })
          .finally(() => clearTimeout(t));
      };
      for (const state of ["active", "draft", "inactive", "sold_out"]) {
        const p0 = new URLSearchParams({ state, limit: "100", offset: "0" });
        p0.append("includes[]", "Images");
        let r0;
        try {
          r0 = await etsyFetch(`https://openapi.etsy.com/v3/application/shops/${sid}/listings?${p0}`);
        } catch (e) {
          stateErrors.push({ state, status: 0, error: e.name === "AbortError" ? "timeout" : e.message });
          continue;
        }
        if (!r0.ok) {
          const e = await r0.json().catch(() => ({}));
          stateErrors.push({ state, status: r0.status, error: e.error || e.message || "unknown" });
          continue;
        }
        const d0 = await r0.json();
        results.push(...(d0.results || []));
        const total = d0.count || 0;
        if (total > 100) {
          const pageCount = Math.ceil((total - 100) / 100);
          // Sequential + throttled — parallel page fetches tripped Etsy's per-second
          // rate limit (10 req/s), which failed the whole load. ~4 req/s is safe.
          for (let i = 1; i <= pageCount; i++) {
            await new Promise(r => setTimeout(r, 250));
            const p = new URLSearchParams({ state, limit: "100", offset: String(i * 100) });
            p.append("includes[]", "Images");
            try {
              const r = await etsyFetch(`https://openapi.etsy.com/v3/application/shops/${sid}/listings?${p}`);
              if (r.ok) { const d = await r.json(); results.push(...(d.results || [])); }
            } catch { /* skip a failed page, keep going */ }
          }
        }
      }
      return res.json({ count: results.length, results, stateErrors: stateErrors.length ? stateErrors : undefined });
    }

    // ── listing_images: images for a listing ──────────────────────────────────
    if (action === "listing_images") {
      const { listing_id } = req.query;
      if (!listing_id) return res.status(400).json({ error: "listing_id required" });
      const r = await fetch(`https://openapi.etsy.com/v3/application/listings/${listing_id}/images`, { headers: pubHeaders });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data.error || "Etsy API error", details: data });
      return res.json(data);
    }

    /* listing_videos: what Etsy holds for a listing. Public like the images
       endpoint — the listing is already public, so no OAuth is needed to read
       back what is on it. Etsy allows one video per listing today, but the
       endpoint answers with a list, so it is passed through as one. */
    if (action === "listing_videos") {
      const { listing_id } = req.query;
      if (!listing_id) return res.status(400).json({ error: "listing_id required" });
      const r = await fetch(`https://openapi.etsy.com/v3/application/listings/${listing_id}/videos`, { headers: pubHeaders });
      const data = await r.json();
      // A listing with no video answers 404 on some shops rather than an empty
      // list; that is an absence, not a failure, and the screen should say so.
      if (r.status === 404) return res.json({ count: 0, results: [] });
      if (!r.ok) return res.status(r.status).json({ error: data.error || "Etsy API error", details: data });
      return res.json(data);
    }

    // ── listing: single listing detail ────────────────────────────────────────
    if (action === "listing") {
      const { listing_id } = req.query;
      if (!listing_id) return res.status(400).json({ error: "listing_id required" });
      const r = await fetch(`https://openapi.etsy.com/v3/application/listings/${listing_id}`, { headers: pubHeaders });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data.error || "Etsy API error", details: data });
      return res.json(data);
    }

    // ── upload_listing_image: fetch image from URL and POST to Etsy listing ─────
    if (action === "upload_listing_image") {
      if (req.method !== "POST") return res.status(405).json({ error: "POST required" });
      if (!token) return res.status(401).json({ error: "OAuth token required" });
      const { listing_id } = req.query;
      const { image_url, rank = 1 } = req.body || {};
      if (!listing_id || !image_url) return res.status(400).json({ error: "listing_id and image_url required" });
      const imgR = await fetch(image_url);
      if (!imgR.ok) return res.status(400).json({ error: `Could not fetch image (${imgR.status})` });
      const imgBuf = await imgR.arrayBuffer();
      const ct = imgR.headers.get("content-type") || "image/jpeg";
      const ext = ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg";
      const form = new FormData();
      form.append("image", new Blob([imgBuf], { type: ct }), `img.${ext}`);
      form.append("rank", String(rank));
      const r = await fetch(
        `https://openapi.etsy.com/v3/application/shops/${sid}/listings/${listing_id}/images`,
        { method: "POST", headers: { "x-api-key": key, Authorization: `Bearer ${token}` }, body: form }
      );
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data.error || "Image upload failed", details: data });
      return res.json(data);
    }

    // ── upload_listing_video: fetch video from URL and POST to Etsy listing ─────
    // Etsy allows ONE video per listing: MP4, ≤100MB, ~5–15s.
    if (action === "upload_listing_video") {
      if (req.method !== "POST") return res.status(405).json({ error: "POST required" });
      if (!token) return res.status(401).json({ error: "OAuth token required" });
      const { listing_id } = req.query;
      const { video_url, name = "video" } = req.body || {};
      if (!listing_id || !video_url) return res.status(400).json({ error: "listing_id and video_url required" });
      const vR = await fetch(video_url);
      if (!vR.ok) return res.status(400).json({ error: `Could not fetch video (${vR.status})` });
      const vBuf = await vR.arrayBuffer();
      const ct = vR.headers.get("content-type") || "video/mp4";
      const form = new FormData();
      form.append("video", new Blob([vBuf], { type: ct }), "video.mp4");
      form.append("name", String(name).slice(0, 70));
      const r = await fetch(
        `https://openapi.etsy.com/v3/application/shops/${sid}/listings/${listing_id}/videos`,
        { method: "POST", headers: { "x-api-key": key, Authorization: `Bearer ${token}` }, body: form }
      );
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data.error || "Video upload failed", details: data });
      return res.json(data);
    }

    // ── delete_listing_image: remove an image from a listing ──────────────────
    if (action === "delete_listing_image") {
      if (req.method !== "POST") return res.status(405).json({ error: "POST required" });
      if (!token) return res.status(401).json({ error: "OAuth token required" });
      const { listing_id, listing_image_id } = { ...req.query, ...(req.body || {}) };
      if (!listing_id || !listing_image_id) return res.status(400).json({ error: "listing_id and listing_image_id required" });
      const r = await fetch(
        `https://openapi.etsy.com/v3/application/shops/${sid}/listings/${listing_id}/images/${listing_image_id}`,
        { method: "DELETE", headers: authHeaders }
      );
      if (!r.ok) { const d = await r.json().catch(() => ({})); return res.status(r.status).json({ error: d.error || "Delete failed" }); }
      return res.json({ ok: true });
    }

    // ── update_listing: PATCH listing metadata (title, description, tags, state) ─
    if (action === "update_listing") {
      if (req.method !== "POST") return res.status(405).json({ error: "POST required" });
      if (!token) return res.status(401).json({ error: "OAuth token required", fix: "Visit /api/etsy-auth?action=start" });
      const { listing_id } = req.query;
      if (!listing_id) return res.status(400).json({ error: "listing_id required" });
      const { title, description, tags, state } = req.body || {};
      const payload = {};
      if (title !== undefined) payload.title = String(title).slice(0, 140);
      if (description !== undefined) payload.description = String(description);
      if (state !== undefined) payload.state = state;
      if (Array.isArray(tags)) {
        payload.tags = [...new Set(tags.map(t => String(t).trim()).filter(Boolean))].slice(0, 13);
      }
      const url = `https://openapi.etsy.com/v3/application/shops/${sid}/listings/${listing_id}`;

      // Try JSON first — Etsy v3 listing PATCH accepts JSON on current clusters.
      let r = await fetch(url, {
        method: "PATCH",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      let { data } = await readJsonish(r);
      console.log("[etsy update_listing] json PATCH status:", r.status, "etsyMsg:", etsyMessage(data));

      // Fallback to form-encoded only on 4xx that aren't auth errors.
      // Some older Etsy clusters reject JSON body and want form-encoded tags.
      if (!r.ok && r.status !== 401 && r.status !== 403) {
        const form = new URLSearchParams();
        if (payload.title       !== undefined) form.set("title",       payload.title);
        if (payload.description !== undefined) form.set("description", payload.description);
        if (payload.state       !== undefined) form.set("state",       payload.state);
        // Form-encoded Etsy wants a comma-separated list, not a JSON array —
        // sending `["a","b"]` made this fallback fail as surely as the JSON try.
        if (payload.tags        !== undefined) form.set("tags",        payload.tags.join(","));
        const rf = await fetch(url, {
          method: "PATCH",
          headers: { ...authHeaders, "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
        });
        const { data: df } = await readJsonish(rf);
        console.log("[etsy update_listing] form PATCH status:", rf.status, "etsyMsg:", etsyMessage(df));
        if (rf.ok) { r = rf; data = df; }
        else if (rf.status !== r.status) { r = rf; data = df; } // use whichever has more info
      }

      if (!r.ok) {
        return res.status(r.status).json({
          error: `Listing update failed: ${etsyMessage(data)}`,
          etsyError: etsyMessage(data),
          details: data,
        });
      }
      return res.json(data);
    }

    // ── update_inventory: update price + quantity via inventory endpoint ──────
    if (action === "update_inventory") {
      if (req.method !== "POST") return res.status(405).json({ error: "POST required" });
      if (!token) return res.status(401).json({ error: "OAuth token required" });
      const { listing_id } = req.query;
      if (!listing_id) return res.status(400).json({ error: "listing_id required" });
      const { price, quantity } = req.body || {};
      // 1. GET current inventory
      const getR = await fetch(`https://openapi.etsy.com/v3/application/listings/${listing_id}/inventory`, { headers: authHeaders });
      const { data: invData } = await readJsonish(getR);
      if (!getR.ok) {
        return res.status(getR.status).json({
          error: "Failed to fetch inventory",
          etsyError: invData?.error || invData?.message || invData?.detail || null,
          details: invData,
          hint: getR.status === 403
            ? "Token may be missing listings_r scope — re-authorize via /api/etsy-auth?action=start"
            : getR.status === 401
            ? "OAuth token expired or invalid — re-authorize via /api/etsy-auth?action=start"
            : null,
        });
      }
      const inv = invData;
      const parsedPrice = price !== undefined ? Number.parseFloat(price) : undefined;
      const parsedQuantity = quantity !== undefined ? Number.parseInt(quantity, 10) : undefined;
      if (price !== undefined && !Number.isFinite(parsedPrice)) {
        return res.status(400).json({ error: "Price must be a valid number" });
      }
      if (quantity !== undefined && (!Number.isFinite(parsedQuantity) || parsedQuantity < 0)) {
        return res.status(400).json({ error: "Quantity must be a valid non-negative number" });
      }

      const moneyToDecimal = money => {
        if (typeof money === "number") return money;
        const amount = Number(money?.amount ?? 0);
        const divisor = Number(money?.divisor || 100);
        return divisor ? amount / divisor : amount;
      };

      // 2. Modify ALL products/offerings (handles multi-variation listings too).
      // Etsy requires the full inventory payload, but rejects read-only fields from
      // getListingInventory. It also wants offering.price as a decimal, not a Money object.
      const cleanProducts = (inv.products || []).map(prod => ({
        sku: prod.sku || "",
        property_values: (prod.property_values || []).map(pv => {
          const clean = {
            property_id: pv.property_id,
            property_name: pv.property_name,
            scale_id: pv.scale_id ?? null,
            value_ids: Array.isArray(pv.value_ids) ? pv.value_ids : [],
            values: Array.isArray(pv.values) ? pv.values : [],
          };
          return Object.fromEntries(Object.entries(clean).filter(([, v]) => v !== undefined));
        }),
        offerings: (prod.offerings || []).map(offering => {
          const nextPrice = parsedPrice ?? moneyToDecimal(offering.price);
          const clean = {
            quantity: parsedQuantity ?? (offering.quantity ?? 1),
            is_enabled: offering.is_enabled ?? true,
            price: Number(nextPrice.toFixed ? nextPrice.toFixed(2) : Number(nextPrice).toFixed(2)),
          };
          if (offering.readiness_state_id !== undefined) clean.readiness_state_id = offering.readiness_state_id;
          return clean;
        }),
      }));
      if (!cleanProducts.length) return res.status(400).json({ error: "Listing has no Etsy inventory products to update" });

      const inventoryBody = {
        products: cleanProducts,
        price_on_property: inv.price_on_property || [],
        quantity_on_property: inv.quantity_on_property || [],
        sku_on_property: inv.sku_on_property || [],
      };
      if (Array.isArray(inv.readiness_state_on_property)) {
        inventoryBody.readiness_state_on_property = inv.readiness_state_on_property;
      }

      // 3. PUT back as JSON. Some Etsy clusters still expect form-encoded JSON
      // strings, so retry that encoding if Etsy returns the classic JSON-string error.
      const inventoryUrl = `https://openapi.etsy.com/v3/application/listings/${listing_id}/inventory`;
      let putR = await fetch(inventoryUrl, {
        method: "PUT",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(inventoryBody),
      });
      let { text: putText, data: putData } = await readJsonish(putR);
      console.log("[etsy update_inventory] JSON PUT status:", putR.status, "body:", putText.slice(0, 500));

      if (!putR.ok && /json/i.test(etsyMessage(putData))) {
        const formBody = new URLSearchParams({
          products: JSON.stringify(cleanProducts),
          price_on_property: JSON.stringify(inventoryBody.price_on_property),
          quantity_on_property: JSON.stringify(inventoryBody.quantity_on_property),
          sku_on_property: JSON.stringify(inventoryBody.sku_on_property),
        });
        if (Array.isArray(inventoryBody.readiness_state_on_property)) {
          formBody.set("readiness_state_on_property", JSON.stringify(inventoryBody.readiness_state_on_property));
        }
        putR = await fetch(inventoryUrl, {
          method: "PUT",
          headers: { ...authHeaders, "Content-Type": "application/x-www-form-urlencoded" },
          body: formBody.toString(),
        });
        ({ text: putText, data: putData } = await readJsonish(putR));
        console.log("[etsy update_inventory] FORM PUT status:", putR.status, "body:", putText.slice(0, 500));
      }

      if (!putR.ok) {
        return res.status(putR.status).json({
          error: `Inventory update failed: ${etsyMessage(putData)}`,
          details: putData,
        });
      }
      return res.json(putData);
    }

    return res.status(400).json({ error: "Unknown action. Use: ping, shop, orders, pulse, listing_pulse, renewal_queue, renewal_stats, renewal_listing, receipt, complete_order, add_tracking, listings, listings_all, listing_images, listing, upload_listing_image, upload_listing_video, delete_listing_image, update_listing, update_inventory" });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

/* One small queue per request for the home page's reads: at most 4 Etsy calls in
   flight and starts spaced 125ms apart (Etsy allows ~10 a second per app), so
   parallel pages never trip the limit; a 429 waits and retries. */
function etsyQueue(headers) {
  let active = 0, nextStart = 0;
  const waiting = [];
  const slot = () => active < 4 ? (active++, Promise.resolve()) : new Promise(r => waiting.push(r));
  const free = () => { const next = waiting.shift(); next ? next() : active--; };
  const spaced = async () => {
    const at = Math.max(Date.now(), nextStart);
    nextStart = at + 125;
    if (at > Date.now()) await new Promise(s => setTimeout(s, at - Date.now()));
  };
  const getJson = async url => {
    for (let attempt = 0; attempt < 4; attempt++) {
      await slot();
      await spaced();
      let r;
      try { r = await fetch(url, { headers }); } finally { free(); }
      if (r.status === 429) { await new Promise(s => setTimeout(s, 700 * (attempt + 1))); continue; }
      const text = await r.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
      if (!r.ok) throw Object.assign(new Error(data?.error || data?.message || data?.detail || "Etsy API error"), { status: r.status });
      return data;
    }
    throw Object.assign(new Error("Etsy is rate-limiting — try again in a minute."), { status: 429 });
  };
  // The first page's count says how many more there are; fetch those together.
  const allPages = async makeUrl => {
    const first = await getJson(makeUrl(0));
    const rows = [...(first.results || [])];
    const total = Math.min(+first.count || rows.length, 3000);
    const offsets = [];
    for (let o = 100; o < total; o += 100) offsets.push(o);
    (await Promise.all(offsets.map(o => getJson(makeUrl(o))))).forEach(p => rows.push(...(p.results || [])));
    return rows;
  };
  // Page in order while the last row of each page still qualifies.
  const pagesWhile = async (makeUrl, more) => {
    const rows = [];
    let count = 0;
    for (let offset = 0; offset < 3000; offset += 100) {
      const d = await getJson(makeUrl(offset));
      const page = d.results || [];
      count = +d.count || count;
      rows.push(...page);
      if (page.length < 100 || !more(page[page.length - 1])) break;
    }
    return { rows, count };
  };
  return { getJson, allPages, pagesWhile };
}

/* Rating, count and the latest written reviews (4 and 5 stars, English,
   at least a sentence). Etsy's API gives no reviewer names, so each is
   credited from its order: first name and last initial ("Paula M."), as
   Etsy itself shows reviewers. A review whose order can't be read is
   credited "Customer". */
const shortName = full => {
  const w = String(full || "").trim().split(/\s+/).filter(x => /^[\p{L}'-]+$/u.test(x));
  if (!w.length) return "";
  const cap = x => x.charAt(0).toUpperCase() + x.slice(1).toLowerCase();
  return w.length > 1 ? `${cap(w[0])} ${w[w.length - 1].charAt(0).toUpperCase()}.` : cap(w[0]);
};
async function storeReviews(res) {
  const key = process.env.ETSY_API_KEY ||
    (process.env.ETSY_KEYSTRING && process.env.ETSY_SHARED_SECRET ? `${process.env.ETSY_KEYSTRING}:${process.env.ETSY_SHARED_SECRET}` : process.env.ETSY_KEYSTRING);
  const sid = process.env.ETSY_SHOP_ID;
  if (!key || !sid) return res.status(503).json({ error: "Etsy not set up" });
  try {
    const token = await getEtsyAccessToken().catch(() => null);
    const get = async (path, auth) => { const r = await fetch(`https://openapi.etsy.com/v3/application/${path}`, { headers: { "x-api-key": key, ...(auth && token ? { Authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(8000) }); if (!r.ok) throw new Error(`Etsy ${r.status}`); return r.json(); };
    const [shop, page] = await Promise.all([get(`shops/${sid}`), get(`shops/${sid}/reviews?limit=100`)]);
    const kept = (page.results || [])
      .filter(r => r.rating >= 4 && String(r.review || "").trim().length >= 40 && (!r.language || /^en/i.test(r.language)))
      .slice(0, 12);
    // review → transaction → receipt name, one at a time: in parallel, Etsy
    // answers 429 (too many requests) and the reviews go unnamed.
    const names = new Map();
    const pause = () => new Promise(r => setTimeout(r, 150));
    if (token) for (const r of kept) {
      try {
        const t = await get(`shops/${sid}/transactions/${r.transaction_id}`, true);
        await pause();
        const rc = await get(`shops/${sid}/receipts/${t.receipt_id}`, true);
        names.set(r.transaction_id, shortName(rc.name));
      } catch (e) { names.err = e.message; /* credited "Customer" */ }
      await pause();
    }
    console.log(`store_reviews: token ${!!token}, named ${names.size}/${kept.length}${names.err ? `, last error ${names.err}` : ""}`);
    const reviews = kept.map(r => ({ rating: r.rating, text: String(r.review).trim().slice(0, 600), date: new Date((r.created_timestamp || r.create_timestamp) * 1000).toISOString().slice(0, 10), name: names.get(r.transaction_id) || "" }));
    return res.status(200).json({ average: +shop.review_average || 0, count: +shop.review_count || 0, reviews });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}
