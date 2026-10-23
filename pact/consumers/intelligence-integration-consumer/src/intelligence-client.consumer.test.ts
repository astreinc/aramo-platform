import { resolve } from 'node:path';

import { MatchersV3, PactV4 } from '@pact-foundation/pact';
import {
  IntelligenceClient,
  IntelligenceRejectedError,
  type IntelligenceFetch,
  type IntelligenceIntegrationConfig,
} from '@aramo/intelligence-integration';
import type { TalentIngestRequest } from '@aramo/intelligence-contracts';
import { describe, expect, it } from 'vitest';

const { atLeastLike, boolean, eachLike, fromProviderState, integer, like, regex, uuid } = MatchersV3;

// ATI-SEP-1 §5 — Pact registration for the ATS → Talent Intelligence contract.
//
// Consumer:  intelligence-integration     (libs/intelligence-integration IntelligenceClient)
// Provider:  talent-intelligence-service  (apps/talent-intelligence-service)
//
// Every interaction is driven through the REAL IntelligenceClient. The client
// exchanges a client_credentials token before its first call; so that each API
// interaction stays independently verifiable, the injectable fetch answers the
// token exchange locally (placeholder bearer) and forwards every other request
// to the Pact mock server. The token exchange itself is its own interaction,
// recorded through the client with the follow-up API call answered locally.
// The provider verifier (pact/provider/src/verify-ti.ts) swaps the placeholder
// bearer for a real service token minted by the running service.
//
// Generated ids (assertions, proposals, disputes, verifications) are injected by
// the provider states (fromProviderState); tenant / talent ids are fixed below
// and MUST match pact/provider/src/verify-ti.ts.

const provider = new PactV4({
  consumer: 'intelligence-integration',
  provider: 'talent-intelligence-service',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

// ── fixtures (MUST match pact/provider/src/verify-ti.ts) ─────────────────────

const CLIENT_ID = 'pact-ats';
const CLIENT_SECRET = 'pact-intelligence-integration-client-secret-0001';
const SYS = 'ARAMO_ATS' as const;

const TENANT = {
  main: '7a100000-0000-7000-8000-000000000001',
  unentitled: '7a100000-0000-7000-8000-000000000002',
  sync: '7a100000-0000-7000-8000-000000000003',
  proposals: '7a100000-0000-7000-8000-000000000004',
  dismiss: '7a100000-0000-7000-8000-000000000005',
  act: '7a100000-0000-7000-8000-000000000006',
  contradiction: '7a100000-0000-7000-8000-000000000007',
  disputeOpen: '7a100000-0000-7000-8000-000000000008',
  disputeList: '7a100000-0000-7000-8000-000000000009',
  disputeGet: '7a100000-0000-7000-8000-00000000000a',
  disputeTriage: '7a100000-0000-7000-8000-00000000000b',
} as const;

const TALENT = {
  ingest: '7b100000-0000-7000-8000-000000000001',
  document: '7b100000-0000-7000-8000-000000000002',
  classC: '7b100000-0000-7000-8000-000000000003',
  erase: '7b100000-0000-7000-8000-000000000004',
  read: '7b100000-0000-7000-8000-000000000005',
  unentitled: '7b100000-0000-7000-8000-000000000006',
  unknown: '7b100000-0000-7000-8000-000000000007',
  verify: '7b100000-0000-7000-8000-000000000008',
  confirm: '7b100000-0000-7000-8000-000000000009',
  status: '7b100000-0000-7000-8000-00000000000a',
  proposals: '7b100000-0000-7000-8000-00000000000b',
  dismiss: '7b100000-0000-7000-8000-00000000000c',
  act: '7b100000-0000-7000-8000-00000000000d',
  contradiction: '7b100000-0000-7000-8000-00000000000e',
  disputeOpen: '7b100000-0000-7000-8000-00000000000f',
  disputeList: '7b100000-0000-7000-8000-000000000010',
  disputeGet: '7b100000-0000-7000-8000-000000000011',
  disputeTriage: '7b100000-0000-7000-8000-000000000012',
} as const;

const ACTOR = 'ats-user-1';
const OCCURRED_AT = '2026-10-20T10:00:00.000Z';
// Example values for provider-injected ids (the provider state returns the real ones).
const EX_ASSERTION_ID = '7c100000-0000-7000-8000-000000000001';
const EX_PROPOSAL_ID = '7c100000-0000-7000-8000-000000000002';
const EX_DISPUTE_ID = '7c100000-0000-7000-8000-000000000003';
const EX_VERIFICATION_ID = '7c100000-0000-7000-8000-000000000004';
const EX_SUBJECT_ID = '7c100000-0000-7000-8000-000000000005';
const EX_CODE = '123456';

const PLACEHOLDER_TOKEN = 'pact-placeholder-service-token';
const BEARER = regex('^Bearer .+$', `Bearer ${PLACEHOLDER_TOKEN}`);
const JSON_TYPE = 'application/json';
const ISO = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,9})?Z$';
const iso = (example = '2026-10-20T10:00:00.000Z') => regex(ISO, example);
const HEX64 = regex('^[a-f0-9]{64}$', 'a'.repeat(64));

