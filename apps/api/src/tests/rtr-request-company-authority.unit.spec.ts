import { randomUUID } from 'node:crypto';

import { AramoError } from '@aramo/common';
import { DocumentNotFoundError, type TemplatesRepository } from '@aramo/documents';
import { type TalentRecordRepository } from '@aramo/talent-record';
import { type RequisitionRepository } from '@aramo/requisition';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RTR_FALLBACK_TITLE, RtrOrchestratorService } from '../rtr/rtr-orchestrator.service.js';
import { RtrTemplateResolverService } from '../rtr/rtr-template-resolver.service.js';
import { RtrTemplateBindingService } from '../rtr/rtr-template-binding.service.js';
import { RTR_GENERATED_SCHEMA_V1 } from '../rtr/rtr-template-content.js';

// Document Templates slice 1 — RtrOrchestratorService.request()/send() authority proofs.
//   (C) the CLIENT company is derived from the REQUISITION (requisitions.findCompanyId),
//       exactly as compose does. A caller-supplied company_id that differs is refused
//       (422 VALIDATION_ERROR company_requisition_mismatch); an absent one uses the
//       requisition's; a requisition with no client company fails closed. client.name
//       and the COMPANY/CLIENT association therefore always name the requisition's client.
//   (E) Document.title = the pinned version's (bound) content title; the envelope subject =
//       the frozen Document.title. 'Right to Represent' is only the blank-title fallback.

const TENANT = randomUUID();
const TALENT = randomUUID();
const REQ = randomUUID();
const REQ_COMPANY = randomUUID();
const OTHER_COMPANY = randomUUID();

function content(title: string) {
  return {
    render_schema_version: RTR_GENERATED_SCHEMA_V1,
    title,
    blocks: [{ type: 'TEXT', text: 'Representation of {{talent.full_name}} to {{client.name}}.' }],
  };
}

async function expectRefusal(p: Promise<unknown>, code: string, reason?: string): Promise<void> {
  try {
    await p;
    throw new Error(`expected AramoError ${code}, but the call succeeded`);
  } catch (e) {
    expect(e).toBeInstanceOf(AramoError);
    expect((e as AramoError).code).toBe(code);
    if (reason !== undefined) expect((e as AramoError).context.details).toMatchObject({ reason });
  }
}

