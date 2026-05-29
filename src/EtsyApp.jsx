import { useState, useEffect, useRef, useCallback } from "react";
import { loadK, loadKFresh, saveK } from "./utils.js";

/* ── theme ───────────────────────────────────────────────────────────────── */
const C = {
  bg:"var(--c-bg)", surface:"var(--c-surface)", card:"var(--c-card)",
  border:"var(--c-border)", borderHi:"var(--c-borderHi)",
  ink:"var(--c-ink)", inkMid:"var(--c-inkMid)", inkFaint:"var(--c-inkFaint)",
  gold:"var(--c-gold)", goldLight:"var(--c-goldLight)",
  green:"var(--c-green)", greenBg:"var(--c-greenBg)",
  red:"var(--c-red)", redBg:"var(--c-redBg)",
  amber:"var(--c-amber)", amberBg:"var(--c-amberBg)",
  blue:"var(--c-blue)", blueBg:"var(--c-blueBg)",
};

/* ── helpers ─────────────────────────────────────────────────────────────── */
const uid   = () => Math.random().toString(36).substr(2,9);
const today = () => new Date().toISOString().slice(0,10);
const mob   = () => window.innerWidth < 700;

const fmtMoney = (amt, div, cur) => {
  const s = {INR:"₹",USD:"$",EUR:"€",GBP:"£",JPY:"¥"}[cur] || (cur+" ");
  return s + ((amt||0)/(div||100)).toLocaleString("en-IN",{minimumFractionDigits:0,maximumFractionDigits:0});
};
const fmtTs  = ts => ts ? new Date(ts*1000).toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"2-digit"}) : "—";
const fmtDate= d  => d  ? new Date(d+"T12:00:00").toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"2-digit"}) : "—";
const etsyAmt= p  => p  ? p.amount/p.divisor : 0;
const FLAG   = iso=> { try { return iso ? String.fromCodePoint(...[...iso.toUpperCase()].map(c=>0x1F1E6-65+c.charCodeAt(0))) : ""; } catch{return "";} };

/* ── storage ─────────────────────────────────────────────────────────────── */
const ETSY_KEY      = "ng-etsy-v1";
const BATCH_KEY     = "ng-etsy-batch-v1";
const INV_KEY       = "ng-invoices-v2";
const BUY_KEY       = "ng-buyers-v2";
const STK_KEY       = "ng-stock-v5";
const IMG_KEY       = "ng-etsy-imgs-v1";
const LISTINGS_KEY  = "ng-etsy-listings-v2";
const SG_CREDS_KEY  = "ng-shipglobal-creds-v1";
const SG_TOKEN_KEY  = "ng-shipglobal-token-v1";

/* ── image cache ─────────────────────────────────────────────────────────── */
function useImgCache() {
  const [cache, setCache] = useState({});
  const inFlight = useRef(new Set());
  useEffect(() => { loadK(IMG_KEY).then(d => { if(d) setCache(d); }); }, []);

  const getImg = useCallback(async (lid) => {
    if (!lid) return null;
    const k = String(lid);
    if (cache[k]) return cache[k];
    if (inFlight.current.has(k)) return null;
    inFlight.current.add(k);
    try {
      const r = await fetch(`/api/etsy?action=listing_images&listing_id=${k}`);
      const d = await r.json();
      const url = d?.results?.[0]?.url_570xN || null;
      if (url) setCache(prev => { const n={...prev,[k]:url}; saveK(IMG_KEY,n); return n; });
      return url;
    } catch { return null; }
    finally { inFlight.current.delete(k); }
  },[cache]);

  return { cache, getImg };
}

/* ── Img ─────────────────────────────────────────────────────────────────── */
function Img({ lid, size=56, radius=6, getImg, cache, placeholder="💎" }) {
  const [url, setUrl] = useState(cache[String(lid)] || null);
  useEffect(() => { if(!url && lid) getImg(lid).then(u => u && setUrl(u)); }, [lid]);
  if (!url) return (
    <div style={{width:size,height:size,borderRadius:radius,flexShrink:0,background:C.card,
      border:`1px solid ${C.border}`,display:"flex",alignItems:"center",justifyContent:"center",
      fontSize:size>40?20:13,color:C.inkFaint}}>{placeholder}</div>
  );
  return <img src={url} alt="" style={{width:size,height:size,borderRadius:radius,flexShrink:0,objectFit:"cover",border:`1px solid ${C.border}`}} />;
}

