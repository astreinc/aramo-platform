import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE, AramoExceptionFilter } from '@aramo/common';
import {
  PrismaService as DocumentsPrismaService,
  RevisionSourceService,
  type DocumentStoragePort,
} from '@aramo/documents';
import {
  ESIGN_S2S_SIGNATURE_HEADER,
  ESIGN_S2S_TIMESTAMP_HEADER,
  signEsignServiceRequest,
} from '@aramo/documents-contracts';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { DocumentsEsignController } from '../documents/documents-esign.controller.js';
import { EsignWriteBackOrchestrator } from '../documents/esign-writeback.js';

// ES-2 (Aramo-E-Sign-ES-2-Core-Service-Trust-Implementation-Authorization-v1_0) —
// the Core document-source route that esign-service pulls, over real HTTP on a
// real Postgres 17 documents schema with a controlled fixture revision.
//
//   1. Reproduction: an ANONYMOUS request reads the fixture document's bytes.
//   2. Only a correctly signed esign-service request (aramo-esign-s2s-v1) is
//      served; unsigned / stale / tampered / wrong-path / wrong-query /
//      cross-purpose / malformed requests are refused (401).
//   3. A missing signing secret fails closed (503) in EVERY mode; `log` mode is
//      explicit and time-bounded.
//   4. The unused public write-back route is retired (404); tenant isolation of
//      the source read is unchanged.

const ROOT = resolve(__dirname, '../../../..');
const MIGRATIONS = [
  'libs/documents/prisma/migrations/20260921180000_init_documents_model/migration.sql',
  'libs/documents/prisma/migrations/20260922130000_doc2_templates_rendering_requirements/migration.sql',
  'libs/documents/prisma/migrations/20260923170000_doc5_seed_rtr_document_type/migration.sql',
].map((p) => resolve(ROOT, p));

const RTR_TYPE_ID = 'd0c50005-0000-7000-8000-000000000001';
const SECRET = 'es2-integration-esign-secret';
const SOURCE_BYTES = Buffer.from('%PDF-1.4 es2 controlled fixture source document');
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

