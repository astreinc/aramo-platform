import { SOURCE_SYSTEM_IDS, type SourceSystemId } from './events.js';

// ATI-SEP-1 T4 (ADR-0036 §5 "Verification v1") — talent identifier verification.
// v1 = a talent email one-time code, initiated through the portal and executed
// by TI. Phone (SMS) has the same path, but its delivery adapter reports
// NOT_AVAILABLE while SMS is on hold.
//
//   POST /v1/verifications               → CreateVerificationResponse (201)
//   POST /v1/verifications/:id/confirm   → ConfirmVerificationResponse (200)
//
// The code itself NEVER appears on the wire to the caller, in the outbox, or in
// a log: TI derives it from a keyed HMAC and hands it to the delivery port only.

export const VERIFICATION_IDENTIFIER_TYPES = ['EMAIL', 'PHONE'] as const;
export type VerificationIdentifierType = (typeof VERIFICATION_IDENTIFIER_TYPES)[number];

export const VERIFICATION_CHANNELS = ['EMAIL', 'SMS'] as const;
export type VerificationChannel = (typeof VERIFICATION_CHANNELS)[number];

export const VERIFICATION_STATUSES = ['PENDING', 'CONFIRMED', 'EXPIRED', 'LOCKED'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const VERIFICATION_CODE_LENGTH = 6;
export const VERIFICATION_TTL_SECONDS = 600;
export const VERIFICATION_MAX_ATTEMPTS = 5;

/** The talent's reference in a source system (the ATS record the portal session belongs to). */
export interface VerificationSourceReference {
  source_system_id: SourceSystemId;
  source_tenant_id: string;
  external_talent_id: string;
}

/** A portal session with no source reference. TI resolves the subject from the identifier. */
export interface VerificationPortalContext {
  portal_session_id: string;
}

/** Exactly one of source_reference / portal_context. */
export interface CreateVerificationRequest {
  source_reference?: VerificationSourceReference;
  portal_context?: VerificationPortalContext;
  identifier_type: VerificationIdentifierType;
  value: string;
}

export const VERIFICATION_DELIVERY_STATES = ['QUEUED', 'NOT_AVAILABLE'] as const;
export type VerificationDeliveryState = (typeof VERIFICATION_DELIVERY_STATES)[number];

export interface CreateVerificationResponse {
  verification_id: string;
  channel: VerificationChannel;
  status: 'PENDING';
  expires_at: string;
  /** NOT_AVAILABLE when the channel's delivery adapter cannot send (SMS on hold). */
  delivery: VerificationDeliveryState;
}

export interface ConfirmVerificationRequest {
  code: string;
}

/**
 * BOUND                — the identifier is now VERIFIED on the talent's subject.
 * ALREADY_BOUND        — it was already VERIFIED on that subject.
 * ANCHOR_CONTRADICTION — it is VERIFIED on another subject: not re-bound, opened for review.
 * UNBOUND              — the code was right but no single subject could be named (portal context).
 */
export const VERIFICATION_CONFIRM_OUTCOMES = ['BOUND', 'ALREADY_BOUND', 'ANCHOR_CONTRADICTION', 'UNBOUND'] as const;
export type VerificationConfirmOutcome = (typeof VERIFICATION_CONFIRM_OUTCOMES)[number];

export interface ConfirmVerificationResponse {
  verification_id: string;
  status: 'CONFIRMED';
  outcome: VerificationConfirmOutcome;
}

/** Refusals. INVALID_CODE carries attempts_remaining. */
export const VERIFICATION_REFUSAL_CODES = [
  'INVALID_REQUEST',
  'REFERENCE_NOT_FOUND',
  'VERIFICATION_NOT_FOUND',
  'INVALID_CODE',
  'VERIFICATION_EXPIRED',
  'VERIFICATION_LOCKED',
  'ALREADY_CONFIRMED',
  'VERIFICATION_UNAVAILABLE',
] as const;
export type VerificationRefusalCode = (typeof VERIFICATION_REFUSAL_CODES)[number];

/** Outbox payload of 'identifier_verification.requested' (TI-internal; routed to the delivery port). */
export interface IdentifierVerificationRequestedPayload {
  verification_id: string;
  channel: VerificationChannel;
  destination: string;
}

const MAX_ID = 128;
const ID_PATTERN = /^[A-Za-z0-9._:@-]+$/;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_SHAPE = /^\+?[0-9 ().-]{7,32}$/;

export type VerificationValidationResult<T> = { ok: true; value: T } | { ok: false; issues: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_ID && ID_PATTERN.test(v);

function closed(obj: Record<string, unknown>, allowed: readonly string[], path: string, issues: string[]): void {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) issues.push(`${path}.${k}: unknown key`);
}

/** Closed-schema validator for POST /v1/verifications. */
export function validateCreateVerificationRequest(input: unknown): VerificationValidationResult<CreateVerificationRequest> {
  const issues: string[] = [];
  if (!isObj(input)) return { ok: false, issues: ['$: must be an object'] };
  closed(input, ['source_reference', 'portal_context', 'identifier_type', 'value'], '$', issues);
  const hasRef = input['source_reference'] !== undefined;
  const hasPortal = input['portal_context'] !== undefined;
  if (hasRef === hasPortal) issues.push('$: exactly one of source_reference / portal_context is required');
  if (hasRef) {
    const r = input['source_reference'];
    if (!isObj(r)) issues.push('$.source_reference: must be an object');
    else {
      closed(r, ['source_system_id', 'source_tenant_id', 'external_talent_id'], '$.source_reference', issues);
      if (!(SOURCE_SYSTEM_IDS as readonly unknown[]).includes(r['source_system_id'])) issues.push('$.source_reference.source_system_id: unknown');
      if (!isId(r['source_tenant_id'])) issues.push('$.source_reference.source_tenant_id: invalid');
      if (!isId(r['external_talent_id'])) issues.push('$.source_reference.external_talent_id: invalid');
    }
  }
  if (hasPortal) {
    const p = input['portal_context'];
    if (!isObj(p)) issues.push('$.portal_context: must be an object');
    else {
      closed(p, ['portal_session_id'], '$.portal_context', issues);
      if (!isId(p['portal_session_id'])) issues.push('$.portal_context.portal_session_id: invalid');
    }
  }
  const type = input['identifier_type'];
  if (!(VERIFICATION_IDENTIFIER_TYPES as readonly unknown[]).includes(type)) issues.push('$.identifier_type: EMAIL | PHONE');
  const value = input['value'];
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 320) issues.push('$.value: invalid');
  else if (type === 'EMAIL' && !EMAIL_SHAPE.test(value.trim())) issues.push('$.value: not an email address');
  else if (type === 'PHONE' && !PHONE_SHAPE.test(value.trim())) issues.push('$.value: not a phone number');
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: input as unknown as CreateVerificationRequest };
}

/** Closed-schema validator for POST /v1/verifications/:id/confirm. */
export function validateConfirmVerificationRequest(input: unknown): VerificationValidationResult<ConfirmVerificationRequest> {
  if (!isObj(input)) return { ok: false, issues: ['$: must be an object'] };
  const issues: string[] = [];
  closed(input, ['code'], '$', issues);
  const code = input['code'];
  if (typeof code !== 'string' || !new RegExp(`^\\d{${VERIFICATION_CODE_LENGTH}}$`).test(code)) {
    issues.push(`$.code: ${VERIFICATION_CODE_LENGTH} digits`);
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { code: code as string } };
}
