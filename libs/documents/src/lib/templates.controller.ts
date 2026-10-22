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
  Patch,
  Post,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import { TemplatesRepository } from './templates.repository.js';
import { RequirementsRepository } from './requirements.repository.js';
import {
  TEMPLATE_CAPABILITIES,
  TEMPLATE_TENANT_LOGO,
  type TemplateCapabilitiesPort,
  type TemplateLogoRef,
  type TemplateTenantLogoPort,
} from './template-capabilities.port.js';
import { TEMPLATE_AUDIT, type TemplateAuditPort } from './template-audit.port.js';
import {
  DocumentNotFoundError,
  DocumentRequirementAlreadySatisfiedError,
  DocumentRequirementNotFoundError,
  TemplateBindingUnsupportedError,
  TemplateDraftAlreadyExistsError,
  TemplateImmutableError,
  TemplateNotFoundError,
  TemplatePlatformDefaultConflictError,
  TemplatePreviewRequiredError,
  TemplateVersionNotActiveError,
  TemplateVersionNotFoundError,
} from './domain/errors.js';

const TEMPLATE_KINDS = new Set(['GENERATED', 'UPLOADED_PDF', 'HYBRID']);
// DOC-TEMPLATE-LIB-1 T-6 [TD] — a withdrawal notice stays listed this long after its
// effective date, so the Org Home banner can still explain the change.
const WITHDRAWAL_NOTICE_GRACE_DAYS = 30;
const FIELD_TYPES = new Set([
  'TEXT',
  'MULTILINE_TEXT',
  'DATE',
  'NUMBER',
  'CURRENCY',
  'CHECKBOX',
  'IMAGE',
  'SIGNATURE',
  'INITIALS',
  'SIGN_DATE',
  'SIGNER_NAME',
  'SIGNER_EMAIL',
]);
const RESOURCE_TYPES = new Set([
  'TALENT',
  'REQUISITION',
  'COMPANY',
  'SUBMITTAL',
  'OFFER',
  'PLACEMENT',
  'PURCHASE_ORDER',
  'TENANT_ORGANIZATION',
  'CONTACT',
]);
const RELATIONSHIPS = new Set(['SUBJECT', 'REGARDING', 'CLIENT', 'SUPPORTS', 'OWNER', 'ISSUER', 'COUNTERPARTY']);

function toHttp(e: unknown, requestId: string): AramoError {
  if (e instanceof TemplateNotFoundError) return new AramoError('TEMPLATE_NOT_FOUND', e.message, 404, { requestId });
  if (e instanceof TemplateVersionNotFoundError) return new AramoError('TEMPLATE_VERSION_NOT_FOUND', e.message, 404, { requestId });
  if (e instanceof TemplateVersionNotActiveError) return new AramoError('TEMPLATE_VERSION_NOT_ACTIVE', e.message, 409, { requestId });
  if (e instanceof TemplateImmutableError) return new AramoError('TEMPLATE_IMMUTABLE', e.message, 409, { requestId });
  if (e instanceof TemplateDraftAlreadyExistsError) return new AramoError('TEMPLATE_DRAFT_ALREADY_EXISTS', e.message, 409, { requestId });
  if (e instanceof TemplatePreviewRequiredError) return new AramoError('TEMPLATE_PREVIEW_REQUIRED', e.message, 409, { requestId });
  if (e instanceof TemplateBindingUnsupportedError) return new AramoError('TEMPLATE_BINDING_UNSUPPORTED', e.message, 422, { requestId });
  if (e instanceof TemplatePlatformDefaultConflictError) {
    return new AramoError('TEMPLATE_PLATFORM_DEFAULT_CONFLICT', e.message, 409, {
      requestId,
      details: { template_id: e.templateId, reason: e.reason, ...e.details },
    });
  }
  if (e instanceof DocumentRequirementNotFoundError) return new AramoError('DOCUMENT_REQUIREMENT_NOT_FOUND', e.message, 404, { requestId });
  if (e instanceof DocumentRequirementAlreadySatisfiedError) return new AramoError('DOCUMENT_REQUIREMENT_ALREADY_SATISFIED', e.message, 409, { requestId });
  if (e instanceof DocumentNotFoundError) return new AramoError('DOCUMENT_NOT_FOUND', e.message, 404, { requestId });
  return e instanceof AramoError
    ? e
    : new AramoError('INTERNAL_ERROR', e instanceof Error ? e.message : String(e), 500, { requestId });
}

