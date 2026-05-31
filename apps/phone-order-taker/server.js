import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import {
  mountAppCore,
  inkressApi,
  createInkressOrder,
  getInkressOrder,
  isPaidStatus,
  orderStatusName,
} from "@inkress/apps-core";
import { openPg } from "@inkress/apps-core/pgdb";
import { sendEmail, sesConfigured } from "@inkress/apps-core/ses";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
for (const k of ["OAUTH_CLIENT_ID", "OAUTH_CLIENT_SECRET", "INKRESS_API_BASE"]) {
  if (!process.env[k]) { console.error(`[phone-order-taker] Missing env: ${k}`); process.exit(1); }
}

// Postgres (shared cluster, own schema). Orders live here as drafts until the
// operator closes out; issuing a link/payment creates a real Inkress order and
// we mirror its payment state. See docs/specs/phone-order-taker.md.
const db = await openPg("phone_order_taker", `
  CREATE TABLE IF NOT EXISTS orders (
    id            BIGSERIAL PRIMARY KEY,
    merchant_id   BIGINT NOT NULL,
    ref           TEXT NOT NULL UNIQUE,
    customer_name TEXT NOT NULL,
    customer_email TEXT,
    customer_phone TEXT,
    items         JSONB NOT NULL DEFAULT '[]',
    subtotal      NUMERIC NOT NULL DEFAULT 0,
    currency      TEXT NOT NULL DEFAULT 'JMD',
    note          TEXT,
    mode          TEXT,
    state         TEXT NOT NULL DEFAULT 'draft',
    inkress_order_id TEXT,
    payment_url   TEXT,
    paid_at       TIMESTAMPTZ,
    created_by_id   BIGINT,
    created_by_name TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_orders_merchant_state ON orders (merchant_id, state, created_at DESC);
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount NUMERIC NOT NULL DEFAULT 0;
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_id BIGINT;

  CREATE TABLE IF NOT EXISTS settings (
    merchant_id BIGINT PRIMARY KEY,
    data        JSONB NOT NULL DEFAULT '{}',
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`);

const app = express();
const core = mountAppCore(app, {
  clientId: process.env.OAUTH_CLIENT_ID,
  clientSecret: process.env.OAUTH_CLIENT_SECRET,
  apiBaseUrl: process.env.INKRESS_API_BASE,
  frameAncestors: process.env.FRAME_ANCESTORS,
  staticDir: path.join(__dirname, "dist"),
});

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const toMoney = (n) => round2(n);

