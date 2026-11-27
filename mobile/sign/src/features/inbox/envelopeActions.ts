// Sender envelope detail: which actions show, and the remind / void calls (handoff
// §4.3, §1.5; directive §5; M-A3 §6, §7). Client Rule Consolidation C3 (audit rows 3–10, 13) —
// every action follows the server's `actions` on the detail (read with senderActionsOf: an
// absent object allows nothing); the device derives nothing from status, ownership or scopes:
//   Remind, Void       — actions.remind / actions.void
//   Continue editing   — actions.edit
//   Delete draft       — actions.delete_draft (D-W6-3; a sent envelope is voided)
//   View certificate   — actions.certificate
//   Host in person     — each recipient's server `hostable`
import {
  nextReminderAt as sharedNextReminderAt,
  refusalMessage as sharedRefusal,
  remindableNow,
  senderActionsOf,
  voidReasonProblem,
  SELF_SIGN_NO_REMINDERS as SHARED_SELF_SIGN_NO_REMINDERS,
} from '@aramo/sign-client';

import { isApiError, type ApiError } from '../../api/errors';
import { refusalMessage } from '../../api/refusalMessages';
import { newIdempotencyKey, type WorkspaceClient } from '../../api/workspaceClient';
import { dateTime } from './agreementsModel';
import { fetchDetail, type DetailWithEtag } from './queries';
import { type DetailRecipient, type SenderEnvelopeDetail } from './types';

export interface ActionSet {
  readonly continueEditing: boolean;
  readonly deleteDraft: boolean;
  readonly viewCertificate: boolean;
  readonly remind: boolean;
  readonly void: boolean;
}

/** The detail screen's actions: the server's decision, nothing derived on the device. */
export function actionsFor(detail: SenderEnvelopeDetail): ActionSet {
  const a = senderActionsOf(detail);
  return {
    continueEditing: a.edit,
    deleteDraft: a.delete_draft,
    viewCertificate: a.certificate,
    remind: a.remind,
    void: a.void,
  };
}

/**
 * In-person signers the user can host now (M-A5 §3.1): the server's per-recipient `hostable`
 * (actions.host_in_person and the hosted-session rule), while this build ships hosting.
 */
export function hostableSigners(detail: SenderEnvelopeDetail, enabled: boolean): DetailRecipient[] {
  if (!enabled) return [];
  return detail.recipients.filter((r) => (r as { hostable?: boolean }).hostable === true);
}

/**
 * Signers a reminder would reach now (server flags `can_remind` + no pending cooldown). UAT SND-14:
 * the rule lives in @aramo/sign-client (remindableNow), shared with sign-web.
 */
export function remindableSigners(
  detail: SenderEnvelopeDetail,
  now: number = Date.now(),
): DetailRecipient[] {
  return remindableNow(detail.recipients, now);
}

/** The earliest time a reminder becomes possible (@aramo/sign-client nextReminderAt, shared with sign-web). */
export function nextReminderAt(detail: SenderEnvelopeDetail): string | null {
  return sharedNextReminderAt(detail.recipients);
}

export function remindLabel(signers: readonly DetailRecipient[]): string {
  if (signers.length === 1 && signers[0]) return `Send reminder to ${signers[0].name}`;
  return `Send reminder to ${signers.length} signers`;
}

/** Copy for a self-sign envelope: there is no one to remind (M-A12 W1-A). */
export const SELF_SIGN_NO_REMINDERS = SHARED_SELF_SIGN_NO_REMINDERS;

/**
 * UAT SND-23 — the server refuses a reminder (409 ESIGN_REMINDER_NOT_ALLOWED) when the
 * envelope changed elsewhere since it was read: voided, completed, declined or expired on
 * another device, or every signer finished. The app shows the change and reloads the
 * envelope, as for a 412 — never a generic error. Only the reason-less 409 is a change:
 * the 429 cooldown / daily limit and the self-sign refusal share the code with a reason.
 */
export function isReminderStale(e: ApiError): boolean {
  // errorFromBody: with no details.reason, `reason` falls back to the code.
  return e.status === 409 && e.code === 'ESIGN_REMINDER_NOT_ALLOWED' && e.reason === e.code;
}

