import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ACCESS_COOKIE,
  ISO_TIMESTAMP,
  errorBody,
  like,
  makeAtsWebProvider,
  regex,
  uuid,
} from './support/ats-web-pact.js';

// PC-7b — ats-web tenant sites (the settings surface's state machine).
// tenant:admin:sites + core. deactivate/reactivate toggle is_active (idempotent
// → no illegal-state); DELETE guards site_in_use; POST guards name_taken.
// idempotency 0-by-substrate.
//   happy: list, create(201), patch, deactivate, reactivate, delete(204);
//   refusal: delete-in-use 400, create-duplicate-name 400.

const provider = makeAtsWebProvider();

const SITE_ID = '00000000-0000-7000-8000-51e000000001';
const SITE_INACTIVE_ID = '00000000-0000-7000-8000-51e000000003';

function siteView(
  id: string | undefined,
  opts: { name?: string; isActive?: boolean } = {},
) {
  return {
    id: id === undefined ? uuid() : uuid(id),
    name: like(opts.name ?? 'Headquarters'),
    is_active: opts.isActive === undefined ? like(true) : opts.isActive,
    parent_site_id: null,
    created_at: regex(ISO_TIMESTAMP, '2026-05-25T00:00:00Z'),
    updated_at: regex(ISO_TIMESTAMP, '2026-05-25T00:00:00Z'),
  };
}

describe('ats-web → tenant sites', () => {
  it('GET /v1/tenant/sites returns the site list', async () => {
    await provider
      .addInteraction()
      .given('an ats-web admin and a site exist')
      .uponReceiving('a sites list read')
      .withRequest('GET', '/v1/tenant/sites', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ items: [siteView(SITE_ID)] });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/tenant/sites`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: unknown[] };
        expect(body.items.length).toBeGreaterThan(0);
      });
  });

  it('POST /v1/tenant/sites creates a site (201)', async () => {
    const BODY = { name: 'West Branch' };
    await provider
      .addInteraction()
      .given('an ats-web admin and a tenant exist')
      .uponReceiving('a site create')
      .withRequest('POST', '/v1/tenant/sites', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(201, (b) => {
        b.jsonBody(siteView(undefined, { name: 'West Branch' }));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/tenant/sites`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(201);
      });
  });

  it('PATCH /v1/tenant/sites/:id renames a site', async () => {
    const BODY = { name: 'HQ (Renamed)' };
    await provider
      .addInteraction()
      .given('an ats-web admin and a site exist')
      .uponReceiving('a site rename')
      .withRequest('PATCH', `/v1/tenant/sites/${SITE_ID}`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(siteView(SITE_ID, { name: 'HQ (Renamed)' }));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/tenant/sites/${SITE_ID}`, {
          method: 'PATCH',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(200);
      });
  });

  it('POST /v1/tenant/sites/:id/deactivate deactivates', async () => {
    await provider
      .addInteraction()
      .given('an ats-web admin and a site exist')
      .uponReceiving('a site deactivate')
      .withRequest('POST', `/v1/tenant/sites/${SITE_ID}/deactivate`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody({});
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(siteView(SITE_ID, { isActive: false }));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/tenant/sites/${SITE_ID}/deactivate`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: '{}',
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { is_active: boolean };
        expect(body.is_active).toBe(false);
      });
  });

  it('POST /v1/tenant/sites/:id/reactivate reactivates', async () => {
    await provider
      .addInteraction()
      .given('an ats-web admin and an inactive site exist')
      .uponReceiving('a site reactivate')
      .withRequest('POST', `/v1/tenant/sites/${SITE_INACTIVE_ID}/reactivate`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody({});
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(siteView(SITE_INACTIVE_ID, { name: 'Closed Office', isActive: true }));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/tenant/sites/${SITE_INACTIVE_ID}/reactivate`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: '{}',
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { is_active: boolean };
        expect(body.is_active).toBe(true);
      });
  });

  it('DELETE /v1/tenant/sites/:id removes a site (204)', async () => {
    await provider
      .addInteraction()
      .given('an ats-web admin and a site exist')
      .uponReceiving('a site delete')
      .withRequest('DELETE', `/v1/tenant/sites/${SITE_ID}`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(204)
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/tenant/sites/${SITE_ID}`, {
          method: 'DELETE',
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(204);
      });
  });
});

describe('ats-web → tenant sites (refusals)', () => {
  it('DELETE a site with children returns 400 (site_in_use)', async () => {
    await provider
      .addInteraction()
      .given('an ats-web admin and a site with a child exist')
      .uponReceiving('a site delete blocked by in-use')
      .withRequest('DELETE', `/v1/tenant/sites/${SITE_ID}`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(400, (b) => {
        b.jsonBody(errorBody('VALIDATION_ERROR', 'site is in use and cannot be deleted'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/tenant/sites/${SITE_ID}`, {
          method: 'DELETE',
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('VALIDATION_ERROR');
      });
  });

  it('POST a site with a taken name returns 400 (name_taken)', async () => {
    const BODY = { name: 'Headquarters' };
    await provider
      .addInteraction()
      .given('an ats-web admin and a site exist')
      .uponReceiving('a site create with a duplicate name')
      .withRequest('POST', '/v1/tenant/sites', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(400, (b) => {
        b.jsonBody(errorBody('VALIDATION_ERROR', 'a site with that name already exists'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/tenant/sites`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('VALIDATION_ERROR');
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
