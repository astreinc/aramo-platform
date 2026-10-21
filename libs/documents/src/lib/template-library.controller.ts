import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Optional,
  Param,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import { TemplatesRepository } from './templates.repository.js';
import {
  TEMPLATE_CAPABILITIES,
  TEMPLATE_TENANT_BRANDING,
  type TemplateCapabilitiesPort,
  type TemplateTenantBrandingPort,
} from './template-capabilities.port.js';
import { TemplateNotFoundError, TemplateSelectionInvalidError } from './domain/errors.js';
import { templateErrorToHttp } from './templates.controller.js';

// DOC-TEMPLATE-LIB-1 T-4 — Implementation Directive v1.0 (LOCKED) §8.2 (ADR-0034 D3, D4,
// D5, D6, D8, D11): the tenant template-library reads + the explicit selection, for the
// Org Home "Document templates" section. Same `v1/document-templates` family and the same
// guards as DocumentTemplatesController (JwtAuthGuard + EntitlementGuard + RolesGuard,
// capability `core`, document_template:read / :manage).
//
//   GET    library                — the gallery: the tenant's own templates ∪ the Aramo
//                                   (PLATFORM) defaults the tenant can resolve now (ACTIVE,
//                                   current version, withdrawal not yet effective). Only
//                                   the CURRENT version of a default is shown (D3).
//   GET    library/:id/preview    — an Aramo default's current version rendered with the
//                                   tenant's branding (organization.* values from the
//                                   tenant profile) and fixed samples for every other
//                                   variable. Read-only: records no preview, writes nothing.
//   GET    selections             — the tenant's active choices.
//   PUT    selections             — set the active choice for (type, optional client) to an
//                                   Aramo default or one of the tenant's own templates.
//   DELETE selections             — clear it: the type reverts to the Aramo default.
//
// "Create your own document template" (D5) is the existing POST /v1/document-templates
// (a TENANT template, written from scratch): there is NO copy-from-default route and no
// provenance field. Every write here is TENANT-scoped (TenantTemplateSelection rows of
// the caller's tenant); no tenant route can write a PLATFORM row.
//
// Registered BEFORE DocumentTemplatesController in DocumentsModule so the static paths
// (`library`, `selections`) win over its `:id` route.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validate(condition: boolean, message: string, requestId: string): void {
  if (!condition) throw new AramoError('VALIDATION_ERROR', message, 400, { requestId });
}

function toHttp(e: unknown, requestId: string): AramoError {
  if (e instanceof TemplateSelectionInvalidError) {
    return new AramoError('VALIDATION_ERROR', e.message, 422, { requestId, details: { reason: e.reason } });
  }
  return templateErrorToHttp(e, requestId);
}

interface SetSelectionBody {
  document_type_id: string;
  client_id?: string | null;
  template_id: string;
}

export interface TemplateLibraryItem {
  readonly id: string;
  readonly owner_scope: 'PLATFORM' | 'TENANT';
  readonly document_type_id: string;
  readonly name: string;
  readonly description: string | null;
  readonly template_kind: string;
  readonly status: string;
  readonly client_id: string | null;
  readonly current_version_id: string | null;
  readonly current_version_number: number | null;
  // "Updated {date}": the current version's activation, else the template's last change.
  readonly updated_at: string;
  readonly products: readonly string[] | null;
  readonly withdraw_effective_at: string | null;
  readonly configurable: boolean;
}

@Controller('v1/document-templates')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('core')
export class DocumentTemplateLibraryController {
  constructor(
    private readonly repo: TemplatesRepository,
    @Optional() @Inject(TEMPLATE_CAPABILITIES) private readonly caps?: TemplateCapabilitiesPort,
    @Optional() @Inject(TEMPLATE_TENANT_BRANDING) private readonly branding?: TemplateTenantBrandingPort,
  ) {}

