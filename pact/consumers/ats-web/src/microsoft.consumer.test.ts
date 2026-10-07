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
