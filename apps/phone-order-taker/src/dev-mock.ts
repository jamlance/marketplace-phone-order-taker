/**
 * DEV-ONLY preview harness. Lets the app render at `localhost?mock` without a
 * live Inkress session, so the UI can be iterated in a browser. Guarded behind
 * `import.meta.env.DEV` in main.ts, so it is tree-shaken out of prod builds.
 */
import type { BvSession } from "./bv-init";

const PRODUCTS = [
  { id: 86, title: "Afro Fade", price: 5000, currency: "JMD", image: null, sku: "CUT-AFR", unlimited: true, units_remaining: null },
  { id: 85, title: "Beard Shaping", price: 2500, currency: "JMD", image: null, sku: "CUT-BRD", unlimited: true, units_remaining: null },
  { id: 84, title: "Line-up & Edge", price: 1800, currency: "JMD", image: null, sku: "CUT-EDG", unlimited: true, units_remaining: null },
  { id: 83, title: "Pomade (4oz)", price: 1500, currency: "JMD", image: null, sku: "RET-POM", unlimited: false, units_remaining: 3 },
  { id: 82, title: "Hot Towel Shave", price: 3500, currency: "JMD", image: null, sku: "CUT-SHV", unlimited: true, units_remaining: null },
  { id: 81, title: "Beard Oil (2oz)", price: 2200, currency: "JMD", image: null, sku: "RET-OIL", unlimited: false, units_remaining: 0 },
  { id: 80, title: "Cornrows (per row)", price: 600, currency: "JMD", image: null, sku: "CUT-CRN", unlimited: true, units_remaining: null },
  { id: 79, title: "Colour Treatment", price: 8000, currency: "JMD", image: null, sku: "CUT-CLR", unlimited: false, units_remaining: 12 },
];

const CUSTOMERS = [
  { id: 501, name: "Maria Brown", email: "maria@example.com", phone: "8765550133" },
  { id: 502, name: "Devon Clarke", email: "devon@example.com", phone: "8765550199" },
  { id: 503, name: "Aaliyah Wright", email: "aaliyah@example.com", phone: "8765550121" },
  { id: 504, name: "Marcus Reid", email: "marcus@example.com", phone: "8765550177" },
];

let SEQ = 100;
const ORDERS: any[] = [
  {
    id: 3, ref: "pot-183-demo3", customer: { name: "Maria Brown", email: "maria@example.com", phone: "8765550133" },
    items: [{ product_id: 86, title: "Afro Fade", price: 5000, qty: 1, note: "low on the sides" }, { product_id: 85, title: "Beard Shaping", price: 2500, qty: 1, note: null }],
    subtotal: 7500, currency: "JMD", note: "Regular — likes it tight", mode: "link", state: "awaiting",
    inkress_order_id: "2351", payment_url: "https://pay.dev.inkress.com/abc", paid_at: null,
    created_by: { id: 90, name: "Front Desk" }, created_at: new Date(Date.now() - 36e5).toISOString(), updated_at: new Date().toISOString(),
  },
  {
    id: 2, ref: "pot-183-demo2", customer: { name: "Devon Clarke", email: null, phone: "8765550199" },
    items: [{ product_id: 82, title: "Hot Towel Shave", price: 3500, qty: 1, note: null }],
    subtotal: 3500, currency: "JMD", note: null, mode: "cash", state: "paid",
    inkress_order_id: "2352", payment_url: null, paid_at: new Date().toISOString(),
    created_by: { id: 90, name: "Front Desk" }, created_at: new Date(Date.now() - 72e5).toISOString(), updated_at: new Date().toISOString(),
  },
  {
    id: 1, ref: "pot-183-demo1", customer: { name: "Aaliyah Wright", email: "aaliyah@example.com", phone: null },
    items: [{ product_id: 79, title: "Colour Treatment", price: 8000, qty: 1, note: "ash blonde" }, { product_id: 81, title: "Wash & Style", price: 2200, qty: 1, note: null }],
    subtotal: 10200, discount: 700, total: 9500, currency: "JMD", note: "Bringing reference photo", mode: null, state: "draft",
    inkress_order_id: null, payment_url: null, paid_at: null,
    created_by: { id: 91, name: "Keisha" }, created_at: new Date(Date.now() - 9e5).toISOString(), updated_at: new Date().toISOString(),
  },
];

