import { useState, useEffect, useRef, useCallback } from "react";
import { loadK, saveK, mob } from "./utils.js";
import { uploadToStorage } from "./storageUtils.js";
import atyaharaSeedBundle from "./exportReconAtyaharaSeed.json";

/* ══ ERP THEME TOKENS ═══════════════════════════════════════════
   Mirror src/theme.css CSS variables so this module inherits the
   shared light/dark palette (the global 🌙 toggle "just works").
   Matches the local-C pattern used by src/EtsyApp.jsx. */
const C = {
  bg:"var(--c-bg)", surface:"var(--c-surface)", card:"var(--c-card)",
  border:"var(--c-border)", borderHi:"var(--c-borderHi)",
  ink:"var(--c-ink)", inkMid:"var(--c-inkMid)", inkFaint:"var(--c-inkFaint)",
  gold:"var(--c-gold)", goldLight:"var(--c-goldLight)", goldBright:"var(--c-goldBright)",
  green:"var(--c-green)", greenBg:"var(--c-greenBg)", greenBright:"var(--c-greenBright)",
  red:"var(--c-red)", redBg:"var(--c-redBg)",
  amber:"var(--c-amber)", amberBg:"var(--c-amberBg)",
  blue:"var(--c-blue)", blueBg:"var(--c-blueBg)",
  purple:"var(--c-purple)", purpleBg:"var(--c-purpleBg)",
  teal:"var(--c-teal)", tealBg:"var(--c-tealBg)",
  fill:"var(--c-fill)",
};
const FONT = "-apple-system,'SF Pro Display','Figtree',system-ui,sans-serif";

/* ══ INDEXEDDB ══════════════════════════════════════════════════ */
const idb = {
  _db: null,
  ns: "atyahara",
  key(k) { return `${this.ns}:${k}`; },
  setNamespace(ns) { this.ns = ns || "atyahara"; },
  async open() {
    if (this._db) return this._db;
    return new Promise((res, rej) => {
      const req = indexedDB.open("export-recon-pdfs-v1", 1);
      req.onupgradeneeded = e => e.target.result.createObjectStore("pdfs");
      req.onsuccess = e => { this._db = e.target.result; res(this._db); };
      req.onerror = () => rej(req.error);
    });
  },
  async get(key) { const db = await this.open(); return new Promise((res,rej) => { const r=db.transaction("pdfs","readonly").objectStore("pdfs").get(this.key(key)); r.onsuccess=()=>res(r.result??null); r.onerror=()=>rej(r.error); }); },
  async set(key,val) { const db = await this.open(); return new Promise((res,rej) => { const r=db.transaction("pdfs","readwrite").objectStore("pdfs").put(val,this.key(key)); r.onsuccess=()=>res(true); r.onerror=()=>rej(r.error); }); },
  async del(key) { const db = await this.open(); return new Promise((res,rej) => { const r=db.transaction("pdfs","readwrite").objectStore("pdfs").delete(this.key(key)); r.onsuccess=()=>res(true); r.onerror=()=>rej(r.error); }); },
  async keys() {
    const db = await this.open();
    return new Promise((res,rej) => {
      const r=db.transaction("pdfs","readonly").objectStore("pdfs").getAllKeys();
      r.onsuccess=()=>res((r.result||[]).filter(k=>String(k).startsWith(`${this.ns}:`)).map(k=>String(k).slice(this.ns.length+1)));
      r.onerror=()=>rej(r.error);
    });
  },
};

/* ══ METADATA ═══════════════════════════════════════════════════ */
const META_KEY      = "er-meta-v5";
const INSIGHTS_KEY  = "er-insights-v1";
const emptyManualFirc = () => ({
  number:"", date:"", amount:"",
  foreignAmount:"", currency:"USD", exchangeRate:"",
  bankName:"", bankAccount:"", remitterName:"", buyerName:"",
  purposeCode:"P0102", transactionRef:"", charges:"",
  evidenceType:"Bank reference", thirdParty:false, notes:"",
});
let activeReconCompany = "atyahara";
const scopedKey = key => `${key}:${activeReconCompany}`;
const emptyMeta = () => ({ fircs: [], shippingBills: [], invoices: [] });
const normalizeMeta = raw => {
  const meta = raw?.meta && typeof raw.meta === "object" ? raw.meta : raw;
  return {
    fircs: Array.isArray(meta?.fircs) ? meta.fircs : [],
    shippingBills: Array.isArray(meta?.shippingBills) ? meta.shippingBills : [],
    invoices: Array.isArray(meta?.invoices) ? meta.invoices : [],
  };
};
const seededMeta = () => {
  if (activeReconCompany !== "atyahara") return emptyMeta();
  return normalizeMeta(atyaharaSeedBundle);
};
const insightsStore = {
  async load() {
    try { const saved = await loadK(scopedKey(INSIGHTS_KEY)); if (saved) return saved; } catch {}
    try { if (window.storage) { const r=await window.storage.get(scopedKey(INSIGHTS_KEY)); if (r?.value) return JSON.parse(r.value); } } catch {}
    try { const raw=localStorage.getItem(scopedKey(INSIGHTS_KEY)); if (raw) return JSON.parse(raw); } catch {}
    return { reviewed: {}, lastRun: null, concerns: [] };
  },
  async save(d) {
    const s=JSON.stringify(d);
    try { await saveK(scopedKey(INSIGHTS_KEY), d); } catch {}
    try { if (window.storage) await window.storage.set(scopedKey(INSIGHTS_KEY),s); } catch {}
    try { localStorage.setItem(scopedKey(INSIGHTS_KEY),s); } catch {}
  },
};
const metaStore = {
  async load() {
    try { const saved = await loadK(scopedKey(META_KEY)); if (saved) return normalizeMeta(saved); } catch {}
    try { if (window.storage) { const r = await window.storage.get(scopedKey(META_KEY)); if (r?.value) return normalizeMeta(JSON.parse(r.value)); } } catch {}
    try { const raw = localStorage.getItem(scopedKey(META_KEY)); if (raw) return normalizeMeta(JSON.parse(raw)); } catch {}
    return seededMeta();
  },
  async save(d) {
    d = normalizeMeta(d);
    const s = JSON.stringify(d);
    try { await saveK(scopedKey(META_KEY), d); } catch {}
    try { if (window.storage) await window.storage.set(scopedKey(META_KEY), s); } catch {}
    try { localStorage.setItem(scopedKey(META_KEY), s); } catch {}
  },
};

/* ══ UTILS ══════════════════════════════════════════════════════ */
const fc  = n => new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:0}).format(n||0);
const fd  = s => { if (!s) return "—"; try { return new Date(s).toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"}); } catch { return s; } };
const uid = () => Date.now().toString(36)+Math.random().toString(36).slice(2,6);
const sbNumFromFilename = name => { const seg=name.replace(/\.pdf$/i,"").split("_").pop()||name; const d=seg.replace(/\D/g,""); return d||seg; };
// Normalize SB numbers for dedup: strip all underscores, hyphens, spaces, lowercase
// CSBV_DEL_2025-2026_0504_21496 === CSBV_DEL_2025-2026_05_04_21496 → "csbvdel2025202605042149 6" → same
const normSbNum = s => (s||"").toLowerCase().replace(/[\s_\-]/g,"");
const readB64    = f => new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result.split(",")[1]); r.onerror=rej; r.readAsDataURL(f); });
const readB64WithMime = f => new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>{ const [meta,data]=r.result.split(","); const mime=meta.match(/:(.*?);/)?.[1]||"application/pdf"; res({b64:data,mime}); }; r.onerror=rej; r.readAsDataURL(f); });
const IMG_MIMES  = new Set(["image/jpeg","image/jpg","image/png","image/webp"]);
const ACCEPT_DOCS= "application/pdf,image/jpeg,image/jpg,image/png";
// Store as JSON envelope {b64, mime} so we can handle both PDFs and images
const packDoc    = (b64,mime) => mime&&mime!=="application/pdf" ? JSON.stringify({b64,mime}) : b64;
const unpackDoc  = raw => { if(!raw) return null; try{ const p=JSON.parse(raw); if(p.b64&&p.mime) return p; }catch{} return {b64:raw,mime:"application/pdf"}; };

/* ══ CLOUD DOCUMENT STORE ════════════════════════════════════════
   Documents were previously only in this browser's IndexedDB, so
   they couldn't be seen on another laptop/profile. Now the source of
   truth is Supabase Storage (public ng-media bucket); IndexedDB stays
   as a fast local cache. A per-company map {docKey: publicUrl} is
   synced via Supabase (er-docurls-v1:<company>) so ANY device resolves
   any document.                                                    */
const DOCURL_KEY = "er-docurls-v1";
let _docUrls = {};          // {docKey -> publicUrl} for the active company
const _b64ToBytes = b64 => { const bin=atob(b64), a=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++)a[i]=bin.charCodeAt(i); return a; };
async function loadDocUrls(){ try{ _docUrls=(await loadK(scopedKey(DOCURL_KEY)))||{}; }catch{ _docUrls={}; } return _docUrls; }
async function saveDocUrls(){ try{ await saveK(scopedKey(DOCURL_KEY), _docUrls); }catch(e){ console.warn("docUrls save",e&&e.message); } }
const _storagePath = (company,key,mime) => { const ext = mime==="application/pdf"?"pdf":((mime||"").split("/")[1]||"bin"); return `export-recon/${company}/${String(key).replace(/[^a-zA-Z0-9._-]/g,"_")}.${ext}`; };
async function _uploadDoc(company,key,b64,mime){
  const bytes=_b64ToBytes(b64);
  const file=new File([bytes], _storagePath(company,key,mime).split("/").pop(), {type:mime||"application/pdf"});
  return await uploadToStorage(_storagePath(company,key,mime), file);
}
async function _fetchDocUrl(url){
  const r=await fetch(url); if(!r.ok) throw new Error(`fetch ${r.status}`);
  const blob=await r.blob();
  const mime=blob.type||"application/pdf";
  const b64=await new Promise((res,rej)=>{ const fr=new FileReader(); fr.onload=()=>res(String(fr.result).split(",")[1]); fr.onerror=rej; fr.readAsDataURL(blob); });
  return {b64,mime};
}
const docs = {
  // raw value compatible with unpackDoc() — local cache first, then cloud
  async get(key){
    let raw=null;
    try{ raw=await idb.get(key); }catch{}
    if (raw) return raw;
    const url=_docUrls[key];
    if (url){ try{ const {b64,mime}=await _fetchDocUrl(url); raw=packDoc(b64,mime); try{ await idb.set(key,raw); }catch{} return raw; }catch(e){ console.warn("cloud fetch",key,e&&e.message); } }
    return null;
  },
  // write to local cache + cloud; records the public URL in the synced map.
  // Cloud failures don't throw: the file stays local and the sync banner picks
  // it up later, so uploads never hard-fail (e.g. offline / transient errors).
  async set(key,b64,mime){
    try{ await idb.set(key, packDoc(b64,mime)); }catch{}
    try{ const url=await _uploadDoc(idb.ns,key,b64,mime); _docUrls[key]=url; await saveDocUrls(); return url; }
    catch(e){ console.warn("cloud upload",key,e&&e.message); return null; }
  },
  async del(key){ try{ await idb.del(key); }catch{} if(_docUrls[key]){ delete _docUrls[key]; await saveDocUrls(); } },
  hasCloud(key){ return !!_docUrls[key]; },
};
// Backfill: upload any local-only docs to the cloud so other devices can see them
async function syncLocalDocsToCloud(onProgress){
  let keys=[]; try{ keys=await idb.keys(); }catch{}
  const todo=keys.filter(k=>!_docUrls[k]);
  let done=0, ok=0;
  for(const k of todo){
    try{
      const raw=await idb.get(k); if(!raw){ done++; onProgress&&onProgress(done,todo.length,k); continue; }
      const {b64,mime}=unpackDoc(raw);
      const url=await _uploadDoc(idb.ns,k,b64,mime);
      _docUrls[k]=url; ok++;
      if(ok%5===0) await saveDocUrls();
    }catch(e){ console.warn("sync",k,e&&e.message); }
    done++; onProgress&&onProgress(done,todo.length,k);
  }
  await saveDocUrls();
  return {attempted:todo.length, uploaded:ok, totalLocal:keys.length};
}

// SB status flow: pending → prepared → submitted → cleared → rejected → pending
const STATUS_NEXT  = { pending:"prepared", prepared:"submitted", submitted:"cleared", cleared:"rejected", rejected:"pending" };
// Statuses where the SB is physically stamped/linked — auto-match undo must not touch these
const STATUS_PROTECTED = new Set(["prepared","submitted","cleared","rejected"]);
const STATUS_STYLE = {
  pending:   { bg:C.card,    color:C.inkMid, label:"Pending"          },
  prepared:  { bg:C.amberBg, color:C.amber,  label:"Prepared"         },
  submitted: { bg:C.blueBg,  color:C.blue,   label:"Submitted to Bank"},
  cleared:   { bg:C.greenBg, color:C.green,  label:"Cleared ✓"        },
  rejected:  { bg:C.redBg,   color:C.red,    label:"Rejected ✗"       },
};

