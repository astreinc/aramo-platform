import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { v7 as uuidv7 } from 'uuid';
import { RequisitionRepository, RequisitionPrismaService, RequisitionEmbeddingRepository } from '@aramo/requisition';
import type { EmbeddingPort } from '@aramo/ai-draft';

import { EnterpriseSearchReadService } from '../search/enterprise-search-read.service.js';
import { RequisitionSearchAdapter } from '../search/adapters/requisition-search.adapter.js';
import { EmbeddingProcessingConfig } from '../embedding/embedding-processing.config.js';
import type { SearchAuthorityContext } from '../search/enterprise-search.port.js';

// Enterprise Search GS-2B — the Requisition semantic leg END-TO-END through the search orchestrator,
// against a REAL pgvector Postgres 17. Proves the two GS-2B invariants that only a live DB can:
//   - the OR-union visibility predicate is co-located INSIDE the vector SQL: a requisition is a
//     semantic hit iff its company ∈ visible_client_ids OR the actor is directly assigned; a hidden-
//     company/unassigned requisition is structurally absent; another tenant is absent; see_all sees all;
//   - TERMINAL requisitions (status='closed') remain eligible.
// Query-time embedding is a deterministic fake.

const ROOT = resolve(__dirname, '../../../..');
// Dollar-quote + comment aware (a requisition migration ships a $$ trigger body).
function splitDdl(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  let inDollar = false;
  let inLineComment = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inLineComment) {
      current += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (!inDollar && ch === '-' && sql[i + 1] === '-') {
      inLineComment = true;
      current += ch;
      continue;
    }
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
function requisitionMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/requisition/prisma/migrations');
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d+_/.test(d.name))
    .map((d) => d.name)
    .sort()
    .map((d) => resolve(dir, d, 'migration.sql'));
}

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '22222222-2222-7222-8222-222222222222';
const COMPANY_VISIBLE = 'aaaaaaaa-1111-7111-8111-aaaaaaaaaaaa';
const COMPANY_HIDDEN = 'bbbbbbbb-2222-7222-8222-bbbbbbbbbbbb';
const ACTOR = 'cccccccc-3333-7333-8333-cccccccccccc';

