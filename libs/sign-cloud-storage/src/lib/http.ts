import { CloudProviderError, type CloudProviderErrorKind, type FetchLike } from './types.js';

// Plain fetch helpers shared by the four provider clients. No provider SDK: each client is a
// handful of documented REST calls. A provider's response body is never put in an error
// message (it can carry file names or account details); only the status is.

const TIMEOUT_MS = 30_000;

export function kindOfStatus(status: number): CloudProviderErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  return 'failed';
}

export async function call(fetchFn: FetchLike, url: string, init: RequestInit = {}, okStatuses: readonly number[] = []): Promise<Response> {
  let res: Response;
  try {
    res = await fetchFn(url, { ...init, signal: init.signal ?? AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new CloudProviderError('failed', null, 'provider request failed');
  }
  if (!res.ok && !okStatuses.includes(res.status)) {
    await res.body?.cancel().catch(() => undefined);
    throw new CloudProviderError(kindOfStatus(res.status), res.status, `provider answered ${res.status}`);
  }
  return res;
}

export async function json<T>(res: Response): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    throw new CloudProviderError('failed', res.status, 'provider answered with unreadable JSON');
  }
}

/** Read a body, stopping (and refusing) past `max` bytes. */
export async function readLimited(res: Response, max: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined);
    throw new CloudProviderError('too_large', res.status, 'file is larger than the limit');
  }
  if (res.body === null) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new CloudProviderError('too_large', res.status, 'file is larger than the limit');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

export function bearer(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${token}`, ...extra };
}

/** The lower-case extension of a file name, without the dot ('' when none). */
export function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

export function offered(name: string, extensions: readonly string[]): boolean {
  return extensions.includes(extensionOf(name));
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** A Uint8Array as a fetch body (a copy into a plain ArrayBuffer, which every runtime accepts). */
export function bodyOf(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
