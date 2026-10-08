import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

// Talent Draft Recovery UX/IA — server authority proof (Slice 2, G1 + G2).
// Against a real Postgres 17, at the repository WHERE boundary (where the
// security invariant lives, not a pre-read check):
//   (1) actor-private ownership — a draft started by recruiter A is invisible
//       and unmutable to recruiter B BY ID, regardless of B's role (the query
//       filters ONLY on created_by; there is no role-widening branch). (§2.2)
//   (2) last_touched_at touch semantics — set on creation, bumped by recruiter
//       review/retry, NEVER by background extraction or by an open. (§22)

const ROOT = resolve(__dirname, '../../../..');
const MIGRATION_LIBS = ['documents', 'talent-evidence'];

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

// Dollar-quote / comment / string-literal aware splitter (documents carries
// `$$`-quoted trigger bodies). Only splits on a top-level `;`.
function splitDdl(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;
  let dollarTag: string | null = null;
  while (i < sql.length) {
    const ch = sql[i];
    if (dollarTag === null && ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      if (nl === -1) break;
      current += '\n';
      i = nl + 1;
      continue;
    }
    if (ch === '$') {
      const m = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (m !== null) {
        const tag = m[0];
        if (dollarTag === null) {
          dollarTag = tag;
          current += tag;
          i += tag.length;
          continue;
        }
        if (dollarTag === tag) {
          dollarTag = null;
          current += tag;
          i += tag.length;
          continue;
        }
      }
    }
    if (dollarTag === null && ch === "'") {
      current += ch;
      i += 1;
      while (i < sql.length) {
        current += sql[i];
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            current += sql[i + 1];
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
    if (dollarTag === null && ch === ';') {
      const trimmed = current.trim();
      if (trimmed.length > 0) statements.push(trimmed);
      current = '';
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  const last = current.trim();
  if (last.length > 0) statements.push(last);
  return statements;
}

const TENANT = '11111111-1111-7111-8111-111111111111';
const RECRUITER_A = '22222222-2222-7222-8222-222222222222';
// RECRUITER_B stands in for ANY other actor in the tenant, including one who
// also holds a manager role — the repository has no role branch, so visibility
// is strictly created_by (§2.2 "applies even when the recruiter also has a
// manager role").
const RECRUITER_B = '33333333-3333-7333-8333-333333333333';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Talent Draft Recovery — actor-private ownership + touch semantics (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: EvidencePrismaService;
    let repo: TalentEvidenceRepository;

    async function seedUploadDraft(createdBy: string): Promise<string> {
      const id = uuidv7();
      await repo.createTalentIntakeDraft({
        id,
        tenant_id: TENANT,
        created_by: createdBy,
        source_type: 'RESUME_UPLOAD',
        source_filename: 'resume.pdf',
        storage_key: `tenant/${TENANT}/${id}/resume.pdf`,
        mime_type: 'application/pdf',
      });
      return id;
    }

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

      prisma = new EvidencePrismaService(url);
      await prisma.$connect();
      repo = new TalentEvidenceRepository(prisma);
    }, 180_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    beforeEach(async () => {
      await prisma.talentIntakeDraft.deleteMany({ where: { tenant_id: TENANT } });
    });

    // ---- (1) actor-private ownership --------------------------------------

    it('findById by owner returns the row; by another actor (any role) returns null', async () => {
      const id = await seedUploadDraft(RECRUITER_A);

      const asOwner = await repo.findTalentIntakeDraftById({ tenant_id: TENANT, id, created_by: RECRUITER_A });
      expect(asOwner).not.toBeNull();
      expect(asOwner?.id).toBe(id);

      const asOther = await repo.findTalentIntakeDraftById({ tenant_id: TENANT, id, created_by: RECRUITER_B });
      expect(asOther).toBeNull(); // service 404s on null — existence not leaked
    });

    it('list is scoped to the creator — B never sees A drafts', async () => {
      await seedUploadDraft(RECRUITER_A);
      await seedUploadDraft(RECRUITER_A);
      await seedUploadDraft(RECRUITER_B);

      const aList = await repo.listTalentIntakeDraftsForCreator({ tenant_id: TENANT, created_by: RECRUITER_A, limit: 100 });
      const bList = await repo.listTalentIntakeDraftsForCreator({ tenant_id: TENANT, created_by: RECRUITER_B, limit: 100 });
      expect(aList).toHaveLength(2);
      expect(bList).toHaveLength(1);
    });

    it('saveReview / markPromoted by a non-owner mutate ZERO rows (write-boundary enforcement)', async () => {
      const id = await seedUploadDraft(RECRUITER_A);
      const row = await repo.findTalentIntakeDraftById({ tenant_id: TENANT, id, created_by: RECRUITER_A });
      const version = row!.version;

      const byOther = await repo.saveTalentIntakeDraftReview({
        tenant_id: TENANT,
        id,
        created_by: RECRUITER_B,
        expected_version: version,
        review_payload: { fields: { first_name: { value: 'Hijack', origin: 'RECRUITER' } } },
      });
      expect(byOther).toBe(0); // no row updated

      const promoteByOther = await repo.markTalentIntakeDraftPromoted({
        tenant_id: TENANT,
        id,
        created_by: RECRUITER_B,
        promoted_talent_record_id: uuidv7(),
        promoted_at: new Date(),
      });
      expect(promoteByOther).toBe(0);

      // The owner's view is unchanged.
      const after = await repo.findTalentIntakeDraftById({ tenant_id: TENANT, id, created_by: RECRUITER_A });
      expect(after?.version).toBe(version);
      expect(after?.review_status).toBe('NOT_STARTED');
      expect(after?.promoted_talent_record_id).toBeNull();
    });

    // ---- (2) last_touched_at touch semantics ------------------------------

    it('creation sets last_touched_at', async () => {
      const id = await seedUploadDraft(RECRUITER_A);
      const row = await repo.findTalentIntakeDraftById({ tenant_id: TENANT, id, created_by: RECRUITER_A });
      expect(row?.last_touched_at).not.toBeNull();
    });

    it('recruiter review bumps last_touched_at; background extraction does NOT; open does NOT', async () => {
      const id = await seedUploadDraft(RECRUITER_A);
      const created = await repo.findTalentIntakeDraftById({ tenant_id: TENANT, id, created_by: RECRUITER_A });
      const t0 = created!.last_touched_at!.getTime();

      // Background extraction result (system path, no created_by) must NOT touch.
      await repo.markTalentIntakeDraftProcessed({
        tenant_id: TENANT,
        id,
        processing_status: 'READY',
        processing_completed_at: new Date(),
      });
      const afterExtract = await repo.findTalentIntakeDraftById({ tenant_id: TENANT, id, created_by: RECRUITER_A });
      expect(afterExtract!.last_touched_at!.getTime()).toBe(t0); // unchanged

      // An open updates last_opened_at only, not last_touched_at.
      await repo.touchTalentIntakeDraftOpened({ tenant_id: TENANT, id, created_by: RECRUITER_A });
      const afterOpen = await repo.findTalentIntakeDraftById({ tenant_id: TENANT, id, created_by: RECRUITER_A });
      expect(afterOpen!.last_touched_at!.getTime()).toBe(t0); // unchanged
      expect(afterOpen!.last_opened_at).not.toBeNull();

      // A recruiter review edit IS a touch — bumps last_touched_at forward.
      await repo.saveTalentIntakeDraftReview({
        tenant_id: TENANT,
        id,
        created_by: RECRUITER_A,
        expected_version: afterOpen!.version,
        review_payload: { fields: { first_name: { value: 'Uma', origin: 'RECRUITER' } } },
      });
      const afterReview = await repo.findTalentIntakeDraftById({ tenant_id: TENANT, id, created_by: RECRUITER_A });
      expect(afterReview!.last_touched_at!.getTime()).toBeGreaterThanOrEqual(t0);
      expect(afterReview!.last_touched_at!.getTime()).not.toBe(afterExtract!.last_touched_at!.getTime());
    });

    // ---- (3) discard (§18) ------------------------------------------------

    it('discard is actor-owned, hard-deletes the row, and refuses a promoted draft', async () => {
      const id = await seedUploadDraft(RECRUITER_A);

      // Non-owner discard is a no-op.
      expect(await repo.deleteTalentIntakeDraft({ tenant_id: TENANT, id, created_by: RECRUITER_B })).toBe(0);
      expect(await repo.findTalentIntakeDraftById({ tenant_id: TENANT, id })).not.toBeNull();

      // Owner discard removes the row.
      expect(await repo.deleteTalentIntakeDraft({ tenant_id: TENANT, id, created_by: RECRUITER_A })).toBe(1);
      expect(await repo.findTalentIntakeDraftById({ tenant_id: TENANT, id })).toBeNull();

      // A promoted draft (a Talent now) cannot be discarded.
      const promotedId = await seedUploadDraft(RECRUITER_A);
      await repo.markTalentIntakeDraftPromoted({
        tenant_id: TENANT,
        id: promotedId,
        created_by: RECRUITER_A,
        promoted_talent_record_id: uuidv7(),
        promoted_at: new Date(),
      });
      expect(await repo.deleteTalentIntakeDraft({ tenant_id: TENANT, id: promotedId, created_by: RECRUITER_A })).toBe(0);
      expect(await repo.findTalentIntakeDraftById({ tenant_id: TENANT, id: promotedId })).not.toBeNull();
    });

    // ---- (4) replace résumé (§13) -----------------------------------------

    it('replace swaps the artifact, resets to UPLOADED, clears failure, bumps touch; owner-scoped; refuses promoted', async () => {
      const id = await seedUploadDraft(RECRUITER_A);
      // Drive it to a FAILED terminal state (the state where Replace is offered).
      await repo.markTalentIntakeDraftProcessed({
        tenant_id: TENANT,
        id,
        processing_status: 'FAILED',
        failure_detail: 'Could not read this résumé.',
        processing_completed_at: new Date(),
      });
      const failed = await repo.findTalentIntakeDraftById({ tenant_id: TENANT, id, created_by: RECRUITER_A });
      const oldKey = failed!.storage_key;
      const t0 = failed!.last_touched_at!.getTime();

      // Non-owner replace is a no-op.
      expect(
        await repo.replaceTalentIntakeDraftArtifact({
          tenant_id: TENANT, id, created_by: RECRUITER_B,
          storage_key: 'hijack-key', source_filename: 'x.pdf', mime_type: 'application/pdf',
        }),
      ).toBe(0);

      // Owner replace swaps + resets.
      const newKey = `tenant/${TENANT}/${id}/replaced.pdf`;
      expect(
        await repo.replaceTalentIntakeDraftArtifact({
          tenant_id: TENANT, id, created_by: RECRUITER_A,
          storage_key: newKey, source_filename: 'replaced.pdf', mime_type: 'application/pdf',
        }),
      ).toBe(1);
      const replaced = await repo.findTalentIntakeDraftById({ tenant_id: TENANT, id, created_by: RECRUITER_A });
      expect(replaced!.storage_key).toBe(newKey);
      expect(replaced!.storage_key).not.toBe(oldKey);
      expect(replaced!.processing_status).toBe('UPLOADED'); // re-queueable via complete-upload
      expect(replaced!.failure_detail).toBeNull(); // prior failure cleared
      expect(replaced!.last_touched_at!.getTime()).toBeGreaterThanOrEqual(t0); // recruiter touch

      // A promoted draft cannot be replaced.
      const promotedId = await seedUploadDraft(RECRUITER_A);
      await repo.markTalentIntakeDraftPromoted({
        tenant_id: TENANT, id: promotedId, created_by: RECRUITER_A,
        promoted_talent_record_id: uuidv7(), promoted_at: new Date(),
      });
      expect(
        await repo.replaceTalentIntakeDraftArtifact({
          tenant_id: TENANT, id: promotedId, created_by: RECRUITER_A,
          storage_key: 'k', source_filename: 'f.pdf', mime_type: 'application/pdf',
        }),
      ).toBe(0);
    });
  },
);
