import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ACCESS_COOKIE,
  ISO_TIMESTAMP,
  TALENT_ID,
  TENANT_ID,
  errorBody,
  like,
  makeAtsWebProvider,
  regex,
  uuid,
} from './support/ats-web-pact.js';

// PC-2 — Pact consumer for ats-web, submittal domain.
//
// Consumer: ats-web · Provider: aramo-core (apps/api). Retrofitted onto the
// shared support module (PC-2 §2.1); this instance merges into the same
// ats-web-aramo-core.json as engagement (portal-thin precedent).
//
// Scope (PC-2 Directive §2.2 + Gate-5 ruling): all 9 submittal endpoints
// ats-web's apiClient wrapper (apps/ats-web/src/submittals/submittals-api.ts)
// calls — 9/9 contracted, 0 excluded. Four interaction classes:
//   - happy — request/response from the FE call sites + live controller DTOs;
//   - illegal-state — SUBMITTAL_STATE_INVALID 422 (fresh-read literal from
//     libs/submittal/src/lib/submittal.repository.ts; NOT the engagement
//     literal) on the 4 transitioning POSTs (confirm, mark-ready,
//     submit-to-ats, confirm-ats);
//   - idempotency — replay + conflict for every POST requiring an
//     Idempotency-Key (6 POSTs);
//   - refusal (Lead Gate-5 ruling, ship 7): EXAMINATION_PINNED_OUTDATED
//     (409, confirm), ATTESTATION_MISSING (422, confirm),
//     SUBMITTAL_ALREADY_CONFIRMED (409, confirm), REVOKE_NOT_ALLOWED (422,
//     revoke-from-confirmed), SUBMITTAL_STRETCH_BLOCKED (422, confirm),
//     JUSTIFICATION_REQUIRED (422, confirm), NOT_FOUND (404, GET :id once).
//
// GET /v1/jobs/:id/matches (FE findMatchesForRequisition) is examination
// domain — OUT of PC-2 scope (deferred to PC-3).

const provider = makeAtsWebProvider();

// ---- submittal-domain constants ---------------------------------------
const SUB_JOB_ID = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';
const SUB_EXAM_ID = '00000000-0000-7000-8000-5e0000000001';
// submittal fixtures, one id per seeded state (see verify-api.ts PC-2 seeds).
const SUB_CREATED_ID = '00000000-0000-7000-8000-5a0000000001';
const SUB_HANDOFF_ID = '00000000-0000-7000-8000-5a0000000002';
const SUB_READY_ID = '00000000-0000-7000-8000-5a0000000003';
const SUB_SUBMITTED_ID = '00000000-0000-7000-8000-5a0000000004';
const SUB_CONFIRMED_ID = '00000000-0000-7000-8000-5a0000000005';
const SUB_STRETCH_ID = '00000000-0000-7000-8000-5a0000000006';
const SUB_WORTH_ID = '00000000-0000-7000-8000-5a0000000007';
const SUB_OUTDATED_ID = '00000000-0000-7000-8000-5a0000000008';
const SUB_MISSING_ID = '00000000-0000-7000-8000-5a00000000ff';

// Idempotency keys (UUID-shaped).
const K_CREATE_REPLAY = '00000000-0000-7000-8000-5d0000000101';
const K_CREATE_CONFLICT = '00000000-0000-7000-8000-5d0000000102';
const K_MARKREADY_REPLAY = '00000000-0000-7000-8000-5d0000000201';
const K_MARKREADY_CONFLICT = '00000000-0000-7000-8000-5d0000000202';
const K_SUBMIT_REPLAY = '00000000-0000-7000-8000-5d0000000301';
const K_SUBMIT_CONFLICT = '00000000-0000-7000-8000-5d0000000302';
const K_CONFIRM_REPLAY = '00000000-0000-7000-8000-5d0000000401';
const K_CONFIRM_CONFLICT = '00000000-0000-7000-8000-5d0000000402';
const K_CONFIRMATS_REPLAY = '00000000-0000-7000-8000-5d0000000501';
const K_CONFIRMATS_CONFLICT = '00000000-0000-7000-8000-5d0000000502';
const K_REVOKE_REPLAY = '00000000-0000-7000-8000-5d0000000601';
const K_REVOKE_CONFLICT = '00000000-0000-7000-8000-5d0000000602';

