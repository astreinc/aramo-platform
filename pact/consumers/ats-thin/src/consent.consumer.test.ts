import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { like, uuid, regex } = MatchersV3;

// PR-2 / PR-3 Pact consumer test for the ATS thin client.
// PR-2 covers /v1/consent/grant.
// PR-3 covers /v1/consent/revoke (canonical contract per Group 2 §2.7).
// Provider verification is deferred until Talent / Tenant entity PRs land.
const provider = new PactV4({
  consumer: 'ats-thin',
  provider: 'aramo-core',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

const TENANT_ID = '11111111-1111-7111-8111-111111111111';
const TALENT_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const IDEMPOTENCY_KEY = 'd2d7a0f0-0000-7000-8000-000000000001';
const REVOKE_KEY_HAPPY = 'd2d7a0f0-0000-7000-8000-000000000099';
const REVOKE_KEY_NOPRIOR = 'd2d7a0f0-0000-7000-8000-000000000098';
const REVOKE_KEY_CONFLICT = 'd2d7a0f0-0000-7000-8000-000000000097';
const REQUEST_ID = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1a00';
const PRIOR_GRANT_ID = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1a01';

const grantBody = {
  talent_id: TALENT_ID,
  scope: 'matching',
  captured_method: 'recruiter_capture',
  consent_version: 'v1',
  occurred_at: '2026-04-29T00:00:00Z',
};

const revokeBody = {
  talent_id: TALENT_ID,
  scope: 'matching',
  captured_method: 'recruiter_capture',
  consent_version: 'v1',
  occurred_at: '2026-04-29T01:00:00Z',
};

describe('ATS thin consumer → POST /v1/consent/grant', () => {
  it('records a grant and returns the locked 201 response shape', async () => {
    await provider
      .addInteraction()
      .given('a valid recruiter token and an ungranted talent')
      .uponReceiving('a consent grant request')
      .withRequest('POST', '/v1/consent/grant', (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'Idempotency-Key': IDEMPOTENCY_KEY,
          'Content-Type': 'application/json',
        }).jsonBody(grantBody);
      })
      .willRespondWith(201, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          event_id: uuid(),
          tenant_id: uuid(TENANT_ID),
          talent_id: uuid(TALENT_ID),
          scope: 'matching',
          action: 'granted',
          captured_method: 'recruiter_capture',
          captured_by_actor_id: uuid(),
          consent_version: 'v1',
          occurred_at: regex(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
            '2026-04-29T00:00:00Z',
          ),
          recorded_at: regex(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
            '2026-04-29T00:00:01Z',
          ),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/consent/grant`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'Idempotency-Key': IDEMPOTENCY_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(grantBody),
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as { action: string };
        expect(body.action).toBe('granted');
      });
  });

  it('returns 400 VALIDATION_ERROR when Idempotency-Key is missing', async () => {
    await provider
      .addInteraction()
      .given('a valid recruiter token')
      .uponReceiving('a consent grant request without Idempotency-Key')
      .withRequest('POST', '/v1/consent/grant', (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'Content-Type': 'application/json',
        }).jsonBody(grantBody);
      })
      .willRespondWith(400, (b) => {
        b.jsonBody({
          error: {
            code: 'VALIDATION_ERROR',
            message: like('Idempotency-Key header is required'),
            request_id: uuid(),
            details: like({ missing_field: 'Idempotency-Key' }),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/consent/grant`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(grantBody),
        });
        expect(res.status).toBe(400);
      });
  });

  it('returns 401 INVALID_TOKEN when the bearer token is malformed', async () => {
    await provider
      .addInteraction()
      .given('no valid token')
      .uponReceiving('a grant request with a malformed bearer token')
      .withRequest('POST', '/v1/consent/grant', (b) => {
        b.headers({
          Authorization: 'Bearer not-a-jwt',
          'Idempotency-Key': IDEMPOTENCY_KEY,
          'Content-Type': 'application/json',
        }).jsonBody(grantBody);
      })
      .willRespondWith(401, (b) => {
        b.jsonBody({
          error: {
            code: 'INVALID_TOKEN',
            message: like('Token verification failed'),
            request_id: uuid(),
            details: like({}),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/consent/grant`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer not-a-jwt',
            'Idempotency-Key': IDEMPOTENCY_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(grantBody),
        });
        expect(res.status).toBe(401);
      });
  });

  it('returns 409 IDEMPOTENCY_KEY_CONFLICT when the same key is replayed with a different body', async () => {
    await provider
      .addInteraction()
      .given('an idempotency key already used with a different body')
      .uponReceiving('a replay grant request with mismatched body')
      .withRequest('POST', '/v1/consent/grant', (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'Idempotency-Key': IDEMPOTENCY_KEY,
          'Content-Type': 'application/json',
        }).jsonBody({ ...grantBody, scope: 'contacting' });
      })
      .willRespondWith(409, (b) => {
        b.jsonBody({
          error: {
            code: 'IDEMPOTENCY_KEY_CONFLICT',
            message: like('Same idempotency key used with a different request body'),
            request_id: uuid(),
            details: like({}),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/consent/grant`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'Idempotency-Key': IDEMPOTENCY_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ...grantBody, scope: 'contacting' }),
        });
        expect(res.status).toBe(409);
      });
  });
});

