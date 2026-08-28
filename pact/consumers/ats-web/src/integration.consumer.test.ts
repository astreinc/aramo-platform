import { describe, expect, it } from 'vitest';

import {
  ACCESS_COOKIE,
  ISO_TIMESTAMP,
  TENANT_ID,
  errorBody,
  like,
  makeAtsWebProvider,
  regex,
  uuid,
} from './support/ats-web-pact.js';

// T8-CONNECTOR-A — Pact consumer for ats-web connector-connection MANAGEMENT
// (Settings → Integrations). Pins the provider-neutral API SHAPE:
//   - a readable connection surface (GET list),
//   - a governed mutation (POST create),
//   - the write-only credential set (request carries the value; the response
//     view NEVER contains secret_ref, an AWS path, or the credential),
//   - the configuration refusal (enable without credential → 409
//     CONNECTOR_CONFIGURATION_INVALID).
// Does NOT touch the T8-P3 requisition-ingestion interactions.

const provider = makeAtsWebProvider();

const CONNECTION_ID = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';

describe('ats-web → GET /v1/integrations', () => {
  it('returns 200 with the tenant connector connections (secret-free)', async () => {
    await provider
      .addInteraction()
      .given('a tenant entitled to ats with a caller holding integration:read and one connector connection')
      .uponReceiving('an ats-web connector-connections list read')
      .withRequest('GET', '/v1/integrations', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          items: [
            {
              id: uuid(CONNECTION_ID),
              tenant_id: uuid(TENANT_ID),
              provider_key: like('acme_vms'),
              status: like('configured'),
              has_secret: like(true),
              provider_account_id: null,
              last_attempted_at: null,
              last_successful_at: null,
              last_error_code: null,
              last_error_summary: null,
              created_at: regex(ISO_TIMESTAMP, '2026-08-14T00:00:01Z'),
              updated_at: regex(ISO_TIMESTAMP, '2026-08-14T00:00:01Z'),
            },
          ],
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/integrations`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: Array<Record<string, unknown>> };
        expect(Array.isArray(body.items)).toBe(true);
        // Secret-free contract: no secret_ref key anywhere.
        expect(JSON.stringify(body)).not.toContain('secret_ref');
      });
  });
});

describe('ats-web → POST /v1/integrations', () => {
  it('returns 201 with a secret-free connection view', async () => {
    await provider
      .addInteraction()
      .given('a tenant entitled to ats with a caller holding integration:write')
      .uponReceiving('an ats-web create connector connection')
      .withRequest('POST', '/v1/integrations', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody({
          provider_key: 'acme_vms',
        });
      })
      .willRespondWith(201, (b) => {
        b.jsonBody({
          id: uuid(CONNECTION_ID),
          tenant_id: uuid(TENANT_ID),
          provider_key: like('acme_vms'),
          status: like('disconnected'),
          has_secret: like(false),
          provider_account_id: null,
          last_attempted_at: null,
          last_successful_at: null,
          last_error_code: null,
          last_error_summary: null,
          created_at: regex(ISO_TIMESTAMP, '2026-08-14T00:00:01Z'),
          updated_at: regex(ISO_TIMESTAMP, '2026-08-14T00:00:01Z'),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/integrations`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider_key: 'acme_vms' }),
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as { has_secret: boolean };
        expect(body.has_secret).toBe(false);
      });
  });
});

describe('ats-web → POST /v1/integrations/:id/credential (write-only)', () => {
  it('returns 200 with a secret-free view; the credential is never echoed', async () => {
    await provider
      .addInteraction()
      .given('a tenant entitled to ats with a caller holding integration:write and one connector connection')
      .uponReceiving('an ats-web write-only credential set')
      .withRequest('POST', `/v1/integrations/${CONNECTION_ID}/credential`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody({
          credential: like('super-secret-value'),
        });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          id: uuid(CONNECTION_ID),
          tenant_id: uuid(TENANT_ID),
          provider_key: like('acme_vms'),
          status: like('configured'),
          has_secret: like(true),
          provider_account_id: null,
          last_attempted_at: null,
          last_successful_at: null,
          last_error_code: null,
          last_error_summary: null,
          created_at: regex(ISO_TIMESTAMP, '2026-08-14T00:00:01Z'),
          updated_at: regex(ISO_TIMESTAMP, '2026-08-14T00:00:01Z'),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/integrations/${CONNECTION_ID}/credential`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify({ credential: 'super-secret-value' }),
        });
        expect(res.status).toBe(200);
        const raw = await res.text();
        expect(raw).not.toContain('super-secret-value'); // write-only: never echoed
        expect(raw).not.toContain('secret_ref');
      });
  });
});

describe('ats-web → POST /v1/integrations/:id/enable (refusal)', () => {
  it('returns 409 CONNECTOR_CONFIGURATION_INVALID when no credential is configured', async () => {
    await provider
      .addInteraction()
      .given('a tenant entitled to ats with a caller holding integration:write and a connector connection with no credential')
      .uponReceiving('an ats-web enable of an unconfigured connector connection')
      .withRequest('POST', `/v1/integrations/${CONNECTION_ID}/enable`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(409, (b) => {
        b.jsonBody(errorBody('CONNECTOR_CONFIGURATION_INVALID', 'cannot enable a connection with no configured credential'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/integrations/${CONNECTION_ID}/enable`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(409);
        const body = (await res.json()) as { error?: { code?: string } };
        expect(body.error?.code).toBe('CONNECTOR_CONFIGURATION_INVALID');
      });
  });
});

// L1-D3-A — VMS lifecycle mapping administration. Pins the active mapping-set
// READ shape (Settings → Integrations → Connection → Lifecycle Mapping). The row
// carries a disposition + a mapped action (or null for IGNORE) + authority_mode.
describe('ats-web → GET /v1/integrations/:id/requisition-lifecycle-mappings/active', () => {
  it("returns 200 with the connection's active lifecycle mapping set", async () => {
    await provider
      .addInteraction()
      .given('a tenant entitled to ats with a caller holding integration:read and a connection with an active lifecycle mapping set')
      .uponReceiving('an ats-web active lifecycle mapping set read')
      .withRequest('GET', `/v1/integrations/${CONNECTION_ID}/requisition-lifecycle-mappings/active`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          id: uuid('eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee'),
          connection_id: uuid(CONNECTION_ID),
          version: like(1),
          status: like('active'),
          created_at: regex(ISO_TIMESTAMP, '2026-08-27T00:00:01Z'),
          created_by: uuid(TENANT_ID),
          activated_at: regex(ISO_TIMESTAMP, '2026-08-27T00:00:01Z'),
          activated_by: uuid(TENANT_ID),
          supersedes_set_id: null,
          mappings: [
            {
              id: uuid('cccccccc-cccc-7ccc-8ccc-cccccccccccc'),
              provider_state: like('halted'),
              disposition: like('EXECUTE_ACTION'),
              mapped_action: like('PUT_ON_HOLD'),
              authority_mode: like('external_authority'),
            },
          ],
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/integrations/${CONNECTION_ID}/requisition-lifecycle-mappings/active`,
          { headers: { Cookie: ACCESS_COOKIE } },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status?: string; mappings?: unknown[] };
        expect(body.status).toBe('active');
        expect(Array.isArray(body.mappings)).toBe(true);
      });
  });
});
