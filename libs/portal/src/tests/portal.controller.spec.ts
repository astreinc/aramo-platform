import { describe, expect, it } from 'vitest';

import { PortalController } from '../lib/portal.controller.js';
import type { PortalRecordRef } from '../lib/portal-talent-resolver.service.js';

// Portal P1 PR-2a §4.1 — controller unit tests on the OPEN-4 records surface,
// with mocked PortalTalentResolverService + TalentRecordService + ConsentService.
// Verifies per-endpoint behavior: portal-consumer auth check, sub UUID sanity,
// chain resolution wiring into findSelfProfile, the UNIFORM 404 (unreachable ==
// unknown == malformed), record-tenant-scoped consent wiring, and R10-class
// field absence in the projection.
//
// The full end-to-end (AppModule compile + HTTP + husk→survivor + cross-tenant
// chain + R10-class absence) lives in
// apps/api/src/tests/portal-refusal.negative-shape.spec.ts.

const PLATFORM_SENTINEL = '00000000-0000-7000-8000-000000000000';
const PORTAL_SUB = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa'; // = PortalUser.id = JWT sub
const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '22222222-2222-7222-8222-222222222222';
const RECORD_A = 'a1a1a1a1-a1a1-7a1a-8a1a-a1a1a1a1a1a1';
const RECORD_B = 'b1b1b1b1-b1b1-7b1b-8b1b-b1b1b1b1b1b1';
const UNKNOWN_RECORD = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc'; // well-formed, not in chain
const MALFORMED_RECORD = 'not-a-uuid';

function portalAuth(overrides: Partial<{
  consumer_type: 'recruiter' | 'portal' | 'ingestion';
  sub: string;
  tenant_id: string;
}> = {}) {
  return {
    sub: overrides.sub ?? PORTAL_SUB,
    consumer_type: overrides.consumer_type ?? ('portal' as const),
    actor_kind: 'user' as const,
    // A portal session carries the platform sentinel, NOT a record's tenant —
    // the chain supplies the record tenant, which is what consent must scope to.
    tenant_id: overrides.tenant_id ?? PLATFORM_SENTINEL,
    scopes: [],
    iat: 0,
    exp: 0,
  };
}

interface ProfileCall { tenant_id: string; talent_id: string }
interface ConsentCall { talent_id: string; authContext: { tenant_id: string }; requestId: string }
interface ResolveRecordsCall { portalUserId: string }
interface ResolveMemberCall { portalUserId: string; recordId: string }

// Resolver mock: resolveRecords returns the seeded refs; resolveMemberRecord
// mirrors the real find-by-record-id-in-chain (null when not present).
function makeResolver(
  refs: PortalRecordRef[],
  calls: { resolveRecords: ResolveRecordsCall[]; resolveMember: ResolveMemberCall[] },
) {
  return {
    resolveRecords: async (portalUserId: string) => {
      calls.resolveRecords.push({ portalUserId });
      return refs;
    },
    resolveMemberRecord: async (portalUserId: string, recordId: string) => {
      calls.resolveMember.push({ portalUserId, recordId });
      return refs.find((r) => r.record_id === recordId) ?? null;
    },
  };
}

// TalentRecordService mock: derives a projection from the (tenant_id, talent_id)
// it is asked for, so per-record wiring is observable. Returns null to simulate
// a vanished record.
function makeTalentRecordService(
  behavior: 'project' | 'null',
  calls: { profile: ProfileCall[] },
) {
  return {
    findSelfProfile: async (input: ProfileCall) => {
      calls.profile.push(input);
      if (behavior === 'null') return null;
      return {
        talent_id: input.talent_id,
        tenant_id: input.tenant_id,
        tenant_status: 'active',
        source_channel: 'self_signup',
        created_at: '2026-05-01T12:00:00.000Z',
      };
    },
  };
}

const sampleConsentState = {
  talent_id: RECORD_A,
  tenant_id: TENANT_A,
  is_anonymized: false,
  computed_at: '2026-05-01T12:00:00.000Z',
  scopes: [],
};

