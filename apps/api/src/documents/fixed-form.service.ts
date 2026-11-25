import { createHash } from 'node:crypto';

import { AramoError } from '@aramo/common';
import { extractPageGraphics, extractTextLayer, readPageFrames } from '@aramo/documents-rendering';
import {
  TEMPLATE_FIELD_SETTINGS,
  detectFields,
  fieldTypesFor,
  importFieldKey,
  matchTagRole,
  parseTemplateFieldSettings,
  senderFilledFieldsEnabled,
  type DetectResult,
  type FieldCondition,
  type FieldOptions,
  type FieldImportWarning,
} from '@aramo/sign-fields';
import {
  FIXED_FORM_MAX_BYTES,
  FIXED_FORM_MAX_FIELDS,
  FIXED_FORM_SCHEMA_V1,
  PLATFORM_TEMPLATE_ASSET_PREFIX,
  FixedFormsRepository,
  TemplatesRepository,
  TemplateVariablesRepository,
  emptyFixedFormContent,
  fixedFormIssues,
  fixedFormConditionIssues,
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

import { prepareFixedFormPdf, type FixedFormImportOptions } from './fixed-form-pdf.js';

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
  // FIELD-PARITY-1 P1-3 — the Sign field settings (NULL = not set).
  readonly label: string | null;
  readonly group_key: string | null;
  readonly group_rule: string | null;
  readonly min_selected: number | null;
  readonly name_mode: string | null;
  // FIELD-PARITY-1 P3 §6.2 — the other settings (NULL / false = not set).
  readonly tooltip: string | null;
  readonly placeholder: string | null;
  readonly read_only: boolean;
  readonly sender_filled: boolean;
  readonly validation: string | null;
  readonly font_size: number | null;
  readonly data_name: string | null;
  readonly options: FieldOptions | null;
  // FIELD-PARITY-2 B-2 — "show only when" (NULL = always shown).
  readonly condition: FieldCondition | null;
}

/** FIELD-PARITY-1 P2-5 / P2-6 — what an opted-in upload imported (absent without a flag). */
export interface FixedFormFieldImport {
  readonly fields: Array<FixedFormFieldView & { readonly source: 'pdf_form' | 'text_tag'; readonly source_name: string }>;
  readonly warnings: FieldImportWarning[];
  readonly stripped: string[];
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
  label?: string | null;
  group_key?: string | null;
  group_rule?: string | null;
  min_selected?: number | null;
  name_mode?: string | null;
  tooltip?: string | null;
  placeholder?: string | null;
  read_only?: boolean;
  sender_filled?: boolean;
  validation?: string | null;
  font_size?: number | null;
  data_name?: string | null;
  options?: unknown;
  condition?: unknown;
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
    label: f.label ?? null,
    group_key: f.group_key ?? null,
    group_rule: f.group_rule ?? null,
    min_selected: f.min_selected ?? null,
    name_mode: f.name_mode ?? null,
    tooltip: f.tooltip ?? null,
    placeholder: f.placeholder ?? null,
    read_only: f.read_only === true,
    sender_filled: f.sender_filled === true,
    validation: f.validation ?? null,
    font_size: f.font_size ?? null,
    data_name: f.data_name ?? null,
    options: (f.options ?? null) as FieldOptions | null,
    condition: (f.condition ?? null) as FieldCondition | null,
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

const FIXED_FORM_TYPE_LIST = fieldTypesFor('template_fixed_form').join(', ');

// One placed field from a request body (shape only — the publish rules are fixedFormIssues).
const FIELD_MEMBERS: readonly string[] = [
  'field_key',
  'field_type',
  'binding_key',
  'signer_role',
  'required',
  'page_number',
  'x',
  'y',
  'width',
  'height',
  'ordinal',
  // FIELD-PARITY-1 P1-3 — the Sign field settings.
  ...TEMPLATE_FIELD_SETTINGS,
];

export function parseFieldInput(raw: unknown, index: number, requestId: string): Omit<FixedFormField, 'ordinal'> & { ordinal: number } {
  const o = (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : null) as Record<string, unknown> | null;
  const at = (field: string, reason: string, message: string): AramoError => invalid(`field ${index + 1}: ${message}`, requestId, { reason, index, field });
  if (o === null) throw at('field', 'field_invalid', 'must be an object');
  for (const k of Object.keys(o)) {
    if (!FIELD_MEMBERS.includes(k)) {
      throw at(k, 'field_unknown_member', `${k} is not a field property`);
    }
  }
  const field_key = typeof o['field_key'] === 'string' ? o['field_key'] : '';
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(field_key)) throw at('field_key', 'field_key_invalid', 'field_key must be lower_snake');
  // FIELD-PARITY-1 P3 — the message names the catalog's template_fixed_form projection.
  if (!isFixedFormFieldType(o['field_type'])) throw at('field_type', 'field_type_invalid', `field_type must be one of ${FIXED_FORM_TYPE_LIST}`);
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
  // FIELD-PARITY-1 P1-3 / P3 — the settings the type takes (the catalog), by Sign's rules; one
  // the type does not take is refused (field_config_not_applicable), never dropped. A
  // sender-filled field is refused while SIGN_SENDER_FILLED_FIELDS_ENABLED is off (R-3, dark).
  const parsed = parseTemplateFieldSettings(o, o['field_type'], { sender_filled_enabled: senderFilledFieldsEnabled(process.env) });
  if (!parsed.ok) throw at(parsed.refusal.setting, parsed.refusal.reason, parsed.refusal.message);
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
    ...parsed.settings,
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

