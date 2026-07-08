import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { TalentTrustRepository } from '../lib/talent-trust.repository.js';
import { SubjectMatcherService } from '../lib/subject-matcher.service.js';
import { TalentTrustService, type SubjectRef } from '../lib/talent-trust.service.js';

// Fix-Slice-1 integration test — proves the SOURCED_TALENT ref_type against
// real SQL: evidence attaches to a ResolutionSubject keyed to an L1
// sourced_talent staging arrival BEFORE any TalentRecord exists (pre-promotion
// attachment, Lifecycle Spec §3.2). The ref is UUID-only, no cross-schema FK
// (I1) — the arrival id is a bare UUID here (the sourced_talent row lives in
// its own schema; the no-FK rule is exactly what lets this stand alone).

const MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260628000000_init_talent_trust/migration.sql',
);
// Slice-B1 — ResolutionSubject.last_reconciled_at + reconcile_attempts (the
// regenerated client SELECTs them on every subject read).
const WATERMARK_MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260705120000_add_reconcile_watermark_to_resolution_subject/migration.sql',
);
// TR-6 B1 — ResolutionSubject.last_matched_at (the regenerated client SELECTs it).
const LAST_MATCHED_MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260707120000_tr6_b1_last_matched_at/migration.sql',
);

const TENANT = '22222222-2222-7222-8222-222222222222';
// Stands in for a sourced_talent arrival id (sourced_talent.SourcedTalent.id).
const ARRIVAL_ID = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';

const sourcedRef: SubjectRef = {
  tenant_id: TENANT,
  ref_type: 'SOURCED_TALENT',
  ref_id: ARRIVAL_ID,
  link_source: 'fix-slice-1-integration',
};

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
  'TalentTrust — SOURCED_TALENT pre-promotion attachment (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let repo: TalentTrustRepository;
    let service: TalentTrustService;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const migrationSql = readFileSync(MIGRATION_PATH, 'utf8');
      const watermarkSql = readFileSync(WATERMARK_MIGRATION_PATH, 'utf8');
      const lastMatchedSql = readFileSync(LAST_MATCHED_MIGRATION_PATH, 'utf8');

      const setupClient = new PrismaService(url);
      await setupClient.$connect();
      for (const stmt of [
        ...splitDdl(migrationSql),
        ...splitDdl(watermarkSql),
        ...splitDdl(lastMatchedSql),
      ]) {
        const trimmed = stmt.trim();
        if (trimmed.length === 0) continue;
        await setupClient.$executeRawUnsafe(trimmed);
      }
      await setupClient.$disconnect();

      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new TalentTrustRepository(prisma);
      service = new TalentTrustService(repo, new SubjectMatcherService(repo));
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    it('recordEvidence resolves-or-creates a subject keyed to a SOURCED_TALENT arrival and attaches evidence (pre-promotion)', async () => {
      const ev = await service.recordEvidence({
        subjectRef: sourcedRef,
        dimension: 'CLAIMS',
        assertion_type: 'SKILL',
        // TR-4 B1 — SKILL registered canonical shape.
        assertion_payload: { value_raw: 'Go' },
        source_class: 'SELF',
        method: 'SELF_DECLARED',
        portability_class: 'TENANT_ONLY',
        decay_profile: 'MODERATE',
        created_by: 'sourcing-collector',
      });
      expect(ev.current_status).toBe('VALID');

      // The subject resolved from the SOURCED_TALENT ref (no TalentRecord yet).
      const subject = await repo.findSubjectByRef(TENANT, 'SOURCED_TALENT', ARRIVAL_ID);
      expect(subject).not.toBeNull();
      expect(subject?.id).toBe(ev.subject_id);

      const state = await service.getTrustState(sourcedRef);
      expect(state?.claims_band).toBe('SELF_ASSERTED');
    });

    it('re-resolves the SAME subject for the same arrival (one ref → one subject)', async () => {
      const again = await service.recordEvidence({
        subjectRef: sourcedRef,
        dimension: 'IDENTITY',
        assertion_type: 'EMPLOYMENT',
        // TR-4 B1 — EMPLOYMENT registered canonical shape.
        assertion_payload: { employer_raw: 'Acme', role_title_raw: 'Engineer' },
        source_class: 'SELF',
        method: 'SELF_DECLARED',
        portability_class: 'TENANT_ONLY',
        decay_profile: 'MODERATE',
        created_by: 'sourcing-collector',
      });
      const subject = await repo.findSubjectByRef(TENANT, 'SOURCED_TALENT', ARRIVAL_ID);
      expect(again.subject_id).toBe(subject?.id);
    });

    it('persists the ref by UUID with no cross-schema FK (the arrival lives in another schema)', async () => {
      const refRow = await prisma.resolutionSubjectRef.findUnique({
        where: {
          tenant_id_ref_type_ref_id: {
            tenant_id: TENANT,
            ref_type: 'SOURCED_TALENT',
            ref_id: ARRIVAL_ID,
          },
        },
      });
      expect(refRow?.ref_type).toBe('SOURCED_TALENT');
      expect(refRow?.ref_id).toBe(ARRIVAL_ID);
    });
  },
);
