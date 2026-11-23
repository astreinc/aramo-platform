import { AramoError } from '@aramo/common';
import { PdfFormImportError, extractTextLayer, importPdfForm, readPageFrames, removeAndCoverTextTags } from '@aramo/documents-rendering';
import { matchTagRole, planPdfFormFields, planTextTags, tagTextNotRemovedWarnings, type FieldImportWarning, type FieldOptions, type ImportedField } from '@aramo/sign-fields';

// FIELD-PARITY-1 (Aramo-Sign-Field-Placement-Enterprise-Parity-Directive-v1_0-LOCKED) §5 P2-5 /
// P2-6 — the Sign envelope document upload's opt-in field import (POST
// envelopes/{id}/documents with `import_fields` / `apply_text_tags`). Both default OFF: without
// them the upload is exactly what it was (same bytes stored, same response).
//
//   import_fields    the PDF's form fields become envelope fields (the catalog mapping,
//                    @aramo/sign-fields planPdfFormFields), the form's active content is
//                    stripped and the form flattened BEFORE the safe-upload gate decides
//                    (@aramo/documents-rendering importPdfForm). An XFA-only form is refused.
//   apply_text_tags  {{type:role…}} tags in the text layer become fields sized to the tag; each
//                    tag's text is removed from the page and covered with white (FIELD-PARITY-2
//                    A-6, ruling C-8; a tag whose text cannot be removed is only covered and
//                    reported as text_tag_text_not_removed). Read on the gated bytes; the
//                    changed PDF passes the gate again.
//
// Binding: an envelope field always belongs to a recipient (the sender API rule). A tag's role
// is matched case-insensitively to a signing recipient's name, email or template role; a form
// field, a tag without a role and a tag whose role matches nobody go to the FIRST signing
// recipient (named warnings). With fields to create and no signing recipient, the upload is
// refused before anything is stored (field_import_needs_recipient).

export const UPLOAD_SURFACE = 'send_web' as const;

export interface UploadImportOptions {
  readonly import_fields: boolean;
  readonly apply_text_tags: boolean;
}

export function uploadImportOptions(body: { import_fields?: unknown; apply_text_tags?: unknown } | undefined, requestId: string): UploadImportOptions {
  const flag = (k: 'import_fields' | 'apply_text_tags'): boolean => {
    const v = body?.[k];
    if (v === undefined || v === null) return false;
    if (typeof v !== 'boolean') {
      throw new AramoError('VALIDATION_ERROR', `${k} must be true or false`, 400, { requestId, details: { reason: 'import_flag_invalid', field: k } });
    }
    return v;
  };
  return { import_fields: flag('import_fields'), apply_text_tags: flag('apply_text_tags') };
}

export interface UploadFieldImport {
  readonly bytes: Uint8Array;
  readonly fields: ImportedField[];
  readonly warnings: FieldImportWarning[];
  readonly stripped: string[];
}

/**
 * Runs the opted-in import around the safe-upload gate. `accept` is the host's gate (it throws
 * to refuse); it runs on the stripped bytes and again after covering tags.
 */
export async function importUploadFields(
  bytes: Uint8Array,
  opts: UploadImportOptions,
  groupKeysTaken: Set<string>,
  accept: (b: Uint8Array) => Promise<Uint8Array>,
  requestId: string,
): Promise<UploadFieldImport> {
  let work = bytes;
  const fields: ImportedField[] = [];
  const warnings: FieldImportWarning[] = [];
  let stripped: string[] = [];
  if (opts.import_fields) {
    try {
      const form = await importPdfForm(work);
      work = form.bytes;
      stripped = form.stripped;
      const plan = planPdfFormFields(form.widgets, form.pages, UPLOAD_SURFACE, groupKeysTaken);
      fields.push(...plan.fields);
      warnings.push(...plan.warnings);
    } catch (e) {
      if (e instanceof PdfFormImportError) {
        throw new AramoError('VALIDATION_ERROR', e.message, 400, { requestId, details: { reason: e.reason } });
      }
      throw e;
    }
  }
  work = await accept(work);
  if (opts.apply_text_tags) {
    let pages: Awaited<ReturnType<typeof extractTextLayer>> | null = null;
    try {
      pages = await extractTextLayer(work);
    } catch {
      warnings.push({ code: 'text_tags_unreadable', message: 'The text of this PDF could not be read, so no tags were found.' });
    }
    if (pages !== null) {
      const plan = planTextTags(pages, await readPageFrames(work), UPLOAD_SURFACE);
      fields.push(...plan.fields);
      warnings.push(...plan.warnings);
      if (plan.covers.length > 0) {
        const removed = await removeAndCoverTextTags(work, plan.covers);
        warnings.push(...tagTextNotRemovedWarnings(plan.covers, removed.not_removed));
        work = await accept(removed.bytes);
      }
    }
  }
  return { bytes: work, fields, warnings, stripped };
}