function stats() {
  const today = new Date().toISOString().slice(0, 10);
  return {
    drafts: ORDERS.filter((o) => o.state === "draft").length,
    awaiting: ORDERS.filter((o) => o.state === "awaiting").length,
    awaiting_value: ORDERS.filter((o) => o.state === "awaiting").reduce((s, o) => s + (o.total ?? o.subtotal), 0),
    paid_today: ORDERS.filter((o) => o.state === "paid" && String(o.paid_at).slice(0, 10) === today).length,
    paid_today_value: ORDERS.filter((o) => o.state === "paid" && String(o.paid_at).slice(0, 10) === today).reduce((s, o) => s + (o.total ?? o.subtotal), 0),
  };
}

export function installMockFetch() {
  const real = window.fetch.bind(window);
  window.fetch = async (input: any, init: any = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init.method || "GET").toUpperCase();
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const body = init.body ? JSON.parse(init.body) : {};
    const json = (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
    await new Promise((r) => setTimeout(r, 120));

    if (path.startsWith("/api/products")) {
      const q = (new URL(url, location.origin).searchParams.get("q") || "").toLowerCase();
      return json({ products: PRODUCTS.filter((p) => p.title.toLowerCase().includes(q) || (p.sku || "").toLowerCase().includes(q)) });
    }
    if (path.startsWith("/api/customers")) {
      const q = (new URL(url, location.origin).searchParams.get("q") || "").toLowerCase();
      return json({ customers: CUSTOMERS.filter((c) => c.name.toLowerCase().includes(q) || (c.email || "").toLowerCase().includes(q) || (c.phone || "").includes(q)) });
    }
    if (path.startsWith("/api/orders") && method === "GET" && !/\/orders\/\d+/.test(path)) {
      const st = new URL(url, location.origin).searchParams.get("state") || "";
      return json({ orders: st ? ORDERS.filter((o) => o.state === st) : ORDERS, stats: stats() });
    }
    const idMatch = path.match(/\/api\/orders\/(\d+)/);
    if (idMatch) {
      const id = Number(idMatch[1]);
      const o = ORDERS.find((x) => x.id === id);
      if (path.endsWith("/issue")) {
        o.mode = body.mode; o.inkress_order_id = String(2400 + id);
        o.payment_url = body.mode === "cash" ? null : "https://pay.dev.inkress.com/" + o.ref;
        o.state = body.mode === "cash" ? "paid" : "awaiting"; if (body.mode === "cash") o.paid_at = new Date().toISOString();
        return json({ order: o, payment_url: o.payment_url, whatsapp_text: "Pay here: " + o.payment_url, emailed: body.mode === "link", ses_configured: true });
      }
      if (path.endsWith("/poll")) return json({ order: o, changed: false });
      if (method === "DELETE") { const i = ORDERS.indexOf(o); if (i >= 0) ORDERS.splice(i, 1); return json({ ok: true }); }
      return json({ order: o });
    }
    if (path === "/api/orders" && method === "POST") {
      const items = (body.items || []).map((i: any) => ({ ...i, note: i.note ?? null }));
      const subtotal = items.reduce((s: number, i: any) => s + i.price * i.qty, 0);
      const discount = Math.max(0, Math.min(subtotal, Number(body.discount) || 0));
      const order = {
        id: ++SEQ, ref: "pot-183-" + SEQ, customer: body.customer, customer_id: body.customer?.id || null, items,
        subtotal, discount, total: subtotal - discount, currency: body.currency || "JMD",
        note: body.note || null, mode: null, state: "draft", inkress_order_id: null, payment_url: null, paid_at: null,
        created_by: { id: 90, name: "Front Desk" }, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      };
      ORDERS.unshift(order);
      return json({ order }, 201);
    }
    if (path === "/api/settings" && method === "GET") return json({ settings: { whatsapp: "18765550100" }, ses_configured: true });
    if (path === "/api/settings" && method === "POST") return json({ settings: body });
    return real(input, init);
  };
}

export function mockSession(): BvSession {
  return {
    inkress: { notify: ({ message }: any) => console.log("[toast]", message) } as any,
    merchant: { id: 183, username: "bookerva-jackjack", name: "Jack Jack Barbershop", currency_code: "JMD", email: "jack@example.com", logo: null },
    user: { id: 90, name: "Front Desk", email: "desk@jackjack.com" },
    scopes: ["orders:read", "orders:write", "products:read"],
  };
}