const ref = (tenant: string, talent: string) => ({ source_system_id: SYS, source_tenant_id: tenant, external_talent_id: talent });
const referencePath = (tenant: string, talent: string) => `/v1/references/${SYS}/${tenant}/${talent}`;

// ── the client under test ────────────────────────────────────────────────────

function config(serviceUrl: string): IntelligenceIntegrationConfig {
  return {
    serviceUrl,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    configured: true,
    timeoutMs: 5000,
    verificationEnabled: false,
    entitlementSyncIntervalMs: 0,
    inboundSyncIntervalMs: 0,
  };
}

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': JSON_TYPE } });

/** A client whose token exchange is answered locally; every API call reaches the mock server. */
function apiClient(mockUrl: string): IntelligenceClient {
  const fetchImpl: IntelligenceFetch = async (input, init) => {
    if (new URL(input).pathname === '/v1/oauth/token') {
      return jsonResponse(200, { access_token: PLACEHOLDER_TOKEN, token_type: 'Bearer', expires_in: 300, scope: 'intelligence:read' });
    }
    return globalThis.fetch(input, init);
  };
  return new IntelligenceClient(config(mockUrl), fetchImpl);
}

async function rejection(p: Promise<unknown>): Promise<IntelligenceRejectedError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof IntelligenceRejectedError) return err;
    throw err;
  }
  throw new Error('expected an IntelligenceRejectedError');
}

// ── shared response shapes ───────────────────────────────────────────────────

const ingestBody = (talent: string, eventSuffix: string, email: string, extra: Record<string, unknown> = {}) => ({
  source_system_id: SYS,
  source_tenant_id: TENANT.main,
  external_talent_id: talent,
  source_event_id: `7d100000-0000-7000-8000-0000000000${eventSuffix}`,
  occurred_at: OCCURRED_AT,
  identity: { names: { first: 'Priya', last: 'Raman' }, emails: [{ value: email, is_primary: true }] },
  assertions: [
    { assertion_type: 'SKILL', payload: { name: 'TypeScript', years: 5 }, source_kind: 'RECRUITER', observed_at: OCCURRED_AT },
    { assertion_type: 'TITLE', payload: { value: 'Staff Engineer' }, source_kind: 'RECRUITER', observed_at: OCCURRED_AT },
  ],
  ...extra,
});

const verifyContactProposal = (talent: string, over: Record<string, unknown> = {}) => ({
  proposal_id: uuid(EX_PROPOSAL_ID),
  external_talent_ids: eachLike(talent),
  kind: 'VERIFY_CONTACT',
  trigger_kind: 'SINGLE_SOURCE_ONLY',
  status: 'OPEN',
  assertion_id: null,
  assertion_type: null,
  identifier_type: 'EMAIL',
  identifier_digest: HEX64,
  justification: null,
  action: null,
  created_at: iso(),
  acted_at: null,
  ...over,
});

const sla = {
  triage_due_at: iso(),
  summary_due_at: iso(),
  reinvestigation_due_at: iso(),
  reinvestigation_extended_at: null,
  ccpa_due_at: iso(),
  ccpa_extended_due_at: null,
};

