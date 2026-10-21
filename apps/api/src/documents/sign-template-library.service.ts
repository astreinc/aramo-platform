import { Injectable, Logger } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import {
  DocumentIdempotencyConflictError,
  DocumentIdempotencyService,
  DocumentsRepository,
  RenderService,
  TemplatesRepository,
  type DocumentStoragePort,
  type TemplateCapabilitiesPort,
  type TemplateTenantLogoPort,
} from '@aramo/documents';
import {
  type SignTemplateFieldDefinition,
  type SignTemplateListResponse,
  type SignTemplatePreviewResponse,
  type SignTemplateRenderResponse,
  type SignTemplateSignatureField,
  type SignTemplateSummary,
  type SignTemplateVariable,
} from '@aramo/documents-contracts';
import { type LetterheadModel } from '@aramo/documents-rendering';
import { type TenantRepository } from '@aramo/identity';

import { RIGHT_TO_REPRESENT_TYPE_ID } from '../rtr/rtr-constants.js';
import { isHtmlContent } from '../rtr/rtr-html-content.js';
import { type RtrTemplateBindingService } from '../rtr/rtr-template-binding.service.js';
import { captureTenantLetterhead, loadLetterhead } from '../rtr/rtr-template-letterhead.js';
import { type ResolvedRtrTemplate, type RtrTemplateResolverService } from '../rtr/rtr-template-resolver.service.js';

// DOC-TEMPLATE-LIB-1 T-5 — Implementation Directive v1.0 (LOCKED) §7 (ADR-0034 D6, D7, D8,
// D12; Conforming Amendment #9). The Documents side of "start an Aramo Sign envelope from a
// template". Called ONLY by sign-service over the signed service-to-service channel
// (DocumentsEsignTemplatesController); sign-service never touches the documents schema —
// the Document + frozen DocumentRevision are written HERE, by apps/api.
//
//   list    — per configurable document type, the template the tenant's explicit choice
//             resolves to (client → tenant → Aramo default; ADR-0034 D6: product flows use
//             the most specific choice and never ask the user). Product tags are recorded,
//             not enforced (D9), so nothing is filtered by product.
//   preview — the resolved template's current version with the tenant's branding values
//             and the sender's values; samples for the rest. Writes nothing.
//   render  — binds the tenant-profile values + the sender's values (Sign has no ATS
//             context: every talent / requisition / client / recruiter value is sender-
//             filled), applies the tenant letterhead to an Aramo default, and freezes a
//             Document + DocumentRevision pinned to the EXACT template_version_id. Returns
//             the CORE_REF document_revision_ref the envelope references.
//
// Only the RTR content contract (rtr-generated-v1 / rtr-html-v1) is renderable today — the
// only configurable document type (TemplateCapabilitiesPort.isConfigurable).

