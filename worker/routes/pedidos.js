import { requiereCliente, requiereAdmin, jsonError, json } from "../auth/middleware.js";
import { mapPedido, uuid } from "../database/mappers.js";
import { calcularEnvio } from "../database/envios.js";
import { enviarEmailEstadoPedido, enviarEmailNuevoPedidoAdmin } from "../auth/mailer.js";

function generarNumeroPedido() {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}-${Math.floor(Math.random() * 9000 + 1000)}`;
}

export async function handlePedidos(request, env, url) {
  const method = request.method;
  const partes = url.pathname.split("/").filter(Boolean); // ["api","pedidos", ":id"?, "accion"?]
  const id = partes[2];
  const accion = partes[3];

  // ---- CHECKOUT: crea el pedido + descuenta stock, todo o nada -------------
  if (method === "POST" && !id) {
    const sesion = await requiereCliente(request, env);
    const body = await request.json();
    const { items, cliente: datosCliente } = body;
    if (!Array.isArray(items) || !items.length) return jsonError("El carrito está vacío", 400);
    if (!datosCliente?.nombre || !datosCliente?.direccion || !datosCliente?.provincia) {
      return jsonError("Faltan datos de envío", 400);
    }

    // Releer productos DESDE LA BASE (nunca confiar en precio/stock del cliente)
    const ids = items.map((i) => i.productoId);
    const placeholders = ids.map(() => "?").join(",");
    const { results: frescos } = await env.DB.prepare(`SELECT * FROM productos WHERE id IN (${placeholders})`).bind(...ids).all();
    const porId = Object.fromEntries(frescos.map((p) => [p.id, p]));

    const itemsVerificados = [];
    for (const it of items) {
      const p = porId[it.productoId];
      if (!p || !p.activo) return jsonError(`El producto "${it.nombre || it.productoId}" ya no está disponible`, 409);
      if (p.stock < it.cantidad) return jsonError(`No hay stock suficiente de "${p.nombre}" (quedan ${p.stock})`, 409);
      itemsVerificados.push({ productoId: p.id, nombre: p.nombre, precio: p.precio, cantidad: Number(it.cantidad) || 1 });
    }
    const total = itemsVerificados.reduce((a, i) => a + i.precio * i.cantidad, 0);
    const totalArticulos = itemsVerificados.reduce((a, i) => a + i.cantidad, 0);

    const rEnvio = await calcularEnvio(env, datosCliente.provincia, totalArticulos, total);
    if (!rEnvio.ok) return jsonError(rEnvio.motivo, 400);

    const numeroPedido = generarNumeroPedido();
    const pedidoId = uuid();
    const lista = itemsVerificados.map((i) => `• ${i.cantidad}x ${i.nombre} - $${(i.precio * i.cantidad).toLocaleString("es-AR")}`).join("\n");
    const direccionCompleta = `${datosCliente.direccion}${datosCliente.entreCalles ? " (" + datosCliente.entreCalles + ")" : ""}, ${datosCliente.ciudad}, ${datosCliente.provincia} — CP ${datosCliente.codigoPostal}`;
    const cfgGeneral = await env.DB.prepare("SELECT valor FROM configuracion WHERE clave='general'").first();
    const aliasCbu = cfgGeneral ? (JSON.parse(cfgGeneral.valor).aliasCbu || "") : "";
    const lineaAlias = aliasCbu ? `\n\nPara transferir: ${aliasCbu}` : "";
    const mensajeWhatsapp = `¡Hola! Quiero confirmar mi pedido N° ${numeroPedido}.\n\nCliente: ${datosCliente.nombre}\nDirección: ${direccionCompleta}\n\nProductos:\n${lista}\n\nSubtotal: $${total.toLocaleString("es-AR")}\nEnvío (${rEnvio.zonaNombre}): $${rEnvio.costo.toLocaleString("es-AR")}\nTOTAL: $${(total + rEnvio.costo).toLocaleString("es-AR")}${lineaAlias}\n\nYa transfiero y te mando el comprobante.`;

    // Batch atómico: inserta pedido + items + descuenta stock. D1 .batch()
    // ejecuta todo en una transacción: si algo falla, no se aplica nada.
    const statements = [
      env.DB.prepare(
        `INSERT INTO pedidos (id, numero_pedido, cliente_id, cliente_nombre, cliente_telefono, direccion, entre_calles, ciudad, provincia, codigo_postal, notas, total, envio, zona_envio, estado, stock_devuelto, mensaje_whatsapp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendiente', 0, ?)`
      ).bind(
        pedidoId, numeroPedido, sesion.uid, datosCliente.nombre, datosCliente.telefono || "",
        datosCliente.direccion, datosCliente.entreCalles || "", datosCliente.ciudad || "",
        datosCliente.provincia, datosCliente.codigoPostal || "", datosCliente.notas || "",
        total, rEnvio.costo, rEnvio.zonaNombre, mensajeWhatsapp
      ),
      ...itemsVerificados.map((i) =>
        env.DB.prepare(`INSERT INTO pedido_items (id, pedido_id, producto_id, nombre, precio, cantidad) VALUES (?, ?, ?, ?, ?, ?)`)
          .bind(uuid(), pedidoId, i.productoId, i.nombre, i.precio, i.cantidad)
      ),
      ...itemsVerificados.map((i) =>
        env.DB.prepare(`UPDATE productos SET stock = stock - ?, cantidad_vendida = cantidad_vendida + ? WHERE id = ? AND stock >= ?`)
          .bind(i.cantidad, i.cantidad, i.productoId, i.cantidad)
      ),
      env.DB.prepare(
        `UPDATE clientes SET nombre=?, telefono=?, direccion=?, entre_calles=?, ciudad=?, provincia=?, codigo_postal=? WHERE id=?`
      ).bind(datosCliente.nombre, datosCliente.telefono || "", datosCliente.direccion, datosCliente.entreCalles || "",
             datosCliente.ciudad || "", datosCliente.provincia, datosCliente.codigoPostal || "", sesion.uid)
    ];
    await env.DB.batch(statements);

    // Aviso automático al admin — si falla el mail, no arruina la compra igual.
    try {
      const emailContacto = cfgGeneral ? (JSON.parse(cfgGeneral.valor).emailContacto || "") : "";
      const destinatario = emailContacto || env.GMAIL_USER;
      if (destinatario) {
        await enviarEmailNuevoPedidoAdmin(env, destinatario, {
          numeroPedido, total, envio: rEnvio.costo,
          clienteNombre: datosCliente.nombre, clienteTelefono: datosCliente.telefono || "",
          items: itemsVerificados
        });
      }
    } catch (err) {
      console.error("No se pudo avisar el pedido nuevo:", err);
    }

    return json({ numeroPedido, pedidoId, mensajeWhatsapp, total, envio: rEnvio.costo }, 201);
  }

  // ---- MIS PEDIDOS (cliente logueado) ---------------------------------------
  if (method === "GET" && !id) {
    const esAdminReq = url.searchParams.get("admin") === "1";
    if (esAdminReq) {
      await requiereAdmin(request, env);
      const estado = url.searchParams.get("estado") || "";
      const desde = url.searchParams.get("desde"); // ISO
      const hasta = url.searchParams.get("hasta"); // ISO
      const limite = Math.min(200, Number(url.searchParams.get("limite")) || 50);
      const offset = Number(url.searchParams.get("offset")) || 0;
      let sql = "SELECT * FROM pedidos WHERE 1=1";
      const args = [];
      if (estado) { sql += " AND estado = ?"; args.push(estado); }
      if (desde) { sql += " AND fecha >= ?"; args.push(desde); }
      if (hasta) { sql += " AND fecha < ?"; args.push(hasta); }
      sql += " ORDER BY fecha DESC LIMIT ? OFFSET ?";
      args.push(limite, offset);
      const { results } = await env.DB.prepare(sql).bind(...args).all();
      const pedidos = await adjuntarItems(env, results);
      const { count } = await env.DB.prepare("SELECT COUNT(*) as count FROM pedidos WHERE estado='pendiente'").first();
      return json({ pedidos, hayMas: results.length === limite, pendientesGlobal: count });
    }
    const sesion = await requiereCliente(request, env);
    const { results } = await env.DB.prepare("SELECT * FROM pedidos WHERE cliente_id = ? ORDER BY fecha DESC").bind(sesion.uid).all();
    const pedidos = await adjuntarItems(env, results);
    return json({ pedidos });
  }

  // ---- RESUMEN (admin: dashboard) -------------------------------------------
  if (method === "GET" && id === "resumen") {
    await requiereAdmin(request, env);
    const pendientes = await env.DB.prepare("SELECT COUNT(*) as c FROM pedidos WHERE estado='pendiente'").first();
    const todos = await env.DB.prepare("SELECT COALESCE(SUM(total),0) as total, COALESCE(SUM(envio),0) as envio FROM pedidos").first();
    const cancelados = await env.DB.prepare("SELECT COALESCE(SUM(total),0) as total, COALESCE(SUM(envio),0) as envio FROM pedidos WHERE estado='cancelado'").first();
    return json({
      pendientes: pendientes.c,
      totalTodos: todos.total, envioTodos: todos.envio,
      totalCancelado: cancelados.total, envioCancelado: cancelados.envio
    });
  }

  // ---- ENVIAR AVISO POR MAIL (admin, manual — no automático) --------------
  if (method === "POST" && id && accion === "notificar") {
    await requiereAdmin(request, env);
    const pedido = await env.DB.prepare("SELECT * FROM pedidos WHERE id = ?").bind(id).first();
    if (!pedido) return jsonError("Pedido no encontrado", 404);
    const cliente = await env.DB.prepare("SELECT email FROM clientes WHERE id = ?").bind(pedido.cliente_id).first();
    if (!cliente?.email) return jsonError("No se encontró el email del cliente", 404);
    const { results: items } = await env.DB.prepare("SELECT * FROM pedido_items WHERE pedido_id = ?").bind(id).all();
    const enviado = await enviarEmailEstadoPedido(env, cliente.email, mapPedido(pedido, items));
    if (!enviado) return jsonError("No se pudo enviar el mail. Revisá la configuración de Gmail.", 500);
    return json({ ok: true });
  }

  // ---- CANCELAR (cliente, su propio pedido pendiente) -----------------------
  if (method === "POST" && id && accion === "cancelar") {
    const sesion = await requiereCliente(request, env);
    const pedido = await env.DB.prepare("SELECT * FROM pedidos WHERE id = ?").bind(id).first();
    if (!pedido) return jsonError("Pedido no encontrado", 404);
    if (pedido.cliente_id !== sesion.uid && sesion.tipo !== "admin") return jsonError("No autorizado", 403);
    if (pedido.estado === "cancelado") return json({ ok: true });
    await devolverStockYCancelar(env, pedido);
    return json({ ok: true });
  }

  // ---- CAMBIAR ESTADO (admin) ------------------------------------------------
  if (method === "PUT" && id) {
    await requiereAdmin(request, env);
    const { estado: nuevoEstado, envio } = await request.json();
    const validos = ["pendiente", "pagado", "preparacion", "enviado", "cancelado"];
    if (!validos.includes(nuevoEstado)) return jsonError("Estado inválido", 400);
    const pedido = await env.DB.prepare("SELECT * FROM pedidos WHERE id = ?").bind(id).first();
    if (!pedido) return jsonError("Pedido no encontrado", 404);

    if (nuevoEstado === "cancelado" && pedido.estado !== "cancelado" && !pedido.stock_devuelto) {
      await devolverStockYCancelar(env, pedido);
      if (envio !== undefined) await env.DB.prepare("UPDATE pedidos SET envio = ? WHERE id = ?").bind(Number(envio) || 0, id).run();
    } else if (nuevoEstado !== "cancelado" && pedido.estado === "cancelado" && pedido.stock_devuelto) {
      // Reactivar un pedido cancelado: vuelve a descontar el stock que se había devuelto.
      const { results: items } = await env.DB.prepare("SELECT * FROM pedido_items WHERE pedido_id = ?").bind(id).all();
      const statements = [
        env.DB.prepare("UPDATE pedidos SET estado = ?, stock_devuelto = 0, envio = ? WHERE id = ?").bind(nuevoEstado, Number(envio) || pedido.envio, id),
        ...items.map((i) => env.DB.prepare("UPDATE productos SET stock = stock - ?, cantidad_vendida = cantidad_vendida + ? WHERE id = ?").bind(i.cantidad, i.cantidad, i.producto_id))
      ];
      await env.DB.batch(statements);
    } else {
      await env.DB.prepare("UPDATE pedidos SET estado = ?, envio = ? WHERE id = ?").bind(nuevoEstado, envio !== undefined ? (Number(envio) || 0) : pedido.envio, id).run();
    }
    return json({ ok: true });
  }

  // ---- BORRAR definitivamente (admin) ---------------------------------------
  if (method === "DELETE" && id) {
    await requiereAdmin(request, env);
    const pedido = await env.DB.prepare("SELECT * FROM pedidos WHERE id = ?").bind(id).first();
    if (!pedido) return jsonError("Pedido no encontrado", 404);
    if (pedido.estado !== "cancelado" && !pedido.stock_devuelto) {
      const { results: items } = await env.DB.prepare("SELECT * FROM pedido_items WHERE pedido_id = ?").bind(id).all();
      await env.DB.batch([
        ...items.map((i) => env.DB.prepare("UPDATE productos SET stock = stock + ?, cantidad_vendida = MAX(0, cantidad_vendida - ?) WHERE id = ?").bind(i.cantidad, i.cantidad, i.producto_id)),
        env.DB.prepare("DELETE FROM pedidos WHERE id = ?").bind(id)
      ]);
    } else {
      await env.DB.prepare("DELETE FROM pedidos WHERE id = ?").bind(id).run();
    }
    return json({ ok: true });
  }

  return jsonError("No encontrado", 404);
}

async function adjuntarItems(env, pedidosRows) {
  const out = [];
  for (const row of pedidosRows) {
    const { results: items } = await env.DB.prepare("SELECT * FROM pedido_items WHERE pedido_id = ?").bind(row.id).all();
    out.push(mapPedido(row, items));
  }
  return out;
}

async function devolverStockYCancelar(env, pedido) {
  const { results: items } = await env.DB.prepare("SELECT * FROM pedido_items WHERE pedido_id = ?").bind(pedido.id).all();
  const statements = [
    env.DB.prepare("UPDATE pedidos SET estado = 'cancelado', stock_devuelto = 1 WHERE id = ?").bind(pedido.id),
    ...items.map((i) => env.DB.prepare("UPDATE productos SET stock = stock + ?, cantidad_vendida = MAX(0, cantidad_vendida - ?) WHERE id = ?").bind(i.cantidad, i.cantidad, i.producto_id))
  ];
  await env.DB.batch(statements);
}
