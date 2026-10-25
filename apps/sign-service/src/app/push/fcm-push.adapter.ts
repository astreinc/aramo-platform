import { createPrivateKey, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { PushMessage, PushSendResult } from './push-delivery.port.js';

// Aramo Sign Mobile — the FCM adapter (M-A3 §2): the HTTP v1 API, authorized with a
// Google service-account OAuth token (an RS256 JWT-bearer assertion exchanged at
// the account's token_uri), with node's own crypto + fetch (no SDK). Configuration:
//   FCM_PROJECT_ID            the Firebase project id
//   FCM_SERVICE_ACCOUNT_PATH  path to the service-account JSON key file
// The access token is cached until a minute before it expires. The device token is
// sent in the request body only and never logged.

export interface FcmServiceAccount {
  client_email: string;
  private_key: string;
  token_uri: string;
}

export interface FcmConfig {
  projectId: string;
  account: FcmServiceAccount;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const TIMEOUT_MS = 10_000;
const MAX_TOKEN = 4096;

const b64url = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

export function fcmConfigFromEnv(env: NodeJS.ProcessEnv = process.env, read: (p: string) => string = (p) => readFileSync(p, 'utf8')): FcmConfig | null {
  const projectId = env['FCM_PROJECT_ID']?.trim();
  const path = env['FCM_SERVICE_ACCOUNT_PATH']?.trim();
  if (!projectId || !path) return null;
  const raw = JSON.parse(read(path)) as Partial<FcmServiceAccount>;
  if (typeof raw.client_email !== 'string' || typeof raw.private_key !== 'string') throw new Error('FCM service account file is missing client_email or private_key');
  return { projectId, account: { client_email: raw.client_email, private_key: raw.private_key, token_uri: typeof raw.token_uri === 'string' ? raw.token_uri : DEFAULT_TOKEN_URI } };
}

export function fcmAssertion(key: KeyObject, account: FcmServiceAccount, nowSeconds: number): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: account.client_email, scope: SCOPE, aud: account.token_uri, iat: nowSeconds, exp: nowSeconds + 3600 }));
  const signature = cryptoSign('sha256', Buffer.from(`${header}.${claims}`), key);
  return `${header}.${claims}.${b64url(signature)}`;
}

// FCM data values must be strings.
function stringData(data: PushMessage['data']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) out[k] = String(v);
  return out;
}

export class FcmPushAdapter {
  private readonly key: KeyObject;
  private access: { token: string; expiresAt: number } | null = null;

  constructor(
    private readonly config: FcmConfig,
    private readonly fetchFn: FetchLike = (url, init) => fetch(url, init),
    private readonly now: () => number = () => Date.now(),
  ) {
    this.key = createPrivateKey(config.account.private_key);
  }

  private async accessToken(): Promise<string | null> {
    const t = this.now();
    if (this.access !== null && t < this.access.expiresAt - 60_000) return this.access.token;
    const assertion = fcmAssertion(this.key, this.config.account, Math.floor(t / 1000));
    const res = await this.fetchFn(this.config.account.token_uri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status !== 200) return null;
    const body = JSON.parse(await res.text()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string') return null;
    const ttl = typeof body.expires_in === 'number' ? body.expires_in : 3600;
    this.access = { token: body.access_token, expiresAt: t + ttl * 1000 };
    return this.access.token;
  }

  async send(token: string, message: PushMessage): Promise<PushSendResult> {
    if (token.length === 0 || token.length > MAX_TOKEN) return { outcome: 'unregistered', error_code: 'fcm_malformed_token' };
    let bearer: string | null;
    try {
      bearer = await this.accessToken();
    } catch {
      return { outcome: 'retry', error_code: 'fcm_oauth_network' };
    }
    if (bearer === null) return { outcome: 'retry', error_code: 'fcm_oauth_refused' };
    const body = {
      message: {
        token,
        notification: { title: message.title, body: message.body },
        data: stringData(message.data),
        android: { priority: 'high', ...(message.badge !== undefined ? { notification: { notification_count: message.badge } } : {}) },
      },
    };
    let res: { status: number; text(): Promise<string> };
    try {
      res = await this.fetchFn(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.config.projectId)}/messages:send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return { outcome: 'retry', error_code: 'fcm_network' };
    }
    if (res.status === 200) return { outcome: 'sent' };
    let errorCode = '';
    try {
      const err = (JSON.parse(await res.text()) as { error?: { status?: string; details?: Array<{ errorCode?: string }> } }).error;
      errorCode = err?.details?.find((d) => typeof d.errorCode === 'string')?.errorCode ?? err?.status ?? '';
    } catch {
      errorCode = '';
    }
    const code = `fcm_${res.status}${errorCode !== '' ? `_${errorCode.replace(/[^A-Za-z0-9_]/g, '')}` : ''}`.slice(0, 64);
    if (res.status === 404 || errorCode === 'UNREGISTERED' || errorCode === 'SENDER_ID_MISMATCH') return { outcome: 'unregistered', error_code: code };
    if (res.status === 401) {
      this.access = null;
      return { outcome: 'retry', error_code: code };
    }
    if (res.status === 429 || res.status >= 500) return { outcome: 'retry', error_code: code };
    return { outcome: 'failed', error_code: code };
  }
}
