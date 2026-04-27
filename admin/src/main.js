import "./styles.css";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from "firebase/auth";
import {
  collection,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc
} from "firebase/firestore";
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";
import { auth, db, isFirebaseConfigured, storage } from "./firebase.js";
import { initialMenuItems } from "../../shared/menu.mjs";
import { DAY_LABELS, DEFAULT_BUSINESS_SETTINGS, ESTIMATE_OPTIONS } from "../../shared/business.js";

const ORDER_STATUSES = ["recibido", "preparando", "listo", "en_camino", "entregado"];
const REPORT_STATUSES = [...ORDER_STATUSES, "cancelado"];
const STATUS_LABELS = {
  recibido: "Recibido",
  preparando: "Preparando",
  listo: "Listo",
  en_camino: "En camino",
  enviado: "Enviado",
  entregado: "Entregado",
  cancelado: "Cancelado"
};

const CANCELLATION_REASONS = [
  "Pago no valido",
  "Sin stock",
  "Direccion fuera de zona",
  "Cliente cancelo",
  "Otro motivo"
];

const STAFF_ROLE_LABELS = {
  owner: "Dueno",
  cashier: "Cajero",
  kitchen: "Cocina",
  driver: "Repartidor"
};

const ROLE_VIEWS = {
  owner: ["orders", "kitchen", "delivery", "reports", "menu", "settings"],
  cashier: ["orders", "delivery"],
  kitchen: ["kitchen"],
  driver: ["delivery"]
};

const PAYMENT_STATUS_LABELS = {
  pendiente_verificacion: "Por verificar",
  verificado: "Verificado",
  rechazado: "Rechazado"
};

const state = {
  user: null,
  authError: "",
  appError: "",
  activeView: "orders",
  staffRole: "owner",
  orders: [],
  menuItems: [],
  settings: DEFAULT_BUSINESS_SETTINGS,
  editingItem: null,
  notificationsEnabled: false,
  soundEnabled: false,
  didLoadInitialOrders: false
};

const app = document.querySelector("#app");

function formatPrice(value) {
  return `S/ ${Number(value || 0).toFixed(2)}`;
}

function toDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  if (value.seconds) return new Date(value.seconds * 1000);
  return new Date(value);
}

function formatDateTime(value) {
  const date = toDate(value);
  if (!date || Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("es-PE", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(date);
}

function mergeBusinessSettings(data = {}) {
  const hoursByDay = new Map((data.hours || []).map((entry) => [Number(entry.day), entry]));
  const hours = DEFAULT_BUSINESS_SETTINGS.hours.map((entry) => ({
    ...entry,
    ...(hoursByDay.get(entry.day) || {})
  }));
  const deliveryZones = Array.isArray(data.deliveryZones) && data.deliveryZones.length
    ? data.deliveryZones.map((zone) => ({
        id: String(zone.id || zone.name || "").trim() || `zone-${Date.now()}`,
        name: String(zone.name || "Zona").trim(),
        fee: Number(zone.fee || 0),
        active: zone.active !== false
      }))
    : DEFAULT_BUSINESS_SETTINGS.deliveryZones;
  const extras = Array.isArray(data.extras) && data.extras.length
    ? data.extras.map((extra) => ({
        id: String(extra.id || extra.name || "").trim() || `extra-${Date.now()}`,
        name: String(extra.name || "Extra").trim(),
        price: Number(extra.price || 0),
        active: extra.active !== false
      }))
    : DEFAULT_BUSINESS_SETTINGS.extras;

  return {
    ...DEFAULT_BUSINESS_SETTINGS,
    ...data,
    estimatedMinutes: Number(data.estimatedMinutes || DEFAULT_BUSINESS_SETTINGS.estimatedMinutes),
    slotIntervalMinutes: Number(data.slotIntervalMinutes || DEFAULT_BUSINESS_SETTINGS.slotIntervalMinutes),
    hours,
    deliveryZones,
    extras
  };
}

function formatFulfillment(order) {
  if (!order.fulfillment) return "Lo antes posible";
  const estimate = order.fulfillment.estimatedMinutes
    ? ` - ${order.fulfillment.estimatedMinutes} min`
    : "";
  return `${order.fulfillment.label || "Lo antes posible"}${estimate}`;
}

function playNewOrderSound() {
  if (!state.soundEnabled) return;

  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const context = new AudioContext();
    const gain = context.createGain();
    const oscillator = context.createOscillator();
    oscillator.type = "sine";
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.24, context.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.45);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.5);
  } catch (error) {
    console.warn("No se pudo reproducir sonido", error);
  }
}

function getAllowedViews() {
  return ROLE_VIEWS[state.staffRole] || ROLE_VIEWS.owner;
}

function ensureAllowedView() {
  const allowed = getAllowedViews();
  if (!allowed.includes(state.activeView)) {
    state.activeView = allowed[0] || "orders";
  }
}

function canSee(view) {
  return getAllowedViews().includes(view);
}

function renderOrderItems(order, showPrices = true) {
  const itemLines = (order.items || [])
    .map((item) => `<span>${item.quantity} x ${escapeHtml(item.name)}${showPrices ? ` - ${formatPrice(item.lineTotal)}` : ""}</span>`)
    .join("");
  const extras = (order.extras || [])
    .map((extra) => `<span>+ ${escapeHtml(extra.name)}${showPrices && Number(extra.price || 0) > 0 ? ` - ${formatPrice(extra.price)}` : ""}</span>`)
    .join("");

  return `${itemLines}${extras}`;
}

