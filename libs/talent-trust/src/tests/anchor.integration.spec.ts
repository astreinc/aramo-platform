import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { TalentTrustRepository } from '../lib/talent-trust.repository.js';
import { TalentTrustService } from '../lib/talent-trust.service.js';

// TR-2a-1 anchor integration — real Postgres 17. Applies the init + SubjectAnchor
// migrations and proves against real SQL:
//   - recordAnchor writes an IDENTITY anchor EvidenceRecord (source of truth) +
//     a SubjectAnchor projection pointing back at it (source_evidence_id);
//   - it is tenant-scoped (same value, different tenant → different subject/anchor);
//   - it is idempotent (re-record → no-op; no duplicate evidence, no duplicate anchor);
//   - anchors are keyed to the ORIGIN subject and survive merge/unmerge un-touched.

const MIGRATIONS = [
  '../../prisma/migrations/20260628000000_init_talent_trust/migration.sql',
  '../../prisma/migrations/20260703120000_tr2a1_subject_anchor/migration.sql',
  // Slice-B1 — the regenerated client SELECTs ResolutionSubject.last_reconciled_at
  // + reconcile_attempts (findSubjectByRef include), so the columns must exist.
  '../../prisma/migrations/20260705120000_add_reconcile_watermark_to_resolution_subject/migration.sql',
].map((p) => resolve(__dirname, p));

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '22222222-2222-7222-8222-222222222222';
const TALENT_1 = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const TALENT_2 = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const CREATED_BY = 'tr2a1-anchor-integration';

