import { requiereAdmin, jsonError, json } from "../auth/middleware.js";
import { mapProducto, uuid } from "../database/mappers.js";
import { invalidarCacheCatalogo } from "./config.js";

export async function handleProductos(request, env, url) {
  const method = request.method;
  const partes = url.pathname.split("/").filter(Boolean); // ["api","productos", ":id"?]
  const id = partes[2];

  // ---- LISTAR (público: solo activos) o (admin: todos con ?admin=1) --------
  if (method === "GET" && !id) {
    const esAdminReq = url.searchParams.get("admin") === "1";
    if (esAdminReq) await requiereAdmin(request, env);
    const { results } = esAdminReq
      ? await env.DB.prepare("SELECT * FROM productos ORDER BY fecha_publicacion DESC").all()
      : await env.DB.prepare("SELECT * FROM productos WHERE activo = 1 ORDER BY fecha_publicacion DESC LIMIT 300").all();
    return json({ productos: results.map(mapProducto) });
  }

  // ---- OBTENER UNO (para revalidar precio/stock en el checkout) ------------
  if (method === "GET" && id) {
    const row = await env.DB.prepare("SELECT * FROM productos WHERE id = ?").bind(id).first();
    if (!row) return jsonError("Producto no encontrado", 404);
    return json({ producto: mapProducto(row) });
  }

  // ---- CREAR (admin) ---------------------------------------------------
  if (method === "POST" && !id) {
    await requiereAdmin(request, env);
    const b = await request.json();
    if (!b.nombre || !b.categoria) return jsonError("Nombre y categoría son obligatorios", 400);
    const nuevoId = uuid();
    await env.DB.prepare(
      `INSERT INTO productos (id, nombre, descripcion, categoria, marca, precio, stock, en_oferta, porcentaje_descuento, activo, imagenes, cantidad_vendida)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    ).bind(
      nuevoId, b.nombre.trim(), (b.descripcion || "").trim(), b.categoria, (b.marca || "").trim(),
      Number(b.precio) || 0, Number(b.stock) || 0, b.enOferta ? 1 : 0, Number(b.porcentajeDescuento) || 0,
      b.activo === false ? 0 : 1, JSON.stringify(b.imagenes || [])
    ).run();
    const row = await env.DB.prepare("SELECT * FROM productos WHERE id = ?").bind(nuevoId).first();
    await invalidarCacheCatalogo();
    return json({ producto: mapProducto(row) }, 201);
  }

  // ---- ACTUALIZAR (admin) ------------------------------------------------
  if (method === "PUT" && id) {
    await requiereAdmin(request, env);
    const b = await request.json();
    await env.DB.prepare(
      `UPDATE productos SET nombre=?, descripcion=?, categoria=?, marca=?, precio=?, stock=?, en_oferta=?, porcentaje_descuento=?, activo=?, imagenes=?
       WHERE id=?`
    ).bind(
      b.nombre.trim(), (b.descripcion || "").trim(), b.categoria, (b.marca || "").trim(),
      Number(b.precio) || 0, Number(b.stock) || 0, b.enOferta ? 1 : 0, Number(b.porcentajeDescuento) || 0,
      b.activo === false ? 0 : 1, JSON.stringify(b.imagenes || []), id
    ).run();
    const row = await env.DB.prepare("SELECT * FROM productos WHERE id = ?").bind(id).first();
    if (!row) return jsonError("Producto no encontrado", 404);
    await invalidarCacheCatalogo();
    return json({ producto: mapProducto(row) });
  }

  // ---- BORRAR (admin) -----------------------------------------------------
  if (method === "DELETE" && id) {
    await requiereAdmin(request, env);
    await env.DB.prepare("DELETE FROM productos WHERE id = ?").bind(id).run();
    await invalidarCacheCatalogo();
    return json({ ok: true });
  }

  return jsonError("No encontrado", 404);
}
