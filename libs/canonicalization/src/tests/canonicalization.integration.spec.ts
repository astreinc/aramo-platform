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
import { CanonicalizationTriggerProcessor } from '../lib/canonicalization-trigger.processor.js';

// Fix-Slice-2 — canonicalization integration spec (Canonicalization Re-Route,
// Fork B → L2). Real Postgres 17 via testcontainers; ARAMO_RUN_INTEGRATION=1
// gated. REWRITTEN from the husk-semantic Proofs 1–4 + T2-3 proofs (Amendment
// v1.3) to the §7 behavior: canonicalize mints NO Core husk; it resolves the
// arrival's within-tenant ResolutionSubject via the verified-email SubjectAnchor
// (v1.2 — verified_email_match / new_identity), attaches per-arrival contact
// EvidenceRecords on L2, writes resolved_subject_id, and emits a subject-keyed
// talent.canonicalized outbox event.
//
// PRESERVED (per v1.3 §2 — §5 leave-untouched, R1): the orthogonal 4b
// resolved_cluster_id / identity_index PersonCluster path + the pepper
// fail-loud proof — unchanged in substance.
//
// Structural tripwires (no DB): canonicalization.tripwires.spec.ts (Proof-5/6/7)
// + follower-drift.spec.ts.

const ROOT = resolve(__dirname, '../../../..');
// Fix-Slice-Final-Drop: the talent + talent_evidence schemas are retired — the
// canonicalization follower client no longer references them, so they are no
// longer applied here. resolved_talent_id is added then dropped (the husk
// column is gone; resolved_subject_id is the sole live pointer).
const MIGRATIONS = [
  // ingestion (init + skill_surface_forms + resolved_talent_id + drop).
  resolve(ROOT, 'libs/ingestion/prisma/migrations/20260516130715_init_ingestion_model/migration.sql'),
  resolve(ROOT, 'libs/ingestion/prisma/migrations/20260516183528_add_skill_surface_forms/migration.sql'),
  resolve(ROOT, 'libs/ingestion/prisma/migrations/20260603160100_add_resolved_talent_id_to_raw_payload_reference/migration.sql'),
  // ingestion (4b additive) — resolved_cluster_id.
  resolve(ROOT, 'libs/ingestion/prisma/migrations/20260630120000_add_resolved_cluster_id_to_raw_payload_reference/migration.sql'),
  // ingestion (Fix-Slice-2 additive) — resolved_subject_id (the L2 anchor).
  resolve(ROOT, 'libs/ingestion/prisma/migrations/20260704120000_add_resolved_subject_id_to_raw_payload_reference/migration.sql'),
  // ingestion (Fix-Slice-Final-Drop) — drop the husk resolved_talent_id.
  resolve(ROOT, 'libs/ingestion/prisma/migrations/20260704160000_drop_resolved_talent_id_from_raw_payload_reference/migration.sql'),
  // canonicalization (init) — canonicalization PG schema + OutboxEvent.
  resolve(ROOT, 'libs/canonicalization/prisma/migrations/20260603160000_init_canonicalization_schema/migration.sql'),
  // identity_index (init, 4b) — PersonCluster + ClusterFingerprint.
  resolve(ROOT, 'libs/identity-index/prisma/migrations/20260630000000_init_identity_index/migration.sql'),
  // talent_trust — the L2 resolution substrate the re-route resolves onto.
  resolve(ROOT, 'libs/talent-trust/prisma/migrations/20260628000000_init_talent_trust/migration.sql'),
  resolve(ROOT, 'libs/talent-trust/prisma/migrations/20260703120000_tr2a1_subject_anchor/migration.sql'),
  resolve(ROOT, 'libs/talent-trust/prisma/migrations/20260703130000_tr2a2_match_advisory/migration.sql'),
  resolve(ROOT, 'libs/talent-trust/prisma/migrations/20260703140000_tr2a3_advisory_resolution/migration.sql'),
];

