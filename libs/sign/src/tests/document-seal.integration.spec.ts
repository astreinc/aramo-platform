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
import { ExecutionService } from '../lib/execution.service.js';
import { OutboxService } from '../lib/outbox.service.js';
import { verifyEventChain } from '../lib/hash-chain.js';
import { DocumentSealService, EXECUTED_DOCUMENT_SEALED, MAX_SEAL_ATTEMPTS, sealedPdfBytes } from '../lib/document-seal/document-seal.service.js';
import { type DocumentSourceProviderPort } from '../lib/ports/document-source-provider.port.js';

import { SelfSignedTestSealProvider, verifySealedPdf } from './fixtures/self-signed-seal-provider.js';

// Feature-Parity Directive v1.0 §1.15 — the PAdES document seal on the completion path,
// on real Postgres with every sign migration:
//   - a newly executed document is sealed before the certificate; the ExecutedDocument
//     row and executed_sha256 are unchanged; the sealed copy (executed || seal_tail)
//     validates cryptographically with the TEST certificate;
//   - EXECUTED_DOCUMENT_SEALED is in the hash-chained ledger and the certificate notes it;
//   - a failed seal never blocks completion: PENDING with backoff, retried by the job;
//   - dark: no provider = no seal row, no ledger event, no certificate line;
//   - the write-once trigger (SEALED frozen; DELETE refused; purge may NULL seal_tail).

const ROOT = resolve(__dirname, '../../../..');

function signMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/sign/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}

const hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('§1.15 document seal — real Postgres', () => {
  let container: StartedPostgreSqlContainer | null = null;
  let db: Client;
  let prisma: PrismaService;
  let repo: EsignRepository;
  let sourcePdf: Uint8Array;
  const TENANT = randomUUID();
  const ACTOR = randomUUID();

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await db.query(sql, params)).rows as T[];

  // The certificate's text blocks by envelope (the rendered PDF content is compressed).
  const certificateBlocks = new Map<string, string>();
  function producer(sealer?: DocumentSealService): ExecutionService {
    const source: DocumentSourceProviderPort = { getSourcePdf: async () => sourcePdf };
    const rendering = new PdfLibDocumentRenderingAdapter();
    const renderGenerated = rendering.renderGenerated.bind(rendering);
    rendering.renderGenerated = async (input) => {
      const heading = input.blocks.find((b) => b.type === 'HEADING')?.text ?? '';
      certificateBlocks.set(heading.replace('Envelope ', ''), input.blocks.map((b) => ('text' in b ? String(b.text) : '')).join('\n'));
      return renderGenerated(input);
    };
    return new ExecutionService(prisma, repo, rendering, source, undefined, new OutboxService(prisma), undefined, undefined, undefined, undefined, undefined, sealer);
  }

  async function completedEnvelope(): Promise<{ envelope_id: string; document_id: string }> {
    const env = await repo.createEnvelope({ tenant_id: TENANT, subject: 'Agreement', execution_mode: 'SINGLE_SIGNATURE', created_by: ACTOR });
    const signer = await repo.addSigner({ tenant_id: TENANT, envelope_id: env.id, email: 'jane@x.com', name: 'Jane', signing_order: 1 });
    const d = await repo.addDocument({ tenant_id: TENANT, envelope_id: env.id, document_ref: randomUUID(), document_revision_ref: randomUUID(), title: 'doc.pdf', source_sha256: 'seed', ordinal: 1 });
    const f = await repo.addField({ tenant_id: TENANT, envelope_document_id: d.id, signer_id: signer.id, field_type: 'SIGNATURE', page_number: 0, x: 72, y: 160, required: true });
    await prisma.signatureField.update({ where: { id: f.id }, data: { value: 'Jane', signature_method: 'TYPED', filled_at: new Date() } });
    return { envelope_id: env.id, document_id: d.id };
  }

  async function certificateText(envelope_id: string): Promise<string> {
    return certificateBlocks.get(envelope_id) ?? '';
  }

  beforeAll(async () => {
    // ARAMO_SEAL_TEST_DATABASE_URL: an empty local database instead of a container.
    let url = process.env['ARAMO_SEAL_TEST_DATABASE_URL'];
    if (url === undefined) {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      url = container.getConnectionUri();
    }
    db = new Client({ connectionString: url });
    await db.connect();
    for (const m of signMigrations()) await db.query(readFileSync(m, 'utf8'));
    prisma = new PrismaService(url);
    await prisma.$connect();
    repo = new EsignRepository(prisma);
    const src = await PDFDocument.create();
    src.addPage([600, 800]);
    sourcePdf = await src.save({ useObjectStreams: false });
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    await container?.stop();
  });

  it('seals a newly executed document before the certificate; the executed row is unchanged and the sealed copy validates', async () => {
    const provider = new SelfSignedTestSealProvider();
    const sealer = new DocumentSealService(prisma, repo, provider, null);
    const { envelope_id, document_id } = await completedEnvelope();
    const [result] = await producer(sealer).produce(TENANT, envelope_id);

    const [doc] = await q<{ id: string; executed_sha256: string; executed_bytes: Buffer; byte_size: number }>(`SELECT id, executed_sha256, executed_bytes, byte_size FROM "sign"."ExecutedDocument" WHERE envelope_document_id = $1`, [document_id]);
    expect(doc?.executed_sha256).toBe(result?.executed_sha256);
    expect(hex(doc?.executed_bytes ?? Buffer.alloc(0))).toBe(doc?.executed_sha256);

    const [seal] = await q<{ status: string; seal_level: string; sealed_sha256: string; sealed_byte_size: number; seal_tail: Buffer; executed_sha256: string; attempts: number; provider: string }>(`SELECT * FROM "sign"."ExecutedDocumentSeal" WHERE executed_document_id = $1`, [doc?.id]);
    expect(seal?.status).toBe('SEALED');
    expect(seal?.seal_level).toBe('PAdES-B-B');
    expect(seal?.provider).toBe('test-self-signed');
    expect(seal?.executed_sha256).toBe(doc?.executed_sha256);
    const sealed = sealedPdfBytes(doc?.executed_bytes ?? Buffer.alloc(0), seal?.seal_tail ?? Buffer.alloc(0));
    expect(hex(sealed)).toBe(seal?.sealed_sha256);
    expect(sealed.length).toBe(seal?.sealed_byte_size);
    verifySealedPdf(sealed, (await provider.identity()).certificate_der);

    // Ledger: the seal event links executed -> sealed, and the chain still verifies.
    const events = await q<{ event_type: string; payload: Record<string, unknown> }>(`SELECT event_type, payload FROM "sign"."SignatureEvent" WHERE envelope_id = $1 ORDER BY occurred_at, id`, [envelope_id]);
    const sealedEvent = events.find((e) => e.event_type === EXECUTED_DOCUMENT_SEALED);
    expect(sealedEvent?.payload['executed_sha256']).toBe(doc?.executed_sha256);
    expect(sealedEvent?.payload['sha256']).toBe(seal?.sealed_sha256);
    const types = events.map((e) => e.event_type);
    expect(types.indexOf(EXECUTED_DOCUMENT_SEALED)).toBeLessThan(types.indexOf('EXECUTION_CERTIFICATE_RECORDED'));
    const chain = await prisma.signatureEvent.findMany({ where: { tenant_id: TENANT, envelope_id }, orderBy: [{ occurred_at: 'asc' }, { id: 'asc' }] });
    const verification = verifyEventChain(
      chain.map((e) => ({ id: e.id, previous_event_hash: e.previous_event_hash, event_hash: e.event_hash, envelope_id: e.envelope_id, event_type: e.event_type, actor_type: e.actor_type, actor_ref: e.actor_ref, payload: e.payload, occurred_at: e.occurred_at.toISOString() })),
      [],
    );
    expect(verification.broken).toEqual([]);
    expect(await certificateText(envelope_id)).toContain('document seal: PAdES-B-B');

    // Write-once once SEALED: no change, no delete; purge may only NULL the tail.
    await expect(db.query(`UPDATE "sign"."ExecutedDocumentSeal" SET sealed_sha256 = 'x' WHERE executed_document_id = $1`, [doc?.id])).rejects.toThrow(/write-once/);
    await expect(db.query(`UPDATE "sign"."ExecutedDocumentSeal" SET seal_tail = NULL WHERE executed_document_id = $1`, [doc?.id])).rejects.toThrow();
    await expect(db.query(`DELETE FROM "sign"."ExecutedDocumentSeal" WHERE executed_document_id = $1`, [doc?.id])).rejects.toThrow(/append-only/);
    await db.query(`UPDATE "sign"."ExecutedDocumentSeal" SET seal_tail = NULL, purged_at = now() WHERE executed_document_id = $1`, [doc?.id]);
  });

  it('a failed seal never blocks completion: PENDING with backoff, then sealed by the retry job', async () => {
    const provider = new SelfSignedTestSealProvider();
    const realSign = provider.signDigest.bind(provider);
    provider.signDigest = async () => {
      throw Object.assign(new Error('vendor down'), { name: 'SealProviderHttpError' });
    };
    let now = new Date('2026-11-01T10:00:00.000Z');
    const sealer = new DocumentSealService(prisma, repo, provider, null, () => now);
    const { envelope_id, document_id } = await completedEnvelope();
    await producer(sealer).produce(TENANT, envelope_id);

    const row = async () => (await q<{ status: string; attempts: number; last_error: string | null; next_attempt_at: Date | null }>(`SELECT s.* FROM "sign"."ExecutedDocumentSeal" s WHERE envelope_document_id = $1`, [document_id]))[0];
    expect((await q(`SELECT 1 FROM "sign"."ExecutionCertificate" WHERE envelope_id = $1`, [envelope_id])).length).toBe(1);
    expect(await certificateText(envelope_id)).toContain('document seal: pending');
    expect((await row())?.status).toBe('PENDING');
    expect((await row())?.attempts).toBe(1);
    expect((await row())?.last_error).toBe('SealProviderHttpError');

    // Not yet due: the job skips it.
    expect((await sealer.retryDue()).attempted).toBe(0);
    now = new Date(now.getTime() + 61_000);
    provider.signDigest = realSign;
    const r = await sealer.retryDue();
    expect(r.sealed).toBeGreaterThanOrEqual(1);
    expect((await row())?.status).toBe('SEALED');
    const events = await q(`SELECT 1 FROM "sign"."SignatureEvent" WHERE envelope_id = $1 AND event_type = $2`, [envelope_id, EXECUTED_DOCUMENT_SEALED]);
    expect(events).toHaveLength(1);
    // A second run does nothing more.
    await sealer.retryDue();
    expect(await q(`SELECT 1 FROM "sign"."SignatureEvent" WHERE envelope_id = $1 AND event_type = $2`, [envelope_id, EXECUTED_DOCUMENT_SEALED])).toHaveLength(1);
  });

  it(`gives up after ${MAX_SEAL_ATTEMPTS} attempts (FAILED); the unsealed executed document remains the record`, async () => {
    const provider = new SelfSignedTestSealProvider();
    provider.signDigest = async () => {
      throw Object.assign(new Error('vendor down'), { name: 'SealProviderHttpError' });
    };
    let now = new Date('2026-11-02T10:00:00.000Z');
    const sealer = new DocumentSealService(prisma, repo, provider, null, () => now);
    const { envelope_id, document_id } = await completedEnvelope();
    await producer(sealer).produce(TENANT, envelope_id);
    for (let i = 0; i < MAX_SEAL_ATTEMPTS + 2; i += 1) {
      now = new Date(now.getTime() + 7 * 3_600_000);
      await sealer.retryDue();
    }
    const [row] = await q<{ status: string; attempts: number }>(`SELECT status, attempts FROM "sign"."ExecutedDocumentSeal" WHERE envelope_document_id = $1`, [document_id]);
    expect(row?.status).toBe('FAILED');
    expect(row?.attempts).toBe(MAX_SEAL_ATTEMPTS);
  });

  it('dark: with no provider nothing is written and the certificate has no seal line', async () => {
    const sealer = new DocumentSealService(prisma, repo, null, null);
    const { envelope_id } = await completedEnvelope();
    await producer(sealer).produce(TENANT, envelope_id);
    expect(await q(`SELECT 1 FROM "sign"."ExecutedDocumentSeal" WHERE envelope_id = $1`, [envelope_id])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM "sign"."SignatureEvent" WHERE envelope_id = $1 AND event_type = $2`, [envelope_id, EXECUTED_DOCUMENT_SEALED])).toHaveLength(0);
    expect(await certificateText(envelope_id)).not.toContain('document seal');
  });

  it('a repeated produce (already executed) does not seal retroactively', async () => {
    const { envelope_id } = await completedEnvelope();
    await producer().produce(TENANT, envelope_id); // completed while the seal was off
    const sealer = new DocumentSealService(prisma, repo, new SelfSignedTestSealProvider(), null);
    await producer(sealer).produce(TENANT, envelope_id);
    expect(await q(`SELECT 1 FROM "sign"."ExecutedDocumentSeal" WHERE envelope_id = $1`, [envelope_id])).toHaveLength(0);
  });
});
