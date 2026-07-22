import { waitUntil } from "@vercel/functions";
import { createClient } from "@supabase/supabase-js";

// ── Supabase ──────────────────────────────────────────────────────────────────
function sb() {
  return createClient(
    process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY
  );
}
async function loadK(key) {
  const { data, error } = await sb().from("app_data").select("value").eq("key", key).single();
  if (error || !data) return null;
  return data.value ?? null;
}
async function broadcastInvalidate(key) {
  try {
    const client = sb();
    const channel = client.channel("ng-appdata-invalidate");
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 1200);
      channel.subscribe(status => {
        if (status === "SUBSCRIBED") {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    await channel.send({ type: "broadcast", event: "invalidate", payload: { key, ts: Date.now() } });
    await client.removeChannel(channel);
  } catch {}
}
async function saveK(key, value) {
  const { error } = await sb().from("app_data").upsert({ key, value });
  if (error) throw new Error(error.message);
  await broadcastInvalidate(key);
}

// ── Multi-bot context ─────────────────────────────────────────────────────────
// ?bot=at → Atyahara bot  |  default → Nikhil Gems bot
function botCtx(isAT) {
  const p = isAT ? "at" : "ng";
  return {
    token:    isAT ? process.env.TELEGRAM_BOT_TOKEN_AT : process.env.TELEGRAM_BOT_TOKEN,
    allowed:  isAT ? (process.env.TELEGRAM_ALLOWED_CHAT_IDS_AT || "") : (process.env.TELEGRAM_ALLOWED_CHAT_IDS || ""),
    memory:   `${p}-bot-memory-v1`,
    sessions: `${p}-bot-sessions-v1`,
    activity: `${p}-activity-v1`,
    finAccs:  `${p}-fin-accounts-v1`,
    finTxns:  `${p}-fin-txns-v1`,
    invoices: isAT ? "at-invoices-v1"  : "ng-invoices-v2",
    buyers:   isAT ? "at-buyers-v1"    : "ng-buyers-v2",
    purchases:isAT ? "at-purch-v1"     : "ng-purch-v5",
    vendors:  isAT ? "at-vendors-v1"   : "ng-vendors-v5",
    expenses: isAT ? "at-expenses-v1"  : "ng-expenses-v1",
    stock:    "ng-stock-v5",
    rates:    "ng-fin-rates-v1",
    shows:    "ng-shows-v1",
    name:     isAT ? "Atyahara" : "Nikhil Gems",
    isAT,
  };
}

// ── Telegram ──────────────────────────────────────────────────────────────────
async function tg(method, body, token) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return r.json();
}

// Resolve a Telegram file_id to a temporary public URL (valid ~1h — long enough
// for OpenAI to fetch it during a single vision call). Returns null on failure.
async function tgFileUrl(fileId) {
  try {
    const r = await tg("getFile", { file_id: fileId }, _ctx.token);
    const path = r?.result?.file_path;
    return path ? `https://api.telegram.org/file/bot${_ctx.token}/${path}` : null;
  } catch { return null; }
}

// Request-scoped bot context (set once per handler invocation — safe in serverless)
let _ctx = null;
// Request-scoped: the file (PDF/photo) the user attached in the current message, if any.
let _pendingFile = null;
let _pendingFileBuffer = null;
let _currentText = "";
let _currentHasVision = false;

// Escape HTML special chars so GPT output never breaks Telegram HTML parse mode
function esc(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Send long messages in chunks; supports basic <b>, <i>, <code> from GPT
async function send(chatId, text) {
  if (!text?.trim()) return;
  // Strip any raw <tag> that isn't an allowed HTML tag (prevent parse errors)
  const safe = text.replace(/<(?!\/?(?:b|i|u|s|code|pre|a|blockquote)[\s>\/])[^>]*>/gi, "");
  for (let i = 0; i < safe.length; i += 4000) {
    await tg("sendMessage", { chat_id: chatId, text: safe.slice(i, i + 4000), parse_mode: "HTML" }, _ctx.token);
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────
const uid = () => Math.random().toString(36).substr(2, 9);
const todayStr = () => {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
};
const fmtMoney = (n, cur = "INR") => {
  const sym = { INR: "₹", USD: "$", JPY: "¥", EUR: "€", GBP: "£", AUD: "A$" };
  return (sym[cur] || cur + " ") + Number(n || 0).toLocaleString("en-IN");
};
const parseDateLoose = s => {
  const v = String(s || "").trim();
  let m = v.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = v.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (!m) return "";
  const yyyy = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${yyyy}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
};
const parseNum = s => {
  const n = Number(String(s || "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

// ── Activity log ──────────────────────────────────────────────────────────────
async function logActivity(entry) {
  try {
    const curr = (await loadK(_ctx.activity)) || [];
    await saveK(_ctx.activity, [{ id: uid(), ts: new Date().toISOString(), ...entry }, ...curr].slice(0, 500));
  } catch {}
}

// ── Bot memory (persistent facts) ─────────────────────────────────────────────
async function getMemory() {
  return (await loadK(_ctx.memory)) || [];
}
async function saveMemory(facts) {
  await saveK(_ctx.memory, facts.slice(0, 200));
}

// ── Session ───────────────────────────────────────────────────────────────────
const MAX_HISTORY = 40;

async function getSession(chatId) {
  const sessions = (await loadK(_ctx.sessions)) || {};
  return sessions[String(chatId)] || { history: [], lastUpdateId: null };
}
async function saveSession(chatId, session) {
  const sessions = (await loadK(_ctx.sessions)) || {};
  sessions[String(chatId)] = { ...session, ts: Date.now() };
  await saveK(_ctx.sessions, sessions);
}
async function clearSession(chatId) {
  const sessions = (await loadK(_ctx.sessions)) || {};
  delete sessions[String(chatId)];
  await saveK(_ctx.sessions, sessions);
}

// ── Tool definitions ──────────────────────────────────────────────────────────
const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_stock",
      description: "Search stock inventory. Returns item IDs, material, shape, qty, unit, location, region, cost price, grade, origin. Use this before any stock action. Can filter by material, unit, region, show, sold status, location, vendor.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free-text search across material, shape, location, region, origin, grade, vendor, show tag. Leave empty to get all." },
          unit: { type: "string", description: "Filter by unit: kg, pcs, ct, gm" },
          region: { type: "string", description: "Filter by region: India, Japan, USA, Europe" },
          unsold_only: { type: "boolean", description: "Default true. Set false to include sold items." },
          in_show: { type: "boolean", description: "If true, only items currently at a show (not India)." },
          limit: { type: "number", description: "Default 50, max 200." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_stock_summary",
      description: "Get aggregated stock summary — total qty by material, by unit, by region. Great for 'how many kgs of X' type questions.",
      parameters: {
        type: "object",
        properties: {
          material: { type: "string", description: "Filter to specific material (e.g. sunstone, amethyst)" },
          group_by: { type: "string", description: "Group results by: material, region, unit, location" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_invoices",
      description: "Get invoices. Use to answer questions about last invoice, invoices to a buyer, recent sales, etc.",
      parameters: {
        type: "object",
        properties: {
          buyer: { type: "string", description: "Filter by buyer/customer name" },
          limit: { type: "number", description: "Default 10" },
          latest_only: { type: "boolean", description: "If true, return only the most recent invoice with full details" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_purchases",
      description: "Get purchase bills from vendors. Filter by vendor or get recent ones. Does NOT include POs — use get_purchase_orders for those.",
      parameters: {
        type: "object",
        properties: {
          vendor: { type: "string" },
          limit: { type: "number", description: "Default 10" },
          latest_only: { type: "boolean" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_expenses",
      description: "Get expenses. Filter by category or get recent ones.",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string" },
          days_back: { type: "number", description: "Get expenses from last N days" },
          limit: { type: "number", description: "Default 15" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_vendors",
      description: "Get vendor/supplier list.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search by name" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_shows",
      description: "Get list of shows/exhibitions.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "get_business_summary",
      description: "Overall business snapshot — stock counts, values, expenses, purchases by period.",
      parameters: {
        type: "object",
        properties: {
          period_days: { type: "number", description: "Look back N days for purchases/expenses. Default 30." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_finance_accounts",
      description: "Get Finance module accounts and their current computed balances. Use this for ANY question about money in accounts — 'how much in USA bank', 'what's my USD balance', 'how much cash do I have', 'show me all balances', 'check my finance module'.",
      parameters: {
        type: "object",
        properties: {
          account_name: { type: "string", description: "Optional: filter by account name keyword (e.g. 'usa', 'japan', 'hdfc', 'cash')" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_finance_transactions",
      description: "Get recent Finance ledger transactions. Use to show payment history, recent money movement, or check what's been recorded.",
      parameters: {
        type: "object",
        properties: {
          account_name: { type: "string", description: "Filter by account name keyword" },
          days_back: { type: "number", description: "Get transactions from last N days. Default 30." },
          limit: { type: "number", description: "Default 20" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "log_finance_transaction",
      description: "Add a transaction to the Finance ledger. Use when user mentions paying someone, receiving money, or any cash/bank movement. ALWAYS include the account field — call get_finance_accounts first if needed to find the right account name.",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", description: "credit (money in) or debit (money out)" },
          amount: { type: "number", description: "Absolute amount (always positive)" },
          currency: { type: "string", description: "INR, USD, JPY, EUR, GBP, AUD" },
          account: { type: "string", description: "REQUIRED — Account name keyword matched to existing Finance accounts (e.g. 'IndusInd', 'Cash', 'USD Cash'). Without this, the transaction won't affect any account balance. Call get_finance_accounts first if unsure which account to use." },
          payee: { type: "string", description: "Who paid or was paid" },
          category: { type: "string", description: "e.g. Vendor Payment, Sales Receipt, Freight, Salary, Show Expense, Transfer, Other" },
          date: { type: "string", description: "YYYY-MM-DD, defaults to today" },
          notes: { type: "string", description: "Optional additional context" }
        },
        required: ["type", "amount", "currency", "account"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "log_finance_transfer",
      description: "Add an internal transfer/conversion between two own Finance accounts, such as EEFC to current account/BOI, USD cash to EEFC, or bank-to-bank transfer. Use this instead of log_finance_transaction for transfers between Nikhil's own accounts.",
      parameters: {
        type: "object",
        properties: {
          from_account: { type: "string", description: "Source account name/keyword, e.g. EEFC, USD Cash" },
          to_account: { type: "string", description: "Destination account name/keyword, e.g. current, BOI, Bank of India 0451" },
          amount_from: { type: "number", description: "Amount leaving the source account" },
          currency_from: { type: "string", description: "Currency leaving the source account, e.g. USD" },
          amount_to: { type: "number", description: "Amount credited to the destination account, if known" },
          currency_to: { type: "string", description: "Currency credited to the destination account, e.g. INR" },
          rate: { type: "number", description: "Conversion rate from source to destination. If amount_to is known this can be omitted." },
          date: { type: "string", description: "YYYY-MM-DD, defaults to today" },
          notes: { type: "string", description: "Reference/remittance details and charges" }
        },
        required: ["from_account", "to_account", "amount_from"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "record_payment",
      description: "Record a payment against a purchase bill or PO — updates its paidAmount and status. Use when Nikhil says 'I paid him', 'paid the bill', 'settled the PO', etc. Call get_purchases or get_purchase_orders first to find the ID if needed.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Bill or PO ID from get_purchases / get_purchase_orders" },
          amount: { type: "number", description: "Amount paid" },
          currency: { type: "string", description: "Currency of payment" },
          date: { type: "string", description: "YYYY-MM-DD payment date, defaults to today" },
          notes: { type: "string" }
        },
        required: ["id", "amount"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "create_purchase",
      description: "Create a purchase bill for gems/stones bought from a vendor.",
      parameters: {
        type: "object",
        properties: {
          vendor: { type: "string" },
          date: { type: "string", description: "YYYY-MM-DD, defaults to today" },
          currency: { type: "string", description: "Default INR" },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                material: { type: "string" },
                shape: { type: "string" },
                qty: { type: "number" },
                unit: { type: "string", description: "pcs/kg/ct/gm" },
                spec: { type: "string", description: "Size, grade, count-per-kg, or quality spec. NOT a price." },
                rate: { type: "number", description: "Monetary price per unit ONLY. Never put specs here." },
                gst: { type: "string", description: "Default '3'" }
              },
              required: ["material"]
            }
          },
          notes: { type: "string" }
        },
        required: ["vendor", "items"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "create_expense",
      description: "Log a business expense.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "YYYY-MM-DD" },
          category: { type: "string", description: "Sea Freight | Air Freight | Courier / Local Delivery | Rent | Electricity | Staff / Labour | Show — Booth Fee | Show — Travel | Show — Hotel | Packaging | Bank Charges | GST / Tax Payment | Repairs & Maintenance | Other" },
          description: { type: "string" },
          amount: { type: "number" },
          currency: { type: "string", description: "Default INR" }
        },
        required: ["category", "amount"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "add_stock_items",
      description: "Add NEW physical stock items to the Stock module (inventory). Use whenever the user sends a note/list/photo of stones and asks to 'add to stock', 'add to inventory', 'add to stock module', etc. Read the image/text and turn EACH distinct stone + shape line into one item. This is NEW inventory — it is NOT a purchase bill and NOT a payment, so NEVER ask for payment details for this. If a quantity has both a count and a weight (e.g. '19 pcs 1 kg'), put the primary number the user wrote in qty/unit and the other in notes.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            description: "One object per stone + shape line.",
            items: {
              type: "object",
              properties: {
                material: { type: "string", description: "Stone / material name, e.g. 'Malachite Chrysocolla', 'Blue Lace Agate', 'Sunset Sodalite'" },
                shape: { type: "string", description: "Shape, e.g. Sphere, Heart, Palm, Tower, Freeform" },
                qty: { type: "string", description: "Quantity as written, e.g. '1', '19', '0.5'" },
                unit: { type: "string", enum: ["pcs", "kg", "g", "ct"], description: "kg/g for weight, pcs for a count, ct for carats" },
                size: { type: "string", description: "Size / dimension spec, e.g. '35-43 mm', '50mm'" },
                weightGm: { type: "string", description: "Specific weight in grams when stated, e.g. note says 0.778 kg → '778'" },
                grade: { type: "string" },
                origin: { type: "string" },
                costPrice: { type: "string", description: "Cost price per unit only if stated; else leave empty" },
                location: { type: "string", description: "Box / location label if given, e.g. 'STK 89'" },
                vendor: { type: "string" },
                notes: { type: "string", description: "Anything that doesn't fit a field, e.g. 'check weight', secondary qty like '0.778 kg'" }
              },
              required: ["material"]
            }
          }
        },
        required: ["items"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "send_to_show",
      description: "Send stock items to a show. ALWAYS call get_stock first to get item IDs, then get_shows for the show ID.",
      parameters: {
        type: "object",
        properties: {
          item_ids: { type: "array", items: { type: "string" } },
          show_id: { type: "string" }
        },
        required: ["item_ids", "show_id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "mark_sold",
      description: "Mark a stock item as sold. Get item ID from get_stock first.",
      parameters: {
        type: "object",
        properties: {
          item_id: { type: "string" },
          qty: { type: "number", description: "Qty sold. Defaults to all." },
          sold_price: { type: "number" },
          sold_currency: { type: "string", description: "Default INR" }
        },
        required: ["item_id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "update_stock_items",
      description: "Update one or more stock items. Pass array of {id, fields} pairs. Good for bulk edits.",
      parameters: {
        type: "object",
        properties: {
          updates: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                fields: { type: "object", description: "Fields to update: location, notes, costPrice, grade, size, shape, material, vendor, market, etc.", additionalProperties: true }
              },
              required: ["id", "fields"]
            }
          }
        },
        required: ["updates"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "return_to_india",
      description: "Return stock items from a show back to India. Get item IDs from get_stock first.",
      parameters: {
        type: "object",
        properties: {
          item_ids: { type: "array", items: { type: "string" } }
        },
        required: ["item_ids"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "save_memory",
      description: "Permanently remember a fact, preference, or note about the business or Nikhil. Use this whenever you learn something reusable — vendor details, preferences, seasonal patterns, pricing norms, recurring shows, etc.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "Short identifier, e.g. 'waris_vendor', 'default_japan_show', 'sunstone_season'" },
          value: { type: "string", description: "The fact to remember" },
          category: { type: "string", description: "vendor | preference | business_rule | show | pricing | other" }
        },
        required: ["key", "value"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "delete_memory",
      description: "Delete a stored memory fact by key.",
      parameters: {
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "create_purchase_order",
      description: "Create a Purchase Order (PO) — an intent to buy before the bill arrives. Different from a bill. Use when user says 'raise a PO', 'order from', 'purchase order for', etc.",
      parameters: {
        type: "object",
        properties: {
          vendor: { type: "string" },
          date: { type: "string", description: "YYYY-MM-DD, defaults to today" },
          currency: { type: "string", description: "Default INR" },
          advance: { type: "string", description: "Advance amount if any" },
          follow_up_date: { type: "string", description: "YYYY-MM-DD date to follow up" },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                desc: { type: "string", description: "Item name/description e.g. 'Moss Agate Spheres'" },
                spec: { type: "string", description: "Size, grade, count-per-kg, or any quality spec e.g. '40mm', '25 pcs per kg', 'transparent'. NOT a price." },
                shape: { type: "string" },
                qty: { type: "string" },
                unit: { type: "string", description: "pcs/kg/ct/gm" },
                rate: { type: "number", description: "Monetary price per unit in numbers ONLY. Leave null if no price given. NEVER put specs or descriptions here." },
                gst: { type: "string", description: "Default '3'" }
              },
              required: ["desc"]
            }
          },
          notes: { type: "string" }
        },
        required: ["vendor", "items"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_purchase_orders",
      description: "Get purchase orders (POs). Different from bills — these are open orders not yet fulfilled.",
      parameters: {
        type: "object",
        properties: {
          vendor: { type: "string" },
          status: { type: "string", description: "open, closed, cancelled — defaults to open" },
          limit: { type: "number", description: "Default 10" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "create_vendor",
      description: "Add a new vendor/supplier.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          gstin: { type: "string" },
          location: { type: "string" },
          country: { type: "string" },
          contact: { type: "string" },
          notes: { type: "string" }
        },
        required: ["name"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "attach_document_to_transaction",
      description: "Attach the file the user just sent (PDF/photo, e.g. a tax invoice or receipt) to a recent Finance transaction. Use when the user sends a file and asks to attach/add it to a transaction (e.g. 'attach this to the recent IKEA transaction'). The file must be in the SAME message.",
      parameters: {
        type: "object",
        properties: {
          payee: { type: "string", description: "Payee/merchant to match the transaction by, e.g. 'IKEA', 'ShipGlobal'." },
          amount: { type: "number", description: "Optional exact amount to disambiguate." },
          days_back: { type: "number", description: "How many days back to look (default 30)." }
        },
        required: []
      }
    }
  }
];

// ── Tool executors ────────────────────────────────────────────────────────────
async function execGetStock({ query = "", unit, region, unsold_only = true, in_show = false, limit = 50 }) {
  const stock = (await loadK(_ctx.stock)) || [];
  const q = query.toLowerCase().trim();
  const results = stock.filter(s => {
    if (unsold_only && s.soldDate) return false;
    if (in_show && (!s.showTag || s.region === "India")) return false;
    if (region && s.region?.toLowerCase() !== region.toLowerCase()) return false;
    if (unit && s.unit?.toLowerCase() !== unit.toLowerCase()) return false;
    if (!q) return true;
    return [s.material, s.shape, s.location, s.region, s.showTag, s.origin, s.grade, s.vendor, s.notes, s.productType]
      .some(f => f?.toLowerCase().includes(q));
  }).slice(0, Math.min(limit, 200));

  if (!results.length) return { count: 0, items: [], note: `No items found${q ? ` matching "${query}"` : ""}` };
  return {
    count: results.length,
    items: results.map(s => ({
      id: s.id, material: s.material, shape: s.shape,
      qty: s.qty, unit: s.unit, qty2: s.qty2, unit2: s.unit2,
      location: s.location, region: s.region || "India",
      showTag: s.showTag, costPrice: s.costPrice,
      grade: s.grade, origin: s.origin, addedDate: s.addedDate,
      vendor: s.vendor, soldDate: s.soldDate || null
    }))
  };
}

async function execGetStockSummary({ material, group_by = "material" }) {
  const stock = (await loadK(_ctx.stock)) || [];
  const unsold = stock.filter(s => !s.soldDate);
  let filtered = material
    ? unsold.filter(s => s.material?.toLowerCase().includes(material.toLowerCase()))
    : unsold;

  const groups = {};
  for (const s of filtered) {
    const key = group_by === "region" ? (s.region || "India")
      : group_by === "unit" ? (s.unit || "pcs")
      : group_by === "location" ? (s.location || "no box")
      : (s.material || "Unknown");
    const unit = s.unit || "pcs";
    if (!groups[key]) groups[key] = {};
    groups[key][unit] = (groups[key][unit] || 0) + (parseFloat(s.qty) || 0);
  }

  return { total_items: filtered.length, summary: groups, note: material ? `Filtered to: ${material}` : "All unsold stock" };
}

async function execGetInvoices({ buyer, limit = 10, latest_only = false }) {
  const invoices = (await loadK(_ctx.invoices)) || [];
  let results = [...invoices].sort((a, b) => (b.date || b.createdAt || "").localeCompare(a.date || a.createdAt || ""));
  if (buyer) {
    const bq = buyer.toLowerCase();
    results = results.filter(i => i.buyer?.toLowerCase().includes(bq) || i.buyerName?.toLowerCase().includes(bq));
  }
  if (latest_only && results.length) {
    const inv = results[0];
    return { invoice: { id: inv.id, invNo: inv.invNo, date: inv.date, buyer: inv.buyer || inv.buyerName, currency: inv.currency || "INR", items: (inv.items || []).map(i => ({ desc: i.desc, qty: i.qty, unit: i.unit, rate: i.rate, total: (+(i.qty||0))*(+(i.rate||0)) })), total: (inv.items || []).reduce((s, i) => s + (+(i.qty||0))*(+(i.rate||0)), 0), notes: inv.notes, status: inv.status } };
  }
  return results.slice(0, limit).map(inv => ({ id: inv.id, invNo: inv.invNo, date: inv.date, buyer: inv.buyer || inv.buyerName, currency: inv.currency || "INR", items_count: (inv.items || []).length, total: (inv.items || []).reduce((s, i) => s + (+(i.qty||0))*(+(i.rate||0)), 0), status: inv.status }));
}

async function execGetPurchases({ vendor, limit = 10, latest_only = false }) {
  const purchases = (await loadK(_ctx.purchases)) || [];
  let results = [...purchases]
    .filter(p => p.type !== "po")
    .sort((a, b) => (b.date || b.createdAt || "").localeCompare(a.date || a.createdAt || ""));
  if (vendor) {
    const vq = vendor.toLowerCase();
    results = results.filter(p => p.vendorName?.toLowerCase().includes(vq) || p.supplier?.toLowerCase().includes(vq));
  }
  if (latest_only && results.length) {
    const p = results[0];
    return { purchase: { id: p.id, vendor: p.vendorName || p.supplier, date: p.date || p.billDate, currency: p.currency || "INR", status: p.status, totalAmount: p.totalAmount, paidAmount: p.paidAmount, items: (p.items || []).map(i => ({ desc: i.desc, qty: i.qty, unit: i.unit, rate: i.rate, amt: i.amt })), notes: p.notes } };
  }
  return results.slice(0, limit).map(p => ({ id: p.id, vendor: p.vendorName || p.supplier, date: p.date || p.billDate, currency: p.currency || "INR", items_count: (p.items || []).length, totalAmount: p.totalAmount, paidAmount: p.paidAmount, status: p.status }));
}

async function execGetExpenses({ category, days_back, limit = 15 }) {
  const expenses = (await loadK(_ctx.expenses)) || [];
  let results = [...expenses].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  if (category) {
    const cq = category.toLowerCase();
    results = results.filter(e => (e.cat || e.category || "").toLowerCase().includes(cq));
  }
  if (days_back) {
    const cutoff = new Date(Date.now() - days_back * 86400000).toISOString().slice(0, 10);
    results = results.filter(e => (e.date || "") >= cutoff);
  }
  const slice = results.slice(0, limit);
  const total = slice.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
  return { count: slice.length, total_inr: total, expenses: slice.map(e => ({ id: e.id, date: e.date, category: e.cat || e.category, description: e.description, amount: e.amount, currency: e.currency || "INR" })) };
}

async function execGetVendors({ query }) {
  const vendors = (await loadK(_ctx.vendors)) || [];
  let results = vendors;
  if (query) {
    const vq = query.toLowerCase();
    results = vendors.filter(v => v.name?.toLowerCase().includes(vq) || v.companyName?.toLowerCase().includes(vq));
  }
  return results.slice(0, 30).map(v => ({ id: v.id, name: v.name, location: v.location, country: v.country, contact: v.contact, gstin: v.gstin }));
}

async function execGetShows() {
  const shows = (await loadK(_ctx.shows)) || [];
  return shows.map(s => ({ id: s.id, name: s.name, city: s.city, country: s.country, startDate: s.startDate, endDate: s.endDate, status: s.status }));
}

async function execGetBusinessSummary({ period_days = 30 } = {}) {
  const [stock, purchases, expenses, invoices] = await Promise.all([
    loadK(_ctx.stock), loadK(_ctx.purchases), loadK(_ctx.expenses), loadK(_ctx.invoices)
  ]);
  const s = stock || [];
  const unsold = s.filter(x => !x.soldDate);
  const byRegion = {};
  for (const item of unsold) {
    const r = item.region || "India";
    byRegion[r] = (byRegion[r] || 0) + 1;
  }
  const cutoff = new Date(Date.now() - period_days * 86400000).toISOString().slice(0, 10);
  const recentExp = (expenses || []).filter(e => (e.date || "") >= cutoff);
  const recentPurch = (purchases || []).filter(p => p.type !== "po" && (p.date || p.billDate || "") >= cutoff);
  const totalExpenses = recentExp.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
  const stockValue = unsold.reduce((s, i) => s + (parseFloat(i.qty) || 0) * (parseFloat(i.costPrice) || 0), 0);
  const recentInvoices = (invoices || []).slice(0, 5).map(i => ({ invNo: i.invNo, buyer: i.buyer || i.buyerName, date: i.date, total: (i.items || []).reduce((s, x) => s + (+(x.qty||0))*(+(x.rate||0)), 0) }));
  return {
    stock: { total: s.length, unsold: unsold.length, sold: s.length - unsold.length, by_region: byRegion, estimated_value_inr: Math.round(stockValue) },
    last_N_days: period_days,
    expenses: { count: recentExp.length, total_inr: Math.round(totalExpenses) },
    purchases: { count: recentPurch.length },
    recent_invoices: recentInvoices,
    total_vendors: ((await loadK(_ctx.vendors)) || []).length
  };
}

// ── Finance helpers ──────────────────────────────────────────────────────────
// Mirrors computeBalances in src/FinanceApp.jsx — keep the two in step.
// Credit cards and overdrafts are liabilities: stored as a positive outstanding,
// so every movement lands on them with the sign flipped.
const LIABILITY_TYPES = new Set(["credit_card", "od"]);

function computeBalances(accs, txns) {
  const liabIds = new Set(accs.filter(a => LIABILITY_TYPES.has(a.type)).map(a => a.id));
  const bals = {};
  // `delta` is always in asset sense (+ = more money available to you).
  const apply = (id, delta) => { if (id) bals[id] = (bals[id] || 0) + (liabIds.has(id) ? -delta : delta); };
  accs.forEach(a => { bals[a.id] = +(a.openingBal || 0); });
  txns.forEach(t => {
    const amt = +t.amount || 0;
    if (t.type === "credit") {
      apply(t.accountTo, amt);
    } else if (t.type === "debit") {
      apply(t.accountFrom, -amt);
      if (t.classifiedAs === "cc_payment" && t.classifiedRef?.cardAccountId) {
        apply(t.classifiedRef.cardAccountId, amt);
      }
    } else if (t.type === "conversion") {
      apply(t.accountFrom, -amt);
      apply(t.accountTo, amt * (+t.convRate || 1));
    }
  });
  return bals;
}

function accountSearchText(a) {
  const bits = [a?.name, a?.id, a?.type, a?.currency].filter(Boolean).join(" ").toLowerCase();
  const aliases = [];
  if (/bank of india|boi|0451/.test(bits)) aliases.push("boi bank of india current current account operative 006420110000451 0451 inr");
  if (/eefc/.test(bits)) aliases.push("eefc foreign currency usd dollar export");
  if (a?.type === "od") aliases.push(`od overdraft cc limit against fd ${a.odAccountNo || ""} ${String(a.odAccountNo || "").slice(-4)}`);
  return `${bits} ${aliases.join(" ")}`;
}
function findFinanceAccount(accs, query, currency = "") {
  const q = String(query || "").toLowerCase().trim();
  const cur = String(currency || "").toUpperCase();
  if (!q && !cur) return null;
  const words = q.split(/[^a-z0-9]+/).filter(Boolean);
  const active = (accs || []).filter(a => a.active !== false);
  const scored = active.map(a => {
    const hay = accountSearchText(a);
    let score = 0;
    if (cur && String(a.currency || "").toUpperCase() === cur) score += 2;
    if (q && hay.includes(q)) score += 8;
    for (const w of words) if (hay.includes(w)) score += w.length >= 4 ? 2 : 1;
    if (/\bcurrent\b/.test(q) && /bank of india|boi|0451/.test(hay)) score += 10;
    if (/\beefc\b/.test(q) && /eefc/.test(hay)) score += 10;
    return { a, score };
  }).sort((x, y) => y.score - x.score);
  return scored[0]?.score > 0 ? scored[0].a : null;
}

async function execGetFinanceAccounts({ account_name } = {}) {
  const [accounts, transactions, rates] = await Promise.all([
    loadK(_ctx.finAccs), loadK(_ctx.finTxns), loadK(_ctx.rates),
  ]);
  const accs = (accounts || []).filter(a => a.active !== false);
  const txns = transactions || [];
  const fx = rates || {};
  const bals = computeBalances(accs, txns);
  const toINR = (amount, currency) => (!currency || currency === "INR") ? (+amount || 0) : (+amount || 0) * (fx[currency] || 1);

  let result = accs.map(a => {
    const bal = Math.round((bals[a.id] || 0) * 100) / 100;
    const row = {
      name: a.name, type: a.type || "bank", currency: a.currency || "INR",
      balance: bal,
      balance_inr: Math.round(toINR(bal, a.currency)),
    };
    if (LIABILITY_TYPES.has(a.type)) row.note = "Liability — balance is the outstanding amount owed, not money available";
    if (a.type === "od") {
      const rate = (+a.odFdRate || 0) + (+a.odSpread || 0);
      row.od_drawn = Math.max(0, bal);
      row.od_limit = +a.odLimit || null;
      row.od_available = a.odLimit ? Math.round((+a.odLimit - Math.max(0, bal)) * 100) / 100 : null;
      row.od_interest_rate_pct = rate || null;
    }
    return row;
  });

  if (account_name) {
    const q = account_name.toLowerCase();
    result = result.filter(a => a.name.toLowerCase().includes(q));
  }
  const totalINR = result.reduce((s, a) => s + (LIABILITY_TYPES.has(a.type) ? -a.balance_inr : a.balance_inr), 0);
  return { accounts: result, total_net_inr: Math.round(totalINR) };
}

async function execGetFinanceTransactions({ account_name, days_back = 30, limit = 20 } = {}) {
  const [accounts, transactions] = await Promise.all([
    loadK(_ctx.finAccs), loadK(_ctx.finTxns),
  ]);
  const accs = (accounts || []);
  let txns = (transactions || []).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  if (days_back) {
    const cutoff = new Date(Date.now() - days_back * 86400000).toISOString().slice(0, 10);
    txns = txns.filter(t => (t.date || "") >= cutoff);
  }
  if (account_name) {
    const q = account_name.toLowerCase();
    const matchIds = accs.filter(a => a.name.toLowerCase().includes(q)).map(a => a.id);
    txns = txns.filter(t => matchIds.includes(t.accountFrom) || matchIds.includes(t.accountTo));
  }
  const getAccName = id => accs.find(a => a.id === id)?.name || id;
  return txns.slice(0, limit).map(t => ({
    id: t.id, date: t.date, type: t.type,
    amount: t.amount, currency: t.currency,
    account: t.type === "conversion"
      ? `${getAccName(t.accountFrom)} → ${getAccName(t.accountTo)}`
      : getAccName(t.accountTo || t.accountFrom),
    payee: t.payee, category: t.category, notes: t.notes
  }));
}

// Upload the file the user attached in this message to Supabase Storage and return an
// attachment object, or null on failure / no file.
async function storePendingFile(targetId) {
  if (!_pendingFile) return null;
  const fileUrl = await tgFileUrl(_pendingFile.fileId);
  if (!fileUrl) return null;
  try {
    const buf = _pendingFileBuffer || await (async () => {
      const resp = await fetch(fileUrl);
      return Buffer.from(await resp.arrayBuffer());
    })();
    _pendingFileBuffer = buf;
    const client = sb();
    await client.storage.createBucket("ng-media", { public: true }).catch(() => {});
    const ext = (_pendingFile.name.split(".").pop() || (_pendingFile.mime.includes("pdf") ? "pdf" : _pendingFile.mime.includes("image") ? "jpg" : "bin")).toLowerCase();
    const path = `telegram/${targetId}-${Date.now()}.${ext}`;
    const { error: upErr } = await client.storage.from("ng-media").upload(path, buf, { contentType: _pendingFile.mime, upsert: true });
    if (upErr) return null;
    const url = client.storage.from("ng-media").getPublicUrl(path).data.publicUrl;
    return { id: uid(), url, name: _pendingFile.name, type: _pendingFile.mime, uploadedAt: new Date().toISOString() };
  } catch { return null; }
}

async function pendingFileBuffer() {
  if (!_pendingFile) return null;
  if (_pendingFileBuffer) return _pendingFileBuffer;
  const fileUrl = await tgFileUrl(_pendingFile.fileId);
  if (!fileUrl) return null;
  const resp = await fetch(fileUrl);
  if (!resp.ok) throw new Error(`Telegram file download failed: ${resp.status}`);
  _pendingFileBuffer = Buffer.from(await resp.arrayBuffer());
  return _pendingFileBuffer;
}

async function extractPendingPdfText() {
  if (!_pendingFile || !/pdf/i.test(`${_pendingFile.mime} ${_pendingFile.name}`)) return "";
  const buf = await pendingFileBuffer();
  if (!buf) return "";
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: buf });
  try {
    const result = await parser.getText();
    return result.text || "";
  } finally {
    await parser.destroy().catch(() => {});
  }
}

function parseBoiRemittanceAdvice(text) {
  const s = String(text || "");
  if (!/FOREIGN\s+INWARD\s+REMITTANCE\s+ADVICE/i.test(s)) return null;
  if (!/Currency\s+Conversion\s+Details/i.test(s)) return null;
  const purchase = s.match(/Purchase\s*:\s*([A-Z]{3})\s*([0-9,.]+)\s+([0-9,.]+)\s+([A-Z]{3})\s*([0-9,.]+)/i);
  if (!purchase) return null;
  const srcCur = purchase[1].toUpperCase();
  const srcAmt = parseNum(purchase[2]);
  const shownRate = parseNum(purchase[3]);
  const dstCur = purchase[4].toUpperCase();
  const grossDst = parseNum(purchase[5]);
  if (!srcAmt || !grossDst) return null;
  const operative = s.match(/Operative\s+([0-9]{6,})\s+[\s\S]*?\b([A-Z]{3})\s+Cr\s+([0-9,.]+)/i);
  const credited = operative ? parseNum(operative[3]) : grossDst;
  const accountNo = operative?.[1] || (s.match(/Account\s+Number\s+([0-9]{6,})/i)?.[1] || "");
  const remittanceNo = s.match(/Remittance\s+No\.\s*([A-Z0-9]+)/i)?.[1] || "";
  const transactionId = s.match(/Transaction\s+Id\s*:\s*([A-Z0-9]+)/i)?.[1] || "";
  const txnDate = parseDateLoose(s.match(/Transaction\s+Date\s*:\s*([0-9./-]+)/i)?.[1]) || todayStr();
  const charges = credited != null ? Math.max(0, Math.round((grossDst - credited) * 100) / 100) : 0;
  return {
    from_account: "EEFC",
    to_account: accountNo ? `Bank of India ${accountNo} current` : "Bank of India current",
    amount_from: srcAmt,
    currency_from: srcCur,
    amount_to: credited || grossDst,
    currency_to: dstCur,
    rate: credited ? credited / srcAmt : shownRate,
    shownRate,
    grossDst,
    charges,
    date: txnDate,
    notes: [
      "BOI foreign inward remittance advice",
      remittanceNo && `Remittance ${remittanceNo}`,
      transactionId && `Transaction ${transactionId}`,
      shownRate && `shown FX ${shownRate}`,
      grossDst && credited && grossDst !== credited && `gross ${dstCur} ${grossDst}, charges/tax ${dstCur} ${charges}`,
    ].filter(Boolean).join(" · "),
  };
}

async function maybeHandleRemittancePdf(chatId, updateId, session) {
  if (!_pendingFile || !/pdf/i.test(`${_pendingFile.mime} ${_pendingFile.name}`)) return false;
  const text = await extractPendingPdfText();
  const transfer = parseBoiRemittanceAdvice(text);
  if (!transfer) return false;
  const result = await execLogFinanceTransfer(transfer);
  const suffix = result.duplicate ? "Already had it, so I skipped the duplicate" : "Saved";
  const amountTo = transfer.amount_to != null ? ` → ${fmtMoney(transfer.amount_to, transfer.currency_to)}` : "";
  await send(chatId, `${suffix}: EEFC ${fmtMoney(transfer.amount_from, transfer.currency_from)}${amountTo} into BOI current. PDF attached.`);
  await saveSession(chatId, { ...session, lastUpdateId: updateId });
  return true;
}

async function execLogFinanceTransaction({ type, amount, currency = "INR", account, payee, category, date, notes }) {
  const [accounts, transactions] = await Promise.all([
    loadK(_ctx.finAccs), loadK(_ctx.finTxns),
  ]);
  const accs = (accounts || []).filter(a => a.active !== false);
  const txns = transactions || [];

  // Match account by name keyword
  const matchedAccount = findFinanceAccount(accs, account, currency);
  const accountId = matchedAccount?.id || null;

  const hasDateCue = (() => {
    const s = String(_currentText || "").toLowerCase();
    return /\b(today|yesterday|tomorrow|aaj|kal)\b/.test(s)
      || /\b\d{4}-\d{2}-\d{2}\b/.test(s)
      || /\b\d{1,2}[\/.-]\d{1,2}(?:[\/.-]\d{2,4})?\b/.test(s)
      || /\b\d{1,2}(?:st|nd|rd|th)?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b/.test(s)
      || /\b(january|february|march|april|june|july|august|september|october|november|december)\b/.test(s);
  })();
  const txnDate = (!_currentHasVision && !hasDateCue) ? todayStr() : (date || todayStr());

  // Dedup: a forwarded/batched payment notification can arrive more than once. Skip if an
  // equivalent transaction already exists — same type + amount + (loose) payee within a
  // 7-day window — so the ledger isn't double-counted and the alert isn't repeated.
  const amt = +amount || 0;
  const py  = String(payee || "").trim().toLowerCase();
  const refRaw = String(notes || "").match(/\b\d{9,}\b/)?.[0] || null; // UPI/UTR ref if present
  const within7d = d => { const t = new Date(d).getTime(); return Number.isFinite(t) && Math.abs(t - new Date(txnDate).getTime()) <= 7 * 86400000; };
  const dup = (txns || []).find(t => {
    if (refRaw && String(t.notes || "").includes(refRaw)) return true; // exact ref match (any date)
    if (t.type !== type) return false;
    if (Math.abs((+t.amount || 0) - amt) >= 0.01) return false;
    if (!within7d(t.date || t.createdAt)) return false;
    const tp = String(t.payee || "").trim().toLowerCase();
    return py && tp ? (tp === py || tp.includes(py) || py.includes(tp)) : true;
  });
  if (dup) {
    // Already recorded — but if the user sent a screenshot/receipt, still attach it to the
    // existing entry so the document isn't lost.
    let att = null;
    if (_pendingFile) {
      att = await storePendingFile(dup.id);
      if (att) {
        const existing = dup.attachments || (dup.attachmentUrl ? [{ url: dup.attachmentUrl, name: dup.attachmentName }] : []);
        const nextAtt = [...existing, att];
        const updated = txns.map(t => t.id === dup.id ? { ...t, attachments: nextAtt, attachmentUrl: nextAtt[0].url, attachmentName: nextAtt[0].name, updatedAt: new Date().toISOString() } : t);
        await saveK(_ctx.finTxns, updated);
      }
    }
    return { success: true, duplicate: true, txn_id: dup.id, type, amount, currency, payee, date: dup.date, screenshot_attached: !!att,
      note: "This payment is already in the ledger — skipped to avoid a duplicate" + (att ? ", and attached the screenshot to the existing entry." : ". (If it's genuinely a second, separate payment, say so and I'll record it.)") };
  }

  const txn = {
    id: uid(),
    type,
    amount: String(amount),
    currency,
    accountTo:   type === "credit" ? accountId : null,
    accountFrom: type === "debit"  ? accountId : null,
    payee: payee || "",
    category: category || "Other",
    date: txnDate,
    notes: notes || "Added via Telegram",
    createdAt: new Date().toISOString(),
  };

  // Auto-attach the payment screenshot / receipt the user sent in this message.
  let attached = false;
  if (_pendingFile) {
    const att = await storePendingFile(txn.id);
    if (att) { txn.attachments = [att]; txn.attachmentUrl = att.url; txn.attachmentName = att.name; attached = true; }
  }

  await saveK(_ctx.finTxns, [txn, ...txns]);
  await logActivity({ user: "Telegram", action: "created", module: "finance", label: `Finance ${type}: ${fmtMoney(amount, currency)} · ${payee || category || ""}`, targetId: txn.id, targetMod: "finance" });

  const accName = accountId ? accs.find(a => a.id === accountId)?.name : "no account linked";
  return { success: true, txn_id: txn.id, type, amount, currency, account: accName, payee, date: txn.date, screenshot_attached: attached };
}

async function execLogFinanceTransfer({ from_account, to_account, amount_from, currency_from, amount_to, currency_to, rate, date, notes }) {
  const [accounts, transactions] = await Promise.all([
    loadK(_ctx.finAccs), loadK(_ctx.finTxns),
  ]);
  const accs = (accounts || []).filter(a => a.active !== false);
  const txns = transactions || [];
  const from = findFinanceAccount(accs, from_account, currency_from);
  const to = findFinanceAccount(accs, to_account, currency_to);
  if (!from || !to) {
    return { error: `Couldn't match ${!from ? `source account "${from_account}"` : ""}${!from && !to ? " and " : ""}${!to ? `destination account "${to_account}"` : ""}. Call get_finance_accounts and try again.` };
  }
  if (from.id === to.id) return { error: "Source and destination accounts matched the same account." };

  const srcAmt = +amount_from || 0;
  if (srcAmt <= 0) return { error: "amount_from must be greater than zero." };
  const dstAmt = +amount_to || 0;
  const convRate = +(rate || (dstAmt ? dstAmt / srcAmt : 1)) || 1;
  const txnDate = date || todayStr();
  const refRaw = String(notes || "").match(/\b[A-Z]?\d{8,}\b/i)?.[0] || null;
  const within7d = d => { const t = new Date(d).getTime(); return Number.isFinite(t) && Math.abs(t - new Date(txnDate).getTime()) <= 7 * 86400000; };
  const dup = txns.find(t => {
    if (refRaw && String(t.notes || "").includes(refRaw)) return true;
    if (t.type !== "conversion") return false;
    if (t.accountFrom !== from.id || t.accountTo !== to.id) return false;
    if (Math.abs((+t.amount || 0) - srcAmt) >= 0.01) return false;
    return within7d(t.date || t.createdAt);
  });
  if (dup) {
    let att = null;
    if (_pendingFile) {
      att = await storePendingFile(dup.id);
      if (att) {
        const existing = dup.attachments || (dup.attachmentUrl ? [{ url: dup.attachmentUrl, name: dup.attachmentName }] : []);
        const nextAtt = [...existing, att];
        const updated = txns.map(t => t.id === dup.id ? { ...t, attachments: nextAtt, attachmentUrl: nextAtt[0].url, attachmentName: nextAtt[0].name, updatedAt: new Date().toISOString() } : t);
        await saveK(_ctx.finTxns, updated);
      }
    }
    return { success: true, duplicate: true, txn_id: dup.id, note: "This transfer is already in the ledger — skipped to avoid a duplicate" + (att ? ", and attached the file to the existing entry." : ".") };
  }

  const txn = {
    id: uid(),
    type: "conversion",
    amount: String(srcAmt),
    currency: currency_from || from.currency || "INR",
    convRate: String(convRate),
    accountFrom: from.id,
    accountTo: to.id,
    payee: `${from.name} → ${to.name}`,
    category: "EEFC → BOI (INR)",
    date: txnDate,
    notes: notes || "Internal transfer added via Telegram",
    classifiedAs: "conversion",
    classifiedRef: { convOtherAccountId: to.id, rate: convRate },
    createdAt: new Date().toISOString(),
  };

  let attached = false;
  if (_pendingFile) {
    const att = await storePendingFile(txn.id);
    if (att) { txn.attachments = [att]; txn.attachmentUrl = att.url; txn.attachmentName = att.name; attached = true; }
  }

  await saveK(_ctx.finTxns, [txn, ...txns]);
  await logActivity({ user: "Telegram", action: "created", module: "finance", label: `Transfer: ${fmtMoney(srcAmt, txn.currency)} ${from.name} → ${to.name}`, targetId: txn.id, targetMod: "finance" });

  return { success: true, txn_id: txn.id, type: "conversion", from: from.name, to: to.name, amount_from: srcAmt, currency_from: txn.currency, amount_to: Math.round(srcAmt * convRate * 100) / 100, currency_to: to.currency || currency_to || "INR", rate: convRate, date: txn.date, file_attached: attached };
}

async function execAttachDocument({ payee, amount, days_back = 45 } = {}) {
  if (!_pendingFile) return { error: "No file is attached. Send the PDF/photo together with the instruction in one message." };
  const txns = (await loadK(_ctx.finTxns)) || [];
  const q = String(payee || "").trim().toLowerCase();
  const stop = new Set(["the", "for", "recent", "transaction", "payment", "this", "that", "attach", "purchase", "paid", "from", "with"]);
  const qWords = q.split(/\s+/).filter(w => w.length >= 3 && !stop.has(w));
  const amt = amount != null ? +amount : null;
  const cutoff = Date.now() - (+days_back || 45) * 86400000;
  // Score across payee + notes + category; amount is a BOOST, not a hard filter (an invoice
  // often shows several different numbers, so don't reject on amount mismatch).
  const scored = txns
    .map(t => {
      const d = new Date(t.date || t.createdAt).getTime();
      if (Number.isFinite(d) && d < cutoff) return null;
      const hay = `${t.payee || ""} ${t.notes || ""} ${t.category || ""}`.toLowerCase();
      let score = 0;
      if (q && hay.includes(q)) score += 4;
      else if (qWords.some(w => hay.includes(w))) score += 2;
      if (amt != null && Math.abs((+t.amount || 0) - amt) < 0.01) score += 3;
      return { t, score, d: Number.isFinite(d) ? d : 0 };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || b.d - a.d);
  // Prefer a real match; if the user gave no useful hint, fall back to the most recent txn.
  let target = scored.find(s => s.score > 0)?.t;
  if (!target && !qWords.length && amt == null) target = scored[0]?.t;
  if (!target) return { error: `Couldn't find a recent transaction matching ${q ? `"${payee}"` : "that"}. Tell me the merchant or amount (e.g. "the ₹15,502 Manek Emporium one").` };

  const att = await storePendingFile(target.id);
  if (!att) return { error: "Couldn't store the file (it may have expired — resend it)." };
  const existing = target.attachments || (target.attachmentUrl ? [{ url: target.attachmentUrl, name: target.attachmentName }] : []);
  const nextAtt = [...existing, att];
  const updated = txns.map(t => t.id === target.id
    ? { ...t, attachments: nextAtt, attachmentUrl: nextAtt[0].url, attachmentName: nextAtt[0].name, updatedAt: new Date().toISOString() }
    : t);
  await saveK(_ctx.finTxns, updated);
  await logActivity({ user: "Telegram", action: "attached", module: "finance", label: `Attached ${_pendingFile.name} to ${target.payee || "transaction"} (${fmtMoney(target.amount, target.currency)})`, targetId: target.id, targetMod: "finance" });
  return { success: true, attached_to: { payee: target.payee, amount: target.amount, currency: target.currency, date: target.date }, file: _pendingFile.name };
}

async function execRecordPayment({ id, amount, currency, date, notes }) {
  const purchases = (await loadK(_ctx.purchases)) || [];
  const item = purchases.find(p => p.id === id);
  if (!item) return { success: false, error: "Bill or PO not found with that ID" };

  const totalAmount = +item.totalAmount || 0;
  const prevPaid = +item.paidAmount || 0;
  const newPaid = prevPaid + (+amount || 0);
  const status = totalAmount > 0 && newPaid >= totalAmount ? "paid" : newPaid > 0 ? "partial" : item.status;

  const updated = purchases.map(p => p.id === id
    ? { ...p, paidAmount: newPaid, paymentDate: date || todayStr(), paymentNote: notes || "", status, updatedAt: new Date().toISOString() }
    : p
  );
  await saveK(_ctx.purchases, updated);

  const label = item.type === "po" ? (item.poNumber || "PO") : (item.billNumber || "Bill");
  await logActivity({ user: "Telegram", action: "updated", module: "purchases", label: `Payment ${fmtMoney(amount, currency || item.currency)} → ${label} (${item.vendorName || item.supplier})`, targetId: id, targetMod: "purchases" });

  return { success: true, id, label, vendor: item.vendorName || item.supplier, paid: newPaid, total: totalAmount, status };
}

async function execCreatePurchase(data) {
  const purchases = (await loadK(_ctx.purchases)) || [];
  const vendors = (await loadK(_ctx.vendors)) || [];
  const vq = (data.vendor || "").toLowerCase();
  const vendor = vendors.find(v => v.name?.toLowerCase().includes(vq) || v.companyName?.toLowerCase().includes(vq));
  const items = (data.items || []).map(i => {
    const qty = +i.qty || 0;
    const rate = i.rate != null && !isNaN(Number(i.rate)) ? Number(i.rate) : 0;
    const amt = qty * rate;
    const descParts = [i.material, i.shape, i.spec].filter(Boolean);
    return {
      id: uid(),
      desc: descParts.join(" "),
      shape: i.shape || "",
      hsn: "7103", gst: i.gst || "3",
      qty: String(i.qty || ""), unit: i.unit || "pcs",
      rate: rate ? String(rate) : "",
      amt,
      received: false, rcvDate: data.date || todayStr(), location: "", cond: "ok", physicalEntries: [],
    };
  });
  const totalAmount = items.reduce((s, i) => s + (i.amt || 0), 0);
  const bill = {
    id: uid(), vendorId: vendor?.id || "", vendorName: data.vendor || "",
    date: data.date || todayStr(), currency: data.currency || "INR",
    items, totalAmount,
    notes: data.notes || "Added via Telegram", status: "pending",
    docUrl: "", docData: "", docName: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  await saveK(_ctx.purchases, [bill, ...purchases]);
  await logActivity({ user: "Telegram", action: "created", module: "purchases", label: `Purchase: ${data.vendor} · ${items.map(i => i.desc).join(", ")}`, targetId: bill.id, targetMod: "purchases" });
  return { success: true, bill_id: bill.id, vendor: data.vendor, date: bill.date, items_count: items.length, total: totalAmount, currency: bill.currency };
}

async function execCreateExpense(data) {
  const expenses = (await loadK(_ctx.expenses)) || [];
  const expense = {
    id: uid(), date: data.date || todayStr(), cat: data.category || "Other",
    description: data.description || "", amount: String(data.amount || ""),
    currency: data.currency || "INR", notes: "Added via Telegram", createdAt: new Date().toISOString(),
  };
  await saveK(_ctx.expenses, [expense, ...expenses]);
  await logActivity({ user: "Telegram", action: "created", module: "expenses", label: `Expense: ${expense.cat} · ${fmtMoney(expense.amount)}`, targetId: expense.id, targetMod: "expenses" });
  return { success: true, expense_id: expense.id, category: expense.cat, amount: expense.amount, currency: expense.currency };
}

async function execSendToShow({ item_ids, show_id }) {
  const stock = (await loadK(_ctx.stock)) || [];
  const shows = (await loadK(_ctx.shows)) || [];
  const show = shows.find(s => s.id === show_id);
  if (!show) return { success: false, error: "Show not found" };
  const t = ((show.city || "") + " " + (show.name || "")).toLowerCase();
  const region = /japan|tokyo|osaka|kyoto|ikebukuro|nagoya/.test(t) ? "Japan"
    : /usa|america|denver|tucson|arizona/.test(t) ? "USA"
    : /europe|germany|munich|france|paris|italy|spain/.test(t) ? "Europe" : "India";
  const idSet = new Set(item_ids);
  const sentItems = stock.filter(s => idSet.has(s.id));
  if (!sentItems.length) return { success: false, error: "No matching stock items found" };
  const newStock = stock.map(s => idSet.has(s.id) ? { ...s, region, showTag: show.name, sentAt: todayStr() } : s);
  await saveK(_ctx.stock, newStock);
  await logActivity({ user: "Telegram", action: "sent", module: "stock", label: `Sent ${sentItems.length} item(s) → ${region} (${show.name})`, targetMod: "stock" });
  return { success: true, sent_count: sentItems.length, show: show.name, region };
}

async function execMarkSold({ item_id, qty, sold_price, sold_currency = "INR" }) {
  const stock = (await loadK(_ctx.stock)) || [];
  const item = stock.find(s => s.id === item_id);
  if (!item) return { success: false, error: "Item not found" };
  const soldQty = qty || parseFloat(item.qty) || 1;
  const remaining = Math.max(0, (parseFloat(item.qty) || 0) - soldQty);
  const newStock = stock.map(s => s.id === item_id ? { ...s, qty: String(remaining), soldDate: todayStr(), soldPrice: sold_price, soldCurrency: sold_currency } : s);
  await saveK(_ctx.stock, newStock);
  await logActivity({ user: "Telegram", action: "sold", module: "stock", label: `Sold: ${item.material} ${item.shape || ""} · ${soldQty} ${item.unit || "pcs"}`, targetId: item_id, targetMod: "stock" });
  return { success: true, item: `${item.material} ${item.shape || ""}`.trim(), qty_sold: soldQty, remaining_qty: remaining };
}

async function execAddStockItems({ items }) {
  if (!Array.isArray(items) || !items.length) return { success: false, error: "No items to add" };
  const stock = (await loadK(_ctx.stock)) || [];
  const created = items
    .filter(i => String(i.material || "").trim() || String(i.shape || "").trim())
    .map(i => ({
      id: uid(),
      material: String(i.material || "").trim(),
      shape: String(i.shape || "").trim(),
      origin: String(i.origin || "").trim(),
      size: String(i.size || "").trim(),
      grade: String(i.grade || "").trim(),
      hsn: "7103",
      qty: String(i.qty ?? "").trim(),
      unit: i.unit || "pcs",
      weightGm: String(i.weightGm || "").trim(),
      costPrice: String(i.costPrice || "").trim(),
      listPrice: "",
      location: String(i.location || "").trim(),
      market: [],
      productType: "",
      photographed: false, postedShopify: false, postedWix: false, postedEtsy: false,
      photo: "", photos: [], video: "",
      notes: String(i.notes || "").trim(),
      addedDate: todayStr(),
      source: "telegram",
      sku: "",
      vendor: String(i.vendor || "").trim(),
      region: "India",
      files: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }));
  if (!created.length) return { success: false, error: "No valid items (each needs at least a material or shape)" };
  await saveK(_ctx.stock, [...created, ...stock]);
  const label = created.map(c => [c.material, c.shape].filter(Boolean).join(" ")).slice(0, 5).join(", ");
  await logActivity({ user: "Telegram", action: "created", module: "stock", label: `Added ${created.length} stock item(s): ${label}${created.length > 5 ? "…" : ""}`, targetMod: "stock" });
  return { success: true, added_count: created.length, items: created.map(c => ({ id: c.id, material: c.material, shape: c.shape, qty: c.qty, unit: c.unit, ...(c.size ? { size: c.size } : {}) })) };
}

async function execUpdateStockItems({ updates }) {
  const stock = (await loadK(_ctx.stock)) || [];
  let changed = 0;
  const newStock = stock.map(s => {
    const upd = updates.find(u => u.id === s.id);
    if (!upd) return s;
    changed++;
    return { ...s, ...upd.fields, updatedAt: new Date().toISOString() };
  });
  await saveK(_ctx.stock, newStock);
  return { success: true, updated_count: changed };
}

async function execReturnToIndia({ item_ids }) {
  const stock = (await loadK(_ctx.stock)) || [];
  const idSet = new Set(item_ids);
  const newStock = stock.map(s => idSet.has(s.id) ? { ...s, region: "India", showTag: null, sentAt: null } : s);
  await saveK(_ctx.stock, newStock);
  await logActivity({ user: "Telegram", action: "updated", module: "stock", label: `Returned ${item_ids.length} item(s) to India`, targetMod: "stock" });
  return { success: true, returned_count: item_ids.length };
}

async function execSaveMemory({ key, value, category = "other" }) {
  const facts = await getMemory();
  const idx = facts.findIndex(f => f.key === key);
  const fact = { key, value, category, ts: new Date().toISOString() };
  if (idx >= 0) facts[idx] = fact; else facts.unshift(fact);
  await saveMemory(facts);
  return { success: true, saved: fact };
}

async function execDeleteMemory({ key }) {
  const facts = await getMemory();
  await saveMemory(facts.filter(f => f.key !== key));
  return { success: true, deleted: key };
}

async function execCreateVendor(data) {
  const vendors = (await loadK(_ctx.vendors)) || [];
  const vendor = { id: uid(), name: data.name, gstin: data.gstin || "", location: data.location || "", country: data.country || "", contact: data.contact || "", notes: data.notes || "", addedFrom: "telegram", createdAt: new Date().toISOString() };
  await saveK(_ctx.vendors, [vendor, ...vendors]);
  return { success: true, vendor_id: vendor.id, name: vendor.name };
}

async function execCreatePurchaseOrder(data) {
  const purchases = (await loadK(_ctx.purchases)) || [];
  const poCount = purchases.filter(p => p.type === "po").length + 1;
  const poNumber = `PO/${new Date().getFullYear()}/${String(poCount).padStart(3, "0")}`;
  const items = (data.items || []).map(i => {
    const qty = +i.qty || 0;
    const rate = i.rate != null && !isNaN(Number(i.rate)) ? Number(i.rate) : 0;
    const amt = qty * rate;
    return {
      id: uid(),
      desc: [i.desc, i.spec].filter(Boolean).join(" · "),
      shape: i.shape || "",
      hsn: "7103", gst: i.gst || "3",
      qty: String(i.qty || ""), unit: i.unit || "pcs",
      rate: rate ? String(rate) : "",
      amt,
      received: false, rcvDate: "", location: "", cond: "ok", physicalEntries: []
    };
  });
  const totalAmount = items.reduce((s, i) => s + (i.amt || 0), 0);
  const po = {
    type: "po", id: uid(), poNumber,
    supplier: data.vendor || "", date: data.date || todayStr(),
    currency: data.currency || "INR", advance: data.advance || "",
    items, totalAmount, notes: data.notes || "Added via Telegram",
    followUpDate: data.follow_up_date || "", status: "open",
    paidAmount: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  await saveK(_ctx.purchases, [po, ...purchases]);
  await logActivity({ user: "Telegram", action: "created", module: "purchases", label: `PO ${poNumber} · ${data.vendor} · ${items.length} item(s)`, targetId: po.id, targetMod: "purchases" });
  return { success: true, po_id: po.id, po_number: poNumber, vendor: data.vendor, date: po.date, items_count: items.length, total: totalAmount, currency: po.currency };
}

async function execGetPurchaseOrders({ vendor, status = "open", limit = 10 }) {
  const purchases = (await loadK(_ctx.purchases)) || [];
  let results = purchases.filter(p => p.type === "po");
  if (status && status !== "all") results = results.filter(p => (p.status || "open") === status);
  if (vendor) {
    const vq = vendor.toLowerCase();
    results = results.filter(p => p.supplier?.toLowerCase().includes(vq));
  }
  results = results.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  return results.slice(0, limit).map(p => ({
    id: p.id, po_number: p.poNumber, vendor: p.supplier, date: p.date,
    currency: p.currency, status: p.status, advance: p.advance,
    total: p.totalAmount, paid: p.paidAmount,
    follow_up: p.followUpDate, items_count: (p.items || []).length,
    items: (p.items || []).map(i => ({ desc: i.desc, qty: i.qty, unit: i.unit, rate: i.rate, amt: i.amt }))
  }));
}

// ── Tool dispatcher ───────────────────────────────────────────────────────────
async function runTool(name, args) {
  try {
    const map = {
      get_stock: execGetStock, get_stock_summary: execGetStockSummary,
      get_invoices: execGetInvoices, get_purchases: execGetPurchases,
      get_expenses: execGetExpenses, get_vendors: execGetVendors,
      get_shows: execGetShows, get_business_summary: execGetBusinessSummary,
      get_finance_accounts: execGetFinanceAccounts,
      get_finance_transactions: execGetFinanceTransactions,
      log_finance_transaction: execLogFinanceTransaction,
      log_finance_transfer: execLogFinanceTransfer,
      attach_document_to_transaction: execAttachDocument,
      record_payment: execRecordPayment,
      create_purchase: execCreatePurchase, create_expense: execCreateExpense,
      add_stock_items: execAddStockItems,
      send_to_show: execSendToShow, mark_sold: execMarkSold,
      update_stock_items: execUpdateStockItems, return_to_india: execReturnToIndia,
      save_memory: execSaveMemory, delete_memory: execDeleteMemory,
      create_vendor: execCreateVendor,
      create_purchase_order: execCreatePurchaseOrder,
      get_purchase_orders: execGetPurchaseOrders,
    };
    if (!map[name]) return { error: `Unknown tool: ${name}` };
    return await map[name](args);
  } catch (e) {
    return { error: e.message };
  }
}

// ── Build system prompt ───────────────────────────────────────────────────────
async function buildSystemPrompt() {
  const memory = await getMemory();
  const memoryBlock = memory.length
    ? `\n\n<memory>\nThings you know about this business:\n${memory.map(f => `- [${f.category}] ${f.key}: ${f.value}`).join("\n")}\n</memory>`
    : "";

  return `You are Gem — personal business AI for Nikhil, who runs ${_ctx.name}, a gemstone trading company.

Today is ${todayStr()}.${memoryBlock}

<business_context>
- Sources gems from vendors across India; ships to trade shows in Japan, USA, Europe
- Stock tracked by material, shape, qty/unit (kg/pcs/ct/gm), box location, cost price, grade, origin
- Purchases: vendor bills (buy confirmed) + Purchase Orders/POs (intent to buy)
- Finance module: bank accounts in INR/USD/JPY/EUR with full transaction ledger
- Expenses: freight, hotels, booth fees, staff, etc.
- GST default 3% for gems
</business_context>

<tools>
You have full access to read AND write everything:
- Stock: search, add new items (add_stock_items), update, send to show, return to India, mark sold
- Purchases & POs: create, view, record payments (record_payment)
- Expenses: create, view
- Invoices: view
- Finance accounts: get_finance_accounts (balances), get_finance_transactions (ledger), log_finance_transaction (one-sided income/expense), log_finance_transfer (internal transfer/conversion)
- Documents: you CAN attach files to transactions. When a user sends a payment screenshot/receipt and you log that payment, the image is AUTOMATICALLY attached to that transaction — confirm it ("…and saved the screenshot to it"). To attach a file to an EXISTING/older transaction, call attach_document_to_transaction.
- Vendors: search, create
- Memory: save/delete persistent facts

IMPORTANT RULES:
1. ALWAYS fetch real data with tools — never guess or make up numbers
2. "How much in [bank]" → use get_finance_accounts
3. "I paid X to Y" or "received X from Y" → call get_finance_accounts first (to know which accounts exist), then IMMEDIATELY call log_finance_transaction with the correct account. Do NOT ask if it's against a bill/PO — just log it. If the user mentioned a bill or PO explicitly, also call record_payment.
3a. If money moves between Nikhil's own accounts (especially EEFC → current account / BOI, USD cash → EEFC, or bank-to-bank), use log_finance_transfer, not log_finance_transaction. For BOI foreign inward remittance advice PDFs, treat them as EEFC → BOI/current conversions.
4. "What did I spend / what transactions" → use get_finance_transactions
5. For any write action, confirm what you're saving in one short line, then do it immediately — don't ask "shall I proceed?"
6. NEVER ask clarifying questions about a payment/receipt unless both the amount AND account are missing. If there's only one bank account in INR, use it automatically. Just log and confirm.
7. CRITICAL — act ONLY on the CURRENT message. Log/announce ONLY the payment(s) explicitly in this message or its screenshot. NEVER re-log, re-process, or re-mention a transaction from an earlier message — those are already saved and done. A new screenshot = exactly one new payment to log (unless the screenshot itself clearly shows more than one).
8. NOT every screenshot is a payment. A note/list/photo of stones with shapes, sizes and quantities is INVENTORY. If the user says "add to stock"/"add to inventory" (or it's clearly a stock note), call add_stock_items — one item per stone + shape line — and NEVER ask for payment details. Only ask for payment info when the user is actually logging a payment.
</tools>

<personality>
Sharp, dry, meticulous. Finance guy who also runs ops. Never lets a sloppy record through.
- Lead with the number: "₹4.2L in HDFC. $2,100 in USA account."
- No filler: never say "Great question!" or "Certainly!"
- Dry one-liners when earned, never forced
- One question at a time if clarification needed
- Rate = money only. Specs (40mm, AA grade) go in description, never rate field.
</personality>`;
}

// ── OpenAI agentic loop ───────────────────────────────────────────────────────
// Strip tool call sequences from history — only keep user + plain assistant text messages.
// Tool call pairs (assistant with tool_calls + role:tool results) are internal plumbing;
// if history is sliced mid-sequence OpenAI rejects the orphaned role:tool messages.
function sanitizeHistory(history) {
  return (history || []).filter(m =>
    (m.role === "user" && (typeof m.content === "string" || Array.isArray(m.content))) ||
    (m.role === "assistant" && typeof m.content === "string" && !m.tool_calls)
  );
}

async function chatWithOpenAI(history) {
  const systemContent = await buildSystemPrompt();
  // Only the most recent turns go to the model — long history full of past payments was
  // making it re-log/re-announce earlier transactions. The current turn is last, so kept.
  const messages = [{ role: "system", content: systemContent }, ...sanitizeHistory(history).slice(-10)];

  // gpt-4o has low org rate limits and the agentic tool-loop makes several calls
  // per message, so it 429s easily. Default to a mini model (much higher limits,
  // cheaper, fine for this chat/logging use) and retry transient 429/5xx with backoff.
  const MODEL = process.env.TELEGRAM_OPENAI_MODEL || "gpt-4.1-mini";
  const callOpenAI = async (msgs) => {
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.OPENAI_KEY}` },
        body: JSON.stringify({ model: MODEL, messages: msgs, tools: TOOLS, tool_choice: "auto", max_tokens: 2000, temperature: 0.2 })
      });
      if (r.ok) return r.json();
      const err = await r.text();
      lastErr = new Error(`OpenAI error ${r.status}: ${err.slice(0, 200)}`);
      if ((r.status === 429 || r.status >= 500) && attempt < 3) {
        await new Promise(res => setTimeout(res, 800 * 2 ** attempt + Math.random() * 400));
        continue;
      }
      throw lastErr;
    }
    throw lastErr || new Error("OpenAI request failed");
  };

  let data = await callOpenAI(messages);
  const newMessages = [];
  let iters = 0;

  while (data.choices?.[0]?.finish_reason === "tool_calls" && iters < 12) {
    iters++;
    const msg = data.choices[0].message;
    newMessages.push(msg);
    // Run all tool calls in parallel
    const toolResults = await Promise.all((msg.tool_calls || []).map(async call => {
      let args = {};
      try { args = JSON.parse(call.function.arguments); } catch {}
      const result = await runTool(call.function.name, args);
      return { role: "tool", tool_call_id: call.id, content: JSON.stringify(result) };
    }));
    newMessages.push(...toolResults);
    data = await callOpenAI([...messages, ...newMessages]);
  }

  const finalText = data.choices?.[0]?.message?.content || "Something went wrong on my end.";
  newMessages.push({ role: "assistant", content: finalText });
  return { reply: finalText, newMessages };
}

// ── Main handler ──────────────────────────────────────────────────────────────
export const config = { api: { bodyParser: true }, maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(200).json({ ok: true }); return; }

  // Respond immediately so Telegram never retries
  res.status(200).json({ ok: true });

  waitUntil((async () => {
    try {
      // Set request-scoped bot context
      _ctx = botCtx(req.query?.bot === "at");
      _pendingFile = null;
      _pendingFileBuffer = null;
      _currentText = "";
      _currentHasVision = false;

      const update = req.body || {};
      const updateId = update.update_id;
      const message = update.message || update.edited_message;
      if (!message) return;

      const chatId = message.chat?.id;
      const hasPhoto = Array.isArray(message.photo) && message.photo.length > 0;
      const doc = message.document || null;
      const caption  = (message.caption || "").trim();
      // Vision enabled for BOTH bots — they can read payment screenshots / receipts,
      // log the transaction, and attach the image to it.
      const wantsVision = hasPhoto;
      let imageUrl = null;
      if (wantsVision) {
        // Largest rendition is last in the photo size array
        imageUrl = await tgFileUrl(message.photo[message.photo.length - 1].file_id);
      }
      // The file (PDF/photo) sent this message — auto-attached when a payment is logged,
      // or attachable to an existing transaction on request.
      if (doc) _pendingFile = { fileId: doc.file_id, name: doc.file_name || "document", mime: doc.mime_type || "application/octet-stream" };
      else if (hasPhoto) _pendingFile = { fileId: message.photo[message.photo.length - 1].file_id, name: `payment-${Date.now()}.jpg`, mime: "image/jpeg" };
      const text = (message.text || caption || (
        doc ? `[file attached: ${doc.file_name || "document"}]`
        : wantsVision ? (imageUrl ? "[image attached]" : "[image attached but could not be loaded — ask the user to resend or describe it]")
        : hasPhoto ? "[image sent — describe what you need]" : ""
      )).trim();
      if (!chatId || !text) return;
      _currentText = text;
      _currentHasVision = !!(wantsVision && imageUrl);

      // Auth
      const allowed = _ctx.allowed.split(",").map(s => s.trim()).filter(Boolean);
      if (allowed.length > 0 && !allowed.includes(String(chatId))) {
        await send(chatId, "⛔ Not authorized.");
        return;
      }

      // Load session — single read
      const session = await getSession(chatId);

      // Deduplication — skip Telegram retries
      if (updateId && session.lastUpdateId === updateId) return;

      // Commands
      if (text === "/start" || text === "/help") {
        await saveSession(chatId, { ...session, lastUpdateId: updateId });
        await send(chatId, [
          `<b>${_ctx.name} · Gem</b>`,
          ``,
          `Connected to your full database. Just talk.`,
          ``,
          `<b>Examples:</b>`,
          `"How much do I have in my USA bank?"`,
          `"How many kgs of sunstone do we have?"`,
          `"What was in my last invoice?"`,
          `"Bought 50 rose quartz spheres from Waris, $2 each"`,
          `"I paid Charlin $881 for PO/2026/007"`,
          `"What's my total freight expense this month?"`,
          `"Send all amethyst to the Tokyo show"`,
          `"Mark the moonstone in box 42 sold for ₹8000"`,
          ``,
          `/clear — reset conversation`,
          `/memory — show saved facts`,
        ].join("\n"));
        return;
      }

      if (text === "/clear") {
        await clearSession(chatId);
        await send(chatId, "Cleared.");
        return;
      }

      if (text === "/memory") {
        await saveSession(chatId, { ...session, lastUpdateId: updateId });
        const facts = await getMemory();
        if (!facts.length) { await send(chatId, "Nothing saved yet."); return; }
        await send(chatId, `<b>Memory (${facts.length} facts)</b>\n\n` + facts.map(f => `• <b>${f.key}</b>: ${f.value}`).join("\n"));
        return;
      }

      // Bank of India foreign inward remittance advice PDFs are structured enough to
      // process deterministically: this is an EEFC → BOI/current conversion, not income.
      if (await maybeHandleRemittancePdf(chatId, updateId, session)) return;

      // Typing indicator (fire and forget)
      tg("sendChatAction", { chat_id: chatId, action: "typing" }, _ctx.token).catch(() => {});

      // Build history with new message
      const history = session.history || [];
      const isImageTurn = !!(wantsVision && imageUrl);
      const looksLikeFinanceWrite = !isImageTurn
        && /\d/.test(text)
        && /\b(to|from|paid|pay|payment|received|receive|sent|transfer|debit|credit|cash|bank|upi|bill|salary|rent)\b/i.test(text);
      // For the model this turn: attach the image as a vision part (both bots).
      const userContent = isImageTurn
        ? [
            { type: "text", text: caption
                ? `${caption}\n\nThe image above was sent with that instruction — act on the image according to it. If it's a stones/inventory note to add to stock, call add_stock_items (one item per stone + shape line) — do NOT treat it as a payment. If it's a payment/receipt to log, log ONLY the single payment it shows and don't re-mention any earlier transaction.`
                : `Read this screenshot and act on it:\n- Payment / receipt → log ONLY the single payment it shows; don't touch or re-mention any earlier transaction.\n- Stones / inventory list → call add_stock_items (one item per stone + shape line).\n- Anything else → say what you see and ask what to do.` },
            { type: "image_url", image_url: { url: imageUrl } },
          ]
        : text;
      // Screenshot/receipt and short payment-log turns are STATELESS — send no prior history so
      // the model can only act on the current message and never reuses an earlier payment/date.
      const modelHistory = (isImageTurn || looksLikeFinanceWrite)
        ? [{ role: "user", content: userContent }]
        : [...history, { role: "user", content: userContent }];

      // Run GPT-4o
      const { reply, newMessages } = await chatWithOpenAI(modelHistory);

      // Persist a text-only version of the user turn — the Telegram file URL is
      // temporary and image content would bloat the stored session.
      const persistedTurn = { role: "user", content: (wantsVision && imageUrl) ? (caption || "[sent an image]") : text };
      const finalHistory = sanitizeHistory([...history, persistedTurn, ...newMessages]).slice(-MAX_HISTORY);
      await saveSession(chatId, { lastUpdateId: updateId, history: finalHistory });

      await send(chatId, reply);

    } catch (err) {
      console.error("Bot error:", err);
      try {
        const chatId = req.body?.message?.chat?.id;
        if (chatId) await send(chatId, `⚠️ Error: ${err.message?.slice(0, 100) || "unknown"}. Try /clear.`);
      } catch {}
    }
  })());
}