function makeConsentService(calls: {
  consent: ConsentCall[];
  texts?: string[];
  history?: { talent_record_id: string; authTenant: string }[];
}) {
  return {
    getState: async (
      talent_id: string,
      authContext: { tenant_id: string },
      requestId: string,
    ) => {
      calls.consent.push({ talent_id, authContext, requestId });
      return sampleConsentState;
    },
    // Portal P2 P2b — text render (per record tenant) + history (rescoped).
    getPortalConsentTexts: (recipientTenantId: string) => {
      calls.texts?.push(recipientTenantId);
      return {
        version: 'portal-consent-v1',
        texts: [{ scope: 'matching', text: `authorize ${recipientTenantId}` }],
      };
    },
    getPortalHistory: async (input: {
      talent_record_id: string;
      authContext: { tenant_id: string };
    }) => {
      calls.history?.push({
        talent_record_id: input.talent_record_id,
        authTenant: input.authContext.tenant_id,
      });
      return { events: [], next_cursor: null, is_anonymized: false };
    },
  };
}

// Portal P2 P2b — the tenant_name enrichment dependency. Maps the seeded tenant
// ids to human names; an unseeded id resolves to null (defensive fallback).
const TENANT_NAMES: Record<string, string> = {
  [TENANT_A]: 'Acme Corp',
  [TENANT_B]: 'Globex',
};
// Portal P3a — minimal TalentTrustService mock (verification view + disputes).
// The P1/P2 record/consent tests never call these; P3a route tests stub as needed.
function makeTrustService(overrides: Record<string, unknown> = {}) {
  return {
    aggregateVerifications: async () => [],
    openPortalDispute: async () => ({}),
    listPortalDisputes: async () => [],
    getPortalDispute: async () => ({ dispute: {}, statements: [] }),
    respondPortalDisputeStatement: async () => ({}),
    withdrawPortalDispute: async () => ({}),
    ...overrides,
  };
}

function makeTenantService() {
  return {
    getTenantById: async (id: string) => ({
      id,
      name: TENANT_NAMES[id] ?? null,
      is_active: true,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      identity_provider: null,
      status: 'active',
    }),
  };
}

const REF_A: PortalRecordRef = { tenant_id: TENANT_A, record_id: RECORD_A };
const REF_B: PortalRecordRef = { tenant_id: TENANT_B, record_id: RECORD_B };

// R10 / Match-class / Full-class field names that must never reach a portal.
const FORBIDDEN = [
  'internal_reasoning', 'entrustability_tier_raw',
  'tier', 'rank_ordinal', 'examination_id', 'score', 'why_matched_sentence',
  'strengths', 'gaps', 'risk_flags', 'expanded_reasoning',
  'evidence_references', 'confidence_indicators', 'delta_to_entrustable',
  'source_recruiter_id',
];

// PR-2b §PR-2.4 / P2b — grep-assert the surface against the D3 trust vocab: NO
// trust/verification/attestation ORIGIN data on this ENGAGEMENT surface (Portal
// DDR P-R4/P-R5). verifier/verified_by/verifying_*/origin_* are the origin-
// secrecy fields. Both tenant_id AND tenant_name are P-R5-legal here (a portal
// user's own engagements, named — ruling 2), so they are deliberately NOT in
// this list; they remain forbidden ONLY inside trust-class schemas (empty),
// which verify-portal-refusal.ts enforces.
const TRUST_VOCAB_FORBIDDEN = [
  'verifier', 'verified_by', 'verifying_tenant', 'origin_tenant',
  'attestation', 'trust_statement', 'verification_state',
];

