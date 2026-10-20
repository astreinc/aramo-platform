import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  PdfLibDocumentRenderingAdapter,
  type DocumentRenderingPort,
  type PreparedField,
  type RenderedOutput,
} from '@aramo/documents-rendering';

import { PrismaService } from '../index.js';
import { EsignRepository } from '../lib/esign.repository.js';
import { ExecutionService } from '../lib/execution.service.js';
import { type DocumentSourceProviderPort } from '../lib/ports/document-source-provider.port.js';

// PX-V1 F2 — proves the SignatureField model is now load-bearing end to end: a
// defined + filled field flows into ExecutionService.produce, the renderer
// receives a NON-EMPTY placement at the requested coordinates, and the executed
// PDF is actually stamped (executed_sha256 != source_sha256). This closes the
// Gate-0 finding that the executed PDF was unstamped because placements were
// always empty. Real Postgres 17 + real pdf-lib renderer.

const ROOT = resolve(__dirname, '../../../..');

function esignMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/sign/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('PX-V1 F2 execution stamping — real Postgres 17', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: PrismaService;
  let repo: EsignRepository;
  let sourcePdf: Uint8Array;

  const TENANT = randomUUID();
  const ACTOR = randomUUID();

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    db = new Client({ connectionString: url });
    await db.connect();
    for (const m of esignMigrations()) await db.query(readFileSync(m, 'utf8'));
    prisma = new PrismaService(url);
    await prisma.$connect();
    repo = new EsignRepository(prisma);

    // A real 1-page source PDF (600x800) so field (72,120) is within page bounds.
    const src = await PDFDocument.create();
    src.addPage([600, 800]);
    sourcePdf = await src.save();
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    await container?.stop();
  });

  it('stamps a filled SIGNATURE field onto the executed PDF at its coordinates', async () => {
    const env = await repo.createEnvelope({ tenant_id: TENANT, subject: 'Agreement', execution_mode: 'SINGLE_SIGNATURE', created_by: ACTOR });
    const doc = await repo.addDocument({
      tenant_id: TENANT, envelope_id: env.id, document_ref: randomUUID(), document_revision_ref: randomUUID(),
      title: 'agreement.pdf', source_sha256: 'seed', ordinal: 1,
    });
    const signer = await repo.addSigner({ tenant_id: TENANT, envelope_id: env.id, email: 'jane@x.com', name: 'Jane', signing_order: 1 });
    const field = await repo.addField({
      tenant_id: TENANT, envelope_document_id: doc.id, signer_id: signer.id, field_type: 'SIGNATURE', page_number: 0, x: 72, y: 120, required: true,
    });
    // Fill it (as the signer flow would) so produce picks it up.
    await prisma.signatureField.update({ where: { id: field.id }, data: { value: 'Jane Doe', signature_method: 'TYPED', filled_at: new Date() } });

    // Capture the placements handed to the renderer, delegating to the real adapter.
    const real = new PdfLibDocumentRenderingAdapter();
    const captured: PreparedField[][] = [];
    const capturing: DocumentRenderingPort = {
      prepareFromSource: async (src, placements, opts): Promise<RenderedOutput> => {
        captured.push(placements);
        return real.prepareFromSource(src, placements, opts);
      },
      renderGenerated: (model) => real.renderGenerated(model),
    };
    const source: DocumentSourceProviderPort = { getSourcePdf: async () => sourcePdf };

    const execution = new ExecutionService(prisma, repo, capturing, source);
    await execution.produce(TENANT, env.id);

    // The renderer received exactly one NON-EMPTY placement at the requested coords.
    expect(captured).toHaveLength(1);
    expect(captured[0]).toHaveLength(1);
    expect(captured[0]?.[0]).toMatchObject({ page_number: 0, x: 72, y: 120, value: 'Jane Doe' });

    // The executed PDF is actually stamped: its sha differs from the source sha.
    const executed = await prisma.executedDocument.findFirst({ where: { tenant_id: TENANT, envelope_document_id: doc.id } });
    expect(executed).not.toBeNull();
    expect(executed?.executed_sha256).not.toBe(executed?.source_sha256);
    expect((executed?.byte_size ?? 0) > 0).toBe(true);
  });

  // PX-2 — the Signature ID under a stamped signature is the signer's
  // SIGNER_SIGNED ledger hash (as uppercase hex), and the execution certificate
  // prints the same ID in full, so the two can be matched.
  it('stamps typed signatures in the Signed by frame with the ledger Signature ID, also in the certificate', async () => {
    const env = await repo.createEnvelope({ tenant_id: TENANT, subject: 'Agreement', execution_mode: 'SINGLE_SIGNATURE', created_by: ACTOR });
    const doc = await repo.addDocument({
      tenant_id: TENANT, envelope_id: env.id, document_ref: randomUUID(), document_revision_ref: randomUUID(),
      title: 'agreement.pdf', source_sha256: 'seed', ordinal: 1,
    });
    const signer = await repo.addSigner({ tenant_id: TENANT, envelope_id: env.id, email: 'jane@x.com', name: 'Jane', signing_order: 1 });
    const field = await repo.addField({
      tenant_id: TENANT, envelope_document_id: doc.id, signer_id: signer.id, field_type: 'SIGNATURE', page_number: 0, x: 72, y: 120, width: 220, height: 48, required: true,
    });
    await prisma.signatureField.update({ where: { id: field.id }, data: { value: 'Jane Doe', signature_method: 'TYPED', filled_at: new Date() } });
    const eventHash = await prisma.$transaction((tx) =>
      repo.appendEvent(tx, { tenant_id: TENANT, envelope_id: env.id, signer_id: signer.id, event_type: 'SIGNER_SIGNED', actor_type: 'SIGNER', actor_ref: signer.id }),
    );
    const signatureId = Buffer.from(eventHash, 'base64url').toString('hex').toUpperCase();

    const real = new PdfLibDocumentRenderingAdapter();
    const captured: PreparedField[][] = [];
    const generated: string[] = [];
    const capturing: DocumentRenderingPort = {
      prepareFromSource: async (src, placements, opts): Promise<RenderedOutput> => {
        captured.push(placements);
        return real.prepareFromSource(src, placements, opts);
      },
      renderGenerated: (model) => {
        generated.push(JSON.stringify(model));
        return real.renderGenerated(model);
      },
    };
    const execution = new ExecutionService(prisma, repo, capturing, { getSourcePdf: async () => sourcePdf });
    await execution.produce(TENANT, env.id);

    expect(captured[0]?.[0]).toMatchObject({ value: 'Jane Doe', font: 'SCRIPT', stamp: { label: 'Signed by:', id: `${signatureId.slice(0, 15)}...` } });
    expect(generated.join('')).toContain(`Signature ID: ${signatureId}`);
  });
  // Multi-Signer Amendment §8 — the executed PDF carries EVERY signer's signature (each
  // with that signer's own ledger Signature ID) and the certificate lists all of them.
  it('10 signers: every signature is stamped with its own Signature ID and the certificate lists every signer', async () => {
    const env = await repo.createEnvelope({ tenant_id: TENANT, subject: 'Ten party', execution_mode: 'MULTI_SIGNATURE', created_by: ACTOR });
    const doc = await repo.addDocument({
      tenant_id: TENANT, envelope_id: env.id, document_ref: randomUUID(), document_revision_ref: randomUUID(),
      title: 'ten.pdf', source_sha256: 'seed', ordinal: 1,
    });
    const ids: string[] = [];
    for (let i = 1; i <= 10; i++) {
      const signer = await repo.addSigner({ tenant_id: TENANT, envelope_id: env.id, email: `p${i}@x.com`, name: `Party ${i}`, signing_order: i });
      const field = await repo.addField({
        tenant_id: TENANT, envelope_document_id: doc.id, signer_id: signer.id, field_type: 'SIGNATURE', page_number: 0, x: 40, y: 40 + i * 60, width: 200, height: 40, required: true,
      });
      await prisma.signatureField.update({ where: { id: field.id }, data: { value: `Party ${i}`, signature_method: 'TYPED', filled_at: new Date() } });
      await prisma.signer.update({ where: { id: signer.id }, data: { status: 'SIGNED', signed_at: new Date() } });
      const h = await prisma.$transaction((tx) =>
        repo.appendEvent(tx, { tenant_id: TENANT, envelope_id: env.id, signer_id: signer.id, event_type: 'SIGNER_SIGNED', actor_type: 'SIGNER', actor_ref: signer.id }),
      );
      ids.push(Buffer.from(h, 'base64url').toString('hex').toUpperCase());
    }
    const real = new PdfLibDocumentRenderingAdapter();
    const captured: PreparedField[][] = [];
    const generated: string[] = [];
    const capturing: DocumentRenderingPort = {
      prepareFromSource: async (src, placements, opts): Promise<RenderedOutput> => {
        captured.push(placements);
        return real.prepareFromSource(src, placements, opts);
      },
      renderGenerated: (model) => {
        generated.push(JSON.stringify(model));
        return real.renderGenerated(model);
      },
    };
    const execution = new ExecutionService(prisma, repo, capturing, { getSourcePdf: async () => sourcePdf });
    await execution.produce(TENANT, env.id);

    const placements = captured[0] ?? [];
    expect(placements).toHaveLength(10);
    for (let i = 0; i < 10; i++) {
      expect(placements).toContainEqual(expect.objectContaining({ value: `Party ${i + 1}`, stamp: expect.objectContaining({ id: `${ids[i]!.slice(0, 15)}...` }) }));
    }
    const certificate = generated.join('');
    for (let i = 0; i < 10; i++) {
      expect(certificate).toContain(`Party ${i + 1}`);
      expect(certificate).toContain(`Signature ID: ${ids[i]}`);
    }
  });
});