function printOrder(orderId) {
  const order = state.orders.find((entry) => entry.id === orderId);
  if (!order) return;

  const printWindow = window.open("", "_blank", "width=420,height=640");
  if (!printWindow) return;
  printWindow.document.write(`
    <html>
      <head>
        <title>Comanda ${escapeHtml(order.id)}</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 18px; }
          h1 { font-size: 22px; margin: 0 0 8px; }
          p { margin: 4px 0; }
          .line { border-top: 1px dashed #111; margin: 12px 0; padding-top: 12px; }
          .items span { display: block; font-size: 16px; margin: 6px 0; }
          .total { font-size: 20px; font-weight: 800; }
        </style>
      </head>
      <body>
        <h1>Chifa Dragon Rojo</h1>
        <p>Pedido: ${escapeHtml(order.id)}</p>
        <p>Cliente: ${escapeHtml(order.customer?.name)} - ${escapeHtml(order.customer?.phone)}</p>
        <p>${order.orderType === "delivery" ? `Delivery: ${escapeHtml(order.customer?.address)}` : "Recojo en tienda"}</p>
        <p>Entrega: ${escapeHtml(formatFulfillment(order))}</p>
        ${order.customer?.notes ? `<p>Notas: ${escapeHtml(order.customer.notes)}</p>` : ""}
        <div class="line items">${renderOrderItems(order, false)}</div>
        <p class="total">Total: ${formatPrice(order.total)}</p>
      </body>
    </html>
  `);
  printWindow.document.close();
  printWindow.focus();
  printWindow.print();
}

async function deductStockForOrder(order) {
  const updates = (order.items || []).map((item) => {
    const menuItem = state.menuItems.find((entry) => entry.id === item.id);
    if (menuItem?.trackStock !== true) return null;
    const nextStock = Math.max(Number(menuItem.stock || 0) - Number(item.quantity || 0), 0);
    return updateDoc(doc(db, "menuItems", menuItem.id), {
      stock: nextStock,
      active: nextStock > 0,
      updatedAt: serverTimestamp()
    });
  }).filter(Boolean);

  await Promise.all(updates);
}

