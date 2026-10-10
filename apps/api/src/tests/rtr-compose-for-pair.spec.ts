import { randomUUID } from 'node:crypto';

import { AramoError } from '@aramo/common';
import { type TemplatesRepository } from '@aramo/documents';
import { type TalentRecordRepository } from '@aramo/talent-record';
import { type RequisitionRepository } from '@aramo/requisition';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RtrOrchestratorService } from '../rtr/rtr-orchestrator.service.js';
import { RtrTemplateResolverService } from '../rtr/rtr-template-resolver.service.js';
import { RtrTemplateBindingService } from '../rtr/rtr-template-binding.service.js';
import { RTR_GENERATED_SCHEMA_V1 } from '../rtr/rtr-template-content.js';

// SEAM 4 (Requisition Talent in play) — unit proof for the READ-ONLY
// RtrOrchestratorService.composeForPair. It opens the recruiter "Send RTR" panel
// BEFORE an RTR Document exists by resolving the tenant's ACTIVE RTR template +
// producing a REAL-BOUND preview for THIS (talent, requisition). The invariants:
//   (a) ZERO writes — no Document / revision / artifact / envelope created.
//   (b) provenance is TENANT-correct — never another tenant's active template.
//   (c) the preview is bound to the EXACT (talent, requisition) pair.
//   (d) no active template → RTR_TEMPLATE_NOT_CONFIGURED (never a fabricated preview).
//   (e) a required binding that cannot resolve → RTR_TEMPLATE_BINDING_MISSING (fail closed).
// Pure fakes (no testcontainers): the real resolver + binding services over
// in-memory repositories, so the substitution/fail-closed behaviour is exercised
// exactly as the send path exercises it.

// A content that uses TWO bindings so the preview visibly reflects both the talent
// and the requisition: {{talent.full_name}} and {{requisition.reference}} (REQ-N).
const CONTENT = {
  render_schema_version: RTR_GENERATED_SCHEMA_V1,
  title: 'Right to Represent',
  blocks: [
    { type: 'HEADING', text: 'Right to Represent' },
    { type: 'TEXT', text: 'This authorizes representation of {{talent.full_name}} for {{requisition.reference}}.' },
  ],
};

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
    throw new Error(`expected AramoError ${code}, but the call succeeded`);
  } catch (e) {
    expect(e).toBeInstanceOf(AramoError);
    expect((e as AramoError).code).toBe(code);
  }
}

interface TemplateRow { id: string; current_version_id: string | null; name: string }
interface VersionRow {
  id: string;
  template_id: string;
  status: string;
  render_schema_version: string;
  version_number: number;
  field_schema: unknown;
}