// $$-aware DDL splitter — strips `--` line comments (so a `;` inside a comment
// never mis-splits) then splits on statement-boundary `;` OUTSIDE `$$…$$`
// bodies (the talent_trust immutability triggers carry `;` inside `$$`).
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
const TENANT_A = '33333333-3333-7333-8333-333333333333';
const TENANT_B = '44444444-4444-7444-8444-444444444444';

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

async function insertPayload(setup: Client, seed: PayloadSeed): Promise<void> {
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
  'Fix-Slice-2 — CanonicalizationService.canonicalize → L2 ResolutionSubject (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: TestingModule;
    let service: CanonicalizationService;
    let outbox: CanonicalizationOutboxRepository;
    let triggerProcessor: CanonicalizationTriggerProcessor;
    let dbClient: Client;

    async function payloadRow(id: string): Promise<{
      resolved_subject_id: string | null;
      resolved_cluster_id: string | null;
      resolution_method: string | null;
    }> {
      const r = await dbClient.query(
        `SELECT resolved_subject_id, resolved_cluster_id, resolution_method
           FROM "ingestion"."RawPayloadReference" WHERE id = $1`,
        [id],
      );
      return r.rows[0];
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      const setup = new Client({ connectionString: url });
      await setup.connect();
      for (const p of MIGRATIONS) {
        for (const stmt of splitDdl(readFileSync(p, 'utf8'))) {
          await setup.query(stmt);
        }
      }
      await setup.end();

      process.env['DATABASE_URL'] = url;
      // The 4b cluster resolve fingerprints verified emails; the pepper must be
      // set or loadIdentityPepper fails loud (the dedicated fail-loud proof
      // unsets it for one assertion).
      process.env['ARAMO_IDENTITY_PEPPER'] = 'canonicalization-integration-pepper';
      app = await Test.createTestingModule({ imports: [TestModule] }).compile();

      service = app.get(CanonicalizationService);
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

    // -----------------------------------------------------------------------
    // Proof 1 — NEW IDENTITY: a never-seen verified email resolves to a NEW
    // ResolutionSubject; ZERO husk minted; email SubjectAnchor + contact
    // evidence on L2; resolved_subject_id set; subject-keyed outbox event.
    // -----------------------------------------------------------------------
    it('proof 1 — NEW IDENTITY: creates an L2 ResolutionSubject (no husk), email anchor + evidence, resolved_subject_id set, subject-keyed outbox', async () => {
      const payloadId = uuidv7();
      const email = `fs2-new-${randomUUID()}@example.com`;
      await insertPayload(dbClient, {
        id: payloadId,
        tenant_id: TENANT_ID,
        source: 'talent_direct',
        storage_ref: 's3://bucket/fs2-p1',
        sha256: 'fs2-p1-' + 'a'.repeat(56),
        content_type: 'application/json',
        captured_at: new Date(),
        verified_email: email,
        profile_url: 'https://github.com/fs2p1',
      });

      const result = await service.canonicalize({
        payload_id: payloadId,
        source_channel: 'self_signup',
        authContext: { tenant_id: TENANT_ID },
        requestId: randomUUID(),
      });

      expect(result.already_canonicalized).toBe(false);
      expect(result.resolution_method).toBe('new_identity');
      expect(result.subject_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.outbox_event_id).not.toBeNull();
      // email anchor evidence + profile_url evidence.
      expect(result.contact_evidence_written).toBe(2);
      // The husk substrate is gone platform-wide (Proof-6, tripwires spec); the
      // talent.Talent table no longer exists to query here.

      // The ResolutionSubject exists and is what resolved_subject_id points at.
      const subj = await dbClient.query(
        `SELECT id, tenant_id FROM "talent_trust"."ResolutionSubject" WHERE id = $1`,
        [result.subject_id],
      );
      expect(subj.rows.length).toBe(1);
      expect(subj.rows[0].tenant_id).toBe(TENANT_ID);

      const row = await payloadRow(payloadId);
      expect(row.resolved_subject_id).toBe(result.subject_id);
      expect(row.resolution_method).toBe('new_identity');

      // An EMAIL SubjectAnchor was recorded for the subject.
      const anchor = await dbClient.query(
        `SELECT normalized_value FROM "talent_trust"."SubjectAnchor"
           WHERE subject_id = $1 AND anchor_kind = 'EMAIL'`,
        [result.subject_id],
      );
      expect(anchor.rows.length).toBe(1);
      expect(anchor.rows[0].normalized_value).toBe(email);

      // The outbox event is subject-keyed.
      const events = await outbox.findUnpublishedEvents({ limit: 100 });
      const ev = events.find((e) => e.id === result.outbox_event_id);
      expect(ev).toBeDefined();
      expect(ev!.event_type).toBe('talent.canonicalized');
      const payload = ev!.event_payload as Record<string, unknown>;
      expect(payload['subject_id']).toBe(result.subject_id);
      expect(payload['talent_id']).toBeUndefined();

      // (b) DISTINCTNESS: a SECOND arrival in the SAME tenant with a DIFFERENT
      // verified email is a miss → a NEW, DISTINCT subject (not the first one).
      const otherId = uuidv7();
      await insertPayload(dbClient, {
        id: otherId,
        tenant_id: TENANT_ID,
        source: 'talent_direct',
        storage_ref: 's3://bucket/fs2-p1-distinct',
        sha256: 'fs2-p1-distinct' + 'l'.repeat(49),
        content_type: 'application/json',
        captured_at: new Date(),
        verified_email: `fs2-new-other-${randomUUID()}@example.com`,
        profile_url: null,
      });
      const other = await service.canonicalize({
        payload_id: otherId,
        source_channel: 'self_signup',
        authContext: { tenant_id: TENANT_ID },
        requestId: randomUUID(),
      });
      expect(other.resolution_method).toBe('new_identity');
      expect(other.subject_id).not.toBe(result.subject_id);
    });

    // -----------------------------------------------------------------------
    // Proof 2 — VERIFIED_EMAIL_MATCH (within-tenant): a second arrival with the
    // same verified email resolves to the SAME subject (Tier-A, §6A/I5). Same
    // human, one subject; no new subject.
    // -----------------------------------------------------------------------
    it('proof 2 — VERIFIED_EMAIL_MATCH: a same-email arrival resolves to the SAME ResolutionSubject (no new subject, no husk)', async () => {
      const email = `fs2-match-${randomUUID()}@example.com`;
      const seedId = uuidv7();
      await insertPayload(dbClient, {
        id: seedId,
        tenant_id: TENANT_ID,
        source: 'talent_direct',
        storage_ref: 's3://bucket/fs2-p2-seed',
        sha256: 'fs2-p2-seed' + 'b'.repeat(52),
        content_type: 'application/json',
        captured_at: new Date(),
        verified_email: email,
        profile_url: null,
      });
      const seed = await service.canonicalize({
        payload_id: seedId,
        source_channel: 'self_signup',
        authContext: { tenant_id: TENANT_ID },
        requestId: randomUUID(),
      });
      expect(seed.resolution_method).toBe('new_identity');

      const secondId = uuidv7();
      await insertPayload(dbClient, {
        id: secondId,
        tenant_id: TENANT_ID,
        source: 'astre_import',
        storage_ref: 's3://bucket/fs2-p2',
        sha256: 'fs2-p2-' + 'c'.repeat(56),
        content_type: 'application/json',
        captured_at: new Date(),
        verified_email: email,
        profile_url: null,
      });
      const result = await service.canonicalize({
        payload_id: secondId,
        source_channel: 'import',
        authContext: { tenant_id: TENANT_ID },
        requestId: randomUUID(),
      });

      expect(result.already_canonicalized).toBe(false);
      expect(result.resolution_method).toBe('verified_email_match');
      // SAME subject as the seed — the Tier-A email anchor resolved same-human.
      expect(result.subject_id).toBe(seed.subject_id);

      const row = await payloadRow(secondId);
      expect(row.resolved_subject_id).toBe(seed.subject_id);
      expect(row.resolution_method).toBe('verified_email_match');
    });

    // -----------------------------------------------------------------------
    // Proof 3 — IDEMPOTENCY: re-canonicalize the same payload → no-op (the
    // resolved_subject_id short-circuit), no duplicate subject/evidence/outbox.
    // -----------------------------------------------------------------------
    it('proof 3 — IDEMPOTENCY: re-canonicalize the same payload → no-op (no dup subject / evidence / outbox)', async () => {
      const payloadId = uuidv7();
      const email = `fs2-idem-${randomUUID()}@example.com`;
      await insertPayload(dbClient, {
        id: payloadId,
        tenant_id: TENANT_ID,
        source: 'talent_direct',
        storage_ref: 's3://bucket/fs2-p3',
        sha256: 'fs2-p3-' + 'd'.repeat(56),
        content_type: 'application/json',
        captured_at: new Date(),
        verified_email: email,
        profile_url: null,
      });
      const first = await service.canonicalize({
        payload_id: payloadId,
        source_channel: 'self_signup',
        authContext: { tenant_id: TENANT_ID },
        requestId: randomUUID(),
      });
      expect(first.already_canonicalized).toBe(false);

      const evidenceBefore = await dbClient.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "talent_trust"."EvidenceRecord" WHERE subject_id = $1`,
        [first.subject_id],
      );
      const outboxBefore = (await outbox.findUnpublishedEvents({ limit: 1000 })).length;

      const second = await service.canonicalize({
        payload_id: payloadId,
        source_channel: 'self_signup',
        authContext: { tenant_id: TENANT_ID },
        requestId: randomUUID(),
      });
      expect(second.already_canonicalized).toBe(true);
      expect(second.subject_id).toBe(first.subject_id);
      expect(second.outbox_event_id).toBeNull();

      const evidenceAfter = await dbClient.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "talent_trust"."EvidenceRecord" WHERE subject_id = $1`,
        [first.subject_id],
      );
      expect(evidenceAfter.rows[0]!.count).toBe(evidenceBefore.rows[0]!.count);
      const outboxAfter = (await outbox.findUnpublishedEvents({ limit: 1000 })).length;
      expect(outboxAfter).toBe(outboxBefore);
    });

    // -----------------------------------------------------------------------
    // Proof 4 — ATOMICITY / fail-safe: a deterministic mid-canonicalize failure
    // (pepper unset → the 4b cluster resolve throws BEFORE the in-tx
    // resolved_subject_id write) leaves the payload UNRESOLVED and writes no
    // outbox event — the row stays re-pickable. (Also the 4b pepper fail-loud.)
    // -----------------------------------------------------------------------
    it('proof 4 — ATOMICITY: a mid-canonicalize failure leaves resolved_subject_id NULL + no outbox event (pepper fail-loud)', async () => {
      const payloadId = uuidv7();
      const email = `fs2-atomic-${randomUUID()}@example.com`;
      await insertPayload(dbClient, {
        id: payloadId,
        tenant_id: TENANT_ID,
        source: 'talent_direct',
        storage_ref: 's3://bucket/fs2-p4',
        sha256: 'fs2-p4-' + 'e'.repeat(56),
        content_type: 'application/json',
        captured_at: new Date(),
        verified_email: email,
        profile_url: null,
      });

      const outboxBefore = (await outbox.findUnpublishedEvents({ limit: 1000 })).length;
      const saved = process.env['ARAMO_IDENTITY_PEPPER'];
      delete process.env['ARAMO_IDENTITY_PEPPER'];
      try {
        await expect(
          service.canonicalize({
            payload_id: payloadId,
            source_channel: 'self_signup',
            authContext: { tenant_id: TENANT_ID },
            requestId: randomUUID(),
          }),
        ).rejects.toThrow(/ARAMO_IDENTITY_PEPPER/);
      } finally {
        if (saved !== undefined) process.env['ARAMO_IDENTITY_PEPPER'] = saved;
      }

      const row = await payloadRow(payloadId);
      expect(row.resolved_subject_id).toBeNull();
      const outboxAfter = (await outbox.findUnpublishedEvents({ limit: 1000 })).length;
      expect(outboxAfter).toBe(outboxBefore);
    });

    // -----------------------------------------------------------------------
    // Cross-tenant access → CANONICALIZATION_PAYLOAD_NOT_FOUND (no enumeration).
    // -----------------------------------------------------------------------
    it('cross-tenant access is absorbed into CANONICALIZATION_PAYLOAD_NOT_FOUND', async () => {
      const payloadId = uuidv7();
      await insertPayload(dbClient, {
        id: payloadId,
        tenant_id: TENANT_ID,
        source: 'talent_direct',
        storage_ref: 's3://bucket/fs2-xtenant',
        sha256: 'fs2-xtenant' + 'f'.repeat(53),
        content_type: 'application/json',
        captured_at: new Date(),
        verified_email: `fs2-xt-${randomUUID()}@example.com`,
        profile_url: null,
      });
      await expect(
        service.canonicalize({
          payload_id: payloadId,
          source_channel: 'self_signup',
          authContext: { tenant_id: OTHER_TENANT_ID },
          requestId: randomUUID(),
        }),
      ).rejects.toMatchObject({
        code: 'CANONICALIZATION_PAYLOAD_NOT_FOUND',
      } satisfies Partial<AramoError>);
    });

    // -----------------------------------------------------------------------
    // 4b (PRESERVED) — CROSS-TENANT CLUSTER: the same verified email in TENANT_A
    // then TENANT_B → DISTINCT per-tenant ResolutionSubjects (the anchor lookup
    // is tenant-scoped) BUT the SAME PERSON_CLUSTER (fingerprint-matched, no
    // cross-tenant email read). §5 leave-untouched / R1.
    // -----------------------------------------------------------------------
    it('4b (preserved) — CROSS-TENANT CLUSTER: same email across tenants → distinct subjects, SAME cluster (one fingerprint)', async () => {
      const email = `fs2-cross-${randomUUID()}@example.com`;
      const seedId = uuidv7();
      await insertPayload(dbClient, {
        id: seedId,
        tenant_id: TENANT_A,
        source: 'talent_direct',
        storage_ref: 's3://bucket/fs2-p5-seed',
        sha256: 'fs2-p5-seed' + 'g'.repeat(52),
        content_type: 'application/json',
        captured_at: new Date(),
        verified_email: email,
        profile_url: null,
      });
      const seed = await service.canonicalize({
        payload_id: seedId,
        source_channel: 'self_signup',
        authContext: { tenant_id: TENANT_A },
        requestId: randomUUID(),
      });

      const bId = uuidv7();
      await insertPayload(dbClient, {
        id: bId,
        tenant_id: TENANT_B,
        source: 'astre_import',
        storage_ref: 's3://bucket/fs2-p5',
        sha256: 'fs2-p5-' + 'h'.repeat(56),
        content_type: 'application/json',
        captured_at: new Date(),
        verified_email: email,
        profile_url: null,
      });
      const result = await service.canonicalize({
        payload_id: bId,
        source_channel: 'import',
        authContext: { tenant_id: TENANT_B },
        requestId: randomUUID(),
      });

      // No cross-tenant email read: TENANT_B did NOT resolve to A's subject —
      // the anchor lookup is tenant-scoped, so B gets its OWN new subject.
      expect(result.resolution_method).toBe('new_identity');
      expect(result.subject_id).not.toBe(seed.subject_id);
      expect(result.tenant_id).toBe(TENANT_B);

      const seedRow = await payloadRow(seedId);
      const bRow = await payloadRow(bId);
      // SAME cluster (cross-tenant identity via fingerprint); DISTINCT subjects.
      expect(seedRow.resolved_cluster_id).not.toBeNull();
      expect(bRow.resolved_cluster_id).toBe(seedRow.resolved_cluster_id);
      expect(bRow.resolved_subject_id).not.toBe(seedRow.resolved_subject_id);

      // Exactly ONE fingerprint for this email across both tenants.
      const fpCount = await dbClient.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM "identity_index"."ClusterFingerprint" WHERE cluster_id = $1`,
        [seedRow.resolved_cluster_id],
      );
      expect(fpCount.rows[0]!.count).toBe('1');
    });

    // -----------------------------------------------------------------------
    // 4b (PRESERVED) — WITHIN-TENANT: same email, same tenant → the SAME subject
    // (verified_email_match) AND the same cluster.
    // -----------------------------------------------------------------------
    it('4b (preserved) — WITHIN-TENANT: same email same tenant → same subject AND same cluster', async () => {
      const email = `fs2-within-${randomUUID()}@example.com`;
      const p1 = uuidv7();
      const p2 = uuidv7();
      for (const [pid, ref] of [[p1, 'w1'], [p2, 'w2']] as const) {
        await insertPayload(dbClient, {
          id: pid,
          tenant_id: TENANT_A,
          source: 'talent_direct',
          storage_ref: `s3://bucket/fs2-p6-${ref}`,
          sha256: `fs2-p6-${ref}` + 'i'.repeat(52),
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

      expect(r1.resolution_method).toBe('new_identity');
      expect(r2.resolution_method).toBe('verified_email_match');
      expect(r2.subject_id).toBe(r1.subject_id);

      const row1 = await payloadRow(p1);
      const row2 = await payloadRow(p2);
      expect(row1.resolved_cluster_id).not.toBeNull();
      expect(row2.resolved_cluster_id).toBe(row1.resolved_cluster_id);
    });

    // -----------------------------------------------------------------------
    // THE TRIGGER — an unresolved RawPayloadReference is drained by the
    // processor (poll gate = resolved_subject_id IS NULL).
    // -----------------------------------------------------------------------
    it('THE TRIGGER: an unresolved payload is drained by the processor → resolved_subject_id set', async () => {
      const payloadId = uuidv7();
      await insertPayload(dbClient, {
        id: payloadId,
        tenant_id: TENANT_ID,
        source: 'talent_direct',
        storage_ref: 's3://bucket/fs2-trigger',
        sha256: 'fs2-trigger' + 'j'.repeat(53),
        content_type: 'application/json',
        captured_at: new Date(),
        verified_email: `fs2-trig-${randomUUID()}@example.com`,
        profile_url: null,
      });

      const drain1 = await triggerProcessor.drainBatch({ batchSize: 1000, jobId: 'fs2-trigger' });
      expect(drain1.attempted).toBeGreaterThan(0);
      expect(drain1.failed).toBe(0);

      const row = await payloadRow(payloadId);
      expect(row.resolved_subject_id).not.toBeNull();

      // A re-fired tick is a no-op for the already-resolved row (poll query
      // excludes resolved rows; the resolved_subject_id short-circuit backstops).
      const drain2 = await triggerProcessor.drainBatch({ batchSize: 1000, jobId: 'fs2-trigger-2' });
      // drain2 does not re-attempt the resolved payload.
      const rowAfter = await payloadRow(payloadId);
      expect(rowAfter.resolved_subject_id).toBe(row.resolved_subject_id);
      expect(drain2.failed).toBe(0);
    });

    // -----------------------------------------------------------------------
    // R10 — the outbox event payload carries no match-class output vocabulary.
    // -----------------------------------------------------------------------
    it('R10: the talent.canonicalized outbox payload carries no tier/score/rank/match-class keys', async () => {
      const payloadId = uuidv7();
      await insertPayload(dbClient, {
        id: payloadId,
        tenant_id: TENANT_ID,
        source: 'talent_direct',
        storage_ref: 's3://bucket/fs2-r10',
        sha256: 'fs2-r10-' + 'k'.repeat(56),
        content_type: 'application/json',
        captured_at: new Date(),
        verified_email: `fs2-r10-${randomUUID()}@example.com`,
        profile_url: null,
      });
      const result = await service.canonicalize({
        payload_id: payloadId,
        source_channel: 'self_signup',
        authContext: { tenant_id: TENANT_ID },
        requestId: randomUUID(),
      });
      const events = await outbox.findUnpublishedEvents({ limit: 1000 });
      const ev = events.find((e) => e.id === result.outbox_event_id);
      expect(ev).toBeDefined();
      const keys = Object.keys(ev!.event_payload as Record<string, unknown>);
      for (const forbidden of ['tier', 'score', 'rank', 'why_matched_sentence', 'strengths', 'gaps']) {
        expect(keys).not.toContain(forbidden);
      }
    });
  },
);
