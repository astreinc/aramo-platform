import { AramoError, type ErrorCode } from '@aramo/common';
import { ESIGN_SCOPE } from '@aramo/identity';
import {
  PARTY_DELETABLE_STATUSES,
  SENDER_ACTION_KEYS,
  TERMINAL_ENVELOPE_STATUSES,
  hostedSessionRefusal,
  isDraftEditable,
  isPartyDeletable,
  isPurgeEligible,
  isPurgeExecuted,
  isPurgeQueued,
  remindableSigners,
  type SenderActionKey,
} from '@aramo/sign-client';

// Aramo-Sign-Client-Rule-Consolidation-Directive-v1_0-LOCKED (480ecdbb) §3 C1 — the
// server decides what a user may do with an envelope (G-2). This module is the ONE home of
// every sender envelope action rule: `senderActions()` computes the `actions` object sent on
// every sender list row and detail, and each route enforces the SAME check functions below
// at the point it always enforced them (so every refusal code, HTTP status and
// details.reason is unchanged). Clients render `actions` and never re-derive it.
//
// Each action is an ordered list of checks (SENDER_ACTION_RULES). A check names where the
// request is refused:
//   boundary — the route decorator (EsignSenderBoundary scope); the check names that scope.
//   service  — the route/service calls this check function and throws its refusal.
//   locked   — the repository or signing engine re-checks it under the envelope row lock
//              (race-safe); the check here mirrors that rule exactly.
// C3 (PO 2026-11-21, D-1) — every `locked` check calls the ONE @aramo/sign-client function the
// repository / engine calls under the lock (locked-rules.ts); nothing here mirrors it.
// A check may also answer 'noop': the route accepts the request but it changes nothing
// (e.g. deleting an envelope already in the Deleted folder). The action is not offered.

// Client Rule Consolidation C3 — the key list lives once in @aramo/sign-client (clients read
// `actions` with the same list).
export { SENDER_ACTION_KEYS, type SenderActionKey } from '@aramo/sign-client';
export type SenderActions = Record<SenderActionKey, boolean>;

// The Sign application's own key (SignatureEnvelope.source_application).
export const SIGN_APPLICATION = 'aramo-sign';
export const ESIGN_READ_SCOPE = 'sign:envelope:read';
export const ESIGN_CREATE_SCOPE = 'sign:envelope:create';
export const ESIGN_SEND_SCOPE = 'sign:envelope:send';

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(TERMINAL_ENVELOPE_STATUSES);
// Retention and Purge W5 — the statuses the Deleted folder accepts (SignPurgeRepository.partyDelete
// calls the same isPartyDeletable, C3 D-1).
export const DELETABLE_STATUSES: ReadonlySet<string> = new Set(PARTY_DELETABLE_STATUSES);

export interface ActionActor {
  sub: string;
  scopes: readonly string[];
}

export interface ActionRecipient {
  id: string;
  status: string;
  signing_order: number;
  recipient_kind?: string | null;
  witness_for_signer_id?: string | null;
}

export interface ActionEnvelope {
  status: string;
  owner_id: string;
  source_application: string;
  envelope_mode?: string | null; // 'SELF' | 'STANDARD' (stored value)
  routing_mode: string;
  expires_at?: Date | null;
  purge_state?: string | null;
  recipients: readonly ActionRecipient[];
}

/** Request-scoped facts the routes also read (the same sources, never a client value). */
export interface SenderActionFacts {
  /** The tenant may author: BUSINESS, or a PERSONAL tenant while Personal sending is open (SenderContextService.authoringOpen). */
  can_author: boolean;
  /** SIGN_PURGE_ENABLED (SignPurgeService.enabled). */
  purge_enabled: boolean;
  /** sign.in_person_signing launch availability (SignFeatureGate). */
  in_person_available: boolean;
  /** The envelope is in this tenant's Deleted folder (an active SENDER party deletion). */
  deleted: boolean;
  /** canSelfSignNow (sender-envelope.service.ts) — the self-sign session rule. */
  can_self_sign_now: boolean;
  /** The caller has an inbox item to sign this envelope through (awaiting_you with an item id). */
  inbox_item: boolean;
}

