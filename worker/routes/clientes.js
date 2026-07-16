import { requiereCliente, jsonError, json } from "../auth/middleware.js";
import { mapCliente } from "../database/mappers.js";

export async function handleClientes(request, env, url) {
  const method = request.method;

  if (method === "GET" && url.pathname === "/api/clientes/yo") {
    const sesion = await requiereCliente(request, env);
    const row = await env.DB.prepare("SELECT * FROM clientes WHERE id = ?").bind(sesion.uid).first();
    if (!row) return jsonError("No encontrado", 404);
    return json({ cliente: mapCliente(row) });
  }

  if (method === "PUT" && url.pathname === "/api/clientes/yo") {
    const sesion = await requiereCliente(request, env);
    const b = await request.json();
    await env.DB.prepare(
      `UPDATE clientes SET nombre=?, telefono=?, direccion=?, entre_calles=?, ciudad=?, provincia=?, codigo_postal=? WHERE id=?`
    ).bind(b.nombre || "", b.telefono || "", b.direccion || "", b.entreCalles || "", b.ciudad || "", b.provincia || "", b.codigoPostal || "", sesion.uid).run();
    const row = await env.DB.prepare("SELECT * FROM clientes WHERE id = ?").bind(sesion.uid).first();
    return json({ cliente: mapCliente(row) });
  }

  // ---- CARRITO SINCRONIZADO -------------------------------------------
  if (method === "GET" && url.pathname === "/api/clientes/carrito") {
    const sesion = await requiereCliente(request, env);
    const row = await env.DB.prepare("SELECT items FROM carritos WHERE cliente_id = ?").bind(sesion.uid).first();
    return json({ items: row ? JSON.parse(row.items) : [] });
  }
  if (method === "PUT" && url.pathname === "/api/clientes/carrito") {
    const sesion = await requiereCliente(request, env);
    const { items } = await request.json();
    await env.DB.prepare(
      `INSERT INTO carritos (cliente_id, items, fecha) VALUES (?, ?, datetime('now'))
       ON CONFLICT(cliente_id) DO UPDATE SET items = excluded.items, fecha = excluded.fecha`
    ).bind(sesion.uid, JSON.stringify(items || [])).run();
    return json({ ok: true });
  }

  return jsonError("No encontrado", 404);
}
