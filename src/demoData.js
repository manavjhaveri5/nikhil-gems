// ─── DEMO DATA — shown when VITE_DEMO_MODE=true ───────────────────────────
// All names, amounts, and details are fictional.

const d = (daysAgo) => {
  const dt = new Date();
  dt.setDate(dt.getDate() - daysAgo);
  return dt.toISOString().slice(0, 10);
};

export const DEMO_DATA = {

  // ── VENDORS ──────────────────────────────────────────────────────────────
  "ng-vendors-v5": [
    { id:"vnd-1", name:"Rajasthan Gems & Minerals", companyName:"RGM Exports Pvt. Ltd.", gstin:"08AABCR1234A1Z5", location:"Jaipur, Rajasthan", country:"India", contact:"+91 98110 22334", email:"sales@rgmexports.com", notes:"Net-30 terms. Primary amethyst & quartz supplier.", files:[], creditBalance:0 },
    { id:"vnd-2", name:"Crystal Cave Exports", companyName:"", gstin:"24AADCC5678B2Z3", location:"Khambhat, Gujarat", country:"India", contact:"+91 97260 44556", email:"info@crystalcave.in", notes:"Specialises in agate, chalcedony, jasper.", files:[], creditBalance:5000 },
    { id:"vnd-3", name:"Himalayan Stone Works", companyName:"HSW Trading Co.", gstin:"", pan:"AAEPH1234C", location:"Dehradun, Uttarakhand", country:"India", contact:"+91 94120 77889", email:"himalayan.stones@gmail.com", notes:"Himalayan quartz, pyrite, garnets. Cash preferred.", files:[], creditBalance:0 },
    { id:"vnd-4", name:"Amjad & Sons Minerals", companyName:"", gstin:"", pan:"AAQFA5678D", location:"Hyderabad, Telangana", country:"India", contact:"+91 99480 11223", email:"amjad.minerals@yahoo.com", notes:"Rough sapphire, tourmaline.", files:[], creditBalance:0 },
    { id:"vnd-5", name:"South India Lapidary", companyName:"SIL Industries", gstin:"33AABCS9012E3Z6", location:"Coimbatore, Tamil Nadu", country:"India", contact:"+91 96000 33445", email:"sil@lapidary.in", notes:"Polished palmstones, spheres, tumbled stones.", files:[], creditBalance:12000 },
  ],

  // ── PURCHASES / BILLS ─────────────────────────────────────────────────────
  "ng-purch-v5": [
    { id:"pur-1", type:"bill", supplier:"Rajasthan Gems & Minerals", billNumber:"INV-RGM-0041", date:d(12), billDate:d(12), totalAmount:185000, paidAmount:185000, status:"paid", items:[{id:"i1",desc:"Amethyst Cluster",hsn:"7103",gst:"3",qty:"45",unit:"kg",rate:"3200"},{id:"i2",desc:"Rose Quartz Palmstone",hsn:"7103",gst:"3",qty:"120",unit:"pcs",rate:"380"}], notes:"Autumn batch — AAA grade amethyst" },
    { id:"pur-2", type:"bill", supplier:"Crystal Cave Exports", billNumber:"INV-CCE-0019", date:d(28), billDate:d(28), totalAmount:92500, paidAmount:46250, status:"partial", items:[{id:"i3",desc:"Blue Chalcedony Tumbled",hsn:"7103",gst:"3",qty:"200",unit:"pcs",rate:"280"},{id:"i4",desc:"Green Agate Slab",hsn:"7103",gst:"3",qty:"15",unit:"kg",rate:"2800"}], notes:"50% advance paid, balance on delivery" },
    { id:"pur-3", type:"bill", supplier:"Himalayan Stone Works", billNumber:"HSW-2024-112", date:d(45), billDate:d(45), totalAmount:67000, paidAmount:67000, status:"paid", items:[{id:"i5",desc:"Clear Quartz Tower",hsn:"7103",gst:"3",qty:"30",unit:"pcs",rate:"1500"},{id:"i6",desc:"Himalayan Pyrite Cluster",hsn:"7103",gst:"3",qty:"18",unit:"pcs",rate:"900"}], notes:"" },
    { id:"pur-4", type:"bill", supplier:"Amjad & Sons Minerals", billNumber:"ASM-0088", date:d(60), billDate:d(60), totalAmount:245000, paidAmount:0, status:"pending", items:[{id:"i7",desc:"Blue Sapphire Rough",hsn:"7103",gst:"0.25",qty:"500",unit:"carats",rate:"480"},{id:"i8",desc:"Pink Tourmaline Rough",hsn:"7103",gst:"0.25",qty:"300",unit:"carats",rate:"120"}], notes:"Payment due in 15 days" },
    { id:"pur-5", type:"bill", supplier:"South India Lapidary", billNumber:"SIL-INV-0234", date:d(8), billDate:d(8), totalAmount:54000, paidAmount:54000, status:"paid", items:[{id:"i9",desc:"Labradorite Sphere",hsn:"7103",gst:"3",qty:"24",unit:"pcs",rate:"1800"},{id:"i10",desc:"Black Tourmaline Chips",hsn:"7103",gst:"3",qty:"10",unit:"kg",rate:"600"}], notes:"" },
    { id:"pur-6", type:"bill", supplier:"Crystal Cave Exports", billNumber:"INV-CCE-0023", date:d(5), billDate:d(5), totalAmount:38500, paidAmount:0, status:"pending", items:[{id:"i11",desc:"Carnelian Tumbled",hsn:"7103",gst:"3",qty:"300",unit:"pcs",rate:"95"},{id:"i12",desc:"Malachite Slice",hsn:"7103",gst:"3",qty:"8",unit:"pcs",rate:"1300"}], notes:"New order — awaiting invoice confirmation" },
  ],

  // ── PHYSICAL STOCK ────────────────────────────────────────────────────────
  "ng-stock-v5": [
    { id:"stk-1",  material:"Amethyst",       shape:"Cluster",    productType:"Mineral",  size:"8–12 cm",  grade:"AAA", hsn:"7103", qty:"22",  unit:"pcs", qty2:"31.5", unit2:"kg",  costPrice:"3200", location:"BOX-01", market:["USA","Japan"], photographed:true,  postedShopify:true,  postedWix:false, postedEtsy:true,  photo:"", notes:"Deep purple, Uruguayan origin", addedDate:d(12), source:"manual", sku:"AME-CLU-001", vendor:"Rajasthan Gems & Minerals" },
    { id:"stk-2",  material:"Rose Quartz",    shape:"Palmstone",  productType:"Lapidary", size:"6–8 cm",   grade:"AA",  hsn:"7103", qty:"85",  unit:"pcs", qty2:"8.5",  unit2:"kg",  costPrice:"380",  location:"BOX-02", market:["USA","Europe"], photographed:true,  postedShopify:true,  postedWix:true,  postedEtsy:true,  photo:"", notes:"",                                   addedDate:d(12), source:"manual", sku:"RQZ-PAL-001", vendor:"Rajasthan Gems & Minerals" },
    { id:"stk-3",  material:"Blue Chalcedony",shape:"Tumbled",    productType:"Lapidary", size:"2–4 cm",   grade:"A",   hsn:"7103", qty:"180", unit:"pcs", qty2:"4.2",  unit2:"kg",  costPrice:"280",  location:"BOX-03", market:["Etsy","General"], photographed:false, postedShopify:false, postedWix:false, postedEtsy:false, photo:"", notes:"",                                   addedDate:d(28), source:"manual", sku:"CHD-TUM-001", vendor:"Crystal Cave Exports" },
    { id:"stk-4",  material:"Green Agate",    shape:"Slab",       productType:"Lapidary", size:"15–20 cm", grade:"AA",  hsn:"7103", qty:"11",  unit:"pcs", qty2:"9.8",  unit2:"kg",  costPrice:"2800", location:"STK-A1", market:["USA","India"], photographed:true,  postedShopify:true,  postedWix:false, postedEtsy:false, photo:"", notes:"Display grade",                       addedDate:d(28), source:"manual", sku:"AGT-SLB-001", vendor:"Crystal Cave Exports" },
    { id:"stk-5",  material:"Clear Quartz",   shape:"Tower",      productType:"Mineral",  size:"10–14 cm", grade:"A",   hsn:"7103", qty:"18",  unit:"pcs", qty2:"7.2",  unit2:"kg",  costPrice:"1500", location:"BOX-04", market:["Japan","USA"], photographed:true,  postedShopify:true,  postedWix:true,  postedEtsy:true,  photo:"", notes:"Brazilian origin",                   addedDate:d(45), source:"manual", sku:"QTZ-TWR-001", vendor:"Himalayan Stone Works" },
    { id:"stk-6",  material:"Pyrite",         shape:"Cluster",    productType:"Mineral",  size:"5–8 cm",   grade:"AA",  hsn:"7103", qty:"14",  unit:"pcs", qty2:"6.3",  unit2:"kg",  costPrice:"900",  location:"BOX-04", market:["Europe","USA"], photographed:false, postedShopify:false, postedWix:false, postedEtsy:false, photo:"", notes:"Himalayan specimens",                addedDate:d(45), source:"manual", sku:"PYR-CLU-001", vendor:"Himalayan Stone Works" },
    { id:"stk-7",  material:"Labradorite",    shape:"Sphere",     productType:"Lapidary", size:"6 cm dia", grade:"AAA", hsn:"7103", qty:"20",  unit:"pcs", qty2:"12.4", unit2:"kg",  costPrice:"1800", location:"BOX-05", market:["USA","Japan"], photographed:true,  postedShopify:true,  postedWix:false, postedEtsy:true,  photo:"", notes:"Exceptional flash",                  addedDate:d(8),  source:"manual", sku:"LAB-SPH-001", vendor:"South India Lapidary" },
    { id:"stk-8",  material:"Black Tourmaline",shape:"Chips",     productType:"Lapidary", size:"1–3 cm",   grade:"A",   hsn:"7103", qty:"8.5", unit:"kg",  qty2:"",     unit2:"kg",  costPrice:"600",  location:"BOX-06", market:["General","India"], photographed:false, postedShopify:false, postedWix:false, postedEtsy:false, photo:"", notes:"For chip bracelets",               addedDate:d(8),  source:"manual", sku:"TRM-CHI-001", vendor:"South India Lapidary" },
    { id:"stk-9",  material:"Carnelian",      shape:"Tumbled",    productType:"Lapidary", size:"2–3 cm",   grade:"A",   hsn:"7103", qty:"280", unit:"pcs", qty2:"3.1",  unit2:"kg",  costPrice:"95",   location:"BOX-07", market:["Etsy","USA"], photographed:false, postedShopify:false, postedWix:false, postedEtsy:false, photo:"", notes:"",                                   addedDate:d(5),  source:"manual", sku:"CAR-TUM-001", vendor:"Crystal Cave Exports" },
    { id:"stk-10", material:"Malachite",      shape:"Slice",      productType:"Mineral",  size:"8–12 cm",  grade:"AA",  hsn:"7103", qty:"7",   unit:"pcs", qty2:"1.8",  unit2:"kg",  costPrice:"1300", location:"BOX-07", market:["USA","Europe"], photographed:false, postedShopify:false, postedWix:false, postedEtsy:false, photo:"", notes:"Congo origin",                      addedDate:d(5),  source:"manual", sku:"MAL-SLC-001", vendor:"Crystal Cave Exports" },
    { id:"stk-11", material:"Celestite",      shape:"Cluster",    productType:"Mineral",  size:"10–14 cm", grade:"AAA", hsn:"7103", qty:"9",   unit:"pcs", qty2:"14.5", unit2:"kg",  costPrice:"2400", location:"BOX-01", market:["USA","Japan"], photographed:true,  postedShopify:true,  postedWix:false, postedEtsy:true,  photo:"", notes:"Madagascar, pale blue",              addedDate:d(20), source:"manual", sku:"CEL-CLU-001", vendor:"Rajasthan Gems & Minerals" },
    { id:"stk-12", material:"Selenite",       shape:"Tower",      productType:"Lapidary", size:"20–25 cm", grade:"A",   hsn:"7103", qty:"35",  unit:"pcs", qty2:"17.5", unit2:"kg",  costPrice:"450",  location:"BOX-08", market:["USA","Etsy"], photographed:true,  postedShopify:true,  postedWix:true,  postedEtsy:true,  photo:"", notes:"",                                   addedDate:d(15), source:"manual", sku:"SEL-TWR-001", vendor:"South India Lapidary" },
    { id:"stk-13", material:"Lapis Lazuli",   shape:"Palmstone",  productType:"Lapidary", size:"6–8 cm",   grade:"AA",  hsn:"7103", qty:"28",  unit:"pcs", qty2:"2.8",  unit2:"kg",  costPrice:"950",  location:"STK-A2", market:["USA","Europe"], photographed:false, postedShopify:false, postedWix:false, postedEtsy:false, photo:"", notes:"Afghan origin, deep blue",          addedDate:d(22), source:"manual", sku:"LAP-PAL-001", vendor:"Himalayan Stone Works" },
    { id:"stk-14", material:"Rhodonite",      shape:"Tumbled",    productType:"Lapidary", size:"3–5 cm",   grade:"A",   hsn:"7103", qty:"150", unit:"pcs", qty2:"4.5",  unit2:"kg",  costPrice:"180",  location:"BOX-09", market:["General"], photographed:false, postedShopify:false, postedWix:false, postedEtsy:false, photo:"", notes:"",                                   addedDate:d(18), source:"manual", sku:"RHO-TUM-001", vendor:"South India Lapidary" },
    { id:"stk-15", material:"Fluorite",       shape:"Sphere",     productType:"Lapidary", size:"7 cm dia", grade:"AA",  hsn:"7103", qty:"12",  unit:"pcs", qty2:"5.2",  unit2:"kg",  costPrice:"2200", location:"BOX-05", market:["Japan","USA"], photographed:true,  postedShopify:true,  postedWix:false, postedEtsy:true,  photo:"", notes:"Rainbow banding",                   addedDate:d(30), source:"manual", sku:"FLU-SPH-001", vendor:"Rajasthan Gems & Minerals" },
  ],

  // ── ACCOUNTING STOCK ──────────────────────────────────────────────────────
  "ng-acc-stock-v1": [
    { id:"acc-1", desc:"Amethyst Cluster",      hsn:"7103", gst:"3",    qty:"22",  unit:"pcs", rate:"3200",  acctCat:"Mineral Specimens",  supplier:"Rajasthan Gems & Minerals", billDate:d(12), notes:"" },
    { id:"acc-2", desc:"Rose Quartz Palmstone", hsn:"7103", gst:"3",    qty:"85",  unit:"pcs", rate:"380",   acctCat:"Lapidary Goods",     supplier:"Rajasthan Gems & Minerals", billDate:d(12), notes:"" },
    { id:"acc-3", desc:"Labradorite Sphere",    hsn:"7103", gst:"3",    qty:"20",  unit:"pcs", rate:"1800",  acctCat:"Lapidary Goods",     supplier:"South India Lapidary",      billDate:d(8),  notes:"" },
    { id:"acc-4", desc:"Clear Quartz Tower",    hsn:"7103", gst:"3",    qty:"18",  unit:"pcs", rate:"1500",  acctCat:"Mineral Specimens",  supplier:"Himalayan Stone Works",     billDate:d(45), notes:"" },
    { id:"acc-5", desc:"Selenite Tower",        hsn:"7103", gst:"3",    qty:"35",  unit:"pcs", rate:"450",   acctCat:"Lapidary Goods",     supplier:"South India Lapidary",      billDate:d(15), notes:"" },
    { id:"acc-6", desc:"Lapis Lazuli Palmstone",hsn:"7103", gst:"3",    qty:"28",  unit:"pcs", rate:"950",   acctCat:"Lapidary Goods",     supplier:"Himalayan Stone Works",     billDate:d(22), notes:"" },
    { id:"acc-7", desc:"Blue Sapphire Rough",   hsn:"7103", gst:"0.25", qty:"500", unit:"carats", rate:"480",acctCat:"Rough Gemstones",   supplier:"Amjad & Sons Minerals",     billDate:d(60), notes:"" },
  ],

  // ── BUYERS ────────────────────────────────────────────────────────────────
  "ng-buyers-v2": [
    { id:"buy-1", name:"Elena Vasquez",    companyName:"Crystal Healing Studio", country:"USA",       port:"New York",    email:"elena@crystalhealingstudio.com", address:"42 West 58th St, New York, NY 10019", notes:"Prefers amethyst and rose quartz. Repeat buyer." },
    { id:"buy-2", name:"Kenji Nakamura",   companyName:"Nakamura Minerals Co.",  country:"Japan",     port:"Tokyo",       email:"kenji@nakamura-minerals.jp",     address:"3-12 Ginza, Chuo-ku, Tokyo 104-0061", notes:"Bulk buyer — mineral specimens for museum retail." },
    { id:"buy-3", name:"Sophie Laurent",   companyName:"Maison Cristal",         country:"France",    port:"Paris",       email:"sophie@maisoncristal.fr",        address:"18 Rue du Faubourg, 75008 Paris", notes:"High-end decorative stones. EUR invoicing." },
    { id:"buy-4", name:"James Hartley",    companyName:"The Crystal Company UK", country:"UK",        port:"London",      email:"james@crystalcompanyuk.com",     address:"14 Portobello Rd, London W11 2DZ", notes:"Wholesale only. Net-30." },
    { id:"buy-5", name:"Priya Mehta",      companyName:"Aura Wellness Pvt. Ltd.",country:"India",     port:"Mumbai",      email:"priya@aurawellness.in",          address:"Bandra Kurla Complex, Mumbai 400051", notes:"INR invoicing. Corporate wellness programmes." },
    { id:"buy-6", name:"Lars Andersen",    companyName:"Scandinavian Stones AB", country:"Sweden",    port:"Stockholm",   email:"lars@scandinavianstones.se",     address:"Vasagatan 12, 111 20 Stockholm", notes:"EUR. Prefers lapidary goods." },
  ],

  // ── INVOICES ──────────────────────────────────────────────────────────────
  "ng-invoices-v2": [
    { id:"inv-1", type:"commercial", invNo:"NG-001/25-26", buyerId:"buy-1", buyerName:"Elena Vasquez",   currency:"USD", totalAmt:4850,  paidAmount:4850,  status:"paid",    date:d(8),  items:[{id:"ii1",desc:"Amethyst Cluster",qty:"5",unit:"pcs",rate:"550",gst:"0",hsn:"7103"},{id:"ii2",desc:"Rose Quartz Palmstone",qty:"20",unit:"pcs",rate:"28",gst:"0",hsn:"7103"}],  notes:"Shipped via FedEx International" },
    { id:"inv-2", type:"commercial", invNo:"NG-002/25-26", buyerId:"buy-2", buyerName:"Kenji Nakamura", currency:"USD", totalAmt:12400, paidAmount:0,     status:"sent",    date:d(14), items:[{id:"ii3",desc:"Clear Quartz Tower",qty:"10",unit:"pcs",rate:"85",gst:"0",hsn:"7103"},{id:"ii4",desc:"Labradorite Sphere",qty:"8",unit:"pcs",rate:"150",gst:"0",hsn:"7103"},{id:"ii5",desc:"Fluorite Sphere",qty:"6",unit:"pcs",rate:"180",gst:"0",hsn:"7103"}], notes:"Port: Tokyo" },
    { id:"inv-3", type:"commercial", invNo:"NG-003/25-26", buyerId:"buy-3", buyerName:"Sophie Laurent",  currency:"EUR", totalAmt:3200,  paidAmount:1600,  status:"partial", date:d(20), items:[{id:"ii6",desc:"Selenite Tower",qty:"12",unit:"pcs",rate:"45",gst:"0",hsn:"7103"},{id:"ii7",desc:"Lapis Lazuli Palmstone",qty:"10",unit:"pcs",rate:"185",gst:"0",hsn:"7103"}], notes:"50% received, balance pending" },
    { id:"inv-4", type:"commercial", invNo:"NG-004/25-26", buyerId:"buy-5", buyerName:"Priya Mehta",    currency:"INR", totalAmt:145000,paidAmount:145000,status:"paid",    date:d(35), items:[{id:"ii8",desc:"Rose Quartz Palmstone",qty:"50",unit:"pcs",rate:"1500",gst:"0",hsn:"7103"},{id:"ii9",desc:"Black Tourmaline Chips",qty:"3",unit:"kg",rate:"8000",gst:"0",hsn:"7103"}], notes:"" },
    { id:"inv-5", type:"proforma",   invNo:"PF-001/25-26", buyerId:"buy-4", buyerName:"James Hartley",  currency:"USD", totalAmt:8900,  paidAmount:0,     status:"sent",    date:d(3),  items:[{id:"ii10",desc:"Amethyst Cluster",qty:"8",unit:"pcs",rate:"480",gst:"0",hsn:"7103"},{id:"ii11",desc:"Celestite Cluster",qty:"5",unit:"pcs",rate:"220",gst:"0",hsn:"7103"}], notes:"Awaiting buyer confirmation" },
    { id:"inv-6", type:"proforma",   invNo:"PF-002/25-26", buyerId:"buy-6", buyerName:"Lars Andersen",  currency:"EUR", totalAmt:2750,  paidAmount:0,     status:"draft",   date:d(1),  items:[{id:"ii12",desc:"Labradorite Sphere",qty:"6",unit:"pcs",rate:"145",gst:"0",hsn:"7103"},{id:"ii13",desc:"Green Agate Slab",qty:"4",unit:"pcs",rate:"220",gst:"0",hsn:"7103"}], notes:"" },
  ],

  // ── EXPENSES ──────────────────────────────────────────────────────────────
  "ng-expenses-v1": [
    { id:"exp-1", date:d(2),  cat:"Courier / Freight", amount:"18500", notes:"FedEx shipment to USA — 3 boxes", vendorId:"", party:"FedEx India" },
    { id:"exp-2", date:d(5),  cat:"Packaging",         amount:"4200",  notes:"Bubble wrap, tissue paper, boxes", vendorId:"", party:"PackRight Supplies" },
    { id:"exp-3", date:d(10), cat:"Custom Duty & Tax", amount:"9800",  notes:"Import charges on rough gemstones", vendorId:"", party:"ICEGATE" },
    { id:"exp-4", date:d(15), cat:"Staff Salary",      amount:"32000", notes:"March salaries — 2 staff", vendorId:"", party:"" },
    { id:"exp-5", date:d(18), cat:"Trade Show Fee",    amount:"25000", notes:"Booth deposit — Tucson 2026", vendorId:"", party:"AGTA" },
    { id:"exp-6", date:d(22), cat:"Office Rent",       amount:"15000", notes:"Monthly office + storage rent", vendorId:"", party:"Shri Properties" },
    { id:"exp-7", date:d(28), cat:"Courier / Freight", amount:"11200", notes:"DHL shipment to Japan — 2 boxes", vendorId:"", party:"DHL Express" },
    { id:"exp-8", date:d(3),  cat:"Photography",       amount:"5500",  notes:"Product photos — new batch", vendorId:"", party:"Studio Click" },
  ],

  // ── FINANCE TRANSACTIONS ──────────────────────────────────────────────────
  "ng-fin-txns-v1": [
    { id:"ft-1", date:d(8),  type:"credit", amount:"4850",   currency:"USD", accountFrom:"fa-boi-0451", payee:"Elena Vasquez",   notes:"Payment for INV NG-001", classifiedRef:{ billNumbers:["NG-001/25-26"], vendorName:"Elena Vasquez" } },
    { id:"ft-2", date:d(12), type:"debit",  amount:"185000", currency:"INR", accountFrom:"fa-boi-0451", payee:"Rajasthan Gems",  notes:"Bill payment RGM-0041",  classifiedRef:null },
    { id:"ft-3", date:d(15), type:"credit", amount:"1600",   currency:"EUR", accountFrom:"fa-boi-0451", payee:"Sophie Laurent",  notes:"Partial payment NG-003", classifiedRef:null },
    { id:"ft-4", date:d(35), type:"credit", amount:"145000", currency:"INR", accountFrom:"fa-boi-0451", payee:"Priya Mehta",     notes:"Full payment NG-004",    classifiedRef:null },
    { id:"ft-5", date:d(45), type:"debit",  amount:"67000",  currency:"INR", accountFrom:"fa-boi-0451", payee:"Himalayan Stone Works", notes:"Bill HSW-2024-112", classifiedRef:null },
  ],

  // ── FINANCE ACCOUNTS ──────────────────────────────────────────────────────
  "ng-fin-accounts-v1": [
    { id:"fa-boi-0451", name:"Bank of India — 0451", type:"bank",   balance:682500, currency:"INR" },
    { id:"fa-cash-01",  name:"Office Cash",          type:"cash",   balance:18000,  currency:"INR" },
    { id:"fa-usd-01",   name:"USD Account",          type:"bank",   balance:8650,   currency:"USD" },
  ],

  // ── GEM SHOWS ─────────────────────────────────────────────────────────────
  "ng-shows-v1": [
    { id:"show-1", name:"Tucson Gem & Mineral Show", location:"Tucson, AZ, USA",     startDate:d(-310), endDate:d(-303), notes:"AGTA booth #A-42. Best show of the year.", status:"upcoming" },
    { id:"show-2", name:"Osaka Mineral Fair",         location:"Osaka, Japan",         startDate:d(-22),  endDate:d(-18),  notes:"Meeting Kenji Nakamura at the show.",   status:"upcoming" },
    { id:"show-3", name:"Jaipur Jewellery Show",      location:"Jaipur, India",        startDate:d(15),   endDate:d(18),   notes:"Source new vendors. Amethyst focus.",   status:"upcoming" },
    { id:"show-4", name:"Munich Mineral Fair",        location:"Munich, Germany",      startDate:d(-185), endDate:d(-182), notes:"Strong EUR sales. 3 new buyers.",       status:"completed" },
  ],

  // ── CALENDAR ──────────────────────────────────────────────────────────────
  "ng-cal-v1": [
    { id:"cal-1", title:"Shipment to Elena Vasquez", date:d(-5),   notes:"FedEx — tracking #789123456",  type:"shipment" },
    { id:"cal-2", title:"Payment due — Crystal Cave", date:d(7),   notes:"Balance ₹46,250 for CCE-0019", type:"payment"  },
    { id:"cal-3", title:"Osaka Mineral Fair departs", date:d(-22), notes:"Flight PNR: ABC123",            type:"travel"   },
    { id:"cal-4", title:"New stock photography",      date:d(-3),  notes:"Studio Click — bring amethyst + labradorite", type:"task" },
    { id:"cal-5", title:"Jaipur buying trip",         date:d(-30), notes:"3 nights — Hotel Pearl Palace", type:"travel"  },
  ],

};
