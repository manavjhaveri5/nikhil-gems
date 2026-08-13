import { useState, useEffect, useMemo, useRef } from "react";
import { loadK, upsertItemK, deleteItemK, onCacheRefresh, readCache, uid, fmtDate, logActivity, mob } from "./utils.js";
import { uploadToStorage, removeFromStorage } from "./storageUtils.js";
import { fetchWithRetry } from "./aiClient.js";
import { C, FI } from "./ui.jsx";

export const DOCS_KEY = "ng-documents-v1";

// Categories are fixed so the filter row stays predictable — anything that doesn't
// fit goes in "Other" with tags for the specifics.
export const DOC_CATEGORIES = [
  { id: "identity",  icon: "🪪", label: "Identity & KYC",  hint: "Passport, PAN, Aadhaar, driving licence" },
  { id: "tax",       icon: "🧾", label: "Tax",             hint: "ITR, GST returns, TDS, challans" },
  { id: "utility",   icon: "💡", label: "Utility Bills",   hint: "Electricity, water, gas, internet, phone" },
  { id: "licence",   icon: "📜", label: "Licences",        hint: "IEC, GST certificate, Shop Act, MSME" },
  { id: "property",  icon: "🏠", label: "Property & Rent", hint: "Agreements, tax receipts, society bills" },
  { id: "banking",   icon: "🏦", label: "Banking",         hint: "Statements, AD code letters, loans" },
  { id: "insurance", icon: "🛡️", label: "Insurance",       hint: "Health, fire, transit, vehicle" },
  { id: "vehicle",   icon: "🚗", label: "Vehicle",         hint: "RC book, PUC, permits" },
  { id: "certs",     icon: "🎓", label: "Certificates",    hint: "Degrees, gemmology, awards" },
  { id: "other",     icon: "📁", label: "Other",           hint: "Anything else worth keeping" },
];
const CAT_BY_ID = Object.fromEntries(DOC_CATEGORIES.map(c => [c.id, c]));
const catOf = d => CAT_BY_ID[d?.category] || CAT_BY_ID.other;

// Anything expiring inside this window gets an amber badge and shows in the alert strip.
const EXPIRY_WARN_DAYS = 60;

const newDoc = () => ({
  id: uid(), title: "", category: "identity", owner: "", refNo: "",
  issueDate: "", expiryDate: "", tags: [], notes: "", files: [],
});

const daysUntil = d => {
  if (!d) return null;
  const ts = new Date(d).getTime();
  if (isNaN(ts)) return null;
  return Math.ceil((ts - new Date().setHours(0, 0, 0, 0)) / 86400000);
};
const expiryState = d => {
  const n = daysUntil(d?.expiryDate);
  if (n === null) return null;
  if (n < 0) return { kind: "expired", days: n, label: `Expired ${Math.abs(n)}d ago`, fg: C.red,   bg: C.redBg };
  if (n === 0) return { kind: "soon",   days: n, label: "Expires today",              fg: C.red,   bg: C.redBg };
  if (n <= EXPIRY_WARN_DAYS) return { kind: "soon", days: n, label: `Expires in ${n}d`, fg: C.amber, bg: C.amberBg };
  return { kind: "ok", days: n, label: `Valid till ${fmtDate(d.expiryDate)}`, fg: C.green, bg: C.greenBg };
};

const fileIcon = f => {
  const t = `${f?.type || ""} ${f?.name || ""}`.toLowerCase();
  if (t.includes("pdf")) return "📄";
  if (/image\/|\.(jpe?g|png|gif|webp|heic)/.test(t)) return "🖼️";
  if (/sheet|excel|\.(xlsx?|csv)/.test(t)) return "📊";
  if (/word|\.(docx?)/.test(t)) return "📝";
  return "📎";
};
const fmtSize = b => {
  const n = +b || 0;
  if (!n) return "";
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};
const safeName = n => String(n || "file").replace(/[^\w.\- ]+/g, "_").slice(-80);

function Toast({ msg }) {
  if (!msg) return null;
  return (
    <div style={{ position: "fixed", bottom: mob ? 84 : 24, left: "50%", transform: "translateX(-50%)", background: C.ink, color: "#FAF0DC", borderRadius: 8, padding: "10px 20px", fontSize: 13, fontWeight: 500, zIndex: 9999, boxShadow: "0 4px 20px rgba(0,0,0,.22)", pointerEvents: "none" }}>
      {msg}
    </div>
  );
}

