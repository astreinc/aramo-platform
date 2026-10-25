import { resolve } from 'node:path';

import { MatchersV3, PactV4 } from '@pact-foundation/pact';
import { describe, expect, it } from 'vitest';

const { eachLike, fromProviderState, integer, like, regex, uuid } = MatchersV3;

// CCP-A10 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.1 row A10; D11;
// PLATFORM-UX-1 Amendment A1, A1-3) — the platform console's contract with the
// platform-admin service for EVERY CCP route that exists, allowed AND refused.
//
// Consumer:  platform-web    (apps/platform-web — the Platform Admin console; the
//                            fe-foundation apiClient names its consumer in
//                            `X-Aramo-Consumer: platform` and rides the
//                            consumer-isolated session cookie
//                            `aramo_access_token_platform`).
// Provider:  platform-admin  (apps/platform-admin).
//
// Per the established harness convention (sign-workspace-consumer, sign-web-consumer,
// ats-web) the interactions are raw fetches matching the client: platform-web is an
// app (relative paths, a browser cookie jar) and an app module is not import-invokable
// from a pact project without crossing the nx project boundary.
//
// Principals: the session cookie value is a PLACEHOLDER naming the role
// (`pact-<role>`). The provider verifier (pact/provider/src/verify-platform-admin.ts)
// seeds one attested operator per role in the platform sentinel tenant and rewrites
// the placeholder to a real RS256 token for that operator, so authority is resolved
// server-side from real RBAC, exactly as in production. The tenant-tier principal
// presents an ats-web session (`X-Aramo-Consumer: recruiter`,
// `aramo_access_token_recruiter`).
//
// Generated ids (change requests) are injected by the provider states
// (fromProviderState). Every mutating interaction gets its OWN fixture on its own
// commercial tenant (change requests and approvals are append-only, and Q14 allows one
// open request per tenant × product).
//
// Coverage — CCP routes (10):
//   GET  /platform/commercial/audit-events                      (CCP-A2)
//   POST /platform/commercial/change-requests                   (CCP-A3)
//   GET  /platform/commercial/change-requests
//   GET  /platform/commercial/change-requests/{id}
//   POST /platform/commercial/change-requests/{id}/submit
//   POST /platform/commercial/change-requests/{id}/withdraw
//   POST /platform/commercial/change-requests/{id}/approvals
//   POST /platform/commercial/change-requests/{id}/reject
//   POST /platform/commercial/change-requests/{id}/apply        (CCP-A6; CCP-B2-backend catalog publish)
//   GET  /platform/commercial/usage/reconciliation              (CCP-D1)
//   GET  /platform/commercial/usage/periods                     (CCP-D1)
//   GET  /platform/commercial/contracts                         (CCP-B4)
//   GET  /platform/commercial/contracts/{id}                    (CCP-B4)
// For each route: the allowed call, super_admin refused (403, holds no commercial
// scope), and the tenant tier refused (403 tier tripwire). Plus the role-level
// refusals: a role missing the route scope (audit feed), a role missing the requester
// or step authority (create, submit, approve, reject), self-approval, and no session.
// Non-CCP: GET /platform/me (allowed only; optional per the A10 row).
// CCP-B1 adds the Approvals inbox's call shapes on the same routes: the full list
// (`?limit=200`), the `eligible_for_me` list, and an approve without a comment.
//
// HOW LATER SLICES EXTEND THIS CONTRACT: see the "Extending" section of
// doc/ccp/slices/CCP-A10-acceptance.md. In short — add a `describe` block per new CCP
// route here (the allowed call + its role refusals), append the route to GATE_ROUTES
// (which generates its super_admin and tenant-tier refusals), and add any new provider
// state to verify-platform-admin.ts. The verifier's coverage gate fails if a route the
// AppModule registers under /platform/commercial lacks an allowed, a super_admin or a
// tenant-tier interaction.