function serialize(row) {
  return {
    id: row.id,
    ref: row.ref,
    customer: { name: row.customer_name, email: row.customer_email, phone: row.customer_phone },
    items: row.items || [],
    subtotal: Number(row.subtotal),
    discount: Number(row.discount || 0),
    total: round2(Number(row.subtotal) - Number(row.discount || 0)),
    customer_id: row.customer_id || null,
    currency: row.currency,
    note: row.note,
    mode: row.mode,
    state: row.state,
    inkress_order_id: row.inkress_order_id,
    payment_url: row.payment_url,
    paid_at: row.paid_at,
    created_by: row.created_by_name ? { id: row.created_by_id, name: row.created_by_name } : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function cleanItems(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((i) => ({
      product_id: Number(i.product_id ?? i.id) || null,
      title: String(i.title || "Item").slice(0, 200),
      price: round2(i.price),
      qty: Math.max(1, Math.floor(Number(i.qty) || 1)),
      note: i.note ? String(i.note).slice(0, 300) : null,
    }))
    .filter((i) => i.title);
}
const itemsSubtotal = (items) => round2(items.reduce((s, i) => s + i.price * i.qty, 0));

function splitName(name) {
  const parts = String(name || "").trim().split(/\s+/);
  return { first_name: parts[0] || "Customer", last_name: parts.slice(1).join(" ") || "" };
}

async function getSettings(merchantId) {
  const row = await db.one(`SELECT data FROM settings WHERE merchant_id=$1`, [merchantId]);
  return row?.data || {};
}

// ---- Live product catalogue (operator picks from these) --------------------
app.get("/api/products", core.requireSession, async (req, res) => {
  const q = String(req.query.q || "").trim();
  try {
    const r = await inkressApi(core.cfg, req.session.accessToken,
      `products?limit=50&order=id desc${q ? `&q=${encodeURIComponent(q)}` : ""}`);
    const entries = r?.result?.entries || [];
    const products = entries.map((p) => {
      const cur = p.currency || {};
      const raw = Number(p.price ?? p.unit_price ?? 0);
      // Inkress stores prices in minor units only for FLOAT currencies (USD…).
      // Zero-decimal currencies like JMD (is_float:false) are already whole.
      const price = cur.is_float === true ? raw / 100 : raw;
      return {
        id: p.id, title: p.title || p.name || `Product ${p.id}`,
        price,
        currency: cur.code || p.currency_code || req.session.data?.merchant?.currency_code || "JMD",
        image: p.image || p.image_url || p.images?.[0]?.url || null,
        sku: p.sku || p.barcode || null,
        unlimited: !!p.unlimited,
        units_remaining: p.unlimited ? null : (p.units_remaining != null ? Number(p.units_remaining) : null),
      };
    });
    res.json({ products });
  } catch (err) {
    res.status(502).json({ error: "products_failed", message: err?.message });
  }
});

// Customer autocomplete — search the merchant's Inkress customers (native Users).
app.get("/api/customers", core.requireSession, async (req, res) => {
  const q = String(req.query.q || "").trim();
  try {
    const r = await inkressApi(core.cfg, req.session.accessToken,
      `users?limit=20${q ? `&q=${encodeURIComponent(q)}` : ""}`);
    const entries = r?.result?.entries || r?.result || [];
    const customers = (Array.isArray(entries) ? entries : []).map((u) => ({
      id: u.id,
      name: u.full_name || [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email || `Customer ${u.id}`,
      email: u.email || null,
      phone: u.phone || u.phone_number || null,
    }));
    res.json({ customers });
  } catch (err) {
    res.status(502).json({ error: "customers_failed", message: err?.message });
  }
});

// ---- Orders list + stats ---------------------------------------------------
app.get("/api/orders", core.requireSession, async (req, res) => {
  const mid = req.session.merchantId;
  const state = String(req.query.state || "").trim();

  // Optional reconciliation: refresh awaiting orders against Inkress (auth'd).
  if (req.query.refresh === "1") {
    const awaiting = await db.q(
      `SELECT * FROM orders WHERE merchant_id=$1 AND state='awaiting' AND inkress_order_id IS NOT NULL LIMIT 25`, [mid]);
    for (const o of awaiting) {
      try {
        const ink = await getInkressOrder(core.cfg, req.session.accessToken, o.inkress_order_id);
        if (ink && isPaidStatus(ink)) {
          await db.run(`UPDATE orders SET state='paid', paid_at=now(), updated_at=now() WHERE id=$1`, [o.id]);
        }
      } catch { /* leave as awaiting */ }
    }
  }

  const rows = state
    ? await db.q(`SELECT * FROM orders WHERE merchant_id=$1 AND state=$2 ORDER BY created_at DESC LIMIT 200`, [mid, state])
    : await db.q(`SELECT * FROM orders WHERE merchant_id=$1 ORDER BY created_at DESC LIMIT 200`, [mid]);

  const all = await db.q(`SELECT state, subtotal, discount, paid_at FROM orders WHERE merchant_id=$1`, [mid]);
  const todayStr = new Date().toISOString().slice(0, 10);
  const chargeable = (o) => round2(Number(o.subtotal) - Number(o.discount || 0));
  const stats = {
    drafts: all.filter((o) => o.state === "draft").length,
    awaiting: all.filter((o) => o.state === "awaiting").length,
    awaiting_value: round2(all.filter((o) => o.state === "awaiting").reduce((s, o) => s + chargeable(o), 0)),
    paid_today: all.filter((o) => o.state === "paid" && String(o.paid_at || "").slice(0, 10) === todayStr).length,
    paid_today_value: round2(all.filter((o) => o.state === "paid" && String(o.paid_at || "").slice(0, 10) === todayStr).reduce((s, o) => s + chargeable(o), 0)),
  };
  res.json({ orders: rows.map(serialize), stats });
});

app.get("/api/orders/:id", core.requireSession, async (req, res) => {
  const row = await db.one(`SELECT * FROM orders WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  if (!row) return res.status(404).json({ error: "not_found" });
  res.json({ order: serialize(row) });
});

// ---- Create / edit a draft -------------------------------------------------
app.post("/api/orders", core.requireSession, async (req, res) => {
  const b = req.body || {};
  const name = String(b.customer?.name || b.customer || "").trim();
  const items = cleanItems(b.items);
  if (!name) return res.status(400).json({ error: "no_customer", message: "Enter a customer name." });
  if (!items.length) return res.status(400).json({ error: "empty_cart", message: "Add at least one item." });
  const subtotal = itemsSubtotal(items);
  const currency = String(b.currency || req.session.data?.merchant?.currency_code || "JMD");
  const ref = `pot-${req.session.merchantId}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
  const row = await db.one(
    `INSERT INTO orders (merchant_id, ref, customer_name, customer_email, customer_phone, customer_id, items, subtotal, discount, currency, note, created_by_id, created_by_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [req.session.merchantId, ref, name, b.customer?.email || null, b.customer?.phone || null, b.customer?.id || null,
     JSON.stringify(items), subtotal, Math.max(0, Math.min(subtotal, round2(b.discount))), currency, b.note || null, req.actor?.id || null, req.actor?.name || null]);
  res.status(201).json({ order: serialize(row) });
});

app.patch("/api/orders/:id", core.requireSession, async (req, res) => {
  const row = await db.one(`SELECT * FROM orders WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  if (!row) return res.status(404).json({ error: "not_found" });
  if (row.state !== "draft") return res.status(409).json({ error: "not_draft", message: "Only draft orders can be edited." });
  const b = req.body || {};
  const items = b.items !== undefined ? cleanItems(b.items) : row.items;
  if (b.items !== undefined && !items.length) return res.status(400).json({ error: "empty_cart", message: "Add at least one item." });
  const subtotal = itemsSubtotal(items);
  const updated = await db.one(
    `UPDATE orders SET customer_name=$1, customer_email=$2, customer_phone=$3, items=$4, subtotal=$5, note=$6, updated_at=now()
     WHERE id=$7 RETURNING *`,
    [String(b.customer?.name || row.customer_name).trim(), b.customer?.email ?? row.customer_email,
     b.customer?.phone ?? row.customer_phone, JSON.stringify(items), subtotal, b.note ?? row.note, row.id]);
  res.json({ order: serialize(updated) });
});

app.delete("/api/orders/:id", core.requireSession, async (req, res) => {
  const r = await db.run(`DELETE FROM orders WHERE id=$1 AND merchant_id=$2 AND state IN ('draft','cancelled')`, [req.params.id, req.session.merchantId]);
  if (!r.rowCount) {
    // Don't delete live/paid orders — cancel the draft state instead.
    await db.run(`UPDATE orders SET state='cancelled', updated_at=now() WHERE id=$1 AND merchant_id=$2 AND state='awaiting'`, [req.params.id, req.session.merchantId]);
  }
  res.json({ ok: true });
});

// ---- Close-out: issue link / take payment now / record cash ----------------
app.post("/api/orders/:id/issue", core.requireSession, async (req, res) => {
  const mode = ["link", "now", "cash"].includes(req.body?.mode) ? req.body.mode : "link";
  const row = await db.one(`SELECT * FROM orders WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  if (!row) return res.status(404).json({ error: "not_found" });
  if (row.state === "paid") return res.status(409).json({ error: "already_paid" });

  const items = row.items || [];
  if (!items.length) return res.status(400).json({ error: "empty_cart" });
  const { first_name, last_name } = splitName(row.customer_name);
  const email = row.customer_email || `pot+${row.ref}@bookerva.com`;
  if (mode === "link" && !row.customer_email) {
    return res.status(400).json({ error: "no_email", message: "Add the customer's email to send a payment link." });
  }

  let inkressOrderId = row.inkress_order_id;
  let paymentUrl = row.payment_url;

  // Create the Inkress order once (idempotent on our ref). Re-issuing reuses it.
  if (!inkressOrderId) {
    try {
      // Native order_lines: pass `products: [{id, quantity}]` so Inkress builds
      // real frozen line items (title/price snapshotted server-side) — visible
      // on the order in the Inkress dashboard, not just our own DB. Requires
      // every cart item to reference a catalog product_id; if any line is ad-hoc
      // (no product_id) we fall back to a total-only order so an unresolvable
      // product can never trigger the "invalid currency" rejection.
      // Send native order_lines only when the line totals match the charge
      // total (i.e. no order-level discount) — otherwise Inkress would see a
      // lines-vs-total mismatch. Discounted orders fall back to the discounted
      // total (itemisation still lives in meta_data.items + our own DB).
      const lineProducts = items.length && items.every((i) => i.product_id) && !(Number(row.discount) > 0)
        ? items.map((i) => ({ id: i.product_id, quantity: i.qty }))
        : null;
      const itemSummary = items.map((i) => `${i.qty}× ${i.title}`).join(", ").slice(0, 120);
      const created = await createInkressOrder(core.cfg, req.session.accessToken, {
        referenceId: row.ref,
        total: toMoney(round2(row.subtotal - (row.discount || 0))),
        currencyCode: row.currency,
        title: `Phone order — ${row.customer_name}`.slice(0, 180),
        kind: "online",
        customer: { ...(row.customer_id ? { id: Number(row.customer_id) } : {}), email, first_name, last_name, phone: row.customer_phone || undefined },
        ...(lineProducts ? { products: lineProducts } : {}),
        metaData: { source: "phone-order-taker", payment_method: mode === "cash" ? "cash" : "online", taken_by: req.actor?.name || "", note: row.note || "", items: itemSummary },
      });
      inkressOrderId = created.id != null ? String(created.id) : null;
      paymentUrl = created.payment_url || created.short_link || null;
    } catch (err) {
      return res.status(502).json({ error: "inkress_failed", message: err?.message || "Couldn't create the Inkress order." });
    }
  }

  let emailed = false;
  let emailError = null;
  if (mode === "link" && paymentUrl && row.customer_email) {
    const merchant = req.session.data?.merchant?.name || "the merchant";
    try {
      await sendEmail({
        to: row.customer_email,
        subject: `Your payment link from ${merchant}`,
        html: paymentLinkHtml({ merchant, name: first_name, total: toMoney(round2(row.subtotal - (row.discount || 0))), currency: row.currency, items, url: paymentUrl }),
      });
      emailed = true;
    } catch (err) { emailError = err?.message || "email_failed"; }
  }

  // Cash is recorded as settled immediately (operator asserts cash received);
  // the Inkress order remains for the record. Otherwise → awaiting payment.
  const newState = mode === "cash" ? "paid" : "awaiting";
  const updated = await db.one(
    `UPDATE orders SET mode=$1, state=$2, inkress_order_id=$3, payment_url=$4, paid_at=$5, updated_at=now() WHERE id=$6 RETURNING *`,
    [mode, newState, inkressOrderId, paymentUrl, mode === "cash" ? new Date().toISOString() : row.paid_at, row.id]);

  const settings = await getSettings(req.session.merchantId);
  const wa = waText({ merchant: req.session.data?.merchant?.name, total: toMoney(round2(row.subtotal - (row.discount || 0))), currency: row.currency, url: paymentUrl });
  res.json({
    order: serialize(updated),
    payment_url: paymentUrl,
    frame_url: paymentUrl,
    whatsapp: settings.whatsapp ? `https://wa.me/${String(settings.whatsapp).replace(/\D/g, "")}?text=${encodeURIComponent(wa)}` : null,
    whatsapp_text: wa,
    emailed, email_error: emailError, ses_configured: sesConfigured(),
  });
});

// Manual single-order reconciliation.
app.post("/api/orders/:id/poll", core.requireSession, async (req, res) => {
  const row = await db.one(`SELECT * FROM orders WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  if (!row) return res.status(404).json({ error: "not_found" });
  if (!row.inkress_order_id) return res.json({ order: serialize(row), changed: false });
  try {
    const ink = await getInkressOrder(core.cfg, req.session.accessToken, row.inkress_order_id);
    const paid = ink && isPaidStatus(ink);
    if (paid && row.state !== "paid") {
      const u = await db.one(`UPDATE orders SET state='paid', paid_at=now(), updated_at=now() WHERE id=$1 RETURNING *`, [row.id]);
      return res.json({ order: serialize(u), changed: true, inkress_status: orderStatusName(ink) });
    }
    res.json({ order: serialize(row), changed: false, inkress_status: ink ? orderStatusName(ink) : null });
  } catch (err) {
    res.status(502).json({ error: "poll_failed", message: err?.message });
  }
});

// ---- Settings --------------------------------------------------------------
app.get("/api/settings", core.requireSession, async (req, res) => {
  res.json({ settings: await getSettings(req.session.merchantId), ses_configured: sesConfigured() });
});
app.post("/api/settings", core.requireSession, async (req, res) => {
  const b = req.body || {};
  const data = {
    whatsapp: String(b.whatsapp || "").replace(/[^\d+]/g, "").slice(0, 20),
    default_currency: String(b.default_currency || "").slice(0, 3).toUpperCase() || undefined,
  };
  await db.run(
    `INSERT INTO settings (merchant_id, data, updated_at) VALUES ($1,$2,now())
     ON CONFLICT (merchant_id) DO UPDATE SET data=$2, updated_at=now()`,
    [req.session.merchantId, JSON.stringify(data)]);
  res.json({ settings: data });
});

core.mountSpaFallback();
app.listen(PORT, HOST, () => console.log(`[phone-order-taker] listening on ${HOST}:${PORT}`));

// ---- email + whatsapp copy -------------------------------------------------
function paymentLinkHtml({ merchant, name, total, currency, items, url }) {
  const fmt = (n) => { try { return new Intl.NumberFormat("en-JM", { style: "currency", currency }).format(n); } catch { return `${currency} ${n.toFixed(2)}`; } };
  const lines = items.map((i) => `<tr><td style="padding:4px 0;">${i.qty}× ${escapeHtml(i.title)}</td><td align="right" style="padding:4px 0;">${fmt(i.price * i.qty)}</td></tr>`).join("");
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;">
    <h2 style="margin:0 0 4px;">Hi ${escapeHtml(name)},</h2>
    <p style="margin:0 0 16px;color:#555;">Here's your payment link from <b>${escapeHtml(merchant)}</b>.</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">${lines}
      <tr><td style="padding:8px 0;border-top:1px solid #eee;font-weight:600;">Total</td><td align="right" style="padding:8px 0;border-top:1px solid #eee;font-weight:600;">${fmt(total)}</td></tr></table>
    <p style="margin:20px 0;"><a href="${escapeAttr(url)}" style="display:inline-block;background:#3b5bdb;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;">Pay now</a></p>
    <p style="font-size:12px;color:#888;">Or paste this link: ${escapeHtml(url)}</p>
  </div>`;
}
function waText({ merchant, total, currency, url }) {
  const fmt = (() => { try { return new Intl.NumberFormat("en-JM", { style: "currency", currency }).format(total); } catch { return `${currency} ${total}`; } })();
  return `Hi! Here's your payment link from ${merchant || "us"} for ${fmt}: ${url || ""}`;
}
function escapeHtml(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function escapeAttr(s) { return escapeHtml(s).replace(/`/g, "&#96;"); }
