import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Optional,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import {
  TEMPLATE_CAPABILITIES,
  TEMPLATE_VARIABLE_DATA_TYPES,
  TemplateVariableKeyConflictError,
  TemplateVariableNotFoundError,
  TemplateVariablesRepository,
  TemplatesRepository,
  templateErrorToHttp,
  type TemplateCapabilitiesPort,
  type TemplateVariableDataType,
  type TemplateVariableRow,
  type UpdateTemplateVariableInput,
} from '@aramo/documents';

// DOC-TEMPLATE-LIB-1 T-2 (§6.1, §8.1; ADR-0034 D2/D3/D7/D9, §4 rule 2) — the PLATFORM-tier
// authoring surface for Aramo default document templates + the Aramo template variable
// catalog. Served under /platform (nginx routes /platform/document-templates and
// /platform/template-variables to api:3000; everything else under /platform stays with
// platform-admin).
//
// AuthZ posture copies SkillGovernanceController (AUTHZ-2): class-level
// @UseGuards(JwtAuthGuard, RolesGuard); per-route @RequireScopes('platform:document_
// template:*'); per-route consumer_type === 'platform' assertion (the DDR §13.1 tripwire
// app-side — a tenant token never satisfies a platform route). Reads → :read;
// writes → :manage. These are the ONLY routes that write PLATFORM template rows or the
// variable catalog: the tenant routes (/v1/document-templates) are tenant_id-scoped and
// cannot match a PLATFORM row (tenant_id NULL).
//
// THIN boundary: shape validation + tier/scope assertion, then the SAME repository
// primitives the tenant admin flow uses (DRAFT one-per-template, §18 preview gate via
// content_fingerprint, publish = activate which retires the prior ACTIVE version) and
// the SAME TEMPLATE_CAPABILITIES port (catalog-driven closed-binding validation,
// fixed-sample preview, html sanitisation). Withdrawal is T-6; selection/resolution T-3.

const TEMPLATE_KINDS = new Set(['GENERATED', 'UPLOADED_PDF', 'HYBRID']);
const NAME_MAX = 120;
const DESCRIPTION_MAX = 500;
const INTERNAL_NOTES_MAX = 500;
// Product tag shape (D9 — recorded, not enforced in this increment), e.g. ATS, SIGN.
const PRODUCT_TAG = /^[A-Z][A-Z0-9_]{0,31}$/;
const PRODUCTS_MAX = 16;
// Catalog key = the token stored in template content: dotted lower-snake segments
// (e.g. talent.full_name). Immutable once created.
const VARIABLE_KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const VARIABLE_KEY_MAX = 64;
const LABEL_MAX = 80;
const SAMPLE_MAX = 2000;

export interface PlatformTemplateVersionSummary {
  id: string;
  version_number: number;
  status: string;
  activated_at: Date | null;
}

