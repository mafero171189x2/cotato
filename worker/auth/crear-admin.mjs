// Genera el INSERT SQL para crear el primer admin, con el MISMO formato de
// hash que usa el Worker (PBKDF2-SHA256, 100000 iteraciones, salt 16 bytes).
//
// Uso:
//   node worker/auth/crear-admin.mjs admin@tutienda.com "unaPasswordSegura123"
//
// Después copiá el INSERT que imprime y ejecutalo con:
//   wrangler d1 execute cotato-db --remote --command "PEGAR_AQUI_EL_INSERT"

import { randomBytes, pbkdf2Sync, randomUUID } from "node:crypto";

const [, , email, password] = process.argv;
if (!email || !password) {
  console.error('Uso: node crear-admin.mjs <email> <password>');
  process.exit(1);
}
if (password.length < 6) {
  console.error("La contraseña debe tener al menos 6 caracteres.");
  process.exit(1);
}

function toBase64Url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, 100000, 32, "sha256");
const stored = `${toBase64Url(salt)}.${toBase64Url(hash)}`;
const id = randomUUID();

const sql = `INSERT INTO admins (id, email, password_hash) VALUES ('${id}', '${email.toLowerCase()}', '${stored}');`;
console.log("\nEjecutá esto contra tu D1 remoto:\n");
console.log(sql);
console.log("");