async function aiExtract(b64, docType, mime="application/pdf") {
  const prompts = {
    firc: 'This is a FIRC from an Indian bank. Return ONLY valid JSON, no markdown: {"number":"FIRC reference number","dateRaw":"date exactly as printed on document e.g. 02/06/2025","amount":"total remittance amount digits only"}',
    sb:   'This is an Indian customs export document. Return ONLY valid JSON, no markdown: {"sbNumber":"document number","dateRaw":"LEO date or filing date exactly as printed e.g. 02/06/2025 or 10/12/2025","amount":"FOB value INR digits only","docType":"pbe if Postal Bill of Export | csb if Courier Shipping Bill CSB-V CSB-IV | commercial if standard Shipping Bill"}',
    invoice: 'This is a commercial export invoice from an Indian exporter. Return ONLY valid JSON, no markdown: {"invoiceNumber":"invoice number","dateRaw":"invoice date exactly as printed DD/MM/YYYY","amount":"total invoice value digits only","currency":"currency code e.g. INR USD GBP","buyerName":"buyer/consignee name","description":"goods description max 8 words","suggestedSbNumber":"if you see a shipping bill number or reference anywhere on this document put it here else empty string"}',
  };
  const res = await fetch("/api/claude",{
    method:"POST", headers:{"Content-Type":"application/json"},
    body:JSON.stringify({ model:"claude-sonnet-4-20250514", max_tokens:300,
      messages:[{role:"user",content:[
        IMG_MIMES.has(mime)
          ? {type:"image",  source:{type:"base64",media_type:mime,data:b64}}
          : {type:"document",source:{type:"base64",media_type:"application/pdf",data:b64}},
        {type:"text",text:prompts[docType]}
      ]}]
    })
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const d = await res.json();
  if (d.error) throw new Error(d.error.message||JSON.stringify(d.error));
  const t = (d.content||[]).map(i=>i.text||"").join("").replace(/```json|```/g,"").trim();
  try {
    const parsed = JSON.parse(t);
    // Parse dateRaw as DD/MM/YYYY — always, no ambiguity
    if (parsed.dateRaw) {
      parsed.date = parseDDMMYYYY(parsed.dateRaw);
    }
    // For CSB docs: override with date extracted directly from the SB number
    // This is 100% deterministic — CSBV_DEL_2025-2026_02_06_15483 → 2025-06-02
    // Never trust AI date interpretation for CSBs
    const csbDate = dateFromCsbNumber(parsed.sbNumber);
    if (csbDate) parsed.date = csbDate;
    return parsed;
  } catch { throw new Error(`Parse failed. Raw: ${t.slice(0,120)}`); }
}

// ── Build a commercial-invoice draft from a Shipping Bill PDF/image (AI) ──
// The SB itself carries exporter, buyer/consignee, goods and FOB value, so we
// can derive a full commercial invoice straight from it.
async function aiInvoiceFromSb(b64, mime="application/pdf") {
  const prompt = `This is an Indian customs export Shipping Bill / CSB / PBE. Build a COMMERCIAL INVOICE from it: pull every field an export commercial invoice needs. Return ONLY valid JSON, no markdown:
{"exporterName":"exporter/seller name as printed","exporterAddress":"exporter full address one line","exporterIEC":"IEC code if present else empty","exporterGSTIN":"exporter GSTIN if present else empty","buyerName":"consignee/buyer name","buyerAddress":"consignee full address one line","buyerCountry":"destination country","invoiceNumber":"invoice number if one is referenced on the SB else empty","dateRaw":"shipping bill / LEO / filing date exactly as printed DD/MM/YYYY","currency":"currency code e.g. INR USD GBP","sbNumber":"shipping bill / document number","items":[{"description":"goods description","hsn":"HSN code if present else empty","qty":"quantity digits only","unit":"unit e.g. PCS KG CTN","unitPrice":"unit price digits only","amount":"line total digits only"}],"totalAmount":"total FOB / invoice value digits only","terms":"delivery or payment terms if present else empty"}
If goods are not itemised, return ONE item summarising the goods with the full FOB value as its amount.`;
  const res = await fetch("/api/claude",{
    method:"POST", headers:{"Content-Type":"application/json"},
    body:JSON.stringify({ model:"claude-sonnet-4-20250514", max_tokens:1200,
      messages:[{role:"user",content:[
        IMG_MIMES.has(mime)
          ? {type:"image",  source:{type:"base64",media_type:mime,data:b64}}
          : {type:"document",source:{type:"base64",media_type:"application/pdf",data:b64}},
        {type:"text",text:prompt}
      ]}]
    })
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const d = await res.json();
  if (d.error) throw new Error(d.error.message||JSON.stringify(d.error));
  const t = (d.content||[]).map(i=>i.text||"").join("").replace(/```json|```/g,"").trim();
  let parsed;
  try { parsed = JSON.parse(t); }
  catch { throw new Error(`Parse failed. Raw: ${t.slice(0,120)}`); }
  if (parsed.dateRaw) parsed.date = parseDDMMYYYY(parsed.dateRaw);
  const csbDate = dateFromCsbNumber(parsed.sbNumber); if (csbDate) parsed.date = csbDate;
  if (!Array.isArray(parsed.items) || !parsed.items.length) {
    parsed.items = [{description:parsed.description||"Exported goods", hsn:"", qty:"1", unit:"", unitPrice:String(parsed.totalAmount||""), amount:String(parsed.totalAmount||"")}];
  }
  return parsed;
}

// ── Map an AI-extracted SB into a draft for the REAL invoice module ──
// Shape matches nikhil-gems InvoiceForm (same as StockApp's create-invoice
// draft) so the invoice is rendered in the correct, editable format.
function sbToInvoiceDraft(ex, sb){
  const num = v => parseFloat(String(v==null?"":v).replace(/[^\d.]/g,""))||0;
  const items=(Array.isArray(ex.items)&&ex.items.length?ex.items:[{description:ex.description||"Exported goods",hsn:"",qty:"1",unit:"",unitPrice:ex.totalAmount,amount:ex.totalAmount}])
    .map(it=>({ id:uid(), acctDesc:it.description||"", customDesc:it.description||"", hsn:it.hsn||"",
      qty:String(it.qty||""), unit:it.unit||"pcs", rate:String(num(it.unitPrice)||""), igst:0,
      amt:num(it.amount), stockId:"", acctStockId:"", ready:false, readyDate:"" }));
  const totalAmt = num(ex.totalAmount) || items.reduce((s,i)=>s+(+i.amt||0),0);
  return {
    id:uid(), invNo:"", type:"commercial",
    date: ex.date || (sb&&sb.date) || new Date().toISOString().slice(0,10),
    dueDate:"", currency:(ex.currency||"USD").toUpperCase(), buyerId:"",
    items, status:"draft", goodsShipped:false, payments:[], paidAmount:0,
    notes: [sb&&sb.sbNumber?`From Shipping Bill ${sb.sbNumber}`:"", ex.buyerName?`Buyer (from SB): ${ex.buyerName}`:""].filter(Boolean).join(" · "),
    terms: ex.terms || "T/T in advance",
    portLading:"Mumbai, India", portDischarge:"",
    consigneeSameAsBuyer:true,
    consigneeName: ex.buyerName||"", consigneeAddress: ex.buyerAddress||"", consigneeCountry: ex.buyerCountry||"",
    totalAmt, createdAt:new Date().toISOString(),
    sourceSbId: sb&&sb.id||"", sourceSbNumber: sb&&sb.sbNumber||(ex.sbNumber||""),
  };
}
// A blank draft for "Create invoice" (same shape; user fills it in the module)
function blankInvoiceDraft(){
  return { id:uid(), invNo:"", type:"commercial", date:new Date().toISOString().slice(0,10),
    dueDate:"", currency:"USD", buyerId:"", items:[], status:"draft", goodsShipped:false,
    payments:[], paidAmount:0, notes:"", terms:"T/T in advance", portLading:"Mumbai, India",
    portDischarge:"", consigneeSameAsBuyer:true, consigneeName:"", consigneeAddress:"",
    consigneeCountry:"", totalAmt:0, createdAt:new Date().toISOString() };
}

// Always treat incoming date strings as DD/MM/YYYY (Indian format)
function parseDDMMYYYY(raw) {
  if (!raw) return "";
  const m = raw.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (!m) return "";
  const [, dd, mm, yyyy] = m;
  const day = parseInt(dd,10), month = parseInt(mm,10), year = parseInt(yyyy,10);
  if (month < 1||month > 12||day < 1||day > 31) return "";
  return `${yyyy}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
}

// Extract date from CSB-V number — two formats exist:
//   Split:    CSBV_DEL_2025-2026_02_06_15483  → parts after FY: "02","06"
//   Combined: CSBV_DEL_2025-2026_0206_15483   → parts after FY: "0206"
function dateFromCsbNumber(sbNumber) {
  if (!sbNumber) return "";
  const upper = sbNumber.toUpperCase();
  if (!upper.startsWith("CSBV_") && !upper.startsWith("CSB_")) return "";
  const parts = sbNumber.split("_");
  const fyIdx = parts.findIndex(p => /\d{4}-\d{4}/.test(p));
  if (fyIdx === -1) return "";
  const yearStr = parts[fyIdx].split("-")[0];
  const year = parseInt(yearStr, 10);
  if (!year) return "";

  let day, month;
  const next = parts[fyIdx + 1] || "";
  const after = parts[fyIdx + 2] || "";

  if (/^\d{4}$/.test(next)) {
    // Combined DDMM e.g. "0206" → DD=02 MM=06
    day   = parseInt(next.slice(0, 2), 10);
    month = parseInt(next.slice(2, 4), 10);
  } else if (/^\d{1,2}$/.test(next) && /^\d{1,2}$/.test(after)) {
    // Split e.g. "02","06"
    day   = parseInt(next, 10);
    month = parseInt(after, 10);
  } else {
    return "";
  }

  if (month < 1||month > 12||day < 1||day > 31) return "";
  // Fiscal year: month Apr-Mar, if month >= 4 → first year, else second year
  const actualYear = month >= 4 ? year : year + 1;
  return `${actualYear}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
}

function autoMatch(fircs, sbs) {
  const used={}, asgn={};
  // Pre-seed with amounts already matched so we don't over-fill or re-erase
  fircs.forEach(f => {
    used[f.id] = sbs.filter(sb=>sb.fircId===f.id).reduce((s,sb)=>s+(+sb.amount||0),0);
  });
  const unmatched = sbs.filter(sb=>!sb.fircId).sort((a,b)=>new Date(a.date||0)-new Date(b.date||0));
  [...fircs].sort((a,b)=>new Date(a.date)-new Date(b.date)).forEach(f=>{
    let rem=(+f.amount||0)-used[f.id];
    const fd2=f.date?new Date(f.date):null;
    unmatched.forEach(sb=>{
      if (asgn[sb.id]) return;
      const sd=sb.date?new Date(sb.date):null;
      if ((+sb.amount||0)<=rem&&(!sd||!fd2||sd<=fd2)){ asgn[sb.id]=f.id; rem-=(+sb.amount||0); }
    });
  });
  return asgn;
}

/* ══ LEARNER BOT ════════════════════════════════════════════════
   Silent, always-on session tracker. Module-level singleton so
   tracking calls never cause React re-renders. Flushes to
   Supabase via saveK('ng-learner-v1') every FLUSH_EVERY events,
   on tab hide, and after 30 min idle.                            */
const learner = (() => {
  const SESSION_ID    = (typeof crypto!=="undefined"&&crypto.randomUUID)?crypto.randomUUID():Math.random().toString(36).slice(2);
  const SESSION_START = Date.now();
  let events   = [];
  let idleTimer= null;
  const FLUSH_EVERY = 30;
  const IDLE_MS     = 30 * 60 * 1000;

  async function flush() {
    if (!events.length) return;
    const snapshot = events.splice(0);
    try {
      const stored = (await loadK("ng-learner-v1")) || { sessions: [], insights: null };
      const existing = stored.sessions.find(s => s.id === SESSION_ID);
      if (existing) {
        existing.events    = [...existing.events, ...snapshot].slice(-200);
        existing.eventCount= existing.events.length;
        existing.end       = Date.now();
      } else {
        stored.sessions.unshift({ id: SESSION_ID, start: SESSION_START, end: Date.now(), eventCount: snapshot.length, events: snapshot });
        stored.sessions = stored.sessions.slice(0, 50);
      }
      await saveK("ng-learner-v1", stored);
    } catch {}
  }

  function resetIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(flush, IDLE_MS);
  }

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => { if (document.hidden) flush(); });
  }

  return {
    track(e, p = {}) {
      events.push({ t: Date.now(), e, p });
      resetIdle();
      if (events.length >= FLUSH_EVERY) flush();
    },
    flush,
    get sessionId()    { return SESSION_ID; },
    get sessionStart() { return SESSION_START; },
    get buffered()     { return events.length; },
  };
})();

/* ══ APP ════════════════════════════════════════════════════════ */
export default function App({ company = "atyahara", onCreateInvoiceFromSb }) {
  const [data, setData]         = useState({fircs:[],shippingBills:[],invoices:[]});
  const dataRef                  = useRef(data);
  const [loading, setLoading]   = useState(true);
  const [view, setView]         = useState("fircs");
  const [sheet, setSheet]       = useState(null);
  const openSheet = useCallback(s => { if (s) learner.track("sheet:open",{type:s.type}); setSheet(s); }, []);
  const [hasFema, setHasFema]   = useState(false);
  const [pdfReady, setPdfReady] = useState(false);
  const [pdfErr, setPdfErr]     = useState(null);
  const pdfLib                  = useRef(null);
  const pdfJs                   = useRef(null);
  const [genId, setGenId]       = useState(null);
  const [pdfModal, setPdfModal]     = useState(null);  // kept for packet download
  const [docViewer, setDocViewer]   = useState(null);  // {url, name, mime} for inline view
  const [exportModal, setExportModal] = useState(null); // raw JSON string fallback for blocked downloads
  const [cloudSync, setCloudSync] = useState({unsynced:0, running:false, done:0, total:0, lastMsg:null});

  useEffect(()=>{ dataRef.current=data; },[data]);

  // Count docs that live only in THIS browser (not yet pushed to the cloud)
  const refreshUnsynced = useCallback(async()=>{
    try{ const keys=await idb.keys(); setCloudSync(s=>({...s,unsynced:keys.filter(k=>!docs.hasCloud(k)).length})); }catch{}
  },[]);
  const runCloudSync = useCallback(async()=>{
    setCloudSync(s=>({...s,running:true,done:0,total:0,lastMsg:null}));
    try{
      const res=await syncLocalDocsToCloud((done,total)=>setCloudSync(s=>({...s,done,total})));
      await refreshUnsynced();
      setCloudSync(s=>({...s,running:false,lastMsg:`✓ ${res.uploaded} document${res.uploaded!==1?"s":""} synced to the cloud — now visible on every device.`}));
    }catch(e){ setCloudSync(s=>({...s,running:false,lastMsg:`Sync error: ${(e&&e.message||"").slice(0,80)}`})); }
  },[refreshUnsynced]);

  useEffect(()=>{
    activeReconCompany = company || "atyahara";
    idb.setNamespace(activeReconCompany);
  },[company]);

  // pdf-lib: fetch UMD → eval (sets window.PDFLib, no module system)
  useEffect(()=>{
    (async()=>{
      if (window.PDFLib){ pdfLib.current=window.PDFLib; setPdfReady(true); }
      else {
        for (const url of [
          "https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js",
          "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js",
        ]) {
          try {
            const r=await fetch(url); if (!r.ok) continue;
            new Function(await r.text())();
            if (window.PDFLib){ pdfLib.current=window.PDFLib; setPdfReady(true); break; }
          } catch(e){ console.warn("pdf-lib:",url,e.message); }
        }
        if (!pdfLib.current) setPdfErr("PDF engine failed to load");
      }
      // Load PDF.js for inline viewing
      if (!window.pdfjsLib) {
        for (const url of [
          "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
          "https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.min.js",
        ]) {
          try {
            const r=await fetch(url); if (!r.ok) continue;
            new Function(await r.text())();
            if (window.pdfjsLib) {
              window.pdfjsLib.GlobalWorkerOptions.workerSrc=
                "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
              pdfJs.current=window.pdfjsLib;
              break;
            }
          } catch(e){ console.warn("pdf.js:",url,e.message); }
        }
      } else {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc=
          "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
        pdfJs.current=window.pdfjsLib;
      }
    })();
  },[]);

  useEffect(()=>{
    (async()=>{
      activeReconCompany = company || "atyahara";
      idb.setNamespace(activeReconCompany);
      await loadDocUrls();
      const d=await metaStore.load(); setData(d); dataRef.current=d;
      setHasFema(!!(await idb.get("fema")) || docs.hasCloud("fema"));
      setLoading(false);
      refreshUnsynced();
    })();
  },[company]);

  const persist = useCallback(async upd => {
    const base=normalizeMeta(dataRef.current);
    const next=normalizeMeta(typeof upd==="function"?upd(base):upd);
    dataRef.current=next; setData({...next}); await metaStore.save(next); return next;
  },[]);

  const addFirc    = useCallback(async f   => persist(d=>({...d,fircs:[...d.fircs,f].sort((a,b)=>new Date(a.date)-new Date(b.date))})),[persist]);
  const deleteFirc = useCallback(async id  => { learner.track("firc:delete"); await persist(d=>({...d,fircs:d.fircs.filter(f=>f.id!==id),shippingBills:d.shippingBills.map(sb=>sb.fircId===id?{...sb,fircId:null}:sb)})); await docs.del(`firc:${id}`); },[persist]);
  const updateFirc = useCallback(async (id,p)=>{ learner.track("firc:edit"); return persist(d=>({...d,fircs:d.fircs.map(f=>f.id===id?{...f,...p}:f)})); },[persist]);
  const addSb      = useCallback(async sb  => persist(d=>({...d,shippingBills:[...d.shippingBills,sb].sort((a,b)=>new Date(a.date)-new Date(b.date))})),[persist]);
  const deleteSb   = useCallback(async id  => { learner.track("sb:delete"); await persist(d=>({...d,shippingBills:d.shippingBills.filter(sb=>sb.id!==id)})); await Promise.all(["sb","inv","hawb","erf","brc"].map(t=>docs.del(`${t}:${id}`))); },[persist]);
  const patchSb    = useCallback(async (id,p)=>persist(d=>({...d,shippingBills:d.shippingBills.map(sb=>sb.id===id?{...sb,...p}:sb)})),[persist]);
  const assignSb   = useCallback(async (sbId,fircId)=>{ learner.track("match:sb:assign",{hasFirc:!!fircId}); return persist(d=>({...d,shippingBills:d.shippingBills.map(sb=>sb.id===sbId?{...sb,fircId}:sb)})); },[persist]);
  const cycleStatus= useCallback(async id=>{ const sb=dataRef.current.shippingBills.find(x=>x.id===id); if(sb){ learner.track("sb:status:cycle",{from:sb.status||"pending",to:STATUS_NEXT[sb.status||"pending"]}); await patchSb(id,{status:STATUS_NEXT[sb.status||"pending"]}); } },[patchSb]);

  // Invoice queue callbacks
  const addInvoice    = useCallback(async inv => persist(d=>({...d,invoices:[...(d.invoices||[]),inv]})),[persist]);
  const patchInvoice  = useCallback(async (id,p)=>persist(d=>({...d,invoices:(d.invoices||[]).map(inv=>inv.id===id?{...inv,...p}:inv)})),[persist]);
  const deleteInvoice = useCallback(async id => { await persist(d=>({...d,invoices:(d.invoices||[]).filter(inv=>inv.id!==id)})); await docs.del(`inv-pending:${id}`); },[persist]);
  // Approve: move PDF from staging key to inv:sbId, patch SB hasInvPdf
  const approveInvoice = useCallback(async (invId, sbId) => {
    learner.track("invoice:approve");
    const raw = await docs.get(`inv-pending:${invId}`);
    if (raw) { const {b64,mime}=unpackDoc(raw); await docs.set(`inv:${sbId}`, b64, mime); await docs.del(`inv-pending:${invId}`); }
    await patchSb(sbId, {hasInvPdf:true});
    await patchInvoice(invId, {status:"approved", linkedSbId:sbId});
  },[patchSb, patchInvoice]);

  // Snapshot: {sbId: fircId|null} saved before each auto-match so we can undo
  const [matchSnapshot, setMatchSnapshot] = useState(null);

  const applyAuto = useCallback(async () => {
    learner.track("match:auto");
    // Save snapshot of current matches BEFORE running (for undo)
    const snapshot = {};
    dataRef.current.shippingBills.forEach(sb => { snapshot[sb.id] = sb.fircId || null; });
    setMatchSnapshot(snapshot);
    const a = autoMatch(dataRef.current.fircs, dataRef.current.shippingBills);
    await persist(d => ({...d, shippingBills: d.shippingBills.map(sb => a[sb.id] ? {...sb, fircId:a[sb.id]} : sb)}));
  }, [persist]);

  const undoAuto = useCallback(async () => {
    if (!matchSnapshot) return;
    learner.track("match:undo");
    // Restore previous fircId, but SKIP protected statuses (prepared/submitted/cleared/rejected)
    await persist(d => ({
      ...d,
      shippingBills: d.shippingBills.map(sb => {
        if (STATUS_PROTECTED.has(sb.status||"pending")) return sb; // don't touch stamped SBs
        return {...sb, fircId: matchSnapshot[sb.id] ?? null};
      })
    }));
    setMatchSnapshot(null);
  }, [matchSnapshot, persist]);

  const clearPending = useCallback(async () => { learner.track("match:clear:pending"); return persist(d => ({...d, shippingBills: d.shippingBills.map(sb => STATUS_PROTECTED.has(sb.status||"pending") ? sb : {...sb, fircId:null})})); }, [persist]);
  const clearAll     = useCallback(async () => { learner.track("match:clear:all"); return persist(d => ({...d, shippingBills: d.shippingBills.map(sb => ({...sb, fircId:null}))})); }, [persist]);

  const showPdf = useCallback(async (key,name)=>{
    learner.track("pdf:view");
    const raw=await docs.get(key);
    if (!raw){alert(`No file stored for "${name}"`);return;}
    const {b64,mime}=unpackDoc(raw);
    const bin=atob(b64),arr=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++) arr[i]=bin.charCodeAt(i);
    const url=URL.createObjectURL(new Blob([arr],{type:mime}));
    setDocViewer({url,name,mime,downloadName:name});
  },[]);

  const generatePacket = useCallback(async sbOrId=>{
    learner.track("packet:generate");
    const sbId=typeof sbOrId==="string"?sbOrId:sbOrId?.id;
    const sb=dataRef.current.shippingBills.find(x=>x.id===sbId);
    if (!sb){alert("SB not found");return;}
    if (!pdfReady&&!window.PDFLib){alert("PDF engine not ready");return;}
    const firc=dataRef.current.fircs.find(f=>f.id===sb.fircId);
    if (!firc){alert("No FIRC assigned — go to Match tab");return;}
    setGenId(sbId);
    try {
      const {PDFDocument,StandardFonts,rgb}=pdfLib.current||window.PDFLib;
      const [sbB,invB,fircB,hawbB,femaB,erfB,brcB]=await Promise.all([
        docs.get(`sb:${sb.id}`),docs.get(`inv:${sb.id}`),docs.get(`firc:${firc.id}`),
        docs.get(`hawb:${sb.id}`),docs.get("fema"),docs.get(`erf:${sb.id}`),docs.get(`brc:${sb.id}`),
      ]);
      const merged=await PDFDocument.create();
      const font=await merged.embedFont(StandardFonts.Helvetica);
      const bold=await merged.embedFont(StandardFonts.HelveticaBold);
      const b2u=b=>{const bin=atob(b),a=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)a[i]=bin.charCodeAt(i);return a;};
      const app=async(raw,label)=>{
        if (!raw){
          const pg=merged.addPage([595,842]);
          pg.drawRectangle({x:0,y:760,width:595,height:82,color:rgb(0.93,0.91,0.87)});
          pg.drawText(label,{x:30,y:808,size:14,font:bold,color:rgb(0.4,0.35,0.28)});
          pg.drawText("Document not uploaded — insert physical copy here",{x:30,y:786,size:9,font,color:rgb(0.6,0.55,0.48)});
          pg.drawText(`SB: ${sb.sbNumber}  ·  ${new Date().toLocaleDateString("en-IN")}`,{x:30,y:768,size:8,font,color:rgb(0.7,0.65,0.58)});
          return;
        }
        try {
          const {b64,mime}=unpackDoc(raw);
          if (IMG_MIMES.has(mime)) {
            // Embed image as a full A4 page
            const imgBytes=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));
            const img=mime==="image/png"?await merged.embedPng(imgBytes):await merged.embedJpg(imgBytes);
            const pg=merged.addPage([595,842]);
            const {width:iw,height:ih}=img.scale(1);
            const scale=Math.min(555/iw,802/ih,1);
            const w=iw*scale,h=ih*scale;
            pg.drawImage(img,{x:(595-w)/2,y:(842-h)/2,width:w,height:h});
          } else {
            const doc=await PDFDocument.load(b2u(b64),{ignoreEncryption:true});
            (await merged.copyPages(doc,doc.getPageIndices())).forEach(p=>merged.addPage(p));
          }
        }
        catch(e){ const pg=merged.addPage([595,842]); pg.drawText(`[ ${label} — error: ${e.message.slice(0,70)} ]`,{x:20,y:420,size:9,font:bold,color:rgb(0.8,0.2,0.2)}); }
      };
      await app(invB, `Invoice — ${sb.sbNumber}`);
      await app(sbB,  `Shipping Bill — ${sb.sbNumber}`);
      await app(fircB,`FIRC — ${firc.number||"—"}`);
      await app(femaB,"FEMA Declaration");
      await app(hawbB,`HAWB — ${sb.sbNumber}`);
      await app(erfB, "Export Reconciliation Form");
      if(brcB||sb.status==="cleared")await app(brcB, "BRC Certificate");
      const out=await merged.save();
      setPdfModal({url:URL.createObjectURL(new Blob([out],{type:"application/pdf"})),name:`Packet_${sb.sbNumber}.pdf`});
    } catch(e){ alert(`Packet error: ${e.message}`); }
    setGenId(null);
  },[pdfReady]);

  const exportBackup = useCallback(async ()=>{
    learner.track("backup:export");
    const meta = dataRef.current;
    const allKeys = await idb.keys();
    const files = {};
    for (const k of allKeys) {
      files[k] = await idb.get(k);
    }
    const bundle = { version: META_KEY, exportedAt: new Date().toISOString(), meta, files };
    const json   = JSON.stringify(bundle);

    // Try direct download first
    try {
      const blob = new Blob([json], {type:"application/json"});
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href=url; a.download=`export-recon-full-${new Date().toISOString().slice(0,10)}.json`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(()=>URL.revokeObjectURL(url),5000);
    } catch(e) {
      // Sandbox blocked — fall back to clipboard
    }

    // Always also copy to clipboard as a reliable fallback
    try {
      await navigator.clipboard.writeText(json);
      alert(`✓ Backup copied to clipboard!\n\nPaste it into a text file and save as:\nexport-recon-full-${new Date().toISOString().slice(0,10)}.json\n\nThen use "Restore from backup" in your ERP.`);
    } catch(e2) {
      // Clipboard also blocked — show in textarea modal
      setExportModal(json);
    }
  },[]);

  const importBackup = useCallback(async (file)=>{
    learner.track("backup:import");
    try {
      const text = await file.text();
      const bundle = JSON.parse(text);
      // Restore meta
      if (bundle.meta) {
        await persist(()=>({
          fircs:          bundle.meta.fircs          || [],
          shippingBills:  bundle.meta.shippingBills  || [],
          invoices:       bundle.meta.invoices        || [],
        }));
      }
      // Restore all IDB binaries
      if (bundle.files) {
        for (const [k,v] of Object.entries(bundle.files)) {
          if (v) await idb.set(k, v);
        }
      }
      alert(`✓ Restored ${bundle.meta?.shippingBills?.length||0} SBs, ${bundle.meta?.fircs?.length||0} FIRCs, and ${Object.keys(bundle.files||{}).length} stored files.`);
    } catch(e) {
      alert(`Import failed: ${e.message}`);
    }
  },[persist]);

  const fixAllDates = useCallback(async (onProgress) => {
    learner.track("date:fix:all");
    const sbs = dataRef.current.shippingBills;
    let fixed = 0, failed = 0, skipped = 0;
    for (let i = 0; i < sbs.length; i++) {
      const sb = sbs[i];
      onProgress({i, total: sbs.length, sb: sb.sbNumber, status: "reading"});
      try {
        const raw = await docs.get(`sb:${sb.id}`);
        if (!raw) { skipped++; onProgress({i, total: sbs.length, sb: sb.sbNumber, status: "no-pdf"}); continue; }
        const {b64,mime} = unpackDoc(raw);
        onProgress({i, total: sbs.length, sb: sb.sbNumber, status: "extracting"});
        const ex = await aiExtract(b64, "sb", mime);
        if (ex.date && ex.date !== sb.date) {
          await patchSb(sb.id, {date: ex.date});
          fixed++;
          onProgress({i, total: sbs.length, sb: sb.sbNumber, status: "fixed", from: sb.date, to: ex.date});
        } else {
          skipped++;
          onProgress({i, total: sbs.length, sb: sb.sbNumber, status: "ok", date: sb.date});
        }
      } catch(e) {
        failed++;
        onProgress({i, total: sbs.length, sb: sb.sbNumber, status: "error", detail: e.message});
      }
    }
    return { fixed, failed, skipped };
  }, [patchSb]);

  const fircUsed = useCallback(id=>data.shippingBills.filter(sb=>sb.fircId===id).reduce((s,sb)=>s+(+sb.amount||0),0),[data]);
  const unmatched = data.shippingBills.filter(sb=>!sb.fircId).length;

  if (loading) return <Loader/>;

  const pendingInvoices = (data.invoices||[]).filter(inv=>inv.status==="pending").length;
  const NAV=[
    {key:"fircs",    icon:"💵", label:"FIRCs",            badge:data.fircs.length},
    {key:"sbs",      icon:"📦", label:"Shipping Bills",   badge:data.shippingBills.length},
    {key:"invoices", icon:"🧾", label:"Invoices",         badge:pendingInvoices||null, badgeAlert:!!pendingInvoices},
    {key:"match",    icon:"⇄",  label:"Match",            badge:unmatched||null, badgeAlert:true},
    {key:"stats",    icon:"📊", label:"Stats"},
    {key:"ai",       icon:"🤖", label:"AI Insights"},
    {key:"fema",     icon:"📄", label:"FEMA Declaration", badge:hasFema?null:"!", badgeAlert:true},
  ];

  const clearedCount  = data.shippingBills.filter(sb=>sb.status==="cleared").length;
  const rejectedCount = data.shippingBills.filter(sb=>sb.status==="rejected").length;

  const navButtons=NAV.map(n=>(
    <button key={n.key} className={mob?`er-tab${view===n.key?" active":""}`:`nav-item${view===n.key?" active":""}`} onClick={()=>{setView(n.key);learner.track("view:change",{to:n.key});}}>
      <span style={{fontSize:mob?14:15,width:mob?"auto":20,textAlign:"center",flexShrink:0}}>{n.icon}</span>
      <span style={{flex:1}}>{n.label}</span>
      {n.badge!=null&&<span style={{background:n.badgeAlert?C.amber:C.ink,color:C.surface,fontSize:10,fontWeight:700,padding:"1px 7px",borderRadius:20,minWidth:20,textAlign:"center"}}>{n.badge}</span>}
    </button>
  ));

  return (
    <div className="er-app" style={S.root}>
      <style>{CSS}</style>

      {!mob&&(
        <div style={S.sidebar}>
          <div style={S.sideHead}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:6}}>
              <div style={S.logo}>ER</div>
              <div>
                <div style={S.appName}>Export Recon</div>
                <div style={S.appSub}>FEMA Reconciliation</div>
              </div>
            </div>
            <div style={{fontSize:11,color:C.inkFaint,lineHeight:1.6,paddingLeft:2}}>
              {data.shippingBills.filter(sb=>sb.fircId).length}/{data.shippingBills.length} matched
              {clearedCount>0&&<span style={{color:C.green}}> · {clearedCount} cleared</span>}
              {rejectedCount>0&&<span style={{color:C.red}}> · {rejectedCount} rejected</span>}
            </div>
          </div>

          <div style={S.navSection}>{navButtons}</div>

          <div style={S.sideFooter}>
            <div style={{fontSize:11,color:pdfErr?C.red:pdfReady?C.green:C.inkFaint,display:"flex",alignItems:"center",gap:6}}>
              <span>{pdfErr?"●":pdfReady?"●":"○"}</span>
              <span>{pdfErr?"PDF engine failed":pdfReady?"PDF engine ready":"PDF engine loading…"}</span>
            </div>
          </div>
        </div>
      )}

      {mob&&(
        <div style={{position:"sticky",top:0,zIndex:90,background:C.bg,paddingBottom:12,marginBottom:6}}>
        <div className="er-tabs">
          {navButtons}
        </div>
        <div style={{fontSize:11.5,color:C.inkFaint,marginTop:8,paddingLeft:4,display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
          <span>{data.shippingBills.filter(sb=>sb.fircId).length}/{data.shippingBills.length} matched</span>
          {clearedCount>0&&<span style={{color:C.green}}>· {clearedCount} cleared</span>}
          {rejectedCount>0&&<span style={{color:C.red}}>· {rejectedCount} rejected</span>}
          {pdfErr
            ?<span style={{color:C.red,display:"inline-flex",alignItems:"center",gap:4}}>· <span style={{fontSize:8}}>●</span> PDF engine failed</span>
            :!pdfReady&&<span style={{color:C.inkFaint,display:"inline-flex",alignItems:"center",gap:4}}>· <span style={{fontSize:8}}>○</span> PDF engine loading…</span>}
        </div>
      </div>
      )}

      {/* ── Main content ── */}
      <div style={{...S.content, transition:"margin-right .25s var(--ease,ease)", marginRight: docViewer&&!mob ? 500 : 0}}>
        {(cloudSync.running || cloudSync.unsynced>0 || cloudSync.lastMsg) && (
          <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap",
            background:cloudSync.running?C.blueBg:cloudSync.unsynced>0?C.amberBg:C.greenBg,
            border:`1px solid ${cloudSync.running?C.blue:cloudSync.unsynced>0?C.amber:C.green}`,
            borderRadius:12,padding:"11px 15px",marginBottom:14}}>
            <span style={{fontSize:18}}>{cloudSync.running?"☁️":cloudSync.unsynced>0?"⚠️":"✅"}</span>
            <div style={{flex:1,minWidth:180,fontSize:13,color:cloudSync.running?C.blue:cloudSync.unsynced>0?C.amber:C.green,lineHeight:1.45}}>
              {cloudSync.running
                ? <>Uploading documents to the cloud… <b>{cloudSync.done}/{cloudSync.total}</b></>
                : cloudSync.unsynced>0
                  ? <><b>{cloudSync.unsynced}</b> document{cloudSync.unsynced!==1?"s are":" is"} stored only on this device — other laptops can’t open {cloudSync.unsynced!==1?"them":"it"}. Sync to the cloud so everyone can view &amp; download.</>
                  : cloudSync.lastMsg}
            </div>
            {!cloudSync.running && cloudSync.unsynced>0 && (
              <button className="pr" onClick={runCloudSync} style={{...S.btnDark,padding:"8px 14px",fontSize:12,whiteSpace:"nowrap"}}>☁️ Sync to cloud</button>
            )}
            {!cloudSync.running && cloudSync.unsynced===0 && cloudSync.lastMsg && (
              <button className="pr" onClick={()=>setCloudSync(s=>({...s,lastMsg:null}))} style={{...S.btnGhost,padding:"6px 10px",fontSize:12}}>Dismiss</button>
            )}
          </div>
        )}
        <HowItWorks setView={setView}/>
        {view==="fircs"    && <FircsView    data={data} fircUsed={fircUsed} onAdd={addFirc} onDelete={deleteFirc} onUpdate={updateFirc} showPdf={showPdf} setSheet={openSheet}/>}
        {view==="sbs"      && <SBsView      data={data} onAdd={addSb} onDelete={deleteSb} onPatch={patchSb} onCycle={cycleStatus} setSheet={openSheet} onGen={generatePacket} genId={genId} hasFema={hasFema} pdfReady={pdfReady} pdfErr={pdfErr} showPdf={showPdf}/>}
        {view==="invoices" && <InvoicesView data={data} onAddInvoice={addInvoice} onPatchInvoice={patchInvoice} onDeleteInvoice={deleteInvoice} onApprove={approveInvoice} showPdf={showPdf} onCreateInvoiceFromSb={onCreateInvoiceFromSb}/>}
        {view==="match"    && <MatchView    data={data} fircUsed={fircUsed} onAssign={assignSb} onAuto={applyAuto} onUndo={undoAuto} onClearPending={clearPending} onClearAll={clearAll} showPdf={showPdf} canUndo={!!matchSnapshot}/>}
        {view==="stats"    && <StatsView    data={data} fircUsed={fircUsed} onExport={exportBackup} onImport={importBackup} onFixDates={fixAllDates}/>}
        {view==="ai"       && <AIInsightsView data={data} fircUsed={fircUsed}/>}
        {view==="fema"     && <FemaView     hasFema={hasFema} setHasFema={setHasFema}/>}
      </div>

      {/* ── Inline document viewer (fixed right panel) ── */}
      {docViewer&&(
        <DocViewerPanel doc={docViewer} pdfJs={pdfJs}
          onClose={()=>{ URL.revokeObjectURL(docViewer.url); setDocViewer(null); }}/>
      )}

      {/* ── Right-side sheet panel ── */}
      {sheet&&(
        <div className="ov" onClick={()=>setSheet(null)}>
          <div className="sh" onClick={e=>e.stopPropagation()}>
            <div style={{padding:"18px 24px 0",display:"flex",alignItems:"center",justifyContent:"space-between",borderBottom:`1px solid ${C.border}`,paddingBottom:14,marginBottom:0,flexShrink:0,position:"sticky",top:0,background:C.surface,zIndex:2}}>
              <div style={{fontFamily:FONT,fontSize:18,fontWeight:700,letterSpacing:"-.01em",color:C.ink}}>
                {sheet.type==="sbDetail"?"Shipping Bill Details":"FIRC Details"}
              </div>
              <button onClick={()=>setSheet(null)} style={{background:C.fill,border:"none",borderRadius:8,padding:"6px 12px",fontSize:13,cursor:"pointer",color:C.inkMid}}>✕ Close</button>
            </div>
            <div style={{padding:"20px 24px 32px",overflowY:"auto"}}>
              {sheet.type==="sbDetail"   && <SbDetailSheet   sbId={sheet.payload}   getData={()=>dataRef.current} onPatch={patchSb} onGen={id=>{setSheet(null);generatePacket(id);}} genId={genId} hasFema={hasFema} pdfReady={pdfReady} pdfErr={pdfErr} showPdf={showPdf} onAddInvoice={addInvoice} onGotoInvoices={()=>{setSheet(null);setView("invoices");}} onCreateInvoiceFromSb={onCreateInvoiceFromSb}/>}
              {sheet.type==="fircDetail" && <FircDetailSheet fircId={sheet.payload} getData={()=>dataRef.current} fircUsed={fircUsed} showPdf={showPdf} onGen={id=>{setSheet(null);generatePacket(id);}} genId={genId} pdfReady={pdfReady} pdfErr={pdfErr} onUnlink={id=>assignSb(id,null)} onDeleteSb={deleteSb} onUpdateFirc={updateFirc}/>}
            </div>
          </div>
        </div>
      )}

      {/* ── Export fallback modal (when download + clipboard both blocked) ── */}
      {exportModal&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",backdropFilter:"blur(6px)",WebkitBackdropFilter:"blur(6px)",zIndex:400,display:"flex",alignItems:"center",justifyContent:"center",padding:24}}>
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:16,padding:28,width:"100%",maxWidth:600,display:"flex",flexDirection:"column",gap:16,boxShadow:"var(--e-modal)"}}>
            <div style={{color:C.ink,fontSize:16,fontWeight:700}}>📋 Copy your backup data</div>
            <div style={{color:C.inkMid,fontSize:13,lineHeight:1.6}}>
              Download was blocked by the sandbox. Select all the text below, copy it, paste into a new file, and save as <code style={{background:C.card,padding:"1px 6px",borderRadius:4,fontSize:12}}>export-recon-full.json</code>
            </div>
            <textarea readOnly value={exportModal}
              style={{width:"100%",height:180,background:C.card,color:C.inkMid,border:`1px solid ${C.border}`,
                borderRadius:9,padding:"10px 12px",fontSize:11,fontFamily:"'SF Mono','Courier New',monospace",resize:"none",lineHeight:1.4}}
              onFocus={e=>e.target.select()}/>
            <div style={{display:"flex",gap:10}}>
              <button className="pr" onClick={async()=>{
                try{ await navigator.clipboard.writeText(exportModal); alert("✓ Copied to clipboard — paste into a .json file"); }
                catch{ alert("Select all text in the box above and copy manually (Ctrl+A then Ctrl+C)"); }
              }} style={{...S.btnPrimary,padding:"11px 24px",fontSize:14,flex:1}}>
                Copy to clipboard
              </button>
              <button className="pr" onClick={()=>setExportModal(null)}
                style={{...S.btnGhost,padding:"11px 20px",fontSize:14}}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
      {pdfModal&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",backdropFilter:"blur(6px)",WebkitBackdropFilter:"blur(6px)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center"}}>
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:16,padding:"28px",width:420,display:"flex",flexDirection:"column",alignItems:"center",gap:16,boxShadow:"var(--e-modal)"}}>
            <div style={{fontSize:48}}>{pdfModal.isJson?"📦":"📄"}</div>
            <div style={{color:C.ink,fontSize:15,fontWeight:600,textAlign:"center"}}>{pdfModal.name}</div>
            <div style={{display:"flex",gap:10}}>
              <a href={pdfModal.url} download={pdfModal.name}
                style={{...S.btnPrimary,padding:"11px 28px",fontSize:14,textDecoration:"none"}}>
                ⬇ Save {pdfModal.isJson?"JSON":"PDF"}
              </a>
              <button onClick={()=>{URL.revokeObjectURL(pdfModal.url);setPdfModal(null);}}
                style={{...S.btnGhost,padding:"11px 20px",fontSize:14}}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ══ FIRCS VIEW ══════════════════════════════════════════════════ */
