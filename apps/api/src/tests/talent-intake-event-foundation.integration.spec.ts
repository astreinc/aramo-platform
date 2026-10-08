import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { v7 as uuidv7 } from 'uuid';
import {
  PrismaService as EvidencePrismaService,
  TalentEvidenceRepository,
} from '@aramo/talent-evidence';
import type {
  EnvelopeDefaults,
  LeaseSafeOutboxRepository,
} from '@aramo/events';
import {
  FakeOutboxPublisher,
  LeaseSafeOutboxDrainService,
} from '@aramo/outbox-publisher';

// ADR-0033 Checkpoint B — operational proof of the durable-event foundation
// against a real Postgres 17, with NO AWS (the OutboxPublisherPort is the test
// FakeOutboxPublisher, so partial success / outage / replay / reclaim /
// quarantine are all deterministic). Proves:
//   (1) source-agnostic idempotency: tenant + source_type + source_event_id →
//       ONE TalentIntakeDraft, including replay AND concurrent duplicate
//       admission, with no fabricated storage_key.
//   (2) the lease lifecycle is operationally distinguishable: claimed →
//       published / released-for-retry / quarantined, with persisted attempt
//       count + event identity in the drain outcome and logs.

const ROOT = resolve(__dirname, '../../../..');
const MIGRATION_LIBS = ['documents', 'talent-evidence'];

function collectMigrations(): string[] {
  const all: { name: string; path: string }[] = [];
  for (const lib of MIGRATION_LIBS) {
    const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (d.isDirectory() && /^\d+_/.test(d.name)) {
        all.push({ name: d.name, path: resolve(dir, d.name, 'migration.sql') });
      }
    }
  }
  return all.sort((a, b) => a.name.localeCompare(b.name)).map((m) => m.path);
}