  @Get('library')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('document_template:read')
  async library(@AuthContext() auth: AuthContextType) {
    const now = new Date();
    const rows = (await this.repo.listTemplatesForTenantIncludingPlatform(auth.tenant_id)).filter((t) =>
      t.owner_scope === 'PLATFORM'
        ? t.tenant_id === null &&
          t.status === 'ACTIVE' &&
          t.current_version_id !== null &&
          (t.withdraw_effective_at === null || t.withdraw_effective_at > now)
        : t.tenant_id === auth.tenant_id,
    );
    const versions = await this.repo.listVersionSummariesOwnerAware(
      auth.tenant_id,
      rows.map((t) => t.current_version_id).filter((id): id is string => id !== null),
    );
    const byId = new Map(versions.map((v) => [v.id, v]));
    const items: TemplateLibraryItem[] = rows.map((t) => {
      const v = t.current_version_id !== null ? byId.get(t.current_version_id) : undefined;
      const platform = t.owner_scope === 'PLATFORM';
      return {
        id: t.id,
        owner_scope: platform ? 'PLATFORM' : 'TENANT',
        document_type_id: t.document_type_id,
        name: t.name,
        description: t.description,
        template_kind: t.template_kind,
        status: t.status,
        client_id: t.client_id,
        current_version_id: t.current_version_id,
        current_version_number: v?.version_number ?? null,
        updated_at: (v?.activated_at ?? t.updated_at).toISOString(),
        products: platform ? t.products : null,
        withdraw_effective_at: platform && t.withdraw_effective_at !== null ? t.withdraw_effective_at.toISOString() : null,
        configurable: this.caps?.isConfigurable(t.document_type_id) === true,
      };
    });
    const document_types = (await this.repo.listSystemDocumentTypes()).map((d) => ({
      id: d.id,
      key: d.key,
      name: d.name,
      configurable: this.caps?.isConfigurable(d.id) === true,
    }));
    return { items, document_types };
  }

  @Get('library/:id/preview')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('document_template:read')
  async previewDefault(@AuthContext() auth: AuthContextType, @Param('id') id: string, @RequestId() requestId: string) {
    try {
      validate(UUID_RE.test(id), 'id must be a uuid', requestId);
      const t = await this.repo.findTemplateByIdOwnerAware(auth.tenant_id, id);
      const now = new Date();
      if (
        t === null ||
        t.owner_scope !== 'PLATFORM' ||
        t.status !== 'ACTIVE' ||
        t.current_version_id === null ||
        (t.withdraw_effective_at !== null && t.withdraw_effective_at <= now)
      ) {
        throw new TemplateNotFoundError(id);
      }
      const caps = this.caps;
      validate(caps !== undefined && caps.isConfigurable(t.document_type_id), 'this document type is not configurable', requestId);
      const v = await this.repo.getPlatformVersion(t.current_version_id);
      const brand = this.branding !== undefined
        ? await this.branding.forTenant(auth.tenant_id)
        : { organization_name: null, logo_available: false, values: {} };
      const preview = await caps!.renderSamplePreview({
        document_type_id: t.document_type_id,
        field_schema: v.field_schema,
        render_schema_version: v.render_schema_version,
        requestId,
        sample_overrides: brand.values,
      });
      return {
        ...preview,
        template_id: t.id,
        version_id: v.id,
        version_number: v.version_number,
        updated_at: (v.activated_at ?? t.updated_at).toISOString(),
        // The tenant letterhead the generated document carries (D8): the organisation name
        // and whether the tenant profile has a logo (captured when the document is generated).
        letterhead: { organization_name: brand.organization_name, logo_available: brand.logo_available },
      };
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  @Get('selections')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('document_template:read')
  async listSelections(@AuthContext() auth: AuthContextType) {
    return { items: await this.repo.listSelections(auth.tenant_id) };
  }

  @Put('selections')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('document_template:manage')
  async setSelection(@AuthContext() auth: AuthContextType, @Body() body: SetSelectionBody, @RequestId() requestId: string) {
    validate(typeof body?.document_type_id === 'string' && UUID_RE.test(body.document_type_id), 'document_type_id must be a uuid', requestId);
    validate(typeof body?.template_id === 'string' && UUID_RE.test(body.template_id), 'template_id must be a uuid', requestId);
    const client_id = body.client_id ?? null;
    validate(client_id === null || (typeof client_id === 'string' && UUID_RE.test(client_id)), 'client_id must be a uuid or null', requestId);
    try {
      return await this.repo.upsertSelection({
        tenant_id: auth.tenant_id,
        document_type_id: body.document_type_id,
        client_id,
        template_id: body.template_id,
        selected_by: auth.sub,
      });
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  @Delete('selections')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireScopes('document_template:manage')
  async clearSelection(
    @AuthContext() auth: AuthContextType,
    @Query('document_type_id') documentTypeId: string | undefined,
    @Query('client_id') clientId: string | undefined,
    @RequestId() requestId: string,
  ): Promise<void> {
    validate(typeof documentTypeId === 'string' && UUID_RE.test(documentTypeId), 'document_type_id must be a uuid', requestId);
    const client_id = clientId === undefined || clientId === '' ? null : clientId;
    validate(client_id === null || UUID_RE.test(client_id), 'client_id must be a uuid', requestId);
    await this.repo.deleteSelection(auth.tenant_id, documentTypeId as string, client_id);
  }
}
