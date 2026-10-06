/* Social → Stories: the Instagram story queue (pieces just listed, pieces just
   sold, any past piece), the same one Listing Manager had, as a page here. */
import { useEffect, useMemo, useState } from "react";
import { C } from "./lmTheme.js";
import { loadK, loadKFresh } from "./utils.js";
import { useStoriesDone } from "./storyState.js";
import { isLive } from "./ListingGrid.jsx";
import { loadStoreFacts } from "./StoreApp.jsx";
import { loadTradeFacts } from "./TradeSiteApp.jsx";
import StoryQueue from "./StoryQueue.jsx";

export default function SocialStories() {
  const [listings, setListings] = useState(null);
  const [orders, setOrders] = useState([]);
  const [store, setStore] = useState({});
  const [trade, setTrade] = useState({});
  const stories = useStoriesDone();
  useEffect(() => {
    loadK("ng-listings-v1").then(l => setListings(Array.isArray(l) ? l : [])).catch(() => setListings([]));
    /* Saved orders, plus the last eight days of Etsy sales straight from Etsy:
       new sales only reach the saved orders when Orders is opened, and a sold
       story shouldn't wait for that. */
    const since = Math.floor((Date.now() - 8 * 864e5) / 1000);
    Promise.all([
      loadKFresh("ng-orders-v1").catch(() => loadK("ng-orders-v1")).then(o => Array.isArray(o) ? o : []).catch(() => []),
      fetch(`/api/etsy?action=orders&limit=100&enrich=false&min_created=${since}`).then(r => r.ok ? r.json() : { results: [] }).catch(() => ({ results: [] })),
    ]).then(([saved, etsy]) => {
      const have = new Set(saved.map(o => o.id));
      const fresh = (etsy.results || []).flatMap(rc => (rc.transactions?.length ? rc.transactions : [null]).map((tx, i) => ({
        id: `etsy-${rc.receipt_id}-${tx?.transaction_id || tx?.listing_id || i}`, platform: "etsy", platform_order_id: String(rc.receipt_id),
        etsy_listing_id: tx?.listing_id || "", listing_title: tx?.title || "", listing_image: tx?.image_data?.url_570xN || tx?.image_data?.url_fullxfull || "",
        status: /cancel/i.test(rc.status || "") ? "cancelled" : "sold", created_at: new Date((rc.create_timestamp || rc.created_timestamp || 0) * 1000).toISOString(),
      }))).filter(o => !have.has(o.id));
      setOrders([...saved, ...fresh]);
    });
    loadStoreFacts().then(setStore).catch(() => {});
    loadTradeFacts().then(setTrade).catch(() => {});
  }, []);
  const facts = useMemo(() => ({ store, trade }), [store, trade]);
  const live = useMemo(() => l => isLive(l, facts), [facts]);
  if (!listings) return <div style={{ color: C.inkFaint, fontSize: 13 }}>Loading…</div>;
  return <StoryQueue inline listings={listings} orders={orders} isLive={live} stories={stories} onClose={() => {}} />;
}