// DOC-TEMPLATE-LIB-1 T-2 — the same domain→HTTP mapping for the platform-tier template
// routes (apps/api), so both surfaces return identical error codes.
export const templateErrorToHttp = toHttp;

function validate(condition: boolean, message: string, requestId: string): void {
  if (!condition) throw new AramoError('VALIDATION_ERROR', message, 400, { requestId });
}

interface CreateTemplateBody {
  document_type_id: string;
  name: string;
  description?: string;
  template_kind: string;
  client_id?: string;
}

// ORG-UX-1 (Directive v1.0 LOCKED §5.1) — adopt an Aramo (PLATFORM) default from the
// gallery as an independent tenant draft.
interface AdoptTemplateBody {
  library_template_id: string;
}

// Document Templates slice 1 (PO ruling 2) — rename a template (DocumentTemplate.name).
interface RenameTemplateBody {
  name: string;
}
const TEMPLATE_NAME_MAX_LENGTH = 120;

interface CreateVersionBody {
  render_schema_version: string;
  field_schema?: unknown;
  binding_schema?: unknown;
  source_artifact_id?: string;
}

// DOC-TEMPLATE-ADMIN-RTR-1 (§9) — DRAFT content update. Only the editable content is
// accepted; version_number/status/tenant_id/template_id/created_by/activated_*/retired_*
// are NOT accepted here (immutable fields are enforced by the repo, not this DTO).
interface UpdateVersionBody {
  field_schema?: unknown;
  render_schema_version?: string;
  // Slice 1 B1 — admin-only notes (string|null; trimmed; ≤500; never rendered).
  internal_notes?: string | null;
}
const INTERNAL_NOTES_MAX_LENGTH = 500;

interface AddFieldBody {
  field_key: string;
  field_type: string;
  binding_key?: string;
  required?: boolean;
  page_number?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  format_rule?: string;
  signer_role?: string;
  ordinal: number;
}

@Controller('v1/document-templates')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('core')
export class DocumentTemplatesController {
  constructor(
    private readonly repo: TemplatesRepository,
    // DOC-TEMPLATE-ADMIN-RTR-1 — document-type content capability (catalog + validation +
    // sample preview). Provided globally by apps/api (RTR impl); @Optional so the generic
    // CRUD still works where no capability is wired.
    @Optional() @Inject(TEMPLATE_CAPABILITIES) private readonly caps?: TemplateCapabilitiesPort,
    // Amendment A1 §1 — the template audit seam (bound in apps/api). @Optional so generic
    // CRUD works without it, but Discard draft REFUSES when it is absent (audit is a MUST).
    @Optional() @Inject(TEMPLATE_AUDIT) private readonly audit?: TemplateAuditPort,
    // A1 §2.4 — tenant-profile logo capture/read (bound in apps/api).
    @Optional() @Inject(TEMPLATE_TENANT_LOGO) private readonly tenantLogo?: TemplateTenantLogoPort,
  ) {}

  // ORG-UX-1 §5.4 — Org template governance audit (adopt / create / approve). Written
  // after the change; the seam is non-swallowing, so a failed write is an error, never
  // silent. Absent only where no audit seam is wired (generic CRUD outside apps/api).
  private async governance(
    auth: AuthContextType,
    action: 'adopted' | 'created' | 'version_activated',
    subject_id: string,
    payload: Record<string, string | number | null>,
    requestId: string,
  ): Promise<void> {
    if (this.audit === undefined) return;
    await this.audit.recordGovernance({ action, tenant_id: auth.tenant_id, actor_id: auth.sub, subject_id, payload, requestId });
  }

