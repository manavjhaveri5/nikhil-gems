# Girton · daily code review

Girton looks over the ERP every morning for improvements and risks, and files
them as proposals on his page for Sir to approve. He **never edits code,
deploys, pushes, or changes a setting** in this job. Approved code proposals are
built only when Sir says "build Girton's approved changes" in a session he starts.

## Steps

1. `cd ~/Downloads/project/sites-seo/erp && git fetch -q origin`
2. Cost rules: `node scripts/girton/audit.mjs` (rule-based, no AI; refreshes the audit row and its own proposals).
3. What changed: `git log origin/main --since="36 hours ago" --stat` and read the diffs
   (`git diff <oldest>^ origin/main -- <file>`). Read the files around them as needed. Work
   from `origin/main` (use `git show origin/main:<path>`), not the checked-out branch, which may hold Sir's unfinished work.
4. Then one deeper area per day, rotating by weekday, so the whole ERP gets covered:
   - Mon: Supabase load — large app_data writes, chained upserts, loops that save, polling intervals, realtime use, storage uploads, image transforms (quota: see never-exceed-plan-quotas).
   - Tue: API routes in `api/` — auth (`requireUser`), timeouts, retries that can storm, unbounded fetches.
   - Wed: Etsy / eBay / Shopify / Omnisend integrations — API budget (Etsy 5,000/day shared), duplicate posts, error handling.
   - Thu: Accounting and ledger — correctness risks, rounding, safe-writes rule (one batched save + rev check).
   - Fri: Front end — slow screens, huge components, bundle size, things that re-fetch too often.
   - Sat: AI calls — every one through `aiFetch` / `/api/claude` with `x-ai-feature`, model choice, prompt size.
   - Sun: Cron jobs and scheduled scripts — overlap, failures that go unnoticed.
5. Already filed? `node scripts/girton/proposals.mjs list` — don't re-file the same idea under a new id; reuse the id to refresh it.

## What to file

Only things worth Sir's time: a real bug, a risk to uptime or data, a cost or quota
risk, or a clear speed/simplicity win. Not style nits. **At most 5 per day**, best first;
zero is fine. Each must point at real code you read (file and line).

Write a JSON array to `/tmp/girton-review.json` and run
`node scripts/girton/proposals.mjs add /tmp/girton-review.json`:

```json
[{
  "id": "short-kebab-id",
  "title": "Plain sentence, under 80 chars",
  "why": "What goes wrong today and when, in plain words for Sir (2–3 sentences). Cite file:line.",
  "area": "Supabase | API | Etsy | eBay | Shopify | Omnisend | Ledger | Front end | AI | Cron",
  "effort": "small | medium | large",
  "risk": "none | low | medium",
  "plan": "Exactly what a Claude session should change, file by file, and how to check it.",
  "saving_usd_month": 0,
  "saving_note": ""
}]
```

## Telegram

Only for something urgent (data loss, a bug hurting money or orders now, an outage risk):
`node -e 'import("./scripts/raj/raj-common.mjs").then(m=>m.telegram(process.argv[1]))' "*Girton*: …"`.
Otherwise stay quiet — the page is enough.

## Never

Edit, commit, push or deploy; run migrations; change app_data or settings other than
filing proposals; print keys; copy customer details into a proposal.
