import { PDFArray, PDFDocument, PDFRawStream, PDFRef, decodePDFRawStream } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { PdfLibDocumentRenderingAdapter, RenderFailedError } from '../index.js';

// M-A6 §1 — the MARK placement kind. CHECKBOX and ACKNOWLEDGEMENT values used to
// be flattened as the literal text "true". A MARK draws a box and (when checked)
// a vector check — no font, no text operator — so the executed PDF never carries
// the stored value as text. Proven by decoding the page content streams.

const adapter = new PdfLibDocumentRenderingAdapter();

async function blankSource(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setCreationDate(new Date('2001-01-01T00:00:00.000Z'));
  doc.setModificationDate(new Date('2001-01-01T00:00:00.000Z'));
  doc.addPage([612, 792]);
  return doc.save({ useObjectStreams: false });
}

// Every content-stream operator drawn on page 0, decoded to text.
async function pageOperators(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(0);
  const contents = page.node.Contents();
  const refs: PDFRef[] = [];
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i += 1) refs.push(contents.get(i) as PDFRef);
  }
  let out = '';
  for (const ref of refs) {
    const stream = doc.context.lookup(ref);
    if (stream instanceof PDFRawStream) out += Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
    else if (stream !== undefined && 'getContentsString' in (stream as object)) out += (stream as unknown as { getContentsString(): string }).getContentsString();
  }
  return out;
}

// Stroke-path operators (`S`) — one per drawn outline.
const strokes = (ops: string): number => ops.split('\n').filter((l) => l === 'S').length;

const TRUE_HEX = Buffer.from('true', 'latin1').toString('hex').toUpperCase();

describe('MARK placement (M-A6 §1 vector check box)', () => {
  it('the TEXT path is what used to print "true" (control)', async () => {
    const out = await adapter.prepareFromSource(await blankSource(), [{ field_key: 'cb', page_number: 0, x: 72, y: 120, value: 'true' }]);
    const ops = await pageOperators(out.bytes);
    expect(ops).toMatch(/Tj/);
    expect(ops.toUpperCase()).toContain(TRUE_HEX);
  });

  it('a checked MARK draws a box and a vector check, with no text operator and no "true"', async () => {
    const out = await adapter.prepareFromSource(await blankSource(), [
      { field_key: 'cb', page_number: 0, x: 72, y: 120, kind: 'MARK', checked: true, width: 14, height: 14 },
    ]);
    const ops = await pageOperators(out.bytes);
    expect(ops).not.toMatch(/Tj|TJ|BT/);
    expect(ops.toUpperCase()).not.toContain(TRUE_HEX);
    expect(ops).not.toMatch(/true/);
    expect(ops).toMatch(/h\nS\n/); // the closed box outline
    expect(strokes(ops)).toBe(2); // the box and the check
    expect(Buffer.from(out.bytes).toString('latin1')).not.toMatch(/\(true\)/);
  });

  it('an unchecked MARK draws only the empty box', async () => {
    const checked = await pageOperators((await adapter.prepareFromSource(await blankSource(), [{ field_key: 'cb', page_number: 0, x: 72, y: 120, kind: 'MARK', checked: true }])).bytes);
    const unchecked = await pageOperators((await adapter.prepareFromSource(await blankSource(), [{ field_key: 'cb', page_number: 0, x: 72, y: 120, kind: 'MARK', checked: false }])).bytes);
    expect(unchecked).toMatch(/h\nS\n/);
    expect(strokes(unchecked)).toBe(1); // the box only
    expect(unchecked).not.toMatch(/Tj|TJ|BT/);
    expect(strokes(checked)).toBe(2);
  });

  it('is hash-stable and the checked state is part of the render manifest', async () => {
    const src = await blankSource();
    const a = await adapter.prepareFromSource(src, [{ field_key: 'cb', page_number: 0, x: 72, y: 120, kind: 'MARK', checked: true }]);
    const b = await adapter.prepareFromSource(src, [{ field_key: 'cb', page_number: 0, x: 72, y: 120, kind: 'MARK', checked: true }]);
    const c = await adapter.prepareFromSource(src, [{ field_key: 'cb', page_number: 0, x: 72, y: 120, kind: 'MARK', checked: false }]);
    expect(a.sha256).toBe(b.sha256);
    expect(a.provenance.render_manifest_sha256).not.toBe(c.provenance.render_manifest_sha256);
  });

  it('refuses a MARK without a checked state', async () => {
    await expect(adapter.prepareFromSource(await blankSource(), [{ field_key: 'cb', page_number: 0, x: 72, y: 120, kind: 'MARK' }])).rejects.toBeInstanceOf(RenderFailedError);
  });
});
