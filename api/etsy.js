import { getEtsyAccessToken } from "./etsy-auth.js";

export const maxDuration = 45; // Vercel Pro: allow up to 45s for multi-page listing fetches

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Etsy-Token");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // x-api-key must be keystring:sharedsecret for Etsy API v3
  const key = process.env.ETSY_API_KEY ||
    (process.env.ETSY_KEYSTRING && process.env.ETSY_SHARED_SECRET
      ? `${process.env.ETSY_KEYSTRING}:${process.env.ETSY_SHARED_SECRET}`
      : process.env.ETSY_KEYSTRING);

  // Bearer token: prefer client-provided (frontend manages refresh lifecycle),
  // fall back to server env var for backwards compat.
  const clientToken = req.headers["x-etsy-token"] ||
    (req.headers["authorization"]?.startsWith("Bearer ") ? req.headers["authorization"].slice(7) : null);
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
        if (att && Math.abs(att.sum) > 0.001) {
          const earned = Number(att.sum.toFixed(2));
          const gross = Number((rec?.buyerPaid || earned).toFixed(2));
          payments[String(rid)] = { gross, net: earned, fees: Number((gross - earned).toFixed(2)), currency: rec?.currency || "", source: "ledger", matched: att.entries.length || undefined, ...(debug ? { entries: att.entries } : {}) };
        } else if (rec) {
          const gross = Number((rec.buyerPaid || rec.net).toFixed(2)), net = Number(rec.net.toFixed(2));
          payments[String(rid)] = { gross, net, fees: Number((gross - net).toFixed(2)), currency: rec.currency || "", source: "payment" };
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

    // ── listings_all: paginate all active + inactive + sold_out listings ──────
    if (action === "listings_all") {
      const results = [];
      const stateErrors = [];
      const etsyFetch = (url) => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 12000); // 12s per request
        return fetch(url, { headers: authHeaders, signal: ctrl.signal })
          .finally(() => clearTimeout(t));
      };
      for (const state of ["active", "inactive", "sold_out"]) {
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
          const fetches = Array.from({ length: pageCount }, (_, i) => {
            const p = new URLSearchParams({ state, limit: "100", offset: String((i + 1) * 100) });
            p.append("includes[]", "Images");
            return etsyFetch(`https://openapi.etsy.com/v3/application/shops/${sid}/listings?${p}`)
              .then(r => r.ok ? r.json() : { results: [] })
              .catch(() => ({ results: [] }));
          });
          const pages = await Promise.all(fetches);
          pages.forEach(d => results.push(...(d.results || [])));
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
        if (payload.tags        !== undefined) form.set("tags",        JSON.stringify(payload.tags));
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

    return res.status(400).json({ error: "Unknown action. Use: ping, shop, orders, receipt, complete_order, add_tracking, listings, listings_all, listing_images, listing, upload_listing_image, upload_listing_video, delete_listing_image, update_listing, update_inventory" });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
