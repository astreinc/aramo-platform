import 'reflect-metadata';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { APP_FILTER } from '@nestjs/core';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
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
import { filterScopesForConsumer } from '@aramo/identity';
import {
  CommercialAuditExportService,
  CommercialAuditExportTooLargeError,
  CommercialChangeRequestError,
  CommercialOperatorRosterService,
  CommercialPolicyGovernanceService,
} from '@aramo/subscription';

import { PlatformCommercialGovernanceController } from '../app/platform/platform-commercial-governance.controller.js';

import { generateTestKeyPair } from './test-keys.js';

// CCP-B5 (PBD §5.3 row B5 + the common Phase B set "for every action, both the UI gating and
// the backend refusal for an ineligible role") — the five B5 routes, run for each of the 6
// CCP platform roles and super_admin (one role per principal), through the REAL request
// chain: a signed platform token → the real JwtAuthGuard (server-side effective-scope
// resolution) → the real RolesGuard (@RequireScopes) → the controller's tier tripwire →
// AramoExceptionFilter. The services are mocked: the service-level authority (author role,
// draft lock, export bound) is proven on real Postgres
// (libs/subscription/src/tests/ccp-b5-governance.integration.spec.ts and
// ccp-b5-governance-routes.integration.spec.ts).
//
// Expected (CCP A1 §4.1 bundles): `platform:approval:read` routes admit the 6 CCP roles and
// refuse super_admin (INV-1); the export (`platform:commercial:audit:read`) admits
// platform_owner, finance_admin and read_only_auditor only.

const ENTRY = 'platform:tenant:read';
const AUDIT = 'platform:commercial:audit:read';
const APPROVAL = 'platform:approval:read';
const BUNDLES: Record<string, readonly string[]> = {
  platform_owner: [ENTRY, 'platform:catalog:read', 'platform:catalog:approve', 'platform:catalog:publish', 'platform:subscription:read', 'platform:subscription:approve', 'platform:entitlement:approve', 'platform:billing:read', 'platform:billing:approve', APPROVAL, AUDIT],
  finance_admin: [ENTRY, 'platform:catalog:read', 'platform:catalog:approve', 'platform:subscription:read', 'platform:subscription:approve', 'platform:entitlement:approve', 'platform:billing:read', 'platform:billing:approve', APPROVAL, AUDIT],
  commercial_ops: [ENTRY, 'platform:catalog:read', 'platform:subscription:read', 'platform:subscription:request', 'platform:entitlement:request', 'platform:billing:read', 'platform:billing:request', APPROVAL],
  catalog_manager: [ENTRY, 'platform:catalog:read', 'platform:catalog:draft', APPROVAL],
  support_admin: [ENTRY, 'platform:catalog:read', 'platform:subscription:read', 'platform:subscription:support', 'platform:billing:read', APPROVAL],
  read_only_auditor: [ENTRY, 'platform:catalog:read', 'platform:subscription:read', 'platform:billing:read', APPROVAL, AUDIT],
  super_admin: ['platform:tenant:provision', ENTRY, 'platform:admin:invite', 'platform:tenant:lifecycle:manage', 'platform:skill:read', 'platform:skill:manage', 'platform:document_template:read', 'platform:document_template:manage', 'platform:matching_policy:read', 'platform:matching_policy:write'],
};
const CCP_ROLES = ['platform_owner', 'finance_admin', 'commercial_ops', 'catalog_manager', 'support_admin', 'read_only_auditor'] as const;
const AUDIT_ROLES = ['platform_owner', 'finance_admin', 'read_only_auditor'] as const;
const V1 = '019a0000-0000-7000-8000-0000000cc201';
const V2 = '019a0000-0000-7000-8000-0000000cc2a2';

class RoleBundleResolver implements EffectiveAuthorizationResolver {
  readonly roleOf = new Map<string, string>();
  async resolve(input: EffectiveAuthorizationInput): Promise<EffectiveAuthorizationResolution> {
    const role = this.roleOf.get(input.principal_id);
    const scopes = role === undefined ? [] : [...(BUNDLES[role] ?? [])];
    return { status: 'ok', scopes: filterScopesForConsumer({ consumer: input.consumer_type, scopes, tenantHasEsign: false }) };
  }
}

const versionRow = (id: string, status: string) => ({
  id,
  version_number: id === V1 ? 1 : 2,
  status,
  content: { format_version: 1 },
  content_checksum: 'a'.repeat(64),
  note: null,
  created_by: null,
  created_at: new Date('2026-10-24T00:00:00.000Z'),
  activated_by: null,
  activated_at: status === 'ACTIVE' ? new Date('2026-10-24T00:00:00.000Z') : null,
  retired_at: null,
});

