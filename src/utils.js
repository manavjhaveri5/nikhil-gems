import { useState, useEffect } from "react";
import { supabase } from "./supabase.js";

export const mob=window.innerWidth<700;

// ── Demo mode: no auth, no Supabase writes, hardcoded data ───────────────────
export const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === "true";

// ── In-memory cache: fetch only requested keys, serve everything from RAM ──
const _cache=new Map();
let _lastFetchAt=0;
const CACHE_TTL=10*60*1000; // 10 min — only re-hit Supabase after this long
const LS_CACHE_KEY="ng-sb-cache-v1";
const LS_CACHE_TS ="ng-sb-cache-ts-v1";
const LS_VERSION_TS="ng-appdata-version-ts-v1";
const _keyFetchedAt=new Map();
let _batchKeys=new Set();
let _batchResolvers=new Map();
let _batchTimer=null;
let _lastLocalSave=new Map();
let _lastVersionTs="";
try{_lastVersionTs=localStorage.getItem(LS_VERSION_TS)||"";}catch{}

let _refreshCallbacks=[];
export const onCacheRefresh=(cb)=>{_refreshCallbacks.push(cb);return()=>{_refreshCallbacks=_refreshCallbacks.filter(x=>x!==cb);};};
const _notifyRefresh=keys=>_refreshCallbacks.forEach(cb=>{try{cb(keys);}catch(e){}});

const DEPRECATED_KEYS=["ng-stock-photos-v1"];
const _isFresh=k=>_cache.has(k)&&(Date.now()-(_keyFetchedAt.get(k)||0))<CACHE_TTL;
const _invalidateKeys=keys=>{
  const wanted=[...new Set((keys||[]).filter(k=>k&&!DEPRECATED_KEYS.includes(k)))];
  if(!wanted.length)return;
  wanted.forEach(k=>{_cache.delete(k);_keyFetchedAt.delete(k);});
  _lastFetchAt=0;
  _persistLS();
  _notifyRefresh(wanted);
};
const _rememberVersionTs=ts=>{
  if(!ts)return;
  if(!_lastVersionTs||new Date(ts).getTime()>new Date(_lastVersionTs).getTime()){
    _lastVersionTs=ts;
    try{localStorage.setItem(LS_VERSION_TS,ts);}catch{}
  }
};
const _safeForLocalCache=(value)=>{
  const scrub=v=>{
    if(typeof v==="string"&&v.startsWith("data:"))return "";
    if(Array.isArray(v))return v.map(scrub);
    if(v&&typeof v==="object"){
      const out={};
      Object.entries(v).forEach(([k,val])=>{
        if(typeof val==="string"&&val.startsWith("data:"))return;
        out[k]=scrub(val);
      });
      return out;
    }
    return v;
  };
  return scrub(value);
};

// Persist current in-memory cache to localStorage (called after every Supabase fetch)
const _persistLS=()=>{
  try{
    const obj={};
    _cache.forEach((v,k)=>{if(!DEPRECATED_KEYS.includes(k))obj[k]=_safeForLocalCache(v);});
    localStorage.setItem(LS_CACHE_KEY,JSON.stringify(obj));
    localStorage.setItem(LS_CACHE_TS,String(Date.now()));
  }catch(e){/* quota exceeded — ignore */}
};

// Load localStorage cache into _cache at startup (zero-latency first paint)
const _loadLS=()=>{
  try{
    const raw=localStorage.getItem(LS_CACHE_KEY);
    const ts =localStorage.getItem(LS_CACHE_TS);
    if(raw&&ts){
      const obj=JSON.parse(raw);
      Object.entries(obj).forEach(([k,v])=>{
        if(DEPRECATED_KEYS.includes(k))return;
        _cache.set(k,v);
        _keyFetchedAt.set(k,parseInt(ts,10)||0);
      });
      _lastFetchAt=parseInt(ts,10)||0;
    }
  }catch(e){}
};
if(!DEMO_MODE)_loadLS();

