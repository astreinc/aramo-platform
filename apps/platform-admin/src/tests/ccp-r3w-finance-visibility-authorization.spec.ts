import 'reflect-metadata';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { APP_FILTER } from '@nestjs/core';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { SignJWT, importPKCS8 } from 'jose';
import request from 'supertest';
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
  BillingAdjustmentRefusedError,
  BillingCommandService,
  BillingWebhookInboxService,
  CommercialAuditRepository,
  CommercialBillingAdjustmentService,
  CommercialChangeRequestError,
  CommercialChangeRequestService,
  CommercialRefundReportService,
  ContractRepository,
} from '@aramo/subscription';

import { PlatformCommercialAuditController } from '../app/platform/platform-commercial-audit.controller.js';
import { PlatformCommercialBillingAdjustmentController } from '../app/platform/platform-commercial-billing-adjustment.controller.js';
import { PlatformCommercialBillingController } from '../app/platform/platform-commercial-billing.controller.js';
import { PlatformCommercialChangeRequestController } from '../app/platform/platform-commercial-change-request.controller.js';
import { PlatformCommercialContractController } from '../app/platform/platform-commercial-contract.controller.js';
import { PlatformCommercialRefundReportController } from '../app/platform/platform-commercial-refund-report.controller.js';

import { generateTestKeyPair } from './test-keys.js';

// CCP-R3-W — Architect rulings W-2 / W-3 (CCP-UI v1.2 Finance visibility, 2026-10-25) and the
// TD-MERGE-43 residual, per role, through the REAL request chain (signed platform token → real
// JwtAuthGuard → real RolesGuard → consumer tripwire → AramoExceptionFilter), services mocked.
// Roles: the 6 CCP roles + super_admin, plus a SECOND commercial_ops (a non-requester of the same
// role) and a synthetic audit-only principal (audit scope without the amount scope; not a catalog
// role) so the audit feed's non-holder branch is exercised.
// Holders of platform:billing:amount:read (CCP-A1 Amendment A1 FA-2): platform_owner,
// finance_admin, read_only_auditor.

const ENTRY = 'platform:tenant:read';
const AMOUNT = 'platform:billing:amount:read';
const AUDIT = 'platform:commercial:audit:read';
const BUNDLES: Record<string, readonly string[]> = {
  platform_owner: [ENTRY, 'platform:catalog:read', 'platform:catalog:approve', 'platform:catalog:publish', 'platform:subscription:read', 'platform:subscription:approve', 'platform:entitlement:approve', 'platform:billing:read', 'platform:billing:approve', 'platform:approval:read', AUDIT, AMOUNT],
  finance_admin: [ENTRY, 'platform:catalog:read', 'platform:catalog:approve', 'platform:subscription:read', 'platform:subscription:approve', 'platform:entitlement:approve', 'platform:billing:read', 'platform:billing:approve', 'platform:approval:read', AUDIT, AMOUNT],
  commercial_ops: [ENTRY, 'platform:catalog:read', 'platform:subscription:read', 'platform:subscription:request', 'platform:entitlement:request', 'platform:billing:read', 'platform:billing:request', 'platform:approval:read'],
  catalog_manager: [ENTRY, 'platform:catalog:read', 'platform:catalog:draft', 'platform:approval:read'],
  support_admin: [ENTRY, 'platform:catalog:read', 'platform:subscription:read', 'platform:subscription:support', 'platform:billing:read', 'platform:approval:read'],
  read_only_auditor: [ENTRY, 'platform:catalog:read', 'platform:subscription:read', 'platform:billing:read', 'platform:approval:read', AUDIT, AMOUNT],
  super_admin: ['platform:tenant:provision', ENTRY, 'platform:admin:invite', 'platform:tenant:lifecycle:manage', 'platform:skill:read', 'platform:skill:manage', 'platform:document_template:read', 'platform:document_template:manage', 'platform:matching_policy:read', 'platform:matching_policy:write'],
  audit_only: [ENTRY, 'platform:billing:read', 'platform:approval:read', AUDIT],
};
const HOLDERS = ['platform_owner', 'finance_admin', 'read_only_auditor'] as const;
const CCP_ROLES = ['platform_owner', 'finance_admin', 'commercial_ops', 'catalog_manager', 'support_admin', 'read_only_auditor'] as const;
// principal name → role bundle (commercial_ops_2 is a second commercial_ops user)
const PRINCIPALS: Record<string, { role: string; sub: string }> = {
  platform_owner: { role: 'platform_owner', sub: '019a0000-0000-7000-8000-0000000e3001' },
  finance_admin: { role: 'finance_admin', sub: '019a0000-0000-7000-8000-0000000e3002' },
  commercial_ops: { role: 'commercial_ops', sub: '019a0000-0000-7000-8000-0000000e3003' },
  commercial_ops_2: { role: 'commercial_ops', sub: '019a0000-0000-7000-8000-0000000e3013' },
  catalog_manager: { role: 'catalog_manager', sub: '019a0000-0000-7000-8000-0000000e3004' },
  support_admin: { role: 'support_admin', sub: '019a0000-0000-7000-8000-0000000e3005' },
  read_only_auditor: { role: 'read_only_auditor', sub: '019a0000-0000-7000-8000-0000000e3006' },
  super_admin: { role: 'super_admin', sub: '019a0000-0000-7000-8000-0000000e3007' },
  audit_only: { role: 'audit_only', sub: '019a0000-0000-7000-8000-0000000e3008' },
};
const REQUESTER = PRINCIPALS['commercial_ops']!.sub;
const isHolder = (p: string): boolean => (HOLDERS as readonly string[]).includes(PRINCIPALS[p]!.role);

