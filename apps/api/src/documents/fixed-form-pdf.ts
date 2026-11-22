import { createHash } from 'node:crypto';

import { AramoError } from '@aramo/common';
import { FIXED_FORM_MAX_BYTES, type FixedFormPage } from '@aramo/documents';
import {
  PdfFormImportError,
  SafePdfPipeline,
  UnsafePdfError,
  coverPdfBoxes,
  extractTextLayer,
  importPdfForm,
  readPageFrames,
  stampTextInBox,
} from '@aramo/documents-rendering';
import { planPdfFormFields, planTextTags, type FieldImportWarning, type ImportedField } from '@aramo/sign-fields';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFStream, StandardFonts, type PDFObject } from 'pdf-lib';

// TEMPLATE-PRODUCT-1 (Implementation Directive v1.0 LOCKED) §7.1 — the gate an official PDF
// passes before it is stored as a PlatformTemplateAsset: PDF only, at most 10 MB, it must
// parse, and it carries no active content.
//
//   1. The size limit of a fixed form (10 MB — tighter than the generic 25 MiB pipeline).
//   2. The governed SafePdfPipeline (DOC-2 R27): %PDF- magic, encrypted PDFs refused, the
//      active-content NAME tokens refused in the raw bytes, structural parse, page bound.
//   3. A deep scan of every parsed object (pdf-lib also decodes compressed object streams,
//      which the raw byte scan cannot see): the same active-content keys plus form actions
//      (XFA, SubmitForm, ImportData, remote go-to, media) are refused.
// Refusals are 422 VALIDATION_ERROR with a stable details.reason (pdf_too_large,
// pdf_unsafe, pdf_invalid).

const ACTIVE_KEYS = new Set([
  'JS',
  'JavaScript',
  'Launch',
  'OpenAction',
  'AA',
  'EmbeddedFile',
  'EmbeddedFiles',
  'RichMedia',
  'XFA',
]);
const ACTIVE_ACTIONS = new Set(['JavaScript', 'Launch', 'SubmitForm', 'ImportData', 'GoToR', 'GoToE', 'Rendition', 'Sound', 'Movie', 'RichMediaExecute']);
const MAX_DEPTH = 24;

export interface AcceptedFixedFormPdf {
  readonly sha256: string;
  readonly byte_size: number;
  readonly page_count: number;
  readonly pages: readonly FixedFormPage[];
}

function refuse(reason: 'pdf_too_large' | 'pdf_unsafe' | 'pdf_invalid' | 'xfa_only_form', message: string, requestId: string): AramoError {
  return new AramoError('VALIDATION_ERROR', message, 422, { requestId, details: { reason } });
}

const nameOf = (n: PDFName): string => n.asString().replace(/^\//, '');

// The first active-content key or action found in an object graph (null when none).
function activeIn(obj: PDFObject | undefined, depth: number, seen: Set<PDFObject>): string | null {
  if (obj === undefined || depth > MAX_DEPTH || seen.has(obj)) return null;
  seen.add(obj);
  const dict = obj instanceof PDFStream ? obj.dict : obj instanceof PDFDict ? obj : null;
  if (dict !== null) {
    for (const [key, value] of dict.entries()) {
      const k = nameOf(key);
      if (ACTIVE_KEYS.has(k)) return `/${k}`;
      if (k === 'S' && value instanceof PDFName && ACTIVE_ACTIONS.has(nameOf(value))) return `/${nameOf(value)}`;
      const inner = activeIn(value, depth + 1, seen);
      if (inner !== null) return inner;
    }
    return null;
  }
  if (obj instanceof PDFArray) {
    for (let i = 0; i < obj.size(); i += 1) {
      const inner = activeIn(obj.get(i), depth + 1, seen);
      if (inner !== null) return inner;
    }
  }
  return null;
}

/** §7.1 — accept an official PDF or refuse it (422 VALIDATION_ERROR, details.reason). */
export async function acceptFixedFormPdf(bytes: Uint8Array, requestId: string): Promise<AcceptedFixedFormPdf> {
  if (bytes.byteLength === 0) throw refuse('pdf_invalid', 'The file is empty.', requestId);
  if (bytes.byteLength > FIXED_FORM_MAX_BYTES) throw refuse('pdf_too_large', 'The PDF is larger than 10 MB.', requestId);
  try {
    await new SafePdfPipeline().accept(bytes);
  } catch (e) {
    if (e instanceof UnsafePdfError) {
      const reason = /active content|encrypted/i.test(e.reason) ? 'pdf_unsafe' : 'pdf_invalid';
      throw refuse(reason, `This PDF can't be used: ${e.reason}`, requestId);
    }
    throw e;
  }
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    throw refuse('pdf_invalid', `This PDF can't be read: ${e instanceof Error ? e.message : String(e)}`, requestId);
  }
  const seen = new Set<PDFObject>();
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const found = activeIn(obj, 0, seen);
    if (found !== null) throw refuse('pdf_unsafe', `This PDF can't be used: active content not allowed: ${found}`, requestId);
  }
  const trailerActive = activeIn(doc.catalog, 0, new Set());
  if (trailerActive !== null) throw refuse('pdf_unsafe', `This PDF can't be used: active content not allowed: ${trailerActive}`, requestId);
  const pages = doc.getPages().map((p) => ({ width: p.getWidth(), height: p.getHeight() }));
  if (pages.length === 0) throw refuse('pdf_invalid', 'The PDF has no pages.', requestId);
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byte_size: bytes.byteLength,
    page_count: pages.length,
    pages,
  };
}