  // A1 / editor v2 — the version read view: the stored row + `logo` ({asset_id, mime} of
  // the frozen letterhead asset, or null). The content (incl. html) is field_schema.
  private versionView<V extends { field_schema: unknown }>(v: V): V & { logo: { asset_id: string; mime: string } | null } {
    const ref = this.caps?.logoOf(v.field_schema) ?? null;
    return { ...v, logo: ref === null ? null : { asset_id: ref.asset_id, mime: ref.mime } };
  }

  // Load the document type for a version (version -> template -> document_type_id).
  private async documentTypeForVersion(tenant_id: string, versionId: string): Promise<{ document_type_id: string; field_schema: unknown; render_schema_version: string }> {
    const v = await this.repo.getVersion(tenant_id, versionId);
    const t = await this.repo.getTemplate(tenant_id, v.template_id);
    return { document_type_id: t.document_type_id, field_schema: v.field_schema, render_schema_version: v.render_schema_version };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('document_template:author')
  async create(@AuthContext() auth: AuthContextType, @Body() body: CreateTemplateBody, @RequestId() requestId: string) {
    validate(typeof body?.document_type_id === 'string', 'document_type_id is required', requestId);
    validate(typeof body?.name === 'string' && body.name.length > 0, 'name is required', requestId);
    validate(TEMPLATE_KINDS.has(body.template_kind), 'invalid template_kind', requestId);
    let created: Awaited<ReturnType<TemplatesRepository['createTemplate']>>;
    try {
      created = await this.repo.createTemplate({ tenant_id: auth.tenant_id, created_by: auth.sub, ...body });
    } catch (e) {
      throw toHttp(e, requestId);
    }
    await this.governance(auth, 'created', created.id, { document_type_id: created.document_type_id }, requestId);
    return created;
  }

  // ORG-UX-1 (Directive v1.0 LOCKED §5.1, Lead Correction B) — ADOPT: Aramo gallery →
  // an independent TENANT-owned template + DRAFT v1 (a full copy of the default's current
  // content), authored by document_template:author and approved later by
  // document_template:manage. Nothing is usable until approved. adopted_from_* is
  // provenance only. A non-adoptable default (not published, withdrawn) → 409
  // TEMPLATE_SELECTION_INVALID; unknown → 404.
  @Post('adopt')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('document_template:author')
  async adopt(@AuthContext() auth: AuthContextType, @Body() body: AdoptTemplateBody, @RequestId() requestId: string) {
    validate(typeof body?.library_template_id === 'string' && body.library_template_id.length > 0, 'library_template_id is required', requestId);
    let adopted: Awaited<ReturnType<TemplatesRepository['adoptPlatformTemplate']>>;
    try {
      const source = await this.repo.findTemplateByIdOwnerAware(auth.tenant_id, body.library_template_id);
      if (source === null || source.owner_scope !== 'PLATFORM') throw new TemplateNotFoundError(body.library_template_id);
      const caps = this.caps;
      const transform =
        caps !== undefined && caps.isConfigurable(source.document_type_id)
          ? (c: { render_schema_version: string; field_schema: unknown }) => caps.draftContentFrom({ document_type_id: source.document_type_id, ...c })
          : undefined;
      adopted = await this.repo.adoptPlatformTemplate({
        tenant_id: auth.tenant_id,
        library_template_id: body.library_template_id,
        created_by: auth.sub,
        ...(transform !== undefined ? { transform } : {}),
      });
    } catch (e) {
      throw toHttp(e, requestId);
    }
    await this.governance(
      auth,
      'adopted',
      adopted.template.id,
      {
        document_type_id: adopted.template.document_type_id,
        adopted_from_template_id: adopted.template.adopted_from_template_id,
        adopted_from_version_id: adopted.template.adopted_from_version_id,
      },
      requestId,
    );
    return { template: adopted.template, version: this.versionView(adopted.version) };
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('document_template:read')
  async list(@AuthContext() auth: AuthContextType) {
    return this.repo.listTemplates(auth.tenant_id);
  }

  // DOC-TEMPLATE-LIB-1 T-6 (§9; ADR-0034 D10) — the Aramo default withdrawal notices
  // that affect THIS tenant (a selection names the default, or the tenant falls back to
  // it): pending ones and ones that took effect within the last 30 days [TD grace]. Feeds
  // the Org Home banner (T-4). Product tags are informational — no filtering (D9).
  // Declared before ':id' so the literal segment wins.
  @Get('notices')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('document_template:read')
  async notices(@AuthContext() auth: AuthContextType) {
    const rows = await this.repo.listWithdrawalNoticesForTenant({
      tenant_id: auth.tenant_id,
      grace_days: WITHDRAWAL_NOTICE_GRACE_DAYS,
    });
    return {
      notices: rows.map((r) => ({
        template_id: r.template_id,
        name: r.name,
        document_type_id: r.document_type_id,
        products: r.products,
        withdraw_notice_at: r.withdraw_notice_at.toISOString(),
        withdraw_effective_at: r.withdraw_effective_at.toISOString(),
        status: r.in_effect ? 'IN_EFFECT' : 'PENDING',
        selected_for_client_ids: r.selected_for_client_ids,
        relies_on_default: r.relies_on_default,
        has_own_template: r.has_own_template,
      })),
    };
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('document_template:read')
  async get(@AuthContext() auth: AuthContextType, @Param('id') id: string, @RequestId() requestId: string) {
    try {
      return await this.repo.getTemplate(auth.tenant_id, id);
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  // Document Templates slice 1 (PO ruling 2) — save the template name on the TEMPLATE.
  // Body { name } trimmed, 1..120 chars. Tenant-scoped (unknown/cross-tenant → 404
  // TEMPLATE_NOT_FOUND). Returns the same template view GET :id returns.
  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('document_template:author')
  async rename(
    @AuthContext() auth: AuthContextType,
    @Param('id') id: string,
    @Body() body: RenameTemplateBody,
    @RequestId() requestId: string,
  ) {
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    validate(name.length > 0, 'name is required', requestId);
    validate(name.length <= TEMPLATE_NAME_MAX_LENGTH, `name must be at most ${TEMPLATE_NAME_MAX_LENGTH} characters`, requestId);
    try {
      return await this.repo.renameTemplate({ tenant_id: auth.tenant_id, id, name });
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  @Post(':id/versions')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('document_template:author')
  async createVersion(
    @AuthContext() auth: AuthContextType,
    @Param('id') templateId: string,
    @Body() body: CreateVersionBody,
    @RequestId() requestId: string,
  ) {
    validate(typeof body?.render_schema_version === 'string' && body.render_schema_version.length > 0, 'render_schema_version is required', requestId);
    try {
      return await this.repo.createVersion({
        tenant_id: auth.tenant_id,
        template_id: templateId,
        render_schema_version: body.render_schema_version,
        field_schema: body.field_schema,
        binding_schema: body.binding_schema,
        source_artifact_id: body.source_artifact_id,
        created_by: auth.sub,
      });
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  // DOC-TEMPLATE-ADMIN-RTR-1 (§8) — open a new editable DRAFT (vN+1) by COPYING the
  // template's current ACTIVE content as the starting point (the backend owns the copy).
  // One-DRAFT guarded (§41): if a DRAFT is already open, 409 TEMPLATE_DRAFT_ALREADY_EXISTS.
  @Post(':id/draft')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('document_template:author')
  async createDraft(@AuthContext() auth: AuthContextType, @Param('id') templateId: string, @RequestId() requestId: string) {
    try {
      const t = await this.repo.getTemplate(auth.tenant_id, templateId);
      const caps = this.caps;
      const transform =
        caps !== undefined && caps.isConfigurable(t.document_type_id)
          ? (c: { render_schema_version: string; field_schema: unknown }) => caps.draftContentFrom({ document_type_id: t.document_type_id, ...c })
          : undefined;
      return this.versionView(
        await this.repo.createDraftFromActive({ tenant_id: auth.tenant_id, template_id: templateId, created_by: auth.sub, ...(transform !== undefined ? { transform } : {}) }),
      );
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  @Get(':id/versions')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('document_template:read')
  async listVersions(@AuthContext() auth: AuthContextType, @Param('id') templateId: string, @RequestId() requestId: string) {
    try {
      return (await this.repo.listVersions(auth.tenant_id, templateId)).map((v) => this.versionView(v));
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  // DOC-TEMPLATE-ADMIN-RTR-1 (§36) — single version-detail read (content + provenance +
  // the preview-gate markers), the admin editor's load. Tenant-scoped; read scope.
  @Get('versions/:versionId')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('document_template:read')
  async getVersion(@AuthContext() auth: AuthContextType, @Param('versionId') versionId: string, @RequestId() requestId: string) {
    try {
      return this.versionView(await this.repo.getVersion(auth.tenant_id, versionId));
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  // DOC-TEMPLATE-ADMIN-RTR-1 (§9) — update a DRAFT version's editable content. DRAFT-only
  // (ACTIVE/RETIRED -> TEMPLATE_IMMUTABLE); editing re-arms the §18 preview gate. Binding-
  // catalog validation (§14) is enforced authoritatively at activation (the RTR validator
  // port, T2); this route owns the generic content write.
  @Patch('versions/:versionId')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('document_template:author')
  async updateVersion(
    @AuthContext() auth: AuthContextType,
    @Param('versionId') versionId: string,
    @Body() body: UpdateVersionBody,
    @RequestId() requestId: string,
  ) {
    const hasContent = body !== null && body !== undefined && 'field_schema' in body;
    const hasNotes = body !== null && body !== undefined && 'internal_notes' in body;
    validate(hasContent || hasNotes, 'field_schema or internal_notes is required', requestId);
    let internal_notes: string | null | undefined;
    if (hasNotes) {
      const raw = body.internal_notes;
      validate(raw === null || typeof raw === 'string', 'internal_notes must be a string or null', requestId);
      const trimmed = raw === null || raw === undefined ? '' : raw.trim();
      validate(trimmed.length <= INTERNAL_NOTES_MAX_LENGTH, `internal_notes must be at most ${INTERNAL_NOTES_MAX_LENGTH} characters`, requestId);
      internal_notes = trimmed.length === 0 ? null : trimmed;
    }
    try {
      let field_schema: unknown = hasContent ? body.field_schema : undefined;
      // A1 §2.2 — authoritative server-side sanitisation of sanitised content versions
      // (rtr-html-v1): the stored + returned html is the allowlist re-serialisation.
      if (hasContent && this.caps !== undefined) {
        const existing = await this.repo.getVersion(auth.tenant_id, versionId);
        if (existing.status !== 'DRAFT') throw new TemplateImmutableError(versionId);
        const t = await this.repo.getTemplate(auth.tenant_id, existing.template_id);
        if (this.caps.isConfigurable(t.document_type_id)) {
          field_schema = await this.caps.normalizeDraftContent({
            document_type_id: t.document_type_id,
            render_schema_version: body.render_schema_version ?? existing.render_schema_version,
            field_schema: body.field_schema,
            existing_field_schema: existing.field_schema,
            requestId,
          });
        }
      }
      return this.versionView(
        await this.repo.updateDraftVersion({
          tenant_id: auth.tenant_id,
          version_id: versionId,
          ...(hasContent ? { field_schema } : {}),
          render_schema_version: body.render_schema_version,
          ...(internal_notes !== undefined ? { internal_notes } : {}),
        }),
      );
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  // Document Templates slice 1 (B) / Amendment A1 §1 — discard the open DRAFT version
  // (204). DRAFT-only (ACTIVE/RETIRED → 409 TEMPLATE_IMMUTABLE); tenant-scoped (404
  // otherwise). The template's current_version_id / ACTIVE version are unchanged.
  // A1 §1: the template audit event (actor, version, time) is written FIRST and must
  // succeed — no audit, no discard. (A concurrent activation between the audit write and
  // the status-guarded delete is refused 409; the audit row then records a discard
  // request that did not complete — the only non-atomic edge of a cross-schema write.)
  @Delete('versions/:versionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireScopes('document_template:author')
  async deleteDraft(@AuthContext() auth: AuthContextType, @Param('versionId') versionId: string, @RequestId() requestId: string): Promise<void> {
    try {
      const v = await this.repo.getVersion(auth.tenant_id, versionId);
      if (v.status !== 'DRAFT') throw new TemplateImmutableError(versionId);
      if (this.audit === undefined) {
        throw new AramoError('INTERNAL_ERROR', 'template audit is not configured; draft discard refused', 500, { requestId });
      }
      await this.audit.recordDraftDiscarded({
        tenant_id: auth.tenant_id,
        actor_id: auth.sub,
        template_id: v.template_id,
        version_id: v.id,
        version_number: v.version_number,
        requestId,
      });
      await this.repo.deleteDraftVersion({ tenant_id: auth.tenant_id, version_id: versionId });
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  // DOC-TEMPLATE-ADMIN-RTR-1 (§17) — fixed-sample preview of the CURRENT draft content
  // (validates + substitutes safe sample values; creates NO business Document/envelope).
  // Recording the preview arms the §18 activation gate for exactly this content.
  @Post('versions/:versionId/preview')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('document_template:author')
  async previewVersion(@AuthContext() auth: AuthContextType, @Param('versionId') versionId: string, @RequestId() requestId: string) {
    try {
      const ctx = await this.documentTypeForVersion(auth.tenant_id, versionId);
      validate(this.caps !== undefined && this.caps.isConfigurable(ctx.document_type_id), 'this document type is not configurable', requestId);
      const preview = await this.caps!.renderSamplePreview({ ...ctx, requestId });
      await this.repo.recordPreview({ tenant_id: auth.tenant_id, version_id: versionId });
      return preview;
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  // DOC-TEMPLATE-ADMIN-RTR-1 (§15) — the governed Insert-field catalog for a template's
  // document type (the single source the editor's Insert menu is generated from; §14).
  @Get(':id/allowed-bindings')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('document_template:read')
  async allowedBindings(@AuthContext() auth: AuthContextType, @Param('id') templateId: string, @RequestId() requestId: string) {
    try {
      const t = await this.repo.getTemplate(auth.tenant_id, templateId);
      const configurable = this.caps?.isConfigurable(t.document_type_id) === true;
      // A1 §2.4 — whether the Tenant profile has a logo the editor can add (+ the name the
      // letterhead shows beside it).
      const tenant_logo =
        configurable && this.tenantLogo !== undefined ? await this.tenantLogo.info(auth.tenant_id) : { available: false, tenant_name: null };
      return { bindings: (await this.caps?.listAllowedBindings(t.document_type_id)) ?? [], tenant_logo };
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  // A1 §2.4 — capture the Tenant profile logo for a DRAFT: fetched ONCE here (https,
  // 5 s, 1 MB, PNG/JPEG magic bytes), frozen as a TemplateAsset (bytes in documents object
  // storage; sha256 + locator on the asset row), referenced from the version content and
  // placed as the first content node. Editing content re-arms the preview gate.
  @Post('versions/:versionId/logo')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('document_template:author')
  async captureLogo(@AuthContext() auth: AuthContextType, @Param('versionId') versionId: string, @RequestId() requestId: string) {
    try {
      const { v, caps } = await this.logoContext(auth.tenant_id, versionId, requestId);
      if (this.tenantLogo === undefined) {
        throw new AramoError('INTERNAL_ERROR', 'tenant logo capture is not configured', 500, { requestId });
      }
      const captured = await this.tenantLogo.capture({ tenant_id: auth.tenant_id, requestId });
      const asset = await this.repo.createAsset({
        tenant_id: auth.tenant_id,
        asset_kind: 'LOGO',
        sha256: captured.sha256,
        mime_type: captured.mime,
        storage_provider: captured.storage_provider,
        storage_locator: captured.storage_locator,
        name: 'tenant.logo',
        created_by: auth.sub,
      });
      const ref: TemplateLogoRef = { asset_id: asset.id, sha256: captured.sha256, mime: captured.mime };
      await this.repo.updateDraftVersion({ tenant_id: auth.tenant_id, version_id: versionId, field_schema: caps.withLogo(v.field_schema, ref, requestId) });
      return { asset_id: asset.id, sha256: captured.sha256, mime: captured.mime };
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  // A1 §2.4 — remove the logo from a DRAFT (the reference AND the logo node). The asset
  // row is kept (an ACTIVE/RETIRED version may still reference it). 204.
  @Delete('versions/:versionId/logo')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireScopes('document_template:author')
  async removeLogo(@AuthContext() auth: AuthContextType, @Param('versionId') versionId: string, @RequestId() requestId: string): Promise<void> {
    try {
      const { v, caps } = await this.logoContext(auth.tenant_id, versionId, requestId);
      await this.repo.updateDraftVersion({ tenant_id: auth.tenant_id, version_id: versionId, field_schema: caps.withLogo(v.field_schema, null, requestId) });
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  // A1 §2.4 — the frozen logo bytes of a version (any status) for the editor letterhead.
  @Get('versions/:versionId/logo/content')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('document_template:read')
  async logoContent(@AuthContext() auth: AuthContextType, @Param('versionId') versionId: string, @RequestId() requestId: string): Promise<StreamableFile> {
    try {
      const v = await this.repo.getVersion(auth.tenant_id, versionId);
      const ref = this.caps?.logoOf(v.field_schema) ?? null;
      const asset = ref === null ? null : await this.repo.findAssetById(auth.tenant_id, ref.asset_id);
      if (ref === null || asset === null || this.tenantLogo === undefined) {
        throw new AramoError('TEMPLATE_VERSION_NOT_FOUND', 'this version has no logo', 404, { requestId, details: { reason: 'no_logo' } });
      }
      const bytes = await this.tenantLogo.read({ storage_locator: asset.storage_locator, requestId });
      return new StreamableFile(bytes, { type: asset.mime_type, length: bytes.byteLength });
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  private async logoContext(tenant_id: string, versionId: string, requestId: string) {
    const v = await this.repo.getVersion(tenant_id, versionId);
    if (v.status !== 'DRAFT') throw new TemplateImmutableError(versionId);
    const t = await this.repo.getTemplate(tenant_id, v.template_id);
    const caps = this.caps;
    if (caps === undefined || !caps.isConfigurable(t.document_type_id)) {
      throw new AramoError('VALIDATION_ERROR', 'this document type does not support a logo', 400, { requestId });
    }
    return { v, caps };
  }

  @Post('versions/:versionId/activate')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('document_template:manage')
  async activate(@AuthContext() auth: AuthContextType, @Param('versionId') versionId: string, @RequestId() requestId: string) {
    try {
      // §14/§19 — closed-binding + non-empty content validation (authoritative; backend,
      // not FE). A non-configurable type is a no-op. Then the repo enforces the §18 preview
      // gate + §21 actor + the DRAFT->ACTIVE transition.
      if (this.caps !== undefined) {
        const ctx = await this.documentTypeForVersion(auth.tenant_id, versionId);
        await this.caps.validateDraftContent({ ...ctx, requestId });
      }
      const activated = await this.repo.activateVersion({ tenant_id: auth.tenant_id, version_id: versionId, actor_id: auth.sub });
      await this.governance(
        auth,
        'version_activated',
        versionId,
        { template_id: activated.template_id, version_number: activated.version_number },
        requestId,
      );
      return activated;
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  @Post('versions/:versionId/fields')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('document_template:author')
  async addField(
    @AuthContext() auth: AuthContextType,
    @Param('versionId') versionId: string,
    @Body() body: AddFieldBody,
    @RequestId() requestId: string,
  ) {
    validate(typeof body?.field_key === 'string' && body.field_key.length > 0, 'field_key is required', requestId);
    validate(FIELD_TYPES.has(body.field_type), 'invalid field_type', requestId);
    validate(typeof body?.ordinal === 'number', 'ordinal is required', requestId);
    try {
      return await this.repo.addField({ tenant_id: auth.tenant_id, template_version_id: versionId, ...body });
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  @Get('versions/:versionId/fields')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('document_template:read')
  async listFields(@AuthContext() auth: AuthContextType, @Param('versionId') versionId: string, @RequestId() requestId: string) {
    try {
      return await this.repo.listFields(auth.tenant_id, versionId);
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }
}

interface CreateRequirementBody {
  document_type_id: string;
  resource_type: string;
  resource_id: string;
  relationship?: string;
}

@Controller('v1/document-requirements')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('core')
export class DocumentRequirementsController {
  constructor(private readonly repo: RequirementsRepository) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('document_requirement:manage')
  async create(@AuthContext() auth: AuthContextType, @Body() body: CreateRequirementBody, @RequestId() requestId: string) {
    validate(typeof body?.document_type_id === 'string', 'document_type_id is required', requestId);
    validate(RESOURCE_TYPES.has(body?.resource_type), `invalid resource_type ${body?.resource_type}`, requestId);
    validate(typeof body?.resource_id === 'string', 'resource_id is required', requestId);
    if (body.relationship !== undefined) {
      validate(RELATIONSHIPS.has(body.relationship), `invalid relationship ${body.relationship}`, requestId);
    }
    try {
      return await this.repo.createRequirement({ tenant_id: auth.tenant_id, created_by: auth.sub, ...body });
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('document_requirement:read')
  async list(
    @AuthContext() auth: AuthContextType,
    @Query('resource_type') resourceType?: string,
    @Query('resource_id') resourceId?: string,
  ) {
    return this.repo.listRequirements(auth.tenant_id, { resource_type: resourceType, resource_id: resourceId });
  }

  @Get(':id/check')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('document_requirement:read')
  async check(@AuthContext() auth: AuthContextType, @Param('id') id: string, @RequestId() requestId: string) {
    try {
      return await this.repo.checkRequirement(auth.tenant_id, id);
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  @Post(':id/satisfy')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('document_requirement:manage')
  async satisfy(
    @AuthContext() auth: AuthContextType,
    @Param('id') id: string,
    @Body() body: { document_id: string },
    @RequestId() requestId: string,
  ) {
    validate(typeof body?.document_id === 'string', 'document_id is required', requestId);
    try {
      return await this.repo.satisfyRequirement({ tenant_id: auth.tenant_id, id, document_id: body.document_id, actor_id: auth.sub });
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  @Post(':id/waive')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('document_requirement:manage')
  async waive(
    @AuthContext() auth: AuthContextType,
    @Param('id') id: string,
    @Body() body: { reason: string },
    @RequestId() requestId: string,
  ) {
    validate(typeof body?.reason === 'string' && body.reason.length > 0, 'reason is required', requestId);
    try {
      return await this.repo.waiveRequirement({ tenant_id: auth.tenant_id, id, reason: body.reason, actor_id: auth.sub });
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }
}

interface CreatePacketBody {
  packet_type: string;
  title: string;
}

interface AddPacketItemBody {
  document_id: string;
  sequence: number;
  required?: boolean;
}

@Controller('v1/document-packets')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('core')
export class DocumentPacketsController {
  constructor(private readonly repo: TemplatesRepository) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('document:create')
  async create(@AuthContext() auth: AuthContextType, @Body() body: CreatePacketBody, @RequestId() requestId: string) {
    validate(typeof body?.packet_type === 'string' && body.packet_type.length > 0, 'packet_type is required', requestId);
    validate(typeof body?.title === 'string' && body.title.length > 0, 'title is required', requestId);
    return this.repo.createPacket({ tenant_id: auth.tenant_id, created_by: auth.sub, ...body });
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('document:read')
  async list(@AuthContext() auth: AuthContextType) {
    return this.repo.listPackets(auth.tenant_id);
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('document:read')
  async get(@AuthContext() auth: AuthContextType, @Param('id') id: string, @RequestId() requestId: string) {
    try {
      return await this.repo.getPacket(auth.tenant_id, id);
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  @Post(':id/items')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('document:create')
  async addItem(
    @AuthContext() auth: AuthContextType,
    @Param('id') packetId: string,
    @Body() body: AddPacketItemBody,
    @RequestId() requestId: string,
  ) {
    validate(typeof body?.document_id === 'string', 'document_id is required', requestId);
    validate(typeof body?.sequence === 'number', 'sequence is required', requestId);
    try {
      return await this.repo.addPacketItem({
        tenant_id: auth.tenant_id,
        packet_id: packetId,
        document_id: body.document_id,
        sequence: body.sequence,
        required: body.required,
      });
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }
}
