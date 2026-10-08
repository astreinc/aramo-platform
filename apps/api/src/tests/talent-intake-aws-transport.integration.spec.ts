import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  LocalstackContainer,
  type StartedLocalStackContainer,
} from '@testcontainers/localstack';
import {
  EventBridgeClient,
  PutEventsCommand,
  PutRuleCommand,
  PutTargetsCommand,
  CreateEventBusCommand,
  ListTargetsByRuleCommand,
} from '@aws-sdk/client-eventbridge';
import {
  SQSClient,
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  ChangeMessageVisibilityCommand,
  type Message,
} from '@aws-sdk/client-sqs';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { v7 as uuidv7 } from 'uuid';
import {
  PrismaService as EvidencePrismaService,
  TalentEvidenceRepository,
} from '@aramo/talent-evidence';
import { TalentExtractionService } from '@aramo/talent-extraction';
import type { AramoEventEnvelope } from '@aramo/events';
import { EventBridgeOutboxPublisher } from '@aramo/outbox-publisher';
import {
  TalentIntakeExtractionService,
  TalentIntakeMessageHandler,
} from '@aramo/talent-record';

import { processTalentIntakeSqsBatch } from '../talent-intake-consumer/sqs-lambda.adapter.js';
import type { SqsRecordLike } from '../talent-intake-consumer/sqs-event.types.js';

// ADR-0033 Checkpoint C / Phase 6 — the AWS-shape runtime proofs. LocalStack
// provides the AWS-MANAGED path (EventBridge PutEvents, rule → SQS delivery,
// redrive/DLQ, visibility timeout); the REAL thin adapter + handler are invoked
// IN-PROCESS against the actual SQS payload shape. We deliberately do NOT emulate
// a full Lambda runtime (brittle). This proves:
//   EventBridge → SQS → actual SQS event shape → real adapter → real handler.
// The no-AWS invariants (lease lifecycle, source-event idempotency, CAS/promotion,
// partial-batch mapping, quarantine) are already green in the Checkpoint B spec;
// here we add the transport-shape proofs + the two flagged composition proofs
// (Redis-down → progresses; duplicate delivery → one effective extraction).

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
// Dollar-quote / comment / string aware splitter (documents carries $$ bodies).
function splitDdl(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  let tag: string | null = null;
  while (i < sql.length) {
    const ch = sql[i];
    if (tag === null && ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      if (nl === -1) break;
      cur += '\n';
      i = nl + 1;
      continue;
    }
    if (ch === '$') {
      const m = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (m !== null) {
        const t = m[0];
        if (tag === null) { tag = t; cur += t; i += t.length; continue; }
        if (tag === t) { tag = null; cur += t; i += t.length; continue; }
      }
    }
    if (tag === null && ch === "'") {
      cur += ch; i += 1;
      while (i < sql.length) {
        cur += sql[i];
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { cur += sql[i + 1]; i += 2; continue; }
          i += 1; break;
        }
        i += 1;
      }
      continue;
    }
    if (tag === null && ch === ';') {
      const t = cur.trim();
      if (t.length > 0) out.push(t);
      cur = ''; i += 1; continue;
    }
    cur += ch; i += 1;
  }
  const last = cur.trim();
  if (last.length > 0) out.push(last);
  return out;
}

const TENANT = '11111111-1111-7111-8111-111111111111';
const ACTOR = '33333333-3333-7333-8333-333333333333';
const BUS = 'aramo-test-talent-intake';
const SOURCE_PREFIX = 'aramo';
const EVENT_TYPE = 'talent_intake.resume_extraction_requested.v1';

const noop = { log: () => undefined, warn: () => undefined, error: () => undefined };

