import { readFileSync } from 'node:fs';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import type { AramoEventEnvelope } from '@aramo/events';
import { isClassCKey, signIntelligenceWebhook, validateTalentIngestRequest } from '@aramo/intelligence-contracts';
import {
  IntelligenceClient,
  IntelligenceEntitlementSyncService,
  IntelligenceInboundSyncService,
  IntelligencePublisherHandler,
  IntelligenceWebhookReceiver,
  loadIntelligenceConfig,
  type IntelligenceFetch,
} from '@aramo/intelligence-integration';
import { PrismaService as EvidencePrismaService, TalentEvidenceRepository } from '@aramo/talent-evidence';
import {
  TalentIntelligenceRepository,
  TalentRecordPrismaService,
  TalentRecordReconcileRepository,
  TalentRecordRepository,
  type TalentEventPayload,
} from '@aramo/talent-record';

import { AtsTalentEventDispatcher } from '../ats-talent-events/ats-talent-event-dispatcher.js';

import { collectIntelligenceIntegrationMigrations, splitDdl } from './support/intelligence-integration-migrations.js';

// ATI-SEP-1 T8 / T9 — the ATS side of the Talent Intelligence integration against
// a REAL Postgres 17 with the documents + talent_evidence + talent_record +
// entitlement migrations. Talent Intelligence itself is a FAKE fetch (the ATS
// reaches TI over HTTP only — the A7 wall): nothing from scope:intelligence is
// loaded here.
//
//   * T9 — the `intelligence` capability exists and is OFF for every tenant;
//   * an ATS create with INTELLIGENCE_SERVICE_URL unset succeeds and its
//     talent.created publishes as a no-op (TI_NOT_CONFIGURED);
//   * entitled → the admission payload is validator-clean with no Class C value;
//     TI 503 → the dispatcher reports the event failed (the drain retries);
//   * the HMAC webhook receiver records into the real inbox, idempotently;
//   * the inbound sync policy matrix on the real field-state / provenance /
//     contradiction tables (recruiter-confirmed never overwritten, REVIEW
//     creates a contradiction, AUTO_APPLY fills an empty field) — and an
//     INTELLIGENCE-sourced value is never echoed back to TI.


const TENANT = '11111111-1111-7111-8111-111111111111';
const ACTOR = '33333333-3333-7333-8333-333333333333';
const SUBJECT = '55555555-5555-7555-8555-555555555555';
const WEBHOOK_SECRET = 'w'.repeat(40);
const TI_ENV = {
  INTELLIGENCE_SERVICE_URL: 'http://ti.test:3004',
  INTELLIGENCE_ATS_CLIENT_ID: 'aramo-ats',
  INTELLIGENCE_ATS_CLIENT_SECRET: 's'.repeat(40),
};