describe('SEAM 4 — RtrOrchestratorService.composeForPair (read-only Send RTR panel)', () => {
  let templateByTenant: Map<string, TemplateRow>;
  let versionById: Map<string, VersionRow>;
  let reqById: Map<string, { title: string; requisition_number: number; company_id: string | null }>;
  let talentById: Map<string, { first_name: string; last_name: string; email1: string }>;

  // Write-surface spies — asserted NEVER called (compose is pure read + in-memory render).
  let documents: { createDocument: ReturnType<typeof vi.fn>; ensureRequirement: ReturnType<typeof vi.fn>; getCurrentRevision: ReturnType<typeof vi.fn>; findDocumentsByTypeKeyAndAssociations: ReturnType<typeof vi.fn>; listArtifacts: ReturnType<typeof vi.fn>; getDocument: ReturnType<typeof vi.fn> };
  let signing: { prepare: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn>; remind: ReturnType<typeof vi.fn> };
  let storage: { putArtifact: ReturnType<typeof vi.fn>; createReadAccess: ReturnType<typeof vi.fn>; createWriteAccess: ReturnType<typeof vi.fn> };

  let orch: RtrOrchestratorService;

  function seedActiveTemplate(
    tenant: string,
    opts?: { name?: string; versionNumber?: number; content?: unknown; status?: string },
  ): { templateId: string; versionId: string } {
    const templateId = randomUUID();
    const versionId = randomUUID();
    templateByTenant.set(tenant, { id: templateId, current_version_id: versionId, name: opts?.name ?? 'Standard Right to Represent' });
    versionById.set(versionId, {
      id: versionId,
      template_id: templateId,
      status: opts?.status ?? 'ACTIVE',
      render_schema_version: RTR_GENERATED_SCHEMA_V1,
      version_number: opts?.versionNumber ?? 1,
      field_schema: opts?.content ?? CONTENT,
    });
    return { templateId, versionId };
  }

  beforeEach(() => {
    templateByTenant = new Map();
    versionById = new Map();
    reqById = new Map();
    talentById = new Map();

    const templatesFake = {
      findActiveTenantTemplateForType: async (tenant: string) => templateByTenant.get(tenant) ?? null,
      findVersionById: async (_tenant: string, id: string) => versionById.get(id) ?? null,
      findTemplateById: async (_tenant: string, id: string) =>
        [...templateByTenant.values()].find((t) => t.id === id) ?? null,
    } as unknown as TemplatesRepository;

    const requisitionsFake = {
      findCompanyId: async ({ id }: { tenant_id: string; id: string }) => reqById.get(id)?.company_id ?? null,
      findByIdAdmin: async ({ id }: { tenant_id: string; id: string }) => {
        const r = reqById.get(id);
        return r === undefined ? null : { title: r.title, requisition_number: r.requisition_number };
      },
    } as unknown as RequisitionRepository;

    const talentFake = {
      findById: async ({ id }: { tenant_id: string; id: string }) => talentById.get(id) ?? null,
    } as unknown as TalentRecordRepository;

    // Only talent.full_name + requisition.reference are referenced by CONTENT, so these
    // three repos are never touched — provided as inert stubs for completeness.
    const companiesFake = { findNamesByIds: async () => new Map<string, string>() };
    const tenantsFake = { findNamesByIds: async () => new Map<string, string>() };
    const identityFake = { findUserById: async () => null };

    documents = {
      createDocument: vi.fn(),
      ensureRequirement: vi.fn(),
      getCurrentRevision: vi.fn(),
      findDocumentsByTypeKeyAndAssociations: vi.fn(),
      listArtifacts: vi.fn(),
      getDocument: vi.fn(),
    };
    signing = { prepare: vi.fn(), send: vi.fn(), remind: vi.fn() };
    storage = { putArtifact: vi.fn(), createReadAccess: vi.fn(), createWriteAccess: vi.fn() };

    const resolver = new RtrTemplateResolverService(templatesFake);
    const binding = new RtrTemplateBindingService(
      talentFake,
      requisitionsFake,
      companiesFake as never,
      tenantsFake as never,
      identityFake as never,
    );

    orch = new RtrOrchestratorService(
      documents as never,
      signing as never,
      talentFake,
      resolver,
      binding,
      templatesFake,
      storage as never,
      requisitionsFake,
    );
  });

  it('(a) performs ZERO writes — no Document, revision, artifact, or envelope is created', async () => {
    const tenant = randomUUID();
    seedActiveTemplate(tenant);
    const talent = randomUUID();
    talentById.set(talent, { first_name: 'Ravi', last_name: 'Shankar', email1: 'ravi@example.test' });
    const requisition = randomUUID();
    reqById.set(requisition, { title: 'Business Analyst', requisition_number: 1001, company_id: randomUUID() });

    const view = await orch.composeForPair({
      tenant_id: tenant,
      talent_id: talent,
      requisition_id: requisition,
      actor_id: randomUUID(),
      requestId: randomUUID(),
    });

    expect(view.preview.title).toBe('Right to Represent');
    expect(documents.createDocument).not.toHaveBeenCalled();
    expect(documents.ensureRequirement).not.toHaveBeenCalled();
    expect(documents.getCurrentRevision).not.toHaveBeenCalled();
    expect(documents.listArtifacts).not.toHaveBeenCalled();
    expect(signing.prepare).not.toHaveBeenCalled();
    expect(signing.send).not.toHaveBeenCalled();
    expect(signing.remind).not.toHaveBeenCalled();
    expect(storage.putArtifact).not.toHaveBeenCalled();
    expect(storage.createReadAccess).not.toHaveBeenCalled();
    expect(storage.createWriteAccess).not.toHaveBeenCalled();
  });

  it("(b) provenance is THIS tenant's active template — never another tenant's", async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    seedActiveTemplate(tenantA, { name: 'Astre RTR', versionNumber: 3 });
    seedActiveTemplate(tenantB, { name: 'Mindlance RTR', versionNumber: 9 });

    const talent = randomUUID();
    talentById.set(talent, { first_name: 'Ravi', last_name: 'Shankar', email1: 'ravi@example.test' });
    const requisition = randomUUID();
    reqById.set(requisition, { title: 'Business Analyst', requisition_number: 1001, company_id: randomUUID() });

    const view = await orch.composeForPair({
      tenant_id: tenantA,
      talent_id: talent,
      requisition_id: requisition,
      actor_id: randomUUID(),
      requestId: randomUUID(),
    });

    expect(view.template).toEqual({ name: 'Astre RTR', version_number: 3 });
    expect(view.template.name).not.toBe('Mindlance RTR');
  });

  it('(c) preview is bound to the EXACT (talent, requisition) — same talent, different requisition yields that requisition values', async () => {
    const tenant = randomUUID();
    seedActiveTemplate(tenant);
    const talent = randomUUID();
    talentById.set(talent, { first_name: 'Ravi', last_name: 'Shankar', email1: 'ravi@example.test' });
    const reqA = randomUUID();
    const reqB = randomUUID();
    reqById.set(reqA, { title: 'Business Analyst', requisition_number: 1001, company_id: randomUUID() });
    reqById.set(reqB, { title: 'Project Manager', requisition_number: 2002, company_id: randomUUID() });

    const a = await orch.composeForPair({ tenant_id: tenant, talent_id: talent, requisition_id: reqA, actor_id: randomUUID(), requestId: randomUUID() });
    const b = await orch.composeForPair({ tenant_id: tenant, talent_id: talent, requisition_id: reqB, actor_id: randomUUID(), requestId: randomUUID() });

    const textA = a.preview.blocks.map((x) => x.text).join('\n');
    const textB = b.preview.blocks.map((x) => x.text).join('\n');

    expect(textA).toContain('Ravi Shankar');
    expect(textA).toContain('REQ-1001');
    expect(textA).not.toContain('REQ-2002');
    expect(textB).toContain('Ravi Shankar');
    expect(textB).toContain('REQ-2002');
    expect(textB).not.toContain('REQ-1001');
    // Real-bound: no raw {{token}} ever survives into the preview.
    expect(textA).not.toContain('{{');
    expect(textB).not.toContain('{{');
  });

  it('(d) no active template → RTR_TEMPLATE_NOT_CONFIGURED (never a fabricated preview)', async () => {
    const tenant = randomUUID();
    // no seed — the tenant has no active RTR template.
    await expectCode(
      orch.composeForPair({ tenant_id: tenant, talent_id: randomUUID(), requisition_id: randomUUID(), actor_id: randomUUID(), requestId: randomUUID() }),
      'RTR_TEMPLATE_NOT_CONFIGURED',
    );
  });

  it('(e) a required binding that cannot resolve → RTR_TEMPLATE_BINDING_MISSING (fail closed)', async () => {
    const tenant = randomUUID();
    seedActiveTemplate(tenant);
    const talent = randomUUID();
    // talent resolves to an EMPTY name → {{talent.full_name}} is unresolvable.
    talentById.set(talent, { first_name: '', last_name: '', email1: '' });
    const requisition = randomUUID();
    reqById.set(requisition, { title: 'Business Analyst', requisition_number: 1001, company_id: randomUUID() });

    await expectCode(
      orch.composeForPair({ tenant_id: tenant, talent_id: talent, requisition_id: requisition, actor_id: randomUUID(), requestId: randomUUID() }),
      'RTR_TEMPLATE_BINDING_MISSING',
    );
    // Fail-closed BEFORE any write surface is touched.
    expect(documents.createDocument).not.toHaveBeenCalled();
    expect(signing.prepare).not.toHaveBeenCalled();
  });
});