// $$-aware DDL splitter (trigger bodies contain semicolons inside $$ … $$).
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

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TalentTrustService.recordAnchor — within-tenant anchor (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let service: TalentTrustService;
    let repo: TalentTrustRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      const setupClient = new PrismaService(url);
      await setupClient.$connect();
      for (const path of MIGRATIONS) {
        for (const stmt of splitDdl(readFileSync(path, 'utf8'))) {
          const trimmed = stmt.trim();
          if (trimmed.length === 0) continue;
          await setupClient.$executeRawUnsafe(trimmed);
        }
      }
      await setupClient.$disconnect();

      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new TalentTrustRepository(prisma);
      service = new TalentTrustService(repo);
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    it('writes an IDENTITY EvidenceRecord + a SubjectAnchor projection pointing back at it', async () => {
      const written = await service.recordAnchor({
        tenant_id: TENANT_A,
        talent_record_id: TALENT_1,
        anchor_kind: 'EMAIL',
        normalized_value: 'ada@example.com',
        raw_source: 'Ada@Example.com',
        created_by: CREATED_BY,
      });
      expect(written).not.toBeNull();
      const { evidence, anchor } = written!;

      // The evidence is the source of truth: IDENTITY / EMAIL, normalized value
      // in the payload, SELF-declared (unverified contact).
      expect(evidence.dimension).toBe('IDENTITY');
      expect(evidence.assertion_type).toBe('EMAIL');
      expect(evidence.source_class).toBe('SELF');
      expect((evidence.assertion_payload as { normalized_value: string }).normalized_value).toBe(
        'ada@example.com',
      );

      // The SubjectAnchor projects it and points back (source_evidence_id).
      expect(anchor.source_evidence_id).toBe(evidence.id);
      expect(anchor.tenant_id).toBe(TENANT_A);
      expect(anchor.subject_id).toBe(evidence.subject_id);
      expect(anchor.normalized_value).toBe('ada@example.com');

      // Both are persisted + linked.
      const anchors = await repo.listAnchorsBySubject(evidence.subject_id);
      expect(anchors).toHaveLength(1);
      const ev = await repo.findEvidenceById(anchor.source_evidence_id);
      expect(ev?.assertion_type).toBe('EMAIL');
    });

    it('is tenant-scoped — the same value in another tenant is a distinct subject + anchor', async () => {
      const a = await service.recordAnchor({
        tenant_id: TENANT_A,
        talent_record_id: TALENT_2,
        anchor_kind: 'PHONE',
        normalized_value: '15551234567',
        raw_source: '+1 (555) 123-4567',
        created_by: CREATED_BY,
      });
      const b = await service.recordAnchor({
        tenant_id: TENANT_B,
        talent_record_id: TALENT_2,
        anchor_kind: 'PHONE',
        normalized_value: '15551234567',
        raw_source: '+1 (555) 123-4567',
        created_by: CREATED_BY,
      });
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(a!.anchor.subject_id).not.toBe(b!.anchor.subject_id);
      expect(a!.anchor.tenant_id).toBe(TENANT_A);
      expect(b!.anchor.tenant_id).toBe(TENANT_B);
    });

    it('is idempotent — re-recording the same anchor is a no-op (no duplicate evidence or anchor)', async () => {
      const first = await service.recordAnchor({
        tenant_id: TENANT_A,
        talent_record_id: TALENT_1,
        anchor_kind: 'PHONE',
        normalized_value: '19998887777',
        raw_source: '999-888-7777 (+1)',
        created_by: CREATED_BY,
      });
      expect(first).not.toBeNull();
      const subjectId = first!.anchor.subject_id;

      const second = await service.recordAnchor({
        tenant_id: TENANT_A,
        talent_record_id: TALENT_1,
        anchor_kind: 'PHONE',
        normalized_value: '19998887777',
        raw_source: '999-888-7777 (+1)',
        created_by: CREATED_BY,
      });
      expect(second).toBeNull(); // idempotent skip

      const anchors = (await repo.listAnchorsBySubject(subjectId)).filter(
        (x) => x.anchor_kind === 'PHONE' && x.normalized_value === '19998887777',
      );
      expect(anchors).toHaveLength(1);
      const phoneEvidence = (await repo.listEvidenceBySubject(subjectId)).filter(
        (e) =>
          e.assertion_type === 'PHONE' &&
          (e.assertion_payload as { normalized_value: string }).normalized_value === '19998887777',
      );
      expect(phoneEvidence).toHaveLength(1);
    });

    it('keeps anchors on their ORIGIN subject through merge + unmerge (un-merge contract)', async () => {
      const one = await service.recordAnchor({
        tenant_id: TENANT_A,
        talent_record_id: 'cccccccc-cccc-7ccc-8ccc-cccccccccccc',
        anchor_kind: 'EMAIL',
        normalized_value: 'origin-a@example.com',
        raw_source: 'origin-a@example.com',
        created_by: CREATED_BY,
      });
      const two = await service.recordAnchor({
        tenant_id: TENANT_A,
        talent_record_id: 'dddddddd-dddd-7ddd-8ddd-dddddddddddd',
        anchor_kind: 'EMAIL',
        normalized_value: 'origin-b@example.com',
        raw_source: 'origin-b@example.com',
        created_by: CREATED_BY,
      });
      const subjectA = one!.anchor.subject_id;
      const subjectB = two!.anchor.subject_id;
      expect(subjectA).not.toBe(subjectB);

      // Merge B into A — pointer-only; anchors must NOT be re-homed.
      await service.mergeSubjects(subjectA, subjectB, 'tr2a1-unmerge-test');
      const bAnchorsAfterMerge = await repo.listAnchorsBySubject(subjectB);
      expect(bAnchorsAfterMerge).toHaveLength(1);
      expect(bAnchorsAfterMerge[0]!.subject_id).toBe(subjectB); // origin preserved
      expect(bAnchorsAfterMerge[0]!.normalized_value).toBe('origin-b@example.com');

      // Unmerge B — anchor still on its origin subject.
      await service.unmergeSubjects(subjectB, 'tr2a1-unmerge-test');
      const bAnchorsAfterUnmerge = await repo.listAnchorsBySubject(subjectB);
      expect(bAnchorsAfterUnmerge).toHaveLength(1);
      expect(bAnchorsAfterUnmerge[0]!.subject_id).toBe(subjectB);
    });
  },
);
