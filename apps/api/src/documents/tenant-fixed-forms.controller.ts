import { Controller, Get, HttpCode, HttpStatus, Inject, Optional, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, EntitlementRepository, RequireCapability } from '@aramo/entitlement';
import {
  FixedFormsRepository,
  TEMPLATE_AUDIT,
  TEMPLATE_PRODUCT_KEYS,
  templateErrorToHttp,
  type PublishedFixedForm,
  type TemplateAuditPort,
} from '@aramo/documents';

import { FixedFormService, fixedFormContentOf, toFieldView } from './fixed-form.service.js';

// TEMPLATE-PRODUCT-1 (Implementation Directive v1.0 LOCKED) §7.3 — the tenant side of Aramo
// fixed legal forms. A fixed form is NEVER adopted: every tenant entitled to one of the form's
// products sees it in Org Home "Our templates" as "Aramo form · read-only" (preview only, no
// edit, no copy), shown by default; a tenant that does not use one hides it.
//
//   GET  /v1/document-templates/library/fixed-forms             the published forms the tenant
//                                                               is entitled to, with `hidden`
//   GET  /v1/document-templates/library/fixed-forms/:id         one form: pages, roles, fields
//   GET  /v1/document-templates/library/fixed-forms/:id/pdf     the official PDF (base64 JSON)
//   POST /v1/document-templates/library/fixed-forms/:id/hide    Hide (document_template:manage)
//   POST /v1/document-templates/library/fixed-forms/:id/show    Show (document_template:manage)
//
// Same guards and capability as the template library (JwtAuthGuard + EntitlementGuard +
// RolesGuard, capability core; reads document_template:read). The paths sit under
// library/fixed-forms so they never meet DocumentTemplatesController's `:id` route. A form
// the tenant is not entitled to (or that is not published) reads as 404. Hide / Show is
// audited like the other tenant template governance (identity.document_template.
// fixed_form_hidden / _shown, after the change, non-swallowing).

export interface TenantFixedFormItem {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly document_type: { readonly id: string; readonly key: string; readonly name: string; readonly category: string | null };
  readonly products: readonly string[];
  readonly version_id: string;
  readonly version_number: number;
  readonly updated_at: string;
  readonly withdraw_effective_at: string | null;
  readonly page_count: number;
  readonly hidden: boolean;
}

function toItem(f: PublishedFixedForm, hidden: boolean): TenantFixedFormItem {
  const { content } = fixedFormContentOf(f.version.field_schema, f.template.name);
  return {
    id: f.template.id,
    name: f.template.name,
    description: f.template.description,
    document_type: { id: f.type.id, key: f.type.key, name: f.type.name, category: f.type.category },
    products: [...f.template.products],
    version_id: f.version.id,
    version_number: f.version.version_number,
    updated_at: (f.version.activated_at ?? f.template.updated_at).toISOString(),
    withdraw_effective_at: f.template.withdraw_effective_at?.toISOString() ?? null,
    page_count: content.pdf?.page_count ?? 0,
    hidden,
  };
}

@Controller('v1/document-templates')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('core')
export class TenantFixedFormsController {
  constructor(
    private readonly repo: FixedFormsRepository,
    private readonly forms: FixedFormService,
    private readonly entitlements: EntitlementRepository,
    // The template audit seam (@Global TemplateCapabilitiesModule). Hide / Show REFUSES
    // without it (governance is audited).
    @Optional() @Inject(TEMPLATE_AUDIT) private readonly audit?: TemplateAuditPort,
  ) {}

  @Get('library/fixed-forms')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('document_template:read')
  async list(@AuthContext() auth: AuthContextType): Promise<{ items: TenantFixedFormItem[] }> {
    const forms = await this.visibleForms(auth.tenant_id);
    const visibility = await this.repo.visibilityFor(auth.tenant_id);
    return { items: forms.map((f) => toItem(f, visibility.get(f.template.id) ?? false)) };
  }

