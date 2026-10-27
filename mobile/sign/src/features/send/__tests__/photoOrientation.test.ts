// A photo's EXIF orientation is applied by the page transform (a PDF viewer ignores EXIF).
import { composeScanPdf, imageMatrix, readJpegOrientation } from '../scanToPdf';

/** SOI, APP1 Exif with one IFD0 entry (Orientation), SOF0, EOI. */
function jpegWithOrientation(w: number, h: number, orientation: number, little = false): Uint8Array {
  const u16 = (v: number) => (little ? [v & 0xff, v >> 8] : [v >> 8, v & 0xff]);
  const u32 = (v: number) =>
    little ? [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24] : [v >>> 24, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
  const tiff = [
    ...(little ? [0x49, 0x49] : [0x4d, 0x4d]),
    ...u16(42),
    ...u32(8),
    ...u16(1),
    ...u16(0x0112),
    ...u16(3),
    ...u32(1),
    ...u16(orientation),
    0,
    0,
    ...u32(0),
  ];
  const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const app1 = [0xff, 0xe1, ...u16be(exif.length + 2), ...exif];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  return new Uint8Array([0xff, 0xd8, ...app1, ...sof, 0xff, 0xd9]);
}
function u16be(v: number) {
  return [v >> 8, v & 0xff];
}

describe('photo orientation', () => {
  it('reads the EXIF orientation (both byte orders), defaulting to 1', () => {
    expect(readJpegOrientation(jpegWithOrientation(10, 10, 6))).toBe(6);
    expect(readJpegOrientation(jpegWithOrientation(10, 10, 8, true))).toBe(8);
    expect(readJpegOrientation(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBe(1);
    expect(readJpegOrientation(new Uint8Array([0x25, 0x50]))).toBe(1);
  });

  it('draws upright: identity for 1, a quarter turn for 6', () => {
    expect(imageMatrix(1, 612, 792)).toEqual([612, 0, 0, 792, 0, 0]);
    expect(imageMatrix(6, 612, 792)).toEqual([0, -792, 612, 0, 0, 792]);
    expect(imageMatrix(3, 100, 50)).toEqual([-100, 0, 0, -50, 100, 50]);
  });

  it('a portrait phone photo stored landscape (orientation 6) gets a portrait page', () => {
    const pdf = composeScanPdf([jpegWithOrientation(4032, 3024, 6)]);
    expect(pdf.pages).toEqual([{ width: 594, height: 792 }]);
    const text = Buffer.from(pdf.bytes).toString('latin1');
    expect(text).toContain('q 0 -792 594 0 0 792 cm /Im0 Do Q');
    // The image itself is embedded as stored.
    expect(text).toContain('/Width 4032 /Height 3024');
  });
});