class RoleBundleResolver implements EffectiveAuthorizationResolver {
  async resolve(input: EffectiveAuthorizationInput): Promise<EffectiveAuthorizationResolution> {
    const p = Object.values(PRINCIPALS).find((x) => x.sub === input.principal_id);
    const scopes = p === undefined ? [] : [...(BUNDLES[p.role] ?? [])];
    return { status: 'ok', scopes: filterScopesForConsumer({ consumer: input.consumer_type, scopes, tenantHasEsign: false }) };
  }
}

const W = 'FINANCE_SCOPE_REQUIRED';
const NOW = new Date('2026-10-25T00:00:00.000Z');
const CR_ID = '019a0000-0000-7000-8000-0000000e3a01';
const REASON = 'Goodwill credit for a service outage';
const REJECTION = 'Credit not justified by the account history';
const COMMENT = 'Within the credit policy';
const EVIDENCE = 'Charged twice for the October period';
const PROVIDER_TEXT = 'No such payment_intent: pi_3Pq9 (Stripe 404)';
const TERMS = ['Invoiced monthly, net 30', '15% negotiated reduction for 24 months'];

function row(action_type: string, payload: Record<string, unknown>, basis: Record<string, unknown> = {}) {
  return {
    id: CR_ID,
    action_type,
    kind: 'NORMAL',
    state: 'REJECTED',
    tenant_id: '0190dddd-0000-7000-8000-0000000000a1',
    product_key: 'sign',
    payload,
    payload_checksum: 'a'.repeat(64),
    required_chain: { format_version: 1, rule: 'FINANCE_ONLY', basis, steps: [{ step_index: 0, role_key: 'finance_admin', scope_keys: ['platform:billing:approve'] }] },
    policy_version_id: '019a0000-0000-7000-8000-0000000cc201',
    policy_checksum: 'b'.repeat(64),
    requested_by: REQUESTER,
    reason: REASON,
    idempotency_key: 'k-r3w-0001',
    created_at: NOW,
    submitted_at: NOW,
    expires_at: NOW,
    approved_at: null,
    rejected_at: NOW,
    rejected_by: PRINCIPALS['finance_admin']!.sub,
    rejection_reason: REJECTION,
    withdrawn_at: null,
    expired_at: null,
    apply_attempts: 0,
    applied_at: null,
    updated_at: NOW,
  };
}
const CREDIT = row('CREDIT', { amount_minor: 35000, currency: 'USD' }, { amount_minor: 35000, credit_escalation_threshold_minor: 50000, escalates: false });
const REFUND = row('REFUND', { amount_minor: 4321, currency: 'USD', provider_invoice_ref: 'in_abc123', provider_payment_ref: 'pi_abc123', category: 'R1_DUPLICATE', basis: EVIDENCE, refund_policy_ref: 'refund-policy@1.0' }, { amount_minor: 4321, currency: 'USD' });
const SUB_OPEN = row('SUBSCRIPTION_OPEN', { plan_version_id: '0190dddd-0000-7000-8000-0000000000c1', contract: { contract_ref: 'CT-2026-021', terms: TERMS, documents: [] } });
const SUPPORT = row('SUPPORT_EXTENSION', { operation: 'EXTEND', subscription_id: '0190dddd-0000-7000-8000-0000000000b1', requested_days: 7 });
const APPROVAL = { id: '019a0000-0000-7000-8000-0000000e3a02', change_request_id: CR_ID, step_index: 0, approver_user_id: PRINCIPALS['finance_admin']!.sub, step_role_key: 'finance_admin', step_scope_keys: ['platform:billing:approve'], approver_role_keys: ['finance_admin'], attestation_id: 'att', comment: COMMENT, created_at: NOW };
const view = (r: ReturnType<typeof row>) => ({ request: r, approvals: [APPROVAL], chain: r.required_chain, is_expired: false, chain_satisfiable: true, apply_actionable: false, steps: [{ step_index: 0, role_key: 'finance_admin', scope_keys: ['platform:billing:approve'], status: 'APPROVED', approval: APPROVAL, caller: { eligible: false, refusal: null } }] });

