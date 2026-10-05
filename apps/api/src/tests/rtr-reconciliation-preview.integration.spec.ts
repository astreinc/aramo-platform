import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { AramoError, ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import {
  DocumentsRepository,
  RenderService,
  TemplatesRepository,
  DocumentIdempotencyService,
  PrismaService as DocumentsPrismaService,
  type DocumentStoragePort,
} from '@aramo/documents';
import { PdfLibDocumentRenderingAdapter } from '@aramo/documents-rendering';
import { type SignatureProviderPort } from '@aramo/documents-contracts';
import { type TalentRecordRepository } from '@aramo/talent-record';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RIGHT_TO_REPRESENT_TYPE_ID } from '../rtr/rtr-constants.js';
import { RtrOrchestratorService } from '../rtr/rtr-orchestrator.service.js';
import { RtrTemplateResolverService } from '../rtr/rtr-template-resolver.service.js';
import { RtrTemplateBindingService } from '../rtr/rtr-template-binding.service.js';
import { DEFAULT_RTR_TEMPLATE_CONTENT_V1, RTR_GENERATED_SCHEMA_V1 } from '../rtr/rtr-template-content.js';

// RTR-TEMPLATE-1 (§13, §14, §15, §16) — reconciliation + preview on real Postgres.
// Proves the FE can reconstruct the exact current RTR state and preview the exact
// frozen unsigned artifact WITHOUT consulting today's active template or exposing
// storage internals. The critical property: provenance is from the PINNED version
// the document used, never DocumentTemplate.current_version_id.

const ROOT = resolve(__dirname, '../../../..');
const ACTOR = randomUUID();
const OFFER_LETTER_TYPE_ID = 'd0c50006-0000-7000-8000-000000000001';
const PRESIGNED_PREFIX = 'https://presigned.example/rtr/';

function documentsMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/documents/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
    throw new Error(`expected AramoError ${code}, but the call succeeded`);
  } catch (e) {
    expect(e).toBeInstanceOf(AramoError);
    expect((e as AramoError).code).toBe(code);
  }
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'RTR-TEMPLATE-1 reconciliation + preview — real Postgres 17',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let prisma: DocumentsPrismaService;
    let docsRepo: DocumentsRepository;
    let templates: TemplatesRepository;
    let orchestrator: RtrOrchestratorService;
    let lastReadKey: string | null = null;

    async function activeRtrTemplate(tenant: string): Promise<{ templateId: string; v1: string }> {
      const tpl = await templates.createTemplate({
        tenant_id: tenant,
        document_type_id: RIGHT_TO_REPRESENT_TYPE_ID,
        name: 'Standard Right to Represent',
        template_kind: 'GENERATED',
        created_by: ACTOR,
      });
      const ver = await templates.createVersion({
        tenant_id: tenant,
        template_id: tpl.id,
        render_schema_version: RTR_GENERATED_SCHEMA_V1,
        field_schema: DEFAULT_RTR_TEMPLATE_CONTENT_V1,
        created_by: ACTOR,
      });
      await templates.activateVersion({ tenant_id: tenant, version_id: ver.id, actor_id: ACTOR });
      return { templateId: tpl.id, v1: ver.id };
    }

    async function requestRtr(tenant: string): Promise<{ document_id: string; talent: string; requisition: string }> {
      const talent = randomUUID();
      const requisition = randomUUID();
      const { document_id } = await orchestrator.request({
        tenant_id: tenant,
        talent_id: talent,
        requisition_id: requisition,
        company_id: randomUUID(),
        created_by: ACTOR,
        requestId: randomUUID(),
      });
      return { document_id, talent, requisition };
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of documentsMigrations()) await db.query(readFileSync(p, 'utf8'));
      prisma = new DocumentsPrismaService(url);
      await prisma.$connect();
      docsRepo = new DocumentsRepository(prisma, new DocumentIdempotencyService(prisma));
      templates = new TemplatesRepository(prisma);

      const storageStub = {
        putArtifact: async () => ({ storage_key: 'stub', sha256: 'stub', byte_size: 0 }),
        getArtifact: async () => Buffer.alloc(0),
        // Presigned read access NEVER echoes the storage key: it mints an opaque URL.
        createReadAccess: async ({ storage_key }: { storage_key: string }) => {
          lastReadKey = storage_key;
          return { url: `${PRESIGNED_PREFIX}${randomUUID()}`, expires_at: new Date(0).toISOString() };
        },
        createWriteAccess: async () => ({ url: 'stub', expires_at: new Date(0).toISOString() }),
        headArtifact: async () => ({ byte_length: 0, content_type: undefined }),
        verifyArtifact: async () => true,
        applyRetention: async () => undefined,
        applyLegalHold: async () => undefined,
      } as unknown as DocumentStoragePort;

      const render = new RenderService(prisma, new PdfLibDocumentRenderingAdapter(), storageStub);
      const resolver = new RtrTemplateResolverService(templates);
      const fakeTalent = {
        findById: async () => ({ first_name: 'Jordan', last_name: 'Lee', email1: 'jordan.lee@example.com' }),
      } as unknown as TalentRecordRepository;
      const binding = new RtrTemplateBindingService(fakeTalent);
      const fakeSignature = {
        createEnvelope: async () => ({ envelope_id: 'env-1' }),
        sendEnvelope: async () => ({ status: 'SENT' }),
        // COMM-RECRUITER-W1 (W1-C1) — dup-send guard: no pre-existing envelope.
        findEnvelopeForDocument: async () => null,
      } as unknown as SignatureProviderPort;

      orchestrator = new RtrOrchestratorService(docsRepo, render, fakeSignature, fakeTalent, resolver, binding, templates, storageStub);
    }, 180_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await db?.end();
      await container?.stop();
    });

    it('current() returns null when no RTR exists for the (tenant, talent, requisition)', async () => {
      const result = await orchestrator.current({
        tenant_id: randomUUID(),
        talent_id: randomUUID(),
        requisition_id: randomUUID(),
        requestId: randomUUID(),
      });
      expect(result).toBeNull();
    });

    it('current() reconstructs status + availability, with provenance from the PINNED version (NOT current_version_id)', async () => {
      const tenant = randomUUID();
      const { templateId } = await activeRtrTemplate(tenant);
      const { document_id, talent, requisition } = await requestRtr(tenant);

      // A NEW version becomes active AFTER request → current_version_id = v2.
      const v2 = await templates.createVersion({
        tenant_id: tenant,
        template_id: templateId,
        render_schema_version: RTR_GENERATED_SCHEMA_V1,
        field_schema: DEFAULT_RTR_TEMPLATE_CONTENT_V1,
        created_by: ACTOR,
      });
      await templates.activateVersion({ tenant_id: tenant, version_id: v2.id, actor_id: ACTOR });

      const cur = await orchestrator.current({ tenant_id: tenant, talent_id: talent, requisition_id: requisition, requestId: randomUUID() });
      expect(cur).not.toBeNull();
      expect(cur?.document_id).toBe(document_id);
      expect(cur?.status).toBe('REQUESTED');
      expect(cur?.document_status).toBe('DRAFT');
      // Provenance is the PINNED v1 (version_number 1), NOT the now-active v2.
      expect(cur?.template).toEqual({ name: 'Standard Right to Represent', version_number: 1 });
      expect(cur?.preview_available).toBe(true);
      expect(cur?.executed_available).toBe(false);
      expect(cur?.certificate_available).toBe(false);
    });

    it('preview() returns presigned access to the frozen revision bytes and never exposes the storage key', async () => {
      const tenant = randomUUID();
      await activeRtrTemplate(tenant);
      const { document_id } = await requestRtr(tenant);
      const rev = await docsRepo.getCurrentRevision(tenant, document_id);

      const preview = await orchestrator.preview(tenant, document_id, randomUUID());
      expect(preview.content_sha256).toBe(rev?.content_sha256); // exact frozen bytes
      expect(preview.url.startsWith(PRESIGNED_PREFIX)).toBe(true);
      // The storage key (content-addressed, tenant-pathed) is what the port was
      // asked for, but is NEVER returned to the recruiter.
      expect(lastReadKey).toContain(`documents/${tenant}/${document_id}/rendered/`);
      expect(preview.url).not.toContain(tenant);
      expect(preview.url).not.toContain('documents/');
    });

    it('preview() rejects a cross-tenant document (DOCUMENT_NOT_FOUND)', async () => {
      const tenant = randomUUID();
      await activeRtrTemplate(tenant);
      const { document_id } = await requestRtr(tenant);
      await expectCode(orchestrator.preview(randomUUID(), document_id, randomUUID()), 'DOCUMENT_NOT_FOUND');
    });

    it('preview() rejects a non-RTR document (DOCUMENT_NOT_FOUND)', async () => {
      const tenant = randomUUID();
      const offerDoc = await docsRepo.createDocument({
        tenant_id: tenant,
        document_type_id: OFFER_LETTER_TYPE_ID,
        title: 'Offer',
        execution_mode: 'SINGLE_SIGNATURE',
        source_kind: 'TEMPLATE_GENERATED',
        created_by: ACTOR,
        associations: [],
        request_id: randomUUID(),
      });
      await expectCode(orchestrator.preview(tenant, offerDoc.id, randomUUID()), 'DOCUMENT_NOT_FOUND');
    });

    it('preview() fails closed when the RTR has no frozen revision (RTR_PREVIEW_NOT_AVAILABLE)', async () => {
      const tenant = randomUUID();
      const bare = await docsRepo.createDocument({
        tenant_id: tenant,
        document_type_id: RIGHT_TO_REPRESENT_TYPE_ID,
        title: 'Right to Represent',
        execution_mode: 'SINGLE_SIGNATURE',
        source_kind: 'TEMPLATE_GENERATED',
        created_by: ACTOR,
        associations: [],
        request_id: randomUUID(),
      });
      await expectCode(orchestrator.preview(tenant, bare.id, randomUUID()), 'RTR_PREVIEW_NOT_AVAILABLE');
    });
  },
);
