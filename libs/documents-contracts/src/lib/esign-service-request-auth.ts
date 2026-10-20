import { createHmac, timingSafeEqual } from 'node:crypto';

// ES-2 (Aramo-E-Sign-ES-2-Core-Service-Trust-Implementation-Authorization-v1_0)
// — authentication of sign-service → Core (apps/api) service requests.
//
// ONE definition shared by the signer (apps/sign-service) and the verifier
// (apps/api), so the canonical form cannot drift between the two sides.
//
// Scheme `aramo-sign-s2s-v1`: HMAC-SHA256 (base64) over the canonical string
//
//     aramo-sign-s2s-v1 \n METHOD \n exact-path \n normalized-query \n timestamp
//
// keyed by the shared E-Sign secret (SIGN_WEBHOOK_SIGNING_SECRET, ruling B-1).
//
// Domain separation from the lifecycle webhook (which signs `${timestamp}.${body}`):
// a webhook message always starts with decimal digits and '.', an s2s message
// always starts with the literal scheme tag, so neither signature can verify as
// the other; the headers are distinct as well.
//
// What the signature binds: method, exact request path (all path parameters,
// e.g. the revision id), every query parameter (e.g. tenant_id) and the
// timestamp. It authenticates the CALLER as sign-service only — it is never a
// signer authorization and never replaces the route's own tenant/document checks.
//
// Recorded residual (Lead ruling, refinement 1): there is no nonce store, so a
// captured IDENTICAL request (same method, path, query) can be replayed until its
// timestamp leaves the ±ESIGN_S2S_TIMESTAMP_TOLERANCE_SEC window. Accepted for the
// read-only source endpoint; a captured request cannot be re-targeted to another
// revision, tenant or route.

export const ESIGN_S2S_SCHEME = 'aramo-sign-s2s-v1';
export const ESIGN_S2S_TIMESTAMP_HEADER = 'x-aramo-sign-s2s-timestamp';
export const ESIGN_S2S_SIGNATURE_HEADER = 'x-aramo-sign-s2s-signature';
export const ESIGN_S2S_TIMESTAMP_TOLERANCE_SEC = 300;

export type EsignS2sVerifyReason = 'NO_SECRET' | 'MISSING' | 'MALFORMED' | 'STALE' | 'BAD_SIGNATURE';

export interface EsignS2sVerifyResult {
  ok: boolean;
  reason?: EsignS2sVerifyReason;
}

// Normalized query: pairs sorted by key, each component percent-encoded with
// encodeURIComponent, joined with '&'. A repeated key is MALFORMED (null) — an
// authorization-relevant parameter must have exactly one unambiguous value.
export function normalizeEsignS2sQuery(rawQuery: string): string | null {
  const q = rawQuery.startsWith('?') ? rawQuery.slice(1) : rawQuery;
  if (q.length === 0) return '';
  const pairs: [string, string][] = [];
  const seen = new Set<string>();
  for (const [k, v] of new URLSearchParams(q)) {
    if (seen.has(k)) return null;
    seen.add(k);
    pairs.push([k, v]);
  }
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

export function canonicalEsignS2sRequest(input: { method: string; path: string; query: string; timestamp: string }): string {
  return [ESIGN_S2S_SCHEME, input.method.toUpperCase(), input.path, input.query, input.timestamp].join('\n');
}

export function computeEsignS2sSignature(canonical: string, secret: string): string {
  return createHmac('sha256', secret).update(canonical, 'utf8').digest('base64');
}

// Signer side: the headers to attach to a request for `url`. Throws on a
// malformed query rather than sending a request the verifier must reject.
export function signEsignServiceRequest(input: { method: string; url: string; secret: string; nowSec: number }): Record<string, string> {
  const u = new URL(input.url);
  const query = normalizeEsignS2sQuery(u.search);
  if (query === null) throw new Error('esign s2s: repeated query parameter cannot be signed');
  const timestamp = String(Math.floor(input.nowSec));
  const signature = computeEsignS2sSignature(canonicalEsignS2sRequest({ method: input.method, path: u.pathname, query, timestamp }), input.secret);
  return { [ESIGN_S2S_TIMESTAMP_HEADER]: timestamp, [ESIGN_S2S_SIGNATURE_HEADER]: signature };
}

// Verifier side. Fail-closed order: secret → header presence → timestamp shape →
// window → path/query shape → length check → constant-time compare.
export function verifyEsignServiceRequest(input: {
  method: string;
  path: string;
  rawQuery: string;
  timestampHeader: string | undefined;
  signatureHeader: string | undefined;
  secret: string | undefined;
  nowSec: number;
  toleranceSec?: number;
}): EsignS2sVerifyResult {
  const tolerance = input.toleranceSec ?? ESIGN_S2S_TIMESTAMP_TOLERANCE_SEC;
  if (input.secret === undefined || input.secret.length === 0) return { ok: false, reason: 'NO_SECRET' };
  const ts = input.timestampHeader;
  const sig = input.signatureHeader;
  if (ts === undefined || ts.length === 0 || sig === undefined || sig.length === 0) return { ok: false, reason: 'MISSING' };
  if (!/^\d{1,12}$/.test(ts)) return { ok: false, reason: 'MALFORMED' };
  if (Math.abs(input.nowSec - Number(ts)) > tolerance) return { ok: false, reason: 'STALE' };
  if (!input.path.startsWith('/') || input.path.includes('?')) return { ok: false, reason: 'MALFORMED' };
  const query = normalizeEsignS2sQuery(input.rawQuery);
  if (query === null) return { ok: false, reason: 'MALFORMED' };

  const expected = Buffer.from(
    computeEsignS2sSignature(canonicalEsignS2sRequest({ method: input.method, path: input.path, query, timestamp: ts }), input.secret),
    'utf8',
  );
  const provided = Buffer.from(sig, 'utf8');
  if (expected.length !== provided.length) return { ok: false, reason: 'BAD_SIGNATURE' };
  return timingSafeEqual(expected, provided) ? { ok: true } : { ok: false, reason: 'BAD_SIGNATURE' };
}
