import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { describe, expect, it } from 'vitest';
import {
  ESIGN_S2S_SIGNATURE_HEADER,
  ESIGN_S2S_TIMESTAMP_HEADER,
  SIGN_TEMPLATE_BODY_DIGEST_PARAM,
  signEsignServiceRequest,
  signTemplateBodyDigest,
} from '@aramo/documents-contracts';

const { like, eachLike, regex } = MatchersV3;

// DOC-TEMPLATE-LIB-1 T-5 (Implementation Directive v1.0 LOCKED §7.5; ADR-0034 D12) — the
// template-library calls sign-service makes against apps/api over the signed
// service-to-service channel.
//
// Consumer:  sign-service   (apps/sign-service DocumentTemplatesHttpAdapter →
//                             GET  /v1/documents/esign/templates
//                             POST /v1/documents/esign/templates/:id/preview
//                             POST /v1/documents/esign/templates/:id/render)
// Provider:  aramo-core      (apps/api DocumentsEsignTemplatesController).
//
// Mirrors the EXACT requests the adapter issues: tenant_id (+ idempotency_key) and, for a
// POST, the body digest `body_sha256` in the query, all signed with aramo-sign-s2s-v1
// (timestamp + signature headers). The signature is dynamic, so the contract pins the
// header FORMAT; the provider re-signs the replayed request (verify-api.ts requestFilter)
// against the STRICT production guard. The digest is a deterministic function of the
// fixed body, so it is pinned exactly.

const SECRET = 'pact-test-esign-webhook-secret';
const TS_FORMAT = '^\\d{1,12}$';
const SIG_FORMAT = '^[A-Za-z0-9+/]{43}=$';

const TENANT_ID = '11111111-1111-7111-8111-111111111111';
// Seeded by the provider state (verify-api.ts): an Aramo (PLATFORM) Right to Represent default.
const TEMPLATE_ID = 'd0c4c000-0000-7000-8000-0000000000d1';
const VERSION_ID = 'd0c4c000-0000-7000-8000-0000000000d2';
const UNKNOWN_TEMPLATE_ID = 'd0c4c000-0000-7000-8000-0000000000df';
const CREATED_BY = 'd0c4c000-0000-7000-8000-0000000000ac';
const IDEMPOTENCY_KEY = 'pact-t5-render-0001';
// Amendment M-A6 §3 — seeded by 'a tenant template with signing roles is usable for the
// tenant' (verify-api.ts) under its own tenant, so it never shows in the lists above.
const ROLES_TENANT_ID = '11111111-1111-7111-8111-1111111111a6';
const ROLES_TEMPLATE_ID = 'd0c4c000-0000-7000-8000-0000000000a1';
const ROLES_VERSION_ID = 'd0c4c000-0000-7000-8000-0000000000a2';
const ROLES_SIGNING = {
  roles: [
    { role_key: 'client', label: 'Client', kind: 'SIGNER', order: 1 },
    { role_key: 'agency', label: 'Agency', kind: 'SIGNER', order: 2 },
    { role_key: 'hr_copy', label: 'HR copy', kind: 'CC', order: 3 },
  ],
  routing_mode: 'SEQUENTIAL',
};

function signed(method: 'GET' | 'POST', url: string): Record<string, string> {
  return signEsignServiceRequest({ method, url, secret: SECRET, nowSec: Math.floor(Date.now() / 1000) });
}

function headerMatchers(method: 'GET' | 'POST', url: string, json: boolean) {
  const h = signed(method, url);
  return {
    [ESIGN_S2S_TIMESTAMP_HEADER]: regex(TS_FORMAT, h[ESIGN_S2S_TIMESTAMP_HEADER]!),
    [ESIGN_S2S_SIGNATURE_HEADER]: regex(SIG_FORMAT, h[ESIGN_S2S_SIGNATURE_HEADER]!),
    ...(json ? { 'content-type': 'application/json' } : {}),
  };
}

