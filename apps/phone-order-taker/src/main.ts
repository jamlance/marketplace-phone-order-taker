import "./index.css";
import {
  initBv, bvApi, makeToast, type BvToastFn,
  mountShell, statRow, dataTable, card, openModal, flash,
  fmtMoney, relTime, pill, emptyState, h, iconEl,
} from "./bv-init";

interface Product { id: number; title: string; price: number; currency: string; image?: string | null; sku?: string | null; unlimited?: boolean; units_remaining?: number | null; }
interface Line { product_id: number | null; title: string; price: number; qty: number; note?: string | null; }
interface CustomerHit { id: number; name: string; email: string | null; phone: string | null; }
interface Customer { name: string; email: string | null; phone: string | null; }
let discount = 0;
let custId: number | null = null;
interface Order {
  id: number; ref: string; customer: Customer; customer_id?: number | null; items: Line[];
  subtotal: number; discount?: number; total?: number; currency: string;
  note: string | null; mode: string | null; state: string; inkress_order_id: string | null;
  payment_url: string | null; paid_at: string | null; created_by: { id: number; name: string } | null;
  created_at: string; updated_at: string;
}
interface Stats { drafts: number; awaiting: number; awaiting_value: number; paid_today: number; paid_today_value: number; }

const root = document.getElementById("root")!;
let toast: BvToastFn;
let merchantName = "Merchant";
let currency = "JMD";

// New-order working state (persists across tab switches within the session).
let cart: Line[] = [];
let custName = "", custPhone = "", custEmail = "", note = "";
let productCache: Product[] = [];
let ordersFilter = "";

let shell: ReturnType<typeof mountShell>;

// In dev, render with mock data whenever there's no real session token
// (the real dashboard always passes ?inkress_session=…). Stripped from prod.
const MOCK = import.meta.env.DEV && !new URLSearchParams(location.search).has("inkress_session");

(async () => {
  let session;
  if (MOCK) {
    const m = await import("./dev-mock");
    m.installMockFetch();
    session = m.mockSession();
  } else {
    try { session = await initBv(); }
    catch (err: any) { root.innerHTML = ""; root.append(fatal(err?.message)); return; }
  }
  toast = makeToast(session.inkress);
  merchantName = session.merchant.name || session.merchant.username || "Merchant";
  currency = session.merchant.currency_code || "JMD";

  shell = mountShell({
    brandIcon: "phone",
    title: "Phone Order Taker",
    subtitle: `${merchantName} · take orders while they're on the line`,
    poweredBy: "Marketplace",
    tabs: [
      { id: "new", label: "New order", icon: "plus", render: renderNew },
      { id: "orders", label: "Orders", icon: "list", render: renderOrders },
      { id: "settings", label: "Settings", icon: "settings", render: renderSettings },
    ],
  });
})();

