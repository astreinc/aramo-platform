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
import { CommercialAlertQueryError, CommercialAlertService } from '@aramo/subscription';

import { PlatformCommercialObservabilityController } from '../app/platform/platform-commercial-observability.controller.js';

import { generateTestKeyPair } from './test-keys.js';

// CCP-D3 (PBD §5.4 row D3; per-role tests for every new platform-admin route) — the alert register
// and metrics routes for each of the 6 CCP platform roles and super_admin, one role per principal,
// through the REAL request chain: a signed platform token → the real JwtAuthGuard (server-side
// effective-scope resolution) → the real RolesGuard (@RequireScopes) → the consumer_type tripwire →
// AramoExceptionFilter.
//
// Expected (CCP A1 §4.1 bundles):
//   alerts/billing, metrics/billing (platform:billing:read): allowed platform_owner, finance_admin,
//     commercial_ops, support_admin, read_only_auditor; refused catalog_manager, super_admin.
//   alerts/approvals, metrics/approvals (platform:approval:read): allowed all 6 CCP roles; refused
//     super_admin (no commercial scope, INV-1; PBD §12).

const SCOPE = 'platform:billing:read';
const APPROVAL = 'platform:approval:read';
const ENTRY = 'platform:tenant:read';
const BUNDLES: Record<string, readonly string[]> = {
  platform_owner: [ENTRY, 'platform:catalog:read', 'platform:catalog:approve', 'platform:catalog:publish', 'platform:subscription:read', 'platform:subscription:approve', 'platform:entitlement:approve', SCOPE, 'platform:billing:approve', 'platform:approval:read', 'platform:commercial:audit:read'],
  finance_admin: [ENTRY, 'platform:catalog:read', 'platform:catalog:approve', 'platform:subscription:read', 'platform:subscription:approve', 'platform:entitlement:approve', SCOPE, 'platform:billing:approve', 'platform:approval:read', 'platform:commercial:audit:read'],
  commercial_ops: [ENTRY, 'platform:catalog:read', 'platform:subscription:read', 'platform:subscription:request', 'platform:entitlement:request', SCOPE, 'platform:billing:request', 'platform:approval:read'],
  catalog_manager: [ENTRY, 'platform:catalog:read', 'platform:catalog:draft', 'platform:approval:read'],
  support_admin: [ENTRY, 'platform:catalog:read', 'platform:subscription:read', 'platform:subscription:support', SCOPE, 'platform:approval:read'],
  read_only_auditor: [ENTRY, 'platform:catalog:read', 'platform:subscription:read', SCOPE, 'platform:approval:read', 'platform:commercial:audit:read'],
  super_admin: ['platform:tenant:provision', ENTRY, 'platform:admin:invite', 'platform:tenant:lifecycle:manage', 'platform:skill:read', 'platform:skill:manage', 'platform:document_template:read', 'platform:document_template:manage', 'platform:matching_policy:read', 'platform:matching_policy:write'],
};
const BILLING_ALLOWED = ['platform_owner', 'finance_admin', 'commercial_ops', 'support_admin', 'read_only_auditor'] as const;
const BILLING_REFUSED = ['catalog_manager', 'super_admin'] as const;
const APPROVAL_ALLOWED = ['platform_owner', 'finance_admin', 'commercial_ops', 'catalog_manager', 'support_admin', 'read_only_auditor'] as const;
const APPROVAL_REFUSED = ['super_admin'] as const;
const ALERTS_B = '/platform/commercial/alerts/billing';
const METRICS_B = '/platform/commercial/metrics/billing';
const ALERTS_A = '/platform/commercial/alerts/approvals';
const METRICS_A = '/platform/commercial/metrics/approvals';

class RoleBundleResolver implements EffectiveAuthorizationResolver {
  readonly roleOf = new Map<string, string>();
  async resolve(input: EffectiveAuthorizationInput): Promise<EffectiveAuthorizationResolution> {
    const role = this.roleOf.get(input.principal_id);
    const scopes = role === undefined ? [] : [...(BUNDLES[role] ?? [])];
    return { status: 'ok', scopes: filterScopesForConsumer({ consumer: input.consumer_type, scopes, tenantHasEsign: false }) };
  }
}

