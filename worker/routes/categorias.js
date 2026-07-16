import { requiereAdmin, jsonError, json } from "../auth/middleware.js";
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
    const { nombre } = await request.json();
    if (!nombre || !nombre.trim()) return jsonError("El nombre es obligatorio", 400);
    const existente = await env.DB.prepare("SELECT * FROM categorias WHERE lower(nombre) = lower(?)").bind(nombre.trim()).first();
    if (existente) return json({ categoria: mapCategoria(existente) }, 200);
    const { maxOrden } = await env.DB.prepare("SELECT COALESCE(MAX(orden),0) as maxOrden FROM categorias").first();
    const nuevoId = uuid();
    await env.DB.prepare("INSERT INTO categorias (id, nombre, orden) VALUES (?, ?, ?)").bind(nuevoId, nombre.trim(), maxOrden + 1).run();
    const row = await env.DB.prepare("SELECT * FROM categorias WHERE id = ?").bind(nuevoId).first();
    await invalidarCacheCatalogo();
    return json({ categoria: mapCategoria(row) }, 201);
  }

  if (method === "PUT" && id) {
    await requiereAdmin(request, env);
    const b = await request.json();
    await env.DB.prepare("UPDATE categorias SET nombre = ?, orden = ? WHERE id = ?").bind(b.nombre.trim(), Number(b.orden) || 0, id).run();
    const row = await env.DB.prepare("SELECT * FROM categorias WHERE id = ?").bind(id).first();
    if (!row) return jsonError("Categoría no encontrada", 404);
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
