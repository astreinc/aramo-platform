import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

import express from 'express';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DocumentsRepository,
  DocumentIdempotencyService,
  DocumentExecutedWriteBackService,
  PrismaService as DocumentsPrismaService,
  type DocumentStoragePort,
} from '@aramo/documents';

import { DocumentReadinessGate } from '../rtr/document-readiness.gate.js';
import { EsignEventsController } from '../integrations/esign/esign-events.controller.js';
import { EsignWriteBackOrchestrator, EsignExecutedArtifactsClient } from '../documents/esign-writeback.js';

// OC-6 — the RTR readiness END-TO-END proof through the REAL signed-webhook path.
//
// Envelope COMPLETED (generic event) → HMAC+timestamp-signed webhook → the REAL
// EsignEventsController receiver (POST /v1/integrations/esign/events, HMAC verified
// with the STRICT production window) → EsignWriteBackOrchestrator (in-process) →
// DocumentExecutedWriteBackService.storeExecuted (real SHA-256 validation + the real
// documents schema) → canonical Document = EXECUTED → the REAL DocumentReadinessGate
// becomes satisfied. The test NEVER calls writeBackEnvelope directly — it POSTs the
// signed webhook, exactly as the E-Sign delivery worker would.
//
// Only the two ALREADY-CONTRACT-COVERED boundaries are stubbed: the executed-artifact
// PULL (esign-consumer Pact) and the object-storage port. SHA-256 values are kept
// internally consistent so storeExecuted exercises its real hash-integrity path.
// The webhook event is GENERIC E-Sign vocabulary — no RTR/Offer semantics in it.

const ROOT = resolve(__dirname, '../../../..');
const mig = (p: string): string => resolve(ROOT, p);
const MIGRATIONS = [
  'libs/documents/prisma/migrations/20260921180000_init_documents_model/migration.sql',
  'libs/documents/prisma/migrations/20260922130000_doc2_templates_rendering_requirements/migration.sql',
  'libs/documents/prisma/migrations/20260923170000_doc5_seed_rtr_document_type/migration.sql',
].map(mig);

// The DOC-5-seeded RIGHT_TO_REPRESENT SYSTEM DocumentType (fixed id + key).
const RTR_TYPE_ID = 'd0c50005-0000-7000-8000-000000000001';
const WEBHOOK_SECRET = 'oc6-e2e-esign-webhook-secret';
const TS_HEADER = 'x-aramo-esign-timestamp';
const SIG_HEADER = 'x-aramo-esign-signature';