function FircsView({ data, fircUsed, onAdd, onDelete, onUpdate, showPdf, setSheet }) {
  const [log,         setLog]      = useState([]);
  const [editId,      setEditId]   = useState(null);
  const [editVals,    setEditVals] = useState({});
  const [search,      setSearch]   = useState("");
  const [sortBy,      setSortBy]   = useState("date-asc");
  const [filterUtil,  setFilterUtil]= useState("all");   // all full partial empty
  const [showFilters, setShowFilters]=useState(false);
  const [manualOpen,  setManualOpen]= useState(false);
  const [manualVals,  setManualVals]= useState(()=>emptyManualFirc());
  const busyRef = useRef(false);
  const fileRef = useRef();

  async function handleFiles(files) {
    if (busyRef.current) return;
    busyRef.current=true;
    const arr=Array.from(files);
    learner.track("firc:upload",{count:arr.length});
    setLog(arr.map(f=>({name:f.name,status:"queued",detail:""})));
    for (let i=0;i<arr.length;i++) {
      const upd=p=>setLog(l=>l.map((r,j)=>j===i?{...r,...p}:r));
      try {
        upd({status:"reading",detail:"reading…"});
        const b64=await readB64(arr[i]);
        upd({status:"extracting",detail:"AI extracting…"});
        const ex=await aiExtract(b64,"firc");
        const fircNumber=(ex.number||"").trim();
        if (fircNumber) {
          const normFirc = v => String(v||"").trim().toUpperCase().replace(/[^A-Z0-9]/g,"");
          const existing=data.fircs.find(f=>normFirc(f.number)===normFirc(fircNumber));
          if (existing){upd({status:"skipped",detail:`FIRC ${fircNumber} already uploaded — skipped`});continue;}
        }
        upd({status:"saving",detail:"saving…"});
        const id=uid();
        await docs.set(`firc:${id}`,b64,"application/pdf");
        await onAdd({id,number:fircNumber,date:ex.date||"",amount:String(ex.amount||""),hasPdf:true});
        upd({status:"done",detail:fircNumber||"saved"});
      } catch(e){upd({status:"error",detail:e.message});}
    }
    busyRef.current=false;
    if(fileRef.current) fileRef.current.value="";
  }

  async function addManualFirc() {
    learner.track("firc:manual:save");
    const number=(manualVals.number||"").trim();
    const explicitAmount=+String(manualVals.amount||"").replace(/,/g,"");
    const foreignAmount=+String(manualVals.foreignAmount||"").replace(/,/g,"");
    const exchangeRate=+String(manualVals.exchangeRate||"").replace(/,/g,"");
    const charges=+String(manualVals.charges||"").replace(/,/g,"")||0;
    const derivedAmount=foreignAmount>0&&exchangeRate>0?Math.max(0,Math.round((foreignAmount*exchangeRate-charges)*100)/100):0;
    const amount=String(explicitAmount>0?explicitAmount:derivedAmount);
    if (!number || !manualVals.date || !(+amount>0)) {
      alert("Add FIRC/reference number, date, and INR amount — or foreign amount with exchange rate.");
      return;
    }
    const normFirc = v => String(v||"").trim().toUpperCase().replace(/[^A-Z0-9]/g,"");
    const existing=data.fircs.find(f=>normFirc(f.number)===normFirc(number));
    if (existing) {
      alert(`FIRC ${number} already exists.`);
      return;
    }
    await onAdd({
      ...manualVals,
      id:uid(),
      number,
      amount,
      hasPdf:false,
      manual:true,
      thirdParty:!!manualVals.thirdParty,
    });
    setManualVals(emptyManualFirc());
    setManualOpen(false);
  }

  // Build list with utilisation
  let list = data.fircs.map(f=>{
    const used=fircUsed(f.id), amt=+f.amount||0;
    const pct=amt?Math.min(100,(used/amt)*100):0;
    const cnt=data.shippingBills.filter(sb=>sb.fircId===f.id).length;
    return {...f, _used:used, _rem:amt-used, _pct:pct, _cnt:cnt};
  });

  // search
  if (search) list=list.filter(f=>(f.number||"").toLowerCase().includes(search.toLowerCase()));
  // filter by utilisation
  if (filterUtil==="full")    list=list.filter(f=>f._pct>=98);
  if (filterUtil==="partial") list=list.filter(f=>f._pct>0&&f._pct<98);
  if (filterUtil==="empty")   list=list.filter(f=>f._pct===0&&f._cnt===0);
  // sort
  list.sort((a,b)=>{
    if (sortBy==="date-asc")  return new Date(a.date||0)-new Date(b.date||0);
    if (sortBy==="date-desc") return new Date(b.date||0)-new Date(a.date||0);
    if (sortBy==="az")        return (a.number||"").localeCompare(b.number||"");
    if (sortBy==="za")        return (b.number||"").localeCompare(a.number||"");
    if (sortBy==="amt-hi")    return (+b.amount||0)-(+a.amount||0);
    if (sortBy==="amt-lo")    return (+a.amount||0)-(+b.amount||0);
    if (sortBy==="util-hi")   return b._pct-a._pct;
    if (sortBy==="util-lo")   return a._pct-b._pct;
    return 0;
  });

  const busy = log.some(r=>["queued","reading","extracting","saving"].includes(r.status));
  const activeFilters = filterUtil!=="all"?1:0;

  const SORT_OPTS=[
    {v:"date-asc", l:"Date ↑"},{v:"date-desc",l:"Date ↓"},
    {v:"az",       l:"A → Z"}, {v:"za",        l:"Z → A"},
    {v:"amt-hi",   l:"Amount ↓"},{v:"amt-lo",  l:"Amount ↑"},
    {v:"util-hi",  l:"Util ↓"},{v:"util-lo",   l:"Util ↑"},
  ];

  return (
    <div style={{maxWidth:900}}>
      <PH title="FIRCs" sub={`${data.fircs.length} loaded · click to see attached SBs`}/>
      <DropZone label="Upload FIRC PDFs" multi disabled={busy} fileRef={fileRef} onFiles={handleFiles}/>
      <div style={{marginTop:-6,marginBottom:14}}>
        <button className="pr" onClick={()=>setManualOpen(v=>!v)}
          style={{...S.btnGhost,width:"100%",padding:"9px 12px",fontSize:12,display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
          {manualOpen?"Close manual entry":"＋ Add FIRC manually"}
        </button>
        {manualOpen&&(
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,padding:14,marginTop:8}}>
            <div style={{fontSize:12,fontWeight:700,color:C.ink,marginBottom:4}}>Manual FIRC / wire receipt</div>
            <div style={{fontSize:11.5,color:C.inkMid,lineHeight:1.5,marginBottom:12}}>
              Use this when the client paid by direct wire and you only have a bank reference, not a FIRC PDF. It can still be matched to SBs.
            </div>
            <div style={{display:"grid",gridTemplateColumns:mob?"1fr":"1.2fr .8fr .8fr",gap:8,marginBottom:8}}>
              <div>
                <div style={{fontSize:10,color:C.inkMid,marginBottom:3}}>IRM / FIRC / bank reference</div>
                <input value={manualVals.number} onChange={e=>setManualVals(v=>({...v,number:e.target.value}))} placeholder="e.g. WIRE-BOFA-2026-001"
                  style={{width:"100%",border:`1.5px solid ${C.border}`,borderRadius:8,padding:"8px 10px",fontSize:13,boxSizing:"border-box"}}/>
              </div>
              <div>
                <div style={{fontSize:10,color:C.inkMid,marginBottom:3}}>Date received</div>
                <input type="date" value={manualVals.date} onChange={e=>setManualVals(v=>({...v,date:e.target.value}))}
                  style={{width:"100%",border:`1.5px solid ${C.border}`,borderRadius:8,padding:"8px 10px",fontSize:13,boxSizing:"border-box"}}/>
              </div>
              <div>
                <div style={{fontSize:10,color:C.inkMid,marginBottom:3}}>Amount (₹)</div>
                <input type="number" inputMode="decimal" value={manualVals.amount} onChange={e=>setManualVals(v=>({...v,amount:e.target.value}))} placeholder="0"
                  style={{width:"100%",border:`1.5px solid ${C.border}`,borderRadius:8,padding:"8px 10px",fontSize:13,boxSizing:"border-box"}}/>
              </div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:mob?"1fr":"1fr .5fr .7fr .7fr",gap:8,marginBottom:8}}>
              <div>
                <div style={{fontSize:10,color:C.inkMid,marginBottom:3}}>Foreign amount</div>
                <input type="number" inputMode="decimal" value={manualVals.foreignAmount} onChange={e=>setManualVals(v=>({...v,foreignAmount:e.target.value}))} placeholder="0"
                  style={{width:"100%",border:`1.5px solid ${C.border}`,borderRadius:8,padding:"8px 10px",fontSize:13,boxSizing:"border-box"}}/>
              </div>
              <div>
                <div style={{fontSize:10,color:C.inkMid,marginBottom:3}}>Currency</div>
                <select value={manualVals.currency} onChange={e=>setManualVals(v=>({...v,currency:e.target.value}))}
                  style={{width:"100%",border:`1.5px solid ${C.border}`,borderRadius:8,padding:"8px 10px",fontSize:13,boxSizing:"border-box",background:C.bg,color:C.ink}}>
                  {["USD","EUR","GBP","JPY","AUD","CAD","INR"].map(c=><option key={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <div style={{fontSize:10,color:C.inkMid,marginBottom:3}}>Exchange rate</div>
                <input type="number" inputMode="decimal" value={manualVals.exchangeRate} onChange={e=>setManualVals(v=>({...v,exchangeRate:e.target.value}))} placeholder="83.25"
                  style={{width:"100%",border:`1.5px solid ${C.border}`,borderRadius:8,padding:"8px 10px",fontSize:13,boxSizing:"border-box"}}/>
              </div>
              <div>
                <div style={{fontSize:10,color:C.inkMid,marginBottom:3}}>Charges (₹)</div>
                <input type="number" inputMode="decimal" value={manualVals.charges} onChange={e=>setManualVals(v=>({...v,charges:e.target.value}))} placeholder="0"
                  style={{width:"100%",border:`1.5px solid ${C.border}`,borderRadius:8,padding:"8px 10px",fontSize:13,boxSizing:"border-box"}}/>
              </div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:mob?"1fr":"1fr 1fr",gap:8,marginBottom:8}}>
              <div>
                <div style={{fontSize:10,color:C.inkMid,marginBottom:3}}>Buyer / client</div>
                <input value={manualVals.buyerName} onChange={e=>setManualVals(v=>({...v,buyerName:e.target.value}))} placeholder="Buyer on invoice"
                  style={{width:"100%",border:`1.5px solid ${C.border}`,borderRadius:8,padding:"8px 10px",fontSize:13,boxSizing:"border-box"}}/>
              </div>
              <div>
                <div style={{fontSize:10,color:C.inkMid,marginBottom:3}}>Sender / remitter</div>
                <input value={manualVals.remitterName} onChange={e=>setManualVals(v=>({...v,remitterName:e.target.value}))} placeholder="Party sending the money"
                  style={{width:"100%",border:`1.5px solid ${C.border}`,borderRadius:8,padding:"8px 10px",fontSize:13,boxSizing:"border-box"}}/>
              </div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:mob?"1fr":"1fr 1fr",gap:8,marginBottom:8}}>
              <div>
                <div style={{fontSize:10,color:C.inkMid,marginBottom:3}}>Bank name</div>
                <input value={manualVals.bankName} onChange={e=>setManualVals(v=>({...v,bankName:e.target.value}))} placeholder="Receiving bank"
                  style={{width:"100%",border:`1.5px solid ${C.border}`,borderRadius:8,padding:"8px 10px",fontSize:13,boxSizing:"border-box"}}/>
              </div>
              <div>
                <div style={{fontSize:10,color:C.inkMid,marginBottom:3}}>Bank account credited</div>
                <input value={manualVals.bankAccount} onChange={e=>setManualVals(v=>({...v,bankAccount:e.target.value}))} placeholder="Account nickname or last 4"
                  style={{width:"100%",border:`1.5px solid ${C.border}`,borderRadius:8,padding:"8px 10px",fontSize:13,boxSizing:"border-box"}}/>
              </div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:mob?"1fr":"1fr 1fr 1fr",gap:8,marginBottom:8}}>
              <div>
                <div style={{fontSize:10,color:C.inkMid,marginBottom:3}}>Purpose code</div>
                <input value={manualVals.purposeCode} onChange={e=>setManualVals(v=>({...v,purposeCode:e.target.value}))} placeholder="P0102"
                  style={{width:"100%",border:`1.5px solid ${C.border}`,borderRadius:8,padding:"8px 10px",fontSize:13,boxSizing:"border-box"}}/>
              </div>
              <div>
                <div style={{fontSize:10,color:C.inkMid,marginBottom:3}}>SWIFT / UTR / txn ref</div>
                <input value={manualVals.transactionRef} onChange={e=>setManualVals(v=>({...v,transactionRef:e.target.value}))} placeholder="Transaction reference"
                  style={{width:"100%",border:`1.5px solid ${C.border}`,borderRadius:8,padding:"8px 10px",fontSize:13,boxSizing:"border-box"}}/>
              </div>
              <div>
                <div style={{fontSize:10,color:C.inkMid,marginBottom:3}}>Evidence type</div>
                <select value={manualVals.evidenceType} onChange={e=>setManualVals(v=>({...v,evidenceType:e.target.value}))}
                  style={{width:"100%",border:`1.5px solid ${C.border}`,borderRadius:8,padding:"8px 10px",fontSize:13,boxSizing:"border-box",background:C.bg,color:C.ink}}>
                  {["Bank reference","Wire advice","Bank statement","Email confirmation","Manual only"].map(x=><option key={x}>{x}</option>)}
                </select>
              </div>
            </div>
            <label style={{display:"flex",alignItems:"center",gap:7,fontSize:12,color:C.inkMid,marginBottom:10,cursor:"pointer",userSelect:"none"}}>
              <input type="checkbox" checked={!!manualVals.thirdParty} onChange={e=>setManualVals(v=>({...v,thirdParty:e.target.checked}))} style={{width:14,height:14,accentColor:C.gold,cursor:"pointer"}}/>
              Payment sender is different from buyer
            </label>
            <div style={{marginBottom:10}}>
              <div style={{fontSize:10,color:C.inkMid,marginBottom:3}}>Notes</div>
              <input value={manualVals.notes} onChange={e=>setManualVals(v=>({...v,notes:e.target.value}))} placeholder="Any extra bank note, invoice group, or follow-up needed"
                style={{width:"100%",border:`1.5px solid ${C.border}`,borderRadius:8,padding:"8px 10px",fontSize:13,boxSizing:"border-box"}}/>
            </div>
            <button className="pr" onClick={addManualFirc} style={{...S.btnDark,width:"100%",padding:"10px",fontSize:13}}>Save manual FIRC</button>
          </div>
        )}
      </div>
      {log.length>0&&<LogList log={log} onClear={()=>setLog([])} busy={busy}/>}

      {data.fircs.length>0&&(
        <div style={{marginBottom:10}}>
          {/* Search + filter toggle */}
          <div style={{display:"flex",gap:7,marginBottom:7}}>
            <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="🔍  Search FIRC number…"
              style={{flex:1,border:`1.5px solid ${C.border}`,borderRadius:9,padding:"8px 11px",fontSize:13,minWidth:0,boxSizing:"border-box"}}/>
            <button className="pr" onClick={()=>setShowFilters(f=>!f)}
              style={{...S.btnGhost,padding:"8px 12px",fontSize:12,flexShrink:0,
                borderColor:activeFilters>0?C.gold:C.border,color:activeFilters>0?C.amber:C.inkMid}}>
              ⚙{activeFilters>0?` (${activeFilters})`:""}
            </button>
          </div>
          {/* Sort pills */}
          <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:showFilters?8:0}}>
            {SORT_OPTS.map(o=>(
              <button key={o.v} className="pr" onClick={()=>setSortBy(o.v)}
                style={{background:sortBy===o.v?C.ink:C.card,color:sortBy===o.v?C.surface:C.inkMid,
                  border:"none",borderRadius:20,padding:"4px 11px",fontSize:11,cursor:"pointer",fontWeight:sortBy===o.v?600:400}}>
                {o.l}
              </button>
            ))}
          </div>
          {/* Filter panel */}
          {showFilters&&(
            <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,padding:"12px 12px 8px",marginTop:6}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                <span style={{fontSize:11,color:C.inkMid,width:52,flexShrink:0}}>Utilisation</span>
                <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                  {[["all","All"],["full","Full (≥98%)"],["partial","Partial"],["empty","Empty"]].map(([v,l])=>(
                    <button key={v} className="pr" onClick={()=>setFilterUtil(v)}
                      style={{background:filterUtil===v?C.ink:C.card,color:filterUtil===v?C.surface:C.inkMid,
                        border:"none",borderRadius:20,padding:"3px 10px",fontSize:11,cursor:"pointer",fontWeight:filterUtil===v?600:400}}>
                      {l}
                    </button>
                  ))}
                </div>
              </div>
              {activeFilters>0&&<button className="pr" onClick={()=>setFilterUtil("all")} style={{...S.btnGhost,fontSize:11,padding:"4px 10px"}}>✕ Clear</button>}
            </div>
          )}
          {(search||activeFilters>0)&&<div style={{fontSize:11,color:C.inkMid,marginTop:6}}>{list.length} of {data.fircs.length} shown</div>}
        </div>
      )}

      {data.fircs.length===0?<Empty icon="💵" text="Upload FIRC PDFs to get started"/>:
       list.length===0?<Empty icon="🔍" text="No FIRCs match your filters"/>:
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(380px,1fr))",gap:10}}>{list.map(f=>{
          const isEdit=editId===f.id;
          return (
            <div key={f.id} className="ri" style={{cursor:isEdit?"default":"pointer"}}
              onClick={()=>{ if(!isEdit) setSheet({type:"fircDetail",payload:f.id}); }}>
              {isEdit?(
                <div onClick={e=>e.stopPropagation()}>
                  <div style={{fontSize:11,fontWeight:600,color:C.ink,marginBottom:10}}>Edit FIRC</div>
                  {[["FIRC Number","number","text"],["Date","date","date"],["Amount (₹)","amount","number"],["Foreign Amount","foreignAmount","number"],["Currency","currency","text"],["Exchange Rate","exchangeRate","number"],["Bank Name","bankName","text"],["Account Credited","bankAccount","text"],["Buyer / Client","buyerName","text"],["Sender / Remitter","remitterName","text"],["Purpose Code","purposeCode","text"],["Transaction Ref","transactionRef","text"],["Charges (₹)","charges","number"],["Evidence Type","evidenceType","text"],["Notes","notes","text"]].map(([lbl,k,t])=>(
                    <div key={k} style={{marginBottom:8,display:k==="notes"?"block":"inline-block",width:k==="notes"?"100%":mob?"100%":"calc(50% - 4px)",marginRight:k==="notes"?0:8,verticalAlign:"top"}}>
                      <div style={{fontSize:10,color:C.inkMid,marginBottom:3}}>{lbl}</div>
                      <input type={t} value={editVals[k]||""} onChange={e=>setEditVals(v=>({...v,[k]:e.target.value}))}
                        style={{width:"100%",border:`1.5px solid ${C.borderHi}`,borderRadius:7,padding:"8px 10px",fontSize:13,background:C.bg,boxSizing:"border-box"}}/>
                    </div>
                  ))}
                  <label style={{display:"flex",alignItems:"center",gap:7,fontSize:12,color:C.inkMid,marginTop:2,cursor:"pointer",userSelect:"none"}}>
                    <input type="checkbox" checked={!!editVals.thirdParty} onChange={e=>setEditVals(v=>({...v,thirdParty:e.target.checked}))} style={{width:14,height:14,accentColor:C.gold,cursor:"pointer"}}/>
                    Payment sender is different from buyer
                  </label>
                  <div style={{display:"flex",gap:8,marginTop:12}}>
                    <button className="pr" onClick={async()=>{await onUpdate(f.id,editVals);setEditId(null);}} style={{...S.btnDark,flex:1,padding:"9px",fontSize:13}}>Save</button>
                    <button className="pr" onClick={()=>setEditId(null)} style={{...S.btnGhost,padding:"9px"}}>Cancel</button>
                  </div>
                </div>
              ):(
                <>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                        <div style={{fontWeight:700,fontSize:14,color:C.ink}}>{f.number||<Warn text="No number"/>}</div>
                        {!f.hasPdf&&<span style={{fontSize:10,padding:"1px 7px",borderRadius:20,background:C.amberBg,color:C.amber,fontWeight:600}}>Manual</span>}
                      </div>
                      <div style={{fontSize:11,color:C.inkMid,marginTop:2}}>{fd(f.date)} · {f._cnt} SB{f._cnt!==1?"s":""} · {fc(f._used)} used</div>
                      {(f.buyerName||f.remitterName)&&<div style={{fontSize:10.5,color:C.inkFaint,marginTop:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{f.buyerName?`Buyer: ${f.buyerName}`:""}{f.buyerName&&f.remitterName?" · ":""}{f.remitterName?`Sender: ${f.remitterName}`:""}</div>}
                      {(f.foreignAmount||f.currency||f.purposeCode)&&<div style={{fontSize:10.5,color:C.inkFaint,marginTop:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{f.foreignAmount?`${f.currency||""} ${f.foreignAmount}`:""}{f.foreignAmount&&f.exchangeRate?` @ ${f.exchangeRate}`:""}{f.purposeCode?`${f.foreignAmount?" · ":""}${f.purposeCode}`:""}{f.thirdParty?" · Third-party payer":""}</div>}
                      {f.notes&&<div style={{fontSize:10.5,color:C.inkFaint,marginTop:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{f.notes}</div>}
                    </div>
                    <div style={{display:"flex",gap:5,flexShrink:0,marginLeft:8}} onClick={e=>e.stopPropagation()}>
                      {f.hasPdf&&<Btn ghost small onClick={()=>showPdf(`firc:${f.id}`,f.number||"FIRC")}>👁</Btn>}
                      <Btn ghost small onClick={()=>{setEditId(f.id);setEditVals({...emptyManualFirc(),...f});}}>✏</Btn>
                      <Btn danger small onClick={()=>onDelete(f.id)}>🗑</Btn>
                    </div>
                  </div>
                  <div style={{display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:7}}>
                    <span style={{fontWeight:600,color:C.ink}}>{fc(f.amount)}</span>
                    <span style={{color:f._rem>=0?C.green:C.red,fontWeight:500}}>{fc(f._rem)} left</span>
                  </div>
                  <div style={{height:6,background:C.card,borderRadius:3}}>
                    <div style={{width:`${f._pct}%`,height:"100%",background:f._pct>98?C.greenBright:C.gold,borderRadius:3,transition:"width 0.4s"}}/>
                  </div>
                  {/* Mini SB type breakdown */}
                  {f._cnt>0&&(()=>{
                    const sbs=data.shippingBills.filter(sb=>sb.fircId===f.id);
                    const byType={commercial:0,csb:0,pbe:0};
                    sbs.forEach(sb=>{byType[detectSbType(sb)]=(byType[detectSbType(sb)]||0)+1;});
                    return (
                      <div style={{display:"flex",gap:5,marginTop:7,flexWrap:"wrap"}}>
                        {Object.entries(byType).filter(([,n])=>n>0).map(([t,n])=>{
                          const ts=SB_TYPE_STYLE[t];
                          return <span key={t} style={{fontSize:10,padding:"1px 7px",borderRadius:20,background:ts.bg,color:ts.color}}>{n} {ts.label}</span>;
                        })}
                        <span style={{fontSize:10,color:C.inkMid,marginLeft:"auto"}}>tap for details →</span>
                      </div>
                    );
                  })()}
                </>
              )}
            </div>
          );
        })}</div>
      }
      {data.fircs.length>1&&(
        <button className="pr" onClick={()=>{ if(confirm(`Delete ALL ${data.fircs.length} FIRCs? All SB matches will be cleared.`)) [...data.fircs].forEach(f=>onDelete(f.id)); }}
          style={{...S.btnDanger,marginTop:10,fontSize:12}}>🗑 Delete all FIRCs</button>
      )}
    </div>
  );
}

