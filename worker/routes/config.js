import { requiereAdmin, jsonError, json, leerJson, texto } from "../auth/middleware.js";
import { mapProducto, mapCategoria, uuid } from "../database/mappers.js";

export async function handleConfig(request, env, url) {
  const method = request.method;
  const partes = url.pathname.split("/").filter(Boolean);
  const clave = partes[2];

  if (method === "GET" && (clave === "general" || clave === "envios")) {
    const row = await env.DB.prepare("SELECT valor FROM configuracion WHERE clave = ?").bind(clave).first();
    let valor = {};
    try { valor = row ? JSON.parse(row.valor) : {}; } catch (_) { valor = {}; }
    if (clave === "envios") {
      const { results: zonas } = await env.DB.prepare("SELECT * FROM envio_zonas ORDER BY orden ASC").all();
      const { results: provincias } = await env.DB.prepare("SELECT * FROM envio_provincias").all();
      valor.zonas = zonas.map((z) => ({
        id: z.id, nombre: z.nombre, precio: z.precio,
        provincias: provincias.filter((p) => p.zona_id === z.id).map((p) => p.provincia)
      }));
    }
    return json({ [clave]: valor });
  }

  if (method === "PUT" && clave === "general") {
    await requiereAdmin(request, env);
    const b = await leerJson(request, 16 * 1024);
    // Lista blanca de campos: antes se guardaba el body entero tal cual, así
    // que cualquier basura extra terminaba en la config pública del catálogo.
    const limpio = {
      nombreTienda: texto(b.nombreTienda, 60),
      bannerUrl: texto(b.bannerUrl, 500),
      bannerTitulo: texto(b.bannerTitulo, 120),
      bannerSubtitulo: texto(b.bannerSubtitulo, 200),
      whatsappNumero: texto(b.whatsappNumero, 20),
      envioGratisDesde: Math.max(0, Number(b.envioGratisDesde) || 0),
      aliasCbu: texto(b.aliasCbu, 60),
      notificarPedidoNuevo: b.notificarPedidoNuevo !== false,
      emailContacto: texto(b.emailContacto, 120),
      direccionContacto: texto(b.direccionContacto, 200),
      ubicacionLat: b.ubicacionLat === null || b.ubicacionLat === undefined ? null : Number(b.ubicacionLat),
      ubicacionLng: b.ubicacionLng === null || b.ubicacionLng === undefined ? null : Number(b.ubicacionLng)
    };
    await env.DB.prepare("INSERT INTO configuracion (clave, valor) VALUES ('general', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor")
      .bind(JSON.stringify(limpio)).run();
    await invalidarCacheCatalogo();
    return json({ ok: true });
  }

  if (method === "PUT" && clave === "envios") {
    await requiereAdmin(request, env);
    const b = await leerJson(request, 32 * 1024);
    const zonas = Array.isArray(b.zonas) ? b.zonas.slice(0, 30) : [];

    const statements = [
      env.DB.prepare("INSERT INTO configuracion (clave, valor) VALUES ('envios', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor")
        .bind(JSON.stringify({
          adicionalPorArticuloExtra: Math.max(0, Number(b.adicionalPorArticuloExtra) || 0),
          envioGratisDesde: Math.max(0, Number(b.envioGratisDesde) || 0)
        })),
      env.DB.prepare("DELETE FROM envio_provincias"),
      env.DB.prepare("DELETE FROM envio_zonas")
    ];
    zonas.forEach((z, idx) => {
      const nombre = texto(z && z.nombre, 60);
      if (!nombre) return;
      const zid = texto(z.id, 60) || uuid();
      statements.push(env.DB.prepare("INSERT INTO envio_zonas (id, nombre, precio, orden) VALUES (?, ?, ?, ?)")
        .bind(zid, nombre, Math.max(0, Number(z.precio) || 0), idx));
      (Array.isArray(z.provincias) ? z.provincias.slice(0, 30) : []).forEach((prov) => {
        const p = texto(prov, 60);
        if (p) statements.push(env.DB.prepare("INSERT INTO envio_provincias (provincia, zona_id) VALUES (?, ?)").bind(p, zid));
      });
    });
    await env.DB.batch(statements);
    await invalidarCacheCatalogo();
    return json({ ok: true });
  }

  return jsonError("No encontrado", 404);
}

/** GET /api/catalogo — productos activos + categorías + config + envíos,
 *  cacheado al edge. */
export async function handleCatalogo(request, env, ctx) {
  if (request.method !== "GET") return jsonError("Método no permitido", 405);

  const cache = caches.default;
  // Clave fija, sin arrastrar headers del pedido original: así la respuesta
  // cacheada no puede quedar atada a la sesión de nadie.
  const cacheKey = new Request("https://cotato-cache/catalogo");
  const cacheado = await cache.match(cacheKey);
  if (cacheado) return cacheado;

  const [productosR, categoriasR, cfgGeneralR, cfgEnviosR, zonasR, provinciasR] = await Promise.all([
    env.DB.prepare("SELECT * FROM productos WHERE activo = 1 ORDER BY fecha_publicacion DESC").all(),
    env.DB.prepare("SELECT * FROM categorias ORDER BY orden ASC").all(),
    env.DB.prepare("SELECT valor FROM configuracion WHERE clave='general'").first(),
    env.DB.prepare("SELECT valor FROM configuracion WHERE clave='envios'").first(),
    env.DB.prepare("SELECT * FROM envio_zonas ORDER BY orden ASC").all(),
    env.DB.prepare("SELECT * FROM envio_provincias").all()
  ]);

  let envios = {};
  try { envios = cfgEnviosR ? JSON.parse(cfgEnviosR.valor) : {}; } catch (_) { envios = {}; }
  envios.zonas = zonasR.results.map((z) => ({
    id: z.id, nombre: z.nombre, precio: z.precio,
    provincias: provinciasR.results.filter((p) => p.zona_id === z.id).map((p) => p.provincia)
  }));

  let config = {};
  try { config = cfgGeneralR ? JSON.parse(cfgGeneralR.valor) : {}; } catch (_) { config = {}; }

  const body = {
    productos: productosR.results.map(mapProducto),
    categorias: categoriasR.results.map(mapCategoria),
    config,
    envios
  };

  const response = new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=30" }
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

export async function invalidarCacheCatalogo() {
  const cache = caches.default;
  await cache.delete(new Request("https://cotato-cache/catalogo"));
}
