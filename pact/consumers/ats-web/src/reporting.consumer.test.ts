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