const REQ_VISIBLE = uuidv7(); // visible company
const REQ_ASSIGNED = uuidv7(); // hidden company but actor assigned
const REQ_HIDDEN = uuidv7(); // hidden company, no assignment → absent
const REQ_CLOSED = uuidv7(); // visible company, TERMINAL (closed) → eligible
const REQ_TENANT_B = uuidv7(); // other tenant → absent
const REQ_NOEMB = uuidv7(); // tenant A, live, NO embedding row → the reconcile anti-join target

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
  'Enterprise Search GS-2B — Requisition semantic leg through the orchestrator (real pgvector Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: RequisitionPrismaService;
    let svc: EnterpriseSearchReadService;
    let embeddingRepo: RequisitionEmbeddingRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const url = container.getConnectionUri();
      const setup = new RequisitionPrismaService(url);
      await setup.$connect();
      for (const path of requisitionMigrations()) {
        for (const stmt of splitDdl(readFileSync(path, 'utf8'))) await setup.$executeRawUnsafe(stmt);
      }
      await setup.$disconnect();

      prisma = new RequisitionPrismaService(url);
      await prisma.$connect();
      const repo = new RequisitionRepository(prisma, {} as never, {} as never, {} as never, {} as never);
      embeddingRepo = new RequisitionEmbeddingRepository(prisma);

      let n = 1000;
      const seed = async (id: string, tenant: string, company: string, status: 'open' | 'closed'): Promise<void> => {
        await prisma.requisition.create({
          data: { id, tenant_id: tenant, title: `Role ${n}`, requisition_number: n++, company_id: company, status },
        });
        await embeddingRepo.saveReady({
          tenant_id: tenant,
          requisition_id: id,
          vector: unit(1),
          source_hash: 'h',
          embedding_model: 'm',
          dimension: 1536,
        });
      };
      await seed(REQ_VISIBLE, TENANT_A, COMPANY_VISIBLE, 'open');
      await seed(REQ_ASSIGNED, TENANT_A, COMPANY_HIDDEN, 'open');
      await seed(REQ_HIDDEN, TENANT_A, COMPANY_HIDDEN, 'open');
      await seed(REQ_CLOSED, TENANT_A, COMPANY_VISIBLE, 'closed');
      await seed(REQ_TENANT_B, TENANT_B, COMPANY_VISIBLE, 'open');
      // Direct assignment for the actor on the hidden-company req.
      await prisma.requisitionAssignment.create({
        data: { id: uuidv7(), tenant_id: TENANT_A, requisition_id: REQ_ASSIGNED, user_id: ACTOR },
      });
      // A live requisition with NO embedding row — the reconcile anti-join target (no saveReady).
      await prisma.requisition.create({
        data: { id: REQ_NOEMB, tenant_id: TENANT_A, title: 'Needs embedding', requisition_number: 2000, company_id: COMPANY_VISIBLE, status: 'open' },
      });

      svc = new EnterpriseSearchReadService([
        new RequisitionSearchAdapter(repo, fakeEmbedding, embeddingRepo, enabledConfig),
      ]);
    }, 180_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    async function reqHits(query: string, authority: SearchAuthorityContext): Promise<string[]> {
      const results = await svc.search({
        query,
        entity_types: ['REQUISITION'],
        authority,
        limit_per_type: 20,
        requestId: 'r-1',
      });
      const group = results.groups.find((g) => g.entity_type === 'REQUISITION');
      return (group?.hits ?? []).map((h) => h.entity_id);
    }

    function authority(overrides: Partial<SearchAuthorityContext['visibility']>): SearchAuthorityContext {
      return {
        tenant_id: TENANT_A,
        scopes: ['requisition:search'],
        visibility: {
          actor_user_id: ACTOR,
          see_all_company: false,
          see_all_requisition: false,
          visible_client_ids: new Set([COMPANY_VISIBLE]),
          ...overrides,
        },
      };
    }

    it('OR-union in the vector SQL: company-visible + directly-assigned present; hidden absent; terminal eligible', async () => {
      const ids = await reqHits('zzz nomatch semantic only', authority({}));
      expect(ids).toContain(REQ_VISIBLE); // company ∈ visible_client_ids
      expect(ids).toContain(REQ_ASSIGNED); // actor directly assigned (hidden company)
      expect(ids).toContain(REQ_CLOSED); // visible company + TERMINAL → eligible
      expect(ids).not.toContain(REQ_HIDDEN); // hidden company, no assignment → absent
      expect(ids).not.toContain(REQ_TENANT_B); // other tenant → absent
    });

    it('see_all_requisition sees every requisition in the tenant (incl. hidden company), none cross-tenant', async () => {
      const ids = await reqHits('zzz nomatch semantic only', authority({ see_all_requisition: true }));
      expect(ids).toEqual(expect.arrayContaining([REQ_VISIBLE, REQ_ASSIGNED, REQ_HIDDEN, REQ_CLOSED]));
      expect(ids).not.toContain(REQ_TENANT_B);
    });

    it('reconcile anti-join returns ONLY requisitions lacking an embedding row (churn-free)', async () => {
      const refs = await embeddingRepo.listReqsMissingEmbedding(100);
      const ids = refs.map((r) => r.requisition_id);
      expect(ids).toContain(REQ_NOEMB);
      expect(ids).not.toContain(REQ_VISIBLE); // already has a ready embedding
      expect(ids).not.toContain(REQ_CLOSED);
      // Enqueue it; it becomes pending, the embedded ones are untouched.
      await embeddingRepo.enqueue({ tenant_id: TENANT_A, requisition_id: REQ_NOEMB });
      expect((await embeddingRepo.getDescriptor({ tenant_id: TENANT_A, requisition_id: REQ_NOEMB }))?.status).toBe('pending');
      expect((await embeddingRepo.getDescriptor({ tenant_id: TENANT_A, requisition_id: REQ_VISIBLE }))?.status).toBe('ready');
    });

    it('marks the semantic hits with signal=semantic', async () => {
      const results = await svc.search({
        query: 'zzz nomatch semantic only',
        entity_types: ['REQUISITION'],
        authority: authority({}),
        limit_per_type: 20,
        requestId: 'r-2',
      });
      const hits = results.groups.find((g) => g.entity_type === 'REQUISITION')?.hits ?? [];
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((h) => h.match.signal === 'semantic')).toBe(true);
    });
  },
);
