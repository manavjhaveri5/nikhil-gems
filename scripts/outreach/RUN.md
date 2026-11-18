# Refreshing the wholesale outreach list

These scripts run on the Mac with the ERP's `.env`. None of them sends a message: Sejal sends by hand from the ERP's **Wholesale Outreach** page. The playbook lives in `src/outreach/playbook.md` and is shown on the page.

```
D=scratchpad/outreach
node scripts/outreach/find-etsy.mjs $D/etsy.json                 # Etsy Open API, shops shipping from target countries (~40 min)
node scripts/outreach/resolve.mjs  $D/etsy.json $D/etsy-res.json # guess a website for shops that list none (title must match)
node scripts/outreach/enrich.mjs   $D/etsy-res.json $D/etsy-enr.json   # email, Instagram and stock signals from their own site
node scripts/outreach/resolve.mjs  $D/seed.json $D/web.json      # named walk-in shops from web research → website
node scripts/outreach/enrich.mjs   $D/web.json $D/web-enr.json
node scripts/outreach/build-leads.mjs $D/leads.json $D/web-enr.json $D/etsy-enr.json   # dedupe vs trade buyers, score, drafts
node scripts/outreach/outreach-push.mjs leads $D/leads.json --dry && node scripts/outreach/outreach-push.mjs leads $D/leads.json
```

- Re-pushing keeps Sejal's stage, dates, notes and history, and updates only the research and the drafts.
- `find-osm.mjs` (OpenStreetMap) works but the public Overpass servers time out often, and few crystal shops are tagged there. Use it only as an extra.
- Instagram can't be searched through Meta's API. Handles come from the shops' own websites, or Sejal looks them up by hand.
- Check a sample of drafts before pushing. Wrong website guesses happen. The resolver checks the page title, but a shop with a generic name can still match the wrong business.
