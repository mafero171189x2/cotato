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
          <p><a href="${link}">Tocá acá para crear una contraseña nueva</a></p>
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
  const msg = MENSAJES_ESTADO[pedido.estado] || { asunto: "Actualización de tu pedido", texto: `Tu pedido cambió de estado a: ${pedido.estado}.` };
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
          <p>Hola${pedido.cliente?.nombre ? " " + pedido.cliente.nombre : ""},</p>
          <p>${msg.texto}</p>
          <p><strong>Pedido:</strong> ${pedido.numeroPedido}<br>
          <strong>Estado actual:</strong> ${pedido.estado}</p>
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
  const listaItems = pedido.items.map((i) => `${i.cantidad}x ${i.nombre} — $${(i.precio * i.cantidad).toLocaleString("es-AR")}`).join("<br>");
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
        subject: `🛒 Nuevo pedido ${pedido.numeroPedido} — $${pedido.total.toLocaleString("es-AR")}`,
        html: `
          <p>Entró un pedido nuevo en COTATO.</p>
          <p><strong>Pedido:</strong> ${pedido.numeroPedido}<br>
          <strong>Cliente:</strong> ${pedido.clienteNombre}<br>
          <strong>Teléfono:</strong> ${pedido.clienteTelefono || "—"}</p>
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
