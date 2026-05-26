/**
 * eBay Trading API proxy — uses Auth'n'Auth token (no OAuth flow needed).
 *
 * Env vars:
 *   EBAY_APP_ID    — App ID  (ManavJha-listingm-PRD-...)
 *   EBAY_DEV_ID    — Dev ID  (63192232-0f1f-...)
 *   EBAY_CERT_ID   — Cert ID (PRD-09ada41f0e9e-...)
 *   EBAY_USER_TOKEN — the v^1.1#... token from eBay developer portal
 *
 * Actions:
 *   GET  ?action=ping        — check token is set + valid
 *   GET  ?action=get_listings — GetMyeBaySelling active items
 *   GET  ?action=get_orders  — GetOrders (last 90 days)
 *   POST ?action=update_item&item_id=xxx — ReviseItem (price, qty, title)
 */

export const maxDuration = 30;

const APP_ID     = process.env.EBAY_APP_ID     || process.env.EBAY_CLIENT_ID   || "";
const DEV_ID     = process.env.EBAY_DEV_ID     || "";
const CERT_ID    = process.env.EBAY_CERT_ID    || process.env.EBAY_CLIENT_SECRET || "";
const USER_TOKEN = process.env.EBAY_USER_TOKEN || "";

const ENDPOINT   = "https://api.ebay.com/ws/api.dll";
const COMPAT     = "967";
const SITE_ID    = "0"; // eBay US

// ── XML helpers ───────────────────────────────────────────────────────────────
const esc = s => String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

