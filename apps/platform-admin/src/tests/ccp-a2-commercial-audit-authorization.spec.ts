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
import { CommercialAuditCursorError, CommercialAuditRepository } from '@aramo/subscription';

import { PlatformCommercialAuditController } from '../app/platform/platform-commercial-audit.controller.js';

import { generateTestKeyPair } from './test-keys.js';

// CCP-A2 (PBD §5.1 row A2, mandatory test "per-role allowed/refused on the audit read
// route") — GET /platform/commercial/audit-events under platform:commercial:audit:read,
// run for each of the 6 CCP platform roles and super_admin, one role per principal,
// through the REAL request chain: a signed platform token → the real JwtAuthGuard
// (server-side effective-scope resolution) → the real RolesGuard (@RequireScopes) → the
// controller's consumer_type tripwire → AramoExceptionFilter.
//
// Expected (CCP A1 §4.1 bundles): allowed — platform_owner, finance_admin,
// read_only_auditor; refused — commercial_ops, catalog_manager, support_admin and
// super_admin (no commercial scope, INV-1; PBD §12 "no commercial permissions for
// super_admin by default"). The bundles are restated from §4.1 as in the A1 spec
// (ccp-a1-platform-role-authorization.spec.ts); libs/identity pins the seed to the same
// matrix.

const SCOPE = 'platform:commercial:audit:read';
const ENTRY = 'platform:tenant:read';
const AMOUNT = 'platform:billing:amount:read';
const BUNDLES: Record<string, readonly string[]> = {
  platform_owner: [ENTRY, 'platform:catalog:read', 'platform:catalog:approve', 'platform:catalog:publish', 'platform:subscription:read', 'platform:subscription:approve', 'platform:entitlement:approve', 'platform:billing:read', 'platform:billing:approve', 'platform:approval:read', SCOPE, AMOUNT],
  finance_admin: [ENTRY, 'platform:catalog:read', 'platform:catalog:approve', 'platform:subscription:read', 'platform:subscription:approve', 'platform:entitlement:approve', 'platform:billing:read', 'platform:billing:approve', 'platform:approval:read', SCOPE, AMOUNT],
  commercial_ops: [ENTRY, 'platform:catalog:read', 'platform:subscription:read', 'platform:subscription:request', 'platform:entitlement:request', 'platform:billing:read', 'platform:billing:request', 'platform:approval:read'],
  catalog_manager: [ENTRY, 'platform:catalog:read', 'platform:catalog:draft', 'platform:approval:read'],
  support_admin: [ENTRY, 'platform:catalog:read', 'platform:subscription:read', 'platform:subscription:support', 'platform:billing:read', 'platform:approval:read'],
  read_only_auditor: [ENTRY, 'platform:catalog:read', 'platform:subscription:read', 'platform:billing:read', 'platform:approval:read', SCOPE, AMOUNT],
  // CCP-R3 — NOT a catalog role: a synthetic principal holding the audit scope without the amount
  // scope, proving the field rule independently of today's bundles (every audit reader is an amount
  // holder under FA-2).
  audit_without_amount: [ENTRY, 'platform:billing:read', SCOPE],
  super_admin: ['platform:tenant:provision', ENTRY, 'platform:admin:invite', 'platform:tenant:lifecycle:manage', 'platform:skill:read', 'platform:skill:manage', 'platform:document_template:read', 'platform:document_template:manage', 'platform:matching_policy:read', 'platform:matching_policy:write'],
};
const ALLOWED = ['platform_owner', 'finance_admin', 'read_only_auditor'] as const;
const REFUSED = ['commercial_ops', 'catalog_manager', 'support_admin', 'super_admin'] as const;
const PATH = '/platform/commercial/audit-events';

