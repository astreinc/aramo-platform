import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { IdentityModule } from '../lib/identity.module.js';
import { IdentityService } from '../lib/identity.service.js';
import { TenantUserLifecycleService } from '../lib/tenant-user/tenant-user-lifecycle.service.js';
import {
  TENANT_COGNITO_PORT,
  StubTenantCognitoAdapter,
  type TenantCognitoPort,
} from '../lib/tenant-user/tenant-cognito.port.js';
import { StubAuditFinancialsGateAdapter } from '../lib/tenant-user/audit-financials-gate.port.js';

// Auth-Cognito-Spec-Backfill v1.0 — the committed DI resolution proof for
// TENANT_COGNITO_PORT, mirroring the two siblings in this directory
// (financials-gate-binding.di.spec.ts, task-assignee-binding.di.spec.ts).
//
// Cognito is the port that started the whole binding-fix thread; this spec is
// the committed DI proof for its binding, gating every CI cycle.
//
// THE DEAD-WIRE, CLOSED. TENANT_COGNITO_PORT is bound to the throw-on-call
// StubTenantCognitoAdapter as a default INSIDE IdentityModule, and the live
// consumer — TenantUserLifecycleService — resolves it in IdentityModule's OWN
// scope. The original defect: apps/api overrode the binding at AppModule scope,
// which never propagated to IdentityModule's scope (NestJS DI is per-module
// hierarchical, not global last-wins; IdentityModule is not @Global). The fix:
// IdentityModule.forRoot({ cognitoAdapter }) appends a same-token provider to
// IdentityModule's own scope (last-wins), binding the real adapter IN-scope
// where the lifecycle service resolves it.
//
// Invite-S2 (Pattern-2) NOTE: the INVITE saga no longer calls Cognito — the
// no-sub flow mints no Cognito user at invite time (the sub links at first
// federated login via the reconcile spine). So the live TENANT_COGNITO_PORT
// consumer exercised by the routing proof below is the DISABLE saga
// (adminDisableUser). The binding property under test is identical; only the
// consuming verb changed.
//
// This spec boots through the REAL DI graph and proves three things:
//   1. forRoot binds the passed adapter in IdentityModule scope — the resolved
//      TENANT_COGNITO_PORT instance is the passed adapter, NOT the stub.
//   2. A bare IdentityModule import resolves the in-scope StubTenantCognitoAdapter
//      default (the fail-loud posture for the four non-cognito importers —
//      auth-service, platform-admin, company, visibility — that import plainly).
//   3. The DISABLE path ROUTES TO THE BOUND ADAPTER, not the stub's throw —
//      with a real adapter bound via forRoot, disableTenantUser's
//      adminDisableUser leg lands on the bound adapter (the same binding-fix
//      property the COGNITO_PROVISION_FAILED bug exercised: the call reaches
//      the adapter instead of hitting the throw).
//
// No real AWS: the real TenantCognitoAdapter lives in apps/api (it imports
// @aws-sdk/*), so libs/identity binds a FAKE adapter via forRoot. The proof is
// pure DI graph-shape + call-routing; no live Cognito is touched. The mailer
// resolves to the StubMailerAdapter (MAILER_PROVIDER=stub in vitest.shared).
//
// DB-free: IdentityService is overridden with a fake (no Postgres), mirroring
// the financials sibling.

const TENANT = '01900000-0000-7000-8000-000000000001';
const ACTOR = '01900000-0000-7000-8000-0000000000b2';
const USER = '01900000-0000-7000-8000-0000000000a1';
const EMAIL = 'invitee@aramo.dev';

// Fake adapter passed via forRoot — records its calls so the routing proof can
// assert the disable leg landed HERE rather than on the throw-on-call stub. A
// no-arg constructor (matches the real TenantCognitoAdapter's shape) so no
// `imports` threading is needed for this port.
@Injectable()
class FakeTenantCognitoAdapter implements TenantCognitoPort {
  disableCalls: Array<{ email: string }> = [];

  async adminCreateUser(): Promise<{ cognito_sub: string }> {
    return { cognito_sub: 'unused-fake-sub' };
  }
  async adminDeleteUser(): Promise<void> {
    return;
  }
  async adminDisableUser(args: { email: string }): Promise<void> {
    this.disableCalls.push(args);
  }
  async adminEnableUser(): Promise<void> {
    return;
  }
}

