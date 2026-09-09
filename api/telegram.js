import { waitUntil } from "@vercel/functions";
import { createClient } from "@supabase/supabase-js";
import { ETSY_CATEGORIES, categoryByValue, sectionIdForCategory, inferCategoryValue } from "../lib/listingCategories.js";
import { publishEtsy } from "./listing-manager.js";
import { publishEbayListing } from "./ebay.js";

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
    listings: "ng-listings-v1",
    albums:   `${p}-tg-listing-albums-v1`,
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
async function tgFileUrl(fileId, token = null) {
  const tok = token || _ctx.token;
  try {
    const r = await tg("getFile", { file_id: fileId }, tok);
    const path = r?.result?.file_path;
    return path ? `https://api.telegram.org/file/bot${tok}/${path}` : null;
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
async function send(chatId, text, token = null) {
  if (!text?.trim()) return;
  // Strip any raw <tag> that isn't an allowed HTML tag (prevent parse errors)
  const safe = text.replace(/<(?!\/?(?:b|i|u|s|code|pre|a|blockquote)[\s>\/])[^>]*>/gi, "");
  for (let i = 0; i < safe.length; i += 4000) {
    await tg("sendMessage", { chat_id: chatId, text: safe.slice(i, i + 4000), parse_mode: "HTML" }, token || _ctx.token);
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
async function logActivity(entry, ctx = null) {
  try {
    const key = (ctx || _ctx).activity;
    const curr = (await loadK(key)) || [];
    await saveK(key, [{ id: uid(), ts: new Date().toISOString(), ...entry }, ...curr].slice(0, 500));
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
      name: "create_listing",
      description: "Create a DRAFT product listing in the Listing Manager (Etsy / Shopify hub). Use when Nikhil describes a piece he wants listed for sale — 'list an amethyst sphere 60mm at $45'. This saves a draft in the ERP only; it never publishes to a live shop. Photos cannot be attached this way — tell him to send the photos to this chat with a caption starting /list.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Buyer-facing product title" },
          material: { type: "string", description: "The stone, e.g. Amethyst, Labradorite" },
          category: { type: "string", description: "One of: metaphysical, rocks_geodes, spheres, hearts, palmstones, towers, tumbled, bowls, bracelets, pendants, pendulums, rough, carvings, collector. Guessed from the title if omitted." },
          description: { type: "string", description: "Product description — 2-3 short paragraphs" },
          tags: { type: "array", items: { type: "string" }, description: "Up to 13 lowercase search tags, each under 20 characters" },
          price_usd: { type: "number", description: "Price in USD (Shopify Earth Editions / eBay). The other currency is converted if only one is given." },
          price_inr: { type: "number", description: "Price in INR (Etsy / Atyahara)" },
          qty: { type: "number", description: "Quantity available. Default 1." },
          size: { type: "string", description: "e.g. 60mm" },
          weight: { type: "string", description: "e.g. 320 g" },
          origin: { type: "string", description: "Country or locality — only if stated" },
          sku: { type: "string" },
          box: { type: "string", description: "Box / storage location" }
        },
        required: ["title"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_listings",
      description: "Get listings from the Listing Manager — what is drafted, what is already live on Etsy/Shopify, and their prices.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search title, material, SKU or listing number" },
          drafts_only: { type: "boolean", description: "Only listings not published anywhere yet" },
          limit: { type: "number", description: "Default 10, max 50" }
        }
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

function parseTelegramFlatCaption(caption = "") {
  const raw = String(caption || "").replace(/\s+/g, " ").trim();
  const weightMatch = raw.match(/(\d+(?:\.\d+)?)\s*(kg|kgs|g|gm|gms|gram|grams)\b/i);
  const pcsMatch = raw.match(/(\d+)\s*(?:pcs?|pieces?|nos?\.?|units?)\b/i);
  const boxMatch = raw.match(/(?:box|stk|stock|location)\s*#?\s*([a-z0-9-]+)|#\s*([a-z0-9-]+)/i);
  const weight = weightMatch ? `${weightMatch[1]} ${weightMatch[2].toLowerCase()}` : "";
  const pcs = pcsMatch ? pcsMatch[1] : "";
  const box = boxMatch ? (boxMatch[1] || boxMatch[2] || "") : "";
  const stoneName = raw
    .replace(/(?:box|stk|stock|location)\s*#?\s*[a-z0-9-]+/ig, "")
    .replace(/#\s*[a-z0-9-]+/g, "")
    .replace(/\d+(?:\.\d+)?\s*(?:kg|kgs|g|gm|gms|gram|grams)\b/ig, "")
    .replace(/\d+\s*(?:pcs?|pieces?|nos?\.?|units?)\b/ig, "")
    .replace(/\bmineral\b/ig, "")
    .replace(/[,:|]+/g, " ")
    .replace(/\s+-\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim() || "Flat stone";
  const titleTail = [weight, pcs && `${pcs} pcs`, box && `#${box}`].filter(Boolean).join(" ");
  return { raw, stoneName, weight, pcs, box, title: `${stoneName} Mineral${titleTail ? ` - ${titleTail}` : ""}` };
}

function weightToGrams(weight) {
  const m = String(weight || "").match(/([\d.]+)\s*(kg|kgs|g|gm|gms|gram|grams)\b/i);
  if (!m) return "";
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return "";
  const grams = /kg/i.test(m[2]) ? n * 1000 : n;
  return String(Math.round(grams * 1000) / 1000);
}

// A Telegram video of a flat is an Earth Editions ERP draft. The price stays blank
// so the user can fill it in Listing Manager before publishing to Shopify. The local
// copy is deleted only after Shopify reports READY and returns a CDN source URL.
async function createTelegramVideoListing(caption = "") {
  const listings = (await loadK(_ctx.listings)) || [];
  const stock = (await loadK(_ctx.stock)) || [];
  const id = uid();
  const media = await storePendingFile(`listing-${id}`);
  if (!media) return { success: false, error: "I could not download the Telegram video. Please resend it." };

  const parsed = parseTelegramFlatCaption(caption);
  const title = parsed.title;
  const listingOrderId = `NG-LST-${new Date().getFullYear()}-${id.slice(-6).toUpperCase()}`;
  const stockId = `telegram-stock-${id}`;
  const stockItem = {
    id: stockId,
    material: parsed.stoneName,
    shape: "Mineral",
    origin: "",
    size: "",
    grade: "",
    hsn: "7103",
    qty: parsed.pcs || "1",
    unit: "pcs",
    qty2: "",
    unit2: "kg",
    weightGm: weightToGrams(parsed.weight),
    costPrice: "",
    listPrice: "",
    location: parsed.box,
    boxNumber: parsed.box,
    market: [],
    productType: "Lapidary",
    photographed: false,
    postedShopify: true,
    postedShopifyEarth: true,
    postedShopifyAtyahara: false,
    postedWix: false,
    postedEtsy: false,
    postedEbay: false,
    photo: "",
    photos: [],
    video: media.url,
    notes: parsed.raw || "Flat video uploaded from Telegram",
    addedDate: todayStr(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: "telegram-video",
    sku: "",
    vendor: "",
    files: [],
    linked_listing_id: id,
  };
  const listing = {
    id,
    listing_order_id: listingOrderId,
    title,
    description: parsed.raw || "Video flat uploaded from Telegram. Add product details and price in Listing Manager.",
    material: parsed.stoneName.replace(/\s+mineral$/i, "").trim(),
    shape: "Mineral",
    origin: "",
    size: "",
    weight: parsed.weight,
    sku: "",
    productType: "Lapidary",
    type: "unique",
    qty: parsed.pcs || 1,
    unit: "pcs",
    boxNumber: parsed.box,
    linked_stock_id: stockId,
    officeLocation: "",
    tags: ["deal", "flat"],
    images: [],
    video: media.url,
    price_etsy: "",
    price_shopify_earth: "",
    price_shopify_aty: "",
    price_ebay: "",
    platforms: {
      etsy: {},
      shopify_earth: { status: "draft", source: "telegram-video" },
      shopify_aty: {},
      ebay: {},
    },
    variations: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    source: "telegram-video",
    videoFileName: media.name,
    originalVideoUrl: media.url,
    sourceVideoUrl: media.url,
    retainVideo: false,
    videoStoragePolicy: "delete_after_shopify_ready",
    shopifyPricePending: true,
  };
  await saveK(_ctx.stock, [stockItem, ...stock]);
  await saveK(_ctx.listings, [listing, ...listings]);
  await logActivity({ user: "Telegram", action: "created", module: "listing", label: `Video flat listing: ${title}`, targetId: id, targetMod: "listing" });
  return { success: true, listing_id: id, stock_id: stockId, listing_order_id: listingOrderId, title, video_url: media.url, platform: "Earth Editions", price_pending: true };
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
      create_listing: execCreateListing, get_listings: execGetListings,
    };
    if (!map[name]) return { error: `Unknown tool: ${name}` };
    return await map[name](args);
  } catch (e) {
    return { error: e.message };
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   LISTING BOT — photos in Telegram become Listing Manager drafts
   ─────────────────────────────────────────────────────────────────────────
   Nothing here ever touches a live shop. A post from Telegram lands in the
   shared ERP (`ng-listings-v1`) as a draft with its photos, AI-written copy
   and whatever price the caption carried; pricing checks and the actual
   publish stay in Listing Manager, where the platform toggles live.
══════════════════════════════════════════════════════════════════════════ */

const sleep = ms => new Promise(r => setTimeout(r, ms));

// A Telegram album arrives as one webhook per photo, all within a second or two.
// The first photo (lowest message_id) leads: it waits for its siblings to file
// themselves, then writes the single listing they all belong to.
const ALBUM_SETTLE_MS = 5000;
const ALBUM_LEADER_GRACE_MS = 2500;
const ALBUM_TTL_MS = 2 * 60 * 60 * 1000;

// INR per USD for the second price when a caption only gives one currency. The
// reply always says the rate it used, so a stale number is visible, not silent.
const LISTING_USD_INR = Number(process.env.LISTING_USD_INR || 84);

/* Atomic single-item write into a JSON-array key. Album rows land from several
   concurrent webhooks at once, so a read-modify-write here would lose photos —
   the RPC takes a row lock and merges server-side. Falls back to a whole-array
   save only if the migration hasn't been applied to this project. */
async function upsertItemK(key, item, { prepend = true } = {}) {
  if (!item?.id) throw new Error("upsertItemK requires item.id");
  const { data, error } = await sb().rpc("app_data_upsert_item", { p_key: key, p_item: item, p_prepend: prepend });
  if (!error) return Array.isArray(data) ? data : null;
  const curr = (await loadK(key)) || [];
  const idx = curr.findIndex(r => r?.id === item.id);
  const next = idx >= 0 ? curr.map((r, i) => (i === idx ? item : r)) : (prepend ? [item, ...curr] : [...curr, item]);
  await saveK(key, next);
  return next;
}

/* Album photos can land on one warm instance at the same moment, so the listing
   path uploads through its own local state rather than the request-scoped
   _pendingFile slot the assistant path shares. */
async function uploadTelegramMedia({ fileId, name, mime }, targetId, ctx) {
  const fileUrl = await tgFileUrl(fileId, ctx.token);
  if (!fileUrl) return null;
  try {
    const resp = await fetch(fileUrl);
    if (!resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    const client = sb();
    await client.storage.createBucket("ng-media", { public: true }).catch(() => {});
    const ext = (String(name).split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
    const path = `telegram/${targetId}-${Date.now()}.${ext}`;
    const { error } = await client.storage.from("ng-media").upload(path, buf, { contentType: mime || "application/octet-stream", upsert: true });
    if (error) return null;
    return { id: uid(), url: client.storage.from("ng-media").getPublicUrl(path).data.publicUrl, name, type: mime, uploadedAt: new Date().toISOString() };
  } catch { return null; }
}

/* ── Caption directives ──────────────────────────────────────────────────── */
// "/list amethyst sphere 60mm $45 box A12 #crystal" → structured hints.
const LISTING_CMD_RE = /^\/(list|listing)(@\w+)?\b[\s:,-]*/i;
const LISTING_WORD_RE = /^(listing|list this|post this|list it|post|list)\b[\s:,-]+/i;

const isListingCaption = caption => {
  const c = String(caption || "").trim();
  return LISTING_CMD_RE.test(c) || LISTING_WORD_RE.test(c);
};

/* Media captioned with a one-line product note ("amethyst sphere 60mm $45") is
   a listing. A caption about money or about the stock room is not — those keep
   going to the assistant, which logs payments and stock notes. Media with no
   caption at all is left alone too, since that is what a forwarded screenshot
   looks like. */
const NOT_A_LISTING_RE = /\b(paid|pay|paying|payment|received|receive|receipt|remit|remittance|transfer|deposit|withdraw|salary|rent|refund|due|outstanding|balance|bill|invoice|expense|upi|neft|rtgs|add to stock|inventory|stock note|stock list|godown)\b/i;
const looksLikeListingCaption = caption => {
  const c = String(caption || "").trim();
  return c.length > 2 && !NOT_A_LISTING_RE.test(c);
};

function parseListingCaption(caption = "") {
  const raw = String(caption || "").replace(/\s+/g, " ").trim();
  let text = raw.replace(LISTING_CMD_RE, "").replace(LISTING_WORD_RE, "").trim();

  const take = re => {
    const m = text.match(re);
    if (!m) return null;
    text = text.replace(m[0], " ");
    return m;
  };

  // "ebay" routes the post; it must not survive into the product name.
  const ebay = /\be-?bay\b/i.test(text);
  text = text.replace(/\b(?:also\s+|and\s+|\+\s*)?(?:post\s+|list\s+|put\s+)?(?:on\s+|to\s+)?e-?bay\b/ig, " ");

  const tags = [];
  for (const m of text.matchAll(/#([a-z][a-z0-9 _-]{1,19})(?=$|[,.;|]|\s#)/gi)) tags.push(m[1].trim());
  text = text.replace(/#[a-z][a-z0-9 _-]{1,19}(?=$|[,.;|]|\s#)/gi, " ");

  /* A price is written either way round — "$45" and "650 usd" are both how a
     dealer types it — so both orders are read. \b on the currency words so
     "colours 3" or "hindustan 4" can't read as a price. */
  const takeAmount = patterns => { for (const re of patterns) { const m = take(re); if (m) return m; } return null; };
  const usd = takeAmount([
    /(?:us\s*\$|\$|\busd\b)\s*([\d,]+(?:\.\d+)?)/i,
    /([\d,]+(?:\.\d+)?)\s*(?:\$|\busd\b|\bdollars?\b)/i,
  ]);
  const inr = takeAmount([
    /(?:₹|\brs\.?|\binr\b)\s*([\d,]+(?:\.\d+)?)/i,
    /([\d,]+(?:\.\d+)?)\s*(?:₹|\binr\b|\brs\b|\brupees?\b|\/-)/i,
  ]);
  const box    = take(/\b(?:box|stk|stock|location|loc)\s*#?\s*([a-z0-9][a-z0-9-]*)/i);
  const sku    = take(/\bsku\s*[:#]?\s*([a-z0-9][a-z0-9/_-]*)/i);
  const origin = take(/\b(?:from|origin)\s*[:]?\s*([a-z][a-z ]{2,30}?)(?=$|[,.;|]|\s*\d)/i);
  const weight = take(/\b([\d.]+)\s*(kgs?|kilograms?|gms?|grams?|g)\b/i);
  // Bare "in" only counts glued to the number — "60 in stock" is not a size.
  const size   = take(/\b(\d+(?:\.\d+)?(?:\s*[-–]\s*\d+(?:\.\d+)?)?)\s*(mm|cm|inch(?:es)?|")/i)
              || take(/\b(\d+(?:\.\d+)?)(in)\b/i);
  const qty    = take(/\b(?:qty\s*[:=]?\s*|x\s*)(\d{1,4})\b(?!\s*(?:mm|cm|g|kg|inch))/i)
              || take(/\b(\d{1,4})\s*(?:pcs?|pieces?|nos?\.?|units?)\b/i);

  const num = m => (m ? Number(String(m[1]).replace(/,/g, "")) : null);
  const leftover = text.replace(/[,:|]+/g, " ").replace(/\s+/g, " ").trim();

  return {
    raw,
    text: leftover,
    tags,
    ebay,
    priceUsd: num(usd),
    priceInr: num(inr),
    qty: num(qty),
    box: box ? box[1] : "",
    sku: sku ? sku[1] : "",
    origin: origin ? origin[1].trim() : "",
    weight: weight ? `${weight[1]} ${weight[2].toLowerCase().replace(/s$/, "")}` : "",
    size: size ? formatSize(size[1], size[2]) : "",
  };
}

// "60mm" reads better closed up; "12 inch" needs the space.
function formatSize(value, unit) {
  const u = String(unit).toLowerCase().replace(/^(in|inches)$/, "inch").replace(/^"$/, "inch");
  return `${String(value).replace(/\s+/g, "")}${u === "mm" || u === "cm" ? "" : " "}${u}`;
}

const cleanListingTags = (list = []) => {
  const out = [];
  for (const t of list) {
    const tag = String(t || "").toLowerCase().replace(/[^a-z0-9 &'-]/g, "").replace(/\s+/g, " ").trim();
    if (!tag || tag.length > 20 || out.includes(tag)) continue;
    out.push(tag);
    if (out.length === 13) break;   // Etsy's hard cap
  }
  return out;
};

/* ── AI draft ────────────────────────────────────────────────────────────── */
// Vision over the photos plus whatever the caption said. Best-effort: a failure
// downgrades the draft to caption-only copy rather than losing the post.
/* The parts of a listing the shop writes the same way every time. Read off 400
   live listings: the "About Atyāhāra" paragraph appears verbatim on 137 of them,
   the lighting note on 61. Reproduced here rather than left to the model, which
   would paraphrase them a little differently every time and drift the shop's
   own words out from under it. */
const ATYAHARA_ABOUT = "Atyāhāra embodies a unique approach to luxury, rooted in mindful sourcing and a deep respect for Mother Earth. Our brand celebrates the beauty of nature’s treasures, not as a necessity, but as a cherished indulgence. Every piece is crafted with a commitment to sustainability, ensuring that the earth’s generosity is honored and preserved for future generations. By choosing Atyāhāra, you are embracing a journey where elegance meets responsibility, and together, we can make a difference.";
const PHOTO_NOTE = "Photographs were taken in both studio and natural lighting to show the stone as accurately as possible. Please message us for any questions.";
/* Everything posted from the phone is a piece that has already travelled: it
   sits in the USA warehouse, which is only opened when the shop is in the
   country for Denver and Tucson. A buyer needs to know that before they order,
   not after, so it goes on every listing the bot writes. */
const USA_WAREHOUSE_NOTE = "Please note: this piece is held in our USA warehouse, which we are only able to access in September, January and February, when we travel over for the Denver and Tucson gem shows. Orders are packed and dispatched during those visits, so kindly plan your purchase accordingly.";
// One of a kind versus one of several — the shop says which, and says it first.
const EXACT_LINE = "You will receive the EXACT piece shown in the photographs.";
const SIMILAR_LINE = "You will receive a very SIMILAR piece. Please message us after purchasing to see available pieces.";

/* The shop's own live Etsy titles and tags, so the model writes in the voice the
   shop already sells in rather than a generic one. Read off the listings as they
   stand; worth refreshing if the house style moves. */
const HOUSE_STYLE_EXAMPLES = [
  { t: "Cavansite with Pentagonite on Matrix — Wagholi, India",
    g: "indian cavansite, blue mineral, pentagonite crystal, rare indian mineral, crystal specimen, collectors minerals, cavansite specimen" },
  { t: "40–45mm | Bloodstone Fancy Jasper (Heliotrope) Sphere - Deep Green with Red Flecking",
    g: "bloodstone sphere, heliotrope sphere, desk crystal orb, handheld crystal, indian bloodstone, red fleck gemstone, altar decor stone" },
  { t: "Rhodolite Garnet Palmstones: Polished Deep Pink Crystal Stone",
    g: "rhodolite palm stone, garnet palm crystal, raspberry red stone, burgundy worry stone, crystal palm stone, garnet reiki stone" },
  { t: "Smoky Quartz Faceted Pendulum Pendant | Gold-Tone Setting | Grounding & Emotional Detox",
    g: "smoky quartz, pendulum necklace, grounding crystal, metaphysical gift, boho gift for her, meditation necklace" },
  { t: "3 Inch Rose Quartz & Green Aventurine Elephants - Hand Carved - Pastel Duo",
    g: "aventurine elephants, pastel stone decor, 3 inch figurines, feng shui elephant, elephant gift idea, boho crystal decor" },
  { t: "Polished Ruby Corundum Hexagon Crystal: South Indian Healing Stone",
    g: "natural ruby hexagon, raw ruby crystal, indian ruby crystal, ruby healing stone, collectible ruby gem, ruby collector stone" },
].map(e => `• ${e.t}\n  tags: ${e.g}`).join("\n");

/* The call that writes the copy is worth insisting on: everything else about a
   listing survives a bad moment on the network, but this one failing turns the
   seller's shorthand into the shop's title. */
const LISTING_AI_ATTEMPTS = 4;
const LISTING_AI_TIMEOUT_MS = 60000;
// The API's way of saying it could not fetch a photo, not that the call was bad.
const LISTING_AI_IMAGE_FAIL_RE = /invalid_image|image_url|timeout while downloading|downloading the image|unsupported image|failed to (?:download|fetch) image/i;

async function aiListingDraft({ caption, imageUrls = [], hints = {} }) {
  if (!process.env.OPENAI_KEY) return null;
  const model = process.env.TELEGRAM_LISTING_MODEL || process.env.TELEGRAM_OPENAI_MODEL || "gpt-4.1-mini";
  const promptFor = photos => `You write Etsy listings for Nikhil Gems / Earth Editions, a crystal
and mineral shop. Match the shop's own titles and tags — here are real ones:

${HOUSE_STYLE_EXAMPLES}

Measured across 400 live listings: titles run 55-100 characters (median 69),
separated by ":" most often, then "-", "|" or "–"; one in four leads with the
size or weight. Every listing carries 13 tags, two or three words each, under
20 characters, nearly always lowercase.

House rules for the title, read off those:
- Name the stone properly. What the seller types is shorthand for a mineral,
  not the title: "cavansite wagholi" is a Cavansite specimen from Wagholi, and
  the shop calls that "Cavansite with Pentagonite on Matrix — Wagholi, India".
- Shape it as: [size or weight, if worth leading with] Stone + Form, then a
  separator (: | - —) and a short phrase that earns the search — colour, the
  locality, what it does, or who it is for.
- Title Case. 45-95 characters. No ALL CAPS, no emoji, no price, no SKU, no box
  number, and never the seller's shorthand verbatim.

Tags, read off those: 13 of them, lowercase, two or three words each, under 20
characters. Cover the stone and its common variants and misspellings, the form,
the colour, the locality, the use (altar, reiki, desk, collector), and a gift
angle. No hashtags, no duplicates of one another.

${photos.length ? `The ${photos.length} photo(s) below are the product.` : "There are no photos — work from the note alone."}
Seller's note (facts, not the title): ${caption ? `"${caption}"` : "(none)"}
Known already: ${JSON.stringify({ size: hints.size || "", weight: hints.weight || "", origin: hints.origin || "", qty: hints.qty || "" })}

The seller's note always wins on the facts — the stone, the locality, the size —
over what you think you see. Never invent an origin, a size or a weight that is
neither stated nor plainly visible: leave it "".

A place named in the note is the origin, and the shop writes it out in full —
"wagholi" is "Wagholi, Maharashtra, India", "jalgaon" is "Jalgaon Quarries,
Maharashtra, India". Naming the state and country of a locality the seller gave
is not inventing one; a locality nobody mentioned is.

The description is assembled around you: the shop's opening line, your paragraph,
a spec block, then the shop's "About Atyāhāra". Write the paragraph only — one
of them, 45-90 words, in this voice:

  "This Ruby in Rhyolite sphere is a natural ruby-bearing rhyolite featuring a
  striking central magenta-pink ruby crystal surrounded by creamy white and grey
  rhyolitic matrix. Additional ruby fragments appear throughout the stone,
  creating a distinctive scattered pattern, while the polished spherical surface
  enhances the contrast, lustre, and natural mineral textures. Ideal for display
  on a desk, shelf, or as a handheld piece."

Open with "This <stone> <form> is a…", describe what is actually in the photo —
colour, matrix, habit, lustre — and close on where it is at home. British
spelling (lustre, colour). No hype, no "stunning", no emoji, no claims about
healing powers, no price.

Return ONLY JSON:
{
  "title": "the Etsy title, in the house style above",
  "material": "the stone, e.g. Amethyst, Clear Quartz, Labradorite",
  "category": "one of: ${ETSY_CATEGORIES.map(c => c.value).join(", ")}",
  "body": "the one descriptive paragraph, in the voice above",
  "finish": "e.g. Polished, Natural, Hand carved, Tumbled — what the surface is",
  "pantone": "the shop quotes Pantone on most listings: 1-3 codes with names, e.g. \"19-2430 TCX Magenta + 11-4300 TCX Blanc de Blanc\", read off the photo. \"\" if there are no photos",
  "dimensions": "e.g. 64 x 45 x 23mm or 43mm diameter — only if stated or measurable from the note, else \"\"",
  "tags": ["exactly 13 lowercase search tags", "two or three words each, under 20 characters"],
  "size": "e.g. 60mm — only if stated or clearly visible, else \\"\\"",
  "weight": "e.g. 320 g — only if stated, else \\"\\"",
  "origin": "country or locality — only if stated, else \\"\\"",
  "notes_for_seller": "one short line on anything you were unsure about, else \\"\\""
}`;

  const callOnce = async photos => {
    const content = [{ type: "text", text: promptFor(photos) },
      ...photos.map(url => ({ type: "image_url", image_url: { url } }))];

    /* A read that hangs would otherwise sit here until the whole webhook dies,
       taking the Etsy draft with it. Cut it loose and let the loop try again. */
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), LISTING_AI_TIMEOUT_MS);
    let r;
    try {
      r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        signal: abort.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_KEY}` },
        body: JSON.stringify({
          model, max_tokens: 900, temperature: 0.3,
          response_format: { type: "json_object" },
          messages: [{ role: "user", content }],
        }),
      });
    } finally { clearTimeout(timer); }

    if (!r.ok) {
      const detail = (await r.text()).slice(0, 400);
      const err = new Error(`Listing AI ${r.status}: ${detail.slice(0, 160)}`);
      err.status = r.status;
      err.retryAfterMs = Math.round((Number(r.headers.get("retry-after")) || 0) * 1000);
      err.imageProblem = LISTING_AI_IMAGE_FAIL_RE.test(detail);
      err.outOfQuota = /insufficient_quota|exceeded your current quota|billing/i.test(detail);
      throw err;
    }
    const data = await r.json();
    const text = data.choices?.[0]?.message?.content || "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Listing AI returned no JSON");
    return JSON.parse(match[0]);
  };

  /* Two stones posted one after the other are two four-photo vision calls
     seconds apart, which is exactly when this API answers 429 — and the listing
     that loses the call falls back to the caption as its title while its
     neighbour reads properly. So the call is given real attempts: backing off
     far enough to clear a rate limit, waiting as long as the API asks when it
     says, and retrying a dropped or timed-out connection too, not only a status
     code. If the complaint is about the photos themselves, one attempt is made
     on the seller's note alone — copy written blind still beats no copy. */
  let photos = imageUrls.slice(0, 4);
  let blind = false;
  for (let attempt = 0; ; attempt++) {
    try {
      return await callOnce(photos);
    } catch (e) {
      if (e?.imageProblem && photos.length && !blind) {
        console.error("Listing AI could not read the photos, retrying on the note alone:", e.message);
        photos = [];
        blind = true;
        continue;
      }
      /* A spent quota also answers 429, but no amount of waiting clears it —
         retrying it only delays telling the seller what is actually wrong. */
      const retryable = (!e?.status || e.status === 429 || e.status >= 500) && !e?.outOfQuota;
      if (!retryable || attempt >= LISTING_AI_ATTEMPTS - 1) throw e;
      const backoff = Math.min(Math.max(e?.retryAfterMs || 0, 2000 * 2 ** attempt), 20000);
      console.error(`Listing AI attempt ${attempt + 1} failed (${e.message}), retrying in ${backoff}ms`);
      await sleep(backoff + Math.floor(Math.random() * 400));
    }
  }
}


/* ── Is the copywriter answering? ───────────────────────────────────────── */
/* A failed listing now says why in the reply, but that is after the stone is
   posted. This asks the API the two questions that separate the faults: does
   the key and model work at all, and can it reach the photos we hand it. A dead
   key, a model name that no longer exists, a spent quota and a storage bucket
   the API cannot read all look identical from the phone otherwise. */
async function aiHealthReport(ctx) {
  if (!process.env.OPENAI_KEY) {
    return "<b>Listing AI check</b>\n\n❌ No OPENAI_KEY is set, so every listing takes its title straight off your caption. Add the key in the Vercel project settings and redeploy.";
  }
  const model = process.env.TELEGRAM_LISTING_MODEL || process.env.TELEGRAM_OPENAI_MODEL || "gpt-4.1-mini";
  const lines = ["<b>Listing AI check</b>", `Model: <code>${esc(model)}</code>`];

  const probe = async content => {
    const started = Date.now();
    try {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_KEY}` },
        body: JSON.stringify({ model, max_tokens: 5, messages: [{ role: "user", content }] }),
      });
      const ms = Date.now() - started;
      if (r.ok) return { ok: true, ms };
      let detail = (await r.text()).slice(0, 500);
      try { detail = JSON.parse(detail)?.error?.message || detail; } catch {}
      return { ok: false, ms, status: r.status, detail: detail.slice(0, 200) };
    } catch (e) {
      return { ok: false, ms: Date.now() - started, detail: e.message };
    }
  };

  const key = await probe([{ type: "text", text: "Reply with the word ok." }]);
  lines.push(key.ok
    ? `✅ Key and model answer (${key.ms} ms)`
    : `❌ Key/model: ${esc(String(key.status || "no reply"))} — ${esc(key.detail || "")}`);

  const url = ((await loadK(ctx.listings)) || []).map(l => l?.images?.[0]).find(Boolean);
  if (!url) {
    lines.push("No listing photo saved yet, so the photo half is untested.");
  } else {
    /* Two separate things can be wrong with a photo: our own storage may not be
       serving it, or it may be serving it only to us. Both are checked. */
    try {
      const head = await fetch(url, { method: "GET" });
      lines.push(head.ok
        ? `✅ Photo is public (${head.status}, ${esc(head.headers.get("content-type") || "?")})`
        : `❌ Photo is not readable: ${head.status} — the ng-media bucket may not be public.`);
    } catch (e) { lines.push(`❌ Photo fetch failed: ${esc(e.message)}`); }

    const vision = await probe([{ type: "text", text: "Reply with the word ok." }, { type: "image_url", image_url: { url } }]);
    lines.push(vision.ok
      ? `✅ The model can read our photos (${vision.ms} ms)`
      : `❌ Photo read: ${esc(String(vision.status || "no reply"))} — ${esc(vision.detail || "")}`);
  }

  if (lines.every(l => !l.startsWith("❌"))) {
    lines.push("", "All good — a failure now would be a passing one, and the listing reply says which.");
  }
  return lines.join("\n");
}

/* ── Draft assembly ──────────────────────────────────────────────────────── */
function buildListingDraft({ parsed, ai, images = [], video = "", source = "telegram-photo" }) {
  const id = uid();
  const category = categoryByValue(ai?.category) || categoryByValue(inferCategoryValue(`${parsed.text} ${ai?.title || ""}`));
  /* The seller's line is shorthand for a mineral — "cavansite wagholi" — and a
     buyer searching Etsy is not typing that. The AI writes the title in the
     shop's own style and the line stays on the record as what was said; if the
     AI is unreachable the line is the name, which is better than nothing. */
  const title = (ai?.title || "").trim() || parsed.text || "Untitled listing";

  const priceUsd = parsed.priceUsd ?? (parsed.priceInr ? Math.round((parsed.priceInr / LISTING_USD_INR) * 100) / 100 : null);
  const priceInr = parsed.priceInr ?? (parsed.priceUsd ? Math.round(parsed.priceUsd * LISTING_USD_INR) : null);
  const money = v => (v == null ? "" : String(v));

  /* The description is built the way the shop builds it — what you will receive,
     the piece itself, the spec block in its own order, then the shop's own
     paragraph about itself. Only the middle is written for this stone; the rest
     is the shop's, word for word. */
  const size = parsed.size || ai?.size || "";
  const weight = parsed.weight || ai?.weight || "";
  const dims = (ai?.dimensions || "").trim();
  const specs = [
    ["Material", (ai?.material || "").trim()],
    ["Finish", (ai?.finish || "").trim()],
    ["Origin", parsed.origin || ai?.origin || ""],
    // The shop writes these on one line when it has both, and separately when not.
    ...(weight && (dims || size)
      ? [["Weight / Dimensions", `${weight} / ${dims || size}`]]
      : [["Weight", weight], ["Dimensions", dims || size]]),
    ["Pantone Color", (ai?.pantone || "").trim()],
  ].filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join("\n");

  const body = (ai?.body || ai?.description || "").trim();
  const description = [
    (parsed.qty > 1 ? SIMILAR_LINE : EXACT_LINE),
    body || title,
    specs,
    images.length ? PHOTO_NOTE : "",
    USA_WAREHOUSE_NOTE,
    `About Atyāhāra:\n${ATYAHARA_ABOUT}`,
  ].filter(Boolean).join("\n\n");

  const listing = {
    id,
    listing_order_id: `NG-LST-${new Date().getFullYear()}-${id.slice(-6).toUpperCase()}`,
    title: title.slice(0, 140),
    description,
    material: (ai?.material || "").trim(),
    shape: category.shape,
    origin: parsed.origin || ai?.origin || "",
    size: parsed.size || ai?.size || "",
    weight: parsed.weight || ai?.weight || "",
    sku: parsed.sku || "",
    productType: category.productType,
    // More than one of the same piece is a stocked line, not a one-off — Shopify
    // and Etsy both publish quantity 1 for a "unique" listing.
    type: parsed.qty > 1 ? "repeatable" : "unique",
    qty: parsed.qty || 1,
    linked_stock_id: "",
    officeLocation: "",
    boxNumber: parsed.box || "",
    tags: cleanListingTags([...(parsed.tags || []), ...(ai?.tags || [])]),
    images: images.map(i => i.url).filter(Boolean),
    video,
    videoEdit: null,
    price_etsy: money(priceInr),
    // Etsy bills in INR here; the USD figure only picks the shipping profile,
    // so pass the real one rather than letting it be back-converted.
    price_etsy_usd: money(priceUsd),
    price_shopify_earth: money(priceUsd),
    price_shopify_aty: money(priceInr),
    price_ebay: money(priceUsd),
    /* Posted from the phone means the piece is already in the USA warehouse, so
       the Etsy draft is marked as slow to dispatch and takes the longest
       processing window the shop has rather than promising tomorrow. Point
       TELEGRAM_ETSY_SHIPPING_PROFILE_ID at a US warehouse profile once one
       exists and every bot listing will use it. */
    etsy_slow_dispatch: true,
    // The shop keeps this stock in its own section, and asks for it by name so a
    // renumbered section cannot quietly file a stone somewhere else.
    etsy_section_name: process.env.TELEGRAM_ETSY_SECTION || "Local USA Warehouse",
    etsy_shipping_profile_id: process.env.TELEGRAM_ETSY_SHIPPING_PROFILE_ID
      ? Number(process.env.TELEGRAM_ETSY_SHIPPING_PROFILE_ID) : null,
    platforms: { etsy: {}, shopify_earth: {}, shopify_aty: {}, ebay: {} },
    width: "", height: "", depth: "", dim_unit: "mm",
    variations: [],
    etsy_section_id: sectionIdForCategory(category.value),
    etsy_taxonomy_id: category.taxonomyId,
    etsy_return_policy_id: null,
    etsy_made_to_order: false,
    etsy_readiness_state_id: null,
    etsy_auto_renew: false,
    etsy_ads: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    source,
    telegram_caption: parsed.raw,
    pricePending: priceUsd == null && priceInr == null,
  };

  return { listing, category, priceUsd, priceInr, converted: parsed.priceUsd == null || parsed.priceInr == null };
}

async function saveListingDraft(listing, ctx) {
  await upsertItemK(ctx.listings, listing);
  await logActivity({
    user: "Telegram", action: "created", module: "listing",
    label: `Listing draft: ${listing.title}`, targetId: listing.id, targetMod: "listing",
  }, ctx);
  return listing;
}

function mediaSummary(listing) {
  const photos = listing.images.length;
  return [photos ? `${photos} photo${photos > 1 ? "s" : ""}` : "", listing.video ? "video" : ""].filter(Boolean).join(" + ") || "no media";
}

function listingReply({ listing, category, priceUsd, priceInr, converted, aiFailed, aiNote, tail = "" }) {
  const price = priceUsd == null && priceInr == null
    ? ""
    : `${priceUsd != null ? `$${priceUsd}` : ""}${priceUsd != null && priceInr != null ? " · " : ""}${priceInr != null ? fmtMoney(priceInr) : ""}${converted ? ` (second price converted at ${LISTING_USD_INR}/USD)` : ""}`;
  return [
    `✓ Saved — <b>${esc(listing.title)}</b>`,
    [listing.material, category.label, mediaSummary(listing)].filter(Boolean).map(esc).join(" · "),
    esc(price),
    listing.tags.length ? `Tags: ${esc(listing.tags.join(", "))}` : "",
    `<code>${esc(listing.listing_order_id)}</code>`,
    aiFailed ? `⚠️ AI copy failed (${esc(String(aiFailed).slice(0, 120))}), so the title is straight off your caption — worth a look. Send the photos again to have another go.` : "",
    aiNote ? `Note: ${esc(aiNote)}` : "",
    tail,
  ].filter(Boolean).join("\n");
}

/* ── Publishing ──────────────────────────────────────────────────────────── */
// Every post gets an Etsy draft (a draft is private — it is not on sale until
// it is activated in Listing Manager or on Etsy). eBay is opt-in per post
// because eBay has no draft: AddItem puts the item live at that price.
const wantsEbay = caption => /\b(e-?bay)\b/i.test(String(caption || ""));

async function publishDraftToPlatforms(listing, { ebay }) {
  const out = {};

  if (!Number(listing.price_etsy)) {
    out.etsy = { skipped: "no price in the caption" };
  } else {
    try {
      // activate:false — created on Etsy as a draft, never put on sale from here.
      const r = await publishEtsy(listing, null, { activate: false });
      out.etsy = { ok: true, listing_id: r.listing_id, url: r.url, status: r.status,
        warning: r.fieldsWarning || r.tagsWarning || "" };
    } catch (e) {
      out.etsy = { error: e.message };
    }
  }

  if (ebay) {
    const price = Number(listing.price_ebay);
    if (!price) {
      out.ebay = { skipped: "no price in the caption" };
    } else {
      try {
        const r = await publishEbayListing({
          title: listing.title, description: listing.description, price,
          quantity: listing.type === "unique" ? 1 : Math.max(1, +listing.qty || 1),
          images: listing.images, video: listing.video || "", sku: listing.sku || listing.listing_order_id,
        });
        out.ebay = r.ok
          ? { ok: true, listing_id: r.itemId, url: r.url || `https://www.ebay.com/itm/${r.itemId}`, warning: r.videoWarning || "" }
          : { error: r.error };
      } catch (e) {
        out.ebay = { error: e.message };
      }
    }
  }
  return out;
}

// Stamp what came back onto the listing so Listing Manager shows it as published
// there and re-syncs to the same item instead of creating a second one.
function withPlatformResults(listing, results) {
  const platforms = { ...listing.platforms };
  const now = new Date().toISOString();
  if (results.etsy?.ok) platforms.etsy = { ...platforms.etsy, listing_id: results.etsy.listing_id, url: results.etsy.url, status: results.etsy.status || "draft", published_at: now, source: "telegram" };
  if (results.ebay?.ok) platforms.ebay = { ...platforms.ebay, listing_id: results.ebay.listing_id, url: results.ebay.url, status: "active", published_at: now, source: "telegram" };
  return { ...listing, platforms, updated_at: now };
}

function platformLines(results) {
  const line = (label, r) => {
    if (!r) return "";
    if (r.ok) return label === "Etsy"
      ? `Etsy: <a href="${esc(r.url)}">draft created</a> — private until you activate it${r.warning ? ` · ${esc(r.warning)}` : ""}`
      : `eBay: <a href="${esc(r.url)}">live now</a>${r.warning ? ` — ${esc(r.warning)}` : ""}`;
    if (r.skipped) return `${label}: skipped — ${esc(r.skipped)}`;
    return `⚠️ ${label} failed: ${esc(String(r.error).slice(0, 180))}`;
  };
  return [line("Etsy", results.etsy), line("eBay", results.ebay)].filter(Boolean);
}

/* ── Media posts ─────────────────────────────────────────────────────────── */
async function albumRows(groupId, ctx) {
  const rows = (await loadK(ctx.albums)) || [];
  return rows.filter(r => r?.groupId === groupId);
}

/* An album item that carries no caption of its own only counts as a listing
   post if a sibling filed one. Telegram delivers the five updates of an album at
   once and Vercel runs them side by side, so "already filed" is a question of
   milliseconds: the captioned sibling may still be claiming its place when this
   one asks. Polled until the album has had as long to form as the leader waits
   for it, rather than asked twice and given up on. */
async function albumJoinedListing(groupId, ctx) {
  const deadline = Date.now() + ALBUM_SETTLE_MS;
  for (;;) {
    if ((await albumRows(groupId, ctx)).length) return true;
    if (Date.now() >= deadline) return false;
    await sleep(400);
  }
}

async function pruneAlbums(ctx) {
  const rows = (await loadK(ctx.albums)) || [];
  const keep = rows.filter(r => (r?.ts || 0) >= Date.now() - ALBUM_TTL_MS);
  if (keep.length !== rows.length) await saveK(ctx.albums, keep);
}

// A photo that reached the leader too late still belongs on the listing. It is
// added in the ERP only — the Etsy draft is already made, and re-syncing it is
// a Listing Manager action.
async function appendLateMedia(listingId, media, ctx) {
  const listings = (await loadK(ctx.listings)) || [];
  const listing = listings.find(l => l?.id === listingId);
  if (!listing) return;
  if (media.kind === "video") {
    if (listing.video) return;
    await upsertItemK(ctx.listings, { ...listing, video: media.url, updated_at: new Date().toISOString() });
    return;
  }
  if ((listing.images || []).includes(media.url)) return;
  await upsertItemK(ctx.listings, { ...listing, images: [...(listing.images || []), media.url], updated_at: new Date().toISOString() });
}

async function finishMediaListing({ chatId, caption, media, ctx }) {
  const images = media.filter(m => m.kind !== "video");
  const video = media.find(m => m.kind === "video");
  const parsed = parseListingCaption(caption);
  let ai = null, aiFailed = "";
  try {
    ai = await aiListingDraft({ caption: parsed.text || parsed.raw, imageUrls: images.map(i => i.url), hints: parsed });
  } catch (e) {
    // Kept as the reason, not just a flag: a rate limit and a dead key both land
    // here and want different things doing about them.
    aiFailed = e.message || "unknown error";
    console.error("Listing AI failed:", e.message);
  }
  const draft = buildListingDraft({ parsed, ai, images, video: video?.url || "", source: video ? "telegram-media" : "telegram-photo" });
  await saveListingDraft(draft.listing, ctx);

  // Acknowledge before publishing: uploading a dozen photos to Etsy takes long
  // enough that a silent wait reads as a dropped post.
  const ebay = parsed.ebay || wantsEbay(caption);
  const priced = !!Number(draft.listing.price_etsy);
  await send(chatId, listingReply({
    ...draft, aiFailed, aiNote: ai?.notes_for_seller,
    tail: priced
      ? `⏳ Making the Etsy draft${ebay ? " — and putting it live on eBay" : ""}…`
      : "No price in the line, so it stays an ERP draft. Add one in Listing Manager and publish from there.",
  }), ctx.token);

  if (!priced && !ebay) return draft.listing;

  const results = await publishDraftToPlatforms(draft.listing, { ebay });
  const published = withPlatformResults(draft.listing, results);
  if (results.etsy?.ok || results.ebay?.ok) await upsertItemK(ctx.listings, published);
  const lines = platformLines(results);
  if (results.etsy?.ok && !draft.listing.images.length) {
    lines.push("Etsy needs at least one photo before that draft can go on sale — add one in Listing Manager.");
  }
  if (lines.length) await send(chatId, lines.join("\n"), ctx.token);
  return published;
}

async function handleMediaListing({ chatId, message, caption, file, ctx }) {
  const groupId = message.media_group_id || "";
  const messageId = Number(message.message_id) || Date.now();
  const rowId = `${groupId}:${messageId}`;

  /* Claim a place in the album before pulling the file, not after. Fetching a
     photo off Telegram and pushing it to storage takes longer than a sibling
     will wait, and a sibling that finds an empty album concludes this was never
     a listing — which is how four photos of one stone ended up described back
     one at a time by the assistant while the fifth was still uploading. */
  if (groupId) {
    await upsertItemK(ctx.albums, {
      id: rowId, groupId, messageId, chatId: String(chatId),
      caption: caption || "", kind: file.kind, ts: Date.now(), pending: true,
    }, { prepend: false });
  }

  const uploaded = await uploadTelegramMedia(file, `listing-${file.uniqueId}`, ctx);
  if (!uploaded) {
    await send(chatId, `⚠️ Could not pull that ${file.kind === "video" ? "video" : "photo"} off Telegram. Send it again?`, ctx.token);
    return;
  }
  const media = { ...uploaded, kind: file.kind };

  if (!groupId) {
    tg("sendChatAction", { chat_id: chatId, action: "typing" }, ctx.token).catch(() => {});
    await finishMediaListing({ chatId, caption, media: [media], ctx });
    return;
  }

  await upsertItemK(ctx.albums, {
    id: rowId, groupId, messageId, chatId: String(chatId),
    url: media.url, name: media.name, kind: media.kind, caption: caption || "", ts: Date.now(),
  }, { prepend: false });

  // Let the rest of the album land, then the lowest message_id writes the listing.
  await sleep(ALBUM_SETTLE_MS);
  const rows = await albumRows(groupId, ctx);
  const done = rows.find(r => r.done);
  if (done) { await appendLateMedia(done.listing_id, media, ctx); return; }

  const items = rows.filter(r => !r.done && r.url).sort((a, b) => a.messageId - b.messageId);
  if (String(items[0]?.messageId) !== String(messageId)) {
    // A sibling is writing this listing — wait for it, then add this file if it missed us.
    await sleep(ALBUM_LEADER_GRACE_MS);
    const marker = (await albumRows(groupId, ctx)).find(r => r.done);
    if (marker) await appendLateMedia(marker.listing_id, media, ctx);
    return;
  }

  tg("sendChatAction", { chat_id: chatId, action: "typing" }, ctx.token).catch(() => {});
  const albumCaption = items.map(p => p.caption).find(c => c && c.trim()) || caption;
  const listing = await finishMediaListing({
    chatId, caption: albumCaption, ctx,
    media: items.map(p => ({ url: p.url, name: p.name, kind: p.kind || "photo" })),
  });
  await upsertItemK(ctx.albums, { id: `${groupId}:done`, groupId, done: true, listing_id: listing.id, ts: Date.now() }, { prepend: false });
  await pruneAlbums(ctx);
}

/* ── Tools: listings from plain text ─────────────────────────────────────── */
async function execCreateListing(args = {}) {
  const bits = [args.title, args.material, args.size, args.weight,
    args.origin && `from ${args.origin}`, args.box && `box ${args.box}`].filter(Boolean).join(" ");
  const parsed = parseListingCaption(bits);
  parsed.raw = "";
  parsed.priceUsd = args.price_usd != null ? Number(args.price_usd) : parsed.priceUsd;
  parsed.priceInr = args.price_inr != null ? Number(args.price_inr) : parsed.priceInr;
  parsed.qty = args.qty != null ? Number(args.qty) : parsed.qty;
  parsed.sku = args.sku || parsed.sku;
  parsed.tags = Array.isArray(args.tags) ? args.tags : parsed.tags;

  const ai = {
    title: args.title,
    material: args.material || "",
    category: args.category || inferCategoryValue(`${args.title || ""} ${args.material || ""}`),
    description: args.description || "",
    tags: Array.isArray(args.tags) ? args.tags : [],
    size: args.size || "", weight: args.weight || "", origin: args.origin || "",
  };
  const draft = buildListingDraft({ parsed, ai, images: [], source: "telegram-text" });
  await saveListingDraft(draft.listing, _ctx);
  return {
    success: true,
    listing_id: draft.listing.id,
    listing_order_id: draft.listing.listing_order_id,
    title: draft.listing.title,
    category: draft.category.label,
    price_usd: draft.priceUsd, price_inr: draft.priceInr,
    price_converted: draft.converted,
    images: 0,
    published: false,
    note: "Saved as an ERP draft only — nothing is live on Etsy or Shopify. Photos and publishing are done in Listing Manager.",
  };
}

async function execGetListings({ query, limit = 10, drafts_only = false } = {}) {
  const listings = (await loadK(_ctx.listings)) || [];
  const q = String(query || "").toLowerCase().trim();
  const live = l => Object.entries(l.platforms || {})
    .filter(([, p]) => p?.listing_id || p?.product_id)
    .map(([k]) => k);
  let rows = [...listings].sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  if (q) rows = rows.filter(l => [l.title, l.material, l.sku, l.listing_order_id, l.shape].some(f => String(f || "").toLowerCase().includes(q)));
  if (drafts_only) rows = rows.filter(l => live(l).length === 0);
  return {
    count: rows.length,
    listings: rows.slice(0, Math.min(limit, 50)).map(l => ({
      id: l.id, listing_order_id: l.listing_order_id, title: l.title,
      material: l.material, shape: l.shape,
      price_usd: l.price_shopify_earth || "", price_inr: l.price_etsy || "",
      images: (l.images || []).length, source: l.source || "erp",
      created_at: l.created_at, published_on: live(l),
    })),
  };
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
- Listings: get_listings (what is drafted / live on Etsy & Shopify), create_listing (a new ERP DRAFT only — it never publishes anywhere and cannot attach photos). Photos or a video sent with a one-line "name price" caption are handled before you see them: they become a listing plus an Etsy draft, and a live eBay item if the line says eBay. So for anything with pictures, tell him to just post the pictures with that one line.
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
8a. Any photo or video that was a listing never reaches you — that path runs first. So a photo you DO see is a screenshot, a stock note, or a question about the picture, never a product to list.
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
// Publishing a post can mean an album upload to Etsy plus an eBay AddItem, all
// inside the one webhook — 60s was tight before that.
export const config = { api: { bodyParser: true }, maxDuration: 300 };

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
      const video = message.video || message.video_note || (doc && /^video\//i.test(doc.mime_type || "") ? doc : null);
      const hasVideo = !!video;
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
      if (video) _pendingFile = { fileId: video.file_id, name: video.file_name || `flat-${Date.now()}.mp4`, mime: video.mime_type || "video/mp4" };
      else if (doc) _pendingFile = { fileId: doc.file_id, name: doc.file_name || "document", mime: doc.mime_type || "application/octet-stream" };
      else if (hasPhoto) _pendingFile = { fileId: message.photo[message.photo.length - 1].file_id, name: `payment-${Date.now()}.jpg`, mime: "image/jpeg" };
      const text = (message.text || caption || (
        video ? "[video attached]"
        : doc ? `[file attached: ${doc.file_name || "document"}]`
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

      // Commands. Normalised first: "/Help@GemBot " and "/listmodeon" are the
      // same commands as "/help" and "/listmode on".
      const cmd = text.trim().toLowerCase().replace(/@[a-z0-9_]+/gi, "");

      if (cmd === "/start" || cmd === "/help") {
        // Keep the bot's command menu in step with what it actually answers, so
        // these get typed from the menu rather than from memory.
        tg("setMyCommands", { commands: [
          { command: "list",     description: "List a product — send photos with a name and price" },
          { command: "listmode", description: "on / off — every photo becomes a listing" },
          { command: "listings", description: "Recent listings and where they are live" },
          { command: "memory",   description: "Facts the bot has saved" },
          { command: "aicheck",  description: "Is the listing copywriter answering?" },
          { command: "clear",    description: "Reset the conversation" },
          { command: "help",     description: "What this bot can do" },
        ] }, _ctx.token).catch(() => {});
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
          `<b>Listings</b> — send photos or a video with one line: the name and the price.`,
          `<code>Amethyst sphere 60mm $45</code>`,
          `→ Listing Manager listing + an <b>Etsy draft</b>. Nothing is on sale.`,
          `Say <b>ebay</b> in the line and it also goes <b>live on eBay</b> at that price.`,
          `Several photos sent as one album all land on one listing.`,
          `Price as <code>$45</code> or <code>₹3800</code> — the other is converted.`,
          `Extras if you want them: <code>60mm 320g x3 box A12 from Brazil #tag</code>`,
          `No price in the line → it stays an ERP draft, nothing is sent to Etsy.`,
          `A caption about money or stock is still a payment/stock note, not a listing.`,
          ``,
          `/listmode on — every photo becomes a listing (no caption needed)`,
          `/listmode off — back to normal`,
          `/listings — the last few, and where they are live`,
          `/clear — reset conversation`,
          `/memory — show saved facts`,
          `/aicheck — why the listing copy failed, if it did`,
        ].join("\n"));
        return;
      }

      if (cmd === "/aicheck" || cmd === "/aitest") {
        await saveSession(chatId, { ...session, lastUpdateId: updateId });
        tg("sendChatAction", { chat_id: chatId, action: "typing" }, _ctx.token).catch(() => {});
        await send(chatId, await aiHealthReport(_ctx));
        return;
      }

      if (cmd === "/clear") {
        await clearSession(chatId);
        await send(chatId, "Cleared.");
        return;
      }

      if (cmd === "/memory") {
        await saveSession(chatId, { ...session, lastUpdateId: updateId });
        const facts = await getMemory();
        if (!facts.length) { await send(chatId, "Nothing saved yet."); return; }
        await send(chatId, `<b>Memory (${facts.length} facts)</b>\n\n` + facts.map(f => `• <b>${f.key}</b>: ${f.value}`).join("\n"));
        return;
      }

      // Listing mode — for a photo session where captioning every shot is a chore.
      const listMode = cmd.match(/^\/list\s*mode\s*(on|off|start|stop|yes|no)?\b/);
      if (listMode) {
        const arg = listMode[1] || "";
        const on = /^(on|start|yes)$/.test(arg) ? true : /^(off|stop|no)$/.test(arg) ? false : !session.listingMode;
        await saveSession(chatId, { ...session, lastUpdateId: updateId, listingMode: on });
        await send(chatId, on
          ? "Listing mode <b>on</b> — every photo you send becomes a listing, caption or not. A line with the price still gets it onto Etsy as a draft. <code>/listmode off</code> when you're done."
          : "Listing mode <b>off</b>. Photos are read as screenshots again; a photo with a name-and-price line is still a listing.", _ctx.token);
        return;
      }

      if (/^\/listings\b/.test(cmd)) {
        await saveSession(chatId, { ...session, lastUpdateId: updateId });
        const { listings } = await execGetListings({ limit: 8 });
        if (!listings.length) { await send(chatId, "No listings yet. Send photos with one line — the name and the price."); return; }
        await send(chatId, `<b>Latest listings</b>\n\n` + listings.map(l => [
          `• <b>${esc(l.title)}</b>`,
          [l.price_usd && `$${l.price_usd}`, l.price_inr && fmtMoney(l.price_inr), `${l.images} photo${l.images === 1 ? "" : "s"}`,
            l.published_on.length ? `live: ${l.published_on.join(", ")}` : "draft"].filter(Boolean).map(esc).join(" · "),
        ].join("\n  ")).join("\n"));
        return;
      }

      // "/list amethyst sphere 60mm $45" with no photo — same draft, no images.
      if (!hasPhoto && !doc && !hasVideo && isListingCaption(text)) {
        await saveSession(chatId, { ...session, lastUpdateId: updateId });
        tg("sendChatAction", { chat_id: chatId, action: "typing" }, _ctx.token).catch(() => {});
        const parsed = parseListingCaption(text);
        if (!parsed.text) {
          await send(chatId, "Tell me what to list — <code>/list amethyst sphere 60mm $45</code> — or send photos with that caption.");
          return;
        }
        let ai = null, aiFailed = "";
        try { ai = await aiListingDraft({ caption: parsed.text, imageUrls: [], hints: parsed }); }
        catch (e) { aiFailed = e.message || "unknown error"; console.error("Listing AI failed:", e.message); }
        const draft = buildListingDraft({ parsed, ai, images: [], source: "telegram-text" });
        await saveListingDraft(draft.listing, _ctx);
        await send(chatId, listingReply({ ...draft, aiFailed, aiNote: ai?.notes_for_seller,
          tail: "ERP draft only — nothing was sent to Etsy without photos. Post the photos with the same line and it goes to Etsy as a draft." }));
        return;
      }

      // Photos posted as a listing go to the Listing Manager, not to the assistant.
      // Explicit by design: a plain photo is still a payment screenshot or a stock
      // note, so it takes a /list caption — or listing mode — to become a product.
      const imageDoc = doc && /^image\//i.test(doc.mime_type || "") ? doc : null;
      if (hasPhoto || imageDoc || hasVideo) {
        const wantsListing = isListingCaption(caption) || session.listingMode === true || looksLikeListingCaption(caption);
        const ctx = _ctx;   // pinned: the listing flow outlives this tick
        const joinsAlbum = !wantsListing && !!message.media_group_id && await albumJoinedListing(message.media_group_id, ctx);
        if (wantsListing || joinsAlbum) {
          const photo = hasPhoto ? message.photo[message.photo.length - 1] : null;
          const file = photo
            ? { fileId: photo.file_id, uniqueId: photo.file_unique_id, name: `listing-${photo.file_unique_id}.jpg`, mime: "image/jpeg", kind: "photo" }
            : imageDoc
              ? { fileId: imageDoc.file_id, uniqueId: imageDoc.file_unique_id, name: imageDoc.file_name || `listing-${imageDoc.file_unique_id}.jpg`, mime: imageDoc.mime_type || "image/jpeg", kind: "photo" }
              : { fileId: video.file_id, uniqueId: video.file_unique_id || String(message.message_id), name: video.file_name || `listing-${message.message_id}.mp4`, mime: video.mime_type || "video/mp4", kind: "video" };
          await saveSession(chatId, { ...session, lastUpdateId: updateId });
          await handleMediaListing({ chatId, message, caption, file, ctx });
          return;
        }
      }

      // Uncaptioned videos keep the old flat workflow: an Earth Editions Shopify
      // draft with a linked stock item, priced later in the ERP. A captioned
      // video is a listing and was handled above — and a video posted inside an
      // album belongs to whatever the album is, so it never takes this path on
      // its own.
      if (hasVideo && !message.media_group_id) {
        const result = await createTelegramVideoListing(caption);
        await saveSession(chatId, { ...session, lastUpdateId: updateId });
        if (!result.success) {
          await send(chatId, `⚠️ ${result.error}`);
          return;
        }
        await send(chatId, `✓ Added to Shopify ERP as a draft: <b>${esc(result.title)}</b>\nVideo retained in ERP media storage. Price is pending — open Listing Manager, add the price, fill any details, choose the Shopify store, then publish.`);
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