const CLASS_C_INPUT = {
  notes: 'SENTINEL-NOTES',
  current_pay: 'SENTINEL-PAY',
  desired_pay: 'SENTINEL-DESIRED',
  source: 'SENTINEL-SOURCE',
  is_hot: true,
  address: 'SENTINEL-ADDRESS',
  address2: 'SENTINEL-ADDRESS2',
  zip: '90210',
  best_time_to_call: 'SENTINEL-BTTC',
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A fake Talent Intelligence HTTP surface. */
function fakeTi(opts: { ingestStatus?: number; profile?: unknown } = {}) {
  const ingested: unknown[] = [];
  const fetchImpl = vi.fn<IntelligenceFetch>(async (url, init) => {
    if (url.endsWith('/v1/oauth/token')) return json(200, { access_token: 'tok', token_type: 'Bearer', expires_in: 900, scope: 'x' });
    if (url.endsWith('/v1/entitlements/sync')) return json(200, { applied: 1, deactivated: 0 });
    if (url.endsWith('/v1/ingest/talent')) {
      if ((opts.ingestStatus ?? 200) !== 200) return json(opts.ingestStatus as number, {});
      ingested.push(JSON.parse(String(init.body)));
      return json(200, { intelligence_subject_id: SUBJECT, outcome: 'CREATED', resolution: 'NEW_PROVISIONAL', changed: true, assertions_added: 1, assertions_superseded: 0, conflicts_opened: 0, replayed: false });
    }
    if (url.includes('/v1/references/ARAMO_ATS/')) return json(200, opts.profile ?? { intelligence_subject_id: SUBJECT, access_mode: 'TENANT_SCOPED', facts: [], trust: {}, generated_at: new Date().toISOString() });
    return json(404, { error: { code: 'NOT_FOUND', message: url } });
  });
  return { fetchImpl, ingested };
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('ATI-SEP-1 T8/T9 — ATS ↔ Talent Intelligence integration (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let recordPrisma: TalentRecordPrismaService;
  let evidencePrisma: EvidencePrismaService;
  let records: TalentRecordRepository;
  let tiRepo: TalentIntelligenceRepository;
  let reconcile: TalentRecordReconcileRepository;
  let evidence: TalentEvidenceRepository;
  let entitlements: { getCapabilities(t: string): Promise<Set<string>>; listTenantIdsWithCapability(c: string): Promise<string[]> };

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    const setup = new EvidencePrismaService(url);
    await setup.$connect();
    for (const path of collectIntelligenceIntegrationMigrations()) {
      for (const stmt of splitDdl(readFileSync(path, 'utf8'))) await setup.$executeRawUnsafe(stmt);
    }
    await setup.$disconnect();
    evidencePrisma = new EvidencePrismaService(url);
    await evidencePrisma.$connect();
    recordPrisma = new TalentRecordPrismaService(url);
    await recordPrisma.$connect();
    records = new TalentRecordRepository(recordPrisma);
    tiRepo = new TalentIntelligenceRepository(recordPrisma);
    reconcile = new TalentRecordReconcileRepository(recordPrisma);
    evidence = new TalentEvidenceRepository(evidencePrisma);
    // The entitlement read through the REAL entitlement schema (enum + table from its migrations).
    entitlements = {
      getCapabilities: async (t) =>
        new Set(
          (await recordPrisma.$queryRawUnsafe<Array<{ c: string }>>(`SELECT capability::text AS c FROM "entitlement"."TenantEntitlement" WHERE tenant_id = $1::uuid`, t)).map((r) => r.c),
        ),
      listTenantIdsWithCapability: async (c) =>
        (await recordPrisma.$queryRawUnsafe<Array<{ t: string }>>(`SELECT tenant_id::text AS t FROM "entitlement"."TenantEntitlement" WHERE capability::text = $1`, c)).map((r) => r.t),
    };
  }, 240_000);

  afterAll(async () => {
    await recordPrisma?.$disconnect();
    await evidencePrisma?.$disconnect();
    await container?.stop();
  });

  beforeEach(async () => {
    await recordPrisma.$executeRawUnsafe(
      `TRUNCATE "talent_record"."TalentEventOutbox", "talent_record"."talent_intelligence_inbound_event",
                "talent_record"."talent_intelligence_sync_policy", "talent_record"."TalentRecord" CASCADE`,
    );
    await recordPrisma.$executeRawUnsafe(`TRUNCATE "entitlement"."TenantEntitlement"`);
    await evidencePrisma.$executeRawUnsafe(`TRUNCATE "talent_evidence"."TalentSkillEvidence", "talent_evidence"."TalentEducationEntry" CASCADE`);
  });

  async function grant(...caps: string[]): Promise<void> {
    for (const c of caps) {
      await recordPrisma.$executeRawUnsafe(`INSERT INTO "entitlement"."TenantEntitlement" (tenant_id, capability, granted_source) VALUES ($1::uuid, $2::"entitlement"."Capability", 'PROVISIONING')`, TENANT, c);
    }
  }

  async function createTalent(over: Record<string, unknown> = {}): Promise<{ id: string; event: AramoEventEnvelope<TalentEventPayload> }> {
    const view = await records.create({
      tenant_id: TENANT,
      entered_by_id: ACTOR,
      input: { first_name: 'Ada', last_name: 'Lovelace', email1: `ada+${Math.random().toString(36).slice(2)}@example.com`, phone_cell: '(555) 123-0000', city: 'Austin', state: 'TX', ...CLASS_C_INPUT, ...over } as never,
    });
    const row = await recordPrisma.talentEventOutbox.findFirstOrThrow({ where: { subject_id: view.id, event_type: 'talent.created' } });
    return {
      id: view.id,
      event: {
        event_id: row.id,
        event_type: row.event_type,
        event_version: row.event_version,
        tenant_id: row.tenant_id,
        source: row.source,
        subject_type: row.subject_type,
        subject_id: row.subject_id,
        occurred_at: row.created_at.toISOString(),
        correlation_id: row.correlation_id ?? row.id,
        causation_id: row.causation_id,
        payload: row.event_payload as unknown as TalentEventPayload,
      },
    };
  }

  function publisher(env: NodeJS.ProcessEnv, fetchImpl?: IntelligenceFetch) {
    const client = new IntelligenceClient(loadIntelligenceConfig(env), fetchImpl);
    const sync = new IntelligenceEntitlementSyncService(client, entitlements as never);
    return new IntelligencePublisherHandler(client, entitlements as never, sync, tiRepo, evidence);
  }

  it('T9 — the `intelligence` capability exists in the enum and NO tenant holds it by default', async () => {
    const labels = await recordPrisma.$queryRawUnsafe<Array<{ l: string }>>(
      `SELECT e.enumlabel AS l FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'entitlement' AND t.typname = 'Capability'`,
    );
    expect(labels.map((r) => r.l)).toContain('intelligence');
    await createTalent();
    expect(await entitlements.listTenantIdsWithCapability('intelligence')).toEqual([]);
  });

  it('ATS create works with INTELLIGENCE_SERVICE_URL unset; talent.created publishes as a no-op (TI_NOT_CONFIGURED)', async () => {
    await grant('core', 'ats', 'intelligence');
    const fetchImpl = vi.fn<IntelligenceFetch>();
    const { id, event } = await createTalent();
    expect(await recordPrisma.talentRecord.count({ where: { id } })).toBe(1);
    await expect(publisher({}, fetchImpl).publish(event)).resolves.toBe('TI_NOT_CONFIGURED');
    expect(fetchImpl).not.toHaveBeenCalled();
    // The dispatcher acknowledges it: the outbox row would be marked published.
    const dispatcher = new AtsTalentEventDispatcher([publisher({}, fetchImpl)], { warn: vi.fn() } as never);
    await expect(dispatcher.publish([event])).resolves.toEqual({ published_event_ids: [event.event_id], failed_event_ids: [] });
  });

  it('configured but the tenant is not entitled → NOT_ENTITLED, nothing sent', async () => {
    await grant('core', 'ats', 'portal');
    const ti = fakeTi();
    const { event } = await createTalent();
    await expect(publisher(TI_ENV, ti.fetchImpl).publish(event)).resolves.toBe('NOT_ENTITLED');
    expect(ti.fetchImpl).not.toHaveBeenCalled();
  });

  it('entitled → a validator-clean snapshot with NO Class C value is ingested; intelligence_link written', async () => {
    await grant('core', 'ats', 'intelligence');
    const ti = fakeTi();
    const { id, event } = await createTalent({ title: 'Principal Engineer', current_employer: 'Acme', web_site: 'https://ada.example.com/' });
    await evidencePrisma.talentSkillEvidence.create({
      data: { id: '0190cccc-0000-7000-8000-000000000001', talent_id: id, tenant_id: TENANT, skill_id: '0190cccc-0000-7000-8000-0000000000aa', surface_form: 'SQL', source: 'declared', evidence_text: 'SENTINEL-EVIDENCE', source_refs: ['SENTINEL-REF'], created_at: new Date() },
    });
    await expect(publisher(TI_ENV, ti.fetchImpl).publish(event)).resolves.toBe('INGESTED');
    expect(ti.ingested).toHaveLength(1);
    const body = ti.ingested[0] as Record<string, unknown>;
    expect(validateTalentIngestRequest(body).ok).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/SENTINEL|90210/);
    const keys = JSON.stringify(body).match(/"([a-z_0-9]+)":/g)?.map((k) => k.slice(1, -2)) ?? [];
    expect(keys.filter((k) => !['source_kind', 'source_system_id', 'source_tenant_id', 'source_event_id', 'source_document_hash', 'url'].includes(k) && isClassCKey(k))).toEqual([]);
    expect(body['source_event_id']).toBe(event.event_id);
    expect(await tiRepo.findLink({ tenant_id: TENANT, talent_record_id: id })).toMatchObject({ intelligence_subject_id: SUBJECT });
    // The entitlement was upserted to TI before the first ingest.
    expect(ti.fetchImpl.mock.calls.some(([u]) => u.endsWith('/v1/entitlements/sync'))).toBe(true);
  });

  it('TI 503 → the dispatcher reports the event FAILED (the lease-safe drain retries it); the ATS row is untouched', async () => {
    await grant('core', 'ats', 'intelligence');
    const ti = fakeTi({ ingestStatus: 503 });
    const { id, event } = await createTalent();
    const dispatcher = new AtsTalentEventDispatcher([publisher(TI_ENV, ti.fetchImpl)], { warn: vi.fn() } as never);
    await expect(dispatcher.publish([event])).resolves.toEqual({ published_event_ids: [], failed_event_ids: [event.event_id] });
    expect(await recordPrisma.talentRecord.count({ where: { id } })).toBe(1);
    expect(await tiRepo.findLink({ tenant_id: TENANT, talent_record_id: id })).toBeNull();
  });

  it('webhook receiver: HMAC accept → inbox RECEIVED; replay → duplicate; bad signature → 401 and nothing recorded', async () => {
    const { id } = await createTalent();
    const receiver = new IntelligenceWebhookReceiver(tiRepo);
    const nowSec = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      event_id: '0190dddd-0000-7000-8000-000000000001',
      event_type: 'golden_talent.profile_updated',
      event_version: 'v1',
      intelligence_subject_id: SUBJECT,
      occurred_at: new Date().toISOString(),
      source_system_id: 'ARAMO_ATS',
      source_tenant_id: TENANT,
      external_talent_id: id,
      changed_fact_types: ['TITLE'],
    });
    const h = signIntelligenceWebhook({ rawBody: body, secret: WEBHOOK_SECRET, nowSec });
    const input = { rawBody: Buffer.from(body), timestampHeader: h['x-aramo-intelligence-timestamp'], signatureHeader: h['x-aramo-intelligence-signature'], secret: WEBHOOK_SECRET, nowSec };
    await expect(receiver.receive({ ...input, signatureHeader: 'AAAA' })).resolves.toEqual({ status: 401 });
    expect(await recordPrisma.talentIntelligenceInboundEvent.count()).toBe(0);
    await expect(receiver.receive(input)).resolves.toMatchObject({ status: 202 });
    await expect(receiver.receive(input)).resolves.toMatchObject({ status: 200, body: { duplicate: true } });
    expect(await recordPrisma.talentIntelligenceInboundEvent.findMany()).toEqual([expect.objectContaining({ status: 'RECEIVED', talent_record_id: id, attempts: 0 })]);
  });

  it('inbound sync policy matrix: AUTO_APPLY fills empty; recruiter-confirmed never overwritten; REVIEW → contradiction; contacts ignored; no echo back to TI', async () => {
    await grant('core', 'ats', 'intelligence');
    const { id, event } = await createTalent({ current_employer: 'Acme' });
    // The recruiter confirmed current_employer (MANUAL control state).
    await reconcile.upsertProfileFieldState({ tenant_id: TENANT, talent_record_id: id, field_key: 'current_employer', value_state: 'SET', source_type: 'MANUAL', projection_policy: 'AUTO' });
    // The tenant opts title + current_employer into AUTO_APPLY.
    await tiRepo.setSyncPolicy({ tenant_id: TENANT, field_key: 'title', mode: 'AUTO_APPLY' });
    await tiRepo.setSyncPolicy({ tenant_id: TENANT, field_key: 'current_employer', mode: 'AUTO_APPLY' });
    const facts = [
      { fact_type: 'TITLE', fact_key: '', value: { value: 'Principal Engineer' }, state: 'RESOLVED', verification_status: 'DECLARED', corroborating_sources: 2, supporting_assertion_ids: [] },
      { fact_type: 'CURRENT_EMPLOYER', fact_key: '', value: { name: 'Globex' }, state: 'RESOLVED', verification_status: 'DECLARED', corroborating_sources: 2, supporting_assertion_ids: [] },
      { fact_type: 'AVAILABILITY', fact_key: '', value: { status: 'AVAILABLE', date_available: '2026-12-01' }, state: 'RESOLVED', verification_status: 'DECLARED', corroborating_sources: 1, supporting_assertion_ids: [] },
      { fact_type: 'EDUCATION', fact_key: 'u', value: { institution: 'University of London' }, state: 'RESOLVED', verification_status: 'DECLARED', corroborating_sources: 1, supporting_assertion_ids: [] },
      { fact_type: 'PHONE', fact_key: '+15550001111', value: { value: '+1 555 000 1111' }, state: 'RESOLVED', verification_status: 'VERIFIED', corroborating_sources: 1, supporting_assertion_ids: [] },
    ];
    const ti = fakeTi({ profile: { intelligence_subject_id: SUBJECT, access_mode: 'CROSS_TENANT', facts, trust: {}, generated_at: new Date().toISOString() } });
    const client = new IntelligenceClient(loadIntelligenceConfig(TI_ENV), ti.fetchImpl);
    const inbound = new IntelligenceInboundSyncService(client, entitlements as never, tiRepo, reconcile, evidence);
    const deliver = async (eventId: string) => {
      await tiRepo.recordInboundEvent({ event_id: eventId, tenant_id: TENANT, talent_record_id: id, intelligence_subject_id: SUBJECT, changed_fact_types: ['TITLE'], occurred_at: new Date() });
      return inbound.drainOnce();
    };

    const [first] = await deliver('d-1');
    expect(first).toMatchObject({ status: 'APPLIED', applied: 2, review: 2, ignored: 1 });
    const row = await recordPrisma.talentRecord.findUniqueOrThrow({ where: { id } });
    expect(row.title).toBe('Principal Engineer'); // AUTO_APPLY into an empty field
    expect(row.availability_status).toBe('available_now'); // default AUTO_APPLY
    expect(row.current_employer).toBe('Acme'); // recruiter-confirmed: NEVER overwritten
    expect(row.phone_cell).toBe('(555) 123-0000'); // contacts IGNORE
    const provenance = await recordPrisma.talentRecordFieldProvenance.findMany({ where: { talent_record_id: id }, orderBy: { field_name: 'asc' } });
    expect(provenance.map((p) => [p.field_name, p.source_kind])).toEqual([
      ['availability_status', 'INTELLIGENCE'],
      ['date_available', 'INTELLIGENCE'],
      ['title', 'INTELLIGENCE'],
    ]);
    const contradictions = await recordPrisma.talentRecordReconcileContradiction.findMany({ where: { talent_record_id: id }, orderBy: { field_name: 'asc' } });
    expect(contradictions.map((c) => [c.field_name, c.source_kind, c.proposed_value, c.status])).toEqual([
      ['current_employer', 'INTELLIGENCE', 'Globex', 'pending'],
      ['education', 'INTELLIGENCE', 'University of London', 'pending'],
    ]);
    const state = await recordPrisma.talentProfileFieldState.findFirstOrThrow({ where: { talent_record_id: id, field_key: 'current_employer' } });
    expect(state).toMatchObject({ source_type: 'MANUAL', resolution_status: 'PENDING_REVIEW', proposed_value: 'Globex' });
    // The trust B2 poll never sees an INTELLIGENCE contradiction.
    expect(await reconcile.findPendingContradictions({ limit: 50 })).toEqual([]);
    expect(await tiRepo.findLink({ tenant_id: TENANT, talent_record_id: id })).toMatchObject({ intelligence_subject_id: SUBJECT, last_synced_at: expect.any(Date) });

    // A second delivery of the same Golden state is idempotent (no new write, no duplicate review).
    const [second] = await deliver('d-2');
    expect(second).toMatchObject({ status: 'APPLIED', applied: 0, review: 0 });
    expect(await recordPrisma.talentRecordReconcileContradiction.count({ where: { talent_record_id: id } })).toBe(2);
    expect(await recordPrisma.talentIntelligenceInboundEvent.findMany({ orderBy: { event_id: 'asc' } })).toEqual([
      expect.objectContaining({ event_id: 'd-1', status: 'APPLIED' }),
      expect.objectContaining({ event_id: 'd-2', status: 'APPLIED' }),
    ]);

    // The next ATS → TI snapshot does NOT echo the TI-applied title / availability back.
    const pubTi = fakeTi();
    await publisher(TI_ENV, pubTi.fetchImpl).publish({ ...event, event_id: '0190eeee-0000-7000-8000-000000000001', event_type: 'talent.profile_updated' });
    const types = ((pubTi.ingested[0] as { assertions: Array<{ assertion_type: string }> }).assertions ?? []).map((a) => a.assertion_type);
    expect(types).not.toContain('TITLE');
    expect(types).not.toContain('AVAILABILITY');
    expect(types).toContain('CURRENT_EMPLOYER');
  });
});