function getBusinessDateKey(value = new Date()) {
  const date = toDate(value) || new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "America/Lima",
    year: "numeric"
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function getReports() {
  const today = getBusinessDateKey();
  const byStatus = REPORT_STATUSES.reduce((accumulator, status) => {
    accumulator[status] = 0;
    return accumulator;
  }, {});
  let todayOrders = 0;
  let todaySales = 0;
  let totalSales = 0;

  for (const order of state.orders) {
    byStatus[order.status] = (byStatus[order.status] || 0) + 1;
    if (order.status !== "cancelado") {
      totalSales += Number(order.total || 0);
    }

    if (getBusinessDateKey(order.createdAt) === today) {
      todayOrders += 1;
      if (order.status !== "cancelado") {
        todaySales += Number(order.total || 0);
      }
    }
  }

  return {
    byStatus,
    todayOrders,
    todaySales,
    totalOrders: state.orders.length,
    totalSales
  };
}

function addToBucket(map, key, amount = 0, quantity = 1) {
  const safeKey = key || "Sin dato";
  const current = map.get(safeKey) || { label: safeKey, quantity: 0, sales: 0 };
  current.quantity += Number(quantity || 0);
  current.sales += Number(amount || 0);
  map.set(safeKey, current);
}

function getAdvancedReports() {
  const validOrders = state.orders.filter((order) => order.status !== "cancelado");
  const salesByDay = new Map();
  const topDishes = new Map();
  const salesByZone = new Map();
  const coupons = new Map();
  const payments = new Map();
  const salesByHour = new Map();

  for (const order of validOrders) {
    const total = Number(order.total || 0);
    addToBucket(salesByDay, getBusinessDateKey(order.createdAt), total, 1);
    addToBucket(salesByZone, order.deliveryZone?.name || (order.orderType === "pickup" ? "Recojo" : "Sin zona"), total, 1);
    addToBucket(payments, order.payment?.methodLabel || "Sin pago", total, 1);

    const date = toDate(order.createdAt);
    const hour = date && !Number.isNaN(date.getTime())
      ? new Intl.DateTimeFormat("es-PE", {
          hour: "2-digit",
          hour12: false,
          timeZone: "America/Lima"
        }).format(date)
      : "Sin hora";
    addToBucket(salesByHour, `${hour}:00`, total, 1);

    if (order.coupon?.code) {
      addToBucket(coupons, order.coupon.code, Number(order.discount || 0), 1);
    }

    for (const item of order.items || []) {
      addToBucket(topDishes, item.name, Number(item.lineTotal || 0), Number(item.quantity || 0));
    }
  }

  const toSorted = (map, by = "sales") =>
    [...map.values()].sort((a, b) => Number(b[by] || 0) - Number(a[by] || 0));
  const byDay = [...salesByDay.values()].sort((a, b) => a.label.localeCompare(b.label)).slice(-7);

  return {
    byDay,
    topDishes: toSorted(topDishes, "quantity").slice(0, 8),
    byZone: toSorted(salesByZone).slice(0, 8),
    coupons: toSorted(coupons).slice(0, 8),
    payments: toSorted(payments).slice(0, 8),
    byHour: [...salesByHour.values()].sort((a, b) => a.label.localeCompare(b.label))
  };
}

function csvEscape(value) {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function downloadCsv(filename, rows) {
  const csv = rows.map((row) => row.map(csvEscape).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function exportOrdersCsv() {
  const rows = [[
    "id",
    "fecha",
    "estado",
    "cliente",
    "telefono",
    "tipo",
    "zona",
    "cupon",
    "pago",
    "subtotal",
    "extras",
    "delivery",
    "descuento",
    "total",
    "cancelacion"
  ]];

  for (const order of state.orders) {
    rows.push([
      order.id,
      formatDateTime(order.createdAt),
      STATUS_LABELS[order.status] || order.status,
      order.customer?.name || "",
      order.customer?.phone || "",
      order.orderType || "",
      order.deliveryZone?.name || "",
      order.coupon?.code || "",
      order.payment?.methodLabel || "",
      order.subtotal || 0,
      order.extrasTotal || 0,
      order.deliveryFee || 0,
      order.discount || 0,
      order.total || 0,
      order.cancellation?.reason || ""
    ]);
  }

  downloadCsv(`pedidos-${getBusinessDateKey()}.csv`, rows);
}

function exportSalesCsv() {
  const rows = [["fecha", "pedido", "plato", "cantidad", "venta", "zona", "metodo_pago"]];

  for (const order of state.orders.filter((entry) => entry.status !== "cancelado")) {
    for (const item of order.items || []) {
      rows.push([
        formatDateTime(order.createdAt),
        order.id,
        item.name,
        item.quantity,
        item.lineTotal,
        order.deliveryZone?.name || "",
        order.payment?.methodLabel || ""
      ]);
    }
  }

  downloadCsv(`ventas-${getBusinessDateKey()}.csv`, rows);
}

function exportMenuCsv() {
  const rows = [["id", "nombre", "categoria", "precio", "activo", "control_stock", "stock"]];

  for (const item of state.menuItems) {
    rows.push([
      item.id,
      item.name,
      item.category,
      item.price,
      item.active !== false ? "si" : "no",
      item.trackStock === true ? "si" : "no",
      item.stock ?? ""
    ]);
  }

  downloadCsv(`productos-${getBusinessDateKey()}.csv`, rows);
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function notifyBusinessNewOrder(order) {
  playNewOrderSound();

  if (!state.notificationsEnabled || !("Notification" in window)) return;

  new Notification("Nuevo pedido recibido", {
    body: `${order.customer?.name || "Cliente"} - ${formatPrice(order.total)}`,
    tag: order.id
  });
}

function enableNewOrderSound() {
  state.soundEnabled = !state.soundEnabled;
  if (state.soundEnabled) {
    playNewOrderSound();
  }
  render();
}

async function enableBusinessNotifications() {
  if (!("Notification" in window)) {
    state.appError = "Este navegador no soporta notificaciones.";
    render();
    return;
  }

  const permission = await Notification.requestPermission();
  state.notificationsEnabled = permission === "granted";
  if (!state.notificationsEnabled) {
    state.appError = "Permiso de notificaciones no concedido.";
  }
  render();
}

async function sendCustomerPush(order, status) {
  if (!order?.customerPushToken) return;

  try {
    await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        to: order.customerPushToken,
        title: "Tu pedido cambio de estado",
        body: `Estado actual: ${STATUS_LABELS[status] || status}`,
        data: {
          orderId: order.id,
          status
        }
      })
    });
  } catch (error) {
    console.warn("No se pudo enviar push al cliente", error);
  }
}

function render() {
  if (!isFirebaseConfigured) {
    app.innerHTML = `
      <section class="center-shell">
        <div class="notice">
          <h1>Firebase no esta configurado</h1>
          <p>Copia <code>.env.example</code> a <code>.env</code> y completa las claves del proyecto Firebase.</p>
        </div>
      </section>
    `;
    return;
  }

  if (!state.user) {
    renderLogin();
    return;
  }

  renderDashboard();
}

function renderLogin() {
  app.innerHTML = `
    <section class="login-shell">
      <form class="login-card" id="loginForm">
        <p class="eyebrow">Chifa Dragon Rojo</p>
        <h1>Panel admin</h1>
        <p class="muted">Ingresa con el usuario creado en Firebase Authentication.</p>
        ${state.authError ? `<div class="error">${escapeHtml(state.authError)}</div>` : ""}
        <label>
          Correo
          <input id="email" type="email" autocomplete="email" required />
        </label>
        <label>
          Contrasena
          <input id="password" type="password" autocomplete="current-password" required />
        </label>
        <button type="submit">Entrar</button>
      </form>
    </section>
  `;

  document.querySelector("#loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    state.authError = "";
    const email = document.querySelector("#email").value.trim();
    const password = document.querySelector("#password").value;

    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (error) {
      state.authError = "No se pudo iniciar sesion. Revisa el correo, contrasena y permisos de admin.";
      render();
    }
  });
}

