/* ==========================================================================
   COTATO — routes/alerta-modelo.js
   --------------------------------------------------------------------------
   Detecta cuando Gemini devuelve 404 — el código típico cuando un modelo fue
   discontinuado (ya pasó con gemini-2.0-flash, dado de baja el 1/6/2026) o
   el nombre está mal escrito — y avisa por mail usando el mismo sistema que
   ya usás para errores generales del Worker.

   Por qué solo 404 y no cualquier error: un 500 o un timeout de Gemini son
   fallas transitorias (ya quedan en los logs, no ameritan un mail cada vez).
   Un 404 significa "este modelo ya no existe" — eso SÍ hay que arreglarlo a
   mano (cambiando GEMINI_MODELO en wrangler.toml), así que amerita avisar.

   Se usa desde las tres rutas que llaman a Gemini: agente.js (chat del
   cliente), admin-ia.js y admin-analisis.js (panel admin).
   ========================================================================== */

import { enviarEmailErrorWorker } from "../auth/mailer.js";

// Evita mandar un mail por cada consulta mientras el modelo está roto: como
// mucho uno cada 6 horas por instancia del Worker. Si Cloudflare recicla la
// instancia antes, en el peor caso llega algún mail de más — nunca de menos.
const COOLDOWN_MS = 6 * 60 * 60 * 1000;
let ultimoAviso = 0;

/** Llamar dentro del "if (!res.ok)" de cada ruta que usa Gemini, pasándole
 *  la Response ya recibida y una descripción corta de qué falló. */
export async function avisarSiModeloRoto(env, res, contexto) {
  if (res.status !== 404) return; // otros códigos no son "modelo discontinuado"

  const ahora = Date.now();
  if (ahora - ultimoAviso < COOLDOWN_MS) return; // ya se avisó hace poco
  ultimoAviso = ahora;

  const modelo = env.GEMINI_MODELO || "(el que esté harcodeado en el código)";
  try {
    await enviarEmailErrorWorker(env, {
      mensaje:
        `Gemini devolvió 404 en ${contexto}. El modelo configurado ` +
        `(${modelo}) probablemente fue discontinuado por Google — es el ` +
        `mismo síntoma que pasó con gemini-2.0-flash el 1/6/2026. ` +
        `Solución: actualizá GEMINI_MODELO en wrangler.toml con un modelo ` +
        `vigente y hacé push. Mientras tanto, esa función de IA está caída ` +
        `(el resto del sitio sigue funcionando normal).`,
      url: contexto,
      metodo: "GEMINI"
    });
  } catch (e) {
    // Si ni el mail de aviso se pudo mandar, que no rompa el flujo normal:
    // el error real ya se logueó aparte en cada ruta.
    console.error("No se pudo enviar el aviso de modelo roto:", e);
  }
}
