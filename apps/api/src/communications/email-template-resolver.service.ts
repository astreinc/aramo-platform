import { Injectable } from '@nestjs/common';
import { EmailTemplateRepository } from '@aramo/communications';

// D-EMAIL-TPL-1 (ET-2) — D-1 Option C precedence. A tenant's ACTIVE override row
// for a template_key wins; absent one, the caller uses the code-owned system
// default (REQUISITION_CONTACT_TEMPLATE_RESOLVER). This service owns ONLY the
// source DECISION + tenant scoping — rendering (closed merge fields) is ET-3's
// renderer, wired at the draft boundary (ET-5). A cross-tenant override row is
// NEVER visible (the repository scopes every read by tenant_id), so it can never
// shadow another tenant's default.

export type ResolvedTemplateSource =
  | {
      readonly source: 'tenant_override';
      readonly template_id: string; // EmailTemplate row id — D-5 provenance
      readonly template_key: string;
      readonly subject_template: string;
      readonly body_template: string;
    }
  | { readonly source: 'system_default'; readonly template_key: string };

@Injectable()
export class EmailTemplateResolverService {
  constructor(private readonly templates: EmailTemplateRepository) {}

  /** Which template SOURCE applies for (tenant, key): tenant override, else system default. */
  async resolveSource(tenant_id: string, template_key: string): Promise<ResolvedTemplateSource> {
    const row = await this.templates.findActiveByKey(tenant_id, template_key);
    if (row === null) {
      return { source: 'system_default', template_key };
    }
    return {
      source: 'tenant_override',
      template_id: row.id,
      template_key: row.template_key,
      subject_template: row.subject_template,
      body_template: row.body_template,
    };
  }
}