const sha256Hex = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'OC-6 RTR readiness E2E — real signed webhook → write-back → EXECUTED → readiness (Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let sql: Client;
    let docsPrisma: DocumentsPrismaService;
    let app: INestApplication;
    let baseUrl: string;
    let readiness: DocumentReadinessGate;

    const TENANT = randomUUID();
    const ACTOR = randomUUID();
    const TALENT = randomUUID();
    const REQUISITION = randomUUID();
    const WRONG_REQUISITION = randomUUID();
    const DOC_ID = randomUUID();
    const REV_ID = randomUUID();
    const ENVELOPE_ID = randomUUID();
    const ENVELOPE_DOC_ID = randomUUID();

    // The executed artifacts the (stubbed, contract-covered) esign pull returns.
    const executedBytes = Buffer.from('%PDF-1.4 executed-rtr-document');
    const certBytes = Buffer.from('%PDF-1.4 rtr-execution-certificate');
    const executedSha = sha256Hex(executedBytes);
    const certSha = sha256Hex(certBytes);

    const savedSecret = process.env['ESIGN_WEBHOOK_SIGNING_SECRET'];

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      sql = new Client({ connectionString: url });
      await sql.connect();
      for (const p of MIGRATIONS) await sql.query(readFileSync(p, 'utf8'));

      docsPrisma = new DocumentsPrismaService(url);
      await docsPrisma.$connect();

      // Seed the RTR canonical Document (PREPARED) + a FROZEN revision + the joint
      // associations + an RTR requirement for BOTH requisitions (so the gate is
      // CONDITIONAL-active for each; the executed doc is associated to REQUISITION only).
      await sql.query(
        `INSERT INTO documents."Document" (id, tenant_id, document_type_id, title, status, execution_mode, source_kind, created_by, prepared_at)
         VALUES ($1,$2,$3,'Right to Represent','PREPARED','SINGLE_SIGNATURE','TEMPLATE_GENERATED',$4, now())`,
        [DOC_ID, TENANT, RTR_TYPE_ID, ACTOR],
      );
      await sql.query(
        `INSERT INTO documents."DocumentRevision" (id, tenant_id, document_id, revision_number, mime_type, byte_size, status, created_by, frozen_at)
         VALUES ($1,$2,$3,1,'application/pdf',100,'FROZEN',$4, now())`,
        [REV_ID, TENANT, DOC_ID, ACTOR],
      );
      await sql.query(
        `INSERT INTO documents."DocumentAssociation" (id, tenant_id, document_id, resource_type, resource_id, relationship, created_by)
         VALUES ($1,$2,$3,'TALENT',$4,'SUBJECT',$5), ($6,$2,$3,'REQUISITION',$7,'REGARDING',$5)`,
        [randomUUID(), TENANT, DOC_ID, TALENT, ACTOR, randomUUID(), REQUISITION],
      );
      await sql.query(
        `INSERT INTO documents."DocumentRequirement" (id, tenant_id, document_type_id, resource_type, resource_id, status, created_by)
         VALUES ($1,$2,$3,'REQUISITION',$4,'UNSATISFIED',$5), ($6,$2,$3,'REQUISITION',$7,'UNSATISFIED',$5)`,
        [randomUUID(), TENANT, RTR_TYPE_ID, REQUISITION, ACTOR, randomUUID(), WRONG_REQUISITION],
      );

      // Stub ONLY the contract-covered executed-artifact pull + the storage port.
      const stubClient = {
        fetchExecuted: async () => ({
          envelope_id: ENVELOPE_ID,
          documents: [
            {
              envelope_document_id: ENVELOPE_DOC_ID,
              document_ref: DOC_ID,
              document_revision_ref: REV_ID,
              executed_sha256: executedSha,
              byte_size: executedBytes.byteLength,
              executed_base64: executedBytes.toString('base64'),
            },
          ],
          certificate: {
            certificate_sha256: certSha,
            byte_size: certBytes.byteLength,
            certificate_base64: certBytes.toString('base64'),
          },
        }),
      } as unknown as EsignExecutedArtifactsClient;

      const storageStub = {
        putArtifact: async () => ({ storage_key: 'stub', sha256: 'stub', byte_size: 0 }),
        getArtifact: async () => Buffer.alloc(0),
        createReadAccess: async () => ({ url: 'stub', expires_at: new Date().toISOString() }),
        createWriteAccess: async () => ({ url: 'stub', expires_at: new Date().toISOString() }),
        headArtifact: async () => ({ exists: true, byte_size: 0, sha256: 'stub' }),
        verifyArtifact: async () => true,
        applyRetention: async () => undefined,
        applyLegalHold: async () => undefined,
      } as unknown as DocumentStoragePort;

      const writeBack = new DocumentExecutedWriteBackService(
        docsPrisma,
        storageStub,
        new DocumentIdempotencyService(docsPrisma),
      );

      const moduleRef = await Test.createTestingModule({
        controllers: [EsignEventsController],
        providers: [
          EsignWriteBackOrchestrator,
          { provide: EsignExecutedArtifactsClient, useValue: stubClient },
          { provide: DocumentExecutedWriteBackService, useValue: writeBack },
        ],
      }).compile();

      app = moduleRef.createNestApplication();
      // Mirror apps/api/src/main.ts: the receiver reads the RAW signed bytes, so a
      // route-scoped raw parser is mounted BEFORE Nest's json parser.
      app.use('/v1/integrations/esign/events', express.raw({ type: () => true }));
      await app.init();
      const server = await app.listen(0);
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;

      process.env['ESIGN_WEBHOOK_SIGNING_SECRET'] = WEBHOOK_SECRET;

      readiness = new DocumentReadinessGate(
        new DocumentsRepository(docsPrisma, new DocumentIdempotencyService(docsPrisma)),
      );
    }, 180_000);

    afterAll(async () => {
      if (savedSecret === undefined) delete process.env['ESIGN_WEBHOOK_SIGNING_SECRET'];
      else process.env['ESIGN_WEBHOOK_SIGNING_SECRET'] = savedSecret;
      await app?.close();
      await docsPrisma?.$disconnect();
      await sql?.end();
      await container?.stop();
    });

    it('closes the RTR loop: not-executed → real webhook → EXECUTED + readiness satisfied; wrong requisition stays unsatisfied', async () => {
      // (1) BEFORE — the RTR requirement exists but no executed document → denied.
      const before = await readiness.assess({ tenant_id: TENANT, talent_id: TALENT, requisition_id: REQUISITION });
      expect(before.satisfied).toBe(false);
      expect(before.deny).toBe('SUBMITTAL_RTR_NOT_EXECUTED');

      // (2) The GENERIC signed webhook (no RTR semantics), delivered to the REAL
      // receiver with the strict production HMAC+timestamp window.
      const event = {
        event_id: randomUUID(),
        event_type: 'esign.envelope.executed.v1',
        event_version: 1,
        occurred_at: new Date().toISOString(),
        tenant_id: TENANT,
        envelope_id: ENVELOPE_ID,
        correlation_id: randomUUID(),
        artifact_refs: { executed_document_ids: [ENVELOPE_DOC_ID], has_certificate: true },
      };
      const rawBody = JSON.stringify(event);
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.${rawBody}`).digest('base64');

      const res = await fetch(`${baseUrl}/v1/integrations/esign/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [TS_HEADER]: ts, [SIG_HEADER]: sig },
        body: rawBody,
      });
      expect(res.status).toBe(200);

      // (3) AFTER — the canonical Document is EXECUTED (via the real write-back) …
      const doc = await docsPrisma.document.findUniqueOrThrow({ where: { id: DOC_ID } });
      expect(doc.status).toBe('EXECUTED');
      // … the EXECUTED + EXECUTION_CERTIFICATE artifacts were stored (real SHA path) …
      const roles = (
        await docsPrisma.documentArtifact.findMany({ where: { document_id: DOC_ID }, select: { artifact_role: true } })
      ).map((a) => a.artifact_role);
      expect(roles).toEqual(expect.arrayContaining(['EXECUTED', 'EXECUTION_CERTIFICATE']));
      // … and RTR readiness is now satisfied for the EXACT (talent, requisition).
      const after = await readiness.assess({ tenant_id: TENANT, talent_id: TALENT, requisition_id: REQUISITION });
      expect(after.satisfied).toBe(true);
      expect(after.deny).toBeNull();

      // (4) The same Talent on the WRONG requisition is still NOT satisfied — the
      // readiness predicate is requisition-exact (same-document, joint associations).
      const wrong = await readiness.assess({ tenant_id: TENANT, talent_id: TALENT, requisition_id: WRONG_REQUISITION });
      expect(wrong.satisfied).toBe(false);
      expect(wrong.deny).toBe('SUBMITTAL_RTR_NOT_EXECUTED');
    });

    it('rejects an unsigned webhook (auth is enforced, not bypassed by the E2E)', async () => {
      const rawBody = JSON.stringify({ event_id: randomUUID(), event_type: 'esign.envelope.executed.v1', tenant_id: TENANT, envelope_id: ENVELOPE_ID });
      const res = await fetch(`${baseUrl}/v1/integrations/esign/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: rawBody,
      });
      expect(res.status).toBe(401);
    });
  },
);
