import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import {
  PdfLibDocumentRenderingAdapter,
  SafePdfPipeline,
  RenderFailedError,
  UnsafePdfError,
  layoutSignatureBlock,
  wrapTextToWidth,
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

// Document Templates slice 1 (F) — GENERATED-path word wrapping + page flow. Each
// block is wrapped to the content width (612 - 2*54 = 504pt) with the embedded font's
// widthOfTextAtSize; a line that would cross the bottom margin starts a new page.
describe('PdfLibDocumentRenderingAdapter (GENERATED path — wrapping)', () => {
  const CONTENT_WIDTH = 504;
  const SENTENCE = 'The Talent authorizes the Recruiting Company to represent them exclusively for this requisition. ';

  async function helveticaMeasure(size: number): Promise<(s: string) => number> {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    return (s: string) => font.widthOfTextAtSize(s, size);
  }

  it('wraps a long paragraph into multiple lines, each within the content width, losing no words', async () => {
    const measure = await helveticaMeasure(11);
    const text = SENTENCE.repeat(6).trim();
    const lines = wrapTextToWidth(text, measure, CONTENT_WIDTH);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(measure(line)).toBeLessThanOrEqual(CONTENT_WIDTH);
    expect(lines.join(' ')).toBe(text);
  });

  it('keeps a short paragraph on one line and honours explicit newlines', async () => {
    const measure = await helveticaMeasure(11);
    expect(wrapTextToWidth('Short line', measure, CONTENT_WIDTH)).toEqual(['Short line']);
    expect(wrapTextToWidth('First\n\nThird', measure, CONTENT_WIDTH)).toEqual(['First', '', 'Third']);
  });

  it('hard-breaks a single word wider than the line so nothing overflows the margin', async () => {
    const measure = await helveticaMeasure(11);
    const lines = wrapTextToWidth('x'.repeat(400), measure, CONTENT_WIDTH);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(measure(line)).toBeLessThanOrEqual(CONTENT_WIDTH);
    expect(lines.join('')).toBe('x'.repeat(400));
  });

  it('a paragraph that overflows the page bottom flows onto a new page', async () => {
    const short = await adapter.renderGenerated({ ...MODEL, blocks: [{ type: 'TEXT', text: SENTENCE }] });
    expect(short.page_count).toBe(1);
    // One single TEXT block long enough to need far more than one page of wrapped lines.
    const long = await adapter.renderGenerated({ ...MODEL, blocks: [{ type: 'TEXT', text: SENTENCE.repeat(120) }] });
    expect(long.page_count).toBeGreaterThan(1);
  });

  it('wrapped output stays hash-stable (deterministic layout)', async () => {
    const m: RenderModel = { ...MODEL, blocks: [{ type: 'HEADING', text: 'Scope' }, { type: 'TEXT', text: SENTENCE.repeat(40) }] };
    const a = await adapter.renderGenerated(m);
    const b = await adapter.renderGenerated(m);
    expect(a.sha256).toBe(b.sha256);
  });
});

// Document Templates slice 1 (B2, spec §9.3 / A1 §2.3) — the fixed signature block the
// renderer appends after the content: TALENT SIGNATURE · PRINTED NAME · DATE SIGNED.
describe('PdfLibDocumentRenderingAdapter (GENERATED path — fixed signature block)', () => {
  const SIGNED: RenderModel = { ...MODEL, signature_block: { printed_name: 'Ravi Shankar' } };

  it('no signature_block → no block, no field placements (offer letter / legacy unchanged)', async () => {
    const out = await adapter.renderGenerated(MODEL);
    expect(out.signature_fields).toBeUndefined();
  });

  it('appends the block and returns SIGNATURE / SIGNER_NAME / SIGN_DATE placements in three columns on the last page', async () => {
    const out = await adapter.renderGenerated(SIGNED);
    expect(out.page_count).toBe(1);
    const f = out.signature_fields ?? [];
    expect(f.map((x) => x.field_type)).toEqual(['SIGNATURE', 'SIGNER_NAME', 'SIGN_DATE']);
    for (const x of f) {
      expect(x.page_number).toBe(0);
      expect(x.x).toBeGreaterThanOrEqual(54);
      expect(x.x + x.width).toBeLessThanOrEqual(612 - 54 + 0.001);
      expect(x.y).toBeGreaterThanOrEqual(54);
      expect(x.width).toBeGreaterThan(0);
      expect(x.height).toBeGreaterThan(0);
    }
    // Columns left → right, non-overlapping.
    expect((f[0] as { x: number; width: number }).x + (f[0] as { width: number }).width).toBeLessThan((f[1] as { x: number }).x);
    expect((f[1] as { x: number; width: number }).x + (f[1] as { width: number }).width).toBeLessThan((f[2] as { x: number }).x);
    // The block changes the bytes vs the same content without it.
    expect(out.sha256).not.toBe((await adapter.renderGenerated(MODEL)).sha256);
  });

  it('the block is never split: when it does not fit above the bottom margin it starts a new page', async () => {
    // Fill page 1 almost to the bottom, then the block must move to page 2.
    const SENT = 'The Talent authorizes the Recruiting Company to represent them exclusively for this requisition. ';
    let n = 1;
    let out = await adapter.renderGenerated({ ...SIGNED, blocks: [{ type: 'TEXT', text: SENT.repeat(n) }] });
    // Grow the paragraph until the block is pushed to a second page.
    while ((out.signature_fields?.[0]?.page_number ?? 0) === 0 && n < 200) {
      n += 1;
      out = await adapter.renderGenerated({ ...SIGNED, blocks: [{ type: 'TEXT', text: SENT.repeat(n) }] });
    }
    expect(out.signature_fields?.[0]?.page_number).toBe(1);
    expect(out.page_count).toBe(2);
    // All three fields land on the same (new) page, near its top.
    for (const x of out.signature_fields ?? []) {
      expect(x.page_number).toBe(1);
      expect(x.y).toBeGreaterThan(600);
    }
  });

  it('layout wraps a long printed name inside the PRINTED NAME column (pure geometry)', () => {
    const measure = (s: string) => s.length * 5; // 5pt per char
    const layout = layoutSignatureBlock(700, 'Alexandria Catherine Montgomery-Wellington Fitzgerald', measure);
    expect(layout.new_page).toBe(false);
    expect(layout.printed_name_lines.length).toBeGreaterThan(1);
    const col = layout.columns[1] as { width: number };
    for (const l of layout.printed_name_lines) expect(measure(l.text)).toBeLessThanOrEqual(col.width);
    // Lines sit above the rule (never over the label).
    for (const l of layout.printed_name_lines) expect(l.y).toBeGreaterThan(layout.rule_y);
    expect(layoutSignatureBlock(80, 'X', measure).new_page).toBe(true);
  });

  it('is hash-stable with the block', async () => {
    const a = await adapter.renderGenerated(SIGNED);
    const b = await adapter.renderGenerated(SIGNED);
    expect(a.sha256).toBe(b.sha256);
    expect(a.signature_fields).toEqual(b.signature_fields);
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
