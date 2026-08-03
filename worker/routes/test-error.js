/* ==========================================================================
   COTATO — routes/test-error.js
   --------------------------------------------------------------------------
   Ruta de diagnóstico, SOLO para el dueño/admin: dispara a propósito una
   excepción real para poder probar de punta a punta que la alerta de error
   por mail (enviarEmailErrorWorker, en worker/auth/mailer.js) está andando,
   sin tener que esperar a que aparezca un bug de verdad.

   NO toca la base de datos, NO modifica nada, NO tiene efectos secundarios
   más allá de disparar el mail de alerta — es completamente seguro de usar
   las veces que haga falta.

   CÓMO USARLA
   Con el navegador logueado en el panel admin (así la cookie de sesión ya
   está puesta), entrá directo a esta URL:
     https://TU-WORKER.workers.dev/api/admin/test-error
   Vas a ver en pantalla el JSON de error genérico que también ve cualquier
   error real ({"error":"Error interno del servidor"}) — eso es lo esperado,
   confirma que el catch-all de index.js lo agarró. Y en unos segundos
   debería llegarte el mail de alerta a GMAIL_ERROR_TO (o GMAIL_USER si esa
   variable no está seteada).

   Por qué requiere admin: para que nadie de afuera pueda hacer que tu
   Worker mande mails de alerta a lo loco (spam a tu propia casilla).
   ========================================================================== */

import { requiereAdmin } from "../auth/middleware.js";

export async function handleTestError(request, env, url) {
  await requiereAdmin(request, env); // si no sos admin, esto corta acá con 403 (y no dispara nada)
  throw new Error("Error de prueba — disparado a propósito desde /api/admin/test-error para comprobar el mail de alertas. Todo bien, esto es esperado.");
}
