# App Chifa

App React Native con Expo para clientes de chifa. Usa Firebase Firestore como backend en la nube y tiene un panel admin web separado con login.

## Requisitos

- Node.js 20 o superior
- Xcode instalado en macOS
- Un simulador de iPhone disponible

## Comandos

Instala dependencias:

```sh
npm install
```

Ejecuta la app cliente en iPhone Simulator:

```sh
npm run dev:ios
```

Ejecuta el panel admin web:

```sh
npm run admin
```

El admin abre en `http://127.0.0.1:5173`.

## Firebase

1. Crea un proyecto en Firebase.
2. Activa Firestore Database.
3. Activa Firebase Storage.
4. Activa Authentication con estos proveedores:
   - Email/Password para el admin.
   - Anonymous para que cada cliente pueda seguir su propio pedido.
5. Crea un usuario admin en Authentication.
6. Copia el UID de ese usuario y crea en Firestore un documento:

```txt
adminUsers/{UID_DEL_ADMIN}
```

Puede tener un campo simple, por ejemplo:

```json
{ "role": "owner" }
```

7. Copia `.env.example` a `.env` y completa las claves Firebase.
8. Publica las reglas de Firestore y Storage:

```sh
npm run deploy:rules
```

Para push notifications en builds reales, agrega tambien `EXPO_PUBLIC_EAS_PROJECT_ID` en `.env` o coloca tu projectId EAS en `app.json`.

## Primer Uso

1. Abre el panel admin con `npm run admin`.
2. Inicia sesion con el usuario admin creado en Firebase Auth.
3. En la pestana `Carta`, presiona `Cargar carta inicial`.
4. Edita cada plato para subir su foto desde el panel admin.
5. Abre la app cliente con `npm run dev:ios`.
6. Crea un pedido desde el simulador.
7. Vuelve al admin para ver el pedido y cambiar su estado.
8. La app cliente mostrara el avance en vivo: recibido, preparando, enviado, entregado.

## Clientes, Pagos y Promociones

- Los clientes pueden crear cuenta o iniciar sesion con correo y contrasena.
- Cada cliente ve sus pedidos anteriores y puede usar `Repetir` para cargar el carrito otra vez.
- Los pedidos guardan metodo de pago, referencia y estado de verificacion para el admin.
- El panel admin permite marcar el pago como verificado o rechazado.
- Cupones disponibles:
  - `CHIFA10`: 10% desde S/ 20.00.
  - `COMBO5`: S/ 5.00 menos desde S/ 45.00.
  - `DELIVERY0`: delivery gratis desde S/ 35.00.
  - `HAPPYCHIFA`: 15% de 12:00 a 15:00 desde S/ 30.00.
- Yape, Plin, Mercado Pago y tarjeta quedan registrados por referencia de pago. Para cobro automatico real con tarjeta o Mercado Pago se necesita backend seguro con credenciales del comercio.

## Operacion Del Negocio

- El panel admin tiene una pestana `Ajustes` para configurar horario de atencion, pedidos programados, zonas de delivery y tiempo estimado base.
- Si el chifa esta cerrado, el cliente no puede pedir `Ahora`; debe elegir un horario programado disponible.
- Las zonas de delivery activas aparecen en la app cliente y cambian el costo de reparto. Las zonas inactivas funcionan como fuera de zona.
- Cada pedido guarda `fulfillment` con entrega inmediata o programada, hora elegida y tiempo estimado.
- En el panel admin, cada pedido tiene botones de tiempo estimado: 10, 20, 30, 45 y 60 minutos. El cliente lo ve en vivo.
- El panel admin tiene boton `Activar sonido`; al entrar un pedido nuevo emite una alerta sonora mientras el panel este abierto.

## Personal, Cocina, Reparto E Inventario

- Los roles se controlan en Firestore con `adminUsers/{uid}.role`.
- Roles disponibles:
  - `owner`: ve pedidos, cocina, reparto, carta y ajustes.
  - `cashier`: ve pedidos y reparto.
  - `kitchen`: ve solo la vista cocina.
  - `driver`: ve solo reparto.
- La vista `Cocina` muestra pedidos grandes sin precios ni pago, con botones `Preparando`, `Listo` e `Imprimir`.
- La vista `Reparto` muestra pedidos delivery listos, direccion, telefono y botones `En camino`, `Entregado` e `Imprimir`.
- La carta permite activar `Controlar stock` por plato. Al pasar un pedido de `Recibido` a `Preparando`, se descuenta stock; si llega a 0, el plato queda fuera de la app cliente.
- En `Ajustes` puedes editar extras/ingredientes globales como arroz adicional, wantan extra o sin cebolla china.
- El cliente puede agregar extras al pedido y se guardan como parte de la comanda.

## Reportes, Exportacion Y Cancelaciones

- La pestana `Reportes` muestra ventas por dia, platos mas vendidos, ventas por zona, cupones usados, metodos de pago y rendimiento por horario.
- Desde `Reportes` puedes descargar CSV de pedidos, ventas por plato y productos/carta.
- Los pedidos cancelados no suman como venta en reportes.
- El cliente puede cancelar mientras el pedido siga en `Recibido`.
- El admin puede cancelar pedidos con motivo: pago no valido, sin stock, direccion fuera de zona, cliente cancelo u otro motivo.
- El estado `Cancelado` queda guardado con `cancellation.reason` para historial y reportes.

## Notificaciones

- El panel admin puede mostrar notificaciones del navegador cuando entra un pedido nuevo. Usa el boton `Activar notificaciones`.
- El cliente recibe push cuando el admin cambia el estado del pedido, si el celular concedio permiso de notificaciones.
- En iPhone Simulator normalmente no hay push real; el seguimiento en vivo si funciona. Para probar push usa un dispositivo fisico o un build EAS.

## Scripts Utiles

```sh
npm run dev:ios      # app cliente en iPhone Simulator
npm run admin        # panel admin web
npm run admin:build  # compila el admin web
npm run deploy:rules # despliega reglas de Firestore
```

## Estructura

- `App.js`: app movil solo para clientes.
- `admin/`: panel web separado para el negocio.
- `src/firebase.js`: conexion Firebase para Expo.
- `admin/src/firebase.js`: conexion Firebase para admin web.
- `firestore.rules`: reglas de seguridad.
- `storage.rules`: reglas para fotos de platos en Firebase Storage.
- `shared/menu.mjs`: carta inicial para sembrar Firestore.

## Configuracion rapida

- El cliente ya no ve el panel admin.
- El dueno gestiona pedidos y carta desde el panel web.
- Los pedidos se guardan en Firestore, no en `server/db.json`.
- Las fotos se suben desde el admin a Firebase Storage y se muestran en la app cliente.
- El cliente ve el estado de su ultimo pedido en tiempo real.
- `server/` queda como backend local legacy, pero el flujo principal ahora usa Firebase.
- Los assets de icono/splash se regeneran con:

```sh
node scripts/create-assets.mjs
```
