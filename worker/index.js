import { handleAuth } from "./routes/auth.js";
import { handleProductos } from "./routes/productos.js";
import { handleCategorias } from "./routes/categorias.js";
import { handlePedidos } from "./routes/pedidos.js";
import { handleClientes } from "./routes/clientes.js";
import { handleConfig, handleCatalogo } from "./routes/config.js";
import { handleAdmins } from "./routes/admins.js";
import { jsonError } from "./auth/middleware.js";

/** Orígenes permitidos. Poné CORS_ORIGIN en las variables del Worker con el
 *  dominio real (se aceptan varios separados por coma).
 *
 *  Cambio de seguridad: antes, si faltaba la variable, el default era "*" y
 *  cualquier sitio del mundo podía pegarle a la API. Ahora el default es la
 *  lista de abajo, y un origen desconocido simplemente no recibe headers CORS. */
const ORIGENES_POR_DEFECTO = [
  "https://cotato.pages.dev",
  "http://localhost:8788",
  "http://localhost:3000"
];

function origenesPermitidos(env) {
  if (env.CORS_ORIGIN && env.CORS_ORIGIN !== "*") {
    return env.CORS_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean);
  }
  return ORIGENES_POR_DEFECTO;
}

function corsHeaders(origin, env) {
  const permitidos = origenesPermitidos(env);
  const base = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
  if (origin && permitidos.includes(origin)) {
    return { ...base, "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true" };
  }
  // Origen desconocido: el navegador bloquea la respuesta del lado del cliente.
  return base;
}

// Cabeceras de seguridad para cualquier respuesta de la API.
const SEGURIDAD = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store"
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    const aplicar = (resp, conNoStore = true) => {
      const r = new Response(resp.body, resp);
      Object.entries(cors).forEach(([k, v]) => r.headers.set(k, v));
      Object.entries(SEGURIDAD).forEach(([k, v]) => {
        // El catálogo público sí se cachea; el resto no.
        if (k === "Cache-Control" && !conNoStore) return;
        r.headers.set(k, v);
      });
      return r;
    };

    try {
      let response;
      let cacheable = false;

      if (url.pathname.startsWith("/api/auth/")) {
        response = await handleAuth(request, env, url);
      } else if (url.pathname === "/api/catalogo") {
        response = await handleCatalogo(request, env, ctx);
        cacheable = true;
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
      } else if (url.pathname.startsWith("/api/admins")) {
        response = await handleAdmins(request, env, url);
      } else {
        response = jsonError("Ruta no encontrada", 404);
      }

      return aplicar(response, !cacheable);
    } catch (err) {
      // requiereAdmin / requiereCliente / leerJson lanzan Response directamente
      if (err instanceof Response) return aplicar(err);
      // El detalle del error queda en los logs, nunca en la respuesta.
      console.error(err);
      return aplicar(jsonError("Error interno del servidor", 500));
    }
  }
};