const tenantDisputeSummary = (talent: string) => ({
  dispute_id: uuid(EX_DISPUTE_ID),
  external_talent_ids: eachLike(talent),
  assertion_id: uuid(EX_ASSERTION_ID),
  assertion_type: 'TITLE',
  contributed_by: 'REQUESTING_TENANT',
  status: 'OPEN',
  opened_at: iso(),
  updated_at: iso(),
  triage_due_at: iso(),
  reinvestigation_due_at: iso(),
});

const errorBody = (code: string) => ({ error: { code, message: like('refused') } });

// ── service auth ─────────────────────────────────────────────────────────────

describe('intelligence-integration → POST /v1/oauth/token', () => {
  it('exchanges the ATS client credentials for a bearer service token', async () => {
    await provider
      .addInteraction()
      .given('the ATS service client is provisioned')
      .uponReceiving('a client_credentials token exchange')
      .withRequest('POST', '/v1/oauth/token', (b) => {
        b.headers({ 'Content-Type': JSON_TYPE }).jsonBody({ grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          access_token: like('eyJhbGciOiJIUzI1NiJ9.pact.token'),
          token_type: 'Bearer',
          expires_in: integer(300),
          scope: like('intelligence:ingest intelligence:read'),
        });
      })
      .executeTest(async (mock) => {
        let bearer: string | undefined;
        const fetchImpl: IntelligenceFetch = async (input, init) => {
          if (new URL(input).pathname === '/v1/oauth/token') return globalThis.fetch(input, init);
          bearer = (init.headers as Record<string, string>)['authorization'];
          return jsonResponse(200, { applied: 0, deactivated: 0 });
        };
        const client = new IntelligenceClient(config(mock.url), fetchImpl);
        await client.syncEntitlements({ source_system_id: SYS, mode: 'UPSERT', tenants: [] });
        expect(bearer).toBe('Bearer eyJhbGciOiJIUzI1NiJ9.pact.token');
      });
  });
});

// ── ingestion ────────────────────────────────────────────────────────────────

describe('intelligence-integration → POST /v1/ingest/talent', () => {
  it('ingests a full talent snapshot (200, new subject)', async () => {
    const body = ingestBody(TALENT.ingest, '01', 'pact.ingest@example.com');
    await provider
      .addInteraction()
      .given('no reference exists for the talent', { tenant_id: TENANT.main, talent_id: TALENT.ingest })
      .uponReceiving('a talent snapshot ingest')
      .withRequest('POST', '/v1/ingest/talent', (b) => {
        b.headers({ Authorization: BEARER, 'Content-Type': JSON_TYPE }).jsonBody(body);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          intelligence_subject_id: uuid(EX_SUBJECT_ID),
          outcome: 'CREATED',
          resolution: 'NEW_PROVISIONAL',
          changed: true,
          assertions_added: integer(3),
          assertions_superseded: integer(0),
          conflicts_opened: integer(0),
          replayed: false,
        });
      })
      .executeTest(async (mock) => {
        const res = await apiClient(mock.url).ingestTalent(body as TalentIngestRequest);
        expect(res).toMatchObject({ outcome: 'CREATED', replayed: false });
      });
  });

  it('refuses a snapshot that carries a document (400 DOCUMENT_REJECTED)', async () => {
    const body = ingestBody(TALENT.document, '02', 'pact.document@example.com', { attachments: [{ storage_key: 'uploads/resume-1' }] });
    await provider
      .addInteraction()
      .given('the ATS service client is provisioned')
      .uponReceiving('a talent snapshot carrying a document field')
      .withRequest('POST', '/v1/ingest/talent', (b) => {
        b.headers({ Authorization: BEARER, 'Content-Type': JSON_TYPE }).jsonBody(body);
      })
      .willRespondWith(400, (b) => {
        b.jsonBody(errorBody('DOCUMENT_REJECTED'));
      })
      .executeTest(async (mock) => {
        const err = await rejection(apiClient(mock.url).ingestTalent(body as unknown as TalentIngestRequest));
        expect([err.status, err.code]).toEqual([400, 'DOCUMENT_REJECTED']);
      });
  });

  it('refuses a snapshot that carries a Class C field (400 CLASS_C_REJECTED)', async () => {
    const body = ingestBody(TALENT.classC, '03', 'pact.classc@example.com', { notes: 'Prefers remote work.' });
    await provider
      .addInteraction()
      .given('the ATS service client is provisioned')
      .uponReceiving('a talent snapshot carrying a Class C field')
      .withRequest('POST', '/v1/ingest/talent', (b) => {
        b.headers({ Authorization: BEARER, 'Content-Type': JSON_TYPE }).jsonBody(body);
      })
      .willRespondWith(400, (b) => {
        b.jsonBody(errorBody('CLASS_C_REJECTED'));
      })
      .executeTest(async (mock) => {
        const err = await rejection(apiClient(mock.url).ingestTalent(body as unknown as TalentIngestRequest));
        expect([err.status, err.code]).toEqual([400, 'CLASS_C_REJECTED']);
      });
  });
});

