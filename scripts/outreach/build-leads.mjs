#!/usr/bin/env node
/* Merges enriched candidates, drops existing trade buyers and duplicates, scores and tiers
   each shop and writes its email, Instagram DM and two follow-ups.
   node scripts/outreach/build-leads.mjs out.json in1.json [in2.json ...]
   Facts used in drafts are the ones Earth Editions can stand behind: family workshop in Mumbai,
   no minimum order (trade_settings.min_order = 0), photos/video of the actual lot before
   payment, tracking on the day it ships, trade prices at trade.eartheditions.co after approval.
   No prices, discounts or delivery times: those are Sir's call. */
import { readFileSync, writeFileSync } from "node:fs";
import { supa } from "../raj/raj-common.mjs";
const [out, ...ins] = process.argv.slice(2);
const sb = supa();
// Everyone we already deal with: trade buyers, store customers and store orders. (Gmail history
// and Omnisend are checked again by the ERP right before each email goes out: lib/outreach.js.)
const buyers = [];
for (const t of ["trade_buyers", "store_customers", "store_orders"])
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(t).select("email").not("email", "is", null).range(from, from + 999);
    if (error) throw new Error(`${t}: ${error.message}`);
    buyers.push(...data); if (data.length < 1000) break;
  }
const host = u => { try { return new URL(/^https?:/.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };
const FREE = /^(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me|mac|aol|proton|protonmail|gmx|web|t-online|btinternet|bigpond|xtra|orange|free|libero|wanadoo|comcast|att|verizon|nifty|docomo|ezweb|softbank|i\.softbank|au|ocn|so-net|biglobe|excite)\./;
const known = new Set();
// Shops already marked on the Outreach page as our customer, a customer, not interested or bounced
// stay out, even when they turn up again from another source (Etsy vs their website).
const BLOCK = ["ours", "customer", "no", "bounced", "list"];
const normName = n => String(n || "").toLowerCase().replace(/&amp;/g, "&").replace(/[^\p{L}\p{N}]+/gu, "");
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb.from("app_rows").select("data").eq("key", "outreach-leads-v1").eq("deleted", false).range(from, from + 999);
  if (error) throw new Error(error.message);
  for (const { data: o } of data) if (BLOCK.includes(o.stage)) {
    for (const v of [String(o.email || "").toLowerCase(), host(o.website), String(o.instagram || "").toLowerCase(), `name:${normName(o.name)}`]) if (v && v !== "name:") known.add(v);
  }
  if (data.length < 1000) break;
}
// Everyone on the ERP's own mailing list (the Japan list, trade, show customers, store sign-ups).
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb.from("app_rows").select("data").eq("key", "mail-contacts-v1").eq("deleted", false).range(from, from + 999);
  if (error) throw new Error(error.message);
  for (const { data: c } of data) { const e = String(c.email || "").toLowerCase(); if (e) { known.add(e); const d = e.split("@")[1]; if (d && !FREE.test(d)) known.add(d); } }
  if (data.length < 1000) break;
}
// Tokyo Mineral Show exhibitors are fellow dealers who already know Nikhil Gems: never cold-email
// them (Sir, 21 Nov 2026). The list is the show's 2026 exhibitor pages (tms-exhibitors.json).
for (const e of JSON.parse(readFileSync(new URL("./tms-exhibitors.json", import.meta.url), "utf8"))) {
  const h = host(e.website); if (h && !/lit\.link|instagram|linktr|facebook|ameblo|thebase|base\.shop|stores\.jp|creema|minne/.test(h)) known.add(h);
  const m = String(e.email || "").toLowerCase(); if (m) { known.add(m); const d = m.split("@")[1]; if (d && !FREE.test(d)) known.add(d); }
  known.add(`name:${normName(e.name)}`);
}
for (const b of buyers || []) { const e = String(b.email || "").toLowerCase(); if (e) { known.add(e); const d = e.split("@")[1]; if (d && !FREE.test(d)) known.add(d); } }

