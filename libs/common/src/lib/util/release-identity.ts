import { Injectable } from '@nestjs/common';

import { AramoError } from '../errors/index.js';

// GLH-2-A (ATS Go-Live Hardening Charter v1.5 / GLH-2 Release Integrity — Scope
// Ruling Instrument v1.0 LOCKED, R1/R3/R9) — the running-release identity
// primitive.
//
// A governed release image is stamped at build with the exact source git SHA
// (ARG GIT_REVISION → ENV ARAMO_RELEASE_REVISION + org.opencontainers.image.revision
// label). This module reads that baked value, validates it, and exposes the
// canonical revision to the running application. It NEVER reads `.git`, performs
// no network lookup, and holds no secret.
//
// Canonical revision (R1/§5): full git SHA, lowercase hex, exactly 40 chars.
// A short/upper-case/abbreviated SHA is INVALID.
//
// Fail-loud binding mirrors libs/common/src/lib/util/identity-fingerprint.ts and
// libs/identity/src/lib/dns/dns.config.ts: in a GOVERNED runtime a missing or
// malformed revision throws (fail-closed) rather than fabricating identity.
// A `dev` sentinel is permitted ONLY when the runtime is positively identified
// as local (never in a governed runtime).

export const RELEASE_REVISION_ENV_VAR = 'ARAMO_RELEASE_REVISION';
export const LOCAL_REVISION_SENTINEL = 'dev';
export const REVISION_REGEX = /^[0-9a-f]{40}$/;
const CONFIG_REQUEST_ID = 'release-identity-config';

// ARAMO_ENV values that positively identify a NON-governed (local) runtime.
// Anything else — including prod-like values AND an UNSET/ambiguous ARAMO_ENV —
// is treated as governed (fail-closed), mirroring the assertNonProd precedent in
// tools/provision-e2e-recruiter.lib.ts ("cannot confirm non-prod ⇒ refuse").
const LOCAL_ARAMO_ENVS = new Set(['local', 'dev', 'development', 'test']);

/**
 * Positively identify a GOVERNED (release) runtime. Governed iff the image
 * reports NODE_ENV=production AND ARAMO_ENV is not one of the explicit local
 * values. NODE_ENV alone is insufficient — it is baked into every app image
 * unconditionally, so a local docker-stack container also reports production;
 * ARAMO_ENV (compose passthrough, unset in a bare image) is the discriminator.
 */
export function isGovernedRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env['NODE_ENV'] !== 'production') return false; // local dev process
  const aramoEnv = (env['ARAMO_ENV'] ?? '').trim().toLowerCase();
  return !LOCAL_ARAMO_ENVS.has(aramoEnv); // prod-like OR unset/ambiguous ⇒ governed
}

/**
 * Resolve the canonical running-release revision from the baked env value.
 * - a valid 40-char lowercase SHA always wins (governed or local);
 * - otherwise, in a governed runtime: throw (fail-closed, never fabricate);
 * - otherwise (local runtime only): return the `dev` sentinel.
 */
export function resolveReleaseRevision(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[RELEASE_REVISION_ENV_VAR];
  const value = (raw ?? '').trim();
  if (REVISION_REGEX.test(value)) return value;

  if (!isGovernedRuntime(env)) return LOCAL_REVISION_SENTINEL;

  const missing = raw === undefined || raw.trim().length === 0;
  throw new AramoError(
    'INTERNAL_ERROR',
    missing
      ? `${RELEASE_REVISION_ENV_VAR} is not set in a governed runtime — the build must stamp a 40-char lowercase git SHA (release provenance, GLH-2-A)`
      : `${RELEASE_REVISION_ENV_VAR} is not a 40-char lowercase git SHA in a governed runtime (got "${raw}")`,
    500,
    {
      requestId: CONFIG_REQUEST_ID,
      details: { kind: missing ? 'env_missing' : 'env_invalid', name: RELEASE_REVISION_ENV_VAR },
    },
  );
}

/**
 * The smallest owning abstraction for release identity (R9). Resolves once and
 * caches; the resolution (incl. fail-closed governed validation) is exercised at
 * first read — and, via a bootstrap probe, before the socket opens.
 */
@Injectable()
export class ReleaseIdentityService {
  private cached: string | undefined;

  revision(): string {
    if (this.cached === undefined) this.cached = resolveReleaseRevision();
    return this.cached;
  }
}
