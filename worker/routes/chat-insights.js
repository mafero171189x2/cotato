/* ==========================================================================
   COTATO — routes/chat-insights.js
   --------------------------------------------------------------------------
   Registra qué preguntan los clientes en el asistente virtual, para que
   desde el panel se pueda ver qué le falta al catálogo o a la FAQ.

   QUÉ SE GUARDA (y qué NO)
   - Se guarda: el texto de la pregunta, si el asistente pudo responderla
     (con datos reales o derivando a WhatsApp) o no, y la fecha.
   - NO se guarda: nombre, teléfono, IP, ni ningún dato que identifique a la
     persona. El texto de la pregunta puede mencionar algo personal si el
     cliente lo escribe así — por eso esta tabla es de acceso solo-admin y
     конviene no usarla como fuente de datos de clientes.

   ENDPOINTS
     POST /api/chat-insights            (público, sin auth) -> registra 1 pregunta
     GET  /api/chat-insights/resumen    (admin)              -> agregados

   El POST es público a propósito: lo llama el chat del cliente, que no está
   logueado. Por eso tiene rate-limit y validación estricta de tamaño — así
   nadie puede usarlo para llenarte la tabla de basura.
   ========================================================================== */

import { jsonError, json, requiereAdmin } from "../auth/middleware.js";
import { uuid } from "../database/mappers.js";

const LIMITE_POR_MINUTO = 20;
const visitas = new Map();
function pasaLimite(ip) {
  const ahora = Date.now();
  const previas = (visitas.get(ip) || []).filter((t) => ahora - t < 60_000);
  if (previas.length >= LIMITE_POR_MINUTO) return false;
  previas.push(ahora);
  visitas.set(ip, previas);
  if (visitas.size > 5000) visitas.clear();
  return true;
}

/** Se ejecuta una sola vez (si la tabla ya existe, no hace nada). Evita que
 *  haya que correr una migración manual aparte para esta funcionalidad. */
async function asegurarTabla(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS chat_insights (
      id TEXT PRIMARY KEY,
      pregunta TEXT NOT NULL,
      resuelto INTEGER NOT NULL DEFAULT 0,
      via TEXT,
      fecha TEXT NOT NULL
    )
  `).run();
}

export async function handleChatInsights(request, env, url) {
  const partes = url.pathname.split("/").filter(Boolean);
  const esResumen = partes[2] === "resumen";

  // ---- GET /api/chat-insights/resumen (admin) ----
  if (request.method === "GET" && esResumen) {
    await requiereAdmin(request, env);
    await asegurarTabla(env);

    const dias = Math.min(90, Math.max(1, Number(url.searchParams.get("dias")) || 14));
    const desde = new Date(Date.now() - dias * 86400000).toISOString();

    const { results } = await env.DB.prepare(
      `SELECT pregunta, resuelto, via, fecha FROM chat_insights WHERE fecha >= ? ORDER BY fecha DESC LIMIT 1000`
    ).bind(desde).all();

    const total = results.length;
    const sinResolver = results.filter((r) => !r.resuelto);

    // Agrupa preguntas sin resolver por similitud simple (mismas palabras
    // significativas), para no mostrar 40 filas casi idénticas.
    const grupos = new Map();
    sinResolver.forEach((r) => {
      const clave = normalizarClave(r.pregunta);
      const prev = grupos.get(clave) || { ejemplo: r.pregunta, veces: 0 };
      prev.veces += 1;
      grupos.set(clave, prev);
    });
    const noResueltasAgrupadas = [...grupos.values()].sort((a, b) => b.veces - a.veces).slice(0, 30);

    return json({
      dias,
      totalPreguntas: total,
      totalSinResolver: sinResolver.length,
      porcentajeResuelto: total ? Math.round(((total - sinResolver.length) / total) * 100) : null,
      noResueltasAgrupadas
    });
  }

  // ---- POST /api/chat-insights (público, lo llama el chat) ----
  if (request.method === "POST" && !esResumen) {
    const ip = request.headers.get("CF-Connecting-IP") || "anon";
    if (!pasaLimite(ip)) return jsonError("Demasiadas solicitudes", 429);

    let body;
    try { body = await request.json(); } catch { return jsonError("JSON inválido", 400); }

    const pregunta = String(body.pregunta || "").trim().slice(0, 300);
    if (!pregunta) return jsonError("Falta la pregunta", 400);

    const resuelto = body.resuelto ? 1 : 0;
    const via = ["faq", "producto", "envio", "pago", "ia", "reglas", "otro"].includes(body.via) ? body.via : "otro";

    await asegurarTabla(env);
    await env.DB.prepare(
      `INSERT INTO chat_insights (id, pregunta, resuelto, via, fecha) VALUES (?, ?, ?, ?, ?)`
    ).bind(uuid(), pregunta, resuelto, via, new Date().toISOString()).run();

    return json({ ok: true });
  }

  return jsonError("No encontrado", 404);
}

/** Reduce una pregunta a sus palabras significativas, para agrupar
 *  variantes parecidas ("cuanto sale la mochila" / "que precio tiene la
 *  mochila") sin tener que hacer comparación difusa costosa.
 *
 *  LIMITACIÓN A TENER EN CUENTA: esto agrupa por palabras compartidas, no
 *  por significado. "cuánto sale el envío" y "qué precio tiene el envío"
 *  NO se agrupan entre sí (comparten "envío" pero no el resto). Agrupa bien
 *  variantes casi idénticas (mismo tipeo, con/sin tilde, singular/plural);
 *  para agrupar paráfrasis distintas hace falta comparación semántica, que
 *  este sistema no hace a propósito (sería más lento y menos transparente
 *  sobre por qué agrupó dos preguntas). Si ves muchas filas parecidas sin
 *  agrupar, es esto — miralas igual, el conteo individual sigue siendo útil. */
function normalizarClave(texto) {
  const vacias = new Set(["que", "qué", "el", "la", "los", "las", "un", "una", "de", "del", "en", "y", "o",
    "es", "son", "para", "por", "con", "se", "me", "mi", "tu", "su", "esta", "está", "hay", "che", "ese", "esa"]);
  const raiz = (w) => {
    // Stemming mínimo: saca plurales y las terminaciones verbales más comunes,
    // para que "envíos"/"envío", "tienen"/"tiene" caigan en la misma clave.
    return w
      .replace(/(ando|iendo)$/, "")
      .replace(/(amos|emos|imos)$/, "")
      .replace(/(an|en)$/, "")
      .replace(/(es|s)$/, "");
  };
  return String(texto || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !vacias.has(w))
    .map(raiz)
    .filter((w) => w.length > 2)
    .sort()
    .join(" ");
}
