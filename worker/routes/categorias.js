import { requiereAdmin, jsonError, json, leerJson, texto } from "../auth/middleware.js";
import { mapCategoria, uuid } from "../database/mappers.js";
import { invalidarCacheCatalogo } from "./config.js";

export async function handleCategorias(request, env, url) {
  const method = request.method;
  const partes = url.pathname.split("/").filter(Boolean);
  const id = partes[2];

  if (method === "GET" && !id) {
    const { results } = await env.DB.prepare("SELECT * FROM categorias ORDER BY orden ASC").all();
    return json({ categorias: results.map(mapCategoria) });
  }

  if (method === "POST" && !id) {
    await requiereAdmin(request, env);
    const b = await leerJson(request, 4096);
    const nombre = texto(b.nombre, 80);
    if (!nombre) return jsonError("El nombre es obligatorio", 400);

    const existente = await env.DB.prepare("SELECT * FROM categorias WHERE lower(nombre) = lower(?)").bind(nombre).first();
    if (existente) return json({ categoria: mapCategoria(existente) }, 200);

    const { maxOrden } = await env.DB.prepare("SELECT COALESCE(MAX(orden),0) as maxOrden FROM categorias").first();
    const nuevoId = uuid();
    await env.DB.prepare("INSERT INTO categorias (id, nombre, orden) VALUES (?, ?, ?)").bind(nuevoId, nombre, maxOrden + 1).run();
    const row = await env.DB.prepare("SELECT * FROM categorias WHERE id = ?").bind(nuevoId).first();
    await invalidarCacheCatalogo();
    return json({ categoria: mapCategoria(row) }, 201);
  }

  if (method === "PUT" && id) {
    await requiereAdmin(request, env);
    const b = await leerJson(request, 4096);
    const nombre = texto(b.nombre, 80);
    if (!nombre) return jsonError("El nombre es obligatorio", 400);

    const existe = await env.DB.prepare("SELECT id FROM categorias WHERE id = ?").bind(id).first();
    if (!existe) return jsonError("Categoría no encontrada", 404);

    await env.DB.prepare("UPDATE categorias SET nombre = ?, orden = ? WHERE id = ?")
      .bind(nombre, Math.max(0, Math.floor(Number(b.orden) || 0)), id).run();
    const row = await env.DB.prepare("SELECT * FROM categorias WHERE id = ?").bind(id).first();
    await invalidarCacheCatalogo();
    return json({ categoria: mapCategoria(row) });
  }

  if (method === "DELETE" && id) {
    await requiereAdmin(request, env);
    await env.DB.prepare("DELETE FROM categorias WHERE id = ?").bind(id).run();
    await invalidarCacheCatalogo();
    return json({ ok: true });
  }

  return jsonError("No encontrado", 404);
}