  /**
   * §7.1 — validate, store under the platform prefix, record the asset, point the draft at it.
   * FIELD-PARITY-1 P2-5 / P2-6 — with `import_fields` / `apply_text_tags` (default false) the
   * stored PDF is the stripped / flattened / tag-covered one and the found fields are added
   * to the draft's fields (prepareFixedFormPdf). A form field has no signer role (the author
   * assigns it in the Studio); a tag's role is matched case-insensitively to a role key or
   * label, and left unassigned (warning) when none matches.
   */
  async uploadPdf(input: { version_id: string; bytes: Uint8Array; actor: string; requestId: string; import?: FixedFormImportOptions }): Promise<{ field_import: FixedFormFieldImport | null }> {
    const { version, template } = await this.platformVersion(input.version_id, input.requestId);
    if (version.status !== 'DRAFT') {
      throw new AramoError('TEMPLATE_IMMUTABLE', `TemplateVersion ${version.id} is not a DRAFT`, 409, { requestId: input.requestId });
    }
    const opts: FixedFormImportOptions = input.import ?? { import_fields: false, apply_text_tags: false };
    const importing = opts.import_fields || opts.apply_text_tags;
    const existing = importing ? (await this.forms.listFields(version.id)).map(toFieldView) : [];
    const prepared = await prepareFixedFormPdf(input.bytes, opts, new Set(existing.flatMap((f) => (f.group_key === null ? [] : [f.group_key]))), input.requestId);
    const accepted = prepared.accepted;
    const storage_key = `${PLATFORM_TEMPLATE_ASSET_PREFIX}/${version.id}/${accepted.sha256}.pdf`;
    await this.storage.putArtifact({ storage_key, body: Buffer.from(prepared.bytes), content_type: 'application/pdf', requestId: input.requestId });
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
    if (!importing) {
      await this.forms.writePlatformDraft({ version_id: version.id, field_schema: { ...content, pdf } });
      return { field_import: null };
    }
    const warnings: FieldImportWarning[] = [...prepared.warnings];
    const room = Math.max(0, FIXED_FORM_MAX_FIELDS - existing.length);
    if (prepared.fields.length > room) {
      warnings.push({ code: 'too_many_fields', message: `A form holds at most ${FIXED_FORM_MAX_FIELDS} fields; ${prepared.fields.length - room} found fields were not added.` });
    }
    const roles = content.signing.roles.filter((r) => r.kind === 'SIGNER').map((r) => ({ id: r.role_key, names: [r.role_key, r.label] }));
    const keys = new Set(existing.map((f) => f.field_key));
    const created = prepared.fields.slice(0, room).map((f, i) => {
      const signer_role = f.role === null ? null : matchTagRole(f.role, roles);
      if (f.role !== null && signer_role === null) {
        warnings.push({ code: 'text_tag_role_unknown', message: `{{${f.name}}}: no signer role is "${f.role}"; the field has no role yet.`, name: f.name, page_number: f.page_number });
      }
      const view: FixedFormFieldView = toFieldView({
        field_key: importFieldKey(f.name, keys),
        field_type: f.field_type,
        binding_key: null,
        signer_role,
        required: f.required,
        page_number: f.page_number,
        x: f.x,
        y: f.y,
        width: f.width,
        height: f.height,
        ordinal: existing.length + i,
        label: f.label,
        group_key: f.group_key,
        group_rule: f.group_rule,
        min_selected: null,
        name_mode: null,
        // FIELD-PARITY-2 A-5 — a PDF dropdown's choices (DROPDOWN only; null otherwise).
        options: f.options,
      });
      return { view, source: f.source, source_name: f.name };
    });
    await this.forms.writePlatformDraft({ version_id: version.id, field_schema: { ...content, pdf }, fields: [...existing, ...created.map((c) => c.view)] });
    return {
      field_import: {
        fields: created.map((c) => ({ ...c.view, source: c.source, source_name: c.source_name })),
        warnings,
        stripped: prepared.stripped,
      },
    };
  }

