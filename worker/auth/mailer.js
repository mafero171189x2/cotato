// Envío de emails transaccionales por SMTP de Gmail, usando tu propia cuenta.
// Ventaja sobre Resend/Brevo: NO necesita dominio propio verificado, porque
// el mail sale realmente de los servidores de Google (con tu Gmail real como
// remitente) — así que llega a cualquier destinatario, no solo a vos.
//
// Requiere en el Worker (ver README):
//   - env.GMAIL_USER          → variable normal en wrangler.toml, tu email de Gmail
//   - env.GMAIL_APP_PASSWORD  → secreto, wrangler secret put GMAIL_APP_PASSWORD
//                                (una "contraseña de aplicación" de Google,
//                                NO tu contraseña normal de Gmail — se genera
//                                en myaccount.google.com con 2FA activado)
import { WorkerMailer } from "worker-mailer";

/** Escapa texto antes de meterlo en el HTML del mail.
 *  Sin esto, un cliente podía poner HTML en su nombre o teléfono al hacer el
 *  checkout y ese HTML llegaba tal cual al mail del admin — por ejemplo un
 *  <a href> con un link de phishing dentro de un mail que parece legítimo
 *  porque sale de la propia tienda. */
function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function enviarEmailReset(env, destinatarioEmail, link) {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
    console.error("Falta GMAIL_USER o GMAIL_APP_PASSWORD — no se pudo enviar el mail de recuperación");
    return false;
  }
  try {
    await WorkerMailer.send(
      {
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        authType: "login",
        credentials: { username: env.GMAIL_USER, password: env.GMAIL_APP_PASSWORD }
      },
      {
        from: { name: "COTATO", email: env.GMAIL_USER },
        to: destinatarioEmail,
        subject: "Recuperar tu contraseña — COTATO",
        html: `
          <p>Recibimos un pedido para restablecer tu contraseña en COTATO.</p>
          <p><a href="${esc(link)}">Tocá acá para crear una contraseña nueva</a></p>
          <p>Este link vence en 1 hora. Si vos no pediste esto, podés ignorar este mail tranquilamente.</p>
        `
      }
    );
    return true;
  } catch (err) {
    console.error("Error enviando mail vía Gmail SMTP:", err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Aviso de estado de pedido — lo dispara el admin a mano con el botón
// "Enviar aviso" en el panel (no es automático).
// ---------------------------------------------------------------------------
const MENSAJES_ESTADO = {
  pendiente: { asunto: "Recibimos tu pedido", texto: "Recibimos tu pedido y está pendiente de confirmación de pago." },
  pagado: { asunto: "¡Confirmamos tu pago!", texto: "Confirmamos el pago de tu pedido. Ya lo estamos preparando." },
  preparacion: { asunto: "Estamos preparando tu pedido", texto: "Tu pedido está en preparación." },
  enviado: { asunto: "¡Tu pedido está en camino!", texto: "Tu pedido fue despachado y está en camino." },
  entregado: { asunto: "Tu pedido fue entregado", texto: "Registramos tu pedido como entregado. ¡Gracias por tu compra!" },
  cancelado: { asunto: "Tu pedido fue cancelado", texto: "Tu pedido fue cancelado. Si tenés dudas, contactanos." }
};

export async function enviarEmailEstadoPedido(env, destinatarioEmail, pedido) {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
    console.error("Falta GMAIL_USER o GMAIL_APP_PASSWORD — no se pudo enviar el aviso de pedido");
    return false;
  }
  const msg = MENSAJES_ESTADO[pedido.estado] || { asunto: "Actualización de tu pedido", texto: `Tu pedido cambió de estado a: ${esc(pedido.estado)}.` };
  try {
    await WorkerMailer.send(
      {
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        authType: "login",
        credentials: { username: env.GMAIL_USER, password: env.GMAIL_APP_PASSWORD }
      },
      {
        from: { name: "COTATO", email: env.GMAIL_USER },
        to: destinatarioEmail,
        subject: `${msg.asunto} — Pedido ${pedido.numeroPedido}`,
        html: `
          <p>Hola${pedido.cliente?.nombre ? " " + esc(pedido.cliente.nombre) : ""},</p>
          <p>${msg.texto}</p>
          <p><strong>Pedido:</strong> ${esc(pedido.numeroPedido)}<br>
          <strong>Estado actual:</strong> ${esc(pedido.estado)}</p>
          <p>Cualquier consulta, respondé este mail o escribinos.</p>
        `
      }
    );
    return true;
  } catch (err) {
    console.error("Error enviando aviso de pedido vía Gmail SMTP:", err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Aviso de PEDIDO NUEVO — este sí es automático, se dispara solo en cada
// checkout (a diferencia del aviso de cambio de estado, que es manual).
// Se manda al email de contacto configurado en la tienda (o al de Gmail si
// no hay uno cargado).
// ---------------------------------------------------------------------------
export async function enviarEmailNuevoPedidoAdmin(env, destinatarioEmail, pedido) {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
    console.error("Falta GMAIL_USER o GMAIL_APP_PASSWORD — no se pudo avisar del pedido nuevo");
    return false;
  }
  const listaItems = pedido.items.map((i) => `${Number(i.cantidad) || 0}x ${esc(i.nombre)} — $${(i.precio * i.cantidad).toLocaleString("es-AR")}`).join("<br>");
  try {
    await WorkerMailer.send(
      {
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        authType: "login",
        credentials: { username: env.GMAIL_USER, password: env.GMAIL_APP_PASSWORD }
      },
      {
        from: { name: "COTATO", email: env.GMAIL_USER },
        to: destinatarioEmail,
        subject: `🛒 Nuevo pedido ${esc(pedido.numeroPedido)} — $${pedido.total.toLocaleString("es-AR")}`,
        html: `
          <p>Entró un pedido nuevo en COTATO.</p>
          <p><strong>Pedido:</strong> ${esc(pedido.numeroPedido)}<br>
          <strong>Cliente:</strong> ${esc(pedido.clienteNombre)}<br>
          <strong>Teléfono:</strong> ${esc(pedido.clienteTelefono) || "—"}</p>
          <p><strong>Productos:</strong><br>${listaItems}</p>
          <p><strong>Subtotal:</strong> $${pedido.total.toLocaleString("es-AR")}<br>
          <strong>Envío:</strong> $${pedido.envio.toLocaleString("es-AR")}<br>
          <strong>Total:</strong> $${(pedido.total + pedido.envio).toLocaleString("es-AR")}</p>
          <p>Entrá al panel para confirmarlo.</p>
        `
      }
    );
    return true;
  } catch (err) {
    console.error("Error avisando pedido nuevo vía Gmail SMTP:", err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Alerta de error inesperado — se dispara sola desde el catch-all de
// worker/index.js, no requiere que nadie la llame a mano. Sirve para
// enterarte de un problema real sin tener que estar mirando los logs.
// No se manda para errores esperados (401, 404, etc.), solo para excepciones
// de verdad (bugs, timeouts, fallas de la base).
// ---------------------------------------------------------------------------
let _ultimoAvisoError = 0;
export async function enviarEmailErrorWorker(env, detalle) {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) return false;
  // Como mucho un mail cada 10 minutos — si algo se rompe en loop, no te
  // inunda la casilla, pero te enterás igual del primer error.
  const ahora = Date.now();
  if (ahora - _ultimoAvisoError < 10 * 60 * 1000) return false;
  _ultimoAvisoError = ahora;
  try {
    await WorkerMailer.send(
      {
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        authType: "login",
        credentials: { username: env.GMAIL_USER, password: env.GMAIL_APP_PASSWORD }
      },
      {
        from: { name: "COTATO — Alertas", email: env.GMAIL_USER },
        to: env.GMAIL_USER,
        subject: `⚠️ Error en COTATO: ${detalle.mensaje}`,
        html: `
          <p>Se produjo un error inesperado en el Worker.</p>
          <p><strong>Ruta:</strong> ${detalle.metodo} ${detalle.url}<br>
          <strong>Error:</strong> ${detalle.mensaje}</p>
          <p style="color:#888">Si esto se repite seguido, avisá a quien te ayudó a armar la tienda.</p>
        `
      }
    );
    return true;
  } catch (err) {
    console.error("No se pudo enviar la alerta de error:", err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Mail de bienvenida — se manda solo al crear una cuenta de cliente nueva.
// ---------------------------------------------------------------------------
export async function enviarEmailBienvenida(env, destinatarioEmail, nombreCliente) {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) return false;
  try {
    await WorkerMailer.send(
      {
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        authType: "login",
        credentials: { username: env.GMAIL_USER, password: env.GMAIL_APP_PASSWORD }
      },
      {
        from: { name: "COTATO", email: env.GMAIL_USER },
        to: destinatarioEmail,
        subject: "¡Bienvenido/a a COTATO!",
        html: `
          <p>Hola${nombreCliente ? " " + nombreCliente : ""},</p>
          <p>Tu cuenta en COTATO ya está lista. Desde "Mi cuenta" podés ver tus pedidos, tus datos y tus favoritos.</p>
        `
      }
    );
    return true;
  } catch (err) {
    console.error("No se pudo enviar el mail de bienvenida:", err);
    return false;
  }
}
