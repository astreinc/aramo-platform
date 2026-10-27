import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import {
  EnvelopeRevisionMismatchError,
  IdempotencyKeyReuseError,
  IdempotencyRequestInProgressError,
  InboxSigningRefusedError,
  ReminderLimitError,
  SessionIssueRefusedError,
  SIGN_IDEMPOTENCY_KEY_MAX,
} from '@aramo/sign';

import { toHttp } from '../esign-http.controller.js';

// Aramo Sign Mobile — the HTTP side of the envelope contracts
// (Aramo-Sign-Unified-Product-Amendment-M-A3 §3, §6, §7, §8; M-A2 §2.2).
//
// Stable refusals (details.reason):
//   428 precondition_required    a native token sent no If-Match on a draft write, send or void
//   412 revision_mismatch        If-Match is not the current revision (details.current_revision)
//   429 reminder_cooldown        < 60 minutes since this signer was reminded (retry_after_seconds, retry_at)
//   429 reminder_daily_limit     5 reminders on this envelope in the rolling 24 hours (retry_after_seconds, retry_at)
//   422 idempotency_key_reuse    the Idempotency-Key was used with a different request
//   409 idempotency_request_in_progress  the first request with this key is still running
//   400 invalid_idempotency_key  the Idempotency-Key header is empty, too long or not printable ASCII
//   400 message_too_long         the sender message is over 1000 characters after sanitizing
//   409 association_inactive | envelope_not_signable | signer_ineligible | not_your_turn | session_revoked | link_expired
//                                inbox signing revalidation (M-A2 §2.2)

export const MESSAGE_MAX = 1000;
export const SIGNING_LINK_VALID_DAYS = 7;

// The strong validator "{envelope_id}.{revision}" (M-A3 §6).
export function envelopeEtag(envelope_id: string, revision: number): string {
  return `"${envelope_id}.${revision}"`;
}

// A native (mobile) token — W1's AuthContext.client (M-A1 §3.6).
export function isNativeClient(auth: AuthContextType): boolean {
  return auth.client === 'native';
}

// If-Match → the expected revision. A header naming another envelope, a weak
// validator or garbage can never match, so it resolves to an impossible revision
// and the locked comparison answers 412 with the current revision. Missing:
// undefined for a browser token (temporary compatibility, M-A3 §6), 428 for native.
export function expectedRevision(auth: AuthContextType, ifMatch: string | undefined, envelope_id: string, requestId: string): number | undefined {
  const raw = typeof ifMatch === 'string' ? ifMatch.trim() : '';
  if (raw === '') {
    if (isNativeClient(auth)) {
      throw new AramoError('INVALID_REQUEST', 'This change needs the envelope version you last read (If-Match)', 428, {
        requestId,
        details: { reason: 'precondition_required' },
      });
    }
    return undefined;
  }
  const m = /^"([0-9a-fA-F-]{36})\.(\d{1,9})"$/.exec(raw) ?? /^([0-9a-fA-F-]{36})\.(\d{1,9})$/.exec(raw);
  if (m === null || m[1]!.toLowerCase() !== envelope_id.toLowerCase()) return -1;
  return Number(m[2]);
}

// Plain text only: control characters (except line breaks and tabs) and the
// bidirectional-override characters are removed, line breaks normalized, the
// result trimmed. Empty means "no message". Never rendered as markup anywhere.
export function sanitizeMessage(raw: unknown, requestId: string): string | null {
  if (raw === null) return null;
  if (typeof raw !== 'string') {
    throw new AramoError('VALIDATION_ERROR', 'message must be text', 400, { requestId, details: { field: 'message', reason: 'invalid_message' } });
  }
  const clean = raw
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, '')
    .trim();
  if (clean.length > MESSAGE_MAX) {
    throw new AramoError('VALIDATION_ERROR', `The message can be at most ${MESSAGE_MAX} characters`, 400, {
      requestId,
      details: { field: 'message', reason: 'message_too_long', max: MESSAGE_MAX },
    });
  }
  return clean.length === 0 ? null : clean;
}

export function idempotencyKey(header: string | undefined, requestId: string): string | undefined {
  if (header === undefined) return undefined;
  const k = header.trim();
  if (k.length === 0 || k.length > SIGN_IDEMPOTENCY_KEY_MAX || !/^[\x21-\x7E]+$/.test(k)) {
    throw new AramoError('VALIDATION_ERROR', 'Idempotency-Key must be 1 to 255 printable characters', 400, {
      requestId,
      details: { reason: 'invalid_idempotency_key' },
    });
  }
  return k;
}