export interface PlatformTemplateView {
  id: string;
  owner_scope: string;
  document_type_id: string;
  name: string;
  description: string | null;
  template_kind: string;
  status: string;
  products: string[];
  current_version: PlatformTemplateVersionSummary | null;
  draft_version_id: string | null;
  withdraw_notice_at: Date | null;
  withdraw_effective_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface TemplateRow {
  id: string;
  owner_scope: string;
  document_type_id: string;
  name: string;
  description: string | null;
  template_kind: string;
  status: string;
  products: string[] | null;
  current_version_id: string | null;
  withdraw_notice_at: Date | null;
  withdraw_effective_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function toTemplateView(
  t: TemplateRow,
  versions: ReadonlyArray<{ id: string; version_number: number; status: string; activated_at: Date | null }>,
): PlatformTemplateView {
  const current = t.current_version_id === null ? undefined : versions.find((v) => v.id === t.current_version_id);
  const draft = versions.find((v) => v.status === 'DRAFT');
  return {
    id: t.id,
    owner_scope: t.owner_scope,
    document_type_id: t.document_type_id,
    name: t.name,
    description: t.description,
    template_kind: t.template_kind,
    status: t.status,
    products: t.products ?? [],
    current_version:
      current === undefined
        ? null
        : { id: current.id, version_number: current.version_number, status: current.status, activated_at: current.activated_at },
    draft_version_id: draft?.id ?? null,
    withdraw_notice_at: t.withdraw_notice_at,
    withdraw_effective_at: t.withdraw_effective_at,
    created_at: t.created_at,
    updated_at: t.updated_at,
  };
}

export interface TemplateVariableView {
  id: string;
  key: string;
  label: string;
  group_label: string;
  data_type: string;
  products: string[];
  ats_binding_key: string | null;
  sample_value: string | null;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

function toVariableView(r: TemplateVariableRow): TemplateVariableView {
  return {
    id: r.id,
    key: r.key,
    label: r.label,
    group_label: r.group_label,
    data_type: r.data_type,
    products: [...r.products],
    ats_binding_key: r.ats_binding_key,
    sample_value: r.sample_value,
    active: r.active,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function bad(message: string, requestId: string, reason?: string): AramoError {
  return new AramoError('VALIDATION_ERROR', message, 400, { requestId, ...(reason !== undefined ? { details: { reason } } : {}) });
}

function requiredText(v: unknown, field: string, max: number, requestId: string): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length === 0) throw bad(`${field} is required`, requestId);
  if (s.length > max) throw bad(`${field} must be at most ${max} characters`, requestId);
  return s;
}

function optionalText(v: unknown, field: string, max: number, requestId: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw bad(`${field} must be a string or null`, requestId);
  const s = v.trim();
  if (s.length > max) throw bad(`${field} must be at most ${max} characters`, requestId);
  return s.length === 0 ? null : s;
}

function productTags(v: unknown, requestId: string): string[] {
  if (!Array.isArray(v)) throw bad('products must be an array of product tags', requestId);
  if (v.length > PRODUCTS_MAX) throw bad(`products must have at most ${PRODUCTS_MAX} tags`, requestId);
  const out: string[] = [];
  for (const p of v) {
    if (typeof p !== 'string' || !PRODUCT_TAG.test(p)) throw bad(`invalid product tag: ${String(p)}`, requestId);
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

@Controller('platform')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PlatformDocumentTemplatesController {
  constructor(
    private readonly templates: TemplatesRepository,
    private readonly variables: TemplateVariablesRepository,
    // The same capability port the tenant admin flow uses (provided @Global by
    // TemplateCapabilitiesModule). @Optional only so the class can be unit-built.
    @Optional() @Inject(TEMPLATE_CAPABILITIES) private readonly caps?: TemplateCapabilitiesPort,
  ) {}

  // ---- Aramo default templates -------------------------------------------

  // SYSTEM document types an Aramo default may target (the create form's type list).
  // Declared before ':id' so the literal segment is matched first.
  @Get('document-templates/document-types')
  @RequireScopes('platform:document_template:read')
  async listDocumentTypes(@AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    this.assertPlatform(auth, requestId);
    const types = await this.templates.listSystemDocumentTypes();
    return {
      document_types: types.map((t) => ({
        id: t.id,
        key: t.key,
        name: t.name,
        configurable: this.caps?.isConfigurable(t.id) === true,
      })),
    };
  }

  @Get('document-templates')
  @RequireScopes('platform:document_template:read')
  async list(@AuthContext() auth: AuthContextType, @RequestId() requestId: string): Promise<{ templates: PlatformTemplateView[] }> {
    this.assertPlatform(auth, requestId);
    const rows = await this.templates.listPlatformTemplates();
    return { templates: rows.map((t) => toTemplateView(t, t.versions)) };
  }

  @Post('document-templates')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('platform:document_template:manage')
  async create(
    @Body() body: Record<string, unknown> | undefined,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<PlatformTemplateView> {
    this.assertPlatform(auth, requestId);
    const document_type_id = typeof body?.['document_type_id'] === 'string' ? body['document_type_id'] : '';
    const name = requiredText(body?.['name'], 'name', NAME_MAX, requestId);
    const description = optionalText(body?.['description'], 'description', DESCRIPTION_MAX, requestId);
    const template_kind = typeof body?.['template_kind'] === 'string' ? body['template_kind'] : '';
    if (!TEMPLATE_KINDS.has(template_kind)) throw bad('invalid template_kind', requestId);
    const products = body?.['products'] === undefined ? [] : productTags(body['products'], requestId);
    const types = await this.templates.listSystemDocumentTypes();
    if (!types.some((t) => t.id === document_type_id)) {
      throw bad('document_type_id must be an active SYSTEM document type', requestId, 'document_type_not_system');
    }
    return this.run(requestId, async () => {
      const t = await this.templates.createPlatformTemplate({
        document_type_id,
        name,
        ...(description !== null ? { description } : {}),
        template_kind,
        products,
        created_by: auth.sub,
      });
      return toTemplateView(t, []);
    });
  }

  @Get('document-templates/:id')
  @RequireScopes('platform:document_template:read')
  async get(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ) {
    this.assertPlatform(auth, requestId);
    return this.run(requestId, async () => {
      const t = await this.templates.getPlatformTemplate(id);
      const versions = await this.templates.listPlatformVersions(id);
      return { ...toTemplateView(t, versions), versions: versions.map((v) => this.versionView(v)) };
    });
  }

  // Name / description / product tags (D9). Status, versions and withdrawal are not
  // writable here.
  @Patch('document-templates/:id')
  @RequireScopes('platform:document_template:manage')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Record<string, unknown> | undefined,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<PlatformTemplateView> {
    this.assertPlatform(auth, requestId);
    const patch: { name?: string; description?: string | null; products?: string[] } = {};
    if (body !== undefined && body !== null && 'name' in body) patch.name = requiredText(body['name'], 'name', NAME_MAX, requestId);
    if (body !== undefined && body !== null && 'description' in body) {
      patch.description = optionalText(body['description'], 'description', DESCRIPTION_MAX, requestId);
    }
    if (body !== undefined && body !== null && 'products' in body) patch.products = productTags(body['products'], requestId);
    if (Object.keys(patch).length === 0) throw bad('one of name, description, products is required', requestId);
    return this.run(requestId, async () => {
      const t = await this.templates.updatePlatformTemplate(id, patch);
      return toTemplateView(t, await this.templates.listPlatformVersions(id));
    });
  }

  // The governed Insert-field catalog for this default's document type (catalog-driven).
  @Get('document-templates/:id/allowed-bindings')
  @RequireScopes('platform:document_template:read')
  async allowedBindings(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ) {
    this.assertPlatform(auth, requestId);
    return this.run(requestId, async () => {
      const t = await this.templates.getPlatformTemplate(id);
      // PLATFORM content carries no tenant asset (§3.5 [TD]) — tenant branding is bound at
      // render (T-3), so the editor never offers a logo here.
      return { bindings: (await this.caps?.listAllowedBindings(t.document_type_id)) ?? [], tenant_logo: { available: false, tenant_name: null } };
    });
  }

  // Open a DRAFT (one per template). With no body content the draft starts from the
  // current ACTIVE version's content (the capability's draftContentFrom transform, as in
  // the tenant flow); with { render_schema_version, field_schema } it starts from that
  // content, normalised by the capability (html allowlist sanitisation, catalog keys).
  @Post('document-templates/:id/versions')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('platform:document_template:manage')
  async createDraft(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Record<string, unknown> | undefined,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ) {
    this.assertPlatform(auth, requestId);
    const internal_notes = optionalText(body?.['internal_notes'], 'internal_notes', INTERNAL_NOTES_MAX, requestId);
    const hasContent = body !== undefined && body !== null && 'field_schema' in body;
    let render_schema_version: string | undefined;
    if (hasContent) {
      const rsv = body['render_schema_version'];
      if (typeof rsv !== 'string' || rsv.length === 0) throw bad('render_schema_version is required with field_schema', requestId);
      render_schema_version = rsv;
    }
    return this.run(requestId, async () => {
      const t = await this.templates.getPlatformTemplate(id);
      const caps = this.caps;
      const configurable = caps !== undefined && caps.isConfigurable(t.document_type_id);
      if (hasContent && render_schema_version !== undefined) {
        const field_schema = configurable
          ? await caps.normalizeDraftContent({
              document_type_id: t.document_type_id,
              render_schema_version,
              field_schema: body['field_schema'],
              existing_field_schema: null,
              requestId,
            })
          : body['field_schema'];
        const v = await this.templates.createPlatformVersion({
          template_id: id,
          render_schema_version,
          field_schema,
          internal_notes,
          created_by: auth.sub,
        });
        return this.versionView(v);
      }
      const transform = configurable
        ? (c: { render_schema_version: string; field_schema: unknown }) => caps.draftContentFrom({ document_type_id: t.document_type_id, ...c })
        : undefined;
      const v = await this.templates.createPlatformDraftFromActive({
        template_id: id,
        created_by: auth.sub,
        ...(transform !== undefined ? { transform } : {}),
      });
      return this.versionView(v);
    });
  }

  @Get('document-templates/versions/:versionId')
  @RequireScopes('platform:document_template:read')
  async getVersion(
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ) {
    this.assertPlatform(auth, requestId);
    return this.run(requestId, async () => this.versionView(await this.templates.getPlatformVersion(versionId)));
  }

  // DRAFT content / notes update. DRAFT-only (ACTIVE/RETIRED → 409 TEMPLATE_IMMUTABLE);
  // a content edit re-arms the §18 preview gate (repo: previewed_fingerprint := null).
  @Patch('document-templates/versions/:versionId')
  @RequireScopes('platform:document_template:manage')
  async updateDraft(
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @Body() body: Record<string, unknown> | undefined,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ) {
    this.assertPlatform(auth, requestId);
    const hasContent = body !== undefined && body !== null && 'field_schema' in body;
    const hasNotes = body !== undefined && body !== null && 'internal_notes' in body;
    if (!hasContent && !hasNotes) throw bad('field_schema or internal_notes is required', requestId);
    const internal_notes = hasNotes ? optionalText(body['internal_notes'], 'internal_notes', INTERNAL_NOTES_MAX, requestId) : undefined;
    const rsvRaw = body?.['render_schema_version'];
    if (rsvRaw !== undefined && (typeof rsvRaw !== 'string' || rsvRaw.length === 0)) throw bad('invalid render_schema_version', requestId);
    const render_schema_version = rsvRaw as string | undefined;
    return this.run(requestId, async () => {
      let field_schema: unknown = hasContent ? body['field_schema'] : undefined;
      if (hasContent && this.caps !== undefined) {
        const existing = await this.templates.getPlatformVersion(versionId);
        if (existing.status !== 'DRAFT') {
          throw new AramoError('TEMPLATE_IMMUTABLE', `TemplateVersion ${versionId} is not a DRAFT`, 409, { requestId });
        }
        const t = await this.templates.getPlatformTemplate(existing.template_id);
        if (this.caps.isConfigurable(t.document_type_id)) {
          field_schema = await this.caps.normalizeDraftContent({
            document_type_id: t.document_type_id,
            render_schema_version: render_schema_version ?? existing.render_schema_version,
            field_schema: body['field_schema'],
            existing_field_schema: existing.field_schema,
            requestId,
          });
        }
      }
      const v = await this.templates.updatePlatformDraftVersion({
        version_id: versionId,
        ...(hasContent ? { field_schema } : {}),
        ...(render_schema_version !== undefined ? { render_schema_version } : {}),
        ...(internal_notes !== undefined ? { internal_notes } : {}),
      });
      return this.versionView(v);
    });
  }

  // Fixed-sample preview of the CURRENT draft content (samples from the variable
  // catalog). Recording it arms the §18 publish gate for exactly this content.
  @Post('document-templates/versions/:versionId/preview')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('platform:document_template:manage')
  async preview(
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ) {
    this.assertPlatform(auth, requestId);
    return this.run(requestId, async () => {
      const v = await this.templates.getPlatformVersion(versionId);
      const t = await this.templates.getPlatformTemplate(v.template_id);
      if (this.caps === undefined || !this.caps.isConfigurable(t.document_type_id)) {
        throw bad('this document type is not configurable', requestId);
      }
      const out = await this.caps.renderSamplePreview({
        document_type_id: t.document_type_id,
        field_schema: v.field_schema,
        render_schema_version: v.render_schema_version,
        requestId,
      });
      await this.templates.recordPlatformPreview(versionId);
      return out;
    });
  }

  // Publish = DRAFT → ACTIVE: closed-binding validation (catalog), then the §18 preview
  // gate (409 TEMPLATE_PREVIEW_REQUIRED unless the current content was previewed), then
  // the prior ACTIVE version is RETIRED and current_version_id moves (tenants only ever
  // resolve the current version — D3). Documents already generated keep their pin.
  @Post('document-templates/versions/:versionId/publish')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('platform:document_template:manage')
  async publish(
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ) {
    this.assertPlatform(auth, requestId);
    return this.run(requestId, async () => {
      if (this.caps !== undefined) {
        const v = await this.templates.getPlatformVersion(versionId);
        const t = await this.templates.getPlatformTemplate(v.template_id);
        await this.caps.validateDraftContent({
          document_type_id: t.document_type_id,
          field_schema: v.field_schema,
          render_schema_version: v.render_schema_version,
          requestId,
        });
      }
      return this.versionView(await this.templates.activatePlatformVersion({ version_id: versionId, actor_id: auth.sub }));
    });
  }

  // ---- Template variable catalog (ADR-0034 D7) ---------------------------

  @Get('template-variables')
  @RequireScopes('platform:document_template:read')
  async listVariables(@AuthContext() auth: AuthContextType, @RequestId() requestId: string): Promise<{ variables: TemplateVariableView[] }> {
    this.assertPlatform(auth, requestId);
    return { variables: (await this.variables.listAll()).map(toVariableView) };
  }

  @Post('template-variables')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('platform:document_template:manage')
  async createVariable(
    @Body() body: Record<string, unknown> | undefined,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<TemplateVariableView> {
    this.assertPlatform(auth, requestId);
    const key = typeof body?.['key'] === 'string' ? body['key'].trim() : '';
    if (key.length > VARIABLE_KEY_MAX || !VARIABLE_KEY.test(key)) {
      throw bad('key must be dotted lower_snake segments (e.g. talent.full_name)', requestId, 'invalid_key');
    }
    const fields = this.variableFields(body ?? {}, requestId, true);
    const { label, group_label, data_type } = fields;
    // create=true makes variableFields require (or throw on) all three.
    if (label === undefined || group_label === undefined || data_type === undefined) {
      throw bad('label, group_label and data_type are required', requestId);
    }
    return this.runVariables(requestId, async () =>
      toVariableView(
        await this.variables.create({
          key,
          label,
          group_label,
          data_type,
          products: fields.products ?? [],
          ats_binding_key: fields.ats_binding_key ?? null,
          sample_value: fields.sample_value ?? null,
          active: fields.active ?? true,
        }),
      ),
    );
  }

  // label / group / data_type / products / ats_binding_key / sample_value / active.
  // The key is immutable (it is the token stored inside template content).
  @Patch('template-variables/:id')
  @RequireScopes('platform:document_template:manage')
  async updateVariable(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Record<string, unknown> | undefined,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<TemplateVariableView> {
    this.assertPlatform(auth, requestId);
    if (body !== undefined && body !== null && 'key' in body) throw bad('key is immutable', requestId, 'key_immutable');
    const patch = this.variableFields(body ?? {}, requestId, false);
    if (Object.keys(patch).length === 0) throw bad('no updatable field supplied', requestId);
    return this.runVariables(requestId, async () => toVariableView(await this.variables.update(id, patch)));
  }

  // ---- Internal ----------------------------------------------------------

  private variableFields(body: Record<string, unknown>, requestId: string, create: boolean): UpdateTemplateVariableInput {
    const out: { -readonly [K in keyof UpdateTemplateVariableInput]: UpdateTemplateVariableInput[K] } = {};
    if (create || 'label' in body) out.label = requiredText(body['label'], 'label', LABEL_MAX, requestId);
    if (create || 'group_label' in body) out.group_label = requiredText(body['group_label'], 'group_label', LABEL_MAX, requestId);
    if (create || 'data_type' in body) {
      const dt = body['data_type'];
      if (typeof dt !== 'string' || !(TEMPLATE_VARIABLE_DATA_TYPES as readonly string[]).includes(dt)) {
        throw bad(`data_type must be one of ${TEMPLATE_VARIABLE_DATA_TYPES.join(', ')}`, requestId);
      }
      out.data_type = dt as TemplateVariableDataType;
    }
    if ('products' in body) out.products = productTags(body['products'], requestId);
    if ('ats_binding_key' in body) {
      const v = optionalText(body['ats_binding_key'], 'ats_binding_key', VARIABLE_KEY_MAX, requestId);
      if (v !== null && !VARIABLE_KEY.test(v)) throw bad('invalid ats_binding_key', requestId, 'invalid_key');
      out.ats_binding_key = v;
    }
    if ('sample_value' in body) out.sample_value = optionalText(body['sample_value'], 'sample_value', SAMPLE_MAX, requestId);
    if ('active' in body) {
      if (typeof body['active'] !== 'boolean') throw bad('active must be a boolean', requestId);
      out.active = body['active'];
    }
    return out;
  }

  // A PLATFORM version view (same shape as the tenant version view; a PLATFORM default
  // never carries a logo asset).
  private versionView<V extends object>(v: V): V & { logo: null } {
    return { ...v, logo: null };
  }

  private assertPlatform(auth: AuthContextType, requestId: string): void {
    // DDR §13.1 tripwire app-side — a tenant token cannot satisfy a platform route.
    if (auth.consumer_type !== 'platform') {
      throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Platform routes require consumer_type=platform', 403, {
        requestId,
        details: { reason: 'tier_mismatch', consumer_type: auth.consumer_type },
      });
    }
  }

  private async run<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw templateErrorToHttp(e, requestId);
    }
  }

  private async runVariables<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof TemplateVariableNotFoundError) throw new AramoError('NOT_FOUND', e.message, 404, { requestId });
      if (e instanceof TemplateVariableKeyConflictError) {
        throw new AramoError('VALIDATION_ERROR', e.message, 409, { requestId, details: { reason: 'key_exists', key: e.key } });
      }
      throw e;
    }
  }
}
