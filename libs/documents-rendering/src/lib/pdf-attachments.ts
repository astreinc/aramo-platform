import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, PDFStream, type PDFContext, type PDFObject } from 'pdf-lib';

import { UnsafePdfError } from './errors.js';
import { dropUnreachable } from './pdf-form-import.js';

// PDF-ATTACH-1 (Aramo-PDF-Attachment-Strip-1-Directive-v1_0-LOCKED) — the one rule for files
// attached to a PDF. An attached file is never part of what a signer sees, so it is removed at
// upload (ATT-2) instead of the whole PDF being refused; the gate then refuses any attachment
// still present as pdf_problem 'attachments' (ATT-5), never 'scripts'.
//
// ATT-1 — an attached file is any of:
//   - the catalog's /Names /EmbeddedFiles name tree;
//   - /AF (associated files: an array of file specifications) on the catalog, a page, an
//     annotation or any other object;
//   - a /FileAttachment annotation;
//   - /Collection (a portfolio) in the catalog;
//   - an embedded-file stream (/Type /EmbeddedFile) or a file specification's /EF entry.
// Only the parsed object graph decides (pdf-lib also expands compressed object streams), so a
// name tree inside an object stream or an untyped embedded-file stream is still found.

const N = (s: string): PDFName => PDFName.of(s);

function resolve(ctx: PDFContext, o: PDFObject | undefined): PDFObject | undefined {
  return o instanceof PDFRef ? ctx.lookup(o) : o;
}

function dictOf(ctx: PDFContext, o: PDFObject | undefined): PDFDict | undefined {
  const v = resolve(ctx, o);
  return v instanceof PDFDict ? v : undefined;
}

function nameIs(o: PDFObject | undefined, name: string): boolean {
  return o instanceof PDFName && o.asString() === `/${name}`;
}

// A file specification's /EF: a dictionary whose entries (F, UF, DOS, Mac, Unix) name streams.
function embeddedFileDict(ctx: PDFContext, o: PDFObject | undefined): PDFDict | undefined {
  const ef = dictOf(ctx, o);
  if (ef === undefined) return undefined;
  return ef.entries().some(([, v]) => resolve(ctx, v) instanceof PDFStream) ? ef : undefined;
}

// The ATT-1 marker in one dictionary (null when none). Keys are checked by meaning, not by
// name alone: /AF must hold an array and /EF a dictionary of file streams, so a resource that
// happens to be named /AF or /EF (a font or graphics-state name) is not an attachment.
function markerIn(ctx: PDFContext, d: PDFDict): string | null {
  if (nameIs(d.get(N('Type')), 'EmbeddedFile')) return '/EmbeddedFile';
  if (nameIs(d.get(N('Subtype')), 'FileAttachment')) return '/FileAttachment';
  if (resolve(ctx, d.get(N('AF'))) instanceof PDFArray) return '/AF';
  if (embeddedFileDict(ctx, d.get(N('EF'))) !== undefined) return '/EF';
  return null;
}

// Walks one object and its DIRECT children (indirect ones are visited on their own).
function findIn(ctx: PDFContext, o: PDFObject | undefined, depth: number): string | null {
  if (o === undefined || o instanceof PDFRef || depth > 32) return null;
  const d = o instanceof PDFStream ? o.dict : o instanceof PDFDict ? o : null;
  if (d !== null) {
    const m = markerIn(ctx, d);
    if (m !== null) return m;
    for (const [, v] of d.entries()) {
      const inner = findIn(ctx, v, depth + 1);
      if (inner !== null) return inner;
    }
    return null;
  }
  if (o instanceof PDFArray) {
    for (const v of o.asArray()) {
      const inner = findIn(ctx, v, depth + 1);
      if (inner !== null) return inner;
    }
  }
  return null;
}

/** ATT-1 / ATT-5 — the first attached-file marker in a loaded PDF (null when it has none). */
export function findPdfAttachment(doc: PDFDocument): string | null {
  const ctx = doc.context;
  const catalog = doc.catalog;
  if (catalog.get(N('Collection')) !== undefined) return '/Collection';
  if (dictOf(ctx, catalog.get(N('Names')))?.get(N('EmbeddedFiles')) !== undefined) return '/EmbeddedFiles';
  const top = findIn(ctx, catalog, 0);
  if (top !== null) return top;
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    const found = findIn(ctx, obj, 0);
    if (found !== null) return found;
  }
  return null;
}

// ATT-4 — a PDF carrying a digital signature: any signature dictionary (/ByteRange).
function isDigitallySigned(doc: PDFDocument): boolean {
  const ctx = doc.context;
  const has = (o: PDFObject | undefined, depth: number): boolean => {
    if (o === undefined || o instanceof PDFRef || depth > 32) return false;
    const d = o instanceof PDFStream ? o.dict : o instanceof PDFDict ? o : null;
    if (d !== null) {
      if (d.get(N('ByteRange')) !== undefined) return true;
      for (const [, v] of d.entries()) if (has(v, depth + 1)) return true;
      return false;
    }
    return o instanceof PDFArray ? o.asArray().some((v) => has(v, depth + 1)) : false;
  };
  for (const [, obj] of ctx.enumerateIndirectObjects()) if (has(obj, 0)) return true;
  return false;
}