// ── Add / edit form ───────────────────────────────────────────────────────────
function DocForm({ draft, owners, onClose, onSaved, onToast }) {
  const [doc, setDoc] = useState(draft);
  const [tagText, setTagText] = useState((draft.tags || []).join(", "));
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(0);
  const fileRef = useRef(null);
  const set = (k, v) => setDoc(d => ({ ...d, [k]: v }));

  const addFiles = async list => {
    const files = Array.from(list || []);
    if (!files.length) return;
    setUploading(u => u + files.length);
    for (const file of files) {
      try {
        // The random segment keeps the URL unguessable — bucket reads are public.
        const path = `documents/${doc.id}/${uid()}${uid()}-${safeName(file.name)}`;
        const url = await uploadToStorage(path, file);
        setDoc(d => ({
          ...d,
          files: [...(d.files || []), { id: uid(), name: file.name, url, type: file.type || "", size: file.size || 0, uploadedAt: new Date().toISOString() }],
        }));
      } catch (e) {
        onToast(`Upload failed: ${e?.message || file.name}`);
      } finally {
        setUploading(u => u - 1);
      }
    }
    if (fileRef.current) fileRef.current.value = "";
  };

  const dropFile = async f => {
    const url = f?.url;
    setDoc(d => ({ ...d, files: (d.files || []).filter(x => x.id !== f.id) }));
    removeFromStorage(url);
  };

  const save = async () => {
    if (!doc.title.trim()) { onToast("Give the document a title"); return; }
    if (uploading > 0) { onToast("Wait for the upload to finish"); return; }
    setBusy(true);
    const tags = tagText.split(",").map(s => s.trim()).filter(Boolean);
    const record = {
      ...doc,
      title: doc.title.trim(),
      owner: (doc.owner || "").trim(),
      refNo: (doc.refNo || "").trim(),
      tags,
      createdAt: doc.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    try {
      await upsertItemK(DOCS_KEY, record);
      onSaved(record, !doc.createdAt);
    } catch (e) {
      onToast(e?.message || "Could not save");
    } finally {
      setBusy(false);
    }
  };

  const lbl = { fontSize: 9, fontWeight: 700, letterSpacing: .9, color: C.inkFaint, textTransform: "uppercase", marginBottom: 4, display: "block" };
  const row = { display: "grid", gridTemplateColumns: mob ? "1fr" : "1fr 1fr", gap: 12, marginBottom: 12 };

  return (
    <div onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(20,14,4,.45)", zIndex: 900, display: "flex", alignItems: mob ? "flex-end" : "center", justifyContent: "center", padding: mob ? 0 : 24 }}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: C.surface, borderRadius: mob ? "14px 14px 0 0" : 14, width: "100%", maxWidth: 620, maxHeight: mob ? "92dvh" : "88vh", overflowY: "auto", border: `1px solid ${C.border}`, boxShadow: "0 18px 50px rgba(26,19,8,.28)" }}>
        <div style={{ position: "sticky", top: 0, background: C.surface, borderBottom: `1px solid ${C.border}`, padding: "14px 18px", display: "flex", alignItems: "center", gap: 10, zIndex: 2 }}>
          <span style={{ fontSize: 18 }}>{catOf(doc).icon}</span>
          <div style={{ flex: 1, fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 19, fontWeight: 600, color: C.ink }}>
            {doc.createdAt ? "Edit document" : "New document"}
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 20, color: C.inkFaint, lineHeight: 1 }}>×</button>
        </div>

        <div style={{ padding: "16px 18px 20px" }}>
          <div style={{ marginBottom: 12 }}>
            <label style={lbl}>Title *</label>
            <input value={doc.title} onChange={e => set("title", e.target.value)} autoFocus
              placeholder="e.g. Passport — Nikhil, ITR FY 2024-25, Electricity bill — Aug 2026" style={FI} />
          </div>

          <div style={row}>
            <div>
              <label style={lbl}>Category</label>
              <select value={doc.category} onChange={e => set("category", e.target.value)} style={FI}>
                {DOC_CATEGORIES.map(c => <option key={c.id} value={c.id}>{c.icon} {c.label}</option>)}
              </select>
              <div style={{ fontSize: 10, color: C.inkFaint, marginTop: 4 }}>{catOf(doc).hint}</div>
            </div>
            <div>
              <label style={lbl}>Belongs to</label>
              <input value={doc.owner} onChange={e => set("owner", e.target.value)} list="ng-doc-owners"
                placeholder="Person or company" style={FI} />
              <datalist id="ng-doc-owners">{owners.map(o => <option key={o} value={o} />)}</datalist>
            </div>
          </div>

          <div style={row}>
            <div>
              <label style={lbl}>Document number</label>
              <input value={doc.refNo} onChange={e => set("refNo", e.target.value)}
                placeholder="Passport no., PAN, consumer no.…" style={FI} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div>
                <label style={lbl}>Issued</label>
                <input type="date" value={doc.issueDate || ""} onChange={e => set("issueDate", e.target.value)} style={FI} />
              </div>
              <div>
                <label style={lbl}>Expires</label>
                <input type="date" value={doc.expiryDate || ""} onChange={e => set("expiryDate", e.target.value)} style={FI} />
              </div>
            </div>
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={lbl}>Tags</label>
            <input value={tagText} onChange={e => setTagText(e.target.value)}
              placeholder="Comma separated — renewal, mseb, fy2024-25" style={FI} />
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={lbl}>Notes</label>
            <textarea value={doc.notes || ""} onChange={e => set("notes", e.target.value)} rows={2}
              placeholder="Where the original is kept, renewal steps, who to call…" style={{ ...FI, resize: "vertical" }} />
          </div>

          {/* Files */}
          <label style={lbl}>Files</label>
          <div style={{ border: `1.5px dashed ${C.borderHi}`, borderRadius: 10, padding: 12, background: C.card }}>
            {(doc.files || []).map(f => (
              <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 9, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: "7px 10px", marginBottom: 6 }}>
                <span style={{ fontSize: 15 }}>{fileIcon(f)}</span>
                <a href={f.url} target="_blank" rel="noopener noreferrer"
                  style={{ flex: 1, minWidth: 0, fontSize: 12, color: C.ink, textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {f.name}
                </a>
                <span style={{ fontSize: 10, color: C.inkFaint, flexShrink: 0 }}>{fmtSize(f.size)}</span>
                <button onClick={() => dropFile(f)} title="Remove file"
                  style={{ background: "none", border: "none", cursor: "pointer", color: C.red, fontSize: 15, lineHeight: 1, padding: 0 }}>×</button>
              </div>
            ))}
            {uploading > 0 && <div style={{ fontSize: 12, color: C.inkMid, padding: "4px 2px" }}>Uploading {uploading} file{uploading > 1 ? "s" : ""}…</div>}
            <input ref={fileRef} type="file" multiple accept="application/pdf,image/*,.doc,.docx,.xls,.xlsx,.csv"
              onChange={e => addFiles(e.target.files)} style={{ display: "none" }} />
            <button onClick={() => fileRef.current?.click()}
              style={{ background: C.surface, border: `1px solid ${C.borderHi}`, borderRadius: 7, padding: "7px 14px", fontSize: 12, fontWeight: 600, color: C.ink, cursor: "pointer", fontFamily: "inherit" }}>
              + Add scan or PDF
            </button>
            <div style={{ fontSize: 10, color: C.inkFaint, marginTop: 7 }}>
              PDFs and photos. Phone photos are downscaled automatically.
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 18, justifyContent: "flex-end" }}>
            <button onClick={onClose}
              style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 8, padding: "9px 16px", fontSize: 13, color: C.inkMid, cursor: "pointer", fontFamily: "inherit" }}>
              Cancel
            </button>
            <button onClick={save} disabled={busy || !doc.title.trim()}
              style={{ background: busy || !doc.title.trim() ? C.border : C.gold, color: "#fff", border: "none", borderRadius: 8, padding: "9px 22px", fontSize: 13, fontWeight: 600, cursor: busy || !doc.title.trim() ? "default" : "pointer", fontFamily: "inherit" }}>
              {busy ? "Saving…" : "Save document"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── One row in the list ───────────────────────────────────────────────────────
/* ── Bulk add ─────────────────────────────────────────────────────────────────
   A drawer of paperwork is filed in one go: drop the lot in, and each file is
   uploaded, read by the model, and comes back as a filled-in row — category,
   title, the number on it, whose it is, and the dates. Nothing is saved until
   the rows are reviewed, because a misread expiry date is worse than a blank
   one: the reminders are built on it.

   Files are read as they upload rather than after, three at a time — enough to
   keep a folder of twenty moving without flooding the endpoint. */
const BULK_CONCURRENCY = 3;
const AI_MAX_BYTES = 8 * 1024 * 1024; // beyond this the base64 payload gets unwieldy

const fileToBase64 = file => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result || "").split(",")[1] || "");
  r.onerror = () => reject(new Error("Could not read the file"));
  r.readAsDataURL(file);
});

