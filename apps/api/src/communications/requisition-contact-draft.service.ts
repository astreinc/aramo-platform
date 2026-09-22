import { Inject, Injectable } from '@nestjs/common';
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
  type RequisitionContactTemplateResolver,
} from './requisition-contact-template.port.js';

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
    // 6. Deterministic hydration of the governed template.
    const reference = `REQ-${req.requisition_number}`;
    const draft = this.template.resolveDefault({
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
    });
    // 7. Draft view — recipient is server-owned and display-only (INV-3).
    return {
      to: { email, display_name: displayName, editable: false },
      subject: draft.subject,
      body: draft.body,
      context: {
        requisition_reference: reference,
        requisition_title: req.title,
        template_id: draft.template_id,
        template_version: draft.template_version,
      },
      ...(draft.warnings.length > 0 ? { warnings: draft.warnings } : {}),
    };
  }
}