const crSvc = {
  current: CREDIT as ReturnType<typeof row>,
  create: vi.fn(async () => ({ request: crSvc.current, replayed: false })),
  list: vi.fn(async () => ({ requests: [crSvc.current], next_cursor: null as string | null })),
  get: vi.fn(async () => view(crSvc.current)),
  submit: vi.fn(async () => crSvc.current),
  withdraw: vi.fn(async () => crSvc.current),
  approve: vi.fn(async () => ({ request: crSvc.current, approval: APPROVAL })),
  reject: vi.fn(async () => crSvc.current),
};

const PERSON = { user_id: '0190cccc-0000-7000-8000-00000000000a', display_name: 'Tomás Silva', email: 'tomas.silva@aramo.ai' };
const CONTRACT_ID = '019a0000-0000-7000-8000-0000000e3c01';
const SUMMARY = {
  id: CONTRACT_ID,
  contract_ref: 'CT-2026-021',
  tenant: { id: '0190dddd-0000-7000-8000-000000000001', name: 'Atlas Freight', slug: 'atlas-freight' },
  product_key: 'sign',
  status: 'ACTIVE' as const,
  subscription: { id: '0190dddd-0000-7000-8000-0000000000b1', source: 'MANUAL', status: 'ACTIVE', ended_at: null, commitment_start: NOW, commitment_end: NOW, plan: { key: 'k', name: 'Business' }, plan_version: { id: '0190dddd-0000-7000-8000-0000000000c1', version_number: 2, status: 'PUBLISHED' } },
  provenance: 'CHANGE_REQUEST' as const,
  recorded_at: NOW,
};
const DETAIL = {
  ...SUMMARY,
  terms: TERMS,
  recorded_terms: [TERMS[0]],
  evidence_ref: 'OF-8034',
  recorded_by: PERSON,
  recorded_by_change_request_id: CR_ID,
  documents: [],
  amendments: [
    { sequence: 1, kind: 'AMENDMENT', summary: 'Seat change', terms: TERMS, documents: [], evidence_ref: null, change_request_id: CR_ID, recorded_by: PERSON, recorded_at: NOW },
    { sequence: 2, kind: 'AMENDMENT', summary: 'Contact change', terms: null, documents: [], evidence_ref: null, change_request_id: CR_ID, recorded_by: PERSON, recorded_at: NOW },
  ],
  invoicing: { enabled: false as const, reason: 'enterprise_invoicing_choice_pending' as const },
};
const contracts = { list: vi.fn(async () => [SUMMARY]), get: vi.fn(async () => DETAIL) };

