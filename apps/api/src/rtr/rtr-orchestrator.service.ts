import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import {
  DocumentsRepository,
  TemplatesRepository,
  DocumentNotFoundError,
  type DocumentStoragePort,
} from '@aramo/documents';
import { TalentRecordRepository } from '@aramo/talent-record';
import { RequisitionRepository } from '@aramo/requisition';
import { PipelineRepository } from '@aramo/pipeline';
import { type LetterheadModel, type RenderBlock } from '@aramo/documents-rendering';
import type { SignatureActor } from '@aramo/documents-contracts';

import { GovernedDocumentSigningService } from '../document-signing/governed-document-signing.service.js';
import { assertRequisitionPermitsContactSend } from '../requisition-lifecycle/requisition-contact.gate.js';

import { RIGHT_TO_REPRESENT_KEY, RIGHT_TO_REPRESENT_TYPE_ID } from './rtr-constants.js';
import { RtrTemplateResolverService } from './rtr-template-resolver.service.js';
import { RtrTemplateBindingService } from './rtr-template-binding.service.js';
import { isHtmlContent, type RtrHtmlLogoRef } from './rtr-html-content.js';

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
  // Optional (back-compat): when supplied it MUST equal the requisition's CLIENT
  // company; when absent the requisition's company is used. The requisition is the
  // authority for client.name and the COMPANY/CLIENT association (never the caller).
  company_id?: string;
  created_by: string;
  requestId: string;
}

// Document Templates slice 1 (PO ruling 3, 2026-10-16) — Document.title and the
// e-sign envelope subject follow the admin's document title (the ACTIVE version's
// content title, bound). This literal is only the safe fallback for a blank title.
export const RTR_FALLBACK_TITLE = 'Right to Represent';

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

