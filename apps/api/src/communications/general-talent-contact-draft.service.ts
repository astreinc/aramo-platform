import { Inject, Injectable } from '@nestjs/common';
import { renderTemplate } from '@aramo/communications';
import { IdentityRepository } from '@aramo/identity';
import { TalentRecordRepository } from '@aramo/talent-record';

import {
  EMAIL_RECIPIENT_RESOLVER,
  type EmailRecipientResolver,
} from '../microsoft/email-recipient-resolver.port.js';

import { TalentContactContextError } from './talent-contact-context.error.js';
import {
  GENERAL_TALENT_CONTACT_TEMPLATE_RESOLVER,
  type GeneralTalentContactContext,
  type GeneralTalentContactTemplateResolver,
} from './general-talent-contact-template.port.js';
import { EmailTemplateResolverService } from './email-template-resolver.service.js';
import { buildGeneralTalentContactTemplateValues } from './system-general-talent-contact-template.service.js';

// COMM-RECRUITER-W1 (W1-A2) — prepares a REVIEWABLE General Talent Contact email
// draft. Talent-only (NO requisition, NO pipeline). AUTHORITATIVE: the browser
// supplies only the talent id; recipient + display context are reloaded
// server-side. Writes NOTHING. Resolution is governed: the tenant's ACTIVE
// override for `talent-general-contact` else the code-owned default — NO client
// template choice. Reuses the C recipient resolver so recipient authority is
// identical to the send path.
const GENERAL_CONTACT_KEY = 'talent-general-contact';

export interface PrepareGeneralTalentContactDraftArgs {
  readonly tenant_id: string;
  readonly recruiter_id: string;
  readonly talent_record_id: string;
}

export interface GeneralTalentContactDraftView {
  readonly to: { readonly email: string; readonly display_name: string | null; readonly editable: false };
  readonly subject: string;
  readonly body: string;
  readonly context: {
    readonly template_id: string;
    readonly template_version: string;
    readonly template_key: string;
  };
  readonly warnings?: readonly string[];
}

@Injectable()
export class GeneralTalentContactDraftService {
  constructor(
    @Inject(EMAIL_RECIPIENT_RESOLVER) private readonly recipients: EmailRecipientResolver,
    private readonly talents: TalentRecordRepository,
    private readonly identity: IdentityRepository,
    @Inject(GENERAL_TALENT_CONTACT_TEMPLATE_RESOLVER)
    private readonly template: GeneralTalentContactTemplateResolver,
    private readonly templateResolver: EmailTemplateResolverService,
  ) {}

  async prepareDraft(args: PrepareGeneralTalentContactDraftArgs): Promise<GeneralTalentContactDraftView> {
    // 1. Talent must exist within the tenant (also rejects cross-tenant). No
    //    requisition, no pipeline — this is Talent-only contact.
    const talent = await this.talents.findById({ tenant_id: args.tenant_id, id: args.talent_record_id });
    if (talent === null) {
      throw new TalentContactContextError('talent_not_found');
    }
    // 2. Authoritative recipient — the SAME resolver as the send path. Throws
    //    TalentEmailUnavailableError (→ recipient-unavailable) when absent.
    const email = await this.recipients.resolveRecipientEmail({
      tenant_id: args.tenant_id,
      talent_record_id: args.talent_record_id,
    });
    const firstName = talent.first_name ?? null;
    const displayName = `${talent.first_name} ${talent.last_name}`.trim() || null;
    // 3. Recruiter + tenant display identities.
    const user = await this.identity.findUserById(args.recruiter_id);
    const tenant = await this.identity.findTenantNameById(args.tenant_id);
    // 4. The closed, requisition-free context (§4B-cat: exactly three bindings).
    const ctx: GeneralTalentContactContext = {
      talent_first_name: firstName,
      recruiter_display_name: user?.display_name ?? null,
      tenant_recruiting_company_name: tenant === null ? null : tenant.display_name ?? tenant.name,
    };
    const rendered = await this.resolveRenderedDraft(args.tenant_id, ctx);
    return {
      to: { email, display_name: displayName, editable: false },
      subject: rendered.subject,
      body: rendered.body,
      context: {
        template_id: rendered.template_id,
        template_version: rendered.template_version,
        template_key: GENERAL_CONTACT_KEY,
      },
      ...(rendered.warnings.length > 0 ? { warnings: rendered.warnings } : {}),
    };
  }

  // Governed resolution: tenant override (if ACTIVE) else code default —
  // server-authoritative, NO client template choice. The override's content was
  // validated at save against the General Talent Contact category allowlist (§4B-cat),
  // so no requisition token and no stray `{{…}}` can reach the draft.
  private async resolveRenderedDraft(
    tenant_id: string,
    ctx: GeneralTalentContactContext,
  ): Promise<{
    subject: string;
    body: string;
    template_id: string;
    template_version: string;
    warnings: readonly string[];
  }> {
    const src = await this.templateResolver.resolveSource(tenant_id, GENERAL_CONTACT_KEY);
    if (src.source === 'tenant_override') {
      const values = buildGeneralTalentContactTemplateValues(ctx);
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
    return {
      subject: d.subject,
      body: d.body,
      template_id: d.template_id,
      template_version: d.template_version,
      warnings: d.warnings,
    };
  }
}