describe('ATS thin consumer → POST /v1/consent/revoke', () => {
  it('records a revoke and returns the locked 201 response shape (with revoked_event_id)', async () => {
    await provider
      .addInteraction()
      .given('a valid recruiter token and a prior grant for talent+scope')
      .uponReceiving('a consent revoke request after a prior grant')
      .withRequest('POST', '/v1/consent/revoke', (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'Idempotency-Key': REVOKE_KEY_HAPPY,
          'Content-Type': 'application/json',
        }).jsonBody(revokeBody);
      })
      .willRespondWith(201, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          event_id: uuid(),
          tenant_id: uuid(TENANT_ID),
          talent_id: uuid(TALENT_ID),
          scope: 'matching',
          action: 'revoked',
          captured_method: 'recruiter_capture',
          captured_by_actor_id: uuid(),
          consent_version: 'v1',
          occurred_at: regex(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
            '2026-04-29T01:00:00Z',
          ),
          recorded_at: regex(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
            '2026-04-29T01:00:01Z',
          ),
          revoked_event_id: uuid(PRIOR_GRANT_ID),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/consent/revoke`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'Idempotency-Key': REVOKE_KEY_HAPPY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(revokeBody),
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as { action: string; revoked_event_id: string | null };
        expect(body.action).toBe('revoked');
        expect(body.revoked_event_id).toBeDefined();
      });
  });

  it('records a revoke with no prior grant (revoked_event_id: null per Decision D)', async () => {
    await provider
      .addInteraction()
      .given('a valid recruiter token and no prior grant for talent+scope')
      .uponReceiving('a consent revoke request without a prior grant')
      .withRequest('POST', '/v1/consent/revoke', (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'Idempotency-Key': REVOKE_KEY_NOPRIOR,
          'Content-Type': 'application/json',
        }).jsonBody(revokeBody);
      })
      .willRespondWith(201, (b) => {
        b.jsonBody({
          event_id: uuid(),
          tenant_id: uuid(TENANT_ID),
          talent_id: uuid(TALENT_ID),
          scope: 'matching',
          action: 'revoked',
          captured_method: 'recruiter_capture',
          captured_by_actor_id: uuid(),
          consent_version: 'v1',
          occurred_at: regex(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
            '2026-04-29T01:00:00Z',
          ),
          recorded_at: regex(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
            '2026-04-29T01:00:01Z',
          ),
          revoked_event_id: null,
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/consent/revoke`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'Idempotency-Key': REVOKE_KEY_NOPRIOR,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(revokeBody),
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as { action: string; revoked_event_id: string | null };
        expect(body.action).toBe('revoked');
        expect(body.revoked_event_id).toBeNull();
      });
  });

  it('returns 400 VALIDATION_ERROR when Idempotency-Key is missing on revoke', async () => {
    await provider
      .addInteraction()
      .given('a valid recruiter token')
      .uponReceiving('a consent revoke request without Idempotency-Key')
      .withRequest('POST', '/v1/consent/revoke', (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'Content-Type': 'application/json',
        }).jsonBody(revokeBody);
      })
      .willRespondWith(400, (b) => {
        b.jsonBody({
          error: {
            code: 'VALIDATION_ERROR',
            message: like('Idempotency-Key header is required'),
            request_id: uuid(),
            details: like({ missing_field: 'Idempotency-Key' }),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/consent/revoke`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(revokeBody),
        });
        expect(res.status).toBe(400);
      });
  });

  it('returns 409 IDEMPOTENCY_KEY_CONFLICT when the same key is replayed with a different body', async () => {
    await provider
      .addInteraction()
      .given('a revoke idempotency key already used with a different body')
      .uponReceiving('a replay revoke request with mismatched body')
      .withRequest('POST', '/v1/consent/revoke', (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'Idempotency-Key': REVOKE_KEY_CONFLICT,
          'Content-Type': 'application/json',
        }).jsonBody({ ...revokeBody, scope: 'contacting' });
      })
      .willRespondWith(409, (b) => {
        b.jsonBody({
          error: {
            code: 'IDEMPOTENCY_KEY_CONFLICT',
            message: like('Same idempotency key used with a different request body'),
            request_id: uuid(),
            details: like({}),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/consent/revoke`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'Idempotency-Key': REVOKE_KEY_CONFLICT,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ...revokeBody, scope: 'contacting' }),
        });
        expect(res.status).toBe(409);
      });
  });
});

