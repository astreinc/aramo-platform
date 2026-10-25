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
import { BillingCommandError, BillingCommandService, BillingWebhookInboxQueryError, BillingWebhookInboxService } from '@aramo/subscription';

import { PlatformCommercialBillingController } from '../app/platform/platform-commercial-billing.controller.js';

import { generateTestKeyPair } from './test-keys.js';

// CCP-C1 (PBD §5.2 row C1 "operator-visible failure states"; per-role tests for every new
// platform-admin route) — GET /platform/commercial/billing-commands and
// GET /platform/commercial/billing-webhook-inbox under platform:billing:read, for each of the 6
// CCP platform roles and super_admin, one role per principal, through the REAL request chain: a
// signed platform token → the real JwtAuthGuard (server-side effective-scope resolution) → the
// real RolesGuard (@RequireScopes) → the controller's consumer_type tripwire → AramoExceptionFilter.
//
// Expected (CCP A1 §4.1 bundles): allowed — platform_owner, finance_admin, commercial_ops,
// support_admin, read_only_auditor; refused — catalog_manager and super_admin (no commercial
// scope, INV-1; PBD §12). The bundles are restated from §4.1 as in the A1 / A2 specs.

const SCOPE = 'platform:billing:read';
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
const ALLOWED = ['platform_owner', 'finance_admin', 'commercial_ops', 'support_admin', 'read_only_auditor'] as const;
const REFUSED = ['catalog_manager', 'super_admin'] as const;
const COMMANDS = '/platform/commercial/billing-commands';
const INBOX = '/platform/commercial/billing-webhook-inbox';

class RoleBundleResolver implements EffectiveAuthorizationResolver {
  readonly roleOf = new Map<string, string>();
  async resolve(input: EffectiveAuthorizationInput): Promise<EffectiveAuthorizationResolution> {
    const role = this.roleOf.get(input.principal_id);
    const scopes = role === undefined ? [] : [...(BUNDLES[role] ?? [])];
    return { status: 'ok', scopes: filterScopesForConsumer({ consumer: input.consumer_type, scopes, tenantHasEsign: false }) };
  }
}

const T = new Date('2026-10-26T12:00:00.000Z');
const COMMAND = {
  id: '019a0000-0000-7000-8000-0000000cc1a1',
  provider: 'STRIPE',
  command_kind: 'SUBSCRIPTION_CANCEL',
  change_request_id: '019a0000-0000-7000-8000-0000000cc1a2',
  step: 'end_self_service',
  idempotency_key: 'aramo-ccp-019a0000-0000-7000-8000-0000000cc1a2-end_self_service',
  tenant_id: '0190dddd-0000-7000-8000-000000000001',
  product_key: 'sign',
  target_ref: 'sub_c1',
  params: { mode: 'IMMEDIATE' },
  state: 'FAILED',
  attempts: 8,
  lease_until: null,
  next_attempt_at: null,
  last_error_code: 'RETRIES_EXHAUSTED',
  last_error_detail: 'billing provider unavailable: HTTP 503',
  provider_accepted_at: null,
  confirmed_at: null,
  confirmation_source: null,
  confirmation_event_id: null,
  failed_at: T,
  created_by: '0190cccc-0000-7000-8000-00000000000a',
  created_at: T,
  updated_at: T,
};
const INBOX_ROW = {
  id: '019a0000-0000-7000-8000-0000000cc1b1',
  provider: 'STRIPE',
  provider_event_id: 'evt_c1',
  event_type: 'invoice.paid',
  event_created_at: T,
  subscription_ref: 'sub_c1',
  checkout_session_ref: null,
  product_key: 'sign',
  status: 'FAILED',
  attempts: 1,
  lease_until: null,
  next_attempt_at: T,
  outcome: null,
  detail: null,
  last_error: 'billing provider unavailable: down',
  received_at: T,
  processed_at: null,
  updated_at: T,
};