/** FIELD-PARITY-1 P2-5 / P2-6 — the upload's opt-in field import (both default false). */
export interface FixedFormImportOptions {
  readonly import_fields: boolean;
  readonly apply_text_tags: boolean;
}

export interface PreparedFixedFormPdf {
  /** The bytes to store: the upload itself, or the stripped / flattened / tag-covered PDF. */
  readonly bytes: Uint8Array;
  readonly accepted: AcceptedFixedFormPdf;
  readonly fields: ImportedField[];
  readonly warnings: FieldImportWarning[];
  /** The active-content keys the import removed. */
  readonly stripped: string[];
}

/**
 * FIELD-PARITY-1 (Aramo-Sign-Field-Placement-Enterprise-Parity-Directive-v1_0-LOCKED) §5 —
 * the §7.1 gate with the opt-in import around it:
 *   import_fields    P2-5: the PDF's form fields are read, the form's active content is
 *                    stripped and the form flattened (@aramo/documents-rendering importPdfForm)
 *                    BEFORE the gate decides; the fields map to the `template_fixed_form`
 *                    catalog types (@aramo/sign-fields planPdfFormFields). An XFA-only form
 *                    is refused (422 details.reason xfa_only_form).
 *   apply_text_tags  P2-6: {{type:role…}} tags on the gated PDF become fields and are covered
 *                    with white (ruling R-5); the covered PDF passes the gate again.
 * With both false this is acceptFixedFormPdf on the upload, unchanged.
 */
export async function prepareFixedFormPdf(bytes: Uint8Array, opts: FixedFormImportOptions, groupKeysTaken: Set<string>, requestId: string): Promise<PreparedFixedFormPdf> {
  if (!opts.import_fields && !opts.apply_text_tags) {
    return { bytes, accepted: await acceptFixedFormPdf(bytes, requestId), fields: [], warnings: [], stripped: [] };
  }
  // The size limit first: nothing larger than a fixed form is parsed.
  if (bytes.byteLength === 0) throw refuse('pdf_invalid', 'The file is empty.', requestId);
  if (bytes.byteLength > FIXED_FORM_MAX_BYTES) throw refuse('pdf_too_large', 'The PDF is larger than 10 MB.', requestId);
  let work = bytes;
  const fields: ImportedField[] = [];
  const warnings: FieldImportWarning[] = [];
  let stripped: string[] = [];
  if (opts.import_fields) {
    try {
      const form = await importPdfForm(work);
      work = form.bytes;
      stripped = form.stripped;
      const plan = planPdfFormFields(form.widgets, form.pages, 'template_fixed_form', groupKeysTaken);
      fields.push(...plan.fields);
      warnings.push(...plan.warnings);
    } catch (e) {
      if (e instanceof PdfFormImportError) throw refuse('xfa_only_form', e.message, requestId);
      throw e;
    }
  }
  let accepted = await acceptFixedFormPdf(work, requestId);
  if (opts.apply_text_tags) {
    let pages: Awaited<ReturnType<typeof extractTextLayer>> | null = null;
    try {
      pages = await extractTextLayer(work);
    } catch {
      warnings.push({ code: 'text_tags_unreadable', message: 'The text of this PDF could not be read, so no tags were found.' });
    }
    if (pages !== null) {
      const plan = planTextTags(pages, await readPageFrames(work), 'template_fixed_form');
      fields.push(...plan.fields);
      warnings.push(...plan.warnings);
      if (plan.covers.length > 0) {
        work = await coverPdfBoxes(work, plan.covers);
        accepted = await acceptFixedFormPdf(work, requestId);
      }
    }
  }
  return { bytes: work, accepted, fields, warnings, stripped };
}

export interface FixedFormStamp {
  readonly page_number: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly text: string;
}

/**
 * §7.4 — print the prefilled values (variables of TEXT fields) on the official PDF with the
 * shared text-in-box stamper (FIELD-PARITY-1 P0-2, the same one the executed PDF uses):
 * WinAnsi replacement, wrap to the box width, shrink 11pt → 7pt, then clip. With no stamp
 * the bytes are returned unchanged (the stored PDF is the document).
 */
export async function stampFixedFormValues(bytes: Uint8Array, stamps: readonly FixedFormStamp[]): Promise<Uint8Array> {
  if (stamps.length === 0) return bytes;
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  for (const s of stamps) {
    const page = pages[s.page_number];
    if (page === undefined) continue;
    stampTextInBox(page, font, { x: s.x, y: s.y, width: s.width, height: s.height }, s.text);
  }
  return doc.save({ useObjectStreams: false });
}
