import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, decodePDFRawStream } from 'pdf-lib';
import { PdfLibDocumentRenderingAdapter } from '@aramo/documents-rendering';
import { describe, expect, it } from 'vitest';

import { valuePlacement, type PlacementField } from '../lib/execution.service.js';

// Aramo-Sign-Mobile-Amendment-M-A13 (LOCKED) #1, R-1a / R-2 — a SIGNATURE or INITIALS
// value that is an image data URL draws as an IMAGE whatever its signature_method
// (Android vc2/vc3 send TYPED with an image); typed text stays in the script font.

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const stampFor = (): { label: string; id: string } => ({ label: 'Signed by:', id: 'ABC...' });

function field(over: Partial<PlacementField>): PlacementField {
  return { id: 'f1', field_type: 'SIGNATURE', signer_id: 's1', page_number: 0, x: 72, y: 120, width: 180, height: 40, value: 'Jane Doe', signature_method: 'TYPED', ...over };
}

async function pageOps(bytes: Uint8Array): Promise<{ ops: string; images: number }> {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(0);
  const contents = page.node.Contents();
  let ops = '';
  const streams = contents instanceof PDFArray ? Array.from({ length: contents.size() }, (_, i) => contents.get(i)) : contents !== undefined ? [contents] : [];
  for (const ref of streams) {
    const stream = ref instanceof PDFRef ? doc.context.lookup(ref) : ref;
    if (stream instanceof PDFRawStream) ops += Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
  }
  let images = 0;
  const xobjects = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  for (const [, ref] of xobjects?.entries() ?? []) {
    const x = doc.context.lookup(ref);
    if (x instanceof PDFRawStream && x.dict.get(PDFName.of('Subtype'))?.toString() === '/Image') images += 1;
  }
  return { ops, images };
}

async function blankSource(): Promise<Uint8Array> {
  const src = await PDFDocument.create();
  src.addPage([600, 800]);
  return src.save();
}

describe('M-A13 #1 — typed signature placement', () => {
  it('TYPED + image data URL on a SIGNATURE is an IMAGE with the stamp', () => {
    const p = valuePlacement(field({ value: PNG, signature_method: 'TYPED' }), stampFor);
    expect(p).toMatchObject({ kind: 'IMAGE', image_format: 'PNG', stamp: { label: 'Signed by:' } });
    expect(p).not.toHaveProperty('value');
    expect(p).not.toHaveProperty('font');
  });

  it('TYPED + image data URL on INITIALS is an IMAGE without a stamp', () => {
    const p = valuePlacement(field({ field_type: 'INITIALS', value: PNG, signature_method: 'TYPED' }), stampFor);
    expect(p).toMatchObject({ kind: 'IMAGE', image_format: 'PNG' });
    expect(p).not.toHaveProperty('stamp');
  });

  it('a missing signature_method with an image data URL is an IMAGE too', () => {
    expect(valuePlacement(field({ value: PNG, signature_method: null }), stampFor)).toMatchObject({ kind: 'IMAGE' });
  });

  it('TYPED text stays in the script font inside the stamp', () => {
    const p = valuePlacement(field({ value: 'Jane Doe' }), stampFor);
    expect(p).toMatchObject({ value: 'Jane Doe', font: 'SCRIPT', stamp: { label: 'Signed by:' } });
    expect(p).not.toHaveProperty('kind');
  });

  it('DRAWN with a malformed image is skipped (no typed fallback), as before', () => {
    expect(valuePlacement(field({ value: 'not-an-image', signature_method: 'DRAWN' }), stampFor)).toBeNull();
  });

  it('a TEXT field never turns into an image (only SIGNATURE / INITIALS do)', () => {
    expect(valuePlacement(field({ field_type: 'TEXT', value: PNG, signature_method: null }), stampFor)).toEqual({ field_key: 'f1', page_number: 0, x: 72, y: 120, value: PNG });
  });
});

describe('M-A13 #1 — render: TYPED image draws an image; TYPED text draws script text', () => {
  const renderer = new PdfLibDocumentRenderingAdapter();

  it('TYPED + image data URL renders as an image XObject, never as the data URL text', async () => {
    const placed = valuePlacement(field({ value: PNG, signature_method: 'TYPED' }), stampFor);
    const out = await renderer.prepareFromSource(await blankSource(), [placed!]);
    const { ops, images } = await pageOps(out.bytes);
    expect(images).toBe(1);
    expect(ops).toMatch(/\bDo\b/);
    expect(ops).not.toContain('data:image');
    expect(ops.toUpperCase()).not.toContain(Buffer.from('data:image', 'latin1').toString('hex').toUpperCase());
  });

  it('TYPED text renders as text (no image)', async () => {
    const placed = valuePlacement(field({ value: 'Jane Doe' }), stampFor);
    const out = await renderer.prepareFromSource(await blankSource(), [placed!]);
    const { ops, images } = await pageOps(out.bytes);
    expect(images).toBe(0);
    expect(ops).toMatch(/Tj|TJ/);
  });
});