function renderDashboard() {
  const reports = getReports();
  ensureAllowedView();

  app.innerHTML = `
    <section class="app-shell">
      <aside class="sidebar">
        <div>
          <p class="eyebrow">Chifa Dragon Rojo</p>
          <h1>Operacion</h1>
          <p class="muted">${escapeHtml(state.user.email)}</p>
          <p class="muted">Rol: ${escapeHtml(STAFF_ROLE_LABELS[state.staffRole] || state.staffRole)}</p>
        </div>
        <nav class="nav">
          ${canSee("orders") ? `<button class="${state.activeView === "orders" ? "selected" : ""}" data-view="orders">Pedidos</button>` : ""}
          ${canSee("kitchen") ? `<button class="${state.activeView === "kitchen" ? "selected" : ""}" data-view="kitchen">Cocina</button>` : ""}
          ${canSee("delivery") ? `<button class="${state.activeView === "delivery" ? "selected" : ""}" data-view="delivery">Reparto</button>` : ""}
          ${canSee("reports") ? `<button class="${state.activeView === "reports" ? "selected" : ""}" data-view="reports">Reportes</button>` : ""}
          ${canSee("menu") ? `<button class="${state.activeView === "menu" ? "selected" : ""}" data-view="menu">Carta</button>` : ""}
          ${canSee("settings") ? `<button class="${state.activeView === "settings" ? "selected" : ""}" data-view="settings">Ajustes</button>` : ""}
        </nav>
        <button class="ghost" id="notifyButton">
          ${state.notificationsEnabled ? "Notificaciones activas" : "Activar notificaciones"}
        </button>
        <button class="ghost" id="soundButton">
          ${state.soundEnabled ? "Sonido activo" : "Activar sonido"}
        </button>
        <button class="ghost" id="logoutButton">Cerrar sesion</button>
      </aside>

      <section class="workspace">
        ${state.appError ? `<div class="error">${escapeHtml(state.appError)}</div>` : ""}
        <div class="metrics">
          <article><span>Pedidos hoy</span><strong>${reports.todayOrders}</strong></article>
          <article><span>Ventas hoy</span><strong>${formatPrice(reports.todaySales)}</strong></article>
          <article><span>Historial</span><strong>${reports.totalOrders}</strong></article>
          <article><span>Ventas total</span><strong>${formatPrice(reports.totalSales)}</strong></article>
        </div>
        ${renderActiveView(reports)}
      </section>
    </section>
  `;

  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeView = button.dataset.view;
      render();
    });
  });

  document.querySelector("#logoutButton").addEventListener("click", () => signOut(auth));
  document.querySelector("#notifyButton").addEventListener("click", enableBusinessNotifications);
  document.querySelector("#soundButton").addEventListener("click", enableNewOrderSound);

  if (["orders", "kitchen", "delivery"].includes(state.activeView)) {
    bindOrderActions();
  } else if (state.activeView === "reports") {
    bindReportActions();
  } else if (state.activeView === "settings") {
    bindSettingsActions();
  } else {
    bindMenuActions();
  }
}

function bindReportActions() {
  document.querySelectorAll("[data-export]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.export === "orders") exportOrdersCsv();
      if (button.dataset.export === "sales") exportSalesCsv();
      if (button.dataset.export === "menu") exportMenuCsv();
    });
  });
}

function renderActiveView(reports) {
  if (state.activeView === "orders") return renderOrders(reports);
  if (state.activeView === "kitchen") return renderKitchen();
  if (state.activeView === "delivery") return renderDelivery();
  if (state.activeView === "reports") return renderReports();
  if (state.activeView === "settings") return renderSettings();
  return renderMenu();
}

function renderOrders(reports) {
  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Cocina</p>
          <h2>Pedidos</h2>
        </div>
      </div>
      <div class="status-grid">
        ${REPORT_STATUSES.map(
          (status) => `
            <article>
              <strong>${reports.byStatus[status] || 0}</strong>
              <span>${STATUS_LABELS[status]}</span>
            </article>
          `
        ).join("")}
      </div>
      <div class="order-list">
        ${
          state.orders.length
            ? state.orders.map(renderOrderCard).join("")
            : `<div class="empty">Todavia no hay pedidos.</div>`
        }
      </div>
    </section>
  `;
}

function renderKitchen() {
  const kitchenOrders = state.orders.filter((order) => ["recibido", "preparando"].includes(order.status));

  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Produccion</p>
          <h2>Vista cocina</h2>
        </div>
      </div>
      <div class="kitchen-grid">
        ${
          kitchenOrders.length
            ? kitchenOrders.map(renderKitchenCard).join("")
            : `<div class="empty">No hay pedidos para cocina.</div>`
        }
      </div>
    </section>
  `;
}

function renderKitchenCard(order) {
  return `
    <article class="kitchen-card">
      <div class="order-top">
        <div>
          <strong>${escapeHtml(order.customer?.name || "Cliente")}</strong>
          <span>${escapeHtml(formatFulfillment(order))}</span>
        </div>
        <mark>${STATUS_LABELS[order.status] || order.status}</mark>
      </div>
      ${order.customer?.notes ? `<p class="kitchen-note">Notas: ${escapeHtml(order.customer.notes)}</p>` : ""}
      <div class="lines kitchen-lines">${renderOrderItems(order, false)}</div>
      <div class="actions">
        <button data-order="${order.id}" data-status="preparando">Preparando</button>
        <button data-order="${order.id}" data-status="listo">Listo</button>
        <button data-print="${order.id}">Imprimir</button>
      </div>
    </article>
  `;
}

