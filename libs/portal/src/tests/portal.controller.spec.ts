import { describe, expect, it } from 'vitest';

import { PortalController } from '../lib/portal.controller.js';

// M3 PR-9 §4.9 — controller unit tests with mocked TalentService and
// ConsentService. Verifies the per-endpoint behavior in §4.1:
// auth check, talent_id resolution from sub, UUID sanity, service
// wiring, 404 on null findSelfProfile, response DTO shape.
//
// End-to-end (AppModule compile + HTTP request + R10-class field
// absence) lives in apps/api/src/tests/portal-refusal.negative-shape.spec.ts.

const TENANT_ID = '11111111-1111-7111-8111-111111111111';
const TALENT_SUB = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const OTHER_TALENT = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';

function portalAuth(overrides: Partial<{
  consumer_type: 'recruiter' | 'portal' | 'ingestion';
  sub: string;
  tenant_id: string;
}> = {}) {
  return {
    sub: overrides.sub ?? TALENT_SUB,
    consumer_type: overrides.consumer_type ?? ('portal' as const),
    actor_kind: 'user' as const,
    tenant_id: overrides.tenant_id ?? TENANT_ID,
    scopes: [],
    iat: 0,
    exp: 0,
  };
}

interface ProfileCall { tenant_id: string; talent_id: string }
interface ConsentCall { talent_id: string; authContext: unknown; requestId: string }

function makeTalentService(
  returns: { talent_id: string; tenant_id: string; lifecycle_status: string; tenant_status: string; source_channel: string; created_at: string } | null,
  calls: { profile: ProfileCall[] },
) {
  return {
    findSelfProfile: async (input: ProfileCall) => {
      calls.profile.push(input);
      return returns;
    },
  };
}

function makeConsentService(
  returns: { talent_id: string; tenant_id: string; is_anonymized: boolean; computed_at: string; scopes: unknown[] },
  calls: { consent: ConsentCall[] },
) {
  return {
    getState: async (talent_id: string, authContext: unknown, requestId: string) => {
      calls.consent.push({ talent_id, authContext, requestId });
      return returns;
    },
  };
}

const sampleProjection = {
  talent_id: TALENT_SUB,
  tenant_id: TENANT_ID,
  lifecycle_status: 'active',
  tenant_status: 'active',
  source_channel: 'self_signup',
  created_at: '2026-05-01T12:00:00.000Z',
};

const sampleConsentState = {
  talent_id: TALENT_SUB,
  tenant_id: TENANT_ID,
  is_anonymized: false,
  computed_at: '2026-05-01T12:00:00.000Z',
  scopes: [],
};

describe('PortalController — /v1/portal/profile', () => {
  it('returns 403 INSUFFICIENT_PERMISSIONS when consumer_type !== "portal"', async () => {
    const calls = { profile: [] as ProfileCall[] };
    const controller = new PortalController(
      makeTalentService(sampleProjection, calls) as never,
      makeConsentService(sampleConsentState, { consent: [] }) as never,
    );
    await expect(
      controller.getProfile(portalAuth({ consumer_type: 'recruiter' }), 'req-1'),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403 });
    expect(calls.profile).toEqual([]);
  });

  it('returns 400 INVALID_REQUEST when sub claim is not a UUID', async () => {
    const calls = { profile: [] as ProfileCall[] };
    const controller = new PortalController(
      makeTalentService(sampleProjection, calls) as never,
      makeConsentService(sampleConsentState, { consent: [] }) as never,
    );
    await expect(
      controller.getProfile(portalAuth({ sub: 'not-a-uuid' }), 'req-1'),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      statusCode: 400,
      context: { details: { invalid_field: 'sub' } },
    });
    expect(calls.profile).toEqual([]);
  });

  it('wires (tenant_id, talent_id) from authContext.{tenant_id, sub} into findSelfProfile', async () => {
    const calls = { profile: [] as ProfileCall[] };
    const controller = new PortalController(
      makeTalentService(sampleProjection, calls) as never,
      makeConsentService(sampleConsentState, { consent: [] }) as never,
    );
    await controller.getProfile(portalAuth(), 'req-1');
    expect(calls.profile).toEqual([{ tenant_id: TENANT_ID, talent_id: TALENT_SUB }]);
  });

  it('returns 404 NOT_FOUND when findSelfProfile returns null', async () => {
    const calls = { profile: [] as ProfileCall[] };
    const controller = new PortalController(
      makeTalentService(null, calls) as never,
      makeConsentService(sampleConsentState, { consent: [] }) as never,
    );
    await expect(controller.getProfile(portalAuth(), 'req-1')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
    });
  });

  it('returns PortalProfileDto verbatim from the projection (no extras, no Full-class leakage)', async () => {
    const calls = { profile: [] as ProfileCall[] };
    const controller = new PortalController(
      makeTalentService(sampleProjection, calls) as never,
      makeConsentService(sampleConsentState, { consent: [] }) as never,
    );
    const result = await controller.getProfile(portalAuth(), 'req-1');
    expect(result).toEqual({
      talent_id: TALENT_SUB,
      tenant_id: TENANT_ID,
      lifecycle_status: 'active',
      tenant_status: 'active',
      source_channel: 'self_signup',
      created_at: '2026-05-01T12:00:00.000Z',
    });
    // Defense-in-depth: no Full/Match/R10-class fields leak.
    const FORBIDDEN = [
      'internal_reasoning', 'entrustability_tier_raw',
      'tier', 'rank_ordinal', 'examination_id', 'score', 'why_matched_sentence',
      'strengths', 'gaps', 'risk_flags', 'expanded_reasoning',
      'evidence_references', 'confidence_indicators', 'delta_to_entrustable',
      'source_recruiter_id',
    ];
    for (const f of FORBIDDEN) expect(result).not.toHaveProperty(f);
  });
});

