import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { TalentEmbeddingRepository } from '../lib/talent-embedding.repository.js';

// Enterprise Search GS-2A — the talent-embedding lib against a REAL pgvector-capable Postgres 17.
// Proves what only a live pgvector runtime can:
//   - the migration applies clean on an empty DB: CREATE EXTENSION vector succeeds; the vector type,
//     the talent_embedding schema/table, and the HNSW cosine index all exist;
//   - a full lifecycle round-trip through the repo: enqueue → claimPending → saveReady(vector) →
//     getDescriptor(ready) → searchSemanticForActor returns the nearest by cosine distance →
//     invalidate removes it;
//   - tenant + site visibility is co-located in the vector SQL (another tenant/site is absent);
//   - the non-vector lifecycle columns behave (markFailed transitions, attempt_count increments).

const MIGRATION = resolve(
  __dirname,
  '../../prisma/migrations/20260930120000_init_talent_embedding/migration.sql',
);

// splitDdl — strip `--` comments to EOL, split on statement-terminating `;\n`. The migration is
// authored splitter-safe (no `$$` blocks, no `;` inside comments).
function splitDdl(sql: string): string[] {
  return sql
    .replace(/--[^\n]*$/gm, '')
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '22222222-2222-7222-8222-222222222222';
const SITE_1 = 'aaaaaaaa-1111-7111-8111-aaaaaaaaaaaa';
const SITE_2 = 'bbbbbbbb-2222-7222-8222-bbbbbbbbbbbb';
const TALENT_1 = 'cccccccc-1111-7111-8111-cccccccccccc';
const TALENT_2 = 'dddddddd-2222-7222-8222-dddddddddddd';

// Two near-orthogonal 1536-dim unit vectors so cosine distance ranks deterministically.
function unitVector(hot: number): number[] {
  const v = new Array<number>(1536).fill(0);
  v[hot] = 1;
  return v;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Enterprise Search GS-2A — talent-embedding (real pgvector Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let repo: TalentEmbeddingRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      prisma = new PrismaService(container.getConnectionUri());
      await prisma.$connect();
      for (const stmt of splitDdl(readFileSync(MIGRATION, 'utf8'))) {
        await prisma.$executeRawUnsafe(stmt);
      }
      repo = new TalentEmbeddingRepository(prisma);
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    it('installs the vector extension, the schema/table, and the HNSW index', async () => {
      const ext = await prisma.$queryRawUnsafe<{ extversion: string }[]>(
        `SELECT extversion FROM pg_extension WHERE extname = 'vector'`,
      );
      expect(ext).toHaveLength(1);
      expect(ext[0]?.extversion).toBeTruthy();

      const tbl = await prisma.$queryRawUnsafe<{ n: bigint | number }[]>(
        `SELECT count(*) AS n FROM information_schema.tables WHERE table_schema='talent_embedding' AND table_name='TalentEmbedding'`,
      );
      expect(Number(tbl[0]?.n)).toBe(1);

      const idx = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
        `SELECT indexname FROM pg_indexes WHERE schemaname='talent_embedding' AND indexname='TalentEmbedding_embedding_hnsw'`,
      );
      expect(idx).toHaveLength(1);
    });

    it('round-trips the full lifecycle: enqueue → claim → saveReady → getDescriptor → search → invalidate', async () => {
      await repo.enqueue({ tenant_id: TENANT_A, talent_record_id: TALENT_1, site_id: SITE_1 });
      await repo.enqueue({ tenant_id: TENANT_A, talent_record_id: TALENT_2, site_id: SITE_1 });

      const claimed = await repo.claimPending(10);
      expect(claimed.map((c) => c.talent_record_id).sort()).toEqual([TALENT_1, TALENT_2].sort());

      await repo.saveReady({
        tenant_id: TENANT_A,
        talent_record_id: TALENT_1,
        site_id: SITE_1,
        vector: unitVector(0),
        source_hash: 'hash-1',
        embedding_model: 'text-embedding-3-small',
        dimension: 1536,
      });
      await repo.saveReady({
        tenant_id: TENANT_A,
        talent_record_id: TALENT_2,
        site_id: SITE_1,
        vector: unitVector(5),
        source_hash: 'hash-2',
        embedding_model: 'text-embedding-3-small',
        dimension: 1536,
      });

      const desc = await repo.getDescriptor({ tenant_id: TENANT_A, talent_record_id: TALENT_1 });
      expect(desc).toEqual({
        status: 'ready',
        source_hash: 'hash-1',
        embedding_model: 'text-embedding-3-small',
        dimension: 1536,
      });

      // Query nearest to TALENT_1's vector → TALENT_1 first (distance ~0).
      const hits = await repo.searchSemanticForActor({
        tenant_id: TENANT_A,
        site_id: SITE_1,
        query_vector: unitVector(0),
        limit: 10,
      });
      expect(hits[0]?.talent_record_id).toBe(TALENT_1);
      expect(hits[0]?.distance).toBeLessThan(0.01);
      expect(hits.map((h) => h.talent_record_id)).toContain(TALENT_2);

      await repo.invalidate({ tenant_id: TENANT_A, talent_record_id: TALENT_1 });
      expect(await repo.getDescriptor({ tenant_id: TENANT_A, talent_record_id: TALENT_1 })).toBeNull();
    });

    it('co-locates tenant + site visibility in the vector SQL (cross-tenant / cross-site absent)', async () => {
      const OTHER = 'eeeeeeee-3333-7333-8333-eeeeeeeeeeee';
      await repo.saveReady({
        tenant_id: TENANT_B,
        talent_record_id: OTHER,
        site_id: SITE_1,
        vector: unitVector(0),
        source_hash: 'h',
        embedding_model: 'm',
        dimension: 1536,
      });
      // Tenant A cannot see tenant B's embedding.
      const crossTenant = await repo.searchSemanticForActor({
        tenant_id: TENANT_A,
        site_id: SITE_1,
        query_vector: unitVector(0),
        limit: 10,
      });
      expect(crossTenant.map((h) => h.talent_record_id)).not.toContain(OTHER);

      // A different site in tenant B yields nothing (site-scoped).
      const crossSite = await repo.searchSemanticForActor({
        tenant_id: TENANT_B,
        site_id: SITE_2,
        query_vector: unitVector(0),
        limit: 10,
      });
      expect(crossSite).toHaveLength(0);
    });

    it('markFailed transitions to failed and increments attempt_count without invalidating', async () => {
      const t = uuidv7();
      await repo.enqueue({ tenant_id: TENANT_A, talent_record_id: t, site_id: null });
      await repo.markFailed({ tenant_id: TENANT_A, talent_record_id: t, error_message: 'boom' });
      const desc = await repo.getDescriptor({ tenant_id: TENANT_A, talent_record_id: t });
      expect(desc?.status).toBe('failed');
      const row = await prisma.talentEmbedding.findUnique({
        where: { tenant_id_talent_record_id: { tenant_id: TENANT_A, talent_record_id: t } },
        select: { attempt_count: true, last_error: true },
      });
      expect(row?.attempt_count).toBe(1);
      expect(row?.last_error).toBe('boom');
    });
  },
);
