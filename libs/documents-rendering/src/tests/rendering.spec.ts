import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import {
  PdfLibDocumentRenderingAdapter,
  SafePdfPipeline,
  RenderFailedError,
  UnsafePdfError,
  type RenderModel,
} from '../index.js';

// DOC-2 boundary 5/6 — the rendering adapter + safe-upload pipeline. Pure pdf-lib,
// no DB. Proves: hash-stable deterministic output (authoritative provenance),
// GENERATED + UPLOADED_PDF paths, bounds-checking, and the safe-upload gates
// (type/size/encrypted/active-content/structural). No network, no filesystem.

const adapter = new PdfLibDocumentRenderingAdapter();

const MODEL: RenderModel = {
  template_version_id: '00000000-0000-7000-8000-000000000001',
  render_schema_version: 'v1',
  title: 'Offer Letter',
  blocks: [
    { type: 'HEADING', text: 'Position' },
    { type: 'TEXT', text: 'Senior Engineer at Acme Corp' },
    { type: 'HEADING', text: 'Compensation' },
    { type: 'TEXT', text: 'USD 180,000 / year' },
  ],
};

async function makeSourcePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setCreationDate(new Date('2001-01-01T00:00:00.000Z'));
  doc.setModificationDate(new Date('2001-01-01T00:00:00.000Z'));
  const page = doc.addPage([612, 792]);
  page.drawText('Client Form', { x: 72, y: 700, size: 12 });
  return doc.save({ useObjectStreams: false });
}

