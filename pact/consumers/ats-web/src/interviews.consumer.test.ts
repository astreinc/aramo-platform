import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ACCESS_COOKIE,
  ISO_TIMESTAMP,
  eachLike,
  like,
  makeAtsWebProvider,
  regex,
  uuid,
} from './support/ats-web-pact.js';

// Calendar/Interview (Slices A–D) — the ats-web ↔ aramo-core contract for the interview
// routes the FE now consumes: the calendar read, the authoritative detail, schedule, the
// versioned transition, the provider-neutral meeting association, and the participant
// (panel) update. All are `@RequireCapability('ats')`; reads use `client-selection:read`,
// writes use `client-selection:interview:{schedule,transition}`. InterviewSession is the
// authority — these are its command/read surface, never a second authority.

const provider = makeAtsWebProvider();

const PROCESS_ID = '22222222-2222-7222-8222-222222222222';
const SESSION_ID = '33333333-3333-7333-8333-333333333333';
const MEETING_INTERACTION_ID = '44444444-4444-7444-8444-444444444444';
const IDEMPOTENCY_KEY = '55555555-5555-7555-8555-555555555555';

const INTERVIEW_STATE = /^(SCHEDULED|RESCHEDULED|COMPLETED|CANCELED|NO_SHOW)$/;

// The projected InterviewSession the schedule / detail / transition / meeting / panel
// operations return. Nullable fields use like(null); the FE handles both branches.
function sessionView() {
  return {
    id: uuid(),
    tenant_id: uuid(),
    client_selection_process_id: uuid(),
    requisition_id: uuid(),
    talent_record_id: uuid(),
    site_id: like(null),
    interview_type: like('onsite'),
    round: like(1),
    scheduled_at: regex(ISO_TIMESTAMP, '2026-10-06T15:00:00.000Z'),
    scheduled_end_at: like(null),
    timezone: like(null),
    interviewer_user_ids: like([]),
    meeting_interaction_id: like(null),
    state: regex(INTERVIEW_STATE, 'SCHEDULED'),
    version: like(0),
    created_at: regex(ISO_TIMESTAMP, '2026-10-01T00:00:00.000Z'),
    updated_at: regex(ISO_TIMESTAMP, '2026-10-01T00:00:00.000Z'),
  };
}

const AUTH = { Cookie: like(ACCESS_COOKIE) };

describe('ats-web → interview calendar + detail (reads)', () => {
  it('GET /v1/interviews returns the enriched, window-bounded calendar', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a scheduled interview exist')
      .uponReceiving('an interview calendar read')
      .withRequest('GET', '/v1/interviews', (b) => {
        b.query({ from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T00:00:00.000Z' }).headers(AUTH);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          interviews: eachLike({
            id: uuid(),
            scheduled_at: regex(ISO_TIMESTAMP, '2026-10-06T15:00:00.000Z'),
            scheduled_end_at: like(null),
            timezone: like(null),
            state: regex(INTERVIEW_STATE, 'SCHEDULED'),
            round: like(1),
            interview_type: like('onsite'),
            talent_record_id: uuid(),
            talent_name: like('Ada Lovelace'),
            requisition_id: uuid(),
            requisition_number: like(100),
            requisition_title: like('Backend Engineer'),
            company_id: uuid(),
            company_name: like(null),
            interviewer_user_ids: like([]),
            version: like(0),
          }),
          window: {
            from: regex(ISO_TIMESTAMP, '2026-10-01T00:00:00.000Z'),
            to: regex(ISO_TIMESTAMP, '2026-10-31T00:00:00.000Z'),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/interviews?from=2026-10-01T00:00:00.000Z&to=2026-10-31T00:00:00.000Z`,
          { headers: { Cookie: ACCESS_COOKIE } },
        );
        expect(res.status).toBe(200);
      });
  });

  it('GET /v1/client-selection/interview-sessions/:id returns the authoritative session', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a scheduled interview exist')
      .uponReceiving('an interview detail read')
      .withRequest('GET', `/v1/client-selection/interview-sessions/${SESSION_ID}`, (b) => {
        b.headers(AUTH);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(sessionView());
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/client-selection/interview-sessions/${SESSION_ID}`,
          { headers: { Cookie: ACCESS_COOKIE } },
        );
        expect(res.status).toBe(200);
      });
  });
});

