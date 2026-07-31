/* ==========================================================================
   AGENTE VIRTUAL COTATO
   --------------------------------------------------------------------------
   Chatbot de atención al cliente para la tienda. Se conecta a los datos
   REALES que la propia tienda ya tiene cargados en memoria:

     - TODOS_PRODUCTOS   -> nombre, precio, stock, categoría, marca, oferta...
     - CONFIG             -> nombre de tienda, WhatsApp, alias/CBU, envío gratis
     - ENVIOS             -> zonas, precios y adicional por artículo extra
     - CATEGORIAS_CACHE    -> categorías activas
     - Carrito.agregar()  -> el mismo carrito de la tienda
     - formatearPrecio(), linkWhatsApp(), zonaDeProvincia(), escapeHTML(),
       optimizarImagenUrl(), precioFinal(), calcularEnvio()

   El agente NUNCA inventa precio ni stock: todo sale de esas variables,
   que la tienda ya mantiene sincronizadas contra la base de datos real
   (Firestore, vía /api/catalogo). Si el catálogo todavía no cargó, el
   agente espera y avisa en vez de arriesgar un dato viejo.

   NOTA TÉCNICA IMPORTANTE
   --------------------------------------------------------------------------
   El script principal de index.html es un <script type="module">. Todo lo
   declarado adentro de un módulo queda encerrado en el módulo: NO se puede
   leer desde un archivo externo, ni con window.X ni con eval.

   Por eso index.html publica, al final de ese módulo, un objeto puente de
   solo lectura llamado window.COTATO_AGENTE, con las funciones y datos que
   este archivo necesita. Si ese puente no está, el asistente lo dice en
   lugar de inventar un precio o un stock.

   Si actualizás index.html, asegurate de que siga existiendo ese bloque
   "PUENTE PARA EL ASISTENTE VIRTUAL" al final del <script type="module">.

   INSTALACIÓN
   --------------------------------------------------------------------------
   1) Subí este archivo junto al resto (por ej. junto a index.html).
   2) Agregá, justo ANTES de </body> y DESPUÉS de tu <script> principal
      (el que define TODOS_PRODUCTOS, CONFIG, Carrito, etc.):

        <script src="agente-cotato.js" defer></script>

   3) Listo. El botón flotante aparece solo. No hace falta tocar el HTML.

   PERSONALIZACIÓN
   --------------------------------------------------------------------------
   - Las preguntas frecuentes NO se cargan acá: el asistente las lee directo
     de tu sección "Preguntas frecuentes" (#/faq) del sitio. Si agregás,
     sacás o editás una pregunta ahí, el asistente la usa automáticamente,
     sin tocar este archivo. Una sola fuente de verdad.
   - Los colores se toman solos de las variables CSS del sitio (--laton,
     --superficie, --texto, etc.), así que respeta el tema claro/oscuro
     sin que haya que tocar nada.
   ========================================================================== */
