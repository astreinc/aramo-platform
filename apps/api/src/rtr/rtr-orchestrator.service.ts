import { Inject, Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import {
  DocumentsRepository,
  RenderService,
  TemplatesRepository,
  DocumentNotFoundError,
  type DocumentStoragePort,
} from '@aramo/documents';
import { SIGNATURE_PROVIDER_PORT, type SignatureProviderPort } from '@aramo/documents-contracts';
import { TalentRecordRepository } from '@aramo/talent-record';

import { RIGHT_TO_REPRESENT_KEY, RIGHT_TO_REPRESENT_TYPE_ID } from './rtr-constants.js';
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

// Recruiter-safe provenance — from the EXACT pinned TemplateVersion (§13), never
// DocumentTemplate.current_version_id. No internal ids are exposed.
export interface RtrProvenanceView {
  name: string;
  version_number: number;
}

export interface RtrCurrentView {
  document_id: string;
  status: string;
  document_status: string;
  template: RtrProvenanceView | null;
  preview_available: boolean;
  executed_available: boolean;
  certificate_available: boolean;
}

export interface RtrPreviewView {
  url: string;
  expires_at: string;
  content_sha256: string;
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
    private readonly templates: TemplatesRepository,
    // Supplied positionally by the RtrModule factory (RTR_DOCS_STORAGE token).
    private readonly storage: DocumentStoragePort,
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
    return { document_id, status: this.deriveStatus(doc.status), document_status: doc.status };
  }

  // RTR-TEMPLATE-1 (§14, §15) — the authoritative current RTR for an exact
  // tenant + talent + requisition, so the recruiter panel restores state on
  // reload without re-deriving in the browser. Returns null when none exists
  // (normal — the recruiter has not requested yet). Provenance comes from the
  // EXACT pinned version (§13), never today's active template.
  async current(input: {
    tenant_id: string;
    talent_id: string;
    requisition_id: string;
    requestId: string;
  }): Promise<RtrCurrentView | null> {
    const docs = await this.documents.findDocumentsByTypeKeyAndAssociations({
      tenant_id: input.tenant_id,
      document_type_key: RIGHT_TO_REPRESENT_KEY,
      associations: [
        { resource_type: 'TALENT', resource_id: input.talent_id, relationship: 'SUBJECT' },
        { resource_type: 'REQUISITION', resource_id: input.requisition_id, relationship: 'REGARDING' },
      ],
    });
    if (docs.length === 0) return null;
    const selected = this.selectCurrent(docs);

    const [unsigned, executed, certificate] = await Promise.all([
      this.documents.listArtifacts(input.tenant_id, selected.id, 'RENDERED_UNSIGNED'),
      this.documents.listArtifacts(input.tenant_id, selected.id, 'EXECUTED'),
      this.documents.listArtifacts(input.tenant_id, selected.id, 'EXECUTION_CERTIFICATE'),
    ]);

    return {
      document_id: selected.id,
      status: this.deriveStatus(selected.status),
      document_status: selected.status,
      template: await this.resolveProvenance(input.tenant_id, selected.id),
      preview_available: unsigned.length > 0,
      executed_available: executed.length > 0,
      certificate_available: certificate.length > 0,
    };
  }

  // RTR-TEMPLATE-1 (§16) — presigned read access to the EXACT frozen unsigned
  // artifact (the bytes send will transmit). Tenant-validated; never exposes the
  // storage key. Fails closed if the document is not RTR or has no frozen preview.
  async preview(tenant_id: string, document_id: string, requestId: string): Promise<RtrPreviewView> {
    let doc;
    try {
      doc = await this.documents.getDocument(tenant_id, document_id);
    } catch (e) {
      if (e instanceof DocumentNotFoundError) {
        throw new AramoError('DOCUMENT_NOT_FOUND', `RTR document ${document_id} not found`, 404, { requestId });
      }
      throw e;
    }
    if (doc.document_type_id !== RIGHT_TO_REPRESENT_TYPE_ID) {
      throw new AramoError('DOCUMENT_NOT_FOUND', `document ${document_id} is not an RTR`, 404, { requestId });
    }
    const revision = await this.documents.getCurrentRevision(tenant_id, document_id);
    if (revision === null) {
      throw new AramoError('RTR_PREVIEW_NOT_AVAILABLE', 'RTR has no frozen revision to preview', 409, { requestId, details: { document_id } });
    }
    const artifacts = await this.documents.listArtifacts(tenant_id, document_id, 'RENDERED_UNSIGNED');
    const artifact = artifacts.find((a) => a.revision_id === revision.id) ?? null;
    if (artifact === null || artifact.sha256 === null) {
      throw new AramoError('RTR_PREVIEW_NOT_AVAILABLE', 'RTR has no rendered unsigned artifact to preview', 409, { requestId, details: { document_id } });
    }
    const access = await this.storage.createReadAccess({
      storage_key: artifact.storage_locator,
      requestId,
      expires_in_seconds: 300,
    });
    return { url: access.url, expires_at: access.expires_at, content_sha256: artifact.sha256 };
  }

  // §15 current-selection precedence: a live (non-terminal) RTR wins; else the
  // most recent EXECUTED; else the most recent. `docs` is created_at desc.
  private selectCurrent<T extends { status: string }>(docs: readonly T[]): T {
    const live = docs.find((d) => d.status !== 'EXECUTED' && d.status !== 'VOIDED');
    if (live !== undefined) return live;
    const executed = docs.find((d) => d.status === 'EXECUTED');
    if (executed !== undefined) return executed;
    return docs[0] as T;
  }

  // Provenance from the PINNED version on the document's current revision — NOT
  // DocumentTemplate.current_version_id (§13). Null when the document carries no
  // pinned version (legacy/pre-template RTRs) or the rows are unresolvable.
  private async resolveProvenance(tenant_id: string, document_id: string): Promise<RtrProvenanceView | null> {
    const revision = await this.documents.getCurrentRevision(tenant_id, document_id);
    if (revision === null || revision.template_version_id === null) return null;
    const version = await this.templates.findVersionById(tenant_id, revision.template_version_id);
    if (version === null) return null;
    const template = await this.templates.findTemplateById(tenant_id, version.template_id);
    if (template === null) return null;
    return { name: template.name, version_number: version.version_number };
  }

  private deriveStatus(docStatus: string): string {
    return docStatus === 'EXECUTED'
      ? 'EXECUTED'
      : docStatus === 'PREPARED' || docStatus === 'EXECUTION_PENDING'
        ? 'AWAITING_SIGNATURE'
        : docStatus === 'DRAFT'
          ? 'REQUESTED'
          : docStatus;
  }
}