// ----------------------------------------------------------------------
// PR-4 — POST /v1/consent/check interactions. The endpoint is the
// resolver-path entry point and returns ConsentDecision per Phase 1 §1.
// Each interaction exercises a different result branch (allowed,
// denied with stale_consent, validation 400 for missing channel, 422
// dependency unmet with embedded ConsentDecision, 200 error for
// consent_state_unknown).
// ----------------------------------------------------------------------

const CHECK_DECISION_ID = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1a02';

describe('ATS thin consumer → POST /v1/consent/check', () => {
  it('returns 200 allowed for an operation backed by valid consent', async () => {
    await provider
      .addInteraction()
      .given('a talent with all required scopes granted for matching')
      .uponReceiving('a consent check for matching operation')
      .withRequest('POST', '/v1/consent/check', (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'Content-Type': 'application/json',
        }).jsonBody({
          talent_id: TALENT_ID,
          operation: 'matching',
        });
      })
      .willRespondWith(200, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          result: 'allowed',
          scope: 'matching',
          decision_id: uuid(CHECK_DECISION_ID),
          computed_at: regex(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
            '2026-04-30T12:00:00Z',
          ),
          log_message: like('matching_allowed'),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/consent/check`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            talent_id: TALENT_ID,
            operation: 'matching',
          }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { result: string; decision_id: string };
        expect(body.result).toBe('allowed');
        expect(body.decision_id).toBeTruthy();
      });
  });

  it('returns 200 denied with reason=stale_consent for an old contacting grant', async () => {
    await provider
      .addInteraction()
      .given('a talent with contacting consent older than 12 months')
      .uponReceiving('a consent check for engagement (contacting + email)')
      .withRequest('POST', '/v1/consent/check', (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'Content-Type': 'application/json',
        }).jsonBody({
          talent_id: TALENT_ID,
          operation: 'engagement',
          channel: 'email',
        });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          result: 'denied',
          scope: 'contacting',
          denied_scopes: ['contacting'],
          reason_code: 'stale_consent',
          display_message: 'Consent has expired. Refresh required.',
          log_message: like('contacting_denied: stale_consent'),
          decision_id: uuid(),
          computed_at: regex(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
            '2026-04-30T12:00:01Z',
          ),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/consent/check`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            talent_id: TALENT_ID,
            operation: 'engagement',
            channel: 'email',
          }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { result: string; reason_code: string };
        expect(body.result).toBe('denied');
        expect(body.reason_code).toBe('stale_consent');
      });
  });

  it('returns 400 VALIDATION_ERROR when channel is missing for a contacting operation', async () => {
    await provider
      .addInteraction()
      .given('a valid recruiter token')
      .uponReceiving('a consent check for engagement without channel')
      .withRequest('POST', '/v1/consent/check', (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'Content-Type': 'application/json',
        }).jsonBody({
          talent_id: TALENT_ID,
          operation: 'engagement',
        });
      })
      .willRespondWith(400, (b) => {
        b.jsonBody({
          error: {
            code: 'VALIDATION_ERROR',
            message: like('channel field is required when operation maps to contacting scope'),
            request_id: uuid(),
            details: {
              missing_field: 'channel',
              operation: 'engagement',
              derived_scope: 'contacting',
            },
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/consent/check`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            talent_id: TALENT_ID,
            operation: 'engagement',
          }),
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('VALIDATION_ERROR');
      });
  });

  it('returns 422 INVALID_SCOPE_COMBINATION with embedded ConsentDecision for unmet dependency', async () => {
    await provider
      .addInteraction()
      .given('a talent with profile_storage but no matching consent')
      .uponReceiving('a consent check for engagement (contacting + email)')
      .withRequest('POST', '/v1/consent/check', (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'Content-Type': 'application/json',
          'Idempotency-Key': 'd2d7a0f0-0000-7000-8000-000000000200',
        }).jsonBody({
          talent_id: TALENT_ID,
          operation: 'engagement',
          channel: 'email',
        });
      })
      .willRespondWith(422, (b) => {
        b.jsonBody({
          error: {
            code: 'INVALID_SCOPE_COMBINATION',
            message: like('Required consent scope dependency unmet'),
            request_id: uuid(),
            details: {
              consent_decision: {
                result: 'denied',
                scope: 'contacting',
                denied_scopes: ['matching'],
                reason_code: 'scope_dependency_unmet',
                display_message: like('Required consent scope(s) not granted: matching'),
                log_message: like('scope_dependency_unmet: matching'),
                decision_id: uuid(),
                computed_at: regex(
                  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
                  '2026-04-30T12:00:02Z',
                ),
              },
            },
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/consent/check`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'Content-Type': 'application/json',
            'Idempotency-Key': 'd2d7a0f0-0000-7000-8000-000000000200',
          },
          body: JSON.stringify({
            talent_id: TALENT_ID,
            operation: 'engagement',
            channel: 'email',
          }),
        });
        expect(res.status).toBe(422);
        const body = (await res.json()) as {
          error: { code: string; details: { consent_decision: { reason_code: string } } };
        };
        expect(body.error.code).toBe('INVALID_SCOPE_COMBINATION');
        expect(body.error.details.consent_decision.reason_code).toBe('scope_dependency_unmet');
      });
  });

  it('returns 200 error with reason=consent_state_unknown when the ledger is empty for the talent', async () => {
    await provider
      .addInteraction()
      .given('a talent with no consent events')
      .uponReceiving('a consent check for matching operation on an unseen talent')
      .withRequest('POST', '/v1/consent/check', (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'Content-Type': 'application/json',
        }).jsonBody({
          talent_id: TALENT_ID,
          operation: 'matching',
        });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          result: 'error',
          scope: 'matching',
          reason_code: 'consent_state_unknown',
          log_message: like('consent_state_missing for talent'),
          decision_id: uuid(),
          computed_at: regex(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
            '2026-04-30T12:00:03Z',
          ),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/consent/check`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            talent_id: TALENT_ID,
            operation: 'matching',
          }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { result: string; reason_code: string };
        expect(body.result).toBe('error');
        expect(body.reason_code).toBe('consent_state_unknown');
      });
  });
});

// ----------------------------------------------------------------------
// PR-5 — GET /v1/consent/state/{talent_id} interactions. Informational
// read endpoint; no Idempotency-Key (Phase 1 §6 N/A); always returns 5
// scopes; no decision-log written (Decision H).
// ----------------------------------------------------------------------

describe('ATS thin consumer → GET /v1/consent/state/{talent_id}', () => {
  it('returns 200 with all 5 scopes when the talent has full consent', async () => {
    await provider
      .addInteraction()
      .given('a talent with all 5 consent scopes granted')
      .uponReceiving('a state read for the talent')
      .withRequest('GET', `/v1/consent/state/${TALENT_ID}`, (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
        });
      })
      .willRespondWith(200, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          talent_id: uuid(TALENT_ID),
          tenant_id: uuid(TENANT_ID),
          is_anonymized: false,
          computed_at: regex(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
            '2026-05-01T12:00:00Z',
          ),
          scopes: [
            {
              scope: 'profile_storage',
              status: 'granted',
              granted_at: regex(
                /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
                '2026-04-01T10:00:00Z',
              ),
              revoked_at: null,
              expires_at: null,
            },
            {
              scope: 'resume_processing',
              status: 'granted',
              granted_at: regex(
                /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
                '2026-04-01T10:00:00Z',
              ),
              revoked_at: null,
              expires_at: null,
            },
            {
              scope: 'matching',
              status: 'granted',
              granted_at: regex(
                /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
                '2026-04-01T10:00:00Z',
              ),
              revoked_at: null,
              expires_at: null,
            },
            {
              scope: 'contacting',
              status: 'granted',
              granted_at: regex(
                /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
                '2026-04-01T10:00:00Z',
              ),
              revoked_at: null,
              expires_at: null,
            },
            {
              scope: 'cross_tenant_visibility',
              status: 'no_grant',
              granted_at: null,
              revoked_at: null,
              expires_at: null,
            },
          ],
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/consent/state/${TALENT_ID}`, {
          method: 'GET',
          headers: { Authorization: 'Bearer eyJfake.token' },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          talent_id: string;
          tenant_id: string;
          is_anonymized: boolean;
          scopes: Array<{ scope: string; status: string }>;
        };
        expect(body.scopes).toHaveLength(5);
        expect(body.is_anonymized).toBe(false);
      });
  });

  it('returns 200 with mixed states (granted + revoked + no_grant)', async () => {
    await provider
      .addInteraction()
      .given('a talent with profile granted and contacting revoked')
      .uponReceiving('a state read for the talent')
      .withRequest('GET', `/v1/consent/state/${TALENT_ID}`, (b) => {
        b.headers({ Authorization: like('Bearer eyJfake.token') });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          talent_id: uuid(TALENT_ID),
          tenant_id: uuid(TENANT_ID),
          is_anonymized: false,
          computed_at: regex(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
            '2026-05-01T12:00:00Z',
          ),
          scopes: [
            {
              scope: 'profile_storage',
              status: 'granted',
              granted_at: regex(
                /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
                '2026-04-01T10:00:00Z',
              ),
              revoked_at: null,
              expires_at: null,
            },
            {
              scope: 'resume_processing',
              status: 'no_grant',
              granted_at: null,
              revoked_at: null,
              expires_at: null,
            },
            {
              scope: 'matching',
              status: 'no_grant',
              granted_at: null,
              revoked_at: null,
              expires_at: null,
            },
            {
              scope: 'contacting',
              status: 'revoked',
              granted_at: regex(
                /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
                '2026-04-01T11:00:00Z',
              ),
              revoked_at: regex(
                /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
                '2026-04-15T14:22:00Z',
              ),
              expires_at: null,
            },
            {
              scope: 'cross_tenant_visibility',
              status: 'no_grant',
              granted_at: null,
              revoked_at: null,
              expires_at: null,
            },
          ],
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/consent/state/${TALENT_ID}`, {
          method: 'GET',
          headers: { Authorization: 'Bearer eyJfake.token' },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          scopes: Array<{ scope: string; status: string }>;
        };
        const contacting = body.scopes.find((s) => s.scope === 'contacting');
        expect(contacting?.status).toBe('revoked');
      });
  });

  it('returns 200 with all scopes no_grant for an unseen talent', async () => {
    await provider
      .addInteraction()
      .given('a talent with no consent events')
      .uponReceiving('a state read for the unseen talent')
      .withRequest('GET', `/v1/consent/state/${TALENT_ID}`, (b) => {
        b.headers({ Authorization: like('Bearer eyJfake.token') });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          talent_id: uuid(TALENT_ID),
          tenant_id: uuid(TENANT_ID),
          is_anonymized: false,
          computed_at: regex(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
            '2026-05-01T12:00:01Z',
          ),
          scopes: [
            { scope: 'profile_storage', status: 'no_grant', granted_at: null, revoked_at: null, expires_at: null },
            { scope: 'resume_processing', status: 'no_grant', granted_at: null, revoked_at: null, expires_at: null },
            { scope: 'matching', status: 'no_grant', granted_at: null, revoked_at: null, expires_at: null },
            { scope: 'contacting', status: 'no_grant', granted_at: null, revoked_at: null, expires_at: null },
            { scope: 'cross_tenant_visibility', status: 'no_grant', granted_at: null, revoked_at: null, expires_at: null },
          ],
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/consent/state/${TALENT_ID}`, {
          method: 'GET',
          headers: { Authorization: 'Bearer eyJfake.token' },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          scopes: Array<{ status: string }>;
        };
        expect(body.scopes).toHaveLength(5);
        for (const s of body.scopes) {
          expect(s.status).toBe('no_grant');
        }
      });
  });

  it('returns 400 VALIDATION_ERROR when talent_id is not a UUID', async () => {
    await provider
      .addInteraction()
      .given('a valid recruiter token')
      .uponReceiving('a state read with a malformed talent_id')
      .withRequest('GET', '/v1/consent/state/not-a-uuid', (b) => {
        b.headers({ Authorization: like('Bearer eyJfake.token') });
      })
      .willRespondWith(400, (b) => {
        b.jsonBody({
          error: {
            code: 'VALIDATION_ERROR',
            message: like('talent_id must be a UUID'),
            request_id: uuid(),
            details: { invalid_field: 'talent_id' },
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/consent/state/not-a-uuid`, {
          method: 'GET',
          headers: { Authorization: 'Bearer eyJfake.token' },
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('VALIDATION_ERROR');
      });
  });
});

// ----------------------------------------------------------------------
// PR-6 — GET /v1/consent/history/{talent_id} interactions. Informational
// read endpoint; no Idempotency-Key (Phase 1 §6 N/A); cursor-paginated;
// no decision-log written (Decision H).
// ----------------------------------------------------------------------

describe('ATS thin consumer → GET /v1/consent/history/{talent_id}', () => {
  it('§7 test 13: happy-path — wrapped shape with one event', async () => {
    await provider
      .addInteraction()
      .given('a talent with one consent grant event')
      .uponReceiving('a history read for the talent')
      .withRequest('GET', `/v1/consent/history/${TALENT_ID}`, (b) => {
        b.headers({ Authorization: like('Bearer eyJfake.token') });
      })
      .willRespondWith(200, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          events: [
            {
              event_id: uuid('00000000-0000-7000-8000-000000000a01'),
              scope: 'matching',
              action: 'granted',
              created_at: regex(
                /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
                '2026-04-15T12:00:00Z',
              ),
              expires_at: null,
            },
          ],
          next_cursor: null,
          is_anonymized: false,
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/consent/history/${TALENT_ID}`, {
          method: 'GET',
          headers: { Authorization: 'Bearer eyJfake.token' },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          events: Array<{ event_id: string; scope: string; action: string }>;
          next_cursor: string | null;
          is_anonymized: boolean;
        };
        expect(body.events).toHaveLength(1);
        expect(body.events[0]?.scope).toBe('matching');
        expect(body.events[0]?.action).toBe('granted');
        expect(body.next_cursor).toBeNull();
        expect(body.is_anonymized).toBe(false);
      });
  });

  it('§7 test 14: pagination — cursor-driven request returns next page', async () => {
    const cursorPayload = {
      c: '2026-04-15T12:00:00.000Z',
      e: '00000000-0000-7000-8000-000000000a01',
    };
    const cursorString = Buffer.from(JSON.stringify(cursorPayload), 'utf8').toString(
      'base64url',
    );

    await provider
      .addInteraction()
      .given('a talent with 5 consent events; cursor at end of first page')
      .uponReceiving('a history read with cursor + limit=2')
      .withRequest('GET', `/v1/consent/history/${TALENT_ID}`, (b) => {
        b.headers({ Authorization: like('Bearer eyJfake.token') }).query({
          limit: '2',
          cursor: cursorString,
        });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          events: [
            {
              event_id: uuid('00000000-0000-7000-8000-000000000a02'),
              scope: 'profile_storage',
              action: 'granted',
              created_at: regex(
                /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
                '2026-04-14T08:00:00Z',
              ),
              expires_at: null,
            },
            {
              event_id: uuid('00000000-0000-7000-8000-000000000a03'),
              scope: 'contacting',
              action: 'revoked',
              created_at: regex(
                /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
                '2026-04-13T15:30:00Z',
              ),
              expires_at: null,
            },
          ],
          next_cursor: like('encoded-opaque-cursor-string'),
          is_anonymized: false,
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/consent/history/${TALENT_ID}?limit=2&cursor=${encodeURIComponent(cursorString)}`,
          {
            method: 'GET',
            headers: { Authorization: 'Bearer eyJfake.token' },
          },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          events: unknown[];
          next_cursor: string | null;
        };
        expect(body.events).toHaveLength(2);
        expect(typeof body.next_cursor).toBe('string');
      });
  });

  it('§7 test 15: empty history — returns 200 with empty array, never 404', async () => {
    await provider
      .addInteraction()
      .given('a talent with no consent events')
      .uponReceiving('a history read for the unseen talent')
      .withRequest('GET', `/v1/consent/history/${TALENT_ID}`, (b) => {
        b.headers({ Authorization: like('Bearer eyJfake.token') });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          events: [],
          next_cursor: null,
          is_anonymized: false,
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/consent/history/${TALENT_ID}`, {
          method: 'GET',
          headers: { Authorization: 'Bearer eyJfake.token' },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          events: unknown[];
          next_cursor: string | null;
          is_anonymized: boolean;
        };
        expect(body.events).toEqual([]);
        expect(body.next_cursor).toBeNull();
        expect(body.is_anonymized).toBe(false);
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
