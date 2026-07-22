-- ============================================================================
-- COTATO — Schema Cloudflare D1
-- Migración desde Firestore. Ejecutar con:
--   wrangler d1 execute cotato-db --file=./schema.sql --remote
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- CATEGORIAS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS categorias (
  id      TEXT PRIMARY KEY,                 -- uuid generado en el Worker
  nombre  TEXT NOT NULL UNIQUE,
  orden   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_categorias_orden ON categorias(orden);

-- ---------------------------------------------------------------------------
-- PRODUCTOS
-- La categoría se guarda como TEXTO (igual que en Firestore original, no FK)
-- porque el front permite crear categorías "al vuelo" al cargar un producto.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS productos (
  id                  TEXT PRIMARY KEY,
  nombre              TEXT NOT NULL,
  descripcion         TEXT NOT NULL DEFAULT '',
  categoria           TEXT NOT NULL DEFAULT '',
  marca               TEXT NOT NULL DEFAULT '',
  precio              REAL NOT NULL DEFAULT 0,
  stock               INTEGER NOT NULL DEFAULT 0,
  en_oferta           INTEGER NOT NULL DEFAULT 0,        -- boolean 0/1
  porcentaje_descuento REAL NOT NULL DEFAULT 0,
  activo              INTEGER NOT NULL DEFAULT 1,        -- boolean 0/1
  -- Muestra en la tienda "Precio con transferencia" debajo del precio.
  precio_transferencia INTEGER NOT NULL DEFAULT 1,       -- boolean 0/1
  imagenes            TEXT NOT NULL DEFAULT '[]',        -- JSON array de URLs (Cloudinary)
  cantidad_vendida    INTEGER NOT NULL DEFAULT 0,
  fecha_publicacion   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_productos_activo ON productos(activo);
CREATE INDEX IF NOT EXISTS idx_productos_categoria ON productos(categoria);
CREATE INDEX IF NOT EXISTS idx_productos_fecha ON productos(fecha_publicacion DESC);

-- ---------------------------------------------------------------------------
-- CLIENTES
-- Reemplaza Firebase Auth (usuarios) + colección "clientes".
-- password_hash: PBKDF2/scrypt vía WebCrypto en el Worker (ver worker/auth).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clientes (
  id              TEXT PRIMARY KEY,                 -- uuid, reemplaza el uid de Firebase
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  nombre          TEXT NOT NULL DEFAULT '',
  telefono        TEXT NOT NULL DEFAULT '',
  direccion       TEXT NOT NULL DEFAULT '',
  entre_calles    TEXT NOT NULL DEFAULT '',
  ciudad          TEXT NOT NULL DEFAULT '',
  provincia       TEXT NOT NULL DEFAULT '',
  codigo_postal   TEXT NOT NULL DEFAULT '',
  fecha_registro  TEXT NOT NULL DEFAULT (datetime('now')),
  reset_token     TEXT,                              -- token temporal p/ recuperar contraseña
  reset_token_exp TEXT,
  -- Se incrementa al cambiar la contraseña o cerrar sesión: invalida todos
  -- los JWT emitidos antes (el token guarda este número como "tv").
  token_version   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_clientes_email ON clientes(email);

-- ---------------------------------------------------------------------------
-- CARRITOS — sincronización del carrito entre dispositivos para clientes logueados
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS carritos (
  cliente_id TEXT PRIMARY KEY REFERENCES clientes(id) ON DELETE CASCADE,
  items      TEXT NOT NULL DEFAULT '[]',   -- JSON
  fecha      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- ADMINS
-- Reemplaza colección "admins/{uid}". Login separado del de clientes.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admins (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  creado        TEXT NOT NULL DEFAULT (datetime('now')),
  reset_token     TEXT,
  reset_token_exp TEXT,
  token_version   INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- INTENTOS — rate limiting de login / registro / recuperación de contraseña.
-- La clave combina endpoint + IP (+ email según el caso). Ver worker/auth/ratelimit.js
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS intentos (
  clave           TEXT PRIMARY KEY,
  intentos        INTEGER NOT NULL DEFAULT 0,
  bloqueado_hasta TEXT,
  ultimo          TEXT
);

-- ---------------------------------------------------------------------------
-- PEDIDOS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pedidos (
  id                TEXT PRIMARY KEY,
  numero_pedido     TEXT NOT NULL UNIQUE,
  cliente_id        TEXT NOT NULL REFERENCES clientes(id),
  cliente_nombre    TEXT NOT NULL,
  cliente_telefono  TEXT NOT NULL DEFAULT '',
  direccion         TEXT NOT NULL DEFAULT '',
  entre_calles      TEXT NOT NULL DEFAULT '',
  ciudad            TEXT NOT NULL DEFAULT '',
  provincia         TEXT NOT NULL DEFAULT '',
  codigo_postal     TEXT NOT NULL DEFAULT '',
  notas             TEXT NOT NULL DEFAULT '',
  total             REAL NOT NULL DEFAULT 0,
  envio             REAL NOT NULL DEFAULT 0,
  zona_envio        TEXT NOT NULL DEFAULT '',
  estado            TEXT NOT NULL DEFAULT 'pendiente', -- pendiente|pagado|preparacion|enviado|entregado|cancelado
  stock_devuelto    INTEGER NOT NULL DEFAULT 0,
  mensaje_whatsapp  TEXT NOT NULL DEFAULT '',
  fecha             TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pedidos_cliente ON pedidos(cliente_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_estado ON pedidos(estado);
CREATE INDEX IF NOT EXISTS idx_pedidos_fecha ON pedidos(fecha DESC);

-- Ítems del pedido (reemplaza el array "productos" + mapa "cantidades" de Firestore)
CREATE TABLE IF NOT EXISTS pedido_items (
  id            TEXT PRIMARY KEY,
  pedido_id     TEXT NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  producto_id   TEXT NOT NULL REFERENCES productos(id),
  nombre        TEXT NOT NULL,           -- snapshot del nombre al momento de la compra
  precio        REAL NOT NULL,           -- snapshot del precio al momento de la compra
  cantidad      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pedido_items_pedido ON pedido_items(pedido_id);
CREATE INDEX IF NOT EXISTS idx_pedido_items_producto ON pedido_items(producto_id);

-- ---------------------------------------------------------------------------
-- CONFIGURACION — key/value, reemplaza configuracion/general y configuracion/envios
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS configuracion (
  clave TEXT PRIMARY KEY,   -- 'general' | 'envios'
  valor TEXT NOT NULL       -- JSON
);

-- Envíos: zonas normalizadas en tablas propias (más prolijo que JSON anidado,
-- pero se puede consultar como un solo bloque igual que antes).
CREATE TABLE IF NOT EXISTS envio_zonas (
  id      TEXT PRIMARY KEY,
  nombre  TEXT NOT NULL,
  precio  REAL NOT NULL DEFAULT 0,
  orden   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS envio_provincias (
  provincia TEXT PRIMARY KEY,
  zona_id   TEXT NOT NULL REFERENCES envio_zonas(id) ON DELETE CASCADE
);

-- ============================================================================
-- DATOS INICIALES
-- ============================================================================

INSERT OR IGNORE INTO configuracion (clave, valor) VALUES
('general', '{"nombreTienda":"COTATO","whatsappNumero":"","envioGratisDesde":50000,"bannerTitulo":"Nueva colección","bannerSubtitulo":"Envío gratis en compras mayores a $50.000","aliasCbu":""}'),
('envios', '{"adicionalPorArticuloExtra":2000,"envioGratisDesde":0}');

INSERT OR IGNORE INTO envio_zonas (id, nombre, precio, orden) VALUES
('z1','CABA y GBA',6000,1),
('z2','Centro',8000,2),
('z3','Norte',10000,3),
('z4','Patagonia',13000,4);

INSERT OR IGNORE INTO envio_provincias (provincia, zona_id) VALUES
('Ciudad Autónoma de Buenos Aires','z1'),('Buenos Aires','z1'),
('Córdoba','z2'),('Santa Fe','z2'),('Entre Ríos','z2'),('La Pampa','z2'),('San Luis','z2'),('Mendoza','z2'),
('Catamarca','z3'),('Chaco','z3'),('Corrientes','z3'),('Formosa','z3'),('Jujuy','z3'),('La Rioja','z3'),
('Misiones','z3'),('Salta','z3'),('San Juan','z3'),('Santiago del Estero','z3'),('Tucumán','z3'),
('Chubut','z4'),('Neuquén','z4'),('Río Negro','z4'),('Santa Cruz','z4'),('Tierra del Fuego','z4');

-- Categoría de ejemplo (borrar/editar desde el panel admin)
INSERT OR IGNORE INTO categorias (id, nombre, orden) VALUES ('cat-demo-1', 'Bolsos', 1);

-- Producto de ejemplo (borrar/editar desde el panel admin)
INSERT OR IGNORE INTO productos (id, nombre, descripcion, categoria, marca, precio, stock, activo, imagenes)
VALUES ('prod-demo-1', 'Bolso ejemplo', 'Producto de prueba — reemplazá o borrá desde el panel', 'Bolsos', 'COTATO', 15000, 5, 1, '[]');

-- IMPORTANTE: el admin inicial NO se crea acá con password en texto plano.
-- Se crea con el script worker/auth/crear-admin.js (ver README paso 6).