const _fetchKeys=async(keys,{silent=false}={})=>{
  const wanted=[...new Set(keys.filter(k=>k&&!DEPRECATED_KEYS.includes(k)))];
  if(!wanted.length)return;
  const {data,error}=await supabase.from("app_data").select("key,value").in("key",wanted);
  if(error)throw new Error(error.message);
  const now=Date.now();
  const found=new Set();
  (data||[]).forEach(r=>{
    if(DEPRECATED_KEYS.includes(r.key))return;
    _cache.set(r.key,r.value);
    _keyFetchedAt.set(r.key,now);
    found.add(r.key);
  });
  wanted.forEach(k=>{
    if(!found.has(k)){
      _cache.set(k,[]);
      _keyFetchedAt.set(k,now);
    }
  });
  _lastFetchAt=now;
  _persistLS();
  // silent=true: internal fetch (e.g. pre-merge read in saveStockK) — don't notify
  // UI components, as the cache will be overwritten by the imminent write.
  if(!silent)_notifyRefresh(wanted);
};

const _queueKeyFetch=k=>new Promise((resolve,reject)=>{
  if(!_batchResolvers.has(k))_batchResolvers.set(k,[]);
  _batchResolvers.get(k).push({resolve,reject});
  _batchKeys.add(k);
  if(_batchTimer)return;
  _batchTimer=setTimeout(async()=>{
    const keys=[..._batchKeys];
    const resolvers=_batchResolvers;
    _batchKeys=new Set();
    _batchResolvers=new Map();
    _batchTimer=null;
    try{
      await _fetchKeys(keys);
      keys.forEach(key=>(resolvers.get(key)||[]).forEach(r=>r.resolve(_cache.get(key)||[])));
    }catch(e){
      keys.forEach(key=>(resolvers.get(key)||[]).forEach(r=>r.reject(e)));
    }
  },0);
});

export const warmCache=()=>{
  if(DEMO_MODE)return Promise.resolve();
  // Previous versions downloaded the whole app_data table here. That was costly:
  // large JSON rows made login/tab-focus expensive. Keep warmup local-only and
  // let loadK batch the exact keys each screen needs.
  return Promise.resolve();
};

// Re-fetch on tab return — but throttled: only if cache is stale (>10 min).
// A device that was closed/backgrounded while another device saved misses the live
// invalidate broadcast, so on focus we mark cached keys stale and tell every mounted
// screen to refetch from Supabase — otherwise it keeps showing an old copy forever.
if(typeof document!=="undefined"&&!DEMO_MODE){
  document.addEventListener("visibilitychange",()=>{
    if(document.visibilityState!=="visible")return;
    _catchUpVersions().catch(()=>{});
    if((Date.now()-_lastFetchAt)<CACHE_TTL)return;
    _lastFetchAt=Date.now();
    const keys=[..._cache.keys()].filter(k=>!DEPRECATED_KEYS.includes(k));
    if(!keys.length)return;
    keys.forEach(k=>_keyFetchedAt.delete(k)); // force next loadK/loadKFresh to hit the network
    _notifyRefresh(keys);
  });
  window.addEventListener("online",()=>_catchUpVersions().catch(()=>{}));
}

const _catchUpVersions=async()=>{
  if(DEMO_MODE)return;
  let q=supabase.from("app_data_versions").select("key,ts,rev").order("ts",{ascending:true});
  if(_lastVersionTs)q=q.gt("ts",_lastVersionTs);
  const{data,error}=await q;
  if(error)return; // migration may not be applied yet; broadcast fallback still works
  const rows=(data||[]).filter(r=>r?.key&&!DEPRECATED_KEYS.includes(r.key));
  if(!rows.length)return;
  rows.forEach(r=>_rememberVersionTs(r.ts));
  _invalidateKeys(rows.map(r=>r.key));
};

