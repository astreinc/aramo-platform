// Test doubles shared by unit tests (never imported by app code).
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { FetchFn } from '../api/http';
import type { SecureKeyValue } from '../auth/secureKeyValue';
import type { CipherPort, FilePort } from '../state/encryptedStore';
import type { CryptoPort } from '../auth/pkce';
import { base64Decode, base64Encode } from '../util/bytes';

export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown> | undefined;
}

export type Responder = (
  req: RecordedRequest,
) =>
  | { status: number; body?: unknown; headers?: Record<string, string> }
  | Promise<{ status: number; body?: unknown; headers?: Record<string, string> }>;

/** A fetch that records every request and answers from `responder`. */
export function recordingFetch(responder: Responder): { fetch: FetchFn; calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const headers = { ...(init.headers as Record<string, string>) };
    const body =
      typeof init.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    const req: RecordedRequest = { url, method: String(init.method), headers, body };
    calls.push(req);
    const r = await responder(req);
    const text = r.body === undefined ? '' : JSON.stringify(r.body);
    const h = new Map(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const res = {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
      text: async () => text,
    };
    return res as unknown as Response;
  };
  return { fetch: fetchFn, calls };
}

export function memoryKv(): SecureKeyValue & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    getItem: async (k) => items.get(k) ?? null,
    setItem: async (k, v) => {
      items.set(k, v);
    },
    deleteItem: async (k) => {
      items.delete(k);
    },
  };
}

export const nodeCrypto: CryptoPort = {
  randomBytes: (n) => new Uint8Array(randomBytes(n)),
  sha256: async (d) => new Uint8Array(createHash('sha256').update(d).digest()),
};

/** AES-256-GCM with Node crypto, same wire format as the expo-crypto adapter (iv||ct||tag). */
export const nodeAesGcm: CipherPort = {
  generateKey: async () => base64Encode(new Uint8Array(randomBytes(32))),
  encrypt: async (plaintext, keyB64, aad) => {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', Buffer.from(base64Decode(keyB64)), iv);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(Buffer.from(plaintext)), c.final()]);
    return base64Encode(new Uint8Array(Buffer.concat([iv, ct, c.getAuthTag()])));
  },
  decrypt: async (sealedB64, keyB64, aad) => {
    const all = Buffer.from(base64Decode(sealedB64));
    const iv = all.subarray(0, 12);
    const tag = all.subarray(all.length - 16);
    const ct = all.subarray(12, all.length - 16);
    const d = createDecipheriv('aes-256-gcm', Buffer.from(base64Decode(keyB64)), iv);
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(tag);
    return new Uint8Array(Buffer.concat([d.update(ct), d.final()]));
  },
};

export function memoryFiles(): FilePort & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    read: async (n) => files.get(n) ?? null,
    write: async (n, c) => {
      files.set(n, c);
    },
    remove: async (n) => {
      files.delete(n);
    },
    list: async () => [...files.keys()],
  };
}

/** A syntactically valid unsigned JWT carrying `sub` (client never verifies tokens). */
export function fakeJwt(sub: string): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc({ sub, consumer: 'sign', client: 'native' })}.sig`;
}

export const TOKEN_A = 'tok_A_' + 'a'.repeat(40);
export const SIGNING_TOKEN = 'Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5';
