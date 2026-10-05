import { Inject, Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { DocumentsRepository, RenderService } from '@aramo/documents';
import { SIGNATURE_PROVIDER_PORT, type SignatureProviderPort } from '@aramo/documents-contracts';
import { type RenderModel } from '@aramo/documents-rendering';

// GOVERNED DOCUMENT SIGNING — the single reusable application-level capability that owns the
// common mechanics of preparing, sending, reminding, and reading the state of a governed,
// e-signed document (PO/architecture ruling, Offer & Start). Business domains stay authoritative
// for WHY a document exists and WHEN it is required — Offer owns the OFFER_LETTER lifecycle,
// Pre-start/DocumentRequirement owns CLIENT_NDA, RTR owns right-to-represent — and each passes
// authoritative inputs (document type, resolved render model, associations, recipient). This
// layer owns HOW: create + freeze an immutable revision, duplicate-envelope-guarded send,
// same-envelope reminder, derived signing state, executed artifact + certificate. It is NOT a
// workflow engine and holds no business state; Documents owns document/revision/artifact, E-sign
// owns signer/envelope/execution. Extracted from the RTR + offer-document orchestrators so send/
// remind/signing-state mechanics are defined once, not re-implemented per document type.

export interface GovernedSigner {
  readonly email: string;
  readonly name: string;
}

export interface GovernedDocumentAssociation {
  readonly resource_type: string;
  readonly resource_id: string;
  readonly relationship: string;
}

export interface GovernedSigningState {
  readonly document_id: string;
  readonly status: string;
  readonly document_status: string;
  readonly preview_available: boolean;
  readonly executed_available: boolean;
  readonly certificate_available: boolean;
}

@Injectable()
export class GovernedDocumentSigningService {
  constructor(
    private readonly documents: DocumentsRepository,
    private readonly render: RenderService,
    @Inject(SIGNATURE_PROVIDER_PORT) private readonly signature: SignatureProviderPort,
  ) {}

  // The SINGLE canonical derived signing status (DOC-5/DOC-6/journey parity): a read-model label
  // over the write-back-authoritative Document.status — no second stored authority.
  deriveStatus(documentStatus: string): string {
    if (documentStatus === 'EXECUTED') return 'EXECUTED';
    if (documentStatus === 'PREPARED' || documentStatus === 'EXECUTION_PENDING') return 'AWAITING_SIGNATURE';
    if (documentStatus === 'DRAFT') return 'REQUESTED';
    return documentStatus;
  }

  // prepare — create the governed Document (+ associations) and FREEZE an immutable revision now
  // from the domain-resolved render model. Freezing at prepare time (not send time) makes send
  // idempotent + duplicate-envelope-guardable against a stable revision.
  async prepare(input: {
    tenant_id: string;
    document_type_id: string;
    title: string;
    execution_mode: string;
    source_kind: string;
    created_by: string;
    requestId: string;
    associations: readonly GovernedDocumentAssociation[];
    render: RenderModel;
    // Durable provenance (INV-2) — the pinned template version, when the domain rendered from a
    // governed template (RTR). Omitted for inline-model documents (offer letter).
    template_version_id?: string;
  }): Promise<{ document_id: string; revision_id: string }> {
    const doc = await this.documents.createDocument({
      tenant_id: input.tenant_id,
      document_type_id: input.document_type_id,
      title: input.title,
      execution_mode: input.execution_mode,
      source_kind: input.source_kind,
      created_by: input.created_by,
      associations: input.associations.map((a) => ({ ...a })),
      request_id: input.requestId,
    });
    const rendered = await this.render.generateRevision({
      tenant_id: input.tenant_id,
      document_id: doc.id,
      actor_id: input.created_by,
      requestId: input.requestId,
      template_version_id: input.template_version_id,
      model: input.render,
    });
    return { document_id: doc.id, revision_id: rendered.revision_id };
  }

  // send — consume the frozen revision, duplicate-envelope-guard (a repeat returns the existing
  // non-terminal envelope, never a second), transition DRAFT→PREPARED (idempotent), then create +
  // send the envelope. The caller supplies the authoritative subject/recipient (server-resolved).
  async send(input: {
    tenant_id: string;
    document_id: string;
    subject: string;
    execution_mode: string;
    recipient: GovernedSigner;
    created_by: string;
    requestId: string;
  }): Promise<{ document_id: string; envelope_id: string; status: string }> {
    const revision = await this.documents.getCurrentRevision(input.tenant_id, input.document_id);
    if (revision === null || revision.content_sha256 === null) {
      throw new AramoError('VALIDATION_ERROR', 'document has no prepared revision to send; prepare it first', 422, {
        requestId: input.requestId,
        details: { document_id: input.document_id },
      });
    }
    // Duplicate-envelope guard (W1-C1/§19): never mint a second active envelope for the same
    // (tenant, document, frozen revision). >1 live ⇒ ESIGN_ENVELOPE_AMBIGUOUS from the port.
    const existing = await this.signature.findEnvelopeForDocument(input.tenant_id, input.document_id, revision.id);
    if (existing !== null) {
      return { document_id: input.document_id, envelope_id: existing.envelope_id, status: existing.status };
    }
    await this.documents.prepareDocument({
      tenant_id: input.tenant_id,
      document_id: input.document_id,
      actor_id: input.created_by,
      request_id: input.requestId,
    });
    const envelope = await this.signature.createEnvelope({
      tenant_id: input.tenant_id,
      subject: input.subject,
      execution_mode: input.execution_mode,
      created_by: input.created_by,
      documents: [
        {
          document_ref: input.document_id,
          document_revision_ref: revision.id,
          source_sha256: revision.content_sha256,
          title: input.subject,
          ordinal: 1,
        },
      ],
      signers: [{ email: input.recipient.email, name: input.recipient.name, signing_order: 1 }],
    });
    const sent = await this.signature.sendEnvelope(input.tenant_id, envelope.envelope_id);
    return { document_id: input.document_id, envelope_id: envelope.envelope_id, status: sent.status };
  }

  // remind — same-envelope reminder against the SAME frozen revision + SAME envelope. Allowed ONLY
  // while AWAITING_SIGNATURE (E-sign additionally enforces SENT/IN_PROGRESS). Never re-renders,
  // re-templates, or mints a new envelope. envelope_id is reverse-resolved server-side.
  async remind(input: {
    tenant_id: string;
    document_id: string;
    requestId: string;
  }): Promise<{ document_id: string; status: string; reminder_sent: true }> {
    const doc = await this.documents.getDocument(input.tenant_id, input.document_id);
    const derived = this.deriveStatus(doc.status);
    if (derived !== 'AWAITING_SIGNATURE') {
      throw new AramoError('ESIGN_REMINDER_NOT_ALLOWED', `document is ${derived}, not awaiting signature`, 409, {
        requestId: input.requestId,
        details: { document_id: input.document_id },
      });
    }
    const revision = await this.documents.getCurrentRevision(input.tenant_id, input.document_id);
    if (revision === null) {
      throw new AramoError('ESIGN_REMINDER_NOT_ALLOWED', 'document has no frozen revision to remind', 409, {
        requestId: input.requestId,
        details: { document_id: input.document_id },
      });
    }
    const envelope = await this.signature.findEnvelopeForDocument(input.tenant_id, input.document_id, revision.id);
    if (envelope === null) {
      throw new AramoError('ESIGN_ENVELOPE_NOT_FOUND_FOR_DOCUMENT', 'no active signature envelope for this document', 404, {
        requestId: input.requestId,
        details: { document_id: input.document_id },
      });
    }
    await this.signature.remindEnvelopeSigner(input.tenant_id, envelope.envelope_id);
    return { document_id: input.document_id, status: derived, reminder_sent: true };
  }

  // getSigningState — derived status + artifact availability (preview/executed/certificate). The
  // read projection a recruiter surface consumes; stores no second authority.
  async getSigningState(tenant_id: string, document_id: string): Promise<GovernedSigningState> {
    const doc = await this.documents.getDocument(tenant_id, document_id);
    const [unsigned, executed, certificate] = await Promise.all([
      this.documents.listArtifacts(tenant_id, document_id, 'RENDERED_UNSIGNED'),
      this.documents.listArtifacts(tenant_id, document_id, 'EXECUTED'),
      this.documents.listArtifacts(tenant_id, document_id, 'EXECUTION_CERTIFICATE'),
    ]);
    return {
      document_id,
      status: this.deriveStatus(doc.status),
      document_status: doc.status,
      preview_available: unsigned.length > 0,
      executed_available: executed.length > 0,
      certificate_available: certificate.length > 0,
    };
  }
}
