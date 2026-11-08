import { describe, expect, it, vi } from 'vitest';
import type { MailerPort } from '@aramo/mailer';

import type { IdentityAuditService } from '../lib/audit/identity-audit.service.js';
import type { MembershipDto } from '../lib/dto/membership.dto.js';
import type { IdentityRepository } from '../lib/identity.repository.js';
import { IdentityService } from '../lib/identity.service.js';
import type { TenantEntitlementReader } from '../lib/tenant-entitlement-reader.service.js';
import type { AuditFinancialsGate } from '../lib/tenant-user/audit-financials-gate.port.js';
import type { RoleBundleValidator } from '../lib/tenant-user/role-bundle-validator.js';
import {
  type SeatGuard,
  type SeatLimitPort,
  type SeatLimitTx,
  SeatLimitReachedError,
  assertSeatAvailableTx,
  countSignSeatsTx,
  holdsSignSendAccess,
} from '../lib/tenant-user/seat-limit.port.js';
import type { TenantCognitoPort } from '../lib/tenant-user/tenant-cognito.port.js';
import { TenantUserLifecycleService } from '../lib/tenant-user/tenant-user-lifecycle.service.js';

// Aramo Sign Business Per-Seat Pricing, Implementation Directive v1.0 (LOCKED) §3.2 — the seat count (S-4),
// and the 409 seat_limit_reached at every tenant-user enforcement point (invite, role grant, re-enable)
// under the tenant-row FOR UPDATE lock: limited / unlimited (no port, or the port says not limited) /
// at the limit. The REAL IdentityService and TenantUserLifecycleService run over a mocked repository
// whose transactions run the guard they are handed, as the real repository does.

const TENANT = '01900000-0000-7000-8000-0000000000a1';
const ACTOR = '01900000-0000-7000-8000-0000000000aa';
const TARGET = '01900000-0000-7000-8000-0000000000bb';
const REQ = 'rq-seats';

function membership(id: string, user_id: string, over: Partial<MembershipDto> = {}): MembershipDto {
  return { id, user_id, tenant_id: TENANT, site_id: null, is_active: true, invite_status: 'ACTIVE', joined_at: 'x', deactivated_at: null, created_at: 'x', updated_at: 'x', ...over };
}

/** A fake identity transaction: records each statement; the count query answers `used`. */
function fakeTx(used: number) {
  const sql: string[] = [];
  const tx: SeatLimitTx = {
    $queryRaw: (async (q: TemplateStringsArray) => {
      const text = q.join('?');
      sql.push(text);
      return text.includes('count(DISTINCT') ? [{ n: used }] : [];
    }) as never,
  };
  return { tx, sql };
}

