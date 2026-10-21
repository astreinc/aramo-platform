import { createHash, randomUUID } from 'node:crypto';
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
import { PdfLibDocumentRenderingAdapter, type RenderModel } from '@aramo/documents-rendering';
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
import { RtrTemplateTenantLogoService } from '../rtr/rtr-template-tenant-logo.service.js';
import { DEFAULT_RTR_TEMPLATE_CONTENT_V1, RTR_GENERATED_SCHEMA_V1 } from '../rtr/rtr-template-content.js';

// DOC-TEMPLATE-LIB-1 T-3 (§4.2, §4.3, §5) — the RTR request path against the Aramo RTR
// default on real Postgres 17. Skipped unless ARAMO_RUN_INTEGRATION=1.
//
// The container carries an identity."Tenant" stub with NO sentinel row, so the T-3
// conversion migration takes its fresh-environment path and creates the Aramo (PLATFORM)
// RTR default exactly as a fresh local DB does. Proves:
//   (a) a tenant with its own selected RTR template renders ITS wording, byte-identical to
//       the pre-T-3 render (no letterhead), and the logo is never fetched
//   (b) a new tenant with no selection renders the Aramo default, pinned to the PLATFORM
//       version, branded with the tenant's organisation name + logo captured at render into
//       a per-render tenant TemplateAsset, and its provenance resolves owner-aware
//   (c) a new tenant without a profile logo renders the Aramo default byte-identical to the
//       retired provisioning copy's output (same content, no letterhead)
//   (d) the requisition's CLIENT company is consulted: a client selection wins
//   (e) a withdrawn Aramo default is skipped → RTR_TEMPLATE_NOT_CONFIGURED for a tenant
//       relying on it, while a tenant with its own selection is unaffected

const ROOT = resolve(__dirname, '../../../..');
const ACTOR = randomUUID();
const CLIENT_COMPANY = randomUUID();
const TALENT_NAME = 'Jordan Lee';
// A valid 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const PNG_SHA = createHash('sha256').update(PNG).digest('hex');

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

