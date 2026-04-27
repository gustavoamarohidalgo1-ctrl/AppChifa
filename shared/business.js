export const DAY_LABELS = ["Domingo", "Lunes", "Martes", "Miercoles", "Jueves", "Viernes", "Sabado"];

export const DEFAULT_HOURS = [
  { day: 0, open: true, from: "12:00", to: "22:00" },
  { day: 1, open: true, from: "12:00", to: "22:00" },
  { day: 2, open: true, from: "12:00", to: "22:00" },
  { day: 3, open: true, from: "12:00", to: "22:00" },
  { day: 4, open: true, from: "12:00", to: "22:00" },
  { day: 5, open: true, from: "12:00", to: "23:00" },
  { day: 6, open: true, from: "12:00", to: "23:00" }
];

export const DEFAULT_DELIVERY_ZONES = [
  { id: "cerca", name: "Zona cercana", fee: 5, active: true },
  { id: "media", name: "Zona media", fee: 8, active: true },
  { id: "lejana", name: "Zona lejana", fee: 12, active: true },
  { id: "fuera", name: "Fuera de zona", fee: 0, active: false }
];

export const ESTIMATE_OPTIONS = [10, 20, 30, 45, 60];

export const DEFAULT_EXTRAS = [
  { id: "arroz-adicional", name: "Arroz adicional", price: 3, active: true },
  { id: "wantan-extra", name: "Wantan extra", price: 4, active: true },
  { id: "salsa-tamarindo", name: "Salsa tamarindo", price: 1, active: true },
  { id: "sin-cebolla-china", name: "Sin cebolla china", price: 0, active: true }
];

export const DEFAULT_BUSINESS_SETTINGS = {
  allowScheduledOrders: true,
  estimatedMinutes: 35,
  hours: DEFAULT_HOURS,
  slotIntervalMinutes: 30,
  timezone: "America/Lima",
  deliveryZones: DEFAULT_DELIVERY_ZONES,
  extras: DEFAULT_EXTRAS
};
