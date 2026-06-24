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
// Cognito is the port that started the whole binding-fix thread, yet it shipped
// with its runtime proof guaranteed only by the forRoot compile-time required
// param plus a THROWAWAY spec that was deleted during implementation. The two
// siblings shipped committed DI specs; this backfills cognito's for parity, so
// all three binding bindings now gate every CI cycle.
//
// THE DEAD-WIRE, CLOSED. TENANT_COGNITO_PORT is bound to the throw-on-call
// StubTenantCognitoAdapter as a default INSIDE IdentityModule, and the sole
// consumer — TenantUserLifecycleService — resolves it in IdentityModule's OWN
// scope. The original defect: apps/api overrode the binding at AppModule scope,
// which never propagated to IdentityModule's scope (NestJS DI is per-module
// hierarchical, not global last-wins; IdentityModule is not @Global). So the
// invite saga's adminCreateUser hit the stub's throw → COGNITO_PROVISION_FAILED.
// The fix: IdentityModule.forRoot({ cognitoAdapter }) appends a same-token
// provider to IdentityModule's own scope (last-wins), binding the real adapter
// IN-scope where the lifecycle service resolves it.
//
// This spec boots through the REAL DI graph and proves three things:
//   1. forRoot binds the passed adapter in IdentityModule scope — the resolved
//      TENANT_COGNITO_PORT instance is the passed adapter, NOT the stub.
//   2. A bare IdentityModule import resolves the in-scope StubTenantCognitoAdapter
//      default (the fail-loud posture for the four non-cognito importers —
//      auth-service, platform-admin, company, visibility — that import plainly).
//   3. The invite path ROUTES TO THE BOUND ADAPTER, not the stub's throw — with
//      a real adapter bound via forRoot, inviteTenantUser's adminCreateUser leg
//      lands on the bound adapter (this is the COGNITO_PROVISION_FAILED bug,
//      closed: the call reaches the adapter instead of hitting the throw).
//
// No real AWS: the real TenantCognitoAdapter lives in apps/api (it imports
// @aws-sdk/*), so libs/identity cannot reference it without violating its lean
// import set. We bind a FAKE adapter via forRoot — the same fake/spy technique
// the deleted throwaway used, now committed. The proof is pure DI graph-shape +
// call-routing; no live Cognito is touched.
//
// DB-free: IdentityService is overridden with a fake (no Postgres), mirroring
// the financials sibling. The financials gate is the inert throw-on-call stub —
// the invite path never consults it.

const TENANT = '01900000-0000-7000-8000-000000000001';
const ACTOR = '01900000-0000-7000-8000-0000000000b2';
const EMAIL = 'invitee@aramo.dev';
const FAKE_SUB = 'fake-cognito-sub-01';

// Fake adapter passed via forRoot — records its calls so the routing proof can
// assert the invite leg landed HERE rather than on the throw-on-call stub. A
// no-arg constructor (matches the real TenantCognitoAdapter's shape) so no
// `imports` threading is needed for this port.
@Injectable()
class FakeTenantCognitoAdapter implements TenantCognitoPort {
  createCalls: Array<{ email: string; display_name?: string | null }> = [];

  async adminCreateUser(args: {
    email: string;
    display_name?: string | null;
  }): Promise<{ cognito_sub: string }> {
    this.createCalls.push(args);
    return { cognito_sub: FAKE_SUB };
  }

  // Unused by the invite-routing proof; present to satisfy the port contract.
  async adminDeleteUser(): Promise<void> {
    return;
  }
  async adminDisableUser(): Promise<void> {
    return;
  }
  async adminEnableUser(): Promise<void> {
    return;
  }
}

function makeFakeIdentityService(): {
  fake: IdentityService;
  createUserFromInvitation: ReturnType<typeof vi.fn>;
} {
  const createUserFromInvitation = vi.fn().mockResolvedValue({
    user: {
      id: '01900000-0000-7000-8000-0000000000a1',
      email: EMAIL,
      display_name: 'Invitee Person',
      is_active: true,
      deactivated_at: null,
      created_at: '2026-06-05T00:00:00.000Z',
      updated_at: '2026-06-05T00:00:00.000Z',
    },
    membership_id: 'membership-1',
  });
  const fake = {
    resolveRoleIdsByKeys: vi
      .fn()
      .mockImplementation(async (keys: readonly string[]) =>
        keys.map((k) => `role-id-${k}`),
      ),
    createUserFromInvitation,
  } as unknown as IdentityService;
  return { fake, createUserFromInvitation };
}

function inviteArgs() {
  return {
    tenant_id: TENANT,
    email: EMAIL,
    display_name: 'Invitee Person',
    role_keys: ['recruiter'] as const,
    actor_user_id: ACTOR,
    request_id: 'req-cognito-bind',
  };
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

  it('invite path ROUTES to the bound adapter (adminCreateUser lands on the fake, not the stub throw)', async () => {
    const { fake, createUserFromInvitation } = makeFakeIdentityService();
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

    const result = await svc.inviteTenantUser(inviteArgs());

    // LOAD-BEARING: the invite's Cognito leg reached the BOUND adapter — the
    // call lands on the fake's adminCreateUser, returning its sub, instead of
    // hitting StubTenantCognitoAdapter's throw (which the pre-fix dead-wire did,
    // surfacing as COGNITO_PROVISION_FAILED).
    expect(adapter.createCalls).toEqual([
      { email: EMAIL, display_name: 'Invitee Person' },
    ]);
    expect(result.cognito_sub).toBe(FAKE_SUB);
    // The identity-tx ran with the bound adapter's sub — end-to-end proof the
    // real-call path is wired, not the throw.
    expect(createUserFromInvitation).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'cognito',
        provider_subject: FAKE_SUB,
      }),
    );
  });
});
