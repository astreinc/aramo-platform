import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { RIGHT_TO_REPRESENT_TYPE_ID } from '../rtr/rtr-constants.js';
import { RtrOrchestratorService } from '../rtr/rtr-orchestrator.service.js';
import { RtrTemplateResolverService } from '../rtr/rtr-template-resolver.service.js';
import { RtrTemplateBindingService } from '../rtr/rtr-template-binding.service.js';
import { DEFAULT_RTR_TEMPLATE_CONTENT_V1, RTR_GENERATED_SCHEMA_V1 } from '../rtr/rtr-template-content.js';

// RTR-TEMPLATE-1 (§12, §34, INV-3) — the SEND INVARIANT, with guard assertions.
// send() consumes the already-frozen RTR revision. A template version activated
// AFTER request cannot change what is sent, and send() must touch NEITHER the
// resolver NOR the binding NOR the renderer. The spies below are protection
// against future refactors silently reintroducing a resolve/render on send.

const ROOT = resolve(__dirname, '../../../..');
const ACTOR = randomUUID();

function documentsMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/documents/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'RTR-TEMPLATE-1 send invariant — real Postgres 17',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let prisma: DocumentsPrismaService;
    let docsRepo: DocumentsRepository;
    let templates: TemplatesRepository;
    let resolver: RtrTemplateResolverService;
    let binding: RtrTemplateBindingService;
    let render: RenderService;
    let orchestrator: RtrOrchestratorService;
    const captured: { documents?: Array<{ document_revision_ref: string; source_sha256: string }> } = {};

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
        createReadAccess: async () => ({ url: 'stub', expires_at: new Date(0).toISOString() }),
        createWriteAccess: async () => ({ url: 'stub', expires_at: new Date(0).toISOString() }),
        headArtifact: async () => ({ byte_length: 0, content_type: undefined }),
        verifyArtifact: async () => true,
        applyRetention: async () => undefined,
        applyLegalHold: async () => undefined,
      } as unknown as DocumentStoragePort;

      render = new RenderService(prisma, new PdfLibDocumentRenderingAdapter(), storageStub);
      resolver = new RtrTemplateResolverService(templates);
      const fakeTalent = {
        findById: async () => ({ first_name: 'Jordan', last_name: 'Lee', email1: 'jordan.lee@example.com' }),
      } as unknown as TalentRecordRepository;
      binding = new RtrTemplateBindingService(fakeTalent);
      const fakeSignature = {
        createEnvelope: async (input: { documents: Array<{ document_revision_ref: string; source_sha256: string }> }) => {
          captured.documents = input.documents;
          return { envelope_id: 'env-1' };
        },
        sendEnvelope: async () => ({ status: 'SENT' }),
      } as unknown as SignatureProviderPort;

      orchestrator = new RtrOrchestratorService(docsRepo, render, fakeSignature, fakeTalent, resolver, binding, templates, storageStub);
    }, 180_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await db?.end();
      await container?.stop();
    });

    it('send consumes R1/AAA and never re-resolves, re-binds, or re-renders after a later activation', async () => {
      const tenant = randomUUID();
      const talent = randomUUID();
      const { templateId, v1 } = await activeRtrTemplate(tenant);

      const spyResolve = vi.spyOn(resolver, 'resolveActive');
      const spyBind = vi.spyOn(binding, 'bind');
      const spyRender = vi.spyOn(render, 'generateRevision');

      // request → resolve v1 → bind → render R1 (hash AAA), pinned to v1.
      const { document_id } = await orchestrator.request({
        tenant_id: tenant,
        talent_id: talent,
        requisition_id: randomUUID(),
        company_id: randomUUID(),
        created_by: ACTOR,
        requestId: randomUUID(),
      });
      expect(spyResolve).toHaveBeenCalledTimes(1);
      expect(spyBind).toHaveBeenCalledTimes(1);
      expect(spyRender).toHaveBeenCalledTimes(1);

      const r1 = await docsRepo.getCurrentRevision(tenant, document_id);
      const hashAAA = r1?.content_sha256;
      expect(r1?.template_version_id).toBe(v1);
      expect(hashAAA).toBeTruthy();

      // A NEW version becomes ACTIVE after request (current_version_id → v2).
      const v2 = await templates.createVersion({
        tenant_id: tenant,
        template_id: templateId,
        render_schema_version: RTR_GENERATED_SCHEMA_V1,
        field_schema: DEFAULT_RTR_TEMPLATE_CONTENT_V1,
        created_by: ACTOR,
      });
      await templates.activateVersion({ tenant_id: tenant, version_id: v2.id, actor_id: ACTOR });
      expect(v2.id).not.toBe(v1);

      // send → consumes the existing frozen revision only.
      await orchestrator.send({
        tenant_id: tenant,
        document_id,
        talent_id: talent,
        created_by: ACTOR,
        requestId: randomUUID(),
      });

      // GUARD: send touched NONE of resolver / binding / renderer (call counts
      // unchanged from request). Protects the invariant from future refactors.
      expect(spyResolve).toHaveBeenCalledTimes(1);
      expect(spyBind).toHaveBeenCalledTimes(1);
      expect(spyRender).toHaveBeenCalledTimes(1);

      // Envelope referenced the EXACT frozen revision R1 + its hash AAA.
      expect(captured.documents?.[0]?.document_revision_ref).toBe(r1?.id);
      expect(captured.documents?.[0]?.source_sha256).toBe(hashAAA);

      // No new revision; document provenance remains v1 (NOT v2) — the pinned
      // version on the frozen revision is unchanged by the later activation.
      const after = await docsRepo.getCurrentRevision(tenant, document_id);
      expect(after?.id).toBe(r1?.id);
      expect(after?.revision_number).toBe(1);
      expect(after?.template_version_id).toBe(v1);

      vi.restoreAllMocks();
    });
  },
);