// Convert plain text (with \n line breaks) to HTML for eBay description rendering
function plainToHtml(text) {
  if (!text) return "";
  return text
    .split(/\n\n+/)
    .map(para => `<p>${para.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

// Decode XML/HTML entities then strip HTML tags → plain text with newlines
function htmlToPlain(raw) {
  if (!raw) return "";
  // Decode XML entities first (description is HTML stored inside XML)
  const decoded = raw
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&nbsp;/gi, " ");
  // Convert block-level HTML to newlines before stripping tags
  return decoded
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Extract text content of first matching tag (strips inner tags — use for leaf nodes)
function xmlTag(tag, xml) {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? m[1].replace(/<[^>]+>/g, "").trim() : "";
}

// Extract raw inner XML of first matching tag (preserves child tags — use for container nodes)
function xmlBlock(tag, xml) {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? m[1] : "";
}

// Extract all raw inner XML blocks for a repeating tag
function xmlAll(tag, xml) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "gi");
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

// ── Make a Trading API call ───────────────────────────────────────────────────
async function trading(callName, bodyXml) {
  const reqXml = `<?xml version="1.0" encoding="utf-8"?>
<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${esc(USER_TOKEN)}</eBayAuthToken></RequesterCredentials>
  ${bodyXml}
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
</${callName}Request>`;

  const r = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type":                  "text/xml",
      "X-EBAY-API-COMPATIBILITY-LEVEL": COMPAT,
      "X-EBAY-API-CALL-NAME":           callName,
      "X-EBAY-API-SITEID":              SITE_ID,
      "X-EBAY-API-APP-NAME":            APP_ID,
      "X-EBAY-API-DEV-NAME":            DEV_ID,
      "X-EBAY-API-CERT-NAME":           CERT_ID,
    },
    body: reqXml,
  });

  const xml = await r.text();
  const ack = xmlTag("Ack", xml);
  return { ok: ack === "Success" || ack === "Warning", ack, xml };
}

// ── Parse a single <Item> block into a plain object ───────────────────────────
function parseItem(block) {
  // eBay returns images under <PictureDetails><GalleryURL> or <PictureURL>
  const picBlock = xmlBlock("PictureDetails", block);
  const pics     = [...xmlAll("PictureURL", picBlock), ...xmlAll("GalleryURL", picBlock)]
                     .filter((v, i, a) => a.indexOf(v) === i); // dedupe
  // Price lives inside <SellingStatus><CurrentPrice> or top-level <BuyItNowPrice>
  const sellingBlock = xmlBlock("SellingStatus", block);
  const price = parseFloat(
    xmlTag("CurrentPrice", sellingBlock) ||
    xmlTag("BuyItNowPrice", block) ||
    xmlTag("StartPrice", block) || "0"
  );
  const listingBlock   = xmlBlock("ListingDetails", block);
  const shippingBlock  = xmlBlock("ShippingDetails", block);
  const serviceBlock   = xmlBlock("ShippingServiceOptions", shippingBlock);
  const shippingCost   = parseFloat(xmlTag("ShippingServiceCost", serviceBlock) || "0");
  return {
    itemId:       xmlTag("ItemID", block),
    title:        xmlTag("Title", block),
    price,
    currency:     "USD",
    quantity:     parseInt(xmlTag("QuantityAvailable", block) || xmlTag("Quantity", block) || "0", 10),
    quantitySold: parseInt(xmlTag("QuantitySold", block) || "0", 10),
    imageUrls:    pics,
    listingUrl:   xmlTag("ViewItemURL", listingBlock),
    endTime:      xmlTag("EndTime", listingBlock),
    conditionId:  xmlTag("ConditionID", block) || "",
    description:  htmlToPlain(xmlBlock("Description", block)),
    shippingCost,
    location:     xmlTag("Location", block) || "",
  };
}

// ── Parse a single <Order> block ──────────────────────────────────────────────
function parseOrder(block) {
  const orderId  = xmlTag("OrderID", block);
  const created  = xmlTag("CreatedTime", block);
  const status   = xmlTag("OrderStatus", block);
  const total    = xmlTag("Total", block);
  // Buyer is nested under <CheckoutStatus><eBayUserID> or <BuyerUserID>
  const buyer    = xmlTag("BuyerUserID", block) || xmlTag("eBayUserID", xmlBlock("CheckoutStatus", block));
  // Line items
  const txnBlock = xmlBlock("TransactionArray", block);
  const items    = xmlAll("Transaction", txnBlock).map(t => ({
    title:  xmlTag("Title", xmlBlock("Item", t)),
    itemId: xmlTag("ItemID", xmlBlock("Item", t)),
    qty:    parseInt(xmlTag("QuantityPurchased", t) || "1", 10),
    price:  parseFloat(xmlTag("TransactionPrice", t) || "0"),
  }));
  return { orderId, buyer, total: parseFloat(total || "0"), currency: "USD", created, status, items };
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const url    = new URL(req.url, `https://${req.headers.host}`);
  const action = url.searchParams.get("action");

  // ── ping ──────────────────────────────────────────────────────────────────
  if (action === "ping") {
    if (!USER_TOKEN) return res.json({ connected: false, reason: "EBAY_USER_TOKEN not set" });
    // Quick call to verify token validity
    const { ok, xml } = await trading("GetUser", "");
    if (ok) {
      const username = xmlTag("UserID", xml);
      return res.json({ connected: true, username });
    }
    const errMsg = xmlTag("LongMessage", xml) || xmlTag("ShortMessage", xml) || "Token invalid";
    return res.json({ connected: false, reason: errMsg });
  }

  // ── get_listings — GetMyeBaySelling active items ─────────────────────────
  if (action === "get_listings") {
    if (!USER_TOKEN) return res.status(401).json({ error: "EBAY_USER_TOKEN not set" });
    const allItems = [];
    let page = 1;

    while (page <= 10) {
      const { ok, xml } = await trading("GetMyeBaySelling", `
        <ActiveList>
          <Include>true</Include>
          <IncludeWatchCount>true</IncludeWatchCount>
          <Pagination>
            <EntriesPerPage>200</EntriesPerPage>
            <PageNumber>${page}</PageNumber>
          </Pagination>
        </ActiveList>
        <GranularityLevel>Fine</GranularityLevel>`);

      if (!ok) {
        const errMsg = xmlTag("LongMessage", xml) || "GetMyeBaySelling failed";
        return res.status(500).json({ error: errMsg });
      }

      const activeBlock   = xmlBlock("ActiveList", xml);
      const arrayBlock    = xmlBlock("ItemArray", activeBlock);
      const itemBlocks    = xmlAll("Item", arrayBlock);
      itemBlocks.forEach(b => allItems.push(parseItem(b)));

      const paginationBlock = xmlBlock("PaginationResult", activeBlock);
      const totalPages = parseInt(xmlTag("TotalNumberOfPages", paginationBlock) || "1", 10);
      if (page >= totalPages) break;
      page++;
    }

    return res.json({ results: allItems, total: allItems.length });
  }

  // ── get_orders — GetOrders last 90 days ──────────────────────────────────
  if (action === "get_orders") {
    if (!USER_TOKEN) return res.status(401).json({ error: "EBAY_USER_TOKEN not set" });
    const daysBack = parseInt(url.searchParams.get("days") || "90", 10);
    const from     = new Date(Date.now() - daysBack * 86400000).toISOString();
    const to       = new Date().toISOString();

    const { ok, xml } = await trading("GetOrders", `
      <CreateTimeFrom>${esc(from)}</CreateTimeFrom>
      <CreateTimeTo>${esc(to)}</CreateTimeTo>
      <OrderRole>Seller</OrderRole>
      <OrderStatus>All</OrderStatus>
      <Pagination><EntriesPerPage>100</EntriesPerPage><PageNumber>1</PageNumber></Pagination>`);

    if (!ok) {
      const errMsg = xmlTag("LongMessage", xml) || "GetOrders failed";
      return res.status(500).json({ error: errMsg });
    }

    const orderArrayBlock = xmlBlock("OrderArray", xml);
    const orderBlocks = xmlAll("Order", orderArrayBlock);
    return res.json({ results: orderBlocks.map(parseOrder), total: orderBlocks.length });
  }

  // ── get_item — GetItem (full details for edit modal) ──────────────────────
  if (action === "get_item") {
    if (!USER_TOKEN) return res.status(401).json({ error: "EBAY_USER_TOKEN not set" });
    const itemId = url.searchParams.get("item_id");
    if (!itemId) return res.status(400).json({ error: "item_id required" });
    const { ok, xml } = await trading("GetItem", `
      <ItemID>${esc(itemId)}</ItemID>
      <DetailLevel>ReturnAll</DetailLevel>`);
    if (!ok) {
      const errMsg = xmlTag("LongMessage", xml) || "GetItem failed";
      return res.status(500).json({ error: errMsg });
    }
    const itemBlock = xmlBlock("Item", xmlBlock("GetItemResponse", xml) || xml);
    return res.json(parseItem(itemBlock || xml));
  }

  // ── update_item — ReviseItem ──────────────────────────────────────────────
  if (action === "update_item" && req.method === "POST") {
    if (!USER_TOKEN) return res.status(401).json({ error: "EBAY_USER_TOKEN not set" });
    const itemId = url.searchParams.get("item_id");
    if (!itemId) return res.status(400).json({ error: "item_id required" });
    const body = req.body || {};

    const fields = [`<ItemID>${esc(itemId)}</ItemID>`];
    if (body.title       !== undefined) fields.push(`<Title>${esc(body.title)}</Title>`);
    if (body.price       !== undefined) fields.push(`<StartPrice>${Number(body.price).toFixed(2)}</StartPrice>`);
    if (body.quantity    !== undefined) fields.push(`<Quantity>${Math.max(0, parseInt(body.quantity, 10))}</Quantity>`);
    if (body.description !== undefined) fields.push(`<Description><![CDATA[${plainToHtml(body.description)}]]></Description>`);
    if (body.conditionId !== undefined) fields.push(`<ConditionID>${esc(String(body.conditionId))}</ConditionID>`);
    if (body.shippingCost !== undefined) {
      fields.push(`<ShippingDetails><ShippingServiceOptions><ShippingServicePriority>1</ShippingServicePriority><ShippingService>USPSMedia</ShippingService><ShippingServiceCost>${Number(body.shippingCost).toFixed(2)}</ShippingServiceCost></ShippingServiceOptions></ShippingDetails>`);
    }
    if (Array.isArray(body.imageUrls) && body.imageUrls.length > 0) {
      const picXml = body.imageUrls.slice(0, 12).map(u => `<PictureURL>${esc(u)}</PictureURL>`).join("");
      fields.push(`<PictureDetails>${picXml}</PictureDetails>`);
    }

    const { ok, xml } = await trading("ReviseItem", `<Item>${fields.join("")}</Item>`);
    if (!ok) {
      const errMsg = xmlTag("LongMessage", xml) || "ReviseItem failed";
      return res.status(500).json({ error: errMsg });
    }
    return res.json({ ok: true, itemId: xmlTag("ItemID", xml) });
  }

  // ── publish_listing — AddItem (new) or ReviseItem (existing) ────────────
  if (action === "publish_listing" && req.method === "POST") {
    if (!USER_TOKEN) return res.status(401).json({ error: "EBAY_USER_TOKEN not set" });
    const body = req.body || {};
    const {
      title, description, price, quantity = 1, images = [],
      conditionId = "3000", shippingCost = 0, itemId: existingId,
      categoryId = "4218", // Crystals & Mineral Specimens
    } = body;

    if (!title) return res.status(400).json({ error: "title required" });
    if (!price)  return res.status(400).json({ error: "price required" });
    console.log("[ebay publish_listing] description preview:", JSON.stringify((description || "").slice(0, 200)));

    const picXml = images.slice(0, 12).map(u => `<PictureURL>${esc(u)}</PictureURL>`).join("");

    if (existingId) {
      // ReviseItem — update existing listing
      const fields = [
        `<ItemID>${esc(existingId)}</ItemID>`,
        `<Title>${esc(title.slice(0, 80))}</Title>`,
        `<Description><![CDATA[${plainToHtml(description || title)}]]></Description>`,
        `<StartPrice>${Number(price).toFixed(2)}</StartPrice>`,
        `<Quantity>${Math.max(1, parseInt(quantity, 10))}</Quantity>`,
        ...(picXml ? [`<PictureDetails>${picXml}</PictureDetails>`] : []),
        `<ShippingDetails><ShippingServiceOptions><ShippingServicePriority>1</ShippingServicePriority><ShippingService>USPSMedia</ShippingService><ShippingServiceCost>${Number(shippingCost).toFixed(2)}</ShippingServiceCost></ShippingServiceOptions></ShippingDetails>`,
      ];
      const { ok, xml } = await trading("ReviseItem", `<Item>${fields.join("")}</Item>`);
      if (!ok) {
        // Item gone on eBay — fall through to create a fresh one below
        const errCode = xmlTag("ErrorCode", xml);
        if (errCode !== "17" && errCode !== "291") {
          return res.status(500).json({ error: xmlTag("LongMessage", xml) || "ReviseItem failed" });
        }
      } else {
        return res.json({ ok: true, itemId: xmlTag("ItemID", xml), isNew: false });
      }
    }

    // AddItem — create new listing
    const itemXml = `
      <Title>${esc(title.slice(0, 80))}</Title>
      <Description><![CDATA[${plainToHtml(description || title)}]]></Description>
      <PrimaryCategory><CategoryID>${esc(String(categoryId))}</CategoryID></PrimaryCategory>
      <StartPrice>${Number(price).toFixed(2)}</StartPrice>
      <ConditionID>${esc(String(conditionId))}</ConditionID>
      <Country>IN</Country>
      <Location>India</Location>
      <Currency>USD</Currency>
      <ItemSpecifics>
        <NameValueList>
          <Name>Brand</Name>
          <Value>Unbranded</Value>
        </NameValueList>
        <NameValueList>
          <Name>Type</Name>
          <Value>Crystal</Value>
        </NameValueList>
      </ItemSpecifics>
      <DispatchTimeMax>5</DispatchTimeMax>
      <ListingDuration>GTC</ListingDuration>
      <ListingType>FixedPriceItem</ListingType>
      <Quantity>${Math.max(1, parseInt(quantity, 10))}</Quantity>
      ${picXml ? `<PictureDetails>${picXml}</PictureDetails>` : ""}
      <ShippingDetails>
        <ShippingServiceOptions>
          <ShippingServicePriority>1</ShippingServicePriority>
          <ShippingService>USPSMedia</ShippingService>
          <ShippingServiceCost>${Number(shippingCost).toFixed(2)}</ShippingServiceCost>
        </ShippingServiceOptions>
      </ShippingDetails>
      <Site>US</Site>
    `;
    const { ok, xml } = await trading("AddItem", `<Item>${itemXml}</Item>`);
    if (!ok) {
      return res.status(500).json({ error: xmlTag("LongMessage", xml) || "AddItem failed" });
    }
    const newItemId = xmlTag("ItemID", xml);
    return res.json({ ok: true, itemId: newItemId, isNew: true,
      url: `https://www.ebay.com/itm/${newItemId}` });
  }

  // ── end_item — EndItem (delete/end listing) ──────────────────────────────
  if (action === "end_item") {
    const itemId = url.searchParams.get("item_id");
    if (!itemId) return res.status(400).json({ error: "item_id required" });
    const { ok, xml } = await trading("EndItem", `
      <ItemID>${itemId}</ItemID>
      <EndingReason>NotAvailable</EndingReason>
    `);
    if (!ok) return res.status(500).json({ ok: false, error: xmlTag("LongMessage", xml) || "EndItem failed" });
    return res.json({ ok: true, itemId });
  }

  return res.status(400).json({ error: "Unknown action" });
}
