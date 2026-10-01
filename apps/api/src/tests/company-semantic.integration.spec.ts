import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { v7 as uuidv7 } from 'uuid';
import { CompanyRepository, CompanyPrismaService, CompanyEmbeddingRepository } from '@aramo/company';
import type { EmbeddingPort } from '@aramo/ai-draft';

import { EnterpriseSearchReadService } from '../search/enterprise-search-read.service.js';
import { CompanySearchAdapter } from '../search/adapters/company-search.adapter.js';
import { EmbeddingProcessingConfig } from '../embedding/embedding-processing.config.js';
import type { SearchAuthorityContext } from '../search/enterprise-search.port.js';

// Enterprise Search GS-2C — the Company semantic leg END-TO-END through the orchestrator, against a
// REAL pgvector Postgres 17. Proves: the visibility predicate (see_all_company OR id ∈
// visible_client_ids) is co-located INSIDE the vector SQL — a non-visible company is structurally
// absent; another tenant is absent; see_all sees all; the reconcile anti-join finds only
// embedding-less companies. Query-time embedding is a deterministic fake.

const ROOT = resolve(__dirname, '../../../..');
// Dollar-quote + comment aware (company migrations may ship $$ trigger bodies).
function splitDdl(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inDollar = false;
  let inLine = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inLine) { cur += ch; if (ch === '\n') inLine = false; continue; }
    if (!inDollar && ch === '-' && sql[i + 1] === '-') { inLine = true; cur += ch; continue; }
    if (sql.startsWith('$$', i)) { inDollar = !inDollar; cur += '$$'; i += 1; continue; }
    if (ch === ';' && !inDollar) { out.push(cur); cur = ''; } else { cur += ch; }
  }
  if (cur.trim().length > 0) out.push(cur);
  return out;
}
function companyMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/company/prisma/migrations');
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d+_/.test(d.name))
    .map((d) => d.name).sort()
    .map((d) => resolve(dir, d, 'migration.sql'));
}

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '22222222-2222-7222-8222-222222222222';
const CO_VISIBLE = 'aaaaaaaa-1111-7111-8111-aaaaaaaaaaaa';
const CO_HIDDEN = 'bbbbbbbb-2222-7222-8222-bbbbbbbbbbbb';
const CO_TENANT_B = 'cccccccc-3333-7333-8333-cccccccccccc';
const CO_NOEMB = 'dddddddd-4444-7444-8444-dddddddddddd';

function unit(hot: number): number[] {
  const v = new Array<number>(1536).fill(0);
  v[hot] = 1;
  return v;
}
const fakeEmbedding = {
  embed: async () => ({ vector: unit(1), provider: 'openai', model: 'text-embedding-3-small', dimension: 1536 }),
} as unknown as EmbeddingPort;
const enabledConfig = { isEnabled: () => true } as unknown as EmbeddingProcessingConfig;

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Enterprise Search GS-2C — Company semantic leg through the orchestrator (real pgvector Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: CompanyPrismaService;
    let svc: EnterpriseSearchReadService;
    let embeddingRepo: CompanyEmbeddingRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const url = container.getConnectionUri();
      const setup = new CompanyPrismaService(url);
      await setup.$connect();
      for (const m of companyMigrations()) {
        for (const s of splitDdl(readFileSync(m, 'utf8'))) { const t = s.trim(); if (t) await setup.$executeRawUnsafe(t); }
      }
      await setup.$disconnect();

      prisma = new CompanyPrismaService(url);
      await prisma.$connect();
      const repo = new CompanyRepository(prisma);
      embeddingRepo = new CompanyEmbeddingRepository(prisma);

      const seed = async (id: string, tenant: string, name: string, withEmbedding: boolean): Promise<void> => {
        await prisma.company.create({ data: { id, tenant_id: tenant, name, industry: 'Software' } });
        if (withEmbedding) {
          await embeddingRepo.saveReady({ tenant_id: tenant, company_id: id, vector: unit(1), source_hash: 'h', embedding_model: 'm', dimension: 1536 });
        }
      };
      await seed(CO_VISIBLE, TENANT_A, 'Globex', true);
      await seed(CO_HIDDEN, TENANT_A, 'Initech', true);
      await seed(CO_TENANT_B, TENANT_B, 'Umbrella', true);
      await seed(CO_NOEMB, TENANT_A, 'Freshco', false);

      svc = new EnterpriseSearchReadService([
        new CompanySearchAdapter(repo, fakeEmbedding, embeddingRepo, enabledConfig),
      ]);
    }, 180_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    function authority(overrides: Partial<SearchAuthorityContext['visibility']>): SearchAuthorityContext {
      return {
        tenant_id: TENANT_A,
        scopes: ['company:search'],
        visibility: { actor_user_id: 'u-1', see_all_company: false, see_all_requisition: false, visible_client_ids: new Set([CO_VISIBLE]), ...overrides },
      };
    }
    async function hits(query: string, auth: SearchAuthorityContext): Promise<string[]> {
      const r = await svc.search({ query, entity_types: ['COMPANY'], authority: auth, limit_per_type: 20, requestId: 'r' });
      return (r.groups.find((g) => g.entity_type === 'COMPANY')?.hits ?? []).map((h) => h.entity_id);
    }

    it('co-locates visibility in the vector SQL: id ∈ visible_client_ids present; non-visible + cross-tenant absent', async () => {
      const ids = await hits('zzz semantic only', authority({}));
      expect(ids).toContain(CO_VISIBLE);
      expect(ids).not.toContain(CO_HIDDEN);
      expect(ids).not.toContain(CO_TENANT_B);
    });

    it('see_all_company sees every company in the tenant, none cross-tenant', async () => {
      const ids = await hits('zzz semantic only', authority({ see_all_company: true }));
      expect(ids).toEqual(expect.arrayContaining([CO_VISIBLE, CO_HIDDEN]));
      expect(ids).not.toContain(CO_TENANT_B);
    });

    it('marks hits semantic + reconcile anti-join returns only the embedding-less company', async () => {
      const r = await svc.search({ query: 'zzz semantic only', entity_types: ['COMPANY'], authority: authority({ see_all_company: true }), limit_per_type: 20, requestId: 'r2' });
      const chits = r.groups.find((g) => g.entity_type === 'COMPANY')?.hits ?? [];
      expect(chits.length).toBeGreaterThan(0);
      expect(chits.every((h) => h.match.signal === 'semantic')).toBe(true);

      const missing = (await embeddingRepo.listCompaniesMissingEmbedding(100)).map((m) => m.company_id);
      expect(missing).toContain(CO_NOEMB);
      expect(missing).not.toContain(CO_VISIBLE);
    });
  },
);
