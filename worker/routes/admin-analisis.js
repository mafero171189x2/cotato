/* ==========================================================================
   COTATO — routes/admin-analisis.js
   --------------------------------------------------------------------------
   Análisis de datos del negocio con IA, para el PANEL DE ADMINISTRACIÓN.

   Acciones (POST /api/admin/analisis con { accion: "..." }):
     - "preguntar"  -> respondés preguntas sobre tus ventas en lenguaje natural
     - "resumen"    -> resumen del período con lo más importante
     - "reposicion" -> qué productos conviene reponer, por velocidad de venta

   POR QUÉ LOS DATOS VIENEN DEL PANEL Y NO DE LA BASE
   El panel ya tiene los pedidos y productos cargados en memoria (los mismos
   que ves en pantalla). Mandarlos desde ahí evita duplicar consultas SQL y
   evita que este archivo dependa del esquema exacto de las tablas: si mañana
   cambiás una columna, esto sigue funcionando.

   REGLA CLAVE — LOS NÚMEROS NO LOS CALCULA LA IA
   Los modelos de lenguaje son malos sumando y es fácil que "alucinen" una
   cifra convincente pero falsa. Acá TODAS las cuentas (totales, unidades,
   rankings, velocidad de venta) las hace este código en JavaScript, de forma
   determinista. A Gemini se le pasan las métricas YA CALCULADAS y su único
   trabajo es redactar la interpretación en lenguaje natural.
   Si Gemini falla, igual devolvemos las métricas: los números nunca dependen
   de que la IA esté disponible.
   ========================================================================== */

import { jsonError, json, requiereAdmin } from "../auth/middleware.js";
import { avisarSiModeloRoto } from "./alerta-modelo.js";

