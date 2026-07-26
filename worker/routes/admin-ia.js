/* ==========================================================================
   COTATO — routes/admin-ia.js
   --------------------------------------------------------------------------
   Herramientas de IA para el PANEL DE ADMINISTRACIÓN (no para el cliente).

   Acciones disponibles (POST /api/admin/ia con { accion: "..." }):
     - "descripcion"     -> redacta la descripción de un producto
     - "alt"             -> sugiere texto alternativo para la foto (SEO/accesibilidad)
     - "importar"        -> lee un texto desprolijo del proveedor y arma el
                            formulario completo (nombre, categoría, descripción)

   SEGURIDAD
   Esta ruta es SOLO para administradores logueados: usa requiereAdmin, igual
   que el resto de las rutas del panel. Sin eso, cualquiera podría gastar tu
   cuota de Gemini desde afuera.

   IMPORTANTE — LA IA NO INVENTA DATOS DUROS
   Nunca genera precios, stock ni códigos. Solo redacta texto descriptivo a
   partir de lo que VOS le pasás. Los números los seguís cargando a mano.
   Además, todo lo que genera es una SUGERENCIA: aparece en el formulario
   para que lo revises y edites antes de guardar. Nada se guarda solo.
   ========================================================================== */

import { jsonError, json, requiereAdmin } from "../auth/middleware.js";

/* Mismo modelo que el asistente del cliente (Gemini 2.0 se dio de baja el
   1/6/2026). Se puede sobreescribir con la variable GEMINI_MODELO. */
const MODELO_GEMINI = "gemini-3.5-flash-lite";

const GEMINI_URL = (modelo) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`;

/* Límite por administrador. Es más alto que el del chat público porque acá
   sos vos generando contenido, pero igual evita un bucle accidental que te
   dispare la factura. */
const LIMITE_POR_MINUTO = 30;
const visitas = new Map();

function pasaLimite(clave) {
  const ahora = Date.now();
  const previas = (visitas.get(clave) || []).filter((t) => ahora - t < 60_000);
  if (previas.length >= LIMITE_POR_MINUTO) return false;
  previas.push(ahora);
  visitas.set(clave, previas);
  if (visitas.size > 1000) visitas.clear();
  return true;
}

/* ------------------------------------------------------------------------ */
/* PROMPTS — uno por acción                                                  */
/* ------------------------------------------------------------------------ */

const TONO_COTATO = `Escribís para COTATO, una tienda online argentina de carteras, mochilas, bolsos y riñoneras de diseño nórdico.
Tono: cálido, claro y concreto. Español rioplatense (voseo). Nada de marketing exagerado ni palabras vacías
("increíble", "el mejor del mercado", "no te lo pierdas"). Nada de emojis. Nada de inventar materiales,
medidas, garantías ni características que no te hayan dado.`;

function promptDescripcion(d) {
  return `${TONO_COTATO}

Escribí la descripción de este producto para la ficha de la tienda.

DATOS DEL PRODUCTO (lo único que sabés — no agregues nada que no esté acá)
Nombre: ${d.nombre || "(sin nombre)"}
Categoría: ${d.categoria || "(sin categoría)"}
Marca: ${d.marca || "(sin marca)"}
Notas del vendedor: ${d.notas || "(sin notas)"}

REGLAS
- Entre 2 y 4 oraciones. Un solo párrafo, sin títulos ni viñetas.
- Si te faltan datos (material, medidas, colores), NO los inventes: escribí solo con lo que tenés.
- No menciones precio, stock, envío ni promociones.
- No repitas el nombre del producto más de una vez.

Respondé ÚNICAMENTE con el texto de la descripción, sin comillas ni explicaciones.`;
}

function promptAlt(d) {
  return `${TONO_COTATO}

Escribí el texto alternativo (atributo alt) de la foto principal de este producto.
Sirve para buscadores y para personas que usan lector de pantalla.

DATOS
Nombre: ${d.nombre || "(sin nombre)"}
Categoría: ${d.categoria || "(sin categoría)"}
Descripción: ${d.descripcion || "(sin descripción)"}

REGLAS
- Máximo 125 caracteres.
- Describí QUÉ SE VE (tipo de producto, color y material si los sabés), no lo que se siente.
- No empieces con "Foto de" ni "Imagen de".
- Si no sabés el color o el material, no los inventes.

Respondé ÚNICAMENTE con el texto alternativo, sin comillas.`;
}

function promptImportar(texto, categorias) {
  return `${TONO_COTATO}

Te paso un texto desprolijo de un proveedor. Extraé los datos para cargar el producto en la tienda.

TEXTO DEL PROVEEDOR
"""
${texto}
"""

CATEGORÍAS EXISTENTES EN LA TIENDA (elegí la que mejor encaje; si ninguna sirve, dejá categoria en "")
${categorias.length ? categorias.join(", ") : "(no hay categorías cargadas)"}