describe('PortalController — GET /v1/portal/records', () => {
  it('returns 403 INSUFFICIENT_PERMISSIONS when consumer_type !== "portal"', async () => {
    const resolverCalls = { resolveRecords: [] as ResolveRecordsCall[], resolveMember: [] as ResolveMemberCall[] };
    const profileCalls = { profile: [] as ProfileCall[] };
    const controller = new PortalController(
      makeResolver([REF_A], resolverCalls) as never,
      makeTalentRecordService('project', profileCalls) as never,
      makeConsentService({ consent: [] }) as never,
      makeTenantService() as never,
      makeTrustService() as never,
    );
    await expect(
      controller.getRecords(portalAuth({ consumer_type: 'recruiter' }), 'req-1'),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403 });
    expect(resolverCalls.resolveRecords).toEqual([]);
  });

  it('returns 400 INVALID_REQUEST when sub claim is not a UUID', async () => {
    const resolverCalls = { resolveRecords: [] as ResolveRecordsCall[], resolveMember: [] as ResolveMemberCall[] };
    const controller = new PortalController(
      makeResolver([REF_A], resolverCalls) as never,
      makeTalentRecordService('project', { profile: [] }) as never,
      makeConsentService({ consent: [] }) as never,
      makeTenantService() as never,
      makeTrustService() as never,
    );
    await expect(
      controller.getRecords(portalAuth({ sub: 'not-a-uuid' }), 'req-1'),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      statusCode: 400,
      context: { details: { invalid_field: 'sub' } },
    });
    expect(resolverCalls.resolveRecords).toEqual([]);
  });

  it('resolves the chain from sub and wires each ref (tenant_id, record_id) into findSelfProfile', async () => {
    const resolverCalls = { resolveRecords: [] as ResolveRecordsCall[], resolveMember: [] as ResolveMemberCall[] };
    const profileCalls = { profile: [] as ProfileCall[] };
    const controller = new PortalController(
      makeResolver([REF_A, REF_B], resolverCalls) as never,
      makeTalentRecordService('project', profileCalls) as never,
      makeConsentService({ consent: [] }) as never,
      makeTenantService() as never,
      makeTrustService() as never,
    );
    const result = await controller.getRecords(portalAuth(), 'req-1');
    // WHO comes from sub only.
    expect(resolverCalls.resolveRecords).toEqual([{ portalUserId: PORTAL_SUB }]);
    // One findSelfProfile per resolved ref, keyed to THAT ref's tenant/record.
    expect(profileCalls.profile).toEqual([
      { tenant_id: TENANT_A, talent_id: RECORD_A },
      { tenant_id: TENANT_B, talent_id: RECORD_B },
    ]);
    expect(result.records).toHaveLength(2);
    expect(result.records[0]).toMatchObject({ talent_id: RECORD_A, tenant_id: TENANT_A });
    expect(result.records[1]).toMatchObject({ talent_id: RECORD_B, tenant_id: TENANT_B });
  });

  it('returns an EMPTY list (200, valid) when the chain resolves no records', async () => {
    const resolverCalls = { resolveRecords: [] as ResolveRecordsCall[], resolveMember: [] as ResolveMemberCall[] };
    const controller = new PortalController(
      makeResolver([], resolverCalls) as never,
      makeTalentRecordService('project', { profile: [] }) as never,
      makeConsentService({ consent: [] }) as never,
      makeTenantService() as never,
      makeTrustService() as never,
    );
    const result = await controller.getRecords(portalAuth(), 'req-1');
    expect(result).toEqual({ records: [] });
  });

  it('emits only PortalProfileDto fields per record (no Full/Match/R10-class leakage)', async () => {
    const controller = new PortalController(
      makeResolver([REF_A], { resolveRecords: [], resolveMember: [] }) as never,
      makeTalentRecordService('project', { profile: [] }) as never,
      makeConsentService({ consent: [] }) as never,
      makeTenantService() as never,
      makeTrustService() as never,
    );
    const result = await controller.getRecords(portalAuth(), 'req-1');
    expect(Object.keys(result)).toEqual(['records']);
    expect(result.records[0]).toEqual({
      talent_id: RECORD_A,
      tenant_id: TENANT_A,
      // Portal P2 P2b — the engagement counterparty is now NAMED (ruling 2).
      tenant_name: 'Acme Corp',
      tenant_status: 'active',
      source_channel: 'self_signup',
      created_at: '2026-05-01T12:00:00.000Z',
    });
    for (const f of FORBIDDEN) expect(result.records[0]).not.toHaveProperty(f);
    // §PR-2.4 — no trust/verification/attestation ORIGIN data on the surface.
    // (tenant_name is NOT here — P2b makes it a MUST on this engagement surface.)
    for (const f of TRUST_VOCAB_FORBIDDEN) expect(result.records[0]).not.toHaveProperty(f);
  });
});

