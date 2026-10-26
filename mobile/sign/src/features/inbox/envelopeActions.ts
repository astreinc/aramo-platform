// Sender envelope detail: which actions show, and the remind / void calls (handoff
// §4.3, §1.5; directive §5; M-A3 §6, §7). Visibility follows the envelope state and the
// permissions/flags the server returns — the device re-derives no policy:
//   Remind, Void       — SENT / IN_PROGRESS envelopes the user may manage
//                        (own, or manage_all) that were created in Aramo Sign
//   Continue editing   — the server's `editable` (own Aramo Sign DRAFT)
//   View certificate   — COMPLETED
import { isApiError, type ApiError } from '../../api/errors';
import { refusalMessage } from '../../api/refusalMessages';
import { newIdempotencyKey, type WorkspaceClient } from '../../api/workspaceClient';
import { dateTime } from './agreementsModel';
import type { DetailWithEtag } from './queries';
import {
  OPEN_STATUSES,
  SIGN_APPLICATION,
  type DetailRecipient,
  type SenderContext,
  type SenderEnvelopeDetail,
} from './types';

export interface ActionSet {
  readonly continueEditing: boolean;
  readonly viewCertificate: boolean;
  readonly remind: boolean;
  readonly void: boolean;
}

export function mayManage(
  detail: SenderEnvelopeDetail,
  ctx: SenderContext | null | undefined,
): boolean {
  if (!ctx) return false;
  const own = detail.sender !== undefined && detail.sender.id === ctx.user.id;
  const perms = ctx.permissions ?? {};
  return (own || perms.manage_all === true) && perms.send !== false;
}

export function actionsFor(
  detail: SenderEnvelopeDetail,
  ctx: SenderContext | null | undefined,
): ActionSet {
  const fromSign = (detail.source_application ?? SIGN_APPLICATION) === SIGN_APPLICATION;
  const open = OPEN_STATUSES.has(detail.status);
  const manage = open && fromSign && mayManage(detail, ctx);
  return {
    continueEditing: detail.status === 'DRAFT' && detail.editable === true,
    viewCertificate: detail.status === 'COMPLETED',
    remind: manage,
    void: manage,
  };
}

/** Signers a reminder would reach now (server flags `can_remind` + no pending cooldown). */
export function remindableSigners(
  detail: SenderEnvelopeDetail,
  now: number = Date.now(),
): DetailRecipient[] {
  return detail.recipients.filter(
    (r) =>
      r.can_remind &&
      (r.reminder_available_at === null || Date.parse(r.reminder_available_at) <= now),
  );
}

/** The earliest time a reminder becomes possible when every remindable signer is cooling down. */
export function nextReminderAt(detail: SenderEnvelopeDetail): string | null {
  const times = detail.recipients
    .filter((r) => r.can_remind && r.reminder_available_at)
    .map((r) => r.reminder_available_at as string)
    .sort();
  return times[0] ?? null;
}

export function remindLabel(signers: readonly DetailRecipient[]): string {
  if (signers.length === 1 && signers[0]) return `Send reminder to ${signers[0].name}`;
  return `Send reminder to ${signers.length} signers`;
}

/** Copy for a reminder refusal; the 429 carries the exact retry time (M-A3 §7). */
export function reminderRefusalCopy(e: ApiError): string {
  if (e.is('reminder_cooldown', 'reminder_daily_limit')) {
    const at =
      e.retryAt ??
      (e.retryAfterSeconds !== null
        ? new Date(Date.now() + e.retryAfterSeconds * 1000).toISOString()
        : null);
    const head =
      e.reason === 'reminder_daily_limit'
        ? 'This envelope has had the most reminders allowed in 24 hours.'
        : 'This signer was reminded less than an hour ago.';
    return at ? `${head} You can send another reminder at ${dateTime(at)}.` : head;
  }
  return refusalMessage(e);
}

export const VOID_REASON_MIN = 3;

export function voidReasonValid(reason: string): boolean {
  return reason.trim().length >= VOID_REASON_MIN;
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

/** "{n} of {m} signed" + the bar tone. */
export function progressOf(detail: SenderEnvelopeDetail): {
  signed: number;
  total: number;
  tone: 'accent' | 'success' | 'destructive';
} {
  const signed = detail.recipients.filter((r) => r.status === 'SIGNED').length;
  return {
    signed,
    total: detail.recipients.length,
    tone:
      detail.status === 'COMPLETED'
        ? 'success'
        : detail.status === 'DECLINED'
          ? 'destructive'
          : 'accent',
  };
}

/** Signers in their order; for SEQUENTIAL routing, who signs now. */
export function orderedRecipients(detail: SenderEnvelopeDetail): DetailRecipient[] {
  if (detail.routing_mode !== 'SEQUENTIAL') return [...detail.recipients];
  return [...detail.recipients].sort((a, b) => (a.signing_order ?? 0) - (b.signing_order ?? 0));
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
