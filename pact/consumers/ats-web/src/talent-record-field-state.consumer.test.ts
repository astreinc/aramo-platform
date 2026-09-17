import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ACCESS_COOKIE,
  like,
  makeAtsWebProvider,
  uuid,
} from './support/ats-web-pact.js';

// TALENT-INTEL-1 TI-1D-B — Pact consumer for ats-web, the DEDICATED field-state
// read model (GET /v1/talent-records/:id/field-state). A separate contract surface
// from getById (which stays the operational talent projection): per governed field
// the control state, the evidence-linkage provenance (by reference — never a raw
// evidence payload), and the current resolution summary.
//
// One interaction pins the full shape over two fields (sorted by field_key):
//   - city:  occupied, control SET/RECONCILED/AUTO, provenance present, no review.
//   - work_authorization: recruiter-cleared (current_value null), control
//     EXPLICITLY_CLEARED/MANUAL/HOLD, an OPEN review (PENDING_REVIEW /
//     EVIDENCE_CONFLICT) carrying the review-only proposed_value.
//
// Guard chain: @RequireCapability('ats') + @RequireScopes('talent:read') +
// @RequireSiteMatch().

const provider = makeAtsWebProvider();

const FIELD_STATE_ID = '00000000-0000-7000-8000-7a0000000015';
const FIELD_STATE_EV_ID = '00000000-0000-7000-8000-7a0000000016';

describe('ats-web → GET /v1/talent-records/:id/field-state', () => {
  it('returns 200 with the per-field control + resolution read model', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a talent record with field-state exist')
      .uponReceiving('a talent-record field-state read')
      .withRequest(
        'GET',
        `/v1/talent-records/${FIELD_STATE_ID}/field-state`,
        (b) => {
          b.headers({ Cookie: like(ACCESS_COOKIE) });
        },
      )
      .willRespondWith(200, (b) => {
        b.jsonBody({
          talent_record_id: uuid(FIELD_STATE_ID),
          fields: [
            {
              field_key: 'city',
              current_value: like('London'),
              value_state: 'SET',
              source_type: 'RECONCILED',
              projection_policy: 'AUTO',
              provenance: { evidence_id: uuid(FIELD_STATE_EV_ID) },
              proposed_value: null,
              resolution_status: 'NONE',
              resolution_reason: null,
            },
            {
              field_key: 'work_authorization',
              current_value: null,
              value_state: 'EXPLICITLY_CLEARED',
              source_type: 'MANUAL',
              projection_policy: 'HOLD',
              provenance: null,
              proposed_value: like('US_CITIZEN'),
              resolution_status: 'PENDING_REVIEW',
              resolution_reason: 'EVIDENCE_CONFLICT',
            },
          ],
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/talent-records/${FIELD_STATE_ID}/field-state`,
          { headers: { Cookie: ACCESS_COOKIE } },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          talent_record_id: string;
          fields: Array<{
            field_key: string;
            current_value: string | null;
            resolution_status: string;
            proposed_value: string | null;
            provenance: { evidence_id: string } | null;
          }>;
        };
        const wa = body.fields.find((f) => f.field_key === 'work_authorization');
        expect(wa?.current_value).toBeNull(); // current from getById, not proposed
        expect(wa?.resolution_status).toBe('PENDING_REVIEW');
        expect(wa?.proposed_value).not.toBeNull();
        expect(wa?.provenance).toBeNull();
        const city = body.fields.find((f) => f.field_key === 'city');
        expect(city?.resolution_status).toBe('NONE');
        expect(city?.provenance).not.toBeNull();
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
