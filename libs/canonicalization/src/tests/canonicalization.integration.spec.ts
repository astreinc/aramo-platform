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
import { CanonicalizationRepository } from '../lib/canonicalization.repository.js';
import { CanonicalizationService } from '../lib/canonicalization.service.js';
import { CanonicalizationTriggerProcessor } from '../lib/canonicalization-trigger.processor.js';
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
  // ingestion (4b additive) — resolved_cluster_id.
  resolve(ROOT, 'libs/ingestion/prisma/migrations/20260630120000_add_resolved_cluster_id_to_raw_payload_reference/migration.sql'),
  // canonicalization (init) — canonicalization PG schema + OutboxEvent.
  resolve(ROOT, 'libs/canonicalization/prisma/migrations/20260603160000_init_canonicalization_schema/migration.sql'),
  // identity_index (init, 4b) — PersonCluster + ClusterFingerprint (the
  // PII-free cross-tenant resolution index the resolver now keys to).
  resolve(ROOT, 'libs/identity-index/prisma/migrations/20260630000000_init_identity_index/migration.sql'),
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
    let triggerProcessor: CanonicalizationTriggerProcessor;
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
      // Step 4b — the resolver fingerprints verified emails; the pepper must
      // be set or loadIdentityPepper fails loud (see the dedicated fail-loud
      // proof, which unsets it for one assertion).
      process.env['ARAMO_IDENTITY_PEPPER'] = 'canonicalization-integration-pepper';
      app = await Test.createTestingModule({
        imports: [TestModule],
      }).compile();

      service = app.get(CanonicalizationService);
      prisma = app.get(PrismaService);
      outbox = app.get(CanonicalizationOutboxRepository);
      triggerProcessor = app.get(CanonicalizationTriggerProcessor);

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

    // ===================================================================
    // T2-3 — RESOLUTION + TRIGGER proofs (§4 of the T2-3 Gate-5 prompt).
    //
    //   1. Resolution NEW identity (verified email unseen → CREATE-NEW).
    //   2. Resolution EXISTING identity (verified email matches existing
    //      verified TalentContactMethod → resolves to that Talent +
    //      new overlay if absent for the incoming tenant; no new Talent).
    //   3. CROSS-TENANT resolution (T2-1 model: same verified email
    //      arriving in a DIFFERENT tenant → resolves to the same Core
    //      Talent + a new tenant overlay; Talent count +0; overlay +1).
    //   4. UNVERIFIED email does NOT resolve (existing contact-method
    //      with verification_status='unverified' is held as evidence,
    //      not an identity key → CREATE-NEW Talent).
    //   5. The trigger: an unresolved RawPayloadReference → trigger
    //      processor drains it → canonicalize fires automatically →
    //      resolved_talent_id set + Talent + overlay + evidence + outbox
    //      event written.
    //   6. Trigger durability + idempotency: a re-fired tick is a no-op
    //      (polling query excludes resolved rows; canonicalize's
    //      resolved_talent_id short-circuit catches any race). A failed
    //      canonicalize leaves the row unresolved → next tick re-picks.
    //   7. Boundary tripwire (re-frame): resolution lives IN Core
    //      canonicalization (the prior 4 proofs are the positive
    //      evidence). The ATS no-resolution tripwire lives separately at
    //      apps/api/src/tests/ats-batch4b-talent-link.integration.spec.ts
    //      and is asserted there — this spec confirms the Core side.
    //   8. R10: the resolution result + the emitted outbox event carry
    //      no tier/score/rank/match output vocabulary.
    // ===================================================================

    // T2-3 tenant IDs distinct from TENANT_ID / OTHER_TENANT_ID to keep
    // the cross-tenant proof independent of prior fixtures.
    const TENANT_A = '33333333-3333-7333-8333-333333333333';
    const TENANT_B = '44444444-4444-7444-8444-444444444444';

    it('T2-3 proof 1 — RESOLUTION NEW IDENTITY: never-seen verified email + core_talent_id omitted → CREATE-NEW Talent (resolution_method = new_identity)', async () => {
      const payloadId = uuidv7();
      const uniqueEmail = `t2-3-new-${randomUUID()}@example.com`;
      await insertPayload(dbClient, {
        id: payloadId,
        tenant_id: TENANT_A,
        source: 'talent_direct',
        storage_ref: 's3://bucket/t2-3-p1',
        sha256: 't2-3-p1-' + 'a'.repeat(56),
        content_type: 'application/json',
        captured_at: new Date(),
        verified_email: uniqueEmail,
        profile_url: null,
      });

      const beforeTalents = await dbClient.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "talent"."Talent"`,
      );

      // Production-path invocation: core_talent_id + resolution_method
      // are OMITTED — the inline resolver runs.
      const result = await service.canonicalize({
        payload_id: payloadId,
        source_channel: 'self_signup',
        authContext: { tenant_id: TENANT_A },
        requestId: randomUUID(),
      });

      expect(result.already_canonicalized).toBe(false);
      expect(result.resolution_method).toBe('new_identity');
      expect(result.outbox_event_id).not.toBeNull();

      // +1 Talent (the resolver missed and CREATE-NEW fired).
      const afterTalents = await dbClient.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "talent"."Talent"`,
      );
      expect(
        Number(afterTalents.rows[0]!.count) -
          Number(beforeTalents.rows[0]!.count),
      ).toBe(1);

      // RawPayloadReference.resolution_method = 'new_identity' (the
      // computed value the service wrote — not caller_supplied).
      const updatedPayload = await dbClient.query(
        `SELECT resolved_talent_id, resolution_method
           FROM "ingestion"."RawPayloadReference" WHERE id = $1`,
        [payloadId],
      );
      expect(updatedPayload.rows[0].resolved_talent_id).toBe(result.talent_id);
      expect(updatedPayload.rows[0].resolution_method).toBe('new_identity');
    });

    it('T2-3 proof 2 — RESOLUTION EXISTING IDENTITY (same tenant): verified email matches an existing verified TalentContactMethod → resolves to that Talent (resolution_method = verified_email_match; Talent count +0)', async () => {
      // Seed an existing Talent in TENANT_A via a prior canonicalize call
      // (the cheapest deterministic way to produce a verified
      // TalentContactMethod row, since the canonicalize tx is the only
      // writer per the proof-7 R12 invariant).
      const seedEmail = `t2-3-existing-${randomUUID()}@example.com`;
      const seedPayloadId = uuidv7();
      await insertPayload(dbClient, {
        id: seedPayloadId,
        tenant_id: TENANT_A,
        source: 'talent_direct',
        storage_ref: 's3://bucket/t2-3-p2-seed',
        sha256: 't2-3-p2-seed' + 'b'.repeat(52),
        content_type: 'application/json',
        captured_at: new Date(),
        verified_email: seedEmail,
        profile_url: null,
      });
      const seed = await service.canonicalize({
        payload_id: seedPayloadId,
        source_channel: 'self_signup',
        authContext: { tenant_id: TENANT_A },
        requestId: randomUUID(),
      });
      expect(seed.resolution_method).toBe('new_identity');

      // A SECOND payload arrives in the SAME tenant with the SAME
      // verified email. The resolver should hit and resolve to seed
      // Talent (no new Talent).
      const payloadId = uuidv7();
      await insertPayload(dbClient, {
        id: payloadId,
        tenant_id: TENANT_A,
        source: 'astre_import',
        storage_ref: 's3://bucket/t2-3-p2',
        sha256: 't2-3-p2-' + 'c'.repeat(56),
        content_type: 'application/json',
        captured_at: new Date(),
        verified_email: seedEmail,
        profile_url: null,
      });

      const beforeTalents = await dbClient.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "talent"."Talent"`,
      );

      const result = await service.canonicalize({
        payload_id: payloadId,
        source_channel: 'import',
        authContext: { tenant_id: TENANT_A },
        requestId: randomUUID(),
      });

      expect(result.already_canonicalized).toBe(false);
      expect(result.resolution_method).toBe('verified_email_match');
      expect(result.talent_id).toBe(seed.talent_id);

      // Talent count UNCHANGED (the resolver hit; no new Talent created).
      const afterTalents = await dbClient.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "talent"."Talent"`,
      );
      expect(afterTalents.rows[0]!.count).toBe(beforeTalents.rows[0]!.count);

      // RawPayloadReference.resolution_method = 'verified_email_match'.
      const updatedPayload = await dbClient.query(
        `SELECT resolved_talent_id, resolution_method
           FROM "ingestion"."RawPayloadReference" WHERE id = $1`,
        [payloadId],
      );
      expect(updatedPayload.rows[0].resolved_talent_id).toBe(seed.talent_id);
      expect(updatedPayload.rows[0].resolution_method).toBe('verified_email_match');
    });

    it('T2-3 proof 3 (4b) — CROSS-TENANT IDENTITY MOVES TO THE CLUSTER, NO CROSS-TENANT EMAIL READ: same verified email in TENANT_A then TENANT_B → DISTINCT per-tenant Core husks BUT the SAME PERSON_CLUSTER (resolved via fingerprint, not a cross-tenant email read)', async () => {
      // Seed in TENANT_A.
      const seedEmail = `t2-3-cross-${randomUUID()}@example.com`;
      const seedPayloadId = uuidv7();
      await insertPayload(dbClient, {
        id: seedPayloadId,
        tenant_id: TENANT_A,
        source: 'talent_direct',
        storage_ref: 's3://bucket/t2-3-p3-seed',
        sha256: 't2-3-p3-seed' + 'd'.repeat(52),
        content_type: 'application/json',
        captured_at: new Date(),
        verified_email: seedEmail,
        profile_url: null,
      });
      const seed = await service.canonicalize({
        payload_id: seedPayloadId,
        source_channel: 'self_signup',
        authContext: { tenant_id: TENANT_A },
        requestId: randomUUID(),
      });

      // A payload arrives in TENANT_B with the SAME verified email.
      // 4b rule: cross-tenant same-human resolution is the CLUSTER's job
      // (fingerprint-matched, PII-free). The per-tenant Core husk is resolved
      // WITHIN the tenant only — so TENANT_B gets its OWN new husk (the
      // tenant-filtered findFirst CANNOT see TENANT_A's contact method).
      // Expected:
      //   - resolution_method = 'new_identity' (no within-tenant husk in B).
      //   - A DISTINCT Core husk (talent_id != TENANT_A's).
      //   - Talent count +1.
      //   - The SAME resolved_cluster_id as TENANT_A (cross-tenant identity).
      const payloadId = uuidv7();
      await insertPayload(dbClient, {
        id: payloadId,
        tenant_id: TENANT_B,
        source: 'astre_import',
        storage_ref: 's3://bucket/t2-3-p3',
        sha256: 't2-3-p3-' + 'e'.repeat(56),
        content_type: 'application/json',
        captured_at: new Date(),
        verified_email: seedEmail,
        profile_url: null,
      });

      const beforeTalents = await dbClient.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "talent"."Talent"`,
      );

      const result = await service.canonicalize({
        payload_id: payloadId,
        source_channel: 'import',
        authContext: { tenant_id: TENANT_B },
        requestId: randomUUID(),
      });

      // NO cross-tenant email read: TENANT_B did NOT resolve to TENANT_A's
      // husk. It minted its own (new_identity), proving the findFirst is
      // tenant-scoped.
      expect(result.resolution_method).toBe('new_identity');
      expect(result.talent_id).not.toBe(seed.talent_id);
      expect(result.tenant_id).toBe(TENANT_B);

      // Talent count +1 (a DISTINCT per-tenant husk — no cross-tenant sharing).
      const afterTalents = await dbClient.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "talent"."Talent"`,
      );
      expect(
        Number(afterTalents.rows[0]!.count) -
          Number(beforeTalents.rows[0]!.count),
      ).toBe(1);

      // THE CROSS-TENANT IDENTITY: both payloads resolved to the SAME
      // PERSON_CLUSTER — established by fingerprint, never by reading the
      // other tenant's email. resolved_cluster_id is set + equal across the
      // two tenants; resolved_talent_id (the husks) differ.
      const clusters = await dbClient.query<{
        id: string;
        resolved_talent_id: string;
        resolved_cluster_id: string | null;
      }>(
        `SELECT id, resolved_talent_id, resolved_cluster_id
           FROM "ingestion"."RawPayloadReference"
          WHERE id = ANY($1::uuid[])`,
        [[seedPayloadId, payloadId]],
      );
      const seedRow = clusters.rows.find((r) => r.id === seedPayloadId)!;
      const bRow = clusters.rows.find((r) => r.id === payloadId)!;
      expect(seedRow.resolved_cluster_id).not.toBeNull();
      expect(bRow.resolved_cluster_id).toBe(seedRow.resolved_cluster_id);
      expect(bRow.resolved_talent_id).not.toBe(seedRow.resolved_talent_id);

      // Exactly ONE cluster + ONE fingerprint for this email across both
      // tenants (the index is tenant-agnostic; the fingerprint @@unique
      // converged them).
      const clusterCount = await dbClient.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM "identity_index"."ClusterFingerprint"
          WHERE cluster_id = $1`,
        [seedRow.resolved_cluster_id],
      );
      expect(clusterCount.rows[0]!.count).toBe('1');
    });

    it('T2-3 proof 3b (4b) — WITHIN-TENANT DEDUP INTACT + SAME CLUSTER: same verified email, same tenant, two payloads → the SAME Core husk (tenant-filter preserves dedup) AND the same cluster', async () => {
      const email = `t2-3-within-${randomUUID()}@example.com`;
      const p1 = uuidv7();
      const p2 = uuidv7();
      for (const [pid, ref] of [[p1, 'w1'], [p2, 'w2']] as const) {
        await insertPayload(dbClient, {
          id: pid,
          tenant_id: TENANT_A,
          source: 'talent_direct',
          storage_ref: `s3://bucket/t2-3-p3b-${ref}`,
          sha256: `t2-3-p3b-${ref}` + 'f'.repeat(52),
          content_type: 'application/json',
          captured_at: new Date(),
          verified_email: email,
          profile_url: null,
        });
      }
      const r1 = await service.canonicalize({
        payload_id: p1,
        source_channel: 'self_signup',
        authContext: { tenant_id: TENANT_A },
        requestId: randomUUID(),
      });
      const r2 = await service.canonicalize({
        payload_id: p2,
        source_channel: 'self_signup',
        authContext: { tenant_id: TENANT_A },
        requestId: randomUUID(),
      });

      // Within-tenant dedup intact: second payload reuses the first husk.
      expect(r1.resolution_method).toBe('new_identity');
      expect(r2.resolution_method).toBe('verified_email_match');
      expect(r2.talent_id).toBe(r1.talent_id);

      // Both share the same cluster.
      const rows = await dbClient.query<{ id: string; resolved_cluster_id: string | null }>(
        `SELECT id, resolved_cluster_id FROM "ingestion"."RawPayloadReference"
          WHERE id = ANY($1::uuid[])`,
        [[p1, p2]],
      );
      const c1 = rows.rows.find((r) => r.id === p1)!.resolved_cluster_id;
      const c2 = rows.rows.find((r) => r.id === p2)!.resolved_cluster_id;
      expect(c1).not.toBeNull();
      expect(c2).toBe(c1);
    });

    it('T2-3 proof 3c (4b) — PEPPER FAIL-LOUD: with ARAMO_IDENTITY_PEPPER unset, canonicalize THROWS rather than mis-resolving with an unkeyed fingerprint', async () => {
      const email = `t2-3-pepper-${randomUUID()}@example.com`;
      const pid = uuidv7();
      await insertPayload(dbClient, {
        id: pid,
        tenant_id: TENANT_A,
        source: 'talent_direct',
        storage_ref: 's3://bucket/t2-3-p3c',
        sha256: 't2-3-p3c-' + 'g'.repeat(55),
        content_type: 'application/json',
        captured_at: new Date(),
        verified_email: email,
        profile_url: null,
      });
      const saved = process.env['ARAMO_IDENTITY_PEPPER'];
      delete process.env['ARAMO_IDENTITY_PEPPER'];
      try {
        await expect(
          service.canonicalize({
            payload_id: pid,
            source_channel: 'self_signup',
            authContext: { tenant_id: TENANT_A },
            requestId: randomUUID(),
          }),
        ).rejects.toThrow(/ARAMO_IDENTITY_PEPPER/);
      } finally {
        if (saved !== undefined) process.env['ARAMO_IDENTITY_PEPPER'] = saved;
      }
      // The payload stayed UNRESOLVED (no mis-resolution) — the row is still
      // re-pickable on the next tick.
      const row = await dbClient.query<{ resolved_talent_id: string | null }>(
        `SELECT resolved_talent_id FROM "ingestion"."RawPayloadReference" WHERE id = $1`,
        [pid],
      );
      expect(row.rows[0]!.resolved_talent_id).toBeNull();
    });

    it('T2-3 proof 4 — UNVERIFIED EMAIL DOES NOT RESOLVE: a TalentContactMethod with verification_status="unverified" is held as evidence, not as an identity key → CREATE-NEW Talent', async () => {
      // Seed a Talent with an UNverified email contact method directly
      // (canonicalize only writes verified=true for verified_email; the
      // unverified case comes from elsewhere — we insert directly to
      // simulate). Use a unique email so this is the only contact-method
      // row matching.
      const unverifiedEmail = `t2-3-unverified-${randomUUID()}@example.com`;
      const seedTalentId = uuidv7();
      await dbClient.query(
        `INSERT INTO "talent"."Talent" (id, lifecycle_status, updated_at)
           VALUES ($1, 'active', NOW())`,
        [seedTalentId],
      );
      await dbClient.query(
        `INSERT INTO "talent_evidence"."TalentContactMethod"
           (id, talent_id, tenant_id, type, value, is_primary,
            verification_status, created_at)
           VALUES ($1, $2, $3, 'email', $4, false, 'unverified', NOW())`,
        [uuidv7(), seedTalentId, TENANT_A, unverifiedEmail],
      );

      // A payload arrives with the same email (verified). The resolver
      // must NOT match (the existing contact method is unverified) →
      // CREATE-NEW.
      const payloadId = uuidv7();
      await insertPayload(dbClient, {
        id: payloadId,
        tenant_id: TENANT_A,
        source: 'talent_direct',
        storage_ref: 's3://bucket/t2-3-p4',
        sha256: 't2-3-p4-' + 'f'.repeat(56),
        content_type: 'application/json',
        captured_at: new Date(),
        verified_email: unverifiedEmail,
        profile_url: null,
      });

      const beforeTalents = await dbClient.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "talent"."Talent"`,
      );

      const result = await service.canonicalize({
        payload_id: payloadId,
        source_channel: 'self_signup',
        authContext: { tenant_id: TENANT_A },
        requestId: randomUUID(),
      });

      expect(result.resolution_method).toBe('new_identity');
      expect(result.talent_id).not.toBe(seedTalentId);

      // +1 Talent (resolver did NOT match the unverified contact-method;
      // CREATE-NEW fired).
      const afterTalents = await dbClient.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "talent"."Talent"`,
      );
      expect(
        Number(afterTalents.rows[0]!.count) -
          Number(beforeTalents.rows[0]!.count),
      ).toBe(1);
    });

    it('T2-3 proof 5 — THE TRIGGER: an unresolved RawPayloadReference is drained automatically by the processor (no caller invokes canonicalize directly)', async () => {
      // Insert a payload (the trigger's outbox row — resolved_talent_id
      // IS NULL). No caller-supplied canonicalize.
      const payloadId = uuidv7();
      const triggerEmail = `t2-3-trigger-${randomUUID()}@example.com`;
      await insertPayload(dbClient, {
        id: payloadId,
        tenant_id: TENANT_A,
        source: 'talent_direct',
        storage_ref: 's3://bucket/t2-3-p5',
        sha256: 't2-3-p5-' + '1'.repeat(56),
        content_type: 'application/json',
        captured_at: new Date(),
        verified_email: triggerEmail,
        profile_url: null,
      });

      // Confirm the polling query SEES the row (the trigger's read seam).
      const repo = app.get(CanonicalizationRepository);
      const unresolvedBefore = await repo.findUnresolvedPayloadBatch({
        limit: 1000,
      });
      expect(unresolvedBefore.some((r) => r.id === payloadId)).toBe(true);

      // Drive the trigger (drainBatch is the in-process drain seam the
      // BullMQ tick would call). Expect: the row gets resolved + the
      // canonicalization side effects fire.
      const drain1 = await triggerProcessor.drainBatch({
        batchSize: 1000,
        jobId: 't2-3-proof-5',
      });
      expect(drain1.attempted).toBeGreaterThan(0);
      expect(drain1.failed).toBe(0);

      // The specific payload is now resolved.
      const updatedPayload = await dbClient.query(
        `SELECT resolved_talent_id, resolution_method
           FROM "ingestion"."RawPayloadReference" WHERE id = $1`,
        [payloadId],
      );
      expect(updatedPayload.rows[0].resolved_talent_id).not.toBeNull();
      expect(updatedPayload.rows[0].resolution_method).toBe('new_identity');

      // The talent.canonicalized event was written to the outbox.
      const ev = await dbClient.query(
        `SELECT event_type FROM "canonicalization"."OutboxEvent"
           WHERE (event_payload->>'payload_id') = $1`,
        [payloadId],
      );
      expect(ev.rowCount).toBe(1);
      expect(ev.rows[0].event_type).toBe('talent.canonicalized');
    });

    it('T2-3 proof 6 — TRIGGER DURABILITY + IDEMPOTENCY: a re-fired tick is a no-op (polling query excludes resolved rows; resolved_talent_id short-circuit catches any race)', async () => {
      // Insert + drive once to get a resolved row.
      const payloadId = uuidv7();
      const email = `t2-3-idem-${randomUUID()}@example.com`;
      await insertPayload(dbClient, {
        id: payloadId,
        tenant_id: TENANT_A,
        source: 'talent_direct',
        storage_ref: 's3://bucket/t2-3-p6',
        sha256: 't2-3-p6-' + '2'.repeat(56),
        content_type: 'application/json',
        captured_at: new Date(),
        verified_email: email,
        profile_url: null,
      });
      await triggerProcessor.drainBatch({
        batchSize: 1000,
        jobId: 't2-3-proof-6-first',
      });
      const resolvedRow = await dbClient.query<{
        resolved_talent_id: string;
        resolution_method: string;
      }>(
        `SELECT resolved_talent_id, resolution_method
           FROM "ingestion"."RawPayloadReference" WHERE id = $1`,
        [payloadId],
      );
      expect(resolvedRow.rows[0].resolved_talent_id).not.toBeNull();
      const firstTalentId = resolvedRow.rows[0].resolved_talent_id;

      // Snapshot the per-payload outbox + evidence counts.
      const beforeEvents = await dbClient.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM "canonicalization"."OutboxEvent"
           WHERE (event_payload->>'payload_id') = $1`,
        [payloadId],
      );
      const beforeContacts = await dbClient.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM "talent_evidence"."TalentContactMethod"
           WHERE talent_id = $1`,
        [firstTalentId],
      );

      // Polling-query layer: the resolved row is EXCLUDED from
      // findUnresolvedPayloadBatch (durability layer (a)).
      const repo = app.get(CanonicalizationRepository);
      const unresolved = await repo.findUnresolvedPayloadBatch({ limit: 1000 });
      expect(unresolved.some((r) => r.id === payloadId)).toBe(false);

      // Short-circuit layer: even if the row WERE re-picked (the race
      // case), canonicalize's resolved_talent_id check fires (already_
      // canonicalized = true; outbox_event_id = null; contacts_created = 0).
      const direct = await service.canonicalize({
        payload_id: payloadId,
        source_channel: 'self_signup',
        authContext: { tenant_id: TENANT_A },
        requestId: randomUUID(),
      });
      expect(direct.already_canonicalized).toBe(true);
      expect(direct.outbox_event_id).toBeNull();
      expect(direct.contact_methods_created).toBe(0);
      expect(direct.talent_id).toBe(firstTalentId);

      // No dup writes: outbox event count + contact count unchanged.
      const afterEvents = await dbClient.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM "canonicalization"."OutboxEvent"
           WHERE (event_payload->>'payload_id') = $1`,
        [payloadId],
      );
      expect(afterEvents.rows[0]!.count).toBe(beforeEvents.rows[0]!.count);
      const afterContacts = await dbClient.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM "talent_evidence"."TalentContactMethod"
           WHERE talent_id = $1`,
        [firstTalentId],
      );
      expect(afterContacts.rows[0]!.count).toBe(beforeContacts.rows[0]!.count);

      // Re-running the trigger is also a no-op for this payload.
      const drain2 = await triggerProcessor.drainBatch({
        batchSize: 1000,
        jobId: 't2-3-proof-6-second',
      });
      // The drain may pick up OTHER unresolved rows from prior proofs,
      // but the failed count must be 0 (durability) and the targeted
      // payload's writes remain unchanged.
      expect(drain2.failed).toBe(0);
      const finalEvents = await dbClient.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM "canonicalization"."OutboxEvent"
           WHERE (event_payload->>'payload_id') = $1`,
        [payloadId],
      );
      expect(finalEvents.rows[0]!.count).toBe(beforeEvents.rows[0]!.count);
    });

    it('T2-3 proof 8 — R10: the outbox event payload from a T2-3 resolution carries no tier/score/rank/match-class keys', async () => {
      // Find an event from any T2-3 resolution above (TENANT_A / TENANT_B).
      const events = await dbClient.query<{
        event_type: string;
        event_payload: Record<string, unknown>;
      }>(
        `SELECT event_type, event_payload FROM "canonicalization"."OutboxEvent"
           WHERE tenant_id IN ($1, $2) ORDER BY created_at ASC`,
        [TENANT_A, TENANT_B],
      );
      expect(events.rowCount).toBeGreaterThan(0);
      const sample = events.rows[0]!;
      expect(sample.event_type).toBe('talent.canonicalized');
      const payload = sample.event_payload;
      // The 4 expected keys ONLY.
      expect(Object.keys(payload).sort()).toEqual(
        ['payload_id', 'resolution_method', 'talent_id', 'tenant_id'].sort(),
      );
      // The R10 forbidden output keys are absent.
      for (const k of [
        'tier',
        'rank',
        'rank_ordinal',
        'score',
        'why_matched_sentence',
        'strengths',
        'gaps',
        'risk_flags',
        'recruiter_notes',
        'override_id',
        'internal_engagement_state',
      ]) {
        expect(payload).not.toHaveProperty(k);
      }
    });

    // Silence unused-var lint for the prisma handle (kept for future
    // diagnostic queries inside the spec).
    void prisma;
  },
);
