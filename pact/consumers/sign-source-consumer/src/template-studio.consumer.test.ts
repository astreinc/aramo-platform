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

// Aramo-TEMPLATE-PRODUCT-1 Implementation Directive v1.0 (LOCKED) §8.3 / §8.5 (§6.5 "new consumer
// interactions are added for §8 routes") — the Studio + "Use as it is" calls sign-service makes
// against apps/api over the signed service-to-service channel.
//
// Consumer:  sign-service   (apps/sign-service DocumentTemplateStudioHttpAdapter →
//                             GET  /v1/documents/esign/templates/library
//                             POST /v1/documents/esign/templates/library/:id/adopt-and-use
//                             GET  /v1/documents/esign/templates/studio
//                             POST /v1/documents/esign/templates/studio/adopt)
// Provider:  aramo-core      (apps/api DocumentsEsignTemplateGalleryController /
//                             DocumentsEsignTemplateStudioController).
//
// Mirrors the EXACT requests the adapter issues: tenant_id (+ actor_id) and, for a POST, the body
// digest `body_sha256` in the query, all signed with aramo-sign-s2s-v1. The signature is dynamic,
// so the contract pins the header FORMAT; the provider re-signs the replayed request
// (verify-api.ts requestFilter) against the STRICT production guard.

const SECRET = 'pact-test-esign-webhook-secret';
const TS_FORMAT = '^\\d{1,12}$';
const SIG_FORMAT = '^[A-Za-z0-9+/]{43}=$';

// Seeded by 'a personal account may adopt and use Aramo templates tagged sign' (verify-api.ts).
const PERSONAL_TENANT_ID = '11111111-1111-7111-8111-1111111111b7';
const OWNER_ID = 'd0c4c000-0000-7000-8000-0000000000b7';
// The Aramo (PLATFORM) Right to Represent default tagged {ats,sign} (the T-5 seed).
const DEFAULT_ID = 'd0c4c000-0000-7000-8000-0000000000d1';
const DEFAULT_VERSION_ID = 'd0c4c000-0000-7000-8000-0000000000d2';
// A BUSINESS tenant (the provider's default tenant).
const BUSINESS_TENANT_ID = '11111111-1111-7111-8111-111111111111';

type Method = 'GET' | 'POST';

function signed(method: Method, url: string): Record<string, string> {
  return signEsignServiceRequest({ method, url, secret: SECRET, nowSec: Math.floor(Date.now() / 1000) });
}

function headerMatchers(method: Method, url: string, json: boolean) {
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

const STATE = 'a personal account may adopt and use Aramo templates tagged sign';
const UUID = regex('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', 'd0c4c000-0000-7000-8000-0000000000e9');

describe('sign-service → GET /v1/documents/esign/templates/library', () => {
  it('lists the Aramo defaults tagged sign, with the tenant’s adopted copy', async () => {
    const path = '/v1/documents/esign/templates/library';
    const query = { tenant_id: PERSONAL_TENANT_ID };
    const qs = new URLSearchParams(query).toString();
    await provider
      .addInteraction()
      .given(STATE)
      .uponReceiving('a Sign template gallery read')
      .withRequest('GET', path, (b) => {
        b.query(query).headers(headerMatchers('GET', `http://core${path}?${qs}`, false));
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          items: eachLike({
            template_id: DEFAULT_ID,
            name: like('Standard Right to Represent'),
            description: like('Aramo default (pact seed).'),
            document_type: { id: like('d0c50005-0000-7000-8000-000000000001'), name: like('Right to Represent') },
            products: eachLike('sign'),
            version_id: DEFAULT_VERSION_ID,
            version_number: like(1),
            updated_at: like('2026-11-02T00:00:00.000Z'),
            adopted_template_id: null,
          }),
        });
      })
      .executeTest(async (mock) => {
        const url = `${mock.url}${path}?${qs}`;
        const res = await fetch(url, { headers: signed('GET', url) });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: Array<{ template_id: string }> };
        expect(body.items[0]?.template_id).toBe(DEFAULT_ID);
      });
  });
});

