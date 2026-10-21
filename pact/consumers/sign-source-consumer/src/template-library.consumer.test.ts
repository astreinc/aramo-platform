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