function renderDelivery() {
  const deliveryOrders = state.orders.filter(
    (order) => order.orderType === "delivery" && ["listo", "en_camino"].includes(order.status)
  );

  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Delivery</p>
          <h2>Panel repartidor</h2>
        </div>
      </div>
      <div class="order-list">
        ${
          deliveryOrders.length
            ? deliveryOrders.map(renderDeliveryCard).join("")
            : `<div class="empty">No hay pedidos listos para reparto.</div>`
        }
      </div>
    </section>
  `;
}

function renderDeliveryCard(order) {
  return `
    <article class="order-card">
      <div class="order-top">
        <div>
          <strong>${escapeHtml(order.customer?.name || "Cliente")}</strong>
          <span>${escapeHtml(order.customer?.phone || "")}</span>
        </div>
        <mark>${STATUS_LABELS[order.status] || order.status}</mark>
      </div>
      <p class="customer">${escapeHtml(order.customer?.address || "")}</p>
      <p class="muted">${escapeHtml(order.deliveryZone?.name || "")} - ${escapeHtml(formatFulfillment(order))}</p>
      <div class="lines">${renderOrderItems(order, false)}</div>
      <div class="actions">
        <button data-order="${order.id}" data-status="en_camino">En camino</button>
        <button data-order="${order.id}" data-status="entregado">Entregado</button>
        <button data-print="${order.id}">Imprimir</button>
      </div>
    </article>
  `;
}

function renderReportBars(title, rows, valueKey = "sales", valueFormatter = formatPrice) {
  const max = Math.max(...rows.map((row) => Number(row[valueKey] || 0)), 1);

  return `
    <article class="report-card">
      <h3>${escapeHtml(title)}</h3>
      <div class="bar-list">
        ${
          rows.length
            ? rows.map((row) => `
              <div class="bar-row">
                <div class="bar-meta">
                  <strong>${escapeHtml(row.label)}</strong>
                  <span>${valueFormatter(row[valueKey])}${row.quantity != null ? ` · ${row.quantity} pedidos/items` : ""}</span>
                </div>
                <div class="bar-track">
                  <div class="bar-fill" style="width:${Math.max((Number(row[valueKey] || 0) / max) * 100, 4)}%"></div>
                </div>
              </div>
            `).join("")
            : `<div class="empty mini">Sin datos todavia.</div>`
        }
      </div>
    </article>
  `;
}

function renderReports() {
  const advanced = getAdvancedReports();

  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Analitica</p>
          <h2>Reportes avanzados</h2>
        </div>
        <div class="export-actions">
          <button data-export="orders">Pedidos CSV</button>
          <button data-export="sales">Ventas CSV</button>
          <button data-export="menu">Productos CSV</button>
        </div>
      </div>
      <div class="reports-grid">
        ${renderReportBars("Ventas por dia", advanced.byDay)}
        ${renderReportBars("Platos mas vendidos", advanced.topDishes, "quantity", (value) => `${Number(value || 0)} uds`)}
        ${renderReportBars("Ventas por zona", advanced.byZone)}
        ${renderReportBars("Cupones usados", advanced.coupons, "quantity", (value) => `${Number(value || 0)} usos`)}
        ${renderReportBars("Metodos de pago", advanced.payments)}
        ${renderReportBars("Rendimiento por horario", advanced.byHour)}
      </div>
    </section>
  `;
}

function renderCancelActions(order) {
  if (["entregado", "cancelado"].includes(order.status)) return "";

  return `
    <div class="actions cancel-actions">
      ${CANCELLATION_REASONS.map(
        (reason) => `
          <button data-order="${order.id}" data-cancel="${escapeHtml(reason)}">
            Cancelar: ${escapeHtml(reason)}
          </button>
        `
      ).join("")}
    </div>
  `;
}

function renderOrderCard(order) {
  const payment = order.payment || {};
  const paymentStatus = payment.status || "pendiente_verificacion";

  return `
    <article class="order-card">
      <div class="order-top">
        <div>
          <strong>${escapeHtml(order.id)}</strong>
          <span>${formatDateTime(order.createdAt)}</span>
        </div>
        <mark>${STATUS_LABELS[order.status] || order.status}</mark>
      </div>
      <p class="customer">${escapeHtml(order.customer?.name)} - ${escapeHtml(order.customer?.phone)}</p>
      <p class="muted">${
        order.orderType === "delivery"
          ? `Delivery: ${escapeHtml(order.customer?.address)}${order.deliveryZone?.name ? ` - ${escapeHtml(order.deliveryZone.name)}` : ""}`
          : "Recojo en tienda"
      }</p>
      <p class="muted">Entrega: ${escapeHtml(formatFulfillment(order))}</p>
      ${order.customerEmail ? `<p class="muted">Cuenta: ${escapeHtml(order.customerEmail)}</p>` : ""}
      ${order.customer?.notes ? `<p class="muted">Notas: ${escapeHtml(order.customer.notes)}</p>` : ""}
      ${order.status === "cancelado" ? `<p class="cancel-note">Motivo: ${escapeHtml(order.cancellation?.reason || "Cancelado")}</p>` : ""}
      <div class="payment-strip ${paymentStatus}">
        <div>
          <strong>${escapeHtml(payment.methodLabel || "Pago")}</strong>
          <span>${escapeHtml(payment.reference || "Sin referencia")}</span>
        </div>
        <mark>${PAYMENT_STATUS_LABELS[paymentStatus] || paymentStatus}</mark>
      </div>
      <div class="lines">
        ${renderOrderItems(order, true)}
      </div>
      <div class="total compact">
        <span>Subtotal</span>
        <strong>${formatPrice(order.subtotal)}</strong>
      </div>
      ${
        Number(order.extrasTotal || 0) > 0
          ? `
            <div class="total compact">
              <span>Extras</span>
              <strong>${formatPrice(order.extrasTotal)}</strong>
            </div>
          `
          : ""
      }
      <div class="total compact">
        <span>Delivery</span>
        <strong>${formatPrice(order.deliveryFee)}</strong>
      </div>
      ${
        Number(order.discount || 0) > 0
          ? `
            <div class="total compact discount">
              <span>${escapeHtml(order.coupon?.code || "Descuento")}</span>
              <strong>- ${formatPrice(order.discount)}</strong>
            </div>
          `
          : ""
      }
      <div class="total">
        <span>Total</span>
        <strong>${formatPrice(order.total)}</strong>
      </div>
      <div class="actions">
        ${
          order.status === "cancelado"
            ? ""
            : ORDER_STATUSES.map(
                (status) => `
                  <button class="${order.status === status ? "selected" : ""}" data-order="${order.id}" data-status="${status}">
                    ${STATUS_LABELS[status]}
                  </button>
                `
              ).join("")
        }
        <button data-print="${order.id}">Imprimir</button>
      </div>
      ${renderCancelActions(order)}
      <div class="actions payment-actions">
        ${["verificado", "rechazado"].map(
          (status) => `
            <button class="${paymentStatus === status ? "selected" : ""}" data-order="${order.id}" data-payment="${status}">
              Pago ${PAYMENT_STATUS_LABELS[status]}
            </button>
          `
        ).join("")}
      </div>
      <div class="actions estimate-actions">
        ${ESTIMATE_OPTIONS.map(
          (minutes) => `
            <button class="${Number(order.fulfillment?.estimatedMinutes) === minutes ? "selected" : ""}" data-order="${order.id}" data-estimate="${minutes}">
              ${minutes} min
            </button>
          `
        ).join("")}
      </div>
    </article>
  `;
}