const provider = new PactV4({
  consumer: 'platform-web',
  provider: 'platform-admin',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

// ── fixtures (MUST match pact/provider/src/verify-platform-admin.ts) ──────────

const OP = {
  platform_owner: 'cca10000-0000-7000-8000-000000000001',
  finance_admin: 'cca10000-0000-7000-8000-000000000002',
  commercial_ops: 'cca10000-0000-7000-8000-000000000003',
  catalog_manager: 'cca10000-0000-7000-8000-000000000004',
  support_admin: 'cca10000-0000-7000-8000-000000000005',
  read_only_auditor: 'cca10000-0000-7000-8000-000000000006',
  super_admin: 'cca10000-0000-7000-8000-000000000007',
} as const;
type Role = keyof typeof OP;

const PLATFORM_TENANT = '01900000-0000-7000-8000-000000000100';
const POLICY_V1 = '019a0000-0000-7000-8000-0000000cc201';
const SEEDED_AUDIT_EVENT = '019a0000-0000-7000-8000-0000000cc203';
const CREATE_TENANT = 'cca10000-0000-7000-8000-0000000000c1';
const REFUSED_CREATE_TENANT = 'cca10000-0000-7000-8000-0000000000c2';
// Example id for provider-state-injected request ids (and for the gate refusals,
// which are answered before any lookup).
const EX_REQUEST_ID = 'cca10000-0000-7000-8000-0000000000e1';

const AUDIT = '/platform/commercial/audit-events';
const CR = '/platform/commercial/change-requests';
const USAGE_REC = '/platform/commercial/usage/reconciliation';
const USAGE_PERIODS = '/platform/commercial/usage/periods';
// CCP-D1 — the usage tenant the provider seeds (MANUAL Sign subscription, two periods of ledger usage).
const USAGE_TENANT = 'cca10000-0000-7000-8000-0000000000d1';
const USAGE_SUBSCRIPTION = 'cca10000-0000-7000-8000-0000000000d2';
const CONTRACTS = '/platform/commercial/contracts';
const EX_CONTRACT_ID = 'cca10000-0000-7000-8000-0000000000b4';

const platformSession = (role: Role) => ({ 'X-Aramo-Consumer': 'platform', Cookie: `aramo_access_token_platform=pact-${role}` });
const platformJson = (role: Role) => ({ ...platformSession(role), 'Content-Type': 'application/json' });
const TENANT_TIER = { 'X-Aramo-Consumer': 'recruiter', Cookie: 'aramo_access_token_recruiter=pact-recruiter' };
const TENANT_TIER_JSON = { ...TENANT_TIER, 'Content-Type': 'application/json' };
const NO_SESSION = { 'X-Aramo-Consumer': 'platform' };

const ISO = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$';
const iso = (example = '2026-10-25T10:00:00.000Z') => regex(ISO, example);
const HEX64 = (example = 'a'.repeat(64)) => regex('^[0-9a-f]{64}$', example);

const CREDIT_PAYLOAD = { amount_minor: 100, currency: 'USD' };
const CREATE_BODY = {
  action_type: 'CREDIT',
  tenant_id: CREATE_TENANT,
  product_key: 'sign',
  payload: CREDIT_PAYLOAD,
  reason: 'Goodwill credit for a service outage',
  idempotency_key: 'pact-a10-create-credit-0001',
};

// The finance-only chain of a below-threshold USD credit (A3 §2: CREDIT below
// credit_escalation_threshold_minor → finance_admin).
const FINANCE_ONLY_CHAIN = {
  rule: 'FINANCE_ONLY',
  basis: like({}),
  steps: eachLike({ step_index: integer(0), role_key: 'finance_admin', scope_keys: eachLike('platform:billing:approve') }),
};

// CommercialChangeRequestDto (platform-commercial-change-request.controller.ts requestDto).
function requestBody(
  state: string,
  o: { submitted?: boolean; approved?: boolean; rejected?: boolean; withdrawn?: boolean; tenant?: string } = {},
): Record<string, unknown> {
  return {
    id: uuid(EX_REQUEST_ID),
    action_type: 'CREDIT',
    kind: 'NORMAL',
    state,
    tenant_id: o.tenant === undefined ? uuid(CREATE_TENANT) : o.tenant,
    product_key: 'sign',
    payload: like(CREDIT_PAYLOAD),
    payload_checksum: HEX64(),
    required_chain: FINANCE_ONLY_CHAIN,
    policy_version_id: POLICY_V1,
    policy_checksum: HEX64(),
    requested_by: OP.commercial_ops,
    reason: like('Goodwill credit for a service outage'),
    created_at: iso(),
    submitted_at: o.submitted === true ? iso() : null,
    expires_at: o.submitted === true ? iso('2026-10-28T10:00:00.000Z') : null,
    approved_at: o.approved === true ? iso() : null,
    rejected_at: o.rejected === true ? iso() : null,
    rejected_by: o.rejected === true ? OP.finance_admin : null,
    rejection_reason: o.rejected === true ? like('Credit not justified') : null,
    withdrawn_at: o.withdrawn === true ? iso() : null,
    expired_at: null,
  };
}

// The Phase 5 error envelope (AramoExceptionFilter).
function errorBody(code: string, details: Record<string, unknown>): Record<string, unknown> {
  return { error: { code, message: like('refused'), request_id: like('req-1'), details } };
}
const missingScope = (scope: string) => errorBody('INSUFFICIENT_PERMISSIONS', { missing_scopes: [scope] });
const TIER_REFUSED = errorBody('INSUFFICIENT_PERMISSIONS', { reason: 'tenant_token_on_platform_route' });
const approvalRefused = (refusal: string) => errorBody('COMMERCIAL_APPROVAL_REFUSED', { refusal });

async function call(url: string, method: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  return { status: res.status, body: (text.length > 0 ? JSON.parse(text) : {}) as Record<string, unknown> };
}
const errCode = (b: Record<string, unknown>) => (b['error'] as { code?: string } | undefined)?.code;

// Route descriptors for the gate-refusal matrix (super_admin and tenant tier on every
// CCP route). The gate answers before the body is read or the id is looked up, so a
// fixed id and the create body suffice and no provider fixture is needed.
interface GateRoute {
  name: string;
  method: 'GET' | 'POST';
  path: string;
  scope: string;
  body?: Record<string, unknown>;
}
const GATE_ROUTES: readonly GateRoute[] = [
  { name: 'GET audit-events', method: 'GET', path: AUDIT, scope: 'platform:commercial:audit:read' },
  { name: 'POST change-requests', method: 'POST', path: CR, scope: 'platform:approval:read', body: CREATE_BODY },
  { name: 'GET change-requests', method: 'GET', path: CR, scope: 'platform:approval:read' },
  { name: 'GET change-requests/{id}', method: 'GET', path: `${CR}/${EX_REQUEST_ID}`, scope: 'platform:approval:read' },
  { name: 'POST change-requests/{id}/submit', method: 'POST', path: `${CR}/${EX_REQUEST_ID}/submit`, scope: 'platform:approval:read' },
  { name: 'POST change-requests/{id}/withdraw', method: 'POST', path: `${CR}/${EX_REQUEST_ID}/withdraw`, scope: 'platform:approval:read' },
  { name: 'POST change-requests/{id}/approvals', method: 'POST', path: `${CR}/${EX_REQUEST_ID}/approvals`, scope: 'platform:approval:read', body: { step_index: 0 } },
  { name: 'POST change-requests/{id}/reject', method: 'POST', path: `${CR}/${EX_REQUEST_ID}/reject`, scope: 'platform:approval:read', body: { reason: 'Credit not justified' } },
  { name: 'POST change-requests/{id}/apply', method: 'POST', path: `${CR}/${EX_REQUEST_ID}/apply`, scope: 'platform:approval:read' },
  { name: 'GET usage/reconciliation', method: 'GET', path: USAGE_REC, scope: 'platform:subscription:read' },
  { name: 'GET usage/periods', method: 'GET', path: USAGE_PERIODS, scope: 'platform:subscription:read' },
  { name: 'GET contracts', method: 'GET', path: CONTRACTS, scope: 'platform:subscription:read' },
  { name: 'GET contracts/{id}', method: 'GET', path: `${CONTRACTS}/${EX_CONTRACT_ID}`, scope: 'platform:subscription:read' },
];

// ── CCP-A2 — the commercial audit feed ────────────────────────────────────────

describe('platform-web → GET /platform/commercial/audit-events (CCP-A2)', () => {
  it('read_only_auditor reads the audit feed (200)', async () => {
    // Filtered to the migration-seeded policy activation so the page is deterministic.
    const path = `${AUDIT}?event_type=COMMERCIAL_POLICY_VERSION_ACTIVATED&limit=50`;
    await provider
      .addInteraction()
      .given('the commercial policy activation is audited')
      .uponReceiving('a commercial audit feed read by a read-only auditor')
      .withRequest('GET', AUDIT, (b) => {
        b.headers(platformSession('read_only_auditor')).query({ event_type: 'COMMERCIAL_POLICY_VERSION_ACTIVATED', limit: '50' });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          events: eachLike({
            id: uuid(SEEDED_AUDIT_EVENT),
            created_at: iso(),
            actor_id: null,
            actor_type: 'system',
            actor_role_keys: [],
            event_type: 'COMMERCIAL_POLICY_VERSION_ACTIVATED',
            is_exception: false,
            tenant_id: null,
            subject: like(`commercial_policy_version:${POLICY_V1}`),
            change_request_id: null,
            policy_version_id: uuid(POLICY_V1),
            payload: like({ version_number: 1 }),
            correlation_id: like('migration'),
          }),
          next_cursor: null,
        });
      })
      .executeTest(async (mock) => {
        const res = await call(`${mock.url}${path}`, 'GET', platformSession('read_only_auditor'));
        expect(res.status).toBe(200);
        expect((res.body['events'] as unknown[]).length).toBeGreaterThan(0);
      });
  });

  it('a role without platform:commercial:audit:read (commercial_ops) is refused (403)', async () => {
    await provider
      .addInteraction()
      .given('platform operators are provisioned')
      .uponReceiving('a commercial audit feed read by a role missing the audit scope')
      .withRequest('GET', AUDIT, (b) => {
        b.headers(platformSession('commercial_ops'));
      })
      .willRespondWith(403, (b) => {
        b.jsonBody(missingScope('platform:commercial:audit:read'));
      })
      .executeTest(async (mock) => {
        const res = await call(`${mock.url}${AUDIT}`, 'GET', platformSession('commercial_ops'));
        expect(res.status).toBe(403);
        expect(errCode(res.body)).toBe('INSUFFICIENT_PERMISSIONS');
      });
  });

  it('no session is refused (401)', async () => {
    await provider
      .addInteraction()
      .given('platform operators are provisioned')
      .uponReceiving('a commercial audit feed read without a session')
      .withRequest('GET', AUDIT, (b) => {
        b.headers(NO_SESSION);
      })
      .willRespondWith(401, (b) => {
        b.jsonBody(errorBody('AUTH_REQUIRED', {}));
      })
      .executeTest(async (mock) => {
        const res = await call(`${mock.url}${AUDIT}`, 'GET', NO_SESSION);
        expect(res.status).toBe(401);
      });
  });
});

