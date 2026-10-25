import { resolve } from 'node:path';

import { MatchersV3, PactV4 } from '@pact-foundation/pact';
import { describe, expect, it } from 'vitest';

const { boolean, eachLike, fromProviderState, integer, like, regex, uuid } = MatchersV3;

// CCP-B2 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.3 row B2; the common B-row
// obligation "Pact consumer contracts for every route the screen calls"; CCP-A10 §5
// "Extending the contracts") — the platform console's Catalog screen contract with
// platform-admin for the 4 catalog routes, allowed AND refused. Written to the SAME pact file
// as platform-commercial.consumer.test.ts (platform-web → platform-admin); the verifier's CCP
// route coverage gate requires each route to hold an allowed, a super_admin and a tenant-tier
// interaction.
//
// The Catalog screen ALSO calls POST /platform/commercial/change-requests (PLAN_VERSION_PUBLISH
// / PLAN_RETIRE) and POST …/{id}/submit to request publish and retire; this file adds the
// catalog_manager PLAN_VERSION_PUBLISH create interaction (the chain the screen relies on). The
// approval steps are contracted in platform-commercial.consumer.test.ts.
//
// Coverage — CCP-B2 routes (4):
//   GET   /platform/commercial/catalog
//   GET   /platform/commercial/catalog/versions/{versionId}
//   POST  /platform/commercial/catalog/plans/{planId}/drafts
//   PATCH /platform/commercial/catalog/versions/{versionId}
// Request shapes are byte-aligned with apps/platform-web/src/commercial/catalog/catalog-api.ts.

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

const POLICY_V1 = '019a0000-0000-7000-8000-0000000cc201';
// Example ids for provider-state-injected ids (and for the gate refusals, which are answered
// before any lookup).
const EX_PLAN_ID = 'ccb20000-0000-7000-8000-0000000000a1';
const EX_VERSION_ID = 'ccb20000-0000-7000-8000-0000000000b1';
const EX_DRAFT_ID = 'ccb20000-0000-7000-8000-0000000000d1';
const UNKNOWN_VERSION_ID = 'ccb20000-0000-7000-8000-0000000000ff';
const EX_CHECKSUM = 'c'.repeat(64);

const CAT = '/platform/commercial/catalog';
const CR = '/platform/commercial/change-requests';

const platformSession = (role: Role) => ({ 'X-Aramo-Consumer': 'platform', Cookie: `aramo_access_token_platform=pact-${role}` });
const platformJson = (role: Role) => ({ ...platformSession(role), 'Content-Type': 'application/json' });
const TENANT_TIER = { 'X-Aramo-Consumer': 'recruiter', Cookie: 'aramo_access_token_recruiter=pact-recruiter' };
const TENANT_TIER_JSON = { ...TENANT_TIER, 'Content-Type': 'application/json' };

const ISO = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$';
const iso = (example = '2026-10-25T10:00:00.000Z') => regex(ISO, example);
const HEX64 = (example = EX_CHECKSUM) => regex('^[0-9a-f]{64}$', example);
const STATUS = (example: 'DRAFT' | 'PUBLISHED' | 'RETIRED') => regex('^(DRAFT|PUBLISHED|RETIRED)$', example);

// The always-present (never null) fields of a version's terms; nullable terms vary per plan
// (an unlimited allowance, a contract-priced plan) and are not pinned by type here.
const TERMS = like({
  sales_model: like('SELF_SERVICE'),
  contract_priced: boolean(false),
  envelopes_unlimited: boolean(false),
  envelopes_present: boolean(true),
  storage_unlimited: boolean(false),
  storage_present: boolean(true),
});

function versionBody(o: { id?: unknown; status?: 'DRAFT' | 'PUBLISHED' | 'RETIRED'; version_number?: number } = {}): Record<string, unknown> {
  return {
    id: o.id ?? uuid(EX_VERSION_ID),
    plan_id: uuid(EX_PLAN_ID),
    version_number: integer(o.version_number ?? 1),
    status: o.status === undefined ? STATUS('PUBLISHED') : o.status,
    content_checksum: HEX64(),
    created_by: like('catalog_manager'),
    created_at: iso(),
    terms: TERMS,
    pinned_subscriptions: integer(0),
  };
}

const PLAN = {
  id: uuid(EX_PLAN_ID),
  key: like('aramo-sign-standard-business-v1'),
  product_key: 'sign',
  name: like('Standard Business'),
  status: like('ACTIVE'),
  sales_model: like('SELF_SERVICE'),
  sellable: boolean(true),
  display_order: integer(20),
};

