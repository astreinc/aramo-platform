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
import { ContractPaymentReadService, type ContractPaymentsView } from '@aramo/subscription';

import { PlatformCommercialContractPaymentsController } from '../app/platform/platform-commercial-contract-payments.controller.js';

import { generateTestKeyPair } from './test-keys.js';

// CCP-C8-PR (PAYMENT_RECORD amendment PR-10, PR-11; CCP-A1 Amendment A1 FA-1 / FA-4 / FA-5) —
// GET /platform/commercial/contracts/{id}/payments for each of the 6 CCP platform roles and super_admin,
// one role per principal, through the REAL request chain (signed platform token → JwtAuthGuard →
// RolesGuard → the consumer_type tripwire → AramoExceptionFilter).
//
// Expected: gate platform:billing:read — allowed platform_owner, finance_admin, commercial_ops,
// support_admin, read_only_auditor; refused catalog_manager and super_admin. Amount scope: the amounts,
// payment terms and records only to platform:billing:amount:read holders (platform_owner, finance_admin,
// read_only_auditor); commercial_ops and support_admin get the statuses and the two booleans only.

const ENTRY = 'platform:tenant:read';
const AMOUNT_SCOPE = 'platform:billing:amount:read';
const BUNDLES: Record<string, readonly string[]> = {
  platform_owner: [ENTRY, 'platform:catalog:read', 'platform:catalog:approve', 'platform:catalog:publish', 'platform:subscription:read', 'platform:subscription:approve', 'platform:entitlement:approve', 'platform:billing:read', 'platform:billing:approve', 'platform:approval:read', 'platform:commercial:audit:read', AMOUNT_SCOPE],
  finance_admin: [ENTRY, 'platform:catalog:read', 'platform:catalog:approve', 'platform:subscription:read', 'platform:subscription:approve', 'platform:entitlement:approve', 'platform:billing:read', 'platform:billing:approve', 'platform:approval:read', 'platform:commercial:audit:read', AMOUNT_SCOPE, 'platform:payment:request'],
  commercial_ops: [ENTRY, 'platform:catalog:read', 'platform:subscription:read', 'platform:subscription:request', 'platform:entitlement:request', 'platform:billing:read', 'platform:billing:request', 'platform:approval:read', 'platform:payment:request'],
  catalog_manager: [ENTRY, 'platform:catalog:read', 'platform:catalog:draft', 'platform:approval:read'],
  support_admin: [ENTRY, 'platform:catalog:read', 'platform:subscription:read', 'platform:subscription:support', 'platform:billing:read', 'platform:approval:read'],
  read_only_auditor: [ENTRY, 'platform:catalog:read', 'platform:subscription:read', 'platform:billing:read', 'platform:approval:read', 'platform:commercial:audit:read', AMOUNT_SCOPE],
  super_admin: ['platform:tenant:provision', ENTRY, 'platform:admin:invite', 'platform:tenant:lifecycle:manage', 'platform:skill:read', 'platform:skill:manage', 'platform:document_template:read', 'platform:document_template:manage', 'platform:matching_policy:read', 'platform:matching_policy:write'],
};
const HOLDERS = ['platform_owner', 'finance_admin', 'read_only_auditor'] as const;
const NON_HOLDERS = ['commercial_ops', 'support_admin'] as const;
const REFUSED = ['catalog_manager', 'super_admin'] as const;
const CONTRACT_ID = '019a0000-0000-7000-8000-0000000c8a01';
const PATH = `/platform/commercial/contracts/${CONTRACT_ID}/payments`;

class RoleBundleResolver implements EffectiveAuthorizationResolver {
  readonly roleOf = new Map<string, string>();
  async resolve(input: EffectiveAuthorizationInput): Promise<EffectiveAuthorizationResolution> {
    const role = this.roleOf.get(input.principal_id);
    const scopes = role === undefined ? [] : [...(BUNDLES[role] ?? [])];
    return { status: 'ok', scopes: filterScopesForConsumer({ consumer: input.consumer_type, scopes, tenantHasEsign: false }) };
  }
}

const VIEW: ContractPaymentsView = {
  contract_id: CONTRACT_ID,
  contract_ref: 'CT-2026-501',
  tenant_id: '0190dddd-0000-7000-8000-000000000001',
  product_key: 'sign',
  payment_terms: { billing_mode: 'PREPAID', currency: 'USD', timezone: 'America/New_York', grace_days: null, effective_grace_days: 0, postpaid_approval: null },
  as_of: new Date('2026-10-26T12:00:00.000Z'),
  as_of_date: '2026-10-26',
  payment_due: true,
  payment_overdue: true,
  obligations: [
    { obligation_ref: 'INITIAL', due_date: '2026-10-01', description: 'Year 1 prepaid fee', amount_minor: 1_234_567, currency: 'USD', status: 'PAID', effective_receipt_id: '019a0000-0000-7000-8000-0000000c8a02' },
    { obligation_ref: 'Q4', due_date: '2026-10-25', description: 'Q4 fee', amount_minor: 76_543, currency: 'USD', status: 'PAST_DUE', effective_receipt_id: null },
  ],
  records: [
    {
      id: '019a0000-0000-7000-8000-0000000c8a02',
      change_request_id: '019a0000-0000-7000-8000-0000000c8a03',
      entry_kind: 'RECORD',
      corrects_receipt_id: null,
      obligation_ref: 'INITIAL',
      external_invoice_ref: 'INV-2026-0042',
      amount_minor: 1_234_567,
      currency: 'USD',
      received_on: '2026-09-30',
      payment_method: 'BANK_TRANSFER',
      payment_reference: 'WIRE-88231',
      verification: 'Matched on the bank statement',
      evidence_documents: [{ name: 'Remittance.pdf', sha256: 'a'.repeat(64) }],
      origin: 'MANUAL',
      recorded_by: '0190cccc-0000-7000-8000-00000000000a',
      recorded_at: new Date('2026-09-30T15:00:00.000Z'),
      linked_at: new Date('2026-10-01T09:00:00.000Z'),
      corrected_at: null,
      corrected_by_change_request_id: null,
      effective: true,
    },
  ],
};