export interface Refusal {
  code: ErrorCode;
  message: string;
  status: number;
  details?: Record<string, unknown>;
}
export type CheckResult = Refusal | 'noop' | null;
export type EnforcedBy = 'boundary' | 'service' | 'locked';

export interface ActionCheck {
  id: string;
  enforced_by: EnforcedBy;
  /** boundary checks only: the scope the route decorator requires. */
  scope?: string;
  test: (actor: ActionActor, env: ActionEnvelope, facts: SenderActionFacts) => CheckResult;
}

export function refusalError(r: Refusal, requestId: string): AramoError {
  return new AramoError(r.code, r.message, r.status, { requestId, ...(r.details !== undefined ? { details: r.details } : {}) });
}

/** Throws the check's refusal; 'noop' and null pass (the route continues). */
export function enforce(result: CheckResult, requestId: string): void {
  if (result !== null && result !== 'noop') throw refusalError(result, requestId);
}

// ── refusals (verbatim from the routes that always raised them) ─────────────

export const personalSendingNotEnabled = (): Refusal => ({
  code: 'INSUFFICIENT_PERMISSIONS',
  message: 'Sending from a personal account is not enabled',
  status: 403,
  details: { reason: 'personal_sending_not_enabled' },
});

export const purgeNotEnabled = (): Refusal => ({
  code: 'ESIGN_FEATURE_NOT_AVAILABLE',
  message: 'Document retention and purge are not enabled',
  status: 403,
  details: { reason: 'purge_not_enabled' },
});

const missingScope = (scope: string): Refusal => ({ code: 'INSUFFICIENT_PERMISSIONS', message: 'Insufficient permissions', status: 403, details: { missing_scopes: [scope] } });

// ── checks ───────────────────────────────────────────────────────────────────

function scopeCheck(scope: string): ActionCheck {
  return { id: `scope:${scope}`, enforced_by: 'boundary', scope, test: (a) => (a.scopes.includes(scope) ? null : missingScope(scope)) };
}

/** SenderContextService.assertCanAuthor — a PERSONAL tenant authors only while Personal sending is open. */
export function authorRefusal(can_author: boolean): CheckResult {
  return can_author ? null : personalSendingNotEnabled();
}
const authorCheck: ActionCheck = { id: 'author', enforced_by: 'service', test: (_a, _e, f) => authorRefusal(f.can_author) };

/**
 * Sign Unified Product S-3 then S-1 (SenderEnvelopeService.assertMayChange): an envelope another
 * application created is never changed here; otherwise the owner may act, anyone else needs
 * sign:envelope:manage:all.
 */
export function changeRefusal(actor: ActionActor, env: Pick<ActionEnvelope, 'owner_id' | 'source_application'>): CheckResult {
  if (env.source_application !== SIGN_APPLICATION) {
    return {
      code: 'ENVELOPE_ILLEGAL_TRANSITION',
      message: 'This envelope is managed by the application that sent it',
      status: 409,
      details: { reason: 'managed_by_source_application', source_application: env.source_application },
    };
  }
  if (env.owner_id === actor.sub) return null;
  if (actor.scopes.includes(ESIGN_SCOPE.ENVELOPE_MANAGE_ALL)) return null;
  return {
    code: 'INSUFFICIENT_PERMISSIONS',
    message: 'Only the sender of this envelope, or a Sign Admin, can change it',
    status: 403,
    details: { reason: 'envelope_not_owned', missing_scopes: [ESIGN_SCOPE.ENVELOPE_MANAGE_ALL] },
  };
}
const changeCheck: ActionCheck = { id: 'change', enforced_by: 'service', test: (a, e) => changeRefusal(a, e) };

const illegalStatus = (status: string): Refusal => ({ code: 'ENVELOPE_ILLEGAL_TRANSITION', message: `envelope is ${status}`, status: 409 });