describe('intelligence-integration → POST /v1/ingest/talent/erased', () => {
  it('erases a source reference (200 ERASED)', async () => {
    const body = { source_system_id: SYS, source_tenant_id: TENANT.main, external_talent_id: TALENT.erase, source_event_id: '7d100000-0000-7000-8000-000000000004', occurred_at: OCCURRED_AT };
    await provider
      .addInteraction()
      .given('a reference exists for the talent', { tenant_id: TENANT.main, talent_id: TALENT.erase })
      .uponReceiving('a talent erasure')
      .withRequest('POST', '/v1/ingest/talent/erased', (b) => {
        b.headers({ Authorization: BEARER, 'Content-Type': JSON_TYPE }).jsonBody(body);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ outcome: 'ERASED', intelligence_subject_id: uuid(EX_SUBJECT_ID), subject_access_state: like('AUDIT_RETAINED'), replayed: false });
      })
      .executeTest(async (mock) => {
        const res = await apiClient(mock.url).ingestErased(body);
        expect(res.outcome).toBe('ERASED');
      });
  });
});

// ── entitlements ─────────────────────────────────────────────────────────────

describe('intelligence-integration → POST /v1/entitlements/sync', () => {
  it('upserts the tenants holding the intelligence capability', async () => {
    const body = { source_system_id: SYS, mode: 'UPSERT' as const, tenants: [{ tenant_id: TENANT.sync, active: true }] };
    await provider
      .addInteraction()
      .given('the ATS service client is provisioned')
      .uponReceiving('an entitlement upsert sync')
      .withRequest('POST', '/v1/entitlements/sync', (b) => {
        b.headers({ Authorization: BEARER, 'Content-Type': JSON_TYPE }).jsonBody(body);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ applied: integer(1), deactivated: integer(0) });
      })
      .executeTest(async (mock) => {
        expect(await apiClient(mock.url).syncEntitlements(body)).toEqual({ applied: 1, deactivated: 0 });
      });
  });
});

// ── read API ─────────────────────────────────────────────────────────────────

