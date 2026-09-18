import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { like, uuid, regex, integer, eachLike } = MatchersV3;

// SKILL-TAX-1F-B2 — platform skill-governance consumer Pact.
//
// Consumer:  platform-governance-consumer  (the apps/platform-web skills-taxonomy
//                                            admin + AI-proposal ratification console)
// Provider:  aramo-core                    (apps/api, the /platform/* surface)
//
// Scope: the platform-tier canonical-taxonomy governance contract SHAPE — a create
// mutation, the counts-only review queue, the atomic proposal accept, and the DDR
// §13.1 tier tripwire (a tenant-tier token is refused 403). Every governed operation
// carries consumer_type=platform; the taxonomy is platform-global (no tenant scope,
// no PII); the review queue is COUNTS-ONLY (never a tenant id in a response).

const provider = new PactV4({
  consumer: 'platform-governance-consumer',
  provider: 'aramo-core',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

const SKILL_ID = '01900000-0000-7000-8000-0000000ab001';
const PROPOSAL_ID = '01900000-0000-7000-8000-0000000ab002';
const ALIAS_ID = '01900000-0000-7000-8000-0000000ab003';
const REQUEST_ID = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1bb0';
const PLATFORM_BEARER = 'Bearer eyJfake.platform.token';
const RECRUITER_BEARER = 'Bearer eyJfake.token';
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

describe('platform-governance-consumer → /platform/* skill governance', () => {
  it('POST /platform/skills → 201 SkillView (create a canonical skill)', async () => {
    const body = { canonical_name: 'Kubernetes', description: 'Container orchestration' };
    await provider
      .addInteraction()
      .given('a platform operator may govern the canonical skills taxonomy')
      .uponReceiving('a create-canonical-skill request')
      .withRequest('POST', '/platform/skills', (b) => {
        b.headers({ Authorization: like(PLATFORM_BEARER), 'Content-Type': 'application/json' }).jsonBody(body);
      })
      .willRespondWith(201, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          id: uuid(SKILL_ID),
          canonical_name: like('Kubernetes'),
          normalized_name: like('kubernetes'),
          description: like('Container orchestration'),
          status: like('active'),
          merged_into_skill_id: null,
          created_at: regex(ISO_TIMESTAMP, '2026-09-18T00:00:01Z'),
          updated_at: regex(ISO_TIMESTAMP, '2026-09-18T00:00:01Z'),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/platform/skills`, {
          method: 'POST',
          headers: { Authorization: PLATFORM_BEARER, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        expect(res.status).toBe(201);
        const json = (await res.json()) as { status: string; merged_into_skill_id: string | null };
        expect(json.status).toBe('active');
        expect(json.merged_into_skill_id).toBeNull();
      });
  });

  it('GET /platform/skill-review-queue → 200 counts-only page', async () => {
    await provider
      .addInteraction()
      .given('the skill review queue has an unresolved surface with cross-domain occurrences')
      .uponReceiving('a review-queue read')
      .withRequest('GET', '/platform/skill-review-queue', (b) => {
        b.query({ limit: '50' }).headers({ Authorization: like(PLATFORM_BEARER) });
      })
      .willRespondWith(200, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          rows: eachLike({
            surface_form: like('kubernetes'),
            occurrence_count: integer(3),
            tenant_count: integer(2),
          }),
          next_cursor: null,
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/platform/skill-review-queue?limit=50`, {
          headers: { Authorization: PLATFORM_BEARER },
        });
        expect(res.status).toBe(200);
        const json = (await res.json()) as {
          rows: Array<Record<string, unknown>>;
          next_cursor: string | null;
        };
        expect(Array.isArray(json.rows)).toBe(true);
        // Counts-only contract: NO tenant id field may appear on a row.
        for (const row of json.rows) {
          expect(row).not.toHaveProperty('tenant_id');
          expect(row).not.toHaveProperty('tenant_ids');
          expect(typeof row['tenant_count']).toBe('number');
        }
      });
  });

  it('POST /platform/skill-proposals/{id}/accept → 200 ProposalView ACCEPTED', async () => {
    await provider
      .addInteraction()
      .given('a PENDING alias proposal exists for a canonical skill')
      .uponReceiving('an accept-proposal decision')
      .withRequest('POST', `/platform/skill-proposals/${PROPOSAL_ID}/accept`, (b) => {
        b.headers({ Authorization: like(PLATFORM_BEARER) });
      })
      .willRespondWith(200, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          id: uuid(PROPOSAL_ID),
          proposal_type: like('ALIAS'),
          source: like('AI_RECOMMENDED'),
          status: like('ACCEPTED'),
          payload: like({ skill_id: SKILL_ID, alias: 'K8s', alias_type: 'ABBREVIATION' }),
          proposed_by: null,
          proposed_at: regex(ISO_TIMESTAMP, '2026-09-18T00:00:01Z'),
          decided_by: uuid('01900000-0000-7000-8000-0000000ac001'),
          decided_at: regex(ISO_TIMESTAMP, '2026-09-18T00:00:02Z'),
          decision_reason: null,
          applied_entity_id: uuid(ALIAS_ID),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/platform/skill-proposals/${PROPOSAL_ID}/accept`, {
          method: 'POST',
          headers: { Authorization: PLATFORM_BEARER },
        });
        expect(res.status).toBe(200);
        const json = (await res.json()) as { status: string; applied_entity_id: string | null };
        expect(json.status).toBe('ACCEPTED');
        expect(json.applied_entity_id).not.toBeNull();
      });
  });

  it('GET /platform/skills with a tenant-tier token → 403 (DDR §13.1 tripwire)', async () => {
    await provider
      .addInteraction()
      .given('a platform operator may govern the canonical skills taxonomy')
      .uponReceiving('a tenant-tier token hitting a platform route')
      .withRequest('GET', '/platform/skills', (b) => {
        b.headers({ Authorization: like(RECRUITER_BEARER) });
      })
      .willRespondWith(403, (b) => {
        b.jsonBody({
          error: {
            code: like('INSUFFICIENT_PERMISSIONS'),
            message: like('Platform routes require consumer_type=platform'),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/platform/skills`, {
          headers: { Authorization: RECRUITER_BEARER },
        });
        expect(res.status).toBe(403);
        const json = (await res.json()) as { error: { code: string } };
        expect(json.error.code).toBe('INSUFFICIENT_PERMISSIONS');
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