  /**
   * FIELD-PARITY-1 §5 P2-4 — the Studio's "Suggest fields": the shared deterministic detector
   * (@aramo/sign-fields detectFields, the same one Sign's envelope route runs) over the stored
   * PDF's text layer, page frames and drawn rectangles, limited to the fixed-form palette (a
   * "Title:" label becomes TEXT here). No model, no network, no text logged. The version must be
   * a fixed form (404 / 409 as the other routes); after that, a version without a PDF, or any
   * failure reading it, is an empty answer (the feature is a convenience).
   */
  async fieldSuggestions(version_id: string, requestId: string): Promise<DetectResult> {
    const { version, template } = await this.platformVersion(version_id, requestId);
    const { content } = fixedFormContentOf(version.field_schema, template.name);
    const none: DetectResult = { suggestions: [], skipped_pages: [] };
    if (content.pdf === null) return none;
    try {
      const bytes = new Uint8Array(await this.readPdf(content.pdf, requestId));
      const [pages, frames, graphics] = await Promise.all([extractTextLayer(bytes), readPageFrames(bytes), extractPageGraphics(bytes).catch(() => [])]);
      return detectFields(pages, frames, { graphics, types: fieldTypesFor('template_fixed_form') });
    } catch {
      return none;
    }
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
      // FIELD-PARITY-2 B-3 — the one cross-field condition rule over the whole list (C-6 too:
      // a fixed form's signatures are all placed fields).
      const [issue] = fixedFormConditionIssues(fields);
      if (issue !== undefined) throw invalid(`field ${issue.index + 1}: ${issue.message}`, input.requestId, { reason: issue.reason, index: issue.index, field: 'condition' });
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
    // FIELD-PARITY-2 B-3 — the cross-field condition rule with the new field (one field at a time:
    // the unconditional-SIGNATURE rule is a publish issue, role_without_signature).
    if (field.condition !== null && field.condition !== undefined) {
      const [issue] = fixedFormConditionIssues([...existing, field], { requireUnconditionalSignature: false });
      if (issue !== undefined) throw invalid(issue.message, input.requestId, { reason: issue.reason, field: 'condition' });
    }
    return this.forms.addPlatformDraftField({ version_id: version.id, field });
  }

  /** The Studio's view of a version: content, fields, variables and the publish problems. */
  // TEMPLATE-FIELDS-1 F-14 — GET …/versions/:id/fields for ANY platform version: a fixed form's
  // placed fields, or an editable template's inline field rows (NULL geometry: positions are
  // computed per render). The same field view either way.
  async platformFields(version_id: string, requestId: string) {
    const out = await this.forms.getPlatformVersion(version_id);
    if (await this.forms.isFixedFormType(out.template.document_type_id)) return (await this.platformView(version_id, requestId)).fields;
    return (await this.forms.listFields(out.version.id)).map(toFieldView);
  }

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
      // FIELD-PARITY-2 A-4 (ruling C-9) — whether sender-filled fields are switched on (S-5, dark;
      // the one shared flag reader, @aramo/sign-fields senderFilledFieldsEnabled). The Studio offers
      // Sender-filled and Read-only only when this is true.
      sender_filled_fields_enabled: senderFilledFieldsEnabled(process.env),
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