/* ── Shell ───────────────────────────────────────────────────────────────── */
function Shell({ title, subtitle, onHome, actions, children }) {
  return (
    <div style={{fontFamily:"'Figtree',system-ui,sans-serif",background:C.bg,minHeight:"100vh",color:C.ink}}>
      <div style={{position:"sticky",top:0,zIndex:100,background:C.surface,borderBottom:`1px solid ${C.border}`,
        display:"flex",alignItems:"center",gap:12,padding:mob()?"10px 14px":"11px 28px"}}>
        <button onClick={onHome} style={{background:"none",border:"none",cursor:"pointer",color:C.inkMid,
          fontSize:13,padding:"0 12px 0 0",borderRight:`1px solid ${C.border}`}}>← Home</button>
        <div>
          <div style={{fontFamily:"'Cormorant Garamond',Georgia,serif",fontSize:20,fontWeight:700,lineHeight:1}}>{title}</div>
          {subtitle && <div style={{fontSize:11,color:C.inkFaint,marginTop:2}}>{subtitle}</div>}
        </div>
        <div style={{flex:1}}/>
        {actions}
      </div>
      {children}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   LISTINGS TAB — loads ALL listings, caches locally, searches across all
══════════════════════════════════════════════════════════════════════════ */
function ListingsTab({ shopId }) {
  const [allListings, setAllListings] = useState([]);
  const [loading,     setLoading]     = useState(false);
  const [loadProg,    setLoadProg]    = useState("");
  const [loadErr,     setLoadErr]     = useState("");
  const [imgMap,      setImgMap]      = useState({});
  const [search,      setSearch]      = useState("");
  const [page,        setPage]        = useState(0);
  const [lastLoaded,  setLastLoaded]  = useState(null);
  const imgFetching = useRef(new Set());
  const DISPLAY = 24;
  const API_LIMIT = 100;

  // Load from cache on mount only — no auto-fetch
  useEffect(() => {
    loadK(LISTINGS_KEY).then(d => {
      if (d?.listings?.length) {
        setAllListings(d.listings);
        setLastLoaded(d.loadedAt);
      }
    });
  }, [shopId]);

  const loadAllListings = async () => {
    setLoading(true); setLoadErr(""); setLoadProg("Connecting…");
    try {
      let all = [], off = 0, total = null;
      do {
        setLoadProg(`Loading ${off+1}–${Math.min(off+API_LIMIT, total||9999)}${total?` of ${total}`:""}…`);
        const r = await fetch(`/api/etsy?action=listings&shop_id=${shopId}&limit=${API_LIMIT}&offset=${off}`);
        const d = await r.json();
        if (d.error) throw new Error(d.error);
        if (total === null) total = d.count;
        all = [...all, ...(d.results||[])];
        off += API_LIMIT;
        if (off < total && d.results?.length === API_LIMIT) await new Promise(r=>setTimeout(r,220));
        else break;
      } while (off < total);

      setAllListings(all);
      setLastLoaded(new Date().toISOString());
      setPage(0);
      // Save to cache (may fail if storage quota exceeded — that's fine)
      try { await saveK(LISTINGS_KEY, { listings: all, loadedAt: new Date().toISOString() }); } catch {}
    } catch(e) {
      setLoadErr(e.message || "Load failed");
    } finally { setLoading(false); setLoadProg(""); }
  };

  // Filtered across ALL listings
  const filtered = search.trim()
    ? allListings.filter(l => {
        const q = search.toLowerCase();
        return l.title?.toLowerCase().includes(q) ||
               l.tags?.some(t => t.toLowerCase().includes(q)) ||
               String(l.listing_id).includes(q);
      })
    : allListings;

  const totalPages = Math.ceil(filtered.length / DISPLAY);
  const pageItems  = filtered.slice(page*DISPLAY, (page+1)*DISPLAY);

  useEffect(() => { setPage(0); }, [search]);

  // Fetch images only for visible listings
  useEffect(() => {
    const missing = pageItems.filter(l => !imgMap[l.listing_id] && !imgFetching.current.has(l.listing_id));
    if (!missing.length) return;
    missing.forEach(l => imgFetching.current.add(l.listing_id));
    (async () => {
      for (let i = 0; i < missing.length; i += 4) {
        await Promise.all(missing.slice(i, i+4).map(async l => {
          try {
            const r = await fetch(`/api/etsy?action=listing_images&listing_id=${l.listing_id}`);
            const d = await r.json();
            const url = d?.results?.[0]?.url_570xN;
            if (url) setImgMap(p => ({...p, [l.listing_id]: url}));
          } catch {} finally { imgFetching.current.delete(l.listing_id); }
        }));
        await new Promise(r => setTimeout(r, 250));
      }
    })();
  }, [pageItems.map(l=>l.listing_id).join(",")]);

  const syncAge = lastLoaded
    ? Math.round((Date.now()-new Date(lastLoaded).getTime())/60000)
    : null;

  // Empty state — never loaded yet
  if (!loading && allListings.length === 0) return (
    <div style={{padding:"80px 28px",textAlign:"center"}}>
      <div style={{fontSize:32,marginBottom:12}}>🏷️</div>
      <div style={{fontSize:15,fontWeight:600,marginBottom:6,color:C.ink}}>Listings not loaded yet</div>
      <div style={{fontSize:13,color:C.inkFaint,marginBottom:20}}>
        Loads all {918} active listings so you can search across them instantly
      </div>
      {loadErr && <div style={{fontSize:12,color:C.red,marginBottom:12}}>⚠ {loadErr}</div>}
      <button onClick={loadAllListings}
        style={{background:C.ink,color:"#FAF0DC",border:"none",borderRadius:8,
          padding:"11px 28px",fontSize:14,fontWeight:700,cursor:"pointer"}}>
        Load All Listings
      </button>
    </div>
  );

  // Loading in progress (with existing listings still visible below)
  const loadingBar = loading && (
    <div style={{padding:"10px 0",textAlign:"center",fontSize:12,color:C.inkMid}}>
      ⟳ {loadProg}
    </div>
  );

  return (
    <div style={{padding:mob()?"14px":"20px 28px",maxWidth:1200,margin:"0 auto"}}>

      {/* toolbar */}
      <div style={{display:"flex",gap:10,marginBottom:20,alignItems:"center",flexWrap:"wrap"}}>
        <input value={search} onChange={e=>setSearch(e.target.value)}
          placeholder="Search title, tags, or listing ID…"
          style={{flex:1,minWidth:200,background:C.surface,border:`1.5px solid ${search?C.gold:C.border}`,
            color:C.ink,borderRadius:20,padding:"8px 16px",fontSize:13,fontFamily:"inherit",outline:"none"}}/>

        <span style={{fontSize:13,color:C.inkMid,whiteSpace:"nowrap"}}>
          {search ? `${filtered.length} of ${allListings.length}` : `${allListings.length} active`}
        </span>

        <div style={{display:"flex",gap:6,alignItems:"center"}}>
          <button onClick={()=>setPage(p=>Math.max(0,p-1))} disabled={page===0||loading}
            style={{padding:"7px 14px",border:`1.5px solid ${C.border}`,borderRadius:7,
              background:C.surface,cursor:page===0?"not-allowed":"pointer",
              fontSize:12,color:page===0?C.inkFaint:C.ink}}>← Prev</button>
          <span style={{padding:"7px 4px",fontSize:12,color:C.inkMid,whiteSpace:"nowrap"}}>
            {filtered.length===0?"0":`${page*DISPLAY+1}–${Math.min((page+1)*DISPLAY,filtered.length)}`} of {filtered.length}
          </span>
          <button onClick={()=>setPage(p=>Math.min(totalPages-1,p+1))} disabled={page>=totalPages-1||loading}
            style={{padding:"7px 14px",border:`1.5px solid ${C.border}`,borderRadius:7,
              background:C.surface,cursor:page>=totalPages-1?"not-allowed":"pointer",
              fontSize:12,color:page>=totalPages-1?C.inkFaint:C.ink}}>Next →</button>
          <button onClick={loadAllListings} disabled={loading}
            title={syncAge!==null?`Last synced ${syncAge} min ago — click to refresh`:"Load all listings"}
            style={{padding:"7px 12px",border:`1.5px solid ${C.border}`,borderRadius:7,
              background:C.surface,cursor:loading?"wait":"pointer",fontSize:11,color:C.inkMid}}>
            {loading ? "…" : "⟳"}
          </button>
        </div>
      </div>

      {loadingBar}
      {loadErr && <div style={{fontSize:12,color:C.red,marginBottom:12,textAlign:"center"}}>⚠ {loadErr}</div>}

      {filtered.length === 0 && !loading && search && (
        <div style={{textAlign:"center",padding:"60px 0",color:C.inkFaint}}>
          No listings match "{search}"
        </div>
      )}

      {/* grid */}
      <div style={{display:"grid",gridTemplateColumns:mob()?"1fr 1fr":"repeat(auto-fill,minmax(200px,1fr))",gap:16}}>
        {pageItems.map(l => {
          const img     = imgMap[l.listing_id];
          const expires = l.ending_timestamp
            ? new Date(l.ending_timestamp*1000).toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"})
            : null;
          const priceStr = l.price ? fmtMoney(l.price.amount, l.price.divisor, l.price.currency_code) : "";

          return (
            <div key={l.listing_id} style={{background:C.surface,border:`1.5px solid ${C.border}`,
              borderRadius:10,overflow:"hidden",display:"flex",flexDirection:"column"}}>
              <div style={{aspectRatio:"1",background:C.card,overflow:"hidden",cursor:"pointer"}}
                onClick={()=>window.open(l.url,"_blank")}>
                {img
                  ? <img src={img} alt={l.title} style={{width:"100%",height:"100%",objectFit:"cover"}}/>
                  : <div style={{width:"100%",height:"100%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:36,color:C.inkFaint}}>💎</div>
                }
              </div>
              <div style={{padding:"10px 12px",flex:1,display:"flex",flexDirection:"column",gap:3}}>
                <div style={{fontSize:12,fontWeight:600,color:C.ink,lineHeight:1.35,
                  display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical",overflow:"hidden",cursor:"pointer"}}
                  onClick={()=>window.open(l.url,"_blank")}>
                  {l.title}
                </div>
                <div style={{fontSize:11,color:C.inkMid}}>{l.quantity} in stock</div>
                <div style={{fontSize:13,fontWeight:700,color:C.ink}}>{priceStr}</div>
                {expires && <div style={{fontSize:10,color:C.inkFaint}}>Expires {expires}</div>}
                <div style={{display:"flex",gap:6,marginTop:"auto",paddingTop:4,justifyContent:"space-between",alignItems:"center"}}>
                  <span style={{fontSize:10,color:C.inkFaint}}>♥ {l.num_favorers} · 👁 {l.views||0}</span>
                  <a href={`https://www.etsy.com/listing/${l.listing_id}`} target="_blank"
                    style={{fontSize:10,color:C.blue,textDecoration:"none"}}>Edit ↗</a>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   ORDERS TAB — Ship Manager style
══════════════════════════════════════════════════════════════════════════ */
function OrderRow({ order, getImg, cache, onProcess, onSkip, isProcessed, sgCreds, sgToken, onSgConnect, onCreateLabel }) {
  const [open, setOpen] = useState(false);
  const txn   = order.transactions?.[0] || {};
  const total = order.grandtotal || order.total_price;
  const isShipped = order.is_shipped;

  // "ship by" urgency
  const shipByDaysAgo = order.estimated_delivery_dates
    ? Math.floor((Date.now() - order.estimated_delivery_dates[0]*1000)/(86400000))
    : null;

  return (
    <div style={{borderBottom:`1px solid ${C.border}`,background:isProcessed?C.card:C.surface}}>
      {/* main row */}
      <div style={{display:"flex",gap:14,padding:"14px 16px",alignItems:"flex-start",cursor:"pointer"}}
        onClick={()=>setOpen(o=>!o)}>

        {/* image */}
        <Img lid={txn.listing_id} size={64} radius={8} getImg={getImg} cache={cache}/>

        {/* middle */}
        <div style={{flex:1,minWidth:0}}>
          <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",marginBottom:4}}>
            <span style={{fontSize:13,fontWeight:700,color:C.ink}}>{order.name}</span>
            {isProcessed && <Chip label="In Batch" color={C.amber} bg={C.amberBg}/>}
            {isShipped   && <Chip label="Shipped"  color={C.blue}  bg={C.blueBg}/>}
            {order.is_gift && <Chip label="Gift" color={C.inkMid} bg={C.card}/>}
          </div>
          <div style={{fontSize:12,color:C.inkMid,marginBottom:3}}>
            #{order.receipt_id} · {FLAG(order.country_iso)} {order.city ? order.city+", " : ""}{order.country_iso}
          </div>
          <div style={{fontSize:12,color:C.inkFaint,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",maxWidth:420}}>
            {(order.transactions||[]).map(t=>`${t.title} ×${t.quantity}`).join(" + ")}
          </div>
          {order.message_from_buyer && (
            <div style={{fontSize:11,color:C.amber,marginTop:3}}>💬 Has buyer note</div>
          )}
        </div>

        {/* right */}
        <div style={{textAlign:"right",flexShrink:0,minWidth:100}}>
          <div style={{fontFamily:"'Cormorant Garamond',Georgia,serif",fontSize:20,fontWeight:700,color:C.green,lineHeight:1}}>
            {fmtMoney(total?.amount, total?.divisor, total?.currency_code)}
          </div>
          <div style={{fontSize:11,color:C.inkFaint,marginTop:2}}>{fmtTs(order.create_timestamp)}</div>
          <div style={{fontSize:11,color:isShipped?C.blue:C.inkFaint,marginTop:2}}>
            {isShipped ? "✓ Shipped" : "Not shipped"}
          </div>
          <div style={{color:C.inkFaint,fontSize:12,marginTop:4}}>{open?"▲":"▼"}</div>
        </div>
      </div>

      {/* expanded */}
      {open && (
        <div style={{borderTop:`1px solid ${C.border}`,background:C.bg}}>

          {/* all items */}
          <div style={{padding:"12px 16px",display:"flex",flexDirection:"column",gap:8}}>
            {(order.transactions||[]).map(t=>(
              <div key={t.transaction_id} style={{display:"flex",gap:12,alignItems:"center",
                background:C.surface,borderRadius:9,padding:"10px 12px",border:`1px solid ${C.border}`}}>
                <Img lid={t.listing_id} size={52} radius={6} getImg={getImg} cache={cache}/>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:13,fontWeight:600,marginBottom:2}}>{t.title}</div>
                  <div style={{fontSize:11,color:C.inkMid}}>
                    Qty {t.quantity}
                    {t.sku && <span> · SKU {t.sku}</span>}
                    {(t.variations||[]).map(v=>(
                      <span key={v.property_id}> · {v.formatted_name}: {v.formatted_value}</span>
                    ))}
                  </div>
                  <a href={`https://www.etsy.com/listing/${t.listing_id}`} target="_blank"
                    style={{fontSize:10,color:C.blue,textDecoration:"none"}}>View listing ↗</a>
                </div>
                <div style={{textAlign:"right",flexShrink:0}}>
                  <div style={{fontSize:14,fontWeight:700}}>{fmtMoney(t.price?.amount,t.price?.divisor,t.price?.currency_code)}</div>
                </div>
              </div>
            ))}
          </div>

          {/* customer + order summary */}
          <div style={{display:"grid",gridTemplateColumns:mob()?"1fr":"1fr 1fr",borderTop:`1px solid ${C.border}`}}>

            {/* Ship to */}
            <div style={{padding:"14px 16px",borderRight:mob()?"none":`1px solid ${C.border}`}}>
              <SectionLabel>Ship to</SectionLabel>
              <div style={{fontSize:13,fontWeight:600,marginBottom:6}}>{order.name}</div>
              {order.formatted_address && (
                <div style={{fontSize:12,color:C.inkMid,lineHeight:1.7,whiteSpace:"pre-line"}}>
                  {order.formatted_address}
                </div>
              )}
              {order.buyer_email && (
                <a href={`mailto:${order.buyer_email}`} style={{fontSize:12,color:C.blue,display:"block",marginTop:6}}>
                  ✉ {order.buyer_email}
                </a>
              )}
              {order.message_from_buyer && (
                <div style={{marginTop:10,background:C.amberBg,border:`1px solid ${C.amber}30`,borderRadius:7,padding:"8px 10px"}}>
                  <div style={{fontSize:9,fontWeight:700,color:C.amber,textTransform:"uppercase",letterSpacing:.6,marginBottom:3}}>Buyer note</div>
                  <div style={{fontSize:12}}>{order.message_from_buyer}</div>
                </div>
              )}
            </div>

            {/* Financials */}
            <div style={{padding:"14px 16px"}}>
              <SectionLabel>Order summary</SectionLabel>
              {[
                ["Subtotal",    order.subtotal],
                ["Shipping",    order.total_shipping_cost],
                ["Tax",         order.total_tax_cost],
                ["Discount",    order.discount_amt],
                ["Grand Total", order.grandtotal],
              ].map(([label, val]) => val && (val.amount > 0 || label === "Grand Total") ? (
                <div key={label} style={{
                  display:"flex",justifyContent:"space-between",
                  fontSize:label==="Grand Total"?14:12,
                  fontWeight:label==="Grand Total"?700:400,
                  color:label==="Grand Total"?C.green:label==="Discount"?C.red:C.inkMid,
                  padding:"3px 0",
                  borderTop:label==="Grand Total"?`1px solid ${C.border}`:"none",
                  marginTop:label==="Grand Total"?6:0,
                }}>
                  <span>{label}</span>
                  <span>{label==="Discount"&&val.amount>0?"−":""}{fmtMoney(val.amount,val.divisor,val.currency_code)}</span>
                </div>
              ) : null)}
              <div style={{fontSize:11,color:C.inkFaint,marginTop:8}}>
                Payment: {(order.payment_method||"").toUpperCase()} · {order.is_paid?"✓ Paid":"Unpaid"}
              </div>

              {/* shipments */}
              {(order.shipments||[]).length>0 && (
                <div style={{marginTop:10,background:C.blueBg,borderRadius:7,padding:"8px 10px"}}>
                  <div style={{fontSize:9,fontWeight:700,color:C.blue,textTransform:"uppercase",letterSpacing:.6,marginBottom:4}}>Tracking</div>
                  {order.shipments.map((s,i)=>(
                    <div key={i} style={{fontSize:12}}>{s.carrier_name} · <strong>{s.tracking_code}</strong></div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* ShipGlobal label row */}
          <div style={{padding:"10px 16px",borderTop:`1px solid ${C.border}`,display:"flex",alignItems:"center",gap:10,background:C.surface}}>
            <span style={{fontSize:11,color:C.inkFaint,flex:1}}>📦 ShipGlobal</span>
            {sgCreds && sgToken
              ? <button onClick={()=>onCreateLabel(order)}
                  style={{padding:"7px 14px",background:"#0057a8",color:"#fff",border:"none",
                    borderRadius:6,fontSize:12,fontWeight:600,cursor:"pointer"}}>
                  Create Label
                </button>
              : <button onClick={onSgConnect}
                  style={{padding:"7px 14px",background:C.surface,border:`1.5px solid ${C.border}`,
                    borderRadius:6,fontSize:12,cursor:"pointer",color:C.inkMid,fontWeight:600}}>
                  Connect ShipGlobal
                </button>
            }
          </div>

          {/* action buttons */}
          {!isProcessed && (
            <div style={{display:"flex",gap:8,padding:"12px 16px",background:C.surface,borderTop:`1px solid ${C.border}`}}>
              <button onClick={()=>onProcess(order)}
                style={{flex:1,background:C.ink,color:"#FAF0DC",border:"none",borderRadius:7,
                  padding:"10px 0",fontSize:13,fontWeight:700,cursor:"pointer"}}>
                ＋ Add to Batch
              </button>
              <a href={`https://www.etsy.com/your/orders/${order.receipt_id}`} target="_blank"
                style={{padding:"10px 14px",background:C.surface,border:`1.5px solid ${C.border}`,
                  borderRadius:7,fontSize:12,color:C.ink,textDecoration:"none",fontWeight:600,display:"flex",alignItems:"center",gap:4}}>
                Open on Etsy ↗
              </a>
              <button onClick={()=>onSkip(order)}
                style={{padding:"10px 14px",background:C.surface,border:`1.5px solid ${C.border}`,
                  borderRadius:7,fontSize:12,cursor:"pointer",color:C.inkMid}}>
                Skip
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SectionLabel({ children }) {
  return <div style={{fontSize:9,fontWeight:700,textTransform:"uppercase",letterSpacing:.7,color:C.inkFaint,marginBottom:8}}>{children}</div>;
}

function Chip({ label, color, bg }) {
  return <span style={{fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:20,background:bg,color,
    border:`1px solid ${color}30`,letterSpacing:.4,textTransform:"uppercase"}}>{label}</span>;
}

/* ══════════════════════════════════════════════════════════════════════════
   SHIPGLOBAL — connect + label modals
══════════════════════════════════════════════════════════════════════════ */
function ShipGlobalConnectModal({ onClose, onSave }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [sellerName,  setSellerName]  = useState("");
  const [sellerMobile,setSellerMobile]= useState("");
  const [sellerEmail, setSellerEmail] = useState("");
  const [sellerAddr,  setSellerAddr]  = useState("");
  const [sellerCity,  setSellerCity]  = useState("");
  const [sellerPin,   setSellerPin]   = useState("");
  const [sellerState, setSellerState] = useState("");
  const [sellerCo,    setSellerCo]    = useState("Nikhil Gems");
  const [testing,     setTesting]     = useState(false);
  const [err,         setErr]         = useState("");

  const FI = { background:C.surface, border:`1.5px solid ${C.border}`, color:C.ink,
    borderRadius:6, padding:"7px 10px", fontSize:13, fontFamily:"inherit", width:"100%" };

  const save = async () => {
    if (!username || !password) { setErr("Username and password required"); return; }
    setTesting(true); setErr("");
    try {
      const r = await fetch("/api/shipglobal", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ action:"authenticate", username, password }),
      });
      const d = await r.json();
      if (!r.ok) { setErr(d.error || "Authentication failed"); return; }
      const token = d.token || d.access_token || d.data?.token;
      const expiresAt = d.expires_at || d.data?.expires_at || (Date.now()/1000 + 86400);
      await saveK(SG_TOKEN_KEY, { token, expiresAt });
      const creds = { username, password, sellerName, sellerMobile, sellerEmail, sellerAddr, sellerCity, sellerPin, sellerState, sellerCo };
      await saveK(SG_CREDS_KEY, creds);
      onSave(creds, token);
    } catch(e) { setErr(e.message); }
    finally { setTesting(false); }
  };

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.5)",zIndex:2000,
      display:"flex",alignItems:mob()?"flex-end":"center",justifyContent:"center"}}
      onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div style={{background:C.bg,borderRadius:mob()?"14px 14px 0 0":12,padding:"22px 24px",
        width:mob()?"100%":520,maxHeight:"90vh",overflowY:"auto",boxShadow:"0 20px 60px rgba(0,0,0,.25)"}}>
        <div style={{fontFamily:"'Cormorant Garamond',Georgia,serif",fontSize:18,fontWeight:700,marginBottom:4}}>Connect ShipGlobal</div>
        <div style={{fontSize:11,color:C.inkFaint,marginBottom:16}}>Enter your ShipGlobal credentials to generate shipping labels directly from orders.</div>

        <div style={{fontSize:9,fontWeight:700,textTransform:"uppercase",letterSpacing:.7,color:C.inkFaint,marginBottom:8}}>ShipGlobal Login</div>
        <div style={{display:"grid",gap:8,marginBottom:16}}>
          <input value={username} onChange={e=>setUsername(e.target.value)} placeholder="Username / Email" style={FI}/>
          <input type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="Password" style={FI}/>
        </div>

        <div style={{fontSize:9,fontWeight:700,textTransform:"uppercase",letterSpacing:.7,color:C.inkFaint,marginBottom:8}}>Shipper (Your) Details</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:16}}>
          <input value={sellerName}   onChange={e=>setSellerName(e.target.value)}   placeholder="Full Name"     style={FI}/>
          <input value={sellerCo}     onChange={e=>setSellerCo(e.target.value)}     placeholder="Company"       style={FI}/>
          <input value={sellerMobile} onChange={e=>setSellerMobile(e.target.value)} placeholder="Mobile"        style={FI}/>
          <input value={sellerEmail}  onChange={e=>setSellerEmail(e.target.value)}  placeholder="Email"         style={FI}/>
          <input value={sellerAddr}   onChange={e=>setSellerAddr(e.target.value)}   placeholder="Address"       style={{...FI,gridColumn:"1/-1"}}/>
          <input value={sellerCity}   onChange={e=>setSellerCity(e.target.value)}   placeholder="City"          style={FI}/>
          <input value={sellerState}  onChange={e=>setSellerState(e.target.value)}  placeholder="State"         style={FI}/>
          <input value={sellerPin}    onChange={e=>setSellerPin(e.target.value)}    placeholder="Pincode"       style={FI}/>
        </div>

        {err && <div style={{color:C.red,fontSize:12,marginBottom:12}}>⚠ {err}</div>}

        <div style={{display:"flex",gap:8}}>
          <button onClick={save} disabled={testing}
            style={{flex:1,background:C.ink,color:"#FAF0DC",border:"none",borderRadius:7,
              padding:"11px 0",fontSize:14,fontWeight:600,cursor:testing?"wait":"pointer",opacity:testing?.7:1}}>
            {testing ? "Connecting…" : "Connect"}
          </button>
          <button onClick={onClose} style={{padding:"11px 18px",background:C.surface,
            border:`1.5px solid ${C.border}`,borderRadius:7,fontSize:13,cursor:"pointer",color:C.ink}}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

const SERVICES = ["DPD-CLASSIC","DPD-EXPRESS","FEDEX","ARAMEX","DELHIVERY"];

function ShipGlobalLabelModal({ order, creds, token, onClose, onSuccess }) {
  const txn = order.transactions?.[0] || {};
  const nameParts = (order.name||"").trim().split(/\s+/);
  const firstName = nameParts[0] || "";
  const lastName  = nameParts.slice(1).join(" ") || "-";
  const addrLines = (order.formatted_address||"").split("\n").map(l=>l.trim()).filter(Boolean);

  const [weightG,    setWeightG]    = useState("");
  const [lengthCm,   setLengthCm]   = useState("");
  const [breadthCm,  setBreadthCm]  = useState("");
  const [heightCm,   setHeightCm]   = useState("");
  const [service,    setService]    = useState(SERVICES[0]);
  const [custAddr,   setCustAddr]   = useState(addrLines.slice(0,2).join(", "));
  const [custCity,   setCustCity]   = useState(order.city || "");
  const [custState,  setCustState]  = useState("");
  const [custPin,    setCustPin]    = useState("");
  const [creating,   setCreating]   = useState(false);
  const [err,        setErr]        = useState("");

  const FI = { background:C.surface, border:`1.5px solid ${C.border}`, color:C.ink,
    borderRadius:6, padding:"7px 10px", fontSize:13, fontFamily:"inherit" };

  const sellerParts = (creds.sellerName||"").trim().split(/\s+/);

  const create = async () => {
    if (!weightG || !lengthCm || !breadthCm || !heightCm) { setErr("All dimensions required"); return; }
    setCreating(true); setErr("");
    try {
      const sgOrder = {
        invoice_no: `ETSY-${order.receipt_id}`,
        invoice_date: new Date().toISOString().slice(0,10),
        order_reference: String(order.receipt_id),
        service,
        package_weight: Number(weightG),
        package_length: Number(lengthCm),
        package_breadth: Number(breadthCm),
        package_height: Number(heightCm),
        currency_code: txn.price?.currency_code || "INR",
        csb5_status: false,
        seller_firstname: sellerParts[0] || creds.sellerName || "",
        seller_lastname:  sellerParts.slice(1).join(" ") || "",
        seller_company:   creds.sellerCo || "Nikhil Gems",
        seller_mobile:    creds.sellerMobile || "",
        seller_email:     creds.sellerEmail  || "",
        seller_address:   creds.sellerAddr   || "",
        seller_city:      creds.sellerCity   || "",
        seller_postcode:  creds.sellerPin    || "",
        seller_country_code: "IN",
        seller_state:     creds.sellerState  || "",
        customer_shipping_firstname:    firstName,
        customer_shipping_lastname:     lastName,
        customer_shipping_address:      custAddr,
        customer_shipping_city:         custCity,
        customer_shipping_state:        custState,
        customer_shipping_postcode:     custPin,
        customer_shipping_country_code: order.country_iso || "",
        vendor_order_items: (order.transactions||[]).map(t=>({
          vendor_order_item_name:       t.title || "",
          vendor_order_item_sku:        t.sku   || "",
          vendor_order_item_quantity:   t.quantity || 1,
          vendor_order_item_unit_price: t.price ? (t.price.amount / (t.price.divisor||100)) : 0,
        })),
      };

      const r = await fetch("/api/shipglobal?action=create_label", {
        method:"POST", headers:{"Content-Type":"application/json","x-shipglobal-token":token},
        body: JSON.stringify({ action:"create_label", order:sgOrder }),
      });
      const data = await r.json();
      if (!r.ok) { setErr(data.error || "Label creation failed"); return; }

      const pdf64 = data?.dpd?.raw_response?.pdf_base64 || data?.pdf_base64 || data?.label_pdf;
      if (pdf64) {
        const byteStr = atob(pdf64);
        const bytes = new Uint8Array(byteStr.length);
        for (let i=0; i<byteStr.length; i++) bytes[i] = byteStr.charCodeAt(i);
        const blob = new Blob([bytes], {type:"application/pdf"});
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = `label-${order.receipt_id}.pdf`; a.click();
        URL.revokeObjectURL(url);
      }
      onSuccess(data);
    } catch(e) { setErr(e.message); }
    finally { setCreating(false); }
  };

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.5)",zIndex:2000,
      display:"flex",alignItems:mob()?"flex-end":"center",justifyContent:"center"}}
      onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div style={{background:C.bg,borderRadius:mob()?"14px 14px 0 0":12,padding:"22px 24px",
        width:mob()?"100%":540,maxHeight:"90vh",overflowY:"auto",boxShadow:"0 20px 60px rgba(0,0,0,.25)"}}>
        <div style={{fontFamily:"'Cormorant Garamond',Georgia,serif",fontSize:18,fontWeight:700,marginBottom:4}}>Create ShipGlobal Label</div>
        <div style={{fontSize:11,color:C.inkFaint,marginBottom:14}}>Order #{order.receipt_id} · {order.name}</div>

        {/* items summary */}
        <div style={{background:C.amberBg,border:`1px solid ${C.borderHi}`,borderRadius:8,padding:"10px 12px",marginBottom:14,fontSize:12}}>
          {(order.transactions||[]).map((t,i)=>(
            <div key={i}>{t.title} ×{t.quantity}</div>
          ))}
        </div>

        {/* package */}
        <div style={{fontSize:9,fontWeight:700,textTransform:"uppercase",letterSpacing:.7,color:C.inkFaint,marginBottom:8}}>Package</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:8,marginBottom:8}}>
          {[["Weight (g)","weightG",weightG,setWeightG],["Length (cm)","l",lengthCm,setLengthCm],
            ["Width (cm)","b",breadthCm,setBreadthCm],["Height (cm)","h",heightCm,setHeightCm]].map(([lbl,,val,set])=>(
            <div key={lbl}>
              <div style={{fontSize:10,color:C.inkFaint,marginBottom:3}}>{lbl}</div>
              <input type="number" value={val} onChange={e=>set(e.target.value)} style={{...FI,width:"100%"}}/>
            </div>
          ))}
        </div>
        <div style={{marginBottom:14}}>
          <div style={{fontSize:10,color:C.inkFaint,marginBottom:3}}>Service</div>
          <select value={service} onChange={e=>setService(e.target.value)} style={{...FI,width:"100%"}}>
            {SERVICES.map(s=><option key={s}>{s}</option>)}
          </select>
        </div>

        {/* recipient */}
        <div style={{fontSize:9,fontWeight:700,textTransform:"uppercase",letterSpacing:.7,color:C.inkFaint,marginBottom:8}}>Recipient</div>
        <div style={{display:"grid",gap:8,marginBottom:14}}>
          <input value={custAddr}  onChange={e=>setCustAddr(e.target.value)}  placeholder="Street address" style={{...FI,width:"100%"}}/>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
            <input value={custCity}  onChange={e=>setCustCity(e.target.value)}  placeholder="City"    style={{...FI,width:"100%"}}/>
            <input value={custState} onChange={e=>setCustState(e.target.value)} placeholder="State"   style={{...FI,width:"100%"}}/>
            <input value={custPin}   onChange={e=>setCustPin(e.target.value)}   placeholder="Postcode" style={{...FI,width:"100%"}}/>
          </div>
          <div style={{fontSize:11,color:C.inkFaint}}>Country: {order.country_iso}</div>
        </div>

        {err && <div style={{color:C.red,fontSize:12,marginBottom:12}}>⚠ {err}</div>}

        <div style={{display:"flex",gap:8}}>
          <button onClick={create} disabled={creating}
            style={{flex:1,background:C.ink,color:"#FAF0DC",border:"none",borderRadius:7,
              padding:"11px 0",fontSize:14,fontWeight:600,cursor:creating?"wait":"pointer",opacity:creating?.7:1}}>
            {creating ? "Creating…" : "Generate & Download Label"}
          </button>
          <button onClick={onClose} style={{padding:"11px 18px",background:C.surface,
            border:`1.5px solid ${C.border}`,borderRadius:7,fontSize:13,cursor:"pointer",color:C.ink}}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── group orders by ship urgency ─────────────────────────────────────── */
function groupOrders(orders) {
  const now = Date.now();
  const groups = { overdue:[], today:[], tomorrow:[], week:[], later:[] };
  orders.forEach(o => {
    const created = o.create_timestamp * 1000;
    const age = (now - created) / 86400000;
    if (age > 7)       groups.overdue.push(o);
    else if (age > 2)  groups.today.push(o);
    else if (age > 1)  groups.tomorrow.push(o);
    else if (age > 0)  groups.week.push(o);
    else               groups.later.push(o);
  });
  return [
    { key:"overdue",  label:"Overdue",        color:C.red,    orders:groups.overdue  },
    { key:"today",    label:"Ship today",      color:C.amber,  orders:groups.today    },
    { key:"tomorrow", label:"Ship tomorrow",   color:C.ink,    orders:groups.tomorrow },
    { key:"week",     label:"Within a week",   color:C.inkMid, orders:groups.week     },
    { key:"later",    label:"New",             color:C.green,  orders:groups.later    },
  ].filter(g => g.orders.length > 0);
}

/* ══════════════════════════════════════════════════════════════════════════
   BATCH + INVOICE
══════════════════════════════════════════════════════════════════════════ */
function BatchTab({ batch, buyers, atyaharaId, setAtyaharaId, onRemove, onCreateInvoice, creating }) {
  const FI = {background:C.surface,border:`1.5px solid ${C.border}`,color:C.ink,borderRadius:6,padding:"7px 10px",fontSize:13,fontFamily:"inherit"};
  const byCur = batch.reduce((s,i)=>({...s,[i.currency]:(s[i.currency]||0)+i.amt}), {});
  const atyBuyer = buyers.find(b=>b.id===atyaharaId);

  if (batch.length===0) return (
    <div style={{maxWidth:900,margin:"0 auto",padding:"60px 28px",textAlign:"center",color:C.inkFaint,fontSize:13}}>
      No items in batch — open an order and click "Add to Batch"
    </div>
  );

  return (
    <div style={{maxWidth:900,margin:"0 auto",padding:mob()?"14px":"24px 28px"}}>
      {/* buyer selector */}
      <div style={{background:C.blueBg,border:`1.5px solid ${C.blue}30`,borderRadius:10,
        padding:"12px 16px",marginBottom:16,display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
        <div style={{fontSize:12,fontWeight:600,color:C.blue}}>Invoice to:</div>
        <select value={atyaharaId} onChange={e=>setAtyaharaId(e.target.value)} style={{...FI,flex:1,minWidth:160,fontSize:12}}>
          <option value="">— Select buyer —</option>
          {buyers.sort((a,b)=>a.name.localeCompare(b.name)).map(b=>(
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>
        {atyBuyer && <span style={{fontSize:11,color:C.blue}}>✓ {atyBuyer.name}</span>}
      </div>

      <div style={{border:`1.5px solid ${C.border}`,borderRadius:12,overflow:"hidden",marginBottom:16}}>
        <div style={{display:"grid",gridTemplateColumns:"1fr 70px 90px 100px 32px",background:C.card,
          padding:"8px 16px",fontSize:9,fontWeight:700,color:C.inkFaint,textTransform:"uppercase",letterSpacing:.7}}>
          <div>Description</div><div style={{textAlign:"right"}}>Qty</div>
          <div style={{textAlign:"right"}}>Rate</div><div style={{textAlign:"right"}}>Total</div><div/>
        </div>
        {batch.map(item=>(
          <div key={item.id} style={{display:"grid",gridTemplateColumns:"1fr 70px 90px 100px 32px",
            padding:"11px 16px",borderTop:`1px solid ${C.border}`,alignItems:"center"}}>
            <div>
              <div style={{fontSize:12,fontWeight:600}}>{item.desc}</div>
              <div style={{fontSize:10,color:C.inkFaint}}>
                #{item.etsyReceiptId} · {item.buyerName} · {FLAG(item.buyerCountry)} {item.buyerCountry}
                {item.fulfill==="dropship"&&<span style={{color:C.amber}}> · dropship</span>}
                {item.fulfill==="stock"&&item.stockDesc&&<span style={{color:C.green}}> · from stock</span>}
              </div>
            </div>
            <div style={{textAlign:"right",fontSize:12}}>{item.qty} {item.unit}</div>
            <div style={{textAlign:"right",fontSize:12}}>{item.currency} {(+item.rate).toFixed(0)}</div>
            <div style={{textAlign:"right",fontSize:13,fontWeight:700,color:C.green}}>{item.currency} {item.amt.toFixed(0)}</div>
            <button onClick={()=>onRemove(item.id)}
              style={{background:"none",border:"none",cursor:"pointer",color:C.inkFaint,fontSize:18,lineHeight:1}}
              onMouseEnter={e=>e.currentTarget.style.color=C.red}
              onMouseLeave={e=>e.currentTarget.style.color=C.inkFaint}>×</button>
          </div>
        ))}
      </div>

      <div style={{display:"flex",justifyContent:"flex-end",gap:20,marginBottom:16}}>
        {Object.entries(byCur).map(([cur,amt])=>(
          <div key={cur} style={{textAlign:"right"}}>
            <div style={{fontSize:9,color:C.inkFaint,textTransform:"uppercase",letterSpacing:.6}}>Total ({cur})</div>
            <div style={{fontFamily:"'Cormorant Garamond',Georgia,serif",fontSize:26,fontWeight:700,color:C.green}}>
              {{INR:"₹",USD:"$",EUR:"€",GBP:"£"}[cur]||cur}{amt.toLocaleString("en-IN")}
            </div>
          </div>
        ))}
      </div>

      <button onClick={onCreateInvoice} disabled={!atyaharaId||creating}
        style={{width:"100%",background:atyaharaId?C.ink:C.border,color:atyaharaId?"#FAF0DC":C.inkFaint,
          border:"none",borderRadius:9,padding:"14px 0",fontSize:15,fontWeight:700,
          cursor:atyaharaId?"pointer":"not-allowed"}}>
        {creating ? "Creating…" : `Create Invoice → ${atyBuyer?.name||"Atyahara"}`}
      </button>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   PROCESS MODAL
══════════════════════════════════════════════════════════════════════════ */
function ProcessModal({ order, stock, onSave, onClose }) {
  const FI = {background:C.surface,border:`1.5px solid ${C.border}`,color:C.ink,borderRadius:6,padding:"7px 10px",fontSize:13,fontFamily:"inherit",width:"100%"};
  const txn = order.transactions?.[0]||{};
  const amt = etsyAmt(txn.price);

  const [fulfill, setFulfill]  = useState("stock");
  const [stockId, setStockId]  = useState("");
  const [search,  setSearch]   = useState("");
  const [qty,  setQty]         = useState(String(txn.quantity||1));
  const [unit, setUnit]        = useState("pcs");
  const [desc, setDesc]        = useState(txn.title||"");
  const [rate, setRate]        = useState(amt.toFixed(2));
  const [cur,  setCur]         = useState(txn.price?.currency_code||"INR");
  const [vendor,  setVendor]   = useState("");
  const [notes,   setNotes]    = useState("");
  const [markup,  setMarkup]   = useState(20);

  const sel = stock.find(s=>s.id===stockId);
  const filtered = search ? stock.filter(s=>`${s.desc||""} ${s.color||""}`.toLowerCase().includes(search.toLowerCase())).slice(0,6) : stock.slice(0,5);

  useEffect(()=>{ if(sel?.costPrice&&fulfill==="stock") setRate((+sel.costPrice*(1+markup/100)).toFixed(2)); },[stockId,markup,fulfill]);

  const total = (+qty||0)*(+rate||0);
  const ok    = desc.trim()&&+rate>0;

  const save = () => onSave({
    id:uid(), etsyReceiptId:order.receipt_id, etsyTransactionId:txn.transaction_id,
    etsyTitle:txn.title, buyerName:order.name, buyerEmail:order.buyer_email||"",
    buyerCountry:order.country_iso, buyerAddress:order.formatted_address||"",
    etsyPrice:amt, etsyCurrency:txn.price?.currency_code||"INR",
    etsyDate:new Date(order.create_timestamp*1000).toISOString().slice(0,10),
    desc:desc.trim(), qty:+qty||1, unit, rate:+rate, currency:cur, amt:total,
    fulfill, stockId:fulfill==="stock"?stockId:"", stockDesc:fulfill==="stock"?sel?.desc:"",
    vendor:fulfill==="dropship"?vendor:"", notes:notes.trim(), addedAt:new Date().toISOString(),
  });

  const FULFILL = [{id:"stock",label:"From Stock",icon:"💎"},{id:"dropship",label:"Dropship",icon:"📦"},{id:"none",label:"No Stock Move",icon:"📝"}];

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.45)",zIndex:1000,
      display:"flex",alignItems:mob()?"flex-end":"center",justifyContent:"center"}}
      onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div style={{background:C.bg,border:mob()?"none":`1.5px solid ${C.border}`,
        borderRadius:mob()?"14px 14px 0 0":12,padding:"22px 24px",
        width:mob()?"100%":520,maxHeight:"90vh",overflowY:"auto",boxShadow:"0 20px 60px rgba(0,0,0,.25)"}}>

        <div style={{fontFamily:"'Cormorant Garamond',Georgia,serif",fontSize:18,fontWeight:700,marginBottom:2}}>Process Order</div>
        <div style={{fontSize:11,color:C.inkFaint,marginBottom:14}}>#{order.receipt_id} · {order.name} · {fmtTs(order.create_timestamp)}</div>

        <div style={{background:C.amberBg,border:`1px solid ${C.borderHi}`,borderRadius:8,padding:"10px 12px",marginBottom:14,fontSize:12}}>
          <div style={{fontWeight:600,marginBottom:2}}>{txn.title}</div>
          <div style={{color:C.inkMid}}>Qty {txn.quantity} · {txn.price?.currency_code} {amt.toFixed(0)} · {order.name} ({FLAG(order.country_iso)} {order.country_iso})</div>
        </div>

        {/* fulfillment */}
        <div style={{fontSize:9,fontWeight:700,color:C.inkFaint,textTransform:"uppercase",letterSpacing:.7,marginBottom:6}}>Fulfillment</div>
        <div style={{display:"flex",gap:8,marginBottom:14}}>
          {FULFILL.map(f=>(
            <button key={f.id} onClick={()=>setFulfill(f.id)} style={{flex:1,padding:"8px 4px",borderRadius:7,
              border:`1.5px solid ${fulfill===f.id?C.gold:C.border}`,background:fulfill===f.id?C.amberBg:C.surface,
              cursor:"pointer",fontSize:11,fontWeight:600,color:fulfill===f.id?C.ink:C.inkMid,textAlign:"center"}}>
              <div style={{fontSize:16,marginBottom:2}}>{f.icon}</div>{f.label}
            </button>
          ))}
        </div>

        {fulfill==="stock" && (
          <div style={{marginBottom:12}}>
            <input value={search} onChange={e=>{setSearch(e.target.value);setStockId("");}}
              placeholder="Search stock…" style={{...FI,marginBottom:6}}/>
            {filtered.length>0&&!stockId&&(
              <div style={{border:`1px solid ${C.border}`,borderRadius:6,overflow:"hidden",marginBottom:6}}>
                {filtered.map(s=>(
                  <div key={s.id} onClick={()=>{setStockId(s.id);setSearch(s.desc||"");setDesc(s.desc||desc);setUnit(s.unit||"pcs");}}
                    style={{padding:"8px 12px",fontSize:12,cursor:"pointer",borderBottom:`1px solid ${C.border}`,background:C.surface,display:"flex",justifyContent:"space-between"}}>
                    <div><div style={{fontWeight:600}}>{s.desc}</div><div style={{fontSize:10,color:C.inkFaint}}>{s.qty} {s.unit} in stock</div></div>
                    {s.costPrice&&<div style={{fontSize:11,color:C.green}}>₹{s.costPrice}</div>}
                  </div>
                ))}
              </div>
            )}
            {sel?.costPrice&&(
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                <span style={{fontSize:11,color:C.inkFaint}}>Markup</span>
                <input type="range" min={0} max={100} value={markup} onChange={e=>setMarkup(+e.target.value)} style={{flex:1}}/>
                <span style={{fontSize:11,fontWeight:600}}>{markup}%</span>
              </div>
            )}
          </div>
        )}

        {fulfill==="dropship" && (
          <div style={{marginBottom:12}}>
            <input value={vendor} onChange={e=>setVendor(e.target.value)} placeholder="Vendor / Supplier" style={FI}/>
          </div>
        )}

        <div style={{borderTop:`1px solid ${C.border}`,paddingTop:12,marginTop:4}}>
          <div style={{fontSize:9,fontWeight:700,color:C.inkFaint,textTransform:"uppercase",letterSpacing:.7,marginBottom:8}}>Invoice Line</div>
          <div style={{marginBottom:8}}><input value={desc} onChange={e=>setDesc(e.target.value)} placeholder="Description" style={FI}/></div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 70px 70px 70px",gap:8,marginBottom:8}}>
            <div><div style={{fontSize:10,color:C.inkFaint,marginBottom:3}}>Rate</div>
              <input type="number" value={rate} onChange={e=>setRate(e.target.value)} style={FI}/></div>
            <div><div style={{fontSize:10,color:C.inkFaint,marginBottom:3}}>Cur</div>
              <select value={cur} onChange={e=>setCur(e.target.value)} style={FI}>
                {["INR","USD","EUR","GBP"].map(c=><option key={c}>{c}</option>)}
              </select></div>
            <div><div style={{fontSize:10,color:C.inkFaint,marginBottom:3}}>Qty</div>
              <input type="number" value={qty} onChange={e=>setQty(e.target.value)} style={FI}/></div>
            <div><div style={{fontSize:10,color:C.inkFaint,marginBottom:3}}>Unit</div>
              <select value={unit} onChange={e=>setUnit(e.target.value)} style={FI}>
                {["pcs","cts","gms","kg","set","pair","lot"].map(u=><option key={u}>{u}</option>)}
              </select></div>
          </div>
          <div style={{background:C.greenBg,borderRadius:6,padding:"8px 12px",fontSize:14,fontWeight:700,color:C.green,textAlign:"right",marginBottom:8}}>
            Total: {cur} {total.toLocaleString("en-IN")}
          </div>
          <input value={notes} onChange={e=>setNotes(e.target.value)} placeholder="Notes (optional)" style={FI}/>
        </div>

        <div style={{display:"flex",gap:8,marginTop:14}}>
          <button onClick={save} disabled={!ok}
            style={{flex:1,background:ok?C.ink:C.border,color:ok?"#FAF0DC":C.inkFaint,
              border:"none",borderRadius:7,padding:"11px 0",fontSize:14,fontWeight:600,cursor:ok?"pointer":"not-allowed"}}>
            Add to Batch
          </button>
          <button onClick={onClose} style={{padding:"11px 18px",background:C.surface,border:`1.5px solid ${C.border}`,borderRadius:7,fontSize:13,cursor:"pointer",color:C.ink}}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   MAIN
══════════════════════════════════════════════════════════════════════════ */
export default function EtsyApp({ onHome }) {
  const [orders,    setOrders]    = useState([]);
  const [processed, setProcessed] = useState({});
  const [batch,     setBatch]     = useState([]);
  const [settings,  setSettings]  = useState({ shopId:"21113006", lastSyncAt:null });
  const [buyers,    setBuyers]    = useState([]);
  const [stock,     setStock]     = useState([]);
  const [loaded,    setLoaded]    = useState(false);
  const [syncing,   setSyncing]   = useState(false);
  const [syncProg,  setSyncProg]  = useState("");
  const [syncErr,   setSyncErr]   = useState("");
  const [tab,       setTab]       = useState("orders");
  const [modal,     setModal]     = useState(null);
  const [toast,     setToast]     = useState("");
  const [atyaharaId,setAtyaharaId]= useState("");
  const [creating,  setCreating]  = useState(false);
  const [search,    setSearch]    = useState("");
  const [doneFilter,setDoneFilter]= useState("all"); // all | shipped | pending
  const [platform,  setPlatform]  = useState("etsy"); // etsy | ebay | atyahara | earth
  const [sgCreds,   setSgCreds]   = useState(null);
  const [sgToken,   setSgToken]   = useState(null);
  const [sgConnect, setSgConnect] = useState(false);
  const [sgLabelOrder, setSgLabelOrder] = useState(null);

  const { cache, getImg } = useImgCache();
  const showToast = m => { setToast(m); setTimeout(()=>setToast(""),3500); };

  /* load */
  useEffect(()=>{
    Promise.all([loadK(ETSY_KEY),loadK(BATCH_KEY),loadK(BUY_KEY),loadK(STK_KEY)])
      .then(([etsy,b,buys,stk])=>{
        if(etsy){ setOrders(etsy.orders||[]); setProcessed(etsy.processed||{}); setSettings(s=>({...s,...(etsy.settings||{})})); }
        setBatch(b||[]);
        setBuyers(buys||[]);
        setStock(stk||[]);
        const aty=(buys||[]).find(b=>(b.name||"").toLowerCase().includes("atyahara"));
        if(aty) setAtyaharaId(aty.id);
        setLoaded(true);
      });
    // Load ShipGlobal creds separately — must not block main order data
    Promise.all([loadK(SG_CREDS_KEY),loadK(SG_TOKEN_KEY)]).then(([sgC,sgT])=>{
      if(sgC && !Array.isArray(sgC)) setSgCreds(sgC);
      if(sgT?.token && sgT.expiresAt > Date.now()/1000) setSgToken(sgT.token);
    }).catch(()=>{});
  },[]);

  const persistEtsy = async (o,p,s) => {
    setOrders(o); setProcessed(p); setSettings(s);
    await saveK(ETSY_KEY,{orders:o,processed:p,settings:s});
  };
  const persistBatch = async b => { setBatch(b); await saveK(BATCH_KEY,b); };

  /* SYNC ALL ORDERS — paginate through all 905 */
  const syncEtsy = async () => {
    const sid = settings.shopId||"21113006";
    setSyncing(true); setSyncErr(""); setSyncProg("Connecting…");
    try {
      const minCreated = settings.lastSyncAt
        ? Math.floor(new Date(settings.lastSyncAt).getTime()/1000) - 86400
        : Math.floor(Date.now()/1000) - 365*86400; // 1 year on first sync

      let allNew = [], off = 0, total = null;
      const existingIds = new Set(orders.map(o=>o.receipt_id));

      do {
        setSyncProg(`Fetching orders ${off+1}…${total?` of ${total}`:""}`);
        const r = await fetch(`/api/etsy?action=orders&shop_id=${sid}&limit=100&offset=${off}&min_created=${minCreated}`);
        const d = await r.json();
        if (!r.ok) throw new Error(d.error||"API error");
        if (total === null) total = d.count;
        const batch = (d.results||[]).filter(o=>!existingIds.has(o.receipt_id));
        allNew = [...allNew, ...batch];
        off += 100;
        if (off < total && d.results?.length === 100) await new Promise(r=>setTimeout(r,220)); // respect rate limit
        else break;
      } while (off < total);

      const merged = [...allNew, ...orders];
      const newSettings = {...settings, shopId:sid, lastSyncAt:new Date().toISOString()};
      await persistEtsy(merged, processed, newSettings);
      showToast(allNew.length>0 ? `✓ ${allNew.length} new orders synced (${merged.length} total)` : `✓ Up to date — ${merged.length} orders`);
    } catch(e) { setSyncErr(e.message); }
    finally { setSyncing(false); setSyncProg(""); }
  };

  /* process order */
  const handleProcess = async (order, item) => {
    await persistBatch([...batch, item]);
    await persistEtsy(orders, {...processed, [order.receipt_id]:item.id}, settings);
    setModal(null);
    showToast("✓ Added to batch");
  };

  const skipOrder = async order => {
    await persistEtsy(orders, {...processed, [order.receipt_id]:"skipped"}, settings);
    showToast("Skipped");
  };

  const removeFromBatch = async id => {
    const item = batch.find(b=>b.id===id);
    const nb = batch.filter(b=>b.id!==id);
    const np = {...processed};
    if(item?.etsyReceiptId&&np[item.etsyReceiptId]===id) delete np[item.etsyReceiptId];
    await persistBatch(nb);
    await persistEtsy(orders, np, settings);
  };

  /* create invoice */
  const createInvoice = async () => {
    if(!batch.length) return;
    setCreating(true);
    try {
      const existing = await loadKFresh(INV_KEY)||[];
      const maxNo = existing.reduce((mx,inv)=>{ const m=(inv.invNo||"").match(/(\d+)/); return m?Math.max(mx,+m[1]):mx; },0);
      const invNo = `NG-${String(maxNo+1).padStart(3,"0")}`;
      const byCur = {};
      batch.forEach(item=>{ const c=item.currency||"INR"; if(!byCur[c]) byCur[c]=[]; byCur[c].push(item); });
      const newInvs = Object.entries(byCur).map(([cur,items],ci)=>({
        id:uid(), invNo:ci===0?invNo:`${invNo}-${ci+1}`,
        type:"commercial", date:today(),
        dueDate:new Date(Date.now()+7*86400000).toISOString().slice(0,10),
        buyerId:atyaharaId||"", consigneeSameAsBuyer:true,
        consigneeName:"",consigneeAddress:"",consigneeCountry:"",
        currency:cur, portLading:"Mumbai, India", portDischarge:"",
        terms:"Internal",
        items:items.map(item=>({
          id:uid(), desc:`${item.desc} [Etsy #${item.etsyReceiptId}]`,
          hsn:"71031029", qty:String(item.qty), unit:item.unit,
          rate:String(item.rate), igst:0, amt:item.amt,
          _etsyReceiptId:item.etsyReceiptId, _fulfillment:item.fulfill,
          _stockId:item.stockId, _buyerCountry:item.buyerCountry, _buyerName:item.buyerName,
        })),
        totalAmt:items.reduce((s,i)=>s+i.amt,0),
        shippingCost:0,
        notes:`Etsy batch — ${items.map(i=>`#${i.etsyReceiptId}`).join(", ")}`,
        status:"draft", paidAmount:0, payments:[], _etsyBatch:true,
        createdAt:new Date().toISOString(),
      }));
      await saveK(INV_KEY, [...existing,...newInvs]);
      await persistBatch([]);
      showToast(`✓ Invoice${newInvs.length>1?"s":""} created — open Invoicing to review`);
    } catch(e) { showToast("⚠ "+e.message); }
    finally { setCreating(false); }
  };

  /* derived */
  const sorted   = [...orders].sort((a,b)=>b.create_timestamp-a.create_timestamp);
  const pending  = sorted.filter(o=>!processed[o.receipt_id]);
  const done     = sorted.filter(o=>!!processed[o.receipt_id]);
  const groups   = groupOrders(pending);

  const searchFiltered = search
    ? sorted.filter(o=>
        o.name?.toLowerCase().includes(search.toLowerCase()) ||
        String(o.receipt_id).includes(search) ||
        (o.transactions||[]).some(t=>t.title?.toLowerCase().includes(search.toLowerCase()))
      )
    : null;

  const FI = {background:C.surface,border:`1.5px solid ${C.border}`,color:C.ink,borderRadius:6,padding:"6px 12px",fontSize:13,fontFamily:"inherit"};

  const PLATFORMS = [
    { id:"etsy",     label:"🛍 Etsy",          color:"#F56400" },
    { id:"ebay",     label:"🔵 eBay",           color:"#0064D2" },
    { id:"atyahara", label:"🌿 Atyahara",       color:"#2E7D32" },
    { id:"earth",    label:"🌍 Earth Editions", color:"#5A3A8A" },
  ];

  return (
    <Shell
      title="Listing Manager"
      subtitle={platform==="etsy"
        ? (settings.lastSyncAt
            ? `Etsy · Last synced ${fmtDate(settings.lastSyncAt.slice(0,10))} · ${orders.length} orders`
            : "Etsy · Not synced yet")
        : PLATFORMS.find(p=>p.id===platform)?.label.replace(/^[^ ]+ /,"")||""}
      onHome={onHome}
      actions={platform==="etsy"
        ? <div style={{display:"flex",gap:8,alignItems:"center"}}>
            {batch.length>0&&(
              <button onClick={()=>setTab("batch")} style={{background:C.greenBg,border:`1.5px solid ${C.green}`,
                color:C.green,borderRadius:6,padding:"6px 14px",fontSize:12,fontWeight:700,cursor:"pointer"}}>
                Batch ({batch.length})
              </button>
            )}
            <button onClick={syncEtsy} disabled={syncing}
              style={{background:C.ink,color:"#FAF0DC",border:"none",borderRadius:6,
                padding:"7px 18px",fontSize:12,fontWeight:600,cursor:syncing?"wait":"pointer",opacity:syncing?.7:1}}>
              {syncing ? syncProg||"Syncing…" : "⟳ Sync All"}
            </button>
          </div>
        : null
      }
    >
      {/* toast */}
      {toast&&(
        <div style={{position:"fixed",bottom:28,left:"50%",transform:"translateX(-50%)",
          background:C.ink,color:"#fff",padding:"10px 22px",borderRadius:10,fontSize:12,
          zIndex:9999,boxShadow:"0 8px 28px rgba(0,0,0,.2)",whiteSpace:"nowrap"}}>
          {toast}
        </div>
      )}

      {/* ── PLATFORM SWITCHER ── */}
      <div style={{background:C.surface,borderBottom:`1px solid ${C.border}`,
        padding:mob()?"0 12px":"0 28px",display:"flex",gap:0,overflowX:"auto"}}>
        {PLATFORMS.map(p=>(
          <button key={p.id} onClick={()=>setPlatform(p.id)} style={{
            padding:"12px 20px",background:"none",border:"none",
            borderBottom:`3px solid ${platform===p.id?p.color:"transparent"}`,
            color:platform===p.id?p.color:C.inkMid,
            fontWeight:platform===p.id?700:400,
            fontSize:mob()?12:13,cursor:"pointer",marginBottom:-1,
            whiteSpace:"nowrap",transition:"all .15s",fontFamily:"inherit"}}>
            {p.label}
          </button>
        ))}
      </div>

      {/* error */}
      {platform==="etsy"&&syncErr&&(
        <div style={{background:C.redBg,border:`1px solid ${C.red}`,padding:"10px 28px",fontSize:12,color:C.red}}>
          ⚠ {syncErr}
        </div>
      )}

      {/* ── NON-ETSY PLACEHOLDERS ── */}
      {platform!=="etsy"&&(
        <div style={{padding:"80px 28px",textAlign:"center",maxWidth:480,margin:"0 auto"}}>
          <div style={{fontSize:48,marginBottom:16}}>
            {platform==="ebay"?"🔵":platform==="atyahara"?"🌿":"🌍"}
          </div>
          <div style={{fontFamily:"'Cormorant Garamond',Georgia,serif",fontSize:24,fontWeight:600,marginBottom:8,color:C.ink}}>
            {PLATFORMS.find(p=>p.id===platform)?.label}
          </div>
          <div style={{fontSize:14,color:C.inkFaint,marginBottom:24,lineHeight:1.6}}>
            {platform==="ebay"&&"eBay listings, orders, and inventory sync is coming soon. Connect your eBay seller account to manage listings here."}
            {platform==="atyahara"&&"Atyahara website listings and direct orders will appear here. Integration coming soon."}
            {platform==="earth"&&"Earth Editions listings and orders will appear here. Integration coming soon."}
          </div>
          <div style={{display:"inline-flex",alignItems:"center",gap:8,background:C.card,border:`1.5px solid ${C.border}`,borderRadius:10,padding:"12px 20px",fontSize:13,color:C.inkFaint}}>
            <span>🔧</span> Coming soon
          </div>
        </div>
      )}

      {/* ── Etsy sub-tab bar ── */}
      {platform==="etsy"&&(
        <div style={{background:C.surface,borderBottom:`1px solid ${C.border}`,
          padding:mob()?"0 14px":"0 28px",display:"flex",alignItems:"center",gap:0,overflowX:"auto"}}>
          {[
            ["orders",   `New (${pending.length})`],
            ["done",     `Completed (${done.length})`],
            ["batch",    `Batch (${batch.length})`],
            ["listings", "Listings"],
          ].map(([id,label])=>(
            <button key={id} onClick={()=>setTab(id)} style={{
              padding:"12px 18px",background:"none",border:"none",
              borderBottom:`2.5px solid ${tab===id?C.gold:"transparent"}`,
              color:tab===id?C.ink:C.inkMid,fontWeight:tab===id?700:400,
              fontSize:13,cursor:"pointer",marginBottom:-1,whiteSpace:"nowrap"}}>
              {label}
            </button>
          ))}
          <div style={{flex:1}}/>
          {(tab==="orders"||tab==="done")&&(
            <input value={search} onChange={e=>setSearch(e.target.value)}
              placeholder="Search orders, names…"
              style={{...FI,width:200,fontSize:12,padding:"6px 12px",borderRadius:20}}/>
          )}
        </div>
      )}

      {/* ══ ORDERS TAB ══ */}
      {platform==="etsy"&&tab==="orders"&&(
        <div style={{maxWidth:1000,margin:"0 auto"}}>
          {!loaded&&<div style={{padding:"60px 0",textAlign:"center",color:C.inkFaint}}>Loading…</div>}

          {loaded&&orders.length===0&&(
            <div style={{padding:"60px 28px",textAlign:"center",color:C.inkFaint}}>
              <div style={{fontSize:32,marginBottom:12}}>📦</div>
              <div style={{fontSize:15,fontWeight:600,marginBottom:8}}>No orders synced yet</div>
              <div style={{fontSize:13,marginBottom:16}}>Click "Sync All" to pull all your Atyahara orders</div>
              <button onClick={syncEtsy} style={{background:C.ink,color:"#FAF0DC",border:"none",borderRadius:8,padding:"10px 24px",fontSize:14,fontWeight:600,cursor:"pointer"}}>
                ⟳ Sync All Orders
              </button>
            </div>
          )}

          {/* search results override groups */}
          {searchFiltered && (
            <div style={{borderTop:`1px solid ${C.border}`}}>
              {searchFiltered.length===0
                ? <div style={{padding:"40px 0",textAlign:"center",color:C.inkFaint}}>No orders match "{search}"</div>
                : searchFiltered.map(o=>(
                    <OrderRow key={o.receipt_id} order={o} getImg={getImg} cache={cache}
                      onProcess={setModal} onSkip={skipOrder} isProcessed={!!processed[o.receipt_id]}
                      sgCreds={sgCreds} sgToken={sgToken}
                      onSgConnect={()=>setSgConnect(true)}
                      onCreateLabel={order=>setSgLabelOrder(order)}/>
                  ))
              }
            </div>
          )}

          {/* grouped by urgency */}
          {!searchFiltered && groups.map(g=>(
            <div key={g.key}>
              <div style={{padding:"10px 20px",background:g.key==="overdue"?C.redBg:C.bg,
                borderBottom:`1px solid ${C.border}`,borderTop:`1px solid ${C.border}`,
                display:"flex",alignItems:"center",gap:10}}>
                <span style={{fontSize:13,fontWeight:700,color:g.color}}>{g.label}</span>
                <span style={{fontSize:12,color:C.inkMid,fontWeight:600}}>{g.orders.length}</span>
                {g.key==="overdue"&&<span style={{fontSize:11,color:C.red}}>· Needs attention</span>}
                <a href="javascript:void 0" onClick={()=>setSearch("")}
                  style={{marginLeft:"auto",fontSize:11,color:C.blue,textDecoration:"none",cursor:"pointer"}}/>
              </div>
              {g.orders.map(o=>(
                <OrderRow key={o.receipt_id} order={o} getImg={getImg} cache={cache}
                  onProcess={setModal} onSkip={skipOrder} isProcessed={!!processed[o.receipt_id]}
                  sgCreds={sgCreds} sgToken={sgToken}
                  onSgConnect={()=>setSgConnect(true)}
                  onCreateLabel={order=>setSgLabelOrder(order)}/>
              ))}
            </div>
          ))}

          {!searchFiltered && loaded && pending.length===0 && orders.length>0 && (
            <div style={{padding:"60px 0",textAlign:"center",color:C.inkFaint}}>
              <div style={{fontSize:28,marginBottom:10}}>✓</div>
              <div style={{fontSize:14,fontWeight:600}}>All caught up!</div>
              <div style={{fontSize:12,marginTop:4}}>No pending orders · {done.length} completed</div>
            </div>
          )}
        </div>
      )}

      {/* ══ DONE TAB ══ */}
      {platform==="etsy"&&tab==="done"&&(
        <div style={{maxWidth:1000,margin:"0 auto"}}>
          {/* filter chips */}
          <div style={{padding:"10px 20px",borderBottom:`1px solid ${C.border}`,display:"flex",gap:8}}>
            {[["all","All"],["shipped","Shipped"],["skipped","Skipped"]].map(([v,l])=>(
              <button key={v} onClick={()=>setDoneFilter(v)}
                style={{padding:"4px 14px",borderRadius:20,border:`1.5px solid ${doneFilter===v?C.gold:C.border}`,
                  background:doneFilter===v?C.amberBg:C.surface,cursor:"pointer",fontSize:12,
                  fontWeight:doneFilter===v?700:400,color:doneFilter===v?C.ink:C.inkMid}}>
                {l}
              </button>
            ))}
          </div>

          {(searchFiltered||done)
            .filter(o => doneFilter==="all"||
              (doneFilter==="shipped"&&o.is_shipped)||
              (doneFilter==="skipped"&&processed[o.receipt_id]==="skipped"))
            .map(o=>(
              <OrderRow key={o.receipt_id} order={o} getImg={getImg} cache={cache}
                onProcess={setModal} onSkip={skipOrder} isProcessed={!!processed[o.receipt_id]}
                sgCreds={sgCreds} sgToken={sgToken}
                onSgConnect={()=>setSgConnect(true)}
                onCreateLabel={order=>setSgLabelOrder(order)}/>
            ))
          }
        </div>
      )}

      {/* ══ BATCH TAB ══ */}
      {platform==="etsy"&&tab==="batch"&&(
        <BatchTab batch={batch} buyers={buyers} atyaharaId={atyaharaId}
          setAtyaharaId={setAtyaharaId} onRemove={removeFromBatch}
          onCreateInvoice={createInvoice} creating={creating}/>
      )}

      {/* ══ LISTINGS TAB ══ */}
      {platform==="etsy"&&tab==="listings"&&(
        <ListingsTab shopId={settings.shopId||"21113006"}/>
      )}

      {/* process modal */}
      {platform==="etsy"&&modal&&(
        <ProcessModal order={modal} stock={stock}
          onSave={item=>handleProcess(modal,item)}
          onClose={()=>setModal(null)}/>
      )}

      {sgConnect && (
        <ShipGlobalConnectModal
          onClose={()=>setSgConnect(false)}
          onSave={(creds, token) => {
            setSgCreds(creds);
            setSgToken(token);
            setSgConnect(false);
            showToast("✓ ShipGlobal connected");
          }}/>
      )}

      {sgLabelOrder && sgCreds && sgToken && (
        <ShipGlobalLabelModal
          order={sgLabelOrder}
          creds={sgCreds}
          token={sgToken}
          onClose={()=>setSgLabelOrder(null)}
          onSuccess={()=>{ setSgLabelOrder(null); showToast("✓ Label downloaded"); }}/>
      )}
    </Shell>
  );
}
