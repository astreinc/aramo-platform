import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  ContradictionResolutionService,
  DisputeService,
  EntitlementService,
  GovIdTokenizer,
  IdentityResolutionService,
  IntelligencePrismaService,
  PrismaIntelligenceUnitOfWork,
  ProfileReadService,
  ProjectionService,
  ProposalService,
  TI_CROSS_TENANT_READ_ENABLED_ENV,
  TalentIngestService,
  VerificationStatusService,
} from '../index.js';

import { VERIFIED, snapshot } from './support/fixtures.js';

// ATI-SEP-1 T10 on a real PostgreSQL 17 (own database aramo_intelligence): the
// 20261023150000 migration (CHECKs, the one-open-dispute partial unique index,
// append-only dispute thread / audit, RECONCILES links) and one end-to-end
// dispute lifecycle through the Prisma repositories (incl. the raw-SQL tenant
// worklists), contradiction resolution and the proposal queue.

const MIGRATIONS = resolve(__dirname, '../../prisma/migrations');
const ATS = { client_id: 'ats', source_system_id: 'ARAMO_ATS' };
const A1 = { source_system_id: 'ARAMO_ATS', source_tenant_id: 'lc-a', external_talent_id: 'a-1' } as const;

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(MIGRATIONS, n, 'migration.sql'));
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('intelligence T10 evidence lifecycle — real database', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: IntelligencePrismaService;
  let ingest: TalentIngestService;
  let disputes: DisputeService;
  let proposals: ProposalService;
  let contradictions: ContradictionResolutionService;
  let reads: ProfileReadService;
  let status: VerificationStatusService;
  const savedFlag = process.env[TI_CROSS_TENANT_READ_ENABLED_ENV];

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).withDatabase('aramo_intelligence').start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    for (const f of migrationFiles()) await db.query(readFileSync(f, 'utf8'));
    prisma = new IntelligencePrismaService(container.getConnectionUri());
    const uow = new PrismaIntelligenceUnitOfWork(prisma);
    const projection = new ProjectionService(uow);
    ingest = new TalentIngestService(uow, new IdentityResolutionService(), GovIdTokenizer.withKey('g'.repeat(32)), projection);
    disputes = new DisputeService(uow, projection);
    proposals = new ProposalService(uow);
    contradictions = new ContradictionResolutionService(uow, projection);
    reads = new ProfileReadService(uow);
    status = new VerificationStatusService(uow);
    await new EntitlementService(uow).sync(
      { source_system_id: 'ARAMO_ATS', mode: 'UPSERT', tenants: [{ tenant_id: 'lc-a', active: true }, { tenant_id: 'lc-b', active: true }] },
      ATS,
    );
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

  it('the T10 migration: tables, closed vocabularies, RECONCILES link type, baseline row', async () => {
    const tables = (await q(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'intelligence'`)).map((r) => r.table_name as string);
    for (const t of ['AssertionDispute', 'AssertionDisputeStatement', 'AssertionDisputeEvent', 'VerificationProposal']) expect(tables).toContain(t);
    expect((await q(`SELECT value FROM "intelligence"."ServiceInfo" WHERE key = 'evidence_lifecycle'`))[0]?.value).toBe('ATI-SEP-1-T10');
    const checks = (await q(`SELECT conname FROM pg_constraint WHERE conname IN ('AssertionLink_link_type_check', 'AssertionDispute_status_check', 'VerificationProposal_status_check')`)).length;
    expect(checks).toBe(3);
    await expect(
      db.query(`INSERT INTO "intelligence"."VerificationProposal" (id, subject_id, source_system_id, source_tenant_id, kind, trigger_kind, basis_ref, basis_snapshot, created_by)
                VALUES (gen_random_uuid(), gen_random_uuid(), 'ARAMO_ATS', 't', 'MERGE_THEM', 'SINGLE_SOURCE_ONLY', 'b', '{}', 'x')`),
    ).rejects.toThrow(/kind_check|foreign key/);
  });

  it('end to end: open → triage (DISPUTED) → correct (REVOKED); worklists via raw SQL; append-only thread + audit; one open dispute per assertion', async () => {
    process.env[TI_CROSS_TENANT_READ_ENABLED_ENV] = 'false';
    const email = [{ value: 'priya.lc@x.io', is_primary: true, verification: { ...VERIFIED } }];
    await ingest.ingest(
      snapshot({
        tenant: 'lc-a',
        talent: 'a-1',
        identity: { names: { first: 'Priya', last: 'Raman' }, emails: email },
        assertions: [{ assertion_type: 'SKILL', payload: { name: 'COBOL' }, source_kind: 'RECRUITER', observed_at: '2026-10-01T00:00:00.000Z' }],
      }),
      ATS,
    );
    await ingest.ingest(
      snapshot({
        tenant: 'lc-b',
        talent: 'b-1',
        identity: { names: { first: 'Priya', last: 'Raman' }, emails: email },
        assertions: [{ assertion_type: 'SKILL', payload: { name: 'Fortran' }, source_kind: 'RECRUITER', observed_at: '2026-10-01T00:00:00.000Z' }],
      }),
      ATS,
    );
    const [cobol] = await q(`SELECT id, subject_id FROM "intelligence"."Assertion" WHERE payload->>'name' = 'COBOL'`);

    const d = await disputes.open({ portal_context: A1, assertion_id: cobol.id, statement: 'I never wrote COBOL.' }, ATS);
    expect((await disputes.open({ portal_context: A1, assertion_id: cobol.id, statement: 'again' }, ATS)).dispute_id).toBe(d.dispute_id);
    await expect(
      db.query(`INSERT INTO "intelligence"."AssertionDispute" (id, assertion_id, opened_via_reference_id, triage_due_at, summary_due_at, reinvestigation_due_at)
                SELECT gen_random_uuid(), assertion_id, opened_via_reference_id, now(), now(), now() FROM "intelligence"."AssertionDispute" WHERE id = $1`, [d.dispute_id]),
    ).rejects.toThrow(/one_open_per_assertion/);

    // Raw-SQL worklists: A sees its own; B (flag off) does not see A's assertion's dispute.
    expect((await disputes.listForTenant('lc-a', ATS, {})).items.map((i) => i.dispute_id)).toEqual([d.dispute_id]);
    expect((await disputes.listForTenant('lc-b', ATS, {})).items).toEqual([]);
    process.env[TI_CROSS_TENANT_READ_ENABLED_ENV] = 'true';
    expect((await disputes.listForTenant('lc-b', ATS, {})).items.map((i) => i.contributed_by)).toEqual(['OTHER_SOURCE']);
    process.env[TI_CROSS_TENANT_READ_ENABLED_ENV] = 'false';

    await disputes.triage(d.dispute_id, { source_tenant_id: 'lc-a', actor: 'u1' }, ATS);
    expect((await q(`SELECT current_status FROM "intelligence"."Assertion" WHERE id = $1`, [cobol.id]))[0].current_status).toBe('DISPUTED');
    expect((await q(`SELECT has_open_dispute FROM "intelligence"."SubjectTrustState" WHERE subject_id = $1`, [cobol.subject_id]))[0].has_open_dispute).toBe(true);
    await disputes.requestInfo(d.dispute_id, { source_tenant_id: 'lc-a', actor: 'u1', note: 'Any evidence?' }, ATS);
    expect((await disputes.correct(d.dispute_id, { source_tenant_id: 'lc-a', actor: 'u1', note: 'Removed.' }, ATS)).status).toBe('RESOLVED_CORRECTED');
    expect((await q(`SELECT current_status FROM "intelligence"."Assertion" WHERE id = $1`, [cobol.id]))[0].current_status).toBe('REVOKED');
    expect((await q(`SELECT event_type FROM "intelligence"."AssertionEvent" WHERE assertion_id = $1 ORDER BY created_at, id`, [cobol.id])).map((r) => r.event_type)).toEqual([
      'ASSERTED',
      'DISPUTED',
      'CORRECTED',
    ]);
    expect((await q(`SELECT has_open_dispute FROM "intelligence"."SubjectTrustState" WHERE subject_id = $1`, [cobol.subject_id]))[0].has_open_dispute).toBe(false);
    expect((await q(`SELECT event_type FROM "intelligence"."AssertionDisputeEvent" WHERE dispute_id = $1 ORDER BY created_at, id`, [d.dispute_id])).map((r) => r.event_type)).toEqual([
      'OPENED',
      'TRIAGED',
      'INFO_REQUESTED',
      'CORRECTED',
    ]);
    await expect(db.query(`UPDATE "intelligence"."AssertionDisputeStatement" SET statement = 'x' WHERE dispute_id = $1`, [d.dispute_id])).rejects.toThrow(/append-only/);
    await expect(db.query(`UPDATE "intelligence"."AssertionDisputeEvent" SET actor = 'x' WHERE dispute_id = $1`, [d.dispute_id])).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM "intelligence"."AssertionDisputeEvent" WHERE dispute_id = $1`, [d.dispute_id])).rejects.toThrow(/DELETE rejected/);
    expect((await disputes.getForPortal(d.dispute_id, ['ARAMO_ATS/lc-a/a-1'], ATS)).statements.map((s) => s.author)).toEqual(['TALENT', 'TENANT']);

    // The corrected claim is not re-admitted when the ATS re-sends it.
    await ingest.ingest(
      snapshot({
        tenant: 'lc-a',
        talent: 'a-1',
        identity: { names: { first: 'Priya', last: 'Raman' }, emails: email },
        assertions: [{ assertion_type: 'SKILL', payload: { name: 'COBOL' }, source_kind: 'RECRUITER', observed_at: '2026-10-01T00:00:00.000Z' }],
      }),
      ATS,
    );
    expect((await q(`SELECT current_status FROM "intelligence"."Assertion" WHERE payload->>'name' = 'COBOL'`)).map((r) => r.current_status)).toEqual(['REVOKED']);
  });

  it('contradiction resolution (RECONCILES link accepted by the CHECK) + proposal worklist via raw SQL + verification status', async () => {
    process.env[TI_CROSS_TENANT_READ_ENABLED_ENV] = 'false';
    const email = [{ value: 'kim.lc@x.io', is_primary: true, verification: { ...VERIFIED } }];
    for (const [talent, value, at] of [
      ['a-2', 'Engineer', '2026-10-01T00:00:00.000Z'],
      ['a-3', 'Manager', '2026-10-05T00:00:00.000Z'],
    ] as const) {
      await ingest.ingest(
        snapshot({
          tenant: 'lc-a',
          talent,
          identity: { names: { first: 'Kim', last: 'Lee' }, emails: email },
          assertions: [{ assertion_type: 'TITLE', payload: { value }, source_kind: 'RECRUITER', observed_at: at }],
        }),
        ATS,
      );
    }
    const [eng] = await q(`SELECT id FROM "intelligence"."Assertion" WHERE payload->>'value' = 'Engineer'`);
    const [mgr] = await q(`SELECT id FROM "intelligence"."Assertion" WHERE payload->>'value' = 'Manager'`);
    const open = await proposals.list('lc-a', ATS, { kind: 'RESOLVE_CONTRADICTION' });
    expect(open.items.map((p) => p.assertion_id).sort()).toEqual([eng.id, mgr.id].sort());

    const ref = { source_system_id: 'ARAMO_ATS', source_tenant_id: 'lc-a', external_talent_id: 'a-2' };
    const r = await contradictions.resolve(ref, eng.id, { resolution: 'KEEP', reason: 'Two roles over time.', actor: 'u1' }, ATS);
    expect(r).toEqual({ assertion_id: eng.id, resolution: 'KEEP', status: 'VALID', reconciled_with: [mgr.id] });
    expect((await q(`SELECT link_type FROM "intelligence"."AssertionLink" WHERE from_assertion_id = $1`, [eng.id])).map((x) => x.link_type)).toContain('RECONCILES');
    expect((await q(`SELECT current_status FROM "intelligence"."Assertion" WHERE id IN ($1, $2) ORDER BY current_status`, [eng.id, mgr.id])).map((x) => x.current_status)).toEqual([
      'VALID',
      'VALID',
    ]);
    expect((await reads.profile(ATS, ref)).trust.open_contradiction_count).toBe(0);
    expect((await proposals.list('lc-a', ATS, { kind: 'RESOLVE_CONTRADICTION' })).items).toEqual([]);
    const settled = await proposals.list('lc-a', ATS, { status: 'SETTLED', kind: 'RESOLVE_CONTRADICTION', limit: '1' });
    expect(settled.items).toHaveLength(1);
    expect(settled.next_cursor).not.toBeNull();
    expect((await proposals.list('lc-a', ATS, { status: 'SETTLED', kind: 'RESOLVE_CONTRADICTION', cursor: settled.next_cursor })).items).toHaveLength(1);

    expect((await status.forReference(ref, ATS)).items).toEqual([
      { identifier_type: 'EMAIL', value_masked: 'k***@x.io', status: 'VERIFIED', expires_at: '2027-10-01T00:00:00.000Z' },
    ]);
    expect((await status.forPortal(['ARAMO_ATS/lc-a/a-2', 'ARAMO_ATS/lc-a/a-3'], ATS)).items).toHaveLength(1);
  });
});
