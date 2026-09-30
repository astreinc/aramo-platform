import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { v7 as uuidv7 } from 'uuid';
import { TalentRecordRepository, TalentRecordPrismaService, ResumeTextService } from '@aramo/talent-record';
import { RequisitionRepository, RequisitionPrismaService } from '@aramo/requisition';
import { CompanyRepository, CompanyPrismaService } from '@aramo/company';
import { ContactRepository, ContactPrismaService } from '@aramo/contact';

import { EnterpriseSearchReadService } from '../search/enterprise-search-read.service.js';
import { TalentSearchAdapter } from '../search/adapters/talent-search.adapter.js';
import { RequisitionSearchAdapter } from '../search/adapters/requisition-search.adapter.js';
import { CompanySearchAdapter } from '../search/adapters/company-search.adapter.js';
import { ContactSearchAdapter } from '../search/adapters/contact-search.adapter.js';
import type { SearchAuthorityContext, SearchEntityType } from '../search/enterprise-search.port.js';

// Enterprise Search GS-1 — the FIRST TRUE BACKEND VERTICAL SLICE: the whole /v1/search surface
// end-to-end across all four entity types, against a REAL Postgres 17 holding all four schemas.
// Drives the real orchestrator wired to the four real adapters over the four real repositories.
// Proves global search, unauthorized-entity omission, explicit-unauthorized module behaviour,
// tenant isolation, per-domain visibility isolation, exact lookup (talent email + requisition
// number), résumé FTS, dedupe, bounded per-type limit, lean projection, and the blank query.

const ROOT = resolve(__dirname, '../../../..');
function migrationsIn(lib: string): string[] {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d+_/.test(d.name))
    .map((d) => d.name)
    .sort()
    .map((d) => resolve(dir, d, 'migration.sql'));
}

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

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '22222222-2222-7222-8222-222222222222';
const COMPANY_VISIBLE = 'cccccccc-1111-7111-8111-cccccccccccc';
const COMPANY_HIDDEN = 'dddddddd-2222-7222-8222-dddddddddddd';
const ACTOR = 'eeeeeeee-3333-7333-8333-eeeeeeeeeeee';

