import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { v7 as uuidv7 } from 'uuid';
import { TalentRecordRepository, TalentRecordPrismaService } from '@aramo/talent-record';
import {
  TalentEmbeddingRepository,
  TalentEmbeddingPrismaService,
} from '@aramo/talent-embedding';
import type { EmbeddingPort } from '@aramo/ai-draft';

import { EnterpriseSearchReadService } from '../search/enterprise-search-read.service.js';
import { TalentSearchAdapter } from '../search/adapters/talent-search.adapter.js';
import { EmbeddingProcessingConfig } from '../embedding/embedding-processing.config.js';
import { TalentEmbeddingReconcileService } from '../embedding/talent-embedding-reconcile.service.js';
import type { SearchAuthorityContext } from '../search/enterprise-search.port.js';

// Enterprise Search GS-2A — the semantic leg END-TO-END through the search orchestrator (the
// /v1/search read path minus HTTP transport), against a REAL pgvector Postgres 17. Drives the real
// EnterpriseSearchReadService → real TalentSearchAdapter → real TalentRecordRepository + real
// TalentEmbeddingRepository (the visibility-co-located vector SQL). Query-time embedding is a
// DETERMINISTIC fake (a test never calls a real embedding provider). Proves:
//   - a semantically-nearest Talent surfaces with signal 'semantic';
//   - the frozen three-band order (exact → lexical → semantic): a lexical hit outranks a semantic;
//   - visibility co-located in the vector SQL — another tenant's embedding is structurally absent.

const ROOT = resolve(__dirname, '../../../..');

function splitDdl(sql: string): string[] {
  return sql
    .replace(/--[^\n]*$/gm, '')
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function migrationsIn(lib: string): string[] {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d+_/.test(d.name))
    .map((d) => d.name)
    .sort()
    .map((d) => resolve(dir, d, 'migration.sql'));
}

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '22222222-2222-7222-8222-222222222222';
const SITE_1 = 'aaaaaaaa-1111-7111-8111-aaaaaaaaaaaa';

const ADA = uuidv7(); // tenant A — matches "Ada" by name (lexical) + has a far embedding
const BOB = uuidv7(); // tenant A — NOT a name match; embedding == the query vector (semantic)
const ZOE = uuidv7(); // tenant B — embedding == the query vector, but another tenant (absent)
const NEW = uuidv7(); // tenant A — live, NO embedding row (the reconcile anti-join target)

// Deterministic 1536-dim unit vectors so cosine distance ranks predictably.
function unit(hot: number): number[] {
  const v = new Array<number>(1536).fill(0);
  v[hot] = 1;
  return v;
}
// The fake query embedding always points at the BOB/ZOE vector (hot index 1).
const QUERY_VECTOR = unit(1);
const fakeEmbedding = {
  embed: async () => ({ vector: QUERY_VECTOR, provider: 'openai', model: 'text-embedding-3-small', dimension: 1536 }),
} as unknown as EmbeddingPort;
const enabledConfig = { isEnabled: () => true } as unknown as EmbeddingProcessingConfig;

