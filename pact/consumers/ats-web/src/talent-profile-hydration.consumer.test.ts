import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ACCESS_COOKIE,
  MatchersV3,
  like,
  makeAtsWebProvider,
  uuid,
} from './support/ats-web-pact.js';

// TALENT-INTEL-1 TI-1E-A — Pact consumer for ats-web, the aggregate
// profile-hydration projection (GET /v1/talent-records/:id/profile-hydration).
// A DERIVED read over the COMPLETE governed editable field set; reuses the
// TI-1D-A/B field-state substrate the field-state pact already seeds. The
// projection returns every governed field, so the response is matched with
// arrayContaining — pinning the three that carry the load-bearing invariants:
//   - city:  reconciled → SET + source_type RECONCILED + evidence linkage.
//   - work_authorization: governed EXPLICITLY_CLEARED + HOLD + OPEN review.
//   - first_name: a plain operational value → SET but source_type null +
//     provenance null (operational fields are NEVER given fabricated provenance).
//
// Guard chain: @RequireCapability('ats') + @RequireScopes('talent:read') +
// @RequireSiteMatch(). Reuses the TI-1D-B field-state provider state.

const provider = makeAtsWebProvider();

const HYDRATION_ID = '00000000-0000-7000-8000-7a0000000015';
const HYDRATION_EV_ID = '00000000-0000-7000-8000-7a0000000016';

describe('ats-web → GET /v1/talent-records/:id/profile-hydration', () => {
  it('returns 200 with the aggregate hydration projection over the governed field set', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a talent record with field-state exist')
      .uponReceiving('a talent-record profile-hydration read')
      .withRequest(
        'GET',
        `/v1/talent-records/${HYDRATION_ID}/profile-hydration`,
        (b) => {
          b.headers({ Cookie: like(ACCESS_COOKIE) });
        },
      )
      .willRespondWith(200, (b) => {
        b.jsonBody({
          talent_record_id: uuid(HYDRATION_ID),
          fields: MatchersV3.arrayContaining(
            {
              field_key: 'city',
              current_value: like('London'),
              value_state: 'SET',
              source_type: 'RECONCILED',
              projection_policy: 'AUTO',
              provenance: { evidence_id: uuid(HYDRATION_EV_ID) },
              resolution_status: 'NONE',
              resolution_reason: null,
              proposed_value: null,
            },
            {
              field_key: 'work_authorization',
              current_value: null,
              value_state: 'EXPLICITLY_CLEARED',
              source_type: 'MANUAL',
              projection_policy: 'HOLD',
              provenance: null,
              resolution_status: 'PENDING_REVIEW',
              resolution_reason: 'EVIDENCE_CONFLICT',
              proposed_value: like('US_CITIZEN'),
            },
            {
              field_key: 'first_name',
              current_value: like('Ada'),
              value_state: 'SET',
              source_type: null,
              projection_policy: 'AUTO',
              provenance: null,
              resolution_status: 'NONE',
              resolution_reason: null,
              proposed_value: null,
            },
          ),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/talent-records/${HYDRATION_ID}/profile-hydration`,
          { headers: { Cookie: ACCESS_COOKIE } },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          talent_record_id: string;
          fields: Array<{
            field_key: string;
            value_state: string;
            source_type: string | null;
            provenance: { evidence_id: string } | null;
          }>;
        };
        const wa = body.fields.find((f) => f.field_key === 'work_authorization');
        expect(wa?.value_state).toBe('EXPLICITLY_CLEARED');
        const fn = body.fields.find((f) => f.field_key === 'first_name');
        // operational field: present (SET) but NO fabricated governed provenance
        expect(fn?.value_state).toBe('SET');
        expect(fn?.source_type).toBeNull();
        expect(fn?.provenance).toBeNull();
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
