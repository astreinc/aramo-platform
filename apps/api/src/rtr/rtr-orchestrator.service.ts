import { Inject, Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { DocumentsRepository, RenderService } from '@aramo/documents';
import { SIGNATURE_PROVIDER_PORT, type SignatureProviderPort } from '@aramo/documents-contracts';
import { TalentRecordRepository } from '@aramo/talent-record';

import { RIGHT_TO_REPRESENT_TYPE_ID } from './rtr-constants.js';
import { RtrTemplateResolverService } from './rtr-template-resolver.service.js';
import { RtrTemplateBindingService } from './rtr-template-binding.service.js';

// DOC-5 / RTR-TEMPLATE-1 — the dedicated apps/api RTR orchestrator. The ONLY layer
// that may touch both scope:boundary Documents/E-Sign AND scope:ats TalentRecord.
// It COMPOSES generic primitives into the RTR workflow and is now TEMPLATE-DRIVEN:
// request() resolves the tenant's ACTIVE RIGHT_TO_REPRESENT DocumentTemplate, pins
// the exact TemplateVersion, resolves the closed binding catalog, and renders a
// FROZEN revision immediately. There is NO inline RTR body and NO fallback path
// (INV-12): a request with no valid template/binding fails closed. send() consumes
// the already-frozen revision and NEVER re-resolves or re-renders (INV-3).

// Re-exported from the single apps/api source (rtr-constants). Kept exported here
// for existing importers; the literal lives in rtr-constants.ts only.
export { RIGHT_TO_REPRESENT_TYPE_ID };

export interface RtrRequestInput {
  tenant_id: string;
  talent_id: string;
  requisition_id: string;
  company_id: string;
  created_by: string;
  requestId: string;
}

export interface RtrSendResult {
  document_id: string;
  envelope_id: string;
  status: string;
}

@Injectable()
export class RtrOrchestratorService {
  constructor(
    private readonly documents: DocumentsRepository,
    private readonly render: RenderService,
    @Inject(SIGNATURE_PROVIDER_PORT) private readonly signature: SignatureProviderPort,
    private readonly talent: TalentRecordRepository,
    private readonly resolver: RtrTemplateResolverService,
    private readonly binding: RtrTemplateBindingService,
  ) {}

  // request → the PREPARE boundary (RTR-TEMPLATE-1 §11). Resolve the governed
  // template + bindings FIRST (fail closed before any persistence), then create
  // the RTR Document + associations + requirement, then render the pinned
  // template into a FROZEN revision. After this the document is ready to preview
  // and ready to send; status stays REQUESTED (DRAFT) until send.
  async request(input: RtrRequestInput): Promise<{ document_id: string }> {
    // 1. Resolve the tenant's ACTIVE RTR template and PIN its exact version.
    //    Throws RTR_TEMPLATE_NOT_CONFIGURED / _CONFIGURATION_INVALID — no fallback.
    const template = await this.resolver.resolveActive({
      tenant_id: input.tenant_id,
      requestId: input.requestId,
    });

    // 2. Resolve the closed binding catalog → a fully-resolved RenderModel pinned
    //    to the exact template version. Throws RTR_TEMPLATE_BINDING_MISSING /
    //    _CONFIGURATION_INVALID before any write; no raw {{token}} can be rendered.
    const model = await this.binding.bind({
      content: template.content,
      template_version_id: template.template_version_id,
      tenant_id: input.tenant_id,
      talent_id: input.talent_id,
      requisition_id: input.requisition_id,
      company_id: input.company_id,
      requestId: input.requestId,
    });

    // 3. Create the RTR Document + the three RTR associations (§365).
    const doc = await this.documents.createDocument({
      tenant_id: input.tenant_id,
      document_type_id: RIGHT_TO_REPRESENT_TYPE_ID,
      title: 'Right to Represent',
      execution_mode: 'SINGLE_SIGNATURE',
      source_kind: 'TEMPLATE_GENERATED',
      created_by: input.created_by,
      associations: [
        { resource_type: 'TALENT', resource_id: input.talent_id, relationship: 'SUBJECT' },
        { resource_type: 'REQUISITION', resource_id: input.requisition_id, relationship: 'REGARDING' },
        { resource_type: 'COMPANY', resource_id: input.company_id, relationship: 'CLIENT' },
      ],
      request_id: input.requestId,
    });

    // 4. Declare the requisition's RTR requirement (idempotent) so the readiness
    //    gate engages for this requisition's submits (R-5-11).
    await this.documents.ensureRequirement({
      tenant_id: input.tenant_id,
      document_type_id: RIGHT_TO_REPRESENT_TYPE_ID,
      resource_type: 'REQUISITION',
      resource_id: input.requisition_id,
      created_by: input.created_by,
    });

    // 5. Render the pinned template + resolved values into a FROZEN revision.
    //    template_version_id is persisted on the revision = durable provenance
    //    (INV-2). This exact artifact is what preview shows and send transmits.
    await this.render.generateRevision({
      tenant_id: input.tenant_id,
      document_id: doc.id,
      actor_id: input.created_by,
      requestId: input.requestId,
      template_version_id: template.template_version_id,
      model,
    });

    return { document_id: doc.id };
  }

  // send → resolve the Talent signer, then create + send the signature envelope
  // over the EXISTING frozen revision. It MUST NOT resolve the template, re-bind,
  // or re-render (INV-3): a template version activated between request and send
  // cannot change this document. The envelope references the exact revision id +
  // source_sha256 produced at request time.
  async send(input: {
    tenant_id: string;
    document_id: string;
    talent_id: string;
    created_by: string;
    requestId: string;
  }): Promise<RtrSendResult> {
    const talent = await this.talent.findById({ tenant_id: input.tenant_id, id: input.talent_id });
    if (talent === null) {
      throw new AramoError('DOCUMENT_NOT_FOUND', `talent ${input.talent_id} not found`, 404, { requestId: input.requestId });
    }
    const email = talent.email1;
    if (email === null || email === undefined || email.length === 0) {
      throw new AramoError('VALIDATION_ERROR', 'talent has no email for RTR signing', 400, { requestId: input.requestId });
    }
    const name = `${talent.first_name} ${talent.last_name}`.trim();

    // Consume the frozen revision created at request time — no re-render (INV-3).
    const revision = await this.documents.getCurrentRevision(input.tenant_id, input.document_id);
    if (revision === null || revision.content_sha256 === null) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'RTR document has no prepared revision to send; request the RTR first',
        422,
        { requestId: input.requestId, details: { document_id: input.document_id } },
      );
    }

    // Transition DRAFT → PREPARED (idempotent). Drives the DERIVED status (PL-3):
    // DRAFT=REQUESTED, PREPARED=AWAITING_SIGNATURE, EXECUTED=EXECUTED.
    await this.documents.prepareDocument({
      tenant_id: input.tenant_id,
      document_id: input.document_id,
      actor_id: input.created_by,
      request_id: input.requestId,
    });

    const envelope = await this.signature.createEnvelope({
      tenant_id: input.tenant_id,
      subject: 'Right to Represent',
      execution_mode: 'SINGLE_SIGNATURE',
      created_by: input.created_by,
      documents: [
        {
          document_ref: input.document_id,
          document_revision_ref: revision.id,
          source_sha256: revision.content_sha256,
          title: 'Right to Represent',
          ordinal: 1,
        },
      ],
      signers: [{ email, name, signing_order: 1 }],
    });
    const sent = await this.signature.sendEnvelope(input.tenant_id, envelope.envelope_id);
    return { document_id: input.document_id, envelope_id: envelope.envelope_id, status: sent.status };
  }

  // DOC-5 (R-5-12, PL-3) — DERIVED status only (no second stored authority).
  async status(tenant_id: string, document_id: string): Promise<{ document_id: string; status: string; document_status: string }> {
    const doc = await this.documents.getDocument(tenant_id, document_id);
    const derived =
      doc.status === 'EXECUTED'
        ? 'EXECUTED'
        : doc.status === 'PREPARED' || doc.status === 'EXECUTION_PENDING'
          ? 'AWAITING_SIGNATURE'
          : doc.status === 'DRAFT'
            ? 'REQUESTED'
            : doc.status;
    return { document_id, status: derived, document_status: doc.status };
  }
}
