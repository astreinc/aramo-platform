import type { FetchLike } from '../index.js';

export interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = Response | ((r: Recorded) => Response);

/** A fetch that answers in order and records each request. */
export function fakeFetch(replies: Reply[]): FetchLike & { calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const r: Recorded = { url, method: init?.method ?? 'GET', headers, body: init?.body ?? null };
    calls.push(r);
    const next = replies.shift();
    if (next === undefined) throw new Error(`unexpected request ${r.method} ${url}`);
    return typeof next === 'function' ? next(r) : next;
  }) as FetchLike & { calls: Recorded[] };
  fn.calls = calls;
  return fn;
}

export function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export function bytesRes(bytes: Uint8Array, status = 200): Response {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Response(copy.buffer, { status });
}

export const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF');

export function textOf(body: unknown): string {
  if (typeof body === 'string') return body;
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
  return '';
}
