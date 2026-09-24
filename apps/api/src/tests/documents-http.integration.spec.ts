import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AramoExceptionFilter } from '@aramo/common';
import { JwtAuthGuard } from '@aramo/auth';
import { EntitlementGuard } from '@aramo/entitlement';
import { DocumentsModule } from '@aramo/documents';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// DOC-1a boundary 6 — HTTP surface over real Postgres 17. JwtAuthGuard and
// EntitlementGuard are overridden to inject a test AuthContext; RolesGuard runs
// for real so scope-gating (403) is genuinely exercised.

const ROOT = resolve(__dirname, '../../../..');
const READ = ['document:read'];
const ADMIN = ['document:read', 'document:create', 'document:manage'];

let testAuth: { tenant_id: string; sub: string; scopes: string[]; site_id: string | null };

function documentsMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/documents/prisma/migrations');
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('DOC-1a documents HTTP — real Postgres 17', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let app: INestApplication;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17').start();
    const url = container.getConnectionUri();
    process.env['DATABASE_URL'] = url;
    db = new Client({ connectionString: url });
    await db.connect();
    for (const p of documentsMigrations()) await db.query(readFileSync(p, 'utf8'));

    const moduleRef = await Test.createTestingModule({ imports: [DocumentsModule] })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: { switchToHttp(): { getRequest(): Record<string, unknown> } }) => {
          const req = ctx.switchToHttp().getRequest();
          req['authContext'] = testAuth;
          req['requestId'] = 'test-req';
          return true;
        },
      })
      .overrideGuard(EntitlementGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AramoExceptionFilter());
    await app.init();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await container?.stop();
  });

  const TENANT_A = randomUUID();
  const TENANT_B = randomUUID();
  const ACTOR = randomUUID();

  beforeEach(() => {
    testAuth = { tenant_id: TENANT_A, sub: ACTOR, scopes: ADMIN, site_id: null };
  });

  async function createType(): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/v1/document-types')
      .send({
        key: `RTR_${randomUUID().slice(0, 8)}`,
        name: 'Right to Represent',
        scope: 'TENANT',
        execution_mode_default: 'SINGLE_SIGNATURE',
        retention_class: 'CONTRACT_RECORD',
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  async function createDocument(typeId: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/v1/documents')
      .send({
        document_type_id: typeId,
        title: 'RTR for Jane',
        execution_mode: 'SINGLE_SIGNATURE',
        source_kind: 'TEMPLATE_GENERATED',
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  it('creates a document type, a document, and reads it back (tenant-scoped)', async () => {
    const typeId = await createType();
    const docId = await createDocument(typeId);
    const get = await request(app.getHttpServer()).get(`/v1/documents/${docId}`);
    expect(get.status).toBe(200);
    expect(get.body.status).toBe('DRAFT');
    // Cross-tenant read -> 404.
    testAuth = { tenant_id: TENANT_B, sub: ACTOR, scopes: ADMIN, site_id: null };
    const cross = await request(app.getHttpServer()).get(`/v1/documents/${docId}`);
    expect(cross.status).toBe(404);
    expect(cross.body.error.code).toBe('DOCUMENT_NOT_FOUND');
  });

  it('prepare transitions DRAFT->PREPARED and is idempotent as a no-op', async () => {
    const docId = await createDocument(await createType());
    const p1 = await request(app.getHttpServer()).post(`/v1/documents/${docId}/prepare`);
    expect(p1.status).toBe(200);
    expect(p1.body.status).toBe('PREPARED');
    const p2 = await request(app.getHttpServer()).post(`/v1/documents/${docId}/prepare`);
    expect(p2.status).toBe(200);
    expect(p2.body.status).toBe('PREPARED');
    const events = await request(app.getHttpServer()).get(`/v1/documents/${docId}/events`);
    expect(events.status).toBe(200);
    // exactly CREATED + PREPARED (no-op appended nothing).
    expect(events.body.map((e: { event_type: string }) => e.event_type)).toEqual(['DOCUMENT_CREATED', 'DOCUMENT_PREPARED']);
  });

  it('enforces scope-gating: create without document:create -> 403', async () => {
    const typeId = await createType();
    testAuth = { tenant_id: TENANT_A, sub: ACTOR, scopes: READ, site_id: null };
    const res = await request(app.getHttpServer())
      .post('/v1/documents')
      .send({ document_type_id: typeId, title: 'x', execution_mode: 'SINGLE_SIGNATURE', source_kind: 'TEMPLATE_GENERATED' });
    expect(res.status).toBe(403);
  });

  it('validates controlled vocab: bad association -> 400', async () => {
    const docId = await createDocument(await createType());
    const res = await request(app.getHttpServer())
      .post(`/v1/documents/${docId}/associations`)
      .send({ resource_type: 'CLIENT', resource_id: randomUUID(), relationship: 'SUBJECT' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('honours the Idempotency-Key header (replay returns the same document)', async () => {
    const typeId = await createType();
    const key = randomUUID();
    const body = { document_type_id: typeId, title: 'RTR', execution_mode: 'SINGLE_SIGNATURE', source_kind: 'TEMPLATE_GENERATED' };
    const r1 = await request(app.getHttpServer()).post('/v1/documents').set('Idempotency-Key', key).send(body);
    const r2 = await request(app.getHttpServer()).post('/v1/documents').set('Idempotency-Key', key).send(body);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r2.body.id).toBe(r1.body.id);
    // A different body with the same key -> conflict.
    const r3 = await request(app.getHttpServer())
      .post('/v1/documents')
      .set('Idempotency-Key', key)
      .send({ ...body, title: 'DIFFERENT' });
    expect(r3.status).toBe(409);
    expect(r3.body.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
  });

  it('creates a document with a COMPANY/CLIENT association and lists it via events/artifacts', async () => {
    const typeId = await createType();
    const create = await request(app.getHttpServer())
      .post('/v1/documents')
      .send({
        document_type_id: typeId,
        title: 'RTR',
        execution_mode: 'SINGLE_SIGNATURE',
        source_kind: 'TEMPLATE_GENERATED',
        associations: [{ resource_type: 'COMPANY', resource_id: randomUUID(), relationship: 'CLIENT' }],
      });
    expect(create.status).toBe(201);
    const artifacts = await request(app.getHttpServer()).get(`/v1/documents/${create.body.id}/artifacts`);
    expect(artifacts.status).toBe(200);
    expect(Array.isArray(artifacts.body)).toBe(true);
  });
});
