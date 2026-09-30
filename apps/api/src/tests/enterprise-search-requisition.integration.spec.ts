import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { v7 as uuidv7 } from 'uuid';
import { RequisitionRepository, RequisitionPrismaService } from '@aramo/requisition';

import { RequisitionSearchAdapter } from '../search/adapters/requisition-search.adapter.js';
import type { SearchAuthorityContext } from '../search/enterprise-search.port.js';

// Enterprise Search GS-1 — the Requisition adapter against a REAL Postgres 17. Requisition
// is a visibility-set domain: retrieval MUST go through the actor-aware visibility predicate
// (buildVisibilityWhere), never raw reads. This proves, against a live DB:
//   - visibility isolation via the FULL A3/D4b OR-union — a requisition is visible when its
//     company is in visible_client_ids OR the actor is directly assigned; a requisition in a
//     hidden company with no assignment is absent;
//   - tenant isolation (same title + same requisition_number in another tenant is absent);
//   - the exact requisition-number leg stays INSIDE the visible set (a hidden req is not
//     retrievable by its exact number — no lookup bypass) and is tagged 'exact';
//   - title/description matches dedupe to ONE hit per requisition;
//   - terminal status is NOT suppressed (mirrors listForActor's read semantics — Search
//     invents no lifecycle rule);
//   - commercial fields never leak into a hit; the route is the canonical requisition route.

const MIGRATIONS_DIR = resolve(__dirname, '../../../../libs/requisition/prisma/migrations');
const MIGRATIONS = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^\d+_/.test(d.name))
  .map((d) => d.name)
  .sort()
  .map((d) => resolve(MIGRATIONS_DIR, d, 'migration.sql'));

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '22222222-2222-7222-8222-222222222222';
const COMPANY_VISIBLE = 'cccccccc-1111-7111-8111-cccccccccccc';
const COMPANY_HIDDEN = 'dddddddd-2222-7222-8222-dddddddddddd';
const ACTOR = 'eeeeeeee-3333-7333-8333-eeeeeeeeeeee';

// Comment-aware AND dollar-quote-aware DDL splitter (requisition/placement migrations carry
// `$$…$$` trigger bodies + `--` comments; a naive splitter mis-splits them). Mirrors the
// canonical splitter in libs/requisition/src/tests/_capacity-b2-harness.ts.
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

// The RESOLVED visibility of a tenant-A actor: sees COMPANY_VISIBLE by client, plus any
// requisition directly assigned to ACTOR. NOT see-all.
function authorityA(): SearchAuthorityContext {
  return {
    tenant_id: TENANT_A,
    scopes: ['requisition:search'],
    visibility: {
      actor_user_id: ACTOR,
      see_all_company: false,
      see_all_requisition: false,
      visible_client_ids: new Set([COMPANY_VISIBLE]),
    },
  };
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Enterprise Search GS-1 — Requisition adapter (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: RequisitionPrismaService;
    let adapter: RequisitionSearchAdapter;

    const reqVisible = uuidv7(); // company visible → visible
    const reqAssigned = uuidv7(); // hidden company BUT assigned to ACTOR → visible
    const reqHidden = uuidv7(); // hidden company, unassigned → NOT visible
    const reqClosed = uuidv7(); // company visible, status 'closed' → visible (not suppressed)
    const reqTenantB = uuidv7(); // tenant B, same title + number → NOT visible

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const setup = new RequisitionPrismaService(url);
      await setup.$connect();
      for (const path of MIGRATIONS) {
        for (const stmt of splitDdl(readFileSync(path, 'utf8'))) {
          const trimmed = stmt.trim();
          if (trimmed.length === 0) continue;
          await setup.$executeRawUnsafe(trimmed);
        }
      }
      await setup.$disconnect();

      prisma = new RequisitionPrismaService(url);
      await prisma.$connect();
      const repo = new RequisitionRepository(
        prisma,
        {} as never, // setPriorityPolicy — unused by the lean search reads
        {} as never, // transitionPolicy — unused
        {} as never, // capacity — unused (lean reads do not enrich)
        {} as never, // clientStatus — unused
      );
      adapter = new RequisitionSearchAdapter(repo);

      await prisma.requisition.create({
        data: { id: reqVisible, tenant_id: TENANT_A, company_id: COMPANY_VISIBLE, title: 'Senior Java Developer', requisition_number: 1042, description: 'Java AWS cloud role', pay_rate_amount: '100', bill_rate_amount: '150' },
      });
      await prisma.requisition.create({
        data: { id: reqAssigned, tenant_id: TENANT_A, company_id: COMPANY_HIDDEN, title: 'Java Platform Engineer', requisition_number: 1043, description: 'platform work' },
      });
      await prisma.requisitionAssignment.create({
        data: { tenant_id: TENANT_A, requisition_id: reqAssigned, user_id: ACTOR },
      });
      await prisma.requisition.create({
        data: { id: reqHidden, tenant_id: TENANT_A, company_id: COMPANY_HIDDEN, title: 'Java Backend Developer', requisition_number: 1044, description: 'backend work' },
      });
      await prisma.requisition.create({
        data: { id: reqClosed, tenant_id: TENANT_A, company_id: COMPANY_VISIBLE, title: 'Java Closed Role', requisition_number: 1099, status: 'closed' },
      });
      await prisma.requisition.create({
        data: { id: reqTenantB, tenant_id: TENANT_B, company_id: COMPANY_VISIBLE, title: 'Senior Java Developer', requisition_number: 1042, description: 'other tenant' },
      });
    }, 180_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    it('lexical leg honours the full OR-union visibility, tenant isolation, and does not suppress terminal status', async () => {
      const hits = await adapter.search('Java', authorityA(), 20);
      const ids = hits.map((h) => h.entity_id).sort();
      // visible-by-company (reqVisible, reqClosed) + assigned (reqAssigned); NOT hidden, NOT tenant B.
      expect(ids).toEqual([reqVisible, reqAssigned, reqClosed].sort());
      // terminal 'closed' requisition is present — Search adds no lifecycle rule.
      expect(hits.some((h) => h.entity_id === reqClosed)).toBe(true);
    });

    it('dedupes a title + description match into one hit', async () => {
      const hits = await adapter.search('Java', authorityA(), 20);
      // reqVisible matches "Java" in BOTH title and description → exactly one hit.
      expect(hits.filter((h) => h.entity_id === reqVisible)).toHaveLength(1);
    });

    it('exact requisition-number leg is tenant-isolated and tagged exact', async () => {
      const hits = await adapter.search('REQ-1042', authorityA(), 20);
      expect(hits.map((h) => h.entity_id)).toEqual([reqVisible]); // NOT reqTenantB (tenant B)
      expect(hits[0]?.match.signal).toBe('exact');
    });

    it('exact requisition-number stays inside the visible set (no lookup bypass)', async () => {
      // reqHidden is number 1044 but its company is hidden and it is unassigned → invisible.
      const hits = await adapter.search('1044', authorityA(), 20);
      expect(hits).toEqual([]);
    });

    it('emits a lean hit: no commercial fields, canonical route', async () => {
      const hits = await adapter.search('REQ-1042', authorityA(), 20);
      const hit = hits[0]!;
      expect(hit).not.toHaveProperty('pay_rate_amount');
      expect(hit).not.toHaveProperty('bill_rate_amount');
      expect(hit).not.toHaveProperty('salary_amount');
      expect(hit.route).toBe(`/requisitions/${reqVisible}`);
      expect(hit.entity_type).toBe('REQUISITION');
      expect(hit.display_label).toBe('Senior Java Developer');
    });
  },
);
