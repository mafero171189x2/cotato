// ============================================================================
// Rate limiting con D1 — protege login, registro y recuperación de contraseña.
//
// Por qué importa acá en particular: verifyPassword corre PBKDF2 con 100.000
// iteraciones. Cada intento fallido quema CPU del Worker. Sin límite, alguien
// puede (a) probar contraseñas hasta entrar y (b) hacerte gastar la cuota.
// Por eso el chequeo va ANTES de tocar el hash.
// ============================================================================
import { jsonError } from "./middleware.js";

const VENTANA_MS = 15 * 60 * 1000; // 15 minutos

/** IP real del visitante detrás de Cloudflare. */
export function ipDe(request) {
  return request.headers.get("CF-Connecting-IP") || "sin-ip";
}

/** Arma los límites de un endpoint: uno por IP+email (evita fuerza bruta
 *  contra una cuenta) y otro por IP sola (evita barrer muchas cuentas).
 *  Separar por IP+email también impide que un atacante bloquee a un cliente
 *  legítimo a propósito desde afuera. */
export function limitesLogin(request, endpoint, email) {
  const ip = ipDe(request);
  const mail = String(email || "").toLowerCase().slice(0, 120);
  return [
    { clave: `${endpoint}|${ip}|${mail}`, max: 8 },
    { clave: `${endpoint}|${ip}`, max: 30 }
  ];
}

/** Lanza 429 si alguna de las claves está bloqueada. Llamar SIEMPRE antes
 *  de verificar la contraseña. */
export async function exigirLimite(env, limites) {
  const ahora = Date.now();
  for (const { clave } of limites) {
    const row = await env.DB.prepare("SELECT bloqueado_hasta FROM intentos WHERE clave = ?").bind(clave).first();
    if (!row || !row.bloqueado_hasta) continue;
    const hasta = new Date(row.bloqueado_hasta).getTime();
    if (hasta > ahora) {
      const min = Math.max(1, Math.ceil((hasta - ahora) / 60000));
      throw jsonError(`Demasiados intentos. Esperá ${min} minuto${min === 1 ? "" : "s"} y probá de nuevo.`, 429);
    }
  }
}

/** Suma un intento fallido. Si la ventana venció, arranca de cero. */
export async function registrarFallo(env, limites) {
  const ahora = Date.now();
  const ahoraISO = new Date(ahora).toISOString();
  for (const { clave, max } of limites) {
    const row = await env.DB.prepare("SELECT intentos, ultimo FROM intentos WHERE clave = ?").bind(clave).first();
    const vencida = !row || !row.ultimo || (ahora - new Date(row.ultimo).getTime()) > VENTANA_MS;
    const intentos = vencida ? 1 : Number(row.intentos || 0) + 1;
    const bloqueado = intentos >= max ? new Date(ahora + VENTANA_MS).toISOString() : null;
    await env.DB.prepare(
      `INSERT INTO intentos (clave, intentos, bloqueado_hasta, ultimo) VALUES (?, ?, ?, ?)
       ON CONFLICT(clave) DO UPDATE SET intentos = excluded.intentos,
                                        bloqueado_hasta = excluded.bloqueado_hasta,
                                        ultimo = excluded.ultimo`
    ).bind(clave, intentos, bloqueado, ahoraISO).run();
  }
}

/** Login exitoso: se limpia el contador para no arrastrar fallos viejos. */
export async function limpiarLimite(env, limites) {
  for (const { clave } of limites) {
    await env.DB.prepare("DELETE FROM intentos WHERE clave = ?").bind(clave).run();
  }
}