describe('PortalController — GET /v1/portal/records/:id/profile', () => {
  it('returns one record profile for an id reachable through the chain', async () => {
    const profileCalls = { profile: [] as ProfileCall[] };
    const controller = new PortalController(
      makeResolver([REF_A], { resolveRecords: [], resolveMember: [] }) as never,
      makeTalentRecordService('project', profileCalls) as never,
      makeConsentService({ consent: [] }) as never,
      makeTenantService() as never,
      makeTrustService() as never,
    );
    const result = await controller.getRecordProfile(RECORD_A, portalAuth(), 'req-1');
    expect(profileCalls.profile).toEqual([{ tenant_id: TENANT_A, talent_id: RECORD_A }]);
    expect(result).toEqual({
      talent_id: RECORD_A,
      tenant_id: TENANT_A,
      tenant_name: 'Acme Corp',
      tenant_status: 'active',
      source_channel: 'self_signup',
      created_at: '2026-05-01T12:00:00.000Z',
    });
    for (const f of FORBIDDEN) expect(result).not.toHaveProperty(f);
  });

  it('returns a UNIFORM 404 for an unknown (well-formed, not-in-chain) id', async () => {
    const resolverCalls = { resolveRecords: [] as ResolveRecordsCall[], resolveMember: [] as ResolveMemberCall[] };
    const controller = new PortalController(
      makeResolver([REF_A], resolverCalls) as never,
      makeTalentRecordService('project', { profile: [] }) as never,
      makeConsentService({ consent: [] }) as never,
      makeTenantService() as never,
      makeTrustService() as never,
    );
    await expect(
      controller.getRecordProfile(UNKNOWN_RECORD, portalAuth(), 'req-1'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'record not found', statusCode: 404 });
    // Membership WAS consulted for a well-formed id.
    expect(resolverCalls.resolveMember).toEqual([{ portalUserId: PORTAL_SUB, recordId: UNKNOWN_RECORD }]);
  });

  it('returns the SAME uniform 404 for a malformed id — WITHOUT consulting membership (no format oracle)', async () => {
    const resolverCalls = { resolveRecords: [] as ResolveRecordsCall[], resolveMember: [] as ResolveMemberCall[] };
    const controller = new PortalController(
      makeResolver([REF_A], resolverCalls) as never,
      makeTalentRecordService('project', { profile: [] }) as never,
      makeConsentService({ consent: [] }) as never,
      makeTenantService() as never,
      makeTrustService() as never,
    );
    await expect(
      controller.getRecordProfile(MALFORMED_RECORD, portalAuth(), 'req-1'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'record not found', statusCode: 404 });
    // Malformed short-circuits: no membership probe → no unknown-vs-malformed oracle.
    expect(resolverCalls.resolveMember).toEqual([]);
  });

  it('returns 404 when the resolved record has vanished (findSelfProfile null)', async () => {
    const controller = new PortalController(
      makeResolver([REF_A], { resolveRecords: [], resolveMember: [] }) as never,
      makeTalentRecordService('null', { profile: [] }) as never,
      makeConsentService({ consent: [] }) as never,
      makeTenantService() as never,
      makeTrustService() as never,
    );
    await expect(
      controller.getRecordProfile(RECORD_A, portalAuth(), 'req-1'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'record not found', statusCode: 404 });
  });

  it('returns 403 for a non-portal consumer before any resolution', async () => {
    const resolverCalls = { resolveRecords: [] as ResolveRecordsCall[], resolveMember: [] as ResolveMemberCall[] };
    const controller = new PortalController(
      makeResolver([REF_A], resolverCalls) as never,
      makeTalentRecordService('project', { profile: [] }) as never,
      makeConsentService({ consent: [] }) as never,
      makeTenantService() as never,
      makeTrustService() as never,
    );
    await expect(
      controller.getRecordProfile(RECORD_A, portalAuth({ consumer_type: 'recruiter' }), 'req-1'),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403 });
    expect(resolverCalls.resolveMember).toEqual([]);
  });
});

