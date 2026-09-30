import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { v7 as uuidv7 } from 'uuid';
import { ContactRepository, ContactPrismaService } from '@aramo/contact';

import { ContactSearchAdapter } from '../search/adapters/contact-search.adapter.js';
import type { SearchAuthorityContext } from '../search/enterprise-search.port.js';

// Enterprise Search GS-1 — the Contact adapter against a REAL Postgres 17. Contact is a
// visibility-set domain (company_id ∈ visible_client_ids unless see_all_company). Contact
// domain reads support only substring name/title lexical search — no exact-identity search —
// so all Contact hits are lexical (no invented exact/email authority path). Proves:
//   - company/visibility isolation and tenant isolation;
//   - name and title lexical retrieval;
//   - dedupe to one hit per contact;
//   - PII conservatism: the hit exposes NO email/phone even when internally matched;
//   - navigation to the contact's company (no contact detail route exists).

const MIGRATIONS_DIR = resolve(__dirname, '../../../../libs/contact/prisma/migrations');
const MIGRATIONS = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^\d+_/.test(d.name))
  .map((d) => d.name)
  .sort()
  .map((d) => resolve(MIGRATIONS_DIR, d, 'migration.sql'));

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '22222222-2222-7222-8222-222222222222';
const COMPANY_VISIBLE = 'cccccccc-1111-7111-8111-cccccccccccc';
const COMPANY_HIDDEN = 'dddddddd-2222-7222-8222-dddddddddddd';

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

function authorityA(): SearchAuthorityContext {
  return {
    tenant_id: TENANT_A,
    scopes: ['contact:search'],
    visibility: {
      actor_user_id: 'u-1',
      see_all_company: false,
      see_all_requisition: false,
      visible_client_ids: new Set([COMPANY_VISIBLE]),
    },
  };
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Enterprise Search GS-1 — Contact adapter (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: ContactPrismaService;
    let adapter: ContactSearchAdapter;

    const contactVisible = uuidv7();
    const contactHidden = uuidv7();
    const contactTenantB = uuidv7();

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const url = container.getConnectionUri();
      const setup = new ContactPrismaService(url);
      await setup.$connect();
      for (const path of MIGRATIONS) {
        for (const stmt of splitDdl(readFileSync(path, 'utf8'))) {
          const trimmed = stmt.trim();
          if (trimmed.length === 0) continue;
          await setup.$executeRawUnsafe(trimmed);
        }
      }
      await setup.$disconnect();

      prisma = new ContactPrismaService(url);
      await prisma.$connect();
      // companyRepository is unused by the lean search read.
      adapter = new ContactSearchAdapter(new ContactRepository(prisma, {} as never));

      await prisma.contact.create({
        data: { id: contactVisible, tenant_id: TENANT_A, company_id: COMPANY_VISIBLE, first_name: 'Jane', last_name: 'Smith', title: 'CTO', email1: 'jane@acme.test', phone_work: '7035551212' },
      });
      await prisma.contact.create({
        data: { id: contactHidden, tenant_id: TENANT_A, company_id: COMPANY_HIDDEN, first_name: 'Jane', last_name: 'Smithson', title: 'VP' },
      });
      await prisma.contact.create({
        data: { id: contactTenantB, tenant_id: TENANT_B, company_id: COMPANY_VISIBLE, first_name: 'Jane', last_name: 'Smith', title: 'CTO' },
      });
    }, 180_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    it('honours company visibility and tenant isolation (name lexical)', async () => {
      const hits = await adapter.search('Smith', authorityA(), 20);
      expect(hits.map((h) => h.entity_id)).toEqual([contactVisible]); // NOT hidden company, NOT tenant B
      expect(hits[0]?.match.signal).toBe('lexical');
    });

    it('matches by title lexical', async () => {
      const hits = await adapter.search('CTO', authorityA(), 20);
      expect(hits.map((h) => h.entity_id)).toEqual([contactVisible]);
    });

    it('dedupes to one hit per contact', async () => {
      const hits = await adapter.search('Smith', authorityA(), 20);
      expect(hits.filter((h) => h.entity_id === contactVisible)).toHaveLength(1);
    });

    it('emits a PII-conservative lean hit: no email/phone; routes to the contact company', async () => {
      const hits = await adapter.search('Smith', authorityA(), 20);
      const hit = hits[0]!;
      expect(hit).not.toHaveProperty('email1');
      expect(hit).not.toHaveProperty('phone_work');
      expect(hit).not.toHaveProperty('phone_cell');
      expect(hit.entity_type).toBe('CONTACT');
      expect(hit.display_label).toBe('Jane Smith');
      expect(hit.route).toBe(`/companies/${COMPANY_VISIBLE}`);
    });
  },
);