/* ══ FIRC DETAIL SHEET ═══════════════════════════════════════════ */
function FircDetailSheet({ fircId, getData, fircUsed, showPdf, onGen, genId, pdfReady, pdfErr, onUnlink, onDeleteSb, onUpdateFirc }) {
  const [removed, setRemoved] = useState(new Set()); // locally hidden after action
  const [fircUp, setFircUp]   = useState(false);
  const [fircErr, setFircErr] = useState(null);
  const [fircHasLocal, setFircHasLocal] = useState(null); // optimistic flag after re-upload
  const d    = getData();
  const firc = d.fircs.find(f=>f.id===fircId);
  if (!firc) return <div style={{padding:20,color:C.inkMid}}>FIRC not found.</div>;
  const fircHasPdf = fircHasLocal!==null ? fircHasLocal : (firc.hasPdf || docs.hasCloud(`firc:${fircId}`));
  async function reuploadFirc(files){
    const file=files[0]; if(!file)return;
    setFircUp(true); setFircErr(null);
    try{
      const {b64,mime}=await readB64WithMime(file);
      await docs.set(`firc:${fircId}`, b64, mime);
      if(onUpdateFirc) await onUpdateFirc(fircId,{hasPdf:true});
      setFircHasLocal(true);
    }catch(e){ setFircErr(e.message); }
    setFircUp(false);
  }

  const sbs   = d.shippingBills.filter(sb=>sb.fircId===fircId&&!removed.has(sb.id)).sort((a,b)=>new Date(a.date)-new Date(b.date));
  const used  = fircUsed(fircId);
  const amt   = +firc.amount||0;
  const rem   = amt-used;
  const pct   = amt?Math.min(100,Math.round((used/amt)*100)):0;

  // Per-status breakdown
  const byStatus = {};
  sbs.forEach(sb=>{ const s=sb.status||"pending"; byStatus[s]=(byStatus[s]||0)+1; });

  return (
    <div>
      {/* Header */}
      <div style={{marginBottom:16}}>
        <div style={{fontFamily:FONT,fontSize:22,fontWeight:700,letterSpacing:"-.01em",color:C.ink}}>{firc.number||"FIRC"}</div>
        <div style={{fontSize:12,color:C.inkMid,marginTop:3}}>{fd(firc.date)}</div>
      </div>

      {/* FIRC document — view / re-attach */}
      <div className="ri" style={{marginBottom:12,border:`1px solid ${fircHasPdf?C.border:C.amber}`}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:6}}>
          <div>
            <div style={{fontSize:13,fontWeight:600,color:C.inkMid}}>FIRC document</div>
            <div style={{fontSize:11,color:fircHasPdf?C.inkMid:C.amber}}>{fircHasPdf?"PDF on file · re-upload to replace":"No file attached — upload the FIRC PDF"}</div>
          </div>
          {fircHasPdf&&<span style={{fontSize:11,color:C.green,background:C.greenBg,padding:"2px 8px",borderRadius:12}}>✓</span>}
        </div>
        {fircErr&&<div style={{fontSize:11,color:C.red,background:C.redBg,borderRadius:6,padding:"4px 8px",marginBottom:6,wordBreak:"break-all"}}>Error: {fircErr}</div>}
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          <InlineUpload label={fircHasPdf?"Replace FIRC":"Upload FIRC"} uploading={fircUp} onFiles={reuploadFirc} imagesOk={true}/>
          {fircHasPdf&&<button className="pr" onClick={()=>showPdf(`firc:${fircId}`,`FIRC ${firc.number||""}`)} style={{...S.btnGhost,padding:"7px 10px",fontSize:11}}>View</button>}
        </div>
      </div>

      {/* Amount summary card */}
      <div style={{background:C.card,borderRadius:10,padding:"13px 14px",marginBottom:12}}>
        <div style={{display:"flex",justifyContent:"space-between",marginBottom:10}}>
          {[
            {l:"Total",  v:fc(amt),  c:C.ink},
            {l:"Used",   v:fc(used), c:C.green},
            {l:"Remaining",v:fc(rem),c:rem<0?C.red:C.inkMid},
          ].map(x=>(
            <div key={x.l} style={{textAlign:"center",flex:1}}>
              <div style={{fontSize:15,fontWeight:700,color:x.c}}>{x.v}</div>
              <div style={{fontSize:10,color:C.inkMid,marginTop:2}}>{x.l}</div>
            </div>
          ))}
        </div>
        <div style={{height:8,background:C.card,borderRadius:4}}>
          <div style={{width:`${pct}%`,height:"100%",background:pct>98?C.greenBright:C.gold,borderRadius:4,transition:"width 0.5s"}}/>
        </div>
        <div style={{fontSize:11,color:C.inkMid,textAlign:"right",marginTop:4}}>{pct}% utilised · {sbs.length} SBs</div>
      </div>

      {/* Status breakdown */}
      {sbs.length>0&&(
        <div style={{display:"flex",gap:6,marginBottom:12,flexWrap:"wrap"}}>
          {Object.entries(byStatus).map(([st,n])=>{
            const ss=STATUS_STYLE[st]||STATUS_STYLE.pending;
            return <span key={st} style={{background:ss.bg,color:ss.color,fontSize:11,fontWeight:600,padding:"3px 10px",borderRadius:20}}>{n} {ss.label}</span>;
          })}
        </div>
      )}

      {/* SB list */}
      {sbs.length===0
        ?<Empty icon="🔗" text="No SBs matched to this FIRC yet"/>
        :<>
          <SecTitle>{sbs.length} Shipping Bill{sbs.length!==1?"s":""} attached</SecTitle>
          {sbs.map((sb,i)=>{
            const ts=SB_TYPE_STYLE[detectSbType(sb)];
            const ss=STATUS_STYLE[sb.status||"pending"];
            const isGen=genId===sb.id;
            const sbAmt=+sb.amount||0;
            const pctOfFirc=used?Math.round((sbAmt/used)*100):0;
            return (
              <div key={sb.id} style={{background:C.surface,borderRadius:10,padding:"12px 13px",marginBottom:7,border:`1px solid ${C.border}`}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:6}}>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                      <span style={{fontSize:12,fontWeight:700,color:C.ink}}>#{i+1} {sb.sbNumber}</span>
                      <span style={{fontSize:10,padding:"1px 7px",borderRadius:20,background:ts.bg,color:ts.color,fontWeight:600}}>{ts.label}</span>
                    </div>
                    <div style={{fontSize:11,color:C.inkMid,marginTop:2}}>{fd(sb.date)}</div>
                  </div>
                  <div style={{textAlign:"right",flexShrink:0}}>
                    <div style={{fontWeight:700,fontSize:13,color:C.ink}}>{fc(sbAmt)}</div>
                    <div style={{fontSize:10,color:C.inkMid,marginTop:1}}>{pctOfFirc}% of used</div>
                  </div>
                </div>
                {/* Thin amount bar */}
                <div style={{height:4,background:C.card,borderRadius:2,marginBottom:6}}>
                  <div style={{width:`${Math.min(100,pctOfFirc)}%`,height:"100%",background:C.gold,borderRadius:2}}/>
                </div>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <span style={{background:ss.bg,color:ss.color,fontSize:10,fontWeight:600,padding:"2px 8px",borderRadius:20}}>{ss.label}</span>
                  <div style={{display:"flex",gap:5}}>
                    <button className="pr" onClick={()=>showPdf(`sb:${sb.id}`,`SB ${sb.sbNumber}`)}
                      style={{...S.btnGhost,padding:"4px 8px",fontSize:11}}>View</button>
                    <button className="pr" disabled={isGen||!pdfReady} onClick={()=>onGen(sb.id)}
                      style={{...S.btnDark,padding:"4px 8px",fontSize:11,opacity:(isGen||!pdfReady)?0.6:1,display:"flex",alignItems:"center",gap:4}}>
                      {isGen?<><Spin/>…</>:"📥"}
                    </button>
                    <button className="pr" onClick={()=>{setRemoved(r=>new Set(r).add(sb.id));onUnlink(sb.id);}}
                      style={{background:C.amberBg,color:C.amber,border:`1px solid ${C.amber}`,borderRadius:7,padding:"4px 8px",fontSize:11,cursor:"pointer"}}
                      title="Unlink from this FIRC">⇤</button>
                    <button className="pr" onClick={()=>{if(confirm(`Delete SB ${sb.sbNumber}? This cannot be undone.`)){setRemoved(r=>new Set(r).add(sb.id));onDeleteSb(sb.id);}}}
                      style={{...S.btnDel,borderRadius:7,padding:"4px 8px",fontSize:11}}
                      title="Delete SB entirely">🗑</button>
                  </div>
                </div>
              </div>
            );
          })}
          {/* Total row */}
          <div style={{background:C.ink,borderRadius:12,padding:"11px 14px",display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:4}}>
            <span style={{color:C.surface,opacity:.6,fontSize:12}}>Total matched</span>
            <span className="tnum" style={{color:C.surface,fontWeight:700,fontSize:14}}>{fc(used)}</span>
          </div>
        </>
      }
    </div>
  );
}

/* ══ SB TYPE DETECTION ═══════════════════════════════════════════
   PBE (Personal Baggage Export / Postal Baggage Export) SBs in
   ICEGATE have numbers that typically contain "PBE" or start with
   known prefixes. Commercial SBs are standard 7-digit numbers.
   We auto-detect but let the user flip the type manually.
════════════════════════════════════════════════════════════════ */
function detectSbType(sb) {
  if (sb.sbType && ["pbe","csb","commercial"].includes(sb.sbType)) return sb.sbType;
  // Fallback heuristics if sbType not stored
  const n = (sb.sbNumber || "").toUpperCase();
  if (n.startsWith("CSBV") || n.startsWith("CSB")) return "csb";
  if (n.startsWith("PBE")) return "pbe";
  return "commercial";
}
const SB_TYPE_STYLE = {
  commercial: { bg:C.blueBg,   color:C.blue,   label:"Commercial SB" },
  csb:        { bg:C.purpleBg, color:C.purple, label:"CSB-V"         },
  pbe:        { bg:C.tealBg,   color:C.teal,   label:"PBE"           },
};
const SB_TYPE_NEXT = { commercial:"csb", csb:"pbe", pbe:"commercial" };

/* ══ SBs VIEW ════════════════════════════════════════════════════ */
function SBsView({ data, onAdd, onDelete, onPatch, onCycle, setSheet, onGen, genId, hasFema, pdfReady, pdfErr, showPdf }) {
  const [log,        setLog]      = useState([]);
  const [search,     setSearch]   = useState("");
  const [sortBy,     setSortBy]   = useState("date-asc");   // date-asc date-desc az za amt-hi amt-lo
  const [filterType, setFilterType]= useState("all");        // all commercial pbe
  const [filterStatus,setFilterStatus]=useState("all");      // all pending prepared submitted cleared rejected
  const [filterMatch,setFilterMatch]=useState("all");        // all matched unmatched
  const [selecting,  setSelecting]= useState(false);
  const [selected,   setSelected] = useState(new Set());
  const [showFilters,setShowFilters]=useState(false);
  const busyRef = useRef(false);
  const fileRef = useRef();

  async function handleFiles(files) {
    if (busyRef.current) return;
    busyRef.current=true;
    const arr=Array.from(files);
    learner.track("sb:upload",{count:arr.length});
    setLog(arr.map(f=>({name:f.name,status:"queued",detail:""})));
    for (let i=0;i<arr.length;i++) {
      const file=arr[i], hint=sbNumFromFilename(file.name);
      const upd=p=>setLog(l=>l.map((r,j)=>j===i?{...r,...p}:r));
      try {
        upd({status:"reading",detail:"reading…"});
        const b64=await readB64(file);
        upd({status:"extracting",detail:"AI extracting…"});
        let ex={};
        try{ex=await aiExtract(b64,"sb");}
        catch(e){upd({detail:`AI failed — using filename (${e.message.slice(0,50)})`});ex={sbNumber:hint};}
        const sbNumber=ex.sbNumber||hint;
        const existing=data.shippingBills.find(sb=>normSbNum(sb.sbNumber)===normSbNum(sbNumber));
        if (existing){upd({status:"skipped",detail:`Duplicate of SB ${existing.sbNumber} (normalised match) — skipped`});continue;}
        upd({status:"saving",detail:"saving…"});
        const id=uid();
        await docs.set(`sb:${id}`,b64,"application/pdf");
        // Use AI-detected docType; fall back to filename heuristic
        const rawType = (ex.docType||"").toLowerCase();
        const sbType = rawType==="pbe" ? "pbe" : rawType==="csb" ? "csb" : "commercial";
        await onAdd({id,sbNumber,date:ex.date||"",amount:String(ex.amount||""),fircId:null,status:"pending",sbType,hasSbPdf:true,hasInvPdf:false,hasHawbPdf:false,hasErfPdf:false,hasBrcPdf:false});
        upd({status:"done",detail:`${sbNumber} (${sbType.toUpperCase()})`});
      } catch(e){upd({status:"error",detail:e.message});}
    }
    busyRef.current=false;
    if(fileRef.current) fileRef.current.value="";
  }

  // ── Sort + filter pipeline ──
  let list=[...data.shippingBills];
  // filter
  if (search)          list=list.filter(sb=>(sb.sbNumber||"").toLowerCase().includes(search.toLowerCase()));
  if (filterType!=="all")  list=list.filter(sb=>detectSbType(sb)===filterType);
  if (filterStatus!=="all")list=list.filter(sb=>(sb.status||"pending")===filterStatus);
  if (filterMatch==="matched")   list=list.filter(sb=>sb.fircId);
  if (filterMatch==="unmatched") list=list.filter(sb=>!sb.fircId);
  // sort
  list.sort((a,b)=>{
    if (sortBy==="date-asc")  return new Date(a.date||0)-new Date(b.date||0);
    if (sortBy==="date-desc") return new Date(b.date||0)-new Date(a.date||0);
    if (sortBy==="az")        return (a.sbNumber||"").localeCompare(b.sbNumber||"");
    if (sortBy==="za")        return (b.sbNumber||"").localeCompare(a.sbNumber||"");
    if (sortBy==="amt-hi")    return (+b.amount||0)-(+a.amount||0);
    if (sortBy==="amt-lo")    return (+a.amount||0)-(+b.amount||0);
    return 0;
  });

  const busy      = log.some(r=>["queued","reading","extracting","saving"].includes(r.status));
  const allIds    = new Set(list.map(sb=>sb.id));
  const allSel    = list.length>0&&[...allIds].every(id=>selected.has(id));
  const selCount  = [...selected].filter(id=>allIds.has(id)).length;
  const activeFilters = (filterType!=="all"?1:0)+(filterStatus!=="all"?1:0)+(filterMatch!=="all"?1:0);

  function toggleSelect(id) { setSelected(s=>{const n=new Set(s); n.has(id)?n.delete(id):n.add(id); return n;}); }
  function toggleAll()      { setSelected(allSel?new Set():new Set(list.map(sb=>sb.id))); }

  async function bulkDelete() {
    if (!confirm(`Delete ${selCount} selected SBs?`)) return;
    for (const id of selected) await onDelete(id);
    setSelected(new Set()); setSelecting(false);
  }
  async function bulkDownload() {
    const ids=[...selected].filter(id=>allIds.has(id));
    for (const id of ids) {
      const sb=data.shippingBills.find(x=>x.id===id);
      if (sb) await showPdf(`sb:${id}`,`SB ${sb.sbNumber}`);
    }
  }

  const SORT_OPTS=[
    {v:"date-asc",l:"Date ↑"},{v:"date-desc",l:"Date ↓"},
    {v:"az",l:"A → Z"},{v:"za",l:"Z → A"},
    {v:"amt-hi",l:"Amount ↓"},{v:"amt-lo",l:"Amount ↑"},
  ];

  return (
    <div style={{maxWidth:1100}}>
      <PH title="Shipping Bills" sub={`${data.shippingBills.length} total · click a card for documents`}/>
      <DropZone label="Upload Shipping Bill PDFs" multi disabled={busy} fileRef={fileRef} onFiles={handleFiles}/>
      {log.length>0&&<LogList log={log} onClear={()=>setLog([])} busy={busy}/>}

      {data.shippingBills.length>0&&<>
        {/* ── Search + toolbar ── */}
        <div style={{marginBottom:10}}>
          <div style={{display:"flex",gap:7,marginBottom:7}}>
            <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="🔍  Search SB number…"
              style={{flex:1,border:`1.5px solid ${C.border}`,borderRadius:9,padding:"8px 11px",fontSize:13,minWidth:0}}/>
            <button className="pr" onClick={()=>setShowFilters(f=>!f)}
              style={{...S.btnGhost,padding:"8px 12px",fontSize:12,position:"relative",flexShrink:0,
                borderColor:activeFilters>0?C.gold:C.border,color:activeFilters>0?C.amber:C.inkMid}}>
              ⚙ Filter{activeFilters>0?` (${activeFilters})`:""}
            </button>
            <button className="pr" onClick={()=>{setSelecting(s=>!s);setSelected(new Set());}}
              style={{...S.btnGhost,padding:"8px 12px",fontSize:12,flexShrink:0,
                background:selecting?C.ink:"transparent",color:selecting?C.surface:C.inkMid}}>
              {selecting?"✕ Done":"Select"}
            </button>
          </div>

          {/* ── Sort pills ── */}
          <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:showFilters?8:0}}>
            {SORT_OPTS.map(o=>(
              <button key={o.v} className="pr" onClick={()=>setSortBy(o.v)}
                style={{background:sortBy===o.v?C.ink:C.card,color:sortBy===o.v?C.surface:C.inkMid,
                  border:"none",borderRadius:20,padding:"4px 11px",fontSize:11,cursor:"pointer",fontWeight:sortBy===o.v?600:400}}>
                {o.l}
              </button>
            ))}
          </div>

          {/* ── Filter dropdowns ── */}
          {showFilters&&(
            <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,padding:"12px 12px 8px",marginTop:6}}>
              {[
                {label:"Type",    state:filterType,   set:setFilterType,   opts:[["all","All types"],["commercial","Commercial SB"],["csb","CSB-V"],["pbe","PBE"]]},
                {label:"Status",  state:filterStatus, set:setFilterStatus, opts:[["all","All statuses"],["pending","Pending"],["prepared","Prepared"],["submitted","Submitted"],["cleared","Cleared"],["rejected","Rejected"]]},
                {label:"Match",   state:filterMatch,  set:setFilterMatch,  opts:[["all","All"],["matched","Matched"],["unmatched","Unmatched"]]},
              ].map(({label,state,set,opts})=>(
                <div key={label} style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                  <span style={{fontSize:11,color:C.inkMid,width:46,flexShrink:0}}>{label}</span>
                  <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                    {opts.map(([v,l])=>(
                      <button key={v} className="pr" onClick={()=>set(v)}
                        style={{background:state===v?C.ink:C.card,color:state===v?C.surface:C.inkMid,
                          border:"none",borderRadius:20,padding:"3px 10px",fontSize:11,cursor:"pointer",fontWeight:state===v?600:400}}>
                        {l}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              {activeFilters>0&&<button className="pr" onClick={()=>{setFilterType("all");setFilterStatus("all");setFilterMatch("all");}} style={{...S.btnGhost,fontSize:11,padding:"4px 10px"}}>✕ Clear filters</button>}
            </div>
          )}
        </div>

        {/* ── Bulk select bar ── */}
        {selecting&&(
          <div style={{background:C.ink,borderRadius:12,padding:"10px 12px",marginBottom:10,display:"flex",alignItems:"center",gap:10}}>
            <button className="pr" onClick={toggleAll}
              style={{width:20,height:20,borderRadius:5,border:`2px solid ${C.surface}`,background:allSel?C.gold:"transparent",flexShrink:0,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",color:C.surface,fontSize:12}}>
              {allSel?"✓":""}
            </button>
            <span style={{color:C.surface,fontSize:12,flex:1}}>{selCount>0?`${selCount} selected`:"Tap cards to select"}</span>
            {selCount>0&&<>
              <button className="pr" onClick={bulkDownload} style={{...S.btnGhost,padding:"5px 11px",fontSize:11,background:"transparent",color:C.surface,border:`1px solid ${C.surface}`}}>⬇ Download</button>
              <button className="pr" onClick={bulkDelete}   style={{background:C.redBg,color:C.red,border:"none",borderRadius:7,padding:"5px 11px",fontSize:11,cursor:"pointer"}}>🗑 Delete</button>
            </>}
          </div>
        )}

        {/* ── Results count ── */}
        {(search||activeFilters>0)&&(
          <div style={{fontSize:11,color:C.inkMid,marginBottom:8}}>{list.length} of {data.shippingBills.length} shown</div>
        )}
      </>}

      {data.shippingBills.length===0?<Empty icon="📦" text="Upload Shipping Bill PDFs above"/>:
       list.length===0?<Empty icon="🔍" text="No SBs match your filters"/>:
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(360px,1fr))",gap:10}}>{
        list.map(sb=>{
          const firc=data.fircs.find(f=>f.id===sb.fircId);
          const isGen=genId===sb.id;
          const st=sb.status||"pending";
          const ss=STATUS_STYLE[st];
          const sbType=detectSbType(sb);
          const ts=SB_TYPE_STYLE[sbType];
          const docCount=[sb.hasInvPdf,sb.hasHawbPdf,sb.hasErfPdf].filter(Boolean).length;
          const isSel=selected.has(sb.id);
          return (
            <div key={sb.id} className="ri"
              style={{cursor:"pointer",outline:isSel?`2px solid ${C.gold}`:"none",outlineOffset:1,transition:"outline 0.1s"}}
              onClick={()=>selecting?toggleSelect(sb.id):setSheet({type:"sbDetail",payload:sb.id})}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                <div style={{display:"flex",gap:8,alignItems:"flex-start",flex:1,minWidth:0}}>
                  {/* Checkbox in select mode */}
                  {selecting&&(
                    <div style={{width:18,height:18,borderRadius:5,border:`2px solid ${isSel?C.gold:C.borderHi}`,background:isSel?C.gold:C.surface,flexShrink:0,marginTop:2,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontSize:11}}>
                      {isSel?"✓":""}
                    </div>
                  )}
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                      <span style={{fontWeight:700,fontSize:14,color:C.ink}}>{sb.sbNumber||<Warn text="No number"/>}</span>
                      {/* SB type badge */}
                      <span style={{fontSize:10,padding:"1px 7px",borderRadius:20,background:ts.bg,color:ts.color,fontWeight:600,
                        cursor:"pointer"}} onClick={e=>{e.stopPropagation();onPatch(sb.id,{sbType:SB_TYPE_NEXT[sbType]});}}>
                        {ts.label}
                      </span>
                      {firc?<span className="chip" style={{background:C.greenBg,color:C.green}}>✓ {firc.number}</span>
                           :<span className="chip" style={{background:C.amberBg,color:C.amber}}>Unmatched</span>}
                    </div>
                    <div style={{fontSize:11,color:C.inkMid,marginTop:3}}>{fd(sb.date)} · {fc(sb.amount)}</div>
                  </div>
                </div>
                {!selecting&&(
                  <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:5,flexShrink:0}}>
                    <div style={{display:"flex",gap:5}}>
                      <button className="pr" onClick={e=>{e.stopPropagation();showPdf(`sb:${sb.id}`,`SB ${sb.sbNumber}`);}} style={{...S.btnGhost,padding:"4px 8px",fontSize:11}}>View</button>
                      <button className="pr" onClick={e=>{e.stopPropagation();onDelete(sb.id);}} style={S.btnDel}>✕</button>
                    </div>
                    <button className="pr" onClick={e=>{e.stopPropagation();onCycle(sb.id);}}
                      style={{background:ss.bg,color:ss.color,border:"none",borderRadius:20,padding:"3px 10px",fontSize:10,fontWeight:600,cursor:"pointer",whiteSpace:"nowrap"}}>
                      {ss.label}
                    </button>
                  </div>
                )}
              </div>
              <div style={{display:"flex",gap:4,marginTop:8,flexWrap:"wrap"}}>
                {[["SB",sb.hasSbPdf],["Inv",sb.hasInvPdf],["HAWB",sb.hasHawbPdf],["ERF",sb.hasErfPdf]].map(([lbl,has])=>(
                  <span key={lbl} style={{fontSize:10,padding:"2px 7px",borderRadius:12,background:has?C.greenBg:C.card,color:has?C.green:C.inkMid,border:`1px solid ${has?C.green:C.border}`}}>{has?"✓":"○"} {lbl}</span>
                ))}
                {hasFema&&<span style={{fontSize:10,padding:"2px 7px",borderRadius:12,background:C.greenBg,color:C.green,border:`1px solid ${C.green}`}}>✓ FEMA</span>}
                <span style={{fontSize:10,padding:"2px 7px",borderRadius:12,background:C.card,color:C.inkMid,border:`1px solid ${C.border}`,marginLeft:"auto"}}>{docCount}/3 docs</span>
              </div>
              {!selecting&&firc&&(
                <div style={{marginTop:10,paddingTop:10,borderTop:`1px solid ${C.border}`}}>
                  <button className="pr" disabled={isGen||!pdfReady} onClick={e=>{e.stopPropagation();onGen(sb.id);}}
                    style={{...S.btnDark,width:"100%",display:"flex",alignItems:"center",justifyContent:"center",gap:5,opacity:(isGen||!pdfReady)?0.6:1}}>
                    {isGen?<><Spin/> Generating…</>:!pdfReady&&!pdfErr?<><Spin/> PDF loading…</>:"📥 Generate Packet"}
                  </button>
                </div>
              )}
            </div>
          );
        })}</div>
      }
    </div>
  );
}

