import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { PdfLibDocumentRenderingAdapter, type DocumentRenderingPort } from '@aramo/documents-rendering';

import { PrismaService } from '../index.js';
import { EsignRepository } from '../lib/esign.repository.js';
import { ExecutionService } from '../lib/execution.service.js';
import { TrustedTimestampService } from '../lib/trusted-timestamp/trusted-timestamp.service.js';
import type { TrustedTimestampPort } from '../lib/ports/trusted-timestamp.port.js';

// Feature-Parity Directive v1.0 §1.18 — the SignTrustedTimestamp table on real Postgres:
// its guard (never deleted; a GRANTED row immutable; the subject immutable), its CHECKs
// and partial unique keys, and the completion path (a TSA outage leaves the documents
// "timestamp pending" and the certificate says so; completion is not blocked).

const ROOT = resolve(__dirname, '../../../..');

function esignMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/sign/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('§1.18 SignTrustedTimestamp — real Postgres 17', () => {
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
    const src = await PDFDocument.create();
    src.addPage([600, 800]);
    sourcePdf = await src.save();
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    await container?.stop();
  });

  async function envelopeWithDocument(): Promise<{ envelope_id: string; document_id: string }> {
    const env = await repo.createEnvelope({ tenant_id: TENANT, subject: 'Timestamped', execution_mode: 'SINGLE_SIGNATURE', created_by: ACTOR });
    const doc = await repo.addDocument({
      tenant_id: TENANT, envelope_id: env.id, document_ref: randomUUID(), document_revision_ref: randomUUID(), title: 'a.pdf', source_sha256: 'seed', ordinal: 1,
    });
    return { envelope_id: env.id, document_id: doc.id };
  }

  async function insertRow(envelope_id: string, document_id: string | null, extra = ''): Promise<string> {
    const id = randomUUID();
    const kind = document_id === null ? 'EVIDENCE_MANIFEST' : 'EXECUTED_DOCUMENT';
    await db.query(
      `INSERT INTO sign."SignTrustedTimestamp" (id, tenant_id, envelope_id, subject_kind, envelope_document_id, message_imprint_sha256, subject_canonical, tsa_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'https://tsa.test')${extra}`,
      [id, TENANT, envelope_id, kind, document_id, 'a'.repeat(64), document_id === null ? '{}' : null],
    );
    return id;
  }

  it('enforces the subject CHECKs and one row per document / per manifest', async () => {
    const { envelope_id, document_id } = await envelopeWithDocument();
    await insertRow(envelope_id, document_id);
    await expect(insertRow(envelope_id, document_id)).rejects.toThrow(/SignTrustedTimestamp_document_key/);
    await insertRow(envelope_id, null);
    await expect(insertRow(envelope_id, null)).rejects.toThrow(/SignTrustedTimestamp_manifest_key/);
    await expect(
      db.query(`INSERT INTO sign."SignTrustedTimestamp" (id, tenant_id, envelope_id, subject_kind, message_imprint_sha256, tsa_url) VALUES ($1, $2, $3, 'EXECUTED_DOCUMENT', $4, 'x')`, [randomUUID(), TENANT, envelope_id, 'a'.repeat(64)]),
    ).rejects.toThrow(/subject_ref_check/);
    await expect(
      db.query(`INSERT INTO sign."SignTrustedTimestamp" (id, tenant_id, envelope_id, subject_kind, subject_canonical, message_imprint_sha256, tsa_url) VALUES ($1, $2, $3, 'EVIDENCE_MANIFEST', '{}', 'NOT-HEX', 'x')`, [randomUUID(), TENANT, envelope_id]),
    ).rejects.toThrow(/imprint_check/);
  });

  it('allows PENDING → GRANTED once, then refuses any change; never allows DELETE or a subject change', async () => {
    const { envelope_id, document_id } = await envelopeWithDocument();
    const id = await insertRow(envelope_id, document_id);
    await db.query(`UPDATE sign."SignTrustedTimestamp" SET attempt_count = 1, last_error = 'timeout' WHERE id = $1`, [id]);
    await expect(db.query(`UPDATE sign."SignTrustedTimestamp" SET message_imprint_sha256 = $2 WHERE id = $1`, [id, 'b'.repeat(64)])).rejects.toThrow(/subject .* is immutable/);
    await expect(db.query(`UPDATE sign."SignTrustedTimestamp" SET status = 'GRANTED' WHERE id = $1`, [id])).rejects.toThrow(/granted_check/);
    await db.query(`UPDATE sign."SignTrustedTimestamp" SET status = 'GRANTED', token_der = '\\x3000', gen_time = now(), granted_at = now() WHERE id = $1`, [id]);
    await expect(db.query(`UPDATE sign."SignTrustedTimestamp" SET last_error = 'x' WHERE id = $1`, [id])).rejects.toThrow(/GRANTED SignTrustedTimestamp is immutable/);
    await expect(db.query(`DELETE FROM sign."SignTrustedTimestamp" WHERE id = $1`, [id])).rejects.toThrow(/never deleted/);
  });

  it('a TSA outage at completion: documents stay "timestamp pending", the certificate says so, completion proceeds; the retry grants later', async () => {
    const { envelope_id, document_id } = await envelopeWithDocument();
    let up = false;
    const tsa: TrustedTimestampPort = {
      tsa_url: 'https://tsa.test/rfc3161',
      timestamp: async (sha) => {
        if (!up) throw new Error('TSA responded HTTP 503');
        return {
          token_der: Buffer.from('3000', 'hex'), gen_time: new Date(), serial_number: '1', policy_oid: '1.2.3.4.1', hash_algorithm: 'SHA-256',
          message_imprint_sha256: sha, tsa_name: 'CN=Aramo Test TSA', tsa_certificate_sha256: 'c'.repeat(64),
        };
      },
    };
    const timestamps = new TrustedTimestampService(prisma, tsa);
    const real = new PdfLibDocumentRenderingAdapter();
    const generated: string[] = [];
    const rendering: DocumentRenderingPort = {
      prepareFromSource: (src, placements, opts) => real.prepareFromSource(src, placements, opts),
      renderGenerated: (model) => {
        generated.push(JSON.stringify(model));
        return real.renderGenerated(model);
      },
    };
    const execution = new ExecutionService(prisma, repo, rendering, { getSourcePdf: async () => sourcePdf }, undefined, undefined, undefined, undefined, undefined, undefined, timestamps);
    await execution.produce(TENANT, envelope_id);

    expect(await prisma.executionCertificate.count({ where: { envelope_id } })).toBe(1);
    expect(generated.join('')).toContain(`Doc ${document_id}: timestamp pending`);
    const pending = await prisma.signTrustedTimestamp.findFirstOrThrow({ where: { envelope_id } });
    expect(pending.status).toBe('PENDING');
    expect(pending.attempt_count).toBe(1);

    up = true;
    expect(await timestamps.retryDue(new Date(Date.now() + 60_000))).toBe(1);
    const granted = await prisma.signTrustedTimestamp.findFirstOrThrow({ where: { envelope_id } });
    expect(granted.status).toBe('GRANTED');
    expect(granted.tsa_name).toBe('CN=Aramo Test TSA');
  });
});