// Authoritative, low-payload invalidation. The database trigger writes one tiny
// row per changed key into app_data_versions, so clients never receive the large
// JSON app_data payload over realtime. Broadcast remains as a fast fallback until
// every environment has the migration applied.
if(!DEMO_MODE){
  const _versionChannel=supabase.channel("ng-appdata-versions");
  _versionChannel
    .on("postgres_changes",{event:"*",schema:"public",table:"app_data_versions"},payload=>{
      const row=payload?.new||payload?.record||{};
      const k=row.key;
      if(!k||DEPRECATED_KEYS.includes(k))return;
      _rememberVersionTs(row.ts);
      _invalidateKeys([k]);
    })
    .subscribe(status=>{
      if(status==="SUBSCRIBED")_catchUpVersions().catch(()=>{});
    });
  const _dataChannel=supabase.channel("ng-appdata-invalidate");
  _dataChannel
    .on("broadcast",{event:"invalidate"},({payload})=>{
      const k=payload?.key;
      if(!k||DEPRECATED_KEYS.includes(k))return;
      if(_lastLocalSave.get(k)===payload.ts)return;
      _invalidateKeys([k]);
    })
    .subscribe();
  globalThis.__ngVersionChannel=_versionChannel;
  globalThis.__ngDataChannel=_dataChannel;
}

// Synchronous cache read — returns cached value if available (even if stale), null if unknown.
// Use for useState(() => readCache(k) ?? []) to avoid the "Loading..." flash when LS cache is warm.
export const readCache=k=>{
  if(DEMO_MODE)return null;
  return _cache.has(k)?(_cache.get(k)??[]):null;
};

export function useLiveK(key,fallback=[]){
  const [value,setValue]=useState(()=>readCache(key)??fallback);
  useEffect(()=>{
    let cancelled=false;
    loadK(key).then(v=>{if(!cancelled)setValue(v??fallback);}).catch(()=>{});
    return()=>{cancelled=true;};
  },[key]);
  useEffect(()=>onCacheRefresh(keys=>{
    if(!keys.includes(key))return;
    loadK(key).then(v=>setValue(v??fallback)).catch(()=>{});
  }),[key]);
  return value;
}

export const loadK=async k=>{
  if(DEMO_MODE){
    const{DEMO_DATA}=await import("./demoData.js");
    return DEMO_DATA[k]||[];
  }
  if(_isFresh(k))return _cache.get(k);
  if(_cache.has(k)){
    _queueKeyFetch(k).catch(()=>{});
    return _cache.get(k);
  }
  await _queueKeyFetch(k);
  return _cache.has(k)?_cache.get(k):[];
};

export const loadKFresh=async k=>{
  if(DEMO_MODE)return loadK(k);
  await _fetchKeys([k],{silent:true});
  return _cache.has(k)?_cache.get(k):[];
};

// ── Offline write queue ───────────────────────────────────────────────────────
const OQ_KEY="ng-offline-queue-v1";
const _getOQ=()=>{try{return JSON.parse(localStorage.getItem(OQ_KEY)||"[]");}catch{return[];}};
const _setOQ=q=>{try{localStorage.setItem(OQ_KEY,JSON.stringify(q));}catch{}};

// Enqueue a key-value pair (dedup: latest value wins). Store the pre-edit base
// so reconnect sync can merge only the user's offline changes.
const _enqueueWrite=(k,v,base)=>{
  const q=_getOQ();
  const idx=q.findIndex(x=>x.k===k);
  const prevBase=idx>=0?q[idx].base:base;
  if(idx>=0)q[idx]={k,v,base:prevBase,ts:Date.now()};
  else q.push({k,v,base,ts:Date.now()});
  _setOQ(q);
};

// Flush queue → Supabase (called on 'online' event)
export const syncOfflineQueue=async()=>{
  const q=_getOQ();
  if(!q.length)return 0;
  const failed=[];
  for(const item of q){
    try{
      const value=Array.isArray(item.v)?await _mergeArrayAgainstFresh(item.k,item.v,item.base):item.v;
      _cache.set(item.k,value);
      _keyFetchedAt.set(item.k,Date.now());
      _persistLS();
      await _putValueK(item.k,value);
    }catch{failed.push(item);}
  }
  _setOQ(failed);
  return q.length-failed.length; // number successfully synced
};