describe('sign-service → the Personal Studio', () => {
  it('GET /studio lists the person’s templates and the defaults tagged sign', async () => {
    const path = '/v1/documents/esign/templates/studio';
    const query = { tenant_id: PERSONAL_TENANT_ID, actor_id: OWNER_ID };
    const qs = new URLSearchParams(query).toString();
    await provider
      .addInteraction()
      .given(STATE)
      .uponReceiving('a Personal Studio list from Aramo Sign')
      .withRequest('GET', path, (b) => {
        b.query(query).headers(headerMatchers('GET', `http://core${path}?${qs}`, false));
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          items: eachLike({
            id: DEFAULT_ID,
            owner_scope: 'PLATFORM',
            document_type_id: like('d0c50005-0000-7000-8000-000000000001'),
            name: like('Standard Right to Represent'),
            status: 'ACTIVE',
            current_version_id: DEFAULT_VERSION_ID,
            products: eachLike('sign'),
            configurable: true,
            adopted_template_id: null,
          }),
          document_types: eachLike({ id: like('d0c50005-0000-7000-8000-000000000001'), key: like('RIGHT_TO_REPRESENT'), name: like('Right to Represent'), configurable: like(true) }),
        });
      })
      .executeTest(async (mock) => {
        const url = `${mock.url}${path}?${qs}`;
        const res = await fetch(url, { headers: signed('GET', url) });
        expect(res.status).toBe(200);
      });
  });

  it('POST /studio/adopt makes a Personal draft', async () => {
    const body = { library_template_id: DEFAULT_ID };
    const path = '/v1/documents/esign/templates/studio/adopt';
    const query = { tenant_id: PERSONAL_TENANT_ID, actor_id: OWNER_ID, [SIGN_TEMPLATE_BODY_DIGEST_PARAM]: signTemplateBodyDigest(body) };
    const qs = new URLSearchParams(query).toString();
    await provider
      .addInteraction()
      .given(STATE)
      .uponReceiving('a Personal Studio adopt from Aramo Sign')
      .withRequest('POST', path, (b) => {
        b.query(query).headers(headerMatchers('POST', `http://core${path}?${qs}`, true)).jsonBody(body);
      })
      .willRespondWith(201, (b) => {
        b.jsonBody({
          template: { id: UUID, owner_scope: 'TENANT', status: 'DRAFT', adopted_from_template_id: DEFAULT_ID },
          version: { id: UUID, status: 'DRAFT', version_number: 1, render_schema_version: 'rtr-html-v1' },
        });
      })
      .executeTest(async (mock) => {
        const url = `${mock.url}${path}?${qs}`;
        const res = await fetch(url, { method: 'POST', headers: { ...signed('POST', url), 'content-type': 'application/json' }, body: JSON.stringify(body) });
        expect(res.status).toBe(201);
      });
  });

  it('a BUSINESS tenant is refused 403 (Org Home owns organization templates)', async () => {
    const path = '/v1/documents/esign/templates/studio';
    const query = { tenant_id: BUSINESS_TENANT_ID, actor_id: OWNER_ID };
    const qs = new URLSearchParams(query).toString();
    await provider
      .addInteraction()
      .given(STATE)
      .uponReceiving('a Personal Studio list for a BUSINESS tenant')
      .withRequest('GET', path, (b) => {
        b.query(query).headers(headerMatchers('GET', `http://core${path}?${qs}`, false));
      })
      // The adapter passes this person-level refusal through; the contract is status + reason.
      .willRespondWith(403, (b) => {
        b.jsonBody({ error: { code: 'INSUFFICIENT_PERMISSIONS', details: { reason: 'organization_templates_in_org_home' } } });
      })
      .executeTest(async (mock) => {
        const url = `${mock.url}${path}?${qs}`;
        const res = await fetch(url, { headers: signed('GET', url) });
        expect(res.status).toBe(403);
      });
  });
});
