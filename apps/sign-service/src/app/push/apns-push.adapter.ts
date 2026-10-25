import { createPrivateKey, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect, constants, type ClientHttp2Session, type OutgoingHttpHeaders } from 'node:http2';

import type { PushMessage, PushSendResult } from './push-delivery.port.js';

// Aramo Sign Mobile — the APNs adapter (M-A3 §2): token-based authentication
// (an ES256 provider JWT signed with the team's .p8 key) over HTTP/2, with node's
// own http2 + crypto (no SDK). Configuration:
//   APNS_KEY_ID       the key's id (JWT header kid)
//   APNS_TEAM_ID      the Apple developer team id (JWT iss)
//   APNS_KEY_PATH     path to the AuthKey_<id>.p8 file (PEM, PKCS#8 EC P-256)
//   APNS_TOPIC        the app's bundle id (ai.aramo.sign)
//   APNS_ENVIRONMENT  production (default) | sandbox (development builds)
// The provider JWT is reused for 50 minutes (Apple accepts 20 to 60). The device
// token is validated as hex before it is put in the request path, and is never
// logged.

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  keyPem: string;
  topic: string;
  environment: 'production' | 'sandbox';
}

export interface Http2Reply {
  status: number;
  body: string;
}

// The transport, injectable for tests: POST `body` to `origin` with `headers`.
export type Http2Requester = (origin: string, headers: OutgoingHttpHeaders, body: string, timeoutMs: number) => Promise<Http2Reply>;

const JWT_TTL_MS = 50 * 60 * 1000;
const TIMEOUT_MS = 10_000;
const APNS_TOKEN = /^[0-9a-fA-F]{32,200}$/;

export const APNS_ORIGINS = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
} as const;

const b64url = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

export function apnsConfigFromEnv(env: NodeJS.ProcessEnv = process.env, read: (p: string) => string = (p) => readFileSync(p, 'utf8')): ApnsConfig | null {
  const keyId = env['APNS_KEY_ID']?.trim();
  const teamId = env['APNS_TEAM_ID']?.trim();
  const keyPath = env['APNS_KEY_PATH']?.trim();
  const topic = env['APNS_TOPIC']?.trim();
  if (!keyId || !teamId || !keyPath || !topic) return null;
  const environment = env['APNS_ENVIRONMENT']?.trim() === 'sandbox' ? 'sandbox' : 'production';
  return { keyId, teamId, keyPem: read(keyPath), topic, environment };
}

// The ES256 provider token: header {alg, kid}, claims {iss, iat}, a raw (r||s) signature.
export function apnsProviderJwt(key: KeyObject, keyId: string, teamId: string, nowSeconds: number): string {
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const claims = b64url(JSON.stringify({ iss: teamId, iat: nowSeconds }));
  const signature = cryptoSign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${header}.${claims}.${b64url(signature)}`;
}

// The default transport: one cached HTTP/2 session per origin, dropped on error.
export function createHttp2Requester(): Http2Requester {
  const sessions = new Map<string, ClientHttp2Session>();
  const sessionFor = (origin: string): ClientHttp2Session => {
    const cached = sessions.get(origin);
    if (cached !== undefined && !cached.closed && !cached.destroyed) return cached;
    const s = connect(origin);
    s.on('error', () => sessions.delete(origin));
    s.on('close', () => sessions.delete(origin));
    s.unref();
    sessions.set(origin, s);
    return s;
  };
  return (origin, headers, body, timeoutMs) =>
    new Promise<Http2Reply>((resolve, reject) => {
      let session: ClientHttp2Session;
      try {
        session = sessionFor(origin);
      } catch (err) {
        reject(err);
        return;
      }
      const req = session.request(headers);
      let status = 0;
      const chunks: Buffer[] = [];
      req.setTimeout(timeoutMs, () => req.close(constants.NGHTTP2_CANCEL));
      req.on('response', (h) => {
        status = Number(h[':status'] ?? 0);
      });
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => (status === 0 ? reject(new Error('apns stream closed')) : resolve({ status, body: Buffer.concat(chunks).toString('utf8') })));
      req.on('error', reject);
      req.end(body);
    });
}

export class ApnsPushAdapter {
  private readonly key: KeyObject;
  private jwt: { token: string; minted: number } | null = null;

  constructor(
    private readonly config: ApnsConfig,
    private readonly request: Http2Requester = createHttp2Requester(),
    private readonly now: () => number = () => Date.now(),
  ) {
    this.key = createPrivateKey(config.keyPem);
  }

  private providerToken(): string {
    const t = this.now();
    if (this.jwt === null || t - this.jwt.minted >= JWT_TTL_MS) {
      this.jwt = { token: apnsProviderJwt(this.key, this.config.keyId, this.config.teamId, Math.floor(t / 1000)), minted: t };
    }
    return this.jwt.token;
  }

  async send(token: string, message: PushMessage): Promise<PushSendResult> {
    if (!APNS_TOKEN.test(token)) return { outcome: 'unregistered', error_code: 'apns_malformed_token' };
    const payload: Record<string, unknown> = {
      aps: {
        alert: { title: message.title, body: message.body },
        sound: 'default',
        ...(message.badge !== undefined ? { badge: message.badge } : {}),
      },
      ...message.data,
    };
    const headers: OutgoingHttpHeaders = {
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      authorization: `bearer ${this.providerToken()}`,
      'apns-topic': this.config.topic,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': String(Math.floor(this.now() / 1000) + 24 * 60 * 60),
      'content-type': 'application/json',
    };
    let reply: Http2Reply;
    try {
      reply = await this.request(APNS_ORIGINS[this.config.environment], headers, JSON.stringify(payload), TIMEOUT_MS);
    } catch {
      return { outcome: 'retry', error_code: 'apns_network' };
    }
    if (reply.status === 200) return { outcome: 'sent' };
    let reason = '';
    try {
      reason = String((JSON.parse(reply.body) as { reason?: unknown }).reason ?? '');
    } catch {
      reason = '';
    }
    const code = `apns_${reply.status}${reason !== '' ? `_${reason.replace(/[^A-Za-z0-9]/g, '')}` : ''}`.slice(0, 64);
    if (reply.status === 410 || reason === 'Unregistered' || reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic') {
      return { outcome: 'unregistered', error_code: code };
    }
    if (reply.status === 403 && reason === 'ExpiredProviderToken') {
      this.jwt = null;
      return { outcome: 'retry', error_code: code };
    }
    if (reply.status === 429 || reply.status >= 500) return { outcome: 'retry', error_code: code };
    return { outcome: 'failed', error_code: code };
  }
}
