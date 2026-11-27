# Atyahara Meta ads: everything we know (as of 15 Nov 2026)

Sources: Meta region export (`~/Downloads/meta-export/region.csv`, 1 Jul 2025 – 6 Nov 2026),
Ads Manager campaign view (15 Nov 2026), and atyahara.com Shopify orders attributed with
`node scripts/ads/ad-orders.mjs`. Ad account 229573559578787, pixel "atyahara" 945965710697244.

## Sir's standing rule (16 Nov 2026), which overrides any "wait for the festival" advice
The Mini Gemstone Ganesha is an **all-year product**. Ads run all year, and nobody waits for Sankranti or Ganesh Chaturthi.
- **Not selling → the creative is the problem.** Recommend a new creative (brief Soniya: new hook, format and angle).
  Don't recommend pausing, waiting for the season or cutting the budget.
- **Selling (for example, a bulk order) → recommend more spend.** Scale in steps of about 20–30% of the daily budget
  so Meta's learning isn't reset, and say how much to top up the prepaid funds.
- Only Sir changes the budget, the creative or the funds. The desk recommends with numbers.
- The festival history below explains past numbers. Under this rule, weak months are a creative problem, not a reason to stop.

## Attribution gotcha (read first)
Since late Jul 2026, orders go through the Shiprocket "fastrr" checkout (app 358523895809). It puts the
UTM tags in **note_attributes**, not `landing_site`. Until 15 Nov 2026 Alex's report read only
`landing_site`, so it showed 23 Meta orders when the real figure is **46**. Raj's `lib/raj-orders.js`
already read note_attributes correctly. Meta tags: utm_campaign = campaign id, utm_term = ad set id,
utm_content = ad id.

## Totals (fact)
- Meta spend 1 Jul 2025 – 6 Nov 2026: **₹64,154**, 270k impressions, 12,631 clicks.
- atyahara.com all-time: 67 valid orders, ₹91,284. **Meta-tagged: 46 orders, ₹57,647 (63%).**
- Revenue ÷ spend across all Meta campaigns: **about 0.90**. That is revenue, not profit: product
  costs are still missing, so no margin or profit claim can be made.

## By campaign (fact; Meta purchases use Meta's 7-day-click/1-day-view count)
| Campaign | When | Spend ₹ | Meta purchases | Shopify-tagged orders, ₹ | Revenue ÷ spend |
|---|---|---|---|---|---|
| SALE-MINI-01 (live; ad set grid_concept_all4; ad [18/8]mix4_02) | 18 Aug 2026 → | 11,490 | 16 | 15 orders, ₹14,865 (mix4_02 alone: 12, ₹12,700) | 1.29 |
| SALE-ALL-001 (id 120250285844060323) | late Jul – Aug 2026 | 8,475 | 13 | 11 orders, ₹11,485 | 1.36 |
| New Sales campaign – Purchase | Apr 2026 | 1,595 | 3 | 2 orders, ₹3,000 | 1.88 |
| DIWALI-MUMBAI-MINI-GANESHA-05NOV | 5 Nov 2026 | 2,325 | 0 | 0 (204 clicks) | 0 |
| 2025 Ganesh season (Initial ₹25,485 is the bulk; ids 120229834771600323 and 120230215488390323) | Jul – Sep 2025 | ≈25–30k | n/a | 17 orders, ₹18,148, plus 2 Facebook/Instagram referrals, ₹10,148 | ≈1.0 |
| New Sales campaign – ATC | 2025 | 6,503 | 0 purchases (88k impressions, 5,113 clicks: cheap traffic) | none traced | 0 |
| Phase A / Retarget / New Sales campaign / catalogue 16/11/2025 | 2025 | 4,189 / 1,644 / 1,553 / 895 | none traced | none traced | ≈0 |

## Lessons (evidence)
1. **Ads sell around Ganesh Chaturthi, and nearly nothing outside it.** Aug 2025: 24 orders. Aug 2026: 20.
   After the festival, SALE-MINI-01 made 5 Meta orders in Sep, 0 in Oct and 1 in Nov (5 Nov, ₹749, Telangana).
2. **The Mini Gemstone Ganesha (₹550–799) is the product that converts.** Bigger or premium pieces
   rarely sell from ads. Multi-piece baskets happen in festival weeks: 2.6 pieces per order in Aug 2025,
   1.5 in Aug 2026.
3. **Purchase-optimised campaigns work; traffic and add-to-cart campaigns don't.** ATC bought 5,113
   clicks and no traced sales.
4. **A gift angle off-season failed:** Diwali Mumbai, ₹2,325, 204 clicks, 0 sales.
5. **Regions:** buyers are in MH, KA, TS, TN, DL, HR, AP. UP, Bihar, Rajasthan, MP, Gujarat and WB give cheap
   clicks and 0–2.6 orders per 1k clicks. Those 6 states were excluded from grid_concept_all4 on 15 Nov 2026.
6. **SALE-MINI-01 lifetime benchmarks** (use these to call something abnormal):
   - CPC ₹8.7, CTR 3.3%, CPM ₹284.
   - About ₹718 per Meta purchase, against an average order of about ₹990.
7. **Meta's purchase count is a little higher than Shopify-tagged orders** (16 vs 15, 13 vs 11, 3 vs 2):
   view-through and cross-device sales. Judge on Shopify-tagged orders and use Meta's count as the upper bound.

8. **The 5-stone "POV" creatives (set5_home_chai, set5_desk) lost to mix4_02** (19–21 Nov 2026): ₹765 spent, link clicks at ≈₹15 (vs ₹8.15 for mix4_02), CTR ≈2.2%, 0 sales. Adding them to the ad set made Meta move all spend off mix4_02 (₹0 on 20 Nov), which stopped sales. Lesson: test new creatives in their own small ad set, not beside the winner.

## The restart (15 Nov 2026)
- Sir loaded ₹3,304 (prepaid) and restarted SALE-MINI-01 at **₹550/day** with no end date.
- First spend was confirmed 15 Nov: about ₹75, with ₹3,228.50 left. At that rate the funds last about 6 days.
- Sir's rule (16 Nov): there is no off-season. On 16 Nov the ad sold ₹2,850 (Delhi, 5 Mini Ganeshas)
  on about ₹580 spent, so it sells now. Grow spend while it sells, and change the creative when it stops.
- Questions this restart answers: does excluding the 6 states lower cost per sale, and is there any
  off-season demand for the Mini Ganesha at all?