// The Sign console's error mapping: the envelope-contract refusals, then the
// shared E-Sign mapping.
export function senderHttp(e: unknown, requestId: string): AramoError {
  if (e instanceof EnvelopeRevisionMismatchError) {
    return new AramoError('INVALID_REQUEST', 'This envelope changed since you last read it. Reload and try again.', 412, {
      requestId,
      details: { reason: 'revision_mismatch', current_revision: e.currentRevision },
    });
  }
  if (e instanceof ReminderLimitError) {
    const seconds = Math.max(1, Math.ceil((e.retryAt.getTime() - Date.now()) / 1000));
    const message = e.reason === 'reminder_cooldown' ? 'This signer was reminded less than an hour ago' : 'This envelope has had 5 reminders in the last 24 hours';
    return new AramoError('ESIGN_REMINDER_NOT_ALLOWED', message, 429, {
      requestId,
      details: { reason: e.reason, retry_after_seconds: seconds, retry_at: e.retryAt.toISOString() },
    });
  }
  if (e instanceof IdempotencyKeyReuseError) {
    return new AramoError('IDEMPOTENCY_KEY_CONFLICT', e.message, 422, { requestId, details: { reason: 'idempotency_key_reuse' } });
  }
  if (e instanceof IdempotencyRequestInProgressError) {
    return new AramoError('IDEMPOTENCY_KEY_CONFLICT', e.message, 409, { requestId, details: { reason: 'idempotency_request_in_progress' } });
  }
  if (e instanceof SessionIssueRefusedError) {
    return sessionIssueHttp(e, requestId);
  }
  if (e instanceof InboxSigningRefusedError) {
    return new AramoError('ENVELOPE_ILLEGAL_TRANSITION', inboxRefusalMessage(e.reason), 409, { requestId, details: { reason: e.reason } });
  }
  return toHttp(e, requestId);
}

function inboxRefusalMessage(reason: InboxSigningRefusedError['reason']): string {
  switch (reason) {
    case 'association_inactive':
      return 'This document is no longer in your inbox';
    case 'envelope_not_signable':
      return 'This document can no longer be signed';
    case 'signer_ineligible':
      return 'You can no longer sign this document';
    case 'not_your_turn':
      return 'Someone before you has to sign first';
    case 'session_revoked':
    case 'link_expired':
      return 'This link was replaced or has expired. Open the newest email, or sign in to your inbox.';
  }
}

// Aramo-Sign-Unified-Product-Amendment-M-A5 §3 / §4 — hosted and self-sign refusals,
// each with a stable details.reason.
function sessionIssueHttp(e: SessionIssueRefusedError, requestId: string): AramoError {
  switch (e.reason) {
    case 'signer_not_found':
      return new AramoError('SIGNER_NOT_FOUND', 'That recipient is not on this envelope', 404, { requestId, details: { reason: e.reason } });
    case 'not_bound_to_you':
      return new AramoError('INSUFFICIENT_PERMISSIONS', 'This envelope has no recipient assigned to you', 403, { requestId, details: { reason: e.reason } });
    case 'email_not_verified':
      return new AramoError('INSUFFICIENT_PERMISSIONS', 'Your verified account email no longer matches this recipient', 403, { requestId, details: { reason: e.reason } });
    case 'not_in_person_signer':
      return new AramoError('ENVELOPE_ILLEGAL_TRANSITION', 'Only an in-person signer can sign on your device', 409, { requestId, details: { reason: e.reason } });
    case 'envelope_not_signable':
      return new AramoError('ENVELOPE_ILLEGAL_TRANSITION', 'This document can no longer be signed', 409, { requestId, details: { reason: e.reason } });
    case 'signer_ineligible':
      return new AramoError('ENVELOPE_ILLEGAL_TRANSITION', 'This recipient can no longer sign', 409, { requestId, details: { reason: e.reason } });
    case 'not_your_turn':
      return new AramoError('SIGNER_NOT_YET_ELIGIBLE', 'Someone before this recipient has to sign first', 409, { requestId, details: { reason: e.reason } });
  }
}
