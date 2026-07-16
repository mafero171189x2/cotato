// Convierte filas de D1 (snake_case) a los objetos que el frontend espera
// (mismos nombres de campo que usaba Firestore, para no tocar el resto del JS).

export function mapProducto(row) {
  if (!row) return null;
  return {
    id: row.id,
    nombre: row.nombre,
    descripcion: row.descripcion,
    categoria: row.categoria,
    marca: row.marca,
    precio: row.precio,
    stock: row.stock,
    enOferta: !!row.en_oferta,
    porcentajeDescuento: row.porcentaje_descuento,
    activo: !!row.activo,
    imagenes: JSON.parse(row.imagenes || "[]"),
    cantidadVendida: row.cantidad_vendida,
    fechaPublicacion: row.fecha_publicacion
  };
}

export function mapCategoria(row) {
  if (!row) return null;
  return { id: row.id, nombre: row.nombre, orden: row.orden };
}

export function mapCliente(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    nombre: row.nombre,
    telefono: row.telefono,
    direccion: row.direccion,
    entreCalles: row.entre_calles,
    ciudad: row.ciudad,
    provincia: row.provincia,
    codigoPostal: row.codigo_postal,
    fechaRegistro: row.fecha_registro
  };
}

export function mapPedido(row, items = []) {
  if (!row) return null;
  return {
    id: row.id,
    numeroPedido: row.numero_pedido,
    clienteUid: row.cliente_id,
    cliente: {
      nombre: row.cliente_nombre,
      telefono: row.cliente_telefono,
      direccion: row.direccion,
      entreCalles: row.entre_calles,
      ciudad: row.ciudad,
      provincia: row.provincia,
      codigoPostal: row.codigo_postal,
      notas: row.notas
    },
    productos: items.map((i) => ({ productoId: i.producto_id, nombre: i.nombre, precio: i.precio, cantidad: i.cantidad })),
    total: row.total,
    envio: row.envio,
    zonaEnvio: row.zona_envio,
    estado: row.estado,
    stockDevuelto: !!row.stock_devuelto,
    mensajeWhatsapp: row.mensaje_whatsapp,
    fecha: row.fecha
  };
}

export function uuid() {
  return crypto.randomUUID();
}
