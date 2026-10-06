import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import {
  DocumentsRepository,
  TemplatesRepository,
  DocumentNotFoundError,
  type DocumentStoragePort,
} from '@aramo/documents';
import { TalentRecordRepository } from '@aramo/talent-record';

import { GovernedDocumentSigningService } from '../document-signing/governed-document-signing.service.js';

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

// COMM-RECRUITER-W1 (W1-C3) — RTR reminder result. RTR business state is
// UNCHANGED (reminder is action/evidence, not a lifecycle transition); status
// remains AWAITING_SIGNATURE.
export interface RtrRemindResult {
  document_id: string;
  status: string;
  reminder_sent: true;
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
    // Shared governed-document signing mechanics (prepare/send/remind/state) — the common
    // e-sign execution layer. RTR keeps only RTR-specific template/provenance/preview logic.
    private readonly signing: GovernedDocumentSigningService,
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

    // 3. Create the RTR Document (+ the three RTR associations) and FREEZE the pinned-template
    //    revision — delegated to the shared governed-signing capability. template_version_id is
    //    carried through for durable provenance (INV-2): the exact frozen artifact preview shows
    //    and send transmits. RTR owns WHAT (type + associations + resolved model); the shared
    //    capability owns the create+freeze mechanics.
    const { document_id } = await this.signing.prepare({
      tenant_id: input.tenant_id,
      document_type_id: RIGHT_TO_REPRESENT_TYPE_ID,
      title: 'Right to Represent',
      execution_mode: 'SINGLE_SIGNATURE',
      source_kind: 'TEMPLATE_GENERATED',
      created_by: input.created_by,
      requestId: input.requestId,
      associations: [
        { resource_type: 'TALENT', resource_id: input.talent_id, relationship: 'SUBJECT' },
        { resource_type: 'REQUISITION', resource_id: input.requisition_id, relationship: 'REGARDING' },
        { resource_type: 'COMPANY', resource_id: input.company_id, relationship: 'CLIENT' },
      ],
      render: model,
      template_version_id: template.template_version_id,
    });

    // 4. Declare the requisition's RTR requirement (idempotent) so the readiness gate engages
    //    for this requisition's submits (R-5-11). RTR-specific; stays in the domain.
    await this.documents.ensureRequirement({
      tenant_id: input.tenant_id,
      document_type_id: RIGHT_TO_REPRESENT_TYPE_ID,
      resource_type: 'REQUISITION',
      resource_id: input.requisition_id,
      created_by: input.created_by,
    });

    return { document_id };
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
    // RTR owns the signer resolution (the Talent on this RTR). The common send mechanics —
    // consume the frozen revision (no re-render, INV-3), duplicate-envelope guard, DRAFT→PREPARED,
    // create + send — are delegated to the shared governed-signing capability.
    const talent = await this.talent.findById({ tenant_id: input.tenant_id, id: input.talent_id });
    if (talent === null) {
      throw new AramoError('DOCUMENT_NOT_FOUND', `talent ${input.talent_id} not found`, 404, { requestId: input.requestId });
    }
    const email = talent.email1;
    if (email === null || email === undefined || email.length === 0) {
      throw new AramoError('VALIDATION_ERROR', 'talent has no email for RTR signing', 400, { requestId: input.requestId });
    }
    const name = `${talent.first_name} ${talent.last_name}`.trim();
    return this.signing.send({
      tenant_id: input.tenant_id,
      document_id: input.document_id,
      subject: 'Right to Represent',
      execution_mode: 'SINGLE_SIGNATURE',
      recipient: { email, name },
      created_by: input.created_by,
      requestId: input.requestId,
    });
  }

  // remind → COMM-RECRUITER-W1 (W1-C3). Send a reminder against the SAME existing
  // RTR Document + SAME frozen DocumentRevision + SAME E-Sign envelope. It NEVER
  // generates another RTR, re-renders, re-resolves a template, changes the pay
  // rate, or creates a new envelope. Allowed ONLY while the RTR is
  // AWAITING_SIGNATURE (envelope SENT/IN_PROGRESS, enforced in E-Sign). The
  // envelope is reverse-resolved server-side from the exact frozen revision —
  // envelope_id is never exposed to the FE.
  async remind(input: {
    tenant_id: string;
    document_id: string;
    requestId: string;
  }): Promise<RtrRemindResult> {
    // RTR-specific guard: the reminder endpoint addresses an RTR document only (concealment —
    // a non-RTR / cross-tenant id is NOT FOUND). The common same-envelope reminder mechanics
    // (AWAITING_SIGNATURE gate, frozen-revision reverse-resolve, remindEnvelopeSigner) are
    // delegated to the shared capability.
    let doc;
    try {
      doc = await this.documents.getDocument(input.tenant_id, input.document_id);
    } catch (e) {
      if (e instanceof DocumentNotFoundError) {
        throw new AramoError('DOCUMENT_NOT_FOUND', `RTR document ${input.document_id} not found`, 404, { requestId: input.requestId });
      }
      throw e;
    }
    if (doc.document_type_id !== RIGHT_TO_REPRESENT_TYPE_ID) {
      throw new AramoError('DOCUMENT_NOT_FOUND', `document ${input.document_id} is not an RTR`, 404, { requestId: input.requestId });
    }
    return this.signing.remind({ tenant_id: input.tenant_id, document_id: input.document_id, requestId: input.requestId });
  }

  // DOC-5 (R-5-12, PL-3) — DERIVED status only (no second stored authority).
  async status(tenant_id: string, document_id: string): Promise<{ document_id: string; status: string; document_status: string }> {
    const doc = await this.documents.getDocument(tenant_id, document_id);
    return { document_id, status: this.signing.deriveStatus(doc.status), document_status: doc.status };
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

    // Status + artifact availability via the shared signing-state read; RTR adds only its
    // pinned-template provenance (§13). Collapses the duplicated artifact-availability derivation.
    const [state, template] = await Promise.all([
      this.signing.getSigningState(input.tenant_id, selected.id),
      this.resolveProvenance(input.tenant_id, selected.id),
    ]);

    return {
      document_id: selected.id,
      status: state.status,
      document_status: state.document_status,
      template,
      preview_available: state.preview_available,
      executed_available: state.executed_available,
      certificate_available: state.certificate_available,
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
}
