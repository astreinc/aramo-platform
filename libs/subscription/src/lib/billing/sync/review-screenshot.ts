// CCP Billing Products Directive v1.0 (LOCKED) BP-7 — the Apple review screenshot checks: read a PNG /
// JPEG's pixel size from its header (no image library) and accept only iPhone screenshot sizes App Store
// Connect accepts for an in-app purchase review screenshot (portrait or landscape).

/** iPhone screenshot sizes (width × height, portrait). Landscape (swapped) is accepted too. */
export const REVIEW_SCREENSHOT_SIZES: readonly (readonly [number, number])[] = [
  [1320, 2868], // 6.9"
  [1290, 2796], // 6.7"
  [1284, 2778], // 6.7" / 6.5"
  [1242, 2688], // 6.5"
  [1206, 2622], // 6.3"
  [1179, 2556], // 6.1"
  [1170, 2532], // 6.1"
  [1125, 2436], // 5.8"
  [1080, 2340], // 5.4"
  [1242, 2208], // 5.5"
  [750, 1334], // 4.7"
  [640, 1136], // 4"
];

export function reviewScreenshotDimensionsError(width: number, height: number): string | null {
  const ok = REVIEW_SCREENSHOT_SIZES.some(([w, h]) => (w === width && h === height) || (w === height && h === width));
  return ok ? null : `a review screenshot must be an iPhone screenshot size (e.g. 1290 × 2796); this image is ${width} × ${height}`;
}

/** The pixel size of a PNG (IHDR) or baseline / progressive JPEG (SOFn), or null. */
export function imageDimensions(bytes: Uint8Array, content_type: string): { width: number; height: number } | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (content_type === 'image/png') {
    const sig = [137, 80, 78, 71, 13, 10, 26, 10];
    if (b.byteLength < 24 || sig.some((v, i) => b[i] !== v) || b.toString('ascii', 12, 16) !== 'IHDR') return null;
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (content_type === 'image/jpeg') {
    if (b.byteLength < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
    let i = 2;
    while (i + 9 < b.byteLength) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      const len = b.readUInt16BE(i + 2);
      // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
    return null;
  }
  return null;
}