describe('PortalController — /v1/portal/consent', () => {
  it('returns 403 INSUFFICIENT_PERMISSIONS when consumer_type !== "portal"', async () => {
    const calls = { consent: [] as ConsentCall[] };
    const controller = new PortalController(
      makeTalentService(sampleProjection, { profile: [] }) as never,
      makeConsentService(sampleConsentState, calls) as never,
    );
    await expect(
      controller.getOwnConsent(portalAuth({ consumer_type: 'ingestion' }), 'req-1'),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403 });
    expect(calls.consent).toEqual([]);
  });

  it('returns 400 INVALID_REQUEST when sub claim is not a UUID', async () => {
    const calls = { consent: [] as ConsentCall[] };
    const controller = new PortalController(
      makeTalentService(sampleProjection, { profile: [] }) as never,
      makeConsentService(sampleConsentState, calls) as never,
    );
    await expect(
      controller.getOwnConsent(portalAuth({ sub: 'not-a-uuid' }), 'req-1'),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST', statusCode: 400 });
    expect(calls.consent).toEqual([]);
  });

  it('wires (talent_id, authContext, requestId) from sub into ConsentService.getState', async () => {
    const calls = { consent: [] as ConsentCall[] };
    const controller = new PortalController(
      makeTalentService(sampleProjection, { profile: [] }) as never,
      makeConsentService(sampleConsentState, calls) as never,
    );
    const auth = portalAuth();
    await controller.getOwnConsent(auth, 'req-7');
    expect(calls.consent).toHaveLength(1);
    expect(calls.consent[0]?.talent_id).toBe(TALENT_SUB);
    expect(calls.consent[0]?.requestId).toBe('req-7');
  });

  it('returns the ConsentService response verbatim (no Match-class/Full-class leakage)', async () => {
    const calls = { consent: [] as ConsentCall[] };
    const controller = new PortalController(
      makeTalentService(sampleProjection, { profile: [] }) as never,
      makeConsentService(sampleConsentState, calls) as never,
    );
    const result = await controller.getOwnConsent(portalAuth(), 'req-1');
    expect(result).toEqual(sampleConsentState);
    const FORBIDDEN = ['internal_reasoning', 'tier', 'rank_ordinal', 'score', 'examination_id'];
    for (const f of FORBIDDEN) expect(result).not.toHaveProperty(f);
  });

  it('portal session cannot address another talent (sub is the only talent_id surface)', async () => {
    const calls = { consent: [] as ConsentCall[] };
    const controller = new PortalController(
      makeTalentService(sampleProjection, { profile: [] }) as never,
      makeConsentService(sampleConsentState, calls) as never,
    );
    // Even if some other talent's id were passed somewhere, the controller
    // resolves talent_id from authContext.sub only — there is no surface
    // to pass a different talent_id. This test fixates that surface gap.
    const auth = portalAuth({ sub: TALENT_SUB });
    await controller.getOwnConsent(auth, 'req-1');
    expect(calls.consent[0]?.talent_id).toBe(TALENT_SUB);
    expect(calls.consent[0]?.talent_id).not.toBe(OTHER_TALENT);
  });
});
