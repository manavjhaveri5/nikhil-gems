import { useState, useEffect } from "react";
import { C, mob, FI } from "./lmTheme.js";

/* Campaign composer — shared by the Omnisend module (primary home) and the
   Listing Manager's contextual "Campaign" button, so both drive one implementation.
   Campaigns are only ever created as drafts here; sending is a separate, confirmed
   action because a blast to the subscriber list cannot be undone. */
export default function CampaignComposer({ listings = [], onClose, showToast }) {
  const [sel, setSel] = useState(() => new Set());
  const [q, setQ] = useState("");
  const [brand, setBrand] = useState("Nikhil Gems");
  const [heading, setHeading] = useState("New arrivals");
  const [subject, setSubject] = useState("");
  const [preheader, setPreheader] = useState("");
  const [intro, setIntro] = useState("");
  const [senderName, setSenderName] = useState("Nikhil Gems");
  const [senderEmail, setSenderEmail] = useState("");
  const [priceMode, setPriceMode] = useState("none");
  /* Design lives in one object so preview and the created draft can never drift
     apart — both are rendered from payloadBase() by the same server function. */
  const [design, setDesign] = useState({
    columns: 2, accent: "#9a6200", ink: "#1a1308", pageBg: "#faf7f2", cardBg: "#ffffff",
    font: "serif", showPrice: true, showMeta: true, showCta: true, showDivider: false,
    cornerStyle: "rounded", ctaStyle: "solid", ctaLabel: "View product",
    headingSize: 27, headerImage: "", footer: "",
  });
  const [designOpen, setDesignOpen] = useState(false);
  const [segments, setSegments] = useState([]);
  const [segIds, setSegIds] = useState(() => new Set());
  const [configured, setConfigured] = useState(null); // null=checking
  const [previewHtml, setPreviewHtml] = useState("");
  const [campaignId, setCampaignId] = useState("");
  const [testTo, setTestTo] = useState("");
  const [testedOk, setTestedOk] = useState(false);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  const post = async payload => {
    const r = await fetch("/api/omnisend", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) throw new Error(d.error || `Request failed (${r.status})`);
    return d;
  };

  useEffect(() => {
    (async () => {
      try {
        const s = await post({ action: "status" });
        setConfigured(!!s.configured && s.valid !== false);
        if (s.configured && s.valid === false) setErr(s.error || "Omnisend rejected the API key.");
        if (s.configured && s.valid !== false) {
          try { const g = await post({ action: "segments" }); setSegments(g.segments || []); } catch {}
        }
      } catch (e) { setConfigured(false); setErr(e.message); }
    })();
  }, []);

  // Money shown per product depends on which storefront the mailer is for —
  // Earth Editions is wholesale/login-to-view, so "no prices" is a first-class option.
  const priceOf = l => {
    if (priceMode === "none") return { price: "", priceValue: null, currency: "" };
    const map = { earth: ["price_shopify_earth", "USD", "$"], aty: ["price_shopify_aty", "INR", "₹"], etsy: ["price_etsy", "INR", "₹"] };
    const [field, currency, sym] = map[priceMode] || [];
    const v = +l[field] || 0;
    if (!v) return { price: "", priceValue: null, currency: "" };
    return { price: `${sym}${v.toLocaleString(currency === "INR" ? "en-IN" : "en-US")}`, priceValue: v, currency };
  };
  const linkOf = l => l.platforms?.shopify_earth?.storefront_url || l.platforms?.shopify_aty?.storefront_url || l.platforms?.etsy?.url || l.platforms?.ebay?.url || "";
  const toProduct = l => ({
    id: l.id, title: l.title || "Untitled",
    image: (l.images || [])[0] || "",
    url: linkOf(l),
    meta: [l.material, l.shape, l.size].filter(Boolean).join(" · "),
    description: l.description || "",
    ...priceOf(l),
  });

  const ql = q.toLowerCase();
  const visible = listings.filter(l => !ql || `${l.title || ""} ${l.material || ""} ${l.sku || ""}`.toLowerCase().includes(ql));
  const chosen = listings.filter(l => sel.has(l.id));
  const products = chosen.map(toProduct);
  const payloadBase = () => ({ brand, heading, intro, products, ...design });

  const toggle = id => setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  // Any edit invalidates the draft that's already in Omnisend.
  const invalidate = () => { setCampaignId(""); setTestedOk(false); };
  // Any design change invalidates the draft already sitting in Omnisend.
  const setD = (k, v) => { setDesign(d => ({ ...d, [k]: v })); invalidate(); };

  const doPreview = async () => {
    setBusy("preview"); setErr("");
    try { const d = await post({ action: "preview", ...payloadBase() }); setPreviewHtml(d.html || ""); }
    catch (e) { setErr(e.message); } finally { setBusy(""); }
  };
  const doCreate = async () => {
    setBusy("create"); setErr("");
    try {
      await post({ action: "sync_products", products }).catch(() => {}); // catalog sync is best-effort
      const d = await post({
        action: "create_campaign", ...payloadBase(),
        name: subject || heading, subject, preheader, senderName, senderEmail: senderEmail || undefined,
        segmentIds: [...segIds],
      });
      setCampaignId(d.campaignId); setTestedOk(false);
      showToast?.("✓ Draft created in Omnisend");
    } catch (e) { setErr(e.message); } finally { setBusy(""); }
  };
  const doTest = async () => {
    setBusy("test"); setErr("");
    try { await post({ action: "test_email", campaignId, emails: [testTo] }); setTestedOk(true); showToast?.(`✓ Test sent to ${testTo}`); }
    catch (e) { setErr(e.message); } finally { setBusy(""); }
  };
  const doSend = async () => {
    const audience = segIds.size ? `${segIds.size} segment(s)` : "ALL subscribers";
    if (!window.confirm(`Send "${subject}" to ${audience}?\n\nThis emails real people and cannot be undone.`)) return;
    if (window.prompt('Type SEND to confirm:') !== "SEND") { showToast?.("Cancelled — nothing sent"); return; }
    setBusy("send"); setErr("");
    try { await post({ action: "send", campaignId, confirm: "SEND" }); showToast?.("📣 Campaign sent"); onClose(); }
    catch (e) { setErr(e.message); } finally { setBusy(""); }
  };

  const card = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14 };
  const lab = { fontSize: 9.5, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .6, marginBottom: 4, display: "block" };

  return (
    <div onClick={e => e.target === e.currentTarget && onClose()} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", zIndex: 1000, display: "flex", alignItems: mob() ? "stretch" : "center", justifyContent: "center", padding: mob() ? 0 : 20 }}>
      <div style={{ background: C.bg, borderRadius: mob() ? 0 : 16, width: "min(1100px,100%)", maxHeight: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 18px", borderBottom: `1px solid ${C.border}`, background: C.surface, flexShrink: 0 }}>
          <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 20, fontWeight: 700, color: C.ink, lineHeight: 1 }}>📣 New-products campaign</div>
          <div style={{ fontSize: 11, color: C.inkFaint }}>{sel.size} selected</div>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={{ background: "transparent", border: `1px solid ${C.border}`, borderRadius: 8, padding: "6px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer", color: C.ink }}>Close</button>
        </div>

        {configured === false && (
          <div style={{ margin: 14, padding: "12px 14px", background: "#fff8e6", border: "1px solid #f0dfae", borderRadius: 10, fontSize: 12.5, color: "#8a6d1a", lineHeight: 1.55, flexShrink: 0 }}>
            <strong>Omnisend isn't connected yet.</strong> Create an API key in Omnisend → <em>API Keys</em>, then add it in Vercel → Settings → Environment Variables as <code>OMNISEND_API_KEY</code> and redeploy. {err && <div style={{ marginTop: 6, color: C.red }}>{err}</div>}
          </div>
        )}

        <div style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: mob() ? "1fr" : "320px 1fr", gap: 14, padding: 14, overflowY: "auto" }}>
          {/* Product picker */}
          <div style={{ ...card, display: "flex", flexDirection: "column", minHeight: 0 }}>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search listings…" style={{ ...FI(), marginBottom: 8 }} />
            <div style={{ flex: 1, overflowY: "auto", maxHeight: mob() ? 260 : 420, display: "flex", flexDirection: "column", gap: 5 }}>
              {visible.length === 0 && <div style={{ fontSize: 12, color: C.inkFaint, padding: 10 }}>No listings match.</div>}
              {visible.map(l => {
                const on = sel.has(l.id);
                return (
                  <label key={l.id} style={{ display: "flex", alignItems: "center", gap: 9, padding: "6px 8px", borderRadius: 8, cursor: "pointer", background: on ? C.tealBg : "transparent", border: `1px solid ${on ? C.teal : "transparent"}` }}>
                    <input type="checkbox" checked={on} onChange={() => { toggle(l.id); invalidate(); }} style={{ accentColor: C.teal }} />
                    {(l.images || [])[0]
                      ? <img src={l.images[0]} alt="" style={{ width: 34, height: 34, borderRadius: 6, objectFit: "cover", flexShrink: 0 }} />
                      : <div style={{ width: 34, height: 34, borderRadius: 6, background: C.card, flexShrink: 0 }} />}
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.title || "Untitled"}</div>
                      <div style={{ fontSize: 10, color: C.inkFaint }}>{[l.material, l.shape].filter(Boolean).join(" · ") || l.sku || ""}{!linkOf(l) && " · no public link"}</div>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>

          {/* Compose + preview */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
            <div style={{ ...card, display: "grid", gap: 10, gridTemplateColumns: mob() ? "1fr" : "1fr 1fr" }}>
              <div style={{ gridColumn: mob() ? "auto" : "1 / -1" }}>
                <label style={lab}>Subject *</label>
                <input value={subject} onChange={e => { setSubject(e.target.value); invalidate(); }} placeholder="Fresh arrivals — hand-picked this week" style={FI()} />
              </div>
              <div><label style={lab}>Preheader</label><input value={preheader} onChange={e => { setPreheader(e.target.value); invalidate(); }} placeholder="Preview text in the inbox" style={FI()} /></div>
              <div><label style={lab}>Heading</label><input value={heading} onChange={e => { setHeading(e.target.value); invalidate(); }} style={FI()} /></div>
              <div style={{ gridColumn: mob() ? "auto" : "1 / -1" }}>
                <label style={lab}>Intro</label>
                <textarea value={intro} onChange={e => { setIntro(e.target.value); invalidate(); }} rows={2} placeholder="A line or two above the products…" style={{ ...FI(), resize: "vertical" }} />
              </div>
              <div><label style={lab}>Brand</label><input value={brand} onChange={e => { setBrand(e.target.value); invalidate(); }} style={FI()} /></div>
              <div><label style={lab}>Sender name *</label><input value={senderName} onChange={e => { setSenderName(e.target.value); invalidate(); }} style={FI()} /></div>
              <div><label style={lab}>Sender email</label><input value={senderEmail} onChange={e => { setSenderEmail(e.target.value); invalidate(); }} placeholder="verified in Omnisend" style={FI()} /></div>
              <div>
                <label style={lab}>Prices shown</label>
                <select value={priceMode} onChange={e => { setPriceMode(e.target.value); invalidate(); }} style={FI()}>
                  <option value="none">No prices (wholesale)</option>
                  <option value="earth">Earth Editions ($)</option>
                  <option value="aty">Atyahara (₹)</option>
                  <option value="etsy">Etsy (₹)</option>
                </select>
              </div>
              <div style={{ gridColumn: mob() ? "auto" : "1 / -1" }}>
                <button type="button" onClick={() => setDesignOpen(o => !o)}
                  style={{ width: "100%", textAlign: "left", background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: "9px 12px", fontSize: 12, fontWeight: 700, color: C.ink, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ transform: designOpen ? "rotate(90deg)" : "none", transition: "transform .15s", fontSize: 10 }}>▸</span>
                  🎨 Design
                  <span style={{ fontWeight: 500, color: C.inkFaint, fontSize: 11 }}>
                    {design.columns === 1 ? "1 column" : "2 columns"} · {design.font === "sans" ? "sans" : "serif"} · {design.cornerStyle}
                  </span>
                  <span style={{ flex: 1 }} />
                  <span style={{ width: 15, height: 15, borderRadius: 4, background: design.accent, border: `1px solid ${C.border}` }} />
                </button>

                {designOpen && (
                  <div style={{ border: `1px solid ${C.border}`, borderTop: "none", borderRadius: "0 0 8px 8px", padding: 12, display: "grid", gap: 12 }}>
                    <div style={{ display: "grid", gridTemplateColumns: mob() ? "1fr 1fr" : "repeat(4, 1fr)", gap: 10 }}>
                      <div>
                        <label style={lab}>Layout</label>
                        <select value={design.columns} onChange={e => setD("columns", +e.target.value)} style={FI()}>
                          <option value={2}>Two columns</option>
                          <option value={1}>One column (big)</option>
                        </select>
                      </div>
                      <div>
                        <label style={lab}>Font</label>
                        <select value={design.font} onChange={e => setD("font", e.target.value)} style={FI()}>
                          <option value="serif">Serif headings</option>
                          <option value="sans">All sans-serif</option>
                        </select>
                      </div>
                      <div>
                        <label style={lab}>Corners</label>
                        <select value={design.cornerStyle} onChange={e => setD("cornerStyle", e.target.value)} style={FI()}>
                          <option value="rounded">Rounded</option>
                          <option value="square">Square</option>
                        </select>
                      </div>
                      <div>
                        <label style={lab}>Button style</label>
                        <select value={design.ctaStyle} onChange={e => setD("ctaStyle", e.target.value)} style={FI()}>
                          <option value="solid">Solid</option>
                          <option value="outline">Outline</option>
                          <option value="link">Text link</option>
                        </select>
                      </div>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: mob() ? "1fr 1fr" : "repeat(4, 1fr)", gap: 10 }}>
                      {[["accent", "Accent"], ["ink", "Text"], ["pageBg", "Page"], ["cardBg", "Card"]].map(([k, label]) => (
                        <div key={k}>
                          <label style={lab}>{label}</label>
                          <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
                            <input type="color" value={design[k]} onChange={e => setD(k, e.target.value)}
                              style={{ width: 34, height: 32, padding: 0, border: `1px solid ${C.border}`, borderRadius: 6, background: "none", cursor: "pointer", flexShrink: 0 }} />
                            <input value={design[k]} onChange={e => setD(k, e.target.value)} style={{ ...FI(), fontSize: 11, padding: "7px 8px" }} />
                          </div>
                        </div>
                      ))}
                    </div>

                    <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                      {[["showPrice", "Show price"], ["showMeta", "Show details"], ["showCta", "Show button"], ["showDivider", "Divider between rows"]].map(([k, label]) => (
                        <label key={k} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.inkMid, cursor: "pointer" }}>
                          <input type="checkbox" checked={design[k]} onChange={e => setD(k, e.target.checked)} /> {label}
                        </label>
                      ))}
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: mob() ? "1fr" : "1fr 1fr 90px", gap: 10 }}>
                      <div>
                        <label style={lab}>Button label</label>
                        <input value={design.ctaLabel} onChange={e => setD("ctaLabel", e.target.value)} placeholder="View product" style={FI()} />
                      </div>
                      <div>
                        <label style={lab}>Logo URL <span style={{ textTransform: "none", fontWeight: 400 }}>(replaces the brand line)</span></label>
                        <input value={design.headerImage} onChange={e => setD("headerImage", e.target.value)} placeholder="https://…" style={FI()} />
                      </div>
                      <div>
                        <label style={lab}>Heading px</label>
                        <input type="number" min={16} max={40} value={design.headingSize} onChange={e => setD("headingSize", +e.target.value)} style={FI()} />
                      </div>
                    </div>

                    <div>
                      <label style={lab}>Footer text <span style={{ textTransform: "none", fontWeight: 400 }}>(above the unsubscribe line Omnisend adds)</span></label>
                      <textarea value={design.footer} onChange={e => setD("footer", e.target.value)} rows={2}
                        placeholder="Studio address, reply-to, shipping note…" style={{ ...FI(), resize: "vertical" }} />
                    </div>

                    <div style={{ fontSize: 10.5, color: C.inkFaint, lineHeight: 1.5 }}>
                      Hit Preview to see changes. Email clients ignore stylesheets, so these map to inline styles and table layout — what you preview is what sends.
                    </div>
                  </div>
                )}
              </div>

              <div style={{ gridColumn: mob() ? "auto" : "1 / -1" }}>
                <label style={lab}>Audience {segments.length === 0 && <span style={{ textTransform: "none", fontWeight: 400 }}>— none loaded, will send to all subscribers</span>}</label>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {segments.map(s => {
                    const on = segIds.has(s.id);
                    return <button key={s.id} type="button" onClick={() => { setSegIds(p => { const n = new Set(p); n.has(s.id) ? n.delete(s.id) : n.add(s.id); return n; }); invalidate(); }}
                      style={{ background: on ? C.teal : C.card, color: on ? "#fff" : C.ink, border: `1px solid ${on ? C.teal : C.border}`, borderRadius: 20, padding: "5px 12px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                      {s.name}{s.count != null ? ` · ${s.count}` : ""}
                    </button>;
                  })}
                </div>
              </div>
            </div>

            {err && configured !== false && <div style={{ background: C.redBg, border: `1px solid ${C.red}55`, color: C.red, borderRadius: 10, padding: "9px 12px", fontSize: 12 }}>{err}</div>}

            {previewHtml && (
              <div style={{ ...card, padding: 0, overflow: "hidden" }}>
                <iframe title="Email preview" srcDoc={previewHtml} style={{ width: "100%", height: 380, border: "none", background: "#fff" }} />
              </div>
            )}

            {/* Draft → test → send. Each step gates the next. */}
            <div style={{ ...card, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <button onClick={doPreview} disabled={!products.length || !!busy}
                style={{ background: C.card, color: C.ink, border: `1px solid ${C.border}`, borderRadius: 9, padding: "10px 16px", fontSize: 12.5, fontWeight: 700, cursor: products.length ? "pointer" : "not-allowed", opacity: products.length ? 1 : .5 }}>
                {busy === "preview" ? "Rendering…" : "Preview"}
              </button>
              <button onClick={doCreate} disabled={!products.length || !subject || !senderName || configured === false || !!busy}
                style={{ background: C.ink, color: "#FAF0DC", border: "none", borderRadius: 9, padding: "10px 16px", fontSize: 12.5, fontWeight: 700, cursor: "pointer", opacity: (!products.length || !subject || !senderName || configured === false) ? .4 : 1 }}>
                {busy === "create" ? "Creating…" : campaignId ? "Recreate draft" : "Create draft"}
              </button>
              {campaignId && <>
                <input value={testTo} onChange={e => setTestTo(e.target.value)} placeholder="you@example.com" style={{ ...FI(), width: 190 }} />
                <button onClick={doTest} disabled={!testTo || !!busy}
                  style={{ background: C.tealBg, color: C.teal, border: `1px solid ${C.teal}`, borderRadius: 9, padding: "10px 16px", fontSize: 12.5, fontWeight: 700, cursor: testTo ? "pointer" : "not-allowed", opacity: testTo ? 1 : .5 }}>
                  {busy === "test" ? "Sending…" : "Send test"}
                </button>
                <div style={{ flex: 1 }} />
                <button onClick={doSend} disabled={!testedOk || !!busy}
                  title={testedOk ? "" : "Send yourself a test first"}
                  style={{ background: testedOk ? C.red : C.card, color: testedOk ? "#fff" : C.inkFaint, border: `1px solid ${testedOk ? C.red : C.border}`, borderRadius: 9, padding: "10px 20px", fontSize: 12.5, fontWeight: 700, cursor: testedOk ? "pointer" : "not-allowed" }}>
                  {busy === "send" ? "Sending…" : "Send to list →"}
                </button>
              </>}
            </div>
            <div style={{ fontSize: 11, color: C.inkFaint, lineHeight: 1.6 }}>
              The draft is created in Omnisend — you can also open it there to tweak the design. Omnisend appends its own unsubscribe footer to campaigns; confirm it's present in the test email before sending. Sending is irreversible.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