export const getOfflineQueueCount=()=>_getOQ().length;

const _jsonStable=v=>{try{return JSON.stringify(v??null);}catch{return String(v);}};
const _putValueK=async(k,value)=>{
  const{error}=await supabase.from("app_data").upsert({key:k,value});
  if(error)throw new Error(error.message);
  const ts=Date.now();
  _lastLocalSave.set(k,ts);
  globalThis.__ngDataChannel?.send({type:"broadcast",event:"invalidate",payload:{key:k,ts}}).catch(()=>{});
};
const _mergeArrayAgainstFresh=async(k,next,prev)=>{
  const nextList=_arrayValue(next);
  const prevList=_arrayValue(prev);
  const hasIds=nextList.some(x=>x?.id)||prevList.some(x=>x?.id);
  if(!hasIds)return nextList;

  const fresh=await loadKFresh(k).catch(()=>prevList);
  const freshList=_arrayValue(fresh);
  const prevById=new Map(prevList.filter(x=>x?.id).map(x=>[x.id,x]));
  const freshById=new Map(freshList.filter(x=>x?.id).map(x=>[x.id,x]));
  const nextIds=new Set(nextList.filter(x=>x?.id).map(x=>x.id));
  const deletedIds=new Set(prevList.filter(x=>x?.id&&!nextIds.has(x.id)).map(x=>x.id));
  const out=[];
  const seen=new Set();

  for(const item of nextList){
    if(!item?.id){out.push(item);continue;}
    if(deletedIds.has(item.id))continue;
    const prevItem=prevById.get(item.id);
    const changed=!prevItem||_jsonStable(prevItem)!==_jsonStable(item);
    const freshItem=freshById.get(item.id);
    if(changed)out.push(item);
    else if(freshItem)out.push(freshItem);
    // If a row was unchanged locally and disappeared remotely, respect the remote delete.
    seen.add(item.id);
  }

  for(const item of freshList){
    if(!item?.id||seen.has(item.id)||deletedIds.has(item.id))continue;
    out.push(item);
  }
  return out;
};

export const saveK=async(k,d,{merge=true}={})=>{
  if(DEMO_MODE)return; // no-op — demo data is read-only
  const prev=_cache.has(k)?_cache.get(k):undefined;
  const persisted=_safeForLocalCache(d);
  _cache.set(k,persisted);            // update cache immediately so UI stays snappy
  _keyFetchedAt.set(k,Date.now());
  _persistLS();               // keep localStorage in sync so next load is fresh

  // If offline: queue the write and return — UI already has the latest data
  if(!navigator.onLine){
    _enqueueWrite(k,persisted,prev);
    return;
  }

  const value=merge&&Array.isArray(persisted)?await _mergeArrayAgainstFresh(k,persisted,prev):persisted;
  _cache.set(k,value);
  _keyFetchedAt.set(k,Date.now());
  _persistLS();
  await _putValueK(k,value);
};

const _arrayValue=v=>Array.isArray(v)?v:[];
const _upsertLocalItem=(arr,item,{prepend=true}={})=>{
  const list=_arrayValue(arr);
  const id=item?.id;
  if(!id)return list;
  if(list.some(x=>x?.id===id))return list.map(x=>x?.id===id?item:x);
  return prepend?[item,...list]:[...list,item];
};
const _deleteLocalItem=(arr,id)=>_arrayValue(arr).filter(x=>x?.id!==id);
const _setCachedValue=(k,value)=>{
  _cache.set(k,_safeForLocalCache(value));
  _keyFetchedAt.set(k,Date.now());
  _persistLS();
  _notifyRefresh([k]);
};
const _versionOf=item=>Number.isFinite(+item?._version)?+item._version:0;
export const isConflictError=e=>e?.code==="STALE_RECORD"||/changed in another tab|updated by someone else|stale/i.test(e?.message||"");
const _conflictError=(k,id,result)=>{
  const latest=result?.latest||null;
  const who=latest?.updatedBy||"someone else";
  const when=latest?.updatedAt?new Date(latest.updatedAt).toLocaleString():"recently";
  const err=new Error(`This record was updated by ${who} at ${when}. Reload latest before saving.`);
  err.code="STALE_RECORD";
  err.key=k;
  err.id=id;
  err.latest=latest;
  err.items=Array.isArray(result?.items)?result.items:null;
  return err;
};