const command = (kind: string) => ({
  id: `019a0000-0000-7000-8000-0000000e3d0${kind === 'REFUND_CREATE' ? 1 : 2}`,
  provider: 'STRIPE',
  command_kind: kind,
  change_request_id: CR_ID,
  self_service_request_id: null,
  step: kind.toLowerCase(),
  idempotency_key: `aramo-ccp-${CR_ID}-${kind.toLowerCase()}`,
  tenant_id: '0190dddd-0000-7000-8000-0000000000a1',
  product_key: 'sign',
  target_ref: 'sub_1',
  params: kind === 'REFUND_CREATE' ? { amount_minor: 4321, currency: 'USD' } : { mode: 'IMMEDIATE' },
  state: 'FAILED',
  attempts: 3,
  lease_until: null,
  next_attempt_at: null,
  last_error_code: 'PROVIDER_REJECTED',
  last_error_detail: PROVIDER_TEXT,
  provider_accepted_at: null,
  confirmed_at: null,
  confirmation_source: null,
  confirmation_event_id: null,
  failed_at: NOW,
  provider_object_ref: null,
  created_by: REQUESTER,
  created_at: NOW,
  updated_at: NOW,
});
const adjSvc = {
  apply: vi.fn(),
  resolveRefund: vi.fn(),
  view: vi.fn(async () => ({ request: REFUND, operation: 'REFUND_CREATE', status: 'FAILED', pending_provider: true, refund_execution_disabled: true, commands: [command('REFUND_CREATE')], adjustment: null })),
};
const commandsSvc = { list: vi.fn(async () => ({ commands: [command('REFUND_CREATE'), command('SUBSCRIPTION_CANCEL')], next_cursor: null })) };
const refundRow = (requested_by: string) => ({ change_request_id: CR_ID, tenant_id: '0190dddd-0000-7000-8000-0000000000a1', product_key: 'sign', request_state: 'APPROVED', refund_state: 'approved', reconciliation_status: 'NOT_SENT', category: 'R1_DUPLICATE', provider_invoice_ref: 'in_abc123', provider_payment_ref: 'pi_abc123', provider_refund_ref: null, currency: 'USD', amount_minor: 4321, effective_at: null, accounting_period: null, requested_by, created_at: NOW, applied_at: null });
const refunds = { list: vi.fn(async () => ({ refunds: [refundRow(REQUESTER), refundRow(PRINCIPALS['commercial_ops_2']!.sub)], next_cursor: null })) };
const auditEvent = (payload: Record<string, unknown>, event_type: string) => ({ id: '019a0000-0000-7000-8000-0000000e3e01', actor_id: REQUESTER, actor_type: 'user', actor_role_keys: ['commercial_ops'], event_type, is_exception: false, tenant_id: null, subject: 's', change_request_id: CR_ID, policy_version_id: '019a0000-0000-7000-8000-0000000cc201', payload, correlation_id: 'c', created_at: NOW });
const audit = {
  list: vi.fn(async () => ({
    events: [
      auditEvent({ action_type: 'CREDIT', reason: REASON, amount_minor: 35000 }, 'COMMERCIAL_CHANGE_REQUEST_APPLIED'),
      auditEvent({ action_type: 'CREDIT', step_index: 0, reason: REJECTION }, 'COMMERCIAL_CHANGE_REQUEST_REJECTED'),
      auditEvent({ action_type: 'REFUND', refusal: 'REFUND_REMAINDER_UNVERIFIABLE', detail: { basis: 'provider_read_failed', error: PROVIDER_TEXT } }, 'COMMERCIAL_CHANGE_REQUEST_APPLY_REFUSED'),
      auditEvent({ action_type: 'SUBSCRIPTION_OPEN', contract: { contract_ref: 'CT-1', terms: TERMS } }, 'COMMERCIAL_CHANGE_REQUEST_APPLIED'),
    ],
    next_cursor: null,
  })),
};

const SECRETS = [REASON, REJECTION, COMMENT, EVIDENCE, PROVIDER_TEXT, TERMS[1] as string, '"amount_minor"'];