describe('ats-web → interview writes', () => {
  it('POST /v1/client-selection/:id/interviews schedules an interview (idempotency-gated)', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a schedulable client-selection process exist')
      .uponReceiving('a schedule-interview command')
      .withRequest('POST', `/v1/client-selection/${PROCESS_ID}/interviews`, (b) => {
        b.headers({ ...AUTH, 'Idempotency-Key': like(IDEMPOTENCY_KEY), 'Content-Type': 'application/json' });
        b.jsonBody({
          interview_type: 'onsite',
          scheduled_at: '2026-10-06T15:00:00.000Z',
          scheduled_end_at: '2026-10-06T16:00:00.000Z',
          timezone: 'America/New_York',
          interviewer_user_ids: [],
        });
      })
      .willRespondWith(201, (b) => {
        // The created session echoes the supplied (non-null) end instant + zone.
        b.jsonBody({
          ...sessionView(),
          scheduled_end_at: regex(ISO_TIMESTAMP, '2026-10-06T16:00:00.000Z'),
          timezone: like('America/New_York'),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/client-selection/${PROCESS_ID}/interviews`, {
          method: 'POST',
          headers: {
            Cookie: ACCESS_COOKIE,
            'Idempotency-Key': IDEMPOTENCY_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            interview_type: 'onsite',
            scheduled_at: '2026-10-06T15:00:00.000Z',
            scheduled_end_at: '2026-10-06T16:00:00.000Z',
            timezone: 'America/New_York',
            interviewer_user_ids: [],
          }),
        });
        expect(res.status).toBe(201);
      });
  });

  it('POST …/interview-sessions/:id/transition drives a versioned transition', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a scheduled interview exist')
      .uponReceiving('an interview transition command')
      .withRequest('POST', `/v1/client-selection/interview-sessions/${SESSION_ID}/transition`, (b) => {
        b.headers({ ...AUTH, 'Content-Type': 'application/json' });
        b.jsonBody({ to_state: 'COMPLETED', expected_version: 0 });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(sessionView());
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/client-selection/interview-sessions/${SESSION_ID}/transition`,
          {
            method: 'POST',
            headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
            body: JSON.stringify({ to_state: 'COMPLETED', expected_version: 0 }),
          },
        );
        expect(res.status).toBe(200);
      });
  });

  it('POST …/interview-sessions/:id/meeting associates a provider-neutral meeting', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a scheduled interview exist')
      .uponReceiving('an interview meeting-association command')
      .withRequest('POST', `/v1/client-selection/interview-sessions/${SESSION_ID}/meeting`, (b) => {
        b.headers({ ...AUTH, 'Content-Type': 'application/json' });
        b.jsonBody({ expected_version: 0, meeting_interaction_id: MEETING_INTERACTION_ID });
      })
      .willRespondWith(200, (b) => {
        // The association response carries the now-linked (non-null) meeting ref.
        b.jsonBody({ ...sessionView(), meeting_interaction_id: uuid() });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/client-selection/interview-sessions/${SESSION_ID}/meeting`,
          {
            method: 'POST',
            headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
            body: JSON.stringify({ expected_version: 0, meeting_interaction_id: MEETING_INTERACTION_ID }),
          },
        );
        expect(res.status).toBe(200);
      });
  });

  it('PATCH …/interview-sessions/:id/interviewers replaces the panel (CAS)', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a scheduled interview exist')
      .uponReceiving('an interview participant-update command')
      .withRequest('PATCH', `/v1/client-selection/interview-sessions/${SESSION_ID}/interviewers`, (b) => {
        b.headers({ ...AUTH, 'Content-Type': 'application/json' });
        b.jsonBody({ expected_version: 0, interviewer_user_ids: [] });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(sessionView());
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/client-selection/interview-sessions/${SESSION_ID}/interviewers`,
          {
            method: 'PATCH',
            headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
            body: JSON.stringify({ expected_version: 0, interviewer_user_ids: [] }),
          },
        );
        expect(res.status).toBe(200);
      });
  });
});

// Keep the beforeAll/afterAll no-op hooks the shared harness style uses (the PactV4
// finalize happens inside executeTest); present for parity with sibling suites.
beforeAll(() => undefined);
afterAll(() => undefined);