/* ------------------------------------------------------------------ New order */
function renderNew(host: HTMLElement) {
  const grid = h("div", { class: "pot-new" });

  // Left: product search + results.
  const results = h("div", { class: "pot-results" });
  const search = h("input", {
    class: "pot-search", placeholder: "Search products by name…", autocomplete: "off",
  }) as HTMLInputElement;
  let t: any;
  search.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => loadProducts(search.value, results), 220); });

  // Right: cart + customer + close-out.
  const cartBox = h("div", { class: "pot-cart" });
  const custBox = h("div");
  const totalBox = h("div", { class: "pot-total" });
  const closeBox = h("div", { class: "pot-close" });

  const repaint = () => {
    renderCart(cartBox, totalBox, repaint);
    renderCloseout(closeBox);
  };

  // Customer name with live Inkress customer autocomplete.
  const nameInput = h("input", { class: "pot-field-input", value: custName, placeholder: "e.g. Maria Brown", autocomplete: "off" }) as HTMLInputElement;
  const suggest = h("div", { class: "pot-suggest", style: { display: "none" } });
  const phoneInput = h("input", { class: "pot-field-input", value: custPhone, placeholder: "WhatsApp / mobile" }) as HTMLInputElement;
  const emailInput = h("input", { class: "pot-field-input", value: custEmail, placeholder: "name@email.com" }) as HTMLInputElement;
  const custNoteInput = h("input", { class: "pot-field-input", value: note, placeholder: "optional — delivery, special instructions" }) as HTMLInputElement;
  phoneInput.addEventListener("input", () => { custPhone = phoneInput.value; });
  emailInput.addEventListener("input", () => { custEmail = emailInput.value; custId = null; renderCloseout(closeBox); });
  custNoteInput.addEventListener("input", () => { note = custNoteInput.value; });
  const closeSuggest = () => { suggest.style.display = "none"; };
  let st: any;
  nameInput.addEventListener("input", () => {
    custName = nameInput.value; custId = null; renderCloseout(closeBox);
    clearTimeout(st); const q = nameInput.value.trim();
    if (q.length < 2) { closeSuggest(); return; }
    st = setTimeout(async () => {
      try {
        const { customers } = await bvApi<{ customers: CustomerHit[] }>(`/api/customers?q=${encodeURIComponent(q)}`);
        suggest.innerHTML = "";
        if (!customers.length) { closeSuggest(); return; }
        for (const c of customers) {
          suggest.append(h("div", { class: "pot-suggest-item", onClick: () => {
            custName = c.name; custEmail = c.email || ""; custPhone = c.phone || ""; custId = c.id;
            nameInput.value = c.name; emailInput.value = custEmail; phoneInput.value = custPhone;
            closeSuggest(); renderCloseout(closeBox);
          } }, h("strong", null, c.name), (c.email || c.phone) ? h("div", { class: "bv-muted" }, [c.email, c.phone].filter(Boolean).join(" · ")) : null));
        }
        suggest.style.display = "block";
      } catch { closeSuggest(); }
    }, 220);
  });
  nameInput.addEventListener("blur", () => setTimeout(closeSuggest, 150));
  custBox.append(
    h("label", { class: "pot-field pot-cust-name" }, h("span", { class: "pot-field-label" }, "Customer name"), nameInput, suggest),
    h("div", { class: "pot-fields" },
      h("label", { class: "pot-field" }, h("span", { class: "pot-field-label" }, "Phone"), phoneInput),
      h("label", { class: "pot-field" }, h("span", { class: "pot-field-label" }, "Email (for payment link)"), emailInput)),
    h("label", { class: "pot-field" }, h("span", { class: "pot-field-label" }, "Note"), custNoteInput),
  );

  const orderCard = card({ title: "Order", body: [cartBox, totalBox, custBox, closeBox] });
  orderCard.classList.add("pot-order-card");
  const scanBtn = h("button", { class: "ghost sm", onClick: () => { void scanProduct(); } }, iconEl("qr", 14), "Scan");
  grid.append(
    card({ title: "Products", action: scanBtn, body: [search, results] }),
    orderCard,
  );
  host.append(grid);
  loadProducts("", results);
  repaint();
}

async function loadProducts(q: string, host: HTMLElement) {
  host.innerHTML = "";
  host.append(h("div", { class: "bv-muted", style: { padding: "8px 2px" } }, "Searching…"));
  try {
    const { products } = await bvApi<{ products: Product[] }>(`/api/products${q ? `?q=${encodeURIComponent(q)}` : ""}`);
    productCache = products;
    host.innerHTML = "";
    if (!products.length) { host.append(h("div", { class: "bv-muted", style: { padding: "8px 2px" } }, "No products found.")); return; }
    for (const p of products) {
      const out = !p.unlimited && p.units_remaining != null && p.units_remaining <= 0;
      const stock = p.unlimited ? null : p.units_remaining != null ? h("span", { class: "pot-stock" + (out ? " is-out" : p.units_remaining <= 5 ? " is-low" : "") }, out ? "Out of stock" : `${p.units_remaining} left`) : null;
      host.append(h("div", { class: "pot-prod" },
        h("span", { class: "pot-prod-thumb" + (p.image ? "" : " is-empty"), style: p.image ? { backgroundImage: `url('${p.image}')` } : {} }),
        h("div", { class: "pot-prod-main" }, h("strong", null, p.title), h("div", { class: "bv-muted" }, fmtMoney(p.price, p.currency || currency), stock ? " · " : "", stock)),
        h("button", { class: "pot-add", disabled: out, onClick: () => addToCart(p) }, "Add"),
      ));
    }
  } catch (err: any) {
    host.innerHTML = "";
    host.append(h("div", { class: "bv-muted", style: { padding: "8px 2px" } }, `Couldn't load products: ${err?.message || "error"}`));
  }
}

