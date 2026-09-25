import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DocumentsRepository, DocumentIdempotencyService, PrismaService } from '../index.js';

// DOC-5 B1 — the RIGHT_TO_REPRESENT SYSTEM-type seed + the PL-1 same-document
// executed-RTR readiness predicate on real Postgres 17.

const ROOT = resolve(__dirname, '../../../..');
const RTR_TYPE_ID = 'd0c50005-0000-7000-8000-000000000001';

function documentsMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/documents/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('DOC-5 RTR readiness — real Postgres 17', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: PrismaService;
  let repo: DocumentsRepository;

  const TENANT = randomUUID();
  const ACTOR = randomUUID();
  const TALENT = randomUUID();
  const REQ = randomUUID();

  async function makeDoc(status: string): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO "documents"."Document" (id, tenant_id, document_type_id, title, created_by, status, execution_mode, source_kind)
       VALUES ($1,$2,$3,'RTR',$4,$5,'SINGLE_SIGNATURE','TEMPLATE_GENERATED')`,
      [id, TENANT, RTR_TYPE_ID, ACTOR, status],
    );
    return id;
  }
  async function assoc(documentId: string, resource_type: string, resource_id: string, relationship: string): Promise<void> {
    await db.query(
      `INSERT INTO "documents"."DocumentAssociation" (id, tenant_id, document_id, resource_type, resource_id, relationship, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [randomUUID(), TENANT, documentId, resource_type, resource_id, relationship, ACTOR],
    );
  }
  const findRtr = (): ReturnType<DocumentsRepository['findExecutedByTypeAndAssociations']> =>
    repo.findExecutedByTypeAndAssociations({
      tenant_id: TENANT,
      document_type_key: 'RIGHT_TO_REPRESENT',
      associations: [
        { resource_type: 'TALENT', resource_id: TALENT, relationship: 'SUBJECT' },
        { resource_type: 'REQUISITION', resource_id: REQ, relationship: 'REGARDING' },
      ],
    });

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17').start();
    const url = container.getConnectionUri();
    db = new Client({ connectionString: url });
    await db.connect();
    for (const m of documentsMigrations()) await db.query(readFileSync(m, 'utf8'));
    prisma = new PrismaService(url);
    await prisma.$connect();
    repo = new DocumentsRepository(prisma, new DocumentIdempotencyService(prisma));
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    await container?.stop();
  });

  it('seeds RIGHT_TO_REPRESENT as a SYSTEM DocumentType (tenant_id NULL, system_defined)', async () => {
    const r = await db.query(
      `SELECT scope, system_defined, execution_mode_default FROM "documents"."DocumentType" WHERE id=$1 AND key='RIGHT_TO_REPRESENT' AND tenant_id IS NULL`,
      [RTR_TYPE_ID],
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].scope).toBe('SYSTEM');
    expect(r.rows[0].system_defined).toBe(true);
    expect(r.rows[0].execution_mode_default).toBe('SINGLE_SIGNATURE');
  });

  it('PL-1: satisfied only when ONE executed RTR carries BOTH the talent + requisition associations', async () => {
    const doc = await makeDoc('EXECUTED');
    await assoc(doc, 'TALENT', TALENT, 'SUBJECT');
    await assoc(doc, 'REQUISITION', REQ, 'REGARDING');
    const found = await findRtr();
    expect(found?.id).toBe(doc);
  });

  it('PL-1 negative: two separate documents (talent on one, requisition on the other) do NOT satisfy', async () => {
    const t2 = randomUUID();
    const r2 = randomUUID();
    const docA = await makeDoc('EXECUTED');
    await assoc(docA, 'TALENT', t2, 'SUBJECT');
    const docB = await makeDoc('EXECUTED');
    await assoc(docB, 'REQUISITION', r2, 'REGARDING');
    const found = await repo.findExecutedByTypeAndAssociations({
      tenant_id: TENANT,
      document_type_key: 'RIGHT_TO_REPRESENT',
      associations: [
        { resource_type: 'TALENT', resource_id: t2, relationship: 'SUBJECT' },
        { resource_type: 'REQUISITION', resource_id: r2, relationship: 'REGARDING' },
      ],
    });
    expect(found).toBeNull();
  });

  it('PL-1 negative: a PREPARED (not EXECUTED) RTR with both associations does NOT satisfy', async () => {
    const t3 = randomUUID();
    const r3 = randomUUID();
    const doc = await makeDoc('PREPARED');
    await assoc(doc, 'TALENT', t3, 'SUBJECT');
    await assoc(doc, 'REQUISITION', r3, 'REGARDING');
    const found = await repo.findExecutedByTypeAndAssociations({
      tenant_id: TENANT,
      document_type_key: 'RIGHT_TO_REPRESENT',
      associations: [
        { resource_type: 'TALENT', resource_id: t3, relationship: 'SUBJECT' },
        { resource_type: 'REQUISITION', resource_id: r3, relationship: 'REGARDING' },
      ],
    });
    expect(found).toBeNull();
  });

  // DOC-5 — the CONDITIONAL trigger: the readiness gate applies only when an RTR
  // requirement exists for the requisition (else ungated; existing submits pass).
  it('findRequirement is null when no RTR requirement exists (gate ungated)', async () => {
    const r = await repo.findRequirement({ tenant_id: TENANT, document_type_id: RTR_TYPE_ID, resource_type: 'REQUISITION', resource_id: randomUUID() });
    expect(r).toBeNull();
  });

  it('ensureRequirement creates an UNSATISFIED RTR requirement, idempotently', async () => {
    const reqId = randomUUID();
    const a = await repo.ensureRequirement({ tenant_id: TENANT, document_type_id: RTR_TYPE_ID, resource_type: 'REQUISITION', resource_id: reqId, created_by: ACTOR });
    expect(a.status).toBe('UNSATISFIED');
    const b = await repo.ensureRequirement({ tenant_id: TENANT, document_type_id: RTR_TYPE_ID, resource_type: 'REQUISITION', resource_id: reqId, created_by: ACTOR });
    expect(b.id).toBe(a.id); // idempotent — no duplicate
    const found = await repo.findRequirement({ tenant_id: TENANT, document_type_id: RTR_TYPE_ID, resource_type: 'REQUISITION', resource_id: reqId });
    expect(found?.id).toBe(a.id);
  });
});
