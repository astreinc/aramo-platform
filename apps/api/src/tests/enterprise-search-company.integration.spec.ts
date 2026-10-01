import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { v7 as uuidv7 } from 'uuid';
import { CompanyRepository, CompanyPrismaService, CompanyEmbeddingRepository } from '@aramo/company';
import type { EmbeddingPort } from '@aramo/ai-draft';

import { CompanySearchAdapter } from '../search/adapters/company-search.adapter.js';
import { EmbeddingProcessingConfig } from '../embedding/embedding-processing.config.js';
import type { SearchAuthorityContext } from '../search/enterprise-search.port.js';

// GS-1 legs only: the semantic leg is dark (EMBEDDING_PROCESSING_ENABLED unset), so this disabled
// embedding port is never invoked and GS-1 retrieval stays byte-identical.
const DISABLED_EMBEDDING = {
  embed: async () => {
    throw new Error('semantic leg must be dark in this GS-1 spec');
  },
} as unknown as EmbeddingPort;

// Enterprise Search GS-1 — the Company adapter against a REAL Postgres 17. Company is a
// visibility-set domain (id ∈ visible_client_ids unless see_all_company). Proves:
//   - visible_client_ids isolation: a company outside the resolved set is absent;
//   - tenant isolation: the same-named company in another tenant is absent;
//   - exact name is a retrieval SIGNAL (tagged exact), derived from already-visibility-
//     filtered rows — never a separate authority path;
//   - name/description lexical matches dedupe to one hit per company;
//   - lean hit: no commercial fields; canonical /companies/:id route.

const MIGRATIONS_DIR = resolve(__dirname, '../../../../libs/company/prisma/migrations');
const MIGRATIONS = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^\d+_/.test(d.name))
  .map((d) => d.name)
  .sort()
  .map((d) => resolve(MIGRATIONS_DIR, d, 'migration.sql'));

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '22222222-2222-7222-8222-222222222222';

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

function authorityA(visibleCompanyIds: string[]): SearchAuthorityContext {
  return {
    tenant_id: TENANT_A,
    scopes: ['company:search'],
    visibility: {
      actor_user_id: 'u-1',
      see_all_company: false,
      see_all_requisition: false,
      visible_client_ids: new Set(visibleCompanyIds),
    },
  };
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Enterprise Search GS-1 — Company adapter (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: CompanyPrismaService;
    let adapter: CompanySearchAdapter;

    const companyVisible = uuidv7();
    const companyHidden = uuidv7();
    const companyTenantB = uuidv7();

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const url = container.getConnectionUri();
      const setup = new CompanyPrismaService(url);
      await setup.$connect();
      for (const path of MIGRATIONS) {
        for (const stmt of splitDdl(readFileSync(path, 'utf8'))) {
          const trimmed = stmt.trim();
          if (trimmed.length === 0) continue;
          await setup.$executeRawUnsafe(trimmed);
        }
      }
      await setup.$disconnect();

      prisma = new CompanyPrismaService(url);
      await prisma.$connect();
      adapter = new CompanySearchAdapter(new CompanyRepository(prisma), DISABLED_EMBEDDING, new CompanyEmbeddingRepository(prisma), new EmbeddingProcessingConfig());

      await prisma.company.create({
        data: { id: companyVisible, tenant_id: TENANT_A, name: 'Freddie Mac', description: 'Freddie mortgage secondary market', industry: 'Finance', fee_model: 'contingent' },
      });
      await prisma.company.create({
        data: { id: companyHidden, tenant_id: TENANT_A, name: 'Freddie Mac Holdings', description: 'holdings', industry: 'Finance' },
      });
      await prisma.company.create({
        data: { id: companyTenantB, tenant_id: TENANT_B, name: 'Freddie Mac', description: 'other tenant', industry: 'Finance' },
      });
    }, 180_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    it('honours visible_client_ids and tenant isolation', async () => {
      const hits = await adapter.search('Freddie', authorityA([companyVisible]), 20);
      expect(hits.map((h) => h.entity_id)).toEqual([companyVisible]); // NOT hidden, NOT tenant B
    });

    it('tags an exact name match as exact (a signal, not a separate authority path)', async () => {
      const hits = await adapter.search('Freddie Mac', authorityA([companyVisible]), 20);
      expect(hits.map((h) => h.entity_id)).toEqual([companyVisible]);
      expect(hits[0]?.match.signal).toBe('exact');
      expect(hits[0]?.display_label).toBe('Freddie Mac');
    });

    it('dedupes a name + description match into one hit', async () => {
      const hits = await adapter.search('Freddie', authorityA([companyVisible]), 20);
      expect(hits.filter((h) => h.entity_id === companyVisible)).toHaveLength(1);
    });

    it('emits a lean hit: no commercial fields, canonical route', async () => {
      const hits = await adapter.search('Freddie Mac', authorityA([companyVisible]), 20);
      const hit = hits[0]!;
      expect(hit).not.toHaveProperty('fee_model');
      expect(hit).not.toHaveProperty('default_contract_markup_pct');
      expect(hit).not.toHaveProperty('payment_terms');
      expect(hit.route).toBe(`/companies/${companyVisible}`);
      expect(hit.entity_type).toBe('COMPANY');
    });
  },
);
