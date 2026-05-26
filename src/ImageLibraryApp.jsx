import { useState, useEffect, useRef, useCallback } from "react";
import { uploadToStorage } from "./storageUtils.js";
import { loadK, saveK, uid } from "./utils.js";
import { SHAPES, KEYS } from "./constants.js";

const mob = window.innerWidth < 700;

const C = {
  bg: "var(--c-bg)", surface: "var(--c-surface)", card: "var(--c-card)",
  border: "var(--c-border)", borderHi: "var(--c-borderHi)",
  ink: "var(--c-ink)", inkMid: "var(--c-inkMid)", inkFaint: "var(--c-inkFaint)",
  gold: "var(--c-gold)", goldBright: "var(--c-goldBright)",
  green: "var(--c-green)", greenBg: "var(--c-greenBg)",
  red: "var(--c-red)", redBg: "var(--c-redBg)",
  amber: "var(--c-amber)", amberBg: "var(--c-amberBg)",
};

const FI = {
  border: `1px solid var(--c-border)`, borderRadius: 7, padding: "8px 11px",
  fontSize: 13, background: "var(--c-bg)", color: "var(--c-ink)",
  outline: "none", fontFamily: "inherit", width: "100%", boxSizing: "border-box",
};

const IMG_KEY    = "ng-image-library-v1";
const SHAPES_KEY = "ng-ds-shapes-v1";

const MARKETS = [
  { id: "etsy",         label: "Etsy" },
  { id: "atyahara",     label: "Atyahara" },
  { id: "eartheditions",label: "Earth Ed." },
  { id: "ebay",         label: "eBay" },
];

const fmtSize = b => {
  if (!b) return "";
  return b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.round(b / 1024) + " KB";
};

const isVideoEntry = entry =>
  entry?.mediaType === "video" ||
  /\.(mp4|mov|avi|webm|mkv)(\?|$)/i.test(entry?.imageUrl || "");

// Group flat image array into listings (unique name+category combos)
// Preserves global array order so first image = cover
function groupListings(images) {
  const seen = new Map();
  for (const img of images) {
    const k = `${img.name}|||${img.category || ""}`;
    if (!seen.has(k)) seen.set(k, { key: k, name: img.name, category: img.category || "", imgs: [] });
    seen.get(k).imgs.push(img);
  }
  return Array.from(seen.values()).map(l => ({ ...l, cover: l.imgs[0], usedOn: l.imgs[0]?.usedOn || [] }));
}

function Toast({ msg }) {
  if (!msg) return null;
  return (
    <div style={{ position: "fixed", bottom: 28, left: "50%", transform: "translateX(-50%)", background: C.ink, color: "#FAF0DC", borderRadius: 8, padding: "10px 20px", fontSize: 13, fontWeight: 500, zIndex: 9999, boxShadow: "0 4px 20px rgba(0,0,0,.22)", pointerEvents: "none" }}>
      {msg}
    </div>
  );
}