// Variables whose value is the tenant's own profile (ORGANIZATION when on record).
const ORGANIZATION_KEYS = new Set([
  'organization.name',
  'organization.address_line1',
  'organization.address_line2',
  'organization.city',
  'organization.region',
  'organization.postal_code',
  'organization.country',
  'recruiting_company.name',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_VALUE_LENGTH = 2000;
const MAX_VALUES = 100;

function invalid(message: string, requestId: string, details: Record<string, unknown>): AramoError {
  return new AramoError('VALIDATION_ERROR', message, 422, { requestId, details });
}

export interface SignTemplateLibraryDeps {
  templates: TemplatesRepository;
  documents: DocumentsRepository;
  render: RenderService;
  idempotency: DocumentIdempotencyService;
  storage: DocumentStoragePort;
  resolver: RtrTemplateResolverService;
  binding: RtrTemplateBindingService;
  tenants: TenantRepository;
  caps?: TemplateCapabilitiesPort;
  tenantLogo?: TemplateTenantLogoPort;
}

@Injectable()
export class SignTemplateLibraryService {
  private readonly logger = new Logger(SignTemplateLibraryService.name);

  constructor(private readonly d: SignTemplateLibraryDeps) {}

  async list(input: { tenant_id: string; client_id: string | null; requestId: string }): Promise<SignTemplateListResponse> {
    await this.assertTenant(input.tenant_id, input.requestId);
    const items: SignTemplateSummary[] = [];
    const unavailable: { document_type_id: string; reason: string }[] = [];
    for (const type of await this.renderableTypes()) {
      let resolved: ResolvedRtrTemplate;
      try {
        resolved = await this.d.resolver.resolveActive({ tenant_id: input.tenant_id, client_id: input.client_id, requestId: input.requestId });
      } catch (e) {
        if (!(e instanceof AramoError)) throw e;
        // Never configured for this type: simply nothing to offer.
        if (e.code === 'RTR_TEMPLATE_NOT_CONFIGURED') continue;
        unavailable.push({ document_type_id: type.id, reason: e.code });
        continue;
      }
      items.push(await this.summary(input.tenant_id, type, resolved, input.requestId));
    }
    return { items, unavailable };
  }

  async preview(input: {
    tenant_id: string;
    template_id: string;
    values: Readonly<Record<string, string>>;
    requestId: string;
  }): Promise<SignTemplatePreviewResponse> {
    await this.assertTenant(input.tenant_id, input.requestId);
    const { resolved, type } = await this.resolveTemplate(input.tenant_id, input.template_id, null, input.requestId);
    const variables = await this.variables(input.tenant_id, type.id, resolved, input.requestId);
    const sender = this.senderValues(variables, input.values, input.requestId);
    const caps = this.d.caps;
    if (caps === undefined) throw new AramoError('TEMPLATE_NOT_FOUND', 'template previews are not available', 404, { requestId: input.requestId });
    const version = await this.d.templates.findVersionByIdOwnerAware(input.tenant_id, resolved.template_version_id);
    if (version === null) throw new AramoError('TEMPLATE_VERSION_NOT_FOUND', 'template version not found', 404, { requestId: input.requestId });
    const overrides: Record<string, string> = {};
    for (const v of variables) if (v.source === 'ORGANIZATION' && v.value !== null) overrides[v.key] = v.value;
    for (const [k, v] of sender) overrides[k] = v;
    const preview = await caps.renderSamplePreview({
      document_type_id: type.id,
      field_schema: version.field_schema,
      render_schema_version: version.render_schema_version,
      requestId: input.requestId,
      sample_overrides: overrides,
    });
    const orgValues = await this.d.binding.organizationValues(input.tenant_id);
    const brand = await this.d.tenants.findBrandingById(input.tenant_id);
    return {
      template_id: resolved.template_id,
      version_id: resolved.template_version_id,
      version_number: resolved.version_number,
      title: preview.title,
      blocks: preview.blocks.map((b) => ({ type: b.type, text: b.text })),
      html: preview.html ?? null,
      letterhead: {
        organization_name: orgValues.get('organization.name') ?? null,
        logo_available: (brand?.logo_url ?? '').trim().length > 0,
      },
      variables,
    };
  }

  async render(input: {
    tenant_id: string;
    template_id: string;
    values: Readonly<Record<string, string>>;
    created_by: string;
    client_id: string | null;
    idempotency_key: string;
    requestId: string;
  }): Promise<SignTemplateRenderResponse> {
    const { requestId } = input;
    await this.assertTenant(input.tenant_id, requestId);
    const key = `sign-template-render:${input.idempotency_key}`;
    const request_hash = DocumentIdempotencyService.hashRequest({
      template_id: input.template_id,
      values: input.values,
      created_by: input.created_by,
      client_id: input.client_id,
    });
    // A repeated request (same key + same body) returns the SAME frozen revision — a retried
    // or replayed call never creates a second Document. Same key + different body ⇒ 409.
    const pre = await this.d.idempotency.lookup(input.tenant_id, key, request_hash);
    if (pre.kind === 'conflict') throw this.conflict(input.idempotency_key, requestId);
    if (pre.kind === 'replay') {
      const document_id = (pre.response_body as { document_id?: string } | null)?.document_id;
      if (typeof document_id === 'string') {
        const replayed = await this.frozenResponse(input.tenant_id, document_id, requestId);
        if (replayed !== null) return replayed;
      }
    }

    // 1. Resolve + pin (fail closed before any write).
    const { resolved, type } = await this.resolveTemplate(input.tenant_id, input.template_id, input.client_id, requestId);
    const variables = await this.variables(input.tenant_id, type.id, resolved, requestId);
    const sender = this.senderValues(variables, input.values, requestId);
    const values = new Map<string, string>();
    for (const v of variables) {
      if (v.source === 'ORGANIZATION' && v.value !== null) values.set(v.key, v.value);
    }
    for (const [k, v] of sender) values.set(k, v);
    const missing = variables.filter((v) => !values.has(v.key)).map((v) => v.key);
    if (missing.length > 0) {
      throw new AramoError('RTR_TEMPLATE_BINDING_MISSING', 'Fill in every template field before creating the envelope', 422, {
        requestId,
        details: { binding_key: missing[0], missing_keys: missing },
      });
    }

    // 2. Letterhead: an Aramo default takes the tenant's CURRENT profile logo (captured
    //    into a per-render tenant asset, ADR-0034 D8); a tenant html version its frozen logo.
    const letterhead: LetterheadModel | undefined =
      resolved.owner_scope === 'PLATFORM'
        ? await captureTenantLetterhead(
            {
              templates: this.d.templates,
              storage: this.d.storage,
              logger: this.logger,
              ...(this.d.tenantLogo !== undefined ? { tenantLogo: this.d.tenantLogo } : {}),
            },
            input.tenant_id,
            input.created_by,
            requestId,
          )
        : isHtmlContent(resolved.content) && resolved.content.logo
          ? await loadLetterhead({ templates: this.d.templates, storage: this.d.storage }, input.tenant_id, resolved.content.logo, requestId)
          : undefined;

    // 3. Bind (closed catalog, supplied values only) → a fully resolved RenderModel.
    const model = await this.d.binding.bindProvided({
      content: resolved.content,
      template_version_id: resolved.template_version_id,
      tenant_id: input.tenant_id,
      values,
      requestId,
      ...(letterhead !== undefined ? { letterhead } : {}),
    });
    const renderModel = { ...model };
    delete renderModel.bound_html;
    const title = (model.title ?? '').trim() || resolved.template_name;

    // 4. Create the Document (idempotent on the key) and FREEZE the revision pinned to
    //    the exact template version. Nothing here is associated with ATS records.
    let doc;
    try {
      doc = await this.d.documents.createDocument(
        {
          tenant_id: input.tenant_id,
          document_type_id: type.id,
          title,
          execution_mode: 'SINGLE_SIGNATURE',
          source_kind: 'TEMPLATE_GENERATED',
          created_by: input.created_by,
          request_id: requestId,
        },
        { key, request_hash },
      );
    } catch (e) {
      if (e instanceof DocumentIdempotencyConflictError) throw this.conflict(input.idempotency_key, requestId);
      throw e;
    }
    const existing = await this.frozenResponse(input.tenant_id, doc.id, requestId);
    if (existing !== null) return existing;
    await this.d.render.generateRevision({
      tenant_id: input.tenant_id,
      document_id: doc.id,
      template_version_id: resolved.template_version_id,
      model: renderModel,
      actor_id: input.created_by,
      requestId,
    });
    const out = await this.frozenResponse(input.tenant_id, doc.id, requestId);
    if (out === null) throw new AramoError('DOCUMENT_RENDER_FAILED', 'the document could not be frozen', 500, { requestId });
    return out;
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async summary(
    tenant_id: string,
    type: { id: string; key: string; name: string },
    resolved: ResolvedRtrTemplate,
    requestId: string,
  ): Promise<SignTemplateSummary> {
    const t = await this.d.templates.findTemplateByIdOwnerAware(tenant_id, resolved.template_id);
    const v = await this.d.templates.findVersionByIdOwnerAware(tenant_id, resolved.template_version_id);
    const updated = v?.activated_at ?? t?.updated_at ?? new Date(0);
    return {
      template_id: resolved.template_id,
      name: resolved.template_name,
      description: t?.description ?? null,
      document_type: type,
      owner_scope: resolved.owner_scope,
      resolution: resolved.source,
      version_id: resolved.template_version_id,
      version_number: resolved.version_number,
      updated_at: updated.toISOString(),
      variables: await this.variables(tenant_id, type.id, resolved, requestId),
    };
  }

  private async renderableTypes(): Promise<Array<{ id: string; key: string; name: string }>> {
    const types = await this.d.templates.listSystemDocumentTypes();
    return types
      .filter((t) => t.id === RIGHT_TO_REPRESENT_TYPE_ID && this.d.caps?.isConfigurable(t.id) === true)
      .map((t) => ({ id: t.id, key: t.key, name: t.name }));
  }

  // Unknown tenant ⇒ 404: a Document is never written for a tenant that does not exist.
  private async assertTenant(tenant_id: string, requestId: string): Promise<void> {
    if (!UUID_RE.test(tenant_id) || (await this.d.tenants.findById(tenant_id)) === null) {
      throw new AramoError('NOT_FOUND', 'tenant not found', 404, { requestId, details: { reason: 'tenant_unknown' } });
    }
  }

  // The template must be the one the tenant's choice resolves to NOW (same resolution the
  // list used). Anything else — another tenant's template, a non-selected template, a
  // withdrawn default — reads as not found; nothing is rendered from it.
  private async resolveTemplate(
    tenant_id: string,
    template_id: string,
    client_id: string | null,
    requestId: string,
  ): Promise<{ resolved: ResolvedRtrTemplate; type: { id: string; key: string; name: string } }> {
    const notFound = (reason: string): AramoError =>
      new AramoError('TEMPLATE_NOT_FOUND', `template ${template_id} is not available to this organization`, 404, {
        requestId,
        details: { reason },
      });
    if (!UUID_RE.test(template_id)) throw notFound('invalid_id');
    const t = await this.d.templates.findTemplateByIdOwnerAware(tenant_id, template_id);
    if (t === null) throw notFound('unknown_template');
    const type = (await this.renderableTypes()).find((x) => x.id === t.document_type_id);
    if (type === undefined) throw notFound('document_type_not_renderable');
    const resolved = await this.d.resolver.resolveActive({ tenant_id, client_id, requestId });
    if (resolved.template_id !== template_id) throw notFound('not_the_selected_template');
    return { resolved, type };
  }

  private async variables(
    tenant_id: string,
    document_type_id: string,
    resolved: ResolvedRtrTemplate,
    requestId: string,
  ): Promise<SignTemplateVariable[]> {
    const used = this.d.binding.usedKeys(resolved.content, requestId);
    const org = await this.d.binding.organizationValues(tenant_id);
    const catalog = this.d.caps !== undefined ? await this.d.caps.listAllowedBindings(document_type_id) : [];
    const order = new Map(catalog.map((c, i) => [c.key, i]));
    const byKey = new Map(catalog.map((c) => [c.key, c]));
    return [...used]
      .sort((a, b) => (order.get(a) ?? 1e6) - (order.get(b) ?? 1e6) || (a < b ? -1 : 1))
      .map((key) => {
        const c = byKey.get(key);
        const value = ORGANIZATION_KEYS.has(key) ? (org.get(key) ?? null) : null;
        return {
          key,
          label: c?.label ?? key,
          group: c?.group ?? '',
          source: value !== null ? 'ORGANIZATION' : 'SENDER',
          value,
        };
      });
  }

  // Sender values: only SENDER variables of this template, plain strings, bounded.
  private senderValues(
    variables: readonly SignTemplateVariable[],
    raw: Readonly<Record<string, string>>,
    requestId: string,
  ): Map<string, string> {
    const sender = new Set(variables.filter((v) => v.source === 'SENDER').map((v) => v.key));
    const known = new Set(variables.map((v) => v.key));
    const entries = Object.entries(raw ?? {});
    if (entries.length > MAX_VALUES) throw invalid('too many values', requestId, { reason: 'too_many_values' });
    const out = new Map<string, string>();
    for (const [key, value] of entries) {
      if (typeof value !== 'string') throw invalid(`value for ${key} must be text`, requestId, { reason: 'value_not_text', key });
      if (!known.has(key)) throw invalid(`${key} is not a field of this template`, requestId, { reason: 'unknown_variable', key });
      if (!sender.has(key)) {
        throw invalid(`${key} comes from your organization profile`, requestId, { reason: 'variable_not_sender_fillable', key });
      }
      const v = value.trim();
      if (v.length > MAX_VALUE_LENGTH) throw invalid(`value for ${key} is too long`, requestId, { reason: 'value_too_long', key });
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)) throw invalid(`value for ${key} has control characters`, requestId, { reason: 'value_invalid', key });
      if (v.length > 0) out.set(key, v);
    }
    return out;
  }

  // The frozen revision of a Document created through this path, or null when it has none
  // yet (a create that crashed before rendering — the caller renders it now).
  private async frozenResponse(tenant_id: string, document_id: string, requestId: string): Promise<SignTemplateRenderResponse | null> {
    const doc = await this.d.documents.getDocument(tenant_id, document_id).catch(() => null);
    if (doc === null) return null;
    const rev = await this.d.documents.getCurrentRevision(tenant_id, document_id);
    if (rev === null || rev.content_sha256 === null || rev.template_version_id === null) return null;
    const version = await this.d.templates.findVersionByIdOwnerAware(tenant_id, rev.template_version_id);
    if (version === null) throw new AramoError('TEMPLATE_VERSION_NOT_FOUND', 'pinned template version not found', 404, { requestId });
    const defs = await this.d.templates.listFieldDefinitionsOwnerAware(tenant_id, version.id);
    return {
      document_id,
      document_revision_ref: rev.id,
      source_sha256: rev.content_sha256,
      byte_size: rev.byte_size ?? 0,
      title: doc.title,
      template_id: version.template_id,
      template_version_id: version.id,
      version_number: version.version_number,
      signature_fields: signatureFields(rev.render_manifest),
      field_definitions: defs.map(
        (f): SignTemplateFieldDefinition => ({
          field_key: f.field_key,
          field_type: f.field_type,
          signer_role: f.signer_role,
          required: f.required,
          page_number: f.page_number,
          x: f.x,
          y: f.y,
          width: f.width,
          height: f.height,
        }),
      ),
    };
  }

  private conflict(idempotency_key: string, requestId: string): AramoError {
    return new AramoError('IDEMPOTENCY_KEY_CONFLICT', 'this idempotency key was used for a different request', 409, {
      requestId,
      details: { idempotency_key },
    });
  }
}

// The renderer-drawn signature block (frozen in render_manifest.signature_fields).
export function signatureFields(manifest: unknown): SignTemplateSignatureField[] {
  const raw = (manifest as { signature_fields?: unknown } | null)?.signature_fields;
  if (!Array.isArray(raw)) return [];
  const out: SignTemplateSignatureField[] = [];
  for (const f of raw as Array<Record<string, unknown>>) {
    const type = f['field_type'];
    if (type !== 'SIGNATURE' && type !== 'SIGN_DATE') continue;
    const [page, x, y, width, height] = [f['page_number'], f['x'], f['y'], f['width'], f['height']];
    if (typeof page !== 'number' || typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number') continue;
    out.push({ field_type: type, page_number: page, x, y, width, height });
  }
  return out;
}
