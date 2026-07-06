import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { SubjectMatcherService } from '../lib/subject-matcher.service.js';
import { TalentTrustRepository } from '../lib/talent-trust.repository.js';
import { TalentTrustService } from '../lib/talent-trust.service.js';

// TR-2a-2 within-tenant same-human matcher — real Postgres 17. Applies the init +
// SubjectAnchor + SubjectMatchAdvisory migrations and proves against real SQL:
//   - a shared-anchor pair → an advisory with the correct band (WEAK for one);
//   - multi-anchor (email + phone) → ADVISE_STRONG;
//   - contradiction (same email, different phone) → flagged;
//   - ADVISE-ONLY: matching NEVER merges / changes subject state (subjects unchanged);
//   - tenant-scoped: the same value in another tenant yields NO cross-tenant advisory;
//   - deterministic: re-running yields the SAME advisory (same id, same band);
//   - backfill idempotent: re-run produces no duplicate advisory;
//   - worst case: two DIFFERENT humans sharing a recycled anchor → an ADVISORY, never a merge.

const MIGRATIONS = [
  '../../prisma/migrations/20260628000000_init_talent_trust/migration.sql',
  '../../prisma/migrations/20260703120000_tr2a1_subject_anchor/migration.sql',
  '../../prisma/migrations/20260703130000_tr2a2_match_advisory/migration.sql',
  // TR-2a-3 added SubjectMatchAdvisory resolution columns; the regenerated client
  // SELECTs them on every advisory query, so this list must apply the migration.
  '../../prisma/migrations/20260703140000_tr2a3_advisory_resolution/migration.sql',
  // Slice-B1 — ResolutionSubject.last_reconciled_at + reconcile_attempts.
  '../../prisma/migrations/20260705120000_add_reconcile_watermark_to_resolution_subject/migration.sql',
  // TR-2a-B1 — SubjectAnchor.source_class + extended (…, source_class) unique key.
  '../../prisma/migrations/20260706170000_tr2a_b1_subject_anchor_source_class/migration.sql',
  '../../prisma/migrations/20260706180000_tr2a_b1_subject_anchor_source_class_unique/migration.sql',
].map((p) => resolve(__dirname, p));

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '22222222-2222-7222-8222-222222222222';
const CREATED_BY = 'tr2a2-match-integration';

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