describe('PortalController — GET /v1/portal/records/:id/consent', () => {
  it('scopes getState to the RECORD tenant (from the chain), not the portal session tenant', async () => {
    const consentCalls = { consent: [] as ConsentCall[] };
    const controller = new PortalController(
      makeResolver([REF_A], { resolveRecords: [], resolveMember: [] }) as never,
      makeTalentRecordService('project', { profile: [] }) as never,
      makeConsentService(consentCalls) as never,
      makeTenantService() as never,
      makeTrustService() as never,
    );
    const result = await controller.getRecordConsent(RECORD_A, portalAuth(), 'req-7');
    expect(consentCalls.consent).toHaveLength(1);
    expect(consentCalls.consent[0]?.talent_id).toBe(RECORD_A);
    expect(consentCalls.consent[0]?.requestId).toBe('req-7');
    // Record-tenant scoping: authContext handed to getState carries the record's
    // tenant (TENANT_A), NOT the portal session's platform sentinel.
    expect(consentCalls.consent[0]?.authContext.tenant_id).toBe(TENANT_A);
    expect(consentCalls.consent[0]?.authContext.tenant_id).not.toBe(PLATFORM_SENTINEL);
    expect(result).toEqual(sampleConsentState);
    for (const f of ['internal_reasoning', 'tier', 'rank_ordinal', 'score', 'examination_id']) {
      expect(result).not.toHaveProperty(f);
    }
  });

  it('returns the uniform 404 for an out-of-chain record — the only WHO surface is sub', async () => {
    const consentCalls = { consent: [] as ConsentCall[] };
    const controller = new PortalController(
      makeResolver([REF_A], { resolveRecords: [], resolveMember: [] }) as never,
      makeTalentRecordService('project', { profile: [] }) as never,
      makeConsentService(consentCalls) as never,
      makeTenantService() as never,
      makeTrustService() as never,
    );
    // A record id the caller does not hold resolves to nothing → uniform 404;
    // there is no surface to read another portal user's record.
    await expect(
      controller.getRecordConsent(UNKNOWN_RECORD, portalAuth(), 'req-1'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'record not found', statusCode: 404 });
    expect(consentCalls.consent).toEqual([]);
  });

  it('returns 400 INVALID_REQUEST when sub claim is not a UUID', async () => {
    const consentCalls = { consent: [] as ConsentCall[] };
    const controller = new PortalController(
      makeResolver([REF_A], { resolveRecords: [], resolveMember: [] }) as never,
      makeTalentRecordService('project', { profile: [] }) as never,
      makeConsentService(consentCalls) as never,
      makeTenantService() as never,
      makeTrustService() as never,
    );
    await expect(
      controller.getRecordConsent(RECORD_A, portalAuth({ sub: 'not-a-uuid' }), 'req-1'),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST', statusCode: 400 });
    expect(consentCalls.consent).toEqual([]);
  });

  it('returns 403 for a non-portal consumer', async () => {
    const consentCalls = { consent: [] as ConsentCall[] };
    const controller = new PortalController(
      makeResolver([REF_A], { resolveRecords: [], resolveMember: [] }) as never,
      makeTalentRecordService('project', { profile: [] }) as never,
      makeConsentService(consentCalls) as never,
      makeTenantService() as never,
      makeTrustService() as never,
    );
    await expect(
      controller.getRecordConsent(RECORD_A, portalAuth({ consumer_type: 'ingestion' }), 'req-1'),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403 });
    expect(consentCalls.consent).toEqual([]);
  });
});

