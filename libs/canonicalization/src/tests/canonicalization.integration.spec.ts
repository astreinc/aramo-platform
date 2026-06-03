import { readFileSync } from 'node:fs';
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
import { AramoError } from '@aramo/common';

import { CanonicalizationModule } from '../lib/canonicalization.module.js';
import { CanonicalizationOutboxRepository } from '../lib/canonicalization-outbox.repository.js';
import { CanonicalizationService } from '../lib/canonicalization.service.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

// T2-2a — canonicalization integration spec. Real Postgres 17 via
// testcontainers; ARAMO_RUN_INTEGRATION=1 gated.
//
// Covers Directive §4 proofs 1-4 (the integration-only proofs):
//   1. Happy CREATE-NEW   — core_talent_id=null → 1 Talent + 1 overlay +
//                           N contact-method evidence + resolved_talent_id
//                           set + talent.canonicalized event WRITTEN
//                           (unpublished — drain is T2-2b); ONE tx.
//   2. Happy ASSOCIATE    — core_talent_id provided → 0 new Talents
//                           (count unchanged); +1 overlay if new tenant;
//                           +N evidence; talent.canonicalized event WRITTEN.
//   3. Idempotency        — re-canonicalize the same payload → no-op
//                           (no dup Talent / overlay / evidence / outbox
//                           event; resolved_talent_id short-circuits).
//   4. Atomicity          — induce a mid-tx failure → Talent / overlay /
//                           evidence / outbox-event / resolved_talent_id
//                           ALL unchanged. Load-bearing per §1 Ruling 1.
//
// Proof 5 (no-resolution tripwire) — STATIC source-scan, lives in
// libs/canonicalization/src/tests/canonicalization.tripwires.spec.ts.
// Proof 6 (authorized-creation) — STATIC source-scan + tx-level
// observation, lives in canonicalization.tripwires.spec.ts.
// Proof 7 (R10/R12) — STATIC scan, lives in canonicalization.tripwires.spec.ts.
// Proof 8 (drift-tripwire) — lives in
// libs/canonicalization/src/tests/follower-drift.spec.ts.

const ROOT = resolve(__dirname, '../../../..');
const MIGRATIONS = [
  // talent (init) — Talent + TalentTenantOverlay.
  resolve(ROOT, 'libs/talent/prisma/migrations/20260516085014_init_talent_model/migration.sql'),
  // talent_evidence (init) — 7 evidence models + 10 enums.
  resolve(ROOT, 'libs/talent-evidence/prisma/migrations/20260519170000_init_talent_evidence_model/migration.sql'),
  // ingestion (init + skill_surface_forms + T2-2a additive).
  resolve(ROOT, 'libs/ingestion/prisma/migrations/20260516130715_init_ingestion_model/migration.sql'),
  resolve(ROOT, 'libs/ingestion/prisma/migrations/20260516183528_add_skill_surface_forms/migration.sql'),
  resolve(ROOT, 'libs/ingestion/prisma/migrations/20260603160100_add_resolved_talent_id_to_raw_payload_reference/migration.sql'),
  // canonicalization (init) — canonicalization PG schema + OutboxEvent.
  resolve(ROOT, 'libs/canonicalization/prisma/migrations/20260603160000_init_canonicalization_schema/migration.sql'),
];

