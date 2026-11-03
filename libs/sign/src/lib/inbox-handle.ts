import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Aramo Sign W2 — the opaque item id of a DISCOVERED inbox item
// (Aramo-Sign-W2-Inbox-Discovery-Gate5-Plan-and-Amendment-v1_0-LOCKED §A3.4, Lead C3).
//
//   format      AES-256-GCM over {v, signer_id, user_id, iat, exp} under the server key
//               SIGN_INBOX_HANDLE_KEY (32 bytes, base64; no default). Authenticated: any
//               change to the handle fails decryption. base64url(iv | ciphertext | tag).
//   short-lived exp = iat + 30 minutes; every list issues fresh handles.
//   user-bound  redemption requires user_id = the authenticated subject.
//   not a capability  a handle only names which recipient row to check; the sign route
//               re-runs the whole discovery rule and today's revalidation before minting.
//
// Without the key there is no discovery at all (fail closed): the list returns bound items
// only and every handle is refused.

export const INBOX_HANDLE_KEY_ENV = 'SIGN_INBOX_HANDLE_KEY';
export const INBOX_HANDLE_TTL_MS = 30 * 60 * 1000;
const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
// A handle is a few hundred characters; anything far longer is refused before decoding.
const MAX_HANDLE_LENGTH = 512;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface InboxHandleClaims {
  v: number;
  signer_id: string;
  user_id: string;
  iat: number;
  exp: number;
}

// The configured key, or null (absent, empty or not exactly 32 bytes) — null means OFF.
export function inboxHandleKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = env[INBOX_HANDLE_KEY_ENV];
  if (raw === undefined || raw.trim() === '') return null;
  const k = Buffer.from(raw.trim(), 'base64');
  return k.length === 32 ? k : null;
}

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function mintInboxHandle(key: Buffer, item: { signer_id: string; user_id: string }, now: Date = new Date()): string {
  const iat = Math.floor(now.getTime() / 1000);
  const claims: InboxHandleClaims = { v: VERSION, signer_id: item.signer_id, user_id: item.user_id, iat, exp: iat + INBOX_HANDLE_TTL_MS / 1000 };
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(claims), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, ct, cipher.getAuthTag()]).toString('base64url');
}

// The claims of a handle that decrypts under `key`, is well formed, unexpired and was
// issued to `user_id`; null for every other case (one answer: no oracle).
export function openInboxHandle(key: Buffer, handle: string, user_id: string, now: Date = new Date()): InboxHandleClaims | null {
  if (handle.length === 0 || handle.length > MAX_HANDLE_LENGTH || !/^[A-Za-z0-9_-]+$/.test(handle)) return null;
  const raw = Buffer.from(handle, 'base64url');
  // Canonical encoding only: a changed padding bit in the last character decodes to the same
  // bytes, so any string that is not exactly what was issued is refused.
  if (raw.length <= IV_BYTES + TAG_BYTES || raw.toString('base64url') !== handle) return null;
  let claims: unknown;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES));
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    const clear = Buffer.concat([decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)), decipher.final()]);
    claims = JSON.parse(clear.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof claims !== 'object' || claims === null) return null;
  const c = claims as Partial<InboxHandleClaims>;
  if (c.v !== VERSION || typeof c.signer_id !== 'string' || !isUuid(c.signer_id) || typeof c.user_id !== 'string') return null;
  if (typeof c.iat !== 'number' || typeof c.exp !== 'number' || c.exp - c.iat !== INBOX_HANDLE_TTL_MS / 1000) return null;
  if (c.exp * 1000 <= now.getTime()) return null;
  if (c.user_id !== user_id) return null;
  return c as InboxHandleClaims;
}