const MODELO_GEMINI = "gemini-3.5-flash-lite";
const GEMINI_URL = (m) => `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;

const LIMITE_POR_MINUTO = 20;
const visitas = new Map();
function pasaLimite(clave) {
  const ahora = Date.now();
  const previas = (visitas.get(clave) || []).filter((t) => ahora - t < 60_000);
  if (previas.length >= LIMITE_POR_MINUTO) return false;
  previas.push(ahora);
  visitas.set(clave, previas);
  if (visitas.size > 1000) visitas.clear();
  return true;
}

/* ------------------------------------------------------------------------ */
/* CÁLCULO DE MÉTRICAS — todo determinista, sin IA                           */
/* ------------------------------------------------------------------------ */

const ESTADOS_VALIDOS = ["pendiente", "pagado", "preparacion", "enviado", "entregado"];

function aFecha(f) {
  if (!f) return null;
  if (typeof f === "object" && f.seconds) return new Date(f.seconds * 1000);
  const d = new Date(f);
  return isNaN(d) ? null : d;
}

/** Calcula todas las métricas del período a partir de pedidos y productos.
 *  Los pedidos cancelados se excluyen de las ventas (no son ingresos). */
function calcularMetricas(pedidos, productos) {
  const validos = pedidos.filter((p) => ESTADOS_VALIDOS.includes(p.estado));
  const cancelados = pedidos.filter((p) => p.estado === "cancelado");

  // --- Totales ---
  const facturado = validos.reduce((a, p) => a + (Number(p.total) || 0), 0);
  const envios = validos.reduce((a, p) => a + (Number(p.envio) || 0), 0);
  const ticketPromedio = validos.length ? Math.round(facturado / validos.length) : 0;

  // --- Unidades vendidas por producto ---
  const porProducto = new Map();
  validos.forEach((p) => {
    (p.productos || []).forEach((i) => {
      const clave = i.productoId || i.nombre;
      if (!clave) return;
      const prev = porProducto.get(clave) || { nombre: i.nombre, unidades: 0, ingresos: 0 };
      prev.unidades += Number(i.cantidad) || 0;
      prev.ingresos += (Number(i.precio) || 0) * (Number(i.cantidad) || 0);
      porProducto.set(clave, prev);
    });
  });
  const ranking = [...porProducto.entries()]
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.unidades - a.unidades);

  // --- Por categoría (cruzando con el catálogo) ---
  const catDe = new Map(productos.map((p) => [p.id, p.categoria || "sin categoría"]));
  const porCategoria = new Map();
  ranking.forEach((r) => {
    const cat = catDe.get(r.id) || "sin categoría";
    const prev = porCategoria.get(cat) || { unidades: 0, ingresos: 0 };
    prev.unidades += r.unidades;
    prev.ingresos += r.ingresos;
    porCategoria.set(cat, prev);
  });

  // --- Por provincia ---
  const porProvincia = new Map();
  validos.forEach((p) => {
    const prov = p.cliente?.provincia || "sin dato";
    porProvincia.set(prov, (porProvincia.get(prov) || 0) + 1);
  });

  // --- Rango de fechas real de los datos ---
  const fechas = validos.map((p) => aFecha(p.fecha)).filter(Boolean).sort((a, b) => a - b);
  const desde = fechas[0] || null;
  const hasta = fechas[fechas.length - 1] || null;
  const dias = (desde && hasta) ? Math.max(1, Math.round((hasta - desde) / 86400000) + 1) : 1;

  return {
    pedidos: validos.length,
    cancelados: cancelados.length,
    facturado,
    envios,
    ticketPromedio,
    dias,
    desde: desde ? desde.toISOString().slice(0, 10) : null,
    hasta: hasta ? hasta.toISOString().slice(0, 10) : null,
    topProductos: ranking.slice(0, 10),
    sinVentas: productos.filter((p) => p.activo && !porProducto.has(p.id)).slice(0, 10).map((p) => p.nombre),
    porCategoria: [...porCategoria.entries()].map(([n, v]) => ({ categoria: n, ...v })).sort((a, b) => b.unidades - a.unidades),
    porProvincia: [...porProvincia.entries()].map(([n, v]) => ({ provincia: n, pedidos: v })).sort((a, b) => b.pedidos - a.pedidos).slice(0, 8)
  };
}

/** Estima qué productos conviene reponer, según velocidad de venta real.
 *  "Se agota en X días" = stock actual / (unidades vendidas por día). */
function calcularReposicion(pedidos, productos, umbralDias = 21) {
  const m = calcularMetricas(pedidos, productos);
  const vendidoPorId = new Map(m.topProductos.map((r) => [r.id, r.unidades]));

  const filas = productos
    .filter((p) => p.activo)
    .map((p) => {
      const unidades = vendidoPorId.get(p.id) || 0;
      const porDia = unidades / m.dias;
      const stock = Number(p.stock) || 0;
      // Sin ventas registradas no se puede estimar: diasRestantes queda null.
      const diasRestantes = porDia > 0 ? Math.floor(stock / porDia) : null;
      return { nombre: p.nombre, stock, unidadesVendidas: unidades, porDia: Number(porDia.toFixed(2)), diasRestantes };
    });

  const urgentes = filas
    .filter((f) => f.diasRestantes !== null && f.diasRestantes <= umbralDias)
    .sort((a, b) => a.diasRestantes - b.diasRestantes);

  const agotados = filas.filter((f) => f.stock === 0 && f.unidadesVendidas > 0)
    .sort((a, b) => b.unidadesVendidas - a.unidadesVendidas);

  const dormidos = filas.filter((f) => f.unidadesVendidas === 0 && f.stock > 0)
    .sort((a, b) => b.stock - a.stock).slice(0, 8);

  return { periodoDias: m.dias, urgentes: urgentes.slice(0, 12), agotados: agotados.slice(0, 8), dormidos };
}

/** Señales de pedidos que conviene mirar a mano. NO acusa de fraude: marca
 *  patrones inusuales para que VOS decidas. Todo con reglas explícitas. */
function detectarInusuales(pedidos) {
  const señales = [];
  const validos = pedidos.filter((p) => p.estado !== "cancelado");

  // 1) Mismo teléfono con muchos pedidos en poco tiempo
  const porTelefono = new Map();
  validos.forEach((p) => {
    const tel = String(p.cliente?.telefono || "").replace(/\D/g, "");
    if (!tel) return;
    if (!porTelefono.has(tel)) porTelefono.set(tel, []);
    porTelefono.get(tel).push(p);
  });
  porTelefono.forEach((lista, tel) => {
    if (lista.length < 3) return;
    const fechas = lista.map((p) => aFecha(p.fecha)).filter(Boolean).sort((a, b) => a - b);
    if (!fechas.length) return;
    const rangoDias = Math.round((fechas[fechas.length - 1] - fechas[0]) / 86400000);
    if (rangoDias <= 7) {
      señales.push({
        tipo: "pedidos_repetidos",
        detalle: `${lista.length} pedidos del mismo teléfono (…${tel.slice(-4)}) en ${rangoDias} día(s)`,
        pedidos: lista.map((p) => p.numeroPedido)
      });
    }
  });

  // 2) Pedidos muy por encima del ticket promedio
  const totales = validos.map((p) => Number(p.total) || 0).filter((n) => n > 0);
  if (totales.length >= 5) {
    const prom = totales.reduce((a, b) => a + b, 0) / totales.length;
    validos.forEach((p) => {
      const t = Number(p.total) || 0;
      if (t > prom * 4) {
        señales.push({
          tipo: "monto_alto",
          detalle: `Pedido ${p.numeroPedido} es ${(t / prom).toFixed(1)}× el ticket promedio`,
          pedidos: [p.numeroPedido]
        });
      }
    });
  }

  // 3) Pedidos pendientes hace mucho (plata que quedó en el aire)
  const ahora = Date.now();
  validos.filter((p) => p.estado === "pendiente").forEach((p) => {
    const f = aFecha(p.fecha);
    if (!f) return;
    const dias = Math.round((ahora - f) / 86400000);
    if (dias >= 7) {
      señales.push({
        tipo: "pendiente_viejo",
        detalle: `Pedido ${p.numeroPedido} lleva ${dias} días pendiente de pago`,
        pedidos: [p.numeroPedido]
      });
    }
  });

  // 4) Datos de envío incompletos
  validos.forEach((p) => {
    const c = p.cliente || {};
    const faltan = [];
    if (!c.direccion) faltan.push("dirección");
    if (!c.provincia) faltan.push("provincia");
    if (!c.telefono) faltan.push("teléfono");
    if (faltan.length) {
      señales.push({
        tipo: "datos_incompletos",
        detalle: `Pedido ${p.numeroPedido} sin ${faltan.join(", ")}`,
        pedidos: [p.numeroPedido]
      });
    }
  });

  return señales.slice(0, 25);
}

/* ------------------------------------------------------------------------ */
/* CAPA DE IA — solo redacta, no calcula                                     */
/* ------------------------------------------------------------------------ */

const CONTEXTO = `Sos el analista de datos de COTATO, una tienda online argentina de carteras, mochilas, bolsos y riñoneras.
Le hablás a la dueña/dueño de la tienda.