let potScanStream: MediaStream | null = null;
async function scanProduct() {
  if (!("BarcodeDetector" in window)) { toast("This browser can't scan — search by name instead.", "warning"); return; }
  const video = h("video", { autoplay: true, playsinline: true, muted: true, class: "pot-scan-video" }) as HTMLVideoElement;
  const wrap = h("div", { class: "pot-scan" }, video, h("div", { class: "pot-scan-frame" }));
  let active = true;
  const stop = () => { active = false; if (potScanStream) { potScanStream.getTracks().forEach((t) => t.stop()); potScanStream = null; } };
  const m = openModal({ title: "Scan a product barcode", body: wrap, actions: [{ label: "Cancel", onClick: () => stop() }] });
  try {
    potScanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    video.srcObject = potScanStream;
    const detector = new (window as any).BarcodeDetector();
    const tick = async () => {
      if (!active || !potScanStream) return;
      try { const codes = await detector.detect(video); const raw = codes?.[0]?.rawValue; if (raw) { stop(); m.close(); await addByCode(String(raw).trim()); return; } } catch { /* frame not ready */ }
      requestAnimationFrame(() => { void tick(); });
    };
    requestAnimationFrame(() => { void tick(); });
  } catch { stop(); m.close(); toast("Couldn't open the camera. Check permissions.", "error"); }
}
async function addByCode(code: string) {
  try {
    const { products } = await bvApi<{ products: Product[] }>(`/api/products?q=${encodeURIComponent(code)}`);
    const p = products.find((x) => x.sku === code) || products[0];
    if (p) addToCart(p); else toast(`No product matches "${code}".`, "warning");
  } catch (err: any) { toast(err?.message || "error", "error"); }
}

function addToCart(p: Product) {
  const existing = cart.find((c) => c.product_id === p.id);
  if (existing) existing.qty += 1;
  else cart.push({ product_id: p.id, title: p.title, price: p.price, qty: 1 });
  flash(`Added ${p.title}`, "success");
  shell.select("new"); // re-render to reflect cart
}

function renderCart(host: HTMLElement, totalHost: HTMLElement, repaint: () => void) {
  host.innerHTML = ""; totalHost.innerHTML = "";
  if (!cart.length) {
    host.append(h("div", { class: "pot-cart-empty" },
      iconEl("inbox", 22),
      h("div", null, h("strong", null, "No items yet"), h("div", { class: "bv-muted" }, "Search and add products from the left.")),
    ));
    return;
  }
  for (const line of cart) {
    const noteInput = h("input", {
      class: "pot-line-note", placeholder: "Add a note for this item (e.g. low fade, no scent)…", value: line.note || "",
    }) as HTMLInputElement;
    // Bind without repaint so typing keeps focus.
    noteInput.addEventListener("input", () => { line.note = noteInput.value || null; });
    host.append(h("div", { class: "pot-line" },
      h("div", { class: "pot-line-main" },
        h("span", { class: "pot-line-title" }, line.title),
        h("span", { class: "pot-qty" },
          h("button", { class: "pot-step", onClick: () => { line.qty--; if (line.qty <= 0) cart = cart.filter((c) => c !== line); repaint(); } }, "−"),
          h("b", null, String(line.qty)),
          h("button", { class: "pot-step", onClick: () => { line.qty++; repaint(); } }, "+"),
        ),
        h("span", { class: "pot-line-amt" }, fmtMoney(line.price * line.qty, currency)),
        h("button", { class: "pot-line-x", title: "Remove item", onClick: () => { cart = cart.filter((c) => c !== line); repaint(); } }, iconEl("x", 14)),
      ),
      noteInput,
    ));
  }
  const subtotal = cart.reduce((s, c) => s + c.price * c.qty, 0);
  const count = cart.reduce((s, c) => s + c.qty, 0);
  if (discount > subtotal) discount = subtotal;
  const grand = h("b", null, fmtMoney(subtotal - discount, currency));
  const discInput = h("input", { type: "number", min: "0", step: "0.01", value: discount ? String(discount) : "", placeholder: "0.00", class: "pot-disc-input" }) as HTMLInputElement;
  discInput.addEventListener("input", () => { discount = Math.min(subtotal, Math.max(0, Number(discInput.value) || 0)); grand.textContent = fmtMoney(subtotal - discount, currency); });
  totalHost.append(
    h("div", { class: "pot-total-row" }, h("span", { class: "pot-total-label" }, `Subtotal · ${count} item${count === 1 ? "" : "s"}`), h("span", null, fmtMoney(subtotal, currency))),
    h("div", { class: "pot-total-row pot-disc-row" }, h("span", { class: "pot-total-label" }, "Discount"), discInput),
    h("div", { class: "pot-total-row pot-grand" }, h("span", null, "Total"), grand),
  );
}

