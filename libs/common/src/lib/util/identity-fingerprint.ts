import { createHmac } from 'node:crypto';

import { AramoError } from '../errors/index.js';

// Step 4a (Architecture Realignment, ADR-0016) — the tenant-side email
// fingerprint primitive for the cross-tenant identity privacy wall (I14).
//
// THE WALL: the raw verified email is PII and never leaves the tenant wall.
// The cross-tenant same-human match (formerly a raw-email read across tenants
// in the canonicalization resolver) is replaced — starting in step 4b — by a
// match on a SALTED ONE-WAY FINGERPRINT computed here, tenant-side, BEFORE the
// value crosses into the PII-free `identity_index` schema. Only the opaque
// fingerprint is ever stored in / read from identity_index.
//
// CONSTRUCTION (OPEN-1, MVP — email only): HMAC-SHA256(pepper, normalized_email)
// rendered as lowercase hex. Email has reasonable entropy, so a keyed hash is
// acceptable for the MVP; the slow-KDF requirement bites harder for the
// low-entropy anchors (phone, credential) added in TR-2 — out of scope here.
//
// THE PEPPER is a platform secret held SEPARATE FROM THE DATABASE, so an
// identity_index-only breach yields pepperless fingerprints (useless). The
// ideal home is a KMS/HSM; the current single-box platform sources it from the
// process env (the existing secret pattern), which still satisfies
// "index-breach-alone is useless". KMS/HSM migration is a filed hardening
// follow-up — NOT a step-4 blocker. The pepper MUST NOT be written to the
// database or into the identity_index schema.
//
// Fail-loud env binding mirrors libs/identity/src/lib/dns/dns.config.ts and
// libs/mailer mailer.config.ts: a missing pepper throws rather than silently
// degrading to an unkeyed / guessable fingerprint.

const PEPPER_ENV_VAR = 'ARAMO_IDENTITY_PEPPER';
const CONFIG_REQUEST_ID = 'identity-fingerprint-config';

/**
 * Load the identity pepper from the process env (fail-loud). The pepper is a
 * platform secret kept separate from the database. Throws a 500 AramoError if
 * unset/empty — never returns a degraded (unkeyed) value.
 */
export function loadIdentityPepper(): string {
  const raw = process.env[PEPPER_ENV_VAR];
  if (raw === undefined || raw.length === 0) {
    throw new AramoError(
      'INTERNAL_ERROR',
      `${PEPPER_ENV_VAR} env-var is not set (the identity fingerprint pepper, held separate from the database)`,
      500,
      {
        requestId: CONFIG_REQUEST_ID,
        details: { kind: 'env_missing', name: PEPPER_ENV_VAR },
      },
    );
  }
  return raw;
}

/**
 * Normalize an email for fingerprinting: lowercase + trim. Matches the
 * normalization the ingestion path already applies to verified_email
 * (libs/ingestion ingestion.service.ts) so a fingerprint computed here lines
 * up with the stored verified value.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Compute the tenant-side, PII-free email fingerprint that crosses into
 * identity_index. The raw email is never returned, logged, or persisted by
 * this function — only the opaque hex digest.
 *
 * @param email   the raw verified email (PII — stays tenant-side)
 * @param pepper  optional explicit pepper (tests inject it); defaults to the
 *                fail-loud env loader so production reads the platform secret.
 */
export function computeEmailFingerprint(email: string, pepper?: string): string {
  const key = pepper ?? loadIdentityPepper();
  const normalized = normalizeEmail(email);
  return createHmac('sha256', key).update(normalized, 'utf8').digest('hex');
}
