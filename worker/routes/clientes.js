import { requiereCliente, requiereAdmin, jsonError, json } from "../auth/middleware.js";
import { mapCliente } from "../database/mappers.js";

export async function handleClientes(request, env, url) {
  const method = request.method;
  const partes = url.pathname.split("/").filter(Boolean); // ["api","clientes", ":id"?]
  const seg2 = partes[2]; // "yo" | "carrito" | ":id" | undefined

  // ---- LISTAR (admin) -------------------------------------------------
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

  // ---- ELIMINAR MI PROPIA CUENTA (cliente logueado) ---------------------
  // Mismo criterio que cuando lo hace un admin: los pedidos ya hechos NO se
  // borran (quedan con los datos de ese momento guardados aparte), solo se
  // borra la cuenta y el carrito.
  if (method === "DELETE" && url.pathname === "/api/clientes/yo") {
    const sesion = await requiereCliente(request, env);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM carritos WHERE cliente_id = ?").bind(sesion.uid),
      env.DB.prepare("DELETE FROM clientes WHERE id = ?").bind(sesion.uid)
    ]);
    return json({ ok: true });
  }

  // ---- ELIMINAR CUENTA (admin) -----------------------------------------
  // Los pedidos ya hechos por este cliente NO se borran ni se rompen: el
  // nombre/teléfono/dirección de cada pedido quedan guardados aparte (una
  // "foto" de esos datos al momento de comprar), así que el historial de
  // ventas se conserva intacto aunque la cuenta del cliente ya no exista.
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
