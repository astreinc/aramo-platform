import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DocumentsRepository,
  DocumentIdempotencyService,
  PrismaService,
  DocumentNotFoundError,
  DocumentIdempotencyConflictError,
} from '../index.js';

// DOC-1a boundary 1+2 — schema/migration proofs against real Postgres 17.
// Skipped unless ARAMO_RUN_INTEGRATION=1. The documents schema is
// self-contained (cross-schema refs are opaque UUIDs, no FK), so this spec
// globs ONLY the module's own migrations — no curated cross-lib list (D7).

const ROOT = resolve(__dirname, '../../../..');

function documentsMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/documents/prisma/migrations');
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'DOC-1a documents core — real Postgres 17',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let prisma: PrismaService;
    let repo: DocumentsRepository;

    const TENANT_A = randomUUID();
    const TENANT_B = randomUUID();
    const ACTOR = randomUUID();

    async function newDocumentType(): Promise<string> {
      const typeId = randomUUID();
      await db.query(
        `INSERT INTO "documents"."DocumentType" (id, tenant_id, key, name, scope, execution_mode_default, retention_class)
         VALUES ($1, NULL, $2, 'RTR', 'SYSTEM', 'SINGLE_SIGNATURE', 'CONTRACT_RECORD')`,
        [typeId, `RIGHT_TO_REPRESENT_${typeId.slice(0, 8)}`],
      );
      return typeId;
    }

    async function eventCount(docId: string): Promise<number> {
      const r = await db.query(`SELECT count(*)::int AS n FROM "documents"."DocumentEvent" WHERE document_id = $1`, [
        docId,
      ]);
      return r.rows[0].n as number;
    }

    async function outboxCount(docId: string): Promise<number> {
      const r = await db.query(
        `SELECT count(*)::int AS n FROM "documents"."OutboxEvent" WHERE event_payload->>'document_id' = $1`,
        [docId],
      );
      return r.rows[0].n as number;
    }

    async function newDocument(tenant: string): Promise<{ typeId: string; docId: string }> {
      const typeId = randomUUID();
      const docId = randomUUID();
      await db.query(
        `INSERT INTO "documents"."DocumentType" (id, tenant_id, key, name, scope, execution_mode_default, retention_class)
         VALUES ($1, NULL, $2, 'RTR', 'SYSTEM', 'SINGLE_SIGNATURE', 'CONTRACT_RECORD')`,
        [typeId, `RIGHT_TO_REPRESENT_${typeId.slice(0, 8)}`],
      );
      await db.query(
        `INSERT INTO "documents"."Document" (id, tenant_id, document_type_id, title, status, execution_mode, source_kind, created_by)
         VALUES ($1, $2, $3, 'RTR for Jane', 'DRAFT', 'SINGLE_SIGNATURE', 'TEMPLATE_GENERATED', $4)`,
        [docId, tenant, typeId, ACTOR],
      );
      return { typeId, docId };
    }

    async function newRevision(tenant: string, docId: string, n: number): Promise<string> {
      const revId = randomUUID();
      await db.query(
        `INSERT INTO "documents"."DocumentRevision" (id, tenant_id, document_id, revision_number, status, created_by)
         VALUES ($1, $2, $3, $4, 'DRAFT', $5)`,
        [revId, tenant, docId, n, ACTOR],
      );
      return revId;
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of documentsMigrations()) await db.query(readFileSync(p, 'utf8'));
      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new DocumentsRepository(prisma, new DocumentIdempotencyService(prisma));
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await db?.end();
      await container?.stop();
    });

    it('creates a canonical Document readable only within its tenant', async () => {
      const { docId } = await newDocument(TENANT_A);
      const own = await db.query(`SELECT id FROM "documents"."Document" WHERE tenant_id = $1 AND id = $2`, [
        TENANT_A,
        docId,
      ]);
      expect(own.rowCount).toBe(1);
      const cross = await db.query(`SELECT id FROM "documents"."Document" WHERE tenant_id = $1 AND id = $2`, [
        TENANT_B,
        docId,
      ]);
      expect(cross.rowCount).toBe(0);
    });

    it('DocumentAssociation is polymorphic with a CONTROLLED vocabulary; client is COMPANY+CLIENT', async () => {
      const { docId } = await newDocument(TENANT_A);
      // Valid: client context is COMPANY + CLIENT (there is no resource_type=CLIENT).
      await expect(
        db.query(
          `INSERT INTO "documents"."DocumentAssociation" (id, tenant_id, document_id, resource_type, resource_id, relationship, created_by)
           VALUES ($1,$2,$3,'COMPANY',$4,'CLIENT',$5)`,
          [randomUUID(), TENANT_A, docId, randomUUID(), ACTOR],
        ),
      ).resolves.toBeDefined();
      // Rejected: CLIENT is not a resource_type.
      await expect(
        db.query(
          `INSERT INTO "documents"."DocumentAssociation" (id, tenant_id, document_id, resource_type, resource_id, relationship, created_by)
           VALUES ($1,$2,$3,'CLIENT',$4,'SUBJECT',$5)`,
          [randomUUID(), TENANT_A, docId, randomUUID(), ACTOR],
        ),
      ).rejects.toThrow(/resource_type_check/);
      // Rejected: out-of-vocabulary relationship.
      await expect(
        db.query(
          `INSERT INTO "documents"."DocumentAssociation" (id, tenant_id, document_id, resource_type, resource_id, relationship, created_by)
           VALUES ($1,$2,$3,'TALENT',$4,'WHATEVER',$5)`,
          [randomUUID(), TENANT_A, docId, randomUUID(), ACTOR],
        ),
      ).rejects.toThrow(/relationship_check/);
    });

    it('DocumentAssociation enforces the unique tuple', async () => {
      const { docId } = await newDocument(TENANT_A);
      const rid = randomUUID();
      await db.query(
        `INSERT INTO "documents"."DocumentAssociation" (id, tenant_id, document_id, resource_type, resource_id, relationship, created_by)
         VALUES ($1,$2,$3,'TALENT',$4,'SUBJECT',$5)`,
        [randomUUID(), TENANT_A, docId, rid, ACTOR],
      );
      await expect(
        db.query(
          `INSERT INTO "documents"."DocumentAssociation" (id, tenant_id, document_id, resource_type, resource_id, relationship, created_by)
           VALUES ($1,$2,$3,'TALENT',$4,'SUBJECT',$5)`,
          [randomUUID(), TENANT_A, docId, rid, ACTOR],
        ),
      ).rejects.toThrow(/DocumentAssociation_unique_tuple/);
    });

    it('DocumentArtifact.document_id must equal the revision parent (invariant trigger)', async () => {
      const { docId } = await newDocument(TENANT_A);
      const other = await newDocument(TENANT_A);
      const revId = await newRevision(TENANT_A, docId, 1);
      // Matching document_id: accepted.
      await expect(
        db.query(
          `INSERT INTO "documents"."DocumentArtifact" (id, tenant_id, revision_id, document_id, artifact_role, storage_provider, storage_locator, mime_type, byte_size, sha256, immutability_state, retention_class, created_by)
           VALUES ($1,$2,$3,$4,'RENDERED_UNSIGNED','aramo-s3','k/1','application/pdf',10,'abc','FROZEN','CONTRACT_RECORD',$5)`,
          [randomUUID(), TENANT_A, revId, docId, ACTOR],
        ),
      ).resolves.toBeDefined();
      // Mismatched document_id (points at another document): rejected by trigger.
      await expect(
        db.query(
          `INSERT INTO "documents"."DocumentArtifact" (id, tenant_id, revision_id, document_id, artifact_role, storage_provider, storage_locator, mime_type, byte_size, sha256, immutability_state, retention_class, created_by)
           VALUES ($1,$2,$3,$4,'RENDERED_UNSIGNED','aramo-s3','k/2','application/pdf',10,'abc','FROZEN','CONTRACT_RECORD',$5)`,
          [randomUUID(), TENANT_A, revId, other.docId, ACTOR],
        ),
      ).rejects.toThrow(/must equal revision parent/);
    });

    it('DocumentEvent is append-only — UPDATE and DELETE are rejected at the DB', async () => {
      const { docId } = await newDocument(TENANT_A);
      const evId = randomUUID();
      await db.query(
        `INSERT INTO "documents"."DocumentEvent" (id, tenant_id, document_id, event_type, actor_type, actor_id)
         VALUES ($1,$2,$3,'DOCUMENT_CREATED','USER',$4)`,
        [evId, TENANT_A, docId, ACTOR],
      );
      await expect(
        db.query(`UPDATE "documents"."DocumentEvent" SET event_type = 'X' WHERE id = $1`, [evId]),
      ).rejects.toThrow(/append-only/);
      await expect(
        db.query(`DELETE FROM "documents"."DocumentEvent" WHERE id = $1`, [evId]),
      ).rejects.toThrow(/append-only/);
    });

    it('createDocument writes the Document + exactly one DocumentEvent + one OutboxEvent in one transaction', async () => {
      const typeId = await newDocumentType();
      const clientCompany = randomUUID();
      const created = await repo.createDocument({
        tenant_id: TENANT_A,
        document_type_id: typeId,
        title: 'RTR for Jane',
        execution_mode: 'SINGLE_SIGNATURE',
        source_kind: 'TEMPLATE_GENERATED',
        created_by: ACTOR,
        associations: [{ resource_type: 'COMPANY', resource_id: clientCompany, relationship: 'CLIENT' }],
      });
      expect(created.status).toBe('DRAFT');
      expect(await eventCount(created.id)).toBe(1);
      expect(await outboxCount(created.id)).toBe(1);
      const assoc = await db.query(
        `SELECT count(*)::int AS n FROM "documents"."DocumentAssociation" WHERE document_id = $1`,
        [created.id],
      );
      expect(assoc.rows[0].n).toBe(1);
    });

    it('prepareDocument transitions DRAFT -> PREPARED and appends exactly one more event + outbox', async () => {
      const typeId = await newDocumentType();
      const created = await repo.createDocument({
        tenant_id: TENANT_A,
        document_type_id: typeId,
        title: 'RTR',
        execution_mode: 'SINGLE_SIGNATURE',
        source_kind: 'TEMPLATE_GENERATED',
        created_by: ACTOR,
      });
      const prepared = await repo.prepareDocument({
        tenant_id: TENANT_A,
        document_id: created.id,
        actor_id: ACTOR,
      });
      expect(prepared.status).toBe('PREPARED');
      expect(prepared.prepared_at).not.toBeNull();
      expect(await eventCount(created.id)).toBe(2);
      expect(await outboxCount(created.id)).toBe(2);
    });

    it('no-op transition appends NEITHER a domain event nor an outbox event', async () => {
      const typeId = await newDocumentType();
      const created = await repo.createDocument({
        tenant_id: TENANT_A,
        document_type_id: typeId,
        title: 'RTR',
        execution_mode: 'SINGLE_SIGNATURE',
        source_kind: 'TEMPLATE_GENERATED',
        created_by: ACTOR,
      });
      await repo.prepareDocument({ tenant_id: TENANT_A, document_id: created.id, actor_id: ACTOR });
      const beforeE = await eventCount(created.id);
      const beforeO = await outboxCount(created.id);
      // Prepare an already-PREPARED document — no actual state change.
      const again = await repo.prepareDocument({ tenant_id: TENANT_A, document_id: created.id, actor_id: ACTOR });
      expect(again.status).toBe('PREPARED');
      expect(await eventCount(created.id)).toBe(beforeE);
      expect(await outboxCount(created.id)).toBe(beforeO);
    });

    it('prepareDocument on an unknown/cross-tenant document throws DocumentNotFoundError (tenant-scoped)', async () => {
      const typeId = await newDocumentType();
      const created = await repo.createDocument({
        tenant_id: TENANT_A,
        document_type_id: typeId,
        title: 'RTR',
        execution_mode: 'SINGLE_SIGNATURE',
        source_kind: 'TEMPLATE_GENERATED',
        created_by: ACTOR,
      });
      await expect(
        repo.prepareDocument({ tenant_id: TENANT_A, document_id: randomUUID(), actor_id: ACTOR }),
      ).rejects.toBeInstanceOf(DocumentNotFoundError);
      // Same document id, wrong tenant -> not found (no cross-tenant leak).
      await expect(
        repo.prepareDocument({ tenant_id: TENANT_B, document_id: created.id, actor_id: ACTOR }),
      ).rejects.toBeInstanceOf(DocumentNotFoundError);
    });

    function createInput(typeId: string) {
      return {
        tenant_id: TENANT_A,
        document_type_id: typeId,
        title: 'RTR',
        execution_mode: 'SINGLE_SIGNATURE',
        source_kind: 'TEMPLATE_GENERATED',
        created_by: ACTOR,
      };
    }

    it('idempotency: unseen key proceeds and creates a new document', async () => {
      const typeId = await newDocumentType();
      const doc = await repo.createDocument(createInput(typeId), { key: randomUUID(), request_hash: 'h1' });
      expect(doc.status).toBe('DRAFT');
      expect(await eventCount(doc.id)).toBe(1);
      expect(await outboxCount(doc.id)).toBe(1);
    });

    it('idempotency: same key + same request hash replays the original result, appending nothing', async () => {
      const typeId = await newDocumentType();
      const key = randomUUID();
      const first = await repo.createDocument(createInput(typeId), { key, request_hash: 'h1' });
      const events1 = await eventCount(first.id);
      const outbox1 = await outboxCount(first.id);
      const second = await repo.createDocument(createInput(typeId), { key, request_hash: 'h1' });
      expect(second.id).toBe(first.id);
      expect(await eventCount(first.id)).toBe(events1);
      expect(await outboxCount(first.id)).toBe(outbox1);
    });

    it('idempotency: same key + different request hash -> conflict', async () => {
      const typeId = await newDocumentType();
      const key = randomUUID();
      await repo.createDocument(createInput(typeId), { key, request_hash: 'h1' });
      await expect(
        repo.createDocument(createInput(typeId), { key, request_hash: 'h2' }),
      ).rejects.toBeInstanceOf(DocumentIdempotencyConflictError);
    });

    it('idempotency: a consumed key does NOT survive a rolled-back transaction', async () => {
      const key = randomUUID();
      const idem = new DocumentIdempotencyService(prisma);
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.idempotencyKey.create({
            data: {
              id: randomUUID(),
              tenant_id: TENANT_A,
              key,
              request_hash: 'h',
              response_status: 201,
              response_body: { document_id: randomUUID() },
            },
          });
          throw new Error('force rollback');
        }),
      ).rejects.toThrow('force rollback');
      // The key was written inside the transaction, so the rollback removed it.
      expect((await idem.lookup(TENANT_A, key, 'h')).kind).toBe('proceed');
    });
  },
);
