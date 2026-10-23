import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { v7 as uuidv7 } from 'uuid';
import {
  PrismaService as EvidencePrismaService,
  TalentEvidenceRepository,
} from '@aramo/talent-evidence';
import { TalentExtractionService } from '@aramo/talent-extraction';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { TalentRecordRepository } from '../lib/talent-record.repository.js';
import { TalentEventOutboxRepository } from '../lib/talent-events/talent-event-outbox.js';
import { TalentIntakePromotionService } from '../lib/talent-intake/talent-intake-promotion.service.js';
import { TALENT_INTAKE_SOURCE_TYPE_RESUME_UPLOAD } from '../lib/talent-intake/talent-intake.constants.js';

// ATI-SEP-1 A2 + A3 — the resumable intake Save and the ATS talent outbox
// against a REAL Postgres 17 with the documents + talent_evidence +
// talent_record migrations. Real TalentEvidenceRepository / TalentExtraction
// (model ports stubbed — a Save never calls them) / TalentRecordRepository /
// TalentEventOutboxRepository. NO trust, identity-index or reconcile service
// exists in this graph: the Save succeeds without any of them.

const ROOT = resolve(__dirname, '../../../..');
const MIGRATION_LIBS = ['documents', 'talent-evidence', 'talent-record'];

function collectMigrations(): string[] {
  const all: { name: string; path: string }[] = [];
  for (const lib of MIGRATION_LIBS) {
    const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (d.isDirectory() && /^\d+_/.test(d.name)) {
        all.push({ name: d.name, path: resolve(dir, d.name, 'migration.sql') });
      }
    }
  }
  return all.sort((a, b) => a.name.localeCompare(b.name)).map((m) => m.path);
}