function renderMenu() {
  const editing = state.editingItem || {
    id: "",
    name: "",
    category: "",
    price: "",
    badge: "",
    description: "",
    imageUrl: "",
    stock: "",
    trackStock: false,
    active: true
  };

  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Carta</p>
          <h2>${editing.id ? "Editar plato" : "Nuevo plato"}</h2>
        </div>
        <button class="ghost" id="seedButton">Cargar carta inicial</button>
      </div>
      <form class="menu-form" id="menuForm">
        <input name="name" placeholder="Nombre" value="${escapeHtml(editing.name)}" required />
        <input name="category" placeholder="Categoria" value="${escapeHtml(editing.category)}" required />
        <input name="price" placeholder="Precio" type="number" step="0.01" value="${escapeHtml(editing.price)}" required />
        <input name="badge" placeholder="Etiqueta" value="${escapeHtml(editing.badge)}" />
        <input name="stock" placeholder="Stock" type="number" min="0" step="1" value="${escapeHtml(editing.stock ?? "")}" />
        <label class="file-field">
          Foto del plato
          <input name="image" type="file" accept="image/*" />
        </label>
        <textarea name="description" placeholder="Descripcion" required>${escapeHtml(editing.description)}</textarea>
        ${
          editing.imageUrl
            ? `<img class="image-preview" src="${escapeHtml(editing.imageUrl)}" alt="${escapeHtml(editing.name)}" />`
            : ""
        }
        <label class="check">
          <input name="active" type="checkbox" ${editing.active !== false ? "checked" : ""} />
          Disponible para clientes
        </label>
        <label class="check">
          <input name="trackStock" type="checkbox" ${editing.trackStock === true ? "checked" : ""} />
          Controlar stock
        </label>
        <div class="form-actions">
          <button type="submit">${editing.id ? "Guardar cambios" : "Crear plato"}</button>
          <button type="button" class="ghost" id="clearForm">Limpiar</button>
        </div>
      </form>

      <div class="menu-list">
        ${state.menuItems.map(renderMenuItem).join("")}
      </div>
    </section>
  `;
}

function renderMenuItem(item) {
  return `
    <article class="menu-row ${item.active === false ? "disabled" : ""}">
      ${
        item.imageUrl
          ? `<img class="menu-thumb" src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.name)}" />`
          : `<div class="menu-thumb placeholder">Sin foto</div>`
      }
      <div>
        <strong>${escapeHtml(item.name)}</strong>
        <span>${escapeHtml(item.category)} - ${formatPrice(item.price)}</span>
        ${item.trackStock === true ? `<span>Stock: ${Number(item.stock || 0)}</span>` : ""}
        <p>${escapeHtml(item.description)}</p>
      </div>
      <div class="row-actions">
        <button data-edit="${item.id}">Editar</button>
        <button data-toggle="${item.id}">${item.active === false ? "Activar" : "Agotar"}</button>
      </div>
    </article>
  `;
}

function renderSettings() {
  const settings = mergeBusinessSettings(state.settings);

  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Operacion</p>
          <h2>Ajustes del negocio</h2>
        </div>
      </div>
      <form class="settings-form" id="settingsForm">
        <div class="settings-grid">
          <label>
            Tiempo estimado base
            <input name="estimatedMinutes" type="number" min="5" step="5" value="${escapeHtml(settings.estimatedMinutes)}" />
          </label>
          <label>
            Intervalo de horarios
            <input name="slotIntervalMinutes" type="number" min="15" step="15" value="${escapeHtml(settings.slotIntervalMinutes)}" />
          </label>
          <label class="check setting-check">
            <input name="allowScheduledOrders" type="checkbox" ${settings.allowScheduledOrders ? "checked" : ""} />
            Aceptar pedidos programados
          </label>
        </div>

        <h3>Horario de atencion</h3>
        <div class="hours-list">
          ${settings.hours.map((entry) => `
            <div class="hours-row">
              <label class="check">
                <input name="open-${entry.day}" type="checkbox" ${entry.open ? "checked" : ""} />
                ${DAY_LABELS[entry.day]}
              </label>
              <input name="from-${entry.day}" type="time" value="${escapeHtml(entry.from)}" />
              <input name="to-${entry.day}" type="time" value="${escapeHtml(entry.to)}" />
            </div>
          `).join("")}
        </div>

        <h3>Zonas de delivery</h3>
        <div class="zones-list">
          ${settings.deliveryZones.map((zone, index) => `
            <div class="zone-row">
              <input name="zone-id-${index}" type="hidden" value="${escapeHtml(zone.id)}" />
              <label class="check">
                <input name="zone-active-${index}" type="checkbox" ${zone.active ? "checked" : ""} />
                Activa
              </label>
              <input name="zone-name-${index}" placeholder="Nombre de zona" value="${escapeHtml(zone.name)}" />
              <input name="zone-fee-${index}" type="number" min="0" step="0.5" value="${escapeHtml(zone.fee)}" />
            </div>
          `).join("")}
        </div>

        <h3>Extras e ingredientes</h3>
        <div class="zones-list">
          ${settings.extras.map((extra, index) => `
            <div class="zone-row">
              <input name="extra-id-${index}" type="hidden" value="${escapeHtml(extra.id)}" />
              <label class="check">
                <input name="extra-active-${index}" type="checkbox" ${extra.active ? "checked" : ""} />
                Activo
              </label>
              <input name="extra-name-${index}" placeholder="Nombre del extra" value="${escapeHtml(extra.name)}" />
              <input name="extra-price-${index}" type="number" min="0" step="0.5" value="${escapeHtml(extra.price)}" />
            </div>
          `).join("")}
        </div>

        <div class="form-actions">
          <button type="submit">Guardar ajustes</button>
        </div>
      </form>
    </section>
  `;
}

