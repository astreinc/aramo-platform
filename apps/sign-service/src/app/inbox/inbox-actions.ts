import type { ErrorCode } from '@aramo/common';
import { INBOX_ACTION_KEYS, envelopeOpenForSigning, isPurgeExecuted, signerMayStillSign, type InboxActionKey } from '@aramo/sign-client';

// Aramo-Sign-Client-Rule-Consolidation-Directive-v1_0-LOCKED (480ecdbb) §3 C1 — the ONE home
// of the recipient inbox item action rules. `inboxActions()` computes the `actions` object of
// every inbox item; the same functions give the existing `can_sign` / `can_download` fields
// (unchanged meaning, C1-3) and the signed-copy route's refusal. Where the route re-checks a
// rule under the envelope row lock (inbox signing: RecipientInboxRepository revalidation), the
// rule here mirrors it; see enforced_by on each rule.

// Client Rule Consolidation C3 — the key list lives once in @aramo/sign-client.
export { INBOX_ACTION_KEYS, type InboxActionKey };
export type InboxActions = Record<InboxActionKey, boolean>;


export interface InboxActionEntry {
  /** bound (a recipient binding; uuid id) or discovered (an opaque handle). */
  source: 'bound' | 'discovered';
  envelope_status: string;
  signer_status: string;
  envelope_expires_at: Date | null;
  purge_state?: string | null;
  /** The shared turn rule (mayActNow: sequential turn + witness readiness). */
  turn: 'now' | 'later';
  /** W-3 — a live emailed link backs inbox signing. */
  link_live: boolean;
}

export interface InboxActionFacts {
  /** The item is listed in this user's Deleted folder (a party deletion or a removal). */
  in_deleted_folder: boolean;
  /** The user removed this item from their inbox (M-A17; return-to-inbox brings it back). */
  removed: boolean;
}

export interface InboxRefusal {
  code: ErrorCode;
  message: string;
  status: number;
  details?: Record<string, unknown>;
}
export type InboxCheckResult = InboxRefusal | 'noop' | null;

/**
 * The envelope is signable for this recipient (open, the recipient unsigned, not expired). C3
 * (D-1) — RecipientInboxRepository runs the same envelopeOpenForSigning / signerMayStillSign
 * under the lock; the turn is the shared mayActNow (entry.turn); the live emailed link is a
 * session-table read the repository re-does (entry.link_live).
 */
export function inboxSignable(e: InboxActionEntry, now: Date = new Date()): boolean {
  return envelopeOpenForSigning({ status: e.envelope_status, expires_at: e.envelope_expires_at }, now) && signerMayStillSign(e.signer_status);
}

/**
 * sign — POST inbox/:id/sign. Signable, the recipient's turn, and a live emailed link. The
 * repository re-runs this rule under the envelope row lock before it mints a session
 * (refusals 409 envelope_not_signable / signer_ineligible / not_your_turn / session_revoked /
 * link_expired).
 */
export function inboxSignDecision(e: InboxActionEntry, now: Date = new Date()): InboxCheckResult {
  if (!inboxSignable(e, now)) return { code: 'ENVELOPE_ILLEGAL_TRANSITION', message: 'This document can no longer be signed', status: 409, details: { reason: 'envelope_not_signable' } };
  if (e.turn !== 'now') return { code: 'ENVELOPE_ILLEGAL_TRANSITION', message: 'Someone before you has to sign first', status: 409, details: { reason: 'not_your_turn' } };
  if (!e.link_live) return { code: 'ENVELOPE_ILLEGAL_TRANSITION', message: 'This link was replaced or has expired. Open the newest email, or sign in to your inbox.', status: 409, details: { reason: 'session_revoked' } };
  return null;
}

/**
 * download — POST inbox/:id/signed-copy (a bound item only: a discovered item's signed copy
 * comes through the emailed link). A completed envelope the user signed, not purged. The route
 * enforces this function (RecipientInboxService.signedCopy).
 */
export function inboxDownloadDecision(e: Pick<InboxActionEntry, 'source' | 'envelope_status' | 'signer_status' | 'purge_state'>): InboxCheckResult {
  if (e.source !== 'bound') return { code: 'NOT_FOUND', message: 'Not in your inbox', status: 404, details: { reason: 'inbox_item_not_found' } };
  if (!(e.envelope_status === 'COMPLETED' && e.signer_status === 'SIGNED' && !isPurgeExecuted(e.purge_state))) {
    return { code: 'ENVELOPE_ILLEGAL_TRANSITION', message: 'A signed copy is available once everyone has signed', status: 409 };
  }
  return null;
}

/** delete — POST inbox/:id/remove-from-inbox (M-A17: any item, any state). Already in the Deleted folder ⇒ nothing to do. */
export function inboxDeleteDecision(f: InboxActionFacts): InboxCheckResult {
  return f.in_deleted_folder ? 'noop' : null;
}

/** restore — POST inbox/:id/return-to-inbox. Only an item the user removed comes back (else restored: false). */
export function inboxRestoreDecision(f: InboxActionFacts): InboxCheckResult {
  return f.removed ? null : 'noop';
}

/** report — POST inbox/:id/report: keyed by a live binding id, so a bound item only (a handle is 404). */
export function inboxReportDecision(e: Pick<InboxActionEntry, 'source'>): InboxCheckResult {
  return e.source === 'bound' ? null : { code: 'NOT_FOUND', message: 'Not in your inbox', status: 404 };
}

export function inboxActions(e: InboxActionEntry, f: InboxActionFacts, now: Date = new Date()): InboxActions {
  return {
    sign: inboxSignDecision(e, now) === null,
    download: inboxDownloadDecision(e) === null,
    delete: inboxDeleteDecision(f) === null,
    restore: inboxRestoreDecision(f) === null,
    report: inboxReportDecision(e) === null,
  };
}
