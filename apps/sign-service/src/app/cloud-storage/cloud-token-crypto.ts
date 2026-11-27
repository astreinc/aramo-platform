import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// SIGN-FREE-PARITY-1 S6 — cloud storage OAuth tokens (and the pending PKCE verifier) are
// stored ENCRYPTED at rest: AES-256-GCM under the service key SIGN_CLOUD_TOKEN_KEY (32 bytes,
// base64), the same envelope format as the push tokens (push/push-token-crypto.ts) but under
// its own key. Without the key no account can be connected (fail closed) and no stored
// token can be read, so every provider reports unavailable.

const VERSION = 'v1';
export const CLOUD_TOKEN_KEY_ENV = 'SIGN_CLOUD_TOKEN_KEY';

function key(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = env[CLOUD_TOKEN_KEY_ENV];
  if (raw === undefined || raw.trim() === '') return null;
  const k = Buffer.from(raw.trim(), 'base64');
  return k.length === 32 ? k : null;
}

export function cloudTokenKeyAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return key(env) !== null;
}

export function encryptCloudToken(token: string, env: NodeJS.ProcessEnv = process.env): string {
  const k = key(env);
  if (k === null) throw new Error(`${CLOUD_TOKEN_KEY_ENV} is not configured`);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptCloudToken(stored: string, env: NodeJS.ProcessEnv = process.env): string {
  const k = key(env);
  if (k === null) throw new Error(`${CLOUD_TOKEN_KEY_ENV} is not configured`);
  const [v, iv, tag, ct] = stored.split('.');
  if (v !== VERSION || iv === undefined || tag === undefined || ct === undefined) throw new Error('unrecognised cloud token format');
  const decipher = createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}
