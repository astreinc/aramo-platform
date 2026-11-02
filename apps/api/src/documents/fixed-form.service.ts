import { createHash } from 'node:crypto';

import { AramoError } from '@aramo/common';
import {
  FIXED_FORM_MAX_BYTES,
  FIXED_FORM_SCHEMA_V1,
  PLATFORM_TEMPLATE_ASSET_PREFIX,
  FixedFormsRepository,
  TemplatesRepository,
  TemplateVariablesRepository,
  emptyFixedFormContent,
  fixedFormIssues,
  fixedFormPdfOf,
  isFixedFormFieldType,
  type DocumentStoragePort,
  type FixedFormContent,
  type FixedFormField,
  type FixedFormIssue,
  type FixedFormPdfRef,
  type FixedFormRole,
  type FixedFormSigning,
} from '@aramo/documents';

import { parseSigningConfig } from '../rtr/rtr-html-content.js';

import { acceptFixedFormPdf } from './fixed-form-pdf.js';

// TEMPLATE-PRODUCT-1 (Implementation Directive v1.0 LOCKED) §7 — the fixed-form rules shared
// by the platform authoring routes (§7.1, §7.2), the tenant read-only routes (§7.3) and the
// Sign use path (§7.4). The persistence is FixedFormsRepository (libs/documents); the PDF
// bytes go through the documents storage port under the platform prefix.
//
// Content contract (field_schema, render_schema_version fixed-form-pdf-v1):
//   { render_schema_version, title, pdf: {asset_id, sha256, byte_size, page_count, pages} | null,
//     signing: {roles, routing_mode} }   — roles parsed with the shared rtr-html-v1 signing
//   parser (the same role rules Sign binds by).
// The placed fields are TemplateFieldDefinition rows (PDF-native geometry). Publishing is the
// shared one: the fixed-form preview route validates and records the §18 preview, and the
// platform publish route (TP-1 tag check, one live default per type) activates it.

export interface FixedFormVariable {
  readonly key: string;
  readonly label: string;
  readonly group: string;
  readonly data_type: string;
  readonly sample_value: string | null;
}

export interface FixedFormFieldView {
  readonly field_key: string;
  readonly field_type: string;
  readonly binding_key: string | null;
  readonly signer_role: string | null;
  readonly required: boolean;
  readonly page_number: number | null;
  readonly x: number | null;
  readonly y: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly ordinal: number;
}

const ROUTING = new Set(['PARALLEL', 'SEQUENTIAL']);
const TITLE_MAX = 200;

function invalid(message: string, requestId: string, details: Record<string, unknown>): AramoError {
  return new AramoError('VALIDATION_ERROR', message, 422, { requestId, details });
}

export function toFieldView(f: {
  field_key: string;
  field_type: string;
  binding_key: string | null;
  signer_role: string | null;
  required: boolean;
  page_number: number | null;
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
  ordinal: number;
}): FixedFormFieldView {
  return {
    field_key: f.field_key,
    field_type: f.field_type,
    binding_key: f.binding_key,
    signer_role: f.signer_role,
    required: f.required,
    page_number: f.page_number,
    x: f.x,
    y: f.y,
    width: f.width,
    height: f.height,
    ordinal: f.ordinal,
  };
}

/** The roles of a stored fixed-form content (parsed; empty when invalid). */
export function fixedFormSigningOf(field_schema: unknown): FixedFormSigning | null {
  const fs = field_schema as { render_schema_version?: unknown; signing?: unknown } | null;
  if (fs === null || typeof fs !== 'object' || fs.render_schema_version !== FIXED_FORM_SCHEMA_V1) return null;
  const parsed = parseSigningConfig(fs.signing);
  if ('issue' in parsed) return null;
  return { roles: parsed.signing.roles, routing_mode: parsed.signing.routing_mode };
}

/** The stored fixed-form content, normalised (title + pdf + signing; null signing → none). */
export function fixedFormContentOf(field_schema: unknown, fallbackTitle: string): { content: FixedFormContent; signing_issue: string | null } {
  const fs = (field_schema ?? {}) as { title?: unknown; signing?: unknown; render_schema_version?: unknown };
  const title = typeof fs.title === 'string' && fs.title.trim().length > 0 ? fs.title.trim() : fallbackTitle;
  const parsed = fs.render_schema_version === FIXED_FORM_SCHEMA_V1 ? parseSigningConfig(fs.signing) : { issue: 'not_fixed_form_content' };
  const empty = emptyFixedFormContent(title);
  return {
    content: {
      render_schema_version: FIXED_FORM_SCHEMA_V1,
      title,
      pdf: fixedFormPdfOf(field_schema),
      signing: 'issue' in parsed ? empty.signing : { roles: parsed.signing.roles, routing_mode: parsed.signing.routing_mode },
    },
    signing_issue: 'issue' in parsed ? parsed.issue : null,
  };
}

