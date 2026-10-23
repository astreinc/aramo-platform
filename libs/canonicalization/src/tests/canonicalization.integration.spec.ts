import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Module } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { v7 as uuidv7 } from 'uuid';
import { Client } from 'pg';
import { ARAMO_POSTGRES_TEST_IMAGE, AramoError } from '@aramo/common';

import { CanonicalizationModule } from '../lib/canonicalization.module.js';
import { CanonicalizationOutboxRepository } from '../lib/canonicalization-outbox.repository.js';
import { CanonicalizationService } from '../lib/canonicalization.service.js';
import { CanonicalizationTriggerProcessor } from '../lib/canonicalization-trigger.processor.js';

// ATI-SEP-1 T10 WP2 — canonicalization integration spec (real Postgres 17;
// ARAMO_RUN_INTEGRATION=1 gated). canonicalize resolves each ingestion arrival to
// an ATS-local sourced_talent.SourcedTalent row keyed by (tenant, channel,
// external id), writes RawPayloadReference.sourced_talent_id (the idempotency
// anchor + poll gate) and an arrival-keyed talent.canonicalized outbox event.
// The retired trust subject / identity-index cluster are never written — their
// schemas are not even migrated here.
//
// Structural tripwires (no DB): canonicalization.tripwires.spec.ts +
// follower-drift.spec.ts.

const ROOT = resolve(__dirname, '../../../..');

function migrationsFor(lib: string): string[] {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}

const MIGRATIONS = [
  ...migrationsFor('ingestion'),
  ...migrationsFor('canonicalization'),
  ...migrationsFor('sourced-talent'),
];