// ── CCP-A3 — change requests and approvals ────────────────────────────────────

describe('platform-web → POST /platform/commercial/change-requests (CCP-A3)', () => {
  it('commercial_ops creates a DRAFT credit request (201)', async () => {
    await provider
      .addInteraction()
      .given('a commercial tenant without an open change request exists', { tenant_id: CREATE_TENANT })
      .uponReceiving('a change request create by commercial_ops')
      .withRequest('POST', CR, (b) => {
        b.headers(platformJson('commercial_ops')).jsonBody(CREATE_BODY);
      })
      .willRespondWith(201, (b) => {
        b.jsonBody({ request: requestBody('DRAFT', { tenant: CREATE_TENANT }), replayed: false });
      })
      .executeTest(async (mock) => {
        const res = await call(`${mock.url}${CR}`, 'POST', platformJson('commercial_ops'), CREATE_BODY);
        expect(res.status).toBe(201);
        expect((res.body['request'] as { state: string }).state).toBe('DRAFT');
      });
  });

  it('a role without the requester authority (finance_admin) is refused (403 requester_scope_missing)', async () => {
    const body = { ...CREATE_BODY, tenant_id: REFUSED_CREATE_TENANT, idempotency_key: 'pact-a10-create-credit-0002' };
    await provider
      .addInteraction()
      .given('a commercial tenant without an open change request exists', { tenant_id: REFUSED_CREATE_TENANT })
      .uponReceiving('a change request create by a role without the requester scope')
      .withRequest('POST', CR, (b) => {
        b.headers(platformJson('finance_admin')).jsonBody(body);
      })
      .willRespondWith(403, (b) => {
        b.jsonBody(errorBody('INSUFFICIENT_PERMISSIONS', { reason: 'requester_scope_missing' }));
      })
      .executeTest(async (mock) => {
        const res = await call(`${mock.url}${CR}`, 'POST', platformJson('finance_admin'), body);
        expect(res.status).toBe(403);
      });
  });
});

describe('platform-web → GET /platform/commercial/change-requests (CCP-A3)', () => {
  it('finance_admin lists the pending requests (200)', async () => {
    await provider
      .addInteraction()
      .given('a pending change request exists')
      .uponReceiving('a pending change request list read by finance_admin')
      .withRequest('GET', CR, (b) => {
        b.headers(platformSession('finance_admin')).query({ state: 'PENDING_APPROVAL' });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ requests: eachLike(requestBody('PENDING_APPROVAL', { submitted: true })), next_cursor: null });
      })
      .executeTest(async (mock) => {
        const res = await call(`${mock.url}${CR}?state=PENDING_APPROVAL`, 'GET', platformSession('finance_admin'));
        expect(res.status).toBe(200);
        expect((res.body['requests'] as unknown[]).length).toBeGreaterThan(0);
      });
  });
});

// CCP-B1 — the Approvals inbox reads (apps/platform-web/src/commercial/commercial-api.ts
// listChangeRequests): every request, one page of 200, and the caller's
// `eligible_for_me` set. A full page mixes states, so the row template names only the
// fields every state carries (nullable timestamps are contracted by the interactions
// above, per state).
const ANY_STATE = '^(DRAFT|PENDING_APPROVAL|APPROVED|APPLYING|APPLIED|APPLY_FAILED|REJECTED|EXPIRED|WITHDRAWN)$';
const inboxRow = (state: ReturnType<typeof regex> | string) => ({
  id: uuid(EX_REQUEST_ID),
  action_type: regex('^[A-Z_]+$', 'CREDIT'),
  kind: 'NORMAL',
  state,
  // TD-MERGE-1: a mixed page carries every action type (CREDIT, SUBSCRIPTION_OPEN from the A6
  // states, the B2 catalog requests whose product_key is null, …), so the payload is contracted
  // as an object only and product_key (nullable) is left to the per-action interactions.
  payload: like({}),
  required_chain: {
    rule: regex('^(FINANCE_ONLY|FINANCE_THEN_OWNER|DISTINCT_PLATFORM_OWNER)$', 'FINANCE_ONLY'),
    steps: eachLike({ step_index: integer(0), role_key: regex('^(finance_admin|platform_owner)$', 'finance_admin') }),
  },
  policy_version_id: uuid(POLICY_V1),
  requested_by: uuid(OP.commercial_ops),
  reason: like('Goodwill credit for a service outage'),
  created_at: iso(),
});

