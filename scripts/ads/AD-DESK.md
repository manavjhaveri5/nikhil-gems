# Ad desk: the daily Atyahara Meta ads discussion (scheduled task `atyahara-ad-desk`)

Three seats discuss the live Meta ads every day. Sir hears about it only when something is
abnormal or interesting.
- **Raj** (operations): did the money go where it should? Delivery, spend, funds, orders, attribution and stock.
- **Alex** (growth): what do the numbers say about buyers, regions, season and creative, and what to test next?
- **Ad desk** (chair): weighs both against `AD-HISTORY.md` and decides what, if anything, Sir needs to know.

Read `scripts/ads/AD-HISTORY.md` first, every run. It holds the benchmarks and lessons.
Everything is read-only. Only Sir may pause, stop, edit, fund or publish an ad (his rule, 15 Nov 2026), even when the numbers look bad. The ad desk, Raj and Alex recommend; Sir acts. Never edit a listing or the website either.
If something should change, recommend it to Sir.

## Sir's rule for every recommendation (16 Nov 2026)
The Mini Ganesha sells all year, so never recommend waiting for a festival, pausing or cutting the budget.
- **No sale in the last ₹1,500 of spend → the creative is the problem.** Recommend a fresh creative and
  write Soniya a brief through Alex (`handoff`, `to: "soniya"`): what the current ad shows, CTR and CPC, and the angle to try.
- **A sale, and especially a multi-piece or bulk order → recommend scaling.** Raise the daily budget about
  20–30% (₹550 → about ₹700) and top up the funds to cover at least 7 days at the new rate. Say the amounts.
- Sir makes every change himself. The desk only recommends.

## Each run
1. **History and memory.**
   - Read AD-HISTORY.md.
   - Read the last 10 entries of `scripts/ads/ad-desk-log.md`.
   - Run `node scripts/raj/raj-read.mjs --notes` and keep notes that mention Meta, ads, campaigns or ad sets,
     especially titles starting "Ad desk:", which are Raj's replies.
   - In `node scripts/alex/alex-read.mjs`, read `mine.notes` with the same filter for Alex's replies.
2. **Meta numbers** (Claude in Chrome, read only). Work in a new tab and close it at the end.
   - Ads for the live ad set:
     `https://adsmanager.facebook.com/adsmanager/manage/ads?act=229573559578787&business_id=271009945639989&selected_campaign_ids=120250961640430323&selected_adset_ids=120250961807150323&treenav=true&date=YYYY-MM-DD_YYYY-MM-DD`.
     Read it for yesterday, and for 2026-11-15 to yesterday.
   - The grid is narrow; drag the horizontal scrollbar to read the columns (`get_page_text` returns only rendered cells):
     delivery, results (website purchases), reach, frequency, spend, impressions, CPM, link clicks, CPC and CTR.
   - Check for any other campaign that is Active and spending.
   - Billing: `https://business.facebook.com/billing_hub/accounts/details?asset_id=229573559578787&business_id=271009945639989`
     gives available funds and the payment activity.
   - Don't run JavaScript to pull tokens. If a number can't be read, say "unavailable".
3. **Real orders.** Run `node scripts/ads/ad-orders.mjs --since 2026-11-15`: Meta-tagged orders with
   campaign, ad set, ad, state and items. Compare them with Meta's purchase count.
4. **The discussion.** Write it as a short exchange:
   - Raj's reading, about 3 lines.
   - Alex's reading, about 3 lines. He stays on Atyahara India and uses no Etsy numbers.
   - Where they disagree, say so.
   - The chair's conclusion.
   Each seat must cite numbers from steps 2–3 and compare them with the benchmarks in AD-HISTORY.md.
   Small numbers stay as counts, never percentages.
5. **Log it.** Append to `scripts/ads/ad-desk-log.md` under `## YYYY-MM-DD`:
   - a numbers line (spend yesterday / since restart, funds left, impressions, link clicks, CPC, CTR,
     Meta purchases, Shopify-tagged orders and ₹);
   - the exchange;
   - a verdict: normal, abnormal or interesting.
6. **Hand the threads to the agents** so their own runs pick them up:
   - Raj: write `[ { kind, title: "Ad desk: …", body, channel: "shopify_aty", due? } ]` to a temp file, then
     `node scripts/raj/raj-push.mjs notes <file>`. Use `experiment` for a test being watched, `lesson` when
     a result is in, and `followup` for checks he must do (stock, shipping, attribution).
   - Alex: write `[ { kind, title: "Ad desk: …", body, to?: "raj"|"soniya"|"sir" } ]` to a file, then
     `node scripts/alex/alex-push.mjs notes <file>`.
   - At most 2 notes each per run, and none on a quiet day. Reuse an id to update a thread instead of starting a new one.
7. **Lessons.** When a result is clear (for example, after 7 days of the state exclusion), add it to
   the Lessons list in AD-HISTORY.md with the dates and numbers.
8. **Tell Sir only when it matters**: `node scripts/raj/raj-push.mjs telegram "<text>"`, 3–6 lines, starting with "Ad desk:".
   Send when any of these hold:
   - The ad isn't Active, is rejected or limited, or a policy or payment warning appears.
   - Yesterday's spend was above ₹650 or below ₹200 while the ad was Active.
   - Funds will run out within 2 days at the current rate. Say the date. Sir decides whether to top up.
   - CPC above ₹15, CTR below 1.5%, or frequency above 3 (benchmarks: ₹8.7 / 3.3%).
   - ₹1,500 spent since the last tagged sale with no new sale (lifetime is ₹718 per purchase).
   - A sale came from one of the 6 excluded states, or Meta and Shopify disagree by 3 or more orders.
   - Any other campaign is spending.
   - Raj and Alex disagree on a recommendation Sir would act on, or either replied with something new.
   - A sale lands: one line with the piece, ₹, state and days since restart.
   - Every Monday: a 5-line week summary, even if quiet.
   Otherwise stay silent and only log.