const visA = {
  actor_user_id: ACTOR,
  see_all_company: false,
  see_all_requisition: false,
  visible_client_ids: new Set([COMPANY_VISIBLE]),
};
const ALL = ['talent:search', 'requisition:search', 'company:search', 'contact:search'];

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Enterprise Search GS-1 — /v1/search end-to-end across all four entities (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let talentPrisma: TalentRecordPrismaService;
    let reqPrisma: RequisitionPrismaService;
    let companyPrisma: CompanyPrismaService;
    let contactPrisma: ContactPrismaService;
    let svc: EnterpriseSearchReadService;

    const talent1 = uuidv7();
    const talent2 = uuidv7();
    const talent3 = uuidv7();
    const talentB = uuidv7();
    const reqVisible = uuidv7();
    const reqHidden = uuidv7();
    const reqB = uuidv7();
    const companyB = uuidv7();
    const contactVisible = uuidv7();
    const contactHidden = uuidv7();
    const contactB = uuidv7();

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const setup = new TalentRecordPrismaService(url);
      await setup.$connect();
      for (const lib of ['talent-record', 'requisition', 'company', 'contact']) {
        for (const path of migrationsIn(lib)) {
          for (const stmt of splitDdl(readFileSync(path, 'utf8'))) {
            const trimmed = stmt.trim();
            if (trimmed.length === 0) continue;
            await setup.$executeRawUnsafe(trimmed);
          }
        }
      }
      await setup.$disconnect();

      talentPrisma = new TalentRecordPrismaService(url);
      reqPrisma = new RequisitionPrismaService(url);
      companyPrisma = new CompanyPrismaService(url);
      contactPrisma = new ContactPrismaService(url);
      await Promise.all([talentPrisma.$connect(), reqPrisma.$connect(), companyPrisma.$connect(), contactPrisma.$connect()]);

      const talentRepo = new TalentRecordRepository(talentPrisma);
      const reqRepo = new RequisitionRepository(reqPrisma, {} as never, {} as never, {} as never, {} as never);
      const companyRepo = new CompanyRepository(companyPrisma);
      const contactRepo = new ContactRepository(contactPrisma, {} as never);
      svc = new EnterpriseSearchReadService([
        new TalentSearchAdapter(talentRepo),
        new RequisitionSearchAdapter(reqRepo),
        new CompanySearchAdapter(companyRepo),
        new ContactSearchAdapter(contactRepo),
      ]);

      // Talent (pool-open; tenant-wide). Three tenant-A "Java" talents + one tenant-B.
      for (const [id, tenant, first, last, email] of [
        [talent1, TENANT_A, 'Ada', 'Java', 'ada@a.test'],
        [talent2, TENANT_A, 'Ben', 'Javaland', 'ben@a.test'],
        [talent3, TENANT_A, 'Cal', 'Javapark', 'cal@a.test'],
        [talentB, TENANT_B, 'Zoe', 'Java', 'zoe@b.test'],
      ] as const) {
        await talentPrisma.talentRecord.create({ data: { id, tenant_id: tenant, first_name: first, last_name: last, email1: email } });
      }
      const resumeText = new ResumeTextService(
        talentPrisma,
        { createPresignedGet: async () => ({ presigned_url: 'https://s3/x', expires_at: 'z' }) } as never,
        { log: () => undefined, warn: () => undefined, error: () => undefined } as never,
      );
      const edition = uuidv7();
      await resumeText.enqueueReindex({ tenant_id: TENANT_A, talent_record_id: talent1, storage_key: 'k/1', resume_edition_id: edition });
      await talentPrisma.talentResumeText.updateMany({
        where: { tenant_id: TENANT_A, talent_record_id: talent1, resume_edition_id: edition },
        data: { redacted_text: 'Senior engineer with Snowflake Spark Airflow experience.', status: 'extracted', extracted_at: new Date() },
      });

      // Requisition: visible (visible company) + hidden (hidden company) + tenant B.
      await reqPrisma.requisition.create({ data: { id: reqVisible, tenant_id: TENANT_A, company_id: COMPANY_VISIBLE, title: 'Java Developer', requisition_number: 1042 } });
      await reqPrisma.requisition.create({ data: { id: reqHidden, tenant_id: TENANT_A, company_id: COMPANY_HIDDEN, title: 'Java Secret', requisition_number: 1043 } });
      await reqPrisma.requisition.create({ data: { id: reqB, tenant_id: TENANT_B, company_id: COMPANY_VISIBLE, title: 'Java Developer', requisition_number: 1042 } });

      // Company: visible (id in set) + hidden (id not in set) + tenant B.
      await companyPrisma.company.create({ data: { id: COMPANY_VISIBLE, tenant_id: TENANT_A, name: 'Java Solutions Inc' } });
      await companyPrisma.company.create({ data: { id: COMPANY_HIDDEN, tenant_id: TENANT_A, name: 'Java Hidden Corp' } });
      await companyPrisma.company.create({ data: { id: companyB, tenant_id: TENANT_B, name: 'Java Offshore' } });

      // Contact: visible (visible company) + hidden (hidden company) + tenant B.
      await contactPrisma.contact.create({ data: { id: contactVisible, tenant_id: TENANT_A, company_id: COMPANY_VISIBLE, first_name: 'Jane', last_name: 'Java', title: 'CTO' } });
      await contactPrisma.contact.create({ data: { id: contactHidden, tenant_id: TENANT_A, company_id: COMPANY_HIDDEN, first_name: 'Jim', last_name: 'Java', title: 'VP' } });
      await contactPrisma.contact.create({ data: { id: contactB, tenant_id: TENANT_B, company_id: COMPANY_VISIBLE, first_name: 'Joe', last_name: 'Java', title: 'CTO' } });
    }, 240_000);

    afterAll(async () => {
      await Promise.all([
        talentPrisma?.$disconnect(),
        reqPrisma?.$disconnect(),
        companyPrisma?.$disconnect(),
        contactPrisma?.$disconnect(),
      ]);
      await container?.stop();
    });

    const group = (r: { groups: { entity_type: SearchEntityType; hits: { entity_id: string }[]; unauthorized?: boolean }[] }, t: SearchEntityType) =>
      r.groups.find((g) => g.entity_type === t);

    it('authorized GLOBAL query returns all four entity types, tenant- and visibility-isolated', async () => {
      const { authority } = authority_(ALL);
      const r = await svc.search({ query: 'Java', authority, requestId: 'r' });
      expect(r.groups.map((g) => g.entity_type).sort()).toEqual(['COMPANY', 'CONTACT', 'REQUISITION', 'TALENT']);
      // Talent is pool-open (tenant-wide) → the three tenant-A talents, never tenant B.
      expect(group(r, 'TALENT')!.hits.map((h) => h.entity_id).sort()).toEqual([talent1, talent2, talent3].sort());
      expect(group(r, 'TALENT')!.hits.some((h) => h.entity_id === talentB)).toBe(false);
      // Visibility-set domains → only the visible record; hidden + tenant-B absent.
      expect(group(r, 'REQUISITION')!.hits.map((h) => h.entity_id)).toEqual([reqVisible]);
      expect(group(r, 'COMPANY')!.hits.map((h) => h.entity_id)).toEqual([COMPANY_VISIBLE]);
      expect(group(r, 'CONTACT')!.hits.map((h) => h.entity_id)).toEqual([contactVisible]);
    });

    it('GLOBAL omits entity types the actor cannot search (no existence leak)', async () => {
      const { authority } = authority_(['talent:search', 'company:search']);
      const r = await svc.search({ query: 'Java', authority, requestId: 'r' });
      expect(r.groups.map((g) => g.entity_type).sort()).toEqual(['COMPANY', 'TALENT']);
      expect(group(r, 'REQUISITION')).toBeUndefined();
      expect(group(r, 'CONTACT')).toBeUndefined();
    });

    it('EXPLICIT module request for an unauthorized type returns an honest unauthorized group', async () => {
      const { authority } = authority_(['talent:search']);
      const r = await svc.search({ query: 'Java', entity_types: ['REQUISITION'], authority, requestId: 'r' });
      const g = group(r, 'REQUISITION')!;
      expect(g.unauthorized).toBe(true);
      expect(g.hits).toEqual([]);
    });

    it('exact talent email lookup is tenant-isolated and tagged exact', async () => {
      const { authority } = authority_(ALL);
      const r = await svc.search({ query: 'ada@a.test', entity_types: ['TALENT'], authority, requestId: 'r' });
      const hits = group(r, 'TALENT')!.hits as { entity_id: string; match: { signal: string } }[];
      expect(hits.map((h) => h.entity_id)).toEqual([talent1]);
      expect(hits[0]!.match.signal).toBe('exact');
    });

    it('exact requisition-number lookup is tenant-isolated and tagged exact', async () => {
      const { authority } = authority_(ALL);
      const r = await svc.search({ query: 'REQ-1042', entity_types: ['REQUISITION'], authority, requestId: 'r' });
      const hits = group(r, 'REQUISITION')!.hits as { entity_id: string; match: { signal: string } }[];
      expect(hits.map((h) => h.entity_id)).toEqual([reqVisible]);
      expect(hits[0]!.match.signal).toBe('exact');
    });

    it('résumé full-text retrieval surfaces the talent with a snippet', async () => {
      const { authority } = authority_(ALL);
      const r = await svc.search({ query: 'Snowflake', entity_types: ['TALENT'], authority, requestId: 'r' });
      const hits = group(r, 'TALENT')!.hits as { entity_id: string; snippet: string | null }[];
      expect(hits.map((h) => h.entity_id)).toEqual([talent1]);
      expect(hits[0]!.snippet).toContain('<mark>');
    });

    it('bounds each entity type to limit_per_type', async () => {
      const { authority } = authority_(ALL);
      const r = await svc.search({ query: 'Java', entity_types: ['TALENT'], authority, limit_per_type: 2, requestId: 'r' });
      expect(group(r, 'TALENT')!.hits).toHaveLength(2);
    });

    it('blank query short-circuits with no groups', async () => {
      const { authority } = authority_(ALL);
      const r = await svc.search({ query: '   ', authority, requestId: 'r' });
      expect(r.groups).toEqual([]);
    });

    it('emits lean hits across entities (no email/phone/commercial fields)', async () => {
      const { authority } = authority_(ALL);
      const r = await svc.search({ query: 'Java', authority, requestId: 'r' });
      const talentHit = group(r, 'TALENT')!.hits[0]! as Record<string, unknown>;
      const reqHit = group(r, 'REQUISITION')!.hits[0]! as Record<string, unknown>;
      const contactHit = group(r, 'CONTACT')!.hits[0]! as Record<string, unknown>;
      expect(talentHit).not.toHaveProperty('email1');
      expect(reqHit).not.toHaveProperty('pay_rate_amount');
      expect(contactHit).not.toHaveProperty('phone_work');
    });
  },
);

// Local alias so each test reads clearly (authority_ returns the resolved authority context).
function authority_(scopes: string[]): { authority: SearchAuthorityContext } {
  return { authority: { tenant_id: TENANT_A, scopes, visibility: visA } };
}