function makeFakeIdentityService(): {
  fake: IdentityService;
  disableMembership: ReturnType<typeof vi.fn>;
} {
  const disableMembership = vi
    .fn()
    .mockResolvedValue({ changed: true, membership_id: 'membership-1' });
  const fake = {
    findUserById: vi.fn().mockResolvedValue({
      id: USER,
      email: EMAIL,
      display_name: 'Invitee Person',
      is_active: true,
      deactivated_at: null,
      created_at: '2026-06-05T00:00:00.000Z',
      updated_at: '2026-06-05T00:00:00.000Z',
    }),
    disableMembership,
    reEnableMembership: vi.fn(),
  } as unknown as IdentityService;
  return { fake, disableMembership };
}

describe('Cognito-Binding — TENANT_COGNITO_PORT through real DI (parity backfill)', () => {
  it('forRoot binds the passed adapter IN IdentityModule scope (NOT the stub default)', async () => {
    const { fake } = makeFakeIdentityService();
    const moduleRef = await Test.createTestingModule({
      imports: [
        IdentityModule.forRoot({
          cognitoAdapter: FakeTenantCognitoAdapter,
          auditFinancialsGate: StubAuditFinancialsGateAdapter,
        }),
      ],
    })
      .overrideProvider(IdentityService)
      .useValue(fake)
      .compile();

    const bound = moduleRef.get(TENANT_COGNITO_PORT);
    // The token resolves to the forRoot-passed adapter — NOT the throw-on-call
    // stub default. This is the dead-wire (the COGNITO_PROVISION_FAILED bug),
    // closed: the real adapter binds IN IdentityModule's scope, where the
    // lifecycle service resolves it.
    expect(bound).toBeInstanceOf(FakeTenantCognitoAdapter);
    expect(bound).not.toBeInstanceOf(StubTenantCognitoAdapter);
  });

  it('plain IdentityModule import resolves the StubTenantCognitoAdapter default (fail-loud for non-cognito importers)', async () => {
    const { fake } = makeFakeIdentityService();
    const moduleRef = await Test.createTestingModule({
      imports: [IdentityModule],
    })
      .overrideProvider(IdentityService)
      .useValue(fake)
      .compile();

    const bound = moduleRef.get(TENANT_COGNITO_PORT);
    // A bare import (the four non-cognito consumers — auth-service,
    // platform-admin, company, visibility) resolves the in-scope stub default.
    // They construct TenantUserLifecycleService but never reach the cognito
    // path; if any of them ever invoked the port it would fail LOUD.
    expect(bound).toBeInstanceOf(StubTenantCognitoAdapter);
  });

  it('disable path ROUTES to the bound adapter (adminDisableUser lands on the fake, not the stub throw)', async () => {
    const { fake, disableMembership } = makeFakeIdentityService();
    const moduleRef = await Test.createTestingModule({
      imports: [
        IdentityModule.forRoot({
          cognitoAdapter: FakeTenantCognitoAdapter,
          auditFinancialsGate: StubAuditFinancialsGateAdapter,
        }),
      ],
    })
      .overrideProvider(IdentityService)
      .useValue(fake)
      .compile();

    const svc = moduleRef.get(TenantUserLifecycleService);
    // The bound singleton the service holds is the SAME instance we resolve
    // here (per-module singleton scope) — so its recorded calls are the
    // service's calls.
    const adapter = moduleRef.get<FakeTenantCognitoAdapter>(TENANT_COGNITO_PORT);

    const result = await svc.disableTenantUser({
      tenant_id: TENANT,
      user_id: USER,
      actor_user_id: ACTOR,
      reason: null,
      request_id: 'req-cognito-bind',
    });

    // LOAD-BEARING: the disable's Cognito leg reached the BOUND adapter — the
    // call lands on the fake's adminDisableUser instead of hitting
    // StubTenantCognitoAdapter's throw (which the pre-fix dead-wire did).
    expect(adapter.disableCalls).toEqual([{ email: EMAIL }]);
    expect(result.changed).toBe(true);
    expect(disableMembership).toHaveBeenCalledWith({
      user_id: USER,
      tenant_id: TENANT,
    });
  });
});
