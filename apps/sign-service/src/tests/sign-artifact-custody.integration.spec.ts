import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { PdfLibDocumentRenderingAdapter } from '@aramo/documents-rendering';
import { EXECUTED_ARTIFACT_CUSTODY_EVENT_TYPE, EsignRepository, ExecutionService, PrismaService, SignArtifactCustodyRepository } from '@aramo/sign';
import { Client } from 'pg';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ExecutedArtifactCustodyService } from '../app/custody/executed-artifact-custody.service.js';
import { buildCustodyRefs, validateArtifactCustody } from '../app/custody/artifact-custody-validation.js';

import { FakeSignS3, fakeStore } from './fixtures/fake-sign-s3.js';

// SX-2 — completion custody against real Postgres 17 with the full sign migration chain
// (incl. 20261031100000_sign_executed_artifact_custody_columns) and an in-memory versioned
// S3 double: produce() records custody + ledger events; an upload failure leaves custody
// NULL without failing produce(); reconcile records it later; the CHECK keeps the custody
// columns all-or-none; recovery validation passes on the recorded versions.

const ROOT = resolve(__dirname, '../../../..');
const migrations = (): string[] => {
  const dir = resolve(ROOT, 'libs/sign/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
};

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('SX-2 artifact custody — real Postgres 17', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: PrismaService;
  let repo: EsignRepository;
  let sourcePdf: Uint8Array;
  const TENANT = randomUUID();
  const ACTOR = randomUUID();
  const moduleRef = {
    get: () => ({
      evidenceManifest: async (_t: string, envelope_id: string) => ({
        manifest: { envelope_id }, signature: 'sig', signature_algorithm: 'SHA256-SOFTWARE-DOC3', kms_key_version_ref: null, signing_timestamp: new Date().toISOString(),
      }),
    }),
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    db = new Client({ connectionString: url });
    await db.connect();
    for (const m of migrations()) await db.query(readFileSync(m, 'utf8'));
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

  async function envelope(): Promise<string> {
    const env = await repo.createEnvelope({ tenant_id: TENANT, subject: 'Agreement', execution_mode: 'SINGLE_SIGNATURE', created_by: ACTOR });
    await repo.addDocument({ tenant_id: TENANT, envelope_id: env.id, document_ref: randomUUID(), document_revision_ref: randomUUID(), title: 'a.pdf', source_sha256: 'seed', ordinal: 1 });
    await repo.addSigner({ tenant_id: TENANT, envelope_id: env.id, email: 'jane@x.com', name: 'Jane', signing_order: 1 });
    return env.id;
  }

  function wire(fake: FakeSignS3, retentionDays: number | null = null) {
    const custody = new ExecutedArtifactCustodyService(new SignArtifactCustodyRepository(prisma, repo), fakeStore(fake, { retentionDays }), moduleRef as never);
    const execution = new ExecutionService(prisma, repo, new PdfLibDocumentRenderingAdapter(), { getSourcePdf: async () => sourcePdf }, undefined, undefined, undefined, undefined, custody);
    return { custody, execution };
  }

  it('produce() records custody on both rows and appends chained ledger events', async () => {
    const envelope_id = await envelope();
    const fake = new FakeSignS3();
    const { execution } = wire(fake, 3);
    await execution.produce(TENANT, envelope_id);

    const ex = await prisma.executedDocument.findFirstOrThrow({ where: { envelope_id } });
    const cert = await prisma.executionCertificate.findFirstOrThrow({ where: { envelope_id } });
    expect(ex.custody_object_key).toBe(`tenants/${TENANT}/envelopes/${envelope_id}/executed/${ex.envelope_document_id}/${ex.executed_sha256}.pdf`);
    expect(ex.custody_sha256).toBe(ex.executed_sha256);
    expect(ex.custody_version_id).not.toBeNull();
    expect(ex.custody_retain_until).not.toBeNull();
    expect(cert.custody_object_key).toBe(`tenants/${TENANT}/envelopes/${envelope_id}/certificate/${cert.certificate_sha256}.pdf`);
    // The DB bytes are kept (PostgreSQL stays authoritative).
    expect(ex.executed_bytes.byteLength).toBe(ex.byte_size);

    const events = await prisma.signatureEvent.findMany({ where: { envelope_id }, orderBy: [{ occurred_at: 'asc' }, { id: 'asc' }] });
    const custodyEvents = events.filter((e) => e.event_type === EXECUTED_ARTIFACT_CUSTODY_EVENT_TYPE);
    expect(custodyEvents).toHaveLength(2);
    for (let i = 1; i < events.length; i += 1) expect(events[i]!.previous_event_hash).toBe(events[i - 1]!.event_hash);

    // The repository's READ ONLY validation read returns the same rows + ledger events.
    const read = await new SignArtifactCustodyRepository(prisma, repo).readForValidation(TENANT, [envelope_id]);
    expect(read.executed).toHaveLength(1);
    expect(read.events).toHaveLength(2);
    const refs = buildCustodyRefs(read);
    const report = await validateArtifactCustody(refs, { getVersion: (k, v) => fakeStore(fake).get(k, v) });
    expect(report).toMatchObject({ checked: 3, ok: 3, failures: 0 });
  });

  it('an upload failure never fails produce(); reconcile records custody afterwards', async () => {
    const envelope_id = await envelope();
    const fake = new FakeSignS3();
    fake.failOn = { name: 'PutObjectCommand', error: Object.assign(new Error('Access Denied'), { name: 'AccessDenied' }), times: 99 };
    const { execution, custody } = wire(fake);
    await expect(execution.produce(TENANT, envelope_id)).resolves.toHaveLength(1);
    const before = await prisma.executedDocument.findFirstOrThrow({ where: { envelope_id } });
    expect(before.custody_object_key).toBeNull();
    expect((await prisma.executionCertificate.findFirstOrThrow({ where: { envelope_id } })).custody_object_key).toBeNull();

    fake.failOn = null;
    const later = new Date(Date.now() + 10 * 60_000);
    const report = await custody.reconcile({ now: later });
    expect(report.failed).toBe(0);
    expect(report.recorded).toBeGreaterThanOrEqual(2);
    expect((await prisma.executedDocument.findFirstOrThrow({ where: { envelope_id } })).custody_object_key).not.toBeNull();
    // Idempotent: nothing left for this envelope.
    expect((await custody.custodyForEnvelope(TENANT, envelope_id)).recorded).toBe(0);
  });

  it('the CHECK keeps custody columns all-or-none', async () => {
    const envelope_id = await envelope();
    const { execution } = wire(new FakeSignS3());
    await execution.produce(TENANT, envelope_id);
    const row = await prisma.executionCertificate.findFirstOrThrow({ where: { envelope_id } });
    const clear = `UPDATE "sign"."ExecutionCertificate" SET custody_sha256 = NULL WHERE id = $1`;
    // Layer 1 — the SX-1 write-once trigger refuses clearing a set custody column.
    await expect(db.query(clear, [row.id])).rejects.toThrow(/write-once/);
    // Layer 2 — with the trigger bypassed (privileged tampering), the CHECK still refuses.
    await db.query('BEGIN');
    try {
      await db.query(`ALTER TABLE "sign"."ExecutionCertificate" DISABLE TRIGGER USER`);
      await expect(db.query(clear, [row.id])).rejects.toThrow(/custody_complete_check/);
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