describe('CCP-B5 — per-role authorization on the policy, roster and export routes (real JwtAuthGuard + RolesGuard)', () => {
  let app: INestApplication;
  let privatePem: string;
  const audience = 'aramo-platform-ccp-b5-test';
  const saved: Record<string, string | undefined> = {};
  const resolver = new RoleBundleResolver();
  const principal = new Map<string, string>();
  const gov = {
    list: vi.fn(async () => ({ versions: [{ row: versionRow(V1, 'ACTIVE'), content: { format_version: 1 }, open_request: null, latest_request: null }], active_version_id: V1, open_request: null, caller: { can_author: false, can_request_activation: false } })),
    createDraft: vi.fn(async () => versionRow(V2, 'DRAFT')),
    updateDraft: vi.fn(async () => versionRow(V2, 'DRAFT')),
  };
  const roster = { read: vi.fn(async () => ({ operators: [], chains: [], all_fulfillable: false })) };
  const exporter = {
    export: vi.fn(async () => ({ export_id: uuidv7(), exported_at: new Date('2026-10-25T00:00:00.000Z'), row_count: 1, filename: 'commercial-audit.csv', csv: 'id\r\n', csv_sha256: 'b'.repeat(64) })),
  };
  const mocks = [gov.list, gov.createDraft, gov.updateDraft, roster.read, exporter.export];

  async function tokenFor(role: string, consumer_type = 'platform'): Promise<string> {
    const key = `${role}:${consumer_type}`;
    let sub = principal.get(key);
    if (sub === undefined) {
      sub = uuidv7();
      principal.set(key, sub);
      resolver.roleOf.set(sub, role);
    }
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ consumer_type, actor_kind: 'user', tenant_id: PLATFORM_TENANT_SENTINEL_ID, authz_version: 1 })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer('Aramo Core Auth')
      .setAudience(audience)
      .setSubject(sub)
      .setIssuedAt(now)
      .setExpirationTime(now + 900)
      .sign(await importPKCS8(privatePem, 'RS256'));
  }

  type Route = { name: string; method: 'get' | 'post' | 'patch'; path: string; body?: object; scope: string; ok: number; service: ReturnType<typeof vi.fn> };
  const ROUTES: Route[] = [
    { name: 'GET policy-versions', method: 'get', path: '/platform/commercial/policy-versions', scope: APPROVAL, ok: 200, service: gov.list },
    { name: 'POST policy-versions', method: 'post', path: '/platform/commercial/policy-versions', body: { source_version_id: V1 }, scope: APPROVAL, ok: 201, service: gov.createDraft },
    { name: 'PATCH policy-versions/:id', method: 'patch', path: `/platform/commercial/policy-versions/${V2}`, body: { content: { approval_expiry_hours: 48 } }, scope: APPROVAL, ok: 200, service: gov.updateDraft },
    { name: 'GET operators', method: 'get', path: '/platform/commercial/operators', scope: APPROVAL, ok: 200, service: roster.read },
    { name: 'POST audit-events/export', method: 'post', path: '/platform/commercial/audit-events/export', body: {}, scope: AUDIT, ok: 200, service: exporter.export },
  ];
  const call = async (r: Route, role: string, consumer_type = 'platform', body: object | undefined = r.body) => {
    const t = request(app.getHttpServer())[r.method](r.path).set('Authorization', `Bearer ${await tokenFor(role, consumer_type)}`);
    return body === undefined ? t : t.send(body);
  };

  beforeAll(async () => {
    const keys = generateTestKeyPair();
    privatePem = keys.privatePem;
    for (const k of ['AUTH_AUDIENCE', 'AUTH_PUBLIC_KEY']) saved[k] = process.env[k];
    process.env['AUTH_AUDIENCE'] = audience;
    process.env['AUTH_PUBLIC_KEY'] = keys.publicPem;
    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule, AuthorizationModule],
      controllers: [PlatformCommercialGovernanceController],
      providers: [
        { provide: EFFECTIVE_AUTHORIZATION_RESOLVER, useValue: resolver },
        { provide: APP_FILTER, useClass: AramoExceptionFilter },
        { provide: CommercialPolicyGovernanceService, useValue: gov },
        { provide: CommercialOperatorRosterService, useValue: roster },
        { provide: CommercialAuditExportService, useValue: exporter },
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

  beforeEach(() => mocks.forEach((m) => m.mockClear()));

  for (const r of ROUTES) {
    const allowed: readonly string[] = r.scope === AUDIT ? AUDIT_ROLES : CCP_ROLES;
    for (const role of [...CCP_ROLES, 'super_admin']) {
      const ok = allowed.includes(role);
      it(`B5-AUTH ${r.name}: ${role} → ${ok ? r.ok : `403 missing ${r.scope}`}`, async () => {
        const res = await call(r, role);
        if (ok) {
          expect(res.status, JSON.stringify(res.body)).toBe(r.ok);
          expect(r.service).toHaveBeenCalledTimes(1);
        } else {
          expect(res.status).toBe(403);
          expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
          expect(res.body.error.details.missing_scopes).toEqual([r.scope]);
          expect(r.service).not.toHaveBeenCalled();
        }
      });
    }
    it(`B5-AUTH ${r.name}: a tenant-tier token is refused (403) and no token is 401; the service is never reached`, async () => {
      expect((await call(r, 'platform_owner', 'recruiter')).status).toBe(403);
      const t = request(app.getHttpServer())[r.method](r.path);
      expect((await (r.body === undefined ? t : t.send(r.body))).status).toBe(401);
      expect(r.service).not.toHaveBeenCalled();
    });
  }

  it('B5-AUTH-400 malformed bodies are refused before any service: a bad source id, an unknown content key, a non-integer value, an unknown export filter, an inverted date range', async () => {
    const [, create, patch, , exp] = ROUTES as [Route, Route, Route, Route, Route];
    expect((await call(create, 'finance_admin', 'platform', { source_version_id: 'nope' })).status).toBe(400);
    expect((await call(patch, 'finance_admin', 'platform', { content: { currency: 'EUR' } })).status).toBe(400);
    expect((await call(patch, 'finance_admin', 'platform', { content: { approval_expiry_hours: 1.5 } })).status).toBe(400);
    expect((await call(exp, 'read_only_auditor', 'platform', { limit: 5 })).status).toBe(400);
    const inv = await call(exp, 'read_only_auditor', 'platform', { from: '2026-10-25T00:00:00Z', to: '2026-10-24T00:00:00Z' });
    expect(inv.status).toBe(400);
    expect(inv.body.error.details.reason).toBe('invalid_date_range');
    expect(gov.createDraft).not.toHaveBeenCalled();
    expect(gov.updateDraft).not.toHaveBeenCalled();
    expect(exporter.export).not.toHaveBeenCalled();
  });

  it('B5-AUTH-MAP service refusals reach the console typed: author role missing 403, draft locked 409, export too large 400', async () => {
    const [, create, patch, , exp] = ROUTES as [Route, Route, Route, Route, Route];
    gov.createDraft.mockRejectedValueOnce(new CommercialChangeRequestError('REQUESTER_ROLE_MISSING', 'x', { required_role: ['platform_owner', 'finance_admin'] }));
    const a = await call(create, 'commercial_ops');
    expect(a.status).toBe(403);
    expect(a.body.error.details.reason).toBe('requester_role_missing');
    gov.updateDraft.mockRejectedValueOnce(new CommercialChangeRequestError('STATE_INVALID', 'x', { reason: 'policy_version_locked', open_request_id: V1 }));
    const b = await call(patch, 'finance_admin');
    expect(b.status).toBe(409);
    expect(b.body.error.code).toBe('COMMERCIAL_CHANGE_REQUEST_CONFLICT');
    expect(b.body.error.details.reason).toBe('policy_version_locked');
    exporter.export.mockRejectedValueOnce(new CommercialAuditExportTooLargeError(10_000));
    const c = await call(exp, 'read_only_auditor');
    expect(c.status).toBe(400);
    expect(c.body.error.details).toMatchObject({ reason: 'export_too_large', max_rows: 10_000 });
  });

  it('B5-AUTH-PATCH a draft edit passes ONLY the settings sent (no undefined keys from the transformed DTO)', async () => {
    const patch = ROUTES[2] as Route;
    expect((await call(patch, 'finance_admin')).status).toBe(200);
    const [, id, input] = gov.updateDraft.mock.calls[0] as unknown as [unknown, string, Record<string, unknown>];
    expect(id).toBe(V2);
    expect(input).toStrictEqual({ content: { approval_expiry_hours: 48 } });
  });

  it('B5-AUTH-EXPORT the export passes the typed filters to the service and returns the CSV envelope', async () => {
    const exp = ROUTES[4] as Route;
    const cr = uuidv7();
    const res = await call(exp, 'finance_admin', 'platform', { change_request_id: cr, product_key: 'sign', exception_only: true, from: '2026-10-01T00:00:00Z' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ row_count: 1, content_type: 'text/csv', csv: 'id\r\n' });
    const [, query] = exporter.export.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    expect(query).toMatchObject({ change_request_id: cr, product_key: 'sign', exception_only: true });
    expect(query['from']).toBeInstanceOf(Date);
  });
});