describe('RTR request() company authority (C) + document title / subject (E)', () => {
  let versionContent: unknown;
  let reqCompany: string | null;
  let companyNames: Map<string, string>;
  let signing: { prepare: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn>; remind: ReturnType<typeof vi.fn> };
  let documents: {
    ensureRequirement: ReturnType<typeof vi.fn>;
    getDocument: ReturnType<typeof vi.fn>;
    findRegardingRequisitionId: ReturnType<typeof vi.fn>;
  };
  let orch: RtrOrchestratorService;

  beforeEach(() => {
    versionContent = content('Exclusive Right to Represent Agreement');
    reqCompany = REQ_COMPANY;
    companyNames = new Map([
      [REQ_COMPANY, 'Mindlance'],
      [OTHER_COMPANY, 'Some Other Client'],
    ]);
    const templateId = randomUUID();
    const versionId = randomUUID();
    const templatesFake = {
      findActiveTenantTemplateForType: async () => ({ id: templateId, current_version_id: versionId, name: 'Exclusive RTR' }),
      findVersionById: async () => ({
        id: versionId,
        template_id: templateId,
        status: 'ACTIVE',
        render_schema_version: RTR_GENERATED_SCHEMA_V1,
        version_number: 3,
        field_schema: versionContent,
      }),
    } as unknown as TemplatesRepository;
    const requisitionsFake = {
      findCompanyId: vi.fn(async () => reqCompany),
      findStatusById: vi.fn(async () => 'open'), // v1.2 §5.6 — pre-send CONTACT_SEND gate
      findByIdAdmin: async () => ({ title: 'Business Analyst', requisition_number: 1001 }),
    } as unknown as RequisitionRepository;
    const talentFake = {
      findById: async () => ({ first_name: 'Ravi', last_name: 'Shankar', email1: 'ravi@example.test' }),
    } as unknown as TalentRecordRepository;
    const companiesFake = {
      findNamesByIds: async ({ ids }: { ids: readonly string[] }) =>
        new Map(ids.filter((i) => companyNames.has(i)).map((i) => [i, companyNames.get(i) as string])),
    };
    signing = {
      prepare: vi.fn(async () => ({ document_id: 'doc-1', revision_id: 'rev-1' })),
      send: vi.fn(async () => ({ document_id: 'doc-1', envelope_id: 'env-1', status: 'SENT' })),
      remind: vi.fn(),
    };
    // v1.2 §5.6 — send resolves the RTR's REGARDING requisition for the pre-send gate.
    documents = { ensureRequirement: vi.fn(async () => undefined), getDocument: vi.fn(), findRegardingRequisitionId: vi.fn(async () => 'req-1') };
    const binding = new RtrTemplateBindingService(
      talentFake,
      requisitionsFake,
      companiesFake as never,
      { findLegalNameById: async () => null } as never,
      { findUserById: async () => null } as never,
    );
    orch = new RtrOrchestratorService(
      documents as never,
      signing as never,
      talentFake,
      new RtrTemplateResolverService(templatesFake),
      binding,
      templatesFake,
      {} as never,
      requisitionsFake,
    );
  });

  const base = { tenant_id: TENANT, talent_id: TALENT, requisition_id: REQ, created_by: 'user-1', requestId: 'r-1' };

  it('absent company_id → uses the requisition client company for client.name and the CLIENT association', async () => {
    await orch.request(base);
    const arg = signing.prepare.mock.calls[0]?.[0];
    expect(arg.associations).toContainEqual({ resource_type: 'COMPANY', resource_id: REQ_COMPANY, relationship: 'CLIENT' });
    expect(arg.render.blocks[0].text).toBe('Representation of Ravi Shankar to Mindlance.');
    // B2 — the render model carries the fixed signature block (printed name = talent).
    expect(arg.render.signature_block).toEqual({ printed_name: 'Ravi Shankar' });
  });

  it('supplied company_id equal to the requisition company is accepted (backward compatible)', async () => {
    await orch.request({ ...base, company_id: REQ_COMPANY });
    expect(signing.prepare).toHaveBeenCalledTimes(1);
  });

  it('supplied company_id that differs from the requisition company → 422 company_requisition_mismatch, no write', async () => {
    await expectRefusal(orch.request({ ...base, company_id: OTHER_COMPANY }), 'VALIDATION_ERROR', 'company_requisition_mismatch');
    expect(signing.prepare).not.toHaveBeenCalled();
    expect(documents.ensureRequirement).not.toHaveBeenCalled();
  });

  it('requisition with no client company (or unknown) → 422 requisition_company_unresolved, no write', async () => {
    reqCompany = null;
    await expectRefusal(orch.request(base), 'VALIDATION_ERROR', 'requisition_company_unresolved');
    expect(signing.prepare).not.toHaveBeenCalled();
  });

  it('Document.title is the pinned version content title (not the hard-coded literal)', async () => {
    await orch.request(base);
    expect(signing.prepare.mock.calls[0]?.[0].title).toBe('Exclusive Right to Represent Agreement');
  });

  it('a blank version title falls back to the safe default title', async () => {
    versionContent = content('   ');
    await orch.request(base);
    expect(signing.prepare.mock.calls[0]?.[0].title).toBe(RTR_FALLBACK_TITLE);
  });

  it('send() envelope subject is the FROZEN Document.title', async () => {
    documents.getDocument.mockResolvedValue({ id: 'doc-1', title: 'Exclusive Right to Represent Agreement' });
    await orch.send({ tenant_id: TENANT, document_id: 'doc-1', talent_id: TALENT, created_by: 'user-1', requestId: 'r-2' });
    expect(signing.send.mock.calls[0]?.[0].subject).toBe('Exclusive Right to Represent Agreement');
  });

  it('send() falls back to the default subject when the document title is blank or unreadable', async () => {
    documents.getDocument.mockResolvedValueOnce({ id: 'doc-1', title: '' });
    await orch.send({ tenant_id: TENANT, document_id: 'doc-1', talent_id: TALENT, created_by: 'user-1', requestId: 'r-3' });
    expect(signing.send.mock.calls[0]?.[0].subject).toBe(RTR_FALLBACK_TITLE);
    documents.getDocument.mockRejectedValueOnce(new DocumentNotFoundError('doc-x'));
    await orch.send({ tenant_id: TENANT, document_id: 'doc-x', talent_id: TALENT, created_by: 'user-1', requestId: 'r-4' });
    expect(signing.send.mock.calls[1]?.[0].subject).toBe(RTR_FALLBACK_TITLE);
  });
});