// ---- request bodies (must byte-match provider idempotency seeds) -------
const CREATE_BODY = {
  talent_id: TALENT_ID,
  job_id: SUB_JOB_ID,
  examination_id: SUB_EXAM_ID,
  talent_identity: { full_name: 'Pact Talent', location: 'Remote (US)' },
  contact_summary: { contact_available: true, channels_verified: ['email'] },
  capability_summary_overrides: {
    key_work_history: [
      { employer_name: 'Acme', role_title: 'Senior Engineer', start_date: '2020-01' },
    ],
  },
  recruiter_contribution: {
    conversation_summary: { recruiter_summary: 'Spoke with the talent about the role.' },
    talent_confirmed: { spoken_to_recruiter: true },
  },
};
const EMPTY_BODY = {};
const ATTESTATIONS_OK = {
  attestations: {
    talent_evidence_reviewed: true,
    constraints_reviewed: true,
    submittal_risk_acknowledged: true,
  },
};
const REVOKE_BODY = { revocation_justification: 'Role closed before the submittal advanced.' };

// ---- submittal-domain response builders (stay in the domain file) ------
function submittalView(
  id: string,
  state: string,
  opts: { confirmedAt?: boolean; revoked?: boolean } = {},
) {
  return {
    id: uuid(id),
    tenant_id: uuid(TENANT_ID),
    talent_id: uuid(TALENT_ID),
    job_id: uuid(SUB_JOB_ID),
    evidence_package_id: uuid(),
    pinned_examination_id: uuid(),
    state,
    created_by: uuid(),
    justification: null,
    failed_criterion_acknowledgments: null,
    created_at: regex(ISO_TIMESTAMP, '2026-05-25T00:00:00Z'),
    confirmed_at: opts.confirmedAt
      ? regex(ISO_TIMESTAMP, '2026-05-25T00:00:00Z')
      : null,
    revoked_at: opts.revoked
      ? regex(ISO_TIMESTAMP, '2026-05-25T00:00:00Z')
      : null,
    revoked_by: opts.revoked ? uuid() : null,
    revocation_justification: opts.revoked ? like('Role closed before the submittal advanced.') : null,
  };
}

function evidencePackageView() {
  return {
    id: uuid(),
    tenant_id: uuid(TENANT_ID),
    talent_id: uuid(TALENT_ID),
    job_id: uuid(SUB_JOB_ID),
    examination_id: uuid(SUB_EXAM_ID),
    talent_identity: like({}),
    contact_summary: like({}),
    capability_summary: like({}),
    match_justification: like({}),
    recruiter_contribution: like({}),
    created_at: regex(ISO_TIMESTAMP, '2026-05-25T00:00:00Z'),
  };
}

function jsonHeaders(key: string) {
  return { Cookie: ACCESS_COOKIE, 'Idempotency-Key': key, 'Content-Type': 'application/json' };
}

// ======================================================================
// POST /v1/submittals — happy + idempotency (create does not transition;
// no illegal-state class)
// ======================================================================
describe('ats-web → POST /v1/submittals', () => {
  it('returns 201 with the created submittal', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and an entrustable examination ready for a new submittal exist')
      .uponReceiving('a create-submittal from an entrustable examination')
      .withRequest('POST', '/v1/submittals', (b) => {
        b.headers(jsonHeaders('00000000-0000-7000-8000-5f0000000001')).jsonBody(CREATE_BODY);
      })
      .willRespondWith(201, (b) => {
        b.jsonBody({ submittal: submittalView(SUB_CREATED_ID, 'created') });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/submittals`, {
          method: 'POST',
          headers: jsonHeaders('00000000-0000-7000-8000-5f0000000001'),
          body: JSON.stringify(CREATE_BODY),
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as { submittal: { state: string } };
        expect(body.submittal.state).toBe('created');
      });
  });

  it('create returns the cached response on Idempotency-Key replay', async () => {
    await provider
      .addInteraction()
      .given('a prior submittal-create response is cached under an Idempotency-Key')
      .uponReceiving('a create-submittal replay with the same Idempotency-Key and body')
      .withRequest('POST', '/v1/submittals', (b) => {
        b.headers(jsonHeaders(K_CREATE_REPLAY)).jsonBody(CREATE_BODY);
      })
      .willRespondWith(201, (b) => {
        b.jsonBody({ submittal: submittalView(SUB_CREATED_ID, 'created') });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/submittals`, {
          method: 'POST',
          headers: jsonHeaders(K_CREATE_REPLAY),
          body: JSON.stringify(CREATE_BODY),
        });
        expect(res.status).toBe(201);
      });
  });

  it('create returns 409 IDEMPOTENCY_KEY_CONFLICT on a key reused with a different body', async () => {
    await provider
      .addInteraction()
      .given('an Idempotency-Key was used with a different submittal-create body')
      .uponReceiving('a create-submittal with a conflicting Idempotency-Key')
      .withRequest('POST', '/v1/submittals', (b) => {
        b.headers(jsonHeaders(K_CREATE_CONFLICT)).jsonBody(CREATE_BODY);
      })
      .willRespondWith(409, (b) => {
        b.jsonBody(errorBody('IDEMPOTENCY_KEY_CONFLICT', 'Idempotency-Key conflict'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/submittals`, {
          method: 'POST',
          headers: jsonHeaders(K_CREATE_CONFLICT),
          body: JSON.stringify(CREATE_BODY),
        });
        expect(res.status).toBe(409);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
      });
  });
});

// ======================================================================
// GET /v1/submittals?talent_id=&job_id= — happy (discovery)
// ======================================================================
describe('ats-web → GET /v1/submittals', () => {
  it('returns 200 with the existing submittal for the (talent, job)', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a created submittal with a current entrustable examination and evidence package exist')
      .uponReceiving('a submittal discovery lookup for the talent and job')
      .withRequest('GET', '/v1/submittals', (b) => {
        b.query({ talent_id: TALENT_ID, job_id: SUB_JOB_ID }).headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ submittal: submittalView(SUB_CREATED_ID, 'created') });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/submittals?talent_id=${encodeURIComponent(TALENT_ID)}&job_id=${encodeURIComponent(SUB_JOB_ID)}`,
          { headers: { Cookie: ACCESS_COOKIE } },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { submittal: { state: string } | null };
        expect(body.submittal?.state).toBe('created');
      });
  });
});