// One placed field from a request body (shape only — the publish rules are fixedFormIssues).
export function parseFieldInput(raw: unknown, index: number, requestId: string): Omit<FixedFormField, 'ordinal'> & { ordinal: number } {
  const o = (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : null) as Record<string, unknown> | null;
  const at = (field: string, reason: string, message: string): AramoError => invalid(`field ${index + 1}: ${message}`, requestId, { reason, index, field });
  if (o === null) throw at('field', 'field_invalid', 'must be an object');
  for (const k of Object.keys(o)) {
    if (!['field_key', 'field_type', 'binding_key', 'signer_role', 'required', 'page_number', 'x', 'y', 'width', 'height', 'ordinal'].includes(k)) {
      throw at(k, 'field_unknown_member', `${k} is not a field property`);
    }
  }
  const field_key = typeof o['field_key'] === 'string' ? o['field_key'] : '';
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(field_key)) throw at('field_key', 'field_key_invalid', 'field_key must be lower_snake');
  if (!isFixedFormFieldType(o['field_type'])) throw at('field_type', 'field_type_invalid', 'field_type must be TEXT, SIGN_DATE, CHECKBOX, SIGNER_NAME, SIGNATURE or INITIALS');
  const text = (k: 'binding_key' | 'signer_role'): string | null => {
    const v = o[k];
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string' || v.length > 64) throw at(k, `${k}_invalid`, `${k} must be text`);
    return v;
  };
  const num = (k: 'page_number' | 'x' | 'y' | 'width' | 'height'): number => {
    const v = o[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw at(k, 'field_position_invalid', `${k} must be a number`);
    if (k === 'page_number' && (!Number.isInteger(v) || v < 0)) throw at(k, 'field_position_invalid', 'page_number must be a 0-based page index');
    return k === 'page_number' ? v : Math.round(v * 100) / 100;
  };
  const required = o['required'] === undefined ? true : o['required'];
  if (typeof required !== 'boolean') throw at('required', 'field_required_invalid', 'required must be true or false');
  const ordinal = o['ordinal'] === undefined ? index : o['ordinal'];
  if (typeof ordinal !== 'number' || !Number.isInteger(ordinal) || ordinal < 0) throw at('ordinal', 'field_ordinal_invalid', 'ordinal must be a non-negative integer');
  return {
    field_key,
    field_type: o['field_type'],
    binding_key: text('binding_key'),
    signer_role: text('signer_role'),
    required,
    page_number: num('page_number'),
    x: num('x'),
    y: num('y'),
    width: num('width'),
    height: num('height'),
    ordinal,
  };
}

export class FixedFormService {
  constructor(
    private readonly forms: FixedFormsRepository,
    private readonly templates: TemplatesRepository,
    private readonly variables: TemplateVariablesRepository,
    private readonly storage: DocumentStoragePort,
  ) {}

  // ── Shared ──────────────────────────────────────────────────────────────────

  /** §7.2 — the variables that may prefill a text field: active catalog rows sharing a product with the type. */
  async allowedVariables(document_type_id: string): Promise<FixedFormVariable[]> {
    const type = await this.templates.findDocumentTypeTemplateConfig(document_type_id);
    if (type === null) return [];
    const typeProducts = new Set(type.products.map((p) => p.toLowerCase()));
    return (await this.variables.listActive())
      .filter((v) => v.products.some((p) => typeProducts.has(p.toLowerCase())))
      .map((v) => ({ key: v.key, label: v.label, group: v.group_label, data_type: v.data_type, sample_value: v.sample_value }));
  }