type Branding = {
  name: string;
  display_name: string | null;
  legal_name: string | null;
  logo_url: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state_province: string | null;
  postal_code: string | null;
  country_code: string | null;
};

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'DOC-TEMPLATE-LIB-1 T-3 — RTR on the Aramo default — real Postgres 17',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let prisma: DocumentsPrismaService;
    let docsRepo: DocumentsRepository;
    let templates: TemplatesRepository;
    let orchestrator: RtrOrchestratorService;
    let platformTemplateId: string;
    let platformVersionId: string;
    const blobs = new Map<string, Buffer>();
    const brandingByTenant = new Map<string, Branding>();
    const fetcher = vi.fn(async () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(PNG.byteLength) } }));
    const renderer = new PdfLibDocumentRenderingAdapter();

    function branding(over: Partial<Branding>): Branding {
      return {
        name: 'workspace',
        display_name: null,
        legal_name: null,
        logo_url: null,
        address_line1: null,
        address_line2: null,
        city: null,
        state_province: null,
        postal_code: null,
        country_code: null,
        ...over,
      };
    }

    async function ownRtrTemplate(tenant: string, text: string, clientId?: string): Promise<string> {
      const tpl = await templates.createTemplate({
        tenant_id: tenant,
        document_type_id: RIGHT_TO_REPRESENT_TYPE_ID,
        name: 'Own RTR',
        template_kind: 'GENERATED',
        created_by: ACTOR,
        ...(clientId !== undefined ? { client_id: clientId } : {}),
      });
      const ver = await templates.createVersion({
        tenant_id: tenant,
        template_id: tpl.id,
        render_schema_version: RTR_GENERATED_SCHEMA_V1,
        field_schema: { render_schema_version: RTR_GENERATED_SCHEMA_V1, title: 'Own RTR', blocks: [{ type: 'TEXT', text }] },
        created_by: ACTOR,
      });
      await templates.activateVersion({ tenant_id: tenant, version_id: ver.id, actor_id: ACTOR, require_preview: false });
      return ver.id;
    }

    async function requestFor(tenant: string): Promise<string> {
      const { document_id } = await orchestrator.request({
        tenant_id: tenant,
        talent_id: randomUUID(),
        requisition_id: randomUUID(),
        created_by: ACTOR,
        requestId: randomUUID(),
      });
      return document_id;
    }

    // The exact pre-T-3 render of an rtr-generated-v1 template: no letterhead.
    async function plainSha(versionId: string, title: string, blocks: Array<{ type: 'HEADING' | 'TEXT'; text: string }>): Promise<string> {
      const model: RenderModel = {
        template_version_id: versionId,
        render_schema_version: 'v1',
        title,
        blocks,
        signature_block: { printed_name: TALENT_NAME },
      };
      return (await renderer.renderGenerated(model)).sha256;
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      // identity."Tenant" stub WITHOUT the sentinel row → the T-3 conversion creates the
      // Aramo RTR default (fresh-environment path).
      await db.query(`CREATE SCHEMA "identity"`);
      await db.query(`CREATE TABLE "identity"."Tenant" ("id" UUID PRIMARY KEY, "is_active" BOOLEAN NOT NULL DEFAULT true)`);
      for (const p of documentsMigrations()) await db.query(readFileSync(p, 'utf8'));
      const def = await db.query(
        `SELECT id::text, current_version_id::text FROM "documents"."DocumentTemplate" WHERE owner_scope = 'PLATFORM' AND document_type_id = $1`,
        [RIGHT_TO_REPRESENT_TYPE_ID],
      );
      expect(def.rows).toHaveLength(1);
      platformTemplateId = def.rows[0].id;
      platformVersionId = def.rows[0].current_version_id;

      prisma = new DocumentsPrismaService(url);
      await prisma.$connect();
      docsRepo = new DocumentsRepository(prisma, new DocumentIdempotencyService(prisma));
      templates = new TemplatesRepository(prisma);

      const storage = {
        putArtifact: async (i: { storage_key: string; body: Buffer | Uint8Array }) => {
          const body = Buffer.from(i.body);
          blobs.set(i.storage_key, body);
          return { storage_key: i.storage_key, sha256: createHash('sha256').update(body).digest('hex'), byte_size: body.byteLength };
        },
        getArtifact: async (i: { storage_key: string }) => blobs.get(i.storage_key) ?? Buffer.alloc(0),
        createReadAccess: async () => ({ url: 'stub', expires_at: new Date().toISOString() }),
        createWriteAccess: async () => ({ url: 'stub', expires_at: new Date().toISOString() }),
        headArtifact: async () => ({ exists: true, byte_size: 0, sha256: 'stub' }),
        verifyArtifact: async () => true,
        applyRetention: async () => undefined,
        applyLegalHold: async () => undefined,
      } as unknown as DocumentStoragePort;

      const tenantsFake = {
        findBrandingById: async (id: string) => brandingByTenant.get(id) ?? null,
        findLegalNameById: async (id: string) => brandingByTenant.get(id)?.legal_name ?? null,
      };
      const fakeTalent = {
        findById: async () => ({ first_name: 'Jordan', last_name: 'Lee', email1: 'jordan.lee@example.com' }),
      } as unknown as TalentRecordRepository;
      const binding = new RtrTemplateBindingService(fakeTalent, {} as never, {} as never, tenantsFake as never, {} as never);
      const fakeSignature = {
        createEnvelope: async () => ({ envelope_id: 'env-1' }),
        sendEnvelope: async () => ({ status: 'SENT' }),
        findEnvelopeForDocument: async () => null,
      } as unknown as SignatureProviderPort;
      const fakeRequisitions = { findCompanyId: async () => CLIENT_COMPANY, findStatusById: async () => 'open' } as never;
      const render = new RenderService(prisma, renderer, storage);
      const logo = new RtrTemplateTenantLogoService(tenantsFake as never, storage, fetcher as never);
      orchestrator = new RtrOrchestratorService(
        docsRepo,
        new GovernedDocumentSigningService(docsRepo, render, staticSignatureRouter(fakeSignature)),
        fakeTalent,
        new RtrTemplateResolverService(templates),
        binding,
        templates,
        storage,
        fakeRequisitions,
        logo,
      );
    }, 300_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await db?.end();
      await container?.stop();
    });

    it('(a) a tenant with its own selected RTR template renders its own wording, byte-identical, no logo fetched', async () => {
      const tenant = randomUUID();
      brandingByTenant.set(tenant, branding({ display_name: 'Own Co', logo_url: 'https://cdn.own-co.example/logo.png' }));
      const v = await ownRtrTemplate(tenant, 'Own wording for {{talent.full_name}}.');
      fetcher.mockClear();
      const docId = await requestFor(tenant);
      const rev = await docsRepo.getCurrentRevision(tenant, docId);
      expect(rev?.template_version_id).toBe(v);
      const model = (rev?.render_manifest as { model: Record<string, unknown> }).model;
      expect(model['letterhead']).toBeUndefined();
      expect(JSON.stringify(model)).toContain(`Own wording for ${TALENT_NAME}.`);
      expect(rev?.content_sha256).toBe(await plainSha(v, 'Own RTR', [{ type: 'TEXT', text: `Own wording for ${TALENT_NAME}.` }]));
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('(b) a new tenant with no selection renders the Aramo default, branded with its name + logo captured at render', async () => {
      const tenant = randomUUID();
      brandingByTenant.set(tenant, branding({ name: 'acme-ws', display_name: 'Acme Branding', legal_name: 'Acme LLC', logo_url: 'https://cdn.acme.example/logo.png' }));
      fetcher.mockClear();
      const docId = await requestFor(tenant);
      const rev = await docsRepo.getCurrentRevision(tenant, docId);
      // Pinned to the EXACT PLATFORM version.
      expect(rev?.template_version_id).toBe(platformVersionId);
      const model = (rev?.render_manifest as { model: { letterhead?: Record<string, unknown>; blocks: unknown } }).model;
      expect(model.letterhead).toEqual({ image_format: 'PNG', image_sha256: PNG_SHA, name: 'Acme Branding' });
      expect(JSON.stringify(model.blocks)).toContain(`This authorizes representation of ${TALENT_NAME}`);
      expect(fetcher).toHaveBeenCalledTimes(1);
      // The per-render tenant TemplateAsset (the PLATFORM content carries none).
      const assets = await db.query(`SELECT asset_kind, sha256, created_by::text FROM "documents"."TemplateAsset" WHERE tenant_id = $1`, [tenant]);
      expect(assets.rows).toEqual([{ asset_kind: 'LOGO', sha256: PNG_SHA, created_by: ACTOR }]);
      // Branded output differs from the plain render (the letterhead is in the frozen bytes).
      expect(rev?.content_sha256).not.toBe(
        await plainSha(platformVersionId, DEFAULT_RTR_TEMPLATE_CONTENT_V1.title, [
          { type: 'HEADING', text: 'Right to Represent' },
          { type: 'TEXT', text: `This authorizes representation of ${TALENT_NAME} to the associated client for the associated requisition.` },
        ]),
      );
      // Owner-aware provenance: the tenant Document pins a PLATFORM version.
      const provenance = await (orchestrator as unknown as {
        resolveProvenance(t: string, d: string): Promise<{ name: string; version_number: number } | null>;
      }).resolveProvenance(tenant, docId);
      expect(provenance).toEqual({ name: 'Standard Right to Represent', version_number: 1 });
      // No tenant row was created for the default (D4).
      const own = await db.query(`SELECT count(*)::int AS n FROM "documents"."DocumentTemplate" WHERE tenant_id = $1`, [tenant]);
      expect(own.rows[0].n).toBe(0);
    });

    it('(c) a new tenant without a profile logo renders the Aramo default byte-identical to the retired copy (no letterhead)', async () => {
      const tenant = randomUUID();
      brandingByTenant.set(tenant, branding({ display_name: 'No Logo Co' }));
      fetcher.mockClear();
      const docId = await requestFor(tenant);
      const rev = await docsRepo.getCurrentRevision(tenant, docId);
      expect(rev?.template_version_id).toBe(platformVersionId);
      expect(rev?.content_sha256).toBe(
        await plainSha(platformVersionId, DEFAULT_RTR_TEMPLATE_CONTENT_V1.title, [
          { type: 'HEADING', text: 'Right to Represent' },
          { type: 'TEXT', text: `This authorizes representation of ${TALENT_NAME} to the associated client for the associated requisition.` },
        ]),
      );
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('(c2) an uncapturable logo degrades to no letterhead instead of blocking the RTR', async () => {
      const tenant = randomUUID();
      brandingByTenant.set(tenant, branding({ display_name: 'Http Co', logo_url: 'http://cdn.http-co.example/logo.png' }));
      const docId = await requestFor(tenant);
      const rev = await docsRepo.getCurrentRevision(tenant, docId);
      expect(rev?.template_version_id).toBe(platformVersionId);
      expect((rev?.render_manifest as { model: Record<string, unknown> }).model['letterhead']).toBeUndefined();
    });

    it('(d) the requisition’s CLIENT company is consulted: a client selection wins over the tenant-wide one', async () => {
      const tenant = randomUUID();
      brandingByTenant.set(tenant, branding({ display_name: 'Client Co' }));
      await ownRtrTemplate(tenant, 'Tenant-wide wording.');
      const clientVersion = await ownRtrTemplate(tenant, 'Client wording.', CLIENT_COMPANY);
      const docId = await requestFor(tenant);
      const rev = await docsRepo.getCurrentRevision(tenant, docId);
      expect(rev?.template_version_id).toBe(clientVersion);
      // Compose (read-only) resolves the same client selection.
      const view = await orchestrator.composeForPair({ tenant_id: tenant, talent_id: randomUUID(), requisition_id: randomUUID(), actor_id: ACTOR, requestId: randomUUID() });
      expect(view.preview.blocks).toEqual([{ type: 'TEXT', text: 'Client wording.' }]);
    });

    it('(e) a withdrawn Aramo default is skipped → NOT_CONFIGURED for a tenant relying on it; an own selection is unaffected', async () => {
      const own = randomUUID();
      brandingByTenant.set(own, branding({ display_name: 'Own Co 2' }));
      const ownVersion = await ownRtrTemplate(own, 'Mine.');
      const relying = randomUUID();
      brandingByTenant.set(relying, branding({ display_name: 'Relying Co' }));
      await db.query(
        `UPDATE "documents"."DocumentTemplate" SET withdraw_notice_at = now() - interval '8 days', withdraw_effective_at = now() - interval '1 second' WHERE id = $1`,
        [platformTemplateId],
      );
      try {
        await expectCode(requestFor(relying), 'RTR_TEMPLATE_NOT_CONFIGURED');
        const rev = await docsRepo.getCurrentRevision(own, await requestFor(own));
        expect(rev?.template_version_id).toBe(ownVersion);
      } finally {
        await db.query(`UPDATE "documents"."DocumentTemplate" SET withdraw_notice_at = NULL, withdraw_effective_at = NULL WHERE id = $1`, [platformTemplateId]);
      }
    });
  },
);
