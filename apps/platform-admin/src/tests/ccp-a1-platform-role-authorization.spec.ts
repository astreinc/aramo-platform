import 'reflect-metadata';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { APP_FILTER } from '@nestjs/core';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SignJWT, importPKCS8 } from 'jose';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { AramoExceptionFilter, RequestIdMiddleware } from '@aramo/common';
import {
  AuthModule,
  EFFECTIVE_AUTHORIZATION_RESOLVER,
  PLATFORM_TENANT_SENTINEL_ID,
  type EffectiveAuthorizationInput,
  type EffectiveAuthorizationResolution,
  type EffectiveAuthorizationResolver,
} from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementRepository } from '@aramo/entitlement';
import {
  DomainClaimService,
  IdentityAuditRepository,
  IdentityRepository,
  PLATFORM_ROLE_KEYS,
  PersonalRiskService,
  PersonalSignupRepository,
  TenantRepository,
  TenantService,
  filterScopesForConsumer,
} from '@aramo/identity';
import { AbuseReportService } from '@aramo/sign';
import { SubscriptionLifecycleService } from '@aramo/subscription';

import { InviteUserRequestDto } from '../app/platform/dto/invite-user.request.dto.js';
import { PlatformController } from '../app/platform/platform.controller.js';
import { PlatformInvitationService } from '../app/platform/platform-invitation.service.js';
import { PlatformPersonalController } from '../app/platform/platform-personal.controller.js';
import { PlatformSignController } from '../app/platform/platform-sign.controller.js';

import { generateTestKeyPair } from './test-keys.js';

// CCP A1 §4.2.1 (Aramo-CCP-A1-Commercial-Roles-and-Scopes-Directive-v1_0 LOCKED; ruling A0-C5)
// — MANDATORY per-role backend authorization tests for the platform-admin routes. Each of
// the 6 CCP platform roles is run, one at a time, as a principal holding EXACTLY that role,
// through the REAL request chain: a signed platform token → the real JwtAuthGuard (token
// verification + server-side effective-scope resolution) → the real RolesGuard
// (@RequireScopes) → the controller's consumer_type tripwire → AramoExceptionFilter.
// super_admin is the control.
//
// Effective scopes: the resolver returns the role's §4.1 bundle passed through the
// PRODUCTION consumer filter (filterScopesForConsumer, platform consumer) — the same
// derivation the identity resolver applies. The bundles are restated from §4.1 here (the
// seed constant is not exported to apps); libs/identity ccp-a1-commercial-role-catalog.spec.ts
// pins the seed to the same matrix, so the two cannot drift silently.
//
// Allowed: R-1…R-6 (platform:tenant:read) return 200. Refused: one or more routes per
// non-held scope family (provision, lifecycle, admin invite) return 403
// INSUFFICIENT_PERMISSIONS naming the missing scope, and the handler's service is never
// reached. The apps/api governance routes (skill, document template, matching policy) are
// covered by apps/api/src/tests/ccp-a1-platform-governance-authorization.spec.ts.
// §7.3(c) — InviteUserRequestDto refuses the 6 keys — is at the end of this file.

const ENTRY = 'platform:tenant:read';
const BUNDLES: Record<string, readonly string[]> = {
  platform_owner: [ENTRY, 'platform:catalog:read', 'platform:catalog:approve', 'platform:catalog:publish', 'platform:subscription:read', 'platform:subscription:approve', 'platform:entitlement:approve', 'platform:billing:read', 'platform:billing:approve', 'platform:approval:read', 'platform:commercial:audit:read'],
  finance_admin: [ENTRY, 'platform:catalog:read', 'platform:catalog:approve', 'platform:subscription:read', 'platform:subscription:approve', 'platform:entitlement:approve', 'platform:billing:read', 'platform:billing:approve', 'platform:approval:read', 'platform:commercial:audit:read'],
  commercial_ops: [ENTRY, 'platform:catalog:read', 'platform:subscription:read', 'platform:subscription:request', 'platform:entitlement:request', 'platform:billing:read', 'platform:billing:request', 'platform:approval:read'],
  catalog_manager: [ENTRY, 'platform:catalog:read', 'platform:catalog:draft', 'platform:approval:read'],
  support_admin: [ENTRY, 'platform:catalog:read', 'platform:subscription:read', 'platform:subscription:support', 'platform:billing:read', 'platform:approval:read'],
  read_only_auditor: [ENTRY, 'platform:catalog:read', 'platform:subscription:read', 'platform:billing:read', 'platform:approval:read', 'platform:commercial:audit:read'],
  // Control — the unchanged 10-scope bundle (seed.ts ROLE_SCOPE_ASSIGNMENTS.super_admin).
  super_admin: ['platform:tenant:provision', ENTRY, 'platform:admin:invite', 'platform:tenant:lifecycle:manage', 'platform:skill:read', 'platform:skill:manage', 'platform:document_template:read', 'platform:document_template:manage', 'platform:matching_policy:read', 'platform:matching_policy:write'],
};
const CCP_ROLES = ['platform_owner', 'finance_admin', 'commercial_ops', 'catalog_manager', 'support_admin', 'read_only_auditor'] as const;