// The Phase 5 error envelope (AramoExceptionFilter).
function errorBody(code: string, details: unknown): Record<string, unknown> {
  return { error: { code, message: like('refused'), request_id: like('req-1'), details } };
}
const missingScope = (scope: string) => errorBody('INSUFFICIENT_PERMISSIONS', { missing_scopes: [scope] });
const TIER_REFUSED = errorBody('INSUFFICIENT_PERMISSIONS', { reason: 'tenant_token_on_platform_route' });
const catalogConflict = (reason: string) => errorBody('COMMERCIAL_CATALOG_CONFLICT', { reason });

async function call(url: string, method: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  return { status: res.status, body: (text.length > 0 ? JSON.parse(text) : {}) as Record<string, unknown> };
}
const errCode = (b: Record<string, unknown>) => (b['error'] as { code?: string } | undefined)?.code;
const errReason = (b: Record<string, unknown>) => (b['error'] as { details?: { reason?: string } } | undefined)?.details?.reason;

interface GateRoute {
  name: string;
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  scope: string;
  body?: Record<string, unknown>;
}
const PATCH_BODY = { expected_content_checksum: EX_CHECKSUM, list_price_minor: 2400 };
const GATE_ROUTES: readonly GateRoute[] = [
  { name: 'GET catalog', method: 'GET', path: CAT, scope: 'platform:catalog:read' },
  { name: 'GET catalog/versions/{versionId}', method: 'GET', path: `${CAT}/versions/${EX_VERSION_ID}`, scope: 'platform:catalog:read' },
  { name: 'POST catalog/plans/{planId}/drafts', method: 'POST', path: `${CAT}/plans/${EX_PLAN_ID}/drafts`, scope: 'platform:catalog:draft', body: { from_version_id: EX_VERSION_ID } },
  { name: 'PATCH catalog/versions/{versionId}', method: 'PATCH', path: `${CAT}/versions/${EX_VERSION_ID}`, scope: 'platform:catalog:draft', body: PATCH_BODY },
];

// ── GET /platform/commercial/catalog ──────────────────────────────────────────

describe('platform-web → GET /platform/commercial/catalog (CCP-B2)', () => {
  it('read_only_auditor reads the catalog: the sign registry, its plans and versions, and the publish chain (200)', async () => {
    await provider
      .addInteraction()
      .given('the Sign catalog holds its published v1 versions')
      .uponReceiving('a catalog read by a read-only auditor')
      .withRequest('GET', CAT, (b) => {
        b.headers(platformSession('read_only_auditor'));
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          products: eachLike({ product_key: 'sign', plans: eachLike({ ...PLAN, versions: eachLike(versionBody()) }) }),
          publish_chain: {
            rule: 'FINANCE_THEN_OWNER',
            step_role_keys: ['finance_admin', 'platform_owner'],
            policy_version_id: uuid(POLICY_V1),
            policy_version_number: integer(1),
            approval_expiry_hours: integer(72),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await call(`${mock.url}${CAT}`, 'GET', platformSession('read_only_auditor'));
        expect(res.status).toBe(200);
        expect((res.body['products'] as { product_key: string }[])[0]?.product_key).toBe('sign');
      });
  });
});

// ── GET /platform/commercial/catalog/versions/{versionId} ─────────────────────

describe('platform-web → GET /platform/commercial/catalog/versions/{versionId} (CCP-B2)', () => {
  it('commercial_ops reads a published version with its pinned tenants (200)', async () => {
    await provider
      .addInteraction()
      .given('a published plan version with a pinned subscription exists')
      .uponReceiving('a plan version read by commercial ops')
      .withRequest('GET', fromProviderState(`${CAT}/versions/\${versionId}`, `${CAT}/versions/${EX_VERSION_ID}`), (b) => {
        b.headers(platformSession('commercial_ops'));
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          version: { ...versionBody({ status: 'PUBLISHED' }), pinned_subscriptions: integer(1) },
          plan: PLAN,
          content: like({ format: 1 }),
          pinned_tenants: eachLike({ tenant_id: uuid('ccb20000-0000-7000-8000-0000000000c1'), name: like('Pact Catalog Tenant') }),
        });
      })
      .executeTest(async (mock) => {
        const res = await call(`${mock.url}${CAT}/versions/${EX_VERSION_ID}`, 'GET', platformSession('commercial_ops'));
        expect(res.status).toBe(200);
      });
  });

  it('an unknown version → 404 NOT_FOUND', async () => {
    await provider
      .addInteraction()
      .given('platform operators are provisioned')
      .uponReceiving('a read of an unknown plan version')
      .withRequest('GET', `${CAT}/versions/${UNKNOWN_VERSION_ID}`, (b) => {
        b.headers(platformSession('read_only_auditor'));
      })
      .willRespondWith(404, (b) => {
        b.jsonBody(errorBody('NOT_FOUND', like({})));
      })
      .executeTest(async (mock) => {
        const res = await call(`${mock.url}${CAT}/versions/${UNKNOWN_VERSION_ID}`, 'GET', platformSession('read_only_auditor'));
        expect(res.status).toBe(404);
      });
  });
});

