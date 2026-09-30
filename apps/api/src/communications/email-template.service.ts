import { Inject, Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import {
  EmailTemplateRepository,
  type EmailTemplateRow,
  renderTemplate,
  TemplateValidationError,
  validateTemplateTokens,
} from '@aramo/communications';

import {
  REQUISITION_CONTACT_TEMPLATE_RESOLVER,
  type RequisitionContactContext,
  type RequisitionContactTemplateResolver,
} from './requisition-contact-template.port.js';

// D-EMAIL-TPL-1 (ET-4) — tenant email-template management (Settings surface).
// D-1 Option C is preserved structurally: the code-owned system default is NEVER
// a mutable row — it surfaces read-only (id=null, is_system_default=true) and can
// only be OVERRIDDEN by creating a tenant row. create/update/deactivate operate
// exclusively on tenant rows (a real UUID id, tenant-scoped in the repository), so
// no API path can edit the code default. Merge content is validated against the
// closed allowlist on every write and preview — an unknown token is rejected 422.

const V1_CATEGORY = 'requisition_initial_contact';
const V1_KEY = 'requisition-contact';
const CATEGORY_TO_KEY: Record<string, string> = { requisition_initial_contact: V1_KEY };

// Server-owned SAMPLE values for preview + the system-default view. These are
// EXAMPLE values, never browser-supplied business truth — preview renders the
// template content the admin is editing against this fixed context.
const SAMPLE_PREVIEW_VALUES: Readonly<Record<string, string>> = {
  'talent.first_name': 'Jordan',
  'requisition.title': 'Senior Registered Nurse',
  'requisition.reference': 'REQ-1042',
  'requisition.location': 'McLean, VA',
  'requisition.engagement_type': 'Contract',
  'requisition.work_arrangement': 'Hybrid',
  'recruiter.display_name': 'Alex Recruiter',
  'company.name': 'Astre Consulting Services',
  'role.summary_excerpt': 'A day-shift critical-care assignment at a partner health system.',
};

const SAMPLE_REQ_CONTEXT: RequisitionContactContext = {
  talent_first_name: 'Jordan',
  requisition_title: 'Senior Registered Nurse',
  requisition_reference: 'REQ-1042',
  location: 'McLean, VA',
  location_short: 'McLean, VA',
  work_arrangement: 'hybrid',
  engagement_type: 'contract',
  role_summary_source: 'A day-shift critical-care assignment at a partner health system.',
  recruiter_display_name: 'Alex Recruiter',
  tenant_recruiting_company_name: 'Astre Consulting Services',
};

export interface EmailTemplateView {
  readonly id: string | null; // null = code-owned system default (read-only)
  readonly template_key: string;
  readonly category: string;
  readonly name: string;
  readonly subject_template: string;
  readonly body_template: string;
  readonly is_system_default: boolean;
  readonly is_active: boolean;
  readonly updated_at: string | null;
}

export interface EmailTemplatePreview {
  readonly subject: string;
  readonly body: string;
  readonly warnings: readonly string[];
}

function toView(row: EmailTemplateRow): EmailTemplateView {
  return {
    id: row.id,
    template_key: row.template_key,
    category: row.category,
    name: row.name,
    subject_template: row.subject_template,
    body_template: row.body_template,
    is_system_default: false,
    is_active: row.is_active,
    updated_at: row.updated_at.toISOString(),
  };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}

@Injectable()
export class EmailTemplateService {
  constructor(
    private readonly repo: EmailTemplateRepository,
    @Inject(REQUISITION_CONTACT_TEMPLATE_RESOLVER)
    private readonly systemDefault: RequisitionContactTemplateResolver,
  ) {}

  private notFound(requestId: string): AramoError {
    // Tenant-safe: unknown id AND another tenant's id collapse to the same 404.
    return new AramoError('EMAIL_TEMPLATE_NOT_FOUND', 'email template not found', 404, { requestId });
  }

  private validateContent(subject: string, body: string, requestId: string): void {
    try {
      validateTemplateTokens(subject);
      validateTemplateTokens(body);
    } catch (e) {
      if (e instanceof TemplateValidationError) {
        throw new AramoError(
          'EMAIL_TEMPLATE_INVALID_MERGE_TOKEN',
          'template contains merge token(s) outside the allowed set',
          422,
          { requestId, details: { unknown_tokens: e.unknownTokens } },
        );
      }
      throw e;
    }
  }

  /** The read-only, code-owned system default rendered against the sample context. */
  private systemDefaultView(): EmailTemplateView {
    const hydrated = this.systemDefault.resolveDefault(SAMPLE_REQ_CONTEXT);
    return {
      id: null,
      template_key: V1_KEY,
      category: V1_CATEGORY,
      name: 'System default — requisition contact',
      subject_template: hydrated.subject,
      body_template: hydrated.body,
      is_system_default: true,
      is_active: true,
      updated_at: null,
    };
  }

  /** Effective templates: the tenant override for a key when present, else the
   *  read-only system default. */
  async list(tenant_id: string): Promise<EmailTemplateView[]> {
    const overrides = await this.repo.listByTenant(tenant_id);
    const activeByKey = new Map(overrides.filter((o) => o.is_active).map((o) => [o.template_key, o]));
    const views: EmailTemplateView[] = [];
    const v1Override = activeByKey.get(V1_KEY);
    views.push(v1Override ? toView(v1Override) : this.systemDefaultView());
    // Any additional override rows (deactivated, or other keys) surface too.
    for (const o of overrides) {
      if (o.template_key === V1_KEY && o.is_active) continue; // already the effective row
      views.push(toView(o));
    }
    return views;
  }

  async get(tenant_id: string, id: string, requestId: string): Promise<EmailTemplateView> {
    const row = await this.repo.findByIdForTenant(tenant_id, id);
    if (row === null) throw this.notFound(requestId);
    return toView(row);
  }

  async create(
    tenant_id: string,
    actor_id: string,
    dto: { category: string; name: string; subject_template: string; body_template: string },
    requestId: string,
  ): Promise<EmailTemplateView> {
    this.validateContent(dto.subject_template, dto.body_template, requestId);
    const template_key = CATEGORY_TO_KEY[dto.category] ?? dto.category;
    try {
      const row = await this.repo.create({
        tenant_id,
        template_key,
        category: dto.category as never,
        name: dto.name,
        subject_template: dto.subject_template,
        body_template: dto.body_template,
        created_by_id: actor_id,
      });
      return toView(row);
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new AramoError(
          'EMAIL_TEMPLATE_ALREADY_EXISTS',
          'a template override for this category already exists',
          409,
          { requestId },
        );
      }
      throw e;
    }
  }

  async update(
    tenant_id: string,
    actor_id: string,
    id: string,
    dto: { name?: string; subject_template?: string; body_template?: string },
    requestId: string,
  ): Promise<EmailTemplateView> {
    const current = await this.repo.findByIdForTenant(tenant_id, id);
    if (current === null) throw this.notFound(requestId);
    // Validate the RESULTING content (unchanged fields keep the stored value).
    this.validateContent(
      dto.subject_template ?? current.subject_template,
      dto.body_template ?? current.body_template,
      requestId,
    );
    const row = await this.repo.update(tenant_id, id, { ...dto, updated_by_id: actor_id });
    if (row === null) throw this.notFound(requestId);
    return toView(row);
  }

  async deactivate(tenant_id: string, actor_id: string, id: string, requestId: string): Promise<void> {
    const ok = await this.repo.deactivate(tenant_id, id, actor_id);
    if (!ok) throw this.notFound(requestId);
  }

  /** Server-side preview: validate the (browser-edited) TEMPLATE content, then
   *  render against the server-owned SAMPLE context. No client business values. */
  async preview(
    dto: { subject_template: string; body_template: string },
    requestId: string,
  ): Promise<EmailTemplatePreview> {
    this.validateContent(dto.subject_template, dto.body_template, requestId);
    const subject = renderTemplate(dto.subject_template, SAMPLE_PREVIEW_VALUES);
    const body = renderTemplate(dto.body_template, SAMPLE_PREVIEW_VALUES);
    return {
      subject: subject.text,
      body: body.text,
      warnings: [...new Set([...subject.warnings, ...body.warnings])],
    };
  }
}
