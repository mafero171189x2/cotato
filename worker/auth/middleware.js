import { verificarJWT, leerCookie } from "./jwt.js";

/** Devuelve { uid, email, tipo: 'cliente'|'admin' } o null si no hay sesión válida. */
export async function obtenerSesion(request, env) {
  const token = leerCookie(request, "sesion");
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
