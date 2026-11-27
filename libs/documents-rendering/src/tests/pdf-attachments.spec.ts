import { PDFDict, PDFDocument, PDFName, PDFString, type PDFRef } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { SafePdfPipeline, UnsafePdfError, findPdfAttachment, removePdfAttachments } from '../index.js';

// PDF-ATTACH-1 (Aramo-PDF-Attachment-Strip-1-Directive-v1_0-LOCKED) T-1 .. T-3 — synthetic
// fixtures only (no user file is committed).

const N = (s: string): PDFName => PDFName.of(s);

async function base(): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  doc.setCreationDate(new Date('2001-01-01T00:00:00.000Z'));
  doc.setModificationDate(new Date('2001-01-01T00:00:00.000Z'));
  doc.addPage([612, 792]).drawText('Company incorporation', { x: 72, y: 700, size: 12 });
  return doc;
}

// An embedded-file stream and a file specification naming it (typed unless `untyped`).
function fileSpec(doc: PDFDocument, name: string, untyped = false): PDFRef {
  const stream = doc.context.flateStream('{"manifest":"provenance"}', untyped ? {} : { Type: 'EmbeddedFile', Subtype: 'application/c2pa' });
  const streamRef = doc.context.register(stream);
  return doc.context.register(doc.context.obj({ Type: 'Filespec', F: PDFString.of(name), UF: PDFString.of(name), EF: { F: streamRef }, AFRelationship: 'Supplement' }));
}

// The reported shape: a catalog name tree + catalog /AF + /PageMode /UseAttachments.
async function c2paLike(objectStreams = false): Promise<Uint8Array> {
  const doc = await base();
  const spec = fileSpec(doc, 'Content Credentials');
  doc.catalog.set(N('Names'), doc.context.obj({ EmbeddedFiles: { Names: [PDFString.of('Content Credentials'), spec] } }));
  doc.catalog.set(N('AF'), doc.context.obj([spec]));
  doc.catalog.set(N('PageMode'), N('UseAttachments'));
  return doc.save({ useObjectStreams: objectStreams });
}

async function loaded(bytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(bytes, { updateMetadata: false });
}

const pipeline = new SafePdfPipeline();

describe('PDF-ATTACH-1 — attached files are removed (T-1)', () => {
  it('removes a catalog attachment (Content Credentials): name tree, /AF, page mode; the gate then accepts it', async () => {
    const out = await removePdfAttachments(await c2paLike());
    expect(out.attachments_removed).toBe(1);
    const doc = await loaded(out.bytes);
    expect(findPdfAttachment(doc)).toBeNull();
    expect(doc.catalog.get(N('Names'))).toBeUndefined();
    expect(doc.catalog.get(N('AF'))).toBeUndefined();
    expect(doc.catalog.get(N('PageMode'))).toEqual(N('UseNone'));
    expect(Buffer.from(out.bytes).toString('latin1')).not.toContain('provenance');
    expect(doc.getPageCount()).toBe(1);
    await expect(pipeline.accept(out.bytes)).resolves.toBe(out.bytes);
  });

  it('removes a /FileAttachment annotation and keeps the page’s other annotations', async () => {
    const doc = await base();
    const page = doc.getPage(0);
    const attach = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'FileAttachment', Rect: [10, 10, 30, 30], FS: fileSpec(doc, 'a.txt') }));
    const link = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [40, 40, 90, 60] }));
    page.node.set(N('Annots'), doc.context.obj([attach, link]));
    const out = await removePdfAttachments(await doc.save({ useObjectStreams: false }));
    expect(out.attachments_removed).toBe(1);
    const after = await loaded(out.bytes);
    expect(findPdfAttachment(after)).toBeNull();
    expect(after.getPage(0).node.Annots()?.size()).toBe(1);
  });

  it('removes /AF on a page', async () => {
    const doc = await base();
    doc.getPage(0).node.set(N('AF'), doc.context.obj([fileSpec(doc, 'data.xml')]));
    const out = await removePdfAttachments(await doc.save({ useObjectStreams: false }));
    expect(out.attachments_removed).toBe(1);
    expect(findPdfAttachment(await loaded(out.bytes))).toBeNull();
  });

  it('removes a portfolio (/Collection) and its files', async () => {
    const doc = await base();
    doc.catalog.set(N('Collection'), doc.context.obj({ Type: 'Collection', View: 'D' }));
    doc.catalog.set(N('Names'), doc.context.obj({ EmbeddedFiles: { Names: [PDFString.of('one.pdf'), fileSpec(doc, 'one.pdf'), PDFString.of('two.pdf'), fileSpec(doc, 'two.pdf')] } }));
    const out = await removePdfAttachments(await doc.save({ useObjectStreams: false }));
    expect(out.attachments_removed).toBe(2);
    const after = await loaded(out.bytes);
    expect(after.catalog.get(N('Collection'))).toBeUndefined();
    expect(findPdfAttachment(after)).toBeNull();
  });

  it('finds and removes an untyped stream named only from a compressed object stream', async () => {
    const doc = await base();
    const spec = fileSpec(doc, 'hidden.bin', true);
    doc.catalog.set(N('Names'), doc.context.obj({ EmbeddedFiles: { Names: [PDFString.of('hidden.bin'), spec] } }));
    const bytes = await doc.save({ useObjectStreams: true });
    // The raw bytes carry neither the singular type nor the plural tree in clear text.
    expect(Buffer.from(bytes).toString('latin1')).not.toMatch(/\/EmbeddedFile[\s/<>[\]]/);
    expect(findPdfAttachment(await loaded(bytes))).not.toBeNull();
    const out = await removePdfAttachments(bytes);
    expect(out.attachments_removed).toBe(1);
    expect(findPdfAttachment(await loaded(out.bytes))).toBeNull();
  });
});

