import { hashPassword, verifyPassword, firmarJWT, cookieSesion, cookieBorrar } from "../auth/jwt.js";
import { obtenerSesion, requiereCliente, jsonError, json } from "../auth/middleware.js";
import { mapCliente, uuid } from "../database/mappers.js";
import { enviarEmailReset } from "../auth/mailer.js";

const DURACION_SESION = 60 * 60 * 24 * 30; // 30 días, igual que la persistencia default de Firebase Auth

export async function handleAuth(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  // ---- REGISTRO (cliente) ------------------------------------------------
  if (path === "/api/auth/registro" && method === "POST") {
    const body = await request.json();
    const { email, password, ...datos } = body;
    if (!email || !password || password.length < 6) {
      return jsonError("Email y contraseña (mínimo 6 caracteres) son obligatorios", 400);
    }
    const existente = await env.DB.prepare("SELECT id FROM clientes WHERE email = ?").bind(email.toLowerCase()).first();
    if (existente) return jsonError("Ya existe una cuenta con ese email", 409);

    const id = uuid();
    const hash = await hashPassword(password);
    await env.DB.prepare(
      `INSERT INTO clientes (id, email, password_hash, nombre, telefono, direccion, entre_calles, ciudad, provincia, codigo_postal)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, email.toLowerCase(), hash,
      datos.nombre || "", datos.telefono || "", datos.direccion || "",
      datos.entreCalles || "", datos.ciudad || "", datos.provincia || "", datos.codigoPostal || ""
    ).run();

    const token = await firmarJWT({ uid: id, email: email.toLowerCase(), tipo: "cliente" }, env.JWT_SECRET, DURACION_SESION);
    const row = await env.DB.prepare("SELECT * FROM clientes WHERE id = ?").bind(id).first();
    return json({ cliente: mapCliente(row), token }, 201, { "Set-Cookie": cookieSesion("sesion", token, DURACION_SESION) });
  }

  // ---- LOGIN (cliente) -----------------------------------------------------
  if (path === "/api/auth/login" && method === "POST") {
    const { email, password } = await request.json();
    const row = await env.DB.prepare("SELECT * FROM clientes WHERE email = ?").bind((email || "").toLowerCase()).first();
    if (!row || !(await verifyPassword(password, row.password_hash))) {
      return jsonError("Email o contraseña incorrectos", 401);
    }
    const token = await firmarJWT({ uid: row.id, email: row.email, tipo: "cliente" }, env.JWT_SECRET, DURACION_SESION);
    return json({ cliente: mapCliente(row), token }, 200, { "Set-Cookie": cookieSesion("sesion", token, DURACION_SESION) });
  }

  // ---- LOGIN (admin) -------------------------------------------------------
  if (path === "/api/auth/admin-login" && method === "POST") {
    const { email, password } = await request.json();
    const row = await env.DB.prepare("SELECT * FROM admins WHERE email = ?").bind((email || "").toLowerCase()).first();
    if (!row || !(await verifyPassword(password, row.password_hash))) {
      return jsonError("Email o contraseña incorrectos", 401);
    }
    const token = await firmarJWT({ uid: row.id, email: row.email, tipo: "admin" }, env.JWT_SECRET, DURACION_SESION);
    return json({ admin: { id: row.id, email: row.email }, token }, 200, { "Set-Cookie": cookieSesion("sesion", token, DURACION_SESION) });
  }

  // ---- LOGOUT ----------------------------------------------------------
  if (path === "/api/auth/logout" && method === "POST") {
    return json({ ok: true }, 200, { "Set-Cookie": cookieBorrar("sesion") });
  }

  // ---- SESION ACTUAL (reemplaza onAuthStateChanged) -------------------------
  if (path === "/api/auth/sesion" && method === "GET") {
    const sesion = await obtenerSesion(request, env);
    if (!sesion) return json({ sesion: null });
    if (sesion.tipo === "cliente") {
      const row = await env.DB.prepare("SELECT * FROM clientes WHERE id = ?").bind(sesion.uid).first();
      return json({ sesion: { tipo: "cliente", cliente: mapCliente(row) } });
    }
    return json({ sesion: { tipo: "admin", email: sesion.email, uid: sesion.uid } });
  }

  // ---- CAMBIO DE CONTRASEÑA (cliente logueado) ------------------------------
  if (path === "/api/auth/cambiar-password" && method === "POST") {
    const sesion = await requiereCliente(request, env);
    const { passwordNueva } = await request.json();
    if (!passwordNueva || passwordNueva.length < 6) return jsonError("La contraseña nueva debe tener al menos 6 caracteres", 400);
    const nuevoHash = await hashPassword(passwordNueva);
    await env.DB.prepare("UPDATE clientes SET password_hash = ? WHERE id = ?").bind(nuevoHash, sesion.uid).run();
    return json({ ok: true });
  }

  // ---- RECUPERAR CONTRASEÑA: pedir link -------------------------------------
  if (path === "/api/auth/solicitar-reset" && method === "POST") {
    const { email } = await request.json();
    const row = await env.DB.prepare("SELECT id, email FROM clientes WHERE email = ?").bind((email || "").toLowerCase()).first();
    if (row) {
      const token = uuid();
      const exp = new Date(Date.now() + 1000 * 60 * 60).toISOString();
      await env.DB.prepare("UPDATE clientes SET reset_token = ?, reset_token_exp = ? WHERE id = ?").bind(token, exp, row.id).run();
      const origenFrontend = env.CORS_ORIGIN && env.CORS_ORIGIN !== "*" ? env.CORS_ORIGIN : url.origin;
      const link = `${origenFrontend}/#/reset?token=${token}`;
      await enviarEmailReset(env, row.email, link);
    }
    return json({ ok: true });
  }

  if (path === "/api/auth/confirmar-reset" && method === "POST") {
    const { token, passwordNueva } = await request.json();
    if (!token || !passwordNueva || passwordNueva.length < 6) return jsonError("Datos inválidos", 400);
    const row = await env.DB.prepare("SELECT * FROM clientes WHERE reset_token = ?").bind(token).first();
    if (!row || !row.reset_token_exp || new Date(row.reset_token_exp) < new Date()) {
      return jsonError("El link de recuperación es inválido o venció", 400);
    }
    const nuevoHash = await hashPassword(passwordNueva);
    await env.DB.prepare("UPDATE clientes SET password_hash = ?, reset_token = NULL, reset_token_exp = NULL WHERE id = ?").bind(nuevoHash, row.id).run();
    return json({ ok: true });
  }

  return jsonError("No encontrado", 404);
}
