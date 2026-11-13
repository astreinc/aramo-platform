import { resolve } from 'node:path';

import { MatchersV3, PactV4 } from '@pact-foundation/pact';
import { describe, expect, it } from 'vitest';

const { boolean, eachLike, like, regex } = MatchersV3;

// India Billing Regions + Razorpay Directive v1.0 (LOCKED) §4.10 — the platform console's Commercial ›
// Billing regions screen contract with platform-admin for its one route, allowed AND refused (the
// verifier's CCP route coverage gate needs an allowed, a super_admin and a tenant-tier interaction).
// Written to the SAME pact file as platform-commercial.consumer.test.ts (platform-web → platform-admin).
//
// The screen ALSO calls POST /platform/commercial/change-requests (BILLING_REGION_CHANGE) and
// POST …/{id}/submit; those routes are contracted in platform-commercial.consumer.test.ts.
//
// Coverage — India Billing routes (1):
//   GET /platform/commercial/billing-regions
// Request shapes are byte-aligned with apps/platform-web/src/commercial/billing-regions/billing-regions-api.ts.

const provider = new PactV4({
  consumer: 'platform-web',
  provider: 'platform-admin',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

type Role = 'catalog_manager' | 'super_admin';
const PATH = '/platform/commercial/billing-regions';
const platformSession = (role: Role) => ({ 'X-Aramo-Consumer': 'platform', Cookie: `aramo_access_token_platform=pact-${role}` });
const TENANT_TIER = { 'X-Aramo-Consumer': 'recruiter', Cookie: 'aramo_access_token_recruiter=pact-recruiter' };

function errorBody(code: string, details: unknown): Record<string, unknown> {
  return { error: { code, message: like('refused'), request_id: like('req-1'), details } };
}

async function call(url: string, headers: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, { method: 'GET', headers });
  const text = await res.text();
  return { status: res.status, body: (text.length > 0 ? JSON.parse(text) : {}) as Record<string, unknown> };
}

describe('platform-web → GET /platform/commercial/billing-regions (India Billing §4.10)', () => {
  it('catalog_manager reads the billing regions (the seeded US / IN rows) (200)', async () => {
    await provider
      .addInteraction()
      .given('platform operators are provisioned')
      .uponReceiving('a billing regions read by the catalog manager')
      .withRequest('GET', PATH, (b) => {
        b.headers(platformSession('catalog_manager'));
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          regions: eachLike({
            country: regex('^[A-Z]{2}$', 'IN'),
            gateway: regex('^(STRIPE|RAZORPAY)$', 'RAZORPAY'),
            currency: regex('^[A-Z]{3}$', 'INR'),
            enabled: boolean(false),
            personal_web_enabled: boolean(false),
            business_web_enabled: boolean(false),
            price_tax_mode: regex('^(UNSET|INCLUSIVE|EXCLUSIVE)$', 'UNSET'),
            selling_entity: {
              id: like('019a0000-0000-7000-8000-0000000a1e02'),
              key: like('aramo-in'),
              display_name: like('Aramo India'),
              legal_name: like('Aramo India'),
              country: regex('^[A-Z]{2}$', 'IN'),
              active: boolean(false),
            },
            gateway_configured: boolean(false),
            registration: like({}),
            open_requests: like([]),
          }),
        });
      })
      .executeTest(async (mock) => {
        const res = await call(`${mock.url}${PATH}`, platformSession('catalog_manager'));
        expect(res.status).toBe(200);
        expect((res.body['regions'] as { country: string }[])[0]?.country).toBe('IN');
      });
  });

  it('super_admin → 403 missing platform:catalog:read', async () => {
    await provider
      .addInteraction()
      .given('platform operators are provisioned')
      .uponReceiving('a billing regions read by super_admin')
      .withRequest('GET', PATH, (b) => {
        b.headers(platformSession('super_admin'));
      })
      .willRespondWith(403, (b) => {
        b.jsonBody(errorBody('INSUFFICIENT_PERMISSIONS', { missing_scopes: ['platform:catalog:read'] }));
      })
      .executeTest(async (mock) => {
        expect((await call(`${mock.url}${PATH}`, platformSession('super_admin'))).status).toBe(403);
      });
  });

  it('a tenant-tier session → 403 tenant_token_on_platform_route', async () => {
    await provider
      .addInteraction()
      .given('platform operators are provisioned')
      .uponReceiving('a billing regions read with a tenant-tier session')
      .withRequest('GET', PATH, (b) => {
        b.headers(TENANT_TIER);
      })
      .willRespondWith(403, (b) => {
        b.jsonBody(errorBody('INSUFFICIENT_PERMISSIONS', { reason: 'tenant_token_on_platform_route' }));
      })
      .executeTest(async (mock) => {
        expect((await call(`${mock.url}${PATH}`, TENANT_TIER)).status).toBe(403);
      });
  });
});
