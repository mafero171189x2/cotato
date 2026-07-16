// ============================================================================
// Auth propio con WebCrypto — reemplaza Firebase Auth.
// - Passwords: PBKDF2 (100.000 iteraciones, salt aleatorio por usuario).
// - Sesión: JWT firmado con HMAC-SHA256, guardado en cookie httpOnly.
// ============================================================================

const encoder = new TextEncoder();

function toBase64Url(bytes) {
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64Url(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// ---------------------------------------------------------------------------
// Hash de contraseñas (PBKDF2-SHA256)
// ---------------------------------------------------------------------------
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    key,
    256
  );
  return `${toBase64Url(salt)}.${toBase64Url(new Uint8Array(bits))}`;
}

export async function verifyPassword(password, stored) {
  const [saltB64, hashB64] = String(stored || "").split(".");
  if (!saltB64 || !hashB64) return false;
  const salt = fromBase64Url(saltB64);
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    key,
    256
  );
  const computed = toBase64Url(new Uint8Array(bits));
  // Comparación en tiempo constante
  if (computed.length !== hashB64.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ hashB64.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// JWT (HMAC-SHA256)
// ---------------------------------------------------------------------------
async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function firmarJWT(payload, secret, expiraEnSeg = 60 * 60 * 24 * 30) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + expiraEnSeg };
  const headerB64 = toBase64Url(encoder.encode(JSON.stringify(header)));
  const bodyB64 = toBase64Url(encoder.encode(JSON.stringify(body)));
  const data = `${headerB64}.${bodyB64}`;
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return `${data}.${toBase64Url(new Uint8Array(sig))}`;
}

export async function verificarJWT(token, secret) {
  if (!token) return null;
  const partes = token.split(".");
  if (partes.length !== 3) return null;
  const [headerB64, bodyB64, sigB64] = partes;
  const key = await hmacKey(secret);
  const valido = await crypto.subtle.verify("HMAC", key, fromBase64Url(sigB64), encoder.encode(`${headerB64}.${bodyB64}`));
  if (!valido) return null;
  const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(bodyB64)));
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null;
  return payload;
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------
export function cookieSesion(nombre, token, maxAgeSeg) {
  return `${nombre}=${token}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${maxAgeSeg}`;
}
export function cookieBorrar(nombre) {
  return `${nombre}=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`;
}
export function leerCookie(request, nombre) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${nombre}=([^;]+)`));
  return match ? match[1] : null;
}
