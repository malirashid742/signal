// AES-256-GCM encryption for stored session cookies (behind-login monitoring).
// Key lives only in COOKIE_ENCRYPTION_KEY (Render + GitHub Actions secrets) —
// never in the database, never sent to the client after it's saved. This is an
// app-level secret, separate from Supabase entirely — consistent with this
// project's rule of never touching the Supabase service_role key.
const crypto = require("crypto");

function getKey() {
  const raw = process.env.COOKIE_ENCRYPTION_KEY;
  if (!raw) throw new Error("COOKIE_ENCRYPTION_KEY is not set — behind-login monitoring is disabled until it's configured.");
  // Accept either a 32-byte hex/base64 string or any passphrase (hashed down to 32 bytes).
  return crypto.createHash("sha256").update(raw).digest();
}

function encryptCookie(plainText) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // store as iv:tag:ciphertext, all base64
  return [iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(":");
}

function decryptCookie(stored) {
  if (!stored) return null;
  const key = getKey();
  const [ivB64, tagB64, dataB64] = stored.split(":");
  if (!ivB64 || !tagB64 || !dataB64) return null;
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString("utf8");
}

module.exports = { encryptCookie, decryptCookie };
