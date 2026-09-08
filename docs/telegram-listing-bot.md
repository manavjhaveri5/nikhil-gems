# Telegram listing bot

Post a product to the Listing Manager from your phone: send the photos to the
Gem bot with a caption, and a draft listing is waiting in the ERP by the time
you put the phone down.

**Nothing the bot writes is live.** A post creates a draft in `ng-listings-v1`
with its photos, copy and price; Etsy and Shopify publishing stays in Listing
Manager, where the platform toggles and the price checks are.

## Posting

```
/list amethyst sphere 60mm $45 box A12 #crystal #gift
```

Send it as the caption on a photo — or on an album, and all the photos land on
one listing. A photo sent as a *file* (uncompressed) works the same way.

Bulk session: `/listmode on` makes every photo a listing with no caption
needed, `/listmode off` ends it. `/listings` shows the last few drafts and
whether any are live yet.

Without a photo, `/list labradorite tower 12 inch ₹12500` still drafts the
listing — add the photos in Listing Manager. You can also just ask ("list an
amethyst sphere at $45"); the assistant has the same `create_listing` tool.

A plain photo with no `/list` caption is untouched — it is still read as a
payment screenshot or a stock note, as before.

## What the caption can carry

| In the caption | Becomes |
| --- | --- |
| `$45` / `₹3800` / `rs 3800` | Price. Give one and the other is converted at `LISTING_USD_INR` (default 84); the reply says so. USD fills Earth Editions + eBay, INR fills Etsy + Atyahara. |
| `60mm`, `2.5"`, `12 inch` | Size |
| `320g`, `1.2kg` | Weight |
| `x3`, `qty 20`, `5 pcs` | Quantity — more than one makes it a repeatable listing rather than a unique piece |
| `box A12`, `stk 7` | Storage location |
| `from Madagascar` | Origin |
| `sku RQ-01` | SKU |
| `#crystal #gift` | Tags, ahead of the AI's own |

Everything left over is the product, and the caption always beats what the AI
thinks it sees in the photo.

## What the bot fills in

Vision over the photos plus the caption writes the title, material, category,
description and up to 13 Etsy-legal tags. The category picks the shape,
product type, Etsy taxonomy id and shop section from
`lib/listingCategories.js` — the same table the listing form uses. If the AI
call fails the draft is still saved, from the caption alone, and the reply
says so.

## Album handling

Telegram delivers an album as one webhook per photo, which can run
concurrently. Each photo files itself into `<bot>-tg-listing-albums-v1` through
the atomic `app_data_upsert_item` RPC; the lowest `message_id` then waits
`ALBUM_SETTLE_MS` (5s), writes the single listing, and marks the album done. A
photo that arrives after that appends itself to the listing rather than
starting a second one. Buffer rows are pruned after two hours.

## Environment

Nothing new is required — the bot already needs `TELEGRAM_BOT_TOKEN`,
`OPENAI_KEY` and the Supabase service key. Optional:

- `TELEGRAM_LISTING_MODEL` — vision model for listing copy (default
  `TELEGRAM_OPENAI_MODEL`, else `gpt-4.1-mini`)
- `LISTING_USD_INR` — rate used when a caption gives only one currency (default 84)
