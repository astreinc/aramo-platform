// Shell model (M-A4 §1): the pure derivations behind the top bar, the side menu and the
// + button. Everything here is read from what the server already returned; the app
// derives no permission of its own (M-A4 §7).
//   - "Needs my signature" counts ONLY inbox items with `can_sign` (claimed associations,
//     M-A2); never an email match.
//   - Templates shows only while the backend reports sign.templates as available.
//   - "Sign a document" exists only when FEATURES.selfSign is on (no disabled placeholder).
import type { RootStackParamList, SendFlowIntent } from '../../navigation/types';
import { limitBanner, type AllowanceModel } from '../inbox/allowance';
import { mergeAgreements, needsSignatureSummary } from '../inbox/agreementsModel';
import type { InboxList, SenderContext } from '../inbox/types';
import { templatesAvailable } from '../send/templates';

/** The number of received envelopes the server says the user can sign now. */
export function needsSignatureCount(inbox: InboxList | null | undefined): number {
  return needsSignatureSummary(mergeAgreements(null, inbox ?? null)).count;
}

/** Badge text for a count: nothing at 0, "99+" above 99. */
export function badgeText(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  return count > 99 ? '99+' : String(Math.floor(count));
}

export type MenuItemKey = 'account' | 'tasks' | 'templates' | 'notifications' | 'settings';

export interface MenuItem {
  readonly key: MenuItemKey;
  readonly label: string;
  /** Unread count text (Notifications only), or null. */
  readonly badge: string | null;
  readonly route:
    | { readonly name: 'Account'; readonly params?: RootStackParamList['Account'] }
    | { readonly name: 'Templates' }
    | { readonly name: 'Tasks' }
    | { readonly name: 'Notifications' };
}

/**
 * The side-menu items, in prototype order: Account · Tasks · Templates · Notifications ·
 * Settings. M-A12: Tasks (W1-D.1, badge = what needs the user); Templates also for a
 * Personal account without the capability, which shows the plans prompt there (W1-F).
 */
export function menuItems(input: {
  readonly context: SenderContext | null | undefined;
  readonly unread: number;
  readonly needs?: number;
}): MenuItem[] {
  const items: MenuItem[] = [
    { key: 'account', label: 'Account', badge: null, route: { name: 'Account' } },
    { key: 'tasks', label: 'Tasks', badge: badgeText(input.needs ?? 0), route: { name: 'Tasks' } },
  ];
  if (templatesAvailable(input.context ?? null) || input.context?.tenant?.kind === 'PERSONAL')
    items.push({
      key: 'templates',
      label: 'Templates',
      badge: null,
      route: { name: 'Templates' },
    });
  items.push(
    {
      key: 'notifications',
      label: 'Notifications',
      badge: badgeText(input.unread),
      route: { name: 'Notifications' },
    },
    {
      key: 'settings',
      label: 'Settings',
      badge: null,
      route: { name: 'Account', params: { section: 'settings' } },
    },
  );
  return items;
}

/** Shown when the server says the session cannot send and gives no limit details. */
export const SEND_UNAVAILABLE_REASON = 'Your account can’t send envelopes right now.';

export interface PlusAction {
  readonly intent: SendFlowIntent;
  readonly label: string;
  readonly disabled: boolean;
  /** Why it is disabled, from the server's answers (C-3/C-4 limit copy when it applies). */
  readonly reason: string | null;
}

/**
 * The + button's actions. Request signatures depends on the server's `can_send`; while it
 * is false the action is disabled with the allowance limit copy when a limit explains it.
 * Sign a document is never disabled by the allowance (M-A12 D-1).
 * "Sign a document" is omitted entirely unless the self-signing backend ships.
 */
export function plusActions(input: {
  readonly canSend: boolean;
  readonly allowance: AllowanceModel | null;
  readonly selfSign: boolean;
}): PlusAction[] {
  const banner = limitBanner(input.allowance);
  const reason = input.canSend ? null : (banner?.body ?? SEND_UNAVAILABLE_REASON);
  const out: PlusAction[] = [
    { intent: 'request', label: 'Request signatures', disabled: !input.canSend, reason },
  ];
  // M-A12 D-1: signing is always free. A self-signed document never uses the send
  // allowance, so a used-up allowance never disables "Sign a document"; any other reason
  // the server gives for no sending still does.
  const selfBlocked = !input.canSend && banner === null;
  if (input.selfSign)
    out.push({
      intent: 'self',
      label: 'Sign a document',
      disabled: selfBlocked,
      reason: selfBlocked ? reason : null,
    });
  return out;
}

/** Up to two initials for an avatar ("·" when nothing is known). */
export function initialsFor(name: string | null | undefined): string {
  const parts = (name ?? '').split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '·';
}

/** The profile card lines: display name (or email), email, organization. */
export function profileLines(context: SenderContext | null | undefined): {
  name: string;
  email: string | null;
  organization: string | null;
} {
  const u = context?.user;
  const email = u?.email ?? null;
  return {
    name: u?.display_name?.trim() || email || '',
    email: u?.display_name?.trim() ? email : null,
    organization: context?.tenant?.name?.trim() || null,
  };
}