describe('CCP-C8-PR — per-role authorization and amount scope on GET /platform/commercial/contracts/{id}/payments (real JwtAuthGuard + RolesGuard)', () => {
  let app: INestApplication;
  let privatePem: string;
  const audience = 'aramo-platform-ccp-c8pr-test';
  const saved: Record<string, string | undefined> = {};
  const resolver = new RoleBundleResolver();
  const principal = new Map<string, string>();
  const reads = { contractPayments: vi.fn(async (id: string) => (id === CONTRACT_ID ? VIEW : null)) };

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
      controllers: [PlatformCommercialContractPaymentsController],
      providers: [
        { provide: EFFECTIVE_AUTHORIZATION_RESOLVER, useValue: resolver },
        { provide: APP_FILTER, useClass: AramoExceptionFilter },
        { provide: ContractPaymentReadService, useValue: reads },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use((req: never, res: never, next: () => void) => new RequestIdMiddleware().use(req, res, next));
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    // Merge train TD-MERGE-41: one bound loopback port for the file.
    await app.listen(0, '127.0.0.1');
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(() => reads.contractPayments.mockClear());

  for (const role of HOLDERS) {
    it(`C8PR-RT-1 ${role} (billing:read + amount:read) → 200 with amounts, payment terms and records`, async () => {
      const r = await get(role);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toMatchObject({ contract_id: CONTRACT_ID, as_of_date: '2026-10-26', payment_due: true, payment_overdue: true, payment_terms: { billing_mode: 'PREPAID', timezone: 'America/New_York', effective_grace_days: 0 } });
      expect(r.body.obligations).toEqual([
        { obligation_ref: 'INITIAL', due_date: '2026-10-01', status: 'PAID', description: 'Year 1 prepaid fee', amount_minor: 1_234_567, currency: 'USD', effective_receipt_id: '019a0000-0000-7000-8000-0000000c8a02' },
        { obligation_ref: 'Q4', due_date: '2026-10-25', status: 'PAST_DUE', description: 'Q4 fee', amount_minor: 76_543, currency: 'USD', effective_receipt_id: null },
      ]);
      expect(r.body.records[0]).toMatchObject({ amount_minor: 1_234_567, payment_reference: 'WIRE-88231', recorded_at: '2026-09-30T15:00:00.000Z', linked_at: '2026-10-01T09:00:00.000Z', effective: true });
      expect(r.body.amount_withheld).toBeUndefined();
    });
  }

  for (const role of NON_HOLDERS) {
    it(`C8PR-RT-2 ${role} (billing:read only) → 200 with the statuses and the two booleans only (FA-4); no amount, term or record anywhere in the body`, async () => {
      const r = await get(role);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toEqual({
        contract_id: CONTRACT_ID,
        contract_ref: 'CT-2026-501',
        as_of: '2026-10-26T12:00:00.000Z',
        as_of_date: '2026-10-26',
        payment_due: true,
        payment_overdue: true,
        obligations: [
          { obligation_ref: 'INITIAL', due_date: '2026-10-01', status: 'PAID' },
          { obligation_ref: 'Q4', due_date: '2026-10-25', status: 'PAST_DUE' },
        ],
        amount_withheld: 'FINANCE_SCOPE_REQUIRED',
      });
      expect(JSON.stringify(r.body)).not.toMatch(/1234567|76543|WIRE-88231|INV-2026-0042|bank statement|PREPAID/);
    });
  }

  for (const role of REFUSED) {
    it(`C8PR-RT-3 ${role} → 403 INSUFFICIENT_PERMISSIONS, the read is never made`, async () => {
      const r = await get(role);
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(reads.contractPayments).not.toHaveBeenCalled();
    });
  }

  it('C8PR-RT-4 404 NOT_FOUND for an unknown contract; 400 for a malformed id; 401 without a token', async () => {
    const unknown = await get('finance_admin', '/platform/commercial/contracts/019a0000-0000-7000-8000-0000000c8aff/payments');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('NOT_FOUND');
    expect((await get('finance_admin', '/platform/commercial/contracts/not-a-uuid/payments')).status).toBe(400);
    expect((await request(app.getHttpServer()).get(PATH)).status).toBe(401);
  });

  it('C8PR-RT-5 the matrix: billing:read gates the route; amount:read is held by exactly the three holders; platform:payment:request by exactly commercial_ops and finance_admin (CCP-A1 Amendment A2 PS-2)', () => {
    expect(Object.keys(BUNDLES).filter((r) => BUNDLES[r]?.includes('platform:billing:read')).sort()).toEqual([...HOLDERS, ...NON_HOLDERS].sort());
    expect(Object.keys(BUNDLES).filter((r) => BUNDLES[r]?.includes(AMOUNT_SCOPE)).sort()).toEqual([...HOLDERS].sort());
    expect(Object.keys(BUNDLES).filter((r) => BUNDLES[r]?.includes('platform:payment:request')).sort()).toEqual(['commercial_ops', 'finance_admin']);
  });
});
