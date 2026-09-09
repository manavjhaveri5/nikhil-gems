# Telegram listing bot

Post a product from your phone. Send the photos (or a video) to the master
Nikhil Gems bot with **one line — the name and the price** — and by the time
you put the phone down there is a listing in Listing Manager and a draft on
Etsy.

```
Amethyst sphere 60mm $45
```

- **Listing Manager** — a listing in `ng-listings-v1` with the media, copy,
  tags and price.
- **Etsy** — created as a *draft*. A draft is private: it is not on sale until
  it is activated, in Listing Manager or on Etsy.
- **eBay** — only when the line says `ebay`. eBay has no draft state, so that
  one goes **live** at the price in the line. The word is stripped from the
  product name.

The line you type is the product name on every platform. The AI fills in the
material, category, description and up to 13 Etsy-legal tags around it — it
does not rename your piece.

## The line

| In the line | Becomes |
| --- | --- |
| `$45` / `₹3800` / `rs 3800` | Price. Give one and the other is converted at `LISTING_USD_INR` (default 84); the reply says so. USD prices Earth Editions + eBay, INR prices Etsy + Atyahara. |
| `ebay` | Also list it live on eBay at the USD price |
| `60mm`, `2.5"`, `12 inch` | Size |
| `320g`, `1.2kg` | Weight |
| `x3`, `qty 20`, `5 pcs` | Quantity — more than one makes it a repeatable listing rather than a unique piece |
| `box A12`, `stk 7` | Storage location |
| `from Madagascar` | Origin |
| `sku RQ-01` | SKU |
| `#crystal #gift` | Tags, ahead of the AI's own |

Everything left over is the product name. None of the shorthand — box numbers,
`ebay`, the raw line — reaches a buyer: the description a shopper sees is the
AI copy plus a specs block, and the original caption is kept on the ERP record
as `telegram_caption`.

**No price in the line** → nothing is sent to Etsy; it waits in Listing Manager
as a draft until you price it.

## What is and isn't a listing

| You send | What happens |
| --- | --- |
| Photos/video + a product line | Listing + Etsy draft (+ eBay if said) |
| Photos/video + a line about money or stock (`paid`, `received`, `invoice`, `add to stock`, …) | Unchanged — the assistant logs the payment or the stock note |
| A photo with no caption | Unchanged — read as a screenshot |
| A video with no caption | Unchanged — the old flat workflow: an Earth Editions Shopify draft with a linked stock item |
| `/listmode on` | Every photo becomes a listing, caption optional, until `/listmode off` |
| `/list …` with no photo | ERP draft only — Etsy needs photos |

`/listings` shows the last few and where each one is live. The assistant also
has `create_listing` and `get_listings` tools for listings dictated in chat;
`create_listing` writes an ERP draft and never publishes.

## Albums

Telegram delivers an album as one webhook per file, which can run
concurrently. Each file uploads itself and files a row in
`<bot>-tg-listing-albums-v1` through the atomic `app_data_upsert_item` RPC; the
lowest `message_id` then waits `ALBUM_SETTLE_MS` (5s), writes the single
listing they all belong to, publishes it, and marks the album done. A file that
lands after that is added to the listing in the ERP rather than starting a
second one (it is not pushed to the marketplaces — re-sync from Listing Manager
for that). Buffer rows are pruned after two hours.

## Publishing internals

`publishEtsy` (exported from `api/listing-manager.js`) is called in-process with
`activate: false`, so the same code path and taxonomy the listing form uses
makes the draft, uploads the photos and attaches the video. `publishEbayListing`
(exported from `api/ebay.js`, extracted from its `publish_listing` route) does
the eBay side. Whatever comes back is stamped onto `listing.platforms`, so
Listing Manager shows the listing as published there and re-syncs to the same
item instead of creating a second one.

Because an album upload to Etsy plus an eBay AddItem all happen inside the one
webhook, `api/telegram.js` runs with `maxDuration: 300`. The bot replies as soon
as the ERP listing is saved and again when the marketplaces answer, so a slow
upload never looks like a dropped post.

## Environment

Nothing new is required. Existing vars in play: `TELEGRAM_BOT_TOKEN`,
`OPENAI_KEY`, the Supabase service key, the Etsy OAuth pair used by
`lib/etsy-auth.js`, and `EBAY_USER_TOKEN` (plus the eBay app/dev/cert ids) for
the eBay path. Optional:

- `TELEGRAM_LISTING_MODEL` — vision model for listing copy (default
  `TELEGRAM_OPENAI_MODEL`, else `gpt-4.1-mini`)
- `LISTING_USD_INR` — rate used when a line gives only one currency (default 84)
