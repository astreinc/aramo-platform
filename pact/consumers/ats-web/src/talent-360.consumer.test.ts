import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ACCESS_COOKIE,
  ISO_TIMESTAMP,
  TALENT_ID,
  like,
  makeAtsWebProvider,
  regex,
  uuid,
} from './support/ats-web-pact.js';

// Pact consumer for ats-web → GET /v1/talent-360/:id (the person-centric
// recruiter workspace composed read). ONE minimal interaction that pins the
// RESPONSE CONTRACT from the authorized side: a fully-scoped recruiter reads a
// Talent with no downstream activity, so every scope-gated section composes
// AUTHORIZED-EMPTY — an OBJECT with empty arrays / 0 counts, NEVER null, and
// authorized_sections all true. This is the load-bearing contract the FE relies
// on: authorization-hidden ⇒ null vs authorized-but-empty ⇒ [] / 0. The null
// (unauthorized) side is proven over HTTP in the api integration suite and
// encoded in openapi/ats.yaml. Merges into ats-web-aramo-core.json.
//
// Provider state seeds only the minimal graph (TalentRecord + contacting
// consent) — see pact/provider/src/verify-api.ts.

const provider = makeAtsWebProvider();

describe('ats-web → GET /v1/talent-360/:id (composed read)', () => {
  it('returns 200 with authorized-empty sections ([] / 0, never null) for a Talent with no activity', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a Talent 360 record with no downstream activity exist')
      .uponReceiving('a Talent 360 composed read for a no-activity Talent')
      .withRequest('GET', `/v1/talent-360/${TALENT_ID}`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          generated_at: regex(ISO_TIMESTAMP, '2026-09-30T00:00:00Z'),
          server_date: like('2026-09-30'),
          header: {
            talent_id: uuid(TALENT_ID),
            first_name: like('Divya'),
            last_name: like('Vasudevan'),
            display_name: like('Divya Vasudevan'),
            title: null,
            location: null,
            experience_summary: null,
            email: null,
            phone: null,
            work_authorization: null,
            desired_compensation: null,
            engagement_type: null,
            availability: { status: null, detail: null },
            recruiting_ready: { ready: like(false), rule: like('…') },
            contactability: {
              summary: like('contactable'),
              recruiting_permitted: like(true),
              email_permitted: like(true),
              phone_permitted: like(true),
              sms_permitted: like(false),
            },
            actions: {
              can_email: like(false),
              can_call: like(false),
              can_add_to_requisition: like(true),
              can_log_activity: like(true),
              can_edit_profile: like(true),
            },
            record_status: 'live',
            superseded_by_record_id: null,
          },
          // Authorized-but-empty: counts are 0 (NOT null); last_contact null (no
          // contact yet, though communication:read is held).
          relationship_strip: {
            active_opportunities: 0,
            submittals: 0,
            interviews_today: 0,
            offers: 0,
            assignments: 0,
            last_contact: null,
          },
          // Scope-gated sections present (authorized) but EMPTY — the pinned
          // distinction from null.
          opportunities: { active: [], closed: [] },
          attention: [],
          tasks: [],
          recent_activity: { items: [], category_counts: like({}), has_more: like(false) },
          documents: { key_documents: [], total: 0 },
          identity: {
            primary_email_confirmed: like(false),
            mobile_confirmed: like(false),
            advisory: null,
          },
          profile: { summary: null, facts: [], skills: [], work_history: [] },
          relationship: {
            history: {
              known_since: regex(ISO_TIMESTAMP, '2026-05-25T00:00:00Z'),
              requisitions: 0,
              submittals: 0,
              interviews: 0,
              placements: 0,
            },
            ownership: {
              owner_provenance: null,
              also_working_with: [],
              worked_with_before: [],
              source: null,
              source_channel: null,
            },
          },
          authorized_sections: {
            opportunities: true,
            attention: true,
            tasks: true,
            activity: true,
            communications: true,
            documents: true,
            identity: true,
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/talent-360/${TALENT_ID}`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          opportunities: { active: unknown[]; closed: unknown[] } | null;
          documents: { total: number } | null;
          relationship_strip: { active_opportunities: number | null; last_contact: unknown };
          authorized_sections: Record<string, boolean>;
        };
        // The contract: authorized sections are non-null objects with empty
        // arrays / 0 counts (authorized-empty), never null.
        expect(body.opportunities).not.toBeNull();
        expect(body.opportunities?.active).toEqual([]);
        expect(body.documents?.total).toBe(0);
        expect(body.relationship_strip.active_opportunities).toBe(0);
        expect(body.relationship_strip.last_contact).toBeNull();
        expect(body.authorized_sections.documents).toBe(true);
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