  /** Read a stored fixed-form PDF and check it is the exact bytes recorded (sha256). */
  async readPdf(pdf: FixedFormPdfRef, requestId: string): Promise<Buffer> {
    const asset = await this.forms.findPlatformAsset(pdf.asset_id);
    if (asset === null || asset.sha256 !== pdf.sha256) {
      throw new AramoError('TEMPLATE_VERSION_NOT_FOUND', 'the form PDF is not available', 404, { requestId, details: { reason: 'pdf_missing' } });
    }
    const bytes = await this.storage.getArtifact({ storage_key: asset.storage_key, requestId, maxBytes: FIXED_FORM_MAX_BYTES });
    if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
      throw new AramoError('DOCUMENT_RENDER_FAILED', 'the stored form PDF does not match its record', 500, { requestId, details: { reason: 'pdf_integrity' } });
    }
    return bytes;
  }

  /** The publish problems of a version (empty = it may be previewed and published). */
  async issues(input: { document_type_id: string; field_schema: unknown; fields: readonly FixedFormFieldView[]; title: string }): Promise<FixedFormIssue[]> {
    const { content, signing_issue } = fixedFormContentOf(input.field_schema, input.title);
    const allowed = new Set((await this.allowedVariables(input.document_type_id)).map((v) => v.key));
    const out: FixedFormIssue[] = [];
    if (signing_issue !== null) out.push({ code: 'signing_invalid', message: `The signer roles are not valid (${signing_issue}).` });
    out.push(...fixedFormIssues({ pdf: content.pdf, roles: content.signing.roles, fields: input.fields, allowedBindingKeys: allowed }));
    return out;
  }

  // ── Platform authoring (§7.1, §7.2) ────────────────────────────────────────

  /** The PLATFORM template must be a default of a FIXED_FORM type (409 otherwise). */
  async assertFixedFormTemplate(template: { id: string; document_type_id: string }, requestId: string): Promise<void> {
    if (!(await this.forms.isFixedFormType(template.document_type_id))) {
      throw new AramoError('VALIDATION_ERROR', 'This template is not a fixed form: its document type is not a fixed-form type', 409, {
        requestId,
        details: { reason: 'not_a_fixed_form', template_id: template.id },
      });
    }
  }

  async platformVersion(version_id: string, requestId: string) {
    const out = await this.forms.getPlatformVersion(version_id);
    await this.assertFixedFormTemplate(out.template, requestId);
    return out;
  }

  async createDraft(template_id: string, actor: string, requestId: string) {
    const template = await this.forms.getPlatformTemplate(template_id);
    await this.assertFixedFormTemplate(template, requestId);
    return this.forms.createPlatformDraft({ template_id, created_by: actor, initial: emptyFixedFormContent(template.name) });
  }

  /** §7.1 — validate, store under the platform prefix, record the asset, point the draft at it. */
  async uploadPdf(input: { version_id: string; bytes: Uint8Array; actor: string; requestId: string }) {
    const { version, template } = await this.platformVersion(input.version_id, input.requestId);
    if (version.status !== 'DRAFT') {
      throw new AramoError('TEMPLATE_IMMUTABLE', `TemplateVersion ${version.id} is not a DRAFT`, 409, { requestId: input.requestId });
    }
    const accepted = await acceptFixedFormPdf(input.bytes, input.requestId);
    const storage_key = `${PLATFORM_TEMPLATE_ASSET_PREFIX}/${version.id}/${accepted.sha256}.pdf`;
    await this.storage.putArtifact({ storage_key, body: Buffer.from(input.bytes), content_type: 'application/pdf', requestId: input.requestId });
    const asset = await this.forms.createPlatformAsset({
      template_version_id: version.id,
      storage_key,
      sha256: accepted.sha256,
      byte_size: accepted.byte_size,
      page_count: accepted.page_count,
      created_by: input.actor,
    });
    const { content } = fixedFormContentOf(version.field_schema, template.name);
    const pdf: FixedFormPdfRef = { asset_id: asset.id, sha256: asset.sha256, byte_size: asset.byte_size, page_count: asset.page_count, pages: accepted.pages };
    return this.forms.writePlatformDraft({ version_id: version.id, field_schema: { ...content, pdf } });
  }

  /** §7.2 — replace the signer roles (+ title) and every placed field of a DRAFT in one write. */
  async saveLayout(input: { version_id: string; body: Record<string, unknown>; requestId: string }) {
    const { version, template } = await this.platformVersion(input.version_id, input.requestId);
    if (version.status !== 'DRAFT') {
      throw new AramoError('TEMPLATE_IMMUTABLE', `TemplateVersion ${version.id} is not a DRAFT`, 409, { requestId: input.requestId });
    }
    const { content } = fixedFormContentOf(version.field_schema, template.name);
    const body = input.body;
    let signing: FixedFormSigning = content.signing;
    if (body['signing'] !== undefined) {
      const raw = body['signing'] as { routing_mode?: unknown } | null;
      if (raw !== null && typeof raw === 'object' && !ROUTING.has(String(raw.routing_mode))) {
        throw invalid('routing_mode must be PARALLEL or SEQUENTIAL', input.requestId, { reason: 'signing_routing_mode_invalid' });
      }
      const parsed = parseSigningConfig(body['signing']);
      if ('issue' in parsed) throw invalid('The signer roles are not valid', input.requestId, { reason: parsed.issue, ...(parsed.index !== undefined ? { index: parsed.index } : {}) });
      signing = { roles: parsed.signing.roles as readonly FixedFormRole[], routing_mode: parsed.signing.routing_mode };
    }
    let title = content.title;
    if (body['title'] !== undefined) {
      const t = typeof body['title'] === 'string' ? body['title'].trim() : '';
      if (t.length === 0 || t.length > TITLE_MAX) throw invalid(`title must be 1-${TITLE_MAX} characters`, input.requestId, { reason: 'title_invalid' });
      title = t;
    }
    let fields: ReturnType<typeof parseFieldInput>[] | undefined;
    if (body['fields'] !== undefined) {
      if (!Array.isArray(body['fields'])) throw invalid('fields must be an array', input.requestId, { reason: 'fields_invalid' });
      if (body['fields'].length > 200) throw invalid('at most 200 fields', input.requestId, { reason: 'too_many_fields' });
      fields = body['fields'].map((f, i) => parseFieldInput(f, i, input.requestId));
      const keys = new Set<string>();
      for (const [index, f] of fields.entries()) {
        if (keys.has(f.field_key)) throw invalid(`${f.field_key} is placed twice`, input.requestId, { reason: 'field_key_duplicate', index });
        keys.add(f.field_key);
      }
    }
    return this.forms.writePlatformDraft({
      version_id: version.id,
      field_schema: { ...content, title, signing },
      ...(fields !== undefined ? { fields } : {}),
    });
  }

  /** §7.2 — add one field (mirrors the tenant POST versions/:versionId/fields). */
  async addField(input: { version_id: string; body: unknown; requestId: string }) {
    const { version } = await this.platformVersion(input.version_id, input.requestId);
    if (version.status !== 'DRAFT') {
      throw new AramoError('TEMPLATE_IMMUTABLE', `TemplateVersion ${version.id} is not a DRAFT`, 409, { requestId: input.requestId });
    }
    const existing = await this.forms.listFields(version.id);
    const field = parseFieldInput(input.body, existing.length, input.requestId);
    if (existing.some((f) => f.field_key === field.field_key)) {
      throw invalid(`${field.field_key} is already placed`, input.requestId, { reason: 'field_key_duplicate' });
    }
    if (existing.length >= 200) throw invalid('at most 200 fields', input.requestId, { reason: 'too_many_fields' });
    return this.forms.addPlatformDraftField({ version_id: version.id, field });
  }

  /** The Studio's view of a version: content, fields, variables and the publish problems. */
  async platformView(version_id: string, requestId: string) {
    const { version, template } = await this.platformVersion(version_id, requestId);
    const fields = (await this.forms.listFields(version.id)).map(toFieldView);
    const { content } = fixedFormContentOf(version.field_schema, template.name);
    return {
      template_id: template.id,
      version_id: version.id,
      version_number: version.version_number,
      status: version.status,
      content,
      fields,
      variables: await this.allowedVariables(template.document_type_id),
      issues: await this.issues({ document_type_id: template.document_type_id, field_schema: version.field_schema, fields, title: template.name }),
      previewed: version.previewed_fingerprint !== null && version.previewed_fingerprint === version.content_fingerprint,
    };
  }

  /**
   * §7.2 — the fixed-form preview: refused (422 details.reason=fixed_form_incomplete with the
   * issues) while anything blocks publishing; otherwise the §18 preview is recorded for exactly
   * this content and these fields, so the shared publish route may activate it.
   */
  async preview(version_id: string, requestId: string) {
    const view = await this.platformView(version_id, requestId);
    if (view.status !== 'DRAFT') {
      throw new AramoError('TEMPLATE_IMMUTABLE', `TemplateVersion ${version_id} is not a DRAFT`, 409, { requestId });
    }
    if (view.issues.length > 0) {
      throw invalid('This form is not ready to publish', requestId, { reason: 'fixed_form_incomplete', issues: view.issues });
    }
    await this.templates.recordPlatformPreview(version_id);
    return { ...view, previewed: true };
  }
}
