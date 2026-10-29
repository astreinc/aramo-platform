import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { like, uuid, integer } = MatchersV3;

// aramo-core (apps/api) → sign-service contracts.
//
// Aramo-Sign-Domain-Isolation-Reconciliation-V1-Directive-v1_0-LOCKED §3 H-2 — the legacy
// unauthenticated provider seam (/v1/sign/envelopes, EsignServiceHttpProvider) is retired:
// the ATS reaches Aramo Sign only through the authenticated Sign API (below) and the
// Sign-owned talent-erasure contract (end of file). apps/api never touches the sign schema.

const provider = new PactV4({
  consumer: 'aramo-core',
  provider: 'sign-service',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

const SHA256 = 'a'.repeat(64);

beforeAll(() => undefined);
afterAll(() => undefined);

// Aramo-Sign-Unified-Product-S6-ATS-Migration-Addendum-v1_0-LOCKED — the ATS
// (aramo-core) as a client of the authenticated Sign API (SIGN_ATS_TRANSPORT=api).
//
// Consumer:  aramo-core   (apps/api: EsignServiceApiProvider + SignApiClient +
//                         EsignExecutedArtifactsClient)
// Provider:  sign-service
//
// Coverage (the API-transport contract the ATS relies on):
//   1. POST /v1/sign/api/envelopes            201 EnvelopeSummary  (user grant)
//   2. GET  /v1/sign/api/availability         200 availability     (user grant)
//   3. GET  /v1/sign/api/envelopes/for-document 200 { envelope }   (user grant)
//   4. POST /v1/sign/oauth/token  (sign-event) 200 event-bound grant (client credential + delivered event)
//   5. GET  /v1/sign/api/envelopes/{id}/executed 200 executed bundle (event grant)
// The user-mode token exchange itself (a real RS256 recruiter token) is proven
// end to end in apps/sign-service/src/tests/sign-api.integration.spec.ts; here
// the provider seeds the live grants the consumer presents.

// MUST match pact/provider/src/verify-sign.ts (ATS API-transport fixtures).
const ATS_TENANT_ID = 'a7500000-0000-7000-8000-000000000001';
const ATS_USER_GRANT = 'sgt_pact_ats_user_grant_0123456789abcdefghij';
const ATS_EVENT_GRANT = 'sgt_pact_ats_event_grant_0123456789abcdefghi';
const ATS_CLIENT_ID = 'sgc_pact_ats';
const ATS_CLIENT_SECRET = 'sgs_pact_ats_secret_0123456789abcdefghijklmnop';
const ATS_EVENT_ID = 'a7500000-0000-7000-8000-0000000000e1';
const ATS_EXEC_ENVELOPE_ID = 'a7500000-0000-7000-8000-0000000000f1';
const ATS_DOC_REF = 'a7500000-0000-7000-8000-0000000000d1';
const ATS_REV_REF = 'a7500000-0000-7000-8000-0000000000d2';

describe('aramo-core → Sign API (API transport)', () => {
  it('creates an envelope by reference under the recruiter’s delegated grant', async () => {
    await provider
      .addInteraction()
      .given('an ATS user grant is live')
      .uponReceiving('a Sign API create-envelope request from the ATS')
      .withRequest('POST', '/v1/sign/api/envelopes', (b) => {
        b.headers({ 'Content-Type': 'application/json', authorization: `Bearer ${ATS_USER_GRANT}` }).jsonBody({
          subject: 'Right to Represent',
          documents: [{ document_ref: ATS_DOC_REF, document_revision_ref: ATS_REV_REF, title: 'Right to Represent', source_sha256: SHA256, ordinal: 1 }],
          signers: [{ name: 'Jane Doe', email: 'jane@example.com', signing_order: 1 }],
        });
      })
      .willRespondWith(201, (b) => {
        b.jsonBody({ envelope_id: uuid(), status: like('DRAFT'), signers: [{ signer_id: uuid(), email: like('jane@example.com'), status: like('PENDING') }] });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/api/envelopes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', authorization: `Bearer ${ATS_USER_GRANT}` },
          body: JSON.stringify({
            subject: 'Right to Represent',
            documents: [{ document_ref: ATS_DOC_REF, document_revision_ref: ATS_REV_REF, title: 'Right to Represent', source_sha256: SHA256, ordinal: 1 }],
            signers: [{ name: 'Jane Doe', email: 'jane@example.com', signing_order: 1 }],
          }),
        });
        expect(res.status).toBe(201);
      });
  });

  it('reads Sign-owned availability', async () => {
    await provider
      .addInteraction()
      .given('an ATS user grant is live')
      .uponReceiving('a Sign API availability read from the ATS')
      .withRequest('GET', '/v1/sign/api/availability', (b) => {
        b.headers({ authorization: `Bearer ${ATS_USER_GRANT}` });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ available: like(true), reason: null, allowance: like({ used: 0, period_start: '2026-10-01T00:00:00.000Z' }) });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/api/availability`, { headers: { authorization: `Bearer ${ATS_USER_GRANT}` } });
        expect(res.status).toBe(200);
      });
  });

  it('reverse-resolves the envelope of a document revision (none yet)', async () => {
    await provider
      .addInteraction()
      .given('an ATS user grant is live')
      .uponReceiving('a Sign API for-document lookup from the ATS')
      .withRequest('GET', '/v1/sign/api/envelopes/for-document', (b) => {
        b.headers({ authorization: `Bearer ${ATS_USER_GRANT}` }).query({ document_ref: 'a7500000-0000-7000-8000-0000000000d9', document_revision_ref: ATS_REV_REF });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ envelope: null });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/api/envelopes/for-document?document_ref=a7500000-0000-7000-8000-0000000000d9&document_revision_ref=${ATS_REV_REF}`, {
          headers: { authorization: `Bearer ${ATS_USER_GRANT}` },
        });
        expect(await res.json()).toEqual({ envelope: null });
      });
  });

  it('exchanges a delivered completion event for an event-bound read grant (client credential required)', async () => {
    await provider
      .addInteraction()
      .given('a completion event was delivered to the ATS')
      .uponReceiving('an event-bound grant request from the ATS write-back')
      .withRequest('POST', '/v1/sign/oauth/token', (b) => {
        b.headers({ 'Content-Type': 'application/json' }).jsonBody({
          client_id: ATS_CLIENT_ID,
          client_secret: ATS_CLIENT_SECRET,
          grant_type: 'urn:aramo:params:oauth:grant-type:sign-event',
          event_id: ATS_EVENT_ID,
        });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          access_token: like('sgt_x'),
          token_type: 'Bearer',
          expires_in: integer(300),
          scope: 'sign:envelope:read',
          tenant_id: ATS_TENANT_ID,
          installation_id: uuid(),
          mode: 'APPLICATION',
          envelope_id: ATS_EXEC_ENVELOPE_ID,
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/oauth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_id: ATS_CLIENT_ID, client_secret: ATS_CLIENT_SECRET, grant_type: 'urn:aramo:params:oauth:grant-type:sign-event', event_id: ATS_EVENT_ID }),
        });
        expect(res.status).toBe(200);
      });
  });

  it('pulls the executed document and certificate with the event grant', async () => {
    await provider
      .addInteraction()
      .given('an ATS event grant is live')
      .uponReceiving('an executed-artifact pull from the ATS write-back over the Sign API')
      .withRequest('GET', `/v1/sign/api/envelopes/${ATS_EXEC_ENVELOPE_ID}/executed`, (b) => {
        b.headers({ authorization: `Bearer ${ATS_EVENT_GRANT}` });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          envelope_id: ATS_EXEC_ENVELOPE_ID,
          documents: [
            {
              envelope_document_id: uuid(),
              document_ref: uuid(),
              document_revision_ref: uuid(),
              executed_sha256: like('b'.repeat(64)),
              byte_size: integer(8),
              executed_base64: like('JVBERi0xLjQ='),
            },
          ],
          certificate: { certificate_sha256: like('c'.repeat(64)), byte_size: integer(4), certificate_base64: like('Y2VydA==') },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/api/envelopes/${ATS_EXEC_ENVELOPE_ID}/executed`, { headers: { authorization: `Bearer ${ATS_EVENT_GRANT}` } });
        expect(res.status).toBe(200);
      });
  });
});

// Aramo-Sign-Domain-Isolation-Reconciliation-V1-Directive-v1_0-LOCKED §2 R-3, §4 D-1/D-2 — the
// Sign-owned talent-erasure contract the ATS erasure engine calls (apps/api
// SignTalentErasureClient) instead of reading or writing the sign schema. Internal only;
// authenticated as the first-party aramo-ats Sign API client (HTTP Basic).
const ATS_BASIC = `Basic ${Buffer.from(`${ATS_CLIENT_ID}:${ATS_CLIENT_SECRET}`, 'utf8').toString('base64')}`;
const ERASE_RECORD_ID = 'a7500000-0000-7000-8000-0000000000c1';
const ERASE_RUN_ID = 'a7500000-0000-7000-8000-0000000000c2';
// A document no provider fixture covers with an envelope (ATS_DOC_REF is under one).
const ERASE_DOC_REF = 'a7500000-0000-7000-8000-0000000000c3';

describe('aramo-core → Sign talent-erasure contract', () => {
  it('asks Sign which of its records block erasing a talent', async () => {
    const body = { tenant_id: ATS_TENANT_ID, record_ids: [ERASE_RECORD_ID], document_refs: [ERASE_DOC_REF] };
    await provider
      .addInteraction()
      .given('the ATS Sign client is registered')
      .uponReceiving('a talent-erasure preflight from the ATS erasure engine')
      .withRequest('POST', '/v1/sign/s2s/talent-erasure/preflight', (b) => {
        b.headers({ 'Content-Type': 'application/json', authorization: ATS_BASIC }).jsonBody(body);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ holders: [], erasable: { idempotency_keys: integer(0), api_idempotency_keys: integer(0), outbox_events: integer(0) } });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/s2s/talent-erasure/preflight`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', authorization: ATS_BASIC },
          body: JSON.stringify(body),
        });
        expect(res.status).toBe(200);
      });
  });

  it('asks Sign to erase its own rows naming the talent', async () => {
    const body = { tenant_id: ATS_TENANT_ID, record_ids: [ERASE_RECORD_ID], document_refs: [], run_id: ERASE_RUN_ID };
    await provider
      .addInteraction()
      .given('the ATS Sign client is registered')
      .uponReceiving('a talent-erasure request from the ATS erasure engine')
      .withRequest('POST', '/v1/sign/s2s/talent-erasure/erase', (b) => {
        b.headers({ 'Content-Type': 'application/json', authorization: ATS_BASIC }).jsonBody(body);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ status: 'erased', run_id: ERASE_RUN_ID, counts: { idempotency_keys: integer(0), api_idempotency_keys: integer(0), outbox_events: integer(0) } });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/s2s/talent-erasure/erase`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', authorization: ATS_BASIC },
          body: JSON.stringify(body),
        });
        expect(res.status).toBe(200);
      });
  });
});
