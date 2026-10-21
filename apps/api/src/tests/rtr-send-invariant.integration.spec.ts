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
import { GovernedDocumentSigningService } from '../document-signing/governed-document-signing.service.js';
import { staticSignatureRouter } from '../document-signing/signature-router.js';
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
const CLIENT_COMPANY = randomUUID();

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
    const captured: { documents?: Array<{ document_revision_ref: string; source_sha256: string }>; subject?: string } = {};

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
      await templates.activateVersion({ tenant_id: tenant, version_id: ver.id, actor_id: ACTOR, require_preview: false });
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
      // T2b: the 4 new resolver repos are unused by the talent.full_name default template.
      binding = new RtrTemplateBindingService(fakeTalent, {} as never, {} as never, {} as never, {} as never);
      const fakeSignature = {
        createEnvelope: async (input: { subject: string; documents: Array<{ document_revision_ref: string; source_sha256: string }> }) => {
          captured.documents = input.documents;
          captured.subject = input.subject;
          return { envelope_id: 'env-1' };
        },
        sendEnvelope: async () => ({ status: 'SENT' }),
        // COMM-RECRUITER-W1 (W1-C1) — dup-send guard: no pre-existing envelope.
        findEnvelopeForDocument: async () => null,
      } as unknown as SignatureProviderPort;

      // Slice 1 (C) — request() derives the CLIENT company from the requisition; the
      // supplied company_id must match it.
      // v1.2 §5.6 — the pre-send CONTACT_SEND gate reads the requisition status (open here).
      const fakeRequisitions = { findCompanyId: async () => CLIENT_COMPANY, findStatusById: async () => 'open' } as never;
      orchestrator = new RtrOrchestratorService(docsRepo, new GovernedDocumentSigningService(docsRepo, render, staticSignatureRouter(fakeSignature)), fakeTalent, resolver, binding, templates, storageStub, fakeRequisitions);
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
        company_id: CLIENT_COMPANY,
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
      await templates.activateVersion({ tenant_id: tenant, version_id: v2.id, actor_id: ACTOR, require_preview: false });
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

    // Amendment A1 — an ACTIVE rtr-html-v1 template renders through the REAL pdf-lib rich
    // path on real Postgres: frozen revision pinned to the version, rich manifest, the
    // signature block geometry, and send consumes it without re-rendering.
    it('rtr-html-v1: request renders the rich content into a frozen revision; send consumes it', async () => {
      const tenant = randomUUID();
      const tpl = await templates.createTemplate({ tenant_id: tenant, document_type_id: RIGHT_TO_REPRESENT_TYPE_ID, name: 'HTML RTR', template_kind: 'GENERATED', created_by: ACTOR });
      const v = await templates.createVersion({
        tenant_id: tenant,
        template_id: tpl.id,
        render_schema_version: 'rtr-html-v1',
        field_schema: { render_schema_version: 'rtr-html-v1', title: 'Exclusive RTR', html: '<h2>Scope</h2><p>For <b><span data-field="talent.full_name"></span></b></p><ul><li>one</li><li>two</li></ul>', logo: null },
        created_by: ACTOR,
      });
      await templates.activateVersion({ tenant_id: tenant, version_id: v.id, actor_id: ACTOR, require_preview: false });
      const { document_id } = await orchestrator.request({ tenant_id: tenant, talent_id: randomUUID(), requisition_id: randomUUID(), created_by: ACTOR, requestId: randomUUID() });
      const frozen = await docsRepo.getCurrentRevision(tenant, document_id);
      expect(frozen?.template_version_id).toBe(v.id);
      const manifest = frozen?.render_manifest as { model: { render_schema_version: string; rich_blocks: unknown[]; bound_html?: unknown }; signature_fields: unknown[] };
      expect(manifest.model.render_schema_version).toBe('rich-v1');
      expect(manifest.model.rich_blocks).toHaveLength(3);
      expect(manifest.model.bound_html).toBeUndefined();
      expect(manifest.signature_fields).toHaveLength(3);
      await orchestrator.send({ tenant_id: tenant, document_id, talent_id: randomUUID(), created_by: ACTOR, requestId: randomUUID() });
      expect(captured.subject).toBe('Exclusive RTR');
      expect(captured.documents?.[0]?.source_sha256).toBe(frozen?.content_sha256);
    });

    // Document Templates slice 1 (E, PO ruling 3) — Document.title + envelope subject
    // follow the admin's document title from the PINNED version; a later activation
    // with a different title cannot change the subject of an already-requested RTR.
    it('Document.title and the envelope subject come from the pinned version title, not a later activation', async () => {
      const tenant = randomUUID();
      const tpl = await templates.createTemplate({
        tenant_id: tenant,
        document_type_id: RIGHT_TO_REPRESENT_TYPE_ID,
        name: 'Exclusive RTR',
        template_kind: 'GENERATED',
        created_by: ACTOR,
      });
      const v1 = await templates.createVersion({
        tenant_id: tenant,
        template_id: tpl.id,
        render_schema_version: RTR_GENERATED_SCHEMA_V1,
        field_schema: { ...DEFAULT_RTR_TEMPLATE_CONTENT_V1, title: 'Exclusive Right to Represent Agreement' },
        created_by: ACTOR,
      });
      await templates.activateVersion({ tenant_id: tenant, version_id: v1.id, actor_id: ACTOR, require_preview: false });

      const { document_id } = await orchestrator.request({
        tenant_id: tenant,
        talent_id: randomUUID(),
        requisition_id: randomUUID(),
        created_by: ACTOR,
        requestId: randomUUID(),
      });
      expect((await docsRepo.getDocument(tenant, document_id)).title).toBe('Exclusive Right to Represent Agreement');
      // B2 — the frozen revision carries the renderer-computed signature-block geometry.
      const frozen = await docsRepo.getCurrentRevision(tenant, document_id);
      const manifest = frozen?.render_manifest as { signature_fields?: Array<{ field_type: string }>; model?: { signature_block?: unknown } };
      expect(manifest.signature_fields?.map((f) => f.field_type)).toEqual(['SIGNATURE', 'SIGNER_NAME', 'SIGN_DATE']);
      expect(manifest.model?.signature_block).toEqual({ printed_name: 'Jordan Lee' });

      const v2 = await templates.createVersion({
        tenant_id: tenant,
        template_id: tpl.id,
        render_schema_version: RTR_GENERATED_SCHEMA_V1,
        field_schema: { ...DEFAULT_RTR_TEMPLATE_CONTENT_V1, title: 'Some Later Title' },
        created_by: ACTOR,
      });
      await templates.activateVersion({ tenant_id: tenant, version_id: v2.id, actor_id: ACTOR, require_preview: false });

      await orchestrator.send({ tenant_id: tenant, document_id, talent_id: randomUUID(), created_by: ACTOR, requestId: randomUUID() });
      expect(captured.subject).toBe('Exclusive Right to Represent Agreement');
    });
  },
);
