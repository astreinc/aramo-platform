import { describe, expect, it, vi } from 'vitest';

import {
  getTalentConsentDecisionLog,
  getTalentConsentHistory,
  getTalentConsentState,
} from './consent-api';
import type {
  ConsentDecisionLogResponse,
  ConsentHistoryResponse,
  TalentConsentStateResponse,
} from './types';

const TALENT_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const TENANT_ID = '11111111-1111-7111-8111-111111111111';

const state: TalentConsentStateResponse = {
  talent_id: TALENT_ID,
  tenant_id: TENANT_ID,
  is_anonymized: false,
  computed_at: '2026-05-16T00:00:00Z',
  scopes: [
    {
      scope: 'profile_storage',
      status: 'granted',
      granted_at: '2026-04-29T00:00:00Z',
      revoked_at: null,
      expires_at: null,
    },
  ],
};

const history: ConsentHistoryResponse = {
  events: [
    {
      event_id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1a00',
      scope: 'profile_storage',
      action: 'granted',
      created_at: '2026-04-29T00:00:00Z',
      expires_at: null,
    },
  ],
  next_cursor: 'opaque-cursor-string',
  is_anonymized: false,
};

const decisionLog: ConsentDecisionLogResponse = {
  entries: [
    {
      event_id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1a00',
      talent_id: TALENT_ID,
      event_type: 'consent.grant.recorded',
      created_at: '2026-04-29T00:00:00Z',
      actor_id: null,
      actor_type: 'recruiter',
      event_payload: { scope: 'profile_storage' },
    },
  ],
  next_cursor: null,
  is_anonymized: false,
};

function mockFetchJson(body: unknown): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
}

describe('consent-api', () => {
  it('GETs /v1/consent/state/:talent_id and returns the typed response', async () => {
    const spy = mockFetchJson(state);
    await expect(getTalentConsentState(TALENT_ID)).resolves.toEqual(state);
    const url = String(spy.mock.calls[0]?.[0]);
    expect(url).toBe(`/v1/consent/state/${TALENT_ID}`);
  });

  it('GETs /v1/consent/history/:talent_id and returns the typed response', async () => {
    const spy = mockFetchJson(history);
    await expect(getTalentConsentHistory(TALENT_ID)).resolves.toEqual(history);
    expect(String(spy.mock.calls[0]?.[0])).toBe(
      `/v1/consent/history/${TALENT_ID}`,
    );
  });

  it('forwards an opaque cursor verbatim as a query parameter', async () => {
    const spy = mockFetchJson(history);
    await getTalentConsentHistory(TALENT_ID, 'opaque-cursor-string');
    const url = String(spy.mock.calls[0]?.[0]);
    expect(url).toBe(
      `/v1/consent/history/${TALENT_ID}?cursor=opaque-cursor-string`,
    );
  });

  it('omits the cursor query parameter when cursor is null/undefined/empty', async () => {
    const spy = mockFetchJson(history);
    await getTalentConsentHistory(TALENT_ID, null);
    await getTalentConsentHistory(TALENT_ID, undefined);
    await getTalentConsentHistory(TALENT_ID, '');
    for (const call of spy.mock.calls) {
      expect(String(call[0])).toBe(`/v1/consent/history/${TALENT_ID}`);
    }
  });

  it('GETs /v1/consent/decision-log/:talent_id and returns the typed response', async () => {
    const spy = mockFetchJson(decisionLog);
    await expect(getTalentConsentDecisionLog(TALENT_ID)).resolves.toEqual(
      decisionLog,
    );
    expect(String(spy.mock.calls[0]?.[0])).toBe(
      `/v1/consent/decision-log/${TALENT_ID}`,
    );
  });
});
