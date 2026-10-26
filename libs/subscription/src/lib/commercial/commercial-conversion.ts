// CCP-C2 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.2 row C2; Conversion Rule C-11…C-15,
// C-21…C-23, C-29) — the PURE half of the governed ↔ self-service conversion: the payload schema
// of the CONVERSION action, the release state machine (mirrored by the DB trigger of migration
// 20261026060000), the failure codes and the apply-deadline reader. No I/O and no clock.
//
// Two directions, one closed action type (C-11; pre-execution record C2-D1):
//   TO_SELF_SERVICE (C-12)  the approved request RELEASES one self-service checkout of a named
//                           plan version, until `release_expires_at` (an approved term of the
//                           request, C2-D3). The release is consumed by exactly one checkout (or
//                           adopts one held activation, `held_subscription_ref`); the governed row
//                           ends only in the webhook transaction that opens the provider-confirmed
//                           SELF_SERVICE row.
//   TO_GOVERNED (C-13)      ending the Stripe-owned row is a durable provider command (C1); the
//                           governed MANUAL row opens only in the transaction that applies the
//                           provider-confirmed end. With `held_subscription_ref` the held provider
//                           subscription is cancelled and the governed row is kept (C-9).

export const CONVERSION_DIRECTIONS = ['TO_SELF_SERVICE', 'TO_GOVERNED'] as const;
export type ConversionDirection = (typeof CONVERSION_DIRECTIONS)[number];

export interface ToSelfServicePayload {
  direction: 'TO_SELF_SERVICE';
  governed_subscription_id: string;
  plan_key: string;
  plan_version_id: string;
  release_expires_at: string;
  held_subscription_ref?: string;
}

export type ToGovernedPayload =
  | { direction: 'TO_GOVERNED'; subscription_id: string; plan_key: string; plan_version_id: string }
  | { direction: 'TO_GOVERNED'; held_subscription_ref: string; governed_subscription_id: string };

export type ConversionPayload = ToSelfServicePayload | ToGovernedPayload;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLAN_KEY = /^[a-z0-9][a-z0-9-]{1,99}$/;
const PROVIDER_REF = /^[A-Za-z0-9_-]{1,255}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/**
 * Structural sanity bound on the release window (not a policy value): a release longer than this
 * after its apply is refused as a unit slip. The window itself is the approved payload term (C2-D3,
 * decision request DR-C2-2).
 */
export const CONVERSION_RELEASE_MAX_WINDOW_MS = 30 * 24 * 60 * 60_000;

/** The C1 command step names a conversion uses (C-22: key = change request + step). */
export const CONVERSION_STEP_END_SELF_SERVICE = 'end_self_service';
export const CONVERSION_STEP_CANCEL_HELD = 'cancel_held_activation';

/** Appends the CONVERSION payload errors (closed key sets per direction). */
export function conversionPayloadErrors(p: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const uuid = (k: string) => {
    if (typeof p[k] !== 'string' || !UUID.test(p[k] as string)) errors.push(`${k} must be a uuid`);
  };
  const ref = (k: string) => {
    if (typeof p[k] !== 'string' || !PROVIDER_REF.test(p[k] as string)) errors.push(`${k} must be a provider subscription reference`);
  };
  const plan = () => {
    if (typeof p['plan_key'] !== 'string' || !PLAN_KEY.test(p['plan_key'])) errors.push('plan_key must be a catalog plan key');
    uuid('plan_version_id');
  };
  const closed = (allowed: readonly string[]) => {
    for (const k of Object.keys(p)) if (!allowed.includes(k)) errors.push(`${k} is not a field of this conversion`);
  };
  switch (p['direction']) {
    case 'TO_SELF_SERVICE':
      closed(['direction', 'governed_subscription_id', 'plan_key', 'plan_version_id', 'release_expires_at', 'held_subscription_ref']);
      uuid('governed_subscription_id');
      plan();
      if (typeof p['release_expires_at'] !== 'string' || !ISO_INSTANT.test(p['release_expires_at']) || Number.isNaN(new Date(p['release_expires_at']).getTime())) {
        errors.push('release_expires_at must be an ISO-8601 UTC instant (the approved release expiry)');
      }
      if (p['held_subscription_ref'] !== undefined) ref('held_subscription_ref');
      break;
    case 'TO_GOVERNED':
      if (p['held_subscription_ref'] !== undefined) {
        closed(['direction', 'held_subscription_ref', 'governed_subscription_id']);
        ref('held_subscription_ref');
        uuid('governed_subscription_id');
      } else {
        closed(['direction', 'subscription_id', 'plan_key', 'plan_version_id']);
        uuid('subscription_id');
        plan();
      }
      break;
    default:
      errors.push(`direction must be one of ${CONVERSION_DIRECTIONS.join(', ')}`);
  }
  return errors;
}

export function asConversionPayload(p: Record<string, unknown>): ConversionPayload {
  return p as unknown as ConversionPayload;
}

export function isHeldResolution(p: ConversionPayload): boolean {
  return 'held_subscription_ref' in p && typeof p.held_subscription_ref === 'string';
}

