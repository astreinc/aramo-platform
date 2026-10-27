// Agreements row actions by state (handoff §2A "Swipe left"; M-A4 §3.5–§3.7). Pure.
//
//   Needs me                       -> Sign      (inbox `can_sign` only)
//   Waiting, own sent              -> Remind, Void
//   Draft                          -> Edit, Delete
//   Completed with an artifact     -> Share     (COMPLETED only; never declined/voided/expired)
//
// Visibility follows what the server returned, exactly as envelopeActions.actionsFor
// does on the detail screen; the device derives no policy. The sender LIST carries fewer
// facts than the detail (no `editable`, no sender id, no `can_remind`), so:
//   - ownership: the list is owner-scoped unless the caller holds read_all
//     (sign-service SenderEnvelopeService.ownerFilter), so a listed envelope is the
//     caller's own when `read_all` is not granted, and manageable by anyone holding
//     `manage_all`. A read_all-only caller gets no Remind/Void swipe (the detail screen,
//     which knows the sender, still offers them);
//   - `editable` and `can_remind`: the action reads the envelope detail first and acts
//     only when the detail allows it (see listActions.ts).
// Every swipe action is also an accessibility custom action (SwipeActions.tsx) and exists
// on the detail screen, so no action is swipe-only (M-A4 §3.6).
import type { AgreementRow } from './agreementsModel';
import { OPEN_STATUSES, SIGN_APPLICATION, type SenderContext } from './types';

export type SwipeActionKind = 'sign' | 'remind' | 'void' | 'edit' | 'delete' | 'share';

export interface SwipeAction {
  readonly kind: SwipeActionKind;
  readonly label: string;
  readonly tone: 'accent' | 'neutral' | 'destructive';
}

export const SWIPE_ACTION: Record<SwipeActionKind, SwipeAction> = {
  sign: { kind: 'sign', label: 'Sign', tone: 'accent' },
  remind: { kind: 'remind', label: 'Remind', tone: 'neutral' },
  void: { kind: 'void', label: 'Void', tone: 'destructive' },
  edit: { kind: 'edit', label: 'Edit', tone: 'neutral' },
  delete: { kind: 'delete', label: 'Delete', tone: 'destructive' },
  share: { kind: 'share', label: 'Share', tone: 'neutral' },
};

export interface SwipeContext {
  readonly sender: SenderContext | null | undefined;
  /** Server actions need the network; only an on-device draft can be changed offline. */
  readonly online: boolean;
}

/**
 * Whether the caller may change a sender-list envelope, from list-level facts only:
 * own (the list is owner-scoped without read_all) or manage_all, and send not refused.
 */
export function mayManageListed(sender: SenderContext | null | undefined): boolean {
  if (!sender) return false;
  const p = sender.permissions ?? {};
  if (p.send === false) return false;
  return p.manage_all === true || p.read_all !== true;
}

export function swipeActionsFor(row: AgreementRow, ctx: SwipeContext): SwipeAction[] {
  if (row.kind === 'local-draft') return [SWIPE_ACTION.edit, SWIPE_ACTION.delete];
  if (!ctx.online) return [];
  if (row.kind === 'received') {
    const i = row.item;
    if (i.can_sign) return [SWIPE_ACTION.sign];
    if (i.envelope_status === 'COMPLETED' && i.can_download) return [SWIPE_ACTION.share];
    return [];
  }
  const e = row.item;
  const fromSign = (e.source_application ?? SIGN_APPLICATION) === SIGN_APPLICATION;
  if (e.status === 'DRAFT')
    return fromSign && mayManageListed(ctx.sender) ? [SWIPE_ACTION.edit, SWIPE_ACTION.delete] : [];
  if (OPEN_STATUSES.has(e.status))
    return fromSign && mayManageListed(ctx.sender) ? [SWIPE_ACTION.remind, SWIPE_ACTION.void] : [];
  if (e.status === 'COMPLETED') return [SWIPE_ACTION.share];
  return [];
}

/** Screen-reader name of an action on a row ("Void Offer letter"). */
export function actionA11yLabel(action: SwipeAction, subject: string): string {
  return `${action.label} ${subject}`;
}
