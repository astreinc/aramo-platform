import { describe, it } from 'vitest';

import {
  ACCESS_COOKIE,
  ISO_TIMESTAMP,
  TALENT_ID,
  eachLike,
  like,
  makeAtsWebProvider,
  regex,
  uuid,
} from './support/ats-web-pact.js';

// Pact consumer for ats-web → the TIP-E2E INC-3 Technical Screening routes
// (ARAMO-TIP-E2E-INC-3-v1.0-LOCKED §9, as amended by ARAMO-TIP-E2E-INC-3-A1-v1.0-LOCKED).
// Pins the session / finding / publication response contract the
// TechnicalScreeningView renders: list a Talent's sessions, open a DRAFT session,
// read one session with its findings, provenance and A1 collections, add an
// interview note, and the honest capture-mode statuses (no Microsoft connection
// in the provider state → Teams not_connected; live capture never offered).
// The lifecycle refusals (409/422), tenant/site concealment and the confirm →
// publish path are proven over HTTP in the api integration suite. Merges into
// ats-web-aramo-core.json. Provider state: pact/provider/src/verify-api.ts.

const SESSION_ID = '0192f3c0-0000-7000-8000-00000000c501';
const FINDING_ID = '0192f3c0-0000-7000-8000-00000000c502';
const STATE = 'an ats-web recruiter and a Talent with a draft technical screening exist';

const sessionBody = (state: 'DRAFT') => ({
  id: uuid(SESSION_ID),
  talent_record_id: uuid(TALENT_ID),
  interaction_id: null,
  requisition_id: null,
  state,
  version: like(1),
  created_at: regex(ISO_TIMESTAMP, '2026-10-15T10:00:00.000Z'),
  updated_at: regex(ISO_TIMESTAMP, '2026-10-15T10:00:00.000Z'),
  created_by_actor_id: like('00000000-0000-0000-0000-0000000000bb'),
  confirmed_by_actor_id: null,
  confirmed_at: null,
  confirmed_version: null,
  voided_by_actor_id: null,
  voided_at: null,
  void_reason: null,
});

const provider = makeAtsWebProvider();

describe('ats-web → technical screening (TIP-E2E INC-3)', () => {
  it('lists a Talent’s screening sessions', async () => {
    await provider
      .addInteraction()
      .given(STATE)
      .uponReceiving('a list of a Talent’s technical screening sessions')
      .withRequest('GET', `/v1/talent-records/${TALENT_ID}/screening-sessions`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ items: eachLike(sessionBody('DRAFT')) });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/talent-records/${TALENT_ID}/screening-sessions`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        if (res.status !== 200) throw new Error(`unexpected ${res.status}`);
      });
  });

  it('opens a DRAFT technical screening session', async () => {
    await provider
      .addInteraction()
      .given(STATE)
      .uponReceiving('a request to open a technical screening session')
      .withRequest('POST', `/v1/talent-records/${TALENT_ID}/screening-sessions`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' });
        b.jsonBody({});
      })
      .willRespondWith(201, (b) => {
        b.jsonBody({ ...sessionBody('DRAFT'), id: uuid(SESSION_ID), version: like(1) });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/talent-records/${TALENT_ID}/screening-sessions`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        if (res.status !== 201) throw new Error(`unexpected ${res.status}`);
      });
  });

  it('reads one screening session with its findings and publication state', async () => {
    await provider
      .addInteraction()
      .given(STATE)
      .uponReceiving('a technical screening session detail read')
      .withRequest('GET', `/v1/screening-sessions/${SESSION_ID}`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          session: sessionBody('DRAFT'),
          findings: eachLike({
            id: uuid(FINDING_ID),
            skill_raw: like('Kubernetes'),
            basis: regex('^(SELF_REPORTED|RECRUITER_OBSERVED|DEMONSTRATED)$', 'RECRUITER_OBSERVED'),
            observation_raw: like('Explained pod disruption budgets.'),
            demonstration_raw: null,
            limitations_raw: null,
            // INC-3 A1 §B.2 — provenance axes (a recruiter-authored finding).
            origin: 'RECRUITER_AUTHORED',
            review_status: null,
            evidence_source: 'RECRUITER_OBSERVATION',
            ai_original: null,
            reviewed_by_actor_id: null,
            reviewed_at: null,
            created_at: regex(ISO_TIMESTAMP, '2026-10-15T10:00:00.000Z'),
            updated_at: regex(ISO_TIMESTAMP, '2026-10-15T10:00:00.000Z'),
          }),
          // A DRAFT has no publication intents (they are pinned at confirmation).
          publications: [],
          // INC-3 A1 — nothing generated, noted, linked or analysed yet.
          citations: [],
          questions: [],
          notes: [],
          suggestions: [],
          generations: [],
          transcripts: [],
          analyses: [],
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/screening-sessions/${SESSION_ID}`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        if (res.status !== 200) throw new Error(`unexpected ${res.status}`);
      });
  });

  it('adds an interview note to a DRAFT session (INC-3 A1)', async () => {
    await provider
      .addInteraction()
      .given(STATE)
      .uponReceiving('a request to add a technical screening interview note')
      .withRequest('POST', `/v1/screening-sessions/${SESSION_ID}/notes`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' });
        b.jsonBody({ body: 'Vague on persistent storage.' });
      })
      .willRespondWith(201, (b) => {
        b.jsonBody({
          session: like(sessionBody('DRAFT')),
          notes: eachLike({
            id: like('0192f3c0-0000-7000-8000-00000000c503'),
            body: like('Vague on persistent storage.'),
            created_at: regex(ISO_TIMESTAMP, '2026-10-15T10:00:00.000Z'),
          }),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/screening-sessions/${SESSION_ID}/notes`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify({ body: 'Vague on persistent storage.' }),
        });
        if (res.status !== 201) throw new Error(`unexpected ${res.status}`);
      });
  });

  it('reads the honest capture-mode statuses (INC-3 A1, R-C)', async () => {
    await provider
      .addInteraction()
      .given(STATE)
      .uponReceiving('a technical screening capture-modes read')
      .withRequest('GET', `/v1/screening-sessions/${SESSION_ID}/capture-modes`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          recruiter_notes: { status: 'available' },
          teams_post_meeting: { status: regex('^(available|not_granted|not_connected|reauth_required)$', 'not_connected') },
          live_external_provider: { status: 'no_approved_provider' },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/screening-sessions/${SESSION_ID}/capture-modes`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        if (res.status !== 200) throw new Error(`unexpected ${res.status}`);
      });
  });
});