const provider = new PactV4({
  consumer: 'sign-service',
  provider: 'aramo-core',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

const variable = { key: 'talent.full_name', label: like('Talent full name'), group: like('Talent'), source: 'SENDER', value: null };

describe('sign-service → GET /v1/documents/esign/templates', () => {
  it('returns the template the tenant resolves to, with its variables', async () => {
    const path = '/v1/documents/esign/templates';
    await provider
      .addInteraction()
      .given('an Aramo default template is resolvable for the tenant')
      .uponReceiving('a template-library list from the Sign console')
      .withRequest('GET', path, (b) => {
        b.query({ tenant_id: TENANT_ID }).headers(headerMatchers('GET', `http://core${path}?tenant_id=${TENANT_ID}`, false));
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          items: eachLike({
            template_id: TEMPLATE_ID,
            name: like('Standard Right to Represent'),
            document_type: { id: like('d0c50005-0000-7000-8000-000000000001'), key: like('RIGHT_TO_REPRESENT'), name: like('Right to Represent') },
            owner_scope: 'PLATFORM',
            resolution: 'PLATFORM_DEFAULT',
            version_id: VERSION_ID,
            version_number: like(1),
            updated_at: like('2026-10-21T00:00:00.000Z'),
            variables: eachLike(variable),
            // Amendment M-A6 §3.1 / §3.7 — list metadata; a template without roles.
            is_default: like(true),
            category: like('Right to Represent'),
            signer_role_count: 1,
            cc_role_count: 0,
            document_count: 1,
            routing_mode: 'PARALLEL',
            signing: null,
          }),
          unavailable: [],
        });
      })
      .executeTest(async (mock) => {
        const url = `${mock.url}${path}?tenant_id=${TENANT_ID}`;
        const res = await fetch(url, { headers: signed('GET', url) });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: Array<{ template_id: string }> };
        expect(body.items[0]?.template_id).toBe(TEMPLATE_ID);
      });
  });
});

describe('sign-service → POST /v1/documents/esign/templates/{id}/preview', () => {
  it('returns the tenant-branded preview with the sender values', async () => {
    const body = { values: { 'talent.full_name': 'Jordan Signer' } };
    const digest = signTemplateBodyDigest(body);
    const path = `/v1/documents/esign/templates/${TEMPLATE_ID}/preview`;
    const query = { tenant_id: TENANT_ID, [SIGN_TEMPLATE_BODY_DIGEST_PARAM]: digest };
    const qs = new URLSearchParams(query).toString();
    await provider
      .addInteraction()
      .given('an Aramo default template is resolvable for the tenant')
      .uponReceiving('a template preview from the Sign console')
      .withRequest('POST', path, (b) => {
        b.query(query).headers(headerMatchers('POST', `http://core${path}?${qs}`, true)).jsonBody(body);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          template_id: TEMPLATE_ID,
          version_id: VERSION_ID,
          version_number: like(1),
          title: like('Right to Represent'),
          blocks: eachLike({ type: like('TEXT'), text: like('text') }),
          html: null,
          letterhead: { organization_name: like('pact-write-freeze'), logo_available: like(false) },
          variables: eachLike({ key: like('talent.full_name'), label: like('Talent full name'), group: like('Talent'), source: like('SENDER'), value: null }),
          signing: null,
        });
      })
      .executeTest(async (mock) => {
        const url = `${mock.url}${path}?${qs}`;
        const res = await fetch(url, { method: 'POST', headers: { ...signed('POST', url), 'content-type': 'application/json' }, body: JSON.stringify(body) });
        expect(res.status).toBe(200);
      });
  });
});