class RoleBundleResolver implements EffectiveAuthorizationResolver {
  readonly roleOf = new Map<string, string>();
  async resolve(input: EffectiveAuthorizationInput): Promise<EffectiveAuthorizationResolution> {
    const role = this.roleOf.get(input.principal_id);
    const scopes = role === undefined ? [] : [...(BUNDLES[role] ?? [])];
    return { status: 'ok', scopes: filterScopesForConsumer({ consumer: input.consumer_type, scopes, tenantHasEsign: false }) };
  }
}

const ROW = {
  id: '019a0000-0000-7000-8000-0000000cc203',
  actor_id: null,
  actor_type: 'system',
  actor_role_keys: [],
  event_type: 'COMMERCIAL_POLICY_VERSION_ACTIVATED',
  is_exception: false,
  tenant_id: null,
  subject: 'commercial_policy_version:019a0000-0000-7000-8000-0000000cc201',
  change_request_id: null,
  policy_version_id: '019a0000-0000-7000-8000-0000000cc201',
  payload: { version_number: 1 },
  correlation_id: 'migration:20261024180000_ccp_a2_commercial_audit_policy',
  created_at: new Date('2026-10-24T00:00:00.000Z'),
};

describe('CCP-A2 — per-role authorization on GET /platform/commercial/audit-events (real JwtAuthGuard + RolesGuard)', () => {
  let app: INestApplication;
  let privatePem: string;
  const audience = 'aramo-platform-ccp-a2-test';
  const saved: Record<string, string | undefined> = {};
  const resolver = new RoleBundleResolver();
  const principal = new Map<string, string>();
  const repo = { list: vi.fn(async () => ({ events: [ROW], next_cursor: null as string | null })) };

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
  const get = async (role: string, query = '', consumer_type = 'platform') =>
    request(app.getHttpServer()).get(`${PATH}${query}`).set('Authorization', `Bearer ${await tokenFor(role, consumer_type)}`);

  beforeAll(async () => {
    const keys = generateTestKeyPair();
    privatePem = keys.privatePem;
    for (const k of ['AUTH_AUDIENCE', 'AUTH_PUBLIC_KEY']) saved[k] = process.env[k];
    process.env['AUTH_AUDIENCE'] = audience;
    process.env['AUTH_PUBLIC_KEY'] = keys.publicPem;
    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule, AuthorizationModule],
      controllers: [PlatformCommercialAuditController],
      providers: [
        { provide: EFFECTIVE_AUTHORIZATION_RESOLVER, useValue: resolver },
        { provide: APP_FILTER, useClass: AramoExceptionFilter },
        { provide: CommercialAuditRepository, useValue: repo },
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

  beforeEach(() => repo.list.mockClear());

  it('CCP-R3 (CCP-A1 Amendment A1, FA-1 / FA-5) a CREDIT amount in an event (its chain basis) reaches an amount holder; a caller with the audit scope but without the amount scope gets the marker and no figure', async () => {
    const credit = { ...ROW, id: '019a0000-0000-7000-8000-0000000cc204', event_type: 'COMMERCIAL_CHANGE_REQUEST_CREATED', payload: { action_type: 'CREDIT', chain_basis: { amount_minor: 35000, currency: 'USD', escalates: false } } };
    repo.list.mockResolvedValue({ events: [credit], next_cursor: null });
    for (const role of ALLOWED) {
      const res = await get(role);
      expect(res.body.events[0].payload.chain_basis, role).toEqual({ amount_minor: 35000, currency: 'USD', escalates: false });
    }
    const res = await get('audit_without_amount');
    expect(res.status).toBe(200);
    expect(res.body.events[0].payload).toEqual({ action_type: 'CREDIT', chain_basis: { currency: 'USD', escalates: false, amount_withheld: 'FINANCE_SCOPE_REQUIRED' } });
    expect(JSON.stringify(res.body)).not.toContain('35000');
    repo.list.mockResolvedValue({ events: [ROW], next_cursor: null });
  });

  it('the matrix is the §4.1 one: exactly platform_owner, finance_admin and read_only_auditor hold the scope; super_admin holds no commercial scope', () => {
    expect(Object.keys(BUNDLES).filter((r) => r !== 'audit_without_amount' && BUNDLES[r]?.includes(SCOPE)).sort()).toEqual([...ALLOWED].sort());
    expect(BUNDLES['super_admin']?.some((s) => /^platform:(commercial|catalog|subscription|entitlement|billing|approval):/.test(s))).toBe(false);
  });

  for (const role of ALLOWED) {
    it(`allowed — ${role} → 200 with the page envelope`, async () => {
      const res = await get(role);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toEqual({ events: [{ ...ROW, created_at: '2026-10-24T00:00:00.000Z' }], next_cursor: null });
      expect(repo.list).toHaveBeenCalledTimes(1);
    });
  }

  for (const role of REFUSED) {
    it(`refused — ${role} → 403 INSUFFICIENT_PERMISSIONS (missing ${SCOPE}); the repository is never reached`, async () => {
      const res = await get(role);
      expect(res.status).toBe(403);
      expect(res.body?.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(res.body?.error?.details?.missing_scopes).toEqual([SCOPE]);
      expect(repo.list).not.toHaveBeenCalled();
    });
  }

  it('refused — no token → 401', async () => {
    const res = await request(app.getHttpServer()).get(PATH);
    expect(res.status).toBe(401);
    expect(repo.list).not.toHaveBeenCalled();
  });

  it('refused — a tenant-tier (recruiter) token for an allowed role → 403, never reaching the repository', async () => {
    const res = await get('platform_owner', '', 'recruiter');
    expect(res.status).toBe(403);
    expect(res.body?.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
    expect(repo.list).not.toHaveBeenCalled();
  });

  it('passes every filter through, typed (from/to as Date, exception_only as boolean)', async () => {
    const actor = '0190cccc-0000-7000-8000-00000000000a';
    const tenant = '0190dddd-0000-7000-8000-000000000001';
    const res = await get(
      'read_only_auditor',
      `?actor_id=${actor}&event_type=SUPPORT_EXTENSION_EXCEPTION_APPLIED&tenant_id=${tenant}&from=2026-10-01T00:00:00.000Z&to=2026-10-24T00:00:00.000Z&exception_only=true&limit=25&cursor=abc`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(repo.list).toHaveBeenCalledWith({
      actor_id: actor,
      event_type: 'SUPPORT_EXTENSION_EXCEPTION_APPLIED',
      tenant_id: tenant,
      from: new Date('2026-10-01T00:00:00.000Z'),
      to: new Date('2026-10-24T00:00:00.000Z'),
      exception_only: true,
      limit: 25,
      cursor: 'abc',
    });
  });

  const bad: Array<[string, string]> = [
    ['actor_id not a uuid', '?actor_id=nope'],
    ['tenant_id not a uuid', '?tenant_id=nope'],
    ['event_type lower-case', '?event_type=policy_activated'],
    ['from not ISO-8601', '?from=yesterday'],
    ['exception_only not a boolean literal', '?exception_only=yes'],
    ['limit above 200', '?limit=201'],
    ['limit 0', '?limit=0'],
    ['unknown parameter', '?status=ACTIVE'],
    ['from not earlier than to', '?from=2026-10-24T00:00:00.000Z&to=2026-10-24T00:00:00.000Z'],
  ];
  for (const [name, q] of bad) {
    it(`400 VALIDATION_ERROR — ${name}`, async () => {
      const res = await get('finance_admin', q);
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body?.error?.code).toBe('VALIDATION_ERROR');
      expect(repo.list).not.toHaveBeenCalled();
    });
  }

  it('400 VALIDATION_ERROR (invalid_cursor) when the repository refuses the cursor', async () => {
    repo.list.mockRejectedValueOnce(new CommercialAuditCursorError('cursor filters do not match the current query'));
    const res = await get('finance_admin', '?cursor=stale');
    expect(res.status).toBe(400);
    expect(res.body?.error?.code).toBe('VALIDATION_ERROR');
    expect(res.body?.error?.details?.reason).toBe('invalid_cursor');
  });
});