/** Copy for a reminder refusal (C3 row 8: the shared wording); the 429 carries the exact retry time (M-A3 §7). */
export function reminderRefusalCopy(e: ApiError): string {
  const retryAt =
    e.retryAt ?? (e.retryAfterSeconds !== null ? new Date(Date.now() + e.retryAfterSeconds * 1000).toISOString() : null);
  return sharedRefusal(
    { code: e.code, reason: e.reason, status: e.status, details: e.details ?? null, retryAt },
    { time: (iso) => dateTime(iso) || null },
  );
}

/** C3 (audit row 6, Appendix A) — non-empty and at most 500 (the minimum of 3 is dropped). */
export function voidReasonValid(reason: string): boolean {
  return voidReasonProblem(reason) === null;
}

/**
 * One reminder intent. The Idempotency-Key is created once per user action and reused on
 * every retry of THAT action (README rule 6), so a retried tap never counts twice.
 */
export function createReminder(workspace: WorkspaceClient, envelopeId: string, signerId?: string) {
  const key = newIdempotencyKey();
  return {
    key,
    async send(): Promise<DetailWithEtag> {
      const r = await workspace.callWithMeta('/v1/sign/sender/envelopes/{id}/remind', 'post', {
        path: { id: envelopeId },
        body: signerId ? { signer_id: signerId } : {},
        idempotencyKey: key,
      });
      return { detail: r.data, etag: r.etag };
    },
  };
}

export type VoidOutcome =
  | { readonly kind: 'voided'; readonly value: DetailWithEtag }
  | { readonly kind: 'stale' }
  | { readonly kind: 'refused'; readonly message: string };

/** Void with the last-read ETag. A 412 means the envelope changed: refresh, never resubmit. */
export async function voidEnvelope(
  workspace: WorkspaceClient,
  current: DetailWithEtag,
  reason: string,
): Promise<VoidOutcome> {
  try {
    const r = await workspace.callWithMeta('/v1/sign/sender/envelopes/{id}/void', 'post', {
      path: { id: current.detail.id },
      body: { reason: reason.trim() },
      ifMatch: current.etag ?? {
        id: current.detail.id,
        revision: current.detail.revision ?? 1,
      },
    });
    return {
      kind: 'voided',
      value: { detail: r.data, etag: r.etag },
    };
  } catch (e) {
    if (isApiError(e) && (e.status === 412 || e.is('revision_mismatch', 'precondition_required')))
      return { kind: 'stale' };
    return {
      kind: 'refused',
      message: isApiError(e)
        ? refusalMessage(e)
        : refusalMessage({ reason: 'unknown', code: 'unknown' }),
    };
  }
}

/** Header sub-line (handoff §4.3). */
export function headerLine(
  detail: SenderEnvelopeDetail,
  shortDate: (iso: string | null) => string,
): string {
  if (detail.status === 'DRAFT') return `Draft · created ${shortDate(detail.created_at ?? null)}`;
  const from = detail.sender?.name ? `From ${detail.sender.name}` : 'Sent';
  let line = detail.sent_at ? `${from} · sent ${shortDate(detail.sent_at)}` : from;
  if (detail.status === 'COMPLETED' && detail.completed_at)
    line += ` · completed ${shortDate(detail.completed_at)}`;
  return line;
}

/** "{n} of {m} signed" + the bar tone. Copy recipients never sign and are not counted. */
export function progressOf(detail: SenderEnvelopeDetail): {
  signed: number;
  total: number;
  tone: 'accent' | 'success' | 'destructive';
} {
  const signing = signingOf(detail);
  const signed = signing.filter((r) => r.status === 'SIGNED').length;
  return {
    signed,
    total: signing.length,
    tone:
      detail.status === 'COMPLETED'
        ? 'success'
        : detail.status === 'DECLINED'
          ? 'destructive'
          : 'accent',
  };
}

