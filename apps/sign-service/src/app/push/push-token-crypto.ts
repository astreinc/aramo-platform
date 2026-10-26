import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// Aramo Sign Mobile — provider push tokens are stored ENCRYPTED at rest (M-A3 §2):
// AES-256-GCM under the service key SIGN_PUSH_TOKEN_KEY (32 bytes, base64), the
// same envelope format as the webhook secrets (integrations/webhook-secrets.ts)
// but under its own key. Without the key no device can be registered (fail closed)
// and no stored token can be read. The digest (sha256) finds a token registered
// on another device session without decrypting anything.

const VERSION = 'v1';

function key(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = env['SIGN_PUSH_TOKEN_KEY'];
  if (raw === undefined || raw.trim() === '') return null;
  const k = Buffer.from(raw.trim(), 'base64');
  return k.length === 32 ? k : null;
}

export function pushTokenKeyAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return key(env) !== null;
}

export function pushTokenDigest(provider: string, token: string): string {
  return createHash('sha256').update(`${provider}:${token}`).digest('hex');
}

export function encryptPushToken(token: string, env: NodeJS.ProcessEnv = process.env): string {
  const k = key(env);
  if (k === null) throw new Error('SIGN_PUSH_TOKEN_KEY is not configured');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptPushToken(stored: string, env: NodeJS.ProcessEnv = process.env): string {
  const k = key(env);
  if (k === null) throw new Error('SIGN_PUSH_TOKEN_KEY is not configured');
  const [v, iv, tag, ct] = stored.split('.');
  if (v !== VERSION || iv === undefined || tag === undefined || ct === undefined) throw new Error('unrecognised push token format');
  const decipher = createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}