REGLAS
- "nombre": corto y comercial, como iría en la ficha. Sin códigos internos del proveedor.
- "descripcion": 2 a 4 oraciones siguiendo el tono de arriba, usando SOLO datos del texto.
- "categoria": exactamente una de la lista de arriba, o "" si ninguna encaja.
- "marca": solo si aparece explícita en el texto; si no, "".
- "precio_detectado": si el texto menciona un precio, el número sin símbolos ni puntos (ej: 45000).
  Si no menciona ninguno, poné null. NUNCA inventes ni estimes un precio.
- No inventes materiales, medidas ni colores que no estén en el texto.

Respondé ÚNICAMENTE con un objeto JSON válido, sin markdown ni texto alrededor:
{"nombre":"","descripcion":"","categoria":"","marca":"","precio_detectado":null}`;
}

function promptWhatsapp(d) {
  // El alias de pago SOLO se le pasa a la IA si el pedido está realmente
  // pendiente de pago. Si se lo mandamos igual en un pedido cancelado o ya
  // pagado, el modelo tiende a mencionarlo de todos modos (es un dato tan
  // "presente" en el contexto que cuesta que lo ignore). Sacándolo de raíz
  // cuando no aplica, es imposible que lo use por error.
  const alias = d.estado === "pendiente" ? d.alias : "";

  // Mismo criterio para el monto: solo tiene sentido mencionar plata cuando
  // hay algo relacionado al pago (pendiente = falta pagar, pagado = se
  // confirma lo cobrado). En preparación, enviado, entregado o cancelado no
  // hay ninguna acción de pago en juego, así que ni se le muestra el total
  // — así no puede "colarlo" en el mensaje aunque la regla se lo prohíba.
  const mostrarTotal = d.estado === "pendiente" || d.estado === "pagado";

  return `${TONO_COTATO}

Escribí un mensaje de WhatsApp para un cliente de COTATO sobre su pedido. Es de la tienda hacia el cliente.

DATOS DEL PEDIDO (los únicos hechos reales — no agregues nada que no esté acá)
Nombre del cliente: ${d.nombre || "(sin nombre)"}
Número de pedido: ${d.numeroPedido}
Estado actual: ${d.estado}
Productos: ${d.productos}
${mostrarTotal ? `Total con envío: $${d.total}` : ""}
${alias ? `Alias para transferir: ${alias}` : ""}
${d.esPrimeraCompra === true ? "Es su primera compra en la tienda." : ""}
${d.esPrimeraCompra === false ? `Ya hizo ${d.comprasPrevia} compra(s) antes.` : ""}

REGLA MÁS IMPORTANTE — EL ESTADO MANDA POR ENCIMA DE TODO LO DEMÁS
El "Estado actual" de arriba es el único real. Nunca asumas que un pedido
está pendiente de pago si el estado dice otra cosa, aunque el mensaje sea
sobre un pedido o el cliente parezca interesado en comprar.

QUÉ ESCRIBIR SEGÚN EL ESTADO (elegí la fila que corresponda)
- "pendiente": pedile el comprobante de la transferencia, mencionando el total. Si te pasé un alias, incluilo.
- "pagado": confirmá que se registró el pago (podés mencionar el monto como respaldo). NO pidas ningún pago ni menciones alias.
- "preparacion": contale que su pedido está en preparación. NO menciones montos, precios ni alias.
- "enviado": avisale que ya salió el envío. NO menciones montos, precios ni alias.
- "entregado": preguntale si lo recibió bien, en tono de cierre. NO menciones montos, precios ni alias, NO lo invites a comprar de nuevo.
- "cancelado": avisale con tono neutral y respetuoso que el pedido quedó cancelado, y que estás para lo que necesite. NO menciones montos, precios ni alias, NO lo invites a completar la compra, NO insistas en que retome el pedido. Es un mensaje informativo, no una venta.

OTRAS REGLAS
- Un solo mensaje, listo para pegar en WhatsApp. Sin asteriscos de markdown, sin emojis salvo como mucho uno.
- Si es su primera compra, dale una bienvenida breve y genuina (sin exagerar) — salvo que el estado sea "cancelado", ahí no corresponde dar la bienvenida.
- Si ya compró antes, un tono más directo y cercano, como a alguien conocido — sin decir explícitamente "como ya sos cliente".
- No inventes descuentos, promociones ni plazos de envío que no estén en los datos.
- Máximo 4 oraciones.

