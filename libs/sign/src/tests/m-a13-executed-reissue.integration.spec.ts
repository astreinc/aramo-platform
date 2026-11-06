import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { PdfLibDocumentRenderingAdapter, type DocumentRenderingPort, type PreparedField } from '@aramo/documents-rendering';

import { PrismaService } from '../index.js';
import { EsignRepository } from '../lib/esign.repository.js';
import { EsignService } from '../lib/esign.service.js';
import { ExecutionService } from '../lib/execution.service.js';
import { findReissueInventory, ExecutedDocumentReissueRefusedError } from '../lib/executed-document-reissue.js';
import { SoftwareEvidenceManifestSigner } from '../lib/ports/evidence-manifest-signer.port.js';
import { EXECUTED_DOCUMENT_REISSUED, EXECUTION_CERTIFICATE_REISSUED } from '../lib/domain/executed-artifact-integrity.js';

// Aramo-Sign-Mobile-Amendment-M-A13 (LOCKED) R-1b on real Postgres 17 with every sign
// migration: an executed document produced with the typed-signature defect (TYPED + an
// image data URL drawn as text) is reissued append-only —
//   - the original ExecutedDocument / ExecutionCertificate rows are kept unchanged;
//   - the corrected copy is rendered from the unchanged stored values (the image now);
//   - EXECUTED_DOCUMENT_REISSUED records old + new SHA-256 and the reason;
//   - the reissued certificate notes the correction and lists both hashes;
//   - a dry run writes nothing; a second apply is already_reissued; the reissue rows
//     are write-once; the evidence manifest still resolves from the ledger.

const ROOT = resolve(__dirname, '../../../..');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const REASON = 'M-A13 R-1b typed signature drawn as text';

function signMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/sign/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}

const hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

// Produce draws a TYPED value as text, exactly as before the fix: the defect state.
class DefectRenderer implements DocumentRenderingPort {
  private readonly real = new PdfLibDocumentRenderingAdapter();
  prepareFromSource(src: Uint8Array, placements: PreparedField[], opts?: Parameters<DocumentRenderingPort['prepareFromSource']>[2]) {
    const asText = placements.map((p) => (p.kind === 'IMAGE' ? { field_key: p.field_key, page_number: p.page_number, x: p.x, y: p.y, value: 'data:image/png;base64,iVBOR' } : p));
    return this.real.prepareFromSource(src, asText, opts);
  }
  renderGenerated(model: Parameters<DocumentRenderingPort['renderGenerated']>[0]) {
    return this.real.renderGenerated(model);
  }
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('M-A13 R-1b corrected reissue — real Postgres 17', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: PrismaService;
  let repo: EsignRepository;
  let sourcePdf: Uint8Array;
  const TENANT = randomUUID();
  const ACTOR = randomUUID();
  const certificateModels: string[] = [];

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await db.query(sql, params)).rows as T[];
  const source = { getSourcePdf: async () => sourcePdf };

  function fixed(): ExecutionService {
    const real = new PdfLibDocumentRenderingAdapter();
    const capturing: DocumentRenderingPort = {
      prepareFromSource: (src, placements, opts) => real.prepareFromSource(src, placements, opts),
      renderGenerated: (model) => {
        certificateModels.push(JSON.stringify(model));
        return real.renderGenerated(model);
      },
    };
    return new ExecutionService(prisma, repo, capturing, source);
  }

