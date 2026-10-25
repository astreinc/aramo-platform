// Typed refusals. Every Aramo service answers a refusal with the canonical envelope
// `{ error: { code, message, request_id, details: { reason, ... } } }` (openapi/common.yaml
// ErrorResponse); some Sign routes still answer the flat `{ code, message }` form. The app
// keys ALL behaviour and copy off `reason` = details.reason, falling back to the code.
// It never mirrors domain policy (directive §4): it renders what the server decided.

/** Reasons the app renders specifically. Unknown reasons still flow through as strings. */
export const KNOWN_REASONS = [
  // Native auth (M-A1)
  'idp_not_permitted_for_tenant',
  'invalid_grant',
  'session_reuse_detected',
  // Concurrency / idempotency (M-A3 §6-§8)
  'precondition_required',
  'revision_mismatch',
  'idempotency_key_reuse',
  'idempotency_request_in_progress',
  // Reminders (M-A3 §7)
  'reminder_cooldown',
  'reminder_daily_limit',
  // Inbox signing revalidation (M-A2 §2.2)
  'association_inactive',
  'envelope_not_signable',
  'signer_ineligible',
  'not_your_turn',
  'session_revoked',
  'link_expired',
  'recipient_mismatch',
  // Personal gates (directive §5)
  'phone_verification_required',
  'personal_review_pending',
  'personal_restricted',
  'personal_sending_not_enabled',
  'legal_acceptance_required',
  // Guest signing transport codes (sign-service domain errors)
  'SIGNING_SESSION_INVALID',
  'SIGNING_SESSION_EXPIRED',
  'ENVELOPE_ALREADY_EXECUTED',
  'SIGNER_NOT_YET_ELIGIBLE',
  'SIGNATURE_FIELD_INCOMPLETE',
  'DISCLOSURE_NOT_ACCEPTED',
  // Client-side conditions (never sent by a server)
  'network_unavailable',
  'session_expired',
  'signing_session_ended',
  'auth_not_configured',
  'auth_cancelled',
  'state_mismatch',
  'authorization_denied',
] as const;

export type KnownReason = (typeof KNOWN_REASONS)[number];
export type Reason = KnownReason | (string & {});

export interface ApiErrorInit {
  readonly status: number;
  readonly code: string;
  readonly reason: Reason;
  readonly message?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly requestId?: string | null;
  readonly retryAfterHeader?: string | null;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly reason: Reason;
  readonly details: Readonly<Record<string, unknown>>;
  readonly requestId: string | null;
  private readonly retryAfterHeader: string | null;

  constructor(init: ApiErrorInit) {
    // The message is the reason only: server messages and request bodies never reach
    // logs through an Error's text (directive §9 "Logging").
    super(init.reason);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.reason = init.reason;
    this.details = init.details ?? {};
    this.requestId = init.requestId ?? null;
    this.retryAfterHeader = init.retryAfterHeader ?? null;
  }

  is(...reasons: KnownReason[]): boolean {
    return reasons.some((r) => r === this.reason || r === this.code);
  }

  /** Seconds until a rate-limited action may be retried (details or Retry-After). */
  get retryAfterSeconds(): number | null {
    const fromDetails = this.details['retry_after_seconds'];
    if (typeof fromDetails === 'number' && Number.isFinite(fromDetails)) return fromDetails;
    if (this.retryAfterHeader && /^\d+$/.test(this.retryAfterHeader))
      return Number(this.retryAfterHeader);
    return null;
  }

  /** ISO time a rate-limited action may be retried (M-A3 §7 `details.retry_at`). */
  get retryAt(): string | null {
    const v = this.details['retry_at'];
    return typeof v === 'string' ? v : null;
  }

  /** The envelope's current revision on a 412 revision_mismatch (M-A3 §6). */
  get currentRevision(): number | null {
    const v = this.details['current_revision'];
    return typeof v === 'number' ? v : null;
  }

  get isNetwork(): boolean {
    return this.reason === 'network_unavailable';
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** Map a non-2xx response body to an ApiError. Tolerates any body shape. */
export function errorFromBody(
  status: number,
  body: unknown,
  retryAfterHeader: string | null = null,
): ApiError {
  const outer = asRecord(body);
  const inner = asRecord(outer?.['error']) ?? outer;
  const details = asRecord(inner?.['details']) ?? {};
  const code = typeof inner?.['code'] === 'string' ? (inner['code'] as string) : `HTTP_${status}`;
  const detailReason = details['reason'];
  const flatReason = inner?.['reason'];
  const reason =
    typeof detailReason === 'string' && detailReason
      ? detailReason
      : typeof flatReason === 'string' && flatReason
        ? flatReason
        : code;
  const requestId =
    typeof inner?.['request_id'] === 'string' ? (inner['request_id'] as string) : null;
  const message = typeof inner?.['message'] === 'string' ? (inner['message'] as string) : undefined;
  return new ApiError({
    status,
    code,
    reason,
    details,
    requestId,
    retryAfterHeader,
    ...(message ? { message } : {}),
  });
}

export function clientError(reason: KnownReason, status = 0): ApiError {
  return new ApiError({ status, code: reason, reason });
}
