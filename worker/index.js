import { handleAuth } from "./routes/auth.js";
import { handleProductos } from "./routes/productos.js";
import { handleCategorias } from "./routes/categorias.js";
import { handlePedidos } from "./routes/pedidos.js";
import { handleClientes } from "./routes/clientes.js";
import { handleConfig, handleCatalogo } from "./routes/config.js";
import { jsonError } from "./auth/middleware.js";

// En producción, poné acá el dominio real de tu Pages (o el custom domain).
// "*" funciona pero no permite cookies cross-origin con credentials — si el
// Worker y el Pages quedan en dominios distintos, hace falta el origin exacto.
function corsHeaders(origin, env) {
  const permitido = env.CORS_ORIGIN || "*";
  return {
    "Access-Control-Allow-Origin": permitido === "*" ? "*" : (origin === permitido ? origin : permitido),
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Credentials": "true",
    "Vary": "Origin"
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    try {
      let response;

      if (url.pathname.startsWith("/api/auth/")) {
        response = await handleAuth(request, env, url);
      } else if (url.pathname === "/api/catalogo") {
        response = await handleCatalogo(request, env, ctx);
      } else if (url.pathname.startsWith("/api/productos")) {
        response = await handleProductos(request, env, url);
      } else if (url.pathname.startsWith("/api/categorias")) {
        response = await handleCategorias(request, env, url);
      } else if (url.pathname.startsWith("/api/pedidos")) {
        response = await handlePedidos(request, env, url);
      } else if (url.pathname.startsWith("/api/clientes")) {
        response = await handleClientes(request, env, url);
      } else if (url.pathname.startsWith("/api/config/")) {
        response = await handleConfig(request, env, url);
      } else {
        response = jsonError("Ruta no encontrada", 404);
      }

      // Agrega headers CORS a cualquier respuesta (incluidas las de error)
      const nuevaResponse = new Response(response.body, response);
      Object.entries(cors).forEach(([k, v]) => nuevaResponse.headers.set(k, v));
      return nuevaResponse;
    } catch (err) {
      // Las funciones requiereCliente/requiereAdmin lanzan Response directamente
      if (err instanceof Response) {
        const r = new Response(err.body, err);
        Object.entries(cors).forEach(([k, v]) => r.headers.set(k, v));
        return r;
      }
      console.error(err);
      const r = jsonError("Error interno del servidor", 500);
      Object.entries(cors).forEach(([k, v]) => r.headers.set(k, v));
      return r;
    }
  }
};