// Mirrors libs/ingestion + libs/talent splitDdl: strip line comments,
// then split on statement-boundary semicolons.
function splitDdl(sql: string): string[] {
  const noLineComments = sql.replace(/--[^\n]*$/gm, '');
  return noLineComments
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const TENANT_ID = '11111111-1111-7111-8111-111111111111';
const OTHER_TENANT_ID = '22222222-2222-7222-8222-222222222222';

// Minimal test module — just CanonicalizationModule. The transitive Nest
// imports (IngestionModule → ConsentModule → BullMQ) wire with
// lazyConnect + manualRegistration so they no-op cleanly without Redis
// (the M5 PR-11 + libs/matching no-network-at-boot guarantee).
@Module({ imports: [CanonicalizationModule] })
class TestModule {}

interface PayloadSeed {
  id: string;
  tenant_id: string;
  source: string;
  storage_ref: string;
  sha256: string;
  content_type: string;
  captured_at: Date;
  verified_email: string | null;
  profile_url: string | null;
}

async function insertPayload(
  setup: Client,
  seed: PayloadSeed,
): Promise<void> {
  await setup.query(
    `INSERT INTO "ingestion"."RawPayloadReference"
       (id, tenant_id, source, storage_ref, sha256, content_type, captured_at,
        verified_email, profile_url, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
    [
      seed.id,
      seed.tenant_id,
      seed.source,
      seed.storage_ref,
      seed.sha256,
      seed.content_type,
      seed.captured_at,
      seed.verified_email,
      seed.profile_url,
    ],
  );
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'T2-2a — CanonicalizationService.canonicalize (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: TestingModule;
    let service: CanonicalizationService;
    let prisma: PrismaService;
    let outbox: CanonicalizationOutboxRepository;
    let dbClient: Client;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      // Apply migrations via a vanilla pg.Client so the canonicalization
      // PrismaService doesn't connect before the schemas exist.
      const setup = new Client({ connectionString: url });
      await setup.connect();
      for (const p of MIGRATIONS) {
        for (const stmt of splitDdl(readFileSync(p, 'utf8'))) {
          await setup.query(stmt);
        }
      }
      await setup.end();

      process.env['DATABASE_URL'] = url;
      app = await Test.createTestingModule({
        imports: [TestModule],
      }).compile();

      service = app.get(CanonicalizationService);
      prisma = app.get(PrismaService);
      outbox = app.get(CanonicalizationOutboxRepository);

      dbClient = new Client({ connectionString: url });
      await dbClient.connect();
    }, 120_000);

    afterAll(async () => {
      await dbClient?.end();
      await app?.close();
      await container?.stop();
    });

    // -------------------------------------------------------------------
    // Proof 1 — Happy CREATE-NEW (core_talent_id: null).
    // -------------------------------------------------------------------
    it('proof 1 — CREATE-NEW: creates 1 Talent + 1 overlay + N evidence + resolved_talent_id set + outbox event written', async () => {
      const payloadId = uuidv7();
      await insertPayload(dbClient, {
        id: payloadId,
        tenant_id: TENANT_ID,
        source: 'talent_direct',
        storage_ref: 's3://bucket/p1',
        sha256: 'a'.repeat(64),
        content_type: 'application/json',
        captured_at: new Date(),
        verified_email: 'alice@example.com',
        profile_url: 'https://linkedin.com/in/alice',
      });

      const beforeTalents = await dbClient.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "talent"."Talent"`,
      );

      const result = await service.canonicalize({
        payload_id: payloadId,
        core_talent_id: null,
        source_channel: 'self_signup',
        resolution_method: 'new_identity',
        authContext: { tenant_id: TENANT_ID },
        requestId: randomUUID(),
      });

      expect(result.already_canonicalized).toBe(false);
      expect(result.tenant_id).toBe(TENANT_ID);
      expect(result.resolution_method).toBe('new_identity');
      expect(result.outbox_event_id).not.toBeNull();
      expect(result.contact_methods_created).toBe(2);

      // +1 Talent.
      const afterTalents = await dbClient.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "talent"."Talent"`,
      );
      expect(Number(afterTalents.rows[0]!.count) - Number(beforeTalents.rows[0]!.count)).toBe(1);

      // +1 overlay for this (talent, tenant).
      const overlay = await dbClient.query(
        `SELECT * FROM "talent"."TalentTenantOverlay"
           WHERE talent_id = $1 AND tenant_id = $2`,
        [result.talent_id, TENANT_ID],
      );
      expect(overlay.rowCount).toBe(1);
      expect(overlay.rows[0].source_channel).toBe('self_signup');

      // +2 contact methods: verified email + linkedin URL.
      const contacts = await dbClient.query(
        `SELECT type, value, verification_status
           FROM "talent_evidence"."TalentContactMethod"
           WHERE talent_id = $1`,
        [result.talent_id],
      );
      expect(contacts.rowCount).toBe(2);
      const byType = new Map(
        contacts.rows.map((r: { type: string; value: string; verification_status: string }) => [r.type, r]),
      );
      expect(byType.get('email')?.value).toBe('alice@example.com');
      expect(byType.get('email')?.verification_status).toBe('verified');
      expect(byType.get('linkedin')?.value).toBe('https://linkedin.com/in/alice');
      expect(byType.get('linkedin')?.verification_status).toBe('unverified');

      // resolved_talent_id + resolution_method set on RawPayloadReference.
      const updatedPayload = await dbClient.query(
        `SELECT resolved_talent_id, resolution_method
           FROM "ingestion"."RawPayloadReference" WHERE id = $1`,
        [payloadId],
      );
      expect(updatedPayload.rows[0].resolved_talent_id).toBe(result.talent_id);
      expect(updatedPayload.rows[0].resolution_method).toBe('new_identity');

      // The talent.canonicalized event was written to the OUTBOX (unpublished
      // — drain is T2-2b). Payload includes talent_id + tenant_id +
      // resolution_method + payload_id.
      const outboxRow = await dbClient.query(
        `SELECT event_type, event_payload, published_at
           FROM "canonicalization"."OutboxEvent" WHERE id = $1`,
        [result.outbox_event_id],
      );
      expect(outboxRow.rowCount).toBe(1);
      expect(outboxRow.rows[0].event_type).toBe('talent.canonicalized');
      expect(outboxRow.rows[0].published_at).toBeNull();
      const payload = outboxRow.rows[0].event_payload as Record<string, unknown>;
      expect(payload['talent_id']).toBe(result.talent_id);
      expect(payload['tenant_id']).toBe(TENANT_ID);
      expect(payload['resolution_method']).toBe('new_identity');
      expect(payload['payload_id']).toBe(payloadId);
    });

    // -------------------------------------------------------------------
    // Proof 2 — Happy ASSOCIATE (core_talent_id provided).
    // -------------------------------------------------------------------
    it('proof 2 — ASSOCIATE: 0 new Talents (existing reused) + overlay if absent + evidence + outbox event', async () => {
      // Seed an existing Talent with no overlay for OTHER_TENANT_ID.
      const existingTalentId = uuidv7();
      await dbClient.query(
        `INSERT INTO "talent"."Talent" (id, lifecycle_status, updated_at)
           VALUES ($1, 'active', NOW())`,
        [existingTalentId],
      );

      const payloadId = uuidv7();
      await insertPayload(dbClient, {
        id: payloadId,
        tenant_id: OTHER_TENANT_ID,
        source: 'astre_import',
        storage_ref: 's3://bucket/p2',
        sha256: 'b'.repeat(64),
        content_type: 'application/json',
        captured_at: new Date(),
        verified_email: 'bob@example.com',
        profile_url: null,
      });

      const beforeTalents = await dbClient.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "talent"."Talent"`,
      );

      const result = await service.canonicalize({
        payload_id: payloadId,
        core_talent_id: existingTalentId,
        source_channel: 'import',
        resolution_method: 'caller_supplied',
        authContext: { tenant_id: OTHER_TENANT_ID },
        requestId: randomUUID(),
      });

      expect(result.already_canonicalized).toBe(false);
      expect(result.talent_id).toBe(existingTalentId);

      // 0 new Talents.
      const afterTalents = await dbClient.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "talent"."Talent"`,
      );
      expect(afterTalents.rows[0]!.count).toBe(beforeTalents.rows[0]!.count);

      // +1 overlay for (existing talent, OTHER_TENANT_ID).
      const overlay = await dbClient.query(
        `SELECT * FROM "talent"."TalentTenantOverlay"
           WHERE talent_id = $1 AND tenant_id = $2`,
        [existingTalentId, OTHER_TENANT_ID],
      );
      expect(overlay.rowCount).toBe(1);

      // +1 contact method (email only — no profile_url on this seed).
      const contacts = await dbClient.query(
        `SELECT type, value FROM "talent_evidence"."TalentContactMethod"
           WHERE talent_id = $1 AND tenant_id = $2`,
        [existingTalentId, OTHER_TENANT_ID],
      );
      expect(contacts.rowCount).toBe(1);
      expect(contacts.rows[0].type).toBe('email');

      // Outbox event written.
      const outboxRow = await dbClient.query(
        `SELECT event_type FROM "canonicalization"."OutboxEvent" WHERE id = $1`,
        [result.outbox_event_id],
      );
      expect(outboxRow.rowCount).toBe(1);
    });

    // -------------------------------------------------------------------
    // Proof 3 — Idempotency.
    // -------------------------------------------------------------------
    it('proof 3 — IDEMPOTENCY: re-canonicalize same payload → no-op (no dup writes)', async () => {
      const payloadId = uuidv7();
      await insertPayload(dbClient, {
        id: payloadId,
        tenant_id: TENANT_ID,
        source: 'talent_direct',
        storage_ref: 's3://bucket/p3',
        sha256: 'c'.repeat(64),
        content_type: 'application/json',
        captured_at: new Date(),
        verified_email: 'carol@example.com',
        profile_url: null,
      });

      // First canonicalize — produces a result.
      const first = await service.canonicalize({
        payload_id: payloadId,
        core_talent_id: null,
        source_channel: 'self_signup',
        resolution_method: 'new_identity',
        authContext: { tenant_id: TENANT_ID },
        requestId: randomUUID(),
      });
      expect(first.already_canonicalized).toBe(false);

      const talentCountAfterFirst = await dbClient.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "talent"."Talent"`,
      );
      const evidenceCountAfterFirst = await dbClient.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM "talent_evidence"."TalentContactMethod" WHERE talent_id = $1`,
        [first.talent_id],
      );
      const outboxCountAfterFirst = await dbClient.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM "canonicalization"."OutboxEvent"
           WHERE (event_payload->>'payload_id') = $1`,
        [payloadId],
      );

      // Second canonicalize — should be a no-op.
      const second = await service.canonicalize({
        payload_id: payloadId,
        core_talent_id: null,
        source_channel: 'self_signup',
        resolution_method: 'new_identity',
        authContext: { tenant_id: TENANT_ID },
        requestId: randomUUID(),
      });
      expect(second.already_canonicalized).toBe(true);
      expect(second.outbox_event_id).toBeNull();
      expect(second.contact_methods_created).toBe(0);
      expect(second.talent_id).toBe(first.talent_id);

      // No duplicate Talent / evidence / outbox event.
      const talentCountAfterSecond = await dbClient.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "talent"."Talent"`,
      );
      expect(talentCountAfterSecond.rows[0]!.count).toBe(talentCountAfterFirst.rows[0]!.count);

      const evidenceCountAfterSecond = await dbClient.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM "talent_evidence"."TalentContactMethod" WHERE talent_id = $1`,
        [first.talent_id],
      );
      expect(evidenceCountAfterSecond.rows[0]!.count).toBe(evidenceCountAfterFirst.rows[0]!.count);

      const outboxCountAfterSecond = await dbClient.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM "canonicalization"."OutboxEvent"
           WHERE (event_payload->>'payload_id') = $1`,
        [payloadId],
      );
      expect(outboxCountAfterSecond.rows[0]!.count).toBe(outboxCountAfterFirst.rows[0]!.count);
    });

    // -------------------------------------------------------------------
    // Proof 4 — Atomicity (LOAD-BEARING per Directive §1 Ruling 1).
    // Forces a mid-tx error by passing an INVALID core_talent_id AFTER
    // the SELECT FOR UPDATE — the canonicalize tx must rollback ALL
    // intermediate state (no Talent / overlay / evidence / outbox-event /
    // resolved_talent_id mutations).
    // -------------------------------------------------------------------
    it('proof 4 — ATOMICITY: a mid-tx failure rolls back ALL writes (Talent, overlay, evidence, outbox event, resolved_talent_id)', async () => {
      const payloadId = uuidv7();
      await insertPayload(dbClient, {
        id: payloadId,
        tenant_id: TENANT_ID,
        source: 'talent_direct',
        storage_ref: 's3://bucket/p4',
        sha256: 'd'.repeat(64),
        content_type: 'application/json',
        captured_at: new Date(),
        verified_email: 'dave@example.com',
        profile_url: 'https://github.com/dave',
      });

      // Snapshot counts before.
      const before = {
        talent: Number(
          (await dbClient.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM "talent"."Talent"`,
          )).rows[0]!.count,
        ),
        overlay: Number(
          (await dbClient.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM "talent"."TalentTenantOverlay"`,
          )).rows[0]!.count,
        ),
        contact: Number(
          (await dbClient.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM "talent_evidence"."TalentContactMethod"`,
          )).rows[0]!.count,
        ),
        outbox: Number(
          (await dbClient.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM "canonicalization"."OutboxEvent"`,
          )).rows[0]!.count,
        ),
      };

      // Trigger: pass a core_talent_id that does NOT exist. The
      // canonicalize tx acquires the FOR UPDATE row lock, reads the
      // payload (idempotency check passes — resolved_talent_id is NULL),
      // then THROWS at the tx.talent.findUnique → null branch. Prisma's
      // interactive tx rolls back the entire transaction on a thrown
      // error.
      const phantomTalentId = uuidv7();
      await expect(
        service.canonicalize({
          payload_id: payloadId,
          core_talent_id: phantomTalentId,
          source_channel: 'recruiter_capture',
          resolution_method: 'caller_supplied',
          authContext: { tenant_id: TENANT_ID },
          requestId: randomUUID(),
        }),
      ).rejects.toThrow(AramoError);

      // Snapshot counts after — every category unchanged.
      const after = {
        talent: Number(
          (await dbClient.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM "talent"."Talent"`,
          )).rows[0]!.count,
        ),
        overlay: Number(
          (await dbClient.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM "talent"."TalentTenantOverlay"`,
          )).rows[0]!.count,
        ),
        contact: Number(
          (await dbClient.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM "talent_evidence"."TalentContactMethod"`,
          )).rows[0]!.count,
        ),
        outbox: Number(
          (await dbClient.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM "canonicalization"."OutboxEvent"`,
          )).rows[0]!.count,
        ),
      };
      expect(after).toEqual(before);

      // The RawPayloadReference's resolved_talent_id MUST still be NULL.
      // If atomicity were broken (e.g. the tx had committed the
      // resolved_talent_id update before throwing), idempotency would
      // misfire on the next call.
      const payloadRow = await dbClient.query(
        `SELECT resolved_talent_id, resolution_method
           FROM "ingestion"."RawPayloadReference" WHERE id = $1`,
        [payloadId],
      );
      expect(payloadRow.rows[0].resolved_talent_id).toBeNull();
      expect(payloadRow.rows[0].resolution_method).toBeNull();
    });

    // -------------------------------------------------------------------
    // CROSS-TENANT REJECTION — confirms cross-tenant ABSORBED into
    // CANONICALIZATION_PAYLOAD_NOT_FOUND (no enumeration; A3 info-leak
    // precedent applied to T2-2a).
    // -------------------------------------------------------------------
    it('cross-tenant access is absorbed into CANONICALIZATION_PAYLOAD_NOT_FOUND', async () => {
      const payloadId = uuidv7();
      await insertPayload(dbClient, {
        id: payloadId,
        tenant_id: TENANT_ID,
        source: 'talent_direct',
        storage_ref: 's3://bucket/p5',
        sha256: 'e'.repeat(64),
        content_type: 'application/json',
        captured_at: new Date(),
        verified_email: null,
        profile_url: null,
      });

      // Caller from OTHER_TENANT_ID asking about TENANT_ID's payload.
      await expect(
        service.canonicalize({
          payload_id: payloadId,
          core_talent_id: null,
          source_channel: 'self_signup',
          resolution_method: 'new_identity',
          authContext: { tenant_id: OTHER_TENANT_ID },
          requestId: randomUUID(),
        }),
      ).rejects.toMatchObject({
        code: 'CANONICALIZATION_PAYLOAD_NOT_FOUND',
        statusCode: 404,
      });
    });

    // -------------------------------------------------------------------
    // T2-2b READINESS — the OutboxRepository surface that T2-2b consumes
    // is wired and exposes the expected (id, tenant_id, event_type,
    // event_payload, created_at) shape.
    // -------------------------------------------------------------------
    it('CanonicalizationOutboxRepository.findUnpublishedEvents returns the canonicalize-emitted events for T2-2b drain', async () => {
      const events = await outbox.findUnpublishedEvents({ limit: 100 });
      // At least one event from the prior proofs.
      expect(events.length).toBeGreaterThan(0);
      const sample = events[0]!;
      expect(sample.event_type).toBe('talent.canonicalized');
      expect(typeof sample.tenant_id).toBe('string');
      expect(typeof sample.id).toBe('string');
      expect(sample.created_at).toBeInstanceOf(Date);
    });

    // Silence unused-var lint for the prisma handle (kept for future
    // diagnostic queries inside the spec).
    void prisma;
  },
);
