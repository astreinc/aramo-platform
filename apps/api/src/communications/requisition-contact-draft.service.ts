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

// D-EMAIL-TPL-1 (ET-5) — the ONLY valid template_key for this draft is the
// requisition-contact logical key. Any other key fails closed.
const REQUISITION_CONTACT_KEY = 'requisition-contact';

// ET-5 — thrown when the client supplies a template_key that is not valid for the
// requisition-contact draft. The controller maps it to 404 EMAIL_TEMPLATE_NOT_FOUND
// (requestId is added there — the same pattern as RequisitionContactContextError).
export class EmailTemplateKeyNotFoundError extends Error {
  constructor() {
    super('no such email template for requisition contact');
    this.name = 'EmailTemplateKeyNotFoundError';
  }
}

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
  // ET-5 — optional; the ONLY new client input. Absent → code default (behaviour
  // unchanged). The recipient/context are never client-supplied.
  readonly template_key?: string;
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
    // 6b. Resolve + render the effective template (D-1). template_key is the ONLY
    //     new client input; the context + recipient above are server-authoritative.
    const rendered = await this.resolveRenderedDraft(args.tenant_id, args.template_key, ctx);

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

  // ET-5 — effective-template resolution + render, preserving D-1 semantics:
  //   absent                 → code default (behaviour unchanged);
  //   requisition-contact key → tenant override (rendered via the ET-3 closed
  //                            renderer against authoritative context) if one
  //                            exists, else the code default;
  //   any other key          → fail closed (404).
  // A tenant override's content was validated at save (ET-4) and the renderer
  // fails closed on any stray token, so no `{{…}}` can reach the draft. Cross-tenant
  // keys are invisible — resolveSource scopes strictly by tenant_id (ET-2).
  private async resolveRenderedDraft(
    tenant_id: string,
    template_key: string | undefined,
    ctx: RequisitionContactContext,
  ): Promise<{
    subject: string;
    body: string;
    template_id: string;
    template_version: string;
    warnings: readonly string[];
  }> {
    if (template_key === undefined) {
      const d = this.template.resolveDefault(ctx);
      return { subject: d.subject, body: d.body, template_id: d.template_id, template_version: d.template_version, warnings: d.warnings };
    }
    if (template_key !== REQUISITION_CONTACT_KEY) {
      throw new EmailTemplateKeyNotFoundError();
    }
    const src = await this.templateResolver.resolveSource(tenant_id, template_key);
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
