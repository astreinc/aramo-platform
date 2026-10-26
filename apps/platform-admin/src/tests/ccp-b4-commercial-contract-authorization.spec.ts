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
import { ContractRepository } from '@aramo/subscription';

import { PlatformCommercialContractController } from '../app/platform/platform-commercial-contract.controller.js';

import { generateTestKeyPair } from './test-keys.js';

// CCP-B4 (PBD §5.3 row B4 + the B-row common mandatory test "the backend refusal for an
// ineligible role") — GET /platform/commercial/contracts and /contracts/{id} under
// platform:subscription:read, for each of the 6 CCP platform roles and super_admin, one role per
// principal, through the REAL request chain (signed platform token → JwtAuthGuard → RolesGuard →
// the consumer_type tripwire → AramoExceptionFilter).
//
// Expected (CCP A1 §4.1): allowed — platform_owner, finance_admin, commercial_ops,
// support_admin, read_only_auditor; refused — catalog_manager (no subscription:read, TD-B4-3)
// and super_admin (no commercial scope, INV-1; PBD §12).

const SCOPE = 'platform:subscription:read';
const AUDIT = 'platform:commercial:audit:read';
const ENTRY = 'platform:tenant:read';
// CCP-R3-W (W-2): the Finance amount scope's 3 holders (CCP-A1 Amendment A1 FA-2) read the terms.
const AMOUNT = 'platform:billing:amount:read';
const BUNDLES: Record<string, readonly string[]> = {
  platform_owner: [ENTRY, 'platform:catalog:read', 'platform:catalog:approve', 'platform:catalog:publish', SCOPE, 'platform:subscription:approve', 'platform:entitlement:approve', 'platform:billing:read', 'platform:billing:approve', 'platform:approval:read', AUDIT, AMOUNT],
  finance_admin: [ENTRY, 'platform:catalog:read', 'platform:catalog:approve', SCOPE, 'platform:subscription:approve', 'platform:entitlement:approve', 'platform:billing:read', 'platform:billing:approve', 'platform:approval:read', AUDIT, AMOUNT],
  commercial_ops: [ENTRY, 'platform:catalog:read', SCOPE, 'platform:subscription:request', 'platform:entitlement:request', 'platform:billing:read', 'platform:billing:request', 'platform:approval:read'],
  catalog_manager: [ENTRY, 'platform:catalog:read', 'platform:catalog:draft', 'platform:approval:read'],
  support_admin: [ENTRY, 'platform:catalog:read', SCOPE, 'platform:subscription:support', 'platform:billing:read', 'platform:approval:read'],
  read_only_auditor: [ENTRY, 'platform:catalog:read', SCOPE, 'platform:billing:read', 'platform:approval:read', AUDIT, AMOUNT],
  super_admin: ['platform:tenant:provision', ENTRY, 'platform:admin:invite', 'platform:tenant:lifecycle:manage', 'platform:skill:read', 'platform:skill:manage', 'platform:document_template:read', 'platform:document_template:manage', 'platform:matching_policy:read', 'platform:matching_policy:write'],
};
const ALLOWED = ['platform_owner', 'finance_admin', 'commercial_ops', 'support_admin', 'read_only_auditor'] as const;
const REFUSED = ['catalog_manager', 'super_admin'] as const;
const PATH = '/platform/commercial/contracts';
const CONTRACT_ID = '019a0000-0000-7000-8000-0000000b4c01';

class RoleBundleResolver implements EffectiveAuthorizationResolver {
  readonly roleOf = new Map<string, string>();
  async resolve(input: EffectiveAuthorizationInput): Promise<EffectiveAuthorizationResolution> {
    const role = this.roleOf.get(input.principal_id);
    const scopes = role === undefined ? [] : [...(BUNDLES[role] ?? [])];
    return { status: 'ok', scopes: filterScopesForConsumer({ consumer: input.consumer_type, scopes, tenantHasEsign: false }) };
  }
}

