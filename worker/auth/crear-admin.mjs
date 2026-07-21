// Genera el INSERT SQL para crear el primer admin, con el MISMO formato de
// hash que usa el Worker (PBKDF2-SHA256, 100000 iteraciones, salt 16 bytes).
//
// Uso (la contraseña se pide por teclado, NO se pasa por argumento):
//   node worker/auth/crear-admin.mjs admin@tutienda.com
//
// Antes la contraseña iba como argumento y quedaba guardada en el historial
// de la terminal (~/.bash_history) y visible en la lista de procesos.
//
// Después copiá el INSERT que imprime y ejecutalo con:
//   wrangler d1 execute cotato-db --remote --command "PEGAR_AQUI_EL_INSERT"

import { randomBytes, pbkdf2Sync, randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const MIN_PASSWORD = 8;

const [, , emailArg] = process.argv;
if (!emailArg) {
  console.error("Uso: node crear-admin.mjs <email>");
  process.exit(1);
}

const email = emailArg.toLowerCase().trim();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 120) {
  console.error("Ese email no parece válido.");
  process.exit(1);
}

const rl = createInterface({ input: stdin, output: stdout });
const password = await rl.question(`Contraseña para ${email} (mínimo ${MIN_PASSWORD} caracteres): `);
const repetir = await rl.question("Repetila: ");
rl.close();

if (password.length < MIN_PASSWORD) {
  console.error(`\nLa contraseña debe tener al menos ${MIN_PASSWORD} caracteres.`);
  process.exit(1);
}
if (password !== repetir) {
  console.error("\nLas contraseñas no coinciden.");
  process.exit(1);
}

function toBase64Url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Escapa comillas simples para SQL. Antes el email se concatenaba crudo:
 *  un email con apóstrofo rompía el INSERT (o permitía inyectar SQL). */
function sqlLiteral(v) {
  return `'${String(v).replace(/'/g, "''")}'`;
}

const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, 100000, 32, "sha256");
const stored = `${toBase64Url(salt)}.${toBase64Url(hash)}`;
const id = randomUUID();

const sql = `INSERT INTO admins (id, email, password_hash, token_version) VALUES (${sqlLiteral(id)}, ${sqlLiteral(email)}, ${sqlLiteral(stored)}, 0);`;
console.log("\nEjecutá esto contra tu D1 remoto:\n");
console.log(sql);
console.log("");
