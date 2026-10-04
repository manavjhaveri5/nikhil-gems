/* Social → Stories: the Instagram story queue (pieces just listed, pieces just
   sold, any past piece), the same one Listing Manager had, as a page here. */
import { useEffect, useMemo, useState } from "react";
import { C } from "./lmTheme.js";
import { loadK } from "./utils.js";
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
    loadK("ng-orders-v1").then(o => setOrders(Array.isArray(o) ? o : [])).catch(() => {});
    loadStoreFacts().then(setStore).catch(() => {});
    loadTradeFacts().then(setTrade).catch(() => {});
  }, []);
  const facts = useMemo(() => ({ store, trade }), [store, trade]);
  const live = useMemo(() => l => isLive(l, facts), [facts]);
  if (!listings) return <div style={{ color: C.inkFaint, fontSize: 13 }}>Loading…</div>;
  return <StoryQueue inline listings={listings} orders={orders} isLive={live} stories={stories} onClose={() => {}} />;
}