// Dollar-quote / comment / string-literal aware splitter (documents and the A2
// repair migration carry `$$` bodies). Only splits on a top-level `;`.
function splitDdl(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  let tag: string | null = null;
  while (i < sql.length) {
    const ch = sql[i];
    if (tag === null && ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      if (nl === -1) break;
      cur += '\n';
      i = nl + 1;
      continue;
    }
    if (ch === '$') {
      const m = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (m !== null && (tag === null || tag === m[0])) {
        tag = tag === null ? m[0] : null;
        cur += m[0];
        i += m[0].length;
        continue;
      }
    }
    if (tag === null && ch === "'") {
      cur += ch;
      i += 1;
      while (i < sql.length) {
        cur += sql[i];
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            cur += sql[i + 1];
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (tag === null && ch === ';') {
      if (cur.trim().length > 0) out.push(cur.trim());
      cur = '';
      i += 1;
      continue;
    }
    cur += ch;
    i += 1;
  }
  if (cur.trim().length > 0) out.push(cur.trim());
  return out;
}

const TENANT = '11111111-1111-7111-8111-111111111111';
const ACTOR = '33333333-3333-7333-8333-333333333333';
const auth = { tenant_id: TENANT, sub: ACTOR, consumer_type: 'recruiter' } as never;

const WORK_HISTORY = [
  {
    employer_name: 'Initech',
    role_title: 'Analyst',
    start_date: '2016',
    end_date: '2019',
    source_refs: ['B003'],
    assertions: [
      { type: 'ACCOMPLISHMENT', statement: 'Cut report latency by 40%', metric: '40%', source_refs: ['B003'] },
      { type: '', statement: 'dropped — no type', source_refs: [] },
    ],
  },
  { employer_name: 'Globex', role_title: 'Engineer', start_date: '2019', end_date: 'Present', source_refs: ['B005'] },
];

function reviewPayload(fields: Record<string, unknown>) {
  return {
    fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { value: v, origin: 'RECRUITER' }])),
    work_history: WORK_HISTORY,
    education: [{ institution_name: 'State University', degree_name: 'BSc', source_refs: ['B009'] }],
    skills: [{ surface_form: 'SQL', source_refs: ['B004'] }],
    resume_provenance: { source_map_version: 'resume-source-map/v1', resume_text_hash: 'hash-1' },
  };
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'ATI-SEP-1 A2/A3 — resumable intake Save + ATS talent outbox (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let evidencePrisma: EvidencePrismaService;
    let recordPrisma: PrismaService;
    let extraction: TalentExtractionService;
    let records: TalentRecordRepository;
    let outbox: TalentEventOutboxRepository;
    let save: TalentIntakePromotionService;

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const url = container.getConnectionUri();
      const setup = new EvidencePrismaService(url);
      await setup.$connect();
      for (const path of collectMigrations()) {
        for (const stmt of splitDdl(readFileSync(path, 'utf8'))) {
          await setup.$executeRawUnsafe(stmt);
        }
      }
      await setup.$disconnect();
      evidencePrisma = new EvidencePrismaService(url);
      await evidencePrisma.$connect();
      recordPrisma = new PrismaService(url);
      await recordPrisma.$connect();
      extraction = new TalentExtractionService(
        { generateDraft: vi.fn() } as never,
        new TalentEvidenceRepository(evidencePrisma),
        { generateStructured: vi.fn() } as never,
      );
      records = new TalentRecordRepository(recordPrisma);
      outbox = new TalentEventOutboxRepository(recordPrisma);
    }, 240_000);

    afterAll(async () => {
      await evidencePrisma?.$disconnect();
      await recordPrisma?.$disconnect();
      await container?.stop();
    });

    beforeEach(async () => {
      vi.restoreAllMocks();
      await recordPrisma.$executeRawUnsafe(`TRUNCATE "talent_record"."TalentEventOutbox", "talent_record"."TalentRecord" CASCADE`);
      await evidencePrisma.$executeRawUnsafe(
        `TRUNCATE "talent_evidence"."TalentIntakeDraft", "talent_evidence"."TalentWorkHistoryEntry",
                  "talent_evidence"."TalentSkillEvidence", "talent_evidence"."TalentEducationEntry",
                  "talent_evidence"."TalentWorkAuthorization", "talent_evidence"."TalentResumeDefault",
                  "talent_evidence"."TalentResumeEdition", "talent_evidence"."TalentDocument",
                  "talent_evidence"."TalentDerivedSnapshot" CASCADE`,
      );
      save = new TalentIntakePromotionService(extraction, records);
    });

    async function draft(fields: Record<string, unknown>): Promise<string> {
      const id = uuidv7();
      await extraction.createTalentIntakeDraft({
        id,
        tenant_id: TENANT,
        created_by: ACTOR,
        source_type: TALENT_INTAKE_SOURCE_TYPE_RESUME_UPLOAD,
        source_filename: 'ada.pdf',
        storage_key: `${TENANT}/resumes/${id}/ada.pdf`,
        mime_type: 'application/pdf',
      });
      await evidencePrisma.talentIntakeDraft.update({
        where: { id },
        data: { review_payload: reviewPayload(fields) as never, review_status: 'IN_REVIEW', artifact_sha256: 'sha-1' },
      });
      return id;
    }

    const ADA = {
      first_name: 'Ada',
      last_name: 'Lovelace',
      email1: 'ada@example.com',
      phone_cell: '(555) 123-0000',
      work_authorization: 'US_CITIZEN',
    };

    async function counts(talentId: string | null) {
      const t = talentId ?? '00000000-0000-0000-0000-000000000000';
      return {
        records: await recordPrisma.talentRecord.count({ where: { tenant_id: TENANT } }),
        created: await recordPrisma.talentEventOutbox.count({ where: { event_type: 'talent.created' } }),
        workHistory: await evidencePrisma.talentWorkHistoryEntry.count({ where: { talent_id: t } }),
        documents: await evidencePrisma.talentDocument.count({ where: { talent_id: t } }),
        editions: await evidencePrisma.talentResumeEdition.count({ where: { talent_id: t } }),
        workAuth: await evidencePrisma.talentWorkAuthorization.count({ where: { talent_id: t } }),
        resumeText: await recordPrisma.talentResumeText.count({ where: { talent_record_id: t } }),
      };
    }

    const EXPECTED = { records: 1, created: 1, workHistory: 2, documents: 1, editions: 1, workAuth: 1, resumeText: 1 };

    it('happy path: one record + one talent.created (ids only) + evidence + assertions + reindex row; PROMOTED last', async () => {
      const id = await draft(ADA);
      const rec = await save.promote(auth, id, 'rq-1');
      expect(await counts(rec.id)).toEqual(EXPECTED);

      const d = await evidencePrisma.talentIntakeDraft.findUniqueOrThrow({ where: { id } });
      expect(d.review_status).toBe('PROMOTED');
      expect(d.promoted_talent_record_id).toBe(rec.id);
      expect(d.save_reserved_talent_record_id).toBe(rec.id);

      const ev = await recordPrisma.talentEventOutbox.findFirstOrThrow({ where: { subject_id: rec.id } });
      expect(ev).toMatchObject({ event_type: 'talent.created', event_version: 'v1', tenant_id: TENANT, published_at: null });
      // ids only — never PII, never a document reference / storage key.
      expect(ev.event_payload).toEqual({ talent_record_id: rec.id, intake_draft_id: id });
      expect(JSON.stringify(ev.event_payload)).not.toMatch(/ada@|555|resumes|\.pdf/);

      // A2 — the reviewed experience assertions are ATS evidence now.
      const initech = await evidencePrisma.talentWorkHistoryEntry.findFirstOrThrow({
        where: { talent_id: rec.id, employer_name: 'Initech' },
      });
      expect(initech.assertions).toEqual([
        {
          type: 'ACCOMPLISHMENT',
          statement: 'Cut report latency by 40%',
          metric: '40%',
          grounding_class: 'SOURCE_ASSOCIATED_INTERPRETATION',
          source_refs: ['B003'],
        },
      ]);
      // A2 — the normalized dedupe key.
      const row = await recordPrisma.talentRecord.findUniqueOrThrow({ where: { id: rec.id } });
      expect(row.phone_cell_normalized).toBe('15551230000');
    });

    it('VALIDATION FIRST: invalid stated field → 400; draft unchanged and re-savable after the fix', async () => {
      const id = await draft({ ...ADA, engagement_type: 'freelance-ish' });
      const before = await evidencePrisma.talentIntakeDraft.findUniqueOrThrow({ where: { id } });
      await expect(save.promote(auth, id, 'rq-1')).rejects.toMatchObject({ statusCode: 400 });
      const after = await evidencePrisma.talentIntakeDraft.findUniqueOrThrow({ where: { id } });
      expect(after).toEqual(before);
      expect(await counts(null)).toMatchObject({ records: 0, created: 0 });

      await evidencePrisma.talentIntakeDraft.update({ where: { id }, data: { review_payload: reviewPayload(ADA) as never } });
      const rec = await save.promote(auth, id, 'rq-2');
      expect(await counts(rec.id)).toEqual(EXPECTED);
    });

    const STEPS: Array<{ name: string; inject: () => void }> = [
      {
        name: 'step 1 (evidence)',
        inject: () => {
          vi.spyOn(extraction, 'materializeIntakeSaveEvidence').mockRejectedValueOnce(new Error('injected'));
        },
      },
      {
        name: 'step 2 before commit (record)',
        inject: () => {
          vi.spyOn(records, 'create').mockRejectedValueOnce(new Error('injected'));
        },
      },
      {
        name: 'step 2 after commit (crash before step 3)',
        inject: () => {
          const real = records.create.bind(records);
          vi.spyOn(records, 'create').mockImplementationOnce(async (a) => {
            await real(a);
            throw new Error('injected');
          });
        },
      },
      {
        name: 'step 3 (work authorization)',
        inject: () => {
          vi.spyOn(extraction, 'recordDeclaredWorkAuthorization').mockRejectedValueOnce(new Error('injected'));
        },
      },
      {
        name: 'step 4 (mark PROMOTED)',
        inject: () => {
          vi.spyOn(extraction, 'completeTalentIntakeDraftSave').mockRejectedValueOnce(new Error('injected'));
        },
      },
    ];

    for (const step of STEPS) {
      it(`failure at ${step.name} → never PROMOTED-without-record; re-Save → exactly one record, one talent.created, evidence once`, async () => {
        const id = await draft(ADA);
        step.inject();
        await expect(save.promote(auth, id, 'rq-1')).rejects.toThrow('injected');
        const mid = await evidencePrisma.talentIntakeDraft.findUniqueOrThrow({ where: { id } });
        expect(mid.review_status).not.toBe('PROMOTED');
        expect(mid.promoted_talent_record_id).toBeNull();

        const rec = await save.promote(auth, id, 'rq-2');
        expect(rec.id).toBe(mid.save_reserved_talent_record_id);
        expect(await counts(rec.id)).toEqual(EXPECTED);
        expect((await evidencePrisma.talentIntakeDraft.findUniqueOrThrow({ where: { id } })).review_status).toBe('PROMOTED');
      });
    }

    it('concurrent Saves of one draft → one record, one talent.created, evidence once, same id for every caller', async () => {
      const id = await draft(ADA);
      const results = await Promise.allSettled([
        save.promote(auth, id, 'c1'),
        save.promote(auth, id, 'c2'),
        save.promote(auth, id, 'c3'),
      ]);
      const ok = results.filter((r): r is PromiseFulfilledResult<{ id: string }> => r.status === 'fulfilled');
      expect(ok.length).toBeGreaterThan(0);
      expect(new Set(ok.map((r) => r.value.id)).size).toBe(1);
      // A caller that lost a race resumes cleanly on the next Save.
      const rec = await save.promote(auth, id, 'c4');
      expect(rec.id).toBe(ok[0]?.value.id);
      expect(await counts(rec.id)).toEqual(EXPECTED);
    });

    it('phone dedupe: a live record with the same normalized cell phone → 409 { reason: phone }, no state change', async () => {
      const other = await records.create({
        tenant_id: TENANT,
        entered_by_id: ACTOR,
        input: { first_name: 'Grace', last_name: 'Hopper', email1: 'grace@example.com', phone_cell: '+1 555 123 0000' } as never,
        requestId: 'seed',
      });
      const id = await draft(ADA);
      await expect(save.promote(auth, id, 'rq-1')).rejects.toMatchObject({
        statusCode: 409,
        code: 'TALENT_RECORD_DUPLICATE',
        context: { details: { reason: 'phone', existing_id: other.id } },
      });
      const d = await evidencePrisma.talentIntakeDraft.findUniqueOrThrow({ where: { id } });
      expect(d.save_reserved_talent_record_id).toBeNull();
      expect(await recordPrisma.talentRecord.count()).toBe(1);
    });

    it('in-transaction dedupe: a racing create of the same email rolls back → no record AND no outbox row', async () => {
      await records.create({
        tenant_id: TENANT,
        entered_by_id: ACTOR,
        input: { first_name: 'Ada', last_name: 'One', email1: 'ADA@example.com', phone_cell: '555 999 0000' } as never,
        requestId: 'seed',
      });
      await expect(
        records.create({
          tenant_id: TENANT,
          entered_by_id: ACTOR,
          input: { first_name: 'Ada', last_name: 'Two', email1: 'ada@example.com', phone_cell: '555 888 0000' } as never,
          requestId: 'rq',
          dedupe: true,
        }),
      ).rejects.toMatchObject({ statusCode: 409, context: { details: { reason: 'email' } } });
      expect(await recordPrisma.talentRecord.count()).toBe(1);
      expect(await recordPrisma.talentEventOutbox.count()).toBe(1); // the seed's own talent.created only
    });

    it('PATCH emits talent.profile_updated with changed field NAMES in the same transaction; a no-op PATCH emits nothing', async () => {
      const rec = await records.create({
        tenant_id: TENANT,
        entered_by_id: ACTOR,
        input: { first_name: 'Ada', last_name: 'Lovelace', email1: 'ada@example.com', phone_cell: '555 123 0000' } as never,
        requestId: 'seed',
      });
      await records.update({ tenant_id: TENANT, id: rec.id, input: { city: 'London', phone_cell: '555 123 0001' } as never, requestId: 'rq' });
      const ev = await recordPrisma.talentEventOutbox.findFirstOrThrow({ where: { event_type: 'talent.profile_updated' } });
      expect(ev.event_payload).toEqual({ talent_record_id: rec.id, changed_fields: ['city', 'phone_cell'] });
      expect((await recordPrisma.talentRecord.findUniqueOrThrow({ where: { id: rec.id } })).phone_cell_normalized).toBe('15551230001');

      await records.update({ tenant_id: TENANT, id: rec.id, input: {} as never, requestId: 'rq' });
      expect(await recordPrisma.talentEventOutbox.count({ where: { event_type: 'talent.profile_updated' } })).toBe(1);

      // A failed update (bad date) commits neither the change nor an event.
      await expect(
        records.update({ tenant_id: TENANT, id: rec.id, input: { date_available: 'soon' } as never, requestId: 'rq' }),
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(await recordPrisma.talentEventOutbox.count({ where: { event_type: 'talent.profile_updated' } })).toBe(1);
    });

    it('outbox lease: claim → failed dispatch keeps the lease (backoff) → not re-claimable until it expires; published is final', async () => {
      const rec = await records.create({
        tenant_id: TENANT,
        entered_by_id: ACTOR,
        input: { first_name: 'Ada', last_name: 'Lovelace', email1: 'ada@example.com', phone_cell: '555 123 0000' } as never,
        requestId: 'seed',
      });
      const claimed = await outbox.claimOutboxBatch({ limit: 10, lease_seconds: 60, max_attempts: 5 });
      expect(claimed.map((r) => r.subject_id)).toEqual([rec.id]);
      const first = claimed[0];
      if (first === undefined) throw new Error('nothing claimed');
      expect(first.publish_attempts).toBe(1);
      await outbox.releaseOutboxLease({ event_ids: [first.id], last_error: 'handler failed' });
      expect(await outbox.claimOutboxBatch({ limit: 10, lease_seconds: 60, max_attempts: 5 })).toEqual([]);
      const leased = await recordPrisma.talentEventOutbox.findUniqueOrThrow({ where: { id: first.id } });
      expect(leased.lease_expires_at?.getTime() ?? 0).toBeGreaterThan(Date.now());
      expect(leased.last_publish_error).toBe('handler failed');

      // Backoff elapsed → re-claimed; published → never claimed again.
      await recordPrisma.talentEventOutbox.update({ where: { id: first.id }, data: { lease_expires_at: new Date(Date.now() - 1000) } });
      const again = await outbox.claimOutboxBatch({ limit: 10, lease_seconds: 60, max_attempts: 5 });
      expect(again.map((r) => [r.id, r.publish_attempts])).toEqual([[first.id, 2]]);
      expect(await outbox.markOutboxPublished({ event_ids: [first.id] })).toBe(1);
      await recordPrisma.talentEventOutbox.update({ where: { id: first.id }, data: { lease_expires_at: null } });
      expect(await outbox.claimOutboxBatch({ limit: 10, lease_seconds: 60, max_attempts: 5 })).toEqual([]);
    });

    it('legacy repair (migration): a pre-A2 PROMOTED draft with no record was returned to IN_REVIEW', async () => {
      // The repair runs once at migrate time; prove the predicate on a fresh row.
      const id = await draft(ADA);
      await evidencePrisma.talentIntakeDraft.update({
        where: { id },
        data: { review_status: 'PROMOTED', promoted_talent_record_id: uuidv7() },
      });
      const repair = readFileSync(
        resolve(ROOT, 'libs/talent-evidence/prisma/migrations/20261024120000_ati_sep_1_intake_resumable_save/migration.sql'),
        'utf8',
      );
      const doBlock = splitDdl(repair).find((s) => s.startsWith('DO $$'));
      await evidencePrisma.$executeRawUnsafe(doBlock as string);
      const d = await evidencePrisma.talentIntakeDraft.findUniqueOrThrow({ where: { id } });
      expect(d.review_status).toBe('IN_REVIEW');
      expect(d.promoted_talent_record_id).toBeNull();
      const rec = await save.promote(auth, id, 'rq');
      expect(await counts(rec.id)).toEqual(EXPECTED);
    });
  },
);