// $$-aware DDL splitter (the immutability triggers carry `;` inside `$$`).
function splitDdl(sql: string): string[] {
  const noLineComments = sql.replace(/--[^\n]*$/gm, '');
  const out: string[] = [];
  let current = '';
  let inDollar = false;
  for (let i = 0; i < noLineComments.length; i++) {
    if (noLineComments.startsWith('$$', i)) {
      inDollar = !inDollar;
      current += '$$';
      i += 1;
      continue;
    }
    const ch = noLineComments[i];
    if (ch === ';' && !inDollar) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) out.push(current);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

const TENANT_ID = '11111111-1111-7111-8111-111111111111';
const OTHER_TENANT_ID = '22222222-2222-7222-8222-222222222222';

@Module({ imports: [CanonicalizationModule] })
class TestModule {}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'ATI-SEP-1 T10 WP2 — CanonicalizationService.canonicalize → sourced_talent (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: TestingModule;
    let service: CanonicalizationService;
    let outbox: CanonicalizationOutboxRepository;
    let triggerProcessor: CanonicalizationTriggerProcessor;
    let db: Client;

    async function insertPayload(over: {
      tenant_id?: string;
      source?: string;
      email?: string | null;
      profile_url?: string | null;
      name?: string | null;
      sha?: string;
    } = {}): Promise<string> {
      const id = uuidv7();
      const source = over.source ?? 'talent_direct';
      await db.query(
        `INSERT INTO "ingestion"."RawPayloadReference"
           (id, tenant_id, source, source_class, storage_ref, sha256, content_type,
            captured_at, verified_email, profile_url, declared_name, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'application/json', NOW(), $7, $8, $9, NOW())`,
        [
          id,
          over.tenant_id ?? TENANT_ID,
          source,
          source === 'talent_direct' ? 'SELF' : 'THIRD_PARTY_UNVERIFIED',
          `s3://bucket/${id}`,
          over.sha ?? `sha-${id}`,
          over.email ?? null,
          over.profile_url ?? null,
          over.name ?? null,
        ],
      );
      return id;
    }

    async function payloadRow(id: string): Promise<Record<string, unknown>> {
      const r = await db.query(
        `SELECT sourced_talent_id, resolved_subject_id, resolved_cluster_id, resolution_method
           FROM "ingestion"."RawPayloadReference" WHERE id = $1`,
        [id],
      );
      return r.rows[0];
    }

    async function arrivalCount(tenant = TENANT_ID): Promise<number> {
      const r = await db.query(
        `SELECT count(*)::int AS n FROM "sourced_talent"."SourcedTalent" WHERE tenant_id = $1`,
        [tenant],
      );
      return r.rows[0].n as number;
    }

    const canon = (payload_id: string, tenant_id = TENANT_ID) =>
      service.canonicalize({
        payload_id,
        source_channel: 'self_signup',
        authContext: { tenant_id },
        requestId: randomUUID(),
      });

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const url = container.getConnectionUri();
      const setup = new Client({ connectionString: url });
      await setup.connect();
      for (const p of MIGRATIONS) {
        for (const stmt of splitDdl(readFileSync(p, 'utf8'))) await setup.query(stmt);
      }
      await setup.end();
      process.env['DATABASE_URL'] = url;
      app = await Test.createTestingModule({ imports: [TestModule] }).compile();
      service = app.get(CanonicalizationService);
      outbox = app.get(CanonicalizationOutboxRepository);
      triggerProcessor = app.get(CanonicalizationTriggerProcessor);
      db = new Client({ connectionString: url });
      await db.connect();
    }, 120_000);

    afterAll(async () => {
      await db?.end();
      await app?.close();
      await container?.stop();
    });

    it('NEW arrival: one SourcedTalent (channel = source, external id = content hash), anchor written, legacy ids untouched, arrival-keyed outbox', async () => {
      const before = await arrivalCount();
      const sha = `sha-new-${randomUUID()}`;
      const payloadId = await insertPayload({ email: ' Ada@Example.com ', name: 'Ada Lovelace', sha });
      const result = await canon(payloadId);
      expect(result.already_canonicalized).toBe(false);
      expect(result.resolution_method).toBe('new_identity');
      expect(result.outbox_event_id).not.toBeNull();
      expect(await arrivalCount()).toBe(before + 1);

      const st = await db.query(
        `SELECT source_channel, external_source_id, normalized_email, provenance
           FROM "sourced_talent"."SourcedTalent" WHERE id = $1`,
        [result.sourced_talent_id],
      );
      expect(st.rows[0].source_channel).toBe('TALENT_DIRECT');
      expect(st.rows[0].external_source_id).toBe(sha);
      expect(st.rows[0].normalized_email).toBe('ada@example.com');
      expect(st.rows[0].provenance.ingestion_payload_id).toBe(payloadId);
      expect(st.rows[0].provenance.applicant.full_name).toBe('Ada Lovelace');

      expect(await payloadRow(payloadId)).toEqual({
        sourced_talent_id: result.sourced_talent_id,
        resolved_subject_id: null,
        resolved_cluster_id: null,
        resolution_method: 'new_identity',
      });
      const events = await outbox.findUnpublishedEvents({ limit: 1000 });
      const ev = events.find((e) => e.id === result.outbox_event_id);
      expect(ev?.event_payload).toEqual({
        sourced_talent_id: result.sourced_talent_id,
        tenant_id: TENANT_ID,
        resolution_method: 'new_identity',
        payload_id: payloadId,
      });
      const keys = Object.keys((ev?.event_payload ?? {}) as Record<string, unknown>);
      for (const forbidden of ['tier', 'score', 'rank', 'subject_id', 'talent_id']) {
        expect(keys).not.toContain(forbidden);
      }
    });

    it('IDEMPOTENCY: re-canonicalize the same payload → no-op (no new arrival / outbox)', async () => {
      const payloadId = await insertPayload();
      const first = await canon(payloadId);
      const arrivals = await arrivalCount();
      const events = (await outbox.findUnpublishedEvents({ limit: 1000 })).length;
      const second = await canon(payloadId);
      expect(second.already_canonicalized).toBe(true);
      expect(second.sourced_talent_id).toBe(first.sourced_talent_id);
      expect(second.outbox_event_id).toBeNull();
      expect(await arrivalCount()).toBe(arrivals);
      expect((await outbox.findUnpublishedEvents({ limit: 1000 })).length).toBe(events);
    });

    it('DEDUP MEMORY: two payloads of the same channel profile resolve to the SAME arrival (per external id)', async () => {
      const url = `https://github.com/p-${randomUUID()}`;
      const a = await canon(await insertPayload({ source: 'github', profile_url: url }));
      const b = await canon(await insertPayload({ source: 'github', profile_url: url }));
      expect(b.sourced_talent_id).toBe(a.sourced_talent_id);
      expect(b.resolution_method).toBe('confirmed_anchor_match');
      const st = await db.query(
        `SELECT source_channel, external_source_id FROM "sourced_talent"."SourcedTalent" WHERE id = $1`,
        [a.sourced_talent_id],
      );
      expect(st.rows[0]).toEqual({ source_channel: 'GITHUB', external_source_id: url });
    });

    it('a channel writer’s own arrival for the payload (provenance.ingestion_payload_id) is REUSED, not duplicated', async () => {
      const payloadId = await insertPayload({ source: 'indeed' });
      const own = uuidv7();
      await db.query(
        `INSERT INTO "sourced_talent"."SourcedTalent"
           (id, tenant_id, source_channel, external_source_id, provenance, legal_basis, arrived_at)
         VALUES ($1, $2, 'INDEED', $3, $4::jsonb, '{}'::jsonb, NOW())`,
        [own, TENANT_ID, `apply-${own}`, JSON.stringify({ ingestion_payload_id: payloadId })],
      );
      const before = await arrivalCount();
      const r = await canon(payloadId);
      expect(r.sourced_talent_id).toBe(own);
      expect(await arrivalCount()).toBe(before);
    });

    it('ATOMICITY: a failure after the arrival write rolls back the payload decision + outbox; the retry reuses the arrival', async () => {
      const payloadId = await insertPayload();
      const eventsBefore = (await outbox.findUnpublishedEvents({ limit: 1000 })).length;
      await db.query(`ALTER TABLE "canonicalization"."OutboxEvent" RENAME TO "OutboxEvent_off"`);
      try {
        await expect(canon(payloadId)).rejects.toThrow();
      } finally {
        await db.query(`ALTER TABLE "canonicalization"."OutboxEvent_off" RENAME TO "OutboxEvent"`);
      }
      expect((await payloadRow(payloadId))['sourced_talent_id']).toBeNull();
      expect((await outbox.findUnpublishedEvents({ limit: 1000 })).length).toBe(eventsBefore);
      const arrivals = await arrivalCount();
      const retry = await canon(payloadId);
      expect(retry.already_canonicalized).toBe(false);
      expect(await arrivalCount()).toBe(arrivals); // the orphan-safe arrival is reused
      expect((await payloadRow(payloadId))['sourced_talent_id']).toBe(retry.sourced_talent_id);
    });

    it('cross-tenant access is absorbed into CANONICALIZATION_PAYLOAD_NOT_FOUND (no arrival written)', async () => {
      const payloadId = await insertPayload();
      const before = await arrivalCount(OTHER_TENANT_ID);
      await expect(canon(payloadId, OTHER_TENANT_ID)).rejects.toSatisfy(
        (e: unknown) => e instanceof AramoError && e.code === 'CANONICALIZATION_PAYLOAD_NOT_FOUND',
      );
      expect(await arrivalCount(OTHER_TENANT_ID)).toBe(before);
      expect((await payloadRow(payloadId))['sourced_talent_id']).toBeNull();
    });

    it('THE TRIGGER: the processor drains un-resolved payloads (sourced_talent_id IS NULL); a min-age holds fresh rows back', async () => {
      const payloadId = await insertPayload();
      const held = await triggerProcessor.drainBatch({ batchSize: 1000, jobId: 'held', minAgeMs: 60_000 });
      expect(held.failed).toBe(0);
      expect((await payloadRow(payloadId))['sourced_talent_id']).toBeNull();

      const drain1 = await triggerProcessor.drainBatch({ batchSize: 1000, jobId: 'wp2-trigger' });
      expect(drain1.attempted).toBeGreaterThan(0);
      expect(drain1.failed).toBe(0);
      const row = await payloadRow(payloadId);
      expect(row['sourced_talent_id']).not.toBeNull();

      const drain2 = await triggerProcessor.drainBatch({ batchSize: 1000, jobId: 'wp2-trigger-2' });
      expect(drain2.failed).toBe(0);
      expect((await payloadRow(payloadId))['sourced_talent_id']).toBe(row['sourced_talent_id']);
    });
  },
);
