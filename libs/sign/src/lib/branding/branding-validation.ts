// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §1.10 — branding validation.
//
// Pure functions shared by the repository (defence in depth) and the sign-service routes.
// The logo is accepted ONLY as PNG or JPEG, identified by its bytes (the declared type must
// agree), within a byte and pixel budget. SVG and every other type are refused: an SVG is a
// document that can carry script, and it is shown on public signing pages and in emails.
// The display name is printable Latin-1 so the certificate's standard PDF fonts can draw it.

export const BRANDING_LOGO_MAX_BYTES = 262_144; // 256 KiB
export const BRANDING_LOGO_MIN_PIXELS = 16;
export const BRANDING_LOGO_MAX_PIXELS = 4096;
export const BRANDING_DISPLAY_NAME_MAX = 80;

export type BrandingLogoType = 'image/png' | 'image/jpeg';

export interface SniffedImage {
  content_type: BrandingLogoType;
  width: number;
  height: number;
}

const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
// Printable Latin-1: space..tilde and no-break space..ÿ (no control characters).
const LATIN1_PRINTABLE_RE = /^[\x20-\x7E\xA0-\xFF]+$/;

/** `#RRGGBB` normalised to upper case, or null when not a 6-digit hex colour. */
export function normalizeBrandColor(raw: unknown): string | null {
  if (typeof raw !== 'string' || !COLOR_RE.test(raw.trim())) return null;
  return raw.trim().toUpperCase();
}

/** A trimmed display name (1..80 printable Latin-1 characters), or null when invalid. */
export function normalizeDisplayName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().replace(/\s+/g, ' ');
  if (v.length === 0 || v.length > BRANDING_DISPLAY_NAME_MAX) return null;
  return LATIN1_PRINTABLE_RE.test(v) ? v : null;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function sniffPng(b: Uint8Array): SniffedImage | null {
  if (b.length < 33) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) if (b[i] !== PNG_SIGNATURE[i]) return null;
  // The first chunk must be IHDR (length 13): width and height are big-endian u32.
  if (b[12] !== 0x49 || b[13] !== 0x48 || b[14] !== 0x44 || b[15] !== 0x52) return null;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { content_type: 'image/png', width: view.getUint32(16), height: view.getUint32(20) };
}

// JPEG: SOI, then segments up to a start-of-frame marker carrying the dimensions.
function sniffJpeg(b: Uint8Array): SniffedImage | null {
  const at = (k: number): number => b[k] ?? 0;
  if (b.length < 4 || at(0) !== 0xff || at(1) !== 0xd8 || at(2) !== 0xff) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (at(i) !== 0xff) return null;
    const marker = at(i + 1);
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    // Standalone markers (no length).
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = (at(i + 2) << 8) | at(i + 3);
    if (len < 2) return null;
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = (at(i + 5) << 8) | at(i + 6);
      const width = (at(i + 7) << 8) | at(i + 8);
      return { content_type: 'image/jpeg', width, height };
    }
    if (marker === 0xda) return null; // start of scan before any frame header
    i += 2 + len;
  }
  return null;
}

/** Identifies a PNG or JPEG by its bytes and reads its pixel size; null for anything else. */
export function sniffBrandingImage(bytes: Uint8Array): SniffedImage | null {
  return sniffPng(bytes) ?? sniffJpeg(bytes);
}

export type LogoRejection = 'logo_empty' | 'logo_too_large' | 'logo_type_unsupported' | 'logo_type_mismatch' | 'logo_dimensions_invalid';

/** Validates logo bytes against the declared type; returns the sniffed image or the reason. */
export function validateBrandingLogo(bytes: Uint8Array, declared_type: unknown): { ok: true; image: SniffedImage } | { ok: false; reason: LogoRejection } {
  if (bytes.byteLength === 0) return { ok: false, reason: 'logo_empty' };
  if (bytes.byteLength > BRANDING_LOGO_MAX_BYTES) return { ok: false, reason: 'logo_too_large' };
  if (declared_type !== 'image/png' && declared_type !== 'image/jpeg') return { ok: false, reason: 'logo_type_unsupported' };
  const image = sniffBrandingImage(bytes);
  if (image === null) return { ok: false, reason: 'logo_type_unsupported' };
  if (image.content_type !== declared_type) return { ok: false, reason: 'logo_type_mismatch' };
  const inRange = (n: number) => Number.isInteger(n) && n >= BRANDING_LOGO_MIN_PIXELS && n <= BRANDING_LOGO_MAX_PIXELS;
  if (!inRange(image.width) || !inRange(image.height)) return { ok: false, reason: 'logo_dimensions_invalid' };
  return { ok: true, image };
}

/** Black or white text, whichever reads better on the given `#RRGGBB` background (WCAG luminance). */
export function readableTextOn(hex: string): '#000000' | '#FFFFFF' {
  const c = normalizeBrandColor(hex);
  if (c === null) return '#FFFFFF';
  const ch = (i: number) => {
    const v = parseInt(c.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const lum = 0.2126 * ch(1) + 0.7152 * ch(3) + 0.0722 * ch(5);
  // Contrast against white vs black; pick the larger.
  return (1.05 / (lum + 0.05) >= (lum + 0.05) / 0.05 ? '#FFFFFF' : '#000000');
}
