import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { like, uuid, integer } = MatchersV3;

// DOC-3 — cross-service E-Sign provider contract.
//
// Consumer:  aramo-core        (apps/api, via EsignServiceHttpProvider — the
//                               SignatureProviderPort HTTP adapter)
// Provider:  sign-service     (apps/sign-service)
//
// This is the TRANSPORT contract Documents (in apps/api) invokes to drive
// signature execution — provider-neutral (libs/documents-contracts). apps/api
// reaches E-Sign ONLY over HTTP through this seam; it never touches the esign
// schema. RTR/Offer (DOC-5/6) consume this already-complete seam.
//
// Coverage: the request/response contract shape of the provider surface —
//   1. POST /v1/sign/envelopes                    201 EnvelopeSummary (fresh)
//   2. GET  /v1/sign/envelopes/{id}               200 EnvelopeSummary
//   3. GET  /v1/sign/envelopes/{id}/evidence      200 EvidenceSummary

const provider = new PactV4({
  consumer: 'aramo-core',
  provider: 'sign-service',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

const TENANT_ID = '11111111-1111-7111-8111-111111111111';
const ENVELOPE_ID = '22222222-2222-7222-8222-222222222222';
const SIGNER_ID = '33333333-3333-7333-8333-333333333333';
const CREATED_BY = '44444444-4444-7444-8444-444444444444';
const DOC_REF = '55555555-5555-7555-8555-555555555555';
const REV_REF = '66666666-6666-7666-8666-666666666666';
const SHA256 = 'a'.repeat(64);
// COMM-RECRUITER-W1 (W1-C) — DEDICATED ids so the reverse-lookup/reminder fixtures
// never collide with the shared DOC_REF/REV_REF/ENVELOPE_ID used by other states
// (which would make the lookup ambiguous).
const RTR_ENVELOPE_ID = '77777777-7777-7777-8777-777777777777';
const RTR_DOC_REF = '88888888-8888-7888-8888-888888888888';
const RTR_REV_REF = '99999999-9999-7999-8999-999999999999';

describe('aramo-core → POST /v1/sign/envelopes', () => {
  it('returns 201 EnvelopeSummary for a fresh envelope', async () => {
    await provider
      .addInteraction()
      .given('no prior envelope for the request')
      .uponReceiving('a create-envelope request from the Documents provider adapter')
      .withRequest('POST', '/v1/sign/envelopes', (b) => {
        b.headers({ 'Content-Type': 'application/json' }).jsonBody({
          tenant_id: TENANT_ID,
          subject: 'Offer Letter',
          execution_mode: 'SINGLE_SIGNATURE',
          created_by: CREATED_BY,
          documents: [
            {
              document_ref: DOC_REF,
              document_revision_ref: REV_REF,
              title: 'offer.pdf',
              source_sha256: SHA256,
              ordinal: 1,
            },
          ],
          signers: [{ email: 'jane@example.com', name: 'Jane Doe', signing_order: 1 }],
        });
      })
      .willRespondWith(201, (b) => {
        b.jsonBody({
          envelope_id: uuid(ENVELOPE_ID),
          status: like('DRAFT'),
          signers: [{ signer_id: uuid(SIGNER_ID), email: like('jane@example.com'), status: like('PENDING') }],
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/envelopes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tenant_id: TENANT_ID,
            subject: 'Offer Letter',
            execution_mode: 'SINGLE_SIGNATURE',
            created_by: CREATED_BY,
            documents: [
              { document_ref: DOC_REF, document_revision_ref: REV_REF, title: 'offer.pdf', source_sha256: SHA256, ordinal: 1 },
            ],
            signers: [{ email: 'jane@example.com', name: 'Jane Doe', signing_order: 1 }],
          }),
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as { envelope_id: string; status: string };
        expect(body.status).toBe('DRAFT');
      });
  });
});

describe('aramo-core → GET /v1/sign/envelopes/{id}', () => {
  it('returns 200 EnvelopeSummary for an existing envelope', async () => {
    await provider
      .addInteraction()
      .given('a signature envelope exists')
      .uponReceiving('a get-envelope request')
      .withRequest('GET', `/v1/sign/envelopes/${ENVELOPE_ID}`, (b) => {
        b.query({ tenant_id: TENANT_ID });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          envelope_id: uuid(ENVELOPE_ID),
          status: like('DRAFT'),
          signers: [{ signer_id: uuid(SIGNER_ID), email: like('jane@example.com'), status: like('PENDING') }],
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/envelopes/${ENVELOPE_ID}?tenant_id=${TENANT_ID}`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { envelope_id: string };
        expect(body.envelope_id).toBe(ENVELOPE_ID);
      });
  });
});

describe('aramo-core → GET /v1/sign/envelopes/{id}/evidence', () => {
  it('returns 200 EvidenceSummary with an event-chain hash + software signature', async () => {
    await provider
      .addInteraction()
      .given('a signature envelope exists')
      .uponReceiving('a get-evidence request')
      .withRequest('GET', `/v1/sign/envelopes/${ENVELOPE_ID}/evidence`, (b) => {
        b.query({ tenant_id: TENANT_ID });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          envelope_id: uuid(ENVELOPE_ID),
          status: like('DRAFT'),
          event_chain_hash: like('QmV2ZW50Q2hhaW5IYXNo'),
          signature: like('c2lnbmF0dXJl'),
          signature_algorithm: like('SHA256-SOFTWARE-DOC3'),
          completed_at: null,
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/envelopes/${ENVELOPE_ID}/evidence?tenant_id=${TENANT_ID}`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { envelope_id: string; signature_algorithm: string };
        expect(body.envelope_id).toBe(ENVELOPE_ID);
      });
  });
});

// DOC-4C (R1 seam B) — the executed-artifact PULL apps/api performs after
// completion (EsignExecutedArtifactsClient, apps/api/src/documents/esign-writeback.ts
// → GET /v1/sign/envelopes/:id/executed). A NEW INTERACTION on the SAME
// aramo-core → sign-service relationship (not a new consumer identity).
describe('aramo-core → GET /v1/sign/envelopes/{id}/executed', () => {
  // A DISTINCT COMPLETED envelope (the 'a signature envelope exists' fixture is a
  // DRAFT with no executed artifacts, and SignatureEvent is append-only so it
  // cannot be re-seeded onto the same id).
  const EXEC_ENVELOPE_ID = '88888888-8888-7888-8888-888888888888';
  const EXEC_ENV_DOC_ID = '99999999-9999-7999-8999-999999999999';
  it('returns 200 ExecutedArtifactsBundle (executed documents + certificate, base64)', async () => {
    await provider
      .addInteraction()
      .given('an executed envelope exists')
      .uponReceiving('an executed-artifact pull for the Documents write-back')
      .withRequest('GET', `/v1/sign/envelopes/${EXEC_ENVELOPE_ID}/executed`, (b) => {
        b.query({ tenant_id: TENANT_ID });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          envelope_id: uuid(EXEC_ENVELOPE_ID),
          documents: [
            {
              envelope_document_id: uuid(EXEC_ENV_DOC_ID),
              document_ref: uuid(DOC_REF),
              document_revision_ref: uuid(REV_REF),
              executed_sha256: like('b'.repeat(64)),
              byte_size: like(12),
              executed_base64: like('JVBERi0xLjQ='),
            },
          ],
          certificate: {
            certificate_sha256: like('c'.repeat(64)),
            byte_size: like(10),
            certificate_base64: like('Y2VydA=='),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/envelopes/${EXEC_ENVELOPE_ID}/executed?tenant_id=${TENANT_ID}`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { envelope_id: string; documents: unknown[]; certificate: unknown };
        expect(body.envelope_id).toBe(EXEC_ENVELOPE_ID);
        expect(Array.isArray(body.documents)).toBe(true);
        expect(body.certificate).not.toBeNull();
      });
  });
});

// COMM-RECRUITER-W1 (W1-C) — reverse envelope lookup + same-envelope reminder.
describe('aramo-core → GET /v1/sign/envelopes/for-document', () => {
  it('returns 200 { envelope } with the single non-terminal envelope for a document revision', async () => {
    await provider
      .addInteraction()
      .given('a non-terminal signature envelope exists for the document revision')
      .uponReceiving('a reverse envelope lookup for an exact document revision')
      .withRequest('GET', '/v1/sign/envelopes/for-document', (b) => {
        b.query({ tenant_id: TENANT_ID, document_ref: RTR_DOC_REF, document_revision_ref: RTR_REV_REF });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          envelope: {
            envelope_id: uuid(RTR_ENVELOPE_ID),
            status: like('SENT'),
            signers: [{ signer_id: uuid(SIGNER_ID), email: like('jane@example.com'), status: like('PENDING') }],
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/sign/envelopes/for-document?tenant_id=${TENANT_ID}&document_ref=${RTR_DOC_REF}&document_revision_ref=${RTR_REV_REF}`,
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { envelope: { envelope_id: string } | null };
        expect(body.envelope?.envelope_id).toBe(RTR_ENVELOPE_ID);
      });
  });
});

describe('aramo-core → POST /v1/sign/envelopes/{id}/remind', () => {
  it('returns 200 EnvelopeSummary (status unchanged) for a same-envelope reminder', async () => {
    await provider
      .addInteraction()
      .given('a sent signature envelope with an incomplete signer exists')
      .uponReceiving('a same-envelope reminder request')
      .withRequest('POST', `/v1/sign/envelopes/${RTR_ENVELOPE_ID}/remind`, (b) => {
        b.jsonBody({ tenant_id: uuid(TENANT_ID) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          envelope_id: uuid(RTR_ENVELOPE_ID),
          status: like('SENT'),
          signers: [{ signer_id: uuid(SIGNER_ID), email: like('jane@example.com'), status: like('PENDING') }],
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/envelopes/${RTR_ENVELOPE_ID}/remind`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tenant_id: TENANT_ID }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { envelope_id: string };
        expect(body.envelope_id).toBe(RTR_ENVELOPE_ID);
      });
  });
});

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
