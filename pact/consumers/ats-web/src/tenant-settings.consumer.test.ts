import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ACCESS_COOKIE,
  ISO_TIMESTAMP,
  TENANT_ID,
  like,
  makeAtsWebProvider,
  regex,
  uuid,
} from './support/ats-web-pact.js';

// PC-7b — ats-web tenant settings surface (settings/profile/roles/audit).
// @RequireCapability('core') + tenant:admin:* scopes. Reads + writes; no
// state machine here (sites/domain carry those). idempotency 0-by-substrate;
// refusal 0-by-ruling (bad-key/value 400 → hardening park). audit-events
// carries the cursor-opacity pin (?limit=1 → non-null opaque next_cursor).

const provider = makeAtsWebProvider();

describe('ats-web → tenant settings', () => {
  it('GET /v1/tenant/settings returns the known-key map', async () => {
    await provider
      .addInteraction()
      .given('an ats-web admin and tenant settings exist')
      .uponReceiving('a tenant settings read')
      .withRequest('GET', '/v1/tenant/settings', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          'compensation.display_default': like('both'),
          'audit.financials_enabled': like(true),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/tenant/settings`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
      });
  });

  it('PUT /v1/tenant/settings/:key writes a setting', async () => {
    const BODY = { value: 'both' };
    await provider
      .addInteraction()
      .given('an ats-web admin and a tenant exist')
      .uponReceiving('a tenant setting write')
      .withRequest('PUT', '/v1/tenant/settings/compensation.display_default', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          key: like('compensation.display_default'),
          value: like('both'),
          previous_value: null,
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/tenant/settings/compensation.display_default`,
          {
            method: 'PUT',
            headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
            body: JSON.stringify(BODY),
          },
        );
        expect(res.status).toBe(200);
      });
  });
});

describe('ats-web → tenant profile', () => {
  const profileView = (opts: { legalName?: unknown } = {}) => ({
    id: uuid(TENANT_ID),
    name: like('Astre Consulting'),
    legal_name: opts.legalName === undefined ? null : opts.legalName,
    display_name: null,
    updated_at: regex(ISO_TIMESTAMP, '2026-05-25T00:00:00Z'),
  });

  it('GET /v1/tenant/profile returns the profile', async () => {
    await provider
      .addInteraction()
      .given('an ats-web admin and a tenant exist')
      .uponReceiving('a tenant profile read')
      .withRequest('GET', '/v1/tenant/profile', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(profileView());
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/tenant/profile`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
      });
  });

  it('PATCH /v1/tenant/profile updates the profile', async () => {
    const BODY = { legal_name: 'Astre Consulting Services Inc' };
    await provider
      .addInteraction()
      .given('an ats-web admin and a tenant exist')
      .uponReceiving('a tenant profile update')
      .withRequest('PATCH', '/v1/tenant/profile', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(profileView({ legalName: like('Astre Consulting Services Inc') }));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/tenant/profile`, {
          method: 'PATCH',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(200);
      });
  });
});

describe('ats-web → GET /v1/tenant/roles-catalog', () => {
  it('returns the role catalog', async () => {
    await provider
      .addInteraction()
      .given('an ats-web admin and a tenant exist')
      .uponReceiving('a roles-catalog read')
      .withRequest('GET', '/v1/tenant/roles-catalog', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          roles: like([
            {
              key: like('recruiter'),
              display: like('Recruiter'),
              description: like('…'),
              tier: like('standard'),
              scopes: like(['talent:read']),
            },
          ]),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/tenant/roles-catalog`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { roles: unknown[] };
        expect(body.roles.length).toBeGreaterThan(0);
      });
  });
});

describe('ats-web → GET /v1/tenant/audit-events', () => {
  it('returns a page with an opaque next_cursor', async () => {
    await provider
      .addInteraction()
      .given('an ats-web admin and audit events exist')
      .uponReceiving('a tenant audit-events read (page 1, more to come)')
      .withRequest('GET', '/v1/tenant/audit-events', (b) => {
        b.query({ limit: '1' }).headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          items: [
            {
              id: uuid(),
              event_type: like('tenant.site.created'),
              category: like('org'),
              actor: { id: like('00000000-0000-7000-8000-000000000bb1'), type: like('user'), display: like('—') },
              subject_id: like('00000000-0000-7000-8000-51e000000001'),
              detail: like('tenant site created'),
              created_at: regex(ISO_TIMESTAMP, '2026-05-02T00:00:00Z'),
            },
          ],
          next_cursor: like('eyJjIjoiMjAyNi0wNS0wMSJ9'),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/tenant/audit-events?limit=1`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: unknown[]; next_cursor: string | null };
        expect(body.items.length).toBe(1);
        expect(typeof body.next_cursor).toBe('string');
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
