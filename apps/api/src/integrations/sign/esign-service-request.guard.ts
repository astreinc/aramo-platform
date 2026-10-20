import { type CanActivate, type ExecutionContext, Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import { AramoError } from '@aramo/common';
import {
  ESIGN_S2S_SIGNATURE_HEADER,
  ESIGN_S2S_TIMESTAMP_HEADER,
  verifyEsignServiceRequest,
} from '@aramo/documents-contracts';

// ES-2 (Aramo-E-Sign-ES-2-Core-Service-Trust-Implementation-Authorization-v1_0)
// — reusable guard for Core routes that ONLY sign-service may call.
//
// Verifies the shared `aramo-sign-s2s-v1` request signature (method + exact path
// + normalized query + timestamp, HMAC-SHA256, constant-time, ±300s) keyed by
// SIGN_WEBHOOK_SIGNING_SECRET. It authenticates the CALLER as sign-service; it
// is never a signer authorization and never replaces the route's own tenant and
// document checks.
//
// Outcomes:
//   503 ESIGN_SERVICE_AUTH_UNAVAILABLE — secret not configured. ALWAYS, in every
//       mode: a missing secret is never downgraded to serving unauthenticated.
//   401 AUTH_REQUIRED — missing / malformed / stale / invalid signature (enforce).
//
// Mode (SIGN_S2S_AUTH_MODE): `enforce` is the default and the intended production
// state. `log` is a TEMPORARY deploy-compatibility setting: it only takes effect
// with an explicit end time SIGN_S2S_AUTH_LOG_UNTIL (ISO-8601) that is in the
// future and at most ESIGN_S2S_LOG_MODE_MAX_MS ahead; anything else — unset,
// unknown value, expired, unparseable or unbounded — enforces. While active, an
// unauthenticated request is served and logged as a warning.

export const ESIGN_S2S_LOG_MODE_MAX_MS = 7 * 24 * 60 * 60 * 1000;

export type EsignS2sMode = { mode: 'enforce' } | { mode: 'log'; until: Date };

export function resolveEsignS2sMode(env: NodeJS.ProcessEnv, nowMs: number): EsignS2sMode {
  if (env['SIGN_S2S_AUTH_MODE'] !== 'log') return { mode: 'enforce' };
  const until = Date.parse(env['SIGN_S2S_AUTH_LOG_UNTIL'] ?? '');
  if (Number.isNaN(until) || until <= nowMs || until - nowMs > ESIGN_S2S_LOG_MODE_MAX_MS) return { mode: 'enforce' };
  return { mode: 'log', until: new Date(until) };
}

function firstHeader(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

@Injectable()
export class EsignServiceRequestGuard implements CanActivate {
  private readonly logger = new Logger(EsignServiceRequestGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request & { requestId?: string }>();
    const requestId = req.requestId ?? 'unknown';
    const secret = process.env['SIGN_WEBHOOK_SIGNING_SECRET'];
    if (secret === undefined || secret.length === 0) {
      throw new AramoError('ESIGN_SERVICE_AUTH_UNAVAILABLE', 'sign-service request authentication is not configured', 503, { requestId });
    }

    const raw = req.originalUrl ?? req.url;
    const q = raw.indexOf('?');
    const path = q === -1 ? raw : raw.slice(0, q);
    const verdict = verifyEsignServiceRequest({
      method: req.method,
      path,
      rawQuery: q === -1 ? '' : raw.slice(q + 1),
      timestampHeader: firstHeader(req.headers[ESIGN_S2S_TIMESTAMP_HEADER]),
      signatureHeader: firstHeader(req.headers[ESIGN_S2S_SIGNATURE_HEADER]),
      secret,
      nowSec: Math.floor(Date.now() / 1000),
    });
    if (verdict.ok) return true;

    const mode = resolveEsignS2sMode(process.env, Date.now());
    if (mode.mode === 'log') {
      this.logger.warn(
        `ES-2 LOG MODE (until ${mode.until.toISOString()}): serving unauthenticated ${req.method} ${path} (${verdict.reason}) — set SIGN_S2S_AUTH_MODE=enforce`,
      );
      return true;
    }
    this.logger.warn(`refused sign-service request ${req.method} ${path}: ${verdict.reason}`);
    throw new AramoError('AUTH_REQUIRED', 'sign-service request signature required', 401, { requestId });
  }
}