// Mint a subject with the given identifier anchors by recording them via the
// producer seam (recordAnchor resolves-or-creates the ATS_TALENT_RECORD subject).
// The ATS TalentRecord.id ref is a UUID — mint one per seeded talent so all its
// anchors resolve to the SAME subject. Returns the subject id.
async function seed(
  service: TalentTrustService,
  tenantId: string,
  anchors: Array<{ kind: 'EMAIL' | 'PHONE'; value: string }>,
): Promise<string> {
  const talentRecordId = uuidv7();
  let subjectId: string | null = null;
  for (const anc of anchors) {
    const written = await service.recordAnchor({
      tenant_id: tenantId,
      talent_record_id: talentRecordId,
      anchor_kind: anc.kind,
      normalized_value: anc.value,
      raw_source: anc.value,
      created_by: CREATED_BY,
    });
    if (written !== null) subjectId = written.anchor.subject_id;
  }
  if (subjectId === null) throw new Error('seed recorded no anchors');
  return subjectId;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'SubjectMatcherService — within-tenant same-human matcher (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let service: TalentTrustService;
    let matcher: SubjectMatcherService;
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
      matcher = new SubjectMatcherService(repo);
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    it('detects a shared-anchor pair → one ADVISE_WEAK advisory (canonical pair, PENDING_REVIEW)', async () => {
      const s1 = await seed(service, TENANT_A, [{ kind: 'EMAIL', value: 'weak@example.com' }]);
      const s2 = await seed(service, TENANT_A, [{ kind: 'EMAIL', value: 'weak@example.com' }]);

      const advisories = await matcher.matchSubject(TENANT_A, s1);
      expect(advisories).toHaveLength(1);
      const adv = advisories[0]!;

      expect(adv.advise_band).toBe('ADVISE_WEAK');
      expect(adv.has_contradiction).toBe(false);
      expect(adv.status).toBe('PENDING_REVIEW');
      // Canonical unordered pair (a < b), covering exactly {s1, s2}.
      expect(adv.subject_a_id < adv.subject_b_id).toBe(true);
      expect([adv.subject_a_id, adv.subject_b_id].sort()).toEqual([s1, s2].sort());
      // match_basis points to the shared EMAIL anchor (PII-free — refs only).
      const basis = adv.match_basis as { shared: Array<{ anchor_kind: string }> };
      expect(basis.shared).toHaveLength(1);
      expect(basis.shared[0]!.anchor_kind).toBe('EMAIL');
      expect(JSON.stringify(adv.match_basis)).not.toContain('weak@example.com');
    });

    it('multi-anchor pair (shared email + phone) → ADVISE_STRONG', async () => {
      const s1 = await seed(service, TENANT_A, [
        { kind: 'EMAIL', value: 'strong@example.com' },
        { kind: 'PHONE', value: '15550001111' },
      ]);
      const s2 = await seed(service, TENANT_A, [
        { kind: 'EMAIL', value: 'strong@example.com' },
        { kind: 'PHONE', value: '15550001111' },
      ]);

      const advisories = await matcher.matchSubject(TENANT_A, s1);
      const adv = advisories.find(
        (x) => [x.subject_a_id, x.subject_b_id].includes(s2),
      )!;
      expect(adv.advise_band).toBe('ADVISE_STRONG');
      expect(adv.has_contradiction).toBe(false);
      const basis = adv.match_basis as { shared: unknown[] };
      expect(basis.shared).toHaveLength(2);
    });

    it('contradiction (same email, different phone) → flagged', async () => {
      const s1 = await seed(service, TENANT_A, [
        { kind: 'EMAIL', value: 'contra@example.com' },
        { kind: 'PHONE', value: '15551110000' },
      ]);
      const s2 = await seed(service, TENANT_A, [
        { kind: 'EMAIL', value: 'contra@example.com' },
        { kind: 'PHONE', value: '15559990000' },
      ]);

      const advisories = await matcher.matchSubject(TENANT_A, s1);
      const adv = advisories.find((x) => [x.subject_a_id, x.subject_b_id].includes(s2))!;
      expect(adv.has_contradiction).toBe(true);
      const basis = adv.match_basis as { contradiction_kinds: string[] };
      expect(basis.contradiction_kinds).toEqual(['PHONE']);
      // One shared anchor (email) → WEAK, with the contradiction flag on top.
      expect(adv.advise_band).toBe('ADVISE_WEAK');
    });

    it('ADVISE-ONLY: matching NEVER merges or changes subject state', async () => {
      const s1 = await seed(service, TENANT_A, [{ kind: 'PHONE', value: '15552223333' }]);
      const s2 = await seed(service, TENANT_A, [{ kind: 'PHONE', value: '15552223333' }]);

      await matcher.matchSubject(TENANT_A, s1);

      const a = await repo.findSubjectById(s1);
      const b = await repo.findSubjectById(s2);
      expect(a?.status).toBe('ACTIVE');
      expect(a?.merged_into_subject_id).toBeNull();
      expect(b?.status).toBe('ACTIVE');
      expect(b?.merged_into_subject_id).toBeNull();
    });

    it('is tenant-scoped — the same value in another tenant is NOT a match', async () => {
      const aSubj = await seed(service, TENANT_A, [{ kind: 'EMAIL', value: 'cross@example.com' }]);
      await seed(service, TENANT_B, [{ kind: 'EMAIL', value: 'cross@example.com' }]);

      const advisories = await matcher.matchSubject(TENANT_A, aSubj);
      // No OTHER tenant-A subject shares the value → no advisory.
      expect(advisories).toEqual([]);
      // And tenant B has no advisory at all from this cross-tenant value.
      expect(await repo.listMatchAdvisories(TENANT_B)).toEqual([]);
    });

    it('is deterministic — re-running matchSubject yields the SAME advisory (same id, band)', async () => {
      const s1 = await seed(service, TENANT_A, [{ kind: 'EMAIL', value: 'det@example.com' }]);
      await seed(service, TENANT_A, [{ kind: 'EMAIL', value: 'det@example.com' }]);

      const first = await matcher.matchSubject(TENANT_A, s1);
      const second = await matcher.matchSubject(TENANT_A, s1);
      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);
      expect(second[0]!.id).toBe(first[0]!.id); // upsert, not insert
      expect(second[0]!.advise_band).toBe(first[0]!.advise_band);
    });

    it('backfill sweep is idempotent — re-run produces no duplicate advisory', async () => {
      // A fresh isolated tenant so the count assertion is exact.
      const tenant = '33333333-3333-7333-8333-333333333333';
      await seed(service, tenant, [{ kind: 'EMAIL', value: 'bf@example.com' }]);
      await seed(service, tenant, [{ kind: 'EMAIL', value: 'bf@example.com' }]);

      const run1 = await matcher.backfillMatches(tenant);
      expect(run1.subjects).toBe(2);
      const after1 = await repo.listMatchAdvisories(tenant);
      expect(after1).toHaveLength(1);

      const run2 = await matcher.backfillMatches(tenant);
      expect(run2.subjects).toBe(2);
      const after2 = await repo.listMatchAdvisories(tenant);
      expect(after2).toHaveLength(1); // no duplicate
      expect(after2[0]!.id).toBe(after1[0]!.id);
    });

    it('worst case — two DIFFERENT humans sharing a recycled phone → an ADVISORY, never a merge', async () => {
      const tenant = '44444444-4444-7444-8444-444444444444';
      // Same recycled phone, different email → shared phone + contradicting email.
      const s1 = await seed(service, tenant, [
        { kind: 'PHONE', value: '15550009999' },
        { kind: 'EMAIL', value: 'humanone@example.com' },
      ]);
      const s2 = await seed(service, tenant, [
        { kind: 'PHONE', value: '15550009999' },
        { kind: 'EMAIL', value: 'humantwo@example.com' },
      ]);

      const advisories = await matcher.matchSubject(tenant, s1);
      expect(advisories).toHaveLength(1);
      expect(advisories[0]!.has_contradiction).toBe(true); // recycled-anchor smell

      // The whole point: an advisory, NOT a merge. Both subjects untouched.
      const a = await repo.findSubjectById(s1);
      const b = await repo.findSubjectById(s2);
      expect(a?.status).toBe('ACTIVE');
      expect(b?.status).toBe('ACTIVE');
      expect(a?.merged_into_subject_id).toBeNull();
      expect(b?.merged_into_subject_id).toBeNull();
    });
  },
);
