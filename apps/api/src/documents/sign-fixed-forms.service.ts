import { createHash } from 'node:crypto';

import { AramoError } from '@aramo/common';
import {
  DocumentIdempotencyConflictError,
  DocumentIdempotencyService,
  DocumentsRepository,
  FixedFormsRepository,
  TemplatesRepository,
  type DocumentStoragePort,
  type PublishedFixedForm,
} from '@aramo/documents';
import {
  type SignTemplateFieldDefinition,
  type SignTemplatePreviewResponse,
  type SignTemplateRenderResponse,
  type SignTemplateSigning,
  type SignTemplateSummary,
  type SignTemplateVariable,
} from '@aramo/documents-contracts';

import { stampFixedFormValues } from './fixed-form-pdf.js';
import { FixedFormService, fixedFormContentOf, fixedFormSigningOf } from './fixed-form.service.js';

// TEMPLATE-PRODUCT-1 (Implementation Directive v1.0 LOCKED) §7.4 — Aramo fixed legal forms in
// Aramo Sign, plugged into SignTemplateLibraryService at the TP-4 seam (list / preview /
// render). Called only over the signed service-to-service channel; sign-service never touches
// the documents schema.
//
//   list    — every published fixed form tagged `sign` that the tenant has not hidden
//             (TenantTemplateVisibility, default shown). template_kind FIXED_FORM, owner
//             PLATFORM, resolution AVAILABLE (a fixed form is never "the default" of a type).
//   preview — the form's roles and the variables of its prefilled text fields (organization
//             profile values, the rest sender-filled). The PDF itself is shown in the Sign
//             editor once the envelope exists (html null, no blocks).
//   render  — "Use": the stored official PDF (sha256-verified), the prefilled values printed
//             on it, frozen as the Document + DocumentRevision pinned to the EXACT version (T-5
//             rule), idempotent on the key like every template render. The placed fields go
//             back as field_definitions (role-bound) so sign-service maps them to recipients
//             by role (sender-templates.service, M-A6 §3.5).

const MAX_VALUE_LENGTH = 2000;
const MAX_VALUES = 100;
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

export interface SignFixedFormsDeps {
  forms: FixedFormsRepository;
  service: FixedFormService;
  templates: TemplatesRepository;
  documents: DocumentsRepository;
  idempotency: DocumentIdempotencyService;
  storage: DocumentStoragePort;
  organizationValues: (tenant_id: string) => Promise<Map<string, string>>;
}

function invalid(message: string, requestId: string, details: Record<string, unknown>): AramoError {
  return new AramoError('VALIDATION_ERROR', message, 422, { requestId, details });
}

export class SignFixedFormsService {
  constructor(private readonly d: SignFixedFormsDeps) {}

  /** The visible fixed forms tagged `sign` for a tenant (published, not hidden). */
  private async visible(tenant_id: string, template_id?: string): Promise<PublishedFixedForm[]> {
    const forms = await this.d.forms.listPublishedFixedForms({ now: new Date(), products: ['sign'], ...(template_id !== undefined ? { template_id } : {}) });
    const typesTaggedSign = new Set((await this.d.forms.listFixedFormTypes('sign')).map((t) => t.id));
    const visibility = await this.d.forms.visibilityFor(tenant_id);
    return forms.filter((f) => typesTaggedSign.has(f.type.id) && visibility.get(f.template.id) !== true);
  }

  /** Whether a template id is an Aramo fixed form (any state) — the library delegates it here. */
  async handles(template_id: string): Promise<boolean> {
    const t = await this.d.forms.getPlatformTemplate(template_id).catch(() => null);
    return t !== null && (await this.d.forms.isFixedFormType(t.document_type_id));
  }

  async list(tenant_id: string): Promise<SignTemplateSummary[]> {
    const out: SignTemplateSummary[] = [];
    for (const f of await this.visible(tenant_id)) out.push(await this.summary(tenant_id, f));
    return out;
  }