describe('platform-web → GET /platform/commercial/change-requests — the Approvals inbox reads (CCP-B1)', () => {
  it('finance_admin reads every request, one page of 200 (200)', async () => {
    await provider
      .addInteraction()
      .given('a pending change request exists')
      .uponReceiving('an inbox read of every change request by finance_admin')
      .withRequest('GET', CR, (b) => {
        b.headers(platformSession('finance_admin')).query({ limit: '200' });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ requests: eachLike(inboxRow(regex(ANY_STATE, 'PENDING_APPROVAL'))), next_cursor: null });
      })
      .executeTest(async (mock) => {
        const res = await call(`${mock.url}${CR}?limit=200`, 'GET', platformSession('finance_admin'));
        expect(res.status).toBe(200);
        expect((res.body['requests'] as unknown[]).length).toBeGreaterThan(0);
      });
  });

  it('finance_admin reads the requests waiting on them (eligible_for_me, 200)', async () => {
    await provider
      .addInteraction()
      .given('a pending change request exists')
      .uponReceiving('an inbox read of the requests eligible for finance_admin')
      .withRequest('GET', CR, (b) => {
        b.headers(platformSession('finance_admin')).query({ eligible_for_me: 'true', limit: '200' });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ requests: eachLike(inboxRow('PENDING_APPROVAL')), next_cursor: null });
      })
      .executeTest(async (mock) => {
        const res = await call(`${mock.url}${CR}?eligible_for_me=true&limit=200`, 'GET', platformSession('finance_admin'));
        expect(res.status).toBe(200);
        expect((res.body['requests'] as unknown[]).length).toBeGreaterThan(0);
      });
  });
});

describe('platform-web → GET /platform/commercial/change-requests/{id} (CCP-A3)', () => {
  it('finance_admin reads a pending request with its own step verdict (200)', async () => {
    await provider
      .addInteraction()
      .given('a pending change request exists')
      .uponReceiving('a pending change request detail read by finance_admin')
      .withRequest('GET', fromProviderState(`${CR}/\${requestId}`, `${CR}/${EX_REQUEST_ID}`), (b) => {
        b.headers(platformSession('finance_admin'));
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          request: requestBody('PENDING_APPROVAL', { submitted: true }),
          approvals: [],
          is_expired: false,
          chain_satisfiable: true,
          apply_actionable: false,
          steps: eachLike({
            step_index: integer(0),
            role_key: 'finance_admin',
            scope_keys: eachLike('platform:billing:approve'),
            status: 'NEXT',
            approval_id: null,
            caller: { eligible: true, refusal: null },
          }),
        });
      })
      .executeTest(async (mock) => {
        const res = await call(`${mock.url}${CR}/${EX_REQUEST_ID}`, 'GET', platformSession('finance_admin'));
        expect(res.status).toBe(200);
        expect((res.body['request'] as { state: string }).state).toBe('PENDING_APPROVAL');
      });
  });
});

describe('platform-web → POST /platform/commercial/change-requests/{id}/submit (CCP-A3)', () => {
  it('the requester (commercial_ops) submits a draft (200 PENDING_APPROVAL)', async () => {
    await provider
      .addInteraction()
      .given('a draft change request exists')
      .uponReceiving('a change request submit by its requester')
      .withRequest('POST', fromProviderState(`${CR}/\${requestId}/submit`, `${CR}/${EX_REQUEST_ID}/submit`), (b) => {
        b.headers(platformSession('commercial_ops'));
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ request: requestBody('PENDING_APPROVAL', { submitted: true }) });
      })
      .executeTest(async (mock) => {
        const res = await call(`${mock.url}${CR}/${EX_REQUEST_ID}/submit`, 'POST', platformSession('commercial_ops'));
        expect(res.status).toBe(200);
      });
  });

  it('a role that is not the requester (finance_admin) is refused (403 not_requester)', async () => {
    await provider
      .addInteraction()
      .given('a draft change request exists')
      .uponReceiving('a change request submit by a role that is not the requester')
      .withRequest('POST', fromProviderState(`${CR}/\${requestId}/submit`, `${CR}/${EX_REQUEST_ID}/submit`), (b) => {
        b.headers(platformSession('finance_admin'));
      })
      .willRespondWith(403, (b) => {
        b.jsonBody(errorBody('INSUFFICIENT_PERMISSIONS', { reason: 'not_requester' }));
      })
      .executeTest(async (mock) => {
        const res = await call(`${mock.url}${CR}/${EX_REQUEST_ID}/submit`, 'POST', platformSession('finance_admin'));
        expect(res.status).toBe(403);
      });
  });
});

describe('platform-web → POST /platform/commercial/change-requests/{id}/withdraw (CCP-A3)', () => {
  it('the requester (commercial_ops) withdraws a draft (200 WITHDRAWN)', async () => {
    await provider
      .addInteraction()
      .given('a draft change request exists')
      .uponReceiving('a change request withdraw by its requester')
      .withRequest('POST', fromProviderState(`${CR}/\${requestId}/withdraw`, `${CR}/${EX_REQUEST_ID}/withdraw`), (b) => {
        b.headers(platformSession('commercial_ops'));
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ request: requestBody('WITHDRAWN', { withdrawn: true }) });
      })
      .executeTest(async (mock) => {
        const res = await call(`${mock.url}${CR}/${EX_REQUEST_ID}/withdraw`, 'POST', platformSession('commercial_ops'));
        expect(res.status).toBe(200);
      });
  });
});