function fixture(opts: { purchased: number | null; used: number; targetKeys?: string[]; targetActive?: boolean; port?: boolean }) {
  const { tx, sql } = fakeTx(opts.used);
  const port: SeatLimitPort = {
    check: vi.fn(async (_tenant: string, t: SeatLimitTx) =>
      opts.purchased === null ? { limited: false as const } : { limited: true as const, used: await countSignSeatsTx(t, TENANT), purchased: opts.purchased },
    ),
  };
  const runGuard = async (a: { seat_guard?: SeatGuard }) => {
    if (a.seat_guard !== undefined) await a.seat_guard(tx);
  };
  const memberships: Record<string, MembershipDto> = {
    [ACTOR]: membership('m-actor', ACTOR),
    [TARGET]: membership('m-target', TARGET, { is_active: opts.targetActive ?? true }),
  };
  const keys: Record<string, string[]> = { 'm-actor': ['tenant_owner'], 'm-target': opts.targetKeys ?? ['sign_viewer'] };
  const repo = {
    findMembership: vi.fn(async (a: { user_id: string }) => memberships[a.user_id] ?? null),
    findRoleKeysForMembership: vi.fn(async (id: string) => keys[id] ?? []),
    replaceMembershipRoles: vi.fn(async (a: { seat_guard?: SeatGuard }) => {
      await runGuard(a);
      return { added_role_ids: [], removed_role_ids: [] };
    }),
    findUserById: vi.fn().mockResolvedValue({ id: TARGET, email: 't@acme.test', display_name: null, is_active: true, deactivated_at: null, created_at: 'x', updated_at: 'x' }),
    findUserByEmail: vi.fn().mockResolvedValue(null),
    findRoleIdsByKeys: vi.fn(async (k: readonly string[]) => new Map(k.map((x) => [x, `rid-${x}`]))),
    findMembershipTenantIdsForUser: vi.fn().mockResolvedValue([]),
    createUserWithMembership: vi.fn(async (a: { seat_guard?: SeatGuard }) => {
      await runGuard(a);
      return { user: { id: 'u-new', email: 'n@acme.test' }, membership_id: 'm-new', membership_role_ids: [] };
    }),
    personalTenantSeatTaken: vi.fn().mockResolvedValue(false),
    createInvitation: vi.fn().mockResolvedValue({ id: 'inv-1' }),
    findTenantAllowedDomainById: vi.fn().mockResolvedValue(null),
    findTenantLabelById: vi.fn().mockResolvedValue('Acme'),
    findTenantAccessStateById: vi.fn().mockResolvedValue({ status: 'ACTIVE', is_active: true }),
    reEnableMembership: vi.fn(async (a: { seat_guard?: SeatGuard }) => {
      await runGuard(a);
      return { membership_id: 'm-target' };
    }),
  };
  const audit = { writeGlobalEvent: vi.fn(), writeEvent: vi.fn() } as unknown as IdentityAuditService;
  const roleBundle = { assertUnionNonInvertible: vi.fn().mockResolvedValue(undefined) } as unknown as RoleBundleValidator;
  const entitlements = { getCapabilities: vi.fn(async () => new Set(['core', 'ats', 'sign'])) } as unknown as TenantEntitlementReader;
  const identity = new IdentityService(repo as unknown as IdentityRepository, audit, roleBundle, entitlements);
  const cognito = { adminDisableUser: vi.fn(), adminEnableUser: vi.fn().mockResolvedValue(undefined) };
  const lifecycle = new TenantUserLifecycleService(
    identity,
    cognito as unknown as TenantCognitoPort,
    { isFinancialsAuditEnabled: vi.fn().mockResolvedValue(true) } as unknown as AuditFinancialsGate,
    { send: vi.fn() } as unknown as MailerPort,
    opts.port === false ? undefined : port,
  );
  return { lifecycle, repo, port, sql };
}

const SEAT_LIMIT = (used: number, purchased: number) => ({
  code: 'ESIGN_BILLING_CONFLICT',
  statusCode: 409,
  context: { requestId: REQ, details: { reason: 'seat_limit_reached', used, purchased } },
});

const invite = (f: ReturnType<typeof fixture>, role_keys: string[]) =>
  f.lifecycle.inviteTenantUser({ tenant_id: TENANT, email: 'n@acme.test', display_name: null, role_keys, actor_user_id: ACTOR, request_id: REQ });
const assign = (f: ReturnType<typeof fixture>, role_keys: string[]) =>
  f.lifecycle.assignTenantUserRoles({ tenant_id: TENANT, user_id: TARGET, role_keys, actor_user_id: ACTOR, request_id: REQ });
const enable = (f: ReturnType<typeof fixture>) => f.lifecycle.enableTenantUser({ tenant_id: TENANT, user_id: TARGET, actor_user_id: ACTOR, request_id: REQ });

