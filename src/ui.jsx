import React from "react";
import { mob } from "./utils.js";
import { useT } from "./languageContext.jsx";

export const C={
  bg:"var(--c-bg)",surface:"var(--c-surface)",card:"var(--c-card)",border:"var(--c-border)",borderHi:"var(--c-borderHi)",
  ink:"var(--c-ink)",inkMid:"var(--c-inkMid)",inkFaint:"var(--c-inkFaint)",
  gold:"var(--c-gold)",goldLight:"var(--c-goldLight)",goldBright:"var(--c-goldBright)",
  green:"var(--c-green)",greenBg:"var(--c-greenBg)",greenBright:"var(--c-greenBright)",
  red:"var(--c-red)",redBg:"var(--c-redBg)",
  amber:"var(--c-amber)",amberBg:"var(--c-amberBg)",
  blue:"var(--c-blue)",blueBg:"var(--c-blueBg)",
  purple:"var(--c-purple)",purpleBg:"var(--c-purpleBg)",
  teal:"var(--c-teal)",tealBg:"var(--c-tealBg)",
};

export const FI={background:C.surface,border:`1px solid ${C.border}`,color:C.ink,borderRadius:8,padding:"8px 11px",fontSize:mob?16:13,width:"100%",fontFamily:"inherit",transition:"border-color .15s, box-shadow .15s"};
export const CI={...FI,padding:"6px 9px",fontSize:mob?16:12};

export function Tag({c,children}){return <div style={{fontSize:9,fontWeight:600,letterSpacing:.9,color:c||C.inkFaint,textTransform:"uppercase",marginBottom:4}}>{children}</div>;}
export function Field({label,c,children}){
  const t=useT();
  const displayLabel=typeof label==="string"?t(label):label;
  return <div><Tag c={c}>{displayLabel}</Tag>{children}</div>;
}
export function Toast({msg}){if(!msg)return null;return <div style={{position:"fixed",bottom:22,right:22,zIndex:9999,background:C.ink,color:"#fff",padding:"10px 18px",borderRadius:6,fontSize:12,boxShadow:"0 8px 28px rgba(0,0,0,.18)",display:"flex",alignItems:"center",gap:8}}><span style={{color:C.goldBright}}>✓</span>{msg}</div>;}
export function TypeBadge({type}){return <span style={{background:type==="po"?C.amberBg:C.blueBg,color:type==="po"?C.amber:C.blue,border:`1px solid ${type==="po"?"#F0C890":"#B8D0F8"}`,borderRadius:4,padding:"2px 7px",fontSize:10,fontWeight:700,letterSpacing:.4}}>{type==="po"?"ORDER":"BILL"}</span>;}
export function StatusBadge({s}){const m={open:[C.amber,C.amberBg],pending:[C.gold,C.goldLight],confirmed:[C.green,C.greenBg],paid:[C.greenBright,C.greenBg],partial:[C.blue,C.blueBg],"in stock":[C.teal,C.tealBg],expanded:[C.teal,C.tealBg],unpaid:[C.red,C.redBg],closed:[C.inkFaint,C.card]};const [col,bg]=m[s]||[C.inkFaint,C.card];const label=s==="expanded"?"in stock":s;return <span style={{color:col,background:bg,borderRadius:4,padding:"2px 8px",fontSize:10,fontWeight:700}}>{label||"—"}</span>;}
export function MarketTag({market}){
  const colors={"India":[C.green,C.greenBg],"Tucson":[C.amber,C.amberBg],"Denver":[C.blue,C.blueBg],"Japan":[C.purple,C.purpleBg],"Etsy/Online":[C.teal,C.tealBg],"General":[C.inkMid,C.card]};
  const arr=(Array.isArray(market)?market:[market]).filter(m=>m&&m!=="Unassigned");
  if(!arr.length)return null;
  return <>{arr.map(m=>{const [col,bg]=colors[m]||[C.inkMid,C.card];return <span key={m} style={{background:bg,color:col,borderRadius:3,padding:"1px 6px",fontSize:10,fontWeight:600,marginRight:2,display:"inline-block"}}>{m}</span>;})}</>;
}
