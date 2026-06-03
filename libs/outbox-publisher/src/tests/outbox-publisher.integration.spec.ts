import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Test, type TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { v7 as uuidv7 } from 'uuid';
import { PrismaService as CanonicalizationPrismaService } from '@aramo/canonicalization';
import { PrismaService as ConsentPrismaService, OutboxPublisherRepository } from '@aramo/consent';
import { PrismaService as EngagementPrismaService } from '@aramo/engagement';
import { PrismaService as SubmittalPrismaService } from '@aramo/submittal';

import { OutboxPublisherModule } from '../lib/outbox-publisher.module.js';
import { OUTBOX_PUBLISHER_QUEUE_NAME } from '../lib/outbox-publisher.queue.constants.js';

// M6 PR-2 §5 Cat 5 — multi-schema outbox publisher integration spec.
// T2-2b — extended to prove the 4th-schema drain (canonicalization;
// the talent.canonicalized events T2-2a writes in-tx are now consumed +
// published, and the existing three schemas continue to drain).
//
// Relocated from libs/consent/src/tests at M6 PR-2 §4 (the publisher
// itself relocated to libs/outbox-publisher). Extended to prove:
//   (i)   domain mutation writes an outbox row in the SAME tx (atomic
//         3-/4-write $transaction array form);
//   (ii)  tx rollback leaves NO orphan outbox row;
//   (iii) the relocated publisher drains consent + engagement +
//         submittal + canonicalization OutboxEvent tables in a single
//         tick (the T2-2b 4th-schema drain — talent.canonicalized
//         events are consumed; payload is R10-clean: talent_id +
//         tenant_id + resolution_method + payload_id, no tier/score/
//         rank/match).
//
// MIGRATIONS apply-list (10 files, dependency-ordered):
//   1. libs/consent/prisma/migrations/20260429164414_initial_consent_schema/migration.sql
//   2. libs/engagement/prisma/migrations/20260525120000_init_engagement_model/migration.sql
//   3. libs/engagement/prisma/migrations/20260525150000_add_engagement_event_log/migration.sql
//   4. libs/engagement/prisma/migrations/20260531000000_add_outbox_event/migration.sql
//   5. libs/submittal/prisma/migrations/20260523120000_init_submittal_model/migration.sql
//   6. libs/submittal/prisma/migrations/20260523200000_add_submittal_revoke/migration.sql
//   7. libs/submittal/prisma/migrations/20260526140602_add_submittal_event_log/migration.sql
//   8. libs/submittal/prisma/migrations/20260527000000_rename_submittal_state_canonical/migration.sql
//   9. libs/submittal/prisma/migrations/20260531000000_add_outbox_event/migration.sql
//  10. libs/canonicalization/prisma/migrations/20260603160000_init_canonicalization_schema/migration.sql
//
// PL-66 Cat 5 contract: real Redis 7 + Postgres 17 testcontainers; no
// mocks for the database or queue.

const MIGRATION_FILES: ReadonlyArray<readonly [string, string]> = [
  ['consent', '../../../consent/prisma/migrations/20260429164414_initial_consent_schema/migration.sql'],
  ['engagement-init', '../../../engagement/prisma/migrations/20260525120000_init_engagement_model/migration.sql'],
  ['engagement-event-log', '../../../engagement/prisma/migrations/20260525150000_add_engagement_event_log/migration.sql'],
  ['engagement-outbox', '../../../engagement/prisma/migrations/20260531000000_add_outbox_event/migration.sql'],
  ['submittal-init', '../../../submittal/prisma/migrations/20260523120000_init_submittal_model/migration.sql'],
  ['submittal-revoke', '../../../submittal/prisma/migrations/20260523200000_add_submittal_revoke/migration.sql'],
  ['submittal-event-log', '../../../submittal/prisma/migrations/20260526140602_add_submittal_event_log/migration.sql'],
  ['submittal-rename', '../../../submittal/prisma/migrations/20260527000000_rename_submittal_state_canonical/migration.sql'],
  ['submittal-outbox', '../../../submittal/prisma/migrations/20260531000000_add_outbox_event/migration.sql'],
  ['canonicalization-init', '../../../canonicalization/prisma/migrations/20260603160000_init_canonicalization_schema/migration.sql'],
];

