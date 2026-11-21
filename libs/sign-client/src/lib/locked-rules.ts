// Client Rule Consolidation C3 — PO ruling 2026-11-21 on C1 divergence D-1: ONE function per
// "locked" check. The repository / signing engine calls each function with the row it read
// under the envelope row lock (the race-safe enforcement); the C1 `actions` predicate in
// sign-service calls the SAME function with the row it loaded. Pure: no database types.
//
//   isDraftEditable          SenderWorkspaceRepository.assertDraft   / actions.edit
//   isPartyDeletable         SignPurgeRepository.partyDelete          / actions.delete
//   isPurgeEligible          SignPurgeRepository.queue                / actions.purge
//   isPurgeExecuted          queue, partyRestore                      / actions.purge, restore, download
//   isPurgeQueued            SignPurgeRepository.dequeue, queue       / actions.dequeue_purge
//   remindableSigners        EsignService.remindSigner                / actions.remind, can_remind
//   sessionIssueRefusal      EsignService hosted / self-sign issue    / hostable, can_self_sign_now
//   hostedSessionRefusal     EsignService.issueHostedSession          / actions.host_in_person, hostable
//   selfSignTarget           EsignService.issueSelfSignSession        / can_self_sign_now (actions.sign)
//   envelopeOpenForSigning   the session-issue locks + inbox signing  / inbox actions.sign
//   signerMayStillSign       the same                                 / the same
import { currentTurnOf, isLinkSigner, recipientKindOf, signingRecipients, witnessReady, type TurnRow } from './turn-rules.js';
import { SIGNABLE_ENVELOPE_STATUSES } from './envelope-lifecycle.js';

// ── envelope state ───────────────────────────────────────────────────────────

/** Every DRAFT authoring write (and send / delete-draft) needs a DRAFT. */
export function isDraftEditable(status: string): boolean {
  return status === 'DRAFT';
}

/** Retention and Purge — only completed, declined or voided envelopes are purged. */
export const PURGE_ELIGIBLE_STATUSES: readonly string[] = ['COMPLETED', 'DECLINED', 'VOIDED'];
/** W5 — the Deleted folder takes a finished envelope (purge-eligible or EXPIRED). */
export const PARTY_DELETABLE_STATUSES: readonly string[] = [...PURGE_ELIGIBLE_STATUSES, 'EXPIRED'];

export function isPurgeEligible(status: string): boolean {
  return PURGE_ELIGIBLE_STATUSES.includes(status);
}

export function isPartyDeletable(status: string): boolean {
  return PARTY_DELETABLE_STATUSES.includes(status);
}

export function isPurgeExecuted(purge_state: string | null | undefined): boolean {
  return purge_state === 'EXECUTED';
}

export function isPurgeQueued(purge_state: string | null | undefined): boolean {
  return purge_state === 'QUEUED';
}

// ── signing ──────────────────────────────────────────────────────────────────

export const PENDING_SIGNER_STATUSES: readonly string[] = ['PENDING', 'VIEWED'];

/** A recipient who has not signed or declined. */
export function signerMayStillSign(status: string): boolean {
  return PENDING_SIGNER_STATUSES.includes(status);
}

/**
 * The envelope accepts a signer action now: SENT / IN_PROGRESS, not past its expiry, and (when
 * the caller read it) not a deleted draft.
 */
export function envelopeOpenForSigning(
  env: { readonly status: string; readonly expires_at?: Date | null; readonly deleted_at?: Date | null },
  now: Date = new Date(),
): boolean {
  if (!SIGNABLE_ENVELOPE_STATUSES.includes(env.status)) return false;
  if (env.deleted_at !== undefined && env.deleted_at !== null) return false;
  return env.expires_at === undefined || env.expires_at === null || env.expires_at.getTime() > now.getTime();
}

/**
 * M-A5 §1.2 / Multi-Signer §4 / §1.17 — the recipients a reminder reaches now: signing open, an
 * unsigned signing recipient (SEQUENTIAL: only the first in the order), who holds an emailed
 * link (SIGNER / WITNESS) and, for a witness, whose signer has signed. The cooldown and the daily
 * limit are time-based and checked separately.
 */
export function remindableSigners<T extends TurnRow>(env: { readonly status: string; readonly routing_mode: string }, rows: readonly T[]): T[] {
  if (!SIGNABLE_ENVELOPE_STATUSES.includes(env.status)) return [];
  const incomplete = signingRecipients(rows)
    .filter((s) => signerMayStillSign(s.status))
    .sort((a, b) => a.signing_order - b.signing_order);
  const pool = env.routing_mode === 'SEQUENTIAL' ? incomplete.slice(0, 1) : incomplete;
  return pool.filter((s) => isLinkSigner(s) && witnessReady(rows, s));
}

export type SessionIssueRefusalReason = 'signer_not_found' | 'envelope_not_signable' | 'signer_ineligible' | 'not_your_turn' | 'not_in_person_signer';

/**
 * M-A5 §3 / §4 — the checks a hosted or self-sign session shares: the recipient is on the
 * envelope, the envelope accepts signing now, the recipient signs and has not finished, and
 * (SEQUENTIAL) it is their turn. The refusal reason, or null.
 */
export function sessionIssueRefusal(
  env: { readonly status: string; readonly routing_mode: string; readonly expires_at?: Date | null },
  rows: readonly TurnRow[],
  signer_id: string,
  now: Date = new Date(),
): SessionIssueRefusalReason | null {
  const signer = rows.find((r) => r.id === signer_id);
  if (signer === undefined) return 'signer_not_found';
  if (!envelopeOpenForSigning(env, now)) return 'envelope_not_signable';
  if (recipientKindOf(signer) === 'RECEIVES_COPY' || !signerMayStillSign(signer.status)) return 'signer_ineligible';
  if (env.routing_mode === 'SEQUENTIAL' && currentTurnOf(rows)?.id !== signer_id) return 'not_your_turn';
  return null;
}

/** M-A5 §3 — a hosted (in-person) session: the shared checks, then an IN_PERSON_SIGNER. */
export function hostedSessionRefusal(
  env: { readonly status: string; readonly routing_mode: string; readonly expires_at?: Date | null },
  rows: readonly TurnRow[],
  signer_id: string,
  now: Date = new Date(),
): SessionIssueRefusalReason | null {
  const shared = sessionIssueRefusal(env, rows, signer_id, now);
  if (shared !== null) return shared;
  const signer = rows.find((r) => r.id === signer_id);
  return signer !== undefined && recipientKindOf(signer) === 'IN_PERSON_SIGNER' ? null : 'not_in_person_signer';
}

/**
 * M-A5 §4.1 — the recipient a self-sign session is for: the first signing recipient (in signing
 * order) bound to the caller by Assign to me, optionally the one named. Null = not bound to you.
 */
export function selfSignTarget<T extends TurnRow & { readonly bound_user_id?: string | null }>(rows: readonly T[], user_id: string, signer_id?: string): T | null {
  const bound = signingRecipients(rows)
    .filter((r) => r.bound_user_id === user_id && (signer_id === undefined || r.id === signer_id))
    .sort((a, b) => a.signing_order - b.signing_order);
  return bound[0] ?? null;
}