function renderCloseout(host: HTMLElement) {
  host.innerHTML = "";
  const ready = cart.length > 0 && custName.trim().length > 0;
  const hint = !cart.length ? "Add at least one item to continue." : !custName.trim() ? "Enter the customer's name to continue." : null;
  if (hint) host.append(h("div", { class: "pot-close-hint" }, iconEl("alert", 14), hint));

  const linkBtn = h("button", { class: "primary pot-collect-primary", disabled: !ready || !custEmail.trim(), title: !custEmail.trim() ? "Add the customer's email to send a link" : "", onClick: () => closeOut("link") }, iconEl("send", 16), "Send payment link");
  const nowBtn = h("button", { disabled: !ready, onClick: () => closeOut("now") }, iconEl("credit-card", 15), "Take payment now");
  const cashBtn = h("button", { disabled: !ready, onClick: () => closeOut("cash") }, iconEl("cash", 15), "Cash / in person");
  const saveBtn = h("button", { class: "ghost pot-save", disabled: !ready, onClick: () => closeOut(null) }, "Save as draft");

  host.append(h("div", { class: "pot-collect" }, linkBtn, nowBtn, cashBtn), saveBtn);
}

async function closeOut(mode: "link" | "now" | "cash" | null) {
  const payload = {
    customer: { name: custName.trim(), email: custEmail.trim() || null, phone: custPhone.trim() || null, id: custId },
    items: cart, note: note.trim() || null, currency, discount: discount > 0 ? discount : 0,
  };
  try {
    const { order } = await bvApi<{ order: Order }>("/api/orders", { method: "POST", body: JSON.stringify(payload) });
    if (mode === null) {
      toast("Draft saved", "success");
      resetNew();
      shell.select("orders");
      return;
    }
    const result = await bvApi<any>(`/api/orders/${order.id}/issue`, { method: "POST", body: JSON.stringify({ mode }) });
    resetNew();
    showCloseoutResult(mode, result);
  } catch (err: any) {
    toast(err?.message || "Couldn't complete the order", "error");
  }
}

function resetNew() {
  cart = []; custName = ""; custPhone = ""; custEmail = ""; note = ""; custId = null; discount = 0;
}

function showCloseoutResult(mode: string, result: any) {
  const url: string | null = result.payment_url;
  const body = h("div");

  if (mode === "cash") {
    body.append(h("p", null, "Recorded as a cash sale. The order is in your Inkress orders for the record."));
  } else {
    body.append(h("p", null, mode === "link"
      ? (result.emailed ? `Payment link emailed to the customer.` : result.ses_configured ? `Order is awaiting payment. Email couldn't send: ${result.email_error || ""}` : `Order is awaiting payment.`)
      : "Open this on the counter device for the customer to pay now."));
    if (url) {
      const urlField = h("input", { class: "pot-search", readonly: true, value: url }) as HTMLInputElement;
      body.append(urlField,
        h("div", { class: "pot-actions", style: { marginTop: "8px" } },
          h("button", { class: "primary", onClick: () => { navigator.clipboard?.writeText(url); flash("Link copied", "success"); } }, iconEl("copy", 15), "Copy link"),
          h("a", { class: "pot-btnlink", href: url, target: "_blank", rel: "noopener" }, iconEl("external", 15), mode === "now" ? "Open checkout" : "Open"),
          result.whatsapp ? h("a", { class: "pot-btnlink", href: result.whatsapp, target: "_blank", rel: "noopener" }, "WhatsApp") : null,
        ));
    }
  }
  openModal({
    title: mode === "cash" ? "Cash sale recorded" : "Order created",
    body,
    actions: [{ label: "Done", primary: true, onClick: () => { shell.select("orders"); } }],
  });
}

