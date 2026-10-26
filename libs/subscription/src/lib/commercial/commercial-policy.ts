import { createHash } from 'node:crypto';

// CCP-A2 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.1, row A2; Charter §7, D5, D10)
// — the CommercialPolicyVersion content document and its STRICT, fail-closed parser.
//
// Every commercial threshold lives in the ACTIVE subscription."CommercialPolicyVersion"
// row, seeded as v1 by migration 20261024180000_ccp_a2_commercial_audit_policy. This file
// holds NO policy value: it defines the document's shape, the canonical checksum, and the
// refusal to run on a missing, malformed or tampered policy. The comparison semantics
// (PO-confirmed 2026-10-24, doc/ccp/slices/CCP-A2-pre-execution.md) live in
// commercial-policy-boundaries.ts and read every number from the parsed document.
//
// Not the ADR-0024 policy store (D10): this lib is scope:shared and never imports it.

/** The only content format this parser admits. A new format is a new parser version. */
export const COMMERCIAL_POLICY_FORMAT_VERSION = 1;

/** The closed key set of a format-1 document. Any extra or missing key fails closed. */
export const COMMERCIAL_POLICY_KEYS = [
  'format_version',
  'currency',
  'discount_escalation_threshold_bps',
  'credit_escalation_threshold_minor',
  'support_extension_max_days',
  'support_extension_frequency_window_days',
  'support_extension_cumulative_max_days',
  'support_extension_cumulative_window_days',
  'approval_expiry_hours',
  'past_due_grace_days',
] as const;

/**
 * Charter Amendment A2 (Refund execution policy keys, LOCKED 2026-10-25, RX-1) — the three OPTIONAL
 * refund keys: the commercial gate (gate 2) and the identity of the approved refund policy document.
 * All present or all absent: partial presence, a wrong type or a bad format fails the whole document
 * closed (MALFORMED). Absent = refund execution disabled; never seeded, never defaulted.
 */
export const REFUND_POLICY_KEYS = ['refund_execution_enabled', 'refund_policy_ref', 'refund_policy_sha256'] as const;
/** RX-D3 — `<DOCUMENT-ID>@<major>.<minor>`, e.g. `ARAMO-COM-REFUND-POL-001@1.0`. */
export const REFUND_POLICY_REF_FORMAT = /^[A-Z0-9-]+@[0-9]+\.[0-9]+$/;
/** RX-D3 — the SHA-256 of the LOCKED refund policy document: exactly 64 lowercase hex characters. */
export const REFUND_POLICY_SHA256_FORMAT = /^[0-9a-f]{64}$/;

/**
 * Charter Amendment A1 (Apply deadline, LOCKED 2026-10-25, AD-1) — OPTIONAL keys of a format-1
 * document. v1 carries none (it stays immutable and byte-identical); a v2 adds `apply_expiry_hours`
 * (named after `approval_expiry_hours`). Absent → no apply deadline (AD-2); present but malformed →
 * the whole document fails closed. Charter Amendment A2 adds the three refund keys (REFUND_POLICY_KEYS).
 */
export const COMMERCIAL_POLICY_OPTIONAL_KEYS = ['apply_expiry_hours', ...REFUND_POLICY_KEYS] as const;

export interface CommercialPolicyContent {
  format_version: 1;
  /** ISO 4217 code the credit threshold is denominated in. */
  currency: string;
  /** Discount at or above this many basis points (1/100 of a percent) escalates. */
  discount_escalation_threshold_bps: number;
  /** Credit at or above this many minor units of `currency` escalates. */
  credit_escalation_threshold_minor: number;
  /** A support extension of at most this many days is within limit. */
  support_extension_max_days: number;
  /** Rolling window (days) in which at most one in-limit extension applies. */
  support_extension_frequency_window_days: number;
  /** Cumulative in-limit extension days allowed within the cumulative window. */
  support_extension_cumulative_max_days: number;
  /** Rolling window (days) for the cumulative cap. */
  support_extension_cumulative_window_days: number;
  /** A request expires this many hours after it is submitted. */
  approval_expiry_hours: number;
  /** Past-due grace, in days. */
  past_due_grace_days: number;
  /**
   * Charter Amendment A1 (AD-1) — an APPROVED / APPLY_FAILED request becomes APPLY_EXPIRED this many
   * hours after its final approval. Absent (v1) = no apply deadline (AD-2).
   */
  apply_expiry_hours?: number;
  /** Charter Amendment A2 (RX-1) — gate 2: this version permits new refund execution. Absent = disabled. */
  refund_execution_enabled?: boolean;
  /** Charter Amendment A2 (RX-2, RX-D3) — the approved refund policy document and version. */
  refund_policy_ref?: string;
  /** Charter Amendment A2 (RX-2, RX-D3) — the SHA-256 of that LOCKED document (its sidecar). */
  refund_policy_sha256?: string;
}

