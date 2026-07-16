// Recalcula el envío EN EL SERVIDOR (nunca confiar en lo que mande el cliente).
// Mismo algoritmo que el original: precio de zona + adicional por artículo extra,
// con envío gratis a partir de cierto monto si está configurado.
export async function calcularEnvio(env, provincia, cantidadArticulos, subtotalCarrito) {
  if (!provincia) return { ok: false, costo: 0, motivo: "Elegí tu provincia para calcular el envío." };

  const zonaRow = await env.DB.prepare(
    `SELECT z.* FROM envio_provincias p JOIN envio_zonas z ON z.id = p.zona_id WHERE lower(p.provincia) = lower(?)`
  ).bind(provincia.trim()).first();
  if (!zonaRow) return { ok: false, costo: 0, motivo: "No hay tarifa cargada para tu zona. Consultanos por WhatsApp." };

  const cfgRow = await env.DB.prepare("SELECT valor FROM configuracion WHERE clave = 'envios'").first();
  const cfg = cfgRow ? JSON.parse(cfgRow.valor) : { adicionalPorArticuloExtra: 0, envioGratisDesde: 0 };

  const extras = Math.max(0, (Number(cantidadArticulos) || 1) - 1);
  const costo = Number(zonaRow.precio) + extras * (Number(cfg.adicionalPorArticuloExtra) || 0);

  const minimo = Number(cfg.envioGratisDesde) || 0;
  if (minimo > 0 && subtotalCarrito >= minimo) {
    return { ok: true, costo: 0, motivo: "", zonaNombre: zonaRow.nombre, gratis: true };
  }
  return { ok: true, costo, motivo: "", zonaNombre: zonaRow.nombre, gratis: false };
}