describe('PortalController — GET /v1/portal/records/:id/consent/text (P2b)', () => {
  it('renders text named by the RECORD tenant (from the chain), for an in-chain id', async () => {
    const calls = { consent: [] as ConsentCall[], texts: [] as string[] };
    const controller = new PortalController(
      makeResolver([REF_A], { resolveRecords: [], resolveMember: [] }) as never,
      makeTalentRecordService('project', { profile: [] }) as never,
      makeConsentService(calls) as never,
      makeTenantService() as never,
      makeTrustService() as never,
    );
    const result = await controller.getRecordConsentText(RECORD_A, portalAuth(), 'req-1');
    // Recipient is the record's tenant, NOT the portal session sentinel.
    expect(calls.texts).toEqual([TENANT_A]);
    expect(result.version).toBe('portal-consent-v1');
  });

  it('returns the uniform 404 for an out-of-chain id (no text rendered)', async () => {
    const calls = { consent: [] as ConsentCall[], texts: [] as string[] };
    const controller = new PortalController(
      makeResolver([REF_A], { resolveRecords: [], resolveMember: [] }) as never,
      makeTalentRecordService('project', { profile: [] }) as never,
      makeConsentService(calls) as never,
      makeTenantService() as never,
      makeTrustService() as never,
    );
    await expect(
      controller.getRecordConsentText(UNKNOWN_RECORD, portalAuth(), 'req-1'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    expect(calls.texts).toEqual([]);
  });

  it('returns 403 for a non-portal consumer', async () => {
    const calls = { consent: [] as ConsentCall[], texts: [] as string[] };
    const controller = new PortalController(
      makeResolver([REF_A], { resolveRecords: [], resolveMember: [] }) as never,
      makeTalentRecordService('project', { profile: [] }) as never,
      makeConsentService(calls) as never,
      makeTenantService() as never,
      makeTrustService() as never,
    );
    await expect(
      controller.getRecordConsentText(RECORD_A, portalAuth({ consumer_type: 'recruiter' }), 'req-1'),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403 });
    expect(calls.texts).toEqual([]);
  });
});

describe('PortalController — GET /v1/portal/records/:id/consent/history (P2b)', () => {
  it('rescopes history to the RECORD tenant (from the chain) for an in-chain id', async () => {
    const calls = { consent: [] as ConsentCall[], history: [] as { talent_record_id: string; authTenant: string }[] };
    const controller = new PortalController(
      makeResolver([REF_A], { resolveRecords: [], resolveMember: [] }) as never,
      makeTalentRecordService('project', { profile: [] }) as never,
      makeConsentService(calls) as never,
      makeTenantService() as never,
      makeTrustService() as never,
    );
    const result = await controller.getRecordConsentHistory(
      RECORD_A, undefined, undefined, undefined, portalAuth(), 'req-9',
    );
    expect(calls.history).toEqual([{ talent_record_id: RECORD_A, authTenant: TENANT_A }]);
    expect(result).toEqual({ events: [], next_cursor: null, is_anonymized: false });
  });

  it('returns the uniform 404 for an out-of-chain id (no history read)', async () => {
    const calls = { consent: [] as ConsentCall[], history: [] as { talent_record_id: string; authTenant: string }[] };
    const controller = new PortalController(
      makeResolver([REF_A], { resolveRecords: [], resolveMember: [] }) as never,
      makeTalentRecordService('project', { profile: [] }) as never,
      makeConsentService(calls) as never,
      makeTenantService() as never,
      makeTrustService() as never,
    );
    await expect(
      controller.getRecordConsentHistory(
        UNKNOWN_RECORD, undefined, undefined, undefined, portalAuth(), 'req-1',
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    expect(calls.history).toEqual([]);
  });
});
