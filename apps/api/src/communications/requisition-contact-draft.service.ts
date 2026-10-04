import { Inject, Injectable } from '@nestjs/common';
import { renderTemplate } from '@aramo/communications';
import { IdentityRepository } from '@aramo/identity';
import { PipelineRepository } from '@aramo/pipeline';
import { RequisitionRepository } from '@aramo/requisition';
import { TalentRecordRepository } from '@aramo/talent-record';

import {
  EMAIL_RECIPIENT_RESOLVER,
  type EmailRecipientResolver,
} from '../microsoft/email-recipient-resolver.port.js';

import { RequisitionContactContextError } from './requisition-contact-context.error.js';
import {
  REQUISITION_CONTACT_TEMPLATE_RESOLVER,
  type RequisitionContactContext,
  type RequisitionContactTemplateResolver,
} from './requisition-contact-template.port.js';
import { EmailTemplateResolverService } from './email-template-resolver.service.js';
import { buildRequisitionContactTemplateValues } from './system-requisition-contact-template.service.js';

// The logical template key for the requisition-contact draft. Resolution is
// server-authoritative — tenant override (if ACTIVE) else the code-owned default.
// COMM-EMAIL-TEMPLATE-GOVERNANCE-1: there is NO client template choice; the
// recruiter cannot bypass an active tenant override at compose time.
const REQUISITION_CONTACT_KEY = 'requisition-contact';

// COMM-C4 (RCE-1) — prepares a requisition-contact email draft. AUTHORITATIVE:
// the browser supplies only ids; every business fact is reloaded server-side.
// Writes NOTHING (no persistence, no Graph, no pipeline mutation). Fails closed
// on an invalid Talent↔Requisition context and reuses the C recipient resolver
// so the recipient authority model is identical to the send path.

export interface PrepareRequisitionContactDraftArgs {
  readonly tenant_id: string;
  readonly recruiter_id: string;
  readonly talent_record_id: string;
  readonly requisition_id: string;
  readonly pipeline_id?: string;
}

export interface RequisitionContactDraftView {
  readonly to: { readonly email: string; readonly display_name: string | null; readonly editable: false };
  readonly subject: string;
  readonly body: string;
  readonly context: {
    readonly requisition_reference: string;
    readonly requisition_title: string;
    readonly template_id: string;
    readonly template_version: string;
    readonly template_key: string;
  };
  readonly warnings?: readonly string[];
}

function composeLocation(city: string | null, state: string | null): string | null {
  const parts = [city, state].map((p) => (p ?? '').trim()).filter((p) => p.length > 0);
  return parts.length === 0 ? null : parts.join(', ');
}

@Injectable()
export class RequisitionContactDraftService {
  constructor(
    @Inject(EMAIL_RECIPIENT_RESOLVER) private readonly recipients: EmailRecipientResolver,
    private readonly talents: TalentRecordRepository,
    private readonly requisitions: RequisitionRepository,
    private readonly pipelines: PipelineRepository,
    private readonly identity: IdentityRepository,
    @Inject(REQUISITION_CONTACT_TEMPLATE_RESOLVER)
    private readonly template: RequisitionContactTemplateResolver,
    // ET-5 — D-1 Option C source decision (tenant override else code default).
    private readonly templateResolver: EmailTemplateResolverService,
  ) {}