/* ══ INVOICES VIEW ═══════════════════════════════════════════════ */
function InvoicesView({ data, onAddInvoice, onPatchInvoice, onDeleteInvoice, onApprove, showPdf, onCreateInvoiceFromSb }) {
  const [log,        setLog]       = useState([]);
  const [filter,     setFilter]    = useState("pending"); // pending approved rejected all
  const [approvingId,setApprovingId]=useState(null); // which inv is open for SB picker
  const [overrideSb, setOverrideSb]= useState("");   // manual SB select in picker
  const busyRef = useRef(false);
  const fileRef = useRef();

  async function handleFiles(files) {
    if (busyRef.current) return;
    busyRef.current = true;
    const arr = Array.from(files);
    learner.track("invoice:upload",{count:arr.length});
    setLog(arr.map(f=>({name:f.name, status:"queued", detail:""})));
    for (let i=0; i<arr.length; i++) {
      const file = arr[i];
      const upd = p => setLog(l=>l.map((r,j)=>j===i?{...r,...p}:r));
      try {
        upd({status:"reading", detail:"reading…"});
        const {b64,mime} = await readB64WithMime(file);
        upd({status:"extracting", detail:"AI extracting…"});
        let ex = {};
        try { ex = await aiExtract(b64, "invoice", mime); }
        catch(e) { upd({detail:`AI failed: ${e.message.slice(0,50)}`}); }

        // Fuzzy-match to SB by amount and/or date
        const invAmt = parseFloat((ex.amount||"").replace(/[^\d.]/g,""))||0;
        const invDate = ex.date||"";
        let suggestedSbId = null, suggestedSbNumber = ex.suggestedSbNumber||"", confidence = "low";

        // First: try exact SB number match if AI found one
        if (suggestedSbNumber) {
          const found = data.shippingBills.find(sb => normSbNum(sb.sbNumber)===normSbNum(suggestedSbNumber));
          if (found) { suggestedSbId = found.id; confidence = "high"; }
        }
        // Second: match by amount within 5% tolerance
        if (!suggestedSbId && invAmt>0) {
          const byAmt = data.shippingBills.filter(sb=>{
            const sbAmt = parseFloat(sb.amount)||0;
            return sbAmt>0 && Math.abs(sbAmt-invAmt)/Math.max(sbAmt,invAmt) < 0.05;
          });
          if (byAmt.length===1) { suggestedSbId=byAmt[0].id; suggestedSbNumber=byAmt[0].sbNumber; confidence="medium"; }
          else if (byAmt.length>1 && invDate) {
            // Narrow by closest date
            byAmt.sort((a,b)=>Math.abs(new Date(a.date)-new Date(invDate))-Math.abs(new Date(b.date)-new Date(invDate)));
            suggestedSbId=byAmt[0].id; suggestedSbNumber=byAmt[0].sbNumber; confidence="medium";
          }
        }

        upd({status:"saving", detail:"saving…"});
        const id = uid();
        await docs.set(`inv-pending:${id}`, b64, mime);
        await onAddInvoice({
          id, filename:file.name,
          invoiceNumber: ex.invoiceNumber||"",
          date: ex.date||"",
          amount: String(ex.amount||""),
          currency: ex.currency||"INR",
          buyerName: ex.buyerName||"",
          description: ex.description||"",
          suggestedSbId, suggestedSbNumber, confidence,
          status: "pending",
        });
        upd({status:"done", detail:`${ex.invoiceNumber||file.name} → ${suggestedSbNumber||"no match"} (${confidence})`});
      } catch(e) { upd({status:"error", detail:e.message}); }
    }
    busyRef.current = false;
    if (fileRef.current) fileRef.current.value="";
  }

  const busy = log.some(r=>["queued","reading","extracting","saving"].includes(r.status));
  const invoices = data.invoices||[];
  const shown = filter==="all" ? invoices : invoices.filter(inv=>inv.status===filter);
  const pendingCount  = invoices.filter(inv=>inv.status==="pending").length;
  const approvedCount = invoices.filter(inv=>inv.status==="approved").length;

  const CONF_STYLE = {
    high:   {bg:C.greenBg,color:C.green,label:"High confidence"},
    medium: {bg:C.amberBg,color:C.amber,label:"Medium confidence"},
    low:    {bg:C.redBg,color:C.red,label:"Low confidence"},
  };

  return (
    <div style={{maxWidth:1000}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:12,flexWrap:"wrap"}}>
        <PH title="Invoices" sub={`${invoices.length} total · ${pendingCount} awaiting review`}/>
        {onCreateInvoiceFromSb&&(
          <button className="pr" onClick={()=>onCreateInvoiceFromSb(blankInvoiceDraft())}
            style={{...S.btnDark,padding:"9px 16px",fontSize:13,display:"flex",alignItems:"center",gap:6,whiteSpace:"nowrap",marginTop:4}}>
            ➕ Create invoice
          </button>
        )}
      </div>
      {onCreateInvoiceFromSb&&<div style={{fontSize:12,color:C.inkMid,margin:"-2px 0 12px"}}>Create a new invoice in the invoice module (correct format, fully editable), or upload existing invoice files below.</div>}
      <DropZone label="Upload Invoice PDFs or Images" multi disabled={busy} fileRef={fileRef} onFiles={handleFiles} imagesOk/>
      {log.length>0 && <LogList log={log} onClear={()=>setLog([])} busy={busy}/>}

      {/* Filter tabs */}
      {invoices.length>0&&(
        <div style={{display:"flex",gap:6,marginBottom:14}}>
          {[
            {v:"pending",  l:`Pending review (${pendingCount})`},
            {v:"approved", l:`Approved (${approvedCount})`},
            {v:"rejected", l:`Rejected (${invoices.filter(i=>i.status==="rejected").length})`},
            {v:"all",      l:`All (${invoices.length})`},
          ].map(o=>(
            <button key={o.v} className="pr" onClick={()=>setFilter(o.v)}
              style={{background:filter===o.v?C.ink:C.card,color:filter===o.v?C.surface:C.inkMid,
                border:"none",borderRadius:20,padding:"5px 14px",fontSize:12,cursor:"pointer",fontWeight:filter===o.v?600:400}}>
              {o.l}
            </button>
          ))}
        </div>
      )}

      {invoices.length===0 ? <Empty icon="🧾" text="Upload invoice PDFs to get started"/> :
       shown.length===0    ? <Empty icon="✅" text="No invoices in this category"/> :
        shown.map(inv=>{
          const linkedSb  = data.shippingBills.find(sb=>sb.id===(inv.linkedSbId||inv.suggestedSbId));
          const sugSb     = data.shippingBills.find(sb=>sb.id===inv.suggestedSbId);
          const cs        = CONF_STYLE[inv.confidence]||CONF_STYLE.low;
          const isPending = inv.status==="pending";
          const isApproving = approvingId===inv.id;

          return (
            <div key={inv.id} className="ri" style={{borderLeft:isPending?`3px solid ${inv.confidence==="high"?"#10b981":inv.confidence==="medium"?"#f59e0b":"#ef4444"}`:`3px solid ${C.border}`}}>
              {/* Header row */}
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:12,marginBottom:10}}>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",marginBottom:3}}>
                    <span style={{fontWeight:700,fontSize:14,color:C.ink}}>{inv.invoiceNumber||inv.filename||"Invoice"}</span>
                    {isPending&&<span style={{background:cs.bg,color:cs.color,fontSize:10,fontWeight:600,padding:"2px 8px",borderRadius:20}}>{cs.label}</span>}
                    {inv.status==="approved"&&<span style={{background:C.greenBg,color:C.green,fontSize:10,fontWeight:600,padding:"2px 8px",borderRadius:20}}>✓ Approved</span>}
                    {inv.status==="rejected"&&<span style={{background:C.redBg,color:C.red,fontSize:10,fontWeight:600,padding:"2px 8px",borderRadius:20}}>✗ Rejected</span>}
                  </div>
                  <div style={{fontSize:12,color:C.inkMid}}>
                    {fd(inv.date)} · <b style={{color:C.ink}}>{fc(inv.amount)}</b> {inv.currency!=="INR"&&inv.currency?`(${inv.currency})`:""}{inv.buyerName?` · ${inv.buyerName}`:""}
                  </div>
                  {inv.description&&<div style={{fontSize:11,color:C.inkFaint,marginTop:2}}>{inv.description}</div>}
                </div>
                <div style={{display:"flex",gap:6,flexShrink:0}}>
                  <button className="pr" onClick={()=>showPdf(`inv-pending:${inv.id}`,inv.invoiceNumber||"Invoice")}
                    style={{...S.btnGhost,padding:"5px 10px",fontSize:12}}>View</button>
                  <button className="pr" onClick={()=>onDeleteInvoice(inv.id)}
                    style={{...S.btnDel,padding:"5px 8px"}}>🗑</button>
                </div>
              </div>

              {/* Suggested SB */}
              <div style={{background:C.card,borderRadius:8,padding:"10px 12px",marginBottom:isPending?10:0}}>
                <div style={{fontSize:11,fontWeight:600,color:C.inkMid,marginBottom:5,textTransform:"uppercase",letterSpacing:"0.4px"}}>
                  {inv.status==="approved"?"Linked SB":"AI Suggested SB"}
                </div>
                {(linkedSb||sugSb)?(
                  <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                    <span style={{fontWeight:600,fontSize:13,color:C.ink}}>{(linkedSb||sugSb).sbNumber}</span>
                    <span style={{fontSize:12,color:C.inkMid}}>{fd((linkedSb||sugSb).date)} · {fc((linkedSb||sugSb).amount)}</span>
                    {(linkedSb||sugSb).fircId&&<span className="chip" style={{background:C.greenBg,color:C.green,fontSize:11}}>✓ FIRC matched</span>}
                  </div>
                ):(
                  <div style={{fontSize:12,color:C.inkFaint}}>No match found — select manually below</div>
                )}
              </div>

              {/* Pending: approve/reject actions */}
              {isPending&&!isApproving&&(
                <div style={{display:"flex",gap:8,marginTop:10}}>
                  <button className="pr" onClick={()=>{setApprovingId(inv.id); setOverrideSb(inv.suggestedSbId||"");}}
                    style={{...S.btnDark,flex:1,padding:"8px",fontSize:13,display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
                    ✓ Review & Approve
                  </button>
                  <button className="pr" onClick={()=>onPatchInvoice(inv.id,{status:"rejected"})}
                    style={{...S.btnDanger,padding:"8px 16px",fontSize:13}}>
                    Reject
                  </button>
                </div>
              )}

              {/* Approve panel — SB picker */}
              {isPending&&isApproving&&(
                <div style={{marginTop:10,background:C.greenBg,borderRadius:9,padding:"12px 14px",border:`1px solid ${C.green}`}}>
                  <div style={{fontSize:12,fontWeight:600,color:C.green,marginBottom:8}}>Select SB to link this invoice to:</div>
                  <select value={overrideSb} onChange={e=>setOverrideSb(e.target.value)}
                    style={{width:"100%",border:`1.5px solid ${C.green}`,borderRadius:7,padding:"8px 10px",fontSize:13,marginBottom:10,background:C.surface,color:C.ink}}>
                    <option value="">— choose SB —</option>
                    {data.shippingBills.map(sb=>(
                      <option key={sb.id} value={sb.id}>
                        {sb.sbNumber} · {fd(sb.date)} · {fc(sb.amount)}{sb.hasInvPdf?" (has invoice)":""}
                      </option>
                    ))}
                  </select>
                  <div style={{display:"flex",gap:8}}>
                    <button className="pr" disabled={!overrideSb} onClick={async()=>{
                        await onApprove(inv.id, overrideSb);
                        setApprovingId(null);
                      }}
                      style={{...S.btnDark,flex:1,padding:"9px",fontSize:13,opacity:overrideSb?1:0.4,display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
                      ✓ Confirm Link
                    </button>
                    <button className="pr" onClick={()=>setApprovingId(null)}
                      style={{...S.btnGhost,padding:"9px 16px",fontSize:13}}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
          );
        })
      }
    </div>
  );
}

function MatchView({ data, fircUsed, onAssign, onAuto, onUndo, onClearPending, onClearAll, showPdf, canUndo }) {
  const [selId,    setSelId]  = useState(null);
  const [running,  setRunning]= useState(false);
  const matched   = data.shippingBills.filter(sb=>sb.fircId).length;
  const unmatched = data.shippingBills.filter(sb=>!sb.fircId).sort((a,b)=>new Date(a.date||0)-new Date(b.date||0));
  const selFirc   = data.fircs.find(f=>f.id===selId);
  const selRem    = selFirc?(+selFirc.amount||0)-fircUsed(selFirc.id):0;
  const assigned  = data.shippingBills.filter(sb=>sb.fircId===selId).sort((a,b)=>new Date(a.date||0)-new Date(b.date||0));
  const sortedFircs=[...data.fircs].sort((a,b)=>new Date(a.date||0)-new Date(b.date||0));
  const totalSb=data.shippingBills.length;
  const matchedPct=totalSb?Math.round(matched/totalSb*100):0;

  return (
    <div style={{maxWidth:1080}}>
      <PH title="Match Payments to Shipping Bills" sub={`${matched} of ${totalSb} SBs matched · ${unmatched.length} still need a FIRC`}/>

      <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,padding:14,marginBottom:14,display:"grid",gridTemplateColumns:mob?"1fr":"1.1fr .9fr .9fr",gap:10,alignItems:"stretch"}}>
        <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:"12px 14px"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",gap:10,marginBottom:8}}>
            <div style={{fontSize:11,fontWeight:800,color:C.inkFaint,textTransform:"uppercase",letterSpacing:.6}}>Progress</div>
            <div style={{fontSize:12,fontWeight:800,color:matchedPct===100?C.green:C.amber}}>{matchedPct}%</div>
          </div>
          <div style={{height:8,background:C.surface,borderRadius:99,overflow:"hidden",border:`1px solid ${C.border}`}}>
            <div style={{width:`${matchedPct}%`,height:"100%",background:matchedPct===100?C.green:C.amber,borderRadius:99}}/>
          </div>
          <div style={{fontSize:12,color:C.inkMid,marginTop:8}}>{matched} matched · {unmatched.length} unmatched</div>
        </div>

        <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:"12px 14px"}}>
          <div style={{fontSize:11,fontWeight:800,color:C.inkFaint,textTransform:"uppercase",letterSpacing:.6,marginBottom:8}}>Next action</div>
          <button className="pr" disabled={running||unmatched.length===0||data.fircs.length===0}
            onClick={async()=>{setRunning(true);await onAuto();setRunning(false);}}
            style={{...S.btnPrimary,width:"100%",display:"flex",alignItems:"center",justifyContent:"center",gap:6,opacity:(running||unmatched.length===0||data.fircs.length===0)?0.5:1,padding:"10px 12px"}}>
            {running?<><Spin/> Matching oldest first…</>:unmatched.length===0?"All SBs matched":"Auto-match oldest SBs"}
          </button>
          <div style={{fontSize:11,color:C.inkFaint,marginTop:7,lineHeight:1.35}}>Best first step. It fills each FIRC without crossing the payment amount.</div>
        </div>

        <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:"12px 14px"}}>
          <div style={{fontSize:11,fontWeight:800,color:C.inkFaint,textTransform:"uppercase",letterSpacing:.6,marginBottom:8}}>Manual mode</div>
          <div style={{fontSize:18,fontWeight:800,color:selFirc?C.ink:C.inkFaint,lineHeight:1.1}}>{selFirc?selFirc.number:"Choose a FIRC"}</div>
          <div style={{fontSize:12,color:selFirc?(selRem>=0?C.green:C.red):C.inkFaint,marginTop:5}}>{selFirc?`${fc(selRem)} left to allocate`:"Then assign SBs below"}</div>
        </div>
      </div>

      {canUndo&&(
        <div style={{display:"flex",gap:8,alignItems:"center",background:C.amberBg,border:`1px solid ${C.goldLight}`,borderRadius:10,padding:"8px 10px",marginBottom:14}}>
          <div style={{fontSize:12,color:C.amber,flex:1}}>Auto-match snapshot saved. Undo restores the last match run.</div>
          <button className="pr" onClick={onUndo} style={{...S.btnGhost,fontSize:12,padding:"6px 12px",borderColor:C.gold,color:C.amber}}>Undo</button>
        </div>
      )}

      {data.fircs.length===0?<Empty icon="₹" text="Add FIRCs before matching"/>:<>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,marginTop:2,marginBottom:10}}>
          <SecTitle>Step 1 · Choose one FIRC</SecTitle>
          {matched>0&&(
            <div style={{display:"flex",gap:7,flexWrap:"wrap",justifyContent:"flex-end"}}>
              <button className="pr" onClick={()=>onClearPending()} style={{...S.btnGhost,fontSize:12,padding:"6px 10px"}}>Clear pending matches</button>
              <button className="pr" onClick={()=>{if(confirm("Hard reset — clears ALL matches including prepared/submitted/cleared?"))onClearAll();}} style={{...S.btnDanger,fontSize:12,padding:"6px 10px"}}>Reset all</button>
            </div>
          )}
        </div>
        <div style={{display:"grid",gridTemplateColumns:mob?"1fr":"repeat(2,minmax(0,1fr))",gap:8,marginBottom:selFirc?16:10}}>
        {sortedFircs.map(f=>{
          const used=fircUsed(f.id), rem=(+f.amount||0)-used;
          const pct=+f.amount?Math.min(100,(used/+f.amount)*100):0;
          const cnt=data.shippingBills.filter(sb=>sb.fircId===f.id).length;
          const active=selId===f.id;
          return (
            <div key={f.id} className="pr" onClick={()=>setSelId(active?null:f.id)} style={{...S.fircPill,...(active?S.fircPillActive:{})}}>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:13,marginBottom:5,gap:8}}>
                <b>{f.number||"—"}</b>
                <span style={{fontSize:11,color:active?C.amber:C.inkMid,whiteSpace:"nowrap",fontWeight:active?800:500}}>{active?"Selected":"Choose"}</span>
              </div>
              <div style={{height:5,background:C.card,borderRadius:3,marginBottom:4}}>
                <div style={{width:`${pct}%`,height:"100%",background:pct>98?C.greenBright:C.gold,borderRadius:3}}/>
              </div>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:11}}>
                <span style={{color:C.inkMid}}>{fd(f.date)} · {cnt} SBs</span>
                <span style={{color:rem>=0?C.green:C.red,fontWeight:700}}>{fc(rem)} left</span>
              </div>
            </div>
          );
        })}
        </div>

        {!selFirc&&<Tip yellow>Choose a FIRC above to open the assignment list.</Tip>}

        {selFirc&&(
          <div style={{display:"grid",gridTemplateColumns:mob?"1fr":"minmax(0,1fr) minmax(0,1fr)",gap:14,alignItems:"start"}}>
            <div>
              <SecTitle>Step 2 · Assign unmatched SBs</SecTitle>
              {unmatched.length===0?<Tip green>All shipping bills are matched.</Tip>:unmatched.map(sb=>{
              const fits=(+sb.amount||0)<=selRem;
              const dateWarn=sb.date&&selFirc.date&&new Date(sb.date)>new Date(selFirc.date);
              return (
                <div key={sb.id} style={{...S.matchRow,opacity:fits?1:0.45}}>
                  <div style={{flex:1}}>
                    <div style={{fontWeight:600,fontSize:13}}>{sb.sbNumber}</div>
                    <div style={{fontSize:11,color:C.inkMid}}>{fd(sb.date)} · {fc(sb.amount)}</div>
                    {!fits&&<div style={{fontSize:10,color:C.red,marginTop:1}}>Exceeds balance</div>}
                    {dateWarn&&<div style={{fontSize:10,color:C.amber,marginTop:1}}>⚠ SB date after FIRC — verify manually</div>}
                  </div>
                  <Btn ghost small onClick={()=>showPdf(`sb:${sb.id}`,sb.sbNumber)}>View</Btn>
                  <button className="pr" disabled={!fits} onClick={()=>onAssign(sb.id,selId)}
                    style={{...S.btnPrimary,padding:"5px 12px",fontSize:12,opacity:fits?1:0.4}}>Assign</button>
                </div>
              );
              })}
            </div>

            <div>
              <SecTitle>Step 3 · Review this FIRC</SecTitle>
              {assigned.length===0?<Tip>Nothing assigned to {selFirc.number} yet.</Tip>:assigned.map(sb=>(
                <div key={sb.id} style={S.matchRow}>
                  <div style={{flex:1}}>
                    <div style={{fontWeight:600,fontSize:13}}>{sb.sbNumber}</div>
                    <div style={{fontSize:11,color:C.inkMid}}>{fd(sb.date)} · {fc(sb.amount)}</div>
                  </div>
                  <Btn ghost small onClick={()=>showPdf(`sb:${sb.id}`,sb.sbNumber)}>View</Btn>
                  <button className="pr" onClick={()=>onAssign(sb.id,null)} style={S.btnDel}>Remove</button>
                </div>
              ))}
              {assigned.length>0&&selRem>=0&&<Tip green>{fc(selRem)} still available on this FIRC.</Tip>}
              {assigned.length>0&&selRem<0&&<Tip red>This FIRC is over-allocated by {fc(Math.abs(selRem))}.</Tip>}
            </div>
          </div>
        )}
      </>}
    </div>
  );
}

