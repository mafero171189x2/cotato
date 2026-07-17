import { hashPassword } from "../auth/jwt.js";
import { requiereAdmin, jsonError, json } from "../auth/middleware.js";
import { uuid } from "../database/mappers.js";

export async function handleAdmins(request, env, url) {
  const method = request.method;
  const partes = url.pathname.split("/").filter(Boolean); // ["api","admins", ":id"?]
  const id = partes[2];

  // ---- LISTAR ------------------------------------------------------------
  if (method === "GET" && !id) {
    await requiereAdmin(request, env);
    const { results } = await env.DB.prepare("SELECT id, email, creado FROM admins ORDER BY creado ASC").all();
    return json({ admins: results });
  }

  // ---- CREAR ---------------------------------------------------------------
  if (method === "POST" && !id) {
    await requiereAdmin(request, env);
    const { email, password } = await request.json();
    if (!email || !password || password.length < 6) {
      return jsonError("Email y contraseña (mínimo 6 caracteres) son obligatorios", 400);
    }
    const emailNorm = email.toLowerCase().trim();
    const existente = await env.DB.prepare("SELECT id FROM admins WHERE email = ?").bind(emailNorm).first();
    if (existente) return jsonError("Ya existe un admin con ese email", 409);

    const nuevoId = uuid();
    const hash = await hashPassword(password);
    await env.DB.prepare("INSERT INTO admins (id, email, password_hash) VALUES (?, ?, ?)").bind(nuevoId, emailNorm, hash).run();
    const row = await env.DB.prepare("SELECT id, email, creado FROM admins WHERE id = ?").bind(nuevoId).first();
    return json({ admin: row }, 201);
  }

  // ---- ELIMINAR --------------------------------------------------------
  if (method === "DELETE" && id) {
    const sesion = await requiereAdmin(request, env);

    if (id === sesion.uid) {
      return jsonError("No podés eliminar tu propia cuenta de admin mientras estás logueado con ella", 400);
    }
    const { total } = await env.DB.prepare("SELECT COUNT(*) as total FROM admins").first();
    if (total <= 1) {
      return jsonError("No podés eliminar el último admin que queda", 400);
    }
    await env.DB.prepare("DELETE FROM admins WHERE id = ?").bind(id).run();
    return json({ ok: true });
  }

  return jsonError("No encontrado", 404);
}
