import { Inject, Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { DocumentsRepository, RenderService } from '@aramo/documents';
import { SIGNATURE_PROVIDER_PORT, type SignatureProviderPort } from '@aramo/documents-contracts';
import { TalentRecordRepository } from '@aramo/talent-record';

// DOC-5 (R-5-5/6) — the dedicated apps/api RTR orchestrator. The ONLY layer that
// may touch both scope:boundary Documents/E-Sign AND scope:ats TalentRecord. It
// COMPOSES generic primitives (Documents create/associate + RenderService freeze
// + SIGNATURE_PROVIDER_PORT create/send) into the RTR workflow — the FIRST real
// consumer of createEnvelope/sendEnvelope. Documents + E-Sign gain NO RTR logic.
// The Talent signer is resolved AUTHORITATIVELY server-side from TalentRecord.

// The seeded SYSTEM RIGHT_TO_REPRESENT DocumentType (R-5-2, fixed UUID).
export const RIGHT_TO_REPRESENT_TYPE_ID = 'd0c50005-0000-7000-8000-000000000001';

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
  ) {}

  // request → create the RTR Document + the three RTR associations (§365).
  async request(input: RtrRequestInput): Promise<{ document_id: string }> {
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
    // Declare the requisition's RTR requirement (idempotent) so the readiness
    // gate engages for this requisition's submits (R-5-11). Satisfaction is
    // per-(talent, requisition) via the PL-1 executed-document predicate.
    await this.documents.ensureRequirement({
      tenant_id: input.tenant_id,
      document_type_id: RIGHT_TO_REPRESENT_TYPE_ID,
      resource_type: 'REQUISITION',
      resource_id: input.requisition_id,
      created_by: input.created_by,
    });
    return { document_id: doc.id };
  }

  // send → resolve the Talent signer, freeze a revision, then create + send the
  // signature envelope (E-Sign is provider-neutral; no RTR knowledge crosses).
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

    // Transition DRAFT → PREPARED (idempotent). Drives the DERIVED status
    // (PL-3): DRAFT=REQUESTED, PREPARED=AWAITING_SIGNATURE, EXECUTED=EXECUTED.
    await this.documents.prepareDocument({
      tenant_id: input.tenant_id,
      document_id: input.document_id,
      actor_id: input.created_by,
      request_id: input.requestId,
    });

    // prepare/freeze — a deterministic frozen revision to sign (R-5-5).
    const rendered = await this.render.generateRevision({
      tenant_id: input.tenant_id,
      document_id: input.document_id,
      actor_id: input.created_by,
      requestId: input.requestId,
      model: {
        render_schema_version: 'v1',
        title: 'Right to Represent',
        blocks: [
          { type: 'HEADING', text: 'Right to Represent' },
          { type: 'TEXT', text: `This authorizes representation of ${name} to the associated client for the associated requisition.` },
        ],
      },
    });

    const envelope = await this.signature.createEnvelope({
      tenant_id: input.tenant_id,
      subject: 'Right to Represent',
      execution_mode: 'SINGLE_SIGNATURE',
      created_by: input.created_by,
      documents: [
        {
          document_ref: input.document_id,
          document_revision_ref: rendered.revision_id,
          source_sha256: rendered.sha256,
          title: 'Right to Represent',
          ordinal: 1,
        },
      ],
      signers: [{ email, name, signing_order: 1 }],
    });
    const sent = await this.signature.sendEnvelope(input.tenant_id, envelope.envelope_id);
    return { document_id: input.document_id, envelope_id: envelope.envelope_id, status: sent.status };
  }

  // DOC-5 (R-5-12, PL-3) — DERIVED status only. The authoritative facts are the
  // Document status + associations + (via write-back) the executed artifacts;
  // this computes a read-model label, storing no second RTR authority.
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