  async preview(input: { tenant_id: string; template_id: string; values: Readonly<Record<string, string>>; requestId: string }): Promise<SignTemplatePreviewResponse> {
    const f = await this.usable(input.tenant_id, input.template_id, input.requestId);
    const variables = await this.variables(input.tenant_id, f);
    this.senderValues(variables, input.values, input.requestId);
    const org = await this.d.organizationValues(input.tenant_id);
    return {
      template_id: f.template.id,
      version_id: f.version.id,
      version_number: f.version.version_number,
      title: fixedFormContentOf(f.version.field_schema, f.template.name).content.title,
      blocks: [],
      html: null,
      letterhead: { organization_name: org.get('organization.name') ?? null, logo_available: false },
      variables,
      signing: this.signing(f),
      template_kind: 'FIXED_FORM',
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
    const key = `sign-template-render:${input.idempotency_key}`;
    const request_hash = DocumentIdempotencyService.hashRequest({
      template_id: input.template_id,
      values: input.values,
      created_by: input.created_by,
      client_id: input.client_id,
    });
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
    const f = await this.usable(input.tenant_id, input.template_id, requestId);
    const { content } = fixedFormContentOf(f.version.field_schema, f.template.name);
    if (content.pdf === null) throw new AramoError('TEMPLATE_NOT_FOUND', `template ${input.template_id} is not available to this organization`, 404, { requestId, details: { reason: 'pdf_missing' } });
    const variables = await this.variables(input.tenant_id, f);
    const sender = this.senderValues(variables, input.values, requestId);
    const values = new Map<string, string>();
    for (const v of variables) if (v.source === 'ORGANIZATION' && v.value !== null) values.set(v.key, v.value);
    for (const [k, v] of sender) values.set(k, v);
    const missing = variables.filter((v) => !values.has(v.key)).map((v) => v.key);
    if (missing.length > 0) {
      throw new AramoError('RTR_TEMPLATE_BINDING_MISSING', 'Fill in every template field before creating the envelope', 422, {
        requestId,
        details: { binding_key: missing[0], missing_keys: missing },
      });
    }
    const fields = await this.d.forms.listFields(f.version.id);
    const source = await this.d.service.readPdf(content.pdf, requestId);
    const prefilled = fields.filter(
      (x): x is typeof x & { binding_key: string; page_number: number; x: number; y: number; width: number; height: number } =>
        x.binding_key !== null && x.page_number !== null && x.x !== null && x.y !== null && x.width !== null && x.height !== null && (values.get(x.binding_key) ?? '').length > 0,
    );
    const stamps = prefilled.map((x) => ({ page_number: x.page_number, x: x.x, y: x.y, width: x.width, height: x.height, text: values.get(x.binding_key) ?? '' }));
    let frozen: Uint8Array;
    try {
      frozen = await stampFixedFormValues(new Uint8Array(source), stamps);
    } catch (e) {
      throw new AramoError('DOCUMENT_RENDER_FAILED', `the form could not be prepared: ${e instanceof Error ? e.message : String(e)}`, 500, { requestId });
    }
    const signing = this.signing(f);
    const signerCount = signing?.roles.filter((r) => r.kind === 'SIGNER').length ?? 1;

    // 2. The Document (idempotent on the key) and its FROZEN revision pinned to the version.
    let doc;
    try {
      doc = await this.d.documents.createDocument(
        {
          tenant_id: input.tenant_id,
          document_type_id: f.type.id,
          title: content.title,
          execution_mode: signerCount > 1 ? 'MULTI_SIGNATURE' : 'SINGLE_SIGNATURE',
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
    const sha256 = createHash('sha256').update(frozen).digest('hex');
    const storage_key = `documents/${input.tenant_id}/${doc.id}/rendered/${sha256}.pdf`;
    await this.d.storage.putArtifact({ storage_key, body: Buffer.from(frozen), content_type: 'application/pdf', requestId });
    await this.d.forms.writeFrozenRevision({
      tenant_id: input.tenant_id,
      document_id: doc.id,
      template_version_id: f.version.id,
      storage_key,
      sha256,
      byte_size: frozen.byteLength,
      render_manifest: {
        fixed_form: {
          template_id: f.template.id,
          source_asset_id: content.pdf.asset_id,
          source_sha256: content.pdf.sha256,
          prefilled_keys: [...new Set(prefilled.map((x) => x.binding_key))],
        },
      },
      actor_id: input.created_by,
    });
    const out = await this.frozenResponse(input.tenant_id, doc.id, requestId);
    if (out === null) throw new AramoError('DOCUMENT_RENDER_FAILED', 'the document could not be frozen', 500, { requestId });
    return out;
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async usable(tenant_id: string, template_id: string, requestId: string): Promise<PublishedFixedForm> {
    const f = (await this.visible(tenant_id, template_id))[0];
    if (f === undefined) {
      throw new AramoError('TEMPLATE_NOT_FOUND', `template ${template_id} is not available to this organization`, 404, {
        requestId,
        details: { reason: 'not_a_usable_template' },
      });
    }
    return f;
  }

  private signing(f: PublishedFixedForm): SignTemplateSigning | null {
    const s = fixedFormSigningOf(f.version.field_schema);
    return s === null ? null : { roles: s.roles.map((r) => ({ ...r })), routing_mode: s.routing_mode };
  }

  private async summary(tenant_id: string, f: PublishedFixedForm): Promise<SignTemplateSummary> {
    const signing = this.signing(f);
    return {
      template_id: f.template.id,
      name: f.template.name,
      description: f.template.description,
      document_type: { id: f.type.id, key: f.type.key, name: f.type.name },
      owner_scope: 'PLATFORM',
      resolution: 'AVAILABLE',
      is_default: false,
      version_id: f.version.id,
      version_number: f.version.version_number,
      updated_at: (f.version.activated_at ?? f.template.updated_at).toISOString(),
      variables: await this.variables(tenant_id, f),
      category: f.type.name,
      signer_role_count: signing === null ? 1 : signing.roles.filter((r) => r.kind === 'SIGNER').length,
      cc_role_count: signing === null ? 0 : signing.roles.filter((r) => r.kind === 'CC').length,
      document_count: 1,
      routing_mode: signing?.routing_mode ?? 'PARALLEL',
      signing,
      template_kind: 'FIXED_FORM',
    };
  }

  // The variables of the prefilled text fields: organization profile values when on record,
  // otherwise filled by the sender (as for every Sign template).
  private async variables(tenant_id: string, f: PublishedFixedForm): Promise<SignTemplateVariable[]> {
    const fields = await this.d.forms.listFields(f.version.id);
    const keys = [...new Set(fields.map((x) => x.binding_key).filter((k): k is string => k !== null))];
    if (keys.length === 0) return [];
    const catalog = new Map((await this.d.service.allowedVariables(f.type.id)).map((v) => [v.key, v]));
    const org = await this.d.organizationValues(tenant_id);
    return keys.map((key) => {
      const c = catalog.get(key);
      const value = ORGANIZATION_KEYS.has(key) ? (org.get(key) ?? null) : null;
      return { key, label: c?.label ?? key, group: c?.group ?? '', source: value !== null ? 'ORGANIZATION' : 'SENDER', value };
    });
  }

  private senderValues(variables: readonly SignTemplateVariable[], raw: Readonly<Record<string, string>>, requestId: string): Map<string, string> {
    const sender = new Set(variables.filter((v) => v.source === 'SENDER').map((v) => v.key));
    const known = new Set(variables.map((v) => v.key));
    const entries = Object.entries(raw ?? {});
    if (entries.length > MAX_VALUES) throw invalid('too many values', requestId, { reason: 'too_many_values' });
    const out = new Map<string, string>();
    for (const [key, value] of entries) {
      if (typeof value !== 'string') throw invalid(`value for ${key} must be text`, requestId, { reason: 'value_not_text', key });
      if (!known.has(key)) throw invalid(`${key} is not a field of this template`, requestId, { reason: 'unknown_variable', key });
      if (!sender.has(key)) throw invalid(`${key} comes from your organization profile`, requestId, { reason: 'variable_not_sender_fillable', key });
      const v = value.trim();
      if (v.length > MAX_VALUE_LENGTH) throw invalid(`value for ${key} is too long`, requestId, { reason: 'value_too_long', key });
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)) throw invalid(`value for ${key} has control characters`, requestId, { reason: 'value_invalid', key });
      if (v.length > 0) out.set(key, v);
    }
    return out;
  }

  private async frozenResponse(tenant_id: string, document_id: string, requestId: string): Promise<SignTemplateRenderResponse | null> {
    const doc = await this.d.documents.getDocument(tenant_id, document_id).catch(() => null);
    if (doc === null) return null;
    const rev = await this.d.documents.getCurrentRevision(tenant_id, document_id);
    if (rev === null || rev.content_sha256 === null || rev.template_version_id === null) return null;
    const version = await this.d.templates.findVersionByIdOwnerAware(tenant_id, rev.template_version_id);
    if (version === null) throw new AramoError('TEMPLATE_VERSION_NOT_FOUND', 'pinned template version not found', 404, { requestId });
    const s = fixedFormSigningOf(version.field_schema);
    // Only the fields a signer fills go to Sign; a prefilled text field is already printed.
    const defs = (await this.d.templates.listFieldDefinitionsOwnerAware(tenant_id, version.id)).filter((x) => x.binding_key === null);
    return {
      document_id,
      document_revision_ref: rev.id,
      source_sha256: rev.content_sha256,
      byte_size: rev.byte_size ?? 0,
      title: doc.title,
      template_id: version.template_id,
      template_version_id: version.id,
      version_number: version.version_number,
      signature_fields: [],
      field_definitions: defs.map(
        (x): SignTemplateFieldDefinition => ({
          field_key: x.field_key,
          field_type: x.field_type,
          signer_role: x.signer_role,
          required: x.required,
          page_number: x.page_number,
          x: x.x,
          y: x.y,
          width: x.width,
          height: x.height,
        }),
      ),
      signing: s === null ? null : { roles: s.roles.map((r) => ({ ...r })), routing_mode: s.routing_mode },
      template_kind: 'FIXED_FORM',
    };
  }

  private conflict(idempotency_key: string, requestId: string): AramoError {
    return new AramoError('IDEMPOTENCY_KEY_CONFLICT', 'this idempotency key was used for a different request', 409, {
      requestId,
      details: { idempotency_key },
    });
  }
}