/** The ACTIVE policy as the commercial engine consumes it. */
export interface CommercialPolicy {
  version_id: string;
  version_number: number;
  checksum: string;
  content: CommercialPolicyContent;
}

export type CommercialPolicyUnavailableReason =
  | 'MISSING' // no ACTIVE version
  | 'NOT_ACTIVE' // the row handed to the parser is not ACTIVE
  | 'MALFORMED' // content fails the strict shape
  | 'CHECKSUM_MISMATCH'; // stored checksum ≠ recomputation over the stored content

/** Fail-closed refusal: no commercial decision is taken without a valid ACTIVE policy. */
export class CommercialPolicyUnavailableError extends Error {
  constructor(
    readonly reason: CommercialPolicyUnavailableReason,
    readonly errors: readonly string[] = [],
  ) {
    super(`Commercial policy unavailable (${reason})${errors.length > 0 ? `: ${errors.join('; ')}` : ''}`);
    this.name = 'CommercialPolicyUnavailableError';
  }
}

/**
 * Canonical JSON: object keys sorted (code-unit order) at every depth, no whitespace.
 * The checksum input, so it is independent of key order in storage or transport.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const s = JSON.stringify(value);
    if (s === undefined) throw new TypeError('canonicalJson: value is not JSON-serializable');
    return s;
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(',')}}`;
}

/** SHA-256 (lower-case hex) of the canonical JSON of a policy content document. */
export function commercialPolicyChecksum(content: unknown): string {
  return createHash('sha256').update(canonicalJson(content), 'utf8').digest('hex');
}

// Structural sanity bounds only (not policy values): integers, non-negative, and a
// ceiling far above any plausible commercial setting so a unit slip (e.g. hours given
// as minutes, cents given as micro-units) is refused rather than silently honoured.
const MAX_DAYS = 3650;
const MAX_HOURS = 24 * MAX_DAYS;
const MAX_BPS = 10_000;

function intIn(errors: string[], doc: Record<string, unknown>, key: string, min: number, max: number): void {
  const v = doc[key];
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) {
    errors.push(`${key} must be an integer`);
    return;
  }
  if (v < min || v > max) errors.push(`${key} must be between ${min} and ${max}`);
}

/** Charter Amendment A2 (RX-1, RX-D3) — all present or all absent; each strictly typed and formatted. */
function refundKeyErrors(errors: string[], doc: Record<string, unknown>): void {
  const present = REFUND_POLICY_KEYS.filter((k) => k in doc);
  if (present.length === 0) return;
  if (present.length !== REFUND_POLICY_KEYS.length) {
    errors.push(`${REFUND_POLICY_KEYS.join(', ')} must be all present or all absent (present: ${present.join(', ')})`);
    return;
  }
  if (typeof doc['refund_execution_enabled'] !== 'boolean') errors.push('refund_execution_enabled must be a boolean');
  const ref = doc['refund_policy_ref'];
  if (typeof ref !== 'string' || !REFUND_POLICY_REF_FORMAT.test(ref)) errors.push('refund_policy_ref must match <DOCUMENT-ID>@<major>.<minor>');
  const sha = doc['refund_policy_sha256'];
  if (typeof sha !== 'string' || !REFUND_POLICY_SHA256_FORMAT.test(sha)) errors.push('refund_policy_sha256 must be 64 lowercase hex characters');
}

/**
 * Strict parser. Accepts exactly a format-1 document; anything else throws
 * CommercialPolicyUnavailableError('MALFORMED') listing every problem found.
 */
