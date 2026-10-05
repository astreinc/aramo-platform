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

// RTR-TEMPLATE-1 (§11, §12, §34, INV-2/INV-3/INV-12) — the architectural cutover
// proof. RTR is now TEMPLATE-DRIVEN end to end:
//   request -> resolve ACTIVE template v1 -> bind closed catalog -> render FROZEN
//             revision R1 pinned to template_version_id=v1 (hash AAA)
//   activate v2
//   send    -> MUST transmit R1/AAA, MUST NOT re-resolve/re-render, doc stays v1
// Also proves fail-closed with NO inline fallback: no template -> NOT_CONFIGURED;
// unresolvable required binding -> BINDING_MISSING. (The send-side invariant is
// formally enforced/retested in T4; the code is already structured for it here.)

const ROOT = resolve(__dirname, '../../../..');
const ACTOR = randomUUID();
const MISSING_TALENT = randomUUID();

function documentsMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/documents/prisma/migrations');
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
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
  'RTR-TEMPLATE-1 cutover — request/render/send on real Postgres 17',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let prisma: DocumentsPrismaService;
    let docsRepo: DocumentsRepository;
    let templates: TemplatesRepository;
    let orchestrator: RtrOrchestratorService;

    // Captures the LAST createEnvelope input so the test can assert the send path
    // transmitted the exact frozen revision (no re-render).
    const captured: { envelope?: { documents: Array<{ document_revision_ref: string; source_sha256: string }> } } = {};

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
        createReadAccess: async () => ({ url: 'stub', expires_at: new Date().toISOString() }),
        createWriteAccess: async () => ({ url: 'stub', expires_at: new Date().toISOString() }),
        headArtifact: async () => ({ exists: true, byte_size: 0, sha256: 'stub' }),
        verifyArtifact: async () => true,
        applyRetention: async () => undefined,
        applyLegalHold: async () => undefined,
      } as unknown as DocumentStoragePort;

      const render = new RenderService(prisma, new PdfLibDocumentRenderingAdapter(), storageStub);
      const resolver = new RtrTemplateResolverService(templates);

      const fakeTalent = {
        findById: async ({ id }: { tenant_id: string; id: string }) =>
          id === MISSING_TALENT ? null : { first_name: 'Jordan', last_name: 'Lee', email1: 'jordan.lee@example.com' },
      } as unknown as TalentRecordRepository;
      const binding = new RtrTemplateBindingService(fakeTalent);

      const fakeSignature = {
        createEnvelope: async (input: { documents: Array<{ document_revision_ref: string; source_sha256: string }> }) => {
          captured.envelope = { documents: input.documents };
          return { envelope_id: 'env-1' };
        },
        sendEnvelope: async () => ({ status: 'SENT' }),
        // COMM-RECRUITER-W1 (W1-C1) — dup-send guard: no pre-existing envelope.
        findEnvelopeForDocument: async () => null,
      } as unknown as SignatureProviderPort;

      orchestrator = new RtrOrchestratorService(docsRepo, render, fakeSignature, fakeTalent, resolver, binding);
    }, 180_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await db?.end();
      await container?.stop();
    });

    it('request renders a FROZEN revision pinned to the exact template version, with bindings resolved', async () => {
      const tenant = randomUUID();
      const { v1 } = await activeRtrTemplate(tenant);
      const { document_id } = await orchestrator.request({
        tenant_id: tenant,
        talent_id: randomUUID(),
        requisition_id: randomUUID(),
        company_id: randomUUID(),
        created_by: ACTOR,
        requestId: randomUUID(),
      });
      const rev = await docsRepo.getCurrentRevision(tenant, document_id);
      expect(rev).not.toBeNull();
      expect(rev?.status).toBe('FROZEN');
      expect(rev?.template_version_id).toBe(v1); // exact version pinned (INV-2)
      expect(rev?.content_sha256).toBeTruthy();
      // Binding resolved; no raw token reached the rendered model (INV-9/§9).
      const manifest = JSON.stringify(rev?.render_manifest);
      expect(manifest).toContain('Jordan Lee');
      expect(manifest).not.toContain('{{');
    });

    it('send transmits the frozen revision and never re-resolves/re-renders when a newer version is active (§34)', async () => {
      const tenant = randomUUID();
      const talent = randomUUID();
      const { templateId, v1 } = await activeRtrTemplate(tenant);

      const { document_id } = await orchestrator.request({
        tenant_id: tenant,
        talent_id: talent,
        requisition_id: randomUUID(),
        company_id: randomUUID(),
        created_by: ACTOR,
        requestId: randomUUID(),
      });
      const r1 = await docsRepo.getCurrentRevision(tenant, document_id);
      const hashAAA = r1?.content_sha256;

      // A new template version becomes ACTIVE AFTER request.
      const v2 = await templates.createVersion({
        tenant_id: tenant,
        template_id: templateId,
        render_schema_version: RTR_GENERATED_SCHEMA_V1,
        field_schema: DEFAULT_RTR_TEMPLATE_CONTENT_V1,
        created_by: ACTOR,
      });
      await templates.activateVersion({ tenant_id: tenant, version_id: v2.id, actor_id: ACTOR });
      expect(v2.id).not.toBe(v1);

      await orchestrator.send({
        tenant_id: tenant,
        document_id,
        talent_id: talent,
        created_by: ACTOR,
        requestId: randomUUID(),
      });

      // Envelope referenced the EXACT frozen revision R1 + its hash.
      expect(captured.envelope?.documents[0]?.document_revision_ref).toBe(r1?.id);
      expect(captured.envelope?.documents[0]?.source_sha256).toBe(hashAAA);

      // No re-render: still ONE revision, still pinned to v1 (NOT v2).
      const after = await docsRepo.getCurrentRevision(tenant, document_id);
      expect(after?.id).toBe(r1?.id);
      expect(after?.revision_number).toBe(1);
      expect(after?.template_version_id).toBe(v1);
    });

    it('fails closed with NO inline fallback when no RTR template is configured (INV-12)', async () => {
      await expectCode(
        orchestrator.request({
          tenant_id: randomUUID(),
          talent_id: randomUUID(),
          requisition_id: randomUUID(),
          company_id: randomUUID(),
          created_by: ACTOR,
          requestId: randomUUID(),
        }),
        'RTR_TEMPLATE_NOT_CONFIGURED',
      );
    });

    it('fails closed when a required binding cannot be resolved (RTR_TEMPLATE_BINDING_MISSING)', async () => {
      const tenant = randomUUID();
      await activeRtrTemplate(tenant);
      await expectCode(
        orchestrator.request({
          tenant_id: tenant,
          talent_id: MISSING_TALENT,
          requisition_id: randomUUID(),
          company_id: randomUUID(),
          created_by: ACTOR,
          requestId: randomUUID(),
        }),
        'RTR_TEMPLATE_BINDING_MISSING',
      );
    });
  },
);
