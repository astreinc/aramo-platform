import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ACCESS_COOKIE,
  ISO_TIMESTAMP,
  TALENT_ID,
  TENANT_ID,
  like,
  makeAtsWebProvider,
  regex,
  uuid,
} from './support/ats-web-pact.js';

// PC-7a — Pact consumer for ats-web, consent-read domain (PC-7 Charter §2:
// the 3 consent-read pins ats-web drives that previously only tenant-console-
// consumer contracted). Migrating them here unblocks the tenant-console-
// consumer retirement (exit accounting §4.2). Merges into ats-web-aramo-core.
//
// Scope (Gate-0 ruling): 3 happy interactions — pure reads, auth-only
// (@UseGuards(JwtAuthGuard); no scope/capability). illegal-state /
// idempotency: 0-by-substrate. refusal: 0-by-ruling (401/404/400-bad-cursor →
// hardening park; the tenant-console 401 stays there).
//   - GET /v1/consent/state/:talent_record_id (5-scope status matrix);
//   - GET /v1/consent/history/:talent_record_id?limit=1 (CURSOR-OPACITY pin:
//     non-null next_cursor is an OPAQUE like-string the FE echoes verbatim,
//     never parses);
//   - GET /v1/consent/decision-log/:talent_record_id (audit entries).
//
// Reuses the live provider consent handlers (consumer-agnostic given strings)
// for state + decision-log; a new handler seeds 2 events for the ?limit=1
// cursor-opacity pin. When tenant-console retires, these handlers stay live
// (now driven by ats-web).

const provider = makeAtsWebProvider();

const EVENT_ID = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1a00';

describe('ats-web → GET /v1/consent/state/:talent_record_id', () => {
  it('returns 200 with the 5-scope consent state matrix', async () => {
    const scope = (
      s: string,
      status: string,
      granted: boolean,
    ) => ({
      scope: s,
      status,
      granted_at: granted ? regex(ISO_TIMESTAMP, '2026-04-29T00:00:00Z') : null,
      revoked_at: null,
      expires_at: null,
    });
    await provider
      .addInteraction()
      .given('a recruiter session and a talent with consent state')
      .uponReceiving('an ats-web consent-state read')
      .withRequest('GET', `/v1/consent/state/${TALENT_ID}`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          talent_record_id: uuid(TALENT_ID),
          tenant_id: uuid(TENANT_ID),
          is_anonymized: false,
          computed_at: regex(ISO_TIMESTAMP, '2026-05-16T00:00:00Z'),
          scopes: [
            scope('profile_storage', 'granted', true),
            scope('resume_processing', 'granted', true),
            scope('matching', 'no_grant', false),
            scope('contacting', 'no_grant', false),
            scope('cross_tenant_visibility', 'no_grant', false),
          ],
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/consent/state/${TALENT_ID}`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { scopes: unknown[] };
        expect(body.scopes.length).toBe(5);
      });
  });
});

describe('ats-web → GET /v1/consent/history/:talent_record_id', () => {
  it('returns 200 with an event page and an opaque next_cursor', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a talent with multiple consent history events')
      .uponReceiving('an ats-web consent-history read (page 1, more to come)')
      .withRequest('GET', `/v1/consent/history/${TALENT_ID}`, (b) => {
        b.query({ limit: '1' }).headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          events: [
            {
              event_id: uuid(),
              scope: like('matching'),
              action: like('granted'),
              created_at: regex(ISO_TIMESTAMP, '2026-04-30T00:00:00Z'),
              expires_at: null,
            },
          ],
          // Cursor-opacity pin: a non-null OPAQUE base64url token, type-matched
          // only (the FE echoes it back verbatim on the next page, never parses).
          next_cursor: like(
            'eyJjIjoiMjAyNi0wNC0zMFQwMDowMDowMC4wMDBaIiwiZSI6IjAxOTBkNWE0LTdlMDEtN2UyYS1hNGQzLTNkNGYxYzJiMWIwMiJ9',
          ),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/consent/history/${TALENT_ID}?limit=1`,
          { headers: { Cookie: ACCESS_COOKIE } },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          events: unknown[];
          next_cursor: string | null;
        };
        expect(body.events.length).toBe(1);
        expect(typeof body.next_cursor).toBe('string');
      });
  });
});

describe('ats-web → GET /v1/consent/decision-log/:talent_record_id', () => {
  it('returns 200 with the decision-log entries', async () => {
    await provider
      .addInteraction()
      .given('a recruiter session and a talent with decision-log entries')
      .uponReceiving('an ats-web consent decision-log read')
      .withRequest('GET', `/v1/consent/decision-log/${TALENT_ID}`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          entries: [
            {
              event_id: uuid(EVENT_ID),
              talent_record_id: uuid(TALENT_ID),
              event_type: 'consent.grant.recorded',
              created_at: regex(ISO_TIMESTAMP, '2026-04-29T00:00:00Z'),
              actor_id: uuid(),
              actor_type: 'recruiter',
              event_payload: like({ scope: 'profile_storage' }),
            },
          ],
          next_cursor: null,
          is_anonymized: false,
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/consent/decision-log/${TALENT_ID}`,
          { headers: { Cookie: ACCESS_COOKIE } },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { entries: unknown[] };
        expect(body.entries.length).toBeGreaterThan(0);
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
