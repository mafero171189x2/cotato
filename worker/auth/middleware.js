import { verificarJWT, leerCookie } from "./jwt.js";

/** Devuelve { uid, email, tipo: 'cliente'|'admin' } o null si no hay sesión válida.
 *  Prioriza el header Authorization (Bearer <token>) sobre la cookie: la cookie
 *  cruzada entre dominios distintos (Pages vs Workers) es "de terceros" para el
 *  navegador y se bloquea en incógnito/Safari/Chrome moderno. El header no depende
 *  de eso — el frontend lo manda a mano en cada pedido. */
export async function obtenerSesion(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : leerCookie(request, "sesion");
  if (!token) return null;
  const payload = await verificarJWT(token, env.JWT_SECRET);
  if (!payload) return null;
  return payload; // { uid, email, tipo }
}

/** Exige sesión de cliente (o admin, que también puede comprar). Lanza Response 401 si no hay. */
export async function requiereCliente(request, env) {
  const sesion = await obtenerSesion(request, env);
  if (!sesion) throw jsonError("No autenticado", 401);
  return sesion;
}

/** Exige sesión de admin. Lanza Response 403 si no lo es. */
export async function requiereAdmin(request, env) {
  const sesion = await obtenerSesion(request, env);
  if (!sesion || sesion.tipo !== "admin") throw jsonError("Requiere permisos de administrador", 403);
  return sesion;
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
