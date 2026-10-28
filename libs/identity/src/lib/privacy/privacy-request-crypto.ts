import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

// Aramo-Sign-Mobile-Amendment-M-A7 §3.1 — a web requester's email is the only
// direct identifier the privacy-request capability keeps, and it keeps it as
//   - a keyed hash (HMAC-SHA256) for lookups (status by reference + email, rate
//     limits), never reversible without the key;
//   - an AES-256-GCM ciphertext so the Aramo privacy team can reply.
// Both use the service key PRIVACY_REQUEST_EMAIL_KEY (32 bytes, base64). Without
// the key the public web request path fails closed (nothing is stored in clear).
// The one-time proof token is stored as SHA-256 only.

const VERSION = 'v1';
const KEY_ENV = 'PRIVACY_REQUEST_EMAIL_KEY';

function key(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = env[KEY_ENV];
  if (raw === undefined || raw.trim() === '') return null;
  const k = Buffer.from(raw.trim(), 'base64');
  return k.length === 32 ? k : null;
}

export function privacyEmailKeyAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return key(env) !== null;
}

/** Lower-cased, trimmed. The same normalization for hashing and for identity lookups. */
export function normalizePrivacyEmail(email: string): string {
  return email.trim().toLowerCase();
}

// A conservative shape check (the proof email is the real validation).
const EMAIL_SHAPE = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,63}$/;
export function isPlausibleEmail(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 320 && EMAIL_SHAPE.test(v.trim());
}

export function privacyEmailHash(email: string, env: NodeJS.ProcessEnv = process.env): string {
  const k = key(env);
  if (k === null) throw new Error(`${KEY_ENV} is not configured`);
  return createHmac('sha256', k).update(`privacy-request-email:${normalizePrivacyEmail(email)}`).digest('hex');
}

export function encryptPrivacyEmail(email: string, env: NodeJS.ProcessEnv = process.env): string {
  const k = key(env);
  if (k === null) throw new Error(`${KEY_ENV} is not configured`);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([cipher.update(normalizePrivacyEmail(email), 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptPrivacyEmail(stored: string, env: NodeJS.ProcessEnv = process.env): string {
  const k = key(env);
  if (k === null) throw new Error(`${KEY_ENV} is not configured`);
  const [v, iv, tag, ct] = stored.split('.');
  if (v !== VERSION || iv === undefined || tag === undefined || ct === undefined) throw new Error('unrecognised privacy email format');
  const decipher = createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

/** A new one-time proof token (base64url, 256 bits) and its stored SHA-256. */
export function newPrivacyProofToken(): { token: string; token_hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, token_hash: privacyProofTokenHash(token) };
}

export function privacyProofTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