const CLASSIFY_PROMPT = `You are filing a business document for a gemstone exporter in India.

Read the attached file and reply with ONLY a JSON object, no prose, no code fence:
{"category":"<id>","title":"<short human title>","owner":"<person or company it belongs to, or empty>","refNo":"<the document's own number, or empty>","issueDate":"<YYYY-MM-DD or empty>","expiryDate":"<YYYY-MM-DD or empty>","tags":["<a few lowercase keywords>"],"confidence":<0-1>}

category MUST be one of: ${DOC_CATEGORIES.map(c => `${c.id} (${c.hint})`).join(", ")}.

Rules:
- title: what a person would call it, e.g. "Passport — Manav Jhaveri", "Electricity bill — Aug 2026", "GST registration certificate". Never repeat the file name if the document says something better.
- refNo: the identifying number printed on it (passport number, PAN, bill number, licence number). Empty if there is none.
- Dates as YYYY-MM-DD. Leave a date empty rather than guessing; do not invent an expiry for a document that has none (a bill has no expiry).
- confidence: how sure you are of the category, 0 to 1.`;

const classifyFile = async file => {
  const b64 = await fileToBase64(file);
  const isPdf = /pdf/i.test(file.type) || /\.pdf$/i.test(file.name);
  const part = isPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64, filename: file.name } }
    : { type: "image", source: { type: "base64", media_type: file.type || "image/jpeg", data: b64 } };
  const res = await fetchWithRetry("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      max_tokens: 600, temperature: 0,
      messages: [{ role: "user", content: [part, { type: "text", text: CLASSIFY_PROMPT }] }],
    }),
  }, { tries: 2, timeoutMs: 60000 });
  const data = await res.json();
  if (data.error) throw new Error(data.error?.message || "The model refused the file");
  const text = data.content?.find(b => b.type === "text")?.text || "";
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  let out;
  try { out = JSON.parse(json); } catch { throw new Error("Couldn't read the reply"); }
  const iso = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "").trim()) ? String(v).trim() : "");
  return {
    category: CAT_BY_ID[out.category] ? out.category : "other",
    title: String(out.title || "").trim().slice(0, 120),
    owner: String(out.owner || "").trim().slice(0, 80),
    refNo: String(out.refNo || "").trim().slice(0, 60),
    issueDate: iso(out.issueDate),
    expiryDate: iso(out.expiryDate),
    tags: Array.isArray(out.tags) ? out.tags.map(t => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 6) : [],
    confidence: Math.max(0, Math.min(1, +out.confidence || 0)),
  };
};

