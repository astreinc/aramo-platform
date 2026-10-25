// Scan-to-PDF (directive §5; handoff §4.6 "The result is one PDF"). The native
// scanner (VisionKit / ML Kit) returns one JPEG per page; this composes them into a
// single PDF with each JPEG embedded as-is (DCTDecode, no re-encoding). Pure: bytes in,
// bytes out, so it is unit-tested and runs on Hermes.
import type { PageSize } from '../editor/geometry';
import { utf8Encode } from '../../util/bytes';

/** Pages are scaled to fit US Letter (portrait or landscape), keeping the aspect ratio. */
const FIT_LONG = 792;
const FIT_SHORT = 612;

export interface JpegInfo {
  readonly width: number;
  readonly height: number;
  readonly components: number;
}

/** Read the frame size from a JPEG's SOF marker. Throws on anything that isn't a JPEG. */
export function readJpegInfo(b: Uint8Array): JpegInfo {
  if (b[0] !== 0xff || b[1] !== 0xd8) throw new Error('not a JPEG');
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = b[i + 1]!;
    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7) ||
      marker === 0xff
    ) {
      i += marker === 0xff ? 1 : 2;
      continue;
    }
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const height = (b[i + 5]! << 8) | b[i + 6]!;
      const width = (b[i + 7]! << 8) | b[i + 8]!;
      const components = b[i + 9]!;
      if (width > 0 && height > 0) return { width, height, components };
      break;
    }
    i += 2 + len;
  }
  throw new Error('JPEG has no frame header');
}

/** The page size a scanned image of `w`×`h` pixels gets, in PDF points. */
export function pageSizeForImage(w: number, h: number): PageSize {
  const landscape = w > h;
  const maxW = landscape ? FIT_LONG : FIT_SHORT;
  const maxH = landscape ? FIT_SHORT : FIT_LONG;
  const s = Math.min(maxW / w, maxH / h);
  return { width: Math.round(w * s * 100) / 100, height: Math.round(h * s * 100) / 100 };
}

function colorSpace(components: number): string {
  if (components === 1) return '/DeviceGray';
  if (components === 4) return '/DeviceCMYK /Decode [1 0 1 0 1 0 1 0]';
  return '/DeviceRGB';
}

export interface ComposedPdf {
  readonly bytes: Uint8Array;
  readonly pages: PageSize[];
}

/** Compose scanned JPEG pages into one PDF. */
export function composeScanPdf(jpegs: readonly Uint8Array[]): ComposedPdf {
  if (jpegs.length === 0) throw new Error('no pages');
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (c: Uint8Array) => {
    chunks.push(c);
    length += c.length;
  };
  const text = (s: string) => push(utf8Encode(s));
  const begin = (num: number) => {
    offsets[num] = length;
    text(`${num} 0 obj\n`);
  };

  text('%PDF-1.4\n');
  // A binary comment line marks the file as binary for transfer tools.
  push(Uint8Array.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const pages: PageSize[] = [];
  const pageNums = jpegs.map((_j, i) => 3 + i * 3);
  begin(1);
  text('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  begin(2);
  text(
    `<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${jpegs.length} >>\nendobj\n`,
  );

  jpegs.forEach((jpeg, i) => {
    const info = readJpegInfo(jpeg);
    const size = pageSizeForImage(info.width, info.height);
    pages.push(size);
    const pageNum = pageNums[i]!;
    const imgNum = pageNum + 1;
    const contentNum = pageNum + 2;
    begin(pageNum);
    text(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${size.width} ${size.height}] ` +
        `/Resources << /XObject << /Im0 ${imgNum} 0 R >> >> /Contents ${contentNum} 0 R >>\nendobj\n`,
    );
    begin(imgNum);
    text(
      `<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} ` +
        `/ColorSpace ${colorSpace(info.components)} /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
    );
    push(jpeg);
    text('\nendstream\nendobj\n');
    const content = `q ${size.width} 0 0 ${size.height} 0 0 cm /Im0 Do Q`;
    begin(contentNum);
    text(`<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
  });

  const count = 3 + jpegs.length * 3;
  const xrefAt = length;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let n = 1; n < count; n += 1)
    xref += `${String(offsets[n] ?? 0).padStart(10, '0')} 00000 n \n`;
  text(xref);
  text(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

  const bytes = new Uint8Array(length);
  let o = 0;
  for (const c of chunks) {
    bytes.set(c, o);
    o += c.length;
  }
  return { bytes, pages };
}
