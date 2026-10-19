import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Sign Unified Product S-5 — webhook signing secrets are ISOLATED per
// subscription and stored ENCRYPTED: AES-256-GCM under the service key
// ESIGN_WEBHOOK_SECRET_KEY (32 bytes, base64). Without the key, no subscription
// can be created and no subscription delivery is signed (fail closed). A secret
// is returned to the subscriber exactly once (creation / rotation).

const VERSION = 'v1';

function key(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = env['ESIGN_WEBHOOK_SECRET_KEY'];
  if (raw === undefined || raw.trim() === '') return null;
  const k = Buffer.from(raw.trim(), 'base64');
  return k.length === 32 ? k : null;
}

export function webhookSecretsAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return key(env) !== null;
}

export const newWebhookSecret = (): string => `whs_${randomBytes(32).toString('base64url')}`;

export function encryptWebhookSecret(secret: string, env: NodeJS.ProcessEnv = process.env): string {
  const k = key(env);
  if (k === null) throw new Error('ESIGN_WEBHOOK_SECRET_KEY is not configured');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptWebhookSecret(stored: string, env: NodeJS.ProcessEnv = process.env): string {
  const k = key(env);
  if (k === null) throw new Error('ESIGN_WEBHOOK_SECRET_KEY is not configured');
  const [v, iv, tag, ct] = stored.split('.');
  if (v !== VERSION || iv === undefined || tag === undefined || ct === undefined) throw new Error('unrecognised secret format');
  const decipher = createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}
