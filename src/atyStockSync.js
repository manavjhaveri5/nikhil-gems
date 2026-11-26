// Rebuilds Atyahara's accounting stock (at-acc-stock-v1) from the documents.
// Called after anything that changes it: an NG invoice to Atyahara, an Atyahara
// sales invoice, a purchase bill, a category link from the orders flow, or an
// adjustment. Calls within ~1.5s are folded into one rebuild.
import { loadK, loadKFresh, saveK } from "./utils.js";
import { buildAtyStock, AT_ACC_STOCK_KEY } from "./atyStock.js";

let timer = null, running = null, again = false;

export async function rebuildAtyStockNow() {
  if (running) { again = true; return running; }
  running = (async () => {
    try {
      const [ngInvoices, atInvoices, atPurchases, customsRows, prev, ngStock] = await Promise.all([
        loadKFresh("ng-invoices-v2"), loadKFresh("at-invoices-v1"), loadKFresh("at-purch-v1"),
        loadK("ng-customs-descs-v1"), loadKFresh(AT_ACC_STOCK_KEY), loadK("ng-stock-v5"),
      ].map(p => p.catch(() => [])));
      const { entries, unsorted } = buildAtyStock({ ngInvoices, atInvoices, atPurchases, customsRows, prev, ngStock });
      await saveK(AT_ACC_STOCK_KEY, entries, { merge: false });
      window.dispatchEvent(new CustomEvent("aty-stock-updated", { detail: { entries, unsorted } }));
      return { entries, unsorted };
    } finally {
      running = null;
      if (again) { again = false; requestAtyStockRebuild(); }
    }
  })();
  return running;
}

export function requestAtyStockRebuild(delay = 1500) {
  clearTimeout(timer);
  timer = setTimeout(() => { rebuildAtyStockNow().catch(e => console.warn("Atyahara stock rebuild failed:", e?.message || e)); }, delay);
}
