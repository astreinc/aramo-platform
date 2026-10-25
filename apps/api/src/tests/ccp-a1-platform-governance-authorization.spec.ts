import 'reflect-metadata';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { APP_FILTER } from '@nestjs/core';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { AramoExceptionFilter, RequestIdMiddleware } from '@aramo/common';
import { AuthModule, EFFECTIVE_AUTHORIZATION_RESOLVER, PLATFORM_TENANT_SENTINEL_ID } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { TemplateVariablesRepository, TemplatesRepository } from '@aramo/documents';
import { filterScopesForConsumer } from '@aramo/identity';
import { MatchingPolicyRepository, SkillGovernanceService, SkillRegistryService } from '@aramo/skills-taxonomy';

import { PlatformDocumentTemplatesController } from '../document-templates-platform/platform-document-templates.controller.js';
import { MatchingPolicyController } from '../matching-policy/matching-policy.controller.js';
import { SkillGovernanceController } from '../skill-governance/skill-governance.controller.js';
import { SkillReviewQueueService } from '../skill-governance/skill-review-queue.service.js';

import { ConfigurableTestResolver, generateTestKeyPair, signCompactAccessToken } from './support/test-auth-harness.js';

// CCP A1 §4.2.1 (Aramo-CCP-A1-Commercial-Roles-and-Scopes-Directive-v1_0 LOCKED; ruling A0-C5)
// — the apps/api half of the mandatory per-role authorization tests: the platform governance
// routes. Each of the 6 CCP platform roles, as a principal holding exactly that role, is
// REFUSED (403, scope missing) on the three governance read routes through the real
// JwtAuthGuard + RolesGuard; super_admin (control) is admitted (200). The role bundles are
// the §4.1 matrix (pinned to the seed by libs/identity ccp-a1-commercial-role-catalog.spec.ts)
// passed through the production platform-consumer filter. The platform-admin routes
// (R-1…R-6 allowed; provision / lifecycle / admin invite refused) are in
// apps/platform-admin/src/tests/ccp-a1-platform-role-authorization.spec.ts.

const ENTRY = 'platform:tenant:read';
const BUNDLES: Record<string, readonly string[]> = {
  platform_owner: [ENTRY, 'platform:catalog:read', 'platform:catalog:approve', 'platform:catalog:publish', 'platform:subscription:read', 'platform:subscription:approve', 'platform:entitlement:approve', 'platform:billing:read', 'platform:billing:approve', 'platform:approval:read', 'platform:commercial:audit:read'],
  finance_admin: [ENTRY, 'platform:catalog:read', 'platform:catalog:approve', 'platform:subscription:read', 'platform:subscription:approve', 'platform:entitlement:approve', 'platform:billing:read', 'platform:billing:approve', 'platform:approval:read', 'platform:commercial:audit:read'],
  commercial_ops: [ENTRY, 'platform:catalog:read', 'platform:subscription:read', 'platform:subscription:request', 'platform:entitlement:request', 'platform:billing:read', 'platform:billing:request', 'platform:approval:read'],
  catalog_manager: [ENTRY, 'platform:catalog:read', 'platform:catalog:draft', 'platform:approval:read'],
  support_admin: [ENTRY, 'platform:catalog:read', 'platform:subscription:read', 'platform:subscription:support', 'platform:billing:read', 'platform:approval:read'],
  read_only_auditor: [ENTRY, 'platform:catalog:read', 'platform:subscription:read', 'platform:billing:read', 'platform:approval:read', 'platform:commercial:audit:read'],
  super_admin: ['platform:tenant:provision', ENTRY, 'platform:admin:invite', 'platform:tenant:lifecycle:manage', 'platform:skill:read', 'platform:skill:manage', 'platform:document_template:read', 'platform:document_template:manage', 'platform:matching_policy:read', 'platform:matching_policy:write'],
};
const CCP_ROLES = ['platform_owner', 'finance_admin', 'commercial_ops', 'catalog_manager', 'support_admin', 'read_only_auditor'] as const;
const ROUTES = [
  { path: '/platform/skills', scope: 'platform:skill:read' },
  { path: '/platform/document-templates/document-types', scope: 'platform:document_template:read' },
  { path: '/platform/matching-policy', scope: 'platform:matching_policy:read' },
] as const;

describe('CCP A1 §4.2.1 — per-role authorization on the apps/api platform governance routes', () => {
  let app: INestApplication;
  let privatePem: string;
  const audience = 'aramo-api-ccp-a1-test';
  const saved: Record<string, string | undefined> = {};
  const resolver = new ConfigurableTestResolver();
  const svc = {
    registry: { listSkills: vi.fn(async () => []) },
    governance: {},
    reviewQueue: {},
    templates: { listSystemDocumentTypes: vi.fn(async () => []) },
    variables: {},
    store: { listVersions: vi.fn(async () => []) },
  };
  const handlers = [svc.registry.listSkills, svc.templates.listSystemDocumentTypes, svc.store.listVersions];

  async function tokenFor(role: string): Promise<string> {
    const sub = uuidv7();
    const scopes = filterScopesForConsumer({ consumer: 'platform', scopes: [...(BUNDLES[role] ?? [])], tenantHasEsign: false });
    const authz_version = resolver.grant(PLATFORM_TENANT_SENTINEL_ID, sub, scopes);
    return signCompactAccessToken({ privatePem, audience, sub, tenant_id: PLATFORM_TENANT_SENTINEL_ID, consumer_type: 'platform', authz_version });
  }

  beforeAll(async () => {
    const keys = await generateTestKeyPair();
    privatePem = keys.privatePem;
    for (const k of ['AUTH_AUDIENCE', 'AUTH_PUBLIC_KEY']) saved[k] = process.env[k];
    process.env['AUTH_AUDIENCE'] = audience;
    process.env['AUTH_PUBLIC_KEY'] = keys.publicPem;
    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule, AuthorizationModule],
      controllers: [SkillGovernanceController, PlatformDocumentTemplatesController, MatchingPolicyController],
      providers: [
        { provide: EFFECTIVE_AUTHORIZATION_RESOLVER, useValue: resolver },
        { provide: APP_FILTER, useClass: AramoExceptionFilter },
        { provide: SkillRegistryService, useValue: svc.registry },
        { provide: SkillGovernanceService, useValue: svc.governance },
        { provide: SkillReviewQueueService, useValue: svc.reviewQueue },
        { provide: TemplatesRepository, useValue: svc.templates },
        { provide: TemplateVariablesRepository, useValue: svc.variables },
        { provide: MatchingPolicyRepository, useValue: svc.store },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use((req: never, res: never, next: () => void) => new RequestIdMiddleware().use(req, res, next));
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  for (const role of CCP_ROLES) {
    for (const r of ROUTES) {
      it(`${role} — refused: GET ${r.path} → 403 (missing ${r.scope}); handler never reached`, async () => {
        for (const h of handlers) h.mockClear();
        const res = await request(app.getHttpServer()).get(r.path).set('Authorization', `Bearer ${await tokenFor(role)}`);
        expect(res.status).toBe(403);
        expect(res.body?.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
        expect(res.body?.error?.details?.missing_scopes).toEqual([r.scope]);
        for (const h of handlers) expect(h).not.toHaveBeenCalled();
      });
    }
  }

  for (const r of ROUTES) {
    it(`super_admin (control) — allowed: GET ${r.path} → 200`, async () => {
      const res = await request(app.getHttpServer()).get(r.path).set('Authorization', `Bearer ${await tokenFor('super_admin')}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    });
  }
});