describe('platform-web → POST /platform/commercial/change-requests/{id}/approvals (CCP-A3)', () => {
  const approve = (requestId = EX_REQUEST_ID) => `${CR}/${requestId}/approvals`;
  const APPROVE_BODY = { step_index: 0, comment: 'Within the credit policy' };

  it('finance_admin approves step 0 of a finance-only chain (201 APPROVED)', async () => {
    await provider
      .addInteraction()
      .given('a pending change request exists')
      .uponReceiving('a change request approval by finance_admin')
      .withRequest('POST', fromProviderState(`${CR}/\${requestId}/approvals`, approve()), (b) => {
        b.headers(platformJson('finance_admin')).jsonBody(APPROVE_BODY);
      })
      .willRespondWith(201, (b) => {
        b.jsonBody({
          request: requestBody('APPROVED', { submitted: true, approved: true }),
          approval: {
            id: uuid('cca10000-0000-7000-8000-0000000000f1'),
            step_index: 0,
            approver_user_id: OP.finance_admin,
            step_role_key: 'finance_admin',
            step_scope_keys: eachLike('platform:billing:approve'),
            approver_role_keys: ['finance_admin'],
            comment: 'Within the credit policy',
            created_at: iso(),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await call(`${mock.url}${approve()}`, 'POST', platformJson('finance_admin'), APPROVE_BODY);
        expect(res.status).toBe(201);
      });
  });

  it('finance_admin approves step 0 without a comment, as the console sends it (201 APPROVED, CCP-B1)', async () => {
    await provider
      .addInteraction()
      .given('a pending change request exists')
      .uponReceiving('a change request approval by finance_admin from the Approvals inbox')
      .withRequest('POST', fromProviderState(`${CR}/\${requestId}/approvals`, approve()), (b) => {
        b.headers(platformJson('finance_admin')).jsonBody({ step_index: 0 });
      })
      .willRespondWith(201, (b) => {
        b.jsonBody({
          request: requestBody('APPROVED', { submitted: true, approved: true }),
          approval: {
            id: uuid('cca10000-0000-7000-8000-0000000000f2'),
            step_index: 0,
            approver_user_id: OP.finance_admin,
            step_role_key: 'finance_admin',
            step_scope_keys: eachLike('platform:billing:approve'),
            approver_role_keys: ['finance_admin'],
            comment: null,
            created_at: iso(),
          },
          apply: null,
        });
      })
      .executeTest(async (mock) => {
        const res = await call(`${mock.url}${approve()}`, 'POST', platformJson('finance_admin'), { step_index: 0 });
        expect(res.status).toBe(201);
      });
  });

  it('the requester approving their own request is refused (409 SELF_APPROVAL)', async () => {
    await provider
      .addInteraction()
      .given('a pending change request exists')
      .uponReceiving('a change request approval by its own requester')
      .withRequest('POST', fromProviderState(`${CR}/\${requestId}/approvals`, approve()), (b) => {
        b.headers(platformJson('commercial_ops')).jsonBody({ step_index: 0 });
      })
      .willRespondWith(409, (b) => {
        b.jsonBody(approvalRefused('SELF_APPROVAL'));
      })
      .executeTest(async (mock) => {
        const res = await call(`${mock.url}${approve()}`, 'POST', platformJson('commercial_ops'), { step_index: 0 });
        expect(res.status).toBe(409);
      });
  });

  it('a role without the step authority (support_admin) is refused (409 STEP_SCOPE_MISSING)', async () => {
    await provider
      .addInteraction()
      .given('a pending change request exists')
      .uponReceiving('a change request approval by a role without the step authority')
      .withRequest('POST', fromProviderState(`${CR}/\${requestId}/approvals`, approve()), (b) => {
        b.headers(platformJson('support_admin')).jsonBody({ step_index: 0 });
      })
      .willRespondWith(409, (b) => {
        b.jsonBody(approvalRefused('STEP_SCOPE_MISSING'));
      })
      .executeTest(async (mock) => {
        const res = await call(`${mock.url}${approve()}`, 'POST', platformJson('support_admin'), { step_index: 0 });
        expect(res.status).toBe(409);
      });
  });
});

describe('platform-web → POST /platform/commercial/change-requests/{id}/reject (CCP-A3)', () => {
  const REJECT_BODY = { reason: 'Credit not justified' };

  it('finance_admin rejects a pending request (200 REJECTED)', async () => {
    await provider
      .addInteraction()
      .given('a pending change request exists')
      .uponReceiving('a change request rejection by finance_admin')
      .withRequest('POST', fromProviderState(`${CR}/\${requestId}/reject`, `${CR}/${EX_REQUEST_ID}/reject`), (b) => {
        b.headers(platformJson('finance_admin')).jsonBody(REJECT_BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ request: requestBody('REJECTED', { submitted: true, rejected: true }) });
      })
      .executeTest(async (mock) => {
        const res = await call(`${mock.url}${CR}/${EX_REQUEST_ID}/reject`, 'POST', platformJson('finance_admin'), REJECT_BODY);
        expect(res.status).toBe(200);
      });
  });

  it('a role without the step authority (support_admin) is refused (409 STEP_SCOPE_MISSING)', async () => {
    await provider
      .addInteraction()
      .given('a pending change request exists')
      .uponReceiving('a change request rejection by a role without the step authority')
      .withRequest('POST', fromProviderState(`${CR}/\${requestId}/reject`, `${CR}/${EX_REQUEST_ID}/reject`), (b) => {
        b.headers(platformJson('support_admin')).jsonBody(REJECT_BODY);
      })
      .willRespondWith(409, (b) => {
        b.jsonBody(approvalRefused('STEP_SCOPE_MISSING'));
      })
      .executeTest(async (mock) => {
        const res = await call(`${mock.url}${CR}/${EX_REQUEST_ID}/reject`, 'POST', platformJson('support_admin'), REJECT_BODY);
        expect(res.status).toBe(409);
      });
  });
});

// ── CCP-A6 — the transactional apply ──────────────────────────────────────────

describe('platform-web → POST /platform/commercial/change-requests/{id}/apply (CCP-A6)', () => {
  const apply = (requestId = EX_REQUEST_ID) => `${CR}/${requestId}/apply`;
  const applied = {
    replayed: false,
    request: {
      id: uuid(EX_REQUEST_ID),
      action_type: 'SUBSCRIPTION_OPEN',
      kind: 'NORMAL',
      state: 'APPLIED',
      tenant_id: uuid('cca10000-0000-7000-8000-0000000000a6'),
      product_key: 'sign',
      payload: like({ plan_key: 'aramo-sign-included-v1' }),
      requested_by: OP.commercial_ops,
      approved_at: iso(),
    },
    application: {
      id: uuid('cca10000-0000-7000-8000-0000000000a7'),
      change_request_id: uuid(EX_REQUEST_ID),
      action_type: 'SUBSCRIPTION_OPEN',
      tenant_id: uuid('cca10000-0000-7000-8000-0000000000a6'),
      product_key: 'sign',
      subscription_id: uuid('cca10000-0000-7000-8000-0000000000a8'),
      replaced_subscription_id: null,
      from_plan_version_id: null,
      to_plan_version_id: uuid('cca10000-0000-7000-8000-0000000000a9'),
      capabilities: ['core', 'sign'],
      capabilities_inserted: eachLike('sign'),
      attempt: 1,
      applied_by: OP.commercial_ops,
      applied_at: iso(),
    },
  };

  it('the requester authority (commercial_ops) applies an approved subscription open (200 APPLIED)', async () => {
    await provider
      .addInteraction()
      .given('an approved subscription-open change request exists')
      .uponReceiving('a change request apply by commercial_ops')
      .withRequest('POST', fromProviderState(`${CR}/\${requestId}/apply`, apply()), (b) => {
        b.headers(platformSession('commercial_ops'));
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(applied);
      })
      .executeTest(async (mock) => {
        const res = await call(`${mock.url}${apply()}`, 'POST', platformSession('commercial_ops'));
        expect(res.status).toBe(200);
      });
  });

  it('the requester reads an approved request with apply_actionable true; an approver reads it false (CCP-A6-R TD-B2-3)', async () => {
    for (const [role, actionable] of [['commercial_ops', true], ['finance_admin', false]] as const) {
      await provider
        .addInteraction()
        .given('an approved subscription-open change request exists')
        .uponReceiving(`an approved change request detail read by ${role}`)
        .withRequest('GET', fromProviderState(`${CR}/\${requestId}`, `${CR}/${EX_REQUEST_ID}`), (b) => {
          b.headers(platformSession(role));
        })
        .willRespondWith(200, (b) => {
          b.jsonBody({ request: { id: uuid(EX_REQUEST_ID), action_type: 'SUBSCRIPTION_OPEN', state: 'APPROVED', requested_by: OP.commercial_ops }, apply_actionable: actionable });
        })
        .executeTest(async (mock) => {
          const res = await call(`${mock.url}${CR}/${EX_REQUEST_ID}`, 'GET', platformSession(role));
          expect(res.body['apply_actionable']).toBe(actionable);
        });
    }
  });

  it('a user who is not the original requester (finance_admin) is refused (403 not_requester; CCP-A6-R TD-A6-3)', async () => {
    await provider
      .addInteraction()
      .given('an approved subscription-open change request exists')
      .uponReceiving('a change request apply by a user who is not its requester')
      .withRequest('POST', fromProviderState(`${CR}/\${requestId}/apply`, apply()), (b) => {
        b.headers(platformSession('finance_admin'));
      })
      .willRespondWith(403, (b) => {
        b.jsonBody(errorBody('INSUFFICIENT_PERMISSIONS', { reason: 'not_requester', explanation: like('Only the person who requested this change can apply it.') }));
      })
      .executeTest(async (mock) => {
        const res = await call(`${mock.url}${apply()}`, 'POST', platformSession('finance_admin'));
        expect(res.status).toBe(403);
      });
  });

  it('an approval whose signer lost eligibility is refused at apply (409 apply_refused, NC-5)', async () => {
    await provider
      .addInteraction()
      .given('an approved subscription-open change request whose approver lost eligibility exists')
      .uponReceiving('a change request apply after its approver lost eligibility')
      .withRequest('POST', fromProviderState(`${CR}/\${requestId}/apply`, apply()), (b) => {
        b.headers(platformSession('commercial_ops'));
      })
      .willRespondWith(409, (b) => {
        b.jsonBody(errorBody('COMMERCIAL_CHANGE_REQUEST_CONFLICT', { reason: 'apply_refused', refusal: 'APPROVER_NO_LONGER_ELIGIBLE', explanation: like('An approver no longer holds the role.') }));
      })
      .executeTest(async (mock) => {
        const res = await call(`${mock.url}${apply()}`, 'POST', platformSession('commercial_ops'));
        expect(res.status).toBe(409);
      });
  });
});

// ── CCP-D1 — usage roll-ups (read-only until reconciled) ──────────────────────

const usageCounts = (c: number, r: number) => ({ consumed: integer(c), consumed_send: integer(c), consumed_historical: integer(0), reserved: integer(r) });

describe('platform-web → GET /platform/commercial/usage/reconciliation (CCP-D1)', () => {
  it('read_only_auditor reads the reconciliation (200 RECONCILED)', async () => {
    await provider
      .addInteraction()
      .given('usage roll-ups are reconciled')
      .uponReceiving('a usage reconciliation read by a read-only auditor')
      .withRequest('GET', USAGE_REC, (b) => {
        b.headers(platformSession('read_only_auditor')).query({ product_key: 'sign' });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          product_key: 'sign',
          status: 'RECONCILED',
          checked_at: iso(),
          metrics: eachLike({
            metric_key: 'sign.envelopes',
            product_key: 'sign',
            status: 'RECONCILED',
            watermark: regex('^[0-9]+$', '801'),
            last_run_id: uuid('01a1730b-0099-70ec-a374-cb6339bc34fb'),
            buckets: { source: integer(2), rollup: integer(2), pending: integer(0), compared: integer(2), mismatched: 0 },
            compared_totals: { allowance_usage: usageCounts(5, 1), rollup: usageCounts(5, 1) },
            usage_event: { event_type: 'sign.envelope.sent', tenants: integer(1), mismatched_tenants: 0, allowance_usage_consumed_send: integer(5), usage_event_quantity: integer(5) },
            mismatch_count: 0,
            mismatches: [],
          }),
        });
      })
      .executeTest(async (mock) => {
        const res = await call(`${mock.url}${USAGE_REC}?product_key=sign`, 'GET', platformSession('read_only_auditor'));
        expect(res.status).toBe(200);
        expect(res.body['status']).toBe('RECONCILED');
      });
  });

  it('a role without platform:subscription:read (catalog_manager) is refused (403)', async () => {
    await provider
      .addInteraction()
      .given('platform operators are provisioned')
      .uponReceiving('a usage reconciliation read by a role missing the subscription read scope')
      .withRequest('GET', USAGE_REC, (b) => {
        b.headers(platformSession('catalog_manager'));
      })
      .willRespondWith(403, (b) => {
        b.jsonBody(missingScope('platform:subscription:read'));
      })
      .executeTest(async (mock) => {
        const res = await call(`${mock.url}${USAGE_REC}`, 'GET', platformSession('catalog_manager'));
        expect(res.status).toBe(403);
      });
  });
});