describe('CCP-R3-W — Finance visibility per role (W-2 contract terms, W-3 financial request text, item 3 provider text)', () => {
  let app: INestApplication;
  let privatePem: string;
  const audience = 'aramo-platform-ccp-r3w-test';
  const saved: Record<string, string | undefined> = {};

  async function tokenFor(principal: string, consumer_type = 'platform'): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ consumer_type, actor_kind: 'user', tenant_id: PLATFORM_TENANT_SENTINEL_ID, authz_version: 1 })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer('Aramo Core Auth')
      .setAudience(audience)
      .setSubject(PRINCIPALS[principal]!.sub)
      .setIssuedAt(now)
      .setExpirationTime(now + 900)
      .sign(await importPKCS8(privatePem, 'RS256'));
  }
  async function get(path: string, principal: string) {
    return request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${await tokenFor(principal)}`);
  }
  async function post(path: string, principal: string, body: object = {}) {
    return request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${await tokenFor(principal)}`).send(body);
  }

  beforeAll(async () => {
    const keys = generateTestKeyPair();
    privatePem = keys.privatePem;
    for (const k of ['AUTH_AUDIENCE', 'AUTH_PUBLIC_KEY']) saved[k] = process.env[k];
    process.env['AUTH_AUDIENCE'] = audience;
    process.env['AUTH_PUBLIC_KEY'] = keys.publicPem;
    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule, AuthorizationModule],
      controllers: [
        PlatformCommercialChangeRequestController,
        PlatformCommercialContractController,
        PlatformCommercialBillingAdjustmentController,
        PlatformCommercialBillingController,
        PlatformCommercialRefundReportController,
        PlatformCommercialAuditController,
      ],
      providers: [
        { provide: EFFECTIVE_AUTHORIZATION_RESOLVER, useValue: new RoleBundleResolver() },
        { provide: APP_FILTER, useClass: AramoExceptionFilter },
        { provide: CommercialChangeRequestService, useValue: crSvc },
        { provide: ContractRepository, useValue: contracts },
        { provide: CommercialBillingAdjustmentService, useValue: adjSvc },
        { provide: BillingCommandService, useValue: commandsSvc },
        { provide: BillingWebhookInboxService, useValue: { list: vi.fn() } },
        { provide: CommercialRefundReportService, useValue: refunds },
        { provide: CommercialAuditRepository, useValue: audit },
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

  beforeEach(() => {
    crSvc.current = CREDIT;
  });

  it('R3W-0 the bundles: exactly 3 amount holders; the 6 CCP roles hold platform:approval:read; super_admin holds no commercial scope', () => {
    expect(CCP_ROLES.filter((r) => BUNDLES[r]?.includes(AMOUNT))).toEqual([...HOLDERS]);
    expect(CCP_ROLES.every((r) => BUNDLES[r]?.includes('platform:approval:read'))).toBe(true);
    expect((BUNDLES['super_admin'] ?? []).some((s) => s.startsWith('platform:approval') || s.startsWith('platform:billing') || s.startsWith('platform:subscription'))).toBe(false);
  });

  // ── W-3 — the change-request routes (7), a CREDIT requested by commercial_ops ─────────────────
  const CR = '/platform/commercial/change-requests';
  const crRoutes: Array<{ name: string; call: (p: string) => Promise<request.Response>; pick: (b: Record<string, unknown>) => Record<string, unknown>; approval?: (b: Record<string, unknown>) => Record<string, unknown> }> = [
    { name: 'POST create', call: (p) => post(CR, p, { action_type: 'CREDIT', tenant_id: CREDIT.tenant_id, product_key: 'sign', payload: { amount_minor: 1, currency: 'USD' }, reason: REASON, idempotency_key: 'idem-r3w-0001' }), pick: (b) => b['request'] as Record<string, unknown> },
    { name: 'GET list', call: (p) => get(CR, p), pick: (b) => (b['requests'] as Array<Record<string, unknown>>)[0] as Record<string, unknown> },
    { name: 'GET detail', call: (p) => get(`${CR}/${CR_ID}`, p), pick: (b) => b['request'] as Record<string, unknown>, approval: (b) => (b['approvals'] as Array<Record<string, unknown>>)[0] as Record<string, unknown> },
    { name: 'POST submit', call: (p) => post(`${CR}/${CR_ID}/submit`, p), pick: (b) => b['request'] as Record<string, unknown> },
    { name: 'POST withdraw', call: (p) => post(`${CR}/${CR_ID}/withdraw`, p), pick: (b) => b['request'] as Record<string, unknown> },
    { name: 'POST approve', call: (p) => post(`${CR}/${CR_ID}/approvals`, p, { step_index: 0, comment: COMMENT }), pick: (b) => b['request'] as Record<string, unknown>, approval: (b) => b['approval'] as Record<string, unknown> },
    { name: 'POST reject', call: (p) => post(`${CR}/${CR_ID}/reject`, p, { reason: REJECTION }), pick: (b) => b['request'] as Record<string, unknown> },
  ];
  const readers = Object.keys(PRINCIPALS).filter((p) => p !== 'audit_only' && p !== 'super_admin');

  for (const r of crRoutes) {
    for (const p of readers) {
      it(`R3W-CR ${r.name} CREDIT as ${p}: ${isHolder(p) ? 'holder — everything' : p === 'commercial_ops' ? 'requester — own reason; notes withheld' : 'non-requester — reason and notes withheld'}`, async () => {
        const res = await r.call(p);
        expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
        const req = r.pick(res.body as Record<string, unknown>);
        if (isHolder(p)) {
          expect(req['reason']).toBe(REASON);
          expect(req['rejection_reason']).toBe(REJECTION);
          expect(req).not.toHaveProperty('reason_withheld');
          expect(req).not.toHaveProperty('notes_withheld');
          expect(req['payload']).toEqual({ amount_minor: 35000, currency: 'USD' });
          if (r.approval) expect(r.approval(res.body as Record<string, unknown>)['comment']).toBe(COMMENT);
          return;
        }
        // R3 unchanged: the amount is withheld from every non-holder, requester included.
        expect(req['payload']).toEqual({ currency: 'USD', amount_withheld: W });
        expect(req).not.toHaveProperty('rejection_reason');
        expect(req['notes_withheld']).toBe(W);
        if (p === 'commercial_ops') {
          expect(req['reason']).toBe(REASON);
          expect(req).not.toHaveProperty('reason_withheld');
        } else {
          expect(req).not.toHaveProperty('reason');
          expect(req['reason_withheld']).toBe(W);
          expect(JSON.stringify(res.body)).not.toContain(REASON);
        }
        if (r.approval) {
          const a = r.approval(res.body as Record<string, unknown>);
          expect(a).not.toHaveProperty('comment');
          expect(a['notes_withheld']).toBe(W);
        }
        for (const s of [REJECTION, COMMENT, '"amount_minor"']) expect(JSON.stringify(res.body), s).not.toContain(s);
      });
    }
    it(`R3W-CR ${r.name} refuses super_admin (403, no commercial scope); nothing is read`, async () => {
      crSvc.get.mockClear();
      const res = await r.call('super_admin');
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain(REASON);
    });
  }

  it('R3W-CR-OWN commercial_ops creates a CREDIT and reads it back: its own reason; the approver comment withheld. Another commercial_ops user: reason and comment withheld', async () => {
    const created = await post(CR, 'commercial_ops', { action_type: 'CREDIT', tenant_id: CREDIT.tenant_id, product_key: 'sign', payload: { amount_minor: 35000, currency: 'USD' }, reason: REASON, idempotency_key: 'idem-r3w-0002' });
    expect(created.status).toBe(201);
    expect(created.body.request.reason).toBe(REASON);
    const own = await get(`${CR}/${CR_ID}`, 'commercial_ops');
    expect(own.body.request.reason).toBe(REASON);
    expect(own.body.approvals[0]).not.toHaveProperty('comment');
    expect(own.body.approvals[0].notes_withheld).toBe(W);
    const other = await get(`${CR}/${CR_ID}`, 'commercial_ops_2');
    expect(other.body.request.reason_withheld).toBe(W);
    expect(other.body.request).not.toHaveProperty('reason');
    expect(other.body.approvals[0].notes_withheld).toBe(W);
    expect(JSON.stringify(other.body)).not.toContain(REASON);
  });

  it('R3W-CR-REFUND the REFUND evidence (category, basis, refund_policy_ref): its requester sees it; another commercial_ops and support_admin get evidence_withheld; holders see it; provider refs stay for all', async () => {
    crSvc.current = REFUND;
    const own = await get(`${CR}/${CR_ID}`, 'commercial_ops');
    expect(own.body.request.payload).toEqual({ currency: 'USD', provider_invoice_ref: 'in_abc123', provider_payment_ref: 'pi_abc123', category: 'R1_DUPLICATE', basis: EVIDENCE, refund_policy_ref: 'refund-policy@1.0', amount_withheld: W });
    for (const p of ['commercial_ops_2', 'support_admin', 'catalog_manager']) {
      const res = await get(`${CR}/${CR_ID}`, p);
      expect(res.body.request.payload, p).toEqual({ currency: 'USD', provider_invoice_ref: 'in_abc123', provider_payment_ref: 'pi_abc123', amount_withheld: W, evidence_withheld: W });
      expect(JSON.stringify(res.body), p).not.toContain(EVIDENCE);
    }
    for (const p of HOLDERS) expect((await get(`${CR}/${CR_ID}`, p)).body.request.payload, p).toEqual(REFUND.payload);
  });

  it('R3W-CR-NONFIN non-financial requests (SUBSCRIPTION_OPEN, SUPPORT_EXTENSION) keep their reason, rejection note and approver comment for EVERY reader', async () => {
    for (const r of [SUB_OPEN, SUPPORT]) {
      crSvc.current = r;
      for (const p of readers) {
        const res = await get(`${CR}/${CR_ID}`, p);
        expect(res.body.request.reason, `${r.action_type} ${p}`).toBe(REASON);
        expect(res.body.request.rejection_reason, `${r.action_type} ${p}`).toBe(REJECTION);
        expect(res.body.approvals[0].comment, `${r.action_type} ${p}`).toBe(COMMENT);
        expect(res.body.request).not.toHaveProperty('reason_withheld');
      }
    }
  });

  it('R3W-CR-TERMS a SUBSCRIPTION_OPEN contract block: terms withheld for commercial_ops (its requester), commercial_ops_2, support_admin and catalog_manager; visible for the 3 holders', async () => {
    crSvc.current = SUB_OPEN;
    for (const p of readers) {
      for (const res of [await get(`${CR}/${CR_ID}`, p), await get(CR, p)]) {
        const req = res.body.request ?? res.body.requests[0];
        if (isHolder(p)) expect(req.payload.contract.terms, p).toEqual(TERMS);
        else {
          expect(req.payload.contract, p).toEqual({ contract_ref: 'CT-2026-021', documents: [], terms_withheld: W });
          expect(JSON.stringify(res.body), p).not.toContain(TERMS[1]);
        }
      }
    }
  });

  // ── W-2 — the B4 contract routes ─────────────────────────────────────────────────────────────
  it('R3W-K-1 contract detail: terms, recorded_terms and every amendment terms visible for the 3 holders; commercial_ops and support_admin get terms_withheld (also on the unchanged amendment); the list carries no terms', async () => {
    for (const p of ['platform_owner', 'finance_admin', 'read_only_auditor', 'commercial_ops', 'support_admin']) {
      const res = await get(`/platform/commercial/contracts/${CONTRACT_ID}`, p);
      expect(res.status, p).toBe(200);
      if (isHolder(p)) {
        expect(res.body.terms, p).toEqual(TERMS);
        expect(res.body.recorded_terms, p).toEqual([TERMS[0]]);
        expect(res.body.amendments.map((a: { terms: unknown }) => a.terms), p).toEqual([TERMS, null]);
        expect(res.body).not.toHaveProperty('terms_withheld');
      } else {
        expect(res.body, p).not.toHaveProperty('terms');
        expect(res.body, p).not.toHaveProperty('recorded_terms');
        expect(res.body.terms_withheld, p).toBe(W);
        for (const a of res.body.amendments) {
          expect(a, p).not.toHaveProperty('terms');
          expect(a.terms_withheld, p).toBe(W);
          expect(a.summary, p).toBeDefined();
        }
        expect(JSON.stringify(res.body), p).not.toContain('net 30');
      }
      const list = await get('/platform/commercial/contracts', p);
      expect(JSON.stringify(list.body), p).not.toContain('net 30');
    }
    for (const p of ['catalog_manager', 'super_admin']) expect((await get(`/platform/commercial/contracts/${CONTRACT_ID}`, p)).status, p).toBe(403);
  });

  // ── item 3 — C4 refusal details and command provider text ───────────────────────────────────
  it('R3W-D-1 REFUND_REMAINDER_UNVERIFIABLE on create (REFUND_NOT_REFUNDABLE): its requester commercial_ops gets the refusal and basis with detail_withheld; the provider text never appears', async () => {
    crSvc.create.mockRejectedValueOnce(new CommercialChangeRequestError('REFUND_NOT_REFUNDABLE', 'refund refused: REFUND_REMAINDER_UNVERIFIABLE', { refusal: 'REFUND_REMAINDER_UNVERIFIABLE', basis: 'provider_read_failed', error: PROVIDER_TEXT }));
    const res = await post(CR, 'commercial_ops', { action_type: 'REFUND', tenant_id: CREDIT.tenant_id, product_key: 'sign', payload: REFUND.payload, reason: REASON, idempotency_key: 'idem-r3w-0003' });
    expect(res.status).toBe(409);
    expect(res.body.error.details).toEqual({ reason: 'refund_not_refundable', refusal: 'REFUND_REMAINDER_UNVERIFIABLE', basis: 'provider_read_failed', detail_withheld: W });
    expect(JSON.stringify(res.body)).not.toContain(PROVIDER_TEXT);
  });

  it('R3W-D-2 the C4 apply / resolve refusal (REFUND_REMAINDER_UNVERIFIABLE, REFUND_OUTCOME_UNCERTAIN provider_read_failed): non-holders get detail_withheld; a holder gets the provider text', async () => {
    const BA = `${CR}/${CR_ID}/billing-adjustment`;
    for (const [route, fn, refusal] of [
      [BA, 'apply', 'REFUND_REMAINDER_UNVERIFIABLE'],
      [`${BA}/resolve`, 'resolveRefund', 'REFUND_OUTCOME_UNCERTAIN'],
    ] as const) {
      for (const p of ['commercial_ops', 'finance_admin']) {
        adjSvc[fn].mockRejectedValueOnce(new BillingAdjustmentRefusedError(refusal as never, { basis: 'provider_read_failed', command_id: 'c1', error: PROVIDER_TEXT }));
        const res = await post(route, p);
        expect(res.status, `${route} ${p}`).toBe(409);
        expect(res.body.error.details.refusal).toBe(refusal);
        expect(res.body.error.details.basis).toBe('provider_read_failed');
        if (isHolder(p)) expect(res.body.error.details.error).toBe(PROVIDER_TEXT);
        else {
          expect(res.body.error.details.detail_withheld).toBe(W);
          expect(JSON.stringify(res.body)).not.toContain(PROVIDER_TEXT);
        }
      }
    }
  });

  it('R3W-D-3 a C4 command (REFUND_CREATE) read through the billing-adjustment view and the billing-commands list: non-holders get the code + detail_withheld; a cancel command keeps its detail; holders get the text', async () => {
    for (const p of ['platform_owner', 'finance_admin', 'read_only_auditor', 'commercial_ops', 'commercial_ops_2', 'support_admin', 'catalog_manager']) {
      const v = await get(`${CR}/${CR_ID}/billing-adjustment`, p);
      expect(v.status, p).toBe(200);
      const c = v.body.adjustment.commands[0];
      if (isHolder(p)) {
        expect(c.last_detail, p).toBe(PROVIDER_TEXT);
        expect(c.failure, p).toEqual({ code: 'PROVIDER_REJECTED', detail: PROVIDER_TEXT });
      } else {
        expect(c, p).not.toHaveProperty('last_detail');
        expect(c.detail_withheld, p).toBe(W);
        expect(c.failure, p).toEqual({ code: 'PROVIDER_REJECTED', detail_withheld: W });
        expect(JSON.stringify(v.body), p).not.toContain(PROVIDER_TEXT);
        // R3-W on the view's request too (REFUND, not the requester unless commercial_ops)
        if (p !== 'commercial_ops') expect(v.body.request.reason_withheld, p).toBe(W);
      }
      if (p === 'catalog_manager') continue; // no platform:billing:read
      const l = await get('/platform/commercial/billing-commands', p);
      expect(l.status, p).toBe(200);
      const [refundCmd, cancelCmd] = l.body.commands;
      expect(cancelCmd.last_detail, p).toBe(PROVIDER_TEXT);
      expect(isHolder(p) ? refundCmd.last_detail : refundCmd.detail_withheld, p).toBe(isHolder(p) ? PROVIDER_TEXT : W);
    }
    expect((await get('/platform/commercial/billing-commands', 'catalog_manager')).status).toBe(403);
  });

  // ── W-3 — the C4-P refund report ─────────────────────────────────────────────────────────────
  it('R3W-RR-1 the refund report category: holders see every row; commercial_ops sees it on its OWN row only; support_admin sees none (evidence_withheld); amounts as R3', async () => {
    for (const p of ['platform_owner', 'finance_admin', 'read_only_auditor', 'commercial_ops', 'commercial_ops_2', 'support_admin']) {
      const res = await get('/platform/commercial/finance/refunds', p);
      expect(res.status, p).toBe(200);
      const rows = res.body.refunds as Array<Record<string, unknown>>;
      for (const r of rows) {
        const own = r['requested_by'] === PRINCIPALS[p]!.sub;
        if (isHolder(p) || own) expect(r['category'], p).toBe('R1_DUPLICATE');
        else {
          expect(r, p).not.toHaveProperty('category');
          expect(r['evidence_withheld'], p).toBe(W);
        }
        expect(isHolder(p) ? r['amount_minor'] : r['amount_withheld'], p).toBe(isHolder(p) ? 4321 : W);
      }
    }
    for (const p of ['catalog_manager', 'super_admin']) expect((await get('/platform/commercial/finance/refunds', p)).status, p).toBe(403);
  });

  // ── the A2 audit feed (audit scope = the 3 holders; the synthetic audit_only = a non-holder) ─────
  it('R3W-AU-1 the audit feed: holders receive reason, notes, provider text and terms; a non-holder with the audit scope gets the markers; every other CCP role is refused (403)', async () => {
    for (const p of [...HOLDERS, 'audit_only']) {
      const res = await get('/platform/commercial/audit-events', p);
      expect(res.status, p).toBe(200);
      const body = JSON.stringify(res.body);
      if (isHolder(p)) for (const s of [REASON, REJECTION, PROVIDER_TEXT, TERMS[1] as string]) expect(body, `${p} ${s}`).toContain(s);
      else {
        for (const s of SECRETS) expect(body, `${p} ${s}`).not.toContain(s);
        for (const m of ['reason_withheld', 'detail_withheld', 'terms_withheld', 'amount_withheld']) expect(body, m).toContain(m);
      }
    }
    for (const p of ['commercial_ops', 'support_admin', 'catalog_manager', 'super_admin']) expect((await get('/platform/commercial/audit-events', p)).status, p).toBe(403);
  });
});
