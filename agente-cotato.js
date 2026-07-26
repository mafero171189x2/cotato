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
   - Editá FAQ_COTATO más abajo con tus propias preguntas frecuentes reales
     (tiempos de fabricación, cambios/devoluciones, garantía, etc.). El
     agente NO inventa estas respuestas: son las que vos cargues acá.
   - Los colores se toman solos de las variables CSS del sitio (--laton,
     --superficie, --texto, etc.), así que respeta el tema claro/oscuro
     sin que haya que tocar nada.
   ========================================================================== */
(function () {
  "use strict";

  /* ------------------------------------------------------------------ */
  /* 0) PREGUNTAS FRECUENTES — completá esto con info real de tu tienda  */
  /* ------------------------------------------------------------------ */
  /* Estas respuestas son EXACTAMENTE las de la sección "Preguntas frecuentes"
   * del sitio (#/faq). Si actualizás una allá, actualizala también acá para
   * que el asistente no diga algo distinto a la página. */
  const FAQ_COTATO = [
    {
      claves: ["como hago un pedido", "cómo hago un pedido", "como compro", "cómo compro", "como comprar", "cómo comprar", "hacer un pedido", "como pido", "cómo pido"],
      respuesta: "Elegís tus productos, los agregás al carrito y completás tus datos de envío. Al confirmar, se abre WhatsApp con tu pedido ya armado para que coordinemos el resto."
    },
    {
      claves: ["hacen envios a todo el pais", "envian a todo el pais", "envían a todo el país", "todo el pais", "todo el país", "correo argentino", "que correo", "qué correo"],
      respuesta: "Sí, enviamos a todo el país por Correo Argentino u otros correos, según lo que más te convenga."
    },
    {
      claves: ["cuanto tarda", "cuánto tarda", "cuanto tardan", "cuánto tardan", "tiempo de entrega", "cuando llega", "cuándo llega", "demora", "en cuanto llega"],
      respuesta: "Una vez confirmado el pago, preparamos el envío en las siguientes 24-48 horas hábiles. El tiempo de entrega depende del correo y tu ubicación."
    },
    {
      claves: ["cambiar o devolver", "cambio", "cambios", "devolucion", "devolución", "devoluciones", "devolver", "no me gusto", "no me gustó", "defecto", "fallado", "vino mal"],
      respuesta: "Los cambios y devoluciones aplican únicamente por defecto de fábrica. Si tu producto llegó con algún defecto, contactanos por WhatsApp dentro de los primeros días de recibido y coordinamos el cambio."
    },
    {
      claves: ["pedido confirmado", "estado de mi pedido", "seguimiento", "como se si", "cómo sé si", "mi pedido", "donde esta mi pedido", "dónde está mi pedido"],
      respuesta: 'Podés ver el estado de todos tus pedidos en la sección "Mi cuenta". Ahí también vas a encontrar un botón para retomar la conversación por WhatsApp si quedó algo pendiente de coordinar.'
    },
    {
      claves: ["eliminar mi cuenta", "borrar mi cuenta", "dar de baja", "eliminar cuenta", "borrar cuenta", "darme de baja"],
      respuesta: 'Sí, en cualquier momento. Desde "Mi cuenta" encontrás la opción para eliminar tu cuenta de forma definitiva. Al hacerlo, se eliminan tus datos personales y de acceso (contraseña, dirección, teléfono, carrito guardado). Los pedidos que ya hayas realizado se conservan en nuestros registros comerciales, sin quedar asociados a ninguna cuenta activa, para dar cumplimiento a nuestras obligaciones contables.'
    },
    {
      claves: ["cambiar mi contrasena", "cambiar mi contraseña", "cambiar contrasena", "cambiar contraseña", "olvide mi contrasena", "olvidé mi contraseña", "recuperar contrasena", "recuperar contraseña", "no recuerdo mi clave", "resetear clave"],
      respuesta: 'Sí. Podés cambiarla cuando quieras desde "Mi cuenta". Si no la recordás, en la pantalla de inicio de sesión contás con la opción "Olvidé mi contraseña", que te permite establecer una nueva a través de un enlace enviado a tu correo electrónico.'
    },
    {
      claves: ["local fisico", "local físico", "tienen local", "tienen negocio", "puedo ir", "retiro por local", "direccion del local", "dirección del local", "showroom", "atienden al publico"],
      respuesta: "Trabajamos únicamente de forma online. Podés hacer todas tus consultas por WhatsApp desde la sección Contacto."
    }
  ];

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
          <button type="button" class="cotato-ag-btn-ver" data-ver="${esc(p.id)}">Ver detalle</button>
          <button type="button" class="cotato-ag-btn-add" data-add="${esc(p.id)}" ${sinStock ? "disabled" : ""}>${sinStock ? "Sin stock" : "Agregar"}</button>
        </div>
      </div>
    </div>`;
  }

  function bloqueProductosHTML(lista) {
    if (!lista.length) return "";
    return `<div class="cotato-ag-prod-lista">${lista.map(tarjetaProductoHTML).join("")}</div>`;
  }

  /* ------------------------------------------------------------------ */
  /* 5) MOTOR DE INTENCIONES (reglas en español, sin inventar datos)     */
  /* ------------------------------------------------------------------ */
  const estado = { esperandoProvincia: false, ultimaBusqueda: "" };

  function responder(mensajeOriginal) {
    const t = normalizar(mensajeOriginal);

    // Si el puente no existe (index.html sin el bloque del asistente), no se
    // puede garantizar ningún dato: se avisa en vez de improvisar.
    if (!puente()) {
      return { html: `No puedo acceder al catálogo en este momento. Escribinos por WhatsApp y te respondemos enseguida.`, whatsapp: true };
    }

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

    // Preguntas frecuentes (mismas respuestas que la sección #/faq del sitio).
    // Va ANTES de envíos/pagos a propósito: "¿cuánto tarda en llegar?" tiene
    // que responder el plazo real, no el detector genérico de envíos.
    const faq = FAQ_COTATO.find((f) => contieneAlguna(t, f.claves));
    if (faq) return { html: faq.respuesta };

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

    // Pagos
    if (contieneAlguna(t, ["pago", "pagos", "como pago", "cómo pago", "pagar", "transferencia", "efectivo", "tarjeta", "cuotas", "mercado pago", "mercadopago", "alias", "cbu"])) {
      let msg = `Podés pagar por <strong>transferencia bancaria</strong> o mediante la aplicación de pagos que prefieras (Mercado Pago u otras equivalentes). Una vez confirmado el pedido, te enviamos por WhatsApp el alias o los datos correspondientes junto con el total final (productos más envío) para que realices el pago y nos hagas llegar el comprobante.`;
      msg += ` Además, muchos de nuestros productos tienen un <strong>precio especial pagando con transferencia</strong>.`;
      return { html: msg };
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
      const resultados = buscarProductos(mensajeOriginal, 5);
      if (resultados.length) {
        estado.ultimaBusqueda = mensajeOriginal;
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
    .cotato-ag-btn-ver, .cotato-ag-btn-add {
      font-size: .7rem; font-weight: 700; padding: 5px 8px; border-radius: 8px; cursor: pointer; border: 1px solid var(--borde, #352E29);
      background: transparent; color: var(--texto, #F2EDE5);
    }
    .cotato-ag-btn-add { background: var(--btn-fondo, #D2A362); color: var(--btn-texto, #14110F); border: none; }
    .cotato-ag-btn-add[disabled] { opacity: .4; cursor: default; }
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
    panel.innerHTML = `
      <div id="cotato-ag-head">
        <div>
          <strong>Asistente ${esc(nombreTienda())}</strong>
          <span>Respuestas al instante</span>
        </div>
        <button type="button" id="cotato-ag-cerrar" aria-label="Cerrar">✕</button>
      </div>
      <div id="cotato-ag-msgs"></div>
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
  }

  function mostrarEscribiendo() {
    const cont = document.getElementById("cotato-ag-msgs");
    const fila = document.createElement("div");
    fila.className = "cotato-ag-fila bot";
    fila.id = "cotato-ag-typing-row";
    fila.innerHTML = `<div class="cotato-ag-bubble cotato-ag-typing"><span></span><span></span><span></span></div>`;
    cont.appendChild(fila);
    cont.scrollTop = cont.scrollHeight;
  }
  function quitarEscribiendo() {
    document.getElementById("cotato-ag-typing-row")?.remove();
  }

  function bindAccionesProducto(cont) {
    cont.querySelectorAll("[data-ver]").forEach((btn) => btn.addEventListener("click", () => {
      const b = puente();
      if (b && typeof b.irAProducto === "function") b.irAProducto(btn.dataset.ver);
      else location.hash = "#/producto/" + btn.dataset.ver;
      cerrarPanel();
    }));
    cont.querySelectorAll("[data-add]").forEach((btn) => btn.addEventListener("click", () => {
      if (btn.disabled) return;
      const p = productos().find((x) => x.id === btn.dataset.add);
      const b = puente();
      if (!p || !b || typeof b.agregarAlCarrito !== "function") return;
      b.agregarAlCarrito(p, 1);
      if (typeof b.mostrarToast === "function") b.mostrarToast("Agregado al carrito", "success");
      btn.textContent = "✓ Agregado";
      setTimeout(() => (btn.textContent = "Agregar"), 1400);
    }));
  }

  function enviarMensajeUsuario(texto) {
    if (!texto.trim()) return;
    agregarMensaje(esc(texto), "user");
    mostrarEscribiendo();
    // Pequeña demora simulando "está escribiendo" — mejora la sensación de agente real,
    // pero la respuesta siempre sale del catálogo real, sin inventar nada.
    setTimeout(() => {
      quitarEscribiendo();
      const r = responder(texto);
      agregarMensaje(r.html, "bot", r.extra, r.whatsapp);
    }, 450);
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
    mensajeBienvenida();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", iniciar);
  } else {
    iniciar();
  }
})();
