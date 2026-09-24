import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DocumentExecutedWriteBackService,
  DocumentIdempotencyService,
  ExecutedArtifactHashMismatchError,
  PrismaService,
  type DocumentStoragePort,
  type PutArtifactInput,
  type PutArtifactResult,
} from '../index.js';

// DOC-4 B6 — the Documents write-back on real Postgres 17. Proves: hash-verified
// storage of EXECUTED + EXECUTION_CERTIFICATE artifacts, Document -> EXECUTED,
// idempotent replay (no duplicate artifacts), and a hash-mismatch rejection.

const ROOT = resolve(__dirname, '../../../..');

function documentsMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/documents/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}

class FakeStorage implements DocumentStoragePort {
  puts: PutArtifactInput[] = [];
  async putArtifact(input: PutArtifactInput): Promise<PutArtifactResult> {
    this.puts.push(input);
    return { storage_key: input.storage_key, sha256: 'fake' };
  }
  async getArtifact(): Promise<Buffer> { return Buffer.from([]); }
  async createReadAccess() { return { url: 'x', expires_at: 'x' }; }
  async createWriteAccess() { return { url: 'x', expires_at: 'x' }; }
  async headArtifact() { return null; }
  async verifyArtifact() { return true; }
  async applyRetention(): Promise<void> { await Promise.resolve(); }
  async applyLegalHold(): Promise<void> { await Promise.resolve(); }
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('DOC-4 Documents write-back — real Postgres 17', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: PrismaService;
  let storage: FakeStorage;
  let service: DocumentExecutedWriteBackService;

  const TENANT = randomUUID();
  const ACTOR = randomUUID();

  async function seedDocument(): Promise<{ documentId: string; revisionId: string }> {
    const typeId = randomUUID();
    await db.query(
      `INSERT INTO "documents"."DocumentType" (id, tenant_id, key, name, scope, execution_mode_default, retention_class)
       VALUES ($1, NULL, $2, 'RTR', 'SYSTEM', 'SINGLE_SIGNATURE', 'CONTRACT_RECORD')`,
      [typeId, `RTR_${typeId.slice(0, 8)}`],
    );
    const documentId = randomUUID();
    await db.query(
      `INSERT INTO "documents"."Document" (id, tenant_id, document_type_id, title, created_by, status, execution_mode, source_kind)
       VALUES ($1,$2,$3,'Offer',$4,'EXECUTION_PENDING','SINGLE_SIGNATURE','TEMPLATE_GENERATED')`,
      [documentId, TENANT, typeId, ACTOR],
    );
    const revisionId = randomUUID();
    await db.query(
      `INSERT INTO "documents"."DocumentRevision" (id, tenant_id, document_id, revision_number, status, created_by)
       VALUES ($1,$2,$3,1,'FROZEN',$4)`,
      [revisionId, TENANT, documentId, ACTOR],
    );
    return { documentId, revisionId };
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17').start();
    const url = container.getConnectionUri();
    db = new Client({ connectionString: url });
    await db.connect();
    for (const m of documentsMigrations()) await db.query(readFileSync(m, 'utf8'));
    prisma = new PrismaService(url);
    await prisma.$connect();
    storage = new FakeStorage();
    service = new DocumentExecutedWriteBackService(prisma, storage, new DocumentIdempotencyService(prisma));
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    await container?.stop();
  });

  const executed = Buffer.from('EXECUTED-PDF-BYTES');
  const cert = Buffer.from('CERTIFICATE-PDF-BYTES');
  const hex = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

  it('stores EXECUTED + EXECUTION_CERTIFICATE artifacts, transitions Document -> EXECUTED, idempotently', async () => {
    const { documentId, revisionId } = await seedDocument();
    const key = randomUUID();
    const input = {
      tenant_id: TENANT, document_id: documentId, revision_id: revisionId,
      executed_bytes: executed, executed_sha256: hex(executed),
      certificate_bytes: cert, certificate_sha256: hex(cert),
      actor_id: ACTOR, requestId: 'rq-1', idempotency_key: key,
    };
    const r1 = await service.storeExecuted(input);
    expect(r1.document_status).toBe('EXECUTED');

    const arts = await db.query(`SELECT artifact_role, immutability_state, sha256 FROM "documents"."DocumentArtifact" WHERE document_id=$1 ORDER BY artifact_role`, [documentId]);
    expect(arts.rows.map((x) => x.artifact_role)).toEqual(['EXECUTED', 'EXECUTION_CERTIFICATE']);
    expect(arts.rows.every((x) => x.immutability_state === 'FROZEN')).toBe(true);
    const docRow = await db.query(`SELECT status, current_revision_id FROM "documents"."Document" WHERE id=$1`, [documentId]);
    expect(docRow.rows[0].status).toBe('EXECUTED');
    expect(docRow.rows[0].current_revision_id).toBe(revisionId);

    // Idempotent replay — same key + same request returns the stored result and
    // creates NO duplicate artifacts.
    const r2 = await service.storeExecuted(input);
    expect(r2.executed_artifact_id).toBe(r1.executed_artifact_id);
    const artCount = await db.query(`SELECT count(*)::int AS n FROM "documents"."DocumentArtifact" WHERE document_id=$1`, [documentId]);
    expect(artCount.rows[0].n).toBe(2);
  });

  it('rejects a write-back whose bytes do not match the asserted sha256', async () => {
    const { documentId, revisionId } = await seedDocument();
    await expect(
      service.storeExecuted({
        tenant_id: TENANT, document_id: documentId, revision_id: revisionId,
        executed_bytes: executed, executed_sha256: 'f'.repeat(64), // wrong
        certificate_bytes: cert, certificate_sha256: hex(cert),
        actor_id: ACTOR, requestId: 'rq-2', idempotency_key: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ExecutedArtifactHashMismatchError);
  });
});
