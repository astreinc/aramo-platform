import { deflateSync, deflateRawSync } from 'node:zlib';

import { inflate } from '../inflate';
import { readPdfPageSizes } from '../pdfPageSizes';
import { composeScanPdf, pageSizeForImage, readJpegInfo } from '../../send/scanToPdf';

const enc = (s: string) => new Uint8Array(Buffer.from(s, 'latin1'));

/** A classic PDF: a /Pages node with an inherited MediaBox and a nested node. */
function classicPdf(): Uint8Array {
  return enc(
    [
      '%PDF-1.7',
      '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
      '2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R] /Count 3 /MediaBox [0 0 612 792] >> endobj',
      '3 0 obj << /Type /Page /Parent 2 0 R /Resources << /Font << /F1 9 0 R >> >> >> endobj',
      '4 0 obj << /Type /Pages /Parent 2 0 R /Kids [5 0 R 6 0 R] /Count 2 >> endobj',
      '5 0 obj << /Type /Page /Parent 4 0 R /MediaBox [0 0 842 595] >> endobj',
      '6 0 obj << /Type /Page /Parent 4 0 R /MediaBox 7 0 R /Contents 8 0 R >> endobj',
      '7 0 obj [ 10 10 605.28 851.89 ] endobj',
      '8 0 obj << /Length 9 >> stream\nendobj >>\nendstream endobj',
      'trailer << /Size 9 /Root 1 0 R >>',
      'startxref 0',
      '%%EOF',
    ].join('\n'),
  );
}

/** A PDF whose page objects live in a compressed object stream (pdf-lib's default output). */
function objectStreamPdf(): Uint8Array {
  const objs = [
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 1008] >>',
  ];
  let header = '';
  let body = '';
  objs.forEach((o, i) => {
    header += `${i + 2} ${body.length} `;
    body += `${o}\n`;
  });
  const content = header + body;
  const z = deflateSync(Buffer.from(content, 'latin1'));
  const head =
    '%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
    `5 0 obj << /Type /ObjStm /N 3 /First ${header.length} /Filter /FlateDecode /Length ${z.length} >>\nstream\n`;
  const tail =
    '\nendstream\nendobj\n6 0 obj << /Type /XRef /Root 1 0 R /Size 7 >>\nstream\n\nendstream\nendobj\nstartxref\n0\n%%EOF\n';
  return new Uint8Array(
    Buffer.concat([Buffer.from(head, 'latin1'), z, Buffer.from(tail, 'latin1')]),
  );
}

describe('inflate', () => {
  it('matches zlib for zlib-wrapped and raw streams', () => {
    const text =
      'Aramo Sign '.repeat(500) + Array.from({ length: 300 }, (_, i) => String(i * 7919)).join(',');
    const input = Buffer.from(text);
    expect(Buffer.from(inflate(new Uint8Array(deflateSync(input)))).toString()).toBe(text);
    expect(Buffer.from(inflate(new Uint8Array(deflateRawSync(input)))).toString()).toBe(text);
    expect(Buffer.from(inflate(new Uint8Array(deflateSync(input, { level: 0 })))).toString()).toBe(
      text,
    );
  });

  it('refuses output past the cap', () => {
    const z = new Uint8Array(deflateSync(Buffer.alloc(100_000)));
    expect(() => inflate(z, 10_000)).toThrow('output too large');
  });
});

describe('PDF page sizes (MediaBox, the frame the server validates against)', () => {
  it('reads pages in tree order with inherited and indirect MediaBoxes', () => {
    expect(readPdfPageSizes(classicPdf())).toEqual([
      { width: 612, height: 792 },
      { width: 842, height: 595 },
      { width: 595.28, height: 841.89 },
    ]);
  });

  it('reads compressed object streams', () => {
    expect(readPdfPageSizes(objectStreamPdf())).toEqual([
      { width: 595.28, height: 841.89 },
      { width: 612, height: 1008 },
    ]);
  });

  it('refuses what is not a PDF', () => {
    expect(() => readPdfPageSizes(enc('PK\u0003\u0004 word/document.xml'))).toThrow('not a PDF');
  });
});

/** A minimal baseline JPEG header (SOI, APP0, SOF0) of `w`×`h` pixels. */
function fakeJpeg(w: number, h: number): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x10,
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00,
    0x01,
    0x01,
    0x00,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    h >> 8,
    h & 0xff,
    w >> 8,
    w & 0xff,
    0x03,
    0x01,
    0x22,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01,
    0xff,
    0xd9,
  ]);
}

describe('scan to PDF (one PDF from the scanned pages)', () => {
  it('reads the JPEG frame size', () => {
    expect(readJpegInfo(fakeJpeg(2480, 3508))).toEqual({
      width: 2480,
      height: 3508,
      components: 3,
    });
    expect(() => readJpegInfo(enc('%PDF-1.4'))).toThrow('not a JPEG');
  });

  it('fits pages to US Letter, keeping the aspect ratio', () => {
    expect(pageSizeForImage(1224, 1584)).toEqual({ width: 612, height: 792 });
    expect(pageSizeForImage(3000, 2000)).toEqual({ width: 792, height: 528 });
  });

  it('composes a 3-page scan into one PDF whose pages the editor reads back', () => {
    const pdf = composeScanPdf([fakeJpeg(1224, 1584), fakeJpeg(2000, 1000), fakeJpeg(1000, 1000)]);
    const text = Buffer.from(pdf.bytes).toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('/Count 3');
    expect(text.match(/\/Filter \/DCTDecode/g)).toHaveLength(3);
    expect(readPdfPageSizes(pdf.bytes)).toEqual(pdf.pages);
    expect(pdf.pages).toEqual([
      { width: 612, height: 792 },
      { width: 792, height: 396 },
      { width: 612, height: 612 },
    ]);
    // Every xref offset points at its object.
    const xref = text.slice(text.lastIndexOf('xref'));
    const offsets = [...xref.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    offsets.forEach((o, i) => expect(text.slice(o).startsWith(`${i + 1} 0 obj`)).toBe(true));
  });
});