function authority(tenant_id: string, site_id: string): SearchAuthorityContext {
  return {
    tenant_id,
    site_id,
    scopes: ['talent:search'],
    visibility: { actor_user_id: 'u-1', see_all_company: true, see_all_requisition: true, visible_client_ids: null },
  };
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Enterprise Search GS-2A — semantic leg through the orchestrator (real pgvector Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let talentPrisma: TalentRecordPrismaService;
    let embPrisma: TalentEmbeddingPrismaService;
    let svc: EnterpriseSearchReadService;
    let semanticRepo: TalentEmbeddingRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const url = container.getConnectionUri();
      const setup = new TalentRecordPrismaService(url);
      await setup.$connect();
      for (const lib of ['talent-record', 'talent-embedding']) {
        for (const path of migrationsIn(lib)) {
          for (const stmt of splitDdl(readFileSync(path, 'utf8'))) await setup.$executeRawUnsafe(stmt);
        }
      }
      await setup.$disconnect();

      talentPrisma = new TalentRecordPrismaService(url);
      embPrisma = new TalentEmbeddingPrismaService(url);
      await Promise.all([talentPrisma.$connect(), embPrisma.$connect()]);
      const talentRepo = new TalentRecordRepository(talentPrisma);
      semanticRepo = new TalentEmbeddingRepository(embPrisma);

      await talentPrisma.talentRecord.create({
        data: { id: ADA, tenant_id: TENANT_A, site_id: SITE_1, first_name: 'Ada', last_name: 'Lexical', email1: 'ada@a.test' },
      });
      await talentPrisma.talentRecord.create({
        data: { id: BOB, tenant_id: TENANT_A, site_id: SITE_1, first_name: 'Bob', last_name: 'Vector', email1: 'bob@a.test' },
      });
      await talentPrisma.talentRecord.create({
        data: { id: ZOE, tenant_id: TENANT_B, site_id: SITE_1, first_name: 'Zoe', last_name: 'Other', email1: 'zoe@b.test' },
      });
      // NEW: live, tenant A, NO embedding row — the reconcile anti-join must find exactly this one.
      await talentPrisma.talentRecord.create({
        data: { id: NEW, tenant_id: TENANT_A, site_id: SITE_1, first_name: 'Neve', last_name: 'Fresh', email1: 'neve@a.test' },
      });

      // ADA far from the query; BOB and ZOE exactly on the query vector.
      await semanticRepo.saveReady({ tenant_id: TENANT_A, talent_record_id: ADA, site_id: SITE_1, vector: unit(900), source_hash: 'h', embedding_model: 'm', dimension: 1536 });
      await semanticRepo.saveReady({ tenant_id: TENANT_A, talent_record_id: BOB, site_id: SITE_1, vector: unit(1), source_hash: 'h', embedding_model: 'm', dimension: 1536 });
      await semanticRepo.saveReady({ tenant_id: TENANT_B, talent_record_id: ZOE, site_id: SITE_1, vector: unit(1), source_hash: 'h', embedding_model: 'm', dimension: 1536 });

      svc = new EnterpriseSearchReadService([
        new TalentSearchAdapter(talentRepo, fakeEmbedding, semanticRepo, enabledConfig),
      ]);
    }, 180_000);

    afterAll(async () => {
      await talentPrisma?.$disconnect();
      await embPrisma?.$disconnect();
      await container?.stop();
    });

    async function talentHits(query: string, tenant: string): Promise<{ id: string; signal: string }[]> {
      const results = await svc.search({
        query,
        entity_types: ['TALENT'],
        authority: authority(tenant, SITE_1),
        limit_per_type: 10,
        requestId: 'r-1',
      });
      const group = results.groups.find((g) => g.entity_type === 'TALENT');
      return (group?.hits ?? []).map((h) => ({ id: h.entity_id, signal: h.match.signal }));
    }

    it('surfaces a semantically-nearest Talent with signal=semantic, ordered AFTER a lexical hit', async () => {
      // "Ada" matches ADA by name (lexical). The fake query vector == BOB's vector → BOB is the
      // nearest semantic match (ADA's vector is far). Three-band order: ADA (lexical) before BOB (semantic).
      const hits = await talentHits('Ada', TENANT_A);
      const ada = hits.find((h) => h.id === ADA);
      const bob = hits.find((h) => h.id === BOB);
      expect(ada?.signal).toBe('lexical');
      expect(bob?.signal).toBe('semantic');
      expect(hits.findIndex((h) => h.id === ADA)).toBeLessThan(hits.findIndex((h) => h.id === BOB));
    });

    it('returns a pure-semantic match for a query that matches no name/email/resume', async () => {
      const hits = await talentHits('distributed systems platform', TENANT_A);
      // BOB (nearest) present with signal semantic; every returned hit is semantic (no lexical match).
      const bob = hits.find((h) => h.id === BOB);
      expect(bob?.signal).toBe('semantic');
      expect(hits.every((h) => h.signal === 'semantic')).toBe(true);
    });

    it('co-locates tenant visibility in the vector SQL — another tenant embedding is absent', async () => {
      const hits = await talentHits('distributed systems platform', TENANT_A);
      expect(hits.map((h) => h.id)).not.toContain(ZOE); // tenant B, structurally absent
    });

    it('reconcile anti-join enqueues ONLY the live Talent lacking an embedding row (churn-free)', async () => {
      // NEW is live with no embedding; ADA/BOB already have ready rows and must NOT be re-enqueued.
      const refs = await semanticRepo.listLiveTalentRefsMissingEmbedding(100);
      const ids = refs.map((r) => r.talent_record_id);
      expect(ids).toContain(NEW);
      expect(ids).not.toContain(ADA);
      expect(ids).not.toContain(BOB);

      const reconcile = new TalentEmbeddingReconcileService(semanticRepo, { isEnabled: () => true } as unknown as EmbeddingProcessingConfig);
      const res = await reconcile.runOnce(100);
      expect(res.enabled).toBe(true);
      expect(res.enqueued).toBeGreaterThanOrEqual(1);
      // NEW now has a pending row; ADA remains ready (not churned).
      expect((await semanticRepo.getDescriptor({ tenant_id: TENANT_A, talent_record_id: NEW }))?.status).toBe('pending');
      expect((await semanticRepo.getDescriptor({ tenant_id: TENANT_A, talent_record_id: ADA }))?.status).toBe('ready');
    });
  },
);
