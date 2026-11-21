// Agreements list actions that need the envelope detail (M-A4 §3.5): each reads the detail
// first (its ETag and per-signer `can_remind` / `reminder_available_at`) and acts only when
// the detail's server `actions` (envelopeActions.actionsFor) still allow it — the row was
// listed earlier. Nothing here decides policy; a refusal carries the server's reason.
import { isApiError } from '../../api/errors';
import { refusalMessage } from '../../api/refusalMessages';
import type { WorkspaceClient } from '../../api/workspaceClient';
import {
  actionsFor,
  createReminder,
  isReminderStale,
  nextReminderAt,
  reminderRefusalCopy,
  remindableSigners,
  voidEnvelope,
  type VoidOutcome,
} from './envelopeActions';
import { dateTime } from './agreementsModel';
import { fetchDetail, type DetailWithEtag } from './queries';
import { OPEN_STATUSES } from './types';

export const NOT_MANAGEABLE = 'Only the sender or a Sign admin can change this envelope.';
export const NOT_EDITABLE = 'Only a draft you created in Aramo Sign can be edited here.';
export const NOTHING_TO_REMIND = 'Everyone who can be reminded has signed.';

function unknownRefusal(e: unknown): string {
  return isApiError(e) ? refusalMessage(e) : refusalMessage({ reason: 'unknown', code: 'unknown' });
}

// UAT SND-23 — the envelope changed elsewhere (no longer open): the lists are refreshed.
export const ENVELOPE_CHANGED = refusalMessage({ reason: 'revision_mismatch', code: 'revision_mismatch' });

export type RemindOutcome =
  | { readonly kind: 'sent'; readonly value: DetailWithEtag }
  | { readonly kind: 'stale'; readonly message: string }
  | { readonly kind: 'refused'; readonly message: string };

/**
 * Remind from the list: read the detail, check the action and the server's remindable
 * signers, then send ONE reminder intent (one Idempotency-Key, as on the detail screen).
 */
export async function remindFromList(
  workspace: WorkspaceClient,
  envelopeId: string,
  now: number = Date.now(),
): Promise<RemindOutcome> {
  let current: DetailWithEtag;
  try {
    current = await fetchDetail(workspace, envelopeId);
  } catch (e) {
    return { kind: 'refused', message: unknownRefusal(e) };
  }
  // The row was open when listed; the fresh detail says it closed since (voided, completed…).
  if (!OPEN_STATUSES.has(current.detail.status)) return { kind: 'stale', message: ENVELOPE_CHANGED };
  const actions = actionsFor(current.detail);
  // The server offers no remind: nobody may be reminded now (when the user may still change
  // the envelope, i.e. void it), or the user may not change it at all.
  if (!actions.remind) return { kind: 'refused', message: actions.void ? NOTHING_TO_REMIND : NOT_MANAGEABLE };
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
    if (isApiError(e) && isReminderStale(e)) return { kind: 'stale', message: ENVELOPE_CHANGED };
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
  reason: string,
): Promise<VoidOutcome> {
  let current: DetailWithEtag;
  try {
    current = await fetchDetail(workspace, envelopeId);
  } catch (e) {
    return { kind: 'refused', message: unknownRefusal(e) };
  }
  if (!actionsFor(current.detail).void) return { kind: 'refused', message: NOT_MANAGEABLE };
  return voidEnvelope(workspace, current, reason);
}

export type EditCheck =
  | { readonly kind: 'editable' }
  | { readonly kind: 'refused'; readonly message: string };

/** Edit from the list: only when the server says the draft is `editable`. */
export async function checkEditable(
  workspace: WorkspaceClient,
  envelopeId: string,
): Promise<EditCheck> {
  try {
    const current = await fetchDetail(workspace, envelopeId);
    return actionsFor(current.detail).continueEditing
      ? { kind: 'editable' }
      : { kind: 'refused', message: NOT_EDITABLE };
  } catch (e) {
    return { kind: 'refused', message: unknownRefusal(e) };
  }
}