const WA = "+91 96192 48797", SITE = "https://trade.eartheditions.co";
// Tokyo Mineral Show, Sunshine City, Ikebukuro, from 11 Dec 2026. Mentioned to Japan and Taiwan
// until UNTIL; leads built after that date leave it out (rebuild and re-push to drop it from old drafts).
// 35th Tokyo Mineral Show, 11–14 Dec 2026; Nikhil Gems at 2F (Hall D), booth A4.
const SHOW = { from: "2026-12-11", until: "2026-12-14", booth: "A4", hall: "2F (Hall D)", hall_ja: "2階 Dホール", hall_zh: "2樓 D廳" };
const todayIST = new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10);
const showOn = c => ["JP", "TW"].includes(c) && todayIST <= SHOW.until;
const NO_COLD_EMAIL = new Set(["DE", "AT"]); // UWG: B2B cold email needs presumed consent
// Uncommon stones we work in. Each email names a different handful so no two read alike.
const RARE = ["Thulite", "Variscite", "Pietersite", "Copper Dolomite", "Chrome Diopside", "Hypersthene", "Gem Lepidolite", "Citron Chrysoprase", "Emerald", "Ruby Zoisite", "Arusha Sunstone", "Confetti Sunstone", "Malachite", "Malachite Chrysocolla", "Golden Sapphire", "Stichtite", "Atlantisite", "Pink Opal from Peru", "Pink Opal from Australia", "Polish Flint", "Phosphosiderite", "Yttrium Fluorite", "Bumblebee Jasper", "Brazilian Aquamarine", "Morganite", "Ametrine", "Sunset Sodalite", "Blue Lace Agate", "Kunzite", "Cobalto Calcite", "Afghanite", "Charoite", "Rainbow Obsidian", "Shattuckite", "Quantum Quattro", "Pink Rhodonite from Peru", "Pink Mookaite", "Larimar", "Arfvedsonite", "Chiastolite", "Opalina", "Flower Agate", "Rosetta Jasper", "Pink Scolecite", "Blue Scheelite", "Sieber Agate", "Lizardite", "Rhodusite", "Optical Calcite", "Purple Dumortierite", "Petalite"];
const RARE_JA = ["チャロアイト", "ラリマー", "クンツァイト", "ピーターサイト", "シャッタカイト", "モルガナイト", "アメトリン", "マラカイト", "バリサイト", "スティヒタイト"];
const seedOf = t => [...String(t)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const pick = (arr, n, t) => { const a = [...arr], out = []; let h = seedOf(t); while (out.length < n && a.length) { h = (h * 1103515245 + 12345) >>> 0; out.push(a.splice(h % a.length, 1)[0]); } return out; };
const HOOKS = JSON.parse(readFileSync(new URL("./hooks.json", import.meta.url), "utf8"));
const SHAPES = ["spheres", "palm stones", "hearts", "tumbles", "towers"];
// One honest line about the shop: hand-written for researched shops, otherwise built from their own Etsy facts.
function hookFor(l) {
  const h = HOOKS[l.name] || HOOKS[l.display]; if (h) return h;
  if (l.source === "etsy" && l.sold >= 500) {
    const n = l.sold >= 10000 ? `${Math.floor(l.sold / 1000)}k` : l.sold >= 1000 ? `${(Math.floor(l.sold / 100) / 10).toString()}k` : `${Math.floor(l.sold / 100) * 100}`;
    return l.since ? `${n}+ sales since ${String(l.since).slice(0, 4)} says a lot about how much your customers love your shop.` : `${n}+ sales says a lot about how much your customers love your shop.`;
  }
  return "";
}
const NICE = { spheres: "spheres", palm: "palm stones", hearts: "hearts", tumbled: "tumbles", himalayan: "Himalayan quartz", zeolite: "zeolites", towers: "towers" };
const shapesFrom = l => {
  const t = `${l.signals?.join(" ") || ""} ${l.title || ""} ${l.title_tag || ""} ${l.desc || ""} ${l.blurb || ""}`.toLowerCase();
  const s = new Set(l.signals || []);
  if (/sphere/.test(t)) s.add("spheres"); if (/palm|worry/.test(t)) s.add("palm"); if (/heart/.test(t)) s.add("hearts"); if (/tumble/.test(t)) s.add("tumbled");
  if (/himalaya/.test(t)) s.add("himalayan"); if (/apophyllite|zeolite|cavansite|stilbite/.test(t)) s.add("zeolite"); if (/tower|point/.test(t)) s.add("towers");
  return ["spheres", "palm", "hearts", "tumbled", "himalayan", "zeolite", "towers"].filter(k => s.has(k));
};
const list = a => a.length < 2 ? a.join("") : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`;
const cleanName = n => String(n || "").replace(/&amp;/g, "&").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\s+/g, " ").trim();

function drafts(l, shapes) {
  const name = l.display || cleanName(l.name);
  const offer = shapes.filter(k => ["spheres", "palm", "hearts", "tumbled", "towers"].includes(k));
  const shapeList = [...new Set([...offer.map(k => NICE[k]), ...SHAPES])];
  const liked = shapes.filter(k => NICE[k]).slice(0, 2).map(k => NICE[k]);
  const hook = hookFor(l);
  const rare = pick(RARE, 6, l.name);
  if (l.country === "JP") {
    return {
      language: "ja",
      draft: { subject: "インドの天然石工房より卸のご案内（Earth Editions）", body:
`${name} ご担当者様

突然のご連絡失礼いたします。インド・ムンバイで天然石の研磨工房を営んでおります、Earth Editions（Nikhil Gems）のセジャルと申します。

貴店のウェブサイトを拝見し、ご連絡いたしました。${hook ? hook : "石のセレクションの素晴らしさに惹かれました。"}

弊社では自社工房で研磨したスフィア、パームストーン、ハート、タンブル、タワー、彫刻品などを、1点からキロ単位まで卸売りしております。${pick(RARE_JA, 4, l.name).join("、")}など珍しい石も多く扱っており、特注品や彫刻のご依頼にも、ほぼどのような石でも対応いたします。

また、日本の多くのお店で人気の、マニハール産・マニカラン産のヒマラヤ水晶やゴールデンルチルのロットも、入荷次第ご案内できます。${showOn("JP") ? `\n\n12月11日〜14日、池袋サンシャインシティの東京ミネラルショーに出展いたします（${SHOW.hall_ja}、ブース${SHOW.booth}）。お越しの際は、ぜひ実物の石をご覧いただければ幸いです。\n` : ""}
・原石は鉱山主から直接（ツーソンやジャイプールにて）買い付け、自社工房で研磨しているため、仲介業者はおりません
・最低注文数はございません
・ご購入前に、実際のロットの写真や動画をお送りいたします
・発送当日に追跡番号をお知らせいたします

卸価格は、こちらでご登録いただいた後にご覧いただけます：${SITE}
やり取りは英語が中心となりますが、日本語のメールも翻訳して拝読いたします。

よく売れる石の種類をお知らせいただければ、在庫の写真をお送りいたします。ヒマラヤ水晶の最新ロットの動画もお送りできます。
今すぐのご予定がなければ、「登録希望」とだけご返信ください。新しいロットが入荷した際に、短いご案内をお送りいたします。
今後このようなご案内が不要でしたら、その旨ご返信ください。以後ご連絡はいたしません。

何卒よろしくお願い申し上げます。

セジャル
Earth Editions / Nikhil Gems（インド・ムンバイ）
WhatsApp: ${WA}` },
      dm: `はじめまして。インド・ムンバイの天然石工房 Earth Editions のセジャルと申します。素敵な石のセレクションですね。弊社は原石を直接買い付け、自社工房で研磨したスフィアやパームストーンなどを、珍しい石も含め1点からキロ単位で卸売りしております。マニハール・マニカラン産のヒマラヤ水晶やゴールデンルチルのロットも入荷次第ご案内でき、ご購入前に実際のロットの動画をお送りしています。${showOn("JP") ? `12月11日〜14日の池袋・東京ミネラルショーにも出展いたします（ブース${SHOW.booth}）。` : ""}よろしければ、在庫の写真をお送りしてもよろしいでしょうか？`,
      followups: [
        { day: 4, body: `${name} ご担当者様\n\n先日はご案内をお送りし、失礼いたしました。もしご興味がございましたら、現在の在庫（ヒマラヤ水晶のロット、スフィア・パームストーンなど）の短い動画をお送りいたします。\n\nセジャル / Earth Editions` },
        { day: 10, body: `${name} ご担当者様\n\nこちらが最後のご連絡となります。今後、インドからの仕入れをご検討の際は ${SITE} からいつでもご登録いただけます。WhatsApp（${WA}）でも承ります。新しいロットのご案内だけをご希望の場合は、「登録希望」とご返信ください。\n\n貴店のますますのご発展をお祈り申し上げます。\nセジャル / Earth Editions` },
      ],
    };
  }
  if (l.country === "TW" && l.lang !== "en") {
    const show = showOn("TW") ? `\n\n12月11日至14日，我們將在東京池袋太陽城的東京礦物展（Tokyo Mineral Show）參展：${SHOW.hall_zh}，攤位 ${SHOW.booth}。如果您也會去，很希望能當面讓您看看實品。` : "";
    return {
      language: "zh-TW",
      draft: { subject: `來自印度自家工坊的水晶批發（Earth Editions）`, body:
`${name} 您好，

冒昧來信。我是 Sejal，來自印度孟買的家族水晶研磨工坊 Earth Editions（Nikhil Gems）。

${hook || "看到貴店的水晶選品，非常喜歡，所以想跟您聯繫。"}

我們以公斤或單件批發自家工坊研磨的水晶球、掌心石、愛心、滾石、水晶柱與雕刻件。我們也做很多少見的礦石，例如 ${pick(RARE, 5, l.name).join("、")}，客製訂單與雕刻幾乎任何礦石都能找來。

另外，喜馬拉雅水晶的批次（馬尼哈爾 Manihar、馬尼卡蘭 Manikaran）以及金髮晶，到貨時都可以第一時間通知您，這也是許多日本和台灣店家常備的貨。${show}

店家喜歡跟我們合作的原因：
・沒有中間商：原石由我們自己在圖森（Tucson），有時在齋浦爾（Jaipur）直接向礦主採購，並在自家工坊切磨
・沒有最低訂購量
・付款前會先傳實際批次的照片或影片
・出貨當天提供追蹤號碼

批發目錄在 ${SITE.replace("https://", "")}，申請一次即可看到批發價。或者直接回信告訴我們哪些賣得最好，我會傳相應庫存的照片給您。我們主要以英文溝通，中文來信我們也會翻譯閱讀。

目前沒有採購計畫？回覆「訂閱」即可，有新批次到貨時我們會寄一封簡短通知給您。

祝 生意興隆
Sejal
Earth Editions · Nikhil Gems，孟買
WhatsApp ${WA}

附註：如果不需要這類訊息，回覆「不用了」，我們就不會再打擾。` },
      dm: "",
      followups: [
        { day: 4, body: `${name} 您好，\n\n再跟您打聲招呼。如果有興趣，我可以傳一段目前喜馬拉雅水晶批次（或水晶球、掌心石）的短片給您參考。\n\nSejal / Earth Editions` },
        { day: 10, body: `${name} 您好，\n\n這是我最後一次來信。日後若考慮從印度直接進貨，隨時可在 ${SITE.replace("https://", "")} 申請，或 WhatsApp ${WA}。只想收到新批次通知的話，回覆「訂閱」即可。\n\n祝 生意興隆\nSejal / Earth Editions` },
      ],
    };
  }
  const where = l.segment === "etsy_reseller" ? "your Etsy shop" : l.segment === "physical_shop" && l.city ? `your shop in ${l.city}` : "your shop";
  const opener = `${liked.length ? `I came across ${where} and loved your ${list(liked)}.` : `I came across ${where} and really liked your selection.`}${hook ? ` ${hook}` : ""}`;
  const live = (l.signals || []).includes("live");
  const himalaya = l.country === "TW" || shapes.includes("himalayan");
  const himTxt = l.country === "TW"
    ? "We also supply Himalayan quartz lots as they come in, from Manihar and Manikaran, and golden rutile: the Himalayan pieces so many shops in Japan and Taiwan carry."
    : "Since you carry Himalayan quartz: we supply Manihar and Manikaran quartz and golden rutile lots as they come in.";
  const subject = l.segment === "etsy_reseller" ? `Crystals by the kilo for ${name}, from our workshop in India` : `Wholesale crystals for ${name}, from our workshop in India`;
  const body =
`Hi there,

${opener}

I'm Sejal from Earth Editions, a family crystal workshop in Mumbai. We supply shops by the kilo or by the piece: ${list(shapeList)}, plus carvings.${live ? " We also put together mixed kilo lots that work well for live sales." : ""}

We work in a lot of uncommon stones, like ${list(rare)}, and we can source almost any stone for custom orders and carvings.${himalaya ? `\n\n${himTxt}` : ""}${showOn(l.country) ? `\n\nWe're also exhibiting at the Tokyo Mineral Show at Sunshine City, Ikebukuro, 11–14 December: ${SHOW.hall}, booth ${SHOW.booth}. If you're there, it would be lovely to meet and show you the stones in person.` : ""}

A few things shops like about buying from us:
- no middleman: we buy the rough ourselves from miners in Tucson and sometimes Jaipur, and cut it in our own lapidary
- no minimum order
- we send photos or a video of the exact lot before you pay
- you get tracking the same day it ships

You can see the trade catalogue at ${SITE.replace("https://", "")}: apply once and the trade prices open up. Or just reply with what sells best for you, and I'll send a few photos of matching stock.

Not buying right now? Reply "sign me up" and I'll add you to our trade list: a short email when new lots come in, so you see them first.

Warmly,
Sejal
Earth Editions · Nikhil Gems, Mumbai
WhatsApp ${WA}

P.S. If this isn't for you, reply "no thanks" and I won't write again.`;
  const dm = `Hi! ${liked.length ? `Love your ${list(liked)} 💎` : "Love your crystals 💎"} I'm Sejal from @eartheditions_, a family crystal workshop in Mumbai. We buy the rough ourselves and cut it in our own lapidary, so no middleman. We supply shops by the kilo with no minimum, in lots of uncommon stones like ${list(rare.slice(0, 3))}${showOn(l.country) ? " (and we'll be at the Ikebukuro mineral show from 11 Dec)" : ""}${himalaya ? ", plus Manihar and Manikaran Himalayan quartz and golden rutile lots as they come in" : ""}, and we send a video of the exact lot before you pay. Would it be OK if I sent you a few photos of what we have right now?`;
  const first = shapeList[0];
  return {
    language: "en", draft: { subject, body }, dm,
    followups: [
      { day: 4, body: `Hi again, just bringing this back to the top of your inbox. If it helps, I can send a short video of the ${himalaya ? "Himalayan quartz" : first} lots we have right now, so you can see the quality before anything else.\n\nSejal` },
      { day: 10, body: `Last note from me! If buying direct from India is ever useful, ${SITE.replace("https://", "")} is always open, and you can WhatsApp me on ${WA}. Or reply "sign me up" and I'll just send you a short note when new lots come in. Wishing ${name} a great season.\n\nSejal` },
    ],
  };
}