function Combobox({ value, onChange, options, placeholder, onCreateNew, disabled }) {
  const [input, setInput] = useState(value || "");
  const [open, setOpen]   = useState(false);
  const [hi, setHi]       = useState(0);
  const wrapRef = useRef(null);

  useEffect(() => { setInput(value || ""); }, [value]);

  const filtered = input.trim()
    ? options.filter(o => o.toLowerCase().includes(input.toLowerCase()))
    : options;

  const exactMatch = options.some(o => o.toLowerCase() === input.trim().toLowerCase());
  const showCreate = input.trim() && !exactMatch;

  const pick = useCallback(opt => {
    setInput(opt); onChange(opt); setOpen(false); setHi(0);
  }, [onChange]);

  const handleCreate = useCallback(() => {
    const v = input.trim();
    if (!v) return;
    onCreateNew(v); setOpen(false); setHi(0);
  }, [input, onCreateNew]);

  useEffect(() => {
    const fn = e => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, []);

  const allOpts = [...filtered, ...(showCreate ? ["__create__"] : [])];

  return (
    <div ref={wrapRef} style={{ position: "relative", width: "100%" }}>
      <input
        value={input}
        onChange={e => { setInput(e.target.value); onChange(e.target.value); setOpen(true); setHi(0); }}
        onFocus={() => setOpen(true)}
        onKeyDown={e => {
          if (!open) { setOpen(true); return; }
          if (e.key === "ArrowDown") { e.preventDefault(); setHi(h => Math.min(h + 1, allOpts.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setHi(h => Math.max(h - 1, 0)); }
          else if (e.key === "Enter") {
            e.preventDefault();
            const opt = allOpts[hi];
            if (opt === "__create__") handleCreate();
            else if (opt) pick(opt);
          }
          else if (e.key === "Escape") setOpen(false);
        }}
        placeholder={placeholder}
        disabled={disabled}
        style={{ ...FI, paddingRight: 28 }}
        autoComplete="off"
      />
      <span onClick={() => !disabled && setOpen(o => !o)}
        style={{ position: "absolute", right: 9, top: "50%", transform: "translateY(-50%)", color: C.inkFaint, fontSize: 10, cursor: "pointer", userSelect: "none" }}>▼</span>

      {open && allOpts.length > 0 && (
        <div style={{ position: "absolute", top: "calc(100% + 3px)", left: 0, right: 0, background: C.surface, border: `1.5px solid ${C.border}`, borderRadius: 8, zIndex: 200, maxHeight: 220, overflowY: "auto", boxShadow: "0 6px 24px rgba(0,0,0,.14)" }}>
          {filtered.map((opt, i) => (
            <div key={opt} onMouseDown={() => pick(opt)}
              style={{ padding: "8px 12px", fontSize: 13, cursor: "pointer", background: hi === i ? C.amberBg : "transparent", color: C.ink, fontWeight: hi === i ? 600 : 400 }}
              onMouseEnter={() => setHi(i)}>{opt}</div>
          ))}
          {showCreate && (
            <div onMouseDown={handleCreate}
              style={{ padding: "8px 12px", fontSize: 13, cursor: "pointer", background: hi === filtered.length ? C.greenBg : "transparent", color: C.green, fontWeight: 600, borderTop: filtered.length ? `1px solid ${C.border}` : "none" }}
              onMouseEnter={() => setHi(filtered.length)}>
              + Create "{input.trim()}"
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Renders an img or video element depending on the entry type
function MediaThumb({ src, isVideo, alt, style, onError }) {
  if (isVideo) {
    return <video src={src} style={style} muted playsInline preload="metadata" />;
  }
  return <img src={src} alt={alt} style={style} onError={onError} />;
}

export default function ImageLibraryApp({ onHome }) {
  const [images, setImages]           = useState([]);
  const [loaded, setLoaded]           = useState(false);
  const [shapes, setShapes]           = useState([]);
  const [stones, setStones]           = useState([]);
  const [filterCats,      setFilterCats]      = useState(new Set());
  const [filterStones,    setFilterStones]    = useState(new Set());
  const [filterPlatforms, setFilterPlatforms] = useState(new Set());
  const [search,          setSearch]          = useState("");
  const [sidebarOpen,     setSidebarOpen]     = useState(false); // mobile toggle
  // which sidebar sections are collapsed
  const [collapsed, setCollapsed] = useState({ stone: false, shape: false, platform: false });

  // listing detail view — drill into a product card
  const [listingView, setListingView] = useState(null); // {name, category} | null

  // modals
  const [addOpen, setAddOpen]         = useState(false);
  const [addToExisting, setAddToExisting] = useState(null); // {name,category} | null — prefill when adding to existing listing
  const [lightbox, setLightbox]       = useState(null);
  const [editMeta, setEditMeta]       = useState(null); // {origName,origCat,name,category,notes}

  const [toast, setToast]             = useState("");
  const showToast = m => { setToast(m); setTimeout(() => setToast(""), 2800); };
  const [dropActive, setDropActive]   = useState(false);
  // page-level file drag: null | "new" | {name,category}
  const [pageDropTarget, setPageDropTarget] = useState(null);

  // ── Bulk selection ───────────────────────────────────────────────
  const [selectMode,     setSelectMode]     = useState(false);
  const [selectedKeys,   setSelectedKeys]   = useState(new Set()); // Set of "name|||category"
  const [bulkMarkModal,  setBulkMarkModal]  = useState(false);     // platform picker
  const [bulkMetaModal,  setBulkMetaModal]  = useState(null);      // {name,category,notes}
  const [bulkMarkState,  setBulkMarkState]  = useState(new Set()); // platforms toggled in modal

  const exitSelectMode = () => { setSelectMode(false); setSelectedKeys(new Set()); };
  const toggleSelect = key => setSelectedKeys(prev => { const s = new Set(prev); s.has(key) ? s.delete(key) : s.add(key); return s; });

  // ── Shopify push state ───────────────────────────────────────────
  const [shopifyModal,   setShopifyModal]   = useState(null);  // {name,price,creds,shopifyProductId}
  const [shopifyPushing, setShopifyPushing] = useState(false);
  const [shopifySetup,   setShopifySetup]   = useState(false); // show creds entry
  const [shopifyStore,   setShopifyStore]   = useState("");
  const [shopifyToken,   setShopifyToken]   = useState("");

  // upload state
  const [items, setItems]       = useState([]);
  const [sharedCat, setSharedCat]     = useState("");
  const [sharedStone, setSharedStone] = useState("");
  const [sharedNotes, setSharedNotes] = useState("");
  const [uploading, setUploading]     = useState(false);
  const fileRef = useRef(null);
  const dragId   = useRef(null);  // id of image being dragged
  const [dragOver, setDragOver] = useState(null); // id of image being hovered over

  // Always clear the page-drop overlay when drag ends for any reason
  // (Escape key, drop on modal with stopPropagation, drop outside window, etc.)
  useEffect(() => {
    const clear = () => setPageDropTarget(null);
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => { window.removeEventListener("dragend", clear); window.removeEventListener("drop", clear); };
  }, []);

  useEffect(() => {
    Promise.all([loadK(IMG_KEY), loadK(SHAPES_KEY), loadK(KEYS.stock)]).then(([imgs, cs, stockItems]) => {
      const imgList = Array.isArray(imgs) ? imgs : [];
      setImages(imgList);
      const allShapes = [...new Set([...SHAPES, ...(Array.isArray(cs) ? cs : [])])].sort();
      const stockStones = (Array.isArray(stockItems) ? stockItems : []).map(s => s.material).filter(Boolean);
      const imgStones = imgList.map(x => x.name).filter(Boolean);
      const allStones = [...new Set([...stockStones, ...imgStones])].sort();
      setShapes(allShapes);
      setStones(allStones);
      setLoaded(true);
    });
  }, []);

  useEffect(() => { if (shapes.length && !sharedCat) setSharedCat(shapes[0]); }, [shapes]);
  useEffect(() => { if (stones.length && !sharedStone) setSharedStone(stones[0]); }, [stones]);

  const persist = async next => { setImages(next); await saveK(IMG_KEY, next); };

  // ── Shopify push logic ───────────────────────────────────────────
  const doPushShopify = async (creds, customName, customPrice) => {
    setShopifyPushing(true);
    const listingImgs = images.filter(img => img.name === listingView?.name && img.category === listingView?.category);
    const coverImg = listingImgs[0];
    const existingProductId = coverImg?.shopifyProductId;
    // Collect all photo URLs for this listing (cover first)
    const photos = listingImgs.map(img => img.imageUrl).filter(Boolean);
    try {
      const item = {
        id: `img-${listingView?.name||""}-${listingView?.category||""}`,
        material: listingView?.name || "",
        shape: listingView?.category || "",
        photo: photos[0] || "",    // cover (backwards compat)
        photos,                    // all photos in listing order
        shopifyProductId: existingProductId || undefined,
        qty: "1", unit: "pcs",
      };
      const res = await fetch("/api/shopify", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: existingProductId ? "update" : "create", item, shopStore: creds.store, shopToken: creds.token, shopifyName: customName, shopifyPrice: customPrice }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Shopify error");
      // Persist shopifyProductId and mark as listed on Earth Editions
      const next = images.map(img => {
        if (img.name !== listingView?.name || img.category !== listingView?.category) return img;
        const usedOn = img.usedOn || [];
        return {
          ...img,
          shopifyProductId: d.shopifyProductId,
          usedOn: usedOn.includes("eartheditions") ? usedOn : [...usedOn, "eartheditions"],
        };
      });
      await persist(next);
      showToast(`✓ ${d.action === "created" ? "Created" : "Updated"} on Shopify`);
    } catch(e) { showToast("❌ " + e.message); }
    finally { setShopifyPushing(false); }
  };

  const openShopifyPush = async () => {
    const creds = await loadK("ng-shopify-creds-v1") || {};
    if (!creds.store || !creds.token) { setShopifyStore(creds.store || ""); setShopifyToken(""); setShopifySetup(true); return; }
    const coverImg = images.find(img => img.name === listingView?.name && img.category === listingView?.category);
    const autoName = [listingView?.name, listingView?.category].filter(Boolean).join(" — ");
    setShopifyModal({ name: autoName, price: "", creds, shopifyProductId: coverImg?.shopifyProductId || null });
  };

  const saveShopifyCreds = async () => {
    const store = shopifyStore.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    const token = shopifyToken.trim();
    if (!store || !token) { showToast("Enter store and token"); return; }
    const creds = { store, token };
    await saveK("ng-shopify-creds-v1", creds);
    setShopifySetup(false);
    const coverImg = images.find(img => img.name === listingView?.name && img.category === listingView?.category);
    const autoName = [listingView?.name, listingView?.category].filter(Boolean).join(" — ");
    setShopifyModal({ name: autoName, price: "", creds, shopifyProductId: coverImg?.shopifyProductId || null });
  };

  const createShape = async val => {
    if (!val.trim() || shapes.includes(val.trim())) return;
    const next = [...shapes, val.trim()].sort();
    setShapes(next);
    setSharedCat(val.trim());
    const custom = next.filter(s => !SHAPES.includes(s));
    await saveK(SHAPES_KEY, custom);
    showToast(`Shape "${val.trim()}" created`);
  };

  const createStone = val => {
    if (!val.trim() || stones.includes(val.trim())) return;
    setStones(prev => [...new Set([...prev, val.trim()])].sort());
    setSharedStone(val.trim());
    showToast(`Stone "${val.trim()}" added`);
  };

  // Returns true if a drag event is carrying files (not an element reorder)
  const isFileDrag = e => e.dataTransfer?.types && Array.from(e.dataTransfer.types).includes("Files");

  // ── Upload ──────────────────────────────────────────────────────
  const openAdd = (existing = null, prefillFiles = null) => {
    if (prefillFiles && prefillFiles.length > 0) {
      setItems(Array.from(prefillFiles).map(f => ({
        id: uid(), file: f,
        preview: URL.createObjectURL(f),
        isVideo: f.type.startsWith("video/"),
        uploading: false, done: false, error: "",
      })));
    } else {
      setItems([]);
    }
    setSharedNotes("");
    if (existing) {
      setSharedStone(existing.name);
      setSharedCat(existing.category);
      setAddToExisting(existing);
    } else {
      if (shapes.length) setSharedCat(shapes[0]);
      if (stones.length) setSharedStone(stones[0]);
      setAddToExisting(null);
    }
    setAddOpen(true);
  };

  const processFiles = fileList => {
    const files = Array.from(fileList);
    if (!files.length) return;
    const newItems = files.map(f => ({
      id: uid(),
      file: f,
      preview: URL.createObjectURL(f),
      isVideo: f.type.startsWith("video/"),
      uploading: false,
      done: false,
      error: "",
    }));
    setItems(prev => [...prev, ...newItems]);
    if (fileRef.current) fileRef.current.value = "";
  };

  const removeItem = id => {
    setItems(prev => {
      const item = prev.find(x => x.id === id);
      if (item?.preview?.startsWith("blob:")) URL.revokeObjectURL(item.preview);
      return prev.filter(x => x.id !== id);
    });
  };

  const doUpload = async () => {
    if (!items.length || !sharedCat || !sharedStone) return;
    setUploading(true);
    const newEntries = [];
    const pending = items.filter(x => !x.done);
    for (const item of pending) {
      setItems(prev => prev.map(x => x.id === item.id ? { ...x, uploading: true, error: "" } : x));
      try {
        const ext = item.file.name.split(".").pop().toLowerCase() || (item.isVideo ? "mp4" : "jpg");
        const safe = sharedStone.toLowerCase().replace(/[^a-z0-9]/g, "-");
        const safeCat = sharedCat.toLowerCase().replace(/[^a-z0-9]/g, "-");
        let fileUrl;

        {
          const prefix = item.isVideo ? "videos" : "images";
          const filename = `${prefix}/${safeCat}/${uid()}-${safe}.${ext}`;
          fileUrl = await uploadToStorage(filename, item.file);
        }

        newEntries.push({
          id: uid(),
          name: sharedStone,
          category: sharedCat,
          notes: sharedNotes.trim(),
          imageUrl: fileUrl,
          mediaType: item.isVideo ? "video" : "image",
          size: item.file.size,
          createdAt: new Date().toISOString(),
        });
        setItems(prev => prev.map(x => x.id === item.id ? { ...x, uploading: false, done: true } : x));
      } catch (e) {
        setItems(prev => prev.map(x => x.id === item.id ? { ...x, uploading: false, error: e.message || "Upload failed" } : x));
      }
    }
    if (newEntries.length) {
      let next;
      if (addToExisting) {
        // insert after the last image in this listing
        const lastIdx = [...images].reduceRight((found, img, i) =>
          found === -1 && img.name === addToExisting.name && img.category === addToExisting.category ? i : found, -1);
        next = [...images];
        next.splice(lastIdx + 1, 0, ...newEntries);
      } else {
        next = [...newEntries, ...images];
      }
      await persist(next);
      showToast(`${newEntries.length} file${newEntries.length > 1 ? "s" : ""} saved`);
      // open listing detail after creating a new listing
      if (!addToExisting && !listingView) {
        setListingView({ name: sharedStone, category: sharedCat });
      }
    }
    setUploading(false);
    if (newEntries.length === pending.length) {
      setAddOpen(false);
      setItems([]);
    }
  };

  // ── Listing operations ───────────────────────────────────────────
  // Move an image left/right within its listing (swaps positions in global array)
  const moveInListing = async (imgId, dir, listingImgs) => {
    const li = listingImgs.findIndex(x => x.id === imgId);
    const swapLi = dir === "left" ? li - 1 : li + 1;
    if (swapLi < 0 || swapLi >= listingImgs.length) return;
    const aId = imgId;
    const bId = listingImgs[swapLi].id;
    const aGlobal = images.findIndex(x => x.id === aId);
    const bGlobal = images.findIndex(x => x.id === bId);
    const next = [...images];
    [next[aGlobal], next[bGlobal]] = [next[bGlobal], next[aGlobal]];
    await persist(next);
  };

  // Move to position 0 in listing (set as cover)
  const setAsCover = async (imgId, listingImgs) => {
    if (listingImgs[0].id === imgId) return;
    const img = listingImgs.find(x => x.id === imgId);
    // remove from its current spot, insert before current first listing image
    const firstGlobal = images.findIndex(x => x.id === listingImgs[0].id);
    let next = images.filter(x => x.id !== imgId);
    // recalculate firstGlobal after removal
    const newFirstGlobal = next.findIndex(x => x.id === listingImgs[0].id);
    next.splice(newFirstGlobal, 0, img);
    await persist(next);
    showToast("Set as cover photo");
  };

  // Drag-and-drop reorder within listing
  const reorderInListing = async (fromId, toId) => {
    if (fromId === toId) return;
    const fromIdx = images.findIndex(x => x.id === fromId);
    const toIdx   = images.findIndex(x => x.id === toId);
    if (fromIdx < 0 || toIdx < 0) return;
    const next = [...images];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    await persist(next);
  };

  const deleteImg = async imgId => {
    if (!window.confirm("Remove this photo?")) return;
    const next = images.filter(x => x.id !== imgId);
    await persist(next);
    if (lightbox?.id === imgId) setLightbox(null);
    // if listing now empty, go back
    const remaining = next.filter(x => listingView && x.name === listingView.name && x.category === listingView.category);
    if (listingView && remaining.length === 0) setListingView(null);
    showToast("File removed");
  };

  // Rename/reassign all images in a listing
  const saveEditMeta = async () => {
    if (!editMeta) return;
    const { origName, origCat, name, category, notes } = editMeta;
    const next = images.map(x =>
      x.name === origName && x.category === origCat
        ? { ...x, name: name.trim() || x.name, category: category.trim() || x.category, notes: notes.trim() }
        : x
    );
    await persist(next);
    if (listingView) setListingView({ name: name.trim() || origName, category: category.trim() || origCat });
    setEditMeta(null);
    showToast("Listing updated");
  };

  const toggleMarket = async (name, category, market, e) => {
    e.stopPropagation();
    const usedOn = images.find(x => x.name === name && x.category === category)?.usedOn || [];
    const next = usedOn.includes(market) ? usedOn.filter(m => m !== market) : [...usedOn, market];
    const updated = images.map(x => x.name === name && x.category === category ? { ...x, usedOn: next } : x);
    await persist(updated);
  };

  // ── Bulk operations ─────────────────────────────────────────────
  const bulkDelete = async () => {
    if (!window.confirm(`Delete ${selectedKeys.size} listing${selectedKeys.size > 1 ? "s" : ""} and all their files? This cannot be undone.`)) return;
    const next = images.filter(img => {
      const k = `${img.name}|||${img.category || ""}`;
      return !selectedKeys.has(k);
    });
    await persist(next);
    showToast(`Deleted ${selectedKeys.size} listing${selectedKeys.size > 1 ? "s" : ""}`);
    exitSelectMode();
  };

  const openBulkMark = () => {
    // Pre-fill with platforms common to ALL selected listings
    const sel = listings.filter(l => selectedKeys.has(l.key));
    const common = MARKETS.map(m => m.id).filter(id => sel.every(l => (l.imgs[0]?.usedOn || []).includes(id)));
    setBulkMarkState(new Set(common));
    setBulkMarkModal(true);
  };

  const applyBulkMark = async () => {
    const next = images.map(img => {
      const k = `${img.name}|||${img.category || ""}`;
      if (!selectedKeys.has(k)) return img;
      return { ...img, usedOn: [...bulkMarkState] };
    });
    await persist(next);
    showToast(`Updated ${selectedKeys.size} listing${selectedKeys.size > 1 ? "s" : ""}`);
    setBulkMarkModal(false);
    exitSelectMode();
  };

  const applyBulkMeta = async () => {
    if (!bulkMetaModal) return;
    const { name, category, notes } = bulkMetaModal;
    const next = images.map(img => {
      const k = `${img.name}|||${img.category || ""}`;
      if (!selectedKeys.has(k)) return img;
      return {
        ...img,
        ...(name.trim()     ? { name: name.trim() }         : {}),
        ...(category.trim() ? { category: category.trim() } : {}),
        ...(notes !== "__unchanged__" ? { notes: notes.trim() } : {}),
      };
    });
    await persist(next);
    showToast(`Updated ${selectedKeys.size} listing${selectedKeys.size > 1 ? "s" : ""}`);
    setBulkMetaModal(null);
    exitSelectMode();
  };

  // ── Derived data ─────────────────────────────────────────────────
  const listings = groupListings(images);
  const uniqueCats   = [...new Set(images.map(x => x.category))].filter(Boolean).sort();
  const uniqueStones = [...new Set(images.map(x => x.name))].filter(Boolean).sort();
  const totalBytes   = images.reduce((s, x) => s + (x.size || 0), 0);

  const activeFilterCount = filterCats.size + filterStones.size + filterPlatforms.size;
  const clearFilters = () => { setFilterCats(new Set()); setFilterStones(new Set()); setFilterPlatforms(new Set()); setSearch(""); };
  const toggleSet = (setter, val) => setter(prev => { const s = new Set(prev); s.has(val) ? s.delete(val) : s.add(val); return s; });

  const filteredListings = listings
    .filter(l => filterCats.size === 0      || filterCats.has(l.category))
    .filter(l => filterStones.size === 0    || filterStones.has(l.name))
    .filter(l => filterPlatforms.size === 0 || filterPlatforms.size > 0 && [...filterPlatforms].every(p => (l.imgs[0]?.usedOn || []).includes(p)))
    .filter(l => !search ||
      l.name.toLowerCase().includes(search.toLowerCase()) ||
      l.category?.toLowerCase().includes(search.toLowerCase()) ||
      l.imgs.some(x => x.notes?.toLowerCase().includes(search.toLowerCase())));

  // current listing images (when drilled in)
  const listingImgs = listingView
    ? images.filter(x => x.name === listingView.name && x.category === listingView.category)
    : [];

  // ── Render ───────────────────────────────────────────────────────
  const pageDragLabel = pageDropTarget && typeof pageDropTarget === "object"
    ? `Add to ${pageDropTarget.name}`
    : listingView
    ? `Add to ${listingView.name}`
    : "Drop to create new listing";

  return (
    <div
      style={{ minHeight: "100vh", background: C.bg, fontFamily: "system-ui, sans-serif", position: "relative" }}
      onDragOver={e => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        // don't override a card-specific target set by card's onDragOver
        setPageDropTarget(pt => pt && typeof pt === "object" ? pt : (listingView ? "listing" : "new"));
      }}
      onDragLeave={e => {
        if (!isFileDrag(e)) return;
        // only clear when leaving the whole page
        if (!e.currentTarget.contains(e.relatedTarget)) setPageDropTarget(null);
      }}
      onDrop={e => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        const target = pageDropTarget;
        setPageDropTarget(null);
        if (target && typeof target === "object") {
          openAdd(target, e.dataTransfer.files);
        } else {
          openAdd(listingView || null, e.dataTransfer.files);
        }
      }}
    >
      <Toast msg={toast} />

      {/* ── Page-level file drop overlay ── */}
      {pageDropTarget !== null && !addOpen && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 2000, pointerEvents: "none",
          background: "rgba(26,19,8,.45)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <div style={{
            background: C.surface, border: `3px dashed ${C.gold}`, borderRadius: 20,
            padding: "40px 60px", textAlign: "center",
            boxShadow: "0 20px 60px rgba(0,0,0,.4)",
          }}>
            <div style={{ fontSize: 52, marginBottom: 10 }}>📂</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: C.ink, fontFamily: "'Cormorant Garamond',Georgia,serif" }}>
              {pageDragLabel}
            </div>
            <div style={{ fontSize: 13, color: C.inkFaint, marginTop: 6 }}>Release to open upload</div>
          </div>
        </div>
      )}

      {/* ── Bulk mark-as-listed modal ── */}
      {bulkMarkModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(26,19,8,.52)", zIndex: 950, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div style={{ background: C.surface, borderRadius: 13, width: "100%", maxWidth: 380, boxShadow: "0 20px 60px rgba(0,0,0,.3)", overflow: "hidden" }}>
            <div style={{ padding: "14px 18px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 18, fontWeight: 600 }}>Mark Listed On</div>
              <button onClick={() => setBulkMarkModal(false)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 22, color: C.inkFaint }}>&times;</button>
            </div>
            <div style={{ padding: "14px 18px" }}>
              <div style={{ fontSize: 12, color: C.inkFaint, marginBottom: 14 }}>
                Applies to {selectedKeys.size} selected listing{selectedKeys.size > 1 ? "s" : ""}. Replaces existing platform tags.
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {MARKETS.map(m => {
                  const on = bulkMarkState.has(m.id);
                  return (
                    <label key={m.id} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", padding: "8px 12px", borderRadius: 8, border: `1.5px solid ${on ? C.green : C.border}`, background: on ? C.greenBg : "transparent", transition: "all .12s" }}>
                      <input type="checkbox" checked={on}
                        onChange={() => setBulkMarkState(prev => { const s = new Set(prev); s.has(m.id) ? s.delete(m.id) : s.add(m.id); return s; })}
                        style={{ accentColor: C.green, width: 15, height: 15, cursor: "pointer" }} />
                      <span style={{ fontSize: 14, fontWeight: on ? 600 : 400, color: on ? C.green : C.ink }}>{m.label}</span>
                    </label>
                  );
                })}
              </div>
            </div>
            <div style={{ padding: "12px 18px", borderTop: `1px solid ${C.border}`, display: "flex", gap: 8 }}>
              <button onClick={() => setBulkMarkModal(false)} style={{ flex: 1, background: "none", border: `1px solid ${C.border}`, borderRadius: 7, padding: 10, cursor: "pointer", fontSize: 13, color: C.inkMid }}>Cancel</button>
              <button onClick={applyBulkMark} style={{ flex: 2, background: C.green, border: "none", borderRadius: 7, padding: 10, cursor: "pointer", fontSize: 13, fontWeight: 600, color: "#fff" }}>Apply to {selectedKeys.size} Listings</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Bulk edit metadata modal ── */}
      {bulkMetaModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(26,19,8,.52)", zIndex: 950, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div style={{ background: C.surface, borderRadius: 13, width: "100%", maxWidth: 420, boxShadow: "0 20px 60px rgba(0,0,0,.3)", overflow: "hidden" }}>
            <div style={{ padding: "14px 18px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 18, fontWeight: 600 }}>Edit Info</div>
              <button onClick={() => setBulkMetaModal(null)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 22, color: C.inkFaint }}>&times;</button>
            </div>
            <div style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ fontSize: 12, color: C.inkFaint, padding: "8px 12px", background: C.amberBg, borderRadius: 7, border: `1px solid ${C.amber}` }}>
                Editing {selectedKeys.size} listing{selectedKeys.size > 1 ? "s" : ""}. Leave a field blank to keep existing values.
              </div>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .6, marginBottom: 5 }}>Stone Name <span style={{ fontWeight: 400, textTransform: "none" }}>(leave blank = no change)</span></div>
                <Combobox value={bulkMetaModal.name} onChange={v => setBulkMetaModal(p => ({ ...p, name: v }))} options={stones} placeholder="e.g. Aquamarine…" onCreateNew={v => { createStone(v); setBulkMetaModal(p => ({ ...p, name: v.trim() })); }} />
              </div>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .6, marginBottom: 5 }}>Shape / Category <span style={{ fontWeight: 400, textTransform: "none" }}>(leave blank = no change)</span></div>
                <Combobox value={bulkMetaModal.category} onChange={v => setBulkMetaModal(p => ({ ...p, category: v }))} options={shapes} placeholder="e.g. Sphere, Tower…" onCreateNew={async v => { await createShape(v); setBulkMetaModal(p => ({ ...p, category: v.trim() })); }} />
              </div>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .6, marginBottom: 5 }}>Notes <span style={{ fontWeight: 400, textTransform: "none" }}>(leave blank = no change)</span></div>
                <input value={bulkMetaModal.notes === "__unchanged__" ? "" : bulkMetaModal.notes}
                  onChange={e => setBulkMetaModal(p => ({ ...p, notes: e.target.value }))}
                  placeholder="Size, grade, origin…" style={FI} />
              </div>
            </div>
            <div style={{ padding: "12px 18px", borderTop: `1px solid ${C.border}`, display: "flex", gap: 8 }}>
              <button onClick={() => setBulkMetaModal(null)} style={{ flex: 1, background: "none", border: `1px solid ${C.border}`, borderRadius: 7, padding: 10, cursor: "pointer", fontSize: 13, color: C.inkMid }}>Cancel</button>
              <button onClick={applyBulkMeta} style={{ flex: 2, background: C.ink, border: "none", borderRadius: 7, padding: 10, cursor: "pointer", fontSize: 13, fontWeight: 600, color: "#FAF0DC" }}>Apply to {selectedKeys.size} Listings</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Lightbox ── */}
      {lightbox && (
        <div onClick={() => setLightbox(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.88)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: C.surface, borderRadius: 14, width: "100%", maxWidth: 640, overflow: "hidden", boxShadow: "0 30px 90px rgba(0,0,0,.55)" }}>
            <div style={{ background: C.card, maxHeight: 460, display: "flex", alignItems: "center", justifyContent: "center" }}>
              {isVideoEntry(lightbox) ? (
                <video
                  src={lightbox.imageUrl}
                  controls
                  muted
                  style={{ width: "100%", maxHeight: 460, display: "block", background: "#000" }}
                />
              ) : (
                <img src={lightbox.imageUrl} alt={lightbox.name} style={{ width: "100%", maxHeight: 460, objectFit: "contain", display: "block" }} />
              )}
            </div>
            <div style={{ padding: "14px 18px", display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 15, color: C.ink }}>{lightbox.name}</div>
                <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 2 }}>
                  {lightbox.category}{lightbox.size ? ` · ${fmtSize(lightbox.size)}` : ""}{lightbox.notes ? ` · ${lightbox.notes}` : ""}
                </div>
              </div>
              <a href={lightbox.imageUrl} target="_blank" rel="noreferrer"
                style={{ fontSize: 12, color: C.gold, fontWeight: 600, textDecoration: "none", padding: "6px 12px", border: `1px solid ${C.border}`, borderRadius: 6, flexShrink: 0 }}>Open ↗</a>
              <button onClick={() => setLightbox(null)}
                style={{ background: "none", border: "none", fontSize: 22, cursor: "pointer", color: C.inkFaint, lineHeight: 1, padding: "0 4px", flexShrink: 0 }}>&times;</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Edit listing metadata modal ── */}
      {editMeta && (
        <div onClick={e => { if (e.target === e.currentTarget) setEditMeta(null); }}
          style={{ position: "fixed", inset: 0, background: "rgba(26,19,8,.52)", zIndex: 950, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div style={{ background: C.surface, borderRadius: 13, width: "100%", maxWidth: 440, boxShadow: "0 20px 60px rgba(0,0,0,.3)", overflow: "hidden" }}>
            <div style={{ padding: "14px 18px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 18, fontWeight: 600 }}>Edit Listing</div>
              <button onClick={() => setEditMeta(null)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 22, color: C.inkFaint }}>&times;</button>
            </div>
            <div style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .6, marginBottom: 5 }}>Stone Name</div>
                <Combobox value={editMeta.name} onChange={v => setEditMeta(p => ({ ...p, name: v }))} options={stones} placeholder="Stone name…"
                  onCreateNew={v => { createStone(v); setEditMeta(p => ({ ...p, name: v.trim() })); }} />
              </div>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .6, marginBottom: 5 }}>Shape / Category</div>
                <Combobox value={editMeta.category} onChange={v => setEditMeta(p => ({ ...p, category: v }))} options={shapes} placeholder="Shape…"
                  onCreateNew={async v => { await createShape(v); setEditMeta(p => ({ ...p, category: v.trim() })); }} />
              </div>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .6, marginBottom: 5 }}>Notes</div>
                <input value={editMeta.notes} onChange={e => setEditMeta(p => ({ ...p, notes: e.target.value }))} placeholder="Size, grade, origin…" style={FI} />
                <div style={{ fontSize: 10, color: C.inkFaint, marginTop: 4 }}>Applied to all photos in this listing</div>
              </div>
            </div>
            <div style={{ padding: "12px 18px", borderTop: `1px solid ${C.border}`, display: "flex", gap: 8 }}>
              <button onClick={() => setEditMeta(null)}
                style={{ flex: 1, background: "none", border: `1px solid ${C.border}`, borderRadius: 7, padding: 10, cursor: "pointer", fontSize: 13, color: C.inkMid }}>Cancel</button>
              <button onClick={saveEditMeta}
                style={{ flex: 2, background: C.ink, border: "none", borderRadius: 7, padding: 10, cursor: "pointer", fontSize: 13, fontWeight: 600, color: "#FAF0DC" }}>Save</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Add photos/videos modal ── */}
      {addOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(26,19,8,.52)", zIndex: 900, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div style={{ background: C.surface, borderRadius: 13, width: "100%", maxWidth: 500, maxHeight: "90vh", display: "flex", flexDirection: "column", boxShadow: "0 20px 60px rgba(0,0,0,.3)", overflow: "hidden" }}>

            <div style={{ padding: "14px 18px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
              <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 18, fontWeight: 600 }}>
                {addToExisting ? `Add Files — ${addToExisting.name}` : "New Listing"}
                {items.length > 0 && <span style={{ fontSize: 13, color: C.inkFaint, fontFamily: "system-ui" }}> · {items.length} selected</span>}
              </div>
              <button onClick={() => setAddOpen(false)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 22, color: C.inkFaint }}>&times;</button>
            </div>

            <div style={{ flex: 1, overflowY: "auto", padding: "16px 18px", display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .6, marginBottom: 7 }}>Photos &amp; Videos</div>
                <div
                  onClick={() => fileRef.current?.click()}
                  onDragOver={e => { e.preventDefault(); e.stopPropagation(); setDropActive(true); }}
                  onDragEnter={e => { e.preventDefault(); e.stopPropagation(); setDropActive(true); }}
                  onDragLeave={e => { e.preventDefault(); e.stopPropagation(); setDropActive(false); }}
                  onDrop={e => {
                    e.preventDefault(); e.stopPropagation();
                    setDropActive(false); setPageDropTarget(null);
                    processFiles(e.dataTransfer.files);
                  }}
                  style={{
                    border: `2px dashed ${dropActive ? C.gold : items.length ? C.gold : C.border}`,
                    borderRadius: 9, padding: "22px 12px", textAlign: "center", cursor: "pointer",
                    background: dropActive ? C.amberBg : C.card,
                    transition: "border-color .15s, background .15s",
                  }}>
                  <input ref={fileRef} type="file" accept="image/*,.webp,video/*" multiple style={{ display: "none" }} onChange={e => processFiles(e.target.files)} />
                  <div style={{ fontSize: 28, marginBottom: 6 }}>{dropActive ? "📂" : "🖼️"}</div>
                  <div style={{ fontSize: 13, fontWeight: 500, color: C.ink }}>
                    {dropActive ? "Drop to add" : "Drop files here or tap to choose"}
                  </div>
                  <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 3 }}>JPG · PNG · WebP · MP4 · MOV · multiple allowed</div>
                </div>
                {items.length > 0 && (
                  <button onClick={() => fileRef.current?.click()}
                    style={{ marginTop: 6, background: "none", border: `1px solid ${C.border}`, borderRadius: 6, padding: "5px 12px", fontSize: 11, cursor: "pointer", color: C.inkMid }}>
                    + Add more
                  </button>
                )}
              </div>

              {items.length > 0 && (
                <div>
                  {items.some(x => x.error) && (
                    <div style={{ marginBottom: 8, padding: "8px 12px", background: C.redBg, border: `1px solid ${C.red}`, borderRadius: 7, fontSize: 12, color: C.red, fontWeight: 500 }}>
                      {items.filter(x => x.error).length} upload{items.filter(x => x.error).length > 1 ? "s" : ""} failed —{" "}
                      {[...new Set(items.filter(x => x.error).map(x => x.error))].join("; ")}
                    </div>
                  )}
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {items.map(item => (
                      <div key={item.id} style={{ position: "relative", width: 64, height: 64, borderRadius: 8, overflow: "hidden", background: C.card, border: `1.5px solid ${item.error ? C.red : item.done ? C.green : C.border}` }}>
                        {item.isVideo ? (
                          <video src={item.preview} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} muted playsInline preload="metadata" />
                        ) : (
                          item.preview && <img src={item.preview} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                        )}
                        {item.isVideo && !item.uploading && !item.done && !item.error && (
                          <div style={{ position: "absolute", bottom: 3, left: 3, background: "rgba(0,0,0,.55)", color: "#fff", fontSize: 9, borderRadius: 3, padding: "1px 4px", lineHeight: 1.5 }}>▶ video</div>
                        )}
                        {item.uploading && <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,.55)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>⏳</div>}
                        {item.done && <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,.35)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, color: C.green }}>✓</div>}
                        {item.error && (
                          <div style={{ position: "absolute", inset: 0, background: "rgba(180,0,0,.7)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>⚠️
                            <button onClick={() => removeItem(item.id)} style={{ position: "absolute", top: 2, right: 2, background: "rgba(0,0,0,.55)", border: "none", color: "#fff", borderRadius: "50%", width: 18, height: 18, cursor: "pointer", fontSize: 12, lineHeight: "18px", textAlign: "center", padding: 0 }}>×</button>
                          </div>
                        )}
                        {!item.uploading && !item.done && !item.error && (
                          <button onClick={() => removeItem(item.id)} style={{ position: "absolute", top: 2, right: 2, background: "rgba(0,0,0,.55)", border: "none", color: "#fff", borderRadius: "50%", width: 18, height: 18, cursor: "pointer", fontSize: 12, lineHeight: "18px", textAlign: "center", padding: 0 }}>×</button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {!addToExisting && (
                <>
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .6, marginBottom: 5 }}>Stone Name</div>
                    <Combobox value={sharedStone} onChange={setSharedStone} options={stones} placeholder="e.g. Aquamarine, Rose Quartz…" onCreateNew={createStone} />
                  </div>
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .6, marginBottom: 5 }}>Shape / Category</div>
                    <Combobox value={sharedCat} onChange={setSharedCat} options={shapes} placeholder="e.g. Sphere, Tower, Palmstone…" onCreateNew={createShape} />
                  </div>
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .6, marginBottom: 5 }}>Notes (optional)</div>
                    <input value={sharedNotes} onChange={e => setSharedNotes(e.target.value)} placeholder="Size, grade…" style={FI} />
                  </div>
                </>
              )}
            </div>

            <div style={{ padding: "12px 18px", borderTop: `1px solid ${C.border}`, display: "flex", gap: 8, flexShrink: 0 }}>
              <button onClick={() => setAddOpen(false)}
                style={{ flex: 1, background: "none", border: `1px solid ${C.border}`, borderRadius: 7, padding: 10, cursor: "pointer", fontSize: 13, color: C.inkMid }}>
                Cancel
              </button>
              <button onClick={doUpload} disabled={!items.length || (!addToExisting && (!sharedCat || !sharedStone)) || uploading}
                style={{ flex: 2, background: items.length && (addToExisting || (sharedCat && sharedStone)) && !uploading ? C.ink : "#ccc", border: "none", borderRadius: 7, padding: 10, cursor: "pointer", fontSize: 13, fontWeight: 600, color: "#FAF0DC" }}>
                {uploading ? "Uploading…" : items.some(x => x.error) ? `↺ Retry ${items.filter(x => x.error).length} Failed` : `Save ${items.length > 1 ? `${items.length} Files` : "File"}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Header ── */}
      <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}`, padding: mob ? "0 12px" : "0 24px", display: "flex", alignItems: "center", height: 54, position: "sticky", top: 0, zIndex: 100, gap: 10 }}>
        {listingView ? (
          <button onClick={() => setListingView(null)}
            style={{ background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, padding: "0 12px 0 0", borderRight: `1px solid ${C.border}`, flexShrink: 0, color: C.ink, fontSize: 13, fontWeight: 500 }}>
            ← {mob ? "" : "All Listings"}
          </button>
        ) : (
          <button onClick={onHome}
            style={{ background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 7, padding: "0 12px 0 0", borderRight: `1px solid ${C.border}`, flexShrink: 0 }}>
            <span style={{ fontSize: 20 }}>🖼️</span>
            {!mob && (
              <div>
                <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 15, fontWeight: 600, color: C.ink, lineHeight: 1.1 }}>Image Library</div>
                <div style={{ fontSize: 8, color: C.inkFaint, letterSpacing: 1.2, fontWeight: 500 }}>NIKHIL GEMS</div>
              </div>
            )}
          </button>
        )}

        {listingView ? (
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{listingView.name}</div>
            <div style={{ fontSize: 11, color: C.inkFaint }}>{listingView.category} · {listingImgs.length} file{listingImgs.length !== 1 ? "s" : ""}</div>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 8, flex: 1, alignItems: "center" }}>
            {/* Mobile filter toggle */}
            {mob && (
              <button onClick={() => setSidebarOpen(o => !o)}
                style={{ background: sidebarOpen ? C.ink : "none", color: sidebarOpen ? "#FAF0DC" : C.ink, border: `1px solid ${C.border}`, borderRadius: 7, padding: "6px 10px", fontSize: 12, cursor: "pointer", position: "relative", flexShrink: 0 }}>
                ⚙ Filters{activeFilterCount > 0 && <span style={{ marginLeft: 5, background: C.gold, color: "#fff", borderRadius: 10, padding: "0 5px", fontSize: 10, fontWeight: 700 }}>{activeFilterCount}</span>}
              </button>
            )}
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search listings…"
              style={{ ...FI, fontSize: 12, padding: "6px 10px", flex: 1 }} />
          </div>
        )}

        <div style={{ display: "flex", gap: 6, flexShrink: 0, alignItems: "center" }}>
          {listingView && (
            <button onClick={() => setEditMeta({ origName: listingView.name, origCat: listingView.category, name: listingView.name, category: listingView.category, notes: listingImgs[0]?.notes || "" })}
              style={{ background: "none", border: `1px solid ${C.border}`, color: C.ink, borderRadius: 7, padding: mob ? "7px 10px" : "7px 14px", fontSize: 13, cursor: "pointer" }}>
              Edit Info
            </button>
          )}
          {listingView && (() => {
            const alreadyPushed = images.some(img => img.name === listingView.name && img.category === listingView.category && img.shopifyProductId);
            return (
              <button onClick={openShopifyPush} disabled={shopifyPushing}
                style={{ background: alreadyPushed ? "#E3F2FD" : "#008060", color: alreadyPushed ? "#1565C0" : "#fff", border: alreadyPushed ? "1px solid #B8D0F0" : "none", borderRadius: 7, padding: mob ? "7px 10px" : "7px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer", opacity: shopifyPushing ? 0.5 : 1, whiteSpace: "nowrap" }}>
                {shopifyPushing ? "Pushing…" : alreadyPushed ? "🛍 Update Shopify" : "🛍 Push to Shopify"}
              </button>
            );
          })()}
          {!listingView && !selectMode && (
            <button onClick={() => setSelectMode(true)}
              style={{ background: "none", border: `1px solid ${C.border}`, color: C.inkMid, borderRadius: 7, padding: mob ? "7px 10px" : "7px 14px", fontSize: 13, cursor: "pointer" }}>
              Select
            </button>
          )}
          {!listingView && selectMode && (
            <button onClick={exitSelectMode}
              style={{ background: "none", border: `1px solid ${C.border}`, color: C.inkMid, borderRadius: 7, padding: mob ? "7px 10px" : "7px 14px", fontSize: 13, cursor: "pointer" }}>
              Cancel
            </button>
          )}
          <button onClick={() => openAdd(listingView ? listingView : null)}
            style={{ background: C.ink, color: "#FAF0DC", border: "none", borderRadius: 7, padding: mob ? "7px 12px" : "7px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
            + {listingView ? "Add Files" : "New Listing"}
          </button>
        </div>
      </div>

      {/* ── Body ── */}
      <div style={{ display: "flex", minHeight: "calc(100vh - 54px)" }}>

        {/* ── Left sidebar (filters) — hidden when in listing detail or on mobile+closed ── */}
        {!listingView && (!mob || sidebarOpen) && (
          <div style={{
            width: mob ? "100%" : 220, flexShrink: 0,
            background: C.surface, borderRight: `1px solid ${C.border}`,
            padding: "18px 0",
            position: mob ? "fixed" : "sticky",
            top: mob ? 54 : 54, left: 0, zIndex: mob ? 80 : "auto",
            height: mob ? "calc(100vh - 54px)" : "calc(100vh - 54px)",
            overflowY: "auto",
            boxShadow: mob ? "4px 0 20px rgba(0,0,0,.15)" : "none",
          }}>
            {/* Header */}
            <div style={{ padding: "0 16px 12px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: `1px solid ${C.border}`, marginBottom: 4 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: 1 }}>Filters</div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {activeFilterCount > 0 && (
                  <button onClick={clearFilters} style={{ fontSize: 10, color: C.gold, fontWeight: 700, background: "none", border: "none", cursor: "pointer", padding: 0 }}>Clear all</button>
                )}
                {mob && <button onClick={() => setSidebarOpen(false)} style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: C.inkFaint, lineHeight: 1 }}>&times;</button>}
              </div>
            </div>

            {/* Stone Name */}
            <div style={{ padding: "10px 16px 4px" }}>
              <button onClick={() => setCollapsed(c => ({ ...c, stone: !c.stone }))}
                style={{ width: "100%", background: "none", border: "none", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", padding: 0, marginBottom: 8 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .8, display: "flex", alignItems: "center", gap: 5 }}>
                  Stone Name
                  {filterStones.size > 0 && <span style={{ background: C.gold, color: "#fff", borderRadius: 8, padding: "1px 5px", fontSize: 9, fontWeight: 700 }}>{filterStones.size}</span>}
                </div>
                <span style={{ fontSize: 9, color: C.inkFaint }}>{collapsed.stone ? "▶" : "▼"}</span>
              </button>
              {!collapsed.stone && (
                <div style={{ display: "flex", flexDirection: "column", gap: 1, maxHeight: 220, overflowY: "auto" }}>
                  {uniqueStones.map(s => {
                    const count = listings.filter(l => l.name === s).length;
                    const checked = filterStones.has(s);
                    return (
                      <label key={s} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 4px", borderRadius: 6, cursor: "pointer", background: checked ? C.amberBg : "transparent", transition: "background .1s" }}>
                        <input type="checkbox" checked={checked} onChange={() => toggleSet(setFilterStones, s)}
                          style={{ accentColor: C.gold, width: 13, height: 13, flexShrink: 0, cursor: "pointer" }} />
                        <span style={{ fontSize: 12, color: checked ? C.ink : C.inkMid, fontWeight: checked ? 600 : 400, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s}</span>
                        <span style={{ fontSize: 10, color: C.inkFaint, flexShrink: 0 }}>{count}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            <div style={{ height: 1, background: C.border, margin: "10px 16px" }} />

            {/* Shape / Category */}
            <div style={{ padding: "4px 16px 4px" }}>
              <button onClick={() => setCollapsed(c => ({ ...c, shape: !c.shape }))}
                style={{ width: "100%", background: "none", border: "none", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", padding: 0, marginBottom: 8 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .8, display: "flex", alignItems: "center", gap: 5 }}>
                  Shape / Category
                  {filterCats.size > 0 && <span style={{ background: C.gold, color: "#fff", borderRadius: 8, padding: "1px 5px", fontSize: 9, fontWeight: 700 }}>{filterCats.size}</span>}
                </div>
                <span style={{ fontSize: 9, color: C.inkFaint }}>{collapsed.shape ? "▶" : "▼"}</span>
              </button>
              {!collapsed.shape && (
                <div style={{ display: "flex", flexDirection: "column", gap: 1, maxHeight: 220, overflowY: "auto" }}>
                  {uniqueCats.map(c => {
                    const count = listings.filter(l => l.category === c).length;
                    const checked = filterCats.has(c);
                    return (
                      <label key={c} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 4px", borderRadius: 6, cursor: "pointer", background: checked ? C.amberBg : "transparent", transition: "background .1s" }}>
                        <input type="checkbox" checked={checked} onChange={() => toggleSet(setFilterCats, c)}
                          style={{ accentColor: C.gold, width: 13, height: 13, flexShrink: 0, cursor: "pointer" }} />
                        <span style={{ fontSize: 12, color: checked ? C.ink : C.inkMid, fontWeight: checked ? 600 : 400, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c}</span>
                        <span style={{ fontSize: 10, color: C.inkFaint, flexShrink: 0 }}>{count}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            <div style={{ height: 1, background: C.border, margin: "10px 16px" }} />

            {/* Listed On */}
            <div style={{ padding: "4px 16px 4px" }}>
              <button onClick={() => setCollapsed(c => ({ ...c, platform: !c.platform }))}
                style={{ width: "100%", background: "none", border: "none", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", padding: 0, marginBottom: 8 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .8, display: "flex", alignItems: "center", gap: 5 }}>
                  Listed On
                  {filterPlatforms.size > 0 && <span style={{ background: C.gold, color: "#fff", borderRadius: 8, padding: "1px 5px", fontSize: 9, fontWeight: 700 }}>{filterPlatforms.size}</span>}
                </div>
                <span style={{ fontSize: 9, color: C.inkFaint }}>{collapsed.platform ? "▶" : "▼"}</span>
              </button>
              {!collapsed.platform && (
                <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                  {MARKETS.map(m => {
                    const count = listings.filter(l => (l.imgs[0]?.usedOn || []).includes(m.id)).length;
                    const checked = filterPlatforms.has(m.id);
                    return (
                      <label key={m.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 4px", borderRadius: 6, cursor: "pointer", background: checked ? C.amberBg : "transparent", transition: "background .1s" }}>
                        <input type="checkbox" checked={checked} onChange={() => toggleSet(setFilterPlatforms, m.id)}
                          style={{ accentColor: C.gold, width: 13, height: 13, flexShrink: 0, cursor: "pointer" }} />
                        <span style={{ fontSize: 12, color: checked ? C.ink : C.inkMid, fontWeight: checked ? 600 : 400, flex: 1 }}>{m.label}</span>
                        <span style={{ fontSize: 10, color: C.inkFaint, flexShrink: 0 }}>{count}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Mobile sidebar backdrop */}
        {mob && sidebarOpen && !listingView && (
          <div onClick={() => setSidebarOpen(false)}
            style={{ position: "fixed", inset: 0, top: 54, background: "rgba(0,0,0,.35)", zIndex: 79 }} />
        )}

        {/* ── Main content ── */}
        <div style={{ flex: 1, minWidth: 0, padding: mob ? "14px 12px" : "22px 28px", maxWidth: listingView ? 960 : "none" }}>

        {/* ── Listing detail view ── */}
        {listingView ? (
          <div>
            {/* notes bar */}
            {listingImgs[0]?.notes && (
              <div style={{ fontSize: 12, color: C.inkMid, marginBottom: 16, padding: "8px 12px", background: C.card, borderRadius: 8, border: `1px solid ${C.border}` }}>
                {listingImgs[0].notes}
              </div>
            )}

            {/* market usage */}
            <div style={{ display: "flex", gap: 6, marginBottom: 18, flexWrap: "wrap", alignItems: "center" }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .6 }}>Listed on:</span>
              {MARKETS.map(m => {
                const usedOn = listingImgs[0]?.usedOn || [];
                const active = usedOn.includes(m.id);
                return (
                  <button key={m.id}
                    onClick={e => toggleMarket(listingView.name, listingView.category, m.id, e)}
                    style={{
                      fontSize: 11, fontWeight: 600, padding: "4px 10px", borderRadius: 6, lineHeight: 1.4,
                      border: `1px solid ${active ? C.green : C.border}`,
                      background: active ? C.greenBg : "transparent",
                      color: active ? C.green : C.inkMid,
                      cursor: "pointer",
                    }}>
                    {active ? "✓ " : ""}{m.label}
                  </button>
                );
              })}
            </div>

            {/* photo/video grid */}
            <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr 1fr" : "repeat(auto-fill, minmax(200px, 1fr))", gap: 14 }}>
              {listingImgs.map((img, i) => (
                <div key={img.id}
                  draggable
                  onDragStart={e => { dragId.current = img.id; e.dataTransfer.effectAllowed = "move"; }}
                  onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDragOver(img.id); }}
                  onDragLeave={() => setDragOver(null)}
                  onDrop={e => { e.preventDefault(); setDragOver(null); if (dragId.current) reorderInListing(dragId.current, img.id); dragId.current = null; }}
                  onDragEnd={() => { dragId.current = null; setDragOver(null); }}
                  style={{
                    background: C.surface,
                    border: `2px solid ${dragOver === img.id ? C.gold : i === 0 ? C.gold : C.border}`,
                    borderRadius: 12, overflow: "hidden", position: "relative",
                    opacity: dragId.current === img.id ? 0.45 : 1,
                    transition: "border-color .15s, opacity .15s",
                    cursor: "grab",
                  }}>
                  {/* cover badge */}
                  {i === 0 && (
                    <div style={{ position: "absolute", top: 8, left: 8, background: C.gold, color: "#fff", fontSize: 9, fontWeight: 700, borderRadius: 4, padding: "2px 7px", letterSpacing: .5, zIndex: 2 }}>COVER</div>
                  )}
                  {/* video badge */}
                  {isVideoEntry(img) && (
                    <div style={{ position: "absolute", top: 8, right: 32, background: "rgba(0,0,0,.6)", color: "#fff", fontSize: 9, fontWeight: 700, borderRadius: 4, padding: "2px 6px", zIndex: 2 }}>▶ VIDEO</div>
                  )}
                  {/* drag hint */}
                  <div style={{ position: "absolute", top: 8, right: 8, background: "rgba(0,0,0,.38)", color: "#fff", fontSize: 11, borderRadius: 4, padding: "2px 6px", zIndex: 2, lineHeight: 1.4, pointerEvents: "none" }}>⠿</div>
                  {/* drop indicator */}
                  {dragOver === img.id && (
                    <div style={{ position: "absolute", inset: 0, border: `3px solid ${C.gold}`, borderRadius: 10, zIndex: 3, pointerEvents: "none", background: C.gold + "18" }} />
                  )}

                  {/* media */}
                  <div onClick={() => setLightbox(img)} style={{ height: mob ? 160 : 200, background: C.card, overflow: "hidden", cursor: "zoom-in" }}>
                    <MediaThumb
                      src={img.imageUrl}
                      isVideo={isVideoEntry(img)}
                      alt={img.name}
                      style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                      onError={e => { e.target.style.display = "none"; }}
                    />
                  </div>

                  {/* controls */}
                  <div style={{ padding: "8px 10px", display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 10, color: C.inkFaint, flex: 1 }}>
                      {i + 1} / {listingImgs.length}{img.size ? ` · ${fmtSize(img.size)}` : ""}
                    </span>
                    {i !== 0 && (
                      <button onClick={() => setAsCover(img.id, listingImgs)} title="Set as cover"
                        style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 5, padding: "3px 8px", fontSize: 11, cursor: "pointer", color: C.gold }}>★ Cover</button>
                    )}
                    <button onClick={() => deleteImg(img.id)} title="Delete"
                      style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 5, padding: "3px 8px", fontSize: 12, cursor: "pointer", color: C.red }}>🗑</button>
                  </div>
                </div>
              ))}

              {/* add more tile */}
              <div onClick={() => openAdd(listingView)}
                style={{ background: C.card, border: `2px dashed ${C.border}`, borderRadius: 12, minHeight: 200, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", cursor: "pointer", gap: 8, color: C.inkFaint }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = C.gold; e.currentTarget.style.color = C.gold; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.color = C.inkFaint; }}>
                <div style={{ fontSize: 28 }}>+</div>
                <div style={{ fontSize: 12, fontWeight: 500 }}>Add Files</div>
              </div>
            </div>
          </div>
        ) : (
          /* ── Gallery view — one card per listing ── */
          <>
            {/* Select-all bar */}
            {selectMode && filteredListings.length > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, padding: "8px 12px", background: C.card, borderRadius: 9, border: `1px solid ${C.border}` }}>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", flex: 1 }}>
                  <input type="checkbox"
                    checked={filteredListings.length > 0 && filteredListings.every(l => selectedKeys.has(l.key))}
                    onChange={e => {
                      if (e.target.checked) setSelectedKeys(prev => { const s = new Set(prev); filteredListings.forEach(l => s.add(l.key)); return s; });
                      else setSelectedKeys(prev => { const s = new Set(prev); filteredListings.forEach(l => s.delete(l.key)); return s; });
                    }}
                    style={{ accentColor: C.gold, width: 14, height: 14, cursor: "pointer" }} />
                  <span style={{ fontSize: 13, color: C.ink, fontWeight: 500 }}>
                    {selectedKeys.size > 0 ? `${selectedKeys.size} selected` : "Select all"}
                  </span>
                </label>
                {selectedKeys.size > 0 && (
                  <span style={{ fontSize: 11, color: C.inkFaint }}>{selectedKeys.size} of {filteredListings.length}</span>
                )}
              </div>
            )}

            {images.length > 0 && !selectMode && (
              <div style={{ fontSize: 11, color: C.inkFaint, marginBottom: 14 }}>
                {filteredListings.length !== listings.length ? `${filteredListings.length} of ${listings.length}` : listings.length} listing{listings.length !== 1 ? "s" : ""}
                {` · ${images.length} file${images.length !== 1 ? "s" : ""}`}
                {totalBytes > 0 ? ` · ~${fmtSize(totalBytes)}` : ""}
                {" · Vercel Blob"}
              </div>
            )}

            {!loaded && <div style={{ textAlign: "center", padding: "60px 0", color: C.inkFaint, fontSize: 13 }}>Loading…</div>}

            {loaded && filteredListings.length === 0 && (
              <div style={{ textAlign: "center", padding: "60px 20px" }}>
                <div style={{ fontSize: 48, marginBottom: 12 }}>🖼️</div>
                <div style={{ fontSize: 16, fontWeight: 600, color: C.ink, marginBottom: 6, fontFamily: "'Cormorant Garamond',Georgia,serif" }}>
                  {activeFilterCount > 0 || search ? "No listings match" : "No listings yet"}
                </div>
                <div style={{ fontSize: 13, color: C.inkFaint, marginBottom: 20 }}>
                  {activeFilterCount > 0 || search ? "Try clearing some filters" : "Create a listing to start uploading product photos and videos."}
                </div>
                {activeFilterCount > 0 && (
                  <button onClick={clearFilters}
                    style={{ background: C.gold, color: "#fff", border: "none", borderRadius: 8, padding: "9px 22px", fontSize: 13, fontWeight: 600, cursor: "pointer", marginRight: 8 }}>
                    Clear Filters
                  </button>
                )}
                {!search && activeFilterCount === 0 && (
                  <button onClick={() => openAdd(null)}
                    style={{ background: C.ink, color: "#FAF0DC", border: "none", borderRadius: 8, padding: "10px 24px", fontSize: 14, fontWeight: 600, cursor: "pointer" }}>
                    + Create First Listing
                  </button>
                )}
              </div>
            )}

            {loaded && filteredListings.length > 0 && (
              <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr 1fr" : "repeat(auto-fill, minmax(200px, 1fr))", gap: 14 }}>
                {filteredListings.map(listing => (
                  <div key={listing.key}
                    onClick={() => selectMode ? toggleSelect(listing.key) : setListingView({ name: listing.name, category: listing.category })}
                    style={{
                      background: C.surface,
                      border: `1.5px solid ${
                        selectedKeys.has(listing.key) ? C.gold :
                        pageDropTarget && typeof pageDropTarget === "object" && pageDropTarget.name === listing.name && pageDropTarget.category === listing.category ? C.gold :
                        C.border}`,
                      borderRadius: 12, overflow: "hidden", cursor: "pointer", position: "relative",
                      boxShadow: selectedKeys.has(listing.key) ? `0 0 0 3px ${C.gold}55` :
                        pageDropTarget && typeof pageDropTarget === "object" && pageDropTarget.name === listing.name && pageDropTarget.category === listing.category ? `0 0 0 3px ${C.gold}55` : "none",
                      transition: "all .15s",
                      outline: "none",
                    }}
                    onMouseEnter={e => { if (!selectMode && !(pageDropTarget && typeof pageDropTarget === "object")) { e.currentTarget.style.boxShadow = "0 6px 20px rgba(0,0,0,.13)"; e.currentTarget.style.transform = "translateY(-1px)"; } }}
                    onMouseLeave={e => { if (!selectMode && !(pageDropTarget && typeof pageDropTarget === "object")) { e.currentTarget.style.boxShadow = selectedKeys.has(listing.key) ? `0 0 0 3px ${C.gold}55` : "none"; e.currentTarget.style.transform = "none"; } }}
                    onDragOver={e => {
                      if (!isFileDrag(e)) return;
                      e.preventDefault(); e.stopPropagation();
                      setPageDropTarget({ name: listing.name, category: listing.category });
                    }}
                    onDragLeave={e => {
                      if (!isFileDrag(e)) return;
                      if (!e.currentTarget.contains(e.relatedTarget))
                        setPageDropTarget("new");
                    }}
                    onDrop={e => {
                      if (!isFileDrag(e)) return;
                      e.preventDefault(); e.stopPropagation();
                      setPageDropTarget(null);
                      openAdd({ name: listing.name, category: listing.category }, e.dataTransfer.files);
                    }}>

                    {/* Select mode checkbox */}
                    {selectMode && (
                      <div style={{ position: "absolute", top: 8, left: 8, zIndex: 5, pointerEvents: "none" }}>
                        <div style={{
                          width: 22, height: 22, borderRadius: 6,
                          background: selectedKeys.has(listing.key) ? C.gold : "rgba(255,255,255,.85)",
                          border: `2px solid ${selectedKeys.has(listing.key) ? C.gold : "rgba(0,0,0,.25)"}`,
                          display: "flex", alignItems: "center", justifyContent: "center",
                          boxShadow: "0 1px 4px rgba(0,0,0,.2)",
                        }}>
                          {selectedKeys.has(listing.key) && <span style={{ color: "#fff", fontSize: 13, fontWeight: 700, lineHeight: 1 }}>✓</span>}
                        </div>
                      </div>
                    )}
                    {/* Selected overlay tint */}
                    {selectMode && selectedKeys.has(listing.key) && (
                      <div style={{ position: "absolute", inset: 0, background: `${C.gold}18`, zIndex: 4, pointerEvents: "none", borderRadius: 10 }} />
                    )}

                    {/* cover photo/video */}
                    <div style={{ position: "relative" }}>
                      <div style={{ height: mob ? 150 : 190, background: C.card, overflow: "hidden" }}>
                        <MediaThumb
                          src={listing.cover.imageUrl}
                          isVideo={isVideoEntry(listing.cover)}
                          alt={listing.name}
                          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                          onError={e => { e.target.style.display = "none"; }}
                        />
                      </div>
                      {/* video badge on cover */}
                      {isVideoEntry(listing.cover) && (
                        <div style={{ position: "absolute", top: 8, left: 8, background: "rgba(0,0,0,.6)", color: "#fff", fontSize: 9, fontWeight: 700, borderRadius: 4, padding: "2px 6px" }}>▶ VIDEO</div>
                      )}
                      {/* photo count badge */}
                      {listing.imgs.length > 1 && (
                        <div style={{ position: "absolute", bottom: 8, right: 8, background: "rgba(0,0,0,.65)", color: "#fff", fontSize: 10, fontWeight: 600, borderRadius: 5, padding: "2px 8px" }}>
                          +{listing.imgs.length - 1} more
                        </div>
                      )}
                      {/* thumbnail strip if >1 photo */}
                      {listing.imgs.length > 1 && (
                        <div style={{ position: "absolute", bottom: 8, left: 8, display: "flex", gap: 4 }}>
                          {listing.imgs.slice(1, 4).map(img => (
                            <div key={img.id} style={{ width: 26, height: 26, borderRadius: 4, overflow: "hidden", border: "1.5px solid rgba(255,255,255,.7)" }}>
                              <MediaThumb
                                src={img.imageUrl}
                                isVideo={isVideoEntry(img)}
                                alt=""
                                style={{ width: "100%", height: "100%", objectFit: "cover" }}
                                onError={e => { e.target.style.display = "none"; }}
                              />
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div style={{ padding: "10px 12px 12px" }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, lineHeight: 1.3, marginBottom: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{listing.name}</div>
                      <div style={{ fontSize: 11, color: C.inkFaint, display: "flex", justifyContent: "space-between" }}>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{listing.category}</span>
                        <span style={{ flexShrink: 0, marginLeft: 6 }}>{listing.imgs.length} file{listing.imgs.length !== 1 ? "s" : ""}</span>
                      </div>
                      {listing.imgs[0]?.notes && (
                        <div style={{ fontSize: 10, color: C.inkFaint, marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{listing.imgs[0].notes}</div>
                      )}
                      <div style={{ display: "flex", gap: 3, marginTop: 6, flexWrap: "wrap" }}>
                        {MARKETS.map(m => {
                          const active = listing.usedOn.includes(m.id);
                          return (
                            <button key={m.id}
                              onClick={e => toggleMarket(listing.name, listing.category, m.id, e)}
                              style={{
                                fontSize: 9, fontWeight: 600, padding: "2px 5px", borderRadius: 4, lineHeight: 1.5,
                                border: `1px solid ${active ? C.green : C.border}`,
                                background: active ? C.greenBg : "transparent",
                                color: active ? C.green : C.inkFaint,
                                cursor: "pointer",
                              }}>
                              {active ? "✓ " : ""}{m.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
        </div>{/* end main content */}
      </div>{/* end body flex row */}

      {/* ── Bulk action bar ── */}
      {selectMode && selectedKeys.size > 0 && (
        <div style={{
          position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)",
          background: C.ink, color: "#FAF0DC", borderRadius: 14,
          padding: "12px 18px", display: "flex", alignItems: "center", gap: 10,
          boxShadow: "0 8px 32px rgba(0,0,0,.35)", zIndex: 500,
          flexWrap: "wrap", justifyContent: "center", maxWidth: "calc(100vw - 32px)",
        }}>
          <span style={{ fontSize: 13, fontWeight: 600, marginRight: 4 }}>{selectedKeys.size} selected</span>
          <div style={{ width: 1, height: 20, background: "rgba(255,255,255,.25)" }} />
          <button onClick={openBulkMark}
            style={{ background: C.green, border: "none", color: "#fff", borderRadius: 8, padding: "7px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
            ✓ Mark Listed
          </button>
          <button onClick={() => setBulkMetaModal({ name: "", category: "", notes: "__unchanged__" })}
            style={{ background: "rgba(255,255,255,.15)", border: "1px solid rgba(255,255,255,.25)", color: "#FAF0DC", borderRadius: 8, padding: "7px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
            ✎ Edit Info
          </button>
          <button onClick={bulkDelete}
            style={{ background: C.red, border: "none", color: "#fff", borderRadius: 8, padding: "7px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
            🗑 Delete
          </button>
          <button onClick={exitSelectMode}
            style={{ background: "none", border: "1px solid rgba(255,255,255,.3)", color: "rgba(255,255,255,.7)", borderRadius: 8, padding: "7px 12px", fontSize: 12, cursor: "pointer" }}>
            ✕
          </button>
        </div>
      )}

      {/* ── Shopify credentials setup modal ── */}
      {shopifySetup && (
        <div onClick={e => { if (e.target === e.currentTarget) setShopifySetup(false); }}
          style={{ position: "fixed", inset: 0, background: "rgba(26,19,8,.55)", zIndex: 1100, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div style={{ background: C.surface, borderRadius: 13, width: "100%", maxWidth: 400, boxShadow: "0 20px 60px rgba(0,0,0,.3)", overflow: "hidden" }}>
            <div style={{ padding: "14px 18px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 18, fontWeight: 600 }}>🛍 Shopify Setup</div>
              <button onClick={() => setShopifySetup(false)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 22, color: C.inkFaint }}>&times;</button>
            </div>
            <div style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .6, marginBottom: 5 }}>Store Domain</div>
                <input value={shopifyStore} onChange={e => setShopifyStore(e.target.value)} placeholder="yourstore.myshopify.com" style={FI} />
              </div>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .6, marginBottom: 5 }}>Admin API Access Token</div>
                <input value={shopifyToken} onChange={e => setShopifyToken(e.target.value)} placeholder="shpat_…" style={FI} type="password" />
              </div>
            </div>
            <div style={{ padding: "12px 18px", borderTop: `1px solid ${C.border}`, display: "flex", gap: 8 }}>
              <button onClick={() => setShopifySetup(false)} style={{ flex: 1, background: "none", border: `1px solid ${C.border}`, borderRadius: 7, padding: 10, cursor: "pointer", fontSize: 13, color: C.inkMid }}>Cancel</button>
              <button onClick={saveShopifyCreds} style={{ flex: 2, background: "#008060", border: "none", borderRadius: 7, padding: 10, cursor: "pointer", fontSize: 13, fontWeight: 600, color: "#fff" }}>Save &amp; Push</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Shopify push confirmation modal ── */}
      {shopifyModal && (
        <div onClick={e => { if (e.target === e.currentTarget) setShopifyModal(null); }}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", zIndex: 1100, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div style={{ background: C.surface, borderRadius: 14, padding: "22px 20px", width: "min(420px,100%)", boxShadow: "0 8px 40px rgba(0,0,0,.3)" }}>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>🛍 {shopifyModal.shopifyProductId ? "Update on Shopify" : "Push to Shopify"}</div>
            <div style={{ fontSize: 11, color: C.inkFaint, marginBottom: 16 }}>
              {shopifyModal.shopifyProductId ? "Update the existing Shopify product with this listing's cover photo." : "Create a new Shopify product using this listing's cover photo."}
            </div>

            <div style={{ fontSize: 11, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .5, marginBottom: 4 }}>Product Name</div>
            <input value={shopifyModal.name} onChange={e => setShopifyModal(m => ({ ...m, name: e.target.value }))}
              style={{ ...FI, marginBottom: 12, fontSize: 14 }} />

            <div style={{ fontSize: 11, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .5, marginBottom: 4 }}>Price (USD)</div>
            <input type="number" value={shopifyModal.price} onChange={e => setShopifyModal(m => ({ ...m, price: e.target.value }))}
              style={{ ...FI, marginBottom: 18 }} placeholder="0.00" />

            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => {
                const { creds, name, price } = shopifyModal;
                setShopifyModal(null);
                doPushShopify(creds, name, price);
              }} style={{ flex: 1, background: "#008060", border: "none", color: "#fff", fontWeight: 700, fontSize: 13, padding: 11, borderRadius: 8, cursor: "pointer" }}>
                {shopifyModal.shopifyProductId ? "Update →" : "Push →"}
              </button>
              <button onClick={() => setShopifyModal(null)}
                style={{ background: "none", border: `1px solid ${C.border}`, fontSize: 13, padding: "11px 18px", borderRadius: 8, cursor: "pointer", color: C.inkFaint }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