// SEAM 4 — the read-only "Send RTR" compose view, served BEFORE any RTR Document
// exists. Provenance is the tenant's ACTIVE template (name · v{n}) — intentionally
// today's active version, since no document has pinned a version yet. The preview
// is the active version's content REAL-BOUND to THIS (talent, requisition) via the
// same closed binding catalog the send path uses (resolved blocks, in-memory only).
export interface RtrComposeView {
  template: RtrProvenanceView;
  // B2 — the fixed signature block the renderer appends (printed name = bound talent name).
  // A1 — for rtr-html-v1 content `blocks` is empty and `html` carries the REAL-bound
  // allowlisted html (field nodes → <span data-sample="{key}">{value}</span>).
  preview: { title: string; blocks: RenderBlock[]; html?: string; signature_block: { printed_name: string | null } };
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
    // SEAM 4 — authoritative source for the requisition's CLIENT company (client.name
    // binding). A compose has no request body, so company is derived from the
    // requisition rather than supplied by the caller. The binding service already
    // reads it for request(); the orchestrator reads only the id here.
    private readonly requisitions: RequisitionRepository,
    // Pipeline & RTR Recon Remediation Directive v1.0 R2 (DEF-7) — the Talent's live episode on the
    // requisition (RTR starts at Talent responded, RTR-1 AC-21). apps/api already depends on
    // @aramo/pipeline; no new nx edge.
    private readonly pipelines: PipelineRepository,
  ) {}

  // R2 (DEF-7; RTR-1 AC-21 / §23 / §29) — an RTR is requested and sent only for a Talent whose
  // live episode on this requisition is at Talent responded, Qualifying or Qualified. No episode →
  // 404 (the Talent is not on the requisition); an earlier stage → 409 RTR_STAGE_NOT_ELIGIBLE.
  private async assertRtrStage(tenant_id: string, talent_id: string, requisition_id: string, requestId: string): Promise<void> {
    const episode = await this.pipelines.findLiveEpisode({ tenant_id, talent_record_id: talent_id, requisition_id });
    if (episode === null) {
      throw new AramoError('NOT_FOUND', 'This talent is not on the requisition', 404, {
        requestId,
        details: { talent_id, requisition_id, reason: 'no_live_episode' },
      });
    }
    if (!RTR_ELIGIBLE_STAGES.has(episode.status)) {
      throw new AramoError(
        'RTR_STAGE_NOT_ELIGIBLE',
        'A Right to Represent can be sent once the talent has responded',
        409,
        { requestId, details: { talent_id, requisition_id, stage: episode.status } },
      );
    }
  }

  // request → the PREPARE boundary (RTR-TEMPLATE-1 §11). Resolve the governed
  // template + bindings FIRST (fail closed before any persistence), then create
  // the RTR Document + associations + requirement, then render the pinned
  // template into a FROZEN revision. After this the document is ready to preview
  // and ready to send; status stays REQUESTED (DRAFT) until send.
  async request(input: RtrRequestInput): Promise<{ document_id: string }> {
    // Talent Lifecycle R1–R5 Impl Directive v1.2 §5.6 (A1 AM-1 §2.2) — an RTR request is new
    // contact THROUGH the requisition: refused on closed / canceled before any persistence.
    await assertRequisitionPermitsContactSend(this.requisitions, {
      tenant_id: input.tenant_id,
      requisition_id: input.requisition_id,
      requestId: input.requestId,
    });
    // Remediation Directive v1.0 R2 (DEF-7) — the Talent must be on the requisition, at Talent
    // responded or later, before any persistence.
    await this.assertRtrStage(input.tenant_id, input.talent_id, input.requisition_id, input.requestId);
    // 1. Resolve the tenant's ACTIVE RTR template and PIN its exact version.
    //    Throws RTR_TEMPLATE_NOT_CONFIGURED / _CONFIGURATION_INVALID — no fallback.
    const template = await this.resolver.resolveActive({
      tenant_id: input.tenant_id,
      requestId: input.requestId,
    });

    // 1b. Derive the CLIENT company from the requisition (the authority for client.name
    //     and the COMPANY/CLIENT association). A caller-supplied company_id that differs
    //     is refused — the preview (compose) and the frozen document must name the same
    //     client. Fails closed before any write.
    const company_id = await this.resolveRequestCompany(input);

    // 1c. A1 §2.4 — the version's FROZEN letterhead logo (rtr-html-v1 only): bytes read
    //     from the TemplateAsset's storage and sha-verified. The renderer never fetches.
    const letterhead =
      isHtmlContent(template.content) && template.content.logo
        ? await this.loadLetterhead(input.tenant_id, template.content.logo, input.requestId)
        : undefined;

    // 2. Resolve the closed binding catalog → a fully-resolved RenderModel pinned
    //    to the exact template version. Throws RTR_TEMPLATE_BINDING_MISSING /
    //    _CONFIGURATION_INVALID before any write; no raw {{token}} can be rendered.
    const model = await this.binding.bind({
      content: template.content,
      template_version_id: template.template_version_id,
      tenant_id: input.tenant_id,
      talent_id: input.talent_id,
      requisition_id: input.requisition_id,
      company_id,
      // §13 ruling — recruiter.display_name resolves to the SENDING recruiter.
      recruiter_user_id: input.created_by,
      requestId: input.requestId,
      ...(letterhead !== undefined ? { letterhead } : {}),
    });
    // bound_html is a compose-preview projection only — never part of the render model.
    const render = { ...model };
    delete render.bound_html;

    // 3. Create the RTR Document (+ the three RTR associations) and FREEZE the pinned-template
    //    revision — delegated to the shared governed-signing capability. template_version_id is
    //    carried through for durable provenance (INV-2): the exact frozen artifact preview shows
    //    and send transmits. RTR owns WHAT (type + associations + resolved model); the shared
    //    capability owns the create+freeze mechanics.
    const { document_id } = await this.signing.prepare({
      tenant_id: input.tenant_id,
      document_type_id: RIGHT_TO_REPRESENT_TYPE_ID,
      // PO ruling 3 — the admin's (bound) document title; fallback only when blank.
      title: rtrTitleOrFallback(model.title),
      execution_mode: 'SINGLE_SIGNATURE',
      source_kind: 'TEMPLATE_GENERATED',
      created_by: input.created_by,
      requestId: input.requestId,
      associations: [
        { resource_type: 'TALENT', resource_id: input.talent_id, relationship: 'SUBJECT' },
        { resource_type: 'REQUISITION', resource_id: input.requisition_id, relationship: 'REGARDING' },
        { resource_type: 'COMPANY', resource_id: company_id, relationship: 'CLIENT' },
      ],
      render,
      template_version_id: template.template_version_id,
      // R2 (DEF-8; RTR-1 §24) — a requested-but-unsent RTR is reused, never duplicated.
      reuse_live_draft: true,
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
    actor?: SignatureActor;
  }): Promise<RtrSendResult> {
    // v1.2 §5.6 — the pre-send CONTACT_SEND gate on the RTR's REGARDING requisition (T-4).
    const requisition_id = await this.assertRegardingRequisitionPermitsSend(input.tenant_id, input.document_id, input.requestId);
    // Remediation Directive v1.0 R2 (DEF-7) — the send is refused before Talent responded too.
    await this.assertRtrStage(input.tenant_id, input.talent_id, requisition_id, input.requestId);
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
    // PO ruling 3 — the envelope subject is the FROZEN Document.title (set at request
    // from the pinned version's title). Read, never re-resolved from today's template
    // (INV-3). An unreadable document falls back; signing.send then fails as before.
    const subject = await this.frozenTitle(input.tenant_id, input.document_id);
    return this.signing.send({
      tenant_id: input.tenant_id,
      document_id: input.document_id,
      subject,
      execution_mode: 'SINGLE_SIGNATURE',
      recipient: { email, name },
      created_by: input.created_by,
      requestId: input.requestId,
      ...(input.actor !== undefined ? { actor: input.actor } : {}),
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
    actor?: SignatureActor;
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
    // v1.2 §5.6 — a reminder is new contact through the requisition: gated like a send.
    await this.assertRegardingRequisitionPermitsSend(input.tenant_id, input.document_id, input.requestId);
    return this.signing.remind({ tenant_id: input.tenant_id, document_id: input.document_id, requestId: input.requestId, ...(input.actor !== undefined ? { actor: input.actor } : {}) });
  }

  // Talent Lifecycle R1–R5 Impl Directive v1.2 §5.6 — resolve the RTR's REGARDING requisition
  // (send / remind carry no requisition id) and apply the CONTACT_SEND gate. An RTR with no
  // requisition association in this tenant is refused (fail-closed, §2.6).
  private async assertRegardingRequisitionPermitsSend(tenant_id: string, document_id: string, requestId: string): Promise<string> {
    const requisition_id = await this.documents.findRegardingRequisitionId(tenant_id, document_id);
    if (requisition_id === null) {
      throw new AramoError(
        'REQUISITION_NOT_ADVANCEABLE',
        'This Right to Represent is not associated with a requisition in this tenant',
        409,
        { requestId, details: { document_id, status: null, activity: 'CONTACT_SEND' } },
      );
    }
    await assertRequisitionPermitsContactSend(this.requisitions, { tenant_id, requisition_id, requestId });
    return requisition_id;
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

  // SEAM 4 — READ-ONLY composition of the recruiter "Send RTR" panel BEFORE an RTR
  // Document exists (talent_responded / qualifying-not-sent, where current() is null
  // and the frozen-revision preview requires a document_id that does not yet exist).
  //
  // It resolves the tenant's ACTIVE RTR template (provenance name · v{n}) and produces
  // a REAL-BOUND preview by resolving the closed binding catalog for THIS (talent,
  // requisition, actor) and substituting into the active version's content. It REUSES
  // the exact send-path primitives (resolveActive + RtrTemplateBindingService.bind) and
  // performs ZERO writes: no Document, no revision, no artifact, no envelope — pure
  // reads + an in-memory render. Every precondition fails CLOSED on the SAME typed
  // codes the request/send path uses (RTR_TEMPLATE_NOT_CONFIGURED /
  // RTR_TEMPLATE_CONFIGURATION_INVALID / RTR_TEMPLATE_BINDING_MISSING) — it NEVER
  // fabricates a preview and NEVER emits a raw {{token}}.
  async composeForPair(input: {
    tenant_id: string;
    talent_id: string;
    requisition_id: string;
    actor_id: string;
    requestId: string;
  }): Promise<RtrComposeView> {
    // 1. Resolve the tenant's ACTIVE RTR template + pin its current version. Throws
    //    RTR_TEMPLATE_NOT_CONFIGURED when none is active, _CONFIGURATION_INVALID when
    //    the active template/version is unusable. No fallback (INV-12).
    const template = await this.resolver.resolveActive({
      tenant_id: input.tenant_id,
      requestId: input.requestId,
    });

    // 2. Derive the requisition's CLIENT company (the authoritative client.name source).
    //    Tenant-scoped read; null ⇒ empty, which fails closed in bind() IFF the active
    //    template actually references {{client.name}} (RTR_TEMPLATE_BINDING_MISSING).
    const company_id =
      (await this.requisitions.findCompanyId({ tenant_id: input.tenant_id, id: input.requisition_id })) ?? '';

    // 3. REAL-BIND the active version's content for THIS (talent, requisition, actor) and
    //    render in memory. Reuses the exact send-path binding/substitution; a missing
    //    required binding throws RTR_TEMPLATE_BINDING_MISSING (fail closed — no raw token,
    //    no empty substitution). NO persistence happens anywhere in this path.
    const model = await this.binding.bind({
      content: template.content,
      template_version_id: template.template_version_id,
      tenant_id: input.tenant_id,
      talent_id: input.talent_id,
      requisition_id: input.requisition_id,
      company_id,
      // §13 ruling — recruiter.display_name resolves to the acting recruiter.
      recruiter_user_id: input.actor_id,
      requestId: input.requestId,
    });

    return {
      template: { name: template.template_name, version_number: template.version_number },
      preview: {
        title: model.title,
        blocks: model.blocks.map((b) => ({ type: b.type, text: b.text })),
        ...(model.bound_html !== undefined ? { html: model.bound_html } : {}),
        signature_block: { printed_name: model.signature_block.printed_name },
      },
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

  // request() company authority — the requisition's CLIENT company. Null (unknown
  // requisition, or one with no client) fails closed; a supplied id that differs is a
  // mismatch. Both are 422 VALIDATION_ERROR with a typed details.reason.
  private async resolveRequestCompany(input: RtrRequestInput): Promise<string> {
    const derived = await this.requisitions.findCompanyId({ tenant_id: input.tenant_id, id: input.requisition_id });
    if (derived === null) {
      throw new AramoError('VALIDATION_ERROR', 'requisition has no client company; an RTR cannot be requested', 422, {
        requestId: input.requestId,
        details: { reason: 'requisition_company_unresolved', requisition_id: input.requisition_id },
      });
    }
    if (input.company_id !== undefined && input.company_id !== derived) {
      throw new AramoError('VALIDATION_ERROR', "company_id does not match the requisition's client company", 422, {
        requestId: input.requestId,
        details: { reason: 'company_requisition_mismatch', requisition_id: input.requisition_id },
      });
    }
    return derived;
  }

  private async loadLetterhead(tenant_id: string, logo: RtrHtmlLogoRef, requestId: string): Promise<LetterheadModel> {
    const invalid = (reason: string): AramoError =>
      new AramoError('RTR_TEMPLATE_CONFIGURATION_INVALID', 'The active Right to Represent template logo is not usable', 422, {
        requestId,
        details: { reason },
      });
    const asset = await this.templates.findAssetById(tenant_id, logo.asset_id);
    if (asset === null) throw invalid('logo_asset_missing');
    const bytes = await this.storage.getArtifact({ storage_key: asset.storage_locator, requestId, maxBytes: 1024 * 1024 });
    const sha = createHash('sha256').update(bytes).digest('hex');
    if (sha !== asset.sha256 || sha !== logo.sha256) throw invalid('logo_asset_hash_mismatch');
    return { image_bytes: new Uint8Array(bytes), image_format: logo.mime === 'image/png' ? 'PNG' : 'JPG', image_sha256: sha, name: null };
  }

  private async frozenTitle(tenant_id: string, document_id: string): Promise<string> {
    try {
      const doc = await this.documents.getDocument(tenant_id, document_id);
      return rtrTitleOrFallback(doc.title);
    } catch (e) {
      if (e instanceof DocumentNotFoundError) return RTR_FALLBACK_TITLE;
      throw e;
    }
  }

  // §15 current-selection precedence: a live (non-terminal) RTR wins; else the
  // most recent EXECUTED; else the most recent. `docs` is created_at desc.
  private selectCurrent<T extends { status: string }>(docs: readonly T[]): T {
    // R2 (DEF-12) — a declined / expired RTR ended without execution: never the live one.
    const live = docs.find((d) => d.status !== 'EXECUTED' && d.status !== 'VOIDED' && d.status !== 'DECLINED' && d.status !== 'EXPIRED');
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

// R2 (DEF-7) — the stages from which an RTR may be requested or sent (RTR-1 AC-21).
const RTR_ELIGIBLE_STAGES: ReadonlySet<string> = new Set(['talent_responded', 'qualifying', 'qualified']);

function rtrTitleOrFallback(title: string | null | undefined): string {
  const t = (title ?? '').trim();
  return t.length > 0 ? t : RTR_FALLBACK_TITLE;
}