// ── POST /platform/commercial/catalog/plans/{planId}/drafts ───────────────────

describe('platform-web → POST /platform/commercial/catalog/plans/{planId}/drafts (CCP-B2)', () => {
  it('catalog_manager creates a draft from the published version (201)', async () => {
    await provider
      .addInteraction()
      .given('a plan without a draft version exists')
      .uponReceiving('a draft creation by a catalog manager')
      .withRequest('POST', fromProviderState(`${CAT}/plans/\${planId}/drafts`, `${CAT}/plans/${EX_PLAN_ID}/drafts`), (b) => {
        b.headers(platformJson('catalog_manager')).jsonBody({ from_version_id: fromProviderState('${versionId}', EX_VERSION_ID) });
      })
      .willRespondWith(201, (b) => {
        b.jsonBody({ version: versionBody({ id: uuid(EX_DRAFT_ID), status: 'DRAFT', version_number: 2 }) });
      })
      .executeTest(async (mock) => {
        const res = await call(`${mock.url}${CAT}/plans/${EX_PLAN_ID}/drafts`, 'POST', platformJson('catalog_manager'), { from_version_id: EX_VERSION_ID });
        expect(res.status).toBe(201);
      });
  });

  it('a second draft on the same plan → 409 COMMERCIAL_CATALOG_CONFLICT draft_exists', async () => {
    await provider
      .addInteraction()
      .given('a draft plan version exists')
      .uponReceiving('a second draft on a plan that already has one')
      .withRequest('POST', fromProviderState(`${CAT}/plans/\${planId}/drafts`, `${CAT}/plans/${EX_PLAN_ID}/drafts`), (b) => {
        b.headers(platformJson('catalog_manager')).jsonBody({ from_version_id: fromProviderState('${publishedVersionId}', EX_VERSION_ID) });
      })
      .willRespondWith(409, (b) => {
        b.jsonBody(catalogConflict('draft_exists'));
      })
      .executeTest(async (mock) => {
        const res = await call(`${mock.url}${CAT}/plans/${EX_PLAN_ID}/drafts`, 'POST', platformJson('catalog_manager'), { from_version_id: EX_VERSION_ID });
        expect(res.status).toBe(409);
        expect(errReason(res.body)).toBe('draft_exists');
      });
  });

  it('finance_admin (no platform:catalog:draft) → 403', async () => {
    const body = { from_version_id: EX_VERSION_ID };
    await provider
      .addInteraction()
      .given('platform operators are provisioned')
      .uponReceiving('a draft creation by a role without the draft scope')
      .withRequest('POST', `${CAT}/plans/${EX_PLAN_ID}/drafts`, (b) => {
        b.headers(platformJson('finance_admin')).jsonBody(body);
      })
      .willRespondWith(403, (b) => {
        b.jsonBody(missingScope('platform:catalog:draft'));
      })
      .executeTest(async (mock) => {
        const res = await call(`${mock.url}${CAT}/plans/${EX_PLAN_ID}/drafts`, 'POST', platformJson('finance_admin'), body);
        expect(res.status).toBe(403);
      });
  });
});

// ── PATCH /platform/commercial/catalog/versions/{versionId} ───────────────────

