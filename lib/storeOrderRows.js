/* A paid eartheditions.co order as Listing Manager → Orders rows: one per
   piece, shaped like the Etsy rows beside them so the list, grouping, address
   and invoices read them the same way.

   - order_number is the store's own number (EE-1003, or EE-1003-1, -2… for a
     several-piece order), as Etsy rows carry ETSY-<receipt>-<n>; the address is
     in the flat ship_* fields the order card reads.
   - A code (WELCOME10) comes off the order as a whole; it is shared across the
     pieces by value, as Etsy coupons are, so each sale_price is what was really
     paid for that piece.
   - date is the order's day in India, where the shop works: a 4am order is
     dated that morning, not the evening before in UTC. */
const istDate = ts => new Date(Date.parse(ts) + 5.5 * 3600e3).toISOString().slice(0, 10);

export function storeOrderRows(order, listings = []) {
  const lines = order.lines || [];
  const a = order.shipping || {};
  const at = order.created_at || new Date().toISOString();
  const lineTotal = l => (+l.price || 0) * (l.qty || 1);
  const goods = lines.reduce((t, l) => t + lineTotal(l), 0);
  const code = order.discount_code || /\bCode (\w+)/.exec(order.notes || "")?.[1] || "";
  return lines.map((line, i) => {
    const L = listings.find(x => x.id === line.listing_id);
    const discount = goods > 0 ? Number(((+order.discount || 0) * lineTotal(line) / goods).toFixed(2)) : 0;
    return {
      id: `store-${order.number}-${i + 1}`,
      order_number: lines.length > 1 ? `${order.number}-${i + 1}` : order.number,
      listing_id: line.listing_id || "", listing_title: line.title || L?.title || "",
      listing_material: L?.material || "", listing_shape: L?.shape || "", listing_sku: line.sku || L?.sku || "",
      listing_order_id: L?.listing_order_id || "", listing_image: line.image || L?.images?.[0] || "",
      ...(line.variant ? { variations: [{ name: "Option", value: line.variant }] } : {}),
      platform: "store", platform_order_id: order.number,
      transaction_id: order.stripe_payment || "",   // Stripe payment, or Razorpay's
      sale_price: Number(Math.max(0, lineTotal(line) - discount).toFixed(2)),
      ...(discount ? { list_price: lineTotal(line), discount, discount_code: code } : {}),
      currency: String(order.currency || "usd").toUpperCase(), qty: line.qty || 1,
      buyer_name: order.name || a.name || "", buyer_email: order.email || "", buyer_country: a.country || "",
      ship_name: order.name || a.name || "", ship_address1: a.line1 || "", ship_address2: a.line2 || "",
      ship_city: a.city || "", ship_state: a.state || "", ship_postcode: a.postal_code || "",
      ship_country: a.country || "", ship_phone: order.phone || a.phone || "",
      status: "sold", date: istDate(at), notes: order.notes || "", created_at: at,
    };
  });
}