  async prepareDraft(args: PrepareRequisitionContactDraftArgs): Promise<RequisitionContactDraftView> {
    // 1. Requisition must exist within the tenant (also rejects cross-tenant).
    const req = await this.requisitions.findByIdAdmin({ tenant_id: args.tenant_id, id: args.requisition_id });
    if (req === null) {
      throw new RequisitionContactContextError('requisition_not_found');
    }
    // 2. Talent↔Requisition association: a pipeline links them in this tenant.
    //    Scoping visible_requisition_ids to the single requisition makes this a
    //    tenant-safe existence check; a cross-tenant Talent has no such pipeline.
    const stages = await this.pipelines.findCurrentStageForTalentIds({
      tenant_id: args.tenant_id,
      talent_record_ids: [args.talent_record_id],
      visible_requisition_ids: new Set([args.requisition_id]),
    });
    if (!stages.has(args.talent_record_id)) {
      throw new RequisitionContactContextError('talent_not_associated_with_requisition');
    }
    // 3. Authoritative recipient — the SAME resolver introduced in C. Throws
    //    TalentEmailUnavailableError (→ recipient-unavailable) when absent.
    const email = await this.recipients.resolveRecipientEmail({
      tenant_id: args.tenant_id,
      talent_record_id: args.talent_record_id,
    });
    // 4. Talent name (salutation + recipient display).
    const talent = await this.talents.findById({ tenant_id: args.tenant_id, id: args.talent_record_id });
    const firstName = talent?.first_name ?? null;
    const displayName = talent === null ? null : `${talent.first_name} ${talent.last_name}`.trim() || null;
    // 5. Recruiter + tenant display identities.
    const user = await this.identity.findUserById(args.recruiter_id);
    const tenant = await this.identity.findTenantNameById(args.tenant_id);
    // 6. Build the AUTHORITATIVE requisition-contact context (server-reloaded).
    const reference = `REQ-${req.requisition_number}`;
    const ctx: RequisitionContactContext = {
      talent_first_name: firstName,
      requisition_title: req.title,
      requisition_reference: reference,
      location: composeLocation(req.city, req.state),
      location_short: composeLocation(req.city, req.state),
      work_arrangement: req.work_arrangement,
      engagement_type: req.job_type,
      role_summary_source: req.description,
      recruiter_display_name: user?.display_name ?? null,
      tenant_recruiting_company_name: tenant === null ? null : tenant.display_name ?? tenant.name,
    };
    // 6b. Resolve + render the governed template: tenant override else code
    //     default — server-authoritative, no client template choice.
    const rendered = await this.resolveRenderedDraft(args.tenant_id, ctx);

    // 7. Draft view — recipient is server-owned and display-only (INV-3).
    return {
      to: { email, display_name: displayName, editable: false },
      subject: rendered.subject,
      body: rendered.body,
      context: {
        requisition_reference: reference,
        requisition_title: req.title,
        template_id: rendered.template_id,
        template_version: rendered.template_version,
        template_key: REQUISITION_CONTACT_KEY,
      },
      ...(rendered.warnings.length > 0 ? { warnings: rendered.warnings } : {}),
    };
  }

  // Governed resolution (COMM-EMAIL-TEMPLATE-GOVERNANCE-1): ALWAYS tenant
  // override (if ACTIVE) else the code-owned default — server-authoritative, with
  // NO client template choice. The override's content was validated at save
  // (ET-4) and the renderer fails closed on any stray token, so no `{{…}}` can
  // reach the draft; resolveSource scopes strictly by tenant_id (ET-2).
  private async resolveRenderedDraft(
    tenant_id: string,
    ctx: RequisitionContactContext,
  ): Promise<{
    subject: string;
    body: string;
    template_id: string;
    template_version: string;
    warnings: readonly string[];
  }> {
    const src = await this.templateResolver.resolveSource(tenant_id, REQUISITION_CONTACT_KEY);
    if (src.source === 'tenant_override') {
      const values = buildRequisitionContactTemplateValues(ctx);
      const subj = renderTemplate(src.subject_template, values);
      const body = renderTemplate(src.body_template, values);
      return {
        subject: subj.text,
        body: body.text,
        template_id: src.template_id,
        template_version: '1',
        warnings: [...new Set([...subj.warnings, ...body.warnings])],
      };
    }
    const d = this.template.resolveDefault(ctx);
    return { subject: d.subject, body: d.body, template_id: d.template_id, template_version: d.template_version, warnings: d.warnings };
  }
}