describe('intelligence-integration → GET /v1/references/…/profile', () => {
  it('reads the tenant-scoped profile of a reference (200)', async () => {
    await provider
      .addInteraction()
      .given('an entitled tenant holds a reference with evidence', { tenant_id: TENANT.main, talent_id: TALENT.read })
      .uponReceiving('a profile read')
      .withRequest('GET', `${referencePath(TENANT.main, TALENT.read)}/profile`, (b) => {
        b.headers({ Authorization: BEARER });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          intelligence_subject_id: uuid(EX_SUBJECT_ID),
          access_mode: 'TENANT_SCOPED',
          facts: eachLike({
            fact_type: like('SKILL'),
            fact_key: like('typescript'),
            value: like({}),
            state: like('RESOLVED'),
            verification_status: like('DECLARED'),
            corroborating_sources: integer(1),
            // Identifier facts (EMAIL / PHONE) carry no supporting assertion.
            supporting_assertion_ids: atLeastLike(uuid(EX_ASSERTION_ID), 0, 1),
          }),
          trust: {
            identity_band: like('SELF_ASSERTED'),
            claims_band: like('SELF_ASSERTED'),
            continuity_band: like('SELF_ASSERTED'),
            eligibility_band: like('NOT_ESTABLISHED'),
            open_contradiction_count: integer(0),
            stale_assertion_count: integer(0),
            has_open_dispute: boolean(false),
            single_source_only: boolean(true),
            verification_stale: boolean(false),
          },
          generated_at: iso(),
        });
      })
      .executeTest(async (mock) => {
        const res = await apiClient(mock.url).readProfile({ tenant_id: TENANT.main, talent_id: TALENT.read });
        expect(res.access_mode).toBe('TENANT_SCOPED');
        expect(res.facts.length).toBeGreaterThan(0);
      });
  });

  it('refuses a tenant without the intelligence entitlement (403 NOT_ENTITLED)', async () => {
    await provider
      .addInteraction()
      .given('a tenant without the intelligence entitlement holds a reference', { tenant_id: TENANT.unentitled, talent_id: TALENT.unentitled })
      .uponReceiving('a profile read by an unentitled tenant')
      .withRequest('GET', `${referencePath(TENANT.unentitled, TALENT.unentitled)}/profile`, (b) => {
        b.headers({ Authorization: BEARER });
      })
      .willRespondWith(403, (b) => {
        b.jsonBody(errorBody('NOT_ENTITLED'));
      })
      .executeTest(async (mock) => {
        const err = await rejection(apiClient(mock.url).readProfile({ tenant_id: TENANT.unentitled, talent_id: TALENT.unentitled }));
        expect([err.status, err.code]).toEqual([403, 'NOT_ENTITLED']);
      });
  });

  it('answers 404 REFERENCE_NOT_FOUND for a reference Talent Intelligence does not hold', async () => {
    await provider
      .addInteraction()
      .given('an entitled tenant without the reference', { tenant_id: TENANT.main, talent_id: TALENT.unknown })
      .uponReceiving('a profile read of an unknown reference')
      .withRequest('GET', `${referencePath(TENANT.main, TALENT.unknown)}/profile`, (b) => {
        b.headers({ Authorization: BEARER });
      })
      .willRespondWith(404, (b) => {
        b.jsonBody(errorBody('REFERENCE_NOT_FOUND'));
      })
      .executeTest(async (mock) => {
        const err = await rejection(apiClient(mock.url).readProfile({ tenant_id: TENANT.main, talent_id: TALENT.unknown }));
        expect([err.status, err.code]).toEqual([404, 'REFERENCE_NOT_FOUND']);
      });
  });
});

describe('intelligence-integration → GET /v1/references/…/evidence', () => {
  it('reads the tenant-view evidence behind the profile (200)', async () => {
    await provider
      .addInteraction()
      .given('an entitled tenant holds a reference with evidence', { tenant_id: TENANT.main, talent_id: TALENT.read })
      .uponReceiving('an evidence read')
      .withRequest('GET', `${referencePath(TENANT.main, TALENT.read)}/evidence`, (b) => {
        b.headers({ Authorization: BEARER });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          intelligence_subject_id: uuid(EX_SUBJECT_ID),
          access_mode: 'TENANT_SCOPED',
          assertions: eachLike({
            assertion_id: uuid(EX_ASSERTION_ID),
            assertion_type: like('SKILL'),
            admission_class: like('A'),
            payload: like({}),
            contributed_by: 'REQUESTING_TENANT',
            source_kind: like('RECRUITER'),
            verification_status: like('DECLARED'),
            status: like('VALID'),
            observed_at: iso(),
            valid_from: null,
            valid_to: null,
            ai_derived: false,
            source_document_hash: null,
            history: eachLike({ event_type: like('CREATED'), from_status: null, to_status: like('VALID'), at: iso() }),
          }),
          generated_at: iso(),
        });
      })
      .executeTest(async (mock) => {
        const res = await apiClient(mock.url).readEvidence({ tenant_id: TENANT.main, talent_id: TALENT.read });
        expect(res.assertions.length).toBeGreaterThan(0);
      });
  });
});