/* -------------------------------------------------------------------- Orders */
async function renderOrders(host: HTMLElement) {
  host.append(h("div", { class: "bv-muted", style: { padding: "12px 2px" } }, "Loading orders…"));
  let data: { orders: Order[]; stats: Stats };
  try {
    data = await bvApi(`/api/orders?refresh=1${ordersFilter ? `&state=${ordersFilter}` : ""}`);
  } catch (err: any) {
    host.innerHTML = ""; host.append(emptyState({ icon: "alert", title: "Couldn't load orders", text: err?.message })); return;
  }
  host.innerHTML = "";
  host.append(statRow([
    { k: "Open drafts", v: String(data.stats.drafts), icon: "edit" },
    { k: "Awaiting payment", v: String(data.stats.awaiting), d: fmtMoney(data.stats.awaiting_value, currency), tone: "accent", icon: "clock" },
    { k: "Paid today", v: String(data.stats.paid_today), d: fmtMoney(data.stats.paid_today_value, currency), tone: "ok", icon: "check" },
  ]));

  const filters = h("div", { class: "pot-filters" },
    ...["", "draft", "awaiting", "paid"].map((f) =>
      h("button", { class: "pot-filter" + (ordersFilter === f ? " is-on" : ""), onClick: () => { ordersFilter = f; shell.select("orders"); } },
        f === "" ? "All" : f.charAt(0).toUpperCase() + f.slice(1))));

  const table = data.orders.length
    ? dataTable<Order>({
        columns: [
          { head: "Customer", cell: (o) => h("div", null, h("strong", null, o.customer.name), o.customer.phone ? h("div", { class: "bv-muted" }, o.customer.phone) : null) },
          { head: "Items", cell: (o) => h("span", { class: "bv-muted" }, o.items.map((i) => `${i.qty}× ${i.title}`).join(", ").slice(0, 60) || "—") },
          { head: "Total", num: true, cell: (o) => fmtMoney(o.total ?? o.subtotal, o.currency) },
          { head: "State", cell: (o) => statePill(o.state) },
          { head: "When", cell: (o) => h("span", { class: "bv-muted" }, relTime(o.created_at)) },
        ],
        rows: data.orders,
        onRowClick: (o) => openOrder(o),
      })
    : emptyState({ icon: "phone", title: "No orders yet", text: "Take your first phone order from the New order tab." });

  host.append(card({ title: "Orders", action: filters, body: table }));
}

function statePill(state: string) {
  const tone = state === "paid" ? "ok" : state === "awaiting" ? "warn" : state === "cancelled" ? "bad" : undefined;
  return pill(state, tone);
}