const ENV_KEYS = ['ESIGN_WEBHOOK_SIGNING_SECRET', 'ESIGN_S2S_AUTH_MODE', 'ESIGN_S2S_AUTH_LOG_UNTIL'] as const;

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('ES-2 esign-service → Core source request authentication (Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let sql: Client;
  let docsPrisma: DocumentsPrismaService;
  let app: INestApplication;
  let baseUrl: string;
  const writeBackSpy = vi.fn(async () => ({ envelope_id: 'x', documents_written: 0 }));
  const saved: Record<string, string | undefined> = {};

  const TENANT = randomUUID();
  const OTHER_TENANT = randomUUID();
  const ACTOR = randomUUID();
  const DOC_ID = randomUUID();
  const REV_ID = randomUUID();
  const OTHER_REV_ID = randomUUID();
  const STORAGE_KEY = `es2/${REV_ID}.pdf`;

  const sourcePath = (rev: string): string => `/v1/documents/revisions/${rev}/source`;
  const sourceUrl = (rev: string, tenant: string): string => `${baseUrl}${sourcePath(rev)}?tenant_id=${tenant}`;
  const signed = (url: string, opts: { nowSec?: number; secret?: string; method?: string } = {}): Record<string, string> =>
    signEsignServiceRequest({ method: opts.method ?? 'GET', url, secret: opts.secret ?? SECRET, nowSec: opts.nowSec ?? Math.floor(Date.now() / 1000) });

  async function get(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(url, { headers });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      body = { raw: text };
    }
    return { status: res.status, body };
  }

  const errorCode = (body: Record<string, unknown>): unknown => (body['error'] as { code?: unknown } | undefined)?.code ?? body['code'];

  function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>): void {
    for (const k of ENV_KEYS) {
      const v = k in values ? values[k] : k === 'ESIGN_WEBHOOK_SIGNING_SECRET' ? SECRET : undefined;
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  beforeAll(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    sql = new Client({ connectionString: url });
    await sql.connect();
    for (const p of MIGRATIONS) await sql.query(readFileSync(p, 'utf8'));
    docsPrisma = new DocumentsPrismaService(url);
    await docsPrisma.$connect();

    // Controlled fixture: one frozen revision with a SOURCE_UPLOAD artifact.
    await sql.query(
      `INSERT INTO documents."Document" (id, tenant_id, document_type_id, title, status, execution_mode, source_kind, created_by, prepared_at)
       VALUES ($1,$2,$3,'Right to Represent','PREPARED','SINGLE_SIGNATURE','TEMPLATE_GENERATED',$4, now())`,
      [DOC_ID, TENANT, RTR_TYPE_ID, ACTOR],
    );
    await sql.query(
      `INSERT INTO documents."DocumentRevision" (id, tenant_id, document_id, revision_number, mime_type, byte_size, status, created_by, frozen_at)
       VALUES ($1,$2,$3,1,'application/pdf',$4,'FROZEN',$5, now())`,
      [REV_ID, TENANT, DOC_ID, SOURCE_BYTES.byteLength, ACTOR],
    );
    await sql.query(
      `INSERT INTO documents."DocumentArtifact" (id, tenant_id, revision_id, document_id, artifact_role, storage_provider, storage_locator, mime_type, byte_size, sha256, immutability_state, retention_class, created_by)
       VALUES ($1,$2,$3,$4,'SOURCE_UPLOAD','aramo-s3',$5,'application/pdf',$6,$7,'FROZEN','CONTRACT_RECORD',$8)`,
      [randomUUID(), TENANT, REV_ID, DOC_ID, STORAGE_KEY, SOURCE_BYTES.byteLength, sha256(SOURCE_BYTES), ACTOR],
    );

    const storage = {
      getArtifact: async (input: { storage_key: string }) => {
        if (input.storage_key !== STORAGE_KEY) throw new Error(`unexpected storage key ${input.storage_key}`);
        return SOURCE_BYTES;
      },
    } as unknown as DocumentStoragePort;

    const moduleRef = await Test.createTestingModule({
      controllers: [DocumentsEsignController],
      providers: [
        { provide: RevisionSourceService, useValue: new RevisionSourceService(docsPrisma, storage) },
        { provide: EsignWriteBackOrchestrator, useValue: { writeBackEnvelope: writeBackSpy } },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AramoExceptionFilter());
    await app.init();
    const server = await app.listen(0);
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 180_000);

  afterEach(() => setEnv({}));

  afterAll(async () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await app?.close();
    await docsPrisma?.$disconnect();
    await sql?.end();
    await container?.stop();
  });

  describe('anonymous access to a real fixture document is refused', () => {
    it('an unsigned request does not receive the document bytes', async () => {
      setEnv({});
      const r = await get(sourceUrl(REV_ID, TENANT));
      expect(r.body['source_base64']).toBeUndefined();
      expect(r.status).toBe(401);
      expect(errorCode(r.body)).toBe('AUTH_REQUIRED');
    });

    it('the legacy marker header alone is not authentication', async () => {
      setEnv({});
      const r = await get(sourceUrl(REV_ID, TENANT), { 'X-Esign-Service': '1' });
      expect(r.status).toBe(401);
    });
  });

  describe('signed esign-service requests', () => {
    it('a correctly signed request returns the unchanged document bytes', async () => {
      setEnv({});
      const url = sourceUrl(REV_ID, TENANT);
      const r = await get(url, signed(url));
      expect(r.status).toBe(200);
      expect(r.body['revision_id']).toBe(REV_ID);
      expect(sha256(Buffer.from(r.body['source_base64'] as string, 'base64'))).toBe(sha256(SOURCE_BYTES));
    });

    it('tenant isolation is unchanged: a signed request for another tenant finds nothing', async () => {
      setEnv({});
      const url = sourceUrl(REV_ID, OTHER_TENANT);
      const r = await get(url, signed(url));
      expect(r.status).toBe(404);
    });

    it.each([
      ['stale', (url: string) => signed(url, { nowSec: Math.floor(Date.now() / 1000) - 301 })],
      ['future', (url: string) => signed(url, { nowSec: Math.floor(Date.now() / 1000) + 301 })],
      ['wrong secret', (url: string) => signed(url, { secret: 'not-the-secret' })],
      ['wrong method', (url: string) => signed(url, { method: 'POST' })],
      ['wrong path (another revision)', () => signed(sourceUrl(OTHER_REV_ID, TENANT))],
      ['wrong query (another tenant)', () => signed(sourceUrl(REV_ID, OTHER_TENANT))],
      [
        'tampered signature',
        (url: string) => {
          const h = signed(url);
          const s = h[ESIGN_S2S_SIGNATURE_HEADER]!;
          return { ...h, [ESIGN_S2S_SIGNATURE_HEADER]: (s[0] === 'A' ? 'B' : 'A') + s.slice(1) };
        },
      ],
      ['malformed timestamp', (url: string) => ({ ...signed(url), [ESIGN_S2S_TIMESTAMP_HEADER]: 'not-a-number' })],
    ] as const)('refuses a %s signature with 401', async (_label, makeHeaders) => {
      setEnv({});
      const url = sourceUrl(REV_ID, TENANT);
      const r = await get(url, makeHeaders(url));
      expect(r.status).toBe(401);
      expect(r.body['source_base64']).toBeUndefined();
    });

    it('refuses a cross-purpose (lifecycle-webhook) signature', async () => {
      setEnv({});
      const ts = String(Math.floor(Date.now() / 1000));
      const webhookSig = createHmac('sha256', SECRET).update(`${ts}.`).digest('base64');
      const url = sourceUrl(REV_ID, TENANT);
      const asS2s = await get(url, { [ESIGN_S2S_TIMESTAMP_HEADER]: ts, [ESIGN_S2S_SIGNATURE_HEADER]: webhookSig });
      const asWebhook = await get(url, { 'x-aramo-esign-timestamp': ts, 'x-aramo-esign-signature': webhookSig });
      expect(asS2s.status).toBe(401);
      expect(asWebhook.status).toBe(401);
    });

    it('refuses a repeated tenant_id even when one value was signed', async () => {
      setEnv({});
      const url = sourceUrl(REV_ID, TENANT);
      const r = await get(`${url}&tenant_id=${OTHER_TENANT}`, signed(url));
      expect(r.status).toBe(401);
    });
  });

  describe('fail-closed configuration', () => {
    it('a missing signing secret refuses with 503 — even a signed request', async () => {
      setEnv({ ESIGN_WEBHOOK_SIGNING_SECRET: undefined });
      const url = sourceUrl(REV_ID, TENANT);
      const r = await get(url, signed(url));
      expect(r.status).toBe(503);
      expect(errorCode(r.body)).toBe('ESIGN_SERVICE_AUTH_UNAVAILABLE');
    });

    it('log mode never downgrades a missing secret', async () => {
      setEnv({ ESIGN_WEBHOOK_SIGNING_SECRET: undefined, ESIGN_S2S_AUTH_MODE: 'log', ESIGN_S2S_AUTH_LOG_UNTIL: new Date(Date.now() + 3_600_000).toISOString() });
      const r = await get(sourceUrl(REV_ID, TENANT));
      expect(r.status).toBe(503);
    });

    it('explicit, bounded log mode serves an unsigned request during the window', async () => {
      setEnv({ ESIGN_S2S_AUTH_MODE: 'log', ESIGN_S2S_AUTH_LOG_UNTIL: new Date(Date.now() + 3_600_000).toISOString() });
      const r = await get(sourceUrl(REV_ID, TENANT));
      expect(r.status).toBe(200);
    });

    it.each([
      ['no end time', undefined],
      ['an expired end time', new Date(Date.now() - 1_000).toISOString()],
      ['an end time beyond the 7-day ceiling', new Date(Date.now() + 8 * 24 * 3_600_000).toISOString()],
      ['an unparseable end time', 'soon'],
    ] as const)('log mode with %s enforces', async (_label, until) => {
      setEnv({ ESIGN_S2S_AUTH_MODE: 'log', ESIGN_S2S_AUTH_LOG_UNTIL: until });
      const r = await get(sourceUrl(REV_ID, TENANT));
      expect(r.status).toBe(401);
    });

    it('an unknown mode value enforces', async () => {
      setEnv({ ESIGN_S2S_AUTH_MODE: 'off' });
      const r = await get(sourceUrl(REV_ID, TENANT));
      expect(r.status).toBe(401);
    });
  });

  it('the unused public write-back route is retired', async () => {
    setEnv({});
    const res = await fetch(`${baseUrl}/v1/documents/esign-writeback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenant_id: TENANT, envelope_id: randomUUID() }),
    });
    expect(res.status).toBe(404);
    expect(writeBackSpy).not.toHaveBeenCalled();
  });
});
