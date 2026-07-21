import { requiereCliente, requiereAdmin, jsonError, json, leerJson, texto } from "../auth/middleware.js";
import { mapCliente } from "../database/mappers.js";

const MAX_ITEMS_CARRITO = 100;

export async function handleClientes(request, env, url) {
  const method = request.method;
  const partes = url.pathname.split("/").filter(Boolean); // ["api","clientes", ":id"?]
  const seg2 = partes[2];

  // ---- LISTAR (admin) ------------------------------------------------------
  if (method === "GET" && !seg2) {
    await requiereAdmin(request, env);
    const { results } = await env.DB.prepare(
      "SELECT id, email, nombre, telefono, provincia, fecha_registro FROM clientes ORDER BY fecha_registro DESC"
    ).all();
    return json({ clientes: results });
  }

  if (method === "GET" && url.pathname === "/api/clientes/yo") {
    const sesion = await requiereCliente(request, env);
    const row = await env.DB.prepare("SELECT * FROM clientes WHERE id = ?").bind(sesion.uid).first();
    if (!row) return jsonError("No encontrado", 404);
    return json({ cliente: mapCliente(row) });
  }

  if (method === "PUT" && url.pathname === "/api/clientes/yo") {
    const sesion = await requiereCliente(request, env);
    const b = await leerJson(request, 8192);
    await env.DB.prepare(
      `UPDATE clientes SET nombre=?, telefono=?, direccion=?, entre_calles=?, ciudad=?, provincia=?, codigo_postal=? WHERE id=?`
    ).bind(
      texto(b.nombre, 80), texto(b.telefono, 30), texto(b.direccion, 160),
      texto(b.entreCalles, 120), texto(b.ciudad, 80), texto(b.provincia, 60), texto(b.codigoPostal, 12),
      sesion.uid
    ).run();
    const row = await env.DB.prepare("SELECT * FROM clientes WHERE id = ?").bind(sesion.uid).first();
    return json({ cliente: mapCliente(row) });
  }

  // ---- CARRITO SINCRONIZADO ------------------------------------------------
  if (method === "GET" && url.pathname === "/api/clientes/carrito") {
    const sesion = await requiereCliente(request, env);
    const row = await env.DB.prepare("SELECT items FROM carritos WHERE cliente_id = ?").bind(sesion.uid).first();
    let items = [];
    try { items = row ? JSON.parse(row.items) : []; } catch (_) { items = []; }
    return json({ items });
  }

  if (method === "PUT" && url.pathname === "/api/clientes/carrito") {
    const sesion = await requiereCliente(request, env);
    const { items } = await leerJson(request, 32 * 1024);
    if (!Array.isArray(items)) return jsonError("Carrito inválido", 400);
    if (items.length > MAX_ITEMS_CARRITO) return jsonError("El carrito tiene demasiados productos", 400);
    // Se guarda solo lo necesario: sin esto se podía almacenar cualquier cosa
    // de cualquier tamaño en la base con solo estar logueado.
    const limpios = items.map((i) => ({
      productoId: texto(i && i.productoId, 60),
      cantidad: Math.max(1, Math.min(999, Number(i && i.cantidad) || 1))
    })).filter((i) => i.productoId);
    await env.DB.prepare(
      `INSERT INTO carritos (cliente_id, items, fecha) VALUES (?, ?, datetime('now'))
       ON CONFLICT(cliente_id) DO UPDATE SET items = excluded.items, fecha = excluded.fecha`
    ).bind(sesion.uid, JSON.stringify(limpios)).run();
    return json({ ok: true });
  }

  // ---- ELIMINAR MI PROPIA CUENTA -------------------------------------------
  if (method === "DELETE" && url.pathname === "/api/clientes/yo") {
    const sesion = await requiereCliente(request, env);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM carritos WHERE cliente_id = ?").bind(sesion.uid),
      env.DB.prepare("DELETE FROM clientes WHERE id = ?").bind(sesion.uid)
    ]);
    return json({ ok: true });
  }

  // ---- ELIMINAR CUENTA (admin) ---------------------------------------------
  if (method === "DELETE" && seg2 && seg2 !== "yo" && seg2 !== "carrito") {
    await requiereAdmin(request, env);
    const cliente = await env.DB.prepare("SELECT id FROM clientes WHERE id = ?").bind(seg2).first();
    if (!cliente) return jsonError("Cliente no encontrado", 404);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM carritos WHERE cliente_id = ?").bind(seg2),
      env.DB.prepare("DELETE FROM clientes WHERE id = ?").bind(seg2)
    ]);
    return json({ ok: true });
  }

  return jsonError("No encontrado", 404);
}
