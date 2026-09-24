import { Inject, Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { DocumentsRepository, RenderService } from '@aramo/documents';
import { SIGNATURE_PROVIDER_PORT, type SignatureProviderPort } from '@aramo/documents-contracts';
import { OfferRepository } from '@aramo/placement';
import { TalentRecordRepository } from '@aramo/talent-record';

// DOC-6 (R-6-4/5/6) — the dedicated apps/api Offer-document orchestrator. The ONLY
// layer that may touch both scope:boundary Documents/E-Sign AND scope:ats
// placement/TalentRecord. It COMPOSES generic primitives (Documents create/associate
// + RenderService freeze + SIGNATURE_PROVIDER_PORT create/send) into the offer-letter
// workflow. Documents + E-Sign gain NO offer logic (R10).
//
// PL-1 (evidence-only, zero state coupling): this orchestrator ONLY READS the Offer
// (OfferRepository.findById) to populate associations + resolve the signer. It NEVER
// calls OfferTransitionPolicyService, never transitions the Offer, never writes a
// placement row. Signing produces an EXECUTED OFFER_LETTER as durable evidence; the
// Offer state machine remains the sole authority for ACCEPT. Document=EXECUTED while
// Offer=SENT is an intended, valid dual state.
// PL-2 (single signer, server-resolved): SINGLE_SIGNATURE; the sole signer (the
// Talent) is resolved server-side from the authoritative Offer row → TalentRecord —
// never supplied by the client.

// The seeded SYSTEM OFFER_LETTER DocumentType id (R-6-2, fixed UUID).
export const OFFER_LETTER_TYPE_ID = 'd0c50006-0000-7000-8000-000000000001';

export interface OfferDocumentRequestInput {
  tenant_id: string;
  offer_id: string;
  created_by: string;
  requestId: string;
}

export interface OfferDocumentSendResult {
  document_id: string;
  envelope_id: string;
  status: string;
}

@Injectable()
export class OfferDocumentOrchestratorService {
  constructor(
    private readonly documents: DocumentsRepository,
    private readonly render: RenderService,
    @Inject(SIGNATURE_PROVIDER_PORT) private readonly signature: SignatureProviderPort,
    private readonly talent: TalentRecordRepository,
    private readonly offers: OfferRepository,
  ) {}

  // request → read the Offer (PL-1 read-only) → create the OFFER_LETTER Document +
  // the three associations (TALENT/SUBJECT, OFFER/REGARDING, REQUISITION/REGARDING).
  async request(input: OfferDocumentRequestInput): Promise<{ document_id: string; offer_id: string }> {
    const offer = await this.offers.findById(input.tenant_id, input.offer_id);
    if (offer === null) {
      throw new AramoError('DOCUMENT_NOT_FOUND', `offer ${input.offer_id} not found`, 404, { requestId: input.requestId });
    }
    const doc = await this.documents.createDocument({
      tenant_id: input.tenant_id,
      document_type_id: OFFER_LETTER_TYPE_ID,
      title: 'Offer Letter',
      execution_mode: 'SINGLE_SIGNATURE',
      source_kind: 'TEMPLATE_GENERATED',
      created_by: input.created_by,
      associations: [
        { resource_type: 'TALENT', resource_id: offer.talent_record_id, relationship: 'SUBJECT' },
        { resource_type: 'OFFER', resource_id: offer.id, relationship: 'REGARDING' },
        { resource_type: 'REQUISITION', resource_id: offer.requisition_id, relationship: 'REGARDING' },
      ],
      request_id: input.requestId,
    });
    return { document_id: doc.id, offer_id: offer.id };
  }

  // send → resolve the Talent signer AUTHORITATIVELY from the Offer (PL-2 — the
  // client supplies only the offer/document ref, never the signer identity), freeze a
  // revision, then create + send the signature envelope. Evidence-only: NO Offer
  // transition is fired (PL-1).
  async send(input: {
    tenant_id: string;
    document_id: string;
    offer_id: string;
    created_by: string;
    requestId: string;
  }): Promise<OfferDocumentSendResult> {
    const offer = await this.offers.findById(input.tenant_id, input.offer_id);
    if (offer === null) {
      throw new AramoError('DOCUMENT_NOT_FOUND', `offer ${input.offer_id} not found`, 404, { requestId: input.requestId });
    }
    const talent = await this.talent.findById({ tenant_id: input.tenant_id, id: offer.talent_record_id });
    if (talent === null) {
      throw new AramoError('DOCUMENT_NOT_FOUND', `talent ${offer.talent_record_id} not found`, 404, { requestId: input.requestId });
    }
    const email = talent.email1;
    if (email === null || email === undefined || email.length === 0) {
      throw new AramoError('VALIDATION_ERROR', 'talent has no email for offer-letter signing', 400, { requestId: input.requestId });
    }
    const name = `${talent.first_name} ${talent.last_name}`.trim();

    // DRAFT → PREPARED (idempotent). Drives the DERIVED status (PL-3).
    await this.documents.prepareDocument({
      tenant_id: input.tenant_id,
      document_id: input.document_id,
      actor_id: input.created_by,
      request_id: input.requestId,
    });

    // Freeze — a deterministic frozen revision to sign (R-6-4).
    const rendered = await this.render.generateRevision({
      tenant_id: input.tenant_id,
      document_id: input.document_id,
      actor_id: input.created_by,
      requestId: input.requestId,
      model: {
        render_schema_version: 'v1',
        title: 'Offer Letter',
        blocks: [
          { type: 'HEADING', text: 'Offer Letter' },
          { type: 'TEXT', text: `This offer letter is presented to ${name} for signature.` },
          ...(offer.offer_terms_summary !== null && offer.offer_terms_summary.length > 0
            ? [{ type: 'TEXT', text: offer.offer_terms_summary }]
            : []),
        ],
      },
    });

    const envelope = await this.signature.createEnvelope({
      tenant_id: input.tenant_id,
      subject: 'Offer Letter',
      execution_mode: 'SINGLE_SIGNATURE',
      created_by: input.created_by,
      documents: [
        {
          document_ref: input.document_id,
          document_revision_ref: rendered.revision_id,
          source_sha256: rendered.sha256,
          title: 'Offer Letter',
          ordinal: 1,
        },
      ],
      signers: [{ email, name, signing_order: 1 }],
    });
    const sent = await this.signature.sendEnvelope(input.tenant_id, envelope.envelope_id);
    return { document_id: input.document_id, envelope_id: envelope.envelope_id, status: sent.status };
  }

  // DOC-6 (R-6-4, PL-3) — DERIVED status only. Authoritative facts are the Document
  // status + associations + (via write-back) the executed artifacts; this computes a
  // read-model label, storing no second authority. DISTINCT from the Offer's state.
  async status(tenant_id: string, document_id: string): Promise<{ document_id: string; status: string; document_status: string }> {
    const doc = await this.documents.getDocument(tenant_id, document_id);
    const derived =
      doc.status === 'EXECUTED'
        ? 'EXECUTED'
        : doc.status === 'PREPARED' || doc.status === 'EXECUTION_PENDING'
          ? 'AWAITING_SIGNATURE'
          : doc.status === 'DRAFT'
            ? 'PREPARING'
            : doc.status;
    return { document_id, status: derived, document_status: doc.status };
  }
}