Respondé ÚNICAMENTE con el texto del mensaje, sin comillas ni explicaciones.`;
}

/* ------------------------------------------------------------------------ */
/* LLAMADA A GEMINI                                                          */
/* ------------------------------------------------------------------------ */

async function pedirAGemini(env, prompt, { json = false, maxTokens = 500 } = {}) {
  const payload = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.6,        // algo de variedad para que no salgan todas iguales
      maxOutputTokens: maxTokens,
      ...(json ? { responseMimeType: "application/json" } : {})
    }
  };

  const res = await fetch(GEMINI_URL(env.GEMINI_MODELO || MODELO_GEMINI), {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const detalle = await res.text().catch(() => "");
    console.error("Gemini admin error", res.status, detalle.slice(0, 300));
    throw new Error("gemini");
  }

  const data = await res.json().catch(() => null);
  const texto = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  return texto.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
}

/* ------------------------------------------------------------------------ */
/* RUTA PRINCIPAL                                                            */
/* ------------------------------------------------------------------------ */

export async function handleAdminIA(request, env, url) {
  // Solo administradores logueados. requiereAdmin lanza Response si no lo es
  // (el index.js lo captura y lo devuelve tal cual).
  await requiereAdmin(request, env);

  if (request.method !== "POST") return jsonError("Método no permitido", 405);
  if (!env.GEMINI_API_KEY) return jsonError("Falta configurar GEMINI_API_KEY en el Worker", 500);

  const ip = request.headers.get("CF-Connecting-IP") || "admin";
  if (!pasaLimite(ip)) return jsonError("Demasiadas generaciones seguidas. Esperá un momento.", 429);

  let body;
  try { body = await request.json(); } catch { return jsonError("JSON inválido", 400); }

  const accion = String(body.accion || "");

  try {
    /* ---- 1) Redactar descripción de producto ---- */
    if (accion === "descripcion") {
      const d = {
        nombre: String(body.nombre || "").slice(0, 200),
        categoria: String(body.categoria || "").slice(0, 100),
        marca: String(body.marca || "").slice(0, 100),
        notas: String(body.notas || "").slice(0, 600)
      };
      if (!d.nombre.trim() && !d.notas.trim()) {
        return jsonError("Escribí al menos el nombre del producto o algunas notas.", 400);
      }
      const texto = await pedirAGemini(env, promptDescripcion(d), { maxTokens: 400 });
      return json({ descripcion: texto.slice(0, 1200) });
    }

    /* ---- 2) Texto alternativo para la foto ---- */
    if (accion === "alt") {
      const d = {
        nombre: String(body.nombre || "").slice(0, 200),
        categoria: String(body.categoria || "").slice(0, 100),
        descripcion: String(body.descripcion || "").slice(0, 600)
      };
      if (!d.nombre.trim()) return jsonError("Cargá primero el nombre del producto.", 400);
      const texto = await pedirAGemini(env, promptAlt(d), { maxTokens: 120 });
      return json({ alt: texto.replace(/^["']|["']$/g, "").slice(0, 125) });
    }

    /* ---- 3) Carga asistida desde texto del proveedor ---- */
    if (accion === "importar") {
      const texto = String(body.texto || "").slice(0, 3000);
      if (texto.trim().length < 15) {
        return jsonError("Pegá un texto un poco más largo para poder interpretarlo.", 400);
      }
      const categorias = Array.isArray(body.categorias)
        ? body.categorias.slice(0, 40).map((c) => String(c).slice(0, 60))
        : [];

      const salida = await pedirAGemini(env, promptImportar(texto, categorias), { json: true, maxTokens: 600 });

      let d;
      try { d = JSON.parse(salida); }
      catch { return jsonError("No pude interpretar ese texto. Probá con una descripción más clara.", 422); }

      // La categoría solo se acepta si EXISTE de verdad en la tienda:
      // así la IA no puede inventar una categoría nueva por su cuenta.
      const catValida = categorias.find((c) => c.toLowerCase() === String(d.categoria || "").toLowerCase());

      // El precio se devuelve como sugerencia para revisar, nunca se aplica solo.
      let precio = Number(d.precio_detectado);
      if (!Number.isFinite(precio) || precio <= 0) precio = null;

      return json({
        nombre: String(d.nombre || "").slice(0, 200),
        descripcion: String(d.descripcion || "").slice(0, 1200),
        categoria: catValida || "",
        marca: String(d.marca || "").slice(0, 100),
        precioDetectado: precio
      });
    }

    /* ---- 4) Mensaje de WhatsApp personalizado para un pedido ---- */
    if (accion === "whatsapp") {
      const d = {
        nombre: String(body.nombre || "").slice(0, 120),
        numeroPedido: String(body.numeroPedido || "").slice(0, 40),
        estado: String(body.estado || "").slice(0, 30),
        productos: String(body.productos || "").slice(0, 600),
        total: Number(body.total) || 0,
        alias: String(body.alias || "").slice(0, 100),
        // esPrimeraCompra puede venir true/false/undefined: si no se sabe,
        // no se le pide a la IA que asuma nada al respecto.
        esPrimeraCompra: typeof body.esPrimeraCompra === "boolean" ? body.esPrimeraCompra : null,
        comprasPrevia: Number(body.comprasPrevia) || 0
      };
      if (!d.numeroPedido || !d.estado) return jsonError("Faltan datos del pedido", 400);

      const texto = await pedirAGemini(env, promptWhatsapp(d), { maxTokens: 350 });
      return json({ mensaje: texto.replace(/^["']|["']$/g, "").slice(0, 900) });
    }

    return jsonError("Acción no reconocida", 400);

  } catch (e) {
    if (e instanceof Response) throw e;          // rechazo de requiereAdmin
    if (e.message === "gemini") return jsonError("Gemini no respondió. Probá de nuevo.", 502);
    console.error(e);
    return jsonError("No se pudo generar el contenido", 500);
  }
}
