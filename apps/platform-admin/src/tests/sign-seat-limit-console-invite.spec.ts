import { describe, expect, it, vi } from 'vitest';
import type { SeatLimitPort, SeatLimitTx } from '@aramo/identity';

import type { CognitoAdminService } from '../app/platform/cognito/cognito-admin.service.js';
import { PlatformInvitationService } from '../app/platform/platform-invitation.service.js';
import { SignSeatLimitAdapter } from '../app/platform/sign-seat-limit.adapter.js';

// Aramo Sign Business Per-Seat Pricing, Implementation Directive v1.0 (LOCKED) §3.2.3-§3.2.4 — a
// platform-console invite into a tenant gives the identity write the seat guard when the invitee would hold
// Sign send access (tenant pool only); the same-tenant role replacement does when it GRANTS that access.
// The adapter composes the purchased seats (libs/subscription) with the in-transaction S-4 count.

const REQ = 'rq-console-seats';

function mocks() {
  return {
    cognito: { adminCreateUser: vi.fn().mockResolvedValue({ cognito_sub: 'sub-1' }), adminGetUser: vi.fn().mockResolvedValue(null), adminDeleteUser: vi.fn() },
    identitySvc: {
      assertPersonalSeatAvailable: vi.fn().mockResolvedValue(undefined),
      resolveRoleIdsByKeys: vi.fn(async (k: readonly string[]) => k.map((x) => `rid-${x}`)),
      classifyInviteEmailOwnership: vi.fn().mockResolvedValue({ kind: 'unregistered' }),
      createUserFromInvitation: vi.fn().mockResolvedValue({ user: { id: 'u-1' }, membership_id: 'm-1' }),
      findRoleIdsForMembership: vi.fn().mockResolvedValue(['rid-sign_viewer']),
      findRoleKeysForMembership: vi.fn().mockResolvedValue(['sign_viewer']),
      replaceMembershipRoles: vi.fn().mockResolvedValue({ added_role_ids: [], removed_role_ids: [] }),
    },
  };
}

const build = (m: ReturnType<typeof mocks>, port?: SeatLimitPort) =>
  new PlatformInvitationService(m.cognito as unknown as CognitoAdminService, {} as never, m.identitySvc as never, {} as never, {} as never, {} as never, undefined, port);

const invite = (svc: PlatformInvitationService, role_keys: string[], pool: 'tenant' | 'platform' = 'tenant') =>
  svc.inviteUserIntoTenant({ tenant_id: 't-1', email: 'n@acme.test', role_keys, display_name: null, actor_user_id: 'sa', pool, request_id: REQ });

const PORT: SeatLimitPort = { check: async () => ({ limited: true, used: 1, purchased: 1 }) };
const guardOf = (fn: ReturnType<typeof vi.fn>): unknown => (fn.mock.calls[0]?.[0] as { seat_guard?: unknown }).seat_guard;

describe('console invites (§3.2.4)', () => {
  it('a Sign sender invite into a tenant carries the seat guard; the guard refuses at the limit', async () => {
    const m = mocks();
    await invite(build(m, PORT), ['sign_sender']);
    const guard = guardOf(m.identitySvc.createUserFromInvitation) as (tx: SeatLimitTx) => Promise<void>;
    expect(typeof guard).toBe('function');
    const tx = { $queryRaw: vi.fn().mockResolvedValue([]) } as unknown as SeatLimitTx;
    await expect(guard(tx)).rejects.toMatchObject({ name: 'SeatLimitReachedError', used: 1, purchased: 1 });
  });

  it('no guard for a role without Sign send access, the platform pool, or an unbound port', async () => {
    for (const [role_keys, pool, port] of [
      [['sign_viewer'], 'tenant', PORT],
      [['sign_sender'], 'platform', PORT],
      [['sign_sender'], 'tenant', undefined],
    ] as const) {
      const m = mocks();
      await invite(build(m, port), [...role_keys], pool);
      expect(guardOf(m.identitySvc.createUserFromInvitation)).toBeUndefined();
    }
  });

  it('a same-tenant role replacement carries the guard only when it grants Sign send access', async () => {
    const m = mocks();
    m.identitySvc.classifyInviteEmailOwnership.mockResolvedValue({ kind: 'same_tenant', user: { id: 'u-1' }, membership: { id: 'm-1' } });
    await invite(build(m, PORT), ['sign_admin']);
    expect(typeof guardOf(m.identitySvc.replaceMembershipRoles)).toBe('function');
    const keep = mocks();
    keep.identitySvc.classifyInviteEmailOwnership.mockResolvedValue({ kind: 'same_tenant', user: { id: 'u-1' }, membership: { id: 'm-1' } });
    keep.identitySvc.findRoleKeysForMembership.mockResolvedValue(['sign_sender']);
    await invite(build(keep, PORT), ['sign_admin']);
    expect(guardOf(keep.identitySvc.replaceMembershipRoles)).toBeUndefined();
  });
});

describe('SignSeatLimitAdapter (§3.2.3)', () => {
  const tx = { $queryRaw: vi.fn().mockResolvedValue([{ n: 3 }]) } as unknown as SeatLimitTx;
  it('limited on a per-seat subscription: purchased from subscription, used from the identity transaction', async () => {
    const a = new SignSeatLimitAdapter({ seatLimit: vi.fn().mockResolvedValue(4) } as never);
    expect(await a.check('t-1', tx)).toEqual({ limited: true, used: 3, purchased: 4 });
  });
  it('not limited without a per-seat subscription', async () => {
    const a = new SignSeatLimitAdapter({ seatLimit: vi.fn().mockResolvedValue(null) } as never);
    expect(await a.check('t-1', tx)).toEqual({ limited: false });
  });
});
