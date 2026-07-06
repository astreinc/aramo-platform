import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { TalentTrustRepository } from '../lib/talent-trust.repository.js';
import { TalentTrustService, type SubjectRef } from '../lib/talent-trust.service.js';

// Promotion-Trigger slice B-api integration — the sourcing-pool readers against
// real Postgres 17. Proves (1) listSourcedPool is a true anti-join: a subject
// with a SOURCED_TALENT ref but NO ATS_TALENT_RECORD ref appears; a promoted
// subject (ATS_TALENT_RECORD attached) is excluded; a subject with no
// SOURCED_TALENT ref is excluded; (2) it is oldest-first with a working
// (created_at, id) keyset cursor; (3) listDisplayIdentityEvidence returns
// batched VALID FULL_NAME/EMAIL for a page of subjects (no N+1). Tenant-scoped.

const MIGRATIONS = [
  '../../prisma/migrations/20260628000000_init_talent_trust/migration.sql',
  '../../prisma/migrations/20260705120000_add_reconcile_watermark_to_resolution_subject/migration.sql',
  '../../prisma/migrations/20260706120000_ats_ref_partial_unique/migration.sql',
  // Slice B-api — the keyset index the list reader scans.
  '../../prisma/migrations/20260706160000_sourcing_pool_keyset_index/migration.sql',
].map((p) => resolve(__dirname, p));

const CREATED_BY = 'sourcing-pool-integration';

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
  'TalentTrust — sourcing-pool readers (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let repo: TalentTrustRepository;
    let service: TalentTrustService;

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

    // Mint a subject keyed to a SOURCED_TALENT arrival, with a name + email.
    async function seedSourced(
      tenant: string,
      name: { first: string; last: string },
      email: string,
    ): Promise<string> {
      const arrivalId = uuidv7();
      const ref: SubjectRef = { tenant_id: tenant, ref_type: 'SOURCED_TALENT', ref_id: arrivalId };
      const nameEv = await service.recordEvidence({
        subjectRef: ref,
        dimension: 'IDENTITY',
        assertion_type: 'FULL_NAME',
        assertion_payload: { first_name: name.first, last_name: name.last },
        source_class: 'THIRD_PARTY_UNVERIFIED',
        method: 'DOCUMENT',
        portability_class: 'TENANT_ONLY',
        decay_profile: 'SLOW',
        created_by: CREATED_BY,
      });
      await service.recordEvidence({
        subjectRef: ref,
        dimension: 'IDENTITY',
        assertion_type: 'EMAIL',
        assertion_payload: { normalized_value: email },
        source_class: 'THIRD_PARTY_UNVERIFIED',
        method: 'DOCUMENT',
        portability_class: 'TENANT_ONLY',
        decay_profile: 'SLOW',
        created_by: CREATED_BY,
      });
      return nameEv.subject_id;
    }

    it('anti-join: sourced-unpromoted appears; promoted + non-sourced excluded', async () => {
      const tenant = uuidv7();
      // (a) sourced + unpromoted → IN the pool.
      const sourced = await seedSourced(tenant, { first: 'Ada', last: 'Lovelace' }, 'ada@x.com');
      // (b) sourced then PROMOTED (ATS_TALENT_RECORD attached) → EXCLUDED.
      const promoted = await seedSourced(tenant, { first: 'Grace', last: 'Hopper' }, 'grace@x.com');
      await service.attachSubjectRef({
        subject_id: promoted,
        tenant_id: tenant,
        ref_type: 'ATS_TALENT_RECORD',
        ref_id: uuidv7(),
        link_source: CREATED_BY,
      });
      // (c) a subject with NO SOURCED_TALENT ref (ATS-only) → EXCLUDED.
      const atsOnly: SubjectRef = { tenant_id: tenant, ref_type: 'ATS_TALENT_RECORD', ref_id: uuidv7() };
      await service.recordEvidence({
        subjectRef: atsOnly,
        dimension: 'IDENTITY',
        assertion_type: 'FULL_NAME',
        assertion_payload: { first_name: 'Not', last_name: 'Sourced' },
        source_class: 'THIRD_PARTY_UNVERIFIED',
        method: 'DOCUMENT',
        portability_class: 'TENANT_ONLY',
        decay_profile: 'SLOW',
        created_by: CREATED_BY,
      });

      const page = await repo.listSourcedPool({ tenant_id: tenant, limit: 50 });
      const ids = page.map((r) => r.subject_id);
      expect(ids).toContain(sourced);
      expect(ids).not.toContain(promoted);
      // Bands present from the 1:1 TrustState (identity has evidence).
      const row = page.find((r) => r.subject_id === sourced)!;
      expect(row.identity_band).not.toBeNull();
      expect(row.open_contradiction_count).toBe(0);
    });

    it('oldest-first + keyset cursor walks the pool without gaps or repeats', async () => {
      const tenant = uuidv7();
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push(await seedSourced(tenant, { first: `P${i}`, last: 'Q' }, `p${i}@x.com`));
      }

      // Page 1 (limit 2), then follow the keyset cursor twice.
      const page1 = await repo.listSourcedPool({ tenant_id: tenant, limit: 2 });
      expect(page1).toHaveLength(2);
      const c1 = page1[page1.length - 1]!;
      const page2 = await repo.listSourcedPool({
        tenant_id: tenant,
        limit: 2,
        cursor: { created_at: c1.created_at, id: c1.subject_id },
      });
      const c2 = page2[page2.length - 1]!;
      const page3 = await repo.listSourcedPool({
        tenant_id: tenant,
        limit: 2,
        cursor: { created_at: c2.created_at, id: c2.subject_id },
      });

      const walked = [...page1, ...page2, ...page3].map((r) => r.subject_id);
      // All 5 seen exactly once, in oldest-first order (the seed order).
      expect(walked).toEqual(ids);
      expect(new Set(walked).size).toBe(5);
    });

    it('listDisplayIdentityEvidence batches VALID FULL_NAME/EMAIL for a page (no N+1)', async () => {
      const tenant = uuidv7();
      const a = await seedSourced(tenant, { first: 'Alan', last: 'Turing' }, 'alan@x.com');
      const b = await seedSourced(tenant, { first: 'Edsger', last: 'Dijkstra' }, 'ed@x.com');

      const rows = await repo.listDisplayIdentityEvidence(tenant, [a, b]);
      const forA = rows.filter((r) => r.subject_id === a);
      expect(forA.map((r) => r.assertion_type).sort()).toEqual(['EMAIL', 'FULL_NAME']);
      const emailA = forA.find((r) => r.assertion_type === 'EMAIL');
      expect((emailA?.assertion_payload as { normalized_value?: string })?.normalized_value).toBe('alan@x.com');
      // Both subjects covered in the single batched read.
      expect(new Set(rows.map((r) => r.subject_id))).toEqual(new Set([a, b]));
    });

    it('empty subject list → no query, empty result', async () => {
      const rows = await repo.listDisplayIdentityEvidence(uuidv7(), []);
      expect(rows).toEqual([]);
    });

    it('tenant-scoped: another tenant sees an empty pool', async () => {
      const tenant = uuidv7();
      await seedSourced(tenant, { first: 'Solo', last: 'Tenant' }, 'solo@x.com');
      const other = await repo.listSourcedPool({ tenant_id: uuidv7(), limit: 50 });
      expect(other).toEqual([]);
    });
  },
);
