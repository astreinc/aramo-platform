import { resolve } from 'node:path';

import { MatchersV3, PactV4 } from '@pact-foundation/pact';
import { describe, expect, it } from 'vitest';

const { eachLike, fromProviderState, integer, like, regex, uuid } = MatchersV3;

// CCP-B5 (PBD §5.3 row B5; CCP-A10 §5 "Extending the contracts") — the platform console's
// contract for the B5 routes and the governed role / policy requests the B5 screens send,
// allowed AND refused. Same consumer, provider and pact file as
// platform-commercial.consumer.test.ts (CCP-A10); this file only adds interactions.
//
// B5 routes (5):
//   GET   /platform/commercial/policy-versions            (policy screen read)
//   POST  /platform/commercial/policy-versions            (create a DRAFT)
//   PATCH /platform/commercial/policy-versions/{id}       (edit a DRAFT)
//   GET   /platform/commercial/operators                  (roster + chain state)
//   POST  /platform/commercial/audit-events/export        (read-only CSV export, audited)
// For each: the allowed call, super_admin refused (403, no commercial scope), the tenant
// tier refused (403 tier tripwire), and the role-level refusals the screens surface.
// Plus, on the A3 route the B5 screens call (POST /platform/commercial/change-requests):
// a governed ROLE_GRANT (201), the last-owner ROLE_REVOKE refusal (409 PLATFORM_LAST_OWNER)
// and a POLICY_ACTIVATE by a platform_owner (403 requester_role_missing; TD-A3-5).
//
// Principals and placeholder cookies are as in the A10 file (`pact-<role>`; the verifier
// seeds one attested operator per role — so OP.platform_owner is the platform's only owner).

const provider = new PactV4({
  consumer: 'platform-web',
  provider: 'platform-admin',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

// MUST match pact/provider/src/verify-platform-admin.ts.
const OP = {
  platform_owner: 'cca10000-0000-7000-8000-000000000001',
  finance_admin: 'cca10000-0000-7000-8000-000000000002',
  commercial_ops: 'cca10000-0000-7000-8000-000000000003',
  read_only_auditor: 'cca10000-0000-7000-8000-000000000006',
  super_admin: 'cca10000-0000-7000-8000-000000000007',
} as const;
type Role = keyof typeof OP | 'catalog_manager' | 'support_admin';

const POLICY_V1 = '019a0000-0000-7000-8000-0000000cc201';
const EX_DRAFT_ID = 'ccb50000-0000-7000-8000-0000000000d1';

const PV = '/platform/commercial/policy-versions';
const OPERATORS = '/platform/commercial/operators';
const EXPORT = '/platform/commercial/audit-events/export';
const CR = '/platform/commercial/change-requests';

const platformSession = (role: Role) => ({
  'X-Aramo-Consumer': 'platform',
  Cookie: `aramo_access_token_platform=pact-${role}`,
});
const platformJson = (role: Role) => ({
  ...platformSession(role),
  'Content-Type': 'application/json',
});
const TENANT_TIER = {
  'X-Aramo-Consumer': 'recruiter',
  Cookie: 'aramo_access_token_recruiter=pact-recruiter',
};
const TENANT_TIER_JSON = { ...TENANT_TIER, 'Content-Type': 'application/json' };

const ISO = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$';
const iso = (example = '2026-10-25T10:00:00.000Z') => regex(ISO, example);
const HEX64 = (example = 'a'.repeat(64)) => regex('^[0-9a-f]{64}$', example);

function errorBody(code: string, details: Record<string, unknown>): Record<string, unknown> {
  return { error: { code, message: like('refused'), request_id: like('req-1'), details } };
}
const missingScope = (scope: string) =>
  errorBody('INSUFFICIENT_PERMISSIONS', { missing_scopes: [scope] });
const TIER_REFUSED = errorBody('INSUFFICIENT_PERMISSIONS', {
  reason: 'tenant_token_on_platform_route',
});
const ROLE_MISSING = errorBody('INSUFFICIENT_PERMISSIONS', { reason: 'requester_role_missing' });

async function call(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: (text.length > 0 ? JSON.parse(text) : {}) as Record<string, unknown>,
  };
}

// The format-1 policy document (CommercialPolicyContent), as the console reads it.
const CONTENT = {
  format_version: 1,
  currency: 'USD',
  discount_escalation_threshold_bps: integer(2000),
  credit_escalation_threshold_minor: integer(50000),
  support_extension_max_days: integer(14),
  support_extension_frequency_window_days: integer(90),
  support_extension_cumulative_max_days: integer(30),
  support_extension_cumulative_window_days: integer(365),
  approval_expiry_hours: integer(72),
  past_due_grace_days: integer(7),
};
const versionBody = (status: string, o: { id?: unknown } = {}) => ({
  id: o.id ?? uuid(POLICY_V1),
  version_number: integer(1),
  status,
  content: CONTENT,
  content_checksum: HEX64(),
  note: like('First governed commercial policy.'),
  created_by: null,
  created_at: iso(),
  activated_by: null,
  activated_at: status === 'ACTIVE' ? iso() : null,
  retired_at: null,
  open_request: null,
});

const DRAFT_PATH = fromProviderState(`${PV}/\${versionId}`, `${PV}/${EX_DRAFT_ID}`);

// ── policy versions ───────────────────────────────────────────────────────────

describe('platform-web → GET /platform/commercial/policy-versions (CCP-B5)', () => {
  it('read_only_auditor reads the versions (200, caller cannot author)', async () => {
    await provider
      .addInteraction()
      .given('no draft commercial policy version exists')
      .uponReceiving('a commercial policy versions read by a read-only auditor')
      .withRequest('GET', PV, (b) => {
        b.headers(platformSession('read_only_auditor'));
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          versions: eachLike(versionBody('ACTIVE')),
          active_version_id: uuid(POLICY_V1),
          open_request: null,
          caller: { can_author: false, can_request_activation: false },
        });
      })
      .executeTest(async (mock) => {
        const res = await call(`${mock.url}${PV}`, 'GET', platformSession('read_only_auditor'));
        expect(res.status).toBe(200);
        expect(res.body['caller']).toEqual({ can_author: false, can_request_activation: false });
      });
  });
});