const T = new Date('2026-10-26T12:00:00.000Z');
const BILLING_ALERT = {
  id: '019a0000-0000-7000-8000-0000000cd3a1',
  alert_type: 'COMMAND_FAILED',
  family: 'BILLING',
  subject_kind: 'billing_command',
  subject_id: '019a0000-0000-7000-8000-0000000cc1a1',
  tenant_id: '0190dddd-0000-7000-8000-000000000001',
  product_key: 'sign',
  status: 'OPEN',
  detail: 'SUBSCRIPTION_CANCEL FAILED RETRIES_EXHAUSTED after 8 attempt(s)',
  evidence: { state: 'FAILED', failure_code: 'RETRIES_EXHAUSTED' },
  threshold_minutes: null,
  detection_count: 3,
  first_detected_at: T,
  last_detected_at: T,
  resolved_at: null,
  resolution_detail: null,
  updated_at: T,
};
const APPROVAL_ALERT = {
  ...BILLING_ALERT,
  id: '019a0000-0000-7000-8000-0000000cd3a2',
  alert_type: 'APPROVAL_PAST_EXPIRY',
  family: 'APPROVAL',
  subject_kind: 'change_request',
  subject_id: '019a0000-0000-7000-8000-0000000cc1a2',
  detail: 'CONVERSION still PENDING_APPROVAL 5 min after its expiry (no further approval is accepted)',
  evidence: { state: 'PENDING_APPROVAL' },
};
const THRESHOLDS = { pending_provider_stuck_minutes: 1440, approval_expiry_lead_minutes: 720 };
const BILLING_METRICS = {
  as_of: T,
  commands_by_state: { PENDING: 0, DISPATCHING: 0, PENDING_PROVIDER: 1, RETRY_WAIT: 0, FAILED: 1, CONFIRMED: 4 },
  commands_pending_provider_past_threshold: 1,
  webhook_inbox_by_status: { RECEIVED: 0, PROCESSING: 0, PROCESSED: 9, FAILED: 1 },
  open_reconciliation_flags_by_reason: { governed_subscription_open: 1 },
  open_alerts_by_type: { COMMAND_PENDING_PROVIDER_STUCK: 1, COMMAND_FAILED: 1, HELD_ACTIVATION: 1, WEBHOOK_INBOX_FAILED: 1, USAGE_NOT_RECONCILED: 0 },
  thresholds: THRESHOLDS,
};
const APPROVAL_METRICS = {
  as_of: T,
  change_requests_by_state: { DRAFT: 0, PENDING_APPROVAL: 2, APPROVED: 1, APPLYING: 0, APPLIED: 5, APPLY_FAILED: 1, REJECTED: 0, EXPIRED: 1, WITHDRAWN: 0 },
  pending_approval_nearing_expiry: 1,
  pending_approval_past_expiry: 1,
  open_alerts_by_type: { APPLY_FAILED: 1, APPROVAL_NEARING_EXPIRY: 1, APPROVAL_PAST_EXPIRY: 1, APPLY_DEADLINE_NEARING: 0, APPLY_DEADLINE_PASSED: 0 },
  thresholds: THRESHOLDS,
};

