import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { SubjectMatcherService } from '../lib/subject-matcher.service.js';
import { SubjectResolutionService } from '../lib/subject-resolution.service.js';
import { TalentTrustRepository } from '../lib/talent-trust.repository.js';
import { TalentTrustService } from '../lib/talent-trust.service.js';

// TR-2a-3 advisory resolution — real Postgres 17. Proves the FULL arc end-to-end:
// matcher writes an advisory (TR-2a-2) → human approve executes the pointer-only
// merge + records the audit (→ MERGED) → reverse un-merges (both ACTIVE, →
// REVERSED). Plus the contradiction gate (R3), dismiss, and idempotency (R5).

const MIGRATIONS = [
  '../../prisma/migrations/20260628000000_init_talent_trust/migration.sql',
  '../../prisma/migrations/20260703120000_tr2a1_subject_anchor/migration.sql',
  '../../prisma/migrations/20260703130000_tr2a2_match_advisory/migration.sql',
  '../../prisma/migrations/20260703140000_tr2a3_advisory_resolution/migration.sql',
].map((p) => resolve(__dirname, p));

const CREATED_BY = 'tr2a3-resolution-integration';
const ACTOR = 'reviewer-admin';

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

// Create a same-human advisory for a fresh tenant and return {tenant, advisory, s1, s2}.
async function makeAdvisory(
  service: TalentTrustService,
  matcher: SubjectMatcherService,
  opts: { contradiction?: boolean } = {},
): Promise<{ tenant: string; advisoryId: string; s1: string; s2: string }> {
  const tenant = uuidv7();
  const email = `shared-${uuidv7()}@example.com`;
  const s1 = await seed(service, tenant, [
    { kind: 'EMAIL', value: email },
    ...(opts.contradiction ? ([{ kind: 'PHONE', value: '15550000001' }] as const) : []),
  ]);
  const s2 = await seed(service, tenant, [
    { kind: 'EMAIL', value: email },
    ...(opts.contradiction ? ([{ kind: 'PHONE', value: '15550000002' }] as const) : []),
  ]);
  const advisories = await matcher.matchSubject(tenant, s1);
  const advisory = advisories.find((a) => [a.subject_a_id, a.subject_b_id].includes(s2))!;
  return { tenant, advisoryId: advisory.id, s1, s2 };
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'SubjectResolutionService — advisory resolution (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let service: TalentTrustService;
    let matcher: SubjectMatcherService;
    let resolution: SubjectResolutionService;
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
      resolution = new SubjectResolutionService(repo, service);
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    it('approve → pointer-only merge (b→a), advisory MERGED + audited', async () => {
      const { tenant, advisoryId, s1, s2 } = await makeAdvisory(service, matcher);

      const resolved = await resolution.approveMerge({
        tenant_id: tenant,
        advisory_id: advisoryId,
        actor: ACTOR,
      });

      // Canonical direction: subject_a survives, subject_b merges into it.
      const [a, b] = s1 < s2 ? [s1, s2] : [s2, s1];
      expect(resolved.status).toBe('MERGED');
      expect(resolved.resolution_action).toBe('MERGE');
      expect(resolved.resolved_by).toBe(ACTOR);
      expect(resolved.surviving_subject_id).toBe(a);
      expect(resolved.merged_subject_id).toBe(b);
      expect(resolved.resolved_at).not.toBeNull();

      // The pointer-only merge actually happened: the merged subject → MERGED,
      // merged_into = surviving; the surviving subject untouched (ACTIVE).
      const mergedSubject = await repo.findSubjectById(b);
      const survivingSubject = await repo.findSubjectById(a);
      expect(mergedSubject?.status).toBe('MERGED');
      expect(mergedSubject?.merged_into_subject_id).toBe(a);
      expect(survivingSubject?.status).toBe('ACTIVE');
      expect(survivingSubject?.merged_into_subject_id).toBeNull();
    });

    it('reverse a MERGED advisory → both subjects ACTIVE, merged_into cleared, advisory REVERSED', async () => {
      const { tenant, advisoryId, s1, s2 } = await makeAdvisory(service, matcher);
      await resolution.approveMerge({ tenant_id: tenant, advisory_id: advisoryId, actor: ACTOR });

      const reversed = await resolution.reverseMerge({
        tenant_id: tenant,
        advisory_id: advisoryId,
        actor: ACTOR,
        justification: 'reviewer error — different people',
      });

      expect(reversed.status).toBe('REVERSED');
      expect(reversed.resolution_action).toBe('REVERSE');
      expect(reversed.reversed_by).toBe(ACTOR);
      // Original merge audit is PRESERVED (append-style history).
      expect(reversed.surviving_subject_id).not.toBeNull();
      expect(reversed.merged_subject_id).not.toBeNull();

      // Both subjects restored.
      const restoredA = await repo.findSubjectById(s1);
      const restoredB = await repo.findSubjectById(s2);
      expect(restoredA?.status).toBe('ACTIVE');
      expect(restoredB?.status).toBe('ACTIVE');
      expect(restoredA?.merged_into_subject_id).toBeNull();
      expect(restoredB?.merged_into_subject_id).toBeNull();
    });

    it('dismiss → advisory DISMISSED, subjects untouched (no merge)', async () => {
      const { tenant, advisoryId, s1, s2 } = await makeAdvisory(service, matcher);

      const dismissed = await resolution.dismiss({
        tenant_id: tenant,
        advisory_id: advisoryId,
        actor: ACTOR,
        justification: 'not the same human',
      });
      expect(dismissed.status).toBe('DISMISSED');
      expect(dismissed.resolution_action).toBe('DISMISS');

      const a = await repo.findSubjectById(s1);
      const b = await repo.findSubjectById(s2);
      expect(a?.status).toBe('ACTIVE');
      expect(b?.status).toBe('ACTIVE');
    });

    it('contradicted advisory: approve WITHOUT ack+justification rejects; WITH → merges (R3)', async () => {
      const { tenant, advisoryId } = await makeAdvisory(service, matcher, { contradiction: true });

      await expect(
        resolution.approveMerge({ tenant_id: tenant, advisory_id: advisoryId, actor: ACTOR }),
      ).rejects.toThrow();

      // Still PENDING_REVIEW after the rejected attempt.
      const stillPending = await repo.findMatchAdvisoryById(tenant, advisoryId);
      expect(stillPending?.status).toBe('PENDING_REVIEW');

      const merged = await resolution.approveMerge({
        tenant_id: tenant,
        advisory_id: advisoryId,
        actor: ACTOR,
        override_acknowledged: true,
        justification: 'same person — changed phone; confirmed by reference',
      });
      expect(merged.status).toBe('MERGED');
      expect(merged.resolution_justification).toContain('changed phone');
    });

    it('idempotency: cannot re-resolve a resolved advisory (R5)', async () => {
      const { tenant, advisoryId } = await makeAdvisory(service, matcher);
      await resolution.approveMerge({ tenant_id: tenant, advisory_id: advisoryId, actor: ACTOR });

      await expect(
        resolution.dismiss({ tenant_id: tenant, advisory_id: advisoryId, actor: ACTOR }),
      ).rejects.toThrow();
      await expect(
        resolution.approveMerge({ tenant_id: tenant, advisory_id: advisoryId, actor: ACTOR }),
      ).rejects.toThrow();
    });

    it('tenant-scoped: an advisory is not resolvable from another tenant', async () => {
      const { advisoryId } = await makeAdvisory(service, matcher);
      await expect(
        resolution.dismiss({ tenant_id: uuidv7(), advisory_id: advisoryId, actor: ACTOR }),
      ).rejects.toThrow();
    });
  },
);
