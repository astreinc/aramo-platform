import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { AramoError } from '@aramo/common';

import { IdentityModule } from '../lib/identity.module.js';
import { IdentityService } from '../lib/identity.service.js';
import { TenantUserLifecycleService } from '../lib/tenant-user/tenant-user-lifecycle.service.js';
import {
  AUDIT_FINANCIALS_GATE,
  type AuditFinancialsGate,
} from '../lib/tenant-user/audit-financials-gate.port.js';
import { StubTenantCognitoAdapter } from '../lib/tenant-user/tenant-cognito.port.js';

// Financials-Gate-Binding-Fix v1.0 — §3.3 COMPLIANCE GATE.
//
// THE pay-rate-visibility (D5) proof. AUDIT_FINANCIALS_GATE was bound to the
// throw-on-call StubAuditFinancialsGateAdapter as a default INSIDE
// IdentityModule, and the sole consumer — TenantUserLifecycleService — resolves
// it in IdentityModule's OWN scope. AppModule's override never propagated
// (per-module hierarchical DI), so assignTenantUserRoles ERRORED whenever it
// tried to grant 'auditor_with_financials' (broken-but-safe — fail CLOSED, the
// opposite of the task-assignee fail-OPEN hole, but still wrong).
//
// This spec boots TenantUserLifecycleService THROUGH THE REAL DI GRAPH
// (IdentityModule.forRoot) and proves behavior is IDENTICAL before/after the
// rebind — an identical-behavior gate, NOT a behavior-change gate:
//   1. forRoot binds the passed gate in IdentityModule's own scope (where the
//      service resolves AUDIT_FINANCIALS_GATE — adjacent to the cognito port).
//   2. financials disabled → 400 financials_audit_not_enabled AND the grant is
//      NEVER persisted (replaceMembershipRoles not called) — the LOAD-BEARING
//      negative: the pay-rate-visible auditor_with_financials bundle is never
//      conferred when financials audit is off.
//   3. financials enabled → grant proceeds to reconcile (replaceMembershipRoles
//      called).
//   4. non-financials role-sets → unaffected; gate not consulted, grant proceeds.
//
// DB-free: IdentityService is overridden with a fake (no Postgres), and the
// gate is a dependency-free controllable class injected via forRoot (the live
// TenantSettingService-backed adapter + its SettingsModule wiring is proven
// separately). The cognito port is the inert throw-on-call stub — the
// role-assign path never calls it.

const TENANT = '01900000-0000-7000-8000-000000000001';
const USER = '01900000-0000-7000-8000-0000000000a1';
const ACTOR = '01900000-0000-7000-8000-0000000000b2';
const AUDITOR_WITH_FINANCIALS = 'auditor_with_financials';

// Dependency-free controllable gates — model the live adapter's boolean
// contract deterministically so the DI proof needs no settings DB.
@Injectable()
class FinancialsDisabledGate implements AuditFinancialsGate {
  async isFinancialsAuditEnabled(): Promise<boolean> {
    return false;
  }
}

@Injectable()
class FinancialsEnabledGate implements AuditFinancialsGate {
  async isFinancialsAuditEnabled(): Promise<boolean> {
    return true;
  }
}

function makeFakeIdentityService(): {
  fake: IdentityService;
  replaceMembershipRoles: ReturnType<typeof vi.fn>;
} {
  const replaceMembershipRoles = vi.fn().mockResolvedValue(undefined);
  const fake = {
    resolveRoleIdsByKeys: vi
      .fn()
      .mockImplementation(async (keys: readonly string[]) =>
        keys.map((k) => `role-id-${k}`),
      ),
    findMembership: vi.fn().mockResolvedValue({ id: 'membership-1' }),
    findRoleKeysForMembership: vi.fn().mockResolvedValue([]),
    replaceMembershipRoles,
  } as unknown as IdentityService;
  return { fake, replaceMembershipRoles };
}

async function bootService(gate: typeof FinancialsDisabledGate): Promise<{
  svc: TenantUserLifecycleService;
  bound: unknown;
  replaceMembershipRoles: ReturnType<typeof vi.fn>;
}> {
  const { fake, replaceMembershipRoles } = makeFakeIdentityService();
  const moduleRef = await Test.createTestingModule({
    imports: [
      IdentityModule.forRoot({
        cognitoAdapter: StubTenantCognitoAdapter,
        auditFinancialsGate: gate,
      }),
    ],
  })
    .overrideProvider(IdentityService)
    .useValue(fake)
    .compile();

  return {
    svc: moduleRef.get(TenantUserLifecycleService),
    bound: moduleRef.get(AUDIT_FINANCIALS_GATE),
    replaceMembershipRoles,
  };
}

function assignArgs(role_keys: readonly string[]) {
  return {
    tenant_id: TENANT,
    user_id: USER,
    role_keys,
    actor_user_id: ACTOR,
    request_id: 'req-fin-gate',
  };
}

describe('Financials-Gate-Binding-Fix — AUDIT_FINANCIALS_GATE through real DI (§3.3)', () => {
  it('forRoot binds the passed gate IN IdentityModule scope (where the lifecycle service resolves it)', async () => {
    const { bound } = await bootService(FinancialsDisabledGate);
    // The token resolves to the forRoot-passed class — NOT the throw-on-call
    // stub default. This is the dead-wire, closed.
    expect(bound).toBeInstanceOf(FinancialsDisabledGate);
  });

  it('financials DISABLED → auditor_with_financials grant rejected 400, role NEVER persisted (the D5 negative)', async () => {
    const { svc, replaceMembershipRoles } = await bootService(FinancialsDisabledGate);
    let err: unknown;
    try {
      await svc.assignTenantUserRoles(assignArgs([AUDITOR_WITH_FINANCIALS]));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AramoError);
    expect((err as AramoError).statusCode).toBe(400);
    expect((err as AramoError).context.details).toMatchObject({
      reason: 'financials_audit_not_enabled',
      role_key: AUDITOR_WITH_FINANCIALS,
    });
    // LOAD-BEARING: the gate rejects BEFORE reconcile — the pay-rate-visible
    // bundle is never conferred. No membership-role write happened.
    expect(replaceMembershipRoles).not.toHaveBeenCalled();
  });

  it('financials ENABLED → auditor_with_financials grant proceeds to reconcile', async () => {
    const { svc, replaceMembershipRoles } = await bootService(FinancialsEnabledGate);
    const result = await svc.assignTenantUserRoles(assignArgs([AUDITOR_WITH_FINANCIALS]));
    expect(result.membership_id).toBe('membership-1');
    expect(replaceMembershipRoles).toHaveBeenCalledOnce();
    expect(replaceMembershipRoles).toHaveBeenCalledWith(
      expect.objectContaining({
        membership_id: 'membership-1',
        role_keys: [AUDITOR_WITH_FINANCIALS],
      }),
    );
  });

  it('non-financials role-set → unaffected; grant proceeds even with the gate disabled', async () => {
    // The gate is consulted ONLY when auditor_with_financials is requested.
    // A recruiter grant flows through untouched despite financials being off.
    const { svc, replaceMembershipRoles } = await bootService(FinancialsDisabledGate);
    const result = await svc.assignTenantUserRoles(assignArgs(['recruiter']));
    expect(result.membership_id).toBe('membership-1');
    expect(replaceMembershipRoles).toHaveBeenCalledOnce();
  });
});
