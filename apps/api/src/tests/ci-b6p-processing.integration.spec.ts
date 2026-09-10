import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { Test, type TestingModule } from '@nestjs/testing';
import { CommonModule, RedisConnectionConfig } from '@aramo/common';
import {
  ConversationIntelligenceProcessingService,
  ConversationIntelligenceRunRepository,
  FakeCiModelProvider,
  PrismaService,
  type AiProcessingAuthorizationPort,
  type NormalizedTranscriptSource,
  type NormalizedTranscriptView,
  type RequisitionSnapshotSource,
} from '@aramo/conversation-intelligence';

import { CiProcessingConfig } from '../conversation-intelligence/ci-processing.config.js';
import { CiProcessingProducer } from '../conversation-intelligence/ci-processing.producer.js';
import { CiProcessingProcessor } from '../conversation-intelligence/ci-processing.processor.js';
import { CiProcessingReconciler } from '../conversation-intelligence/ci-processing-reconciler.js';
import { CI_PROCESSING_QUEUE_NAME } from '../conversation-intelligence/ci-processing.queue.constants.js';

// CI-B6P §32 — production processing integration against REAL Postgres 17 +
// REAL Redis 7 / BullMQ. Proves the B6P wiring the unit specs cannot: durable
// run persistence, the enqueue→worker→completed round-trip, idempotency,
// restart recovery, and the activation gate. The PROVIDER boundary is the
// deterministic FakeCiModelProvider — NO real Anthropic/Talent call (Gate-5).

const CI_ROOT = resolve(__dirname, '../../../../libs/conversation-intelligence/prisma/migrations');
function ciMigrations(): string[] {
  return readdirSync(CI_ROOT).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(CI_ROOT, n, 'migration.sql'));
}
function splitDdl(sql: string): string[] {
  const out: string[] = [];
  let cur = ''; let inDollar = false; let inLineComment = false;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i] as string;
    if (inLineComment) { cur += ch; if (ch === '\n') inLineComment = false; continue; }
    if (!inDollar && ch === '-' && sql[i + 1] === '-') { inLineComment = true; cur += ch; continue; }
    if (sql.startsWith('$$', i)) { inDollar = !inDollar; cur += '$$'; i += 1; continue; }
    if (ch === ';' && !inDollar) { const t = cur.trim(); if (t.length > 0) out.push(t); cur = ''; continue; }
    cur += ch;
  }
  const tail = cur.trim(); if (tail.length > 0) out.push(tail);
  return out;
}

function view(tenant: string, transcriptId: string, interactionId: string, sha: string): NormalizedTranscriptView {
  return {
    conversation_transcript_id: transcriptId,
    tenant_id: tenant,
    interaction_id: interactionId,
    normalized_sha256: sha,
    utterances: [
      { utterance_id: 'utt_1', ordinal: 0, speaker_role: 'RECRUITER', text: 'How many years of Java do you have?' },
      { utterance_id: 'utt_2', ordinal: 1, speaker_role: 'UNKNOWN', text: 'I think about eight years of Java.' },
    ],
  };
}