function bindSettingsActions() {
  document.querySelector("#settingsForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const current = mergeBusinessSettings(state.settings);
    const hours = current.hours.map((entry) => ({
      day: entry.day,
      open: form.get(`open-${entry.day}`) === "on",
      from: String(form.get(`from-${entry.day}`) || entry.from),
      to: String(form.get(`to-${entry.day}`) || entry.to)
    }));
    const deliveryZones = current.deliveryZones.map((zone, index) => ({
      id: String(form.get(`zone-id-${index}`) || zone.id),
      name: String(form.get(`zone-name-${index}`) || zone.name).trim(),
      fee: Number(form.get(`zone-fee-${index}`) || 0),
      active: form.get(`zone-active-${index}`) === "on"
    }));
    const extras = current.extras.map((extra, index) => ({
      id: String(form.get(`extra-id-${index}`) || extra.id),
      name: String(form.get(`extra-name-${index}`) || extra.name).trim(),
      price: Number(form.get(`extra-price-${index}`) || 0),
      active: form.get(`extra-active-${index}`) === "on"
    }));

    try {
      await setDoc(doc(db, "businessSettings", "public"), {
        allowScheduledOrders: form.get("allowScheduledOrders") === "on",
        estimatedMinutes: Number(form.get("estimatedMinutes") || current.estimatedMinutes),
        slotIntervalMinutes: Number(form.get("slotIntervalMinutes") || current.slotIntervalMinutes),
        timezone: "America/Lima",
        hours,
        deliveryZones,
        extras,
        updatedAt: serverTimestamp()
      }, { merge: true });
      state.appError = "";
    } catch (error) {
      state.appError = error.message;
      render();
    }
  });
}

function bindOrderActions() {
  document.querySelectorAll("[data-status]").forEach((button) => {
    button.addEventListener("click", async () => {
      const order = state.orders.find((entry) => entry.id === button.dataset.order);
      try {
        if (button.dataset.status === "preparando" && order?.status === "recibido") {
          await deductStockForOrder(order);
        }
        await updateDoc(doc(db, "orders", button.dataset.order), {
          status: button.dataset.status,
          updatedAt: serverTimestamp()
        });
        await sendCustomerPush(order, button.dataset.status);
      } catch (error) {
        state.appError = error.message;
        render();
      }
    });
  });

  document.querySelectorAll("[data-print]").forEach((button) => {
    button.addEventListener("click", () => printOrder(button.dataset.print));
  });

  document.querySelectorAll("[data-cancel]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await updateDoc(doc(db, "orders", button.dataset.order), {
          status: "cancelado",
          cancellation: {
            by: state.staffRole,
            reason: button.dataset.cancel,
            email: state.user?.email || ""
          },
          updatedAt: serverTimestamp()
        });
      } catch (error) {
        state.appError = error.message;
        render();
      }
    });
  });

  document.querySelectorAll("[data-payment]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await updateDoc(doc(db, "orders", button.dataset.order), {
          "payment.status": button.dataset.payment,
          updatedAt: serverTimestamp()
        });
      } catch (error) {
        state.appError = error.message;
        render();
      }
    });
  });

  document.querySelectorAll("[data-estimate]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await updateDoc(doc(db, "orders", button.dataset.order), {
          "fulfillment.estimatedMinutes": Number(button.dataset.estimate),
          updatedAt: serverTimestamp()
        });
      } catch (error) {
        state.appError = error.message;
        render();
      }
    });
  });
}