const T = '019a0000-0000-7000-8000-0000000000aa';
type Route = { id: string; method: 'get' | 'post'; path: string; scope: string };
const ALLOWED: Route[] = [
  { id: 'R-1', method: 'get', path: '/platform/me', scope: ENTRY },
  { id: 'R-2', method: 'get', path: '/platform/tenants', scope: ENTRY },
  { id: 'R-3', method: 'get', path: '/platform/dashboard', scope: ENTRY },
  { id: 'R-4', method: 'get', path: `/platform/tenants/${T}`, scope: ENTRY },
  { id: 'R-5', method: 'get', path: `/platform/tenants/${T}/audit`, scope: ENTRY },
  { id: 'R-6', method: 'get', path: `/platform/tenants/${T}/sign`, scope: ENTRY },
];
const REFUSED: Route[] = [
  { id: 'provision-1', method: 'post', path: '/platform/tenants', scope: 'platform:tenant:provision' },
  { id: 'provision-2', method: 'post', path: `/platform/tenants/${T}/invitations`, scope: 'platform:tenant:provision' },
  { id: 'provision-3', method: 'post', path: `/platform/tenants/${T}/resend-owner-invite`, scope: 'platform:tenant:provision' },
  { id: 'lifecycle-1', method: 'post', path: `/platform/tenants/${T}/suspend`, scope: 'platform:tenant:lifecycle:manage' },
  { id: 'lifecycle-2', method: 'post', path: `/platform/tenants/${T}/reactivate`, scope: 'platform:tenant:lifecycle:manage' },
  { id: 'lifecycle-3', method: 'post', path: `/platform/tenants/${T}/start-offboarding`, scope: 'platform:tenant:lifecycle:manage' },
  { id: 'lifecycle-4', method: 'post', path: `/platform/tenants/${T}/close`, scope: 'platform:tenant:lifecycle:manage' },
  { id: 'lifecycle-5', method: 'get', path: `/platform/tenants/${T}/domain`, scope: 'platform:tenant:lifecycle:manage' },
  { id: 'lifecycle-6', method: 'get', path: '/platform/personal-review', scope: 'platform:tenant:lifecycle:manage' },
  // M-A7 §5.2 — the operators' abuse-report queue (every sender).
  { id: 'lifecycle-7', method: 'get', path: '/platform/sign-abuse-reports', scope: 'platform:tenant:lifecycle:manage' },
  { id: 'admin-invite', method: 'post', path: '/platform/admins/invitations', scope: 'platform:admin:invite' },
];

// MODE B-shaped resolver: principal → its one role → that role's bundle → the production
// platform-consumer filter.
class RoleBundleResolver implements EffectiveAuthorizationResolver {
  readonly roleOf = new Map<string, string>();
  async resolve(input: EffectiveAuthorizationInput): Promise<EffectiveAuthorizationResolution> {
    const role = this.roleOf.get(input.principal_id);
    const scopes = role === undefined ? [] : [...(BUNDLES[role] ?? [])];
    return { status: 'ok', scopes: filterScopesForConsumer({ consumer: input.consumer_type, scopes, tenantHasEsign: false }) };
  }
}