(function () {
  "use strict";

  /* ------------------------------------------------------------------ */
  /* 0) PREGUNTAS FRECUENTES — se leen DIRECTO del sitio, no se duplican  */
  /* ------------------------------------------------------------------ */
  /* Antes había un array con las respuestas copiadas a mano acá adentro.
   * El problema: si alguna vez actualizás una política en la página
   * #/faq (plazos, cambios, etc.) y te olvidás de tocar este archivo
   * también, el asistente queda diciendo algo distinto a tu propio sitio.
   *
   * Ahora el asistente lee la sección "Preguntas frecuentes" directo del
   * HTML (siempre está en el DOM, aunque esa vista esté oculta) — una
   * sola fuente de verdad. Si cambiás una respuesta en el sitio, el
   * asistente la usa actualizada sin tocar este archivo. */

  /** Frases que la gente escribe y que capaz no aparecen tal cual en el
   *  enunciado de la pregunta del sitio, pero deberían disparar esa misma
   *  respuesta. Esto NO duplica la respuesta (esa se lee siempre del sitio)
   *  — solo ayuda a reconocer la intención. Si el enunciado de una pregunta
   *  cambia mucho en el sitio, en el peor caso un sinónimo deja de aplicar
   *  (se degrada solo, no rompe nada ni queda desactualizado). */
  const SINONIMOS_FAQ = [
    { si: "hago un pedido", agrega: ["como comprar", "cómo comprar", "como compro", "cómo compro", "quiero comprar"] },
    { si: "todo el pais", agrega: ["envian a todo el pais", "envían a todo el país", "correo argentino", "que correo", "qué correo"] },
    { si: "tarda en llegar", agrega: ["cuando llega", "cuándo llega", "demora", "en cuanto llega", "tiempo de entrega"] },
    { si: "cambiar o devolver", agrega: ["devolucion", "devolución", "devoluciones", "no me gusto", "no me gustó", "vino mal", "fallado", "defecto"] },
    { si: "pedido fue confirmado", agrega: ["estado de mi pedido", "seguimiento", "donde esta mi pedido", "dónde está mi pedido", "mi pedido"] },
    { si: "eliminar mi cuenta", agrega: ["borrar mi cuenta", "dar de baja", "darme de baja", "borrar cuenta"] },
    { si: "cambiar mi contrasena", agrega: ["cambiar mi contraseña", "olvide mi contrasena", "olvidé mi contraseña", "recuperar clave", "no recuerdo mi clave", "resetear clave"] },
    { si: "tienen local fisico", agrega: ["tienen local físico", "tienen negocio", "puedo ir", "retiro por local", "showroom", "atienden al publico", "atienden al público"] },
    { si: "como pago", agrega: ["pagar", "transferencia", "efectivo", "tarjeta", "cuotas", "mercado pago", "mercadopago", "alias", "cbu"] }
  ];

  /** Convierte la pregunta en un set de "claves" para reconocerla: la frase
   *  completa, pares de palabras consecutivas (más específico que palabras
   *  sueltas, para no confundir preguntas distintas que comparten una
   *  palabra común como "pedido"), y los sinónimos que apliquen. */
  function derivarClaves(preguntaTexto) {
    const norm = normalizar(preguntaTexto);
    const palabras = norm.split(" ").filter(Boolean);
    const claves = new Set([norm]);
    for (let i = 0; i < palabras.length - 1; i++) claves.add(palabras[i] + " " + palabras[i + 1]);
    SINONIMOS_FAQ.forEach(({ si, agrega }) => {
      if (norm.includes(normalizar(si))) agrega.forEach((a) => claves.add(normalizar(a)));
    });
    return [...claves];
  }

  /** Lee la sección "Preguntas frecuentes" directo del HTML del sitio.
   *  Es contenido estático que siempre está en el documento (aunque esa
   *  vista esté oculta), así que se puede cachear sin problema. */
  let _faqCache = null;
  function leerFaqDelSitio() {
    if (_faqCache) return _faqCache;
    const items = document.querySelectorAll('[data-view="faq"] .faq-item');
    const lista = [];
    items.forEach((el) => {
      const pregunta = el.querySelector("summary")?.textContent?.trim();
      const respuesta = el.querySelector(".faq-respuesta")?.textContent?.trim();
      if (!pregunta || !respuesta) return;
      lista.push({ pregunta, respuesta, claves: derivarClaves(pregunta) });
    });
    _faqCache = lista;
    return lista;
  }

  /** Busca la pregunta del sitio que mejor matchea el mensaje del cliente,
   *  por cantidad de claves coincidentes (no la primera que matchee "algo",
   *  para no confundir preguntas parecidas). */
  function buscarEnFaq(textoNormalizado) {
    let mejor = null, mejorScore = 0;
    leerFaqDelSitio().forEach((f) => {
      const score = f.claves.reduce((acc, k) => acc + (textoNormalizado.includes(k) ? 1 : 0), 0);
      if (score > mejorScore) { mejor = f; mejorScore = score; }
    });
    return mejor;
  }

  /* ------------------------------------------------------------------ */
  /* 1) UTILIDADES DE TEXTO                                              */
  /* ------------------------------------------------------------------ */
  function normalizar(s) {
    return String(s || "")
      .toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // saca acentos
      .replace(/[^\w\sñ]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function contieneAlguna(texto, lista) {
    return lista.some((k) => texto.includes(normalizar(k)));
  }

  /** El puente que publica index.html al final de su <script type="module">.
   *  Todo el acceso a datos reales pasa por acá. Si todavía no está listo,
   *  devuelve null y el agente avisa en vez de inventar un dato. */
  function puente() {
    return window.COTATO_AGENTE || null;
  }

  function esc(s) {
    const b = puente();
    if (b && typeof b.escapeHTML === "function") return b.escapeHTML(s);
    return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function precio(p) {
    const b = puente();
    const f = (b && typeof b.precioFinal === "function") ? b.precioFinal(p) : p.precio;
    return precioComoNumero(f);
  }

  function img(p) {
    const raw = p.imagenes && p.imagenes[0];
    const b = puente();
    if (b && typeof b.optimizarImagenUrl === "function") return b.optimizarImagenUrl(raw) || "img/placeholder.jpg";
    return raw || "img/placeholder.jpg";
  }

  /* ------------------------------------------------------------------ */
  /* 2) ACCESO A LOS DATOS REALES DE LA TIENDA (nunca se inventan)      */
  /* ------------------------------------------------------------------ */
  function productos() {
    const b = puente();
    const arr = b && typeof b.productos === "function" ? b.productos() : [];
    return Array.isArray(arr) ? arr : [];
  }
  function activos() { return productos().filter((p) => p.activo); }
  function cfg() {
    const b = puente();
    return (b && typeof b.config === "function") ? (b.config() || {}) : {};
  }
  function nombreTienda() { return cfg().nombreTienda || "COTATO"; }
  function whatsappNumero() { return cfg().whatsappNumero; }
  function catalogoListo() { return productos().length > 0; }

  function linkWa(mensaje) {
    const b = puente();
    if (b && typeof b.linkWhatsApp === "function") return b.linkWhatsApp(whatsappNumero(), mensaje);
    const n = String(whatsappNumero() || "").replace(/\D/g, "");
    return n ? `https://wa.me/${n}?text=${encodeURIComponent(mensaje)}` : "https://wa.me/";
  }

  /** Busca productos por texto libre: nombre, marca, categoría, descripción.
   *  Devuelve resultados puntuados por relevancia (más coincidencias primero). */
  function buscarProductos(texto, limite = 5) {
    const t = normalizar(texto);
    const palabras = t.split(" ").filter((w) => w.length > 2);
    if (!palabras.length) return [];
    const candidatos = activos().map((p) => {
      const campos = [p.nombre, p.marca, p.categoria, p.descripcion].map(normalizar).join(" ");
      let puntaje = 0;
      palabras.forEach((w) => { if (campos.includes(w)) puntaje += 1; });
      if (normalizar(p.nombre).includes(t)) puntaje += 3; // match exacto del nombre completo
      return { p, puntaje };
    }).filter((x) => x.puntaje > 0);
    candidatos.sort((a, b) => b.puntaje - a.puntaje);
    return candidatos.slice(0, limite).map((x) => x.p);
  }

  function productosPorCategoria(nombreCat) {
    const t = normalizar(nombreCat);
    return activos().filter((p) => normalizar(p.categoria).includes(t) || t.includes(normalizar(p.categoria)));
  }

  /* ------------------------------------------------------------------ */
  /* 2.b) FILTROS ESTRUCTURADOS                                          */
  /*      "mochilas negras de menos de $30.000 en oferta" se convierte   */
  /*      en un filtro con campos concretos, y recién ahí se busca.      */
  /* ------------------------------------------------------------------ */
  const COLORES = [
    "negro", "blanco", "gris", "marron", "beige", "camel", "nude", "tostado",
    "verde", "verde militar", "azul", "celeste", "rojo", "bordo", "rosa",
    "violeta", "lila", "amarillo", "naranja", "plateado", "dorado"
  ];

  /** Convierte "30.000", "30000", "30 mil" o "$30.000" en el número 30000. */
  function aNumero(txt) {
    if (!txt) return null;
    let s = String(txt).toLowerCase().replace(/[$\s]/g, "");
    const enMiles = /mil$/.test(s);
    s = s.replace(/mil$/, "").replace(/\./g, "").replace(/,/g, ".");
    let n = parseFloat(s);
    if (!Number.isFinite(n)) return null;
    if (enMiles) n *= 1000;
    return n;
  }

  /** Lee un mensaje libre y extrae los filtros que se puedan reconocer.
   *  Lo que no aparece queda en null: nunca se asume nada. */
  function parsearFiltros(mensaje) {
    const t = normalizar(mensaje);
    const f = { texto: mensaje, categoria: null, color: null, precioMin: null, precioMax: null, soloOferta: false, soloStock: false, orden: null };

    // --- Precio ---
    const num = "(\\d[\\d.,]*\\s*(?:mil)?)";
    let m;
    if ((m = t.match(new RegExp("entre\\s*\\$?" + num + "\\s*(?:y|a)\\s*\\$?" + num)))) {
      f.precioMin = aNumero(m[1]); f.precioMax = aNumero(m[2]);
    } else if ((m = t.match(new RegExp("(?:menos de|hasta|por debajo de|maximo|max|no mas de|que no pase de)\\s*\\$?" + num)))) {
      f.precioMax = aNumero(m[1]);
    } else if ((m = t.match(new RegExp("(?:mas de|desde|arriba de|minimo|superior a)\\s*\\$?" + num)))) {
      f.precioMin = aNumero(m[1]);
    }

    // --- Color (el más largo primero: "verde militar" antes que "verde") ---
    const colorHallado = [...COLORES].sort((a, b) => b.length - a.length)
      .find((c) => new RegExp("\\b" + c + "(?:s|a|as|os)?\\b").test(t));
    if (colorHallado) f.color = colorHallado;

    // --- Categoría (contra las categorías reales de la tienda) ---
    const cats = listaCategorias();
    const catHallada = cats.find((c) => t.includes(normalizar(c)) || normalizar(c).includes(t));
    if (catHallada) f.categoria = catHallada;

    // --- Oferta / stock / orden ---
    if (/\boferta|promo|descuento|rebaja/.test(t)) f.soloOferta = true;
    if (/\bstock|disponible|hay\b/.test(t)) f.soloStock = true;
    if (/barat|economic|mas accesible|menor precio|mas barato/.test(t)) f.orden = "precio-asc";
    if (/\bcaro|premium|mas caro|mayor precio/.test(t)) f.orden = "precio-desc";

    return f;
  }

  /** Aplica un filtro estructurado sobre el catálogo REAL. */
  function buscarConFiltros(f, limite = 6) {
    let items = activos();

    if (f.categoria) {
      const c = normalizar(f.categoria);
      items = items.filter((p) => normalizar(p.categoria).includes(c) || c.includes(normalizar(p.categoria)));
    }
    if (f.color) {
      const c = normalizar(f.color);
      items = items.filter((p) => normalizar(`${p.nombre} ${p.descripcion || ""} ${p.marca || ""}`).includes(c));
    }
    if (f.soloOferta) items = items.filter((p) => p.enOferta);
    if (f.soloStock) items = items.filter((p) => p.stock > 0);

    const precioDe = (p) => {
      const b = puente();
      return (b && typeof b.precioFinal === "function") ? b.precioFinal(p) : Number(p.precio) || 0;
    };
    if (f.precioMin != null) items = items.filter((p) => precioDe(p) >= f.precioMin);
    if (f.precioMax != null) items = items.filter((p) => precioDe(p) <= f.precioMax);

    // Si además hay texto libre, se usa para ordenar por relevancia.
    if (f.texto) {
      const palabras = normalizar(f.texto).split(" ").filter((w) => w.length > 3);
      items = items.map((p) => {
        const campos = normalizar([p.nombre, p.marca, p.categoria, p.descripcion].join(" "));
        let puntaje = 0;
        palabras.forEach((w) => { if (campos.includes(w)) puntaje += 1; });
        return { p, puntaje };
      }).sort((a, b) => b.puntaje - a.puntaje).map((x) => x.p);
    }

    if (f.orden === "precio-asc") items = [...items].sort((a, b) => precioDe(a) - precioDe(b));
    if (f.orden === "precio-desc") items = [...items].sort((a, b) => precioDe(b) - precioDe(a));

    return items.slice(0, limite);
  }

  /** Describe el filtro en palabras, para que el cliente vea qué se aplicó. */
  function describirFiltros(f) {
    const partes = [];
    if (f.categoria) partes.push(esc(f.categoria.toLowerCase()));
    if (f.color) partes.push(`color ${f.color}`);
    if (f.precioMin != null && f.precioMax != null) partes.push(`entre ${precioComoNumero(f.precioMin)} y ${precioComoNumero(f.precioMax)}`);
    else if (f.precioMax != null) partes.push(`hasta ${precioComoNumero(f.precioMax)}`);
    else if (f.precioMin != null) partes.push(`desde ${precioComoNumero(f.precioMin)}`);
    if (f.soloOferta) partes.push("en oferta");
    return partes.join(", ");
  }

  /* ------------------------------------------------------------------ */
  /* 2.c) COMPARACIÓN DE PRODUCTOS                                       */
  /* ------------------------------------------------------------------ */
  /** Detecta "diferencia entre X y Y" / "comparar X con Y" y devuelve los
   *  productos mencionados (o null si no es una comparación). */
  function detectarComparacion(mensaje) {
    const t = normalizar(mensaje);
    if (!/\b(diferencia|compar|versus|\bvs\b|cual es mejor|cuál es mejor|o el|o la)\b/.test(t)) return null;
    // Se parte por "y", "vs", "versus", "o" y se busca cada mitad en el catálogo.
    const partes = t.split(/\s+(?:y|o|vs|versus|contra)\s+/).map((s) => s.trim()).filter(Boolean);
    if (partes.length < 2) return null;
    const encontrados = [];
    partes.forEach((parte) => {
      const r = buscarProductos(parte, 1);
      if (r.length && !encontrados.some((x) => x.id === r[0].id)) encontrados.push(r[0]);
    });
    return encontrados.length >= 2 ? encontrados.slice(0, 3) : null;
  }

  /** Tabla comparativa con datos reales. Solo muestra filas que existan. */
  function tablaComparacionHTML(lista) {
    const b = puente();
    const precioDe = (p) => (b && typeof b.precioFinal === "function") ? b.precioFinal(p) : Number(p.precio) || 0;
    const masBarato = lista.reduce((a, p) => (precioDe(p) < precioDe(a) ? p : a), lista[0]);

    const filas = [
      { etiqueta: "Precio", valor: (p) => `${precio(p)}${p.id === masBarato.id && lista.length > 1 ? ' <span style="font-size:.62rem;opacity:.75">más económico</span>' : ""}` },
      { etiqueta: "Stock", valor: (p) => (p.stock > 0 ? `${esc(p.stock)} u.` : "Sin stock") },
      { etiqueta: "Categoría", valor: (p) => esc(p.categoria || "—") },
      { etiqueta: "Marca", valor: (p) => esc(p.marca || "—") },
      { etiqueta: "Oferta", valor: (p) => (p.enOferta ? `-${esc(p.porcentajeDescuento)}%` : "—") }
    ];

    return `
    <div class="cotato-ag-comp-wrap">
      <table class="cotato-ag-comp">
        <thead>
          <tr><th></th>${lista.map((p) => `<th>${esc(p.nombre)}</th>`).join("")}</tr>
        </thead>
        <tbody>
          ${filas.map((f) => `<tr><td class="cotato-ag-comp-lbl">${f.etiqueta}</td>${lista.map((p) => `<td>${f.valor(p)}</td>`).join("")}</tr>`).join("")}
        </tbody>
      </table>
    </div>
    ${bloqueProductosHTML(lista)}`;
  }

  function productosEnOferta(limite = 5) {
    return activos().filter((p) => p.enOferta).slice(0, limite);
  }

  function listaCategorias() {
    const b = puente();
    const cats = b && typeof b.categorias === "function" ? b.categorias() : [];
    if (Array.isArray(cats) && cats.length) return cats.map((c) => c.nombre);
    return [...new Set(activos().map((p) => p.categoria).filter(Boolean))];
  }

  /* ------------------------------------------------------------------ */
  /* 3) ENVÍOS — usa el mismo cálculo real que el checkout               */
  /* ------------------------------------------------------------------ */
  const PROVINCIAS_AR_LOCAL = [
    "Buenos Aires", "CABA", "Catamarca", "Chaco", "Chubut", "Córdoba", "Corrientes",
    "Entre Ríos", "Formosa", "Jujuy", "La Pampa", "La Rioja", "Mendoza", "Misiones",
    "Neuquén", "Río Negro", "Salta", "San Juan", "San Luis", "Santa Cruz", "Santa Fe",
    "Santiago del Estero", "Tierra del Fuego", "Tucumán"
  ];

  function detectarProvincia(texto) {
    const t = normalizar(texto);
    const b = puente();
    const listaSitio = b && typeof b.provincias === "function" ? b.provincias() : null;
    const lista = (Array.isArray(listaSitio) && listaSitio.length) ? listaSitio : PROVINCIAS_AR_LOCAL;
    // Se ordena de nombre más largo a más corto para que "Buenos Aires" no le
    // gane a "Ciudad Autónoma de Buenos Aires" cuando el cliente escribe CABA.
    const ordenada = [...lista].sort((a, c) => c.length - a.length);
    const directa = ordenada.find((prov) => t.includes(normalizar(prov)));
    if (directa) return directa;
    // Alias comunes que la gente escribe y no coinciden con el nombre oficial.
    if (/\bcaba\b|capital federal|ciudad de buenos aires/.test(t)) {
      return ordenada.find((p) => normalizar(p).includes("ciudad autonoma")) || null;
    }
    return null;
  }

  function respuestaEnvio(provincia) {
    const b = puente();
    if (!b || typeof b.calcularEnvio !== "function") {
      return `Hacemos envíos a todo el país por Correo Argentino u otros correos. Contanos tu provincia o escribinos por WhatsApp y te confirmamos el costo.`;
    }
    const r = b.calcularEnvio(provincia, 1);
    if (!r.ok) return r.motivo || "No tengo tarifa cargada para esa zona todavía. Te recomiendo consultar por WhatsApp.";
    const gratisDesde = Number(cfg().envioGratisDesde);
    let msg = r.gratis
      ? `Para ${esc(provincia)} el envío te sale <strong>gratis</strong> (superás el mínimo de compra).`
      : `Para ${esc(provincia)} el envío base cuesta <strong>${precioComoNumero(r.costo)}</strong> (el costo final se ajusta según la cantidad de artículos, y lo ves exacto en el carrito antes de confirmar).`;
    if (!r.gratis && gratisDesde > 0) {
      msg += ` Envío gratis a partir de ${precioComoNumero(gratisDesde)} en compras.`;
    }
    msg += ` Una vez confirmado el pago, preparamos el envío en 24-48 horas hábiles.`;
    return msg;
  }

  function precioComoNumero(n) {
    const b = puente();
    if (b && typeof b.formatearPrecio === "function") return b.formatearPrecio(n);
    return "$" + Number(n || 0).toLocaleString("es-AR");
  }

  /* ------------------------------------------------------------------ */
  /* 4) TARJETA DE PRODUCTO DENTRO DEL CHAT                              */
  /* ------------------------------------------------------------------ */
  function tarjetaProductoHTML(p) {
    const sinStock = !p.activo || p.stock <= 0;
    return `
    <div class="cotato-ag-prod" data-id="${esc(p.id)}">
      <img src="${esc(img(p))}" alt="${esc(p.nombre)}" loading="lazy" onerror="this.onerror=null;this.src='img/placeholder.jpg'">
      <div class="cotato-ag-prod-info">
        <div class="cotato-ag-prod-nombre">${esc(p.nombre)}</div>
        <div class="cotato-ag-prod-precio">${precio(p)}</div>
        <div class="cotato-ag-prod-stock ${sinStock ? "sin-stock" : ""}">${sinStock ? "Sin stock" : (p.stock <= 5 ? `¡Últimas ${esc(p.stock)}!` : "Stock disponible")}</div>
        <div class="cotato-ag-prod-acciones">
          <button type="button" class="cotato-ag-btn-ver" data-ver="${esc(p.id)}">Ver</button>
          ${sinStock
            ? `<button type="button" class="cotato-ag-btn-similares" data-similares="${esc(p.id)}">Ver similares</button>`
            : `<button type="button" class="cotato-ag-btn-add" data-add="${esc(p.id)}">Agregar</button>
               <button type="button" class="cotato-ag-btn-comprar" data-comprar="${esc(p.id)}">Comprar</button>`}
        </div>
      </div>
    </div>`;
  }

  function bloqueProductosHTML(lista) {
    if (!lista.length) return "";
    return `<div class="cotato-ag-prod-lista">${lista.map(tarjetaProductoHTML).join("")}</div>`;
  }

  /** Alternativas para un producto sin stock: primero de la misma categoría,
   *  y si no alcanza, se completa con lo más parecido por precio. */
  function alternativasPara(p, limite = 3) {
    const b = puente();
    const precioDe = (x) => (b && typeof b.precioFinal === "function") ? b.precioFinal(x) : Number(x.precio) || 0;
    const conStock = activos().filter((x) => x.id !== p.id && x.stock > 0);

    const mismaCat = conStock.filter((x) => normalizar(x.categoria) === normalizar(p.categoria));
    // Se ordenan por cercanía de precio: lo más parecido a lo que quería.
    const porPrecio = (lista) => [...lista].sort((a, c) => Math.abs(precioDe(a) - precioDe(p)) - Math.abs(precioDe(c) - precioDe(p)));

    const elegidos = porPrecio(mismaCat).slice(0, limite);
    if (elegidos.length < limite) {
      const resto = porPrecio(conStock.filter((x) => !elegidos.some((e) => e.id === x.id)));
      elegidos.push(...resto.slice(0, limite - elegidos.length));
    }
    return elegidos;
  }

  /* ------------------------------------------------------------------ */
  /* 5) MOTOR DE INTENCIONES (reglas en español, sin inventar datos)     */
  /* ------------------------------------------------------------------ */
  const estado = { esperandoProvincia: false, ultimaBusqueda: "" };

  /** "¿Quién sos?" / "¿Sos una IA?" etc. — respuesta corta y SIEMPRE igual,
   *  sin pasar por Gemini (para no depender del humor del modelo) ni por el
   *  buscador de productos (para que no lo confunda con una búsqueda). */
  function respuestaIdentidad(texto) {
    const t = normalizar(texto);
    const esPregunta = contieneAlguna(t, [
      "quien sos", "que sos", "quien eres", "que eres",
      "eres una ia", "sos una ia", "sos un bot", "eres un bot", "sos un robot", "eres un robot",
      "sos humano", "eres humano", "con quien hablo", "con quien estoy hablando"
    ]);
    if (!esPregunta) return null;
    return { html: `Soy el asistente virtual de ${esc(nombreTienda())}. Estoy para ayudarte.` };
  }

  function responder(mensajeOriginal) {
    const t = normalizar(mensajeOriginal);

    // Si el puente no existe (index.html sin el bloque del asistente), no se
    // puede garantizar ningún dato: se avisa en vez de improvisar.
    if (!puente()) {
      return { html: `No puedo acceder al catálogo en este momento. Escribinos por WhatsApp y te respondemos enseguida.`, whatsapp: true };
    }

    // "¿Quién sos?" tiene prioridad sobre todo lo demás.
    const identidad = respuestaIdentidad(mensajeOriginal);
    if (identidad) return identidad;

    // Si veníamos esperando una provincia (después de preguntar por envío)
    if (estado.esperandoProvincia) {
      const prov = detectarProvincia(t);
      estado.esperandoProvincia = false;
      if (prov) return { html: respuestaEnvio(prov) };
      // no reconocimos la provincia: seguimos igual con el resto del mensaje
    }

    // Saludo
    if (contieneAlguna(t, ["hola", "buenas", "buen dia", "buenas tardes", "buenas noches", "hey"]) && t.length < 25) {
      return { html: `¡Hola! Soy el asistente virtual de ${esc(nombreTienda())}. Puedo ayudarte con precios, stock, envíos, formas de pago o recomendarte productos. ¿Qué estás buscando?` };
    }

    // Agradecimiento / despedida
    if (contieneAlguna(t, ["gracias", "muchas gracias", "genial gracias"])) {
      return { html: `¡De nada! Si necesitás algo más, estoy por acá. 😊` };
    }
    if (contieneAlguna(t, ["chau", "adios", "adiós", "nos vemos", "hasta luego"])) {
      return { html: `¡Gracias por tu visita a ${esc(nombreTienda())}! Cualquier cosa, volvé a escribirme.` };
    }

    // Categorías disponibles
    if (contieneAlguna(t, ["que categorias", "qué categorias", "que tienen", "qué tienen", "que venden", "qué venden", "que productos tienen"])) {
      const cats = listaCategorias();
      if (!cats.length) return { html: `Todavía no tengo categorías cargadas. Consultanos por WhatsApp.`, whatsapp: true };
      return { html: `En ${esc(nombreTienda())} tenemos: <strong>${cats.map(esc).join(", ")}</strong>. ¿Sobre cuál querés que te muestre productos?` };
    }

    // Ofertas / promociones
    if (contieneAlguna(t, ["oferta", "ofertas", "promocion", "promoción", "promo", "descuento", "descuentos", "rebaja"])) {
      if (!catalogoListo()) return { html: `Estoy terminando de cargar el catálogo. Probá de nuevo en unos segundos.` };
      const enOferta = productosEnOferta(6);
      if (!enOferta.length) return { html: `Por el momento no tenemos productos en oferta activa. Te aviso apenas haya alguna, o consultá por WhatsApp por descuentos especiales.`, whatsapp: true };
      return { html: `Estas son nuestras ofertas activas ahora mismo:`, extra: bloqueProductosHTML(enOferta) };
    }

    // Preguntas frecuentes: se leen directo de la página #/faq del sitio,
    // así nunca dicen algo distinto a lo que el cliente puede leer ahí.
    // Va ANTES de envíos/pagos a propósito: "¿cuánto tarda en llegar?" tiene
    // que responder el plazo real, no el detector genérico de envíos.
    const faq = buscarEnFaq(t);
    if (faq) {
      let respuesta = esc(faq.respuesta);
      // Enriquecimiento propio del asistente (no está en el texto de la FAQ,
      // pero es un dato real y útil): el precio especial por transferencia.
      if (normalizar(faq.pregunta).includes("como pago")) {
        respuesta += ` Además, muchos de nuestros productos tienen un <strong>precio especial pagando con transferencia</strong>.`;
      }
      return { html: respuesta };
    }

    // Envíos
    if (contieneAlguna(t, ["envio", "envios", "envío", "envíos", "mandan", "llega", "entregan", "delivery", "correo", "flete"])) {
      const prov = detectarProvincia(t);
      if (prov) return { html: respuestaEnvio(prov) };
      estado.esperandoProvincia = true;
      return { html: `Hacemos envíos a todo el país. Decime tu <strong>provincia</strong> y te calculo el costo y tiempo estimado.` };
    }
    // Si el mensaje es SOLO el nombre de una provincia (respuesta a la pregunta anterior)
    const provinciaSuelta = detectarProvincia(t);
    if (provinciaSuelta && t.split(" ").length <= 3) {
      return { html: respuestaEnvio(provinciaSuelta) };
    }

    // Pagos: si llegó hasta acá sin matchear la FAQ real ("¿Cómo pago?"),
    // es una frase suelta como "efectivo" o "tarjeta" sin más contexto —
    // se responde con lo mismo, sin inventar nada nuevo.
    if (contieneAlguna(t, ["pago", "pagos", "pagar", "transferencia", "efectivo", "tarjeta", "cuotas", "mercado pago", "mercadopago", "alias", "cbu"])) {
      const faqPago = leerFaqDelSitio().find((f) => normalizar(f.pregunta).includes("como pago"));
      if (faqPago) {
        return { html: `${esc(faqPago.respuesta)} Además, muchos de nuestros productos tienen un <strong>precio especial pagando con transferencia</strong>.` };
      }
    }

    // Hablar con una persona / humano
    if (contieneAlguna(t, ["hablar con alguien", "humano", "persona", "asesor", "vendedor", "whatsapp"])) {
      return { html: `Te paso directo a nuestro WhatsApp para que te atienda el equipo de ${esc(nombreTienda())}.`, whatsapp: true };
    }

    // Precio / stock de un producto puntual, o búsqueda general
    const esConsultaProducto = contieneAlguna(t, [
      "cuanto sale", "cuánto sale", "cuanto cuesta", "cuánto cuesta", "precio de", "vale",
      "hay stock", "queda", "disponible", "cartera", "carteras", "mochila", "mochilas",
      "bolso", "bolsos", "riñonera", "billetera", "busco", "buscando", "necesito", "quiero",
      "tenes", "tenés", "tienen"
    ]);
    if (esConsultaProducto || t.length > 3) {
      if (!catalogoListo()) {
        return { html: `Estoy terminando de cargar el catálogo. Probá de nuevo en unos segundos y te muestro los productos con precio y stock reales.` };
      }

      // ¿Es una comparación? ("diferencia entre el Oslo y el Bergen")
      const comparar = detectarComparacion(mensajeOriginal);
      if (comparar) {
        return { html: `Te los comparo:`, extra: tablaComparacionHTML(comparar) };
      }

      // Filtros estructurados: precio, color, categoría, oferta.
      const f = parsearFiltros(mensajeOriginal);
      const tieneFiltro = f.categoria || f.color || f.precioMin != null || f.precioMax != null || f.soloOferta || f.orden;
      if (tieneFiltro) {
        const conFiltro = buscarConFiltros(f, 6);
        const desc = describirFiltros(f);
        if (conFiltro.length) {
          return { html: desc ? `Esto es lo que tengo ${desc}:` : `Encontré estas opciones:`, extra: bloqueProductosHTML(conFiltro) };
        }
        // Sin resultados: se afloja el filtro de precio antes de rendirse.
        if (f.precioMax != null || f.precioMin != null) {
          const sinPrecio = buscarConFiltros({ ...f, precioMin: null, precioMax: null }, 4);
          if (sinPrecio.length) {
            return {
              html: `No tengo nada ${desc}. Lo más cercano que tengo:`,
              extra: bloqueProductosHTML(sinPrecio)
            };
          }
        }
        return { html: `No encontré productos ${desc}. ¿Querés que te muestre otras opciones, o preferís consultarnos por WhatsApp?`, whatsapp: true };
      }

      const resultados = buscarProductos(mensajeOriginal, 5);
      if (resultados.length) {
        estado.ultimaBusqueda = mensajeOriginal;

        // Si TODO lo encontrado está sin stock, se ofrecen alternativas reales
        // en el mismo mensaje, en vez de dejar al cliente en un callejón.
        const todosSinStock = resultados.every((p) => p.stock <= 0);
        if (todosSinStock) {
          const alt = alternativasPara(resultados[0], 3);
          const intro = resultados.length === 1
            ? `${esc(resultados[0].nombre)} está sin stock por ahora.`
            : `Lo que encontré está sin stock por ahora.`;
          if (alt.length) {
            return { html: `${intro} Estas sí tienen stock y son parecidas:`, extra: bloqueProductosHTML(alt) };
          }
          return { html: `${intro} Escribinos por WhatsApp y te avisamos cuando repongamos.`, whatsapp: true };
        }

        const intro = resultados.length === 1
          ? `Encontré esto en ${esc(nombreTienda())}:`
          : `Encontré estas opciones en ${esc(nombreTienda())}:`;
        return { html: intro, extra: bloqueProductosHTML(resultados) };
      }
    }

    // No se entendió / no hay datos
    return {
      html: `No tengo ese dato en este momento. Puedo derivarte directamente a nuestro WhatsApp para ayudarte mejor.`,
      whatsapp: true
    };
  }

  /* ------------------------------------------------------------------ */
  /* 5.b) CAPA DE IA (Gemini, vía el Worker de COTATO)                   */
  /* ------------------------------------------------------------------ */
  /* CÓMO SE EVITA QUE LA IA INVENTE DATOS
   * -------------------------------------
   * Gemini NUNCA escribe precios ni stock. Se le manda el catálogo como
   * contexto y se le pide que responda un JSON donde solo elige:
   *   - un texto conversacional (sin números de precio),
   *   - qué IDs de producto mostrar,
   *   - si conviene comparar o derivar a WhatsApp.
   * Las tarjetas y la tabla se arman después con el catálogo REAL del
   * navegador. Si Gemini nombra un ID que no existe, se descarta.
   * Si el Worker falla o tarda, se usa el motor de reglas de siempre. */

  const IA = {
    activa: true,          // poné false para volver al motor de reglas puro
    ruta: "/api/agente",   // endpoint en tu Worker (ver worker-agente.js)
    disponible: true,      // se apaga sola si el endpoint no existe
    historial: []          // últimos turnos, para que la charla tenga hilo
  };

  /** Versión compacta del catálogo: solo lo necesario para que la IA elija.
   *  Se recortan descripciones largas para no gastar tokens de más. */
  function catalogoParaIA() {
    const b = puente();
    const precioDe = (p) => (b && typeof b.precioFinal === "function") ? b.precioFinal(p) : Number(p.precio) || 0;
    return activos().slice(0, 120).map((p) => ({
      id: p.id,
      nombre: p.nombre,
      categoria: p.categoria || "",
      marca: p.marca || "",
      precio: precioDe(p),
      stock: Number(p.stock) || 0,
      oferta: !!p.enOferta,
      desc: String(p.descripcion || "").slice(0, 160)
    }));
  }

  async function responderConIA(mensaje) {
    const b = puente();
    if (!b || typeof b.api !== "function") throw new Error("sin api");

    const data = await b.api(IA.ruta, {
      method: "POST",
      timeoutMs: 15000,
      body: {
        mensaje,
        historial: IA.historial.slice(-6),
        catalogo: catalogoParaIA(),
        faq: leerFaqDelSitio().map((f) => ({ tema: f.pregunta, respuesta: f.respuesta })),
        tienda: {
          nombre: nombreTienda(),
          envioGratisDesde: Number(cfg().envioGratisDesde) || 0,
          tieneWhatsapp: !!whatsappNumero()
        }
      }
    });

    if (!data || typeof data.respuesta !== "string") throw new Error("respuesta inválida");

    // Solo se aceptan IDs que existan de verdad en el catálogo local.
    const catalogo = activos();
    const elegidos = (Array.isArray(data.ids) ? data.ids : [])
      .map((id) => catalogo.find((p) => p.id === id))
      .filter(Boolean)
      .slice(0, 6);

    let extra = "";
    if (data.accion === "comparar" && elegidos.length >= 2) extra = tablaComparacionHTML(elegidos);
    else if (elegidos.length) extra = bloqueProductosHTML(elegidos);

    // Gemini decide el TEXTO y decide qué PRODUCTOS mostrar por separado —
    // y nada obliga a que coincidan. Puede escribir "te muestro esto" y al
    // mismo tiempo no mandar ningún id real (o mandar ids que no existen,
    // que ya filtramos arriba por seguridad). Sin este chequeo, el cliente
    // ve una promesa sin nada abajo. Si el texto prometía productos y no
    // hay ninguno real para mostrar, se descarta ese texto y se reemplaza
    // por uno honesto — nunca se le muestra al cliente una promesa vacía.
    const prometioProductos = data.accion === "productos" || data.accion === "comparar";
    const cumplioLaPromesa = data.accion === "comparar" ? elegidos.length >= 2 : elegidos.length > 0;

    if (prometioProductos && !cumplioLaPromesa) {
      IA.historial.push({ rol: "cliente", texto: mensaje });
      IA.historial.push({ rol: "asistente", texto: "(sin resultados reales para esa búsqueda)" });
      return {
        html: `No encontré productos que coincidan. ¿Querés que te muestre otras opciones, o preferís consultarnos por WhatsApp?`,
        whatsapp: true
      };
    }

    IA.historial.push({ rol: "cliente", texto: mensaje });
    IA.historial.push({ rol: "asistente", texto: data.respuesta });

    return { html: esc(data.respuesta), extra, whatsapp: !!data.derivar_whatsapp };
  }


  /* ------------------------------------------------------------------ */
  /* 6) INTERFAZ (se inyecta sola, sin tocar el HTML del sitio)          */
  /* ------------------------------------------------------------------ */
  function inyectarEstilos() {
    const css = `
    #cotato-ag-btn {
      position: fixed; right: 18px; bottom: 18px; z-index: 9998;
      width: 46px; height: 46px; border-radius: 999px; border: none; cursor: pointer;
      background: var(--btn-fondo, #D2A362); color: var(--btn-texto, #14110F);
      box-shadow: 0 8px 20px rgba(0,0,0,.25);
      display: flex; align-items: center; justify-content: center;
      padding: 0; transition: transform .15s ease;
    }
    #cotato-ag-btn svg { width: 24px; height: 24px; display: block; }
    #cotato-ag-btn:hover { transform: scale(1.06); }
    #cotato-ag-btn .cotato-ag-badge {
      position: absolute; top: -1px; right: -1px; background: var(--vino, #B04A5F);
      color: #fff; font-size: 9px; font-weight: 800; border-radius: 999px;
      width: 15px; height: 15px; display: flex; align-items: center; justify-content: center;
    }
    #cotato-ag-panel {
      position: fixed; right: 18px; bottom: 88px; z-index: 9999;
      width: min(370px, calc(100vw - 32px)); height: min(560px, calc(100vh - 130px));
      background: var(--superficie, #1E1A17); color: var(--texto, #F2EDE5);
      border: 1px solid var(--borde, #352E29); border-radius: 18px;
      display: none; flex-direction: column; overflow: hidden;
      box-shadow: 0 20px 50px rgba(0,0,0,.35);
      font-family: 'Karla', system-ui, sans-serif;
    }
    #cotato-ag-panel.abierto { display: flex; }

    /* En celulares el panel ocupa casi toda la pantalla: más cómodo para
       leer y escribir. Se usa dvh (no vh) porque vh en mobile incluye la
       barra del navegador y el panel terminaba cortado abajo. */
    @media (max-width: 520px) {
      #cotato-ag-panel {
        right: 10px; left: 10px; bottom: 76px;
        width: auto; height: min(74dvh, calc(100dvh - 150px));
      }
    }
    #cotato-ag-head {
      padding: 14px 16px; background: var(--elevado, #282320);
      border-bottom: 1px solid var(--borde, #352E29);
      display: flex; align-items: center; justify-content: space-between; flex-shrink: 0;
    }
    #cotato-ag-head strong { font-family: 'Bricolage Grotesque', sans-serif; font-size: .95rem; }
    #cotato-ag-head span { display: block; font-size: .72rem; color: var(--humo, #9A9188); }
    #cotato-ag-cerrar { background: none; border: none; color: var(--texto, #F2EDE5); cursor: pointer; font-size: 20px; line-height: 1; padding: 4px; }
    #cotato-ag-msgs { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
    .cotato-ag-fila { display: flex; }
    .cotato-ag-fila.bot { justify-content: flex-start; }
    .cotato-ag-fila.user { justify-content: flex-end; }
    .cotato-ag-bubble {
      max-width: 85%; padding: 9px 12px; border-radius: 14px; font-size: .86rem; line-height: 1.4;
    }
    .cotato-ag-fila.bot .cotato-ag-bubble { background: var(--elevado, #282320); border-bottom-left-radius: 4px; }
    .cotato-ag-fila.user .cotato-ag-bubble { background: var(--btn-fondo, #D2A362); color: var(--btn-texto, #14110F); border-bottom-right-radius: 4px; }
    .cotato-ag-wa-btn {
      margin-top: 6px; display: inline-flex; align-items: center; gap: 6px;
      background: #25d366; color: #06210f; font-weight: 700; font-size: .78rem;
      padding: 7px 12px; border-radius: 999px; text-decoration: none;
    }
    .cotato-ag-prod-lista { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; max-width: 100%; }
    .cotato-ag-prod {
      display: flex; gap: 10px; background: var(--elevado, #282320);
      border: 1px solid var(--borde, #352E29); border-radius: 12px; padding: 8px;
    }
    .cotato-ag-prod img { width: 56px; height: 56px; object-fit: contain; border-radius: 8px; background: var(--fondo, #14110F); flex-shrink: 0; }
    .cotato-ag-prod-info { flex: 1; min-width: 0; }
    .cotato-ag-prod-nombre { font-size: .82rem; font-weight: 700; line-height: 1.2; }
    .cotato-ag-prod-precio { color: var(--precio, #D2A362); font-weight: 800; font-size: .88rem; margin-top: 2px; }
    .cotato-ag-prod-stock { font-size: .68rem; color: #4ade80; margin-top: 1px; }
    .cotato-ag-prod-stock.sin-stock { color: #f87171; }
    .cotato-ag-prod-acciones { display: flex; gap: 6px; margin-top: 6px; }
    .cotato-ag-comp-wrap { overflow-x: auto; margin-top: 6px; border: 1px solid var(--borde, #352E29); border-radius: 10px; }
    .cotato-ag-comp { width: 100%; border-collapse: collapse; font-size: .72rem; }
    .cotato-ag-comp th, .cotato-ag-comp td { padding: 6px 8px; text-align: left; border-bottom: 1px solid var(--borde, #352E29); vertical-align: top; }
    .cotato-ag-comp thead th { background: var(--elevado-2, #322C27); font-weight: 700; font-size: .7rem; }
    .cotato-ag-comp tbody tr:last-child td { border-bottom: none; }
    .cotato-ag-comp-lbl { color: var(--humo, #9A9188); font-weight: 600; white-space: nowrap; }
    .cotato-ag-prod-acciones { display: flex; gap: 5px; margin-top: 6px; flex-wrap: wrap; }
    .cotato-ag-btn-ver, .cotato-ag-btn-add, .cotato-ag-btn-comprar, .cotato-ag-btn-similares {
      font-size: .68rem; font-weight: 700; padding: 5px 9px; border-radius: 8px; cursor: pointer;
      border: 1px solid var(--borde, #352E29); background: transparent; color: var(--texto, #F2EDE5);
      min-height: 30px;
    }
    .cotato-ag-btn-add { background: rgba(210,163,98,.14); border-color: var(--btn-fondo, #D2A362); }
    .cotato-ag-btn-comprar { background: var(--btn-fondo, #D2A362); color: var(--btn-texto, #14110F); border: none; }
    .cotato-ag-btn-similares { border-color: var(--btn-fondo, #D2A362); color: var(--btn-fondo, #D2A362); }
    .cotato-ag-btn-add[disabled] { opacity: .55; cursor: default; }

    /* Botones dentro de un mensaje del bot (ej: "Ver carrito") */
    .cotato-ag-acciones-msg { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
    .cotato-ag-btn-carrito, .cotato-ag-btn-seguir {
      font-size: .74rem; font-weight: 700; padding: 6px 12px; border-radius: 999px; cursor: pointer;
      border: 1px solid var(--borde, #352E29); background: transparent; color: var(--texto, #F2EDE5);
    }
    .cotato-ag-btn-carrito { background: var(--btn-fondo, #D2A362); color: var(--btn-texto, #14110F); border: none; }

    /* Botón de reiniciar en el encabezado */
    #cotato-ag-reiniciar {
      background: none; border: none; color: var(--humo, #9A9188); cursor: pointer;
      font-size: 17px; line-height: 1; padding: 4px 6px; border-radius: 6px;
    }
    #cotato-ag-reiniciar:hover { color: var(--texto, #F2EDE5); }

    /* Indicador de escribiendo, con texto de estado si la espera se alarga */
    .cotato-ag-typing em {
      font-style: normal; font-size: .7rem; color: var(--humo, #9A9188);
      margin-left: 4px; vertical-align: 1px;
    }

    #cotato-ag-chips { display: flex; gap: 6px; padding: 0 14px 10px; flex-wrap: wrap; flex-shrink: 0; }
    .cotato-ag-chip {
      font-size: .72rem; background: var(--elevado, #282320); border: 1px solid var(--borde, #352E29);
      color: var(--texto, #F2EDE5); padding: 5px 10px; border-radius: 999px; cursor: pointer;
    }
    #cotato-ag-form { display: flex; gap: 8px; padding: 12px; border-top: 1px solid var(--borde, #352E29); flex-shrink: 0; }
    #cotato-ag-input {
      flex: 1; background: var(--elevado, #282320); border: 1px solid var(--borde, #352E29);
      color: var(--texto, #F2EDE5); border-radius: 999px; padding: 9px 14px; font-size: .85rem; outline: none;
    }
    #cotato-ag-enviar {
      background: var(--btn-fondo, #D2A362); color: var(--btn-texto, #14110F); border: none;
      border-radius: 999px; width: 38px; height: 38px; flex-shrink: 0; cursor: pointer; font-size: 16px;
    }
    .cotato-ag-typing span { display: inline-block; width: 5px; height: 5px; margin-right: 3px; border-radius: 50%; background: var(--humo, #9A9188); animation: cotatoAgBlink 1s infinite; }
    .cotato-ag-typing span:nth-child(2) { animation-delay: .15s; }
    .cotato-ag-typing span:nth-child(3) { animation-delay: .3s; }
    @keyframes cotatoAgBlink { 0%, 80%, 100% { opacity: .2; } 40% { opacity: 1; } }
    `;
    const style = document.createElement("style");
    style.id = "cotato-ag-estilos";
    style.textContent = css;
    document.head.appendChild(style);
  }

  /* Ícono de robot dibujado a mano en el mismo estilo que los íconos Lucide
     que ya usa el sitio (trazo de 2px, puntas redondeadas). Va inline como
     SVG para no depender de que lucide.createIcons() corra después. */
  const ICONO_ROBOT = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 5V3"></path>
      <circle cx="12" cy="3" r="1"></circle>
      <rect x="4" y="7" width="16" height="12" rx="3"></rect>
      <path d="M2 12v3"></path>
      <path d="M22 12v3"></path>
      <circle cx="9" cy="12" r="1.15" fill="currentColor" stroke="none"></circle>
      <circle cx="15" cy="12" r="1.15" fill="currentColor" stroke="none"></circle>
      <path d="M9.5 15.6h5"></path>
    </svg>`;

  function inyectarMarkup() {
    const btn = document.createElement("button");
    btn.id = "cotato-ag-btn";
    btn.type = "button";
    btn.setAttribute("aria-label", "Abrir asistente virtual");
    btn.setAttribute("title", "Asistente virtual");
    btn.innerHTML = `${ICONO_ROBOT}<span class="cotato-ag-badge" id="cotato-ag-badge" style="display:none">1</span>`;
    document.body.appendChild(btn);

    const panel = document.createElement("div");
    panel.id = "cotato-ag-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "false");
    panel.setAttribute("aria-label", `Asistente virtual de ${nombreTienda()}`);
    panel.innerHTML = `
      <div id="cotato-ag-head">
        <div>
          <strong>Asistente ${esc(nombreTienda())}</strong>
          <span>Respuestas al instante</span>
        </div>
        <div style="display:flex;gap:2px;align-items:center">
          <button type="button" id="cotato-ag-reiniciar" aria-label="Empezar conversación de nuevo" title="Empezar de nuevo">⟲</button>
          <button type="button" id="cotato-ag-cerrar" aria-label="Cerrar asistente">✕</button>
        </div>
      </div>
      <div id="cotato-ag-msgs" role="log" aria-live="polite" aria-relevant="additions" aria-label="Conversación con el asistente"></div>
      <div id="cotato-ag-chips">
        <button type="button" class="cotato-ag-chip" data-chip="Ver ofertas">🔥 Ofertas</button>
        <button type="button" class="cotato-ag-chip" data-chip="Costos de envío">🚚 Envíos</button>
        <button type="button" class="cotato-ag-chip" data-chip="Formas de pago">💳 Pagos</button>
        <button type="button" class="cotato-ag-chip" data-chip="¿Cómo hago un pedido?">📦 Cómo comprar</button>
        <button type="button" class="cotato-ag-chip" data-chip="Hablar con un asesor">🙋 Asesor</button>
      </div>
      <form id="cotato-ag-form" autocomplete="off">
        <input id="cotato-ag-input" type="text" placeholder="Escribí tu consulta..." maxlength="200">
        <button id="cotato-ag-enviar" type="submit" aria-label="Enviar">➤</button>
      </form>`;
    document.body.appendChild(panel);
  }

  function agregarMensaje(html, quien, extra, whatsapp) {
    const cont = document.getElementById("cotato-ag-msgs");
    const fila = document.createElement("div");
    fila.className = "cotato-ag-fila " + (quien === "user" ? "user" : "bot");
    let waHtml = "";
    if (whatsapp) {
      const numero = whatsappNumero();
      const msg = `Hola! Vengo del asistente virtual de ${nombreTienda()} y necesito ayuda.`;
      waHtml = numero
        ? `<a class="cotato-ag-wa-btn" href="${esc(linkWa(msg))}" target="_blank" rel="noopener">📲 Hablar por WhatsApp</a>`
        : "";
    }
    fila.innerHTML = `<div class="cotato-ag-bubble">${html}${extra || ""}${waHtml}</div>`;
    cont.appendChild(fila);
    cont.scrollTop = cont.scrollHeight;
    bindAccionesProducto(fila);
    guardarHistorial();
  }

  /* El indicador de "escribiendo" ahora refleja la espera REAL. Con Gemini
   * la respuesta puede tardar varios segundos: si solo se ven tres puntitos
   * quietos, parece colgado. A los 2,5s pasa a decir que está pensando, y a
   * los 7s avisa que está tardando, para que el cliente no crea que se rompió. */
  let _typingTimers = [];

  function mostrarEscribiendo() {
    const cont = document.getElementById("cotato-ag-msgs");
    const fila = document.createElement("div");
    fila.className = "cotato-ag-fila bot";
    fila.id = "cotato-ag-typing-row";
    fila.innerHTML = `<div class="cotato-ag-bubble cotato-ag-typing" aria-label="El asistente está escribiendo">
      <span></span><span></span><span></span>
      <em id="cotato-ag-typing-txt"></em>
    </div>`;
    cont.appendChild(fila);
    cont.scrollTop = cont.scrollHeight;

    const decir = (txt) => {
      const el = document.getElementById("cotato-ag-typing-txt");
      if (el) { el.textContent = txt; document.getElementById("cotato-ag-msgs").scrollTop = 9e9; }
    };
    _typingTimers = [
      setTimeout(() => decir("buscando en el catálogo…"), 2500),
      setTimeout(() => decir("un segundito más…"), 7000)
    ];
  }

  function quitarEscribiendo() {
    _typingTimers.forEach(clearTimeout);
    _typingTimers = [];
    document.getElementById("cotato-ag-typing-row")?.remove();
  }

  /* ------------------------------------------------------------------ */
  /* 6.b) PERSISTENCIA DE LA CHARLA                                      */
  /*      El sitio navega por hash (#/producto/..), así que la página no  */
  /*      se recarga — pero si el cliente refresca o vuelve más tarde,    */
  /*      la charla se recupera. sessionStorage: dura lo que la pestaña,  */
  /*      no queda guardado para siempre en el dispositivo.               */
  /* ------------------------------------------------------------------ */
  const HISTORIAL_KEY = "cotato_ag_chat";
  const MAX_GUARDADOS = 30;

  function guardarHistorial() {
    try {
      const filas = [...document.querySelectorAll("#cotato-ag-msgs .cotato-ag-fila")]
        .filter((f) => f.id !== "cotato-ag-typing-row")
        .slice(-MAX_GUARDADOS)
        .map((f) => ({
          quien: f.classList.contains("user") ? "user" : "bot",
          html: f.querySelector(".cotato-ag-bubble")?.innerHTML || ""
        }));
      sessionStorage.setItem(HISTORIAL_KEY, JSON.stringify({ filas, ia: IA.historial.slice(-6) }));
    } catch (e) { /* si el navegador no deja, simplemente no se guarda */ }
  }

  function restaurarHistorial() {
    try {
      const raw = sessionStorage.getItem(HISTORIAL_KEY);
      if (!raw) return false;
      const { filas, ia } = JSON.parse(raw);
      if (!Array.isArray(filas) || !filas.length) return false;

      const cont = document.getElementById("cotato-ag-msgs");
      filas.forEach((f) => {
        const fila = document.createElement("div");
        fila.className = "cotato-ag-fila " + (f.quien === "user" ? "user" : "bot");
        fila.innerHTML = `<div class="cotato-ag-bubble">${f.html}</div>`;
        cont.appendChild(fila);
        bindAccionesProducto(fila);   // los botones vuelven a funcionar
      });
      if (Array.isArray(ia)) IA.historial = ia;
      cont.scrollTop = cont.scrollHeight;
      return true;
    } catch (e) { return false; }
  }

  function borrarHistorial() {
    try { sessionStorage.removeItem(HISTORIAL_KEY); } catch (e) {}
    IA.historial = [];
    const cont = document.getElementById("cotato-ag-msgs");
    if (cont) cont.innerHTML = "";
  }

  function bindAccionesProducto(cont) {
    cont.querySelectorAll("[data-ver]").forEach((btn) => btn.addEventListener("click", () => {
      const b = puente();
      if (b && typeof b.irAProducto === "function") b.irAProducto(btn.dataset.ver);
      else location.hash = "#/producto/" + btn.dataset.ver;
      cerrarPanel();
    }));

    // Agregar al carrito: confirma en el chat y ofrece ir al carrito.
    cont.querySelectorAll("[data-add]").forEach((btn) => btn.addEventListener("click", () => {
      if (btn.disabled) return;
      const p = productos().find((x) => x.id === btn.dataset.add);
      const b = puente();
      if (!p || !b || typeof b.agregarAlCarrito !== "function") return;
      b.agregarAlCarrito(p, 1);
      btn.textContent = "✓";
      btn.disabled = true;
      setTimeout(() => { btn.textContent = "Agregar"; btn.disabled = false; }, 1800);
      agregarMensaje(
        `Agregué <strong>${esc(p.nombre)}</strong> a tu carrito.`,
        "bot",
        `<div class="cotato-ag-acciones-msg">
           <button type="button" class="cotato-ag-btn-carrito" data-abrir-carrito="1">Ver carrito</button>
           <button type="button" class="cotato-ag-btn-seguir" data-seguir="1">Seguir viendo</button>
         </div>`
      );
    }));

    // Comprar ahora: agrega y abre el checkout directo.
    cont.querySelectorAll("[data-comprar]").forEach((btn) => btn.addEventListener("click", () => {
      const p = productos().find((x) => x.id === btn.dataset.comprar);
      const b = puente();
      if (!p || !b || typeof b.agregarAlCarrito !== "function") return;
      b.agregarAlCarrito(p, 1);
      if (typeof b.abrirCheckout === "function") {
        cerrarPanel();
        b.abrirCheckout();
      } else if (typeof b.abrirCarrito === "function") {
        cerrarPanel();
        b.abrirCarrito();
      }
    }));

    // Sin stock: mostrar alternativas reales con stock.
    cont.querySelectorAll("[data-similares]").forEach((btn) => btn.addEventListener("click", () => {
      const p = productos().find((x) => x.id === btn.dataset.similares);
      if (!p) return;
      const alt = alternativasPara(p, 3);
      if (!alt.length) {
        agregarMensaje(`Por ahora no tengo otras opciones con stock. Escribinos por WhatsApp y te avisamos cuando repongamos.`, "bot", "", true);
        return;
      }
      agregarMensaje(`Estas tienen stock ahora y son parecidas a ${esc(p.nombre)}:`, "bot", bloqueProductosHTML(alt));
    }));

    // Botones de los mensajes de confirmación.
    cont.querySelectorAll("[data-abrir-carrito]").forEach((btn) => btn.addEventListener("click", () => {
      const b = puente();
      if (b && typeof b.abrirCarrito === "function") { cerrarPanel(); b.abrirCarrito(); }
    }));
    cont.querySelectorAll("[data-seguir]").forEach((btn) => btn.addEventListener("click", () => {
      btn.closest(".cotato-ag-acciones-msg")?.remove();
      document.getElementById("cotato-ag-input")?.focus();
    }));
  }

  async function enviarMensajeUsuario(texto) {
    if (!texto.trim()) return;
    agregarMensaje(esc(texto), "user");
    mostrarEscribiendo();

    let r = respuestaIdentidad(texto);
    if (r) await new Promise((res) => setTimeout(res, 300));

    // 1) Primero se intenta la IA (charla fluida, entiende cualquier frase).
    if (!r && IA.activa && IA.disponible && puente()) {
      try {
        r = await responderConIA(texto);
      } catch (e) {
        console.warn("[agente] IA no disponible, se usa el motor de reglas:", e && e.message);
        // Si el endpoint no existe (404) no se reintenta más en esta sesión.
        if (String(e && e.message).includes("404")) IA.disponible = false;
      }
    }

    // 2) Si la IA falló o está apagada, responde el motor de reglas local.
    //    Nunca se queda mudo ni inventa: siempre hay una respuesta válida.
    if (!r) {
      await new Promise((res) => setTimeout(res, 350));
      r = responder(texto);
    }

    quitarEscribiendo();
    agregarMensaje(r.html, "bot", r.extra, r.whatsapp);
    registrarInsight(texto, r);
  }

  /** Manda al Worker qué se preguntó y si se pudo resolver, para que desde
   *  el panel se vea qué le falta al catálogo o a la FAQ. No manda nombre,
   *  teléfono ni ningún dato personal — solo el texto de la pregunta.
   *  "Fire and forget": si falla, no afecta la respuesta al cliente. */
  function registrarInsight(pregunta, resultado) {
    const b = puente();
    if (!b || typeof b.api !== "function") return;
    try {
      b.api("/api/chat-insights", {
        method: "POST",
        timeoutMs: 5000,
        body: {
          pregunta: String(pregunta || "").slice(0, 300),
          // "Resuelto" = se le mostró algo concreto (texto propio o productos),
          // no derivó en seco a WhatsApp por no tener idea de qué contestar.
          resuelto: !resultado.whatsapp || !!resultado.extra,
          via: resultado.extra ? "producto" : (resultado.whatsapp ? "otro" : "faq")
        }
      }).catch(() => {}); // si falla, no importa: es solo estadística
    } catch (e) { /* nunca debe romper la conversación */ }
  }

  /* ------------------------------------------------------------------ */
  /* 6.c) TECLADO EN CELULARES                                           */
  /*      Cuando se abre el teclado virtual, el navegador NO achica la    */
  /*      ventana: el panel sigue "midiendo" lo mismo y el campo de       */
  /*      escritura queda tapado abajo. visualViewport sí informa el alto */
  /*      real visible, así que se usa para reajustar el panel en vivo.   */
  /* ------------------------------------------------------------------ */
  function initTecladoMovil() {
    const vv = window.visualViewport;
    if (!vv) return;   // navegadores viejos: se queda con el CSS de siempre

    const panel = document.getElementById("cotato-ag-panel");
    if (!panel) return;

    const ajustar = () => {
      if (!panel.classList.contains("abierto")) return;
      // Cuánto del alto de la ventana se está comiendo el teclado.
      const tapado = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      if (tapado > 100) {
        // Teclado abierto: el panel se apoya justo encima de él.
        panel.style.bottom = `${tapado + 8}px`;
        panel.style.height = `${Math.max(260, vv.height - 96)}px`;
      } else {
        // Teclado cerrado: vuelve a los valores del CSS.
        panel.style.bottom = "";
        panel.style.height = "";
      }
      // Que el último mensaje quede siempre a la vista.
      const msgs = document.getElementById("cotato-ag-msgs");
      if (msgs) msgs.scrollTop = msgs.scrollHeight;
    };

    vv.addEventListener("resize", ajustar);
    vv.addEventListener("scroll", ajustar);
    document.getElementById("cotato-ag-input")?.addEventListener("focus", () => setTimeout(ajustar, 250));
  }

  function abrirPanel() {
    document.getElementById("cotato-ag-panel").classList.add("abierto");
    document.getElementById("cotato-ag-badge").style.display = "none";
    document.getElementById("cotato-ag-input").focus();
  }
  function cerrarPanel() {
    document.getElementById("cotato-ag-panel").classList.remove("abierto");
  }

  function initListeners() {
    const btn = document.getElementById("cotato-ag-btn");
    const panel = document.getElementById("cotato-ag-panel");
    btn.addEventListener("click", () => {
      panel.classList.contains("abierto") ? cerrarPanel() : abrirPanel();
    });
    document.getElementById("cotato-ag-cerrar").addEventListener("click", cerrarPanel);
    document.getElementById("cotato-ag-reiniciar").addEventListener("click", () => {
      borrarHistorial();
      estado.esperandoProvincia = false;
      estado.ultimaBusqueda = "";
      mensajeBienvenida();
      document.getElementById("cotato-ag-input")?.focus();
    });
    document.getElementById("cotato-ag-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const input = document.getElementById("cotato-ag-input");
      const val = input.value;
      input.value = "";
      enviarMensajeUsuario(val);
    });
    document.querySelectorAll(".cotato-ag-chip").forEach((chip) => {
      chip.addEventListener("click", () => enviarMensajeUsuario(chip.dataset.chip));
    });
  }

  function mensajeBienvenida() {
    agregarMensaje(
      `¡Hola! 👋 Soy el asistente virtual de <strong>${esc(nombreTienda())}</strong>. Puedo ayudarte a encontrar carteras, mochilas y bolsos, contarte precios, stock, envíos y formas de pago. ¿En qué te ayudo?`,
      "bot"
    );
  }

  /* ------------------------------------------------------------------ */
  /* 7) ARRANQUE                                                         */
  /* ------------------------------------------------------------------ */
  function iniciar() {
    inyectarEstilos();
    inyectarMarkup();
    initListeners();
    initTecladoMovil();
    // Si el cliente ya venía charlando en esta pestaña, se retoma donde quedó.
    if (!restaurarHistorial()) mensajeBienvenida();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", iniciar);
  } else {
    iniciar();
  }
})();