  @Get('library/fixed-forms/:id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('document_template:read')
  async detail(@AuthContext() auth: AuthContextType, @Param('id', ParseUUIDPipe) id: string, @RequestId() requestId: string) {
    const f = await this.form(auth.tenant_id, id, requestId);
    const visibility = await this.repo.visibilityFor(auth.tenant_id);
    const { content } = fixedFormContentOf(f.version.field_schema, f.template.name);
    const variables = new Map((await this.forms.allowedVariables(f.type.id)).map((v) => [v.key, v]));
    const fields = (await this.repo.listFields(f.version.id)).map(toFieldView);
    return {
      ...toItem(f, visibility.get(f.template.id) ?? false),
      title: content.title,
      pages: content.pdf?.pages ?? [],
      signing: content.signing,
      fields,
      // The variables that prefill text fields (label for the read-only preview).
      variables: [...new Set(fields.map((x) => x.binding_key).filter((k): k is string => k !== null))].map((key) => ({
        key,
        label: variables.get(key)?.label ?? key,
      })),
    };
  }

  @Get('library/fixed-forms/:id/pdf')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('document_template:read')
  async pdf(@AuthContext() auth: AuthContextType, @Param('id', ParseUUIDPipe) id: string, @RequestId() requestId: string) {
    const f = await this.form(auth.tenant_id, id, requestId);
    const { content } = fixedFormContentOf(f.version.field_schema, f.template.name);
    if (content.pdf === null) throw new AramoError('TEMPLATE_NOT_FOUND', `template ${id} is not available`, 404, { requestId });
    try {
      const bytes = await this.forms.readPdf(content.pdf, requestId);
      return { sha256: content.pdf.sha256, byte_size: bytes.byteLength, content_base64: bytes.toString('base64') };
    } catch (e) {
      throw templateErrorToHttp(e, requestId);
    }
  }

  @Post('library/fixed-forms/:id/hide')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('document_template:manage')
  async hide(@AuthContext() auth: AuthContextType, @Param('id', ParseUUIDPipe) id: string, @RequestId() requestId: string) {
    return this.setHidden(auth, id, true, requestId);
  }

  @Post('library/fixed-forms/:id/show')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('document_template:manage')
  async show(@AuthContext() auth: AuthContextType, @Param('id', ParseUUIDPipe) id: string, @RequestId() requestId: string) {
    return this.setHidden(auth, id, false, requestId);
  }

  private async setHidden(auth: AuthContextType, id: string, hidden: boolean, requestId: string): Promise<TenantFixedFormItem> {
    const audit = this.audit;
    if (audit === undefined) {
      throw new AramoError('INTERNAL_ERROR', 'template audit is not available', 500, { requestId, details: { reason: 'audit_unavailable' } });
    }
    const f = await this.form(auth.tenant_id, id, requestId);
    await this.repo.setVisibility({ tenant_id: auth.tenant_id, template_id: f.template.id, hidden, updated_by: auth.sub });
    await audit.recordGovernance({
      action: hidden ? 'fixed_form_hidden' : 'fixed_form_shown',
      tenant_id: auth.tenant_id,
      actor_id: auth.sub,
      subject_id: f.template.id,
      payload: { document_type_id: f.template.document_type_id, version_id: f.version.id },
      requestId,
    });
    return toItem(f, hidden);
  }

  // The published forms tagged with a product the tenant is entitled to (§7.3).
  private async visibleForms(tenant_id: string, template_id?: string): Promise<PublishedFixedForm[]> {
    const entitled = await this.entitlements.getCapabilities(tenant_id);
    const products = TEMPLATE_PRODUCT_KEYS.filter((p) => entitled.has(p));
    if (products.length === 0) return [];
    return this.repo.listPublishedFixedForms({ now: new Date(), products, ...(template_id !== undefined ? { template_id } : {}) });
  }

  private async form(tenant_id: string, id: string, requestId: string): Promise<PublishedFixedForm> {
    const f = (await this.visibleForms(tenant_id, id))[0];
    if (f === undefined) throw new AramoError('TEMPLATE_NOT_FOUND', `template ${id} is not available`, 404, { requestId });
    return f;
  }
}