describe('platform-web → GET /platform/commercial/usage/periods (CCP-D1)', () => {
  it('finance_admin reads a tenant\'s consumption per billing period (200)', async () => {
    await provider
      .addInteraction()
      .given('usage roll-ups are reconciled')
      .uponReceiving('a usage periods read by a finance admin')
      .withRequest('GET', USAGE_PERIODS, (b) => {
        b.headers(platformSession('finance_admin')).query({ product_key: 'sign', metric_key: 'sign.envelopes', tenant_id: USAGE_TENANT });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          product_key: 'sign',
          reconciliation: { status: 'RECONCILED', checked_at: iso() },
          truncated: false,
          periods: eachLike({
            tenant_id: USAGE_TENANT,
            metric_key: 'sign.envelopes',
            product_key: 'sign',
            period_start: iso('2026-10-01T00:00:00.000Z'),
            period_end: iso('2026-11-01T00:00:00.000Z'),
            alignment: 'ALIGNED',
            subscription_id: USAGE_SUBSCRIPTION,
            plan_version_id: uuid('cca10000-0000-7000-8000-0000000000d3'),
            included_quantity: integer(100),
            unlimited: false,
            counts: usageCounts(3, 1),
            stale: false,
            computed_at: iso(),
          }),
        });
      })
      .executeTest(async (mock) => {
        const res = await call(`${mock.url}${USAGE_PERIODS}?product_key=sign&metric_key=sign.envelopes&tenant_id=${USAGE_TENANT}`, 'GET', platformSession('finance_admin'));
        expect(res.status).toBe(200);
        expect((res.body['periods'] as unknown[]).length).toBeGreaterThan(0);
      });
  });

  it('analytics are refused while the roll-ups do not reconcile (409 USAGE_ROLLUP_NOT_RECONCILED)', async () => {
    await provider
      .addInteraction()
      .given('usage roll-ups do not reconcile')
      .uponReceiving('a usage periods read while the roll-ups do not reconcile')
      .withRequest('GET', USAGE_PERIODS, (b) => {
        b.headers(platformSession('commercial_ops'));
      })
      .willRespondWith(409, (b) => {
        b.jsonBody(errorBody('USAGE_ROLLUP_NOT_RECONCILED', { status: 'NOT_RECONCILED', mismatch_count: integer(1), checked_at: iso() }));
      })
      .executeTest(async (mock) => {
        const res = await call(`${mock.url}${USAGE_PERIODS}`, 'GET', platformSession('commercial_ops'));
        expect(res.status).toBe(409);
        expect(errCode(res.body)).toBe('USAGE_ROLLUP_NOT_RECONCILED');
      });
  });
});

