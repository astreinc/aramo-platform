import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { v7 as uuidv7 } from 'uuid';
import {
  TalentRecordRepository,
  TalentRecordPrismaService,
  ResumeTextService,
} from '@aramo/talent-record';

import { TalentSearchAdapter } from '../search/adapters/talent-search.adapter.js';
import type { SearchAuthorityContext } from '../search/enterprise-search.port.js';

// Enterprise Search GS-1 — the Talent adapter against a REAL Postgres 17, exercising the
// three retrieval legs (exact-email, name lexical, résumé FTS) through the real
// TalentRecordRepository. Proves the directive + PO watch-points that only a live DB can:
//   - tenant isolation on EVERY leg (a match in another tenant is structurally absent);
//   - exact-email stays INSIDE the pool-open tenant+site+live contract — never a bypass
//     (watch-point 1): a same-email record in another tenant / another site is not returned;
//   - deterministic dedupe — one TalentRecord yields ONE SearchHit even when it matches
//     both name and résumé (watch-point 2), exact signal preferred, résumé snippet kept;
//   - lean projection — a hit carries no email/phone/compensation PII (directive §5/§8/§17).

const MIGRATIONS_DIR = resolve(__dirname, '../../../../libs/talent-record/prisma/migrations');
const MIGRATIONS = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^\d+_/.test(d.name))
  .map((d) => d.name)
  .sort()
  .map((d) => resolve(MIGRATIONS_DIR, d, 'migration.sql'));

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '22222222-2222-7222-8222-222222222222';
const SITE_1 = 'aaaaaaaa-1111-7111-8111-aaaaaaaaaaaa';
const SITE_2 = 'bbbbbbbb-2222-7222-8222-bbbbbbbbbbbb';

