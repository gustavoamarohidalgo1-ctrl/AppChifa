import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import { StatusBar } from "expo-status-bar";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  updateProfile
} from "firebase/auth";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where
} from "firebase/firestore";
import { auth, db, isFirebaseConfigured } from "./src/firebase";
import { DAY_LABELS, DEFAULT_BUSINESS_SETTINGS } from "./shared/business";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowAlert: true
  })
});

const ORDER_STATUSES = ["recibido", "preparando", "listo", "en_camino", "entregado"];
const STATUS_LABELS = {
  recibido: "Recibido",
  preparando: "Preparando",
  listo: "Listo",
  en_camino: "En camino",
  enviado: "Enviado",
  entregado: "Entregado",
  cancelado: "Cancelado"
};

const PAYMENT_METHODS = [
  {
    id: "yape",
    label: "Yape",
    icon: "cellphone",
    placeholder: "Codigo de operacion Yape"
  },
  {
    id: "plin",
    label: "Plin",
    icon: "cellphone-wireless",
    placeholder: "Codigo de operacion Plin"
  },
  {
    id: "mercado_pago",
    label: "Mercado Pago",
    icon: "wallet-outline",
    placeholder: "Codigo o referencia Mercado Pago"
  },
  {
    id: "card",
    label: "Tarjeta",
    icon: "credit-card-outline",
    placeholder: "Codigo de aprobacion o ultimos 4 digitos"
  }
];

const COUPONS = {
  CHIFA10: {
    label: "10% de descuento",
    minSubtotal: 20,
    type: "percent",
    value: 0.1
  },
  COMBO5: {
    label: "S/ 5.00 menos",
    minSubtotal: 45,
    type: "amount",
    value: 5
  },
  DELIVERY0: {
    label: "Delivery gratis",
    minSubtotal: 35,
    type: "delivery_free"
  },
  HAPPYCHIFA: {
    label: "15% de 12:00 a 15:00",
    minSubtotal: 30,
    type: "percent",
    value: 0.15,
    hours: [12, 15]
  }
};

const emptyCustomer = {
  name: "",
  phone: "",
  address: "",
  notes: ""
};

const emptyAuthForm = {
  name: "",
  email: "",
  password: ""
};