// ---- Release state machine (DB trigger guard_commercial_conversion_release mirror) ----------

export const CONVERSION_RELEASE_STATES = ['RELEASED', 'CONSUMED', 'CONVERTED', 'EXPIRED'] as const;
export type ConversionReleaseState = (typeof CONVERSION_RELEASE_STATES)[number];

export const CONVERSION_RELEASE_TRANSITIONS: Readonly<Record<ConversionReleaseState, readonly ConversionReleaseState[]>> = {
  // CONSUMED: bound to its one checkout (no held ref); CONVERTED directly: a held activation adopted.
  RELEASED: ['CONSUMED', 'CONVERTED', 'EXPIRED'],
  CONSUMED: ['CONVERTED'],
  CONVERTED: [],
  EXPIRED: [],
};

/** The state a reader sees: an unconsumed release past its expiry is EXPIRED (half-open). */
export function effectiveReleaseState(r: { state: string; expires_at: Date }, at: Date): ConversionReleaseState {
  if (r.state === 'RELEASED' && at.getTime() >= r.expires_at.getTime()) return 'EXPIRED';
  return r.state as ConversionReleaseState;
}

/** May this release still be consumed at `at`? (Half-open window, TD-A2-1.) */
export function releaseConsumable(r: { state: string; expires_at: Date }, at: Date): boolean {
  return r.state === 'RELEASED' && at.getTime() < r.expires_at.getTime();
}

// ---- Failure / refusal codes ----------------------------------------------------------------

/** Why a CONVERSION apply attempt failed (rolled back; the request is APPLY_FAILED, retryable). */
export type ConversionFailureCode =
  | 'INVALID_PAYLOAD'
  | 'TARGET_NOT_FOUND' // the named row is not a row of this tenant × product
  | 'TARGET_STALE' // the named row has ended / is not the open row, or another row is open
  | 'TARGET_NOT_GOVERNED' // TO_SELF_SERVICE / held TO_GOVERNED: the named row is not an open governed BASE row
  | 'TARGET_NOT_SELF_SERVICE' // TO_GOVERNED: the named row is not an open provider-linked SELF_SERVICE row
  | 'HELD_ACTIVATION_NOT_FOUND' // no open governed_subscription_open flag for that provider subscription
  | 'PLAN_NOT_FOUND'
  | 'PLAN_VERSION_MISMATCH'
  | 'PLAN_VERSION_NOT_PUBLISHED' // G3
  | 'PLAN_NOT_ASSIGNABLE' // TO_GOVERNED: an INACTIVE / FREE plan; TO_SELF_SERVICE: not a sellable self-service plan
  | 'PLAN_TENANT_KIND_MISMATCH'
  | 'TENANT_NOT_FOUND'
  | 'RELEASE_EXPIRY_PASSED' // the approved release expiry is not in the future at apply
  | 'RELEASE_WINDOW_TOO_LONG' // structural sanity bound (CONVERSION_RELEASE_MAX_WINDOW_MS)
  | 'RELEASE_EXISTS' // an unconsumed release of this tenant × product exists
  | 'RELEASE_CHECKOUT_OPEN' // a consumed release's checkout is not provider-confirmed expired yet
  // T8 (Architect ruling 2026-10-25) — details.kind DOWNGRADE | OPEN_RESERVATIONS | CROSS_PERIOD.
  | 'USAGE_TREATMENT_UNDEFINED'
  // DR-C2-1 — details.kind COMMITMENT_TERM: an immediate cancel inside a commitment term has no
  // defined financial treatment (no proration or cancel-mode choice is authorized).
  | 'FINANCIAL_TREATMENT_UNDEFINED'
  | 'ONE_OPEN_BASE_VIOLATION'
  | 'UNEXPECTED';

// Merge train TD-MERGE-21 (TD-C2-7): the apply deadline uses CCP-A6-R's names — the policy key
// `apply_expiry_hours`, read and verified from the SNAPSHOTTED policy by
// CommercialChangeRequestService.applyDeadlineOf. A CONVERSION in APPLYING (pending at the provider)
// never expires. CCP-FIX1 (O-D4-2): the deadline refusal is no longer a conversion-only error class
// (`ConversionApplyRefusedError('APPLY_EXPIRED')`, reported as reason `apply_refused` + refusal
// `APPLY_EXPIRED`); the conversion apply throws exactly the A6-R refusal
// (`CommercialChangeRequestError('APPLY_EXPIRED')`, commercial-apply-records.ts), so both apply routes
// report code COMMERCIAL_CHANGE_REQUEST_CONFLICT, details.reason `apply_expired`, the same
// details.explanation and no details.refusal.

export class ConversionApplyFailedError extends Error {
  constructor(
    readonly code: ConversionFailureCode,
    readonly attempt: number,
    readonly detail: Record<string, unknown>,
    readonly request_state: string,
  ) {
    super(`conversion apply failed (${code}); the request is ${request_state}`);
    this.name = 'ConversionApplyFailedError';
  }
}

