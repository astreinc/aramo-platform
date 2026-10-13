import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import type { EnvelopeDefaults, LeaseSafeOutboxRepository } from '@aramo/events';
import { LeaseSafeOutboxDrainService } from '@aramo/outbox-publisher';
import { TalentIntakeMessageHandler } from '@aramo/talent-record';

import { SingleBoxTalentIntakePublisher } from '../talent-intake-consumer/singlebox-talent-intake-publisher.js';

// ADR-0033 / single-box — the singlebox transport delivers the canonical outbox
// envelope DIRECTLY to the in-process TalentIntakeMessageHandler (no AWS), reusing
// the EXISTING lease-safe drain + CAS processing. Proves, against a real Postgres:
//   • singlebox delivery: QUEUED outbox → drain → handler → processing invoked →
//     outbox published (§12 at the drain+handler level; the LLM extraction is
//     stubbed via the processing port — it is unchanged by this feature);
//   • a terminal/idempotent draft is acked without re-processing (§8);
//   • a transient handler failure leaves the event retryable, never lost (§6);
//   • the GOVERNED redrive resets a stuck (exhausted/quarantined) draft's outbox so
//     the drain re-delivers it — the supported recovery (no manual SQL).

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
const noopLogger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'ADR-0033 single-box transport — in-process delivery + redrive (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: EvidencePrismaService;
    let repo: TalentEvidenceRepository;
    let leaseRepo: LeaseSafeOutboxRepository;

    const defaults: EnvelopeDefaults = {
      source: 'talent-intake',
      event_version: 'v1',
      subjectTypeFor: () => 'talent_intake_draft',
      subjectIdFor: (row) =>
        String((row.event_payload as { draft_id?: string })?.draft_id ?? row.id),
      correlationIdFor: (row) =>
        String((row.event_payload as { correlation_id?: string })?.correlation_id ?? row.id),
    };

    // A real handler whose processing port is stubbed (the LLM extraction is
    // unchanged by this feature and is not exercised here). findTalentIntakeDraftById
    // returns a non-null draft so the handler proceeds to the CAS processing step.
    function handlerWith(processIntakeDraft: () => Promise<boolean>): TalentIntakeMessageHandler {
      const processing = { processIntakeDraft: vi.fn(processIntakeDraft) };
      const talentExtraction = {
        findTalentIntakeDraftById: async ({ id }: { tenant_id: string; id: string }) => ({
          id,
          tenant_id: TENANT_A,
        }),
      };
      return new TalentIntakeMessageHandler(
        processing as never,
        talentExtraction as never,
        noopLogger as never,
      );
    }

    function singleboxDrain(
      handler: TalentIntakeMessageHandler,
      cfg: { lease_seconds?: number; max_attempts?: number } = {},
    ): LeaseSafeOutboxDrainService {
      const pub = new SingleBoxTalentIntakePublisher(handler, noopLogger as never);
      return new LeaseSafeOutboxDrainService(
        leaseRepo,
        pub,
        defaults,
        { limit: 50, lease_seconds: cfg.lease_seconds ?? 60, max_attempts: cfg.max_attempts ?? 5 },
        noopLogger as never,
        'singlebox',
      );
    }

    async function seedQueuedDraft(sourceEventId: string): Promise<string> {
      const draftId = uuidv7();
      const correlation = `corr-${sourceEventId}`;
      const res = await repo.createOrRecoverSourceIntakeWithOutbox({
        id: draftId,
        tenant_id: TENANT_A,
        created_by: ACTOR_A,
        source_type: 'JOB_BOARD',
        source_event_id: sourceEventId,
        source_ref: 'application-xyz',
        structured_payload: { summary: 'seed' },
        event_type: 'talent_intake.resume_extraction_requested.v1',
        event_version: 'v1',
        source: 'talent-intake',
        subject_type: 'talent_intake_draft',
        correlation_id: correlation,
        event_payload: { draft_id: draftId, correlation_id: correlation },
      });
      return res.draft.id;
    }

    const outboxRows = () =>
      prisma.talentIntakeOutboxEvent.findMany({ where: { tenant_id: TENANT_A } });

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
          repo.markTalentIntakeOutboxPublished({
            event_ids: [...i.event_ids],
            published_at: new Date(),
          }),
        releaseOutboxLease: (i) =>
          repo.releaseTalentIntakeOutboxLease({
            event_ids: [...i.event_ids],
            last_error: i.last_error,
          }),
        quarantineOutbox: (i) =>
          repo.quarantineTalentIntakeOutboxEvents({ event_ids: [...i.event_ids], reason: i.reason }),
      };
    }, 180_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    beforeEach(async () => {
      await prisma.talentIntakeOutboxEvent.deleteMany({ where: { tenant_id: TENANT_A } });
      await prisma.talentIntakeDraft.deleteMany({ where: { tenant_id: TENANT_A } });
    });

    it('§12 singlebox delivers a QUEUED draft to the handler → processing invoked → outbox published', async () => {
      const draftId = await seedQueuedDraft('sb-1');
      const processing = vi.fn(async () => true);
      const handler = handlerWith(processing);
      const outcome = await singleboxDrain(handler).drainOnce();

      expect(outcome.claimed).toBe(1);
      expect(outcome.published).toBe(1);
      expect(outcome.failed).toBe(0);
      expect(processing).toHaveBeenCalledTimes(1);
      const [ob] = await outboxRows();
      expect(ob.published_at).not.toBeNull();
      // nothing left to drain
      expect((await singleboxDrain(handler).drainOnce()).claimed).toBe(0);
      expect(draftId).toBeTruthy();
    });

    it('§8 a terminal/idempotent draft (processing not claimable) is acked without re-processing', async () => {
      await seedQueuedDraft('sb-2');
      const processing = vi.fn(async () => false); // already terminal → not claimable
      const handler = handlerWith(processing);
      const outcome = await singleboxDrain(handler).drainOnce();
      expect(outcome.published).toBe(1); // 'skipped' is acknowledged (no loop)
      const [ob] = await outboxRows();
      expect(ob.published_at).not.toBeNull();
      expect(processing).toHaveBeenCalledTimes(1);
    });

    it('§6 a transient handler failure leaves the event retryable (not published, re-claimable)', async () => {
      await seedQueuedDraft('sb-3');
      const handler = handlerWith(async () => {
        throw new Error('transient db blip');
      });
      const outcome = await singleboxDrain(handler, { lease_seconds: 0 }).drainOnce();
      expect(outcome.failed).toBe(1);
      const [ob] = await outboxRows();
      expect(ob.published_at).toBeNull(); // retryable, never lost
      // lease_seconds 0 → immediately re-claimable on the next tick
      expect((await singleboxDrain(handler, { lease_seconds: 0 }).drainOnce()).claimed).toBe(1);
    });

    it('§redrive a stuck (exhausted/quarantined) draft becomes deliverable again after redrive', async () => {
      const draftId = await seedQueuedDraft('sb-redrive');
      const failing = handlerWith(async () => {
        throw new Error('persistent');
      });
      // Exhaust the attempt budget (and/or quarantine) until nothing is claimable.
      for (let i = 0; i < 8; i++) {
        const o = await singleboxDrain(failing, { lease_seconds: 0, max_attempts: 5 }).drainOnce();
        if (o.claimed === 0) break;
      }
      // Stuck: not re-claimable.
      expect(
        (await singleboxDrain(failing, { lease_seconds: 0, max_attempts: 5 }).drainOnce()).claimed,
      ).toBe(0);
      const beforeRedrive = (await outboxRows())[0];
      expect(beforeRedrive.published_at).toBeNull();

      // GOVERNED redrive — resets delivery state for the draft's unpublished outbox.
      const reset = await repo.redriveTalentIntakeOutboxByDraft({
        tenant_id: TENANT_A,
        draft_id: draftId,
      });
      expect(reset).toBe(1);

      // Now a healthy handler delivers it.
      const healthy = handlerWith(async () => true);
      const delivered = await singleboxDrain(healthy, { max_attempts: 5 }).drainOnce();
      expect(delivered.claimed).toBe(1);
      expect(delivered.published).toBe(1);
      expect((await outboxRows())[0].published_at).not.toBeNull();
    });

    it('§redrive never touches an already-published outbox (idempotent no-op)', async () => {
      await seedQueuedDraft('sb-published');
      const draftId = (await prisma.talentIntakeDraft.findFirst({ where: { tenant_id: TENANT_A } }))!
        .id;
      await singleboxDrain(handlerWith(async () => true)).drainOnce(); // publishes it
      const reset = await repo.redriveTalentIntakeOutboxByDraft({
        tenant_id: TENANT_A,
        draft_id: draftId,
      });
      expect(reset).toBe(0); // published row is left delivered
      expect((await outboxRows())[0].published_at).not.toBeNull();
    });

    // REGRESSION — the recruiter UPLOAD path (completeUploadWithOutbox) historically
    // wrote NO subject_id; the draft id lived ONLY in event_payload.draft_id. This
    // is the EXACT shape of the stuck PROD draft this PR must recover. A redrive
    // keyed on subject_id alone would match zero rows → fail to recover it. Here we
    // seed that precise legacy shape (subject_id NULL) directly and prove redrive
    // still finds it via event_payload.draft_id.
    it('§redrive recovers a LEGACY upload row (subject_id NULL, draft id only in event_payload) — the stuck PROD shape', async () => {
      const draftId = uuidv7();
      await prisma.talentIntakeOutboxEvent.create({
        data: {
          tenant_id: TENANT_A,
          event_type: 'talent_intake.resume_extraction_requested.v1',
          event_payload: { draft_id: draftId, correlation_id: `corr-legacy-${draftId}` },
          // subject_id intentionally omitted (NULL) — the pre-fix upload shape.
        },
      });
      expect((await outboxRows())[0].subject_id).toBeNull(); // sanity: truly legacy

      const failing = handlerWith(async () => {
        throw new Error('persistent');
      });
      for (let i = 0; i < 8; i++) {
        const o = await singleboxDrain(failing, { lease_seconds: 0, max_attempts: 5 }).drainOnce();
        if (o.claimed === 0) break;
      }
      expect(
        (await singleboxDrain(failing, { lease_seconds: 0, max_attempts: 5 }).drainOnce()).claimed,
      ).toBe(0);

      const reset = await repo.redriveTalentIntakeOutboxByDraft({
        tenant_id: TENANT_A,
        draft_id: draftId,
      });
      expect(reset).toBe(1); // matched via event_payload.draft_id, NOT subject_id

      const delivered = await singleboxDrain(handlerWith(async () => true), {
        max_attempts: 5,
      }).drainOnce();
      expect(delivered.claimed).toBe(1);
      expect(delivered.published).toBe(1);
    });

    // The same recovery seeded through the REAL completeUploadWithOutbox() path
    // (not a hand-built row). Post-fix, that path now persists subject_id too —
    // asserted here — so the row is self-describing AND redrivable.
    it('§redrive recovers a draft enqueued through the REAL completeUploadWithOutbox() path', async () => {
      const draftId = uuidv7();
      await prisma.talentIntakeDraft.create({
        data: {
          id: draftId,
          tenant_id: TENANT_A,
          created_by: ACTOR_A,
          source_type: 'RESUME_UPLOAD',
          processing_status: 'UPLOADED', // the precondition completeUploadWithOutbox guards on
        },
      });
      const res = await repo.completeUploadWithOutbox({
        tenant_id: TENANT_A,
        id: draftId,
        created_by: ACTOR_A,
        artifact_sha256: 'a'.repeat(64),
        mime_type: 'application/pdf',
        size_bytes: 1234,
        event_type: 'talent_intake.resume_extraction_requested.v1',
        event_payload: { draft_id: draftId, correlation_id: `corr-upload-${draftId}` },
      });
      expect(res.enqueued).toBe(true);
      expect((await outboxRows())[0].subject_id).toBe(draftId); // forward-fix persists it

      const failing = handlerWith(async () => {
        throw new Error('persistent');
      });
      for (let i = 0; i < 8; i++) {
        const o = await singleboxDrain(failing, { lease_seconds: 0, max_attempts: 5 }).drainOnce();
        if (o.claimed === 0) break;
      }
      const reset = await repo.redriveTalentIntakeOutboxByDraft({
        tenant_id: TENANT_A,
        draft_id: draftId,
      });
      expect(reset).toBe(1);
      const delivered = await singleboxDrain(handlerWith(async () => true), {
        max_attempts: 5,
      }).drainOnce();
      expect(delivered.published).toBe(1);
    });
  },
);
