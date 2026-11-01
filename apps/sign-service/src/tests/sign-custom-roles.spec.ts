import 'reflect-metadata';
import { AramoError } from '@aramo/common';
import { REQUIRED_SCOPES_KEY } from '@aramo/authorization';
import { ESIGN_ROLE_PERMISSIONS, ESIGN_SCOPE, SIGN_CUSTOM_ROLE_COMPOSABLE_SCOPES } from '@aramo/identity';
import { FEATURE_AVAILABILITY } from '@aramo/subscription';
import { describe, expect, it, vi } from 'vitest';

import { SignCustomRolesController } from '../app/custom-roles/sign-custom-roles.controller.js';
import { SignCustomRolesGate, SubscriptionPlanFeatureReader } from '../app/custom-roles/sign-custom-roles.gate.js';
import { SIGN_CUSTOM_ROLES_FEATURE, SignFeatureGate } from '../app/sign-feature.gate.js';
import { SenderContextService } from '../app/sender/sender-context.service.js';

// Aramo Sign Feature-Parity §1.21 — the custom-roles routes: shipped DARK, gated server-side
// (launch availability, BUSINESS tenant, plan entitlement), every route behind
// sign:member:manage, and the actor taken only from the verified auth context.

const T = '019000a0-0000-7000-8000-000000000001';
const RID = 'req-1';
const ROLE = '019000a0-0000-7000-8000-0000000000aa';
const USER = '019000a0-0000-7000-8000-0000000000bb';
const ADMIN = { tenant_id: T, sub: 'u-admin', scopes: [...ESIGN_ROLE_PERMISSIONS.sign_admin] };

const VIEW = { id: ROLE, name: 'Desk', description: null, scope_keys: ['sign:envelope:read'], member_count: 0, created_at: new Date('2026-11-01T00:00:00Z'), updated_at: new Date('2026-11-01T00:00:00Z') };

function make(opts: { available?: boolean; kind?: string; inPlan?: boolean | 'throws'; noPlanReader?: boolean } = {}) {
  const features = new SignFeatureGate({ ...FEATURE_AVAILABILITY, [SIGN_CUSTOM_ROLES_FEATURE]: opts.available === false ? 'NOT_AVAILABLE' : 'AVAILABLE' });
  const senders = { tenantOf: vi.fn(async () => ({ id: T, kind: opts.kind ?? 'BUSINESS', status: 'ACTIVE' })) };
  const plans = {
    planFeatureEnabled: vi.fn(async () => {
      if (opts.inPlan === 'throws') throw new Error('db down');
      return opts.inPlan ?? true;
    }),
  };
  const gate = new SignCustomRolesGate(features, senders as unknown as SenderContextService, opts.noPlanReader === true ? undefined : plans);
  const roles = {
    list: vi.fn(async () => [VIEW]),
    listMembers: vi.fn(async () => [{ user_id: USER, email: 'm@org.test', display_name: null, role_keys: ['sign_sender'], custom_role_ids: [] }]),
    create: vi.fn(async () => VIEW),
    update: vi.fn(async () => VIEW),
    remove: vi.fn(async () => undefined),
    assign: vi.fn(async () => ({ assigned: true })),
    unassign: vi.fn(async () => ({ unassigned: true })),
  };
  const c = new SignCustomRolesController(roles as never, gate);
  return { c, roles, plans, senders };
}

async function refusal(p: Promise<unknown>): Promise<AramoError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AramoError);
    return e as AramoError;
  }
  throw new Error('expected a refusal');
}

function everyRoute(c: SignCustomRolesController, auth = ADMIN): Array<() => Promise<unknown>> {
  return [
    () => c.list(auth as never, RID),
    () => c.members(auth as never, RID),
    () => c.create(auth as never, RID, { name: 'X', scope_keys: ['sign:envelope:read'] }),
    () => c.update(auth as never, RID, ROLE, { name: 'Y' }),
    () => c.remove(auth as never, RID, ROLE),
    () => c.assign(auth as never, RID, ROLE, USER),
    () => c.unassign(auth as never, RID, ROLE, USER),
  ];
}

describe('Sign custom roles — shipped dark', () => {
  it('sign.custom_roles is NOT_AVAILABLE in the production registry', () => {
    expect(FEATURE_AVAILABILITY[SIGN_CUSTOM_ROLES_FEATURE]).toBe('NOT_AVAILABLE');
    expect(new SignFeatureGate().isAvailable(SIGN_CUSTOM_ROLES_FEATURE)).toBe(false);
  });

  it('with the production registry every route answers 403 ESIGN_FEATURE_NOT_AVAILABLE and touches nothing', async () => {
    const senders = { tenantOf: vi.fn() };
    const plans = { planFeatureEnabled: vi.fn(async () => true) };
    const roles = { list: vi.fn(), listMembers: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), assign: vi.fn(), unassign: vi.fn() };
    const c = new SignCustomRolesController(roles as never, new SignCustomRolesGate(new SignFeatureGate(), senders as never, plans));
    for (const r of everyRoute(c)) {
      const e = await refusal(r());
      expect(e.code).toBe('ESIGN_FEATURE_NOT_AVAILABLE');
      expect(e.statusCode).toBe(403);
      expect(e.context.details).toEqual({ feature_key: 'sign.custom_roles' });
    }
    for (const fn of [...Object.values(roles), senders.tenantOf, plans.planFeatureEnabled]) expect(fn).not.toHaveBeenCalled();
  });
});

