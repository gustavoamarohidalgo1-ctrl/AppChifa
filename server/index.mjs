import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "db.json");
const PORT = Number(process.env.PORT || 3001);
const BUSINESS_TIME_ZONE = "America/Lima";

const ORDER_STATUSES = ["recibido", "preparando", "enviado", "entregado"];

const initialMenuItems = [
  {
    id: "combo-familiar",
    name: "Combo Familiar Chifa",
    category: "Combos",
    description: "Arroz chaufa, tallarin saltado, wantanes y pollo chi jau kay.",
    price: 68,
    badge: "Mas pedido",
    active: true
  },
  {
    id: "combo-duo",
    name: "Combo Duo",
    category: "Combos",
    description: "Dos chaufa especiales, wantan frito y gaseosa personal.",
    price: 42,
    badge: "Para compartir",
    active: true
  },
  {
    id: "chaufa-especial",
    name: "Arroz Chaufa Especial",
    category: "Aeropuertos",
    description: "Chaufa con pollo, chancho asado, langostinos y tortilla.",
    price: 24,
    badge: "Clasico",
    active: true
  },
  {
    id: "aeropuerto-mixto",
    name: "Aeropuerto Mixto",
    category: "Aeropuertos",
    description: "Arroz chaufa con tallarin saltado, pollo, carne y verduras.",
    price: 27,
    badge: "Contundente",
    active: true
  },
  {
    id: "tallarin-saltado",
    name: "Tallarin Saltado",
    category: "Tallarines",
    description: "Fideos salteados al wok con pollo, verduras y salsa oriental.",
    price: 23,
    badge: "Wok",
    active: true
  },
  {
    id: "kam-lu-wantan",
    name: "Kam Lu Wantan",
    category: "Entradas",
    description: "Wantanes crocantes con pollo, chancho, pina y salsa tamarindo.",
    price: 30,
    badge: "Dulce salado",
    active: true
  },
  {
    id: "wantan-frito",
    name: "Wantan Frito",
    category: "Entradas",
    description: "Docena de wantanes dorados con salsa tamarindo de la casa.",
    price: 15,
    badge: "Crocante",
    active: true
  },
  {
    id: "inka-cola",
    name: "Inca Kola 1L",
    category: "Bebidas",
    description: "Gaseosa helada para acompanar el pedido.",
    price: 9,
    badge: "Helada",
    active: true
  }
];

function createInitialDb() {
  return {
    menuItems: initialMenuItems,
    orders: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

async function readDb() {
  try {
    const raw = await readFile(DB_PATH, "utf8");
    const db = JSON.parse(raw);

    return {
      menuItems: Array.isArray(db.menuItems) ? db.menuItems : [],
      orders: Array.isArray(db.orders) ? db.orders : [],
      createdAt: db.createdAt || new Date().toISOString(),
      updatedAt: db.updatedAt || new Date().toISOString()
    };
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }

    const db = createInitialDb();
    await writeDb(db);
    return db;
  }
}

async function writeDb(db) {
  await mkdir(dirname(DB_PATH), { recursive: true });
  const nextDb = { ...db, updatedAt: new Date().toISOString() };
  await writeFile(DB_PATH, `${JSON.stringify(nextDb, null, 2)}\n`);
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload));
}

function parseBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.on("data", (chunk) => {
      body += chunk.toString();
      if (body.length > 1_000_000) {
        reject(new Error("Payload demasiado grande"));
        request.destroy();
      }
    });

    request.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("JSON invalido"));
      }
    });
  });
}

function generateId(prefix) {
  const time = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `${prefix}-${time}-${random}`;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePrice(value) {
  const price = Number(value);
  return Number.isFinite(price) && price >= 0 ? Math.round(price * 100) / 100 : null;
}

function getBusinessDateKey(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: BUSINESS_TIME_ZONE,
    year: "numeric"
  }).formatToParts(new Date(value));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return `${byType.year}-${byType.month}-${byType.day}`;
}

function getReports(orders) {
  const today = getBusinessDateKey();
  const byStatus = ORDER_STATUSES.reduce((accumulator, status) => {
    accumulator[status] = 0;
    return accumulator;
  }, {});

  let totalSales = 0;
  let todayOrders = 0;
  let todaySales = 0;

  for (const order of orders) {
    byStatus[order.status] = (byStatus[order.status] || 0) + 1;
    totalSales += Number(order.total || 0);

    if (getBusinessDateKey(order.createdAt) === today) {
      todayOrders += 1;
      todaySales += Number(order.total || 0);
    }
  }

  return {
    byStatus,
    totalOrders: orders.length,
    totalSales: Math.round(totalSales * 100) / 100,
    todayOrders,
    todaySales: Math.round(todaySales * 100) / 100
  };
}

