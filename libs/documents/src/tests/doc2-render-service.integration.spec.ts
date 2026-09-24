import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PdfLibDocumentRenderingAdapter, type RenderModel } from '@aramo/documents-rendering';

import { PrismaService, RenderService } from '../index.js';
import { type DocumentStoragePort, type PutArtifactInput, type PutArtifactResult } from '../lib/storage/document-storage.port.js';

// DOC-2 boundary 5 — RenderService orchestration on real Postgres 17 with a fake
// storage port and the real pdf-lib adapter. Proves a generated document yields a
// FROZEN revision + RENDERED_UNSIGNED artifact with a populated render_manifest
// (provenance), and that identical inputs are hash-stable across revisions.

const ROOT = resolve(__dirname, '../../../..');

function documentsMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/documents/prisma/migrations');
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}

// Minimal in-memory storage port — records puts, never touches S3.
class FakeStorage implements DocumentStoragePort {
  puts: PutArtifactInput[] = [];
  async putArtifact(input: PutArtifactInput): Promise<PutArtifactResult> {
    this.puts.push(input);
    return { storage_key: input.storage_key, sha256: 'fake' };
  }
  async getArtifact(): Promise<Buffer> {
    return Buffer.from([]);
  }
  async createReadAccess() {
    return { url: 'x', expires_at: 'x' };
  }
  async createWriteAccess() {
    return { url: 'x', expires_at: 'x' };
  }
  async headArtifact() {
    return null;
  }
  async verifyArtifact() {
    return true;
  }
  async applyRetention(): Promise<void> {
    await Promise.resolve();
  }
  async applyLegalHold(): Promise<void> {
    await Promise.resolve();
  }
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'DOC-2 RenderService — real Postgres 17 + real pdf-lib + fake storage',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let prisma: PrismaService;
    let storage: FakeStorage;
    let service: RenderService;

    const TENANT = randomUUID();
    const ACTOR = randomUUID();

    // A real TemplateVersion so the DocumentRevision.template_version_id FK
    // (added in B1) is satisfied — a generated document renders from a real version.
    let VERSION_ID: string;
    let MODEL: RenderModel;

    async function newDocument(): Promise<string> {
      const typeId = randomUUID();
      await db.query(
        `INSERT INTO "documents"."DocumentType" (id, tenant_id, key, name, scope, execution_mode_default, retention_class)
         VALUES ($1, NULL, $2, 'OFFER', 'SYSTEM', 'SINGLE_SIGNATURE', 'CONTRACT_RECORD')`,
        [typeId, `OFFER_${typeId.slice(0, 8)}`],
      );
      const docId = randomUUID();
      await db.query(
        `INSERT INTO "documents"."Document" (id, tenant_id, document_type_id, title, status, execution_mode, source_kind, created_by)
         VALUES ($1,$2,$3,'Offer','DRAFT','SINGLE_SIGNATURE','TEMPLATE_GENERATED',$4)`,
        [docId, TENANT, typeId, ACTOR],
      );
      return docId;
    }

    async function seedTemplateVersion(): Promise<string> {
      const typeId = randomUUID();
      await db.query(
        `INSERT INTO "documents"."DocumentType" (id, tenant_id, key, name, scope, execution_mode_default, retention_class)
         VALUES ($1, NULL, $2, 'OFFER', 'SYSTEM', 'SINGLE_SIGNATURE', 'CONTRACT_RECORD')`,
        [typeId, `OFFER_TMPL_${typeId.slice(0, 8)}`],
      );
      const templateId = randomUUID();
      await db.query(
        `INSERT INTO "documents"."DocumentTemplate" (id, tenant_id, document_type_id, name, template_kind, status, created_by)
         VALUES ($1,$2,$3,'Offer Letter','GENERATED','ACTIVE',$4)`,
        [templateId, TENANT, typeId, ACTOR],
      );
      const versionId = randomUUID();
      await db.query(
        `INSERT INTO "documents"."TemplateVersion" (id, tenant_id, template_id, version_number, status, render_schema_version, created_by, activated_at)
         VALUES ($1,$2,$3,1,'ACTIVE','v1',$4, now())`,
        [versionId, TENANT, templateId, ACTOR],
      );
      return versionId;
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of documentsMigrations()) await db.query(readFileSync(p, 'utf8'));
      prisma = new PrismaService(url);
      await prisma.$connect();
      storage = new FakeStorage();
      service = new RenderService(prisma, new PdfLibDocumentRenderingAdapter(), storage);
      VERSION_ID = await seedTemplateVersion();
      MODEL = {
        template_version_id: VERSION_ID,
        render_schema_version: 'v1',
        title: 'Offer Letter',
        blocks: [{ type: 'HEADING', text: 'Position' }, { type: 'TEXT', text: 'Senior Engineer' }],
      };
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await db?.end();
      await container?.stop();
    });

    it('generates a FROZEN revision + RENDERED_UNSIGNED artifact with provenance in render_manifest', async () => {
      const docId = await newDocument();
      const result = await service.generateRevision({
        tenant_id: TENANT,
        document_id: docId,
        template_version_id: MODEL.template_version_id,
        model: MODEL,
        actor_id: ACTOR,
        requestId: 'req-1',
      });
      expect(result.revision_number).toBe(1);
      expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
      // Bytes were persisted via the storage port.
      expect(storage.puts.some((p) => p.storage_key === result.storage_locator)).toBe(true);

      const rev = await db.query(
        `SELECT status, content_sha256, mime_type, template_version_id, render_manifest FROM "documents"."DocumentRevision" WHERE id = $1`,
        [result.revision_id],
      );
      expect(rev.rows[0]).toMatchObject({
        status: 'FROZEN',
        content_sha256: result.sha256,
        mime_type: 'application/pdf',
        template_version_id: MODEL.template_version_id,
      });
      expect(rev.rows[0].render_manifest.provenance.renderer).toBe('PDF_LIB');
      expect(rev.rows[0].render_manifest.provenance.output_sha256).toBe(result.sha256);

      const art = await db.query(
        `SELECT artifact_role, storage_locator, sha256, immutability_state FROM "documents"."DocumentArtifact" WHERE id = $1`,
        [result.artifact_id],
      );
      expect(art.rows[0]).toMatchObject({
        artifact_role: 'RENDERED_UNSIGNED',
        storage_locator: result.storage_locator,
        sha256: result.sha256,
        immutability_state: 'FROZEN',
      });
    });

    it('is hash-stable across revisions (same model -> same sha256, incrementing revision_number)', async () => {
      const docId = await newDocument();
      const r1 = await service.generateRevision({ tenant_id: TENANT, document_id: docId, model: MODEL, actor_id: ACTOR, requestId: 'a' });
      const r2 = await service.generateRevision({ tenant_id: TENANT, document_id: docId, model: MODEL, actor_id: ACTOR, requestId: 'b' });
      expect(r1.sha256).toBe(r2.sha256);
      expect(r2.revision_number).toBe(r1.revision_number + 1);
    });
  },
);