/** The signing recipients (SIGNER + IN_PERSON_SIGNER); copy recipients never sign. */
export function signingOf(detail: SenderEnvelopeDetail): DetailRecipient[] {
  return detail.recipients.filter((r) => r.recipient_kind !== 'RECEIVES_COPY');
}

/** The copy recipients (M-A5 §2), shown apart under "Receives a copy". */
export function copiesOf(detail: SenderEnvelopeDetail): DetailRecipient[] {
  return detail.recipients.filter((r) => r.recipient_kind === 'RECEIVES_COPY');
}

/** Signing recipients in their order; for SEQUENTIAL routing, who signs now. */
export function orderedRecipients(detail: SenderEnvelopeDetail): DetailRecipient[] {
  const signing = signingOf(detail);
  if (detail.routing_mode !== 'SEQUENTIAL') return signing;
  return signing.sort((a, b) => (a.signing_order ?? 0) - (b.signing_order ?? 0));
}

const COPY_TIMING_LINE: Record<string, string> = {
  ON_SEND: 'Receives a copy when sent',
  ON_COMPLETION: 'Receives a copy after completion',
  BOTH: 'Receives a copy when sent and after completion',
};

/** The state line of a copy recipient (sender view only). */
export function copyTimingLine(r: DetailRecipient): string {
  return COPY_TIMING_LINE[r.copy_delivery ?? ''] ?? 'Receives a copy';
}

export function recipientStateLine(
  r: DetailRecipient,
  shortDate: (iso: string | null) => string,
): {
  text: string;
  tone: 'success' | 'accent' | 'secondary' | 'destructive';
} {
  switch (r.status) {
    case 'SIGNED':
      return { text: `Signed ${shortDate(r.signed_at)}`, tone: 'success' };
    case 'VIEWED':
      return { text: 'Opened · not signed yet', tone: 'accent' };
    case 'DECLINED':
      return { text: 'Declined', tone: 'destructive' };
    default:
      return { text: 'Waiting to sign', tone: 'secondary' };
  }
}

export type DeleteDraftOutcome =
  | { readonly kind: 'deleted' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'refused'; readonly message: string };

const NOT_DELETABLE = 'Only a draft you created in Aramo Sign can be deleted. Void a sent envelope instead.';

function refusal(e: unknown): DeleteDraftOutcome {
  return {
    kind: 'refused',
    message: isApiError(e)
      ? refusalMessage(e)
      : refusalMessage({ reason: 'unknown', code: 'unknown' }),
  };
}

/**
 * Delete a DRAFT with the last-read ETag (D-W6-3: DELETE /v1/sign/sender/envelopes/{id},
 * If-Match required for a native token). A 412 means it changed: the caller refreshes.
 */
export async function deleteDraftEnvelope(
  workspace: WorkspaceClient,
  current: DetailWithEtag,
): Promise<DeleteDraftOutcome> {
  if (!senderActionsOf(current.detail).delete_draft) return { kind: 'refused', message: NOT_DELETABLE };
  try {
    await workspace.call('/v1/sign/sender/envelopes/{id}', 'delete', {
      path: { id: current.detail.id },
      ifMatch: current.etag ?? {
        id: current.detail.id,
        revision: current.detail.revision ?? 1,
      },
    });
    return { kind: 'deleted' };
  } catch (e) {
    if (isApiError(e) && (e.status === 412 || e.is('revision_mismatch', 'precondition_required')))
      return { kind: 'stale' };
    return refusal(e);
  }
}

/**
 * Delete a draft from the list, where no ETag is held: read the envelope, then delete
 * with its ETag. The sender asked to delete this draft, so a change made in between
 * (412) is read once more and retried once; a second 412 is reported.
 */
export async function deleteDraftById(
  workspace: WorkspaceClient,
  envelopeId: string,
): Promise<DeleteDraftOutcome> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let current: DetailWithEtag;
    try {
      current = await fetchDetail(workspace, envelopeId);
    } catch (e) {
      return refusal(e);
    }
    const r = await deleteDraftEnvelope(workspace, current);
    if (r.kind !== 'stale') return r;
  }
  return { kind: 'stale' };
}