function BulkAdd({ onClose, onSaved, onToast }) {
  const [rows, setRows] = useState([]);      // {id,file,name,size,status,url,fields,error,keep}
  const [dragging, setDragging] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef(null);
  const patch = (id, p) => setRows(rs => rs.map(r => r.id === id ? { ...r, ...p } : r));

  const intake = async list => {
    const files = Array.from(list || []).filter(Boolean);
    if (!files.length) return;
    const fresh = files.map(f => ({
      id: uid(), file: f, name: f.name, size: f.size || 0, type: f.type || "",
      status: "queued", url: "", error: "", keep: true,
      fields: { ...newDoc(), title: f.name.replace(/\.[^.]+$/, ""), category: "other", tags: [] },
    }));
    setRows(rs => [...rs, ...fresh]);

    // A small worker pool: each file uploads, then is read, before the next starts.
    const queue = [...fresh];
    const worker = async () => {
      while (queue.length) {
        const row = queue.shift();
        try {
          patch(row.id, { status: "uploading" });
          const path = `documents/bulk/${row.fields.id}/${uid()}${uid()}-${safeName(row.name)}`;
          const url = await uploadToStorage(path, row.file);
          patch(row.id, { url, status: "reading" });
          if (row.size > AI_MAX_BYTES) {
            patch(row.id, { status: "done", error: "Too large to read — fill it in by hand" });
            continue;
          }
          const got = await classifyFile(row.file);
          patch(row.id, {
            status: "done",
            fields: { ...row.fields, ...got, title: got.title || row.fields.title },
          });
        } catch (e) {
          // An upload that failed has nothing to save; a read that failed still does.
          patch(row.id, { status: "done", error: e?.message || "Could not read this file" });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(BULK_CONCURRENCY, fresh.length) }, worker));
  };

  const setField = (id, k, v) => setRows(rs => rs.map(r => r.id === id ? { ...r, fields: { ...r.fields, [k]: v } } : r));
  const drop = id => setRows(rs => {
    const row = rs.find(r => r.id === id);
    if (row?.url) removeFromStorage(row.url);
    return rs.filter(r => r.id !== id);
  });

  const working = rows.some(r => r.status === "uploading" || r.status === "reading");
  const savable = rows.filter(r => r.keep && r.url && r.fields.title.trim());

  const saveAll = async () => {
    if (!savable.length) return;
    setSaving(true);
    let ok = 0;
    for (const r of savable) {
      const rec = {
        ...r.fields,
        title: r.fields.title.trim(),
        owner: (r.fields.owner || "").trim(),
        refNo: (r.fields.refNo || "").trim(),
        files: [{ id: uid(), name: r.name, url: r.url, type: r.type, size: r.size, uploadedAt: new Date().toISOString() }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      try { await upsertItemK(DOCS_KEY, rec); ok++; } catch (e) { onToast(`Couldn't save ${r.name}: ${e?.message || ""}`); }
    }
    setSaving(false);
    onSaved(ok);
  };

  const lbl = { fontSize: 9, fontWeight: 700, letterSpacing: .9, color: C.inkFaint, textTransform: "uppercase", marginBottom: 3, display: "block" };
  const cell = { ...FI, padding: "6px 8px", fontSize: 12 };

  return (
    <div onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(20,14,4,.45)", zIndex: 900, display: "flex", alignItems: mob ? "flex-end" : "center", justifyContent: "center", padding: mob ? 0 : 24 }}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: C.bg, borderRadius: mob ? "14px 14px 0 0" : 16, width: "min(1000px,100%)", maxHeight: "92vh", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "var(--e-modal)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "15px 20px", borderBottom: `1px solid ${C.border}`, background: C.surface, flexShrink: 0 }}>
          <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 20, fontWeight: 600, color: C.ink, lineHeight: 1 }}>⇪ Bulk upload</div>
          <div style={{ fontSize: 11, color: C.inkFaint }}>drop the folder in — each file is read and filed</div>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 8, padding: "6px 14px", fontSize: 12.5, color: C.inkMid, cursor: "pointer", fontFamily: "inherit" }}>Close</button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 16 }}>
          <div
            onDragOver={e => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={e => { e.preventDefault(); setDragging(false); intake(e.dataTransfer?.files); }}
            onClick={() => fileRef.current?.click()}
            style={{ border: `2px dashed ${dragging ? C.gold : C.borderHi}`, background: dragging ? C.goldLight : C.card,
              borderRadius: 14, padding: rows.length ? "18px 16px" : "40px 16px", textAlign: "center", cursor: "pointer", transition: "all .15s", marginBottom: rows.length ? 14 : 0 }}>
            <div style={{ fontSize: rows.length ? 22 : 32, marginBottom: 6 }}>📥</div>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: C.ink }}>Drop files here, or click to choose</div>
            <div style={{ fontSize: 11.5, color: C.inkFaint, marginTop: 4, lineHeight: 1.6 }}>
              PDFs and photos, as many at once as you like. Each one is read to work out what it is,<br />what it{"'"}s numbered, whose it is and when it expires — you check before anything is saved.
            </div>
            <input ref={fileRef} type="file" multiple accept="application/pdf,image/*,.doc,.docx,.xls,.xlsx,.csv"
              onChange={e => { intake(e.target.files); e.target.value = ""; }} style={{ display: "none" }} />
          </div>

          {rows.map(r => {
            const cat = CAT_BY_ID[r.fields.category] || CAT_BY_ID.other;
            const low = r.status === "done" && !r.error && (r.fields.confidence || 0) < 0.55;
            return (
              <div key={r.id} style={{ background: C.surface, border: `1px solid ${r.keep ? C.border : C.borderHi}`, borderRadius: 12, padding: 12, marginBottom: 10, opacity: r.keep ? 1 : .55 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: r.status === "done" ? 10 : 0 }}>
                  <input type="checkbox" checked={r.keep} onChange={e => patch(r.id, { keep: e.target.checked })} style={{ accentColor: C.gold }} />
                  <span style={{ fontSize: 15 }}>{fileIcon(r)}</span>
                  <span style={{ fontSize: 12, color: C.inkMid, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
                  <span style={{ fontSize: 10.5, color: C.inkFaint, flexShrink: 0 }}>{fmtSize(r.size)}</span>
                  {r.status !== "done" && (
                    <span style={{ fontSize: 11, color: C.gold, fontWeight: 600, flexShrink: 0 }}>
                      {r.status === "uploading" ? "Uploading…" : r.status === "reading" ? "Reading…" : "Queued"}
                    </span>
                  )}
                  {r.status === "done" && !r.error && <span style={{ fontSize: 11, color: C.green, fontWeight: 600, flexShrink: 0 }}>{cat.icon} {cat.label}</span>}
                  <button onClick={() => drop(r.id)} style={{ background: "none", border: "none", cursor: "pointer", color: C.red, fontSize: 16, lineHeight: 1, padding: 0, flexShrink: 0 }}>×</button>
                </div>

                {r.error && <div style={{ fontSize: 11.5, color: C.amber, background: C.amberBg, borderRadius: 7, padding: "6px 9px", marginBottom: r.status === "done" ? 9 : 0 }}>{r.error}</div>}
                {low && <div style={{ fontSize: 11.5, color: C.amber, background: C.amberBg, borderRadius: 7, padding: "6px 9px", marginBottom: 9 }}>Not sure about this one — worth a look before saving.</div>}

                {r.status === "done" && (
                  <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr" : "2fr 1.2fr 1fr 1fr 1fr", gap: 8 }}>
                    <div><span style={lbl}>Title</span><input value={r.fields.title} onChange={e => setField(r.id, "title", e.target.value)} style={cell} /></div>
                    <div><span style={lbl}>Category</span>
                      <select value={r.fields.category} onChange={e => setField(r.id, "category", e.target.value)} style={{ ...cell, cursor: "pointer" }}>
                        {DOC_CATEGORIES.map(c => <option key={c.id} value={c.id}>{c.icon} {c.label}</option>)}
                      </select>
                    </div>
                    <div><span style={lbl}>Owner</span><input value={r.fields.owner} onChange={e => setField(r.id, "owner", e.target.value)} style={cell} /></div>
                    <div><span style={lbl}>Number</span><input value={r.fields.refNo} onChange={e => setField(r.id, "refNo", e.target.value)} style={cell} /></div>
                    <div><span style={lbl}>Expires</span><input type="date" value={r.fields.expiryDate} onChange={e => setField(r.id, "expiryDate", e.target.value)} style={cell} /></div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 20px", borderTop: `1px solid ${C.border}`, background: C.surface, flexShrink: 0 }}>
          <span style={{ fontSize: 12, color: C.inkFaint }}>
            {rows.length ? `${savable.length} of ${rows.length} ready to file` : "Nothing queued yet"}
          </span>
          <div style={{ flex: 1 }} />
          <button onClick={saveAll} disabled={!savable.length || working || saving}
            style={{ background: !savable.length || working || saving ? C.border : C.gold, color: "#fff", border: "none", borderRadius: 8, padding: "9px 22px", fontSize: 13, fontWeight: 600, cursor: !savable.length || working || saving ? "default" : "pointer", fontFamily: "inherit" }}>
            {saving ? "Filing…" : working ? "Reading…" : `File ${savable.length} document${savable.length === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function DocRow({ doc, onEdit, onDelete, onToast }) {
  const cat = catOf(doc);
  const exp = expiryState(doc);
  const files = doc.files || [];

  const copyLink = async f => {
    try { await navigator.clipboard.writeText(f.url); onToast("Link copied"); }
    catch { onToast("Could not copy"); }
  };

  return (
    <div style={{ background: C.surface, border: `1px solid ${exp?.kind === "expired" ? C.red : C.border}`, borderRadius: 11, padding: mob ? "12px 13px" : "13px 16px", marginBottom: 8 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 11 }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, background: C.card, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17, flexShrink: 0 }}>{cat.icon}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: C.ink }}>{doc.title}</span>
            {exp && exp.kind !== "ok" && (
              <span style={{ background: exp.bg, color: exp.fg, border: `1px solid ${exp.fg}33`, borderRadius: 4, padding: "1px 7px", fontSize: 10, fontWeight: 700 }}>{exp.label}</span>
            )}
          </div>
          <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 3, display: "flex", gap: 10, flexWrap: "wrap" }}>
            <span>{cat.label}</span>
            {doc.owner && <span>· {doc.owner}</span>}
            {doc.refNo && <span>· <span style={{ fontFamily: "ui-monospace,monospace", color: C.inkMid }}>{doc.refNo}</span></span>}
            {doc.issueDate && <span>· Issued {fmtDate(doc.issueDate)}</span>}
            {exp?.kind === "ok" && <span>· {exp.label}</span>}
          </div>
          {doc.notes && <div style={{ fontSize: 12, color: C.inkMid, marginTop: 6, whiteSpace: "pre-wrap" }}>{doc.notes}</div>}

          {!!(doc.tags || []).length && (
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 7 }}>
              {doc.tags.map(t => (
                <span key={t} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 4, padding: "1px 7px", fontSize: 10, color: C.inkMid }}>{t}</span>
              ))}
            </div>
          )}

          {!!files.length && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
              {files.map(f => (
                <span key={f.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, background: C.card, border: `1px solid ${C.border}`, borderRadius: 6, padding: "4px 9px", fontSize: 11 }}>
                  <a href={f.url} target="_blank" rel="noopener noreferrer" title={f.name}
                    style={{ color: C.ink, textDecoration: "none", maxWidth: 190, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {fileIcon(f)} {f.name}
                  </a>
                  <button onClick={() => copyLink(f)} title="Copy link"
                    style={{ background: "none", border: "none", cursor: "pointer", color: C.inkFaint, fontSize: 11, padding: 0 }}>⧉</button>
                </span>
              ))}
            </div>
          )}
          {!files.length && <div style={{ fontSize: 11, color: C.amber, marginTop: 7 }}>⚠ No file attached yet</div>}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 5, flexShrink: 0 }}>
          <button onClick={() => onEdit(doc)} title="Edit"
            style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 6, padding: "4px 9px", fontSize: 11, color: C.inkMid, cursor: "pointer", fontFamily: "inherit" }}>Edit</button>
          <button onClick={() => onDelete(doc)} title="Delete"
            style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 6, padding: "4px 9px", fontSize: 11, color: C.red, cursor: "pointer", fontFamily: "inherit" }}>Delete</button>
        </div>
      </div>
    </div>
  );
}

// ── Module ────────────────────────────────────────────────────────────────────
export default function DocumentsApp({ onHome, currentUser }) {
  const [docs, setDocs] = useState(() => (Array.isArray(readCache(DOCS_KEY)) ? readCache(DOCS_KEY) : []));
  const [loaded, setLoaded] = useState(() => Array.isArray(readCache(DOCS_KEY)));
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("all");
  const [expFilter, setExpFilter] = useState("all"); // all | soon | expired
  const [sort, setSort] = useState("updated");       // updated | expiry | title
  const [draft, setDraft] = useState(null);
  const [bulk, setBulk] = useState(false);
  const [toast, setToast] = useState("");
  const showToast = m => { setToast(m); setTimeout(() => setToast(""), 2600); };
  const who = currentUser?.name || currentUser?.email || "Admin";

  const pull = () => loadK(DOCS_KEY).then(d => { setDocs(Array.isArray(d) ? d : []); setLoaded(true); }).catch(() => setLoaded(true));
  useEffect(() => { pull(); }, []);
  useEffect(() => onCacheRefresh(keys => { if (keys.includes(DOCS_KEY)) pull(); }), []);

  const owners = useMemo(
    () => [...new Set(docs.map(d => (d.owner || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [docs]
  );

  const counts = useMemo(() => {
    const c = { all: docs.length };
    docs.forEach(d => { const k = catOf(d).id; c[k] = (c[k] || 0) + 1; });
    return c;
  }, [docs]);

  const alerts = useMemo(() => {
    let soon = 0, expired = 0;
    docs.forEach(d => {
      const s = expiryState(d);
      if (s?.kind === "expired") expired++;
      else if (s?.kind === "soon") soon++;
    });
    return { soon, expired };
  }, [docs]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const hay = d => [
      d.title, d.owner, d.refNo, d.notes, catOf(d).label,
      ...(d.tags || []),
      ...(d.files || []).map(f => f.name),
    ].filter(Boolean).join(" ").toLowerCase();

    let out = docs.filter(d => {
      if (cat !== "all" && catOf(d).id !== cat) return false;
      if (expFilter !== "all" && expiryState(d)?.kind !== expFilter) return false;
      if (needle && !needle.split(/\s+/).every(w => hay(d).includes(w))) return false;
      return true;
    });

    const ts = d => new Date(d.updatedAt || d.createdAt || 0).getTime();
    if (sort === "title") out = [...out].sort((a, b) => String(a.title).localeCompare(String(b.title), undefined, { sensitivity: "base" }));
    else if (sort === "expiry") out = [...out].sort((a, b) => {
      const x = daysUntil(a.expiryDate), y = daysUntil(b.expiryDate);
      if (x === null && y === null) return ts(b) - ts(a);
      if (x === null) return 1;
      if (y === null) return -1;
      return x - y;
    });
    else out = [...out].sort((a, b) => ts(b) - ts(a));
    return out;
  }, [docs, q, cat, expFilter, sort]);

  const onSaved = (record, isNew) => {
    setDraft(null);
    showToast(isNew ? "Document added" : "Document saved");
    logActivity({ user: who, action: isNew ? "add" : "edit", module: "documents", label: `📁 ${record.title}`, targetMod: "documents", targetId: record.id });
  };

  const onDelete = async doc => {
    if (!window.confirm(`Delete "${doc.title}" and its ${(doc.files || []).length} file(s)? This cannot be undone.`)) return;
    try {
      await deleteItemK(DOCS_KEY, doc.id);
      removeFromStorage((doc.files || []).map(f => f.url));
      showToast("Deleted");
      logActivity({ user: who, action: "delete", module: "documents", label: `🗑 ${doc.title}` });
    } catch (e) {
      showToast(e?.message || "Could not delete");
    }
  };

  const chip = (active, extra = {}) => ({
    background: active ? C.gold : C.surface, color: active ? "#fff" : C.inkMid,
    border: `1px solid ${active ? C.gold : C.border}`, borderRadius: 20, padding: "5px 12px",
    fontSize: 11, fontWeight: active ? 700 : 500, cursor: "pointer", whiteSpace: "nowrap",
    fontFamily: "inherit", transition: "all .15s", ...extra,
  });

  return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: "system-ui, sans-serif", paddingBottom: mob ? 76 : 32 }}>
      <Toast msg={toast} />
      {draft && <DocForm draft={draft} owners={owners} onClose={() => setDraft(null)} onSaved={onSaved} onToast={showToast} />}
      {bulk && (
        <BulkAdd
          onClose={() => setBulk(false)}
          onToast={showToast}
          onSaved={n => {
            setBulk(false);
            pull();
            showToast(n ? `✓ Filed ${n} document${n === 1 ? "" : "s"}` : "Nothing was filed");
            if (n) logActivity({ user: who, action: "added", module: "documents", label: `📁 Bulk filed ${n} document${n === 1 ? "" : "s"}`, targetMod: "documents" });
          }}
        />
      )}

      {/* Header */}
      <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}`, padding: mob ? "0 12px" : "0 24px", display: "flex", alignItems: "center", height: 54, position: "sticky", top: 0, zIndex: 100, gap: 10 }}>
        <button onClick={onHome} style={{ background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 7, padding: "0 12px 0 0", borderRight: `1px solid ${C.border}`, flexShrink: 0 }}>
          <span style={{ fontSize: 20 }}>📁</span>
          {!mob && <div><div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 15, fontWeight: 600, color: C.ink, lineHeight: 1.1 }}>Documents</div><div style={{ fontSize: 8, color: C.inkFaint, letterSpacing: 1.2, fontWeight: 500 }}>NIKHIL GEMS</div></div>}
        </button>
        <input value={q} onChange={e => setQ(e.target.value)}
          placeholder={mob ? "Search documents…" : "Search title, number, owner, tag, note or file name…"}
          style={{ ...FI, flex: 1, maxWidth: 460 }} />
        {q && <button onClick={() => setQ("")} style={{ background: "none", border: "none", cursor: "pointer", color: C.inkFaint, fontSize: 17, padding: 0 }}>×</button>}
        <div style={{ flex: 1 }} />
        <button onClick={() => setBulk(true)}
          title="Drop in a pile of files — each is read and filed"
          style={{ background: C.surface, color: C.ink, border: `1px solid ${C.borderHi}`, borderRadius: 8, padding: mob ? "7px 12px" : "8px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", flexShrink: 0, fontFamily: "inherit", marginRight: 8 }}>
          ⇪ {mob ? "Bulk" : "Bulk upload"}
        </button>
        <button onClick={() => setDraft(newDoc())}
          style={{ background: C.gold, color: "#fff", border: "none", borderRadius: 8, padding: mob ? "7px 12px" : "8px 16px", fontSize: 12, fontWeight: 600, cursor: "pointer", flexShrink: 0, fontFamily: "inherit" }}>
          + {mob ? "Add" : "Add document"}
        </button>
      </div>

      <div style={{ maxWidth: 980, margin: "0 auto", padding: mob ? "14px 12px" : "20px 24px" }}>
        {/* Expiry alerts */}
        {(alerts.expired > 0 || alerts.soon > 0) && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
            {alerts.expired > 0 && (
              <button onClick={() => { setExpFilter(expFilter === "expired" ? "all" : "expired"); setCat("all"); }}
                style={{ background: C.redBg, border: `1px solid ${expFilter === "expired" ? C.red : `${C.red}44`}`, borderRadius: 9, padding: "8px 14px", fontSize: 12, color: C.red, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
                ⚠ {alerts.expired} expired
              </button>
            )}
            {alerts.soon > 0 && (
              <button onClick={() => { setExpFilter(expFilter === "soon" ? "all" : "soon"); setCat("all"); }}
                style={{ background: C.amberBg, border: `1px solid ${expFilter === "soon" ? C.amber : `${C.amber}44`}`, borderRadius: 9, padding: "8px 14px", fontSize: 12, color: C.amber, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
                ⏳ {alerts.soon} expiring within {EXPIRY_WARN_DAYS} days
              </button>
            )}
          </div>
        )}

        {/* Category filter */}
        <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 4, marginBottom: 10 }}>
          <button onClick={() => setCat("all")} style={chip(cat === "all")}>All · {counts.all || 0}</button>
          {DOC_CATEGORIES.filter(c => counts[c.id]).map(c => (
            <button key={c.id} onClick={() => setCat(cat === c.id ? "all" : c.id)} style={chip(cat === c.id)}>
              {c.icon} {c.label} · {counts[c.id]}
            </button>
          ))}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
          <div style={{ fontSize: 11, color: C.inkFaint, flex: 1 }}>
            {loaded ? `${visible.length} of ${docs.length} document${docs.length === 1 ? "" : "s"}` : "Loading…"}
            {expFilter !== "all" && <button onClick={() => setExpFilter("all")} style={{ background: "none", border: "none", color: C.gold, cursor: "pointer", fontSize: 11, fontFamily: "inherit" }}>· clear expiry filter</button>}
          </div>
          <select value={sort} onChange={e => setSort(e.target.value)} style={{ ...FI, width: "auto", fontSize: 11, padding: "5px 9px" }}>
            <option value="updated">Recently updated</option>
            <option value="expiry">Expiring soonest</option>
            <option value="title">Title A–Z</option>
          </select>
        </div>

        {/* List */}
        {loaded && !docs.length && (
          <div style={{ textAlign: "center", padding: "56px 20px", color: C.inkFaint }}>
            <div style={{ fontSize: 40, marginBottom: 10 }}>📁</div>
            <div style={{ fontSize: 15, fontWeight: 600, color: C.ink, marginBottom: 6 }}>No documents yet</div>
            <div style={{ fontSize: 12, maxWidth: 380, margin: "0 auto 16px", lineHeight: 1.55 }}>
              Keep passports, ITRs, electricity bills, licences and certificates in one place —
              searchable by number, owner or tag, with expiry reminders on the ones that lapse.
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
              <button onClick={() => setBulk(true)}
                style={{ background: C.gold, color: "#fff", border: "none", borderRadius: 8, padding: "9px 20px", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
                ⇪ Drop in a pile of files
              </button>
              <button onClick={() => setDraft(newDoc())}
                style={{ background: C.surface, color: C.ink, border: `1px solid ${C.borderHi}`, borderRadius: 8, padding: "9px 20px", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
                + Add one by hand
              </button>
            </div>
          </div>
        )}
        {loaded && !!docs.length && !visible.length && (
          <div style={{ textAlign: "center", padding: "40px 20px", color: C.inkFaint, fontSize: 13 }}>
            Nothing matches that search.
          </div>
        )}
        {visible.map(d => (
          <DocRow key={d.id} doc={d} onEdit={setDraft} onDelete={onDelete} onToast={showToast} />
        ))}
      </div>
    </div>
  );
}