function openOrder(o: Order) {
  const body = h("div", { class: "pot-detail" });
  body.append(
    h("div", { class: "pot-detail-cust" },
      h("strong", null, o.customer.name),
      o.customer.email ? h("div", { class: "bv-muted" }, o.customer.email) : null,
      o.customer.phone ? h("div", { class: "bv-muted" }, o.customer.phone) : null),
    h("table", { class: "bv-table pot-detail-items" },
      h("tbody", null, ...o.items.map((i) =>
        h("tr", null,
          h("td", null,
            h("span", { class: "pot-detail-line-title" }, `${i.qty}× ${i.title}`),
            i.note ? h("div", { class: "pot-detail-line-note" }, iconEl("edit", 12), i.note) : null),
          h("td", { class: "num" }, fmtMoney(i.price * i.qty, o.currency)))),
        (o.discount && o.discount > 0
          ? h("tr", { class: "pot-detail-subtotal" }, h("td", null, "Subtotal"), h("td", { class: "num" }, fmtMoney(o.subtotal, o.currency)))
          : null),
        (o.discount && o.discount > 0
          ? h("tr", null, h("td", null, "Discount"), h("td", { class: "num" }, "−" + fmtMoney(o.discount, o.currency)))
          : null),
        h("tr", { class: o.discount && o.discount > 0 ? "" : "pot-detail-subtotal" },
          h("td", null, h("b", null, "Total")),
          h("td", { class: "num" }, h("b", null, fmtMoney(o.total ?? o.subtotal, o.currency)))))),
    h("div", { class: "pot-detail-meta" },
      h("span", null, "State: ", statePill(o.state)),
      o.inkress_order_id ? h("span", { class: "bv-muted" }, `Inkress #${o.inkress_order_id}`) : null,
      o.created_by ? h("span", { class: "bv-muted" }, `by ${o.created_by.name}`) : null),
  );
  if (o.note) body.append(h("p", { class: "bv-muted" }, o.note));
  if (o.payment_url) {
    body.append(h("div", { class: "pot-actions", style: { marginTop: "8px" } },
      h("button", { class: "ghost", onClick: () => { navigator.clipboard?.writeText(o.payment_url!); flash("Link copied", "success"); } }, "Copy link"),
      h("a", { class: "pot-btnlink", href: o.payment_url, target: "_blank", rel: "noopener" }, "Open checkout")));
  }

  const actions: { label: string; primary?: boolean; danger?: boolean; onClick?: () => void | boolean }[] = [];
  if (o.state === "draft") {
    actions.push({ label: "Send link", primary: true, onClick: () => { issueExisting(o, "link"); } });
    actions.push({ label: "Cash", onClick: () => { issueExisting(o, "cash"); } });
    actions.push({ label: "Delete", danger: true, onClick: () => { delOrder(o); } });
  } else if (o.state === "awaiting") {
    body.append(h("div", { class: "pot-await-note bv-muted" }, iconEl("clock", 14), "Awaiting payment — this updates automatically from Inkress."));
    actions.push({ label: "Cancel order", danger: true, onClick: () => { delOrder(o); } });
    actions.push({ label: "Close", onClick: () => {} });
  } else {
    actions.push({ label: "Close", onClick: () => {} });
  }
  openModal({ title: `Order — ${o.customer.name}`, body, actions });
}

async function issueExisting(o: Order, mode: "link" | "cash") {
  try {
    const result = await bvApi<any>(`/api/orders/${o.id}/issue`, { method: "POST", body: JSON.stringify({ mode }) });
    showCloseoutResult(mode, result);
  } catch (err: any) { toast(err?.message || "error", "error"); }
}
async function delOrder(o: Order) {
  try { await bvApi(`/api/orders/${o.id}`, { method: "DELETE" }); flash("Removed", "success"); shell.select("orders"); }
  catch (err: any) { toast(err?.message || "error", "error"); }
}

/* ------------------------------------------------------------------ Settings */
async function renderSettings(host: HTMLElement) {
  let s: any = {};
  let sesOk = false;
  try { const r = await bvApi<{ settings: any; ses_configured: boolean }>("/api/settings"); s = r.settings || {}; sesOk = r.ses_configured; } catch { /* defaults */ }

  let whatsapp = s.whatsapp || "";
  const body = h("div", { class: "pot-settings" },
    field("WhatsApp number (for the \"copy message\" link)", whatsapp, (v) => (whatsapp = v), "e.g. 18761234567"),
    h("div", { class: "pot-setting-note bv-muted" },
      iconEl(sesOk ? "check" : "alert", 15),
      sesOk ? "Email sending is active (payment links email automatically)." : "Email sending isn't configured yet — links can still be copied/WhatsApped."),
    h("div", { class: "pot-actions" },
      h("button", { class: "primary", onClick: async () => {
        try { await bvApi("/api/settings", { method: "POST", body: JSON.stringify({ whatsapp }) }); flash("Settings saved", "success"); }
        catch (err: any) { toast(err?.message || "error", "error"); }
      } }, "Save settings")),
  );
  host.append(card({ title: "Settings", body }));
}

/* -------------------------------------------------------------------- helpers */
function field(label: string, value: string, onInput: (v: string) => void, placeholder = "") {
  const input = h("input", { class: "pot-field-input", value, placeholder }) as HTMLInputElement;
  input.addEventListener("input", () => onInput(input.value));
  return h("label", { class: "pot-field" }, h("span", { class: "pot-field-label" }, label), input);
}
function fatal(msg?: string) {
  return h("div", { class: "bv-empty", style: { margin: "40px auto" } },
    h("h3", null, "Phone Order Taker couldn't load"),
    h("p", null, msg || "Open this app from the Inkress dashboard."));
}
