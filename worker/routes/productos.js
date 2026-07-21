import { requiereAdmin, jsonError, json, leerJson, texto } from "../auth/middleware.js";
import { mapProducto, uuid } from "../database/mappers.js";
import { invalidarCacheCatalogo } from "./config.js";

const MAX_IMAGENES = 12;

/** Normaliza y valida el body de un producto. Antes, un PUT sin "nombre"
 *  reventaba con 500 (b.nombre.trim() sobre undefined). */
function normalizarProducto(b) {
  const nombre = texto(b.nombre, 140);
  const categoria = texto(b.categoria, 80);
  if (!nombre) return { error: "El nombre del producto es obligatorio" };
  if (!categoria) return { error: "La categoría es obligatoria" };

  let imagenes = Array.isArray(b.imagenes) ? b.imagenes : [];
  imagenes = imagenes.slice(0, MAX_IMAGENES).map((u) => texto(u, 500)).filter(Boolean);

  return {
    nombre,
    descripcion: texto(b.descripcion, 4000),
    categoria,
    marca: texto(b.marca, 80),
    precio: Math.max(0, Number(b.precio) || 0),
    stock: Math.max(0, Math.floor(Number(b.stock) || 0)),
    enOferta: b.enOferta ? 1 : 0,
    porcentajeDescuento: Math.min(100, Math.max(0, Number(b.porcentajeDescuento) || 0)),
    activo: b.activo === false ? 0 : 1,
    imagenes: JSON.stringify(imagenes)
  };
}

export async function handleProductos(request, env, url) {
  const method = request.method;
  const partes = url.pathname.split("/").filter(Boolean);
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

  // ---- OBTENER UNO ---------------------------------------------------------
  // El público solo ve productos activos; el admin (con ?admin=1) ve todos,
  // así el panel puede seguir abriendo borradores para editarlos.
  if (method === "GET" && id) {
    const esAdminReq = url.searchParams.get("admin") === "1";
    if (esAdminReq) await requiereAdmin(request, env);
    const row = esAdminReq
      ? await env.DB.prepare("SELECT * FROM productos WHERE id = ?").bind(id).first()
      : await env.DB.prepare("SELECT * FROM productos WHERE id = ? AND activo = 1").bind(id).first();
    if (!row) return jsonError("Producto no encontrado", 404);
    return json({ producto: mapProducto(row) });
  }

  // ---- CREAR (admin) -------------------------------------------------------
  if (method === "POST" && !id) {
    await requiereAdmin(request, env);
    const b = await leerJson(request, 32 * 1024);
    const p = normalizarProducto(b);
    if (p.error) return jsonError(p.error, 400);

    const nuevoId = uuid();
    await env.DB.prepare(
      `INSERT INTO productos (id, nombre, descripcion, categoria, marca, precio, stock, en_oferta, porcentaje_descuento, activo, imagenes, cantidad_vendida)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    ).bind(nuevoId, p.nombre, p.descripcion, p.categoria, p.marca, p.precio, p.stock, p.enOferta, p.porcentajeDescuento, p.activo, p.imagenes).run();

    const row = await env.DB.prepare("SELECT * FROM productos WHERE id = ?").bind(nuevoId).first();
    await invalidarCacheCatalogo();
    return json({ producto: mapProducto(row) }, 201);
  }

  // ---- ACTUALIZAR (admin) --------------------------------------------------
  if (method === "PUT" && id) {
    await requiereAdmin(request, env);
    const b = await leerJson(request, 32 * 1024);
    const p = normalizarProducto(b);
    if (p.error) return jsonError(p.error, 400);

    const existe = await env.DB.prepare("SELECT id FROM productos WHERE id = ?").bind(id).first();
    if (!existe) return jsonError("Producto no encontrado", 404);

    await env.DB.prepare(
      `UPDATE productos SET nombre=?, descripcion=?, categoria=?, marca=?, precio=?, stock=?, en_oferta=?, porcentaje_descuento=?, activo=?, imagenes=?
       WHERE id=?`
    ).bind(p.nombre, p.descripcion, p.categoria, p.marca, p.precio, p.stock, p.enOferta, p.porcentajeDescuento, p.activo, p.imagenes, id).run();

    const row = await env.DB.prepare("SELECT * FROM productos WHERE id = ?").bind(id).first();
    await invalidarCacheCatalogo();
    return json({ producto: mapProducto(row) });
  }

  // ---- BORRAR (admin) ------------------------------------------------------
  if (method === "DELETE" && id) {
    await requiereAdmin(request, env);
    await env.DB.prepare("DELETE FROM productos WHERE id = ?").bind(id).run();
    await invalidarCacheCatalogo();
    return json({ ok: true });
  }

  return jsonError("No encontrado", 404);
}