describe('sign-service → POST /v1/documents/esign/templates/{id}/render', () => {
  it('freezes a Document revision pinned to the template version and returns the CORE_REF', async () => {
    const body = { values: { 'talent.full_name': 'Jordan Signer' }, created_by: CREATED_BY, client_id: null };
    const digest = signTemplateBodyDigest(body);
    const path = `/v1/documents/esign/templates/${TEMPLATE_ID}/render`;
    const query = { tenant_id: TENANT_ID, idempotency_key: IDEMPOTENCY_KEY, [SIGN_TEMPLATE_BODY_DIGEST_PARAM]: digest };
    const qs = new URLSearchParams(query).toString();
    await provider
      .addInteraction()
      .given('an Aramo default template is resolvable for the tenant')
      .uponReceiving('a template render for a new Sign envelope')
      .withRequest('POST', path, (b) => {
        b.query(query).headers(headerMatchers('POST', `http://core${path}?${qs}`, true)).jsonBody(body);
      })
      .willRespondWith(201, (b) => {
        b.jsonBody({
          document_id: like('d0c4c000-0000-7000-8000-0000000000e1'),
          document_revision_ref: like('d0c4c000-0000-7000-8000-0000000000e2'),
          source_sha256: regex('^[0-9a-f]{64}$', 'a'.repeat(64)),
          byte_size: like(1024),
          title: like('Right to Represent'),
          template_id: TEMPLATE_ID,
          template_version_id: VERSION_ID,
          version_number: like(1),
          signature_fields: eachLike({ field_type: like('SIGNATURE'), page_number: like(0), x: like(72), y: like(100), width: like(200), height: like(40) }),
          field_definitions: [],
          signing: null,
        });
      })
      .executeTest(async (mock) => {
        const url = `${mock.url}${path}?${qs}`;
        const res = await fetch(url, { method: 'POST', headers: { ...signed('POST', url), 'content-type': 'application/json' }, body: JSON.stringify(body) });
        expect(res.status).toBe(201);
        const out = (await res.json()) as { document_revision_ref: string; template_version_id: string };
        expect(out.template_version_id).toBe(VERSION_ID);
        expect(typeof out.document_revision_ref).toBe('string');
      });
  });

  it('returns 404 for a template the tenant cannot use', async () => {
    const body = { values: { 'talent.full_name': 'Jordan Signer' }, created_by: CREATED_BY, client_id: null };
    const digest = signTemplateBodyDigest(body);
    const path = `/v1/documents/esign/templates/${UNKNOWN_TEMPLATE_ID}/render`;
    const query = { tenant_id: TENANT_ID, idempotency_key: 'pact-t5-render-0404', [SIGN_TEMPLATE_BODY_DIGEST_PARAM]: digest };
    const qs = new URLSearchParams(query).toString();
    await provider
      .addInteraction()
      .given('an Aramo default template is resolvable for the tenant')
      .uponReceiving('a template render for a template the tenant cannot use')
      .withRequest('POST', path, (b) => {
        b.query(query).headers(headerMatchers('POST', `http://core${path}?${qs}`, true)).jsonBody(body);
      })
      // The adapter passes the typed refusal through; the contract is the status + code.
      .willRespondWith(404, (b) => {
        b.jsonBody({ error: { code: 'TEMPLATE_NOT_FOUND' } });
      })
      .executeTest(async (mock) => {
        const url = `${mock.url}${path}?${qs}`;
        const res = await fetch(url, { method: 'POST', headers: { ...signed('POST', url), 'content-type': 'application/json' }, body: JSON.stringify(body) });
        expect(res.status).toBe(404);
      });
  });
});

