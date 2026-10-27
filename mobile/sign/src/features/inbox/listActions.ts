// Agreements list actions that need facts the sender LIST lacks (M-A4 §3.5): each reads
// the envelope detail first (its ETag, `editable`, sender, `can_remind`) and acts only
// when envelopeActions.actionsFor — the detail screen's rule — allows it. Nothing here
// decides policy; a refusal carries the server's reason.
import { isApiError } from '../../api/errors';
import { refusalMessage } from '../../api/refusalMessages';
import type { WorkspaceClient } from '../../api/workspaceClient';
import {
  actionsFor,
  createReminder,
  nextReminderAt,
  reminderRefusalCopy,
  remindableSigners,
  voidEnvelope,
  type VoidOutcome,
} from './envelopeActions';
import { dateTime } from './agreementsModel';
import { fetchDetail, type DetailWithEtag } from './queries';
import type { SenderContext } from './types';

export const NOT_MANAGEABLE = 'Only the sender or a Sign admin can change this envelope.';
export const NOT_EDITABLE = 'Only a draft you created in Aramo Sign can be edited here.';
export const NOTHING_TO_REMIND = 'Everyone who can be reminded has signed.';

function unknownRefusal(e: unknown): string {
  return isApiError(e) ? refusalMessage(e) : refusalMessage({ reason: 'unknown', code: 'unknown' });
}

export type RemindOutcome =
  | { readonly kind: 'sent'; readonly value: DetailWithEtag }
  | { readonly kind: 'refused'; readonly message: string };

/**
 * Remind from the list: read the detail, check the action and the server's remindable
 * signers, then send ONE reminder intent (one Idempotency-Key, as on the detail screen).
 */
export async function remindFromList(
  workspace: WorkspaceClient,
  envelopeId: string,
  ctx: SenderContext | null | undefined,
  now: number = Date.now(),
): Promise<RemindOutcome> {
  let current: DetailWithEtag;
  try {
    current = await fetchDetail(workspace, envelopeId);
  } catch (e) {
    return { kind: 'refused', message: unknownRefusal(e) };
  }
  if (!actionsFor(current.detail, ctx).remind) return { kind: 'refused', message: NOT_MANAGEABLE };
  const remindable = remindableSigners(current.detail, now);
  if (remindable.length === 0) {
    const at = nextReminderAt(current.detail);
    return {
      kind: 'refused',
      message: at ? `You can send another reminder at ${dateTime(at)}.` : NOTHING_TO_REMIND,
    };
  }
  const signerId = remindable.length === 1 ? remindable[0]?.id : undefined;
  try {
    const value = await createReminder(workspace, envelopeId, signerId).send();
    return { kind: 'sent', value };
  } catch (e) {
    return {
      kind: 'refused',
      message: isApiError(e) ? reminderRefusalCopy(e) : unknownRefusal(e),
    };
  }
}

/** Void from the list: read the detail (for its ETag), check the action, then void. */
export async function voidFromList(
  workspace: WorkspaceClient,
  envelopeId: string,
  ctx: SenderContext | null | undefined,
  reason: string,
): Promise<VoidOutcome> {
  let current: DetailWithEtag;
  try {
    current = await fetchDetail(workspace, envelopeId);
  } catch (e) {
    return { kind: 'refused', message: unknownRefusal(e) };
  }
  if (!actionsFor(current.detail, ctx).void) return { kind: 'refused', message: NOT_MANAGEABLE };
  return voidEnvelope(workspace, current, reason);
}

export type EditCheck =
  | { readonly kind: 'editable' }
  | { readonly kind: 'refused'; readonly message: string };

/** Edit from the list: only when the server says the draft is `editable`. */
export async function checkEditable(
  workspace: WorkspaceClient,
  envelopeId: string,
  ctx: SenderContext | null | undefined,
): Promise<EditCheck> {
  try {
    const current = await fetchDetail(workspace, envelopeId);
    return actionsFor(current.detail, ctx).continueEditing
      ? { kind: 'editable' }
      : { kind: 'refused', message: NOT_EDITABLE };
  } catch (e) {
    return { kind: 'refused', message: unknownRefusal(e) };
  }
}
