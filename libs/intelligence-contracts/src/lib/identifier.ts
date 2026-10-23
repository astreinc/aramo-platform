import { createHash } from 'node:crypto';

import type { VerificationIdentifierType } from './verification.js';

// ATI-SEP-1 T10 (Addendum A3) — the identifier normalization, digest and mask
// both sides of the wall must agree on. TI names a contact by
// identifier_type + identifier_digest (ProposalView) and shows it masked
// (ReferenceVerificationItem.value_masked); the ATS recomputes both from its own
// record fields to match a worklist row or a status item back to an email /
// phone slot. Pure functions, byte-identical to the TI implementation
// (intelligence-core normalize.ts / projection.ts identifierDigest /
// verification-delivery.ts maskDestination) — a drift spec pins the parity.

/** Email: trimmed, lower-cased. */
export function normalizeEmailIdentifier(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Phone, E.164-ish: '+' followed by the digits. A bare 10-digit number is read
 * as NANP (+1). An input that already carries a '+' keeps its own country code.
 */
export function normalizePhoneIdentifier(value: string): string {
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
}

export function normalizeIdentifierValue(type: VerificationIdentifierType, value: string): string {
  return type === 'EMAIL' ? normalizeEmailIdentifier(value) : normalizePhoneIdentifier(value);
}

/** sha256 hex of `TYPE:normalized_value` — how TI names a contact without carrying it. */
export function identifierDigest(type: VerificationIdentifierType, normalizedValue: string): string {
  return createHash('sha256').update(`${type}:${normalizedValue}`, 'utf8').digest('hex');
}

/** Digest straight from a raw (un-normalized) value. */
export function identifierDigestOf(type: VerificationIdentifierType, rawValue: string): string {
  return identifierDigest(type, normalizeIdentifierValue(type, rawValue));
}

/** The masked form TI returns for a normalized value: `j***@example.com` / `***34`. */
export function maskIdentifierValue(normalizedValue: string): string {
  const at = normalizedValue.indexOf('@');
  if (at > 0) return `${normalizedValue[0]}***${normalizedValue.slice(at)}`;
  return normalizedValue.length > 4 ? `***${normalizedValue.slice(-2)}` : '***';
}