export const upsertItemK=async(k,item,{prepend=true}={})=>{
  if(DEMO_MODE)return [];
  if(!item?.id)throw new Error("upsertItemK requires item.id");
  const curr=_cache.has(k)?_cache.get(k):(await loadK(k).catch(()=>[]));
  const optimistic=_upsertLocalItem(curr,item,{prepend});
  _setCachedValue(k,optimistic);

  if(!navigator.onLine){
    _enqueueWrite(k,optimistic,curr);
    return optimistic;
  }

  const{data,error}=await supabase.rpc("app_data_upsert_item",{p_key:k,p_item:item,p_prepend:prepend});
  if(error){
    // Migration not applied yet: keep the app functional and still avoid stale
    // whole-array clobber by merging onto a fresh server copy before saveK.
    if(/app_data_upsert_item|schema cache|function/i.test(error.message||"")){
      const fresh=await loadKFresh(k).catch(()=>optimistic);
      const merged=_upsertLocalItem(fresh,item,{prepend});
      await saveK(k,merged);
      return merged;
    }
    throw new Error(error.message);
  }
  const next=Array.isArray(data)?data:optimistic;
  _setCachedValue(k,next);
  return next;
};

export const deleteItemK=async(k,id)=>{
  if(DEMO_MODE)return [];
  if(!id)throw new Error("deleteItemK requires id");
  const curr=_cache.has(k)?_cache.get(k):(await loadK(k).catch(()=>[]));
  const optimistic=_deleteLocalItem(curr,id);
  _setCachedValue(k,optimistic);

  if(!navigator.onLine){
    _enqueueWrite(k,optimistic,curr);
    return optimistic;
  }

  const{data,error}=await supabase.rpc("app_data_delete_item",{p_key:k,p_id:id});
  if(error){
    if(/app_data_delete_item|schema cache|function/i.test(error.message||"")){
      const fresh=await loadKFresh(k).catch(()=>optimistic);
      const merged=_deleteLocalItem(fresh,id);
      await saveK(k,merged);
      return merged;
    }
    throw new Error(error.message);
  }
  const next=Array.isArray(data)?data:optimistic;
  _setCachedValue(k,next);
  return next;
};

export const upsertVersionedItemK=async(k,item,{prepend=true,user="Admin"}={})=>{
  if(DEMO_MODE)return [];
  if(!item?.id)throw new Error("upsertVersionedItemK requires item.id");
  const expectedVersion=_versionOf(item);
  const optimistic=_upsertLocalItem(_cache.has(k)?_cache.get(k):(await loadK(k).catch(()=>[])),item,{prepend});
  _setCachedValue(k,optimistic);

  if(!navigator.onLine){
    throw new Error("You are offline. Reconnect and reload latest before saving this record.");
  }

  const{data,error}=await supabase.rpc("app_data_upsert_item_versioned",{
    p_key:k,
    p_item:item,
    p_expected_version:expectedVersion,
    p_prepend:prepend,
    p_user:user,
  });
  if(error)throw new Error(error.message);
  if(data?.ok===false||data?.status===409){
    if(Array.isArray(data?.items))_setCachedValue(k,data.items);
    throw _conflictError(k,item.id,data);
  }
  const next=Array.isArray(data?.items)?data.items:optimistic;
  _setCachedValue(k,next);
  return next;
};