// ── verification ─────────────────────────────────────────────────────────────

describe('intelligence-integration → POST /v1/verifications', () => {
  it('starts an email one-time-code verification for a reference (201)', async () => {
    const body = { source_reference: ref(TENANT.main, TALENT.verify), identifier_type: 'EMAIL' as const, value: 'pact.verify@example.com' };
    await provider
      .addInteraction()
      .given('a reference exists for the talent', { tenant_id: TENANT.main, talent_id: TALENT.verify })
      .uponReceiving('a verification request')
      .withRequest('POST', '/v1/verifications', (b) => {
        b.headers({ Authorization: BEARER, 'Content-Type': JSON_TYPE }).jsonBody(body);
      })
      .willRespondWith(201, (b) => {
        b.jsonBody({ verification_id: uuid(EX_VERIFICATION_ID), channel: 'EMAIL', status: 'PENDING', expires_at: iso(), delivery: 'QUEUED' });
      })
      .executeTest(async (mock) => {
        const res = await apiClient(mock.url).requestVerification(body);
        expect(res).toMatchObject({ status: 'PENDING', delivery: 'QUEUED' });
      });
  });

  it('confirms a pending verification with its code (200 BOUND)', async () => {
    await provider
      .addInteraction()
      .given('a pending email verification exists', { tenant_id: TENANT.main, talent_id: TALENT.confirm })
      .uponReceiving('a verification confirmation')
      .withRequest('POST', fromProviderState('/v1/verifications/${verificationId}/confirm', `/v1/verifications/${EX_VERIFICATION_ID}/confirm`), (b) => {
        b.headers({ Authorization: BEARER, 'Content-Type': JSON_TYPE }).jsonBody({ code: fromProviderState('${code}', EX_CODE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ verification_id: uuid(EX_VERIFICATION_ID), status: 'CONFIRMED', outcome: 'BOUND' });
      })
      .executeTest(async (mock) => {
        const res = await apiClient(mock.url).confirmVerification(EX_VERIFICATION_ID, EX_CODE);
        expect(res).toMatchObject({ status: 'CONFIRMED', outcome: 'BOUND' });
      });
  });

  it('lists the verification status of a reference’s contacts (200)', async () => {
    await provider
      .addInteraction()
      .given('a reference with a verified email exists', { tenant_id: TENANT.main, talent_id: TALENT.status })
      .uponReceiving('a reference verification-status read')
      .withRequest('GET', `${referencePath(TENANT.main, TALENT.status)}/verifications`, (b) => {
        b.headers({ Authorization: BEARER });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ items: eachLike({ identifier_type: 'EMAIL', value_masked: like('p***@example.com'), status: 'VERIFIED', expires_at: iso() }) });
      })
      .executeTest(async (mock) => {
        const res = await apiClient(mock.url).listReferenceVerifications({ tenant_id: TENANT.main, talent_id: TALENT.status });
        expect(res.items[0]?.status).toBe('VERIFIED');
      });
  });
});

// ── proposals + contradiction resolution ─────────────────────────────────────