/** Send: a DRAFT only (SenderEnvelopeService.send). */
export function sendStateRefusal(env: Pick<ActionEnvelope, 'status'>): CheckResult {
  return env.status === 'DRAFT' ? null : illegalStatus(env.status);
}

/**
 * Void: a SENT or IN_PROGRESS envelope. Client Rule Consolidation C3 (DV-void-draft, PO-ruled
 * 2026-11-21) — drafts are deleted, never voided: the route and `actions.void` refuse a DRAFT
 * together (409 ENVELOPE_ILLEGAL_TRANSITION, details.reason draft_use_delete). No Sign client,
 * ATS integration or connector voids a draft through this route.
 */
export function voidStateRefusal(env: Pick<ActionEnvelope, 'status'>): CheckResult {
  if (env.status === 'DRAFT') {
    return { code: 'ENVELOPE_ILLEGAL_TRANSITION', message: 'A draft is deleted, not voided', status: 409, details: { reason: 'draft_use_delete' } };
  }
  return TERMINAL_STATUSES.has(env.status) ? illegalStatus(env.status) : null;
}

/** Delete a draft: a DRAFT only (also re-checked by the repository under the row lock). */
export function deleteDraftStateRefusal(env: Pick<ActionEnvelope, 'status'>): CheckResult {
  return env.status === 'DRAFT'
    ? null
    : { code: 'ENVELOPE_ILLEGAL_TRANSITION', message: 'Only a draft can be deleted. Void a sent envelope instead.', status: 409, details: { reason: 'envelope_not_draft' } };
}

/** Edit (every DRAFT authoring write): the repository asserts isDraftEditable under the row lock (409). */
export function editStateRefusal(env: Pick<ActionEnvelope, 'status'>): CheckResult {
  return isDraftEditable(env.status) ? null : illegalStatus(env.status);
}

/** Remind: a self-sign envelope invites no one, so no one is reminded (SenderEnvelopeService.remind). */
export function remindModeRefusal(env: Pick<ActionEnvelope, 'envelope_mode'>): CheckResult {
  return env.envelope_mode === 'SELF'
    ? { code: 'ESIGN_REMINDER_NOT_ALLOWED', message: 'A document you sign yourself has no one to remind', status: 409, details: { reason: 'self_sign_no_reminders' } }
    : null;
}

/**
 * M-A5 §1.2 / §3, Multi-Signer — a recipient may be reminded now: signing open, not a SELF
 * envelope, an emailed-link signer (SIGNER / WITNESS), witness ready, unsigned, and (sequential)
 * their turn. The detail's per-recipient `can_remind` is this rule; the engine re-checks it.
 */
export function canRemindRecipient(env: Pick<ActionEnvelope, 'status' | 'envelope_mode' | 'routing_mode' | 'recipients'>, r: ActionRecipient): boolean {
  if (env.envelope_mode === 'SELF') return false;
  // C3 (D-1) — the engine's remindSigner calls the same remindableSigners under the lock.
  return remindableSigners(env, env.recipients).some((x) => x.id === r.id);
}

/** Download / certificate: a COMPLETED envelope whose executed documents were not purged. */
export function downloadStateRefusal(env: Pick<ActionEnvelope, 'status' | 'purge_state'>, envelope_id = ''): CheckResult {
  if (env.status !== 'COMPLETED') return { code: 'ENVELOPE_ILLEGAL_TRANSITION', message: 'Executed documents exist only for a completed envelope', status: 409 };
  if (isPurgeExecuted(env.purge_state)) return { code: 'ENVELOPE_PURGED', message: `envelope ${envelope_id} documents were purged`, status: 410 };
  return null;
}

/** M-A5 §3 — an in-person signer the host may start a session for now (EsignService.issueHostedSession). */
export function hostableRecipient(env: Pick<ActionEnvelope, 'status' | 'routing_mode' | 'expires_at' | 'recipients'>, r: ActionRecipient, now: Date = new Date()): boolean {
  // C3 (D-1) — EsignService.issueHostedSession enforces the same hostedSessionRefusal under the lock.
  return hostedSessionRefusal(env, env.recipients, r.id, now) === null;
}