function bindMenuActions() {
  document.querySelector("#clearForm").addEventListener("click", () => {
    state.editingItem = null;
    render();
  });

  document.querySelector("#seedButton").addEventListener("click", async () => {
    try {
      await Promise.all(
        initialMenuItems.map((item) =>
          setDoc(doc(db, "menuItems", item.id), {
            ...item,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          }, { merge: true })
        )
      );
    } catch (error) {
      state.appError = error.message;
      render();
    }
  });

  document.querySelector("#menuForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name")).trim();
    const itemId = state.editingItem?.id || name.toLowerCase().normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    const imageFile = form.get("image");
    const trackStock = form.get("trackStock") === "on";
    const stock = Number(form.get("stock") || 0);
    const payload = {
      name,
      category: String(form.get("category")).trim(),
      price: Number(form.get("price")),
      badge: String(form.get("badge")).trim() || "Nuevo",
      description: String(form.get("description")).trim(),
      stock,
      trackStock,
      active: form.get("active") === "on" && (!trackStock || stock > 0),
      updatedAt: serverTimestamp()
    };

    try {
      if (imageFile && imageFile.size > 0) {
        const extension = imageFile.name.split(".").pop() || "jpg";
        const imagePath = `menuItems/${itemId}-${Date.now()}.${extension}`;
        const imageRef = ref(storage, imagePath);
        await uploadBytes(imageRef, imageFile, { contentType: imageFile.type });
        payload.imageUrl = await getDownloadURL(imageRef);
        payload.imagePath = imagePath;
      }

      if (state.editingItem?.id) {
        await updateDoc(doc(db, "menuItems", itemId), payload);
      } else {
        await setDoc(doc(db, "menuItems", itemId), {
          ...payload,
          createdAt: serverTimestamp()
        });
      }

      state.editingItem = null;
    } catch (error) {
      state.appError = error.message;
      render();
    }
  });

  document.querySelectorAll("[data-edit]").forEach((button) => {
    button.addEventListener("click", () => {
      const item = state.menuItems.find((entry) => entry.id === button.dataset.edit);
      state.editingItem = item ? { ...item } : null;
      render();
    });
  });

  document.querySelectorAll("[data-toggle]").forEach((button) => {
    button.addEventListener("click", async () => {
      const item = state.menuItems.find((entry) => entry.id === button.dataset.toggle);
      if (!item) return;

      try {
        await updateDoc(doc(db, "menuItems", item.id), {
          active: item.active === false,
          updatedAt: serverTimestamp()
        });
      } catch (error) {
        state.appError = error.message;
        render();
      }
    });
  });
}

function subscribeData() {
  const unsubscribers = [];

  if (state.user?.uid) {
    unsubscribers.push(
      onSnapshot(
        doc(db, "adminUsers", state.user.uid),
        (snapshot) => {
          state.staffRole = snapshot.exists() ? (snapshot.data().role || "owner") : "owner";
          ensureAllowedView();
          render();
        },
        (error) => {
          state.appError = `${error.message}. Verifica adminUsers/{uid}.`;
          render();
        }
      )
    );
  }

  unsubscribers.push(
    onSnapshot(
      query(collection(db, "orders")),
      (snapshot) => {
        const addedOrders = snapshot.docChanges()
          .filter((change) => change.type === "added")
          .map((change) => ({ id: change.doc.id, ...change.doc.data() }));
        state.orders = snapshot.docs
          .map((entry) => ({ id: entry.id, ...entry.data() }))
          .sort((a, b) => (toDate(b.createdAt)?.getTime() || 0) - (toDate(a.createdAt)?.getTime() || 0));
        state.appError = "";
        if (state.didLoadInitialOrders) {
          addedOrders.forEach(notifyBusinessNewOrder);
        } else {
          state.didLoadInitialOrders = true;
        }
        render();
      },
      (error) => {
        state.appError = `${error.message}. Verifica que el usuario tenga documento en adminUsers/{uid}.`;
        render();
      }
    )
  );

  unsubscribers.push(
    onSnapshot(
      query(collection(db, "menuItems")),
      (snapshot) => {
        state.menuItems = snapshot.docs
          .map((entry) => ({ id: entry.id, ...entry.data() }))
          .sort((a, b) => `${a.category}${a.name}`.localeCompare(`${b.category}${b.name}`));
        state.appError = "";
        render();
      },
      (error) => {
        state.appError = `${error.message}. Verifica las reglas de Firestore y permisos de admin.`;
        render();
      }
    )
  );

  unsubscribers.push(
    onSnapshot(
      doc(db, "businessSettings", "public"),
      (snapshot) => {
        state.settings = mergeBusinessSettings(snapshot.exists() ? snapshot.data() : {});
        state.appError = "";
        render();
      },
      (error) => {
        state.appError = `${error.message}. Verifica las reglas de Firestore para businessSettings/public.`;
        render();
      }
    )
  );

  return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
}

if (isFirebaseConfigured) {
  let unsubscribeData = null;
  onAuthStateChanged(auth, (user) => {
    state.user = user;
    state.authError = "";

    if (unsubscribeData) {
      unsubscribeData();
      unsubscribeData = null;
    }

    if (user) {
      unsubscribeData = subscribeData();
    }

    render();
  });
} else {
  render();
}