describe('intelligence-integration → trust proposals', () => {
  it('lists the open verify-contact proposals of a tenant (200)', async () => {
    await provider
      .addInteraction()
      .given('an open verify-contact proposal exists', { tenant_id: TENANT.proposals, talent_id: TALENT.proposals })
      .uponReceiving('a proposal worklist read')
      .withRequest('GET', `/v1/tenants/${TENANT.proposals}/proposals`, (b) => {
        b.headers({ Authorization: BEARER }).query({ kind: 'VERIFY_CONTACT' });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ items: eachLike(verifyContactProposal(TALENT.proposals)), next_cursor: null });
      })
      .executeTest(async (mock) => {
        const res = await apiClient(mock.url).listProposals(TENANT.proposals, { kind: 'VERIFY_CONTACT' });
        expect(res.items[0]?.kind).toBe('VERIFY_CONTACT');
      });
  });

  it('dismisses an open proposal with a justification (200 DISMISSED)', async () => {
    await provider
      .addInteraction()
      .given('an open verify-contact proposal exists', { tenant_id: TENANT.dismiss, talent_id: TALENT.dismiss })
      .uponReceiving('a proposal dismissal')
      .withRequest('POST', fromProviderState('/v1/proposals/${proposalId}/dismiss', `/v1/proposals/${EX_PROPOSAL_ID}/dismiss`), (b) => {
        b.headers({ Authorization: BEARER, 'Content-Type': JSON_TYPE }).jsonBody({ source_tenant_id: TENANT.dismiss, actor: ACTOR, justification: 'Contact confirmed by phone.' });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(verifyContactProposal(TALENT.dismiss, { status: 'DISMISSED', justification: 'Contact confirmed by phone.', acted_at: iso() }));
      })
      .executeTest(async (mock) => {
        const res = await apiClient(mock.url).dismissProposal(EX_PROPOSAL_ID, { tenant_id: TENANT.dismiss, actor: ACTOR, justification: 'Contact confirmed by phone.' });
        expect(res.status).toBe('DISMISSED');
      });
  });

  it('records the action taken on an open proposal (200 ACTED)', async () => {
    await provider
      .addInteraction()
      .given('an open verify-contact proposal exists', { tenant_id: TENANT.act, talent_id: TALENT.act })
      .uponReceiving('a proposal action record')
      .withRequest('POST', fromProviderState('/v1/proposals/${proposalId}/act', `/v1/proposals/${EX_PROPOSAL_ID}/act`), (b) => {
        b.headers({ Authorization: BEARER, 'Content-Type': JSON_TYPE }).jsonBody({ source_tenant_id: TENANT.act, actor: ACTOR, action: 'VERIFICATION_REQUESTED' });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(verifyContactProposal(TALENT.act, { status: 'ACTED', action: 'VERIFICATION_REQUESTED', acted_at: iso() }));
      })
      .executeTest(async (mock) => {
        const res = await apiClient(mock.url).actOnProposal(EX_PROPOSAL_ID, { tenant_id: TENANT.act, actor: ACTOR, action: 'VERIFICATION_REQUESTED' });
        expect(res.status).toBe('ACTED');
      });
  });

  it('resolves a contradiction in the tenant view, keeping the assertion (200)', async () => {
    const reason = 'Both roles were held at the same time.';
    await provider
      .addInteraction()
      .given('a contradicted assertion exists on the reference', { tenant_id: TENANT.contradiction, talent_id: TALENT.contradiction })
      .uponReceiving('a contradiction resolution')
      .withRequest(
        'POST',
        fromProviderState(
          `${referencePath(TENANT.contradiction, TALENT.contradiction)}/assertions/\${assertionId}/contradiction-resolution`,
          `${referencePath(TENANT.contradiction, TALENT.contradiction)}/assertions/${EX_ASSERTION_ID}/contradiction-resolution`,
        ),
        (b) => {
          b.headers({ Authorization: BEARER, 'Content-Type': JSON_TYPE }).jsonBody({ resolution: 'KEEP', reason, actor: ACTOR });
        },
      )
      .willRespondWith(200, (b) => {
        b.jsonBody({ assertion_id: uuid(EX_ASSERTION_ID), resolution: 'KEEP', status: 'VALID', reconciled_with: eachLike(uuid(EX_ASSERTION_ID)) });
      })
      .executeTest(async (mock) => {
        const res = await apiClient(mock.url).resolveContradiction(
          { tenant_id: TENANT.contradiction, talent_id: TALENT.contradiction, assertion_id: EX_ASSERTION_ID },
          { resolution: 'KEEP', reason, actor: ACTOR },
        );
        expect(res).toMatchObject({ resolution: 'KEEP', status: 'VALID' });
      });
  });
});

// ── disputes ─────────────────────────────────────────────────────────────────