describe('PdfLibDocumentRenderingAdapter (GENERATED path)', () => {
  it('produces a valid PDF with provenance', async () => {
    const out = await adapter.renderGenerated(MODEL);
    expect(Buffer.from(out.bytes.slice(0, 5)).toString('latin1')).toBe('%PDF-');
    expect(out.page_count).toBeGreaterThanOrEqual(1);
    expect(out.provenance.renderer).toBe('PDF_LIB');
    expect(out.provenance.output_sha256).toBe(out.sha256);
    expect(out.provenance.template_version_id).toBe(MODEL.template_version_id);
    expect(out.provenance.render_manifest_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is hash-stable: identical inputs render byte-identically', async () => {
    const a = await adapter.renderGenerated(MODEL);
    const b = await adapter.renderGenerated(MODEL);
    expect(a.sha256).toBe(b.sha256);
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
  });

  it('produces a different hash for different content (no accidental collision)', async () => {
    const a = await adapter.renderGenerated(MODEL);
    const b = await adapter.renderGenerated({ ...MODEL, title: 'Different Title' });
    expect(a.sha256).not.toBe(b.sha256);
  });
});

describe('PdfLibDocumentRenderingAdapter (UPLOADED_PDF path)', () => {
  it('overlays a field on an existing PDF, recording source + output provenance', async () => {
    const source = await makeSourcePdf();
    const out = await adapter.prepareFromSource(
      source,
      [{ field_key: 'signature', page_number: 0, x: 72, y: 120, value: 'Jane Doe' }],
      { template_version_id: MODEL.template_version_id },
    );
    expect(Buffer.from(out.bytes.slice(0, 5)).toString('latin1')).toBe('%PDF-');
    expect(out.provenance.source_artifact_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(out.provenance.output_sha256).toBe(out.sha256);
    // Overlay changed the bytes (source != output).
    expect(out.provenance.source_artifact_sha256).not.toBe(out.provenance.output_sha256);
  });

  it('is hash-stable on the uploaded path too', async () => {
    const source = await makeSourcePdf();
    const a = await adapter.prepareFromSource(source, [{ field_key: 'x', page_number: 0, x: 72, y: 120, value: 'v' }]);
    const b = await adapter.prepareFromSource(source, [{ field_key: 'x', page_number: 0, x: 72, y: 120, value: 'v' }]);
    expect(a.sha256).toBe(b.sha256);
  });

  it('rejects an out-of-bounds placement (RenderFailedError)', async () => {
    const source = await makeSourcePdf();
    await expect(
      adapter.prepareFromSource(source, [{ field_key: 'x', page_number: 0, x: 9999, y: 9999, value: 'v' }]),
    ).rejects.toBeInstanceOf(RenderFailedError);
  });

  it('rejects a placement on a non-existent page', async () => {
    const source = await makeSourcePdf();
    await expect(
      adapter.prepareFromSource(source, [{ field_key: 'x', page_number: 5, x: 10, y: 10, value: 'v' }]),
    ).rejects.toBeInstanceOf(RenderFailedError);
  });

  // DOC-4 B1 — IMAGE placement: stamp a DRAWN/UPLOADED signature image (PNG) at
  // field coordinates. A 1x1 transparent PNG proves the embed+draw path.
  const PNG_1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
    'base64',
  );

  it('stamps a PNG signature image at field coordinates (executed-doc production)', async () => {
    const source = await makeSourcePdf();
    const out = await adapter.prepareFromSource(source, [
      {
        field_key: 'sig',
        page_number: 0,
        x: 72,
        y: 120,
        kind: 'IMAGE',
        image_bytes: new Uint8Array(PNG_1x1),
        image_format: 'PNG',
        width: 120,
        height: 40,
      },
    ]);
    expect(Buffer.from(out.bytes.slice(0, 5)).toString('latin1')).toBe('%PDF-');
    expect(out.provenance.output_sha256).toBe(out.sha256);
    // Image overlay changed the bytes (source != output).
    expect(out.provenance.source_artifact_sha256).not.toBe(out.provenance.output_sha256);
  });

  it('is hash-stable on the IMAGE path (deterministic embed)', async () => {
    const source = await makeSourcePdf();
    const placement = {
      field_key: 'sig',
      page_number: 0,
      x: 72,
      y: 120,
      kind: 'IMAGE' as const,
      image_bytes: new Uint8Array(PNG_1x1),
      image_format: 'PNG' as const,
      width: 120,
      height: 40,
    };
    const a = await adapter.prepareFromSource(source, [placement]);
    const b = await adapter.prepareFromSource(source, [placement]);
    expect(a.sha256).toBe(b.sha256);
  });

  it('rejects an out-of-bounds IMAGE placement', async () => {
    const source = await makeSourcePdf();
    await expect(
      adapter.prepareFromSource(source, [
        {
          field_key: 'sig',
          page_number: 0,
          x: 9999,
          y: 9999,
          kind: 'IMAGE',
          image_bytes: new Uint8Array(PNG_1x1),
          image_format: 'PNG',
          width: 120,
          height: 40,
        },
      ]),
    ).rejects.toBeInstanceOf(RenderFailedError);
  });
});

describe('SafePdfPipeline (B6 — governed upload safety)', () => {
  const pipeline = new SafePdfPipeline();

  it('accepts a clean PDF and returns its bytes unchanged', async () => {
    const source = await makeSourcePdf();
    const accepted = await pipeline.accept(source);
    expect(Buffer.from(accepted).equals(Buffer.from(source))).toBe(true);
  });

  it('rejects a non-PDF (missing %PDF- header)', async () => {
    await expect(pipeline.accept(new Uint8Array([1, 2, 3, 4, 5]))).rejects.toBeInstanceOf(UnsafePdfError);
  });

  it('rejects an empty file', async () => {
    await expect(pipeline.accept(new Uint8Array([]))).rejects.toBeInstanceOf(UnsafePdfError);
  });

  it('rejects a PDF carrying active content (/OpenAction)', async () => {
    const source = await makeSourcePdf();
    // Splice an /OpenAction token into the raw bytes (uncompressed scan target).
    const tampered = Buffer.concat([Buffer.from(source), Buffer.from('\n/OpenAction 1 0 R\n', 'latin1')]);
    await expect(pipeline.accept(new Uint8Array(tampered))).rejects.toThrow(/active content/i);
  });

  it('rejects an encrypted PDF marker (/Encrypt) — never ignoreEncryption', async () => {
    const source = await makeSourcePdf();
    const tampered = Buffer.concat([Buffer.from(source), Buffer.from('\n/Encrypt 2 0 R\n', 'latin1')]);
    await expect(pipeline.accept(new Uint8Array(tampered))).rejects.toThrow(/encrypted/i);
  });
});