describe('CCP-C1 — per-role authorization on the billing-operations read routes (real JwtAuthGuard + RolesGuard)', () => {
  let app: INestApplication;
  let privatePem: string;
  const audience = 'aramo-platform-ccp-c1-test';
  const saved: Record<string, string | undefined> = {};
  const resolver = new RoleBundleResolver();
  const principal = new Map<string, string>();
  const commands = { list: vi.fn(async () => ({ commands: [COMMAND], next_cursor: null as string | null })) };
  const inbox = { list: vi.fn(async () => ({ events: [INBOX_ROW], next_cursor: null as string | null })) };

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
      controllers: [PlatformCommercialBillingController],
      providers: [
        { provide: EFFECTIVE_AUTHORIZATION_RESOLVER, useValue: resolver },
        { provide: APP_FILTER, useClass: AramoExceptionFilter },
        { provide: BillingCommandService, useValue: commands },
        { provide: BillingWebhookInboxService, useValue: inbox },
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

  beforeEach(() => {
    commands.list.mockClear();
    inbox.list.mockClear();
  });

  it('C1-R-0 the matrix is the §4.1 one: exactly the 5 allowed roles hold platform:billing:read; super_admin holds no commercial scope', () => {
    expect(Object.keys(BUNDLES).filter((r) => BUNDLES[r]?.includes(SCOPE)).sort()).toEqual([...ALLOWED].sort());
    expect(BUNDLES['super_admin']?.some((s) => /^platform:(commercial|catalog|subscription|entitlement|billing|approval):/.test(s))).toBe(false);
  });

  for (const role of ALLOWED) {
    it(`C1-R-1 allowed — ${role} → 200 on both routes (a FAILED command is visible; pending_provider true until confirmed)`, async () => {
      const c = await get(COMMANDS, role);
      expect(c.status, JSON.stringify(c.body)).toBe(200);
      expect(c.body.next_cursor).toBeNull();
      expect(c.body.commands).toEqual([
        expect.objectContaining({
          id: COMMAND.id,
          state: 'FAILED',
          pending_provider: true,
          attempts: 8,
          failure: { code: 'RETRIES_EXHAUSTED', detail: 'billing provider unavailable: HTTP 503' },
          failed_at: '2026-10-26T12:00:00.000Z',
          confirmed_at: null,
          params: { mode: 'IMMEDIATE' },
        }),
      ]);
      const i = await get(INBOX, role);
      expect(i.status, JSON.stringify(i.body)).toBe(200);
      expect(i.body.events).toEqual([expect.objectContaining({ provider_event_id: 'evt_c1', status: 'FAILED', last_error: 'billing provider unavailable: down', received_at: '2026-10-26T12:00:00.000Z' })]);
      expect(commands.list).toHaveBeenCalledTimes(1);
      expect(inbox.list).toHaveBeenCalledTimes(1);
    });
  }

  for (const role of REFUSED) {
    it(`C1-R-2 refused — ${role} → 403 INSUFFICIENT_PERMISSIONS (missing ${SCOPE}) on both routes; no service reached`, async () => {
      for (const path of [COMMANDS, INBOX]) {
        const res = await get(path, role);
        expect(res.status).toBe(403);
        expect(res.body?.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
        expect(res.body?.error?.details?.missing_scopes).toEqual([SCOPE]);
      }
      expect(commands.list).not.toHaveBeenCalled();
      expect(inbox.list).not.toHaveBeenCalled();
    });
  }

  it('C1-R-3 refused — no token → 401; a tenant-tier token for an allowed role → 403', async () => {
    for (const path of [COMMANDS, INBOX]) {
      expect((await request(app.getHttpServer()).get(path)).status).toBe(401);
      const res = await get(path, 'finance_admin', '', 'recruiter');
      expect(res.status).toBe(403);
      expect(res.body?.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
    }
    expect(commands.list).not.toHaveBeenCalled();
    expect(inbox.list).not.toHaveBeenCalled();
  });

  it('C1-R-4 passes every filter through, typed', async () => {
    const tenant = '0190dddd-0000-7000-8000-000000000001';
    const cr = '019a0000-0000-7000-8000-0000000cc1a2';
    expect((await get(COMMANDS, 'support_admin', `?state=PENDING_PROVIDER&tenant_id=${tenant}&change_request_id=${cr}&limit=25&cursor=abc`)).status).toBe(200);
    expect(commands.list).toHaveBeenCalledWith({ state: 'PENDING_PROVIDER', tenant_id: tenant, change_request_id: cr, limit: 25, cursor: 'abc' });
    expect((await get(INBOX, 'support_admin', '?status=FAILED&limit=10')).status).toBe(200);
    expect(inbox.list).toHaveBeenCalledWith({ status: 'FAILED', limit: 10, cursor: undefined });
  });

  const bad: Array<[string, string, string]> = [
    ['unknown command state', COMMANDS, '?state=DROPPED'],
    ['tenant_id not a uuid', COMMANDS, '?tenant_id=nope'],
    ['change_request_id not a uuid', COMMANDS, '?change_request_id=nope'],
    ['limit above 200', COMMANDS, '?limit=201'],
    ['unknown parameter', COMMANDS, '?status=FAILED'],
    ['unknown inbox status', INBOX, '?status=DONE'],
    ['inbox limit 0', INBOX, '?limit=0'],
  ];
  for (const [name, path, q] of bad) {
    it(`C1-R-5 400 VALIDATION_ERROR — ${name}`, async () => {
      const res = await get(path, 'finance_admin', q);
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body?.error?.code).toBe('VALIDATION_ERROR');
      expect(commands.list).not.toHaveBeenCalled();
      expect(inbox.list).not.toHaveBeenCalled();
    });
  }

  it('C1-R-6 400 VALIDATION_ERROR (invalid_cursor) when a service refuses the cursor', async () => {
    commands.list.mockRejectedValueOnce(new BillingCommandError('INVALID_CURSOR', 'cursor filters do not match the current query'));
    const a = await get(COMMANDS, 'finance_admin', '?cursor=stale');
    expect(a.status).toBe(400);
    expect(a.body?.error?.details?.reason).toBe('invalid_cursor');
    inbox.list.mockRejectedValueOnce(new BillingWebhookInboxQueryError('malformed cursor'));
    const b = await get(INBOX, 'finance_admin', '?cursor=stale');
    expect(b.status).toBe(400);
    expect(b.body?.error?.details?.reason).toBe('invalid_cursor');
  });
});
