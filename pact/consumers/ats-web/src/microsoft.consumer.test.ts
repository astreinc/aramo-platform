import { describe, expect, it } from 'vitest';

import {
  ACCESS_COOKIE,
  like,
  makeAtsWebProvider,
  uuid,
} from './support/ats-web-pact.js';

// Recruiting-Journey §5/§27 (recon-noted email→CONTACT gap) — the FE recruiter email
// send surface had NO consumer contract. This pins the ONE send interaction ats-web
// issues: POST /v1/integrations/microsoft/email. The send is ids-only (COMM-C4 — the
// recipient is resolved SERVER-side from the Talent record; the client never supplies
// an address) and, when a pipeline is bound and the caller holds pipeline:change-status,
// a durable accepted send converges the bound episode no_contact→contacted through the
// EVIDENCE-BEARING command recordContactEvidence (never a naked stage write). The send
// RESPONSE is the EmailSendResultView; the no_contact→contacted convergence is a durable
// side effect proven by the apps/api integration suite (the provider exercises the legal
// provider-backed path through a Graph test-double + a faked delegated token, so the
// real send/evidence/convergence code runs end-to-end without touching the network).

const provider = makeAtsWebProvider();

const TALENT_ID = '00000000-0000-7000-8000-7a1e00000001';
const REQ_ID = '00000000-0000-7000-8000-4e9100000001';
const PIPE_ID = '00000000-0000-7000-8000-71be00000001';

describe('ats-web → POST /v1/integrations/microsoft/email (Recruiting-Journey §5 email→CONTACT)', () => {
  it('returns 200 accepting the send (recipient server-owned; convergence is a side effect)', async () => {
    const IDEMPOTENCY_KEY = 'ms-email-pact-idem-0001';
    // ids ONLY — no recipient/to_email is ever supplied by the client (COMM-C4).
    const BODY = {
      talent_record_id: TALENT_ID,
      requisition_id: REQ_ID,
      pipeline_id: PIPE_ID,
      subject: 'Opportunity — Senior Engineer',
      body: 'Hi Dana, I would love to connect about a role.',
      idempotency_key: IDEMPOTENCY_KEY,
    };
    await provider
      .addInteraction()
      .given(
        'an ats-web recruiter with a configured microsoft connection and a no_contact pipeline exist',
      )
      .uponReceiving('an ats-web recruiter email send that converges the episode to contacted')
      .withRequest('POST', '/v1/integrations/microsoft/email', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(
          BODY,
        );
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          interaction_id: uuid('eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee'),
          status: like('accepted'),
          talent_record_id: uuid(TALENT_ID),
          requisition_id: uuid(REQ_ID),
          idempotent_replay: like(false),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/integrations/microsoft/email`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(200);
        const parsed = (await res.json()) as { status: string };
        expect(parsed.status).toBe('accepted');
      });
  });
});

// COMM-C2B Amendment A1 (M365-SCHED-1) — the FE Outlook scheduling surface. Pins the
// five calendar-meeting interactions ats-web issues. The provider replays each against
// the real app with a faked Graph calendar port + consent gate + a seeded live pipeline
// (create) or a seeded scheduled meeting (read/reschedule/cancel/list), so the real
// durable-op/CAS/organizer-bound/audit code runs without touching Microsoft.
const MEETING_ID = '00000000-0000-7000-8000-ee7100000001';

describe('ats-web → Microsoft Outlook calendar scheduling (COMM-C2B Amendment A1)', () => {
  it('POST /calendar-meeting schedules a meeting (durable op + Teams + invitation)', async () => {
    const BODY = {
      talent_record_id: TALENT_ID,
      requisition_id: REQ_ID,
      pipeline_id: PIPE_ID,
      subject: 'Recruiter screen — Senior Engineer',
      start_date_time: '2026-11-03T15:00:00',
      end_date_time: '2026-11-03T15:30:00',
      time_zone: 'America/New_York',
      idempotency_key: 'ms-sched-pact-idem-0001',
    };
    await provider
      .addInteraction()
      .given('an ats-web recruiter with a configured microsoft connection, consent, and a live pipeline episode exist')
      .uponReceiving('an ats-web recruiter scheduling an Outlook calendar meeting')
      .withRequest('POST', '/v1/integrations/microsoft/calendar-meeting', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          interaction_id: uuid('cccccccc-cccc-7ccc-8ccc-cccccccccccc'),
          provider_event_id: like('evt-pact-0001'),
          join_url: like('https://teams.microsoft.example/l/meetup-join/pact'),
          status: 'scheduled',
          version: like(0),
          idempotent_replay: like(false),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/integrations/microsoft/calendar-meeting`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(200);
        expect(((await res.json()) as { status: string }).status).toBe('scheduled');
      });
  });

  it('GET /calendar-meeting/{id} reads a scheduling meeting', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter with an existing scheduled Outlook meeting exist')
      .uponReceiving('an ats-web recruiter reading a scheduling meeting by id')
      .withRequest('GET', `/v1/integrations/microsoft/calendar-meeting/${MEETING_ID}`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ interaction_id: uuid(MEETING_ID), status: like('scheduled'), version: like(0), idempotent_replay: like(false) });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/integrations/microsoft/calendar-meeting/${MEETING_ID}`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
      });
  });

  it('GET /calendar-meetings lists upcoming meetings by Talent context', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter with an existing scheduled Outlook meeting exist')
      .uponReceiving('an ats-web recruiter listing upcoming scheduling meetings')
      .withRequest('GET', '/v1/integrations/microsoft/calendar-meetings', (b) => {
        b.query({ talent_record_id: TALENT_ID }).headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ meetings: like([{ interaction_id: uuid(MEETING_ID), status: like('scheduled'), version: like(0), idempotent_replay: like(false) }]) });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/integrations/microsoft/calendar-meetings?talent_record_id=${TALENT_ID}`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
      });
  });

  it('PATCH /calendar-meeting/{id} reschedules the same provider event (organizer-bound, CAS)', async () => {
    const BODY = {
      expected_version: 0,
      start_date_time: '2026-11-04T16:00:00',
      end_date_time: '2026-11-04T16:30:00',
      time_zone: 'America/New_York',
    };
    await provider
      .addInteraction()
      .given('an ats-web recruiter with an existing scheduled Outlook meeting exist')
      .uponReceiving('an ats-web recruiter rescheduling a scheduling meeting')
      .withRequest('PATCH', `/v1/integrations/microsoft/calendar-meeting/${MEETING_ID}`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ interaction_id: uuid(MEETING_ID), status: 'rescheduled', version: like(1), idempotent_replay: like(false) });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/integrations/microsoft/calendar-meeting/${MEETING_ID}`, {
          method: 'PATCH',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(200);
        expect(((await res.json()) as { status: string }).status).toBe('rescheduled');
      });
  });

  it('POST /calendar-meeting/{id}/cancel cancels the same provider event (organizer-bound, idempotent)', async () => {
    const BODY = { expected_version: 0 };
    await provider
      .addInteraction()
      .given('an ats-web recruiter with an existing scheduled Outlook meeting exist')
      .uponReceiving('an ats-web recruiter cancelling a scheduling meeting')
      .withRequest('POST', `/v1/integrations/microsoft/calendar-meeting/${MEETING_ID}/cancel`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ interaction_id: uuid(MEETING_ID), status: 'cancelled', version: like(1), idempotent_replay: like(false) });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/integrations/microsoft/calendar-meeting/${MEETING_ID}/cancel`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(200);
        expect(((await res.json()) as { status: string }).status).toBe('cancelled');
      });
  });
});
