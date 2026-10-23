import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  EntitlementService,
  GovIdTokenizer,
  IdentityMergeSplitService,
  IdentityResolutionService,
  IntelligenceOutboxDrainService,
  IntelligencePrismaService,
  PrismaIntelligenceUnitOfWork,
  ProfileReadService,
  ProjectionService,
  TI_CROSS_TENANT_READ_ENABLED_ENV,
  TalentIngestService,
  VerificationCodeService,
  VerificationService,
} from '../index.js';

import { VERIFIED, snapshot } from './support/fixtures.js';
import { RecordingDelivery, RecordingTransport } from './support/services.js';

// ATI-SEP-1 T4–T7 on a real PostgreSQL 17 (own database aramo_intelligence):
// the migration set (CHECKs, append-only read audit), the lease-safe outbox
// claim (SKIP LOCKED) and idempotent fan-out, verification binding under the
// partial unique index, and the end-to-end ingest(A) → ingest(B, same verified
// email) → read as A with TI_CROSS_TENANT_READ_ENABLED off / on.

const MIGRATIONS = resolve(__dirname, '../../prisma/migrations');
const ATS = { client_id: 'ats', source_system_id: 'ARAMO_ATS' };
const A = { source_system_id: 'ARAMO_ATS', source_tenant_id: 'e2e-a', external_talent_id: 'a-1' };

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(MIGRATIONS, n, 'migration.sql'));
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('intelligence T4–T7 — real database', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: IntelligencePrismaService;
  let uow: PrismaIntelligenceUnitOfWork;
  let ingest: TalentIngestService;
  let projection: ProjectionService;
  let verification: VerificationService;
  let reads: ProfileReadService;
  let drain: IntelligenceOutboxDrainService;
  let transport: RecordingTransport;
  const codes = VerificationCodeService.withKey('c'.repeat(32));
  const savedFlag = process.env[TI_CROSS_TENANT_READ_ENABLED_ENV];

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).withDatabase('aramo_intelligence').start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    for (const f of migrationFiles()) await db.query(readFileSync(f, 'utf8'));
    prisma = new IntelligencePrismaService(container.getConnectionUri());
    uow = new PrismaIntelligenceUnitOfWork(prisma);
    projection = new ProjectionService(uow);
    const mergeSplit = new IdentityMergeSplitService(uow, projection);
    ingest = new TalentIngestService(uow, new IdentityResolutionService(), GovIdTokenizer.withKey('g'.repeat(32)), projection);
    const delivery = new RecordingDelivery();
    verification = new VerificationService(uow, codes, delivery, mergeSplit, projection);
    reads = new ProfileReadService(uow);
    transport = new RecordingTransport();
    drain = new IntelligenceOutboxDrainService(uow, delivery, codes, transport);
  }, 180_000);

  afterEach(() => {
    if (savedFlag === undefined) delete process.env[TI_CROSS_TENANT_READ_ENABLED_ENV];
    else process.env[TI_CROSS_TENANT_READ_ENABLED_ENV] = savedFlag;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    await container?.stop();
  });

  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;

  it('the T4–T7 migration creates its tables, CHECKs and the append-only read audit', async () => {
    const tables = (await q(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'intelligence'`)).map((r) => r.table_name as string);
    for (const t of ['VerificationRequest', 'SubjectTrustState', 'EntitledTenant', 'IntelligenceReadAudit', 'IntelligenceWebhookDelivery']) expect(tables).toContain(t);
    await expect(
      db.query(`INSERT INTO "intelligence"."VerificationRequest" (id, identifier_type, normalized_value, channel, code_salt, code_hash, expires_at, requested_by_client_id)
                VALUES (gen_random_uuid(), 'EMAIL', 'x@x.io', 'EMAIL', 's', 'plaintext-code', now(), 'c')`),
    ).rejects.toThrow(/code_hash_check/);
    await expect(
      db.query(`INSERT INTO "intelligence"."SubjectTrustState" VALUES ($1, 'HIGH', 'NOT_ESTABLISHED', 'NOT_ESTABLISHED', 'NOT_ESTABLISHED', 0, 0, false, false, false, now())`, [
        '00000000-0000-4000-8000-000000000001',
      ]),
    ).rejects.toThrow();
    const [row] = await q(
      `INSERT INTO "intelligence"."IntelligenceReadAudit" (id, client_id, source_system_id, source_tenant_id, external_talent_id, read_kind, outcome)
       VALUES (gen_random_uuid(), 'c', 'ARAMO_ATS', 't', 'x', 'PROFILE', 'GRANTED') RETURNING id`,
    );
    await expect(db.query(`UPDATE "intelligence"."IntelligenceReadAudit" SET fields_returned = 1 WHERE id = $1`, [row.id])).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM "intelligence"."IntelligenceReadAudit" WHERE id = $1`, [row.id])).rejects.toThrow(/DELETE rejected/);
  });

  it('end to end: ingest(A) → ingest(B, same verified email) → read as A, flag off then on; drain fans out per entitled reference', async () => {
    const identity = (extra: Array<{ value: string; is_primary: boolean }> = []) => ({
      names: { first: 'Priya', last: 'Raman' },
      emails: [{ value: 'priya.e2e@x.io', is_primary: true, verification: { ...VERIFIED } }, ...extra],
    });
    const a = await ingest.ingest(
      snapshot({ tenant: 'e2e-a', talent: 'a-1', identity: identity(), assertions: [{ assertion_type: 'SKILL', payload: { name: 'TypeScript' }, source_kind: 'RECRUITER', observed_at: '2026-10-01T00:00:00.000Z' }] }),
      ATS,
    );
    const b = await ingest.ingest(
      snapshot({
        tenant: 'e2e-b',
        talent: 'b-1',
        identity: identity([{ value: 'b-secret@x.io', is_primary: false }]),
        assertions: [{ assertion_type: 'SKILL', payload: { name: 'Go' }, source_kind: 'RECRUITER', observed_at: '2026-10-02T00:00:00.000Z' }],
      }),
      ATS,
    );
    expect(b).toMatchObject({ resolution: 'VERIFIED_ANCHOR', intelligence_subject_id: a.intelligence_subject_id });
    const subject = a.intelligence_subject_id;
    expect((await q(`SELECT count(*)::int AS n FROM "intelligence"."ResolvedProfileFact" WHERE subject_id = $1 AND fact_type = 'SKILL'`, [subject]))[0].n).toBe(2);
    expect((await q(`SELECT identity_band FROM "intelligence"."SubjectTrustState" WHERE subject_id = $1`, [subject]))[0].identity_band).toBe('CORROBORATED');

    const entitlements = new EntitlementService(uow);
    await expect(reads.profile(ATS, A)).rejects.toMatchObject({ code: 'NOT_ENTITLED' });
    await entitlements.sync({ source_system_id: 'ARAMO_ATS', mode: 'UPSERT', tenants: [{ tenant_id: 'e2e-a', active: true }, { tenant_id: 'e2e-b', active: true }] }, ATS);

    process.env[TI_CROSS_TENANT_READ_ENABLED_ENV] = 'false';
    const off = await reads.profile(ATS, A);
    expect(off.access_mode).toBe('TENANT_SCOPED');
    expect(off.facts.filter((f) => f.fact_type === 'SKILL').map((f) => f.fact_key)).toEqual(['typescript']);
    expect(off.facts.filter((f) => f.fact_type === 'EMAIL').map((f) => f.fact_key)).toEqual(['priya.e2e@x.io']);
    const offEvidence = await reads.evidence(ATS, A);
    expect(offEvidence.assertions.every((x) => x.contributed_by === 'REQUESTING_TENANT')).toBe(true);
    expect(JSON.stringify([off, offEvidence])).not.toMatch(/e2e-b|b-secret|"Go"/);

    process.env[TI_CROSS_TENANT_READ_ENABLED_ENV] = 'true';
    const on = await reads.profile(ATS, A);
    expect(on.access_mode).toBe('CROSS_TENANT');
    expect(on.facts.filter((f) => f.fact_type === 'SKILL').map((f) => f.fact_key)).toEqual(['go', 'typescript']);
    expect(on.facts.filter((f) => f.fact_type === 'EMAIL').map((f) => f.fact_key).sort()).toEqual(['b-secret@x.io', 'priya.e2e@x.io']);
    expect((await reads.evidence(ATS, A)).assertions.some((x) => x.contributed_by === 'OTHER_SOURCE')).toBe(true);
    const audit = await q(`SELECT outcome, access_mode FROM "intelligence"."IntelligenceReadAudit" WHERE source_tenant_id = 'e2e-a' ORDER BY created_at`);
    expect(audit.map((r) => `${r.outcome}:${r.access_mode ?? '-'}`)).toEqual(['NOT_ENTITLED:-', 'GRANTED:TENANT_SCOPED', 'GRANTED:TENANT_SCOPED', 'GRANTED:CROSS_TENANT', 'GRANTED:CROSS_TENANT']);

    // A projection change now fans out: one delivery per active reference of an entitled tenant.
    await ingest.ingest(
      snapshot({ tenant: 'e2e-a', talent: 'a-1', identity: identity(), assertions: [{ assertion_type: 'SKILL', payload: { name: 'Rust' }, source_kind: 'RECRUITER', observed_at: '2026-10-03T00:00:00.000Z' }] }),
      ATS,
    );
    const cfg = { batchSize: 100, leaseMs: 60_000, maxAttempts: 3, baseBackoffMs: 5_000, maxBackoffMs: 60_000, webhookUrl: 'http://ats/hook', signingSecret: 'w'.repeat(40) };
    await drain.drainOnce(new Date(), cfg);
    // Three projection events are pending (ingest A, ingest B, ingest A again); entitlement is read at
    // drain time, so each event reaches BOTH entitled references exactly once.
    const events = (await q(`SELECT id FROM "intelligence"."IntelligenceOutbox" WHERE subject_id = $1 AND event_type = 'golden_talent.profile_updated'`, [subject])).length;
    expect(events).toBe(3);
    const delivered = transport.posts.map((p) => JSON.parse(p.body) as { source_tenant_id: string; intelligence_subject_id: string });
    const forSubject = delivered.filter((d) => d.intelligence_subject_id === subject).map((d) => d.source_tenant_id);
    expect(forSubject.filter((t) => t === 'e2e-a')).toHaveLength(events);
    expect(forSubject.filter((t) => t === 'e2e-b')).toHaveLength(events);
    expect((await q(`SELECT count(*)::int AS n FROM "intelligence"."IntelligenceOutbox" WHERE published_at IS NULL AND quarantined_at IS NULL AND event_type = 'golden_talent.profile_updated'`))[0].n).toBe(0);
  });

  it('outbox claim is lease-safe: concurrent claims never share a row; fan-out is idempotent', async () => {
    for (let i = 0; i < 6; i++) {
      await uow.run((r) => r.outbox.enqueue({ event_type: 'probe.event', subject_id: `probe-${i}`, payload: {}, occurred_at: new Date() }));
    }
    const now = new Date(Date.now() + 10 * 60_000);
    const [x, y] = await Promise.all([uow.run((r) => r.outbox.claim(4, now, 60_000)), uow.run((r) => r.outbox.claim(4, now, 60_000))]);
    const ids = [...(x ?? []), ...(y ?? [])].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    const probes = [...(x ?? []), ...(y ?? [])].filter((r) => r.event_type === 'probe.event');
    expect(probes.length).toBe(6);
    const one = probes[0] as (typeof probes)[number];
    expect(await uow.run((r) => r.outbox.markPublished(one.id, new Date(0), now))).toBe(false);
    expect(await uow.run((r) => r.outbox.markPublished(one.id, one.claimed_at as Date, now))).toBe(true);

    const ref = (await q(`SELECT id, subject_id FROM "intelligence"."ExternalTalentReference" LIMIT 1`))[0];
    const row = { outbox_event_id: one.id, reference_id: ref.id, subject_id: ref.subject_id, source_system_id: 'ARAMO_ATS', source_tenant_id: 't', external_talent_id: 'x', payload: {} };
    expect(await uow.run((r) => r.deliveries.createMany([row]))).toBe(1);
    expect(await uow.run((r) => r.deliveries.createMany([row]))).toBe(0);
  });

  it('verification binds under the partial unique index and the re-assessment query selects unassessed subjects', async () => {
    const res = await ingest.ingest(snapshot({ tenant: 'v-a', talent: 'v-1', identity: { emails: [{ value: 'otp@x.io', is_primary: true }] } }), ATS);
    const created = await verification.create({ source_reference: { source_system_id: 'ARAMO_ATS', source_tenant_id: 'v-a', external_talent_id: 'v-1' }, identifier_type: 'EMAIL', value: 'otp@x.io' }, ATS);
    const [row] = await q(`SELECT id, code_salt FROM "intelligence"."VerificationRequest" WHERE id = $1`, [created.verification_id]);
    const out = await verification.confirm(created.verification_id, { code: codes.codeFor(row.id, row.code_salt) });
    expect(out).toMatchObject({ outcome: 'BOUND', intelligence_subject_id: res.intelligence_subject_id });
    const bound = await q(
      `SELECT subject_id, verification_method, source_reference_id FROM "intelligence"."SubjectIdentifier" WHERE normalized_value = 'otp@x.io' AND verification_status = 'VERIFIED' AND status = 'ACTIVE'`,
    );
    expect(bound).toEqual([{ subject_id: res.intelligence_subject_id, verification_method: 'EMAIL_OTP', source_reference_id: null }]);
    expect((await q(`SELECT count(*)::int AS n FROM "intelligence"."Assertion" WHERE assertion_type = 'VERIFICATION_OUTCOME' AND subject_id = $1`, [res.intelligence_subject_id]))[0].n).toBe(1);
    await expect(
      db.query(
        `INSERT INTO "intelligence"."SubjectIdentifier" (id, subject_id, identifier_type, normalized_value, verification_status) VALUES (gen_random_uuid(), $1, 'EMAIL', 'otp@x.io', 'VERIFIED')`,
        [res.intelligence_subject_id],
      ),
    ).rejects.toThrow(/verified_active_unique/);

    await db.query(`DELETE FROM "intelligence"."SubjectTrustState" WHERE subject_id = $1`, [res.intelligence_subject_id]);
    const due = await uow.run((r) => r.subjects.listForReassessment(new Date(), 1000));
    expect(due).toContain(res.intelligence_subject_id);
    expect(await projection.reassess(new Date(), 1000)).toBeGreaterThan(0);
    expect((await q(`SELECT count(*)::int AS n FROM "intelligence"."SubjectTrustState" WHERE subject_id = $1`, [res.intelligence_subject_id]))[0].n).toBe(1);
  });
});
