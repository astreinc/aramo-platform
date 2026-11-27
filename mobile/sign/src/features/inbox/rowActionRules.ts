// Agreements row actions (handoff §2A "Swipe left"; M-A4 §3.5–§3.7). Pure.
//
//   Received                -> Sign (actions.sign) or Share (actions.download)
//   Sent                    -> Sign (actions.sign: the server's my_inbox_item_id, else a SELF
//                              session), Edit + Delete (actions.edit / delete_draft), Remind
//                              (actions.remind), Void (actions.void), Share (actions.download),
//                              Delete to the Deleted folder (actions.delete; APP-DELETED-1, kind 'trash')
//   On-device draft         -> Edit, Delete (never on the server yet)
//
// Client Rule Consolidation C3 (audit rows 3, 5, 9, 10, 12) — visibility follows the server's
// `actions` on each row (sender list rows and inbox items carry them, C1): the device derives
// nothing from status, ownership or permissions. An absent `actions` allows nothing.
// Every swipe action is also an accessibility custom action (SwipeActions.tsx) and exists
// on the detail screen, so no action is swipe-only (M-A4 §3.6).
import { inboxActionsOf, senderActionsOf } from '@aramo/sign-client';

import type { AgreementRow } from './agreementsModel';
import type { SenderContext } from './types';

export type SwipeActionKind = 'sign' | 'remind' | 'void' | 'edit' | 'delete' | 'trash' | 'share';

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
  // APP-DELETED-1 — a finished sent envelope to the Deleted folder (restorable), not a draft delete.
  trash: { kind: 'trash', label: 'Delete', tone: 'destructive' },
  share: { kind: 'share', label: 'Share', tone: 'neutral' },
};

export interface SwipeContext {
  readonly sender: SenderContext | null | undefined;
  /** Server actions need the network; only an on-device draft can be changed offline. */
  readonly online: boolean;
}

export function swipeActionsFor(row: AgreementRow, ctx: SwipeContext): SwipeAction[] {
  if (row.kind === 'local-draft') return [SWIPE_ACTION.edit, SWIPE_ACTION.delete];
  if (!ctx.online) return [];
  if (row.kind === 'received') {
    const a = inboxActionsOf(row.item);
    if (a.sign) return [SWIPE_ACTION.sign];
    if (a.download) return [SWIPE_ACTION.share];
    return [];
  }
  const a = senderActionsOf(row.item);
  const out: SwipeAction[] = [];
  if (a.sign) out.push(SWIPE_ACTION.sign);
  if (a.edit) out.push(SWIPE_ACTION.edit);
  if (a.delete_draft) out.push(SWIPE_ACTION.delete);
  if (a.remind) out.push(SWIPE_ACTION.remind);
  if (a.void) out.push(SWIPE_ACTION.void);
  if (a.download) out.push(SWIPE_ACTION.share);
  if (a.delete) out.push(SWIPE_ACTION.trash);
  return out;
}

/** Screen-reader name of an action on a row ("Void Offer letter"). */
export function actionA11yLabel(action: SwipeAction, subject: string): string {
  return `${action.label} ${subject}`;
}
