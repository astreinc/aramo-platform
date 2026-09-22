import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// DOC-1b boundary 1 — TalentDocument -> documents.Document backfill, proven on
// real Postgres 17. The DOC-1b migration is cross-schema (writes documents.*),
// so the documents schema is migrated first. TalentDocuments are seeded BEFORE
// the DOC-1b migration so the backfill has rows to reconcile.

const ROOT = resolve(__dirname, '../../../..');
const DOC1B = '20260922120000_doc1b_talentdocument_reconciliation';

function migrations(libDir: string): { name: string; sql: string }[] {
  const dir = resolve(ROOT, libDir, 'prisma/migrations');
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => ({ name: n, sql: readFileSync(resolve(dir, n, 'migration.sql'), 'utf8') }));
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('DOC-1b TalentDocument reconciliation — real Postgres 17', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;

  const TENANT = randomUUID();
  const ACTOR = randomUUID();
  const TALENT_A = randomUUID();
  const TALENT_B = randomUUID();
  const TD_RESUME = randomUUID();
  const TD_COVER = randomUUID();

  async function seedTalentDocument(id: string, talentId: string, type: string, filename: string, storageRef: string, active: boolean) {
    await db.query(
      `INSERT INTO "talent_evidence"."TalentDocument"
         (id, talent_id, tenant_id, uploaded_by_actor_id, uploaded_at, document_type, filename, file_storage_ref, mime_type, size_bytes, parse_status, consent_scope_at_upload, retention_policy, is_active)
       VALUES ($1,$2,$3,$4, now(), $5, $6, $7, 'application/pdf', 2048, 'parsed', '{}', 'default', $8)`,
      [id, talentId, TENANT, ACTOR, type, filename, storageRef, active],
    );
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17').start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    // documents schema first (DOC-1b writes into it).
    for (const m of migrations('libs/documents')) await db.query(m.sql);
    // talent-evidence migrations EXCEPT DOC-1b.
    for (const m of migrations('libs/talent-evidence')) {
      if (!m.name.includes(DOC1B)) await db.query(m.sql);
    }
    // Seed pre-existing TalentDocuments (the prod rows the backfill reconciles).
    await seedTalentDocument(TD_RESUME, TALENT_A, 'resume', 'jane-resume.pdf', 'tenant/talent/jane/resume/k1', true);
    await seedTalentDocument(TD_COVER, TALENT_B, 'cover_letter', 'bob-cover.pdf', 'tenant/talent/bob/cover/k2', false);
    // Apply the DOC-1b migration (seed DocumentTypes + ADD document_id + backfill).
    const doc1b = migrations('libs/talent-evidence').find((m) => m.name.includes(DOC1B));
    if (doc1b === undefined) throw new Error('DOC-1b migration not found');
    await db.query(doc1b.sql);
  }, 120_000);

  afterAll(async () => {
    await db?.end();
    await container?.stop();
  });

  it('seeds exactly the six SYSTEM DocumentTypes', async () => {
    const r = await db.query(`SELECT key FROM "documents"."DocumentType" WHERE scope = 'SYSTEM' AND tenant_id IS NULL ORDER BY key`);
    expect(r.rows.map((x) => x.key)).toEqual([
      'TALENT_CERTIFICATION',
      'TALENT_COVER_LETTER',
      'TALENT_OTHER',
      'TALENT_REFERENCE_LETTER',
      'TALENT_RESUME',
      'TALENT_WORK_SAMPLE',
    ]);
  });

  it('backfills document_id on every TalentDocument, preserving TalentDocument.id', async () => {
    const r = await db.query(`SELECT id, document_id FROM "talent_evidence"."TalentDocument" ORDER BY id`);
    expect(r.rowCount).toBe(2);
    for (const row of r.rows) expect(row.document_id).not.toBeNull();
    // The stable id is preserved (the row we seeded is still addressable by it).
    const byId = await db.query(`SELECT document_id FROM "talent_evidence"."TalentDocument" WHERE id = $1`, [TD_RESUME]);
    expect(byId.rowCount).toBe(1);
    expect(byId.rows[0].document_id).not.toBeNull();
  });

  it('backfills a canonical Document with mapped fields + type', async () => {
    const r = await db.query(
      `SELECT d.title, d.status, d.execution_mode, d.source_kind, d.created_by, dt.key
       FROM "talent_evidence"."TalentDocument" td
       JOIN "documents"."Document" d ON d.id = td.document_id
       JOIN "documents"."DocumentType" dt ON dt.id = d.document_type_id
       WHERE td.id = $1`,
      [TD_RESUME],
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0]).toMatchObject({
      title: 'jane-resume.pdf',
      status: 'EXECUTED',
      execution_mode: 'NO_SIGNATURE',
      source_kind: 'UPLOADED',
      created_by: ACTOR,
      key: 'TALENT_RESUME',
    });
    // Inactive TalentDocument -> VOIDED Document; type maps to cover letter.
    const inactive = await db.query(
      `SELECT d.status, dt.key FROM "talent_evidence"."TalentDocument" td
       JOIN "documents"."Document" d ON d.id = td.document_id
       JOIN "documents"."DocumentType" dt ON dt.id = d.document_type_id
       WHERE td.id = $1`,
      [TD_COVER],
    );
    expect(inactive.rows[0]).toMatchObject({ status: 'VOIDED', key: 'TALENT_COVER_LETTER' });
  });

  it('backfills a SOURCE_UPLOAD artifact carrying the S3 ref, on a revision of the same document', async () => {
    const r = await db.query(
      `SELECT a.artifact_role, a.storage_locator, a.storage_provider, a.byte_size, r.revision_number, r.document_id AS rev_doc, a.document_id AS art_doc
       FROM "talent_evidence"."TalentDocument" td
       JOIN "documents"."DocumentArtifact" a ON a.document_id = td.document_id
       JOIN "documents"."DocumentRevision" r ON r.id = a.revision_id
       WHERE td.id = $1`,
      [TD_RESUME],
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0]).toMatchObject({
      artifact_role: 'SOURCE_UPLOAD',
      storage_locator: 'tenant/talent/jane/resume/k1',
      storage_provider: 'aramo-s3',
      byte_size: 2048,
      revision_number: 1,
    });
    // The artifact->revision->document invariant holds (trigger accepted it).
    expect(r.rows[0].rev_doc).toBe(r.rows[0].art_doc);
  });

  it('INVARIANT — every TalentDocument.document_id resolves to exactly one canonical Document', async () => {
    // No dangling: every TalentDocument has a non-null document_id AND a matching
    // documents.Document (document_id → Document.id, which is the PK ⇒ at most one).
    const dangling = await db.query(
      `SELECT count(*)::int AS n FROM "talent_evidence"."TalentDocument" td
         LEFT JOIN "documents"."Document" d ON d.id = td.document_id
        WHERE td.document_id IS NULL OR d.id IS NULL`,
    );
    expect(dangling.rows[0].n).toBe(0);
    // Exactly one: the join yields precisely one Document per TalentDocument.
    const counts = await db.query(
      `SELECT td.id, count(d.id)::int AS n
         FROM "talent_evidence"."TalentDocument" td
         JOIN "documents"."Document" d ON d.id = td.document_id
        GROUP BY td.id`,
    );
    expect(counts.rowCount).toBe(2);
    for (const row of counts.rows) expect(row.n).toBe(1);
  });

  it('backfills a TALENT/SUBJECT association pointing at the talent_id', async () => {
    const r = await db.query(
      `SELECT resource_type, resource_id, relationship
       FROM "talent_evidence"."TalentDocument" td
       JOIN "documents"."DocumentAssociation" assoc ON assoc.document_id = td.document_id
       WHERE td.id = $1`,
      [TD_RESUME],
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0]).toMatchObject({ resource_type: 'TALENT', resource_id: TALENT_A, relationship: 'SUBJECT' });
  });
});