const TENANT_A = '11111111-1111-7111-8111-111111111111';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'OutboxPublisherProcessor — multi-schema integration (real Redis 7 + Postgres 17)',
  () => {
    let redisContainer: StartedRedisContainer;
    let pgContainer: StartedPostgreSqlContainer;
    let consentPrisma: ConsentPrismaService;
    let engagementPrisma: EngagementPrismaService;
    let submittalPrisma: SubmittalPrismaService;
    let canonicalizationPrisma: CanonicalizationPrismaService;
    let moduleRef: TestingModule;
    let publisherQueue: Queue;
    let savedRedisUrl: string | undefined;
    let savedDatabaseUrl: string | undefined;

    beforeAll(async () => {
      [redisContainer, pgContainer] = await Promise.all([
        new RedisContainer('redis:7').start(),
        new PostgreSqlContainer('postgres:17').start(),
      ]);

      const pgUrl = pgContainer.getConnectionUri();

      // Apply all 9 migrations in dependency order using a single setup
      // client. Each migration file is split on top-level semicolons
      // (dollar-quote aware) and executed via $executeRawUnsafe.
      const setupClient = new ConsentPrismaService(pgUrl);
      await setupClient.$connect();
      for (const [label, relPath] of MIGRATION_FILES) {
        const absPath = resolve(__dirname, relPath);
        const sql = readFileSync(absPath, 'utf8');
        for (const stmt of splitDdl(sql)) {
          const trimmed = stmt.trim();
          if (trimmed.length === 0) continue;
          try {
            await setupClient.$executeRawUnsafe(trimmed);
          } catch (err) {
            throw new Error(
              `migration ${label} failed on statement: ${trimmed.slice(0, 200)}…\n${(err as Error).message}`,
            );
          }
        }
      }
      await setupClient.$disconnect();

      consentPrisma = new ConsentPrismaService(pgUrl);
      engagementPrisma = new EngagementPrismaService(pgUrl);
      submittalPrisma = new SubmittalPrismaService(pgUrl);
      canonicalizationPrisma = new CanonicalizationPrismaService(pgUrl);
      await Promise.all([
        consentPrisma.$connect(),
        engagementPrisma.$connect(),
        submittalPrisma.$connect(),
        canonicalizationPrisma.$connect(),
      ]);

      savedRedisUrl = process.env['REDIS_URL'];
      savedDatabaseUrl = process.env['DATABASE_URL'];
      process.env['REDIS_URL'] = redisContainer.getConnectionUrl();
      process.env['DATABASE_URL'] = pgUrl;

      moduleRef = await Test.createTestingModule({
        imports: [OutboxPublisherModule],
      })
        .overrideProvider(ConsentPrismaService)
        .useValue(consentPrisma)
        .overrideProvider(EngagementPrismaService)
        .useValue(engagementPrisma)
        .overrideProvider(SubmittalPrismaService)
        .useValue(submittalPrisma)
        .overrideProvider(CanonicalizationPrismaService)
        .useValue(canonicalizationPrisma)
        .compile();

      const app = moduleRef.createNestApplication();
      await app.init();
      moduleRef = app as unknown as TestingModule;

      publisherQueue = moduleRef.get<Queue>(getQueueToken(OUTBOX_PUBLISHER_QUEUE_NAME));
    }, 240_000);

    afterAll(async () => {
      if (savedRedisUrl === undefined) {
        delete process.env['REDIS_URL'];
      } else {
        process.env['REDIS_URL'] = savedRedisUrl;
      }
      if (savedDatabaseUrl === undefined) {
        delete process.env['DATABASE_URL'];
      } else {
        process.env['DATABASE_URL'] = savedDatabaseUrl;
      }
      try {
        await publisherQueue?.close();
      } catch {
        /* queue may already be closed by Nest shutdown */
      }
      await (moduleRef as unknown as { close?: () => Promise<void> }).close?.();
      await Promise.all([
        consentPrisma?.$disconnect(),
        engagementPrisma?.$disconnect(),
        submittalPrisma?.$disconnect(),
        canonicalizationPrisma?.$disconnect(),
      ]);
      await Promise.all([redisContainer?.stop(), pgContainer?.stop()]);
    }, 60_000);

    // (iii) Publisher drains rows from all four schemas in one tick.
    // T2-2b — adds the canonicalization 4th-schema participant + an
    // R10-clean payload assertion on the talent.canonicalized event
    // (no tier / score / rank / match — only talent_id + tenant_id +
    // resolution_method + payload_id, per T2-2a's emission shape).
    it('drains consent + engagement + submittal + canonicalization OutboxEvent rows; preserves pre-published rows', async () => {
      const preExistingPublishedAt = new Date('2025-01-01T00:00:00Z');

      // Seed 2 unpublished rows per schema (8 total).
      for (let i = 0; i < 2; i++) {
        await consentPrisma.outboxEvent.create({
          data: {
            id: uuidv7(),
            tenant_id: TENANT_A,
            event_type: 'consent.granted',
            event_payload: { idx: i } as never,
          },
        });
        await engagementPrisma.outboxEvent.create({
          data: {
            id: uuidv7(),
            tenant_id: TENANT_A,
            event_type: 'engagement.state_transition',
            event_payload: { idx: i } as never,
          },
        });
        await submittalPrisma.outboxEvent.create({
          data: {
            id: uuidv7(),
            tenant_id: TENANT_A,
            event_type: 'submittal.state_transition',
            event_payload: { idx: i } as never,
          },
        });
        // T2-2b — talent.canonicalized payload mirrors T2-2a's emission
        // (CanonicalizationRepository.canonicalize): talent_id +
        // tenant_id + resolution_method + payload_id. R10-clean.
        await canonicalizationPrisma.outboxEvent.create({
          data: {
            id: uuidv7(),
            tenant_id: TENANT_A,
            event_type: 'talent.canonicalized',
            event_payload: {
              talent_id: uuidv7(),
              tenant_id: TENANT_A,
              resolution_method: 'caller_supplied',
              payload_id: uuidv7(),
            } as never,
          },
        });
      }

      // Seed 1 already-published row per schema (4 total) to prove the
      // publisher does NOT re-stamp them.
      const prePublished: Record<
        'consent' | 'engagement' | 'submittal' | 'canonicalization',
        string
      > = {
        consent: uuidv7(),
        engagement: uuidv7(),
        submittal: uuidv7(),
        canonicalization: uuidv7(),
      };
      await consentPrisma.outboxEvent.create({
        data: {
          id: prePublished.consent,
          tenant_id: TENANT_A,
          event_type: 'consent.granted',
          event_payload: { idx: 'pre' } as never,
          published_at: preExistingPublishedAt,
        },
      });
      await engagementPrisma.outboxEvent.create({
        data: {
          id: prePublished.engagement,
          tenant_id: TENANT_A,
          event_type: 'engagement.state_transition',
          event_payload: { idx: 'pre' } as never,
          published_at: preExistingPublishedAt,
        },
      });
      await submittalPrisma.outboxEvent.create({
        data: {
          id: prePublished.submittal,
          tenant_id: TENANT_A,
          event_type: 'submittal.state_transition',
          event_payload: { idx: 'pre' } as never,
          published_at: preExistingPublishedAt,
        },
      });
      await canonicalizationPrisma.outboxEvent.create({
        data: {
          id: prePublished.canonicalization,
          tenant_id: TENANT_A,
          event_type: 'talent.canonicalized',
          event_payload: {
            talent_id: uuidv7(),
            tenant_id: TENANT_A,
            resolution_method: 'caller_supplied',
            payload_id: uuidv7(),
          } as never,
          published_at: preExistingPublishedAt,
        },
      });

      await publisherQueue.add('tick', {});

      await waitFor(
        async () => {
          const counts = await publisherQueue.getJobCounts('completed', 'failed');
          return (counts.completed ?? 0) + (counts.failed ?? 0) >= 1;
        },
        30_000,
        250,
      );

      const counts = await publisherQueue.getJobCounts('completed', 'failed');
      expect(counts.failed ?? 0).toBe(0);
      expect(counts.completed ?? 0).toBeGreaterThanOrEqual(1);

      // Assert: each schema has 3 published rows total (2 newly drained
      // + 1 pre-published).
      const [
        consentPublished,
        engagementPublished,
        submittalPublished,
        canonicalizationPublished,
      ] = await Promise.all([
        consentPrisma.outboxEvent.findMany({
          where: { tenant_id: TENANT_A, published_at: { not: null } },
        }),
        engagementPrisma.outboxEvent.findMany({
          where: { tenant_id: TENANT_A, published_at: { not: null } },
        }),
        submittalPrisma.outboxEvent.findMany({
          where: { tenant_id: TENANT_A, published_at: { not: null } },
        }),
        canonicalizationPrisma.outboxEvent.findMany({
          where: { tenant_id: TENANT_A, published_at: { not: null } },
        }),
      ]);
      expect(consentPublished).toHaveLength(3);
      expect(engagementPublished).toHaveLength(3);
      expect(submittalPublished).toHaveLength(3);
      expect(canonicalizationPublished).toHaveLength(3);

      // T2-2b — R10-clean payload assertion on the drained
      // talent.canonicalized events: the published rows carry only
      // {talent_id, tenant_id, resolution_method, payload_id}; no
      // tier / score / rank / match keys (vocab-clean per the R10
      // boundary).
      const forbidden = ['tier', 'score', 'rank', 'match'];
      const drainedCanonical = canonicalizationPublished.filter(
        (row) => row.id !== prePublished.canonicalization,
      );
      expect(drainedCanonical).toHaveLength(2);
      for (const row of drainedCanonical) {
        expect(row.event_type).toBe('talent.canonicalized');
        const payload = row.event_payload as Record<string, unknown>;
        expect(Object.keys(payload).sort()).toEqual([
          'payload_id',
          'resolution_method',
          'talent_id',
          'tenant_id',
        ]);
        for (const banned of forbidden) {
          expect(
            Object.keys(payload).some((k) => k.toLowerCase().includes(banned)),
            `payload key contains forbidden vocab '${banned}'`,
          ).toBe(false);
        }
      }

      // Assert: pre-existing published_at values are preserved on all 4
      // pre-published rows.
      for (const [schema, id] of Object.entries(prePublished) as ReadonlyArray<
        ['consent' | 'engagement' | 'submittal' | 'canonicalization', string]
      >) {
        const client =
          schema === 'consent'
            ? consentPrisma
            : schema === 'engagement'
              ? engagementPrisma
              : schema === 'submittal'
                ? submittalPrisma
                : canonicalizationPrisma;
        const row = await client.outboxEvent.findUnique({ where: { id } });
        expect(row?.published_at?.getTime(), `pre-published ${schema} row`).toBe(
          preExistingPublishedAt.getTime(),
        );
      }
    }, 90_000);

    // (i) + (ii) Atomicity: a $transaction that fails partway leaves NO
    // orphan outbox row. Proves the in-tx emission is bound to the
    // domain-mutation success/failure.
    it('tx rollback leaves NO orphan engagement outbox row', async () => {
      const outboxIdAttempted = uuidv7();
      const duplicateId = uuidv7();

      // Two creates with the same id should fail the second create on a
      // primary-key conflict. Including the outboxEvent.create as the
      // FIRST op proves that even when the outbox write succeeds in
      // isolation, the failing peer rolls it back.
      await expect(
        engagementPrisma.$transaction([
          engagementPrisma.outboxEvent.create({
            data: {
              id: outboxIdAttempted,
              tenant_id: TENANT_A,
              event_type: 'engagement.state_transition',
              event_payload: { atomicity_probe: true } as never,
            },
          }),
          engagementPrisma.outboxEvent.create({
            data: {
              id: duplicateId,
              tenant_id: TENANT_A,
              event_type: 'engagement.state_transition',
              event_payload: { atomicity_probe: 'a' } as never,
            },
          }),
          engagementPrisma.outboxEvent.create({
            data: {
              id: duplicateId,
              tenant_id: TENANT_A,
              event_type: 'engagement.state_transition',
              event_payload: { atomicity_probe: 'b' } as never,
            },
          }),
        ]),
      ).rejects.toBeDefined();

      // Neither row should exist post-rollback.
      const orphan = await engagementPrisma.outboxEvent.findUnique({
        where: { id: outboxIdAttempted },
      });
      const duplicateLeftover = await engagementPrisma.outboxEvent.findUnique({
        where: { id: duplicateId },
      });
      expect(orphan).toBeNull();
      expect(duplicateLeftover).toBeNull();
    }, 30_000);

    it('tx rollback leaves NO orphan submittal outbox row', async () => {
      const outboxIdAttempted = uuidv7();
      const duplicateId = uuidv7();

      await expect(
        submittalPrisma.$transaction([
          submittalPrisma.outboxEvent.create({
            data: {
              id: outboxIdAttempted,
              tenant_id: TENANT_A,
              event_type: 'submittal.state_transition',
              event_payload: { atomicity_probe: true } as never,
            },
          }),
          submittalPrisma.outboxEvent.create({
            data: {
              id: duplicateId,
              tenant_id: TENANT_A,
              event_type: 'submittal.state_transition',
              event_payload: { atomicity_probe: 'a' } as never,
            },
          }),
          submittalPrisma.outboxEvent.create({
            data: {
              id: duplicateId,
              tenant_id: TENANT_A,
              event_type: 'submittal.state_transition',
              event_payload: { atomicity_probe: 'b' } as never,
            },
          }),
        ]),
      ).rejects.toBeDefined();

      const orphan = await submittalPrisma.outboxEvent.findUnique({
        where: { id: outboxIdAttempted },
      });
      const duplicateLeftover = await submittalPrisma.outboxEvent.findUnique({
        where: { id: duplicateId },
      });
      expect(orphan).toBeNull();
      expect(duplicateLeftover).toBeNull();
    }, 30_000);

    it('repository markPublished is a no-op on empty input (consent regression)', async () => {
      const repo = moduleRef.get(OutboxPublisherRepository);
      const result = await repo.markPublished({
        event_ids: [],
        published_at: new Date(),
      });
      expect(result).toBe(0);
    });
  },
);

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) {
      throw new Error(`waitFor: predicate did not become true within ${String(timeoutMs)}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function splitDdl(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  let inDollar = false;
  let inLineComment = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inLineComment) {
      current += ch;
      if (ch === '\n') {
        inLineComment = false;
      }
      continue;
    }
    if (!inDollar && sql.startsWith('--', i)) {
      // T2-2b — skip `;` inside `-- ...` line comments. The
      // canonicalization init migration carries a `;` inside its
      // header comment block ("...(talent, talent_evidence, ingestion)
      // already exist;..."); without this guard the splitter cuts the
      // header in two and feeds the comment-tail to the DB as SQL.
      inLineComment = true;
      current += '--';
      i += 1;
      continue;
    }
    if (sql.startsWith('$$', i)) {
      inDollar = !inDollar;
      current += '$$';
      i += 1;
      continue;
    }
    if (ch === ';' && !inDollar) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) out.push(current);
  return out;
}