const notTerminalForDelete: Refusal = {
  code: 'ENVELOPE_ILLEGAL_TRANSITION',
  message: 'Only a completed, declined, voided or expired envelope can be deleted',
  status: 409,
  details: { reason: 'envelope_not_terminal' },
};
const notPurgeable: Refusal = {
  code: 'ENVELOPE_ILLEGAL_TRANSITION',
  message: 'Only a completed, declined or voided envelope can be purged',
  status: 409,
  details: { reason: 'envelope_not_purgeable' },
};
const purged = (status = 410): Refusal => ({ code: 'ENVELOPE_PURGED', message: 'envelope was purged', status });

const RULE_DRAFT_EDIT: ActionCheck = { id: 'state:draft', enforced_by: 'locked', test: (_a, e) => editStateRefusal(e) };

export const SENDER_ACTION_RULES: Record<SenderActionKey, readonly ActionCheck[]> = {
  // PATCH envelopes/:id, documents, recipients, fields (sign:envelope:create).
  edit: [scopeCheck(ESIGN_CREATE_SCOPE), authorCheck, changeCheck, RULE_DRAFT_EDIT],
  // POST envelopes/:id/send (sign:envelope:send). Readiness, payments and the Personal
  // send gate are checks on the draft's content, reported by the send itself.
  send: [scopeCheck(ESIGN_SEND_SCOPE), authorCheck, changeCheck, { id: 'state:draft', enforced_by: 'service', test: (_a, e) => sendStateRefusal(e) }],
  // DELETE envelopes/:id (sign:envelope:create).
  delete_draft: [scopeCheck(ESIGN_CREATE_SCOPE), authorCheck, changeCheck, { id: 'state:draft', enforced_by: 'service', test: (_a, e) => deleteDraftStateRefusal(e) }],
  // POST envelopes/:id/void (sign:envelope:send).
  void: [scopeCheck(ESIGN_SEND_SCOPE), authorCheck, changeCheck, { id: 'state:open', enforced_by: 'service', test: (_a, e) => voidStateRefusal(e) }],
  // POST envelopes/:id/remind (sign:envelope:send). The cooldown and the 24-hour limit are
  // time-based and reported per recipient as reminder_available_at (429 with retry_at).
  remind: [
    scopeCheck(ESIGN_SEND_SCOPE),
    authorCheck,
    changeCheck,
    { id: 'mode:not_self', enforced_by: 'service', test: (_a, e) => remindModeRefusal(e) },
    {
      id: 'remindable_recipient',
      enforced_by: 'locked',
      test: (_a, e) => (e.recipients.some((r) => canRemindRecipient(e, r)) ? null : { code: 'ESIGN_REMINDER_NOT_ALLOWED', message: 'No signer can be reminded now', status: 409 }),
    },
  ],
  // POST envelopes/:id/delete (sign:envelope:read + ownership, #1131).
  delete: [
    { id: 'purge_enabled', enforced_by: 'service', test: (_a, _e, f) => (f.purge_enabled ? null : purgeNotEnabled()) },
    scopeCheck(ESIGN_READ_SCOPE),
    changeCheck,
    { id: 'state:deletable', enforced_by: 'locked', test: (_a, e) => (isPartyDeletable(e.status) ? null : notTerminalForDelete) },
    { id: 'folder:not_deleted', enforced_by: 'locked', test: (_a, _e, f) => (f.deleted ? 'noop' : null) },
  ],
  // POST envelopes/:id/restore (sign:envelope:read + ownership, #1131).
  restore: [
    { id: 'purge_enabled', enforced_by: 'service', test: (_a, _e, f) => (f.purge_enabled ? null : purgeNotEnabled()) },
    scopeCheck(ESIGN_READ_SCOPE),
    changeCheck,
    { id: 'purge:not_executed', enforced_by: 'locked', test: (_a, e) => (isPurgeExecuted(e.purge_state) ? purged() : null) },
    { id: 'folder:deleted', enforced_by: 'locked', test: (_a, _e, f) => (f.deleted ? null : 'noop') },
  ],
  // GET envelopes/:id/executed (sign:envelope:read) — the executed documents.
  download: [scopeCheck(ESIGN_READ_SCOPE), { id: 'state:completed_not_purged', enforced_by: 'service', test: (_a, e) => downloadStateRefusal(e) }],
  // GET envelopes/:id/executed (sign:envelope:read) — the same bundle carries the certificate.
  certificate: [scopeCheck(ESIGN_READ_SCOPE), { id: 'state:completed_not_purged', enforced_by: 'service', test: (_a, e) => downloadStateRefusal(e) }],
  // POST envelopes/:id/self-sign-session (canSelfSignNow: sign:envelope:send, ownership, the
  // caller's bound recipient, their turn) or POST inbox/:id/sign (the caller's inbox item).
  sign: [
    {
      id: 'self_sign_or_inbox_item',
      enforced_by: 'locked',
      test: (_a, _e, f) => (f.can_self_sign_now || f.inbox_item ? null : { code: 'ENVELOPE_ILLEGAL_TRANSITION', message: 'You cannot sign this envelope now', status: 409 }),
    },
  ],
  // POST envelopes/:id/hosted-sessions (sign:envelope:send).
  host_in_person: [
    scopeCheck(ESIGN_SEND_SCOPE),
    authorCheck,
    {
      id: 'feature:in_person_signing',
      enforced_by: 'service',
      test: (_a, _e, f) => (f.in_person_available ? null : { code: 'ESIGN_FEATURE_NOT_AVAILABLE', message: 'This feature is not available in Aramo Sign yet', status: 403 }),
    },
    changeCheck,
    {
      id: 'hostable_recipient',
      enforced_by: 'locked',
      test: (_a, e) => (e.recipients.some((r) => hostableRecipient(e, r)) ? null : { code: 'ENVELOPE_ILLEGAL_TRANSITION', message: 'No in-person signer can sign now', status: 409 }),
    },
  ],
  // POST envelopes/:id/purge (sign:envelope:manage:all). A queued purge may be raised to a
  // higher level, so a queued envelope still offers purge.
  purge: [
    { id: 'purge_enabled', enforced_by: 'service', test: (_a, _e, f) => (f.purge_enabled ? null : purgeNotEnabled()) },
    scopeCheck(ESIGN_SCOPE.ENVELOPE_MANAGE_ALL),
    { id: 'state:purgeable', enforced_by: 'locked', test: (_a, e) => (isPurgeEligible(e.status) ? null : notPurgeable) },
    { id: 'purge:not_executed', enforced_by: 'locked', test: (_a, e) => (isPurgeExecuted(e.purge_state) ? purged() : null) },
  ],
  // POST envelopes/:id/purge/dequeue (sign:envelope:manage:all).
  dequeue_purge: [
    { id: 'purge_enabled', enforced_by: 'service', test: (_a, _e, f) => (f.purge_enabled ? null : purgeNotEnabled()) },
    scopeCheck(ESIGN_SCOPE.ENVELOPE_MANAGE_ALL),
    {
      id: 'purge:queued',
      enforced_by: 'locked',
      test: (_a, e) =>
        isPurgeQueued(e.purge_state) ? null : { code: 'ENVELOPE_ILLEGAL_TRANSITION', message: 'This envelope has no queued purge', status: 409, details: { reason: 'purge_not_queued' } },
    },
  ],
};

/** The first check of `action` that refuses (or 'noop'), else null: the action's predicate. */
export function senderActionDecision(action: SenderActionKey, actor: ActionActor, env: ActionEnvelope, facts: SenderActionFacts): CheckResult {
  for (const check of SENDER_ACTION_RULES[action]) {
    const r = check.test(actor, env, facts);
    if (r !== null) return r;
  }
  return null;
}

/** The `actions` object of a sender list row or detail. */
export function senderActions(actor: ActionActor, env: ActionEnvelope, facts: SenderActionFacts): SenderActions {
  const out = {} as SenderActions;
  for (const k of SENDER_ACTION_KEYS) out[k] = senderActionDecision(k, actor, env, facts) === null;
  return out;
}