describe('platform-web → POST /platform/commercial/policy-versions (CCP-B5)', () => {
  const BODY = { source_version_id: POLICY_V1 };
  it('finance_admin creates a DRAFT from v1 (201)', async () => {
    await provider
      .addInteraction()
      .given('no draft commercial policy version exists')
      .uponReceiving('a policy draft created by a finance admin')
      .withRequest('POST', PV, (b) => {
        b.headers(platformJson('finance_admin')).jsonBody(BODY);
      })
      .willRespondWith(201, (b) => {
        b.jsonBody({
          version: {
            ...versionBody('DRAFT', { id: uuid(EX_DRAFT_ID) }),
            version_number: integer(2),
            note: like('Draft from v1'),
            created_by: uuid(OP.finance_admin),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await call(`${mock.url}${PV}`, 'POST', platformJson('finance_admin'), BODY);
        expect(res.status).toBe(201);
      });
  });
  it('commercial_ops cannot author a draft (403 requester_role_missing)', async () => {
    await provider
      .addInteraction()
      .given('platform operators are provisioned')
      .uponReceiving('a policy draft refused for commercial ops')
      .withRequest('POST', PV, (b) => {
        b.headers(platformJson('commercial_ops')).jsonBody(BODY);
      })
      .willRespondWith(403, (b) => {
        b.jsonBody(ROLE_MISSING);
      })
      .executeTest(async (mock) => {
        expect(
          (await call(`${mock.url}${PV}`, 'POST', platformJson('commercial_ops'), BODY)).status,
        ).toBe(403);
      });
  });
});

describe('platform-web → PATCH /platform/commercial/policy-versions/{id} (CCP-B5)', () => {
  const BODY = { content: { approval_expiry_hours: 48 } };
  it('finance_admin edits the DRAFT (200)', async () => {
    await provider
      .addInteraction()
      .given('a draft commercial policy version exists')
      .uponReceiving('a policy draft edited by a finance admin')
      .withRequest('PATCH', DRAFT_PATH, (b) => {
        b.headers(platformJson('finance_admin')).jsonBody(BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          version: {
            ...versionBody('DRAFT', { id: uuid(EX_DRAFT_ID) }),
            version_number: integer(2),
            note: like('Draft from v1'),
            created_by: uuid(OP.finance_admin),
            content: { ...CONTENT, approval_expiry_hours: 48 },
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await call(
          `${mock.url}${PV}/${EX_DRAFT_ID}`,
          'PATCH',
          platformJson('finance_admin'),
          BODY,
        );
        expect(res.status).toBe(200);
      });
  });
  it('read_only_auditor cannot edit a draft (403 requester_role_missing)', async () => {
    await provider
      .addInteraction()
      .given('a draft commercial policy version exists')
      .uponReceiving('a policy draft edit refused for a read-only auditor')
      .withRequest('PATCH', DRAFT_PATH, (b) => {
        b.headers(platformJson('read_only_auditor')).jsonBody(BODY);
      })
      .willRespondWith(403, (b) => {
        b.jsonBody(ROLE_MISSING);
      })
      .executeTest(async (mock) => {
        expect(
          (
            await call(
              `${mock.url}${PV}/${EX_DRAFT_ID}`,
              'PATCH',
              platformJson('read_only_auditor'),
              BODY,
            )
          ).status,
        ).toBe(403);
      });
  });
});

// ── roster ────────────────────────────────────────────────────────────────────

describe('platform-web → GET /platform/commercial/operators (CCP-B5)', () => {
  it('platform_owner reads the roster and the chain state (200)', async () => {
    await provider
      .addInteraction()
      .given('platform operators are provisioned')
      .uponReceiving('the commercial roster read by a platform owner')
      .withRequest('GET', OPERATORS, (b) => {
        b.headers(platformSession('platform_owner'));
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          // Minimal shape: the roster also holds the other seeded operators (super_admin with
          // no commercial role) and any pending role request another interaction created.
          operators: eachLike({
            user_id: uuid(OP.platform_owner),
            attested: like(true),
            is_last_owner: like(true),
          }),
          chains: eachLike({
            key: like('ABOVE_THRESHOLD'),
            rule: like('FINANCE_THEN_OWNER'),
            fulfillable: like(true),
          }),
          all_fulfillable: like(false),
        });
      })
      .executeTest(async (mock) => {
        const res = await call(`${mock.url}${OPERATORS}`, 'GET', platformSession('platform_owner'));
        expect(res.status).toBe(200);
      });
  });
});

// ── audit export ──────────────────────────────────────────────────────────────

describe('platform-web → POST /platform/commercial/audit-events/export (CCP-B5)', () => {
  const BODY = { event_type: 'COMMERCIAL_POLICY_VERSION_ACTIVATED' };
  it('read_only_auditor exports the filtered events as CSV (200; the export is audited)', async () => {
    await provider
      .addInteraction()
      .given('the commercial policy activation is audited')
      .uponReceiving('a commercial audit CSV export by a read-only auditor')
      .withRequest('POST', EXPORT, (b) => {
        b.headers(platformJson('read_only_auditor')).jsonBody(BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          export_id: uuid('ccb50000-0000-7000-8000-0000000000e1'),
          exported_at: iso(),
          row_count: integer(1),
          filename: like('commercial-audit-20261025-100000.csv'),
          content_type: 'text/csv',
          csv: regex(
            '^id,time_utc,event,actor,roles,tenant,product,change_request,exception,detail\\r\\n[\\s\\S]*$',
            'id,time_utc,event,actor,roles,tenant,product,change_request,exception,detail\r\n',
          ),
          csv_sha256: HEX64(),
        });
      })
      .executeTest(async (mock) => {
        const res = await call(
          `${mock.url}${EXPORT}`,
          'POST',
          platformJson('read_only_auditor'),
          BODY,
        );
        expect(res.status).toBe(200);
      });
  });
  it('commercial_ops holds no audit read scope (403)', async () => {
    await provider
      .addInteraction()
      .given('platform operators are provisioned')
      .uponReceiving('a commercial audit export refused for commercial ops')
      .withRequest('POST', EXPORT, (b) => {
        b.headers(platformJson('commercial_ops')).jsonBody(BODY);
      })
      .willRespondWith(403, (b) => {
        b.jsonBody(missingScope('platform:commercial:audit:read'));
      })
      .executeTest(async (mock) => {
        expect(
          (await call(`${mock.url}${EXPORT}`, 'POST', platformJson('commercial_ops'), BODY)).status,
        ).toBe(403);
      });
  });
});

// ── the governed requests the B5 screens send (A3 / A9 route) ───────────────────

describe('platform-web → POST /platform/commercial/change-requests from the B5 screens', () => {
  it('platform_owner requests a governed ROLE_GRANT (201, DRAFT, chain = a distinct platform owner)', async () => {
    const body = {
      action_type: 'ROLE_GRANT',
      payload: { subject_user_id: OP.read_only_auditor, role_key: 'support_admin' },
      reason: 'Cover for the Q4 close\n\nEvidence: HR-3391',
      idempotency_key: 'pact-b5-role-grant-0001',
    };
    await provider
      .addInteraction()
      .given('platform operators are provisioned')
      .uponReceiving('a governed role grant requested by a platform owner')
      .withRequest('POST', CR, (b) => {
        b.headers(platformJson('platform_owner')).jsonBody(body);
      })
      .willRespondWith(201, (b) => {
        b.jsonBody({
          request: like({
            id: uuid('ccb50000-0000-7000-8000-0000000000c1'),
            action_type: 'ROLE_GRANT',
            state: 'DRAFT',
            tenant_id: null,
            product_key: null,
            payload: { subject_user_id: OP.read_only_auditor, role_key: 'support_admin' },
            required_chain: {
              rule: 'DISTINCT_PLATFORM_OWNER',
              basis: like({}),
              steps: eachLike({
                step_index: integer(0),
                role_key: 'platform_owner',
                scope_keys: eachLike('platform:billing:approve'),
              }),
            },
            requested_by: OP.platform_owner,
            effect_applied_at: null,
          }),
          replayed: false,
        });
      })
      .executeTest(async (mock) => {
        expect(
          (await call(`${mock.url}${CR}`, 'POST', platformJson('platform_owner'), body)).status,
        ).toBe(201);
      });
  });
  it('a ROLE_REVOKE of the last platform owner is refused (409 PLATFORM_LAST_OWNER)', async () => {
    const body = {
      action_type: 'ROLE_REVOKE',
      payload: { subject_user_id: OP.platform_owner, role_key: 'platform_owner' },
      reason: 'Leaving\n\nEvidence: HR-1',
      idempotency_key: 'pact-b5-role-revoke-0001',
    };
    await provider
      .addInteraction()
      .given('platform operators are provisioned')
      .uponReceiving('a last-owner role revoke refused')
      .withRequest('POST', CR, (b) => {
        b.headers(platformJson('platform_owner')).jsonBody(body);
      })
      .willRespondWith(409, (b) => {
        b.jsonBody(errorBody('PLATFORM_LAST_OWNER', { reason: 'platform_last_owner' }));
      })
      .executeTest(async (mock) => {
        expect(
          (await call(`${mock.url}${CR}`, 'POST', platformJson('platform_owner'), body)).status,
        ).toBe(409);
      });
  });
  it('a platform_owner cannot request a policy activation (403 requester_role_missing; finance_admin requests it, TD-A3-5)', async () => {
    const body = {
      action_type: 'POLICY_ACTIVATE',
      payload: { policy_version_id: POLICY_V1 },
      reason: 'x\n\nEvidence: y',
      idempotency_key: 'pact-b5-policy-activate-0001',
    };
    await provider
      .addInteraction()
      .given('platform operators are provisioned')
      .uponReceiving('a policy activation refused for a platform owner')
      .withRequest('POST', CR, (b) => {
        b.headers(platformJson('platform_owner')).jsonBody(body);
      })
      .willRespondWith(403, (b) => {
        b.jsonBody(
          errorBody('INSUFFICIENT_PERMISSIONS', {
            reason: 'requester_role_missing',
            required_role: 'finance_admin',
          }),
        );
      })
      .executeTest(async (mock) => {
        expect(
          (await call(`${mock.url}${CR}`, 'POST', platformJson('platform_owner'), body)).status,
        ).toBe(403);
      });
  });
});

// ── the gate refusals on every B5 route ─────────────────────────────────────────

interface GateRoute {
  name: string;
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  scope: string;
  body?: Record<string, unknown>;
}
const GATE_ROUTES: readonly GateRoute[] = [
  { name: 'GET policy-versions', method: 'GET', path: PV, scope: 'platform:approval:read' },
  {
    name: 'POST policy-versions',
    method: 'POST',
    path: PV,
    scope: 'platform:approval:read',
    body: { source_version_id: POLICY_V1 },
  },
  {
    name: 'PATCH policy-versions/{id}',
    method: 'PATCH',
    path: `${PV}/${EX_DRAFT_ID}`,
    scope: 'platform:approval:read',
    body: { content: { approval_expiry_hours: 48 } },
  },
  { name: 'GET operators', method: 'GET', path: OPERATORS, scope: 'platform:approval:read' },
  {
    name: 'POST audit-events/export',
    method: 'POST',
    path: EXPORT,
    scope: 'platform:commercial:audit:read',
    body: {},
  },
];

describe('platform-web → every B5 route refuses super_admin (403, no commercial scope)', () => {
  for (const r of GATE_ROUTES) {
    it(`${r.name} → 403 missing ${r.scope}`, async () => {
      const headers =
        r.body === undefined ? platformSession('super_admin') : platformJson('super_admin');
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
          expect((await call(`${mock.url}${r.path}`, r.method, headers, r.body)).status).toBe(403);
        });
    });
  }
});

describe('platform-web → every B5 route refuses the tenant tier (403 tier tripwire)', () => {
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
          expect((await call(`${mock.url}${r.path}`, r.method, headers, r.body)).status).toBe(403);
        });
    });
  }
});
