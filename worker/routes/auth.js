import { hashPassword, verifyPassword, firmarJWT, cookieSesion, cookieBorrar } from "../auth/jwt.js";
import { obtenerSesion, requiereCliente, jsonError, json, leerJson, texto } from "../auth/middleware.js";
import { exigirLimite, registrarFallo, limpiarLimite, limitesLogin, ipDe } from "../auth/ratelimit.js";
import { mapCliente, uuid } from "../database/mappers.js";
import { enviarEmailReset } from "../auth/mailer.js";

const DURACION_SESION = 60 * 60 * 24 * 30; // 30 días
const MIN_PASSWORD = 8;

// Las 30 contraseñas que más aparecen en las filtraciones. No es una lista
// completa (eso sería un servicio aparte), pero corta lo más obvio.
const PASSWORDS_COMUNES = new Set([
  "12345678", "123456789", "1234567890", "password", "password1", "password123",
  "qwerty123", "qwertyui", "11111111", "00000000", "abc12345", "iloveyou",
  "princess", "sunshine", "football", "baseball", "shadow12", "superman",
  "trustno1", "michael1", "jennifer", "letmein1", "welcome1", "admin123",
  "administrador", "contrasena", "contraseña", "argentina", "boca1234", "river1234"
]);

function validarPassword(p) {
  if (typeof p !== "string" || p.length < MIN_PASSWORD) {
    return `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres`;
  }
  if (p.length > 200) return "La contraseña es demasiado larga";
  if (PASSWORDS_COMUNES.has(p.toLowerCase())) {
    return "Esa contraseña es demasiado fácil de adivinar. Elegí otra.";
  }
  return null;
}

function emailValido(e) {
  return typeof e === "string" && e.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
}

/** Firma el JWT incluyendo tv (token_version): así una contraseña cambiada o
 *  una cuenta borrada invalidan el token al instante. */
function firmarSesion(env, { uid, email, tipo, tv }) {
  return firmarJWT({ uid, email, tipo, tv: Number(tv || 0) }, env.JWT_SECRET, DURACION_SESION);
}