// Dollar-quote / comment / string-literal aware splitter (documents carries
// `$$`-quoted trigger bodies). Only splits on a top-level `;`.
function splitDdl(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;
  let dollarTag: string | null = null;
  while (i < sql.length) {
    const ch = sql[i];
    if (dollarTag === null && ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      if (nl === -1) break;
      current += '\n';
      i = nl + 1;
      continue;
    }
    if (ch === '$') {
      const m = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (m !== null) {
        const tag = m[0];
        if (dollarTag === null) {
          dollarTag = tag;
          current += tag;
          i += tag.length;
          continue;
        }
        if (dollarTag === tag) {
          dollarTag = null;
          current += tag;
          i += tag.length;
          continue;
        }
      }
    }
    if (dollarTag === null && ch === "'") {
      current += ch;
      i += 1;
      while (i < sql.length) {
        current += sql[i];
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            current += sql[i + 1];
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (dollarTag === null && ch === ';') {
      const trimmed = current.trim();
      if (trimmed.length > 0) statements.push(trimmed);
      current = '';
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  const last = current.trim();
  if (last.length > 0) statements.push(last);
  return statements;
}

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const ACTOR_A = '33333333-3333-7333-8333-333333333333';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'ADR-0033 durable-event foundation — idempotency + lease lifecycle (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: EvidencePrismaService;
    let repo: TalentEvidenceRepository;
    let leaseRepo: LeaseSafeOutboxRepository;

    const logs: Array<Record<string, unknown>> = [];
    const capturingLogger = {
      log: (e: Record<string, unknown>) => logs.push(e),
      warn: (e: Record<string, unknown>) => logs.push(e),
      error: (e: Record<string, unknown>) => logs.push(e),
    };

    const defaults: EnvelopeDefaults = {
      source: 'talent-intake',
      event_version: 'v1',
      subjectTypeFor: () => 'talent_intake_draft',
      subjectIdFor: (row) =>
        String((row.event_payload as { draft_id?: string })?.draft_id ?? row.id),
      correlationIdFor: (row) =>
        String((row.event_payload as { correlation_id?: string })?.correlation_id ?? row.id),
    };

    function makeDrain(
      publisher: FakeOutboxPublisher,
      cfg: { lease_seconds?: number; max_attempts?: number } = {},
    ): LeaseSafeOutboxDrainService {
      return new LeaseSafeOutboxDrainService(
        leaseRepo,
        publisher,
        defaults,
        { limit: 50, lease_seconds: cfg.lease_seconds ?? 60, max_attempts: cfg.max_attempts ?? 5 },
        capturingLogger as never,
        'fake',
      );
    }

    async function seedSourceIntake(
      sourceEventId: string,
    ): Promise<{ created: boolean; draftId: string }> {
      const draftId = uuidv7();
      const correlation = `corr-${sourceEventId}`;
      const res = await repo.createOrRecoverSourceIntakeWithOutbox({
        id: draftId,
        tenant_id: TENANT_A,
        created_by: ACTOR_A,
        source_type: 'JOB_BOARD',
        source_event_id: sourceEventId,
        source_ref: 'application-123',
        // NO storage_key / artifact — a non-upload source.
        structured_payload: { summary: 'from job board' },
        event_type: 'talent_intake.resume_extraction_requested.v1',
        event_version: 'v1',
        source: 'talent-intake',
        subject_type: 'talent_intake_draft',
        correlation_id: correlation,
        event_payload: { draft_id: draftId, correlation_id: correlation },
      });
      return { created: res.created, draftId: res.draft.id };
    }

    function outboxRows() {
      return prisma.talentIntakeOutboxEvent.findMany({ where: { tenant_id: TENANT_A } });
    }
    function draftRows() {
      return prisma.talentIntakeDraft.findMany({ where: { tenant_id: TENANT_A } });
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const url = container.getConnectionUri();
      const setup = new EvidencePrismaService(url);
      await setup.$connect();
      for (const path of collectMigrations()) {
        for (const stmt of splitDdl(readFileSync(path, 'utf8'))) {
          await setup.$executeRawUnsafe(stmt);
        }
      }
      await setup.$disconnect();

      prisma = new EvidencePrismaService(url);
      await prisma.$connect();
      repo = new TalentEvidenceRepository(prisma);
      leaseRepo = {
        claimOutboxBatch: (i) => repo.claimTalentIntakeOutboxBatch(i),
        markOutboxPublished: (i) =>
          repo.markTalentIntakeOutboxPublished({ event_ids: [...i.event_ids], published_at: new Date() }),
        releaseOutboxLease: (i) =>
          repo.releaseTalentIntakeOutboxLease({ event_ids: [...i.event_ids], last_error: i.last_error }),
        quarantineOutbox: (i) =>
          repo.quarantineTalentIntakeOutboxEvents({ event_ids: [...i.event_ids], reason: i.reason }),
      };
    }, 180_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    beforeEach(async () => {
      logs.length = 0;
      await prisma.talentIntakeOutboxEvent.deleteMany({ where: { tenant_id: TENANT_A } });
      await prisma.talentIntakeDraft.deleteMany({ where: { tenant_id: TENANT_A } });
    });

    // ---- (1) source-agnostic idempotency ----------------------------------

    it('replay of the same (tenant, source_type, source_event_id) → ONE draft, ONE outbox event, no fake storage_key', async () => {
      const first = await seedSourceIntake('evt-1');
      const second = await seedSourceIntake('evt-1');

      expect(first.created).toBe(true);
      expect(second.created).toBe(false); // recovered, not re-created
      expect(second.draftId).toBe(first.draftId); // converge on the same intake

      expect(await draftRows()).toHaveLength(1);
      expect(await outboxRows()).toHaveLength(1); // emitted only on first creation
      const [draft] = await draftRows();
      expect(draft.storage_key).toBeNull(); // no fabricated artifact
      expect(draft.source_event_id).toBe('evt-1');
    });

    it('CONCURRENT duplicate admission → exactly one winner, one draft, one outbox event', async () => {
      const [a, b] = await Promise.all([seedSourceIntake('evt-race'), seedSourceIntake('evt-race')]);
      const createdCount = [a, b].filter((r) => r.created).length;
      expect(createdCount).toBe(1); // exactly one insert won the partial-unique race
      expect(a.draftId).toBe(b.draftId); // both converge on the winner's draft
      expect(await draftRows()).toHaveLength(1);
      expect(await outboxRows()).toHaveLength(1);
    });

    it('a different source_event_id → a distinct intake', async () => {
      await seedSourceIntake('evt-A');
      await seedSourceIntake('evt-B');
      expect(await draftRows()).toHaveLength(2);
      expect(await outboxRows()).toHaveLength(2);
    });

    // ---- (2) lease lifecycle: claimed → published / released / quarantined --

    it('all-confirmed publish → every row published_at set; outcome.published = N', async () => {
      await seedSourceIntake('p1');
      await seedSourceIntake('p2');
      const fake = new FakeOutboxPublisher();
      const outcome = await makeDrain(fake).drainOnce();

      expect(outcome.claimed).toBe(2);
      expect(outcome.published).toBe(2);
      expect(outcome.failed).toBe(0);
      const rows = await outboxRows();
      expect(rows.every((r) => r.published_at !== null)).toBe(true);
      // Observability: a 'published' outcome is logged per event with identity.
      const published = logs.filter((l) => l['outcome'] === 'published');
      expect(published).toHaveLength(2);
      expect(published.every((l) => typeof l['event_id'] === 'string')).toBe(true);
    });

    it('partial transport failure → failed row released (reclaimable), others published', async () => {
      await seedSourceIntake('ok-1');
      await seedSourceIntake('fail-1');
      const all = await outboxRows();
      const failId = all.find((r) => (r.event_payload as { correlation_id: string }).correlation_id === 'corr-fail-1')!.id;

      const fake = new FakeOutboxPublisher().failEvents([failId]);
      const outcome = await makeDrain(fake).drainOnce();

      expect(outcome.published).toBe(1);
      expect(outcome.failed).toBe(1);
      expect(outcome.quarantined).toBe(0);
      const rows = await outboxRows();
      const failed = rows.find((r) => r.id === failId)!;
      expect(failed.published_at).toBeNull(); // NOT marked published
      expect(failed.lease_expires_at).toBeNull(); // lease released → reclaimable
      expect(failed.last_publish_error).toBe('transport_publish_failed');
      expect(failed.quarantined_at).toBeNull();

      // Reclaimable next tick: a recovered publisher drains it.
      const outcome2 = await makeDrain(fake.recover()).drainOnce();
      expect(outcome2.claimed).toBe(1);
      expect(outcome2.published).toBe(1);
      expect((await outboxRows()).every((r) => r.published_at !== null)).toBe(true);
    });

    it('full outage → whole batch released, none published, all reclaimable', async () => {
      await seedSourceIntake('o1');
      await seedSourceIntake('o2');
      const fake = new FakeOutboxPublisher().failEverything();
      const outcome = await makeDrain(fake).drainOnce();

      expect(outcome.published).toBe(0);
      expect(outcome.failed).toBe(2);
      const rows = await outboxRows();
      expect(rows.every((r) => r.published_at === null && r.lease_expires_at === null)).toBe(true);
    });

    it('over-budget failure → quarantined (stops being claimed), distinct from retry', async () => {
      await seedSourceIntake('q1');
      // max_attempts = 1: the claim bumps attempts to 1; a transport failure then
      // sees attempts (1) >= max (1) → quarantine, not release.
      const fake = new FakeOutboxPublisher().failEverything();
      const outcome = await makeDrain(fake, { max_attempts: 1 }).drainOnce();

      expect(outcome.quarantined).toBe(1);
      expect(outcome.failed).toBe(1);
      const [row] = await outboxRows();
      expect(row.quarantined_at).not.toBeNull();
      expect(row.quarantine_reason).toBe('max_publish_attempts_exceeded');

      // A quarantined row is NOT claimed again, even by a recovered publisher.
      const outcome2 = await makeDrain(new FakeOutboxPublisher(), { max_attempts: 1 }).drainOnce();
      expect(outcome2.claimed).toBe(0);
      // Observability: the quarantine outcome was logged with the attempt count.
      const q = logs.find((l) => l['outcome'] === 'quarantined');
      expect(q?.['attempt']).toBe(1);
    });

    it('expired lease is reclaimable (crash-before-publish): a second claim re-leases the row', async () => {
      await seedSourceIntake('lease-1');
      // lease_seconds = 0 → lease_expires_at = now() at claim; by the next claim
      // DB now() has advanced, so the row is reclaimable (crash-recovery path).
      const claim1 = await repo.claimTalentIntakeOutboxBatch({ limit: 10, lease_seconds: 0, max_attempts: 5 });
      expect(claim1).toHaveLength(1);
      expect(claim1[0].publish_attempts).toBe(1);

      const claim2 = await repo.claimTalentIntakeOutboxBatch({ limit: 10, lease_seconds: 60, max_attempts: 5 });
      expect(claim2).toHaveLength(1); // reclaimed after expiry
      expect(claim2[0].id).toBe(claim1[0].id);
      expect(claim2[0].publish_attempts).toBe(2); // attempt count persisted + incremented
    });

    it('an unexpired lease is NOT reclaimable by a concurrent publisher', async () => {
      await seedSourceIntake('held-1');
      const claim1 = await repo.claimTalentIntakeOutboxBatch({ limit: 10, lease_seconds: 300, max_attempts: 5 });
      expect(claim1).toHaveLength(1);
      // Second publisher, lease still held → SKIP LOCKED + unexpired lease = none.
      const claim2 = await repo.claimTalentIntakeOutboxBatch({ limit: 10, lease_seconds: 300, max_attempts: 5 });
      expect(claim2).toHaveLength(0);
    });

    // ---- (3) ADR-0033 decoupling — late-extraction no-op after manual promote --
    it('a PROMOTED intake can NEVER be claimed for extraction (late-extraction no-op); an unpromoted QUEUED draft still claims', async () => {
      // Control: a QUEUED, unpromoted draft claims exactly once at its version.
      const ctl = await seedSourceIntake('claim-control');
      const ctlRow = (await draftRows()).find((d) => d.id === ctl.draftId)!;
      expect(ctlRow.processing_status).toBe('QUEUED');
      expect(
        await repo.claimTalentIntakeDraftForProcessing({
          tenant_id: TENANT_A,
          id: ctl.draftId,
          expected_version: ctlRow.version,
        }),
      ).toBe(1);

      // Guard: the recruiter promoted a still-QUEUED draft (manual create while the
      // async extraction path was unavailable). A late extraction delivery then
      // tries to claim it AT ITS CURRENT VERSION → 0, blocked by the
      // promoted_talent_record_id guard (NOT a version mismatch). promote does not
      // change processing_status, so only the new guard prevents the claim.
      const g = await seedSourceIntake('claim-guard');
      const promoted = await repo.markTalentIntakeDraftPromoted({
        tenant_id: TENANT_A,
        id: g.draftId,
        promoted_talent_record_id: uuidv7(),
        promoted_at: new Date(),
      });
      expect(promoted).toBe(1);
      const gRow = (await draftRows()).find((d) => d.id === g.draftId)!;
      expect(gRow.processing_status).toBe('QUEUED'); // promote leaves processing dimension untouched
      expect(gRow.promoted_talent_record_id).not.toBeNull();
      expect(
        await repo.claimTalentIntakeDraftForProcessing({
          tenant_id: TENANT_A,
          id: g.draftId,
          expected_version: gRow.version,
        }),
      ).toBe(0);
    });
  },
);
