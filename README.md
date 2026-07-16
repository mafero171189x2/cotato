# COTATO — Migración de Firebase a Cloudflare

Arquitectura nueva: **Cloudflare Pages** (frontend) + **Cloudflare Workers** (API)
+ **Cloudflare D1** (base de datos SQL) + **Cloudinary** (imágenes, sin cambios).

```
/
├── index.html          → frontend (subir a Pages)
├── schema.sql           → estructura de la base D1
├── wrangler.toml        → config del Worker
└── worker/
    ├── index.js          → router principal
    ├── auth/             → JWT, hash de passwords, middleware
    ├── database/         → mappers y cálculo de envíos
    └── routes/           → productos, categorías, pedidos, clientes, config, auth
```

## 0) Requisitos

```bash
npm install -g wrangler
wrangler login
```

## 1) Crear la base D1

```bash
wrangler d1 create cotato-db
```

Esto imprime un `database_id`. Copialo dentro de `wrangler.toml`, en
`database_id = "..."`.

## 2) Cargar el schema

```bash
wrangler d1 execute cotato-db --remote --file=./schema.sql
```

Esto crea todas las tablas y carga las zonas de envío + un producto/categoría
de ejemplo (borralos desde el panel admin cuando tengas los tuyos).

## 3) Crear el primer admin

No hay un endpoint público para crear admins (por seguridad). Generá el hash
localmente y ejecutalo contra D1:

```bash
node worker/auth/crear-admin.mjs tu-email@tutienda.com "unaPasswordSegura123"
```

Copiá el `INSERT INTO admins (...)` que imprime y ejecutalo:

```bash
wrangler d1 execute cotato-db --remote --command "INSERT INTO admins (...) VALUES (...);"
```

## 4) Configurar el secreto JWT

```bash
wrangler secret put JWT_SECRET
```

Pegá cualquier string largo y random (ej. generado con `openssl rand -hex 32`).

## 5) Desplegar el Worker

```bash
wrangler deploy
```

Te va a dar una URL tipo `https://cotato-api.tu-usuario.workers.dev`.
Copiala en `index.html`, buscá `const API_URL` y reemplazá
`TU-SUBDOMINIO` por la tuya.

En `wrangler.toml`, actualizá también `CORS_ORIGIN` con el dominio real donde
vas a alojar el frontend (el de Pages o tu dominio propio) — sin esto,
las cookies de sesión no van a viajar correctamente entre el sitio y la API.

## 6) Subir el frontend a Cloudflare Pages

Con GitHub como repo principal (como pediste), lo más simple:

1. Empujá este repo (con el `index.html` ya editado) a GitHub.
2. En el dashboard de Cloudflare → **Workers & Pages** → **Create** → **Pages**
   → **Connect to Git** → elegí el repo.
3. Build command: (vacío — es un solo HTML estático).
4. Build output directory: `/` (o donde quede el `index.html`).
5. Deploy.

Cada push a `main` va a redeployar solo. Tu DNS ya está en Cloudflare, así que
podés apuntar tu dominio propio al proyecto de Pages desde la misma pantalla
("Custom domains").

## 7) Probar la migración

- Entrá al sitio → la tienda debería cargar el producto de ejemplo.
- Anda a `/#/cuenta`, registrate como cliente, armá un pedido de prueba.
- Con el admin que creaste en el paso 3, entrá a `/#/admin` y confirmá que
  ves el pedido, podés cambiar categorías/productos, y que el contador de
  "pendientes" se actualiza.
- Revisá que las imágenes sigan subiendo bien (Cloudinary no cambió).

## Notas de arquitectura

- **Cache de borde**: `/api/catalogo` se cachea 30s con la Cache API de
  Cloudflare y se invalida automáticamente en cada escritura de productos,
  categorías o configuración — no hace falta "republicar" nada a mano.
- **Seguridad**: precio y stock SIEMPRE se verifican en el Worker antes de
  crear un pedido (nunca se confía en lo que mande el navegador). El
  descuento/devolución de stock es atómico (`D1 .batch()`).
- **Sesión**: cookie httpOnly con JWT firmado (HMAC-SHA256), 30 días. No hay
  reCAPTCHA ni rate-limiting propio todavía — para producción con tráfico
  real, conviene activar el **WAF / Rate Limiting** de Cloudflare sobre las
  rutas `/api/auth/*` y `/api/pedidos` (Security → WAF en el dashboard).
- **Emails**: `solicitar-reset` genera el token pero no envía el mail (no hay
  proveedor de correo integrado). Para conectarlo, sumá un `fetch()` a
  Resend/Mailgun/Postmark dentro de `worker/routes/auth.js`.
- **Storage muerto eliminado**: el `firebase-storage` que importaba el
  original nunca se usaba (las imágenes ya subían a Cloudinary) — no hay
  nada que migrar ahí.