const PERSON = { user_id: '0190cccc-0000-7000-8000-00000000000a', display_name: 'Tomás Silva', email: 'tomas.silva@aramo.ai' };
const SUMMARY = {
  id: CONTRACT_ID,
  contract_ref: 'CT-2026-021',
  tenant: { id: '0190dddd-0000-7000-8000-000000000001', name: 'Atlas Freight', slug: 'atlas-freight' },
  product_key: 'sign',
  status: 'ACTIVE' as const,
  subscription: {
    id: '0190dddd-0000-7000-8000-0000000000b1',
    source: 'MANUAL',
    status: 'ACTIVE',
    ended_at: null,
    commitment_start: new Date('2026-05-01T00:00:00.000Z'),
    commitment_end: new Date('2027-04-30T00:00:00.000Z'),
    plan: { key: 'aramo-sign-standard-business-v1', name: 'Business' },
    plan_version: { id: '0190dddd-0000-7000-8000-0000000000c1', version_number: 2, status: 'PUBLISHED' },
  },
  provenance: 'CHANGE_REQUEST' as const,
  recorded_at: new Date('2026-04-28T00:00:00.000Z'),
};
const DETAIL = {
  ...SUMMARY,
  terms: ['Invoiced monthly, net 30'],
  recorded_terms: ['Invoiced monthly, net 30'],
  evidence_ref: 'OF-8034',
  recorded_by: PERSON,
  recorded_by_change_request_id: '019a0000-0000-7000-8000-0000000b4c02',
  documents: [{ name: 'Order form OF-8034.pdf', sha256: '0'.repeat(64), recorded_by: PERSON, recorded_at: new Date('2026-04-28T00:00:00.000Z'), amendment_sequence: null }],
  amendments: [],
  invoicing: { enabled: false as const, reason: 'enterprise_invoicing_choice_pending' as const },
};

