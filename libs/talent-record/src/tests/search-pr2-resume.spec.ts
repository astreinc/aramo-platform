import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '@aramo/auth';
import { extractResumeText } from '@aramo/resume-parse';

import { TalentRecordController } from '../lib/talent-record.controller.js';
import type { TalentRecordRepository } from '../lib/talent-record.repository.js';
import type { TalentLinkService } from '../lib/talent-link.service.js';
import { ResumeTextService } from '../lib/resume-text/resume-text.service.js';
import {
  redactResumeText,
  REDACTION_PLACEHOLDER,
} from '../lib/resume-text/redaction.js';

// extractResumeText is reused by ResumeTextService.drainPendingBatch — mock it
// so the re-extract path is exercised deterministically (no real pdf/docx).
// Partial mock (importOriginal) so the other barrel exports the controller
// pulls in (ResumeParserService) stay intact. vitest hoists vi.mock above the
// imports, so the mock applies despite being written below them.
vi.mock('@aramo/resume-parse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aramo/resume-parse')>();
  return { ...actual, extractResumeText: vi.fn() };
});

// Search PR-2 — résumé full-text proofs. Lead pre-committed rulings:
//   R1 async re-extract · R2 SSN redaction at persist · R3 websearch_to_tsquery
//   + ts_rank + generated tsvector/GIN · R4 ?resume_q= AND ?q= · R5 DB
//   onDelete cascade purge. Unit-level construction + structural proofs
//   (the PR-1 substrate norm; the cascade is proven structurally — the R1
//   drift-spec precedent of reading the source/migration).

const REQUEST_ID = 'rq-search-pr2-resume-001';
const TENANT_ID = '01900000-0000-7000-8000-000000000001';
const OTHER_TENANT = '01900000-0000-7000-8000-0000000000ff';
const ACTOR_ID = '01900000-0000-7000-8000-0000000000aa';

function makeAuthContext(scopes: string[]): AuthContextType {
  return {
    sub: ACTOR_ID,
    tenant_id: TENANT_ID,
    scopes,
    consumer_type: 'tenant_user',
    capabilities: ['ats'],
  } as unknown as AuthContextType;
}

function makeController(): {
  ctl: TalentRecordController;
  repo: {
    list: ReturnType<typeof vi.fn>;
    searchByResumeText: ReturnType<typeof vi.fn>;
  };
} {
  const repo = {
    list: vi.fn().mockResolvedValue([]),
    searchByResumeText: vi.fn().mockResolvedValue([]),
  };
  const ctl = new TalentRecordController(
    repo as unknown as TalentRecordRepository,
    {} as unknown as TalentLinkService,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {} as any,
  );
  return { ctl, repo };
}