describe('intelligence-integration → talent disputes', () => {
  it('opens a dispute of one assertion through the talent’s own reference (201)', async () => {
    const statement = 'This title is not mine.';
    await provider
      .addInteraction()
      .given('a disputable assertion exists on the reference', { tenant_id: TENANT.disputeOpen, talent_id: TALENT.disputeOpen })
      .uponReceiving('a dispute opening')
      .withRequest('POST', '/v1/disputes', (b) => {
        b.headers({ Authorization: BEARER, 'Content-Type': JSON_TYPE }).jsonBody({
          portal_context: ref(TENANT.disputeOpen, TALENT.disputeOpen),
          assertion_id: fromProviderState('${assertionId}', EX_ASSERTION_ID),
          statement,
        });
      })
      .willRespondWith(201, (b) => {
        b.jsonBody({
          dispute_id: uuid(EX_DISPUTE_ID),
          assertion_id: uuid(EX_ASSERTION_ID),
          assertion_type: 'TITLE',
          status: 'OPEN',
          opened_at: iso(),
          updated_at: iso(),
          resolution_note: null,
          sla,
          statements: eachLike({ author: 'TALENT', statement: like(statement), created_at: iso() }),
        });
      })
      .executeTest(async (mock) => {
        const res = await apiClient(mock.url).openDispute({ tenant_id: TENANT.disputeOpen, talent_id: TALENT.disputeOpen, assertion_id: EX_ASSERTION_ID, statement });
        expect(res.status).toBe('OPEN');
      });
  });

  it('lists the open disputes of a tenant (200)', async () => {
    await provider
      .addInteraction()
      .given('an open dispute exists', { tenant_id: TENANT.disputeList, talent_id: TALENT.disputeList })
      .uponReceiving('a tenant dispute worklist read')
      .withRequest('GET', `/v1/tenants/${TENANT.disputeList}/disputes`, (b) => {
        b.headers({ Authorization: BEARER });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ items: eachLike(tenantDisputeSummary(TALENT.disputeList)), next_cursor: null });
      })
      .executeTest(async (mock) => {
        const res = await apiClient(mock.url).listTenantDisputes(TENANT.disputeList);
        expect(res.items[0]?.status).toBe('OPEN');
      });
  });

  it('reads one dispute in the tenant view (200)', async () => {
    await provider
      .addInteraction()
      .given('an open dispute exists', { tenant_id: TENANT.disputeGet, talent_id: TALENT.disputeGet })
      .uponReceiving('a tenant dispute detail read')
      .withRequest('GET', fromProviderState(`/v1/tenants/${TENANT.disputeGet}/disputes/\${disputeId}`, `/v1/tenants/${TENANT.disputeGet}/disputes/${EX_DISPUTE_ID}`), (b) => {
        b.headers({ Authorization: BEARER });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          ...tenantDisputeSummary(TALENT.disputeGet),
          assertion_status: like('VALID'),
          assertion_payload: like({ value: 'Staff Engineer' }),
          resolution_note: null,
          no_transition_reason: null,
          sla,
          statements: eachLike({ author: 'TALENT', statement: like('This title is not mine.'), created_at: iso() }),
        });
      })
      .executeTest(async (mock) => {
        const res = await apiClient(mock.url).getTenantDispute(TENANT.disputeGet, EX_DISPUTE_ID);
        expect(res.status).toBe('OPEN');
      });
  });

  it('triages an open dispute (200 UNDER_REVIEW)', async () => {
    await provider
      .addInteraction()
      .given('an open dispute exists', { tenant_id: TENANT.disputeTriage, talent_id: TALENT.disputeTriage })
      .uponReceiving('a dispute triage')
      .withRequest('POST', fromProviderState('/v1/disputes/${disputeId}/triage', `/v1/disputes/${EX_DISPUTE_ID}/triage`), (b) => {
        b.headers({ Authorization: BEARER, 'Content-Type': JSON_TYPE }).jsonBody({ source_tenant_id: TENANT.disputeTriage, actor: ACTOR });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ dispute_id: uuid(EX_DISPUTE_ID), status: 'UNDER_REVIEW' });
      })
      .executeTest(async (mock) => {
        const res = await apiClient(mock.url).triageDispute(EX_DISPUTE_ID, { tenant_id: TENANT.disputeTriage, actor: ACTOR });
        expect(res.status).toBe('UNDER_REVIEW');
      });
  });
});
