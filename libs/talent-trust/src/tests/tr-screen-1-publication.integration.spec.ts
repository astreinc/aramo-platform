import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE, resolveTalentTrustMigrations } from '@aramo/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { TalentTrustRepository } from '../lib/talent-trust.repository.js';
import { SubjectMatcherService } from '../lib/subject-matcher.service.js';
import { TalentTrustService } from '../lib/talent-trust.service.js';

// TR-SCREEN-1 DDR §3 (Aramo-TR-SCREEN-1-DDR-v1_0-LOCKED) — recordScreeningFindingIfAbsent
// against real Postgres 17: the G1 atomic insert keyed on the preallocated
// evidence_id, the tenant-bound logical-replay comparison and the
// IDEMPOTENCY_KEY_CONFLICT refusal. Directive ARAMO-TIP-E2E-INC-3 §13 rows 13,
// 16, 35, 36, 39 (trust side) + the S1a foreign-id concealment.

const REPO_ROOT = resolve(__dirname, '../../../..');
const TENANT_A = '0192f000-aaaa-7000-8000-00000000000a';
const TENANT_B = '0192f000-bbbb-7000-8000-00000000000b';

function splitDdl(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  let inDollar = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
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

function findingPayload(sessionId: string, findingId: string, over: Record<string, unknown> = {}) {
  return {
    skill_raw: 'Kubernetes',
    basis: 'RECRUITER_OBSERVED',
    observation_raw: 'Walked through a rolling deployment and its rollback path.',
    confirmation: { confirmed_at: '2026-10-15T10:00:00.000Z', session_version: 2 },
    screening_ref: { screening_session_id: sessionId, screening_finding_id: findingId },
    ...over,
  };
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TR-SCREEN-1 — recordScreeningFindingIfAbsent (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let service: TalentTrustService;
    const collectedAt = new Date('2026-10-15T10:00:00.000Z');

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const url = container.getConnectionUri();
      const setup = new PrismaService(url);
      await setup.$connect();
      for (const path of resolveTalentTrustMigrations(REPO_ROOT)) {
        for (const stmt of splitDdl(readFileSync(path, 'utf8'))) {
          if (stmt.trim().length > 0) await setup.$executeRawUnsafe(stmt.trim());
        }
      }
      await setup.$disconnect();
      prisma = new PrismaService(url);
      await prisma.$connect();
      const repo = new TalentTrustRepository(prisma);
      service = new TalentTrustService(repo, new SubjectMatcherService(repo));
    }, 180_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    function input(tenant: string, record: string, evidenceId: string, payload: Record<string, unknown>) {
      return {
        tenant_id: tenant,
        talent_record_id: record,
        evidence_id: evidenceId,
        assertion_payload: payload,
        collected_at: collectedAt,
      };
    }

    it('writes ONE canonical row + its CREATED event (actor = slice name) through the G1 insert', async () => {
      const record = uuidv7();
      const evidenceId = uuidv7();
      const res = await service.recordScreeningFindingIfAbsent(
        input(TENANT_A, record, evidenceId, findingPayload(uuidv7(), uuidv7())),
      );
      expect(res).toEqual({ written: true, evidence_id: evidenceId });

      const row = await prisma.evidenceRecord.findUniqueOrThrow({ where: { id: evidenceId } });
      expect(row.assertion_type).toBe('SCREENING_FINDING');
      expect(row.dimension).toBe('CLAIMS');
      expect(row.source_class).toBe('THIRD_PARTY_UNVERIFIED');
      expect(row.method).toBe('HUMAN_ATTESTED');
      expect(row.ai_derived).toBe(false);
      expect(row.created_by).toBe('technical-screening');
      expect(row.decay_profile).toBe('MODERATE');
      expect(row.portability_class).toBe('TENANT_ONLY');
      expect(JSON.stringify(row.assertion_payload)).not.toMatch(/actor/);

      const events = await prisma.evidenceEvent.findMany({ where: { evidence_id: evidenceId } });
      expect(events).toHaveLength(1);
      expect(events[0]?.event_type).toBe('CREATED');
      expect(events[0]?.actor).toBe('technical-screening');

      // The synchronous recompute converged and cleared the durable G1 request.
      const subject = await prisma.resolutionSubject.findUniqueOrThrow({ where: { id: row.subject_id } });
      expect(subject.trust_recompute_requested_at).toBeNull();
      const state = await prisma.trustState.findUnique({ where: { subject_id: row.subject_id } });
      expect(state?.claims_band).toBe('SELF_ASSERTED');
    });

    it('derives SELF × SELF_DECLARED for a SELF_REPORTED finding', async () => {
      const evidenceId = uuidv7();
      await service.recordScreeningFindingIfAbsent(
        input(TENANT_A, uuidv7(), evidenceId, findingPayload(uuidv7(), uuidv7(), { basis: 'SELF_REPORTED' })),
      );
      const row = await prisma.evidenceRecord.findUniqueOrThrow({ where: { id: evidenceId } });
      expect(row.source_class).toBe('SELF');
      expect(row.method).toBe('SELF_DECLARED');
    });

    it('an identical replay is { written: false } with no second row or event (row 35)', async () => {
      const record = uuidv7();
      const evidenceId = uuidv7();
      const payload = findingPayload(uuidv7(), uuidv7());
      await service.recordScreeningFindingIfAbsent(input(TENANT_A, record, evidenceId, payload));
      const again = await service.recordScreeningFindingIfAbsent(input(TENANT_A, record, evidenceId, payload));
      expect(again).toEqual({ written: false, evidence_id: evidenceId });
      expect(await prisma.evidenceRecord.count({ where: { id: evidenceId } })).toBe(1);
      expect(await prisma.evidenceEvent.count({ where: { evidence_id: evidenceId } })).toBe(1);
    });

    it('concurrent attempts produce exactly one row; every attempt converges (row 36)', async () => {
      const record = uuidv7();
      const evidenceId = uuidv7();
      const payload = findingPayload(uuidv7(), uuidv7());
      // The subject first, sequentially — the concurrent first-arrival subject
      // creation race is a pre-existing, separately tracked defect (G1 follow-up).
      await service.recordScreeningFindingIfAbsent(
        input(TENANT_A, record, uuidv7(), findingPayload(uuidv7(), uuidv7())),
      );
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          service.recordScreeningFindingIfAbsent(input(TENANT_A, record, evidenceId, payload)),
        ),
      );
      expect(results.filter((r) => r.written)).toHaveLength(1);
      expect(results.every((r) => r.evidence_id === evidenceId)).toBe(true);
      expect(await prisma.evidenceRecord.count({ where: { id: evidenceId } })).toBe(1);
      expect(await prisma.evidenceEvent.count({ where: { evidence_id: evidenceId } })).toBe(1);
    });

    it('a conflicting replay is refused with IDEMPOTENCY_KEY_CONFLICT and the stored row is unchanged (row 39)', async () => {
      const record = uuidv7();
      const evidenceId = uuidv7();
      const sessionId = uuidv7();
      const findingId = uuidv7();
      await service.recordScreeningFindingIfAbsent(
        input(TENANT_A, record, evidenceId, findingPayload(sessionId, findingId)),
      );
      const before = await prisma.evidenceRecord.findUniqueOrThrow({ where: { id: evidenceId } });
      await expect(
        service.recordScreeningFindingIfAbsent(
          input(TENANT_A, record, evidenceId, findingPayload(sessionId, findingId, { observation_raw: 'tampered' })),
        ),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT', statusCode: 409 });
      // Same payload, different collected_at — also a different publication.
      await expect(
        service.recordScreeningFindingIfAbsent({
          ...input(TENANT_A, record, evidenceId, findingPayload(sessionId, findingId)),
          collected_at: new Date('2026-10-16T00:00:00.000Z'),
        }),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });
      const after = await prisma.evidenceRecord.findUniqueOrThrow({ where: { id: evidenceId } });
      expect(after).toEqual(before);
      expect(await prisma.evidenceEvent.count({ where: { evidence_id: evidenceId } })).toBe(1);
    });

    it("another tenant's evidence id is never compared or disclosed (S1a concealment)", async () => {
      const evidenceId = uuidv7();
      const payload = findingPayload(uuidv7(), uuidv7());
      await service.recordScreeningFindingIfAbsent(input(TENANT_A, uuidv7(), evidenceId, payload));
      const before = await prisma.evidenceRecord.findUniqueOrThrow({ where: { id: evidenceId } });
      const err = await service
        .recordScreeningFindingIfAbsent(input(TENANT_B, uuidv7(), evidenceId, payload))
        .then(() => null, (e: unknown) => e as { code?: string; message?: string; details?: unknown });
      expect(err?.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
      expect(JSON.stringify(err?.details ?? {})).not.toContain(TENANT_A);
      expect(await prisma.evidenceRecord.findUniqueOrThrow({ where: { id: evidenceId } })).toEqual(before);
      expect(await prisma.evidenceRecord.count({ where: { tenant_id: TENANT_B } })).toBe(0);
    });

    it('A1: an AI-drafted finding publishes with ai_derived=true; a provenance change is a conflicting replay', async () => {
      const evidenceId = uuidv7();
      const record = uuidv7();
      const sessionId = uuidv7();
      const findingId = uuidv7();
      const ai = findingPayload(sessionId, findingId, {
        basis: 'SELF_REPORTED',
        provenance: { origin: 'AI_DRAFTED', review_outcome: 'EDITED', evidence_source: 'RECRUITER_NOTES' },
      });
      await service.recordScreeningFindingIfAbsent(input(TENANT_A, record, evidenceId, ai));
      const row = await prisma.evidenceRecord.findUniqueOrThrow({ where: { id: evidenceId } });
      expect(row.ai_derived).toBe(true);
      expect(row.source_class).toBe('SELF'); // a self-reported statement stays SELF
      // Same id, provenance stripped (would flip ai_derived) → conflict, unchanged.
      await expect(
        service.recordScreeningFindingIfAbsent(input(TENANT_A, record, evidenceId, findingPayload(sessionId, findingId, { basis: 'SELF_REPORTED' }))),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });
      expect((await prisma.evidenceRecord.findUniqueOrThrow({ where: { id: evidenceId } })).ai_derived).toBe(true);
    });

    it('A1: a recruiter-authored finding stays ai_derived=false', async () => {
      const evidenceId = uuidv7();
      await service.recordScreeningFindingIfAbsent(input(TENANT_A, uuidv7(), evidenceId, findingPayload(uuidv7(), uuidv7(), {
        provenance: { origin: 'RECRUITER_AUTHORED', evidence_source: 'RECRUITER_OBSERVATION' },
      })));
      expect((await prisma.evidenceRecord.findUniqueOrThrow({ where: { id: evidenceId } })).ai_derived).toBe(false);
    });

    it('an invalid shape is refused with CLAIM_SHAPE_INVALID before any write (row 16)', async () => {
      const evidenceId = uuidv7();
      await expect(
        service.recordScreeningFindingIfAbsent(
          input(TENANT_A, uuidv7(), evidenceId, findingPayload(uuidv7(), uuidv7(), { basis: 'DEMONSTRATED' })),
        ),
      ).rejects.toMatchObject({ code: 'CLAIM_SHAPE_INVALID', statusCode: 422 });
      expect(await prisma.evidenceRecord.count({ where: { id: evidenceId } })).toBe(0);
    });
  },
);
