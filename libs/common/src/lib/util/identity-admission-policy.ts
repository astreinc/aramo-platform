import { AramoError } from '../errors/index.js';

// TR-2b B1 (Aramo-TR2b-B1-Directive-v1_0-LOCKED §1; DDR R1) — the platform-
// global identity-index admission-policy loader, the sibling of the fingerprint
// pepper (identity-fingerprint.ts). Ruling v1.1 Decision 15 freezes the
// IdentityIndexAdmissionPolicy behind a switch: PORTABLE_ONLY | ALL_ARRIVALS.
//
// THE SWITCH governs whether an arrival's contact material is admitted into the
// cross-tenant identity_index (the aperture-1 fingerprint mint in the
// canonicalization path). It is a PLATFORM-GLOBAL, env-injected, fail-loud
// setting — NOT tenant config (DDR R1: D15 is a counsel-dependent PLATFORM
// decision; per-tenant variation is expressly rejected). Production launches at
// PORTABLE_ONLY.
//
// Fail-loud env binding mirrors loadIdentityPepper (identity-fingerprint.ts:40)
// and the config loaders it cites (dns.config.ts / mailer.config.ts): a missing
// or unknown value throws rather than silently defaulting — an UNDECLARED
// admission gate is exactly the dark-launch-without-a-gate state D15 forbids.

const POLICY_ENV_VAR = 'ARAMO_IDENTITY_ADMISSION_POLICY';
const CONFIG_REQUEST_ID = 'identity-admission-policy-config';

/**
 * The closed vocabulary of admission policies (Ruling v1.1 D15). `PORTABLE_ONLY`
 * admits only a VERIFIED anchor of a D5 portable class (today: verified email);
 * `ALL_ARRIVALS` admits any arrival carrying normalized anchor material.
 * Flipping the switch changes FORWARD ingestion only — pre-switch history enters
 * the index solely via the audited backfill command (TR-2b B2 / DDR R7), never
 * silent retro-ingestion (D15: "Flipping the switch does not ingest; the
 * command does").
 */
export const IDENTITY_ADMISSION_POLICIES = [
  'PORTABLE_ONLY',
  'ALL_ARRIVALS',
] as const;

export type IdentityAdmissionPolicy =
  (typeof IDENTITY_ADMISSION_POLICIES)[number];

/**
 * Load the platform-global identity-index admission policy from the process env
 * (fail-loud). Throws a 500 AramoError if unset/empty OR set to a value outside
 * the closed vocabulary — never returns a degraded/defaulted policy.
 */
export function loadIdentityAdmissionPolicy(): IdentityAdmissionPolicy {
  const raw = process.env[POLICY_ENV_VAR];
  if (raw === undefined || raw.length === 0) {
    throw new AramoError(
      'INTERNAL_ERROR',
      `${POLICY_ENV_VAR} env-var is not set (the identity-index admission policy — Ruling D15: ${IDENTITY_ADMISSION_POLICIES.join(
        ' | ',
      )})`,
      500,
      {
        requestId: CONFIG_REQUEST_ID,
        details: { kind: 'env_missing', name: POLICY_ENV_VAR },
      },
    );
  }
  if (!(IDENTITY_ADMISSION_POLICIES as readonly string[]).includes(raw)) {
    throw new AramoError(
      'INTERNAL_ERROR',
      `${POLICY_ENV_VAR} env-var is set to an unknown value (must be one of: ${IDENTITY_ADMISSION_POLICIES.join(
        ' | ',
      )})`,
      500,
      {
        requestId: CONFIG_REQUEST_ID,
        details: { kind: 'env_invalid', name: POLICY_ENV_VAR },
      },
    );
  }
  return raw as IdentityAdmissionPolicy;
}
