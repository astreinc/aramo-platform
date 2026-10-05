import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { OfferRepository } from '@aramo/placement';
import { TalentRecordRepository } from '@aramo/talent-record';

import { GovernedDocumentSigningService } from '../document-signing/governed-document-signing.service.js';

// DOC-6 — the offer-letter orchestrator. THIN business orchestration (PL-1 evidence-only): it
// knows WHY/WHEN an OFFER_LETTER exists (read the Offer for associations + the server-resolved
// Talent signer) and delegates the HOW — prepare/send/remind/signing-state — to the shared
// GovernedDocumentSigningService (PO/architecture ruling). It NEVER transitions the Offer: the
// Offer state machine stays the sole authority for ACCEPT (Document=EXECUTED while Offer=SENT is
// a valid dual state). PL-2: SINGLE_SIGNATURE; the sole signer (the Talent) is resolved
// server-side from the authoritative Offer → TalentRecord, never supplied by the client.

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
    private readonly signing: GovernedDocumentSigningService,
    private readonly talent: TalentRecordRepository,
    private readonly offers: OfferRepository,
  ) {}

  private async readOffer(tenant_id: string, offer_id: string, requestId: string) {
    const offer = await this.offers.findById(tenant_id, offer_id);
    if (offer === null) {
      throw new AramoError('DOCUMENT_NOT_FOUND', `offer ${offer_id} not found`, 404, { requestId });
    }
    return offer;
  }

  private async talentName(tenant_id: string, talent_record_id: string, requestId: string): Promise<string> {
    const talent = await this.talent.findById({ tenant_id, id: talent_record_id });
    if (talent === null) {
      throw new AramoError('DOCUMENT_NOT_FOUND', `talent ${talent_record_id} not found`, 404, { requestId });
    }
    return `${talent.first_name} ${talent.last_name}`.trim();
  }

  // request → read the Offer (PL-1 read-only) → delegate create + freeze (the OFFER_LETTER
  // Document + three associations + an immutable rendered revision) to the shared capability.
  // Freezing at request time makes send idempotent + duplicate-envelope-guardable (R-6-4).
  async request(input: OfferDocumentRequestInput): Promise<{ document_id: string; offer_id: string }> {
    const offer = await this.readOffer(input.tenant_id, input.offer_id, input.requestId);
    const name = await this.talentName(input.tenant_id, offer.talent_record_id, input.requestId);
    const { document_id } = await this.signing.prepare({
      tenant_id: input.tenant_id,
      document_type_id: OFFER_LETTER_TYPE_ID,
      title: 'Offer Letter',
      execution_mode: 'SINGLE_SIGNATURE',
      source_kind: 'TEMPLATE_GENERATED',
      created_by: input.created_by,
      requestId: input.requestId,
      associations: [
        { resource_type: 'TALENT', resource_id: offer.talent_record_id, relationship: 'SUBJECT' },
        { resource_type: 'OFFER', resource_id: offer.id, relationship: 'REGARDING' },
        { resource_type: 'REQUISITION', resource_id: offer.requisition_id, relationship: 'REGARDING' },
      ],
      render: {
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
    return { document_id, offer_id: offer.id };
  }

  // send → resolve the Talent signer AUTHORITATIVELY from the Offer (PL-2), then delegate the
  // duplicate-guarded send to the shared capability. Evidence-only: NO Offer transition (PL-1).
  async send(input: {
    tenant_id: string;
    document_id: string;
    offer_id: string;
    created_by: string;
    requestId: string;
  }): Promise<OfferDocumentSendResult> {
    const offer = await this.readOffer(input.tenant_id, input.offer_id, input.requestId);
    const talent = await this.talent.findById({ tenant_id: input.tenant_id, id: offer.talent_record_id });
    if (talent === null) {
      throw new AramoError('DOCUMENT_NOT_FOUND', `talent ${offer.talent_record_id} not found`, 404, { requestId: input.requestId });
    }
    const email = talent.email1;
    if (email === null || email === undefined || email.length === 0) {
      throw new AramoError('VALIDATION_ERROR', 'talent has no email for offer-letter signing', 400, { requestId: input.requestId });
    }
    const name = `${talent.first_name} ${talent.last_name}`.trim();
    return this.signing.send({
      tenant_id: input.tenant_id,
      document_id: input.document_id,
      subject: 'Offer Letter',
      execution_mode: 'SINGLE_SIGNATURE',
      recipient: { email, name },
      created_by: input.created_by,
      requestId: input.requestId,
    });
  }

  // remind → same-envelope signer reminder via the shared capability (AWAITING_SIGNATURE-gated).
  async remind(input: { tenant_id: string; document_id: string; requestId: string }): Promise<{ document_id: string; status: string; reminder_sent: true }> {
    return this.signing.remind({ tenant_id: input.tenant_id, document_id: input.document_id, requestId: input.requestId });
  }

  // DERIVED status only (PL-3) — delegated to the shared signing-state read; stores no second
  // authority and is DISTINCT from the Offer's state.
  async status(tenant_id: string, document_id: string): Promise<{ document_id: string; status: string; document_status: string }> {
    const state = await this.signing.getSigningState(tenant_id, document_id);
    return { document_id, status: state.status, document_status: state.document_status };
  }
}