describe('PDF-ATTACH-1 — a clean file is unchanged (T-2, ATT-3)', () => {
  it('returns the very same bytes, with nothing removed', async () => {
    const bytes = await (await base()).save({ useObjectStreams: false });
    const out = await removePdfAttachments(bytes);
    expect(out.attachments_removed).toBe(0);
    expect(out.bytes).toBe(bytes);
    const gated = await pipeline.acceptRemovingAttachments(bytes);
    expect(gated).toEqual({ bytes, attachments_removed: 0 });
    expect(gated.bytes).toBe(bytes);
  });

  it('a resource that is merely NAMED /AF or /EF (a font, a graphics state) is not an attachment', async () => {
    const doc = await base();
    const font = doc.context.register(doc.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' }));
    const gs = doc.context.register(doc.context.obj({ Type: 'ExtGState', CA: 1 }));
    doc.getPage(0).node.set(N('Resources'), doc.context.obj({ Font: { AF: font }, ExtGState: { EF: gs } }));
    const bytes = await doc.save({ useObjectStreams: false });
    const out = await removePdfAttachments(bytes);
    expect(out.bytes).toBe(bytes);
    await expect(pipeline.accept(bytes)).resolves.toBe(bytes);
  });

  it('a file pdf-lib cannot load is passed to the gate untouched', async () => {
    const junk = new Uint8Array(Buffer.from('%PDF-1.7\nnot really a pdf', 'latin1'));
    expect((await removePdfAttachments(junk)).bytes).toBe(junk);
  });
});

describe('PDF-ATTACH-1 — refusals (T-3, ATT-4, ATT-5)', () => {
  const problemOf = (p: Promise<unknown>): Promise<string> =>
    p.then(
      () => 'accepted',
      (e: unknown) => (e instanceof UnsafePdfError ? e.problem : String(e)),
    );

  it('a digitally signed PDF with an attachment is refused, never rewritten', async () => {
    const doc = await base();
    doc.catalog.set(N('Names'), doc.context.obj({ EmbeddedFiles: { Names: [PDFString.of('x'), fileSpec(doc, 'x')] } }));
    const sig = doc.context.register(doc.context.obj({ Type: 'Sig', Filter: 'Adobe.PPKLite', ByteRange: [0, 10, 20, 30] }));
    doc.catalog.set(N('Perms'), doc.context.obj({ DocMDP: sig }));
    const bytes = await doc.save({ useObjectStreams: false });
    expect(await problemOf(removePdfAttachments(bytes))).toBe('attachments');
    expect(await problemOf(pipeline.acceptRemovingAttachments(bytes))).toBe('attachments');
  });

  it('a signed PDF without attachments is not touched', async () => {
    const doc = await base();
    const sig = doc.context.register(doc.context.obj({ Type: 'Sig', ByteRange: [0, 10, 20, 30] }));
    doc.catalog.set(N('Perms'), doc.context.obj({ DocMDP: sig }));
    const bytes = await doc.save({ useObjectStreams: false });
    expect((await removePdfAttachments(bytes)).bytes).toBe(bytes);
  });

  it('an attachment plus a script: the attachment goes, the script is still refused as scripts', async () => {
    const doc = await base();
    doc.catalog.set(N('Names'), doc.context.obj({ EmbeddedFiles: { Names: [PDFString.of('x'), fileSpec(doc, 'x')] } }));
    doc.catalog.set(N('OpenAction'), doc.context.obj({ S: 'JavaScript', JS: PDFString.of('app.alert(1)') }));
    expect(await problemOf(pipeline.acceptRemovingAttachments(await doc.save({ useObjectStreams: false })))).toBe('scripts');
  });

  it('the gate alone refuses an attachment as attachments, never scripts', async () => {
    expect(await problemOf(pipeline.accept(await c2paLike()))).toBe('attachments');
    expect(await problemOf(pipeline.accept(await c2paLike(true)))).toBe('attachments');
  });

  it('an attachment that cannot be removed (a file specification inside another object) is refused', async () => {
    const doc = await base();
    const page = doc.getPage(0);
    const holder = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [1, 1, 2, 2] }));
    (doc.context.lookup(holder) as PDFDict).set(N('Spec'), fileSpec(doc, 'kept.bin'));
    page.node.set(N('Annots'), doc.context.obj([holder]));
    expect(await problemOf(removePdfAttachments(await doc.save({ useObjectStreams: false })))).toBe('attachments');
  });

  it('acceptRemovingAttachments: the reported shape comes out accepted, with the count', async () => {
    const out = await pipeline.acceptRemovingAttachments(await c2paLike(true));
    expect(out.attachments_removed).toBe(1);
    expect(findPdfAttachment(await loaded(out.bytes))).toBeNull();
  });
});
