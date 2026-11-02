import { createHash } from 'node:crypto';

import { AramoError } from '@aramo/common';
import { FIXED_FORM_MAX_BYTES, type FixedFormPage } from '@aramo/documents';
import { SafePdfPipeline, UnsafePdfError } from '@aramo/documents-rendering';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFStream, StandardFonts, rgb, type PDFObject } from 'pdf-lib';

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

function refuse(reason: 'pdf_too_large' | 'pdf_unsafe' | 'pdf_invalid', message: string, requestId: string): AramoError {
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

export interface FixedFormStamp {
  readonly page_number: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly text: string;
}

// Helvetica (WinAnsi) cannot encode every character: anything outside printable Latin-1 is
// printed as "?" so a value never breaks the freeze.
function winAnsi(text: string): string {
  return text.replace(/[\r\n\t]+/g, ' ').replace(/[^\x20-\x7e\xa0-\xff]/g, '?');
}

/**
 * §7.4 — print the prefilled values (variables of TEXT fields) on the official PDF. One line
 * per box, Helvetica, sized to the box height, truncated to the box width. With no stamp
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
    const size = Math.max(6, Math.min(11, s.height * 0.7));
    let text = winAnsi(s.text);
    const maxWidth = Math.max(0, s.width - 4);
    while (text.length > 0 && font.widthOfTextAtSize(text, size) > maxWidth) text = text.slice(0, -1);
    if (text.length === 0) continue;
    page.drawText(text, { x: s.x + 2, y: s.y + (s.height - size) / 2 + size * 0.2, size, font, color: rgb(0, 0, 0) });
  }
  return doc.save({ useObjectStreams: false });
}