REGLAS ABSOLUTAS
- Los números que te paso ya están calculados y son correctos: usalos TAL CUAL. Nunca los recalcules ni los redondees a ojo.
- Nunca inventes una cifra que no esté en los datos. Si algo no se puede saber con lo que tenés, decilo.
- Español rioplatense (voseo). Directo y concreto, sin marketing ni palabras vacías.
- Escribí para alguien que conoce su negocio pero no es analista: nada de jerga estadística.
- Si los datos son pocos (menos de 10 pedidos), aclaralo: una conclusión sobre 3 pedidos no es una tendencia.`;

async function pedirAGemini(env, prompt, maxTokens = 700) {
  const res = await fetch(GEMINI_URL(env.GEMINI_MODELO || MODELO_GEMINI), {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: maxTokens }
    })
  });
  if (!res.ok) {
    console.error("Gemini análisis", res.status, (await res.text().catch(() => "")).slice(0, 300));
    await avisarSiModeloRoto(env, res, "panel admin — análisis del negocio (admin-analisis.js)");
    throw new Error("gemini");
  }
  const data = await res.json().catch(() => null);
  return (data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "").trim();
}

/* ------------------------------------------------------------------------ */
/* RUTA PRINCIPAL                                                            */
/* ------------------------------------------------------------------------ */

export async function handleAdminAnalisis(request, env, url) {
  await requiereAdmin(request, env);

  if (request.method !== "POST") return jsonError("Método no permitido", 405);
  if (!env.GEMINI_API_KEY) return jsonError("Falta configurar GEMINI_API_KEY en el Worker", 500);

  const ip = request.headers.get("CF-Connecting-IP") || "admin";
  if (!pasaLimite(ip)) return jsonError("Demasiadas consultas seguidas. Esperá un momento.", 429);

  let body;
  try { body = await request.json(); } catch { return jsonError("JSON inválido", 400); }

  const pedidos = Array.isArray(body.pedidos) ? body.pedidos.slice(0, 600) : [];
  const productos = Array.isArray(body.productos) ? body.productos.slice(0, 400) : [];
  const accion = String(body.accion || "");

  if (!pedidos.length && accion !== "reposicion") {
    return json({ texto: "No hay pedidos en el período seleccionado. Probá ampliándolo con el selector de arriba.", metricas: null });
  }

  try {
    /* ---- Preguntas en lenguaje natural sobre las ventas ---- */
    if (accion === "preguntar") {
      const pregunta = String(body.pregunta || "").slice(0, 400);
      if (!pregunta.trim()) return jsonError("Escribí una pregunta", 400);

      const m = calcularMetricas(pedidos, productos);
      const inusuales = detectarInusuales(pedidos);

      const prompt = `${CONTEXTO}