export interface UploadRecipient {
  readonly id: string;
  readonly name: string;
  readonly email: string | null;
  readonly signer_role: string | null;
}

/** The envelope field rows (recipient bound) of the imported fields, with the binding warnings. */
export function bindImportedFields(
  fields: readonly ImportedField[],
  recipients: readonly UploadRecipient[],
  requestId: string,
): { rows: BoundImportedField[]; warnings: FieldImportWarning[] } {
  const warnings: FieldImportWarning[] = [];
  if (fields.length === 0) return { rows: [], warnings };
  const first = recipients[0];
  if (first === undefined) {
    throw new AramoError('VALIDATION_ERROR', 'Add a recipient who signs before importing fields from this document.', 422, {
      requestId,
      details: { reason: 'field_import_needs_recipient' },
    });
  }
  const options = recipients.map((r) => ({ id: r.id, names: [r.name, r.email, r.signer_role] }));
  let toFirst = 0;
  const rows = fields.map((f): BoundImportedField => {
    let signer_id = f.role === null ? null : matchTagRole(f.role, options);
    if (f.role !== null && signer_id === null) {
      warnings.push({ code: 'text_tag_role_unknown', message: `{{${f.name}}}: no recipient is "${f.role}"; the field goes to ${first.name}.`, name: f.name, page_number: f.page_number });
    }
    if (signer_id === null) {
      signer_id = first.id;
      toFirst += 1;
    }
    return {
      source: f.source,
      name: f.name,
      signer_id,
      field_type: f.field_type,
      page_number: f.page_number,
      x: f.x,
      y: f.y,
      width: f.width,
      height: f.height,
      required: f.required,
      label: f.label,
      group_key: f.group_key,
      group_rule: f.group_rule,
      min_selected: null,
      // M-A6 §2.2 — the sender default for a name field.
      name_mode: f.field_type === 'SIGNER_NAME' ? 'SIGNER_PROFILE' : null,
      // FIELD-PARITY-2 A-5 — a PDF dropdown's choices (DROPDOWN only).
      options: f.options,
    };
  });
  if (toFirst > 0) {
    warnings.push({ code: 'field_assigned_to_first_recipient', message: `${toFirst} imported field${toFirst === 1 ? '' : 's'} went to ${first.name}; reassign them in the editor.` });
  }
  // A radio group's boxes share one recipient (Sign's check-box group rule): form fields have
  // no role, so they all went to the first recipient above.
  return { rows, warnings };
}

export interface BoundImportedField {
  readonly source: ImportedField['source'];
  readonly name: string;
  readonly signer_id: string;
  readonly field_type: string;
  readonly page_number: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly required: boolean;
  readonly label: string | null;
  readonly group_key: string | null;
  readonly group_rule: string | null;
  readonly min_selected: number | null;
  readonly name_mode: string | null;
  /** FIELD-PARITY-2 A-5 — DROPDOWN: { choices } from the PDF; null otherwise. */
  readonly options: FieldOptions | null;
}

/** The stored row of a bound field (the repository's field input; no import metadata). */
export function fieldRowOf(f: BoundImportedField): Omit<BoundImportedField, 'source' | 'name' | 'options'> & { readonly options: Readonly<Record<string, unknown>> | null } {
  return {
    signer_id: f.signer_id,
    field_type: f.field_type,
    page_number: f.page_number,
    x: f.x,
    y: f.y,
    width: f.width,
    height: f.height,
    required: f.required,
    label: f.label,
    group_key: f.group_key,
    group_rule: f.group_rule,
    min_selected: f.min_selected,
    name_mode: f.name_mode,
    options: f.options === null ? null : { ...f.options },
  };
}