// ── CCP-B2-backend — the catalog publish through the same apply route ─────────

describe('platform-web → POST /platform/commercial/change-requests/{id}/apply (CCP-B2-backend catalog publish)', () => {
  it('the requester (catalog_manager) applies an approved plan-version publish (200, catalog_application)', async () => {
    const path = `${CR}/${EX_REQUEST_ID}/apply`;
    await provider
      .addInteraction()
      .given('an approved plan-version publish change request exists')
      .uponReceiving('a plan-version publish apply by catalog_manager')
      .withRequest('POST', fromProviderState(`${CR}/\${requestId}/apply`, path), (b) => {
        b.headers(platformSession('catalog_manager'));
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          replayed: false,
          application: null,
          request: { id: uuid(EX_REQUEST_ID), action_type: 'PLAN_VERSION_PUBLISH', state: 'APPLIED', tenant_id: null, product_key: null, requested_by: OP.catalog_manager },
          catalog_application: {
            id: uuid('cca10000-0000-7000-8000-0000000000b7'),
            change_request_id: uuid(EX_REQUEST_ID),
            action_type: 'PLAN_VERSION_PUBLISH',
            plan_id: uuid('cca10000-0000-7000-8000-0000000000b8'),
            plan_version_id: uuid('cca10000-0000-7000-8000-0000000000b9'),
            retired_plan_version_id: uuid('cca10000-0000-7000-8000-0000000000ba'),
            provider_price_ref: null,
            attempt: 1,
            applied_by: OP.catalog_manager,
            applied_at: iso(),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await call(`${mock.url}${path}`, 'POST', platformSession('catalog_manager'));
        expect(res.status).toBe(200);
      });
  });
});

// ── gate refusals on every CCP route: super_admin and the tenant tier ─────────

// ── CCP-B4 — enterprise contract records (read-only) ──────────────────────────

// CommercialContractSummaryDto (platform-commercial-contract.controller.ts summaryDto). The
// provider state records the contract through the governed path (an applied
// SUBSCRIPTION_OPEN carrying a `contract` block) on the included operator plan, which has
// no commitment term.
const CONTRACT_SUMMARY = {
  id: uuid(EX_CONTRACT_ID),
  contract_ref: regex('^[A-Z][A-Z0-9-]{2,39}$', 'CT-2026-021'),
  tenant: { id: uuid('cca10000-0000-7000-8000-0000000000b5'), name: like('Pact Commercial 00b5'), slug: null },
  product_key: 'sign',
  status: 'ACTIVE',
  subscription: {
    id: uuid('cca10000-0000-7000-8000-0000000000b6'),
    source: 'MANUAL',
    status: 'ACTIVE',
    ended_at: null,
    commitment_start: null,
    commitment_end: null,
    plan: { key: 'aramo-sign-included-v1', name: like('Aramo Sign included') },
    plan_version: { id: uuid('cca10000-0000-7000-8000-0000000000b7'), version_number: integer(1), status: 'PUBLISHED' },
  },
  provenance: 'CHANGE_REQUEST',
  recorded_at: iso(),
};
const PERSON = { user_id: uuid(OP.commercial_ops), display_name: null, email: like(`${OP.commercial_ops}@ops.test`) };

describe('platform-web → GET /platform/commercial/contracts (CCP-B4)', () => {
  it('commercial_ops lists the contract records (200)', async () => {
    await provider
      .addInteraction()
      .given('an enterprise contract exists')
      .uponReceiving('a contract list read by commercial_ops')
      .withRequest('GET', CONTRACTS, (b) => {
        b.headers(platformSession('commercial_ops')).query({ status: 'ACTIVE' });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ contracts: eachLike(CONTRACT_SUMMARY) });
      })
      .executeTest(async (mock) => {
        const res = await call(`${mock.url}${CONTRACTS}?status=ACTIVE`, 'GET', platformSession('commercial_ops'));
        expect(res.status).toBe(200);
        expect((res.body['contracts'] as unknown[]).length).toBeGreaterThan(0);
      });
  });

  it('a role without platform:subscription:read (catalog_manager) is refused (403)', async () => {
    await provider
      .addInteraction()
      .given('platform operators are provisioned')
      .uponReceiving('a contract list read by a role missing the subscription read scope')
      .withRequest('GET', CONTRACTS, (b) => {
        b.headers(platformSession('catalog_manager'));
      })
      .willRespondWith(403, (b) => {
        b.jsonBody(missingScope('platform:subscription:read'));
      })
      .executeTest(async (mock) => {
        const res = await call(`${mock.url}${CONTRACTS}`, 'GET', platformSession('catalog_manager'));
        expect(res.status).toBe(403);
        expect(errCode(res.body)).toBe('INSUFFICIENT_PERMISSIONS');
      });
  });
});