DATOS YA CALCULADOS DEL PERÍODO (${m.desde || "?"} a ${m.hasta || "?"}, ${m.dias} días)
Pedidos válidos: ${m.pedidos} | Cancelados: ${m.cancelados}
Facturado en productos: $${m.facturado} | Cobrado en envíos: $${m.envios}
Ticket promedio: $${m.ticketPromedio}

MÁS VENDIDOS (unidades | ingresos)
${m.topProductos.map((r, i) => `${i + 1}. ${r.nombre} — ${r.unidades} u. | $${r.ingresos}`).join("\n") || "(sin ventas)"}

POR CATEGORÍA
${m.porCategoria.map((c) => `- ${c.categoria}: ${c.unidades} u. | $${c.ingresos}`).join("\n") || "(sin datos)"}

POR PROVINCIA (cantidad de pedidos)
${m.porProvincia.map((p) => `- ${p.provincia}: ${p.pedidos}`).join("\n") || "(sin datos)"}

PRODUCTOS ACTIVOS SIN NINGUNA VENTA EN EL PERÍODO
${m.sinVentas.join(", ") || "(ninguno)"}

SEÑALES A REVISAR
${inusuales.map((s) => `- ${s.detalle}`).join("\n") || "(ninguna)"}

PREGUNTA
"${pregunta}"

Respondé en 2 a 5 oraciones, con los números concretos que correspondan. Si la pregunta no se puede responder con estos datos, decí exactamente qué te falta.`;

      const texto = await pedirAGemini(env, prompt, 600);
      return json({ texto, metricas: m });
    }

    /* ---- Resumen del período ---- */
    if (accion === "resumen") {
      const m = calcularMetricas(pedidos, productos);
      const rep = calcularReposicion(pedidos, productos);
      const inusuales = detectarInusuales(pedidos);

      const prompt = `${CONTEXTO}