const seen = new Set(), outL = [];
let dropped = { known: 0, dup: 0, nocontact: 0 };
for (const f of ins) for (const l of JSON.parse(readFileSync(f, "utf8"))) {
  if (l.drop) continue;
  const h = host(l.website), em = String(l.email || "").toLowerCase();
  if ((em && known.has(em)) || (h && known.has(h)) || (em && known.has(em.split("@")[1])) || (l.instagram && known.has(l.instagram.toLowerCase())) || known.has(`name:${normName(l.display || l.name)}`)) { dropped.known++; continue; }
  const k = h || (l.instagram || "").toLowerCase() || l.etsy_url || l.name.toLowerCase();
  if (seen.has(k) || (l.instagram && seen.has(l.instagram.toLowerCase()))) { dropped.dup++; continue; }
  seen.add(k); if (l.instagram) seen.add(l.instagram.toLowerCase());
  const shapes = shapesFrom(l);
  const segment = l.segment || (l.source === "etsy" ? "etsy_reseller" : l.source === "web" && l.city ? "physical_shop" : "online_shop");
  // Email only (Sir, 20 Nov 2026: no Instagram DMs). A shop is reachable only with an email
  // address, and Germany/Austria never (UWG: no cold B2B email).
  const contact = !!l.email && !NO_COLD_EMAIL.has(l.country);
  // Score: fit (shapes we make), size (sales/favourites), reachability.
  let score = shapes.length * 12 + (l.hits || 0) * 4 + (contact ? 25 : 0) + (l.email ? 10 : 0);
  if (l.sold) score += Math.min(30, Math.round(Math.log10(l.sold) * 9));
  if ((l.signals || []).includes("wholesale")) score -= 8; // may already be a supplier
  if ((l.signals || []).includes("live")) score += 8;
  const tier = !contact ? "C" : score >= 70 ? "A" : "B";
  const d = drafts({ ...l, segment }, shapes);
  const channel = "email";
  const why = [
    segment === "etsy_reseller" ? `Etsy shop, ${l.sold?.toLocaleString() || "?"} sales since ${String(l.since || "?").slice(0, 4)}, ${l.listings || "?"} listings` : SEG_WHY(segment, l),
    shapes.length ? `sells ${shapes.map(k => NICE[k]).join(", ")}` : "",
    (l.signals || []).includes("wholesale") ? "mentions wholesale (may buy in bulk already, or be a supplier)" : "",
    !l.email ? "no email address found" : "",
    NO_COLD_EMAIL.has(l.country) ? "Germany/Austria: no cold email" : "",
  ].filter(Boolean).join(" · ");
  outL.push({ name: l.display || cleanName(l.name), country: l.country, city: l.city || "", segment, tier, score, channel, website: l.website || "", email: channel === "email" ? l.email : (l.email || ""),
    instagram: l.instagram || "", etsy_url: l.etsy_url || "", sold: l.sold || null, signals: shapes, platform: l.platform || "", why, ...d, source: l.source });
}
function SEG_WHY(seg, l) { return seg === "physical_shop" ? `Walk-in crystal shop${l.city ? ` in ${l.city}` : ""}` : seg === "live_seller" ? "Live seller" : "Online crystal shop"; }
outL.sort((a, b) => a.tier.localeCompare(b.tier) || b.score - a.score);
writeFileSync(out, JSON.stringify(outL, null, 1));
const by = {}; for (const l of outL) by[`${l.country}-${l.tier}`] = (by[`${l.country}-${l.tier}`] || 0) + 1;
console.log(outL.length, JSON.stringify(dropped), JSON.stringify(by));
