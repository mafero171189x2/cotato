import { requiereAdmin, jsonError, json } from "../auth/middleware.js";
import { mapProducto, mapCategoria, uuid } from "../database/mappers.js";

export async function handleConfig(request, env, url) {
  const method = request.method;
  const partes = url.pathname.split("/").filter(Boolean); // ["api","config", "general"|"envios"]
  const clave = partes[2];

  if (method === "GET" && (clave === "general" || clave === "envios")) {
    const row = await env.DB.prepare("SELECT valor FROM configuracion WHERE clave = ?").bind(clave).first();
    const valor = row ? JSON.parse(row.valor) : {};
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
    const b = await request.json();
    await env.DB.prepare("INSERT INTO configuracion (clave, valor) VALUES ('general', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor")
      .bind(JSON.stringify(b)).run();
    await invalidarCacheCatalogo();
    return json({ ok: true });
  }

  if (method === "PUT" && clave === "envios") {
    await requiereAdmin(request, env);
    const b = await request.json(); // { adicionalPorArticuloExtra, envioGratisDesde, zonas: [{id,nombre,precio,provincias:[]}] }
    const statements = [
      env.DB.prepare("INSERT INTO configuracion (clave, valor) VALUES ('envios', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor")
        .bind(JSON.stringify({ adicionalPorArticuloExtra: b.adicionalPorArticuloExtra, envioGratisDesde: b.envioGratisDesde })),
      env.DB.prepare("DELETE FROM envio_provincias"),
      env.DB.prepare("DELETE FROM envio_zonas")
    ];
    (b.zonas || []).forEach((z, idx) => {
      const zid = z.id || uuid();
      statements.push(env.DB.prepare("INSERT INTO envio_zonas (id, nombre, precio, orden) VALUES (?, ?, ?, ?)").bind(zid, z.nombre, Number(z.precio) || 0, idx));
      (z.provincias || []).forEach((prov) => {
        statements.push(env.DB.prepare("INSERT INTO envio_provincias (provincia, zona_id) VALUES (?, ?)").bind(prov, zid));
      });
    });
    await env.DB.batch(statements);
    await invalidarCacheCatalogo();
    return json({ ok: true });
  }

  return jsonError("No encontrado", 404);
}

/** GET /api/catalogo — combina productos activos + categorías + config + envíos
 *  en una sola respuesta, cacheada al edge (reemplaza el snapshot "publico/catalogo"
 *  que se usaba en Firestore para ahorrar cuota; acá el objetivo es ahorrar
 *  latencia/lecturas a D1 en picos de tráfico). */
export async function handleCatalogo(request, env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request("https://cotato-cache/catalogo", request);
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

  const envios = cfgEnviosR ? JSON.parse(cfgEnviosR.valor) : {};
  envios.zonas = zonasR.results.map((z) => ({
    id: z.id, nombre: z.nombre, precio: z.precio,
    provincias: provinciasR.results.filter((p) => p.zona_id === z.id).map((p) => p.provincia)
  }));

  const body = {
    productos: productosR.results.map(mapProducto),
    categorias: categoriasR.results.map(mapCategoria),
    config: cfgGeneralR ? JSON.parse(cfgGeneralR.valor) : {},
    envios
  };

  const response = new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=30" }
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

/** Invalida la cache del catálogo. Llamar después de cualquier cambio en
 *  productos, categorías o configuración desde el panel admin. */
export async function invalidarCacheCatalogo() {
  const cache = caches.default;
  await cache.delete(new Request("https://cotato-cache/catalogo"));
}
