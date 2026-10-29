import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { PdfLibDocumentRenderingAdapter } from '@aramo/documents-rendering';

import { PrismaService } from '../index.js';
import { EsignRepository } from '../lib/esign.repository.js';
import { EsignService } from '../lib/esign.service.js';
import { ExecutionService } from '../lib/execution.service.js';
import { OutboxService } from '../lib/outbox.service.js';
import { type DocumentSourceProviderPort } from '../lib/ports/document-source-provider.port.js';
import { SoftwareEvidenceManifestSigner } from '../lib/ports/evidence-manifest-signer.port.js';
import {
  EXECUTED_ARTIFACT_INTEGRITY_CONFLICT,
  EXECUTED_DOCUMENT_RECORDED,
  EXECUTION_CERTIFICATE_RECORDED,
  ExecutedArtifactIntegrityConflictError,
  ExecutedArtifactLedgerMismatchError,
} from '../lib/domain/executed-artifact-integrity.js';

// Aramo-Sign-Executed-Artifact-Custody-and-Isolation-Directive-v1_0-LOCKED SX-1
// items 1 to 3 on real Postgres 17 with every sign migration:
//   1. insert-only executed artifacts (same-bytes retry idempotent, different
//      bytes refused + recorded, row unchanged, concurrent produce idempotent)
//   2. the write-once triggers (UPDATE / DELETE / TRUNCATE refused; written_back_at
//      and custody_* columns set once, NULL → value)
//   3. the ledger hash record and the ledger-built evidence manifest (every
//      document, fail closed on a ledger/row mismatch, legacy fallback flagged)

const ROOT = resolve(__dirname, '../../../..');

function signMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/sign/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}

const hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('SX-1 executed-artifact integrity — real Postgres 17', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: PrismaService;
  let repo: EsignRepository;
  let service: EsignService;
  let sourcePdf: Uint8Array;
  // A hook the source provider runs after produce's "already kept?" check and
  // before the locked insert: it simulates a writer racing outside the lock.
  let beforeSourceRead: ((envelope_document_id: string | null) => Promise<void>) | null = null;
  let sourceReads = 0;

  const TENANT = randomUUID();
  const ACTOR = randomUUID();

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await db.query(sql, params)).rows as T[];

  function producer(): ExecutionService {
    const source: DocumentSourceProviderPort = {
      getSourcePdf: async (input) => {
        sourceReads += 1;
        if (beforeSourceRead !== null) await beforeSourceRead(input.document_revision_ref ?? null);
        return sourcePdf;
      },
    };
    return new ExecutionService(prisma, repo, new PdfLibDocumentRenderingAdapter(), source, undefined, new OutboxService(prisma));
  }

  // An envelope with two documents and one filled signature field per document.
  // document_revision_ref carries the EnvelopeDocument id so the source hook can
  // name the document being produced.
  async function envelopeWithTwoDocuments(): Promise<{ envelope_id: string; document_ids: string[] }> {
    const env = await repo.createEnvelope({ tenant_id: TENANT, subject: 'Agreement', execution_mode: 'SINGLE_SIGNATURE', created_by: ACTOR });
    const signer = await repo.addSigner({ tenant_id: TENANT, envelope_id: env.id, email: 'jane@x.com', name: 'Jane', signing_order: 1 });
    const document_ids: string[] = [];
    for (const ordinal of [1, 2]) {
      const d = await repo.addDocument({
        tenant_id: TENANT, envelope_id: env.id, document_ref: randomUUID(), document_revision_ref: randomUUID(),
        title: `doc-${ordinal}.pdf`, source_sha256: 'seed', ordinal,
      });
      await db.query(`UPDATE "sign"."EnvelopeDocument" SET document_revision_ref = id WHERE id = $1`, [d.id]);
      const f = await repo.addField({ tenant_id: TENANT, envelope_document_id: d.id, signer_id: signer.id, field_type: 'SIGNATURE', page_number: 0, x: 72, y: 120 + ordinal * 40, required: true });
      await prisma.signatureField.update({ where: { id: f.id }, data: { value: `Jane ${ordinal}`, signature_method: 'TYPED', filled_at: new Date() } });
      document_ids.push(d.id);
    }
    return { envelope_id: env.id, document_ids };
  }

  const ledger = (envelope_id: string) =>
    q<{ event_type: string; payload: Record<string, unknown> }>(
      `SELECT event_type, payload FROM "sign"."SignatureEvent" WHERE envelope_id = $1 AND event_type = ANY($2) ORDER BY occurred_at, id`,
      [envelope_id, [EXECUTED_DOCUMENT_RECORDED, EXECUTION_CERTIFICATE_RECORDED, EXECUTED_ARTIFACT_INTEGRITY_CONFLICT]],
    );

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    db = new Client({ connectionString: url });
    await db.connect();
    for (const m of signMigrations()) await db.query(readFileSync(m, 'utf8'));
    prisma = new PrismaService(url);
    await prisma.$connect();
    repo = new EsignRepository(prisma);
    service = new EsignService(prisma, repo, new SoftwareEvidenceManifestSigner());
    const src = await PDFDocument.create();
    src.setCreationDate(new Date('2001-01-01T00:00:00.000Z'));
    src.setModificationDate(new Date('2001-01-01T00:00:00.000Z'));
    src.addPage([600, 800]);
    sourcePdf = await src.save({ useObjectStreams: false });
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    await container?.stop();
  });

  // ── 1 + 3: insert, ledger record, idempotent retry ─────────────────────────
  it('records one ledger event per executed document and one for the certificate (sha256, byte size, artifact id)', async () => {
    const { envelope_id, document_ids } = await envelopeWithTwoDocuments();
    const results = await producer().produce(TENANT, envelope_id);
    expect(results.map((r) => r.envelope_document_id)).toEqual(document_ids);

    const rows = await q<{ id: string; envelope_document_id: string; executed_sha256: string; byte_size: number; executed_bytes: Buffer }>(
      `SELECT id, envelope_document_id, executed_sha256, byte_size, executed_bytes FROM "sign"."ExecutedDocument" WHERE envelope_id = $1`, [envelope_id],
    );
    const cert = (await q<{ id: string; certificate_sha256: string; byte_size: number }>(`SELECT id, certificate_sha256, byte_size FROM "sign"."ExecutionCertificate" WHERE envelope_id = $1`, [envelope_id]))[0]!;
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(hex(r.executed_bytes)).toBe(r.executed_sha256);

    const events = await ledger(envelope_id);
    expect(events.map((e) => e.event_type)).toEqual([EXECUTED_DOCUMENT_RECORDED, EXECUTED_DOCUMENT_RECORDED, EXECUTION_CERTIFICATE_RECORDED]);
    for (const r of rows) {
      expect(events.find((e) => e.payload['artifact_id'] === r.id)?.payload).toMatchObject({
        artifact_kind: 'EXECUTED_DOCUMENT', envelope_document_id: r.envelope_document_id, sha256: r.executed_sha256, byte_size: r.byte_size,
      });
    }
    expect(events[2]!.payload).toMatchObject({ artifact_kind: 'EXECUTION_CERTIFICATE', artifact_id: cert.id, sha256: cert.certificate_sha256, byte_size: cert.byte_size });
    const outbox = await q(`SELECT 1 FROM "sign"."OutboxEvent" WHERE event_payload->>'envelope_id' = $1`, [envelope_id]);
    expect(outbox).toHaveLength(1);
  });

  it('a same-bytes retry returns the existing artifacts and writes nothing', async () => {
    const { envelope_id } = await envelopeWithTwoDocuments();
    const first = await producer().produce(TENANT, envelope_id);
    const before = await q(`SELECT id, executed_sha256, produced_at FROM "sign"."ExecutedDocument" WHERE envelope_id = $1 ORDER BY id`, [envelope_id]);
    const certBefore = await q(`SELECT id, certificate_sha256, produced_at FROM "sign"."ExecutionCertificate" WHERE envelope_id = $1`, [envelope_id]);
    const eventsBefore = (await q(`SELECT id FROM "sign"."SignatureEvent" WHERE envelope_id = $1`, [envelope_id])).length;

    sourceReads = 0;
    const again = await producer().produce(TENANT, envelope_id);
    expect(again).toEqual(first);
    expect(sourceReads).toBe(0); // nothing rendered again
    expect(await q(`SELECT id, executed_sha256, produced_at FROM "sign"."ExecutedDocument" WHERE envelope_id = $1 ORDER BY id`, [envelope_id])).toEqual(before);
    expect(await q(`SELECT id, certificate_sha256, produced_at FROM "sign"."ExecutionCertificate" WHERE envelope_id = $1`, [envelope_id])).toEqual(certBefore);
    expect((await q(`SELECT id FROM "sign"."SignatureEvent" WHERE envelope_id = $1`, [envelope_id])).length).toBe(eventsBefore);
    expect(await q(`SELECT 1 FROM "sign"."OutboxEvent" WHERE event_payload->>'envelope_id' = $1`, [envelope_id])).toHaveLength(1);
  });

  it('concurrent produce calls are idempotent: one row per artifact, one ledger record each, one outbox event', async () => {
    const { envelope_id } = await envelopeWithTwoDocuments();
    const [a, b] = await Promise.all([producer().produce(TENANT, envelope_id), producer().produce(TENANT, envelope_id)]);
    expect(a).toEqual(b);
    expect(await q(`SELECT 1 FROM "sign"."ExecutedDocument" WHERE envelope_id = $1`, [envelope_id])).toHaveLength(2);
    expect(await q(`SELECT 1 FROM "sign"."ExecutionCertificate" WHERE envelope_id = $1`, [envelope_id])).toHaveLength(1);
    expect((await ledger(envelope_id)).map((e) => e.event_type).sort()).toEqual([EXECUTED_DOCUMENT_RECORDED, EXECUTED_DOCUMENT_RECORDED, EXECUTION_CERTIFICATE_RECORDED]);
    expect(await q(`SELECT 1 FROM "sign"."OutboxEvent" WHERE event_payload->>'envelope_id' = $1`, [envelope_id])).toHaveLength(1);
    // The manifest built from that ledger verifies.
    expect((await service.evidenceManifest(TENANT, envelope_id)).manifest.artifact_hash_source).toBe('LEDGER');
  });

  it('a different-bytes write is refused, recorded in the ledger, and leaves the kept row unchanged', async () => {
    const { envelope_id, document_ids } = await envelopeWithTwoDocuments();
    const target = document_ids[0]!;
    const otherBytes = Buffer.from('%PDF-1.4 a different executed document');
    // A row for the first document appears between produce's pre-check and its
    // locked insert (a writer outside the lock), with different bytes.
    beforeSourceRead = async (envelope_document_id) => {
      if (envelope_document_id !== target) return;
      await db.query(
        `INSERT INTO "sign"."ExecutedDocument" (id, tenant_id, envelope_id, envelope_document_id, source_sha256, executed_sha256, byte_size, executed_bytes)
         VALUES ($1, $2, $3, $4, 'racer', $5, $6, $7)`,
        [randomUUID(), TENANT, envelope_id, target, hex(otherBytes), otherBytes.byteLength, otherBytes],
      );
    };
    try {
      const err = await producer().produce(TENANT, envelope_id).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ExecutedArtifactIntegrityConflictError);
      expect((err as ExecutedArtifactIntegrityConflictError).code).toBe('EXECUTED_ARTIFACT_INTEGRITY_CONFLICT');
      expect((err as ExecutedArtifactIntegrityConflictError).existing_sha256).toBe(hex(otherBytes));
    } finally {
      beforeSourceRead = null;
    }
    const kept = await q<{ executed_sha256: string; executed_bytes: Buffer; source_sha256: string }>(
      `SELECT executed_sha256, executed_bytes, source_sha256 FROM "sign"."ExecutedDocument" WHERE envelope_document_id = $1`, [target],
    );
    expect(kept).toHaveLength(1);
    expect(kept[0]!.executed_sha256).toBe(hex(otherBytes));
    expect(Buffer.compare(kept[0]!.executed_bytes, otherBytes)).toBe(0);
    expect(kept[0]!.source_sha256).toBe('racer');

    const conflicts = (await ledger(envelope_id)).filter((e) => e.event_type === EXECUTED_ARTIFACT_INTEGRITY_CONFLICT);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.payload).toMatchObject({ artifact_kind: 'EXECUTED_DOCUMENT', envelope_document_id: target, existing_sha256: hex(otherBytes) });
    expect(conflicts[0]!.payload['attempted_sha256']).not.toBe(hex(otherBytes));
    // Production stopped: no certificate was produced for a conflicted envelope.
    expect(await q(`SELECT 1 FROM "sign"."ExecutionCertificate" WHERE envelope_id = $1`, [envelope_id])).toHaveLength(0);
  });

  // ── 2: write-once triggers ─────────────────────────────────────────────────
  describe('write-once triggers', () => {
    let envelope_id: string;
    let docId: string;
    let certId: string;

    beforeAll(async () => {
      ({ envelope_id } = await envelopeWithTwoDocuments());
      await producer().produce(TENANT, envelope_id);
      docId = (await q<{ id: string }>(`SELECT id FROM "sign"."ExecutedDocument" WHERE envelope_id = $1 LIMIT 1`, [envelope_id]))[0]!.id;
      certId = (await q<{ id: string }>(`SELECT id FROM "sign"."ExecutionCertificate" WHERE envelope_id = $1`, [envelope_id]))[0]!.id;
    });

    const refused = async (sql: string, params: unknown[], pattern: RegExp): Promise<void> => {
      await expect(db.query(sql, params)).rejects.toThrow(pattern);
    };

    it.each([
      ['executed_bytes', `UPDATE "sign"."ExecutedDocument" SET executed_bytes = decode('00','hex') WHERE id = $1`],
      ['executed_sha256', `UPDATE "sign"."ExecutedDocument" SET executed_sha256 = repeat('0', 64) WHERE id = $1`],
      ['source_sha256', `UPDATE "sign"."ExecutedDocument" SET source_sha256 = 'x' WHERE id = $1`],
      ['byte_size', `UPDATE "sign"."ExecutedDocument" SET byte_size = byte_size + 1 WHERE id = $1`],
      ['tenant_id', `UPDATE "sign"."ExecutedDocument" SET tenant_id = gen_random_uuid() WHERE id = $1`],
      ['envelope_id', `UPDATE "sign"."ExecutedDocument" SET envelope_id = gen_random_uuid() WHERE id = $1`],
      ['envelope_document_id', `UPDATE "sign"."ExecutedDocument" SET envelope_document_id = gen_random_uuid() WHERE id = $1`],
      ['produced_at', `UPDATE "sign"."ExecutedDocument" SET produced_at = now() - interval '1 day' WHERE id = $1`],
    ])('ExecutedDocument: UPDATE of %s is refused', async (col, sql) => {
      await refused(sql, [docId], new RegExp(`column ${col} cannot be changed`));
    });

    it.each([
      ['certificate_bytes', `UPDATE "sign"."ExecutionCertificate" SET certificate_bytes = decode('00','hex') WHERE id = $1`],
      ['certificate_sha256', `UPDATE "sign"."ExecutionCertificate" SET certificate_sha256 = repeat('0', 64) WHERE id = $1`],
      ['byte_size', `UPDATE "sign"."ExecutionCertificate" SET byte_size = 1 WHERE id = $1`],
      ['tenant_id', `UPDATE "sign"."ExecutionCertificate" SET tenant_id = gen_random_uuid() WHERE id = $1`],
      ['envelope_id', `UPDATE "sign"."ExecutionCertificate" SET envelope_id = gen_random_uuid() WHERE id = $1`],
    ])('ExecutionCertificate: UPDATE of %s is refused', async (col, sql) => {
      await refused(sql, [certId], new RegExp(`column ${col} cannot be changed`));
    });

    it('DELETE and TRUNCATE are refused on both tables', async () => {
      await refused(`DELETE FROM "sign"."ExecutedDocument" WHERE id = $1`, [docId], /ExecutedDocument is write-once \(SX-1\): DELETE is rejected/);
      await refused(`DELETE FROM "sign"."ExecutionCertificate" WHERE id = $1`, [certId], /ExecutionCertificate is write-once \(SX-1\): DELETE is rejected/);
      await refused(`TRUNCATE "sign"."ExecutedDocument"`, [], /TRUNCATE is rejected/);
      await refused(`TRUNCATE "sign"."ExecutionCertificate"`, [], /TRUNCATE is rejected/);
      expect(await q(`SELECT 1 FROM "sign"."ExecutedDocument" WHERE id = $1`, [docId])).toHaveLength(1);
    });

    it('Prisma (the app client) cannot update or delete an executed artifact either', async () => {
      await expect(prisma.executedDocument.update({ where: { id: docId }, data: { executed_sha256: 'f'.repeat(64) } })).rejects.toThrow(/write-once/);
      await expect(prisma.executionCertificate.delete({ where: { id: certId } })).rejects.toThrow(/write-once/);
    });

    it('written_back_at may be set once (NULL → value); a second change or a reset is refused', async () => {
      for (const [table, id] of [['ExecutedDocument', docId], ['ExecutionCertificate', certId]] as const) {
        await db.query(`UPDATE "sign"."${table}" SET written_back_at = now() WHERE id = $1`, [id]);
        await refused(`UPDATE "sign"."${table}" SET written_back_at = now() + interval '1 hour' WHERE id = $1`, [id], /set-once column written_back_at is already set/);
        await refused(`UPDATE "sign"."${table}" SET written_back_at = NULL WHERE id = $1`, [id], /set-once column written_back_at is already set/);
        // A no-op write of the same value is not a change.
        await db.query(`UPDATE "sign"."${table}" SET written_back_at = written_back_at WHERE id = $1`, [id]);
      }
    });

    it('a custody_* column (added later, as SX-2 does) is set-once; any other new column is protected', async () => {
      // Test-only columns on this container: the trigger names no custody column.
      await db.query(`ALTER TABLE "sign"."ExecutedDocument" ADD COLUMN "custody_test_version_id" TEXT, ADD COLUMN "sx_test_other" TEXT`);
      await db.query(`UPDATE "sign"."ExecutedDocument" SET custody_test_version_id = 'v1' WHERE id = $1`, [docId]);
      await refused(`UPDATE "sign"."ExecutedDocument" SET custody_test_version_id = 'v2' WHERE id = $1`, [docId], /set-once column custody_test_version_id is already set/);
      await refused(`UPDATE "sign"."ExecutedDocument" SET sx_test_other = 'x' WHERE id = $1`, [docId], /column sx_test_other cannot be changed/);
      // Setting a custody column together with a protected column is refused whole.
      const other = (await q<{ id: string }>(`SELECT id FROM "sign"."ExecutedDocument" WHERE envelope_id = $1 AND id <> $2`, [envelope_id, docId]))[0]!.id;
      await refused(`UPDATE "sign"."ExecutedDocument" SET custody_test_version_id = 'v1', byte_size = 1 WHERE id = $1`, [other], /column byte_size cannot be changed/);
      expect((await q<{ c: string | null }>(`SELECT custody_test_version_id AS c FROM "sign"."ExecutedDocument" WHERE id = $1`, [other]))[0]!.c).toBeNull();
      await db.query(`ALTER TABLE "sign"."ExecutedDocument" DROP COLUMN "custody_test_version_id", DROP COLUMN "sx_test_other"`);
    });
  });

  // ── 3: the manifest is built from the ledger ───────────────────────────────
  it('the evidence manifest lists every executed document hash and the certificate, from the ledger', async () => {
    const { envelope_id, document_ids } = await envelopeWithTwoDocuments();
    await producer().produce(TENANT, envelope_id);
    const signed = await service.evidenceManifest(TENANT, envelope_id);
    const rows = await q<{ envelope_document_id: string; executed_sha256: string; byte_size: number }>(
      `SELECT envelope_document_id, executed_sha256, byte_size FROM "sign"."ExecutedDocument" WHERE envelope_id = $1`, [envelope_id],
    );
    const byDoc = new Map(rows.map((r) => [r.envelope_document_id, r]));
    expect(signed.manifest.artifact_hash_source).toBe('LEDGER');
    expect(signed.manifest.executed_documents?.map((d) => d.envelope_document_id)).toEqual(document_ids);
    expect(signed.manifest.executed_documents?.map((d) => d.sha256)).toEqual(document_ids.map((id) => byDoc.get(id)!.executed_sha256));
    expect(signed.manifest.executed_sha256).toBe(byDoc.get(document_ids[0]!)!.executed_sha256);
    const cert = (await q<{ certificate_sha256: string }>(`SELECT certificate_sha256 FROM "sign"."ExecutionCertificate" WHERE envelope_id = $1`, [envelope_id]))[0]!;
    expect(signed.manifest.certificate?.sha256).toBe(cert.certificate_sha256);
    expect(await new SoftwareEvidenceManifestSigner().verify(signed)).toBe(true);
  });

  it('the manifest fails closed when a row no longer matches its ledger record (trigger bypassed by an owner)', async () => {
    const { envelope_id, document_ids } = await envelopeWithTwoDocuments();
    await producer().produce(TENANT, envelope_id);
    const forged = Buffer.from('%PDF-1.4 forged');
    // Only a superuser / table owner can do this; SX-1 item 6 removes that from the runtime role.
    await db.query(`ALTER TABLE "sign"."ExecutedDocument" DISABLE TRIGGER executed_document_write_once`);
    try {
      await db.query(`UPDATE "sign"."ExecutedDocument" SET executed_bytes = $1, executed_sha256 = $2, byte_size = $3 WHERE envelope_document_id = $4`, [
        forged, hex(forged), forged.byteLength, document_ids[1],
      ]);
    } finally {
      await db.query(`ALTER TABLE "sign"."ExecutedDocument" ENABLE TRIGGER executed_document_write_once`);
    }
    const err = await service.evidenceManifest(TENANT, envelope_id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecutedArtifactLedgerMismatchError);
    expect((err as ExecutedArtifactLedgerMismatchError).reason).toBe('hash_mismatch');
    expect((err as ExecutedArtifactLedgerMismatchError).code).toBe('EXECUTED_ARTIFACT_LEDGER_MISMATCH');
  });

  it('the manifest fails closed when stored bytes were swapped under an unchanged hash', async () => {
    const { envelope_id } = await envelopeWithTwoDocuments();
    await producer().produce(TENANT, envelope_id);
    await db.query(`ALTER TABLE "sign"."ExecutionCertificate" DISABLE TRIGGER execution_certificate_write_once`);
    try {
      await db.query(`UPDATE "sign"."ExecutionCertificate" SET certificate_bytes = decode('00','hex') WHERE envelope_id = $1`, [envelope_id]);
    } finally {
      await db.query(`ALTER TABLE "sign"."ExecutionCertificate" ENABLE TRIGGER execution_certificate_write_once`);
    }
    const err = await service.evidenceManifest(TENANT, envelope_id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecutedArtifactLedgerMismatchError);
    expect((err as ExecutedArtifactLedgerMismatchError).reason).toBe('bytes_digest_mismatch');
  });

  it('an envelope completed before SX-1 (rows, no ledger record) gets row hashes, flagged LEGACY_UNLEDGERED_ROW', async () => {
    const { envelope_id, document_ids } = await envelopeWithTwoDocuments();
    const pdf = Buffer.from('%PDF-1.4 legacy executed');
    const certBytes = Buffer.from('%PDF-1.4 legacy certificate');
    for (const id of document_ids) {
      await db.query(
        `INSERT INTO "sign"."ExecutedDocument" (id, tenant_id, envelope_id, envelope_document_id, source_sha256, executed_sha256, byte_size, executed_bytes) VALUES (gen_random_uuid(), $1, $2, $3, 'legacy-src', $4, $5, $6)`,
        [TENANT, envelope_id, id, hex(pdf), pdf.byteLength, pdf],
      );
    }
    await db.query(
      `INSERT INTO "sign"."ExecutionCertificate" (id, tenant_id, envelope_id, certificate_sha256, byte_size, certificate_bytes) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
      [TENANT, envelope_id, hex(certBytes), certBytes.byteLength, certBytes],
    );
    const signed = await service.evidenceManifest(TENANT, envelope_id);
    expect(signed.manifest.artifact_hash_source).toBe('LEGACY_UNLEDGERED_ROW');
    expect(signed.manifest.executed_documents).toHaveLength(2);
    expect(signed.manifest.certificate?.sha256).toBe(hex(certBytes));
  });

  it('an envelope with nothing produced yet → NONE', async () => {
    const { envelope_id } = await envelopeWithTwoDocuments();
    const signed = await service.evidenceManifest(TENANT, envelope_id);
    expect(signed.manifest.artifact_hash_source).toBe('NONE');
    expect(signed.manifest.executed_documents).toEqual([]);
    expect(signed.manifest.executed_sha256).toBeNull();
  });
});