describe('CCP-B4 — per-role authorization on the contract read routes (real JwtAuthGuard + RolesGuard)', () => {
  let app: INestApplication;
  let privatePem: string;
  const audience = 'aramo-platform-ccp-b4-test';
  const saved: Record<string, string | undefined> = {};
  const resolver = new RoleBundleResolver();
  const principal = new Map<string, string>();
  const repo = { list: vi.fn(async () => [SUMMARY]), get: vi.fn(async (id: string) => (id === CONTRACT_ID ? DETAIL : null)) };

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
  const get = async (role: string, path = PATH, consumer_type = 'platform') =>
    request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${await tokenFor(role, consumer_type)}`);

  beforeAll(async () => {
    const keys = generateTestKeyPair();
    privatePem = keys.privatePem;
    for (const k of ['AUTH_AUDIENCE', 'AUTH_PUBLIC_KEY']) saved[k] = process.env[k];
    process.env['AUTH_AUDIENCE'] = audience;
    process.env['AUTH_PUBLIC_KEY'] = keys.publicPem;
    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule, AuthorizationModule],
      controllers: [PlatformCommercialContractController],
      providers: [
        { provide: EFFECTIVE_AUTHORIZATION_RESOLVER, useValue: resolver },
        { provide: APP_FILTER, useClass: AramoExceptionFilter },
        { provide: ContractRepository, useValue: repo },
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

  beforeEach(() => {
    repo.list.mockClear();
    repo.get.mockClear();
  });

  it('the matrix is the §4.1 one: exactly the five roles hold platform:subscription:read; catalog_manager and super_admin do not', () => {
    expect(Object.keys(BUNDLES).filter((r) => BUNDLES[r]?.includes(SCOPE)).sort()).toEqual([...ALLOWED].sort());
    expect(BUNDLES['super_admin']?.some((s) => /^platform:(commercial|catalog|subscription|entitlement|billing|approval):/.test(s))).toBe(false);
  });

  for (const role of ALLOWED) {
    it(`allowed — ${role} → 200 on list and detail`, async () => {
      const list = await get(role);
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      expect(list.body.contracts[0]).toMatchObject({ id: CONTRACT_ID, contract_ref: 'CT-2026-021', status: 'ACTIVE', subscription: { commitment_end: '2027-04-30T00:00:00.000Z' } });
      const one = await get(role, `${PATH}/${CONTRACT_ID}`);
      expect(one.status, JSON.stringify(one.body)).toBe(200);
      expect(one.body).toMatchObject({ id: CONTRACT_ID, invoicing: { enabled: false, reason: 'enterprise_invoicing_choice_pending' }, documents: [{ sha256: '0'.repeat(64), byte_size: null, media_type: null, recorded_at: '2026-04-28T00:00:00.000Z' }] });
      // CCP-R3-W (W-2): the free-text terms only with platform:billing:amount:read.
      if (BUNDLES[role]?.includes(AMOUNT)) {
        expect(one.body.terms).toEqual(['Invoiced monthly, net 30']);
        expect(one.body.recorded_terms).toEqual(['Invoiced monthly, net 30']);
        expect(one.body).not.toHaveProperty('terms_withheld');
      } else {
        expect(one.body).not.toHaveProperty('terms');
        expect(one.body).not.toHaveProperty('recorded_terms');
        expect(one.body.terms_withheld).toBe('FINANCE_SCOPE_REQUIRED');
      }
    });
  }

  for (const role of REFUSED) {
    it(`refused — ${role} → 403 INSUFFICIENT_PERMISSIONS (missing ${SCOPE}) on both routes; the repository is never reached`, async () => {
      for (const path of [PATH, `${PATH}/${CONTRACT_ID}`]) {
        const res = await get(role, path);
        expect(res.status).toBe(403);
        expect(res.body?.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
        expect(res.body?.error?.details?.missing_scopes).toEqual([SCOPE]);
      }
      expect(repo.list).not.toHaveBeenCalled();
      expect(repo.get).not.toHaveBeenCalled();
    });
  }

  it('refused — no token → 401', async () => {
    expect((await request(app.getHttpServer()).get(PATH)).status).toBe(401);
    expect(repo.list).not.toHaveBeenCalled();
  });

  it('refused — a tenant-tier token for an allowed role → 403, never reaching the repository', async () => {
    const res = await get('commercial_ops', PATH, 'recruiter');
    expect(res.status).toBe(403);
    expect(repo.list).not.toHaveBeenCalled();
  });

  it('404 NOT_FOUND for an unknown contract; 400 for a malformed id or query', async () => {
    const res = await get('finance_admin', `${PATH}/019a0000-0000-7000-8000-0000000b4cff`);
    expect(res.status).toBe(404);
    expect(res.body?.error?.code).toBe('NOT_FOUND');
    for (const path of [`${PATH}/nope`, `${PATH}?status=OPEN`, `${PATH}?limit=0`, `${PATH}?tenant_id=x`, `${PATH}?plan_key=a`]) {
      const bad = await get('finance_admin', path);
      expect(bad.status, path).toBe(400);
      expect(bad.body?.error?.code).toBe('VALIDATION_ERROR');
    }
  });

  it('passes the filters through typed', async () => {
    const tenant = '0190dddd-0000-7000-8000-000000000001';
    expect((await get('read_only_auditor', `${PATH}?tenant_id=${tenant}&status=ENDED&limit=25`)).status).toBe(200);
    expect(repo.list).toHaveBeenCalledWith({ tenant_id: tenant, status: 'ENDED', limit: 25 });
  });

  it('the routes are read-only: the controller declares no write handler', () => {
    const proto = PlatformCommercialContractController.prototype as unknown as Record<string, unknown>;
    const handlers = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor');
    expect(handlers.sort()).toEqual(['get', 'list']);
  });
});