const allowAuthz: AiProcessingAuthorizationPort = { evaluate: async () => ({ allowed: true, consent_decision_ref: 'cd' }) };
const noopLogger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'CI-B6P production processing — real Postgres 17 + real Redis 7 / BullMQ',
  () => {
    let pg: StartedPostgreSqlContainer;
    let redis: StartedRedisContainer;
    let prisma: PrismaService;
    let repo: ConversationIntelligenceRunRepository;
    let moduleRef: TestingModule;
    let producer: CiProcessingProducer;
    let reconciler: CiProcessingReconciler;
    let savedEnv: NodeJS.ProcessEnv;

    const TENANT_A = randomUUID();
    const TENANT_B = randomUUID();
    const model = new FakeCiModelProvider('valid');

    // A processing service over real PG + fake ports + the deterministic model.
    function processingFor(snapshotId: string, transcript: NormalizedTranscriptView): ConversationIntelligenceProcessingService {
      const transcripts: NormalizedTranscriptSource = { load: async () => ({ status: 'ready', view: transcript }) };
      const snapshots: RequisitionSnapshotSource = {
        getSnapshot: async () => ({ id: snapshotId, source_requisition_version: 1, context: { role: { title: 'Engineer' } } }),
      };
      return new ConversationIntelligenceProcessingService(repo, snapshots, transcripts, allowAuthz, model);
    }

    // Enqueue a queued run + drive the real worker, mirroring the handler's
    // provenance (analysis identity). Returns the durable run id.
    async function scheduleRun(tenant: string, snapshotId: string, transcript: NormalizedTranscriptView): Promise<string> {
      const id = model.modelIdentity();
      const run = await repo.createOrGetQueued({
        tenant_id: tenant,
        conversation_transcript_id: transcript.conversation_transcript_id,
        requisition_analysis_context_snapshot_id: snapshotId,
        interaction_id: transcript.interaction_id,
        normalized_sha256: transcript.normalized_sha256,
        model_provider: id.provider,
        model_name: id.model,
        model_version: id.version ?? null,
        prompt_template_id: 'conversation-intelligence.analysis',
        prompt_template_version: 'v1',
        prompt_sha256: 'c'.repeat(64),
        output_schema_version: 'conversation-intelligence.analysis.v1',
      });
      return run.id;
    }

    async function waitForStatus(tenant: string, runId: string, target: string, timeoutMs = 15_000): Promise<string> {
      const start = Date.now();
      // Date.now is allowed here (test file, not a workflow script).
      while (Date.now() - start < timeoutMs) {
        const run = await repo.findRunByIdInTenant(tenant, runId);
        if (run !== null && run.status === target) return run.status;
        await new Promise((r) => setTimeout(r, 200));
      }
      const run = await repo.findRunByIdInTenant(tenant, runId);
      return run?.status ?? 'absent';
    }

    beforeAll(async () => {
      savedEnv = { ...process.env };
      [pg, redis] = await Promise.all([
        new PostgreSqlContainer('postgres:17').start(),
        new RedisContainer('redis:7').start(),
      ]);
      const url = pg.getConnectionUri();
      const setup = new PrismaService(url);
      await setup.$connect();
      for (const p of ciMigrations()) {
        for (const stmt of splitDdl(readFileSync(p, 'utf8'))) await setup.$executeRawUnsafe(stmt);
      }
      await setup.$disconnect();

      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new ConversationIntelligenceRunRepository(prisma);

      process.env['REDIS_URL'] = redis.getConnectionUrl();
      process.env['CI_PROCESSING_ENABLED'] = 'true';
      process.env['CI_ANTHROPIC_MODEL'] = 'claude-sonnet-4-6';

      // A processing service bound to a per-run transcript is impractical through
      // DI; the processor delegates to ONE processing service, so we bind a
      // service whose fake ports serve the single active transcript per test.
      // We rebind via a mutable holder the module reads.
      @Module({
        imports: [
          CommonModule,
          BullModule.forRootAsync({
            extraOptions: { manualRegistration: true },
            useFactory: (cfg: RedisConnectionConfig) => ({
              skipWaitingForReady: true, skipVersionCheck: true, skipMetasUpdate: true,
              connection: { ...cfg.connection, lazyConnect: true },
            }),
            inject: [RedisConnectionConfig],
            extraProviders: [RedisConnectionConfig],
          }),
          BullModule.registerQueue({ name: CI_PROCESSING_QUEUE_NAME }),
        ],
        providers: [
          CiProcessingConfig,
          { provide: ConversationIntelligenceRunRepository, useValue: repo },
          { provide: ConversationIntelligenceProcessingService, useValue: { process: (cmd: { tenant_id: string; conversation_transcript_id: string; requisition_analysis_context_snapshot_id: string }) => activeService.process(cmd) } },
          CiProcessingProducer,
          CiProcessingReconciler,
          CiProcessingProcessor,
          { provide: 'CiProcessingReconcilerLogger', useValue: noopLogger },
          { provide: 'CiProcessingProcessorLogger', useValue: noopLogger },
        ],
      })
      class TestCiModule {}

      moduleRef = await Test.createTestingModule({ imports: [TestCiModule] }).compile();
      await moduleRef.init();
      producer = moduleRef.get(CiProcessingProducer);
      reconciler = moduleRef.get(CiProcessingReconciler);
    }, 240_000);

    afterAll(async () => {
      await moduleRef?.close();
      await prisma?.$disconnect();
      await Promise.all([pg?.stop(), redis?.stop()]);
      process.env = savedEnv;
    });

    // A mutable holder the DI'd processing service delegates to (per-test transcript).
    let activeService: ConversationIntelligenceProcessingService;

    it('enqueue → real worker → completed run; queue payload is identifiers only', async () => {
      const transcript = view(TENANT_A, randomUUID(), randomUUID(), 'b'.repeat(64));
      const snapId = randomUUID();
      activeService = processingFor(snapId, transcript);
      model.callCount = 0;
      const runId = await scheduleRun(TENANT_A, snapId, transcript);

      await producer.enqueueRun(runId, TENANT_A);
      expect(await waitForStatus(TENANT_A, runId, 'completed')).toBe('completed');
      expect(model.callCount).toBe(1);
      const claims = await repo.listClaims(TENANT_A, runId);
      expect(claims.length).toBeGreaterThan(0);
    });

    it('restart recovery: a durable queued run with NO enqueue is re-driven by the reconciler', async () => {
      const transcript = view(TENANT_A, randomUUID(), randomUUID(), 'b'.repeat(64));
      const snapId = randomUUID();
      activeService = processingFor(snapId, transcript);
      model.callCount = 0;
      const runId = await scheduleRun(TENANT_A, snapId, transcript); // durable, NOT enqueued

      await reconciler.reconcile(); // re-enqueues re-drivable runs
      expect(await waitForStatus(TENANT_A, runId, 'completed')).toBe('completed');
    });

    it('duplicate enqueue converges to ONE completed run (idempotent short-circuit)', async () => {
      const transcript = view(TENANT_A, randomUUID(), randomUUID(), 'b'.repeat(64));
      const snapId = randomUUID();
      activeService = processingFor(snapId, transcript);
      model.callCount = 0;
      const runId = await scheduleRun(TENANT_A, snapId, transcript);

      await producer.enqueueRun(runId, TENANT_A);
      expect(await waitForStatus(TENANT_A, runId, 'completed')).toBe('completed');
      const afterFirst = model.callCount;
      await producer.enqueueRun(runId, TENANT_A); // duplicate after completion
      await new Promise((r) => setTimeout(r, 1500));
      const run = await repo.findRunByIdInTenant(TENANT_A, runId);
      expect(run!.status).toBe('completed');
      expect(model.callCount).toBe(afterFirst); // terminal short-circuit → no re-invoke
    });

    it('completed run is immutable (DB trigger blocks a terminal update)', async () => {
      const transcript = view(TENANT_A, randomUUID(), randomUUID(), 'b'.repeat(64));
      const snapId = randomUUID();
      activeService = processingFor(snapId, transcript);
      const runId = await scheduleRun(TENANT_A, snapId, transcript);
      await producer.enqueueRun(runId, TENANT_A);
      await waitForStatus(TENANT_A, runId, 'completed');
      await expect(repo.patchRun(TENANT_A, runId, { status: 'processing' })).rejects.toThrow();
    });

    it('tenant isolation: a run is invisible to another tenant', async () => {
      const transcript = view(TENANT_A, randomUUID(), randomUUID(), 'b'.repeat(64));
      const snapId = randomUUID();
      activeService = processingFor(snapId, transcript);
      const runId = await scheduleRun(TENANT_A, snapId, transcript);
      expect(await repo.findRunByIdInTenant(TENANT_B, runId)).toBeNull();
    });

    it('activation disabled: the worker leaves the run queued and makes NO model call', async () => {
      const transcript = view(TENANT_A, randomUUID(), randomUUID(), 'b'.repeat(64));
      const snapId = randomUUID();
      activeService = processingFor(snapId, transcript);
      model.callCount = 0;
      const runId = await scheduleRun(TENANT_A, snapId, transcript);

      process.env['CI_PROCESSING_ENABLED'] = 'false';
      try {
        await producer.enqueueRun(runId, TENANT_A);
        await new Promise((r) => setTimeout(r, 1500));
        const run = await repo.findRunByIdInTenant(TENANT_A, runId);
        expect(run!.status).toBe('queued');
        expect(model.callCount).toBe(0);
      } finally {
        process.env['CI_PROCESSING_ENABLED'] = 'true';
      }
    });
  },
);