// The embedded-file streams reachable in the file: each stream typed /EmbeddedFile, and each
// stream a file specification's /EF names (the type is optional).
function embeddedStreams(ctx: PDFContext): Set<string> {
  const out = new Set<string>();
  const visit = (o: PDFObject | undefined, depth: number): void => {
    if (o === undefined || depth > 32) return;
    if (o instanceof PDFRef) return;
    const d = o instanceof PDFStream ? o.dict : o instanceof PDFDict ? o : null;
    if (d !== null) {
      const ef = embeddedFileDict(ctx, d.get(N('EF')));
      if (ef !== undefined) for (const [, v] of ef.entries()) if (v instanceof PDFRef) out.add(v.tag);
      for (const [, v] of d.entries()) visit(v, depth + 1);
    } else if (o instanceof PDFArray) {
      for (const v of o.asArray()) visit(v, depth + 1);
    }
  };
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (obj instanceof PDFStream && nameIs(obj.dict.get(N('Type')), 'EmbeddedFile')) out.add(ref.tag);
    visit(obj, 0);
  }
  return out;
}

// Deletes /AF (an array of associated files) from every dictionary, direct or indirect.
function dropAssociatedFiles(ctx: PDFContext): void {
  const seen = new Set<PDFObject>();
  const visit = (o: PDFObject | undefined, depth: number): void => {
    if (o === undefined || o instanceof PDFRef || depth > 32 || seen.has(o)) return;
    seen.add(o);
    const d = o instanceof PDFStream ? o.dict : o instanceof PDFDict ? o : null;
    if (d !== null) {
      if (resolve(ctx, d.get(N('AF'))) instanceof PDFArray) d.delete(N('AF'));
      for (const [, v] of d.entries()) visit(v, depth + 1);
    } else if (o instanceof PDFArray) {
      for (const v of o.asArray()) visit(v, depth + 1);
    }
  };
  for (const [, obj] of ctx.enumerateIndirectObjects()) visit(obj, 0);
}

export interface PdfAttachmentRemoval {
  /** The PDF without attached files (the input bytes, untouched, when it had none). */
  bytes: Uint8Array;
  /** How many attached files were removed (0 when none). */
  attachments_removed: number;
}

/**
 * ATT-2 / ATT-3 / ATT-4 — removes every attached file (ATT-1) and saves a fresh file.
 * A PDF without attachments, or one pdf-lib cannot load, is returned byte-for-byte as given
 * (the gate decides exactly as before). A digitally signed PDF that has attachments is never
 * rewritten (that would break its signature): UnsafePdfError 'attachments'. Nothing else is
 * stripped here: scripts, actions and the rest keep the gate's handling.
 */
export async function removePdfAttachments(bytes: Uint8Array): Promise<PdfAttachmentRemoval> {
  const unchanged: PdfAttachmentRemoval = { bytes, attachments_removed: 0 };
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch {
    return unchanged;
  }
  let found: string | null;
  try {
    found = findPdfAttachment(doc);
  } catch {
    // A file pdf-lib parses without a usable catalog: the gate decides, as before.
    return unchanged;
  }
  if (found === null) return unchanged;
  if (isDigitallySigned(doc)) throw new UnsafePdfError('a digitally signed PDF with attached files', 'attachments');

  const ctx = doc.context;
  const before = embeddedStreams(ctx);
  const catalog = doc.catalog;
  const names = dictOf(ctx, catalog.get(N('Names')));
  if (names !== undefined) {
    names.delete(N('EmbeddedFiles'));
    if (names.entries().length === 0) catalog.delete(N('Names'));
  }
  catalog.delete(N('Collection'));
  if (nameIs(catalog.get(N('PageMode')), 'UseAttachments')) catalog.set(N('PageMode'), N('UseNone'));
  let annotations = 0;
  for (const page of doc.getPages()) {
    const annots = resolve(ctx, page.node.get(N('Annots')));
    if (!(annots instanceof PDFArray)) continue;
    const keep = annots.asArray().filter((a) => !nameIs(dictOf(ctx, a)?.get(N('Subtype')), 'FileAttachment'));
    annotations += annots.size() - keep.length;
    if (keep.length === annots.size()) continue;
    if (keep.length === 0) page.node.delete(N('Annots'));
    else page.node.set(N('Annots'), ctx.obj(keep));
  }
  dropAssociatedFiles(ctx);
  dropUnreachable(ctx);
  // Anything ATT-1 still finds (for example a file specification inside a link's action) could
  // not be removed safely: refused, never reported as removed.
  if (findPdfAttachment(doc) !== null) throw new UnsafePdfError('attached files that cannot be removed safely', 'attachments');
  const after = embeddedStreams(ctx);
  const removedStreams = [...before].filter((t) => !after.has(t)).length;
  const out = await doc.save({ useObjectStreams: false });
  // A file specification without an embedded stream still counts as one attached file.
  return { bytes: out, attachments_removed: Math.max(1, removedStreams, annotations) };
}