// ======================================================================
// GET /v1/submittals/:id — happy + refusal (NOT_FOUND, representative)
// ======================================================================
describe('ats-web → GET /v1/submittals/:id', () => {
  it('returns 200 with the submittal view', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a created submittal with a current entrustable examination and evidence package exist')
      .uponReceiving('a submittal read by id')
      .withRequest('GET', `/v1/submittals/${SUB_CREATED_ID}`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(submittalView(SUB_CREATED_ID, 'created'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/submittals/${SUB_CREATED_ID}`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { state: string };
        expect(body.state).toBe('created');
      });
  });

  it('returns 404 NOT_FOUND when the submittal does not exist', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and no submittal for the id exist')
      .uponReceiving('a submittal read for a missing id')
      .withRequest('GET', `/v1/submittals/${SUB_MISSING_ID}`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(404, (b) => {
        b.jsonBody(errorBody('NOT_FOUND', 'TalentSubmittalRecord not found'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/submittals/${SUB_MISSING_ID}`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(404);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('NOT_FOUND');
      });
  });
});

// ======================================================================
// GET /v1/submittals/:id/evidence-package — happy
// ======================================================================
describe('ats-web → GET /v1/submittals/:id/evidence-package', () => {
  it('returns 200 with the evidence package view', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a created submittal with a current entrustable examination and evidence package exist')
      .uponReceiving('an evidence-package read for the submittal')
      .withRequest('GET', `/v1/submittals/${SUB_CREATED_ID}/evidence-package`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(evidencePackageView());
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/submittals/${SUB_CREATED_ID}/evidence-package`,
          { headers: { Cookie: ACCESS_COOKIE } },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { examination_id: string };
        expect(body.examination_id).toBeTruthy();
      });
  });
});

// ======================================================================
// POST /v1/submittals/:id/mark-ready — happy + illegal-state + idempotency
// ======================================================================
describe('ats-web → POST /v1/submittals/:id/mark-ready', () => {
  it('returns 200 advancing handoff_draft -> ready_for_review', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a handoff_draft submittal exist')
      .uponReceiving('a mark-ready on a handoff_draft submittal')
      .withRequest('POST', `/v1/submittals/${SUB_HANDOFF_ID}/mark-ready`, (b) => {
        b.headers(jsonHeaders('00000000-0000-7000-8000-5f0000000201')).jsonBody(EMPTY_BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ submittal: submittalView(SUB_HANDOFF_ID, 'ready_for_review') });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/submittals/${SUB_HANDOFF_ID}/mark-ready`, {
          method: 'POST',
          headers: jsonHeaders('00000000-0000-7000-8000-5f0000000201'),
          body: JSON.stringify(EMPTY_BODY),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { submittal: { state: string } };
        expect(body.submittal.state).toBe('ready_for_review');
      });
  });

  it('returns 422 SUBMITTAL_STATE_INVALID when not in handoff_draft', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a created submittal with a current entrustable examination and evidence package exist')
      .uponReceiving('a mark-ready on a created submittal')
      .withRequest('POST', `/v1/submittals/${SUB_CREATED_ID}/mark-ready`, (b) => {
        b.headers(jsonHeaders('00000000-0000-7000-8000-5f0000000202')).jsonBody(EMPTY_BODY);
      })
      .willRespondWith(422, (b) => {
        b.jsonBody(errorBody('SUBMITTAL_STATE_INVALID', 'Illegal submittal state transition'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/submittals/${SUB_CREATED_ID}/mark-ready`, {
          method: 'POST',
          headers: jsonHeaders('00000000-0000-7000-8000-5f0000000202'),
          body: JSON.stringify(EMPTY_BODY),
        });
        expect(res.status).toBe(422);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('SUBMITTAL_STATE_INVALID');
      });
  });

  it('mark-ready returns the cached response on Idempotency-Key replay', async () => {
    await provider
      .addInteraction()
      .given('a prior submittal-mark-ready response is cached under an Idempotency-Key')
      .uponReceiving('a mark-ready replay with the same Idempotency-Key and body')
      .withRequest('POST', `/v1/submittals/${SUB_HANDOFF_ID}/mark-ready`, (b) => {
        b.headers(jsonHeaders(K_MARKREADY_REPLAY)).jsonBody(EMPTY_BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ submittal: submittalView(SUB_HANDOFF_ID, 'ready_for_review') });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/submittals/${SUB_HANDOFF_ID}/mark-ready`, {
          method: 'POST',
          headers: jsonHeaders(K_MARKREADY_REPLAY),
          body: JSON.stringify(EMPTY_BODY),
        });
        expect(res.status).toBe(200);
      });
  });

  it('mark-ready returns 409 IDEMPOTENCY_KEY_CONFLICT on a key reused with a different body', async () => {
    await provider
      .addInteraction()
      .given('an Idempotency-Key was used with a different submittal-mark-ready body')
      .uponReceiving('a mark-ready with a conflicting Idempotency-Key')
      .withRequest('POST', `/v1/submittals/${SUB_HANDOFF_ID}/mark-ready`, (b) => {
        b.headers(jsonHeaders(K_MARKREADY_CONFLICT)).jsonBody(EMPTY_BODY);
      })
      .willRespondWith(409, (b) => {
        b.jsonBody(errorBody('IDEMPOTENCY_KEY_CONFLICT', 'Idempotency-Key conflict'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/submittals/${SUB_HANDOFF_ID}/mark-ready`, {
          method: 'POST',
          headers: jsonHeaders(K_MARKREADY_CONFLICT),
          body: JSON.stringify(EMPTY_BODY),
        });
        expect(res.status).toBe(409);
      });
  });
});

// ======================================================================
// POST /v1/submittals/:id/submit-to-ats — happy + illegal-state + idempotency
// ======================================================================
describe('ats-web → POST /v1/submittals/:id/submit-to-ats', () => {
  it('returns 200 advancing ready_for_review -> submitted_to_ats', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a ready_for_review submittal exist')
      .uponReceiving('a submit-to-ats on a ready_for_review submittal')
      .withRequest('POST', `/v1/submittals/${SUB_READY_ID}/submit-to-ats`, (b) => {
        b.headers(jsonHeaders('00000000-0000-7000-8000-5f0000000301')).jsonBody(EMPTY_BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ submittal: submittalView(SUB_READY_ID, 'submitted_to_ats', { confirmedAt: true }) });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/submittals/${SUB_READY_ID}/submit-to-ats`, {
          method: 'POST',
          headers: jsonHeaders('00000000-0000-7000-8000-5f0000000301'),
          body: JSON.stringify(EMPTY_BODY),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { submittal: { state: string } };
        expect(body.submittal.state).toBe('submitted_to_ats');
      });
  });

  it('returns 422 SUBMITTAL_STATE_INVALID when not in ready_for_review', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a created submittal with a current entrustable examination and evidence package exist')
      .uponReceiving('a submit-to-ats on a created submittal')
      .withRequest('POST', `/v1/submittals/${SUB_CREATED_ID}/submit-to-ats`, (b) => {
        b.headers(jsonHeaders('00000000-0000-7000-8000-5f0000000302')).jsonBody(EMPTY_BODY);
      })
      .willRespondWith(422, (b) => {
        b.jsonBody(errorBody('SUBMITTAL_STATE_INVALID', 'Illegal submittal state transition'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/submittals/${SUB_CREATED_ID}/submit-to-ats`, {
          method: 'POST',
          headers: jsonHeaders('00000000-0000-7000-8000-5f0000000302'),
          body: JSON.stringify(EMPTY_BODY),
        });
        expect(res.status).toBe(422);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('SUBMITTAL_STATE_INVALID');
      });
  });

  it('submit-to-ats returns the cached response on Idempotency-Key replay', async () => {
    await provider
      .addInteraction()
      .given('a prior submittal-submit-to-ats response is cached under an Idempotency-Key')
      .uponReceiving('a submit-to-ats replay with the same Idempotency-Key and body')
      .withRequest('POST', `/v1/submittals/${SUB_READY_ID}/submit-to-ats`, (b) => {
        b.headers(jsonHeaders(K_SUBMIT_REPLAY)).jsonBody(EMPTY_BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ submittal: submittalView(SUB_READY_ID, 'submitted_to_ats', { confirmedAt: true }) });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/submittals/${SUB_READY_ID}/submit-to-ats`, {
          method: 'POST',
          headers: jsonHeaders(K_SUBMIT_REPLAY),
          body: JSON.stringify(EMPTY_BODY),
        });
        expect(res.status).toBe(200);
      });
  });

  it('submit-to-ats returns 409 IDEMPOTENCY_KEY_CONFLICT on a key reused with a different body', async () => {
    await provider
      .addInteraction()
      .given('an Idempotency-Key was used with a different submittal-submit-to-ats body')
      .uponReceiving('a submit-to-ats with a conflicting Idempotency-Key')
      .withRequest('POST', `/v1/submittals/${SUB_READY_ID}/submit-to-ats`, (b) => {
        b.headers(jsonHeaders(K_SUBMIT_CONFLICT)).jsonBody(EMPTY_BODY);
      })
      .willRespondWith(409, (b) => {
        b.jsonBody(errorBody('IDEMPOTENCY_KEY_CONFLICT', 'Idempotency-Key conflict'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/submittals/${SUB_READY_ID}/submit-to-ats`, {
          method: 'POST',
          headers: jsonHeaders(K_SUBMIT_CONFLICT),
          body: JSON.stringify(EMPTY_BODY),
        });
        expect(res.status).toBe(409);
      });
  });
});

// ======================================================================
// POST /v1/submittals/:id/confirm — happy + illegal-state + idempotency +
// 5 refusals (ATTESTATION_MISSING, ALREADY_CONFIRMED, PINNED_OUTDATED,
// STRETCH_BLOCKED, JUSTIFICATION_REQUIRED)
// ======================================================================
describe('ats-web → POST /v1/submittals/:id/confirm', () => {
  it('returns 200 advancing created -> handoff_draft', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a created submittal with a current entrustable examination and evidence package exist')
      .uponReceiving('a confirm on a created submittal with all attestations')
      .withRequest('POST', `/v1/submittals/${SUB_CREATED_ID}/confirm`, (b) => {
        b.headers(jsonHeaders('00000000-0000-7000-8000-5f0000000401')).jsonBody(ATTESTATIONS_OK);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ submittal: submittalView(SUB_CREATED_ID, 'handoff_draft') });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/submittals/${SUB_CREATED_ID}/confirm`, {
          method: 'POST',
          headers: jsonHeaders('00000000-0000-7000-8000-5f0000000401'),
          body: JSON.stringify(ATTESTATIONS_OK),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { submittal: { state: string } };
        expect(body.submittal.state).toBe('handoff_draft');
      });
  });

  it('returns 422 SUBMITTAL_STATE_INVALID when not confirmable from state', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a ready_for_review submittal exist')
      .uponReceiving('a confirm on a ready_for_review submittal')
      .withRequest('POST', `/v1/submittals/${SUB_READY_ID}/confirm`, (b) => {
        b.headers(jsonHeaders('00000000-0000-7000-8000-5f0000000402')).jsonBody(ATTESTATIONS_OK);
      })
      .willRespondWith(422, (b) => {
        b.jsonBody(errorBody('SUBMITTAL_STATE_INVALID', 'Illegal submittal state transition'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/submittals/${SUB_READY_ID}/confirm`, {
          method: 'POST',
          headers: jsonHeaders('00000000-0000-7000-8000-5f0000000402'),
          body: JSON.stringify(ATTESTATIONS_OK),
        });
        expect(res.status).toBe(422);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('SUBMITTAL_STATE_INVALID');
      });
  });

  it('returns 422 ATTESTATION_MISSING when an attestation is not true', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a created submittal with a current entrustable examination and evidence package exist')
      .uponReceiving('a confirm with an incomplete attestation set')
      .withRequest('POST', `/v1/submittals/${SUB_CREATED_ID}/confirm`, (b) => {
        b.headers(jsonHeaders('00000000-0000-7000-8000-5f0000000403')).jsonBody({
          attestations: {
            talent_evidence_reviewed: true,
            constraints_reviewed: true,
            submittal_risk_acknowledged: false,
          },
        });
      })
      .willRespondWith(422, (b) => {
        b.jsonBody(errorBody('ATTESTATION_MISSING', 'All three attestations must be true'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/submittals/${SUB_CREATED_ID}/confirm`, {
          method: 'POST',
          headers: jsonHeaders('00000000-0000-7000-8000-5f0000000403'),
          body: JSON.stringify({
            attestations: {
              talent_evidence_reviewed: true,
              constraints_reviewed: true,
              submittal_risk_acknowledged: false,
            },
          }),
        });
        expect(res.status).toBe(422);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('ATTESTATION_MISSING');
      });
  });

  it('returns 409 SUBMITTAL_ALREADY_CONFIRMED when already in handoff_draft', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a handoff_draft submittal exist')
      .uponReceiving('a confirm on an already-confirmed (handoff_draft) submittal')
      .withRequest('POST', `/v1/submittals/${SUB_HANDOFF_ID}/confirm`, (b) => {
        b.headers(jsonHeaders('00000000-0000-7000-8000-5f0000000404')).jsonBody(ATTESTATIONS_OK);
      })
      .willRespondWith(409, (b) => {
        b.jsonBody(errorBody('SUBMITTAL_ALREADY_CONFIRMED', 'Submittal is already in handoff_draft state'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/submittals/${SUB_HANDOFF_ID}/confirm`, {
          method: 'POST',
          headers: jsonHeaders('00000000-0000-7000-8000-5f0000000404'),
          body: JSON.stringify(ATTESTATIONS_OK),
        });
        expect(res.status).toBe(409);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('SUBMITTAL_ALREADY_CONFIRMED');
      });
  });

  it('returns 409 EXAMINATION_PINNED_OUTDATED when a newer examination exists', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a created submittal whose pinned examination has been superseded by a newer one exist')
      .uponReceiving('a confirm on a submittal with an outdated pinned examination')
      .withRequest('POST', `/v1/submittals/${SUB_OUTDATED_ID}/confirm`, (b) => {
        b.headers(jsonHeaders('00000000-0000-7000-8000-5f0000000405')).jsonBody(ATTESTATIONS_OK);
      })
      .willRespondWith(409, (b) => {
        b.jsonBody(errorBody('EXAMINATION_PINNED_OUTDATED', 'Newer examination exists; recruiter must refresh draft'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/submittals/${SUB_OUTDATED_ID}/confirm`, {
          method: 'POST',
          headers: jsonHeaders('00000000-0000-7000-8000-5f0000000405'),
          body: JSON.stringify(ATTESTATIONS_OK),
        });
        expect(res.status).toBe(409);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('EXAMINATION_PINNED_OUTDATED');
      });
  });

  it('returns 422 SUBMITTAL_STRETCH_BLOCKED for a stretch-tier examination', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a created submittal pinned to a stretch-tier examination exist')
      .uponReceiving('a confirm on a stretch-tier submittal')
      .withRequest('POST', `/v1/submittals/${SUB_STRETCH_ID}/confirm`, (b) => {
        b.headers(jsonHeaders('00000000-0000-7000-8000-5f0000000406')).jsonBody(ATTESTATIONS_OK);
      })
      .willRespondWith(422, (b) => {
        b.jsonBody(errorBody('SUBMITTAL_STRETCH_BLOCKED', 'Stretch-tier examinations cannot be confirmed'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/submittals/${SUB_STRETCH_ID}/confirm`, {
          method: 'POST',
          headers: jsonHeaders('00000000-0000-7000-8000-5f0000000406'),
          body: JSON.stringify(ATTESTATIONS_OK),
        });
        expect(res.status).toBe(422);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('SUBMITTAL_STRETCH_BLOCKED');
      });
  });

  it('returns 422 JUSTIFICATION_REQUIRED for a worth-considering examination without justification', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a created worth-considering submittal without justification exist')
      .uponReceiving('a confirm on a worth-considering submittal lacking justification')
      .withRequest('POST', `/v1/submittals/${SUB_WORTH_ID}/confirm`, (b) => {
        b.headers(jsonHeaders('00000000-0000-7000-8000-5f0000000407')).jsonBody(ATTESTATIONS_OK);
      })
      .willRespondWith(422, (b) => {
        b.jsonBody(errorBody('JUSTIFICATION_REQUIRED', 'Worth Considering submittals require non-empty justification'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/submittals/${SUB_WORTH_ID}/confirm`, {
          method: 'POST',
          headers: jsonHeaders('00000000-0000-7000-8000-5f0000000407'),
          body: JSON.stringify(ATTESTATIONS_OK),
        });
        expect(res.status).toBe(422);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('JUSTIFICATION_REQUIRED');
      });
  });

  it('confirm returns the cached response on Idempotency-Key replay', async () => {
    await provider
      .addInteraction()
      .given('a prior submittal-confirm response is cached under an Idempotency-Key')
      .uponReceiving('a confirm replay with the same Idempotency-Key and body')
      .withRequest('POST', `/v1/submittals/${SUB_CREATED_ID}/confirm`, (b) => {
        b.headers(jsonHeaders(K_CONFIRM_REPLAY)).jsonBody(ATTESTATIONS_OK);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ submittal: submittalView(SUB_CREATED_ID, 'handoff_draft') });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/submittals/${SUB_CREATED_ID}/confirm`, {
          method: 'POST',
          headers: jsonHeaders(K_CONFIRM_REPLAY),
          body: JSON.stringify(ATTESTATIONS_OK),
        });
        expect(res.status).toBe(200);
      });
  });

  it('confirm returns 409 IDEMPOTENCY_KEY_CONFLICT on a key reused with a different body', async () => {
    await provider
      .addInteraction()
      .given('an Idempotency-Key was used with a different submittal-confirm body')
      .uponReceiving('a confirm with a conflicting Idempotency-Key')
      .withRequest('POST', `/v1/submittals/${SUB_CREATED_ID}/confirm`, (b) => {
        b.headers(jsonHeaders(K_CONFIRM_CONFLICT)).jsonBody(ATTESTATIONS_OK);
      })
      .willRespondWith(409, (b) => {
        b.jsonBody(errorBody('IDEMPOTENCY_KEY_CONFLICT', 'Idempotency-Key conflict'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/submittals/${SUB_CREATED_ID}/confirm`, {
          method: 'POST',
          headers: jsonHeaders(K_CONFIRM_CONFLICT),
          body: JSON.stringify(ATTESTATIONS_OK),
        });
        expect(res.status).toBe(409);
      });
  });
});

// ======================================================================
// POST /v1/submittals/:id/confirm-ats — happy + illegal-state + idempotency
// ======================================================================
describe('ats-web → POST /v1/submittals/:id/confirm-ats', () => {
  it('returns 200 advancing submitted_to_ats -> confirmed', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a submitted_to_ats submittal exist')
      .uponReceiving('a confirm-ats on a submitted_to_ats submittal')
      .withRequest('POST', `/v1/submittals/${SUB_SUBMITTED_ID}/confirm-ats`, (b) => {
        b.headers(jsonHeaders('00000000-0000-7000-8000-5f0000000501')).jsonBody(EMPTY_BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ submittal: submittalView(SUB_SUBMITTED_ID, 'confirmed', { confirmedAt: true }) });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/submittals/${SUB_SUBMITTED_ID}/confirm-ats`, {
          method: 'POST',
          headers: jsonHeaders('00000000-0000-7000-8000-5f0000000501'),
          body: JSON.stringify(EMPTY_BODY),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { submittal: { state: string } };
        expect(body.submittal.state).toBe('confirmed');
      });
  });

  it('returns 422 SUBMITTAL_STATE_INVALID when not in submitted_to_ats', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a created submittal with a current entrustable examination and evidence package exist')
      .uponReceiving('a confirm-ats on a created submittal')
      .withRequest('POST', `/v1/submittals/${SUB_CREATED_ID}/confirm-ats`, (b) => {
        b.headers(jsonHeaders('00000000-0000-7000-8000-5f0000000502')).jsonBody(EMPTY_BODY);
      })
      .willRespondWith(422, (b) => {
        b.jsonBody(errorBody('SUBMITTAL_STATE_INVALID', 'Illegal submittal state transition'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/submittals/${SUB_CREATED_ID}/confirm-ats`, {
          method: 'POST',
          headers: jsonHeaders('00000000-0000-7000-8000-5f0000000502'),
          body: JSON.stringify(EMPTY_BODY),
        });
        expect(res.status).toBe(422);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('SUBMITTAL_STATE_INVALID');
      });
  });

  it('confirm-ats returns the cached response on Idempotency-Key replay', async () => {
    await provider
      .addInteraction()
      .given('a prior submittal-confirm-ats response is cached under an Idempotency-Key')
      .uponReceiving('a confirm-ats replay with the same Idempotency-Key and body')
      .withRequest('POST', `/v1/submittals/${SUB_SUBMITTED_ID}/confirm-ats`, (b) => {
        b.headers(jsonHeaders(K_CONFIRMATS_REPLAY)).jsonBody(EMPTY_BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ submittal: submittalView(SUB_SUBMITTED_ID, 'confirmed', { confirmedAt: true }) });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/submittals/${SUB_SUBMITTED_ID}/confirm-ats`, {
          method: 'POST',
          headers: jsonHeaders(K_CONFIRMATS_REPLAY),
          body: JSON.stringify(EMPTY_BODY),
        });
        expect(res.status).toBe(200);
      });
  });

  it('confirm-ats returns 409 IDEMPOTENCY_KEY_CONFLICT on a key reused with a different body', async () => {
    await provider
      .addInteraction()
      .given('an Idempotency-Key was used with a different submittal-confirm-ats body')
      .uponReceiving('a confirm-ats with a conflicting Idempotency-Key')
      .withRequest('POST', `/v1/submittals/${SUB_SUBMITTED_ID}/confirm-ats`, (b) => {
        b.headers(jsonHeaders(K_CONFIRMATS_CONFLICT)).jsonBody(EMPTY_BODY);
      })
      .willRespondWith(409, (b) => {
        b.jsonBody(errorBody('IDEMPOTENCY_KEY_CONFLICT', 'Idempotency-Key conflict'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/submittals/${SUB_SUBMITTED_ID}/confirm-ats`, {
          method: 'POST',
          headers: jsonHeaders(K_CONFIRMATS_CONFLICT),
          body: JSON.stringify(EMPTY_BODY),
        });
        expect(res.status).toBe(409);
      });
  });
});