function sortOrders(orders) {
  return [...orders].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

function buildOrder(db, payload) {
  const customer = payload.customer || {};
  const orderType = payload.orderType === "pickup" ? "pickup" : "delivery";
  const rawItems = Array.isArray(payload.items) ? payload.items : [];

  if (!normalizeText(customer.name) || !normalizeText(customer.phone)) {
    throw new Error("Ingresa nombre y telefono del cliente");
  }

  if (orderType === "delivery" && !normalizeText(customer.address)) {
    throw new Error("Ingresa direccion para delivery");
  }

  if (!rawItems.length) {
    throw new Error("Agrega al menos un producto");
  }

  const items = rawItems.map((entry) => {
    const menuItem = db.menuItems.find((item) => item.id === entry.id);
    const quantity = Number(entry.quantity);

    if (!menuItem || menuItem.active === false) {
      throw new Error("Uno de los productos ya no esta disponible");
    }

    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new Error("Cantidad invalida en el pedido");
    }

    return {
      id: menuItem.id,
      name: menuItem.name,
      category: menuItem.category,
      price: menuItem.price,
      quantity,
      lineTotal: Math.round(menuItem.price * quantity * 100) / 100
    };
  });

  const subtotal = Math.round(items.reduce((sum, item) => sum + item.lineTotal, 0) * 100) / 100;
  const deliveryFee = orderType === "delivery" && subtotal > 0 ? 5 : 0;
  const total = Math.round((subtotal + deliveryFee) * 100) / 100;
  const now = new Date().toISOString();

  return {
    id: generateId("PED"),
    status: "recibido",
    orderType,
    customer: {
      name: normalizeText(customer.name),
      phone: normalizeText(customer.phone),
      address: normalizeText(customer.address),
      notes: normalizeText(customer.notes)
    },
    items,
    subtotal,
    deliveryFee,
    total,
    createdAt: now,
    updatedAt: now
  };
}

function createMenuItem(payload) {
  const name = normalizeText(payload.name);
  const category = normalizeText(payload.category);
  const description = normalizeText(payload.description);
  const badge = normalizeText(payload.badge);
  const price = normalizePrice(payload.price);

  if (!name || !category || !description || price === null) {
    throw new Error("Completa nombre, categoria, descripcion y precio valido");
  }

  return {
    id: generateId("PLATO"),
    name,
    category,
    description,
    price,
    badge: badge || "Nuevo",
    active: payload.active !== false
  };
}

function updateMenuItem(item, payload) {
  const next = { ...item };

  if ("name" in payload) next.name = normalizeText(payload.name);
  if ("category" in payload) next.category = normalizeText(payload.category);
  if ("description" in payload) next.description = normalizeText(payload.description);
  if ("badge" in payload) next.badge = normalizeText(payload.badge);
  if ("active" in payload) next.active = Boolean(payload.active);
  if ("price" in payload) {
    const price = normalizePrice(payload.price);
    if (price === null) throw new Error("Precio invalido");
    next.price = price;
  }

  if (!next.name || !next.category || !next.description) {
    throw new Error("Completa nombre, categoria y descripcion");
  }

  return next;
}

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const path = url.pathname;

  if (request.method === "OPTIONS") {
    sendJson(response, 200, { ok: true });
    return;
  }

  try {
    if (request.method === "GET" && path === "/api/health") {
      sendJson(response, 200, { ok: true, service: "App Chifa API" });
      return;
    }

    if (request.method === "GET" && path === "/api/menu") {
      const db = await readDb();
      const includeInactive = url.searchParams.get("includeInactive") === "true";
      const menuItems = includeInactive ? db.menuItems : db.menuItems.filter((item) => item.active !== false);
      sendJson(response, 200, { menuItems });
      return;
    }

    if (request.method === "POST" && path === "/api/menu") {
      const db = await readDb();
      const payload = await parseBody(request);
      const menuItem = createMenuItem(payload);
      db.menuItems.push(menuItem);
      await writeDb(db);
      sendJson(response, 201, { menuItem });
      return;
    }

    if (request.method === "PATCH" && path.startsWith("/api/menu/")) {
      const id = decodeURIComponent(path.replace("/api/menu/", ""));
      const db = await readDb();
      const index = db.menuItems.findIndex((item) => item.id === id);

      if (index === -1) {
        sendJson(response, 404, { error: "Plato no encontrado" });
        return;
      }

      const payload = await parseBody(request);
      db.menuItems[index] = updateMenuItem(db.menuItems[index], payload);
      await writeDb(db);
      sendJson(response, 200, { menuItem: db.menuItems[index] });
      return;
    }

    if (request.method === "GET" && path === "/api/orders") {
      const db = await readDb();
      sendJson(response, 200, { orders: sortOrders(db.orders), reports: getReports(db.orders) });
      return;
    }

    if (request.method === "POST" && path === "/api/orders") {
      const db = await readDb();
      const payload = await parseBody(request);
      const order = buildOrder(db, payload);
      db.orders.push(order);
      await writeDb(db);
      sendJson(response, 201, { order });
      return;
    }

    if (request.method === "PATCH" && path.startsWith("/api/orders/")) {
      const id = decodeURIComponent(path.replace("/api/orders/", "").replace("/status", ""));
      const db = await readDb();
      const index = db.orders.findIndex((order) => order.id === id);

      if (index === -1) {
        sendJson(response, 404, { error: "Pedido no encontrado" });
        return;
      }

      const payload = await parseBody(request);
      const status = normalizeText(payload.status);

      if (!ORDER_STATUSES.includes(status)) {
        sendJson(response, 400, { error: "Estado invalido" });
        return;
      }

      db.orders[index] = {
        ...db.orders[index],
        status,
        updatedAt: new Date().toISOString()
      };
      await writeDb(db);
      sendJson(response, 200, { order: db.orders[index] });
      return;
    }

    if (request.method === "GET" && path === "/api/reports") {
      const db = await readDb();
      sendJson(response, 200, { reports: getReports(db.orders) });
      return;
    }

    sendJson(response, 404, { error: "Ruta no encontrada" });
  } catch (error) {
    sendJson(response, 400, { error: error.message || "Error inesperado" });
  }
}

const server = createServer(handleRequest);

server.listen(PORT, "0.0.0.0", async () => {
  await readDb();
  console.log(`App Chifa API escuchando en http://127.0.0.1:${PORT}`);
});
