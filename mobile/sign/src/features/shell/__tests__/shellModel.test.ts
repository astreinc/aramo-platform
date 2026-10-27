// Shell derivations (M-A4 §1): needs-signature badge, side-menu items, + actions.
import { allowanceModel } from '../../inbox/allowance';
import { CTX_OWNER, received } from '../../inbox/__tests__/fixtures';
import type { BillingAccount, InboxList, SenderContext } from '../../inbox/types';
import { consumeSearchFocus, requestSearchFocus } from '../searchFocus';
import {
  badgeText,
  initialsFor,
  menuItems,
  needsSignatureCount,
  plusActions,
  profileLines,
  SEND_UNAVAILABLE_REASON,
} from '../shellModel';

const ctx = (over: Partial<SenderContext> = {}): SenderContext =>
  ({ ...CTX_OWNER, ...over }) as SenderContext;

describe('needsSignatureCount', () => {
  it('counts only inbox items the server marks can_sign, once each', () => {
    const a = received({ can_sign: true });
    const b = received({ can_sign: true });
    const signedAlready = received({ can_sign: false, my_status: 'SIGNED' });
    const inbox: InboxList = { waiting: [a, b, signedAlready], completed: [], other: [a] };
    expect(needsSignatureCount(inbox)).toBe(2);
  });

  it('is 0 with no inbox (never derived from email)', () => {
    expect(needsSignatureCount(null)).toBe(0);
    expect(needsSignatureCount(undefined)).toBe(0);
  });
});

describe('badgeText', () => {
  it('hides at 0, caps at 99+', () => {
    expect(badgeText(0)).toBeNull();
    expect(badgeText(-1)).toBeNull();
    expect(badgeText(Number.NaN)).toBeNull();
    expect(badgeText(1)).toBe('1');
    expect(badgeText(99)).toBe('99');
    expect(badgeText(100)).toBe('99+');
  });
});

describe('menuItems', () => {
  it('Account · Notifications · Settings without the templates capability', () => {
    const items = menuItems({ context: ctx(), unread: 0 });
    expect(items.map((i) => i.label)).toEqual(['Account', 'Notifications', 'Settings']);
    expect(items.find((i) => i.key === 'settings')?.route).toEqual({
      name: 'Account',
      params: { section: 'settings' },
    });
  });

  it('shows Templates only when the plan feature AND the permission are both true', () => {
    const on = ctx({
      features: { templates: true },
      permissions: { ...CTX_OWNER.permissions, templates: true },
    });
    expect(menuItems({ context: on, unread: 0 }).map((i) => i.label)).toEqual([
      'Account',
      'Templates',
      'Notifications',
      'Settings',
    ]);
    const featureOnly = ctx({ features: { templates: true } });
    expect(menuItems({ context: featureOnly, unread: 0 }).some((i) => i.key === 'templates')).toBe(
      false,
    );
    expect(menuItems({ context: null, unread: 0 }).some((i) => i.key === 'templates')).toBe(false);
  });

  it('puts the server unread count on Notifications only', () => {
    const items = menuItems({ context: ctx(), unread: 120 });
    expect(items.find((i) => i.key === 'notifications')?.badge).toBe('99+');
    expect(items.filter((i) => i.badge !== null)).toHaveLength(1);
    expect(
      menuItems({ context: ctx(), unread: 0 }).find((i) => i.key === 'notifications')?.badge,
    ).toBeNull();
  });
});

describe('plusActions', () => {
  it('offers only Request signatures while self-signing is not shipped', () => {
    const a = plusActions({ canSend: true, allowance: null, selfSign: false });
    expect(a).toEqual([
      { intent: 'request', label: 'Request signatures', disabled: false, reason: null },
    ]);
  });

  it('adds Sign a document when FEATURES.selfSign is on', () => {
    const a = plusActions({ canSend: true, allowance: null, selfSign: true });
    expect(a.map((x) => [x.intent, x.label])).toEqual([
      ['request', 'Request signatures'],
      ['self', 'Sign a document'],
    ]);
  });

  it('disables with the allowance limit copy when the server says no sending', () => {
    const billing = {
      tenant_kind: 'PERSONAL',
      allowance: { limit: 5, used: 5, remaining: 0, period_end: '2026-11-01T00:00:00.000Z' },
    } as unknown as BillingAccount;
    const a = plusActions({ canSend: false, allowance: allowanceModel(billing), selfSign: false });
    expect(a[0]?.disabled).toBe(true);
    expect(a[0]?.reason).toMatch(/^You’ve used all 5 documents this month\./);
    expect(a[0]?.reason).not.toMatch(/tomorrow/i);
  });

  it('falls back to a generic reason when no limit explains it', () => {
    const a = plusActions({ canSend: false, allowance: null, selfSign: false });
    expect(a[0]).toMatchObject({ disabled: true, reason: SEND_UNAVAILABLE_REASON });
  });
});

describe('profile', () => {
  it('name, email and organization from the sender context', () => {
    expect(profileLines(ctx())).toEqual({
      name: 'Pat Sender',
      email: 'pat@example.com',
      organization: 'Northwind',
    });
  });

  it('falls back to the email as the name, without repeating it', () => {
    const c = ctx({
      user: { ...CTX_OWNER.user, display_name: null, identity_provider: null },
      tenant: {},
    });
    expect(profileLines(c)).toEqual({ name: 'pat@example.com', email: null, organization: null });
  });

  it('initials', () => {
    expect(initialsFor('Pat Sender')).toBe('PS');
    expect(initialsFor('')).toBe('·');
    expect(initialsFor(null)).toBe('·');
  });
});

describe('searchFocus', () => {
  it('a request is consumed exactly once', () => {
    expect(consumeSearchFocus()).toBe(false);
    requestSearchFocus();
    expect(consumeSearchFocus()).toBe(true);
    expect(consumeSearchFocus()).toBe(false);
  });
});