describe('Sign custom roles — gate (availability on)', () => {
  it('a PERSONAL tenant is refused (organizations only)', async () => {
    const { c, roles } = make({ kind: 'PERSONAL' });
    for (const r of everyRoute(c)) {
      const e = await refusal(r());
      expect([e.code, e.statusCode, e.context.details]).toEqual(['INSUFFICIENT_PERMISSIONS', 403, { reason: 'custom_roles_business_only' }]);
    }
    for (const fn of Object.values(roles)) expect(fn).not.toHaveBeenCalled();
  });

  it('a plan without sign.custom_roles is refused; an unreadable subscription or no reader fails closed', async () => {
    for (const opts of [{ inPlan: false }, { inPlan: 'throws' as const }, { noPlanReader: true }]) {
      const { c, roles } = make(opts);
      for (const r of everyRoute(c)) {
        const e = await refusal(r());
        expect([e.code, e.statusCode, e.context.details], JSON.stringify(opts)).toEqual(['ESIGN_FEATURE_NOT_AVAILABLE', 403, { feature_key: 'sign.custom_roles', reason: 'not_in_plan' }]);
      }
      for (const fn of Object.values(roles)) expect(fn).not.toHaveBeenCalled();
    }
  });

  it('entitled: the actor is the verified auth context (tenant, user, scopes) — never the body', async () => {
    const { c, roles, plans } = make();
    await c.create(ADMIN as never, RID, { name: 'Desk', description: 'd', scope_keys: ['sign:envelope:read'], tenant_id: 'other' } as never);
    const actor = { tenant_id: T, user_id: 'u-admin', scopes: ADMIN.scopes, request_id: RID };
    expect(roles.create).toHaveBeenCalledWith(actor, { name: 'Desk', description: 'd', scope_keys: ['sign:envelope:read'] });
    expect(plans.planFeatureEnabled).toHaveBeenCalledWith(T, 'sign.custom_roles');
    await c.update(ADMIN as never, RID, ROLE, { scope_keys: ['sign:envelope:read'] });
    expect(roles.update).toHaveBeenCalledWith(actor, ROLE, { name: undefined, description: undefined, scope_keys: ['sign:envelope:read'] });
    await expect(c.remove(ADMIN as never, RID, ROLE)).resolves.toEqual({ deleted: true });
    expect(roles.remove).toHaveBeenCalledWith(actor, ROLE);
    await expect(c.assign(ADMIN as never, RID, ROLE, USER)).resolves.toEqual({ assigned: true });
    expect(roles.assign).toHaveBeenCalledWith(actor, ROLE, USER);
    await expect(c.unassign(ADMIN as never, RID, ROLE, USER)).resolves.toEqual({ unassigned: true });
    expect(roles.unassign).toHaveBeenCalledWith(actor, ROLE, USER);
    expect(roles.list).not.toHaveBeenCalledWith('other');
  });

  it('GET lists roles (wire dates) and every composable permission with grantable = held by the caller', async () => {
    const { c, roles } = make();
    const sender = { tenant_id: T, sub: 'u-s', scopes: [...ESIGN_ROLE_PERMISSIONS.sign_sender, ESIGN_SCOPE.MEMBER_MANAGE] };
    const out = await c.list(sender as never, RID);
    expect(roles.list).toHaveBeenCalledWith(T);
    expect(out.roles).toEqual([{ ...VIEW, created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z' }]);
    expect(out.permissions.map((p) => p.key)).toEqual([...SIGN_CUSTOM_ROLE_COMPOSABLE_SCOPES]);
    expect(out.permissions.filter((p) => p.grantable).map((p) => p.key).sort()).toEqual([...sender.scopes].sort());
    expect(out.permissions.some((p) => p.key === ESIGN_SCOPE.BILLING_MANAGE)).toBe(false);
    await expect(c.members(ADMIN as never, RID)).resolves.toEqual({ members: [expect.objectContaining({ user_id: USER })] });
  });

  it('every route requires sign:member:manage (EsignSenderBoundary)', () => {
    const proto = SignCustomRolesController.prototype as unknown as Record<string, object>;
    for (const m of ['list', 'members', 'create', 'update', 'remove', 'assign', 'unassign']) {
      expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, proto[m]!), m).toEqual([ESIGN_SCOPE.MEMBER_MANAGE]);
    }
  });
});

describe('SubscriptionPlanFeatureReader', () => {
  const account = (subscription: unknown) => ({ account: vi.fn(async () => ({ subscription })) });
  it('true only for a live subscription whose plan lists the feature enabled', async () => {
    const f = (enabled: boolean) => [{ feature_key: 'sign.custom_roles', enabled, available: false }];
    expect(await new SubscriptionPlanFeatureReader(account({ ended_at: null, features: f(true) }) as never).planFeatureEnabled(T, 'sign.custom_roles')).toBe(true);
    expect(await new SubscriptionPlanFeatureReader(account({ ended_at: null, features: f(false) }) as never).planFeatureEnabled(T, 'sign.custom_roles')).toBe(false);
    expect(await new SubscriptionPlanFeatureReader(account({ ended_at: new Date(), features: f(true) }) as never).planFeatureEnabled(T, 'sign.custom_roles')).toBe(false);
    expect(await new SubscriptionPlanFeatureReader(account(null) as never).planFeatureEnabled(T, 'sign.custom_roles')).toBe(false);
    expect(await new SubscriptionPlanFeatureReader(account({ ended_at: null, features: [] }) as never).planFeatureEnabled(T, 'sign.custom_roles')).toBe(false);
  });
});