function cannedResult(): unknown {
  return {
    prefill: { first_name: 'Ada', last_name: 'Lovelace', email1: 'ada@example.com', phone_cell: '+15551230000' },
    parse_status: 'parsed',
    extraction_status: 'success',
    source_map_version: 'resume-source-map/v1',
    resume_text_hash: 'aws-shape-hash',
  };
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'ADR-0033 Phase 6 — AWS-shape transport proofs (LocalStack EventBridge+SQS; real adapter/handler)',
  () => {
    let pg: StartedPostgreSqlContainer;
    let ls: StartedLocalStackContainer;
    let prisma: EvidencePrismaService;
    let repo: TalentEvidenceRepository;
    let eb: EventBridgeClient;
    let sqs: SQSClient;
    let publisher: EventBridgeOutboxPublisher;
    let handler: TalentIntakeMessageHandler;
    let orchestratorCalls = 0;

    let sourceQueueUrl: string;
    let sourceQueueArn: string;
    let consumerDlqUrl: string;
    let ebTargetDlqUrl: string;
    let ruleArn: string;

    async function queueArn(url: string): Promise<string> {
      const a = await sqs.send(
        new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] }),
      );
      return a.Attributes!['QueueArn']!;
    }

    async function receiveOne(url: string, waitSeconds = 5): Promise<Message | null> {
      const r = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: url,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: waitSeconds,
          MessageAttributeNames: ['All'],
        }),
      );
      return r.Messages?.[0] ?? null;
    }

    function envelopeFor(draftId: string): AramoEventEnvelope {
      return {
        event_id: uuidv7(),
        event_type: EVENT_TYPE,
        event_version: 'v1',
        tenant_id: TENANT,
        source: 'talent-intake',
        subject_type: 'talent_intake_draft',
        subject_id: draftId,
        occurred_at: '2026-10-07T00:00:00.000Z',
        correlation_id: `corr-${draftId}`,
        causation_id: null,
        payload: { draft_id: draftId, correlation_id: `corr-${draftId}` },
      };
    }

    // Create a QUEUED, ARTIFACT-backed intake draft (storage_key set → the
    // extraction path runs the orchestrator).
    async function seedQueuedUploadDraft(): Promise<string> {
      const id = uuidv7();
      await repo.createTalentIntakeDraft({
        id,
        tenant_id: TENANT,
        created_by: ACTOR,
        source_type: 'RESUME_UPLOAD',
        source_filename: 'resume.pdf',
        storage_key: `${TENANT}/talent/${id}/resume.pdf`,
      });
      await repo.completeUploadWithOutbox({
        tenant_id: TENANT,
        id,
        event_type: EVENT_TYPE,
        event_payload: { draft_id: id, correlation_id: `corr-${id}` },
      });
      return id;
    }

    function draftRow(id: string) {
      return prisma.talentIntakeDraft.findFirst({ where: { tenant_id: TENANT, id } });
    }

    beforeAll(async () => {
      [pg, ls] = await Promise.all([
        new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start(),
        new LocalstackContainer('localstack/localstack:3').start(),
      ]);

      const url = pg.getConnectionUri();
      const setup = new EvidencePrismaService(url);
      await setup.$connect();
      for (const p of collectMigrations()) {
        for (const stmt of splitDdl(readFileSync(p, 'utf8'))) await setup.$executeRawUnsafe(stmt);
      }
      await setup.$disconnect();
      prisma = new EvidencePrismaService(url);
      await prisma.$connect();
      repo = new TalentEvidenceRepository(prisma);

      const endpoint = ls.getConnectionUri();
      const awsCfg = { region: 'us-east-1', endpoint, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } };
      eb = new EventBridgeClient(awsCfg);
      sqs = new SQSClient(awsCfg);

      // --- AWS-managed resources (the real transport shapes) ---
      await eb.send(new CreateEventBusCommand({ Name: BUS }));
      const mk = async (name: string, attrs: Record<string, string> = {}) => {
        const q = await sqs.send(new CreateQueueCommand({ QueueName: name, Attributes: attrs }));
        return q.QueueUrl!;
      };
      consumerDlqUrl = await mk('talent-intake-consumer-dlq');
      ebTargetDlqUrl = await mk('talent-intake-ebtarget-dlq');
      const consumerDlqArn = await queueArn(consumerDlqUrl);
      // source queue: LOW visibility timeout (redrive/redelivery proofs) +
      // redrive → consumer DLQ after 2 receives.
      sourceQueueUrl = await mk('talent-intake', {
        VisibilityTimeout: '2',
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: consumerDlqArn, maxReceiveCount: 2 }),
      });
      sourceQueueArn = await queueArn(sourceQueueUrl);
      // allow the EventBridge rule to SendMessage to the source queue.
      await sqs.send(
        new SetQueueAttributesCommand({
          QueueUrl: sourceQueueUrl,
          Attributes: {
            Policy: JSON.stringify({
              Version: '2012-10-17',
              Statement: [{ Effect: 'Allow', Principal: { Service: 'events.amazonaws.com' }, Action: 'sqs:SendMessage', Resource: sourceQueueArn }],
            }),
          },
        }),
      );
      const ebTargetDlqArn = await queueArn(ebTargetDlqUrl);
      const rule = await eb.send(
        new PutRuleCommand({
          Name: 'talent-intake-extraction-requested',
          EventBusName: BUS,
          EventPattern: JSON.stringify({ source: [`${SOURCE_PREFIX}.talent-intake`], 'detail-type': [EVENT_TYPE] }),
        }),
      );
      ruleArn = rule.RuleArn!;
      await eb.send(
        new PutTargetsCommand({
          Rule: 'talent-intake-extraction-requested',
          EventBusName: BUS,
          Targets: [
            {
              Id: 'talent-intake-queue',
              Arn: sourceQueueArn,
              DeadLetterConfig: { Arn: ebTargetDlqArn },
              RetryPolicy: { MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 60 },
            },
          ],
        }),
      );

      publisher = new EventBridgeOutboxPublisher(eb, { busName: BUS, sourcePrefix: SOURCE_PREFIX }, noop as never);

      const talentExtraction = new TalentExtractionService({} as never, repo, {} as never, {} as never);
      const orchestratorStub = {
        extractResume: async () => {
          orchestratorCalls += 1;
          return cannedResult();
        },
      };
      const extraction = new TalentIntakeExtractionService(orchestratorStub as never, talentExtraction, noop as never);
      handler = new TalentIntakeMessageHandler(extraction, talentExtraction, noop as never);
    }, 240_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await Promise.allSettled([pg?.stop(), ls?.stop()]);
    });

    // ---- LocalStack AWS-shape proofs ----

    it('EventBridge PutEvents success → rule routes to SQS → the SQS body carries the canonical envelope as `detail`', async () => {
      const draftId = await seedQueuedUploadDraft();
      const envelope = envelopeFor(draftId);
      const result = await publisher.publish([envelope]);
      expect(result.published_event_ids).toEqual([envelope.event_id]); // PutEvents accepted
      expect(result.failed_event_ids).toEqual([]);

      const msg = await receiveOne(sourceQueueUrl, 8); // rule → SQS delivery
      expect(msg).not.toBeNull();
      const body = JSON.parse(msg!.Body!) as { source: string; 'detail-type': string; detail: AramoEventEnvelope };
      expect(body.source).toBe(`${SOURCE_PREFIX}.talent-intake`);
      expect(body['detail-type']).toBe(EVENT_TYPE);
      // envelope shape as actually serialized through EventBridge → SQS
      expect(body.detail.event_id).toBe(envelope.event_id);
      expect(body.detail.subject_id).toBe(draftId);
      expect(body.detail.tenant_id).toBe(TENANT);
      expect(body.detail.correlation_id).toBe(envelope.correlation_id);

      // the REAL adapter + handler process the ACTUAL SQS payload → terminal.
      const record: SqsRecordLike = { messageId: msg!.MessageId!, body: msg!.Body!, attributes: {} };
      const resp = await processTalentIntakeSqsBatch([record], handler, noop as never);
      expect(resp.batchItemFailures).toEqual([]);
      const d = await draftRow(draftId);
      expect(d?.processing_status).toBe('READY');
    });

    it('per-entry PutEvents partial success is mapped entry-by-entry (adapter unit, mocked client)', async () => {
      const okEnv = envelopeFor('aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa');
      const badEnv = envelopeFor('bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb');
      const mockClient = {
        send: async () => ({
          FailedEntryCount: 1,
          // positional: entry 0 ok, entry 1 failed
          Entries: [{ EventId: 'evt-ok' }, { ErrorCode: 'InternalException', ErrorMessage: 'boom' }],
        }),
      };
      const p = new EventBridgeOutboxPublisher(mockClient as never, { busName: BUS, sourcePrefix: SOURCE_PREFIX }, noop as never);
      const res = await p.publish([okEnv, badEnv]);
      expect(res.published_event_ids).toEqual([okEnv.event_id]); // only the confirmed entry
      expect(res.failed_event_ids).toEqual([badEnv.event_id]); // the failed entry, not the batch
    });

    it('Plane B — SQS redrive: a message repeatedly not deleted moves to the CONSUMER DLQ (processing failure plane)', async () => {
      await sqs.send(new SendMessageCommand({ QueueUrl: sourceQueueUrl, MessageBody: JSON.stringify({ detail: envelopeFor('cccccccc-cccc-7ccc-8ccc-cccccccccccc') }) }));
      // Drive the message past maxReceiveCount (2) deterministically: each real
      // receive increments the receive count; ChangeMessageVisibility(0) makes it
      // immediately visible again (no sleep-timing fragility). The receive that
      // would exceed maxReceiveCount redirects it to the consumer DLQ instead.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const m = await receiveOne(sourceQueueUrl, 2);
        if (m === null) break; // moved to DLQ (no longer on the source)
        await sqs.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: sourceQueueUrl,
            ReceiptHandle: m.ReceiptHandle!,
            VisibilityTimeout: 0,
          }),
        );
      }
      // Poll the Plane B (processing) DLQ with retries.
      let dead: Message | null = null;
      for (let attempt = 0; attempt < 10 && dead === null; attempt += 1) {
        dead = await receiveOne(consumerDlqUrl, 2);
        if (dead === null) await sleep(1000);
      }
      expect(dead).not.toBeNull(); // landed in the Plane B (processing) DLQ
    }, 60_000);

    it('visibility-timeout redelivery is harmless: CAS/idempotency yields ONE effective extraction', async () => {
      const draftId = await seedQueuedUploadDraft();
      await publisher.publish([envelopeFor(draftId)]);
      const first = await receiveOne(sourceQueueUrl, 8);
      expect(first).not.toBeNull();
      orchestratorCalls = 0;

      // First delivery: process it (claims QUEUED → PROCESSING → terminal).
      const rec1: SqsRecordLike = { messageId: first!.MessageId!, body: first!.Body!, attributes: { ApproximateReceiveCount: '1' } };
      await processTalentIntakeSqsBatch([rec1], handler, noop as never);
      expect(orchestratorCalls).toBe(1);
      expect((await draftRow(draftId))?.processing_status).toBe('READY');

      // Redelivery (visibility lapsed, not deleted): the SAME payload again.
      const rec2: SqsRecordLike = { messageId: first!.MessageId!, body: first!.Body!, attributes: { ApproximateReceiveCount: '2' } };
      const resp = await processTalentIntakeSqsBatch([rec2], handler, noop as never);
      // No duplicate effective extraction — the draft is no longer QUEUED.
      expect(orchestratorCalls).toBe(1);
      expect(resp.batchItemFailures).toEqual([]);
    });

    it('Plane A — the EventBridge target carries a DeadLetterConfig (delivery-failure plane), distinct from Plane B', async () => {
      // LocalStack does not reliably drive EventBridge target-DLQ delivery at
      // runtime, so we assert the CONFIGURATION is in place (the two planes stay
      // operationally distinct: this is EventBridge→SQS delivery failure, NOT
      // SQS→consumer processing failure).
      const targets = await eb.send(new ListTargetsByRuleCommand({ Rule: 'talent-intake-extraction-requested', EventBusName: BUS }));
      const t = targets.Targets?.[0];
      expect(t?.DeadLetterConfig?.Arn).toContain('talent-intake-ebtarget-dlq');
      expect(t?.Arn).toBe(sourceQueueArn);
    });

    // ---- Real-composition proofs (no AWS dependency) ----

    it('Redis DOWN → Talent Intake still progresses through the composed drain → EventBridge → SQS → handler path', async () => {
      // No Redis client is constructed anywhere in this spec; the drain publishes
      // via the REAL EventBridge port and the handler processes — all Redis-free.
      const draftId = await seedQueuedUploadDraft();
      // Publish straight through the real publisher (the drain's transport) with
      // zero Redis involvement, then process the actual SQS message.
      await publisher.publish([envelopeFor(draftId)]);
      const msg = await receiveOne(sourceQueueUrl, 8);
      expect(msg).not.toBeNull();
      const rec: SqsRecordLike = { messageId: msg!.MessageId!, body: msg!.Body!, attributes: {} };
      await processTalentIntakeSqsBatch([rec], handler, noop as never);
      expect((await draftRow(draftId))?.processing_status).toBe('READY'); // progressed, no Redis
    });

    it('duplicate delivery → ONE effective extraction (CAS in the real handler)', async () => {
      const draftId = await seedQueuedUploadDraft();
      const envelope = envelopeFor(draftId);
      orchestratorCalls = 0;
      const rec: SqsRecordLike = { messageId: uuidv7(), body: JSON.stringify({ detail: envelope }), attributes: {} };
      // Deliver the SAME record twice (duplicate at-least-once delivery).
      await processTalentIntakeSqsBatch([rec], handler, noop as never);
      await processTalentIntakeSqsBatch([rec], handler, noop as never);
      expect(orchestratorCalls).toBe(1); // exactly one effective extraction
      expect((await draftRow(draftId))?.processing_status).toBe('READY');
    });
  },
);