const formatPrice = (value) => `S/ ${Number(value || 0).toFixed(2)}`;
const roundMoney = (value) => Math.round(Number(value || 0) * 100) / 100;

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
        fee: roundMoney(zone.fee),
        active: zone.active !== false
      }))
    : DEFAULT_BUSINESS_SETTINGS.deliveryZones;
  const extras = Array.isArray(data.extras) && data.extras.length
    ? data.extras.map((extra) => ({
        id: String(extra.id || extra.name || "").trim() || `extra-${Date.now()}`,
        name: String(extra.name || "Extra").trim(),
        price: roundMoney(extra.price),
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

function timeToMinutes(value = "00:00") {
  const [hours = "0", minutes = "0"] = String(value).split(":");
  return Number(hours) * 60 + Number(minutes);
}

function minutesToTime(value) {
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function getLimaParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    timeZone: "America/Lima",
    year: "numeric"
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const hour = Number(byType.hour) % 24;
  const dateKey = `${byType.year}-${byType.month}-${byType.day}`;
  const dayIndex = new Date(`${dateKey}T05:00:00.000Z`).getUTCDay();

  return {
    dateKey,
    dayIndex,
    minutes: hour * 60 + Number(byType.minute)
  };
}

function addDaysToDateKey(dateKey, days) {
  const date = new Date(`${dateKey}T05:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function getDateLabel(dateKey) {
  const today = getLimaParts().dateKey;
  const tomorrow = addDaysToDateKey(today, 1);
  if (dateKey === today) return "Hoy";
  if (dateKey === tomorrow) return "Manana";
  const day = new Date(`${dateKey}T05:00:00.000Z`).getUTCDay();
  return DAY_LABELS[day] || dateKey;
}

function getDayHours(settings, dateKey) {
  const dayIndex = new Date(`${dateKey}T05:00:00.000Z`).getUTCDay();
  return settings.hours.find((entry) => Number(entry.day) === dayIndex);
}

function isBusinessOpenNow(settings) {
  const now = getLimaParts();
  const today = settings.hours.find((entry) => Number(entry.day) === now.dayIndex);
  if (!today?.open) return false;
  return now.minutes >= timeToMinutes(today.from) && now.minutes < timeToMinutes(today.to);
}

function getScheduleDays() {
  const today = getLimaParts().dateKey;
  return [today, addDaysToDateKey(today, 1)];
}

function getScheduleSlots(settings, dateKey) {
  const dayHours = getDayHours(settings, dateKey);
  if (!dayHours?.open) return [];

  const interval = Number(settings.slotIntervalMinutes || 30);
  const now = getLimaParts();
  const start = timeToMinutes(dayHours.from);
  const end = timeToMinutes(dayHours.to);
  if (end <= start) return [];

  const minimum = dateKey === now.dateKey
    ? Math.max(start, now.minutes + Number(settings.estimatedMinutes || 35))
    : start;
  let nextSlot = Math.ceil(minimum / interval) * interval;
  const slots = [];

  while (nextSlot < end) {
    slots.push(minutesToTime(nextSlot));
    nextSlot += interval;
  }

  return slots;
}

function toDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  if (value.seconds) return new Date(value.seconds * 1000);
  return new Date(value);
}

function formatShortDate(value) {
  const date = toDate(value);
  if (!date || Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("es-PE", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(date);
}

function getPeruHour(date = new Date()) {
  const value = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    hour12: false,
    timeZone: "America/Lima"
  }).format(date);
  return Number(value);
}

function resolveCoupon(code, subtotal, deliveryFee, orderType) {
  const normalized = String(code || "").trim().toUpperCase();
  if (!normalized) return null;

  const coupon = COUPONS[normalized];
  if (!coupon) {
    return { valid: false, message: "Cupon no encontrado." };
  }

  if (subtotal < coupon.minSubtotal) {
    return {
      valid: false,
      message: `Este cupon aplica desde ${formatPrice(coupon.minSubtotal)}.`
    };
  }

  if (coupon.hours) {
    const hour = getPeruHour();
    const [start, end] = coupon.hours;
    if (hour < start || hour >= end) {
      return {
        valid: false,
        message: `Disponible de ${String(start).padStart(2, "0")}:00 a ${String(end).padStart(2, "0")}:00.`
      };
    }
  }

  if (coupon.type === "delivery_free" && orderType !== "delivery") {
    return { valid: false, message: "Este cupon aplica solo para delivery." };
  }

  let discount = 0;
  if (coupon.type === "percent") discount = subtotal * coupon.value;
  if (coupon.type === "amount") discount = coupon.value;
  if (coupon.type === "delivery_free") discount = deliveryFee;

  return {
    valid: true,
    code: normalized,
    discount: Math.min(roundMoney(discount), roundMoney(subtotal + deliveryFee)),
    label: coupon.label,
    type: coupon.type
  };
}

function getFriendlyAuthError(error) {
  if (error?.code === "auth/email-already-in-use") return "Ese correo ya tiene una cuenta.";
  if (error?.code === "auth/invalid-credential") return "Correo o contrasena incorrectos.";
  if (error?.code === "auth/weak-password") return "Usa una contrasena de al menos 6 caracteres.";
  if (error?.code === "auth/invalid-email") return "El correo no tiene un formato valido.";
  return error?.message || "No se pudo completar el acceso.";
}

async function registerForPushNotificationsAsync() {
  if (!Device.isDevice) {
    return null;
  }

  const current = await Notifications.getPermissionsAsync();
  let status = current.status;

  if (status !== "granted") {
    const requested = await Notifications.requestPermissionsAsync();
    status = requested.status;
  }

  if (status !== "granted") {
    return null;
  }

  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ||
    Constants.easConfig?.projectId ||
    process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
  const tokenResponse = projectId
    ? await Notifications.getExpoPushTokenAsync({ projectId })
    : await Notifications.getExpoPushTokenAsync();

  return tokenResponse.data;
}

export default function App() {
  const [selectedCategory, setSelectedCategory] = useState("");
  const [menuItems, setMenuItems] = useState([]);
  const [cart, setCart] = useState({});
  const [orderType, setOrderType] = useState("delivery");
  const [customer, setCustomer] = useState(emptyCustomer);
  const [currentOrder, setCurrentOrder] = useState(null);
  const [currentOrderId, setCurrentOrderId] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSavingOrder, setIsSavingOrder] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [authReady, setAuthReady] = useState(false);
  const [customerUser, setCustomerUser] = useState(null);
  const [authMode, setAuthMode] = useState("signin");
  const [authForm, setAuthForm] = useState(emptyAuthForm);
  const [authError, setAuthError] = useState("");
  const [customerOrders, setCustomerOrders] = useState([]);
  const [couponDraft, setCouponDraft] = useState("");
  const [appliedCouponCode, setAppliedCouponCode] = useState("");
  const [couponError, setCouponError] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("yape");
  const [paymentReference, setPaymentReference] = useState("");
  const [businessSettings, setBusinessSettings] = useState(DEFAULT_BUSINESS_SETTINGS);
  const [fulfillmentMode, setFulfillmentMode] = useState("asap");
  const [scheduledDateKey, setScheduledDateKey] = useState("");
  const [scheduledTime, setScheduledTime] = useState("");
  const [selectedDeliveryZoneId, setSelectedDeliveryZoneId] = useState("");
  const [selectedExtras, setSelectedExtras] = useState({});

  const categories = useMemo(() => {
    const names = menuItems.map((item) => item.category).filter(Boolean);
    return [...new Set(names)];
  }, [menuItems]);

  const visibleItems = useMemo(
    () => menuItems.filter((item) => item.category === selectedCategory),
    [menuItems, selectedCategory]
  );

  const cartItems = useMemo(
    () =>
      Object.entries(cart)
        .map(([id, quantity]) => {
          const item = menuItems.find((entry) => entry.id === id);
          return item ? { ...item, quantity } : null;
        })
        .filter(Boolean),
    [cart, menuItems]
  );

  const subtotal = cartItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const activeExtras = businessSettings.extras.filter((extra) => extra.active !== false);
  const orderExtras = activeExtras.filter((extra) => selectedExtras[extra.id]);
  const extrasTotal = orderExtras.reduce((sum, extra) => sum + Number(extra.price || 0), 0);
  const activeDeliveryZones = businessSettings.deliveryZones.filter((zone) => zone.active !== false);
  const selectedDeliveryZone = activeDeliveryZones.find((zone) => zone.id === selectedDeliveryZoneId)
    || activeDeliveryZones[0]
    || null;
  const deliveryFee = orderType === "delivery" && subtotal > 0 ? Number(selectedDeliveryZone?.fee || 0) : 0;
  const businessOpen = isBusinessOpenNow(businessSettings);
  const scheduleDays = useMemo(() => getScheduleDays(), []);
  const scheduledSlots = scheduledDateKey ? getScheduleSlots(businessSettings, scheduledDateKey) : [];
  const scheduledAt = fulfillmentMode === "scheduled" && scheduledDateKey && scheduledTime
    ? new Date(`${scheduledDateKey}T${scheduledTime}:00-05:00`)
    : null;
  const fulfillmentLabel = fulfillmentMode === "scheduled" && scheduledDateKey && scheduledTime
    ? `${getDateLabel(scheduledDateKey)} ${scheduledTime}`
    : `Lo antes posible (${businessSettings.estimatedMinutes} min)`;
  const couponResult = useMemo(
    () => resolveCoupon(appliedCouponCode, subtotal + extrasTotal, deliveryFee, orderType),
    [appliedCouponCode, deliveryFee, extrasTotal, orderType, subtotal]
  );
  const discount = couponResult?.valid ? couponResult.discount : 0;
  const total = Math.max(roundMoney(subtotal + extrasTotal + deliveryFee - discount), 0);
  const itemCount = cartItems.reduce((sum, item) => sum + item.quantity, 0);
  const selectedPayment = PAYMENT_METHODS.find((method) => method.id === paymentMethod) || PAYMENT_METHODS[0];

  const loadMenu = async () => {
    if (!isFirebaseConfigured || !db) {
      setLoadError("Configura Firebase en el archivo .env para conectar la app a la nube.");
      return;
    }

    setIsLoading(true);
    try {
      const menuQuery = query(collection(db, "menuItems"), where("active", "==", true));
      const snapshot = await getDocs(menuQuery);
      const items = snapshot.docs
        .map((entry) => ({ id: entry.id, ...entry.data() }))
        .filter((item) => item.trackStock !== true || Number(item.stock || 0) > 0)
        .sort((a, b) => `${a.category}${a.name}`.localeCompare(`${b.category}${b.name}`));

      setMenuItems(items);
      setLoadError("");
    } catch (error) {
      setLoadError(error.message);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadMenu();
  }, []);

  useEffect(() => {
    if (!db) {
      return undefined;
    }

    return onSnapshot(
      doc(db, "businessSettings", "public"),
      (snapshot) => {
        setBusinessSettings(mergeBusinessSettings(snapshot.exists() ? snapshot.data() : {}));
        setLoadError("");
      },
      (error) => {
        setLoadError(error.message);
      }
    );
  }, []);

  useEffect(() => {
    if (!auth || !db) {
      setAuthReady(true);
      return undefined;
    }

    return onAuthStateChanged(auth, async (user) => {
      setCustomerUser(user);
      setAuthReady(true);
      setAuthError("");

      if (!user) {
        setCustomerOrders([]);
        return;
      }

      try {
        const profileSnapshot = await getDoc(doc(db, "customers", user.uid));
        const profile = profileSnapshot.exists() ? profileSnapshot.data() : {};
        setCustomer((current) => ({
          ...current,
          name: profile.name || user.displayName || current.name,
          phone: profile.phone || current.phone,
          address: profile.address || current.address
        }));
      } catch (error) {
        setLoadError(error.message);
      }
    });
  }, []);

  useEffect(() => {
    if (!currentOrderId || !db) {
      return undefined;
    }

    return onSnapshot(
      doc(db, "orders", currentOrderId),
      (snapshot) => {
        if (snapshot.exists()) {
          setCurrentOrder({ id: snapshot.id, ...snapshot.data() });
        }
      },
      (error) => {
        setLoadError(error.message);
      }
    );
  }, [currentOrderId]);

  useEffect(() => {
    if (!customerUser || !db) {
      setCustomerOrders([]);
      return undefined;
    }

    const ordersQuery = query(collection(db, "orders"), where("customerUid", "==", customerUser.uid));
    return onSnapshot(
      ordersQuery,
      (snapshot) => {
        const orders = snapshot.docs
          .map((entry) => ({ id: entry.id, ...entry.data() }))
          .sort((a, b) => (toDate(b.createdAt)?.getTime() || 0) - (toDate(a.createdAt)?.getTime() || 0));
        setCustomerOrders(orders);
      },
      (error) => setLoadError(error.message)
    );
  }, [customerUser]);

  useEffect(() => {
    if (!selectedCategory && categories.length) {
      setSelectedCategory(categories[0]);
    }

    if (selectedCategory && categories.length && !categories.includes(selectedCategory)) {
      setSelectedCategory(categories[0]);
    }
  }, [categories, selectedCategory]);

  useEffect(() => {
    if (orderType !== "delivery") {
      return;
    }

    if (!selectedDeliveryZone || selectedDeliveryZone.id !== selectedDeliveryZoneId) {
      setSelectedDeliveryZoneId(activeDeliveryZones[0]?.id || "");
    }
  }, [activeDeliveryZones, orderType, selectedDeliveryZone, selectedDeliveryZoneId]);

  useEffect(() => {
    const firstDateKey = scheduleDays.find((dateKey) => getScheduleSlots(businessSettings, dateKey).length);

    if (!businessOpen && fulfillmentMode === "asap") {
      setFulfillmentMode("scheduled");
    }

    if (!scheduledDateKey || !scheduleDays.includes(scheduledDateKey)) {
      setScheduledDateKey(firstDateKey || scheduleDays[0]);
      return;
    }

    const slots = getScheduleSlots(businessSettings, scheduledDateKey);
    if (fulfillmentMode === "scheduled" && (!scheduledTime || !slots.includes(scheduledTime))) {
      setScheduledTime(slots[0] || "");
    }
  }, [businessOpen, businessSettings, fulfillmentMode, scheduleDays, scheduledDateKey, scheduledTime]);

  const updateQuantity = (id, amount) => {
    setCart((current) => {
      const nextQuantity = Math.max((current[id] || 0) + amount, 0);
      const next = { ...current };

      if (nextQuantity === 0) {
        delete next[id];
      } else {
        next[id] = nextQuantity;
      }

      return next;
    });
  };

  const updateCustomer = (field, value) => {
    setCustomer((current) => ({ ...current, [field]: value }));
  };

  const updateAuthForm = (field, value) => {
    setAuthForm((current) => ({ ...current, [field]: value }));
  };

  const toggleExtra = (id) => {
    setSelectedExtras((current) => ({
      ...current,
      [id]: !current[id]
    }));
  };

  const resetOrderForm = () => {
    setCart({});
    setCustomer((current) => ({ ...current, notes: "" }));
    setSelectedExtras({});
    setAppliedCouponCode("");
    setCouponDraft("");
    setCouponError("");
    setPaymentReference("");
    setFulfillmentMode(businessOpen ? "asap" : "scheduled");
  };

  const handleCustomerAuth = async () => {
    if (!auth || !db) {
      setAuthError("Firebase no esta configurado.");
      return;
    }

    const email = authForm.email.trim().toLowerCase();
    const password = authForm.password;
    const name = authForm.name.trim();

    if (!email || !password || (authMode === "register" && !name)) {
      setAuthError("Completa los campos para continuar.");
      return;
    }

    setAuthError("");
    try {
      if (authMode === "register") {
        const credential = await createUserWithEmailAndPassword(auth, email, password);
        await updateProfile(credential.user, { displayName: name });
        await setDoc(doc(db, "customers", credential.user.uid), {
          email,
          name,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        }, { merge: true });
        setCustomer((current) => ({ ...current, name: current.name || name }));
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }

      setAuthForm(emptyAuthForm);
    } catch (error) {
      setAuthError(getFriendlyAuthError(error));
    }
  };

  const handleCustomerSignOut = async () => {
    try {
      await signOut(auth);
      setCurrentOrder(null);
      setCurrentOrderId("");
    } catch (error) {
      setAuthError(error.message);
    }
  };

  const applyCoupon = () => {
    const normalized = couponDraft.trim().toUpperCase();
    const result = resolveCoupon(normalized, subtotal, deliveryFee, orderType);

    if (!result?.valid) {
      setAppliedCouponCode("");
      setCouponError(result?.message || "Ingresa un cupon.");
      return;
    }

    setAppliedCouponCode(normalized);
    setCouponDraft(normalized);
    setCouponError("");
  };

  const clearCoupon = () => {
    setAppliedCouponCode("");
    setCouponDraft("");
    setCouponError("");
  };

  const repeatOrder = (order) => {
    const nextCart = {};
    const unavailable = [];

    for (const item of order.items || []) {
      const menuItem = menuItems.find((entry) => entry.id === item.id);
      if (menuItem) {
        nextCart[item.id] = item.quantity || 1;
      } else {
        unavailable.push(item.name);
      }
    }

    if (!Object.keys(nextCart).length) {
      Alert.alert("No disponible", "Los platos de ese pedido ya no estan activos en la carta.");
      return;
    }

    setCart(nextCart);
    setOrderType(order.orderType || "delivery");
    setFulfillmentMode(businessOpen ? "asap" : "scheduled");
    setCustomer((current) => ({
      ...current,
      name: order.customer?.name || current.name,
      phone: order.customer?.phone || current.phone,
      address: order.customer?.address || current.address,
      notes: ""
    }));
    setAppliedCouponCode("");
    setCouponDraft("");
    setCouponError("");
    setPaymentReference("");
    setSelectedExtras({});

    const firstItemId = Object.keys(nextCart)[0];
    const firstMenuItem = menuItems.find((item) => item.id === firstItemId);
    if (firstMenuItem?.category) {
      setSelectedCategory(firstMenuItem.category);
    }

    Alert.alert(
      "Pedido repetido",
      unavailable.length
        ? "Agregue los platos disponibles. Algunos ya no estan activos."
        : "Agregue el pedido anterior al carrito."
    );
  };

  const submitOrder = async () => {
    if (!isFirebaseConfigured || !db) {
      Alert.alert("Firebase no configurado", "Completa el archivo .env antes de crear pedidos.");
      return;
    }

    if (!customerUser) {
      Alert.alert("Inicia sesion", "Crea una cuenta o entra con tu correo para enviar el pedido.");
      return;
    }

    if (!cartItems.length) {
      Alert.alert("Carrito vacio", "Agrega al menos un plato para continuar.");
      return;
    }

    if (!customer.name.trim() || !customer.phone.trim()) {
      Alert.alert("Datos incompletos", "Ingresa tu nombre y telefono.");
      return;
    }

    if (orderType === "delivery" && !customer.address.trim()) {
      Alert.alert("Falta direccion", "Ingresa la direccion para el delivery.");
      return;
    }

    if (orderType === "delivery" && !selectedDeliveryZone) {
      Alert.alert("Zona no disponible", "Elige una zona de delivery disponible.");
      return;
    }

    if (fulfillmentMode === "asap" && !businessOpen) {
      Alert.alert("Chifa cerrado", "Programa tu pedido para un horario disponible.");
      return;
    }

    if (fulfillmentMode === "scheduled") {
      if (!businessSettings.allowScheduledOrders) {
        Alert.alert("Pedidos programados no disponibles", "El negocio no esta aceptando pedidos programados ahora.");
        return;
      }

      if (!scheduledDateKey || !scheduledTime || !scheduledSlots.includes(scheduledTime)) {
        Alert.alert("Horario no disponible", "Elige un horario valido para programar tu pedido.");
        return;
      }
    }

    if (appliedCouponCode && !couponResult?.valid) {
      Alert.alert("Cupon no aplicado", couponResult?.message || "Revisa el cupon antes de continuar.");
      return;
    }

    if (!paymentReference.trim()) {
      Alert.alert("Pago pendiente", `Ingresa la referencia de pago para ${selectedPayment.label}.`);
      return;
    }

    setIsSavingOrder(true);
    try {
      const pushToken = await registerForPushNotificationsAsync();
      const items = cartItems.map((item) => ({
        id: item.id,
        name: item.name,
        category: item.category,
        imageUrl: item.imageUrl || "",
        price: item.price,
        quantity: item.quantity,
        lineTotal: roundMoney(item.price * item.quantity)
      }));

      await setDoc(doc(db, "customers", customerUser.uid), {
        email: customerUser.email || "",
        name: customer.name.trim(),
        phone: customer.phone.trim(),
        address: customer.address.trim(),
        updatedAt: serverTimestamp()
      }, { merge: true });

      const order = {
        customerUid: customerUser.uid,
        customerEmail: customerUser.email || "",
        customerPushToken: pushToken,
        status: "recibido",
        orderType,
        customer: {
          name: customer.name.trim(),
          phone: customer.phone.trim(),
          address: customer.address.trim(),
          notes: customer.notes.trim()
        },
        items,
        subtotal: roundMoney(subtotal),
        extras: orderExtras.map((extra) => ({
          id: extra.id,
          name: extra.name,
          price: roundMoney(extra.price)
        })),
        extrasTotal: roundMoney(extrasTotal),
        deliveryFee,
        deliveryZone: orderType === "delivery" && selectedDeliveryZone
          ? {
              id: selectedDeliveryZone.id,
              name: selectedDeliveryZone.name,
              fee: roundMoney(selectedDeliveryZone.fee)
            }
          : {
              id: "pickup",
              name: "Recojo en tienda",
              fee: 0
            },
        discount,
        coupon: couponResult?.valid
          ? {
              code: couponResult.code,
              discount: couponResult.discount,
              label: couponResult.label,
              type: couponResult.type
            }
          : null,
        payment: {
          method: selectedPayment.id,
          methodLabel: selectedPayment.label,
          reference: paymentReference.trim(),
          status: "pendiente_verificacion",
          paidBeforeSend: true
        },
        fulfillment: {
          mode: fulfillmentMode,
          label: fulfillmentLabel,
          scheduledAt,
          scheduledDateKey: fulfillmentMode === "scheduled" ? scheduledDateKey : "",
          scheduledTime: fulfillmentMode === "scheduled" ? scheduledTime : "",
          estimatedMinutes: Number(businessSettings.estimatedMinutes || 35)
        },
        total,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      };

      const docRef = await addDoc(collection(db, "orders"), order);
      setCurrentOrder({
        ...order,
        id: docRef.id,
        createdAt: new Date(),
        updatedAt: new Date()
      });
      setCurrentOrderId(docRef.id);
      resetOrderForm();
      Alert.alert("Pedido registrado", `Tu pedido ${docRef.id} fue enviado al chifa.`);
    } catch (error) {
      Alert.alert("No se pudo guardar", error.message);
    } finally {
      setIsSavingOrder(false);
    }
  };

  const cancelCurrentOrder = async () => {
    if (!currentOrderId || !db || currentOrder?.status !== "recibido") {
      Alert.alert("No disponible", "Solo puedes cancelar antes de que cocina empiece a preparar.");
      return;
    }

    try {
      await updateDoc(doc(db, "orders", currentOrderId), {
        status: "cancelado",
        cancellation: {
          by: "customer",
          reason: "Cancelado por el cliente"
        },
        updatedAt: serverTimestamp()
      });
      Alert.alert("Pedido cancelado", "Avisamos al negocio que cancelaste el pedido.");
    } catch (error) {
      Alert.alert("No se pudo cancelar", error.message);
    }
  };

  const renderConfigNotice = () =>
    loadError ? (
      <View style={styles.errorBanner}>
        <MaterialCommunityIcons name="alert-circle-outline" size={20} color="#991b1b" />
        <Text style={styles.errorText}>{loadError}</Text>
      </View>
    ) : null;

  const renderOrderTracker = () => {
    if (!currentOrder) return null;
    const isCanceled = currentOrder.status === "cancelado";
    const trackerStatus = currentOrder.status === "enviado" ? "en_camino" : currentOrder.status;
    const currentIndex = Math.max(ORDER_STATUSES.indexOf(trackerStatus), 0);

    return (
      <View style={[styles.trackerCard, isCanceled && styles.trackerCardCanceled]}>
        <View style={styles.panelHeader}>
          <View style={styles.flexItem}>
            <Text style={styles.sectionTitle}>{isCanceled ? "Pedido cancelado" : "Pedido en vivo"}</Text>
            <Text style={styles.sectionMeta}>{currentOrder.id}</Text>
            {isCanceled && (
              <Text style={styles.canceledText}>
                {currentOrder.cancellation?.reason || "Cancelado"}
              </Text>
            )}
            {!!currentOrder.payment?.methodLabel && (
              <Text style={styles.sectionMeta}>
                {currentOrder.payment.methodLabel} - {
                  currentOrder.payment.status === "verificado"
                    ? "verificado"
                    : currentOrder.payment.status === "rechazado"
                      ? "rechazado"
                      : "por verificar"
                }
              </Text>
            )}
            {!!currentOrder.fulfillment?.label && (
              <Text style={styles.sectionMeta}>{currentOrder.fulfillment.label}</Text>
            )}
            {!!currentOrder.fulfillment?.estimatedMinutes && (
              <Text style={styles.sectionMeta}>Tiempo estimado: {currentOrder.fulfillment.estimatedMinutes} min</Text>
            )}
          </View>
          <Text style={styles.trackerTotal}>{formatPrice(currentOrder.total)}</Text>
        </View>
        {!isCanceled && (
          <View style={styles.trackerSteps}>
            {ORDER_STATUSES.map((status, index) => {
              const isDone = index <= currentIndex;
              return (
                <View key={status} style={styles.trackerStep}>
                  <View style={[styles.trackerDot, isDone && styles.trackerDotActive]}>
                    <MaterialCommunityIcons
                      name={isDone ? "check" : "clock-outline"}
                      size={14}
                      color={isDone ? "#fff" : "#78716c"}
                    />
                  </View>
                  <Text style={[styles.trackerLabel, isDone && styles.trackerLabelActive]}>
                    {STATUS_LABELS[status]}
                  </Text>
                </View>
              );
            })}
          </View>
        )}
        {currentOrder.status === "recibido" && (
          <Pressable style={styles.cancelOrderButton} onPress={cancelCurrentOrder}>
            <MaterialCommunityIcons name="close-circle-outline" size={18} color="#991b1b" />
            <Text style={styles.cancelOrderText}>Cancelar pedido</Text>
          </Pressable>
        )}
      </View>
    );
  };

  const renderCustomerAccess = () => {
    if (!authReady) {
      return (
        <View style={styles.accountCard}>
          <Text style={styles.sectionTitle}>Cuenta</Text>
          <Text style={styles.emptyText}>Preparando acceso...</Text>
        </View>
      );
    }

    if (customerUser) {
      return (
        <View style={styles.accountCard}>
          <View style={styles.accountHeader}>
            <View style={styles.flexItem}>
              <Text style={styles.sectionTitle}>{customer.name || customerUser.displayName || "Cliente"}</Text>
              <Text style={styles.sectionMeta}>{customerUser.email}</Text>
            </View>
            <Pressable style={styles.iconOnlyButton} onPress={handleCustomerSignOut}>
              <MaterialCommunityIcons name="logout" size={20} color="#7f1d1d" />
            </Pressable>
          </View>
        </View>
      );
    }

    return (
      <View style={styles.accountCard}>
        <View style={styles.authSwitch}>
          <Pressable
            style={[styles.authToggle, authMode === "signin" && styles.authToggleSelected]}
            onPress={() => setAuthMode("signin")}
          >
            <MaterialCommunityIcons
              name="login"
              size={17}
              color={authMode === "signin" ? "#fff" : "#57534e"}
            />
            <Text style={[styles.authToggleText, authMode === "signin" && styles.authToggleTextSelected]}>
              Entrar
            </Text>
          </Pressable>
          <Pressable
            style={[styles.authToggle, authMode === "register" && styles.authToggleSelected]}
            onPress={() => setAuthMode("register")}
          >
            <MaterialCommunityIcons
              name="account-plus-outline"
              size={17}
              color={authMode === "register" ? "#fff" : "#57534e"}
            />
            <Text style={[styles.authToggleText, authMode === "register" && styles.authToggleTextSelected]}>
              Crear cuenta
            </Text>
          </Pressable>
        </View>
        {authMode === "register" && (
          <TextInput
            placeholder="Nombre"
            placeholderTextColor="#a8a29e"
            value={authForm.name}
            onChangeText={(value) => updateAuthForm("name", value)}
            style={styles.input}
          />
        )}
        <TextInput
          placeholder="Correo"
          placeholderTextColor="#a8a29e"
          value={authForm.email}
          onChangeText={(value) => updateAuthForm("email", value)}
          keyboardType="email-address"
          autoCapitalize="none"
          style={styles.input}
        />
        <TextInput
          placeholder="Contrasena"
          placeholderTextColor="#a8a29e"
          value={authForm.password}
          onChangeText={(value) => updateAuthForm("password", value)}
          secureTextEntry
          style={styles.input}
        />
        {!!authError && (
          <View style={styles.inlineError}>
            <MaterialCommunityIcons name="alert-circle-outline" size={16} color="#991b1b" />
            <Text style={styles.inlineErrorText}>{authError}</Text>
          </View>
        )}
        <Pressable style={styles.accountButton} onPress={handleCustomerAuth}>
          <Text style={styles.accountButtonText}>{authMode === "register" ? "Crear cuenta" : "Entrar"}</Text>
        </Pressable>
      </View>
    );
  };

  const renderOrderHistory = () => {
    if (!customerUser) return null;

    const recentOrders = customerOrders.slice(0, 3);
    return (
      <View style={styles.historyPanel}>
        <View style={styles.panelHeader}>
          <View>
            <Text style={styles.sectionTitle}>Historial</Text>
            <Text style={styles.sectionMeta}>{customerOrders.length} pedidos</Text>
          </View>
          <MaterialCommunityIcons name="history" size={22} color="#7f1d1d" />
        </View>
        {recentOrders.length ? (
          recentOrders.map((order) => (
            <View key={order.id} style={styles.historyItem}>
              <View style={styles.flexItem}>
                <Text style={styles.historyTitle}>{formatPrice(order.total)}</Text>
                <Text style={styles.sectionMeta}>
                  {STATUS_LABELS[order.status] || order.status} - {formatShortDate(order.createdAt)}
                </Text>
              </View>
              <Pressable style={styles.repeatButton} onPress={() => repeatOrder(order)}>
                <MaterialCommunityIcons name="repeat" size={16} color="#7f1d1d" />
                <Text style={styles.repeatButtonText}>Repetir</Text>
              </Pressable>
            </View>
          ))
        ) : (
          <Text style={styles.emptyText}>Aun no tienes pedidos guardados.</Text>
        )}
      </View>
    );
  };

  const renderBusinessStatus = () => {
    const now = getLimaParts();
    const todayHours = businessSettings.hours.find((entry) => Number(entry.day) === now.dayIndex);
    const statusText = businessOpen
      ? `Abierto hasta ${todayHours?.to || "--:--"}`
      : businessSettings.allowScheduledOrders
        ? "Cerrado ahora, programa tu pedido"
        : "Cerrado ahora";

    return (
      <View style={[styles.statusNotice, businessOpen ? styles.statusNoticeOpen : styles.statusNoticeClosed]}>
        <MaterialCommunityIcons
          name={businessOpen ? "store-clock-outline" : "calendar-clock"}
          size={20}
          color={businessOpen ? "#166534" : "#92400e"}
        />
        <Text style={[styles.statusNoticeText, businessOpen ? styles.statusNoticeTextOpen : styles.statusNoticeTextClosed]}>
          {statusText}
        </Text>
      </View>
    );
  };

  const renderDeliveryZones = () => {
    if (orderType !== "delivery") return null;

    return (
      <View style={styles.optionBox}>
        <View style={styles.couponHeader}>
          <MaterialCommunityIcons name="map-marker-radius-outline" size={19} color="#7f1d1d" />
          <Text style={styles.subsectionTitle}>Zona de delivery</Text>
        </View>
        <View style={styles.optionGrid}>
          {activeDeliveryZones.map((zone) => {
            const isSelected = selectedDeliveryZone?.id === zone.id;
            return (
              <Pressable
                key={zone.id}
                style={[styles.deliveryZoneOption, isSelected && styles.deliveryZoneOptionSelected]}
                onPress={() => setSelectedDeliveryZoneId(zone.id)}
              >
                <Text style={[styles.deliveryZoneName, isSelected && styles.deliveryZoneNameSelected]}>
                  {zone.name}
                </Text>
                <Text style={[styles.deliveryZoneFee, isSelected && styles.deliveryZoneFeeSelected]}>
                  {formatPrice(zone.fee)}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {!activeDeliveryZones.length && (
          <Text style={styles.couponError}>No hay zonas de delivery activas.</Text>
        )}
      </View>
    );
  };

  const renderFulfillmentOptions = () => (
    <View style={styles.optionBox}>
      <View style={styles.couponHeader}>
        <MaterialCommunityIcons name="clock-outline" size={19} color="#7f1d1d" />
        <Text style={styles.subsectionTitle}>Entrega</Text>
      </View>
      <View style={styles.segmentedCompact}>
        <Pressable
          style={[
            styles.segmentCompact,
            fulfillmentMode === "asap" && styles.segmentSelected,
            !businessOpen && styles.segmentDisabled
          ]}
          onPress={() => businessOpen && setFulfillmentMode("asap")}
          disabled={!businessOpen}
        >
          <Text style={[styles.segmentText, fulfillmentMode === "asap" && styles.segmentTextSelected]}>
            Ahora
          </Text>
        </Pressable>
        <Pressable
          style={[styles.segmentCompact, fulfillmentMode === "scheduled" && styles.segmentSelected]}
          onPress={() => setFulfillmentMode("scheduled")}
        >
          <Text style={[styles.segmentText, fulfillmentMode === "scheduled" && styles.segmentTextSelected]}>
            Programar
          </Text>
        </Pressable>
      </View>

      {fulfillmentMode === "scheduled" && (
        <>
          <View style={styles.optionGrid}>
            {scheduleDays.map((dateKey) => {
              const isSelected = scheduledDateKey === dateKey;
              return (
                <Pressable
                  key={dateKey}
                  style={[styles.dateOption, isSelected && styles.dateOptionSelected]}
                  onPress={() => {
                    setScheduledDateKey(dateKey);
                    setScheduledTime("");
                  }}
                >
                  <Text style={[styles.dateOptionText, isSelected && styles.dateOptionTextSelected]}>
                    {getDateLabel(dateKey)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <View style={styles.timeGrid}>
            {scheduledSlots.map((time) => {
              const isSelected = scheduledTime === time;
              return (
                <Pressable
                  key={time}
                  style={[styles.timeOption, isSelected && styles.timeOptionSelected]}
                  onPress={() => setScheduledTime(time)}
                >
                  <Text style={[styles.timeOptionText, isSelected && styles.timeOptionTextSelected]}>{time}</Text>
                </Pressable>
              );
            })}
          </View>
          {!scheduledSlots.length && (
            <Text style={styles.couponError}>No hay horarios disponibles para ese dia.</Text>
          )}
        </>
      )}
    </View>
  );

  const renderExtrasOptions = () => {
    if (!activeExtras.length) return null;

    return (
      <View style={styles.optionBox}>
        <View style={styles.couponHeader}>
          <MaterialCommunityIcons name="plus-box-multiple-outline" size={19} color="#7f1d1d" />
          <Text style={styles.subsectionTitle}>Extras</Text>
        </View>
        <View style={styles.optionGrid}>
          {activeExtras.map((extra) => {
            const isSelected = !!selectedExtras[extra.id];
            return (
              <Pressable
                key={extra.id}
                style={[styles.extraOption, isSelected && styles.extraOptionSelected]}
                onPress={() => toggleExtra(extra.id)}
              >
                <Text style={[styles.extraName, isSelected && styles.extraNameSelected]}>{extra.name}</Text>
                <Text style={[styles.extraPrice, isSelected && styles.extraPriceSelected]}>
                  {Number(extra.price || 0) > 0 ? formatPrice(extra.price) : "Sin costo"}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    );
  };

  const renderMenuItem = ({ item }) => {
    const quantity = cart[item.id] || 0;

    return (
      <View style={styles.menuCard}>
        {item.imageUrl ? (
          <Image source={{ uri: item.imageUrl }} style={styles.dishImage} />
        ) : (
          <View style={styles.dishMark}>
            <MaterialCommunityIcons name="rice" size={25} color="#a11d21" />
          </View>
        )}
        <View style={styles.menuInfo}>
          <View style={styles.cardHeader}>
            <Text style={styles.itemName}>{item.name}</Text>
            <Text style={styles.itemPrice}>{formatPrice(item.price)}</Text>
          </View>
          {!!item.badge && <Text style={styles.itemBadge}>{item.badge}</Text>}
          {item.trackStock === true && (
            <Text style={styles.stockBadge}>Quedan {Number(item.stock || 0)}</Text>
          )}
          <Text style={styles.itemDescription}>{item.description}</Text>
          <View style={styles.quantityRow}>
            <Pressable
              accessibilityLabel={`Quitar ${item.name}`}
              style={[styles.iconButton, quantity === 0 && styles.iconButtonDisabled]}
              onPress={() => updateQuantity(item.id, -1)}
              disabled={quantity === 0}
            >
              <MaterialCommunityIcons name="minus" size={20} color={quantity === 0 ? "#a8a29e" : "#7f1d1d"} />
            </Pressable>
            <Text style={styles.quantityValue}>{quantity}</Text>
            <Pressable
              accessibilityLabel={`Agregar ${item.name}`}
              style={styles.iconButton}
              onPress={() => updateQuantity(item.id, 1)}
            >
              <MaterialCommunityIcons name="plus" size={20} color="#7f1d1d" />
            </Pressable>
          </View>
        </View>
      </View>
    );
  };

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safeArea} edges={["top", "left", "right"]}>
        <StatusBar style="dark" />
        <KeyboardAvoidingView
          behavior={Platform.select({ ios: "padding", android: undefined })}
          style={styles.screen}
        >
          <ScrollView
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
            refreshControl={<RefreshControl refreshing={isLoading} onRefresh={loadMenu} tintColor="#7f1d1d" />}
          >
            {renderConfigNotice()}

            <View style={styles.hero}>
              <View style={styles.heroCopy}>
                <Text style={styles.kicker}>Chifa Dragon Rojo</Text>
                <Text style={styles.title}>Pide tu chifa favorito</Text>
                <Text style={styles.subtitle}>Carta en la nube, pedido directo para cocina y atencion mas rapida.</Text>
              </View>
              <View style={styles.cartPill}>
                <MaterialCommunityIcons name="shopping-outline" size={20} color="#fff" />
                <Text style={styles.cartPillText}>{itemCount}</Text>
              </View>
            </View>

            {renderCustomerAccess()}
            {renderBusinessStatus()}
            {renderOrderTracker()}
            {renderOrderHistory()}

            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.categoryList}>
              {categories.map((category) => {
                const isSelected = selectedCategory === category;
                return (
                  <Pressable
                    key={category}
                    style={[styles.categoryChip, isSelected && styles.categoryChipSelected]}
                    onPress={() => setSelectedCategory(category)}
                  >
                    <Text style={[styles.categoryText, isSelected && styles.categoryTextSelected]}>{category}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>

            {visibleItems.length ? (
              <FlatList
                data={visibleItems}
                renderItem={renderMenuItem}
                keyExtractor={(item) => item.id}
                scrollEnabled={false}
                ItemSeparatorComponent={() => <View style={styles.separator} />}
              />
            ) : (
              <View style={styles.emptyCart}>
                <MaterialCommunityIcons name="silverware-clean" size={28} color="#a8a29e" />
                <Text style={styles.emptyText}>No hay platos activos todavia.</Text>
              </View>
            )}

            <View style={styles.orderPanel}>
              <View style={styles.panelHeader}>
                <Text style={styles.sectionTitle}>Tu pedido</Text>
                <Text style={styles.sectionMeta}>{itemCount} items</Text>
              </View>

              {cartItems.length === 0 ? (
                <View style={styles.emptyCart}>
                  <MaterialCommunityIcons name="cart-outline" size={28} color="#a8a29e" />
                  <Text style={styles.emptyText}>Agrega platos para ver el resumen.</Text>
                </View>
              ) : (
                cartItems.map((item) => (
                  <View key={item.id} style={styles.cartLine}>
                    <View style={styles.cartLineInfo}>
                      <Text style={styles.cartLineName}>
                        {item.quantity} x {item.name}
                      </Text>
                      <Text style={styles.cartLinePrice}>{formatPrice(item.price * item.quantity)}</Text>
                    </View>
                    <View style={styles.cartControls}>
                      <Pressable style={styles.smallIconButton} onPress={() => updateQuantity(item.id, -1)}>
                        <MaterialCommunityIcons name="minus" size={16} color="#7f1d1d" />
                      </Pressable>
                      <Pressable style={styles.smallIconButton} onPress={() => updateQuantity(item.id, 1)}>
                        <MaterialCommunityIcons name="plus" size={16} color="#7f1d1d" />
                      </Pressable>
                    </View>
                  </View>
                ))
              )}

              <View style={styles.segmented}>
                <Pressable
                  style={[styles.segment, orderType === "delivery" && styles.segmentSelected]}
                  onPress={() => setOrderType("delivery")}
                >
                  <MaterialCommunityIcons
                    name="moped-outline"
                    size={18}
                    color={orderType === "delivery" ? "#fff" : "#57534e"}
                  />
                  <Text style={[styles.segmentText, orderType === "delivery" && styles.segmentTextSelected]}>
                    Delivery
                  </Text>
                </Pressable>
                <Pressable
                  style={[styles.segment, orderType === "pickup" && styles.segmentSelected]}
                  onPress={() => setOrderType("pickup")}
                >
                  <MaterialCommunityIcons
                    name="storefront-outline"
                    size={18}
                    color={orderType === "pickup" ? "#fff" : "#57534e"}
                  />
                  <Text style={[styles.segmentText, orderType === "pickup" && styles.segmentTextSelected]}>
                    Recojo
                  </Text>
                </Pressable>
              </View>

              {renderDeliveryZones()}
              {renderFulfillmentOptions()}
              {renderExtrasOptions()}

              <View style={styles.formGrid}>
                <TextInput
                  placeholder="Nombre"
                  placeholderTextColor="#a8a29e"
                  value={customer.name}
                  onChangeText={(value) => updateCustomer("name", value)}
                  style={styles.input}
                />
                <TextInput
                  placeholder="Telefono"
                  placeholderTextColor="#a8a29e"
                  value={customer.phone}
                  onChangeText={(value) => updateCustomer("phone", value)}
                  keyboardType="phone-pad"
                  style={styles.input}
                />
                {orderType === "delivery" && (
                  <TextInput
                    placeholder="Direccion"
                    placeholderTextColor="#a8a29e"
                    value={customer.address}
                    onChangeText={(value) => updateCustomer("address", value)}
                    style={styles.input}
                  />
                )}
                <TextInput
                  placeholder="Notas para cocina"
                  placeholderTextColor="#a8a29e"
                  value={customer.notes}
                  onChangeText={(value) => updateCustomer("notes", value)}
                  style={[styles.input, styles.notesInput]}
                  multiline
                />
              </View>

              <View style={styles.couponBox}>
                <View style={styles.couponHeader}>
                  <MaterialCommunityIcons name="ticket-percent-outline" size={19} color="#7f1d1d" />
                  <Text style={styles.subsectionTitle}>Cupon</Text>
                </View>
                <View style={styles.couponRow}>
                  <TextInput
                    placeholder="CHIFA10"
                    placeholderTextColor="#a8a29e"
                    value={couponDraft}
                    onChangeText={(value) => setCouponDraft(value.toUpperCase())}
                    autoCapitalize="characters"
                    style={[styles.input, styles.couponInput]}
                  />
                  {appliedCouponCode ? (
                    <Pressable style={styles.clearCouponButton} onPress={clearCoupon}>
                      <MaterialCommunityIcons name="close" size={18} color="#7f1d1d" />
                    </Pressable>
                  ) : (
                    <Pressable style={styles.applyCouponButton} onPress={applyCoupon}>
                      <Text style={styles.applyCouponText}>Aplicar</Text>
                    </Pressable>
                  )}
                </View>
                {!!couponError && <Text style={styles.couponError}>{couponError}</Text>}
                {!!couponResult?.valid && (
                  <Text style={styles.couponSuccess}>
                    {couponResult.code}: {couponResult.label}
                  </Text>
                )}
              </View>

              <View style={styles.paymentBox}>
                <View style={styles.couponHeader}>
                  <MaterialCommunityIcons name="wallet-outline" size={19} color="#7f1d1d" />
                  <Text style={styles.subsectionTitle}>Pago</Text>
                </View>
                <View style={styles.paymentGrid}>
                  {PAYMENT_METHODS.map((method) => {
                    const isSelected = paymentMethod === method.id;
                    return (
                      <Pressable
                        key={method.id}
                        style={[styles.paymentOption, isSelected && styles.paymentOptionSelected]}
                        onPress={() => {
                          setPaymentMethod(method.id);
                          setPaymentReference("");
                        }}
                      >
                        <MaterialCommunityIcons
                          name={method.icon}
                          size={18}
                          color={isSelected ? "#fff" : "#57534e"}
                        />
                        <Text style={[styles.paymentOptionText, isSelected && styles.paymentOptionTextSelected]}>
                          {method.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
                <TextInput
                  placeholder={selectedPayment.placeholder}
                  placeholderTextColor="#a8a29e"
                  value={paymentReference}
                  onChangeText={setPaymentReference}
                  style={styles.input}
                />
              </View>

              <View style={styles.totals}>
                <View style={styles.totalLine}>
                  <Text style={styles.totalLabel}>Subtotal</Text>
                  <Text style={styles.totalValue}>{formatPrice(subtotal)}</Text>
                </View>
                {extrasTotal > 0 && (
                  <View style={styles.totalLine}>
                    <Text style={styles.totalLabel}>Extras</Text>
                    <Text style={styles.totalValue}>{formatPrice(extrasTotal)}</Text>
                  </View>
                )}
                <View style={styles.totalLine}>
                  <Text style={styles.totalLabel}>Delivery</Text>
                  <Text style={styles.totalValue}>{formatPrice(deliveryFee)}</Text>
                </View>
                {discount > 0 && (
                  <View style={styles.totalLine}>
                    <Text style={styles.discountLabel}>Descuento</Text>
                    <Text style={styles.discountValue}>- {formatPrice(discount)}</Text>
                  </View>
                )}
                <View style={styles.grandTotalLine}>
                  <Text style={styles.grandTotalLabel}>Total</Text>
                  <Text style={styles.grandTotalValue}>{formatPrice(total)}</Text>
                </View>
              </View>

              <Pressable
                style={[styles.submitButton, isSavingOrder && styles.buttonDisabled]}
                onPress={submitOrder}
                disabled={isSavingOrder}
              >
                <MaterialCommunityIcons name="shield-check-outline" size={22} color="#fff" />
                <Text style={styles.submitText}>{isSavingOrder ? "Enviando..." : "Confirmar pago y enviar"}</Text>
              </Pressable>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#fff7ed"
  },
  screen: {
    flex: 1
  },
  content: {
    padding: 20,
    paddingBottom: 40
  },
  flexItem: {
    flex: 1
  },
  errorBanner: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#fecaca",
    backgroundColor: "#fee2e2",
    padding: 12,
    marginBottom: 14,
    flexDirection: "row",
    gap: 9,
    alignItems: "center"
  },
  errorText: {
    flex: 1,
    color: "#991b1b",
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "700"
  },
  inlineError: {
    borderRadius: 8,
    backgroundColor: "#fee2e2",
    padding: 10,
    flexDirection: "row",
    gap: 8,
    alignItems: "center"
  },
  inlineErrorText: {
    flex: 1,
    color: "#991b1b",
    fontSize: 12,
    fontWeight: "800"
  },
  hero: {
    minHeight: 172,
    borderRadius: 8,
    backgroundColor: "#7f1d1d",
    padding: 22,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    overflow: "hidden"
  },
  heroCopy: {
    flex: 1,
    paddingRight: 16
  },
  kicker: {
    color: "#fed7aa",
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 0,
    marginBottom: 10,
    textTransform: "uppercase"
  },
  title: {
    color: "#fff",
    fontSize: 32,
    lineHeight: 38,
    fontWeight: "800",
    letterSpacing: 0
  },
  subtitle: {
    color: "#ffedd5",
    fontSize: 15,
    lineHeight: 22,
    marginTop: 10,
    maxWidth: 270
  },
  cartPill: {
    width: 54,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#16a34a",
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 5
  },
  cartPillText: {
    color: "#fff",
    fontWeight: "800",
    fontSize: 14
  },
  accountCard: {
    marginTop: 14,
    borderRadius: 8,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#fed7aa",
    padding: 16,
    gap: 10
  },
  statusNotice: {
    marginTop: 14,
    borderRadius: 8,
    borderWidth: 1,
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 9
  },
  statusNoticeOpen: {
    backgroundColor: "#f0fdf4",
    borderColor: "#bbf7d0"
  },
  statusNoticeClosed: {
    backgroundColor: "#fef3c7",
    borderColor: "#fed7aa"
  },
  statusNoticeText: {
    flex: 1,
    fontSize: 13,
    fontWeight: "900"
  },
  statusNoticeTextOpen: {
    color: "#166534"
  },
  statusNoticeTextClosed: {
    color: "#92400e"
  },
  accountHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12
  },
  authSwitch: {
    backgroundColor: "#f5f5f4",
    borderRadius: 8,
    padding: 4,
    flexDirection: "row",
    gap: 4
  },
  authToggle: {
    flex: 1,
    minHeight: 40,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 7
  },
  authToggleSelected: {
    backgroundColor: "#111827"
  },
  authToggleText: {
    color: "#57534e",
    fontWeight: "900",
    fontSize: 13
  },
  authToggleTextSelected: {
    color: "#fff"
  },
  accountButton: {
    minHeight: 46,
    borderRadius: 8,
    backgroundColor: "#16a34a",
    alignItems: "center",
    justifyContent: "center"
  },
  accountButtonText: {
    color: "#fff",
    fontWeight: "900",
    fontSize: 15
  },
  iconOnlyButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 1,
    borderColor: "#fecaca",
    backgroundColor: "#fff7ed",
    alignItems: "center",
    justifyContent: "center"
  },
  historyPanel: {
    marginTop: 14,
    borderRadius: 8,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#fed7aa",
    padding: 16
  },
  historyItem: {
    borderTopWidth: 1,
    borderTopColor: "#f5f5f4",
    paddingTop: 12,
    marginTop: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12
  },
  historyTitle: {
    color: "#1c1917",
    fontSize: 15,
    fontWeight: "900"
  },
  repeatButton: {
    minHeight: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#fed7aa",
    backgroundColor: "#fff7ed",
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 6
  },
  repeatButtonText: {
    color: "#7f1d1d",
    fontSize: 12,
    fontWeight: "900"
  },
  categoryList: {
    gap: 10,
    paddingVertical: 18
  },
  categoryChip: {
    height: 40,
    paddingHorizontal: 15,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#fed7aa",
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center"
  },
  categoryChipSelected: {
    backgroundColor: "#111827",
    borderColor: "#111827"
  },
  categoryText: {
    color: "#57534e",
    fontWeight: "700",
    fontSize: 14
  },
  categoryTextSelected: {
    color: "#fff"
  },
  separator: {
    height: 12
  },
  menuCard: {
    borderRadius: 8,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#fed7aa",
    padding: 14,
    flexDirection: "row",
    gap: 12
  },
  dishMark: {
    width: 48,
    height: 48,
    borderRadius: 8,
    backgroundColor: "#fee2e2",
    alignItems: "center",
    justifyContent: "center"
  },
  dishImage: {
    width: 72,
    height: 72,
    borderRadius: 8,
    backgroundColor: "#fee2e2"
  },
  menuInfo: {
    flex: 1
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 12
  },
  itemName: {
    flex: 1,
    color: "#1c1917",
    fontSize: 16,
    lineHeight: 21,
    fontWeight: "800"
  },
  itemPrice: {
    color: "#a11d21",
    fontSize: 15,
    fontWeight: "800"
  },
  itemBadge: {
    alignSelf: "flex-start",
    color: "#b45309",
    backgroundColor: "#fef3c7",
    fontSize: 12,
    fontWeight: "800",
    marginTop: 7,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    overflow: "hidden"
  },
  stockBadge: {
    alignSelf: "flex-start",
    color: "#166534",
    backgroundColor: "#dcfce7",
    fontSize: 12,
    fontWeight: "900",
    marginTop: 7,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    overflow: "hidden"
  },
  itemDescription: {
    color: "#57534e",
    fontSize: 14,
    lineHeight: 20,
    marginTop: 8
  },
  quantityRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    marginTop: 12
  },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#fecaca",
    backgroundColor: "#fff7ed",
    alignItems: "center",
    justifyContent: "center"
  },
  iconButtonDisabled: {
    borderColor: "#e7e5e4",
    backgroundColor: "#f5f5f4"
  },
  quantityValue: {
    minWidth: 18,
    textAlign: "center",
    color: "#1c1917",
    fontWeight: "800",
    fontSize: 16
  },
  orderPanel: {
    marginTop: 18,
    borderRadius: 8,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#fed7aa",
    padding: 16
  },
  trackerCard: {
    marginTop: 14,
    borderRadius: 8,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#fed7aa",
    padding: 16
  },
  trackerCardCanceled: {
    borderColor: "#fecaca",
    backgroundColor: "#fff1f2"
  },
  canceledText: {
    color: "#991b1b",
    fontSize: 13,
    fontWeight: "900",
    marginTop: 3
  },
  cancelOrderButton: {
    minHeight: 42,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#fecaca",
    backgroundColor: "#fee2e2",
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 7,
    marginTop: 14
  },
  cancelOrderText: {
    color: "#991b1b",
    fontSize: 13,
    fontWeight: "900"
  },
  trackerTotal: {
    color: "#a11d21",
    fontSize: 18,
    fontWeight: "900"
  },
  trackerSteps: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 8,
    marginTop: 8
  },
  trackerStep: {
    flex: 1,
    alignItems: "center",
    gap: 7
  },
  trackerDot: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "#f5f5f4",
    borderWidth: 1,
    borderColor: "#e7e5e4",
    alignItems: "center",
    justifyContent: "center"
  },
  trackerDotActive: {
    backgroundColor: "#16a34a",
    borderColor: "#16a34a"
  },
  trackerLabel: {
    color: "#78716c",
    fontSize: 11,
    lineHeight: 14,
    textAlign: "center",
    fontWeight: "800"
  },
  trackerLabelActive: {
    color: "#1c1917"
  },
  panelHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
    gap: 12
  },
  sectionTitle: {
    color: "#1c1917",
    fontSize: 20,
    fontWeight: "800"
  },
  sectionMeta: {
    color: "#78716c",
    fontSize: 13,
    fontWeight: "700"
  },
  subsectionTitle: {
    color: "#292524",
    fontSize: 15,
    fontWeight: "900"
  },
  emptyCart: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#e7e5e4",
    backgroundColor: "#fafaf9",
    padding: 18,
    alignItems: "center",
    gap: 8
  },
  emptyText: {
    color: "#78716c",
    fontSize: 14,
    textAlign: "center"
  },
  cartLine: {
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#f5f5f4",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10
  },
  cartLineInfo: {
    flex: 1
  },
  cartLineName: {
    color: "#292524",
    fontSize: 14,
    lineHeight: 19,
    fontWeight: "700"
  },
  cartLinePrice: {
    color: "#78716c",
    marginTop: 2,
    fontSize: 13
  },
  cartControls: {
    flexDirection: "row",
    gap: 8
  },
  smallIconButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "#fff7ed",
    borderWidth: 1,
    borderColor: "#fed7aa",
    alignItems: "center",
    justifyContent: "center"
  },
  segmented: {
    backgroundColor: "#f5f5f4",
    borderRadius: 8,
    padding: 4,
    flexDirection: "row",
    marginTop: 16,
    marginBottom: 16,
    gap: 4
  },
  segment: {
    flex: 1,
    minHeight: 42,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 7,
    paddingHorizontal: 6
  },
  segmentSelected: {
    backgroundColor: "#1f2937"
  },
  segmentText: {
    color: "#57534e",
    fontWeight: "800",
    fontSize: 14
  },
  segmentTextSelected: {
    color: "#fff"
  },
  formGrid: {
    gap: 10,
    marginTop: 14
  },
  optionBox: {
    marginTop: 16,
    borderTopWidth: 1,
    borderTopColor: "#f5f5f4",
    paddingTop: 14,
    gap: 10
  },
  optionGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  },
  deliveryZoneOption: {
    minWidth: "47%",
    flexGrow: 1,
    minHeight: 58,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#e7e5e4",
    backgroundColor: "#fafaf9",
    padding: 10,
    justifyContent: "center"
  },
  deliveryZoneOptionSelected: {
    backgroundColor: "#111827",
    borderColor: "#111827"
  },
  deliveryZoneName: {
    color: "#292524",
    fontSize: 13,
    fontWeight: "900"
  },
  deliveryZoneNameSelected: {
    color: "#fff"
  },
  deliveryZoneFee: {
    color: "#78716c",
    fontSize: 12,
    fontWeight: "800",
    marginTop: 3
  },
  deliveryZoneFeeSelected: {
    color: "#d1d5db"
  },
  segmentedCompact: {
    backgroundColor: "#f5f5f4",
    borderRadius: 8,
    padding: 4,
    flexDirection: "row",
    gap: 4
  },
  segmentCompact: {
    flex: 1,
    minHeight: 38,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 8
  },
  segmentDisabled: {
    opacity: 0.45
  },
  dateOption: {
    minHeight: 38,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#e7e5e4",
    backgroundColor: "#fff",
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center"
  },
  dateOptionSelected: {
    backgroundColor: "#111827",
    borderColor: "#111827"
  },
  dateOptionText: {
    color: "#57534e",
    fontSize: 13,
    fontWeight: "900"
  },
  dateOptionTextSelected: {
    color: "#fff"
  },
  timeGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  },
  timeOption: {
    minHeight: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#fed7aa",
    backgroundColor: "#fff7ed",
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center"
  },
  timeOptionSelected: {
    backgroundColor: "#16a34a",
    borderColor: "#16a34a"
  },
  timeOptionText: {
    color: "#7f1d1d",
    fontSize: 12,
    fontWeight: "900"
  },
  timeOptionTextSelected: {
    color: "#fff"
  },
  extraOption: {
    minWidth: "47%",
    flexGrow: 1,
    minHeight: 58,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#e7e5e4",
    backgroundColor: "#fafaf9",
    padding: 10,
    justifyContent: "center"
  },
  extraOptionSelected: {
    backgroundColor: "#111827",
    borderColor: "#111827"
  },
  extraName: {
    color: "#292524",
    fontSize: 13,
    fontWeight: "900"
  },
  extraNameSelected: {
    color: "#fff"
  },
  extraPrice: {
    color: "#78716c",
    fontSize: 12,
    fontWeight: "800",
    marginTop: 3
  },
  extraPriceSelected: {
    color: "#d1d5db"
  },
  input: {
    minHeight: 48,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#e7e5e4",
    backgroundColor: "#fff",
    color: "#1c1917",
    paddingHorizontal: 12,
    fontSize: 15
  },
  notesInput: {
    minHeight: 82,
    paddingTop: 12,
    textAlignVertical: "top"
  },
  couponBox: {
    marginTop: 16,
    borderTopWidth: 1,
    borderTopColor: "#f5f5f4",
    paddingTop: 14,
    gap: 10
  },
  couponHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8
  },
  couponRow: {
    flexDirection: "row",
    gap: 8
  },
  couponInput: {
    flex: 1
  },
  applyCouponButton: {
    minWidth: 92,
    borderRadius: 8,
    backgroundColor: "#111827",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12
  },
  applyCouponText: {
    color: "#fff",
    fontWeight: "900",
    fontSize: 13
  },
  clearCouponButton: {
    width: 48,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#fecaca",
    backgroundColor: "#fff7ed",
    alignItems: "center",
    justifyContent: "center"
  },
  couponError: {
    color: "#991b1b",
    fontSize: 12,
    fontWeight: "800"
  },
  couponSuccess: {
    color: "#166534",
    fontSize: 12,
    fontWeight: "900"
  },
  paymentBox: {
    marginTop: 16,
    borderTopWidth: 1,
    borderTopColor: "#f5f5f4",
    paddingTop: 14,
    gap: 10
  },
  paymentGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  },
  paymentOption: {
    minHeight: 40,
    minWidth: "47%",
    flexGrow: 1,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#e7e5e4",
    backgroundColor: "#fafaf9",
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 7,
    paddingHorizontal: 10
  },
  paymentOptionSelected: {
    backgroundColor: "#111827",
    borderColor: "#111827"
  },
  paymentOptionText: {
    color: "#57534e",
    fontSize: 12,
    fontWeight: "900"
  },
  paymentOptionTextSelected: {
    color: "#fff"
  },
  totals: {
    marginTop: 16,
    borderTopWidth: 1,
    borderTopColor: "#e7e5e4",
    paddingTop: 12,
    gap: 8
  },
  totalLine: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12
  },
  totalLabel: {
    color: "#78716c",
    fontSize: 14,
    fontWeight: "700"
  },
  totalValue: {
    color: "#292524",
    fontSize: 14,
    fontWeight: "800"
  },
  discountLabel: {
    color: "#166534",
    fontSize: 14,
    fontWeight: "800"
  },
  discountValue: {
    color: "#166534",
    fontSize: 14,
    fontWeight: "900"
  },
  grandTotalLine: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 4
  },
  grandTotalLabel: {
    color: "#1c1917",
    fontSize: 18,
    fontWeight: "900"
  },
  grandTotalValue: {
    color: "#a11d21",
    fontSize: 20,
    fontWeight: "900"
  },
  submitButton: {
    minHeight: 52,
    borderRadius: 8,
    backgroundColor: "#16a34a",
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 9,
    marginTop: 16,
    paddingHorizontal: 12
  },
  buttonDisabled: {
    opacity: 0.7
  },
  submitText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "900"
  }
});