export async function handleAuth(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  // ---- REGISTRO (cliente) --------------------------------------------------
  if (path === "/api/auth/registro" && method === "POST") {
    // Límite por IP: sin esto, el 409 "ya existe esa cuenta" se puede usar para
    // averiguar qué emails están registrados en la tienda (enumeración).
    const limites = [{ clave: `registro|${ipDe(request)}`, max: 6 }];
    await exigirLimite(env, limites);

    const body = await leerJson(request);
    const { email, password, ...datos } = body;
    const emailNorm = String(email || "").toLowerCase().trim();

    if (!emailValido(emailNorm)) {
      await registrarFallo(env, limites);
      return jsonError("Ingresá un email válido", 400);
    }
    const errPass = validarPassword(password);
    if (errPass) {
      await registrarFallo(env, limites);
      return jsonError(errPass, 400);
    }

    const existente = await env.DB.prepare("SELECT id FROM clientes WHERE email = ?").bind(emailNorm).first();
    if (existente) {
      await registrarFallo(env, limites);
      return jsonError("No se pudo crear la cuenta con ese email. Si ya tenés una, entrá con tu contraseña o usá 'Olvidé mi contraseña'.", 409);
    }

    const id = uuid();
    const hash = await hashPassword(password);
    await env.DB.prepare(
      `INSERT INTO clientes (id, email, password_hash, nombre, telefono, direccion, entre_calles, ciudad, provincia, codigo_postal, token_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    ).bind(
      id, emailNorm, hash,
      texto(datos.nombre, 80), texto(datos.telefono, 30), texto(datos.direccion, 160),
      texto(datos.entreCalles, 120), texto(datos.ciudad, 80), texto(datos.provincia, 60), texto(datos.codigoPostal, 12)
    ).run();

    const token = await firmarSesion(env, { uid: id, email: emailNorm, tipo: "cliente", tv: 0 });
    const row = await env.DB.prepare("SELECT * FROM clientes WHERE id = ?").bind(id).first();
    return json({ cliente: mapCliente(row), token }, 201, { "Set-Cookie": cookieSesion("sesion", token, DURACION_SESION) });
  }

  // ---- LOGIN (cliente) -----------------------------------------------------
  if (path === "/api/auth/login" && method === "POST") {
    const { email, password } = await leerJson(request, 4096);
    const emailNorm = String(email || "").toLowerCase().trim();
    const limites = limitesLogin(request, "login", emailNorm);

    await exigirLimite(env, limites); // antes de gastar CPU en PBKDF2

    const row = await env.DB.prepare("SELECT * FROM clientes WHERE email = ?").bind(emailNorm).first();
    if (!row || !(await verifyPassword(password, row.password_hash))) {
      await registrarFallo(env, limites);
      return jsonError("Email o contraseña incorrectos", 401);
    }
    await limpiarLimite(env, limites);

    const token = await firmarSesion(env, { uid: row.id, email: row.email, tipo: "cliente", tv: row.token_version });
    return json({ cliente: mapCliente(row), token }, 200, { "Set-Cookie": cookieSesion("sesion", token, DURACION_SESION) });
  }

  // ---- LOGIN (admin) -------------------------------------------------------
  if (path === "/api/auth/admin-login" && method === "POST") {
    const { email, password } = await leerJson(request, 4096);
    const emailNorm = String(email || "").toLowerCase().trim();
    // Contador propio, separado del de cliente: el frontend prueba primero
    // como cliente y después como admin, así que si compartieran contador
    // cada login real gastaría dos intentos.
    const limites = limitesLogin(request, "admin-login", emailNorm);

    await exigirLimite(env, limites);

    const row = await env.DB.prepare("SELECT * FROM admins WHERE email = ?").bind(emailNorm).first();
    if (!row || !(await verifyPassword(password, row.password_hash))) {
      await registrarFallo(env, limites);
      return jsonError("Email o contraseña incorrectos", 401);
    }
    await limpiarLimite(env, limites);

    const token = await firmarSesion(env, { uid: row.id, email: row.email, tipo: "admin", tv: row.token_version });
    return json({ admin: { id: row.id, email: row.email }, token }, 200, { "Set-Cookie": cookieSesion("sesion", token, DURACION_SESION) });
  }

  // ---- LOGOUT --------------------------------------------------------------
  if (path === "/api/auth/logout" && method === "POST") {
    return json({ ok: true }, 200, { "Set-Cookie": cookieBorrar("sesion") });
  }

  // ---- CERRAR SESIÓN EN TODOS LOS DISPOSITIVOS -----------------------------
  // Nuevo: sirve si te robaron el celular o sospechás que alguien entró.
  if (path === "/api/auth/cerrar-todo" && method === "POST") {
    const sesion = await obtenerSesion(request, env);
    if (!sesion) return jsonError("No autenticado", 401);
    const tabla = sesion.tipo === "admin" ? "admins" : "clientes";
    await env.DB.prepare(`UPDATE ${tabla} SET token_version = token_version + 1 WHERE id = ?`).bind(sesion.uid).run();
    return json({ ok: true }, 200, { "Set-Cookie": cookieBorrar("sesion") });
  }

  // ---- SESIÓN ACTUAL -------------------------------------------------------
  if (path === "/api/auth/sesion" && method === "GET") {
    const sesion = await obtenerSesion(request, env);
    if (!sesion) return json({ sesion: null });
    if (sesion.tipo === "cliente") {
      const row = await env.DB.prepare("SELECT * FROM clientes WHERE id = ?").bind(sesion.uid).first();
      if (!row) return json({ sesion: null });
      return json({ sesion: { tipo: "cliente", cliente: mapCliente(row) } });
    }
    return json({ sesion: { tipo: "admin", email: sesion.email, uid: sesion.uid } });
  }

  // ---- CAMBIO DE CONTRASEÑA (cliente logueado) -----------------------------
  // Ahora pide la contraseña ACTUAL. Antes alcanzaba con tener la sesión, así
  // que un token robado (o un celular prestado) permitía tomar la cuenta.
  if (path === "/api/auth/cambiar-password" && method === "POST") {
    const sesion = await requiereCliente(request, env);
    const { passwordActual, passwordNueva } = await leerJson(request, 4096);

    const limites = [{ clave: `cambiar-pass|${ipDe(request)}|${sesion.uid}`, max: 8 }];
    await exigirLimite(env, limites);

    const errPass = validarPassword(passwordNueva);
    if (errPass) return jsonError(errPass, 400);

    const row = await env.DB.prepare("SELECT password_hash FROM clientes WHERE id = ?").bind(sesion.uid).first();
    if (!row) return jsonError("No encontrado", 404);
    if (!(await verifyPassword(passwordActual, row.password_hash))) {
      await registrarFallo(env, limites);
      return jsonError("La contraseña actual no es correcta", 401);
    }
    await limpiarLimite(env, limites);

    const nuevoHash = await hashPassword(passwordNueva);
    // token_version + 1 → se caen todas las sesiones viejas de esta cuenta.
    await env.DB.prepare("UPDATE clientes SET password_hash = ?, token_version = token_version + 1 WHERE id = ?")
      .bind(nuevoHash, sesion.uid).run();

    // Se le devuelve un token nuevo para que no lo eche de su propia sesión.
    const fresco = await env.DB.prepare("SELECT id, email, token_version FROM clientes WHERE id = ?").bind(sesion.uid).first();
    const token = await firmarSesion(env, { uid: fresco.id, email: fresco.email, tipo: "cliente", tv: fresco.token_version });
    return json({ ok: true, token }, 200, { "Set-Cookie": cookieSesion("sesion", token, DURACION_SESION) });
  }

  // ---- RECUPERAR CONTRASEÑA: pedir link ------------------------------------
  if (path === "/api/auth/solicitar-reset" && method === "POST") {
    const { email } = await leerJson(request, 4096);
    const emailNorm = String(email || "").toLowerCase().trim();

    // Sin límite, este endpoint es una máquina de mandar mails (y de quemar
    // la cuota de Gmail) apuntando a cualquier casilla registrada.
    const limites = [
      { clave: `reset|${ipDe(request)}`, max: 5 },
      { clave: `reset-mail|${emailNorm}`, max: 3 }
    ];
    await exigirLimite(env, limites);
    await registrarFallo(env, limites); // cuenta siempre, haya cuenta o no

    const rowCliente = await env.DB.prepare("SELECT id, email FROM clientes WHERE email = ?").bind(emailNorm).first();
    const rowAdmin = rowCliente ? null : await env.DB.prepare("SELECT id, email FROM admins WHERE email = ?").bind(emailNorm).first();
    const tabla = rowCliente ? "clientes" : rowAdmin ? "admins" : null;
    const row = rowCliente || rowAdmin;

    // Responde igual exista o no la cuenta (no revelar si un email está registrado).
    if (row && tabla) {
      const token = uuid(); // crypto.randomUUID(): impredecible
      const exp = new Date(Date.now() + 1000 * 60 * 60).toISOString(); // 1 hora
      await env.DB.prepare(`UPDATE ${tabla} SET reset_token = ?, reset_token_exp = ? WHERE id = ?`).bind(token, exp, row.id).run();
      const origenFrontend = env.CORS_ORIGIN && env.CORS_ORIGIN !== "*" ? env.CORS_ORIGIN : url.origin;
      const link = `${origenFrontend}/#/reset?token=${encodeURIComponent(token)}`;
      await enviarEmailReset(env, row.email, link);
    }
    return json({ ok: true });
  }

  // ---- RECUPERAR CONTRASEÑA: confirmar -------------------------------------
  if (path === "/api/auth/confirmar-reset" && method === "POST") {
    const { token, passwordNueva } = await leerJson(request, 4096);
    if (!token || typeof token !== "string" || token.length > 100) return jsonError("Datos inválidos", 400);

    const limites = [{ clave: `confirmar-reset|${ipDe(request)}`, max: 10 }];
    await exigirLimite(env, limites);

    const errPass = validarPassword(passwordNueva);
    if (errPass) return jsonError(errPass, 400);

    let row = await env.DB.prepare("SELECT * FROM clientes WHERE reset_token = ?").bind(token).first();
    let tabla = "clientes";
    if (!row) {
      row = await env.DB.prepare("SELECT * FROM admins WHERE reset_token = ?").bind(token).first();
      tabla = "admins";
    }
    if (!row || !row.reset_token_exp || new Date(row.reset_token_exp) < new Date()) {
      await registrarFallo(env, limites);
      return jsonError("El link de recuperación es inválido o venció", 400);
    }

    const nuevoHash = await hashPassword(passwordNueva);
    // token_version + 1 → si alguien había entrado con la contraseña vieja,
    // recuperar la cuenta ahora sí lo saca.
    await env.DB.prepare(
      `UPDATE ${tabla} SET password_hash = ?, reset_token = NULL, reset_token_exp = NULL, token_version = token_version + 1 WHERE id = ?`
    ).bind(nuevoHash, row.id).run();

    return json({ ok: true });
  }

  return jsonError("No encontrado", 404);
}
