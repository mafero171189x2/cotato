import { verificarJWT, leerCookie } from "./jwt.js";

/** Devuelve { uid, email, tipo, tv } o null si no hay sesión válida.
 *
 *  IMPORTANTE (cambio de seguridad): antes alcanzaba con que la firma del JWT
 *  fuera válida. Eso significaba que un admin borrado seguía entrando 30 días,
 *  y que cambiarle la contraseña a una cuenta comprometida NO echaba al
 *  atacante. Ahora se consulta la base en cada pedido autenticado:
 *    - si la cuenta no existe más  -> sesión inválida
 *    - si token_version cambió     -> sesión revocada
 *  Es una lectura extra a D1 por request, pero es la única forma de poder
 *  cortarle el acceso a alguien de verdad. */
export async function obtenerSesion(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : leerCookie(request, "sesion");
  if (!token) return null;

  const payload = await verificarJWT(token, env.JWT_SECRET);
  if (!payload || !payload.uid) return null;
  if (payload.tipo !== "admin" && payload.tipo !== "cliente") return null;

  // El nombre de tabla sale de un ternario cerrado, no de input del usuario.
  const tabla = payload.tipo === "admin" ? "admins" : "clientes";
  const row = await env.DB.prepare(`SELECT token_version FROM ${tabla} WHERE id = ?`).bind(payload.uid).first();
  if (!row) return null;                                                      // cuenta borrada
  if (Number(row.token_version || 0) !== Number(payload.tv || 0)) return null; // sesión revocada

  return payload;
}

/** Exige cualquier sesión válida (cliente o admin). */
export async function requiereSesion(request, env) {
  const sesion = await obtenerSesion(request, env);
  if (!sesion) throw jsonError("No autenticado", 401);
  return sesion;
}

/** Exige sesión de CLIENTE específicamente.
 *  Antes aceptaba cualquier sesión válida, así que un token de admin pasaba
 *  como cliente y terminaba escribiendo en la tabla equivocada. */
export async function requiereCliente(request, env) {
  const sesion = await requiereSesion(request, env);
  if (sesion.tipo !== "cliente") throw jsonError("Esta acción es solo para cuentas de cliente", 403);
  return sesion;
}

/** Exige sesión de admin. */
export async function requiereAdmin(request, env) {
  const sesion = await obtenerSesion(request, env);
  if (!sesion || sesion.tipo !== "admin") throw jsonError("Requiere permisos de administrador", 403);
  return sesion;
}

/** Lee el body como JSON con tope de tamaño. Sin esto, cualquier cliente
 *  logueado podía mandar megabytes (carrito, notas del pedido) y guardarlos
 *  en D1. Lanza Response directamente, igual que requiereAdmin. */
export async function leerJson(request, maxBytes = 64 * 1024) {
  const declarado = Number(request.headers.get("Content-Length") || 0);
  if (declarado > maxBytes) throw jsonError("El contenido enviado es demasiado grande", 413);

  const texto = await request.text();
  if (texto.length > maxBytes) throw jsonError("El contenido enviado es demasiado grande", 413);

  try {
    const data = JSON.parse(texto);
    if (!data || typeof data !== "object") throw new Error("no es objeto");
    return data;
  } catch (_) {
    throw jsonError("El formato de los datos enviados no es válido", 400);
  }
}

/** Recorta un texto libre a un máximo, para que no entren campos gigantes. */
export function texto(valor, max = 200) {
  return String(valor ?? "").trim().slice(0, max);
}

export function jsonError(mensaje, status = 400) {
  return new Response(JSON.stringify({ error: mensaje }), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders }
  });
}