export function parseCommercialPolicyContent(raw: unknown): CommercialPolicyContent {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CommercialPolicyUnavailableError('MALFORMED', ['content must be a JSON object']);
  }
  const doc = raw as Record<string, unknown>;
  const errors: string[] = [];
  const allowed = new Set<string>([...COMMERCIAL_POLICY_KEYS, ...COMMERCIAL_POLICY_OPTIONAL_KEYS]);
  for (const k of Object.keys(doc)) if (!allowed.has(k)) errors.push(`unknown key ${k}`);
  for (const k of COMMERCIAL_POLICY_KEYS) if (!(k in doc)) errors.push(`missing key ${k}`);
  if (errors.length > 0) throw new CommercialPolicyUnavailableError('MALFORMED', errors);

  if (doc['format_version'] !== COMMERCIAL_POLICY_FORMAT_VERSION) {
    errors.push(`format_version must be ${COMMERCIAL_POLICY_FORMAT_VERSION}`);
  }
  if (typeof doc['currency'] !== 'string' || !/^[A-Z]{3}$/.test(doc['currency'])) {
    errors.push('currency must be an ISO 4217 code');
  }
  intIn(errors, doc, 'discount_escalation_threshold_bps', 1, MAX_BPS);
  intIn(errors, doc, 'credit_escalation_threshold_minor', 1, Number.MAX_SAFE_INTEGER);
  intIn(errors, doc, 'support_extension_max_days', 1, MAX_DAYS);
  intIn(errors, doc, 'support_extension_frequency_window_days', 1, MAX_DAYS);
  intIn(errors, doc, 'support_extension_cumulative_max_days', 1, MAX_DAYS);
  intIn(errors, doc, 'support_extension_cumulative_window_days', 1, MAX_DAYS);
  intIn(errors, doc, 'approval_expiry_hours', 1, MAX_HOURS);
  intIn(errors, doc, 'past_due_grace_days', 0, MAX_DAYS);
  if ('apply_expiry_hours' in doc) intIn(errors, doc, 'apply_expiry_hours', 1, MAX_HOURS);
  refundKeyErrors(errors, doc);
  if (errors.length === 0) {
    // Internal coherence: one extension cannot exceed the cumulative cap, and the cap's
    // window cannot be shorter than the frequency window.
    if ((doc['support_extension_max_days'] as number) > (doc['support_extension_cumulative_max_days'] as number)) {
      errors.push('support_extension_max_days must not exceed support_extension_cumulative_max_days');
    }
    if ((doc['support_extension_cumulative_window_days'] as number) < (doc['support_extension_frequency_window_days'] as number)) {
      errors.push('support_extension_cumulative_window_days must not be shorter than support_extension_frequency_window_days');
    }
  }
  if (errors.length > 0) throw new CommercialPolicyUnavailableError('MALFORMED', errors);
  return {
    format_version: 1,
    currency: doc['currency'] as string,
    discount_escalation_threshold_bps: doc['discount_escalation_threshold_bps'] as number,
    credit_escalation_threshold_minor: doc['credit_escalation_threshold_minor'] as number,
    support_extension_max_days: doc['support_extension_max_days'] as number,
    support_extension_frequency_window_days: doc['support_extension_frequency_window_days'] as number,
    support_extension_cumulative_max_days: doc['support_extension_cumulative_max_days'] as number,
    support_extension_cumulative_window_days: doc['support_extension_cumulative_window_days'] as number,
    approval_expiry_hours: doc['approval_expiry_hours'] as number,
    past_due_grace_days: doc['past_due_grace_days'] as number,
    // Only present when the version declares it (v1 parses to the exact v1 shape).
    ...('apply_expiry_hours' in doc ? { apply_expiry_hours: doc['apply_expiry_hours'] as number } : {}),
    // Charter Amendment A2 (RX-1) — all three, or none (validated above).
    ...('refund_execution_enabled' in doc
      ? {
          refund_execution_enabled: doc['refund_execution_enabled'] as boolean,
          refund_policy_ref: doc['refund_policy_ref'] as string,
          refund_policy_sha256: doc['refund_policy_sha256'] as string,
        }
      : {}),
  };
}

/** The stored row fields the active-policy parser needs. */
export interface CommercialPolicyVersionRecord {
  id: string;
  version_number: number;
  status: string;
  content: unknown;
  content_checksum: string;
}

/**
 * Fail-closed ACTIVE-policy parser: refuses a missing row, a non-ACTIVE row, malformed
 * content, and a stored checksum that does not match the stored content.
 */
export function parseActiveCommercialPolicy(row: CommercialPolicyVersionRecord | null | undefined): CommercialPolicy {
  if (row === null || row === undefined) throw new CommercialPolicyUnavailableError('MISSING');
  if (row.status !== 'ACTIVE') throw new CommercialPolicyUnavailableError('NOT_ACTIVE', [`status ${row.status}`]);
  const content = parseCommercialPolicyContent(row.content);
  const recomputed = commercialPolicyChecksum(row.content);
  if (recomputed !== row.content_checksum) {
    throw new CommercialPolicyUnavailableError('CHECKSUM_MISMATCH', [`stored ${row.content_checksum}`, `recomputed ${recomputed}`]);
  }
  return { version_id: row.id, version_number: row.version_number, checksum: row.content_checksum, content };
}