describe('CCP-D3 — per-role authorization on the alert and metrics read routes (real JwtAuthGuard + RolesGuard)', () => {
  let app: INestApplication;
  let privatePem: string;
  const audience = 'aramo-platform-ccp-d3-test';
  const saved: Record<string, string | undefined> = {};
  const resolver = new RoleBundleResolver();
  const principal = new Map<string, string>();
  const alerts = {
    list: vi.fn(async (family: string) => ({ alerts: [family === 'BILLING' ? BILLING_ALERT : APPROVAL_ALERT], next_cursor: null as string | null })),
    billingMetrics: vi.fn(async () => BILLING_METRICS),
    approvalMetrics: vi.fn(async () => APPROVAL_METRICS),
  };
  const called = () => alerts.list.mock.calls.length + alerts.billingMetrics.mock.calls.length + alerts.approvalMetrics.mock.calls.length;

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
  const get = async (path: string, role: string, query = '', consumer_type = 'platform') =>
    request(app.getHttpServer()).get(`${path}${query}`).set('Authorization', `Bearer ${await tokenFor(role, consumer_type)}`);

  beforeAll(async () => {
    const keys = generateTestKeyPair();
    privatePem = keys.privatePem;
    for (const k of ['AUTH_AUDIENCE', 'AUTH_PUBLIC_KEY']) saved[k] = process.env[k];
    process.env['AUTH_AUDIENCE'] = audience;
    process.env['AUTH_PUBLIC_KEY'] = keys.publicPem;
    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule, AuthorizationModule],
      controllers: [PlatformCommercialObservabilityController],
      providers: [
        { provide: EFFECTIVE_AUTHORIZATION_RESOLVER, useValue: resolver },
        { provide: APP_FILTER, useClass: AramoExceptionFilter },
        { provide: CommercialAlertService, useValue: alerts },
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
    alerts.list.mockClear();
    alerts.billingMetrics.mockClear();
    alerts.approvalMetrics.mockClear();
  });

  it('D3-R-0 the matrix is the §4.1 one: 5 roles hold platform:billing:read, 6 hold platform:approval:read; super_admin holds no commercial scope', () => {
    expect(Object.keys(BUNDLES).filter((r) => BUNDLES[r]?.includes(SCOPE)).sort()).toEqual([...BILLING_ALLOWED].sort());
    expect(Object.keys(BUNDLES).filter((r) => BUNDLES[r]?.includes(APPROVAL)).sort()).toEqual([...APPROVAL_ALLOWED].sort());
    expect(BUNDLES['super_admin']?.some((s) => /^platform:(commercial|catalog|subscription|entitlement|billing|approval):/.test(s))).toBe(false);
  });

  for (const role of BILLING_ALLOWED) {
    it(`D3-R-1 billing family allowed — ${role} → 200 on alerts/billing and metrics/billing`, async () => {
      const a = await get(ALERTS_B, role);
      expect(a.status, JSON.stringify(a.body)).toBe(200);
      expect(a.body).toEqual({
        alerts: [expect.objectContaining({ id: BILLING_ALERT.id, alert_type: 'COMMAND_FAILED', family: 'BILLING', status: 'OPEN', detection_count: 3, first_detected_at: '2026-10-26T12:00:00.000Z', resolved_at: null, evidence: { state: 'FAILED', failure_code: 'RETRIES_EXHAUSTED' } })],
        next_cursor: null,
      });
      expect(a.body.alerts[0]).not.toHaveProperty('updated_at');
      const m = await get(METRICS_B, role);
      expect(m.status, JSON.stringify(m.body)).toBe(200);
      expect(m.body).toEqual({ ...BILLING_METRICS, as_of: '2026-10-26T12:00:00.000Z' });
      expect(alerts.list).toHaveBeenCalledWith('BILLING', { status: undefined, alert_type: undefined, tenant_id: undefined, limit: undefined, cursor: undefined });
      expect(alerts.billingMetrics).toHaveBeenCalledTimes(1);
    });
  }

  for (const role of BILLING_REFUSED) {
    it(`D3-R-2 billing family refused — ${role} → 403 INSUFFICIENT_PERMISSIONS (missing ${SCOPE}); no service reached`, async () => {
      for (const path of [ALERTS_B, METRICS_B]) {
        const res = await get(path, role);
        expect(res.status).toBe(403);
        expect(res.body?.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
        expect(res.body?.error?.details?.missing_scopes).toEqual([SCOPE]);
      }
      expect(called()).toBe(0);
    });
  }

  for (const role of APPROVAL_ALLOWED) {
    it(`D3-R-3 approval family allowed — ${role} → 200 on alerts/approvals and metrics/approvals`, async () => {
      const a = await get(ALERTS_A, role);
      expect(a.status, JSON.stringify(a.body)).toBe(200);
      expect(a.body.alerts).toEqual([expect.objectContaining({ id: APPROVAL_ALERT.id, alert_type: 'APPROVAL_PAST_EXPIRY', family: 'APPROVAL' })]);
      const m = await get(METRICS_A, role);
      expect(m.status, JSON.stringify(m.body)).toBe(200);
      expect(m.body).toEqual({ ...APPROVAL_METRICS, as_of: '2026-10-26T12:00:00.000Z' });
      expect(alerts.list).toHaveBeenCalledWith('APPROVAL', expect.any(Object));
    });
  }

  for (const role of APPROVAL_REFUSED) {
    it(`D3-R-4 approval family refused — ${role} → 403 INSUFFICIENT_PERMISSIONS (missing ${APPROVAL}); no service reached`, async () => {
      for (const path of [ALERTS_A, METRICS_A]) {
        const res = await get(path, role);
        expect(res.status).toBe(403);
        expect(res.body?.error?.details?.missing_scopes).toEqual([APPROVAL]);
      }
      expect(called()).toBe(0);
    });
  }

  it('D3-R-5 catalog_manager reaches the approval family but not the billing family', async () => {
    expect((await get(ALERTS_A, 'catalog_manager')).status).toBe(200);
    expect((await get(ALERTS_B, 'catalog_manager')).status).toBe(403);
  });

  it('D3-R-6 refused — no token → 401; a tenant-tier token for an allowed role → 403 on all four routes', async () => {
    for (const path of [ALERTS_B, METRICS_B, ALERTS_A, METRICS_A]) {
      expect((await request(app.getHttpServer()).get(path)).status).toBe(401);
      const res = await get(path, 'finance_admin', '', 'recruiter');
      expect(res.status).toBe(403);
      expect(res.body?.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
    }
    expect(called()).toBe(0);
  });

  it('D3-R-7 passes every filter through, typed', async () => {
    const tenant = '0190dddd-0000-7000-8000-000000000001';
    expect((await get(ALERTS_B, 'support_admin', `?status=OPEN&alert_type=HELD_ACTIVATION&tenant_id=${tenant}&limit=25&cursor=abc`)).status).toBe(200);
    expect(alerts.list).toHaveBeenCalledWith('BILLING', { status: 'OPEN', alert_type: 'HELD_ACTIVATION', tenant_id: tenant, limit: 25, cursor: 'abc' });
    expect((await get(ALERTS_A, 'catalog_manager', '?status=RESOLVED&alert_type=APPLY_FAILED&limit=10')).status).toBe(200);
    expect(alerts.list).toHaveBeenCalledWith('APPROVAL', { status: 'RESOLVED', alert_type: 'APPLY_FAILED', tenant_id: undefined, limit: 10, cursor: undefined });
  });

  const bad: Array<[string, string, string]> = [
    ['unknown status', ALERTS_B, '?status=CLOSED'],
    ['an approval type on the billing route', ALERTS_B, '?alert_type=APPLY_FAILED'],
    ['a billing type on the approval route', ALERTS_A, '?alert_type=COMMAND_FAILED'],
    ['tenant_id not a uuid', ALERTS_A, '?tenant_id=nope'],
    ['limit above 200', ALERTS_B, '?limit=201'],
    ['limit 0', ALERTS_A, '?limit=0'],
    ['unknown parameter (alerts)', ALERTS_B, '?family=APPROVAL'],
    ['unknown parameter (metrics)', METRICS_B, '?tenant_id=0190dddd-0000-7000-8000-000000000001'],
    ['unknown parameter (approval metrics)', METRICS_A, '?at=2026-10-26'],
  ];
  for (const [name, path, q] of bad) {
    it(`D3-R-8 400 VALIDATION_ERROR — ${name}`, async () => {
      const res = await get(path, 'finance_admin', q);
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body?.error?.code).toBe('VALIDATION_ERROR');
      expect(called()).toBe(0);
    });
  }

  it('D3-R-9 400 VALIDATION_ERROR (invalid_cursor / invalid_query) when the service refuses', async () => {
    alerts.list.mockRejectedValueOnce(new CommercialAlertQueryError('INVALID_CURSOR', 'cursor filters do not match the current query'));
    const a = await get(ALERTS_B, 'finance_admin', '?cursor=stale');
    expect(a.status).toBe(400);
    expect(a.body?.error?.details?.reason).toBe('invalid_cursor');
    alerts.list.mockRejectedValueOnce(new CommercialAlertQueryError('INVALID_QUERY', 'unknown status'));
    const b = await get(ALERTS_A, 'finance_admin');
    expect(b.status).toBe(400);
    expect(b.body?.error?.details?.reason).toBe('invalid_query');
  });
});