RESUMEN DEL PERÍODO (${m.desde || "?"} a ${m.hasta || "?"}, ${m.dias} días)
Pedidos: ${m.pedidos} | Cancelados: ${m.cancelados} | Facturado: $${m.facturado} | Ticket promedio: $${m.ticketPromedio}

MÁS VENDIDOS
${m.topProductos.slice(0, 5).map((r, i) => `${i + 1}. ${r.nombre} — ${r.unidades} u.`).join("\n") || "(sin ventas)"}

POR CATEGORÍA
${m.porCategoria.map((c) => `- ${c.categoria}: ${c.unidades} u.`).join("\n") || "(sin datos)"}

STOCK QUE SE AGOTA PRONTO (al ritmo actual)
${rep.urgentes.slice(0, 5).map((r) => `- ${r.nombre}: quedan ${r.stock} u., se agota en ~${r.diasRestantes} días`).join("\n") || "(nada urgente)"}

AGOTADOS QUE SE ESTABAN VENDIENDO
${rep.agotados.map((r) => `- ${r.nombre} (vendió ${r.unidadesVendidas} u.)`).join("\n") || "(ninguno)"}

SIN VENTAS EN EL PERÍODO
${m.sinVentas.join(", ") || "(ninguno)"}

A REVISAR
${inusuales.map((s) => `- ${s.detalle}`).join("\n") || "(nada)"}

Escribí un resumen de 4 a 6 oraciones: cómo viene el período, qué se destaca, y qué conviene hacer esta semana.
Terminá con una sola recomendación concreta y accionable. Sin títulos ni viñetas, texto corrido.`;

      const texto = await pedirAGemini(env, prompt, 700);
      return json({ texto, metricas: m, reposicion: rep, inusuales });
    }

    /* ---- Alertas de reposición ---- */
    if (accion === "reposicion") {
      const rep = calcularReposicion(pedidos, productos);

      // Si no hay nada que decir, no se gasta una consulta a Gemini.
      if (!rep.urgentes.length && !rep.agotados.length) {
        return json({
          texto: "No hay nada urgente para reponer con los datos del período que estás viendo.",
          reposicion: rep
        });
      }

      const prompt = `${CONTEXTO}

Analicé ${rep.periodoDias} días de ventas.

SE AGOTAN PRONTO (al ritmo actual de venta)
${rep.urgentes.map((r) => `- ${r.nombre}: ${r.stock} u. en stock, vende ${r.porDia}/día, se agota en ~${r.diasRestantes} días`).join("\n") || "(ninguno)"}

YA AGOTADOS PERO SE VENDÍAN
${rep.agotados.map((r) => `- ${r.nombre}: vendió ${r.unidadesVendidas} u. y quedó en cero`).join("\n") || "(ninguno)"}

CON STOCK PERO SIN VENTAS
${rep.dormidos.map((r) => `- ${r.nombre}: ${r.stock} u. paradas`).join("\n") || "(ninguno)"}

Escribí 3 a 5 oraciones diciendo qué reponer primero y por qué. Priorizá lo agotado que se vendía bien.
Si hay stock parado, sugerí qué hacer con eso. Sin viñetas, texto corrido.`;

      const texto = await pedirAGemini(env, prompt, 600);
      return json({ texto, reposicion: rep });
    }

    return jsonError("Acción no reconocida", 400);

  } catch (e) {
    if (e instanceof Response) throw e;
    // Las métricas se calculan sin IA, así que si Gemini falla igual las
    // devolvemos: perdés la redacción, no los números.
    if (e.message === "gemini") {
      try {
        return json({
          texto: null,
          error: "Gemini no respondió, pero acá están los números calculados.",
          metricas: calcularMetricas(pedidos, productos),
          reposicion: calcularReposicion(pedidos, productos),
          inusuales: detectarInusuales(pedidos)
        });
      } catch { return jsonError("Gemini no respondió. Probá de nuevo.", 502); }
    }
    console.error(e);
    return jsonError("No se pudo generar el análisis", 500);
  }
}