// Amendment M-A6 §3.1–§3.3 — a template with signing roles: listed with its roles and
// metadata (the user chooses it; it is not the automatic choice), rendered with one block per
// SIGNER role whose placements carry the role_key.
describe('sign-service → template library (M-A6 multi-role template)', () => {
  it('lists the template with its roles and list metadata', async () => {
    const path = '/v1/documents/esign/templates';
    await provider
      .addInteraction()
      .given('a tenant template with signing roles is usable for the tenant')
      .uponReceiving('a template-library list including a multi-role template')
      .withRequest('GET', path, (b) => {
        b.query({ tenant_id: ROLES_TENANT_ID }).headers(headerMatchers('GET', `http://core${path}?tenant_id=${ROLES_TENANT_ID}`, false));
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          items: [
            {
              template_id: ROLES_TEMPLATE_ID,
              name: like('Mutual Agreement'),
              description: like('Two-party agreement (pact seed).'),
              document_type: { id: like('d0c50005-0000-7000-8000-000000000001'), key: like('RIGHT_TO_REPRESENT'), name: like('Right to Represent') },
              owner_scope: 'TENANT',
              resolution: 'AVAILABLE',
              is_default: false,
              version_id: ROLES_VERSION_ID,
              version_number: like(1),
              updated_at: like('2026-10-28T00:00:00.000Z'),
              variables: eachLike({ key: like('requisition.title'), label: like('Requisition title'), group: like('Requisition'), source: like('SENDER'), value: null }),
              category: like('Right to Represent'),
              signer_role_count: 2,
              cc_role_count: 1,
              document_count: 1,
              routing_mode: 'SEQUENTIAL',
              signing: ROLES_SIGNING,
            },
          ],
          unavailable: [],
        });
      })
      .executeTest(async (mock) => {
        const url = `${mock.url}${path}?tenant_id=${ROLES_TENANT_ID}`;
        const res = await fetch(url, { headers: signed('GET', url) });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: Array<{ signing: { roles: unknown[] } }> };
        expect(body.items[0]?.signing.roles).toHaveLength(3);
      });
  });

  it('renders one signature block per SIGNER role (placements carry role_key)', async () => {
    const body = { values: { 'requisition.title': 'Analyst' }, created_by: CREATED_BY, client_id: null };
    const digest = signTemplateBodyDigest(body);
    const path = `/v1/documents/esign/templates/${ROLES_TEMPLATE_ID}/render`;
    const query = { tenant_id: ROLES_TENANT_ID, idempotency_key: 'pact-m-a6-render-0001', [SIGN_TEMPLATE_BODY_DIGEST_PARAM]: digest };
    const qs = new URLSearchParams(query).toString();
    const placement = (field_type: string, role_key: string) => ({ field_type, role_key, page_number: like(0), x: like(54), y: like(500), width: like(160), height: like(16) });
    await provider
      .addInteraction()
      .given('a tenant template with signing roles is usable for the tenant')
      .uponReceiving('a multi-role template render for a new Sign envelope')
      .withRequest('POST', path, (b) => {
        b.query(query).headers(headerMatchers('POST', `http://core${path}?${qs}`, true)).jsonBody(body);
      })
      .willRespondWith(201, (b) => {
        b.jsonBody({
          document_id: like('d0c4c000-0000-7000-8000-0000000000e3'),
          document_revision_ref: like('d0c4c000-0000-7000-8000-0000000000e4'),
          source_sha256: regex('^[0-9a-f]{64}$', 'b'.repeat(64)),
          byte_size: like(1024),
          title: like('Mutual Agreement'),
          template_id: ROLES_TEMPLATE_ID,
          template_version_id: ROLES_VERSION_ID,
          version_number: like(1),
          signature_fields: [
            placement('SIGNATURE', 'client'),
            placement('SIGNER_NAME', 'client'),
            placement('SIGN_DATE', 'client'),
            placement('SIGNATURE', 'agency'),
            placement('SIGNER_NAME', 'agency'),
            placement('SIGN_DATE', 'agency'),
          ],
          field_definitions: [],
          signing: ROLES_SIGNING,
        });
      })
      .executeTest(async (mock) => {
        const url = `${mock.url}${path}?${qs}`;
        const res = await fetch(url, { method: 'POST', headers: { ...signed('POST', url), 'content-type': 'application/json' }, body: JSON.stringify(body) });
        expect(res.status).toBe(201);
        const out = (await res.json()) as { signature_fields: Array<{ role_key: string }> };
        expect(out.signature_fields.map((f) => f.role_key)).toEqual(['client', 'client', 'client', 'agency', 'agency', 'agency']);
      });
  });
});