// ---------------------------------------------------------------------------
// PROOF #1 — SSN-redaction (redact at persist; planted SSN absent).
// ---------------------------------------------------------------------------
describe('PR-2 proof #1 — SSN-shaped redaction (R2/D4)', () => {
  it('redacts the three common SSN separators; planted SSN is absent', () => {
    const input =
      'Jane Doe. SSN 123-45-6789. Also 987 65 4321 and 111.22.3333. Skills: k8s.';
    const out = redactResumeText(input);
    expect(out).not.toContain('123-45-6789');
    expect(out).not.toContain('987 65 4321');
    expect(out).not.toContain('111.22.3333');
    expect(out).toContain(REDACTION_PLACEHOLDER);
  });

  it('preserves non-SSN content verbatim (recall-neutral)', () => {
    const input = 'Led the Kubernetes migration for ACME in 2021.';
    expect(redactResumeText(input)).toBe(input);
  });

  it('does NOT redact a bare 9-digit run (recall — deliberately excluded)', () => {
    const input = 'Employee id 123456789 ref.';
    expect(redactResumeText(input)).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// PROOF #2/#3/#4 + R4 — the ?resume_q= query construction (repo, mocked raw).
// ---------------------------------------------------------------------------
describe('PR-2 proof #2/#3/#4 — résumé content-search SQL (repo)', () => {
  async function runSearch(args: {
    tenant_id: string;
    site_id?: string;
    resume_q: string;
    q?: string;
  }): Promise<{ sql: string; params: unknown[] }> {
    const { TalentRecordRepository: Repo } = await import(
      '../lib/talent-record.repository.js'
    );
    const $queryRawUnsafe = vi.fn().mockResolvedValue([]);
    const repo = new Repo({ $queryRawUnsafe } as never);
    await repo.searchByResumeText(args);
    const call = $queryRawUnsafe.mock.calls[0];
    return { sql: call[0] as string, params: call.slice(1) };
  }

  it('#2 — websearch_to_tsquery match + ts_rank ordering against the tsvector', async () => {
    const { sql, params } = await runSearch({
      tenant_id: TENANT_ID,
      resume_q: 'kubernetes',
    });
    expect(sql).toContain("search_tsv @@ websearch_to_tsquery('english', $1)");
    expect(sql).toContain(
      "ORDER BY ts_rank(rt.search_tsv, websearch_to_tsquery('english', $1)) DESC",
    );
    // $1 carries the user query text (parameterized — no interpolation).
    expect(params[0]).toBe('kubernetes');
  });

  it('#3 — visibility-AND: tenant_id is bound in the WHERE; site narrows when given', async () => {
    const withoutSite = await runSearch({
      tenant_id: TENANT_ID,
      resume_q: 'kubernetes',
    });
    expect(withoutSite.sql).toContain('tr.tenant_id = $2');
    expect(withoutSite.params[1]).toBe(TENANT_ID);
    // A different tenant's record cannot appear — tenant_id is a bound param,
    // never the actor-supplied query.
    expect(withoutSite.params).not.toContain(OTHER_TENANT);

    const withSite = await runSearch({
      tenant_id: TENANT_ID,
      site_id: 'site-1',
      resume_q: 'kubernetes',
    });
    expect(withSite.sql).toContain('tr.site_id = $3');
    expect(withSite.params[2]).toBe('site-1');
  });

  it('#4 — ts_headline snippet over the REDACTED text column', async () => {
    const { sql } = await runSearch({ tenant_id: TENANT_ID, resume_q: 'k8s' });
    expect(sql).toContain("ts_headline('english', rt.redacted_text");
    expect(sql).toContain('AS resume_snippet');
  });

  it('maps a raw row to a view carrying resume_snippet', async () => {
    const { TalentRecordRepository: Repo } = await import(
      '../lib/talent-record.repository.js'
    );
    const now = new Date('2026-06-09T00:00:00.000Z');
    const $queryRawUnsafe = vi.fn().mockResolvedValue([
      {
        id: 'tr-1',
        tenant_id: TENANT_ID,
        site_id: null,
        first_name: 'Jane',
        last_name: 'Doe',
        email1: null,
        email2: null,
        phone_home: null,
        phone_cell: null,
        phone_work: null,
        address: null,
        address2: null,
        city: null,
        state: null,
        zip: null,
        source: null,
        key_skills: null,
        current_employer: null,
        current_pay: null,
        desired_pay: null,
        availability_status: null,
        engagement_type: null,
        work_authorization: null,
        date_available: null,
        can_relocate: false,
        is_hot: false,
        notes: null,
        web_site: null,
        best_time_to_call: null,
        owner_id: null,
        entered_by_id: null,
        created_at: now,
        updated_at: now,
        resume_snippet: 'led the <mark>Kubernetes</mark> migration',
      },
    ]);
    const repo = new Repo({ $queryRawUnsafe } as never);
    const items = await repo.searchByResumeText({
      tenant_id: TENANT_ID,
      resume_q: 'kubernetes',
    });
    expect(items[0]?.resume_snippet).toBe('led the <mark>Kubernetes</mark> migration');
    expect(items[0]?.first_name).toBe('Jane');
  });

  it('R4 — when ?q= is also present the name-ILIKE is ANDed', async () => {
    const { sql, params } = await runSearch({
      tenant_id: TENANT_ID,
      resume_q: 'kubernetes',
      q: 'jane',
    });
    expect(sql).toContain('tr.first_name ILIKE $3 OR tr.last_name ILIKE $3');
    expect(params[2]).toBe('%jane%');
  });
});

// ---------------------------------------------------------------------------
// PROOF #7 + #6 + R4 routing — controller scope-gate + backward-compat.
// ---------------------------------------------------------------------------
describe('PR-2 proof #7/#6 — controller scope-gate + backward-compat', () => {
  it('#7 — resume_q present WITHOUT talent:search → 403 INSUFFICIENT_PERMISSIONS', async () => {
    const { ctl } = makeController();
    const auth = makeAuthContext(['talent:read']);
    await expect(
      ctl.list(auth, undefined, undefined, 'kubernetes', REQUEST_ID),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403 });
  });

  it('#7 — the 403 details name the required scope', async () => {
    const { ctl } = makeController();
    const auth = makeAuthContext(['talent:read']);
    try {
      await ctl.list(auth, undefined, undefined, 'kubernetes', REQUEST_ID);
      throw new Error('expected throw');
    } catch (e) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((e as any).context.details).toMatchObject({
        reason: 'search_scope_missing',
        required_scope: 'talent:search',
      });
    }
  });

  it('resume_q WITH talent:search → searchByResumeText called (NOT list)', async () => {
    const { ctl, repo } = makeController();
    const auth = makeAuthContext(['talent:read', 'talent:search']);
    await ctl.list(auth, undefined, undefined, '  kubernetes  ', REQUEST_ID);
    expect(repo.searchByResumeText).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: TENANT_ID, resume_q: 'kubernetes', q: undefined }),
    );
    expect(repo.list).not.toHaveBeenCalled();
  });

  it('R4 — both q and resume_q → searchByResumeText receives the name term', async () => {
    const { ctl, repo } = makeController();
    const auth = makeAuthContext(['talent:read', 'talent:search']);
    await ctl.list(auth, undefined, 'jane', 'kubernetes', REQUEST_ID);
    expect(repo.searchByResumeText).toHaveBeenCalledWith(
      expect.objectContaining({ resume_q: 'kubernetes', q: 'jane' }),
    );
  });

  it('#6 — resume_q ABSENT → the PR-1/no-search path (repo.list), searchByResumeText untouched', async () => {
    const { ctl, repo } = makeController();
    const auth = makeAuthContext(['talent:read']);
    await ctl.list(auth, undefined, undefined, undefined, REQUEST_ID);
    expect(repo.list).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: TENANT_ID, q: undefined }),
    );
    expect(repo.searchByResumeText).not.toHaveBeenCalled();
  });

  it('#6 — whitespace-only resume_q is treated as absent', async () => {
    const { ctl, repo } = makeController();
    const auth = makeAuthContext(['talent:read']);
    await ctl.list(auth, undefined, undefined, '   ', REQUEST_ID);
    expect(repo.searchByResumeText).not.toHaveBeenCalled();
    expect(repo.list).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PROOF #1 (end-to-end persist) + R1 async — enqueue + drain re-extract.
// ---------------------------------------------------------------------------
describe('PR-2 — enqueue + async re-extract (R1)', () => {
  const extractMock = vi.mocked(extractResumeText);

  beforeEach(() => {
    extractMock.mockReset();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(8),
      }),
    );
  });

  function makeService(prismaOverrides: Record<string, unknown>): {
    service: ResumeTextService;
    update: ReturnType<typeof vi.fn>;
  } {
    const update = vi.fn().mockResolvedValue({});
    const prisma = {
      talentResumeText: {
        upsert: vi.fn().mockResolvedValue({}),
        findMany: vi.fn().mockResolvedValue([]),
        update,
        ...prismaOverrides,
      },
    };
    const objectStorage = {
      createPresignedGet: vi
        .fn()
        .mockResolvedValue({ presigned_url: 'https://s3/x', expires_at: 'z' }),
    };
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const service = new ResumeTextService(
      prisma as never,
      objectStorage as never,
      logger as never,
    );
    return { service, update };
  }

  it('enqueueReindex upserts a pending row keyed to the talent_record_id', async () => {
    const upsert = vi.fn().mockResolvedValue({});
    const { service } = makeService({ upsert });
    await service.enqueueReindex({
      tenant_id: TENANT_ID,
      talent_record_id: 'tr-1',
      attachment_id: 'att-1',
      storage_key: 'tenant/x/resume.pdf',
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { talent_record_id: 'tr-1' },
        create: expect.objectContaining({ status: 'pending', talent_record_id: 'tr-1' }),
        update: expect.objectContaining({ status: 'pending' }),
      }),
    );
  });

  it('#1 (persist) — drain extracts, REDACTS, and persists redacted text (no SSN)', async () => {
    extractMock.mockResolvedValue('Jane Doe SSN 123-45-6789, Kubernetes lead.');
    const findMany = vi.fn().mockResolvedValue([
      {
        id: 'rt-1',
        tenant_id: TENANT_ID,
        talent_record_id: 'tr-1',
        storage_key: 'tenant/x/resume.pdf',
        status: 'pending',
        created_at: new Date(),
      },
    ]);
    const { service, update } = makeService({ findMany });
    const result = await service.drainPendingBatch({ limit: 10 });
    expect(result).toEqual({ attempted: 1, extracted: 1, failed: 0 });
    const data = update.mock.calls[0][0].data;
    expect(data.status).toBe('extracted');
    expect(data.redacted_text).not.toContain('123-45-6789');
    expect(data.redacted_text).toContain(REDACTION_PLACEHOLDER);
    expect(data.redacted_text).toContain('Kubernetes');
  });

  it('R1 per-row isolation — an extraction failure marks the row failed, batch continues', async () => {
    extractMock.mockResolvedValue(null); // extraction failed
    const findMany = vi.fn().mockResolvedValue([
      {
        id: 'rt-1',
        tenant_id: TENANT_ID,
        talent_record_id: 'tr-1',
        storage_key: 'tenant/x/bad.bin',
        status: 'pending',
        created_at: new Date(),
      },
    ]);
    const { service, update } = makeService({ findMany });
    const result = await service.drainPendingBatch({ limit: 10 });
    expect(result).toEqual({ attempted: 1, extracted: 0, failed: 1 });
    expect(update.mock.calls[0][0].data).toEqual({ status: 'failed' });
  });
});