describe('seat count and guard (§3.2.1, S-4, O-7)', () => {
  it('Sign send access = sign_admin, sign_sender, tenant_owner, tenant_admin (a viewer is not a seat)', () => {
    expect(holdsSignSendAccess(['sign_sender'])).toBe(true);
    expect(holdsSignSendAccess(['sign_admin'])).toBe(true);
    expect(holdsSignSendAccess(['tenant_owner'])).toBe(true);
    expect(holdsSignSendAccess(['tenant_admin'])).toBe(true);
    expect(holdsSignSendAccess(['sign_viewer', 'recruiter'])).toBe(false);
  });

  it('the count is active, accepted members holding a sending role (pending invites never count)', async () => {
    const { tx, sql } = fakeTx(4);
    expect(await countSignSeatsTx(tx, TENANT)).toBe(4);
    const q = sql[0] as string;
    expect(q).toContain(`m."is_active" = true`);
    expect(q).toContain(`m."deactivated_at" IS NULL`);
    expect(q).toContain(`m."invite_status" IN ('ACCEPTED', 'ACTIVE')`);
    expect(q).toContain(`r."key" IN ('sign_admin', 'sign_sender', 'tenant_owner', 'tenant_admin')`);
  });

  it('the guard locks the tenant row FOR UPDATE before it counts, and refuses at the limit only', async () => {
    const { tx, sql } = fakeTx(3);
    const port = (purchased: number): SeatLimitPort => ({ check: async (_t, t) => ({ limited: true, used: await countSignSeatsTx(t, TENANT), purchased }) });
    await expect(assertSeatAvailableTx(tx, TENANT, port(3))).rejects.toBeInstanceOf(SeatLimitReachedError);
    expect(sql[0]).toMatch(/FOR UPDATE/);
    expect(sql[1]).toMatch(/count\(DISTINCT/);
    await expect(assertSeatAvailableTx(tx, TENANT, port(4))).resolves.toBeUndefined();
    await expect(assertSeatAvailableTx(tx, TENANT, { check: async () => ({ limited: false }) })).resolves.toBeUndefined();
  });
});

describe('invite (§3.2.4)', () => {
  it('at the limit: 409 seat_limit_reached { used, purchased }, nothing persisted after the guard', async () => {
    const f = fixture({ purchased: 2, used: 2 });
    await expect(invite(f, ['sign_sender'])).rejects.toMatchObject(SEAT_LIMIT(2, 2));
    expect(f.repo.createInvitation).not.toHaveBeenCalled();
  });
  it('a free seat: invited, and the guard ran under the lock', async () => {
    const f = fixture({ purchased: 3, used: 2 });
    await expect(invite(f, ['sign_sender'])).resolves.toMatchObject({ invite_status: 'INVITED' });
    expect(f.port.check).toHaveBeenCalledTimes(1);
    expect(f.sql[0]).toMatch(/FOR UPDATE/);
  });
  it('a role without Sign send access takes no seat (no guard)', async () => {
    const f = fixture({ purchased: 1, used: 1 });
    await expect(invite(f, ['sign_viewer'])).resolves.toMatchObject({ invite_status: 'INVITED' });
    expect(f.port.check).not.toHaveBeenCalled();
  });
  it('unlimited: a per-account tenant (port not limited) and an unbound port both invite', async () => {
    await expect(invite(fixture({ purchased: null, used: 50 }), ['sign_sender'])).resolves.toMatchObject({ invite_status: 'INVITED' });
    await expect(invite(fixture({ purchased: 1, used: 5, port: false }), ['sign_sender'])).resolves.toMatchObject({ invite_status: 'INVITED' });
  });
});

describe('role grant (§3.2.4)', () => {
  it('granting Sign send access at the limit: 409', async () => {
    const f = fixture({ purchased: 2, used: 2, targetKeys: ['sign_viewer'] });
    await expect(assign(f, ['sign_sender'])).rejects.toMatchObject(SEAT_LIMIT(2, 2));
  });
  it('granting with a free seat succeeds; keeping or removing access never consults the limit (O-6)', async () => {
    await expect(assign(fixture({ purchased: 3, used: 2, targetKeys: ['sign_viewer'] }), ['sign_admin'])).resolves.toMatchObject({ added_role_keys: ['sign_admin'] });
    const keep = fixture({ purchased: 2, used: 2, targetKeys: ['sign_sender'] });
    await expect(assign(keep, ['sign_admin'])).resolves.toMatchObject({ added_role_keys: ['sign_admin'] });
    expect(keep.port.check).not.toHaveBeenCalled();
    const remove = fixture({ purchased: 2, used: 2, targetKeys: ['sign_sender'] });
    await expect(assign(remove, ['sign_viewer'])).resolves.toMatchObject({ removed_role_keys: ['sign_sender'] });
    expect(remove.port.check).not.toHaveBeenCalled();
  });
});

describe('re-enable (§3.2.4)', () => {
  it('re-enabling a disabled Sign sender at the limit: 409', async () => {
    const f = fixture({ purchased: 1, used: 1, targetKeys: ['sign_sender'], targetActive: false });
    await expect(enable(f)).rejects.toMatchObject(SEAT_LIMIT(1, 1));
  });
  it('a free seat re-enables; a disabled viewer and an already-active sender take no seat', async () => {
    await expect(enable(fixture({ purchased: 2, used: 1, targetKeys: ['sign_sender'], targetActive: false }))).resolves.toMatchObject({ changed: true });
    const viewer = fixture({ purchased: 1, used: 1, targetKeys: ['sign_viewer'], targetActive: false });
    await expect(enable(viewer)).resolves.toMatchObject({ changed: true });
    expect(viewer.port.check).not.toHaveBeenCalled();
    const active = fixture({ purchased: 1, used: 1, targetKeys: ['sign_sender'], targetActive: true });
    await expect(enable(active)).resolves.toMatchObject({ changed: false });
    expect(active.port.check).not.toHaveBeenCalled();
  });
});
