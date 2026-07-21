import { hashPassword } from "../auth/jwt.js";
import { requiereAdmin, jsonError, json, leerJson } from "../auth/middleware.js";
import { uuid } from "../database/mappers.js";

const MIN_PASSWORD = 8;

function emailValido(e) {
  return typeof e === "string" && e.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
}

export async function handleAdmins(request, env, url) {
  const method = request.method;
  const partes = url.pathname.split("/").filter(Boolean); // ["api","admins", ":id"?]
  const id = partes[2];

  // ---- LISTAR --------------------------------------------------------------
  if (method === "GET" && !id) {
    await requiereAdmin(request, env);
    const { results } = await env.DB.prepare("SELECT id, email, creado FROM admins ORDER BY creado ASC").all();
    return json({ admins: results });
  }

  // ---- CREAR ---------------------------------------------------------------
  if (method === "POST" && !id) {
    await requiereAdmin(request, env);
    const { email, password } = await leerJson(request, 4096);
    const emailNorm = String(email || "").toLowerCase().trim();

    if (!emailValido(emailNorm)) return jsonError("Ingresá un email válido", 400);
    if (typeof password !== "string" || password.length < MIN_PASSWORD) {
      return jsonError(`La contraseña debe tener al menos ${MIN_PASSWORD} caracteres`, 400);
    }
    if (password.length > 200) return jsonError("La contraseña es demasiado larga", 400);

    const existente = await env.DB.prepare("SELECT id FROM admins WHERE email = ?").bind(emailNorm).first();
    if (existente) return jsonError("Ya existe un admin con ese email", 409);

    const nuevoId = uuid();
    const hash = await hashPassword(password);
    await env.DB.prepare("INSERT INTO admins (id, email, password_hash, token_version) VALUES (?, ?, ?, 0)")
      .bind(nuevoId, emailNorm, hash).run();
    const row = await env.DB.prepare("SELECT id, email, creado FROM admins WHERE id = ?").bind(nuevoId).first();
    return json({ admin: row }, 201);
  }

  // ---- CAMBIAR CONTRASEÑA DE UN ADMIN --------------------------------------
  if (method === "PUT" && id) {
    const sesion = await requiereAdmin(request, env);
    const { password } = await leerJson(request, 4096);
    if (typeof password !== "string" || password.length < MIN_PASSWORD) {
      return jsonError(`La contraseña debe tener al menos ${MIN_PASSWORD} caracteres`, 400);
    }
    if (password.length > 200) return jsonError("La contraseña es demasiado larga", 400);

    const existente = await env.DB.prepare("SELECT id FROM admins WHERE id = ?").bind(id).first();
    if (!existente) return jsonError("Admin no encontrado", 404);

    const hash = await hashPassword(password);
    // token_version + 1: cambiar la contraseña ahora SÍ echa a quien estuviera
    // usando esa cuenta. Antes el token viejo seguía valiendo 30 días.
    await env.DB.prepare("UPDATE admins SET password_hash = ?, token_version = token_version + 1 WHERE id = ?")
      .bind(hash, id).run();

    // Si un admin se cambia su propia clave, se le devuelve token nuevo para
    // que no se auto-expulse del panel.
    if (id === sesion.uid) {
      const { firmarJWT } = await import("../auth/jwt.js");
      const fresco = await env.DB.prepare("SELECT id, email, token_version FROM admins WHERE id = ?").bind(id).first();
      const token = await firmarJWT(
        { uid: fresco.id, email: fresco.email, tipo: "admin", tv: Number(fresco.token_version || 0) },
        env.JWT_SECRET, 60 * 60 * 24 * 30
      );
      return json({ ok: true, token });
    }
    return json({ ok: true });
  }

  // ---- ELIMINAR ------------------------------------------------------------
  if (method === "DELETE" && id) {
    const sesion = await requiereAdmin(request, env);

    if (id === sesion.uid) {
      return jsonError("No podés eliminar tu propia cuenta de admin mientras estás logueado con ella", 400);
    }
    const { total } = await env.DB.prepare("SELECT COUNT(*) as total FROM admins").first();
    if (total <= 1) {
      return jsonError("No podés eliminar el último admin que queda", 400);
    }
    // Al borrar la fila, obtenerSesion() ya no encuentra la cuenta y el token
    // del admin eliminado deja de funcionar en el acto.
    await env.DB.prepare("DELETE FROM admins WHERE id = ?").bind(id).run();
    return json({ ok: true });
  }

  return jsonError("No encontrado", 404);
}