describe('CCP A1 §4.2.1 — per-role platform-admin authorization (real JwtAuthGuard + RolesGuard)', () => {
  let app: INestApplication;
  let privatePem: string;
  const audience = 'aramo-platform-ccp-a1-test';
  const saved: Record<string, string | undefined> = {};
  const resolver = new RoleBundleResolver();
  const principal = new Map<string, string>(); // role -> sub

  const tenant = { id: T, name: 'Acme', is_active: true, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', identity_provider: null, status: 'ACTIVE', kind: 'BUSINESS' };
  const svc = {
    invitations: { provisionTenantAndInviteOwner: vi.fn(), inviteUserIntoTenant: vi.fn(), resendOwnerInvite: vi.fn(), invitePlatformAdmin: vi.fn() },
    tenantSvc: {
      getTenantById: vi.fn(async () => tenant),
      listTenantsForPlatform: vi.fn(async () => [tenant]),
      getPlatformDashboard: vi.fn(async () => ({ status_counts: {}, onboarding: [], recent_activity: [] })),
      suspendTenant: vi.fn(), reactivateTenant: vi.fn(), startOffboarding: vi.fn(), closeTenant: vi.fn(),
    },
    auditRepo: { findTenantLifecycleAudit: vi.fn(async () => [{ event_type: 'tenant.created', created_at: new Date(0), actor_type: 'system', actor_id: null, event_payload: {} }]) },
    domainClaims: { getClaimView: vi.fn(async () => null), claimFor: vi.fn(async () => null) },
    identityRepo: { findMeContext: vi.fn(async () => ({ email: 'ops@aramo.ai', display_name: 'Ops', roles: [{ key: 'x', description: 'x' }], tenant_name: 'Aramo Platform', tenant_display_name: null, tenant_status: 'ACTIVE' })) },
    tenantRepo: { findSlugById: vi.fn(async () => 'acme') },
    entitlements: { getCapabilities: vi.fn(async () => new Set(['core', 'sign'])) },
    lifecycle: { account: vi.fn(async () => ({ subscription: null, allowance: null, storage: null, billing_available: false })), recentBillingEvents: vi.fn(async () => []) },
    risk: { reviewClearsStepUp: vi.fn(() => false), phoneVerificationAvailable: vi.fn(() => false) },
    signups: { reviewQueue: vi.fn(async () => []) },
    reports: { listQueue: vi.fn(async () => []) },
  };
  // The services behind every REFUSED route: none may ever be reached for a CCP role.
  const refusedRouteServices = [
    svc.invitations.provisionTenantAndInviteOwner, svc.invitations.inviteUserIntoTenant, svc.invitations.resendOwnerInvite,
    svc.invitations.invitePlatformAdmin, svc.tenantSvc.suspendTenant, svc.tenantSvc.reactivateTenant,
    svc.tenantSvc.startOffboarding, svc.tenantSvc.closeTenant, svc.signups.reviewQueue, svc.reports.listQueue,
  ];

  async function tokenFor(role: string): Promise<string> {
    let sub = principal.get(role);
    if (sub === undefined) {
      sub = uuidv7();
      principal.set(role, sub);
      resolver.roleOf.set(sub, role);
    }
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ consumer_type: 'platform', actor_kind: 'user', tenant_id: PLATFORM_TENANT_SENTINEL_ID, authz_version: 1 })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer('Aramo Core Auth')
      .setAudience(audience)
      .setSubject(sub)
      .setIssuedAt(now)
      .setExpirationTime(now + 900)
      .sign(await importPKCS8(privatePem, 'RS256'));
  }
  async function call(role: string, r: Route) {
    const req = request(app.getHttpServer())[r.method](r.path).set('Authorization', `Bearer ${await tokenFor(role)}`);
    return r.method === 'post' ? req.send({}) : req;
  }

  beforeAll(async () => {
    const keys = generateTestKeyPair();
    privatePem = keys.privatePem;
    for (const k of ['AUTH_AUDIENCE', 'AUTH_PUBLIC_KEY']) saved[k] = process.env[k];
    process.env['AUTH_AUDIENCE'] = audience;
    process.env['AUTH_PUBLIC_KEY'] = keys.publicPem;
    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule, AuthorizationModule],
      controllers: [PlatformController, PlatformSignController, PlatformPersonalController],
      providers: [
        { provide: EFFECTIVE_AUTHORIZATION_RESOLVER, useValue: resolver },
        { provide: APP_FILTER, useClass: AramoExceptionFilter },
        { provide: PlatformInvitationService, useValue: svc.invitations },
        { provide: TenantService, useValue: svc.tenantSvc },
        { provide: IdentityAuditRepository, useValue: svc.auditRepo },
        { provide: DomainClaimService, useValue: svc.domainClaims },
        { provide: IdentityRepository, useValue: svc.identityRepo },
        { provide: TenantRepository, useValue: svc.tenantRepo },
        { provide: EntitlementRepository, useValue: svc.entitlements },
        { provide: SubscriptionLifecycleService, useValue: svc.lifecycle },
        { provide: PersonalRiskService, useValue: svc.risk },
        { provide: PersonalSignupRepository, useValue: svc.signups },
        { provide: AbuseReportService, useValue: svc.reports },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use((req: never, res: never, next: () => void) => new RequestIdMiddleware().use(req, res, next));
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    // Merge train TD-MERGE-41: one bound loopback port for the file (see support/ccp-d4-harness.ts).
    await app.listen(0, '127.0.0.1');
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('the 6 CCP roles are platform-tier keys (PLATFORM_ROLE_KEYS); each holds platform:tenant:read and none of provision / lifecycle / admin invite', () => {
    for (const role of CCP_ROLES) {
      expect(PLATFORM_ROLE_KEYS as readonly string[]).toContain(role);
      expect(BUNDLES[role]).toContain(ENTRY);
      for (const r of REFUSED) expect(BUNDLES[role], `${role} ${r.scope}`).not.toContain(r.scope);
    }
  });

  for (const role of CCP_ROLES) {
    describe(`${role} (exactly one role)`, () => {
      for (const r of ALLOWED) {
        it(`allowed — ${r.id} ${r.method.toUpperCase()} ${r.path.replace(T, ':tenant_id')} → 200`, async () => {
          const res = await call(role, r);
          expect(res.status, JSON.stringify(res.body)).toBe(200);
        });
      }
      for (const r of REFUSED) {
        it(`refused — ${r.method.toUpperCase()} ${r.path.replace(T, ':tenant_id')} → 403 (missing ${r.scope})`, async () => {
          for (const f of refusedRouteServices) f.mockClear();
          const res = await call(role, r);
          expect(res.status).toBe(403);
          expect(res.body?.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
          expect(res.body?.error?.details?.missing_scopes).toEqual([r.scope]);
          for (const f of refusedRouteServices) expect(f).not.toHaveBeenCalled();
        });
      }
    });
  }

  describe('super_admin (control — unchanged by CCP A1)', () => {
    for (const r of ALLOWED) {
      it(`allowed — ${r.id} ${r.method.toUpperCase()} ${r.path.replace(T, ':tenant_id')} → 200`, async () => {
        const res = await call('super_admin', r);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
      });
    }
    for (const r of REFUSED) {
      it(`admitted by the guard — ${r.method.toUpperCase()} ${r.path.replace(T, ':tenant_id')} (holds ${r.scope}; status ≠ 403)`, async () => {
        const res = await call('super_admin', r);
        expect(res.status, JSON.stringify(res.body)).not.toBe(403);
        expect(res.body?.error?.code).not.toBe('INSUFFICIENT_PERMISSIONS');
      });
    }
  });
});

describe('CCP A1 §7.3(c) — InviteUserRequestDto refuses the 6 CCP role keys (400 at the DTO)', () => {
  for (const key of ['platform_owner', 'finance_admin', 'commercial_ops', 'catalog_manager', 'support_admin', 'read_only_auditor']) {
    it(`${key} is not in the tenant-assignable allow-list`, async () => {
      const bad = await validate(plainToInstance(InviteUserRequestDto, { email: 'a@acme.io', role_keys: ['recruiter', key] }));
      expect(bad.some((e) => e.property === 'role_keys' && e.constraints?.['isIn'] !== undefined)).toBe(true);
      const ok = await validate(plainToInstance(InviteUserRequestDto, { email: 'a@acme.io', role_keys: ['recruiter'] }));
      expect(ok).toEqual([]);
    });
  }
});