  // A COMPLETED envelope whose SIGNATURE was stored TYPED + image and executed as text.
  async function defectiveEnvelope(): Promise<{ envelope_id: string; document_id: string }> {
    const env = await repo.createEnvelope({ tenant_id: TENANT, subject: 'Lease', execution_mode: 'SINGLE_SIGNATURE', created_by: ACTOR });
    const doc = await repo.addDocument({ tenant_id: TENANT, envelope_id: env.id, document_ref: randomUUID(), document_revision_ref: randomUUID(), title: 'lease.pdf', source_sha256: 'seed', ordinal: 1 });
    const signer = await repo.addSigner({ tenant_id: TENANT, envelope_id: env.id, email: 'jane@x.com', name: 'Jane', signing_order: 1 });
    const field = await repo.addField({ tenant_id: TENANT, envelope_document_id: doc.id, signer_id: signer.id, field_type: 'SIGNATURE', page_number: 0, x: 72, y: 120, width: 180, height: 40, required: true });
    await prisma.signatureField.update({ where: { id: field.id }, data: { value: PNG, signature_method: 'TYPED', filled_at: new Date() } });
    await new ExecutionService(prisma, repo, new DefectRenderer(), source).produce(TENANT, env.id);
    await q(`UPDATE "sign"."SignatureEnvelope" SET status = 'COMPLETED', completed_at = now() WHERE id = $1`, [env.id]);
    return { envelope_id: env.id, document_id: doc.id };
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    db = new Client({ connectionString: url });
    await db.connect();
    for (const m of signMigrations()) await db.query(readFileSync(m, 'utf8'));
    prisma = new PrismaService(url);
    await prisma.$connect();
    repo = new EsignRepository(prisma);
    const src = await PDFDocument.create();
    src.addPage([600, 800]);
    sourcePdf = await src.save();
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    await container?.stop();
  });

  it('the read-only inventory counts the affected executed document (ids only)', async () => {
    const { envelope_id, document_id } = await defectiveEnvelope();
    const inv = await findReissueInventory(prisma, { tenant_id: TENANT, envelope_ids: [envelope_id] });
    expect(inv.executed_documents).toBe(1);
    expect(inv.envelopes).toBe(1);
    expect(inv.affected_fields).toBe(1);
    expect(inv.affected[0]).toMatchObject({ envelope_id, envelope_document_id: document_id, purged: false, already_reissued: false });
    expect(JSON.stringify(inv)).not.toContain('data:image');
  });

  it('a dry run renders the corrected copy and writes nothing', async () => {
    const { envelope_id } = await defectiveEnvelope();
    const events = await q(`SELECT count(*)::int AS n FROM "sign"."SignatureEvent" WHERE envelope_id = $1`, [envelope_id]);
    const out = await fixed().reissueCorrected(TENANT, envelope_id, { reason: REASON, apply: false });
    expect(out.status).toBe('dry_run');
    expect(out.documents).toHaveLength(1);
    expect(out.documents[0]?.sha256).not.toBe(out.documents[0]?.original_sha256);
    expect(await q(`SELECT 1 FROM "sign"."ExecutedDocumentReissue" WHERE envelope_id = $1`, [envelope_id])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM "sign"."ExecutionCertificateReissue" WHERE envelope_id = $1`, [envelope_id])).toHaveLength(0);
    expect(await q(`SELECT count(*)::int AS n FROM "sign"."SignatureEvent" WHERE envelope_id = $1`, [envelope_id])).toEqual(events);
  });

  it('apply: original kept, corrected copy kept + served, ledger events, certificate lists both hashes', async () => {
    const { envelope_id, document_id } = await defectiveEnvelope();
    const [before] = await q<{ id: string; executed_sha256: string; executed_bytes: Buffer }>(`SELECT id, executed_sha256, executed_bytes FROM "sign"."ExecutedDocument" WHERE envelope_id = $1`, [envelope_id]);
    const [certBefore] = await q<{ id: string; certificate_sha256: string; certificate_bytes: Buffer }>(`SELECT id, certificate_sha256, certificate_bytes FROM "sign"."ExecutionCertificate" WHERE envelope_id = $1`, [envelope_id]);

    certificateModels.length = 0;
    const out = await fixed().reissueCorrected(TENANT, envelope_id, { reason: REASON, apply: true });
    expect(out.status).toBe('reissued');
    const doc = out.documents[0]!;
    expect(doc).toMatchObject({ envelope_document_id: document_id, original_artifact_id: before!.id, original_sha256: before!.executed_sha256 });
    expect(doc.sha256).not.toBe(before!.executed_sha256);

    // The original rows are unchanged (bytes and hashes).
    const [after] = await q<{ executed_sha256: string; executed_bytes: Buffer }>(`SELECT executed_sha256, executed_bytes FROM "sign"."ExecutedDocument" WHERE id = $1`, [before!.id]);
    expect(after!.executed_sha256).toBe(before!.executed_sha256);
    expect(Buffer.compare(after!.executed_bytes, before!.executed_bytes)).toBe(0);
    const [certAfter] = await q<{ certificate_sha256: string; certificate_bytes: Buffer }>(`SELECT certificate_sha256, certificate_bytes FROM "sign"."ExecutionCertificate" WHERE id = $1`, [certBefore!.id]);
    expect(certAfter!.certificate_sha256).toBe(certBefore!.certificate_sha256);
    expect(Buffer.compare(certAfter!.certificate_bytes, certBefore!.certificate_bytes)).toBe(0);

    // The corrected copy is stored with its own digest.
    const [reissue] = await q<{ executed_sha256: string; executed_bytes: Buffer; original_sha256: string; reason: string }>(`SELECT executed_sha256, executed_bytes, original_sha256, reason FROM "sign"."ExecutedDocumentReissue" WHERE original_executed_document_id = $1`, [before!.id]);
    expect(reissue).toMatchObject({ executed_sha256: doc.sha256, original_sha256: before!.executed_sha256, reason: REASON });
    expect(hex(reissue!.executed_bytes)).toBe(doc.sha256);

    // The ledger records both reissues, old and new hashes, and the reason.
    const events = await q<{ event_type: string; payload: Record<string, unknown> }>(
      `SELECT event_type, payload FROM "sign"."SignatureEvent" WHERE envelope_id = $1 AND event_type IN ($2, $3) ORDER BY occurred_at, id`,
      [envelope_id, EXECUTED_DOCUMENT_REISSUED, EXECUTION_CERTIFICATE_REISSUED],
    );
    expect(events.map((e) => e.event_type)).toEqual([EXECUTED_DOCUMENT_REISSUED, EXECUTION_CERTIFICATE_REISSUED]);
    expect(events[0]?.payload).toMatchObject({ original_sha256: before!.executed_sha256, sha256: doc.sha256, reason: REASON, original_artifact_id: before!.id });
    expect(events[1]?.payload).toMatchObject({ original_sha256: certBefore!.certificate_sha256, sha256: out.certificate!.sha256, reason: REASON });

    // The reissued certificate notes the correction and lists both executed hashes in full.
    const model = certificateModels.at(-1) ?? '';
    expect(model).toContain('Correction');
    expect(model).toContain(before!.executed_sha256);
    expect(model).toContain(doc.sha256);
    expect(model).toContain(certBefore!.certificate_sha256);

    // Downloads serve the corrected copy and the reissued certificate.
    const served = await repo.listExecutedDocuments(TENANT, envelope_id);
    expect(served[0]?.executed_sha256).toBe(doc.sha256);
    expect((await repo.getExecutionCertificate(TENANT, envelope_id))?.certificate_sha256).toBe(out.certificate!.sha256);

    // The evidence manifest still resolves from the ledger (original artifacts).
    const evidence = await new EsignService(prisma, repo, new SoftwareEvidenceManifestSigner()).evidenceManifest(TENANT, envelope_id);
    expect(evidence.manifest.artifact_hash_source).toBe('LEDGER');
    expect(evidence.manifest.executed_sha256).toBe(before!.executed_sha256);

    // Idempotent: a second apply writes nothing.
    expect((await fixed().reissueCorrected(TENANT, envelope_id, { reason: REASON, apply: true })).status).toBe('already_reissued');
    expect(await q(`SELECT 1 FROM "sign"."ExecutedDocumentReissue" WHERE envelope_id = $1`, [envelope_id])).toHaveLength(1);
    expect((await findReissueInventory(prisma, { envelope_ids: [envelope_id] })).affected[0]?.already_reissued).toBe(true);
  });

  it('the reissue rows are write-once (UPDATE and DELETE refused)', async () => {
    const { envelope_id } = await defectiveEnvelope();
    await fixed().reissueCorrected(TENANT, envelope_id, { reason: REASON, apply: true });
    await expect(db.query(`UPDATE "sign"."ExecutedDocumentReissue" SET reason = 'x' WHERE envelope_id = $1`, [envelope_id])).rejects.toThrow(/write-once/);
    await expect(db.query(`DELETE FROM "sign"."ExecutedDocumentReissue" WHERE envelope_id = $1`, [envelope_id])).rejects.toThrow(/write-once/);
    await expect(db.query(`UPDATE "sign"."ExecutionCertificateReissue" SET certificate_sha256 = 'x' WHERE envelope_id = $1`, [envelope_id])).rejects.toThrow(/write-once/);
    await expect(db.query(`DELETE FROM "sign"."ExecutionCertificateReissue" WHERE envelope_id = $1`, [envelope_id])).rejects.toThrow(/write-once/);
  });

  it('refuses an envelope that is not completed; an unaffected envelope is not_affected', async () => {
    const env = await repo.createEnvelope({ tenant_id: TENANT, subject: 'Draft', execution_mode: 'SINGLE_SIGNATURE', created_by: ACTOR });
    await expect(fixed().reissueCorrected(TENANT, env.id, { reason: REASON, apply: true })).rejects.toBeInstanceOf(ExecutedDocumentReissueRefusedError);

    const ok = await repo.createEnvelope({ tenant_id: TENANT, subject: 'Typed', execution_mode: 'SINGLE_SIGNATURE', created_by: ACTOR });
    const doc = await repo.addDocument({ tenant_id: TENANT, envelope_id: ok.id, document_ref: randomUUID(), document_revision_ref: randomUUID(), title: 'a.pdf', source_sha256: 'seed', ordinal: 1 });
    const signer = await repo.addSigner({ tenant_id: TENANT, envelope_id: ok.id, email: 'j@x.com', name: 'J', signing_order: 1 });
    const f = await repo.addField({ tenant_id: TENANT, envelope_document_id: doc.id, signer_id: signer.id, field_type: 'SIGNATURE', page_number: 0, x: 72, y: 120, required: true });
    await prisma.signatureField.update({ where: { id: f.id }, data: { value: 'Jane Doe', signature_method: 'TYPED', filled_at: new Date() } });
    await fixed().produce(TENANT, ok.id);
    await q(`UPDATE "sign"."SignatureEnvelope" SET status = 'COMPLETED', completed_at = now() WHERE id = $1`, [ok.id]);
    expect((await fixed().reissueCorrected(TENANT, ok.id, { reason: REASON, apply: true })).status).toBe('not_affected');
  });
});
