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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RIGHT_TO_REPRESENT_TYPE_ID } from '../rtr/rtr-constants.js';
import { GovernedDocumentSigningService } from '../document-signing/governed-document-signing.service.js';
import { staticSignatureRouter } from '../document-signing/signature-router.js';
import { RtrOrchestratorService } from '../rtr/rtr-orchestrator.service.js';
import { RtrTemplateResolverService } from '../rtr/rtr-template-resolver.service.js';
import { RtrTemplateBindingService } from '../rtr/rtr-template-binding.service.js';
import { DEFAULT_RTR_TEMPLATE_CONTENT_V1, RTR_GENERATED_SCHEMA_V1 } from '../rtr/rtr-template-content.js';
import { EsignSigningEndedRecorder, signingEndedStatusFor } from '../documents/esign-signing-ended.js';

import { episodeReaderAt } from './helpers/rtr-stage-fixture.js';

// Pipeline & RTR Recon Remediation Directive v1.0 LOCKED §2 R2 — RTR integrity on REAL Postgres 17
// (the documents schema), through the real RtrOrchestratorService + GovernedDocumentSigningService +
// DocumentsRepository:
//   DEF-7  RTR is requested / sent only from Talent responded (RTR-1 AC-21); not on the requisition → 404
//   DEF-8  a requested-but-unsent RTR is REUSED, never duplicated — sequentially AND concurrently (RTR-1 §24)
//   DEF-12 a declined / expired / voided envelope is recorded on its Document (new DECLINED status);
//          redelivery is a no-op; EXECUTED is never overwritten; an unrouted envelope is ignored

const ROOT = resolve(__dirname, '../../../..');
const ACTOR = randomUUID();
const CLIENT_COMPANY = randomUUID();

function documentsMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/documents/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('R2 — RTR integrity (Remediation v1.0; real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: DocumentsPrismaService;
  let docsRepo: DocumentsRepository;
  let templates: TemplatesRepository;
  let signing: GovernedDocumentSigningService;
  let resolver: RtrTemplateResolverService;
  let binding: RtrTemplateBindingService;
  let storageStub: DocumentStoragePort;
  let fakeTalent: TalentRecordRepository;
  const fakeRequisitions = { findCompanyId: async () => CLIENT_COMPANY, findStatusById: async () => 'open' } as never;

  function orchestrator(stage: string | null): RtrOrchestratorService {
    return new RtrOrchestratorService(docsRepo, signing, fakeTalent, resolver, binding, templates, storageStub, fakeRequisitions, episodeReaderAt(stage));
  }

  async function activeRtrTemplate(tenant: string): Promise<void> {
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
  }

  async function rtrDocCount(tenant: string, talent: string): Promise<number> {
    const r = await db.query(
      `SELECT count(*)::int AS c FROM documents."Document" d
        WHERE d.tenant_id = $1 AND d.document_type_id = $2
          AND EXISTS (SELECT 1 FROM documents."DocumentAssociation" a
                       WHERE a.document_id = d.id AND a.resource_type = 'TALENT' AND a.resource_id = $3)`,
      [tenant, RIGHT_TO_REPRESENT_TYPE_ID, talent],
    );
    return Number((r.rows[0] as { c: number }).c);
  }
  async function statusOf(documentId: string): Promise<string> {
    return ((await db.query(`SELECT status FROM documents."Document" WHERE id = $1`, [documentId])).rows[0] as { status: string }).status;
  }
  async function refusal(p: Promise<unknown>): Promise<{ code?: string; status?: number; stage?: unknown }> {
    try {
      await p;
      return { code: 'NO_THROW' };
    } catch (e) {
      const x = e as { code?: string; statusCode?: number; context?: { details?: { stage?: unknown } } };
      return { code: x.code, status: x.statusCode, stage: x.context?.details?.stage };
    }
  }
  const request = (o: RtrOrchestratorService, tenant: string, talent: string, requisition: string) =>
    o.request({ tenant_id: tenant, talent_id: talent, requisition_id: requisition, company_id: CLIENT_COMPANY, created_by: ACTOR, requestId: `r2-${randomUUID()}` } as never);

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
    storageStub = {
      putArtifact: async () => ({ storage_key: 'stub', sha256: 'stub', byte_size: 0 }),
      getArtifact: async () => Buffer.alloc(0),
      createReadAccess: async () => ({ url: 'stub', expires_at: new Date(0).toISOString() }),
      createWriteAccess: async () => ({ url: 'stub', expires_at: new Date(0).toISOString() }),
      headArtifact: async () => ({ byte_length: 0, content_type: undefined }),
      verifyArtifact: async () => true,
      applyRetention: async () => undefined,
      applyLegalHold: async () => undefined,
    } as unknown as DocumentStoragePort;
    const render = new RenderService(prisma, new PdfLibDocumentRenderingAdapter(), storageStub);
    resolver = new RtrTemplateResolverService(templates);
    fakeTalent = {
      findById: async () => ({ first_name: 'Jordan', last_name: 'Lee', email1: 'jordan.lee@example.com' }),
    } as unknown as TalentRecordRepository;
    binding = new RtrTemplateBindingService(fakeTalent, {} as never, {} as never, {} as never, {} as never);
    const fakeSignature = {
      createEnvelope: async () => ({ envelope_id: `env-${randomUUID()}` }),
      sendEnvelope: async () => ({ status: 'SENT' }),
      findEnvelopeForDocument: async () => null,
    } as unknown as SignatureProviderPort;
    signing = new GovernedDocumentSigningService(docsRepo, render, staticSignatureRouter(fakeSignature));
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    await container?.stop();
  });

  // ---- DEF-7 — RTR starts at Talent responded ------------------------------------------------
  for (const stage of ['no_contact', 'contacted'] as const) {
    it(`DEF-7: request at ${stage} → 409 RTR_STAGE_NOT_ELIGIBLE; nothing persists`, async () => {
      const tenant = randomUUID();
      const talent = randomUUID();
      await activeRtrTemplate(tenant);
      const r = await refusal(request(orchestrator(stage), tenant, talent, randomUUID()));
      expect(r).toEqual({ code: 'RTR_STAGE_NOT_ELIGIBLE', status: 409, stage });
      expect(await rtrDocCount(tenant, talent)).toBe(0);
    });
  }

  it('DEF-7: a Talent not on the requisition → 404; nothing persists', async () => {
    const tenant = randomUUID();
    const talent = randomUUID();
    await activeRtrTemplate(tenant);
    const r = await refusal(request(orchestrator(null), tenant, talent, randomUUID()));
    expect(r).toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect(await rtrDocCount(tenant, talent)).toBe(0);
  });

  for (const stage of ['talent_responded', 'qualifying', 'qualified'] as const) {
    it(`DEF-7: request at ${stage} succeeds`, async () => {
      const tenant = randomUUID();
      const talent = randomUUID();
      await activeRtrTemplate(tenant);
      const { document_id } = await request(orchestrator(stage), tenant, talent, randomUUID());
      expect(await statusOf(document_id)).toBe('DRAFT');
    });
  }

  it('DEF-7: send is refused when the episode is before Talent responded', async () => {
    const tenant = randomUUID();
    const talent = randomUUID();
    const requisition = randomUUID();
    await activeRtrTemplate(tenant);
    const { document_id } = await request(orchestrator('talent_responded'), tenant, talent, requisition);
    // The REGARDING requisition is read from the document; the episode reader reports contacted.
    const r = await refusal(
      orchestrator('contacted').send({ tenant_id: tenant, document_id, talent_id: talent, created_by: ACTOR, requestId: 'r2-send' }),
    );
    expect(r).toMatchObject({ code: 'RTR_STAGE_NOT_ELIGIBLE', status: 409 });
    expect(await statusOf(document_id)).toBe('DRAFT');
  });

  // ---- DEF-8 — no duplicate RTR documents ---------------------------------------------------
  it('DEF-8: a second request for the same Talent × requisition reuses the requested RTR', async () => {
    const tenant = randomUUID();
    const talent = randomUUID();
    const requisition = randomUUID();
    await activeRtrTemplate(tenant);
    const o = orchestrator('talent_responded');
    const first = await request(o, tenant, talent, requisition);
    const second = await request(o, tenant, talent, requisition);
    expect(second.document_id).toBe(first.document_id);
    expect(await rtrDocCount(tenant, talent)).toBe(1);
    // The reused draft keeps exactly one frozen revision (no re-render).
    const revs = await db.query(`SELECT count(*)::int AS c FROM documents."DocumentRevision" WHERE document_id = $1`, [first.document_id]);
    expect(Number((revs.rows[0] as { c: number }).c)).toBe(1);
  });

  it('DEF-8: two concurrent requests produce exactly one RTR document', async () => {
    const tenant = randomUUID();
    const talent = randomUUID();
    const requisition = randomUUID();
    await activeRtrTemplate(tenant);
    const o = orchestrator('talent_responded');
    const [a, b] = await Promise.all([request(o, tenant, talent, requisition), request(o, tenant, talent, requisition)]);
    expect(a.document_id).toBe(b.document_id);
    expect(await rtrDocCount(tenant, talent)).toBe(1);
  });

  it('DEF-8: a different requisition gets its own RTR', async () => {
    const tenant = randomUUID();
    const talent = randomUUID();
    await activeRtrTemplate(tenant);
    const o = orchestrator('talent_responded');
    const a = await request(o, tenant, talent, randomUUID());
    const b = await request(o, tenant, talent, randomUUID());
    expect(a.document_id).not.toBe(b.document_id);
  });

  // ---- DEF-12 — declined / expired / voided ------------------------------------------------
  async function sentRtr(): Promise<{ tenant: string; documentId: string }> {
    const tenant = randomUUID();
    const talent = randomUUID();
    await activeRtrTemplate(tenant);
    const o = orchestrator('talent_responded');
    const { document_id } = await request(o, tenant, talent, randomUUID());
    await o.send({ tenant_id: tenant, document_id, talent_id: talent, created_by: ACTOR, requestId: 'r2-sent' });
    expect(['PREPARED', 'EXECUTION_PENDING']).toContain(await statusOf(document_id));
    return { tenant, documentId: document_id };
  }

  for (const status of ['DECLINED', 'EXPIRED', 'VOIDED'] as const) {
    it(`DEF-12: an envelope ${status.toLowerCase()} event records ${status}; redelivery is a no-op`, async () => {
      const { tenant, documentId } = await sentRtr();
      const recorder = new EsignSigningEndedRecorder(docsRepo, {
        findRouteByEnvelope: async () => ({ tenant_id: tenant, document_id: documentId, document_revision_id: 'rev' }),
      } as never);
      expect(await recorder.record({ tenant_id: tenant, envelope_id: 'env', status, requestId: 'r2-ended' })).toBe('recorded');
      expect(await statusOf(documentId)).toBe(status);
      expect(await recorder.record({ tenant_id: tenant, envelope_id: 'env', status, requestId: 'r2-ended-2' })).toBe('already_final');
      const ev = await db.query(`SELECT count(*)::int AS c FROM documents."DocumentEvent" WHERE document_id = $1 AND event_type = $2`, [documentId, `DOCUMENT_${status}`]);
      expect(Number((ev.rows[0] as { c: number }).c)).toBe(1);
    });
  }

  it('DEF-12: an EXECUTED document is never overwritten by a late decline', async () => {
    const { tenant, documentId } = await sentRtr();
    await db.query(`UPDATE documents."Document" SET status = 'EXECUTED' WHERE id = $1`, [documentId]);
    const recorder = new EsignSigningEndedRecorder(docsRepo, {
      findRouteByEnvelope: async () => ({ tenant_id: tenant, document_id: documentId, document_revision_id: 'rev' }),
    } as never);
    expect(await recorder.record({ tenant_id: tenant, envelope_id: 'env', status: 'DECLINED', requestId: 'r2-late' })).toBe('already_final');
    expect(await statusOf(documentId)).toBe('EXECUTED');
  });

  it("DEF-12: an envelope routed for another tenant (or not routed) is ignored", async () => {
    const { tenant, documentId } = await sentRtr();
    const other = new EsignSigningEndedRecorder(docsRepo, {
      findRouteByEnvelope: async () => ({ tenant_id: randomUUID(), document_id: documentId, document_revision_id: 'rev' }),
    } as never);
    expect(await other.record({ tenant_id: tenant, envelope_id: 'env', status: 'DECLINED', requestId: 'r2-x' })).toBe('unrouted');
    const none = new EsignSigningEndedRecorder(docsRepo, { findRouteByEnvelope: async () => null } as never);
    expect(await none.record({ tenant_id: tenant, envelope_id: 'env', status: 'DECLINED', requestId: 'r2-y' })).toBe('unrouted');
    expect(['PREPARED', 'EXECUTION_PENDING']).toContain(await statusOf(documentId));
  });

  it('DEF-12: after a decline, a new RTR can be requested (the declined one is not live)', async () => {
    const tenant = randomUUID();
    const talent = randomUUID();
    const requisition = randomUUID();
    await activeRtrTemplate(tenant);
    const o = orchestrator('qualifying');
    const first = await request(o, tenant, talent, requisition);
    await o.send({ tenant_id: tenant, document_id: first.document_id, talent_id: talent, created_by: ACTOR, requestId: 'r2-s1' });
    await docsRepo.markSigningEnded({ tenant_id: tenant, document_id: first.document_id, status: 'DECLINED', actor_id: ACTOR });
    const second = await request(o, tenant, talent, requisition);
    expect(second.document_id).not.toBe(first.document_id);
    const current = await o.current({ tenant_id: tenant, talent_id: talent, requisition_id: requisition, requestId: 'r2-c' });
    expect(current?.document_id).toBe(second.document_id);
  });

  it('DEF-12: the DB CHECK admits DECLINED (additive migration)', async () => {
    const { documentId } = await sentRtr();
    await expect(db.query(`UPDATE documents."Document" SET status = 'DECLINED' WHERE id = $1`, [documentId])).resolves.toBeDefined();
    await expect(db.query(`UPDATE documents."Document" SET status = 'REJECTED' WHERE id = $1`, [documentId])).rejects.toThrow(/Document_status_check/);
  });

  it('DEF-12: event-type routing (sign.* and legacy esign.* prefixes)', () => {
    expect(signingEndedStatusFor('sign.envelope.declined.v1')).toBe('DECLINED');
    expect(signingEndedStatusFor('esign.envelope.expired.v1')).toBe('EXPIRED');
    expect(signingEndedStatusFor('sign.envelope.voided.v1')).toBe('VOIDED');
    expect(signingEndedStatusFor('sign.envelope.executed.v1')).toBeNull();
    expect(signingEndedStatusFor('sign.envelope.sent.v1')).toBeNull();
  });
});