// ======================================================================
// POST /v1/submittals/:id/revoke — happy + idempotency + refusal
// (REVOKE_NOT_ALLOWED from a terminal state). Revoke's terminal refusal is
// REVOKE_NOT_ALLOWED, not SUBMITTAL_STATE_INVALID → no illegal-state class.
// ======================================================================
describe('ats-web → POST /v1/submittals/:id/revoke', () => {
  it('returns 200 revoking a non-terminal submittal', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a created submittal with a current entrustable examination and evidence package exist')
      .uponReceiving('a revoke on a created submittal')
      .withRequest('POST', `/v1/submittals/${SUB_CREATED_ID}/revoke`, (b) => {
        b.headers(jsonHeaders('00000000-0000-7000-8000-5f0000000601')).jsonBody(REVOKE_BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          submittal: submittalView(SUB_CREATED_ID, 'revoked', { revoked: true }),
          evidence_package_mutated: false,
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/submittals/${SUB_CREATED_ID}/revoke`, {
          method: 'POST',
          headers: jsonHeaders('00000000-0000-7000-8000-5f0000000601'),
          body: JSON.stringify(REVOKE_BODY),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          submittal: { state: string };
          evidence_package_mutated: boolean;
        };
        expect(body.submittal.state).toBe('revoked');
        expect(body.evidence_package_mutated).toBe(false);
      });
  });

  it('returns 422 REVOKE_NOT_ALLOWED for a confirmed (terminal) submittal', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a confirmed submittal exist')
      .uponReceiving('a revoke on a confirmed submittal')
      .withRequest('POST', `/v1/submittals/${SUB_CONFIRMED_ID}/revoke`, (b) => {
        b.headers(jsonHeaders('00000000-0000-7000-8000-5f0000000602')).jsonBody(REVOKE_BODY);
      })
      .willRespondWith(422, (b) => {
        b.jsonBody(errorBody('REVOKE_NOT_ALLOWED', 'cannot be revoked'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/submittals/${SUB_CONFIRMED_ID}/revoke`, {
          method: 'POST',
          headers: jsonHeaders('00000000-0000-7000-8000-5f0000000602'),
          body: JSON.stringify(REVOKE_BODY),
        });
        expect(res.status).toBe(422);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('REVOKE_NOT_ALLOWED');
      });
  });

  it('revoke returns the cached response on Idempotency-Key replay', async () => {
    await provider
      .addInteraction()
      .given('a prior submittal-revoke response is cached under an Idempotency-Key')
      .uponReceiving('a revoke replay with the same Idempotency-Key and body')
      .withRequest('POST', `/v1/submittals/${SUB_CREATED_ID}/revoke`, (b) => {
        b.headers(jsonHeaders(K_REVOKE_REPLAY)).jsonBody(REVOKE_BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          submittal: submittalView(SUB_CREATED_ID, 'revoked', { revoked: true }),
          evidence_package_mutated: false,
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/submittals/${SUB_CREATED_ID}/revoke`, {
          method: 'POST',
          headers: jsonHeaders(K_REVOKE_REPLAY),
          body: JSON.stringify(REVOKE_BODY),
        });
        expect(res.status).toBe(200);
      });
  });

  it('revoke returns 409 IDEMPOTENCY_KEY_CONFLICT on a key reused with a different body', async () => {
    await provider
      .addInteraction()
      .given('an Idempotency-Key was used with a different submittal-revoke body')
      .uponReceiving('a revoke with a conflicting Idempotency-Key')
      .withRequest('POST', `/v1/submittals/${SUB_CREATED_ID}/revoke`, (b) => {
        b.headers(jsonHeaders(K_REVOKE_CONFLICT)).jsonBody(REVOKE_BODY);
      })
      .willRespondWith(409, (b) => {
        b.jsonBody(errorBody('IDEMPOTENCY_KEY_CONFLICT', 'Idempotency-Key conflict'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/submittals/${SUB_CREATED_ID}/revoke`, {
          method: 'POST',
          headers: jsonHeaders(K_REVOKE_CONFLICT),
          body: JSON.stringify(REVOKE_BODY),
        });
        expect(res.status).toBe(409);
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