// ---------------------------------------------------------------------------
// PROOF #5 (load-bearing) — purge-on-delete cascade is DB-ENFORCED.
// Structural proof (R1 drift-spec precedent): the FK ON DELETE CASCADE is
// declared in BOTH the migration and the schema, so deleting a TalentRecord
// purges the résumé-text row (and its tsvector GIN entry) at the DB level.
// ---------------------------------------------------------------------------
describe('PR-2 proof #5 — purge-on-delete cascade (R5/D1)', () => {
  const migrationSql = readFileSync(
    fileURLToPath(
      new URL(
        '../../prisma/migrations/20260609130000_search_pr2_resume_text/migration.sql',
        import.meta.url,
      ),
    ),
    'utf8',
  );
  const schema = readFileSync(
    fileURLToPath(new URL('../../prisma/schema.prisma', import.meta.url)),
    'utf8',
  );

  it('migration declares the FK with ON DELETE CASCADE to TalentRecord', () => {
    expect(migrationSql).toContain(
      'REFERENCES "talent_record"."TalentRecord" ("id")',
    );
    expect(migrationSql).toMatch(/ON DELETE CASCADE/);
  });

  it('schema declares onDelete: Cascade on the résumé-text relation', () => {
    expect(schema).toContain('model TalentResumeText');
    expect(schema).toMatch(/references:\s*\[id\],\s*onDelete:\s*Cascade/);
  });

  it('migration generates the tsvector column + GIN index (R3 net-new full-text)', () => {
    expect(migrationSql).toContain(
      "GENERATED ALWAYS AS (to_tsvector('english', coalesce(\"redacted_text\", ''))) STORED",
    );
    expect(migrationSql).toMatch(/USING gin \("search_tsv"\)/);
    // full-text is CORE Postgres — NO extension (unlike PR-1's pg_trgm).
    expect(migrationSql).not.toContain('CREATE EXTENSION');
  });
});
