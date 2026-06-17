# Browser LocalStorage Recovery

The app caches all Supabase data in your browser's localStorage under the key
`ng-sb-cache-v1`. If the data was lost *after* you last had it open on this
browser, the old buying plan may still be sitting in that cache.

## Step 1 — Extract the cached data

Open the app in Chrome/Safari, then open DevTools (F12 or Cmd+Option+I) and
paste this into the **Console** tab:

```js
(function() {
  const raw = localStorage.getItem('ng-sb-cache-v1');
  if (!raw) { console.error('No cache found'); return; }
  const cache = JSON.parse(raw);
  const shows = cache['ng-shows-v1'];
  if (!shows || !shows.length) { console.error('No shows in cache'); return; }

  shows.forEach(show => {
    const bp = show.buyingPlan || [];
    const gi = bp.filter(r => (r.vendor||'').toUpperCase().includes('GEMSTONES INFINITY'));
    console.log(`%c${show.name}`, 'font-weight:bold; font-size:14px');
    console.log(`  Total buying plan rows: ${bp.length}`);
    console.log(`  GEMSTONES INFINITY rows: ${gi.length}`);
    if (gi.length) {
      const stones = [...new Set(gi.map(r => r.stone).filter(Boolean))];
      console.log(`  GI stones: ${stones.join(', ')}`);
      console.table(gi.map(r => ({ stone: r.stone, shape: r.shape, qty: r.qty, unit: r.unit, vendor: r.vendor, cp: r.costPerKg })));
    }
    console.log('');
  });

  // Download the full cache as a JSON file
  const blob = new Blob([JSON.stringify(cache, null, 2)], {type: 'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ng-cache-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.json`;
  a.click();
  console.log('%cJSON file downloaded — keep it safe!', 'color:green; font-weight:bold');
})();
```

This will:
- Print a summary of every show's buying plan (with GEMSTONES INFINITY row counts)
- Download the full cache as a JSON file to your Downloads folder

## Step 2 — If the cache has the missing rows

If the console shows MORE than 43 GEMSTONES INFINITY rows for Denver, the old
data is still in your browser cache. Run the recovery script on your Mac to
restore it to Supabase:

```
node recover-buying-plan.mjs
```

Then open a new browser tab to the app — it will load fresh from Supabase.

## Step 3 — If the cache is already showing the reduced data

The browser cache was updated at the same time as Supabase (they're synced on
every save). In this case you'll need point-in-time recovery from Supabase:

1. Go to your Supabase Dashboard → **Project Settings** → **Backups**
2. If you're on a Pro or higher plan, you can restore to a point before the
   data was lost
3. After restoring, run `node recover-buying-plan.mjs` to verify the data
   came back