// splitDdl (résumé-text edition-history precedent) — strip `--` comments to EOL, then split
// on statement-terminating `;\n`. Comment-safe per the splitter-guard rule.
function splitDdl(sql: string): string[] {
  return sql
    .replace(/--[^\n]*$/gm, '')
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function authority(tenant_id: string, site_id?: string): SearchAuthorityContext {
  return {
    tenant_id,
    site_id,
    scopes: ['talent:search'],
    visibility: {
      actor_user_id: 'u-1',
      see_all_company: true,
      see_all_requisition: true,
      visible_client_ids: null,
    },
  };
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Enterprise Search GS-1 — Talent adapter (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: TalentRecordPrismaService;
    let repo: TalentRecordRepository;
    let adapter: TalentSearchAdapter;

    // talentA1: tenant A, site_1, "Alice Kovacs", alice@acme.test, résumé mentions Snowflake.
    // talentA2: tenant A, site_2, "Bob Nguyen",   bob@acme.test,   résumé mentions Nguyen.
    // talentB1: tenant B, (no site), "Alice Kovacs", alice@acme.test — same name+email as A1.
    const talentA1 = uuidv7();
    const talentA2 = uuidv7();
    const talentB1 = uuidv7();

    const fakeObjectStorage = {
      createPresignedGet: async () => ({ presigned_url: 'https://s3/x', expires_at: 'z' }),
    };
    const fakeLogger = { log: () => undefined, warn: () => undefined, error: () => undefined };
    let resumeText: ResumeTextService;

    async function setResume(tenant: string, talent: string, text: string): Promise<void> {
      const edition = uuidv7();
      await resumeText.enqueueReindex({
        tenant_id: tenant,
        talent_record_id: talent,
        storage_key: `k/${talent}`,
        resume_edition_id: edition,
      });
      await prisma.talentResumeText.updateMany({
        where: { tenant_id: tenant, talent_record_id: talent, resume_edition_id: edition },
        data: { redacted_text: text, status: 'extracted', extracted_at: new Date() },
      });
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const setup = new TalentRecordPrismaService(url);
      await setup.$connect();
      for (const path of MIGRATIONS) {
        for (const stmt of splitDdl(readFileSync(path, 'utf8'))) {
          await setup.$executeRawUnsafe(stmt);
        }
      }
      await setup.$disconnect();

      prisma = new TalentRecordPrismaService(url);
      await prisma.$connect();
      repo = new TalentRecordRepository(prisma);
      resumeText = new ResumeTextService(prisma, fakeObjectStorage as never, fakeLogger as never);
      adapter = new TalentSearchAdapter(repo);

      await prisma.talentRecord.create({
        data: { id: talentA1, tenant_id: TENANT_A, site_id: SITE_1, first_name: 'Alice', last_name: 'Kovacs', email1: 'alice@acme.test', current_pay: '120000' },
      });
      await prisma.talentRecord.create({
        data: { id: talentA2, tenant_id: TENANT_A, site_id: SITE_2, first_name: 'Bob', last_name: 'Nguyen', email1: 'bob@acme.test' },
      });
      await prisma.talentRecord.create({
        data: { id: talentB1, tenant_id: TENANT_B, first_name: 'Alice', last_name: 'Kovacs', email1: 'alice@acme.test' },
      });

      await setResume(TENANT_A, talentA1, 'Senior data engineer expert in Snowflake Spark and Airflow.');
      await setResume(TENANT_A, talentA2, 'Nguyen is a Java developer with mortgage experience at Freddie Mac.');
      await setResume(TENANT_B, talentB1, 'Snowflake specialist in another tenant.');
    }, 180_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    it('name lexical leg is tenant-isolated (same name in tenant B is absent)', async () => {
      const hits = await adapter.search('Kovacs', authority(TENANT_A), 10);
      expect(hits.map((h) => h.entity_id)).toEqual([talentA1]);
      expect(hits[0]?.match.signal).toBe('lexical');
      expect(hits[0]?.display_label).toBe('Alice Kovacs');
    });

    it('exact-email leg matches by email, tenant-isolated, and marks the hit exact', async () => {
      const hits = await adapter.search('alice@acme.test', authority(TENANT_A), 10);
      expect(hits.map((h) => h.entity_id)).toEqual([talentA1]); // NOT talentB1 (tenant B)
      expect(hits[0]?.match.signal).toBe('exact');
    });

    it('exact-email stays inside the pool-open tenant+site contract (no authority bypass)', async () => {
      // alice@acme.test lives in SITE_1. A site_2-scoped actor must NOT retrieve her.
      const wrongSite = await adapter.search('alice@acme.test', authority(TENANT_A, SITE_2), 10);
      expect(wrongSite).toEqual([]);
      // The site she is in retrieves her.
      const rightSite = await adapter.search('alice@acme.test', authority(TENANT_A, SITE_1), 10);
      expect(rightSite.map((h) => h.entity_id)).toEqual([talentA1]);
    });

    it('résumé FTS leg matches redacted résumé text, tenant-isolated, with a snippet', async () => {
      const hits = await adapter.search('Snowflake', authority(TENANT_A), 10);
      expect(hits.map((h) => h.entity_id)).toEqual([talentA1]); // NOT talentB1 (tenant B)
      expect(hits[0]?.match.signal).toBe('lexical');
      expect(hits[0]?.snippet).toContain('<mark>');
      expect(hits[0]?.snippet?.toLowerCase()).toContain('snowflake');
    });

    it('dedupes name + résumé matches into ONE hit (watch-point 2)', async () => {
      // "Nguyen" matches Bob Nguyen by BOTH last_name and résumé text.
      const hits = await adapter.search('Nguyen', authority(TENANT_A), 10);
      const forBob = hits.filter((h) => h.entity_id === talentA2);
      expect(forBob).toHaveLength(1);
      // strongest leg wins the relevance; the résumé snippet is preserved on the merged hit.
      expect(forBob[0]?.match.signal).toBe('lexical');
      expect(forBob[0]?.snippet).toContain('<mark>');
    });

    it('emits a lean hit: no email / phone / compensation PII', async () => {
      const hits = await adapter.search('Kovacs', authority(TENANT_A), 10);
      const hit = hits[0]!;
      expect(hit).not.toHaveProperty('email1');
      expect(hit).not.toHaveProperty('phone_cell');
      expect(hit).not.toHaveProperty('current_pay');
      expect(hit.route).toBe(`/talent/${talentA1}`);
      expect(hit.entity_type).toBe('TALENT');
    });
  },
);
