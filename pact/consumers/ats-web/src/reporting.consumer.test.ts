import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ACCESS_COOKIE,
  like,
  makeAtsWebProvider,
  uuid,
} from './support/ats-web-pact.js';

// PC-7d — ats-web reporting surface (My Desk header + dashboard + company
// KPI strips). @RequireCapability('ats') + report:read / dashboard:read
// (+ RequireSiteMatch). All reads; idempotency + illegal-state 0-by-substrate.
// Rollups group-by status → empty arrays with no reqs/pipelines seeded;
// recruiter-metrics always returns its four fixed keys; company-placements at
// a company with no placements → empty items (a legit, FE-handled state).

const provider = makeAtsWebProvider();

const COMPANY_ID = '00000000-0000-7000-8000-c00000000001';

describe('ats-web → reporting', () => {
  it('GET /v1/dashboard returns the dashboard rollup', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and tenant reporting data exist')
      .uponReceiving('a dashboard read')
      .withRequest('GET', '/v1/dashboard', (b) => { b.headers({ Cookie: like(ACCESS_COOKIE) }); })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          tenant_counts: {
            companies: like(1),
            contacts: like(0),
            talent_records: like(1),
            saved_lists: like(0),
            calendar_events: like(0),
            activities: like(0),
          },
          requisition_rollup: { total: like(0), by_status: [] },
          pipeline_rollup: { total: like(0), by_status: [] },
          placement: { placed_pipelines: like(0), includes_core_submittal_placements: false },
          upcoming_events: [],
          recent_activity: [],
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/dashboard`, { headers: { Cookie: ACCESS_COOKIE } });
        expect(res.status).toBe(200);
      });
  });

  it('GET /v1/reports/recruiter-metrics returns the four desk KPIs', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and tenant reporting data exist')
      .uponReceiving('a recruiter-metrics read')
      .withRequest('GET', '/v1/reports/recruiter-metrics', (b) => { b.headers({ Cookie: like(ACCESS_COOKIE) }); })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          items: like([
            { key: like('submittals_weekly'), series: like([]), period: like('week') },
          ]),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/reports/recruiter-metrics`, { headers: { Cookie: ACCESS_COOKIE } });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: unknown[] };
        expect(body.items.length).toBeGreaterThan(0);
      });
  });

  it('GET /v1/reports/company-metrics returns a per-company KPI row', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and tenant reporting data exist')
      .uponReceiving('a company-metrics read')
      .withRequest('GET', '/v1/reports/company-metrics', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) }).query({ company_ids: COMPANY_ID });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          items: [
            {
              company_id: uuid(COMPANY_ID),
              open_reqs: like(0),
              active_placements: like(0),
              submitted: like(0),
              openings: like(0),
              filled: like(0),
              fill_rate: null,
            },
          ],
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/reports/company-metrics?company_ids=${COMPANY_ID}`, { headers: { Cookie: ACCESS_COOKIE } });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: unknown[] };
        expect(body.items.length).toBeGreaterThan(0);
      });
  });

  it('GET /v1/reports/fill-performance returns fill-rate + time-to-fill metrics', async () => {
    const FROM = '2020-01-01T00:00:00.000Z';
    const TO = '2030-01-01T00:00:00.000Z';
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a fully-filled requisition exist')
      .uponReceiving('a fill-performance read')
      .withRequest('GET', '/v1/reports/fill-performance', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) }).query({ from: FROM, to: TO });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          period: { from: like(FROM), to: like(TO) },
          openings: like(1),
          filled_openings: like(1),
          fill_rate: like(100),
          fully_filled_requisitions: like(1),
          time_to_fill: { count: like(1), average_days: like(0) },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/reports/fill-performance?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`,
          { headers: { Cookie: ACCESS_COOKIE } },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { fill_rate: number | null };
        expect(body.fill_rate).toBe(100);
      });
  });

  it('GET /v1/reports/fallthrough returns fallthrough rate + reasons', async () => {
    const FROM = '2020-01-01T00:00:00.000Z';
    const TO = '2100-01-01T00:00:00.000Z';
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a fallen-through placement exist')
      .uponReceiving('a fallthrough read')
      .withRequest('GET', '/v1/reports/fallthrough', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) }).query({ from: FROM, to: TO });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          period: { from: like(FROM), to: like(TO) },
          accepted_attempts: like(1),
          fallthrough_attempts: like(1),
          fallthrough_rate: like(100),
          reasons: like([
            {
              reason_code: like('start_date_failed'),
              reason_label: like('Start date failed'),
              count: like(1),
              rate: like(100),
            },
          ]),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/reports/fallthrough?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`,
          { headers: { Cookie: ACCESS_COOKIE } },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { fallthrough_rate: number | null };
        expect(body.fallthrough_rate).toBe(100);
      });
  });

  it('GET /v1/reports/company-placements returns the placements list', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and tenant reporting data exist')
      .uponReceiving('a company-placements read')
      .withRequest('GET', '/v1/reports/company-placements', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) }).query({ company_id: COMPANY_ID });
      })
      .willRespondWith(200, (b) => { b.jsonBody({ items: [] }); })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/reports/company-placements?company_id=${COMPANY_ID}`, { headers: { Cookie: ACCESS_COOKIE } });
        expect(res.status).toBe(200);
      });
  });

  it('GET /v1/reports/assignment-pipeline returns the current-snapshot counts', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and assignment-pipeline placements exist')
      .uponReceiving('an assignment-pipeline read')
      .withRequest('GET', '/v1/reports/assignment-pipeline', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          total_live: like(7),
          by_state: like([{ state: like('STARTED'), count: like(3) }]),
          start_date: {
            overdue: like(0),
            today: like(0),
            next_7_days: like(1),
            later: like(1),
            unspecified: like(1),
            timezone_basis: 'UTC',
          },
          contract_assignments: { active: like(1), ended: like(1), coverage: 'forward_materialized' },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/reports/assignment-pipeline`, { headers: { Cookie: ACCESS_COOKIE } });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { contract_assignments: { coverage: string } };
        expect(body.contract_assignments.coverage).toBe('forward_materialized');
      });
  });

  // T9-B4 — margin current-snapshot aggregate. report:read AND
  // assignment:commercials:read (the ACCESS_COOKIE recruiter holds both). The
  // aggregate field is group_margin_percent (NOT the row-level margin_percent
  // that the global D5 mask strips) per the T9-B4 field-masking amendment.
  it('GET /v1/reports/margin returns the current-snapshot aggregate by (currency, rate_period)', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a commercialized contract assignment exist')
      .uponReceiving('a margin read')
      .withRequest('GET', '/v1/reports/margin', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          eligible_count: like(1),
          commercialized_count: like(1),
          missing_commercial_count: like(0),
          coverage: 'forward_materialized',
          groups: like([
            {
              currency: like('USD'),
              rate_period: like('HOURLY'),
              assignment_count: like(1),
              group_margin_percent: like('20.00'),
            },
          ]),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/reports/margin`, { headers: { Cookie: ACCESS_COOKIE } });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          coverage: string;
          groups: Array<{ group_margin_percent: string | null }>;
        };
        expect(body.coverage).toBe('forward_materialized');
        expect(body.groups[0]?.group_margin_percent).toBe('20.00');
      });
  });

  // T9-B4 §15 — an actor WITH reporting access (report:read) but WITHOUT
  // assignment:commercials:read is rejected 403 by the compound gate (the
  // reportonly fake token → a report:read-only recruiter JWT provider-side).
  it('GET /v1/reports/margin without assignment:commercials:read → 403', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a commercialized contract assignment exist')
      .uponReceiving('a margin read without the commercial scope')
      .withRequest('GET', '/v1/reports/margin', (b) => {
        b.headers({ Authorization: 'Bearer eyJfake.reportonly.token' });
      })
      .willRespondWith(403, (b) => {
        b.jsonBody({
          error: {
            code: 'INSUFFICIENT_PERMISSIONS',
            message: like('Required scopes not granted'),
            request_id: uuid(),
            details: like({}),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/reports/margin`, {
          headers: { Authorization: 'Bearer eyJfake.reportonly.token' },
        });
        expect(res.status).toBe(403);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
      });
  });
});

describe('ats-web → me', () => {
  it('GET /v1/me returns the current user, roles, and tenant label', async () => {
    await provider
      .addInteraction()
      .given('an ats-web user with a membership and a role exist')
      .uponReceiving('a current-user read')
      .withRequest('GET', '/v1/me', (b) => { b.headers({ Cookie: like(ACCESS_COOKIE) }); })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          user: { display_name: like('Rita Recruiter'), email: like('recruiter@astre.example') },
          roles: like(['recruiter']),
          tenant: { display_name: like('Astre') },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/me`, { headers: { Cookie: ACCESS_COOKIE } });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { user: { email: string } };
        expect(typeof body.user.email).toBe('string');
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