describe('platform-web → PATCH /platform/commercial/catalog/versions/{versionId} (CCP-B2)', () => {
  it('catalog_manager edits a draft price (200)', async () => {
    await provider
      .addInteraction()
      .given('a draft plan version exists')
      .uponReceiving('a draft edit by a catalog manager')
      .withRequest('PATCH', fromProviderState(`${CAT}/versions/\${versionId}`, `${CAT}/versions/${EX_DRAFT_ID}`), (b) => {
        b.headers(platformJson('catalog_manager')).jsonBody({ expected_content_checksum: fromProviderState('${checksum}', EX_CHECKSUM), list_price_minor: 2400 });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ version: { ...versionBody({ id: uuid(EX_DRAFT_ID), status: 'DRAFT', version_number: 2 }), terms: like({ list_price_minor: 2400, contract_priced: boolean(false) }) } });
      })
      .executeTest(async (mock) => {
        const res = await call(`${mock.url}${CAT}/versions/${EX_DRAFT_ID}`, 'PATCH', platformJson('catalog_manager'), PATCH_BODY);
        expect(res.status).toBe(200);
      });
  });

  it('an edit of a PUBLISHED version → 409 COMMERCIAL_CATALOG_CONFLICT not_draft (published versions are immutable)', async () => {
    await provider
      .addInteraction()
      .given('a published plan version with a pinned subscription exists')
      .uponReceiving('an edit of a published plan version')
      .withRequest('PATCH', fromProviderState(`${CAT}/versions/\${versionId}`, `${CAT}/versions/${EX_VERSION_ID}`), (b) => {
        b.headers(platformJson('catalog_manager')).jsonBody({ expected_content_checksum: fromProviderState('${checksum}', EX_CHECKSUM), list_price_minor: 2400 });
      })
      .willRespondWith(409, (b) => {
        b.jsonBody(catalogConflict('not_draft'));
      })
      .executeTest(async (mock) => {
        const res = await call(`${mock.url}${CAT}/versions/${EX_VERSION_ID}`, 'PATCH', platformJson('catalog_manager'), PATCH_BODY);
        expect(res.status).toBe(409);
        expect(errReason(res.body)).toBe('not_draft');
      });
  });

  it('read_only_auditor (no platform:catalog:draft) → 403', async () => {
    await provider
      .addInteraction()
      .given('platform operators are provisioned')
      .uponReceiving('a draft edit by a role without the draft scope')
      .withRequest('PATCH', `${CAT}/versions/${EX_VERSION_ID}`, (b) => {
        b.headers(platformJson('read_only_auditor')).jsonBody(PATCH_BODY);
      })
      .willRespondWith(403, (b) => {
        b.jsonBody(missingScope('platform:catalog:draft'));
      })
      .executeTest(async (mock) => {
        const res = await call(`${mock.url}${CAT}/versions/${EX_VERSION_ID}`, 'PATCH', platformJson('read_only_auditor'), PATCH_BODY);
        expect(res.status).toBe(403);
      });
  });
});

// ── the publish request the Catalog screen submits (CCP-A3 surface) ───────────

describe('platform-web → POST /platform/commercial/change-requests (PLAN_VERSION_PUBLISH, CCP-B2 screen)', () => {
  it('catalog_manager requests publishing a draft: a DRAFT change request on the Finance → Owner chain (201)', async () => {
    await provider
      .addInteraction()
      .given('a draft plan version exists')
      .uponReceiving('a publish request for a draft plan version by a catalog manager')
      .withRequest('POST', CR, (b) => {
        b.headers(platformJson('catalog_manager')).jsonBody({
          action_type: 'PLAN_VERSION_PUBLISH',
          payload: { plan_version_id: fromProviderState('${versionId}', EX_DRAFT_ID), evidence: 'Pricing review PR-2026-Q4' },
          reason: 'Annual price review',
          idempotency_key: 'pact-b2-publish-0001',
        });
      })
      .willRespondWith(201, (b) => {
        b.jsonBody({
          request: like({
            id: uuid('ccb20000-0000-7000-8000-0000000000e1'),
            action_type: 'PLAN_VERSION_PUBLISH',
            state: 'DRAFT',
            tenant_id: null,
            product_key: null,
            required_chain: { rule: 'FINANCE_THEN_OWNER', basis: like({}), steps: [like({ step_index: 0, role_key: 'finance_admin' }), like({ step_index: 1, role_key: 'platform_owner' })] },
            policy_version_id: POLICY_V1,
            requested_by: OP.catalog_manager,
          }),
          replayed: false,
        });
      })
      .executeTest(async (mock) => {
        const res = await call(`${mock.url}${CR}`, 'POST', platformJson('catalog_manager'), {
          action_type: 'PLAN_VERSION_PUBLISH',
          payload: { plan_version_id: EX_DRAFT_ID, evidence: 'Pricing review PR-2026-Q4' },
          reason: 'Annual price review',
          idempotency_key: 'pact-b2-publish-0001',
        });
        expect(res.status).toBe(201);
      });
  });
});

// ── gate refusals on every catalog route: super_admin and the tenant tier ─────

describe('platform-web → every catalog route refuses super_admin (403, no commercial scope)', () => {
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

describe('platform-web → every catalog route refuses the tenant tier (403 tier tripwire)', () => {
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