/* ══ STATS VIEW ══════════════════════════════════════════════════ */
function StatsView({ data, fircUsed, onExport, onImport, onFixDates }) {
  const [fixLog,    setFixLog]   = useState([]);
  const [fixing,    setFixing]   = useState(false);
  const [fixDone,   setFixDone]  = useState(null); // {fixed,failed,skipped}
  const [lrnData,   setLrnData]  = useState(null); // ng-learner-v1
  const [lrnLoading,setLrnLoading]=useState(false);
  const [lrnInsight,setLrnInsight]=useState(null); // {patterns, bottlenecks, automation, suggestions, summary}
  const [lrnOpen,   setLrnOpen]  = useState(true);
  const [lrnTick,   setLrnTick]  = useState(0);    // forces live counter refresh

  useEffect(()=>{
    loadK("ng-learner-v1").then(d=>{ if(d) setLrnData(d); }).catch(()=>{});
    const t=setInterval(()=>setLrnTick(x=>x+1),5000);
    return ()=>clearInterval(t);
  },[]);

  async function runLearnerAnalysis() {
    setLrnLoading(true); setLrnInsight(null);
    try {
      const stored=(await loadK("ng-learner-v1"))||{sessions:[]};
      // Send last 10 sessions, compacted to just event codes for token efficiency
      const compact=stored.sessions.slice(0,10).map(s=>({
        id:s.id.slice(0,8), start:s.start, end:s.end,
        events:s.events.map(e=>e.e+(e.p&&Object.keys(e.p).length?":"+JSON.stringify(e.p):""))
      }));
      const res=await fetch("/api/claude",{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          model:"claude-sonnet-4-20250514",max_tokens:1200,
          messages:[{role:"user",content:`You are a workflow intelligence analyst for an Indian export reconciliation tool (FEMA compliance — matching FIRC receipts with Shipping Bills).

Here are the user's last ${compact.length} work session(s) as compact event logs:
${JSON.stringify(compact,null,1)}

Event codes: view:change=tab switch, firc:upload=uploaded FIRC PDFs, firc:manual:save=entered FIRC manually, firc:delete/edit=removed or edited FIRC, sb:upload=uploaded Shipping Bills, sb:delete=removed SB, sb:status:cycle=advanced SB status (from→to), match:auto=ran auto-match, match:undo=undid match, match:sb:assign=manually assigned SB to FIRC, match:clear:pending/all=cleared matches, invoice:upload/approve=invoice actions, packet:generate=created submission packet, ai:insights:run=ran AI compliance check, date:fix:all=fixed dates, backup:export/import=backup actions, pdf:view=viewed a document, sheet:open=opened detail panel.

Respond ONLY with valid JSON (no markdown):
{"patterns":["<3-5 specific behavioural patterns you observe>"],"bottlenecks":["<2-3 places effort is repeated or wasted>"],"automation":["<2-3 things that could be auto-done or pre-filled>"],"suggestions":["<3-5 specific actionable workflow improvements>"],"summary":"<2 sentence plain-English summary of this user's working style>"}`}]
        })
      });
      if (!res.ok) throw new Error(`API ${res.status}`);
      const d=await res.json();
      const txt=(d.content||[]).map(i=>i.text||"").join("").replace(/```json|```/g,"").trim();
      const parsed=JSON.parse(txt);
      setLrnInsight(parsed);
      // Persist insights back
      const updated={...stored,insights:{lastRun:Date.now(),...parsed}};
      await saveK("ng-learner-v1",updated);
      setLrnData(updated);
    } catch(e){ setLrnInsight({summary:`Analysis failed: ${e.message}`,patterns:[],bottlenecks:[],automation:[],suggestions:[]}); }
    setLrnLoading(false);
  }

  const totalSessions=(lrnData?.sessions?.length)||0;
  const totalEvents=(lrnData?.sessions||[]).reduce((s,x)=>s+(x.eventCount||0),0);
  const thisSessionEvents=lrnData?.sessions?.find(s=>s.id===learner.sessionId)?.events?.length||0;
  const liveBuffer=lrnTick>=0?learner.buffered:0; // lrnTick forces re-read
  const liveCount=thisSessionEvents+liveBuffer;
  const lastAnalysisMs=lrnData?.insights?.lastRun;
  const lastAnalysisStr=lastAnalysisMs
    ?new Date(lastAnalysisMs).toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"})
    :null;

  async function runFix() {
    setFixing(true); setFixLog([]); setFixDone(null);
    const result = await onFixDates(({i, total, sb, status, from, to, date, detail}) => {
      const entry = { i, total, sb, status, from, to, date, detail };
      setFixLog(l => {
        const next = [...l];
        next[i] = entry;
        return next;
      });
    });
    setFixDone(result);
    setFixing(false);
  }
  const sbs   = data.shippingBills;
  const fircs = data.fircs;
  const total = sbs.length;

  const byStatus = st => sbs.filter(sb=>(sb.status||"pending")===st).length;
  const amtBy    = fn => sbs.filter(fn).reduce((s,sb)=>s+(+sb.amount||0),0);

  const matched   = sbs.filter(sb=>sb.fircId).length;
  const pending   = byStatus("pending");
  const prepared  = byStatus("prepared");
  const submitted = byStatus("submitted");
  const cleared   = byStatus("cleared");
  const rejected  = byStatus("rejected");

  const totalFirc = fircs.reduce((s,f)=>s+(+f.amount||0),0);
  const totalSb   = amtBy(()=>true);
  const matchedAmt= amtBy(sb=>sb.fircId);
  const clearedAmt= amtBy(sb=>sb.status==="cleared");

  const Bar=({pct,color})=>(
    <div style={{flex:pct,background:color,minWidth:pct>0?12:0,transition:"flex 0.4s",display:"flex",alignItems:"center",justifyContent:"center",fontSize:8,color:"#fff",fontWeight:700}}>
      {pct>5&&Math.round(pct)+"%"}
    </div>
  );

  return (
    <div style={{maxWidth:1000}}>
      <PH title="Overview" sub="Live stats across all records"/>

      {/* KPI strip */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:12}}>
        {[
          {v:total,     l:"Total SBs",   c:C.ink},
          {v:matched,   l:"Matched",     c:C.green, sub:total?`${Math.round(matched/total*100)}%`:"—"},
          {v:prepared,  l:"Prepared",    c:C.amber},
          {v:submitted, l:"Submitted",   c:C.blue},
          {v:cleared,   l:"Cleared ✓",  c:C.green},
          {v:rejected,  l:"Rejected",    c:C.red},
        ].map(({v,l,c,sub})=>(
          <div key={l} style={{background:C.surface,borderRadius:10,padding:"13px 12px",border:`1px solid ${C.border}`}}>
            <div style={{fontSize:28,fontWeight:700,color:c,fontFamily:FONT,letterSpacing:"-.02em",lineHeight:1}}>
              {v}{sub&&<span style={{fontSize:13,fontWeight:400,color:C.inkFaint,marginLeft:4}}>{sub}</span>}
            </div>
            <div style={{fontSize:11,color:C.inkMid,marginTop:3}}>{l}</div>
          </div>
        ))}
      </div>

      {/* SB type breakdown */}
      {total>0&&(
        <div className="ri" style={{marginBottom:8}}>
          <div style={{fontSize:12,fontWeight:600,color:C.inkMid,marginBottom:10}}>SB Types</div>
          {[
            {type:"commercial", label:"Commercial SB", bg:C.blueBg, color:C.blue},
            {type:"csb",        label:"CSB-V (Courier)",bg:C.purpleBg,color:C.purple},
            {type:"pbe",        label:"PBE (Postal)",   bg:C.tealBg,color:C.teal},
          ].map(({type,label,bg,color})=>{
            const n=sbs.filter(sb=>detectSbType(sb)===type).length;
            return n>0?(
              <div key={type} style={{display:"flex",alignItems:"center",gap:8,padding:"5px 0",borderBottom:`1px solid ${C.border}`}}>
                <span style={{fontSize:11,padding:"2px 9px",borderRadius:20,background:bg,color,fontWeight:600,flexShrink:0}}>{label}</span>
                <div style={{flex:1,height:6,background:C.card,borderRadius:3}}>
                  <div style={{width:`${Math.round(n/total*100)}%`,height:"100%",background:color,borderRadius:3,opacity:0.7}}/>
                </div>
                <span style={{fontSize:12,fontWeight:600,color:C.ink,flexShrink:0}}>{n}</span>
              </div>
            ):null;
          })}
        </div>
      )}
      {total>0&&(
        <div className="ri" style={{marginBottom:8}}>
          <div style={{fontSize:12,fontWeight:600,color:C.inkMid,marginBottom:10}}>SB Pipeline</div>
          <div style={{display:"flex",height:22,borderRadius:6,overflow:"hidden",gap:2,marginBottom:10}}>
            {[
              {n:pending,  c:C.borderHi},
              {n:prepared, c:"#fbbf24"},
              {n:submitted,c:"#3b82f6"},
              {n:cleared,  c:"#10b981"},
              {n:rejected, c:"#f87171"},
            ].map((x,i)=>x.n>0?<Bar key={i} pct={(x.n/total)*100} color={x.c}/>:null)}
          </div>
          <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
            {[
              {n:pending,  c:C.borderHi,l:"Pending"},
              {n:prepared, c:"#fbbf24",l:"Prepared"},
              {n:submitted,c:"#3b82f6",l:"Submitted"},
              {n:cleared,  c:"#10b981",l:"Cleared"},
              {n:rejected, c:"#f87171",l:"Rejected"},
            ].map(x=>(
              <div key={x.l} style={{display:"flex",alignItems:"center",gap:5,fontSize:11}}>
                <div style={{width:9,height:9,borderRadius:2,background:x.c}}/>
                <span style={{color:C.inkMid}}>{x.l} <b style={{color:C.ink}}>{x.n}</b></span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Amounts */}
      <div className="ri" style={{marginBottom:8}}>
        <div style={{fontSize:12,fontWeight:600,color:C.inkMid,marginBottom:10}}>Amount Summary</div>
        {[
          {l:"Total FIRC value",  v:totalFirc,            c:C.ink},
          {l:"Total SB value",    v:totalSb,              c:C.inkMid},
          {l:"Matched SB value",  v:matchedAmt,           c:C.green},
          {l:"Cleared value",     v:clearedAmt,           c:C.greenBright},
          {l:"Unmatched value",   v:totalSb-matchedAmt,   c:C.amber},
        ].map(r=>(
          <div key={r.l} style={{display:"flex",justifyContent:"space-between",padding:"7px 0",borderBottom:`1px solid ${C.border}`,fontSize:12}}>
            <span style={{color:C.inkMid}}>{r.l}</span>
            <span style={{fontWeight:600,color:r.c}}>{fc(r.v)}</span>
          </div>
        ))}
      </div>

      {/* Doc readiness */}
      {total>0&&(
        <div className="ri" style={{marginBottom:8}}>
          <div style={{fontSize:12,fontWeight:600,color:C.inkMid,marginBottom:10}}>Document Readiness</div>
          {[
            {l:"SB PDF uploaded",  n:sbs.filter(sb=>sb.hasSbPdf).length},
            {l:"Invoice uploaded", n:sbs.filter(sb=>sb.hasInvPdf).length},
            {l:"HAWB uploaded",    n:sbs.filter(sb=>sb.hasHawbPdf).length},
            {l:"ERF uploaded",     n:sbs.filter(sb=>sb.hasErfPdf).length},
            {l:"BRC uploaded",     n:sbs.filter(sb=>sb.hasBrcPdf).length},
            {l:"Packet-ready",     n:sbs.filter(sb=>sb.fircId&&sb.hasSbPdf&&sb.hasInvPdf&&sb.hasHawbPdf&&sb.hasErfPdf&&((sb.status||"pending")!=="cleared"||sb.hasBrcPdf)).length, bold:true},
            {l:"Closed + BRC",      n:sbs.filter(sb=>(sb.status||"pending")==="cleared"&&sb.hasBrcPdf).length, bold:true},
          ].map(r=>(
            <div key={r.l} style={{display:"flex",alignItems:"center",gap:8,padding:"5px 0",borderBottom:`1px solid ${C.border}`}}>
              <span style={{fontSize:12,flex:1,color:r.bold?C.ink:C.inkMid,fontWeight:r.bold?600:400}}>{r.l}</span>
              <div style={{width:90,height:6,background:C.card,borderRadius:3}}>
                <div style={{width:`${total?Math.round(r.n/total*100):0}%`,height:"100%",background:r.bold?C.ink:C.gold,borderRadius:3}}/>
              </div>
              <span style={{fontSize:11,color:C.inkMid,width:36,textAlign:"right"}}>{r.n}/{total}</span>
            </div>
          ))}
        </div>
      )}

      {/* FIRC utilisation */}
      {fircs.length>0&&(
        <div className="ri" style={{marginBottom:8}}>
          <div style={{fontSize:12,fontWeight:600,color:C.inkMid,marginBottom:10}}>FIRC Utilisation</div>
          {[...fircs].sort((a,b)=>new Date(a.date)-new Date(b.date)).map(f=>{
            const used=fircUsed(f.id), pct=+f.amount?Math.min(100,Math.round((used/+f.amount)*100)):0;
            const cnt=sbs.filter(sb=>sb.fircId===f.id).length;
            return (
              <div key={f.id} style={{marginBottom:12}}>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:4}}>
                  <span style={{fontWeight:600,color:C.ink}}>{f.number||"—"}</span>
                  <span style={{fontSize:11,color:C.inkMid}}>{cnt} SBs · {fd(f.date)}</span>
                </div>
                <div style={{height:8,background:C.card,borderRadius:4}}>
                  <div style={{width:`${pct}%`,height:"100%",background:pct>98?C.greenBright:pct>60?C.gold:"#60a5fa",borderRadius:4,transition:"width 0.5s"}}/>
                </div>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:C.inkMid,marginTop:3}}>
                  <span>{fc(used)} used</span>
                  <span style={{color:pct>98?C.greenBright:"inherit"}}>{pct}% · {fc((+f.amount||0)-used)} left</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Fix all dates ── */}
      <div className="ri" style={{marginBottom:10}}>
        <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:16,marginBottom:fixLog.length>0?12:0}}>
          <div>
            <div style={{fontSize:14,fontWeight:600,color:C.ink,marginBottom:3}}>🗓 Re-analyse All SB Dates</div>
            <div style={{fontSize:12,color:C.inkMid,lineHeight:1.6}}>
              Runs AI on every stored SB PDF and corrects dates using DD/MM/YYYY Indian format.
              Only updates dates that have changed — amounts, numbers, and types are untouched.
            </div>
          </div>
          <button className="pr" onClick={runFix} disabled={fixing||data.shippingBills.length===0}
            style={{...S.btnDark,padding:"9px 18px",whiteSpace:"nowrap",flexShrink:0,opacity:(fixing||data.shippingBills.length===0)?0.6:1,display:"flex",alignItems:"center",gap:7}}>
            {fixing?<><Spin/>Fixing…</>:"⚡ Fix All Dates"}
          </button>
        </div>

        {/* Progress log */}
        {fixLog.length>0&&(
          <div style={{maxHeight:260,overflowY:"auto",border:`1px solid ${C.border}`,borderRadius:8}}>
            {/* Summary bar */}
            {fixing&&(
              <div style={{background:C.card,padding:"7px 12px",fontSize:12,color:C.inkMid,borderBottom:`1px solid ${C.border}`,display:"flex",gap:16}}>
                <span>Processing {fixLog.filter(Boolean).length} / {data.shippingBills.length}</span>
                <span style={{color:C.greenBright}}>✓ {fixLog.filter(x=>x?.status==="fixed").length} fixed</span>
                <span style={{color:C.inkMid}}>— {fixLog.filter(x=>x?.status==="ok").length} unchanged</span>
                <span style={{color:C.red}}>✗ {fixLog.filter(x=>x?.status==="error").length} errors</span>
              </div>
            )}
            {fixDone&&(
              <div style={{background: fixDone.failed>0?C.redBg:C.greenBg,padding:"9px 12px",fontSize:13,fontWeight:600,borderBottom:`1px solid ${C.border}`,
                color:fixDone.failed>0?C.red:C.green,display:"flex",gap:16}}>
                <span>✓ {fixDone.fixed} dates fixed</span>
                <span style={{color:C.inkMid,fontWeight:400}}>· {fixDone.skipped} already correct / no PDF</span>
                {fixDone.failed>0&&<span style={{color:C.red}}>· {fixDone.failed} failed</span>}
              </div>
            )}
            {/* Per-SB rows */}
            {fixLog.filter(Boolean).map((r,i)=>{
              const isFixed = r.status==="fixed";
              const isErr   = r.status==="error";
              const isNoPdf = r.status==="no-pdf";
              const isProc  = ["reading","extracting"].includes(r.status);
              return (
                <div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"6px 12px",
                  borderBottom:`1px solid ${C.border}`,fontSize:12,
                  background:isFixed?C.greenBg:isErr?C.redBg:"#fff"}}>
                  <span style={{width:16,textAlign:"center",flexShrink:0,color:isFixed?C.greenBright:isErr?C.red:isNoPdf?C.inkFaint:isProc?C.amber:C.inkFaint}}>
                    {isFixed?"✓":isErr?"✗":isNoPdf?"○":isProc?<Spin/>:"·"}
                  </span>
                  <span style={{flex:1,fontWeight:500,color:C.ink,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.sb}</span>
                  {isFixed&&<span style={{color:C.inkMid,flexShrink:0}}><s style={{color:C.red}}>{fd(r.from)}</s> → <b style={{color:C.greenBright}}>{fd(r.to)}</b></span>}
                  {r.status==="ok"&&<span style={{color:C.inkMid,flexShrink:0}}>{fd(r.date)} ✓</span>}
                  {isNoPdf&&<span style={{color:C.inkFaint,flexShrink:0}}>no PDF stored</span>}
                  {isErr&&<span style={{color:C.red,flexShrink:0,maxWidth:200,overflow:"hidden",textOverflow:"ellipsis"}}>{r.detail?.slice(0,50)}</span>}
                  {isProc&&<span style={{color:C.amber,flexShrink:0}}>{r.status}…</span>}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Data migration ── */}
      <div style={{background:C.card,borderRadius:10,padding:"18px 20px",marginTop:4}}>
        <div style={{fontFamily:"system-ui,sans-serif",fontSize:11,fontWeight:600,letterSpacing:"1px",textTransform:"uppercase",color:C.inkMid,marginBottom:14}}>Data &amp; Migration</div>

        <button className="pr" onClick={onExport}
          style={{...S.btnDark,width:"100%",marginBottom:10,display:"flex",alignItems:"center",justifyContent:"center",gap:8,padding:"11px 16px",fontSize:13}}>
          📦 Full backup — metadata + all documents
        </button>

        <div style={{fontFamily:"system-ui,sans-serif",fontSize:11,color:C.inkFaint,marginBottom:10,lineHeight:1.5}}>
          Exports everything: SBs, FIRCs, invoices, and every stored PDF/image. Use this to migrate to your ERP or move between browsers.
        </div>

        <label style={{display:"block",width:"100%"}}>
          <input type="file" accept=".json" style={{display:"none"}}
            onChange={e=>{ if(e.target.files[0]) onImport(e.target.files[0]); e.target.value=""; }}/>
          <span className="pr" style={{...S.btnGhost,display:"flex",alignItems:"center",justifyContent:"center",gap:8,padding:"11px 16px",fontSize:13,cursor:"pointer",width:"100%"}}>
            📥 Restore from backup
          </span>
        </label>

        <div style={{fontFamily:"system-ui,sans-serif",fontSize:11,color:C.inkFaint,marginTop:8,lineHeight:1.5}}>
          Restores all records and documents from a full backup file. Merges with existing data — does not wipe first.
        </div>
      </div>

      {/* ── Workflow Learner ── */}
      <div style={{background:C.surface,border:`1.5px solid ${C.border}`,borderRadius:12,marginTop:16,overflow:"hidden"}}>
        <button
          onClick={()=>setLrnOpen(o=>!o)}
          style={{width:"100%",background:"none",border:"none",cursor:"pointer",padding:"14px 18px",display:"flex",alignItems:"center",gap:10,textAlign:"left"}}>
          <span style={{fontSize:18}}>🧠</span>
          <div style={{flex:1}}>
            <div style={{fontSize:14,fontWeight:700,color:C.ink,fontFamily:FONT}}>Workflow Learner</div>
            <div style={{fontSize:11,color:C.inkMid,marginTop:1}}>
              Always learning — observing every action silently
            </div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
            <span style={{fontSize:11,color:C.green,fontWeight:600,background:C.greenBg,padding:"2px 9px",borderRadius:20}}>
              ● Active
            </span>
            <span style={{fontSize:11,color:C.inkMid}}>{lrnOpen?"▲":"▼"}</span>
          </div>
        </button>

        {lrnOpen&&(
          <div style={{borderTop:`1px solid ${C.border}`,padding:"16px 18px 20px"}}>
            {/* Session stats row */}
            <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:16}}>
              {[
                {v:liveCount,  l:"This session",     c:C.green},
                {v:totalSessions, l:"Total sessions", c:C.ink},
                {v:totalEvents,   l:"Total events",   c:C.blue},
              ].map(({v,l,c})=>(
                <div key={l} style={{background:C.card,borderRadius:9,padding:"10px 12px",border:`1px solid ${C.border}`}}>
                  <div style={{fontSize:22,fontWeight:700,color:c,fontFamily:FONT,letterSpacing:"-.02em",lineHeight:1}}>{v}</div>
                  <div style={{fontSize:10,color:C.inkMid,marginTop:2}}>{l}</div>
                </div>
              ))}
            </div>

            {lastAnalysisStr&&(
              <div style={{fontSize:11,color:C.inkMid,marginBottom:12}}>
                Last analysis: <b style={{color:C.ink}}>{lastAnalysisStr}</b>
              </div>
            )}

            <button className="pr" onClick={runLearnerAnalysis}
              disabled={lrnLoading||totalSessions===0}
              style={{...S.btnDark,width:"100%",marginBottom:16,display:"flex",alignItems:"center",justifyContent:"center",gap:8,padding:"11px 16px",fontSize:13,opacity:(lrnLoading||totalSessions===0)?0.6:1}}>
              {lrnLoading?<><Spin/>Analysing your workflow…</>:"🔍 Analyse My Workflow"}
            </button>
            {totalSessions===0&&(
              <div style={{fontSize:12,color:C.inkMid,textAlign:"center",marginBottom:12}}>
                Use the app a bit — the learner will gather data and then analyse your patterns.
              </div>
            )}

            {/* Insight cards */}
            {(lrnInsight||lrnData?.insights)&&(()=>{
              const ins=lrnInsight||lrnData.insights;
              return (
                <div style={{display:"flex",flexDirection:"column",gap:12}}>
                  {ins.summary&&(
                    <div style={{background:C.purpleBg,borderRadius:9,padding:"11px 14px",border:`1px solid ${C.purple}22`,fontSize:13,color:C.ink,lineHeight:1.6}}>
                      {ins.summary}
                    </div>
                  )}
                  {[
                    {key:"patterns",    icon:"🔄", title:"Patterns",               color:C.blue,   bg:C.blueBg},
                    {key:"bottlenecks", icon:"⚠️",  title:"Bottlenecks",            color:C.amber,  bg:C.amberBg},
                    {key:"automation",  icon:"⚡",  title:"Automation Opportunities",color:C.teal,   bg:C.tealBg},
                    {key:"suggestions", icon:"💡",  title:"Smart Suggestions",      color:C.green,  bg:C.greenBg},
                  ].map(({key,icon,title,color,bg})=>{
                    const items=ins[key];
                    if (!items||!items.length) return null;
                    return (
                      <div key={key} style={{background:bg,borderRadius:9,padding:"11px 14px",border:`1px solid ${color}22`}}>
                        <div style={{fontSize:12,fontWeight:700,color,marginBottom:8}}>{icon} {title}</div>
                        {items.map((item,i)=>(
                          <div key={i} style={{display:"flex",gap:8,alignItems:"flex-start",marginBottom:i<items.length-1?6:0}}>
                            <span style={{color,flexShrink:0,marginTop:1,fontSize:11}}>•</span>
                            <span style={{fontSize:12,color:C.ink,lineHeight:1.5}}>{item}</span>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </div>
        )}
      </div>
    </div>
  );
}

/* ══ AI INSIGHTS VIEW ════════════════════════════════════════════ */
function AIInsightsView({ data, fircUsed }) {
  const [insights,   setInsights]  = useState(null);   // { summary, concerns: [{id,severity,title,detail,category}] }
  const [reviewed,   setReviewed]  = useState({});      // {id: true}
  const [loading,    setLoading]   = useState(false);
  const [error,      setError]     = useState(null);
  const [lastRun,    setLastRun]   = useState(null);
  const [filter,     setFilter]    = useState("all");   // all open reviewed

  // Load persisted reviews + last run on mount
  useEffect(()=>{
    (async()=>{
      const s=await insightsStore.load();
      if (s.reviewed) setReviewed(s.reviewed);
      if (s.lastRun)  setLastRun(s.lastRun);
      if (s.concerns && s.concerns.length>0) setInsights({summary:s.summary||"",concerns:s.concerns});
    })();
  },[]);

  async function persistReviewed(newReviewed) {
    setReviewed(newReviewed);
    const current=await insightsStore.load();
    await insightsStore.save({...current, reviewed:newReviewed});
  }

  async function runAnalysis() {
    if (data.fircs.length===0 && data.shippingBills.length===0) { setError("No data yet — upload FIRCs and SBs first."); return; }
    learner.track("ai:insights:run");
    setLoading(true); setError(null);

    // Build a compact but rich data summary for the AI
    const fircSummary = data.fircs.map(f=>({
      number: f.number,
      date:   f.date,
      amount: +f.amount||0,
      sbsAssigned: data.shippingBills.filter(sb=>sb.fircId===f.id).length,
      amountUsed: fircUsed(f.id),
    })).sort((a,b)=>new Date(a.date)-new Date(b.date));

    const sbSummary = data.shippingBills.map(sb=>({
      number:  sb.sbNumber,
      type:    sb.sbType||"commercial",
      date:    sb.date,
      amount:  +sb.amount||0,
      status:  sb.status||"pending",
      matched: !!sb.fircId,
      fircNumber: sb.fircId ? (data.fircs.find(f=>f.id===sb.fircId)?.number||"?") : null,
    })).sort((a,b)=>new Date(a.date)-new Date(b.date));

    const prompt = `You are an Indian export compliance expert. Analyze this exporter's FIRC and Shipping Bill data. Be concise but specific — always name actual FIRC numbers, SB numbers, and dates.

KEY RULES:
- SB date must be BEFORE FIRC date (FEMA hard rule)
- Proceeds must be realised within 9 months of SB date
- Exporter receives FIRCs from Payoneer typically every 1-2 weeks
- SB types: PBE = Postal, CSB = Courier, commercial = standard

FIRC DATA (${fircSummary.length} total):
${JSON.stringify(fircSummary)}

SB DATA (${sbSummary.length} total):
${JSON.stringify(sbSummary)}

Return ONLY valid compact JSON (no markdown):
{"summary":"2 sentence health overview","concerns":[{"id":"slug","severity":"high|medium|low","category":"missing-firc|date-violation|amount-mismatch|pattern-gap|compliance|unmatched|utilisation|other","title":"max 7 words","detail":"specific concern with actual numbers and dates, max 2 sentences","action":"what to do"}]}

Analyse for: 1) FIRC date gaps >3 weeks suggesting missed Payoneer payment 2) SBs approaching 9-month FEMA deadline 3) SB date after FIRC date violations 4) Unmatched SBs 5) Under/over-utilised FIRCs 6) Any amount inconsistencies. Return max 10 concerns, highest severity first.`;

    try {
      const res = await fetch("/api/claude", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({
          model:"claude-sonnet-4-20250514", max_tokens:4000,
          messages:[{role:"user", content:prompt}]
        })
      });
      if (!res.ok) throw new Error(`API ${res.status}`);
      const d = await res.json();
      if (d.error) throw new Error(d.error.message);
      let text = (d.content||[]).map(i=>i.text||"").join("").replace(/```json|```/g,"").trim();

      // If response was cut off, try to salvage valid JSON by closing open structures
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Find last complete concern object and close the JSON
        const lastClose = text.lastIndexOf('}');
        if (lastClose > 0) {
          // Walk back to find the last fully closed concern
          let truncated = text.slice(0, lastClose + 1);
          // Close concerns array and root object if needed
          const openBrackets = (truncated.match(/\[/g)||[]).length - (truncated.match(/\]/g)||[]).length;
          const openBraces   = (truncated.match(/\{/g)||[]).length - (truncated.match(/\}/g)||[]).length;
          for (let i=0;i<openBrackets;i++) truncated += ']';
          for (let i=0;i<openBraces;i++)   truncated += '}';
          try { parsed = JSON.parse(truncated); }
          catch { throw new Error("Could not parse AI response — try running again"); }
        } else {
          throw new Error("Empty response — try running again");
        }
      }
      setInsights(parsed);
      const now = new Date().toISOString();
      setLastRun(now);
      // Persist
      const current = await insightsStore.load();
      await insightsStore.save({...current, summary:parsed.summary, concerns:parsed.concerns, lastRun:now});
    } catch(e) { setError(`Analysis failed: ${e.message}`); }
    setLoading(false);
  }

  async function toggleReview(id) {
    const next = {...reviewed, [id]: !reviewed[id]};
    await persistReviewed(next);
  }

  const SEV_STYLE = {
    high:   {bg:C.redBg,color:C.red,dot:"#ef4444",label:"High"},
    medium: {bg:C.amberBg,color:C.amber,dot:"#f59e0b",label:"Medium"},
    low:    {bg:C.greenBg,color:C.green,dot:"#10b981",label:"Low"},
  };
  const CAT_ICON = {
    "missing-firc":"💸", "date-violation":"⚠️", "amount-mismatch":"🔢",
    "pattern-gap":"📅",  "compliance":"⚖️",      "unmatched":"🔗",
    "utilisation":"📊",  "other":"📌",
  };

  const concerns = insights?.concerns || [];
  const openCount     = concerns.filter(c=>!reviewed[c.id]).length;
  const reviewedCount = concerns.filter(c=>reviewed[c.id]).length;
  const shown = filter==="open"     ? concerns.filter(c=>!reviewed[c.id])
              : filter==="reviewed" ? concerns.filter(c=>reviewed[c.id])
              : concerns;

  return (
    <div style={{maxWidth:800}}>
      <PH title="AI Insights" sub="Pattern analysis · FEMA compliance · Payoneer gap detection"/>

      {/* Run button */}
      <div className="ri" style={{marginBottom:12,background:C.ink,border:"none"}}>
        <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:10}}>
          <div style={{width:36,height:36,borderRadius:9,background:C.gold,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>🤖</div>
          <div>
            <div style={{color:C.surface,fontSize:13,fontWeight:600}}>Claude Export Analyst</div>
            <div style={{color:C.surface,opacity:.5,fontSize:11}}>{lastRun?`Last run ${new Date(lastRun).toLocaleDateString("en-IN",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"})}`:"Not run yet"}</div>
          </div>
        </div>
        <button className="pr" onClick={runAnalysis} disabled={loading}
          style={{...S.btnPrimary,width:"100%",display:"flex",alignItems:"center",justifyContent:"center",gap:6,padding:"12px",opacity:loading?0.7:1}}>
          {loading?<><Spin/> Analysing your data…</>:"⚡ Run AI Analysis"}
        </button>
        {loading&&<div style={{fontSize:11,color:C.surface,opacity:.5,textAlign:"center",marginTop:6}}>Sending {data.fircs.length} FIRCs + {data.shippingBills.length} SBs to OpenAI…</div>}
      </div>

      {error&&<Tip red>{error}</Tip>}

      {/* Summary card */}
      {insights?.summary&&(
        <div style={{background:C.surface,borderRadius:10,padding:"13px 14px",marginBottom:10,border:`1px solid ${C.border}`}}>
          <div style={{fontSize:11,fontWeight:600,color:C.inkMid,textTransform:"uppercase",letterSpacing:"0.5px",marginBottom:6}}>Executive Summary</div>
          <div style={{fontSize:13,color:C.ink,lineHeight:1.65}}>{insights.summary}</div>
        </div>
      )}

      {/* Concern stats + filter */}
      {concerns.length>0&&(
        <>
          <div style={{display:"flex",gap:6,marginBottom:10}}>
            {[
              {v:"all",     l:`All (${concerns.length})`},
              {v:"open",    l:`Open (${openCount})`,    c:openCount>0?C.red:undefined},
              {v:"reviewed",l:`Reviewed (${reviewedCount})`},
            ].map(o=>(
              <button key={o.v} className="pr" onClick={()=>setFilter(o.v)}
                style={{background:filter===o.v?C.ink:C.card,color:filter===o.v?C.surface:(o.c||C.inkMid),
                  border:"none",borderRadius:20,padding:"5px 13px",fontSize:11,cursor:"pointer",fontWeight:filter===o.v?600:400}}>
                {o.l}
              </button>
            ))}
          </div>

          {/* Severity summary pills */}
          <div style={{display:"flex",gap:6,marginBottom:12,flexWrap:"wrap"}}>
            {["high","medium","low"].map(sev=>{
              const n=concerns.filter(c=>c.severity===sev&&!reviewed[c.id]).length;
              if (!n) return null;
              const ss=SEV_STYLE[sev];
              return <span key={sev} style={{background:ss.bg,color:ss.color,fontSize:11,fontWeight:600,padding:"3px 10px",borderRadius:20}}>{n} {ss.label}</span>;
            })}
          </div>
        </>
      )}

      {/* Concern cards */}
      {shown.length===0&&insights&&<Empty icon="✅" text={filter==="reviewed"?"No reviewed items yet":"All concerns reviewed!"}/>}
      {shown.map(c=>{
        const ss=SEV_STYLE[c.severity]||SEV_STYLE.low;
        const icon=CAT_ICON[c.category]||"📌";
        const done=reviewed[c.id];
        return (
          <div key={c.id} className="ri" style={{opacity:done?0.55:1,transition:"opacity 0.2s",borderLeft:`3px solid ${done?C.borderHi:ss.dot}`}}>
            <div style={{display:"flex",alignItems:"flex-start",gap:10}}>
              {/* Checkbox */}
              <button className="pr" onClick={()=>toggleReview(c.id)}
                style={{width:22,height:22,borderRadius:5,border:`2px solid ${done?"#10b981":C.borderHi}`,
                  background:done?"#10b981":"#fff",flexShrink:0,marginTop:1,cursor:"pointer",
                  display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontSize:12,fontWeight:700}}>
                {done?"✓":""}
              </button>
              <div style={{flex:1,minWidth:0}}>
                <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap",marginBottom:4}}>
                  <span style={{fontSize:14}}>{icon}</span>
                  <span style={{fontSize:13,fontWeight:600,color:done?C.inkMid:C.ink,textDecoration:done?"line-through":"none"}}>{c.title}</span>
                  <span style={{background:ss.bg,color:ss.color,fontSize:10,fontWeight:600,padding:"2px 8px",borderRadius:20,flexShrink:0}}>{ss.label}</span>
                </div>
                <div style={{fontSize:12,color:C.inkMid,lineHeight:1.65,marginBottom:done?0:8}}>{c.detail}</div>
                {!done&&c.action&&(
                  <div style={{background:C.card,borderRadius:7,padding:"7px 10px",fontSize:11,color:C.inkMid,lineHeight:1.5}}>
                    <span style={{fontWeight:600,color:C.inkMid}}>→ Action: </span>{c.action}
                  </div>
                )}
                {done&&<div style={{fontSize:11,color:"#10b981",marginTop:2}}>✓ Reviewed</div>}
              </div>
            </div>
          </div>
        );
      })}

      {concerns.length>0&&reviewedCount>0&&(
        <button className="pr" onClick={async()=>{await persistReviewed({});}}
          style={{...S.btnGhost,width:"100%",marginTop:4,fontSize:12,padding:"9px"}}>
          Reset all reviews
        </button>
      )}

      {!insights&&!loading&&(
        <div style={{textAlign:"center",padding:"30px 20px",color:C.inkFaint}}>
          <div style={{fontSize:40,marginBottom:12}}>🤖</div>
          <div style={{fontSize:13,fontWeight:600,color:C.inkMid,marginBottom:6}}>No analysis run yet</div>
          <div style={{fontSize:12,lineHeight:1.7}}>Claude will analyze your FIRCs and SBs for:<br/>
            missing Payoneer payments · FEMA deadline risks<br/>date violations · utilisation gaps · patterns</div>
        </div>
      )}
    </div>
  );
}

/* ══ FEMA VIEW ═══════════════════════════════════════════════════ */
function FemaView({ hasFema, setHasFema }) {
  const [uploading,setUploading]=useState(false);
  const fileRef=useRef();
  async function handle(files){
    const f=files[0]; if(!f)return;
    setUploading(true);
    try{const {b64,mime}=await readB64WithMime(f);await docs.set("fema",b64,mime);setHasFema(true);}
    catch(e){alert("Upload failed: "+e.message);}
    setUploading(false);
    if(fileRef.current)fileRef.current.value="";
  }
  return (
    <div style={{maxWidth:700}}>
      <PH title="FEMA Declaration" sub="Upload once — included in every packet"/>
      <div className="ri">
        <div style={{fontSize:13,color:C.inkMid,lineHeight:1.7,marginBottom:14}}>The FEMA Declaration is the same for all shipments. Upload it once and it will be auto-included in every packet.</div>
        {hasFema
          ?<div style={{background:C.greenBg,borderRadius:10,padding:"12px 14px",marginBottom:14,display:"flex",alignItems:"center",gap:10}}>
            <span style={{fontSize:22}}>✓</span>
            <div><div style={{fontWeight:600,fontSize:13,color:C.green}}>FEMA Declaration uploaded</div><div style={{fontSize:12,color:C.green}}>Included in all packets automatically</div></div>
          </div>
          :<div style={{background:C.amberBg,borderRadius:10,padding:"12px 14px",marginBottom:14}}>
            <div style={{fontWeight:600,fontSize:13,color:C.amber}}>⚠ Not uploaded yet</div>
            <div style={{fontSize:12,color:C.amber,marginTop:2}}>Packets will show a placeholder page until uploaded.</div>
          </div>
        }
        <DropZone label={hasFema?"Replace FEMA PDF":"Upload FEMA PDF"} multi={false} fileRef={fileRef} onFiles={handle} uploading={uploading}/>
        {hasFema&&<button className="pr" onClick={async()=>{await docs.del("fema");setHasFema(false);}} style={{...S.btnDanger,width:"100%",marginTop:8}}>Remove FEMA PDF</button>}
      </div>
    </div>
  );
}

/* ══ SB DETAIL SHEET ═════════════════════════════════════════════ */
function SbDetailSheet({ sbId, getData, onPatch, onGen, genId, hasFema, pdfReady, pdfErr, showPdf, onAddInvoice, onGotoInvoices, onCreateInvoiceFromSb }) {
  const [localHas, setLocalHas]=useState({});
  const [uploading,setUploading]=useState({});
  const [errors,   setErrors]  =useState({});
  const [editMode, setEditMode]=useState(false);
  const [editVals, setEditVals]=useState({});
  const [genInv,   setGenInv]  =useState(false);   // creating invoice from SB
  const [genInvMsg,setGenInvMsg]=useState(null);   // {ok, text}

  const FLAGS={sb:"hasSbPdf",inv:"hasInvPdf",hawb:"hasHawbPdf",erf:"hasErfPdf",brc:"hasBrcPdf"};
  const d=getData(), sb=d.shippingBills.find(s=>s.id===sbId), firc=sb?d.fircs.find(f=>f.id===sb.fircId):null;
  if (!sb) return <div style={{padding:20,color:C.inkMid}}>SB not found.</div>;
  const has=flag=>localHas[flag]!==undefined?localHas[flag]:sb[flag];
  const isGen=genId===sbId;
  const st=sb.status||"pending";
  const ss=STATUS_STYLE[st];

  async function handleDoc(type,files){
    const file=files[0]; if(!file)return;
    setUploading(u=>({...u,[type]:true})); setErrors(e=>({...e,[type]:null}));
    try{
      const {b64,mime}=await readB64WithMime(file);
      await docs.set(`${type}:${sbId}`,b64,mime);
      await onPatch(sbId,{[FLAGS[type]]:true});
      setLocalHas(h=>({...h,[FLAGS[type]]:true}));
    }catch(e){setErrors(er=>({...er,[type]:e.message}));}
    setUploading(u=>({...u,[type]:false}));
  }
  async function removeDoc(type){
    await docs.del(`${type}:${sbId}`);
    await onPatch(sbId,{[FLAGS[type]]:false});
    setLocalHas(h=>({...h,[FLAGS[type]]:false}));
  }

  // Generate a commercial-invoice draft from the uploaded Shipping Bill (AI)
  async function createInvoiceFromSb(){
    setGenInvMsg(null);
    if(!onCreateInvoiceFromSb){ setGenInvMsg({ok:false,text:"Invoice module isn't available here."}); return; }
    if(!has("hasSbPdf")){ setGenInvMsg({ok:false,text:"Upload the Shipping Bill PDF first (Source document above)."}); return; }
    setGenInv(true);
    try{
      const raw=await docs.get(`sb:${sbId}`);
      if(!raw) throw new Error("Shipping Bill file not found.");
      const {b64,mime}=unpackDoc(raw);
      const ex=await aiInvoiceFromSb(b64,mime);
      const draft=sbToInvoiceDraft(ex, sb);
      learner.track("invoice:create-from-sb");
      onCreateInvoiceFromSb(draft);   // opens the real invoice module, prefilled & editable
    }catch(e){ setGenInvMsg({ok:false,text:`Couldn't read the SB: ${(e.message||"").slice(0,90)}`}); setGenInv(false); }
  }

  const docSlots=[
    {type:"inv", label:"Invoice",                    flag:"hasInvPdf",  note:"PDF, JPG or PNG accepted"},
    {type:"hawb",label:"HAWB",                        flag:"hasHawbPdf", note:"PDF, JPG or PNG accepted"},
    {type:"erf", label:"Export Reconciliation Form",  flag:"hasErfPdf",  note:"Bank-provided, per SB · PDF, JPG or PNG"},
    {type:"brc", label:"BRC Certificate",             flag:"hasBrcPdf",  note:"For forms closed / accepted by the bank · PDF, JPG or PNG"},
  ];
  const packet=[
    {label:"Invoice",                    ready:has("hasInvPdf"), src:"below"},
    {label:"Shipping Bill",              ready:has("hasSbPdf"),  src:"imported"},
    {label:`FIRC${firc?` — ${firc.number}`:""}`,ready:!!firc,  src:"match tab"},
    {label:"FEMA Declaration",           ready:hasFema,          src:"global"},
    {label:"HAWB",                       ready:has("hasHawbPdf"),src:"below"},
    {label:"Export Reconciliation Form", ready:has("hasErfPdf"), src:"below"},
    ...(st==="cleared"||has("hasBrcPdf")?[{label:"BRC Certificate",ready:has("hasBrcPdf"),src:"bank"}]:[]),
  ];
  const readyCount=packet.filter(p=>p.ready).length;

  return (
    <div>
      {/* Header */}
      <div style={{marginBottom:14}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:10}}>
          <div>
            <div style={{fontFamily:FONT,fontSize:22,fontWeight:700,letterSpacing:"-.01em",color:C.ink}}>{sb.sbNumber||"Shipping Bill"}</div>
            <div style={{fontSize:12,color:C.inkMid,marginTop:2}}>{fd(sb.date)} · {fc(sb.amount)}</div>
          </div>
          <button className="pr" onClick={()=>{setEditMode(!editMode);setEditVals({sbNumber:sb.sbNumber,date:sb.date,amount:sb.amount});}}
            style={{...S.btnGhost,padding:"5px 10px",fontSize:11,marginTop:3,flexShrink:0}}>{editMode?"Cancel":"Edit"}</button>
        </div>
        {editMode&&(
          <div style={{background:C.card,borderRadius:10,padding:12,marginTop:10}}>
            {[["SB Number","sbNumber","text"],["Date","date","date"],["FOB Amount","amount","number"]].map(([lbl,k,t])=>(
              <div key={k} style={{marginBottom:8}}>
                <div style={{fontSize:10,color:C.inkMid,marginBottom:3}}>{lbl}</div>
                <input type={t} value={editVals[k]||""} onChange={e=>setEditVals(v=>({...v,[k]:e.target.value}))}
                  style={{width:"100%",border:`1.5px solid ${C.border}`,borderRadius:7,padding:"7px 10px",fontSize:13,boxSizing:"border-box"}}/>
              </div>
            ))}
            <button className="pr" onClick={async()=>{await onPatch(sbId,editVals);setEditMode(false);}} style={{...S.btnDark,width:"100%",padding:"9px",marginTop:4}}>Save changes</button>
          </div>
        )}
        <div style={{display:"flex",gap:8,marginTop:10,flexWrap:"wrap"}}>
          {firc
            ?<span style={{background:C.greenBg,color:C.green,fontSize:11,fontWeight:500,padding:"3px 10px",borderRadius:20}}>✓ FIRC: {firc.number}</span>
            :<span style={{background:C.amberBg,color:C.amber,fontSize:11,padding:"3px 10px",borderRadius:20}}>⚠ No FIRC assigned</span>
          }
          <span style={{background:ss.bg,color:ss.color,fontSize:11,fontWeight:600,padding:"3px 10px",borderRadius:20}}>{ss.label}</span>
        </div>
      </div>

      {/* Packet checklist */}
      <div style={{background:C.card,borderRadius:10,padding:"12px 14px",marginBottom:12}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
          <div style={{fontSize:12,fontWeight:600,color:C.inkMid}}>Packet — {packet.length} documents</div>
          <div style={{fontSize:11,color:readyCount===packet.length?C.greenBright:C.inkMid}}>{readyCount}/{packet.length} ready</div>
        </div>
        {packet.map(p=>(
          <div key={p.label} style={{display:"flex",alignItems:"center",gap:8,padding:"5px 0",borderBottom:`1px solid ${C.border}`}}>
            <span style={{fontSize:13,width:18,textAlign:"center",color:p.ready?C.greenBright:C.borderHi}}>{p.ready?"✓":"○"}</span>
            <span style={{flex:1,fontSize:12,color:p.ready?C.ink:C.inkMid}}>{p.label}</span>
            <span style={{fontSize:10,color:C.inkFaint}}>{p.src}</span>
          </div>
        ))}
      </div>

      {/* Source document — the Shipping Bill itself (re-upload / replace) */}
      {(()=>{
        const hasDoc=has("hasSbPdf"), isUp=uploading.sb, err=errors.sb;
        return (
          <div className="ri" style={{marginBottom:8,border:`1px solid ${hasDoc?C.border:C.amber}`}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:6}}>
              <div>
                <div style={{fontSize:13,fontWeight:600,color:C.inkMid}}>Shipping Bill <span style={{fontSize:10,color:C.inkFaint}}>· source document</span></div>
                <div style={{fontSize:11,color:hasDoc?C.inkMid:C.amber}}>{hasDoc?"PDF on file · re-upload to replace":"No file stored — upload the SB PDF"}</div>
              </div>
              {hasDoc&&<span style={{fontSize:11,color:C.green,background:C.greenBg,padding:"2px 8px",borderRadius:12}}>✓</span>}
            </div>
            {err&&<div style={{fontSize:11,color:C.red,background:C.redBg,borderRadius:6,padding:"4px 8px",marginBottom:6,wordBreak:"break-all"}}>Error: {err}</div>}
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              <InlineUpload label={hasDoc?"Replace SB":"Upload SB"} uploading={isUp} onFiles={f=>handleDoc("sb",f)} imagesOk={true}/>
              {hasDoc&&<button className="pr" onClick={()=>showPdf(`sb:${sbId}`,`SB ${sb.sbNumber}`)} style={{...S.btnGhost,padding:"7px 10px",fontSize:11}}>View</button>}
            </div>
          </div>
        );
      })()}

      {/* Doc slots */}
      {docSlots.map(({type,label,flag,note})=>{
        const hasDoc=has(flag), isUp=uploading[type], err=errors[type];
        return (
          <div key={type} className="ri" style={{marginBottom:8}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:6}}>
              <div>
                <div style={{fontSize:13,fontWeight:600,color:C.inkMid}}>{label}</div>
                {note&&<div style={{fontSize:11,color:C.inkMid}}>{note}</div>}
              </div>
              {hasDoc&&<span style={{fontSize:11,color:C.green,background:C.greenBg,padding:"2px 8px",borderRadius:12}}>✓</span>}
            </div>
            {err&&<div style={{fontSize:11,color:C.red,background:C.redBg,borderRadius:6,padding:"4px 8px",marginBottom:6,wordBreak:"break-all"}}>Error: {err}</div>}
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              <InlineUpload label={hasDoc?"Replace":"Upload"} uploading={isUp} onFiles={f=>handleDoc(type,f)} imagesOk={true}/>
              {type==="inv"&&onCreateInvoiceFromSb&&(
                <button className="pr" onClick={createInvoiceFromSb} disabled={genInv}
                  style={{...S.btnGhost,padding:"7px 10px",fontSize:11,borderColor:C.gold,color:C.gold,display:"flex",alignItems:"center",gap:5}}>
                  {genInv?<><Spin/> Reading SB…</>:"✨ Create invoice from SB"}
                </button>
              )}
              {hasDoc&&<>
                <button className="pr" onClick={()=>showPdf(`${type}:${sbId}`,label)} style={{...S.btnGhost,padding:"7px 10px",fontSize:11}}>View</button>
                <button className="pr" onClick={()=>removeDoc(type)} style={{...S.btnDanger,padding:"7px 10px",fontSize:11}}>Remove</button>
              </>}
            </div>
            {type==="inv"&&genInvMsg&&(
              <div style={{fontSize:11,marginTop:7,padding:"7px 9px",borderRadius:7,lineHeight:1.45,
                background:genInvMsg.ok?C.greenBg:C.redBg, color:genInvMsg.ok?C.green:C.red}}>
                {genInvMsg.ok?"✓ ":"⚠ "}{genInvMsg.text}
                {genInvMsg.ok&&onGotoInvoices&&<> <button className="pr" onClick={onGotoInvoices} style={{...S.btnGhost,padding:"3px 9px",fontSize:11,marginLeft:6}}>Open Invoices →</button></>}
              </div>
            )}
          </div>
        );
      })}

      {/* Generate */}
      <div style={{marginTop:14}}>
        {!firc&&<Tip yellow>Assign a FIRC in the Match tab first</Tip>}
        {pdfErr&&<Tip red>{pdfErr}</Tip>}
        {!pdfReady&&!pdfErr&&<Tip>⟳ Loading PDF engine…</Tip>}
        <button className="pr" disabled={!firc||isGen||!pdfReady} onClick={()=>onGen(sbId)}
          style={{...S.btnDark,width:"100%",display:"flex",alignItems:"center",justifyContent:"center",gap:6,fontSize:15,padding:"14px",opacity:(!firc||isGen||!pdfReady)?0.5:1}}>
          {isGen?<><Spin/> Generating packet…</>:"📥 Generate Packet PDF"}
        </button>
        <div style={{fontSize:11,color:C.inkMid,textAlign:"center",marginTop:6}}>Missing docs become placeholder pages</div>
      </div>
    </div>
  );
}

/* ══ SHARED COMPONENTS ═══════════════════════════════════════════ */
function DropZone({label,multi,disabled,fileRef,onFiles,uploading,imagesOk}){
  const accept=imagesOk?ACCEPT_DOCS:"application/pdf";
  return (
    <div style={{marginBottom:14}}>
      <input ref={fileRef} type="file" accept={accept} multiple={multi} style={{display:"none"}} onChange={e=>{if(!disabled&&e.target.files.length)onFiles(e.target.files);}}/>
      <button className="pr" disabled={disabled||uploading} onClick={()=>fileRef.current?.click()}
        style={{width:"100%",background:disabled?C.card:C.surface,border:`1.5px dashed ${disabled?C.border:C.borderHi}`,borderRadius:12,padding:"16px",fontSize:13,fontWeight:500,color:disabled?C.inkFaint:C.inkMid,cursor:disabled?"not-allowed":"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
        {uploading?<><Spin/> Uploading…</>:disabled?<><Spin/> Processing…</>:<><span style={{fontSize:18}}>📎</span>{label}{imagesOk?" — PDF, JPG, PNG":""}{multi?" (select multiple)":""}</>}
      </button>
    </div>
  );
}
function InlineUpload({label,uploading,onFiles,imagesOk}){
  const ref=useRef();
  const accept=imagesOk?ACCEPT_DOCS:"application/pdf";
  return <>
    <input ref={ref} type="file" accept={accept} style={{display:"none"}} onChange={e=>{if(e.target.files.length)onFiles(e.target.files);e.target.value="";}}/>
    <button className="pr" onClick={()=>ref.current?.click()} disabled={uploading} style={{...S.btnGhost,display:"flex",alignItems:"center",gap:5,fontSize:12}}>
      {uploading?<><Spin/> …</>:`📎 ${label}`}
    </button>
  </>;
}
function LogList({log,onClear,busy}){
  const DOT={queued:C.borderHi,reading:C.gold,extracting:C.gold,saving:C.blue,done:C.greenBright,error:C.red,skipped:C.purple};
  return (
    <div style={{marginBottom:12}}>
      {log.map((r,i)=>(
        <div key={i} style={{display:"flex",alignItems:"flex-start",gap:8,padding:"7px 10px",background:r.status==="error"?C.redBg:r.status==="done"?C.greenBg:r.status==="skipped"?C.purpleBg:C.surface,borderRadius:8,marginBottom:4,border:`1px solid ${C.border}`,fontSize:12}}>
          <span style={{width:8,height:8,borderRadius:"50%",background:DOT[r.status]||C.borderHi,flexShrink:0,marginTop:3,display:"inline-block"}} className={["reading","extracting","saving"].includes(r.status)?"pulse":""}/>
          <div style={{flex:1,minWidth:0}}>
            <div style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",color:C.inkMid}}>{r.name}</div>
            {r.detail&&<div style={{fontSize:11,color:r.status==="error"?C.red:C.inkMid,marginTop:2,wordBreak:"break-all"}}>{r.detail}</div>}
          </div>
          <span style={{fontSize:10,color:DOT[r.status],fontWeight:600,flexShrink:0}}>{r.status}</span>
        </div>
      ))}
      {!busy&&<button className="pr" onClick={onClear} style={{...S.btnGhost,fontSize:12,padding:"6px 12px"}}>Clear log</button>}
    </div>
  );
}

function Btn({ghost,danger,small,onClick,children,disabled}){
  const base=ghost?S.btnGhost:danger?S.btnDanger:S.btnPrimary;
  return <button className="pr" onClick={onClick} disabled={disabled} style={{...base,padding:small?"4px 10px":"8px 16px",fontSize:small?12:13,opacity:disabled?0.5:1}}>{children}</button>;
}
function Tip({children,yellow,green,red}){
  const bg=yellow?C.amberBg:green?C.greenBg:red?C.redBg:C.card;
  const color=yellow?C.amber:green?C.green:red?C.red:C.inkMid;
  return <div style={{fontSize:13,color,background:bg,borderRadius:9,padding:"9px 13px",marginBottom:10,lineHeight:1.5}}>{children}</div>;
}
function Spin(){return <span className="spin">⟳</span>;}
function Loader(){return <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"60vh",fontFamily:FONT,fontSize:15,color:C.inkFaint}}><span className="spin" style={{marginRight:8}}>⟳</span>Loading…</div>;}
function PH({title,sub}){return <div style={{marginBottom:22}}><div style={{fontFamily:FONT,fontSize:mob?22:26,fontWeight:700,letterSpacing:"-.02em",color:C.ink,lineHeight:1.1}}>{title}</div>{sub&&<div style={{fontSize:13,color:C.inkMid,marginTop:4}}>{sub}</div>}</div>;}
function SecTitle({children}){return <div style={{fontSize:11,fontWeight:600,color:C.inkFaint,textTransform:"uppercase",letterSpacing:"0.6px",marginBottom:10,marginTop:18}}>{children}</div>;}
function Empty({icon,text}){return <div style={{textAlign:"center",padding:"60px 20px",color:C.inkFaint}}><div style={{fontSize:42,marginBottom:12}}>{icon}</div><div style={{fontSize:14}}>{text}</div></div>;}

/* Plain-language onboarding guide. Collapsible + remembered, so it helps newcomers
   without nagging power users. Steps double as quick-nav into the matching tabs. */
const HOWTO_STEPS=[
  {key:"fircs", n:1, icon:"💵", title:"Add FIRCs",          desc:"Bank certificates proving you received the foreign payment for your exports."},
  {key:"sbs",   n:2, icon:"📦", title:"Add Shipping Bills", desc:"Customs documents proving the goods actually left the country."},
  {key:"match", n:3, icon:"⇄",  title:"Match them",         desc:"Allocate each shipping bill against a FIRC, until the money received covers the goods shipped."},
  {key:"sbs",   n:4, icon:"🏦", title:"Generate packet",    desc:"Once a FIRC is fully matched, generate the bank / FEMA submission packet."},
];
function HowItWorks({ setView }){
  const [open,setOpen]=useState(()=>{try{return localStorage.getItem("er-howto-hidden")!=="1";}catch{return true;}});
  const set=v=>{setOpen(v);try{localStorage.setItem("er-howto-hidden",v?"0":"1");}catch{}};
  if(!open) return (
    <button className="pr" onClick={()=>set(true)}
      style={{display:"inline-flex",alignItems:"center",gap:6,background:"transparent",border:`1px solid ${C.border}`,borderRadius:20,padding:"5px 12px",fontSize:12,fontWeight:500,color:C.inkMid,cursor:"pointer",marginBottom:14}}>
      ⓘ New here? How Export Recon works
    </button>
  );
  return (
    <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,padding:mob?"14px 14px 16px":"16px 18px 18px",marginBottom:16,boxShadow:"var(--e-1)"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontSize:15}}>🧭</span>
          <span style={{fontFamily:FONT,fontSize:14,fontWeight:700,color:C.ink}}>How Export Recon works</span>
        </div>
        <button className="pr" onClick={()=>set(false)}
          style={{background:C.fill,border:"none",borderRadius:7,padding:"5px 11px",fontSize:12,fontWeight:500,color:C.inkMid,cursor:"pointer"}}>
          Got it · hide
        </button>
      </div>
      <div style={{display:"grid",gridTemplateColumns:mob?"1fr":"repeat(4,1fr)",gap:9}}>
        {HOWTO_STEPS.map((s,i)=>(
          <button key={i} className="pr" onClick={()=>setView(s.key)}
            style={{textAlign:"left",background:C.card,border:`1px solid ${C.border}`,borderRadius:11,padding:"11px 12px",cursor:"pointer",display:"flex",flexDirection:"column",gap:5}}>
            <div style={{display:"flex",alignItems:"center",gap:7}}>
              <span style={{width:20,height:20,borderRadius:"50%",background:C.goldLight,color:C.amber,fontSize:11,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{s.n}</span>
              <span style={{fontSize:13,fontWeight:700,color:C.ink}}>{s.icon} {s.title}</span>
            </div>
            <div style={{fontSize:11.5,color:C.inkMid,lineHeight:1.45}}>{s.desc}</div>
          </button>
        ))}
      </div>
      <div style={{fontSize:11.5,color:C.inkFaint,marginTop:11,lineHeight:1.5}}>
        Why match? Indian FEMA rules require every export (shipping bill) to be accounted against an inward foreign payment (FIRC). Matching does exactly that — and the packet is your proof for the bank.
      </div>
    </div>
  );
}
function Warn({text}){return <span style={{color:C.amber,fontSize:13}}>{text}</span>;}

/* ══ DOCUMENT VIEWER PANEL ═══════════════════════════════════════ */
function DocViewerPanel({ doc, pdfJs, onClose }) {
  const { url, name, mime, downloadName } = doc;
  const isImage = IMG_MIMES.has(mime||"");
  const canvasRef = useRef([]);
  const [numPages,  setNumPages]  = useState(0);
  const [curPage,   setCurPage]   = useState(1);
  const [scale,     setScale]     = useState(1.4);
  const [loading,   setLoading]   = useState(!isImage);
  const [err,       setErr]       = useState(null);
  const pdfDocRef = useRef(null);
  const renderingRef = useRef(false);

  // Load PDF when url/scale changes
  useEffect(() => {
    if (isImage) return;
    const lib = pdfJs?.current;
    if (!lib) { setErr("PDF viewer not loaded yet — try again in a moment"); setLoading(false); return; }
    setLoading(true); setErr(null); setNumPages(0); setCurPage(1);
    let cancelled = false;
    (async () => {
      try {
        const task = lib.getDocument(url);
        const pdf  = await task.promise;
        if (cancelled) return;
        pdfDocRef.current = pdf;
        setNumPages(pdf.numPages);
        setCurPage(1);
        setLoading(false);
      } catch(e) {
        if (!cancelled) { setErr(e.message); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [url, isImage]);

  // Render current page onto canvas
  useEffect(() => {
    if (isImage || !pdfDocRef.current || numPages === 0) return;
    if (renderingRef.current) return;
    renderingRef.current = true;
    (async () => {
      try {
        const page     = await pdfDocRef.current.getPage(curPage);
        const viewport = page.getViewport({ scale });
        const canvas   = canvasRef.current[0];
        if (!canvas) return;
        canvas.width  = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      } catch(e) { setErr(e.message); }
      renderingRef.current = false;
    })();
  }, [numPages, curPage, scale, isImage]);

  return (
    <div style={{
      position:"fixed", top:0, right:0, bottom:0, width:500,
      background:"#1c1c1e", zIndex:250, display:"flex", flexDirection:"column",
      boxShadow:"-8px 0 40px rgba(0,0,0,0.35)",
    }}>
      {/* Header */}
      <div style={{
        display:"flex", alignItems:"center", justifyContent:"space-between",
        padding:"12px 16px", borderBottom:"1px solid rgba(255,255,255,0.1)", flexShrink:0,
        background:"#2a2a2e",
      }}>
        <div style={{flex:1,minWidth:0,marginRight:10}}>
          <div style={{color:"#fff",fontSize:13,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{name}</div>
          {!isImage && numPages>0 && (
            <div style={{color:"rgba(255,255,255,0.45)",fontSize:11,marginTop:2}}>
              {numPages} page{numPages!==1?"s":""}
            </div>
          )}
        </div>
        <div style={{display:"flex",gap:6,alignItems:"center",flexShrink:0}}>
          {/* Zoom controls for PDF */}
          {!isImage && numPages>0 && <>
            <button onClick={()=>setScale(s=>Math.max(0.6,+(s-0.2).toFixed(1)))} title="Zoom out"
              style={vBtn}>−</button>
            <span style={{color:"rgba(255,255,255,0.6)",fontSize:11,minWidth:32,textAlign:"center"}}>{Math.round(scale*100)}%</span>
            <button onClick={()=>setScale(s=>Math.min(3,+(s+0.2).toFixed(1)))} title="Zoom in"
              style={vBtn}>+</button>
            <div style={{width:1,height:20,background:"rgba(255,255,255,0.15)",margin:"0 4px"}}/>
          </>}
          <a href={url} download={downloadName||name} title="Download"
            style={{...vBtn, textDecoration:"none", display:"flex", alignItems:"center", justifyContent:"center"}}>⬇</a>
          <button onClick={onClose} title="Close" style={{...vBtn, fontWeight:700}}>✕</button>
        </div>
      </div>

      {/* Viewer area */}
      <div style={{flex:1,overflowY:"auto",overflowX:"auto",display:"flex",flexDirection:"column",alignItems:"center",padding:16,gap:12}}>
        {isImage ? (
          <img src={url} alt={name}
            style={{maxWidth:"100%",borderRadius:6,boxShadow:"0 4px 24px rgba(0,0,0,0.5)"}}/>
        ) : loading ? (
          <div style={{color:"rgba(255,255,255,0.5)",marginTop:80,fontSize:14}}>
            <span className="spin" style={{marginRight:8}}>⟳</span>Loading…
          </div>
        ) : err ? (
          <div style={{color:"#f87171",marginTop:60,textAlign:"center",padding:24,fontSize:13}}>
            <div style={{fontSize:32,marginBottom:12}}>⚠</div>
            {err}
            <div style={{marginTop:16}}>
              <a href={url} download={downloadName||name}
                style={{color:C.gold,fontSize:13}}>Download instead ⬇</a>
            </div>
          </div>
        ) : (
          <canvas ref={el=>canvasRef.current[0]=el}
            style={{borderRadius:4,boxShadow:"0 4px 24px rgba(0,0,0,0.5)",maxWidth:"100%"}}/>
        )}
      </div>

      {/* Page nav for multi-page PDFs */}
      {!isImage && numPages>1 && (
        <div style={{
          display:"flex",alignItems:"center",justifyContent:"center",gap:12,
          padding:"10px 16px",borderTop:"1px solid rgba(255,255,255,0.08)",
          background:"#2a2a2e",flexShrink:0,
        }}>
          <button onClick={()=>setCurPage(p=>Math.max(1,p-1))} disabled={curPage===1} style={vBtn}>‹ Prev</button>
          <span style={{color:"rgba(255,255,255,0.7)",fontSize:12,minWidth:80,textAlign:"center"}}>
            Page {curPage} of {numPages}
          </span>
          <button onClick={()=>setCurPage(p=>Math.min(numPages,p+1))} disabled={curPage===numPages} style={vBtn}>Next ›</button>
        </div>
      )}
    </div>
  );
}
const vBtn={
  background:"rgba(255,255,255,0.1)",color:"#fff",border:"none",
  borderRadius:6,padding:"5px 10px",fontSize:12,cursor:"pointer",
  fontFamily:"inherit",
};

/* ══ STYLES ══════════════════════════════════════════════════════ */
const CSS=`
  .er-app *{box-sizing:border-box;}
  .er-app{font-family:${FONT};font-size:14px;color:var(--c-ink);}
  .er-app button,.er-app input,.er-app select{font-family:inherit;}
  .pr{transition:opacity .12s var(--ease,ease),background .12s var(--ease,ease),transform .12s var(--ease,ease);}
  .pr:hover{opacity:.9;}
  .pr:active{opacity:.72;}
  .ri{background:var(--c-surface);border-radius:var(--r-md,12px);padding:16px;margin-bottom:10px;border:1px solid var(--c-border);box-shadow:var(--e-1);transition:transform .2s var(--ease-spring,ease),box-shadow .2s var(--ease,ease),border-color .15s var(--ease,ease);}
  .ri:hover{border-color:var(--c-borderHi);box-shadow:var(--e-2);}
  .chip{display:inline-flex;align-items:center;padding:2px 9px;border-radius:20px;font-size:11px;font-weight:600;}
  .ov{position:fixed;inset:0;background:rgba(0,0,0,.38);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);z-index:200;display:flex;align-items:flex-start;justify-content:flex-end;animation:erFade .18s var(--ease,ease);}
  .sh{background:var(--c-surface);height:100dvh;width:${mob?"100vw":"480px"};max-width:100vw;overflow-y:auto;box-shadow:var(--e-modal);animation:erSlide .24s var(--ease-spring,ease);}
  @keyframes erFade{from{opacity:0}to{opacity:1}}
  @keyframes erSlide{from{transform:translateX(24px);opacity:.4}to{transform:none;opacity:1}}
  @keyframes spin{to{transform:rotate(360deg)}}
  .spin{animation:spin .9s linear infinite;display:inline-block;}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
  .pulse{animation:pulse 1s ease-in-out infinite;}
  /* Segmented tab bar (Apple-style) */
  .er-tabs{display:flex;gap:4px;overflow-x:auto;padding:4px;background:var(--c-card);border:1px solid var(--c-border);border-radius:12px;scrollbar-width:none;}
  .er-tabs::-webkit-scrollbar{display:none;}
  .er-tab{display:inline-flex;align-items:center;gap:7px;padding:7px 14px;border-radius:9px;cursor:pointer;border:none;background:transparent;color:var(--c-inkMid);font-size:13px;font-weight:500;white-space:nowrap;flex:0 0 auto;transition:background .18s var(--ease,ease),color .18s var(--ease,ease),box-shadow .18s var(--ease,ease);}
  .er-tab:hover{color:var(--c-ink);}
  .er-tab.active{background:var(--c-surface);color:var(--c-ink);font-weight:600;box-shadow:var(--e-1);}
  .nav-item{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:9px;cursor:pointer;border:none;background:transparent;width:100%;text-align:left;color:var(--c-inkMid);font-size:13px;font-weight:600;position:relative;transition:background .16s var(--ease,ease),color .16s var(--ease,ease),box-shadow .16s var(--ease,ease);}
  .nav-item:hover{background:var(--c-card);color:var(--c-ink);}
  .nav-item.active{background:${C.greenBg};color:var(--c-ink);font-weight:700;box-shadow:var(--e-1);}
  .nav-item.active::before{content:"";position:absolute;left:0;top:18%;bottom:18%;width:3px;background:${C.gold};border-radius:0 3px 3px 0;}
  .two-col{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
  .three-col{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;}
`;
const S={
  root:       {display:"flex",alignItems:"flex-start",gap:24,minWidth:0,width:"100%"},
  sidebar:    {width:235,background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,display:"flex",flexDirection:"column",flexShrink:0,minHeight:"calc(100dvh - 118px)",maxHeight:"calc(100dvh - 118px)",position:"sticky",top:12,overflow:"hidden",boxShadow:"var(--e-1)"},
  sideHead:   {padding:"18px 16px 12px",borderBottom:`1px solid ${C.border}`},
  logo:       {width:38,height:38,background:C.ink,borderRadius:9,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:FONT,fontWeight:800,color:C.gold,fontSize:13,flexShrink:0,letterSpacing:"-.02em"},
  appName:    {fontFamily:FONT,color:C.ink,fontWeight:800,fontSize:17,lineHeight:1.05,letterSpacing:"-.02em"},
  appSub:     {color:C.inkFaint,fontSize:11,marginTop:3},
  navSection: {flex:1,padding:"10px 8px",overflowY:"auto",display:"flex",flexDirection:"column",gap:4},
  sideFooter: {padding:"12px 16px",borderTop:`1px solid ${C.border}`,background:C.card},
  content:    {flex:1,minWidth:0,transition:"margin-right .25s var(--ease,ease)"},
  btnPrimary: {background:C.gold,color:"#fff",border:"none",borderRadius:9,padding:"8px 18px",fontSize:13,fontWeight:600,cursor:"pointer"},
  btnGhost:   {background:C.fill||"rgba(118,118,128,.10)",color:C.ink,border:`1px solid ${C.border}`,borderRadius:9,padding:"7px 14px",fontSize:13,fontWeight:500,cursor:"pointer"},
  btnDark:    {background:C.ink,color:C.surface,border:"none",borderRadius:9,padding:"9px 18px",fontSize:13,fontWeight:600,cursor:"pointer"},
  btnDel:     {background:C.redBg,color:C.red,border:"none",borderRadius:7,padding:"4px 9px",fontSize:12,cursor:"pointer"},
  btnDanger:  {background:C.redBg,color:C.red,border:`1px solid ${C.red}`,borderRadius:9,padding:"7px 14px",fontSize:13,fontWeight:500,cursor:"pointer"},
  fircPill:   {background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,padding:"12px 14px",marginBottom:8,cursor:"pointer",boxShadow:"var(--e-1)"},
  fircPillActive:{border:`1.5px solid ${C.gold}`,background:C.goldLight,boxShadow:"0 0 0 3px var(--c-goldLight)"},
  matchRow:   {background:C.surface,borderRadius:12,padding:"12px 14px",marginBottom:6,border:`1px solid ${C.border}`,display:"flex",alignItems:"center",gap:10,boxShadow:"var(--e-1)"},
}