export const deleteVersionedItemK=async(k,itemOrId,{user="Admin"}={})=>{
  if(DEMO_MODE)return [];
  const id=typeof itemOrId==="string"?itemOrId:itemOrId?.id;
  if(!id)throw new Error("deleteVersionedItemK requires item id");
  const curr=_cache.has(k)?_cache.get(k):(await loadK(k).catch(()=>[]));
  const item=typeof itemOrId==="string"?_arrayValue(curr).find(x=>x?.id===id):itemOrId;
  const expectedVersion=_versionOf(item);
  const optimistic=_deleteLocalItem(curr,id);
  _setCachedValue(k,optimistic);

  if(!navigator.onLine){
    throw new Error("You are offline. Reconnect and reload latest before deleting this record.");
  }

  const{data,error}=await supabase.rpc("app_data_delete_item_versioned",{
    p_key:k,
    p_id:id,
    p_expected_version:expectedVersion,
    p_user:user,
  });
  if(error)throw new Error(error.message);
  if(data?.ok===false||data?.status===409){
    if(Array.isArray(data?.items))_setCachedValue(k,data.items);
    throw _conflictError(k,id,data);
  }
  const next=Array.isArray(data?.items)?data.items:optimistic;
  _setCachedValue(k,next);
  return next;
};

export const uid=()=>Math.random().toString(36).substr(2,9);
export const today=()=>new Date().toISOString().slice(0,10);

// ── Activity log ─────────────────────────────────────────────────────────────
const ACT_KEY="ng-activity-v1";
const _actChannel=supabase.channel("ng-act-broadcast");
_actChannel.subscribe();

export const logActivity=async(entry)=>{
  if(DEMO_MODE)return;
  try{
    const curr=Array.isArray(_cache.get(ACT_KEY))?_cache.get(ACT_KEY):(await loadK(ACT_KEY)||[]);
    const rec={id:uid(),ts:new Date().toISOString(),...entry};
    const next=[rec,...curr].slice(0,200);
    _cache.set(ACT_KEY,next);
    _keyFetchedAt.set(ACT_KEY,Date.now());
    saveK(ACT_KEY,next).catch(()=>{});
    _actChannel.send({type:"broadcast",event:"act",payload:rec}).catch(()=>{});
  }catch(e){console.warn("logActivity:",e);}
};

export const subscribeActivity=(cb)=>{
  const handler=({payload})=>cb(payload);
  _actChannel.on("broadcast",{event:"act"},handler);
  return()=>{try{_actChannel.off("broadcast",handler);}catch{}};
};
export const fmtDate=d=>d?new Date(d).toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"2-digit"}):"—";
export const daysSince=d=>{if(!d)return null;const ts=new Date(d).getTime();if(isNaN(ts))return null;return Math.floor((Date.now()-ts)/86400000);};
export const inr=n=>n!=null&&n!==""?"₹"+(+n).toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2}):"—";
export const pct=(a,b)=>b?Math.min(100,Math.round(a/b*100)):0;
export const calcGST=(base,gst)=>(+base||0)*(+gst||0)/100;
export const lineBase=(i)=>(+i.qty||0)*(+i.rate||0);
export const lineTotal=(i)=>lineBase(i)+calcGST(lineBase(i),i.gst);
export const billTotal=items=>items.reduce((s,i)=>s+lineTotal(i),0);
export const billSubtotal=items=>items.reduce((s,i)=>s+lineBase(i),0);
export const billGST=items=>items.reduce((s,i)=>s+calcGST(lineBase(i),i.gst),0);

export function useDark(){
  const [dark,setDark]=useState(()=>document.documentElement.classList.contains('dark'));
  const toggle=()=>{const next=!dark;setDark(next);document.documentElement.classList.toggle('dark',next);localStorage.setItem('ng-theme',next?'dark':'light');};
  return[dark,toggle];
}

export function useDebounce(value, delay=300){
  const [debouncedValue, setDebouncedValue]=useState(value);
  useEffect(()=>{
    const timer=setTimeout(()=>setDebouncedValue(value), delay);
    return ()=>clearTimeout(timer);
  },[value,delay]);
  return debouncedValue;
}
