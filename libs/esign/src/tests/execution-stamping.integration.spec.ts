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
  const dir = resolve(ROOT, 'libs/esign/prisma/migrations');
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
});