describe('platform-web → GET /platform/commercial/contracts/{id} (CCP-B4)', () => {
  it('finance_admin reads a contract with its terms, hashed documents and amendments (200)', async () => {
    await provider
      .addInteraction()
      .given('an enterprise contract exists')
      .uponReceiving('a contract detail read by finance_admin')
      .withRequest('GET', fromProviderState(`${CONTRACTS}/\${contractId}`, `${CONTRACTS}/${EX_CONTRACT_ID}`), (b) => {
        b.headers(platformSession('finance_admin'));
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          ...CONTRACT_SUMMARY,
          terms: eachLike('Invoiced monthly, net 30'),
          recorded_terms: eachLike('Invoiced monthly, net 30'),
          evidence_ref: like('Order form OF-8034'),
          recorded_by: PERSON,
          recorded_by_change_request_id: uuid(EX_REQUEST_ID),
          documents: eachLike({
            name: like('Order form OF-8034.pdf'),
            sha256: HEX64(),
            byte_size: integer(1024),
            media_type: like('application/pdf'),
            recorded_by: PERSON,
            recorded_at: iso(),
            amendment_sequence: null,
          }),
          amendments: [],
          invoicing: { enabled: false, reason: 'enterprise_invoicing_choice_pending' },
        });
      })
      .executeTest(async (mock) => {
        const res = await call(`${mock.url}${CONTRACTS}/${EX_CONTRACT_ID}`, 'GET', platformSession('finance_admin'));
        expect(res.status).toBe(200);
        expect((res.body['invoicing'] as { enabled: boolean }).enabled).toBe(false);
      });
  });

  it('an unknown contract is 404', async () => {
    await provider
      .addInteraction()
      .given('platform operators are provisioned')
      .uponReceiving('a contract detail read for an unknown id')
      .withRequest('GET', `${CONTRACTS}/${EX_CONTRACT_ID}`, (b) => {
        b.headers(platformSession('read_only_auditor'));
      })
      .willRespondWith(404, (b) => {
        b.jsonBody(errorBody('NOT_FOUND', { contract_id: EX_CONTRACT_ID }));
      })
      .executeTest(async (mock) => {
        const res = await call(`${mock.url}${CONTRACTS}/${EX_CONTRACT_ID}`, 'GET', platformSession('read_only_auditor'));
        expect(res.status).toBe(404);
      });
  });

  it('a role without platform:subscription:read (catalog_manager) is refused (403)', async () => {
    await provider
      .addInteraction()
      .given('platform operators are provisioned')
      .uponReceiving('a contract detail read by a role missing the subscription read scope')
      .withRequest('GET', `${CONTRACTS}/${EX_CONTRACT_ID}`, (b) => {
        b.headers(platformSession('catalog_manager'));
      })
      .willRespondWith(403, (b) => {
        b.jsonBody(missingScope('platform:subscription:read'));
      })
      .executeTest(async (mock) => {
        const res = await call(`${mock.url}${CONTRACTS}/${EX_CONTRACT_ID}`, 'GET', platformSession('catalog_manager'));
        expect(res.status).toBe(403);
      });
  });
});

describe('platform-web → every CCP route refuses super_admin (403, no commercial scope)', () => {
  for (const r of GATE_ROUTES) {
    it(`${r.name} → 403 missing ${r.scope}`, async () => {
      const headers = r.body === undefined ? platformSession('super_admin') : platformJson('super_admin');
      await provider
        .addInteraction()
        .given('platform operators are provisioned')
        .uponReceiving(`${r.name} by super_admin`)
        .withRequest(r.method, r.path, (b) => {
          b.headers(headers);
          if (r.body !== undefined) b.jsonBody(r.body);
        })
        .willRespondWith(403, (b) => {
          b.jsonBody(missingScope(r.scope));
        })
        .executeTest(async (mock) => {
          const res = await call(`${mock.url}${r.path}`, r.method, headers, r.body);
          expect(res.status).toBe(403);
          expect(errCode(res.body)).toBe('INSUFFICIENT_PERMISSIONS');
        });
    });
  }
});

describe('platform-web → every CCP route refuses the tenant tier (403 tier tripwire)', () => {
  for (const r of GATE_ROUTES) {
    it(`${r.name} → 403 tenant_token_on_platform_route`, async () => {
      const headers = r.body === undefined ? TENANT_TIER : TENANT_TIER_JSON;
      await provider
        .addInteraction()
        .given('platform operators are provisioned')
        .uponReceiving(`${r.name} with a tenant-tier session`)
        .withRequest(r.method, r.path, (b) => {
          b.headers(headers);
          if (r.body !== undefined) b.jsonBody(r.body);
        })
        .willRespondWith(403, (b) => {
          b.jsonBody(TIER_REFUSED);
        })
        .executeTest(async (mock) => {
          const res = await call(`${mock.url}${r.path}`, r.method, headers, r.body);
          expect(res.status).toBe(403);
        });
    });
  }
});

// ── non-CCP (optional) ────────────────────────────────────────────────────────

describe('platform-web → GET /platform/me', () => {
  it('an operator reads their own identity (200)', async () => {
    await provider
      .addInteraction()
      .given('platform operators are provisioned')
      .uponReceiving('a caller identity read by platform_owner')
      .withRequest('GET', '/platform/me', (b) => {
        b.headers(platformSession('platform_owner'));
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          user_id: OP.platform_owner,
          email: like(`${OP.platform_owner}@ops.test`),
          display_name: null,
          tenant_id: PLATFORM_TENANT,
          tenant_name: like('Aramo Platform'),
          role_keys: ['platform_owner'],
        });
      })
      .executeTest(async (mock) => {
        const res = await call(`${mock.url}/platform/me`, 'GET', platformSession('platform_owner'));
        expect(res.status).toBe(200);
        expect(res.body['user_id']).toBe(OP.platform_owner);
      });
  });
});
